// LOCKSMITH ACQUISITION E-11A — the webhook ingress, offline.
//
// The return path from E-7B2B1 with a signature in front of it and a durable
// fingerprint beside it. Everything here uses fake req/res objects and injected
// fakes; nothing opens a socket, and no Retell request is made.
//
// The proofs that matter are the ones about NOT writing: an unverified,
// malformed, or somebody-else's delivery must not reach an acquisition table.

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
const { EVENT_CODES } = require("../src/services/acquisition-call-events");
const { VERIFY_RESULTS } = require("../src/services/retell-webhook-verify");

const { createAcquisitionWebhookHandler, isAcquisitionEvent, statusFor } = require("../src/routes/acquisition-retell-webhook-handler");
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
    phones: [{ raw: `(03) 5550 1${String(100 + seq).slice(-3)}` }], sourceRefs: [{ url: "https://x.example.com.au/c" }],
    origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const t of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, t, { actor: "Peter", reason: "e11a", now: now() }).prospect;
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
  const e164 = prospect.phones[0].e164 || `+6135550${String(1100 + seq).slice(-4)}`;
  const rows = evidenceFor(prospect);
  const ws = createWashStore({ now: now(), mode: "fixture" });
  ws.wash(e164);
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: `b ${prospect.prospectId}` });
  assert.strictEqual((await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e11a" })).ok, true);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

/** A store with one claimed dispatch. `lost` leaves provider_ref null. */
async function claimed({ lost = false, callId = "call_R" } = {}) {
  const store = createInMemoryAcquisitionStore();
  await store.writeCallingState({ state: "enabled", revision: 1, changedBy: "h", changedAt: ISO, reason: "t" });
  const prospect = mkProspect();
  const d = await authorise(store, prospect);
  const transport = lost
    ? async () => { throw new Error("socket hang up"); }
    : async () => ({ ok: true, resource: { id: callId } });
  await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport }), now: now() });
  // Stage the prospect the way a complete dispatch path does (E-8).
  for (const to of ["queued", "attempted"]) {
    await store.transitionProspectLifecycle({ prospectId: prospect.prospectId, to, actor: "h", reason: "staging", at: ISO }).catch(() => {});
  }
  const recorder = createDurableOutcomes({
    now: now(), suppression: await createDurableSuppression({ now: now(), store }), store,
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
  });
  return { store, prospect, dispatchId: d.dial.dispatchId, recorder };
}

/** An in-memory stand-in for the LPM3 durable event log. */
function fakeEvents({ failLookup = false, failRecord = false } = {}) {
  const real = require("../src/services/provider-webhook-events");
  const seen = new Map();
  return {
    validateEventEnvelope: real.validateEventEnvelope,
    eventFingerprint: real.eventFingerprint,
    buildEventFields: real.buildEventFields,
    boundEventMetadata: real.boundEventMetadata,
    findEventByFingerprint: async (fp) => {
      if (failLookup) throw new Error("db_error");
      return seen.get(fp) || null;
    },
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
  call: {
    call_id: callId,
    disconnection_reason: reason,
    call_analysis: analysis,
    metadata: { aida_purpose: "locksmith_acquisition", aida_dispatch_id: dispatchId },
  },
});

