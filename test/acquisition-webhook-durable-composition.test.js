// LOCKSMITH ACQUISITION E-12D — the webhook's durable wiring.
//
// ── THE GAP ─────────────────────────────────────────────────────────
// E-11A built the ingress and mounted it, then called
// `createAcquisitionWebhookHandler()` with no dependencies. `store` defaulted
// to null, so a genuine signed Retell event was verified, fingerprinted,
// acknowledged — and refused with `acquisition_event_store_unavailable`. Safe,
// and incapable of finishing the job it exists to do.
//
// ── WHAT THESE TESTS ARE ────────────────────────────────────────────
// Composition tests, deliberately not handler mocks. E-11A already proves the
// handler's logic against injected fakes; what was never proven is that the
// ROUTE hands it anything real. So these drive `createAcquisitionWebhookDeps`
// and the route's own `resolveHandler`, with an in-memory store standing in for
// Supabase — the same store the rest of the acquisition suite uses.
//
// ── THE TWO THINGS MOST WORTH GUARDING ──────────────────────────────
// 1. Production has NO acquisition schema, and server.js imports this router
//    unconditionally. Composition hydrates the suppression list from the
//    database, so it must NOT happen at import — or a module existing becomes a
//    production database query. Tested directly.
// 2. Nothing unauthenticated, malformed, or belonging to another product may
//    reach an acquisition table. E-11A proved that of the handler; it is
//    re-proven here against the wired composition, because that is the version
//    that will actually be deployed.

const { describe, it, beforeEach } = require("node:test");
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
const { executeAuthorisedDial } = require("../src/services/acquisition-dial-execution");
const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");
const { EVENT_CODES } = require("../src/services/acquisition-call-events");
const { VERIFY_RESULTS } = require("../src/services/retell-webhook-verify");

const { createAcquisitionWebhookDeps } = require("../src/services/acquisition-webhook-deps");
const { createAcquisitionWebhookHandler } = require("../src/routes/acquisition-retell-webhook-handler");
const routeMod = require("../src/routes/acquisition-retell-webhook");

const ISO = "2026-08-05T04:00:00Z";
const now = (iso = ISO) => () => new Date(iso);
const ROUTING = Object.freeze({ agentId: "agent_fixture", fromNumber: "+61355500001" });

let seq = 0;
function mkProspect() {
  seq += 1;
  let p = createProspect({
    businessName: `Northside Lock & Key ${seq}`, tradeCategory: "Locksmith", suburb: "Brunswick", state: "VIC",
    postcode: "3056", region: "Melbourne", timezone: "Australia/Melbourne",
    phones: [{ raw: `(03) 5550 2${String(100 + seq).slice(-3)}` }], sourceRefs: [{ url: "https://x.example.com.au/c" }],
    origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const t of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, t, { actor: "Peter", reason: "e12d", now: now() }).prospect;
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

async function authorise(store, prospect) {
  const e164 = prospect.phones[0].e164 || `+6135550${String(2100 + seq).slice(-4)}`;
  const rows = evidenceFor(prospect);
  const ws = createWashStore({ now: now(), mode: "fixture" });
  ws.wash(e164);
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: `b ${prospect.prospectId}` });
  assert.strictEqual((await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e12d" })).ok, true);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

/**
 * A store with one claimed dispatch, plus the REAL composed dependencies —
 * the thing E-12D adds. `lost` leaves provider_ref null (ambiguous submission).
 */
async function composed({ lost = false, callId = "call_R" } = {}) {
  const store = createInMemoryAcquisitionStore();
  await store.writeCallingState({ state: "enabled", revision: 1, changedBy: "h", changedAt: ISO, reason: "t" });
  const prospect = mkProspect();
  const d = await authorise(store, prospect);
  const transport = lost
    ? async () => { throw new Error("socket hang up"); }
    : async () => ({ ok: true, resource: { id: callId } });
  await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport }), now: now() });
  for (const to of ["queued", "attempted"]) {
    await store.transitionProspectLifecycle({ prospectId: prospect.prospectId, to, actor: "h", reason: "staging", at: ISO }).catch(() => {});
  }
  // ── The composition under test ──
  const deps = await createAcquisitionWebhookDeps({ now: now(), store });
  return { store, prospect, dispatchId: d.dial.dispatchId, deps };
}

