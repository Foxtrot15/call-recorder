// AIDA Locksmith Acquisition — projecting a review decision onto a prospect
// (M8J / E-2).
//
//   projectReviewResolution({ store, reviewId, now, actor })
//   reconcileReviewProjections({ store, now, actor, limit })
//   lifecycleForReviewDecision(decision)
//   PROJECTION_CODES
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────
// `recordReviewDecision` (A1) moves an in-memory prospect object to
// `review_approved`. Nothing wrote that anywhere. `upsertProspect` deliberately
// refuses to send `lifecycle` — correctly, because a re-run CSV must not drag a
// reviewed business back to `discovered` — so a persisted prospect was
// permanently `discovered`, and the eligibility engine's `review_approved`
// check could never be satisfied by anything in the database.
//
// Counsel could have signed off A-L1 tomorrow and not one prospect would have
// become eligible.
//
// ── DECISION FIRST, PROJECTION SECOND. THE ORDER IS THE DESIGN. ─────
// There is no multi-statement transaction over PostgREST, so the append to
// `acquisition_decisions` and the update to `acquisition_prospects.lifecycle`
// are two separate writes and either can be the last one to succeed. One of
// those orders is recoverable and the other is not:
//
//   decision → projection   the failure leaves a durable, attributable record
//                           of what was decided and a lifecycle that has not
//                           caught up. Repairable from the decision, by anyone,
//                           later. Eligibility stays BLOCKED meanwhile, because
//                           the column still says review_pending.
//
//   projection → decision   the failure leaves a business marked APPROVED with
//                           no record of who approved it or why. That is an
//                           unattributable approval — the exact thing the
//                           append-only log exists to make impossible — and it
//                           fails OPEN.
//
// So the decision is the truth and the lifecycle column is a PROJECTION of it.
// This module reads the durable decision and makes the column agree.
//
// ── REPAIR APPENDS NOTHING ──────────────────────────────────────────
// Reconciliation reads the existing resolution; it never records a second one.
// A repeated resolution goes through resolveReviewItem, which already refuses
// with `already_resolved` and names who decided it. Neither path can produce a
// second human decision for one review, and the decision log is append-only
// anyway — a duplicate could not be taken back.
//
// Pure apart from the store. See test/acquisition-lifecycle.test.js.

const { assertStoreContract, LIFECYCLE_TRANSITION_CODES } = require("./acquisition-store");
const { loadReviewItem, listReviewItems, REVIEW_DECISIONS, STATUS } = require("./acquisition-review-queue");

const PROJECTION_CODES = Object.freeze({
  PROJECTED: "lifecycle_projected",
  ALREADY_CONSISTENT: "lifecycle_already_consistent",
  NO_PROSPECT_ROW: "no_persisted_prospect",
  NOT_RESOLVED: "review_not_resolved",
  NOT_FOUND: "review_not_found",
  NO_LIFECYCLE_EFFECT: "decision_has_no_lifecycle_effect",
  BLOCKED: "lifecycle_projection_blocked",
  FAILED: "lifecycle_projection_failed",
});

/**
 * Which lifecycle state a review decision projects onto the prospect.
 *
 * `merge_into_existing` returns null deliberately: the candidate is not a
 * prospect and never becomes one — the canonical business is enriched instead
 * (M8H). Moving a lifecycle on the merge TARGET would be asserting that a human
 * reviewed the target, which they did not; they reviewed the candidate.
 *
 * `needs_more_information` returns null because the item stays open.
 */
function lifecycleForReviewDecision(decision) {
  switch (decision) {
    case REVIEW_DECISIONS.APPROVE_AS_NEW:
      return "review_approved";
    case REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH:
    case REVIEW_DECISIONS.REJECT_DUPLICATE:
      return "review_rejected";
    default:
      return null;
  }
}

/**
 * The path a persisted prospect must walk to reach the reviewed state.
 *
 * A prospect persisted by the M8G import lands at `discovered` (the column
 * default), and the state machine will not jump straight to `review_approved` —
 * `discovered → evidence_captured → review_pending → review_approved`, one legal
 * hop at a time. Walking it is not ceremony: each hop writes a journal entry, so
 * the prospect's own history reads as what happened rather than as a jump
 * somebody made in a database client.
 */
function pathTo(from, to) {
  const ORDER = ["discovered", "evidence_captured", "review_pending"];
  if (from === to) return [];
  const start = ORDER.indexOf(from);
  if (start === -1) return null; // not on the pre-review path; caller decides
  const steps = ORDER.slice(start + 1);
  steps.push(to);
  return steps;
}

/**
 * Make one prospect's lifecycle agree with its durable review resolution.
 *
 * IDEMPOTENT. Running it on an already-consistent prospect reports
 * `lifecycle_already_consistent` and writes nothing. That is what makes it safe
 * as a repair: the caller does not have to know whether the first attempt got
 * through.
 *
 * @param {object}   store
 * @param {string}   reviewId
 * @param {function} now
 * @param {string}   [actor]  who is applying the projection. Defaults to the
 *                            system, because the DECISION carries the human —
 *                            the projection is bookkeeping, not a judgement.
 */
