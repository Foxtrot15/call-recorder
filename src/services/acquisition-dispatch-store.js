// AIDA Locksmith Acquisition — the durable dispatch claim (E-7B1).
//
//   claimAuthorisedDial({ store, dial, provider, claimedBy, now })
//   recordProviderResult({ store, dispatchId, ... })
//   resolveDispatchForOutcome({ store, dispatchId, ... })
//   resolveDispatchByOperator({ store, dispatchId, resolvedBy, reason, now })
//   listUnresolvedDispatches({ store, olderThanMs, now })    READ-ONLY
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────
// E-7A's single-consumption guarantee is a WeakSet in one module in one
// process. It is honest and it is documented, and it is worth exactly nothing
// against a second worker. This moves the arbitration into Postgres.
//
// ── THE DATABASE DECIDES. NOTHING HERE DOES. ────────────────────────
// There is no SELECT-then-INSERT anywhere in this file, and there must never
// be one. Two workers that both read "nothing in flight" and then both write
// are the bug; a single INSERT that one of them loses is the fix. Every outcome
// below is derived from what Postgres did, not from what this process believed
// a moment earlier.
//
// The three ways an INSERT can lose mean three different things, and laq5 names
// its constraints so they can be told apart without parsing English prose:
//
//   primary key on dispatch_id                     ALREADY_CLAIMED — a replay
//   idx_acq_dial_exec_unresolved_prospect          CONFLICT — this business
//   idx_acq_dial_exec_unresolved_destination       CONFLICT — this handset
//
// ── FAIL CLOSED, AS EVERYWHERE ELSE ─────────────────────────────────
// An unreadable or unwritable store is STORE_UNAVAILABLE, and STORE_UNAVAILABLE
// does not dispatch. The same rule the suppression, history, batch and
// duplicate reads have followed since M8E: not knowing is a refusal, never a
// permission.
//
// ── RESOLUTION IS A BUSINESS FACT, NOT A PROVIDER FACT ──────────────
// `recordProviderResult` writes what the mechanism did and DELIBERATELY CANNOT
// set resolved_at — the parameter does not exist. Only two things release a
// lock, and each has its own function so that releasing one is always a
// deliberate act somebody had to type:
//
//   resolveDispatchForOutcome   a durable contact outcome exists
//   resolveDispatchByOperator   a named human adjudicated it
//
// Pure except for the store calls. See test/acquisition-dispatch-store.test.js.

const { assertStoreContract } = require("./acquisition-store");

/** What a claim attempt did. Only CLAIMED may go near a provider. */
const CLAIM_CODES = Object.freeze({
  CLAIMED: "CLAIMED",
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  CONFLICT: "CONFLICT",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
});

/** Why a CONFLICT happened, so a founder screen can say something useful. */
const CONFLICT_SCOPES = Object.freeze({
  PROSPECT: "prospect",
  DESTINATION: "destination",
  UNKNOWN: "unknown",
});

const PROVIDER_STATUS = Object.freeze(["pending", "submitted", "refused", "unknown"]);
const RESOLUTIONS = Object.freeze(["outcome_recorded", "operator_closed"]);

/**
 * The constraint names laq5 gives its indexes.
 *
 * Matched on the name first and the column second, because PostgREST surfaces
 * the detail in `message`, `details` or `hint` depending on the path — the same
 * reason acquisition-store.js matches `uq_acq_decisions_prev_hash` two ways.
 */
const IDX_PROSPECT = "idx_acq_dial_exec_unresolved_prospect";
const IDX_DESTINATION = "idx_acq_dial_exec_unresolved_destination";
const PK_DISPATCH = "acquisition_dial_executions_pkey";

const errorText = (error) =>
  `${(error && error.message) || ""} ${(error && error.details) || ""} ${(error && error.hint) || ""} ${(error && error.constraint) || ""}`;

const isUniqueViolation = (error) =>
  Boolean(error) && (error.code === "23505" || /duplicate key value/i.test(errorText(error)));

function conflictScopeFor(error) {
  const text = errorText(error);
  if (new RegExp(IDX_PROSPECT, "i").test(text)) return CONFLICT_SCOPES.PROSPECT;
  if (new RegExp(IDX_DESTINATION, "i").test(text)) return CONFLICT_SCOPES.DESTINATION;
  return CONFLICT_SCOPES.UNKNOWN;
}

const isDispatchIdViolation = (error) => {
  const text = errorText(error);
  return new RegExp(PK_DISPATCH, "i").test(text) || /\bdispatch_id\b/i.test(text);
};

function clip(value, max = 500) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const outcome = (code, extra = {}) =>
  Object.freeze({
    code,
    claimed: code === CLAIM_CODES.CLAIMED,
    dispatchId: null,
    conflictScope: null,
    message: "",
    ...extra,
  });

/**
 * Claim the right to hand ONE authorised dial to a provider.
 *
 * @param {object}   store       an acquisition store with appendDialExecution
 * @param {object}   dial        a GENUINE AuthorisedDial. Every durable field
 *                               is read off it and off nothing else.
 * @param {object}   provider    { name, live }
 * @param {string}   claimedBy   which worker
 * @param {function} now
 */
