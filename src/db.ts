// gas/src/db.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Env, GrowthJob, LiteExecutiveSummary, NetworkSnapshot, ContentDraft, VideoRenderResult } from "./types";

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

/** draftVideo carries the initial render state for any draft whose
 * content_type triggered a video render (see agent.ts) — undefined for
 * plain text drafts, which keep media_type = "text" (the column default).
 * sourceBrief is stored directly on every row (job niche, or the free-text
 * description for an ad-hoc /generate call) so later video-render polling
 * doesn't need to join back through growth_jobs — works identically for
 * job-based and ad-hoc drafts. */
export async function insertDrafts(
  db: SupabaseClient,
  jobId: string | null,
  sourceBrief: string,
  drafts: ContentDraft[],
  draftVideo?: Map<number, VideoRenderResult>,
): Promise<number> {
  if (drafts.length === 0) return 0;
  const rows = drafts.map((d, i) => {
    const video = draftVideo?.get(i);
    return {
      job_id: jobId,
      source_brief: sourceBrief,
      platform: d.platform,
      content_type: d.content_type,
      title: d.title,
      body: d.body,
      tracking_subid: d.tracking_subid ?? null,
      status: "pending_approval",
      media_type: video ? "video" : "text",
      video_status: video?.status ?? null,
      video_provider: video?.provider ?? null,
      video_url: video?.video_url ?? null,
      video_task_id: video?.video_task_id ?? null,
      video_assets: video?.assets ?? null,
      render_error: video?.error ?? null,
    };
  });
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

// ── Video render polling ────────────────────────────────────────────────

export interface PendingVideoDraft {
  id: string;
  body: string;
  video_task_id: string;
  source_brief: string;
}

/** Every draft still waiting on a Runway task. Reads source_brief directly
 * off content_queue — no growth_jobs join needed, which also means this
 * works identically for ad-hoc (/generate) drafts that have no job_id at
 * all. */
export async function getPendingVideoRenders(db: SupabaseClient): Promise<PendingVideoDraft[]> {
  const { data, error } = await db
    .from("content_queue")
    .select("id, body, video_task_id, source_brief")
    .in("video_status", ["queued", "rendering"])
    .not("video_task_id", "is", null);
  if (error) throw new Error(`getPendingVideoRenders: ${error.message}`);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    body: row.body,
    video_task_id: row.video_task_id,
    source_brief: row.source_brief ?? "",
  }));
}

export async function updateDraftVideo(
  db: SupabaseClient,
  draftId: string,
  result: VideoRenderResult,
): Promise<void> {
  const { error } = await db
    .from("content_queue")
    .update({
      video_status: result.status,
      video_provider: result.provider,
      video_url: result.video_url ?? null,
      video_task_id: result.video_task_id ?? null,
      video_assets: result.assets ?? null,
      render_error: result.error ?? null,
    })
    .eq("id", draftId);
  if (error) throw new Error(`updateDraftVideo: ${error.message}`);
}

/** Single draft by id — backs both GET /queue/:id (used by LITE's download
 * handler, which needs the full row including video_url/video_assets) and
 * deleteDraftRow below (needs the row's R2 keys before it can be dropped). */
export async function getDraftById(db: SupabaseClient, id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from("content_queue").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getDraftById: ${error.message}`);
  return data ?? null;
}

/** Permanently removes a draft row. Does NOT touch R2 — index.ts's DELETE
 * route deletes the referenced R2 objects (video_assets.image_keys/
 * audio_key) itself, before calling this, since that needs the Env
 * binding this db-only module doesn't have. */
export async function deleteDraftRow(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("content_queue").delete().eq("id", id);
  if (error) throw new Error(`deleteDraftRow: ${error.message}`);
}
