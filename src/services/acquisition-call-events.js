// AIDA Locksmith Acquisition — the return path (E-7B2B1).
//
//   handleAcquisitionCallEvent({ ... })   one verified event -> at most one effect
//   classifyTechnicalOutcome(reason)      disconnection_reason -> outcome or null
//   EVENT_CODES / TECHNICAL_OUTCOME_MAP
//
// ── OFFLINE. THERE IS NO ROUTE TO THIS FILE ─────────────────────────
// Nothing mounts it, no server exposes it, and it opens no socket. It is a pure
// function of (event, store, recorder) and it is tested with fixtures. Wiring it
// to a URL Retell can reach is E-7B2B, and it is deliberately not done here:
// this is the return path of a call that cannot yet be placed.
//
// ── IT AUTHENTICATES NOTHING, AND REFUSES ANYTHING UNAUTHENTICATED ──
// Retell signature verification already exists (services/retell-webhook-verify)
// and a second implementation would be a second thing to get wrong. So this
// file does not verify — it REFUSES to act on an envelope that does not already
// say it was verified. The guard is one line and it is load-bearing: an
// unverified event produces no lookup, no binding, no outcome and no
// resolution.
//
// ── THE ORDER, AND WHY EACH STEP IS WHERE IT IS ─────────────────────
//
//   verified?           -> no  : nothing happens
//   dispatch id?        -> no  : nothing happens. We do not guess a prospect
//   dispatch exists?    -> no  : nothing happens. An unmatched event is reported
//   correlation agrees? -> no  : nothing happens
//   already resolved?   -> yes : nothing happens. THIS IS THE IDEMPOTENCY
//   bind the call id          : at most once, never overwritten
//   classify                  : and only if the answer is durable
//   record the outcome        : the business fact, FIRST
//   resolve the dispatch      : the lock, SECOND, and only if the first worked
//
// ── WHAT IT MAY NOT DO, STRUCTURALLY ────────────────────────────────
// It never writes a suppression. An opt-out suppresses a business permanently,
// and that consequence belongs to acquisition-outcome.js, which already owns
// it. This file produces a CLASSIFICATION and hands it over. A ratchet asserts
// no suppression call appears here.
//
// It never places a call, never redials, never schedules a callback, and never
// resolves a dispatch that has no durable outcome behind it.

const { recordOutcomeAndResolveDispatch } = require("./acquisition-dispatch-resolution");
const { validateAcquisitionAnalysis, classifyAnalysedOutcome } = require("./acquisition-agent-contract");
const { establishContactFact, CONTACT_FACTS } = require("./acquisition-contact-lifecycle");

const EVENT_CODES = Object.freeze({
  NOT_VERIFIED: "acquisition_event_not_verified",
  IGNORED: "acquisition_event_ignored",
  NO_DISPATCH_ID: "acquisition_event_no_dispatch_id",
  UNKNOWN_DISPATCH: "acquisition_event_unknown_dispatch",
  CORRELATION_MISMATCH: "acquisition_event_correlation_mismatch",
  CALL_ID_CONFLICT: "acquisition_event_call_id_conflict",
  ALREADY_RESOLVED: "acquisition_event_already_resolved",
  BOUND: "acquisition_event_call_id_bound",
  AWAITING_ANALYSIS: "acquisition_event_awaiting_analysis",
  NEEDS_HUMAN: "acquisition_event_needs_human_review",
  OUTCOME_RECORDED: "acquisition_event_outcome_recorded",
  OUTCOME_FAILED: "acquisition_event_outcome_failed",
  STORE_UNAVAILABLE: "acquisition_event_store_unavailable",
  // E-9: this provider call already belongs to a DIFFERENT dispatch. A
  // permanent identity conflict, not an outage, and never a retry.
  CALL_ID_TAKEN: "acquisition_event_call_id_taken",
  // E-8: the lifecycle could not be made to say truthfully what happened, so
  // nothing was recorded against it.
  LIFECYCLE_REFUSED: "acquisition_event_lifecycle_refused",
});

const HANDLED_EVENTS = Object.freeze(["call_started", "call_ended", "call_analyzed"]);