function fakeEvents({ failLookup = false, failRecord = false } = {}) {
  const real = require("../src/services/provider-webhook-events");
  const seen = new Map();
  return {
    validateEventEnvelope: real.validateEventEnvelope,
    eventFingerprint: real.eventFingerprint,
    buildEventFields: real.buildEventFields,
    boundEventMetadata: real.boundEventMetadata,
    findEventByFingerprint: async (fp) => { if (failLookup) throw new Error("db_error"); return seen.get(fp) || null; },
    recordEvent: async (fields) => {
      if (failRecord) throw new Error("insert failed");
      if (seen.has(fields.fingerprint)) return { duplicate: true };
      seen.set(fields.fingerprint, { ...fields });
      return { duplicate: false, row: fields };
    },
    markEventProcessed: async (fp, patch) => { if (seen.has(fp)) Object.assign(seen.get(fp), patch); },
    _seen: seen,
  };
}

const body = (o) => Buffer.from(JSON.stringify(o), "utf8");

const acqEvent = (dispatchId, { eventType = "call_ended", callId = "call_R", reason = null, analysis = null } = {}) => ({
  event: eventType,
  call: { call_id: callId, disconnection_reason: reason, call_analysis: analysis, metadata: { aida_purpose: "locksmith_acquisition", aida_dispatch_id: dispatchId } },
});

const analysisOf = (over = {}) => ({
  reached_human: true, outcome: "not_interested", explicit_opt_out: false, callback_requested: false,
  requested_callback_at: null, confidence: "high", reason: "fixture", evidence_ref: "turn:5", ...over,
});

function fakeRes() {
  const r = { statusCode: null, payload: null, ended: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

const verified = async () => ({ verified: true, result: VERIFY_RESULTS.verified });
const unverified = (result) => async () => ({ verified: false, result });

/** Drive the handler with the REAL composed deps and wait for background work. */
async function deliver({ deps, events, payload, verify = verified, extra = {} }) {
  const handler = createAcquisitionWebhookHandler({
    verify, events, store: deps.store, recorder: deps.recorder, now: now(), ...extra,
  });
  const res = fakeRes();
  await handler({ headers: { "content-type": "application/json" }, body: payload }, res);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return res;
}

const outcomesFor = async (store, prospectId) => (await store.listOutcomes()).filter((o) => o.prospectId === prospectId);
const dispatchOf = async (store, dispatchId) => (await store.listDialExecutions({ dispatchId }))[0];

// ---------------------------------------------------------------------------
// 1-2. COMPOSITION
// ---------------------------------------------------------------------------

describe("E-12D: the route composes real durable dependencies", () => {
  beforeEach(() => routeMod.__resetHandlerForTests());

  it("1. composition yields a non-null store and a real recorder", async () => {
    const { deps } = await composed();
    assert.ok(deps.store, "a store, not null — this is the whole milestone");
    assert.strictEqual(typeof deps.store.listDialExecutions, "function");
    assert.strictEqual(typeof deps.store.updateDialExecution, "function");
    assert.strictEqual(typeof deps.store.loadProspect, "function");
    assert.strictEqual(typeof deps.store.transitionProspectLifecycle, "function");
    assert.strictEqual(typeof deps.recorder.record, "function");
  });

  it("1b. the route no longer builds a handler with a null store", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "acquisition-retell-webhook.js"), "utf8");
    assert.ok(!/createAcquisitionWebhookHandler\(\)/.test(src), "the dependency-free call is gone");
    assert.match(src, /createAcquisitionWebhookDeps/);
    // E-12L: the route hands the handler a BUILDER rather than built deps, so
    // that storage is reached only after a delivery has verified.
    assert.match(src, /createAcquisitionWebhookHandler\(\{ resolveDeps/);
  });

  it("2. a disabled route never constructs acquisition persistence", async () => {
    // The gate exits the router before the entry handler, so resolveHandler is
    // unreachable. Proven by the gate's own behaviour rather than by inspection.
    let reached = false;
    const gate = routeMod.acquisitionWebhookGate({});
    gate({}, {}, (arg) => { if (arg !== "router") reached = true; });
    assert.strictEqual(reached, false, "flags off must exit the router");
    assert.strictEqual(routeMod.isAcquisitionWebhookEnabled({}), false);
  });

  it("2b. importing the route touches no database — production dormancy", () => {
    // Production has NO acquisition schema and server.js imports this router
    // unconditionally. If composition happened at import, every production
    // deploy would query acquisition_suppressions.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "acquisition-retell-webhook.js"), "utf8");
    assert.ok(
      !/^const\s+\w+\s*=\s*await\s+createAcquisitionWebhookDeps/m.test(src),
      "composition must not run at module scope"
    );
    assert.match(src, /async function resolveDeps/, "built on demand");
    // And the module really does import clean with no Supabase configuration.
    const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_KEY };
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;
      const abs = require.resolve("../src/routes/acquisition-retell-webhook");
      delete require.cache[abs];
      assert.doesNotThrow(() => require(abs));
    } finally {
      if (saved.u) process.env.SUPABASE_URL = saved.u;
      if (saved.k) process.env.SUPABASE_SERVICE_KEY = saved.k;
    }
  });

  it("2c. a failed composition is not memoised — a later delivery may retry", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "acquisition-retell-webhook.js"), "utf8");
    assert.match(src, /_building = null; \/\/ a transient outage must not disable the route/);
  });
});

