// LOCKSMITH ACQUISITION E-7B2B1 — the return path, offline.
//
// A call that cannot yet be placed still needs a way home. This proves the
// path: verified event -> exact dispatch -> bound call id -> classified
// outcome -> durable outcome -> and only then the lock.
//
// Everything here is fixtures. No route is mounted, no signature is checked
// against a service, no network exists, and dev is never touched.
//
// The proofs that matter most are the ones about NOT writing: an unverified
// event, an unmatched event, a connected call whose analysis has not arrived,
// and an ambiguous opt-out all leave the ledger exactly as they found it.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createDialAuthoriser } = require("../src/services/acquisition-authorisation");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect } = require("../src/services/acquisition-prospect");
const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
const { FOUNDER_CALLING_POLICY } = require("../src/services/acquisition-calling-approval");
const { createDurableOutcomes, createDurableSuppression } = require("../src/services/acquisition-durable");
const { executeAuthorisedDial } = require("../src/services/acquisition-dial-execution");
const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");

const { handleAcquisitionCallEvent, classifyTechnicalOutcome, EVENT_CODES } = require("../src/services/acquisition-call-events");
const {
  validateAcquisitionAnalysis,
  classifyAnalysedOutcome,
  ACQUISITION_AGENT_CONTRACT,
  EXPLICIT_OPT_OUT_RULE,
  ANALYSIS_CODES,
} = require("../src/services/acquisition-agent-contract");

const ISO = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";
const now = (iso = ISO) => () => new Date(iso);
const ROUTING = Object.freeze({ agentId: "agent_acqfixture0001", fromNumber: "+61355500001" });

function mkProspect() {
  let p = createProspect({
    businessName: "Northside Lock & Key", tradeCategory: "Locksmith", suburb: "Brunswick", state: "VIC",
    postcode: "3056", region: "Melbourne", timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }], sourceRefs: [{ url: "https://x.example.com.au/c" }],
    origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const t of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, t, { actor: "Peter", reason: "e7b2b1", now: now() }).prospect;
  }
  return p;
}

function evidenceFor(p) {
  const led = createEvidenceLedger({ now: now() });
  for (const [k, v] of [["business_name", p.businessName], ["trade_category", "Locksmith"], ["phone", p.phones[0].raw]]) {
    led.record({ prospectId: p.prospectId, kind: k, captureMode: "fixture", value: v, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "t", source: { url: "https://x.example.com.au/c" } });
  }
  return led.forProspect(p.prospectId);
}

async function authorise(store, prospect, e164 = NUMBER) {
  const rows = evidenceFor(prospect);
  const ws = createWashStore({ now: now(), mode: "fixture" });
  ws.wash(e164);
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: `batch ${prospect.prospectId}` });
  const appr = await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e7b2b1" });
  assert.strictEqual(appr.ok, true, appr.message);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

/**
 * A store with calling enabled and one authorised + CLAIMED dispatch.
 *
 * ── WHY THE PROSPECT IS STAGED TO `attempted` HERE ──────────────────
 * acquisition-outcome refuses to record against a prospect that is not
 * `queued`, `attempted`, `connected` or `callback_requested` — "no call could
 * have been made to it, so there is no outcome to record". That refusal is
 * correct and this milestone does not weaken it.
 *
 * But NOTHING IN THE PIPELINE CURRENTLY MOVES A PROSPECT THERE: batch selection
 * does not set `queued` and the dispatch path does not set `attempted`. That is
 * a real gap, it is recorded in the register, and it belongs to the dispatch
 * side rather than to the return path — a webhook asserting "a call was
 * attempted" would be the wrong module making that claim.
 *
 * So the fixture does here what the dispatch path will have to do, and the
 * un-staged case is proven separately to fail SAFELY: nothing written, lock
 * held.
 */