/**
 * Retell disconnection reasons that settle the question WITHOUT a conversation.
 *
 * Only reasons already represented in this repository appear here; nothing is
 * invented. The absent ones are absent on purpose:
 *
 *   user_hangup / agent_hangup   somebody TALKED to us. What was said decides
 *                                the outcome, and only the analysis knows it.
 *                                Resolving these here would let "they hung up"
 *                                become a durable business conclusion.
 *   inactivity / max_duration    likewise connected. Await the analysis.
 *   error / dial_failed          we cannot tell whether a telephone rang.
 *                                No outcome, lock held, an operator decides.
 */
const TECHNICAL_OUTCOME_MAP = Object.freeze({
  dial_no_answer: "no_answer",
  voicemail_reached: "voicemail",
  machine_detected: "voicemail",
  // Nobody was reached. Under A-L7 this consumes no counted attempt, which is
  // the correct reading: a busy signal is not a conversation.
  dial_busy: "no_answer",
});

/** A durable outcome for a technical end, or null when only a human can say. */
function classifyTechnicalOutcome(disconnectionReason) {
  if (typeof disconnectionReason !== "string" || !disconnectionReason) return null;
  return TECHNICAL_OUTCOME_MAP[disconnectionReason] || null;
}

const outcome = (code, message, extra = {}) =>
  Object.freeze({ ok: false, code, message, mutated: false, outcomeRecorded: false, dispatchResolved: false, ...extra });

/** The laq6 constraint and the token its guard raises. */
const PROVIDER_REF_INDEX = "idx_acq_dial_exec_provider_ref";
const WRITE_ONCE_TOKEN = "acq_provider_ref_write_once";

/**
 * Classify a failed binding: "taken" (another dispatch owns this call),
 * "write_once" (this dispatch already holds a different one), or "unknown".
 *
 * Matched on the SQLSTATE and the constraint first, and on the text only as the
 * fallback PostgREST sometimes forces — the same two-way match
 * acquisition-dispatch-store already uses for laq5's indexes, and the reason
 * `fail()` now preserves `code` and `constraint` at all.
 */
function classifyBindFailure(err) {
  const text = `${(err && err.message) || ""} ${(err && err.details) || ""} ${(err && err.hint) || ""} ${(err && err.constraint) || ""}`;
  if (text.includes(WRITE_ONCE_TOKEN)) return "write_once";
  if ((err && err.constraint) === PROVIDER_REF_INDEX) return "taken";
  if (new RegExp(PROVIDER_REF_INDEX, "i").test(text)) return "taken";
  if ((err && err.code) === "23505" && /provider_ref/i.test(text)) return "taken";
  return "unknown";
}

/**
 * Handle one already-verified Retell event for an acquisition dispatch.
 *
 * @param {boolean}  verified        must be strictly true
 * @param {string}   eventType       call_started | call_ended | call_analyzed
 * @param {string}   providerCallId  Retell's call_id
 * @param {object}   call            the raw call object, carrying metadata
 * @param {object}   store           the durable store
 * @param {object}   recorder        an acquisition-outcome recorder
 * @param {function} now
 * @param {string}   [actor]
 */
