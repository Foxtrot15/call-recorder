-- ============================================================================
-- M8D - VERIFY LAQ2.  DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- READ-ONLY BY CONSTRUCTION. One statement, one result set, one paste.
-- Every arm is a SELECT. No INSERT, UPDATE, DELETE, CREATE, ALTER, DROP.
-- No transaction block is needed because nothing here can write.
--
-- ASCII ONLY. No box-drawing characters, no em-dashes.
--
-- CAST-SAFE. Postgres catalog columns confdeltype, contype, relkind and
-- tgenabled are type "char", not text. Concatenating one without ::text
-- raises 42725 "operator is not unique: unknown || char". Every such column
-- below is cast. Equality comparisons against a quoted literal are left
-- UNCAST on purpose - they resolve unambiguously and need no cast.
--
-- Rows marked PASS/FAIL are assertions. Rows marked REVIEW are printed for
-- reading, not judged by the query.
-- ============================================================================

-- A: structure -------------------------------------------------------------
select 'A' as section,
       'A01 LAQ2 tables present' as item,
       (select count(*)::text from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_suppressions','acquisition_qualifications',
                             'acquisition_call_queue','acquisition_contact_outcomes')) as detail,
       (select case when count(*) = 4 then 'PASS' else 'FAIL' end from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_suppressions','acquisition_qualifications',
                             'acquisition_call_queue','acquisition_contact_outcomes')) as verdict

union all
select 'A', 'A02 RLS enabled on all 8 acquisition tables',
       (select count(*) filter (where c.relrowsecurity)::text || ' of ' || count(*)::text
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind::text = 'r' and c.relname like 'acquisition\_%'),
       (select case when count(*) = 8 and count(*) filter (where c.relrowsecurity) = 8
                    then 'PASS' else 'FAIL' end
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind::text = 'r' and c.relname like 'acquisition\_%')

union all
select 'A', 'A03 Policies on acquisition_* (must be zero)',
       (select count(*)::text from pg_policies where tablename like 'acquisition\_%'),
       (select case when count(*) = 0 then 'PASS' else 'FAIL - INVESTIGATE' end
          from pg_policies where tablename like 'acquisition\_%')

union all
select 'A', 'A04 Indexes named idx_acq_* (8 from LAQ1 + 9 from LAQ2)',
       (select count(*)::text from pg_indexes
         where schemaname = 'public' and indexname like 'idx\_acq\_%'),
       (select case when count(*) = 17 then 'PASS' else 'FAIL' end from pg_indexes
         where schemaname = 'public' and indexname like 'idx\_acq\_%')

union all
select 'A', 'A05 Public table count',
       (select count(*)::text from pg_tables where schemaname = 'public'),
       (select case when count(*) = 13 then 'PASS' else 'FAIL' end
          from pg_tables where schemaname = 'public')

-- A: the partial unique live-lease index ------------------------------------
-- The rule application code cannot guarantee under a race. UNIQUE alone is not
-- enough: without the WHERE predicate a prospect could never be leased twice
-- even after release. Both properties are asserted.
union all
select 'A', 'A06 idx_acq_queue_one_live_lease is UNIQUE',
       (select case when count(*) = 0 then 'INDEX MISSING'
                    when bool_or(i.indisunique) then 'unique' else 'NOT UNIQUE' end
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'idx_acq_queue_one_live_lease'),
       (select case when count(*) = 1 and bool_or(i.indisunique) then 'PASS' else 'FAIL' end
          from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'idx_acq_queue_one_live_lease')

union all
select 'A', 'A07 idx_acq_queue_one_live_lease is PARTIAL on released_at is null',
       (select coalesce(max(indexdef), 'INDEX MISSING') from pg_indexes
         where schemaname = 'public' and indexname = 'idx_acq_queue_one_live_lease'),
       (select case when count(*) = 1
                     and bool_or(indexdef like '%WHERE (released\_at IS NULL)%')
                    then 'PASS' else 'FAIL' end
          from pg_indexes
         where schemaname = 'public' and indexname = 'idx_acq_queue_one_live_lease')

-- A: append-only triggers ---------------------------------------------------
-- Now four: evidence and decisions from LAQ1, suppressions and outcomes from
-- LAQ2. tgtype 27 = ROW 1 + BEFORE 2 + DELETE 8 + UPDATE 16.
union all
select 'A', 'A08 Append-only triggers installed (4)',
       (select count(*)::text from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                                               'acq_suppressions_no_update','acq_outcomes_no_update')),
       (select case when count(*) = 4 then 'PASS' else 'FAIL' end from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                                               'acq_suppressions_no_update','acq_outcomes_no_update'))

union all
select 'A', 'A09 All 4 append-only triggers ENABLED (tgenabled = O)',
       (select coalesce(string_agg(tgname || '=' || tgenabled::text, ', ' order by tgname), 'none')
          from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                                               'acq_suppressions_no_update','acq_outcomes_no_update')),
       (select case when count(*) = 4 and count(*) filter (where tgenabled::text = 'O') = 4
                    then 'PASS' else 'FAIL - a disabled trigger enforces nothing' end
          from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                                               'acq_suppressions_no_update','acq_outcomes_no_update'))

