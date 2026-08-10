// ============================================================================
// M8L RESTART PROOF — PROCESS A. A human resolves an ambiguity, then EXITS.
//
//   node scripts/dev/acquisition-duplicate-proof/process-a.js
//
// This process creates an ambiguous duplicate, has a named human resolve it, and
// dies. Its heap — the review item, the decision, the resolution object — is
// gone before process B starts.
//
// It resolves TWO candidates, because the two outcomes that matter behave
// differently and B has to see both:
//
//   merged      the canonical business is the only callable identity
//   distinct    the candidate was approved as its own business
//
// and leaves a THIRD unresolved, so B can prove an open question still blocks.
//
// NOTHING HERE CONTACTS ANYBODY.
// ============================================================================

const fs = require("node:fs");
const C = require("./common");
const { openReviewItem, resolveReviewItem, loadReviewItem, REVIEW_DECISIONS, STATUS } = require("../../../src/services/acquisition-review-queue");
const { resolveDuplicateStateForProspect, DUPLICATE_STATE } = require("../../../src/services/acquisition-duplicate-state");
const { canonicalBatchIdentity, recordBatchApproval } = require("../../../src/services/acquisition-batch-approval");
const { verifyRows } = require("../../../src/services/acquisition-audit");
const { createProspect, transitionProspect } = require("../../../src/services/acquisition-prospect");

