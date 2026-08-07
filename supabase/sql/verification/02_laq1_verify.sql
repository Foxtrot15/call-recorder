-- ============================================================================
-- M8D STEP 3 - VERIFY LAQ1.  DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- READ-ONLY BY CONSTRUCTION. Every statement is a bare SELECT against the
-- system catalogues and the four new (empty) tables. No INSERT, UPDATE,
-- DELETE, CREATE, ALTER or DROP. Nothing here writes, and nothing here needs
-- a transaction.
--
-- This step proves the four LAQ1 objects EXIST and are SHAPED correctly.
-- It deliberately does NOT try to make the append-only triggers fire - that
-- is a behavioural proof and it belongs to Step 4's self-rolling-back probes.
--
-- Run QUERY A through QUERY F. Paste all six result sets back.
-- ============================================================================


-- QUERY A - headline verification -----------------------------------------
-- One row per check. Every row must read PASS.

select 'V3.1' as id,
       'LAQ1 tables present' as check_name,
       '4' as expected,
       (select count(*)::text from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_prospects','acquisition_prospect_phones',
                             'acquisition_evidence','acquisition_decisions')) as actual,
       (select case when count(*) = 4 then 'PASS' else 'FAIL' end from pg_tables
         where schemaname = 'public'
           and tablename in ('acquisition_prospects','acquisition_prospect_phones',
                             'acquisition_evidence','acquisition_decisions')) as verdict

union all
select 'V3.2',
       'RLS enabled on all 4',
       '4 of 4 true',
       (select count(*) filter (where c.relrowsecurity)::text || ' of ' || count(*)::text || ' true'
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('acquisition_prospects','acquisition_prospect_phones',
                             'acquisition_evidence','acquisition_decisions')),
       (select case when count(*) = 4 and count(*) filter (where c.relrowsecurity) = 4
                    then 'PASS' else 'FAIL' end
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('acquisition_prospects','acquisition_prospect_phones',
                             'acquisition_evidence','acquisition_decisions'))

union all
-- The one that matters most: RLS on with NO policies denies every non-superuser
-- role outright. A policy here would be a client-facing read path.
select 'V3.3',
       'Policies on acquisition_* (must be zero)',
       '0',
       (select count(*)::text from pg_policies where tablename like 'acquisition\_%'),
       (select case when count(*) = 0 then 'PASS' else 'FAIL - INVESTIGATE' end
          from pg_policies where tablename like 'acquisition\_%')

union all
select 'V3.4',
       'Indexes named idx_acq_*',
       '8',
       (select count(*)::text from pg_indexes
         where schemaname = 'public' and indexname like 'idx\_acq\_%'),
       (select case when count(*) = 8 then 'PASS' else 'FAIL' end from pg_indexes
         where schemaname = 'public' and indexname like 'idx\_acq\_%')

union all
select 'V3.5',
       'Append-only triggers installed',
       '2',
       (select count(*)::text from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update')),
       (select case when count(*) = 2 then 'PASS' else 'FAIL' end from pg_trigger
         where not tgisinternal and tgname in ('acq_evidence_no_update','acq_decisions_no_update'))

union all
-- BEFORE UPDATE OR DELETE, FOR EACH ROW = tgtype bitmask 27
-- (ROW 1 + BEFORE 2 + DELETE 8 + UPDATE 16). An INSERT-firing or AFTER trigger
-- would be the wrong shape and would not block anything.
select 'V3.6',
       'Both triggers are BEFORE UPDATE OR DELETE FOR EACH ROW',
       'both tgtype = 27',
       (select coalesce(string_agg(tgname || '=' || tgtype::text, ', ' order by tgname), 'none')
          from pg_trigger where not tgisinternal
            and tgname in ('acq_evidence_no_update','acq_decisions_no_update')),
       (select case when count(*) = 2 and count(*) filter (where tgtype = 27) = 2
                    then 'PASS' else 'FAIL' end
          from pg_trigger where not tgisinternal
            and tgname in ('acq_evidence_no_update','acq_decisions_no_update'))

union all
select 'V3.7',
       'Function acquisition_refuse_mutation() exists',
       '1, plpgsql',
       (select coalesce(string_agg(l.lanname, ', '), 'ABSENT')
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          join pg_language l on l.oid = p.prolang
         where n.nspname = 'public' and p.proname = 'acquisition_refuse_mutation'),
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'acquisition_refuse_mutation')

