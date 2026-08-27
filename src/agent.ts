// gas/src/agent.ts
import type { Env, GrowthJob, ContentDraft, VideoRenderResult } from "./types";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { generateWithSummary } from "./llm";
import { insertDrafts, logRun } from "./db";
import { startVideoRender } from "./video";
import type { SupabaseClient } from "@supabase/supabase-js";

const PIECE_FORMAT_INSTRUCTIONS = [
  "",
  "For EACH piece, output a clearly delimited block in exactly this form ",
  "(so it can be parsed programmatically) — repeat the block once per piece:",
  "",
  "---PIECE---",
  "platform: <one of the target platforms>",
  "content_type: <one of post_ideas | video | video_script | email_sequence | ad_copy | landing_page>",
  "title: <short internal title>",
  "tracking_subid: <short lowercase-hyphenated tag>",
  "body: |",
  "  <the actual content, multi-line ok>",
  "---END---",
  "",
  "Content-type guidance:",
  "- 'video' means this piece should become an ACTUAL rendered video, not just",
  "  a script — the body must still read as a spoken narration script (a plain",
  "  paragraph works better than a scene-numbered format), split into a hook,",
  "  2-3 value beats, and a CTA, since it gets automatically chunked into",
  "  visual scenes downstream. Use 'video' whenever the platform is TikTok,",
  "  Instagram Reels, YouTube Shorts, or LinkedIn video — 'video_script' is",
  "  only for when you explicitly just want a written script with no render.",
  "- For LinkedIn specifically (any content_type): professional tone, no",
  "  slang/trend-audio references, hook should be a credibility/insight",
  "  statement rather than a shock hook, and keep the CTA soft (comment/",
  "  connect/DM) rather than a hard sales push — LinkedIn's algorithm and",
  "  audience both punish anything that reads like a TikTok script pasted in.",
  "",
  "After all pieces, still include the mandatory LITE EXECUTIVE SUMMARY block.",
].join("\n");

function buildScheduledTask(job: GrowthJob): string {
  return (
    `Generate ${job.posts_per_run} pieces of content for the '${job.niche}' ` +
    `affiliate niche. Goal: ${job.goal}. ` +
    `Target platforms: ${job.platforms.join(", ")}. ` +
    PIECE_FORMAT_INSTRUCTIONS
  );
}

/** Ad-hoc task: unlike the scheduled pass (which works from a standing
 * niche + goal), this takes the user's exact one-off brief verbatim — e.g.
 * "a 20%-off launch ad for our new budgeting app aimed at Gen Z" — and
 * asks for content built around THAT idea specifically, rather than the
 * more generic "grow this niche" framing. */
function buildAdHocTask(
  description: string,
  platforms: string[],
  count: number,
  contentTypeHint?: string,
): string {
  const platformLine = platforms.length > 0 ? `Target platforms: ${platforms.join(", ")}. ` : "";
  const typeLine = contentTypeHint
    ? `Use content_type: ${contentTypeHint} for every piece unless that genuinely doesn't fit a platform. `
    : "";
  return (
    `Generate ${count} piece(s) of content for this exact idea/brief — stay ` +
    `specific to it rather than writing generically about the niche:\n\n"${description}"\n\n` +
    platformLine +
    typeLine +
    PIECE_FORMAT_INSTRUCTIONS
  );
}

function parseDrafts(text: string): ContentDraft[] {
  const drafts: ContentDraft[] = [];
  const pieceRe = /---PIECE---([\s\S]*?)---END---/g;
  let m: RegExpExecArray | null;
  while ((m = pieceRe.exec(text)) !== null) {
    const block = m[1];
    const get = (key: string): string => {
      const re = new RegExp(`${key}\\s*:\\s*\\|?\\s*([\\s\\S]*?)(?=\\n\\w+\\s*:|$)`, "i");
      const mm = re.exec(block);
      return mm ? mm[1].trim() : "";
    };
    const platform = get("platform");
    const body = get("body");
    if (!platform || !body) continue; // skip malformed pieces rather than insert junk
    drafts.push({
      platform,
      content_type: get("content_type") || "post_ideas",
      title: get("title") || `${platform} draft`,
      tracking_subid: get("tracking_subid") || undefined,
      body,
    });
  }
  return drafts;
}

