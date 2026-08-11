-- ============================================================================
-- LAQ5 VERIFICATION (E-7B1). Run AFTER applying laq5, against DEV only.
--
-- Sections 1-5 are READ-ONLY and may be re-run at any time.
--
-- Section 6 is a BEHAVIOURAL PROBE and it WRITES. It inserts fictional dispatch
-- rows against a fictional prospect and a fictional number, proves the refusals
-- against them, and then CANNOT DELETE THEM -- the table refuses DELETE, which
-- is one of the properties being proven.
--
-- SECTION 6 HAS NOT BEEN RUN. Running it against dev permanently adds ONE row
-- to acquisition_dial_executions (dev residue 21 -> 23 including the bootstrap
-- calling-state row). Read section 6's header before running it.
--
-- NOTHING HERE ENABLES CALLING. Section 7 deliberately proves the state row
-- refuses to be tampered with; it never sets state = 'enabled'.
-- ============================================================================

-- -- 1. Both tables exist, with the columns laq5 describes -----------
--    Expect for acquisition_dial_executions: dispatch_id, authorisation_id,
--    prospect_id, destination_e164, batch_key, authorised_at, claimed_at,
--    claimed_by, provider, provider_live, provider_status, submitted_at,
--    provider_ref, error_code, resolved_at, resolution, resolved_by,
--    resolution_note, created_at
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('acquisition_dial_executions','acquisition_calling_state')
 order by table_name, ordinal_position;

-- -- 2. RLS is on for both, with no policies -------------------------
--    Expect: relrowsecurity = true for both.
select relname, relrowsecurity
  from pg_class
 where relname in ('acquisition_dial_executions','acquisition_calling_state');

--    Expect: ZERO rows, here and across every acquisition table.
select tablename, policyname
  from pg_policies
 where schemaname = 'public'
   and tablename like 'acquisition\_%';

-- -- 3. The load-bearing indexes exist ------------------------------
--    THE TWO PARTIAL UNIQUE INDEXES ARE THE SAFETY CONSTRAINTS. If either is
--    missing, the durable guarantee is gone and the application's claim is a
--    lie. Expect both, each with "WHERE (resolved_at IS NULL)".
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'acquisition_dial_executions'
 order by indexname;

-- -- 4. Constraints and triggers ------------------------------------
--    Expect: the destination_e164 pattern, the provider_status enum, the
--            resolution enum, the resolution-complete pair, the
--            submission-consistent pair, the scope check, the state enum,
--            the revision check, the prospect FK with ON DELETE RESTRICT.
select rel.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname in ('acquisition_dial_executions','acquisition_calling_state')
 order by rel.relname, con.conname;

--    Expect: acq_dial_exec_guard and acq_calling_state_guard, both BEFORE
--            UPDATE OR DELETE.
select rel.relname as table_name, tg.tgname, pg_get_triggerdef(tg.oid) as definition
  from pg_trigger tg
  join pg_class rel on rel.oid = tg.tgrelid
 where rel.relname in ('acquisition_dial_executions','acquisition_calling_state')
   and not tg.tgisinternal
 order by rel.relname, tg.tgname;

-- -- 5. Calling is PAUSED, attributed, revision 1 --------------------
--    THE MOST IMPORTANT READ IN THIS FILE.
--    Expect EXACTLY ONE row: ('global', 'paused', 1, 'laq5-migration', ...).
--    If this says 'enabled', something other than this migration wrote it.
select scope, state, revision, changed_by, changed_at, reason
  from public.acquisition_calling_state;

--    Expect: 0. The migration writes no dispatch rows.
select count(*) as dial_executions_after_migration
  from public.acquisition_dial_executions;

-- ============================================================================
-- SECTION 6 -- BEHAVIOURAL PROBE. WRITES. READ THIS BEFORE RUNNING.
--
-- Adds ONE PERMANENT ROW to acquisition_dial_executions. The table refuses
-- DELETE, so it cannot be cleaned up -- that is the point of the probe.
--
-- It needs a prospect to reference (ON DELETE RESTRICT). Dev already holds the
-- fictional M8G prospects; substitute a real dev prospect_id below. The
-- destination is +61355509999, the same fictional number laq4's probe used.
--
-- Run inside a transaction and ROLLBACK if you only want to see the refusals
-- without leaving the row. The refusals are what matters; the surviving row is
-- only needed if you want the residue to demonstrate the lock afterwards.
-- ============================================================================

