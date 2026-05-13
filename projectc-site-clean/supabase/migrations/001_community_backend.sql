-- ============================================================================
-- Project C Community Backend — initial schema
-- ============================================================================
-- Creates the three core tables (cohorts, applications, memberships) that
-- power the new /community application + membership flow. Safe to re-run in
-- staging; uses "create table if not exists" and idempotent policy creates.
--
-- Order matters:
--   1. cohorts          (referenced by applications and memberships)
--   2. applications     (referenced by memberships)
--   3. memberships
--   4. updated_at trigger
--   5. row-level security policies
--
-- All timestamps are timestamptz to avoid timezone ambiguity.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. COHORTS
-- ----------------------------------------------------------------------------
create table if not exists cohorts (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  name              text not null,                    -- 'ONA 2026 Fellows'
  partner           text,                              -- 'Online News Association'
  invite_code       text not null unique,              -- 'ONA26-FELLOWS'

  seat_limit        int,                               -- null = unlimited
  seats_used        int not null default 0,

  code_expires_at   timestamptz not null,              -- last day code works
  cohort_ends_at    timestamptz not null,              -- last day membership active

  auto_approve      boolean not null default true,
  active            boolean not null default true,

  notes             text                               -- internal only
);

create index if not exists cohorts_invite_code_idx
  on cohorts(invite_code);

create index if not exists cohorts_active_idx
  on cohorts(active) where active = true;

comment on table cohorts is
  'Partner program cohorts (Muslim Accelerator, ONA26, etc.). Each row is one invite code that grants free membership.';
comment on column cohorts.code_expires_at is
  'Last day the invite code can be redeemed. Distinct from cohort_ends_at.';
comment on column cohorts.cohort_ends_at is
  'Last day the free membership period runs. Copied into memberships.membership_ends_at on approval.';


-- ----------------------------------------------------------------------------
-- 2. APPLICATIONS
-- ----------------------------------------------------------------------------
create table if not exists applications (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Applicant details (captured from the form)
  name                      text not null,
  email                     text not null,
  work_url                  text,
  about                     text,
  tier                      text not null check (tier in (
                              'solo_monthly',
                              'solo_yearly',
                              'org_monthly',
                              'org_yearly',
                              'cohort'
                            )),

  -- Cohort linkage (only populated if they entered a code)
  cohort_code               text,
  cohort_id                 uuid references cohorts(id),

  -- Stripe vault (null for cohort members)
  stripe_customer_id        text,
  stripe_payment_method_id  text,
  stripe_setup_intent_id    text,

  -- Review workflow
  status                    text not null default 'pending_review' check (status in (
                              'pending_review',
                              'approved',
                              'rejected',
                              'withdrawn'
                            )),
  reviewed_by               text,                      -- reviewer email
  reviewed_at               timestamptz,
  review_notes              text,                      -- internal only
  rejection_reason          text check (rejection_reason in (
                              'wrong_profile',
                              'not_yet',
                              'other'
                            )),

  -- FrieNDA / community agreement consent
  agreement_accepted_at     timestamptz not null,

  -- Metadata
  source                    text,                      -- 'community_page', etc.
  user_agent                text
);

create index if not exists applications_status_idx
  on applications(status);

create index if not exists applications_email_idx
  on applications(email);

create index if not exists applications_cohort_code_idx
  on applications(cohort_code);

create index if not exists applications_created_at_idx
  on applications(created_at desc);

