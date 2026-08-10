// AIDA Locksmith Acquisition — durable duplicate resolution (M8L).
//
//   resolveDuplicateStateForProspect({ store, prospectId })   what the gate asks
//   summariseDuplicateState({ store })                        what a founder reads
//   DUPLICATE_STATE / DUPLICATE_STATE_CODES
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────
// The eligibility engine's duplicate check was satisfied by
// `context.duplicateResolution` — the return value of `resolveDuplicates()` run
// over a record set THE CALLER CHOSE. Default-deny held (no resolution meant
// refusal), so the hole was not "forgot to check". It was subtler and worse:
//
//     resolveDuplicates([theOneProspect])
//
// is a valid resolution object in which nothing is ever a duplicate of anything,
// because there is nothing to compare against. Every test, every dry run and
// both dev proofs built exactly that, and it cleared the gate. A caller could
// authorise a call to a business it had every reason to know was a duplicate,
// simply by analysing it alone.
//
// And none of it was durable. A founder's decision about an ambiguous identity —
// the one judgement in this pipeline that is most obviously a human's — was
// re-derived in memory on every run and never consulted at the moment it
// mattered.
//
// ── NO NEW STATE, AND NO NEW SQL. M8H ALREADY DECIDED THIS. ─────────
// The review queue has recorded exactly this since M8H, in the append-only
// decision log, keyed by the candidate's prospect id:
//
//   review_opened     defer     an ambiguous identity, its signals, and the
//                               prospects it might already be
//   review_resolved   approve   approve_as_new       — a distinct business
//                     approve   merge_into_existing  — plus a mergeTarget
//                     reject    reject_duplicate     — it is the other one
//                     reject    reject_not_locksmith
//                     defer     needs_more_information — stays open
//
// Those five outcomes ARE the five states M8L has to answer. Inventing a
// `duplicate_resolved` event beside them would have created a second truth
// source that could disagree with the review queue, and the disagreement would
// be discovered by a call to the wrong business.
//
// So this module adds no event, no column and no table. It reads what a human
// already decided and answers one question with it.
//
// ── THE ONE INFERENCE, STATED PLAINLY ───────────────────────────────
// A prospect with NO review item is treated as durably cleared — but only if a
// prospect ROW exists for it.
//
// That is an inference and it is worth being explicit about, because it is the
// load-bearing one. `acquisition-persist` writes a prospect row only for
// candidates the import did NOT hold: a candidate with a duplicate concern is
// held, a review item is opened, and no row is written (M8H). A row therefore
// means dedupe ran over the whole import and did not flag this business, or a
// human approved it as new. Either is a real, durable clearance.
//
// The converse is what makes it safe. A prospect object that exists only in a
// caller's memory has NEVER been assessed against anything, and is refused as
// `duplicate_never_assessed` rather than passing because no review happens to
// name it. Absence of a review is only evidence when there is a row whose
// existence required one not to be needed.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────
// It is not permission to call. It clears one check. Suppression, DNCR, the
// calling window, holidays, the attempt policy, lifecycle, campaign, the durable
// founder batch approval and the M8E gate itself are all still evaluated at the
// instant of every call, and only that gate mints an AuthorisedDial.
//
// Pure apart from the injected store. See test/acquisition-duplicate-state.test.js.

const { assertStoreContract } = require("./acquisition-store");
const { loadReviewItem, listReviewItems, REVIEW_DECISIONS, STATUS } = require("./acquisition-review-queue");

/** What durable state says about one business's identity. */
const DUPLICATE_STATE = Object.freeze({
  /** A distinct business: cleared at import, or a human approved it as new. */
  RESOLVED_DISTINCT: "resolved_distinct",
  /** A human has been asked and has not answered, or asked for more information. */
  UNRESOLVED: "unresolved",
  /** A human merged it into another business. That one is callable; this is not. */
  MERGED: "merged_into_canonical",
  /** A human rejected it — as a duplicate, or as not a locksmith at all. */
  REJECTED: "rejected",
  /** Nothing durable has ever assessed this record's identity. */
  NEVER_ASSESSED: "never_assessed",
  /** OUR failure. Never a finding about the business. */
  UNAVAILABLE: "unavailable",
});

/**
 * The eligibility codes each state reports.
 *
 * The first two are the existing duplicate vocabulary and are reused rather than
 * duplicated. The last three are new because they name facts the old vocabulary
 * could not distinguish — see acquisition-eligibility.
 */
