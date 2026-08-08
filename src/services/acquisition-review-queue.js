// AIDA Locksmith Acquisition — the durable review queue (M8H).
//
//   openReviewItem({ candidate, reason, store, now, ... })
//   listReviewItems({ store, status })
//   loadReviewItem({ store, reviewId })
//   resolveReviewItem({ store, reviewId, decision, actor, reason, ... })
//
// M8F could tell a founder that a row needed a human. M8G could store the rows
// that did not. Between them sat the work itself — the ambiguous candidates —
// which lived in a returned object, got printed, and died with the process.
//
// ── IT IS AN EVENT LOG, NOT A STATUS COLUMN, AND NO NEW TABLE ───────
// A review item is two decisions in `acquisition_decisions`:
//
//   review_opened     decision: defer     the candidate, the signals, the
//                                         possible matches, the reason
//   review_resolved   decision: approve   what a human decided, who they were,
//                     or reject           and why
//
// Current state is a fold over the rows for one entity_id, exactly as
// suppression and outcomes already work. That table is append-only and
// hash-chained, so the queue inherits an audit trail rather than needing one:
// "who decided this, when, and against what evidence" is answerable a year
// later, and a row that was altered is detectable.
//
// A status column would have been simpler and wrong. Reviews are decisions, and
// this project's rule is that decisions are appended, never edited.
//
// ── WHY A REVIEW ITEM IS NOT A PROSPECT ROW ─────────────────────────
// The obvious alternative is to persist the candidate with
// `lifecycle: review_pending`, which the schema already supports. It is wrong
// here for one specific reason: the commonest review item is "this may be a
// duplicate of a business we already have", and writing it as a prospect
// creates exactly the duplicate row M8G removed. The review queue exists to
// hold candidates that must NOT become prospects until a human says so.
//
// ── CONCURRENT WRITERS (M8I supersedes M8H's single-writer note) ────
// M8H continued the chain across a restart and said plainly that two processes
// appending at once would fork it. They no longer can: laq3 puts
// `unique (prev_hash)` on acquisition_decisions, so the database itself permits
// exactly one successor per head and the loser of a race gets a 23505.
//
// Every append here goes through appendDecisionSerialised, which re-reads the
// head, re-mints and re-tries on that refusal — bounded, and throwing rather
// than reporting a decision as recorded when it was not. The protection is the
// index, not the helper; the helper only makes losing survivable.
//
// Nothing here contacts anybody, and resolving a review does not make a
// business callable.
//
// See test/acquisition-review-queue.test.js and test/acquisition-decision-log.test.js.

const { assertStoreContract } = require("./acquisition-store");
const { appendDecisionSerialised, hydrateLog, ChainContentionError } = require("./acquisition-decision-log");
const S = require("./acquisition-schema");

const ENTITY_TYPE = "prospect";
const EVENT_OPENED = "review_opened";
const EVENT_RESOLVED = "review_resolved";

/**
 * What a human may decide.
 *
 * Mapped onto the decision-log vocabulary the schema already constrains
 * (`approve` / `reject`), so the CHECK constraint keeps working and no parallel
 * set of words has to be kept in step with it.
 */
const REVIEW_DECISIONS = Object.freeze({
  APPROVE_AS_NEW: "approve_as_new",
  MERGE_INTO_EXISTING: "merge_into_existing",
  REJECT_NOT_LOCKSMITH: "reject_not_locksmith",
  REJECT_DUPLICATE: "reject_duplicate",
  NEEDS_MORE_INFORMATION: "needs_more_information",
});

/** Which of those resolve an item, and which leave it open. */
const RESOLVING = Object.freeze([
  REVIEW_DECISIONS.APPROVE_AS_NEW,
  REVIEW_DECISIONS.MERGE_INTO_EXISTING,
  REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH,
  REVIEW_DECISIONS.REJECT_DUPLICATE,
]);

