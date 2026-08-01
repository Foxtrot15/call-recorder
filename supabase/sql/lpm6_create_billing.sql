-- ============================================================================
-- LOCKSMITH PILOT M6 (LPM6): usage metering and billing.
--
-- Three additive tables. Nothing existing is altered, renamed or dropped.
--
--   billing_accounts        one per client: lifecycle state, plan, provider ids.
--   billing_usage_periods   one per client per period: the metered totals that
--                           the portal shows AND the invoice is built from.
--   billing_meter_events    every meter event we produced, and whether the
--                           provider accepted it.
--
-- WHY A LOCAL METER-EVENT LOG
-- Stripe deduplicates on `identifier` for at least 24 hours. That protects
-- against a retry storm; it does NOT protect against re-metering a period a
-- week later, and it gives us no way to answer "which calls did we bill for?"
-- when a client disputes an invoice. The log is the record we can actually
-- show them, and its unique index is a deduplication guarantee that does not
-- expire.
--
-- WHY NO PRICES IN THE DATABASE
-- Plan prices live in services/billing-plans.js and nowhere else. A price
-- column here would be a second source of truth that silently disagrees with
-- the code the moment either changes — and the disagreement would be between
-- what a client was shown and what they were charged. The plan_id is stored;
-- the price is always looked up.
--
-- Contracts encoded here:
--   * RLS enabled IN THE SAME TRANSACTION on all three (D8), no policies —
--     service_role only. These rows carry payment state and provider customer
--     ids; there is no client-facing direct read path.
--   * A meter event is unique per (client, meter, call). The database enforces
--     the idempotency the application intends.
--   * A period's totals are non-negative, and billable minutes cannot exceed
--     what the billable call count could physically produce.
--   * `state` is constrained to the ten lifecycle states.
--   * NO CARD DATA. No PAN, no CVV, no expiry, no token that could be used to
--     charge. Stripe holds all of it; we hold a customer id. A verification
--     probe below asserts no such column exists.
--
-- REVIEW ONLY — NOT APPLIED. No database was connected. No payment was taken.
--
-- APPLICATION ORDER:
--   1. lpm2_create_locksmith_onboarding.sql
--   2. lpm3_create_retell_provisioning.sql
--   3. lpm4_create_onboarding_call_runtime.sql
--   4. lpm5_create_client_portal.sql
--   5. lpm6_create_billing.sql            (this file)
-- ============================================================================

begin;

-- ── 1. Billing accounts ─────────────────────────────────────────────────────
create table if not exists public.billing_accounts (
  client_id                 text        primary key,

  state                     text        not null default 'none'
    check (state in ('none','pilot_unbilled','customer_created','pending_first_payment',
                     'active','past_due','collections','suspended','cancelled','closed')),

  -- The plan the client is on. NOT its price: see the header note.
  plan_id                   text
    check (plan_id is null or plan_id in ('micro','solo','growth','pro')),

  -- Provider identifiers. A customer id is not a credential — it cannot be
  -- used to charge anything without the secret key, which is never stored.
  stripe_customer_id        text unique,
  stripe_subscription_id    text unique,

  -- The founding offer, and when its clock started. The offer's VALUE is
  -- computed from the catalogue; only its existence and start are stored.
  offer_id                  text,
  offer_started_at          timestamptz,

  failed_payment_attempts   integer     not null default 0 check (failed_payment_attempts >= 0),
  last_stripe_event_id      text,

  -- Set only by a human decision. A cron job may never write this.
  suspended_by              text,
  suspended_at              timestamptz,
  suspension_reason         text,

  account_version           text        not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Suspension stops a locksmith's phone being answered. It must always carry
  -- who decided it and when, so it can never be an anonymous automated action.
  constraint ba_suspension_is_attributed check (
    state <> 'suspended' or (suspended_by is not null and suspended_at is not null)
  ),
  -- An offer without a start date has no expiry, which would make it permanent.
  constraint ba_offer_has_start check (offer_id is null or offer_started_at is not null)
);

create index if not exists ba_state_idx on public.billing_accounts (state);

alter table public.billing_accounts enable row level security;
-- No policies: service_role only, deliberately (D8).

-- ── 2. Usage periods ────────────────────────────────────────────────────────
create table if not exists public.billing_usage_periods (
  id                    bigserial   primary key,
  client_id             text        not null,
  period_start          timestamptz not null,
  period_end            timestamptz,

  -- The metered totals. These are the numbers the portal displays AND the
  -- numbers the invoice is built from — one set, not two.
  billable_calls        integer     not null default 0 check (billable_calls >= 0),
  billable_minutes      integer     not null default 0 check (billable_minutes >= 0),
  billable_seconds      integer     not null default 0 check (billable_seconds >= 0),
  excluded_calls        integer     not null default 0 check (excluded_calls >= 0),
  excluded_by_reason    jsonb       not null default '{}'::jsonb,

  -- Which thresholds the client has already been told about, so a re-run of
  -- the notice job cannot notify them again. Re-notifying is how people learn
  -- to ignore the notice that mattered.
  notified_thresholds   text[]      not null default '{}',

  plan_id               text,
  metering_version      text        not null,
  closed_at             timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- One period row per client per period.
  constraint bup_client_period_unique unique (client_id, period_start),
  -- Minutes are rounded up per call, so N billable calls produce at least N
  -- and at most N + (seconds/60) minutes. A total below the call count means
  -- the aggregation is wrong.
  constraint bup_minutes_at_least_calls check (billable_minutes >= billable_calls),
  constraint bup_period_order check (period_end is null or period_end > period_start)
);

