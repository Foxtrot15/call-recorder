// LOCKSMITH ACQUISITION E-7B1 — durable dispatch authority and the durable stop.
//
// E-7A's single-consumption guarantee was a WeakSet in one module in one
// process, and it said so. This file proves the half that survives a restart:
// the claim is one INSERT, the database arbitrates it, and the locks it takes
// are released by a business outcome or by a named human — never by a provider.
//
// The store here is the in-memory reference implementation, which MODELS laq5's
// two partial unique indexes rather than substituting for them. The static
// proofs that the real indexes exist and are predicated on resolved_at live in
// test/acquisition-laq5-migration.test.js; these two files are load-bearing
// together and neither is sufficient alone.

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
const { createOutcomeRecorder } = require("../src/services/acquisition-outcome");
const { createAuditLog } = require("../src/services/acquisition-audit");

const { executeAuthorisedDial, createAcquisitionDialExecutor, EXECUTION_CODES } = require("../src/services/acquisition-dial-execution");
const { createFakeDialProvider, createDisabledDialProvider } = require("../src/services/acquisition-dial-provider");
const { claimAuthorisedDial, listUnresolvedDispatches, CLAIM_CODES, CONFLICT_SCOPES } = require("../src/services/acquisition-dispatch-store");
const { readCallingState, pauseAcquisitionCalling, enableAcquisitionCalling, STATE_CODES } = require("../src/services/acquisition-calling-state");
const { recordOutcomeAndResolveDispatch, resolveAbnormalDispatch } = require("../src/services/acquisition-dispatch-resolution");

const ISO = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";
const OTHER = "+61355501099";
const now = (iso = ISO) => () => new Date(iso);

function mkProspect({ name = "Northside Lock & Key", suburb = "Brunswick", raw = "(03) 5550 1042" } = {}) {
  let p = createProspect({
    businessName: name, tradeCategory: "Locksmith", suburb, state: "VIC",
    postcode: "3056", region: "Melbourne", timezone: "Australia/Melbourne",
    phones: [{ raw }], sourceRefs: [{ url: "https://x.example.com.au/c" }],
    origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const t of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, t, { actor: "Peter", reason: "e7b1", now: now() }).prospect;
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

async function enabledStore({ calling = "enabled" } = {}) {
  const store = createInMemoryAcquisitionStore();
  if (calling !== "missing") {
    await store.writeCallingState({ state: calling, revision: 1, changedBy: "e7b1 harness", changedAt: ISO, reason: "test" });
  }
  return store;
}

/** Authorise one prospect in a given store, returning a genuine slip. */
async function authorise(store, prospect, e164 = NUMBER) {
  const rows = evidenceFor(prospect);
  const ws = createWashStore({ now: now(), mode: "fixture" });
  ws.wash(e164);
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: `batch ${prospect.prospectId}` });
  const appr = await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e7b1" });
  assert.strictEqual(appr.ok, true, appr.message);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

// ---------------------------------------------------------------------------
// 1-4. IDENTITY AND BINDING
// ---------------------------------------------------------------------------

describe("E-7B1 identity: a durable key that can arbitrate", () => {
  it("1. dispatchId is freshly random per genuine mint", async () => {
    const store = await enabledStore();
    const p = mkProspect();
    const a = await authorise(store, p);
    const b = await authorise(store, p);
    assert.notStrictEqual(a.dial.dispatchId, b.dial.dispatchId);
    assert.match(a.dial.dispatchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("2. authorisationId stays deterministic — same prospect, number and millisecond collide", async () => {
    const store = await enabledStore();
    const p = mkProspect();
    const a = await authorise(store, p);
    const b = await authorise(store, p);
    assert.strictEqual(a.dial.authorisationId, b.dial.authorisationId, "the fingerprint must still collide");
  });

  it("3. batchKey is bound onto the slip from the DURABLE approval", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    assert.ok(d.dial.batchKey, "a slip must carry the approval it was granted under");
    assert.strictEqual(d.dial.batchKey, d.batchKey);
    assert.match(d.dial.batchKey, /^ba_/);
    assert.strictEqual(d.batchSource, "durable");
  });

  it("4. a caller-asserted batch cannot become the bound batchKey", async () => {
    const store = await enabledStore();
    const p = mkProspect();
    const rows = evidenceFor(p);
    const ws = createWashStore({ now: now(), mode: "fixture" });
    ws.wash(NUMBER);
    await store.upsertProspect(p);
    const dup = resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], evidenceCount: rows.length, hasOfficialSource: true }]);

    // No durable approval written at all; the caller simply claims one.
    const d = await createDialAuthoriser({
      now: now(), store,
      engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
    }).authorise(p, { evidenceRows: rows, duplicateResolution: dup, batch: { approved: true, batchKey: "ba_forged", source: "durable" } });

    assert.strictEqual(d.authorised, false, "a caller-asserted approval must authorise nothing");
    assert.strictEqual(d.dial, null, "and no slip may exist to carry a forged batchKey");
  });

  it("the durable claim binds every identity field off the slip and nothing off the caller", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    await claimAuthorisedDial({ store, dial: d.dial, provider: createFakeDialProvider(), claimedBy: "worker-a", now: now() });

    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.dispatchId, d.dial.dispatchId);
    assert.strictEqual(row.authorisationId, d.dial.authorisationId);
    assert.strictEqual(row.prospectId, d.dial.prospectId);
    assert.strictEqual(row.destinationE164, d.dial.e164);
    assert.strictEqual(row.batchKey, d.dial.batchKey);
    assert.strictEqual(row.authorisedAt, d.dial.authorisedAt);
    assert.strictEqual(row.resolvedAt, null, "a claim resolves nothing");
    assert.strictEqual(row.providerStatus, "pending");
  });
});

