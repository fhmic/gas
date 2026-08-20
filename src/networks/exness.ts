// gas/src/networks/exness.ts
//
// Exness Partnership API. Auth flow: POST email+password to /api/auth,
// receive a JWT, then use it as `Authorization: JWT <token>` on report
// endpoints. Schema/docs: https://my.exnessaffiliates.com/api/schema/
//
// Exness's exact reporting endpoint names have moved around across their
// docs revisions, so — same defensive approach as the PartnerStack adapter
// — this stores the full raw response and only promotes fields it actually
// finds. First real run: check `raw` in the earnings_snapshots table and
// tighten the field names below to match what your account returns.

import type { Env, NetworkSnapshot } from "../types";

const AUTH_URL = "https://my.exnessaffiliates.com/api/auth/";
const REPORT_URL = "https://my.exnessaffiliates.com/api/reports/partner/";

async function getExnessToken(env: Env): Promise<string> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: env.EXNESS_EMAIL, password: env.EXNESS_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Exness auth -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const token = (body as any)?.token ?? (body as any)?.access;
  if (!token) throw new Error("Exness auth: no token in response");
  return token;
}

function pick(obj: any, candidates: string[]): number | null {
  for (const key of candidates) {
    if (obj?.[key] !== undefined && obj[key] !== null) return Number(obj[key]);
  }
  return null;
}

export async function pollExness(env: Env): Promise<NetworkSnapshot> {
  if (!env.EXNESS_EMAIL || !env.EXNESS_PASSWORD) {
    return {
      network: "exness",
      ok: false,
      error: "EXNESS_EMAIL / EXNESS_PASSWORD not configured",
      clicks: null,
      leads: null,
      conversions: null,
      earnings: null,
      currency: "USD",
      raw: null,
    };
  }

  try {
    const token = await getExnessToken(env);
    const res = await fetch(REPORT_URL, {
      headers: { Authorization: `JWT ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Exness report -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }

    // Exness's Cellxpert-derived reports commonly use "clicks", "reg" /
    // "registrations", "ftd" (first-time deposits, i.e. conversions), and
    // "reward" / "commission" for earnings. Adjust once you see real `raw`.
    const summary = Array.isArray((body as any)?.results)
      ? (body as any).results[0]
      : body;

    return {
      network: "exness",
      ok: true,
      clicks: pick(summary, ["clicks", "click_count"]),
      leads: pick(summary, ["reg", "registrations", "leads"]),
      conversions: pick(summary, ["ftd", "conversions", "deposits"]),
      earnings: pick(summary, ["reward", "commission", "earnings"]),
      currency: summary?.currency ?? "USD",
      raw: body,
    };
  } catch (err) {
    return {
      network: "exness",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      clicks: null,
      leads: null,
      conversions: null,
      earnings: null,
      currency: "USD",
      raw: null,
    };
  }
}
