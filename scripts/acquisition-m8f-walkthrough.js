#!/usr/bin/env node
// AIDA Locksmith Acquisition — M8F import walkthrough.
//
// Runs the fixture export through the whole intake pipeline and prints why each
// row ended where it did. Deterministic, offline, and contacts nothing.
//
//   node scripts/acquisition-m8f-walkthrough.js

const fs = require("node:fs");
const path = require("node:path");

const { importBusinessCsv, IMPORT_OUTCOMES } = require("../src/services/acquisition-import");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createEligibilityEngine } = require("../src/services/acquisition-eligibility");
const { qualifyProspect } = require("../src/services/acquisition-qualification");
const { getImportProfile } = require("../src/services/acquisition-import-profiles");

const AT = new Date("2026-08-08T03:00:00.000Z");
const now = () => AT;
const FIXTURE = path.join(__dirname, "..", "test", "fixtures", "locksmiths-outscraper-sample.csv");

const rule = (c = "=") => console.log(c.repeat(78));
const head = (n, title) => {
  console.log("");
  rule("─");
  console.log(`${n}. ${title}`);
  rule("─");
};

function main() {
  rule();
  console.log("AIDA LOCKSMITH ACQUISITION — M8F: a real-shaped export becomes prospects");
  rule();
  console.log("");
  console.log("Offline. No network, no provider, no call, no SMS, no email. The file below");
  console.log("is invented and every number in it is fictional.");

  const profile = getImportProfile("outscraper-google-maps").profile;
  const text = fs.readFileSync(FIXTURE, "utf8");
  const ledger = createEvidenceLedger({ now });
  const suppression = createSuppressionList({ now });
  const engine = createEligibilityEngine({ now, suppression });

  head(1, "THE SOURCE FILE");
  console.log(`  file      ${path.relative(process.cwd(), FIXTURE)}`);
  console.log(`  profile   ${profile.name} — ${profile.label}`);
  console.log(`  treated as ${profile.sourceType} (a map listing is NOT an official source)`);
  console.log(`  bytes     ${text.length}`);

  const result = importBusinessCsv({
    text,
    profileName: profile.name,
    now,
    ledger,
    qualify: (p, e) => qualifyProspect(p, { evidenceRows: e, at: AT }),
    evaluate: (p, e) => engine.evaluate(p, { evidenceRows: e }),
  });

  if (!result.ok) {
    console.log("\nThe file could not be read:");
    for (const p of result.problems) console.log(`  ✗ ${p.message}`);
    process.exit(1);
  }

  head(2, "MAPPING — checked before a single row was read");
  console.log(`  recognised   ${result.mapping.recognised.join(", ")}`);
  console.log(`  ignored      ${result.mapping.unrecognised.join(", ") || "(none)"}`);
  console.log("");
  console.log("  Columns this build deliberately does NOT import, though the export carries");
  console.log("  them: reviews, reviewer names, photos, owner names, harvested emails.");
  console.log("  None is needed to decide whether a locksmith may lawfully be called.");

  head(3, "EVERY ROW, AND WHY");
  const order = [
    IMPORT_OUTCOMES.IMPORTED,
    IMPORT_OUTCOMES.REVIEW_REQUIRED,
    IMPORT_OUTCOMES.MERGED,
    IMPORT_OUTCOMES.DUPLICATE,
    IMPORT_OUTCOMES.NOT_LOCKSMITH,
    IMPORT_OUTCOMES.INVALID_PHONE,
    IMPORT_OUTCOMES.MISSING_PHONE,
    IMPORT_OUTCOMES.INSUFFICIENT_DATA,
    IMPORT_OUTCOMES.FAILED,
  ];
  for (const status of order) {
    const rows = result.outcomes.filter((o) => o.status === status);
    if (rows.length === 0) continue;
    console.log(`\n  ${status.toUpperCase()} (${rows.length})`);
    for (const o of rows) {
      console.log(`    line ${String(o.line).padStart(2)}  ${o.businessName || "(no business name)"}`);
      console.log(`             ${o.message}`);
      if (o.phones && o.phones.length) {
        console.log(`             numbers: ${o.phones.map((p) => `${p.e164} (${p.kind})`).join(", ")}`);
      }
    }
  }

  head(4, "LANDLINES ARE BUSINESS NUMBERS");
  const kinds = result.summary.phoneKinds;
  console.log(`  landline ${kinds.landline || 0}   mobile ${kinds.mobile || 0}   service ${kinds.service || 0}`);
  console.log("");
  console.log("  An SMS-first pipeline would have discarded most of this file. AIDA is");
  console.log("  voice-first, and the published landline is the number a locksmith answers.");
  console.log("  Only premium-rate and short numbers are refused, because dialling those");
  console.log("  can cost the recipient money.");

  head(5, "PROVENANCE — one ledger, not a second one");
  const imported = result.outcomes.find((o) => o.status === IMPORT_OUTCOMES.IMPORTED);
  const rows = ledger.forProspect(imported.prospectId);
  console.log(`  ${imported.businessName} — ${rows.length} evidence rows`);
  for (const e of rows.slice(0, 5)) {
    const src = e.source && (e.source.label || e.source.url) ? e.source.label || e.source.url : "(none)";
    console.log(`    ${String(e.kind).padEnd(15)} ${String(e.value).slice(0, 34).padEnd(36)} ${e.captureMode} · ${src}`);
  }
  console.log("");
  console.log("  Every claim names the source that supplied THAT claim. The listing is");
  console.log("  cited for what the listing said; the website is recorded but cited for");
  console.log("  nothing, because this build has not read it.");

  head(6, "COMPLIANCE — importing changes nothing about callability");
  const withElig = result.outcomes.filter((o) => o.eligibility);
  const eligible = withElig.filter((o) => o.eligibility.eligible).length;
  console.log(`  imported prospects assessed : ${withElig.length}`);
  console.log(`  eligible to call now        : ${eligible}`);
  const sample = withElig[0];
  if (sample) {
    console.log(`\n  ${sample.businessName} is blocked because:`);
    for (const f of sample.eligibility.failedChecks.slice(0, 5)) console.log(`    ✗ ${f.check}: ${f.message}`);
  }

  head(7, "OPERATOR SUMMARY");
  const s = result.summary;
  const line = (k, v) => console.log(`  ${String(k).padEnd(28)} ${v}`);
  line("source rows", s.sourceRows);
  line("imported", s.imported);
  line("imported, needs review", s.reviewRequired);
  line("merged into existing", s.merged);
  line("duplicate listing in file", s.duplicate);
  line("excluded — not a locksmith", s.notLocksmith);
  line("no usable number", s.invalidPhone);
  line("no number published", s.missingPhone);
  line("no business name", s.insufficientData);
  line("failed", s.failed);
  line("qualified", s.qualified);
  line("compliance-blocked", s.complianceBlocked);
  console.log(`  classification               ${JSON.stringify(s.classification)}`);
  console.log(`  phone kinds                  ${JSON.stringify(s.phoneKinds)}`);

  console.log("");
  rule();
  console.log("WHAT DID NOT HAPPEN");
  rule();
  console.log("  ✗ No website was fetched. The website column was normalised and compared,");
  console.log("    never visited.");
  console.log("  ✗ No search API, directory API or Google/Outscraper endpoint was called.");
  console.log("  ✗ No number was washed against the Do Not Call Register.");
  console.log("  ✗ No call was placed, scheduled or prepared. There is no dialler.");
  console.log("  ✗ No SMS and no email was sent.");
  console.log("  ✗ No database was written to. The ledger above is in memory.");
  console.log("  ✗ No prospect became callable. Every one is still blocked.");
  console.log("");
  console.log("  The terminal artifact is a list of businesses with evidence attached.");
  console.log("  Data describing an intention — not an instruction.");
  rule();
}

main();