// ---------------------------------------------------------------------------
// 5-9. CONCURRENCY — the guarantee that survives a process
// ---------------------------------------------------------------------------

describe("E-7B1 concurrency: the database arbitrates", () => {
  it("5. the same dispatch claimed twice — the second is ALREADY_CLAIMED", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    const first = await claimAuthorisedDial({ store, dial: d.dial, provider: createFakeDialProvider(), now: now() });
    const second = await claimAuthorisedDial({ store, dial: d.dial, provider: createFakeDialProvider(), now: now() });

    assert.strictEqual(first.code, CLAIM_CODES.CLAIMED);
    assert.strictEqual(second.code, CLAIM_CODES.ALREADY_CLAIMED);
    assert.strictEqual((await store.listDialExecutions({})).length, 1);
  });

  it("6. ten concurrent claims of ONE dispatch produce exactly one row", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    const results = await Promise.all(Array.from({ length: 10 }, () => claimAuthorisedDial({ store, dial: d.dial, provider: createFakeDialProvider(), now: now() })));

    assert.strictEqual(results.filter((r) => r.claimed).length, 1);
    assert.strictEqual(results.filter((r) => r.code === CLAIM_CODES.ALREADY_CLAIMED).length, 9);
    assert.strictEqual((await store.listDialExecutions({})).length, 1);
  });

  it("7. DIFFERENT dispatchIds, SAME prospect — one claims, the other CONFLICTs", async () => {
    const store = await enabledStore();
    const p = mkProspect();
    const a = await authorise(store, p);
    const b = await authorise(store, p);
    assert.notStrictEqual(a.dial.dispatchId, b.dial.dispatchId);

    const first = await claimAuthorisedDial({ store, dial: a.dial, provider: createFakeDialProvider(), now: now() });
    const second = await claimAuthorisedDial({ store, dial: b.dial, provider: createFakeDialProvider(), now: now() });

    assert.strictEqual(first.code, CLAIM_CODES.CLAIMED);
    assert.strictEqual(second.code, CLAIM_CODES.CONFLICT);
    assert.strictEqual(second.conflictScope, CONFLICT_SCOPES.PROSPECT);
  });

  /**
   * THE ONE A PER-PROSPECT LOCK CANNOT CATCH.
   *
   * Two prospects, one handset. Neither the phones table nor dedupe can see it:
   * acquisition_prospect_phones is unique (prospect_id, raw), and
   * resolveDuplicates only compares the records it is handed.
   */
  it("8. DIFFERENT prospects, SAME destination — one claims, the other CONFLICTs", async () => {
    const store = await enabledStore();
    const a = await authorise(store, mkProspect({ name: "Northside Lock & Key", suburb: "Brunswick" }));
    const b = await authorise(store, mkProspect({ name: "Coburg Emergency Locksmiths", suburb: "Coburg" }));

    assert.notStrictEqual(a.dial.prospectId, b.dial.prospectId, "two genuinely different businesses");
    assert.strictEqual(a.dial.e164, b.dial.e164, "sharing one handset");

    const first = await claimAuthorisedDial({ store, dial: a.dial, provider: createFakeDialProvider(), now: now() });
    const second = await claimAuthorisedDial({ store, dial: b.dial, provider: createFakeDialProvider(), now: now() });

    assert.strictEqual(first.code, CLAIM_CODES.CLAIMED);
    assert.strictEqual(second.code, CLAIM_CODES.CONFLICT);
    assert.strictEqual(second.conflictScope, CONFLICT_SCOPES.DESTINATION);
    assert.match(second.message, /same handset must not be called twice/);
  });

  it("9. different prospects on different numbers may both claim", async () => {
    const store = await enabledStore();
    const a = await authorise(store, mkProspect({ name: "Northside Lock & Key", suburb: "Brunswick" }), NUMBER);
    const b = await authorise(store, mkProspect({ name: "Coburg Emergency Locksmiths", suburb: "Coburg", raw: "(03) 5550 1099" }), OTHER);

    const first = await claimAuthorisedDial({ store, dial: a.dial, provider: createFakeDialProvider(), now: now() });
    const second = await claimAuthorisedDial({ store, dial: b.dial, provider: createFakeDialProvider(), now: now() });

    assert.strictEqual(first.code, CLAIM_CODES.CLAIMED);
    assert.strictEqual(second.code, CLAIM_CODES.CLAIMED, "independent businesses on independent numbers are independent");
    assert.strictEqual((await store.listDialExecutions({})).length, 2);
  });

  it("a SECOND executor instance cannot double-spend what the first one claimed", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());

    // Two executors, two module-level WeakSets as far as each is concerned.
    const p1 = createFakeDialProvider();
    const p2 = createFakeDialProvider();
    const first = await createAcquisitionDialExecutor({ now: now(), store, provider: p1, claimedBy: "worker-a" }).execute(d.dial);

    // The same slip, handed to a different executor. In E-7A only the shared
    // WeakSet stopped this; now the database does too.
    const second = await createAcquisitionDialExecutor({ now: now(), store, provider: p2, claimedBy: "worker-b" }).execute(d.dial);

    assert.strictEqual(first.ok, true, first.message);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.status, EXECUTION_CODES.AUTHORISATION_CONSUMED);
    assert.strictEqual(p2.submissionCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 10-14. THE DURABLE EMERGENCY STOP
// ---------------------------------------------------------------------------

describe("E-7B1 the durable emergency stop", () => {
  it("10. an unreadable store means NO provider invocation", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    const broken = { ...store, async readCallingState() { throw new Error("connection reset"); } };
    const provider = createFakeDialProvider();

    const r = await executeAuthorisedDial({ store: broken, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.CALLING_STATE_UNAVAILABLE);
    assert.strictEqual(provider.submissionCount(), 0);
  });

  it("11. a MISSING state row means NO provider invocation", async () => {
    const store = await enabledStore({ calling: "missing" });
    const d = await authorise(store, mkProspect());
    const provider = createFakeDialProvider();

    const verdict = await readCallingState({ store });
    assert.strictEqual(verdict.permitted, false);
    assert.strictEqual(verdict.code, STATE_CODES.MISSING);

    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.CALLING_STATE_UNAVAILABLE);
    assert.strictEqual(provider.submissionCount(), 0);
  });

  it("12. PAUSED means no provider invocation, and nothing is spent", async () => {
    const store = await enabledStore({ calling: "paused" });
    const d = await authorise(store, mkProspect());
    const provider = createFakeDialProvider();

    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.status, EXECUTION_CODES.KILL_SWITCH);
    assert.strictEqual(provider.submissionCount(), 0);
    assert.strictEqual((await store.listDialExecutions({})).length, 0, "a paused system must not accumulate claimed rows");
    assert.match(r.message, /No authorisation was spent/);
  });

  it("13. ENABLED lets a fake provider execute", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    const provider = createFakeDialProvider();

    const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(provider.submissionCount(), 1);
    assert.strictEqual(provider.submissions[0].destination, NUMBER);
  });

  it("14. enabled at preflight, paused before the final read — no call, claim stays unresolved", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());

    let reads = 0;
    const racing = {
      ...store,
      async readCallingState() {
        reads += 1;
        const row = await store.readCallingState();
        return reads === 1 ? row : { ...row, state: "paused", reason: "stopped mid-dispatch" };
      },
    };

    const provider = createFakeDialProvider();
    const r = await executeAuthorisedDial({ store: racing, authorisedDial: d.dial, provider, now: now() });

    assert.strictEqual(r.status, EXECUTION_CODES.KILL_SWITCH);
    assert.strictEqual(provider.submissionCount(), 0, "NO CALL");
    assert.strictEqual(reads, 2, "the stop is read twice, on purpose");
    assert.strictEqual(r.dispatchClaimed, true);

    const open = await store.listDialExecutions({ unresolvedOnly: true });
    assert.strictEqual(open.length, 1, "the claim is not rolled back");
    assert.strictEqual(open[0].resolvedAt, null, "and it still holds its locks");
  });

  it("paused -> enabled never causes an automatic dispatch", async () => {
    const store = await enabledStore({ calling: "paused" });
    const d = await authorise(store, mkProspect());
    const provider = createFakeDialProvider();

    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });
    assert.strictEqual(provider.submissionCount(), 0);

    await enableAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "resuming the pilot", now: now() });

    // Enabling changes state. It does not retry anything, and nothing is queued.
    assert.strictEqual(provider.submissionCount(), 0, "enabling must never dispatch by itself");
    assert.strictEqual((await store.listDialExecutions({})).length, 0);
  });

  it("a caller cannot supply, override or omit the stop", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    for (const key of ["killSwitch", "callingState", "callingEnabled"]) {
      const provider = createFakeDialProvider();
      const r = await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now(), [key]: true });
      assert.strictEqual(r.status, EXECUTION_CODES.CALLER_OVERRIDE_REJECTED, `${key} must be refused`);
      assert.strictEqual(provider.submissionCount(), 0);
    }
  });

  it("an unrecognised state value BLOCKS rather than being guessed at", async () => {
    const store = await enabledStore();
    // Bypass the writer's validation to model a database somebody hand-edited.
    const weird = { ...store, async readCallingState() { return { scope: "global", state: "ENABLED ", revision: 2, changedBy: "x", changedAt: ISO, reason: "typo" }; } };
    const verdict = await readCallingState({ store: weird });
    assert.strictEqual(verdict.permitted, false);
    assert.strictEqual(verdict.code, STATE_CODES.UNKNOWN_STATE);
  });
});

