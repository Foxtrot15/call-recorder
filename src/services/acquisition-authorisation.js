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
//     PROCESS MEMORY, OR ON ANYTHING THE CALLER ASSERTS.
//
// So this gate reads suppression from the store, every time, for the one
// business it is being asked about. The hydrated index keeps its job — cheap
// rejection during discovery, ranking, batching and the founder's screens —
// and loses only its authority at the last step.
//
// ── FOUR AUTHORITATIVE READS, NOT ONE ───────────────────────────────
// The invariant has been applied four times, each time closing a path by which
// something a caller held in memory could have decided a call:
//
//   suppression          M8E / M-7   store.lookupSuppression
//   contact history      M8J / E-1   acquisition-history.readContactHistory
//   batch approval       E-5         acquisition-batch-approval
//   duplicate resolution M8L         acquisition-duplicate-state
//
// The last two were the ones that had been assertable. `context.batch =
// { approved: true }` was, until E-5, sufficient — an object with no author, no
// timestamp and no membership could clear the check that exists to record that
// a named human looked at a specific list of businesses and said yes.
//
// `context.duplicateResolution` was subtler and, in its way, worse: it was a
// real analysis, honestly computed, over a record set the caller chose. Running
// it over one prospect alone produces a resolution in which nothing is a
// duplicate of anything, and that cleared the gate. It came from the same code
// that would have caught the duplicate, pointed at nothing.
//
// Both are now destructured off the caller's context and discarded. The answers
// come from acquisition_decisions or they do not exist.
//
// A BATCH APPROVAL IS STILL NOT PERMISSION TO CALL. It clears one check out of
// nine. It cannot clear suppression, DNCR, duplicates, the calling window, the
// attempt cap, the campaign, or a lifecycle that a human has not approved, and
// nothing about it shortens the list of things re-evaluated here.
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

const { createHash } = require("node:crypto");

const { createEligibilityEngine, ELIGIBILITY_CODES, assessmentFingerprint } = require("./acquisition-eligibility");
const { createSuppressionList } = require("./acquisition-suppression");
const { assertStoreContract } = require("./acquisition-store");
const { normaliseProspectPhones } = require("./acquisition-phone");
const { readContactHistory } = require("./acquisition-history");
const { resolveBatchApprovalForProspect } = require("./acquisition-batch-approval");
const { resolveDuplicateStateForProspect } = require("./acquisition-duplicate-state");

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
  /**
   * E-5, and it belongs to the eligibility vocabulary rather than to a second
   * one here — the engine is what reports it, at the batch check's own
   * precedence, so a suppressed business is still reported as suppressed.
   * Aliased here because callers of this gate switch on AUTHORISATION_CODES.
   */
  BATCH_APPROVAL_STORE_UNAVAILABLE: ELIGIBILITY_CODES.BATCH_STORE_UNAVAILABLE,
  /** M8L, aliased for the same reason as the one above. */
  DUPLICATE_RESOLUTION_STORE_UNAVAILABLE: ELIGIBILITY_CODES.DUPLICATE_STORE_UNAVAILABLE,
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

/**
 * ── WHY THE BRAND IS NOT THE AUTHENTICITY MODEL (E-7A) ──────────────
 *
 * `AUTHORISED_DIAL` is exported, and a branded property is copied by object
 * spread. Both were true from the day this file was written, and together they
 * meant the brand proved less than the comment above it claimed:
 *
 *   { [AUTHORISED_DIAL]: true, e164 }   passed — the symbol is importable
 *   { ...genuineSlip }                  passed — spread copies own symbols,
 *                                       AND the copy is not frozen, so its
 *                                       destination could then be rewritten
 *
 * Only JSON and structuredClone stripped it, because those drop symbols. So a
 * caller could take a real slip for a number the gate cleared, clone it, point
 * it at a different number, and hold something indistinguishable from
 * permission. Nothing dialled, so nothing happened — but E-7A is the milestone
 * that gives a slip somewhere to be spent, and it must not inherit that.
 *
 * IDENTITY, NOT SHAPE. A slip is genuine because it is THE OBJECT this module
 * froze, not because it looks like one. The WeakSet holds no strong reference,
 * so a slip nobody kept is collected normally; a slip that was copied is a
 * different object and is simply not in the set.
 *
 * The brand stays, and `isAuthorisedDial` keeps its old meaning, because it is
 * still a useful cheap check and callers depend on it. It is no longer the
 * check that may authorise execution. See `isGenuineAuthorisedDial`.
 */
const MINTED = new WeakSet();

