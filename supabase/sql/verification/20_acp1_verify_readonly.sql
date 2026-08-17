-- ACP1 POST-VERIFY — read-only. Run AFTER applying acp1_create_client_configuration.sql.
--
-- Proves the invariants exist in the DATABASE, not merely in the migration file
-- somebody believes was applied.
--
-- Nothing here writes.
--
-- ── WHY to_regclass() AND NOT ::regclass ────────────────────────────────────
-- P36. Every catalogue lookup below uses to_regclass('public.x'), which returns
-- NULL for a relation that does not exist. The cast form — 'public.x'::regclass
-- — RAISES 42P01 instead, and a verifier that explodes when the thing it is
-- verifying is absent tells you nothing about why. That is exactly how this
-- file was first run: before the tables existed, against a database where the
-- honest answer was "none of it is here".
--
-- `conrelid = to_regclass(...)` matches nothing when the table is absent,
-- because NULL equals nothing. Do NOT "improve" this to
-- `conrelid IN (coalesce(to_regclass(...), 0::oid))`: a DOMAIN constraint has
-- conrelid = 0, so that shape silently matches every domain CHECK in the
-- database. It was written that way once and returned
-- information_schema's cardinal_number_domain_check as though it belonged to
-- platform_config_versions. If you ever need the IN form, it also needs
-- `and conrelid <> 0`.
--
-- LPM4 TRANSPORT LESSON, again: raw material over computed verdicts. Each query
-- is small enough to paste alone and produces output a person can check by
-- eye. The expectation is written beside each one.
--
-- ── WHAT "PASS" LOOKS LIKE ──────────────────────────────────────────────────
--  1  two rows, rowsecurity = t on both
--  2  0
--  3  ten index names, including pcv_one_active_per_client
--  4  the one-active index definition, containing WHERE (status = 'active'::text)
--  5  the three lineage FKs, all self-referential on (client_id, ...)
--  6  ~15 check constraints on the versions table
--  7  three triggers
--  8  0 rows  (no credential-shaped column)
--  9  0 and 0 (the migration creates no rows)
-- 10  0 rows  (no client has two active versions)
-- 11  0 rows  (no approved row whose approved_hash disagrees with content_hash)
-- 12  0 rows  (no row carrying approval metadata it has not earned)

-- 1. Tables exist, RLS is on.
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_config_events')
 order by tablename;

-- 2. ZERO policies. Service-role only, matching LPM3 and the house posture.
--    A non-zero answer here means a browser may be able to read a business's
--    approved wording and transfer numbers directly.
select count(*) as policy_count
  from pg_policies
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_config_events');

-- 3. Indexes.
select tablename, indexname
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_config_events')
 order by tablename, indexname;

-- 4. THE ONE-ACTIVE AUTHORITY. This is the single most important row in the
--    whole verification: it is what makes two active versions per client
--    impossible rather than merely unlikely.
select indexdef
  from pg_indexes
 where schemaname = 'public' and indexname = 'pcv_one_active_per_client';

-- 5. Lineage foreign keys — all three self-referential and composite, which is
--    what makes cross-client lineage unrepresentable.
select conname, pg_get_constraintdef(oid) as definition, convalidated
  from pg_constraint
 where conrelid = to_regclass('public.platform_config_versions')
   and contype = 'f'
 order by conname;

-- 6. Check constraints.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = to_regclass('public.platform_config_versions')
   and contype = 'c'
 order by conname;

-- 7. Triggers — frozen rows, no delete, append-only events.
select c.relname as table_name, t.tgname
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('platform_config_versions','platform_config_events')
   and not t.tgisinternal
 order by c.relname, t.tgname;

-- 8. No credential-shaped column anywhere. Expect ZERO rows.
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('platform_config_versions','platform_config_events')
   and (column_name ilike '%api_key%' or column_name ilike '%secret%'
        or column_name ilike '%token%' or column_name ilike '%password%'
        or column_name ilike '%credential%' or column_name ilike '%bearer%');

