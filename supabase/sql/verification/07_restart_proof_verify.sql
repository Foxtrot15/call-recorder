-- ============================================================================
-- M8D RESTART PROOF - FINAL VERIFICATION.  Run LAST, in the Supabase editor.
-- DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- ASCII ONLY. CAST-SAFE. READ-ONLY BY CONSTRUCTION - one statement, every arm
-- a bare SELECT. No INSERT, UPDATE, DELETE, CREATE, ALTER, DROP.
--
-- Confirms from the database side, independently of any script's own report:
--   F1-F3  the three permanent rows exist and are exactly identified
--   F4-F7  nothing else from the restart proof survived
--   F8-F9  the append-only triggers are STILL ENABLED - i.e. permanence was
--          never bought by switching enforcement off
-- ============================================================================

select 'F1' as id,
       'Permanent SUPPRESSION row (intentional)' as claim,
       coalesce((select 'id=' || s.id::text || '  reason=' || s.reason
                        || '  scope=' || s.scope || '  e164=' || coalesce(s.e164, 'null')
                        || '  fingerprint=' || coalesce(s.fingerprint, 'null')
                   from public.acquisition_suppressions s
                  where s.actor = 'm8d-restart-probe' limit 1), 'NOT FOUND') as detail,
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from public.acquisition_suppressions where actor = 'm8d-restart-probe') as verdict

union all
select 'F2',
       'Permanent OUTCOME row (intentional)',
       coalesce((select 'id=' || o.id::text || '  outcome=' || o.outcome
                        || '  reached=' || o.reached_the_business::text
                        || '  suppression_applied=' || o.suppression_applied::text
                   from public.acquisition_contact_outcomes o
                  where o.actor = 'm8d-restart-probe' limit 1), 'NOT FOUND'),
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from public.acquisition_contact_outcomes where actor = 'm8d-restart-probe')

union all
select 'F3',
       'Permanent PROSPECT row (pinned by RESTRICT)',
       coalesce((select 'prospect_id=' || p.prospect_id || '  name=' || p.business_name
                        || '  lifecycle=' || p.lifecycle
                   from public.acquisition_prospects p
                  where p.discovered_by = 'm8d-restart-probe' limit 1), 'NOT FOUND'),
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from public.acquisition_prospects where discovered_by = 'm8d-restart-probe')

union all
select 'F4',
       'No probe LEASE rows survived',
       (select count(*)::text from public.acquisition_call_queue
         where worker_id like 'm8d-%' or lease_token like 'm8d-%' or lease_token like 'lease_m8d%'),
       (select case when count(*) = 0 then 'PASS' else 'FAIL' end
          from public.acquisition_call_queue
         where worker_id like 'm8d-%' or lease_token like 'm8d-%' or lease_token like 'lease_m8d%')

union all
select 'F5',
       'No probe QUALIFICATION rows survived',
       (select count(*)::text from public.acquisition_qualifications where prospect_id like '%m8d%'),
       (select case when count(*) = 0 then 'PASS' else 'FAIL' end
          from public.acquisition_qualifications where prospect_id like '%m8d%')

union all
select 'F6',
       'The live-lease probe prospect was removed',
       (select count(*)::text || ' m8d prospect row(s) total'
          from public.acquisition_prospects where discovered_by = 'm8d-restart-probe'),
       (select case when count(*) = 1 then 'PASS' else 'FAIL' end
          from public.acquisition_prospects where discovered_by = 'm8d-restart-probe')

union all
select 'F7',
       'No Step-6 probe residue (m8d_ identifiers) anywhere',
       (select (select count(*) from public.acquisition_prospects where prospect_id like 'm8d\_%')::text
               || ' prospects, '
               || (select count(*) from public.acquisition_evidence where evidence_id like 'm8d\_%')::text
               || ' evidence, '
               || (select count(*) from public.acquisition_decisions where audit_id like 'm8d\_%')::text
               || ' decisions'),
       (select case when (select count(*) from public.acquisition_prospects where prospect_id like 'm8d\_%') = 0
                     and (select count(*) from public.acquisition_evidence where evidence_id like 'm8d\_%') = 0
                     and (select count(*) from public.acquisition_decisions where audit_id like 'm8d\_%') = 0
                    then 'PASS' else 'FAIL' end)

union all
-- The claim that matters most about HOW permanence was achieved.
select 'F8',
       'Append-only triggers are STILL ENABLED (never disabled)',
       (select coalesce(string_agg(tgname || '=' || tgenabled::text, ', ' order by tgname), 'none')
          from pg_trigger
         where not tgisinternal
           and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                          'acq_suppressions_no_update','acq_outcomes_no_update')),
       (select case when count(*) = 4 and count(*) filter (where tgenabled::text = 'O') = 4
                    then 'PASS' else 'FAIL - enforcement was switched off' end
          from pg_trigger
         where not tgisinternal
           and tgname in ('acq_evidence_no_update','acq_decisions_no_update',
                          'acq_suppressions_no_update','acq_outcomes_no_update'))

union all
select 'F9',
       'Schema unchanged by the proof: 13 tables, 0 policies, RLS on all 8',
       (select (select count(*) from pg_tables where schemaname = 'public')::text || ' tables, '
               || (select count(*) from pg_policies where tablename like 'acquisition\_%')::text || ' policies, '
               || (select count(*) filter (where c.relrowsecurity)::text
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind::text = 'r' and c.relname like 'acquisition\_%')
               || ' RLS-enabled'),
       (select case when (select count(*) from pg_tables where schemaname = 'public') = 13
                     and (select count(*) from pg_policies where tablename like 'acquisition\_%') = 0
                     and (select count(*) filter (where c.relrowsecurity)
                            from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind::text = 'r'
                             and c.relname like 'acquisition\_%') = 8
                    then 'PASS' else 'FAIL' end)

order by id;

-- ============================================================================
-- EXPECTED: 9 rows, every verdict PASS.
--
-- F1, F2 and F3 are the three rows that remain BY DESIGN. They describe an
-- invented business on an invented number and can never match anything real.
-- F8 is the reason they remain: the append-only triggers were never disabled.
-- ============================================================================
