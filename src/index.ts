// gas/src/video/index.ts
//
// Entry point for turning a video-type draft's script into an actual video
// asset. Routing:
//
//   RUNWAY_API_KEY configured?
//     yes -> submit to Runway (video/runway.ts), draft goes to
//            video_status = "queued". A later cron tick's /render-check
//            polls it to "ready" (with a video_url) or "failed".
//     no  -> render the Workers-AI fallback slideshow immediately
//            (video/fallback.ts), draft goes straight to
//            video_status = "fallback_ready".
//
//   If a queued Runway task later comes back FAILED, /render-check falls
//   through to the same Workers-AI fallback rather than leaving the draft
//   stuck — so "no API call" is also the safety net for "the paid API had
//   a bad day", not just the zero-budget default.

import type { Env, VideoRenderResult, VideoScene } from "../types";
import { submitVideoTask, pollVideoTask } from "./runway";
import { renderFallbackSlideshow } from "./fallback";

const MAX_SCENES = 4;

/** Splits a script body into scenes a video pipeline can act on. Scripts
 * from the LLM are prose, not structured JSON, so this is a heuristic split
 * on sentence boundaries rather than a strict parser — good enough for
 * "how many distinct visual beats does this script imply", which is all
 * either video provider needs. */
export function parseScenes(scriptBody: string, brief: string): VideoScene[] {
  const sentences = scriptBody
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8); // drop stray fragments/labels

  const chunkSize = Math.max(1, Math.ceil(sentences.length / MAX_SCENES));
  const scenes: VideoScene[] = [];
  for (let i = 0; i < sentences.length && scenes.length < MAX_SCENES; i += chunkSize) {
    const narration = sentences.slice(i, i + chunkSize).join(" ");
    scenes.push({ narration, visual_prompt: narration });
  }
  if (scenes.length === 0) {
    scenes.push({ narration: scriptBody.slice(0, 200), visual_prompt: `A social media video about ${brief}` });
  }
  return scenes;
}

/** Kicks off rendering for one video-type draft. Called right after a
 * draft is parsed out of the LLM's response, before it's inserted into
 * content_queue — so the row is written once with its initial video state
 * already set, rather than inserted as text-only and patched a moment
 * later. */
export async function startVideoRender(
  env: Env,
  scriptBody: string,
  brief: string,
  draftIdHint: string,
): Promise<VideoRenderResult> {
  const scenes = parseScenes(scriptBody, brief);

  if (env.RUNWAY_API_KEY) {
    const submitted = await submitVideoTask(env, scenes, brief);
    if (submitted.ok && submitted.taskId) {
      return { status: "queued", provider: "runway", video_task_id: submitted.taskId };
    }
    // Runway configured but the submit call itself failed (bad key, rate
    // limit, model outage) — fall through to the free path rather than
    // leaving this draft with no media at all.
    const fallback = await renderFallbackSlideshow(env, scenes, draftIdHint);
    fallback.error = `Runway submit failed (${submitted.error}); used fallback instead.`;
    return fallback;
  }

  return renderFallbackSlideshow(env, scenes, draftIdHint);
}

/** Polls one in-flight Runway task. Called from index.ts's /render-check
 * route on every cron tick. On FAILED, drops straight to the same
 * Workers-AI fallback used when Runway was never configured — needs the
 * original script's scenes again since Runway itself never saw them
 * chunked (it only got the single hook prompt). */
export async function checkVideoRender(
  env: Env,
  taskId: string,
  scriptBody: string,
  brief: string,
  draftIdHint: string,
): Promise<VideoRenderResult | null> {
  const poll = await pollVideoTask(env, taskId);

  if (poll.status === "PENDING" || poll.status === "RUNNING") {
    return null; // no change — still rendering, check again next tick
  }
  if (poll.status === "SUCCEEDED" && poll.videoUrl) {
    return { status: "ready", provider: "runway", video_url: poll.videoUrl };
  }

  // FAILED — degrade to the fallback rather than leaving the draft stuck
  // in "rendering" forever.
  const scenes = parseScenes(scriptBody, brief);
  const fallback = await renderFallbackSlideshow(env, scenes, draftIdHint);
  fallback.error = `Runway render failed (${poll.error}); used fallback instead.`;
  return fallback;
}
