-- ============================================================================
-- DEV-ONLY addendum for the aida-dev Supabase project (WCS-1b).
--
-- NOT FOR PRODUCTION. Production's clients table already has twilio_number
-- (it is the tenant-resolution key — see src/services/clients.js); the dev
-- minimal schema (dev_minimal_schema.sql) deliberately omitted it because the
-- mobile-registration path never reads it. The call-setup generate path DOES:
-- clients.twilio_number is the server-derived AIDA forwarding target (read
-- only — nothing in the call-setup code ever writes to clients).
--
-- Seeds a FAKE number for dev-client so generate can be exercised end-to-end
-- in dev. Never seed a real number here (no PII / no live routing targets in
-- the dev project).
--
-- Apply in the DEV project's SQL editor only, after the existing sequence:
--   1. dev_minimal_schema.sql
--   2. phase1a_add_voip_enabled.sql
--   3. phase1b_create_devices.sql
--   4. this file
--   5. wcs1b_create_client_phone_routing_profiles.sql
--
-- REVIEW ONLY — not applied by the assistant; human-applied like every other
-- file in supabase/sql/.
-- ============================================================================

begin;

alter table public.clients
  add column if not exists twilio_number text;

update public.clients
   set twilio_number = '+61400000099'   -- fake AU number, dev only
 where slug = 'dev-client'
   and twilio_number is null;           -- idempotent; never clobbers a deliberate value

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select slug, twilio_number from public.clients where slug = 'dev-client';
-- Expect: one row, twilio_number = '+61400000099'.

-- ── Rollback ────────────────────────────────────────────────────────────────
-- begin;
-- alter table public.clients drop column if exists twilio_number;
-- commit;
