// ============================================================================
// M8K / E-3 — READ-ONLY BASELINE. Run BEFORE the restart proof.
//
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-dncr-proof/baseline.js
//
// Records what dev holds so the proof can prove it changed nothing. SELECT only.
// ============================================================================

const crypto = require("crypto");
const C = require("./common");

async function main() {
  console.log("=".repeat(74));
  console.log("M8K / E-3 BASELINE — what dev holds before the proof (read-only)");
  console.log("=".repeat(74));

  const store = C.makeStore(C.makeClient());

  // ── Exactly one wash row, and it is the one we were told about ────
  const rows = await store.listWashes({ e164: C.SUBJECT });
  C.check("B1", `exactly one wash row exists for ${C.SUBJECT}`, rows.length === 1, `${rows.length} row(s)`);
  if (rows.length !== 1) {
    console.error("\nREFUSING TO CONTINUE: dev is not in the state this proof was written against.");
    process.exit(1);
  }

  const row = rows[0];
  const mismatches = Object.entries(C.EXPECTED).filter(([k, want]) => {
    if (k === "washedAt") return Date.parse(row.washedAt) !== Date.parse(want);
    return row[k] !== want;
  });
  C.check(
    "B2",
    "every stored field matches the reported state",
    mismatches.length === 0,
    mismatches.length ? mismatches.map(([k, want]) => `${k}: expected ${want}, found ${JSON.stringify(row[k])}`).join("; ") : "e164, result, washed_at, attested_by, mode, authoritative, batch_ref, source"
  );

  C.check("B3", "the wash is authoritative, because a human attested an import", row.authoritative === true && row.mode === "import", `mode=${row.mode} authoritative=${row.authoritative}`);

  // ── The whole ledger, not just this number ────────────────────────
  const allWashes = await store.listWashes({});
  C.check("B4", "the wash ledger holds exactly one row in total", allWashes.length === 1, `${allWashes.length} row(s)`);

  // ── Nine tables, twenty-one rows ──────────────────────────────────
  const after = await C.counts();
  const total = Object.values(after).reduce((a, b) => a + b, 0);
  C.check("B5", `the acquisition tables hold exactly ${C.EXPECTED_TOTAL_ROWS} rows`, total === C.EXPECTED_TOTAL_ROWS, Object.entries(after).map(([t, n]) => `${t}=${n}`).join("  "));
  C.check("B6", "acquisition_dncr_washes holds exactly 1", after.acquisition_dncr_washes === 1, `${after.acquisition_dncr_washes}`);
  C.check("B7", "acquisition_decisions still holds exactly 4 — laq4 wrote no decision", after.acquisition_decisions === 4, `${after.acquisition_decisions}`);

  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(allWashes)).digest("hex");

  console.log("");
  console.log("-".repeat(74));
  console.log("BASELINE, RECORDED");
  console.log(`  e164          ${row.e164}`);
  console.log(`  result        ${row.result}`);
  console.log(`  washed_at     ${row.washedAt}`);
  console.log(`  attested_by   ${row.attestedBy}`);
  console.log(`  mode          ${row.mode}   authoritative ${row.authoritative}`);
  console.log(`  batch_ref     ${row.batchRef}`);
  console.log(`  source        ${row.source}`);
  console.log(`  recorded_at   ${row.recordedAt}`);
  console.log(`  ledger sha256 ${fingerprint}`);
  console.log(`  total rows    ${total}`);
  console.log("-".repeat(74));
  console.log("RESIDUE FROM THIS BASELINE: none. Every statement was a SELECT.");

  process.exit(C.summary("M8K / E-3 BASELINE") ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
