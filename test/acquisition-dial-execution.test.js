// LOCKSMITH ACQUISITION E-7A — the provider-disabled dial execution seam.
//
// E-7A answers one question: if M8E mints a genuine permission slip, what is
// allowed to consume it and ask for a call? And it answers it while remaining
// incapable of calling anybody.
//
// So this file has two jobs. It proves the seam WORKS against an offline fake —
// one authorisation, one submission, the right number — and it proves the seam
// CANNOT REACH A HUMAN BEING: no live provider, no network, no credentials, no
// contact outcome, no retry.
//
// The collaborators are the real modules. A test that faked the authorisation
// gate would prove nothing about what the executor refuses, since refusing
// things that did not come from that gate is the entire point.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createDialAuthoriser, isAuthorisedDial, isGenuineAuthorisedDial } = require("../src/services/acquisition-authorisation");
const { ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect, identityFingerprint } = require("../src/services/acquisition-prospect");
const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
const { FOUNDER_CALLING_POLICY } = require("../src/services/acquisition-calling-approval");
const { createAuditLog } = require("../src/services/acquisition-audit");
const { pauseAcquisitionCalling, enableAcquisitionCalling, readCallingState, STATE_CODES } = require("../src/services/acquisition-calling-state");

const {
  executeAuthorisedDial,
  createAcquisitionDialExecutor,
  EXECUTION_CODES,
  FORBIDDEN_OPTION_KEYS,
  DEFAULT_MAX_AGE_MS,
} = require("../src/services/acquisition-dial-execution");

const {
  createDisabledDialProvider,
  createFakeDialProvider,
  assertDialProvider,
  PROVIDER_DISABLED,
  PROVIDER_STATUS,
} = require("../src/services/acquisition-dial-provider");

const MELBOURNE = "Australia/Melbourne";
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";
const SUBSTITUTE = "+61355509911";

const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

function goodProspect() {
  const built = createProspect({
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: MELBOURNE,
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  });
  let p = built.prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: "Peter", reason: "test", now: now() }).prospect;
  }
  return p;
}

function evidenceFor(prospect, clock) {
  const ledger = createEvidenceLedger({ now: clock });
  const source = { url: "https://northsidelockandkey.example.com.au/contact" };
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0].raw],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "test", source });
  }
  return ledger.forProspect(prospect.prospectId);
}

async function approveBatchIn(store, prospect, clock) {
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({
    members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164: NUMBER }],
    label: "e7a test batch",
  });
  const r = await recordBatchApproval({ store, now: clock, identity, approvedBy: "Peter Dang", reason: "Approved for the E-7A tests." });
  assert.strictEqual(r.ok, true, r.message);
  return identity;
}

/**
 * Everything wired and permitted, so a genuine slip comes out the far end.
 *
 * `washed`, `holidays` and `suppress` are the knobs the compliance tests turn:
 * each one should stop a slip ever existing, which is the strongest possible
 * statement about the executor — it is not that it refuses, it is that there is
 * nothing to hand it.
 */
async function mintGenuineSlip({ iso = WEDNESDAY_2PM, washed = true, holidays = null, approveBatch = true, suppress = false, persistProspect = true, killSwitchEngaged = false, calling = "enabled" } = {}) {
  const clock = now(iso);
  const store = createInMemoryAcquisitionStore();
  const prospect = goodProspect();
  const evidenceRows = evidenceFor(prospect, clock);

  // E-7B1. The durable emergency stop. An in-memory store starts with NO
  // calling-state row at all, modelling a database where laq5 has not run — and
  // the executor blocks on that. A test that wants a call to proceed has to say
  // so, which is the right way round.
  if (calling !== "missing") {
    await store.writeCallingState({
      state: calling,
      revision: 1,
      changedBy: "e7b1 test harness",
      changedAt: new Date(iso).toISOString(),
      reason: `Calling ${calling} for this test.`,
    });
  }

  const washStore = createWashStore({ now: clock, mode: "fixture" });
  if (washed) washStore.wash(NUMBER);

  if (persistProspect) await store.upsertProspect(prospect);
  if (approveBatch) await approveBatchIn(store, prospect, clock);

  if (suppress) {
    await store.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" }),
      e164: NUMBER,
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
      suppressedAt: new Date(iso).toISOString(),
    });
  }

  const duplicateResolution = resolveDuplicates([{ ...prospect, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]);

  const engineOptions = {
    washStore,
    holidays: holidays || createFixtureHolidayProvider(),
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
    callingPolicyApproval: FOUNDER_CALLING_POLICY,
  };

  const context = { evidenceRows, duplicateResolution };
  if (killSwitchEngaged) context.campaign = { id: "pilot", killSwitchEngaged: true };

  // The gate builds its own engine from these collaborators and binds the
  // authoritative suppression list itself — it will not accept a pre-built one.
  const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);

  return { decision, store, clock, prospect, engineOptions, context };
}

// ---------------------------------------------------------------------------
// M. THE OFFLINE END-TO-END PROOF
// ---------------------------------------------------------------------------