/** How each maps to the append-only log's own `decision` CHECK. */
const LOG_DECISION = Object.freeze({
  [REVIEW_DECISIONS.APPROVE_AS_NEW]: "approve",
  [REVIEW_DECISIONS.MERGE_INTO_EXISTING]: "approve",
  [REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH]: "reject",
  [REVIEW_DECISIONS.REJECT_DUPLICATE]: "reject",
  [REVIEW_DECISIONS.NEEDS_MORE_INFORMATION]: "defer",
});

const STATUS = Object.freeze({ OPEN: "open", RESOLVED: "resolved" });

/**
 * Build a log that continues the persisted chain rather than starting a new one.
 *
 * KEPT AS A NAME, NOT AS AN IMPLEMENTATION (M8I). M8H derived the head from the
 * last element of listDecisions(), which is the last element of a PAGE — right
 * for eighteen rows and silently wrong past the limit, where it would hydrate a
 * long-dead head and mint a fork. It now delegates to the authoritative
 * single-row head read.
 */
const hydratedLog = hydrateLog;

/** A review item id is derived from the candidate, so the same one is stable. */
const reviewIdFor = (candidate) => `rv_${candidate.prospectId}`;

/**
 * Open a review item for one ambiguous candidate.
 *
 * IDEMPOTENT. Re-importing the same unresolved candidate finds the open item
 * and returns it rather than opening a second one — otherwise a founder who ran
 * the same file twice would be asked the same question twice, and a nightly
 * import would build a queue nobody could face.
 *
 * THROWS ChainContentionError if the log could not be appended to. Deliberately
 * not softened into a returned object: every other path here returns something
 * truthy, so a "failed" object would be counted as an opened review by any
 * caller that did not check, and the candidate would be dropped silently.
 */
async function openReviewItem({ candidate, reason, signals = [], possibleMatches = [], evidence = [], store, now, actor = "acquisition-import", importContext = null } = {}) {
  if (typeof now !== "function") throw new Error("openReviewItem requires an injected now().");
  assertStoreContract(store, "review store");
  if (!candidate || !candidate.prospectId) throw new Error("openReviewItem needs a candidate with a prospectId.");

  const reviewId = reviewIdFor(candidate);
  const existing = await loadReviewItem({ store, reviewId });

  if (existing && existing.status === STATUS.OPEN) {
    return Object.freeze({ ...existing, created: false, message: `Already waiting for review since ${existing.openedAt}.` });
  }
  if (existing && existing.status === STATUS.RESOLVED) {
    // A resolved item is not reopened by the same evidence arriving again. That
    // is the whole value of having recorded the decision: the founder said no
    // once and should not be asked again by the next export.
    return Object.freeze({ ...existing, created: false, message: `Already decided on ${existing.resolvedAt}: ${existing.decision}. Not reopened.` });
  }

  // Minted per attempt. If another process opened this same review while we
  // were reading, the re-check inside the callback finds it and aborts rather
  // than opening a second one — which is the idempotency guard above, applied
  // again at the point where it can actually be relied upon.
  const outcome = await appendDecisionSerialised({
    store,
    now,
    mint: async ({ log, attempt }) => {
      if (attempt > 1) {
        const raced = await loadReviewItem({ store, reviewId });
        if (raced) return null;
      }
      return log.record({
        entityType: ENTITY_TYPE,
        entityId: candidate.prospectId,
        event: EVENT_OPENED,
        decision: "defer",
        actor,
        actorKind: "system",
        reason: reason || "This candidate needs a human decision before it can become a prospect.",
        detail: {
          reviewId,
          candidate: {
            prospectId: candidate.prospectId,
            businessName: candidate.businessName,
            tradeCategory: candidate.tradeCategory,
            suburb: candidate.suburb,
            state: candidate.state,
            postcode: candidate.postcode,
            timezone: candidate.timezone,
            phones: (candidate.phones || []).map((p) => ({ raw: p.raw, label: p.label || null })),
            origin: candidate.origin,
          },
          possibleMatches,
          signals,
          // Kept so a reviewer can see what the row claimed without re-reading
          // the file, and so the evidence can be written if they approve it.
          evidenceCount: evidence.length,
          importContext,
        },
      });
    },
  });

  if (outcome.aborted || outcome.replayed) {
    // Aborted: another process opened it while we were reading. Replayed: two
    // processes minted a byte-identical row in the same millisecond and the
    // second was recognised as the same decision. Either way this call did not
    // create it, and saying it did would make an idempotency test pass twice.
    const raced = await loadReviewItem({ store, reviewId });
    return Object.freeze({ ...raced, created: false, message: `Another process opened this for review first; it is waiting since ${raced.openedAt}.` });
  }
  return Object.freeze({ ...(await loadReviewItem({ store, reviewId })), created: true, message: `Opened for review.` });
}