async function claimAuthorisedDial({ store, dial, provider, claimedBy = "unknown", now } = {}) {
  if (typeof now !== "function") throw new Error("claimAuthorisedDial requires an injected now().");
  if (!dial || typeof dial !== "object") {
    return outcome(CLAIM_CODES.STORE_UNAVAILABLE, { message: "There is no authorisation to claim." });
  }

  // Deliberately NOT `isGenuineAuthorisedDial` — that check belongs to the
  // executor, which runs it before anything reaches here. Duplicating it would
  // put two answers to one question in two files.
  if (!dial.dispatchId || !dial.prospectId || !dial.e164 || !dial.batchKey) {
    return outcome(CLAIM_CODES.STORE_UNAVAILABLE, {
      message: "This authorisation is missing the identity a durable claim binds: dispatchId, prospectId, destination and batchKey are all required.",
    });
  }

  try {
    assertStoreContract(store, "dispatch store");
    if (typeof store.appendDialExecution !== "function") {
      return outcome(CLAIM_CODES.STORE_UNAVAILABLE, {
        message: "This store cannot record dispatch claims, so no call may be dispatched through it.",
      });
    }
  } catch (err) {
    return outcome(CLAIM_CODES.STORE_UNAVAILABLE, { message: err.message });
  }

  // ── THE SINGLE INSERT ────────────────────────────────────────────
  //
  // Every value comes off the slip. There is no parameter on this function by
  // which a caller could name a different prospect, a different number, or a
  // different approval.
  const row = Object.freeze({
    dispatchId: dial.dispatchId,
    authorisationId: dial.authorisationId || null,
    prospectId: dial.prospectId,
    destinationE164: dial.e164,
    batchKey: dial.batchKey,
    authorisedAt: dial.authorisedAt,
    claimedAt: now().toISOString(),
    claimedBy: clip(claimedBy, 120) || "unknown",
    provider: (provider && provider.name) || "unknown",
    providerLive: Boolean(provider && provider.live === true),
    providerStatus: "pending",
  });

  try {
    await store.appendDialExecution(row);
  } catch (err) {
    if (!isUniqueViolation(err)) {
      // Anything that is not a uniqueness answer is us failing, not the
      // database refusing. We do not know whether the row landed, so we must
      // not dispatch — and we must not retry, for the same reason E-7A does
      // not retry a provider: a lost response is not a "no".
      return outcome(CLAIM_CODES.STORE_UNAVAILABLE, {
        dispatchId: dial.dispatchId,
        message: `The dispatch ledger could not be written, so no call may be placed: ${err.message}`,
      });
    }

    if (isDispatchIdViolation(err)) {
      return outcome(CLAIM_CODES.ALREADY_CLAIMED, {
        dispatchId: dial.dispatchId,
        message: "This authorisation has already been claimed. One authorisation permits at most one submission, across every process.",
      });
    }

    const scope = conflictScopeFor(err);
    return outcome(CLAIM_CODES.CONFLICT, {
      dispatchId: dial.dispatchId,
      conflictScope: scope,
      message:
        scope === CONFLICT_SCOPES.DESTINATION
          ? `Another unresolved dispatch already holds ${dial.e164}. The same handset must not be called twice because two records point at it.`
          : scope === CONFLICT_SCOPES.PROSPECT
            ? "Another unresolved dispatch already holds this business. It stays held until a contact outcome is recorded or an operator resolves it."
            : "Another unresolved dispatch conflicts with this one.",
    });
  }

  return outcome(CLAIM_CODES.CLAIMED, {
    dispatchId: dial.dispatchId,
    message: `Claimed ${dial.dispatchId} for ${dial.e164}. This permits ONE submission and does not resolve anything.`,
  });
}

/**
 * Write what the mechanism did.
 *
 * THERE IS NO `resolvedAt` PARAMETER, AND THERE MUST NEVER BE ONE. A provider
 * status is not an answer about the business, and the single most valuable
 * property of this whole design is that no provider result can release a lock.
 */
async function recordProviderResult({ store, dispatchId, providerStatus, providerRef = null, errorCode = null, now } = {}) {
  if (typeof now !== "function") throw new Error("recordProviderResult requires an injected now().");
  if (!PROVIDER_STATUS.includes(providerStatus) || providerStatus === "pending") {
    throw new Error(`"${providerStatus}" is not a terminal provider status.`);
  }

  const patch = {
    providerStatus,
    providerRef: clip(providerRef, 200),
    errorCode: clip(errorCode, 120),
    // 'unknown' may genuinely not know whether the provider was reached; the
    // laq5 CHECK permits submitted_at either way for exactly that reason.
    submittedAt: providerStatus === "unknown" ? null : now().toISOString(),
  };

  try {
    await store.updateDialExecution(dispatchId, patch);
    return Object.freeze({ ok: true, dispatchId, ...patch });
  } catch (err) {
    // Reported, never thrown into the dispatch path: by the time this runs the
    // provider has already been called, and the lock is already held. Losing
    // the status costs an operator some context; it costs nobody a phone call.
    return Object.freeze({ ok: false, dispatchId, message: err.message, ...patch });
  }
}

