// ============================================================================
// M8I CONCURRENCY PROOF - shared harness.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Reads credentials from a dev .env itself; the key never reaches a
//      command line, a shell history, or any output.
//   3. Contacts nothing but Postgres. No provider, no dialler, no website, no
//      prospect. Nothing here can cause anybody to be contacted.
//   4. Writes to ONE table, acquisition_decisions, and to nothing else.
//
// APPROVED PERMANENT RESIDUE: exactly 2 rows in acquisition_decisions, both
// fictional, taking the dev total from 18 to 20. One per process. No prospect,
// phone, evidence, suppression, outcome, queue or qualification row.
//
// ── THE GATE, AND WHY IT IS AN ATTESTATION RATHER THAN A CHECK ──────
// This proof MUST NOT run before laq3 is applied. Without the unique index the
// two processes would not race for the head; they would BOTH succeed, and the
// decision chain on dev would be permanently forked in a table where nothing
// can be deleted. That is the one outcome this milestone must never produce.
//
// The script cannot verify the index itself. PostgREST exposes the `public`
// schema, not the catalog, so pg_indexes is unreachable from here, and every
// behavioural probe for "is uniqueness enforced" requires attempting the very
// insert that would cause the damage if it is not.
//
// So the operator attests to it, and the attestation is the definition rather
// than a yes: M8I_LAQ3_INDEXDEF must be set to the exact string that
// verification query V3 printed. A checkbox can be ticked without looking; a
// definition has to be copied from the output of the check.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

/** The invented subject. Deliberately never persisted as a prospect. */
const PROBE_ENTITY = "pr_m8i_race_probe_0001";
const PROBE_CORRELATION = "m8i-concurrency-proof";

/** Exactly what 09_laq3_verify.sql V3 must have printed. */
const EXPECTED_INDEXDEF = "CREATE UNIQUE INDEX uq_acq_decisions_prev_hash ON public.acquisition_decisions USING btree (prev_hash)";

function requireLaq3Attestation() {
  const given = (process.env.M8I_LAQ3_INDEXDEF || "").trim().replace(/\s+/g, " ").replace(/;$/, "");
  if (given !== EXPECTED_INDEXDEF) {
    throw new Error(
      "REFUSING TO RUN: laq3 has not been attested.\n\n" +
        "  Apply supabase/sql/laq3_serialise_decision_chain.sql to DEV, run\n" +
        "  supabase/sql/verification/09_laq3_verify.sql, and set the V3 detail\n" +
        "  string as M8I_LAQ3_INDEXDEF before running this proof.\n\n" +
        `  expected: ${EXPECTED_INDEXDEF}\n` +
        `  got:      ${given || "(unset)"}\n\n` +
        "  Running without the index would not race - both processes would\n" +
        "  succeed and fork the dev decision chain permanently."
    );
  }
}

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

module.exports = {
  DEV_REF,
  PROBE_ENTITY,
  PROBE_CORRELATION,
  EXPECTED_INDEXDEF,
  requireLaq3Attestation,
  loadEnv,
  makeClient,
  makeStore,
  check,
  summary,
};
