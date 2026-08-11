// AIDA Locksmith Acquisition — the durable emergency stop (E-7B1).
//
//   readCallingState({ store })              the authoritative read
//   pauseAcquisitionCalling({ ... })         stop, now
//   enableAcquisitionCalling({ ... })        a deliberate, attributed decision
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// Until now the kill switch was `context.campaign.killSwitchEngaged` — a field
// a CALLER supplied. Two things were wrong with that, and the second is worse:
//
//   1. a caller could simply not pass it, and
//   2. the eligibility engine's default for a missing campaign is PASS:
//
//        add(pass("campaign", campaign ? "The campaign permits this business."
//                                      : "No campaign restrictions apply."));
//
// ABSENCE MEANT GO. That is survivable while nothing dials. It is not
// survivable for an emergency stop, whose entire job is to work when somebody
// is panicking and nothing else is going right.
//
// ── EVERY UNCERTAIN ANSWER IS A BLOCK ───────────────────────────────
//
//     row says 'enabled'      -> permitted
//     row says 'paused'       -> BLOCK
//     row says anything else  -> BLOCK
//     row is missing          -> BLOCK   (laq5 has not run, or somebody removed it)
//     store cannot be read    -> BLOCK
//     store has no method     -> BLOCK
//     no store at all         -> BLOCK
//
// There is exactly one path to `permitted: true`, and it requires a durable row
// that says the word. No caller may supply, override or substitute this: the
// executor reads it itself, and `callingState` is on the executor's forbidden
// options list.
//
// ── THE ORDER OF THE TWO WRITES DEPENDS ON THE DIRECTION ────────────
// State changes are audited into acquisition_decisions, which needs no new SQL
// (`entity_type` has admitted 'campaign' and 'system' since laq1). Audit and
// state cannot be written atomically — there are no cross-table transactions
// here, as acquisition-durable.js has said since M8C. So the order is chosen
// per direction, and both orders fail towards silence rather than towards calls:
//
//   ENABLING   audit FIRST, then state.   Audit fails -> stays paused.
//   PAUSING    state FIRST, then audit.   Audit fails -> already stopped.
//
// An audit failure can therefore only ever leave calling OFF. And because the
// state row carries its own changedBy / changedAt / reason / revision, a
// missing decision row costs history, never safety.
//
// Pure except for the store calls. See test/acquisition-calling-state.test.js.

const { assertStoreContract } = require("./acquisition-store");

const CALLING_STATES = Object.freeze(["enabled", "paused"]);

const STATE_CODES = Object.freeze({
  ENABLED: "acquisition_calling_enabled",
  PAUSED: "acquisition_calling_paused",
  MISSING: "acquisition_calling_state_missing",
  UNAVAILABLE: "acquisition_calling_state_unavailable",
  UNKNOWN_STATE: "acquisition_calling_state_unrecognised",
});

const blocked = (code, message, extra = {}) =>
  Object.freeze({ permitted: false, code, message, state: null, revision: null, changedBy: null, changedAt: null, reason: null, ...extra });

/**
 * THE AUTHORITATIVE READ. Never cached, never memoised, never defaulted.
 *
 * It is called twice per dispatch on purpose — once as a preflight before
 * anything is claimed, and once immediately before the provider — because a
 * stop engaged between those two moments must still stop the call.
 */
