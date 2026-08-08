// ============================================================================
// M8G PERSISTENCE PROOF - shared harness.
//
// Proves that an imported prospect survives a real process restart against real
// dev Postgres, and that re-importing it merges rather than multiplying.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. Reads credentials from a dev .env itself; the key never reaches a
//      command line, a shell history, or any output.
//   3. Contacts nothing but Postgres. No provider, no website, no dialler.
//   4. ONE invented business, "M8G Persist Probe Locksmiths", on invented
//      numbers. No real prospect data.
//
// APPROVED PERMANENT RESIDUE: whatever laq1 necessarily pins for that one
// business - its prospect row, its phone row(s) and its evidence rows. Evidence
// is append-only and the prospect is pinned by ON DELETE RESTRICT, so those
// cannot be removed without disabling permanence controls, which is forbidden.
// No suppression, no outcome, no queue row and no qualification row is created.
//
// The suppression half of the proof reuses the EXISTING M8E fictional opt-out
// (actor m8e-crossprocess-probe, +61355503881). No new suppression is written.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

/** The one invented business this proof creates. */
const PROBE_NAME = "M8G Persist Probe Locksmiths";
const PROBE_PLACE_IDS = ["PLACE-M8G-0001", "PLACE-M8G-0002"];
const PROBE_DISCOVERED_BY = "import:outscraper-google-maps";

/** The EXISTING M8E suppression, reused rather than adding another. */
const M8E_ACTOR = "m8e-crossprocess-probe";
const M8E_NUMBER = "+61355503881";
const M8E_BUSINESS = "M8E Crossprocess Probe Locksmiths";

const FIXTURES = path.resolve(__dirname, "..", "..", "..", "test", "fixtures");
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

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
  if (!out.SUPABASE_URL || !out.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not found in the dev .env");
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

const { createSupabaseAcquisitionStore } = require("../../../src/services/acquisition-store");
const makeStore = (client) => createSupabaseAcquisitionStore({ client });

// ── Reporting ───────────────────────────────────────────────────────

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

/** Every M8G row currently in dev, by table. Read-only. */
async function countResidue(client) {
  const prospects = await client.from("acquisition_prospects").select("prospect_id,business_name").eq("discovered_by", PROBE_DISCOVERED_BY);
  if (prospects.error) throw new Error(prospects.error.message);
  const ids = (prospects.data || []).map((r) => r.prospect_id);

  let phones = { data: [] };
  let evidence = { data: [] };
  if (ids.length > 0) {
    phones = await client.from("acquisition_prospect_phones").select("id,prospect_id,raw").in("prospect_id", ids);
    if (phones.error) throw new Error(phones.error.message);
    evidence = await client.from("acquisition_evidence").select("id,prospect_id,kind").in("prospect_id", ids);
    if (evidence.error) throw new Error(evidence.error.message);
  }

  return {
    prospects: prospects.data || [],
    phones: phones.data || [],
    evidence: evidence.data || [],
  };
}

module.exports = {
  DEV_REF,
  PROBE_NAME,
  PROBE_PLACE_IDS,
  PROBE_DISCOVERED_BY,
  M8E_ACTOR,
  M8E_NUMBER,
  M8E_BUSINESS,
  loadEnv,
  makeClient,
  makeStore,
  readFixture,
  countResidue,
  check,
  summary,
};
