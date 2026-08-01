// LOCKSMITH ACQUISITION A1 — human review of source and context.
//
// This is the step that makes the engine a controlled pipeline rather than a
// scrape-and-blast system. These tests are about what a reviewer CANNOT do:
// approve a record that does not support approval, approve without being a
// named person, or have a decision take effect that was never audited.

const { describe, it } = require("node:test");
const assert = require("node:assert");

require("../src/services/acquisition-discovery-fixture");
const { discoverProspects } = require("../src/services/acquisition-discovery");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createAuditLog } = require("../src/services/acquisition-audit");
const review = require("../src/services/acquisition-review");

const FIXED = new Date("2026-08-01T00:00:00.000Z");
const now = () => FIXED;
const ON = { ACQUISITION_ENABLED: "true", ACQUISITION_REVIEW_ENABLED: "true" };

/** Discover the named fixture business and queue it for review. */
function pending(name, { audit = null } = {}) {
  const ledger = createEvidenceLedger({ now });
  const result = discoverProspects({ now, ledger, capturedBy: "test", env: ON, query: { names: [name] } });
  const prospect = result.prospects[0];
  const evidenceRows = ledger.currentForProspect(prospect.prospectId);
  const queued = review.queueForReview(prospect, { evidenceRows, actor: "system", now, audit, env: ON });
  return { prospect: queued.prospect, evidenceRows, ledger, queued };
}

const CLEAN = "Northside Lock & Key";
const AGGREGATOR_PHONE = "Bayside Emergency Locksmiths";
const NO_OFFICIAL = "Yarra Valley Security Services";
const NO_PHONE = "Werribee Locks & Alarms";

describe("queueing for review", () => {
  it("is off unless review is switched on", () => {
    const ledger = createEvidenceLedger({ now });
    const result = discoverProspects({ now, ledger, env: ON, query: { names: [CLEAN] } });
    const p = result.prospects[0];
    const rows = ledger.forProspect(p.prospectId);
    assert.strictEqual(review.queueForReview(p, { evidenceRows: rows, now, env: {} }).code, "acquisition_disabled");
    assert.strictEqual(review.queueForReview(p, { evidenceRows: rows, now, env: { ACQUISITION_ENABLED: "true" } }).code, "review_disabled");
  });

  it("refuses to queue a prospect with no evidence — reviewer attention is scarce", () => {
    const ledger = createEvidenceLedger({ now });
    const p = discoverProspects({ now, ledger, env: ON, query: { names: [CLEAN] } }).prospects[0];
    const result = review.queueForReview(p, { evidenceRows: [], now, env: ON });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "no_evidence");
  });

  it("walks the prospect through evidence_captured on the way", () => {
    const { prospect, queued } = pending(CLEAN);
    assert.strictEqual(queued.ok, true);
    assert.strictEqual(prospect.lifecycle, "review_pending");
    assert.deepStrictEqual(
      prospect.history.map((h) => h.to),
      ["evidence_captured", "review_pending"]
    );
  });

  it("records the queueing in the decision log", () => {
    const audit = createAuditLog({ now });
    pending(CLEAN, { audit });
    const rows = audit.all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event, "queued_for_review");
    assert.strictEqual(rows[0].actorKind, "system");
  });
});

