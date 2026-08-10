// ============================================================================
// M8K / E-3 RESTART PROOF — PROCESS B. READ-ONLY.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-dncr-proof/process-b.js
//
// A BRAND NEW OS PROCESS. Process A has exited; nothing survives it but the row
// in Postgres and a small file recording what A saw. B re-reads the database,
// proves it recovered the SAME row, gets the SAME answer at the same instant,
// and then asks the one question a durable wash store exists to answer:
//
//     what does this row mean 42 days after the wash was performed?
//
// It must decay to unknown and refuse. It must NOT keep reporting not_listed,
// and NOTHING in the database may change to make that happen.
//
// SELECT ONLY. Nothing here writes to the database.
// ============================================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./common");
const { hydrateWashStore, DNCR_WASH_VALIDITY_DAYS } = require("../../../src/services/acquisition-dncr");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../../../src/services/acquisition-eligibility");

const HANDOFF = path.resolve(process.env.M8K_HANDOFF || path.join(__dirname, ".process-a-saw.json"));

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
  return {
    failed: (decision.failedChecks || []).find((f) => f.check === "dncr"),
    passed: (decision.passedChecks || []).includes("dncr"),
    decision,
  };
}

const fingerprint = (rows) => crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");

async function main() {
  console.log("=".repeat(74));
  console.log("M8K / E-3 RESTART PROOF — PROCESS B (pid " + process.pid + ")");
  console.log("=".repeat(74));

  if (!fs.existsSync(HANDOFF)) throw new Error(`${HANDOFF} is missing. Run process-a.js first.`);
  const a = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
  C.check("B0", "this is a DIFFERENT operating-system process from A", a.pid !== process.pid, `A was pid ${a.pid}, B is pid ${process.pid}`);

  // ── The restart: a new client, a new store, a new everything ──────
  const store = C.makeStore(C.makeClient());
  const before = await store.listWashes({});
  const washStore = await hydrateWashStore({ store, now: () => C.FRESH_AT });

  C.check("B1", "the ledger is readable from this new process too", washStore.available === true);
  C.check("B2", "the SAME row was recovered — every field identical to what A saw", JSON.stringify(await store.latestWashFor(C.SUBJECT)) === JSON.stringify(a.row), "compared field by field against A's handoff");

  // ── Same instant, same answer ─────────────────────────────────────
  const fresh = washStore.assess(C.SUBJECT, { at: C.FRESH_AT });
  C.check("B3", "evaluated at the same instant, it gives the same answer", fresh.result === a.assessed.result && fresh.authoritative === a.assessed.authoritative && fresh.usable === a.assessed.usable && fresh.ageDays === a.assessed.ageDays, `${fresh.result}, authoritative=${fresh.authoritative}, usable=${fresh.usable}, age=${fresh.ageDays}d — A saw ${a.assessed.result}, ${a.assessed.authoritative}, ${a.assessed.usable}, ${a.assessed.ageDays}d`);

  const freshVerdict = dncrVerdict(washStore, C.SUBJECT, C.FRESH_AT);
  C.check("B4", "and the DNCR gate still passes after the restart", freshVerdict.passed === true, freshVerdict.failed ? `${freshVerdict.failed.code}` : "dncr passed");

  // ── THE SAME ROW, 42 DAYS AFTER THE WASH ──────────────────────────
  //
  // Nothing is re-read and nothing is re-written. The identical hydrated store
  // is asked about a later instant, which is the whole point: freshness is a
  // question about WHEN YOU ASK, not a property stored on the row.
  const stale = washStore.assess(C.SUBJECT, { at: C.STALE_AT });
  const staleAge = Math.floor((C.STALE_AT.getTime() - Date.parse(C.EXPECTED.washedAt)) / (24 * 3600 * 1000));

  C.check("B5", `at +${staleAge} days the same row is NO LONGER usable`, stale.usable === false && stale.fresh === false, `usable=${stale.usable} fresh=${stale.fresh} age=${stale.ageDays}d`);
  C.check("B6", "it decays to UNKNOWN — not to its last answer", stale.result === "unknown", `result=${stale.result}`);
  C.check("B7", "but what it used to say stays visible to a human", stale.priorResult === "not_listed", `priorResult=${stale.priorResult}`);
  C.check("B8", "it does NOT keep reporting not_listed indefinitely", stale.result !== "not_listed" && stale.usable !== true);

  const staleVerdict = dncrVerdict(washStore, C.SUBJECT, C.STALE_AT);
  C.check("B9", "eligibility refuses with the STALE condition specifically", staleVerdict.failed && staleVerdict.failed.code === ELIGIBILITY_CODES.DNCR_STALE, staleVerdict.failed ? `${staleVerdict.failed.code}` : "the gate did not refuse at all");
  C.check(
    "B10",
    "and it is not misreported as never-checked or as a store fault",
    staleVerdict.failed && staleVerdict.failed.code !== ELIGIBILITY_CODES.DNCR_UNKNOWN && staleVerdict.failed.code !== ELIGIBILITY_CODES.DNCR_UNAVAILABLE,
    staleVerdict.failed ? `"${staleVerdict.failed.message}"` : ""
  );
  C.check("B11", "the founder is told to wash it AGAIN, not to wash it for the first time", staleVerdict.failed && /again/i.test(staleVerdict.failed.requiredFounderAction || ""), staleVerdict.failed ? staleVerdict.failed.requiredFounderAction : "");

  // ── NOTHING MOVED. Time passing rewrites no row. ──────────────────
  const after = await store.listWashes({});
  C.check("B12", "asking about a later instant changed NOTHING in the database", fingerprint(after) === fingerprint(before), `ledger sha256 ${fingerprint(after)}`);
  C.check("B13", "the ledger still holds exactly one row", after.length === 1, `${after.length} row(s)`);

  const counts = await C.counts();
  const total = Object.values(counts).reduce((x, y) => x + y, 0);
  C.check("B14", `dev still holds exactly ${C.EXPECTED_TOTAL_ROWS} acquisition rows`, total === C.EXPECTED_TOTAL_ROWS, `${total}`);

  console.log("");
  console.log("-".repeat(74));
  console.log("WHAT THIS PROVED");
  console.log(`  One row, written by hand on 2026-08-09, read by two separate OS processes.`);
  console.log(`  At +6 days   not_listed, authoritative, usable   -> the DNCR gate passes.`);
  console.log(`  At +${staleAge} days  unknown (was not_listed), unusable      -> dncr_wash_stale.`);
  console.log(`  Same row both times. ${DNCR_WASH_VALIDITY_DAYS}-day validity computed at read time.`);
  console.log("RESIDUE: none. Every database statement was a SELECT.");
  console.log("-".repeat(74));

  process.exit(C.summary("M8K / E-3 PROCESS B") ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
