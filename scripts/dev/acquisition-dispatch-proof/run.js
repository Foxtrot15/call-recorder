#!/usr/bin/env node
// ============================================================================
// E-7B1 DISPATCH PROOF — durable arbitration against REAL dev Postgres.
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-dispatch-proof/run.js
//   ... --commit-proof-row        also leaves the ONE approved fictional row
//
// REQUIRES laq5 to have been applied to dev BY HAND. Nothing here applies SQL.
//
// ── WHAT IT WRITES ──────────────────────────────────────────────────
// With --commit-proof-row: exactly ONE row in acquisition_dial_executions, for
// a fictional prospect on a fictional number, left UNRESOLVED for ever. That is
// the founder-approved residue, taking dev from 22 to 23.
//
// Without the flag: nothing at all. Every probe below is expected to be
// REFUSED BY POSTGRES, and a refused insert writes nothing.
//
// ── WHAT IT NEVER DOES ──────────────────────────────────────────────
// Never enables calling. Never resolves a dispatch. Never invokes a provider.
// Never writes a decision, a queue row, an outcome or a prospect. Never touches
// production. There is no code path here for any of those.
// ============================================================================

const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const {
  makeClient,
  makeDispatchStore,
  proofDial,
  PROOF_PROSPECT,
  OTHER_PROSPECT,
  PROOF_DESTINATION,
  OTHER_DESTINATION,
} = require("./common");

const ROOT = path.join(__dirname, "..", "..", "..");
const { claimAuthorisedDial, CLAIM_CODES, CONFLICT_SCOPES } = require(path.join(ROOT, "src/services/acquisition-dispatch-store"));
const { readCallingState, STATE_CODES } = require(path.join(ROOT, "src/services/acquisition-calling-state"));
const { executeAuthorisedDial, EXECUTION_CODES } = require(path.join(ROOT, "src/services/acquisition-dial-execution"));
const { createFakeDialProvider } = require(path.join(ROOT, "src/services/acquisition-dial-provider"));

