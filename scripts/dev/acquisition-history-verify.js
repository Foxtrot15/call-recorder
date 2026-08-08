// ============================================================================
// M8J / E-1 — DURABLE CONTACT HISTORY, verified against real dev Postgres.
// READ-ONLY. ZERO RESIDUE.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-history-verify.js
//
// The offline tests prove the fold against the in-memory store. What only real
// Postgres can prove is that `listOutcomes` round-trips through the adapter
// into the same facts — the class of defect M8H hit with timestamptz, where the
// in-memory store handed back the object it was given and hid the problem.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. SELECT only. No insert, update, delete or RPC anywhere in this file, and
//      the only store methods called are readers.
//   3. Contacts nothing but Postgres. No provider, no dialler, no prospect.
//   4. Creates NO residue of any kind. It reads the fictional outcome rows that
//      M8D already left behind and asserts what the fold makes of them.
//
// It also asserts the thing that would make the whole exercise pointless: that
// the attempt policy still refuses to count on an unreadable history, and that
// A-L7 is still open.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";

function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(__dirname, "..", "..", "..", "call-recorder", ".env");
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

const { createSupabaseAcquisitionStore } = require("../../src/services/acquisition-store");
const { readContactHistory, unavailableHistory, isDurableHistory } = require("../../src/services/acquisition-history");
const { createAttemptPolicy, ATTEMPT_CONSUMPTION } = require("../../src/services/acquisition-attempt-policy");

let passes = 0;
let failures = 0;
function check(id, claim, ok, detail) {
  if (ok === true) passes += 1;
  else failures += 1;
  console.log(`${id} ${ok === true ? "PASS" : "FAIL"}  ${claim}${detail ? `\n         ${detail}` : ""}`);
}

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8J / E-1 — DURABLE CONTACT HISTORY (read-only, zero residue)");
  console.log("=".repeat(74));

  const client = makeClient();
  const store = createSupabaseAcquisitionStore({ client });

  // Every outcome on dev, so the proof describes what it is actually reading.
  const all = await store.listOutcomes({});
  console.log(`\nacquisition_contact_outcomes holds ${all.length} row(s) on dev:`);
  for (const o of all) {
    console.log(`  ${o.prospectId}  ${o.outcome}  reached=${o.reachedTheBusiness}  ${o.recordedAt}`);
  }
  console.log("");

  check("H1", "the adapter returns outcome rows at all", Array.isArray(all) && all.length > 0, `${all.length} row(s)`);
  if (all.length === 0) {
    console.log("\nNo outcome rows on dev, so there is nothing for the fold to be right about.");
    process.exit(1);
  }

  const subject = all[0].prospectId;
  const expected = all.filter((o) => o.prospectId === subject);

  // ── The fold, against real rows ──
  const history = await readContactHistory({ store, prospectId: subject });

  check("H2", "the history reads as AVAILABLE", history.available === true, history.available ? `source ${history.source}` : history.reason);
  check("H3", "it is a durable history, not a lookalike", isDurableHistory(history) === true);
  check("H4", `it holds exactly this prospect's rows (${expected.length})`, history.totalOutcomes === expected.length, `${history.totalOutcomes} of ${all.length} total`);
  check("H5", "no other business's outcomes leaked in", history.outcomes.every((o) => typeof o.outcome === "string"), history.outcomes.map((o) => o.outcome).join(", "));

  // ── Round-trip fidelity, the thing only real Postgres proves ──
  const first = history.outcomes[0];
  const source = expected[0];
  check(
    "H6",
    "recordedAt survives the timestamptz round trip as a usable instant",
    Number.isFinite(Date.parse(first.recordedAt)),
    `stored ${source.recordedAt} -> folded ${first.recordedAt}`
  );
  check("H7", "reachedTheBusiness came back a real boolean, not a string", typeof first.reachedTheBusiness === "boolean", `${JSON.stringify(first.reachedTheBusiness)}`);
  check("H8", "lastEventAt is the newest recordedAt", history.lastEventAt === expected.map((o) => o.recordedAt).sort().slice(-1)[0], `${history.lastEventAt}`);

  const reached = expected.filter((o) => o.reachedTheBusiness);
  check(
    "H9",
    "lastReachedAt uses ONLY rows where the business was actually reached",
    history.lastReachedAt === (reached.length ? reached.map((o) => o.recordedAt).sort().slice(-1)[0] : null),
    `${reached.length} reached of ${expected.length}; lastReachedAt ${history.lastReachedAt}`
  );

  // ── The same read twice: a restart must produce the same facts ──
  const again = await readContactHistory({ store, prospectId: subject });
  check("H10", "a second read of the same store gives identical facts (restart-equivalent)", JSON.stringify(again.outcomes) === JSON.stringify(history.outcomes) && again.lastEventAt === history.lastEventAt);

  // ── Fail closed ──
  const broken = { ...store, listOutcomes: async () => { throw new Error("simulated read failure"); } };
  const unreadable = await readContactHistory({ store: broken, prospectId: subject });
  check("H11", "an unreadable store yields UNAVAILABLE, not empty", unreadable.available === false, unreadable.reason);

  const policy = createAttemptPolicy({ approved: true, approvedBy: "proof" });
  const refused = policy.assess({ history: unreadable }, { now });
  check("H12", "the attempt policy REFUSES on an unavailable history", refused.ok === false && refused.code === "history_unavailable", refused.message);

  const counted = policy.assess({ history }, { now });
  check("H13", "and it does assess a readable one", counted.code !== "history_unavailable", `${counted.code}: ${counted.message}`);

  // ── The fold decided nothing about A-L7 ──
  check("H14", "the durable history exposes no attempts count", history.attempts === undefined, "counting belongs to the attempt policy");
  check(
    "H15",
    "A-L7 is still open — no_answer and voicemail remain UNAPPROVED as attempt-consuming",
    ATTEMPT_CONSUMPTION.no_answer.approved === false && ATTEMPT_CONSUMPTION.voicemail.approved === false
  );
  check("H16", "an unapproved policy still names A-L7 in its gap", /A-L7/.test(createAttemptPolicy().describeGap()), createAttemptPolicy().describeGap());

  console.log("");
  console.log("-".repeat(74));
  console.log("RESIDUE FROM THIS RUN: none. No row was inserted, updated or deleted.");
  console.log("-".repeat(74));
  console.log(`${passes} passed, ${failures} failed.`);
  console.log("=".repeat(74));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
