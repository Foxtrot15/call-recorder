-- ============================================================================
-- AIDA CLIENT PLATFORM (ACP1): durable client configuration.
--
-- Two additive tables. Nothing existing is altered, renamed or dropped.
--
--   platform_config_versions   every version of every client's configuration,
--                              and its whole lifecycle. The row IS the version;
--                              there is no separate "current pointer" table,
--                              because a pointer and a status are two truths
--                              that can disagree.
--   platform_config_events     append-only history of who did what, for the
--                              questions the version rows cannot answer:
--                              "who tried and failed", "what did the voice
--                              agent propose", "when was this read".
--
-- ── WHY THE LIFECYCLE IS COLUMNS AND THE BLUEPRINT IS JSONB ─────────────────
-- The blueprint body is a validated domain object with ~14 sections; giving it
-- 200 columns would make every schema change a migration and every read a
-- join. So it lives in one jsonb column.
--
-- But it is NOT an unvalidated blob. The application validates against
-- src/platform/client-blueprint.js before any write, the schema version is a
-- column so an old body is detectable rather than silently misread, and the
-- content hash is a column so tampering is visible. Everything a DECISION
-- switches on — status, approval, activation, tenancy, lineage — is a real
-- column with real constraints, because those are the fields where being wrong
-- means a business's telephone is answered with the wrong words.
--
-- ── THE INVARIANTS THIS FILE OWNS, NOT THE APPLICATION ──────────────────────
--
--   * ONE ACTIVE VERSION PER CLIENT. A partial unique index, so two active
--     versions are structurally impossible rather than merely avoided. This
--     matters because activation is two statements (supersede the incumbent,
--     then activate the successor) and there is no cross-table transaction in
--     this codebase. An interrupt between them leaves ZERO active — recoverable
--     by re-running, and fail-closed in the meantime — and the index makes the
--     dangerous direction unreachable.
--
--   * VERSION OWNERSHIP. unique (client_id, config_version): a version number
--     belongs to exactly one client, and the composite is what lineage FKs
--     point at, so cross-client lineage cannot be expressed.
--
--   * FROZEN CONTENT. A trigger refuses any UPDATE that changes the blueprint,
--     its hash, its identity or its approval once the row is approved, active
--     or superseded. Approving is a person taking responsibility for specific
--     words; those words cannot change underneath the approval afterwards.
--
--   * NO LIFECYCLE REGRESSION. The same trigger refuses approved/active/
--     superseded going back to draft or validated. History cannot be rewritten
--     into a shape that never happened.
--
--   * APPROVAL AND ACTIVATION COMPLETENESS. Row-level CHECKs: an approved row
--     has an approver, an instant and the hash that was approved; an active row
--     additionally has an activator and an instant; a draft has none of them.
--
--   * THE APPROVED HASH IS THE CONTENT HASH. approved_hash = content_hash is a
--     CHECK, so a row whose body was swapped after approval cannot satisfy the
--     database at all.
--
--   * EVENTS ARE APPEND-ONLY. A trigger refuses UPDATE and DELETE outright.
--
-- ── RLS POSTURE ─────────────────────────────────────────────────────────────
-- RLS enabled in the SAME transaction on both tables, with ZERO policies —
-- service_role only, matching LPM3 and the deny-by-default house rule. These
-- rows carry a business's approved wording, transfer numbers and compliance
-- position. There is no client-browser read path and there must not be one: a
-- portal that needs to show a client their own configuration reads a narrow
-- projection through the server, which already resolves the tenant from a
-- verified session (src/middleware/auth.js) rather than from anything the
-- browser sent.
--
-- ── NO CREDENTIALS, EVER ────────────────────────────────────────────────────
-- There is no column for an API key, a token or a provider secret, and the
-- verifier asserts none appears. Provider identifiers (voice id, llm id,
-- agent id) are NOT here either: they belong to provider_resources, which is a
-- different authority with a different lifecycle.
--
-- ── ACTIVATION IS NOT DEPLOYMENT ────────────────────────────────────────────
-- `status = 'active'` means "this is the configuration AIDA considers current
-- for this client". It does NOT mean anything was sent to Retell. Provisioning
-- is provider_resources' business, gated separately, and nothing in this schema
-- references it.
--
-- ── STATUS ─────────────────────────────────────────────────────────────────
-- NOT APPLIED TO DEV.
-- NOT APPLIED TO PRODUCTION.
-- NOT APPLIED ANYWHERE.
-- Nothing in this repository applies SQL, and a test asserts that. This file
-- has never been executed and no database was connected while writing it.
--
-- APPLICATION ORDER: independent. It references no other table and no other
-- migration references it, so it may be applied before or after any of the
-- laq*/lpm*/phase* files.
-- ============================================================================