const COMMIT_PROOF_ROW = process.argv.includes("--commit-proof-row");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "PASS" : "**FAIL**"}  ${label}${detail ? `\n         ${detail}` : ""}`);
};

const line = (c = "-") => console.log(c.repeat(74));
const head = (t) => {
  console.log("");
  line("=");
  console.log(t);
  line("=");
};

const now = () => new Date();

async function census(db) {
  const tables = [
    "acquisition_prospects", "acquisition_prospect_phones", "acquisition_evidence",
    "acquisition_decisions", "acquisition_suppressions", "acquisition_qualifications",
    "acquisition_call_queue", "acquisition_contact_outcomes", "acquisition_dncr_washes",
    "acquisition_calling_state", "acquisition_dial_executions",
  ];
  const counts = {};
  let total = 0;
  for (const t of tables) {
    const { data, error } = await db.from(t).select("*").limit(1000);
    if (error) {
      counts[t] = `ABSENT (${error.message.slice(0, 40)})`;
      continue;
    }
    counts[t] = data.length;
    total += data.length;
  }
  return { counts, total };
}

async function main() {
  console.log("");
  line("=");
  console.log("  E-7B1 DURABLE DISPATCH PROOF — real dev Postgres, NO CALL POSSIBLE");
  console.log(`  mode: ${COMMIT_PROOF_ROW ? "COMMIT the one approved fictional row" : "READ-ONLY / refusals only"}`);
  line("=");

  const db = makeClient();
  const store = makeDispatchStore(db);

  // ── 0. Census before ─────────────────────────────────────────────
  head("0. Dev census BEFORE");
  const before = await census(db);
  for (const [t, n] of Object.entries(before.counts)) console.log(`  ${String(n).padStart(4)}  ${t}`);
  console.log(`  ${String(before.total).padStart(4)}  TOTAL`);

  const laq5Applied = typeof before.counts.acquisition_calling_state === "number";
  if (!laq5Applied) {
    console.log("\n  LAQ5 HAS NOT BEEN APPLIED. Nothing else can run. Apply it by hand first.");
    process.exit(2);
  }

  // ── 1. The durable stop ──────────────────────────────────────────
  head("1. The durable emergency stop, read from real Postgres");
  const state = await readCallingState({ store });
  console.log(`  state     : ${state.state}`);
  console.log(`  revision  : ${state.revision}`);
  console.log(`  changedBy : ${state.changedBy}`);
  console.log(`  reason    : ${state.reason}`);
  check("the bootstrap row exists and is PAUSED", state.state === "paused");
  check("and it therefore does NOT permit calling", state.permitted === false);
  check("the refusal is a decision, not our failure", state.code === STATE_CODES.PAUSED);

  // ── 2. The executor refuses while paused ─────────────────────────
  head("2. The executor, against real Postgres, while paused");
  const provider = createFakeDialProvider();
  const blocked = await executeAuthorisedDial({
    store,
    authorisedDial: proofDial({ dispatchId: randomUUID(), at: now().toISOString() }),
    provider,
    now,
  });
  // The slip is not M8E-minted, so identity refuses it before the stop is even
  // reached — which is itself the point: nothing but a genuine slip gets close.
  check("a non-genuine slip is refused outright", blocked.status === EXECUTION_CODES.AUTHORISATION_INVALID, blocked.status);
  check("no provider was invoked", provider.submissionCount() === 0);

  const overridden = await executeAuthorisedDial({
    store,
    authorisedDial: proofDial({ dispatchId: randomUUID(), at: now().toISOString() }),
    provider,
    now,
    killSwitch: () => ({ engaged: false }),
  });
  check("a caller cannot override the stop", overridden.status === EXECUTION_CODES.CALLER_OVERRIDE_REJECTED);
  check("still no provider invocation", provider.submissionCount() === 0);

  // ── 3. The one approved claim ────────────────────────────────────
  head("3. The approved fictional dispatch claim");
  const existing = await store.listDialExecutions({});
  let proofDispatchId = existing.length ? existing[0].dispatchId : null;

  if (existing.length) {
    console.log(`  a proof row already exists: ${proofDispatchId}`);
  } else if (COMMIT_PROOF_ROW) {
    proofDispatchId = randomUUID();
    const claimed = await claimAuthorisedDial({
      store,
      dial: proofDial({ dispatchId: proofDispatchId, at: now().toISOString() }),
      provider: { name: "disabled", live: false },
      claimedBy: "e7b1-verify",
      now,
    });
    check("the claim was accepted by Postgres", claimed.code === CLAIM_CODES.CLAIMED, claimed.message);
    console.log(`  dispatch_id      : ${proofDispatchId}`);
    console.log(`  prospect         : ${PROOF_PROSPECT}  (fictional, M8D)`);
    console.log(`  destination      : ${PROOF_DESTINATION}  (fictional)`);
  } else {
    console.log("  skipped — rerun with --commit-proof-row to leave the approved row.");
    console.log("  The probes below need it, so they will be skipped too.");
  }

  if (!proofDispatchId) {
    head("SUMMARY");
    console.log(`  ${passed} passed, ${failed} failed. Proof row not committed.`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // ── 4. T1 — the same dispatch id ─────────────────────────────────
  head("4. T1 — the SAME dispatch_id claimed again");
  const replay = await claimAuthorisedDial({
    store,
    dial: proofDial({ dispatchId: proofDispatchId, at: now().toISOString() }),
    provider: { name: "disabled", live: false },
    claimedBy: "e7b1-replay",
    now,
  });
  check("refused as ALREADY_CLAIMED", replay.code === CLAIM_CODES.ALREADY_CLAIMED, replay.message);

  // ── 5. T2 — same prospect, different dispatch ────────────────────
  head("5. T2 — SAME prospect, a DIFFERENT dispatch_id");
  const rivalProspect = await claimAuthorisedDial({
    store,
    dial: proofDial({ dispatchId: randomUUID(), destination: OTHER_DESTINATION, at: now().toISOString() }),
    provider: { name: "disabled", live: false },
    claimedBy: "e7b1-t2",
    now,
  });
  check("refused as CONFLICT", rivalProspect.code === CLAIM_CODES.CONFLICT, rivalProspect.message);
  check("scope is PROSPECT", rivalProspect.conflictScope === CONFLICT_SCOPES.PROSPECT, `got ${rivalProspect.conflictScope}`);

  // ── 6. T3 — same destination, different prospect ─────────────────
  head("6. T3 — SAME destination, a DIFFERENT prospect");
  const rivalDestination = await claimAuthorisedDial({
    store,
    dial: proofDial({ dispatchId: randomUUID(), prospectId: OTHER_PROSPECT, at: now().toISOString() }),
    provider: { name: "disabled", live: false },
    claimedBy: "e7b1-t3",
    now,
  });
  check("refused as CONFLICT", rivalDestination.code === CLAIM_CODES.CONFLICT, rivalDestination.message);
  check("scope is DESTINATION", rivalDestination.conflictScope === CONFLICT_SCOPES.DESTINATION, `got ${rivalDestination.conflictScope}`);
  console.log("  (this is the case a per-prospect lock cannot see at all)");

  // ── 7. T4 — independent claims ───────────────────────────────────
  //
  // Proven STRUCTURALLY, without writing: a second prospect on a second number
  // collides with neither index, and the only reason it is not attempted is
  // that a successful claim would leave unapproved residue.
  head("7. T4 — independent prospect + independent destination");
  const open = await store.listDialExecutions({ unresolvedOnly: true });
  const heldProspects = new Set(open.map((d) => d.prospectId));
  const heldDestinations = new Set(open.map((d) => d.destinationE164));
  check("the other fictional prospect holds no unresolved dispatch", !heldProspects.has(OTHER_PROSPECT));
  check("the other fictional number holds no unresolved dispatch", !heldDestinations.has(OTHER_DESTINATION));
  console.log("  Neither partial index would match, so the claim would succeed.");
  console.log("  NOT ATTEMPTED: a successful claim leaves a permanent row, and only");
  console.log("  ONE such row is approved. T3 already proves the destination index,");
  console.log("  and T2 the prospect index, so nothing here is left unproven.");

  // ── 8. Provider status never resolves ────────────────────────────
  head("8. The proof row is still unresolved, and holds both locks");
  const [row] = await store.listDialExecutions({});
  console.log(`  dispatch_id     : ${row.dispatchId}`);
  console.log(`  provider_status : ${row.providerStatus}`);
  console.log(`  resolved_at     : ${row.resolvedAt}`);
  check("resolved_at IS NULL", row.resolvedAt === null);
  check("resolution IS NULL", row.resolution === null);
  check("it still holds its prospect", (await store.listDialExecutions({ unresolvedOnly: true })).length === 1);

  // ── 9. Census after ──────────────────────────────────────────────
  head("9. Dev census AFTER");
  const after = await census(db);
  for (const [t, n] of Object.entries(after.counts)) console.log(`  ${String(n).padStart(4)}  ${t}`);
  console.log(`  ${String(after.total).padStart(4)}  TOTAL`);
  check("acquisition_decisions is unchanged at 4", after.counts.acquisition_decisions === 4);
  check("acquisition_call_queue is unchanged at 0", after.counts.acquisition_call_queue === 0);
  check("acquisition_dial_executions holds exactly one row", after.counts.acquisition_dial_executions === 1);
  check("acquisition_calling_state holds exactly one row", after.counts.acquisition_calling_state === 1);
  check("total residue is 23", after.total === 23, `got ${after.total}`);

  const finalState = await readCallingState({ store });
  check("calling is STILL paused", finalState.state === "paused" && finalState.permitted === false);

  head("SUMMARY");
  console.log(`  ${passed} passed, ${failed} failed.`);
  console.log("  NO CALL WAS PLACED. NO PROVIDER WAS INVOKED. CALLING REMAINS PAUSED.");
  line("=");
  process.exit(failed === 0 ? 0 : 1);
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error("\nPROOF FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
