#!/usr/bin/env node
// AIDA Locksmith Acquisition — the dial execution proof (E-7A + E-7B1).
//
//   node scripts/acquisition-dial-proof.js
//   node scripts/acquisition-dial-proof.js --verbose
//
// Shows a founder exactly what WOULD be dialled, and proves that nothing is.
//
// ── WHAT THIS RUNS ──────────────────────────────────────────────────
// One fictional locksmith, through the real modules: evidence, dedupe, DNCR
// wash, durable batch approval, the founder calling policy, the M8E pre-dial
// gate, and then the execution seam. The prospect is invented here, in this
// file. It is not read from anywhere and it belongs to nobody.
//
// E-7B1 added four things to the walkthrough, and each is worth watching:
//
//   * the durable emergency stop, BLOCKING before it is bootstrapped, because
//     an absent row is never permission;
//   * a second worker with a brand-new authorisation for the same business,
//     refused by the durable lock even though the first dispatch's provider
//     already accepted — provider completion is not resolution;
//   * a founder pausing mid-flight, and the next dispatch stopping;
//   * an operator resolving the dispatch by name, which is one of only two
//     things in the system that can release a lock.
//
// The store is IN-MEMORY. Against a real database these would be laq5 rows —
// and laq5 has not been applied to dev or production.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────
//   * place a call — the only providers that exist are a fake and a disabled one
//   * reach a network — nothing here imports a transport
//   * read credentials — no environment variable is consulted
//   * write to dev or production — the store is in-memory and dies with it
//   * record a contact outcome — a fake submission is not an attempt
//   * accept a real number to dial — there is no argument that takes one
//
// It finishes by running the SAME authorisation through the DEFAULT executor,
// which is the disabled provider, so the last thing printed is the refusal
// production would give today.

const path = require("node:path");

process.env.ACQUISITION_ENABLED = "true";

const root = path.join(__dirname, "..");
const S = (m) => require(path.join(root, "src/services", m));

const { createInMemoryAcquisitionStore } = S("acquisition-store");
const { createProspect, transitionProspect } = S("acquisition-prospect");
const { createEvidenceLedger } = S("acquisition-evidence");
const { resolveDuplicates } = S("acquisition-dedupe");
const { createWashStore } = S("acquisition-dncr");
const { createFixtureHolidayProvider, describeCoverage } = S("acquisition-holidays");
const { createAttemptPolicy } = S("acquisition-attempt-policy");
const { createAuditLog } = S("acquisition-audit");
const { canonicalBatchIdentity, recordBatchApproval } = S("acquisition-batch-approval");
const { FOUNDER_CALLING_POLICY } = S("acquisition-calling-approval");
const { createDialAuthoriser } = S("acquisition-authorisation");
const { executeAuthorisedDial, createAcquisitionDialExecutor, EXECUTION_CODES } = S("acquisition-dial-execution");
const { createFakeDialProvider, createDisabledDialProvider } = S("acquisition-dial-provider");
const { readCallingState, enableAcquisitionCalling, pauseAcquisitionCalling } = S("acquisition-calling-state");
const { listUnresolvedDispatches } = S("acquisition-dispatch-store");
const { resolveAbnormalDispatch } = S("acquisition-dispatch-resolution");

const VERBOSE = process.argv.includes("--verbose");

// A fictional business. The number is in the 03 5550 range, which is reserved
// for fiction, and the domain is example.com.au.
const FICTIONAL_NUMBER = "+61355501042";
const WEDNESDAY_2PM_MELBOURNE = "2026-08-05T04:00:00Z";

const now = () => new Date(WEDNESDAY_2PM_MELBOURNE);

const line = (c = "─") => console.log(c.repeat(74));
const head = (t) => {
  console.log("");
  line("=");
  console.log(t);
  line("=");
};

function banner() {
  console.log("");
  line("=");
  console.log("  DRY EXECUTION / NO CALL SENT");
  console.log("");
  console.log("  E-7A acquisition dial proof. Fictional prospect, offline providers.");
  console.log("  No network, no credentials, no database, no contact outcome.");
  line("=");
}

