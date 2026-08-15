-- ===========================================================================
-- 17 - LPM4 VERIFIER, AS ONE RESULT SET. READ-ONLY.
--
-- WHY THIS EXISTS. File 16 asks the same questions across eleven statements,
-- and the Supabase SQL editor displays only the result of the LAST statement
-- when a script is run as a batch. So the verifier ran in full and showed a
-- single row - the sentinel collision check - which passes whether or not LPM4
-- was applied. A verifier whose decisive answers are invisible verifies nothing.
--
-- There is no apostrophe anywhere in this file, in code or comment. That is
-- deliberate after a paste corrupted the quoting in file 16.
--
-- This is ONE statement. Every check is a row, ordered, in one grid.
--
-- ASCII only, no reserved-word aliases, no semicolon inside any string, and
-- every column cast to text so the branches of the union agree on type.
--
-- Contains no INSERT, UPDATE, DELETE, TRUNCATE, CREATE, DROP or ALTER.
-- ===========================================================================

with def as (
  select pg_get_constraintdef(c.oid) as d
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'provider_resources'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%purpose%'
     and pg_get_constraintdef(c.oid) like '%onboarding_agent%'
   limit 1
),
named as (
  select pg_get_constraintdef(c.oid) as d
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'provider_resources'
     and c.conname = 'provider_resources_purpose_check'
   limit 1
),
purpose_checks as (
  select count(*) as n
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'provider_resources'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%purpose%'
     and pg_get_constraintdef(c.oid) like '%onboarding_agent%'
),
vals (expected) as (
  values ('acquisition_agent'),
         ('acquisition_response_engine'),
         ('inbound_binding'),
         ('onboarding_agent'),
         ('onboarding_analysis'),
         ('receptionist_agent'),
         ('receptionist_analysis'),
         ('receptionist_knowledge')
)
select 1 as seq,
       'acquisition purposes permitted' as check_name,
       (case when (select d from def) like '%acquisition_agent%'
              and (select d from def) like '%acquisition_response_engine%'
             then '1' else '0' end) as found,
       (case when (select d from def) like '%acquisition_agent%'
              and (select d from def) like '%acquisition_response_engine%'
             then 'PASS' else 'FAIL - LPM4 did not take effect' end) as verdict

union all
select 2,
       'value present: ' || v.expected,
       (case when (select d from def) like '%' || v.expected || '%' then '1' else '0' end),
       (case when (select d from def) like '%' || v.expected || '%' then 'PASS' else 'FAIL - value lost' end)
  from vals v

union all
select 3,
       'purpose CHECK count',
       (select n::text from purpose_checks),
       (case when (select n from purpose_checks) = 1 then 'PASS'
             else 'FAIL - duplicate or orphaned constraint remains' end)

union all
select 4,
       'constraint named provider_resources_purpose_check',
       (case when (select d from named) is null then '0' else '1' end),
       (case when (select d from named) is null
             then 'FAIL - LPM4 did not add its constraint' else 'PASS' end)

union all
select 5,
       'pr_idempotency_key still present',
       (select count(*)::text from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'provider_resources'
          and c.conname = 'pr_idempotency_key'),
       (case when (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and t.relname = 'provider_resources'
                     and c.conname = 'pr_idempotency_key') = 1
             then 'PASS' else 'FAIL - missing' end)

union all
select 6,
       'pr_superseded_consistency still present',
       (select count(*)::text from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname = 'provider_resources'
          and c.conname = 'pr_superseded_consistency'),
       (case when (select count(*) from pg_constraint c
                    join pg_class t on t.oid = c.conrelid
                    join pg_namespace n on n.oid = t.relnamespace
                   where n.nspname = 'public' and t.relname = 'provider_resources'
                     and c.conname = 'pr_superseded_consistency') = 1
             then 'PASS' else 'FAIL - missing' end)

union all
select 7,
       'pr_one_active_per_purpose index',
       (select count(*)::text from pg_indexes
        where schemaname = 'public' and tablename = 'provider_resources'
          and indexname = 'pr_one_active_per_purpose'),
       (case when (select count(*) from pg_indexes
                   where schemaname = 'public' and tablename = 'provider_resources'
                     and indexname = 'pr_one_active_per_purpose') = 1
             then 'PASS - still the one-agent guard' else 'FAIL - the guard is gone' end)

union all
select 8,
       'rls enabled',
       (select coalesce(bool_and(rowsecurity), false)::text from pg_tables
        where schemaname = 'public' and tablename = 'provider_resources'),
       (case when (select coalesce(bool_and(rowsecurity), false) from pg_tables
                   where schemaname = 'public' and tablename = 'provider_resources')
             then 'PASS' else 'FAIL' end)

union all
select 9,
       'policy count',
       (select count(*)::text from pg_policies
        where schemaname = 'public' and tablename = 'provider_resources'),
       (case when (select count(*) from pg_policies
                   where schemaname = 'public' and tablename = 'provider_resources') = 0
             then 'PASS - service_role only' else 'FAIL' end)

union all
select 10,
       'total rows',
       (select count(*)::text from public.provider_resources),
       (case when (select count(*) from public.provider_resources) = 0
             then 'PASS - LPM4 creates no row' else 'ATTENTION - rows exist' end)

union all
select 11,
       'acquisition rows',
       (select count(*)::text from public.provider_resources
        where purpose in ('acquisition_agent','acquisition_response_engine')),
       (case when (select count(*) from public.provider_resources
                   where purpose in ('acquisition_agent','acquisition_response_engine')) = 0
             then 'PASS - expected until an agent is created'
             else 'ATTENTION - an acquisition resource is recorded' end)

union all
select 12,
       'reserved slug collision',
       (select count(*)::text from public.clients where slug = 'aida-acquisition'),
       (case when (select count(*) from public.clients where slug = 'aida-acquisition') = 0
             then 'PASS' else 'ATTENTION - a real client uses the reserved slug' end)

union all
select 13,
       'full purpose CHECK definition',
       '-',
       coalesce((select d from def), 'NONE FOUND')

order by seq, check_name;