/** Fold one item's rows into its current state. */
function foldItem(rows) {
  const opened = rows.find((r) => r.event === EVENT_OPENED);
  if (!opened) return null;
  const resolutions = rows.filter((r) => r.event === EVENT_RESOLVED);
  // The NEWEST resolving decision wins; earlier ones remain readable above it.
  const resolving = resolutions.filter((r) => r.detail && RESOLVING.includes(r.detail.reviewDecision));
  const last = resolving[resolutions.length - 1] || resolving[resolving.length - 1] || null;

  return Object.freeze({
    reviewId: opened.detail.reviewId,
    prospectId: opened.entityId,
    candidate: opened.detail.candidate,
    possibleMatches: opened.detail.possibleMatches || [],
    signals: opened.detail.signals || [],
    reason: opened.reason,
    importContext: opened.detail.importContext || null,
    openedAt: opened.recordedAt,
    status: last ? STATUS.RESOLVED : STATUS.OPEN,
    decision: last ? last.detail.reviewDecision : null,
    decidedBy: last ? last.actor : null,
    decisionReason: last ? last.reason : null,
    resolvedAt: last ? last.recordedAt : null,
    mergeTarget: last && last.detail ? last.detail.mergeTarget || null : null,
    // Every note ever added, including NEEDS_MORE_INFORMATION, oldest first.
    history: Object.freeze(
      rows.map((r) => Object.freeze({ event: r.event, decision: r.detail && r.detail.reviewDecision ? r.detail.reviewDecision : r.decision, actor: r.actor, reason: r.reason, at: r.recordedAt }))
    ),
  });
}

async function loadReviewItem({ store, reviewId }) {
  assertStoreContract(store, "review store");
  const prospectId = String(reviewId || "").replace(/^rv_/, "");
  const rows = await store.listDecisions({ entityType: ENTITY_TYPE, entityId: prospectId });
  const reviewRows = rows.filter((r) => r.event === EVENT_OPENED || r.event === EVENT_RESOLVED);
  if (reviewRows.length === 0) return null;
  return foldItem(reviewRows);
}

/**
 * Every review item, newest first, optionally filtered by status.
 *
 * Reads the whole decision log and folds by entity. Fine at pilot volume and
 * honestly noted as such: a queue with tens of thousands of items would want
 * the fold materialised.
 */
async function listReviewItems({ store, status = null, limit = 500 } = {}) {
  assertStoreContract(store, "review store");
  const rows = await store.listDecisions({ entityType: ENTITY_TYPE, limit: 5000 });
  const byEntity = new Map();
  for (const r of rows) {
    if (r.event !== EVENT_OPENED && r.event !== EVENT_RESOLVED) continue;
    if (!byEntity.has(r.entityId)) byEntity.set(r.entityId, []);
    byEntity.get(r.entityId).push(r);
  }
  const items = [...byEntity.values()].map(foldItem).filter(Boolean);
  const filtered = status === null ? items : items.filter((i) => i.status === status);
  return Object.freeze(filtered.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt))).slice(0, limit));
}

/**
 * Record a human decision.
 *
 * REFUSES A STALE RESOLUTION. An item already decided is not re-decided by a
 * second operator working from a list they loaded ten minutes ago. The refusal
 * names who decided it and when, so the second operator knows what happened
 * rather than wondering why their command did nothing.
 *
 * NEEDS_MORE_INFORMATION appends a note and leaves the item OPEN, which is what
 * "I looked and I still cannot tell" should do.
 */
