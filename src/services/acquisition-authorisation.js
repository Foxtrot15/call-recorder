// AIDA Locksmith Acquisition — the final pre-dial authorisation gate (M8E).
//
//   createDialAuthoriser({ now, store, engine, ... }).authorise(prospect, ctx)
//
// Answers exactly one question, at exactly one moment:
//
//     May a call to this business be permitted RIGHT NOW, judged against
//     durable state rather than against anything this process remembers?
//
// ── WHY THIS EXISTS: M-7 ────────────────────────────────────────────
// The suppression index is hydrated once, at construction, from a single
// `listSuppressions()`. `rehydrate()` is exposed — and, before this module, had
// no callers anywhere in the repository. A process that started on Monday held
// Monday's view of who had opted out for as long as it lived.
//
// That is survivable while nothing dials. It stops being survivable the moment
// something does, because the failure is not a stale screen: it is a call to
// somebody who asked us never to call again, placed by a process that had been
// told and had not noticed.
//
// ── THE INVARIANT, STATED ONCE ──────────────────────────────────────
//
//     THE FINAL PRE-DIAL DECISION MUST NEVER RELY SOLELY ON STALE
//     PROCESS MEMORY.
//
// So this gate reads suppression from the store, every time, for the one
// business it is being asked about. The hydrated index keeps its job — cheap
// rejection during discovery, ranking, batching and the founder's screens —
// and loses only its authority at the last step.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────
// It does not place a call. It cannot: there is no transport here, no provider
// client, no number is ever handed to anything that could reach a network. It
// returns a DECISION. A test asserts this file contains no execution surface,
// and a second asserts that nothing which could dial can be constructed from
// what it returns without going through it.
//
// ── PRE-FETCH, THEN RE-RUN ──────────────────────────────────────────
// `suppression.check()` is synchronous and is called by four services. Making
// it async to reach a database would ripple through all of them and every test
// that drives them — the cost M8C explicitly refused to pay, and rightly.
//
// So the durable read happens HERE, once, for one prospect, and the existing
// engine is then re-run against a suppression view backed by that authoritative
// answer. Async at the boundary; synchronous everywhere it already was. The
// engine is unchanged and unaware.
//
// Pure except for the store read. See test/acquisition-authorisation.test.js.

const { createEligibilityEngine, ELIGIBILITY_CODES, assessmentFingerprint } = require("./acquisition-eligibility");
const { createSuppressionList } = require("./acquisition-suppression");
const { assertStoreContract } = require("./acquisition-store");
const { normaliseProspectPhones } = require("./acquisition-phone");

/**
 * The one code the existing vocabulary did not already have.
 *
 * Everything else this gate can report is an ELIGIBILITY_CODES value, because
 * everything else it can find is something the eligibility engine already knows
 * how to name. Suppression is `suppressed_permanently`; a bad number is
 * `no_usable_number`; an unchecked wash is `dncr_not_checked`; a closed window
 * is `outside_calling_policy`. Inventing a parallel BLOCKED_* vocabulary would
 * have meant two names for every refusal and a translation table between them.
 *
 * This one is genuinely new: it describes the gate's own failure, not the
 * prospect's. "We could not read who has opted out" is not a fact about this
 * business, and it must never be reported as one.
 */
const AUTHORISATION_CODES = Object.freeze({
  AUTHORISED: ELIGIBILITY_CODES.ELIGIBLE,
  SUPPRESSION_STORE_UNAVAILABLE: "suppression_store_unavailable",
});

/**
 * A permission slip, and the only thing a future dialler may accept (M8E).
 *
 * ── WHY A TOKEN AND NOT A BOOLEAN ───────────────────────────────────
 * A boolean can be produced by anything. `if (prospect.eligible)` compiles, and
 * so does `if (true)`. The point of this object is that it CANNOT be produced
 * except by a gate that has just read durable suppression state — so a future
 * dialler whose signature demands one cannot be handed a prospect that skipped
 * the gate, and the mistake becomes a type error rather than a phone call.
 *
 * It carries the decision, the instant, and the number the gate actually
 * cleared — not "a number from the record". If those ever differ, the cleared
 * one is the only safe answer.
 *
 * It is deliberately inert: no method on it does anything.
 */
const AUTHORISED_DIAL = Symbol("acquisition.authorisedDial");

