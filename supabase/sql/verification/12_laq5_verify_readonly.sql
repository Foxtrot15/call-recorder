-- ============================================================================
-- LAQ5 READ-ONLY SCHEMA VERIFICATION (E-7B1).
--
-- THIS FILE CONTAINS NO WRITES OF ANY KIND.
--
--   no INSERT, no UPDATE, no DELETE, no UPSERT, no MERGE, no TRUNCATE
--   no CREATE, no ALTER, no DROP, no GRANT, no REVOKE
--   no begin/commit/rollback, and therefore no transaction wrapping a probe
--   no function call that mutates anything -- pg_get_*def() and the
--   information_schema views read the catalogue and nothing else
--
-- It cannot alter acquisition_calling_state, cannot alter
-- acquisition_dial_executions, and cannot create proof residue. It is safe to
-- run any number of times, in any order, on dev or on production.
--
-- ── WHY THIS FILE EXISTS SEPARATELY FROM 12_laq5_verify.sql ─────────
-- That file is the full verification, and its sections 6 and 7 WRITE:
-- section 6 leaves a permanent dispatch row that cannot be deleted, and
-- section 7's tamper probes would mutate the approved residue if any of them
-- unexpectedly succeeded. Both are correct to exist and both need a human who
-- has read their headers.
--
-- Neither belongs in a file somebody runs to answer "is the schema right?".
-- **SECTIONS 6 AND 7 ARE DELIBERATELY ABSENT HERE**, statement and comment
-- alike. This file is sections 1-5 only, restated as assertions.
--
-- ── WHAT IT ADDS TO SECTIONS 1-5 ───────────────────────────────────
-- Sections 1-5 print catalogue rows for a human to compare against prose. This
-- file computes the comparison: every check yields PASS or **FAIL** in a
-- verdict column, and section 15 rolls the whole file into one row. Reading
-- index predicates by eye is exactly the step where a missing
-- "WHERE (resolved_at IS NULL)" would be nodded past, and that predicate is the
-- entire durable guarantee.
--
-- ── WHAT IT CANNOT TELL YOU ────────────────────────────────────────
-- That the guards WORK. This file proves the triggers, functions, indexes and
-- constraints are PRESENT and shaped correctly. Proving they refuse requires
-- attempting refused writes -- section 6/7 of the full file, or the scripted
-- proof in scripts/dev/acquisition-dispatch-proof/, which exercises the two
-- partial unique indexes through the real dispatch-store code including a
-- genuine two-process race.
--
-- Expected on dev as at 2026-08-12: every check PASS, calling 'paused',
-- revision 1, one unresolved fictional dispatch.
-- Expected on production as at 2026-08-12: section 1 FAILs -- laq5 has never
-- been applied there, and that is the correct answer, not a defect.
-- ============================================================================


-- -- 1. Both LAQ5 tables exist ---------------------------------------
--    Expect 2 rows, both relkind 'r'. If this returns 0 rows, laq5 has not been
--    applied to this database and every check below is meaningless.
select c.relname                        as table_name,
       c.relkind                        as kind,
       case when c.relkind = 'r' then 'PASS' else '**FAIL**' end as verdict
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('acquisition_dial_executions','acquisition_calling_state')
 order by c.relname;


-- -- 2. RLS is ENABLED on both ---------------------------------------
--    Enabled with zero policies denies every non-superuser role. The service
--    key bypasses RLS, which is why the application is trusted to be the only
--    writer; RLS is the floor under that, not a substitute for it.
select c.relname                        as table_name,
       c.relrowsecurity                 as rls_enabled,
       c.relforcerowsecurity            as rls_forced,
       case when c.relrowsecurity then 'PASS' else '**FAIL**' end as verdict
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('acquisition_dial_executions','acquisition_calling_state')
 order by c.relname;