async function resolveReviewItem({ store, reviewId, decision, actor, reason, mergeTarget = null, now, detail = null } = {}) {
  if (typeof now !== "function") throw new Error("resolveReviewItem requires an injected now().");
  assertStoreContract(store, "review store");

  if (!Object.values(REVIEW_DECISIONS).includes(decision)) {
    return { ok: false, code: "decision_unknown", message: `"${String(decision).slice(0, 40)}" is not a review decision. Use one of: ${Object.values(REVIEW_DECISIONS).join(", ")}.` };
  }
  const who = typeof actor === "string" ? actor.trim() : "";
  if (!who) return { ok: false, code: "actor_required", message: "A review decision has to name the person making it." };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) return { ok: false, code: "reason_required", message: "A review decision has to say why, in a sentence somebody can read later." };

  const item = await loadReviewItem({ store, reviewId });
  if (!item) return { ok: false, code: "review_not_found", message: `There is no review item "${String(reviewId).slice(0, 60)}".` };
  if (item.status === STATUS.RESOLVED) {
    return { ok: false, code: "already_resolved", message: `"${reviewId}" was already decided by ${item.decidedBy} on ${item.resolvedAt}: ${item.decision}. Nothing was changed.` };
  }
  if (decision === REVIEW_DECISIONS.MERGE_INTO_EXISTING && !mergeTarget) {
    return { ok: false, code: "merge_target_required", message: "A merge has to name the prospect it merges into." };
  }

  // ── THE STALE-RESOLUTION CHECK, RE-RUN AFTER LOSING A RACE ────────
  // The check above ran before the append. If another operator's resolution
  // landed in between, appending ours would record a second human decision on
  // an item that was already decided — the exact thing `already_resolved`
  // exists to prevent, arriving through the door the pre-check does not cover.
  // So it is asked again on every retry, against the state that beat us.
  let raced = null;
  let recorded = null;

  let outcome;
  try {
    outcome = await appendDecisionSerialised({
      store,
      now,
      mint: async ({ log, attempt }) => {
        if (attempt > 1) {
          const fresh = await loadReviewItem({ store, reviewId });
          if (fresh && fresh.status === STATUS.RESOLVED) {
            raced = fresh;
            return null;
          }
        }
        recorded = log.record({
          entityType: ENTITY_TYPE,
          entityId: item.prospectId,
          event: EVENT_RESOLVED,
          decision: LOG_DECISION[decision],
          actor: who,
          // A REVIEW DECISION IS A HUMAN ONE. The whole point of this queue is
          // that the ambiguous cases are not decided by the classifier.
          actorKind: "human",
          reason: why,
          detail: { reviewId: item.reviewId, reviewDecision: decision, mergeTarget, ...(detail || {}) },
        });
        return recorded;
      },
    });
  } catch (err) {
    if (err instanceof ChainContentionError) {
      // Reported as a failure, never as a resolution. Nothing was written.
      return { ok: false, code: "chain_contention", message: `The decision log was too busy to record this after ${err.attempts} attempts. Nothing was changed and the item is still open. Try again.` };
    }
    throw err;
  }

  if (outcome.aborted) {
    return { ok: false, code: "already_resolved", message: `"${reviewId}" was decided by ${raced.decidedBy} on ${raced.resolvedAt}: ${raced.decision}, while this decision was being recorded. Nothing was changed.` };
  }

  return { ok: true, item: await loadReviewItem({ store, reviewId }), recorded: outcome.decision || recorded };
}

module.exports = {
  openReviewItem,
  listReviewItems,
  loadReviewItem,
  resolveReviewItem,
  hydratedLog,
  reviewIdFor,
  REVIEW_DECISIONS,
  RESOLVING,
  STATUS,
  ENTITY_TYPE,
  EVENT_OPENED,
  EVENT_RESOLVED,
};
