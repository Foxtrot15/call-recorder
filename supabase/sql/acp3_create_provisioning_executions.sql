-- ============================================================================
-- AIDA CLIENT PLATFORM (ACP3): durable provisioning execution claims.
--
-- Two additive tables. Nothing existing is altered, renamed or dropped, and
-- ACP1 and ACP2 are untouched — they were reviewed already and this is
-- additive by design.
--
--   platform_provisioning_executions  one attempt to execute one approved plan
--   platform_action_executions        one row per action within an attempt
--
-- ── WHAT THESE TABLES ARE FOR ───────────────────────────────────────────────
--
--   TWO PROCESSES MUST NOT EXECUTE THE SAME APPROVED ACTION.
--
-- An in-process mutex protects one Node process from itself, which is not the
-- failure that creates a second agent. Two workers, two containers, or one
-- operator running a CLI while a job runs — those are the cases, and only the
-- database can arbitrate them. The claim is an INSERT taken BEFORE the provider
-- is contacted, and these indexes are what make it a claim rather than a note.
--
-- ── AND WHAT THEY ARE NOT ───────────────────────────────────────────────────
-- They do not make provider mutation exactly-once. Nothing can: a request may
-- reach a provider and its response may be lost, and no client-side code can
-- tell the difference. What they provide is:
--
--   * one durable local claim per (client, action)
--   * one intentional mutation attempt per authorised action
--   * a deterministic provider_request_id, so a provider offering idempotency
--     keys can de-duplicate on ITS side
--   * a blocked client until an unresolved action is reconciled
--
-- ── UNKNOWN IS A FIRST-CLASS STATE ──────────────────────────────────────────
-- `unknown` and `persist_failed_after_provider_success` are STATUSES, not error
-- strings. Collapsing either into 'failed' is the single change that would make
-- a second agent possible, so the CHECK constraint names them and the partial
-- unique index below treats them as blocking.
--
-- ── RLS POSTURE ─────────────────────────────────────────────────────────────
-- Enabled in the same transaction, ZERO policies, service_role only — matching
-- LPM3, ACP1 and ACP2. These rows record what AIDA has changed, or may have
-- changed, at a provider. There is no client-browser read path.
--
-- ── STATUS ──────────────────────────────────────────────────────────────────
-- NOT APPLIED TO DEV.
-- NOT APPLIED TO PRODUCTION.
-- NOT APPLIED ANYWHERE.
-- Nothing in this repository applies SQL and a ratchet asserts it. This file
-- has never been executed and no database was connected while writing it.
--
-- APPLICATION ORDER: after ACP2 (also unapplied). It references no other table.
-- ============================================================================

begin;

-- ── 1. Execution attempts ───────────────────────────────────────────────────
create table if not exists public.platform_provisioning_executions (
  id                    uuid        primary key default gen_random_uuid(),
  execution_id          text        not null check (length(execution_id) between 1 and 64),
  client_id             text        not null check (length(client_id) between 1 and 64),
  plan_id               text        not null check (length(plan_id) between 1 and 64),

  -- Bound to the exact plan, and therefore to the exact configuration that
  -- plan was built from. An execution cannot drift onto another plan.
  plan_hash             text        not null check (length(plan_hash) = 64),
  config_version        integer     not null check (config_version >= 1),
  config_content_hash   text        check (config_content_hash is null or length(config_content_hash) = 64),
  behaviour_hash        text        not null check (length(behaviour_hash) = 64),

  provider              text        not null check (provider in ('retell','mock','dry_run')),
  provider_tag          text        check (provider_tag is null or length(provider_tag) <= 50),

  actor                 text        check (actor is null or length(actor) <= 200),
  attempt_ordinal       integer     not null default 1 check (attempt_ordinal >= 1),

  status                text        not null default 'claimed'
    check (status in ('claimed','completed','failed','unknown','manual_reconciliation_required','abandoned')),

  started_at            timestamptz not null default now(),
  completed_at          timestamptz,
  detail                text        check (detail is null or length(detail) <= 2000),

  constraint pex_execution_id_unique unique (client_id, execution_id),

  -- A finished execution says when it finished; an unresolved one does not
  -- pretend to have.
  constraint pex_completion_consistency check (
    (status in ('claimed','unknown','manual_reconciliation_required') and completed_at is null)
    or (status in ('completed','failed','abandoned') and completed_at is not null)
  ),
  constraint pex_instants_ordered check (completed_at is null or completed_at >= started_at)
);

-- ── THE CLIENT-LEVEL BLOCK ──────────────────────────────────────────────────
-- While a client has ANY unresolved execution, no new one may be claimed. This
-- is the durable half of "no second agent": an operator who re-runs after a
-- timeout is refused by the database, not by a memory of what happened.
create unique index if not exists pex_one_unresolved_per_client
  on public.platform_provisioning_executions (client_id)
  where status in ('claimed','unknown','manual_reconciliation_required');

