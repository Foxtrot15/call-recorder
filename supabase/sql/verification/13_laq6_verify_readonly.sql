-- ============================================================================
-- LAQ6 READ-ONLY VERIFICATION (E-9).
--
-- THIS FILE CONTAINS NO WRITES OF ANY KIND.
--
--   no INSERT, no UPDATE, no DELETE, no UPSERT, no MERGE, no TRUNCATE
--   no CREATE, no ALTER, no DROP, no GRANT, no REVOKE
--   no begin/commit/rollback, and therefore no transaction wrapping a probe
--   no function call that mutates anything
--
-- Safe to run any number of times, on dev or on production, before or after
-- laq6 is applied. Before it is applied, sections 1 and 2 FAIL and that is the
-- correct answer rather than a defect.
--
-- ── IT ASKS WHAT THINGS ARE, NOT HOW THEY ARE PRINTED ──────────────
-- The lesson LAQ5 taught the hard way: pg_get_triggerdef RECONSTRUCTS its
-- output in Postgres's canonical event order, so matching its exact phrasing
-- tests the printer rather than the schema. Section 4 reads pg_trigger.tgtype
-- bits and tgenabled instead. The one place text is unavoidable is the guard
-- FUNCTION BODY (§3), where the rule is a statement rather than a catalogue
-- entry — and even there the match is on a stable machine token, not prose.
--
-- ── WHAT IT CANNOT TELL YOU ────────────────────────────────────────
-- That the guard REFUSES. Present and correctly shaped is not the same as
-- enforces. Proving refusal needs attempted writes, which is
-- 14_laq6_mutation_probes.sql — that file wraps everything in a transaction it
-- rolls back, so it also leaves nothing behind.
-- ============================================================================


-- -- 1. INVARIANT A — the cross-dispatch uniqueness index -------------
--
--    THE MOST IMPORTANT CHECK IN THIS FILE.
--
--    Must be UNIQUE, on provider_ref alone, and partial on exactly
--    "provider_ref IS NOT NULL". Deliberately NOT partial on resolved_at: a
--    business may be dispatched again after an outcome, but a provider call
--    reference names one real telephone call for ever and may never be rebound.
select i.relname                                    as index_name,
       idx.indisunique                              as is_unique,
       idx.indnatts                                 as column_count,
       pg_get_expr(idx.indpred, idx.indrelid)       as predicate,
       pg_get_indexdef(idx.indexrelid)              as definition,
       case when idx.indisunique
             and idx.indnatts = 1
             and pg_get_expr(idx.indpred, idx.indrelid) = '(provider_ref IS NOT NULL)'
            then 'PASS' else '**FAIL**' end          as verdict
  from pg_index idx
  join pg_class i on i.oid = idx.indexrelid
  join pg_class t on t.oid = idx.indrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public'
   and t.relname = 'acquisition_dial_executions'
   and i.relname = 'idx_acq_dial_exec_provider_ref';


--    The indexed column really is provider_ref, read from the catalogue rather
--    than assumed from the index's name.
select a.attname                                    as indexed_column,
       case when a.attname = 'provider_ref' then 'PASS' else '**FAIL**' end as verdict
  from pg_index idx
  join pg_class i on i.oid = idx.indexrelid
  join pg_class t on t.oid = idx.indrelid
  join pg_attribute a on a.attrelid = t.oid and a.attnum = idx.indkey[0]
 where t.relname = 'acquisition_dial_executions'
   and i.relname = 'idx_acq_dial_exec_provider_ref';


-- -- 2. laq5's own two locks are still there and still correct -------
--    laq6 must not have disturbed them.
select i.relname                                    as index_name,
       idx.indisunique                              as is_unique,
       pg_get_expr(idx.indpred, idx.indrelid)       as predicate,
       case when idx.indisunique
             and pg_get_expr(idx.indpred, idx.indrelid) = '(resolved_at IS NULL)'
            then 'PASS' else '**FAIL**' end          as verdict
  from pg_index idx
  join pg_class i on i.oid = idx.indexrelid
  join pg_class t on t.oid = idx.indrelid
 where t.relname = 'acquisition_dial_executions'
   and i.relname in ('idx_acq_dial_exec_unresolved_prospect',
                     'idx_acq_dial_exec_unresolved_destination')
 order by i.relname;


--    Every index on the table, for the reader. Expect six after laq6: the
--    primary key, laq5's five, plus idx_acq_dial_exec_provider_ref.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename  = 'acquisition_dial_executions'
 order by indexname;


