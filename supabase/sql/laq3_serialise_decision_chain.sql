-- ============================================================================
-- LOCKSMITH ACQUISITION M8I (LAQ3): one successor per chain head.
--
-- One additive unique index. No table is altered, no column added, no data
-- rewritten, no trigger touched, no foreign key changed, no policy created.
--
-- STATUS: NOT APPLIED. Written and reviewed; it has not been run against any
-- database. Apply to DEV ONLY, by hand, after
-- supabase/sql/verification/08_laq3_preflight.sql comes back clean.
-- See docs/ACQUISITION_SQL_RUNBOOK.md.
--
-- ASCII ONLY, so no editor or clipboard can mangle a section heading.
--
-- -- WHAT THIS ENFORCES, AND WHY IT IS THE WHOLE MILESTONE -----------
-- acquisition_decisions is an append-only, hash-chained decision log. Every row
-- names its predecessor in prev_hash. M8H made a fresh process CONTINUE that
-- chain across a restart instead of starting a second one, and proved it -- but
-- only for a single sequential writer. Two processes that read the same head H
-- could both mint a successor to H, and nothing in the database stopped them:
--
--     H --> A          two valid-looking rows, one broken history,
--      \                and verifyChain() reporting a fork forever,
--       --> B          in a table where nothing can be deleted.
--
-- A FORK IS EXACTLY TWO ROWS SHARING A PREDECESSOR. So the invariant is not
-- something to coordinate around; it is something to make unrepresentable. A
-- unique index on prev_hash means the second writer's INSERT fails with 23505,
-- and the only way forward is to re-read the new head, re-mint, and try again.
--
-- -- WHY AN INDEX RATHER THAN A LOCK, A TRANSACTION OR AN RPC --------
-- This system reaches Postgres only through PostgREST (@supabase/supabase-js).
-- Every client call is one statement in its own implicit transaction, and Node
-- cannot hold a transaction open across calls. That rules out the usual three:
--
--   pg_advisory_xact_lock   transaction-scoped; the lock would be released
--                           before the INSERT was issued. A session-level lock
--                           is worse -- PostgREST pools connections, so the
--                           lock may be held on a different backend.
--   SELECT ... FOR UPDATE   same problem: the row lock dies at statement end.
--   SERIALIZABLE + retry    needs client-controlled isolation. Not available.
--
-- A database function would work, and this system has that pattern already
-- (claim_recording). It was still not chosen, for one reason: a function is a
-- path, and a path can be gone around. Any future caller with an INSERT grant
-- could write a forking row without touching it. An index constrains the TABLE,
-- so there is no route past it -- including for the caller who has not read
-- this comment.
--
-- -- ONE GLOBAL CHAIN. THIS MATTERS. ---------------------------------
-- Today acquisition_decisions is a SINGLE global chain: the head is read with
-- no entity filter and every event, whatever it is about, links to the one
-- before it. `unique (prev_hash)` is correct precisely because of that.
--
-- IF THE SYSTEM EVER PARTITIONS THE CHAIN -- per tenant, per client, per run --
-- this index becomes wrong: two partitions would legitimately each have a first
-- row, and legitimately each extend their own head. The invariant would have to
-- become `unique (chain_key, prev_hash)`, and the partitioning change and the
-- index change must land together. Do not introduce chain partitioning quietly.
--
-- -- AND IT SETTLES GENESIS FOR FREE ---------------------------------
-- The first row of a chain carries prev_hash = 64 zeroes. Uniqueness therefore
-- allows exactly one genesis row, ever. A process that lost its way and tried
-- to restart the log from scratch is refused by the database rather than
-- quietly beginning a second history alongside the real one.
-- ============================================================================

begin;

-- -- Refuse loudly rather than guess ---------------------------------
--
-- Deliberately NOT `create unique index if not exists`. That is idempotent in
-- the shallowest sense: it succeeds when an index of the same NAME exists, no
-- matter what that index actually does. An earlier hand-made
-- `uq_acq_decisions_prev_hash` over the wrong column, or non-unique, would be
-- silently accepted and the invariant would not exist while every report said
-- it did. Re-running is safe here because the guard checks the DEFINITION.
do $$
declare
  existing_def text;
  duplicate_count bigint;
  competing text;
begin
  -- The index cannot build over a chain that has already forked, and the raw
  -- error for that is not readable. Say what is actually wrong.
  select count(*) into duplicate_count
    from (select prev_hash
            from public.acquisition_decisions
           group by prev_hash
          having count(*) > 1) d;

  if duplicate_count > 0 then
    raise exception
      'Cannot apply laq3: % prev_hash value(s) already appear more than once, which means the decision chain has ALREADY forked. That is a data question, not a schema question. Investigate before applying; never delete a decision row to make this pass.',
      duplicate_count
      using errcode = 'unique_violation';
  end if;

  -- Another index already doing this job, under a different name.
  select string_agg(indexname, ', ') into competing
    from pg_indexes
   where schemaname = 'public'
     and tablename = 'acquisition_decisions'
     and indexname <> 'uq_acq_decisions_prev_hash'
     and indexdef ~ '\(prev_hash\)$';

  if competing is not null then
    raise exception
      'Cannot apply laq3: index(es) % already cover exactly (prev_hash). Applying a second would be duplication; confirm whether the existing one is UNIQUE and adopt it instead.',
      competing
      using errcode = 'duplicate_object';
  end if;

  select pg_get_indexdef(i.indexrelid) into existing_def
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where c.relname = 'uq_acq_decisions_prev_hash';

  if existing_def is null then
    create unique index uq_acq_decisions_prev_hash
      on public.acquisition_decisions (prev_hash);
    raise notice 'laq3: created uq_acq_decisions_prev_hash.';

  elsif existing_def !~ 'CREATE UNIQUE INDEX uq_acq_decisions_prev_hash ON public\.acquisition_decisions USING btree \(prev_hash\)' then
    raise exception
      'Cannot apply laq3: an index named uq_acq_decisions_prev_hash already exists but is NOT a unique btree on exactly (prev_hash). Found: %',
      existing_def
      using errcode = 'duplicate_object';

  else
    raise notice 'laq3: uq_acq_decisions_prev_hash already present and correct; nothing to do.';
  end if;
end;
$$;

commit;

-- ============================================================================
-- VERIFICATION (run manually after applying; not part of the transaction)
--
-- Use supabase/sql/verification/09_laq3_verify.sql, which checks that the index
-- exists, is UNIQUE, covers exactly prev_hash, and that nothing else moved --
-- row count, append-only trigger, RLS and policies all unchanged.
--
-- Then re-run the chain verifier and confirm it still passes:
--   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-chain-verify.js
--
-- ROLLBACK, for completeness. Dropping the index removes the guarantee and
-- returns the table to the M8H single-writer limitation; it destroys no data:
--   drop index if exists public.uq_acq_decisions_prev_hash;
-- ============================================================================
