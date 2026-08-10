// ============================================================================
// M8K / E-3 RESTART PROOF — PROCESS A. READ-ONLY.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-dncr-proof/process-a.js
//
// The first of two GENUINELY SEPARATE OS PROCESSES. This one hydrates the wash
// store from dev Postgres, proves the persisted wash is found and interpreted
// correctly, writes what it saw to a handoff file, and EXITS COMPLETELY. Its
// heap is gone before process B starts.
//
// The handoff file exists so process B can assert it recovered THE SAME ROW
// rather than merely a plausible one. It is not a cache: B re-reads Postgres and
// compares, and the file is written after the read, never consulted before it.
//
// SELECT ONLY. Nothing here writes to the database.
// ============================================================================

const fs = require("fs");
const path = require("path");
const C = require("./common");
const { hydrateWashStore, DNCR_WASH_VALIDITY_DAYS } = require("../../../src/services/acquisition-dncr");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../../../src/services/acquisition-eligibility");

const HANDOFF = path.resolve(process.env.M8K_HANDOFF || path.join(__dirname, ".process-a-saw.json"));

/**
 * The DNCR gate's verdict for one number, isolated from every other gate.
 *
 * The eligibility engine answers a whole question at once; this proof is about
 * one check inside it, so the dncr result is pulled out by name. Everything else
 * being unhappy is expected and irrelevant here — see the final case in
 * test/acquisition-dncr-durable.test.js, which pins that a cleared wash clears
 * ONLY this gate.
 */
function dncrVerdict(washStore, e164, at) {
  const engine = createEligibilityEngine({ now: () => at, washStore });
  const decision = engine.evaluate(
    {
      prospectId: "pr_m8k_dncr_probe",
      businessName: "M8K DNCR Probe",
      timezone: "Australia/Melbourne",
      lifecycle: "review_approved",
      phones: [{ raw: e164 }],
      sourceRefs: [],
    },
    {}
  );
  const failed = (decision.failedChecks || []).find((f) => f.check === "dncr");
  return { failed, passed: (decision.passedChecks || []).includes("dncr"), decision };
}

async function main() {
  console.log("=".repeat(74));
  console.log("M8K / E-3 RESTART PROOF — PROCESS A (pid " + process.pid + ")");
  console.log("=".repeat(74));

  // ── Hydrated from Postgres, not from anything this process invented ──
  const store = C.makeStore(C.makeClient());
  const washStore = await hydrateWashStore({ store, now: () => C.FRESH_AT });

  C.check("A1", "the durable wash ledger was readable — the store is AVAILABLE", washStore.available === true, `available=${washStore.available}`);
  C.check("A2", "exactly one wash was hydrated from Postgres", washStore.count() === 1, `${washStore.count()} record(s)`);

  const assessed = washStore.assess(C.SUBJECT, { at: C.FRESH_AT });
  C.check("A3", "the persisted wash is FOUND for the subject number", assessed.result !== "unknown" || assessed.washedAt !== null, `result=${assessed.result} washedAt=${assessed.washedAt}`);
  C.check("A4", "it reads back as not_listed", assessed.result === "not_listed", `${assessed.result}`);
  C.check("A5", "it is AUTHORITATIVE — a human attested a real wash", assessed.authoritative === true, `authoritative=${assessed.authoritative}`);
  C.check("A6", "it is usable at an instant inside the validity window", assessed.usable === true && assessed.fresh === true, `usable=${assessed.usable} fresh=${assessed.fresh}`);

  // ── Freshness is computed FROM washed_at, not stored ──────────────
  const expectedAge = Math.floor((C.FRESH_AT.getTime() - Date.parse(C.EXPECTED.washedAt)) / (24 * 3600 * 1000));
  C.check(
    "A7",
    "the age is computed from washed_at against the evaluation instant",
    assessed.ageDays === expectedAge,
    `washed_at ${C.EXPECTED.washedAt} evaluated at ${C.FRESH_AT.toISOString()} => ${assessed.ageDays} day(s), expected ${expectedAge}`
  );
  C.check("A8", `and ${expectedAge} is inside the ${DNCR_WASH_VALIDITY_DAYS}-day statutory window`, expectedAge < DNCR_WASH_VALIDITY_DAYS);

  // ── PROOF IT CAME FROM POSTGRES, NOT FROM THIS PROCESS ────────────
  //
  // A wash store built with no durable rows at all answers "unknown" for this
  // number. If the number is only known when the ledger is read, then the
  // knowledge came from the ledger.
  const { createWashStore } = require("../../../src/services/acquisition-dncr");
  const processLocal = createWashStore({ now: () => C.FRESH_AT, mode: "import" });
  C.check(
    "A9",
    "a store with no durable read knows NOTHING about this number",
    processLocal.assess(C.SUBJECT).result === "unknown" && processLocal.count() === 0,
    `process-local says "${processLocal.assess(C.SUBJECT).result}" with ${processLocal.count()} record(s) — so A4's answer came from Postgres`
  );

  // ── The gate itself ───────────────────────────────────────────────
  const verdict = dncrVerdict(washStore, C.SUBJECT, C.FRESH_AT);
  C.check("A10", "the DNCR gate PASSES on the persisted wash", verdict.passed === true && !verdict.failed, verdict.failed ? `${verdict.failed.code}: ${verdict.failed.message}` : "dncr check passed");
  C.check(
    "A11",
    "and it is neither dncr_not_checked nor dncr_store_unavailable",
    !verdict.failed || (verdict.failed.code !== ELIGIBILITY_CODES.DNCR_UNKNOWN && verdict.failed.code !== ELIGIBILITY_CODES.DNCR_UNAVAILABLE),
    verdict.failed ? verdict.failed.code : "no dncr failure at all"
  );

  // ── Hand off what was seen, then die ──────────────────────────────
  const seen = {
    pid: process.pid,
    at: new Date().toISOString(),
    evaluatedAt: C.FRESH_AT.toISOString(),
    row: await store.latestWashFor(C.SUBJECT),
    assessed: { result: assessed.result, authoritative: assessed.authoritative, usable: assessed.usable, ageDays: assessed.ageDays, washedAt: assessed.washedAt },
    dncrPassed: verdict.passed,
  };
  fs.writeFileSync(HANDOFF, JSON.stringify(seen, null, 2), "utf8");

  console.log("");
  console.log("-".repeat(74));
  console.log(`PROCESS A (pid ${process.pid}) is about to exit. Its heap goes with it.`);
  console.log(`What it saw was written to ${path.basename(HANDOFF)} so B can prove it recovered the SAME row.`);
  console.log("RESIDUE: none. Every database statement was a SELECT.");
  console.log("-".repeat(74));

  process.exit(C.summary("M8K / E-3 PROCESS A") ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
