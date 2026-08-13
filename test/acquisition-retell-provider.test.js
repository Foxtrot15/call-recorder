// LOCKSMITH ACQUISITION E-7B2A — the Retell provider, built and unable to call.
//
// The milestone's claim is narrow and worth stating exactly: we can construct
// the precise create-phone-call request, map every response Retell can give,
// and bind a returned call id to the durable dispatch — WITHOUT acquiring the
// ability to send anything. Every proof below runs offline against injected
// fakes. No transport is imported, no key is read, no host is named.
//
// The two proofs that matter most are the ones about NOT calling:
//   * a paused durable stop yields ZERO submissions even with a valid provider
//   * an ambiguous answer is never retried, and never claims a call was placed

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

const { executeAuthorisedDial, EXECUTION_CODES } = require("../src/services/acquisition-dial-execution");
const { PROVIDER_STATUS } = require("../src/services/acquisition-dial-provider");
const { listUnresolvedDispatches } = require("../src/services/acquisition-dispatch-store");
const {
  createRetellAcquisitionProvider,
  buildRetellCallPayload,
  mapRetellResponse,
  classifyProviderFailure,
  assertRetellRouting,
  AmbiguousSubmission,
  AMBIGUOUS_FAILURE_CODES,
  DEFINITIVE_FAILURE_CODES,
} = require("../src/services/acquisition-retell-provider");

const ISO = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";
const now = (iso = ISO) => () => new Date(iso);

/** Fictional throughout. agent_ and the 03 5550 range are both invented. */
const ROUTING = Object.freeze({ agentId: "agent_acqfixture0001", fromNumber: "+61355500001" });

const EXECUTION = Object.freeze({
  executionId: "ex_fixture_0001",
  destination: NUMBER,
  prospectId: "pr_fixture0001",
  businessName: "Northside Lock & Key",
  authorisedAt: ISO,
  metadata: Object.freeze({ campaign: "pilot" }),
});

function mkProspect() {
  let p = createProspect({
    businessName: "Northside Lock & Key", tradeCategory: "Locksmith", suburb: "Brunswick", state: "VIC",
    postcode: "3056", region: "Melbourne", timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }], sourceRefs: [{ url: "https://x.example.com.au/c" }],
    origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const t of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, t, { actor: "Peter", reason: "e7b2a", now: now() }).prospect;
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

async function storeWithCalling(state) {
  const store = createInMemoryAcquisitionStore();
  await store.writeCallingState({ state, revision: 1, changedBy: "e7b2a harness", changedAt: ISO, reason: "test" });
  return store;
}

async function authorise(store, prospect, e164 = NUMBER) {
  const rows = evidenceFor(prospect);
  const ws = createWashStore({ now: now(), mode: "fixture" });
  ws.wash(e164);
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: `batch ${prospect.prospectId}` });
  const appr = await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e7b2a" });
  assert.strictEqual(appr.ok, true, appr.message);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

/** A transport that records calls and answers from a script. Never networked. */
function fakeTransport(script) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const answer = typeof script === "function" ? script(calls.length) : script;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  fn.calls = calls;
  return fn;
}

const okResponse = (callId = "call_fixture_abc123") =>
  ({ ok: true, operation: "createPhoneCall", mode: "live", resource: { id: callId }, providerRequestId: "req_fixture_1" });

const failResponse = (code) =>
  ({ ok: false, operation: "createPhoneCall", mode: "live", error: { code, message: "fixture", retryable: true }, providerRequestId: "req_fixture_2" });

// ---------------------------------------------------------------------------
// A. ROUTING COMES FROM CONFIGURATION, NEVER FROM A CALLER
// ---------------------------------------------------------------------------

describe("E-7B2A routing is configuration, not caller input", () => {
  it("refuses to construct without an agent and an outbound number", () => {
    assert.throws(() => createRetellAcquisitionProvider({ routing: {} }), /agentId must be a non-empty string/);
    assert.throws(() => createRetellAcquisitionProvider({ routing: { agentId: "a" } }), /fromNumber must be a non-empty string/);
    assert.throws(() => createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "03 5550 0001" } }), /fromNumber must be E\.164/);
    assert.throws(() => assertRetellRouting(null), /routing configuration is required/);
  });

  it("the execution cannot supply a from-number or an agent", () => {
    const payload = buildRetellCallPayload({
      execution: { ...EXECUTION, from_number: "+61399999999", override_agent_id: "agent_attacker", agentId: "agent_attacker" },
      routing: ROUTING,
    });
    assert.strictEqual(payload.from_number, ROUTING.fromNumber);
    assert.strictEqual(payload.override_agent_id, ROUTING.agentId);
  });
});

