-- ============================================================================
-- M7I CUTOVER — repoint the sandbox receptionist agent to the tool-free,
-- production-compiled build.
--
-- REVIEW ONLY — NOT APPLIED. Nothing here has been executed and no database was
-- connected by the assistant. Apply it yourself, read the NOTICE output, and
-- only then proceed to the Retell number cutover.
--
-- ─── WHAT THIS DOES ────────────────────────────────────────────────────────
-- Updates EXACTLY ONE row of public.provider_resources: the active Retell
-- voice_agent serving purpose 'receptionist_agent' for the sandbox client. It
-- moves provider_resource_id from the OLD agent to the NEW one and refreshes
-- the version/tag and sync bookkeeping.
--
-- ─── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
--   * does not touch locksmith_business_profiles — so the approved profile,
--     its profile_version and the TRANSFER CONFIGURATION (transfer.primaryNumber,
--     backupNumber, unansweredAction, requiredUrgency) are untouched. Transfer
--     settings do not live in this table and are not readable from it.
--   * does not change client_id or profile_version on the row it updates
--   * does not insert, delete, deactivate or supersede any row
--   * does not touch the knowledge_base or response_engine rows — the new LLM
--     and KB are bound to the new AGENT at the provider, and the agent id is the
--     only identifier the inbound number resolves against
--   * does not touch any other client, provider or purpose
--
-- ─── PRECONDITION ──────────────────────────────────────────────────────────
-- supabase/sql/lpm3_create_retell_provisioning.sql has NEVER been recorded as
-- applied. If provider_resources does not exist, guard 0 stops the transaction
-- with a clear message: the registry is simply not in use yet, the runtime does
-- not depend on it for inbound resolution, and you can proceed straight to the
-- Retell number cutover. That is an expected outcome, not a failure.
--
-- ─── RESOURCE IDS ──────────────────────────────────────────────────────────
--   OLD (retained for rollback)      NEW (verified against the compiled contract)
--   agent  agent_f5ceb1f7af5db76f9ee23e83e5   agent_75125d59f510d8b6e70f907ee5
--   llm    llm_c4e1a90c456bda3d20105cbe1b78   llm_e4b4585e02ff21c47595ebb29369
--   kb     knowledge_base_8791efb5c771fcf0    knowledge_base_b465d8f4bd6443b8
-- ============================================================================

BEGIN;

-- ── Guard 0: the registry must exist ───────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.provider_resources') IS NULL THEN
    RAISE EXCEPTION
      'provider_resources does not exist — lpm3_create_retell_provisioning.sql has not been applied. %',
      'The registry is not in use; no cutover row exists. Roll this back and proceed to the Retell number cutover.';
  END IF;
END $$;

-- ── Guard 1 + update + guard 2, in ONE block ───────────────────────────────
-- Deliberately a single PL/pgSQL block. GET DIAGNOSTICS ... ROW_COUNT reports
-- the last statement executed WITHIN the same block, so a separate DO block
-- after a top-level UPDATE would silently report 0 and the post-check would be
-- decorative. Keeping the count, the write and the assertion together is what
-- makes "exactly one row" an actual guarantee.
--
-- Guard 1: zero matches means the registry does not track this agent (nothing
-- to cut over). More than one means the one-active-per-purpose invariant is
-- already broken, and a blind UPDATE would corrupt it further.
DO $$
DECLARE
  match_count  integer;
  rows_written integer;
