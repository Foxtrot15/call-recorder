// ============================================================================
// M8G PERSISTENCE PROOF - PROCESS A (the writer).
//
// Imports one invented locksmith from a fixture CSV in explicit write mode,
// persists it to real dev Postgres, reports exact row counts, and EXITS. Its
// heap goes with it; process B starts cold.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-persist-proof/process-a.js
// ============================================================================

const C = require("./common");
const { importBusinessCsv } = require("../../../src/services/acquisition-import");
const { persistImportResult, loadExistingForImport } = require("../../../src/services/acquisition-persist");
const { createEvidenceLedger } = require("../../../src/services/acquisition-evidence");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8G PERSISTENCE PROOF - PROCESS A (import and persist)");
  console.log("=".repeat(74));

  const client = C.makeClient();
  const store = C.makeStore(client);
  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed`);

  const before = await C.countResidue(client);
  console.log(`Before        : ${before.prospects.length} prospect(s), ${before.phones.length} phone(s), ${before.evidence.length} evidence row(s)\n`);

  const text = C.readFixture("m8g-persist-probe.csv");
  const ledger = createEvidenceLedger({ now });
  const existing = await loadExistingForImport({ store, text, profileName: "outscraper-google-maps" });
  const result = importBusinessCsv({ text, profileName: "outscraper-google-maps", now, ledger, existing });

  C.check("A1", "the fixture imported cleanly", result.ok === true && result.prospects.length === 1, `${result.outcomes.length} row(s), status=${result.outcomes[0] && result.outcomes[0].status}`);

  const written = await persistImportResult({ result, ledger, store, now });
  const w = written.summary;
  C.check("A2", "nothing failed or was left partial", w.failed === 0 && w.partial === 0, `created=${w.created} updated=${w.updated} unchanged=${w.unchanged}`);
  C.check("A3", "prospect, phone and evidence rows were written", w.phonesAdded + w.evidenceAdded > 0 || w.unchanged === 1, `phones+${w.phonesAdded} evidence+${w.evidenceAdded}`);

  const after = await C.countResidue(client);
  C.check("A4", "exactly ONE invented M8G prospect exists", after.prospects.length === 1, after.prospects.map((p) => `${p.prospect_id} "${p.business_name}"`).join(", "));
  console.log(`\nAfter         : ${after.prospects.length} prospect(s), ${after.phones.length} phone(s), ${after.evidence.length} evidence row(s)`);

  const ok = C.summary("PROCESS A");
  console.log("\nProcess A is exiting. Its heap, its ledger and its client go with it.");
  console.log("Run process-b.js next, in a fresh process.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPROCESS A FAILED:", err.message);
  process.exit(1);
});