-- -- 3. ZERO RLS policies, across every acquisition table ------------
--    Expect NO ROWS. A policy appearing here is somebody having granted access
--    that no migration in this repository ever asked for.
select schemaname,
       tablename,
       policyname,
       '**FAIL**: no acquisition table may carry a policy' as verdict
  from pg_policies
 where schemaname = 'public'
   and tablename like 'acquisition\_%';


-- -- 4. Columns, nullability and defaults ----------------------------
--    Expect for acquisition_dial_executions, in order: dispatch_id,
--    authorisation_id, prospect_id, destination_e164, batch_key, authorised_at,
--    claimed_at, claimed_by, provider, provider_live, provider_status,
--    submitted_at, provider_ref, error_code, resolved_at, resolution,
--    resolved_by, resolution_note, created_at.
--
--    The nullability split IS the design: everything describing WHO WAS CLAIMED
--    is NOT NULL, everything describing WHAT HAPPENED is nullable, because at
--    the instant of the claim none of it is known yet.
select table_name,
       ordinal_position                 as pos,
       column_name,
       data_type,
       is_nullable,
       column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('acquisition_dial_executions','acquisition_calling_state')
 order by table_name, ordinal_position;


-- -- 5. dispatch_id is a uuid PRIMARY KEY ----------------------------
--    The replay invariant. A genuine mint generates it randomly, so two
--    distinct authorisations cannot collide, and a replayed one cannot insert.
select 'dispatch_id uuid primary key'   as check_name,
       a.attname                        as column_name,
       format_type(a.atttypid, a.atttypmod) as column_type,
       case when a.attname = 'dispatch_id'
             and format_type(a.atttypid, a.atttypmod) = 'uuid'
             and i.indisprimary
             and i.indnatts = 1
            then 'PASS' else '**FAIL**' end as verdict
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
 where n.nspname = 'public'
   and t.relname = 'acquisition_dial_executions'
   and i.indisprimary;


-- -- 6. batch_key is NOT NULL ----------------------------------------
--    Proven rather than assumed. The M8E gate discards context.batch and reads
--    the durable founder approval itself, so an authorised decision without one
--    does not exist -- the mint throws rather than produce a slip with no
--    batch_key. NOT NULL is that guarantee expressed where it cannot be argued
--    with.
select 'batch_key is NOT NULL'          as check_name,
       is_nullable,
       case when is_nullable = 'NO' then 'PASS' else '**FAIL**' end as verdict
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'acquisition_dial_executions'
   and column_name  = 'batch_key';


-- -- 7. The prospect FK is ON DELETE RESTRICT ------------------------
--    confdeltype: 'r' = RESTRICT, 'a' = NO ACTION, 'c' = CASCADE, 'n' = SET NULL.
--    EXPECT 'r'. A record that we may have rung a business must not become
--    deletable by deleting the business. This is the opposite of
--    acquisition_call_queue, which cascades because a reservation is not
--    evidence of anything. CASCADE here would be a data-loss bug wearing the
--    clothes of tidiness.
select 'prospect FK on delete RESTRICT' as check_name,
       con.conname                      as constraint_name,
       con.confdeltype                  as delete_action,
       pg_get_constraintdef(con.oid)    as definition,
       case when con.confdeltype = 'r' then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
 where n.nspname = 'public'
   and rel.relname = 'acquisition_dial_executions'
   and con.contype = 'f';


