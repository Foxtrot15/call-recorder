#!/usr/bin/env node
// AIDA Locksmith Acquisition — the founder-facing import command (M8F).
//
//   node scripts/acquisition-import.js --file <csv> --source outscraper-google-maps
//
// Reads a real business export, runs it through the acquisition intake
// pipeline, and prints what would happen.
//
// ── DRY RUN IS THE DEFAULT. WRITING IS EXPLICIT, TYPED IN FULL. ─────
// M8F had no write mode at all, because there was nowhere to write to. M8G
// added one: --write persists into the laq1 tables.
//
// The flag is `--write` and nothing else. Not `--live`, which reads like "go
// live" and would one day be typed by somebody who meant "use real data"; not
// `--commit`, which is a git verb here. Omitting it can only ever produce a
// report, and no configuration, environment variable or default can turn a dry
// run into a write.
//
// --write additionally requires SUPABASE_URL and SUPABASE_SERVICE_KEY and
// refuses any project that is not dev. Reading a file needs neither, so a dry
// run never touches a credential.
//
// ── WHAT NEITHER MODE CAN DO ────────────────────────────────────────
// No network. No provider. No call, SMS or email. The website column in the
// file is normalised and compared; it is never visited. No provider is
// reachable, and no secret is ever printed.

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
    else if (a === "--dry-run") out.explicitDryRun = true; // accepted; it is the default
    else if (a === "--write") out.write = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out.unknown = a;
  }
  return out;
}

function usage() {
  console.log(`
AIDA locksmith acquisition — import a business export (dry run unless --write)

  node scripts/acquisition-import.js --file <csv> --source <profile>

  --file, -f        path to a CSV export
  --source, -s      mapping profile: ${listImportProfiles().join(" | ")}
  --limit           only process the first N rows
  --summary-only    skip the per-row detail
  --dry-run         accepted for clarity; it is the default
  --write           PERSIST prospects, phones and evidence to the dev database

Without --write this reads a file and prints what the acquisition engine would
make of it. Nothing is stored and no credential is read.

With --write it also stores canonical prospects, their published numbers and
their evidence. It refuses any project that is not dev.

Neither mode dials, sends anything, reaches a provider, or opens a business's
website. Persisting a business does not make it callable: it is stored as
\`discovered\`, unreviewed and unwashed, and every gate still applies.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.file && !args.source)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (args.unknown) {
    console.error(`Unknown option "${args.unknown}". Writing is --write and nothing else; see --help.`);
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

  /**
   * THE DEV GUARD, BEFORE A CLIENT EXISTS.
   *
   * Only reached with --write. A dry run never gets here, so it never reads a
   * credential at all.
   */
  let store = null;
  if (args.write) {
    const DEV_REF = "wvwemitmmsdytyutaqbm";
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      console.error("--write needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment. Nothing was written.");
      process.exit(1);
    }
    if (!url.includes(DEV_REF)) {
      console.error(`REFUSING TO WRITE. --write is permitted against the dev project (${DEV_REF}) only, and SUPABASE_URL points elsewhere. Nothing was written.`);
      process.exit(1);
    }
    const { createSupabaseAcquisitionStore } = require("../src/services/acquisition-store");
    store = createSupabaseAcquisitionStore();
  }

  console.log("");
  console.log("=".repeat(78));
  console.log(args.write ? "ACQUISITION IMPORT — WRITE MODE. Prospects will be stored. Nobody is contacted." : "ACQUISITION IMPORT — DRY RUN. Nothing is written, nobody is contacted.");
  console.log("=".repeat(78));
  console.log(`  file     ${file}`);
  console.log(`  profile  ${profile.profile.name} (${profile.profile.label})`);
  console.log(`  treated as ${profile.profile.sourceType}`);
  console.log(`  mode     ${args.write ? "WRITE (dev only)" : "dry run"}`);

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

  if (args.write) {
    const { persistImportResult } = require("../src/services/acquisition-persist");
    console.log("\nWRITING to the dev database…");
    const written = await persistImportResult({ result, ledger, store, now });
    const w = written.summary;
    console.log("");
    console.log(`  prospects created          ${w.created}`);
    console.log(`  prospects updated          ${w.updated}`);
    console.log(`  prospects unchanged        ${w.unchanged}`);
    console.log(`  phone rows added           ${w.phonesAdded}`);
    console.log(`  evidence rows appended     ${w.evidenceAdded}`);
    if (w.partial > 0 || w.failed > 0) {
      console.log(`  PARTIAL                    ${w.partial}`);
      console.log(`  FAILED                     ${w.failed}`);
      console.log("\n  Not everything was stored. Re-running this command adds exactly what is");
      console.log("  missing — every step is idempotent, so a retry repairs rather than duplicates.");
      for (const p of written.persisted.filter((x) => x.outcome === "partial" || x.outcome === "failed")) {
        console.log(`    ${p.businessName || p.prospectId}: [${p.stage}] ${p.message}`);
      }
    }
  }

  console.log("");
  console.log("-".repeat(78));
  if (args.write) {
    console.log("WRITE COMPLETE. Prospects, published numbers and evidence were stored in the");
    console.log("dev database. No number was washed against the Do Not Call Register, no");
    console.log("website was fetched, and no call, SMS or email was sent. Storing a business");
    console.log("does not make it callable: every prospect above is `discovered`, unreviewed");
    console.log("and unwashed, and still faces suppression, DNCR and the calling policy.");
  } else {
    console.log("DRY RUN COMPLETE. No prospect was stored, no number was washed against the");
    console.log("Do Not Call Register, no website was fetched, and no call, SMS or email was");
    console.log("sent. Importing a business does not make it callable: every prospect above");
    console.log("still faces review, qualification, DNCR, suppression and the calling policy.");
    console.log("");
    console.log("Add --write to store these prospects in the dev database.");
  }
  console.log("-".repeat(78));
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error(`\nThe import failed: ${err.message}`);
  process.exit(1);
});
