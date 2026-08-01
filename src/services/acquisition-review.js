// AIDA Locksmith Acquisition — human review of source and context (A1).
//
//   buildReviewPacket(prospect, evidence)      what a human is shown
//   queueForReview(prospect, ctx)              evidence_captured → review_pending
//   recordReviewDecision(prospect, decision)   the human's answer, audited
//
// The pipeline's fourth step is "source and context human-reviewed". This is
// the step that makes the whole thing a controlled pipeline rather than a
// scrape-and-blast system, so it is written to be difficult to do carelessly:
//
//  1. THE PACKET SHOWS THE WEAKNESSES FIRST. Gaps and source caveats are not
//     buried below a confident-looking summary. A reviewer skimming the top of
//     the packet sees what we do NOT know before they see what we do.
//
//  2. APPROVAL IS NOT OFFERED WHEN THE RECORD CANNOT SUPPORT IT. If required
//     evidence is missing or no official source exists, `canApprove` is false
//     and the reason is stated. A UI built on this cannot render an approve
//     button it should not render.
//
//  3. APPROVAL IS ALSO REFUSED, NOT ONLY UNOFFERED. recordReviewDecision
//     re-checks the same conditions and returns an error if asked to approve an
//     unapprovable prospect. The two checks are deliberate duplication: a UI
//     bug, a stale packet, or a direct API call all hit the same wall. This is
//     the same "the runtime gate re-does the work" redundancy the compliance
//     engine uses, for the same reason.
//
//  4. EVERY DECISION IS AUDITED BEFORE IT TAKES EFFECT. The audit write happens
//     first; if it throws, the transition does not happen. No decision without
//     a record of it.
//
// Reviewing does NOT make a prospect callable. It makes it eligible to be
// ASSESSED for calling — the wash, suppression and calling-policy gates in A2
// all still apply, and the founder still has to approve a batch after that.
//
// Pure + dep-free. See test/acquisition-review.test.js.

const S = require("./acquisition-schema");
const { acquisitionReady } = require("../config/acquisition");
const { assessProspect, transitionProspect } = require("./acquisition-prospect");
const { describeSources } = require("./acquisition-source");

const MAX_TEXT = 1000;

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Assemble everything a human needs to decide, and nothing they do not.
 *
 * The packet is a VIEW: it makes no decisions and changes nothing. It can be
 * rebuilt at any time from the prospect plus its evidence.
 */
