-- 010_event_tickets.sql (ALREADY APPLIED to projectc-community on 2026-11-16; kept for the record)
create table public.event_tickets (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  checkout_session_id text not null unique,
  payment_intent_id text,
  stripe_customer_id text,
  name text, email text, organization text, title text, attending_as text,
  amount_paid integer not null default 0,
  currency text default 'usd',
  promo_code text,
  ticket_type text not null default 'paid',
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);
create index event_tickets_event_idx on public.event_tickets (event, created_at desc);
create index event_tickets_pi_idx on public.event_tickets (payment_intent_id);
alter table public.event_tickets enable row level security;