/**
 * Release the lock because a durable contact outcome now exists.
 *
 * ── THE ORDERING IS THE WHOLE POINT ─────────────────────────────────
 * The caller must have ALREADY written the outcome. This function does not
 * write one, cannot verify one cheaply, and is documented as the second half of
 * a two-step that must happen in this order:
 *
 *   1. acquisition_contact_outcomes            the business fact
 *   2. resolved_at / resolution                the lock
 *
 * There are no cross-table transactions here — PostgREST issues one statement
 * per call, and acquisition-durable.js has said so since M8C. So the question
 * is not "can this be atomic" but "which half may survive alone", and the
 * answer is the same as it was for suppression: the safe half.
 *
 *   step 1 fails            no outcome, LOCK HELD          safe
 *   step 2 fails            outcome exists, LOCK HELD      safe
 *
 * The forbidden state — lock released, outcome missing — is unreachable,
 * because releasing is strictly second. A crash makes manual work. It never
 * makes a second call.
 */
async function resolveDispatchForOutcome({ store, dispatchId, resolvedBy, note = null, now } = {}) {
  return resolveDispatch({ store, dispatchId, resolution: "outcome_recorded", resolvedBy, note, now });
}

/**
 * Release the lock because a named human adjudicated an abnormal dispatch.
 *
 * The only other way out, and deliberately manual. Nothing automatic may call
 * this: not a provider, not a retry, not a reaper, not a timeout. A dispatch
 * whose fate is unknown is a question for a person, and this is where their
 * answer is recorded.
 */
async function resolveDispatchByOperator({ store, dispatchId, resolvedBy, reason, now } = {}) {
  if (!clip(reason)) {
    return Object.freeze({ ok: false, dispatchId, message: "An operator resolution must say why. A lock released without a reason is a lock nobody can audit." });
  }
  return resolveDispatch({ store, dispatchId, resolution: "operator_closed", resolvedBy, note: reason, now });
}

async function resolveDispatch({ store, dispatchId, resolution, resolvedBy, note, now }) {
  if (typeof now !== "function") throw new Error("resolving a dispatch requires an injected now().");
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`"${resolution}" is not a resolution.`);
  if (!clip(resolvedBy)) {
    return Object.freeze({ ok: false, dispatchId, message: "A resolution must name who made it." });
  }
  if (!dispatchId) {
    return Object.freeze({ ok: false, dispatchId: null, message: "There is no dispatch to resolve." });
  }

  try {
    await store.updateDialExecution(dispatchId, {
      resolvedAt: now().toISOString(),
      resolution,
      resolvedBy: clip(resolvedBy, 120),
      resolutionNote: clip(note, 500),
    });
    return Object.freeze({ ok: true, dispatchId, resolution, message: `Dispatch ${dispatchId} resolved as ${resolution}. The prospect and destination locks are released.` });
  } catch (err) {
    return Object.freeze({
      ok: false,
      dispatchId,
      resolution,
      message: `The dispatch could not be resolved, so its locks are still held: ${err.message}`,
    });
  }
}

/**
 * READ-ONLY. Which dispatches are still unresolved, and for how long.
 *
 * A report, and nothing else. It does not resolve, retry, redispatch or release
 * anything, and a test asserts this file contains no such path. An unresolved
 * dispatch is a question for a human; this is how they find out it is waiting.
 */
async function listUnresolvedDispatches({ store, olderThanMs = 0, now } = {}) {
  if (typeof now !== "function") throw new Error("listUnresolvedDispatches requires an injected now().");
  try {
    const rows = await store.listDialExecutions({ unresolvedOnly: true });
    const cutoff = now().getTime() - Math.max(0, olderThanMs);
    const stale = (Array.isArray(rows) ? rows : [])
      .filter((r) => Date.parse(r.claimedAt) <= cutoff)
      .map((r) =>
        Object.freeze({
          dispatchId: r.dispatchId,
          prospectId: r.prospectId,
          destinationE164: r.destinationE164,
          providerStatus: r.providerStatus,
          provider: r.provider,
          claimedAt: r.claimedAt,
          ageMs: now().getTime() - Date.parse(r.claimedAt),
          holdsProspectLock: true,
          holdsDestinationLock: true,
        })
      )
      .sort((a, b) => b.ageMs - a.ageMs);

    return Object.freeze({
      available: true,
      count: stale.length,
      dispatches: Object.freeze(stale),
      note: "Read-only. Nothing here resolves, retries or redispatches anything; an unresolved dispatch is released only by a recorded outcome or a named operator.",
    });
  } catch (err) {
    return Object.freeze({ available: false, count: 0, dispatches: Object.freeze([]), reason: err.message });
  }
}

module.exports = {
  claimAuthorisedDial,
  recordProviderResult,
  resolveDispatchForOutcome,
  resolveDispatchByOperator,
  listUnresolvedDispatches,
  CLAIM_CODES,
  CONFLICT_SCOPES,
};
