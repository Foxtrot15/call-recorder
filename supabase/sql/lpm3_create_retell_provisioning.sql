-- ============================================================================
-- LOCKSMITH PILOT M3 (LPM3): Retell provisioning foundation.
--
-- Four additive tables. Nothing existing is altered, renamed or dropped; the
-- M2 tables are untouched.
--
--   provider_resources        what AIDA believes exists at a provider, and why.
--                             The record that makes provisioning idempotent.
--   provisioning_plans        a versioned, hashed plan built from ONE immutable
--                             approved profile version.
--   provisioning_actions      per-action result rows, so a partial failure is
--                             resumable without duplicating successes.
--   provider_webhook_events   append-mostly event log with a deterministic
--                             fingerprint for idempotent delivery handling.
--
-- Contracts encoded here (the app enforces the same rules — these are the
-- backstop):
--
--   * RLS enabled IN THE SAME TRANSACTION on all four (D8). No policies:
--     service_role only, matching the deny-by-default posture. These rows
--     describe a business's provisioned configuration and its provider
--     identifiers; there is no client-facing read path.
--   * client_id is clients.slug (text), the canonical tenant key.
--   * NO API KEY IS EVER STORED. There is no column for one.
--   * PARTIAL UNIQUE INDEX: at most one ACTIVE provider resource per
--     (client, provider, purpose, resource_type). Superseding is a flag +
--     timestamp, never a delete, so history survives.
--   * Idempotency keys are unique per client+provider, so a retry after a
--     partial failure cannot create a second copy of a resource.
--   * Webhook fingerprints are globally unique — that IS the idempotency
--     mechanism, since Retell's envelope carries no per-delivery event id.
--   * Provider metadata is bounded in the app (4 KB, redacted) and additionally
--     length-checked here.
--
-- REVIEW ONLY — NOT APPLIED. Nothing in this file has been executed and no
-- database was connected. Apply only when Retell provisioning is actually
-- being switched on, and never before the M2 file.
--
-- APPLICATION ORDER:
--   1. lpm2_create_locksmith_onboarding.sql   (M2 — profiles + sessions + events)
--   2. lpm3_create_retell_provisioning.sql    (this file)
-- This file references locksmith_onboarding_sessions and depends on M2 having
-- been applied first. It has no dependency on the other pending files
-- (phase1a/1b/1c, wcs1b) and may be applied before or after them.
-- ============================================================================

begin;

-- ── 1. Provider resources ───────────────────────────────────────────────────
create table if not exists public.provider_resources (
  id                        uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,          -- clients.slug (tenant)
  provider                  text        not null default 'retell'
    check (provider in ('retell','mock','dry_run')),
  resource_type             text        not null
    check (resource_type in ('knowledge_base','response_engine','voice_agent','analysis_schema','phone_number_binding')),
  purpose                   text        not null
    check (purpose in ('onboarding_agent','receptionist_agent','receptionist_knowledge','receptionist_analysis','onboarding_analysis','inbound_binding')),

  provider_resource_id      text        not null check (length(provider_resource_id) between 1 and 200),
  provider_version          text        check (provider_version is null or length(provider_version) <= 50),
  provider_tag              text        check (provider_tag is null or length(provider_tag) <= 50),

  active                    boolean     not null default true,
  profile_version           integer     check (profile_version is null or profile_version >= 1),
  provisioning_plan_id      uuid,
  superseded_by_plan_id     uuid,

  -- Stable across retries: the resume key. Unique per client+provider below.
  idempotency_key           text        not null check (length(idempotency_key) between 1 and 100),
  payload_hash              text        not null check (length(payload_hash) = 64),

  -- Bounded, redacted in the app before it ever gets here.
  provider_metadata         jsonb       check (provider_metadata is null or length(provider_metadata::text) <= 8192),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  superseded_at             timestamptz,
  last_synced_at            timestamptz,
  last_failure_code         text        check (last_failure_code is null or length(last_failure_code) <= 100),
  last_failure_at           timestamptz,

  -- An inactive row must say when it stopped being active, and vice versa.
  constraint pr_superseded_consistency check (
    (active = true and superseded_at is null) or (active = false and superseded_at is not null)
  ),

  constraint pr_idempotency_key unique (client_id, provider, idempotency_key)
);

-- AT MOST ONE ACTIVE RESOURCE per purpose+type per tenant. This is what stops a
-- retry, a double-click or a racing operator creating two live agents.
create unique index if not exists pr_one_active_per_purpose
  on public.provider_resources (client_id, provider, purpose, resource_type)
  where active = true;

create index if not exists pr_client_idx on public.provider_resources (client_id, created_at desc);
create index if not exists pr_plan_idx on public.provider_resources (provisioning_plan_id);

alter table public.provider_resources enable row level security;

comment on table public.provider_resources is
  'RLS enabled, no policies: service_role only. What AIDA believes exists at a voice provider. NEVER stores an API key. Superseding is a flag + timestamp so history is preserved. See docs/RETELL_INTEGRATION_SPEC.md.';
