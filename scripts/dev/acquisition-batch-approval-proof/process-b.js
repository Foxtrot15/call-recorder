// ============================================================================
// E-5 RESTART PROOF — PROCESS B. A fresh OS process that has never seen a batch.
//
//   node scripts/dev/acquisition-batch-approval-proof/process-b.js
//
// Run AFTER process-a.js. Everything this process knows about the founder's
// decision, it read back from durable state. There is no approval object in its
// heap, no `context.batch` in anything it passes, and no way for it to
// construct one that the gate would accept.
//
// It proves, in order:
//
//   the approval survived the process that made it;
//   it covers exactly the membership it covered;
//   the final M8E gate authorises from it with no caller-supplied approval;
//   a MUTATED batch is not covered by it;
//   the approval is not permission — suppression still refuses;
//   an unreadable approval store fails closed with its own code;
//   withdrawing it takes effect immediately and erases nothing.
//
// NOTHING HERE CONTACTS ANYBODY.
// ============================================================================

const fs = require("node:fs");
const C = require("./common");
const {
  loadBatchApproval,
  listBatchApprovals,
  resolveBatchApprovalForProspect,
  revokeBatchApproval,
  checkDurableFreshness,
  canonicalBatchIdentity,
  BATCH_APPROVAL_CODES,
  STATUS,
} = require("../../../src/services/acquisition-batch-approval");
const { createDialAuthoriser, isAuthorisedDial, AUTHORISATION_CODES } = require("../../../src/services/acquisition-authorisation");
const { ELIGIBILITY_CODES } = require("../../../src/services/acquisition-eligibility");
const { identityFingerprint } = require("../../../src/services/acquisition-prospect");
const { verifyRows } = require("../../../src/services/acquisition-audit");

