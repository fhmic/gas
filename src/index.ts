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

// A missing WORKER_SHARED_SECRET is a deploy/config mistake, not a bad
// caller — surfacing it as a distinct 500 (instead of the same 401 a wrong
// key produces) means "the secret was never set" and "the caller sent the
// wrong key" no longer look identical from the client side.
function misconfigured(): Response {
  return new Response(
    JSON.stringify({
      error: "server misconfigured",
      detail: "WORKER_SHARED_SECRET is not set on this Worker — run `wrangler secret put WORKER_SHARED_SECRET`.",
    }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

type AuthResult = "ok" | "unauthorized" | "misconfigured";

function checkAuth(req: Request, env: Env): AuthResult {
  const expected = (env.WORKER_SHARED_SECRET ?? "").trim();
  if (!expected) return "misconfigured";
  // .trim() on the incoming header absorbs the classic copy-paste artifact
  // (trailing newline/whitespace picked up when selecting a full line) that
  // would otherwise fail this exact-match check for a "correct" key.
  const auth = (req.headers.get("authorization") ?? "").trim();
  return auth === `Bearer ${expected}` ? "ok" : "unauthorized";
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

    const authResult = checkAuth(req, env);
    if (authResult === "misconfigured") return misconfigured();
    if (authResult === "unauthorized") return unauthorized();

    // Everything past this point (Supabase access, route handlers) is wrapped
    // so a missing/bad env var (e.g. SUPABASE_URL never set) produces a clear,
    // diagnosable JSON error instead of Cloudflare's bare generic 500 — which
    // was previously indistinguishable from the auth-misconfiguration case on
    // the client side and caused real confusion troubleshooting the wrong thing.
    try {
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

    // ═══════════════════════════════════════════════════════════════════
    // RICS CRM routes — same auth, same db, same error-handling as
    // everything above. Query params double as simple filters throughout.
    // ═══════════════════════════════════════════════════════════════════

    // POST /crm/companies — create or update (pass id to update)
    if (url.pathname === "/crm/companies" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const { id, ...fields } = body;
      const row = { ...fields, updated_at: new Date().toISOString() };
      const q = id
        ? db.from("crm_companies").update(row).eq("id", id)
        : db.from("crm_companies").insert(row);
      const { data, error } = await q.select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ company: data });
    }

    // GET /crm/companies?q=<name search>&id=<exact>
    if (url.pathname === "/crm/companies" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const q = url.searchParams.get("q");
      let query = db.from("crm_companies").select("*");
      if (id) query = query.eq("id", id);
      if (q) query = query.ilike("name", `%${q}%`);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
      if (error) return json({ error: error.message }, 400);
      return json({ companies: data });
    }

    // POST /crm/contacts — create or update (pass id to update)
    if (url.pathname === "/crm/contacts" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const { id, ...fields } = body;
      const row = { ...fields, updated_at: new Date().toISOString() };
      const q = id
        ? db.from("crm_contacts").update(row).eq("id", id)
        : db.from("crm_contacts").insert(row);
      const { data, error } = await q.select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ contact: data });
    }

    // GET /crm/contacts?q=<name search>&company_id=<filter>&id=<exact>
    if (url.pathname === "/crm/contacts" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const companyId = url.searchParams.get("company_id");
      const q = url.searchParams.get("q");
      let query = db.from("crm_contacts").select("*");
      if (id) query = query.eq("id", id);
      if (companyId) query = query.eq("company_id", companyId);
      if (q) query = query.ilike("name", `%${q}%`);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
      if (error) return json({ error: error.message }, 400);
      return json({ contacts: data });
    }

    // POST /crm/deals — create or update (pass id to update)
    if (url.pathname === "/crm/deals" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const { id, ...fields } = body;
      const row = { ...fields, updated_at: new Date().toISOString() };
      const q = id
        ? db.from("crm_deals").update(row).eq("id", id)
        : db.from("crm_deals").insert(row);
      const { data, error } = await q.select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ deal: data });
    }

    // GET /crm/deals?stage=<filter>&id=<exact>
    if (url.pathname === "/crm/deals" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const stage = url.searchParams.get("stage");
      let query = db.from("crm_deals").select("*");
      if (id) query = query.eq("id", id);
      if (stage) query = query.eq("stage", stage);
      const { data, error } = await query.order("updated_at", { ascending: false }).limit(50);
      if (error) return json({ error: error.message }, 400);
      return json({ deals: data });
    }

    // POST /crm/interactions — log a touchpoint (no update path — interactions
    // are an append-only log, matching earnings_snapshots' pattern above)
    if (url.pathname === "/crm/interactions" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const { data, error } = await db.from("crm_interactions").insert(body).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ interaction: data });
    }

    // GET /crm/interactions?contact_id=<filter>&company_id=<filter>&deal_id=<filter>
    if (url.pathname === "/crm/interactions" && req.method === "GET") {
      const contactId = url.searchParams.get("contact_id");
      const companyId = url.searchParams.get("company_id");
      const dealId = url.searchParams.get("deal_id");
      let query = db.from("crm_interactions").select("*");
      if (contactId) query = query.eq("contact_id", contactId);
      if (companyId) query = query.eq("company_id", companyId);
      if (dealId) query = query.eq("deal_id", dealId);
      const { data, error } = await query.order("occurred_at", { ascending: false }).limit(100);
      if (error) return json({ error: error.message }, 400);
      return json({ interactions: data });
    }

    // POST /crm/tasks — create a follow-up (pass id + done to mark complete)
    if (url.pathname === "/crm/tasks" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const { id, ...fields } = body;
      const q = id
        ? db.from("crm_tasks").update(fields).eq("id", id)
        : db.from("crm_tasks").insert(fields);
      const { data, error } = await q.select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ task: data });
    }

    // GET /crm/tasks?done=false&due_before=<ISO date>
    if (url.pathname === "/crm/tasks" && req.method === "GET") {
      const done = url.searchParams.get("done");
      const dueBefore = url.searchParams.get("due_before");
      let query = db.from("crm_tasks").select("*");
      if (done !== null) query = query.eq("done", done === "true");
      if (dueBefore) query = query.lte("due_at", dueBefore);
      const { data, error } = await query.order("due_at", { ascending: true }).limit(50);
      if (error) return json({ error: error.message }, 400);
      return json({ tasks: data });
    }

    return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: "internal error", detail: String(e?.message ?? e) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env));
  },
};
