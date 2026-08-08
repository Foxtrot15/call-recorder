-- ============================================================================
-- M8I / LAQ3 PRE-FLIGHT.  DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- Run this BEFORE applying laq3_serialise_decision_chain.sql.
--
-- ASCII ONLY. CAST-SAFE. READ-ONLY BY CONSTRUCTION: one statement, every arm a
-- bare SELECT. No INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.
--
-- LAQ3 adds ONE unique index:
--
--     unique (prev_hash) on public.acquisition_decisions
--
-- A fork in the hash chain IS two rows sharing a predecessor, so uniqueness on
-- prev_hash makes that state structurally impossible. The index protects the
-- table even if a future caller bypasses the Node helper entirely, which is
-- the property a lock or an RPC cannot offer.
--
-- Three things have to be true before it is applied, and the migration will
-- refuse loudly rather than guess if they are not:
--
--   A  no duplicate prev_hash values exist (or the index cannot build)
--   B  the index name is free, and no OTHER index already covers prev_hash
--   C  the persisted chain verifies BEFORE the schema changes, so a later
--      failure cannot be blamed on the migration
--
-- C is the one this file cannot answer: verifying a hash chain means recomputing
-- sha256 over each row, which SQL here will not do. Run the checked-in verifier
-- instead, and record its output alongside these results:
--
--     NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-chain-verify.js
-- ============================================================================

-- A: duplicates that would block the index -----------------------------------
select 'A' as section,
       'A1 duplicate prev_hash values' as item,
       (select count(*)::text from (
          select prev_hash from public.acquisition_decisions
           group by prev_hash having count(*) > 1
        ) d) as detail,
       (select case when count(*) = 0 then 'PASS' else 'STOP - the chain has ALREADY forked; do not apply' end
          from (select prev_hash from public.acquisition_decisions
                 group by prev_hash having count(*) > 1) d) as verdict

union all
-- If A1 ever fails, this names the offenders. Expect no rows to be listed.
select 'A',
       'A2 offending prev_hash (expect none)',
       coalesce((select string_agg(prev_hash || ' x' || n::text, ', ')
                   from (select prev_hash, count(*) as n
                           from public.acquisition_decisions
                          group by prev_hash having count(*) > 1) d), 'none'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from (select prev_hash from public.acquisition_decisions
                 group by prev_hash having count(*) > 1) d)

union all
-- B: the name is free ---------------------------------------------------------
select 'B',
       'B1 index name uq_acq_decisions_prev_hash is free',
       (select case when count(*) = 0 then 'free' else 'ALREADY EXISTS' end
          from pg_class where relname = 'uq_acq_decisions_prev_hash'),
       (select case when count(*) = 0 then 'PASS' else 'REVIEW - the migration will verify its definition and refuse if it differs' end
          from pg_class where relname = 'uq_acq_decisions_prev_hash')

union all
-- B: no OTHER index already covers exactly prev_hash --------------------------
select 'B',
       'B2 existing indexes on acquisition_decisions',
       (select coalesce(string_agg(indexname || (case when indexdef like 'CREATE UNIQUE%' then ' [UNIQUE]' else '' end), ', ' order by indexname), 'none')
          from pg_indexes
         where schemaname = 'public' and tablename = 'acquisition_decisions'),
       'REVIEW'

union all
select 'B',
       'B3 any index whose columns are exactly (prev_hash)',
       (select coalesce(string_agg(indexname, ', '), 'none')
          from pg_indexes
         where schemaname = 'public' and tablename = 'acquisition_decisions'
           and indexdef ~ '\(prev_hash\)$'),
       (select case when count(*) = 0 then 'PASS' else 'STOP - an equivalent index exists; applying a second is duplication' end
          from pg_indexes
         where schemaname = 'public' and tablename = 'acquisition_decisions'
           and indexdef ~ '\(prev_hash\)$')

union all
-- C: the state the chain is in before anything changes ------------------------
select 'C',
       'C1 decision rows, and the range of sequences',
       (select count(*)::text || ' row(s), sequence ' ||
               coalesce(min(sequence)::text, '-') || '..' || coalesce(max(sequence)::text, '-')
          from public.acquisition_decisions),
       'RECORD'

union all
select 'C',
       'C2 current chain head (highest sequence)',
       coalesce((select 'seq ' || sequence::text || '  ' || entry_hash
                   from public.acquisition_decisions
                  order by sequence desc limit 1), 'empty chain'),
       'RECORD'

union all
-- The chain must be gapless for the sequence to mean what the code assumes.
select 'C',
       'C3 sequence is gapless from 1',
       (select case when count(*) = 0 then 'empty'
                    when max(sequence) = count(*) and min(sequence) = 1 then 'gapless'
                    else 'GAPS PRESENT' end
          from public.acquisition_decisions),
       (select case when count(*) = 0 or (max(sequence) = count(*) and min(sequence) = 1)
                    then 'PASS' else 'STOP - investigate before changing anything' end
          from public.acquisition_decisions)

union all
select 'C',
       'C4 duplicate sequence values',
       (select count(*)::text from (
          select sequence from public.acquisition_decisions
           group by sequence having count(*) > 1) d),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from (select sequence from public.acquisition_decisions
                 group by sequence having count(*) > 1) d)

union all
-- The controls that must survive the migration untouched.
select 'C',
       'C5 append-only trigger on decisions is enabled',
       (select coalesce(string_agg(tgname || '=' || tgenabled::text, ', '), 'MISSING')
          from pg_trigger where not tgisinternal and tgname = 'acq_decisions_no_update'),
       (select case when count(*) = 1 and bool_and(tgenabled::text = 'O') then 'PASS' else 'STOP' end
          from pg_trigger where not tgisinternal and tgname = 'acq_decisions_no_update')

union all
select 'C',
       'C6 RLS on, zero policies',
       (select (select case when bool_and(c.relrowsecurity) then 'RLS on' else 'RLS OFF' end
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'acquisition_decisions')
               || ', ' || (select count(*)::text from pg_policies where tablename = 'acquisition_decisions') || ' policies'),
       (select case when count(*) = 0 then 'PASS' else 'STOP' end
          from pg_policies where tablename = 'acquisition_decisions')

order by section, item;

-- ============================================================================
-- EXPECTED: every PASS row PASS; the RECORD and REVIEW rows written down so the
-- post-application check has something to compare against.
--
-- ANY 'STOP' MEANS DO NOT APPLY LAQ3. In particular a duplicate prev_hash means
-- the chain has already forked, and that is a data question to answer before it
-- becomes a schema question.
--
-- Then run the chain verifier and record its output:
--   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-chain-verify.js
-- ============================================================================