union all
select 'A', 'A10 All 4 triggers are BEFORE UPDATE OR DELETE FOR EACH ROW',
       (select coalesce(string_agg(tgname || '=' || tgtype::text, ', ' order by tgname), 'none')
          from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                                               'acq_suppressions_no_update','acq_outcomes_no_update')),
       (select case when count(*) = 4 and count(*) filter (where tgtype = 27) = 4
                    then 'PASS' else 'FAIL' end
          from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                                               'acq_suppressions_no_update','acq_outcomes_no_update'))

-- A: the widened lifecycle CHECK --------------------------------------------
-- LAQ1 admitted 6 states. LAQ2 must admit those 6 PLUS 8 engagement states.
-- Both halves are asserted: a widen that dropped the originals would be just
-- as wrong as one that never happened.
union all
select 'A', 'A11 lifecycle CHECK retains the 6 acquisition states',
       (select case when count(*) = 0 then 'CONSTRAINT MISSING' else 'checked' end
          from pg_constraint where conname = 'acquisition_prospects_lifecycle_check'),
       (select case when count(*) = 1
                     and bool_and(pg_get_constraintdef(oid) like '%discovered%')
                     and bool_and(pg_get_constraintdef(oid) like '%evidence_captured%')
                     and bool_and(pg_get_constraintdef(oid) like '%review_pending%')
                     and bool_and(pg_get_constraintdef(oid) like '%review_approved%')
                     and bool_and(pg_get_constraintdef(oid) like '%review_rejected%')
                     and bool_and(pg_get_constraintdef(oid) like '%suppressed%')
                    then 'PASS' else 'FAIL' end
          from pg_constraint where conname = 'acquisition_prospects_lifecycle_check')

union all
select 'A', 'A12 lifecycle CHECK now admits the 8 engagement states',
       (select case when count(*) = 0 then 'CONSTRAINT MISSING'
                    when bool_or(pg_get_constraintdef(oid) like '%queued%') then 'widened'
                    else 'NOT WIDENED' end
          from pg_constraint where conname = 'acquisition_prospects_lifecycle_check'),
       (select case when count(*) = 1
                     and bool_and(pg_get_constraintdef(oid) like '%queued%')
                     and bool_and(pg_get_constraintdef(oid) like '%attempted%')
                     and bool_and(pg_get_constraintdef(oid) like '%connected%')
                     and bool_and(pg_get_constraintdef(oid) like '%callback\_requested%')
                     and bool_and(pg_get_constraintdef(oid) like '%not\_interested%')
                     and bool_and(pg_get_constraintdef(oid) like '%customer%')
                     and bool_and(pg_get_constraintdef(oid) like '%disqualified%')
                    then 'PASS' else 'FAIL' end
          from pg_constraint where conname = 'acquisition_prospects_lifecycle_check')

-- A: RESTRICT vs CASCADE, and the absent foreign key -----------------------
-- THE MOST IMPORTANT ASSERTION IN THIS FILE IS A13.
-- Suppression must survive the prospect record being deleted. A foreign key
-- with ON DELETE CASCADE would let a deleted prospect erase its own opt-out.
-- So acquisition_suppressions holds NO foreign key at all, by design.
union all
select 'A', 'A13 acquisition_suppressions has ZERO foreign keys (by design)',
       (select count(*)::text || ' foreign keys'
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'f' and t.relname = 'acquisition_suppressions'),
       (select case when count(*) = 0 then 'PASS'
                    else 'FAIL - a suppression must not reference a prospect' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'f' and t.relname = 'acquisition_suppressions')

union all
select 'A', 'A14 contact_outcomes FK is RESTRICT, not CASCADE',
       (select coalesce(string_agg(c.conname || '=' || c.confdeltype::text, ', '), 'NO FK FOUND')
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'f' and t.relname = 'acquisition_contact_outcomes'),
       (select case when count(*) = 1 and bool_and(c.confdeltype::text = 'r')
                    then 'PASS' else 'FAIL - an outcome must not be deletable via its prospect' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'f' and t.relname = 'acquisition_contact_outcomes')

union all
-- Derived state, rebuildable from the append-only tables. CASCADE is correct
-- here and is asserted so a later change away from it is visible.
select 'A', 'A15 qualifications + call_queue FKs are CASCADE (derived state)',
       (select coalesce(string_agg(t.relname || '.' || c.conname || '=' || c.confdeltype::text, ', '
                                   order by t.relname), 'NO FK FOUND')
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'f'
           and t.relname in ('acquisition_qualifications','acquisition_call_queue')),
       (select case when count(*) = 2 and count(*) filter (where c.confdeltype::text = 'c') = 2
                    then 'PASS' else 'FAIL' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'f'
           and t.relname in ('acquisition_qualifications','acquisition_call_queue'))

