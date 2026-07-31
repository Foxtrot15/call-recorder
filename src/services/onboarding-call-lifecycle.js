// AIDA — onboarding call lifecycle + transcript-to-review automation (M4).
//
// Turns verified provider events into internal state, then drives the M2
// pipeline: transcript intake → extraction → draft profile → needs_review.
//
// THE REALITIES THIS HANDLES
//   * Events arrive more than once (Retell retries 3×).
//   * Events arrive late, and analysis often arrives AFTER call_ended.
//   * Events arrive OUT OF ORDER. A late call_started after call_ended must not
//     drag the call backwards; it is reconciled and recorded, not applied.
//   * An invalid transition is SURFACED, never silently swallowed — a state
//     machine that quietly ignores impossible input hides real bugs.
//   * A provider call id binds to exactly ONE onboarding session.
//   * Cross-client mismatches fail closed.
//   * Recording URLs are stored as references and never downloaded.
//   * Provider analysis can supplement warnings; it can never approve anything.
//
// Pure decision core + injectable adapters.

const calls = require("./onboarding-call-service");
const sessions = require("./locksmith-onboarding-session");
const intake = require("./locksmith-transcript-intake");
const store = require("./locksmith-profile-store");
const { extractLocksmithProfile } = require("./locksmith-extraction");
const { validateProviderAnalysis, toSupplementaryWarnings } = require("./locksmith-analysis-schema");
const { buildAuditEvent } = require("./locksmith-profile-store");

const INTERNAL_EVENTS = Object.freeze([
  "onboarding_call.requested",
  "onboarding_call.created",
  "onboarding_call.started",
  "onboarding_call.connected",
  "onboarding_call.ended",
  "onboarding_call.transcript_received",
  "onboarding_call.analysis_received",
  "onboarding_call.failed",
]);

// Internal event → the call status it implies.
const EVENT_TO_STATUS = Object.freeze({
  "onboarding_call.started": "dialling",
  "onboarding_call.connected": "connected",
  "onboarding_call.ended": "ended",
  "onboarding_call.transcript_received": "transcript_received",
  "onboarding_call.analysis_received": "analysis_received",
  "onboarding_call.failed": "failed",
});

// Ordering rank. A lower-ranked event arriving after a higher-ranked one is
// late, not wrong: we record it and keep the more advanced state.
const STATUS_RANK = Object.freeze({
  requested: 0, created: 1, dialling: 2, connected: 3, ended: 4,
  transcript_received: 5, analysis_received: 5, failed: 6, cancelled: 6,
});

const OUTCOMES = Object.freeze({
  applied: "applied",
  lateIgnored: "late_event_ignored",
  duplicate: "duplicate",
  invalid: "invalid_transition",
  noBinding: "no_call_binding",
  mismatch: "client_mismatch",
});

/**
 * Decide what a provider event means for a call we already know about.
 * Pure — all the awkward ordering logic is testable without a database.
 */
function reconcileEvent({ call, internalEvent, expectedClientId = null }) {
  if (!call) return { outcome: OUTCOMES.noBinding, message: "no onboarding call is bound to this provider call id" };
  if (expectedClientId && call.client_id !== expectedClientId) {
    return { outcome: OUTCOMES.mismatch, message: "the call belongs to a different client" };
  }

  const target = EVENT_TO_STATUS[internalEvent];
  if (!target) return { outcome: OUTCOMES.invalid, message: `"${internalEvent}" does not map to a call status` };

  if (call.status === target) return { outcome: OUTCOMES.duplicate, message: `the call is already ${target}` };

  const currentRank = STATUS_RANK[call.status] ?? -1;
  const targetRank = STATUS_RANK[target] ?? -1;

  // A late lower-ranked event: keep the advanced state, record the arrival.
  if (targetRank < currentRank) {
    return { outcome: OUTCOMES.lateIgnored, message: `"${internalEvent}" arrived after the call reached ${call.status}`, target };
  }

  if (!calls.canTransition(call.status, target)) {
    // Surfaced, not swallowed. The caller records it as a failed event so the
    // founder console shows something genuinely went wrong.
    return { outcome: OUTCOMES.invalid, message: `a call cannot move from ${call.status} to ${target}`, target };
  }

  return { outcome: OUTCOMES.applied, target };
}

