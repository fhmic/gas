// gas/src/agent.ts
import type { Env, GrowthJob, ContentDraft } from "./types";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { generateWithSummary } from "./anthropic";
import { insertDrafts, logRun } from "./db";
import type { SupabaseClient } from "@supabase/supabase-js";

function buildTask(job: GrowthJob): string {
  return [
    `Generate ${job.posts_per_run} pieces of content for the '${job.niche}' `,
    `affiliate niche. Goal: ${job.goal}. `,
    `Target platforms: ${job.platforms.join(", ")}. `,
    "",
    "For EACH piece, output a clearly delimited block in exactly this form ",
    "(so it can be parsed programmatically) — repeat the block once per piece:",
    "",
    "---PIECE---",
    "platform: <one of the target platforms>",
    "content_type: <post_ideas | video_script | email_sequence | ad_copy | landing_page>",
    "title: <short internal title>",
    "tracking_subid: <short lowercase-hyphenated tag>",
    "body: |",
    "  <the actual content, multi-line ok>",
    "---END---",
    "",
    "After all pieces, still include the mandatory LITE EXECUTIVE SUMMARY block.",
  ].join("\n");
}

function parseDrafts(text: string): ContentDraft[] {
  const drafts: ContentDraft[] = [];
  const pieceRe = /---PIECE---([\s\S]*?)---END---/g;
  let m: RegExpExecArray | null;
  while ((m = pieceRe.exec(text)) !== null) {
    const block = m[1];
    const get = (key: string): string => {
      const re = new RegExp(`${key}\\s*:\\s*\\|?\\s*([\\s\\S]*?)(?=\\n\\w+\\s*:|$)`, "i");
      const mm = re.exec(block);
      return mm ? mm[1].trim() : "";
    };
    const platform = get("platform");
    const body = get("body");
    if (!platform || !body) continue; // skip malformed pieces rather than insert junk
    drafts.push({
      platform,
      content_type: get("content_type") || "post_ideas",
      title: get("title") || `${platform} draft`,
      tracking_subid: get("tracking_subid") || undefined,
      body,
    });
  }
  return drafts;
}

/** Runs one content-generation pass for a single job. Never throws —
 * failures are logged to run_log and surfaced in the return value instead,
 * so one bad job doesn't stop the cron cycle from processing the rest. */
export async function runContentPass(
  db: SupabaseClient,
  env: Env,
  job: GrowthJob
): Promise<{ ok: boolean; draftsCreated: number; error?: string }> {
  try {
    const task = buildTask(job);
    const { text, summary } = await generateWithSummary(env, SYSTEM_PROMPT, task);
    const drafts = parseDrafts(text);
    const created = await insertDrafts(db, job.id, drafts);

    await logRun(db, {
      jobId: job.id,
      action: "content_pass",
      ok: true,
      draftsCreated: created,
      summary,
    });

    return { ok: true, draftsCreated: created };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logRun(db, { jobId: job.id, action: "content_pass", ok: false, error: message });
    return { ok: false, draftsCreated: 0, error: message };
  }
}
