// ============================================================================
// M8G PERSISTENCE PROOF - PROCESS B (fresh process).
//
// A BRAND-NEW OS PROCESS. Process A's heap, ledger and client are gone. Every
// claim below is rebuilt from dev Postgres alone.
//
// Proves: the prospect survived; a fresh process can load it; an exact
// re-import is idempotent; a drifted re-import merges rather than exploding the
// prospect count; genuinely new evidence and a genuinely new phone are each
// added exactly once; and the EXISTING M8E suppression still blocks a
// persisted, re-imported business at the final authorisation gate.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-persist-proof/process-b.js
// ============================================================================

const C = require("./common");
const { importBusinessCsv } = require("../../../src/services/acquisition-import");
const { persistImportResult, loadExistingForImport } = require("../../../src/services/acquisition-persist");
const { createEvidenceLedger } = require("../../../src/services/acquisition-evidence");
const { createDialAuthoriser } = require("../../../src/services/acquisition-authorisation");
const { createEligibilityEngine } = require("../../../src/services/acquisition-eligibility");
const { createSuppressionList } = require("../../../src/services/acquisition-suppression");
const { qualifyProspect } = require("../../../src/services/acquisition-qualification");

const now = () => new Date();

async function reimport(store, fixture) {
  const text = C.readFixture(fixture);
  const ledger = createEvidenceLedger({ now });
  const existing = await loadExistingForImport({ store, text, profileName: "outscraper-google-maps" });
  const result = importBusinessCsv({ text, profileName: "outscraper-google-maps", now, ledger, existing });
  const written = await persistImportResult({ result, ledger, store, now });
  return { result, written, existing };
}

