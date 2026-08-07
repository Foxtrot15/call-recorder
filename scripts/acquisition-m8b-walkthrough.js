#!/usr/bin/env node
// AIDA Locksmith Acquisition — the M8B end-to-end walkthrough.
//
//   node scripts/acquisition-m8b-walkthrough.js
//   node scripts/acquisition-m8b-walkthrough.js --verbose
//
// Walks the WHOLE machine on invented data, offline:
//
//   fixture leads → ingestion → normalisation → dedupe → qualification
//   → compliance → queue selection → opt-out → re-import → still suppressed
//
// NOTHING EXTERNAL HAPPENS AND NOTHING CAN. No network, no database, no
// telephony, no message, no provider. The "call" in step 9 is a founder typing
// what a locksmith said; there is no dialler in this build.
//
// The two dry runs that came before this one still stand:
//   scripts/acquisition-dry-run.js         A1 — discovery, evidence, review
//   scripts/acquisition-batch-dry-run.js   A2 — wash, eligibility, batch
// This one exercises what M8B added and the parts of A1/A2 it depends on.

const path = require("node:path");

process.env.ACQUISITION_ENABLED = "true";
process.env.ACQUISITION_REVIEW_ENABLED = "true";

const root = path.join(__dirname, "..");
const req = (m) => require(path.join(root, m));

const { registerM8bFixtureAdapter, M8B_ADAPTER_NAME } = req("src/services/acquisition-m8b-fixtures");
const { discoverProspects } = req("src/services/acquisition-discovery");
const { createEvidenceLedger } = req("src/services/acquisition-evidence");
const { createAuditLog, verifyRows } = req("src/services/acquisition-audit");
const review = req("src/services/acquisition-review");
const { normaliseProspectPhones } = req("src/services/acquisition-phone");
const { resolveDuplicates } = req("src/services/acquisition-dedupe");
const { qualifyProspect, rankQualified, compareQualifications, describeQualification } = req("src/services/acquisition-qualification");
const { createWashStore } = req("src/services/acquisition-dncr");
const { createSuppressionList } = req("src/services/acquisition-suppression");
const { createFixtureHolidayProvider } = req("src/services/acquisition-holidays");
const { createAttemptPolicy } = req("src/services/acquisition-attempt-policy");
const { createEligibilityEngine } = req("src/services/acquisition-eligibility");
const { createCallQueue } = req("src/services/acquisition-queue");
const { createOutcomeRecorder } = req("src/services/acquisition-outcome");
const { summarisePipeline, describePipeline } = req("src/services/acquisition-readmodel");
const { identityFingerprint } = req("src/services/acquisition-prospect");
const batchSvc = req("src/services/acquisition-batch");

const VERBOSE = process.argv.includes("--verbose");

// Frozen clock: Friday 7 August 2026, 13:00 in Melbourne (11:00 in Perth).
const RUN_AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => RUN_AT;

const W = 78;
const line = (c = "─") => c.repeat(W);
let stepNo = 0;
function step(title) {
  stepNo += 1;
  console.log(`\n${line()}`);
  console.log(`${stepNo}. ${title}`);
  console.log(line());
}
const say = (s = "") => console.log(s);
// The engine runs EVERY computable check and reports the highest-precedence
// failure as decisive. For the timezone and holiday probes we want the window
// verdict specifically, which may be sitting behind a higher-precedence block.
const windowVerdict = (d) => {
  if (d.eligible) return "window OK";
  const w = d.failedChecks.find((f) => f.check === "calling_window");
  return w ? (w.detail && w.detail.windowCode) || w.code : `window OK (blocked earlier by ${d.code})`;
};
// localTime is an object ({ date, time, weekday, ... }) or null when no
// timezone could be applied. Rendering it raw prints "[object Object]".
const clock = (lt) => (lt ? `${lt.weekday} ${lt.time}` : "—");
const bullet = (s) => console.log(`   ${s}`);

