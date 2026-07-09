-- ============================================================================
-- VoIP Phase 1b: create the `devices` table (backend spec §3.1, decision D8).
--
-- Tracks which app installs may ring for a client. The raw push token lives
-- ONLY in Twilio's binding — we store a sha256 hash, enough to dedupe and
-- revoke, useless to impersonate.
--
-- Non-negotiables encoded here:
--   * RLS enabled IN THE SAME TRANSACTION (D8 — no table is born unprotected;
--     precedent set by create_personal_contacts.sql).
--   * unique (client_id, push_token_hash) — the upsert path in
--     src/services/devices.js depends on it.
--   * partial index on active devices — the per-call activeDeviceCount check.
--
-- REVIEW ONLY — apply in the Supabase SQL Editor at Phase 1b entry, after
-- phase1a_add_voip_enabled.sql. Until applied, the /devices endpoints return
-- a clear "not provisioned" error (and are unreachable anyway while
-- VOIP_V2_ENABLED is false).
-- ============================================================================

begin;

create table if not exists public.devices (
  id                 uuid        primary key default gen_random_uuid(),
  client_id          text        not null,             -- clients.slug (tenant)
  auth_user_id       uuid,                              -- Supabase Auth user that registered it
  platform           text        not null check (platform in ('ios','android')),
  push_token_hash    text        not null,              -- sha256 hex; raw token only in Twilio's binding
  label              text,                              -- "Pete's iPhone 15"
  app_version        text,
  os_version         text,
  last_registered_at timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  revoked_at         timestamptz,                       -- soft revocation
  created_at         timestamptz not null default now(),
  constraint devices_client_token_key unique (client_id, push_token_hash)
);

create index if not exists devices_client_active_idx
  on public.devices (client_id) where revoked_at is null;

alter table public.devices enable row level security;

comment on table public.devices is
  'RLS enabled, no policies: only service_role (the app server) may access. VoIP v2 device registrations — see docs/VOIP_V2_BACKEND_SPEC.md §3.1 and src/services/devices.js.';

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename = 'devices';       -- expect rowsecurity = t
select indexname from pg_indexes
 where schemaname = 'public' and tablename = 'devices';       -- expect pkey + unique + active idx

-- ── Rollback ────────────────────────────────────────────────────────────────
-- begin;
-- drop table if exists public.devices;
-- commit;