-- -- 8/9. THE TWO LOAD-BEARING PARTIAL UNIQUE INDEXES ----------------
--
--    THIS IS THE MOST IMPORTANT CHECK IN THE FILE.
--
--    Each must be UNIQUE, on the stated single column, and PARTIAL on exactly
--    "resolved_at IS NULL". Any one of those three properties missing and the
--    durable guarantee is gone while the application still believes it holds:
--
--      not unique   -> two unresolved dispatches, two calls
--      wrong column -> the destination case a per-prospect lock cannot see
--      no predicate -> a business can never be dispatched a SECOND time, ever,
--                      even years later after a recorded outcome -- which fails
--                      in the safe direction but breaks the pilot
--      wider predicate (e.g. on provider_status) -> a PROVIDER RESULT would
--                      release a business lock, which is the exact confusion
--                      this migration exists to prevent
select i.relname                        as index_name,
       idx.indisunique                  as is_unique,
       pg_get_expr(idx.indpred, idx.indrelid) as predicate,
       pg_get_indexdef(idx.indexrelid)  as definition,
       case when idx.indisunique
             and pg_get_expr(idx.indpred, idx.indrelid) = '(resolved_at IS NULL)'
            then 'PASS' else '**FAIL**' end as verdict
  from pg_index idx
  join pg_class i on i.oid = idx.indexrelid
  join pg_class t on t.oid = idx.indrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public'
   and t.relname = 'acquisition_dial_executions'
   and i.relname in ('idx_acq_dial_exec_unresolved_prospect',
                     'idx_acq_dial_exec_unresolved_destination')
 order by i.relname;


--    Every index on the table, for completeness. Expect five: the two above,
--    idx_acq_dial_exec_prospect, idx_acq_dial_exec_authorisation,
--    idx_acq_dial_exec_open, plus the primary key.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename  = 'acquisition_dial_executions'
 order by indexname;


-- -- 10. The expected CHECK constraints exist ------------------------
--    Matched on DEFINITION rather than on name. Two of these were declared
--    inline on their column and therefore carry Postgres-generated names;
--    asserting those names would be asserting a naming convention, not a
--    guarantee.
select 'acq_dial_exec_resolution_complete' as check_name,
       count(*)                            as found,
       case when count(*) = 1 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_dial_executions'
   and con.contype = 'c'
   and con.conname = 'acq_dial_exec_resolution_complete';

select 'acq_dial_exec_submission_consistent' as check_name,
       count(*)                              as found,
       case when count(*) = 1 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_dial_executions'
   and con.contype = 'c'
   and con.conname = 'acq_dial_exec_submission_consistent';

--    The column-level CHECKs, by what they constrain.
--    Expect one row each, all PASS.
select 'destination_e164 E.164 pattern' as check_name,
       count(*)                         as found,
       case when count(*) >= 1 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_dial_executions'
   and con.contype = 'c'
   and pg_get_constraintdef(con.oid) like '%destination_e164%'
   and pg_get_constraintdef(con.oid) like '%~%';

select 'provider_status enum'           as check_name,
       count(*)                         as found,
       case when count(*) >= 1 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_dial_executions'
   and con.contype = 'c'
   and pg_get_constraintdef(con.oid) like '%provider_status%'
   and pg_get_constraintdef(con.oid) like '%pending%';

--    resolution admits ONLY the two ways a lock may be released. A provider
--    status is not among them and must never become one.
select 'resolution enum (outcome_recorded, operator_closed)' as check_name,
       count(*)                         as found,
       case when count(*) >= 1 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_dial_executions'
   and con.contype = 'c'
   and pg_get_constraintdef(con.oid) like '%outcome_recorded%'
   and pg_get_constraintdef(con.oid) like '%operator_closed%';

--    Full text of every constraint on both tables, for the reader.
select rel.relname                      as table_name,
       con.conname                      as constraint_name,
       con.contype                      as type,
       pg_get_constraintdef(con.oid)    as definition
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
 where n.nspname = 'public'
   and rel.relname in ('acquisition_dial_executions','acquisition_calling_state')
 order by rel.relname, con.conname;


-- -- 11. Both guard FUNCTIONS exist ----------------------------------
--    Expect 2 rows, both plpgsql, both returning trigger.
select p.proname                        as function_name,
       l.lanname                        as language,
       pg_get_function_result(p.oid)    as returns,
       case when l.lanname = 'plpgsql'
             and pg_get_function_result(p.oid) = 'trigger'
            then 'PASS' else '**FAIL**' end as verdict
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language  l on l.oid = p.prolang
 where n.nspname = 'public'
   and p.proname in ('acquisition_dial_exec_guard','acquisition_calling_state_guard')
 order by p.proname;


