// gas/src/categories.ts
//
// Batch-type rotation. A job no longer produces the same kind of content on
// every pass; it cycles through its `rotation` list (default:
// affiliate -> job_opportunity -> educational -> affiliate ...). Each type has
// its own brief, so the model is told exactly what the batch is for instead
// of defaulting to affiliate promotion every time.

import type { ContentCategory, GrowthJob } from "./types";
import { CONTENT_CATEGORIES, DEFAULT_ROTATION } from "./types";

export interface RotationPick {
  category: ContentCategory;
  /** How many full trips through the rotation have completed. Used to vary
   * the topic / role within a category so consecutive batches of the same
   * type don't repeat each other. */
  cycle: number;
  /** Value to store as rotation_index after this pass succeeds. */
  nextIndex: number;
}

function sanitizeRotation(raw: unknown): ContentCategory[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ROTATION];
  const valid = raw.filter((c): c is ContentCategory => CONTENT_CATEGORIES.includes(c as ContentCategory));
  return valid.length > 0 ? valid : [...DEFAULT_ROTATION];
}

/** Which batch type this job's NEXT pass should be. Pure function of the
 * job row, so it's the same answer no matter which cron tick asks. */
export function pickCategory(job: Pick<GrowthJob, "rotation" | "rotation_index">): RotationPick {
  const rotation = sanitizeRotation(job.rotation);
  const idx = Math.max(0, job.rotation_index ?? 0);
  return {
    category: rotation[idx % rotation.length],
    cycle: Math.floor(idx / rotation.length),
    nextIndex: idx + 1,
  };
}

// ── Job opportunity batch ────────────────────────────────────────────────

const JOB_ROLES = [
  "Chief Financial Officer (CFO)",
  "Finance Manager",
  "Financial Controller",
] as const;

// ── Educational batch ────────────────────────────────────────────────────

const EDUCATIONAL_TOPICS = [
  "Nigerian tax: how VAT, company income tax and withholding tax obligations show up in a finance team's monthly calendar",
  "Capital markets: how the Nigerian Exchange (NGX) works for a retail investor, from CSCS account to settlement",
  "Treasury management: cash forecasting and liquidity buffers for a Nigerian mid-sized business",
  "Accounting: IFRS 9 expected credit loss (ECL) staging explained in plain language",
  "Investment: how Nigerian treasury bills, FGN bonds and money market funds compare, and what drives their yields",
  "Corporate finance: working capital and the cash conversion cycle, with a Nigerian SME example",
  "Financial reporting: what a board actually wants to see in a monthly finance pack",
  "Nigerian tax: common compliance deadlines and penalties finance managers should have on their calendar",
  "Capital markets: reading a company's annual report before buying its shares",
  "Treasury: managing foreign exchange exposure when you invoice in naira but pay suppliers in dollars",
  "Accounting: month-end close discipline and the reconciliations that catch problems early",
  "Investment: diversification and risk basics for a salaried professional in Nigeria",
  "Supply chain finance and invoice factoring: how receivables become working capital",
  "Regulation: what CBN, SEC Nigeria and FRC Nigeria each oversee, in one short explainer",
] as const;

// ── Task builders ────────────────────────────────────────────────────────

export interface CategoryBrief {
  /** Instruction text placed before the shared PIECE_FORMAT_INSTRUCTIONS. */
  task: string;
  /** Short label stored in logs / summaries. */
  label: string;
}

export function affiliateBrief(job: GrowthJob, countLine: string, platformLine: string): CategoryBrief {
  return {
    label: "affiliate",
    task:
      `BATCH TYPE: AFFILIATE PRODUCT PROMOTION.\n` +
      `${countLine} of content for the '${job.niche}' affiliate niche. Goal: ${job.goal}. ` +
      `${platformLine}` +
      `Promote a product or offer with a clear audience pain point, real value, and a CTA. ` +
      `Never invent commission rates, offer terms or performance numbers; use [NEEDS INPUT].`,
  };
}

