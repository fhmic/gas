// gas/src/report.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NetworkSnapshot } from "./types";
import { latestSnapshotBefore } from "./db";

interface BuildReportParams {
  db: SupabaseClient;
  periodStart: string; // ISO timestamp
  periodEnd: string;   // ISO timestamp
  currentSnapshots: NetworkSnapshot[];
}

export interface ReportResult {
  period_start: string;
  period_end: string;
  drafts_created: number;
  pending_review: number;
  leads_delta: number;
  conversions_delta: number;
  earnings_delta: number;
  currency: string;
  summary_text: string;
  metrics: Record<string, unknown>;
}

function delta(current: number | null, previous: number | null): number {
  if (current === null) return 0;
  return current - (previous ?? 0);
}

export async function buildReport({
  db,
  periodStart,
  periodEnd,
  currentSnapshots,
}: BuildReportParams): Promise<ReportResult> {
  // Drafts created in this window
  const { count: draftsCreated } = await db
    .from("content_queue")
    .select("id", { count: "exact", head: true })
    .gte("created_at", periodStart)
    .lt("created_at", periodEnd);

  const { count: pendingReview } = await db
    .from("content_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending_approval");

  const perNetwork: Record<string, unknown> = {};
  let leadsDelta = 0;
  let conversionsDelta = 0;
  let earningsDelta = 0;
  let currency = "USD";

  for (const snap of currentSnapshots) {
    const prev = await latestSnapshotBefore(db, snap.network, periodStart);
    const dLeads = delta(snap.leads, prev?.leads ?? null);
    const dConversions = delta(snap.conversions, prev?.conversions ?? null);
    const dEarnings = delta(snap.earnings, prev?.earnings ?? null);

    leadsDelta += dLeads;
    conversionsDelta += dConversions;
    earningsDelta += dEarnings;
    if (snap.currency) currency = snap.currency;

    perNetwork[snap.network] = {
      ok: snap.ok,
      error: snap.error,
      clicks_now: snap.clicks,
      leads_now: snap.leads,
      conversions_now: snap.conversions,
      earnings_now: snap.earnings,
      leads_delta: dLeads,
      conversions_delta: dConversions,
      earnings_delta: dEarnings,
    };
  }

  const failedNetworks = currentSnapshots.filter((s) => !s.ok).map((s) => s.network);

  const lines: string[] = [];
  lines.push(`While you were away (${periodStart} to ${periodEnd}):`);
  lines.push(`- Content drafted: ${draftsCreated ?? 0} new piece(s), ${pendingReview ?? 0} awaiting your approval.`);
  lines.push(`- New leads: ${leadsDelta}`);
  lines.push(`- New conversions: ${conversionsDelta}`);
  lines.push(`- Earnings this period: ${earningsDelta.toFixed(2)} ${currency}`);
  if (failedNetworks.length > 0) {
    lines.push(`- Could not reach: ${failedNetworks.join(", ")} (check credentials/logs).`);
  }

  return {
    period_start: periodStart,
    period_end: periodEnd,
    drafts_created: draftsCreated ?? 0,
    pending_review: pendingReview ?? 0,
    leads_delta: leadsDelta,
    conversions_delta: conversionsDelta,
    earnings_delta: earningsDelta,
    currency,
    summary_text: lines.join("\n"),
    metrics: perNetwork,
  };
}
