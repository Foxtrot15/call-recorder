#!/usr/bin/env node
// AIDA Locksmith Acquisition — import an attested DNCR wash (M8K).
//
//   node scripts/acquisition-dncr-import.js --file <washed.csv> --attested-by "Name"
//
// Loads the results of a wash A HUMAN PERFORMED against the real Do Not Call
// Register, and records them as durable evidence.
//
// ── THIS PROGRAM DOES NOT WASH ANYTHING ─────────────────────────────
// It cannot contact the Register. There is no account, no endpoint, no
// credential and no client anywhere in this tree — see the ratchets in
// test/acquisition-dncr-durable.test.js, which fail the build if one appears.
// The wash happens out of band, by a person with access, and enters this system
// as attested data. WHO attests is mandatory, because an imported file with no
// name against it is indistinguishable from a made-up one, and the lawful basis
// for every resulting call rests on it being real.
//
// ── DRY RUN IS THE DEFAULT. WRITING IS EXPLICIT, TYPED IN FULL. ─────
// Omitting --write can only ever produce a report. No environment variable and
// no default can turn a dry run into a write. A dry run reads a file and a
// clock, and touches no credential at all.
//
// --write requires laq4, which is WRITTEN AND NOT APPLIED ANYWHERE. Until a
// human applies it to dev, --write will fail on a missing table, and that is
// the correct behaviour rather than a bug to route around.
//
// ── THE INPUT FORMAT ────────────────────────────────────────────────
// This repository has never seen a real DNCR export, so it does not pretend to
// know its shape. What it defines instead is a small canonical AIDA format that
// a person can produce from whatever the Register actually returns:
//
//     e164,result
//     (03) 5550 1042,not_listed
//     0355504488,listed
//
// `result` is `listed` or `not_listed` — never blank, never "unknown". A number
// nobody checked belongs in no row at all: its absence is what makes it read as
// unchecked, and a blank would invite somebody to treat it as clear.
//
// Numbers may be written any way at all; they are canonicalised to +61 form on
// the way in, so one telephone lands on one key however the file spells it.
//
// MAPPING THE OFFICIAL EXPORT IS PENDING. When the founder supplies a real
// sample, the mapping belongs beside the other import profiles rather than in
// this file. Until then, converting the export to the two columns above is a
// human step, and it is a small one.

const fs = require("node:fs");
const path = require("node:path");

const { importWashResults, hydrateWashStore, canonicalNumber, DNCR_WASH_VALIDITY_DAYS } = require("../src/services/acquisition-dncr");

function parseArgs(argv) {
  const out = { file: null, attestedBy: null, batchRef: null, washedAt: null, write: false, help: false, unknown: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file" || a === "-f") out.file = argv[++i];
    else if (a === "--attested-by" || a === "-a") out.attestedBy = argv[++i];
    else if (a === "--batch-ref" || a === "-b") out.batchRef = argv[++i];
    else if (a === "--washed-at" || a === "-w") out.washedAt = argv[++i];
    else if (a === "--write") out.write = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out.unknown = a;
  }
  return out;
}

const USAGE = `
AIDA locksmith acquisition — import an attested DNCR wash (dry run unless --write)

  node scripts/acquisition-dncr-import.js --file <csv> --attested-by "Name"

  --file, -f          path to a CSV of wash results: e164,result
  --attested-by, -a   WHO attests these are the results of a real wash (required)
  --washed-at, -w     ISO instant the wash was PERFORMED (default: the file's mtime)
  --batch-ref, -b     the operator's reference for the wash run
  --write             PERSIST the results to the dev database (requires laq4)

This program cannot contact the Do Not Call Register. It records the results of
a wash a person performed. Without --write it reads the file and prints what
would be stored; nothing is written and no credential is read.

A wash may be relied on for ${DNCR_WASH_VALIDITY_DAYS} days from when it was PERFORMED — not from when
it was imported. Importing an old wash does not make it fresh.
`;

