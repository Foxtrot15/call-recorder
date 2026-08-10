// ============================================================================
// M8L RESTART PROOF — PROCESS B. A fresh OS process that saw no human decide.
//
//   node scripts/dev/acquisition-duplicate-proof/process-b.js
//
// Run AFTER process-a.js. Everything this process knows about the duplicate
// decisions, it read back from durable state. There is no resolution object in
// its heap, no `context.duplicateResolution` in anything it passes, and no way
// for it to construct one the gate would accept.
//
// It proves, in order:
//
//   the resolutions survived the process that made them;
//   a merged candidate is not callable and the canonical business is;
//   an approve-as-new candidate is callable;
//   an undecided one is refused;
//   a caller supplying a clean resolveDuplicates() cannot override any of it;
//   the resolution does not bypass suppression;
//   an unreadable store fails closed with its own code.
//
// NOTHING HERE CONTACTS ANYBODY.
// ============================================================================

const fs = require("node:fs");
const C = require("./common");
const { resolveDuplicateStateForProspect, summariseDuplicateState, DUPLICATE_STATE, DUPLICATE_STATE_CODES } = require("../../../src/services/acquisition-duplicate-state");
const { createDialAuthoriser, isAuthorisedDial, AUTHORISATION_CODES } = require("../../../src/services/acquisition-authorisation");
const { ELIGIBILITY_CODES } = require("../../../src/services/acquisition-eligibility");
const { resolveDuplicates } = require("../../../src/services/acquisition-dedupe");
const { identityFingerprint } = require("../../../src/services/acquisition-prospect");
const { verifyRows } = require("../../../src/services/acquisition-audit");

