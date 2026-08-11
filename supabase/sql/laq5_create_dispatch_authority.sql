-- ============================================================================
-- LOCKSMITH ACQUISITION E-7B1 (LAQ5): durable dispatch authority and the
-- durable emergency stop.
--
-- Two new tables, two new trigger functions, two triggers, five indexes, one
-- bootstrap row, RLS on with no policies. No existing table is altered, no
-- column added to one, no data rewritten, no existing trigger touched, no
-- existing foreign key changed.
--
-- STATUS: NOT APPLIED TO DEV. NOT APPLIED TO PRODUCTION.
-- Awaiting founder approval. Reviewed design:
-- docs/ACQUISITION_E7B1_DESIGN.md (revision 2).
--
-- ASCII ONLY, so no editor or clipboard can mangle a section heading.
--
-- -- WHAT THIS CLOSES ------------------------------------------------
-- E-7A built the dial execution seam and left it provider-disabled. Its
-- single-consumption guarantee is a WeakSet in one module in one process: a
-- second process knows nothing about the first. That is safe only for as long
-- as no live provider exists, and it is the first thing that must stop being
-- true before one does.
--
-- This migration moves the arbitration into the database, where it survives a
-- restart, a second worker and a second host.
--
-- -- WHY dispatch_id AND NOT authorisation_id ------------------------
-- The obvious key is the authorisation. It is wrong, and it was measured
-- rather than guessed: authorisation_id is a sha256 of
-- (prospect_id, e164, authorised_at, decision), so two GENUINELY DISTINCT
-- authorisations of the same business at the same millisecond produce the SAME
-- value. A unique constraint on it would refuse the second legitimate
-- authorisation as though it were a replay of the first, and the ledger would
-- record two different authorisations as one.
--
-- So dispatch_id is a random UUID minted per authorisation, and
-- authorisation_id is kept, deliberately NOT unique, as a fingerprint.
--
-- -- WHY TWO LOCKS AND NOT ONE ---------------------------------------
-- Uniqueness on the dispatch stops a REPLAY of one authorisation. It does not
-- stop two workers each minting THEIR OWN authorisation for the same business
-- seconds apart: different ids, both claim, both dial. And the attempt policy
-- cannot catch that, because minDaysBetweenAttempts is computed from
-- acquisition_contact_outcomes and neither worker has recorded an outcome yet.
--
-- Hence idx_acq_dial_exec_unresolved_prospect.
--
-- The destination lock exists for a different reason, also measured.
-- acquisition_prospect_phones is unique (prospect_id, raw) -- scoped per
-- prospect -- and stores the number AS PUBLISHED. There is no normalised e164
-- column on it at all; the only e164 index in this schema is on
-- acquisition_suppressions. Meanwhile resolveDuplicates() compares only the
-- records it is handed, so two prospects imported in separate batches are
-- never compared and neither gets a review item. Two fictional locksmiths
-- sharing one handset were both authorised to +61355501042 in a probe.
--
-- A per-prospect lock cannot see that. idx_acq_dial_exec_unresolved_destination
-- is the ONLY place in this schema where a normalised E.164 carries a
-- uniqueness rule. It intentionally blocks two genuinely separate businesses on
-- a shared answering service from having simultaneous unresolved dispatches --
-- accepted for the pilot, because the person picking up is the same person.
--
-- -- WHY resolved_at AND NOT completed_at ----------------------------
-- PROVIDER COMPLETION IS NOT RESOLUTION. A worker whose provider accepted the
-- call still holds the lock, because the question the lock protects is not
-- "did the API return" but "do we durably know what happened to this business".
--
-- resolved_at is set in exactly two ways:
--   outcome_recorded  a row exists in acquisition_contact_outcomes, so the
--                     normal M8J attempt/history policy can take over
--   operator_closed   a named human adjudicated an abnormal dispatch
--
-- Nothing else may set it. Not a provider result, not a status, not a timeout,
-- not an exception, not a reaper. A crash may create manual work; it must never
-- create a second call.
--
-- -- WHAT IS DELIBERATELY NOT HERE -----------------------------------
-- No provider adapter, no endpoint, no credential, no network. Applying this
-- migration does NOT enable calling: acquisition_calling_state is bootstrapped
-- 'paused', and there is still no provider in the repository that declares
-- itself live. Two independent locks, and this file opens neither.
--
-- No history table for calling-state changes. acquisition_decisions.entity_type
-- has admitted 'campaign' and 'system' since laq1, so the append-only,
-- hash-chained log already holds them and no SQL is needed for it.
-- ============================================================================