async function readCallingState({ store } = {}) {
  if (!store || typeof store !== "object") {
    return blocked(STATE_CODES.UNAVAILABLE, "There is no store to read the acquisition calling state from, so no call is permitted.");
  }

  try {
    assertStoreContract(store, "calling state store");
  } catch (err) {
    return blocked(STATE_CODES.UNAVAILABLE, `The calling state store is not usable, so no call is permitted: ${err.message}`);
  }

  if (typeof store.readCallingState !== "function") {
    return blocked(
      STATE_CODES.UNAVAILABLE,
      "This store cannot report the acquisition calling state. A store that cannot be asked whether calling is stopped may not be used to place calls."
    );
  }

  let row;
  try {
    row = await store.readCallingState();
  } catch (err) {
    // FAIL CLOSED. The same branch as the M8E suppression read, for the same
    // reason: the two available answers are "refuse" and "call somebody while
    // the emergency stop might be engaged", and the second is not an answer.
    return blocked(STATE_CODES.UNAVAILABLE, `Whether acquisition calling is stopped could not be established, so no call is permitted. ${err.message}`);
  }

  if (!row) {
    return blocked(
      STATE_CODES.MISSING,
      "There is no acquisition calling state row. An absent switch is read as STOPPED — laq5 may not have been applied, and absence is never permission."
    );
  }

  const base = {
    state: row.state || null,
    revision: typeof row.revision === "number" ? row.revision : null,
    changedBy: row.changedBy || null,
    changedAt: row.changedAt || null,
    reason: row.reason || null,
  };

  if (!CALLING_STATES.includes(row.state)) {
    return blocked(STATE_CODES.UNKNOWN_STATE, `The acquisition calling state reads "${row.state}", which is not a state this system understands. No call is permitted.`, base);
  }

  if (row.state !== "enabled") {
    return blocked(
      STATE_CODES.PAUSED,
      `Acquisition calling is paused${row.changedBy ? ` (by ${row.changedBy}` : ""}${row.changedAt ? ` on ${row.changedAt}` : ""}${row.changedBy ? ")" : ""}: ${row.reason || "no reason recorded"}`,
      base
    );
  }

  return Object.freeze({
    permitted: true,
    code: STATE_CODES.ENABLED,
    message: `Acquisition calling is enabled (revision ${base.revision}, by ${base.changedBy}).`,
    ...base,
  });
}

function requireActor(changedBy, reason) {
  if (!String(changedBy || "").trim()) return "A calling state change must name who made it.";
  if (!String(reason || "").trim()) return "A calling state change must say why.";
  return null;
}

async function auditStateChange({ audit, to, changedBy, reason, revision }) {
  if (!audit) return { ok: true, skipped: true };
  try {
    audit.record({
      entityType: "campaign",
      entityId: "acquisition-global",
      event: to === "enabled" ? "acquisition_calling_enabled" : "acquisition_calling_paused",
      decision: to === "enabled" ? "approve" : "veto",
      actor: changedBy,
      actorKind: "human",
      reason,
      detail: { state: to, revision },
    });
    return { ok: true, skipped: false };
  } catch (err) {
    return { ok: false, skipped: false, message: err.message };
  }
}

/**
 * ENABLE. Audit first, state second.
 *
 * If the audit write fails, the state is never touched and calling stays
 * paused. Turning acquisition calling on is the one operation in this system
 * that should be harder than it needs to be.
 */
async function enableAcquisitionCalling({ store, changedBy, reason, audit = null, expectedRevision = null, now } = {}) {
  if (typeof now !== "function") throw new Error("enableAcquisitionCalling requires an injected now().");
  const bad = requireActor(changedBy, reason);
  if (bad) return Object.freeze({ ok: false, code: "actor_required", message: bad });

  const current = await readCallingState({ store });
  if (current.code === STATE_CODES.UNAVAILABLE || current.code === STATE_CODES.MISSING) {
    return Object.freeze({ ok: false, code: current.code, message: `Acquisition calling cannot be enabled: ${current.message}` });
  }
  const nextRevision = (current.revision || 0) + 1;

  // ── AUDIT FIRST ──────────────────────────────────────────────────
  const audited = await auditStateChange({ audit, to: "enabled", changedBy, reason, revision: nextRevision });
  if (!audited.ok) {
    return Object.freeze({
      ok: false,
      code: "audit_failed",
      state: current.state,
      message: `The decision log could not record this change, so acquisition calling was NOT enabled and remains ${current.state}: ${audited.message}`,
    });
  }

  try {
    const written = await store.writeCallingState(
      { state: "enabled", revision: nextRevision, changedBy: String(changedBy).trim(), changedAt: now().toISOString(), reason: String(reason).trim() },
      { expectedRevision: expectedRevision === null ? current.revision : expectedRevision }
    );
    return Object.freeze({ ok: true, code: STATE_CODES.ENABLED, state: written.state, revision: written.revision, message: `Acquisition calling enabled by ${written.changedBy} (revision ${written.revision}).` });
  } catch (err) {
    return Object.freeze({
      ok: false,
      code: err.code === "REVISION_CONFLICT" ? "revision_conflict" : "write_failed",
      message: `Acquisition calling was NOT enabled: ${err.message}`,
    });
  }
}

/**
 * PAUSE. State first, audit second.
 *
 * The opposite order, for the opposite reason: stopping must take effect even
 * if everything else is broken. If the audit write then fails, calling is
 * already stopped and the missing history is recoverable — the state row still
 * names who paused it and why.
 */
async function pauseAcquisitionCalling({ store, changedBy, reason, audit = null, expectedRevision = null, now } = {}) {
  if (typeof now !== "function") throw new Error("pauseAcquisitionCalling requires an injected now().");
  const bad = requireActor(changedBy, reason);
  if (bad) return Object.freeze({ ok: false, code: "actor_required", message: bad });

  const current = await readCallingState({ store });
  if (current.code === STATE_CODES.UNAVAILABLE || current.code === STATE_CODES.MISSING) {
    // Nothing to pause, and nothing can dial either: both of those codes
    // already BLOCK at the executor. Reported rather than pretended away.
    return Object.freeze({
      ok: false,
      code: current.code,
      message: `The calling state could not be written, but calling is already blocked for the same reason: ${current.message}`,
      alreadyBlocked: true,
    });
  }
  const nextRevision = (current.revision || 0) + 1;

  // ── STATE FIRST ──────────────────────────────────────────────────
  let written;
  try {
    written = await store.writeCallingState(
      { state: "paused", revision: nextRevision, changedBy: String(changedBy).trim(), changedAt: now().toISOString(), reason: String(reason).trim() },
      { expectedRevision: expectedRevision === null ? current.revision : expectedRevision }
    );
  } catch (err) {
    return Object.freeze({
      ok: false,
      code: err.code === "REVISION_CONFLICT" ? "revision_conflict" : "write_failed",
      message: `ACQUISITION CALLING IS NOT PAUSED — the write failed: ${err.message}. Try again, and if it keeps failing, stop the workers.`,
    });
  }

  const audited = await auditStateChange({ audit, to: "paused", changedBy, reason, revision: written.revision });

  return Object.freeze({
    ok: true,
    code: STATE_CODES.PAUSED,
    state: written.state,
    revision: written.revision,
    audited: audited.ok,
    message: audited.ok
      ? `Acquisition calling paused by ${written.changedBy} (revision ${written.revision}).`
      : `Acquisition calling is PAUSED (revision ${written.revision}) — calls are stopped. The decision log did not record it: ${audited.message}`,
  });
}

module.exports = {
  readCallingState,
  enableAcquisitionCalling,
  pauseAcquisitionCalling,
  STATE_CODES,
  CALLING_STATES,
};