async function main() {
  console.log("=".repeat(74));
  console.log(`M8L RESTART PROOF — PROCESS A (pid ${process.pid})`);
  console.log("=".repeat(74));
  console.log("");

  C.resetState();
  const store = C.makeStore();

  const canonical = C.canonical();
  const merged = C.candidate();
  const distinct = (() => {
    let p = createProspect({
      businessName: "M8L Distinct Locks",
      tradeCategory: "Locksmith",
      suburb: "Thornbury",
      state: "VIC",
      postcode: "3071",
      region: "Melbourne",
      timezone: "Australia/Melbourne",
      phones: [{ raw: "(03) 5550 1088" }],
      sourceRefs: [{ url: "https://m8l-duplicate-probe.example.com.au/contact" }],
      origin: "fixture",
      discoveredAt: "2026-07-15T02:00:00.000Z",
    }).prospect;
    for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
      p = transitionProspect(p, to, { actor: C.FOUNDER, reason: "M8L proof fixture", now: C.clock }).prospect;
    }
    return p;
  })();
  const undecided = (() => {
    let p = createProspect({
      businessName: "M8L Undecided Locks",
      tradeCategory: "Locksmith",
      suburb: "Fitzroy",
      state: "VIC",
      postcode: "3065",
      region: "Melbourne",
      timezone: "Australia/Melbourne",
      phones: [{ raw: "(03) 5550 1099" }],
      sourceRefs: [{ url: "https://m8l-duplicate-probe.example.com.au/contact" }],
      origin: "fixture",
      discoveredAt: "2026-07-15T02:00:00.000Z",
    }).prospect;
    for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
      p = transitionProspect(p, to, { actor: C.FOUNDER, reason: "M8L proof fixture", now: C.clock }).prospect;
    }
    return p;
  })();

  // The business we already hold.
  await store.upsertProspect(canonical);
  C.check("A1", "a canonical business is stored", (await store.loadProspect(canonical.prospectId)) !== null, canonical.prospectId);

  const clean = await resolveDuplicateStateForProspect({ store, prospectId: canonical.prospectId });
  C.check("A2", "a stored, uncontested business is durably resolved as distinct", clean.state === DUPLICATE_STATE.RESOLVED_DISTINCT);

  // ── Three ambiguous candidates, held rather than stored ───────────
  for (const c of [merged, distinct, undecided]) {
    const opened = await openReviewItem({
      candidate: c,
      reason: "This may be the same business as one already known.",
      signals: ["same_phone_number", "different_locality"],
      possibleMatches: [canonical.prospectId],
      store,
      now: C.clock,
    });
    C.check(`A3.${c.businessName.split(" ")[1]}`, `"${c.businessName}" is held for a human`, opened.created === true, opened.reviewId);
  }

  const held = await resolveDuplicateStateForProspect({ store, prospectId: merged.prospectId });
  C.check("A4", "an open review reads as UNRESOLVED", held.state === DUPLICATE_STATE.UNRESOLVED, held.code);

  // ── A named human decides. Twice. ─────────────────────────────────
  const m = await resolveReviewItem({
    store,
    reviewId: `rv_${merged.prospectId}`,
    decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING,
    actor: C.FOUNDER,
    reason: "Same business as the canonical record; the second listing is an old address.",
    mergeTarget: canonical.prospectId,
    now: C.clock,
  });
  C.check("A5", "the merge is recorded by a named human", m.ok === true && m.item.decidedBy === C.FOUNDER, m.ok ? m.item.decision : m.message);

  const d = await resolveReviewItem({
    store,
    reviewId: `rv_${distinct.prospectId}`,
    decision: REVIEW_DECISIONS.APPROVE_AS_NEW,
    actor: C.FOUNDER,
    reason: "Different owner, different ABN, different business.",
    now: C.clock,
  });
  C.check("A6", "the approve-as-new is recorded by a named human", d.ok === true && d.item.decidedBy === C.FOUNDER);

  // Approving as new is what makes it a prospect — the review CLI does this.
  await store.upsertProspect(distinct);
  const distinctState = await resolveDuplicateStateForProspect({ store, prospectId: distinct.prospectId });
  C.check("A7", "the approved-as-new candidate is now durably distinct", distinctState.state === DUPLICATE_STATE.RESOLVED_DISTINCT, distinctState.message);

  const mergedState = await resolveDuplicateStateForProspect({ store, prospectId: merged.prospectId });
  C.check("A8", "the merged candidate names the canonical business", mergedState.state === DUPLICATE_STATE.MERGED && mergedState.canonicalId === canonical.prospectId, mergedState.canonicalId);

  const stillOpen = await loadReviewItem({ store, reviewId: `rv_${undecided.prospectId}` });
  C.check("A9", "the third is deliberately left undecided", stillOpen.status === STATUS.OPEN);

  // A batch approval for the two that could be called, so B's gate run is
  // testing the duplicate check rather than tripping over E-5.
  const identity = canonicalBatchIdentity({
    members: [
      { rowId: canonical.prospectId, prospectId: canonical.prospectId, e164: C.CANONICAL_NUMBER },
      { rowId: merged.prospectId, prospectId: merged.prospectId, e164: C.NUMBER },
    ],
    label: "m8l proof batch",
  });
  const approved = await recordBatchApproval({ store, now: C.clock, identity, approvedBy: C.FOUNDER, reason: "M8L proof — a fictional batch." });
  C.check("A10", "a founder batch approval is recorded for both", approved.ok === true && approved.created === true, identity.batchKey);

  const rows = await store.listDecisions({});
  C.check("A11", "the decision chain verifies", verifyRows(rows).ok === true, `${rows.length} row(s)`);

  fs.writeFileSync(
    C.HANDOFF,
    JSON.stringify(
      {
        pid: process.pid,
        canonicalId: canonical.prospectId,
        mergedId: merged.prospectId,
        distinctId: distinct.prospectId,
        undecidedId: undecided.prospectId,
        mergedDecidedBy: mergedState.decidedBy,
        mergedDecidedAt: mergedState.decidedAt,
        batchKey: identity.batchKey,
        prospects: { canonical, merged, distinct, undecided },
      },
      null,
      2
    )
  );

  console.log("");
  console.log(`  store    ${C.STATE_FILE}`);
  console.log(`  handoff  ${C.HANDOFF}`);
  console.log("");
  console.log("  Nothing was called, scheduled or prepared. Process A is exiting; its heap goes with it.");
  C.summary("PROCESS A");
}

main().catch((err) => {
  console.error(`\nPROCESS A FAILED: ${err.stack}`);
  process.exit(1);
});
