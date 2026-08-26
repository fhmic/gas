-- growth-agent-service/schema.sql
-- Run this in the Supabase SQL editor (same project style as EVA's va_progress etc).

create extension if not exists "pgcrypto";

-- One row per assignment you give the agent, e.g.
-- "grow the personal-finance-apps affiliate niche on IG + TikTok".
create table if not exists growth_jobs (
    id            uuid primary key default gen_random_uuid(),
    niche         text not null,
    goal          text not null default 'grow leads and affiliate revenue',
    platforms     text[] not null default array['Instagram','TikTok'],
    networks      text[] not null default array['partnerstack','exness'],
    cadence_hours integer not null default 6,        -- how often the cron does a content pass for this job
    posts_per_run integer not null default 3,
    status        text not null default 'active',    -- active | paused
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- Draft content the agent writes. Nothing here ever auto-posts —
-- status stays pending_approval until you approve it from LITE or Supabase.
create table if not exists content_queue (
    id             uuid primary key default gen_random_uuid(),
    job_id         uuid references growth_jobs(id) on delete cascade,
    platform       text not null,
    content_type   text not null,     -- post_ideas | video_script | email_sequence | ad_copy | landing_page
    title          text not null default '',
    body           text not null,
    tracking_subid text,              -- tag used in the affiliate link for this piece, for attribution
    status         text not null default 'pending_approval', -- pending_approval | approved | rejected | posted
    created_at     timestamptz not null default now(),
    reviewed_at    timestamptz
);

-- Raw polling snapshots pulled from each affiliate network on every cron tick.
-- Kept append-only so deltas (this run vs last run) can be computed for the report.
create table if not exists earnings_snapshots (
    id          uuid primary key default gen_random_uuid(),
    network     text not null,        -- partnerstack | exness
    pulled_at   timestamptz not null default now(),
    clicks      integer,
    leads       integer,
    conversions integer,
    earnings    numeric,
    currency    text default 'USD',
    raw         jsonb,                -- full raw API response, for debugging / re-deriving fields later
    ok          boolean not null default true,
    error       text
);

-- One row per cron execution, regardless of outcome. Mirrors the
-- LITE EXECUTIVE SUMMARY structure so it's directly renderable.
create table if not exists run_log (
    id            uuid primary key default gen_random_uuid(),
    job_id        uuid references growth_jobs(id) on delete set null,
    run_at        timestamptz not null default now(),
    action        text not null,      -- content_pass | earnings_poll | report_build
    ok            boolean not null default true,
    drafts_created integer default 0,
    summary       jsonb,              -- parsed LITE EXECUTIVE SUMMARY (opportunity/action/roi/risk/priority/next_actions)
    error         text
);

-- Precomputed "while you were away" reports. LITE fetches the latest one
-- (or builds a fresh one on demand via /report?since=) rather than
-- reassembling everything client-side.
create table if not exists reports (
    id             uuid primary key default gen_random_uuid(),
    period_start   timestamptz not null,
    period_end     timestamptz not null,
    generated_at   timestamptz not null default now(),
    drafts_created integer default 0,
    pending_review integer default 0,
    leads_delta    integer default 0,
    conversions_delta integer default 0,
    earnings_delta numeric default 0,
    currency       text default 'USD',
    summary_text   text not null,     -- ready-to-speak/display summary
    metrics        jsonb              -- full breakdown per network/platform
);

create index if not exists idx_content_queue_status on content_queue(status);
create index if not exists idx_earnings_snapshots_network_time on earnings_snapshots(network, pulled_at desc);
create index if not exists idx_run_log_time on run_log(run_at desc);
create index if not exists idx_reports_generated on reports(generated_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- RICS (Research, Intelligence & CRM/Sales) — CRM tables.
-- Added on top of GAS's existing growth-ops tables above; routed through
-- this same Worker (see the /crm/* routes in index.ts) rather than a
-- second Cloudflare Worker, since CRM storage is read/write-on-demand,
-- not autonomous/cron-driven like the growth tables above.
-- ═══════════════════════════════════════════════════════════════════════════

-- companies: organizations RICS has researched or is tracking
create table if not exists crm_companies (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    domain      text,
    industry    text,
    size        text,               -- e.g. '1-10', '11-50', '51-200'
    notes       text,
    source      text not null default 'manual'
                check (source in ('research', 'manual', 'gas')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- contacts: people, optionally tied to a company
create table if not exists crm_contacts (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid references crm_companies(id) on delete set null,
    name        text not null,
    email       text,
    role        text,
    notes       text,
    source      text not null default 'manual'
                check (source in ('research', 'manual', 'gas')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- deals: pipeline — a contact/company moving through sales stages
create table if not exists crm_deals (
    id              uuid primary key default gen_random_uuid(),
    contact_id      uuid references crm_contacts(id) on delete set null,
    company_id      uuid references crm_companies(id) on delete set null,
    title           text not null,
    stage           text not null default 'prospecting'
                    check (stage in ('prospecting', 'contacted', 'qualified',
                                      'proposal', 'won', 'lost')),
    value           numeric,
    currency        text default 'USD',
    probability     integer check (probability between 0 and 100),
    expected_close  date,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- interactions: every touchpoint — research findings, outreach, calls, replies.
-- This is the spine: "what do we know about this contact" is one query here.
create table if not exists crm_interactions (
    id          uuid primary key default gen_random_uuid(),
    contact_id  uuid references crm_contacts(id) on delete cascade,
    company_id  uuid references crm_companies(id) on delete cascade,
    deal_id     uuid references crm_deals(id) on delete set null,
    type        text not null
                check (type in ('research', 'outreach_sent', 'call',
                                  'email_reply', 'meeting', 'note')),
    summary     text not null,
    occurred_at timestamptz not null default now()
);

-- tasks: follow-ups RICS or the user needs to act on
create table if not exists crm_tasks (
    id          uuid primary key default gen_random_uuid(),
    contact_id  uuid references crm_contacts(id) on delete cascade,
    deal_id     uuid references crm_deals(id) on delete set null,
    description text not null,
    due_at      timestamptz,
    done        boolean not null default false,
    created_at  timestamptz not null default now()
);

create index if not exists idx_crm_contacts_company on crm_contacts(company_id);
create index if not exists idx_crm_deals_stage on crm_deals(stage);
create index if not exists idx_crm_interactions_contact on crm_interactions(contact_id);
create index if not exists idx_crm_interactions_company on crm_interactions(company_id);
create index if not exists idx_crm_tasks_due on crm_tasks(due_at) where done = false;
