// gas/src/index.ts
import type { Env } from "./types";
import { getDb, getActiveJobs, insertSnapshot, logRun } from "./db";
import { runContentPass } from "./agent";
import { pollPartnerStack } from "./networks/partnerstack";
import { pollExness } from "./networks/exness";
import { buildReport } from "./report";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function checkAuth(req: Request, env: Env): boolean {
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${env.WORKER_SHARED_SECRET}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Full poll-and-generate cycle. Called by the cron trigger, and reachable
 * manually via POST /run-now so you can test or force a fresh pull. */
async function runCycle(env: Env): Promise<{ jobsRun: number; reportId: string | null }> {
  const db = getDb(env);
  const cycleStart = new Date().toISOString();

  // 1. Content pass for every active job.
  const jobs = await getActiveJobs(db);
  for (const job of jobs) {
    await runContentPass(db, env, job);
  }

  // 2. Poll every network once per cycle (shared across jobs — earnings
  //    aren't per-job, they're per affiliate account).
  const [psSnapshot, exSnapshot] = await Promise.all([
    pollPartnerStack(env),
    pollExness(env),
  ]);
  await insertSnapshot(db, psSnapshot);
  await insertSnapshot(db, exSnapshot);
  await logRun(db, {
    action: "earnings_poll",
    ok: psSnapshot.ok && exSnapshot.ok,
    error: [psSnapshot.error, exSnapshot.error].filter(Boolean).join(" | ") || null,
  });

  // 3. Build a report covering since-the-last-report to now.
  const { data: lastReport } = await db
    .from("reports")
    .select("generated_at")
    .order("generated_at", { ascending: false })
    .limit(1);
  const periodStart = lastReport?.[0]?.generated_at ?? cycleStart;

  const report = await buildReport({
    db,
    periodStart,
    periodEnd: cycleStart,
    currentSnapshots: [psSnapshot, exSnapshot],
  });

  const { data: inserted, error: insertErr } = await db
    .from("reports")
    .insert({
      period_start: report.period_start,
      period_end: report.period_end,
      drafts_created: report.drafts_created,
      pending_review: report.pending_review,
      leads_delta: report.leads_delta,
      conversions_delta: report.conversions_delta,
      earnings_delta: report.earnings_delta,
      currency: report.currency,
      summary_text: report.summary_text,
      metrics: report.metrics,
    })
    .select("id")
    .single();

  await logRun(db, { action: "report_build", ok: !insertErr, error: insertErr?.message ?? null });

  return { jobsRun: jobs.length, reportId: inserted?.id ?? null };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (!checkAuth(req, env)) return unauthorized();

    const db = getDb(env);

    // POST /jobs — create a job
    if (url.pathname === "/jobs" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const { data, error } = await db
        .from("growth_jobs")
        .insert({
          niche: body.niche,
          goal: body.goal ?? "grow leads and affiliate revenue",
          platforms: body.platforms ?? ["Instagram", "TikTok"],
          networks: body.networks ?? ["partnerstack", "exness"],
          cadence_hours: body.cadence_hours ?? 6,
          posts_per_run: body.posts_per_run ?? 3,
        })
        .select()
        .single();
      if (error) return json({ error: error.message }, 400);
      return json({ job: data });
    }

    // GET /jobs — list jobs
    if (url.pathname === "/jobs" && req.method === "GET") {
      const { data, error } = await db.from("growth_jobs").select("*").order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 400);
      return json({ jobs: data });
    }

    // PATCH /jobs/:id — pause/resume/update
    const jobMatch = url.pathname.match(/^\/jobs\/([\w-]+)$/);
    if (jobMatch && req.method === "PATCH") {
      const body = (await req.json()) as Record<string, unknown>;
      const { data, error } = await db.from("growth_jobs").update(body).eq("id", jobMatch[1]).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ job: data });
    }

    // GET /queue?status=pending_approval — list drafts
    if (url.pathname === "/queue" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? "pending_approval";
      const { data, error } = await db
        .from("content_queue")
        .select("*")
        .eq("status", status)
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 400);
      return json({ items: data });
    }

    // POST /queue/:id/approve | /queue/:id/reject
    const queueMatch = url.pathname.match(/^\/queue\/([\w-]+)\/(approve|reject)$/);
    if (queueMatch && req.method === "POST") {
      const [, id, action] = queueMatch;
      const status = action === "approve" ? "approved" : "rejected";
      const { data, error } = await db
        .from("content_queue")
        .update({ status, reviewed_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      if (error) return json({ error: error.message }, 400);
      return json({ item: data });
    }

    // GET /report/latest
    if (url.pathname === "/report/latest" && req.method === "GET") {
      const { data, error } = await db
        .from("reports")
        .select("*")
        .order("generated_at", { ascending: false })
        .limit(1);
      if (error) return json({ error: error.message }, 400);
      if (!data || data.length === 0) return json({ report: null });
      return json({ report: data[0] });
    }

    // POST /run-now — manually trigger a full cycle (testing / forced refresh)
    if (url.pathname === "/run-now" && req.method === "POST") {
      const result = await runCycle(env);
      return json({ ran: true, ...result });
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env));
  },
};
