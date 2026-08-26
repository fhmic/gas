// gas/src/anthropic.ts
import type { Env, LiteExecutiveSummary } from "./types";

export async function callClaude(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2000
): Promise<string> {
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
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text;
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

/** Ensures the mandatory summary block is present, retrying once if not. */
export async function generateWithSummary(
  env: Env,
  systemPrompt: string,
  userPrompt: string
): Promise<{ text: string; summary: LiteExecutiveSummary }> {
  let text = await callClaude(env, systemPrompt, userPrompt);

  if (!/LITE EXECUTIVE SUMMARY/i.test(text)) {
    const followUp =
      "Your previous response did not include the mandatory " +
      "'## LITE EXECUTIVE SUMMARY' block. Reply with ONLY that block, " +
      "summarising the response below, using the exact field labels " +
      "Opportunity / Recommended Action / Expected ROI / Risk Level / " +
      "Priority / Next Actions.\n\n---\n" +
      text;
    try {
      const addendum = await callClaude(env, systemPrompt, followUp, 500);
      text = `${text}\n\n${addendum}`;
    } catch {
      // Ship what we have; parseLiteSummary degrades gracefully to empty fields.
    }
  }

  return { text, summary: parseLiteSummary(text) };
}
