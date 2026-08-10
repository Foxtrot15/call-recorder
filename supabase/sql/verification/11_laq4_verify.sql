-- ============================================================================
-- LAQ4 VERIFICATION (M8K). Run AFTER applying laq4, against DEV only.
--
-- Sections 1-4 are READ-ONLY.
--
-- Section 5 is a BEHAVIOURAL PROBE and it WRITES. It inserts one fictional row
-- against a fictional number, proves the four refusals against it, and then
-- CANNOT DELETE IT -- the table is append-only, which is the very property
-- being proven. Everything above it is safe to run unconditionally.
--
-- SECTION 5 HAS ALREADY BEEN RUN AGAINST DEV. Do not run it there again; see
-- the warning above section 5. Sections 1-4 may be re-run at any time.
-- ============================================================================

-- -- 1. The table exists, with the columns laq4 describes ------------
--    Expect: id, e164, result, washed_at, attested_by, mode, authoritative,
--            batch_ref, source, recorded_at
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'acquisition_dncr_washes'
 order by ordinal_position;

-- -- 2. RLS is on, with no policies ----------------------------------
--    Expect: relrowsecurity = true.
select relname, relrowsecurity
  from pg_class
 where relname = 'acquisition_dncr_washes';

--    Expect: zero rows, here and across every acquisition table.
select tablename, policyname
  from pg_policies
 where schemaname = 'public'
   and tablename like 'acquisition\_%';

-- -- 3. The constraints, indexes and triggers are all present --------
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

-- -- 4. laq4 created nothing and touched nothing else ----------------
--    Immediately after applying laq4: expect ZERO rows in the new table, and
--    every other count identical to the preflight's section 8.
--
--    On dev TODAY: expect ONE row, because section 5 has since been run. The
--    other eight counts are still exactly what the preflight recorded, and the
--    nine-table total is 21.
select count(*) as dncr_wash_rows from public.acquisition_dncr_washes;

select 'acquisition_prospects'         as t, count(*) from public.acquisition_prospects
union all select 'acquisition_prospect_phones',    count(*) from public.acquisition_prospect_phones
union all select 'acquisition_evidence',           count(*) from public.acquisition_evidence
union all select 'acquisition_decisions',          count(*) from public.acquisition_decisions
union all select 'acquisition_suppressions',       count(*) from public.acquisition_suppressions
union all select 'acquisition_qualifications',     count(*) from public.acquisition_qualifications
union all select 'acquisition_call_queue',         count(*) from public.acquisition_call_queue
union all select 'acquisition_contact_outcomes',   count(*) from public.acquisition_contact_outcomes
union all select 'acquisition_dncr_washes',        count(*) from public.acquisition_dncr_washes
 order by t;

--    And the nine-table total, which is the number the blocker register quotes.
--    Expect on dev today: 21.
select sum(n) as total_acquisition_rows from (
  select count(*) as n from public.acquisition_prospects
  union all select count(*) from public.acquisition_prospect_phones
  union all select count(*) from public.acquisition_evidence
  union all select count(*) from public.acquisition_decisions
  union all select count(*) from public.acquisition_suppressions
  union all select count(*) from public.acquisition_qualifications
  union all select count(*) from public.acquisition_call_queue
  union all select count(*) from public.acquisition_contact_outcomes
  union all select count(*) from public.acquisition_dncr_washes
) counts;

