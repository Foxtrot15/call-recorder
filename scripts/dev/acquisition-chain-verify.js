// ============================================================================
// ACQUISITION DECISION-CHAIN VERIFIER (M8I). READ-ONLY.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-chain-verify.js
//
// Recomputes the sha256 hash chain over every persisted row in
// acquisition_decisions and reports the first break, if any. This is the check
// the laq3 pre-flight cannot do in SQL: verifying the chain means re-hashing
// each row's body with the same stableStringify the writer used, and that lives
// in acquisition-audit.js.
//
// SAFETY
//   1. Refuses any project ref but dev, before a client is constructed.
//   2. SELECT only. There is no insert, update or delete anywhere in this file,
//      and nothing it calls can write: the store's read methods are the only
//      ones used.
//   3. Contacts nothing but Postgres. No provider, no dialler, no website, no
//      prospect. It cannot cause anybody to be contacted.
//   4. Creates no residue of any kind.
//
// WHY IT PAGES INSTEAD OF CALLING listDecisions({})
// Because a verifier that reads a capped page and pronounces the chain sound is
// worse than no verifier. PostgREST caps a response regardless of the limit
// asked for, so this walks the table in explicit ranges until a short page ends
// it, and cross-checks the number of rows it read against a server-side count.
// If those disagree it FAILS rather than reporting on a partial read.
//
// EXIT CODE 0 only when the chain verifies and every structural check passes.
// ============================================================================

const fs = require("fs");
const path = require("path");

const DEV_REF = "wvwemitmmsdytyutaqbm";
const PAGE = 500;

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
  if (!out.SUPABASE_URL.includes(DEV_REF)) throw new Error(`REFUSING TO RUN. Expected dev ref ${DEV_REF}, got ${out.SUPABASE_URL}.`);
  return out;
}

function makeClient() {
  const env = loadEnv();
  const { createClient } = require("@supabase/supabase-js");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const { verifyRows } = require("../../src/services/acquisition-audit");
const { createSupabaseAcquisitionStore, fromDecisionRow } = require("../../src/services/acquisition-store");

let passes = 0;
let failures = 0;
function check(id, claim, ok, detail) {
  if (ok === true) passes += 1;
  else failures += 1;
  console.log(`${id} ${ok === true ? "PASS" : "FAIL"}  ${claim}${detail ? `\n         ${detail}` : ""}`);
}

/**
 * Every row, oldest first, read in explicit ranges.
 *
 * Mapped with the STORE'S OWN fromDecisionRow, so the canonicalisation the
 * verdict depends on — timestamptz back to ...000Z, bigint sequence back to a
 * Number — is exactly the one the application uses. A verifier with a private
 * mapper would drift from the writer and then either miss a round-trip defect
 * or invent one; M8H's timestamptz bug was found precisely here.
 *
 * listDecisions() is deliberately not used: it is capped, and a verifier that
 * reads a page and pronounces the chain sound is worse than none.
 */
async function readAll(client) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("acquisition_decisions")
      .select("*")
      .order("sequence", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Read failed at offset ${from}: ${error.message}`);
    const page = data || [];
    for (const r of page) rows.push(fromDecisionRow(r));
    if (page.length < PAGE) break;
  }
  return rows;
}

async function main() {
  console.log("=".repeat(74));
  console.log("ACQUISITION DECISION-CHAIN VERIFIER (read-only)");
  console.log("=".repeat(74));

  const client = makeClient();
  const store = createSupabaseAcquisitionStore({ client });

  // Server-side count first, so a short read cannot masquerade as a whole chain.
  const counted = await client.from("acquisition_decisions").select("*", { count: "exact", head: true });
  if (counted.error) throw new Error(`Count failed: ${counted.error.message}`);
  const expected = counted.count;

  const rows = await readAll(client);
  check("R1", `read every row (${rows.length} of ${expected} counted)`, rows.length === expected, rows.length === expected ? null : "PARTIAL READ - the verdict below would be meaningless. Investigate before trusting anything else here.");
  if (rows.length !== expected) process.exit(1);

  if (rows.length === 0) {
    console.log("\nThe decision log is empty. Nothing to verify.");
    process.exit(0);
  }

  // ── The chain itself ──
  const verdict = verifyRows(rows);
  check("V1", "the hash chain verifies end to end", verdict.ok === true, verdict.ok ? `${rows.length} row(s), genesis to head.` : `${verdict.message} (first break at index ${verdict.brokenAt})`);

  // ── Structure the chain assumes ──
  const sequences = rows.map((r) => r.sequence);
  const gapless = sequences.length > 0 && sequences[0] === 1 && sequences.every((s, i) => s === i + 1);
  check("V2", "sequence is gapless from 1", gapless, `min ${Math.min(...sequences)}, max ${Math.max(...sequences)}, ${sequences.length} row(s)`);

  const prevCounts = new Map();
  for (const r of rows) prevCounts.set(r.prevHash, (prevCounts.get(r.prevHash) || 0) + 1);
  const forked = [...prevCounts.entries()].filter(([, n]) => n > 1);
  check("V3", "no prev_hash has two successors (the laq3 invariant, checked in data)", forked.length === 0, forked.length === 0 ? "one successor per head" : forked.map(([h, n]) => `${h} x${n}`).join(", "));

  const genesisRows = rows.filter((r) => r.prevHash === "0".repeat(64));
  check("V4", "exactly one genesis row", genesisRows.length === 1, `${genesisRows.length} row(s) claim no predecessor`);

  const ids = new Set(rows.map((r) => r.auditId));
  check("V5", "audit ids are unique", ids.size === rows.length, `${ids.size} distinct of ${rows.length}`);

  // ── The head, read the way the application reads it ──
  const head = await store.readChainHead();
  const tail = rows[rows.length - 1];
  check(
    "V6",
    "readChainHead() agrees with the last row of the full read",
    head !== null && head.entryHash === tail.entryHash && head.sequence === tail.sequence,
    head === null ? "readChainHead returned null on a non-empty chain" : `head seq ${head.sequence} ${head.entryHash.slice(0, 16)}...  tail seq ${tail.sequence} ${tail.entryHash.slice(0, 16)}...`
  );

  console.log("");
  console.log("-".repeat(74));
  console.log(`rows      ${rows.length}`);
  console.log(`head      seq ${tail.sequence}  ${tail.entryHash}`);
  console.log(`recorded  ${tail.recordedAt}  ${tail.event}  ${tail.entityId}`);
  console.log("-".repeat(74));
  console.log(`${passes} passed, ${failures} failed.`);
  console.log("=".repeat(74));

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