begin;

-- -- Dial executions ------------------------------------------------
-- Irreversible dispatch claims. One row per authorisation that was allowed to
-- reach a provider, whether or not it got there.

create table if not exists public.acquisition_dial_executions (
  -- Random per genuine mint (crypto.randomUUID). Derived from nothing, so two
  -- distinct authorisations can never collide. This is the replay invariant.
  dispatch_id       uuid        primary key,

  -- Derived fingerprint of (prospect, number, instant, decision). NOT unique,
  -- on purpose: two legitimate authorisations may share it. Correlation only.
  authorisation_id  text        not null,

  -- RESTRICT, never CASCADE. A record that we may have rung a business must not
  -- become deletable by deleting the business -- the same reason
  -- acquisition_contact_outcomes restricts, and the opposite of
  -- acquisition_call_queue, which cascades because a reservation is not
  -- evidence of anything.
  prospect_id       text        not null
                      references public.acquisition_prospects (prospect_id)
                      on delete restrict,

  -- The number the M8E gate cleared, normalised. Not "a number from the
  -- record": if those ever differ, the cleared one is the only safe answer.
  destination_e164  text        not null
                      check (destination_e164 ~ '^\+61[0-9]{6,12}$'),

  -- NOT NULL is proven rather than assumed. The eligibility engine's batch
  -- check is unconditional, and the M8E gate discards context.batch and binds
  -- the durable read itself, so an authorised decision without a durable
  -- founder approval does not exist. The mint throws rather than produce one.
  batch_key         text        not null,

  authorised_at     timestamptz not null,
  claimed_at        timestamptz not null default now(),
  claimed_by        text        not null,

  -- -- What the MECHANISM did. None of this releases the lock. --------
  provider          text        not null,
  provider_live     boolean     not null,
  provider_status   text        not null default 'pending'
                      check (provider_status in ('pending','submitted','refused','unknown')),
  -- Set once we have actually reached the provider. Its absence next to a
  -- non-pending status is what tells an operator "we crashed before sending",
  -- which is the single most important fact when deciding whether a phone rang.
  submitted_at      timestamptz,
  provider_ref      text,
  error_code        text,

  -- -- Whether the BUSINESS question is settled. The locks read this. --
  resolved_at       timestamptz,
  resolution        text
                      check (resolution in ('outcome_recorded','operator_closed')),
  resolved_by       text,
  resolution_note   text,

  created_at        timestamptz not null default now(),

  -- A resolution is all of its parts or none of them. A resolved_at with no
  -- resolution would release a lock while recording nothing about why.
  constraint acq_dial_exec_resolution_complete
    check ((resolved_at is null     and resolution is null     and resolved_by is null)
        or (resolved_at is not null and resolution is not null and resolved_by is not null)),

  -- 'submitted' and 'refused' mean we definitely reached the provider.
  -- 'unknown' is allowed with or without submitted_at, because not knowing
  -- whether we reached it is precisely what that status means.
  constraint acq_dial_exec_submission_consistent
    check ((provider_status = 'pending' and submitted_at is null)
        or (provider_status in ('submitted','refused') and submitted_at is not null)
        or (provider_status = 'unknown'))
);

-- ONE PROSPECT -> AT MOST ONE UNRESOLVED DISPATCH, across every process and
-- host. Named explicitly so the application can map 23505 to a precise refusal
-- instead of parsing error prose.
create unique index if not exists idx_acq_dial_exec_unresolved_prospect
  on public.acquisition_dial_executions (prospect_id)
  where resolved_at is null;

