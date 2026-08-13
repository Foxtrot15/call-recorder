-- ============================================================================
-- LAQ6 MUTATION PROBES (E-9) — ZERO RESIDUE BY CONSTRUCTION.
--
-- This file WRITES, and then throws all of it away.
--
-- Everything happens inside ONE transaction whose last statement is ROLLBACK.
-- Nothing here can be committed by finishing the file; a reader who stops
-- half-way and disconnects also leaves nothing behind, because an unfinished
-- transaction is rolled back by the server.
--
-- ── WHY IT EXISTS ───────────────────────────────────────────────────
-- 13_laq6_verify_readonly.sql proves the index and the guard are PRESENT.
-- Present is not the same as refuses. These six probes are the only way to
-- watch the database actually say no — and this is the founder-approved shape
-- for doing it, because acquisition_dial_executions refuses DELETE, so any row
-- committed here would be permanent and no proof is worth a permanent
-- fictional dispatch.
--
-- ── THE SIX CASES ───────────────────────────────────────────────────
--   A. NULL -> R1                            PASS
--   B. R1   -> R1                            PASS   (redelivered webhook)
--   C. R1   -> R2                            REFUSED by the write-once guard
--   D. R1   -> NULL                          REFUSED by the write-once guard
--   E. D1 holds R1, D2 claims R1             REFUSED by the unique index
--   F. D1 -> R1 and D2 -> R2                 PASS
--
-- Each expected refusal is caught in its own block, so one failure does not
-- abandon the rest of the run.
--
-- ── WHAT IT NEVER TOUCHES ───────────────────────────────────────────
-- The E-7B1 proof dispatch is READ ONLY — never updated, never resolved, and
-- its provider_ref is never bound. The calling state is read once, to refuse to
-- run at all unless calling is paused, and is never written.
--
-- ── PREREQUISITE ────────────────────────────────────────────────────
-- laq6 must be applied. Run 13_laq6_verify_readonly.sql first; if its roll-up
-- does not say PASS then this file is testing something other than laq6.
-- ============================================================================

begin;

do $$
declare
  v_prospect  text;
  v_d1        uuid := gen_random_uuid();
  v_d2        uuid := gen_random_uuid();
  v_got       text;
  v_state     text;
