// LOCKSMITH ACQUISITION E-9 — one provider call, one dispatch.
//
// Two invariants, both enforced by laq6 rather than by application timing:
//
//   A. CROSS-DISPATCH   one non-null provider_ref belongs to at most one row
//   B. WRITE-ONCE       once bound, provider_ref may not change or be cleared
//
// A alone is not sufficient. The same-dispatch race is two workers reading NULL
// and wanting DIFFERENT references — R1 and R2 collide with nothing, so a
// unique index never fires. B is what makes the first writer win.
//
// The in-memory store MODELS both rules, raising the same SQLSTATEs and the
// same constraint name Postgres raises, so these tests exercise the service's
// classification against the real shapes rather than against a pre-read
// pretending to be atomic. The database is the authority; this file proves the
// service reads its verdict correctly.

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
const { executeAuthorisedDial, EXECUTION_CODES } = require("../src/services/acquisition-dial-execution");
const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");
const { handleAcquisitionCallEvent, EVENT_CODES } = require("../src/services/acquisition-call-events");

const ISO = "2026-08-05T04:00:00Z";
const now = (iso = ISO) => () => new Date(iso);
const ROUTING = Object.freeze({ agentId: "agent_acqfixture0001", fromNumber: "+61355500001" });

let seq = 0;
function mkProspect(suffix = "") {
  seq += 1;
  let p = createProspect({
    businessName: `Northside Lock & Key ${suffix || seq}`, tradeCategory: "Locksmith",
    suburb: "Brunswick", state: "VIC", postcode: "3056", region: "Melbourne", timezone: "Australia/Melbourne",
    phones: [{ raw: `(03) 5550 10${String(40 + seq).slice(-2)}` }],
    sourceRefs: [{ url: "https://x.example.com.au/c" }],
    origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z",
  }).prospect;
  for (const t of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, t, { actor: "Peter", reason: "e9", now: now() }).prospect;
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
  const e164 = prospect.phones[0].e164 || `+6135550${String(1040 + seq).slice(-4)}`;
  const rows = evidenceFor(prospect);
  const ws = createWashStore({ now: now(), mode: "fixture" });
  ws.wash(e164);
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }], label: `batch ${prospect.prospectId}` });
  const appr = await recordBatchApproval({ store, now: now(), identity, approvedBy: "Peter Dang", reason: "e9" });
  assert.strictEqual(appr.ok, true, appr.message);
  const dup = resolveDuplicates([{ ...prospect, numbers: [{ e164 }], evidenceCount: rows.length, hasOfficialSource: true }]);
  const d = await createDialAuthoriser({
    now: now(), store,
    engineOptions: { washStore: ws, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), callingPolicyApproval: FOUNDER_CALLING_POLICY },
  }).authorise(prospect, { evidenceRows: rows, duplicateResolution: dup });
  assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
  return d;
}

async function freshStore() {
  const store = createInMemoryAcquisitionStore();
  await store.writeCallingState({ state: "enabled", revision: 1, changedBy: "e9", changedAt: ISO, reason: "test" });
  return store;
}

async function recorderFor(store) {
  return createDurableOutcomes({
    now: now(), suppression: await createDurableSuppression({ now: now(), store }), store,
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
  });
}

/** Dispatch a prospect, optionally losing the response so provider_ref stays NULL. */
async function dispatch(store, { lost = false, callId = "call_R1" } = {}) {
  const p = mkProspect();
  const d = await authorise(store, p);
  const transport = lost
    ? async () => { throw new Error("socket hang up"); }
    : async () => ({ ok: true, resource: { id: callId } });
  await executeAuthorisedDial({ store, authorisedDial: d.dial, provider: createRetellAcquisitionProvider({ routing: ROUTING, transport }), now: now() });
  return { prospect: p, dispatchId: d.dial.dispatchId };
}

const eventFor = (dispatchId, callId, extra = {}) => ({
  verified: true,
  eventType: "call_started",
  providerCallId: callId,
  call: { call_id: callId, metadata: { aida_dispatch_id: dispatchId }, ...extra },
});

// ---------------------------------------------------------------------------
// 1-5. THE FIVE SERVICE CASES
// ---------------------------------------------------------------------------

