-- ============================================================================
-- LOCKSMITH ACQUISITION M8B (LAQ2): suppression, qualification, queue, outcomes.
--
-- Four additive tables and one widened CHECK. Nothing existing is dropped or
-- renamed; no data is rewritten.
--
--   acquisition_suppressions        permanent, cross-campaign exclusions
--   acquisition_qualifications      the explainable score, with its signals
--   acquisition_call_queue          reservations — NOT a dialler queue
--   acquisition_contact_outcomes    what happened when a business was approached
--
-- STATUS: APPLIED TO DEV on 2026-08-07 (M8D), project ref wvwemitmmsdytyutaqbm,
-- after laq1. NOT APPLIED TO PRODUCTION, and neither is laq1. Verified by
-- supabase/sql/verification/04_laq2_verify.sql and proven behaviourally by
-- 05_behavioural_probes.sql. See docs/ACQUISITION_SQL_RUNBOOK.md.
--
-- ORDERING: this file assumes laq1_create_acquisition_prospects.sql has been
-- applied first. It ALTERs the lifecycle CHECK that file creates, and will fail
-- loudly rather than silently if the table is absent. laq1 is deliberately left
-- untouched: it is a reviewed artifact, and widening its CHECK in place would
-- mean the file a reviewer approved is no longer the file that gets applied.
--
-- ── WHY SUPPRESSION HAS NO FOREIGN KEY TO acquisition_prospects ─────
-- The single most important line in this file. Suppression must survive the
-- prospect record being deleted, because the failure mode is a business that
-- opted out being re-imported six months later as a fresh row and called again.
-- A foreign key with ON DELETE CASCADE would do exactly that; a foreign key
-- without one would block the delete and get removed by whoever needed to
-- delete. So suppression is keyed on the IDENTITY FINGERPRINT and the
-- NORMALISED NUMBER — values that a re-import reproduces — and holds no
-- reference to any prospect row at all.
--
-- The application enforces the same thing: acquisition-suppression.js exposes
-- no remove, delete or unsuppress, and the trigger below makes that a property
-- of the table rather than a convention of the module.
--
-- ── WHY THE QUEUE IS A TABLE AND NOT A JOB RUNNER ───────────────────
-- This holds reservations: "worker X may work prospect Y until time Z". It does
-- not hold instructions, has no status a dialler would drive, and nothing reads
-- it today — src/services/acquisition-queue.js keeps its leases in memory, and
-- this is the durable shape that memory would take. The partial unique index is
-- the point of writing it down: "one live lease per business" is a rule two
-- racing processes cannot both satisfy in application code, and can never
-- violate here.
--
-- Contracts encoded here, following laq1:
--   * RLS enabled IN THE SAME TRANSACTION on all four (D8), with NO policies —
--     service_role only. These are Niche Drops' own prospecting records about
--     businesses that are not clients, so there is no client-facing read path,
--     and no client_id column for the same reason laq1 has none.
--   * acquisition_suppressions and acquisition_contact_outcomes are APPEND-ONLY,
--     enforced by the trigger laq1 already defines. A correction is a new row.
--   * The queue and the qualification cache are NOT append-only: a lease is
--     released and a score is recomputed. Both are derived state that can be
--     rebuilt from the append-only tables, which is precisely why they may be
--     mutated and the others may not.
-- ============================================================================

begin;

-- Fail early and legibly if laq1 has not been applied, rather than part-way
-- through with a foreign key error nobody can read.
do $$
begin
  if to_regclass('public.acquisition_prospects') is null then
    raise exception
      'laq2 requires laq1_create_acquisition_prospects.sql to have been applied first.'
      using errcode = 'undefined_table';
  end if;
end;
$$;

-- ── Widen the prospect lifecycle for the engagement states (M8B) ────
--
-- laq1's CHECK lists the six acquisition states. M8B added eight engagement
-- states describing what happened when a business was approached. The
-- transition WHITELIST stays in the application (acquisition-schema.js) for the
-- reason laq1 gives: a state machine written as CHECK constraints produces
-- something nobody can read and everybody works around. This constraint only
-- keeps unknown strings out of the column.

alter table public.acquisition_prospects
  drop constraint if exists acquisition_prospects_lifecycle_check;