async function main() {
  console.log("=".repeat(74));
  console.log(`M8L RESTART PROOF — PROCESS B (pid ${process.pid})`);
  console.log("=".repeat(74));
  console.log("");

  if (!fs.existsSync(C.HANDOFF)) {
    console.error(`Run process-a.js first — ${C.HANDOFF} does not exist.`);
    process.exit(1);
  }
  const saw = JSON.parse(fs.readFileSync(C.HANDOFF, "utf8"));
  C.check("B0", "this is a different OS process from the one that decided", saw.pid !== process.pid, `A was pid ${saw.pid}, B is pid ${process.pid}`);

  const store = C.makeStore();
  const canonical = saw.prospects.canonical;
  const merged = saw.prospects.merged;
  const distinct = saw.prospects.distinct;
  const undecided = saw.prospects.undecided;

  // ── 1. The decisions survived ─────────────────────────────────────
  const mergedState = await resolveDuplicateStateForProspect({ store, prospectId: saw.mergedId });
  C.check("B1", "the merge is still there, in a process that never made it", mergedState.state === DUPLICATE_STATE.MERGED, mergedState.code);
  C.check("B2", "it names the same person and the same instant", mergedState.decidedBy === saw.mergedDecidedBy && mergedState.decidedAt === saw.mergedDecidedAt, `${mergedState.decidedBy} at ${mergedState.decidedAt}`);
  C.check("B3", "and the same canonical business", mergedState.canonicalId === saw.canonicalId, mergedState.canonicalId);

  const distinctState = await resolveDuplicateStateForProspect({ store, prospectId: saw.distinctId });
  C.check("B4", "the approve-as-new is still resolved as distinct", distinctState.state === DUPLICATE_STATE.RESOLVED_DISTINCT);

  const undecidedState = await resolveDuplicateStateForProspect({ store, prospectId: saw.undecidedId });
  C.check("B5", "the undecided one is still unresolved", undecidedState.state === DUPLICATE_STATE.UNRESOLVED && undecidedState.blocked === true);

  const rows = await store.listDecisions({});
  C.check("B6", "the decision chain read back out of durable state verifies", verifyRows(rows).ok === true, `${rows.length} row(s)`);

  // ── 2. THE MILESTONE: the gate decides from that, and only that ───
  const canonicalInputs = C.gateInputs(canonical, C.CANONICAL_NUMBER);
  C.check("B7", "the context handed to the gate contains NO duplicateResolution", Object.prototype.hasOwnProperty.call(canonicalInputs.context, "duplicateResolution") === false);

  const canonicalDecision = await createDialAuthoriser({ now: C.clock, store, engineOptions: canonicalInputs.engineOptions }).authorise(canonical, canonicalInputs.context);
  C.check("B8", "THE CANONICAL BUSINESS IS AUTHORISED, from durable state alone", canonicalDecision.authorised === true && canonicalDecision.duplicateSource === "durable", `code=${canonicalDecision.code}`);
  C.check("B9", "and only then is a permission slip minted", isAuthorisedDial(canonicalDecision.dial) === true);

  // ── 3. The merged candidate is not a second calling target ────────
  const mergedInputs = C.gateInputs(merged, C.NUMBER);
  const mergedGate = createDialAuthoriser({ now: C.clock, store, engineOptions: mergedInputs.engineOptions });

  const mergedDecision = await mergedGate.authorise(merged, mergedInputs.context);
  C.check(
    "B10",
    "the merged candidate is REFUSED — calling it would dial the canonical business twice",
    mergedDecision.authorised === false && mergedDecision.code === ELIGIBILITY_CODES.DUPLICATE_OF_CANONICAL,
    `code=${mergedDecision.code}`
  );
  C.check("B11", "and no slip was minted for it", mergedDecision.dial === null);

  // ── 4. A caller cannot assert its way past the decision ───────────
  //
  // This is the exact object every dry run and proof used to build, and it says
  // the candidate is unique — because it is the only record in it.
  const forged = resolveDuplicates([{ ...merged, numbers: [{ e164: C.NUMBER }], hasOfficialSource: true }]);
  const liar = await mergedGate.authorise(merged, { ...mergedInputs.context, duplicateResolution: forged });
  C.check(
    "B12",
    "a caller-supplied clean resolution changes NOTHING",
    liar.authorised === false && liar.code === ELIGIBILITY_CODES.DUPLICATE_OF_CANONICAL && liar.duplicateSource === "durable",
    `code=${liar.code} duplicateSource=${liar.duplicateSource}`
  );

  const undecidedInputs = C.gateInputs(undecided, "+61355501099");
  const undecidedDecision = await createDialAuthoriser({ now: C.clock, store, engineOptions: undecidedInputs.engineOptions }).authorise(undecided, {
    ...undecidedInputs.context,
    duplicateResolution: resolveDuplicates([{ ...undecided, numbers: [{ e164: "+61355501099" }], hasOfficialSource: true }]),
  });
  C.check(
    "B13",
    "an UNDECIDED identity is refused however clean the caller's analysis is",
    undecidedDecision.authorised === false && undecidedDecision.code === ELIGIBILITY_CODES.DUPLICATE_REVIEW,
    `code=${undecidedDecision.code}`
  );

  // ── 5. A record nothing has ever assessed ─────────────────────────
  const ghost = { ...canonical, prospectId: "pr_never_stored_anywhere", businessName: "M8L Ghost Locks" };
  const ghostInputs = C.gateInputs(ghost, C.CANONICAL_NUMBER);
  const ghostDecision = await createDialAuthoriser({ now: C.clock, store, engineOptions: ghostInputs.engineOptions }).authorise(ghost, ghostInputs.context);
  C.check("B14", "a record that exists only in memory is refused as never assessed", ghostDecision.code === ELIGIBILITY_CODES.DUPLICATE_NEVER_ASSESSED, `code=${ghostDecision.code}`);

  // ── 6. Resolution is not permission ───────────────────────────────
  await store.appendSuppression({
    reason: "opt_out",
    scope: "business",
    fingerprint: identityFingerprint({ businessName: canonical.businessName, suburb: canonical.suburb, state: canonical.state }),
    e164: C.CANONICAL_NUMBER,
    actor: "m8l-probe",
    actorKind: "human",
    note: "M8L proof: asked never to be contacted again.",
    suppressedAt: C.AT.toISOString(),
  });

  const afterOptOut = await createDialAuthoriser({ now: C.clock, store, engineOptions: canonicalInputs.engineOptions }).authorise(canonical, canonicalInputs.context);
  C.check("B15", "a resolved duplicate does NOT outrank an opt-out recorded afterwards", afterOptOut.authorised === false && afterOptOut.code === ELIGIBILITY_CODES.SUPPRESSED, `code=${afterOptOut.code}`);
  C.check("B16", "and the duplicate resolution is untouched by it", (await resolveDuplicateStateForProspect({ store, prospectId: saw.canonicalId })).resolved === true);
  C.check("B17", "no permission slip was minted on the refusal", afterOptOut.dial === null);

  // ── 7. Fail closed ────────────────────────────────────────────────
  //
  // The DISTINCT business, not the canonical one: step 6 just recorded an
  // opt-out against the canonical, and suppression rightly outranks a read
  // failure. Asserting the store code against a suppressed business would be
  // asserting the wrong precedence and would fail for the right reason.
  const blind = { ...store, async loadProspect() { throw new Error("connection terminated unexpectedly"); } };
  const unreadable = await resolveDuplicateStateForProspect({ store: blind, prospectId: saw.distinctId });
  C.check("B18", "an unreadable store is 'unavailable', never 'no duplicate known'", unreadable.unavailable === true && unreadable.code === DUPLICATE_STATE_CODES.STORE_UNAVAILABLE, unreadable.message);

  const distinctInputs = C.gateInputs(distinct, "+61355501088");
  const blindDecision = await createDialAuthoriser({ now: C.clock, store: blind, engineOptions: distinctInputs.engineOptions }).authorise(distinct, distinctInputs.context);
  C.check(
    "B19",
    "and the gate refuses with its own code rather than a finding about the business",
    blindDecision.authorised === false && blindDecision.code === AUTHORISATION_CODES.DUPLICATE_RESOLUTION_STORE_UNAVAILABLE && blindDecision.duplicateSource === "unavailable",
    `code=${blindDecision.code}`
  );

  const stillSuppressed = await createDialAuthoriser({ now: C.clock, store: blind, engineOptions: canonicalInputs.engineOptions }).authorise(canonical, canonicalInputs.context);
  C.check("B19b", "and an unreadable duplicate store still does not outrank a known opt-out", stillSuppressed.code === ELIGIBILITY_CODES.SUPPRESSED, `code=${stillSuppressed.code}`);

  // ── 8. What a founder can read ────────────────────────────────────
  const summary = await summariseDuplicateState({ store });
  C.check(
    "B20",
    "the read model counts every bucket for a founder",
    summary.available === true && summary.counts.total === 3 && summary.counts.merged === 1 && summary.counts.resolvedDistinct === 1 && summary.counts.unresolved === 1,
    JSON.stringify(summary.counts)
  );

  console.log("");
  console.log("  Nothing was called, scheduled or prepared. No database was touched.");
  C.summary("PROCESS B");
}

main().catch((err) => {
  console.error(`\nPROCESS B FAILED: ${err.stack}`);
  process.exit(1);
});