create index if not exists pex_by_client_started
  on public.platform_provisioning_executions (client_id, started_at desc);
create index if not exists pex_by_plan
  on public.platform_provisioning_executions (client_id, plan_id);

-- ── 2. Action executions ────────────────────────────────────────────────────
create table if not exists public.platform_action_executions (
  id                    uuid        primary key default gen_random_uuid(),
  client_id             text        not null check (length(client_id) between 1 and 64),
  execution_id          text        not null check (length(execution_id) between 1 and 64),
  plan_id               text        not null check (length(plan_id) between 1 and 64),

  -- purpose:resource_type. The identity of the THING, independent of any plan.
  action_key            text        not null check (length(action_key) between 3 and 120),
  action_ordinal        integer     not null check (action_ordinal >= 0),
  action_kind           text        not null check (action_kind in ('create','update','replace','retire')),
  purpose               text        not null,
  resource_type         text        not null,

  desired_payload_hash  text        check (desired_payload_hash is null or length(desired_payload_hash) = 64),

  -- Deterministic and IMMUTABLE. The same authorised action always produces
  -- the same value, so a provider offering idempotency keys can de-duplicate
  -- even when AIDA cannot tell whether the first request arrived. A value that
  -- changed between attempts would defeat the entire purpose.
  provider_request_id   text        not null check (length(provider_request_id) = 64),

  provider_resource_id  text        check (provider_resource_id is null or length(provider_resource_id) between 1 and 200),

  status                text        not null default 'claimed'
    check (status in (
      'not_started','claimed','provider_succeeded','provider_failed_definite',
      'unknown','persist_failed_after_provider_success','completed','manual_reconciliation_required'
    )),

  ambiguity_reason      text        check (ambiguity_reason is null or ambiguity_reason in (
      'timeout_after_request_sent','connection_reset_after_write',
      'malformed_response_after_accepted_request','transport_ambiguity','unclassifiable_provider_error'
  )),

  claimed_at            timestamptz not null default now(),
  attempted_at          timestamptz,
  resolved_at           timestamptz,
  detail                text        check (detail is null or length(detail) <= 2000),

  -- One row per action per execution attempt.
  constraint pae_action_unique unique (client_id, execution_id, action_key),

  -- An UNKNOWN action must say why it is unknown.
  constraint pae_unknown_has_reason
    check (status <> 'unknown' or ambiguity_reason is not null),

  -- A resource that EXISTS must carry its id, or nobody can ever record it.
  constraint pae_success_has_provider_id
    check (status not in ('provider_succeeded','completed','persist_failed_after_provider_success')
           or provider_resource_id is not null),

  -- Unresolved actions do not claim to be resolved.
  constraint pae_resolution_consistency
    check ((status in ('claimed','provider_succeeded','unknown','persist_failed_after_provider_success')
            and resolved_at is null)
        or (status in ('not_started','provider_failed_definite','completed','manual_reconciliation_required')
            and (resolved_at is not null or status = 'not_started'))),

  constraint pae_instants_ordered
    check ((attempted_at is null or attempted_at >= claimed_at)
       and (resolved_at is null or resolved_at >= claimed_at))
);

-- ── THE RESOURCE-LEVEL BLOCK — THE NO-SECOND-AGENT GUARD ────────────────────
-- While an action for (client, action_key) is unresolved, NO other execution
-- may claim it. The blocking set deliberately includes `unknown` and
-- `persist_failed_after_provider_success`: in both of those a resource may or
-- does exist remotely, and claiming again is exactly how one authorised write
-- becomes two agents.
create unique index if not exists pae_one_unresolved_per_action
  on public.platform_action_executions (client_id, action_key)
  where status in ('claimed','provider_succeeded','unknown','persist_failed_after_provider_success');

create index if not exists pae_by_execution
  on public.platform_action_executions (client_id, execution_id, action_ordinal);
create index if not exists pae_by_request_id
  on public.platform_action_executions (provider_request_id);
create index if not exists pae_unresolved
  on public.platform_action_executions (client_id, status)
  where status in ('unknown','persist_failed_after_provider_success');

