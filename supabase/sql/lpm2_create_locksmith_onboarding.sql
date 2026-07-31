-- ============================================================================
-- LOCKSMITH PILOT M2 (LPM2): autonomous onboarding data model.
--
-- Three additive tables. Nothing existing is altered, renamed or dropped —
-- the v1 missed-call pipeline and every existing table are untouched.
--
--   locksmith_onboarding_sessions  one row per attempt to onboard a locksmith
--                                  by voice: the interview, its transcript and
--                                  the extraction that came out of it.
--   locksmith_business_profiles    the canonical, VERSIONED business profile.
--                                  One row per version; approval never mutates
--                                  a draft in place.
--   locksmith_onboarding_events    append-only audit trail for both.
--
-- Contracts encoded here (the app enforces the same rules — these are the
-- backstop, because "at most one approved version" is exactly the invariant
-- that survives a refactor only if the database also believes it):
--
--   * RLS enabled IN THE SAME TRANSACTION on all three (D8 — no table is born
--     unprotected; precedent: create_personal_contacts.sql,
--     phase1b_create_devices.sql, wcs1b_create_client_phone_routing_profiles.sql).
--     No policies are created: service_role (the app server) only, matching the
--     current deny-by-default posture. Deliberately NOT adding an
--     authenticated-user policy — these rows contain a business's full
--     operating configuration and its transcribed interview.
--   * client_id is clients.slug (text), the repo's canonical tenant key.
--   * unique (client_id, version) — versions are dense per tenant.
--   * PARTIAL UNIQUE INDEX on (client_id) where status='approved' — at most one
--     approved version per tenant, enforced by Postgres.
--   * Safety-critical, routing-critical and approval facts are REAL COLUMNS
--     with constraints (transfer numbers, timezone, pricing authority,
--     provisioning_ready). The twelve profile sections live in one validated
--     jsonb body — the app validates every section against
--     src/services/locksmith-profile-schema.js before any write, so this is a
--     structured document, not an opaque blob.
--   * Status values are CHECK-constrained: the lifecycles are stable and a
--     stray value would break the review UI. Service ids, tones and enum
--     vocabularies are NOT constrained here — they live in the app schema
--     module so adding a service never needs a migration.
--   * Transcript text is stored verbatim (never HTML-escaped at rest); every
--     render site escapes. Retention is a client preference recorded on the
--     profile, not enforced here — see the deferred note at the end.
--
-- REVIEW ONLY — NOT APPLIED. Apply in the Supabase SQL editor only when M3
-- begins, before LOCKSMITH_ONBOARDING_ENABLED is ever set. Until applied, every
-- adapter fails closed with "locksmith onboarding tables not provisioned"
-- (src/services/locksmith-profile-store.js), and the routes are unreachable
-- anyway: the flag defaults off.
--
-- APPLICATION ORDER: this file is self-contained and has no dependency on any
-- unapplied migration. It may be applied at any time relative to the other
-- pending files (phase1a/1b/1c, wcs1b). It requires only `clients` to exist,
-- and even that is a soft dependency — see the foreign-key note below.
-- ============================================================================

begin;

-- ── 1. Onboarding sessions ──────────────────────────────────────────────────
create table if not exists public.locksmith_onboarding_sessions (
  session_id                uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,          -- clients.slug (tenant)
  status                    text        not null default 'created'
    check (status in ('created','interview_ready','interview_in_progress','transcript_received',
                      'extraction_pending','needs_review','approved','cancelled','failed')),

  onboarding_agent_version  text,                          -- which interview agent ran
  interview_spec_version    text,                          -- src/services/locksmith-interview-spec.js version

  -- Provider is DATA, not a branch: the ingestion boundary is provider-neutral
  -- (src/services/locksmith-transcript-intake.js). 'retell' is reserved so the
  -- enum does not change when that integration lands; nothing dispatches on it.
  provider                  text        check (provider in ('fixture','retell','manual')),
  provider_call_id          text,                          -- preserved verbatim for reconciliation

  transcript_source         text,
  transcript_text           text,                          -- verbatim; escaped at every render site
  transcript_sha256         text,                          -- idempotency key for re-delivery
  transcript_metadata       jsonb,
  transcript_received_at    timestamptz,

  extraction_version        text,                          -- e.g. 'fixture-v1'
  extraction_result         jsonb,                         -- adapter output as accepted
  missing_fields            jsonb       not null default '[]'::jsonb,
  contradictions            jsonb       not null default '[]'::jsonb,
  review_warnings           jsonb       not null default '[]'::jsonb,

  profile_version           integer,                       -- the draft this session produced

  started_at                timestamptz,
  completed_at              timestamptz,
  failure_code              text,
  failure_detail            text,                          -- operator-facing; never transcript content

  created_by                text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- A webhook that retries must not create a second interview. Where a provider
  -- gives us a call id, (provider, provider_call_id) is unique across the table.
  constraint los_provider_call_key unique (provider, provider_call_id)
);