-- -- 3. INVARIANT B — write-once, in the guard function body ---------
--
--    A trigger function's rule is a STATEMENT, not a catalogue row, so this is
--    the one place the body has to be read. It is matched on the stable machine
--    token the migration puts in the exception message, plus the two structural
--    halves of the condition — never on English prose.
select p.proname                                    as function_name,
       l.lanname                                    as language,
       pg_get_function_result(p.oid)                as returns,
       (pg_get_functiondef(p.oid) like '%acq_provider_ref_write_once%')          as has_token,
       (pg_get_functiondef(p.oid) like '%old.provider_ref is not null%')         as has_bound_test,
       (pg_get_functiondef(p.oid) like '%new.provider_ref is distinct from old.provider_ref%') as has_change_test,
       case when l.lanname = 'plpgsql'
             and pg_get_function_result(p.oid) = 'trigger'
             and pg_get_functiondef(p.oid) like '%acq_provider_ref_write_once%'
             and pg_get_functiondef(p.oid) like '%old.provider_ref is not null%'
             and pg_get_functiondef(p.oid) like '%new.provider_ref is distinct from old.provider_ref%'
            then 'PASS' else '**FAIL**' end          as verdict
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language  l on l.oid = p.prolang
 where n.nspname = 'public'
   and p.proname = 'acquisition_dial_exec_guard';


--    laq5's rules must all still be in the replaced body. A migration that
--    dropped one while adding another would pass every check above.
select 'laq5 rules survived the replacement'        as check_name,
       (pg_get_functiondef(p.oid) like '%is not deletable%')            as no_delete,
       (pg_get_functiondef(p.oid) like '%identity is immutable%')       as immutable_identity,
       (pg_get_functiondef(p.oid) like '%cannot be reopened%')          as no_reopen,
       (pg_get_functiondef(p.oid) like '%already terminal%')            as status_forward_only,
       case when pg_get_functiondef(p.oid) like '%is not deletable%'
             and pg_get_functiondef(p.oid) like '%identity is immutable%'
             and pg_get_functiondef(p.oid) like '%cannot be reopened%'
             and pg_get_functiondef(p.oid) like '%already terminal%'
            then 'PASS' else '**FAIL**' end          as verdict
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'acquisition_dial_exec_guard';


-- -- 4. The trigger is attached, BEFORE, ROW-level, and ENABLED ------
--
--    tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE,
--    32 = TRUNCATE, 64 = INSTEAD OF. Bits carry no ordering, which is the whole
--    reason this is not a text match.
--
--    tgenabled is checked because a guard switched off administratively renders
--    an identical definition while firing on nothing.
select rel.relname                                  as table_name,
       tg.tgname                                    as trigger_name,
       case when (tg.tgtype::int &  2) <> 0 then 'BEFORE'
            when (tg.tgtype::int & 64) <> 0 then 'INSTEAD OF'
            else 'AFTER' end                        as timing,
       case when (tg.tgtype::int &  1) <> 0 then 'ROW' else 'STATEMENT' end as level,
       (tg.tgtype::int &  8) <> 0                   as on_delete,
       (tg.tgtype::int & 16) <> 0                   as on_update,
       (tg.tgtype::int &  4) <> 0                   as on_insert,
       tg.tgenabled                                 as enabled_flag,
       p.proname                                    as guard_function,
       case when (tg.tgtype::int &  2) <> 0
             and (tg.tgtype::int &  1) <> 0
             and (tg.tgtype::int &  8) <> 0
             and (tg.tgtype::int & 16) <> 0
             and (tg.tgtype::int &  4)  = 0
             and (tg.tgtype::int & 32)  = 0
             and tg.tgenabled in ('O','A')
             and p.proname = 'acquisition_dial_exec_guard'
            then 'PASS' else '**FAIL**' end          as verdict
  from pg_trigger tg
  join pg_class rel on rel.oid = tg.tgrelid
  join pg_namespace n on n.oid = rel.relnamespace
  join pg_proc  p   on p.oid   = tg.tgfoid
 where n.nspname = 'public'
   and rel.relname = 'acquisition_dial_executions'
   and not tg.tgisinternal;


-- -- 5. RLS unchanged, still no policies -----------------------------
select c.relname                                    as table_name,
       c.relrowsecurity                             as rls_enabled,
       case when c.relrowsecurity then 'PASS' else '**FAIL**' end as verdict
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('acquisition_dial_executions','acquisition_calling_state')
 order by c.relname;

--    Expect NO ROWS.
select tablename, policyname, '**FAIL**: no acquisition table may carry a policy' as verdict
  from pg_policies
 where schemaname = 'public'
   and tablename like 'acquisition\_%';


-- -- 6. The data laq6 must not have touched --------------------------
--
--    Calling state: still exactly one row, still paused, still revision 1.
select scope, state, revision, changed_by,
       case when scope = 'global' and state = 'paused' and revision = 1
            then 'PASS'
            when state = 'enabled' then '**FAIL**: ACQUISITION CALLING IS ENABLED'
            else '**FAIL**' end                      as verdict
  from public.acquisition_calling_state;