// ---------------------------------------------------------------------------
// H. THE EXACT PAYLOAD
// ---------------------------------------------------------------------------

describe("E-7B2A builds the exact Retell request", () => {
  it("binds the destination the gate cleared, and nothing else", () => {
    const payload = buildRetellCallPayload({ execution: EXECUTION, routing: ROUTING });
    assert.strictEqual(payload.to_number, NUMBER);
    assert.strictEqual(payload.from_number, ROUTING.fromNumber);
    assert.strictEqual(payload.override_agent_id, ROUTING.agentId);
  });

  it("carries correlation metadata, and no permission of any kind", () => {
    const payload = buildRetellCallPayload({ execution: EXECUTION, routing: ROUTING });
    assert.strictEqual(payload.metadata.aida_execution_id, EXECUTION.executionId);
    assert.strictEqual(payload.metadata.aida_prospect_id, EXECUTION.prospectId);
    assert.strictEqual(payload.metadata.aida_purpose, "locksmith_acquisition");

    const serialised = JSON.stringify(payload);
    for (const word of ["dncr", "suppress", "approved", "eligib", "permitted"]) {
      assert.ok(!serialised.toLowerCase().includes(word), `the payload must not carry ${word}`);
    }
  });

  it("is deterministic — the same execution always builds the same request", () => {
    const a = buildRetellCallPayload({ execution: EXECUTION, routing: ROUTING });
    const b = buildRetellCallPayload({ execution: EXECUTION, routing: ROUTING });
    assert.deepStrictEqual(a, b);
    assert.ok(Object.isFrozen(a));
  });

  it("refuses a missing, malformed or self-directed destination", () => {
    assert.throws(() => buildRetellCallPayload({ execution: { ...EXECUTION, destination: null }, routing: ROUTING }), /no usable E\.164/);
    assert.throws(() => buildRetellCallPayload({ execution: { ...EXECUTION, destination: "0355501042" }, routing: ROUTING }), /no usable E\.164/);
    assert.throws(
      () => buildRetellCallPayload({ execution: { ...EXECUTION, destination: ROUTING.fromNumber }, routing: ROUTING }),
      /destination is the outbound number/
    );
  });

  it("exposes the request a founder could read before anything is enabled", () => {
    const p = createRetellAcquisitionProvider({ routing: ROUTING });
    assert.strictEqual(p.describeSubmission(EXECUTION).to_number, NUMBER);
  });
});

// ---------------------------------------------------------------------------
// I. MOCKED RESPONSES
// ---------------------------------------------------------------------------

describe("E-7B2A maps every answer Retell can give", () => {
  it("success yields ONE call id, and says it is not evidence of contact", () => {
    const r = mapRetellResponse(okResponse("call_abc"));
    assert.strictEqual(r.status, PROVIDER_STATUS.ACCEPTED);
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(r.providerRef, "call_abc");
    assert.match(r.message, /NOT evidence that anybody was contacted/i);
  });

  it("a definitive refusal is a refusal — nothing rang", () => {
    for (const code of DEFINITIVE_FAILURE_CODES) {
      const r = mapRetellResponse(failResponse(code));
      assert.strictEqual(r.status, PROVIDER_STATUS.REFUSED, code);
      assert.strictEqual(r.accepted, false, code);
      assert.strictEqual(r.providerRef, null, code);
    }
  });

  it("an AMBIGUOUS answer is raised, never returned as a refusal", () => {
    for (const code of AMBIGUOUS_FAILURE_CODES) {
      assert.throws(() => mapRetellResponse(failResponse(code)), AmbiguousSubmission, code);
    }
  });

  it("an unrecognised failure code fails TOWARDS ambiguity", () => {
    assert.strictEqual(classifyProviderFailure("something_nobody_has_seen"), "ambiguous");
    assert.strictEqual(classifyProviderFailure(null), "ambiguous");
    assert.throws(() => mapRetellResponse(failResponse("brand_new_code")), AmbiguousSubmission);
  });

  it("success WITHOUT a call id is ambiguous, not accepted", () => {
    // A dispatch we cannot reconcile later is worse than one marked unknown,
    // because it looks settled.
    assert.throws(() => mapRetellResponse({ ok: true, resource: { id: null } }), /without a call id/);
  });

  it("an unrecognisable transport answer is ambiguous", () => {
    for (const junk of [null, undefined, "yes", 42]) {
      assert.throws(() => mapRetellResponse(junk), AmbiguousSubmission);
    }
  });

  it("the port's `retryable` flag is discarded, not propagated", () => {
    const r = mapRetellResponse(failResponse("invalid_request"));
    assert.ok(!("retryable" in r), "a retry hint must not reach the acquisition path");
  });
});

// ---------------------------------------------------------------------------
// C. NO AUTOMATIC RETRY
// ---------------------------------------------------------------------------