/**
 * A stable id for one authorisation, for correlation and audit only.
 *
 * NOT a capability. Holding the string authorises nothing — execution requires
 * the object itself. It is derived rather than random so that a proof run and
 * its transcript can be compared without a clock or an entropy source.
 */
function authorisationIdFor({ prospectId, e164, authorisedAt, decision }) {
  const body = [prospectId || "", e164 || "", authorisedAt || "", decision || ""].join("|");
  return `ad_${createHash("sha256").update(body).digest("hex").slice(0, 20)}`;
}

function mintAuthorisedDial({ prospectId, businessName, e164, authorisedAt, decision }) {
  const slip = Object.freeze({
    [AUTHORISED_DIAL]: true,
    kind: "authorised-dial",
    /** Correlation only. See authorisationIdFor: it is not a bearer token. */
    authorisationId: authorisationIdFor({ prospectId, e164, authorisedAt, decision }),
    prospectId,
    businessName,
    /** The number the gate cleared. Whatever dials must use THIS one. */
    e164,
    authorisedAt,
    decision,
    note: "Permission to attempt one call, as at authorisedAt. It expires the moment anything changes; re-authorise rather than storing this.",
  });
  MINTED.add(slip);
  return slip;
}

/**
 * The BRAND check. True for a slip this module minted — and also for a copy of
 * one, because a copy carries the symbol. Cheap, and adequate for reporting.
 *
 * Do not use it to decide whether something may be executed. Use
 * `isGenuineAuthorisedDial`.
 */
function isAuthorisedDial(value) {
  return Boolean(value) && typeof value === "object" && value[AUTHORISED_DIAL] === true;
}

/**
 * The IDENTITY check, and the only one execution may rely on (E-7A).
 *
 * True only for an object this module actually froze and registered. A forged
 * lookalike, a spread clone, an Object.assign copy, a JSON round-trip and a
 * structuredClone are all false — the first two because they are different
 * objects, the last two because they are different objects that also lost the
 * brand on the way.
 */