describe("the review packet", () => {
  it("shows the weaknesses, not just a confident summary", () => {
    const { prospect, evidenceRows } = pending(AGGREGATOR_PHONE);
    const packet = review.buildReviewPacket(prospect, evidenceRows);
    assert.ok(packet.blockers.length > 0);
    assert.ok(packet.blockers.some((b) => /third-party listing/.test(b)));
    // The blockers appear before the claims in the packet's own key order.
    const keys = Object.keys(packet);
    assert.ok(keys.indexOf("blockers") < keys.indexOf("claims"), "weaknesses come first");
  });

  it("ties every claim to the source that published it", () => {
    const { prospect, evidenceRows } = pending(AGGREGATOR_PHONE);
    const packet = review.buildReviewPacket(prospect, evidenceRows);
    const phone = packet.claims.find((c) => c.kind === "phone");
    assert.strictEqual(phone.sources[0].official, false);
    assert.strictEqual(phone.sources[0].sourceType, "aggregator");
    const name = packet.claims.find((c) => c.kind === "business_name");
    assert.strictEqual(name.sources[0].official, true);
  });

  it("asks questions rather than presenting ticked boxes", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const packet = review.buildReviewPacket(prospect, evidenceRows);
    assert.ok(packet.questions.length >= 5);
    for (const q of packet.questions) {
      assert.match(q.question, /\?$/, `"${q.question}" should be a question and nothing else`);
      assert.ok(!/\btick\b|\bverified\b|\bconfirmed:\s*yes/i.test(q.question), "questions must not assert the answer");
    }
  });

  it("keeps the context a reviewer needs separate from the question itself", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const packet = review.buildReviewPacket(prospect, evidenceRows);
    const sourceQuestion = packet.questions.find((q) => q.code === "does_the_source_support_it");
    assert.match(sourceQuestion.context, /government business register/i);
    const phoneQuestion = packet.questions.find((q) => q.code === "is_the_phone_theirs");
    assert.match(phoneQuestion.context, /5550 1042/);
  });

  it("says out loud when nothing was verified by a human", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const packet = review.buildReviewPacket(prospect, evidenceRows);
    assert.strictEqual(packet.humanVerifiedEvidence, false, "fixture evidence is never human-verified");
  });

  it("offers approval only when the record can support it", () => {
    assert.strictEqual(review.buildReviewPacket(...Object.values(pick(pending(CLEAN)))).canApprove, true);
    for (const name of [AGGREGATOR_PHONE, NO_OFFICIAL, NO_PHONE]) {
      const packet = review.buildReviewPacket(...Object.values(pick(pending(name))));
      assert.strictEqual(packet.canApprove, false, `${name} must not be approvable`);
      assert.ok(packet.cannotApproveReason, `${name} must say why not`);
    }
  });

  it("always allows rejection — a reviewer is never stuck with a record", () => {
    for (const name of [CLEAN, AGGREGATOR_PHONE, NO_OFFICIAL, NO_PHONE]) {
      assert.strictEqual(review.buildReviewPacket(...Object.values(pick(pending(name)))).canReject, true);
    }
  });

  it("is a pure view — building it changes nothing", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    review.buildReviewPacket(prospect, evidenceRows);
    review.buildReviewPacket(prospect, evidenceRows);
    assert.strictEqual(prospect.lifecycle, "review_pending");
  });
});

function pick({ prospect, evidenceRows }) {
  return { prospect, evidenceRows };
}

describe("recording a decision", () => {
  const base = { reviewer: "Peter", reason: "Checked the site and the ABR entry.", now, env: ON };

  it("approves a clean prospect", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const audit = createAuditLog({ now });
    const result = review.recordReviewDecision(prospect, { ...base, decision: "approve", evidenceRows, audit });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.prospect.lifecycle, "review_approved");
  });

  it("REFUSES to approve a prospect the packet would not offer, even if asked directly", () => {
    for (const name of [AGGREGATOR_PHONE, NO_OFFICIAL, NO_PHONE]) {
      const { prospect, evidenceRows } = pending(name);
      const result = review.recordReviewDecision(prospect, { ...base, decision: "approve", evidenceRows });
      assert.strictEqual(result.ok, false, `${name} must not be approvable by direct call`);
      assert.strictEqual(result.code, "not_approvable");
      assert.ok(result.gaps.length > 0);
    }
  });

  it("re-checks against current evidence, not against a stale packet", () => {
    // A caller who passes NO evidence rows cannot approve, even though the
    // prospect itself is the clean one.
    const { prospect } = pending(CLEAN);
    const result = review.recordReviewDecision(prospect, { ...base, decision: "approve", evidenceRows: [] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "not_approvable");
  });

  it("insists the reviewer is a named person, not the system", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    for (const who of ["system", "AIDA", "automation", "bot", "auto"]) {
      const result = review.recordReviewDecision(prospect, { ...base, reviewer: who, decision: "approve", evidenceRows });
      assert.strictEqual(result.code, "reviewer_not_human", `"${who}" must not be able to approve`);
    }
    assert.strictEqual(review.recordReviewDecision(prospect, { ...base, reviewer: "  ", decision: "approve", evidenceRows }).code, "reviewer_missing");
  });

  it("insists on a reason", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    assert.strictEqual(review.recordReviewDecision(prospect, { ...base, reason: "   ", decision: "approve", evidenceRows }).code, "reason_missing");
  });

  it("a rejection needs a reason CODE, not just free text", () => {
    const { prospect, evidenceRows } = pending(NO_OFFICIAL);
    assert.strictEqual(review.recordReviewDecision(prospect, { ...base, decision: "reject", evidenceRows }).code, "rejection_reason_required");
    assert.strictEqual(review.recordReviewDecision(prospect, { ...base, decision: "reject", rejectionReason: "dunno", evidenceRows }).code, "rejection_reason_required");

    const ok = review.recordReviewDecision(prospect, { ...base, decision: "reject", rejectionReason: "source_not_official", evidenceRows });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.prospect.lifecycle, "review_rejected");
  });

  it("\"needs more evidence\" leaves the prospect waiting rather than inventing a state", () => {
    const { prospect, evidenceRows } = pending(AGGREGATOR_PHONE);
    const audit = createAuditLog({ now });
    const result = review.recordReviewDecision(prospect, { ...base, decision: "needs_more_evidence", evidenceRows, audit });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.prospect.lifecycle, "review_pending");
    assert.strictEqual(audit.all()[0].event, "review_needs_more_evidence");
  });

  it("refuses to decide on a prospect that is not waiting for review", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const approved = review.recordReviewDecision(prospect, { ...base, decision: "approve", evidenceRows }).prospect;
    const again = review.recordReviewDecision(approved, { ...base, decision: "approve", evidenceRows });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.code, "not_awaiting_review");
  });

  it("refuses a decision it does not understand", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    assert.strictEqual(review.recordReviewDecision(prospect, { ...base, decision: "maybe", evidenceRows }).code, "decision_unknown");
  });

  it("is off unless review is switched on", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    assert.strictEqual(review.recordReviewDecision(prospect, { ...base, decision: "approve", evidenceRows, env: {} }).code, "acquisition_disabled");
  });
});

