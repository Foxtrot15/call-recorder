// ============================================================================
// M8J / E-2 LIFECYCLE PROOF — shared harness.  NOT YET RUN.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Reads credentials from a dev .env itself; the key never reaches a
//      command line, a shell history, or any output.
//   3. Contacts nothing but Postgres. No provider, no dialler, no website, no
//      prospect. Nothing here can cause anybody to be contacted.
//   4. Writes to ONE column of ONE existing row, and puts it back.
//
// ── THE RESIDUE, STATED BEFORE ANYTHING IS WRITTEN ──────────────────
// NO NEW ROW IN ANY TABLE. NO APPEND-ONLY TABLE IS TOUCHED. The decision log,
// the evidence ledger, the suppression list and the outcome ledger are all
// read-only from here.
//
// The subject is pr_3740207ebbc0a379910f — "M8D Restart Probe Locksmiths", a
// fictional business on a fictional number, already on dev since M8D and
// already sitting at lifecycle `review_approved`.
//
// The proof is a ROUND TRIP:
//
//     review_approved  ->  review_pending  ->  review_approved
//
// Both hops are legal in the state machine and both are inside laq1's CHECK, so
// the prospect ENDS EXACTLY WHERE IT STARTED. What remains afterwards is:
//
//     * 2 new entries in that one row's `history` jsonb journal
//     * a bumped `updated_at` on that one row
//
// and nothing else. The lifecycle value itself is unchanged from before the
// run. This is the smallest write that can prove a compare-and-set actually
// compares and actually sets against real Postgres — the offline tests cannot,
// because the in-memory store is not the thing being doubted.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

/**
 * The subject. Chosen because it is ALREADY at review_approved, which is what
 * makes the round trip end where it began. An M8G prospect sitting at
 * `discovered` could not be put back — `review_pending -> discovered` is not a
 * legal transition, and this proof will not weaken the state machine to tidy up
 * after itself.
 */
const SUBJECT = "pr_3740207ebbc0a379910f";
const EXPECTED_START = "review_approved";
const VIA = "review_pending";

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

/** The operator has to say they accept the journal entries. */
function requireWriteConsent() {
  if (process.env.M8J_LIFECYCLE_PROOF_WRITE !== "yes") {
    throw new Error(
      "REFUSING TO WRITE.\n\n" +
        `  This proof appends 2 entries to ${SUBJECT}'s history journal and bumps\n` +
        "  its updated_at. It creates no rows and leaves the lifecycle value\n" +
        "  exactly as it found it.\n\n" +
        "  Set M8J_LIFECYCLE_PROOF_WRITE=yes to proceed."
    );
  }
}

let passes = 0;
let failures = 0;
function check(id, claim, ok, detail) {
  if (ok === true) passes += 1;
  else failures += 1;
  console.log(`${id} ${ok === true ? "PASS" : "FAIL"}  ${claim}${detail ? `\n         ${detail}` : ""}`);
  return ok === true;
}
function summary(label) {
  console.log("");
  console.log("=".repeat(74));
  console.log(`${label}: ${passes} passed, ${failures} failed.`);
  console.log("=".repeat(74));
  return failures === 0;
}

module.exports = { DEV_REF, SUBJECT, EXPECTED_START, VIA, loadEnv, makeClient, makeStore, requireWriteConsent, check, summary };
