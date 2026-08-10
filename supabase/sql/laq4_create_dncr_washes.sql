-- ============================================================================
-- LOCKSMITH ACQUISITION M8K (LAQ4): durable Do Not Call Register wash storage.
--
-- One new table, one reused trigger function, three indexes, RLS on with no
-- policies. No existing table is altered, no column added to one, no data
-- rewritten, no existing trigger touched, no foreign key changed.
--
-- STATUS: APPLIED TO DEV 2026-08-10, by hand, after
-- supabase/sql/verification/10_laq4_preflight.sql came back clean.
-- NOT APPLIED TO PRODUCTION.
--
-- Dev also holds ONE permanent fictional wash row from section 5 of
-- supabase/sql/verification/11_laq4_verify.sql (+61355509999, not_listed,
-- washed 2026-08-09). It is append-only and cannot be removed. Do not re-run
-- that section against dev. See docs/ACQUISITION_SQL_RUNBOOK.md section 11.
--
-- ASCII ONLY, so no editor or clipboard can mangle a section heading.
--
-- -- WHAT THIS CLOSES ------------------------------------------------
-- E-3. Under the Do Not Call Register Act 2006 and the Telemarketing and
-- Research Calls Industry Standard 2017, an unsolicited telemarketing call to a
-- number on the Register is prohibited unless the list was washed against the
-- Register within the last 30 days and the number was absent.
--
-- Until now the wash store was an in-process Map. A wash performed, attested and
-- imported by a human did not survive the process exiting. After a restart every
-- number read back as "unknown", which vetoes -- so the failure direction was
-- always safe, but it meant a real wash could never actually authorise anything
-- across a restart, and the register's DNCR gate could not go green.
--
-- -- WHY A LEDGER AND NOT A FLAG -------------------------------------
-- The obvious schema is one row per number with a boolean "washed". That schema
-- cannot answer the only question that matters, which is not "was it washed"
-- but "is what we know still good enough to rely on RIGHT NOW".
--
-- So this stores the WASH EVENTS and nothing derived from them:
--
--     washed_at   when the wash was actually performed against the Register
--     result      what the Register said -- listed / not_listed
--
-- Freshness is recomputed at read time from washed_at against the clock, every
-- time, by acquisition-dncr.js. A wash that was fresh when a batch was assembled
-- and stale by the time it is read comes back unusable without anything having
-- had to notice, and without any row being rewritten. Nothing here decays, and
-- nothing here is ever updated because time passed.
--
-- A stale wash does NOT decay to its last value -- it decays to "unknown", which
-- vetoes. Collapsing "we never checked" or "our check expired" into "it's fine"
-- is the single mistake that produces mass unlawful calling.
--
-- -- APPEND-ONLY, LIKE EVERY OTHER LEDGER HERE -----------------------
-- A wash is evidence of what the Register said at an instant. Editing one would
-- be rewriting the evidence, so the same refusal trigger that guards evidence,
-- decisions, suppressions and outcomes guards this table. A number washed three
-- times has three rows, and the history stays auditable: "it was listed in June
-- and not listed in August" is a fact somebody may need to explain later.
--
-- -- WHAT IS DELIBERATELY NOT HERE -----------------------------------
-- No DNCR credentials, no endpoint, no account identifier, no API surface of any
-- kind. This is storage and import architecture only. A wash still happens
-- OUT OF BAND, performed by a human against the real Register, and enters this
-- system as attested data. DNCR-1 -- who holds the account and may attest -- is
-- a separate, open blocker and this migration does not touch it.
--
-- ============================================================================

begin;

-- -- The wash ledger -------------------------------------------------

create table if not exists public.acquisition_dncr_washes (
  id                  uuid primary key default gen_random_uuid(),

  -- The canonical number, normalised by acquisition-phone.js before it gets
  -- here. Formatting drift ("(03) 5550 1042", "03 5550 1042", "+61355501042")
  -- must collapse to ONE key, or a wash would be recorded against a spelling
  -- rather than against a telephone.
  e164                text not null
                        check (e164 ~ '^\+61[0-9]{6,12}$'),

  -- What the Register said. There is no 'unknown' here on purpose: unknown is
  -- the ABSENCE of a usable row, not a row. Storing it would invite a reader to
  -- treat "we recorded that we do not know" as a check having been performed.
  result              text not null
                        check (result in ('listed','not_listed')),

  -- WHEN THE WASH WAS ACTUALLY PERFORMED against the Register -- not when it
  -- was imported. This is the load-bearing column: every freshness decision is
  -- computed from it, so importing a two-month-old wash today must NOT make it
  -- look fresh. See the future-dating trigger below.
  washed_at           timestamptz not null,

  -- WHO attests that these are the results of a real wash. Without it an
  -- imported file is indistinguishable from a made-up one, and the whole
  -- lawful basis for the call rests on this being a real person.
  attested_by         text not null
                        check (length(btrim(attested_by)) > 0),

  -- import  = a wash a human really performed against the real Register
  -- fixture = deterministic in-repo data for tests and the dry run
  --
  -- A fixture result is NEVER authoritative, whatever else is true, and the
  -- check below makes that unrepresentable rather than merely conventional.
  mode                text not null
                        check (mode in ('import','fixture')),
  authoritative       boolean not null
                        check (authoritative = (mode = 'import')),

  -- The operator's reference for the wash run, and where the file came from.
  -- Provenance, so a row can be traced back to a specific piece of paper.
  batch_ref           text,
  source              text,

  -- When this system learned it, which is not when the wash happened.
  recorded_at         timestamptz not null default now()
);