create index if not exists los_client_created_idx
  on public.locksmith_onboarding_sessions (client_id, created_at desc);
create index if not exists los_status_idx
  on public.locksmith_onboarding_sessions (status);

alter table public.locksmith_onboarding_sessions enable row level security;

comment on table public.locksmith_onboarding_sessions is
  'RLS enabled, no policies: service_role only. One row per voice-onboarding attempt. Holds the raw interview transcript — treat as sensitive business information. See docs/LOCKSMITH_ONBOARDING_SPEC.md.';
comment on column public.locksmith_onboarding_sessions.transcript_sha256 is
  'Digest of the normalised transcript. Idempotency key: a re-delivered transcript with a matching digest is accepted once, and a DIFFERENT transcript for a session that already has one is refused, never overwritten.';
comment on column public.locksmith_onboarding_sessions.failure_detail is
  'Short operator-facing explanation. Must never contain transcript content or caller PII.';

-- ── 2. Canonical business profiles (versioned) ──────────────────────────────
create table if not exists public.locksmith_business_profiles (
  id                        uuid        primary key default gen_random_uuid(),
  client_id                 text        not null,          -- clients.slug (tenant)
  version                   integer     not null check (version >= 1),
  status                    text        not null default 'draft'
    check (status in ('draft','needs_review','approved','superseded','rejected')),
  schema_version            text,                          -- locksmith-profile-YYYY-MM-DD
  session_id                uuid        references public.locksmith_onboarding_sessions(session_id) on delete set null,
  extraction_version        text,

  -- The twelve validated sections (A-L). Validated by the app against
  -- locksmith-profile-schema.js on every write; the queryable mirror below
  -- keeps the routing- and safety-critical facts out of the document.
  profile                   jsonb       not null,

  -- ── Queryable mirror: safety- and routing-critical facts ──
  business_timezone         text,
  spoken_business_name      text,
  -- E.164 Australian numbers as produced by normaliseAuNumber(): 9 digits for a
  -- mobile or landline (+61 4XX XXX XXX), 10 for a 1300/1800 service number
  -- (+61 1300 XXX XXX — the leading 1 is part of the number, not a trunk code).
  transfer_primary_number   text        check (transfer_primary_number is null or transfer_primary_number ~ '^\+61[0-9]{9,10}$'),
  transfer_backup_number    text        check (transfer_backup_number  is null or transfer_backup_number  ~ '^\+61[0-9]{9,10}$'),
  accepted_service_count    integer     not null default 0 check (accepted_service_count >= 0),
  after_hours_available     boolean,
  pricing_may_be_mentioned  boolean,
  pricing_human_confirms    boolean,
  provisioning_ready        boolean     not null default false,
  blocking_reasons          jsonb       not null default '[]'::jsonb,

  -- ── Review + approval ──
  confirmations             jsonb       not null default '{}'::jsonb,  -- section -> { confirmedAt, actorId }
  review_notes              jsonb       not null default '{}'::jsonb,
  approved_at               timestamptz,
  approved_by               text,
  approval_reason           text,
  superseded_at             timestamptz,
  superseded_by_version     integer,
  rejected_at               timestamptz,
  rejection_reason          text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint lbp_client_version_key unique (client_id, version),

  -- An approved row must carry its approval evidence; a rejected row must carry
  -- its reason. A status without its paperwork is not auditable.
  constraint lbp_approved_has_evidence check (
    status <> 'approved' or (approved_at is not null and approved_by is not null)
  ),
  constraint lbp_rejected_has_reason check (
    status <> 'rejected' or rejection_reason is not null
  ),
  -- Nothing may be approved while it is not provisioning-ready. This is the
  -- database refusing to hold an approved-but-unsafe configuration, mirroring
  -- evaluateApproval() in the app.
  constraint lbp_approved_is_ready check (
    status <> 'approved' or provisioning_ready = true
  )
);

-- AT MOST ONE approved version per tenant. The app supersedes the previous
-- version on approval; this index guarantees the invariant even if that code is
-- ever changed or a manual fix goes wrong.
create unique index if not exists lbp_one_approved_per_client
  on public.locksmith_business_profiles (client_id)
  where status = 'approved';

create index if not exists lbp_client_version_idx
  on public.locksmith_business_profiles (client_id, version desc);
create index if not exists lbp_ready_idx
  on public.locksmith_business_profiles (client_id, provisioning_ready)
  where status = 'approved';

alter table public.locksmith_business_profiles enable row level security;

comment on table public.locksmith_business_profiles is
  'RLS enabled, no policies: service_role only. Versioned canonical locksmith receptionist configuration — the single source of truth that Retell/Twilio adapters consume. Approval never mutates a draft in place; corrections create a new version. See docs/LOCKSMITH_ONBOARDING_SPEC.md.';