function isGenuineAuthorisedDial(value) {
  return Boolean(value) && typeof value === "object" && MINTED.has(value);
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
 *                   attemptPolicy, callingPolicy, callingPolicyApproval,
 *                   policyVersion.
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
  function decide({ authorised, code, message, prospect, e164, instant, eligibility, suppressionSource, failedChecks, batchApproval = null }) {
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
      /** And where the attempt history came from. Always "durable" on any authorised one. */
      historySource: eligibility ? eligibility.historySource || null : null,
      /** And the founder batch approval (E-5). Always "durable" on any authorised one. */
      batchSource: eligibility ? eligibility.batchSource || null : null,
      /** And the duplicate resolution (M8L). Always "durable" on any authorised one. */
      duplicateSource: eligibility ? eligibility.duplicateSource || null : null,
      /** Which durable approval covered it, if one did. */
      batchKey: batchApproval ? batchApproval.batchKey || null : null,
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

    // ── WHAT THE CALLER IS NOT ALLOWED TO DECIDE (E-5, M8L) ───────────
    //
    // Both are removed from the object before anything downstream can see them,
    // in the same statement that captures them. Not overwritten later, not
    // ignored by convention — taken away.
    //
    // `callerBatch` survives only so its `batchKey` can hint the durable lookup;
    // every other field on it, including `approved: true`, is discarded.
    //
    // `duplicateResolution` survives for nothing at all. It needs no hint: a
    // prospect names itself, and the review decisions are keyed by that same id.
    // It is captured only so that the rest-spread cannot carry it through.
    const { batch: callerBatch = null, duplicateResolution: _callerDuplicates = null, ...callerContext } = context || {};

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

    // ── 2b. THE DURABLE CONTACT HISTORY (M8J / E-1) ───────────────────
    //
    // The second authoritative read, for the same reason as the first. Until
    // M8J no production path supplied an attempt history at all, so every
    // prospect evaluated as though it had never been called — and approving
    // A-L6 would have enforced caps against zero.
    //
    // readContactHistory never throws: an unreadable store comes back
    // `available: false`, the engine is built with historyRequired and refuses,
    // and the refusal is `contact_history_unavailable` — the gate's own
    // failure, not a claim about the business.
    // ── 2c. THE DURABLE FOUNDER BATCH APPROVAL (E-5) ──────────────────
    //
    // The third authoritative read, and it exists for the same reason as the
    // first two. Until E-5 the approval arrived as `context.batch`, an object
    // the caller built — so a process that had never seen a founder could
    // authorise a call by asserting one had approved, and a batch approved this
    // morning by a process that has since exited left nothing behind to read.
    //
    // The caller's `batch` is destructured off the context below and DISCARDED.
    // It may still name a batchKey as a REFERENCE, which narrows the lookup and
    // confers nothing: if the store says there is no approval, there is no
    // approval, whatever the object claimed. resolveBatchApprovalForProspect
    // never throws — an unreadable store comes back `unavailable: true` and the
    // engine refuses with batch_approval_store_unavailable, which is the gate's
    // own failure and never a finding about the batch.
    //
    // WHAT THIS DELIBERATELY DOES NOT DO is treat the approval as permission.
    // It clears exactly one check. Suppression, DNCR, duplicates, campaign,
    // policy, attempts and the calling window are all still evaluated below,
    // against the state of the world at this instant.
    const batchApproval = await resolveBatchApprovalForProspect({
      store,
      prospectId: prospect.prospectId,
      e164,
      batchKey: callerBatch && typeof callerBatch === "object" ? callerBatch.batchKey || null : null,
    });

    if (batchApproval.unavailable && audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId || "unknown",
        event: "authorisation_blocked",
        decision: "veto",
        actor: "dial-authoriser",
        actorKind: "system",
        reason: `The founder batch approval store could not be read, so authorisation was refused: ${batchApproval.message}`,
        detail: { code: ELIGIBILITY_CODES.BATCH_STORE_UNAVAILABLE },
      });
    }

    // ── 2d. THE DURABLE DUPLICATE RESOLUTION (M8L) ────────────────────
    //
    // The fourth authoritative read. Until M8L the duplicate check was cleared
    // by `context.duplicateResolution` — the output of resolveDuplicates() over
    // a record set the caller chose. Default-deny held, so the hole was not a
    // missing check; it was that `resolveDuplicates([oneProspect])` is a valid
    // resolution in which nothing can be a duplicate of anything, and it passed.
    //
    // The answer now comes from the M8H review decisions: an open review means
    // unresolved, a merge means the canonical business is the callable one, a
    // rejection means this record is not callable at all, and approve-as-new
    // means a human settled the identity question. No caller hint is taken,
    // because none is needed.
    //
    // resolveDuplicateStateForProspect never throws — an unreadable store comes
    // back `unavailable: true` and the engine refuses with
    // duplicate_resolution_store_unavailable, which is the gate's own failure
    // and never a claim about the business.
    const duplicateState = await resolveDuplicateStateForProspect({ store, prospectId: prospect.prospectId });

    if (duplicateState.unavailable && audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId || "unknown",
        event: "authorisation_blocked",
        decision: "veto",
        actor: "dial-authoriser",
        actorKind: "system",
        reason: `The durable duplicate resolution could not be read, so authorisation was refused: ${duplicateState.message}`,
        detail: { code: ELIGIBILITY_CODES.DUPLICATE_STORE_UNAVAILABLE },
      });
    }

    const contactHistory = await readContactHistory({ store, prospectId: prospect.prospectId });
    if (!contactHistory.available && audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId || "unknown",
        event: "authorisation_blocked",
        decision: "veto",
        actor: "dial-authoriser",
        actorKind: "system",
        reason: `The contact history could not be read, so authorisation was refused: ${contactHistory.reason}`,
        detail: { code: ELIGIBILITY_CODES.HISTORY_UNAVAILABLE },
      });
    }

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
    // Both authoritative reads are bound LAST and unconditionally, so a caller
    // who supplies either cannot reach the engine with it. historyRequired is
    // set here and nowhere else: this is the one path where a caller-built
    // history must be refused outright rather than merely labelled.
    const { suppression: _ignoredSuppression, historyIndex: _ignoredIndex, historyRequired: _ignoredFlag, ...collaborators } = engineOptions || {};
    const active = createEligibilityEngine({ ...collaborators, now, suppression: authoritative, historyRequired: true });

    // `callerContext` is the context WITHOUT `batch` and WITHOUT
    // `duplicateResolution` — see the destructure at the top of authorise(). All
    // four authoritative answers are spread AFTER it, so a caller who supplies
    // any of them cannot reach the engine with it.
    const eligibility = active.evaluate(prospect, {
      ...callerContext,
      at: instant,
      history: contactHistory,
      batch: batchApproval,
      duplicateState,
    });

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
        batchApproval,
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
      batchApproval,
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
  isGenuineAuthorisedDial,
  AUTHORISATION_CODES,
  AUTHORISED_DIAL,
};
