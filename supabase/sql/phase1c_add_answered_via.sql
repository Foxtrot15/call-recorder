-- ============================================================================
-- VoIP Phase 1c: add the v2 bookkeeping columns to `calls` (spec §3.2).
--
-- Safe/additive: all nullable, no defaults that rewrite rows, the pipeline
-- ignores them entirely. Written by /voip/dial-result (best-effort — the
-- code logs-and-continues if these are missing, so applying this is about
-- data quality, not availability).
--
--   answered_via  'voip' | 'voicemail' | 'bridge'  — how the call terminated
--   dial_status   raw Twilio DialCallStatus from <Dial action>
--   answered_at   when the app leg was answered
--
-- REVIEW ONLY — apply in the Supabase SQL Editor at Phase 1c entry
-- (after phase1a_add_voip_enabled.sql and phase1b_create_devices.sql).
-- ============================================================================

begin;

alter table public.calls add column if not exists answered_via text;
alter table public.calls add column if not exists dial_status  text;
alter table public.calls add column if not exists answered_at  timestamptz;

comment on column public.calls.answered_via is
  'VoIP v2: voip (app answered) | voicemail | bridge. Null for pre-v2 rows. See docs/VOIP_V2_BACKEND_SPEC.md §3.2.';

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'calls'
   and column_name in ('answered_via', 'dial_status', 'answered_at');
-- Expect three rows.

-- ── Rollback ────────────────────────────────────────────────────────────────
-- begin;
-- alter table public.calls drop column if exists answered_via;
-- alter table public.calls drop column if exists dial_status;
-- alter table public.calls drop column if exists answered_at;
-- commit;