-- begin;
--
-- -- 6a. Claim one dispatch.
-- insert into public.acquisition_dial_executions
--   (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
--    authorised_at, claimed_by, provider, provider_live)
-- values
--   (gen_random_uuid(), 'ad_laq5verify', '<DEV_PROSPECT_ID>', '+61355509999',
--    'ba_laq5verify', now(), 'laq5-verify', 'disabled', false);
--
-- -- 6b. ONE PROSPECT -> ONE UNRESOLVED DISPATCH.
-- --     Expect: 23505 on idx_acq_dial_exec_unresolved_prospect.
-- insert into public.acquisition_dial_executions
--   (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
--    authorised_at, claimed_by, provider, provider_live)
-- values
--   (gen_random_uuid(), 'ad_laq5verify_b', '<DEV_PROSPECT_ID>', '+61355509998',
--    'ba_laq5verify', now(), 'laq5-verify', 'disabled', false);
--
-- -- 6c. ONE DESTINATION -> ONE UNRESOLVED DISPATCH.
-- --     A DIFFERENT prospect, the SAME number.
-- --     Expect: 23505 on idx_acq_dial_exec_unresolved_destination.
-- insert into public.acquisition_dial_executions
--   (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
--    authorised_at, claimed_by, provider, provider_live)
-- values
--   (gen_random_uuid(), 'ad_laq5verify_c', '<OTHER_DEV_PROSPECT_ID>', '+61355509999',
--    'ba_laq5verify', now(), 'laq5-verify', 'disabled', false);
--
-- -- 6d. THE POINT OF THE WHOLE MIGRATION.
-- --     Provider completion must NOT release the lock.
-- update public.acquisition_dial_executions
--    set provider_status = 'submitted', submitted_at = now(), provider_ref = 'probe'
--  where authorisation_id = 'ad_laq5verify';
--
-- --     Retry 6b. Expect: STILL 23505. The provider finishing changed nothing.
--
-- -- 6e. Only a business-level resolution releases it.
-- update public.acquisition_dial_executions
--    set resolved_at = now(), resolution = 'operator_closed',
--        resolved_by = 'laq5-verify',
--        resolution_note = 'Verification probe. No call was placed; the provider was the disabled one.'
--  where authorisation_id = 'ad_laq5verify';
--
-- --     Retry 6b. Expect: SUCCEEDS now.
--
-- -- 6f. Identity is immutable.
-- --     Expect: 'acquisition_dial_executions identity is immutable'.
-- update public.acquisition_dial_executions
--    set destination_e164 = '+61355509911'
--  where authorisation_id = 'ad_laq5verify';
--
-- -- 6g. A resolved dispatch cannot be reopened.
-- --     Expect: 'this dispatch was resolved at ... and cannot be reopened'.
-- update public.acquisition_dial_executions
--    set provider_status = 'unknown'
--  where authorisation_id = 'ad_laq5verify';
--
-- -- 6h. Rows are not deletable.
-- --     Expect: 'acquisition_dial_executions is not deletable'.
-- delete from public.acquisition_dial_executions where authorisation_id = 'ad_laq5verify';
--
-- -- 6i. Constraint pairs.
-- --     Expect: 23514 on acq_dial_exec_resolution_complete.
-- insert into public.acquisition_dial_executions
--   (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
--    authorised_at, claimed_by, provider, provider_live, resolved_at)
-- values
--   (gen_random_uuid(), 'ad_bad', '<DEV_PROSPECT_ID>', '+61355509997',
--    'ba_x', now(), 'laq5-verify', 'disabled', false, now());
--
-- --     Expect: 23514 on acq_dial_exec_submission_consistent.
-- insert into public.acquisition_dial_executions
--   (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
--    authorised_at, claimed_by, provider, provider_live, provider_status)
-- values
--   (gen_random_uuid(), 'ad_bad2', '<DEV_PROSPECT_ID>', '+61355509996',
--    'ba_x', now(), 'laq5-verify', 'disabled', false, 'submitted');
--
-- rollback;   -- or commit, if you intend to keep the one residue row

-- ============================================================================
-- SECTION 7 -- CALLING STATE TAMPER PROBE. WRITES, but adds no rows.
--
-- Every statement here is expected to FAIL. None of them sets state='enabled',
-- and none of them may be "fixed" so that it succeeds.
-- ============================================================================

-- begin;
--
-- -- 7a. A second global row is impossible. Expect: 23505.
-- --     Deliberately inserts 'paused', not 'enabled': the probe is about the
-- --     primary key, and no runnable line in this repository should carry the
-- --     string that turns calling on.
-- insert into public.acquisition_calling_state (scope, state, changed_by, reason)
-- values ('global', 'paused', 'probe', 'must fail');
--
-- -- 7b. A non-global scope is impossible. Expect: 23514 on the scope check.
-- insert into public.acquisition_calling_state (scope, state, changed_by, reason)
-- values ('campaign-x', 'paused', 'probe', 'must fail');
--
-- -- 7c. The row cannot be deleted. Expect: 'may not be deleted'.
-- delete from public.acquisition_calling_state;
--
-- -- 7d. Revision cannot skip. Expect: 'increment by exactly one'.
-- update public.acquisition_calling_state
--    set state = 'paused', revision = revision + 2,
--        changed_by = 'probe', reason = 'must fail';
--
-- -- 7e. A change must be attributed. Expect: 'must name who made it and why'.
-- update public.acquisition_calling_state
--    set state = 'paused', revision = revision + 1,
--        changed_by = '', reason = 'must fail';
--
-- -- 7f. An unknown state is impossible. Expect: 23514 on the state check.
-- update public.acquisition_calling_state
--    set state = 'on', revision = revision + 1,
--        changed_by = 'probe', reason = 'must fail';
--
-- rollback;

-- ============================================================================
-- AFTER RUNNING: expected dev state
--
--   acquisition_calling_state    1 row, 'global', 'paused', revision 1
--   acquisition_dial_executions  0 rows if section 6 was rolled back,
--                                1 row if it was committed
--
--   Total dev fictional acquisition residue: 22 (rolled back) or 23 (committed),
--   up from 21. acquisition_decisions is UNCHANGED at 4 -- laq5 writes none.
-- ============================================================================
