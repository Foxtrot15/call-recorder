// AIDA Locksmith Acquisition — the dial execution seam (E-7A).
//
//   executeAuthorisedDial({ authorisedDial, provider, now, ... })
//
// The one component permitted to consume an M8E permission slip and ask a
// provider for one outbound acquisition call.
//
// ── E-7A IS NOT E-7 ─────────────────────────────────────────────────
// This milestone builds the SEAM and leaves it incapable of calling anybody.
// The default provider refuses, the only other provider is an offline fake, and
// a ratchet fails the build if a live one appears. E-7 stays OPEN. Nothing here
// is permission to place a real call, and nothing here can.
//
// ── WHAT IT REFUSES, AND WHY EACH ONE IS SEPARATE ───────────────────
//
//   authorisation_invalid      not a slip M8E minted — forged, cloned, revived
//                              from JSON, or assembled by hand
//   authorisation_expired      minted too long ago to still describe now
//   authorisation_consumed     already spent — in this process or durably
//   caller_override_rejected   the caller tried to supply a destination, a
//                              compliance answer, or the emergency stop
//   kill_switch_engaged        somebody engaged the durable stop
//   acquisition_calling_state_unavailable
//                              we could not read the stop. Not the same thing,
//                              and it blocks just as hard
//   dispatch_conflict          another UNRESOLVED dispatch holds this business
//                              or this handset
//   dispatch_store_unavailable the durable ledger could not be written
//   provider_refused           compliance said yes; the mechanism said no
//   provider_failed            the provider threw or answered incoherently
//
// AUTHORISED IS NOT CALLED. PROVIDER-DISABLED IS NOT NON-COMPLIANT. Collapsing
// those into one boolean is how a founder ends up reading "blocked" and
// believing a business refused them, or reading "ok" and believing a phone rang.
//
// ── SINGLE USE — NOW IN TWO LAYERS (E-7B1) ──────────────────────────
// One slip may be handed to a provider AT MOST ONCE, and that is now enforced
// twice over:
//
//   IN PROCESS   a module-level WeakSet, claimed SYNCHRONOUSLY before the first
//                await, so two concurrent executions of the same slip cannot
//                both pass. Cheap, immediate, and worth nothing across a
//                process boundary.
//
//   DURABLY      one INSERT into acquisition_dial_executions, arbitrated by
//                Postgres. laq5 puts the primary key on a RANDOM dispatch_id
//                and two partial unique indexes on (prospect_id) and
//                (destination_e164) where resolved_at is null. A second worker,
//                a second host or a restarted process loses to a 23505 — not to
//                anything this file remembers.
//
// E-7A's process-local limitation is CLOSED by the durable half. Applying laq5
// is what makes that true; until it is applied, the durable claim fails and
// STORE_UNAVAILABLE blocks, which is the correct direction to fail.
//
// A refusal still spends the slip, and a claimed dispatch stays claimed. "At
// most one submission" is the invariant worth having, and un-spending on
// refusal would mean a caller could retry a disabled provider until somebody
// enabled it.
//
// ── PROVIDER COMPLETION IS NOT RESOLUTION ───────────────────────────
// Nothing in this file sets `resolved_at`, and `recordProviderResult` has no
// parameter that could. A dispatch holds its prospect and destination locks
// until a durable contact outcome is recorded or a named operator resolves it.
// A provider that accepted, refused, threw or vanished changes the STATUS and
// releases NOTHING — because the question the lock protects is not "did the API
// return" but "do we know what happened to this business".
//
// ── NO AUTOMATIC RETRY. NOT ANYWHERE. NOT EVER HERE. ────────────────
// A provider timeout is genuinely ambiguous: it may mean the call was rejected,
// or that it was accepted and the answer was lost. Retrying resolves that
// ambiguity by calling a business twice. So a provider failure returns an
// explicit uncertain state and stops. Deciding what to do next is a human's
// job, and re-deciding requires a fresh authorisation.
//
// ── WHAT IT DOES NOT RE-DECIDE ──────────────────────────────────────
// Suppression, DNCR, duplicates, batch approval, attempt caps and the calling
// window are M8E's, evaluated against durable state at mint time. This file
// does not re-implement them and cannot be handed substitutes for them: a
// context carrying `suppressed: false` or `batch: {approved:true}` is refused
// outright rather than ignored, because a caller who tries deserves an error
// rather than silence.
//
// The one thing re-checked at execution is the KILL SWITCH, because an
// emergency stop that a slip minted a minute ago could ignore is not a stop.

