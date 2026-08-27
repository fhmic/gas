-- gas/migrations/003_features.sql
-- Run after 002_video.sql. Adds:
--   1. content_queue.source_brief — the niche/idea text used to generate a
--      piece, stored directly on the row instead of only via growth_jobs.
--      Needed so ad-hoc pieces (POST /generate, no job at all) and the
--      video-render poller both work without a growth_jobs join.
--   2. Backfill for existing rows so nothing already in the queue loses
--      its context.

alter table content_queue
  add column if not exists source_brief text;

update content_queue cq
set source_brief = gj.niche
from growth_jobs gj
where cq.job_id = gj.id
  and cq.source_brief is null;