begin;

-- ── 1. Configuration versions ───────────────────────────────────────────────
create table if not exists public.platform_config_versions (
  id                  uuid        primary key default gen_random_uuid(),

  -- Tenancy. clients.slug, the canonical tenant key used everywhere else in
  -- this codebase (provider_resources, provisioning_plans, the portal).
  client_id           text        not null check (length(client_id) between 1 and 64),

  -- Per-client, monotonic, and the half of the identity a human quotes.
  config_version      integer     not null check (config_version >= 1),

  -- Which blueprint schema this body was written against. A column, not a
  -- jsonb key, so "find every client still on the old schema" is an index scan
  -- rather than a full-table jsonb walk.
  schema_version      text        not null check (length(schema_version) between 1 and 100),

  status              text        not null default 'draft'
    check (status in ('draft','validated','approved','active','superseded')),

  -- ── content ──
  -- Validated by the application against client-blueprint.js before it gets
  -- here. Bounded so a runaway extensions bag cannot become a storage problem.
  blueprint           jsonb       not null check (length(blueprint::text) <= 262144),
  content_hash        text        not null check (length(content_hash) = 64),
  behaviour_hash      text        check (behaviour_hash is null or length(behaviour_hash) = 64),

  -- ── provenance ──
  created_at          timestamptz not null default now(),
  created_by          text        check (created_by is null or length(created_by) <= 200),
  source              text        not null default 'ui'
    check (source in ('ui','voice','api','import','operator')),

  -- ── lineage ──
  supersedes          integer     check (supersedes is null or supersedes >= 1),
  restored_from       integer     check (restored_from is null or restored_from >= 1),

  -- ── concurrency ──
  -- The compare-and-swap token. NULL means "never edited since creation",
  -- which is a real value an editor can hold and present back — conflating it
  -- with "no expectation" was a live bug in the in-memory authority.
  updated_at          timestamptz,
  updated_by          text        check (updated_by is null or length(updated_by) <= 200),

  -- ── validation ──
  validated_at        timestamptz,

  -- ── approval ──
  approved_at         timestamptz,
  approved_by         text        check (approved_by is null or length(approved_by) <= 200),
  approved_hash       text        check (approved_hash is null or length(approved_hash) = 64),
  approval_reason     text        check (approval_reason is null or length(approval_reason) <= 2000),

  -- ── activation ──
  activated_at        timestamptz,
  activated_by        text        check (activated_by is null or length(activated_by) <= 200),

  -- ── supersession ──
  superseded_at       timestamptz,
  superseded_by       integer     check (superseded_by is null or superseded_by >= 1),
  supersede_reason    text        check (supersede_reason is null or length(supersede_reason) <= 2000),

  -- A version number identifies one version of one client. This is also the
  -- target of the lineage foreign keys below, which is what makes cross-client
  -- lineage impossible to express rather than merely discouraged.
  constraint pcv_client_version_unique unique (client_id, config_version),

  -- The body must agree with the row about who owns it. Belt and braces with
  -- the application check, and the thing that catches a bad backfill.
  constraint pcv_body_client_matches
    check (blueprint -> 'identity' ->> 'clientId' = client_id),

  -- The body must agree with the row about which schema it is.
  constraint pcv_body_schema_matches
    check (blueprint ->> 'schemaVersion' = schema_version),

  -- A draft has no approval and no activation. Stated positively so a partly
  -- filled row cannot exist at all.
  constraint pcv_draft_is_clean
    check (status not in ('draft','validated')
           or (approved_at is null and approved_by is null and approved_hash is null
               and activated_at is null and activated_by is null)),

  -- Validated, approved and active all mean "this exact body passed validation".
  constraint pcv_validated_has_instant
    check (status not in ('validated','approved','active') or validated_at is not null),

  -- An approved row carries a named person, an instant and the hash approved.
  constraint pcv_approved_is_complete
    check (status not in ('approved','active')
           or (approved_at is not null and approved_by is not null and approved_hash is not null)),

  -- THE ANTI-TAMPER CONSTRAINT. The hash a person approved must be the hash of
  -- what is stored. A row whose body was swapped after approval cannot satisfy
  -- the database.
  constraint pcv_approved_hash_is_content_hash
    check (approved_hash is null or approved_hash = content_hash),

  -- An active row additionally carries who put it live and when.
  constraint pcv_active_is_complete
    check (status <> 'active' or (activated_at is not null and activated_by is not null)),

  -- Only active and superseded rows may carry activation metadata: an approved
  -- row that was never activated must not look as though it was.
  constraint pcv_activation_only_when_earned
    check (status in ('active','superseded') or (activated_at is null and activated_by is null)),

  -- Supersession metadata belongs to superseded rows only.
  constraint pcv_supersede_only_when_superseded
    check (status = 'superseded'
           or (superseded_at is null and superseded_by is null and supersede_reason is null)),

  -- A version cannot supersede, restore from, or be superseded by itself.
  constraint pcv_lineage_not_self
    check (supersedes    is distinct from config_version
       and restored_from is distinct from config_version
       and superseded_by is distinct from config_version),

  -- Timestamps move forward.
  constraint pcv_instants_ordered
    check ((updated_at   is null or updated_at   >= created_at)
       and (validated_at is null or validated_at >= created_at)
       and (approved_at  is null or approved_at  >= created_at)
       and (activated_at is null or activated_at >= created_at)
       and (activated_at is null or approved_at is null or activated_at >= approved_at))
);

