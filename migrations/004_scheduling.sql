-- gas/migrations/004_scheduling.sql
-- Run after 003_features.sql. Fixes two related things:
--
-- 1. cadence_hours was stored on every job but never actually enforced —
--    the Worker's global cron (wrangler.toml, every 6h by default) ran a
--    fresh content pass for EVERY active job on EVERY tick, no matter what
--    that job's own cadence_hours said. last_run_at is what makes cadence
--    real: getActiveJobs now only returns jobs that are actually due.
--
-- 2. posts_per_run left the split across platforms up to the LLM's own
--    judgment — it could put 2 pieces on TikTok and 0 on LinkedIn in one
--    pass. posts_per_platform (when set) generates exactly that many
--    pieces for EACH platform in the job, guaranteed by the code doing one
--    generation call per platform rather than trusting the model to split
--    evenly.

alter table growth_jobs
  add column if not exists posts_per_platform integer,
  add column if not exists last_run_at timestamptz;