async function claimedDispatch({ lostResponse = false, stage = "attempted" } = {}) {
  const store = createInMemoryAcquisitionStore();
  await store.writeCallingState({ state: "enabled", revision: 1, changedBy: "harness", changedAt: ISO, reason: "test" });
  const prospect = mkProspect();
  const d = await authorise(store, prospect);

  const transport = lostResponse
    ? async () => { throw new Error("socket hang up before the response was read"); }
    : async () => ({ ok: true, resource: { id: "call_live_0001" }, providerRequestId: "req_1" });

  const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport });
  const exec = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });

  // Stage the prospect the way a complete dispatch path will have to.
  //
  // Through transitionProspectLifecycle, not upsertProspect: an upsert
  // deliberately never overwrites lifecycle, so that re-running an import
  // cannot drag a reviewed business backwards. The durable move is the E-2
  // compare-and-set.
  let staged = prospect;
  if (stage) {
    for (const to of ["queued", "attempted"]) {
      const moved = await store.transitionProspectLifecycle({
        prospectId: prospect.prospectId, to, actor: "harness", reason: "e7b2b1 staging", at: ISO,
      });
      assert.strictEqual(moved.ok, true, `staging to ${to}: ${moved.message}`);
      staged = moved.prospect;
      if (to === stage) break;
    }
  }

  // The DURABLE recorder. createOutcomeRecorder alone drives the state machine
  // and the suppression side-effect but persists nothing; createDurableOutcomes
  // wraps it and writes the row. The return path needs the durable one, because
  // "the outcome is recorded" has to mean it survives the process.
  const recorder = createDurableOutcomes({
    now: now(),
    suppression: await createDurableSuppression({ now: now(), store }),
    store,
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
  });

  return { store, prospect: staged, dial: d.dial, dispatchId: d.dial.dispatchId, recorder, exec };
}

const eventFor = (dispatchId, { eventType = "call_ended", callId = "call_live_0001", reason = null, analysis = null, prospectId = null } = {}) => ({
  verified: true,
  eventType,
  providerCallId: callId,
  call: {
    call_id: callId,
    disconnection_reason: reason,
    call_analysis: analysis,
    metadata: {
      aida_purpose: "locksmith_acquisition",
      aida_dispatch_id: dispatchId,
      aida_execution_id: "ex_whatever",
      ...(prospectId ? { aida_prospect_id: prospectId } : {}),
    },
  },
});

const goodAnalysis = (over = {}) => ({
  reached_human: true,
  outcome: "not_interested",
  explicit_opt_out: false,
  callback_requested: false,
  requested_callback_at: null,
  confidence: "high",
  reason: "They said they already have a provider.",
  evidence_ref: "turn:14",
  ...over,
});

// ---------------------------------------------------------------------------
// 1-4. AUTHENTICATION AND CORRELATION — the refusals
// ---------------------------------------------------------------------------

describe("E-7B2B1 refuses anything it cannot authenticate or match", () => {
  it("1. an unverified event mutates nothing", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const before = await store.listDialExecutions({});
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId), verified: false, store, recorder, now: now() });
    assert.strictEqual(r.code, EVENT_CODES.NOT_VERIFIED);
    assert.strictEqual(r.mutated, false);
    assert.deepStrictEqual(await store.listDialExecutions({}), before);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("2. an event with no aida_dispatch_id mutates nothing and guesses nothing", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const ev = eventFor(dispatchId);
    delete ev.call.metadata.aida_dispatch_id;
    const r = await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    assert.strictEqual(r.code, EVENT_CODES.NO_DISPATCH_ID);
    assert.strictEqual(r.mutated, false);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].providerRef, "call_live_0001");
  });

  it("3. an unknown dispatchId binds nothing to anybody", async () => {
    const { store, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor("00000000-0000-4000-8000-000000000000"), store, recorder, now: now() });
    assert.strictEqual(r.code, EVENT_CODES.UNKNOWN_DISPATCH);
    assert.strictEqual(r.mutated, false);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("4. the dispatch is found by DIRECT lookup on the durable key", async () => {
    const { store, dispatchId } = await claimedDispatch();
    const direct = await store.listDialExecutions({ dispatchId });
    assert.strictEqual(direct.length, 1);
    assert.strictEqual(direct[0].dispatchId, dispatchId);
    // And a wrong key returns nothing rather than "the only row there is".
    assert.strictEqual((await store.listDialExecutions({ dispatchId: "nope" })).length, 0);
  });

  it("a prospect that disagrees with the dispatch is refused", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { prospectId: "pr_somebody_else" }), store, recorder, now: now() });
    assert.strictEqual(r.code, EVENT_CODES.CORRELATION_MISMATCH);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5-8. CALL-ID BINDING AND THE LOST RESPONSE
