-- ============================================================================
-- DEV-ONLY minimal schema for the aida-dev Supabase project (M2 Batch 3).
--
-- NOT FOR PRODUCTION. Production's clients table has many more columns; this
-- file creates only what the mobile-registration path reads
-- (src/middleware/auth.js: slug/name/real_number/auth_user_id;
--  src/services/devices.js: voip_enabled by slug), so the dev project stays
-- free of production structure and data (no PII, no dump).
--
-- Apply in the DEV project's SQL editor, then apply the existing reviewed
-- files IN ORDER:
--   1. this file
--   2. phase1a_add_voip_enabled.sql   (no-op here — column already present —
--                                      kept in sequence for fidelity)
--   3. phase1b_create_devices.sql     (devices + RLS, same transaction)
--
-- RLS: enabled in the same transaction with NO policies (deny-by-default,
-- service-role only) — the same posture as production (D8).
-- ============================================================================

begin;

create table if not exists public.clients (
  slug          text        primary key,          -- tenant id ("dev-client")
  name          text        not null,
  real_number   text,                              -- unused in registration; auth.js selects it
  auth_user_id  uuid,                              -- linked by signupClient()
  voip_enabled  boolean     not null default false, -- D7 per-client flag
  created_at    timestamptz not null default now()
);

alter table public.clients enable row level security;

-- Dev tenant. voip_enabled=true is the whole point of the dev environment;
-- production defaults stay false (D7).
insert into public.clients (slug, name, voip_enabled)
values ('dev-client', 'Dev Client Co', true)
on conflict (slug) do nothing;

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select slug, name, voip_enabled, auth_user_id from public.clients;
-- Expect: one row, dev-client, voip_enabled = true, auth_user_id null (until
-- the signup step links it).
select relrowsecurity from pg_class where oid = 'public.clients'::regclass;
-- Expect: true.