-- ONE DESTINATION -> AT MOST ONE UNRESOLVED DISPATCH. See the header: nothing
-- else in this schema can express it.
create unique index if not exists idx_acq_dial_exec_unresolved_destination
  on public.acquisition_dial_executions (destination_e164)
  where resolved_at is null;

create index if not exists idx_acq_dial_exec_prospect
  on public.acquisition_dial_executions (prospect_id, claimed_at desc);

create index if not exists idx_acq_dial_exec_authorisation
  on public.acquisition_dial_executions (authorisation_id);

-- For the read-only stale-dispatch report. Reporting only: nothing may resolve,
-- retry or redispatch from it.
create index if not exists idx_acq_dial_exec_open
  on public.acquisition_dial_executions (claimed_at)
  where resolved_at is null;

-- -- Dial execution guard --------------------------------------------
-- Not the shared acquisition_refuse_mutation(): this table is not append-only.
-- A dispatch has a genuine in-flight period, so its identity is immutable while
-- its outcome is written once. A pure ledger would make "is anything
-- unresolved" a fold, and a fold cannot be a unique index -- which would put
-- the invariant back in application memory, the exact thing this closes.

create or replace function public.acquisition_dial_exec_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'acquisition_dial_executions is not deletable: it records that a business may have been rung';
  end if;

  if new.dispatch_id      is distinct from old.dispatch_id
  or new.authorisation_id is distinct from old.authorisation_id
  or new.prospect_id      is distinct from old.prospect_id
  or new.destination_e164 is distinct from old.destination_e164
  or new.batch_key        is distinct from old.batch_key
  or new.authorised_at    is distinct from old.authorised_at
  or new.claimed_at       is distinct from old.claimed_at
  or new.claimed_by       is distinct from old.claimed_by then
    raise exception 'acquisition_dial_executions identity is immutable';
  end if;

  -- A resolved dispatch is finished. Reopening one would release and re-take a
  -- lock behind the application's back.
  if old.resolved_at is not null then
    raise exception
      'this dispatch was resolved at % and cannot be reopened', old.resolved_at;
  end if;

  -- Provider status is forward-only: it leaves 'pending' exactly once.
  if old.provider_status <> 'pending'
     and new.provider_status is distinct from old.provider_status then
    raise exception
      'provider status is already terminal (%)', old.provider_status;
  end if;

  return new;
end $$;

drop trigger if exists acq_dial_exec_guard on public.acquisition_dial_executions;
create trigger acq_dial_exec_guard
  before update or delete on public.acquisition_dial_executions
  for each row execute function public.acquisition_dial_exec_guard();

-- -- Calling state --------------------------------------------------
-- The durable emergency stop. GLOBAL ONLY for the pilot: one pilot, no campaign
-- table, and a founder in an emergency must not have to know which switch to
-- hit. If per-campaign stops are ever wanted, the CHECK widens and 'global'
-- keeps precedence.

create table if not exists public.acquisition_calling_state (
  -- Explicit singleton. The primary key admits exactly one value, so a second
  -- row is impossible rather than merely discouraged.
  scope       text        primary key check (scope = 'global'),

  -- No default. A row must SAY what it means; inheriting a state is how a
  -- migration accidentally enables calling.
  state       text        not null check (state in ('enabled','paused')),

  -- Increments by exactly one per change, so a MISSING history entry is
  -- detectable without the safety decision ever depending on history existing.
  revision    integer     not null default 1 check (revision > 0),

  changed_by  text        not null,
  changed_at  timestamptz not null default now(),
  reason      text        not null
);

create or replace function public.acquisition_calling_state_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'the acquisition calling state row may not be deleted: a missing row is read as BLOCK, and deleting it would hide who paused calling and why';
  end if;

  if new.revision <> old.revision + 1 then
    raise exception
      'calling state revision must increment by exactly one (was %, got %)',
      old.revision, new.revision;
  end if;

  if coalesce(btrim(new.changed_by), '') = ''
  or coalesce(btrim(new.reason), '')     = '' then
    raise exception 'a calling state change must name who made it and why';
  end if;

  -- Stamped here so an operator cannot backdate a pause.
  new.changed_at := now();
  return new;
end $$;