function buildReviewPacket(prospect, evidenceRows = []) {
  const assessment = assessProspect(prospect, evidenceRows);
  const sources = assessment.sources;

  // What we are claiming about this business, each tied to the source that
  // published it. A claim with no evidence row behind it is shown as
  // unevidenced rather than omitted — an unevidenced claim is the thing a
  // reviewer most needs to notice.
  const evidenceByKind = new Map();
  for (const row of evidenceRows) {
    if (!evidenceByKind.has(row.kind)) evidenceByKind.set(row.kind, []);
    evidenceByKind.get(row.kind).push(row);
  }

  const claims = [];
  const addClaim = (kind, value) => {
    if (!value) return;
    const rows = evidenceByKind.get(kind) || [];
    claims.push({
      kind,
      label: S.EVIDENCE_KIND_LABELS[kind],
      value,
      evidenced: rows.length > 0,
      sources: rows.map((r) => ({
        sourceType: r.source.sourceType,
        typeLabel: S.SOURCE_TYPE_LABELS[r.source.sourceType],
        official: r.source.official,
        label: r.source.label,
        url: r.source.url,
        observedAt: r.observedAt,
        captureMode: r.captureMode,
        authoritative: r.authoritative,
        caveats: r.source.caveats,
      })),
    });
  };

  addClaim("business_name", prospect.businessName);
  addClaim("legal_name", prospect.legalName);
  addClaim("abn", prospect.abn);
  addClaim("trade_category", prospect.tradeCategory);
  addClaim("address", [prospect.suburb, prospect.state, prospect.postcode].filter(Boolean).join(" ") || prospect.region);
  for (const phone of prospect.phones) addClaim("phone", phone.raw);

  // The questions this reviewer is actually being asked. Phrased as questions,
  // not as checkboxes, because a reviewer who is asked "is this a locksmith?"
  // checks; one shown a ticked box labelled "verified" agrees.
  // `question` is the question and nothing else; anything the reviewer needs in
  // order to answer it goes in `context`. Keeping them separate means a UI can
  // render the question prominently and the context beneath it, rather than
  // showing one long sentence that is easy to skim past.
  const questions = [
    { code: "is_this_a_real_business", question: "Is this a real, currently trading business?", context: null },
    { code: "is_this_a_locksmith", question: "Is it actually a locksmith, rather than a lead-generation or referral page?", context: prospect.tradeCategory ? `Recorded as: ${prospect.tradeCategory}.` : "No trade category was captured." },
    { code: "does_the_source_support_it", question: "Does the source we hold genuinely support that?", context: describeSources(sources) },
    { code: "is_the_phone_theirs", question: "Is the phone number published by the business itself, and current?", context: prospect.phones.length ? prospect.phones.map((p) => p.raw).join(", ") : "No phone number was captured." },
    { code: "is_it_in_region", question: "Is it in the pilot region?", context: `Recorded as ${prospect.suburb || "an unknown suburb"}, ${prospect.state || "unknown state"}.` },
  ];

  // Whether approval may be offered at all, and why not when it may not.
  const blockers = assessment.gaps.map((g) => g.message);
  const canApprove = assessment.reviewable && prospect.lifecycle === "review_pending";
  let cannotApproveReason = null;
  if (!assessment.reviewable) {
    cannotApproveReason = "This record is not complete enough to approve. Fix or reject it.";
  } else if (prospect.lifecycle !== "review_pending") {
    cannotApproveReason = `This prospect is not waiting for review — it is "${S.PROSPECT_STATE_LABELS[prospect.lifecycle]}".`;
  }

  return Object.freeze({
    prospectId: prospect.prospectId,
    businessName: prospect.businessName,
    lifecycle: prospect.lifecycle,
    lifecycleLabel: S.PROSPECT_STATE_LABELS[prospect.lifecycle],

    // Deliberately first in the object: the weaknesses.
    blockers: Object.freeze(blockers),
    sourceCaveats: sources.caveats,
    unusableSources: sources.unusable,
    unevidencedClaims: Object.freeze(claims.filter((c) => !c.evidenced).map((c) => c.label)),

    sourceSummary: describeSources(sources),
    hasOfficialSource: sources.hasOfficialSource,
    strongestSourceType: sources.strongestType,

    claims: Object.freeze(claims),
    questions: Object.freeze(questions),

    evidenceCount: evidenceRows.length,
    humanVerifiedEvidence: assessment.evidence.humanVerified,

    canApprove,
    cannotApproveReason,
    // Rejecting is always available. A reviewer must never be stuck with a
    // record they cannot dispose of.
    canReject: prospect.lifecycle === "review_pending",
    rejectionReasons: S.REVIEW_REJECTION_REASONS.map((code) => ({ code, label: S.REVIEW_REJECTION_LABELS[code] })),
  });
}

/**
 * Move a prospect into the review queue. Evidence must already be attached —
 * queueing an empty record wastes a reviewer's attention, which is the scarcest
 * resource in this pipeline.
 */
function queueForReview(prospect, { evidenceRows = [], actor, now, audit, env = process.env } = {}) {
  const gate = acquisitionReady("review", env);
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.message };

  if (evidenceRows.length === 0) {
    return { ok: false, code: "no_evidence", message: "This prospect has no evidence attached, so there is nothing to review." };
  }

  // discovered → evidence_captured happens first if it has not already.
  let current = prospect;
  if (current.lifecycle === "discovered") {
    const stepped = transitionProspect(current, "evidence_captured", {
      actor: actor || "system",
      reason: `${evidenceRows.length} pieces of evidence captured.`,
      now,
    });
    if (!stepped.ok) return stepped;
    current = stepped.prospect;
  }

  const queued = transitionProspect(current, "review_pending", {
    actor: actor || "system",
    reason: "Queued for human review of source and context.",
    now,
  });
  if (!queued.ok) return queued;

  if (audit) {
    audit.record({
      entityType: "prospect",
      entityId: current.prospectId,
      event: "queued_for_review",
      decision: "record",
      actor: actor || "system",
      actorKind: "system",
      reason: "Evidence captured; awaiting human review of source and context.",
      detail: { evidenceCount: evidenceRows.length },
    });
  }

  return { ok: true, prospect: queued.prospect };
}

/**
 * Record a human's review decision.
 *
 * @param {object} prospect
 * @param {object} input
 * @param {string} input.decision   one of REVIEW_DECISIONS
 * @param {string} input.reviewer   the human's identity — required, always
 * @param {string} input.reason     free text — required, always
 * @param {string} [input.rejectionReason] a REVIEW_REJECTION_REASONS code, required to reject
 * @param {Array}  [input.evidenceRows]    used to re-check approvability
 * @param {object} [input.audit]    the append-only decision log
 * @param {function} input.now
 *
 * Returns { ok:true, prospect, packet } or { ok:false, code, message }.
 */
