#!/usr/bin/env node
// AIDA Locksmith Acquisition — offline dry run (A1).
//
//   node scripts/acquisition-dry-run.js
//   node scripts/acquisition-dry-run.js --verbose
//
// Walks the whole A1 pipeline against the deterministic fixture and prints what
// a founder would see:
//
//   business discovered → official source identified → identity and phone
//   evidence captured → source and context human-reviewed
//
// NOTHING EXTERNAL HAPPENS. No network request, no database, no phone call, no
// message. The engine's flags are set for this process only; the offline
// boundary in src/config/acquisition.js is a hardcoded constant this script
// cannot and does not try to change.
//
// The "reviewer" here is a scripted stand-in that applies an obvious rule
// (approve what has no gaps, reject what plainly is not a locksmith). It exists
// to show the shape of the workflow end to end. It is NOT a substitute for a
// human: the real review step requires a named person, and the scripted
// reviewer below is named as what it is in every audit row it writes.

const path = require("node:path");

// Flags for THIS PROCESS ONLY. Nothing is written to a .env file.
process.env.ACQUISITION_ENABLED = "true";
process.env.ACQUISITION_REVIEW_ENABLED = "true";

const root = path.join(__dirname, "..");
require(path.join(root, "src/services/acquisition-discovery-fixture"));

const { getAcquisitionConfig, EXTERNAL_ACCESS_SUPPORTED } = require(path.join(root, "src/config/acquisition"));
const { discoverProspects, describeDiscoveryAdapters } = require(path.join(root, "src/services/acquisition-discovery"));
const { createEvidenceLedger } = require(path.join(root, "src/services/acquisition-evidence"));
const { createAuditLog } = require(path.join(root, "src/services/acquisition-audit"));
const review = require(path.join(root, "src/services/acquisition-review"));

const VERBOSE = process.argv.includes("--verbose");

// A frozen clock. The whole run is deterministic, so two runs produce byte-identical output.
const RUN_AT = new Date("2026-08-01T09:00:00.000Z");
const now = () => RUN_AT;

// ── Presentation helpers ────────────────────────────────────────────

const line = (char = "─", width = 78) => char.repeat(width);
function heading(text) {
  console.log(`\n${line("━")}`);
  console.log(text);
  console.log(line("━"));
}
function step(n, text) {
  console.log(`\n${n}. ${text}`);
  console.log(line());
}

// ── Run ─────────────────────────────────────────────────────────────

heading("AIDA LOCKSMITH ACQUISITION — OFFLINE DRY RUN (A1)");

const config = getAcquisitionConfig(process.env);
console.log(`Run at (frozen clock):  ${RUN_AT.toISOString()}`);
console.log(`External access:        ${EXTERNAL_ACCESS_SUPPORTED ? "AVAILABLE" : "CLOSED — no network, no database, no telephony"}`);
console.log(`DNCR mode:              ${config.dncr.mode} (authoritative: ${config.dncr.resultsAreAuthoritative})`);
console.log(`Discovery adapters:     ${describeDiscoveryAdapters().map((a) => `${a.name} (network: ${a.requiresNetwork})`).join(", ")}`);
if (config.faults.length) {
  console.log("\nConfig faults:");
  for (const fault of config.faults) console.log(`  ! ${fault.message}`);
}

const ledger = createEvidenceLedger({ now });
const audit = createAuditLog({ now });

// ── 1. Discovery ────────────────────────────────────────────────────

step(1, "BUSINESS DISCOVERED  ·  official source identified  ·  evidence captured");

const discovery = discoverProspects({ adapter: "fixture-v1", now, ledger, capturedBy: "dry-run", env: process.env });
if (!discovery.ok) {
  console.error(`Discovery refused: ${discovery.message}`);
  process.exit(1);
}

console.log(`Admitted ${discovery.prospects.length} businesses; refused ${discovery.rejected.length}.`);
console.log(`Wrote ${ledger.count()} pieces of evidence.\n`);

if (discovery.rejected.length) {
  console.log("Refused at discovery (not stored, no evidence kept):");
  for (const r of discovery.rejected) {
    console.log(`  ✗ ${r.businessName}`);
    console.log(`      ${r.message}`);
  }
}

