-- ============================================================================
-- LOCKSMITH PILOT M5 (LPM5): client portal.
--
-- Three additive tables. Nothing existing is altered, renamed or dropped.
--
--   locksmith_change_requests       channel-neutral configuration change
--                                   requests (portal, voice, founder, api).
--   locksmith_notification_settings per-client destinations + preferences.
--   locksmith_call_forwarding       the client's diversion setup journey.
--
-- WHY NO NEW CALL OR ENQUIRY TABLE
-- The portal's call list and enquiry list are PROJECTIONS over the existing
-- `calls` table (services/locksmith-portal-readmodel.js). Adding a second
-- store for the same events would produce two counts of the same thing that
-- drift apart the first time a call is reclassified — and one of them would be
-- the one the invoice used. Enquiry working-state is the only genuinely new
-- fact, and it is small enough to live on the change/state tables rather than
-- justify duplicating call history.
--
-- WHY CHANGE REQUESTS ARE NOT PER-CHANNEL
-- There is ONE table for configuration changes, whatever asked for them.
-- source_channel records the origin. A separate table per channel is how a
-- voice agent quietly becomes a second configuration store with its own rules,
-- which is exactly what the architecture forbids: the UI and the future
-- configuration agent must share one validation, versioning and approval path.
--
-- Contracts encoded here:
--   * RLS enabled IN THE SAME TRANSACTION on all three (D8), no policies —
--     service_role only. These rows carry a business's operating configuration,
--     its notification destinations and its phone numbers. There is no
--     client-facing direct read path; the portal reads through the server.
--   * request_id is globally unique; (client_id, request_id) is the lookup key
--     so a request can never be read across tenants.
--   * A voice-originated request MUST carry a voice_session_id. Enforced by
--     CHECK, not by convention, because an untraceable spoken change is the
--     one thing that would make voice configuration unauditable.
--   * transcript_reference is a REFERENCE. No transcript text column exists on
--     any of these tables — raw transcripts must never be a configuration
--     source (architecture rule 5).
--   * Notification destinations are stored verified/unverified, and the
--     confirmed_own_number acknowledgement is a distinct fact from verification.
--   * One notification-settings row and one forwarding row per client.
--
-- REVIEW ONLY — NOT APPLIED. No database was connected.
--
-- APPLICATION ORDER:
--   1. lpm2_create_locksmith_onboarding.sql    (sessions + profiles)
--   2. lpm3_create_retell_provisioning.sql     (provider resources + plans)
--   3. lpm4_create_onboarding_call_runtime.sql (consents + onboarding calls)
--   4. lpm5_create_client_portal.sql           (this file)
-- This file references locksmith_profile_versions (M2), so it must follow it.
-- ============================================================================

begin;

-- ── 1. Change requests ──────────────────────────────────────────────────────
create table if not exists public.locksmith_change_requests (
  id                        bigserial primary key,
  request_id                text        not null unique,
  client_id                 text        not null,

  -- Which channel asked. The six the domain recognises; anything else is a
  -- bug, not a new feature, so it is constrained rather than free text.
  source_channel            text        not null
    check (source_channel in ('client_ui','voice_configuration_agent','initial_voice_onboarding',
                              'founder_operator','api','system_generated')),
  requested_by              text,

  -- Voice provenance. A reference to the session and, separately, to where the
  -- transcript lives. Never transcript text.
  voice_session_id          text,
  transcript_reference      text,

  status                    text        not null default 'draft'
    check (status in ('draft','submitted','needs_clarification','accepted','applied_to_draft',
                      'awaiting_client_approval','approved','rejected','cancelled','superseded')),

  -- The structured changes. Validated in the domain before they arrive here.
  changes                   jsonb       not null,
  client_note               text,
  clarification_note        text,

  -- Which confirmations this request needs (read-backs on safety-critical
  -- targets) and which have been given, with the channel that gave them.
  required_confirmations    jsonb       not null default '[]'::jsonb,
  confirmations             jsonb       not null default '{}'::jsonb,

  -- Approving a change that alters call handling invalidates the receptionist
  -- test results. Stored so the portal can say so rather than infer it.
  invalidates_tests         boolean     not null default false,

  resulting_profile_version integer,
  decided_by                text,
  decided_at                timestamptz,
  decision_reason           text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- A spoken change with no session cannot be traced back to what was said.
  -- This is the audit floor for voice configuration.
  constraint lcr_voice_requires_session check (
    source_channel not in ('voice_configuration_agent','initial_voice_onboarding')
    or voice_session_id is not null
  ),
  -- A decision must record who made it and when, together or not at all.
  constraint lcr_decision_is_complete check (
    (decided_by is null and decided_at is null)
    or (decided_by is not null and decided_at is not null)
  ),
  -- At least one change. An empty request is a bug that would otherwise sit in
  -- someone's queue looking legitimate.
  constraint lcr_has_changes check (jsonb_array_length(changes) > 0)
);

create index if not exists lcr_client_created_idx
  on public.locksmith_change_requests (client_id, created_at desc);

-- The portal's commonest query: what is still open for this client.
create index if not exists lcr_client_open_idx
  on public.locksmith_change_requests (client_id, status)
  where status not in ('approved','rejected','cancelled','superseded');

-- Tenant-scoped lookup. Pairing client_id with request_id means a handler that
-- forgets the tenant filter finds nothing rather than another client's row.
create unique index if not exists lcr_client_request_idx
  on public.locksmith_change_requests (client_id, request_id);