alter table public.acquisition_prospects
  add constraint acquisition_prospects_lifecycle_check
  check (lifecycle in (
    -- acquisition (laq1)
    'discovered','evidence_captured','review_pending',
    'review_approved','review_rejected','suppressed',
    -- engagement (laq2)
    'queued','attempted','connected','callback_requested',
    'interested','not_interested','customer','disqualified'
  ));

-- ── Suppressions ────────────────────────────────────────────────────
-- Permanent. Cross-campaign. No foreign key, by design — see the header.

create table if not exists public.acquisition_suppressions (
  id                  uuid primary key default gen_random_uuid(),

  reason              text not null
                        check (reason in ('opt_out','complaint','regulator_mention',
                                          'manual_exclusion','competitor','existing_client',
                                          'wrong_number','dncr_listed')),

  -- business  = every number this business has now or publishes later
  -- number    = this handset only
  -- An opt-out is a statement about the relationship, not about a phone.
  scope               text not null check (scope in ('business','number')),

  -- The identity fingerprint (name + locality, corporate-form stripped). This
  -- is what a re-import reproduces, and it is why re-importing cannot
  -- resurrect a business that opted out.
  fingerprint         text,

  -- E.164. NORMALISED BEFORE STORAGE, always: comparing published forms means
  -- "(03) 5550 2287" and "03-5550-2287" are different numbers, and the second
  -- one gets called.
  e164                text check (e164 is null or e164 ~ '^\+61[0-9]{6,12}$'),

  -- A business-scoped entry without an identity would suppress one handset and
  -- let the same business be called back on its other line next week.
  constraint acq_suppression_scope_key check (
    (scope = 'business' and fingerprint is not null) or
    (scope = 'number'   and e164        is not null)
  ),

  actor               text not null,
  actor_kind          text not null default 'system' check (actor_kind in ('human','system')),
  note                text not null,

  suppressed_at       timestamptz not null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_acq_suppressions_fingerprint on public.acquisition_suppressions (fingerprint) where fingerprint is not null;
create index if not exists idx_acq_suppressions_e164        on public.acquisition_suppressions (e164) where e164 is not null;
create index if not exists idx_acq_suppressions_reason      on public.acquisition_suppressions (reason);

-- ── Qualification results ───────────────────────────────────────────
-- Derived state: recomputed from the prospect and its evidence whenever either
-- changes. Stored so a founder screen need not recompute a hundred scores to
-- render a list, and so a ranking can be explained after the fact.
--
-- `signals` holds the full breakdown that produced the score. Storing the
-- number without the signals would leave "why is this one above that one?"
-- unanswerable the moment the signal table is edited.

create table if not exists public.acquisition_qualifications (
  id                  uuid primary key default gen_random_uuid(),

  prospect_id         text not null
                        references public.acquisition_prospects (prospect_id) on delete cascade,

  verdict             text not null
                        check (verdict in ('qualified','not_qualified','insufficient_information','disqualified')),
  tier                text not null check (tier in ('priority','standard','marginal','excluded')),
  score               integer not null,

  -- The full explanation: every named signal, its status, its points and why.
  signals             jsonb not null default '[]'::jsonb,
  -- Named exclusions. Not a score penalty — no amount of merit overturns one.
  disqualifiers       jsonb not null default '[]'::jsonb,
  -- What we do not know, INCLUDING the three things never visible from outside
  -- (call volume, missed-call rate, current answering arrangement). Recorded
  -- every time, so their absence can never read as "we checked and it was fine".
  unknowns            jsonb not null default '[]'::jsonb,
  -- Operator attestations that were used. An attestation is not an observation
  -- and a founder reading a ranking is entitled to tell them apart.
  attested            jsonb not null default '[]'::jsonb,

  -- Which version of the signal table produced this. A score from an older
  -- table is not comparable with a newer one, and silently mixing them is how a
  -- ranking becomes meaningless.
  policy_version      text not null default 'acq-m8b-qualification-v1',
  evaluated_at        timestamptz not null,
  created_at          timestamptz not null default now(),

  -- One current score per prospect. History lives in the decision log.
  unique (prospect_id)
);

create index if not exists idx_acq_qualifications_tier  on public.acquisition_qualifications (tier, score desc);

-- ── The call queue ──────────────────────────────────────────────────
-- Reservations, not instructions. Nothing reads this today.

create table if not exists public.acquisition_call_queue (
  id                  uuid primary key default gen_random_uuid(),

  prospect_id         text not null
                        references public.acquisition_prospects (prospect_id) on delete cascade,

  -- The number the ELIGIBILITY ENGINE cleared, not "a number from the record".
  -- If those ever differ, the cleared one is the only safe answer.
  e164                text not null check (e164 ~ '^\+61[0-9]{6,12}$'),

  worker_id           text not null,
  lease_token         text not null unique,
  granted_at          timestamptz not null,
  expires_at          timestamptz not null,
  released_at         timestamptz,
  release_reason      text,

  -- Idempotency. A retried selection must return the same reservation rather
  -- than making a second one — a network timeout between a worker and the queue
  -- must not double the day's calls.
  request_id          text unique,

  -- Why this prospect, at this position. Captured at reservation time for the
  -- audit trail; it is NOT what authorises the call. Whatever eventually dials
  -- must re-run eligibility at the moment of dialling, because a wash can
  -- expire and somebody can opt out between reservation and call.
  qualification_score integer,
  eligibility_snapshot jsonb,

  created_at          timestamptz not null default now()
);

-- ONE LIVE LEASE PER BUSINESS.
--
-- The rule the in-memory Map cannot actually guarantee. Two processes racing
-- both read "no lease", both write one, and two workers call the same
-- locksmith. A partial unique index makes that impossible regardless of
-- timing: only unreleased rows participate, so a prospect can be leased,
-- released and leased again, but never leased twice at once.
--
-- Expiry is deliberately NOT part of this index. An index predicate cannot
-- reference now() (it must be immutable), and more importantly a lease that has
-- expired without being released is a worker that died mid-call — the reaper
-- should release it explicitly and leave a row saying so, rather than have it
-- silently evaporate from the constraint.
create unique index if not exists idx_acq_queue_one_live_lease
  on public.acquisition_call_queue (prospect_id)
  where released_at is null;

create index if not exists idx_acq_queue_worker  on public.acquisition_call_queue (worker_id) where released_at is null;
create index if not exists idx_acq_queue_expires on public.acquisition_call_queue (expires_at) where released_at is null;

-- ── Contact outcomes ────────────────────────────────────────────────
-- What happened when a business was approached. Append-only: "they asked us not
-- to call again on the 3rd" does not stop being true.

create table if not exists public.acquisition_contact_outcomes (
  id                  uuid primary key default gen_random_uuid(),

  -- RESTRICT, not CASCADE. Two reasons, and the second is the one that matters.
  --
  -- Mechanically: this table is append-only, enforced by a BEFORE DELETE
  -- trigger. A cascade would fire that trigger and abort the transaction with
  -- "acquisition_contact_outcomes is append-only", which is a true but
  -- baffling error to receive when you asked to delete a prospect. RESTRICT
  -- says what is actually wrong.
  --
  -- Substantively: an outcome is the record that a conversation happened.
  -- "They asked us not to call again on the 3rd" must not become deletable by
  -- deleting the row it points at — that is the same class of mistake as
  -- putting a foreign key on the suppression table.
  prospect_id         text not null
                        references public.acquisition_prospects (prospect_id) on delete restrict,

  outcome             text not null
                        check (outcome in ('booked','qualified','not_interested','opt_out',
                                           'wrong_person','callback','voicemail','no_answer','declined')),

  -- Did we speak to THIS BUSINESS? Not "did the phone get answered". A
  -- wrong-number outcome answers yes to the second and no to the first, and
  -- recording it as a connection would put a conversation in the history that
  -- never happened.
  reached_the_business boolean not null,

  e164                text check (e164 is null or e164 ~ '^\+61[0-9]{6,12}$'),

  lifecycle_from      text not null,
  lifecycle_to        text not null,
  -- Every hop the outcome walked the prospect through, so the history reads
  -- "we called, we spoke to them, they said no" rather than "they said no".
  hops                jsonb not null default '[]'::jsonb,

  -- Whether the consequence was applied, and whether anybody had approved it.
  -- Most cooldown durations are still unapproved (A-L6, A-L8); a row that
  -- recorded only the effect would imply a rule that is not in force.
  effect              text,
  effect_approved     boolean not null default false,
  suppression_applied boolean not null default false,

  actor               text not null,
  actor_kind          text not null default 'system' check (actor_kind in ('human','system')),
  note                text not null,

  recorded_at         timestamptz not null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_acq_outcomes_prospect on public.acquisition_contact_outcomes (prospect_id, recorded_at desc);
create index if not exists idx_acq_outcomes_outcome  on public.acquisition_contact_outcomes (outcome);

-- ── Append-only enforcement ─────────────────────────────────────────
--
-- Reuses the trigger function laq1 created. Applied to the two tables that
-- record what happened, and NOT to the two that hold derived state — a lease is
-- released and a score is recomputed, and both can be rebuilt from the
-- append-only tables if they are lost.

drop trigger if exists acq_suppressions_no_update on public.acquisition_suppressions;
create trigger acq_suppressions_no_update
  before update or delete on public.acquisition_suppressions
  for each row execute function public.acquisition_refuse_mutation();

drop trigger if exists acq_outcomes_no_update on public.acquisition_contact_outcomes;
create trigger acq_outcomes_no_update
  before update or delete on public.acquisition_contact_outcomes
  for each row execute function public.acquisition_refuse_mutation();

-- ── RLS, in the same transaction as creation (D8) ───────────────────
--
-- Enabled with NO policies, which under Postgres RLS denies every non-superuser
-- role outright. service_role bypasses RLS and is the only intended reader. A
-- client must never be able to see which other businesses we are approaching,
-- and must certainly never see who has opted out.

alter table public.acquisition_suppressions      enable row level security;
alter table public.acquisition_qualifications    enable row level security;
alter table public.acquisition_call_queue        enable row level security;
alter table public.acquisition_contact_outcomes  enable row level security;

commit;

-- ============================================================================
-- VERIFICATION (run manually after applying; not part of the transaction)
-- ============================================================================
--
-- 1. RLS is on for all four new tables:
--      select relname, relrowsecurity from pg_class
--       where relname in ('acquisition_suppressions','acquisition_qualifications',
--                         'acquisition_call_queue','acquisition_contact_outcomes');
--    Expect relrowsecurity = true on every row.
--
-- 2. There are still no policies on anything acquisition-related:
--      select tablename, policyname from pg_policies
--       where tablename like 'acquisition\_%';
--    Expect zero rows.
--
-- 3. A suppression cannot be removed or edited:
--      delete from public.acquisition_suppressions where true;
--    Expect: ERROR ... is append-only: DELETE is not permitted.
--
-- 4. One live lease per business is enforced by the database, not by hope:
--      insert into public.acquisition_call_queue
--        (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
--      values ('pr_test','+61355501042','a','tok-a', now(), now() + interval '5 min'),
--             ('pr_test','+61355501042','b','tok-b', now(), now() + interval '5 min');
--    Expect: ERROR duplicate key value violates unique constraint
--            "idx_acq_queue_one_live_lease".
--    Then release the first and confirm the second is accepted:
--      update public.acquisition_call_queue set released_at = now() where lease_token = 'tok-a';
--
-- 5. A business-scoped suppression cannot be stored without an identity:
--      insert into public.acquisition_suppressions
--        (reason, scope, e164, actor, note, suppressed_at)
--      values ('opt_out','business','+61355501042','test','test', now());
--    Expect: ERROR ... violates check constraint "acq_suppression_scope_key".
--
-- 6. The lifecycle CHECK accepts the engagement states:
--      update public.acquisition_prospects set lifecycle = 'queued' where false;
--    Expect: no error (zero rows matched, but the constraint is parsed).
--
-- 7. A non-normalised number is refused, so suppression comparison stays sound:
--      insert into public.acquisition_suppressions
--        (reason, scope, e164, actor, note, suppressed_at)
--      values ('wrong_number','number','(03) 5550 1042','test','test', now());
--    Expect: ERROR ... violates check constraint on e164.
-- ============================================================================
