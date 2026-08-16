-- ============================================================================
-- AIDA CLIENT PLATFORM (ACP2): platform provisioning plans.
--
-- ONE additive table. Nothing existing is altered, renamed or dropped.
--
-- ── WHY NOT REUSE public.provisioning_plans ─────────────────────────────────
-- The instruction was to prefer reuse, so this was assessed properly. It does
-- not fit, for reasons that are structural rather than aesthetic:
--
--   1. `approved_profile_version integer not null`
--      That column means a LOCKSMITH PROFILE version. A platform plan binds to
--      a client CONFIGURATION version. Storing one in the other would give the
--      column a name that lies, and every future reader would have to know.
--
--   2. `session_id uuid references public.locksmith_onboarding_sessions(...)`
--      A hard foreign key to a locksmith onboarding table. A plumber
--      configured through the platform has no onboarding session and never
--      will.
--
--   3. `receptionist_template_version` / `onboarding_template_version`
--      Locksmith template concepts with no platform equivalent.
--
--   4. It has no place for the binding this authority is built on: an active
--      configuration CONTENT hash and a BEHAVIOUR hash, and an approval that
--      binds to an exact plan hash. `plan_hash` exists but nothing ties an
--      approval to it.
--
--   5. LPM3 IS APPLIED TO DEV. Widening a live table to fit a second meaning
--      is the change most likely to break the system that already depends on
--      it, and this batch is explicitly forbidden from modifying applied
--      schema.
--
-- So: a second table, and NOT "merely because there is a new module". The two
-- coexist without overlap — provisioning_plans keeps serving locksmith
-- onboarding, this serves platform-configured clients, and neither pretends to
-- be the other.
--
-- ── WHAT IT DOES REUSE ──────────────────────────────────────────────────────
-- Everything that already exists and fits:
--
--   * public.provider_resources — UNCHANGED. Platform resources use the
--     EXISTING purposes (receptionist_agent, receptionist_analysis, ...) and
--     the EXISTING resource types. No new purpose, no widened CHECK, no
--     migration against it.
--
--   * pr_one_active_per_purpose — the one-active-resource-per-client guard is
--     already a database index. If the legacy locksmith compiler and this
--     platform both try to own one client's receptionist agent, Postgres
--     refuses the second. That is the correct answer, and the diff engine
--     surfaces it as a conflict for a person.
--
--   * provider_resources.provider_metadata (jsonb, bounded) — carries the
--     platform provenance chain { producedBy, clientId, configVersion,
--     behaviourHash, payloadHash }. Config-to-resource traceability therefore
--     needs NO schema change at all.
--
-- ── THE INVARIANTS THIS FILE OWNS ───────────────────────────────────────────
--
--   * ONE OPEN PLAN PER CLIENT. A partial unique index over draft/validated/
--     approved. Two open plans for one client is two people about to change
--     the same telephone service.
--
--   * AN APPROVAL BINDS TO A BODY. approved_plan_hash must equal plan_hash, as
--     a CHECK — a plan whose actions changed after approval cannot satisfy the
--     database.
--
--   * APPROVED PLANS ARE FROZEN. A trigger refuses any change to actions, the
--     configuration binding, or the approval, once approved.
--
--   * NOTHING IS EXECUTED. execution_state is constrained to the declared
--     vocabulary, and an executed_at requires an execution_state. No executor
--     exists; the columns are here so a later one cannot invent a shape nobody
--     reviewed.
--
-- ── RLS POSTURE ─────────────────────────────────────────────────────────────
-- Enabled in the same transaction, ZERO policies, service_role only — matching
-- LPM3 and ACP1. A plan describes what AIDA is about to change at a provider;
-- there is no client-browser read path.
--
-- ── STATUS ──────────────────────────────────────────────────────────────────
-- NOT APPLIED TO DEV.
-- NOT APPLIED TO PRODUCTION.
-- NOT APPLIED ANYWHERE.
-- Nothing in this repository applies SQL and a ratchet asserts it. This file
-- has never been executed and no database was connected while writing it.
--
-- APPLICATION ORDER: after acp1_create_client_configuration.sql, which is also
-- unapplied. It references no other table.
-- ============================================================================

begin;

