// gas/src/types.ts

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WORKER_SHARED_SECRET: string;
  PARTNERSTACK_API_KEY: string;
  EXNESS_EMAIL: string;
  EXNESS_PASSWORD: string;

  // LLM provider chain — tried in this order, first configured (key present)
  // AND successful one wins. Gemini first: free-tier friendly while GAS is
  // in testing. Claude stays in the chain so it kicks in automatically the
  // moment ANTHROPIC_API_KEY is added later, no code change needed then.
  // Every key below is optional at the type level — callProvider() in
  // llm.ts filters to whichever ones are actually set at runtime.
  GOOGLE_GEMINI_API_KEY?: string;
  GOOGLE_GEMINI_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_MODEL?: string;
  HUGGINGFACE_API_KEY?: string;
  HUGGINGFACE_MODEL?: string;

  // ── Real video rendering ────────────────────────────────────────────
  // Primary path: Runway's text-to-video API (async task, polled to
  // completion). Optional — if unset, every video-type draft goes straight
  // to the fallback path below instead of erroring.
  RUNWAY_API_KEY?: string;
  RUNWAY_MODEL?: string;          // default: "gen4_turbo" — see video/runway.ts
  RUNWAY_API_VERSION?: string;    // default: "2024-11-06" — Runway requires a dated version header

  // Fallback path: Cloudflare Workers AI (bound, not a third-party network
  // call — no extra signup, no extra key, billed to the same Cloudflare
  // account this Worker already runs on). Used automatically whenever
  // Runway is unset OR a Runway render fails/times out. Produces an
  // AI-generated image set + narration audio ("slideshow assets") rather
  // than a fully assembled MP4 — see video/fallback.ts for why a stateless
  // Worker can't do full video encoding, and what "ready" means for this
  // path.
  AI: Ai;
  MEDIA_BUCKET: R2Bucket;
  MEDIA_PUBLIC_BASE_URL?: string; // e.g. "https://media.yourdomain.com" (R2 custom domain / public bucket URL)
}

export interface GrowthJob {
  id: string;
  niche: string;
  goal: string;
  platforms: string[];
  networks: string[];
  cadence_hours: number;
  posts_per_run: number;
  posts_per_platform?: number | null; // when set, overrides posts_per_run — exactly this many pieces per platform, guaranteed (not left to the LLM's split)
  last_run_at?: string | null;        // last time this job's cadence was honored — see getActiveJobs in db.ts
  status: "active" | "paused";
  created_at: string;
  updated_at: string;
}

export interface LiteExecutiveSummary {
  opportunity: string;
  recommended_action: string;
  expected_roi: string;
  risk_level: string;
  priority: string;
  next_actions: string[];
}

export interface NetworkSnapshot {
  network: "partnerstack" | "exness";
  ok: boolean;
  error?: string;
  clicks: number | null;
  leads: number | null;
  conversions: number | null;
  earnings: number | null;
  currency: string;
  raw: unknown;
}

export interface ContentDraft {
  platform: string;
  content_type: string;
  title: string;
  body: string;
  tracking_subid?: string;
}

// ── Video rendering ─────────────────────────────────────────────────────

/** A single scene the video pipeline needs to realize — parsed out of a
 * video-type draft's script body before rendering. */
export interface VideoScene {
  narration: string;   // what's spoken/captioned for this scene
  visual_prompt: string; // what should be ON SCREEN for this scene
}

export type VideoStatus = "queued" | "rendering" | "ready" | "failed" | "fallback_ready";
export type VideoProvider = "runway" | "fallback_slideshow";

/** Result of attempting to render one draft's video. Always returns a
 * status rather than throwing — a failed/degraded render still needs to
 * land in content_queue so it's visible in the review queue instead of
 * silently vanishing. */
export interface VideoRenderResult {
  status: VideoStatus;
  provider: VideoProvider;
  video_url?: string;     // set once status === "ready" (Runway MP4)
  video_task_id?: string; // set while status === "queued" | "rendering" (Runway poll handle)
  assets?: {               // set once status === "fallback_ready"
    images: string[];      // R2 public URLs (or r2-key: placeholders), one per scene
    image_keys: string[];  // raw R2 object keys, same order as images — used for delete cleanup
    audio_url: string;     // R2 public URL, full narration track (Workers AI TTS)
    audio_key: string;     // raw R2 object key for the audio
    captions: string[];    // per-scene caption text, same order as images
  };
  error?: string;
}
