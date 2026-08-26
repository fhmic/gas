// gas/src/video/runway.ts
//
// Primary video provider: Runway's REST API (https://api.dev.runwayml.com/v1).
// Generation is async — POST submits a task, GET /v1/tasks/{id} is polled
// until it reaches SUCCEEDED or FAILED. Every request needs a dated
// X-Runway-Version header; behavior can change behind new dates, so this is
// pinned via env.RUNWAY_API_VERSION (default below) rather than hardcoded
// loosely.
//
// This module never blocks a Worker request waiting for a render to finish
// (Runway renders can take minutes) — submitVideoTask() returns immediately
// with a task id, and pollVideoTask() is called separately on a later cron
// tick via the /render-check route in index.ts. That's why draft rows carry
// video_status = "queued" | "rendering" as real, persisted states.

import type { Env, VideoScene } from "../types";

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.RUNWAY_API_KEY ?? ""}`,
    "content-type": "application/json",
    "X-Runway-Version": env.RUNWAY_API_VERSION?.trim() || "2024-11-06",
  };
}

/** Combines a video draft's parsed scenes into one Runway text-to-video
 * prompt. Runway's text-to-video models generate a single continuous clip
 * per request (3-10s), not a multi-scene sequence — so for a longer script
 * we render the strongest scene (the hook) as the clip and let the caption
 * track carry the rest, rather than firing N separate paid renders per
 * draft. Multi-clip stitching is a real upgrade path (see README) but adds
 * a second paid step (concatenation) this fallback-free version doesn't
 * assume you want by default. */
function buildPromptText(scenes: VideoScene[], niche: string): string {
  const hook = scenes[0];
  if (!hook) return `A short, attention-grabbing social video about ${niche}.`;
  return `${hook.visual_prompt}. Context: content about ${niche}. Cinematic, high production value, no on-screen text.`;
}

export interface RunwaySubmitResult {
  ok: boolean;
  taskId?: string;
  error?: string;
}

/** Submits a text-to-video render. Returns the task id immediately —
 * caller stores it and polls later. */
export async function submitVideoTask(
  env: Env,
  scenes: VideoScene[],
  niche: string,
  opts: { ratio?: "1280:720" | "720:1280"; durationSeconds?: 5 | 10 } = {},
): Promise<RunwaySubmitResult> {
  if (!env.RUNWAY_API_KEY) return { ok: false, error: "RUNWAY_API_KEY not configured" };

  try {
    const res = await fetch(`${RUNWAY_BASE}/text_to_video`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({
        model: env.RUNWAY_MODEL?.trim() || "gen4_turbo",
        promptText: buildPromptText(scenes, niche),
        ratio: opts.ratio ?? "720:1280", // vertical by default — TikTok/IG/Shorts
        duration: opts.durationSeconds ?? 5,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Runway ${res.status}: ${body.slice(0, 400)}` };
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) return { ok: false, error: "Runway response had no task id" };
    return { ok: true, taskId: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RunwayPollResult {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  videoUrl?: string;
  error?: string;
}

/** One poll of a submitted task. Call at most once every 5s per Runway's
 * own rate guidance — index.ts's /render-check route is cron-driven (every
 * 6h alongside the content pass), which is comfortably under that, so no
 * extra throttling is needed here. */
export async function pollVideoTask(env: Env, taskId: string): Promise<RunwayPollResult> {
  try {
    const res = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
      method: "GET",
      headers: headers(env),
    });
    if (!res.ok) {
      const body = await res.text();
      return { status: "FAILED", error: `Runway ${res.status}: ${body.slice(0, 400)}` };
    }
    const data = (await res.json()) as {
      status?: string;
      output?: string[];
      failure?: string;
    };
    const status = (data.status ?? "PENDING").toUpperCase() as RunwayPollResult["status"];
    if (status === "SUCCEEDED") {
      const videoUrl = data.output?.[0];
      if (!videoUrl) return { status: "FAILED", error: "Runway task succeeded but returned no output URL" };
      return { status, videoUrl };
    }
    if (status === "FAILED") {
      return { status, error: data.failure || "Runway task failed with no reason given" };
    }
    return { status }; // PENDING or RUNNING — caller checks again next cycle
  } catch (err) {
    return { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}