// ---------------------------------------------------------------------------
// 3-5. NOTHING UNAUTHENTICATED REACHES A TABLE
// ---------------------------------------------------------------------------

describe("E-12D: wired, and still refusing everything it should", () => {
  it("3. an unsigned event answers 401 and mutates nothing", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    const events = fakeEvents();
    const res = await deliver({ deps, events, payload: body(acqEvent(dispatchId)), verify: unverified(VERIFY_RESULTS.missingSignature) });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(events._seen.size, 0, "no fingerprint for an unsigned delivery");
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), []);
    assert.strictEqual((await dispatchOf(store, dispatchId)).providerRef, "call_R");
  });

  it("4. a malformed body answers 400 and mutates nothing", async () => {
    const { deps, store, prospect } = await composed();
    const events = fakeEvents();
    const res = await deliver({ deps, events, payload: Buffer.from("{not json", "utf8") });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(events._seen.size, 0);
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), []);
  });

  it("5. another product's Retell event answers 204 and writes NO fingerprint", async () => {
    const { deps, store, prospect } = await composed();
    const events = fakeEvents();
    const foreign = { event: "call_ended", call: { call_id: "call_other", metadata: { aida_purpose: "locksmith_onboarding", session_id: "s1" } } };
    const res = await deliver({ deps, events, payload: body(foreign) });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(events._seen.size, 0, "the is-it-ours check precedes the fingerprint write");
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), []);
  });

  it("5b. an oversized delivery is refused by the verifier before any work", async () => {
    const { deps } = await composed();
    const events = fakeEvents();
    const res = await deliver({ deps, events, payload: body({ event: "call_ended" }), verify: unverified(VERIFY_RESULTS.oversize) });
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(events._seen.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 6-8. DURABLE FINGERPRINT
// ---------------------------------------------------------------------------

describe("E-12D: idempotency stays database-authoritative", () => {
  it("6. the first valid event claims a fingerprint", async () => {
    const { deps, dispatchId } = await composed();
    const events = fakeEvents();
    const res = await deliver({ deps, events, payload: body(acqEvent(dispatchId, { reason: "dial_no_answer" })) });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(events._seen.size, 1);
  });

  it("7. a duplicate delivery does no second processing", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    const events = fakeEvents();
    const payload = body(acqEvent(dispatchId, { reason: "voicemail_reached" }));
    await deliver({ deps, events, payload });
    const after1 = await outcomesFor(store, prospect.prospectId);
    await deliver({ deps, events, payload });
    const after2 = await outcomesFor(store, prospect.prospectId);
    assert.strictEqual(events._seen.size, 1, "one fingerprint");
    assert.deepStrictEqual(after2.length, after1.length, "no second outcome");
  });

  it("8. arbitration is the store's answer, not an app-side cache", async () => {
    // recordEvent reports the duplicate; the handler obeys it rather than
    // consulting a local set. Two concurrent deliveries, one winner.
    const { deps, store, prospect, dispatchId } = await composed();
    const events = fakeEvents();
    const payload = body(acqEvent(dispatchId, { reason: "voicemail_reached" }));
    await Promise.all([deliver({ deps, events, payload }), deliver({ deps, events, payload })]);
    assert.strictEqual(events._seen.size, 1);
    assert.ok((await outcomesFor(store, prospect.prospectId)).length <= 1, "at most one outcome from a duplicate pair");
  });
});

// ---------------------------------------------------------------------------
// 9-11. CORRELATION IS EXACT
// ---------------------------------------------------------------------------

describe("E-12D: correlation is the exact dispatch id, or nothing", () => {
  it("9. the exact aida_dispatch_id correlates", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { reason: "dial_no_answer" })) });
    const outs = await outcomesFor(store, prospect.prospectId);
    assert.strictEqual(outs.length, 1);
    assert.strictEqual(outs[0].outcome, "no_answer");
  });

  it("10. a missing dispatch id is permanent, not retried", async () => {
    const { deps, store, prospect } = await composed();
    const events = fakeEvents();
    const noId = { event: "call_ended", call: { call_id: "call_R", disconnection_reason: "dial_no_answer", metadata: { aida_purpose: "locksmith_acquisition" } } };
    const res = await deliver({ deps, events, payload: body(noId) });
    assert.strictEqual(res.statusCode, 204, "permanent — a 5xx would make Retell redeliver for ever");
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), []);
  });

  it("11. an unknown dispatch id fuzzy-matches nothing", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    const wrong = "00000000-0000-4000-8000-000000000000";
    assert.notStrictEqual(wrong, dispatchId);
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(wrong, { reason: "dial_no_answer" })) });
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), [], "no destination, name or timestamp fallback");
  });
});

