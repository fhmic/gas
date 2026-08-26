// gas/src/agent.ts
import type { Env, GrowthJob, ContentDraft, VideoRenderResult } from "./types";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { generateWithSummary } from "./llm";
import { insertDrafts, logRun } from "./db";
import { startVideoRender } from "./video";
import type { SupabaseClient } from "@supabase/supabase-js";

function buildTask(job: GrowthJob): string {
  return [
    `Generate ${job.posts_per_run} pieces of content for the '${job.niche}' `,
    `affiliate niche. Goal: ${job.goal}. `,
    `Target platforms: ${job.platforms.join(", ")}. `,
    "",
    "For EACH piece, output a clearly delimited block in exactly this form ",
    "(so it can be parsed programmatically) — repeat the block once per piece:",
    "",
    "---PIECE---",
    "platform: <one of the target platforms>",
    "content_type: <post_ideas | video | video_script | email_sequence | ad_copy | landing_page>",
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

/** Runs one content-generation pass for a single job. Never throws —
 * failures are logged to run_log and surfaced in the return value instead,
 * so one bad job doesn't stop the cron cycle from processing the rest. */
export async function runContentPass(
  db: SupabaseClient,
  env: Env,
  job: GrowthJob
): Promise<{ ok: boolean; draftsCreated: number; error?: string }> {
  try {
    const task = buildTask(job);
    // Scaled to the number of pieces requested: ~1200 tokens/piece is
    // generous for a post/ad/script, plus headroom for the mandatory
    // summary block. The flat 2000-token default was fine for 1-2 pieces
    // but silently truncated longer runs (posts_per_run > 2, or any
    // video_script/email_sequence piece, which run longer than a post) —
    // a cut-off piece loses its closing ---END--- marker and gets silently
    // dropped by parseDrafts rather than erroring, so this was invisible
    // until someone actually counted drafts vs. posts_per_run and found
    // fewer than expected.
    const maxTokens = Math.min(1200 * job.posts_per_run + 500, 8000);
    const { text, summary } = await generateWithSummary(env, SYSTEM_PROMPT, task, maxTokens);
    const drafts = parseDrafts(text);

    // Kick off a real video render for every 'video' piece BEFORE inserting,
    // so each row is written once with its starting video_status already
    // set, instead of landing as text-only and being patched moments later.
    // Runway submits return almost immediately (just the task id); the
    // Workers-AI fallback runs to completion inline — both are fast enough
    // not to meaningfully extend this pass, which already runs on a 6h cron
    // and isn't latency-sensitive.
    const videoResults = new Map<number, VideoRenderResult>();
    for (let i = 0; i < drafts.length; i++) {
      if (drafts[i].content_type !== "video") continue;
      const draftIdHint = `${job.id}-${Date.now()}-${i}`;
      const result = await startVideoRender(env, drafts[i].body, job.niche, draftIdHint);
      videoResults.set(i, result);
    }

    const created = await insertDrafts(db, job.id, drafts, videoResults);

    // Surfaces truncation/malformed-output cases instead of silently
    // under-delivering: parseDrafts drops any piece missing a clean
    // ---END--- marker, which happens if the response got cut off before
    // the token budget fix above, or the model just didn't follow the
    // format. ok stays true (a partial batch isn't a failure), but the
    // shortfall is visible in run_log rather than only discoverable by
    // manually counting drafts against posts_per_run.
    const shortfall = job.posts_per_run - created;
    const videoFailures = [...videoResults.values()].filter((v) => v.status === "failed").length;
    const notes = [
      shortfall > 0
        ? `Requested ${job.posts_per_run} piece(s), only ${created} parsed cleanly — check for truncation or format drift.`
        : null,
      videoFailures > 0 ? `${videoFailures} video render(s) failed outright — see render_error per draft.` : null,
    ].filter(Boolean);

    await logRun(db, {
      jobId: job.id,
      action: "content_pass",
      ok: true,
      draftsCreated: created,
      summary,
      error: notes.length > 0 ? notes.join(" ") : undefined,
    });

    return { ok: true, draftsCreated: created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logRun(db, { jobId: job.id, action: "content_pass", ok: false, error: message });
    return { ok: false, draftsCreated: 0, error: message };
  }
}