console.log(line("═"));
console.log("AIDA LOCKSMITH ACQUISITION — M8B END-TO-END WALKTHROUGH");
console.log(line("═"));
say(`Clock frozen at ${RUN_AT.toISOString()} (Friday 7 August 2026, 13:00 Melbourne).`);
say("Every business below is invented. Every number is in an ACMA fiction range.");

// ── 0. Discovery ────────────────────────────────────────────────────

step("INGESTION — fixture leads become prospects");

registerM8bFixtureAdapter();
const ledger = createEvidenceLedger({ now });
const audit = createAuditLog({ now });

const discovery = discoverProspects({ adapter: M8B_ADAPTER_NAME, now, ledger, capturedBy: "m8b-walkthrough" });
if (!discovery.ok) {
  console.error(`Discovery failed: ${discovery.message}`);
  process.exit(1);
}

say(`Adapter "${M8B_ADAPTER_NAME}" (requiresNetwork: false).`);
say(`Admitted ${discovery.prospects.length} prospects, refused ${discovery.rejected.length} at the source gate.`);
for (const r of discovery.rejected) bullet(`refused (${r.code}): ${r.message}`);
say(`Evidence rows written: ${ledger.count()}. Nothing was fetched — every row is capture_mode "fixture".`);

const byName = new Map(discovery.prospects.map((p) => [p.businessName, p]));
const evidenceFor = (prospectId) => ledger.forProspect(prospectId);

// ── 1. Normalisation ────────────────────────────────────────────────

step("NORMALISATION — published numbers become E.164");

for (const p of discovery.prospects) {
  const phones = normaliseProspectPhones(p);
  const rendered = phones.numbers.map((n) => `${n.raw} → ${n.ok && n.callable ? n.e164 : `${n.kind.toUpperCase()} (not callable)`}`);
  if (VERBOSE || phones.callable.length === 0 || phones.numbers.length > 1) {
    bullet(`${p.businessName}: ${rendered.join("; ")}`);
  }
}
say("");
say('Note the two spellings of one number: "(03) 5550 1180" and "+61 3 5550 1180"');
say("both normalise to +61355501180. That is what makes the next step possible.");

// ── 2. Deduplication ────────────────────────────────────────────────

step("DEDUPLICATION — the same locksmith found twice");

// Dedupe reads NORMALISED numbers, never raw ones — which is the whole reason
// normalisation is the step before this one. Handing it raw prospects would
// make it match on ABN and identity alone, and the two spellings of the same
// number above would contribute nothing.
const dedupeRecords = discovery.prospects.map((p) => ({
  ...p,
  numbers: normaliseProspectPhones(p).callable.map((n) => n.e164),
  hasOfficialSource: true,
  evidenceCount: evidenceFor(p.prospectId).length,
}));
const duplicateResolution = resolveDuplicates(dedupeRecords);
const stats = duplicateResolution.stats;
say(`Records: ${stats.records}. Clusters: ${stats.clusters}. Redundant records merged away: ${stats.exactDuplicatesRemoved}. Needing a person: ${stats.pendingReview}.`);
say("");
for (const cluster of duplicateResolution.clusters.filter((c) => c.size > 1)) {
  bullet(`canonical: ${cluster.canonicalName}`);
  bullet(`  merged in: ${cluster.preserved.names.filter((n) => n !== cluster.canonicalName).join(", ")}`);
  bullet(`  numbers preserved across the cluster: ${cluster.preserved.numbers.join(", ")}`);
  bullet(`  ABNs seen: ${cluster.preserved.abns.join(", ")}`);
}
for (const pending of duplicateResolution.pendingReview) {
  bullet(`needs a decision (${pending.decision}): ${pending.a.businessName} ⇄ ${pending.b.businessName}`);
  for (const s of pending.signals || []) bullet(`     ${s.label || s.key} (${s.strength})`);
}
say("");
say("Nothing was destroyed: the cluster carries every name, number, ABN and source");
say("its members held. Consolidation is a proposal, not a deletion.");