const DUPLICATE_STATE_CODES = Object.freeze({
  REQUIRES_RESOLUTION: "duplicate_requires_resolution",
  OF_CANONICAL: "duplicate_of_canonical",
  NEVER_ASSESSED: "duplicate_never_assessed",
  REVIEW_REJECTED: "review_decision_rejected",
  STORE_UNAVAILABLE: "duplicate_resolution_store_unavailable",
});

const text = (v) => (typeof v === "string" ? v.trim() : "");

function verdict(state, code, message, extra = {}) {
  return Object.freeze({
    state,
    /** True only when this record's identity is durably settled AND callable. */
    resolved: state === DUPLICATE_STATE.RESOLVED_DISTINCT,
    blocked: state !== DUPLICATE_STATE.RESOLVED_DISTINCT,
    unavailable: state === DUPLICATE_STATE.UNAVAILABLE,
    /** Where the answer came from. Always "durable" on any real decision. */
    source: state === DUPLICATE_STATE.UNAVAILABLE ? "unavailable" : "durable",
    code,
    message,
    canonicalId: null,
    reviewId: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    reviewDecision: null,
    ...extra,
  });
}

/**
 * Is this business's identity durably resolved, and is this the identity that
 * may be called?
 *
 * NEVER THROWS. An unreadable store comes back `unavailable: true`, because the
 * caller that matters is the pre-dial gate and a thrown error there is far too
 * easy to catch into "no duplicate known".
 *
 * NO CALLER HINT IS ACCEPTED, and none is needed: the prospect names itself, and
 * review items are keyed by that same id. There is deliberately no parameter a
 * caller could use to point this lookup somewhere more convenient.
 *
 * @param {object} store
 * @param {string} prospectId
 */
async function resolveDuplicateStateForProspect({ store, prospectId } = {}) {
  assertStoreContract(store, "duplicate resolution store");

  const id = text(prospectId);
  if (!id) {
    return verdict(
      DUPLICATE_STATE.NEVER_ASSESSED,
      DUPLICATE_STATE_CODES.NEVER_ASSESSED,
      "This record has no prospect id, so nothing can be looked up about whether it duplicates a business we already know."
    );
  }

  // ── The durable reads ─────────────────────────────────────────────
  let item;
  let prospect;
  try {
    item = await loadReviewItem({ store, reviewId: id });
    prospect = await store.loadProspect(id);
  } catch (err) {
    return verdict(
      DUPLICATE_STATE.UNAVAILABLE,
      DUPLICATE_STATE_CODES.STORE_UNAVAILABLE,
      `Whether this business duplicates one we already know could not be established, so no call is permitted. ${err.message}`
    );
  }

  if (item) {
    const common = {
      reviewId: item.reviewId,
      reviewDecision: item.decision,
      decidedBy: item.decidedBy,
      decidedAt: item.resolvedAt,
      decisionReason: item.decisionReason,
    };

    if (item.status !== STATUS.RESOLVED) {
      // Open, or reopened by needs_more_information. A human has been asked and
      // has not answered; nothing may be called on either side of an unresolved
      // identity question.
      return verdict(
        DUPLICATE_STATE.UNRESOLVED,
        DUPLICATE_STATE_CODES.REQUIRES_RESOLUTION,
        `A person has been asked whether this is the same business as ${
          item.possibleMatches && item.possibleMatches.length ? item.possibleMatches.join(", ") : "one we already know"
        } and has not decided. ${item.reason || ""}`.trim(),
        { ...common, possibleMatches: Object.freeze([...(item.possibleMatches || [])]) }
      );
    }

    if (item.decision === REVIEW_DECISIONS.MERGE_INTO_EXISTING) {
      // ── C. THE CANONICAL IS THE ONLY CALLABLE IDENTITY ────────────
      // The candidate never became a prospect; what it knew was attached to the
      // canonical business instead. Calling it would dial that business twice,
      // which is the harm the whole duplicate step exists to prevent — and the
      // decision is durable, so a fresh process reaches the same answer without
      // being told.
      return verdict(
        DUPLICATE_STATE.MERGED,
        DUPLICATE_STATE_CODES.OF_CANONICAL,
        `${item.decidedBy} decided on ${item.resolvedAt} that this is the same business as ${item.mergeTarget || "another record"}, which is the one that would be called. ${item.decisionReason || ""}`.trim(),
        { ...common, canonicalId: item.mergeTarget || null }
      );
    }

    if (item.decision === REVIEW_DECISIONS.REJECT_DUPLICATE) {
      return verdict(
        DUPLICATE_STATE.REJECTED,
        DUPLICATE_STATE_CODES.OF_CANONICAL,
        `${item.decidedBy} decided on ${item.resolvedAt} that this record is a duplicate and rejected it. ${item.decisionReason || ""}`.trim(),
        common
      );
    }

    if (item.decision === REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH) {
      // Not a duplicate question at all, and reported as itself rather than
      // dressed up as one. It is checked here because the lifecycle column that
      // would otherwise block it is a PROJECTION of this decision (M8J), and a
      // projection that has not landed yet must not leave a rejected business
      // callable.
      return verdict(
        DUPLICATE_STATE.REJECTED,
        DUPLICATE_STATE_CODES.REVIEW_REJECTED,
        `${item.decidedBy} rejected this record on ${item.resolvedAt}: ${item.decisionReason || "it is not a locksmith."}`,
        common
      );
    }

    // APPROVE_AS_NEW — a human looked at the ambiguity and said these are
    // different businesses. That settles the identity question. It settles
    // NOTHING else: the record still has to be persisted, and every other gate
    // still applies. So it falls through to the row check below.
    if (!prospect) {
      return verdict(
        DUPLICATE_STATE.NEVER_ASSESSED,
        DUPLICATE_STATE_CODES.NEVER_ASSESSED,
        `${item.decidedBy} approved this candidate as a distinct business on ${item.resolvedAt}, but no prospect record was ever stored for it. Nothing may be called from a record that does not exist durably.`,
        common
      );
    }
    return verdict(
      DUPLICATE_STATE.RESOLVED_DISTINCT,
      null,
      `${item.decidedBy} decided on ${item.resolvedAt} that this is a distinct business. ${item.decisionReason || ""}`.trim(),
      { ...common, canonicalId: id }
    );
  }

  // ── No review item was ever opened ────────────────────────────────
  //
  // See the header: the row is the evidence, not the silence. A candidate the
  // import held for review has no row, so a row means the import compared this
  // business against everything else it had and did not flag it.
  if (!prospect) {
    return verdict(
      DUPLICATE_STATE.NEVER_ASSESSED,
      DUPLICATE_STATE_CODES.NEVER_ASSESSED,
      "No stored record of this business exists, so nothing has ever compared it against the businesses we already know. An unassessed identity is not a cleared one."
    );
  }

  return verdict(
    DUPLICATE_STATE.RESOLVED_DISTINCT,
    null,
    "This business was compared against the records we hold when it was imported, and no duplicate concern was raised about it.",
    { canonicalId: id }
  );
}

