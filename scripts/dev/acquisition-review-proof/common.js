// ============================================================================
// M8H REVIEW-QUEUE PROOF - shared harness.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Reads credentials from a dev .env itself; the key never reaches a
//      command line, a shell history, or any output.
//   3. Contacts nothing but Postgres. No provider, no website, no dialler.
//   4. One INVENTED candidate on an invented number.
//
// APPROVED PERMANENT RESIDUE: 2 rows in acquisition_decisions and nothing else.
// The candidate is deliberately never persisted as a prospect.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

/** The invented candidate. Never written as a prospect — that is the point. */
const CANDIDATE_ID = "pr_m8h_review_probe_0001";
const REVIEW_ID = `rv_${CANDIDATE_ID}`;
/** The M8G business it might be. Read only; never modified by this proof. */
const POSSIBLE_MATCH = "pr_0b9f51cfe79018067bf1";

const candidate = () =>
  Object.freeze({
    prospectId: CANDIDATE_ID,
    businessName: "M8H Review Probe Locksmiths",
    tradeCategory: "Locksmith",
    suburb: "Coburg",
    state: "VIC",
    postcode: "3058",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 7101", label: "Listed number" }],
    origin: "operator_import",
  });

function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(__dirname, "..", "..", "..", "..", "call-recorder", ".env");
  if (!fs.existsSync(envPath)) throw new Error(`Cannot find ${envPath}. Set ACQUISITION_ENV_FILE.`);
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  if (!out.SUPABASE_URL || !out.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not found.");
  if (!out.SUPABASE_URL.includes(DEV_REF)) throw new Error(`REFUSING TO RUN. Expected dev ref ${DEV_REF}.`);
  return out;
}

function makeClient() {
  const env = loadEnv();
  const { createClient } = require("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const { createSupabaseAcquisitionStore } = require("../../../src/services/acquisition-store");
const makeStore = (client) => createSupabaseAcquisitionStore({ client });

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

module.exports = { DEV_REF, CANDIDATE_ID, REVIEW_ID, POSSIBLE_MATCH, candidate, loadEnv, makeClient, makeStore, check, summary };