comment on index public.pr_one_active_per_purpose is
  'At most one active provider resource per client/provider/purpose/type — the duplicate-agent guard.';
comment on column public.provider_resources.idempotency_key is
  'Deterministic key from (client, purpose, resource type, payload hash, plan). Stable across retries so a partial failure resumes rather than duplicating.';

-- ── 2. Provisioning plans ───────────────────────────────────────────────────
create table if not exists public.provisioning_plans (
  id                        uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,
  provider                  text        not null default 'retell'
    check (provider in ('retell','mock','dry_run')),
  status                    text        not null default 'created'
    check (status in ('created','validated','blocked','approved_for_execution','executing','completed','partially_failed','failed','superseded','rolled_back')),

  -- Every plan points at ONE immutable approved profile version.
  approved_profile_version  integer     not null check (approved_profile_version >= 1),
  session_id                uuid        references public.locksmith_onboarding_sessions(session_id) on delete set null,

  compiler_version          text,
  receptionist_template_version text,
  onboarding_template_version   text,

  plan_hash                 text        check (plan_hash is null or length(plan_hash) = 64),
  spec_hash                 text        check (spec_hash is null or length(spec_hash) = 64),
  knowledge_hash            text        check (knowledge_hash is null or length(knowledge_hash) = 64),
  tool_schema_hash          text        check (tool_schema_hash is null or length(tool_schema_hash) = 64),

  actions                   jsonb       not null default '[]'::jsonb,
  blocking_reasons          jsonb       not null default '[]'::jsonb,
  warnings                  jsonb       not null default '[]'::jsonb,
  estimated_api_operations  integer     not null default 0 check (estimated_api_operations >= 0),

  created_by                text,
  created_at                timestamptz not null default now(),
  approved_by               text,
  approved_at               timestamptz,
  executed_by               text,
  executed_at               timestamptz,
  execution_mode            text        check (execution_mode is null or execution_mode in ('mock','dry_run','live')),
  result_summary            jsonb,
  superseded_at             timestamptz,
  updated_at                timestamptz not null default now(),

  -- A blocked plan must say why; an approved plan must carry its approval.
  constraint pp_blocked_has_reason check (
    status <> 'blocked' or jsonb_array_length(blocking_reasons) > 0
  ),
  constraint pp_approved_has_evidence check (
    status <> 'approved_for_execution' or (approved_at is not null and approved_by is not null)
  ),
  -- Nothing may be marked executed without recording HOW it was executed.
  constraint pp_executed_has_mode check (
    executed_at is null or execution_mode is not null
  )
);

-- At most one plan per client is awaiting or undergoing execution. Two live
-- plans for one tenant is how a provider ends up with two agents.
create unique index if not exists pp_one_active_per_client
  on public.provisioning_plans (client_id)
  where status in ('approved_for_execution','executing');

create index if not exists pp_client_created_idx on public.provisioning_plans (client_id, created_at desc);
create index if not exists pp_profile_version_idx on public.provisioning_plans (client_id, approved_profile_version);

alter table public.provisioning_plans enable row level security;

comment on table public.provisioning_plans is
  'RLS enabled, no policies: service_role only. A deterministic, hashed provisioning plan bound to one immutable approved profile version. A plan whose profile version is no longer the approved one is stale and must not execute.';
comment on constraint pp_executed_has_mode on public.provisioning_plans is
  'An executed plan must record whether it ran in mock, dry_run or live mode — the audit trail must never be ambiguous about whether an external provider was touched.';

-- ── 3. Provisioning actions (per-action results) ────────────────────────────
create table if not exists public.provisioning_actions (
  id                        bigserial   primary key,
  plan_id                   uuid        not null references public.provisioning_plans(id) on delete cascade,
  client_id                 text        not null,
  action_kind               text        not null check (action_kind in ('create','update','noop','archive','unsupported')),
  purpose                   text        not null,
  resource_type             text        not null,
  idempotency_key           text        check (idempotency_key is null or length(idempotency_key) <= 100),
  payload_hash              text        check (payload_hash is null or length(payload_hash) = 64),

  outcome                   text        check (outcome in ('succeeded','failed','noop','already_done','recorded_locally','unsupported')),
  execution_mode            text        check (execution_mode is null or execution_mode in ('mock','dry_run','live')),
  provider_request_id       text        check (provider_request_id is null or length(provider_request_id) <= 200),
  error_code                text        check (error_code is null or length(error_code) <= 100),
  retryable                 boolean,
  attempt                   integer     not null default 1 check (attempt >= 1),

  created_at                timestamptz not null default now()
);

create index if not exists pa_plan_idx on public.provisioning_actions (plan_id, created_at);
-- One successful attempt per idempotency key per plan: the resume guard.
create unique index if not exists pa_one_success_per_key
  on public.provisioning_actions (plan_id, idempotency_key)
  where outcome = 'succeeded' and idempotency_key is not null;

alter table public.provisioning_actions enable row level security;

comment on table public.provisioning_actions is
  'RLS enabled, no policies: service_role only. Per-action provisioning results. The partial unique index means a resumed execution cannot record a second success for the same idempotency key.';