-- Supports the re-application flagging logic: the Slack alert function
-- queries prior applications by email to surface history ("applied before
-- on X, rejected"). The email index above already covers this.

comment on table applications is
  'Every form submission lands here. Source of truth for the review workflow. Rows are never deleted.';
comment on column applications.email is
  'Not unique — re-applications are allowed. Slack alert function queries prior applications by email to surface history.';
comment on column applications.stripe_setup_intent_id is
  'Stripe SetupIntent used to vault the card at application time without charging. Kept even after the subscription is created, for debugging.';


-- ----------------------------------------------------------------------------
-- 3. MEMBERSHIPS
-- ----------------------------------------------------------------------------
create table if not exists memberships (
  id                         uuid primary key default gen_random_uuid(),
  application_id             uuid not null references applications(id),
  created_at                 timestamptz not null default now(),

  -- Denormalized from application for query speed
  name                       text not null,
  email                      text not null,
  tier                       text not null,
  cohort_id                  uuid references cohorts(id),

  -- Status: paid members stay 'active' until their Stripe period ends,
  -- then a webhook flips them to 'expired'. Cancellation sets canceled_at
  -- but leaves status unchanged until the period runs out.
  status                     text not null default 'active' check (status in (
                               'active',
                               'paused',
                               'canceled',
                               'expired'
                             )),

  -- Stripe linkage (null for cohort members)
  stripe_customer_id         text,
  stripe_subscription_id     text,

  -- Slack linkage
  slack_user_id              text,
  slack_invite_sent_at       timestamptz,
  slack_joined_at            timestamptz,

  -- Email lifecycle tracking (idempotency — has this email already gone?)
  welcome_email_sent_at      timestamptz,
  day3_email_sent_at         timestamptz,
  cohort_reminder_2w_sent_at timestamptz,
  cohort_reminder_3d_sent_at timestamptz,

  -- Lifecycle dates
  membership_starts_at       timestamptz not null default now(),
  membership_ends_at         timestamptz,              -- null = ongoing paid
  canceled_at                timestamptz,
  cancellation_reason        text
);

create index if not exists memberships_email_idx
  on memberships(email);

create index if not exists memberships_status_idx
  on memberships(status);

create index if not exists memberships_cohort_id_idx
  on memberships(cohort_id);

-- Partial index: scheduled functions querying "which memberships expire
-- soon?" only walk rows that have an end date set.
create index if not exists memberships_ends_at_idx
  on memberships(membership_ends_at)
  where membership_ends_at is not null;

comment on table memberships is
  'Active record of a person''s relationship with Project C. Created on application approval.';
comment on column memberships.membership_ends_at is
  'Null for open-ended paid members. Set to the cohort end date for cohort members, or to the Stripe period end for canceled paid members.';
comment on column memberships.canceled_at is
  'When the member canceled in Stripe. Status stays ''active'' until membership_ends_at is reached, per Liz''s call: paid members keep Slack access through their paid period.';


-- ----------------------------------------------------------------------------
-- 4. updated_at TRIGGER for applications
-- ----------------------------------------------------------------------------
-- Keeps applications.updated_at fresh on every row update. The other tables
-- don't need this — memberships is append-mostly and cohorts is rarely
-- touched.

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists applications_touch_updated_at on applications;
create trigger applications_touch_updated_at
  before update on applications
  for each row execute function touch_updated_at();


-- ----------------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Public (anon role): can INSERT applications with a required agreement
-- timestamp, nothing else. Cannot read applications, memberships, or cohorts.
-- Service role (used by Netlify functions): full access, as usual.
--
-- NOTE: the service role key bypasses RLS entirely in Supabase, so the
-- policies below only constrain the anon role. We enable RLS on all three
-- tables and then add one INSERT policy for anon on applications.

alter table cohorts       enable row level security;
alter table applications  enable row level security;
alter table memberships   enable row level security;

-- Drop old policy if it exists (makes this script re-runnable)
drop policy if exists "anon can insert applications" on applications;

create policy "anon can insert applications"
  on applications
  for insert
  to anon
  with check (
    -- Applicant must have accepted the agreement to submit.
    agreement_accepted_at is not null
    -- Cannot pre-set their own status to approved, etc.
    and status = 'pending_review'
    -- Cannot pre-set reviewer fields.
    and reviewed_by is null
    and reviewed_at is null
    and review_notes is null
  );

-- No policies for cohorts or memberships means anon cannot touch them.
-- Service role still can, because the service key bypasses RLS.


-- ----------------------------------------------------------------------------
-- DONE
-- ----------------------------------------------------------------------------
-- Next: run this file in the Supabase SQL editor (or via the CLI) against
-- the Project C project, then proceed to Step 3 (Netlify submission
-- function + Stripe SetupIntent).