-- ── Lineage integrity ───────────────────────────────────────────────────────
-- Composite self-references. Because client_id is part of the key, a version
-- can only ever point at another version OF THE SAME CLIENT. Cross-client
-- lineage is not "checked" — it is unrepresentable.
--
-- MATCH SIMPLE (the default) means a NULL lineage column satisfies the
-- constraint, which is what we want: most versions supersede nothing.
--
-- NOT VALID so the constraint applies to new rows without demanding a full
-- scan at apply time; validate separately when convenient.
alter table public.platform_config_versions
  add constraint pcv_supersedes_fk
  foreign key (client_id, supersedes)
  references public.platform_config_versions (client_id, config_version)
  on delete restrict
  not valid;

alter table public.platform_config_versions
  add constraint pcv_restored_from_fk
  foreign key (client_id, restored_from)
  references public.platform_config_versions (client_id, config_version)
  on delete restrict
  not valid;

alter table public.platform_config_versions
  add constraint pcv_superseded_by_fk
  foreign key (client_id, superseded_by)
  references public.platform_config_versions (client_id, config_version)
  on delete restrict
  not valid;

-- ── THE ONE-ACTIVE AUTHORITY ────────────────────────────────────────────────
-- Not an application check somebody has to remember to call. Two active
-- versions for one client cannot be written, whatever the application does,
-- however many workers race, and whenever a process dies mid-activation.
create unique index if not exists pcv_one_active_per_client
  on public.platform_config_versions (client_id)
  where status = 'active';

-- Read paths.
create index if not exists pcv_by_client_version
  on public.platform_config_versions (client_id, config_version desc);
create index if not exists pcv_by_client_status
  on public.platform_config_versions (client_id, status);
create index if not exists pcv_by_content_hash
  on public.platform_config_versions (content_hash);
create index if not exists pcv_by_schema_version
  on public.platform_config_versions (schema_version);