// ── 2. Review ───────────────────────────────────────────────────────

step(2, "SOURCE AND CONTEXT HUMAN-REVIEWED");

const REVIEWER = "dry-run stand-in (not a real reviewer)";
const reviewed = { approved: [], rejected: [], blocked: [] };

for (const prospect of discovery.prospects) {
  const evidenceRows = ledger.currentForProspect(prospect.prospectId);

  const queued = review.queueForReview(prospect, { evidenceRows, actor: "dry-run", now, audit, env: process.env });
  if (!queued.ok) {
    console.log(`  ! ${prospect.businessName}: ${queued.message}`);
    continue;
  }

  const packet = review.buildReviewPacket(queued.prospect, evidenceRows);

  if (!packet.canApprove) {
    // A record that cannot be approved is shown with its blockers. A real
    // reviewer decides what to do; the stand-in simply reports.
    reviewed.blocked.push({ prospect: queued.prospect, packet });
    continue;
  }

  const decision = review.recordReviewDecision(queued.prospect, {
    decision: "approve",
    reviewer: REVIEWER,
    reason: `No gaps in the record. ${packet.sourceSummary}`.slice(0, 300),
    evidenceRows,
    audit,
    now,
    env: process.env,
  });

  if (decision.ok) reviewed.approved.push(decision.prospect);
  else reviewed.rejected.push({ prospect: queued.prospect, message: decision.message });
}

console.log(`Approved: ${reviewed.approved.length}    Cannot be approved as they stand: ${reviewed.blocked.length}\n`);

console.log("APPROVED — a human accepted the identity and the source:");
for (const p of reviewed.approved) {
  console.log(`  ✓ ${p.businessName.padEnd(34)} ${p.suburb || ""}`);
}

console.log("\nNOT APPROVABLE — the record does not support a call:");
for (const { prospect, packet } of reviewed.blocked) {
  console.log(`  ✗ ${prospect.businessName}`);
  for (const blocker of packet.blockers) console.log(`      · ${blocker}`);
}

if (VERBOSE) {
  console.log("\nSource caveats a reviewer would be shown:");
  for (const { prospect, packet } of reviewed.blocked) {
    for (const c of packet.sourceCaveats) console.log(`  ${prospect.businessName}: ${c.caveat}`);
  }
}

// ── 3. The audit trail ──────────────────────────────────────────────

step(3, "EVERY DECISION IS AUDITED");

const chain = audit.verifyChain();
console.log(`Decision log entries:   ${audit.count()}`);
console.log(`Hash chain:             ${chain.ok ? "intact" : `BROKEN at row ${chain.brokenAt} — ${chain.message}`}`);
console.log(`Evidence rows:          ${ledger.count()}`);
console.log(`Human-verified rows:    ${ledger.all().filter((r) => r.authoritative).length}  (fixture data is never human-verified)`);

if (VERBOSE) {
  console.log("\nDecision log:");
  for (const row of audit.all()) {
    console.log(`  [${String(row.sequence).padStart(3)}] ${row.decision.toUpperCase().padEnd(8)} ${row.event.padEnd(28)} ${row.actorKind.padEnd(6)} ${row.entityId}`);
  }
}

// ── 4. What has NOT happened ────────────────────────────────────────

step(4, "WHAT HAS NOT HAPPENED");

console.log("  · No website was fetched, crawled or searched.");
console.log("  · No directory, register, Google or Bing API was called.");
console.log("  · No number was washed against the Do Not Call Register.");
console.log("  · No suppression list was consulted.");
console.log("  · No calling-hours check was applied.");
console.log("  · No campaign batch exists, and no batch has been approved.");
console.log("  · No phone call was placed. No SMS or email was sent.");
console.log("  · Nothing was written to a database.");
console.log("\nAn approved prospect is NOT a callable prospect. Approval means a human");
console.log("accepted the identity and the source — the wash, suppression, calling-policy");
console.log("and founder batch-approval steps all still stand between here and a call.");

console.log(`\n${line("━")}`);
console.log("Dry run complete. Nothing external was contacted or changed.");
console.log(line("━"));
