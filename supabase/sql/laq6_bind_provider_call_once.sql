-- ============================================================================
-- LAQ6 — ONE PROVIDER CALL, ONE DISPATCH (E-9).
--
-- STATUS: NOT APPLIED ANYWHERE. Written 2026-08-13, awaiting a founder applying
-- it by hand in the dev SQL editor. Nothing in this repository can execute DDL
-- and a test asserts that.
--
-- Requires laq5_create_dispatch_authority.sql. It REPLACES that file's guard
-- function; laq5 itself is left untouched, for the reason laq2 gives about
-- laq1 — the file a reviewer approved must stay the file that was applied.
--
-- ── WHAT THIS CLOSES ────────────────────────────────────────────────
-- laq5 stores the provider's own call reference in `provider_ref` and puts no
-- constraint on it at all. Two separate defects follow, and only the first was
-- known before this migration was designed:
--
--   A. CROSS-DISPATCH. Nothing stops one provider call being bound to two
--      dispatches. The application never even checks: acquisition-call-events
--      inspects the CURRENT dispatch's own provider_ref and never asks whether
--      that call already belongs to somebody else. There is no SELECT for it
--      anywhere, and adding one would only be a second read-then-write.
--
--   B. SAME-DISPATCH. The application does check `if (!dispatch.providerRef)`
--      before writing — but that is read-then-write across processes. Two
--      workers can both read NULL, one wants R1 and the other R2, and both
--      checks pass before either commits. A unique index does NOT stop this,
--      because R1 and R2 are different values and neither collides.
--
-- So uniqueness alone is necessary and NOT sufficient. B needs the value to be
-- WRITE-ONCE, enforced where the race actually resolves.
--
-- ── WHY THE KEY IS provider_ref AND NOT (provider, provider_ref) ─────
-- The strictly correct semantic is "one external provider call, identified
-- within its own provider's namespace, belongs to one dispatch" — which argues
-- for the composite key. It was rejected, deliberately:
--
--   * A composite key is only SOUND if `provider` is itself sticky. Otherwise
--     changing `provider` frees the same reference to be bound again, and the
--     index that was supposed to arbitrate simply does not apply. Making
--     `provider` write-once as well is more machinery for a case that does not
--     exist.
--   * `provider_ref` alone is strictly STRONGER and cannot be defeated by
--     mutating any other column.
--   * The only cost is a hypothetical false conflict, if a second provider ever
--     issued a textually identical reference. That fails SAFE: the bind is
--     refused, the dispatch keeps its locks and stays unresolved, and a human
--     reconciles. It never admits a duplicate.
--
-- There is one live provider planned. If a second is ever added and a genuine
-- collision is observed, this is revisited with evidence rather than with
-- speculation.
--
-- `provider` is in practice already write-once: updateDialExecution maps eight
-- columns and `provider` is not among them, in either the adapter or the
-- in-memory twin. No guard is added for it, because no path can write it.
--
-- ── WHY THE INDEX IS NOT PARTIAL ON resolved_at ─────────────────────
-- laq5's two locks are `where resolved_at is null` because a business may
-- legitimately be dispatched again once an outcome is recorded. A provider call
-- reference is different in kind: it names one real telephone call, for ever,
-- and may never be rebound — not after resolution, not ever. So uniqueness here
-- holds across the whole table.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────
-- It rewrites no row, creates no row, deletes no row, adds no policy, changes
-- no RLS, touches neither the calling-state bootstrap nor the E-7B1 proof
-- dispatch. It adds one index and replaces one function body.
--
-- IT MUST FAIL RATHER THAN REPAIR. `create unique index` against data holding a
-- duplicate raises 23505 and rolls the whole transaction back. That is
-- intended: a historical duplicate is evidence that one telephone call was
-- attributed to two businesses, and a migration must never quietly delete
-- evidence to make itself succeed.
-- ============================================================================

begin;

-- Fail early and legibly if laq5 has not been applied.
do $$
begin
  if to_regclass('public.acquisition_dial_executions') is null then
    raise exception
      'laq6 requires laq5_create_dispatch_authority.sql to have been applied first.'
      using errcode = 'undefined_table';
  end if;
end;
$$;

-- ── 1. INVARIANT A — CROSS-DISPATCH UNIQUENESS ──────────────────────
--
-- One non-null provider call reference belongs to at most one dispatch, and
-- POSTGRES decides it, not the order two workers happened to read in.
--
-- The predicate is about index size and intent, not NULL correctness: Postgres
-- already treats NULLs as distinct in a unique index, so the many unbound rows
-- would be admitted either way. They simply do not belong in the index.
create unique index if not exists idx_acq_dial_exec_provider_ref
  on public.acquisition_dial_executions (provider_ref)
  where provider_ref is not null;

-- ── 2. INVARIANT B — SAME-DISPATCH STICKINESS ───────────────────────
--
-- The laq5 guard, reproduced in full with ONE new rule. It is restated rather
-- than patched because a trigger function has no partial replacement, and a
-- reviewer should be able to read the whole thing that will be running.
--
-- The new rule is the last one. Everything above it is laq5 unchanged.
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

  -- ── NEW IN LAQ6 (E-9): provider_ref is WRITE-ONCE ─────────────────
  --
  -- Permitted:   NULL -> R      (the first and only binding)
  --              R    -> R      (a redelivered webhook, idempotent)
  --              any update that leaves provider_ref alone
  --
  -- Refused:     R1   -> R2     (rebinding to a different call)
  --              R    -> NULL   (unbinding, which would free the reference
  --                              and let the uniqueness index be walked around)
  --
  -- The unbinding case is the one worth spelling out: without it, a caller
  -- could clear provider_ref and then bind the same reference to a second
  -- dispatch, and every individual statement would satisfy the unique index.
  -- Write-once is what makes the index mean what it claims.
  --
  -- The message carries a stable machine token so the service layer can
  -- classify it without parsing English prose, and a distinct SQLSTATE so it is
  -- never mistaken for the unique violation, which is a DIFFERENT problem with
  -- a different investigation.
  if old.provider_ref is not null
     and new.provider_ref is distinct from old.provider_ref then
    raise exception
      'acq_provider_ref_write_once: dispatch % is already bound to provider reference %; provider_ref is write-once and may not be changed or cleared',
      old.dispatch_id, old.provider_ref
      using errcode = '23514';
  end if;

  return new;
end $$;

-- Re-attached exactly as laq5 attached it: BEFORE, row-level, on UPDATE and
-- DELETE. `create or replace function` alone would have been enough, since the
-- trigger points at the function by name — this is restated so that applying
-- laq6 to a database where the trigger was somehow dropped still leaves it in
-- the correct state.
drop trigger if exists acq_dial_exec_guard on public.acquisition_dial_executions;
create trigger acq_dial_exec_guard
  before update or delete on public.acquisition_dial_executions
  for each row execute function public.acquisition_dial_exec_guard();

commit;

-- ============================================================================
-- AFTER APPLYING
--
--   rows created            0
--   rows rewritten          0
--   rows deleted            0
--   policies added          0
--   RLS changes             none
--   calling state           untouched
--   E-7B1 proof dispatch    untouched, still unresolved, provider_ref still NULL
--
--   Total dev acquisition residue: UNCHANGED at 23.
--
-- Verify with:
--   supabase/sql/verification/13_laq6_verify_readonly.sql   (read-only, safe)
--   supabase/sql/verification/14_laq6_mutation_probes.sql   (BEGIN … ROLLBACK)
-- ============================================================================
