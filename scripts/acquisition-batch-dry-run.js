#!/usr/bin/env node
// AIDA Locksmith Acquisition — offline batch dry run (A2).
//
//   node scripts/acquisition-batch-dry-run.js
//   node scripts/acquisition-batch-dry-run.js --verbose
//
// Continues where scripts/acquisition-dry-run.js (A1) stops, and walks the rest
// of the pipeline:
//
//   phone normalised → duplicates resolved → DNCR wash → suppression checked
//   → calling policy applied → plain-language eligibility → founder approves
//
// NOTHING EXTERNAL HAPPENS, and nothing can. No network, no database, no
// telephony, no message. The final artifact is a DORMANT approved batch: there
// is no dispatch function in this milestone, and this script demonstrates that
// by finishing with an approved batch and stopping.

const path = require("node:path");

process.env.ACQUISITION_ENABLED = "true";
process.env.ACQUISITION_REVIEW_ENABLED = "true";

const root = path.join(__dirname, "..");
require(path.join(root, "src/services/acquisition-discovery-fixture"));

const { discoverProspects } = require(path.join(root, "src/services/acquisition-discovery"));
const { createEvidenceLedger } = require(path.join(root, "src/services/acquisition-evidence"));
const { createAuditLog } = require(path.join(root, "src/services/acquisition-audit"));
const review = require(path.join(root, "src/services/acquisition-review"));
const { normaliseProspectPhones } = require(path.join(root, "src/services/acquisition-phone"));
const { resolveDuplicates } = require(path.join(root, "src/services/acquisition-dedupe"));
const { createWashStore } = require(path.join(root, "src/services/acquisition-dncr"));
const { createSuppressionList, FIXTURE_SUPPRESSIONS } = require(path.join(root, "src/services/acquisition-suppression"));
const { createFixtureHolidayProvider, describeCoverage } = require(path.join(root, "src/services/acquisition-holidays"));
const { createAttemptPolicy } = require(path.join(root, "src/services/acquisition-attempt-policy"));
const { createEligibilityEngine } = require(path.join(root, "src/services/acquisition-eligibility"));
const batchSvc = require(path.join(root, "src/services/acquisition-batch"));

const VERBOSE = process.argv.includes("--verbose");

// Frozen clock: Wednesday 5 August 2026, 14:00 in Melbourne.
const RUN_AT = new Date("2026-08-05T04:00:00.000Z");
const now = () => RUN_AT;

const line = (c = "─", w = 78) => c.repeat(w);
const heading = (t) => { console.log(`\n${line("━")}`); console.log(t); console.log(line("━")); };
const step = (n, t) => { console.log(`\n${n}. ${t}`); console.log(line()); };

heading("AIDA LOCKSMITH ACQUISITION — OFFLINE BATCH DRY RUN (A2)");
console.log(`Run at (frozen clock):  ${RUN_AT.toISOString()}  (Wed 14:00 Melbourne)`);

const ledger = createEvidenceLedger({ now });
const audit = createAuditLog({ now });

// ── A1 recap: discover + review ─────────────────────────────────────
const discovery = discoverProspects({ now, ledger, capturedBy: "dry-run", env: process.env });
let prospects = discovery.prospects.map((p) => {
  const ev = ledger.currentForProspect(p.prospectId);
  const queued = review.queueForReview(p, { evidenceRows: ev, actor: "dry-run", now, audit, env: process.env });
  if (!queued.ok) return p;
  const packet = review.buildReviewPacket(queued.prospect, ev);
  if (!packet.canApprove) return queued.prospect;
  const decided = review.recordReviewDecision(queued.prospect, {
    decision: "approve", reviewer: "dry-run stand-in (not a real reviewer)",
    reason: `No gaps. ${packet.sourceSummary}`.slice(0, 300), evidenceRows: ev, audit, now, env: process.env,
  });
  return decided.ok ? decided.prospect : queued.prospect;
});

console.log(`Discovered ${discovery.prospects.length}, refused ${discovery.rejected.length} at source.`);
console.log(`Human-reviewed and accepted: ${prospects.filter((p) => p.lifecycle === "review_approved").length}`);

// ── 1. Normalise ────────────────────────────────────────────────────
step(1, "PHONE NUMBERS NORMALISED");
const numbersFor = new Map();
for (const p of prospects) {
  const result = normaliseProspectPhones(p);
  numbersFor.set(p.prospectId, result);
  for (const bad of result.problems) console.log(`  ! ${p.businessName}: ${bad.message}`);
}
console.log(`  ${prospects.filter((p) => numbersFor.get(p.prospectId).callable.length > 0).length} of ${prospects.length} have a callable number.`);

