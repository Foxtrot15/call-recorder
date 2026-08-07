-- ============================================================================
-- M8D STEP 1 — PRE-FLIGHT.  DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- READ-ONLY BY CONSTRUCTION. Every statement below is a bare SELECT. There is
-- no INSERT, UPDATE, DELETE, CREATE, ALTER or DROP anywhere in this file, and
-- no transaction block is needed because nothing here can write.
--
-- Run QUERY A, QUERY B and QUERY C. Paste all three result sets back.
-- Apply NOTHING until the results have been read.
-- ============================================================================


-- ── QUERY A — schema pre-flight ─────────────────────────────────────────────
-- One row per check. Expect PASS on every row except P1.1, which you confirm
-- by eye against the project ref in your Supabase dashboard URL.

select 'P1.1' as id,
       'Database and role' as check_name,
       'DEV project, ref wvwemitmmsdytyutaqbm' as expected,
       current_database() || ' / ' || current_user as actual,
       'CONFIRM BY EYE' as verdict

union all
select 'P1.2',
       'LAQ1 tables present (must be none)',
       '0 of 4',
       (select count(*)::text from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_prospects','acquisition_prospect_phones',
                             'acquisition_evidence','acquisition_decisions')) || ' of 4',
       (select case when count(*) = 0 then 'PASS' else 'STOP' end from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_prospects','acquisition_prospect_phones',
                             'acquisition_evidence','acquisition_decisions'))

union all
select 'P1.3',
       'LAQ2 tables present (must be none)',
       '0 of 4',
       (select count(*)::text from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_suppressions','acquisition_qualifications',
                             'acquisition_call_queue','acquisition_contact_outcomes')) || ' of 4',
       (select case when count(*) = 0 then 'PASS' else 'STOP' end from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_suppressions','acquisition_qualifications',
                             'acquisition_call_queue','acquisition_contact_outcomes'))

union all
-- Catches a partial prior apply that created something not on either list.
select 'P1.4',
       'Any acquisition_* table at all',
       'none',
       (select coalesce(string_agg(tablename, ', ' order by tablename), 'none')
          from pg_tables where schemaname = 'public' and tablename like 'acquisition\_%'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from pg_tables where schemaname = 'public' and tablename like 'acquisition\_%')

union all
-- LAQ1 defines this function. Present without the tables = a partial apply.
select 'P1.5',
       'Function acquisition_refuse_mutation()',
       'absent',
       (select case when count(*) = 0 then 'absent' else 'PRESENT' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'acquisition_refuse_mutation'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'acquisition_refuse_mutation')

union all
-- LAQ1 creates this constraint; LAQ2 widens it. Present = LAQ1 already ran.
select 'P1.6',
       'Constraint acquisition_prospects_lifecycle_check',
       'absent',
       (select case when count(*) = 0 then 'absent' else 'PRESENT' end
          from pg_constraint where conname = 'acquisition_prospects_lifecycle_check'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from pg_constraint where conname = 'acquisition_prospects_lifecycle_check')

union all
-- Every index either migration creates is named idx_acq_*.
select 'P1.7',
       'Indexes named idx_acq_*',
       'none',
       (select coalesce(string_agg(indexname, ', ' order by indexname), 'none')
          from pg_indexes where schemaname = 'public' and indexname like 'idx\_acq\_%'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from pg_indexes where schemaname = 'public' and indexname like 'idx\_acq\_%')

union all
-- Triggers both migrations install.
select 'P1.8',
       'Triggers named acq_*_no_update',
       'none',
       (select coalesce(string_agg(tgname, ', ' order by tgname), 'none')
          from pg_trigger where not tgisinternal and tgname like 'acq\_%'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from pg_trigger where not tgisinternal and tgname like 'acq\_%')

union all
-- gen_random_uuid() backs every primary key default in both files.
select 'P1.9',
       'gen_random_uuid() available',
       'available',
       (select case when count(*) > 0 then 'available' else 'MISSING' end
          from pg_proc where proname = 'gen_random_uuid'),
       (select case when count(*) > 0 then 'PASS' else 'STOP — run: create extension if not exists pgcrypto;' end
          from pg_proc where proname = 'gen_random_uuid')

union all
-- Baseline for §8 of the runbook. Expect this to rise by exactly 8 after both
-- migrations. Write the number down.
select 'P1.10',
       'Baseline public table count',
       'record this number',
       (select count(*)::text from pg_tables where schemaname = 'public'),
       'RECORD'

order by id;


-- ── QUERY B — expected dev tenant state ─────────────────────────────────────
-- Confirms this is the dev project and not production. Dev holds exactly one
-- tenant, 'dev-client', with voip_enabled = true. A production project would
-- show real tenants here — if it does, STOP.

select slug,
       name,
       voip_enabled,
       (auth_user_id is not null) as has_auth_user,
       created_at
  from public.clients
 order by slug;

-- Expect exactly ONE row: dev-client / Dev Client Co / true.


-- ── QUERY C — naming-collision sweep ────────────────────────────────────────
-- Every object kind, every schema, anything whose name begins 'acquisition' or
-- 'acq_'. Expect ZERO ROWS. A hit here is a collision that must be resolved
-- before either migration runs — 'create table if not exists' would silently
-- adopt a pre-existing table of the same name rather than fail.

select n.nspname as schema_name,
       c.relname as object_name,
       case c.relkind
         when 'r' then 'table'      when 'v' then 'view'
         when 'm' then 'matview'    when 'i' then 'index'
         when 'S' then 'sequence'   when 'p' then 'partitioned table'
         when 'c' then 'composite type'
         else c.relkind::text
       end as object_kind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog','information_schema')
   and (c.relname like 'acquisition%' or c.relname like 'acq\_%')

union all

select n.nspname,
       p.proname,
       'function'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog','information_schema')
   and (p.proname like 'acquisition%' or p.proname like 'acq\_%')

union all

select n.nspname,
       t.typname,
       'type'
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
 where n.nspname not in ('pg_catalog','information_schema')
   and (t.typname like 'acquisition%' or t.typname like 'acq\_%')

order by schema_name, object_name;

-- Expect ZERO ROWS.
-- ============================================================================