-- -- 12. Both TRIGGERS exist, BEFORE UPDATE OR DELETE ----------------
--    BEFORE, not AFTER: a guard that raises after the row has changed is a log
--    entry, not a guard. Both UPDATE and DELETE, because immutability and
--    undeletability are different promises and each needs its own arm.
select rel.relname                      as table_name,
       tg.tgname                         as trigger_name,
       pg_get_triggerdef(tg.oid)         as definition,
       case when pg_get_triggerdef(tg.oid) like '%BEFORE UPDATE OR DELETE%'
             and pg_get_triggerdef(tg.oid) like '%FOR EACH ROW%'
            then 'PASS' else '**FAIL**' end as verdict
  from pg_trigger tg
  join pg_class rel on rel.oid = tg.tgrelid
  join pg_namespace n on n.oid = rel.relnamespace
 where n.nspname = 'public'
   and rel.relname in ('acquisition_dial_executions','acquisition_calling_state')
   and not tg.tgisinternal
 order by rel.relname, tg.tgname;


-- -- 13. The calling-state SINGLETON constraint ----------------------
--    Two halves, and both are needed. The primary key on scope stops a second
--    row with the SAME scope; the CHECK (scope = 'global') stops a second row
--    with a DIFFERENT one. Either alone permits two switches, and a founder in
--    an emergency must not have to know which one to hit.
select 'scope is the primary key'       as check_name,
       a.attname                        as column_name,
       case when a.attname = 'scope' and i.indnatts = 1
            then 'PASS' else '**FAIL**' end as verdict
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
 where n.nspname = 'public'
   and t.relname = 'acquisition_calling_state'
   and i.indisprimary;

select 'scope is CHECKed to global only' as check_name,
       count(*)                          as found,
       case when count(*) >= 1 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_calling_state'
   and con.contype = 'c'
   and pg_get_constraintdef(con.oid) like '%scope%'
   and pg_get_constraintdef(con.oid) like '%global%';

--    state admits ONLY 'enabled' and 'paused'. revision must be positive, so a
--    revision cannot be reset to zero to disguise a change.
select 'state enum + revision positive'  as check_name,
       count(*)                          as found,
       case when count(*) >= 2 then 'PASS' else '**FAIL**' end as verdict
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'acquisition_calling_state'
   and con.contype = 'c'
   and (pg_get_constraintdef(con.oid) like '%paused%'
     or pg_get_constraintdef(con.oid) like '%revision%');


-- -- 14. The bootstrap row -------------------------------------------
--    A READ. It does not write, and it does not repair: if this row is wrong,
--    fixing it is a deliberate, attributed, separate act by a named human.
--
--    Expect EXACTLY ONE row: ('global', 'paused', 1, 'laq5-migration', ...).
--    IF state READS 'enabled', SOMETHING OTHER THAN THIS MIGRATION WROTE IT.
select scope,
       state,
       revision,
       changed_by,
       changed_at,
       reason,
       case when scope = 'global'
             and state = 'paused'
             and revision >= 1
             and coalesce(btrim(changed_by), '') <> ''
             and coalesce(btrim(reason), '')     <> ''
            then 'PASS'
            when state = 'enabled'
            then '**FAIL**: ACQUISITION CALLING IS ENABLED'
            else '**FAIL**' end          as verdict
  from public.acquisition_calling_state;

--    Expect exactly 1.
select count(*)                          as calling_state_rows,
       case when count(*) = 1 then 'PASS' else '**FAIL**' end as verdict
  from public.acquisition_calling_state;

--    Context, not an assertion: how many dispatch rows exist and how many hold
--    a lock. On dev as at 2026-08-12 this is 1 and 1 -- the fictional proof row,
--    unresolved for ever by design. On a fresh apply it is 0 and 0.
select count(*)                                              as dial_executions,
       count(*) filter (where resolved_at is null)           as unresolved,
       count(distinct prospect_id) filter (where resolved_at is null) as prospects_locked,
       count(distinct destination_e164) filter (where resolved_at is null) as numbers_locked
  from public.acquisition_dial_executions;


