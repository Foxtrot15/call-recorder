// ============================================================================
// M8E CROSS-PROCESS PROOF - PROCESS B (the stale one).
//
// Starts FIRST. Hydrates its suppression index while the business is still
// clear, then stays alive while process A commits an opt-out from a different
// process against the same database.
//
// B never rehydrates. Its memory is wrong for the rest of its life, exactly as
// a pilot worker's would be. The question M8E answers is whether that matters
// at the moment a call would be authorised.
//
// HANDSHAKE: two marker files in the OS temp directory, so the sequence is
// deterministic rather than timed. B publishes "hydrated" and waits for
// "written"; nothing here sleeps hopefully and assumes.
//
// RUN (start this one first, in its own shell):
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-crossprocess-proof/process-b.js
// ============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./common");

const HYDRATED = path.join(os.tmpdir(), "m8e-b-hydrated");
const WRITTEN = path.join(os.tmpdir(), "m8e-a-written");
const clock = () => new Date();

const waitFor = async (file, timeoutMs = 120000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

async function main() {
  console.log("=".repeat(74));
  console.log("M8E CROSS-PROCESS PROOF - PROCESS B (stale memory)");
  console.log("=".repeat(74));

  for (const f of [HYDRATED, WRITTEN]) if (fs.existsSync(f)) fs.rmSync(f);

  const client = C.makeClient(); // throws unless dev
  const store = C.makeStore(client);
  const prospect = C.probeProspect();

  console.log(`\nProject guard : dev ref ${C.DEV_REF} confirmed`);
  console.log(`Target        : ${prospect.businessName}`);
  console.log(`Fingerprint   : ${C.FINGERPRINT}`);
  console.log(`Number        : ${C.NUMBER}\n`);

  // -- 1. HYDRATE, BEFORE THE SUPPRESSION EXISTS ----------------------------
  const suppression = await C.createDurableSuppression({ now: clock, store });
  const beforeCount = suppression.count();
  const clearAtHydration = suppression.check({ e164: C.NUMBER, fingerprint: C.FINGERPRINT }).suppressed === false;

  C.check("B1", "B hydrated while the business was NOT suppressed", clearAtHydration, `${beforeCount} suppression(s) in B's index at hydration`);

  if (!clearAtHydration) {
    console.log("\nThe target is already suppressed, so the defining precondition cannot be");
    console.log("established. This proof is one-shot by design: re-running it would need a");
    console.log("SECOND permanent row, which is not approved. Nothing was written.");
    process.exit(1);
  }

  fs.writeFileSync(HYDRATED, new Date().toISOString(), "utf8");
  console.log("\n  -> B is hydrated and waiting. Run process-a.js now.\n");

  if (!(await waitFor(WRITTEN))) {
    console.log("Timed out waiting for process A. Nothing was written by B.");
    process.exit(1);
  }

  // -- 2. B'S MEMORY IS STALE, AND NOTHING WILL TELL IT ---------------------
  const stillClear = suppression.check({ e164: C.NUMBER, fingerprint: C.FINGERPRINT }).suppressed === false;
  C.check("B2", "STALE MEMORY: B's hydrated index still says the business is clear", stillClear, `B's index still holds ${suppression.count()} row(s); it has not rehydrated and nothing calls rehydrate()`);

  // -- 3. THE DATABASE DISAGREES -------------------------------------------
  const durable = await store.lookupSuppression({ fingerprint: C.FINGERPRINT, e164: C.NUMBER });
  C.check("B3", "AUTHORITATIVE STATE: Postgres holds the opt-out", durable.length >= 1, `${durable.length} row(s); reason=${durable[0] ? durable[0].reason : "n/a"} actor=${durable[0] ? durable[0].actor : "n/a"}`);

  // -- 4. THE MILESTONE ----------------------------------------------------
  const gate = C.createDialAuthoriser({ now: clock, store, engineOptions: C.engineOptionsFor(prospect, clock) });
  const decision = await gate.authorise(prospect, C.contextFor(prospect, clock));

  C.check("B4", "THE GATE REFUSES, from durable state, despite B's stale memory", decision.authorised === false && decision.code === "suppressed_permanently", `code=${decision.code} suppressionSource=${decision.suppressionSource}`);
  C.check("B5", "no dial permission was minted", decision.dial === null);

  // -- 5. DRIFTED RE-IMPORT ------------------------------------------------
  // Same business, different suburb, so a different identity fingerprint. The
  // opt-out was recorded against the number too, and the number is stable.
  const drifted = C.probeProspect({ suburb: "Coburg North" });
  const driftedFingerprint = C.identityFingerprint({ businessName: drifted.businessName, suburb: drifted.suburb, state: drifted.state });
  const driftedDecision = await gate.authorise(drifted, C.contextFor(drifted, clock));
  C.check("B6", "a drifted re-import is still refused", driftedDecision.authorised === false && driftedDecision.code === "suppressed_permanently", `identity moved ${C.FINGERPRINT.slice(0, 24)}... -> ${driftedFingerprint.slice(0, 24)}...`);

  // -- 6. FAIL CLOSED ------------------------------------------------------
  const brokenStore = {
    ...store,
    async lookupSuppression() {
      throw new Error("simulated connection loss");
    },
  };
  const brokenGate = C.createDialAuthoriser({ now: clock, store: brokenStore, engineOptions: C.engineOptionsFor(prospect, clock) });
  const brokenDecision = await brokenGate.authorise(prospect, C.contextFor(prospect, clock));
  C.check("B7", "an unreadable suppression store is BLOCKED, not assumed safe", brokenDecision.authorised === false && brokenDecision.code === "suppression_store_unavailable", `code=${brokenDecision.code} suppressionSource=${brokenDecision.suppressionSource}`);

  // -- 7. NO EXECUTION SURFACE --------------------------------------------
  const gateKeys = Object.keys(gate).sort().join(",");
  C.check("B8", "the gate exposes a decision and nothing that acts", gateKeys === "authorise,kind", `keys: ${gateKeys}`);
  C.check("B9", "an authorised decision is the only thing that could carry a dial, and none was issued", decision.dial === null && driftedDecision.dial === null && brokenDecision.dial === null);

  for (const f of [HYDRATED, WRITTEN]) if (fs.existsSync(f)) fs.rmSync(f);

  const ok = C.summary("PROCESS B");
  console.log("\nSTALE MEMORY and AUTHORITATIVE DATABASE STATE disagreed, and the gate");
  console.log("followed the database. Nothing was dialled; there is no dialler.");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPROCESS B FAILED:", err.message);
  process.exit(1);
});
