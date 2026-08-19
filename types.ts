// gas/src/types.ts

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  WORKER_SHARED_SECRET: string;
  PARTNERSTACK_API_KEY: string;
  EXNESS_EMAIL: string;
  EXNESS_PASSWORD: string;
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
