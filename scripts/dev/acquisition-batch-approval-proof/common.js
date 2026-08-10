// ============================================================================
// E-5 RESTART PROOF — shared fixtures and a file-backed store.
//
//   node scripts/dev/acquisition-batch-approval-proof/process-a.js
//   node scripts/dev/acquisition-batch-approval-proof/process-b.js
//
// ── WHY A FILE AND NOT POSTGRES ─────────────────────────────────────
// The claim E-5 has to prove is that a batch approved by a process that has
// EXITED is recognised by a process that has never seen it. What makes that
// claim true is the fold over append-only decision rows, and that fold does not
// know or care which durable thing the rows came out of.
//
// Running it against dev Postgres would append a PERMANENT approval row to
// acquisition_decisions — an append-only table, on a database whose fictional
// row count is tracked in the runbook — to demonstrate a property this proves
// with none. The residue would buy the adapter's row mapping, which
// test/acquisition-store.test.js and the M8H/M8I proofs already cover.
//
// So the store here is a JSON file, and the two processes are genuinely two OS
// processes with no shared heap. Process A's memory is gone before B starts;
// everything B knows, it read back.
//
// ── WHAT THIS STORE IS AND IS NOT ───────────────────────────────────
// A thin persistence wrapper over createInMemoryAcquisitionStore — the same
// reference implementation the unit tests run against, seeded from the file and
// re-dumped after each write. It persists DECISIONS and SUPPRESSIONS, which is
// what this proof reads; everything else delegates and is not durable here. It
// is a proof harness, not an adapter, and nothing outside this directory uses
// it.
//
// NOTHING HERE TOUCHES A DATABASE, A NETWORK OR A PROVIDER.
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

const { createInMemoryAcquisitionStore } = require("../../../src/services/acquisition-store");
const { createProspect, transitionProspect } = require("../../../src/services/acquisition-prospect");
const { createEvidenceLedger } = require("../../../src/services/acquisition-evidence");
const { createWashStore } = require("../../../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../../../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../../../src/services/acquisition-attempt-policy");
const { resolveDuplicates } = require("../../../src/services/acquisition-dedupe");

// A fixed instant inside the permitted calling window, so neither process
// depends on when it happens to be run.
const AT = new Date("2026-08-05T04:00:00Z"); // Wednesday, 14:00 Melbourne
const clock = () => AT;

// Fictional. Belongs to no business. The 5550 block is reserved for fiction.
const NUMBER = "+61355501042";
const OTHER_NUMBER = "+61355501099";
const SOURCE = { url: "https://e5-batch-approval-probe.example.com.au/contact" };

const FOUNDER = "Peter Dang";

const STATE_FILE = path.resolve(process.env.E5_STATE || path.join(__dirname, ".e5-store.json"));
const HANDOFF = path.resolve(process.env.E5_HANDOFF || path.join(__dirname, ".process-a-approved.json"));

// -- The file-backed store -------------------------------------------

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { decisions: [], suppressions: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function makeStore() {
  const seed = readState();
  const inner = createInMemoryAcquisitionStore({ seed });

  const dump = async () => {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ decisions: await inner.listDecisions({ limit: 100000 }), suppressions: await inner.listSuppressions() }, null, 2)
    );
  };

  return Object.freeze({
    ...inner,
    kind: "file",
    async appendDecision(row) {
      const r = await inner.appendDecision(row);
      // Durable BEFORE visible, exactly as the real adapters: the file is
      // written before this call reports success.
      if (r && r.created) await dump();
      return r;
    },
    async appendSuppression(row) {
      const r = await inner.appendSuppression(row);
      await dump();
      return r;
    },
  });
}

function resetState() {
  for (const f of [STATE_FILE, HANDOFF]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

// -- The invented batch ----------------------------------------------

function fixtureProspect({ name = "E5 Batch Probe Locksmiths", suburb = "Coburg", phone = "(03) 5550 1042" } = {}) {
  let p = createProspect({
    businessName: name,
    tradeCategory: "Locksmith",
    suburb,
    state: "VIC",
    postcode: "3058",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: phone }],
    sourceRefs: [SOURCE],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: FOUNDER, reason: "E-5 proof fixture", now: clock }).prospect;
  }
  return p;
}

function evidenceFor(prospect) {
  const ledger = createEvidenceLedger({ now: clock });
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0].raw],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "e5-probe", source: SOURCE });
  }
  return ledger.forProspect(prospect.prospectId);
}

/** Everything the M8E gate needs EXCEPT the batch approval, which is durable. */
function gateInputs(prospect, e164 = NUMBER) {
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  washStore.wash(e164);
  const evidenceRows = evidenceFor(prospect);
  return {
    engineOptions: {
      washStore,
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }),
      counselApproved: true,
    },
    context: {
      evidenceRows,
      duplicateResolution: resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]),
      // DELIBERATELY NO `batch`. That is the point of the proof.
    },
  };
}

// -- Reporting -------------------------------------------------------

let passes = 0;
let failures = 0;

function check(id, claim, condition, detail) {
  const ok = condition === true;
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${id} ${ok ? "PASS" : "FAIL"}  ${claim}${detail ? `\n         ${detail}` : ""}`);
  return ok;
}

function summary(label) {
  console.log("");
  console.log("=".repeat(74));
  console.log(`${label}: ${passes} passed, ${failures} failed.`);
  console.log("=".repeat(74));
  console.log("");
  if (failures > 0) process.exitCode = 1;
}

module.exports = {
  AT,
  clock,
  NUMBER,
  OTHER_NUMBER,
  FOUNDER,
  STATE_FILE,
  HANDOFF,
  makeStore,
  resetState,
  fixtureProspect,
  evidenceFor,
  gateInputs,
  check,
  summary,
};