// ---------------------------------------------------------------------------
// AUDIT ORDERING — a failure may never leave calling on
// ---------------------------------------------------------------------------

describe("E-7B1 kill-switch mutation ordering", () => {
  const failingAudit = { record() { throw new Error("decision chain unavailable"); } };

  it("ENABLING audits first — an audit failure leaves calling PAUSED", async () => {
    const store = await enabledStore({ calling: "paused" });
    const r = await enableAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "resuming", audit: failingAudit, now: now() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "audit_failed");
    const after = await readCallingState({ store });
    assert.strictEqual(after.permitted, false, "CALLING MUST STILL BE OFF");
    assert.strictEqual(after.state, "paused");
  });

  it("PAUSING writes state first — an audit failure still leaves calling STOPPED", async () => {
    const store = await enabledStore({ calling: "enabled" });
    const r = await pauseAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "emergency", audit: failingAudit, now: now() });

    assert.strictEqual(r.ok, true, "the pause itself must succeed");
    assert.strictEqual(r.audited, false);
    const after = await readCallingState({ store });
    assert.strictEqual(after.permitted, false, "CALLING IS OFF, which is what matters");
    assert.match(r.message, /PAUSED/);
  });

  it("the authoritative row carries its own attribution, so safety never needs the audit", async () => {
    const store = await enabledStore({ calling: "enabled" });
    await pauseAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "emergency stop", audit: failingAudit, now: now() });
    const after = await readCallingState({ store });

    assert.strictEqual(after.changedBy, "Peter Dang");
    assert.strictEqual(after.reason, "emergency stop");
    assert.strictEqual(after.revision, 2);
    assert.ok(after.changedAt);
  });

  it("a state change must name who and why", async () => {
    const store = await enabledStore({ calling: "paused" });
    for (const args of [{ changedBy: "", reason: "x" }, { changedBy: "Peter", reason: "" }]) {
      const r = await enableAcquisitionCalling({ store, ...args, now: now() });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, "actor_required");
    }
    assert.strictEqual((await readCallingState({ store })).permitted, false);
  });

  it("revision is optimistic-concurrency controlled", async () => {
    const store = await enabledStore({ calling: "paused" });
    const r = await enableAcquisitionCalling({ store, changedBy: "Peter", reason: "go", expectedRevision: 99, now: now() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "revision_conflict");
    assert.strictEqual((await readCallingState({ store })).permitted, false);
  });

  it("an enable IS audited when the log works", async () => {
    const store = await enabledStore({ calling: "paused" });
    const audit = createAuditLog({ now: now() });
    const r = await enableAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "starting the pilot", audit, now: now() });

    assert.strictEqual(r.ok, true, r.message);
    const rows = audit.forEntity("campaign", "acquisition-global");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event, "acquisition_calling_enabled");
    assert.strictEqual(rows[0].actorKind, "human");
  });
});

