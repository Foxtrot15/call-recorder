// ============================================================================
// M8L RESTART PROOF — shared fixtures and a file-backed store.
//
//   node scripts/dev/acquisition-duplicate-proof/process-a.js
//   node scripts/dev/acquisition-duplicate-proof/process-b.js
//
// ── WHY A FILE AND NOT POSTGRES ─────────────────────────────────────
// The claim M8L has to prove is that a duplicate resolved by a human in one
// process is still resolved for a process that has never seen it, and that a
// caller who says otherwise cannot override it. What makes that true is the fold
// over append-only review decisions, and that fold does not know or care which
// durable thing the rows came out of.
//
// Running it against dev would append PERMANENT review rows to
// acquisition_decisions — an append-only table — to demonstrate a property this
// proves with none. The M8H review queue and the M8I decision chain were both
// already proven against real dev Postgres; nothing about the substrate is in
// question here.
//
// So the store is a JSON file, and the two processes are genuinely two OS
// processes with no shared heap.
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
const { FOUNDER_CALLING_POLICY, createCallingPolicyApproval } = require("../../../src/services/acquisition-calling-approval");

const AT = new Date("2026-08-05T04:00:00Z"); // Wednesday, 14:00 Melbourne
const clock = () => AT;

// Fictional. The 5550 block belongs to no business.
const NUMBER = "+61355501042";
const CANONICAL_NUMBER = "+61355501077";
const SOURCE = { url: "https://m8l-duplicate-probe.example.com.au/contact" };
const FOUNDER = "Peter Dang";

const STATE_FILE = path.resolve(process.env.M8L_STATE || path.join(__dirname, ".m8l-store.json"));
const HANDOFF = path.resolve(process.env.M8L_HANDOFF || path.join(__dirname, ".process-a-decided.json"));

// -- The file-backed store -------------------------------------------

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { decisions: [], prospects: [], suppressions: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function makeStore() {
  const seed = readState();
  const inner = createInMemoryAcquisitionStore({ seed });
  const known = new Set((seed.prospects || []).map((p) => p.prospectId));

  const dump = async () => {
    const prospects = [];
    for (const id of known) {
      const p = await inner.loadProspect(id);
      if (p) prospects.push(p);
    }
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        { decisions: await inner.listDecisions({ limit: 100000 }), prospects, suppressions: await inner.listSuppressions() },
        null,
        2
      )
    );
  };

  return Object.freeze({
    ...inner,
    kind: "file",
    async appendDecision(row) {
      const r = await inner.appendDecision(row);
      // Durable BEFORE visible, exactly as the real adapters.
      if (r && r.created) await dump();
      return r;
    },
    async upsertProspect(row) {
      const r = await inner.upsertProspect(row);
      known.add(row.prospectId);
      await dump();
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

// -- Fixtures --------------------------------------------------------

function fixtureProspect({ name, suburb, phone }) {
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
    p = transitionProspect(p, to, { actor: FOUNDER, reason: "M8L proof fixture", now: clock }).prospect;
  }
  return p;
}

/** The business already known, and the ambiguous candidate that may be it. */
const canonical = () => fixtureProspect({ name: "M8L Canonical Locksmiths", suburb: "Coburg", phone: "(03) 5550 1077" });
const candidate = () => fixtureProspect({ name: "M8L Ambiguous Locks", suburb: "Preston", phone: "(03) 5550 1042" });

function evidenceFor(prospect) {
  const ledger = createEvidenceLedger({ now: clock });
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0].raw],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "m8l-probe", source: SOURCE });
  }
  return ledger.forProspect(prospect.prospectId);
}

/** Everything the M8E gate needs except the durable answers it reads itself. */
function gateInputs(prospect, e164) {
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  washStore.wash(e164);
  return {
    engineOptions: {
      washStore,
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }),
      callingPolicyApproval: FOUNDER_CALLING_POLICY,
    },
    // NO duplicateResolution and NO batch. That is the point of the proof.
    context: { evidenceRows: evidenceFor(prospect) },
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
  CANONICAL_NUMBER,
  FOUNDER,
  STATE_FILE,
  HANDOFF,
  makeStore,
  resetState,
  canonical,
  candidate,
  evidenceFor,
  gateInputs,
  check,
  summary,
};
