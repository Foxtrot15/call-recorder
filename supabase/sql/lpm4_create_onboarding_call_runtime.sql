-- ============================================================================
-- LOCKSMITH PILOT M4 (LPM4): onboarding call runtime.
--
-- Two additive tables. Nothing existing is altered, renamed or dropped.
--
--   onboarding_call_consents  explicit, versioned, number-bound permission to
--                             make ONE onboarding call.
--   onboarding_calls          the normalised call lifecycle and its binding to
--                             exactly one provider call id.
--
-- WHY NOT REUSE `calls`
-- The existing `calls` table is the v1 missed-call pipeline's record: a customer
-- rang a locksmith, was recorded, transcribed and analysed. An onboarding call
-- is the opposite direction and a different subject — AIDA rings the BUSINESS
-- OWNER to collect configuration. Reusing that table would put owner-consent
-- and provider-provisioning columns onto the row type that the prime-directive
-- pipeline reads, and would make "a call" mean two things. These are separate,
-- additive tables; the v1 pipeline is untouched.
--
-- Contracts encoded here:
--   * RLS enabled IN THE SAME TRANSACTION on both (D8), no policies —
--     service_role only. Consent records carry a phone number, an IP and a
--     user agent; there is no client-facing read path.
--   * A provider call id binds to EXACTLY ONE onboarding call (unique).
--   * request_key is unique per client: the same client+session+consent cannot
--     produce two calls, so a double-submitted form is idempotent.
--   * Consent validity is constrained where a database can check it: an
--     affirmative call+transcription consent, a normalised E.164 destination,
--     and an expiry that is after creation.
--   * Recording consent is separate from transcription consent and defaults
--     false.
--
-- REVIEW ONLY — NOT APPLIED. No database was connected.
--
-- APPLICATION ORDER:
--   1. lpm2_create_locksmith_onboarding.sql   (sessions + profiles)
--   2. lpm3_create_retell_provisioning.sql    (provider resources + plans)
--   3. lpm4_create_onboarding_call_runtime.sql (this file)
-- This file references locksmith_onboarding_sessions (M2) and
-- provisioning_plans (M3), so both must precede it.
-- ============================================================================

begin;

-- ── 1. Onboarding-call consent ──────────────────────────────────────────────
create table if not exists public.onboarding_call_consents (
  consent_id                uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,
  session_id                uuid        not null references public.locksmith_onboarding_sessions(session_id) on delete cascade,
  user_id                   text        not null check (length(user_id) between 1 and 200),

  -- Both kept: the raw value so the client sees exactly what they typed, the
  -- normalised value so what we dial is unambiguous.
  destination_number_raw    text        not null check (length(destination_number_raw) <= 40),
  destination_number        text        not null check (destination_number ~ '^\+61[0-9]{9,10}$'),
  destination_fingerprint   text        not null check (length(destination_fingerprint) = 64),

  -- Required, and constrained to true: a row that does not carry affirmative
  -- consent has no business existing.
  call_consent              boolean     not null check (call_consent = true),
  transcription_consent     boolean     not null check (transcription_consent = true),
  -- Optional and SEPARATE. Defaults false and stays false until the founder's
  -- legal wording is confirmed.
  recording_consent         boolean     not null default false,

  disclosure_version        text        not null check (length(disclosure_version) between 1 and 100),

  -- Recorded only because the client asked us to ring them and a dispute would
  -- turn on who asked. Bounded, never rendered back to anyone.
  request_ip                text        check (request_ip is null or length(request_ip) <= 64),
  request_user_agent        text        check (request_user_agent is null or length(request_user_agent) <= 300),

  revoked_at                timestamptz,
  revocation_reason         text        check (revocation_reason is null or length(revocation_reason) <= 500),
  attempt_count             integer     not null default 0 check (attempt_count >= 0 and attempt_count <= 10),

  expires_at                timestamptz not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint occ_expiry_after_creation check (expires_at > created_at)
);

create index if not exists occ_session_idx on public.onboarding_call_consents (client_id, session_id, created_at desc);
-- At most one live (unrevoked, unexpired) consent per session is enforced in
-- the app; the index makes the lookup cheap.
create index if not exists occ_live_idx on public.onboarding_call_consents (client_id, session_id) where revoked_at is null;

alter table public.onboarding_call_consents enable row level security;

comment on table public.onboarding_call_consents is
  'RLS enabled, no policies: service_role only. Explicit, versioned, number-bound permission to make ONE onboarding call. NOT cold-marketing consent and must never be used as such. A different destination number requires a new record.';
comment on column public.onboarding_call_consents.recording_consent is
  'Separate from transcription. Defaults false. Recording stays off until the founder legal wording is confirmed — see docs/LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md.';
comment on column public.onboarding_call_consents.disclosure_version is
  'The wording the client actually saw. Disclosure text is versioned and never edited in place, so an old consent stays readable as what was agreed.';

