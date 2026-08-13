// LOCKSMITH ACQUISITION E-8 — lifecycle state must represent facts.
//
// The outcome guard was never the defect. Nothing wrote `queued` and nothing
// wrote `attempted`, so a real Retell outcome would have been correctly refused
// and no business could ever be recorded as called.
//
// E-8 fixes the source. The guard is untouched, and every mapping below is
// argued from what actually happened rather than from what would be convenient:
//
//   a claim              is a reservation           -> queued, NEVER attempted
//   a pause after a claim is still a reservation    -> stays queued
//   a definite acceptance is a placed call          -> attempted
//   an ambiguous result   proves nothing            -> no advance at all
//   a real call id        proves a call existed     -> attempted, later
//   a person answering    is the only thing that is -> connected

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createDialAuthoriser } = require("../src/services/acquisition-authorisation");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy, OUTCOME_RULES } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect } = require("../src/services/acquisition-prospect");
const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
const { FOUNDER_CALLING_POLICY } = require("../src/services/acquisition-calling-approval");
const { createDurableOutcomes, createDurableSuppression } = require("../src/services/acquisition-durable");
const { executeAuthorisedDial, EXECUTION_CODES } = require("../src/services/acquisition-dial-execution");
const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");
const { createDisabledDialProvider, createFakeDialProvider } = require("../src/services/acquisition-dial-provider");
const { handleAcquisitionCallEvent, EVENT_CODES } = require("../src/services/acquisition-call-events");
const {
  establishContactFact,
  CONTACT_FACTS,
  CONTACT_LADDER,
  LIFECYCLE_FACT_CODES,
} = require("../src/services/acquisition-contact-lifecycle");

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
    p = transitionProspect(p, t, { actor: "Peter", reason: "e8", now: now() }).prospect;
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
  const appr = await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e8" });
  assert.strictEqual(appr.ok, true, appr.message);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

async function freshStore(state = "enabled") {
  const store = createInMemoryAcquisitionStore();
  await store.writeCallingState({ state, revision: 1, changedBy: "e8 harness", changedAt: ISO, reason: "test" });
  return store;
}

const lifecycleOf = async (store, prospectId) => (await store.loadProspect(prospectId)).lifecycle;

async function recorderFor(store) {
  return createDurableOutcomes({
    now: now(),
    suppression: await createDurableSuppression({ now: now(), store }),
    store,
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
  });
}

const eventFor = (dispatchId, { eventType = "call_ended", callId = "call_R", reason = null, analysis = null } = {}) => ({
  verified: true,
  eventType,
  providerCallId: callId,
  call: {
    call_id: callId,
    disconnection_reason: reason,
    call_analysis: analysis,
    metadata: { aida_purpose: "locksmith_acquisition", aida_dispatch_id: dispatchId },
  },
});

const analysis = (over = {}) => ({
  reached_human: true, outcome: "not_interested", explicit_opt_out: false, callback_requested: false,
  requested_callback_at: null, confidence: "high", reason: "They already have a provider.", evidence_ref: "turn:12", ...over,
});

// ---------------------------------------------------------------------------
// 1-3. WHAT A RESERVATION IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------