// ---------------------------------------------------------------------------

describe("E-7B2B1 binds one call id to one dispatch", () => {
  it("5. the call id binds to the correct dispatch", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch({ lostResponse: true });
    assert.strictEqual((await store.listDialExecutions({}))[0].providerRef, null);
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_started", callId: "call_R" }), store, recorder, now: now() });
    assert.strictEqual(r.code, EVENT_CODES.BOUND);
    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.providerRef, "call_R");
    assert.strictEqual(row.dispatchId, dispatchId);
  });

  it("6. the same event twice is idempotent", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch({ lostResponse: true });
    const ev = eventFor(dispatchId, { eventType: "call_started", callId: "call_R" });
    await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    const after1 = await store.listDialExecutions({});
    const r2 = await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.mutated, false, "the second delivery writes nothing");
    assert.deepStrictEqual(await store.listDialExecutions({}), after1);
  });

  it("7. a conflicting call id is REFUSED, and the first is not overwritten", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch({ lostResponse: true });
    await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_started", callId: "call_R1" }), store, recorder, now: now() });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_ended", callId: "call_R2", reason: "dial_no_answer" }), store, recorder, now: now() });

    assert.strictEqual(r.code, EVENT_CODES.CALL_ID_CONFLICT);
    assert.strictEqual(r.mutated, false);
    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.providerRef, "call_R1", "the original binding stands");
    assert.strictEqual(row.resolvedAt, null, "and no outcome was recorded on a conflicted event");
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("8. THE LOST RESPONSE: a later webhook reconciles the dispatch", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch({ lostResponse: true });

    // Step 5 of the scenario: unknown, unbound, unresolved.
    const [before] = await store.listDialExecutions({});
    assert.strictEqual(before.providerStatus, "unknown");
    assert.strictEqual(before.providerRef, null);
    assert.strictEqual(before.resolvedAt, null);

    // Steps 6-7: an authenticated webhook names D and supplies R.
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_started", callId: "call_R" }), store, recorder, now: now() });
    assert.strictEqual(r.ok, true);

    const [after] = await store.listDialExecutions({});
    assert.strictEqual(after.providerRef, "call_R", "D <-> R is now durable");
    assert.strictEqual(after.providerStatus, "unknown", "the status stays truthful about what we knew when we submitted");
    // Step 8: still unresolved, because no BUSINESS outcome exists yet.
    assert.strictEqual(after.resolvedAt, null);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 9-15. EVENT PHASES AND TECHNICAL MAPPING
// ---------------------------------------------------------------------------

describe("E-7B2B1 keeps technical state and business outcome apart", () => {
  it("9-10. call_started creates no outcome and resolves nothing", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_started" }), store, recorder, now: now() });
    assert.strictEqual(r.outcomeRecorded, false);
    assert.strictEqual(r.dispatchResolved, false);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null);
  });

  it("11. no answer maps to no_answer", async () => {
    assert.strictEqual(classifyTechnicalOutcome("dial_no_answer"), "no_answer");
    const { store, dispatchId, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store, recorder, now: now() });
    assert.strictEqual(r.classifiedOutcome, "no_answer", r.message);
    assert.strictEqual(r.outcomeRecorded, true, r.message);
    assert.strictEqual(r.dispatchResolved, true, r.message);
  });

  it("12. a no_answer still consumes no counted attempt (A-L7)", async () => {
    const { OUTCOME_RULES } = require("../src/services/acquisition-attempt-policy");
    assert.strictEqual(OUTCOME_RULES.no_answer.effect, "does_not_consume_attempt", "the founder answer must be unchanged by this milestone");
    assert.strictEqual(OUTCOME_RULES.voicemail.effect, "counts_as_attempt");
  });

  it("a prospect nothing ever staged as called is refused SAFELY", async () => {
    // The pipeline gap, pinned rather than papered over: no batch selection sets
    // `queued` and no dispatch sets `attempted`, so a review_approved prospect
    // cannot carry an outcome. The refusal writes nothing and holds the lock.
    const { store, dispatchId, recorder } = await claimedDispatch({ stage: null });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store, recorder, now: now() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomeRecorded, false);
    assert.match(r.message, /no call could have been made|not_contactable/i);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "the lock is held for a human");
  });

  it("13-14. voicemail maps to voicemail, and DOES consume an attempt", async () => {
    assert.strictEqual(classifyTechnicalOutcome("voicemail_reached"), "voicemail");
    assert.strictEqual(classifyTechnicalOutcome("machine_detected"), "voicemail");
    const { store, dispatchId, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "voicemail_reached" }), store, recorder, now: now() });
    assert.strictEqual(r.classifiedOutcome, "voicemail");
    const [o] = await store.listOutcomes({});
    assert.strictEqual(o.outcome, "voicemail");
  });

  it("busy reaches nobody, so it maps to no_answer", () => {
    assert.strictEqual(classifyTechnicalOutcome("dial_busy"), "no_answer");
  });

  it("15. a connected user_hangup alone becomes NOTHING", async () => {
    // The single most important refusal in the file: "they hung up" is not
    // "they were not interested", and call_ended routinely precedes analysis.
    const { store, dispatchId, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "user_hangup" }), store, recorder, now: now() });
    assert.strictEqual(r.code, EVENT_CODES.AWAITING_ANALYSIS);
    assert.strictEqual(r.outcomeRecorded, false);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "the locks are still held");
  });

  it("agent_hangup, inactivity and an unexplained error also wait", async () => {
    for (const reason of ["agent_hangup", "inactivity", "max_duration_reached", "error", "dial_failed", null]) {
      assert.strictEqual(classifyTechnicalOutcome(reason), null, `${reason} must not settle a business outcome`);
    }
  });

  it("a later analysis can still classify a call whose call_ended arrived first", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "user_hangup" }), store, recorder, now: now() });
    assert.strictEqual((await store.listOutcomes({})).length, 0, "nothing was written too early");

    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_analyzed", analysis: goodAnalysis() }), store, recorder, now: now() });
    assert.strictEqual(r.classifiedOutcome, "not_interested");
    assert.strictEqual((await store.listOutcomes({})).length, 1, "exactly one durable outcome, written by the authoritative event");
  });
});