alter table public.locksmith_change_requests enable row level security;
-- No policies: service_role only, deliberately (D8).

-- ── 2. Notification settings ────────────────────────────────────────────────
create table if not exists public.locksmith_notification_settings (
  client_id         text        primary key,

  -- Destinations keyed by id: { "d1": { kind, label, value, verified, ... } }.
  -- Separate from preferences so changing a mobile number updates one record
  -- rather than every preference that pointed at it.
  destinations      jsonb       not null default '{}'::jsonb,

  -- Preferences keyed by notification type, each with channels + destination
  -- ids. The domain owns which types exist.
  preferences       jsonb       not null default '{}'::jsonb,

  -- { enabled, startHour, endHour }. Suppresses non-urgent SMS only.
  quiet_hours       jsonb       not null default '{"enabled":false,"startHour":21,"endHour":7}'::jsonb,

  settings_version  text        not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint lns_destinations_is_object check (jsonb_typeof(destinations) = 'object'),
  constraint lns_preferences_is_object  check (jsonb_typeof(preferences) = 'object'),
  constraint lns_quiet_hours_is_object  check (jsonb_typeof(quiet_hours) = 'object')
);

alter table public.locksmith_notification_settings enable row level security;

-- ── 3. Call forwarding ──────────────────────────────────────────────────────
create table if not exists public.locksmith_call_forwarding (
  client_id          text        primary key,

  state              text        not null default 'not_ready'
    check (state in ('not_ready','ready_to_set_up','instructions_generated','client_reports_done',
                     'verification_pending','confirmed_working','needs_help','turned_off')),

  -- What the client told us about their phone, plus the AIDA number the
  -- instructions were built against. No GSM codes are stored: they are derived
  -- from services/divert-codes.js at render time, so a template correction
  -- reaches every client instead of only the ones set up after it.
  setup              jsonb,

  -- The client's claim that they dialled the codes. Evidence, not proof.
  claim              jsonb,

  -- The outcome of the test call, and whether it was observed or self-reported.
  verification       jsonb,

  forwarding_version text        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Reaching confirmed_working requires a verification record. Without this a
  -- client could be marked live on an empty claim, and launch readiness reads
  -- this column.
  constraint lcf_confirmed_requires_verification check (
    state <> 'confirmed_working' or verification is not null
  )
);

alter table public.locksmith_call_forwarding enable row level security;

commit;

-- ============================================================================
-- VERIFICATION — run after applying. Every probe states its expectation.
-- ============================================================================

-- All three tables exist:
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('locksmith_change_requests','locksmith_notification_settings','locksmith_call_forwarding')
 order by table_name;                              -- expect 3 rows

-- RLS is ON for all three and NO policies exist (service_role only):
select relname, relrowsecurity from pg_class
 where relname in ('locksmith_change_requests','locksmith_notification_settings','locksmith_call_forwarding');
                                                   -- expect relrowsecurity = true for all 3
select schemaname, tablename, policyname from pg_policies
 where tablename in ('locksmith_change_requests','locksmith_notification_settings','locksmith_call_forwarding');
                                                   -- expect ZERO rows

-- Indexes present:
select indexname from pg_indexes
 where schemaname = 'public' and tablename = 'locksmith_change_requests' order by indexname;
                                                   -- expect lcr_client_created_idx, lcr_client_open_idx,
                                                   --        lcr_client_request_idx

-- No credential or transcript-text column anywhere. Must return ZERO rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('locksmith_change_requests','locksmith_notification_settings','locksmith_call_forwarding')
   and (column_name ilike '%api_key%' or column_name ilike '%secret%' or column_name ilike '%token%'
        or column_name ilike '%password%' or column_name = 'transcript');

-- Invariant probes — all must return ZERO rows:

-- A voice request without a session (the CHECK should make this impossible):
select request_id from public.locksmith_change_requests
 where source_channel in ('voice_configuration_agent','initial_voice_onboarding')
   and voice_session_id is null;

-- A decided request missing half its decision:
select request_id from public.locksmith_change_requests
 where (decided_by is null) <> (decided_at is null);

-- A client marked live on forwarding with no verification:
select client_id from public.locksmith_call_forwarding
 where state = 'confirmed_working' and verification is null;

-- Any request id reused across tenants (unique constraint should prevent it):
select request_id, count(*) from public.locksmith_change_requests group by 1 having count(*) > 1;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- No table references another, so drop order is free.
-- begin;
-- drop table if exists public.locksmith_change_requests;
-- drop table if exists public.locksmith_notification_settings;
-- drop table if exists public.locksmith_call_forwarding;
-- commit;

-- ── Deferred, deliberately not in this migration ────────────────────────────
-- * Enquiry working-state storage. The portal projects enquiries from `calls`;
--   persisting per-enquiry state (contacted/quoted/won/lost) needs a decision
--   about whether it belongs on `calls` itself or beside it, and that decision
--   affects the v1 pipeline's row type. Not made unilaterally here.
-- * Notification delivery log. Nothing sends yet — there is no transport in
--   M5 — and a log table with no writer is just a schema claim.
-- * Any authenticated-role RLS policy. The portal reads a narrow projection
--   through the server, never these tables directly. Adding a policy would
--   create a second, weaker access path to the same rows.
-- * Retention on change requests. They carry a business's configuration
--   history, which is the audit trail; retention needs the same legal review
--   as transcript retention (M2 spec §12).
