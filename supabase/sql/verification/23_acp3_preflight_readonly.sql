-- ACP3 PREFLIGHT — read-only. Run BEFORE acp3_create_provisioning_executions.sql.
--
-- Nothing here writes. Raw material, not a computed verdict (the LPM4 lesson).
--
-- EXPECTED BEFORE APPLYING: 1 to 3 return ZERO rows, 4 returns context,
-- 5 returns one row.

-- 1. Do the tables already exist? Expect ZERO rows.
select tablename from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_provisioning_executions','platform_action_executions');

-- 2. Do any of the names collide with anything? Expect ZERO rows.
select c.relname, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'platform_provisioning_executions','platform_action_executions',
     'pex_one_unresolved_per_client','pex_by_client_started','pex_by_plan',
     'pae_one_unresolved_per_action','pae_by_execution','pae_by_request_id','pae_unresolved'
   );

-- 3. Do the trigger functions already exist? Expect ZERO rows.
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('pae_guard_identity','pex_refuse_delete');

-- 4. CONTEXT: ACP1 and ACP2 should be applied first. ACP3 references neither,
--    so this is context rather than a hard gate — but an execution record with
--    no plan to point at is of limited use.
select tablename from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_provisioning_plans');

-- 5. gen_random_uuid() must exist. Expect 1 row.
select proname from pg_proc where proname = 'gen_random_uuid' limit 1;

-- 6. CONTEXT: provider_resources is the registry the executor writes to, and
--    ACP3 does not alter it. Confirm the one-active index is still there.
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'pr_one_active_per_purpose';