drop trigger if exists acq_calling_state_guard on public.acquisition_calling_state;
create trigger acq_calling_state_guard
  before update or delete on public.acquisition_calling_state
  for each row execute function public.acquisition_calling_state_guard();

-- -- Bootstrap ------------------------------------------------------
-- 'paused' is the ONLY value this migration ever writes. Applying LAQ5 does not
-- enable acquisition calling, and cannot: there is also no provider in this
-- repository that declares itself live.

insert into public.acquisition_calling_state (scope, state, revision, changed_by, reason)
values ('global', 'paused', 1, 'laq5-migration',
        'Acquisition calling is paused on creation. Enabling it is a deliberate, attributed founder action.')
on conflict (scope) do nothing;

-- -- RLS, in the same transaction as creation (D8) -------------------
-- Enabled with NO policies, which under Postgres RLS denies every non-superuser
-- role outright. service_role bypasses RLS and is the only intended reader. A
-- client must never see which businesses we are dispatching to, and must
-- certainly never be able to flip the emergency stop.

alter table public.acquisition_dial_executions enable row level security;
alter table public.acquisition_calling_state   enable row level security;

commit;

-- ============================================================================
-- VERIFICATION (run manually after applying; not part of the transaction)
-- ============================================================================
--
-- The full script is supabase/sql/verification/12_laq5_verify.sql. In short:
--
-- 1. Both tables exist with RLS on and zero policies.
--
-- 2. Calling is PAUSED, attributed, revision 1:
--      select scope, state, revision, changed_by, reason
--        from public.acquisition_calling_state;
--    Expect exactly one row, state = 'paused'.
--
-- 3. A second state row is impossible:
--      insert ... values ('global', ...)     -> 23505 on the primary key
--      insert ... values ('campaign-x', ...) -> 23514 on the scope check
--
-- 4. The state row cannot be deleted, backdated or made anonymous:
--      delete                                 -> 'may not be deleted'
--      update ... set revision = revision + 2 -> 'increment by exactly one'
--      update ... set changed_by = ''         -> 'must name who made it and why'
--
-- 5. ONE PROSPECT -> ONE UNRESOLVED DISPATCH:
--    two rows, same prospect_id, resolved_at null -> 23505 on
--    idx_acq_dial_exec_unresolved_prospect.
--
-- 6. ONE DESTINATION -> ONE UNRESOLVED DISPATCH:
--    two rows, different prospect_id, same destination_e164, resolved_at null
--    -> 23505 on idx_acq_dial_exec_unresolved_destination.
--
-- 7. THE POINT OF THE WHOLE MIGRATION -- provider completion does NOT release
--    the lock:
--      update row1 set provider_status='submitted', submitted_at=now();
--      insert row2 for the same prospect   -> still 23505
--      update row1 set resolved_at=now(), resolution='outcome_recorded',
--                     resolved_by='operator';
--      insert row2 again                   -> succeeds
--
-- 8. Identity immutable, resolution terminal, rows not deletable.
--
-- 9. Constraint pairs: resolved_at without resolution -> 23514;
--    provider_status='submitted' with submitted_at null -> 23514.
--
-- ROLLBACK
--   This migration is additive and creates two tables nothing else references.
--   To undo it before anything depends on it:
--
--     drop trigger if exists acq_dial_exec_guard      on public.acquisition_dial_executions;
--     drop trigger if exists acq_calling_state_guard  on public.acquisition_calling_state;
--     drop table   if exists public.acquisition_dial_executions;
--     drop table   if exists public.acquisition_calling_state;
--     drop function if exists public.acquisition_dial_exec_guard();
--     drop function if exists public.acquisition_calling_state_guard();
--
--   Do NOT drop public.acquisition_refuse_mutation() -- laq2 created it and
--   five other tables still depend on it. This migration does not use it.
--
--   Once a real dispatch row exists it is evidence that a business may have
--   been rung, and dropping the table destroys that evidence. At that point the
--   rollback is a restore, not a drop.
--
--   Dropping acquisition_calling_state does NOT re-enable calling: with the
--   table absent the durable read fails, and an unreadable stop BLOCKS.
-- ============================================================================
