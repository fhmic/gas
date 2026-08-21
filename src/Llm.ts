// gas/src/llm.ts
//
// Multi-provider LLM chain for GAS, same shape and philosophy as EVA's
// callProvider in eva.server.ts: try each *configured* provider (one with a
// key actually set) in order, fall through to the next on any failure,
// aggregate every failure reason into one clear error if all of them fail.
//
// Order: Gemini first (generous genuinely-free tier — the right default
// while GAS is still in testing and pre-revenue), then Claude (kicks in
// automatically the moment ANTHROPIC_API_KEY is added later — no code
// change needed then), then Groq, then OpenRouter/NVIDIA/HuggingFace as
// further free-tier fallbacks. Model names below match the ones just
// verified working against each provider's live API for EVA on 2026-08-20 —
// keep the two in sync if either changes again.

import type { Env, LiteExecutiveSummary } from "./types";

type ChatMessage = { role: "user" | "assistant"; content: string };

interface Provider {
  name: string;
  configured: boolean;
  call: () => Promise<string>;
}

function normalizeBase(base: string | undefined, fallback: string): string {
  const b = (base || fallback).trim();
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

async function callGemini(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  const base = "https://generativelanguage.googleapis.com";
  // gemini-2.0-flash was retired 2026-08; gemini-3.6-flash is the current
  // replacement (confirmed directly from Google's own 404 error message).
  const model = env.GOOGLE_GEMINI_MODEL?.trim() || "gemini-3.6-flash";

  const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error("Gemini returned an empty response");
  return text;
}

async function callClaude(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Claude returned an empty response");
  return text;
}

/** Shared caller for every OpenAI-compatible chat/completions provider
 * (Groq, OpenRouter, NVIDIA NIM, HuggingFace router) — same request/response
 * shape, only the base URL, key, and model differ. */
async function callOpenAICompatible(
  providerName: string,
  base: string,
  key: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ] as ChatMessage[],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${providerName} ${res.status} (${model}): ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error(`${providerName} returned an empty response`);
  return text;
}

async function callGroq(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  // llama-3.1-8b-instant was deprecated by Groq 2026-06-17, hard shutdown
  // 2026-08-16 — openai/gpt-oss-20b is Groq's official replacement.
  return callOpenAICompatible(
    "Groq",
    normalizeBase(undefined, "https://api.groq.com/openai"),
    env.GROQ_API_KEY ?? "",
    env.GROQ_MODEL?.trim() || "openai/gpt-oss-20b",
    system,
    user,
    maxTokens,
  );
}

async function callOpenRouter(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  return callOpenAICompatible(
    "OpenRouter",
    normalizeBase(undefined, "https://openrouter.ai/api"),
    env.OPENROUTER_API_KEY ?? "",
    env.OPENROUTER_MODEL?.trim() || "openai/gpt-4o-mini",
    system,
    user,
    maxTokens,
  );
}

async function callNvidia(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  return callOpenAICompatible(
    "NVIDIA NIM",
    normalizeBase(undefined, "https://integrate.api.nvidia.com"),
    env.NVIDIA_API_KEY ?? "",
    env.NVIDIA_MODEL?.trim() || "meta/llama-3.3-70b-instruct",
    system,
    user,
    maxTokens,
  );
}

async function callHuggingFace(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  // HF moved chat models to router.huggingface.co (OpenAI-compatible) —
  // the old api-inference.huggingface.co/models/{id} endpoint is legacy.
  return callOpenAICompatible(
    "HuggingFace",
    normalizeBase(undefined, "https://router.huggingface.co"),
    env.HUGGINGFACE_API_KEY ?? "",
    env.HUGGINGFACE_MODEL?.trim() || "meta-llama/Llama-3.1-8B-Instruct",
    system,
    user,
    maxTokens,
  );
}

/** Tries every provider that actually has a key configured, in priority
 * order, falling through to the next on any failure. Throws only if every
 * configured provider failed, with every individual reason included — same
 * pattern as EVA's callProvider, so a failure here is just as diagnosable. */
