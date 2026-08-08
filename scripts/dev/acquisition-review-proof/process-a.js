// ============================================================================
// M8H REVIEW-QUEUE PROOF - PROCESS A (opens the review item).
//
// The novel M8H real-database claim, and only that:
//
//   ambiguous candidate -> durable review_opened -> process exits
//   -> fresh process hydrates the persisted decision chain
//   -> the review is still visible -> a human resolution appends
//      review_resolved -> the combined chain still verifies
//
// PERSISTENCE OF PROSPECTS/PHONES/EVIDENCE WAS PROVEN IN M8G AGAINST REAL
// POSTGRES AND IS NOT RE-PROVEN HERE. Merge enrichment is proven offline
// against the store contract. Neither is worth new permanent residue.
//
// APPROVED PERMANENT RESIDUE: 2 rows in acquisition_decisions, both fictional.
//   review_opened   (this process)
//   review_resolved (process B)
// No prospect, no phone, no evidence, no suppression, no outcome, no queue row.
//
// The candidate is INVENTED and is deliberately NOT persisted as a prospect —
// which is the review queue's whole point.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-review-proof/process-a.js
// ============================================================================

const C = require("./common");
const { openReviewItem, loadReviewItem } = require("../../../src/services/acquisition-review-queue");
const { verifyRows } = require("../../../src/services/acquisition-audit");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8H REVIEW-QUEUE PROOF - PROCESS A (open a durable review item)");
  console.log("=".repeat(74));

  const client = C.makeClient();
  const store = C.makeStore(client);
  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed`);

  const before = await store.listDecisions({});
  console.log(`Decisions before : ${before.length}`);
  C.check("A0", "the chain we are about to continue is currently valid", verifyRows(before).ok === true, `${before.length} row(s)`);

  const existing = await loadReviewItem({ store, reviewId: C.REVIEW_ID });
  if (existing) {
    C.check("A1", "REFUSING to open a second review item", false, `${C.REVIEW_ID} already exists (${existing.status}). The approval was for exactly two decision rows. Nothing was written.`);
    process.exit(1);
  }

  const opened = await openReviewItem({
    candidate: C.candidate(),
    reason: "M8H proof: an invented candidate that may be the M8G probe business. Held for a human.",
    signals: ["same_phone_number", "different_business_name"],
    possibleMatches: [C.POSSIBLE_MATCH],
    store,
    now,
    importContext: { line: 2, classification: "likely_locksmith" },
  });

  C.check("A2", "a durable review item was opened", opened.created === true, `${opened.reviewId} status=${opened.status}`);

  const after = await store.listDecisions({});
  C.check("A3", "exactly ONE decision row was written", after.length === before.length + 1, `${before.length} -> ${after.length}`);
  C.check("A4", "the chain still verifies after the append", verifyRows(after).ok === true);
  C.check("A5", "the candidate was NOT written as a prospect", (await store.loadProspect(C.CANDIDATE_ID)) === null, "a possible duplicate must not become the duplicate row");

  const head = after[after.length - 1];
  console.log(`\nChain head    : sequence ${head.sequence}, ${head.entryHash.slice(0, 16)}...`);

  const ok = C.summary("PROCESS A");
  console.log("\nProcess A is exiting. Its heap and its chain state go with it.");
  console.log("Run process-b.js next, in a fresh process.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPROCESS A FAILED:", err.message);
  process.exit(1);
});