/**
 * Walk a session through an ordered list of statuses, skipping any it is
 * already at or past and stopping at the first genuinely illegal step.
 *
 * Exists because the session machine is strict by design: a caller that wants
 * `needs_review` after a transcript must pass through `transcript_received` and
 * `extraction_pending`. Jumping is not a shortcut, it is a silent failure.
 */
async function advanceSessionTo({ sessionsApi, clientId, sessionId, path, reason, logger }) {
  for (const to of path) {
    const result = await sessionsApi.transitionSession({
      clientId, sessionId, to,
      actor: { type: "system", id: null }, reason, source: "retell",
    });
    if (result && result.ok) continue;
    // A no-op means the session is already there — carry on.
    if (result && result.code === "no_op") continue;
    // Anything else is a real refusal.
    return { ok: false, stoppedAt: to, code: result ? result.code : "unknown", message: result ? result.message : "no result" };
  }
  return { ok: true };
}

/** Column patch for an applied transition, including the provider's own facts. */
function buildLifecyclePatch({ target, providerCall = null }, nowIso = new Date().toISOString()) {
  const patch = { status: target, updated_at: nowIso };

  if (target === "dialling" && providerCall && providerCall.start_timestamp) patch.started_at = new Date(providerCall.start_timestamp).toISOString();
  if (target === "connected" && !patch.started_at) patch.started_at = nowIso;

  if (target === "ended") {
    patch.ended_at = nowIso;
    if (providerCall) {
      const { reason, providerLabel } = calls.normaliseEndReason(providerCall.disconnection_reason);
      patch.end_reason = reason;
      patch.provider_end_label = providerLabel;
      if (Number.isFinite(providerCall.duration_ms)) patch.duration_ms = providerCall.duration_ms;
      // Cost metadata if the provider offers it — bounded, numeric only.
      if (providerCall.call_cost && Number.isFinite(providerCall.call_cost.combined_cost)) {
        patch.provider_cost = providerCall.call_cost.combined_cost;
      }
      // A reference, never a download. We store that a recording exists and
      // where the provider says it is; we never fetch it.
      if (typeof providerCall.recording_url === "string") patch.recording_reference = providerCall.recording_url.slice(0, 500);
    }
  }

  if (target === "transcript_received") patch.transcript_received_at = nowIso;
  if (target === "analysis_received") patch.analysis_received_at = nowIso;
  if (target === "failed" && providerCall) {
    const { reason } = calls.normaliseEndReason(providerCall.disconnection_reason);
    patch.failure_code = reason;
  }
  return patch;
}

// ── The lifecycle service ───────────────────────────────────────────