const { isGenuineAuthorisedDial } = require("./acquisition-authorisation");
const { assertDialProvider, PROVIDER_STATUS } = require("./acquisition-dial-provider");
const { readCallingState, STATE_CODES: CALLING_STATE_CODES } = require("./acquisition-calling-state");
const { claimAuthorisedDial, recordProviderResult, CLAIM_CODES } = require("./acquisition-dispatch-store");
const { createHash } = require("node:crypto");

/**
 * How long a permission slip still describes the present.
 *
 * NOT invented for this file. The slip has always carried a note describing
 * itself as "permission to attempt one call, as at authorisedAt... re-authorise
 * rather than storing this" — the intent was always immediate use, with nothing
 * enforcing it. This enforces it.
 *
 * 60 seconds because the honest window is "long enough to hand the slip to a
 * provider, and no longer". The queue's 5-minute lease is the wrong comparison:
 * a lease reserves a prospect so nobody else takes it, while this asserts that
 * the world has not changed. Somebody can opt out in four minutes.
 */
const DEFAULT_MAX_AGE_MS = 60 * 1000;

const EXECUTION_CODES = Object.freeze({
  AUTHORISATION_INVALID: "authorisation_invalid",
  AUTHORISATION_EXPIRED: "authorisation_expired",
  AUTHORISATION_CONSUMED: "authorisation_consumed",
  CALLER_OVERRIDE_REJECTED: "caller_override_rejected",
  /** Somebody engaged the stop. A fact about a decision, not about us. */
  KILL_SWITCH: "kill_switch_engaged",
  /**
   * E-7B1. We could not establish whether calling is stopped — the row is
   * missing, the store is unreadable, or the value is not one we understand.
   *
   * Kept apart from KILL_SWITCH for the same reason HISTORY_UNAVAILABLE is kept
   * apart from ATTEMPTS_BLOCKED: one says "we know, and the answer is no", the
   * other says "we could not find out", and reporting ours as theirs sends a
   * founder to the wrong place. Both block.
   */
  CALLING_STATE_UNAVAILABLE: "acquisition_calling_state_unavailable",
  /** E-7B1. Another UNRESOLVED dispatch holds this business or this handset. */
  DISPATCH_CONFLICT: "dispatch_conflict",
  /** E-7B1. The dispatch ledger could not be written. Our failure. Blocks. */
  DISPATCH_STORE_UNAVAILABLE: "dispatch_store_unavailable",
  PROVIDER_REFUSED: "provider_refused",
  PROVIDER_FAILED: "provider_failed",
  SUBMITTED: "provider_accepted",
});

/**
 * A stop somebody engaged, or a stop we could not read?
 *
 * Only `paused` is a decision. Missing, unreadable and unrecognised are all
 * facts about the system, and each of them blocks just as hard.
 */
function callingStateCodeFor(verdict) {
  return verdict.code === CALLING_STATE_CODES.PAUSED ? EXECUTION_CODES.KILL_SWITCH : EXECUTION_CODES.CALLING_STATE_UNAVAILABLE;
}

/**
 * Keys a caller may not supply, and what each one would have meant.
 *
 * Every one of these is something a durable read already answered. Accepting
 * any of them would rebuild the exact hole E-5 and M8L closed — a caller
 * asserting a compliance result — one layer further down, where M8E cannot see
 * it. `destination` and `e164` are here for a different reason: the number is
 * not the caller's to choose.
 */
const FORBIDDEN_OPTION_KEYS = Object.freeze([
  "destination",
  "e164",
  "number",
  "to",
  "prospectId",
  // E-7B1. The durable identity and the approval it was granted under are not
  // the caller's to state either — both come off the slip and nowhere else.
  "dispatchId",
  "batchKey",
  "batch_key",
  // E-7B1. The emergency stop is READ, never received. A caller that still
  // passes one is refused rather than quietly ignored, because silently
  // dropping it would look exactly like it being honoured.
  "killSwitch",
  "callingState",
  "callingEnabled",
  "suppressed",
  "suppression",
  "dncr",
  "batch",
  "duplicateResolution",
  "duplicateState",
  "callingPolicy",
  "eligibility",
  "authorised",
  "approved",
]);

