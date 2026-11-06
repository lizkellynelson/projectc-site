-- 009_event_signups.sql  (ALREADY APPLIED to projectc-community on 2026-11-06; kept here for the record)
-- Email "keep me posted" lists for event pages (first: Covering Washington, March 30, 2027).
-- One row per person per event. Service-key access only, through netlify/functions/event-signup.js.
create table public.event_signups (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  email text not null,
  source text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  constraint event_signups_email_lower check (email = lower(email)),
  unique (event, email)
);
create index event_signups_event_idx on public.event_signups (event, created_at desc);
alter table public.event_signups enable row level security;
