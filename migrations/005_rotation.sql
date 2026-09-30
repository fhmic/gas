-- gas/migrations/005_rotation.sql
-- Run after 004_scheduling.sql. Adds batch-type rotation so a job no longer
-- produces the same kind of content every pass:
--
--   pass 1 -> affiliate          (affiliate product promotion)
--   pass 2 -> job_opportunity    (CFO / Finance Manager / Financial Controller roles)
--   pass 3 -> educational        (finance, accounting, Nigerian tax, capital markets, treasury, investment)
--   pass 4 -> affiliate ... and so on
--
-- rotation       : ordered list of batch types for this job (edit to reorder,
--                  drop a type, or repeat one). Default is the 3-step cycle above.
-- rotation_index : how many passes have completed; the next pass uses
--                  rotation[rotation_index % length(rotation)].
-- job_leads      : OPTIONAL free text of real openings you want promoted
--                  (employer, role, location, link, deadline). When empty, the
--                  agent writes role-spotlight posts with [NEEDS INPUT]
--                  placeholders and never invents employers or vacancies.
-- content_category on content_queue records which batch type produced a draft.

alter table growth_jobs
  add column if not exists rotation text[] not null
    default array['affiliate','job_opportunity','educational'],
  add column if not exists rotation_index integer not null default 0,
  add column if not exists job_leads text;

alter table content_queue
  add column if not exists content_category text not null default 'affiliate';

create index if not exists idx_content_queue_category
  on content_queue(content_category, created_at desc);
