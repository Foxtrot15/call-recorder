-- ACP1 PREFLIGHT — read-only. Run BEFORE applying acp1_create_client_configuration.sql.
--
-- Answers one question: is it safe to apply, and will it collide with anything?
--
-- Nothing here writes. No begin/commit, no DDL, no DML.
--
-- LPM4 TRANSPORT LESSON: this returns RAW MATERIAL, not a computed verdict.
-- A 6.6KB verdict block failed three times — the editor showed only the last
-- result set, em-dashes corrupted quoting on paste, and the whole thing was too
-- large. Small queries whose output a person can read beat one clever query
-- whose output a person must trust.
--
-- EXPECTED BEFORE APPLYING: query 1 returns 0 rows, query 2 returns 0 rows,
-- query 3 returns 0 rows, query 4 returns whatever clients exist.

-- 1. Do the tables already exist? Expect ZERO rows on a first apply.
--    Any row means this migration has been applied before — STOP and check
--    whether the definition matches before running it again.
select tablename
  from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_config_events');

-- 2. Do the names collide with anything at all — table, view, sequence, index?
--    Expect ZERO rows.
select c.relname, c.relkind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'platform_config_versions','platform_config_events',
     'pcv_one_active_per_client','pcv_by_client_version','pcv_by_client_status',
     'pcv_by_content_hash','pcv_by_schema_version',
     'pce_by_client_time','pce_by_client_version','pce_by_type'
   );

-- 3. Do the trigger functions already exist under these names? Expect ZERO rows.
--    `create or replace function` would silently overwrite somebody else's.
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('pcv_guard_frozen_rows','pcv_refuse_delete','pce_append_only');

-- 4. What tenant keys exist? The migration stores clients.slug in client_id but
--    deliberately adds no foreign key, so this is context rather than a gate.
select slug from public.clients order by slug limit 50;

-- 5. Is gen_random_uuid() available? Expect one row.
--    (pgcrypto, or Postgres 13+ built-in.) The tables default their primary
--    keys with it, so a missing function fails the apply at the first table.
select p.proname
  from pg_proc p
 where p.proname = 'gen_random_uuid'
 limit 1;
