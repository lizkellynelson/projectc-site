-- 011 (ALREADY APPLIED 2026-11-16)
alter table public.event_signups
  add column newsletter_opt_in boolean not null default false,
  add column newsletter_status text;
