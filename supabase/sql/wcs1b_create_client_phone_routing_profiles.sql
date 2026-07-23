-- ============================================================================
-- WEB-CALL-SETUP-1 (WCS-1b): create `client_phone_routing_profiles`.
--
-- One row per tenant recording their conditional call-diversion setup
-- (missed / busy / unreachable) and how far they got. The webapp contract
-- lives in docs/WEB_CALL_SETUP_SPEC.md; the divert-code templates in
-- src/services/divert-codes.js; the adapter in src/services/routing-profile.js.
--
-- Non-negotiables encoded here:
--   * RLS enabled IN THE SAME TRANSACTION (D8 — no table is born unprotected;
--     precedent: create_personal_contacts.sql, phase1b_create_devices.sql).
--   * unique (client_id) — one profile per tenant; the adapter upserts on it.
--   * carrier / phone_platform are plain text, NOT DB enums or checks — the
--     option registries live in src/services/divert-codes.js so adding a
--     carrier never needs a migration. setup_status IS constrained: the
--     status machine is stable and a stray value would break the UI.
--   * business_number is the number the CLIENT confirmed for diversion. It is
--     stored here only — it must NEVER be copied into clients.real_number
--     (owner recognition and the INV-1 loop guard read that column).
--   * target_number + generated_codes are a SNAPSHOT taken at generate time
--     (generated_codes holds the exact buildDivertCodes result, including
--     templateVersion) so what a user was shown survives template edits.
--   * claimed_done_at / test_passed_at record SELF-REPORTED claims from the
--     client, not platform-verified facts (spec §1).
--
-- REVIEW ONLY — apply in the Supabase SQL Editor at WCS-1b-ii entry, before
-- CALL_SETUP_ENABLED is ever set. Until applied, the adapter fails with a
-- clear "not provisioned" error (and is unreachable anyway: no route imports
-- it in WCS-1b-i, and the future routes sit behind the flag, default off).
-- ============================================================================

begin;

create table if not exists public.client_phone_routing_profiles (
  id                        uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,          -- clients.slug (tenant)
  business_number           text,                          -- client-confirmed E.164; never copied to clients.real_number
  phone_platform            text,                          -- app-validated against the module registry
  carrier                   text,                          -- app-validated against the module registry
  divert_no_answer          boolean     not null default true,
  divert_busy               boolean     not null default true,
  divert_unreachable        boolean     not null default true,
  no_answer_delay_seconds   int         check (no_answer_delay_seconds between 5 and 60), -- module enforces the exact 15/20/25/30 set
  target_number             text,                          -- snapshot of clients.twilio_number at generate time
  generated_codes           jsonb,                         -- exact buildDivertCodes result (incl. templateVersion, disclaimer)
  setup_status              text        not null default 'not_started'
    check (setup_status in ('not_started','instructions_generated','user_claimed_done','test_passed','needs_help')),
  needs_help_note           text,                          -- free text from "I need help" (app caps length)
  status_updated_at         timestamptz,
  instructions_generated_at timestamptz,
  claimed_done_at           timestamptz,                   -- self-reported claim, not verification
  test_passed_at            timestamptz,                   -- self-reported claim, not verification
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint cprp_client_key unique (client_id)
);

alter table public.client_phone_routing_profiles enable row level security;

comment on table public.client_phone_routing_profiles is
  'RLS enabled, no policies: only service_role (the app server) may access. WEB-CALL-SETUP-1 phone-diversion setup — see docs/WEB_CALL_SETUP_SPEC.md and src/services/routing-profile.js.';

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename = 'client_phone_routing_profiles'; -- expect rowsecurity = t
select conname, contype from pg_constraint
 where conrelid = 'public.client_phone_routing_profiles'::regclass
 order by conname;                                                            -- expect pkey + cprp_client_key (u) + the two check constraints
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'client_phone_routing_profiles'
 order by ordinal_position;                                                   -- expect the 19 columns above

-- ── Rollback ────────────────────────────────────────────────────────────────
-- begin;
-- drop table if exists public.client_phone_routing_profiles;
-- commit;