async function projectReviewResolution({ store, reviewId, now, actor = "review-projection", prospectId = null } = {}) {
  assertStoreContract(store, "projection store");
  if (typeof now !== "function") throw new Error("projectReviewResolution requires an injected now().");

  const item = await loadReviewItem({ store, reviewId });
  if (!item) return { ok: false, code: PROJECTION_CODES.NOT_FOUND, message: `There is no review item "${String(reviewId).slice(0, 60)}".` };
  if (item.status !== STATUS.RESOLVED) {
    return { ok: false, code: PROJECTION_CODES.NOT_RESOLVED, message: `"${item.reviewId}" is still open, so there is no resolution to project.`, item };
  }

  const target = lifecycleForReviewDecision(item.decision);
  if (target === null) {
    return {
      ok: true,
      code: PROJECTION_CODES.NO_LIFECYCLE_EFFECT,
      changed: false,
      message: `"${item.decision}" does not move a prospect's lifecycle${item.decision === REVIEW_DECISIONS.MERGE_INTO_EXISTING ? " — the candidate never becomes a prospect; the canonical business was enriched instead." : "."}`,
      item,
    };
  }

  const id = prospectId || item.prospectId;
  const prospect = await store.loadProspect(id);
  if (!prospect) {
    // Not an error. A rejected candidate is commonly never persisted at all —
    // that is the review queue's whole point — and there is nothing to project.
    return {
      ok: true,
      code: PROJECTION_CODES.NO_PROSPECT_ROW,
      changed: false,
      message: `"${item.decision}" was recorded, and there is no persisted prospect "${id}" whose lifecycle needs to agree with it.`,
      item,
    };
  }
  if (prospect.lifecycle === target) {
    return { ok: true, code: PROJECTION_CODES.ALREADY_CONSISTENT, changed: false, message: `"${id}" is already "${target}".`, item, prospect };
  }

  const steps = pathTo(prospect.lifecycle, target);
  if (steps === null) {
    return {
      ok: false,
      code: PROJECTION_CODES.BLOCKED,
      message: `"${id}" is "${prospect.lifecycle}", which is not on the path to "${target}". A human decided this review; a human has to decide what to do with a prospect that has moved on since.`,
      item,
      prospect,
    };
  }

  const reason = `Projecting review ${item.reviewId}: ${item.decidedBy} decided ${item.decision} on ${item.resolvedAt}. ${item.decisionReason}`;
  const applied = [];
  let current = prospect;

  for (const step of steps) {
    const result = await store.transitionProspectLifecycle({
      prospectId: id,
      // COMPARE-AND-SET on every hop, not just the first. A concurrent
      // reconciler working the same review is refused rather than racing us
      // through the path.
      expectedFrom: current.lifecycle,
      to: step,
      actor,
      reason,
      at: now().toISOString(),
    });

    if (!result.ok) {
      // FAIL CLOSED AND LEAVE IT REPAIRABLE. Whatever hops did land stay
      // landed; nothing is rolled back, because a half-walked path is still
      // closer to the truth than `discovered` and the next run continues from
      // wherever this one stopped. The durable decision is untouched.
      return {
        ok: false,
        code: result.code === LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE ? PROJECTION_CODES.BLOCKED : PROJECTION_CODES.FAILED,
        message: `The lifecycle could not be brought to "${target}": ${result.message} The review decision stands and is unchanged; run reconciliation again once this is understood.`,
        item,
        prospect: current,
        applied,
        failedAt: step,
        cause: result.code,
      };
    }

    applied.push({ from: current.lifecycle, to: step, changed: result.changed === true });
    current = result.prospect;
  }

  return {
    ok: true,
    code: PROJECTION_CODES.PROJECTED,
    changed: applied.some((a) => a.changed),
    message: `"${id}" is now "${target}", matching the review ${item.decidedBy} resolved on ${item.resolvedAt}.`,
    item,
    prospect: current,
    applied,
  };
}

/**
 * Find every resolved review whose prospect disagrees with it, and repair it.
 *
 * This is the recovery path for "the decision landed and the projection did
 * not". It is safe to run at any time, appends nothing to the decision log, and
 * reports what it could not fix rather than forcing it.
 */
async function reconcileReviewProjections({ store, now, actor = "review-projection", limit = 500 } = {}) {
  assertStoreContract(store, "projection store");
  if (typeof now !== "function") throw new Error("reconcileReviewProjections requires an injected now().");

  const resolved = await listReviewItems({ store, status: STATUS.RESOLVED, limit });
  const repaired = [];
  const alreadyConsistent = [];
  const skipped = [];
  const failed = [];

  for (const item of resolved) {
    const result = await projectReviewResolution({ store, reviewId: item.reviewId, now, actor });
    if (!result.ok) failed.push({ reviewId: item.reviewId, code: result.code, message: result.message });
    else if (result.code === PROJECTION_CODES.PROJECTED) repaired.push({ reviewId: item.reviewId, prospectId: item.prospectId, applied: result.applied });
    else if (result.code === PROJECTION_CODES.ALREADY_CONSISTENT) alreadyConsistent.push(item.reviewId);
    else skipped.push({ reviewId: item.reviewId, code: result.code });
  }

  return Object.freeze({
    examined: resolved.length,
    repaired: Object.freeze(repaired),
    alreadyConsistent: Object.freeze(alreadyConsistent),
    skipped: Object.freeze(skipped),
    failed: Object.freeze(failed),
    ok: failed.length === 0,
  });
}

module.exports = {
  projectReviewResolution,
  reconcileReviewProjections,
  lifecycleForReviewDecision,
  pathTo,
  PROJECTION_CODES,
};
