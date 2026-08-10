// ============================================================================
// E-5 RESTART PROOF — PROCESS A. Approves, writes down what it approved, EXITS.
//
//   node scripts/dev/acquisition-batch-approval-proof/process-a.js
//
// This process invents a batch, approves it durably, and dies. Its heap — and
// with it every trace of the approval object, the identity and the founder's
// decision — is gone before process B starts.
//
// The handoff file exists so B can assert it recovered THE SAME approval rather
// than merely a plausible one. It is not a cache: B re-reads the store and
// compares, and the file is written after the write, never consulted before it.
//
// It also writes a SECOND, mutated batch's identity to the handoff WITHOUT
// approving it, so B can prove the old approval does not stretch to cover it.
//
// NOTHING HERE CONTACTS ANYBODY.
// ============================================================================

const fs = require("node:fs");
const C = require("./common");
const {
  canonicalBatchIdentity,
  recordBatchApproval,
  loadBatchApproval,
  STATUS,
} = require("../../../src/services/acquisition-batch-approval");
const { verifyRows } = require("../../../src/services/acquisition-audit");

async function main() {
  console.log("=".repeat(74));
  console.log(`E-5 RESTART PROOF — PROCESS A (pid ${process.pid})`);
  console.log("=".repeat(74));
  console.log("");

  // A clean slate, so the proof proves this run rather than the last one.
  C.resetState();
  const store = C.makeStore();

  const one = C.fixtureProspect();
  const two = C.fixtureProspect({ name: "E5 Second Probe Locksmiths", suburb: "Preston", phone: "(03) 5550 1099" });

  // ── The batch the founder approves ────────────────────────────────
  const identity = canonicalBatchIdentity({
    members: [{ rowId: one.prospectId, prospectId: one.prospectId, e164: C.NUMBER }],
    label: "e5 proof batch",
  });
  C.check("A1", "an invented batch has a deterministic identity", identity.ok === true, `${identity.batchKey}  ${identity.recordCount} business`);

  const again = canonicalBatchIdentity({ members: [{ rowId: one.prospectId, prospectId: one.prospectId, e164: C.NUMBER }], label: "renamed" });
  C.check("A2", "the same membership hashes the same, and a rename does not move it", again.batchKey === identity.batchKey);

  // ── The durable approval ──────────────────────────────────────────
  const before = await loadBatchApproval({ store, batchKey: identity.batchKey });
  C.check("A3", "nothing is approved before the founder approves it", before.status === STATUS.NONE);

  const result = await recordBatchApproval({
    store,
    now: C.clock,
    identity,
    approvedBy: C.FOUNDER,
    reason: "E-5 restart proof — a fictional business, approved to prove the approval survives this process.",
  });
  C.check("A4", "the founder's approval is recorded", result.ok === true && result.created === true, result.message);

  const replay = await recordBatchApproval({ store, now: C.clock, identity, approvedBy: C.FOUNDER, reason: "Running it twice, as an unsure operator would." });
  C.check("A5", "running the same approval again writes nothing", replay.ok === true && replay.created === false && replay.replayed === true);

  const impostor = await recordBatchApproval({ store, now: C.clock, identity: canonicalBatchIdentity({ members: [{ rowId: two.prospectId, prospectId: two.prospectId, e164: C.OTHER_NUMBER }] }), approvedBy: "aida", reason: "Approving myself." });
  C.check("A6", "a system actor cannot approve a batch", impostor.ok === false && impostor.code === "approver_not_human");

  const rows = await store.listDecisions({});
  C.check("A7", "exactly one durable row exists, and the chain verifies", rows.length === 1 && verifyRows(rows).ok === true, `${rows.length} row(s), event=${rows[0] && rows[0].event}`);

  const state = await loadBatchApproval({ store, batchKey: identity.batchKey });
  C.check("A8", "the approval names who, when and exactly what", state.status === STATUS.APPROVED && state.approval.approvedBy === C.FOUNDER && state.approval.recordCount === 1, `${state.approval.approvedBy} at ${state.approval.approvedAt}`);

  // ── The batch that was NEVER approved ─────────────────────────────
  const mutated = canonicalBatchIdentity({
    members: [
      { rowId: one.prospectId, prospectId: one.prospectId, e164: C.NUMBER },
      { rowId: two.prospectId, prospectId: two.prospectId, e164: C.OTHER_NUMBER },
    ],
    label: "e5 proof batch",
  });
  C.check("A9", "adding a business produces a DIFFERENT batch key", mutated.batchKey !== identity.batchKey, `${identity.batchKey} -> ${mutated.batchKey}`);

  fs.writeFileSync(
    C.HANDOFF,
    JSON.stringify(
      {
        pid: process.pid,
        approvedBatchKey: identity.batchKey,
        approvedMembershipHash: identity.membershipHash,
        approvedBy: state.approval.approvedBy,
        approvedAt: state.approval.approvedAt,
        approvedMembers: identity.members,
        mutatedBatchKey: mutated.batchKey,
        mutatedMembers: mutated.members,
        prospectOne: one,
        prospectTwo: two,
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