// ---------------------------------------------------------------------------
// 15-18. PROVIDER STATUS NEVER RESOLVES
// ---------------------------------------------------------------------------

describe("E-7B1 provider status never releases the lock", () => {
  const cases = {
    "15. provider submitted": { behaviour: "accept", expectStatus: "submitted" },
    "16. provider refused": { behaviour: "refuse", expectStatus: "refused" },
    "17. provider threw": { behaviour: "throw", expectStatus: "unknown" },
  };

  for (const [label, { behaviour, expectStatus }] of Object.entries(cases)) {
    it(`${label} — the dispatch stays unresolved and keeps both locks`, async () => {
      const store = await enabledStore();
      const d = await authorise(store, mkProspect());
      const provider = createFakeDialProvider({ behaviour });

      await executeAuthorisedDial({ store, authorisedDial: d.dial, provider, now: now() });

      const [row] = await store.listDialExecutions({});
      assert.strictEqual(row.providerStatus, expectStatus, "the mechanism's status IS written");
      assert.strictEqual(row.resolvedAt, null, "AND THE LOCK IS STILL HELD");
      assert.strictEqual(row.resolution, null);

      const open = await store.listDialExecutions({ unresolvedOnly: true });
      assert.strictEqual(open.length, 1);
    });
  }

  it("18. a disabled provider also leaves the dispatch unresolved", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createDisabledDialProvider(), now: now() });

    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.providerStatus, "refused");
    assert.strictEqual(row.resolvedAt, null);
  });

  it("THE SAFETY EXAMPLE: provider accepted, no outcome yet, second worker still refused", async () => {
    const store = await enabledStore();
    const p = mkProspect();
    const a = await authorise(store, p);

    // Worker A: claims, provider accepts, provider status changes.
    const pA = createFakeDialProvider();
    const first = await executeAuthorisedDial({ store, authorisedDial: a.dial, provider: pA, now: now() });
    assert.strictEqual(first.ok, true);
    assert.strictEqual((await store.listDialExecutions({}))[0].providerStatus, "submitted");

    // NO durable contact outcome has been written yet.
    assert.strictEqual((await store.listOutcomes({ prospectId: p.prospectId })).length, 0);

    // Worker B: re-authorises the same prospect and tries again.
    const b = await authorise(store, p);
    const pB = createFakeDialProvider();
    const second = await executeAuthorisedDial({ store, authorisedDial: b.dial, provider: pB, now: now() });

    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.status, EXECUTION_CODES.DISPATCH_CONFLICT);
    assert.strictEqual(second.conflictScope, CONFLICT_SCOPES.PROSPECT);
    assert.strictEqual(pB.submissionCount(), 0, "THE SECOND CALL MUST NOT HAPPEN");
  });

  it("recordProviderResult has no way to set resolved_at", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dispatch-store.js"), "utf8");
    // Comments stripped: the next function's doc comment explains the ordering
    // at length, and prose about the invariant is not a violation of it.
    const code = src
      .split("\n")
      .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
      .join("\n");
    const fn = code.slice(code.indexOf("async function recordProviderResult"), code.indexOf("async function resolveDispatchForOutcome"));
    assert.ok(fn.length > 0, "the function must be found");
    assert.ok(!/resolvedAt/.test(fn), "a provider result must not be able to resolve anything");
    assert.ok(!/resolution/.test(fn));
  });
});