-- ── FROZEN CONTENT + NO LIFECYCLE REGRESSION ────────────────────────────────
-- The CHECKs above describe what a row may look like. This describes what a
-- row may BECOME, which CHECKs cannot express because they never see the old
-- value.
create or replace function public.pcv_guard_frozen_rows()
returns trigger
language plpgsql
as $$
begin
  -- Identity never changes, at any status. A version that could be renamed to
  -- another client or another number is not an audit record.
  if new.id             is distinct from old.id
     or new.client_id      is distinct from old.client_id
     or new.config_version is distinct from old.config_version
     or new.created_at     is distinct from old.created_at then
    raise exception
      'platform_config_versions: identity is immutable (client=% version=%)',
      old.client_id, old.config_version
      using errcode = 'check_violation';
  end if;

  if old.status in ('approved','active','superseded') then
    -- Content and approval are frozen once a person has taken responsibility
    -- for them.
    if new.blueprint::text is distinct from old.blueprint::text
       or new.content_hash   is distinct from old.content_hash
       or new.schema_version is distinct from old.schema_version
       or new.created_by     is distinct from old.created_by
       or new.source         is distinct from old.source
       or new.approved_at    is distinct from old.approved_at
       or new.approved_by    is distinct from old.approved_by
       or new.approved_hash  is distinct from old.approved_hash then
      raise exception
        'platform_config_versions: client=% version=% is % — content and approval are immutable; create a new version instead',
        old.client_id, old.config_version, old.status
        using errcode = 'check_violation';
    end if;

    -- Lifecycle only moves forward from here: approved -> active -> superseded,
    -- or straight to superseded. Never back to a draft.
    if new.status not in ('approved','active','superseded') then
      raise exception
        'platform_config_versions: client=% version=% cannot go from % back to %',
        old.client_id, old.config_version, old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- An active version's only exit is supersession.
    if old.status = 'active' and new.status not in ('active','superseded') then
      raise exception
        'platform_config_versions: client=% version=% is active and may only be superseded',
        old.client_id, old.config_version
        using errcode = 'check_violation';
    end if;

    -- Superseded is terminal.
    if old.status = 'superseded' and new.status <> 'superseded' then
      raise exception
        'platform_config_versions: client=% version=% is superseded and cannot be revived — restore creates a NEW draft',
        old.client_id, old.config_version
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists pcv_guard_frozen_rows_trg on public.platform_config_versions;
create trigger pcv_guard_frozen_rows_trg
  before update on public.platform_config_versions
  for each row execute function public.pcv_guard_frozen_rows();

-- A configuration version is never deleted. History that can be deleted is not
-- history, and an approval nobody can find is an approval that did not happen.
create or replace function public.pcv_refuse_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'platform_config_versions: rows are never deleted (client=% version=%) — supersede instead',
    old.client_id, old.config_version
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists pcv_refuse_delete_trg on public.platform_config_versions;
create trigger pcv_refuse_delete_trg
  before delete on public.platform_config_versions
  for each row execute function public.pcv_refuse_delete();

-- ── 2. Configuration events ─────────────────────────────────────────────────
-- The version rows answer "what is the configuration and who approved it".
-- They cannot answer "who tried to and was refused", "what did the voice agent
-- propose", or "who looked". This does.
create table if not exists public.platform_config_events (
  id                uuid        primary key default gen_random_uuid(),
  client_id         text        not null check (length(client_id) between 1 and 64),
  config_version    integer     check (config_version is null or config_version >= 1),

  event_type        text        not null
    check (event_type in (
      'draft_created','draft_updated','validated','validation_failed',
      'approved','approval_refused','activated','activation_refused',
      'superseded','restored','voice_patch_proposed','voice_patch_refused',
      'previewed'
    )),

  -- WHO. Text rather than a foreign key: an actor may be an operator, a client
  -- user, an importer or a future voice agent, and they do not share a table.
  actor             text        check (actor is null or length(actor) <= 200),
  actor_role        text        check (actor_role is null or actor_role in
                                       ('operator','client_owner','client_editor','client_viewer','voice_agent','system','import')),
  source            text        check (source is null or source in ('ui','voice','api','import','operator')),

  occurred_at       timestamptz not null default now(),

  -- Bounded, and redacted by the application before it arrives. No transcript,
  -- no credential, no integration secret — the verifier asserts there is no
  -- column that could hold one.
  metadata          jsonb       check (metadata is null or length(metadata::text) <= 4096)
);

create index if not exists pce_by_client_time
  on public.platform_config_events (client_id, occurred_at desc);
create index if not exists pce_by_client_version
  on public.platform_config_events (client_id, config_version);
create index if not exists pce_by_type
  on public.platform_config_events (event_type);

-- APPEND-ONLY. An audit log that can be edited is a rumour.
create or replace function public.pce_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'platform_config_events is append-only (attempted % on client=%)',
    tg_op, coalesce(old.client_id, new.client_id)
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists pce_append_only_trg on public.platform_config_events;
create trigger pce_append_only_trg
  before update or delete on public.platform_config_events
  for each row execute function public.pce_append_only();

-- ── RLS, in the same transaction (D8) ───────────────────────────────────────
alter table public.platform_config_versions enable row level security;
alter table public.platform_config_events   enable row level security;
-- Deliberately NO policies. service_role only. See the header.

