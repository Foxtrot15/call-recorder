-- ===========================================================================
-- LPM4 — let acquisition resources live in provider_resources
--
--   E-12F, hardened by an independent review in E-12I.
--   NOT APPLIED. The founder applies this by hand in the Supabase SQL editor.
--
--   Run supabase/sql/verification/15_lpm4_preflight_readonly.sql FIRST.
--   Run supabase/sql/verification/16_lpm4_verify_readonly.sql AFTER.
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────────
-- "Has the acquisition agent already been provisioned?" needs a durable answer,
-- or a second run of the provisioning runner creates a second agent — and
-- unlike a duplicate response engine, a duplicate AGENT can telephone people.
--
-- provider_resources (LPM3) already answers that for every other Retell
-- resource. It already carries payload_hash, provider_version, provider_tag,
-- active, superseded_at, last_failure_code, and:
--
--   pr_idempotency_key         unique (client_id, provider, idempotency_key)
--   pr_one_active_per_purpose  UNIQUE (client_id, provider, purpose,
--                                      resource_type) WHERE active
--
-- That second index IS the one-agent guard, enforced by the database rather
-- than by an application check. Nothing new is needed for it.
--
-- ── THE ONLY THING IN THE WAY ─────────────────────────────────────────────
-- `purpose` carries a CHECK listing six receptionist/onboarding values, so an
-- acquisition row is REJECTED BY POSTGRES. This widens that one constraint.
--
-- No new table. No new index. No column added, dropped or retyped. No data
-- change of any kind.
--
-- ── THE client_id SENTINEL, AND ITS ONE FUTURE DEPENDENCY ─────────────────
-- Acquisition is OUR outbound activity and belongs to no tenant, so it uses a
-- reserved client_id of 'aida-acquisition' rather than borrowing a locksmith's
-- slug — which would file our cold-calling agent under somebody's business and
-- put it in their operator views.
--
-- There is NO foreign key on provider_resources.client_id today. LPM3 defers
-- it deliberately ("clients.slug is not uniquely constrained in every
-- environment") and records the statement that would add it, WITH
-- `on delete cascade`.
--
-- So this is written down rather than discovered later: IF pr_client_fk is ever
-- added, acquisition rows need either a real `clients` row for the sentinel or
-- an FK that excludes them. Adding that FK while an acquisition row exists and
-- no matching client does would fail the ALTER — loudly, which is the good
-- outcome. The bad outcome would be someone creating a REAL client whose slug
-- is 'aida-acquisition' and later deleting it, cascading our agent record away.
-- The preflight script checks for exactly that collision before you apply this,
-- and the verifier re-checks it afterwards.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
-- Widening a CHECK cannot invalidate an existing row: every value permitted
-- before is permitted after. It is idempotent — re-running it is a no-op — and
-- it refuses rather than guesses if the constraint is not in the shape it
-- expects. Reversible; the rollback is at the bottom and will fail loudly if an
-- acquisition row exists by then, which is correct rather than silently
-- deleting one.
-- ===========================================================================

begin;

do $$
declare
  con_name  text;
  con_count int;
  already   boolean;
begin
  -- Already widened? Then this whole migration is a no-op.
  select exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'provider_resources'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%acquisition_agent%'
  ) into already;

  if already then
    raise notice 'LPM4: purpose already permits acquisition values. Nothing to do.';
    return;
  end if;

  -- Find the purpose CHECK. It is inline in LPM3 and therefore auto-named, so
  -- it is discovered by its DEFINITION rather than by a name we guessed.
  -- provider_resources has many CHECK constraints; requiring BOTH 'purpose' and
  -- a value only that constraint contains makes the match unambiguous.
  select count(*), min(c.conname)
    into con_count, con_name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'provider_resources'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%purpose%'
     and pg_get_constraintdef(c.oid) like '%onboarding_agent%';

  -- Refuse rather than guess. Dropping the wrong constraint would remove a
  -- protection nobody would notice was gone.
  if con_count = 0 then
    raise exception 'LPM4: no purpose CHECK constraint found on provider_resources. Refusing — the schema is not in the expected shape.';
  elsif con_count > 1 then
    raise exception 'LPM4: % candidate purpose CHECK constraints found. Refusing rather than dropping the wrong one.', con_count;
  end if;

  execute format('alter table public.provider_resources drop constraint %I', con_name);
  raise notice 'LPM4: dropped purpose constraint %', con_name;

  -- The same six, plus the two acquisition purposes. Listed explicitly so the
  -- permitted set is readable in one place rather than inferred from a diff.
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

  raise notice 'LPM4: purpose now permits acquisition_agent and acquisition_response_engine.';
end
$$;

commit;

-- ===========================================================================
-- ROLLBACK
--
-- Fails loudly if an acquisition row exists, which is correct: reverting the
-- constraint while a row depends on it would either fail anyway or require
-- deleting provisioning history, and neither should happen silently.
-- ===========================================================================
-- begin;
-- do $$
-- begin
--   if exists (select 1 from public.provider_resources
--               where purpose in ('acquisition_agent','acquisition_response_engine')) then
--     raise exception 'LPM4 rollback refused: acquisition rows exist. Supersede or remove them deliberately first.';
--   end if;
-- end $$;
-- alter table public.provider_resources drop constraint provider_resources_purpose_check;
-- alter table public.provider_resources
--   add constraint provider_resources_purpose_check
--   check (purpose in (
--     'onboarding_agent','receptionist_agent','receptionist_knowledge',
--     'receptionist_analysis','onboarding_analysis','inbound_binding'));
-- commit;