/**
 * Slips already handed to a provider. Module-level, so two executor instances
 * in one process cannot both spend the same slip.
 *
 * WeakSet: holding a slip here must not keep it alive.
 */
const CONSUMED = new WeakSet();

/**
 * One execution id per DISPATCH, not per authorisation fingerprint (E-7B1).
 *
 * It used to hash `authorisationId`, which is itself derived from (prospect,
 * number, instant, decision) — so two distinct authorisations at the same
 * millisecond produced the same execution id. Keying off the random dispatchId
 * makes an execution id name one attempt and only one.
 */
function executionIdFor(slip) {
  return `ex_${createHash("sha256").update(String(slip.dispatchId || "")).digest("hex").slice(0, 20)}`;
}

function result({ ok, code, message, slip, provider, executionId, executedAt, providerRef = null, providerStatus = null, conflictScope = null, callingState = null, dispatchClaimed = false }) {
  return Object.freeze({
    ok,
    status: code,
    reason: ok ? null : code,
    message,
    executionId,
    /** The durable identity, so a result can be matched to its ledger row. */
    dispatchId: slip ? slip.dispatchId || null : null,
    /** The founder approval this was dispatched under (E-7B1). */
    batchKey: slip ? slip.batchKey || null : null,
    /** Whether a durable claim exists — and therefore whether locks are held. */
    dispatchClaimed,
    /** Which lock refused, when one did: "prospect" or "destination". */
    conflictScope,
    /** What the durable emergency stop said at the last read. */
    callingState,
    /** Straight off the slip. There is no path by which a caller sets these. */
    prospectId: slip ? slip.prospectId || null : null,
    businessName: slip ? slip.businessName || null : null,
    destination: slip ? slip.e164 || null : null,
    authorisationId: slip ? slip.authorisationId || null : null,
    authorisedAt: slip ? slip.authorisedAt || null : null,
    executedAt,
    provider: provider ? provider.name : null,
    providerLive: provider ? provider.live === true : null,
    providerStatus,
    providerRef,
    /**
     * Said on every result, because the distinction is the whole point of the
     * milestone and a log line is where somebody will misread it.
     */
    note: "A dial execution result. It describes what a provider was asked to do, not what a business experienced. No contact outcome is implied or recorded.",
  });
}

/**
 * Execute one authorised dial.
 *
 * @param {object}   authorisedDial  a slip M8E minted. Nothing else is accepted.
 * @param {object}   provider        defaults to the DISABLED provider
 * @param {function} now             injected clock
 * @param {object}   [store]         the DURABLE store. Without one there is no
 *                                   emergency stop to read and no claim to make,
 *                                   so nothing may be dispatched.
 * @param {string}   [claimedBy]     which worker, for the dispatch ledger
 * @param {number}   [maxAgeMs]
 * @param {object}   [audit]         append-only decision log. In-memory in every
 *                                   current caller; this file never writes a database.
 *
 * NOTE: there is deliberately NO killSwitch parameter (E-7B1). It used to be an
 * optional function a caller passed in, which meant a caller who omitted it got
 * no emergency stop at all. The stop is now read from the store by this
 * function, twice, and `killSwitch` is on FORBIDDEN_OPTION_KEYS so that code
 * still passing one is refused loudly rather than silently ignored.
 */