/**
 * What a founder needs to see about duplicate resolution across the queue.
 *
 * Separate from the gate read on purpose. This folds the whole log, which is
 * right for a screen somebody reads occasionally and wrong for a check that runs
 * once per authorisation — so the gate never calls it.
 */
async function summariseDuplicateState({ store, limit = 500 } = {}) {
  assertStoreContract(store, "duplicate resolution store");

  let items;
  try {
    items = await listReviewItems({ store, limit });
  } catch (err) {
    return Object.freeze({ available: false, reason: err.message, counts: null, items: Object.freeze([]) });
  }

  const counts = { unresolved: 0, resolvedDistinct: 0, merged: 0, rejectedDuplicate: 0, rejectedOther: 0 };
  const rows = [];

  for (const item of items) {
    let bucket;
    if (item.status !== STATUS.RESOLVED) bucket = "unresolved";
    else if (item.decision === REVIEW_DECISIONS.MERGE_INTO_EXISTING) bucket = "merged";
    else if (item.decision === REVIEW_DECISIONS.REJECT_DUPLICATE) bucket = "rejectedDuplicate";
    else if (item.decision === REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH) bucket = "rejectedOther";
    else bucket = "resolvedDistinct";
    counts[bucket] += 1;

    rows.push(
      Object.freeze({
        reviewId: item.reviewId,
        prospectId: item.prospectId,
        businessName: item.candidate ? item.candidate.businessName : null,
        bucket,
        status: item.status,
        decision: item.decision,
        canonicalId: item.mergeTarget || null,
        possibleMatches: Object.freeze([...(item.possibleMatches || [])]),
        decidedBy: item.decidedBy,
        decidedAt: item.resolvedAt,
        decisionReason: item.decisionReason,
        openedAt: item.openedAt,
      })
    );
  }

  return Object.freeze({
    available: true,
    reason: null,
    counts: Object.freeze({ ...counts, total: items.length }),
    items: Object.freeze(rows),
  });
}

module.exports = {
  resolveDuplicateStateForProspect,
  summariseDuplicateState,
  DUPLICATE_STATE,
  DUPLICATE_STATE_CODES,
};