create table if not exists public.platform_provisioning_plans (
  id                    uuid        primary key default gen_random_uuid(),
  plan_id               text        not null check (length(plan_id) between 1 and 64),

  -- Tenancy. clients.slug, exactly as everywhere else in this codebase.
  client_id             text        not null check (length(client_id) between 1 and 64),

  provider              text        not null default 'retell'
    check (provider in ('retell','mock','dry_run')),
  provider_tag          text        check (provider_tag is null or length(provider_tag) <= 50),

  status                text        not null default 'draft'
    check (status in ('draft','validated','approved','executing','completed','failed','unknown','cancelled','superseded')),

  -- ── THE CONFIGURATION BINDING ──
  -- All four together. An approval cannot drift onto a different configuration
  -- that happens to produce a similar plan.
  config_version        integer     not null check (config_version >= 1),
  config_content_hash   text        check (config_content_hash is null or length(config_content_hash) = 64),
  behaviour_hash        text        not null check (length(behaviour_hash) = 64),
  desired_hash          text        not null check (length(desired_hash) = 64),

  -- ── THE PLAN ITSELF ──
  -- Typed counts as columns so "how many provider mutations would this cause"
  -- is answerable without parsing jsonb; the actions themselves are jsonb
  -- because they are a reviewed list, not a query surface.
  actions               jsonb       not null default '[]'::jsonb
    check (jsonb_typeof(actions) = 'array' and length(actions::text) <= 262144),
  mutating_count        integer     not null default 0 check (mutating_count >= 0),
  is_no_op              boolean     not null default false,
  requires_reconciliation boolean   not null default false,
  blocking_reasons      jsonb       not null default '[]'::jsonb
    check (jsonb_typeof(blocking_reasons) = 'array'),

  -- The hash of what a person is asked to say yes to.
  plan_hash             text        not null check (length(plan_hash) = 64),

  -- ── provenance ──
  created_at            timestamptz not null default now(),
  created_by            text        check (created_by is null or length(created_by) <= 200),
  notes                 text        check (notes is null or length(notes) <= 2000),

  validated_at          timestamptz,

  -- ── approval ──
  approved_at           timestamptz,
  approved_by           text        check (approved_by is null or length(approved_by) <= 200),
  approved_plan_hash    text        check (approved_plan_hash is null or length(approved_plan_hash) = 64),
  approval_reason       text        check (approval_reason is null or length(approval_reason) <= 2000),

  -- ── execution: declared, and unreachable ──
  execution_state       text        check (execution_state is null or execution_state in ('executing','completed','failed','unknown')),
  executed_at           timestamptz,
  executed_by           text        check (executed_by is null or length(executed_by) <= 200),
  execution_result      jsonb       check (execution_result is null or length(execution_result::text) <= 65536),

  cancelled_at          timestamptz,
  superseded_at         timestamptz,
  superseded_by         text        check (superseded_by is null or length(superseded_by) <= 64),

  constraint ppp_plan_id_unique unique (client_id, plan_id),

  -- A draft carries no approval and no execution.
  constraint ppp_draft_is_clean
    check (status not in ('draft','validated')
           or (approved_at is null and approved_by is null and approved_plan_hash is null
               and execution_state is null and executed_at is null)),

  constraint ppp_validated_has_instant
    check (status not in ('validated','approved') or validated_at is not null),

  -- An approved plan carries a named person, an instant, and the hash approved.
  constraint ppp_approved_is_complete
    check (status <> 'approved'
           or (approved_at is not null and approved_by is not null and approved_plan_hash is not null)),

  -- THE ANTI-DRIFT CONSTRAINT. What was approved must be what is stored.
  constraint ppp_approval_binds_the_body
    check (approved_plan_hash is null or approved_plan_hash = plan_hash),

  -- Nothing may look executed without recording HOW.
  constraint ppp_executed_has_state
    check (executed_at is null or execution_state is not null),

  -- Only an approved plan may ever have been executed.
  constraint ppp_execution_requires_approval
    check (execution_state is null or approved_plan_hash is not null),

  -- A no-op plan causes no provider mutation, by definition.
  constraint ppp_no_op_has_no_mutations
    check (is_no_op = false or mutating_count = 0),

  constraint ppp_instants_ordered
    check ((validated_at is null or validated_at >= created_at)
       and (approved_at  is null or approved_at  >= created_at)
       and (executed_at  is null or approved_at is null or executed_at >= approved_at))
);

-- ── ONE OPEN PLAN PER CLIENT ────────────────────────────────────────────────
-- Two open plans for one client is two people about to change the same
-- telephone service. Superseding is a status change, never a delete.
create unique index if not exists ppp_one_open_plan_per_client
  on public.platform_provisioning_plans (client_id)
  where status in ('draft','validated','approved');

create index if not exists ppp_by_client_created
  on public.platform_provisioning_plans (client_id, created_at desc);
create index if not exists ppp_by_config_version
  on public.platform_provisioning_plans (client_id, config_version);
create index if not exists ppp_by_plan_hash
  on public.platform_provisioning_plans (plan_hash);

