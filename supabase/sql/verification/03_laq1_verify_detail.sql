-- ============================================================================
-- M8D STEP 3b - the LAQ1 checks Query A could not make.
-- DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- READ-ONLY BY CONSTRUCTION. One statement, one result set, one paste.
-- Folds together what were Queries B, C, E and F of m8d_step3_laq1_verify.sql.
-- (Query D - index detail - is dropped: V3.4 already counted all 8 and no
-- further claim rests on their definitions.)
--
-- Rows marked PASS/FAIL are assertions. Rows marked REVIEW are the enum
-- values, printed for reading - they are what V3.9's count of 8 does not show.
-- ============================================================================

-- B: no unexpected rows ---------------------------------------------------
select 'B' as section,
       'acquisition_prospects' as item,
       count(*)::text as detail,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end as verdict
  from public.acquisition_prospects
union all
select 'B', 'acquisition_prospect_phones', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_prospect_phones
union all
select 'B', 'acquisition_evidence', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_evidence
union all
select 'B', 'acquisition_decisions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - rows present' end
  from public.acquisition_decisions

-- E: triggers are ENABLED, not merely present -----------------------------
-- tgenabled: 'O' = enabled (origin). 'D' = DISABLED - append-only would not be
-- enforced at all, and Query A cannot see this.
union all
select 'E',
       g.tgname || ' [enabled=' || g.tgenabled::text || ']',
       pg_get_triggerdef(g.oid),
       case when g.tgenabled = 'O' then 'PASS'
            else 'FAIL - trigger not enabled (flag ' || g.tgenabled::text || ')' end
  from pg_trigger g
  join pg_class t on t.oid = g.tgrelid
  join pg_namespace n on n.oid = t.relnamespace
 where not g.tgisinternal and n.nspname = 'public' and t.relname like 'acquisition\_%'

-- F: the NOT NULLs that carry a contract ----------------------------------
-- timezone: calling hours are checked in the business's local time, so a
--           prospect without one cannot be assessed for compliance.
-- prev_hash / entry_hash: the audit chain. Nullable here would mean a decision
--           row could exist outside the chain and verifyRows() would not know.
union all
select 'F',
       c.table_name || '.' || c.column_name || ' NOT NULL',
       'is_nullable=' || c.is_nullable,
       case when c.is_nullable = 'NO' then 'PASS' else 'FAIL - nullable' end
  from information_schema.columns c
 where c.table_schema = 'public'
   and ((c.table_name = 'acquisition_prospects' and c.column_name = 'timezone')
     or (c.table_name = 'acquisition_decisions' and c.column_name in ('prev_hash','entry_hash')))

-- F: every id defaults to gen_random_uuid() -------------------------------
union all
select 'F',
       c.table_name || '.id default',
       coalesce(c.column_default, '(none)'),
       case when coalesce(c.column_default, '') like 'gen_random_uuid%'
            then 'PASS' else 'FAIL - unexpected default' end
  from information_schema.columns c
 where c.table_schema = 'public'
   and c.column_name = 'id'
   and c.table_name in ('acquisition_prospects','acquisition_prospect_phones',
                        'acquisition_evidence','acquisition_decisions')

-- C: the eight CHECK bodies, in full --------------------------------------
-- V3.9 proved there are 8. This prints what they actually admit. Compare
-- against the expected value sets in the report accompanying this file.
union all
select 'C',
       t.relname || '.' || c.conname,
       pg_get_constraintdef(c.oid),
       'REVIEW'
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
 where c.contype = 'c'
   and n.nspname = 'public'
   and t.relname in ('acquisition_prospects','acquisition_prospect_phones',
                     'acquisition_evidence','acquisition_decisions')

order by section, item;

-- Expect 21 rows:
--   B  4 rows, all PASS, all detail = 0
--   C  8 rows, all REVIEW
--   E  2 rows, both PASS, both enabled=O
--   F  7 rows, all PASS  (3 NOT NULL + 4 id defaults)
-- ============================================================================