-- 9. The migration creates NO rows. Both expect 0.
select (select count(*) from public.platform_config_versions) as version_rows,
       (select count(*) from public.platform_config_events)   as event_rows;

-- ── Invariant probes. Every one must return ZERO rows, at any time, forever. ──

-- 10. Two active versions for one client.
select client_id, count(*) as active_count
  from public.platform_config_versions
 where status = 'active'
 group by client_id having count(*) > 1;

-- 11. An approved row whose approved hash disagrees with its content hash —
--     i.e. a body swapped after somebody approved it.
select client_id, config_version, status
  from public.platform_config_versions
 where approved_hash is not null and approved_hash <> content_hash;

-- 12. A row carrying approval or activation metadata its status has not earned.
select client_id, config_version, status
  from public.platform_config_versions
 where (status in ('draft','validated')
        and (approved_at is not null or approved_by is not null or activated_at is not null))
    or (status = 'active' and (activated_at is null or activated_by is null))
    or (status in ('approved','active')
        and (approved_at is null or approved_by is null or approved_hash is null));

-- 13. A version whose stored body disagrees with the row about who owns it.
select client_id, config_version
  from public.platform_config_versions
 where blueprint -> 'identity' ->> 'clientId' is distinct from client_id;

-- 14. Tenant ownership structure exists — the composite uniqueness the lineage
--     FKs depend on. Expect one row.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = to_regclass('public.platform_config_versions')
   and contype = 'u';

-- ── ADDED IN P36 ────────────────────────────────────────────────────────────
-- Query 6 covers platform_config_VERSIONS only, so the two vocabularies most
-- likely to drift were verified nowhere: event_type and actor_role both live on
-- platform_config_EVENTS. Both have been widened since ACP1 was first written —
-- event_type from 13 to 29 in P24-P28, actor_role from 7 to 8 in P36 — and a
-- database carrying the older list does not reject loudly. config-service wraps
-- its audit append in a try/catch, so a stale CHECK produces SILENTLY MISSING
-- audit rows, which is the failure nobody notices.

-- 15. The event vocabulary. Read the list.
--     EXPECT 29 values, including 'execution_requested' and 'manual_review_required'.
--     13 values means this database predates P24-P28 and is STALE.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = to_regclass('public.platform_config_events')
   and contype = 'c'
 order by conname;

-- 16. The same question, answered as a number rather than by counting quotes.
--     EXPECT event_type = 29 and actor_role = 8.
select
  (select cardinality(regexp_split_to_array(pg_get_constraintdef(oid), ''','''))
     from pg_constraint
    where conrelid = to_regclass('public.platform_config_events')
      and contype = 'c' and pg_get_constraintdef(oid) like '%event_type%') as event_type_values,
  (select cardinality(regexp_split_to_array(pg_get_constraintdef(oid), ''','''))
     from pg_constraint
    where conrelid = to_regclass('public.platform_config_events')
      and contype = 'c' and pg_get_constraintdef(oid) like '%actor_role%') as actor_role_values;

-- 17. Does this database know the roles and events the application will write?
--     EXPECT t on both. `f` on either means the application's audit writes will
--     be refused by the database and swallowed by the service.
select
  pg_get_constraintdef(oid) like '%operator_executor%' as knows_operator_executor
  from pg_constraint
 where conrelid = to_regclass('public.platform_config_events')
   and contype = 'c' and pg_get_constraintdef(oid) like '%actor_role%';

select
  pg_get_constraintdef(oid) like '%manual_review_required%' as knows_execution_events
  from pg_constraint
 where conrelid = to_regclass('public.platform_config_events')
   and contype = 'c' and pg_get_constraintdef(oid) like '%event_type%';

-- 18. RLS on the EVENTS table specifically, and its policy count.
--     EXPECT rowsecurity = t, and zero policies.
select relname, relrowsecurity
  from pg_class
 where oid = to_regclass('public.platform_config_events');