--    Dispatch ledger: the E-7B1 proof row, untouched and unresolved.
select dispatch_id, provider, provider_status, provider_ref, resolved_at,
       case when resolved_at is null then 'PASS' else '**FAIL**: a dispatch was resolved' end as verdict
  from public.acquisition_dial_executions
 order by claimed_at;

--    THE PRE-MIGRATION CONDITION, re-checked afterwards. Expect 0 duplicates
--    for ever: if this is ever non-zero the unique index is not doing its job,
--    or was never applied.
select count(*)                                                   as dial_executions,
       count(provider_ref)                                        as non_null_provider_refs,
       count(distinct provider_ref)                               as distinct_provider_refs,
       count(provider_ref) - count(distinct provider_ref)         as duplicate_refs,
       case when count(provider_ref) = count(distinct provider_ref)
            then 'PASS' else '**FAIL**: one provider call is bound to more than one dispatch' end as verdict
  from public.acquisition_dial_executions;


-- -- 7. ROLL-UP ------------------------------------------------------
--    One row. PASS means every structural guarantee laq6 claims is present in
--    THIS database. It still does not mean the guard refuses — see the header.
with checks as (
  select 'invariant A: unique partial index on provider_ref' as check_name,
         (select count(*) from pg_index idx
            join pg_class i on i.oid = idx.indexrelid
            join pg_class t on t.oid = idx.indrelid
           where t.relname = 'acquisition_dial_executions'
             and i.relname = 'idx_acq_dial_exec_provider_ref'
             and idx.indisunique
             and idx.indnatts = 1
             and pg_get_expr(idx.indpred, idx.indrelid) = '(provider_ref IS NOT NULL)') = 1 as ok
  union all
  select 'invariant B: write-once rule present in the guard',
         (select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'acquisition_dial_exec_guard'
             and pg_get_functiondef(p.oid) like '%acq_provider_ref_write_once%'
             and pg_get_functiondef(p.oid) like '%old.provider_ref is not null%'
             and pg_get_functiondef(p.oid) like '%new.provider_ref is distinct from old.provider_ref%') = 1
  union all
  select 'laq5 rules survived the guard replacement',
         (select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'acquisition_dial_exec_guard'
             and pg_get_functiondef(p.oid) like '%is not deletable%'
             and pg_get_functiondef(p.oid) like '%identity is immutable%'
             and pg_get_functiondef(p.oid) like '%cannot be reopened%'
             and pg_get_functiondef(p.oid) like '%already terminal%') = 1
  union all
  select 'laq5 locks still unique and predicated on resolved_at',
         (select count(*) from pg_index idx
            join pg_class i on i.oid = idx.indexrelid
           where i.relname in ('idx_acq_dial_exec_unresolved_prospect','idx_acq_dial_exec_unresolved_destination')
             and idx.indisunique
             and pg_get_expr(idx.indpred, idx.indrelid) = '(resolved_at IS NULL)') = 2
  union all
  select 'guard trigger BEFORE, ROW, UPDATE+DELETE, enabled',
         (select count(*) from pg_trigger tg
            join pg_class rel on rel.oid = tg.tgrelid
            join pg_proc  p   on p.oid   = tg.tgfoid
           where rel.relname = 'acquisition_dial_executions'
             and not tg.tgisinternal
             and (tg.tgtype::int &  2) <> 0
             and (tg.tgtype::int &  1) <> 0
             and (tg.tgtype::int &  8) <> 0
             and (tg.tgtype::int & 16) <> 0
             and tg.tgenabled in ('O','A')
             and p.proname = 'acquisition_dial_exec_guard') = 1
  union all
  select 'no duplicate provider references exist',
         (select count(provider_ref) - count(distinct provider_ref)
            from public.acquisition_dial_executions) = 0
  union all
  select 'RLS still on, still no policies',
         (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'acquisition_dial_executions' and c.relrowsecurity) = 1
         and (select count(*) from pg_policies where schemaname = 'public' and tablename like 'acquisition\_%') = 0
  union all
  select 'calling is still PAUSED at revision 1',
         (select count(*) from public.acquisition_calling_state where state = 'paused' and revision = 1) = 1
)
select count(*)                                  as checks_run,
       count(*) filter (where ok)                as passed,
       count(*) filter (where not ok)            as failed,
       coalesce(string_agg(check_name, ', ') filter (where not ok), '(none)') as failing,
       case when count(*) filter (where not ok) = 0
            then 'PASS: laq6 is structurally intact in this database'
            else '**FAIL**' end                  as verdict
  from checks;