describe("E-7A end to end: a genuine authorisation reaches a fake provider, and nothing else happens", () => {
  it("1-7. an eligible fictional prospect is authorised, executed once, and contacts nobody", async () => {
    const { decision, clock, store } = await mintGenuineSlip();

    // 1-3. M8E minted a genuine slip against durable state.
    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    assert.strictEqual(decision.suppressionSource, "durable");
    assert.strictEqual(decision.historySource, "durable");
    assert.strictEqual(decision.batchSource, "durable");
    assert.strictEqual(decision.duplicateSource, "durable");
    assert.ok(isGenuineAuthorisedDial(decision.dial), "the gate must mint a genuine slip");

    // 4-5. The executor accepts it and the provider sees exactly one destination.
    const provider = createFakeDialProvider();
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.status, EXECUTION_CODES.SUBMITTED);
    assert.strictEqual(provider.submissionCount(), 1, "exactly one submission");
    assert.strictEqual(provider.submissions[0].destination, NUMBER);
    assert.strictEqual(provider.submissions[0].prospectId, decision.prospectId);

    // 6. The result records a fake execution, and says whose it was.
    assert.strictEqual(result.provider, "fake");
    assert.strictEqual(result.providerLive, false);
    assert.strictEqual(result.destination, NUMBER);
    assert.ok(result.executionId.startsWith("ex_"));
    assert.ok(result.providerRef.startsWith("fake_"));
    assert.strictEqual(result.authorisedAt, decision.dial.authorisedAt);

    // 7. NO CONTACT OUTCOME. Not stated in the result, not implied by it.
    assert.strictEqual("outcome" in result, false);
    assert.strictEqual("attempt" in result, false);
    assert.strictEqual("contacted" in result, false);
    assert.match(result.note, /No contact outcome is implied or recorded/);
  });

  it("the provider is handed nothing it could reinterpret as permission", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();
    await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    const submitted = provider.submissions[0];
    // A CLOSED WORLD, deliberately. Widening it is how a provider quietly
    // acquires something it can reinterpret, so the list is exact and every
    // addition has to be argued for here.
    //
    // dispatchId was added by the E-7B2A correlation fix. It is an IDENTITY,
    // not a permission: it names which durable row this attempt belongs to, it
    // is the key a provider's own webhook must echo back for a lost response to
    // be reconcilable, and knowing it grants nothing — the locks are held by
    // the row, the row is written by the executor, and no provider result can
    // release it. See acquisition-retell-provider.js.
    assert.deepStrictEqual(
      Object.keys(submitted).sort(),
      ["authorisedAt", "businessName", "destination", "dispatchId", "executionId", "metadata", "prospectId"].sort()
    );
    assert.strictEqual(submitted.dispatchId, decision.dial.dispatchId, "verbatim off the slip — never derived");
    for (const forbidden of ["authorised", "approved", "eligible", "suppressed", "dncr", "batch", "duplicateResolution", "callingPolicy", "eligibility"]) {
      assert.strictEqual(forbidden in submitted, false, `a provider must not receive ${forbidden}`);
    }
    assert.ok(Object.isFrozen(submitted), "the execution record must be frozen");
  });
});

// ---------------------------------------------------------------------------
// A. AUTHORISED-DIAL-ONLY ENTRY — forgery
// ---------------------------------------------------------------------------

describe("E-7A refuses anything that is not a slip M8E minted", () => {
  const forgeries = () => {
    const { AUTHORISED_DIAL } = require("../src/services/acquisition-authorisation");
    return {
      "a plain object asserting permission": { authorised: true, prospectId: "pr_x", e164: NUMBER },
      "a hand-made lookalike": { kind: "authorised-dial", prospectId: "pr_x", e164: NUMBER, authorisedAt: new Date(WEDNESDAY_2PM).toISOString() },
      "one branded with the exported symbol": { [AUTHORISED_DIAL]: true, kind: "authorised-dial", prospectId: "pr_x", e164: NUMBER, authorisedAt: new Date(WEDNESDAY_2PM).toISOString() },
      null: null,
      "a boolean": true,
      "a string": "authorised",
    };
  };

  it("8. every forged capability is refused", async () => {
    // A fully permitted world — durable stop enabled, nothing in flight — so a
    // forgery is refused on its own merits and not incidentally by some other gate.
    const { clock, store } = await mintGenuineSlip();
    for (const [label, forged] of Object.entries(forgeries())) {
      const provider = createFakeDialProvider();
      const result = await executeAuthorisedDial({ store, authorisedDial: forged, provider, now: clock });
      assert.strictEqual(result.ok, false, `${label} must not execute`);
      assert.strictEqual(result.status, EXECUTION_CODES.AUTHORISATION_INVALID, label);
      assert.strictEqual(provider.submissionCount(), 0, `${label} must not reach a provider`);
    }
  });

  /**
   * THE ONE THE OLD BRAND CHECK GOT WRONG.
   *
   * Object spread copies own symbol properties, so a spread clone of a genuine
   * slip carried the brand — and, being a fresh object, was not frozen. That is
   * a mutable object which `isAuthorisedDial` called genuine, and its
   * destination could be rewritten. E-7A executes on identity instead.
   */
  it("9. copies of a genuine slip are refused — spread, assign, JSON, structuredClone", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const genuine = decision.dial;

    const copies = {
      "a spread clone": { ...genuine },
      "an Object.assign copy": Object.assign({}, genuine),
      "a JSON round-trip": JSON.parse(JSON.stringify(genuine)),
      "a structuredClone": structuredClone(genuine),
      "a hand-copied property set": {
        kind: genuine.kind,
        authorisationId: genuine.authorisationId,
        prospectId: genuine.prospectId,
        businessName: genuine.businessName,
        e164: genuine.e164,
        authorisedAt: genuine.authorisedAt,
        decision: genuine.decision,
      },
    };

    for (const [label, copy] of Object.entries(copies)) {
      assert.strictEqual(isGenuineAuthorisedDial(copy), false, `${label} must not be genuine`);
      const provider = createFakeDialProvider();
      const result = await executeAuthorisedDial({ store, authorisedDial: copy, provider, now: clock });
      assert.strictEqual(result.status, EXECUTION_CODES.AUTHORISATION_INVALID, label);
      assert.strictEqual(provider.submissionCount(), 0, `${label} must not reach a provider`);
    }

    // And the genuine one still works, so this is a real distinction rather
    // than a check that refuses everything.
    const provider = createFakeDialProvider();
    assert.strictEqual((await executeAuthorisedDial({ store, authorisedDial: genuine, provider, now: clock })).ok, true);
  });

  it("the brand check still means what it always meant, and is no longer the authority", async () => {
    const { decision, store } = await mintGenuineSlip();
    const clone = { ...decision.dial };
    // Documented honestly: the brand survives a copy...
    assert.strictEqual(isAuthorisedDial(clone), true, "spread does copy own symbols — this is why identity is checked");
    // ...and identity does not.
    assert.strictEqual(isGenuineAuthorisedDial(clone), false);
  });
});

