-- ============================================================================
-- Phase 5 item 1: Backfill legacy tenant data from 'default' (and NULL) to a
-- real client slug.
--
-- ⛔ DO NOT RUN AS-IS. Two manual steps first:
--   1. Replace every occurrence of __NEW_SLUG__ with the real clients.slug
--      (the DO block refuses to run if you forget).
--   2. Run this in the SAME change window as updating OPERATOR_CLIENT_ID in
--      Railway to that slug — otherwise dashboard reads and pipeline writes
--      split across two tenants.
--
-- After this succeeds: remove the transitional tenant filter in
-- src/routes/calls.js (PHASE_5_PLAN.md item 2).
--
-- Failure mode to expect: if a row already exists under BOTH 'default' and
-- the new slug where a unique constraint spans (client_id, ...) — e.g. the
-- same phone in personal_contacts, or a connections row per provider — the
-- UPDATE raises a unique violation and the whole script rolls back cleanly.
-- Resolve the duplicate manually (usually: delete the stale 'default' row),
-- then re-run.
-- ============================================================================

-- ── Pre-flight: see what will move (run alone first, sanity-check counts) ──
select 'calls'             as tbl, count(*) from public.calls             where client_id = 'default' or client_id is null
union all
select 'contacts',                 count(*) from public.contacts          where client_id = 'default' or client_id is null
union all
select 'personal_contacts',        count(*) from public.personal_contacts where client_id = 'default' or client_id is null
union all
select 'client_settings',          count(*) from public.client_settings   where client_id = 'default' or client_id is null
union all
select 'connections',              count(*) from public.connections       where client_id = 'default' or client_id is null
union all
select 'business_profiles',        count(*) from public.business_profiles where client_id = 'default' or client_id is null;

-- ── The backfill (atomic: the DO block is a single transaction) ────────────
do $$
declare
  v_slug  text := '__NEW_SLUG__';
  v_count bigint;
begin
  -- Guards: fail loudly rather than mis-migrate.
  if v_slug = '__NEW_SLUG__' then
    raise exception 'Replace __NEW_SLUG__ with the real clients.slug before running';
  end if;
  if v_slug = 'default' then
    raise exception 'Refusing to backfill onto the ''default'' slug itself';
  end if;
  if not exists (select 1 from public.clients where slug = v_slug) then
    raise exception 'No clients row with slug "%" — create/onboard the client first', v_slug;
  end if;

  update public.calls set client_id = v_slug
    where client_id = 'default' or client_id is null;
  get diagnostics v_count = row_count;
  raise notice 'calls: % rows migrated', v_count;

  update public.contacts set client_id = v_slug
    where client_id = 'default' or client_id is null;
  get diagnostics v_count = row_count;
  raise notice 'contacts: % rows migrated', v_count;

  update public.personal_contacts set client_id = v_slug
    where client_id = 'default' or client_id is null;
  get diagnostics v_count = row_count;
  raise notice 'personal_contacts: % rows migrated', v_count;

  update public.client_settings set client_id = v_slug
    where client_id = 'default' or client_id is null;
  get diagnostics v_count = row_count;
  raise notice 'client_settings: % rows migrated', v_count;

  update public.connections set client_id = v_slug
    where client_id = 'default' or client_id is null;
  get diagnostics v_count = row_count;
  raise notice 'connections: % rows migrated', v_count;

  update public.business_profiles set client_id = v_slug
    where client_id = 'default' or client_id is null;
  get diagnostics v_count = row_count;
  raise notice 'business_profiles: % rows migrated', v_count;
end $$;

-- ── Post-verification: both selects should return zero rows ────────────────
select 'leftover' as check, tbl, cnt from (
  select 'calls'             as tbl, count(*) as cnt from public.calls             where client_id = 'default' or client_id is null
  union all
  select 'contacts',                 count(*)        from public.contacts          where client_id = 'default' or client_id is null
  union all
  select 'personal_contacts',        count(*)        from public.personal_contacts where client_id = 'default' or client_id is null
  union all
  select 'client_settings',          count(*)        from public.client_settings   where client_id = 'default' or client_id is null
  union all
  select 'connections',              count(*)        from public.connections       where client_id = 'default' or client_id is null
  union all
  select 'business_profiles',        count(*)        from public.business_profiles where client_id = 'default' or client_id is null
) t where cnt > 0;

-- Reminder of the paired infra change (no SQL): set OPERATOR_CLIENT_ID to the
-- new slug in Railway now, and redeploy/restart.