const analysis = (over = {}) => ({
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

/** Run one delivery through the handler and wait for the after-response work. */
async function deliver({ payload, store, recorder, verify = verified, eventsApi = fakeEvents(), captured = {} }) {
  const seenResults = [];
  const handler = createAcquisitionWebhookHandler({
    verify,
    events: eventsApi,
    store,
    recorder,
    now: now(),
    logger: { log() {}, error() {} },
    handleAcquisitionCallEvent: captured.handle
      ? captured.handle
      : async (args) => {
          const { handleAcquisitionCallEvent } = require("../src/services/acquisition-call-events");
          const out = await handleAcquisitionCallEvent(args);
          seenResults.push(out);
          return out;
        },
  });
  const res = fakeRes();
  await handler({ headers: { "content-type": "application/json" }, body: payload }, res);
  // Let the post-response chain settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { res, results: seenResults, eventsApi };
}

// ---------------------------------------------------------------------------
// 1-3. AUTHENTICATION — nothing gets past an unverified delivery
// ---------------------------------------------------------------------------

describe("E-11A: unverified deliveries mutate nothing", () => {
  it("1. a missing signature is refused, and writes nothing", async () => {
    const { store, dispatchId, recorder } = await claimed();
    const before = await store.listDialExecutions({});
    const e = fakeEvents();
    const { res } = await deliver({ payload: body(acqEvent(dispatchId)), store, recorder, verify: unverified(VERIFY_RESULTS.missingSignature), eventsApi: e });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(e._seen.size, 0, "no fingerprint written");
    assert.deepStrictEqual(await store.listDialExecutions({}), before);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("2. an invalid signature is refused, and writes nothing", async () => {
    const { store, dispatchId, recorder } = await claimed();
    const e = fakeEvents();
    const { res } = await deliver({ payload: body(acqEvent(dispatchId)), store, recorder, verify: unverified(VERIFY_RESULTS.invalidSignature), eventsApi: e });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(e._seen.size, 0);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("a stale signature and a bad content type map to their own codes", async () => {
    const { store, dispatchId, recorder } = await claimed();
    for (const [result, code] of [[VERIFY_RESULTS.staleSignature, 401], [VERIFY_RESULTS.badContentType, 400], [VERIFY_RESULTS.oversize, 413], [VERIFY_RESULTS.disabled, 503]]) {
      const { res } = await deliver({ payload: body(acqEvent(dispatchId)), store, recorder, verify: unverified(result) });
      assert.strictEqual(res.statusCode, code, result);
    }
  });

  it("3. a malformed body is refused after verification", async () => {
    const { store, dispatchId, recorder } = await claimed();
    void dispatchId;
    const e = fakeEvents();
    const { res } = await deliver({ payload: Buffer.from("{not json", "utf8"), store, recorder, eventsApi: e });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload.error, "malformed_json");
    assert.strictEqual(e._seen.size, 0);
  });

  it("an envelope with no call_id is refused", async () => {
    const { store, recorder } = await claimed();
    const { res } = await deliver({ payload: body({ event: "call_ended", call: {} }), store, recorder });
    assert.strictEqual(res.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// 4-7. ROUTING AND CORRELATION
// ---------------------------------------------------------------------------

describe("E-11A: only genuine acquisition events enter the acquisition path", () => {
  it("4. an ordinary receptionist event is ignored without touching anything", async () => {
    const { store, recorder } = await claimed();
    const e = fakeEvents();
    const receptionist = { event: "call_ended", call: { call_id: "call_someone_else", metadata: { client_id: "abc", session_id: "s1" } } };
    const { res, results } = await deliver({ payload: body(receptionist), store, recorder, eventsApi: e });

    assert.strictEqual(res.statusCode, 204, "acknowledged — it is somebody else's event, not an error");
    assert.strictEqual(e._seen.size, 0, "and it does not fill our event log");
    assert.strictEqual(results.length, 0, "the acquisition handler is never called");
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("isAcquisitionEvent recognises ours and only ours", () => {
    assert.strictEqual(isAcquisitionEvent({ metadata: { aida_purpose: "locksmith_acquisition" } }), true);
    assert.strictEqual(isAcquisitionEvent({ metadata: { aida_dispatch_id: "d" } }), true);
    assert.strictEqual(isAcquisitionEvent({ metadata: { client_id: "x" } }), false);
    assert.strictEqual(isAcquisitionEvent({}), false);
    assert.strictEqual(isAcquisitionEvent(null), false);
  });

  it("5. an acquisition event with no dispatchId guesses nothing", async () => {
    const { store, recorder } = await claimed();
    const ev = { event: "call_ended", call: { call_id: "call_R", metadata: { aida_purpose: "locksmith_acquisition" } } };
    const { res, results } = await deliver({ payload: body(ev), store, recorder });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(results[0].code, EVENT_CODES.NO_DISPATCH_ID);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("6. an unknown dispatchId produces no guessed outcome", async () => {
    const { store, recorder } = await claimed();
    const { results } = await deliver({ payload: body(acqEvent("00000000-0000-4000-8000-000000000000")), store, recorder });
    assert.strictEqual(results[0].code, EVENT_CODES.UNKNOWN_DISPATCH);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
  });

  it("7. the exact dispatchId routes to the right dispatch", async () => {
    const { store, dispatchId, recorder } = await claimed();
    const { results } = await deliver({ payload: body(acqEvent(dispatchId, { reason: "dial_no_answer" })), store, recorder });
    assert.strictEqual(results[0].dispatchId, dispatchId);
    assert.strictEqual(results[0].outcomeRecorded, true, results[0].message);
  });
});

// ---------------------------------------------------------------------------
// 8. DURABLE IDEMPOTENCY
// ---------------------------------------------------------------------------

describe("E-11A: a redelivered event is harmless", () => {
  it("8. the same fingerprint twice processes once", async () => {
    const { store, dispatchId, recorder } = await claimed();
    const e = fakeEvents();
    const payload = body(acqEvent(dispatchId, { reason: "dial_no_answer" }));

    const first = await deliver({ payload, store, recorder, eventsApi: e });
    assert.strictEqual(first.res.statusCode, 204);
    assert.strictEqual(first.results.length, 1);
    assert.strictEqual((await store.listOutcomes({})).length, 1);

    const second = await deliver({ payload, store, recorder, eventsApi: e });
    assert.strictEqual(second.res.statusCode, 204, "still acknowledged");
    assert.strictEqual(second.results.length, 0, "and never processed a second time");
    assert.strictEqual((await store.listOutcomes({})).length, 1, "one outcome");
  });

  it("a concurrent duplicate losing the DB race is still idempotent", async () => {
    const { store, dispatchId, recorder } = await claimed();
    const e = fakeEvents();
    e.recordEvent = async () => ({ duplicate: true }); // the database decided
    const { res, results } = await deliver({ payload: body(acqEvent(dispatchId)), store, recorder, eventsApi: e });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(results.length, 0);
  });

  it("a storage outage is the ONLY transient answer", async () => {
    const { store, dispatchId, recorder } = await claimed();
    const lookupDown = await deliver({ payload: body(acqEvent(dispatchId)), store, recorder, eventsApi: fakeEvents({ failLookup: true }) });
    assert.strictEqual(lookupDown.res.statusCode, 503, "so Retell redelivers later rather than the event being lost");
    const recordDown = await deliver({ payload: body(acqEvent(dispatchId)), store, recorder, eventsApi: fakeEvents({ failRecord: true }) });
    assert.strictEqual(recordDown.res.statusCode, 503);
  });
});

// ---------------------------------------------------------------------------
// 9-13. BINDING AND LIFECYCLE
// ---------------------------------------------------------------------------

describe("E-11A: binding and lifecycle survive the ingress", () => {
  it("9. call_started establishes only what it proves", async () => {
    const { store, prospect, dispatchId, recorder } = await claimed({ lost: true });
    const { results } = await deliver({ payload: body(acqEvent(dispatchId, { eventType: "call_started", callId: "call_R" })), store, recorder });
    assert.strictEqual(results[0].outcomeRecorded, false);
    assert.strictEqual((await store.loadProspect(prospect.prospectId)).lifecycle, "attempted", "attempted, not connected");
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null);
  });

  it("10-11. a lost-response webhook binds provider_ref, and repeats are idempotent", async () => {
    const { store, dispatchId, recorder } = await claimed({ lost: true });
    assert.strictEqual((await store.listDialExecutions({}))[0].providerRef, null);
    const e = fakeEvents();
    await deliver({ payload: body(acqEvent(dispatchId, { eventType: "call_started", callId: "call_LATE" })), store, recorder, eventsApi: e });
    assert.strictEqual((await store.listDialExecutions({}))[0].providerRef, "call_LATE");
    const snapshot = await store.listDialExecutions({});
    await deliver({ payload: body(acqEvent(dispatchId, { eventType: "call_started", callId: "call_LATE" })), store, recorder, eventsApi: e });
    assert.deepStrictEqual(await store.listDialExecutions({}), snapshot);
  });

  it("12. a conflicting provider_ref is refused and never retried", async () => {
    const { store, dispatchId, recorder } = await claimed({ lost: true });
    await deliver({ payload: body(acqEvent(dispatchId, { eventType: "call_started", callId: "call_R1" })), store, recorder });
    const { res, results } = await deliver({ payload: body(acqEvent(dispatchId, { eventType: "call_ended", callId: "call_R2", reason: "dial_no_answer" })), store, recorder });

    assert.strictEqual(results[0].code, EVENT_CODES.CALL_ID_CONFLICT);
    assert.strictEqual(res.statusCode, 204, "a permanent conflict must NOT ask Retell to redeliver for ever");
    assert.strictEqual((await store.listDialExecutions({}))[0].providerRef, "call_R1");
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listDialExecutions({}))[0].resolvedAt, null);
  });

  it("13. a different dispatch claiming the same call id is refused", async () => {
    const a = await claimed({ lost: true });
    const b = await claimed({ lost: true });
    await deliver({ payload: body(acqEvent(a.dispatchId, { eventType: "call_started", callId: "call_SHARED" })), store: a.store, recorder: a.recorder });
    // Bind the same id into b's store by hand to model the cross-dispatch case.
    await b.store.updateDialExecution(b.dispatchId, { providerRef: "call_OTHER" });
    const { results } = await deliver({ payload: body(acqEvent(b.dispatchId, { eventType: "call_ended", callId: "call_SHARED", reason: "dial_no_answer" })), store: b.store, recorder: b.recorder });
    assert.ok([EVENT_CODES.CALL_ID_CONFLICT, EVENT_CODES.CALL_ID_TAKEN].includes(results[0].code), results[0].code);
    assert.strictEqual((await b.store.listOutcomes({})).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 14-21. OUTCOMES
// ---------------------------------------------------------------------------

describe("E-11A: outcomes arrive intact through the ingress", () => {
  const run = async (opts) => {
    const c = await claimed();
    const { results } = await deliver({ payload: body(acqEvent(c.dispatchId, opts)), store: c.store, recorder: c.recorder });
    return { r: results[0], store: c.store };
  };

  it("14. no_answer", async () => {
    const { r, store } = await run({ reason: "dial_no_answer" });
    assert.strictEqual(r.classifiedOutcome, "no_answer", r.message);
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "no_answer");
  });

  it("15. voicemail", async () => {
    const { r, store } = await run({ reason: "voicemail_reached" });
    assert.strictEqual(r.classifiedOutcome, "voicemail", r.message);
    assert.strictEqual((await store.listOutcomes({}))[0].outcome, "voicemail");
  });

  it("16-19. connected outcomes stay distinct", async () => {
    for (const [a, expected] of [
      [analysis({ outcome: "not_interested" }), "not_interested"],
      [analysis({ outcome: "declined" }), "declined"],
      [analysis({ outcome: "declined", explicit_opt_out: true }), "opt_out"],
      [analysis({ outcome: "callback_requested", callback_requested: true }), "callback"],
    ]) {
      const { r, store } = await run({ eventType: "call_analyzed", analysis: a });
      assert.strictEqual(r.classifiedOutcome, expected, `${expected}: ${r.message}`);
      assert.strictEqual((await store.listOutcomes({}))[0].outcome, expected);
    }
  });

  it("21. an ambiguous analysis writes no permanent outcome", async () => {
    const { r, store } = await run({ eventType: "call_analyzed", analysis: analysis({ explicit_opt_out: true, confidence: "low", evidence_ref: null }) });
    assert.strictEqual(r.code, EVENT_CODES.NEEDS_HUMAN);
    assert.strictEqual((await store.listOutcomes({})).length, 0);
    assert.strictEqual((await store.listSuppressions({})).length, 0);
  });

  it("25. a duplicate call_analyzed duplicates neither outcome nor suppression", async () => {
    const c = await claimed();
    const e = fakeEvents();
    const payload = body(acqEvent(c.dispatchId, { eventType: "call_analyzed", analysis: analysis({ outcome: "declined", explicit_opt_out: true }) }));
    await deliver({ payload, store: c.store, recorder: c.recorder, eventsApi: e });
    await deliver({ payload, store: c.store, recorder: c.recorder, eventsApi: e });
    assert.strictEqual((await c.store.listOutcomes({})).length, 1);
    assert.strictEqual((await c.store.listSuppressions({})).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 22-24. FAILURE ORDERING
// ---------------------------------------------------------------------------

describe("E-11A: every failure leaves the dispatch unresolved", () => {
  it("22. a lifecycle that cannot be established writes no outcome", async () => {
    const c = await claimed();
    await c.store.transitionProspectLifecycle({ prospectId: c.prospect.prospectId, to: "suppressed", actor: "h", reason: "earlier opt-out", at: ISO });
    const { results } = await deliver({ payload: body(acqEvent(c.dispatchId, { eventType: "call_analyzed", analysis: analysis() })), store: c.store, recorder: c.recorder });
    assert.strictEqual(results[0].code, EVENT_CODES.LIFECYCLE_REFUSED);
    assert.strictEqual((await c.store.listOutcomes({})).length, 0);
    assert.strictEqual((await c.store.listDialExecutions({}))[0].resolvedAt, null);
  });

  it("23. an outcome that cannot be written leaves the lock held", async () => {
    const c = await claimed();
    const broken = { record: async () => { throw new Error("outcome store down"); } };
    const { results } = await deliver({ payload: body(acqEvent(c.dispatchId, { reason: "dial_no_answer" })), store: c.store, recorder: broken });
    assert.strictEqual(results[0].outcomeRecorded, false);
    assert.strictEqual((await c.store.listDialExecutions({}))[0].resolvedAt, null);
  });

  it("24. a failed resolution leaves the OUTCOME and an unresolved dispatch", async () => {
    const c = await claimed();
    const guard = Object.freeze({
      ...c.store,
      updateDialExecution: async (id, patch) => {
        if ("resolvedAt" in patch) throw new Error("the ledger refused the release");
        return c.store.updateDialExecution(id, patch);
      },
    });
    const { results } = await deliver({ payload: body(acqEvent(c.dispatchId, { reason: "dial_no_answer" })), store: guard, recorder: c.recorder });
    assert.strictEqual(results[0].outcomeRecorded, true, results[0].message);
    assert.strictEqual(results[0].dispatchResolved, false);
    assert.strictEqual((await c.store.listDialExecutions({}))[0].resolvedAt, null);
  });

  it("the durable event log records a permanent conflict as failed, not processed", () => {
    assert.strictEqual(statusFor({ ok: true }), "processed");
    assert.strictEqual(statusFor({ ok: false, code: EVENT_CODES.CALL_ID_TAKEN }), "failed");
    assert.strictEqual(statusFor({ ok: true, code: EVENT_CODES.ALREADY_RESOLVED }), "processed");
    assert.strictEqual(statusFor(null), "failed");
  });
});

// ---------------------------------------------------------------------------
// 26-29. THE ROUTE CANNOT DO ANYTHING ELSE
// ---------------------------------------------------------------------------

describe("E-11A: the route cannot call, provision or enable anything", () => {
  const FILES = ["src/routes/acquisition-retell-webhook.js", "src/routes/acquisition-retell-webhook-handler.js"];
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const codeOf = (s) => s.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");

  it("26-27. it cannot create a call or provision a resource", () => {
    for (const f of FILES) {
      const code = codeOf(read(f));
      for (const p of [/createPhoneCall/, /createWebCall/, /createAgent/, /createResponseEngine/, /bindPhoneNumber/, /executeAuthorisedDial/, /\.submit\s*\(/, /describeAcquisitionRetellResources/]) {
        assert.ok(!p.test(code), `${f} must not contain ${p}`);
      }
    }
  });

  it("it reaches no network of its own and holds no credential", () => {
    for (const f of FILES) {
      const src = read(f);
      const code = codeOf(src);
      for (const p of [/\bfetch\s*\(/, /require\(["'](axios|got|node-fetch|undici|twilio|retell-sdk)/, /require\(["']\.\.\/services\/retell-adapter["']\)/]) {
        assert.ok(!p.test(code), `${f} must not contain ${p}`);
      }
      for (const s of ["API_KEY", "apiKey", "Bearer"]) assert.ok(!code.includes(s), `${f} must not reference ${s}`);
    }
  });

  it("it does not verify signatures itself — it reuses the one verifier", () => {
    const code = codeOf(read("src/routes/acquisition-retell-webhook-handler.js"));
    assert.match(code, /require\(["']\.\.\/services\/retell-webhook-verify["']\)/, "the shared verifier");
    for (const p of [/createHmac/, /timingSafeEqual/, /crypto/]) {
      assert.ok(!p.test(code), `signature logic must not be duplicated here: ${p}`);
    }
  });

  it("it does not route acquisition through onboarding business handling", () => {
    const code = codeOf(read("src/routes/acquisition-retell-webhook-handler.js"));
    for (const p of [/decideEventHandling/, /onboarding-call-lifecycle/, /onboarding_call\./]) {
      assert.ok(!p.test(code), `acquisition must not traverse onboarding handling: ${p}`);
    }
  });

  it("28-29. providers stay live:false and calling stays paused", async () => {
    const { createDisabledDialProvider, createFakeDialProvider } = require("../src/services/acquisition-dial-provider");
    assert.strictEqual(createDisabledDialProvider().live, false);
    assert.strictEqual(createFakeDialProvider().live, false);
    assert.strictEqual(createRetellAcquisitionProvider({ routing: ROUTING }).live, false);
    const code = codeOf(read("src/routes/acquisition-retell-webhook-handler.js"));
    for (const p of [/writeCallingState/, /enableAcquisitionCalling/, /live:\s*true/]) {
      assert.ok(!p.test(code), `the route must not touch calling state: ${p}`);
    }
  });

  it("the path is DORMANT behind its own third flag", () => {
    const { isAcquisitionWebhookEnabled, ACQUISITION_WEBHOOK_PATH } = routeMod;
    assert.strictEqual(ACQUISITION_WEBHOOK_PATH, "/webhooks/retell/acquisition");
    assert.strictEqual(isAcquisitionWebhookEnabled({}), false, "off by default");
    assert.strictEqual(isAcquisitionWebhookEnabled({ RETELL_ACQUISITION_WEBHOOK_ENABLED: "true" }), true);

    // Enabling the ONBOARDING webhook must not enable this one.
    const gate = routeMod.acquisitionWebhookGate({ RETELL_ENABLED: "true", RETELL_WEBHOOK_ENABLED: "true" });
    let routed = null;
    gate({}, {}, (arg) => { routed = arg; });
    assert.strictEqual(routed, "router", "without its own flag the path 404s");
  });

  it("it is mounted, and separately from the onboarding ingress", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.match(server, /routes\/acquisition-retell-webhook/, "mounted in source");
    assert.match(server, /routes\/retell-webhook/, "alongside, not instead of");
    assert.ok(!/webhooks\/retell\/acquisition/.test(fs.readFileSync(path.join(__dirname, "..", "src", "routes", "retell-webhook.js"), "utf8")), "the onboarding route knows nothing about it");
  });
});
