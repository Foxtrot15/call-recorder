-- ============================================================================
-- M8I / LAQ3 VERIFICATION.  Run AFTER applying laq3_serialise_decision_chain.sql.
-- DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- ASCII ONLY. CAST-SAFE. READ-ONLY BY CONSTRUCTION: one statement, every arm a
-- bare SELECT. No INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.
--
-- Proves the index exists and is the RIGHT index, and that applying it moved
-- nothing else. An additive index should be invisible to everything except the
-- invariant it enforces, and that is asserted rather than assumed.
-- ============================================================================

select 'V1' as id,
       'uq_acq_decisions_prev_hash exists' as claim,
       (select case when count(*) = 1 then 'present' else 'ABSENT' end
          from pg_class where relname = 'uq_acq_decisions_prev_hash') as detail,
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from pg_class where relname = 'uq_acq_decisions_prev_hash') as verdict

union all
select 'V2',
       'it is UNIQUE',
       (select case when count(*) = 0 then 'not found'
                    when bool_and(i.indisunique) then 'unique' else 'NOT UNIQUE' end
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'uq_acq_decisions_prev_hash'),
       (select case when count(*) = 1 and bool_and(i.indisunique) then 'PASS' else 'FAIL' end
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'uq_acq_decisions_prev_hash')

union all
-- The column matters as much as the uniqueness. A unique index on the wrong
-- column would pass V1 and V2 and enforce nothing that matters.
select 'V3',
       'the indexed expression is exactly (prev_hash)',
       coalesce((select indexdef from pg_indexes
                  where schemaname = 'public' and indexname = 'uq_acq_decisions_prev_hash'), 'not found'),
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from pg_indexes
         where schemaname = 'public'
           and indexname = 'uq_acq_decisions_prev_hash'
           and indexdef ~ 'CREATE UNIQUE INDEX uq_acq_decisions_prev_hash ON public\.acquisition_decisions USING btree \(prev_hash\)$')

union all
select 'V4',
       'it is not partial and not deferrable',
       (select case when count(*) = 0 then 'not found'
                    when bool_or(i.indpred is not null) then 'PARTIAL - a predicate would leave a gap'
                    else 'full' end
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'uq_acq_decisions_prev_hash'),
       (select case when count(*) = 1 and bool_and(i.indpred is null) then 'PASS' else 'FAIL' end
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'uq_acq_decisions_prev_hash')

union all
-- -- Nothing else may have moved -------------------------------------
select 'V5',
       'decision rows unchanged (compare with pre-flight C1)',
       (select count(*)::text || ' row(s), sequence ' ||
               coalesce(min(sequence)::text, '-') || '..' || coalesce(max(sequence)::text, '-')
          from public.acquisition_decisions),
       'COMPARE'

union all
select 'V6',
       'chain head unchanged (compare with pre-flight C2)',
       coalesce((select 'seq ' || sequence::text || '  ' || entry_hash
                   from public.acquisition_decisions order by sequence desc limit 1), 'empty chain'),
       'COMPARE'

union all
select 'V7',
       'still no duplicate prev_hash',
       (select count(*)::text from (
          select prev_hash from public.acquisition_decisions
           group by prev_hash having count(*) > 1) d),
       (select case when count(*) = 0 then 'PASS' else 'FAIL' end
          from (select prev_hash from public.acquisition_decisions
                 group by prev_hash having count(*) > 1) d)

union all
select 'V8',
       'append-only trigger STILL enabled',
       (select coalesce(string_agg(tgname || '=' || tgenabled::text, ', '), 'MISSING')
          from pg_trigger where not tgisinternal and tgname = 'acq_decisions_no_update'),
       (select case when count(*) = 1 and bool_and(tgenabled::text = 'O') then 'PASS' else 'FAIL' end
          from pg_trigger where not tgisinternal and tgname = 'acq_decisions_no_update')

union all
select 'V9',
       'all four append-only triggers still enabled',
       (select coalesce(string_agg(tgname || '=' || tgenabled::text, ', ' order by tgname), 'none')
          from pg_trigger
         where not tgisinternal
           and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                          'acq_suppressions_no_update','acq_outcomes_no_update')),
       (select case when count(*) = 4 and count(*) filter (where tgenabled::text = 'O') = 4
                    then 'PASS' else 'FAIL' end
          from pg_trigger
         where not tgisinternal
           and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                          'acq_suppressions_no_update','acq_outcomes_no_update'))

union all
select 'V10',
       'RLS on and still zero policies across acquisition_*',
       (select (select count(*) filter (where c.relrowsecurity)::text
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind::text = 'r' and c.relname like 'acquisition\_%')
               || ' RLS-enabled, '
               || (select count(*)::text from pg_policies where tablename like 'acquisition\_%') || ' policies'),
       (select case when (select count(*) filter (where c.relrowsecurity)
                            from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind::text = 'r' and c.relname like 'acquisition\_%') = 8
                     and (select count(*) from pg_policies where tablename like 'acquisition\_%') = 0
                    then 'PASS' else 'FAIL' end)

union all
select 'V11',
       'schema still 13 tables (laq3 adds none)',
       (select count(*)::text from pg_tables where schemaname = 'public'),
       (select case when count(*) = 13 then 'PASS' else 'FAIL' end
          from pg_tables where schemaname = 'public')

union all
-- The column SET, not a count.
--
-- This check first shipped comparing against a hard-coded 16, which was simply
-- a miscount: laq1 has defined 17 columns on this table since the commit that
-- created it, and dev has always had exactly those 17. The count was wrong, not
-- the schema -- but a count could not have told anyone that, because it cannot
-- distinguish "a column was added" from "a column was added and another
-- dropped", and it invites exactly the miscount that happened here.
--
-- So the invariant is the list itself, alphabetically, compared against laq1's
-- definition. Any addition, removal or rename shows up as a readable diff
-- rather than as an integer that disagrees with a number in a comment.
-- test/acquisition-decision-log.test.js keeps this literal in step with the
-- migration, so the two can never drift again.
select 'V12',
       'acquisition_decisions has exactly the laq1 columns, no more and no fewer',
       (select string_agg(column_name, ',' order by column_name)
          from information_schema.columns
         where table_schema = 'public' and table_name = 'acquisition_decisions'),
       (select case when string_agg(column_name, ',' order by column_name) =
                         'actor,actor_kind,audit_id,correlation_id,created_at,decision,detail,'
                      || 'entity_id,entity_type,entry_hash,event,id,prev_hash,reason,'
                      || 'recorded_at,schema_version,sequence'
                    then 'PASS' else 'FAIL - schema drift; compare the detail against laq1' end
          from information_schema.columns
         where table_schema = 'public' and table_name = 'acquisition_decisions')

order by id;

-- ============================================================================
-- EXPECTED: every PASS row PASS. V5 and V6 must MATCH the pre-flight values --
-- an additive index changes no data, and if the head moved between the two
-- runs something else wrote to the log.
--
-- Then re-run the chain verifier:
--   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-chain-verify.js
-- ============================================================================