async function handleAcquisitionCallEvent({
  verified = false,
  eventType = null,
  providerCallId = null,
  call = null,
  store = null,
  recorder = null,
  now,
  actor = "retell-acquisition-webhook",
} = {}) {
  if (typeof now !== "function") throw new Error("handleAcquisitionCallEvent requires an injected now().");

  // ── 1. UNVERIFIED IS UNTOUCHED ───────────────────────────────────
  if (verified !== true) {
    return outcome(EVENT_CODES.NOT_VERIFIED, "This event was not verified, so nothing was read and nothing was written.");
  }
  if (!HANDLED_EVENTS.includes(eventType)) {
    return outcome(EVENT_CODES.IGNORED, `"${eventType}" is not an event the acquisition path acts on.`);
  }
  if (!store || typeof store.listDialExecutions !== "function") {
    return outcome(EVENT_CODES.STORE_UNAVAILABLE, "The dispatch ledger cannot be read, so no acquisition event may be applied.");
  }

  // ── 2. CORRELATION, BY THE DURABLE KEY ONLY ──────────────────────
  const metadata = call && typeof call.metadata === "object" && call.metadata ? call.metadata : {};
  const dispatchId = typeof metadata.aida_dispatch_id === "string" ? metadata.aida_dispatch_id.trim() : "";
  if (!dispatchId) {
    return outcome(
      EVENT_CODES.NO_DISPATCH_ID,
      "The event carries no aida_dispatch_id. It is NOT matched to a prospect by number, name or anything else — " +
        "a guessed correlation is how the wrong business acquires somebody else's outcome."
    );
  }

  // A DIRECT lookup on the durable key. No scan, and no recomputation of the
  // executor's execution-id hash.
  let rows;
  try {
    rows = await store.listDialExecutions({ dispatchId });
  } catch (err) {
    return outcome(EVENT_CODES.STORE_UNAVAILABLE, `The dispatch ledger could not be read: ${err.message}`);
  }
  const dispatch = (rows || []).find((r) => r.dispatchId === dispatchId) || null;
  if (!dispatch) {
    return outcome(EVENT_CODES.UNKNOWN_DISPATCH, `No dispatch ${dispatchId} exists here. The event is unmatched and nothing was written.`, { dispatchId });
  }

  // Secondary consistency. It may refuse, but it may never be what MATCHED.
  const claimedProspect = typeof metadata.aida_prospect_id === "string" ? metadata.aida_prospect_id : null;
  if (claimedProspect && claimedProspect !== dispatch.prospectId) {
    return outcome(
      EVENT_CODES.CORRELATION_MISMATCH,
      `The event names prospect ${claimedProspect} but dispatch ${dispatchId} belongs to ${dispatch.prospectId}.`,
      { dispatchId }
    );
  }

  // ── 3. ALREADY FINISHED? THEN THIS IS A REDELIVERY ───────────────
  // The durable idempotency for everything below: a resolved dispatch cannot be
  // reopened (the laq5 guard says so), so a second delivery of an event that
  // already produced an outcome produces nothing.
  if (dispatch.resolvedAt) {
    return Object.freeze({
      ok: true,
      code: EVENT_CODES.ALREADY_RESOLVED,
      message: `Dispatch ${dispatchId} was already resolved at ${dispatch.resolvedAt}. This delivery changed nothing.`,
      mutated: false,
      outcomeRecorded: false,
      dispatchResolved: false,
      dispatchId,
    });
  }

  // ── 4. BIND THE CALL ID — AT MOST ONCE, NEVER OVERWRITTEN ────────
  let bound = false;
  if (providerCallId) {
    if (!dispatch.providerRef) {
      try {
        // providerRef ONLY. provider_status is deliberately untouched: the laq5
        // guard makes it forward-only out of 'pending', so a dispatch left
        // 'unknown' by a lost response stays 'unknown' — which remains the
        // truth about what we knew when we submitted. What changes is that we
        // now know WHICH CALL it was.
        await store.updateDialExecution(dispatchId, { providerRef: providerCallId });
        bound = true;
      } catch (err) {
        // ── THE DATABASE'S VERDICT, NOT OUR GUESS (E-9) ────────────
        //
        // The pre-read above is a courtesy: it gives a better message and
        // handles the common case, and it is NOT the authority. Two workers can
        // both read NULL and both arrive here. What decides is laq6.
        //
        // Three outcomes, and telling them apart is the whole point — calling a
        // permanent identity conflict "store unavailable" would invite a retry
        // of the one thing that must never be retried.
        const verdict = classifyBindFailure(err);
        if (verdict === "taken") {
          return outcome(
            EVENT_CODES.CALL_ID_TAKEN,
            `Call ${providerCallId} already belongs to a different dispatch, so it was NOT bound to ${dispatchId}. ` +
              "This is a permanent conflict for a human to reconcile; nothing was retried and no outcome was recorded.",
            { dispatchId, claimedCallId: providerCallId }
          );
        }
        if (verdict === "write_once") {
          return outcome(
            EVENT_CODES.CALL_ID_CONFLICT,
            `Dispatch ${dispatchId} is already bound to a different call, and provider references are write-once. ` +
              `It was NOT rebound to ${providerCallId}. Nothing was retried and no outcome was recorded.`,
            { dispatchId, claimedCallId: providerCallId }
          );
        }
        return outcome(EVENT_CODES.STORE_UNAVAILABLE, `The call id could not be bound to dispatch ${dispatchId}: ${err.message}`, { dispatchId });
      }
    } else if (dispatch.providerRef !== providerCallId) {
      // ONE dispatch, AT MOST ONE call id. A second, different id means
      // something we do not understand has happened, and overwriting the first
      // would destroy the only record of it.
      return outcome(
        EVENT_CODES.CALL_ID_CONFLICT,
        `Dispatch ${dispatchId} is already bound to ${dispatch.providerRef}; this event claims ${providerCallId}. ` +
          "The existing binding was NOT overwritten and no outcome was recorded.",
        { dispatchId, boundCallId: dispatch.providerRef, claimedCallId: providerCallId }
      );
    }
  }

  const settled = (code, message, extra = {}) =>
    Object.freeze({ ok: true, code, message, mutated: bound, outcomeRecorded: false, dispatchResolved: false, dispatchId, callIdBound: bound, ...extra });

  // ── 4b. THE CALL EXISTS, SO THE ATTEMPT IS A FACT (E-8) ──────────
  //
  // An authenticated event correlated to dispatch D and carrying a real
  // Retell call_id is durable evidence that a call was created. That is
  // `attempted`, and establishing it here is what recovers the case the
  // executor could not: a LOST HTTP RESPONSE, where provider_status stayed
  // `unknown` and no attempt could honestly be claimed at submission time.
  //
  // It establishes `attempted` and NOTHING MORE. Not connected — a call
  // existing is not a person answering, and in this repository only
  // transfer_bridged maps to "connected" while call_started maps to "started".
  // Inferring an answer from an event name is exactly the mistake this
  // milestone exists to prevent.
  //
  // Idempotent, and never backwards: a prospect already `connected` stays
  // `connected` when a duplicate call_started arrives, and events do arrive
  // out of order.
  let attemptEstablished = null;
  if (providerCallId) {
    attemptEstablished = await establishContactFact({
      store,
      prospectId: dispatch.prospectId,
      fact: CONTACT_FACTS.ATTEMPTED,
      actor,
      reason: `Retell call ${providerCallId} exists for dispatch ${dispatchId}, so a call was placed.`,
      at: now().toISOString(),
    });
  }

  // ── 5. PHASE ─────────────────────────────────────────────────────
  //
  // call_started establishes WHICH CALL, never WHAT HAPPENED.
  if (eventType === "call_started") {
    return settled(
      EVENT_CODES.BOUND,
      `Dispatch ${dispatchId} is bound to call ${providerCallId || "(none supplied)"}. ` +
        `${attemptEstablished && attemptEstablished.ok ? `The attempt is recorded as a fact ("${attemptEstablished.to}").` : ""} ` +
        "No contact outcome is implied and the dispatch stays unresolved.",
      { lifecycle: attemptEstablished ? attemptEstablished.to : null }
    );
  }

  let classified = null;

  if (eventType === "call_ended") {
    const technical = classifyTechnicalOutcome(call && call.disconnection_reason);
    if (!technical) {
      // Connected, or unexplained. EITHER WAY WE WAIT.
      //
      // This is the ordering decision the milestone turns on: call_ended
      // routinely arrives BEFORE call_analyzed, and outcomes are append-only.
      // Writing "they hung up" now would put a technical fact in the durable
      // history where a business conclusion belongs, and the later analysis
      // could not correct it without a second, contradictory row.
      return settled(
        EVENT_CODES.AWAITING_ANALYSIS,
        `The call ended as "${(call && call.disconnection_reason) || "unspecified"}", which does not settle what the business said. ` +
          "No outcome was recorded and the dispatch still holds this business and this number."
      );
    }
    classified = { outcome: technical, reason: `Retell reported ${call.disconnection_reason}.` };
  }

  if (eventType === "call_analyzed") {
    const verdict = validateAcquisitionAnalysis(call && call.call_analysis);
    if (!verdict.ok) {
      // Includes the unsupported-opt-out case. NOTHING is recorded, and the
      // dispatch keeps its locks until a person looks at it.
      return settled(EVENT_CODES.NEEDS_HUMAN, `${verdict.message} The dispatch is unresolved and needs human review.`, { analysisCode: verdict.code });
    }
    const mapped = classifyAnalysedOutcome(verdict.analysis);
    if (!mapped.outcome) {
      return settled(EVENT_CODES.NEEDS_HUMAN, `${mapped.reason} No outcome was recorded and the dispatch needs human review.`);
    }
    classified = { outcome: mapped.outcome, reason: mapped.reason, callbackAt: mapped.callbackAt || null, reachedHuman: verdict.analysis.reachedHuman === true };
  }

  // ── 5b. THE LIFECYCLE FACT BEFORE THE OUTCOME (E-8) ──────────────
  //
  // `connected` is established ONLY from the analysis saying a person was
  // actually reached — not from call_analyzed merely existing, and not from a
  // call having ended. The outcome guard then has a state it can legitimately
  // record from.
  //
  // ORDERING: if the lifecycle cannot be established, NO OUTCOME IS WRITTEN and
  // the dispatch stays unresolved. A business fact recorded against a lifecycle
  // that denies the call happened is a contradiction in the permanent record,
  // and the safe half is always the one that leaves work for a human.
  if (classified.reachedHuman === true) {
    const connected = await establishContactFact({
      store,
      prospectId: dispatch.prospectId,
      fact: CONTACT_FACTS.CONNECTED,
      actor,
      reason: `The post-call analysis for dispatch ${dispatchId} reports a person was reached.`,
      at: now().toISOString(),
    });
    if (!connected.ok) {
      return outcome(
        EVENT_CODES.LIFECYCLE_REFUSED,
        `${connected.message} No outcome was recorded and the dispatch still holds this business and this number.`,
        { dispatchId, lifecycleCode: connected.code }
      );
    }
  } else if (attemptEstablished && !attemptEstablished.ok) {
    // A technical outcome still needs the attempt to be a fact.
    return outcome(
      EVENT_CODES.LIFECYCLE_REFUSED,
      `${attemptEstablished.message} No outcome was recorded and the dispatch still holds this business and this number.`,
      { dispatchId, lifecycleCode: attemptEstablished.code }
    );
  }

  // ── 6. THE BUSINESS FACT FIRST, THE LOCK SECOND ──────────────────
  let prospect = null;
  try {
    prospect = await store.loadProspect(dispatch.prospectId);
  } catch (err) {
    return outcome(EVENT_CODES.STORE_UNAVAILABLE, `The prospect could not be read, so no outcome was recorded: ${err.message}`, { dispatchId });
  }
  if (!prospect) {
    return outcome(EVENT_CODES.UNKNOWN_DISPATCH, `Dispatch ${dispatchId} names prospect ${dispatch.prospectId}, which does not exist.`, { dispatchId });
  }

  // recordOutcomeAndResolveDispatch owns the ordering: outcome, then lock, and
  // the lock is never released when the outcome failed. Reused rather than
  // reimplemented so there is exactly one place that ordering lives.
  const result = await recordOutcomeAndResolveDispatch({
    store,
    recorder,
    prospect,
    outcome: classified.outcome,
    dispatchId,
    actor,
    note: `${classified.reason}${classified.callbackAt ? ` Callback requested for ${classified.callbackAt}.` : ""}`,
    e164: dispatch.destinationE164 || null,
    now,
  });

  if (!result.ok) {
    return Object.freeze({
      ok: false,
      code: EVENT_CODES.OUTCOME_FAILED,
      message: result.message,
      mutated: bound || Boolean(result.outcomeRecorded),
      outcomeRecorded: Boolean(result.outcomeRecorded),
      dispatchResolved: false,
      dispatchId,
      classifiedOutcome: classified.outcome,
    });
  }

  return Object.freeze({
    ok: true,
    code: EVENT_CODES.OUTCOME_RECORDED,
    message: result.message,
    mutated: true,
    outcomeRecorded: true,
    dispatchResolved: true,
    dispatchId,
    callIdBound: bound,
    classifiedOutcome: classified.outcome,
    callbackAt: classified.callbackAt || null,
  });
}

module.exports = {
  handleAcquisitionCallEvent,
  classifyTechnicalOutcome,
  TECHNICAL_OUTCOME_MAP,
  EVENT_CODES,
  HANDLED_EVENTS,
};