// ---------------------------------------------------------------------------
// 16-21. BUSINESS OUTCOMES
// ---------------------------------------------------------------------------

describe("E-7B2B1 maps conversation to durable outcomes, conservatively", () => {
  const run = async (analysis) => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_analyzed", analysis }), store, recorder, now: now() });
    return { r, store };
  };

  it("16. not_interested stays not_interested", async () => {
    const { r, store } = await run(goodAnalysis({ outcome: "not_interested" }));
    assert.strictEqual(r.classifiedOutcome, "not_interested");
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "not_interested");
  });

  it("17. declined stays declined — it is NOT collapsed into not_interested", async () => {
    const { r, store } = await run(goodAnalysis({ outcome: "declined", reason: "They declined." }));
    assert.strictEqual(r.classifiedOutcome, "declined");
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "declined");
  });

  it("18. an evidenced explicit opt-out becomes opt_out AND suppresses", async () => {
    const { r, store } = await run(goodAnalysis({ outcome: "declined", explicit_opt_out: true, confidence: "high", evidence_ref: "turn:9", reason: "Asked never to be called again." }));
    assert.strictEqual(r.classifiedOutcome, "opt_out", r.message);
    assert.strictEqual(r.outcomeRecorded, true, r.message);
    const [o] = await store.listOutcomes({});
    assert.strictEqual(o.outcome, "opt_out");
    const supps = await store.listSuppressions({});
    assert.strictEqual(supps.length, 1, "the outcome recorder — not this handler — wrote the suppression");
    assert.strictEqual(supps[0].reason, "opt_out");
  });

  it("19. callback_requested stays a callback, not a suppression", async () => {
    const { r, store } = await run(goodAnalysis({ outcome: "callback_requested", callback_requested: true, requested_callback_at: "2026-08-07T01:00:00Z", reason: "Asked for Thursday." }));
    assert.strictEqual(r.classifiedOutcome, "callback");
    assert.strictEqual(r.callbackAt, "2026-08-07T01:00:00Z");
    assert.strictEqual((await store.listSuppressions({})).length, 0, "a callback is not a suppression");
  });

  it("interested becomes qualified, never booked", async () => {
    const { r } = await run(goodAnalysis({ outcome: "interested", reason: "Wants to hear more." }));
    assert.strictEqual(r.classifiedOutcome, "qualified", "nothing here can confirm a booking was made");
  });

  it("20. an AMBIGUOUS analysis invents no opt-out and writes nothing", async () => {
    // A low-confidence opt-out with no evidence. The dangerous case.
    const { r, store } = await run(goodAnalysis({ explicit_opt_out: true, confidence: "low", evidence_ref: null }));
    assert.strictEqual(r.code, EVENT_CODES.NEEDS_HUMAN);
    assert.strictEqual(r.analysisCode, ANALYSIS_CODES.UNSUPPORTED_OPT_OUT);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listSuppressions({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "a human decides, and the locks are held until they do");
  });

  it("no_meaningful_conversation writes nothing", async () => {
    const { r, store } = await run(goodAnalysis({ outcome: "no_meaningful_conversation", reached_human: false, reason: "Nothing usable." }));
    assert.strictEqual(r.code, EVENT_CODES.NEEDS_HUMAN);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("21. a duplicate analysis webhook does not duplicate the outcome", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const ev = eventFor(dispatchId, { eventType: "call_analyzed", analysis: goodAnalysis() });
    const first = await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    assert.strictEqual(first.outcomeRecorded, true);

    const second = await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    assert.strictEqual(second.code, EVENT_CODES.ALREADY_RESOLVED);
    assert.strictEqual(second.mutated, false);
    assert.strictEqual((await store.listOutcomes({})).length, 1, "one outcome");
    assert.strictEqual((await store.listSuppressions({})).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 22-24. ORDERING — outcome first, lock second, never the other way
// ---------------------------------------------------------------------------

describe("E-7B2B1 writes the business fact before it releases the lock", () => {
  it("22. the outcome exists before the dispatch is resolved", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const seen = [];
    const spyStore = Object.freeze({
      ...store,
      appendOutcome: async (row) => { seen.push("outcome"); return store.appendOutcome(row); },
      updateDialExecution: async (id, patch) => {
        if ("resolvedAt" in patch) seen.push("resolve");
        return store.updateDialExecution(id, patch);
      },
    });
    const spyRecorder = createDurableOutcomes({
      now: now(), suppression: await createDurableSuppression({ now: now(), store: spyStore }), store: spyStore,
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
    });
    void recorder;
    await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store: spyStore, recorder: spyRecorder, now: now() });
    assert.deepStrictEqual(seen, ["outcome", "resolve"], "the business fact is durable first");
  });

  it("23. an outcome that cannot be written leaves the lock HELD", async () => {
    const { store, dispatchId } = await claimedDispatch();
    const brokenRecorder = { record: async () => { throw new Error("outcome store is down"); } };
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store, recorder: brokenRecorder, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomeRecorded, false);
    assert.strictEqual(r.dispatchResolved, false);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "the business is still held");
  });

  it("24. a resolution that fails leaves the OUTCOME recorded and the lock held", async () => {
    const { store, dispatchId, recorder } = await claimedDispatch();
    const brokenStore = Object.freeze({
      ...store,
      updateDialExecution: async (id, patch) => {
        if ("resolvedAt" in patch) throw new Error("the ledger refused the release");
        return store.updateDialExecution(id, patch);
      },
    });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store: brokenStore, recorder, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomeRecorded, true, "the business is accounted for");
    assert.strictEqual(r.dispatchResolved, false);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "and the lock is stuck, which is the safe half");
  });

  it("a dispatch is NEVER resolved while its outcome is absent", async () => {
    const { store, dispatchId } = await claimedDispatch();
    const brokenRecorder = { record: async () => ({ ok: false, message: "refused" }) };
    await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store, recorder: brokenRecorder, now: now() });
    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.resolvedAt, null);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 25-29. THE SAFETY RATCHETS
