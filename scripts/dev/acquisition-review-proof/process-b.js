// ============================================================================
// M8H REVIEW-QUEUE PROOF - PROCESS B (fresh process, hydrate and resolve).
//
// A BRAND-NEW OS PROCESS. Process A's heap and its chain state are gone. This
// one hydrates the persisted decision chain, finds the review still waiting,
// records a human resolution, and proves the COMBINED chain still verifies as
// one — which is the claim that could not be made before M8H, because nothing
// persisted decisions and the chain always restarted from genesis.
//
// Writes exactly ONE decision row: review_resolved.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-review-proof/process-b.js
// ============================================================================

const C = require("./common");
const { loadReviewItem, listReviewItems, resolveReviewItem, REVIEW_DECISIONS, STATUS } = require("../../../src/services/acquisition-review-queue");
const { verifyRows } = require("../../../src/services/acquisition-audit");
const { createDialAuthoriser } = require("../../../src/services/acquisition-authorisation");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8H REVIEW-QUEUE PROOF - PROCESS B (hydrate the chain and resolve)");
  console.log("=".repeat(74));

  const client = C.makeClient();
  const store = C.makeStore(client);
  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed\n`);

  const before = await store.listDecisions({});

  // -- 1. THE REVIEW SURVIVED THE PROCESS -----------------------------------
  const item = await loadReviewItem({ store, reviewId: C.REVIEW_ID });
  C.check("B1", "a fresh process finds the review item opened by process A", item !== null && item.status === STATUS.OPEN, item ? `${item.reviewId} | ${item.candidate.businessName} | opened ${item.openedAt}` : "not found");
  C.check("B2", "it carries the candidate and what it might be", item !== null && item.candidate.phones.length === 1 && item.possibleMatches.includes(C.POSSIBLE_MATCH), item ? `phones=${item.candidate.phones.map((p) => p.raw).join(",")} mayBe=${item.possibleMatches.join(",")}` : "n/a");

  const open = await listReviewItems({ store, status: STATUS.OPEN });
  C.check("B3", "and it appears in the operator queue", open.some((i) => i.reviewId === C.REVIEW_ID), `${open.length} open item(s)`);

  // -- 2. THE CANDIDATE IS STILL NOT A PROSPECT -----------------------------
  C.check("B4", "the held candidate never became a prospect row", (await store.loadProspect(C.CANDIDATE_ID)) === null);

  // -- 3. A HUMAN RESOLVES IT -----------------------------------------------
  const resolved = await resolveReviewItem({
    store,
    reviewId: C.REVIEW_ID,
    decision: REVIEW_DECISIONS.REJECT_DUPLICATE,
    actor: "m8h-proof-founder",
    reason: "M8H proof: the same invented business as the M8G probe. Rejected as a duplicate; nothing is created.",
    now,
  });
  C.check("B5", "the human decision was recorded", resolved.ok === true && resolved.item.status === STATUS.RESOLVED, resolved.ok ? `${resolved.item.decision} by ${resolved.item.decidedBy}` : resolved.message);
  C.check("B6", "and recorded as a HUMAN decision, not the classifier", resolved.ok === true && resolved.recorded.actorKind === "human");

  // -- 4. THE COMBINED CHAIN STILL VERIFIES ---------------------------------
  const after = await store.listDecisions({});
  C.check("B7", "exactly ONE further decision row was written", after.length === before.length + 1, `${before.length} -> ${after.length}`);
  C.check("B8", "THE COMBINED PRE- AND POST-RESTART CHAIN VERIFIES AS ONE", verifyRows(after).ok === true, `${after.length} row(s); ${verifyRows(after).ok ? "intact" : verifyRows(after).message}`);

  const opened = after.find((r) => r.event === "review_opened" && r.entityId === C.CANDIDATE_ID);
  const closed = after.find((r) => r.event === "review_resolved" && r.entityId === C.CANDIDATE_ID);
  C.check("B9", "the resolution links to the row the OTHER process wrote", closed && opened && closed.sequence > opened.sequence && closed.prevHash.length === 64, opened && closed ? `opened seq ${opened.sequence} -> resolved seq ${closed.sequence}` : "n/a");

  // -- 5. RESOLUTION IS NOT PERMISSION --------------------------------------
  const stale = await resolveReviewItem({ store, reviewId: C.REVIEW_ID, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "someone-else", reason: "Trying to re-decide.", now });
  C.check("B10", "a second resolution is refused rather than silently re-deciding", stale.ok === false && stale.code === "already_resolved", stale.message);

  const afterStale = await store.listDecisions({});
  C.check("B11", "and the refusal wrote nothing", afterStale.length === after.length, `${after.length} -> ${afterStale.length}`);

  const gate = createDialAuthoriser({ now, store });
  const decision = await gate.authorise({ ...C.candidate(), lifecycle: "discovered" }, {});
  C.check("B12", "deciding a review does not make anything callable", decision.authorised === false && decision.dial === null, `code=${decision.code}`);

  console.log(`\nDecision rows written by this proof: 2 (one per process).`);

  const ok = C.summary("PROCESS B");
  console.log("\nThe review survived a real process restart, a fresh process continued the");
  console.log("persisted chain, and the combined log verifies. Nothing was dialled.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPROCESS B FAILED:", err.message);
  process.exit(1);
});
