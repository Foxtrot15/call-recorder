// ============================================================================
// M8E CROSS-PROCESS PROOF - shared harness.
//
// Proves M-7 against real dev Postgres across two real Node processes, and
// proves the M8E gate closes it.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Reads credentials from a dev .env itself; the service key never reaches
//      a command line, a shell history, or any output.
//   3. Contacts nothing but Postgres. No Twilio, no Retell, no HTTP, no
//      dialler. There is no code path here that places or prepares a call.
//   4. Every identifier is m8e-crossprocess-probe. The business is invented.
//
// PERMANENT RESIDUE: exactly ONE row, approved in advance.
//   acquisition_suppressions: 1 fictional opt_out, actor m8e-crossprocess-probe
// No prospect row and no outcome row are needed, because suppressions carry no
// foreign key - which is the same design property M8E is proving the value of.
// The append-only trigger is never disabled.
//
// RUN with NODE_PATH pointing at the runtime worktree's node_modules.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";
const ACTOR = "m8e-crossprocess-probe";

const { createSupabaseAcquisitionStore } = require("../../../src/services/acquisition-store");
const { createDurableSuppression } = require("../../../src/services/acquisition-durable");
const { createDialAuthoriser } = require("../../../src/services/acquisition-authorisation");
const { createWashStore } = require("../../../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../../../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../../../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../../../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../../../src/services/acquisition-dedupe");
const { createProspect, transitionProspect, identityFingerprint } = require("../../../src/services/acquisition-prospect");

// -- Credentials -----------------------------------------------------

function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(__dirname, "..", "..", "..", "..", "call-recorder", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Cannot find ${envPath}. Set ACQUISITION_ENV_FILE to a dev .env holding SUPABASE_URL and SUPABASE_SERVICE_KEY.`);
  }
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  if (!out.SUPABASE_URL || !out.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not found in the dev .env");
  }
  if (!out.SUPABASE_URL.includes(DEV_REF)) {
    throw new Error(`REFUSING TO RUN. Expected the dev project ref ${DEV_REF}; SUPABASE_URL points elsewhere.`);
  }
  return out;
}

function makeClient() {
  const env = loadEnv();
  const { createClient } = require("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const makeStore = (client) => createSupabaseAcquisitionStore({ client });

// -- The invented business -------------------------------------------

const NUMBER = "+61355503881";
const MELBOURNE = "Australia/Melbourne";

function probeProspect({ suburb = "Coburg" } = {}) {
  const built = createProspect({
    businessName: "M8E Crossprocess Probe Locksmiths",
    tradeCategory: "Locksmith",
    suburb,
    state: "VIC",
    postcode: "3058",
    region: "Melbourne",
    timezone: MELBOURNE,
    phones: [{ raw: "(03) 5550 3881" }],
    sourceRefs: [{ url: "https://m8e-crossprocess-probe.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-08-01T02:00:00.000Z",
  });
  if (!built.ok) throw new Error(`fixture invalid: ${JSON.stringify(built.errors)}`);
  let p = built.prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: "m8e-probe", reason: "proof fixture", now: () => new Date() }).prospect;
  }
  return p;
}

const FINGERPRINT = identityFingerprint({ businessName: "M8E Crossprocess Probe Locksmiths", suburb: "Coburg", state: "VIC" });

// -- Everything the gate needs, all real modules ----------------------

function engineOptionsFor(prospect, clock) {
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  washStore.wash(NUMBER);
  return {
    washStore,
    holidays: createFixtureHolidayProvider(),
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "m8e-probe" }),
    counselApproved: true,
  };
}

function contextFor(prospect, clock) {
  const ledger = createEvidenceLedger({ now: clock });
  const source = { url: "https://m8e-crossprocess-probe.example.com.au/contact" };
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0].raw],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-08-01T02:00:00.000Z", capturedBy: "m8e-probe", source });
  }
  const evidenceRows = ledger.forProspect(prospect.prospectId);
  return {
    evidenceRows,
    duplicateResolution: resolveDuplicates([{ ...prospect, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]),
    batch: { approved: true, batchHash: "m8ecrossproc01", approvedBy: "m8e-probe" },
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
  return failures === 0;
}

module.exports = {
  DEV_REF,
  ACTOR,
  NUMBER,
  FINGERPRINT,
  loadEnv,
  makeClient,
  makeStore,
  probeProspect,
  engineOptionsFor,
  contextFor,
  createDurableSuppression,
  createDialAuthoriser,
  identityFingerprint,
  check,
  summary,
};
