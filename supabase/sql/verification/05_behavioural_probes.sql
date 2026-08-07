-- ============================================================================
-- M8D - BEHAVIOURAL PROBES against the real dev Postgres.  (HARNESS v2)
-- DEV SUPABASE PROJECT ONLY (ref wvwemitmmsdytyutaqbm)
--
-- ASCII ONLY. CAST-SAFE. RLS UNCHANGED - nothing here touches RLS.
--
-- ---------------------------------------------------------------------------
-- WHY v1 FAILED, AND WHAT CHANGED
--
-- v1 was five top-level statements: begin / create temporary table / do /
-- select / rollback. The Supabase SQL Editor does not keep a TEMPORARY table
-- alive across statement boundaries, so by the time the DO block ran, the
-- results table was gone. Probe P01 raised its expected 23001, its EXCEPTION
-- handler tried to record the result, and THAT insert raised
-- 42P01 relation "m8d_probe_results" does not exist. An error raised inside an
-- exception handler propagates, so the whole DO block aborted at the first
-- probe. The final SELECT was never reached.
--
-- v2 removes the cross-statement dependency completely:
--
--   * THE ENTIRE HARNESS IS ONE STATEMENT - a single DO block. There is no
--     temp table, no outer BEGIN, no trailing SELECT, nothing that has to
--     survive a statement boundary.
--   * Results accumulate in a PL/pgSQL text variable, not in a table.
--   * The block ENDS IN A DELIBERATE RAISE EXCEPTION carrying the report.
--
-- SO THE ERROR YOU WILL SEE IS THE RESULT. That is not a workaround, it is
-- the strongest available guarantee: a statement that ends in an uncaught
-- exception is rolled back by Postgres atomically and unconditionally. v1
-- depended on a trailing "rollback;" actually being executed by the editor.
-- v2 depends on nothing but Postgres statement atomicity. It cannot leave
-- fixture data behind even if the editor autocommits every statement.
--
-- There is no COMMIT anywhere in this file.
--
-- ---------------------------------------------------------------------------
-- Each probe still runs in a nested PL/pgSQL BEGIN ... EXCEPTION block, which
-- Postgres wraps in an implicit SAVEPOINT, so a caught exception rolls back
-- only that probe. All 30 probes and their SQLSTATE expectations are
-- unchanged from v1:
--   23001 restrict_violation (append-only trigger)   23514 check_violation
--   23505 unique_violation                           23503 fk_violation
-- A probe raising the WRONG error reads FAIL, not PASS.
--
-- DATA: entirely fictional, every identifier prefixed m8d_. No real business,
-- no real number. Nothing is dialled, sent, or transmitted anywhere.
-- ============================================================================

do $$
declare
  v_report text := '';
  v_n      integer;
  v_pass   integer;
  v_fail   integer;
