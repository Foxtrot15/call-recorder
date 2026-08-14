-- ===========================================================================
-- 15 — LPM4 PREFLIGHT. READ-ONLY. Run this BEFORE applying LPM4.
--
-- Answers one question: is the schema in the shape LPM4 expects, and is the
-- reserved client_id free?
--
-- Contains no INSERT, UPDATE, DELETE, ALTER, CREATE or DROP. Safe to run at
-- any time, on any environment, as often as you like.
-- ===========================================================================

-- ── 1. Does the table exist, and is it the LPM3 one? ──────────────────────
select
  'provider_resources exists' as check,
  count(*)                    as found,
  case when count(*) = 1 then 'PASS' else 'FAIL — LPM3 has not been applied' end as verdict
from information_schema.tables
where table_schema = 'public' and table_name = 'provider_resources';

-- ── 2. The purpose CHECK — exactly one, in the expected shape ─────────────
-- LPM4 refuses to run if this is not exactly 1.
select
  'purpose CHECK candidates' as check,
  count(*)                   as found,
  case
    when count(*) = 1 then 'PASS — LPM4 will widen this one'
    when count(*) = 0 then 'FAIL — not found; already widened, or schema differs'
    else 'FAIL — ambiguous; LPM4 will refuse rather than guess'
  end as verdict
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.contype = 'c'
  and pg_get_constraintdef(c.oid) like '%purpose%'
  and pg_get_constraintdef(c.oid) like '%onboarding_agent%';

-- Its current definition, for the record.
select c.conname, pg_get_constraintdef(c.oid) as current_definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.contype = 'c'
  and pg_get_constraintdef(c.oid) like '%purpose%';

-- ── 3. Has it already been widened? Then LPM4 is a no-op. ─────────────────
select
  'already widened' as check,
  count(*)          as found,
  case when count(*) > 0 then 'ALREADY APPLIED — LPM4 will do nothing' else 'not yet' end as verdict
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.contype = 'c'
  and pg_get_constraintdef(c.oid) like '%acquisition_agent%';

-- ── 4. The one-agent guard must already exist. LPM4 does not create it. ───
select
  'pr_one_active_per_purpose' as check,
  count(*)                    as found,
  case when count(*) = 1 then 'PASS — the one-agent guard is present' else 'FAIL — LPM3 index missing' end as verdict
from pg_indexes
where schemaname = 'public'
  and tablename  = 'provider_resources'
  and indexname  = 'pr_one_active_per_purpose';

select indexdef from pg_indexes
where schemaname = 'public' and tablename = 'provider_resources' and indexname = 'pr_one_active_per_purpose';
-- expect: UNIQUE, (client_id, provider, purpose, resource_type) WHERE active

-- ── 5. Is there a foreign key on client_id? ───────────────────────────────
-- Expected: NONE. LPM3 defers it. If one exists, the reserved sentinel needs a
-- matching clients row before any acquisition resource can be recorded.
select
  'client_id foreign key' as check,
  count(*)                as found,
  case when count(*) = 0 then 'PASS — no FK; the sentinel is safe'
       else 'ATTENTION — an FK exists; the reserved client_id needs a clients row' end as verdict
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and t.relname = 'provider_resources' and c.contype = 'f';

-- ── 6. Does a REAL client already use the reserved slug? ──────────────────
-- This is the collision that would matter: a genuine tenant named
-- 'aida-acquisition' could later be deleted and, if the deferred FK is ever
-- added with ON DELETE CASCADE, take our provisioning record with it.
select
  'reserved slug collision' as check,
  count(*)                  as found,
  case when count(*) = 0 then 'PASS — no real client uses the reserved slug'
       else 'FAIL — a real client uses aida-acquisition; choose a different sentinel' end as verdict
from public.clients
where slug = 'aida-acquisition';

-- ── 7. Existing rows are preserved — this is what must not change. ────────
select
  'existing rows' as check,
  count(*)        as found,
  'LPM4 changes none of these' as verdict
from public.provider_resources;

select purpose, resource_type, count(*) as rows
from public.provider_resources
group by purpose, resource_type
order by purpose, resource_type;
-- expect: no rows today on dev.