-- ── FROZEN AFTER APPROVAL ───────────────────────────────────────────────────
create or replace function public.ppp_guard_approved_plans()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.plan_id   is distinct from old.plan_id
     or new.client_id is distinct from old.client_id
     or new.created_at is distinct from old.created_at then
    raise exception 'platform_provisioning_plans: identity is immutable (client=% plan=%)',
      old.client_id, old.plan_id using errcode = 'check_violation';
  end if;

  if old.status in ('approved','executing','completed','failed','unknown') then
    if new.actions::text        is distinct from old.actions::text
       or new.plan_hash         is distinct from old.plan_hash
       or new.config_version    is distinct from old.config_version
       or new.behaviour_hash    is distinct from old.behaviour_hash
       or new.desired_hash      is distinct from old.desired_hash
       or new.approved_at       is distinct from old.approved_at
       or new.approved_by       is distinct from old.approved_by
       or new.approved_plan_hash is distinct from old.approved_plan_hash then
      raise exception
        'platform_provisioning_plans: client=% plan=% is % — its actions, configuration binding and approval are immutable',
        old.client_id, old.plan_id, old.status using errcode = 'check_violation';
    end if;

    -- No return to an editable state. A plan somebody approved cannot become a
    -- draft again with different contents.
    if new.status in ('draft','validated') then
      raise exception 'platform_provisioning_plans: client=% plan=% cannot go from % back to %',
        old.client_id, old.plan_id, old.status, new.status using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ppp_guard_approved_plans_trg on public.platform_provisioning_plans;
create trigger ppp_guard_approved_plans_trg
  before update on public.platform_provisioning_plans
  for each row execute function public.ppp_guard_approved_plans();

-- A plan is never deleted. It is the record of what somebody agreed to change.
create or replace function public.ppp_refuse_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform_provisioning_plans: rows are never deleted (client=% plan=%) — cancel or supersede instead',
    old.client_id, old.plan_id using errcode = 'check_violation';
end;
$$;

drop trigger if exists ppp_refuse_delete_trg on public.platform_provisioning_plans;
create trigger ppp_refuse_delete_trg
  before delete on public.platform_provisioning_plans
  for each row execute function public.ppp_refuse_delete();

-- ── RLS, same transaction (D8) ──────────────────────────────────────────────
alter table public.platform_provisioning_plans enable row level security;
-- Deliberately NO policies. service_role only.

comment on table public.platform_provisioning_plans is
  'AIDA client platform: provisioning plans binding an ACTIVE configuration version to a set of proposed provider mutations. Approved means a person agreed to the mutations — NOT that any were performed. Service-role only.';
comment on index public.ppp_one_open_plan_per_client is
  'Two open plans for one client is two people about to change the same telephone service.';
comment on column public.platform_provisioning_plans.approved_plan_hash is
  'Must equal plan_hash (constraint ppp_approval_binds_the_body). A plan whose actions changed after approval cannot satisfy the database.';
comment on column public.platform_provisioning_plans.execution_state is
  'Declared but unreachable: no executor exists. Present so a later one cannot invent a shape nobody reviewed.';

commit;

-- ============================================================================
-- VERIFICATION — read-only. Full verifier: verification/22_acp2_verify_readonly.sql
-- ============================================================================
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename = 'platform_provisioning_plans';   -- expect 1 row, rowsecurity = t

select count(*) as policy_count from pg_policies
 where schemaname = 'public' and tablename = 'platform_provisioning_plans';   -- expect 0

select indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'ppp_one_open_plan_per_client';  -- expect the partial index

select count(*) as plan_rows from public.platform_provisioning_plans;         -- expect 0

-- Invariant probes. Every one must return zero rows, forever:
select client_id, count(*) from public.platform_provisioning_plans
 where status in ('draft','validated','approved') group by 1 having count(*) > 1;
select client_id, plan_id from public.platform_provisioning_plans
 where approved_plan_hash is not null and approved_plan_hash <> plan_hash;
select client_id, plan_id from public.platform_provisioning_plans
 where execution_state is not null;      -- nothing has ever been executed

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- begin;
-- drop trigger if exists ppp_refuse_delete_trg on public.platform_provisioning_plans;
-- drop trigger if exists ppp_guard_approved_plans_trg on public.platform_provisioning_plans;
-- drop function if exists public.ppp_refuse_delete();
-- drop function if exists public.ppp_guard_approved_plans();
-- drop table if exists public.platform_provisioning_plans;
-- commit;

-- ============================================================================
-- DEFERRED, DELIBERATELY NOT IN THIS MIGRATION
-- ============================================================================
-- * Any ALTER on public.provider_resources. Platform provenance fits in the
--   existing bounded provider_metadata jsonb, so config-to-resource
--   traceability needs no schema change. Dedicated columns
--   (platform_config_version, platform_behaviour_hash) would query better and
--   would ALTER a table that is APPLIED TO DEV — a change that belongs in its
--   own reviewed migration, with its own preflight, if the jsonb read ever
--   becomes a real cost.
--
-- * A foreign key to public.clients(slug), for the same reason ACP1 and LPM3
--   defer theirs: it would be ON DELETE CASCADE, and a record of what somebody
--   approved changing at a provider should outlive a tidied-up client row.
--
-- * Any execution table. There is no executor. When there is one, its durable
--   result belongs either in execution_result here or in provider_resources —
--   and that is a decision to make with the executor in front of you, not
--   speculatively now.
