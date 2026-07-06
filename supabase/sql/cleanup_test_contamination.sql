-- ============================================================================
-- Cleanup: purge test-fixture contamination from LLM-feeding tables.
--
-- Context (docs/LLM_PROMPT_CONTAMINATION_INVESTIGATION.md): demo transcripts
-- ("Streamline Software") injected via /test/inject were saved as completed
-- calls, which poisoned the auto-generated business profile and contact
-- summaries — both of which are recycled into future Claude prompts. The code
-- fixes stop NEW contamination; this script removes what is already cached.
--
-- REVIEW ONLY — run in the Supabase SQL Editor after reading each step.
-- Step 0 is read-only reconnaissance: run it first and sanity-check counts.
-- ============================================================================

-- ── Step 0: reconnaissance (read-only) ──────────────────────────────────────
select 'test_calls' as what, count(*) from public.calls where call_sid like 'TEST-%';
select 'contaminated_profiles' as what, count(*) from public.business_profiles
  where profile_summary ilike '%streamline%' or business_type ilike '%software%';
select 'contaminated_contacts' as what, count(*) from public.contacts
  where company ilike '%streamline%' or context_summary ilike '%streamline%';
-- Also list the demo phone numbers used by the dashboard batch:
select phone, name, company from public.contacts where phone like '+614333330%';

-- ── Step 1: delete test-injected calls ──────────────────────────────────────
begin;
delete from public.calls where call_sid like 'TEST-%';
commit;

-- ── Step 2: delete the contaminated business profile ────────────────────────
-- The profile regenerates automatically from REAL calls once >= 3 completed
-- calls exist (business-profile.js), now with TEST- rows excluded by code.
begin;
delete from public.business_profiles where client_id = 'default';
commit;

-- ── Step 3: delete demo contacts (numbers from the dashboard demo batch) ────
begin;
delete from public.contacts where phone like '+614333330%';
commit;

-- ── Step 4: clear rolling summaries that mention the fixture business ───────
-- (Real contacts whose summaries were generated while the profile was
-- contaminated. Clearing the summary is safe: it rebuilds on their next call.)
begin;
update public.contacts
   set context_summary = null, updated_at = now()
 where context_summary ilike '%streamline%';
commit;

-- ── Verification ─────────────────────────────────────────────────────────────
select count(*) as remaining_test_calls from public.calls where call_sid like 'TEST-%';
select count(*) as remaining_streamline_refs from public.contacts
  where company ilike '%streamline%' or context_summary ilike '%streamline%';
select * from public.business_profiles where client_id = 'default'; -- expect 0 rows until regenerated