union all
select 'V3.8',
       'Foreign keys, all ON DELETE RESTRICT',
       '3, all restrict',
       (select count(*)::text || ', ' ||
               count(*) filter (where confdeltype = 'r')::text || ' restrict'
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where c.contype = 'f' and n.nspname = 'public'
           and t.relname like 'acquisition\_%'),
       (select case when count(*) = 3 and count(*) filter (where confdeltype = 'r') = 3
                    then 'PASS' else 'FAIL' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where c.contype = 'f' and n.nspname = 'public'
           and t.relname like 'acquisition\_%')

union all
select 'V3.9',
       'CHECK constraints on LAQ1 tables',
       '8',
       (select count(*)::text
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where c.contype = 'c' and n.nspname = 'public'
           and t.relname like 'acquisition\_%'),
       (select case when count(*) = 8 then 'PASS' else 'REVIEW QUERY C' end
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where c.contype = 'c' and n.nspname = 'public'
           and t.relname like 'acquisition\_%')

union all
-- THE OFFLINE BOUNDARY. capture_mode must not admit 'live_fetch'. This build
-- cannot fetch a live page and the column must refuse to claim it did.
select 'V3.10',
       'capture_mode EXCLUDES live_fetch',
       'absent from constraint',
       (select case when count(*) = 0 then 'constraint missing'
                    when bool_or(pg_get_constraintdef(c.oid) like '%live_fetch%')
                    then 'PRESENT - BOUNDARY BREACHED' else 'absent' end
          from pg_constraint c where c.conname = 'acquisition_evidence_capture_mode_check'),
       (select case when count(*) = 1
                     and not bool_or(pg_get_constraintdef(c.oid) like '%live_fetch%')
                    then 'PASS' else 'FAIL' end
          from pg_constraint c where c.conname = 'acquisition_evidence_capture_mode_check')

union all
-- The M8C correction: entity_type must admit 'queue', or every queue audit row
-- is rejected at write time.
select 'V3.11',
       'entity_type ADMITS queue (M8C fix)',
       'present in constraint',
       (select case when count(*) = 0 then 'constraint missing'
                    when bool_or(pg_get_constraintdef(c.oid) like '%queue%')
                    then 'present' else 'ABSENT - M8C FIX MISSING' end
          from pg_constraint c where c.conname = 'acquisition_decisions_entity_type_check'),
       (select case when count(*) = 1
                     and bool_or(pg_get_constraintdef(c.oid) like '%queue%')
                    then 'PASS' else 'FAIL' end
          from pg_constraint c where c.conname = 'acquisition_decisions_entity_type_check')

union all
-- PRE-LAQ2 BASELINE. lifecycle currently holds only the six acquisition states.
-- 'queued' must NOT be admitted yet - LAQ2 is what widens this, and Step 5
-- re-runs this check expecting the opposite answer.
select 'V3.12',
       'lifecycle is still the 6 acquisition states (pre-LAQ2)',
       'queued NOT yet admitted',
       (select case when count(*) = 0 then 'constraint missing'
                    when bool_or(pg_get_constraintdef(c.oid) like '%queued%')
                    then 'ALREADY WIDENED - LAQ2 may have run' else 'not yet admitted' end
          from pg_constraint c where c.conname = 'acquisition_prospects_lifecycle_check'),
       (select case when count(*) = 1
                     and not bool_or(pg_get_constraintdef(c.oid) like '%queued%')
                    then 'PASS' else 'FAIL' end
          from pg_constraint c where c.conname = 'acquisition_prospects_lifecycle_check')