describe("E-8: a reservation is not a call", () => {
  it("1. founder batch approval alone advances nothing", async () => {
    const store = await freshStore();
    const p = mkProspect();
    await authorise(store, p); // records the durable batch approval
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "review_approved", "an approval is permission to consider, not to dial");
  });

  it("2. a durable dispatch claim is `queued`, and NEVER `attempted`", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);

    // The disabled provider refuses, so the claim happens and nothing is placed.
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createDisabledDialProvider(), now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.PROVIDER_REFUSED);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "queued", "a claim reserves; it does not dial");
  });

  it("3. claimed, THEN the durable stop pauses — `queued`, never `attempted`", async () => {
    // The exact E-7B1 scenario: enabled at the preflight, paused by the time
    // the executor takes its second reading. The claim happened; the call did
    // not. Simulated by a store that changes its answer between the two reads,
    // because that is the only way the race is real.
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);

    let reads = 0;
    const pausingStore = Object.freeze({
      ...store,
      readCallingState: async () => {
        reads += 1;
        return reads === 1
          ? { scope: "global", state: "enabled", revision: 1, changedBy: "h", changedAt: ISO, reason: "t" }
          : { scope: "global", state: "paused", revision: 2, changedBy: "Peter Dang", changedAt: ISO, reason: "stop" };
      },
    });

    const provider = createFakeDialProvider();
    const r = await executeAuthorisedDial({ store: pausingStore, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(r.ok, false, "the second reading stops it");
    assert.strictEqual(r.dispatchClaimed, true, "but the claim already happened");
    assert.strictEqual(provider.submissionCount(), 0, "nothing was submitted");
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "queued", "a call that never happened is not an attempt");
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "and the dispatch still holds both locks");
  });

  it("paused BEFORE the preflight advances nothing at all — there is no claim", async () => {
    const store = await freshStore("paused");
    const p = mkProspect();
    const d = await authorise(store, p);
    const provider = createFakeDialProvider();
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(provider.submissionCount(), 0);
    assert.strictEqual((await store.listDialExecutions({})).length, 0, "nothing was even reserved");
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "review_approved", "so the business is exactly where it was");
  });
});

// ---------------------------------------------------------------------------
// 4-6. WHAT ESTABLISHES AN ATTEMPT
// ---------------------------------------------------------------------------

describe("E-8: an attempt is a call that was actually accepted for placement", () => {
  it("4. a definite provider acceptance establishes `attempted`", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    const provider = createRetellAcquisitionProvider({
      routing: ROUTING,
      transport: async () => ({ ok: true, resource: { id: "call_accepted_1" }, providerRequestId: "req" }),
    });
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.SUBMITTED, r.message);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "attempted");
  });

  it("an acceptance does NOT establish that anybody answered", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => ({ ok: true, resource: { id: "call_x" } }) });
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.notStrictEqual(await lifecycleOf(store, p.prospectId), "connected");
  });

  it("a provider REFUSAL leaves the business `queued` — nothing was placed", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    const provider = createRetellAcquisitionProvider({
      routing: ROUTING, transport: async () => ({ ok: false, error: { code: "invalid_request" } }),
    });
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.PROVIDER_REFUSED);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "queued");
  });

  it("5. an AMBIGUOUS submission does not falsely mark `attempted`", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    const provider = createRetellAcquisitionProvider({
      routing: ROUTING, transport: async () => { throw new Error("socket hang up"); },
    });
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(r.status, EXECUTION_CODES.PROVIDER_FAILED);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "queued", "we do not know whether a telephone rang, so we do not say we called");
    assert.strictEqual((await store.listDialExecutions({}))[0].providerStatus, "unknown");
  });

  it("6. THE LOST RESPONSE: a later authenticated webhook establishes the attempt", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => { throw new Error("socket hang up"); } });
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(await lifecycleOf(store, p.prospectId), "queued", "unknown, so not claimed as an attempt");

    const recorder = await recorderFor(store);
    const r = await handleAcquisitionCallEvent({
      ...eventFor(d.dial.dispatchId, { eventType: "call_started", callId: "call_real" }), store, recorder, now: now(),
    });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "attempted", "the call demonstrably existed, so the attempt is now a fact");
    assert.strictEqual((await store.listDialExecutions({}))[0].providerRef, "call_real");
    assert.strictEqual((await store.listOutcomes({})).length, 0, "and still no business outcome");
  });

  it("7. call_started proves an attempt and NOT a conversation", async () => {
    // In this repository call_started maps to "started"; only transfer_bridged
    // maps to "connected". The event name is not the evidence.
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createDisabledDialProvider(), now: now() });
    const recorder = await recorderFor(store);
    await handleAcquisitionCallEvent({ ...eventFor(d.dial.dispatchId, { eventType: "call_started" }), store, recorder, now: now() });
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "attempted");
  });
});

// ---------------------------------------------------------------------------
// 8-15. OUTCOMES NOW PERSIST, AND STAY DISTINCT
// ---------------------------------------------------------------------------

