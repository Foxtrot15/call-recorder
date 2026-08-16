-- ACP3 POST-VERIFY — read-only. Run AFTER acp3_create_provisioning_executions.sql.
--
-- Nothing here writes.
--
-- WHAT "PASS" LOOKS LIKE
--   1  two rows, rowsecurity = t on both
--   2  0
--   3  nine index names
--   4  the pae_one_unresolved_per_action definition, listing claimed,
--      provider_succeeded, unknown and persist_failed_after_provider_success
--   5  the pex_one_unresolved_per_client definition
--   6  ~12 check constraints across both tables
--   7  three triggers
--   8  0 rows (no credential-shaped column)
--   9  0 and 0 — NOTHING HAS EVER BEEN EXECUTED
--  10  0 rows — no client has two unresolved executions
--  11  0 rows — no action_key has two unresolved actions
--  12  0 rows — no success without a provider resource id
--  13  0 rows — no UNKNOWN without a stated reason

select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_provisioning_executions','platform_action_executions')
 order by tablename;

select count(*) as policy_count from pg_policies
 where schemaname = 'public'
   and tablename in ('platform_provisioning_executions','platform_action_executions');

select tablename, indexname from pg_indexes
 where schemaname = 'public'
   and tablename in ('platform_provisioning_executions','platform_action_executions')
 order by tablename, indexname;

-- THE NO-SECOND-AGENT GUARD.
select indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'pae_one_unresolved_per_action';

select indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'pex_one_unresolved_per_client';

select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in ('public.platform_provisioning_executions'::regclass,
                    'public.platform_action_executions'::regclass)
   and contype = 'c'
 order by 1, 2;

select c.relname as table_name, t.tgname
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('platform_provisioning_executions','platform_action_executions')
   and not t.tgisinternal
 order by c.relname, t.tgname;

select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('platform_provisioning_executions','platform_action_executions')
   and (column_name ilike '%api_key%' or column_name ilike '%secret%'
        or column_name ilike '%token%' or column_name ilike '%password%'
        or column_name ilike '%credential%');

-- ── THE PROBE THAT MATTERS MOST ──
-- Any row here means a provider was contacted.
select (select count(*) from public.platform_provisioning_executions) as executions,
       (select count(*) from public.platform_action_executions)       as action_executions;

-- ── Invariant probes. Every one must return ZERO rows, at any time. ──

select client_id, count(*) as unresolved
  from public.platform_provisioning_executions
 where status in ('claimed','unknown','manual_reconciliation_required')
 group by client_id having count(*) > 1;

select client_id, action_key, count(*) as unresolved
  from public.platform_action_executions
 where status in ('claimed','provider_succeeded','unknown','persist_failed_after_provider_success')
 group by client_id, action_key having count(*) > 1;

select client_id, action_key, status
  from public.platform_action_executions
 where status in ('provider_succeeded','completed','persist_failed_after_provider_success')
   and provider_resource_id is null;

select client_id, action_key
  from public.platform_action_executions
 where status = 'unknown' and ambiguity_reason is null;

-- CONFIRM ACP3 DID NOT TOUCH provider_resources.
select indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'pr_one_active_per_purpose';