describe("E-9 binds one provider call to one dispatch", () => {
  it("1. CASE 1 — the first binding succeeds", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_R1"), store, recorder: await recorderFor(store), now: now() });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(r.code, EVENT_CODES.BOUND);
    assert.strictEqual((await store.listDialExecutions({ dispatchId }))[0].providerRef, "call_R1");
  });

  it("2. CASE 2 — the same binding again is idempotent", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);
    await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_R1"), store, recorder, now: now() });
    const before = await store.listDialExecutions({ dispatchId });

    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_R1"), store, recorder, now: now() });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(r.code, EVENT_CODES.BOUND);
    assert.deepStrictEqual(await store.listDialExecutions({ dispatchId }), before, "nothing changed");
  });

  it("3. CASE 3 — same dispatch, a different call is a permanent conflict", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);
    await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_R1"), store, recorder, now: now() });

    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_R2"), store, recorder, now: now() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, EVENT_CODES.CALL_ID_CONFLICT);
    assert.strictEqual((await store.listDialExecutions({ dispatchId }))[0].providerRef, "call_R1", "the original stands");
  });

  it("4. CASE 4 — a different dispatch claiming the same call is refused by the DATABASE", async () => {
    const store = await freshStore();
    const a = await dispatch(store, { lost: true });
    const b = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);

    await handleAcquisitionCallEvent({ ...eventFor(a.dispatchId, "call_SHARED"), store, recorder, now: now() });

    const r = await handleAcquisitionCallEvent({ ...eventFor(b.dispatchId, "call_SHARED"), store, recorder, now: now() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, EVENT_CODES.CALL_ID_TAKEN, r.message);
    assert.strictEqual((await store.listDialExecutions({ dispatchId: b.dispatchId }))[0].providerRef, null);
    assert.strictEqual((await store.listDialExecutions({ dispatchId: a.dispatchId }))[0].providerRef, "call_SHARED", "the first owner keeps it");
  });

  it("5. CASE 5 — different dispatches with different calls are both allowed", async () => {
    const store = await freshStore();
    const a = await dispatch(store, { lost: true });
    const b = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);

    const ra = await handleAcquisitionCallEvent({ ...eventFor(a.dispatchId, "call_A"), store, recorder, now: now() });
    const rb = await handleAcquisitionCallEvent({ ...eventFor(b.dispatchId, "call_B"), store, recorder, now: now() });
    assert.strictEqual(ra.ok, true, ra.message);
    assert.strictEqual(rb.ok, true, rb.message);
  });
});

// ---------------------------------------------------------------------------
// 5-6. THE ARBITRATION IS THE DATABASE'S, NOT THE PRE-READ'S
// ---------------------------------------------------------------------------

describe("E-9 reads the database's verdict rather than its own pre-read", () => {
  /**
   * The race the unique index CANNOT catch: both workers read NULL, and they
   * want DIFFERENT references, so nothing collides. Only write-once decides.
   *
   * Modelled by letting both callers past the pre-read with a store whose read
   * is stale — which is exactly what two processes see.
   */
  it("6. two workers who both read NULL and want different refs — one wins", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const stale = (await store.listDialExecutions({ dispatchId }))[0];
    assert.strictEqual(stale.providerRef, null);

    const racy = Object.freeze({
      ...store,
      // Both workers see the row as it was BEFORE either wrote. The pre-read
      // therefore passes for both, and the database has to be the tie-breaker.
      listDialExecutions: async () => [stale],
    });
    const recorder = await recorderFor(store);

    const [w1, w2] = await Promise.all([
      handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_W1"), store: racy, recorder, now: now() }),
      handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_W2"), store: racy, recorder, now: now() }),
    ]);

    const winners = [w1, w2].filter((r) => r.ok);
    const losers = [w1, w2].filter((r) => !r.ok);
    assert.strictEqual(winners.length, 1, "exactly one binding may survive");
    assert.strictEqual(losers.length, 1);
    assert.strictEqual(losers[0].code, EVENT_CODES.CALL_ID_CONFLICT, losers[0].message);

    const finalRef = (await store.listDialExecutions({ dispatchId }))[0].providerRef;
    assert.ok(["call_W1", "call_W2"].includes(finalRef));
  });

  it("a unique violation is NOT store_unavailable", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const err = new Error('duplicate key value violates unique constraint "idx_acq_dial_exec_provider_ref"');
    err.code = "23505";
    err.constraint = "idx_acq_dial_exec_provider_ref";

    const failing = Object.freeze({ ...store, updateDialExecution: async () => { throw err; } });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_X"), store: failing, recorder: await recorderFor(store), now: now() });
    assert.strictEqual(r.code, EVENT_CODES.CALL_ID_TAKEN);
    assert.notStrictEqual(r.code, EVENT_CODES.STORE_UNAVAILABLE);
  });

  it("a write-once violation is NOT store_unavailable", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const err = new Error("acq_provider_ref_write_once: dispatch d is already bound to provider reference R1; provider_ref is write-once");
    err.code = "23514";

    const failing = Object.freeze({ ...store, updateDialExecution: async () => { throw err; } });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_X"), store: failing, recorder: await recorderFor(store), now: now() });
    assert.strictEqual(r.code, EVENT_CODES.CALL_ID_CONFLICT);
    assert.notStrictEqual(r.code, EVENT_CODES.STORE_UNAVAILABLE);
  });

  it("a GENUINE outage is still store_unavailable", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const failing = Object.freeze({ ...store, updateDialExecution: async () => { throw new Error("connection terminated unexpectedly"); } });
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_X"), store: failing, recorder: await recorderFor(store), now: now() });
    assert.strictEqual(r.code, EVENT_CODES.STORE_UNAVAILABLE, "an outage must not be dressed up as a conflict either");
  });

  it("fail() now preserves the database's code and constraint", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-store.js"), "utf8");
    const fn = src.slice(src.indexOf("function fail(table, verb, error)"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    for (const kept of ["wrapped.code", "wrapped.constraint", "wrapped.details", "wrapped.hint"]) {
      assert.ok(body.includes(kept), `fail() must preserve ${kept}`);
    }
    assert.ok(body.includes("acquisition ${verb} failed on ${table}"), "and the message must be unchanged for existing callers");
  });
});