// ── 2. Duplicates ───────────────────────────────────────────────────
step(2, "DUPLICATES RESOLVED");
const records = prospects.map((p) => ({
  ...p,
  numbers: numbersFor.get(p.prospectId).callable,
  evidenceCount: ledger.currentForProspect(p.prospectId).length,
  hasOfficialSource: true,
}));
const duplicateResolution = resolveDuplicates(records);
console.log(`  ${duplicateResolution.stats.records} records → ${duplicateResolution.stats.clusters} businesses`);
console.log(`  merged automatically: ${duplicateResolution.stats.exactDuplicatesRemoved}   needing your decision: ${duplicateResolution.stats.pendingReview}`);
for (const c of duplicateResolution.clusters.filter((x) => x.size > 1)) {
  console.log(`    · merged: ${c.preserved.names.join("  ⟷  ")}`);
  console.log(`      kept ${c.preserved.numbers.length} number(s) and ${c.preserved.sourceRefs.length} source(s) — nothing discarded`);
}
for (const p of duplicateResolution.pendingReview) console.log(`    ? ${p.aName} ⟷ ${p.bName}: ${p.reasons[0]}`);

// ── 3. DNCR ─────────────────────────────────────────────────────────
step(3, "DNCR WASH PERFORMED (fixture mode — NOT a real wash)");
const washStore = createWashStore({ now, mode: "fixture", audit });
let washed = 0;
for (const r of records) for (const n of r.numbers) { washStore.wash(n.e164); washed += 1; }
console.log(`  ${washed} numbers washed against the FIXTURE register.`);
console.log(`  Results are labelled non-authoritative: a real wash must be imported (mode "import").`);

// ── 4. Suppression ──────────────────────────────────────────────────
step(4, "INTERNAL SUPPRESSION CHECKED");
const suppression = createSuppressionList({ now, audit });
for (const entry of FIXTURE_SUPPRESSIONS) suppression.suppress(entry);
console.log(`  ${suppression.count()} standing suppressions loaded (permanent, cross-campaign).`);
for (const e of suppression.all()) console.log(`    · ${e.reasonLabel} — ${e.scope}-scoped`);

// ── 5. Eligibility ──────────────────────────────────────────────────
step(5, "CALLING POLICY APPLIED  ·  ELIGIBILITY DECIDED");
const holidays = createFixtureHolidayProvider();
console.log(`  ${describeCoverage(holidays)}`);

// The attempt/wash policy is UNAPPROVED by default. The dry run approves it
// explicitly so the rest of the pipeline can be demonstrated — and says so.
const attemptPolicy = createAttemptPolicy({ approved: true, approvedBy: "dry-run stand-in (NOT a real approval)" });
console.log(`  Attempt policy: ${attemptPolicy.describeGap()}`);
console.log(`  Counsel approval: SIMULATED for this dry run. In any real build it is false and blocks everything.`);

const engine = createEligibilityEngine({ now, washStore, suppression, holidays, attemptPolicy, counselApproved: true });

const batch0 = batchSvc.assembleBatch({
  prospects,
  evaluate: (p, ctx) => engine.evaluate(p, { ...ctx, batch: { approved: true, batchHash: "assembly", approvedBy: "dry-run" } }),
  evidenceFor: (id) => ledger.currentForProspect(id),
  duplicateResolution,
  now,
  batchId: "batch_dryrun_1",
});

console.log("");
for (const c of batchSvc.CATEGORIES) {
  const n = batch0.summary[c.key];
  if (n) console.log(`  ${String(n).padStart(3)}  ${c.label}`);
}
console.log(`  ${String(batch0.summary.totalDiscovered).padStart(3)}  total considered`);

console.log("\n  Plain-language decisions:");
for (const row of batch0.rows) {
  const mark = row.eligible ? "✓" : "✗";
  console.log(`   ${mark} ${row.businessName.padEnd(34)} ${row.canonicalNumber || "(no number)"}`);
  if (!row.eligible) console.log(`       ${row.decisiveReason}`);
  else console.log(`       Can be called now. ${row.localTime ? `It is ${row.localTime.time} on a ${row.localTime.weekday} there.` : ""}`);
  if (VERBOSE && row.nextEligibleAt && !row.eligible) console.log(`       Next possible: ${row.nextEligibleAt}`);
}