-- ── Comments ────────────────────────────────────────────────────────────────
comment on table public.platform_config_versions is
  'AIDA client platform: every version of every client''s configuration and its full lifecycle. Active means "the configuration AIDA considers current", NOT "deployed to a provider". Service-role only.';
comment on column public.platform_config_versions.client_id is
  'clients.slug — the canonical tenant key. Also half of the composite the lineage foreign keys point at, so cross-client lineage is unrepresentable.';
comment on column public.platform_config_versions.blueprint is
  'The validated client blueprint. Validated by src/platform/client-blueprint.js BEFORE any write — never an unvalidated blob.';
comment on column public.platform_config_versions.content_hash is
  'sha256 of the canonical blueprint. approved_hash must equal it, so a body swapped after approval cannot satisfy the database.';
comment on column public.platform_config_versions.updated_at is
  'The compare-and-swap token. NULL means never edited since creation — a real value an editor holds, distinct from "no expectation".';
comment on index public.pcv_one_active_per_client is
  'THE one-active authority. Two active versions for one client are structurally impossible, whatever the application does.';
comment on table public.platform_config_events is
  'Append-only configuration history: who did what, including what was REFUSED. Bounded, redacted metadata. Service-role only.';

commit;

-- ============================================================================
-- VERIFICATION — read-only, safe to run any time.
-- The full verifier lives in supabase/sql/verification/19_acp1_verify_readonly.sql
-- ============================================================================

-- Both tables exist and RLS is on.
select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_config_events')
 order by tablename;                       -- expect 2 rows, rowsecurity = t on both

-- Zero policies — service_role only.
select count(*) as policy_count from pg_policies
 where schemaname = 'public'
   and tablename in ('platform_config_versions','platform_config_events');   -- expect 0

-- The one-active authority exists.
select indexname, indexdef from pg_indexes
 where schemaname = 'public' and indexname = 'pcv_one_active_per_client';    -- expect 1 row, WHERE status = 'active'

-- No column anywhere may hold a credential. Must return zero rows:
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and table_name in ('platform_config_versions','platform_config_events')
   and (column_name ilike '%api_key%' or column_name ilike '%secret%'
        or column_name ilike '%token%' or column_name ilike '%password%'
        or column_name ilike '%credential%');

-- The migration creates NO rows. Both must be 0 immediately after applying:
select count(*) as version_rows from public.platform_config_versions;
select count(*) as event_rows   from public.platform_config_events;

-- Invariant probe — must return zero rows at all times:
select client_id, count(*) as active_count
  from public.platform_config_versions
 where status = 'active'
 group by client_id having count(*) > 1;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- begin;
-- drop trigger if exists pce_append_only_trg on public.platform_config_events;
-- drop trigger if exists pcv_refuse_delete_trg on public.platform_config_versions;
-- drop trigger if exists pcv_guard_frozen_rows_trg on public.platform_config_versions;
-- drop function if exists public.pce_append_only();
-- drop function if exists public.pcv_refuse_delete();
-- drop function if exists public.pcv_guard_frozen_rows();
-- drop table if exists public.platform_config_events;
-- drop table if exists public.platform_config_versions;
-- commit;
--
-- NOTE: pcv_refuse_delete_trg blocks DELETE, not DROP TABLE. The rollback works.
-- It also destroys every approval record, which is the point of writing it down
-- rather than improvising it at 2am.

-- ============================================================================
-- DEFERRED, DELIBERATELY NOT IN THIS MIGRATION
-- ============================================================================
-- * A foreign key to public.clients(slug). LPM3 defers the same one and
--   documents why: it would be ON DELETE CASCADE, and a configuration history
--   is exactly the thing that should survive a client row being tidied away.
--   Add it only alongside a decided retention position.
--
-- * Any authenticated-role RLS policy. A client portal showing a business its
--   own configuration reads a narrow projection through the server, which
--   already resolves the tenant from a verified session.
--
-- * An activation RPC. Activation is two statements and this codebase has no
--   cross-table transactions (see acquisition-durable.js:302). The partial
--   unique index makes the dangerous interleaving — two active — impossible,
--   and the safe one — zero active — is fail-closed and fixed by re-running
--   activation, which is idempotent. If activation ever needs to be atomic
--   rather than merely safe, it is a single plpgsql function taking
--   (client_id, config_version, activated_by), and it belongs in its own
--   reviewed migration.
--
-- * Retention/expiry for platform_config_events. Rows are small and bounded,
--   and deleting audit history needs the same review as transcript retention.
