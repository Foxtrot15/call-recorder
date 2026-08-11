// AIDA Locksmith Acquisition — releasing a dispatch lock (E-7B1).
//
//   recordOutcomeAndResolveDispatch({ store, recorder, ... })
//   resolveAbnormalDispatch({ store, dispatchId, resolvedBy, reason, now })
//
// A claimed dispatch holds two locks — the prospect and the destination — and
// holds them until one of exactly two things happens. This file is both of them,
// and nothing else in the repository may set `resolved_at`.
//
// ── WHY THE ORDER IS THE WHOLE DESIGN ───────────────────────────────
// There are no cross-table transactions here. acquisition-durable.js has said so
// since M8C: PostgREST issues one statement per call, so "write the outcome and
// release the lock" cannot be made atomic from this side. That is not a gap to
// be papered over with a stored procedure; it is a choice about WHICH HALF MAY
// SURVIVE ALONE, and the two halves are not equally bad.
//
//   outcome written, lock not released
//       -> the business is safe. A human sees an unresolved dispatch, checks
//          the outcome, and closes it. Manual work, and nothing worse.
//
//   lock released, outcome missing
//       -> the prospect and the number are free again, the attempt history says
//          this business was never contacted, and the next worker rings a phone
//          somebody has already been called on. This is the accident the entire
//          pipeline exists to prevent.
//
// So: OUTCOME FIRST, and if it fails the resolution is REFUSED — not attempted
// with a warning, refused. If the outcome succeeds and the release then fails,
// that is reported with `outcomeRecorded: true` so an operator can see the
// business is safe and only the lock is stuck.
//
// The forbidden state is UNREACHABLE, not merely unlikely: releasing is strictly
// the second statement, so nothing can release before an outcome exists.
//
// A crash may create manual work. It must never create a second call.
//
// ── AN RPC WOULD NOT IMPROVE THIS ───────────────────────────────────
// A database function could make both writes atomic and remove the manual-work
// case. It is deliberately not used: it would put dispatch semantics in a second
// language, in a place the rest of the acquisition domain does not live, to
// optimise away the failure mode that was explicitly chosen as acceptable. The
// property that matters is already guaranteed by ordering.

const { resolveDispatchForOutcome, resolveDispatchByOperator } = require("./acquisition-dispatch-store");

/**
 * Record what happened to a business, then release the dispatch that was
 * waiting on it.
 *
 * @param {object}   store       the durable store
 * @param {object}   recorder    an outcome recorder (acquisition-outcome)
 * @param {object}   prospect
 * @param {string}   outcome     a CALL_OUTCOMES value
 * @param {string}   dispatchId  the dispatch this outcome answers
 * @param {function} now
 */
async function recordOutcomeAndResolveDispatch({ store, recorder, prospect, outcome, dispatchId, actor, note = null, e164 = null, now } = {}) {
  if (typeof now !== "function") throw new Error("recordOutcomeAndResolveDispatch requires an injected now().");
  if (!dispatchId) {
    return Object.freeze({ ok: false, outcomeRecorded: false, dispatchResolved: false, message: "There is no dispatch to resolve." });
  }
  if (!recorder || typeof recorder.record !== "function") {
    return Object.freeze({ ok: false, outcomeRecorded: false, dispatchResolved: false, message: "No outcome recorder was supplied, so nothing may be resolved." });
  }

  // ── STEP 1: THE BUSINESS FACT ────────────────────────────────────
  let recorded;
  try {
    recorded = await recorder.record({ prospect, outcome, actor, note, e164, at: now() });
  } catch (err) {
    return Object.freeze({
      ok: false,
      outcomeRecorded: false,
      dispatchResolved: false,
      message: `The contact outcome could not be recorded, so the dispatch was NOT resolved and still holds this business and this number: ${err.message}`,
    });
  }

  if (recorded && recorded.ok === false) {
    return Object.freeze({
      ok: false,
      outcomeRecorded: false,
      dispatchResolved: false,
      message: `The contact outcome was refused, so the dispatch was NOT resolved and still holds this business and this number: ${recorded.message || "no reason given"}`,
    });
  }

  // ── STEP 2: AND ONLY NOW, THE LOCK ───────────────────────────────
  const released = await resolveDispatchForOutcome({
    store,
    dispatchId,
    resolvedBy: actor,
    note: `Contact outcome "${outcome}" recorded; the attempt policy governs from here.`,
    now,
  });

  if (!released.ok) {
    return Object.freeze({
      ok: false,
      outcomeRecorded: true,
      dispatchResolved: false,
      dispatchId,
      message:
        `The contact outcome IS recorded, so the business is accounted for — but the dispatch could not be released and still holds ` +
        `this business and this number: ${released.message} An operator can close it.`,
    });
  }

  return Object.freeze({
    ok: true,
    outcomeRecorded: true,
    dispatchResolved: true,
    dispatchId,
    message: `Outcome "${outcome}" recorded and dispatch ${dispatchId} resolved. The locks are released and the M8J attempt policy governs from here.`,
  });
}

/**
 * The other way out: a named human closes a dispatch nobody can explain.
 *
 * For the crash cases — claimed and never submitted, submitted and never
 * answered, a provider that vanished. Somebody has to decide whether that phone
 * rang, and this records that they did.
 *
 * DELIBERATELY MANUAL. Nothing automatic may call it: not a provider, not a
 * retry, not a reaper, not a timeout. A test asserts no such caller exists.
 */
async function resolveAbnormalDispatch({ store, dispatchId, resolvedBy, reason, now } = {}) {
  return resolveDispatchByOperator({ store, dispatchId, resolvedBy, reason, now });
}

module.exports = {
  recordOutcomeAndResolveDispatch,
  resolveAbnormalDispatch,
};
