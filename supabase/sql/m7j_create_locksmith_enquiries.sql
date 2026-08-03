-- ============================================================================
-- M7J: caller enquiry capture — the table `create_locksmith_enquiry` writes to.
--
-- REVIEW ONLY — NOT APPLIED. Nothing here has been executed and no database was
-- connected by the assistant.
--
-- ─── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
-- A CALLER's job enquiry: someone locked out of a house rings the locksmith's
-- number and the receptionist records what they need.
--
-- It is NOT the landing-page pilot form in services/locksmith-enquiry.js. That
-- one is a LOCKSMITH BUSINESS asking to join the pilot (businessName,
-- missedCallHandling, consent…). The two share a word and nothing else — no
-- table, no validator, no route. Conflating them would put marketing leads and
-- 3am lockouts in one table with one retention policy.
--
-- ─── SANDBOX AND PRODUCTION ARE SEPARATED BY A COLUMN, NOT A CONVENTION ────
-- `environment` carries the deployment tag that wrote the row. A sandbox agent
-- can only ever write 'dev'. Every read path filters on it, so a fictional
-- founder-test enquiry can never be counted, billed, notified or exported as a
-- real one — and the check constraint means a bug cannot invent a third value.
--
-- ─── IDEMPOTENCY IS A DATABASE FACT ────────────────────────────────────────
-- Retell does NOT retry custom functions (verified against
-- docs.retellai.com/build/single-multi-prompt/custom-function, reviewed
-- 2026-08-03) — but the MODEL can call the same tool twice in one call, and a
-- caller who repeats themselves is the normal case, not the edge case.
--
-- `idempotency_key` is derived server-side from the provider call id plus a
-- hash of the submitted arguments, so:
--   * the same enquiry submitted twice on one call collapses to one row
--   * a genuinely DIFFERENT second enquiry on the same call still saves
-- The partial unique index is the enforcement; the app's ON CONFLICT is the
-- fast path. Two mechanisms because a duplicate 3am job is a duplicate call-out.
--
-- ─── NO PII BEYOND WHAT THE JOB NEEDS ──────────────────────────────────────
-- There is no column for a payment detail, a date of birth or an identity
-- document, and there never will be. The callback number is stored canonical
-- (E.164) because AIDA has to be able to ring it; everything else is prose the
-- caller volunteered.
--
-- APPLICATION ORDER: after lpm2 and lpm3 (this references neither with a
-- foreign key, but client_id is only meaningful once those exist).
-- ============================================================================

create table if not exists public.locksmith_enquiries (
  id                     uuid        primary key default gen_random_uuid(),

  -- Tenant. clients.slug, the canonical key used everywhere else.
  client_id              text        not null check (length(client_id) between 1 and 100),

  -- Which deployment wrote this. The sandbox/production boundary.
  environment            text        not null default 'dev'
    check (environment in ('dev','staging','prod')),

  -- ── Provenance: which call, which agent, which compiled profile ──────────
  source                 text        not null default 'voice_agent'
    check (source in ('voice_agent','portal','manual','import')),
  provider               text        not null default 'retell'
    check (provider in ('retell','mock','dry_run')),
  provider_call_id       text        check (provider_call_id is null or length(provider_call_id) <= 200),
  provider_agent_id      text        check (provider_agent_id is null or length(provider_agent_id) <= 200),
  profile_version        integer     check (profile_version is null or profile_version >= 1),

  -- ── The caller and the job ───────────────────────────────────────────────
  -- Only caller_name, callback_number, suburb and problem_description are
  -- required, matching the tool schema the compiler already emits. Everything
  -- else is what a good receptionist gets when the caller is willing to give it.
  caller_name            text        not null check (length(caller_name) between 1 and 200),
  -- Canonical E.164. AIDA has to be able to ring it, so it is normalised before
  -- it gets here and a non-Australian shape is refused at the app boundary.
  callback_number        text        not null check (callback_number ~ '^\+[1-9][0-9]{7,14}$'),
  suburb                 text        not null check (length(suburb) between 1 and 200),
  street_address         text        check (street_address is null or length(street_address) <= 300),
  property_type          text        check (property_type is null or property_type in ('residential','commercial','automotive')),
  service_id             text        check (service_id is null or length(service_id) <= 60),
  problem_description    text        not null check (length(problem_description) between 1 and 2000),
  property_secure        boolean,
  desired_timing         text        check (desired_timing is null or length(desired_timing) <= 200),
  urgency                text        check (urgency is null or urgency in ('urgent','priority','standard','non_urgent')),

  -- ── Idempotency ──────────────────────────────────────────────────────────
  idempotency_key        text        not null check (length(idempotency_key) between 8 and 200),

  -- ── What happens next. NOTHING YET, deliberately (M7J scope). ────────────
  -- Recorded so the notification milestone has somewhere to write rather than
  -- needing a migration to begin. `pending` means nobody has been told.
  notification_state     text        not null default 'pending'
    check (notification_state in ('pending','not_required','sent','failed')),
  notified_at            timestamptz,
  transfer_attempted     boolean     not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- A notified row must say when; an un-notified one must not claim a time.
  constraint le_notified_consistency check (
    (notification_state = 'sent' and notified_at is not null)
    or (notification_state <> 'sent' and notified_at is null)
  )
);