// ---------------------------------------------------------------------------
// 19-22. OUTCOME -> RESOLUTION, AND THE OPERATOR PATH
// ---------------------------------------------------------------------------

describe("E-7B1 releasing a lock", () => {
  async function claimedDispatch() {
    const store = await enabledStore();
    const p = mkProspect();
    const d = await authorise(store, p);
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createFakeDialProvider(), now: now() });
    return { store, prospect: p, dispatchId: d.dial.dispatchId };
  }

  it("19. an outcome is written FIRST, and only then is the lock released", async () => {
    const { store, prospect, dispatchId } = await claimedDispatch();
    const recorder = createOutcomeRecorder({ now: now() });

    // The dispatch moved the prospect to 'queued'/'attempted' in the real flow;
    // here the prospect is review_approved, so move it as the queue would.
    const queued = transitionProspect(prospect, "queued", { actor: "worker", reason: "dispatch", now: now() }).prospect;

    const r = await recordOutcomeAndResolveDispatch({
      store, recorder, prospect: queued, outcome: "no_answer", dispatchId, actor: "worker-a", e164: NUMBER, note: "Rang out; nobody picked up.", now: now(),
    });

    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(r.outcomeRecorded, true);
    assert.strictEqual(r.dispatchResolved, true);

    const [row] = await store.listDialExecutions({});
    assert.ok(row.resolvedAt);
    assert.strictEqual(row.resolution, "outcome_recorded");
    assert.strictEqual((await store.listDialExecutions({ unresolvedOnly: true })).length, 0, "the locks are released");
  });

  it("20. if the outcome write FAILS, the lock is held and nothing is resolved", async () => {
    const { store, prospect, dispatchId } = await claimedDispatch();
    const brokenRecorder = { record() { throw new Error("outcome store unavailable"); } };

    const r = await recordOutcomeAndResolveDispatch({
      store, recorder: brokenRecorder, prospect, outcome: "no_answer", dispatchId, actor: "worker-a", note: "Rang out; nobody picked up.", now: now(),
    });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomeRecorded, false);
    assert.strictEqual(r.dispatchResolved, false);

    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.resolvedAt, null, "THE LOCK MUST STILL BE HELD");
    assert.match(r.message, /still holds this business and this number/);
  });

  it("21. if the RESOLUTION write fails after a good outcome, the lock is still held", async () => {
    const { store, prospect, dispatchId } = await claimedDispatch();
    const recorder = createOutcomeRecorder({ now: now() });
    const queued = transitionProspect(prospect, "queued", { actor: "w", reason: "d", now: now() }).prospect;

    const brokenStore = { ...store, async updateDialExecution() { throw new Error("write failed"); } };

    const r = await recordOutcomeAndResolveDispatch({
      store: brokenStore, recorder, prospect: queued, outcome: "no_answer", dispatchId, actor: "worker-a", e164: NUMBER, note: "Rang out; nobody picked up.", now: now(),
    });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomeRecorded, true, "the business IS accounted for");
    assert.strictEqual(r.dispatchResolved, false);

    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.resolvedAt, null, "the lock is stuck, which is the safe direction");
  });

  it("the forbidden state is unreachable: nothing resolves before an outcome exists", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dispatch-resolution.js"), "utf8");
    const step1 = src.indexOf("STEP 1: THE BUSINESS FACT");
    const step2 = src.indexOf("STEP 2: AND ONLY NOW, THE LOCK");
    assert.ok(step1 > 0 && step2 > step1, "the outcome write must come first in the source, and it does");
    assert.ok(!/\.rpc\(/.test(src), "no database function was added for this");
  });

  it("22. an operator can resolve an abnormal dispatch, explicitly and by name", async () => {
    const { store, dispatchId } = await claimedDispatch();

    const refused = await resolveAbnormalDispatch({ store, dispatchId, resolvedBy: "Peter Dang", reason: "", now: now() });
    assert.strictEqual(refused.ok, false, "a resolution without a reason is refused");

    const r = await resolveAbnormalDispatch({ store, dispatchId, resolvedBy: "Peter Dang", reason: "Checked the provider console; no call was placed.", now: now() });
    assert.strictEqual(r.ok, true, r.message);

    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.resolution, "operator_closed");
    assert.strictEqual(row.resolvedBy, "Peter Dang");
    assert.strictEqual((await store.listDialExecutions({ unresolvedOnly: true })).length, 0);
  });

  it("once resolved, the prospect and destination are free again", async () => {
    const store = await enabledStore();
    const p = mkProspect();
    const a = await authorise(store, p);
    await executeAuthorisedDial({ store, authorisedDial: a.dial, provider: createFakeDialProvider(), now: now() });

    const blocked = await claimAuthorisedDial({ store, dial: (await authorise(store, p)).dial, provider: createFakeDialProvider(), now: now() });
    assert.strictEqual(blocked.code, CLAIM_CODES.CONFLICT);

    await resolveAbnormalDispatch({ store, dispatchId: a.dial.dispatchId, resolvedBy: "Peter Dang", reason: "closed", now: now() });

    const allowed = await claimAuthorisedDial({ store, dial: (await authorise(store, p)).dial, provider: createFakeDialProvider(), now: now() });
    assert.strictEqual(allowed.code, CLAIM_CODES.CLAIMED, "a resolved dispatch releases the business");
  });
});