// ---------------------------------------------------------------------------
// 7-9. A CONFLICT IS NEVER A RETRY, A RESOLUTION OR AN OUTCOME
// ---------------------------------------------------------------------------

describe("E-9 conflicts change nothing except an operator's to-do list", () => {
  const conflictCases = async () => {
    const store = await freshStore();
    const a = await dispatch(store, { lost: true });
    const b = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);
    await handleAcquisitionCallEvent({ ...eventFor(a.dispatchId, "call_SHARED"), store, recorder, now: now() });

    return {
      store,
      taken: await handleAcquisitionCallEvent({ ...eventFor(b.dispatchId, "call_SHARED"), store, recorder, now: now() }),
      conflict: await handleAcquisitionCallEvent({ ...eventFor(a.dispatchId, "call_OTHER"), store, recorder, now: now() }),
      a, b,
    };
  };

  it("7-9. neither conflict retries, resolves or records an outcome", async () => {
    const { store, taken, conflict, a, b } = await conflictCases();
    for (const r of [taken, conflict]) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.outcomeRecorded, false);
      assert.strictEqual(r.dispatchResolved, false);
    }
    assert.strictEqual((await store.listOutcomes({})).length, 0, "no outcome");
    assert.strictEqual((await store.listSuppressions({})).length, 0, "no suppression");
    for (const d of [a, b]) {
      assert.strictEqual((await store.listDialExecutions({ dispatchId: d.dispatchId }))[0].resolvedAt, null, "the locks are held");
    }
  });

  it("no conflict path contains a retry, a timer or a redial", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-call-events.js"), "utf8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");
    for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bredial\b/, /\.submit\s*\(/]) {
      assert.ok(!p.test(code), `the event path must contain no ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 10-13. NOTHING EARLIER WAS BROKEN
// ---------------------------------------------------------------------------

describe("E-9 leaves the earlier guarantees intact", () => {
  it("10. a duplicate binding is still idempotent end to end", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);
    const ev = eventFor(dispatchId, "call_R1");
    await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    const snapshot = await store.listDialExecutions({});
    await handleAcquisitionCallEvent({ ...ev, store, recorder, now: now() });
    assert.deepStrictEqual(await store.listDialExecutions({}), snapshot);
  });

  it("11. ambiguous provider submission still binds nothing and claims nothing", async () => {
    const store = await freshStore();
    const { dispatchId, prospect } = await dispatch(store, { lost: true });
    const [row] = await store.listDialExecutions({ dispatchId });
    assert.strictEqual(row.providerStatus, "unknown");
    assert.strictEqual(row.providerRef, null);
    assert.strictEqual(row.resolvedAt, null);
    assert.strictEqual((await store.loadProspect(prospect.prospectId)).lifecycle, "queued", "E-8 unchanged");
  });

  it("12. lost-response reconciliation still works, and now cannot be hijacked", async () => {
    const store = await freshStore();
    const { dispatchId, prospect } = await dispatch(store, { lost: true });
    const recorder = await recorderFor(store);
    const r = await handleAcquisitionCallEvent({ ...eventFor(dispatchId, "call_LATE"), store, recorder, now: now() });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual((await store.listDialExecutions({ dispatchId }))[0].providerRef, "call_LATE");
    assert.strictEqual((await store.loadProspect(prospect.prospectId)).lifecycle, "attempted", "E-8 unchanged");
  });

  it("13. a definite acceptance still binds at dispatch time", async () => {
    const store = await freshStore();
    const { dispatchId } = await dispatch(store, { callId: "call_ACCEPTED" });
    assert.strictEqual((await store.listDialExecutions({ dispatchId }))[0].providerRef, "call_ACCEPTED");
    assert.strictEqual((await store.listDialExecutions({ dispatchId }))[0].providerStatus, "submitted");
  });

  it("the in-memory store models laq6 rather than pretending a pre-read is atomic", async () => {
    const store = await freshStore();
    const a = await dispatch(store, { lost: true });
    const b = await dispatch(store, { lost: true });

    await store.updateDialExecution(a.dispatchId, { providerRef: "call_Z" });

    // Cross-dispatch: the store itself refuses, with Postgres's own shapes.
    await assert.rejects(
      () => store.updateDialExecution(b.dispatchId, { providerRef: "call_Z" }),
      (err) => err.code === "23505" && err.constraint === "idx_acq_dial_exec_provider_ref"
    );
    // Write-once: rebinding and unbinding both refused.
    await assert.rejects(() => store.updateDialExecution(a.dispatchId, { providerRef: "call_Y" }), /acq_provider_ref_write_once/);
    await assert.rejects(() => store.updateDialExecution(a.dispatchId, { providerRef: null }), /acq_provider_ref_write_once/);
    // Same value again is fine.
    await store.updateDialExecution(a.dispatchId, { providerRef: "call_Z" });
  });
});

// ---------------------------------------------------------------------------
// THE MIGRATION TEXT
// ---------------------------------------------------------------------------

describe("E-9 migration says what it claims", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "sql", "laq6_bind_provider_call_once.sql"), "utf8");

  it("creates the uniqueness index on provider_ref, partial on NOT NULL", () => {
    assert.match(sql, /create unique index if not exists idx_acq_dial_exec_provider_ref/i);
    assert.match(sql, /on public\.acquisition_dial_executions \(provider_ref\)/i);
    assert.match(sql, /where provider_ref is not null/i);
  });

  it("is NOT partial on resolved_at — a call reference may never be rebound", () => {
    const indexBlock = sql.slice(sql.indexOf("idx_acq_dial_exec_provider_ref"));
    const stmt = indexBlock.slice(0, indexBlock.indexOf(";"));
    assert.ok(!/resolved_at/i.test(stmt), "the provider_ref index must not be scoped to unresolved rows");
  });

  it("adds the write-once rule with a stable token and a distinct SQLSTATE", () => {
    assert.match(sql, /old\.provider_ref is not null/i);
    assert.match(sql, /new\.provider_ref is distinct from old\.provider_ref/i);
    assert.match(sql, /acq_provider_ref_write_once/);
    assert.match(sql, /using errcode = '23514'/i);
  });

  it("keeps every laq5 rule in the replaced guard", () => {
    for (const rule of ["is not deletable", "identity is immutable", "cannot be reopened", "already terminal"]) {
      assert.ok(sql.includes(rule), `laq5's "${rule}" must survive the replacement`);
    }
  });

  it("creates no row, deletes nothing, and touches neither RLS nor the calling state", () => {
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const forbidden of [/\bdelete\s+from\b/i, /\bdrop\s+table\b/i, /\balter\s+table\b/i, /\bcreate\s+policy\b/i, /row level security/i, /acquisition_calling_state/i]) {
      assert.ok(!forbidden.test(code), `the migration must not contain ${forbidden}`);
    }
    // The only INSERT-shaped word may be in prose, never in a statement.
    assert.ok(!/\binsert\s+into\b/i.test(code), "the migration must create no rows");
  });

  it("is wrapped in a transaction", () => {
    assert.match(sql, /^begin;/im);
    assert.match(sql, /^commit;/im);
  });

  it("the read-only verifier really is read-only", () => {
    const v = fs.readFileSync(path.join(__dirname, "..", "supabase", "sql", "verification", "13_laq6_verify_readonly.sql"), "utf8");
    const code = v.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /\bcreate\b/i, /\balter\b/i, /\bdrop\b/i, /\bbegin\s*;/i, /\bcommit\s*;/i, /\brollback\s*;/i]) {
      assert.ok(!forbidden.test(code), `the read-only verifier must not contain ${forbidden}`);
    }
  });

  it("the mutation probe always rolls back and never resolves the proof dispatch", () => {
    const v = fs.readFileSync(path.join(__dirname, "..", "supabase", "sql", "verification", "14_laq6_mutation_probes.sql"), "utf8");
    assert.match(v, /^begin;/im, "it must open a transaction");
    assert.match(v, /^rollback;/im, "and end by throwing everything away");
    assert.ok(!/^commit;/im.test(v), "it must never commit");
    assert.match(v, /REFUSING TO RUN/, "it must refuse to run while calling is not paused");
  });
});
