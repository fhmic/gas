-- gas/migrations/002_video.sql
-- Run this in the Supabase SQL editor AFTER schema.sql. Adds real-video-
-- rendering support to content_queue: a draft can now carry an actual
-- rendered asset (Runway) or a Workers-AI-generated fallback slideshow
-- (images + narration audio, zero external API), instead of only text.
--
-- Nothing here changes the approval model — approve/reject still work
-- exactly as before regardless of media_type.

alter table content_queue
  add column if not exists media_type     text not null default 'text',     -- text | video
  add column if not exists video_status   text,                              -- null | queued | rendering | ready | failed | fallback_ready
  add column if not exists video_provider text,                              -- runway | fallback_slideshow
  add column if not exists video_url      text,                              -- final MP4 URL (Runway) once ready
  add column if not exists video_task_id  text,                              -- Runway's task id, used by the poller
  add column if not exists video_assets   jsonb,                             -- fallback: { images: [...url], audio_url, captions: [...] }
  add column if not exists render_error   text;

create index if not exists idx_content_queue_video_status
  on content_queue(video_status)
  where video_status in ('queued', 'rendering');
