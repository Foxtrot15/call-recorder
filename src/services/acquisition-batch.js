// AIDA Locksmith Acquisition — founder batch review and approval (A2).
//
//   assembleBatch({ prospects, evaluate, ... })   a reviewable batch
//   recordFounderAction(batch, action)            approve / reject / suppress / defer / resolve
//   approveBatch(batch, { founder, ... })         the explicit, immutable approval
//   checkApprovalFreshness(approved, current)     has anything changed since?
//   revokeApproval(batch, { actor, reason })      reversible, because nothing has dispatched
//
// The pipeline's eleventh step is "founder explicitly approves a campaign
// batch". This module owns that moment and nothing beyond it.
//
// ── THERE IS NO "START CALLING" ─────────────────────────────────────
// Deliberately. This module has no dispatch function, no dialler reference, no
// scheduler, and no way to reach telephony — a test asserts that its exports
// contain nothing resembling one. The output of approval is a DORMANT approved
// batch: a frozen, hash-bound record that a later dispatch milestone may one
// day read. Approving a batch is a statement of intent, not an action.
//
// ── THE APPROVAL BINDS TO WHAT WAS ACTUALLY SEEN ────────────────────
// A founder approves a specific list of businesses with specific numbers in
// specific eligibility states. The approval therefore carries a hash over
// exactly those facts. If a record changes, a wash expires, a suppression
// arrives, or an eligibility result flips, the hash no longer matches and the
// approval is STALE — it does not silently continue to authorise a list that is
// no longer the list.
//
// That is the difference between "the founder approved this batch" and "the
// founder approved something once and we have been calling ever since".
//
// ── THIS MODULE'S APPROVAL IS IN-PROCESS. E-5 IS THE DURABLE ONE ────
// `approveBatch` here returns an approved batch OBJECT, and
// `checkApprovalFreshness` compares it against a freshly assembled one. Both are
// the FOUNDER'S SCREEN: "you looked at this list ten minutes ago — has anything
// changed since?" `batchHash` covers each row's eligibility for exactly that
// reason, so a wash expiring while the founder reads shows up as a change.
//
// It is NOT what a call is authorised against, and it must not become that. A
// hash that moves whenever the world moves would make every durable approval
// look stale within hours, and a founder asked to re-approve an unchanged list
// daily learns to do it without reading it.
//
// The durable approval lives in acquisition-batch-approval.js. It binds to a
// `membershipHash` over WHO and ON WHAT NUMBER only, it is written to the
// append-only decision log, and it is what acquisition-authorisation reads at
// the final gate. See that file's header for why the two hashes differ.
//
// ── ROWS ARE DOMAIN RESULTS, NOT RECOMPUTED ─────────────────────────
// Every row carries the eligibility decision produced by the eligibility
// engine. A founder UI renders these; it must never re-derive eligibility, or
// there would be two answers to the only question that matters.
//
// Pure + dep-free. See test/acquisition-batch.test.js.

const S = require("./acquisition-schema");
const { contentHash } = require("./acquisition-evidence");
const { duplicateStatusFor } = require("./acquisition-dedupe");

const MAX_TEXT = 500;

