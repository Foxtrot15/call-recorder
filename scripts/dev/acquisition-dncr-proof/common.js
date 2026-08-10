// ============================================================================
// M8K / E-3 DNCR DURABILITY PROOF — shared harness. READ-ONLY THROUGHOUT.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Reads credentials from a dev .env itself; the key never reaches a
//      command line, a shell history, or any output.
//   3. Contacts nothing but Postgres. No DNCR account, no Register, no API, no
//      SOAP, no SFTP, no provider, no dialler, no prospect.
//   4. SELECT ONLY. There is no insert, update or delete anywhere in this
//      directory, and nothing it calls can write: the store's read methods and
//      the pure eligibility engine are all that is used.
//
// ── THE RESIDUE, STATED BEFORE ANYTHING RUNS ────────────────────────
// NONE. Not one row is created, changed or removed by any file here.
//
// The subject already exists: ONE fictional wash row against +61355509999,
// written by hand during the laq4 verification on 2026-08-09 and counted in the
// dev fictional total of 21. This proof READS it. It does not re-insert it, and
// it does not re-run any part of section 5 of 11_laq4_verify.sql.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

/** The one fictional wash row laq4's verification left on dev. */
const SUBJECT = "+61355509999";

/** What the founder's report says is stored. Every field is checked, not assumed. */
const EXPECTED = Object.freeze({
  e164: SUBJECT,
  result: "not_listed",
  washedAt: "2026-08-09T00:00:00Z",
  attestedBy: "laq4-verify",
  mode: "import",
  authoritative: true,
  batchRef: "laq4-verify-batch",
  source: "verification probe",
});

/** Nine tables now: laq1's four, laq2's four, and laq4's one. */
const ACQUISITION_TABLES = Object.freeze([
  "acquisition_prospects",
  "acquisition_prospect_phones",
  "acquisition_evidence",
  "acquisition_decisions",
  "acquisition_suppressions",
  "acquisition_qualifications",
  "acquisition_call_queue",
  "acquisition_contact_outcomes",
  "acquisition_dncr_washes",
]);

const EXPECTED_TOTAL_ROWS = 21;

// ── The two instants this proof reasons about ───────────────────────
//
// Fixed rather than "now", so the answer does not depend on the day somebody
// runs it. Both are evaluated against the SAME stored row, which never changes.
//
//   washed_at            2026-08-09T00:00:00Z
//   FRESH_AT   +6 days   inside the 30-day statutory validity
//   STALE_AT  +42 days   outside it
const FRESH_AT = new Date("2026-08-15T00:00:00.000Z");
const STALE_AT = new Date("2026-09-20T00:00:00.000Z");

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

/** Exact row counts, straight off PostgREST's content-range. */
async function counts() {
  const https = require("https");
  const env = loadEnv();
  const H = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    Accept: "application/json",
    Prefer: "count=exact",
    Range: "0-0",
  };
  const out = {};
  for (const t of ACQUISITION_TABLES) {
    out[t] = await new Promise((res, rej) => {
      https
        .get(`${env.SUPABASE_URL}/rest/v1/${t}?select=*`, { headers: H }, (r) => {
          let b = "";
          r.on("data", (d) => (b += d));
          r.on("end", () => res(Number(String(r.headers["content-range"] || "0-0/0").split("/")[1] || 0)));
        })
        .on("error", rej);
    });
  }
  return out;
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

module.exports = {
  DEV_REF,
  SUBJECT,
  EXPECTED,
  ACQUISITION_TABLES,
  EXPECTED_TOTAL_ROWS,
  FRESH_AT,
  STALE_AT,
  loadEnv,
  makeClient,
  makeStore,
  counts,
  check,
  summary,
};