-- ── IMMUTABLE IDENTITY ──────────────────────────────────────────────────────
create or replace function public.pae_guard_identity()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.client_id           is distinct from old.client_id
     or new.execution_id        is distinct from old.execution_id
     or new.action_key          is distinct from old.action_key
     or new.action_kind         is distinct from old.action_kind
     or new.provider_request_id is distinct from old.provider_request_id
     or new.claimed_at          is distinct from old.claimed_at then
    raise exception
      'platform_action_executions: identity and the provider request id are immutable (client=% action=%)',
      old.client_id, old.action_key using errcode = 'check_violation';
  end if;

  -- A provider resource id, once recorded, is a fact about the world. It may
  -- be filled in, never changed to a different value.
  if old.provider_resource_id is not null
     and new.provider_resource_id is distinct from old.provider_resource_id then
    raise exception
      'platform_action_executions: provider_resource_id % cannot be changed to % — that would rewrite what exists',
      old.provider_resource_id, new.provider_resource_id using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists pae_guard_identity_trg on public.platform_action_executions;
create trigger pae_guard_identity_trg
  before update on public.platform_action_executions
  for each row execute function public.pae_guard_identity();

-- Execution history is never deleted: it is the record of what AIDA may have
-- changed at somebody's telephone provider.
create or replace function public.pex_refuse_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '%: rows are never deleted — resolve or abandon instead', tg_table_name
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists pex_refuse_delete_trg on public.platform_provisioning_executions;
create trigger pex_refuse_delete_trg
  before delete on public.platform_provisioning_executions
  for each row execute function public.pex_refuse_delete();

drop trigger if exists pae_refuse_delete_trg on public.platform_action_executions;
create trigger pae_refuse_delete_trg
  before delete on public.platform_action_executions
  for each row execute function public.pex_refuse_delete();

-- ── RLS, same transaction (D8) ──────────────────────────────────────────────
alter table public.platform_provisioning_executions enable row level security;
alter table public.platform_action_executions       enable row level security;
-- Deliberately NO policies. service_role only.

comment on table public.platform_provisioning_executions is
  'One attempt to execute one approved provisioning plan. An unresolved row BLOCKS every further execution for that client. Service-role only.';
comment on index public.pex_one_unresolved_per_client is
  'The durable half of no-second-agent: an operator re-running after a timeout is refused by the database.';
comment on table public.platform_action_executions is
  'One row per action per attempt, claimed BEFORE the provider is contacted. Service-role only.';
comment on index public.pae_one_unresolved_per_action is
  'While an action is claimed, succeeded-but-unrecorded, or UNKNOWN, no other execution may claim it. This is what stops a second resource being created for one purpose.';
comment on column public.platform_action_executions.provider_request_id is
  'Deterministic and immutable. Lets a provider that supports idempotency keys de-duplicate on its side when AIDA cannot tell whether the first request arrived.';

commit;

-- ============================================================================
-- VERIFICATION — read-only. Full verifier: verification/24_acp3_verify_readonly.sql
-- ============================================================================
select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_provisioning_executions','platform_action_executions')
 order by tablename;                       -- expect 2 rows, rowsecurity = t

select count(*) as policy_count from pg_policies
 where schemaname = 'public'
   and tablename in ('platform_provisioning_executions','platform_action_executions');   -- expect 0

select indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'pae_one_unresolved_per_action';

-- THE PROBE THAT MATTERS MOST WHILE NO REAL PROVIDER IS WIRED.
-- Any row here means something contacted a provider.
select client_id, execution_id, status from public.platform_provisioning_executions;   -- expect 0 rows
select client_id, action_key, status, provider_resource_id
  from public.platform_action_executions;                                              -- expect 0 rows

-- Invariant probes — every one must return zero rows, forever:
select client_id, count(*) from public.platform_provisioning_executions
 where status in ('claimed','unknown','manual_reconciliation_required')
 group by 1 having count(*) > 1;
select client_id, action_key, count(*) from public.platform_action_executions
 where status in ('claimed','provider_succeeded','unknown','persist_failed_after_provider_success')
 group by 1,2 having count(*) > 1;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- begin;
-- drop trigger if exists pae_refuse_delete_trg on public.platform_action_executions;
-- drop trigger if exists pex_refuse_delete_trg on public.platform_provisioning_executions;
-- drop trigger if exists pae_guard_identity_trg on public.platform_action_executions;
-- drop function if exists public.pex_refuse_delete();
-- drop function if exists public.pae_guard_identity();
-- drop table if exists public.platform_action_executions;
-- drop table if exists public.platform_provisioning_executions;
-- commit;

-- ============================================================================
-- DEFERRED, DELIBERATELY NOT IN THIS MIGRATION
-- ============================================================================
-- * Any ALTER on provider_resources. The registry write path uses the existing
--   columns and the existing bounded provider_metadata; nothing new is needed.
--
-- * A foreign key to platform_provisioning_plans(plan_id). Same reasoning as
--   ACP1 and ACP2: the record of what AIDA may have changed at a provider
--   should outlive a tidied-up plan row.
--
-- * Any table for a live provider transport, credentials or endpoints. There is
--   no live transport. Wiring one is a separate code milestone with its own
--   review, and it does not begin with a schema.