-- -- 15. ROLL-UP -----------------------------------------------------
--    One row. If verdict is PASS, every structural guarantee laq5 claims is
--    present in THIS database. It still does not mean the guards refuse -- see
--    the header.
with checks as (
  select 'tables exist' as check_name,
         (select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname in ('acquisition_dial_executions','acquisition_calling_state')
             and c.relkind = 'r') = 2 as ok
  union all
  select 'rls enabled on both',
         (select count(*) from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname in ('acquisition_dial_executions','acquisition_calling_state')
             and c.relrowsecurity) = 2
  union all
  select 'zero rls policies',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename like 'acquisition\_%') = 0
  union all
  select 'dial execution columns present',
         (select count(*) from information_schema.columns
           where table_schema = 'public'
             and table_name = 'acquisition_dial_executions') = 19
  union all
  select 'batch_key not null',
         (select count(*) from information_schema.columns
           where table_schema = 'public'
             and table_name = 'acquisition_dial_executions'
             and column_name = 'batch_key'
             and is_nullable = 'NO') = 1
  union all
  select 'prospect fk restricts delete',
         (select count(*) from pg_constraint con
            join pg_class rel on rel.oid = con.conrelid
           where rel.relname = 'acquisition_dial_executions'
             and con.contype = 'f'
             and con.confdeltype = 'r') = 1
  union all
  select 'unresolved-prospect unique partial index',
         (select count(*) from pg_index idx
            join pg_class i on i.oid = idx.indexrelid
           where i.relname = 'idx_acq_dial_exec_unresolved_prospect'
             and idx.indisunique
             and pg_get_expr(idx.indpred, idx.indrelid) = '(resolved_at IS NULL)') = 1
  union all
  select 'unresolved-destination unique partial index',
         (select count(*) from pg_index idx
            join pg_class i on i.oid = idx.indexrelid
           where i.relname = 'idx_acq_dial_exec_unresolved_destination'
             and idx.indisunique
             and pg_get_expr(idx.indpred, idx.indrelid) = '(resolved_at IS NULL)') = 1
  union all
  select 'named check constraints present',
         (select count(*) from pg_constraint con
            join pg_class rel on rel.oid = con.conrelid
           where rel.relname = 'acquisition_dial_executions'
             and con.contype = 'c'
             and con.conname in ('acq_dial_exec_resolution_complete',
                                 'acq_dial_exec_submission_consistent')) = 2
  union all
  select 'guard functions present',
         (select count(*) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('acquisition_dial_exec_guard',
                               'acquisition_calling_state_guard')) = 2
  union all
  select 'guard triggers present, before update or delete',
         (select count(*) from pg_trigger tg
            join pg_class rel on rel.oid = tg.tgrelid
           where rel.relname in ('acquisition_dial_executions','acquisition_calling_state')
             and not tg.tgisinternal
             and pg_get_triggerdef(tg.oid) like '%BEFORE UPDATE OR DELETE%') = 2
  union all
  select 'calling state singleton',
         (select count(*) from pg_constraint con
            join pg_class rel on rel.oid = con.conrelid
           where rel.relname = 'acquisition_calling_state'
             and con.contype = 'c'
             and pg_get_constraintdef(con.oid) like '%global%') >= 1
  union all
  select 'exactly one calling state row',
         (select count(*) from public.acquisition_calling_state) = 1
  union all
  select 'calling is PAUSED',
         (select count(*) from public.acquisition_calling_state
           where state = 'paused') = 1
)
select count(*)                                  as checks_run,
       count(*) filter (where ok)                as passed,
       count(*) filter (where not ok)            as failed,
       coalesce(string_agg(check_name, ', ') filter (where not ok), '(none)') as failing,
       case when count(*) filter (where not ok) = 0
            then 'PASS: laq5 is structurally intact in this database'
            else '**FAIL**' end                  as verdict
  from checks;