function mintAuthorisedDial({ prospectId, businessName, e164, authorisedAt, decision }) {
  return Object.freeze({
    [AUTHORISED_DIAL]: true,
    kind: "authorised-dial",
    prospectId,
    businessName,
    /** The number the gate cleared. Whatever dials must use THIS one. */
    e164,
    authorisedAt,
    decision,
    note: "Permission to attempt one call, as at authorisedAt. It expires the moment anything changes; re-authorise rather than storing this.",
  });
}

/** True only for a slip this module minted. Nothing else can fake it. */
function isAuthorisedDial(value) {
  return Boolean(value) && typeof value === "object" && value[AUTHORISED_DIAL] === true;
}

/**
 * The gate.
 *
 * ── WHY IT WILL NOT ACCEPT A PRE-BUILT ENGINE ───────────────────────
 * An eligibility engine binds its suppression list at CONSTRUCTION, and
 * `evaluate()` has no parameter that can override it. So an engine handed in
 * from outside would carry whatever suppression view its builder had — in
 * practice the hydrated, possibly week-old one — and this gate would read the
 * database, ignore the answer, and authorise from stale memory while reporting
 * `suppressionSource: "durable"`. A gate that can be defeated by passing it a
 * collaborator is not a gate.
 *
 * So it takes the engine's COLLABORATORS and builds the engine itself, binding
 * the authoritative list. There is no parameter that can substitute it.
 *
 * @param {function} now
 * @param {object}   store   an acquisition store — the AUTHORITATIVE source
 * @param {object}   [engineOptions] collaborators: washStore, holidays,
 *                   attemptPolicy, callingPolicy, counselApproved, policyVersion.
 *                   `suppression` is ignored if present — this gate supplies it.
 * @param {object}   [audit] the append-only decision log
 */