async function executeAuthorisedDial(options = {}) {
  const {
    authorisedDial = null,
    provider = null,
    now = null,
    store = null,
    claimedBy = "acquisition-executor",
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    audit = null,
    metadata = null,
    ...rest
  } = options || {};

  if (typeof now !== "function") {
    throw new Error("executeAuthorisedDial requires an injected now().");
  }

  // The provider is REQUIRED to be stated. Defaulting to the disabled provider
  // silently would mean a caller who forgot one gets a refusal that looks like
  // a policy answer. Callers use createAcquisitionDialExecutor() for the safe
  // default; this function makes the choice explicit.
  const active = provider || null;
  if (active) assertDialProvider(active, "executeAuthorisedDial provider");

  const executedAt = now().toISOString();

  // ── 1. Caller overrides, before anything else ─────────────────────
  // Checked first because it is the only failure that says something about the
  // CALLER rather than about the authorisation, and it should not be masked by
  // an expiry or a consumed slip.
  const offered = Object.keys(rest).filter((k) => FORBIDDEN_OPTION_KEYS.includes(k));
  if (offered.length > 0) {
    return result({
      ok: false,
      code: EXECUTION_CODES.CALLER_OVERRIDE_REJECTED,
      message:
        `A caller may not supply ${offered.join(", ")}. The destination comes from the authorisation, ` +
        "and every compliance answer came from a durable read at authorisation time.",
      slip: isGenuineAuthorisedDial(authorisedDial) ? authorisedDial : null,
      provider: active,
      executionId: null,
      executedAt,
    });
  }

  // ── 2. Is this a slip M8E actually minted? ────────────────────────
  // Identity, not shape. A clone is a different object and fails here.
  if (!isGenuineAuthorisedDial(authorisedDial)) {
    return result({
      ok: false,
      code: EXECUTION_CODES.AUTHORISATION_INVALID,
      message:
        "This is not an authorisation the pre-dial gate issued. Only the object that gate returns may be " +
        "executed — not a copy of one, and not something merely shaped like one.",
      slip: null,
      provider: active,
      executionId: null,
      executedAt,
    });
  }

  const slip = authorisedDial;
  const executionId = executionIdFor(slip);
  const refuse = (code, message, extra = {}) => result({ ok: false, code, message, slip, provider: active, executionId, executedAt, ...extra });

  // ── 3. Is it still about now? ─────────────────────────────────────
  //
  // Checked BEFORE anything is consumed or claimed. An expired slip is already
  // useless, and spending it would only mean a durable row recording a dispatch
  // that never had permission to exist.
  const authorisedAtMs = Date.parse(slip.authorisedAt);
  const ageMs = Number.isFinite(authorisedAtMs) ? now().getTime() - authorisedAtMs : Number.POSITIVE_INFINITY;
  if (!(ageMs >= 0) || ageMs > maxAgeMs) {
    return refuse(
      EXECUTION_CODES.AUTHORISATION_EXPIRED,
      `This authorisation was issued ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s` : "an unknown time"} ago and is no longer current. ` +
        "Permission describes the moment it was granted; somebody can opt out in a minute. Authorise again."
    );
  }

  // ── 4. THE EMERGENCY STOP, PREFLIGHT (E-7B1) ──────────────────────
  //
  // Read from the store, by this function, before anything is spent. A caller
  // cannot supply it, omit it, or pass false: `killSwitch` and `callingState`
  // are both on FORBIDDEN_OPTION_KEYS, and the only reader is below.
  //
  // Deliberately before the claim so that a paused system does not accumulate
  // claimed-but-never-dispatched rows, each holding a prospect and a
  // destination lock that a human would then have to resolve by hand.
  const preflight = await readCallingState({ store });
  if (!preflight.permitted) {
    return refuse(callingStateCodeFor(preflight), `${preflight.message} No authorisation was spent.`, { callingState: preflight.code });
  }

  // ── 5. Spend it in this process. SYNCHRONOUSLY, BEFORE ANY AWAIT ──
  //
  // Still here, and still first-past-the-post: two concurrent calls with the
  // same slip both reach this line, but only one finds it unclaimed, because
  // nothing between the check and the add yields the event loop.
  //
  // This is now the CHEAP half of the guarantee. The durable half is step 7,
  // and it is the one that holds across processes.
  if (CONSUMED.has(slip)) {
    return refuse(
      EXECUTION_CODES.AUTHORISATION_CONSUMED,
      "This authorisation has already been handed to a provider. One authorisation permits at most one " +
        "submission; authorise again rather than reusing this one."
    );
  }
  CONSUMED.add(slip);

  if (!active) {
    return refuse(EXECUTION_CODES.PROVIDER_REFUSED, "No dial provider was supplied, so nothing could be submitted.", { provider: null });
  }

  // ── 6. THE DURABLE CLAIM (E-7B1) ──────────────────────────────────
  //
  // One INSERT, arbitrated by Postgres. This is what makes the single-use rule
  // true across processes, restarts and hosts rather than only inside this one.
  //
  // Three ways to lose, three different meanings:
  //   ALREADY_CLAIMED     this authorisation was already spent somewhere
  //   CONFLICT            another UNRESOLVED dispatch holds this business, or
  //                       this handset — see acquisition-dispatch-store
  //   STORE_UNAVAILABLE   we could not find out, which is a refusal
  const claim = await claimAuthorisedDial({ store, dial: slip, provider: active, claimedBy, now });
  if (!claim.claimed) {
    const code =
      claim.code === CLAIM_CODES.ALREADY_CLAIMED
        ? EXECUTION_CODES.AUTHORISATION_CONSUMED
        : claim.code === CLAIM_CODES.CONFLICT
          ? EXECUTION_CODES.DISPATCH_CONFLICT
          : EXECUTION_CODES.DISPATCH_STORE_UNAVAILABLE;
    return refuse(code, claim.message, { conflictScope: claim.conflictScope || null });
  }

  // ── 7. THE EMERGENCY STOP, AGAIN, AT THE LAST INSTANT ─────────────
  //
  // A stop engaged between the preflight and here must still stop the call, and
  // this is the last moment at which stopping is free.
  //
  // If it blocks now, the dispatch STAYS CLAIMED AND UNRESOLVED. That is
  // intentional: the row is evidence that a call very nearly happened, and its
  // locks stay held until somebody records an outcome or resolves it by hand.
  // Releasing it automatically would mean a paused system quietly re-arming
  // itself the moment it was unpaused.
  const final = await readCallingState({ store });
  if (!final.permitted) {
    await recordProviderResult({ store, dispatchId: slip.dispatchId, providerStatus: "refused", errorCode: final.code, now }).catch(() => {});
    return refuse(
      callingStateCodeFor(final),
      `${final.message} The dispatch was claimed and remains unresolved; it holds this business and this number until it is resolved.`,
      { callingState: final.code, dispatchClaimed: true }
    );
  }

  // ── 8. THE SUBMISSION. Exactly one, exactly here ──────────────────
  //
  // The provider is handed a frozen record built only from the slip. There is
  // no expression below in which a caller-supplied value could become the
  // destination.
  //
  // ── WHY dispatchId TRAVELS, AND WHY IT IS NOT executionId ─────────
  // E-7B2A can build a Retell request but not send one, and the case that
  // decided this field is the one where sending goes wrong: the claim succeeds,
  // the provider accepts, and the HTTP response carrying the call id is LOST.
  // `provider_ref` is then never written, and a webhook arriving later names a
  // call we have no record of.
  //
  // Correlation therefore has to survive in the payload itself, and it has to
  // be the DURABLE key. executionId is `ex_` + a 20-hex truncation of
  // sha256(dispatchId) — one-way, so a reconciler holding one could only
  // recover the dispatch by listing unresolved rows and recomputing this
  // module's private hash for each. That is a second copy of a derivation which
  // must never diverge, and a scan where a lookup belongs.
  //
  // So the exact LAQ5 primary key travels, unhashed and untruncated, and
  // executionId stays exactly what it was. They are different things: one names
  // the durable dispatch, the other names this attempt for logs.
  const execution = Object.freeze({
    executionId,
    /** THE DURABLE LAQ5 IDENTITY. Verbatim off the genuine slip. */
    dispatchId: slip.dispatchId,
    destination: slip.e164,
    prospectId: slip.prospectId,
    businessName: slip.businessName,
    authorisedAt: slip.authorisedAt,
    metadata: Object.freeze({ ...(metadata && typeof metadata === "object" ? metadata : {}) }),
  });

  let providerResult;
  try {
    providerResult = await active.submit(execution);
  } catch (err) {
    // NO RETRY. The call may or may not have been placed, and the only honest
    // answer is that we do not know. A second submission would resolve the
    // ambiguity in the one direction that cannot be undone.
    //
    // 'unknown' on the durable row, and the lock STAYS HELD. This is the exact
    // case the whole design is built around: we cannot say whether a phone
    // rang, so nobody may ring it again until a person decides.
    await recordProviderResult({ store, dispatchId: slip.dispatchId, providerStatus: "unknown", errorCode: "provider_exception", now }).catch(() => {});

    if (audit) {
      audit.record({
        entityType: "prospect",
        entityId: slip.prospectId || "unknown",
        event: "dial_execution_failed",
        decision: "error",
        actor: "dial-executor",
        actorKind: "system",
        reason: `The provider failed and was NOT retried: ${err.message}`,
        detail: { code: EXECUTION_CODES.PROVIDER_FAILED, executionId, provider: active.name },
      });
    }
    return result({
      ok: false,
      code: EXECUTION_CODES.PROVIDER_FAILED,
      message:
        `The provider failed: ${err.message}. Whether anything was submitted is UNKNOWN, and it was not retried — ` +
        "a retry after an ambiguous failure is how one authorisation becomes two calls.",
      slip,
      provider: active,
      executionId,
      executedAt,
      providerStatus: "unknown",
      dispatchClaimed: true,
    });
  }

  const accepted = Boolean(providerResult && providerResult.accepted === true && providerResult.status === PROVIDER_STATUS.ACCEPTED);

  // What the MECHANISM did, onto the durable row. It cannot set resolved_at —
  // recordProviderResult has no such parameter — so whichever way this goes,
  // the prospect and destination locks are still held afterwards.
  await recordProviderResult({
    store,
    dispatchId: slip.dispatchId,
    providerStatus: accepted ? "submitted" : "refused",
    providerRef: providerResult ? providerResult.providerRef || null : null,
    errorCode: accepted ? null : (providerResult && providerResult.reason) || "provider_refused",
    now,
  }).catch(() => {});

  if (audit) {
    audit.record({
      entityType: "prospect",
      entityId: slip.prospectId || "unknown",
      event: accepted ? "dial_execution_submitted" : "dial_execution_refused",
      decision: "record",
      actor: "dial-executor",
      actorKind: "system",
      reason: accepted
        ? `Submitted to the ${active.name} provider. This is a dispatch record, NOT evidence that anybody was contacted.`
        : `The ${active.name} provider refused: ${providerResult ? providerResult.reason : "no result"}.`,
      detail: { code: accepted ? EXECUTION_CODES.SUBMITTED : EXECUTION_CODES.PROVIDER_REFUSED, executionId, provider: active.name, providerLive: active.live === true },
    });
  }

  if (!accepted) {
    return result({
      ok: false,
      code: EXECUTION_CODES.PROVIDER_REFUSED,
      message:
        (providerResult && providerResult.message) ||
        "The provider refused the submission. This is a mechanism refusal, not a compliance refusal.",
      slip,
      provider: active,
      executionId,
      executedAt,
      providerStatus: providerResult ? providerResult.status || null : null,
      dispatchClaimed: true,
      providerRef: providerResult ? providerResult.providerRef || null : null,
    });
  }

  return result({
    ok: true,
    code: EXECUTION_CODES.SUBMITTED,
    message: `Submitted to the ${active.name} provider for ${slip.e164}. No contact outcome has been recorded.`,
    slip,
    provider: active,
    executionId,
    executedAt,
    providerStatus: providerResult.status,
    dispatchClaimed: true,
    providerRef: providerResult.providerRef || null,
  });
}

/**
 * The safe construction path, and the one callers should use.
 *
 * The provider defaults to the DISABLED one. There is no branch here that reads
 * an environment variable, looks for credentials, or upgrades itself to
 * something live — a live provider must be constructed by a caller who names it,
 * in a milestone that adds one.
 */
function createAcquisitionDialExecutor({ now, provider = null, store = null, claimedBy = "acquisition-executor", maxAgeMs = DEFAULT_MAX_AGE_MS, audit = null } = {}) {
  if (typeof now !== "function") throw new Error("createAcquisitionDialExecutor requires an injected now().");

  // Lazily required so the default costs nothing to anybody who supplies one.
  const { createDisabledDialProvider } = require("./acquisition-dial-provider");
  const bound = provider || createDisabledDialProvider();
  assertDialProvider(bound, "acquisition dial executor provider");

  return Object.freeze({
    kind: "acquisition-dial-executor",
    provider: bound,
    providerName: bound.name,
    providerLive: bound.live === true,
    /** True only when this executor could, in principle, reach a live provider. */
    liveCapable: bound.live === true,
    execute: (authorisedDial, extra = {}) =>
      executeAuthorisedDial({ ...extra, authorisedDial, provider: bound, now, store, claimedBy, maxAgeMs, audit }),
  });
}

module.exports = {
  executeAuthorisedDial,
  createAcquisitionDialExecutor,
  EXECUTION_CODES,
  FORBIDDEN_OPTION_KEYS,
  DEFAULT_MAX_AGE_MS,
};