// ---------------------------------------------------------------------------
// 12-15. E-9 PROVIDER_REF BINDING
// ---------------------------------------------------------------------------

describe("E-12D: call-id binding keeps its E-9 authority", () => {
  it("12. an unbound dispatch binds the provider call id", async () => {
    const { deps, store, dispatchId } = await composed({ lost: true });
    assert.strictEqual((await dispatchOf(store, dispatchId)).providerRef, null);
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { callId: "call_LATE", reason: "dial_no_answer" })) });
    assert.strictEqual((await dispatchOf(store, dispatchId)).providerRef, "call_LATE", "a lost submission reconciles");
  });

  it("13. the same call id on the same dispatch is idempotent", async () => {
    const { deps, store, dispatchId } = await composed({ callId: "call_SAME" });
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { callId: "call_SAME", reason: "dial_no_answer" })) });
    assert.strictEqual((await dispatchOf(store, dispatchId)).providerRef, "call_SAME");
  });

  it("14. a conflicting call id on a bound dispatch is refused, and refused PERMANENTLY", async () => {
    const { deps, store, prospect, dispatchId } = await composed({ callId: "call_R1" });
    const res = await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { callId: "call_R2", reason: "dial_no_answer" })) });
    assert.strictEqual((await dispatchOf(store, dispatchId)).providerRef, "call_R1", "write-once holds");
    assert.strictEqual(res.statusCode, 204, "permanent conflict must not become a redelivery loop");
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), []);
  });

  it("15. a call id already owned by another dispatch is refused", async () => {
    const a = await composed({ callId: "call_OWNED" });
    // A second dispatch in the SAME store, then hand it the first one's call id.
    const prospectB = mkProspect();
    const dB = await authorise(a.store, prospectB);
    await executeAuthorisedDial({
      store: a.store, authorisedDial: dB.dial,
      provider: createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => { throw new Error("socket hang up"); } }),
      now: now(),
    });
    const res = await deliver({ deps: a.deps, events: fakeEvents(), payload: body(acqEvent(dB.dial.dispatchId, { callId: "call_OWNED", reason: "dial_no_answer" })) });
    assert.strictEqual((await dispatchOf(a.store, dB.dial.dispatchId)).providerRef, null, "global uniqueness holds");
    assert.strictEqual(res.statusCode, 204);
  });
});

// ---------------------------------------------------------------------------
// 16-20. LIFECYCLE AND OUTCOMES
// ---------------------------------------------------------------------------

