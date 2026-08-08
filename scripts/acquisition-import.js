#!/usr/bin/env node
// AIDA Locksmith Acquisition — the founder-facing import command (M8F).
//
//   node scripts/acquisition-import.js --file <csv> --source outscraper-google-maps
//
// Reads a real business export, runs it through the acquisition intake
// pipeline, and prints what would happen.
//
// ── DRY RUN IS NOT A FLAG. IT IS THE ONLY MODE. ─────────────────────
// There is no --write, no --commit and no --apply, and adding one is a
// reviewable change rather than a command-line argument. This build has nowhere
// to write imported prospects to: the durable store covers suppressions, leases
// and outcomes, and a prospect-writing path does not exist. A `--write` flag
// here would have to invent one, and it would be invented at the exact moment
// somebody was in a hurry.
//
// So this command reads a file and prints a report. That is all it can do, and
// a test asserts it.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────
// No network. No provider. No call, SMS or email. The website column in the
// file is normalised and compared; it is never visited. Nothing is written to
// any database, and no secret is read or printed.

const fs = require("node:fs");
const path = require("node:path");

const { importBusinessCsv, IMPORT_OUTCOMES } = require("../src/services/acquisition-import");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createEligibilityEngine } = require("../src/services/acquisition-eligibility");
const { qualifyProspect } = require("../src/services/acquisition-qualification");
const { listImportProfiles, getImportProfile } = require("../src/services/acquisition-import-profiles");

function parseArgs(argv) {
  const out = { file: null, source: null, limit: null, showRows: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--source" || a === "-s") out.source = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--summary-only") out.showRows = false;
    else if (a === "--dry-run") out.explicitDryRun = true; // accepted, always true anyway
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out.unknown = a;
  }
  return out;
}

function usage() {
  console.log(`
AIDA locksmith acquisition — import a business export (DRY RUN ONLY)

  node scripts/acquisition-import.js --file <csv> --source <profile>

  --file, -f        path to a CSV export
  --source, -s      mapping profile: ${listImportProfiles().join(" | ")}
  --limit           only process the first N rows
  --summary-only    skip the per-row detail
  --dry-run         accepted for clarity; this command has no other mode

This command never writes, never dials and never reaches the network. It reads
a file and prints what the acquisition engine would make of it.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.file && !args.source)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.unknown) {
    console.error(`Unknown option "${args.unknown}". There is no write mode; see --help.`);
    process.exit(1);
  }
  if (!args.file) {
    console.error("Which file? Pass --file <csv>.");
    process.exit(1);
  }
  if (!args.source) {
    console.error(`Which source profile? Pass --source with one of: ${listImportProfiles().join(", ")}.`);
    process.exit(1);
  }

  const profile = getImportProfile(args.source);
  if (!profile.ok) {
    console.error(profile.message);
    process.exit(1);
  }

  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`That file could not be read: ${err.message}`);
    process.exit(1);
  }

  const now = () => new Date();
  const ledger = createEvidenceLedger({ now });
  const suppression = createSuppressionList({ now });
  const engine = createEligibilityEngine({ now, suppression });

  console.log("");
  console.log("=".repeat(78));
  console.log("ACQUISITION IMPORT — DRY RUN. Nothing is written, nobody is contacted.");
  console.log("=".repeat(78));
  console.log(`  file     ${file}`);
  console.log(`  profile  ${profile.profile.name} (${profile.profile.label})`);
  console.log(`  treated as ${profile.profile.sourceType}`);

  const result = importBusinessCsv({
    text,
    profileName: profile.profile.name,
    now,
    ledger,
    qualify: (p, e) => qualifyProspect(p, { evidenceRows: e, at: new Date() }),
    evaluate: (p, e) => engine.evaluate(p, { evidenceRows: e }),
  });

  if (!result.ok) {
    console.log("\nThis file could not be imported:\n");
    for (const p of result.problems) console.log(`  ✗ ${p.message}`);
    if (result.mapping) {
      console.log(`\n  Columns recognised: ${result.mapping.recognised.join(", ") || "(none)"}`);
      console.log(`  Columns present but unused: ${result.mapping.unrecognised.join(", ") || "(none)"}`);
      console.log(`\n  If this is not an ${profile.profile.name} export, try --source with one of: ${listImportProfiles().join(", ")}.`);
    }
    process.exit(1);
  }

  if (result.problems.length > 0) {
    console.log("\nFILE PROBLEMS (rows may have been skipped)");
    for (const p of result.problems) console.log(`  ! ${p.message}`);
  }

  if (args.showRows) {
    console.log("\nPER-ROW OUTCOMES");
    const shown = args.limit ? result.outcomes.slice(0, args.limit) : result.outcomes;
    for (const o of shown) {
      console.log(`  line ${String(o.line).padStart(4)}  ${o.status.toUpperCase().padEnd(18)} ${o.businessName || "(no business name)"}`);
      console.log(`                ${o.message}`);
    }
    if (args.limit && result.outcomes.length > args.limit) {
      console.log(`  … ${result.outcomes.length - args.limit} more rows not shown (--limit ${args.limit}).`);
    }
  }

  const s = result.summary;
  console.log("\nSUMMARY");
  const line = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`);
  line("source rows", s.sourceRows);
  line("would import", s.imported);
  line("would import, needs review", s.reviewRequired);
  line("merged into an existing business", s.merged);
  line("duplicate listing within the file", s.duplicate);
  line("excluded — not a locksmith", s.notLocksmith);
  line("no usable number", s.invalidPhone);
  line("no number published", s.missingPhone);
  line("no business name", s.insufficientData);
  line("failed", s.failed);
  line("qualified", s.qualified);
  line("compliance-blocked", s.complianceBlocked);
  console.log(`  ${"phone kinds".padEnd(30)} ${JSON.stringify(s.phoneKinds)}`);
  console.log(`  ${"classification".padEnd(30)} ${JSON.stringify(s.classification)}`);

  console.log("");
  console.log("-".repeat(78));
  console.log("DRY RUN COMPLETE. No prospect was stored, no number was washed against the");
  console.log("Do Not Call Register, no website was fetched, and no call, SMS or email was");
  console.log("sent. Importing a business does not make it callable: every prospect above");
  console.log("still faces review, qualification, DNCR, suppression and the calling policy.");
  console.log("-".repeat(78));
  console.log("");

  process.exit(0);
}

main();
