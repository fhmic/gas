// gas/src/networks/partnerstack.ts
//
// PartnerStack Partner REST API (v2). Bearer auth using your own partner
// api_key (Partner dashboard -> Settings -> API). Docs:
// https://docs.partnerstack.com/docs/partner-api
//
// `/rewards` is confirmed and gives your earned/paid rewards. PartnerStack's
// exact list of partner-side list endpoints (leads/customers) can vary by
// program, so this adapter is defensive: it always stores the full raw
// response in `raw`, and only promotes fields into the typed columns when
// they're actually present, rather than guessing field names and silently
// reporting zero.

import type { Env, NetworkSnapshot } from "../types";

const BASE = "https://api.partnerstack.com/api/v2";

async function psGet(env: Env, path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.PARTNERSTACK_API_KEY}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PartnerStack ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

function sumField(items: any[], candidates: string[]): number | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  for (const field of candidates) {
    if (items[0]?.[field] !== undefined) {
      return items.reduce((acc, it) => acc + (Number(it[field]) || 0), 0);
    }
  }
  return null;
}

export async function pollPartnerStack(env: Env): Promise<NetworkSnapshot> {
  if (!env.PARTNERSTACK_API_KEY) {
    return {
      network: "partnerstack",
      ok: false,
      error: "PARTNERSTACK_API_KEY not configured",
      clicks: null,
      leads: null,
      conversions: null,
      earnings: null,
      currency: "USD",
      raw: null,
    };
  }

  try {
    const rewards = await psGet(env, "/rewards?limit=100");
    const items: any[] = rewards?.data?.items ?? [];

    // Reward amounts on PartnerStack are typically in cents.
    const earningsCents = sumField(items, ["amount", "value"]);
    const earnings = earningsCents !== null ? earningsCents / 100 : null;

    return {
      network: "partnerstack",
      ok: true,
      clicks: null,        // not exposed on /rewards; see README for the subid/S2S note
      leads: null,
      conversions: items.length || null,
      earnings,
      currency: items[0]?.currency ?? "USD",
      raw: rewards,
    };
  } catch (err) {
    return {
      network: "partnerstack",
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