// ---------------------------------------------------------------------------
// 23-24 + O. NO AUTOMATIC ANYTHING
// ---------------------------------------------------------------------------

describe("E-7B1 does nothing automatically", () => {
  it("23. no retry exists in the dispatch path", () => {
    for (const f of ["acquisition-dial-execution.js", "acquisition-dispatch-store.js", "acquisition-dispatch-resolution.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
      const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
      for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/]) {
        assert.ok(!p.test(code), `${f} must contain no ${p}`);
      }
    }
  });

  /**
   * Only the two deliberate paths may release a dispatch lock.
   *
   * Matched on the resolver FUNCTIONS rather than on the string "resolvedAt",
   * because that word legitimately appears in two unrelated places: the store
   * adapter maps the column, and acquisition-review-queue.js has its own
   * `resolvedAt` for M8H review items, which are a different thing entirely.
   * A ratchet that confused them would be noise, and noisy ratchets get deleted.
   */
  it("24. nothing resolves a dispatch except the two deliberate paths", () => {
    const SERVICES = path.join(__dirname, "..", "src", "services");
    const offenders = fs
      .readdirSync(SERVICES)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => f !== "acquisition-dispatch-store.js" && f !== "acquisition-dispatch-resolution.js")
      .filter((f) => /resolveDispatchForOutcome|resolveDispatchByOperator|resolveAbnormalDispatch/.test(fs.readFileSync(path.join(SERVICES, f), "utf8")));
    assert.deepStrictEqual(offenders, [], `only the resolution paths may resolve: ${offenders.join(", ")}`);
  });

  it("the executor itself cannot resolve anything", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dial-execution.js"), "utf8");
    for (const forbidden of ["resolveDispatch", "resolvedAt", "resolution:", "operator_closed", "outcome_recorded"]) {
      assert.ok(!src.includes(forbidden), `the executor must not be able to release a lock (${forbidden})`);
    }
  });

  it("the stale-dispatch report is READ-ONLY", async () => {
    const store = await enabledStore();
    const d = await authorise(store, mkProspect());
    await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createFakeDialProvider({ behaviour: "throw" }), now: now() });

    const later = () => new Date(Date.parse(ISO) + 3 * 3600 * 1000);
    const report = await listUnresolvedDispatches({ store, olderThanMs: 60 * 60 * 1000, now: later });

    assert.strictEqual(report.available, true);
    assert.strictEqual(report.count, 1);
    assert.strictEqual(report.dispatches[0].providerStatus, "unknown");
    assert.strictEqual(report.dispatches[0].holdsProspectLock, true);

    // It changed nothing.
    const [row] = await store.listDialExecutions({});
    assert.strictEqual(row.resolvedAt, null);
    assert.strictEqual((await store.listDialExecutions({ unresolvedOnly: true })).length, 1);

    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-dispatch-store.js"), "utf8");
    const fn = src.slice(src.indexOf("async function listUnresolvedDispatches"));
    assert.ok(!/updateDialExecution|appendDialExecution/.test(fn), "the report must not write");
  });
});