-- ── 2. Onboarding calls ─────────────────────────────────────────────────────
create table if not exists public.onboarding_calls (
  call_id                   uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,
  session_id                uuid        not null references public.locksmith_onboarding_sessions(session_id) on delete cascade,
  consent_id                uuid        not null references public.onboarding_call_consents(consent_id) on delete restrict,
  requested_by              text        check (requested_by is null or length(requested_by) <= 200),

  -- Deterministic hash of (client, session, consent). Unique per client, so a
  -- double-submitted request returns the first call instead of dialling twice.
  request_key               text        not null check (length(request_key) = 64),

  status                    text        not null default 'requested'
    check (status in ('requested','created','dialling','connected','ended','transcript_received','analysis_received','failed','cancelled')),
  -- Which execution mode produced this call. The audit trail must never be
  -- ambiguous about whether a real provider was involved.
  mode                      text        not null check (mode in ('disabled','mock','dry_run','live')),
  provider                  text        not null default 'retell',
  provider_call_id          text        check (provider_call_id is null or length(provider_call_id) <= 200),

  destination_number        text        not null check (destination_number ~ '^\+61[0-9]{9,10}$'),

  started_at                timestamptz,
  ended_at                  timestamptz,
  duration_ms               integer     check (duration_ms is null or duration_ms >= 0),
  end_reason                text        check (end_reason is null or length(end_reason) <= 50),
  provider_end_label        text        check (provider_end_label is null or length(provider_end_label) <= 100),
  failure_code              text        check (failure_code is null or length(failure_code) <= 100),

  transcript_received_at    timestamptz,
  analysis_received_at      timestamptz,
  provider_cost             numeric(10,4) check (provider_cost is null or provider_cost >= 0),
  -- A REFERENCE to provider-hosted media. Never downloaded, never proxied.
  recording_reference       text        check (recording_reference is null or length(recording_reference) <= 500),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint oc_request_key unique (client_id, request_key),
  -- A provider call id belongs to exactly one onboarding call, so a webhook can
  -- never be applied to the wrong session.
  constraint oc_provider_call_key unique (provider_call_id),
  constraint oc_ended_has_time check (status <> 'ended' or ended_at is not null),
  constraint oc_duration_needs_start check (duration_ms is null or started_at is not null)
);

create index if not exists oc_session_idx on public.onboarding_calls (client_id, session_id, created_at desc);
-- At most one ACTIVE call per session: the guard against two simultaneous
-- dials to the same owner.
create unique index if not exists oc_one_active_per_session
  on public.onboarding_calls (client_id, session_id)
  where status in ('requested','created','dialling','connected');

alter table public.onboarding_calls enable row level security;

comment on table public.onboarding_calls is
  'RLS enabled, no policies: service_role only. Normalised onboarding-call lifecycle. SEPARATE from the v1 `calls` table on purpose: that records a customer ringing a locksmith; this records AIDA ringing the business owner to collect configuration. The v1 pipeline is untouched.';
comment on index public.oc_one_active_per_session is
  'At most one active onboarding call per session — the guard against dialling an owner twice.';
comment on column public.onboarding_calls.recording_reference is
  'A provider-hosted URL, stored as an opaque reference. AIDA never downloads or proxies call audio.';
comment on column public.onboarding_calls.mode is
  'disabled | mock | dry_run | live. A row can always be read to tell whether an external provider was actually involved.';

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename in ('onboarding_call_consents','onboarding_calls')
 order by tablename;                              -- expect 2 rows, rowsecurity = t

select count(*) as policy_count from pg_policies
 where schemaname = 'public' and tablename in ('onboarding_call_consents','onboarding_calls');
                                                  -- expect 0

select conname, contype from pg_constraint
 where conrelid = 'public.onboarding_calls'::regclass order by conname;
                                                  -- expect oc_request_key (u), oc_provider_call_key (u),
                                                  -- oc_ended_has_time, oc_duration_needs_start, status/mode checks

select indexname from pg_indexes
 where schemaname = 'public' and tablename = 'onboarding_calls' order by indexname;
                                                  -- expect oc_one_active_per_session

-- No credential column anywhere. Must return zero rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('onboarding_call_consents','onboarding_calls')
   and (column_name ilike '%api_key%' or column_name ilike '%secret%' or column_name ilike '%token%' or column_name ilike '%password%');

-- Invariant probes — all must return zero rows:
select client_id, session_id, count(*) from public.onboarding_calls
 where status in ('requested','created','dialling','connected') group by 1,2 having count(*) > 1;
select provider_call_id, count(*) from public.onboarding_calls
 where provider_call_id is not null group by 1 having count(*) > 1;
-- No consent row may exist without affirmative call + transcription consent:
select count(*) from public.onboarding_call_consents where call_consent is not true or transcription_consent is not true;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Drop order matters: calls reference consents.
-- begin;
-- drop table if exists public.onboarding_calls;
-- drop table if exists public.onboarding_call_consents;
-- commit;

-- ── Deferred, deliberately not in this migration ────────────────────────────
-- * Consent/call retention. Consents carry a phone number, an IP and a user
--   agent; a retention job needs the same legal review as transcript retention
--   (M2 spec §12) before it is written.
-- * Any authenticated-role RLS policy. The client portal reads a narrow
--   projection through the server, never these tables directly.