-- THE duplicate guard. Unique per tenant + environment, so a sandbox key can
-- never collide with a production one.
create unique index if not exists le_idempotency
  on public.locksmith_enquiries (client_id, environment, idempotency_key);

-- Read paths: newest-first per client, always scoped by environment.
create index if not exists le_client_recent_idx
  on public.locksmith_enquiries (client_id, environment, created_at desc);

-- Answering "what came in on that call" without a table scan.
create index if not exists le_call_idx
  on public.locksmith_enquiries (provider_call_id)
  where provider_call_id is not null;

-- ── RLS at birth, in the same transaction (D8) ──────────────────────────────
-- Enabled with NO policies: service_role only, matching the deny-by-default
-- posture of every other table here. These rows are members of the public
-- describing where they live and that they cannot get in — there is no browser
-- read path, and there will not be one without a policy written on purpose.
alter table public.locksmith_enquiries enable row level security;

comment on table public.locksmith_enquiries is
  'RLS enabled, no policies: service_role only. CALLER job enquiries captured by the receptionist agent — NOT the landing-page pilot form. environment separates sandbox from production. See docs/RETELL_INTEGRATION_SPEC.md.';
comment on column public.locksmith_enquiries.idempotency_key is
  'Derived server-side from provider_call_id + a hash of the submitted arguments. The same enquiry twice on one call collapses; a different second enquiry still saves.';
comment on column public.locksmith_enquiries.environment is
  'The deployment tag that wrote the row. A founder-test enquiry is dev and must never be counted, billed, notified or exported as production.';
comment on column public.locksmith_enquiries.notification_state is
  'M7J captures only. pending means nobody has been told — notifications are a separate milestone.';

-- ============================================================================
-- VERIFICATION — run after applying.
-- ============================================================================
--
-- -- 1. The table exists with RLS on and no policies.
-- select relname, relrowsecurity from pg_class where relname = 'locksmith_enquiries';
-- select count(*) as policy_count from pg_policies
--  where schemaname = 'public' and tablename = 'locksmith_enquiries';   -- expect 0
--
-- -- 2. The duplicate guard is present.
-- select indexname from pg_indexes
--  where schemaname = 'public' and tablename = 'locksmith_enquiries'
--  order by indexname;   -- expect le_call_idx, le_client_recent_idx, le_idempotency
--
-- -- 3. Idempotency actually holds (safe to run; rolls itself back).
-- begin;
--   insert into public.locksmith_enquiries
--     (client_id, environment, caller_name, callback_number, suburb, problem_description, idempotency_key)
--   values ('sandbox-fixture-locksmith','dev','Test','+61491570006','Springvale','locked out','probe-key-0001');
--   -- This MUST fail with a unique violation:
--   insert into public.locksmith_enquiries
--     (client_id, environment, caller_name, callback_number, suburb, problem_description, idempotency_key)
--   values ('sandbox-fixture-locksmith','dev','Test','+61491570006','Springvale','locked out','probe-key-0001');
-- rollback;
--
-- -- 4. A non-E.164 callback number is refused (must raise):
-- -- insert into public.locksmith_enquiries
-- --   (client_id, caller_name, callback_number, suburb, problem_description, idempotency_key)
-- -- values ('x','Test','0491570006','Springvale','locked out','probe-key-0002');
--
-- ============================================================================
-- ROLLBACK — the table is additive and referenced by nothing.
-- ============================================================================
-- drop table if exists public.locksmith_enquiries;