interface GenerationResult {
  ok: boolean;
  draftsCreated: number;
  error?: string;
}

/** Shared pipeline: call the LLM, parse pieces, kick off video renders for
 * any 'video' piece, insert everything, log the run. Used by both the
 * scheduled per-job pass and the ad-hoc /generate route — the only real
 * difference between them is how `task` and `requestedCount` get built. */
async function generateAndStore(
  db: SupabaseClient,
  env: Env,
  params: { jobId: string | null; sourceBrief: string; task: string; requestedCount: number; logAction: string },
): Promise<GenerationResult> {
  try {
    // ~1200 tokens/piece is generous for a post/ad/script, plus headroom
    // for the mandatory summary block. A flat low default silently
    // truncates longer runs — a cut-off piece loses its closing ---END---
    // marker and gets silently dropped by parseDrafts rather than
    // erroring, so this scales with what was actually asked for.
    const maxTokens = Math.min(1200 * params.requestedCount + 500, 8000);
    const { text, summary } = await generateWithSummary(env, SYSTEM_PROMPT, params.task, maxTokens);
    const drafts = parseDrafts(text);

    // Kick off a real video render for every 'video' piece BEFORE
    // inserting, so each row is written once with its starting
    // video_status already set, instead of landing as text-only and being
    // patched moments later. Runway submits return almost immediately
    // (just the task id); the Workers-AI fallback runs to completion
    // inline — both are fast enough not to meaningfully extend this call.
    const videoResults = new Map<number, VideoRenderResult>();
    for (let i = 0; i < drafts.length; i++) {
      if (drafts[i].content_type !== "video") continue;
      const draftIdHint = `${params.jobId ?? "adhoc"}-${Date.now()}-${i}`;
      const result = await startVideoRender(env, drafts[i].body, params.sourceBrief, draftIdHint);
      videoResults.set(i, result);
    }

    const created = await insertDrafts(db, params.jobId, params.sourceBrief, drafts, videoResults);

    const shortfall = params.requestedCount - created;
    const videoFailures = [...videoResults.values()].filter((v) => v.status === "failed").length;
    const notes = [
      shortfall > 0
        ? `Requested ${params.requestedCount} piece(s), only ${created} parsed cleanly — check for truncation or format drift.`
        : null,
      videoFailures > 0 ? `${videoFailures} video render(s) failed outright — see render_error per draft.` : null,
    ].filter(Boolean);

    await logRun(db, {
      jobId: params.jobId,
      action: params.logAction,
      ok: true,
      draftsCreated: created,
      summary,
      error: notes.length > 0 ? notes.join(" ") : undefined,
    });

    return { ok: true, draftsCreated: created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logRun(db, { jobId: params.jobId, action: params.logAction, ok: false, error: message });
    return { ok: false, draftsCreated: 0, error: message };
  }
}

/** Runs one scheduled content-generation pass for a job (cron-driven).
 * Never throws — failures are logged to run_log and returned instead, so
 * one bad job doesn't stop the cron cycle from processing the rest. */
export async function runContentPass(db: SupabaseClient, env: Env, job: GrowthJob): Promise<GenerationResult> {
  return generateAndStore(db, env, {
    jobId: job.id,
    sourceBrief: job.niche,
    task: buildScheduledTask(job),
    requestedCount: job.posts_per_run,
    logAction: "content_pass",
  });
}

/** Runs a one-off, on-demand content pass from a free-text idea/brief —
 * the /generate route (or a `generate_ads` action from LITE). Independent
 * of any standing job/cadence; jobId is left null so this never shows up
 * tied to a recurring niche's job_id, but source_brief still carries the
 * description so the video-render poller and the review queue both have
 * full context on what this was for. */
export async function runAdHocGeneration(
  db: SupabaseClient,
  env: Env,
  params: { description: string; platforms?: string[]; count?: number; content_type?: string },
): Promise<GenerationResult> {
  const platforms = params.platforms ?? [];
  const count = params.count ?? 3;
  return generateAndStore(db, env, {
    jobId: null,
    sourceBrief: params.description,
    task: buildAdHocTask(params.description, platforms, count, params.content_type),
    requestedCount: count,
    logAction: "adhoc_generate",
  });
}
