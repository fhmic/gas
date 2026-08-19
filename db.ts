// gas/src/db.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Env, GrowthJob, LiteExecutiveSummary, NetworkSnapshot, ContentDraft } from "./types";

export function getDb(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

export async function getActiveJobs(db: SupabaseClient): Promise<GrowthJob[]> {
  const { data, error } = await db
    .from("growth_jobs")
    .select("*")
    .eq("status", "active");
  if (error) throw new Error(`getActiveJobs: ${error.message}`);
  return data as GrowthJob[];
}

export async function insertDrafts(
  db: SupabaseClient,
  jobId: string,
  drafts: ContentDraft[]
): Promise<number> {
  if (drafts.length === 0) return 0;
  const rows = drafts.map((d) => ({
    job_id: jobId,
    platform: d.platform,
    content_type: d.content_type,
    title: d.title,
    body: d.body,
    tracking_subid: d.tracking_subid ?? null,
    status: "pending_approval",
  }));
  const { error } = await db.from("content_queue").insert(rows);
  if (error) throw new Error(`insertDrafts: ${error.message}`);
  return rows.length;
}

export async function insertSnapshot(db: SupabaseClient, s: NetworkSnapshot): Promise<void> {
  const { error } = await db.from("earnings_snapshots").insert({
    network: s.network,
    clicks: s.clicks,
    leads: s.leads,
    conversions: s.conversions,
    earnings: s.earnings,
    currency: s.currency,
    raw: s.raw,
    ok: s.ok,
    error: s.error ?? null,
  });
  if (error) throw new Error(`insertSnapshot: ${error.message}`);
}

export async function logRun(
  db: SupabaseClient,
  params: {
    jobId?: string | null;
    action: string;
    ok: boolean;
    draftsCreated?: number;
    summary?: LiteExecutiveSummary | null;
    error?: string | null;
  }
): Promise<void> {
  const { error } = await db.from("run_log").insert({
    job_id: params.jobId ?? null,
    action: params.action,
    ok: params.ok,
    drafts_created: params.draftsCreated ?? 0,
    summary: params.summary ?? null,
    error: params.error ?? null,
  });
  if (error) throw new Error(`logRun: ${error.message}`);
}

/** Latest snapshot per network, used to compute deltas for the report. */
export async function latestSnapshotBefore(
  db: SupabaseClient,
  network: string,
  before: string
): Promise<NetworkSnapshot | null> {
  const { data, error } = await db
    .from("earnings_snapshots")
    .select("*")
    .eq("network", network)
    .lt("pulled_at", before)
    .order("pulled_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`latestSnapshotBefore: ${error.message}`);
  if (!data || data.length === 0) return null;
  const row = data[0];
  return {
    network: row.network,
    ok: row.ok,
    error: row.error ?? undefined,
    clicks: row.clicks,
    leads: row.leads,
    conversions: row.conversions,
    earnings: row.earnings,
    currency: row.currency,
    raw: row.raw,
  };
}