// ---------------------------------------------------------------------------

describe("E-7B2B1 cannot call, redial, schedule or reach anything", () => {
  const FILES = ["acquisition-call-events.js", "acquisition-agent-contract.js"];
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
  const codeOf = (src) => src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");

  it("25-26. no retry, no timer, no automatic callback dialling", () => {
    for (const f of FILES) {
      const code = codeOf(read(f));
      for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bschedule\w*\s*\(/, /\bredial\b/, /\bdial\s*\(/]) {
        assert.ok(!p.test(code), `${f} must contain no ${p}`);
      }
    }
  });

  it("27. it cannot invoke a provider or place a call", () => {
    for (const f of FILES) {
      const code = codeOf(read(f));
      for (const p of [/executeAuthorisedDial/, /\.submit\s*\(/, /createRetellAcquisitionProvider/, /claimAuthorisedDial/]) {
        assert.ok(!p.test(code), `${f} must not be able to dispatch a call: ${p}`);
      }
    }
  });

  it("29. it reaches no network and reads no environment", () => {
    for (const f of FILES) {
      const src = read(f);
      const code = codeOf(src);
      assert.ok(!/process\.env/.test(src), `${f} must not read the environment`);
      for (const p of [/\bfetch\s*\(/, /require\(["'](axios|got|node-fetch|undici|twilio|retell-sdk)/, /require\(["']node:(http|https|net|tls)["']\)/, /https?:\/\//]) {
        assert.ok(!p.test(code), `${f} must not contain ${p}`);
      }
      for (const r of [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])) {
        assert.ok(r.startsWith("./"), `${f} may not import ${r}`);
      }
    }
  });

  it("it never writes a suppression itself — that belongs to the outcome recorder", () => {
    const code = codeOf(read("acquisition-call-events.js"));
    for (const p of [/appendSuppression/, /\bsuppress\s*\(/, /createSuppressionList/]) {
      assert.ok(!p.test(code), `the event handler must not apply suppression directly: ${p}`);
    }
  });

  it("it never sets resolved_at itself — only the resolution service may", () => {
    const code = codeOf(read("acquisition-call-events.js"));
    assert.ok(!/resolvedAt\s*:/.test(code), "the handler must not write a resolution patch of its own");
    assert.ok(/recordOutcomeAndResolveDispatch/.test(code), "it must go through the service that owns the ordering");
  });

  it("28. no exposed route reaches the acquisition event handler", () => {
    const dir = path.join(__dirname, "..", "src", "routes");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!/acquisition-call-events/.test(body), `${f} exposes the acquisition event handler to the network`);
    }
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.ok(!/acquisition-call-events/.test(server), "server.js must not mount the acquisition event handler");
  });

  it("28b. calling remains paused and no provider is live", async () => {
    const { createDisabledDialProvider, createFakeDialProvider } = require("../src/services/acquisition-dial-provider");
    assert.strictEqual(createDisabledDialProvider().live, false);
    assert.strictEqual(createFakeDialProvider().live, false);
    assert.strictEqual(createRetellAcquisitionProvider({ routing: ROUTING }).live, false);
  });
});

// ---------------------------------------------------------------------------
// THE AGENT CONTRACT AND ITS ANALYSIS SCHEMA
// ---------------------------------------------------------------------------

describe("E-7B2B1 acquisition agent contract", () => {
  it("is a cold-acquisition contract, distinct from the other two agents", () => {
    assert.strictEqual(ACQUISITION_AGENT_CONTRACT.purpose, "cold_acquisition");
    assert.match(ACQUISITION_AGENT_CONTRACT.appliesTo, /have not asked to be contacted/);
    const all = JSON.stringify(ACQUISITION_AGENT_CONTRACT).toLowerCase();
    assert.ok(all.includes("identify"), "it must require self-identification");
    assert.ok(all.includes("opt"), "it must address opt-outs");
  });

  it("does NOT invent AI disclosure wording", () => {
    assert.strictEqual(ACQUISITION_AGENT_CONTRACT.aiDisclosure.decided, false);
    assert.strictEqual(ACQUISITION_AGENT_CONTRACT.aiDisclosure.wording, null);
  });

  it("creates no agent and reaches nothing", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-contract.js"), "utf8");
    for (const p of [/createAgent/, /\bfetch\s*\(/, /agent_id\s*:/, /process\.env/]) {
      assert.ok(!p.test(src), `the contract must not contain ${p}`);
    }
  });

  it("the opt-out rule is conservative and keeps a decline distinct", () => {
    assert.ok(EXPLICIT_OPT_OUT_RULE.counts.includes("stop calling"));
    for (const soft of ["busy", "not now", "maybe later", "not interested"]) {
      assert.ok(EXPLICIT_OPT_OUT_RULE.doesNotCount.includes(soft), `${soft} must not count as an opt-out`);
    }
  });

  it("rejects malformed, unknown and incoherent analyses", () => {
    assert.strictEqual(validateAcquisitionAnalysis(null).code, ANALYSIS_CODES.MALFORMED);
    assert.strictEqual(validateAcquisitionAnalysis({}).code, ANALYSIS_CODES.MALFORMED);
    assert.strictEqual(validateAcquisitionAnalysis(goodAnalysis({ outcome: "vibes" })).code, ANALYSIS_CODES.UNKNOWN_OUTCOME);
    assert.strictEqual(validateAcquisitionAnalysis(goodAnalysis({ reached_human: false })).code, ANALYSIS_CODES.INCOHERENT);
    assert.strictEqual(
      validateAcquisitionAnalysis(goodAnalysis({ reached_human: false, outcome: "no_meaningful_conversation", explicit_opt_out: true })).code,
      ANALYSIS_CODES.INCOHERENT
    );
  });

  it("holds an opt-out to a higher standard than anything else", () => {
    for (const weak of [{ confidence: "medium" }, { confidence: "low" }, { evidence_ref: null }, { evidence_ref: "  " }]) {
      const v = validateAcquisitionAnalysis(goodAnalysis({ explicit_opt_out: true, ...weak }));
      assert.strictEqual(v.code, ANALYSIS_CODES.UNSUPPORTED_OPT_OUT, JSON.stringify(weak));
    }
    assert.strictEqual(validateAcquisitionAnalysis(goodAnalysis({ explicit_opt_out: true })).ok, true);
  });

  it("an unsupported opt-out is NOT quietly downgraded to a decline", () => {
    const v = validateAcquisitionAnalysis(goodAnalysis({ outcome: "declined", explicit_opt_out: true, confidence: "low" }));
    assert.strictEqual(v.ok, false, "the whole analysis is held back for a human");
    assert.ok(!v.analysis, "no partial classification leaks through");
  });

  it("classification never invents an outcome it does not have", () => {
    assert.strictEqual(classifyAnalysedOutcome(null).outcome, null);
    assert.strictEqual(classifyAnalysedOutcome({ outcome: "no_meaningful_conversation" }).outcome, null);
    assert.strictEqual(classifyAnalysedOutcome({ outcome: "declined", explicitOptOut: true }).outcome, "opt_out", "the strongest statement wins");
  });
});