describe("E-8: outcomes can now be recorded, and remain distinct", () => {
  async function dispatched({ lost = false } = {}) {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    const transport = lost
      ? async () => { throw new Error("socket hang up"); }
      : async () => ({ ok: true, resource: { id: "call_R" } });
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport }), now: now() });
    return { store, prospect: p, dispatchId: d.dial.dispatchId, recorder: await recorderFor(store) };
  }

  it("8. no_answer passes the lifecycle prerequisite and persists", async () => {
    const { store, prospect, dispatchId, recorder } = await dispatched();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_no_answer" }), store, recorder, now: now() });
    assert.strictEqual(r.outcomeRecorded, true, r.message);
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "no_answer");
    void prospect;
  });

  it("9. no_answer still consumes no counted attempt — lifecycle != attempt policy", async () => {
    assert.strictEqual(OUTCOME_RULES.no_answer.effect, "does_not_consume_attempt");
    assert.strictEqual(OUTCOME_RULES.voicemail.effect, "counts_as_attempt");
  });

  it("10. voicemail persists", async () => {
    const { store, dispatchId, recorder } = await dispatched();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "voicemail_reached" }), store, recorder, now: now() });
    assert.strictEqual(r.outcomeRecorded, true, r.message);
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "voicemail");
  });

  it("11. busy maps safely to no_answer", async () => {
    const { store, dispatchId, recorder } = await dispatched();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { reason: "dial_busy" }), store, recorder, now: now() });
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "no_answer", r.message);
  });

  it("12. a connected analysed outcome persists, and establishes `connected` first", async () => {
    const { store, prospect, dispatchId, recorder } = await dispatched();
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_analyzed", analysis: analysis() }), store, recorder, now: now() });
    assert.strictEqual(r.outcomeRecorded, true, r.message);
    // The outcome moved it on from `connected` to its own terminal state.
    const o = (await store.listOutcomes({}))[0];
    assert.strictEqual(o.outcome, "not_interested");
    assert.strictEqual(o.lifecycleFrom, "connected", "the conversation was a fact before its conclusion was recorded");
    void prospect;
  });

  it("13-15. not_interested, declined, opt_out and callback stay distinct", async () => {
    const cases = [
      [analysis({ outcome: "not_interested" }), "not_interested"],
      [analysis({ outcome: "declined", reason: "They declined." }), "declined"],
      [analysis({ outcome: "declined", explicit_opt_out: true, reason: "Asked never to be called." }), "opt_out"],
      [analysis({ outcome: "callback_requested", callback_requested: true, reason: "Ring Thursday." }), "callback"],
    ];
    for (const [a, expected] of cases) {
      const { store, dispatchId, recorder } = await dispatched();
      const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, { eventType: "call_analyzed", analysis: a }), store, recorder, now: now() });
      assert.strictEqual(r.classifiedOutcome, expected, `${expected}: ${r.message}`);
      assert.strictEqual((await store.listOutcomes({}))[0].outcome, expected);
    }
  });

  it("an analysis that reached nobody does NOT establish `connected`", async () => {
    const { store, prospect, dispatchId, recorder } = await dispatched();
    await handleAcquisitionCallEvent({
      ...eventFor(dispatchId, { eventType: "call_analyzed", analysis: analysis({ reached_human: false, outcome: "no_meaningful_conversation" }) }),
      store, recorder, now: now(),
    });
    assert.strictEqual(await lifecycleOf(store, prospect.prospectId), "attempted", "nobody answered, so nobody was spoken to");
  });
});

// ---------------------------------------------------------------------------
// 16-19. IDEMPOTENCY AND FAILURE ORDERING
// ---------------------------------------------------------------------------