BEGIN
  SELECT count(*) INTO match_count
    FROM public.provider_resources
   WHERE client_id            = 'sandbox-fixture-locksmith'
     AND provider             = 'retell'
     AND resource_type        = 'voice_agent'
     AND purpose              = 'receptionist_agent'
     AND provider_resource_id = 'agent_f5ceb1f7af5db76f9ee23e83e5'
     AND active               = true;

  IF match_count = 0 THEN
    RAISE EXCEPTION
      'Refusing: no ACTIVE receptionist_agent row for client sandbox-fixture-locksmith with the old agent id. %',
      'Either the cutover already ran, or the registry never recorded this agent. Inspect with the verification query below before doing anything else.';
  ELSIF match_count > 1 THEN
    RAISE EXCEPTION
      'Refusing: % active rows match — the one-active-per-purpose invariant is already violated. Fix that first.',
      match_count;
  END IF;

  RAISE NOTICE 'Guard passed: exactly 1 active row matched. Applying cutover.';

  -- The update: one row, three identity columns plus sync bookkeeping.
  -- client_id, profile_version, provisioning_plan_id, idempotency_key,
  -- payload_hash, created_at and active are all left exactly as they are.
  UPDATE public.provider_resources
     SET provider_resource_id = 'agent_75125d59f510d8b6e70f907ee5',
         provider_version     = '0',
         provider_tag         = 'dev',
         last_synced_at       = now(),
         updated_at           = now()
   WHERE client_id            = 'sandbox-fixture-locksmith'
     AND provider             = 'retell'
     AND resource_type        = 'voice_agent'
     AND purpose              = 'receptionist_agent'
     AND provider_resource_id = 'agent_f5ceb1f7af5db76f9ee23e83e5'
     AND active               = true;

  -- Guard 2: exactly one row was actually written.
  GET DIAGNOSTICS rows_written = ROW_COUNT;
  IF rows_written <> 1 THEN
    RAISE EXCEPTION 'Refusing: UPDATE wrote % rows, expected exactly 1.', rows_written;
  END IF;

  RAISE NOTICE 'Cutover applied to exactly 1 row.';
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION — run AFTER the commit above. Expect exactly one row, showing
-- the NEW agent id, unchanged client_id and unchanged profile_version.
-- ============================================================================
--
-- SELECT client_id,
--        provider,
--        resource_type,
--        purpose,
--        provider_resource_id,
--        provider_version,
--        provider_tag,
--        profile_version,
--        active,
--        superseded_at,
--        last_synced_at,
--        updated_at
--   FROM public.provider_resources
--  WHERE client_id     = 'sandbox-fixture-locksmith'
--    AND provider      = 'retell'
--    AND resource_type = 'voice_agent'
--    AND purpose       = 'receptionist_agent'
--  ORDER BY active DESC, updated_at DESC;
--
-- Expected: provider_resource_id = 'agent_75125d59f510d8b6e70f907ee5'
--           active               = true
--           superseded_at        = NULL
--           profile_version      unchanged from before the cutover
--
-- Blast-radius check — this must return 0. If it returns anything, something
-- other than the intended row was modified in the last five minutes:
--
-- SELECT count(*) AS unexpected_rows
--   FROM public.provider_resources
--  WHERE updated_at > now() - interval '5 minutes'
--    AND NOT (client_id = 'sandbox-fixture-locksmith'
--             AND provider = 'retell'
--             AND resource_type = 'voice_agent'
--             AND purpose = 'receptionist_agent');
--
-- ============================================================================
-- ROLLBACK — restores the OLD agent id. Same guards, mirrored.
-- Apply this if the founder live call fails. The old Retell resources are
-- retained and untouched, so this fully restores the previous working state
-- once the number is also rebound to the old agent.
-- ============================================================================
--
-- BEGIN;
--
-- DO $$
-- DECLARE
--   match_count  integer;
--   rows_written integer;
-- BEGIN
--   SELECT count(*) INTO match_count
--     FROM public.provider_resources
--    WHERE client_id            = 'sandbox-fixture-locksmith'
--      AND provider             = 'retell'
--      AND resource_type        = 'voice_agent'
--      AND purpose              = 'receptionist_agent'
--      AND provider_resource_id = 'agent_75125d59f510d8b6e70f907ee5'
--      AND active               = true;
--
--   IF match_count = 0 THEN
--     RAISE EXCEPTION 'Refusing rollback: no ACTIVE row carrying the NEW agent id. Nothing to roll back.';
--   ELSIF match_count > 1 THEN
--     RAISE EXCEPTION 'Refusing rollback: % active rows match, expected exactly 1.', match_count;
--   END IF;
--
--   UPDATE public.provider_resources
--      SET provider_resource_id = 'agent_f5ceb1f7af5db76f9ee23e83e5',
--          provider_version     = '0',
--          provider_tag         = 'dev',
--          last_synced_at       = now(),
--          updated_at           = now()
--    WHERE client_id            = 'sandbox-fixture-locksmith'
--      AND provider             = 'retell'
--      AND resource_type        = 'voice_agent'
--      AND purpose              = 'receptionist_agent'
--      AND provider_resource_id = 'agent_75125d59f510d8b6e70f907ee5'
--      AND active               = true;
--
--   GET DIAGNOSTICS rows_written = ROW_COUNT;
--   IF rows_written <> 1 THEN
--     RAISE EXCEPTION 'Refusing rollback: UPDATE wrote % rows, expected exactly 1.', rows_written;
--   END IF;
--
--   RAISE NOTICE 'Rollback applied to exactly 1 row.';
-- END $$;
--
-- COMMIT;
--
-- ============================================================================
-- COMPILED ARTEFACT PROVENANCE (informational — no column is set from this)
--
--   client_id        sandbox-fixture-locksmith
--   profile_version  2
--   compiler         locksmith-receptionist-compiler-2026-08-01
--   template         retell-sandbox-receptionist-2026-08-03
--   specHash         3a5f9364ae99d780488ffc2550a8c1988595890a0fcedcdc70d450e839d62186
--   knowledgeHash    8f957be6bd8a91961d7067cd157b4b26272bf45ca5e4f10bfb13a8d44dfca614
--   toolSchemaHash   4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945
--                    (= sha256 of an empty tool list — this build emits ZERO tools)
--
-- DRIFT NOTE, DELIBERATELY NOT ACTED ON:
-- The row's existing payload_hash and idempotency_key still describe the OLD
-- build. The brief scoped this cutover to the agent id, version and tag, so they
-- are left alone rather than rewritten underneath a unique constraint. The
-- consequence is that a future planner comparing hashes will see this resource
-- as drifted and want to re-provision it. Decide that separately — updating
-- payload_hash without also recomputing idempotency_key (which is derived from
-- it) would leave the registry internally inconsistent, which is worse than a
-- stale-but-honest hash.
-- ============================================================================