comment on column public.locksmith_business_profiles.profile is
  'The twelve validated sections (A-L). Structured and app-validated, not an opaque blob: routing, service, approval and safety facts are ALSO mirrored into the typed columns above so they are queryable and constrained.';
comment on column public.locksmith_business_profiles.confirmations is
  'Per-section reviewer confirmations. Approval is refused until every confirmable section carries one (transfer numbers, hours, exclusions, pricing authority and forbidden promises included).';
comment on index public.lbp_one_approved_per_client is
  'At most one approved version per tenant — the provisioning target is never ambiguous.';

-- ── 3. Append-only audit events ─────────────────────────────────────────────
create table if not exists public.locksmith_onboarding_events (
  id                        bigserial   primary key,
  client_id                 text        not null,
  session_id                uuid        references public.locksmith_onboarding_sessions(session_id) on delete set null,
  profile_version           integer,
  event_type                text        not null,          -- e.g. transcript.received, profile.approved
  actor_type                text        not null check (actor_type in ('client','operator','system')),
  actor_id                  text,
  reason                    text,
  source                    text,
  detail                    jsonb,                         -- digests and counts only, never transcript text
  created_at                timestamptz not null default now()
);

create index if not exists loe_client_created_idx
  on public.locksmith_onboarding_events (client_id, created_at desc);
create index if not exists loe_session_idx
  on public.locksmith_onboarding_events (session_id, created_at desc);

alter table public.locksmith_onboarding_events enable row level security;

comment on table public.locksmith_onboarding_events is
  'RLS enabled, no policies: service_role only. APPEND-ONLY audit trail for onboarding and profile approval. Rows are never updated or deleted. detail holds digests, counts and status pairs — never transcript content, caller PII or full phone numbers.';

commit;

-- ── Foreign keys to `clients` (deliberately deferred) ───────────────────────
-- No FK from client_id to clients.slug is created here, matching
-- client_phone_routing_profiles: clients.slug carries a unique constraint in
-- some environments and not others (the dev minimal schema differs), and a
-- migration that fails on a missing unique target is worse than an app-enforced
-- reference. Every read and write filters on client_id in the adapter layer.
-- If/when clients.slug is guaranteed unique everywhere, add:
--   alter table public.locksmith_onboarding_sessions
--     add constraint los_client_fk foreign key (client_id) references public.clients(slug) on delete cascade;
--   alter table public.locksmith_business_profiles
--     add constraint lbp_client_fk foreign key (client_id) references public.clients(slug) on delete cascade;

-- ── Verification ────────────────────────────────────────────────────────────
select tablename, rowsecurity from pg_tables
 where schemaname = 'public'
   and tablename in ('locksmith_onboarding_sessions','locksmith_business_profiles','locksmith_onboarding_events')
 order by tablename;                              -- expect 3 rows, rowsecurity = t on every one

select count(*) as policy_count from pg_policies
 where schemaname = 'public'
   and tablename in ('locksmith_onboarding_sessions','locksmith_business_profiles','locksmith_onboarding_events');
                                                  -- expect 0 — service_role only, deny by default

select conname, contype from pg_constraint
 where conrelid = 'public.locksmith_business_profiles'::regclass
 order by conname;                                -- expect pkey, lbp_client_version_key (u),
                                                  -- lbp_approved_has_evidence, lbp_rejected_has_reason,
                                                  -- lbp_approved_is_ready, the two number checks,
                                                  -- version + accepted_service_count checks, status check

select indexname from pg_indexes
 where schemaname = 'public' and tablename = 'locksmith_business_profiles'
 order by indexname;                              -- expect lbp_one_approved_per_client among them

select column_name, data_type, is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'locksmith_business_profiles'
 order by ordinal_position;                       -- expect the 28 columns above

-- Invariant probe — must return zero rows at all times:
select client_id, count(*) from public.locksmith_business_profiles
 where status = 'approved' group by client_id having count(*) > 1;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Drop order matters: events and profiles reference sessions.
-- begin;
-- drop table if exists public.locksmith_onboarding_events;
-- drop table if exists public.locksmith_business_profiles;
-- drop table if exists public.locksmith_onboarding_sessions;
-- commit;

-- ── Deferred, deliberately not in this migration ────────────────────────────
-- * Transcript/recording RETENTION enforcement. privacy.transcriptRetention on
--   the profile records the client's PREFERENCE; nothing here expires rows. A
--   retention job needs a legal review of what must be kept and for how long
--   (spec §13 legal-review items) before it is written.
-- * Any authenticated-role RLS policy. If a future client portal reads these
--   tables directly rather than through the server, the policy must be designed
--   and reviewed on its own terms — not bolted on here.