// ── 3. Qualification ────────────────────────────────────────────────

step("QUALIFICATION — worth approaching, and in what order");

const qualifications = new Map();
for (const p of discovery.prospects) {
  qualifications.set(p.prospectId, qualifyProspect(p, { evidenceRows: evidenceFor(p.prospectId), at: RUN_AT }));
}
const ranked = rankQualified([...qualifications.values()]);

say("score  tier      verdict         business");
say(line("·"));
for (const q of ranked) {
  say(`${String(q.score).padStart(5)}  ${q.tier.padEnd(9)} ${q.verdict.padEnd(15)} ${q.businessName}`);
  if (q.disqualifiers.length) for (const d of q.disqualifiers) bullet(`   ✗ ${d.why}`);
}

say("");
say("Why the top one is above the second:");
const why = compareQualifications(ranked[0], ranked[1]);
say(`  ${why.reason}`);
if (why.differingSignals) for (const d of why.differingSignals.slice(0, 4)) say(`    ${d.label}: ${d.winner} vs ${d.loser}`);

if (VERBOSE) {
  say("");
  say(`Full explanation for ${ranked[0].businessName}:`);
  say(describeQualification(ranked[0]).split("\n").map((l) => `  ${l}`).join("\n"));
}

say("");
say("Note what is NOT scored anywhere above: how many calls these businesses take.");
say("It is not visible from outside, so it is reported as unknown on every record");
say("rather than estimated.");

// ── 4. Human review ─────────────────────────────────────────────────

step("HUMAN REVIEW — a person accepts the identity and the source");

const reviewed = discovery.prospects.map((p) => {
  const ev = evidenceFor(p.prospectId);
  const queued = review.queueForReview(p, { evidenceRows: ev, actor: "m8b-walkthrough", now, audit, env: process.env });
  if (!queued.ok) return p;
  const packet = review.buildReviewPacket(queued.prospect, ev);
  if (!packet.canApprove) return queued.prospect;
  const decided = review.recordReviewDecision(queued.prospect, {
    decision: "approve",
    reviewer: "walkthrough stand-in (NOT a real reviewer)",
    reason: `No gaps. ${packet.sourceSummary}`.slice(0, 300),
    evidenceRows: ev,
    audit,
    now,
    env: process.env,
  });
  return decided.ok ? decided.prospect : queued.prospect;
});

const approvedCount = reviewed.filter((p) => p.lifecycle === "review_approved").length;
say(`Accepted by a person: ${approvedCount} of ${reviewed.length}.`);
for (const p of reviewed.filter((x) => x.lifecycle !== "review_approved")) {
  bullet(`still ${p.lifecycle}: ${p.businessName}`);
}
say("");
say("An approved prospect is NOT a callable prospect. Review accepted the identity");
say("and the source. Permission is decided separately, below.");

// ── 5. Compliance inputs ────────────────────────────────────────────

step("COMPLIANCE INPUTS — suppression, the DNC Register, holidays");

const suppression = createSuppressionList({ now, audit });

// One business already opted out, before this run began.
const altona = byName.get("Altona Bay Locksmiths");
suppression.suppress({
  reason: "opt_out",
  fingerprint: identityFingerprint(altona),
  actor: "Peter Dang",
  actorKind: "human",
  note: "Asked not to be contacted again when we spoke in June. Permanent, across every campaign.",
});
bullet(`Suppression list seeded: ${suppression.count()} entry (Altona Bay Locksmiths opted out before this run).`);

// The wash. Import mode: results arrive from a file a human produced, never
// from a live query — there is no live DNCR path in this build.
const washStore = createWashStore({ now, mode: "import", audit });
const numberOf = (name) => {
  const phones = normaliseProspectPhones(byName.get(name));
  return phones.callable[0] ? phones.callable[0].e164 : null;
};