/** The canonical AIDA wash file: two columns, a header, and nothing clever. */
function parseWashCsv(text) {
  const rows = [];
  const problems = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { rows, problems: [{ line: 0, message: "The file is empty." }] };

  let start = 0;
  const header = lines[0].toLowerCase();
  if (header.includes("e164") || header.includes("number") || header.includes("phone")) start = 1;

  for (let i = start; i < lines.length; i += 1) {
    const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 2) {
      problems.push({ line: i + 1, message: `"${lines[i].slice(0, 40)}" is not "<number>,<result>".` });
      continue;
    }
    const [raw, result] = parts;
    const e164 = canonicalNumber(raw);
    if (!e164) {
      problems.push({ line: i + 1, message: `"${raw.slice(0, 30)}" is not a number a wash can be recorded against.` });
      continue;
    }
    if (result !== "listed" && result !== "not_listed") {
      problems.push({ line: i + 1, message: `"${result.slice(0, 30)}" is not "listed" or "not_listed". A number nobody checked belongs in no row at all.` });
      continue;
    }
    rows.push({ e164, result, raw });
  }
  return { rows, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  if (args.unknown) {
    console.error(`Unknown option "${args.unknown}".`);
    process.exit(1);
  }
  if (!args.attestedBy || !String(args.attestedBy).trim()) {
    console.error("--attested-by is required. A wash with nobody's name against it is not evidence of anything.");
    process.exit(1);
  }

  const file = path.resolve(args.file);
  if (!fs.existsSync(file)) {
    console.error(`Cannot find ${file}.`);
    process.exit(1);
  }

  // The wash instant. Defaulting to the file's mtime is a convenience, and it
  // is stated out loud every run rather than assumed, because this timestamp
  // decides how long the wash may lawfully be relied on.
  const washedAt = args.washedAt || new Date(fs.statSync(file).mtime).toISOString();
  if (!Number.isFinite(Date.parse(washedAt))) {
    console.error(`"${washedAt}" is not an instant this can read. Pass --washed-at as an ISO timestamp.`);
    process.exit(1);
  }

  const { rows, problems } = parseWashCsv(fs.readFileSync(file, "utf8"));

  console.log("=".repeat(74));
  console.log("DNCR WASH IMPORT");
  console.log("=".repeat(74));
  console.log(`file          ${file}`);
  console.log(`washed at     ${washedAt}${args.washedAt ? "" : "  (from the file's modification time)"}`);
  console.log(`attested by   ${String(args.attestedBy).trim()}`);
  console.log(`batch ref     ${args.batchRef || "(none)"}`);
  console.log(`mode          ${args.write ? "WRITE" : "dry run — nothing will be stored"}`);
  console.log("");

  const now = () => new Date();
  const ageDays = Math.floor((now().getTime() - Date.parse(washedAt)) / (24 * 3600 * 1000));
  console.log(`rows read     ${rows.length}   listed ${rows.filter((r) => r.result === "listed").length}   not listed ${rows.filter((r) => r.result === "not_listed").length}`);
  console.log(`unreadable    ${problems.length}`);
  console.log(`wash age      ${ageDays} day(s) — a wash may be relied on for ${DNCR_WASH_VALIDITY_DAYS}`);

  if (ageDays >= DNCR_WASH_VALIDITY_DAYS) {
    console.log("");
    console.log("WARNING: this wash is ALREADY past its validity. Importing it is allowed —");
    console.log("the ledger is a record of what happened — but it will clear nobody, because");
    console.log("freshness is computed from when the wash was performed.");
  }

  if (problems.length) {
    console.log("");
    console.log("PROBLEMS (nothing will be imported while any remain):");
    for (const p of problems.slice(0, 20)) console.log(`  line ${p.line}: ${p.message}`);
    if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
  }

  if (!args.write) {
    console.log("");
    console.log("-".repeat(74));
    console.log("DRY RUN. Nothing was stored and no credential was read.");
    console.log("Re-run with --write to persist. That requires laq4, which is written and");
    console.log("NOT APPLIED — see docs/ACQUISITION_SQL_RUNBOOK.md.");
    process.exit(problems.length ? 1 : 0);
  }

  if (problems.length) {
    console.error("\nREFUSING TO WRITE: some rows could not be read. A half-applied wash is worse than none.");
    process.exit(1);
  }

  // ── The write path ────────────────────────────────────────────────
  const { createSupabaseAcquisitionStore } = require("../src/services/acquisition-store");
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.error("--write needs SUPABASE_URL and SUPABASE_SERVICE_KEY.");
    process.exit(1);
  }
  const DEV_REF = "wvwemitmmsdytyutaqbm";
  if (!env.SUPABASE_URL.includes(DEV_REF)) {
    console.error(`REFUSING TO WRITE. Expected the dev project (${DEV_REF}).`);
    process.exit(1);
  }

  const { createClient } = require("@supabase/supabase-js");
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const store = createSupabaseAcquisitionStore({ client });

  const result = await importWashResults({
    store,
    now,
    source: path.basename(file),
    batch: {
      washedAt: new Date(washedAt).toISOString(),
      batchRef: args.batchRef || null,
      attestedBy: String(args.attestedBy).trim(),
      results: rows.map((r) => ({ e164: r.e164, result: r.result })),
    },
  });

  if (!result.ok) {
    console.error(`\nIMPORT REFUSED: ${result.message}`);
    for (const p of result.problems || []) console.error(`  row ${p.index}: ${p.message}`);
    process.exit(1);
  }

  console.log("");
  console.log("-".repeat(74));
  console.log(`IMPORTED ${result.imported} of ${result.total}${result.duplicates ? `, ${result.duplicates} already held` : ""}.`);

  // Read it straight back through the production path, so the run ends with
  // proof that what was written is what will be read.
  const wash = await hydrateWashStore({ store, now });
  if (!wash.available) {
    console.error(`\nWROTE, BUT COULD NOT READ BACK: ${wash.reason}`);
    process.exit(1);
  }
  const usable = rows.filter((r) => wash.assess(r.e164).usable).length;
  console.log(`Read back through the eligibility path: ${usable} of ${rows.length} numbers now have a usable wash.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