begin
  -- ── Interlocks, before a single row is written ───────────────────
  if to_regclass('public.acquisition_dial_executions') is null then
    raise exception 'laq5 is not applied here.';
  end if;

  if not exists (
    select 1
      from pg_index idx
      join pg_class i on i.oid = idx.indexrelid
     where i.relname = 'idx_acq_dial_exec_provider_ref'
       and idx.indisunique
  ) then
    raise exception 'laq6 has not been applied: idx_acq_dial_exec_provider_ref is absent.';
  end if;

  select state into v_state from public.acquisition_calling_state where scope = 'global';
  if v_state is distinct from 'paused' then
    raise exception 'REFUSING TO RUN: acquisition calling is "%", not paused.', coalesce(v_state, 'absent');
  end if;

  -- A real fictional prospect that holds NO unresolved dispatch, so the laq5
  -- prospect lock is free and these probes cannot collide with the E-7B1 proof
  -- row. The foreign key is why a real prospect is needed at all.
  select p.prospect_id into v_prospect
    from public.acquisition_prospects p
   where not exists (
           select 1 from public.acquisition_dial_executions d
            where d.prospect_id = p.prospect_id and d.resolved_at is null
         )
   order by p.prospect_id
   limit 1;

  if v_prospect is null then
    raise exception 'Every fictional prospect already holds an unresolved dispatch; cannot probe without touching a real lock.';
  end if;

  raise notice 'probing against fictional prospect % (dispatches % and %)', v_prospect, v_d1, v_d2;

  -- D1: UNRESOLVED. It takes the prospect and destination locks, which is fine
  -- because the prospect above holds neither.
  insert into public.acquisition_dial_executions
    (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
     authorised_at, claimed_by, provider, provider_live)
  values
    (v_d1, 'ad_laq6_probe_1', v_prospect, '+61355509901', 'ba_laq6probe',
     now(), 'laq6-probe', 'disabled', false);

  -- D2: RESOLVED on creation, so it holds NEITHER laq5 lock and can share the
  -- prospect. That is deliberate and is itself part of the point: the E-9
  -- uniqueness index applies to resolved rows too, because a provider call
  -- reference may never be rebound even to a finished dispatch.
  insert into public.acquisition_dial_executions
    (dispatch_id, authorisation_id, prospect_id, destination_e164, batch_key,
     authorised_at, claimed_by, provider, provider_live,
     resolved_at, resolution, resolved_by)
  values
    (v_d2, 'ad_laq6_probe_2', v_prospect, '+61355509902', 'ba_laq6probe',
     now(), 'laq6-probe', 'disabled', false,
     now(), 'operator_closed', 'laq6-probe');

  -- ── A. NULL -> R1 ────────────────────────────────────────────────
  begin
    update public.acquisition_dial_executions
       set provider_ref = 'call_laq6_R1'
     where dispatch_id = v_d1;
    select provider_ref into v_got from public.acquisition_dial_executions where dispatch_id = v_d1;
    raise notice '%  A. NULL -> R1 (bound to %)',
      case when v_got = 'call_laq6_R1' then 'PASS  ' else '**FAIL**' end, v_got;
  exception when others then
    raise notice '**FAIL** A. the first binding was refused: %', sqlerrm;
  end;

  -- ── B. R1 -> R1, the redelivered webhook ─────────────────────────
  begin
    update public.acquisition_dial_executions
       set provider_ref = 'call_laq6_R1'
     where dispatch_id = v_d1;
    raise notice 'PASS   B. R1 -> R1 is idempotent and permitted';
  exception when others then
    raise notice '**FAIL** B. R1 -> R1 was refused: %', sqlerrm;
  end;

  -- ── C. R1 -> R2, rebinding to a different call ───────────────────
  begin
    update public.acquisition_dial_executions
       set provider_ref = 'call_laq6_R2'
     where dispatch_id = v_d1;
    raise notice '**FAIL** C. R1 -> R2 was ACCEPTED. provider_ref is not write-once.';
  exception when others then
    raise notice '%  C. R1 -> R2 refused: %',
      case when position('acq_provider_ref_write_once' in sqlerrm) > 0 then 'PASS  ' else '**CHECK**' end,
      sqlerrm;
  end;

  -- ── D. R1 -> NULL, unbinding ─────────────────────────────────────
  --
  -- The case that makes the index mean anything: without this, a caller could
  -- clear the reference and rebind it to a second dispatch, and every single
  -- statement would satisfy the unique index on its own.
  begin
    update public.acquisition_dial_executions
       set provider_ref = null
     where dispatch_id = v_d1;
    raise notice '**FAIL** D. R1 -> NULL was ACCEPTED. A reference could be freed and rebound elsewhere.';
  exception when others then
    raise notice '%  D. R1 -> NULL refused: %',
      case when position('acq_provider_ref_write_once' in sqlerrm) > 0 then 'PASS  ' else '**CHECK**' end,
      sqlerrm;
  end;

  -- ── E. two dispatches, one reference ─────────────────────────────
  begin
    update public.acquisition_dial_executions
       set provider_ref = 'call_laq6_R1'
     where dispatch_id = v_d2;
    raise notice '**FAIL** E. ONE PROVIDER CALL WAS BOUND TO TWO DISPATCHES.';
  exception
    when unique_violation then
      raise notice 'PASS   E. a second dispatch claiming the same reference is refused by the database: %', sqlerrm;
    when others then
      raise notice '**CHECK** E. refused, but not by the uniqueness index: %', sqlerrm;
  end;

  -- ── F. different dispatches, different references ────────────────
  begin
    update public.acquisition_dial_executions
       set provider_ref = 'call_laq6_R2'
     where dispatch_id = v_d2;
    select provider_ref into v_got from public.acquisition_dial_executions where dispatch_id = v_d2;
    raise notice '%  F. D1 -> R1 and D2 -> R2 both permitted (D2 bound to %)',
      case when v_got = 'call_laq6_R2' then 'PASS  ' else '**FAIL**' end, v_got;
  exception when others then
    raise notice '**FAIL** F. two distinct references were refused: %', sqlerrm;
  end;

  raise notice '--- probes complete. Everything above is about to be rolled back. ---';
end $$;

-- ── EVERYTHING GOES BACK ────────────────────────────────────────────
rollback;

-- ============================================================================
-- AFTER RUNNING
--
--   rows added        0
--   rows changed      0
--   dev residue       UNCHANGED at 23
--   proof dispatch    untouched, still unresolved, provider_ref still NULL
--   calling state     untouched, still paused at revision 1
--
-- Confirm with 13_laq6_verify_readonly.sql §6, which re-reads exactly those.
-- ============================================================================