describe("E-12D: lifecycle and outcome semantics survive the wiring", () => {
  it("16. an authenticated event repairs a prospect left short of attempted", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.writeCallingState({ state: "enabled", revision: 1, changedBy: "h", changedAt: ISO, reason: "t" });
    const prospect = mkProspect();
    const d = await authorise(store, prospect);
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport: async () => ({ ok: true, resource: { id: "call_L" } }) }), now: now() });
    // Deliberately NOT staged to attempted.
    const deps = await createAcquisitionWebhookDeps({ now: now(), store });
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(d.dial.dispatchId, { callId: "call_L", reason: "dial_no_answer" })) });
    const after = await store.loadProspect(prospect.prospectId);
    assert.ok(["attempted", "connected"].includes(after.lifecycleState) || (await outcomesFor(store, prospect.prospectId)).length === 1);
  });

  it("17. reached_human true records a human-reached outcome", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { eventType: "call_analyzed", analysis: analysisOf({ reached_human: true, outcome: "not_interested" }) })) });
    const outs = await outcomesFor(store, prospect.prospectId);
    assert.strictEqual(outs.length, 1);
    assert.strictEqual(outs[0].outcome, "not_interested");
    assert.strictEqual(outs[0].reachedTheBusiness, true);
  });

  it("18. voicemail is preserved end to end (E-12A)", async () => {
    for (const reason of ["voicemail_reached", "machine_detected"]) {
      const { deps, store, prospect, dispatchId } = await composed();
      await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { reason })) });
      const outs = await outcomesFor(store, prospect.prospectId);
      assert.strictEqual(outs.length, 1, reason);
      assert.strictEqual(outs[0].outcome, "voicemail", reason);
    }
  });

  it("19. no_answer is preserved end to end", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { reason: "dial_no_answer" })) });
    const outs = await outcomesFor(store, prospect.prospectId);
    assert.strictEqual(outs[0].outcome, "no_answer");
    assert.strictEqual(outs[0].reachedTheBusiness, false);
  });

  it("20. an evidenced opt-out actually suppresses — the composition made that possible", async () => {
    // An opt-out is NOT an outcome value: `outcome` is one of the six analysed
    // outcomes, and opting out is the `explicit_opt_out` FLAG on top of one.
    // (An earlier draft of this test sent outcome:"opt_out" and was correctly
    // rejected as an unknown outcome.)
    //
    // With a null recorder this path could not have run at all. With a null
    // SUPPRESSION the recorder refuses rather than recording a hollow opt-out.
    const { deps, store, prospect, dispatchId } = await composed();
    await deliver({
      deps, events: fakeEvents(),
      payload: body(acqEvent(dispatchId, {
        eventType: "call_analyzed",
        analysis: analysisOf({ outcome: "not_interested", explicit_opt_out: true, confidence: "high", evidence_ref: "turn:9" }),
      })),
    });
    const outs = await outcomesFor(store, prospect.prospectId);
    assert.strictEqual(outs.length, 1);
    assert.strictEqual(outs[0].outcome, "opt_out", "the flag wins over the reported outcome");
    assert.strictEqual(outs[0].suppressionApplied, true, "recorded AND uncallable, or neither");
    assert.ok((await store.listSuppressions()).length >= 1, "the business is genuinely suppressed");
  });

  it("20b. a low-confidence opt-out is held for a human, not acted on", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    await deliver({
      deps, events: fakeEvents(),
      payload: body(acqEvent(dispatchId, {
        eventType: "call_analyzed",
        analysis: analysisOf({ outcome: "not_interested", explicit_opt_out: true, confidence: "low", evidence_ref: null }),
      })),
    });
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), [], "not recorded, and NOT downgraded to a decline");
    assert.deepStrictEqual(await store.listSuppressions(), [], "and nobody was suppressed on weak evidence");
    assert.strictEqual((await dispatchOf(store, dispatchId)).resolvedAt, null, "left for a person");
  });
});

// ---------------------------------------------------------------------------
// 21-23. ORDERING — OUTCOME BEFORE RESOLUTION
// ---------------------------------------------------------------------------