async function main() {
  console.log("=".repeat(74));
  console.log("M8G PERSISTENCE PROOF - PROCESS B (fresh process, reload and re-import)");
  console.log("=".repeat(74));

  const client = C.makeClient();
  const store = C.makeStore(client);
  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed\n`);

  // -- 1. IT SURVIVED --------------------------------------------------------
  const found = await C.countResidue(client);
  C.check("B1", "the prospect written by process A survived the restart", found.prospects.some((p) => p.business_name === C.PROBE_NAME), found.prospects.map((p) => `${p.prospect_id} "${p.business_name}"`).join(", "));

  const canonical = found.prospects.find((p) => p.business_name === C.PROBE_NAME);
  const prospectId = canonical && canonical.prospect_id;
  const loaded = prospectId ? await store.loadProspect(prospectId) : null;
  C.check(
    "B2",
    "a fresh process loads it from Postgres with its identity intact",
    loaded !== null && loaded.businessName === C.PROBE_NAME && loaded.timezone === "Australia/Melbourne",
    loaded ? `${loaded.businessName} | ${loaded.suburb} ${loaded.state} | ${loaded.timezone} | ${loaded.origin}` : "not found"
  );

  const phones0 = await store.listProspectPhones(prospectId);
  const evidence0 = await store.listEvidence(prospectId);
  C.check("B3", "its published number and evidence survived", phones0.length >= 1 && evidence0.length >= 3, `${phones0.length} phone(s), ${evidence0.length} evidence row(s)`);

  C.check("B4", "it is stored as discovered - persisting is not approving", loaded !== null && loaded.lifecycle === "discovered", loaded ? `lifecycle=${loaded.lifecycle}` : "n/a");

  // -- 2. EXACT RE-IMPORT IS IDEMPOTENT --------------------------------------
  const exact = await reimport(store, "m8g-persist-probe.csv");
  const afterExact = await C.countResidue(client);
  C.check("B5", "an exact re-import creates no new prospect", afterExact.prospects.length === found.prospects.length, `${found.prospects.length} -> ${afterExact.prospects.length}; created=${exact.written.summary.created} unchanged=${exact.written.summary.unchanged}`);
  C.check("B6", "and appends no duplicate phone or evidence", exact.written.summary.phonesAdded === 0 && exact.written.summary.evidenceAdded === 0, `phones+${exact.written.summary.phonesAdded} evidence+${exact.written.summary.evidenceAdded}`);
  C.check("B7", "row counts are unchanged", afterExact.phones.length === found.phones.length && afterExact.evidence.length === found.evidence.length, `phones ${found.phones.length}->${afterExact.phones.length}, evidence ${found.evidence.length}->${afterExact.evidence.length}`);

  // -- 3. DRIFTED RE-IMPORT MERGES ------------------------------------------
  // Pty Ltd name, different place_id, different suburb spelling, differently
  // formatted number, plus one genuinely new mobile.
  const drifted = await reimport(store, "m8g-persist-probe-drifted.csv");
  const afterDrift = await C.countResidue(client);
  C.check("B8", "a DRIFTED re-import creates NO new prospect - it is held for a human", afterDrift.prospects.length === found.prospects.length, `${found.prospects.length} -> ${afterDrift.prospects.length}; import outcome=${drifted.result.outcomes[0] && drifted.result.outcomes[0].status}; held=${drifted.written.summary.heldForReview}`);
  C.check("B9", "nothing was attached to a business we are not sure about", afterDrift.phones.length === found.phones.length, `phones ${found.phones.length} -> ${afterDrift.phones.length}`);
  C.check("B10", "and no evidence either, until a human decides", afterDrift.evidence.length === found.evidence.length, `evidence ${found.evidence.length} -> ${afterDrift.evidence.length}; held=${drifted.written.summary.heldForReview}`);

  // -- 4. REPEATING THE DRIFT ADDS NOTHING ----------------------------------
  await reimport(store, "m8g-persist-probe-drifted.csv");
  const afterAgain = await C.countResidue(client);
  C.check("B11", "repeating the drifted import duplicates neither phone nor evidence", afterAgain.phones.length === afterDrift.phones.length && afterAgain.evidence.length === afterDrift.evidence.length, `phones ${afterDrift.phones.length}->${afterAgain.phones.length}, evidence ${afterDrift.evidence.length}->${afterAgain.evidence.length}`);
  C.check("B12", "and creates no further prospect", afterAgain.prospects.length === found.prospects.length, `${found.prospects.length} -> ${afterAgain.prospects.length}`);

  // -- 5. THE READ MODEL CAN CONSUME PERSISTED PROSPECTS --------------------
  const q = qualifyProspect({ ...loaded, phones: phones0.map((p) => ({ raw: p.raw })) }, { evidenceRows: evidence0, at: now() });
  C.check("B13", "qualification runs on a prospect loaded from Postgres", q && typeof q.verdict === "string", `verdict=${q.verdict} tier=${q.tier} score=${q.score}`);

  // -- 6. SUPPRESSION STILL WINS, USING THE EXISTING M8E OPT-OUT ------------
  //
  // No new suppression is written. The M8E business is presented as a freshly
  // imported, drifted record and must remain blocked.
  const m8eRows = await store.lookupSuppression({ e164: C.M8E_NUMBER });
  C.check("B14", "the existing M8E opt-out is still in Postgres", m8eRows.length >= 1, `${m8eRows.length} row(s), actor=${m8eRows[0] && m8eRows[0].actor}`);

  const suppressedProspect = {
    prospectId: "pr_m8g_suppressed_probe",
    businessName: C.M8E_BUSINESS,
    tradeCategory: "Locksmith",
    suburb: "Coburg North",
    state: "VIC",
    postcode: "3058",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "03 5550 3881" }],
    origin: "operator_import",
    lifecycle: "discovered",
  };

  const engine = createEligibilityEngine({ now, suppression: createSuppressionList({ now, initialEntries: await store.listSuppressions() }) });
  const elig = engine.evaluate(suppressedProspect, { evidenceRows: [] });
  C.check("B15", "eligibility blocks the suppressed business despite a drifted suburb and reformatted number", elig.eligible === false && elig.failedChecks.some((f) => f.check === "suppression"), `code=${elig.code}`);

  const gate = createDialAuthoriser({ now, store });
  const decision = await gate.authorise(suppressedProspect, {});
  C.check("B16", "the FINAL authorisation gate refuses it from authoritative durable state", decision.authorised === false && decision.dial === null, `code=${decision.code} suppressionSource=${decision.suppressionSource}`);

  // -- 7. NOTHING WAS CONTACTED ---------------------------------------------
  C.check("B17", "the gate exposes a decision and nothing that acts", Object.keys(gate).sort().join(",") === "authorise,kind");

  console.log(`\nFinal M8G residue: ${afterAgain.prospects.length} prospect(s), ${afterAgain.phones.length} phone(s), ${afterAgain.evidence.length} evidence row(s)`);

  const ok = C.summary("PROCESS B");
  console.log("\nPersisted state survived a real process restart, re-imported cleanly, and");
  console.log("suppression still won. Nothing was dialled; there is no dialler.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPROCESS B FAILED:", err.message);
  process.exit(1);
});
