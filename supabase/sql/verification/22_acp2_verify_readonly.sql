-- ACP2 POST-VERIFY — read-only. Run AFTER acp2_create_platform_provisioning_plans.sql.
--
-- Proves the invariants exist in the DATABASE, not merely in a file somebody
-- believes was applied. Nothing here writes.
--
-- WHAT "PASS" LOOKS LIKE
--   1  one row, rowsecurity = t
--   2  0
--   3  four index names, including ppp_one_open_plan_per_client
--   4  the partial index definition, containing WHERE ... status = ANY (...draft, validated, approved...)
--   5  ~10 check constraints
--   6  two triggers
--   7  0 rows (no credential-shaped column)
--   8  0 (the migration creates no rows)
--   9  0 rows — no client has two open plans
--  10  0 rows — no approval that does not bind its body
--  11  0 rows — NOTHING HAS EVER BEEN EXECUTED
--  12  0 rows — no plan claims to be a no-op while carrying mutations
--  13  one row — the plan-id uniqueness that scopes plans to a tenant

-- 1. Table exists, RLS is on.
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename = 'platform_provisioning_plans';

-- 2. ZERO policies. Service-role only. A non-zero answer means a browser may
--    be able to read what AIDA is about to change at a provider.
select count(*) as policy_count from pg_policies
 where schemaname = 'public' and tablename = 'platform_provisioning_plans';

-- 3. Indexes.
select indexname from pg_indexes
 where schemaname = 'public' and tablename = 'platform_provisioning_plans'
 order by indexname;

-- 4. THE ONE-OPEN-PLAN AUTHORITY.
select indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'ppp_one_open_plan_per_client';

-- 5. Check constraints.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.platform_provisioning_plans'::regclass and contype = 'c'
 order by conname;

-- 6. Triggers — frozen after approval, and no delete.
select t.tgname from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'platform_provisioning_plans'
   and not t.tgisinternal
 order by t.tgname;

-- 7. No credential-shaped column. Expect ZERO rows.
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'platform_provisioning_plans'
   and (column_name ilike '%api_key%' or column_name ilike '%secret%'
        or column_name ilike '%token%' or column_name ilike '%password%'
        or column_name ilike '%credential%');

-- 8. The migration creates no rows.
select count(*) as plan_rows from public.platform_provisioning_plans;

-- ── Invariant probes. Every one must return ZERO rows, at any time. ──

-- 9. Two open plans for one client.
select client_id, count(*) as open_plans
  from public.platform_provisioning_plans
 where status in ('draft','validated','approved')
 group by client_id having count(*) > 1;

-- 10. An approval that does not bind the body it approved.
select client_id, plan_id, status
  from public.platform_provisioning_plans
 where approved_plan_hash is not null and approved_plan_hash <> plan_hash;

-- 11. THE ONE THAT MATTERS MOST WHILE NO EXECUTOR EXISTS.
--     Any row here means something executed a provider mutation.
select client_id, plan_id, status, execution_state, executed_at, executed_by
  from public.platform_provisioning_plans
 where execution_state is not null or executed_at is not null;

-- 12. A plan claiming to be a no-op while carrying mutations.
select client_id, plan_id from public.platform_provisioning_plans
 where is_no_op = true and mutating_count > 0;

-- 13. Tenant-scoped plan identity.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.platform_provisioning_plans'::regclass and contype = 'u';

-- 14. CONFIRM provider_resources WAS NOT TOUCHED by ACP2. Its purpose CHECK
--     should be exactly what LPM3+LPM4 left, with no platform additions.
select pg_get_constraintdef(oid) as purpose_check
  from pg_constraint
 where conrelid = 'public.provider_resources'::regclass
   and contype = 'c'
   and pg_get_constraintdef(oid) ilike '%purpose%';