// ---------------------------------------------------------------------------
// B. BINDING — no substitution, no caller override
// ---------------------------------------------------------------------------

describe("E-7A binds the destination to the authorisation", () => {
  it("10. a caller cannot substitute the destination", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();

    const result = await executeAuthorisedDial({
      authorisedDial: decision.dial,
      provider,
      now: clock,
      destination: SUBSTITUTE,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.CALLER_OVERRIDE_REJECTED);
    assert.strictEqual(provider.submissionCount(), 0, "a substitution attempt must not reach a provider");
  });

  it("the genuine slip is frozen, so its destination cannot be rewritten in place", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    assert.ok(Object.isFrozen(decision.dial));

    assert.throws(() => {
      "use strict";
      decision.dial.e164 = SUBSTITUTE;
    }, TypeError);

    const provider = createFakeDialProvider();
    await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });
    assert.strictEqual(provider.submissions[0].destination, NUMBER, "the cleared number is the only one dialled");
  });

  it("every compliance answer a caller might assert is refused, not ignored", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    for (const key of FORBIDDEN_OPTION_KEYS) {
      const provider = createFakeDialProvider();
      const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock, [key]: true });
      assert.strictEqual(result.status, EXECUTION_CODES.CALLER_OVERRIDE_REJECTED, `${key} must be refused`);
      assert.strictEqual(provider.submissionCount(), 0);
    }
  });

  it("the forbidden list covers every substitute E-5 and M8L took away", () => {
    for (const key of ["batch", "duplicateResolution", "suppressed", "dncr", "callingPolicy", "destination", "e164", "prospectId"]) {
      assert.ok(FORBIDDEN_OPTION_KEYS.includes(key), `${key} must be refusable`);
    }
  });
});

// ---------------------------------------------------------------------------
// C + O. SINGLE EXECUTION, REPLAY, CONCURRENCY
// ---------------------------------------------------------------------------

describe("E-7A spends an authorisation exactly once", () => {
  it("11. the same capability executed twice is refused the second time", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();

    const first = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });
    const second = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.status, EXECUTION_CODES.AUTHORISATION_CONSUMED);
    assert.strictEqual(provider.submissionCount(), 1, "one authorisation, one submission");
  });

  it("a refusal still spends it — a disabled provider is not a free retry", async () => {
    const { decision, clock, store } = await mintGenuineSlip();

    const refused = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createDisabledDialProvider(), now: clock });
    assert.strictEqual(refused.status, EXECUTION_CODES.PROVIDER_REFUSED);

    // Somebody enables a fake provider and retries the same slip.
    const provider = createFakeDialProvider();
    const retried = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });
    assert.strictEqual(retried.status, EXECUTION_CODES.AUTHORISATION_CONSUMED);
    assert.strictEqual(provider.submissionCount(), 0);
  });

  /**
   * O. CONCURRENCY, and why this is a real guarantee rather than a hopeful one.
   *
   * Both calls are started before either is awaited, so both enter the function
   * on the same tick. The claim is made synchronously before the first await,
   * so exactly one can find the slip unclaimed.
   */
  it("12. two concurrent executions of one slip produce at most one submission", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();

    const [a, b] = await Promise.all([
      executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock }),
      executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock }),
    ]);

    const ok = [a, b].filter((r) => r.ok);
    const consumed = [a, b].filter((r) => r.status === EXECUTION_CODES.AUTHORISATION_CONSUMED);
    assert.strictEqual(ok.length, 1, "exactly one may succeed");
    assert.strictEqual(consumed.length, 1, "the other must be refused as already consumed");
    assert.strictEqual(provider.submissionCount(), 1, "AT MOST ONE provider invocation");
  });

  it("ten concurrent executions still produce one submission", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock }))
    );

    assert.strictEqual(results.filter((r) => r.ok).length, 1);
    assert.strictEqual(provider.submissionCount(), 1);
  });

  /**
   * ── THE LIMITATION E-7A PINNED, NOW CLOSED BY E-7B1 ─────────────────
   *
   * This assertion used to say single-consumption was PROCESS-LOCAL and demand
   * the source say so. That was true and honest for E-7A, and it is now wrong:
   * the durable claim in acquisition-dispatch-store is arbitrated by Postgres,
   * so a second process loses to a 23505 rather than to anything this process
   * remembers.
   *
   * It is restated rather than deleted, because the in-process WeakSet is still
   * there and still doing the cheap half of the job — and somebody reading it
   * should be told it is no longer the only half.
   */
  it("13. single use is enforced in TWO layers, one of which survives a restart", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dial-execution.js"), "utf8");

    // The cheap layer, unchanged.
    assert.match(src, /new WeakSet\(\)/, "the in-process claim is still there");
    assert.match(src, /SYNCHRONOUSLY BEFORE ANY AWAIT|SYNCHRONOUSLY, BEFORE ANY AWAIT/i);

    // The durable layer, and the file must say the old limitation is closed.
    assert.match(src, /claimAuthorisedDial/, "the executor must make a durable claim");
    assert.match(src, /E-7A's process-local limitation is CLOSED by the durable half/);

    // The executor still writes no business state of its own: the only durable
    // writes it makes are the dispatch claim and the provider status on it.
    for (const forbidden of ["appendDecision", "appendOutcome", "upsertProspect", "appendSuppression", "supabase"]) {
      assert.ok(!src.includes(forbidden), `the executor must not write ${forbidden}`);
    }
  });

  /**
   * The durable half, exercised. This is the case E-7A could not close: two
   * SEPARATE executor instances, each with its own module state, both handed
   * their own genuine authorisation for the same business.
   */
  it("14. two different authorisations for one prospect — only one may claim", async () => {
    const { decision, clock, store, prospect, engineOptions, context } = await mintGenuineSlip();

    // A second, genuinely distinct authorisation of the same business. Same
    // millisecond, so the derived fingerprints collide and only the random
    // dispatchId tells them apart.
    const second = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(second.authorised, true);
    assert.strictEqual(second.dial.authorisationId, decision.dial.authorisationId, "same fingerprint");
    assert.notStrictEqual(second.dial.dispatchId, decision.dial.dispatchId, "different durable identity");

    const p1 = createFakeDialProvider();
    const p2 = createFakeDialProvider();
    const first = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: p1, now: clock });
    const rival = await executeAuthorisedDial({ store, authorisedDial: second.dial, provider: p2, now: clock });

    assert.strictEqual(first.ok, true, first.message);
    assert.strictEqual(rival.ok, false);
    assert.strictEqual(rival.status, EXECUTION_CODES.DISPATCH_CONFLICT);
    assert.strictEqual(rival.conflictScope, "prospect");
    assert.strictEqual(p1.submissionCount(), 1);
    assert.strictEqual(p2.submissionCount(), 0, "the second authorisation must never reach a provider");
  });
});

