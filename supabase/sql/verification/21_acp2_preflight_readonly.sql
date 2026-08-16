-- ACP2 PREFLIGHT — read-only. Run BEFORE acp2_create_platform_provisioning_plans.sql.
--
-- Nothing here writes. Raw material, not a computed verdict (the LPM4 lesson).
--
-- EXPECTED BEFORE APPLYING: 1 → 0 rows, 2 → 0 rows, 3 → 0 rows,
-- 4 → whatever exists (context), 5 → 1 row, 6 → context.

-- 1. Does the table already exist? Expect ZERO rows.
select tablename from pg_tables
 where schemaname = 'public' and tablename = 'platform_provisioning_plans';

-- 2. Do any of the names collide with anything? Expect ZERO rows.
select c.relname, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'platform_provisioning_plans',
     'ppp_one_open_plan_per_client','ppp_by_client_created',
     'ppp_by_config_version','ppp_by_plan_hash'
   );

-- 3. Do the trigger functions already exist? Expect ZERO rows.
--    `create or replace function` would silently overwrite somebody else's.
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('ppp_guard_approved_plans','ppp_refuse_delete');

-- 4. ACP1 should be applied first. Context, not a hard gate — ACP2 references
--    no ACP1 table, but a plan without a durable configuration to bind to is
--    of limited use.
select tablename from pg_tables
 where schemaname = 'public' and tablename in ('platform_config_versions','platform_config_events');

-- 5. gen_random_uuid() must exist. Expect 1 row.
select proname from pg_proc where proname = 'gen_random_uuid' limit 1;

-- 6. CONTEXT: the table ACP2 deliberately does NOT reuse, and why. Confirm it
--    is still locksmith-onboarding-shaped before accepting that reasoning.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'provisioning_plans'
   and column_name in ('approved_profile_version','session_id',
                       'receptionist_template_version','onboarding_template_version')
 order by column_name;

-- 7. CONTEXT: provider_resources is reused UNCHANGED. Confirm the existing
--    purposes cover receptionist work, so ACP2 needs no widening of it.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.provider_resources'::regclass
   and contype = 'c'
   and pg_get_constraintdef(oid) ilike '%purpose%';