function createDialAuthoriser({ now, store, engineOptions = null, audit = null } = {}) {
  if (typeof now !== "function") {
    throw new Error("createDialAuthoriser requires an injected now().");
  }
  assertStoreContract(store, "authorisation store");
  if (typeof store.lookupSuppression !== "function") {
    throw new Error("createDialAuthoriser requires a store with lookupSuppression(); a hydrated index is not authority.");
  }

  /**
   * Build the decision the caller sees.
   *
   * `authorised` is deliberately not derived from `code === eligible` alone: a
   * slip is minted only where the gate has actually completed a durable read,
   * so a future refactor that adds an early return cannot accidentally produce
   * an authorised decision with no slip attached.
   */
  function decide({ authorised, code, message, prospect, e164, instant, eligibility, suppressionSource, failedChecks }) {
    const base = Object.freeze({
      authorised,
      code,
      message,
      prospectId: prospect ? prospect.prospectId || null : null,
      businessName: prospect ? prospect.businessName || null : null,
      e164: e164 || null,
      authorisedAt: instant.toISOString(),
      /** Where the suppression answer came from. Always "durable" on any real decision. */
      suppressionSource,
      eligibilityCode: eligibility ? eligibility.code : null,
      failedChecks: Object.freeze(failedChecks || []),
      note: "This is a decision about permission. Nothing here places, schedules or prepares a call.",
    });

    if (!authorised) return Object.freeze({ ...base, dial: null });

    return Object.freeze({
      ...base,
      dial: mintAuthorisedDial({
        prospectId: base.prospectId,
        businessName: base.businessName,
        e164: base.e164,
        authorisedAt: base.authorisedAt,
        decision: code,
      }),
    });
  }

  /**
   * Authorise one prospect, at one instant.
   *
   * Reads the store EVERY time. There is no cache here on purpose: this runs
   * once per authorisation at an irreversible boundary, not once per candidate
   * in a ranking, so the read is bounded by how many calls could be placed —
   * which is the only number worth spending a query on.
   */
  async function authorise(prospect, context = {}) {
    const instant = context.at instanceof Date && Number.isFinite(context.at.getTime()) ? context.at : now();

    if (!prospect || typeof prospect !== "object") {
      return decide({
        authorised: false,
        code: ELIGIBILITY_CODES.RECORD_INVALID,
        message: "There is no prospect record to authorise.",
        prospect: null,
        e164: null,
        instant,
        eligibility: null,
        suppressionSource: "not_reached",
        failedChecks: [],
      });
    }

    // ── The number, normalised before anything is compared ────────────
    //
    // Suppression is stored in E.164 and compared in E.164. Looking a business
    // up on its published form would miss the opt-out recorded against the same
    // handset written differently, which is the exact defect M8C fixed in the
    // in-memory path. It must not reappear in the durable one.
    const phones = normaliseProspectPhones(prospect);
    const canonical = phones.callable[0] || null;
    const e164 = canonical ? canonical.e164 : null;
    const fingerprint = prospect.prospectId ? assessmentFingerprint(prospect) : null;

    if (e164 === null && fingerprint === null) {
      // Nothing to look up by. Refused rather than cleared: a record we cannot
      // identify is a record we cannot prove has not opted out.
      return decide({
        authorised: false,
        code: ELIGIBILITY_CODES.NO_USABLE_NUMBER,
        message: "This record has neither a usable number nor an identity, so it cannot be checked against the suppression list.",
        prospect,
        e164: null,
        instant,
        eligibility: null,
        suppressionSource: "not_reached",
        failedChecks: [],
      });
    }

    // ── 1. THE AUTHORITATIVE READ ─────────────────────────────────────
    let rows;
    try {
      rows = await store.lookupSuppression({ fingerprint, e164 });
    } catch (err) {
      /**
       * FAIL CLOSED. The most important branch in this file.
       *
       * We do not know whether this business has opted out. The only two
       * answers available are "refuse" and "call somebody who may have asked us
       * not to", and the second is not an answer. Reported as the gate's own
       * failure — never as a fact about the business, because a founder reading
       * "not suppressed" would be reading something nobody established.
       */
      if (audit) {
        audit.record({
          entityType: "prospect",
          entityId: prospect.prospectId || "unknown",
          event: "authorisation_blocked",
          decision: "veto",
          actor: "dial-authoriser",
          actorKind: "system",
          reason: `The suppression store could not be read, so authorisation was refused: ${err.message}`,
          detail: { code: AUTHORISATION_CODES.SUPPRESSION_STORE_UNAVAILABLE },
        });
      }
      return decide({
        authorised: false,
        code: AUTHORISATION_CODES.SUPPRESSION_STORE_UNAVAILABLE,
        message: `Whether this business has opted out could not be established, so no call is permitted. ${err.message}`,
        prospect,
        e164,
        instant,
        eligibility: null,
        suppressionSource: "unavailable",
        failedChecks: [],
      });
    }

    /**
     * ── 2. THE SAME MATCHING CODE, ON AUTHORITATIVE ROWS ──────────────
     *
     * Built fresh, from what the database just said, and thrown away when this
     * call returns. It is not a cache and must never become one: the moment
     * this list outlives one authorisation it is exactly the stale memory this
     * gate exists to stop trusting.
     */
    const authoritative = createSuppressionList({ now, initialEntries: rows });

    // ── 3. RE-RUN ELIGIBILITY AGAINST IT ──────────────────────────────
    //
    // Every other rule — DNCR and its freshness, duplicates, campaign and
    // kill-switch, counsel and attempt-policy approval, batch approval,
    // timezone, holidays, calling window — is re-evaluated here, at this
    // instant, by the engine that owns them. This gate adds a durable
    // suppression read; it does not re-implement or weaken anything else, and
    // a stored eligibility snapshot is never consulted.
    // `suppression` is destructured off and discarded before spreading, so a
    // caller who supplies one cannot reach the engine with it. The authoritative
    // list is bound last and unconditionally.
    const { suppression: _ignored, ...collaborators } = engineOptions || {};
    const active = createEligibilityEngine({ ...collaborators, now, suppression: authoritative });

    const eligibility = active.evaluate(prospect, { ...context, at: instant });

    const failedChecks = (eligibility.failedChecks || []).map((f) => Object.freeze({ check: f.check, code: f.code, message: f.message }));

    if (!eligibility.eligible) {
      return decide({
        authorised: false,
        code: eligibility.code,
        message: eligibility.message,
        prospect,
        e164,
        instant,
        eligibility,
        suppressionSource: "durable",
        failedChecks,
      });
    }

    return decide({
      authorised: true,
      code: AUTHORISATION_CODES.AUTHORISED,
      message: `A call to ${prospect.businessName || "this business"} on ${e164} is permitted as at ${instant.toISOString()}.`,
      prospect,
      e164,
      instant,
      eligibility,
      suppressionSource: "durable",
      failedChecks: [],
    });
  }

  return Object.freeze({
    kind: "dial-authoriser",
    authorise,
    // Deliberately absent: dial, dispatch, place, ring, start, send, execute.
    // This object decides. Nothing on it acts.
  });
}

module.exports = {
  createDialAuthoriser,
  isAuthorisedDial,
  AUTHORISATION_CODES,
  AUTHORISED_DIAL,
};
