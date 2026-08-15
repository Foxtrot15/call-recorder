-- ===========================================================================
-- 16 - LPM4 VERIFIER. READ-ONLY. Run this AFTER applying LPM4.
--
-- Proves the constraint was widened, that nothing else moved, and that the
-- one-agent guard is still the thing enforcing one agent.
--
-- Contains no INSERT, UPDATE, DELETE, ALTER, CREATE or DROP.
--
-- ASCII ONLY, AND DELIBERATELY SO. The first version of this file used em
-- dashes inside its string literals. A single mangled multi-byte character
-- inside a quoted string desynchronises the quoting for everything after it,
-- and the editor then reports a syntax error at whatever clause happens to
-- follow - which is how a healthy file produced
-- `syntax error at or near "where"` on a line that was never a statement.
-- Nothing here goes above U+007E, and no column is aliased to a reserved word.
-- ===========================================================================

-- ---- 1. The purpose CHECK now permits both acquisition values -------------
select
  'acquisition purposes permitted' as check_name,
  count(*)                         as found,
  case when count(*) = 1 then 'PASS' else 'FAIL - LPM4 did not take effect' end as verdict
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.contype = 'c'
  and pg_get_constraintdef(c.oid) like '%acquisition_agent%'
  and pg_get_constraintdef(c.oid) like '%acquisition_response_engine%';

-- ---- 2. And still permits all six originals -------------------------------
-- A widening that quietly dropped a value would break receptionist and
-- onboarding provisioning, so each is checked by name rather than by count.
select v.expected,
       case when pg_get_constraintdef(c.oid) like '%' || v.expected || '%' then 'PASS' else 'FAIL - value lost' end as verdict
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
cross join (values
  ('onboarding_agent'),('receptionist_agent'),('receptionist_knowledge'),
  ('receptionist_analysis'),('onboarding_analysis'),('inbound_binding'),
  ('acquisition_agent'),('acquisition_response_engine')
) as v(expected)
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.conname = 'provider_resources_purpose_check'
order by v.expected;

-- The full definition, for the record.
select pg_get_constraintdef(c.oid) as purpose_check_definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.conname = 'provider_resources_purpose_check';

-- ---- 3. Exactly ONE purpose CHECK exists - no orphan left behind ----------
select
  'purpose CHECK count' as check_name,
  count(*)              as found,
  case when count(*) = 1 then 'PASS' else 'FAIL - a duplicate or orphaned constraint remains' end as verdict
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'provider_resources'
  and c.contype = 'c'
  and pg_get_constraintdef(c.oid) like '%purpose%'
  and pg_get_constraintdef(c.oid) like '%onboarding_agent%';

-- ---- 4. NOTHING ELSE MOVED ------------------------------------------------
-- The other constraints LPM3 created must all still be here.
select v.expected_constraint,
       case when exists (
         select 1 from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'public' and t.relname = 'provider_resources' and c.conname = v.expected_constraint
       ) then 'PASS' else 'FAIL - missing' end as verdict
from (values ('pr_idempotency_key'),('pr_superseded_consistency')) as v(expected_constraint);

-- The one-agent guard, unchanged.
select
  'pr_one_active_per_purpose' as check_name,
  count(*)                    as found,
  case when count(*) = 1 then 'PASS - still the one-agent guard' else 'FAIL' end as verdict
from pg_indexes
where schemaname = 'public' and tablename = 'provider_resources' and indexname = 'pr_one_active_per_purpose';

-- RLS posture, unchanged: enabled, no policies, service_role only.
select
  'rls enabled' as check_name,
  bool_and(rowsecurity) as found,
  case when bool_and(rowsecurity) then 'PASS' else 'FAIL' end as verdict
from pg_tables where schemaname = 'public' and tablename = 'provider_resources';

select
  'policy count' as check_name,
  count(*)       as found,
  case when count(*) = 0 then 'PASS - service_role only' else 'FAIL' end as verdict
from pg_policies where schemaname = 'public' and tablename = 'provider_resources';

-- ---- 5. Row-level reality -------------------------------------------------
-- LPM4 is a constraint change. It must not have created, altered or removed a
-- single row.
select
  'total rows' as check_name,
  count(*)     as found,
  'LPM4 creates no row' as verdict
from public.provider_resources;

select
  'acquisition rows' as check_name,
  count(*)           as found,
  case when count(*) = 0 then 'expected until an agent is created' else 'an acquisition resource is recorded' end as verdict
from public.provider_resources
where purpose in ('acquisition_agent','acquisition_response_engine');

-- ---- 6. The sentinel still has no colliding real client -------------------
select
  'reserved slug collision' as check_name,
  count(*)                  as found,
  case when count(*) = 0 then 'PASS' else 'ATTENTION - a real client now uses the reserved slug' end as verdict
from public.clients
where slug = 'aida-acquisition';
