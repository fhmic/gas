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
}

export interface GrowthJob {
  id: string;
  niche: string;
  goal: string;
  platforms: string[];
  networks: string[];
  cadence_hours: number;
  posts_per_run: number;
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