const washBatch = {
  washedAt: new Date(RUN_AT.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
  batchRef: "m8b-walkthrough-wash-001",
  // WHO says these are real results. Without it an imported file is
  // indistinguishable from a made-up one — which this one is.
  attestedBy: "walkthrough stand-in (NOT a real wash)",
  importedFrom: "invented wash file (no Register was contacted)",
  results: discovery.prospects
    .map((p) => {
      const e164 = numberOf(p.businessName);
      if (!e164) return null;
      // Deliberately absent: Dandenong Ranges Locksmiths — never washed.
      if (p.businessName === "Dandenong Ranges Locksmiths") return null;
      return { e164, result: p.businessName === "Werribee Lock Centre" ? "listed" : "not_listed" };
    })
    .filter(Boolean),
};
const imported = washStore.importResults(washBatch);
if (!imported.ok) {
  console.error(`Wash import failed: ${imported.message}`);
  process.exit(1);
}
bullet(`Wash results imported: ${imported.imported} (${imported.listed} listed), washed ${washBatch.washedAt.slice(0, 10)}.`);
bullet(`One number is on the Register (Werribee Lock Centre) and one was never washed (Dandenong Ranges Locksmiths).`);

// Holidays. Per-state providers, because a Victorian public holiday is not a
// public holiday in New South Wales — see A-L2 in the spec, which this makes
// visible rather than hiding.
const holidaysFor = (state) => createFixtureHolidayProvider({ regions: ["national", String(state || "").toLowerCase()] });
bullet(`Holiday calendar: hand-compiled fixture, 2026 only, per-state scoping (${holidaysFor("VIC").coverage.from} to ${holidaysFor("VIC").coverage.to}).`);

// SIMULATED APPROVALS — loudly, because in any real build both are false and
// both block every prospect.
const attemptPolicy = createAttemptPolicy({ approved: true, approvedBy: "walkthrough stand-in (NOT a real approval)" });
say("");
say("⚠  SIMULATED FOR THIS WALKTHROUGH, AND FALSE IN EVERY REAL BUILD:");
say("   • counsel sign-off on the permitted calling window (A-L1)");
say("   • approval of the attempt caps, retry spacing and cooldowns (A-L6)");
say("   Without both, the eligibility engine blocks every prospect and this");
say("   walkthrough would end here. Neither has actually been obtained.");

const engineFor = (state) =>
  createEligibilityEngine({
    now,
    washStore,
    suppression,
    holidays: holidaysFor(state),
    attemptPolicy,
    counselApproved: true,
  });

const BATCH_CONTEXT = { approved: true, batchHash: "walkthrough-assembly", approvedBy: "walkthrough stand-in" };
const evaluate = (prospect, ctx = {}) => engineFor(prospect.state).evaluate(prospect, { batch: BATCH_CONTEXT, duplicateResolution, ...ctx });

// ── 6. Eligibility ──────────────────────────────────────────────────

step("COMPLIANCE DECISION — who may be called, right now");

for (const p of reviewed) {
  const decision = evaluate(p, { evidenceRows: evidenceFor(p.prospectId) });
  const mark = decision.eligible ? "✓" : "✗";
  say(`  ${mark} ${p.businessName.padEnd(38)} ${decision.eligible ? "CALLABLE" : decision.code}`);
  if (!decision.eligible && VERBOSE) bullet(`     ${decision.message}`);
}

// ── 7. Timezone and holidays ────────────────────────────────────────

step("TIMEZONE AND HOLIDAYS — the same instant, different answers");

const SATURDAY_MORNING = new Date("2026-08-07T23:30:00.000Z"); // Sat 09:30 Melbourne, 07:30 Perth
say(`At ${SATURDAY_MORNING.toISOString()} — Saturday 09:30 in Melbourne, 07:30 in Perth:`);
for (const name of ["Brunswick Rapid Locksmiths", "Fremantle Coast Locksmiths"]) {
  const p = reviewed.find((x) => x.businessName === name);
  const d = evaluate(p, { evidenceRows: evidenceFor(p.prospectId), at: SATURDAY_MORNING });
  bullet(`${name.padEnd(34)} local ${clock(d.localTime).padEnd(10)} ${windowVerdict(d)}`);
}
say("   The Perth business is not callable because it is 07:30 THERE. Calling");
say("   hours are checked in the business's own time, never the server's.");

const CUP_DAY = new Date("2026-11-03T02:00:00.000Z"); // Tue 13:00 Melbourne (AEDT), Melbourne Cup Day
say("");
say(`At ${CUP_DAY.toISOString()} — Melbourne Cup Day, a Victorian public holiday:`);
for (const name of ["Brunswick Rapid Locksmiths", "Inner West Lock & Key"]) {
  const p = reviewed.find((x) => x.businessName === name);
  const d = evaluate(p, { evidenceRows: evidenceFor(p.prospectId), at: CUP_DAY });
  bullet(`${name.padEnd(34)} ${p.state}  local ${clock(d.localTime).padEnd(10)} ${windowVerdict(d)}`);
}
say("   Victoria is blocked; New South Wales is not. The calendar is scoped per");
say("   state — which is exactly the open decision A-L2 records, made visible.");

const NEW_YEAR_2027 = new Date("2027-01-05T02:00:00.000Z");
const brunswick = reviewed.find((x) => x.businessName === "Brunswick Rapid Locksmiths");
const beyondCalendar = evaluate(brunswick, { evidenceRows: evidenceFor(brunswick.prospectId), at: NEW_YEAR_2027 });
say("");
say(`At ${NEW_YEAR_2027.toISOString()} — beyond the calendar's coverage:`);
bullet(`${brunswick.businessName}: ${windowVerdict(beyondCalendar)}`);
say("   The calendar expiring stops calls loudly. It does not degrade into");
say("   calling on Christmas Day 2027.");

// ── 8. The queue ────────────────────────────────────────────────────

step("QUEUE — the next locksmiths to call, and why those");

const queue = createCallQueue({ now, evaluate, audit });
const preview = queue.preview({ prospects: reviewed, limit: 20, at: RUN_AT, evidenceFor, duplicateResolution, qualificationFor: (p) => qualifications.get(p.prospectId) });

say(`Considered ${preview.considered}. Eligible right now: ${preview.eligibleCount}.`);
say("");
for (const row of preview.next) {
  say(`  ${String(row.position).padStart(2)}. ${row.businessName.padEnd(34)} ${row.e164.padEnd(15)} ${row.tier} (${row.score})`);
  if (VERBOSE) for (const w of row.whyRanked) bullet(`      ${w}`);
}
say("");
say(`Skipped (${preview.skipped.length}):`);
for (const s of preview.skipped) say(`   ${s.code.padEnd(22)} ${s.businessName || s.prospectId}`);

say("");
say(`Ordered by: ${preview.ordering.by}. Tie-breaks, in order: ${preview.ordering.tieBreakers.map((t) => t.key).join(" → ")}.`);

// Two workers, to show the lease
const workerA = queue.selectNext({ prospects: reviewed, limit: 2, workerId: "worker-a", requestId: "wt-1", at: RUN_AT, evidenceFor, duplicateResolution, qualificationFor: (p) => qualifications.get(p.prospectId) });
const workerB = queue.selectNext({ prospects: reviewed, limit: 2, workerId: "worker-b", requestId: "wt-2", at: RUN_AT, evidenceFor, duplicateResolution, qualificationFor: (p) => qualifications.get(p.prospectId) });
say("");
say(`worker-a reserved: ${workerA.selected.map((r) => r.businessName).join(", ")}`);
say(`worker-b reserved: ${workerB.selected.map((r) => r.businessName).join(", ")}`);
const overlap = workerA.selected.filter((a) => workerB.selected.some((b) => b.prospectId === a.prospectId));
say(`Overlap between the two workers: ${overlap.length}. ${overlap.length === 0 ? "Neither can call the same business." : "!! LEASES ARE BROKEN !!"}`);

const retry = queue.selectNext({ prospects: reviewed, limit: 2, workerId: "worker-a", requestId: "wt-1", at: RUN_AT, evidenceFor, duplicateResolution, qualificationFor: (p) => qualifications.get(p.prospectId) });
say(`worker-a retries request wt-1: reserved ${queue.activeLeases().length} in total (unchanged), returned ${retry.selected.length} — the same prospects, not new ones.`);
say("");
say(workerA.note);

// Everything from here needs `await`: recording an outcome became async in
// M8C so that the suppression it triggers can be a durable write. CommonJS
// has no top-level await, hence the main().
async function main() {
  // ── 9. An outcome ───────────────────────────────────────────────────

  step("OUTCOME — a locksmith asks not to be contacted again");

  const outcomes = createOutcomeRecorder({ now, suppression, audit, attemptPolicy });

  // Move the subject through the states a real attempt would produce.
  const prestonRow = [...workerA.selected, ...workerB.selected].find((r) => r.businessName === "Preston Key & Safe");
  let preston = reviewed.find((p) => p.businessName === "Preston Key & Safe");
  const { transitionProspect } = req("src/services/acquisition-prospect");
  preston = transitionProspect(preston, "queued", { actor: "acquisition-queue", reason: "Selected into an approved calling batch.", now }).prospect;

  say(`Nobody has been called. What follows is a founder typing what a locksmith said.`);
  say("");
  const optOut = await outcomes.record({
    prospect: preston,
    outcome: "opt_out",
    actor: "Peter Dang",
    actorKind: "human",
    note: "Said they are not interested and asked us never to contact them again.",
    e164: prestonRow ? prestonRow.e164 : numberOf("Preston Key & Safe"),
  });

  if (!optOut.ok) {
    console.error(`Recording the outcome failed: ${optOut.message}`);
    process.exit(1);
  }
  bullet(`${preston.businessName}: ${optOut.from} → ${optOut.to}`);
  bullet(`Hops recorded: ${optOut.hops.map((h) => `${h.from}→${h.to}`).join(", ")}`);
  bullet(`Suppression: ${optOut.suppression.applied ? `${optOut.suppression.scope}-wide, reason "${optOut.suppression.reason}"` : "none"}`);
  bullet(optOut.consequence.message);

  const prestonSuppressed = preston;
  const optedOut = optOut.prospect;

  // ── 10. Re-import ───────────────────────────────────────────────────

  step("RE-IMPORT — the same business arrives again, three months later");

  say("A second data drop contains the same locksmith with its name and number");
  say("written differently:");
  bullet(`  original:  "Preston Key & Safe"        (03) 5550 2287`);
  bullet(`  re-import: "Preston Key and Safe Pty Ltd"  03-5550-2287`);
  say("");

  const reimport = reviewed.find((p) => p.businessName === "Preston Key and Safe Pty Ltd");
  const reimportFingerprint = identityFingerprint(reimport);
  const originalFingerprint = identityFingerprint(prestonSuppressed);

  bullet(`identity fingerprint, original:  ${originalFingerprint}`);
  bullet(`identity fingerprint, re-import: ${reimportFingerprint}`);
  bullet(`Same identity: ${originalFingerprint === reimportFingerprint ? "YES" : "NO"}`);

  const hit = suppression.check({ e164: numberOf("Preston Key and Safe Pty Ltd"), fingerprint: reimportFingerprint });
  bullet(`Suppression check on the re-imported record: ${hit.suppressed ? "SUPPRESSED" : "NOT SUPPRESSED"}`);
  if (hit.suppressed) bullet(`  ${hit.message}`);

  const reimportDecision = evaluate(reimport, { evidenceRows: evidenceFor(reimport.prospectId) });
  bullet(`Eligibility on the re-imported record: ${reimportDecision.eligible ? "CALLABLE" : reimportDecision.code}`);

  const postOptOutQueue = queue.preview({
    prospects: [...reviewed.filter((p) => p.businessName !== "Preston Key & Safe"), optedOut],
    limit: 20,
    at: RUN_AT,
    evidenceFor,
    qualificationFor: (p) => qualifications.get(p.prospectId),
  });
  const stillOffered = postOptOutQueue.next.some((r) => r.businessName.startsWith("Preston Key"));
  say("");
  say(`Either spelling of this business appearing in the queue: ${stillOffered ? "YES — THIS IS A BUG" : "NO"}`);
  say("");
  say("Normalisation happens BEFORE the suppression comparison, and suppression is");
  say("keyed on the business identity rather than on the prospect row — so throwing");
  say("the record away and re-importing it cannot resurrect them.");

  // ── 11. Read model ──────────────────────────────────────────────────

  step("READ MODEL — what a founder would see");

  const finalProspects = [...reviewed.filter((p) => p.businessName !== "Preston Key & Safe"), optedOut];
  const summary = summarisePipeline({
    prospects: finalProspects,
    evaluate,
    qualifyFor: (p) => qualifications.get(p.prospectId),
    evidenceFor,
    suppression,
    queue,
    duplicateResolution,
    at: RUN_AT,
  });
  say(describePipeline(summary));
  say("");
  say('"Callable now" here is larger than the queue offered, and that is the design:');
  say("this number is COMPLIANCE only — it counts everyone we are permitted to call.");
  say("The queue then applies qualification on top, which is what removed the plumber");
  say("and the lead-resale page. Two questions, two answers, never merged into one.");

  // ── 12. Audit ───────────────────────────────────────────────────────

  step("AUDIT — the trail, and whether it has been tampered with");

  const rows = audit.all();
  say(`Decision log: ${rows.length} rows, hash-chained.`);
  const verification = verifyRows(rows);
  say(`Chain verification: ${verification.ok ? "INTACT" : `BROKEN at index ${verification.brokenAt}`}`);
  if (VERBOSE) {
    for (const r of rows.slice(-8)) say(`   ${r.recordedAt}  ${String(r.entityType).padEnd(12)} ${String(r.event).padEnd(18)} ${r.actor}`);
  }

  // ── What did not happen ─────────────────────────────────────────────

  console.log(`\n${line("═")}`);
  console.log("WHAT DID NOT HAPPEN");
  console.log(line("═"));
  for (const s of [
    "No website was fetched. No search API, directory or business register was queried.",
    "No number was washed against the real Do Not Call Register — the results were imported from an invented file.",
    "No call was placed, scheduled, or prepared. There is no dialler in this build.",
    "No SMS and no email was sent.",
    "No database was written to. Every store above is in memory and is gone when this process exits.",
    "No provider was contacted: not Twilio, not Retell, not Anthropic.",
    "No SQL was applied. supabase/sql/laq2_*.sql is written and unapplied, like laq1 before it.",
    "No counsel has approved the calling window, and no one has approved the attempt caps.",
  ]) {
    console.log(`  ✗ ${s}`);
  }
  console.log("");
  console.log("  The terminal artifact of this entire walkthrough is a list of prospects");
  console.log("  with lease tokens. Data describing an intention — not an instruction.");
  console.log(line("═"));

  // A non-zero exit if any invariant the walkthrough exists to demonstrate failed.
  const failures = [];
  if (overlap.length !== 0) failures.push("two workers were handed the same prospect");
  if (stillOffered) failures.push("an opted-out business reappeared in the queue after re-import");
  if (!hit.suppressed) failures.push("the re-imported record was not caught by suppression");
  if (reimportDecision.eligible) failures.push("the re-imported record was judged callable");
  if (!verification.ok) failures.push("the audit chain did not verify");
  if (failures.length) {
    console.error(`\nWALKTHROUGH FAILED:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}`);
    process.exit(1);
  }

}

main().catch((err) => {
  console.error(`
WALKTHROUGH CRASHED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