function clip(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// What a founder may do to one row. There is deliberately no "call" here.
const FOUNDER_ACTIONS = Object.freeze(["approve_record", "reject_record", "suppress_record", "defer_record", "resolve_duplicate"]);

const FOUNDER_ACTION_LABELS = Object.freeze({
  approve_record: "Include in the batch",
  reject_record: "Reject this record",
  suppress_record: "Never contact this business",
  defer_record: "Leave for later",
  resolve_duplicate: "Record a duplicate decision",
});

// Row dispositions — the founder's standing on each record.
const ROW_DISPOSITIONS = Object.freeze(["pending", "included", "rejected", "suppressed", "deferred"]);

/**
 * The founder-facing categories. Each maps eligibility outcomes onto the
 * question a founder actually asks: "what is stopping this, and is it my
 * problem or the clock's?"
 */
const CATEGORIES = Object.freeze([
  { key: "eligibleNow", label: "Can be called now" },
  { key: "eligibleLater", label: "Blocked only by timing" },
  { key: "duplicatesRemoved", label: "Duplicate records merged away" },
  { key: "duplicatesNeedingReview", label: "Possible duplicates needing your decision" },
  { key: "permanentlySuppressed", label: "Must never be contacted" },
  { key: "dncrBlocked", label: "On the Do Not Call Register" },
  { key: "dncrUnchecked", label: "Not checked against the Do Not Call Register" },
  { key: "timezoneProblem", label: "Missing or unusable timezone" },
  { key: "holidayBlocked", label: "Public holiday, or holiday calendar unknown" },
  { key: "outsideWindow", label: "Outside permitted calling hours" },
  { key: "attemptBlocked", label: "Attempt limit or cooling-off period" },
  { key: "policyBlocked", label: "Waiting on a policy decision" },
  { key: "needsManualReview", label: "Needs your review" },
]);

/** Which category a decision belongs to. One row, one category — the decisive one. */
function categoriseDecision(decision, duplicateStatus) {
  if (decision.eligible) return "eligibleNow";

  const code = decision.code;
  if (code === "suppressed_permanently") return "permanentlySuppressed";
  if (code === "dncr_listed") return "dncrBlocked";
  if (code === "dncr_not_checked" || code === "dncr_wash_stale") return "dncrUnchecked";
  if (code === "duplicate_requires_resolution") return "duplicatesNeedingReview";
  if (code === "duplicate_of_canonical") return "duplicatesRemoved";
  if (code === "record_invalid" || code === "record_not_reviewed" || code === "no_usable_number") return "needsManualReview";
  if (code === "attempt_policy_unapproved" || code === "counsel_approval_missing") return "policyBlocked";
  if (code === "founder_batch_approval_missing") return "eligibleLater";
  // E-5. The approval could not be READ, which is not the same as there not
  // being one. It must not appear under a heading a founder can clear by
  // approving something, because approving again would not fix it.
  if (code === "batch_approval_store_unavailable") return "needsManualReview";
  if (code === "attempt_or_wash_restriction") return "attemptBlocked";
  if (code === "campaign_blocked" || code === "kill_switch_engaged") return "policyBlocked";

  if (code === "outside_calling_policy") {
    const windowCode = (decision.failedChecks.find((f) => f.check === "calling_window") || {}).detail;
    const wc = windowCode ? windowCode.windowCode : null;
    if (wc === "timezone_missing" || wc === "timezone_invalid") return "timezoneProblem";
    if (wc === "public_holiday" || wc === "holiday_coverage_unknown") return "holidayBlocked";
    return "outsideWindow";
  }

  return "needsManualReview";
}

/**
 * Assemble a reviewable batch.
 *
 * @param {Array}    prospects
 * @param {function} evaluate       (prospect, context) => eligibility decision
 * @param {function} [evidenceFor]  (prospectId) => evidence rows
 * @param {object}   [duplicateResolution]
 * @param {function} now
 * @param {string}   [batchId]
 * @param {object}   [context]      extra context passed to evaluate
 */
function assembleBatch({ prospects, evaluate, evidenceFor = () => [], duplicateResolution = null, now, batchId = "batch", context = {}, dispositions = {} } = {}) {
  if (typeof now !== "function") throw new Error("assembleBatch requires an injected now().");
  if (typeof evaluate !== "function") throw new Error("assembleBatch requires an evaluate() function — it must not compute eligibility itself.");

  const list = Array.isArray(prospects) ? prospects : [];

  // Deterministic order so the batch hash cannot depend on input ordering.
  const ordered = [...list].sort((a, b) => (String(a.prospectId) < String(b.prospectId) ? -1 : 1));

  // ROWS NEED THEIR OWN KEY, because prospectId is NOT unique across rows.
  // A1 derives prospectId from the identity fingerprint, so two records for the
  // same business in the same suburb share one. Keying founder actions by
  // prospectId meant "reject this row" silently rejected every row that shared
  // the id — including a different, still-good record for the same business.
  // Counted up front so that when a prospectId collides, EVERY one of its rows
  // is suffixed — never just the second onward. If the first row kept the bare
  // id, that id would be both a valid rowId and an ambiguous prospectId, and
  // the ambiguity guard below would have to refuse a legitimate target.
  const occurrences = new Map();
  for (const p of ordered) occurrences.set(p.prospectId, (occurrences.get(p.prospectId) || 0) + 1);

  const seen = new Map();
  const rowIdFor = (prospectId) => {
    if ((occurrences.get(prospectId) || 0) === 1) return prospectId;
    const n = (seen.get(prospectId) || 0) + 1;
    seen.set(prospectId, n);
    return `${prospectId}#${n}`;
  };

  const rows = ordered.map((prospect) => {
    const rowId = rowIdFor(prospect.prospectId);
    const evidenceRows = evidenceFor(prospect.prospectId) || [];
    const decision = evaluate(prospect, { ...context, evidenceRows, duplicateResolution });
    const duplicate = duplicateStatusFor(prospect.prospectId, duplicateResolution);
    const declared = dispositions[rowId] !== undefined ? dispositions[rowId] : dispositions[prospect.prospectId];
    const disposition = ROW_DISPOSITIONS.includes(declared) ? declared : "pending";

    return Object.freeze({
      rowId,
      prospectId: prospect.prospectId,
      businessName: prospect.businessName,
      suburb: prospect.suburb,
      state: prospect.state,

      canonicalNumber: decision.canonicalNumber,

      // Provenance travels with the row so a founder never has to go looking.
      provenance: decision.provenance,
      sourceRefs: prospect.sourceRefs,
      evidenceCount: evidenceRows.length,

      eligible: decision.eligible,
      code: decision.code,
      decisiveReason: decision.message,
      decisiveCheck: decision.decisiveCheck,
      temporary: decision.temporary,
      failedChecks: decision.failedChecks,
      passedChecks: decision.passedChecks,
      nextEligibleAt: decision.nextEligibleAt,
      requiredFounderAction: decision.requiredFounderAction,
      localTime: decision.localTime,

      duplicate: duplicate.blocked || duplicate.requiresReview ? duplicate : null,

      category: categoriseDecision(decision, duplicate),
      disposition,
    });
  });

  const summary = summarise(rows);

  return Object.freeze({
    batchId,
    schemaVersion: S.SCHEMA_VERSION,
    state: "draft",
    assembledAt: now().toISOString(),
    rows: Object.freeze(rows),
    summary,
    duplicateStats: duplicateResolution ? duplicateResolution.stats : null,
    // The identity of exactly what a founder would be approving.
    batchHash: hashBatch(rows),
    approval: null,
  });
}

/** Category totals plus the headline numbers a founder reads first. */
function summarise(rows) {
  const counts = {};
  for (const category of CATEGORIES) counts[category.key] = 0;

  for (const row of rows) {
    // A row the founder has already disposed of is counted as that, not as its
    // eligibility category — otherwise a rejected record keeps appearing in the
    // "needs your review" pile it was just cleared out of.
    if (row.disposition === "rejected" || row.disposition === "suppressed" || row.disposition === "deferred") continue;
    if (row.eligible && row.disposition !== "included") counts.eligibleNow += 1;
    else if (row.disposition === "included") counts.eligibleNow += 1;
    else counts[row.category] = (counts[row.category] || 0) + 1;
  }

  // "Eligible later" = blocked, but every block is temporary and timed.
  counts.eligibleLater = rows.filter(
    (r) => !r.eligible && r.disposition === "pending" && r.temporary === true && r.nextEligibleAt !== null
  ).length;

  return Object.freeze({
    totalDiscovered: rows.length,
    ...counts,
    included: rows.filter((r) => r.disposition === "included").length,
    rejected: rows.filter((r) => r.disposition === "rejected").length,
    suppressed: rows.filter((r) => r.disposition === "suppressed").length,
    deferred: rows.filter((r) => r.disposition === "deferred").length,
    pending: rows.filter((r) => r.disposition === "pending").length,
    categories: Object.freeze(CATEGORIES),
  });
}

/**
 * The hash a founder's approval binds to.
 *
 * Covers WHO would be called, ON WHAT NUMBER, and WHY they were considered
 * callable. Any change to any of those invalidates the approval — which is the
 * entire point. Deliberately excludes assembledAt, so re-assembling the same
 * facts is not spuriously "changed".
 */
function hashBatch(rows) {
  const material = rows
    .filter((r) => r.disposition === "included" || (r.disposition === "pending" && r.eligible))
    .map((r) => ({
      // rowId, not prospectId: two rows can share a prospectId, and sorting a
      // hash's material by a non-unique key makes the hash depend on row order.
      rowId: r.rowId,
      prospectId: r.prospectId,
      canonicalNumber: r.canonicalNumber,
      code: r.code,
      eligible: r.eligible,
      evidenceCount: r.evidenceCount,
      duplicate: r.duplicate ? r.duplicate.code : null,
    }))
    .sort((a, b) => (a.rowId < b.rowId ? -1 : 1));

  return contentHash(material);
}

/**
 * Record a founder decision about one row.
 *
 * Returns a NEW batch — the input is never mutated. Rows are re-summarised and
 * the hash recomputed, so a batch's hash always describes its current contents.
 */
function recordFounderAction(batch, { prospectId, action, actor, reason = null, now, audit = null, duplicateDecision = null } = {}) {
  if (!batch || typeof batch !== "object") return { ok: false, code: "batch_invalid", message: "No batch was given." };
  if (batch.state === "approved") {
    return { ok: false, code: "batch_approved", message: "This batch has already been approved. Withdraw the approval before changing it." };
  }
  if (!FOUNDER_ACTIONS.includes(action)) {
    return { ok: false, code: "action_unknown", message: `"${String(action).slice(0, 40)}" is not something a founder can do to a record.` };
  }

  const who = clip(actor, 120);
  if (!who) return { ok: false, code: "actor_missing", message: "Every founder decision has to record who made it." };
  if (typeof now !== "function") return { ok: false, code: "clock_missing", message: "recordFounderAction requires an injected now()." };

  // AMBIGUITY IS CHECKED FIRST, before any match is attempted.
  //
  // The first of several colliding rows carries the bare prospectId as its
  // rowId, so a rowId lookup would silently resolve to it — which is exactly
  // the guess this must not make. If the id names more than one row's business,
  // refuse and name the rowIds, rather than disposing of a record the founder
  // never looked at.
  const byProspect = batch.rows.filter((r) => r.prospectId === prospectId);
  if (byProspect.length > 1) {
    return {
      ok: false,
      code: "ambiguous_row",
      message: `"${String(prospectId).slice(0, 60)}" matches ${byProspect.length} rows in this batch (${byProspect.map((m) => m.businessName).join(", ")}). Use the rowId to say which one.`,
      rowIds: byProspect.map((m) => m.rowId),
    };
  }

  const row = batch.rows.find((r) => r.rowId === prospectId) || byProspect[0];
  if (!row) return { ok: false, code: "row_not_found", message: `No record with id "${String(prospectId).slice(0, 60)}" is in this batch.` };

  // Rejecting or suppressing a business is a decision that outlives the batch,
  // so it needs a reason on the record.
  if ((action === "reject_record" || action === "suppress_record") && !clip(reason)) {
    return { ok: false, code: "reason_required", message: "Rejecting or suppressing a business has to record why." };
  }

  // A founder cannot include a record the engine says is not callable. The
  // batch is a list of businesses that MAY be called; putting an ineligible one
  // in it would make the approval mean something different from what it says.
  if (action === "approve_record" && !row.eligible) {
    return {
      ok: false,
      code: "row_not_eligible",
      message: `"${row.businessName}" cannot be included: ${row.decisiveReason}`,
    };
  }

  const disposition =
    action === "approve_record" ? "included" :
    action === "reject_record" ? "rejected" :
    action === "suppress_record" ? "suppressed" :
    action === "defer_record" ? "deferred" :
    row.disposition; // resolve_duplicate does not change disposition by itself

  if (audit) {
    audit.record({
      entityType: "batch",
      entityId: batch.batchId,
      event: `founder_${action}`,
      decision: action === "approve_record" ? "approve" : action === "reject_record" || action === "suppress_record" ? "reject" : "record",
      actor: who,
      actorKind: "human",
      reason: clip(reason) || FOUNDER_ACTION_LABELS[action],
      detail: { rowId: row.rowId, prospectId: row.prospectId, businessName: row.businessName, action, duplicateDecision },
      correlationId: batch.batchId,
    });
  }

  const updatedRows = batch.rows.map((r) =>
    r.rowId === row.rowId
      ? Object.freeze({
          ...r,
          disposition,
          founderNote: clip(reason),
          duplicateResolvedAs: action === "resolve_duplicate" ? clip(duplicateDecision, 60) : r.duplicateResolvedAs || null,
          // A resolved duplicate stops blocking; the founder has adjudicated it.
          duplicate: action === "resolve_duplicate" ? null : r.duplicate,
        })
      : r
  );

  return {
    ok: true,
    batch: Object.freeze({
      ...batch,
      rows: Object.freeze(updatedRows),
      summary: summarise(updatedRows),
      batchHash: hashBatch(updatedRows),
    }),
  };
}

/** Move a draft batch to awaiting_approval. */
function submitForApproval(batch, { actor, now, audit = null } = {}) {
  if (!batch) return { ok: false, code: "batch_invalid", message: "No batch was given." };
  if (!S.BATCH_TRANSITIONS[batch.state] || !S.BATCH_TRANSITIONS[batch.state].includes("awaiting_approval")) {
    return { ok: false, code: "transition_not_allowed", message: `A batch that is "${S.BATCH_STATE_LABELS[batch.state] || batch.state}" cannot be submitted for approval.` };
  }
  const who = clip(actor, 120);
  if (!who) return { ok: false, code: "actor_missing", message: "Submitting a batch has to record who did it." };
  if (typeof now !== "function") return { ok: false, code: "clock_missing", message: "submitForApproval requires an injected now()." };

  if (audit) {
    audit.record({
      entityType: "batch",
      entityId: batch.batchId,
      event: "batch_submitted",
      decision: "record",
      actor: who,
      actorKind: "human",
      reason: `Submitted ${batch.summary.included} records for approval.`,
      detail: { batchHash: batch.batchHash, included: batch.summary.included },
      correlationId: batch.batchId,
    });
  }

  return { ok: true, batch: Object.freeze({ ...batch, state: "awaiting_approval", submittedAt: now().toISOString(), submittedBy: who }) };
}

/**
 * The founder's explicit approval of a batch.
 *
 * Refuses unless every included record is genuinely callable and every
 * duplicate has been adjudicated. Records the actor and the timestamp, binds to
 * the batch hash, and writes an audit entry BEFORE the approval takes effect.
 *
 * DOES NOT CALL ANYBODY. Returns a dormant approved batch.
 */
function approveBatch(batch, { founder, now, audit = null, note = null } = {}) {
  if (!batch) return { ok: false, code: "batch_invalid", message: "No batch was given." };
  if (batch.state !== "awaiting_approval") {
    return { ok: false, code: "not_awaiting_approval", message: `This batch is "${S.BATCH_STATE_LABELS[batch.state] || batch.state}", not waiting for approval.` };
  }

  const who = clip(founder, 120);
  if (!who) return { ok: false, code: "founder_missing", message: "A batch approval has to record which person made it." };
  if (/^(system|automation|auto|aida|bot)$/i.test(who)) {
    return { ok: false, code: "approver_not_human", message: `Batch approval is a human decision. "${who}" is not a person.` };
  }
  if (typeof now !== "function") return { ok: false, code: "clock_missing", message: "approveBatch requires an injected now()." };

  const included = batch.rows.filter((r) => r.disposition === "included");
  if (included.length === 0) {
    return { ok: false, code: "batch_empty", message: "There are no records in this batch to approve." };
  }

  // Re-check, rather than trusting the disposition that was set earlier. A row
  // included yesterday may have become ineligible since.
  const notEligible = included.filter((r) => !r.eligible);
  if (notEligible.length > 0) {
    return {
      ok: false,
      code: "included_not_eligible",
      message: `${notEligible.length} record${notEligible.length === 1 ? "" : "s"} in this batch can no longer be called: ${notEligible.map((r) => `${r.businessName} (${r.decisiveReason})`).join("; ")}`,
      rows: notEligible.map((r) => r.prospectId),
    };
  }

  const unresolved = included.filter((r) => r.duplicate && r.duplicate.requiresReview);
  if (unresolved.length > 0) {
    return {
      ok: false,
      code: "unresolved_duplicates",
      message: `${unresolved.length} record${unresolved.length === 1 ? "" : "s"} may be duplicates and have not been decided: ${unresolved.map((r) => r.businessName).join("; ")}. Resolve them before approving.`,
      rows: unresolved.map((r) => r.prospectId),
    };
  }

  const approvedAt = now().toISOString();
  const approval = Object.freeze({
    approvedBy: who,
    approvedAt,
    batchHash: batch.batchHash,
    recordCount: included.length,
    rowIds: Object.freeze(included.map((r) => r.rowId).sort()),
    prospectIds: Object.freeze(included.map((r) => r.prospectId).sort()),
    numbers: Object.freeze(included.map((r) => r.canonicalNumber).sort()),
    note: clip(note),
    // Stated on the artifact itself, so nothing downstream can read an approved
    // batch as an instruction to dial.
    authorises: "Inclusion in a future calling batch. This approval does not place, schedule or trigger any call.",
  });

  // Audit before the approval exists.
  if (audit) {
    audit.record({
      entityType: "batch",
      entityId: batch.batchId,
      event: "batch_approved",
      decision: "approve",
      actor: who,
      actorKind: "human",
      reason: clip(note) || `Approved ${included.length} businesses for a future calling batch.`,
      detail: { batchHash: batch.batchHash, recordCount: included.length, prospectIds: approval.prospectIds },
      correlationId: batch.batchId,
    });
  }

  return {
    ok: true,
    batch: Object.freeze({
      ...batch,
      state: "approved",
      approval,
      // Explicit and asserted by test: approving does not dispatch.
      dispatched: false,
    }),
  };
}

/**
 * Is an approval still good for the current facts?
 *
 * Compares the hash the founder approved against the hash of the batch as it
 * stands now. Any change to who would be called, on what number, or why they
 * were callable makes the approval stale.
 */
function checkApprovalFreshness(approvedBatch, currentBatch) {
  if (!approvedBatch || approvedBatch.state !== "approved" || !approvedBatch.approval) {
    return Object.freeze({ fresh: false, stale: true, code: "not_approved", message: "This batch has not been approved." });
  }
  if (!currentBatch) {
    return Object.freeze({ fresh: false, stale: true, code: "no_current_batch", message: "There is nothing to compare the approval against." });
  }

  if (approvedBatch.approval.batchHash !== currentBatch.batchHash) {
    return Object.freeze({
      fresh: false,
      stale: true,
      code: "batch_changed",
      message:
        "The approval is out of date. The records, their numbers or their eligibility have changed since it was given, so it no longer describes what would be called. Review and approve again.",
      approvedHash: approvedBatch.approval.batchHash,
      currentHash: currentBatch.batchHash,
    });
  }

  return Object.freeze({ fresh: true, stale: false, code: "approval_current", message: `Approved by ${approvedBatch.approval.approvedBy} and still matches the current records.` });
}

/**
 * Withdraw an approval. Always available, because nothing has dispatched —
 * there is no dispatch in this milestone.
 */
function revokeApproval(batch, { actor, reason, now, audit = null } = {}) {
  if (!batch || batch.state !== "approved") {
    return { ok: false, code: "not_approved", message: "This batch is not approved, so there is nothing to withdraw." };
  }
  const who = clip(actor, 120);
  if (!who) return { ok: false, code: "actor_missing", message: "Withdrawing an approval has to record who did it." };
  const why = clip(reason);
  if (!why) return { ok: false, code: "reason_required", message: "Withdrawing an approval has to record why." };
  if (typeof now !== "function") return { ok: false, code: "clock_missing", message: "revokeApproval requires an injected now()." };

  if (audit) {
    audit.record({
      entityType: "batch",
      entityId: batch.batchId,
      event: "batch_approval_revoked",
      decision: "reject",
      actor: who,
      actorKind: "human",
      reason: why,
      detail: { batchHash: batch.approval.batchHash, previouslyApprovedBy: batch.approval.approvedBy },
      correlationId: batch.batchId,
    });
  }

  return {
    ok: true,
    batch: Object.freeze({
      ...batch,
      state: "cancelled",
      // The approval is kept, not deleted — it happened, and the audit trail
      // has to show what was withdrawn as well as that something was.
      revokedApproval: batch.approval,
      approval: null,
      revokedAt: now().toISOString(),
      revokedBy: who,
      revokedReason: why,
    }),
  };
}

module.exports = {
  assembleBatch,
  recordFounderAction,
  submitForApproval,
  approveBatch,
  checkApprovalFreshness,
  revokeApproval,
  summarise,
  hashBatch,
  categoriseDecision,
  FOUNDER_ACTIONS,
  FOUNDER_ACTION_LABELS,
  ROW_DISPOSITIONS,
  CATEGORIES,
};