begin

  -- == SETUP =================================================================
  -- In the main body, not inside a nested block, so it survives each probe's
  -- savepoint rollback and is available to every probe that follows.

  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at)
  values ('m8d_main',  'M8D Probe Locksmiths',     'Australia/Melbourne', 'fixture', now()),
         ('m8d_ev',    'M8D Evidence Probe',       'Australia/Melbourne', 'fixture', now()),
         ('m8d_ph',    'M8D Phone Probe',          'Australia/Melbourne', 'fixture', now()),
         ('m8d_out',   'M8D Outcome Probe',        'Australia/Melbourne', 'fixture', now()),
         ('m8d_q',     'M8D Qualification Probe',  'Australia/Melbourne', 'fixture', now()),
         ('m8d_cq',    'M8D Queue Probe',          'Australia/Melbourne', 'fixture', now()),
         ('m8d_lease', 'M8D Lease Probe',          'Australia/Melbourne', 'fixture', now()),
         ('m8d_sup',   'M8D Suppression Probe',    'Australia/Melbourne', 'fixture', now());

  insert into public.acquisition_evidence
    (evidence_id, sequence, prospect_id, kind, capture_mode, value,
     observed_at, recorded_at, captured_by, source_type, source_official, content_hash)
  values ('m8d_ev_main', 1, 'm8d_main', 'business_name', 'fixture', 'M8D Probe Locksmiths',
          now(), now(), 'm8d-probe', 'official_website', true, 'm8d-hash-1'),
         ('m8d_ev_x',    2, 'm8d_ev',   'business_name', 'fixture', 'M8D Evidence Probe',
          now(), now(), 'm8d-probe', 'official_website', true, 'm8d-hash-2');

  insert into public.acquisition_decisions
    (audit_id, sequence, entity_type, entity_id, event, decision,
     actor, actor_kind, reason, prev_hash, entry_hash, recorded_at)
  values ('m8d_ad_1', 1, 'prospect', 'm8d_main', 'probe', 'record',
          'm8d-probe', 'system', 'M8D probe row.', repeat('0', 64), 'm8d-entry-1', now());

  insert into public.acquisition_prospect_phones (prospect_id, raw)
  values ('m8d_ph', '(03) 5550 1042');

  insert into public.acquisition_suppressions
    (reason, scope, fingerprint, e164, actor, actor_kind, note, suppressed_at)
  values ('opt_out', 'business', 'm8d-suppression-probe#preston|vic', '+61355509001',
          'm8d-probe', 'human', 'M8D probe suppression.', now());

  insert into public.acquisition_contact_outcomes
    (prospect_id, outcome, reached_the_business, lifecycle_from, lifecycle_to,
     actor, actor_kind, note, recorded_at)
  values ('m8d_out', 'opt_out', true, 'queued', 'suppressed',
          'm8d-probe', 'human', 'M8D probe outcome.', now());

  insert into public.acquisition_qualifications
    (prospect_id, verdict, tier, score, evaluated_at)
  values ('m8d_q', 'qualified', 'standard', 50, now());

  insert into public.acquisition_call_queue
    (prospect_id, e164, worker_id, lease_token, granted_at, expires_at, request_id)
  values ('m8d_cq',    '+61355509002', 'm8d-worker',   'm8d-tok-cq', now(), now() + interval '5 min', 'm8d-req-1'),
         ('m8d_lease', '+61355509003', 'm8d-worker-a', 'm8d-tok-a',  now(), now() + interval '5 min', null);


  -- == APPEND-ONLY ENFORCEMENT (P01-P08) =====================================

  begin
    update public.acquisition_evidence set value = 'm8d-changed' where evidence_id = 'm8d_ev_main';
    v_report := v_report || E'\nP01 FAIL  no error raised          evidence UPDATE refused';
  exception when others then
    v_report := v_report || E'\nP01 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  evidence UPDATE refused';
  end;

  begin
    delete from public.acquisition_evidence where evidence_id = 'm8d_ev_main';
    v_report := v_report || E'\nP02 FAIL  no error raised          evidence DELETE refused';
  exception when others then
    v_report := v_report || E'\nP02 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  evidence DELETE refused';
  end;

  begin
    update public.acquisition_decisions set reason = 'm8d-changed' where audit_id = 'm8d_ad_1';
    v_report := v_report || E'\nP03 FAIL  no error raised          decisions UPDATE refused';
  exception when others then
    v_report := v_report || E'\nP03 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  decisions UPDATE refused';
  end;

  begin
    delete from public.acquisition_decisions where audit_id = 'm8d_ad_1';
    v_report := v_report || E'\nP04 FAIL  no error raised          decisions DELETE refused';
  exception when others then
    v_report := v_report || E'\nP04 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  decisions DELETE refused';
  end;

  begin
    update public.acquisition_suppressions set note = 'm8d-changed' where actor = 'm8d-probe';
    v_report := v_report || E'\nP05 FAIL  no error raised          suppressions UPDATE refused';
  exception when others then
    v_report := v_report || E'\nP05 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  suppressions UPDATE refused';
  end;

  begin
    delete from public.acquisition_suppressions where actor = 'm8d-probe';
    v_report := v_report || E'\nP06 FAIL  no error raised          suppressions DELETE refused';
  exception when others then
    v_report := v_report || E'\nP06 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  suppressions DELETE refused';
  end;

  begin
    update public.acquisition_contact_outcomes set note = 'm8d-changed' where prospect_id = 'm8d_out';
    v_report := v_report || E'\nP07 FAIL  no error raised          outcomes UPDATE refused';
  exception when others then
    v_report := v_report || E'\nP07 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  outcomes UPDATE refused';
  end;

  begin
    delete from public.acquisition_contact_outcomes where prospect_id = 'm8d_out';
    v_report := v_report || E'\nP08 FAIL  no error raised          outcomes DELETE refused';
  exception when others then
    v_report := v_report || E'\nP08 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  outcomes DELETE refused';
  end;


  -- == DERIVED STATE MUST STAY MUTABLE (P09-P10) =============================

  begin
    update public.acquisition_call_queue set released_at = now() where lease_token = 'm8d-tok-cq';
    v_report := v_report || E'\nP09 PASS  released                 call_queue UPDATE permitted';
  exception when others then
    v_report := v_report || E'\nP09 FAIL  got ' || sqlstate || '                  call_queue UPDATE permitted';
  end;

  begin
    update public.acquisition_qualifications set score = 60 where prospect_id = 'm8d_q';
    v_report := v_report || E'\nP10 PASS  rescored                 qualifications UPDATE permitted';
  exception when others then
    v_report := v_report || E'\nP10 FAIL  got ' || sqlstate || '                  qualifications UPDATE permitted';
  end;


  -- == CHECK CONSTRAINTS (P11-P18) ===========================================

  begin
    insert into public.acquisition_evidence
      (evidence_id, sequence, prospect_id, kind, capture_mode, value,
       observed_at, recorded_at, captured_by, source_type, source_official, content_hash)
    values ('m8d_ev_live', 3, 'm8d_main', 'business_name', 'live_fetch', 'x',
            now(), now(), 'm8d-probe', 'official_website', true, 'm8d-hash-3');
    v_report := v_report || E'\nP11 FAIL  no error raised          capture_mode live_fetch refused';
  exception when others then
    v_report := v_report || E'\nP11 ' || case when sqlstate = '23514' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  capture_mode live_fetch refused';
  end;

  begin
    insert into public.acquisition_prospects
      (prospect_id, business_name, timezone, origin, discovered_at, lifecycle)
    values ('m8d_lc_bad', 'M8D Bad Lifecycle', 'Australia/Melbourne', 'fixture', now(), 'ringing');
    v_report := v_report || E'\nP12 FAIL  no error raised          lifecycle rejects unknown state';
  exception when others then
    v_report := v_report || E'\nP12 ' || case when sqlstate = '23514' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  lifecycle rejects unknown state';
  end;

  begin
    insert into public.acquisition_prospects
      (prospect_id, business_name, timezone, origin, discovered_at, lifecycle)
    values ('m8d_lc_ok', 'M8D Good Lifecycle', 'Australia/Melbourne', 'fixture', now(), 'queued');
    v_report := v_report || E'\nP13 PASS  accepted                 lifecycle ACCEPTS queued (LAQ2)';
  exception when others then
    v_report := v_report || E'\nP13 FAIL  got ' || sqlstate || '                  lifecycle ACCEPTS queued (LAQ2)';
  end;

  begin
    insert into public.acquisition_decisions
      (audit_id, sequence, entity_type, entity_id, event, decision,
       actor, actor_kind, reason, prev_hash, entry_hash, recorded_at)
    values ('m8d_ad_q', 2, 'queue', 'm8d_main', 'selection', 'record',
            'm8d-probe', 'system', 'M8D queue audit probe.', repeat('0', 64), 'm8d-entry-2', now());
    v_report := v_report || E'\nP14 PASS  accepted                 entity_type ACCEPTS queue (M8C)';
  exception when others then
    v_report := v_report || E'\nP14 FAIL  got ' || sqlstate || '                  entity_type ACCEPTS queue (M8C)';
  end;

  begin
    insert into public.acquisition_suppressions
      (reason, scope, e164, actor, note, suppressed_at)
    values ('opt_out', 'business', '+61355509004', 'm8d-probe', 'M8D scope probe.', now());
    v_report := v_report || E'\nP15 FAIL  no error raised          business scope needs fingerprint';
  exception when others then
    v_report := v_report || E'\nP15 ' || case when sqlstate = '23514' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  business scope needs fingerprint';
  end;

  begin
    insert into public.acquisition_suppressions
      (reason, scope, fingerprint, actor, note, suppressed_at)
    values ('wrong_number', 'number', 'm8d-no-number#preston|vic', 'm8d-probe', 'M8D scope probe.', now());
    v_report := v_report || E'\nP16 FAIL  no error raised          number scope needs e164';
  exception when others then
    v_report := v_report || E'\nP16 ' || case when sqlstate = '23514' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  number scope needs e164';
  end;

  begin
    insert into public.acquisition_suppressions
      (reason, scope, e164, actor, note, suppressed_at)
    values ('wrong_number', 'number', '(03) 5550 1042', 'm8d-probe', 'M8D normalisation probe.', now());
    v_report := v_report || E'\nP17 FAIL  no error raised          non-normalised e164 refused';
  exception when others then
    v_report := v_report || E'\nP17 ' || case when sqlstate = '23514' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  non-normalised e164 refused';
  end;

  begin
    insert into public.acquisition_suppressions
      (reason, scope, e164, actor, note, suppressed_at)
    values ('wrong_number', 'number', '+61355509005', 'm8d-probe', 'M8D normalisation probe.', now());
    v_report := v_report || E'\nP18 PASS  accepted                 normalised e164 ACCEPTED';
  exception when others then
    v_report := v_report || E'\nP18 FAIL  got ' || sqlstate || '                  normalised e164 ACCEPTED';
  end;


  -- == THE ONE-LIVE-LEASE RACE INVARIANT (P19-P24) ===========================

  begin
    insert into public.acquisition_call_queue
      (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
    values ('m8d_lease', '+61355509003', 'm8d-worker-b', 'm8d-tok-b', now(), now() + interval '5 min');
    v_report := v_report || E'\nP19 FAIL  no error raised          SECOND LIVE LEASE REFUSED';
  exception when others then
    v_report := v_report || E'\nP19 ' || case when sqlstate = '23505' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  SECOND LIVE LEASE REFUSED';
  end;

  begin
    update public.acquisition_call_queue set released_at = now() where lease_token = 'm8d-tok-a';
    insert into public.acquisition_call_queue
      (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
    values ('m8d_lease', '+61355509003', 'm8d-worker-b', 'm8d-tok-b', now(), now() + interval '5 min');
    v_report := v_report || E'\nP20 PASS  re-leased                releasing frees the slot';
  exception when others then
    v_report := v_report || E'\nP20 FAIL  got ' || sqlstate || '                  releasing frees the slot';
  end;

  begin
    insert into public.acquisition_call_queue
      (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
    values ('m8d_ph', '+61355509006', 'm8d-worker-c', 'm8d-tok-a', now(), now() + interval '5 min');
    v_report := v_report || E'\nP21 FAIL  no error raised          duplicate lease_token refused';
  exception when others then
    v_report := v_report || E'\nP21 ' || case when sqlstate = '23505' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  duplicate lease_token refused';
  end;

  begin
    insert into public.acquisition_call_queue
      (prospect_id, e164, worker_id, lease_token, granted_at, expires_at, request_id)
    values ('m8d_out', '+61355509007', 'm8d-worker-d', 'm8d-tok-e', now(), now() + interval '5 min', 'm8d-req-1');
    v_report := v_report || E'\nP22 FAIL  no error raised          duplicate request_id refused';
  exception when others then
    v_report := v_report || E'\nP22 ' || case when sqlstate = '23505' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  duplicate request_id refused';
  end;

  begin
    insert into public.acquisition_qualifications
      (prospect_id, verdict, tier, score, evaluated_at)
    values ('m8d_q', 'not_qualified', 'marginal', 10, now());
    v_report := v_report || E'\nP23 FAIL  no error raised          one qualification per prospect';
  exception when others then
    v_report := v_report || E'\nP23 ' || case when sqlstate = '23505' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  one qualification per prospect';
  end;

  begin
    insert into public.acquisition_evidence
      (evidence_id, sequence, prospect_id, kind, capture_mode, value,
       observed_at, recorded_at, captured_by, source_type, source_official, content_hash, supersedes_id)
    values ('m8d_ev_sup', 4, 'm8d_main', 'business_name', 'fixture', 'x',
            now(), now(), 'm8d-probe', 'official_website', true, 'm8d-hash-4', 'm8d_does_not_exist');
    v_report := v_report || E'\nP24 FAIL  no error raised          supersedes_id must resolve';
  exception when others then
    v_report := v_report || E'\nP24 ' || case when sqlstate = '23503' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  supersedes_id must resolve';
  end;


  -- == FOREIGN KEY BEHAVIOUR: RESTRICT (P25-P27) =============================

  begin
    delete from public.acquisition_prospects where prospect_id = 'm8d_out';
    v_report := v_report || E'\nP25 FAIL  no error raised          prospect w/ OUTCOME not deletable';
  exception when others then
    v_report := v_report || E'\nP25 ' || case when sqlstate = '23503' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  prospect w/ OUTCOME not deletable';
  end;

  begin
    delete from public.acquisition_prospects where prospect_id = 'm8d_ev';
    v_report := v_report || E'\nP26 FAIL  no error raised          prospect w/ EVIDENCE not deletable';
  exception when others then
    v_report := v_report || E'\nP26 ' || case when sqlstate = '23503' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  prospect w/ EVIDENCE not deletable';
  end;

  begin
    delete from public.acquisition_prospects where prospect_id = 'm8d_ph';
    v_report := v_report || E'\nP27 FAIL  no error raised          prospect w/ PHONE not deletable';
  exception when others then
    v_report := v_report || E'\nP27 ' || case when sqlstate = '23503' then 'PASS ' else 'FAIL ' end
                || ' got ' || sqlstate || '                  prospect w/ PHONE not deletable';
  end;


  -- == FOREIGN KEY BEHAVIOUR: CASCADE (P28-P29) ==============================

  begin
    delete from public.acquisition_prospects where prospect_id = 'm8d_q';
    select count(*) into v_n from public.acquisition_qualifications where prospect_id = 'm8d_q';
    v_report := v_report || E'\nP28 ' || case when v_n = 0 then 'PASS ' else 'FAIL ' end
                || ' ' || v_n::text || ' left                   qualification CASCADEs';
  exception when others then
    v_report := v_report || E'\nP28 FAIL  got ' || sqlstate || '                  qualification CASCADEs';
  end;

  begin
    delete from public.acquisition_prospects where prospect_id = 'm8d_cq';
    select count(*) into v_n from public.acquisition_call_queue where prospect_id = 'm8d_cq';
    v_report := v_report || E'\nP29 ' || case when v_n = 0 then 'PASS ' else 'FAIL ' end
                || ' ' || v_n::text || ' left                   queue row CASCADEs';
  exception when others then
    v_report := v_report || E'\nP29 FAIL  got ' || sqlstate || '                  queue row CASCADEs';
  end;


  -- == THE ONE THAT MATTERS MOST (P30) =======================================
  -- Suppression must survive the prospect record being deleted. The failure
  -- mode this prevents: a business that opted out is re-imported months later
  -- as a fresh row and called again.

  begin
    delete from public.acquisition_prospects where prospect_id = 'm8d_sup';
    select count(*) into v_n from public.acquisition_suppressions where actor = 'm8d-probe';
    v_report := v_report || E'\nP30 ' || case when v_n >= 1 then 'PASS ' else 'FAIL ' end
                || ' ' || v_n::text || ' remain                 SUPPRESSION SURVIVES DELETE';
  exception when others then
    v_report := v_report || E'\nP30 FAIL  got ' || sqlstate || '                  SUPPRESSION SURVIVES DELETE';
  end;


  -- == REPORT, AND THE DELIBERATE ABORT ======================================

  v_pass := (length(v_report) - length(replace(v_report, ' PASS ', ''))) / 6;
  v_fail := (length(v_report) - length(replace(v_report, ' FAIL ', ''))) / 6;

  raise exception E'M8D PROBE REPORT\n=== THIS ERROR IS EXPECTED. It is how the rollback is guaranteed. ===\n%\n\nSUMMARY: % of 30 passed, % failed.\nEvery fixture row written by this block has been rolled back by this abort.',
    v_report, v_pass, v_fail;

end
$$;

-- ============================================================================
-- EXPECTED OUTPUT: an ERROR whose message is the 30-line report, ending
--   SUMMARY: 30 of 30 passed, 0 failed.
--
-- An ERROR here is SUCCESS. The only genuinely bad outcomes are:
--   * a report showing any FAIL line, or
--   * an error that is NOT the M8D PROBE REPORT (a real fault).
--
-- Copy the whole error message back.
-- Then run m8d_step6_cleanup_check.sql to confirm from the database side.
-- ============================================================================
