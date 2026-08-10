-- ============================================================================
-- LAQ4 VERIFICATION (M8K). Run AFTER applying laq4, against DEV only.
--
-- Sections 1-4 are READ-ONLY.
--
-- Section 5 is a BEHAVIOURAL PROBE and it WRITES. It inserts one fictional row
-- against a fictional number, proves the four refusals against it, and then
-- CANNOT DELETE IT -- the table is append-only, which is the very property
-- being proven. Do not run section 5 unless you accept one permanent fictional
-- row in dev. Everything above it is safe to run unconditionally.
-- ============================================================================

-- ── 1. The table exists, with the columns laq4 describes ────────────
--    Expect: id, e164, result, washed_at, attested_by, mode, authoritative,
--            batch_ref, source, recorded_at
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'acquisition_dncr_washes'
 order by ordinal_position;

-- ── 2. RLS is on, with no policies ──────────────────────────────────
--    Expect: relrowsecurity = true.
select relname, relrowsecurity
  from pg_class
 where relname = 'acquisition_dncr_washes';

--    Expect: zero rows, here and across every acquisition table.
select tablename, policyname
  from pg_policies
 where schemaname = 'public'
   and tablename like 'acquisition\_%';

-- ── 3. The constraints, indexes and triggers are all present ────────
--    Expect: the e164 pattern, the result enum, the mode enum, the
--            attested_by non-empty check, and the authoritative/mode agreement.
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
 where c.relname = 'acquisition_dncr_washes'
 order by con.conname;

--    Expect: acquisition_dncr_washes_idem (unique), _latest, _batch (partial).
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'acquisition_dncr_washes'
 order by indexname;

--    Expect: acq_dncr_no_future_wash (insert) and
--            acq_dncr_washes_no_update (update or delete).
select tgname, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where c.relname = 'acquisition_dncr_washes'
   and not t.tgisinternal
 order by tgname;

-- ── 4. laq4 created nothing and touched nothing else ────────────────
--    Expect: zero rows in the new table, and every other count identical to
--            the preflight's section 8.
select count(*) as dncr_wash_rows from public.acquisition_dncr_washes;

select 'acquisition_prospects'         as t, count(*) from public.acquisition_prospects
union all select 'acquisition_prospect_phones',    count(*) from public.acquisition_prospect_phones
union all select 'acquisition_evidence',           count(*) from public.acquisition_evidence
union all select 'acquisition_decisions',          count(*) from public.acquisition_decisions
union all select 'acquisition_suppressions',       count(*) from public.acquisition_suppressions
union all select 'acquisition_qualifications',     count(*) from public.acquisition_qualifications
union all select 'acquisition_call_queue',         count(*) from public.acquisition_call_queue
union all select 'acquisition_contact_outcomes',   count(*) from public.acquisition_contact_outcomes
 order by t;

-- ============================================================================
-- ── 5. BEHAVIOURAL PROBE. THIS WRITES ONE PERMANENT FICTIONAL ROW. ──
-- ============================================================================
--
-- +61355509999 is fictional and belongs to no business. Run each statement
-- separately and read the error text; four of the five MUST fail.

-- 5a. A future wash is refused.
--     Expect: ERROR, check_violation, from acquisition_reject_future_wash().
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative)
-- values ('+61355509999', 'not_listed', now() + interval '1 day',
--         'laq4-verify', 'import', true);

-- 5b. A fixture row cannot claim to be authoritative.
--     Expect: ERROR, violates the authoritative/mode agreement check.
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative)
-- values ('+61355509999', 'not_listed', now(), 'laq4-verify', 'fixture', true);

-- 5c. An unattested wash is refused.
--     Expect: ERROR, violates the attested_by non-empty check.
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative)
-- values ('+61355509999', 'not_listed', now(), '   ', 'import', true);

-- 5d. THE ONE THAT SUCCEEDS. One permanent fictional row.
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative, batch_ref, source)
-- values ('+61355509999', 'not_listed', now() - interval '1 day',
--         'laq4-verify', 'import', true, 'laq4-verify-batch', 'verification probe');

-- 5e. The same wash again is refused by the idempotency index.
--     Expect: ERROR 23505 on acquisition_dncr_washes_idem.
--     (Re-run 5d verbatim.)

-- 5f. It cannot be edited or removed. Both must raise the append-only refusal.
-- update public.acquisition_dncr_washes set result = 'listed'
--  where e164 = '+61355509999';
-- delete from public.acquisition_dncr_washes
--  where e164 = '+61355509999';

-- 5g. Record the residue. Expect exactly 1 row, and remember to add it to the
--     dev fictional-row count in the blocker register.
-- select e164, result, washed_at, attested_by, mode, authoritative, batch_ref
--   from public.acquisition_dncr_washes;