-- ============================================================================
-- -- 5. BEHAVIOURAL PROBE. THIS WRITES ONE PERMANENT FICTIONAL ROW. --
-- ============================================================================
--
-- ALREADY RUN AGAINST DEV ON 2026-08-10. DO NOT RUN IT THERE AGAIN.
--
-- The row 5d creates is on dev now, it is counted in the dev fictional total of
-- 21, and it CANNOT BE DELETED -- the table is append-only, which is the very
-- property 5f proves. Re-running 5d against dev would simply raise 23505, which
-- is 5e's demonstration rather than 5d's; that is harmless but it is not what
-- this section is for. Everything below is written for a database that has NOT
-- had it run: a fresh dev after a rebuild, or production if it is ever applied.
--
-- +61355509999 is fictional and belongs to no business.
--
-- -- WHY EVERY TIMESTAMP HERE IS FIXED --------------------------------
-- The first version of this section used `now() - interval '1 day'` in 5d and
-- then told the reader to "re-run 5d verbatim" to demonstrate the idempotency
-- index. THAT WAS WRONG, and wrong in the direction that reads as a pass:
-- washed_at is part of the unique key
--
--     (e164, washed_at, result, coalesce(batch_ref, ''))
--
-- so a second run a minute later carried a DIFFERENT washed_at, produced a
-- DIFFERENT key, and inserted a SECOND row. The index was never exercised, and
-- the operator would have been left with two permanent rows believing they had
-- proven no duplicate was possible.
--
-- Every timestamp below is therefore a literal. 5d and 5e are byte-identical on
-- purpose: that is the only way "the same wash twice" can mean anything against
-- a key that includes the instant.
--
-- Run each statement SEPARATELY and read the error text. Four of the five
-- inserts MUST fail; exactly one MUST succeed.

-- 5a. A future wash is refused.
--     A far-future literal, so this stays a future date whenever it is run.
--     Expect: ERROR, check_violation, from acquisition_reject_future_wash().
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative)
-- values ('+61355509999', 'not_listed', timestamptz '2099-01-01T00:00:00Z',
--         'laq4-verify', 'import', true);

-- 5b. A fixture row cannot claim to be authoritative.
--     A distinct timestamp from 5d's, so this can only ever fail on the
--     authoritative/mode agreement and never on the idempotency index.
--     Expect: ERROR, violates the authoritative/mode agreement check.
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative)
-- values ('+61355509999', 'not_listed', timestamptz '2026-08-01T00:00:00Z',
--         'laq4-verify', 'fixture', true);

-- 5c. An unattested wash is refused.
--     Again a distinct timestamp, for the same reason.
--     Expect: ERROR, violates the attested_by non-empty check.
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative)
-- values ('+61355509999', 'not_listed', timestamptz '2026-08-02T00:00:00Z',
--         '   ', 'import', true);

-- 5d. THE ONE THAT SUCCEEDS, AND IT IS PERMANENT.
--
--     This row cannot be edited or deleted afterwards (5f proves it). Running
--     this statement adds one row to the database's fictional residue FOREVER.
--     Do not run it unless you accept that.
--
--     The timestamp is a literal and is the same one dev already holds, so the
--     probe is reproducible and 5e can be byte-identical.
--     Expect: INSERT 0 1.
-- insert into public.acquisition_dncr_washes
--   (e164, result, washed_at, attested_by, mode, authoritative, batch_ref, source)
-- values ('+61355509999', 'not_listed', timestamptz '2026-08-09T00:00:00Z',
--         'laq4-verify', 'import', true, 'laq4-verify-batch', 'verification probe');

-- 5e. THE SAME WASH AGAIN. Re-run 5d byte for byte -- every value above is a
--     literal, so the key is identical and the index must refuse it.
--     Expect: ERROR 23505, duplicate key value violates unique constraint
--             "acquisition_dncr_washes_idem".
--     If this SUCCEEDS you now have two rows and the index is not doing its job.

-- 5f. It cannot be edited or removed. Both must raise the append-only refusal
--     from acquisition_refuse_mutation().
-- update public.acquisition_dncr_washes set result = 'listed'
--  where e164 = '+61355509999';
-- delete from public.acquisition_dncr_washes
--  where e164 = '+61355509999';

-- 5g. Record the residue. Expect EXACTLY ONE row -- if 5e behaved, there is no
--     second one. Add it to the fictional-row count in the blocker register.
-- select e164, result, washed_at, attested_by, mode, authoritative, batch_ref
--   from public.acquisition_dncr_washes;

-- 5h. And confirm the count, because "exactly one" is the whole claim.
--     Expect: 1.
-- select count(*) from public.acquisition_dncr_washes
--  where e164 = '+61355509999';