-- -- Idempotency -----------------------------------------------------
--
-- Re-running the same import must not multiply rows. The natural key of a wash
-- event is the number, the instant it was performed, and which run it came from.
--
-- coalesce() on batch_ref because in Postgres NULLs are distinct in a unique
-- index: without it, two imports with no batch reference would both be allowed
-- and the "same import twice" case would silently duplicate.
--
-- A conflicting insert raises 23505 and the store treats it as "already have
-- this", which is the correct outcome -- not an error to be surfaced.
create unique index if not exists acquisition_dncr_washes_idem
  on public.acquisition_dncr_washes (e164, washed_at, result, coalesce(batch_ref, ''));

-- The authoritative read: the most recent wash for one number. Descending on
-- washed_at so "latest" is the first row of an index scan rather than a sort.
create index if not exists acquisition_dncr_washes_latest
  on public.acquisition_dncr_washes (e164, washed_at desc);

-- Auditing a run: "show me everything that came out of the August wash".
create index if not exists acquisition_dncr_washes_batch
  on public.acquisition_dncr_washes (batch_ref)
  where batch_ref is not null;

-- -- A wash cannot have been performed in the future -----------------
--
-- Enforced by a trigger rather than a CHECK because Postgres does not allow a
-- non-immutable function like now() in a check constraint. It is worth a trigger
-- rather than trusting the application: a future washed_at would make a wash
-- appear fresh for as long as the date is wrong, which is the one input error
-- that silently EXTENDS how long we believe we are allowed to call somebody.
--
-- A small tolerance absorbs clock skew between this system and Postgres without
-- admitting a date that is wrong in any way that matters.
create or replace function public.acquisition_reject_future_wash()
returns trigger
language plpgsql
as $$
begin
  if new.washed_at > now() + interval '5 minutes' then
    raise exception
      'acquisition_dncr_washes.washed_at is in the future (% > now()). A wash cannot have been performed later than now; check the importing clock.',
      new.washed_at
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists acq_dncr_no_future_wash on public.acquisition_dncr_washes;
create trigger acq_dncr_no_future_wash
  before insert on public.acquisition_dncr_washes
  for each row execute function public.acquisition_reject_future_wash();

-- -- Append-only -----------------------------------------------------
--
-- Reuses public.acquisition_refuse_mutation(), created by laq2 and already
-- guarding evidence, decisions, suppressions and outcomes. Deliberately NOT
-- redefined here: one refusal function, one behaviour, one place to read it.
--
-- laq2 is a hard prerequisite of this migration for exactly that reason, and
-- the preflight checks the function exists before this file is run.
drop trigger if exists acq_dncr_washes_no_update on public.acquisition_dncr_washes;
create trigger acq_dncr_washes_no_update
  before update or delete on public.acquisition_dncr_washes
  for each row execute function public.acquisition_refuse_mutation();

-- -- RLS, in the same transaction as creation (D8) -------------------
--
-- Enabled with NO policies, which under Postgres RLS denies every non-superuser
-- role outright. service_role bypasses RLS and is the only intended reader.
--
-- This table is more sensitive than it looks: it is a list of telephone numbers
-- annotated with whether their owner is on the Do Not Call Register. No client,
-- and no anon or authenticated role, has any business reading it.
alter table public.acquisition_dncr_washes enable row level security;

commit;

-- ============================================================================
-- VERIFICATION (run manually after applying; not part of the transaction)
-- ============================================================================
--
-- The full script is supabase/sql/verification/11_laq4_verify.sql. In short:
--
-- 1. The table exists with RLS on and no policies:
--      select relname, relrowsecurity from pg_class
--       where relname = 'acquisition_dncr_washes';
--      select tablename, policyname from pg_policies
--       where tablename = 'acquisition_dncr_washes';
--    Expect relrowsecurity = true, and zero policies.
--
-- 2. A wash cannot be edited or removed:
--      update public.acquisition_dncr_washes set result = 'not_listed';
--      delete from public.acquisition_dncr_washes;
--    Both must raise the append-only refusal from acquisition_refuse_mutation().
--
-- 3. A future wash is refused:
--      insert into public.acquisition_dncr_washes
--        (e164, result, washed_at, attested_by, mode, authoritative)
--      values ('+61355509999','not_listed', now() + interval '1 day',
--              'preflight','import', true);
--    Must raise check_violation from acquisition_reject_future_wash().
--
-- 4. A fixture row cannot claim to be authoritative:
--      insert into public.acquisition_dncr_washes
--        (e164, result, washed_at, attested_by, mode, authoritative)
--      values ('+61355509999','not_listed', now(), 'preflight','fixture', true);
--    Must raise a check violation on the authoritative/mode agreement.
--
-- 5. The same wash twice yields one row:
--    Insert the same (e164, washed_at, result, batch_ref) tuple twice; the
--    second must raise 23505 on acquisition_dncr_washes_idem.
--
-- ROLLBACK
--   This migration is additive and creates one table nothing else references.
--   To undo it before anything depends on it:
--
--     drop table if exists public.acquisition_dncr_washes;
--     drop function if exists public.acquisition_reject_future_wash();
--
--   Do NOT drop public.acquisition_refuse_mutation() -- laq2 created it and four
--   other tables still depend on it.
--
--   Once real attested washes exist, dropping this table destroys the evidence
--   that calls were lawfully made. At that point the rollback is a restore, not
--   a drop.
-- ============================================================================
