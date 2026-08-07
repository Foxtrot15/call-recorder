-- ============================================================================
-- M8D - PROBE CLEANUP VERIFICATION.  Run this AFTER m8d_step6_probes.sql.
-- DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- ASCII ONLY. CAST-SAFE. READ-ONLY BY CONSTRUCTION: one statement, every arm
-- a bare SELECT. No INSERT, UPDATE, DELETE, CREATE, ALTER, DROP.
--
-- This proves from the DATABASE side that the probe transaction rolled back
-- and left nothing behind. It does not take the probe script's word for it.
--
-- Two independent things are checked:
--   C1-C8   every acquisition table is empty (the absolute claim)
--   D1-D8   no row bearing an m8d_ probe identifier exists (the targeted
--           claim - this is what would catch a partial rollback that left
--           probe rows while some other process legitimately wrote others)
-- ============================================================================

-- C: absolute emptiness ----------------------------------------------------
select 'C' as section, 'C1 acquisition_prospects' as item, count(*)::text as rows_found,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end as verdict
  from public.acquisition_prospects
union all
select 'C', 'C2 acquisition_prospect_phones', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_prospect_phones
union all
select 'C', 'C3 acquisition_evidence', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_evidence
union all
select 'C', 'C4 acquisition_decisions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_decisions
union all
select 'C', 'C5 acquisition_suppressions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_suppressions
union all
select 'C', 'C6 acquisition_qualifications', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_qualifications
union all
select 'C', 'C7 acquisition_call_queue', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_call_queue
union all
select 'C', 'C8 acquisition_contact_outcomes', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - table not empty' end
  from public.acquisition_contact_outcomes

-- D: targeted - nothing bearing an m8d_ probe identifier -------------------
union all
select 'D', 'D1 prospects with m8d_ id', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_prospects where prospect_id like 'm8d\_%'
union all
select 'D', 'D2 phones on an m8d_ prospect', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_prospect_phones where prospect_id like 'm8d\_%'
union all
select 'D', 'D3 evidence with m8d_ id', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_evidence where evidence_id like 'm8d\_%' or prospect_id like 'm8d\_%'
union all
select 'D', 'D4 decisions with m8d_ id', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_decisions where audit_id like 'm8d\_%' or entity_id like 'm8d\_%'
union all
-- The most important cleanup row. A surviving probe suppression could not be
-- deleted afterwards without disabling the append-only trigger.
select 'D', 'D5 suppressions written by m8d-probe', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe suppression survived' end
  from public.acquisition_suppressions
 where actor = 'm8d-probe' or fingerprint like 'm8d-%' or note like 'M8D %'
union all
select 'D', 'D6 qualifications on an m8d_ prospect', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_qualifications where prospect_id like 'm8d\_%'
union all
select 'D', 'D7 queue rows with m8d identifiers', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_call_queue
 where prospect_id like 'm8d\_%' or lease_token like 'm8d-%' or worker_id like 'm8d-%'
union all
select 'D', 'D8 outcomes written by m8d-probe', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'FAIL - probe rows survived' end
  from public.acquisition_contact_outcomes where prospect_id like 'm8d\_%' or actor = 'm8d-probe'

order by section, item;

-- ============================================================================
-- EXPECTED: 16 rows, every rows_found = 0, every verdict PASS.
--
-- ANY non-zero row here means the probe transaction did NOT fully roll back.
-- Stop and report it rather than deleting anything - a surviving suppression
-- row cannot be removed without disabling an append-only trigger, and that is
-- a decision to make deliberately, not reflexively.
-- ============================================================================