describe("E-8: repeated events do not corrupt the lifecycle", () => {
  it("16. a duplicate event duplicates neither lifecycle nor outcome", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => ({ ok: true, resource: { id: "call_R" } }) }), now: now() });
    const recorder = await recorderFor(store);
    const ev = eventFor(d.dial.dispatchId, { reason: "dial_no_answer" });

    await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    const lifecycleAfterFirst = await lifecycleOf(store, p.prospectId);
    const second = await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });

    assert.strictEqual(second.code, EVENT_CODES.ALREADY_RESOLVED);
    assert.strictEqual((await store.listOutcomes({})).length, 1);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), lifecycleAfterFirst);
  });

  it("a duplicate provider acceptance does not re-advance the lifecycle", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const first = await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.ATTEMPTED, actor: "t", reason: "call placed", at: ISO });
    assert.strictEqual(first.ok, false, "there is no persisted prospect yet");

    await store.upsertProspect(p);
    const a = await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.ATTEMPTED, actor: "t", reason: "call placed", at: ISO });
    assert.strictEqual(a.changed, true);
    const b = await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.ATTEMPTED, actor: "t", reason: "call placed", at: ISO });
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.changed, false, "already true");
    assert.strictEqual(b.code, LIFECYCLE_FACT_CODES.ALREADY);
  });

  it("the ladder is never walked BACKWARDS by a late event", async () => {
    const store = await freshStore();
    const p = mkProspect();
    await store.upsertProspect(p);
    await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.CONNECTED, actor: "t", reason: "a person answered", at: ISO });
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "connected");

    // A late call_started arriving after the conversation.
    const late = await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.ATTEMPTED, actor: "t", reason: "late call_started", at: ISO });
    assert.strictEqual(late.ok, true);
    assert.strictEqual(late.changed, false);
    assert.strictEqual(late.code, LIFECYCLE_FACT_CODES.BEYOND);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "connected");
  });

  it("17. a lifecycle that cannot be established writes NO outcome", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => ({ ok: true, resource: { id: "call_R" } }) }), now: now() });

    // Suppressed between the call and the analysis. Terminal, and no event may
    // drag it back.
    await store.transitionProspectLifecycle({ prospectId: p.prospectId, to: "suppressed", actor: "h", reason: "opted out by phone earlier", at: ISO });

    const recorder = await recorderFor(store);
    const r = await handleAcquisitionCallEvent({ ...eventFor(d.dial.dispatchId, { eventType: "call_analyzed", analysis: analysis() }), store, recorder, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, EVENT_CODES.LIFECYCLE_REFUSED);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "the dispatch is unresolved");
  });

  it("18-19. outcome failure and resolution failure both leave the dispatch unresolved", async () => {
    const store = await freshStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => ({ ok: true, resource: { id: "call_R" } }) }), now: now() });

    // 18. the outcome write fails
    const broken = { record: async () => { throw new Error("outcome store down"); } };
    const a = await handleAcquisitionCallEvent({ ...eventFor(d.dial.dispatchId, { reason: "dial_no_answer" }), store, recorder: broken, now: now() });
    assert.strictEqual(a.outcomeRecorded, false);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null);

    // 19. the outcome succeeds and the release fails
    const guard = Object.freeze({
      ...store,
      updateDialExecution: async (id, patch) => {
        if ("resolvedAt" in patch) throw new Error("the ledger refused the release");
        return store.updateDialExecution(id, patch);
      },
    });
    const b = await handleAcquisitionCallEvent({ ...eventFor(d.dial.dispatchId, { reason: "dial_no_answer" }), store: guard, recorder: await recorderFor(store), now: now() });
    assert.strictEqual(b.outcomeRecorded, true, b.message);
    assert.strictEqual(b.dispatchResolved, false);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null, "outcome exists, lock held — the safe half");
  });
});

// ---------------------------------------------------------------------------
// THE BRIDGE ITSELF
// ---------------------------------------------------------------------------

