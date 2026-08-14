-- ===========================================================================
-- LPM4 — let acquisition resources live in provider_resources
--
--   E-12F. NOT APPLIED. Founder applies this by hand in the Supabase SQL editor.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────────
-- The question "has the acquisition agent already been provisioned?" needs a
-- durable answer, or a second run of the provisioning runner creates a second
-- agent — and unlike a duplicate response engine, a duplicate AGENT is a thing
-- that can telephone people.
--
-- provider_resources (LPM3) already answers that question for every other
-- Retell resource. It already has:
--
--   resource_type ... 'voice_agent' and 'response_engine'   (both allowed)
--   payload_hash  ... 64-char hash of the exact sent payload
--   provider_version, provider_tag, active, superseded_at
--   last_failure_code / last_failure_at
--   pr_idempotency_key      unique (client_id, provider, idempotency_key)
--   pr_one_active_per_purpose  UNIQUE (client_id, provider, purpose,
--                                      resource_type) WHERE active
--
-- That last index IS the one-agent guard, and it is enforced by the database
-- rather than by an application check. Nothing new is needed for it.
--
-- ── THE ONLY THING IN THE WAY ─────────────────────────────────────────────
-- `purpose` carries a CHECK constraint listing six values, all receptionist or
-- onboarding. An acquisition row would be REJECTED BY POSTGRES. So this
-- migration widens that one constraint and nothing else.
--
-- No new table. No new index. No data change. No column added or dropped.
--
-- ── WHY NOT A NEW acquisition_agents TABLE ────────────────────────────────
-- Because provider_resources already models identity, version, payload hash,
-- supersession, failure and single-active-per-purpose — and a second table
-- would mean two places to ask "what exists at the provider?", which is how
-- the answers eventually disagree.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
-- Widening a CHECK cannot invalidate an existing row: every value currently
-- permitted stays permitted. There are zero rows in this table today in any
-- case. It is reversible — the rollback at the bottom restores the original
-- six values, and will fail loudly if an acquisition row exists by then, which
-- is the correct behaviour rather than silently deleting one.
-- ===========================================================================

begin;

-- The constraint is inline in LPM3 and therefore auto-named by Postgres.
-- Discovered rather than assumed, so this works regardless of the generated
-- name, and does nothing if it has already been replaced.
do $$
declare
  con_name text;
begin
  select c.conname
    into con_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'provider_resources'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%purpose%'
     and pg_get_constraintdef(c.oid) ilike '%onboarding_agent%'
   limit 1;

  if con_name is null then
    raise notice 'LPM4: no purpose CHECK found — already widened, or shape differs. Nothing dropped.';
  else
    execute format('alter table public.provider_resources drop constraint %I', con_name);
    raise notice 'LPM4: dropped purpose constraint %', con_name;
  end if;
end
$$;

-- The same six, plus the two acquisition purposes. Named explicitly so the
-- permitted set is readable in one place rather than inferred.
alter table public.provider_resources
  add constraint provider_resources_purpose_check
  check (purpose in (
    'onboarding_agent',
    'receptionist_agent',
    'receptionist_knowledge',
    'receptionist_analysis',
    'onboarding_analysis',
    'inbound_binding',
    -- E-12F: the cold-acquisition agent, and the response engine it points at.
    'acquisition_agent',
    'acquisition_response_engine'
  ));

commit;

-- ===========================================================================
-- VERIFY (read-only — safe to run on its own)
-- ===========================================================================
-- select pg_get_constraintdef(c.oid) as purpose_check
--   from pg_constraint c
--   join pg_class t on t.oid = c.conrelid
--   join pg_namespace n on n.oid = t.relnamespace
--  where n.nspname = 'public'
--    and t.relname = 'provider_resources'
--    and c.conname = 'provider_resources_purpose_check';
--
-- Expect the definition to contain acquisition_agent and
-- acquisition_response_engine.
--
-- The one-agent guard needs no change and can be confirmed with:
--
-- select indexdef from pg_indexes
--  where schemaname = 'public'
--    and tablename  = 'provider_resources'
--    and indexname  = 'pr_one_active_per_purpose';
--
-- Expect: UNIQUE, on (client_id, provider, purpose, resource_type) WHERE active.

-- ===========================================================================
-- ROLLBACK (only if no acquisition row exists — it will fail loudly if one does)
-- ===========================================================================
-- begin;
-- alter table public.provider_resources drop constraint provider_resources_purpose_check;
-- alter table public.provider_resources
--   add constraint provider_resources_purpose_check
--   check (purpose in (
--     'onboarding_agent','receptionist_agent','receptionist_knowledge',
--     'receptionist_analysis','onboarding_analysis','inbound_binding'));
-- commit;
