-- ============================================================================
-- LAQ4 PREFLIGHT (M8K). READ-ONLY. Run BEFORE applying laq4.
--
-- Writes nothing and changes nothing. Every query below either reports a fact
-- or returns zero rows; none of them create, alter or drop anything.
--
-- Run this against DEV and read every result before running
-- supabase/sql/laq4_create_dncr_washes.sql. If any check disagrees with its
-- stated expectation, STOP -- the schema is not what laq4 was written against.
-- ============================================================================

-- 1. WHICH DATABASE IS THIS. Guard against applying to the wrong project.
select current_database() as db, current_user as usr, version() as pg;

-- 2. laq1, laq2 and laq3 are applied. laq4 assumes all three.
--    Expect: acquisition_prospects, acquisition_prospect_phones,
--            acquisition_evidence, acquisition_decisions,
--            acquisition_suppressions, acquisition_qualifications,
--            acquisition_call_queue, acquisition_contact_outcomes  (8 rows)
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name like 'acquisition\_%'
 order by table_name;

-- 3. THE HARD PREREQUISITE. laq4 attaches laq2's refusal function to its new
--    table rather than defining its own. If this returns zero rows, laq2 has
--    not been applied and laq4 MUST NOT be run.
--    Expect: exactly 1 row.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'acquisition_refuse_mutation';

-- 4. The table laq4 creates must NOT already exist.
--    Expect: zero rows. If it returns one, laq4 has already been applied and
--    re-running it would be a no-op on the table but would still recreate the
--    trigger -- read the existing definition before deciding.
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name = 'acquisition_dncr_washes';

-- 5. Nor may its function or indexes exist under those names.
--    Expect: zero rows from both.
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'acquisition_reject_future_wash';

select indexname
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('acquisition_dncr_washes_idem',
                     'acquisition_dncr_washes_latest',
                     'acquisition_dncr_washes_batch');

-- 6. gen_random_uuid() is available (pgcrypto / pg13+ builtin). laq1 and laq2
--    already rely on it, so this is a confirmation rather than a question.
--    Expect: exactly 1 row.
select p.proname
  from pg_proc p
 where p.proname = 'gen_random_uuid';

-- 7. THE POSTURE CHECK. Every acquisition table has RLS on and no policies.
--    laq4 continues that; if it is not already true, find out why first.
--    Expect: relrowsecurity = true on all 8 rows.
select c.relname, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname like 'acquisition\_%'
   and c.relkind = 'r'
 order by c.relname;

--    Expect: zero rows.
select tablename, policyname
  from pg_policies
 where schemaname = 'public'
   and tablename like 'acquisition\_%';

-- 8. Row counts, so the post-apply verification can prove laq4 created nothing
--    and touched nothing. Record this output.
select 'acquisition_prospects'         as t, count(*) from public.acquisition_prospects
union all select 'acquisition_prospect_phones',    count(*) from public.acquisition_prospect_phones
union all select 'acquisition_evidence',           count(*) from public.acquisition_evidence
union all select 'acquisition_decisions',          count(*) from public.acquisition_decisions
union all select 'acquisition_suppressions',       count(*) from public.acquisition_suppressions
union all select 'acquisition_qualifications',     count(*) from public.acquisition_qualifications
union all select 'acquisition_call_queue',         count(*) from public.acquisition_call_queue
union all select 'acquisition_contact_outcomes',   count(*) from public.acquisition_contact_outcomes
 order by t;