// ── 6. Founder approval ─────────────────────────────────────────────
step(6, "FOUNDER EXPLICITLY APPROVES A BATCH");
let batch = batch0;
for (const row of batch.rows.filter((r) => r.eligible)) {
  const result = batchSvc.recordFounderAction(batch, { prospectId: row.rowId, action: "approve_record", actor: "dry-run founder", now, audit });
  if (result.ok) batch = result.batch;
}
for (const row of batch.rows.filter((r) => !r.eligible && !r.temporary)) {
  const result = batchSvc.recordFounderAction(batch, { prospectId: row.rowId, action: "reject_record", actor: "dry-run founder", reason: row.decisiveReason.slice(0, 200), now, audit });
  if (result.ok) batch = result.batch;
}

batch = batchSvc.submitForApproval(batch, { actor: "dry-run founder", now, audit }).batch;
const approval = batchSvc.approveBatch(batch, { founder: "dry-run founder", now, audit, note: "Dry run — not a real approval." });

if (!approval.ok) {
  console.log(`  Approval refused: ${approval.message}`);
} else {
  batch = approval.batch;
  console.log(`  State:        ${batch.state}`);
  console.log(`  Approved by:  ${batch.approval.approvedBy}`);
  console.log(`  Approved at:  ${batch.approval.approvedAt}`);
  console.log(`  Bound to:     ${batch.approval.batchHash}`);
  console.log(`  Businesses:   ${batch.approval.recordCount}`);
  console.log(`  Authorises:   ${batch.approval.authorises}`);
}

// Staleness demonstration: re-evaluate the same batch on a Sunday.
step(7, "AN APPROVAL GOES STALE WHEN THE FACTS CHANGE");
const sundayEngine = createEligibilityEngine({
  now: () => new Date("2026-08-09T02:00:00.000Z"),
  washStore, suppression, holidays, attemptPolicy, counselApproved: true,
});
const dispositions = Object.fromEntries(batch.rows.map((r) => [r.prospectId, r.disposition]));
const sundayBatch = batchSvc.assembleBatch({
  prospects,
  evaluate: (p, ctx) => sundayEngine.evaluate(p, { ...ctx, batch: { approved: true, batchHash: "assembly", approvedBy: "dry-run" } }),
  evidenceFor: (id) => ledger.currentForProspect(id),
  duplicateResolution,
  now: () => new Date("2026-08-09T02:00:00.000Z"),
  batchId: "batch_dryrun_1",
  dispositions,
});
const freshness = batchSvc.checkApprovalFreshness(batch, sundayBatch);
console.log(`  Re-checked on Sunday: ${freshness.stale ? "STALE" : "still fresh"}`);
console.log(`  ${freshness.message}`);

// ── Audit ───────────────────────────────────────────────────────────
step(8, "EVERYTHING IS AUDITED");
const chain = audit.verifyChain();
console.log(`  Decision log entries: ${audit.count()}`);
console.log(`  Hash chain:           ${chain.ok ? "intact" : `BROKEN at ${chain.brokenAt}`}`);
if (VERBOSE) for (const r of audit.all()) console.log(`   [${String(r.sequence).padStart(3)}] ${r.decision.toUpperCase().padEnd(8)} ${r.event.padEnd(28)} ${r.actorKind.padEnd(6)} ${r.entityId}`);

// ── What has NOT happened ───────────────────────────────────────────
step(9, "WHAT HAS NOT HAPPENED");
console.log("  · No website was fetched, crawled or searched.");
console.log("  · No real Do Not Call Register wash was performed — the fixture register is not the Register.");
console.log("  · No Twilio, Retell or any provider was contacted.");
console.log("  · No phone call was placed. No SMS or email was sent.");
console.log("  · Nothing was written to a database. No SQL was applied.");
console.log("  · No batch was dispatched — THERE IS NO DISPATCH FUNCTION IN THIS MILESTONE.");
console.log("");
console.log("  The approved batch above is inert data. It records that a person agreed a");
console.log("  specific list of businesses could be called, bound to a hash of exactly what");
console.log("  they saw. Turning that into a call is a later milestone that does not exist.");

console.log(`\n${line("━")}`);
console.log("Dry run complete. Nothing external was contacted or changed.");
console.log(line("━"));
