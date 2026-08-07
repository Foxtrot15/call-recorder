-- ============================================================================
-- LOCKSMITH ACQUISITION A1 (LAQ1): prospect intelligence and evidence.
--
-- Four additive tables. Nothing existing is altered, renamed or dropped.
--
--   acquisition_prospects        a candidate business and its lifecycle state
--   acquisition_evidence         append-only: what we know and where from
--   acquisition_decisions        append-only, hash-chained: what we decided
--   acquisition_prospect_phones  published numbers, one row each
--
-- STATUS: APPLIED TO DEV on 2026-08-07 (M8D), project ref wvwemitmmsdytyutaqbm.
-- NOT APPLIED TO PRODUCTION. Verified by supabase/sql/verification/02 and 03.
-- See docs/ACQUISITION_SQL_RUNBOOK.md and docs/LOCKSMITH_ACQUISITION_SPEC.md.
--
-- WHY THE EVIDENCE AND DECISION TABLES ARE SEPARATE
-- Evidence is about the WORLD and can legitimately be superseded when the world
-- changes (a business republishes its number). Decisions are about US and can
-- never be revised — "we approved this on the 3rd" does not stop being true
-- because we later wish it were not. One table with a `kind` column would
-- eventually grow an UPDATE path for the evidence case that also reached the
-- decision rows. Two tables, two sets of grants, one of which never gets an
-- update path at all.
--
-- WHY THERE IS NO client_id ON THESE TABLES
-- Every other table in Aida is tenant-scoped by client_id because it holds a
-- CLIENT's data. These hold Niche Drops' own prospecting records about
-- businesses that are not clients and have no account. Adding a client_id would
-- imply a tenant relationship that does not exist, and would invite a future
-- "let clients see their own prospects" feature that must never exist: a client
-- must never be able to read who else we are approaching. Access is
-- service_role only, forever.
--
-- Contracts encoded here:
--   * RLS enabled IN THE SAME TRANSACTION on all four (D8), no policies —
--     service_role only. There is no client-facing read path to any of this.
--   * acquisition_evidence and acquisition_decisions are APPEND-ONLY. This is
--     enforced by a trigger that raises on UPDATE and DELETE, not merely by
--     convention or by withheld grants — a future migration that grants UPDATE
--     would otherwise silently open the door.
--   * The decision log is hash-chained (prev_hash / entry_hash) so a row that
--     is altered or removed in the database is detectable afterwards. The
--     application verifier is verifyRows() in
--     src/services/acquisition-audit.js; the chain is stored, not recomputed.
--   * capture_mode CHECK deliberately EXCLUDES 'live_fetch'. This build cannot
--     capture evidence from a live website, and the database refuses to store a
--     row claiming otherwise. When a live capture path is eventually built, the
--     CHECK has to be widened deliberately, which is a reviewable change.
--   * Evidence is never deleted to correct it — supersedes_id points at the row
--     it replaces and BOTH remain readable.
--   * lifecycle transitions are constrained by CHECK to the known states; the
--     transition WHITELIST lives in the application (acquisition-schema.js),
--     because expressing a state machine in CHECK constraints produces
--     something nobody can read and everybody works around.
-- ============================================================================

begin;

-- ── Prospects ───────────────────────────────────────────────────────