union all
select 'V3.13',
       'Public table count',
       '9',
       (select count(*)::text from pg_tables where schemaname = 'public'),
       (select case when count(*) = 9 then 'PASS' else 'FAIL' end
          from pg_tables where schemaname = 'public')

order by id;


-- QUERY B - no unexpected rows --------------------------------------------
-- All four tables must be completely empty. A row here means something wrote
-- to them, and nothing should have.

select 'acquisition_prospects'       as table_name, count(*) as row_count from public.acquisition_prospects
union all
select 'acquisition_prospect_phones', count(*) from public.acquisition_prospect_phones
union all
select 'acquisition_evidence',        count(*) from public.acquisition_evidence
union all
select 'acquisition_decisions',       count(*) from public.acquisition_decisions
order by table_name;

-- Expect 4 rows, row_count = 0 on every one.


-- QUERY C - every constraint, in full -------------------------------------
-- The authoritative reading of the CHECK bodies. Read the enum lists here:
--   origin        fixture, manual_entry, operator_import, inbound_referral
--   lifecycle     discovered, evidence_captured, review_pending,
--                 review_approved, review_rejected, suppressed        (6 - pre-LAQ2)
--   kind          business_name, legal_name, abn, phone, address,
--                 service_area, trade_category, website, operating_status
--   capture_mode  fixture, operator_entry, operator_import            (NO live_fetch)
--   source_type   government_register, official_website, verified_directory,
--                 unverified_directory, aggregator, social_profile,
--                 map_listing, unknown
--   entity_type   prospect, phone, batch, queue, suppression, campaign, system
--   decision      pass, veto, defer, approve, reject, record, error
--   actor_kind    human, system

select t.relname as table_name,
       c.conname as constraint_name,
       case c.contype
         when 'c' then 'check'      when 'f' then 'foreign key'
         when 'p' then 'primary key' when 'u' then 'unique'
         else c.contype::text
       end as constraint_type,
       pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public'
   and t.relname in ('acquisition_prospects','acquisition_prospect_phones',
                     'acquisition_evidence','acquisition_decisions')
 order by t.relname, constraint_type, c.conname;

-- Expect: 4 primary keys, 4 unique, 3 foreign key (all ON DELETE RESTRICT),
-- 8 check.


-- QUERY D - every index ---------------------------------------------------

select tablename as table_name,
       indexname as index_name,
       indexdef   as definition
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('acquisition_prospects','acquisition_prospect_phones',
                     'acquisition_evidence','acquisition_decisions')
 order by tablename, indexname;

-- Expect 8 idx_acq_* indexes plus the primary-key and unique-constraint
-- indexes Postgres creates automatically (*_pkey, *_key).


-- QUERY E - trigger detail ------------------------------------------------
-- pg_get_triggerdef is the authoritative statement. Both must read
-- BEFORE UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION
-- public.acquisition_refuse_mutation()

select t.relname as table_name,
       g.tgname  as trigger_name,
       g.tgenabled as enabled_flag,
       pg_get_triggerdef(g.oid) as definition
  from pg_trigger g
  join pg_class t on t.oid = g.tgrelid
  join pg_namespace n on n.oid = t.relnamespace
 where not g.tgisinternal
   and n.nspname = 'public'
   and t.relname like 'acquisition\_%'
 order by t.relname, g.tgname;

-- Expect exactly 2 rows. enabled_flag must be 'O' (enabled, origin).
-- 'D' means DISABLED - append-only would not be enforced at all.


-- QUERY F - column inventory ----------------------------------------------
-- Confirms the shape of each table, including that the hash-chain columns and
-- the timezone/compliance columns arrived NOT NULL.

select table_name,
       ordinal_position as pos,
       column_name,
       data_type,
       is_nullable,
       column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('acquisition_prospects','acquisition_prospect_phones',
                      'acquisition_evidence','acquisition_decisions')
 order by table_name, ordinal_position;

-- Spot-check: acquisition_prospects.timezone  NOT NULL
--             acquisition_decisions.prev_hash NOT NULL
--             acquisition_decisions.entry_hash NOT NULL
--             every id column defaults to gen_random_uuid()
-- ============================================================================