function buildFictionalProspect() {
  const built = createProspect({
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  });
  let p = built.prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    const moved = transitionProspect(p, to, { actor: "Peter Dang", reason: "E-7A proof", now });
    if (!moved.ok || !moved.prospect) throw new Error(`could not move the fictional prospect to ${to}: ${moved.message || "refused"}`);
    p = moved.prospect;
  }
  return p;
}

async function main() {
  banner();

  const store = createInMemoryAcquisitionStore();
  const audit = createAuditLog({ now });
  const prospect = buildFictionalProspect();

  head("1. The fictional prospect");
  console.log(`  ${prospect.businessName} — ${prospect.suburb}, ${prospect.state}`);
  console.log(`  prospectId : ${prospect.prospectId}`);
  console.log(`  number     : ${FICTIONAL_NUMBER}  (fictional; the 03 5550 range is reserved)`);
  console.log(`  lifecycle  : ${prospect.lifecycle}`);

  // Evidence, so qualification has something to stand on.
  const ledger = createEvidenceLedger({ now });
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0].raw],
  ]) {
    ledger.record({
      prospectId: prospect.prospectId,
      kind,
      captureMode: "fixture",
      value,
      observedAt: "2026-07-15T02:00:00.000Z",
      capturedBy: "e7a-proof",
      source: { url: "https://northsidelockandkey.example.com.au/contact" },
    });
  }
  const evidenceRows = ledger.forProspect(prospect.prospectId);

  head("2. The durable state M8E will read");

  await store.upsertProspect(prospect);
  console.log(`  prospect persisted (in-memory store)      ✔  duplicate resolution has something to read`);

  const washStore = createWashStore({ now, mode: "fixture" });
  washStore.wash(FICTIONAL_NUMBER);
  console.log(`  DNCR wash recorded (FIXTURE, not real)    ✔  no Register was contacted`);

  const identity = canonicalBatchIdentity({
    members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164: FICTIONAL_NUMBER }],
    label: "E-7A proof batch",
  });
  const approval = await recordBatchApproval({
    store,
    now,
    identity,
    approvedBy: "Peter Dang",
    reason: "Approved for the E-7A offline proof. Fictional business.",
  });
  console.log(`  founder batch approval written            ${approval.ok ? "✔" : "✖"}  ${identity.batchKey}`);

  const holidays = createFixtureHolidayProvider();
  console.log(`  holiday calendar                          ⚠  ${describeCoverage(holidays)}`);
  console.log(`  calling policy                            ✔  ${FOUNDER_CALLING_POLICY.version} (founder policy, NOT legal advice)`);

  // ── E-7B1: the durable emergency stop ────────────────────────────
  //
  // The in-memory store starts with NO calling-state row, exactly as a database
  // where laq5 has not been applied would. That BLOCKS, and the proof shows it
  // blocking before enabling anything.
  head("2b. The durable emergency stop (E-7B1)");

  const beforeBootstrap = await readCallingState({ store });
  console.log(`  no state row yet          : permitted=${beforeBootstrap.permitted}  (${beforeBootstrap.code})`);
  console.log(`                              ${beforeBootstrap.message}`);

  await store.writeCallingState({ state: "paused", revision: 1, changedBy: "laq5-migration", changedAt: now().toISOString(), reason: "Paused on creation." });
  const bootstrapped = await readCallingState({ store });
  console.log(`  after laq5 bootstrap      : permitted=${bootstrapped.permitted}  (state=${bootstrapped.state})`);

  const enabled = await enableAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "E-7A/E-7B1 offline proof against fictional data.", audit, now });
  const live = await readCallingState({ store });
  console.log(`  founder enables           : permitted=${live.permitted}  revision=${live.revision}  by ${live.changedBy}`);
  console.log(`                              ${enabled.message}`);
  console.log(`  NOTE: enabling this does NOT make a call possible — there is still no live provider.`);

  head("3. M8E — the final pre-dial authorisation gate");

  const duplicateResolution = resolveDuplicates([
    { ...prospect, numbers: [{ e164: FICTIONAL_NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true },
  ]);

  const authoriser = createDialAuthoriser({
    now,
    store,
    audit,
    engineOptions: {
      washStore,
      holidays,
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" }),
      callingPolicyApproval: FOUNDER_CALLING_POLICY,
    },
  });

  const decision = await authoriser.authorise(prospect, { evidenceRows, duplicateResolution });

  console.log(`  authorised        : ${decision.authorised}`);
  console.log(`  code              : ${decision.code}`);
  console.log(`  suppression source: ${decision.suppressionSource}`);
  console.log(`  history source    : ${decision.historySource}`);
  console.log(`  batch source      : ${decision.batchSource}`);
  console.log(`  duplicate source  : ${decision.duplicateSource}`);

  if (!decision.authorised) {
    console.log("");
    console.log(`  REFUSED: ${decision.message}`);
    for (const f of decision.failedChecks) console.log(`    · ${f.check}: ${f.message}`);
    console.log("");
    console.log("  Nothing to execute. That is a correct ending, not a failure of the proof.");
    return;
  }

  console.log("");
  console.log(`  A permission slip was minted:`);
  console.log(`    authorisationId : ${decision.dial.authorisationId}`);
  console.log(`    dispatchId      : ${decision.dial.dispatchId}   ← RANDOM, the durable key`);
  console.log(`    batchKey        : ${decision.dial.batchKey}`);
  console.log(`    destination     : ${decision.dial.e164}   ← the number the GATE cleared`);
  console.log(`    authorisedAt    : ${decision.dial.authorisedAt}`);

  head("4. E-7A — what WOULD be dialled (fake provider)");

  const fake = createFakeDialProvider();
  const executed = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: fake, now, audit });

  console.log(`  ok               : ${executed.ok}`);
  console.log(`  status           : ${executed.status}`);
  console.log(`  executionId      : ${executed.executionId}`);
  console.log(`  provider         : ${executed.provider}  (live: ${executed.providerLive})`);
  console.log(`  providerRef      : ${executed.providerRef}`);
  console.log("");
  console.log("  THE SUBMISSION THE PROVIDER RECEIVED:");
  for (const [k, v] of Object.entries(fake.submissions[0])) {
    console.log(`    ${k.padEnd(14)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  console.log("");
  console.log(`  submissions made : ${fake.submissionCount()}   ← exactly one`);
  console.log("  NO CALL WAS PLACED. The fake provider recorded this and reached nothing.");

  head("5. Replaying the same authorisation");

  const replay = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: fake, now });
  console.log(`  status           : ${replay.status}`);
  console.log(`  submissions made : ${fake.submissionCount()}   ← still one`);
  console.log("  One authorisation permits at most one submission.");

  head("6. Substituting the destination");

  const second = await authoriser.authorise(prospect, { evidenceRows, duplicateResolution });
  const substituted = await executeAuthorisedDial({
    store,
    authorisedDial: second.dial,
    provider: fake,
    now,
    destination: "+61355509911",
  });
  console.log(`  status           : ${substituted.status}`);
  console.log(`  submissions made : ${fake.submissionCount()}   ← still one`);
  console.log("  The caller does not choose the number. The gate does.");

  // ── E-7B1: the durable locks ─────────────────────────────────────
  head("6b. A SECOND worker, a brand new authorisation (E-7B1)");

  const rival = await authoriser.authorise(prospect, { evidenceRows, duplicateResolution });
  console.log(`  new dispatchId   : ${rival.dial.dispatchId}`);
  console.log(`  same fingerprint : ${rival.dial.authorisationId === decision.dial.authorisationId}   ← authorisationId collides, and cannot arbitrate`);

  const rivalProvider = createFakeDialProvider();
  const conflicted = await executeAuthorisedDial({ store, authorisedDial: rival.dial, provider: rivalProvider, now, claimedBy: "worker-b" });
  console.log(`  status           : ${conflicted.status}  (${conflicted.conflictScope})`);
  console.log(`  submissions made : ${rivalProvider.submissionCount()}   ← worker B reached no provider`);
  console.log("  The first dispatch is UNRESOLVED, so it still holds this business");
  console.log("  and this number — even though its provider already accepted.");

  head("6c. The stop, mid-flight");

  const stopped = await pauseAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "Demonstrating the emergency stop.", audit, now });
  console.log(`  founder pauses   : ${stopped.message}`);
  const afterPause = await authoriser.authorise(prospect, { evidenceRows, duplicateResolution });
  const pausedProvider = createFakeDialProvider();
  const blocked = await executeAuthorisedDial({ store, authorisedDial: afterPause.dial, provider: pausedProvider, now });
  console.log(`  status           : ${blocked.status}`);
  console.log(`  submissions made : ${pausedProvider.submissionCount()}`);
  await enableAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "Resuming the proof.", audit, now });
  console.log("  (re-enabled for the rest of the proof; enabling dispatches nothing)");

  head("6d. Unresolved dispatches — a READ-ONLY report");

  const report = await listUnresolvedDispatches({ store, olderThanMs: 0, now });
  console.log(`  unresolved       : ${report.count}`);
  for (const d of report.dispatches) {
    console.log(`    ${d.dispatchId}  ${d.destinationE164}  provider=${d.providerStatus}  holdsLocks=${d.holdsProspectLock}`);
  }
  console.log(`  ${report.note}`);

  head("6e. An operator resolves it — the ONLY thing that releases a lock here");

  const closed = await resolveAbnormalDispatch({
    store,
    dispatchId: decision.dial.dispatchId,
    resolvedBy: "Peter Dang",
    reason: "Offline proof against a fictional business. The provider was a fake and no call was placed.",
    now,
  });
  console.log(`  ${closed.message}`);
  const after = await listUnresolvedDispatches({ store, olderThanMs: 0, now });
  console.log(`  unresolved now   : ${after.count}`);

  head("7. The DEFAULT executor — what production does today");

  const third = await authoriser.authorise(prospect, { evidenceRows, duplicateResolution });
  const executor = createAcquisitionDialExecutor({ now, store, audit });
  const refused = await executor.execute(third.dial);

  console.log(`  provider         : ${executor.providerName}  (live: ${executor.providerLive})`);
  console.log(`  ok               : ${refused.ok}`);
  console.log(`  status           : ${refused.status}`);
  console.log(`  message          : ${refused.message}`);
  console.log("");
  console.log(`  ${createDisabledDialProvider().describe()}`);

  head("8. What was NOT written");

  const outcomes = await store.listOutcomes({ prospectId: prospect.prospectId });
  const suppressions = await store.listSuppressions();
  console.log(`  contact outcomes recorded : ${outcomes.length}   ← a dispatch is not a contact`);
  console.log(`  suppressions written      : ${suppressions.length}`);
  console.log(`  rows written to dev       : 0   (this store is in-memory)`);
  console.log(`  rows written to production: 0`);
  const dispatches = await store.listDialExecutions({});
  console.log(`  dispatch rows (in-memory) : ${dispatches.length}   ← would be laq5 rows against a real database`);
  console.log(`  networks reached          : 0`);
  console.log(`  people contacted          : 0`);

  if (VERBOSE) {
    head("Audit trail (in-memory, discarded when this process exits)");
    for (const row of audit.all ? audit.all() : audit.forEntity("prospect", prospect.prospectId)) {
      console.log(`  ${row.recordedAt}  ${row.event.padEnd(26)} ${row.decision.padEnd(7)} ${row.reason}`);
    }
  }

  console.log("");
  line("=");
  console.log("  DRY EXECUTION / NO CALL SENT");
  console.log("");
  console.log("  E-7 remains OPEN. There is no live provider adapter in this repository,");
  console.log("  and adding one is a founder-authorised milestone, not a configuration change.");
  console.log("  DNCR-1 remains open: no real wash or attestation exists yet.");
  line("=");
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error("PROOF FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
