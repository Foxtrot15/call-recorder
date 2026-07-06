-- ============================================================================
-- VoIP Phase 1a: add the per-client voip_enabled flag (decision D7, INV-1).
--
-- Safe/additive: nullable-free boolean with DEFAULT FALSE — no existing row
-- or query changes behaviour. The loop guard (src/services/loop-guard.js)
-- works BEFORE this is applied too: it detects the missing column (42703)
-- and treats the fleet as non-VoIP, which is correct because no CFU cutover
-- can have happened under the runbook until this flag exists.
--
-- REVIEW ONLY — apply in the Supabase SQL Editor at Phase 1 entry.
-- RLS note: column-add on an RLS-enabled table needs no RLS changes.
-- ============================================================================

begin;

alter table public.clients
  add column if not exists voip_enabled boolean not null default false;

comment on column public.clients.voip_enabled is
  'VoIP v2 / CFU cutover flag (docs/VOIP_V2_IMPLEMENTATION_PLAN.md D7). While true, the loop guard (INV-1) refuses any PSTN dial to this client''s real_number. Set true ONLY as part of the §16 cutover runbook.';

commit;

-- ── Verification ────────────────────────────────────────────────────────────
-- 1. Column exists, default false, no client enabled yet:
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'clients' and column_name = 'voip_enabled';
select count(*) as voip_enabled_clients from public.clients where voip_enabled = true;
-- Expect: column present, default false, count 0.

-- 2. After applying, the server log line
--    "loop-guard: clients.voip_enabled column not provisioned yet"
--    must no longer appear on /call/initiate.

-- ── Rollback ────────────────────────────────────────────────────────────────
-- begin;
-- alter table public.clients drop column if exists voip_enabled;
-- commit;
