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
//   authorisation_consumed     already spent. One slip, one submission
//   caller_override_rejected   the caller tried to supply a destination or a
//                              compliance answer
//   kill_switch_engaged        an emergency stop is active AT EXECUTION TIME
//   provider_refused           compliance said yes; the mechanism said no
//   provider_failed            the provider threw or answered incoherently
//
// AUTHORISED IS NOT CALLED. PROVIDER-DISABLED IS NOT NON-COMPLIANT. Collapsing
// those into one boolean is how a founder ends up reading "blocked" and
// believing a business refused them, or reading "ok" and believing a phone rang.
//
// ── SINGLE USE, AND EXACTLY WHAT IT IS WORTH ────────────────────────
// One slip may be handed to a provider AT MOST ONCE. The claim is made against
// object identity in a module-level WeakSet, and it is made SYNCHRONOUSLY —
// before the first await — so two concurrent executions of the same slip cannot
// both pass the check. That is a real guarantee on one event loop.
//
//   *** IT IS PROCESS-LOCAL, AND THAT IS AN E-7A LIMITATION. ***
//
// A second process holds a second WeakSet and knows nothing about the first.
// Durable cross-process single-consumption needs a uniquely-constrained row,
// which needs SQL, which is E-7B. This is safe today for exactly one reason:
// no live provider exists, so the worst a double-spend can currently do is
// record a second fake submission. It would NOT be safe the day a real adapter
// lands, and the docs say so in those words.
//
// A refusal still spends the slip. "At most one submission" is the invariant
// worth having, and un-spending on refusal would mean a caller could retry a
// disabled provider until somebody enabled it.
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
  KILL_SWITCH: "kill_switch_engaged",
  PROVIDER_REFUSED: "provider_refused",
  PROVIDER_FAILED: "provider_failed",
  SUBMITTED: "provider_accepted",
});

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

function result({ ok, code, message, slip, provider, executionId, executedAt, providerRef = null, providerStatus = null }) {
  return Object.freeze({
    ok,
    status: code,
    reason: ok ? null : code,
    message,
    executionId,
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
 * @param {function} [killSwitch]    () => boolean | {engaged, reason}. Read
 *                                   immediately before the provider, never cached.
 * @param {number}   [maxAgeMs]
 * @param {object}   [audit]         append-only decision log. In-memory in every
 *                                   current caller; this file never writes a database.
 */
async function executeAuthorisedDial(options = {}) {
  const {
    authorisedDial = null,
    provider = null,
    now = null,
    killSwitch = null,
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

  // ── 3. Claim it. SYNCHRONOUSLY, BEFORE ANY AWAIT ──────────────────
  //
  // The ordering is the guarantee. Two concurrent calls with the same slip both
  // reach this line, but only one can find it unclaimed, because nothing
  // between the check and the add yields the event loop.
  if (CONSUMED.has(slip)) {
    return result({
      ok: false,
      code: EXECUTION_CODES.AUTHORISATION_CONSUMED,
      message:
        "This authorisation has already been handed to a provider. One authorisation permits at most one " +
        "submission; authorise again rather than reusing this one.",
      slip,
      provider: active,
      executionId,
      executedAt,
    });
  }
  CONSUMED.add(slip);

  // ── 4. Is it still about now? ─────────────────────────────────────
  const authorisedAtMs = Date.parse(slip.authorisedAt);
  const ageMs = Number.isFinite(authorisedAtMs) ? now().getTime() - authorisedAtMs : Number.POSITIVE_INFINITY;
  if (!(ageMs >= 0) || ageMs > maxAgeMs) {
    return result({
      ok: false,
      code: EXECUTION_CODES.AUTHORISATION_EXPIRED,
      message:
        `This authorisation was issued ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s` : "an unknown time"} ago and is no longer current. ` +
        "Permission describes the moment it was granted; somebody can opt out in a minute. Authorise again.",
      slip,
      provider: active,
      executionId,
      executedAt,
    });
  }

  // ── 5. The emergency stop, read HERE and not remembered ───────────
  //
  // The engine evaluates `campaign.killSwitchEngaged` at authorisation time.
  // That is the same switch, read again at the last possible instant, because a
  // stop engaged after a slip was minted must still stop the call. It is NOT a
  // second kill-switch system: no state is kept here and no new vocabulary is
  // invented — the refusal reuses the engine's own kill_switch_engaged.
  //
  // Absent a reader, the only kill-switch authority is the one M8E already
  // applied, bounded by maxAgeMs. That gap is recorded in the blocker register.
  if (typeof killSwitch === "function") {
    const verdict = killSwitch();
    const engaged = verdict === true || (verdict && typeof verdict === "object" && verdict.engaged === true);
    if (engaged) {
      return result({
        ok: false,
        code: EXECUTION_CODES.KILL_SWITCH,
        message: `Calling is stopped: the kill switch is engaged.${verdict && verdict.reason ? ` ${verdict.reason}` : ""}`,
        slip,
        provider: active,
        executionId,
        executedAt,
      });
    }
  }

  if (!active) {
    return result({
      ok: false,
      code: EXECUTION_CODES.PROVIDER_REFUSED,
      message: "No dial provider was supplied, so nothing could be submitted.",
      slip,
      provider: null,
      executionId,
      executedAt,
    });
  }

  // ── 6. THE SUBMISSION. Exactly one, exactly here ──────────────────
  //
  // The provider is handed a frozen record built only from the slip. There is
  // no expression below in which a caller-supplied value could become the
  // destination.
  const execution = Object.freeze({
    executionId,
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
    });
  }

  const accepted = Boolean(providerResult && providerResult.accepted === true && providerResult.status === PROVIDER_STATUS.ACCEPTED);

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
function createAcquisitionDialExecutor({ now, provider = null, killSwitch = null, maxAgeMs = DEFAULT_MAX_AGE_MS, audit = null } = {}) {
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
    execute: (authorisedDial, extra = {}) =>
      executeAuthorisedDial({ ...extra, authorisedDial, provider: bound, now, killSwitch, maxAgeMs, audit }),
  });
}

module.exports = {
  executeAuthorisedDial,
  createAcquisitionDialExecutor,
  EXECUTION_CODES,
  FORBIDDEN_OPTION_KEYS,
  DEFAULT_MAX_AGE_MS,
};
