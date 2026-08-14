#!/usr/bin/env node
// ============================================================================
// E-12H — IS AIDA ALLOWED TO MAKE ONE ACQUISITION PROOF CALL?
//
//   NODE_PATH=../call-recorder/node_modules \
//     node scripts/dev/acquisition-preview-proof.js
//
//   ... --prospect <id> --to +61...      scope the compliance checks
//
// READ-ONLY. This script answers a question and does nothing else. There is no
// flag that makes it place a call, create a resource, or change any state — it
// has no write path at all, which is why it takes no confirmation flag.
//
// NOT READY is the expected answer today, and it is the truthful one rather
// than a failure of the script. Exit code stays 0: reporting accurately is
// success.
// ============================================================================

const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..", "..");
const { describeProofPreflight } = require(path.join(ROOT, "src/services/acquisition-proof-preflight"));

const line = (c = "-") => console.log(c.repeat(78));
const head = (t) => { console.log(""); line("="); console.log(`  ${t}`); line("="); };

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
};

function loadEnv() {
  const envPath = process.env.ACQUISITION_ENV_FILE
    ? path.resolve(process.env.ACQUISITION_ENV_FILE)
    : path.resolve(ROOT, "..", "call-recorder", ".env");
  const out = { ...process.env };
  if (fs.existsSync(envPath)) {
    for (const l of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return out;
}

const MARK = { true: "  OK   ", false: " BLOCK ", unknown: "  ??   " };

function section(title, items) {
  console.log("");
  console.log(`  ${title}`);
  line("-");
  for (const [name, item] of Object.entries(items)) {
    console.log(`  [${MARK[String(item.ready)]}] ${name.padEnd(22)} ${item.detail}`);
  }
}

async function main() {
  const env = loadEnv();
  const prospectId = arg("prospect");
  const destinationE164 = arg("to");

  console.log("");
  line("=");
  console.log("  E-12H — ACQUISITION PROOF-CALL PREFLIGHT (read-only)");
  console.log(`  prospect: ${prospectId || "(not scoped)"}    destination: ${destinationE164 || "(not scoped)"}`);
  line("=");

  const report = await describeProofPreflight({ env, prospectId, destinationE164 });

  section("RESOURCE READINESS", report.resources);
  section("COMPLIANCE", report.compliance);
  section("EXECUTION SAFETY", report.execution);

  head(report.readyForReview ? "ALL ITEMS GREEN — STILL NOT PERMISSION" : "NOT READY");
  if (report.blockers.length) {
    console.log(`  ${report.blockers.length} blocker(s):`);
    console.log("");
    for (const b of report.blockers) console.log(`   • ${b}`);
  }
  console.log("");
  console.log("  " + report.note.replace(/\s+/g, " "));
  line("=");
  console.log("");
  // Reporting the truth is success. NOT READY is not a script failure.
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