// ---------------------------------------------------------------------------
// 25-26. LIVE-CALL IMPOSSIBILITY, STILL
// ---------------------------------------------------------------------------

describe("E-7B1 leaves live calling impossible", () => {
  it("25. the disabled provider still reaches no network", () => {
    for (const f of ["acquisition-dial-provider.js", "acquisition-dispatch-store.js", "acquisition-calling-state.js", "acquisition-dispatch-resolution.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
      const code = src.split("\n").filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
      for (const p of [/\bfetch\s*\(/, /require\(["'](twilio|axios|got|node-fetch|retell-sdk|@retell)/, /https?:\/\//, /https?\.request\s*\(/, /process\.env/]) {
        assert.ok(!p.test(code), `${f} must not contain ${p}`);
      }
    }
  });

  it("26. the default executor is still disabled and not live-capable", async () => {
    const store = await enabledStore();
    const executor = createAcquisitionDialExecutor({ now: now(), store });
    assert.strictEqual(executor.providerName, "disabled");
    assert.strictEqual(executor.providerLive, false);
    assert.strictEqual(executor.liveCapable, false);

    const d = await authorise(store, mkProspect());
    const r = await executor.execute(d.dial);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, EXECUTION_CODES.PROVIDER_REFUSED);
  });

  it("enabling the durable state does NOT make calling possible — two locks, not one", async () => {
    const store = await enabledStore({ calling: "paused" });
    await enableAcquisitionCalling({ store, changedBy: "Peter Dang", reason: "pilot", now: now() });
    assert.strictEqual((await readCallingState({ store })).permitted, true, "lock one is open");

    const executor = createAcquisitionDialExecutor({ now: now(), store });
    assert.strictEqual(executor.liveCapable, false, "AND LOCK TWO IS STILL SHUT: no live provider exists");

    const d = await authorise(store, mkProspect());
    const r = await executor.execute(d.dial);
    assert.strictEqual(r.ok, false, "so nothing can be called even with calling enabled");
  });

  it("no acquisition module can construct a live provider", () => {
    const mod = require("../src/services/acquisition-dial-provider");
    for (const [name, factory] of Object.entries(mod).filter(([, v]) => typeof v === "function" && /^create/.test(v.name || ""))) {
      assert.strictEqual(factory().live, false, `${name} must not be live`);
    }
  });
});