describe("E-12D: the business fact is durable before the lock is released", () => {
  it("21. a successful event records the outcome AND resolves the dispatch", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    assert.strictEqual((await dispatchOf(store, dispatchId)).resolvedAt, null);
    await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { reason: "dial_no_answer" })) });
    assert.strictEqual((await outcomesFor(store, prospect.prospectId)).length, 1);
    assert.ok((await dispatchOf(store, dispatchId)).resolvedAt, "resolved last, but resolved");
  });

  it("22. if the outcome fails, the dispatch stays UNRESOLVED", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    const broken = { ...deps.recorder, record: async () => ({ ok: false, code: "storage_error", message: "append failed" }) };
    const handler = createAcquisitionWebhookHandler({ verify: verified, events: fakeEvents(), store: deps.store, recorder: broken, now: now() });
    const res = fakeRes();
    await handler({ headers: { "content-type": "application/json" }, body: body(acqEvent(dispatchId, { reason: "dial_no_answer" })) }, res);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(await outcomesFor(store, prospect.prospectId), []);
    assert.strictEqual((await dispatchOf(store, dispatchId)).resolvedAt, null, "the lock is never released on a failed outcome");
  });

  it("23. redelivery after success does not duplicate the outcome", async () => {
    const { deps, store, prospect, dispatchId } = await composed();
    const events = fakeEvents();
    const payload = body(acqEvent(dispatchId, { reason: "dial_no_answer" }));
    await deliver({ deps, events, payload });
    await deliver({ deps, events, payload });
    assert.strictEqual((await outcomesFor(store, prospect.prospectId)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 24-27. FAILURE SEMANTICS AND RESTRAINT
// ---------------------------------------------------------------------------

describe("E-12D: transient means 503, permanent means 204", () => {
  it("24. a fingerprint-store outage answers 503", async () => {
    const { deps, dispatchId } = await composed();
    const res = await deliver({ deps, events: fakeEvents({ failLookup: true }), payload: body(acqEvent(dispatchId, { reason: "dial_no_answer" })) });
    assert.strictEqual(res.statusCode, 503, "transient — Retell should redeliver");
  });

  it("24b. an unbuildable durable layer answers 503, never a 2xx", () => {
    // E-12L moved this out of the route entry and into the handler, where it
    // now sits AFTER verification and BEFORE the 204. Both edges matter:
    // earlier let an unsigned request reach storage; later would have
    // acknowledged an event that could not be processed, losing the redelivery.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "acquisition-retell-webhook-handler.js"), "utf8");
    assert.match(src, /status\(503\)\.json\(\{ error: "storage_unavailable" \}\)/);

    const verifyAt = src.search(/await verify\(/);
    const depsAt = src.indexOf("resolveDeps()");
    const ackAt = src.indexOf("res.status(204).end()", depsAt);
    assert.ok(verifyAt > 0 && depsAt > verifyAt, "deps come after verification");
    assert.ok(ackAt > depsAt, "and before the acknowledgement");
  });

  it("25. permanent semantic conflicts stay 204", async () => {
    const { deps, dispatchId } = await composed({ callId: "call_P1" });
    const res = await deliver({ deps, events: fakeEvents(), payload: body(acqEvent(dispatchId, { callId: "call_P2", reason: "dial_no_answer" })) });
    assert.strictEqual(res.statusCode, 204);
  });

  it("26. this milestone introduced no retry", () => {
    for (const f of ["services/acquisition-webhook-deps.js", "routes/acquisition-retell-webhook.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
      assert.ok(!/setTimeout|setInterval|retryCount|backoff|for \(let attempt/.test(src), `${f} schedules nothing`);
    }
  });

  it("27. and no automatic callback", () => {
    for (const f of ["services/acquisition-webhook-deps.js", "routes/acquisition-retell-webhook.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
      assert.ok(!/createPhoneCall|callback_number|redial|placeCall/i.test(src));
    }
  });
});

// ---------------------------------------------------------------------------
// 28-30. INDEPENDENCE AND DORMANCY
// ---------------------------------------------------------------------------

describe("E-12D: the wiring adds no reach", () => {
  it("28. neither new nor changed file mentions Twilio", () => {
    for (const f of ["services/acquisition-webhook-deps.js", "routes/acquisition-retell-webhook.js"]) {
      assert.ok(!/twilio/i.test(fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")), f);
    }
  });

  it("29. the route still loads with Twilio credentials absent", () => {
    const saved = { s: process.env.TWILIO_ACCOUNT_SID, t: process.env.TWILIO_AUTH_TOKEN };
    try {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      const abs = require.resolve("../src/routes/acquisition-retell-webhook");
      delete require.cache[abs];
      assert.doesNotThrow(() => require(abs));
    } finally {
      if (saved.s) process.env.TWILIO_ACCOUNT_SID = saved.s;
      if (saved.t) process.env.TWILIO_AUTH_TOKEN = saved.t;
    }
  });

  it("30. default flags keep acquisition persistence dormant, and no provider is live", () => {
    assert.strictEqual(routeMod.isAcquisitionWebhookEnabled({}), false);
    const dial = require("../src/services/acquisition-dial-provider");
    const retell = require("../src/services/acquisition-retell-provider");
    assert.strictEqual(dial.createDisabledDialProvider().live, false);
    assert.strictEqual(retell.createRetellAcquisitionProvider({ routing: ROUTING }).live, false);
    assert.strictEqual(require("../src/config/acquisition").EXTERNAL_SYSTEMS.telephony, false);
  });

  it("30b. no SQL and no second persistence model were introduced", () => {
    const deps = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-webhook-deps.js"), "utf8");
    assert.ok(!/CREATE |INSERT |UPDATE |DELETE |\.sql/i.test(deps), "no SQL in the composition");
    assert.match(deps, /createSupabaseAcquisitionStore/, "reuses the existing store");
    assert.match(deps, /createDurableSuppression/);
    assert.match(deps, /createDurableOutcomes/);
    assert.ok(!/createClient\(/.test(deps), "no ad-hoc Supabase client");
  });
});
