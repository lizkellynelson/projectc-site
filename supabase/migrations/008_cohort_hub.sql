-- 008_cohort_hub.sql  (ALREADY APPLIED to projectc-community on 2026-10-14; kept here for the record)
-- Cohort hub tables for partner-run cohorts (first: TikTok x Project C, fall 2026).
-- Separate from memberships: cohort participants are not Project C members.
-- Service-key access only through netlify/functions/cohort-hub*.js. RLS on, no public policies.
-- The TikTok program row, its five weeks, checklists and the staff/partner logins were
-- seeded by hand the same day (see hub_programs slug 'tiktok-q4-2026').

create table public.hub_programs (
  id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null, partner text,
  starts_on date not null, ends_on date not null, access_ends_at timestamptz not null,
  timezone text not null default 'America/New_York', zoom_meeting_id text,
  settings jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());

create table public.hub_people (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.hub_programs(id) on delete cascade,
  email text not null, name text not null, tiktok_handle text,
  role text not null default 'creator' check (role in ('creator','staff','partner')),
  status text not null default 'active' check (status in ('active','removed')),
  zoom_registrant_id text, zoom_join_url text, consent_at timestamptz, welcome_sent_at timestamptz,
  last_login_at timestamptz, notes text, added_at timestamptz not null default now(),
  constraint hub_people_email_lower check (email = lower(email)), unique (program_id, email));

create table public.hub_weeks (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.hub_programs(id) on delete cascade,
  week_number int not null, session_at timestamptz not null, title text not null, presenters text, guests text,
  summary text, assignment text, due_at timestamptz, replay_url text, slides_url text,
  resources jsonb not null default '[]'::jsonb, attendance_pulled_at timestamptz,
  unique (program_id, week_number));

create table public.hub_checklist_items (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references public.hub_weeks(id) on delete cascade,
  position int not null default 0, label text not null, link_url text,
  kind text not null default 'task' check (kind in ('task','submit')));

create table public.hub_checklist_done (
  person_id uuid not null references public.hub_people(id) on delete cascade,
  item_id uuid not null references public.hub_checklist_items(id) on delete cascade,
  done_at timestamptz not null default now(), primary key (person_id, item_id));

create table public.hub_submissions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.hub_people(id) on delete cascade,
  week_id uuid not null references public.hub_weeks(id) on delete cascade,
  video_url text not null, note text, submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), critique_pick boolean not null default false,
  featured boolean not null default false, reviewer_note text, unique (person_id, week_id));

create table public.hub_attendance (
  person_id uuid not null references public.hub_people(id) on delete cascade,
  week_id uuid not null references public.hub_weeks(id) on delete cascade,
  minutes int not null default 0, first_join_at timestamptz, source text not null default 'zoom',
  primary key (person_id, week_id));

create table public.hub_login_codes (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.hub_programs(id) on delete cascade,
  email text not null, code_hash text not null, attempts int not null default 0,
  expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now());

create table public.hub_reminders_sent (
  person_id uuid not null references public.hub_people(id) on delete cascade,
  week_id uuid not null references public.hub_weeks(id) on delete cascade,
  kind text not null, sent_at timestamptz not null default now(), primary key (person_id, week_id, kind));

alter table public.hub_programs enable row level security;
alter table public.hub_people enable row level security;
alter table public.hub_weeks enable row level security;
alter table public.hub_checklist_items enable row level security;
alter table public.hub_checklist_done enable row level security;
alter table public.hub_submissions enable row level security;
alter table public.hub_attendance enable row level security;
alter table public.hub_login_codes enable row level security;
alter table public.hub_reminders_sent enable row level security;

-- Added 2026-10-15 (also already applied): private staff votes and notes on homework.
create table public.hub_reviews (
  submission_id uuid not null references public.hub_submissions(id) on delete cascade,
  reviewer_id uuid not null references public.hub_people(id) on delete cascade,
  vote boolean not null default false, note text, updated_at timestamptz not null default now(),
  primary key (submission_id, reviewer_id));
alter table public.hub_reviews enable row level security;

-- Added 2026-10-24 (also already applied), after TikTok's feedback:
-- link-type homework (week 1 asks for two creator profiles), and roster fields from the shared participant sheet.
alter table public.hub_weeks add column kind text not null default 'video';        -- 'video' or 'links'
alter table public.hub_submissions add column links jsonb not null default '[]'::jsonb;
alter table public.hub_people add column date_added date;
alter table public.hub_people add column role_label text;
alter table public.hub_people add column employer text;