-- ── 4. Provider webhook events ──────────────────────────────────────────────
create table if not exists public.provider_webhook_events (
  id                        bigserial   primary key,
  provider                  text        not null default 'retell',
  event_type                text        not null check (length(event_type) <= 100),
  provider_call_id          text        check (provider_call_id is null or length(provider_call_id) <= 200),

  -- Retell's envelope carries no per-delivery event id, so idempotency rests on
  -- this deterministic fingerprint of (provider, event type, call id, a hash of
  -- the meaningful payload). Globally unique — that is the whole mechanism.
  fingerprint               text        not null check (length(fingerprint) = 64),

  received_at               timestamptz not null default now(),
  verification_result       text        not null check (length(verification_result) <= 50),
  processing_status         text        not null default 'received'
    check (processing_status in ('received','ignored','processed','failed','duplicate')),
  attempt_count             integer     not null default 1 check (attempt_count >= 1),

  client_id                 text,
  session_id                uuid        references public.locksmith_onboarding_sessions(session_id) on delete set null,
  provisioning_plan_id      uuid        references public.provisioning_plans(id) on delete set null,

  error_code                text        check (error_code is null or length(error_code) <= 100),
  -- Digests, counts and status only. NEVER the transcript, the recording URL
  -- content, or the analysis body — those belong on the session record, not
  -- duplicated into a long-lived event log.
  metadata                  jsonb       check (metadata is null or length(metadata::text) <= 4096),
  updated_at                timestamptz not null default now(),

  constraint pwe_fingerprint_key unique (fingerprint)
);

create index if not exists pwe_call_idx on public.provider_webhook_events (provider_call_id, received_at desc);
create index if not exists pwe_status_idx on public.provider_webhook_events (processing_status, received_at desc);
create index if not exists pwe_session_idx on public.provider_webhook_events (session_id, received_at desc);

alter table public.provider_webhook_events enable row level security;

comment on table public.provider_webhook_events is
  'RLS enabled, no policies: service_role only. Verified provider webhook deliveries. The unique fingerprint is the idempotency mechanism — a retried delivery collides and is acknowledged without reprocessing. Raw webhook bodies are deliberately NOT stored: metadata holds digests, counts and status only.';
comment on column public.provider_webhook_events.metadata is
  'Bounded, PII-light. transcript_present/transcript_chars rather than the transcript; recording_present rather than the URL.';

commit;

-- ── Foreign keys to `clients` (deliberately deferred) ───────────────────────
-- Same reasoning as M2 and client_phone_routing_profiles: clients.slug is not
-- uniquely constrained in every environment. Every read and write filters on
-- client_id in the adapter layer. To add later:
--   alter table public.provider_resources
--     add constraint pr_client_fk foreign key (client_id) references public.clients(slug) on delete cascade;
--   alter table public.provisioning_plans
--     add constraint pp_client_fk foreign key (client_id) references public.clients(slug) on delete cascade;

-- ── Verification ────────────────────────────────────────────────────────────
select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('provider_resources','provisioning_plans','provisioning_actions','provider_webhook_events')
 order by tablename;                              -- expect 4 rows, rowsecurity = t on every one

select count(*) as policy_count from pg_policies
 where schemaname = 'public'
   and tablename in ('provider_resources','provisioning_plans','provisioning_actions','provider_webhook_events');
                                                  -- expect 0 — service_role only

select indexname from pg_indexes
 where schemaname = 'public'
   and tablename in ('provider_resources','provisioning_plans','provisioning_actions','provider_webhook_events')
 order by indexname;                              -- expect pr_one_active_per_purpose,
                                                  -- pp_one_active_per_client, pa_one_success_per_key
                                                  -- among them

select conname, contype from pg_constraint
 where conrelid = 'public.provider_resources'::regclass
 order by conname;                                -- expect pr_idempotency_key (u),
                                                  -- pr_superseded_consistency, the type/purpose checks

-- No column anywhere may hold a credential. This must return zero rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('provider_resources','provisioning_plans','provisioning_actions','provider_webhook_events')
   and (column_name ilike '%api_key%' or column_name ilike '%secret%' or column_name ilike '%token%' or column_name ilike '%password%');

-- Invariant probes — both must return zero rows at all times:
select client_id, provider, purpose, resource_type, count(*)
  from public.provider_resources where active = true
 group by 1,2,3,4 having count(*) > 1;
select client_id, count(*) from public.provisioning_plans
 where status in ('approved_for_execution','executing') group by 1 having count(*) > 1;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Drop order matters: actions and events reference plans.
-- begin;
-- drop table if exists public.provider_webhook_events;
-- drop table if exists public.provisioning_actions;
-- drop table if exists public.provisioning_plans;
-- drop table if exists public.provider_resources;
-- commit;

-- ── Deferred, deliberately not in this migration ────────────────────────────
-- * Any authenticated-role RLS policy. If a client portal ever needs to see its
--   own provisioning status, it should read a narrow projection through the
--   server, not these tables directly.
-- * Webhook event retention/expiry. Rows are small and bounded; a retention job
--   needs the same legal review as transcript retention (M2 spec §12).