create table if not exists public.acquisition_prospects (
  id                  uuid primary key default gen_random_uuid(),

  -- Deterministic id derived from the identity fingerprint (name + locality).
  -- Unique so the same business discovered twice collides here rather than
  -- becoming two prospects that both get called.
  prospect_id         text not null unique,
  schema_version      text not null default 'acq-1',

  -- Identity, exactly as published. Never normalised, never corrected in place.
  business_name       text not null,
  legal_name          text,
  abn                 text,
  trade_category      text,

  -- Locality. `state` here is the AUSTRALIAN state; the lifecycle is `lifecycle`.
  suburb              text,
  state               text,
  postcode            text,
  region              text,

  -- A compliance input, not a display field: calling hours are checked in the
  -- business's local time, so a prospect without one cannot be assessed.
  timezone            text not null,

  origin              text not null
                        check (origin in ('fixture','manual_entry','operator_import','inbound_referral')),
  discovered_at       timestamptz not null,
  discovered_by       text,
  notes               text,

  lifecycle           text not null default 'discovered'
                        check (lifecycle in ('discovered','evidence_captured','review_pending',
                                             'review_approved','review_rejected','suppressed')),

  -- Append-only journal of state changes: [{from,to,at,actor,reason}].
  history             jsonb not null default '[]'::jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_acq_prospects_lifecycle on public.acquisition_prospects (lifecycle);
create index if not exists idx_acq_prospects_region    on public.acquisition_prospects (region, suburb);

-- ── Published phone numbers ─────────────────────────────────────────
-- One row per published number. Separate from the prospect because a business
-- legitimately publishes several, and because A2 attaches per-number facts
-- (normalised form, DNCR wash, suppression) that do not belong on the business.

create table if not exists public.acquisition_prospect_phones (
  id                  uuid primary key default gen_random_uuid(),
  prospect_id         text not null references public.acquisition_prospects (prospect_id) on delete restrict,

  -- The number AS PUBLISHED. Never rewritten — this is the thing a reviewer
  -- checks against the source.
  raw                 text not null,
  label               text,

  -- Which evidence row published it. A number with no evidence is caught at
  -- review; the column is nullable so that gap is visible rather than blocking
  -- the insert and losing the record entirely.
  evidence_id         text,

  created_at          timestamptz not null default now(),

  unique (prospect_id, raw)
);

create index if not exists idx_acq_phones_prospect on public.acquisition_prospect_phones (prospect_id);

-- ── Evidence (APPEND-ONLY) ──────────────────────────────────────────

create table if not exists public.acquisition_evidence (
  id                  uuid primary key default gen_random_uuid(),
  evidence_id         text not null unique,
  schema_version      text not null default 'acq-1',
  sequence            bigint not null,

  prospect_id         text not null references public.acquisition_prospects (prospect_id) on delete restrict,

  kind                text not null
                        check (kind in ('business_name','legal_name','abn','phone','address',
                                        'service_area','trade_category','website','operating_status')),

  -- 'live_fetch' is deliberately ABSENT. This build cannot fetch a live page,
  -- and the database will not store a row that claims it did.
  capture_mode        text not null
                        check (capture_mode in ('fixture','operator_entry','operator_import')),

  value               text not null,
  excerpt             text,
  note                text,

  observed_at         timestamptz not null,
  recorded_at         timestamptz not null,
  captured_by         text not null,

  -- Provenance. source_official is stored rather than derived so that a later
  -- change to the host tables cannot retroactively reclassify old evidence.
  source_type         text not null
                        check (source_type in ('government_register','official_website','verified_directory',
                                               'unverified_directory','aggregator','social_profile',
                                               'map_listing','unknown')),
  source_official     boolean not null,
  source_url          text,
  source_domain       text,
  source_register     text,
  source_identifier   text,
  source_label        text,
  source_caveats      jsonb not null default '[]'::jsonb,

  -- True only when a human actually verified it. Fixture data is false forever.
  authoritative       boolean not null default false,

  -- A correction is a NEW row pointing at the one it replaces. Both remain.
  supersedes_id       text references public.acquisition_evidence (evidence_id) on delete restrict,

  content_hash        text not null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_acq_evidence_prospect on public.acquisition_evidence (prospect_id, kind);
create index if not exists idx_acq_evidence_super    on public.acquisition_evidence (supersedes_id);

-- ── Decisions (APPEND-ONLY, HASH-CHAINED) ───────────────────────────

create table if not exists public.acquisition_decisions (
  id                  uuid primary key default gen_random_uuid(),
  audit_id            text not null unique,
  schema_version      text not null default 'acq-1',
  sequence            bigint not null,

  -- 'queue' was added in M8B (reserving a prospect for a worker, releasing it,
  -- completing it). Corrected here rather than by an ALTER in laq2 because this
  -- file has never been applied: amending an unapplied migration leaves one
  -- readable statement, whereas a compensating ALTER would preserve a history
  -- that never happened and leave a reader wondering which one is current.
  entity_type         text not null
                        check (entity_type in ('prospect','phone','batch','queue',
                                               'suppression','campaign','system')),
  entity_id           text not null,
  event               text not null,

  decision            text not null
                        check (decision in ('pass','veto','defer','approve','reject','record','error')),

  -- WHO, and whether it was a person. Both are required: an approval nobody
  -- can be named for is indistinguishable from one nobody made.
  actor               text not null,
  actor_kind          text not null default 'system' check (actor_kind in ('human','system')),
  reason              text not null,

  -- Structured proof, not a log string — the artifact a complaint is answered
  -- with.
  detail              jsonb,
  correlation_id      text,

  -- The chain. prev_hash of the first row is 64 zeroes.
  prev_hash           text not null,
  entry_hash          text not null,

  recorded_at         timestamptz not null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_acq_decisions_entity      on public.acquisition_decisions (entity_type, entity_id);
create index if not exists idx_acq_decisions_correlation on public.acquisition_decisions (correlation_id);
create index if not exists idx_acq_decisions_sequence    on public.acquisition_decisions (sequence);

-- ── Append-only enforcement ─────────────────────────────────────────
--
-- Withholding UPDATE/DELETE grants is not enough: these tables are reached by
-- service_role, which has them. A trigger makes the refusal a property of the
-- table itself, so a future migration or an ad-hoc console session cannot
-- quietly rewrite history.

create or replace function public.acquisition_refuse_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Table % is append-only: % is not permitted. Correct a record by inserting a new row that supersedes it.',
    tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists acq_evidence_no_update on public.acquisition_evidence;
create trigger acq_evidence_no_update
  before update or delete on public.acquisition_evidence
  for each row execute function public.acquisition_refuse_mutation();

drop trigger if exists acq_decisions_no_update on public.acquisition_decisions;
create trigger acq_decisions_no_update
  before update or delete on public.acquisition_decisions
  for each row execute function public.acquisition_refuse_mutation();

-- ── RLS, in the same transaction as creation (D8) ───────────────────
--
-- Enabled with NO policies. Under Postgres RLS that denies every non-superuser
-- role outright; service_role bypasses RLS and is the only intended reader.
-- These rows are Niche Drops' own prospecting records — there is deliberately
-- no client-facing read path, because a client must never be able to see which
-- other businesses we are approaching.

alter table public.acquisition_prospects       enable row level security;
alter table public.acquisition_prospect_phones enable row level security;
alter table public.acquisition_evidence        enable row level security;
alter table public.acquisition_decisions       enable row level security;

commit;

-- ============================================================================
-- VERIFICATION (run manually after applying; not part of the transaction)
-- ============================================================================
--
-- 1. RLS is on for all four:
--      select relname, relrowsecurity from pg_class
--       where relname like 'acquisition\_%' order by relname;
--    Expect relrowsecurity = true on every row.
--
-- 2. There are no policies:
--      select tablename, policyname from pg_policies
--       where tablename like 'acquisition\_%';
--    Expect zero rows.
--
-- 3. Append-only is enforced, not just intended:
--      update public.acquisition_evidence set value = 'x' where true;
--    Expect: ERROR ... is append-only: UPDATE is not permitted.
--
-- 4. The offline boundary reaches the database:
--      insert into public.acquisition_evidence (..., capture_mode, ...)
--      values (..., 'live_fetch', ...);
--    Expect: ERROR ... violates check constraint.
-- ============================================================================