export function jobOpportunityBrief(job: GrowthJob, cycle: number, countLine: string, platformLine: string): CategoryBrief {
  const role = JOB_ROLES[cycle % JOB_ROLES.length];
  const leads = job.job_leads?.trim();
  const leadsBlock = leads
    ? `REAL OPENINGS PROVIDED BY THE OPERATOR (use these, and only these, as the vacancies):\n${leads}\n\n` +
      `Do not add details that are not in the list above. Anything missing (deadline, salary, apply link) becomes [NEEDS INPUT].`
    : `NO REAL OPENINGS WERE PROVIDED. You have no way to look up live vacancies, so you must NOT invent employers, ` +
      `salaries, locations, deadlines or application links. Write a role-spotlight post instead: what the role involves, ` +
      `what employers typically look for (qualifications such as ACA/ACCA/ICAN, experience, systems and reporting skills, ` +
      `Nigerian regulatory exposure), and how a candidate should position themselves. Put [NEEDS INPUT: employer], ` +
      `[NEEDS INPUT: location], [NEEDS INPUT: apply link] wherever a real vacancy detail would go, so the operator can ` +
      `fill them in before posting.`;
  return {
    label: "job_opportunity",
    task:
      `BATCH TYPE: JOB OPPORTUNITY.\n` +
      `${countLine} of content about career opportunities for senior finance professionals. ` +
      `Focus role for this batch: ${role}. Other roles in scope across batches: ${JOB_ROLES.join(", ")}. ` +
      `${platformLine}` +
      `This batch is NOT affiliate promotion: no affiliate links, no product pitch, no trading-app CTAs. ` +
      `Set content_type to post_ideas (or video for short video platforms) and leave tracking_subid as a short tag such as 'job-${role.split(" ")[0].toLowerCase()}'.\n\n` +
      `${leadsBlock}\n\n` +
      `Tone: professional, credible, LinkedIn-native. CTA: invite candidates to comment, message, or apply through the link.`,
  };
}

export function educationalBrief(job: GrowthJob, cycle: number, countLine: string, platformLine: string): CategoryBrief {
  const topic = EDUCATIONAL_TOPICS[cycle % EDUCATIONAL_TOPICS.length];
  return {
    label: "educational",
    task:
      `BATCH TYPE: PURE EDUCATIONAL / INFORMATIONAL.\n` +
      `${countLine} of educational content for finance professionals and informed investors. ` +
      `Suggested topic for this batch: ${topic}. If you produce more than one piece, vary the angle, ` +
      `or pick closely related sub-topics from this wider scope: finance, accounting, Nigerian tax regulation, ` +
      `capital markets, treasury, investment. ` +
      `${platformLine}` +
      `This batch is NOT promotional: no affiliate links, no product mentions, no sales CTA, no job ads. ` +
      `Teach something concrete a reader can use, with a clear hook, a simple structure (for example 3 to 5 points), ` +
      `and a soft closing line inviting discussion (a question to the audience works well). ` +
      `Set content_type to post_ideas (or video for short video platforms).\n\n` +
      `ACCURACY RULES: Nigerian tax law, rates, thresholds, deadlines and regulator rules change. Name the relevant law ` +
      `or regulator where you are confident of it, but do not state specific rates, thresholds or dates unless you are ` +
      `certain they are current. Where a figure matters, write it as [VERIFY: <what to check and against which source>] ` +
      `so the operator confirms it before posting. Never present general education as personalised tax, legal or ` +
      `investment advice; add a one-line "general information, not advice" note on tax and investment pieces.`,
  };
}

/** Builds the category-specific brief. `countLine` is e.g. "Generate exactly 1 piece(s)". */
export function buildCategoryBrief(
  category: ContentCategory,
  job: GrowthJob,
  cycle: number,
  countLine: string,
  platformLine: string,
): CategoryBrief {
  switch (category) {
    case "job_opportunity":
      return jobOpportunityBrief(job, cycle, countLine, platformLine);
    case "educational":
      return educationalBrief(job, cycle, countLine, platformLine);
    case "affiliate":
    default:
      return affiliateBrief(job, countLine, platformLine);
  }
}
