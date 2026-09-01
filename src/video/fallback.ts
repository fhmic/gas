// gas/src/video/fallback.ts
//
// Zero-external-API fallback for video-type drafts. Used automatically
// whenever RUNWAY_API_KEY is unset, or a Runway submit/poll call fails —
// see video/index.ts for the routing logic.
//
// "Zero external API" here means: no third-party vendor account, no extra
// API key to buy or manage, nothing billed outside your existing Cloudflare
// account. It does NOT mean "runs for free with infinite compute" — it
// calls Cloudflare Workers AI (env.AI), which is a first-party binding
// (configured once in wrangler.toml, no signup beyond the Cloudflare
// account this Worker already deploys to), and writes results to your own
// R2 bucket.
//
// Honest limitation, stated plainly: a stateless Cloudflare Worker has no
// ffmpeg binary and a hard per-request CPU-time ceiling, so this does NOT
// assemble a finished, playable MP4. What it DOES produce, fully
// automatically and without touching a third-party vendor: one AI-generated
// still image per scene plus one AI-generated narration audio track,
// uploaded to R2 with public URLs. Dropping those into any video editor
// (CapCut, InShot, Canva, even Cloudflare Stream's own uploader) is a
// sub-one-minute assembly step from there. If you later want that last step
// automated too, the plug-in point is a render-as-a-service API
// (Shotstack/Creatomate take exactly this image+audio+caption shape as a
// JSON timeline) — that's the one place a genuinely zero-API fallback has
// to hand off to something else, because "encode a video file" is not a
// thing a stateless edge function can do on its own.
//
// Model IDs below are current as of 2026-08 in Cloudflare's Workers AI
// catalog. Like the LLM model names in llm.ts, these get renamed/retired
// occasionally — if a call here 404s, check
// https://developers.cloudflare.com/workers-ai/models/ and swap the id.

import type { Env, VideoRenderResult, VideoScene } from "../types";

const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const TTS_MODEL = "@cf/myshell-ai/melotts";

/** Workers AI responses vary by model family: some return a base64 string
 * under a named field ({ image: "..." } / { audio: "..." }), others return
 * raw bytes directly (ReadableStream/ArrayBuffer). Normalizing here means
 * the two call sites below don't need to know which shape their model uses. */
async function toBytes(result: unknown): Promise<Uint8Array> {
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof ReadableStream) {
    const buf = await new Response(result).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const b64 = (obj.image ?? obj.audio) as string | undefined;
    if (typeof b64 === "string") {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
  }
  throw new Error("Unrecognized Workers AI response shape — check the model's current output format");
}

function publicUrl(env: Env, key: string): string {
  const base = env.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  // Falls back to a clearly-labeled placeholder rather than a broken link —
  // the file IS in R2 either way (fetchable via `wrangler r2 object get`),
  // this just flags that no public serving domain is configured yet.
  return base ? `${base}/${key}` : `r2-key:${key} (set MEDIA_PUBLIC_BASE_URL to get a real URL)`;
}

async function generateSceneImage(env: Env, prompt: string, key: string): Promise<string> {
  const result = await env.AI.run(IMAGE_MODEL, {
    // Scene captions are already tracked separately (VideoRenderResult.assets.captions,
    // one per scene) and overlaid at the video-editing step — the image itself was never
    // meant to carry any words. Without an explicit "no text" instruction, feeding raw
    // narration prose (e.g. "...tax season...") straight in as the prompt reads to the
    // model as a request to render that word on-screen, and flux-1-schnell (the fast,
    // distilled variant used here for low latency) is known to misspell rendered text
    // badly — "tax" -> "tox" and similar. Suppressing on-screen text entirely, rather
    // than trying to get the spelling right, is the fix: it also matches the prompt
    // Runway gets in runway.ts ("...no on-screen text.").
    prompt: `${prompt}. Vertical composition, bold and eye-catching, suitable for a social media video frame. No text, no words, no letters, no captions, no typography, no writing of any kind — image only.`,
  });
  const bytes = await toBytes(result);
  await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  return publicUrl(env, key);
}

async function generateNarrationAudio(env: Env, fullNarration: string, key: string): Promise<string> {
  const result = await env.AI.run(TTS_MODEL, { prompt: fullNarration, lang: "en" });
  const bytes = await toBytes(result);
  await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType: "audio/wav" } });
  return publicUrl(env, key);
}

/** Generates the fallback asset pack for one draft. Never throws — a
 * partial success (e.g. images worked, TTS model hiccupped) still returns
 * whatever it managed, with the failure noted in `error`, rather than
 * discarding a mostly-successful pass. */
export async function renderFallbackSlideshow(
  env: Env,
  scenes: VideoScene[],
  draftIdHint: string,
): Promise<VideoRenderResult> {
  const images: string[] = [];
  const imageKeys: string[] = [];
  const captions: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    captions.push(scene.narration);
    const key = `gas/${draftIdHint}/scene-${i}.png`;
    try {
      const url = await generateSceneImage(env, scene.visual_prompt, key);
      images.push(url);
      imageKeys.push(key);
    } catch (err) {
      failures.push(`scene ${i} image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let audioUrl = "";
  const audioKey = `gas/${draftIdHint}/narration.wav`;
  try {
    const fullNarration = scenes.map((s) => s.narration).join(" ");
    audioUrl = await generateNarrationAudio(env, fullNarration, audioKey);
  } catch (err) {
    failures.push(`narration audio: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (images.length === 0 && !audioUrl) {
    return {
      status: "failed",
      provider: "fallback_slideshow",
      error: `Fallback pipeline produced nothing usable: ${failures.join(" | ")}`,
    };
  }

  return {
    status: "fallback_ready",
    provider: "fallback_slideshow",
    assets: { images, image_keys: imageKeys, audio_url: audioUrl, audio_key: audioUrl ? audioKey : "", captions },
    error: failures.length > 0 ? `Partial success — ${failures.join(" | ")}` : undefined,
  };
}