union all
select 'A', 'A16 Total FKs across all acquisition tables (3 LAQ1 + 3 LAQ2)',
       (select count(*)::text || ' total: '
               || count(*) filter (where c.confdeltype::text = 'r')::text || ' restrict, '
               || count(*) filter (where c.confdeltype::text = 'c')::text || ' cascade'
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where c.contype::text = 'f' and n.nspname = 'public' and t.relname like 'acquisition\_%'),
       (select case when count(*) = 6
                     and count(*) filter (where c.confdeltype::text = 'r') = 4
                     and count(*) filter (where c.confdeltype::text = 'c') = 2
                    then 'PASS' else 'FAIL' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where c.contype::text = 'f' and n.nspname = 'public' and t.relname like 'acquisition\_%')

union all
-- A business-scoped suppression without an identity would suppress one handset
-- and let the same business be called back on its other line next week.
select 'A', 'A17 acq_suppression_scope_key constraint present',
       (select case when count(*) = 1 then 'present' else 'ABSENT' end
          from pg_constraint where conname = 'acq_suppression_scope_key'),
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from pg_constraint where conname = 'acq_suppression_scope_key')

union all
-- E.164 normalisation enforced at the column. Comparing published forms means
-- "(03) 5550 2287" and "03-5550-2287" are different numbers.
select 'A', 'A18 e164 regex CHECKs on suppressions, call_queue, contact_outcomes',
       (select count(*)::text || ' of 3'
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'c'
           and t.relname in ('acquisition_suppressions','acquisition_call_queue',
                             'acquisition_contact_outcomes')
           and pg_get_constraintdef(c.oid) like '%+61%'),
       (select case when count(*) = 3 then 'PASS' else 'FAIL' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
         where c.contype::text = 'c'
           and t.relname in ('acquisition_suppressions','acquisition_call_queue',
                             'acquisition_contact_outcomes')
           and pg_get_constraintdef(c.oid) like '%+61%')

-- B: no unexpected rows, all eight tables -----------------------------------
union all
select 'B', 'B01 acquisition_prospects', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_prospects
union all
select 'B', 'B02 acquisition_prospect_phones', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_prospect_phones
union all
select 'B', 'B03 acquisition_evidence', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_evidence
union all
select 'B', 'B04 acquisition_decisions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_decisions
union all
select 'B', 'B05 acquisition_suppressions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_suppressions
union all
select 'B', 'B06 acquisition_qualifications', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_qualifications
union all
select 'B', 'B07 acquisition_call_queue', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_call_queue
union all
select 'B', 'B08 acquisition_contact_outcomes', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_contact_outcomes

-- C: every constraint on the four LAQ2 tables, printed in full --------------
union all
select 'C',
       'C ' || t.relname || '.' || c.conname,
       pg_get_constraintdef(c.oid),
       'REVIEW'
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public'
   and t.relname in ('acquisition_suppressions','acquisition_qualifications',
                     'acquisition_call_queue','acquisition_contact_outcomes')

-- C: the widened lifecycle CHECK itself, printed in full --------------------
union all
select 'C',
       'C acquisition_prospects.' || conname,
       pg_get_constraintdef(oid),
       'REVIEW'
  from pg_constraint
 where conname = 'acquisition_prospects_lifecycle_check'

-- D: every LAQ2 index, printed in full --------------------------------------
union all
select 'D',
       'D ' || indexname,
       indexdef,
       'REVIEW'
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('acquisition_suppressions','acquisition_qualifications',
                     'acquisition_call_queue','acquisition_contact_outcomes')

-- E: the two new triggers, printed in full ----------------------------------
union all
select 'E',
       'E ' || g.tgname || ' [enabled=' || g.tgenabled::text || ']',
       pg_get_triggerdef(g.oid),
       case when g.tgenabled::text = 'O' then 'PASS'
            else 'FAIL - trigger not enabled (flag ' || g.tgenabled::text || ')' end
  from pg_trigger g
  join pg_class t on t.oid = g.tgrelid
  join pg_namespace n on n.oid = t.relnamespace
 where not g.tgisinternal
   and n.nspname = 'public'
   and t.relname in ('acquisition_suppressions','acquisition_contact_outcomes')

order by section, item;

-- ============================================================================
-- EXPECTED:
--   A  18 rows, every one PASS
--   B   8 rows, every one PASS, every detail 0
--   C  ~12 rows REVIEW (LAQ2 constraints + the widened lifecycle CHECK)
--   D  ~11 rows REVIEW (9 idx_acq_* plus the pkey/unique indexes)
--   E   2 rows, both PASS, both enabled=O
--
-- STOP CONDITIONS - any of these halts M8D before the probes:
--   A03 non-zero      a client-facing read path exists
--   A06 or A07 FAIL   one-live-lease is not actually enforced
--   A09 FAIL          append-only is decoration, not enforcement
--   A13 FAIL          a suppression can be erased by deleting a prospect
--   A14 FAIL          an outcome can be erased by deleting a prospect
--   any B non-zero    something wrote to a table that should be empty
-- ============================================================================