async function main() {
  console.log("=".repeat(74));
  console.log(`E-5 RESTART PROOF — PROCESS B (pid ${process.pid})`);
  console.log("=".repeat(74));
  console.log("");

  if (!fs.existsSync(C.HANDOFF)) {
    console.error(`Run process-a.js first — ${C.HANDOFF} does not exist.`);
    process.exit(1);
  }
  const saw = JSON.parse(fs.readFileSync(C.HANDOFF, "utf8"));
  C.check("B0", "this is a different OS process from the one that approved", saw.pid !== process.pid, `A was pid ${saw.pid}, B is pid ${process.pid}`);

  // Rebuilt from the same deterministic fixture, NOT from anything A handed over.
  const one = C.fixtureProspect();
  const two = C.fixtureProspect({ name: "E5 Second Probe Locksmiths", suburb: "Preston", phone: "(03) 5550 1099" });

  const store = C.makeStore();

  // ── 1. The approval survived ──────────────────────────────────────
  const state = await loadBatchApproval({ store, batchKey: saw.approvedBatchKey });
  C.check("B1", "the approval is still there, in a process that never made it", state.status === STATUS.APPROVED, `${state.batchKey}`);
  C.check("B2", "it names the same person and the same instant", state.approval.approvedBy === saw.approvedBy && state.approval.approvedAt === saw.approvedAt, `${state.approval.approvedBy} at ${state.approval.approvedAt}`);
  C.check("B3", "it binds to the same membership hash", state.approval.membershipHash === saw.approvedMembershipHash, saw.approvedMembershipHash);
  C.check(
    "B4",
    "it covers exactly the businesses and numbers it covered",
    JSON.stringify(state.approval.members.map((m) => [m.prospectId, m.e164])) === JSON.stringify(saw.approvedMembers.map((m) => [m.prospectId, m.e164])),
    state.approval.members.map((m) => `${m.prospectId} ${m.e164}`).join("; ")
  );

  const rows = await store.listDecisions({});
  C.check("B5", "the decision chain read back out of durable state verifies", verifyRows(rows).ok === true, `${rows.length} row(s)`);

  // ── 2. B does not need to be told which batch ─────────────────────
  const found = await resolveBatchApprovalForProspect({ store, prospectId: one.prospectId, e164: C.NUMBER });
  C.check("B6", "a restarted process finds the approval knowing only the prospect", found.approved === true && found.source === "durable", `${found.batchKey}`);

  // ── 3. THE MILESTONE: the M8E gate authorises from durable state ──
  const { engineOptions, context } = C.gateInputs(one);
  C.check("B7", "the context handed to the gate contains NO batch approval", Object.prototype.hasOwnProperty.call(context, "batch") === false);

  const gate = createDialAuthoriser({ now: C.clock, store, engineOptions });
  const decision = await gate.authorise(one, context);
  C.check("B8", "the final gate authorises, and says the approval came from durable state", decision.authorised === true && decision.batchSource === "durable", `code=${decision.code} batchKey=${decision.batchKey}`);
  C.check("B9", "and only then is a permission slip minted", isAuthorisedDial(decision.dial) === true);

  // ── 4. A caller cannot assert its way past the gate ───────────────
  //
  // The second business is wired so that EVERY other check passes — its own
  // wash, its own duplicate resolution, the same approved attempt policy — and
  // the only thing it lacks is a durable approval. So a refusal here can only be
  // the batch gate, which is what makes the assertion worth making. (An earlier
  // version of this probe reused the first business's collaborators, and DNCR
  // refused first: it printed a refusal that proved nothing about E-5.)
  const secondInputs = C.gateInputs(two, C.OTHER_NUMBER);
  const secondGate = createDialAuthoriser({ now: C.clock, store, engineOptions: secondInputs.engineOptions });

  const honest = await secondGate.authorise(two, secondInputs.context);
  C.check("B10a", "the un-approved business fails ONLY the batch check", honest.authorised === false && honest.code === ELIGIBILITY_CODES.BATCH_UNAPPROVED && honest.failedChecks.length === 1, `code=${honest.code} failed=${honest.failedChecks.map((f) => f.check).join(",")}`);

  const liar = await secondGate.authorise(two, {
    ...secondInputs.context,
    batch: { approved: true, stale: false, source: "durable", batchHash: saw.approvedMembershipHash, approvedBy: C.FOUNDER },
  });
  C.check("B10b", "and asserting an approval in the context changes nothing", liar.authorised === false && liar.code === ELIGIBILITY_CODES.BATCH_UNAPPROVED && liar.dial === null, `code=${liar.code} batchSource=${liar.batchSource}`);

  // ── 5. A mutated batch is not covered ─────────────────────────────
  const mutated = canonicalBatchIdentity({
    members: [
      { rowId: one.prospectId, prospectId: one.prospectId, e164: C.NUMBER },
      { rowId: two.prospectId, prospectId: two.prospectId, e164: C.OTHER_NUMBER },
    ],
  });
  C.check("B11", "B re-derives the same mutated key A computed", mutated.batchKey === saw.mutatedBatchKey, `${mutated.batchKey}`);

  const fresh = await checkDurableFreshness({ store, identity: mutated });
  C.check("B12", "the mutated batch is NOT approved — the old approval does not stretch", fresh.fresh === false && fresh.code === BATCH_APPROVAL_CODES.MISSING, fresh.message);

  const added = await resolveBatchApprovalForProspect({ store, prospectId: two.prospectId, e164: C.OTHER_NUMBER });
  C.check("B13", "the business added after approval is covered by nothing", added.approved === false && added.code === BATCH_APPROVAL_CODES.MISSING);

  const renumbered = await resolveBatchApprovalForProspect({ store, prospectId: one.prospectId, e164: C.OTHER_NUMBER });
  C.check("B14", "an approved business on a DIFFERENT number is refused as stale", renumbered.approved === false && renumbered.stale === true && renumbered.code === BATCH_APPROVAL_CODES.STALE);

  // ── 6. Approval is not permission ─────────────────────────────────
  await store.appendSuppression({
    reason: "opt_out",
    scope: "business",
    fingerprint: identityFingerprint({ businessName: one.businessName, suburb: one.suburb, state: one.state }),
    e164: C.NUMBER,
    actor: "e5-probe",
    actorKind: "human",
    note: "E-5 proof: asked never to be contacted again.",
    suppressedAt: C.AT.toISOString(),
  });

  const afterOptOut = await createDialAuthoriser({ now: C.clock, store, engineOptions }).authorise(one, context);
  C.check("B15", "an approved batch does NOT outrank an opt-out recorded afterwards", afterOptOut.authorised === false && afterOptOut.code === ELIGIBILITY_CODES.SUPPRESSED, `code=${afterOptOut.code}`);
  C.check("B16", "and the batch approval is still valid — the membership did not change", (await loadBatchApproval({ store, batchKey: saw.approvedBatchKey })).status === STATUS.APPROVED);
  C.check("B17", "no permission slip was minted on the refusal", afterOptOut.dial === null);

  // ── 7. Fail closed ────────────────────────────────────────────────
  const blind = { ...store, async listDecisions() { throw new Error("connection terminated unexpectedly"); } };
  const unreadable = await resolveBatchApprovalForProspect({ store: blind, prospectId: one.prospectId, e164: C.NUMBER });
  C.check("B18", "an unreadable approval store is 'unavailable', never 'not approved'", unreadable.unavailable === true && unreadable.code === BATCH_APPROVAL_CODES.STORE_UNAVAILABLE, unreadable.message);
  C.check("B19", "and the gate's code for it is its own, not the founder's", AUTHORISATION_CODES.BATCH_APPROVAL_STORE_UNAVAILABLE === ELIGIBILITY_CODES.BATCH_STORE_UNAVAILABLE && ELIGIBILITY_CODES.BATCH_STORE_UNAVAILABLE !== ELIGIBILITY_CODES.BATCH_UNAPPROVED);

  // ── 8. Withdrawal takes effect, and erases nothing ────────────────
  const revoked = await revokeBatchApproval({ store, now: C.clock, batchKey: saw.approvedBatchKey, actor: C.FOUNDER, reason: "E-5 proof: withdrawing to show it takes effect." });
  C.check("B20", "the approval can be withdrawn", revoked.ok === true);

  const afterRevoke = await resolveBatchApprovalForProspect({ store, prospectId: one.prospectId, e164: C.NUMBER });
  C.check("B21", "and the business is immediately covered by nothing", afterRevoke.approved === false);

  const finalState = await loadBatchApproval({ store, batchKey: saw.approvedBatchKey });
  C.check("B22", "the approval that WAS given is kept, not deleted", finalState.status === STATUS.WITHDRAWN && finalState.previousApproval.approvedBy === C.FOUNDER);
  C.check("B23", "both rows remain and the chain still verifies", (await store.listDecisions({})).length === 2 && verifyRows(await store.listDecisions({})).ok === true);

  const listed = await listBatchApprovals({ store });
  C.check("B24", "the withdrawn batch is still listable, with what it covered", listed.available === true && listed.batches.length === 1 && listed.batches[0].status === STATUS.WITHDRAWN);

  console.log("");
  console.log("  Nothing was called, scheduled or prepared. No database was touched.");
  C.summary("PROCESS B");
}

main().catch((err) => {
  console.error(`\nPROCESS B FAILED: ${err.stack}`);
  process.exit(1);
});