export async function callProvider(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2000,
): Promise<string> {
  const providers: Provider[] = [
    {
      name: "Gemini",
      configured: !!env.GOOGLE_GEMINI_API_KEY,
      call: () => callGemini(env, systemPrompt, userPrompt, maxTokens),
    },
    {
      name: "Claude",
      configured: !!env.ANTHROPIC_API_KEY,
      call: () => callClaude(env, systemPrompt, userPrompt, maxTokens),
    },
    {
      name: "Groq",
      configured: !!env.GROQ_API_KEY,
      call: () => callGroq(env, systemPrompt, userPrompt, maxTokens),
    },
    {
      name: "OpenRouter",
      configured: !!env.OPENROUTER_API_KEY,
      call: () => callOpenRouter(env, systemPrompt, userPrompt, maxTokens),
    },
    {
      name: "NVIDIA NIM",
      configured: !!env.NVIDIA_API_KEY,
      call: () => callNvidia(env, systemPrompt, userPrompt, maxTokens),
    },
    {
      name: "HuggingFace",
      configured: !!env.HUGGINGFACE_API_KEY,
      call: () => callHuggingFace(env, systemPrompt, userPrompt, maxTokens),
    },
  ];

  const configured = providers.filter((p) => p.configured);
  if (configured.length === 0) {
    throw new Error(
      "No LLM provider is configured — set at least one of GOOGLE_GEMINI_API_KEY, " +
        "ANTHROPIC_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY, " +
        "HUGGINGFACE_API_KEY via `wrangler secret put`.",
    );
  }

  const failures: string[] = [];
  for (const provider of configured) {
    try {
      return await provider.call();
    } catch (err) {
      failures.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All configured providers failed:\n${failures.join("\n")}`);
}

const FIELD_RE =
  /(Opportunity|Recommended Action|Expected ROI|Risk Level|Priority)\s*:\s*([\s\S]*?)(?=\n(?:Opportunity|Recommended Action|Expected ROI|Risk Level|Priority|Next Actions)\s*:|$)/gi;
const NEXT_ACTIONS_RE = /Next Actions\s*:\s*([\s\S]*)/i;
const SUMMARY_BLOCK_RE = /##\s*LITE EXECUTIVE SUMMARY\s*([\s\S]*)/i;

export function parseLiteSummary(text: string): LiteExecutiveSummary {
  const summary: LiteExecutiveSummary = {
    opportunity: "",
    recommended_action: "",
    expected_roi: "",
    risk_level: "",
    priority: "",
    next_actions: [],
  };

  const blockMatch = SUMMARY_BLOCK_RE.exec(text);
  const block = blockMatch ? blockMatch[1] : text;

  const keyMap: Record<string, keyof LiteExecutiveSummary> = {
    opportunity: "opportunity",
    "recommended action": "recommended_action",
    "expected roi": "expected_roi",
    "risk level": "risk_level",
    priority: "priority",
  };

  let m: RegExpExecArray | null;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(block)) !== null) {
    const label = m[1].trim().toLowerCase();
    const key = keyMap[label];
    if (key && key !== "next_actions") {
      (summary[key] as string) = m[2].trim();
    }
  }

  const actionsMatch = NEXT_ACTIONS_RE.exec(block);
  if (actionsMatch) {
    summary.next_actions = actionsMatch[1]
      .split("\n")
      .map((ln) => ln.replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter(Boolean);
  }

  return summary;
}

/** Ensures the mandatory summary block is present, retrying once (against
 * the same provider chain) if not. `maxTokens` controls the main generation
 * pass only — the summary-only retry always uses a small fixed budget,
 * since it's asking for a few short labelled fields, not fresh content. */
export async function generateWithSummary(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2000,
): Promise<{ text: string; summary: LiteExecutiveSummary }> {
  let text = await callProvider(env, systemPrompt, userPrompt, maxTokens);

  if (!/LITE EXECUTIVE SUMMARY/i.test(text)) {
    const followUp =
      "Your previous response did not include the mandatory " +
      "'## LITE EXECUTIVE SUMMARY' block. Reply with ONLY that block, " +
      "summarising the response below, using the exact field labels " +
      "Opportunity / Recommended Action / Expected ROI / Risk Level / " +
      "Priority / Next Actions.\n\n---\n" +
      text;
    try {
      const addendum = await callProvider(env, systemPrompt, followUp, 500);
      text = `${text}\n\n${addendum}`;
    } catch {
      // Ship what we have; parseLiteSummary degrades gracefully to empty fields.
    }
  }

  return { text, summary: parseLiteSummary(text) };
}