// ---------------------------------------------------------------------------
// D. TOCTOU / EXPIRY
// ---------------------------------------------------------------------------

describe("E-7A does not let an authorisation become a long-lived permission token", () => {
  it("a slip executed immediately is accepted", async () => {
    const { decision, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: now(WEDNESDAY_2PM) });
    assert.strictEqual(result.ok, true);
  });

  it("a stale slip is refused, and says so as an expiry rather than a compliance failure", async () => {
    const { decision, store } = await mintGenuineSlip();
    const later = () => new Date(Date.parse(WEDNESDAY_2PM) + DEFAULT_MAX_AGE_MS + 1000);
    const provider = createFakeDialProvider();

    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: later });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.AUTHORISATION_EXPIRED);
    assert.strictEqual(provider.submissionCount(), 0);
    assert.match(result.message, /somebody can opt out in a minute/);
  });

  it("the boundary is inclusive at maxAgeMs and refuses past it", async () => {
    const at = (ms) => () => new Date(Date.parse(WEDNESDAY_2PM) + ms);

    const justInside = await mintGenuineSlip();
    assert.strictEqual((await executeAuthorisedDial({ store: justInside.store, authorisedDial: justInside.decision.dial, provider: createFakeDialProvider(), now: at(DEFAULT_MAX_AGE_MS) })).ok, true);

    const justOutside = await mintGenuineSlip();
    assert.strictEqual(
      (await executeAuthorisedDial({ store: justOutside.store, authorisedDial: justOutside.decision.dial, provider: createFakeDialProvider(), now: at(DEFAULT_MAX_AGE_MS + 1) })).status,
      EXECUTION_CODES.AUTHORISATION_EXPIRED
    );
  });

  it("a slip from the future is refused rather than treated as fresh", async () => {
    const { decision, store } = await mintGenuineSlip();
    const earlier = () => new Date(Date.parse(WEDNESDAY_2PM) - 5000);
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createFakeDialProvider(), now: earlier });
    assert.strictEqual(result.status, EXECUTION_CODES.AUTHORISATION_EXPIRED);
  });

  it("the default window is a minute, and it is stated rather than buried", () => {
    assert.strictEqual(DEFAULT_MAX_AGE_MS, 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// F + G + Q. PROVIDERS, DEFAULT SAFETY, LIVE-CALL IMPOSSIBILITY
// ---------------------------------------------------------------------------

describe("E-7A cannot place a live call", () => {
  it("14. the disabled provider refuses explicitly, and is distinct from a compliance refusal", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createDisabledDialProvider(), now: clock });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.PROVIDER_REFUSED);
    assert.strictEqual(result.provider, "disabled");
    // The compliance answer was YES. Only the mechanism said no.
    assert.notStrictEqual(result.status, ELIGIBILITY_CODES.SUPPRESSED);
    assert.match(result.message, /Compliance may well have permitted this call/);
  });

  it("the disabled provider's refusal reason is the documented code", () => {
    const r = createDisabledDialProvider().submit({ executionId: "ex_x", destination: NUMBER });
    assert.strictEqual(r.reason, PROVIDER_DISABLED);
    assert.strictEqual(r.reason, "acquisition_provider_disabled");
    assert.strictEqual(r.accepted, false);
  });

  /** G. THE DEFAULT. Nothing has to be configured for calling to be off. */
  it("15. the default executor is the disabled one", () => {
    const executor = createAcquisitionDialExecutor({ now: now() });
    assert.strictEqual(executor.providerName, "disabled");
    assert.strictEqual(executor.providerLive, false);
  });

  it("the default executor refuses a genuine slip even with everything else permitted", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const executor = createAcquisitionDialExecutor({ now: clock, store });
    const result = await executor.execute(decision.dial);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.PROVIDER_REFUSED);
    assert.strictEqual(result.dispatchClaimed, true, "it got all the way to the provider, and the provider said no");
  });

  it("the default executor is not live-capable", () => {
    assert.strictEqual(createAcquisitionDialExecutor({ now: now() }).liveCapable, false);
  });

  /**
   * Q. THE LIVE-CALL IMPOSSIBILITY RATCHET.
   *
   * Every provider this repository can construct must state live: false. If
   * somebody adds a real adapter, they must either mark it live — and fail here
   * — or lie in the source, which is a different conversation and a visible one.
   */
  it("16. every constructible provider states live: false", () => {
    const providers = [createDisabledDialProvider(), createFakeDialProvider(), createFakeDialProvider({ behaviour: "refuse" })];
    for (const p of providers) {
      assert.strictEqual(p.live, false, `${p.name} must not be live`);
      assert.ok(Object.isFrozen(p), `${p.name} must be frozen`);
    }
  });

  it("no provider factory in the repository yields a live provider", () => {
    const mod = require("../src/services/acquisition-dial-provider");
    const factories = Object.entries(mod).filter(([, v]) => typeof v === "function" && /^create/.test(String(v.name)));
    assert.ok(factories.length >= 2, "the two E-7A providers must be constructible");
    for (const [name, factory] of factories) {
      assert.strictEqual(factory().live, false, `${name} must not produce a live provider`);
    }
  });

  it("a provider must state whether it is live, and one that will not is rejected", () => {
    assert.throws(() => assertDialProvider({ name: "sneaky", submit: () => {} }), /missing live|live must be stated/);
    assert.throws(() => assertDialProvider({ name: "sneaky", live: "no", submit: () => {} }), /live must be stated/);
    assert.throws(() => assertDialProvider(null), /a provider is required/);
  });

  /**
   * G. No environment variable may switch calling on.
   *
   * Checked against CODE, with comments stripped, because both files talk about
   * credentials at length in order to say they never read any. A ratchet that
   * banned the word would forbid documenting the invariant it exists to keep.
   */
  it("17. no environment variable or credential can activate calling", () => {
    for (const file of ["acquisition-dial-execution.js", "acquisition-dial-provider.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", file), "utf8");
      // Not even in a comment: nothing here should ever mention reading it.
      assert.ok(!/process\.env/.test(src), `${file} must not read the environment`);

      const code = src
        .split("\n")
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      for (const secret of ["API_KEY", "AUTH_TOKEN", "ACCOUNT_SID", "apiKey", "accountSid", "authToken", "credential", "Bearer"]) {
        assert.ok(!code.includes(secret), `${file} must not reference ${secret} in code`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P. NETWORK RATCHETS
// ---------------------------------------------------------------------------

describe("E-7A reaches no network", () => {
  const E7A_FILES = ["acquisition-dial-execution.js", "acquisition-dial-provider.js"];
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");

  /** Comments are stripped, so prose about Twilio is not mistaken for a client. */
  const codeOf = (src) =>
    src
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");

  it("18. no transport, client or provider URL appears in the execution path", () => {
    const offenders = [];
    for (const f of E7A_FILES) {
      const code = codeOf(read(f));
      const patterns = [
        /\bfetch\s*\(/,
        /require\(["'](twilio|axios|got|node-fetch|superagent|request|undici|nodemailer|retell-sdk|@retell)/,
        /\bhttps?\.request\s*\(/,
        /\bhttps?\.get\s*\(/,
        /require\(["']node:(http|https|net|dgram|tls)["']\)/,
        /require\(["'](http|https|net|dgram|tls)["']\)/,
        /child_process/,
        /\bXMLHttpRequest\b/,
        /\bWebSocket\b/,
        /https?:\/\//,
        /\bcalls\.create\s*\(/,
        /\bmessages\.create\s*\(/,
      ];
      for (const p of patterns) if (p.test(code)) offenders.push(`${f}: ${p}`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join("; "));
  });

  it("the execution path imports only local acquisition modules and node:crypto", () => {
    for (const f of E7A_FILES) {
      const requires = [...read(f).matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
      for (const r of requires) {
        assert.ok(r.startsWith("./") || r === "node:crypto", `${f} may not import ${r}`);
      }
    }
  });

  it("the provider registry contains only fake and disabled implementations", () => {
    const mod = require("../src/services/acquisition-dial-provider");
    const names = Object.keys(mod).filter((k) => /^create/.test(k)).sort();
    assert.deepStrictEqual(names, ["createDisabledDialProvider", "createFakeDialProvider"]);
  });
});

// ---------------------------------------------------------------------------
// N. NO AUTOMATIC RETRY
// ---------------------------------------------------------------------------

describe("E-7A never retries", () => {
  it("19. a provider exception becomes an explicit uncertain failure, submitted once", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider({ behaviour: "throw" });

    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.PROVIDER_FAILED);
    assert.strictEqual(result.providerStatus, "unknown", "an ambiguous failure must be reported as unknown");
    assert.strictEqual(provider.submissionCount(), 1, "exactly one provider invocation, and NO retry");
    assert.match(result.message, /was not retried/);
  });

  it("a provider refusal is not retried either", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider({ behaviour: "refuse" });
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(result.status, EXECUTION_CODES.PROVIDER_REFUSED);
    assert.strictEqual(provider.submissionCount(), 1);
  });

  it("there is no retry, backoff or attempt loop in the execution path", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dial-execution.js"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
    for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bwhile\s*\(/, /\bfor\s*\(/]) {
      assert.ok(!p.test(code), `the execution path must contain no ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// K. KILL SWITCH
// ---------------------------------------------------------------------------

describe("E-7A honours an emergency stop at execution time", () => {
  /**
   * ── CHANGED BY E-7B1 ────────────────────────────────────────────────
   *
   * The stop used to be a function a CALLER passed in, which meant a caller who
   * omitted it got no emergency stop at all. It is now read from the store by
   * the executor itself, twice, and a caller who still passes one is REFUSED
   * rather than quietly ignored — because silently dropping it would look
   * exactly like it being honoured.
   */
  it("a caller can no longer supply the emergency stop at all", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();

    const result = await executeAuthorisedDial({
      store,
      authorisedDial: decision.dial,
      provider,
      now: clock,
      killSwitch: () => ({ engaged: false }),
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.CALLER_OVERRIDE_REJECTED);
    assert.strictEqual(provider.submissionCount(), 0);
  });

  it("a durable stop engaged AFTER authorisation still stops the call", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();

    // The slip is genuine and current. The founder pauses a moment later.
    const paused = await pauseAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "Founder stopped the pilot.", now: clock });
    assert.strictEqual(paused.ok, true, paused.message);

    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.KILL_SWITCH);
    assert.strictEqual(provider.submissionCount(), 0, "a stop must be enforced BEFORE the provider");
    assert.match(result.message, /Founder stopped the pilot/);
    assert.match(result.message, /No authorisation was spent/);
  });

  it("it reuses the engine's own kill-switch code rather than inventing a second one", () => {
    assert.strictEqual(EXECUTION_CODES.KILL_SWITCH, ELIGIBILITY_CODES.KILL_SWITCH);
    assert.strictEqual(EXECUTION_CODES.KILL_SWITCH, "kill_switch_engaged");
  });

  it("an enabled durable state permits execution, so the check is real", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const provider = createFakeDialProvider();
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(provider.submissionCount(), 1);
  });

  /**
   * THE ONE THAT MATTERS MOST, AND THE REASON THE STOP IS READ TWICE.
   *
   * Enabled at the preflight, paused before the final read. The claim has
   * already been made durably by then, so the dispatch stays claimed and
   * unresolved — holding its locks — and no provider is reached.
   */
  it("paused BETWEEN the preflight and the final read — no call, and the claim stays held", async () => {
    const { decision, clock, store } = await mintGenuineSlip();

    // A provider that pauses calling the instant it is asked to submit would be
    // too late; the pause has to land between the two state reads. So the
    // store itself does it: the second readCallingState sees a paused row.
    let reads = 0;
    const racing = {
      ...store,
      async readCallingState() {
        reads += 1;
        const row = await store.readCallingState();
        if (reads === 1) return row; // preflight: enabled
        return { ...row, state: "paused", reason: "Founder hit stop mid-dispatch." };
      },
    };

    const provider = createFakeDialProvider();
    const result = await executeAuthorisedDial({ store: racing, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.KILL_SWITCH);
    assert.strictEqual(provider.submissionCount(), 0, "NO CALL");
    assert.strictEqual(result.dispatchClaimed, true, "the claim was already made and is not rolled back");
    assert.strictEqual(reads, 2, "the stop must be read twice");

    // And the lock is still held: the row is unresolved.
    const open = await store.listDialExecutions({ unresolvedOnly: true });
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].resolvedAt, null);
  });

  it("a missing calling-state row BLOCKS, and is reported as our failure not a decision", async () => {
    const { decision, clock, store } = await mintGenuineSlip({ calling: "missing" });
    const provider = createFakeDialProvider();
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, EXECUTION_CODES.CALLING_STATE_UNAVAILABLE);
    assert.notStrictEqual(result.status, EXECUTION_CODES.KILL_SWITCH, "absence is not a decision somebody made");
    assert.strictEqual(provider.submissionCount(), 0);
  });

  it("an unreadable calling state BLOCKS", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const broken = { ...store, async readCallingState() { throw new Error("connection reset"); } };
    const provider = createFakeDialProvider();

    const result = await executeAuthorisedDial({ store: broken, authorisedDial: decision.dial, provider, now: clock });
    assert.strictEqual(result.status, EXECUTION_CODES.CALLING_STATE_UNAVAILABLE);
    assert.strictEqual(provider.submissionCount(), 0);
  });

  it("no store at all BLOCKS", async () => {
    const { decision, clock } = await mintGenuineSlip();
    const provider = createFakeDialProvider();
    const result = await executeAuthorisedDial({ authorisedDial: decision.dial, provider, now: clock });
    assert.strictEqual(result.status, EXECUTION_CODES.CALLING_STATE_UNAVAILABLE);
    assert.strictEqual(provider.submissionCount(), 0);
  });

  it("and M8E already refuses to mint at all while the switch is engaged", async () => {
    const { decision, store } = await mintGenuineSlip({ killSwitchEngaged: true });
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.KILL_SWITCH);
    assert.strictEqual(decision.dial, null, "no slip may exist while calling is stopped");
  });
});

// ---------------------------------------------------------------------------
// J. COMPLIANCE STAYS WITH M8E — nothing to execute in the first place
// ---------------------------------------------------------------------------

describe("E-7A has nothing to execute when compliance refuses", () => {
  const cases = {
    "14. suppression before authorisation": { suppress: true },
    "15. a stale/absent DNCR wash": { washed: false },
    "16. an unresolved duplicate (never assessed)": { persistProspect: false, approveBatch: false },
    "17. a missing durable batch approval": { approveBatch: false },
    "18. outside the calling window": { iso: "2026-08-05T12:00:00Z" }, // 10pm Melbourne
    "public holiday": { iso: "2026-04-25T02:00:00Z" }, // Anzac Day
  };

  for (const [label, over] of Object.entries(cases)) {
    it(`${label} → no AuthorisedDial is minted, so there is nothing to execute`, async () => {
      const { decision, clock, store } = await mintGenuineSlip(over);

      assert.strictEqual(decision.authorised, false, `${label} must not authorise`);
      assert.strictEqual(decision.dial, null, "a refused decision carries no slip");

      // And the executor cannot be talked into acting on the refusal.
      const provider = createFakeDialProvider();
      const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });
      assert.strictEqual(result.status, EXECUTION_CODES.AUTHORISATION_INVALID);
      assert.strictEqual(provider.submissionCount(), 0);
    });
  }

  it("the executor does not re-implement any compliance rule", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dial-execution.js"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
    for (const mod of ["acquisition-suppression", "acquisition-dncr", "acquisition-eligibility", "acquisition-batch-approval", "acquisition-duplicate-state", "acquisition-calling-policy", "acquisition-attempt-policy"]) {
      assert.ok(!code.includes(mod), `the executor must not import ${mod} — those answers are M8E's`);
    }
  });
});

// ---------------------------------------------------------------------------
// I. OUTCOME / ATTEMPT ACCOUNTING
// ---------------------------------------------------------------------------

describe("E-7A records no contact and consumes no attempt", () => {
  it("a fake execution writes nothing to the outcome or suppression stores", async () => {
    const { decision, clock, store } = await mintGenuineSlip();

    const outcomesBefore = (await store.listOutcomes({ prospectId: decision.prospectId })).length;
    const suppressionsBefore = (await store.listSuppressions()).length;

    await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createFakeDialProvider(), now: clock });

    assert.strictEqual((await store.listOutcomes({ prospectId: decision.prospectId })).length, outcomesBefore);
    assert.strictEqual((await store.listSuppressions()).length, suppressionsBefore);
    assert.strictEqual(outcomesBefore, 0, "and there were none to begin with");
  });

  it("the executor cannot record an outcome — it does not import the recorder", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dial-execution.js"), "utf8");
    for (const forbidden of ["acquisition-outcome", "createOutcomeRecorder", "appendOutcome", "recordOutcome", "no_answer", "voicemail", "connected"]) {
      assert.ok(!src.includes(forbidden), `the executor must not touch contact accounting (${forbidden})`);
    }
  });

  it("a fake submission leaves the attempt count untouched, so a cap is not silently spent", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const { readContactHistory } = require("../src/services/acquisition-history");

    const before = await readContactHistory({ store, prospectId: decision.prospectId });
    await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createFakeDialProvider(), now: clock });
    const after = await readContactHistory({ store, prospectId: decision.prospectId });

    assert.strictEqual(after.totalOutcomes, before.totalOutcomes);
    assert.strictEqual(after.reachedCount, before.reachedCount);
    assert.strictEqual(after.lastEventAt, before.lastEventAt);
    // A fake dispatch is not an attempt, so the business still reads as never contacted.
    assert.strictEqual(after.totalOutcomes, 0);
    assert.strictEqual(after.reachedCount, 0);
    assert.strictEqual(after.lastEventAt, null);
  });

  it("an audit entry, when one is kept, says dispatch and not contact", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const audit = createAuditLog({ now: clock });

    await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createFakeDialProvider(), now: clock, audit });

    const rows = audit.forEntity("prospect", decision.prospectId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event, "dial_execution_submitted");
    assert.match(rows[0].reason, /NOT evidence that anybody was contacted/);
    // It is a record, not a gate outcome, and not an outcome row.
    assert.strictEqual(rows[0].decision, "record");
  });

  it("a provider failure is audited as an error that was not retried", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const audit = createAuditLog({ now: clock });

    await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createFakeDialProvider({ behaviour: "throw" }), now: clock, audit });

    const rows = audit.forEntity("prospect", decision.prospectId);
    assert.strictEqual(rows[0].event, "dial_execution_failed");
    assert.strictEqual(rows[0].decision, "error");
    assert.match(rows[0].reason, /NOT retried/);
  });
});

// ---------------------------------------------------------------------------
// H. RESULT SHAPE
// ---------------------------------------------------------------------------

describe("E-7A reports authorisation, execution and provider outcomes as different things", () => {
  it("the four states are distinct codes, and none is a synonym for another", () => {
    const codes = Object.values(EXECUTION_CODES);
    assert.strictEqual(new Set(codes).size, codes.length, "no duplicate codes");
    for (const c of ["authorisation_invalid", "authorisation_expired", "authorisation_consumed", "provider_refused", "provider_failed", "provider_accepted"]) {
      assert.ok(codes.includes(c), `${c} must exist`);
    }
    // The one that matters most: a disabled provider is NOT a compliance refusal.
    assert.notStrictEqual(EXECUTION_CODES.PROVIDER_REFUSED, ELIGIBILITY_CODES.SUPPRESSED);
    assert.notStrictEqual(EXECUTION_CODES.PROVIDER_REFUSED, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("every result is frozen and carries the full correlation set", async () => {
    const { decision, clock, store } = await mintGenuineSlip();
    const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider: createFakeDialProvider(), now: clock });

    assert.ok(Object.isFrozen(result));
    for (const key of ["ok", "status", "reason", "executionId", "prospectId", "destination", "authorisationId", "authorisedAt", "executedAt", "provider", "providerLive", "providerStatus", "providerRef"]) {
      assert.ok(key in result, `a result must carry ${key}`);
    }
    assert.strictEqual(result.reason, null, "a successful execution has no refusal reason");
  });

  it("ok is true only for a provider that accepted", async () => {
    const outcomes = [
      [createFakeDialProvider(), true],
      [createDisabledDialProvider(), false],
      [createFakeDialProvider({ behaviour: "refuse" }), false],
      [createFakeDialProvider({ behaviour: "throw" }), false],
    ];
    for (const [provider, expected] of outcomes) {
      const { decision, clock, store } = await mintGenuineSlip();
      const result = await executeAuthorisedDial({ store, authorisedDial: decision.dial, provider, now: clock });
      assert.strictEqual(result.ok, expected, `${provider.name} → ok should be ${expected}`);
    }
  });

  /**
   * ── CHANGED BY E-7B1, ON PURPOSE ────────────────────────────────────
   *
   * This test used to assert that the EXECUTION id was deterministic, and it
   * was — because it was derived from `authorisationId`, which is a hash of
   * (prospect, number, instant, decision).
   *
   * That determinism is exactly why it could never arbitrate a durable claim:
   * two genuinely distinct authorisations at the same millisecond collide, so a
   * `unique` key on it would refuse the second legitimate authorisation as a
   * replay of the first. E-7B1 therefore splits the two ideas apart, and this
   * test now pins BOTH halves — the derived one that stayed derived, and the
   * random one that must never be.
   */
  it("authorisationId stays deterministic, and dispatchId must not be", async () => {
    const a = await mintGenuineSlip();
    const b = await mintGenuineSlip();

    // Same fictional prospect, same instant, same number → the SAME derived
    // fingerprint. Unchanged from E-7A, and still what a transcript compares.
    assert.strictEqual(
      a.decision.dial.authorisationId,
      b.decision.dial.authorisationId,
      "the derived fingerprint must still collide — that is what makes it a fingerprint"
    );

    // And the durable identity must NOT collide, or the claim cannot arbitrate.
    assert.notStrictEqual(
      a.decision.dial.dispatchId,
      b.decision.dial.dispatchId,
      "two distinct authorisations must never share a dispatchId"
    );
    for (const slip of [a.decision.dial, b.decision.dial]) {
      assert.match(slip.dispatchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a v4 UUID");
    }
  });

  it("dispatchId is derived from nothing — not the prospect, number, clock, batch or authorisationId", async () => {
    const seen = new Set();
    for (let i = 0; i < 25; i += 1) {
      const { decision, store } = await mintGenuineSlip();
      assert.strictEqual(seen.has(decision.dial.dispatchId), false, "a repeat would mean it is derived");
      seen.add(decision.dial.dispatchId);
    }
    assert.strictEqual(seen.size, 25);
  });

  it("the execution id still correlates one authorisation to its transcript", async () => {
    const a = await mintGenuineSlip();
    const b = await mintGenuineSlip();
    const ra = await executeAuthorisedDial({ store: a.store, authorisedDial: a.decision.dial, provider: createFakeDialProvider(), now: a.clock });
    const rb = await executeAuthorisedDial({ store: b.store, authorisedDial: b.decision.dial, provider: createFakeDialProvider(), now: b.clock });
    assert.strictEqual(ra.authorisationId, rb.authorisationId, "the fingerprint is comparable across runs");
    assert.notStrictEqual(ra.executionId, rb.executionId, "but the execution is not the same execution");
  });
});

// ---------------------------------------------------------------------------
// A + the M8E ratchets, restated for the milestone that changed them
// ---------------------------------------------------------------------------

describe("E-7A is the only execution seam, and it is the safe one", () => {
  const SERVICES = path.join(__dirname, "..", "src", "services");
  const files = fs.readdirSync(SERVICES).filter((f) => f.endsWith(".js"));
  const read = (f) => fs.readFileSync(path.join(SERVICES, f), "utf8");

  /**
   * M8E's ratchet said "no execution verb exists anywhere in the acquisition
   * tree yet". E-7A is the milestone that makes that false on purpose, so the
   * ratchet is restated rather than deleted: there is now exactly ONE file that
   * may submit to a provider, and it is this one.
   */
  it("exactly one acquisition module may submit to a provider", () => {
    const submitters = files
      .filter((f) => f.startsWith("acquisition-") && f !== "acquisition-dial-provider.js")
      .filter((f) => /\.submit\s*\(/.test(read(f)));
    assert.deepStrictEqual(submitters, ["acquisition-dial-execution.js"], `only the executor may submit: ${submitters.join(", ")}`);
  });

  it("the executor requires the authorisation gate", () => {
    assert.match(read("acquisition-dial-execution.js"), /require\("\.\/acquisition-authorisation"\)/);
  });

  /** Unchanged from M8E, and it must stay true: the brand is minted in one place. */
  it("still only the authorisation gate can mint a dial permission", () => {
    const minters = files.filter((f) => f !== "acquisition-authorisation.js" && /AUTHORISED_DIAL|mintAuthorisedDial/.test(read(f)));
    assert.deepStrictEqual(minters, [], `these modules can forge a dial permission: ${minters.join(", ")}`);
  });

  it("the executor authorises nothing itself — it only verifies", () => {
    const src = read("acquisition-dial-execution.js");
    assert.ok(src.includes("isGenuineAuthorisedDial"), "it must verify identity");
    assert.ok(!/createDialAuthoriser\s*\(/.test(src), "it must not be able to mint its own permission");
  });
});