function createLifecycleService(deps = {}) {
  const logger = deps.logger || console;
  const callsApi = deps.calls || calls.createCallAdapter();
  const sessionsApi = deps.sessions || sessions;
  const storeApi = deps.store || store;
  const intakeApi = deps.intake || intake;
  const extract = deps.extract || extractLocksmithProfile;
  const audit = deps.recordAuditEvent || store.recordAuditEvent;
  const now = deps.now || (() => new Date());
  const env = deps.env || process.env;

  /**
   * Resolve a provider call id to its binding. Used by the webhook handler
   * BEFORE it decides anything, so a mismatch fails closed at the edge.
   */
  async function resolveBinding(providerCallId) {
    const call = await callsApi.findByProviderCallId(providerCallId);
    if (!call) return null;
    return { clientId: call.client_id, sessionId: call.session_id, callId: call.call_id, status: call.status };
  }

  /**
   * Handle one verified internal event. Idempotent by construction: the webhook
   * layer has already deduplicated by fingerprint, and reconcileEvent refuses to
   * re-apply a state the call already holds.
   */
  async function handleEvent({ internalEvent, providerCallId, call: providerCall = null, binding = null }) {
    const call = await callsApi.findByProviderCallId(providerCallId);
    const verdict = reconcileEvent({ call, internalEvent, expectedClientId: binding ? binding.clientId : null });

    if (verdict.outcome === OUTCOMES.noBinding || verdict.outcome === OUTCOMES.mismatch) {
      logger.error(`onboarding_call.event_unbound event=${internalEvent} outcome=${verdict.outcome}`);
      return { ok: false, outcome: verdict.outcome, message: verdict.message };
    }

    if (verdict.outcome === OUTCOMES.duplicate) {
      return { ok: true, outcome: verdict.outcome, message: verdict.message };
    }

    if (verdict.outcome === OUTCOMES.lateIgnored) {
      // Recorded so the trail is honest, but the advanced state stands.
      await audit(buildAuditEvent({
        clientId: call.client_id, sessionId: call.session_id, eventType: "onboarding_call.late_event",
        actorType: "system", reason: internalEvent, source: "retell",
      }));
      return { ok: true, outcome: verdict.outcome, message: verdict.message };
    }

    if (verdict.outcome === OUTCOMES.invalid) {
      // Surfaced loudly. This is a genuine inconsistency worth a founder's time.
      logger.error(`onboarding_call.invalid_transition from=${call.status} event=${internalEvent}`);
      await audit(buildAuditEvent({
        clientId: call.client_id, sessionId: call.session_id, eventType: "onboarding_call.invalid_transition",
        actorType: "system", reason: verdict.message, source: "retell",
      }));
      return { ok: false, outcome: verdict.outcome, message: verdict.message };
    }

    // Apply.
    const patch = buildLifecyclePatch({ target: verdict.target, providerCall }, now().toISOString());
    await callsApi.update(call.client_id, call.call_id, patch);
    await audit(buildAuditEvent({
      clientId: call.client_id, sessionId: call.session_id, eventType: internalEvent,
      actorType: "system", source: "retell", detail: { from: call.status, to: verdict.target },
    }));

    // A completed call carries the transcript; that is where the M2 pipeline
    // takes over.
    if (verdict.target === "ended" && providerCall && typeof providerCall.transcript === "string" && providerCall.transcript.trim()) {
      return processTranscript({ call, transcript: providerCall.transcript, providerCallId });
    }

    if (verdict.target === "analysis_received" && providerCall && providerCall.call_analysis) {
      return processAnalysis({ call, analysis: providerCall.call_analysis });
    }

    return { ok: true, outcome: OUTCOMES.applied, status: verdict.target };
  }

  /**
   * Transcript → draft profile → needs_review. Never auto-approves, never
   * replaces an approved profile, never overwrites an existing transcript.
   */
  async function processTranscript({ call, transcript, providerCallId }) {
    const { client_id: clientId, session_id: sessionId } = call;

    // 1. Idempotent intake. A second transcript for the same session is refused
    //    by the M2 boundary, not silently merged.
    const received = await intakeApi.receiveOnboardingTranscript({
      clientId, sessionId, provider: "retell", providerCallId, transcript,
      actor: { type: "system", id: null },
    });
    if (!received.ok) {
      logger.error(`onboarding_call.transcript_refused code=${received.code}`);
      return { ok: false, outcome: "transcript_refused", code: received.code, message: received.message };
    }
    if (received.code === "duplicate") {
      return { ok: true, outcome: "transcript_duplicate", message: "this transcript was already received" };
    }

    await callsApi.update(clientId, call.call_id, { status: "transcript_received", transcript_received_at: now().toISOString(), updated_at: now().toISOString() });

    // 2. Extract. The approved profile is NOT passed in as a base — a new
    //    interview produces a fresh draft, and the approved version is
    //    untouched either way.
    const result = extract({ transcript, clientId, existingProfile: null });
    if (!result.ok) {
      logger.error(`onboarding_call.extraction_failed code=${result.code}`);
      await sessionsApi.failSession({ clientId, sessionId, code: `extraction_${result.code}`, detail: result.message, actor: { type: "system", id: null } });
      return { ok: false, outcome: "extraction_failed", code: result.code };
    }

    // 3. Draft version. createDraftVersion always INSERTs — an approved profile
    //    cannot be overwritten by this path.
    const approvedBefore = await storeApi.getApprovedVersion(clientId);
    const draft = await storeApi.createDraftVersion({
      clientId, profile: result.profile, sessionId,
      extractionVersion: result.extractionVersion,
      actor: { type: "system", id: null },
      reason: "extracted from onboarding call transcript",
      source: "retell",
    });

    // 4. Warnings: missing fields, contradictions, safety-critical confirms.
    const warnings = [
      ...result.warnings,
      ...result.missingFields.map((m) => ({ code: `missing_${m.path}`, message: `Not established during the call: ${m.label}.`, severity: "blocking" })),
      ...result.contradictions.map((c) => ({ code: c.code, message: c.message, severity: "contradiction" })),
    ];

    // Walk the session through its legal path rather than jumping to the end.
    // M2's machine is deliberately strict — interview_in_progress cannot reach
    // needs_review directly — so a single jump silently fails and the client's
    // journey stalls at "on the call" forever. Each step is checked.
    const walk = await advanceSessionTo({
      sessionsApi, clientId, sessionId,
      path: ["transcript_received", "extraction_pending", "needs_review"],
      reason: "draft profile created from transcript",
      logger,
    });
    if (!walk.ok) {
      logger.error(`onboarding_call.session_stalled at=${walk.stoppedAt} code=${walk.code}`);
      await audit(buildAuditEvent({
        clientId, sessionId, eventType: "onboarding_call.session_stalled", actorType: "system",
        reason: `could not reach needs_review: ${walk.message}`, source: "retell",
      }));
    }

    await audit(buildAuditEvent({
      clientId, sessionId, profileVersion: draft.version,
      eventType: "onboarding_call.draft_created", actorType: "system", source: "retell",
      detail: { warnings: warnings.length, missing: result.missingFields.length, contradictions: result.contradictions.length, approvedUntouched: approvedBefore ? approvedBefore.version : null },
    }));

    return {
      ok: true,
      outcome: "draft_created",
      profileVersion: draft.version,
      warnings,
      approvedProfileUntouched: approvedBefore ? approvedBefore.version : null,
      reviewAvailable: true,
    };
  }

  /**
   * Provider analysis supplements the review with warnings. It CANNOT approve,
   * and it CANNOT write profile fields — there is no code path from here to a
   * profile body.
   */
  async function processAnalysis({ call, analysis }) {
    const { client_id: clientId, session_id: sessionId } = call;
    const validated = validateProviderAnalysis(analysis);

    if (!validated.ok) {
      logger.error(`onboarding_call.analysis_rejected errors=${validated.errors.length}`);
      await audit(buildAuditEvent({
        clientId, sessionId, eventType: "onboarding_call.analysis_rejected", actorType: "system",
        reason: "provider analysis failed validation", source: "retell",
        detail: { errorCount: validated.errors.length },
      }));
      // The transcript-derived draft stands. Nothing is lost.
      return { ok: true, outcome: "analysis_rejected", errors: validated.errors, draftUnaffected: true };
    }

    const supplementary = toSupplementaryWarnings(validated);
    await callsApi.update(clientId, call.call_id, { status: "analysis_received", analysis_received_at: now().toISOString(), updated_at: now().toISOString() });
    await audit(buildAuditEvent({
      clientId, sessionId, eventType: "onboarding_call.analysis_received", actorType: "system", source: "retell",
      detail: { warningCount: supplementary.length, consentConfirmed: validated.analysis.consent_provided === true },
    }));

    return { ok: true, outcome: "analysis_recorded", warnings: supplementary, approved: false, canApprove: false };
  }

  return { resolveBinding, handleEvent, processTranscript, processAnalysis };
}

module.exports = {
  INTERNAL_EVENTS,
  EVENT_TO_STATUS,
  STATUS_RANK,
  OUTCOMES,
  reconcileEvent,
  buildLifecyclePatch,
  advanceSessionTo,
  createLifecycleService,
};