describe("E-8: the bridge only establishes facts it is entitled to", () => {
  it("refuses a fact it is not allowed to establish", async () => {
    const store = await freshStore();
    const p = mkProspect();
    await store.upsertProspect(p);
    for (const bad of ["customer", "suppressed", "interested", "review_approved", "nonsense"]) {
      const r = await establishContactFact({ store, prospectId: p.prospectId, fact: bad, actor: "t", reason: "r", at: ISO });
      assert.strictEqual(r.ok, false, bad);
      assert.strictEqual(r.code, LIFECYCLE_FACT_CODES.UNKNOWN_FACT, bad);
    }
  });

  it("requires an actor and the evidence", async () => {
    const store = await freshStore();
    const p = mkProspect();
    await store.upsertProspect(p);
    assert.strictEqual((await establishContactFact({ store, prospectId: p.prospectId, fact: "queued", actor: "", reason: "r" })).ok, false);
    assert.strictEqual((await establishContactFact({ store, prospectId: p.prospectId, fact: "queued", actor: "t", reason: "  " })).ok, false);
  });

  it("walks the ladder rather than skipping it", async () => {
    const store = await freshStore();
    const p = mkProspect();
    await store.upsertProspect(p);
    const r = await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.CONNECTED, actor: "t", reason: "a person answered", at: ISO });
    assert.strictEqual(r.ok, true, r.message);
    assert.deepStrictEqual([...r.path], ["queued", "attempted", "connected"], "you cannot speak to somebody you never called");
  });

  it("callback_requested establishes the attempt first", async () => {
    const store = await freshStore();
    const p = mkProspect();
    await store.upsertProspect(p);
    const r = await establishContactFact({ store, prospectId: p.prospectId, fact: CONTACT_FACTS.CALLBACK_REQUESTED, actor: "t", reason: "asked for Thursday", at: ISO });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(await lifecycleOf(store, p.prospectId), "callback_requested");
  });

  it("agrees with the state machine it depends on", () => {
    const { PROSPECT_STATES, PROSPECT_TRANSITIONS } = require("../src/services/acquisition-schema");
    for (const s of CONTACT_LADDER) assert.ok(PROSPECT_STATES.includes(s), `${s} must be a real state`);
    assert.ok(PROSPECT_TRANSITIONS.review_approved.includes("queued"));
    assert.ok(PROSPECT_TRANSITIONS.queued.includes("attempted"));
    assert.ok(PROSPECT_TRANSITIONS.attempted.includes("connected"));
  });

  it("does not weaken the outcome guard it exists to satisfy", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-outcome.js"), "utf8");
    assert.match(src, /OUTCOME_RECORDABLE_FROM/, "the guard must still exist");
    assert.match(src, /not_contactable_state/, "and still refuse");
    const list = src.match(/OUTCOME_RECORDABLE_FROM = Object\.freeze\(\[([^\]]*)\]/);
    assert.ok(list, "the recordable list must still be declared");
    for (const s of ["queued", "attempted", "connected", "callback_requested"]) {
      assert.ok(list[1].includes(s), `${s} must still be the only way in`);
    }
  });
});

// ---------------------------------------------------------------------------
// 20-24. SAFETY
// ---------------------------------------------------------------------------

describe("E-8 changes nothing about what can call anybody", () => {
  const FILE = path.join(__dirname, "..", "src", "services", "acquisition-contact-lifecycle.js");
  const src = fs.readFileSync(FILE, "utf8");
  const code = src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");

  it("20-22. no retry, no callback dialling, no provider invocation", () => {
    for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bschedule\w*\s*\(/, /\bredial\b/, /executeAuthorisedDial/, /\.submit\s*\(/]) {
      assert.ok(!p.test(code), `the bridge must contain no ${p}`);
    }
  });

  it("24. it reaches no network and reads no environment", () => {
    assert.ok(!/process\.env/.test(src));
    for (const p of [/\bfetch\s*\(/, /require\(["'](axios|got|node-fetch|undici|twilio|retell-sdk)/, /https?:\/\//]) {
      assert.ok(!p.test(code), `must not contain ${p}`);
    }
    for (const r of [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])) {
      assert.ok(r.startsWith("./"), `may not import ${r}`);
    }
  });

  it("23. every provider is still live:false and calling is still refused by default", () => {
    assert.strictEqual(createDisabledDialProvider().live, false);
    assert.strictEqual(createFakeDialProvider().live, false);
    assert.strictEqual(createRetellAcquisitionProvider({ routing: ROUTING }).live, false);
  });

  it("the bridge writes no outcome and no suppression of its own", () => {
    for (const p of [/appendOutcome/, /appendSuppression/, /recordOutcome/, /resolvedAt/]) {
      assert.ok(!p.test(code), `the bridge must not do contact accounting: ${p}`);
    }
  });
});