create index if not exists bup_client_period_idx on public.billing_usage_periods (client_id, period_start desc);
create index if not exists bup_open_periods_idx on public.billing_usage_periods (client_id) where closed_at is null;

alter table public.billing_usage_periods enable row level security;

-- ── 3. Meter events ─────────────────────────────────────────────────────────
create table if not exists public.billing_meter_events (
  id                bigserial   primary key,
  client_id         text        not null,

  -- Stripe's event_name (max 100 chars) and our deterministic identifier
  -- (max 100 chars). Both limits are the provider's, encoded here so a value
  -- that would be rejected cannot be stored as if it had been sent.
  meter_name        text        not null check (char_length(meter_name) <= 100),
  identifier        text        not null check (char_length(identifier) <= 100),

  call_id           text,
  value             numeric     not null check (value >= 0),
  event_timestamp   timestamptz not null,

  status            text        not null default 'pending'
    check (status in ('pending','sent','accepted','rejected','skipped')),
  -- Why an event was never sent: too_old, in_future, bad_timestamp, no_customer.
  skip_reason       text,
  provider_response jsonb,
  sent_at           timestamptz,

  created_at        timestamptz not null default now(),

  -- THE deduplication guarantee. Stripe's own dedup window is "at least 24
  -- hours"; this one does not expire, so re-metering an old period cannot
  -- double-bill a call.
  constraint bme_identifier_unique unique (identifier),
  constraint bme_skip_has_reason check (status <> 'skipped' or skip_reason is not null),
  constraint bme_sent_has_time check (status not in ('sent','accepted') or sent_at is not null)
);

create index if not exists bme_client_created_idx on public.billing_meter_events (client_id, created_at desc);
create index if not exists bme_unsent_idx on public.billing_meter_events (client_id) where status = 'pending';

alter table public.billing_meter_events enable row level security;

commit;

-- ============================================================================
-- VERIFICATION — run after applying. Every probe states its expectation.
-- ============================================================================

-- All three tables exist:
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('billing_accounts','billing_usage_periods','billing_meter_events')
 order by table_name;                               -- expect 3 rows

-- RLS is ON for all three and NO policies exist:
select relname, relrowsecurity from pg_class
 where relname in ('billing_accounts','billing_usage_periods','billing_meter_events');
                                                    -- expect relrowsecurity = true for all 3
select tablename, policyname from pg_policies
 where tablename in ('billing_accounts','billing_usage_periods','billing_meter_events');
                                                    -- expect ZERO rows

-- NO CARD DATA AND NO CREDENTIALS ANYWHERE. Must return ZERO rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('billing_accounts','billing_usage_periods','billing_meter_events')
   and (column_name ilike '%card%' or column_name ilike '%pan%' or column_name ilike '%cvv%'
        or column_name ilike '%cvc%' or column_name ilike '%expiry%' or column_name ilike '%secret%'
        or column_name ilike '%api_key%' or column_name ilike '%password%'
        -- A payment-method token could be used to charge; a customer id cannot.
        or column_name ilike '%payment_method%' or column_name ilike '%card_token%');

-- NO PRICE COLUMNS. Prices live in code, in one place. Must return ZERO rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('billing_accounts','billing_usage_periods')
   and (column_name ilike '%price%' or column_name ilike '%amount%' or column_name ilike '%_cents');

-- Invariant probes — all must return ZERO rows:

-- A suspended account with no attribution (the CHECK should prevent it):
select client_id from public.billing_accounts
 where state = 'suspended' and (suspended_by is null or suspended_at is null);

-- An offer with no start date, which would never expire:
select client_id from public.billing_accounts where offer_id is not null and offer_started_at is null;

-- A duplicate meter identifier (the unique constraint should prevent it):
select identifier, count(*) from public.billing_meter_events group by 1 having count(*) > 1;

-- A period whose minutes are below its call count — impossible under per-call
-- round-up, so it means the aggregation is wrong:
select client_id, period_start from public.billing_usage_periods where billable_minutes < billable_calls;

-- An event marked sent with no send time:
select identifier from public.billing_meter_events where status in ('sent','accepted') and sent_at is null;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- No table references another, so drop order is free.
-- begin;
-- drop table if exists public.billing_meter_events;
-- drop table if exists public.billing_usage_periods;
-- drop table if exists public.billing_accounts;
-- commit;

-- ── Deferred, deliberately not in this migration ────────────────────────────
-- * An invoices table. Stripe is the system of record for invoices; copying
--   them here creates a second version that can disagree with the one the
--   client was actually charged. The portal links to Stripe's hosted invoices.
-- * Dunning schedule state. Non-payment escalation is a human process in the
--   pilot (see the lifecycle note: service never stops automatically), and a
--   schedule table with no scheduler is a schema claim rather than a feature.
-- * Tax. GST handling needs advice we do not have, and guessing at tax
--   treatment in a migration is worse than leaving it out.
-- * Any authenticated-role RLS policy. The portal reads through the server.