describe("no decision without a record of it", () => {
  it("audits an approval before it takes effect, marked as a human decision", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const audit = createAuditLog({ now });
    review.recordReviewDecision(prospect, { reviewer: "Peter", reason: "Verified.", decision: "approve", evidenceRows, audit, now, env: ON });

    const rows = audit.forEntity("prospect", prospect.prospectId);
    const approval = rows.find((r) => r.event === "review_approved");
    assert.ok(approval, "the approval must be in the decision log");
    assert.strictEqual(approval.decision, "approve");
    assert.strictEqual(approval.actor, "Peter");
    assert.strictEqual(approval.actorKind, "human");
    assert.strictEqual(approval.detail.officialSourceType, "government_register");
    assert.strictEqual(audit.verifyChain().ok, true);
  });

  it("if the audit write fails, the approval does not happen", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const brokenAudit = createAuditLog({
      now,
      sink: () => {
        throw new Error("audit store down");
      },
    });
    assert.throws(
      () => review.recordReviewDecision(prospect, { reviewer: "Peter", reason: "Verified.", decision: "approve", evidenceRows, audit: brokenAudit, now, env: ON }),
      /audit store down/
    );
    // The prospect the caller holds is unchanged — the transition never ran.
    assert.strictEqual(prospect.lifecycle, "review_pending");
    assert.strictEqual(brokenAudit.count(), 0);
  });

  it("records the rejection reason code in the log for later analysis", () => {
    const { prospect, evidenceRows } = pending(NO_OFFICIAL);
    const audit = createAuditLog({ now });
    review.recordReviewDecision(prospect, { reviewer: "Peter", reason: "Directory listings only.", decision: "reject", rejectionReason: "source_not_official", evidenceRows, audit, now, env: ON });
    const row = audit.all().find((r) => r.event === "review_rejected");
    assert.strictEqual(row.detail.rejectionReason, "source_not_official");
    assert.strictEqual(row.actorKind, "human");
  });
});

describe("review does not make a prospect callable", () => {
  it("approval only reaches review_approved — never a callable state", () => {
    const { prospect, evidenceRows } = pending(CLEAN);
    const result = review.recordReviewDecision(prospect, { reviewer: "Peter", reason: "Verified.", decision: "approve", evidenceRows, now, env: ON });
    assert.strictEqual(result.prospect.lifecycle, "review_approved");
    const S = require("../src/services/acquisition-schema");
    assert.ok(!S.PROSPECT_STATES.includes("callable"), "there is no callable prospect state — calling is decided per batch");
  });
});
