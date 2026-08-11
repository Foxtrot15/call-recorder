#!/usr/bin/env node
// ============================================================================
// E-7B1 DISPATCH PROOF — the genuine two-process race.
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-dispatch-proof/race.js
//
// REQUIRES laq5 applied to dev, and an EMPTY acquisition_dial_executions.
//
// ── WHY THIS EXISTS SEPARATELY FROM run.js ──────────────────────────
// run.js proves the refusals sequentially, which is honest but weaker: one
// process, one event loop, and the possibility that some ordering in Node — not
// Postgres — is what kept things safe.
//
// This spawns TWO SEPARATE OS PROCESSES, each with its own database
// connection, and has both busy-wait to the same wall-clock instant before
// issuing their claims. Neither can see the other's memory. Whatever arbitrates
// is the database.
//
// ── WHAT IT WRITES ──────────────────────────────────────────────────
// Exactly ONE row: the winner's. That row IS the founder-approved proof residue
// (dev 22 -> 23). The loser's insert is refused by Postgres and writes nothing.
//
// Run this INSTEAD of `run.js --commit-proof-row`, not as well — between them
// only one approved row may exist.
// ============================================================================

const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const { makeClient, makeDispatchStore, PROOF_PROSPECT, PROOF_DESTINATION } = require("./common");

const line = (c = "-") => console.log(c.repeat(74));
const head = (t) => {
  console.log("");
  line("=");
  console.log(t);
  line("=");
};

function runWorker({ label, dispatchId, prospectId, destination, startAtMs }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "race-worker.js"), label, dispatchId, prospectId, destination, String(startAtMs)],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        resolve({ label, code: "WORKER_UNPARSEABLE", message: (err || out).slice(0, 300) });
      }
    });
  });
}

async function main() {
  console.log("");
  line("=");
  console.log("  E-7B1 — TWO PROCESSES, ONE PROSPECT, ONE HANDSET");
  console.log("  Two OS processes. Two connections. No shared memory.");
  line("=");

  const db = makeClient();
  const store = makeDispatchStore(db);

  const state = await store.readCallingState();
  if (!state) {
    console.log("\n  LAQ5 has not been applied. Stopping.");
    process.exit(2);
  }
  console.log(`\n  calling state : ${state.state}  (revision ${state.revision})`);
  if (state.state !== "paused") {
    console.log("  REFUSING TO RUN: this proof expects calling to be paused.");
    process.exit(2);
  }

  const existing = await store.listDialExecutions({});
  if (existing.length > 0) {
    console.log(`\n  acquisition_dial_executions already holds ${existing.length} row(s).`);
    console.log("  This race writes the ONE approved row and must start from empty.");
    console.log("  Nothing was attempted.");
    process.exit(2);
  }

  head("The race");

  // Two DIFFERENT authorisations — as two independent workers would mint —
  // for the SAME fictional business on the SAME fictional handset.
  const a = randomUUID();
  const b = randomUUID();
  const startAtMs = Date.now() + 1500;

  console.log(`  worker A dispatch_id : ${a}`);
  console.log(`  worker B dispatch_id : ${b}`);
  console.log(`  both claiming        : ${PROOF_PROSPECT} on ${PROOF_DESTINATION}`);
  console.log(`  both fire at         : ${new Date(startAtMs).toISOString()}`);
  console.log("");

  const [ra, rb] = await Promise.all([
    runWorker({ label: "A", dispatchId: a, prospectId: PROOF_PROSPECT, destination: PROOF_DESTINATION, startAtMs }),
    runWorker({ label: "B", dispatchId: b, prospectId: PROOF_PROSPECT, destination: PROOF_DESTINATION, startAtMs }),
  ]);

  for (const r of [ra, rb]) {
    console.log(`  worker ${r.label}  pid ${r.pid}  ->  ${r.code}${r.conflictScope ? ` (${r.conflictScope})` : ""}`);
    console.log(`            ${r.message}`);
  }

  head("What the database decided");

  const winners = [ra, rb].filter((r) => r.claimed === true);
  const losers = [ra, rb].filter((r) => r.claimed !== true);
  const rows = await store.listDialExecutions({});

  let failed = 0;
  const check = (label, ok, detail = "") => {
    if (!ok) failed += 1;
    console.log(`  ${ok ? "PASS" : "**FAIL**"}  ${label}${detail ? `  (${detail})` : ""}`);
  };

  check("exactly ONE worker claimed", winners.length === 1, `${winners.length} winners`);
  check("the other was refused", losers.length === 1 && losers[0].code !== "WORKER_ERROR", losers[0] && losers[0].code);
  check("the refusal names a lock", losers[0] && (losers[0].conflictScope === "prospect" || losers[0].conflictScope === "destination"), losers[0] && losers[0].conflictScope);
  check("exactly ONE row exists in the ledger", rows.length === 1, `${rows.length} rows`);
  check("and it belongs to the winner", rows.length === 1 && winners.length === 1 && rows[0].dispatchId === (winners[0].label === "A" ? a : b));
  check("it is UNRESOLVED", rows.length === 1 && rows[0].resolvedAt === null);

  console.log("");
  console.log("  Neither process could see the other. Postgres arbitrated.");

  head("SUMMARY");
  console.log(`  ${failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED"}`);
  console.log("  NO CALL WAS PLACED. NO PROVIDER WAS INVOKED. CALLING REMAINS PAUSED.");
  line("=");
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nRACE FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