function recordReviewDecision(prospect, { decision, reviewer, reason, rejectionReason = null, evidenceRows = [], audit = null, now, env = process.env } = {}) {
  const gate = acquisitionReady("review", env);
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.message };

  if (!S.REVIEW_DECISIONS.includes(decision)) {
    return { ok: false, code: "decision_unknown", message: `"${String(decision).slice(0, 40)}" is not a review decision.` };
  }

  // A named human. Not "the system", not a blank string — the whole point of
  // this step is that a person put their name to it.
  const who = clip(reviewer, 120);
  if (!who) return { ok: false, code: "reviewer_missing", message: "A review has to record which person made it." };
  if (/^(system|automation|auto|aida|bot)$/i.test(who)) {
    return { ok: false, code: "reviewer_not_human", message: "Review is a human step. \"" + who + "\" is not a person." };
  }

  const why = clip(reason, MAX_TEXT);
  if (!why) return { ok: false, code: "reason_missing", message: "A review has to record the reviewer's reasoning." };

  if (prospect.lifecycle !== "review_pending") {
    return {
      ok: false,
      code: "not_awaiting_review",
      message: `This prospect is not waiting for review — it is "${S.PROSPECT_STATE_LABELS[prospect.lifecycle] || prospect.lifecycle}".`,
    };
  }

  if (typeof now !== "function") return { ok: false, code: "clock_missing", message: "recordReviewDecision requires an injected now()." };

  // "needs_more_evidence" is not a state change — it is a note that leaves the
  // prospect exactly where it is, waiting. Modelling it as a transition would
  // mean inventing a state whose only purpose is to be transitioned out of.
  if (decision === "needs_more_evidence") {
    if (audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId,
        event: "review_needs_more_evidence",
        decision: "record",
        actor: who,
        actorKind: "human",
        reason: why,
      });
    }
    return { ok: true, prospect, packet: buildReviewPacket(prospect, evidenceRows) };
  }

  if (decision === "reject") {
    if (!S.REVIEW_REJECTION_REASONS.includes(rejectionReason)) {
      return {
        ok: false,
        code: "rejection_reason_required",
        message: "A rejection has to carry a reason code so the dataset can be improved, not just free text.",
      };
    }
    // Audit BEFORE the transition: no decision without a record of it.
    if (audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId,
        event: "review_rejected",
        decision: "reject",
        actor: who,
        actorKind: "human",
        reason: why,
        detail: { rejectionReason, rejectionLabel: S.REVIEW_REJECTION_LABELS[rejectionReason] },
      });
    }
    const moved = transitionProspect(prospect, "review_rejected", { actor: who, reason: `${S.REVIEW_REJECTION_LABELS[rejectionReason]}: ${why}`, now });
    if (!moved.ok) return moved;
    return { ok: true, prospect: moved.prospect, packet: buildReviewPacket(moved.prospect, evidenceRows) };
  }

  // decision === "approve" — the consequential one.
  //
  // Re-check approvability against the CURRENT evidence rather than trusting
  // the packet the reviewer was looking at. A packet can be stale; a direct
  // call can skip the packet entirely.
  const assessment = assessProspect(prospect, evidenceRows);
  if (!assessment.reviewable) {
    return {
      ok: false,
      code: "not_approvable",
      message: "This prospect cannot be approved as it stands: " + assessment.gaps.map((g) => g.message).join(" "),
      gaps: assessment.gaps,
    };
  }

  if (audit) {
    audit.record({
      entityType: "prospect",
      entityId: prospect.prospectId,
      event: "review_approved",
      decision: "approve",
      actor: who,
      actorKind: "human",
      reason: why,
      detail: {
        officialSource: assessment.sources.officialSource ? assessment.sources.officialSource.label : null,
        officialSourceType: assessment.sources.officialSource ? assessment.sources.officialSource.sourceType : null,
        evidenceCount: evidenceRows.length,
        phoneFromOfficialSource: assessment.evidence.phoneFromOfficialSource,
      },
    });
  }

  const moved = transitionProspect(prospect, "review_approved", { actor: who, reason: why, now });
  if (!moved.ok) return moved;

  return { ok: true, prospect: moved.prospect, packet: buildReviewPacket(moved.prospect, evidenceRows) };
}

module.exports = {
  buildReviewPacket,
  queueForReview,
  recordReviewDecision,
};