describe("E-7B2A never retries", () => {
  it("submits exactly once on success", async () => {
    const t = fakeTransport(okResponse());
    const p = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });
    await p.submit(EXECUTION);
    assert.strictEqual(t.calls.length, 1);
  });

  it("submits exactly once on a definitive refusal", async () => {
    const t = fakeTransport(failResponse("invalid_request"));
    const p = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });
    await p.submit(EXECUTION);
    assert.strictEqual(t.calls.length, 1);
  });

  it("submits exactly once on an AMBIGUOUS timeout — the case that matters", async () => {
    const t = fakeTransport(failResponse("provider_timeout"));
    const p = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });
    await assert.rejects(() => p.submit(EXECUTION), AmbiguousSubmission);
    assert.strictEqual(t.calls.length, 1, "a timeout must never be tried again — it may already have rung");
  });

  it("contains no retry, backoff, timer or loop", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-retell-provider.js"), "utf8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");
    for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bwhile\s*\(/, /\bfor\s*\(/]) {
      assert.ok(!p.test(code), `the provider must contain no ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. BINDING THE CALL ID TO THE DURABLE DISPATCH
// ---------------------------------------------------------------------------

describe("E-7B2A binds a Retell call id to the dispatch, through LAQ5's own fields", () => {
  it("an accepted call writes provider_ref and leaves the dispatch UNRESOLVED", async () => {
    const store = await storeWithCalling("enabled");
    const d = await authorise(store, mkProspect());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: fakeTransport(okResponse("call_bound_001")) });

    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.SUBMITTED, r.message);
    assert.strictEqual(r.providerRef, "call_bound_001");

    const rows = await store.listDialExecutions({});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].dispatchId, d.dial.dispatchId, "one dispatchId");
    assert.strictEqual(rows[0].providerRef, "call_bound_001", "at most one recorded call id");
    assert.strictEqual(rows[0].providerStatus, "submitted");
    assert.strictEqual(rows[0].resolvedAt, null, "a provider result NEVER resolves a dispatch");

    const open = await listUnresolvedDispatches({ store, now: now() });
    assert.strictEqual(open.count, 1, "the locks are still held");
    assert.strictEqual(open.dispatches[0].holdsProspectLock, true);
    assert.strictEqual(open.dispatches[0].holdsDestinationLock, true);
  });

  it("an AMBIGUOUS submission records unknown, no call id, and stays unresolved", async () => {
    const store = await storeWithCalling("enabled");
    const d = await authorise(store, mkProspect());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: fakeTransport(failResponse("provider_timeout")) });

    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.PROVIDER_FAILED);
    assert.match(r.message, /UNKNOWN/);

    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.providerStatus, "unknown");
    assert.strictEqual(row.providerRef, null);
    assert.strictEqual(row.resolvedAt, null, "an unknown dispatch keeps its locks until a human resolves it");
  });

  it("a definitive refusal records refused and still keeps the locks", async () => {
    const store = await storeWithCalling("enabled");
    const d = await authorise(store, mkProspect());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: fakeTransport(failResponse("invalid_request")) });

    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.PROVIDER_REFUSED);
    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.providerStatus, "refused");
    assert.strictEqual(row.resolvedAt, null);
  });

  it("one authorisation permits at most one submission, even with a working provider", async () => {
    const store = await storeWithCalling("enabled");
    const d = await authorise(store, mkProspect());
    const t = fakeTransport(okResponse());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });

    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    const again = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(again.status, EXECUTION_CODES.AUTHORISATION_CONSUMED);
    assert.strictEqual(t.calls.length, 1, "exactly one Retell submission per authorisation");
  });

  it("ten concurrent executions of one slip produce ONE submission", async () => {
    const store = await storeWithCalling("enabled");
    const d = await authorise(store, mkProspect());
    const t = fakeTransport(okResponse());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });

    await Promise.all(Array.from({ length: 10 }, () => executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() })));
    assert.strictEqual(t.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// J. THE DURABLE STOP OUTRANKS A PERFECTLY GOOD PROVIDER
// ---------------------------------------------------------------------------

describe("E-7B2A cannot submit while acquisition calling is paused", () => {
  it("a paused stop yields ZERO Retell submissions", async () => {
    const store = await storeWithCalling("enabled");
    const d = await authorise(store, mkProspect());

    // Authorised while enabled, then stopped before execution — the exact
    // sequence the second stop read exists for.
    await store.writeCallingState({ state: "paused", revision: 2, changedBy: "Peter Dang", changedAt: ISO, reason: "stop" });

    const t = fakeTransport(okResponse());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(t.calls.length, 0, "a paused stop must reach the provider before the provider reaches Retell");
    assert.strictEqual((await store.listDialExecutions({})).length, 0, "and nothing may be claimed");
  });

  it("a missing calling-state row also yields zero submissions", async () => {
    const store = createInMemoryAcquisitionStore();
    await store.writeCallingState({ state: "enabled", revision: 1, changedBy: "h", changedAt: ISO, reason: "t" });
    const d = await authorise(store, mkProspect());
    const bare = Object.freeze({ ...store, readCallingState: async () => null });

    const t = fakeTransport(okResponse());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });
    const r = await executeAuthorisedDial({ store: bare, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(t.calls.length, 0);
  });

  it("a caller cannot supply a stop to talk past the durable one", async () => {
    const store = await storeWithCalling("paused");
    const d = await authorise(await storeWithCalling("enabled"), mkProspect());
    const t = fakeTransport(okResponse());
    const provider = createRetellAcquisitionProvider({ routing: ROUTING, transport: t });
    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now(), killSwitch: () => ({ engaged: false }) });
    assert.strictEqual(r.status, EXECUTION_CODES.CALLER_OVERRIDE_REJECTED);
    assert.strictEqual(t.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// K. LIVE-CALL IMPOSSIBILITY — THE RATCHETS THAT KEEP E-7 CLOSED
// ---------------------------------------------------------------------------

describe("E-7B2A cannot call anybody", () => {
  const FILE = path.join(__dirname, "..", "src", "services", "acquisition-retell-provider.js");
  const src = fs.readFileSync(FILE, "utf8");
  const code = src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");

  it("the provider states live: false, with or without a transport", () => {
    assert.strictEqual(createRetellAcquisitionProvider({ routing: ROUTING }).live, false);
    assert.strictEqual(createRetellAcquisitionProvider({ routing: ROUTING, transport: fakeTransport(okResponse()) }).live, false);
  });

  it("live is not a parameter — a caller cannot ask for a live provider", () => {
    const p = createRetellAcquisitionProvider({ routing: ROUTING, live: true, transport: fakeTransport(okResponse()) });
    assert.strictEqual(p.live, false);
    assert.ok(Object.isFrozen(p));
  });

  it("no transport, client, host or endpoint appears in the code", () => {
    for (const pattern of [
      /\bfetch\s*\(/,
      /require\(["'](twilio|axios|got|node-fetch|superagent|request|undici|retell-sdk|@retell)/,
      /require\(["']node:(http|https|net|dgram|tls)["']\)/,
      /require\(["'](http|https|net|dgram|tls)["']\)/,
      /child_process/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /https?:\/\//,
      /create-phone-call/,
    ]) {
      assert.ok(!pattern.test(code), `the provider must not contain ${pattern}`);
    }
  });

  it("it imports only local acquisition modules", () => {
    const requires = [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    assert.ok(requires.length > 0);
    for (const r of requires) {
      assert.ok(r.startsWith("./"), `the provider may not import ${r}`);
    }
    // Specifically: not the runtime's live Retell transport.
    assert.ok(!requires.includes("./retell-adapter"), "the acquisition provider must not import the live Retell adapter");
  });

  it("it reads no environment and holds no credential", () => {
    assert.ok(!/process\.env/.test(src), "the provider must not read the environment");
    for (const secret of ["API_KEY", "AUTH_TOKEN", "ACCOUNT_SID", "apiKey", "accountSid", "authToken", "credential", "Bearer"]) {
      assert.ok(!code.includes(secret), `the provider must not reference ${secret} in code`);
    }
  });

  it("without a transport it refuses, and says the means is deliberately absent", async () => {
    const p = createRetellAcquisitionProvider({ routing: ROUTING });
    const r = await p.submit(EXECUTION);
    assert.strictEqual(r.status, PROVIDER_STATUS.REFUSED);
    assert.strictEqual(r.reason, "acquisition_retell_transport_absent");
    assert.strictEqual(r.providerRef, null);
  });

  it("nothing in the acquisition path constructs a transport for it", () => {
    const dir = path.join(__dirname, "..", "src", "services");
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("acquisition-") && n.endsWith(".js"))) {
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      if (/createRetellAcquisitionProvider\s*\(/.test(body) && f !== "acquisition-retell-provider.js") {
        offenders.push(f);
      }
      if (/require\(["']\.\/retell-adapter["']\)/.test(body)) offenders.push(`${f} imports the live adapter`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join("; "));
  });

  it("the E-7A provider registry is untouched — still only disabled and fake", () => {
    const mod = require("../src/services/acquisition-dial-provider");
    const names = Object.keys(mod).filter((k) => /^create/.test(k)).sort();
    assert.deepStrictEqual(names, ["createDisabledDialProvider", "createFakeDialProvider"]);
  });
});
