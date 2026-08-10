// LOCKSMITH ACQUISITION E-5 — durable founder batch approval.
//
// E-5 succeeds only if a batch approved by a process that has since exited is
// still recognised by a process that has never seen it, AND a batch whose
// membership changed since is not.
//
// The two halves matter equally. Durability alone would be a way to make an old
// approval cover a new list; staleness alone would be the in-process check that
// already existed. This file decides both against the in-memory store; the same
// sequence runs across two genuinely separate OS processes in
// scripts/dev/acquisition-batch-approval-proof/.
//
// ── THE COLLABORATORS ARE THE REAL MODULES ──────────────────────────
// The eligibility engine, the authorisation gate, the decision log and the
// store are all the shipping ones. A test that faked the gate would prove
// nothing about what refuses a call.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalBatchIdentity,
  membersFromBatch,
  verifyIdentity,
  recordBatchApproval,
  loadBatchApproval,
  listBatchApprovals,
  revokeBatchApproval,
  resolveBatchApprovalForProspect,
  checkDurableFreshness,
  BATCH_APPROVAL_CODES,
  STATUS,
  EVENT_APPROVED,
  EVENT_WITHDRAWN,
} = require("../src/services/acquisition-batch-approval");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createDialAuthoriser, isAuthorisedDial, AUTHORISATION_CODES } = require("../src/services/acquisition-authorisation");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect, identityFingerprint } = require("../src/services/acquisition-prospect");
const { assembleBatch, recordFounderAction, submitForApproval, approveBatch } = require("../src/services/acquisition-batch");
const { verifyRows } = require("../src/services/acquisition-audit");
const { DEFAULT_CAPS } = require("../src/config/acquisition");

const MELBOURNE = "Australia/Melbourne";
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";
const OTHER_NUMBER = "+61355501099";

const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

const FOUNDER = "Peter Dang";

function goodProspect({ name = "Northside Lock & Key", phone = "(03) 5550 1042", suburb = "Brunswick" } = {}) {
  const built = createProspect({
    businessName: name,
    tradeCategory: "Locksmith",
    suburb,
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: MELBOURNE,
    phones: [{ raw: phone }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
  });
  let p = built.prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: FOUNDER, reason: "test", now: now() }).prospect;
  }
  return p;
}

function evidenceFor(prospect, clock = now()) {
  const ledger = createEvidenceLedger({ now: clock });
  const source = { url: "https://northsidelockandkey.example.com.au/contact" };
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0] ? prospect.phones[0].raw : "n/a"],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "test", source });
  }
  return ledger.forProspect(prospect.prospectId);
}

const memberOf = (p, e164 = NUMBER) => ({ rowId: p.prospectId, prospectId: p.prospectId, e164 });

/** One durably approved batch containing `prospect`. Returns the identity. */
async function approveOne(store, prospect, { clock = now(), e164 = NUMBER, by = FOUNDER } = {}) {
  const identity = canonicalBatchIdentity({ members: [memberOf(prospect, e164)], label: "test batch" });
  const result = await recordBatchApproval({ store, now: clock, identity, approvedBy: by, reason: "Approved for the pilot." });
  assert.strictEqual(result.ok, true, result.message);
  return identity;
}

/** Everything the M8E gate needs except the batch approval, which is durable. */
function gateHarness({ iso = WEDNESDAY_2PM, prospect = null, washed = true, counselApproved = true, holidays = null } = {}) {
  const clock = now(iso);
  const p = prospect || goodProspect();
  const evidenceRows = evidenceFor(p, clock);

  const washStore = createWashStore({ now: clock, mode: "fixture" });
  if (washed) washStore.wash(NUMBER);

  const duplicateResolution = resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]);

  return {
    clock,
    prospect: p,
    engineOptions: { washStore, holidays: holidays || createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }), counselApproved },
    context: { evidenceRows, duplicateResolution },
  };
}

// ---------------------------------------------------------------------------

describe("E-5 canonical batch identity", () => {
  it("is deterministic: the same businesses on the same numbers always hash the same", () => {
    const a = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }, { rowId: "r2", prospectId: "p2", e164: "+61355500002" }] });
    const b = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }, { rowId: "r2", prospectId: "p2", e164: "+61355500002" }] });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.batchKey, b.batchKey);
  });

  it("does not depend on the order the caller happened to hold the rows in", () => {
    const forwards = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }, { rowId: "r2", prospectId: "p2", e164: "+61355500002" }] });
    const backwards = canonicalBatchIdentity({ members: [{ rowId: "r2", prospectId: "p2", e164: "+61355500002" }, { rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    assert.strictEqual(forwards.batchKey, backwards.batchKey);
  });

  it("carries no clock and no random id — the same batch identifies the same on any day", () => {
    const a = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    const b = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    assert.strictEqual(a.batchKey, b.batchKey);
    assert.ok(!JSON.stringify(a).includes("2026"), "an identity that carried a timestamp could not be recognised tomorrow");
  });

  it("changes when a business is added", () => {
    const one = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    const two = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }, { rowId: "r2", prospectId: "p2", e164: "+61355500002" }] });
    assert.notStrictEqual(one.batchKey, two.batchKey);
  });

  it("changes when a business is removed", () => {
    const two = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }, { rowId: "r2", prospectId: "p2", e164: "+61355500002" }] });
    const one = canonicalBatchIdentity({ members: [{ rowId: "r2", prospectId: "p2", e164: "+61355500002" }] });
    assert.notStrictEqual(one.batchKey, two.batchKey);
  });

  it("changes when a number changes, because membership is who AND on what number", () => {
    const a = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    const b = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355509999" }] });
    assert.notStrictEqual(a.batchKey, b.batchKey);
  });

  it("changes when the campaign or the policy version changes", () => {
    const base = { members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] };
    const plain = canonicalBatchIdentity(base);
    assert.notStrictEqual(canonicalBatchIdentity({ ...base, campaignId: "spring" }).batchKey, plain.batchKey);
    assert.notStrictEqual(canonicalBatchIdentity({ ...base, policyVersion: "v2" }).batchKey, plain.batchKey);
  });

  it("does NOT change when the batch is renamed — a label is not the contents", () => {
    const base = { members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] };
    assert.strictEqual(canonicalBatchIdentity({ ...base, label: "Monday" }).batchKey, canonicalBatchIdentity({ ...base, label: "Tuesday" }).batchKey);
  });

  it("refuses an empty batch, a member with no number, and a repeated row", () => {
    assert.strictEqual(canonicalBatchIdentity({ members: [] }).code, "batch_empty");
    assert.strictEqual(canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1" }] }).code, "member_invalid");
    const dup = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }, { rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    assert.strictEqual(dup.code, "member_duplicated");
  });

  it("takes membership from the INCLUDED rows of an assembled batch, and nothing else", () => {
    const rows = [
      { rowId: "a", prospectId: "pa", canonicalNumber: "+61355500001", disposition: "included" },
      { rowId: "b", prospectId: "pb", canonicalNumber: "+61355500002", disposition: "pending" },
      { rowId: "c", prospectId: "pc", canonicalNumber: "+61355500003", disposition: "rejected" },
    ];
    assert.deepStrictEqual(membersFromBatch({ rows }).map((m) => m.rowId), ["a"]);
  });

  it("rejects an identity whose key does not match its own members", () => {
    const real = canonicalBatchIdentity({ members: [{ rowId: "r1", prospectId: "p1", e164: "+61355500001" }] });
    const forged = { ...real, members: [{ rowId: "r9", prospectId: "p9", e164: "+61355509999" }] };
    assert.strictEqual(verifyIdentity(forged).code, "identity_mismatch");
  });
});

// ---------------------------------------------------------------------------

describe("E-5 the pilot batch ceiling (L)", () => {
  it("is 25, and this test fails if anybody changes it without changing A-L9", () => {
    assert.strictEqual(DEFAULT_CAPS.maxBatchSize, 25, "maxBatchSize is the founder's pilot ceiling. A-L9 is the open question about raising it; it has not been answered.");
  });

  it("refuses to identify — and therefore to approve — a batch above the ceiling", () => {
    const members = Array.from({ length: DEFAULT_CAPS.maxBatchSize + 1 }, (_, i) => ({ rowId: `r${i}`, prospectId: `p${i}`, e164: `+6135550${String(1000 + i)}` }));
    const over = canonicalBatchIdentity({ members });
    assert.strictEqual(over.ok, false);
    assert.strictEqual(over.code, "batch_too_large");
    assert.match(over.message, /A-L9/);
  });

  it("permits exactly the ceiling", () => {
    const members = Array.from({ length: DEFAULT_CAPS.maxBatchSize }, (_, i) => ({ rowId: `r${i}`, prospectId: `p${i}`, e164: `+6135550${String(1000 + i)}` }));
    assert.strictEqual(canonicalBatchIdentity({ members }).ok, true);
  });

  it("cannot be raised by writing a bigger number on the identity", async () => {
    // maxBatchSize is not part of the hash — it is policy, not membership — so a
    // forged identity claiming a larger ceiling still hashes correctly. The
    // ceiling is therefore re-derived and clamped rather than trusted.
    const store = createInMemoryAcquisitionStore();
    const members = Array.from({ length: DEFAULT_CAPS.maxBatchSize + 5 }, (_, i) => ({ rowId: `r${i}`, prospectId: `p${i}`, e164: `+6135550${String(1000 + i)}` }));
    const roomy = canonicalBatchIdentity({ members, maxBatchSize: 1000 });
    assert.strictEqual(roomy.ok, true, "a caller may build one; it must not be approvable");

    const r = await recordBatchApproval({ store, now: now(), identity: roomy, approvedBy: FOUNDER, reason: "Raising my own ceiling." });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "batch_too_large");
    assert.strictEqual((await store.listDecisions({})).length, 0);
  });

  it("may be made STRICTER than the configured maximum, never looser", async () => {
    const store = createInMemoryAcquisitionStore();
    const members = Array.from({ length: 3 }, (_, i) => ({ rowId: `r${i}`, prospectId: `p${i}`, e164: `+6135550${String(1000 + i)}` }));
    const strict = canonicalBatchIdentity({ members, maxBatchSize: 2 });
    assert.strictEqual(strict.code, "batch_too_large");

    const fine = canonicalBatchIdentity({ members, maxBatchSize: 3 });
    assert.strictEqual((await recordBatchApproval({ store, now: now(), identity: fine, approvedBy: FOUNDER, reason: "Three is fine." })).ok, true);
  });

  it("an oversized batch cannot be approved even with a valid founder and reason", async () => {
    const store = createInMemoryAcquisitionStore();
    const members = Array.from({ length: DEFAULT_CAPS.maxBatchSize + 1 }, (_, i) => ({ rowId: `r${i}`, prospectId: `p${i}`, e164: `+6135550${String(1000 + i)}` }));
    const result = await recordBatchApproval({ store, now: now(), identity: canonicalBatchIdentity({ members }), approvedBy: FOUNDER, reason: "Trying it on." });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "batch_too_large");
    assert.strictEqual((await store.listDecisions({})).length, 0, "nothing may be written when the approval is refused");
  });
});

// ---------------------------------------------------------------------------

describe("E-5 the approval is durable, and it is a decision", () => {
  it("writes one append-only, hash-chained decision row and nothing else", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    await approveOne(store, p);

    const rows = await store.listDecisions({});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].entityType, "batch");
    assert.strictEqual(rows[0].event, EVENT_APPROVED);
    assert.strictEqual(rows[0].decision, "approve");
    assert.strictEqual(rows[0].actorKind, "human");
    assert.strictEqual(verifyRows(rows).ok, true);
  });

  it("records who, when, why, the exact membership and the hash", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const identity = await approveOne(store, p);

    const state = await loadBatchApproval({ store, batchKey: identity.batchKey });
    assert.strictEqual(state.status, STATUS.APPROVED);
    assert.strictEqual(state.approval.approvedBy, FOUNDER);
    assert.strictEqual(state.approval.approvedAt, new Date(WEDNESDAY_2PM).toISOString());
    assert.strictEqual(state.approval.membershipHash, identity.membershipHash);
    assert.strictEqual(state.approval.recordCount, 1);
    assert.deepStrictEqual(state.approval.members.map((m) => m.prospectId), [p.prospectId]);
    assert.match(state.approval.reason, /pilot/);
  });

  it("says on the record itself that it is not permission to call", async () => {
    const store = createInMemoryAcquisitionStore();
    await approveOne(store, goodProspect());
    const rows = await store.listDecisions({ entityType: "batch" });
    assert.match(rows[0].detail.authorises, /NOT permission to place a call/i);
    assert.match(rows[0].detail.authorises, /M8E/);
  });

  it("survives the process: a store handed to brand new services still answers approved", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const identity = await approveOne(store, p);

    // Everything that held the approval in memory is destroyed. The store is
    // what a database would be: the only thing that outlived the process.
    const rehydrated = await loadBatchApproval({ store: createInMemoryAcquisitionStore({ seed: { decisions: await store.listDecisions({}) } }), batchKey: identity.batchKey });
    assert.strictEqual(rehydrated.status, STATUS.APPROVED);
    assert.strictEqual(rehydrated.approval.approvedBy, FOUNDER);
  });

  it("requires a named person, and refuses a system actor", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = canonicalBatchIdentity({ members: [memberOf(goodProspect())] });

    assert.strictEqual((await recordBatchApproval({ store, now: now(), identity, approvedBy: "", reason: "x" })).code, "approver_missing");
    for (const impostor of ["system", "aida", "automation", "AI", "claude", "bot", "scheduler"]) {
      const r = await recordBatchApproval({ store, now: now(), identity, approvedBy: impostor, reason: "Approving myself." });
      assert.strictEqual(r.code, "approver_not_human", `"${impostor}" must not be able to approve a batch`);
    }
    assert.strictEqual((await store.listDecisions({})).length, 0);
  });

  it("requires a reason — an approval nobody can explain is not one", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = canonicalBatchIdentity({ members: [memberOf(goodProspect())] });
    assert.strictEqual((await recordBatchApproval({ store, now: now(), identity, approvedBy: FOUNDER, reason: "   " })).code, "reason_required");
  });

  it("has no automatic mode: there is no default approver anywhere in the module", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-batch-approval.js"), "utf8");
    assert.ok(!/approvedBy\s*=\s*["'`]/.test(src), "a default approver would make an unattended approval possible");
    assert.ok(!/autoApprove|approveAll|--yes/i.test(src));
  });
});

// ---------------------------------------------------------------------------

describe("E-5 idempotency", () => {
  it("approving the exact same batch twice does not write a second row", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = canonicalBatchIdentity({ members: [memberOf(goodProspect())] });

    const first = await recordBatchApproval({ store, now: now(), identity, approvedBy: FOUNDER, reason: "Pilot." });
    const second = await recordBatchApproval({ store, now: now("2026-08-06T04:00:00Z"), identity, approvedBy: FOUNDER, reason: "Pilot." });

    assert.strictEqual(first.created, true);
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.replayed, true);
    assert.strictEqual((await store.listDecisions({ entityType: "batch" })).length, 1);
    assert.strictEqual(second.approval.approvedAt, first.approval.approvedAt, "the ORIGINAL approval is what stands");
  });

  it("a second approver of an already-approved batch does not fork it", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = canonicalBatchIdentity({ members: [memberOf(goodProspect())] });
    await recordBatchApproval({ store, now: now(), identity, approvedBy: FOUNDER, reason: "Pilot." });
    const again = await recordBatchApproval({ store, now: now(), identity, approvedBy: "Someone Else", reason: "Me too." });

    assert.strictEqual(again.created, false);
    assert.strictEqual(again.approval.approvedBy, FOUNDER);
    assert.strictEqual((await store.listDecisions({ entityType: "batch" })).length, 1);
  });

  it("a mutated batch needs its OWN approval and does not inherit the old one", async () => {
    const store = createInMemoryAcquisitionStore();
    const a = goodProspect();
    const b = goodProspect({ name: "Southside Locks", suburb: "Prahran", phone: "(03) 5550 1099" });

    const one = canonicalBatchIdentity({ members: [memberOf(a)] });
    await recordBatchApproval({ store, now: now(), identity: one, approvedBy: FOUNDER, reason: "Pilot." });

    const two = canonicalBatchIdentity({ members: [memberOf(a), memberOf(b, OTHER_NUMBER)] });
    assert.notStrictEqual(two.batchKey, one.batchKey);

    const fresh = await checkDurableFreshness({ store, identity: two });
    assert.strictEqual(fresh.fresh, false);
    assert.strictEqual(fresh.code, BATCH_APPROVAL_CODES.MISSING);
    assert.match(fresh.message, /membership has changed/i);
  });

  it("an approval object replayed against a different batch approves nothing", async () => {
    const store = createInMemoryAcquisitionStore();
    const a = goodProspect();
    const b = goodProspect({ name: "Southside Locks", suburb: "Prahran", phone: "(03) 5550 1099" });

    const approvedIdentity = canonicalBatchIdentity({ members: [memberOf(a)] });
    await recordBatchApproval({ store, now: now(), identity: approvedIdentity, approvedBy: FOUNDER, reason: "Pilot." });

    // The attacker keeps the approved key and swaps the contents underneath it.
    const replay = { ...approvedIdentity, members: [memberOf(b, OTHER_NUMBER)] };
    const result = await recordBatchApproval({ store, now: now(), identity: replay, approvedBy: FOUNDER, reason: "Slipping one in." });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "identity_mismatch");

    // And the durable approval still covers only the business it always did.
    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: b.prospectId, e164: OTHER_NUMBER });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.MISSING);
  });

  it("re-reading never duplicates: the fold is stable however often it is run", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = await approveOne(store, goodProspect());
    const reads = await Promise.all([1, 2, 3].map(() => loadBatchApproval({ store, batchKey: identity.batchKey })));
    for (const r of reads) assert.strictEqual(r.approval.auditId, reads[0].approval.auditId);
  });

  it("concurrent approvals of the same batch resolve to one row, not a fork", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = canonicalBatchIdentity({ members: [memberOf(goodProspect())] });

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => recordBatchApproval({ store, now: now(), identity, approvedBy: FOUNDER, reason: "Pilot." }))
    );

    assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.message)));
    assert.strictEqual(results.filter((r) => r.created).length, 1, "exactly one writer may create the approval");
    const rows = await store.listDecisions({ entityType: "batch" });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(verifyRows(await store.listDecisions({})).ok, true, "the chain must not fork");
  });
});

// ---------------------------------------------------------------------------

describe("E-5 withdrawal, without erasing what happened", () => {
  it("stops covering the batch, and keeps the approval readable", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const identity = await approveOne(store, p);

    const revoked = await revokeBatchApproval({ store, now: now(), batchKey: identity.batchKey, actor: FOUNDER, reason: "Wrong list." });
    assert.strictEqual(revoked.ok, true);

    const state = await loadBatchApproval({ store, batchKey: identity.batchKey });
    assert.strictEqual(state.status, STATUS.WITHDRAWN);
    assert.strictEqual(state.approval, null);
    assert.strictEqual(state.previousApproval.approvedBy, FOUNDER, "the approval happened and the record must show it");
    assert.strictEqual(state.history.length, 2);

    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: p.prospectId, e164: NUMBER });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.MISSING);
  });

  it("deletes nothing — both rows remain and the chain still verifies", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = await approveOne(store, goodProspect());
    await revokeBatchApproval({ store, now: now(), batchKey: identity.batchKey, actor: FOUNDER, reason: "Wrong list." });

    const rows = await store.listDecisions({});
    assert.deepStrictEqual(rows.map((r) => r.event), [EVENT_APPROVED, EVENT_WITHDRAWN]);
    assert.strictEqual(verifyRows(rows).ok, true);
  });

  it("refuses to withdraw what is not approved, and requires who and why", async () => {
    const store = createInMemoryAcquisitionStore();
    const identity = await approveOne(store, goodProspect());
    assert.strictEqual((await revokeBatchApproval({ store, now: now(), batchKey: "ba_nothing", actor: FOUNDER, reason: "x" })).code, "not_approved");
    assert.strictEqual((await revokeBatchApproval({ store, now: now(), batchKey: identity.batchKey, actor: "", reason: "x" })).code, "actor_missing");
    assert.strictEqual((await revokeBatchApproval({ store, now: now(), batchKey: identity.batchKey, actor: FOUNDER, reason: "" })).code, "reason_required");
  });

  it("re-approving after a withdrawal is a new approval, not a resurrection", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const identity = await approveOne(store, p);
    await revokeBatchApproval({ store, now: now(), batchKey: identity.batchKey, actor: FOUNDER, reason: "Wrong list." });

    const again = await recordBatchApproval({ store, now: now("2026-08-06T04:00:00Z"), identity, approvedBy: FOUNDER, reason: "Checked it properly this time." });
    assert.strictEqual(again.created, true);
    assert.strictEqual((await store.listDecisions({ entityType: "batch" })).length, 3);
    assert.strictEqual((await loadBatchApproval({ store, batchKey: identity.batchKey })).approval.approvedAt, "2026-08-06T04:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------

describe("E-5 what the gate asks: is this business covered, right now", () => {
  it("finds the approval without being told which batch — the restart path", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    await approveOne(store, p);

    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: p.prospectId, e164: NUMBER });
    assert.strictEqual(verdict.approved, true);
    assert.strictEqual(verdict.source, "durable");
    assert.strictEqual(verdict.approvedBy, FOUNDER);
  });

  it("refuses a business that is in no approved batch", async () => {
    const store = createInMemoryAcquisitionStore();
    await approveOne(store, goodProspect());
    const stranger = goodProspect({ name: "Southside Locks", suburb: "Prahran", phone: "(03) 5550 1099" });
    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: stranger.prospectId, e164: OTHER_NUMBER });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.MISSING);
  });

  it("refuses when the number that would be dialled is not the one that was approved", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    await approveOne(store, p, { e164: NUMBER });

    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: p.prospectId, e164: OTHER_NUMBER });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.stale, true, "a changed number is a changed membership, not a compliance problem");
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.STALE);
  });

  it("a named batchKey narrows the lookup and confers nothing", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: p.prospectId, e164: NUMBER, batchKey: "ba_whatever_i_like" });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.MISSING);
  });

  it("an approved batch that does not contain this business does not cover it", async () => {
    const store = createInMemoryAcquisitionStore();
    const inBatch = goodProspect();
    const identity = await approveOne(store, inBatch);
    const outsider = goodProspect({ name: "Southside Locks", suburb: "Prahran", phone: "(03) 5550 1099" });

    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: outsider.prospectId, e164: OTHER_NUMBER, batchKey: identity.batchKey });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.NOT_A_MEMBER);
  });

  it("an in-process `batch_approved` audit row confers nothing durable", async () => {
    // acquisition-batch.js writes this event name for its own session log. If
    // one is ever persisted it must not be read as a durable approval.
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const identity = canonicalBatchIdentity({ members: [memberOf(p)] });
    const { hydrateLog } = require("../src/services/acquisition-decision-log");
    const { log } = await hydrateLog({ store, now: now() });
    await store.appendDecision(
      log.record({
        entityType: "batch",
        entityId: identity.batchKey,
        event: "batch_approved",
        decision: "approve",
        actor: FOUNDER,
        actorKind: "human",
        reason: "The old in-process event name.",
        detail: { batchHash: identity.membershipHash, members: identity.members },
      })
    );

    assert.strictEqual((await loadBatchApproval({ store, batchKey: identity.batchKey })).status, STATUS.NONE);
    assert.strictEqual((await resolveBatchApprovalForProspect({ store, prospectId: p.prospectId, e164: NUMBER })).approved, false);
  });
});

// ---------------------------------------------------------------------------

describe("E-5 fail closed", () => {
  const unreadable = () => ({
    ...createInMemoryAcquisitionStore(),
    async listDecisions() {
      throw new Error("connection terminated unexpectedly");
    },
  });

  it("an unreadable approval store is `unavailable`, never `not approved`", async () => {
    const verdict = await resolveBatchApprovalForProspect({ store: unreadable(), prospectId: "pr_x", e164: NUMBER });
    assert.strictEqual(verdict.approved, false);
    assert.strictEqual(verdict.unavailable, true);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.STORE_UNAVAILABLE);
    assert.match(verdict.message, /could not be established/i);
  });

  it("is unavailable on the named-batch path too, not only the search path", async () => {
    const verdict = await resolveBatchApprovalForProspect({ store: unreadable(), prospectId: "pr_x", e164: NUMBER, batchKey: "ba_abc" });
    assert.strictEqual(verdict.unavailable, true);
    assert.strictEqual(verdict.code, BATCH_APPROVAL_CODES.STORE_UNAVAILABLE);
  });

  it("will not APPROVE against a store it cannot read first", async () => {
    const identity = canonicalBatchIdentity({ members: [memberOf(goodProspect())] });
    const r = await recordBatchApproval({ store: unreadable(), now: now(), identity, approvedBy: FOUNDER, reason: "Pilot." });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, BATCH_APPROVAL_CODES.STORE_UNAVAILABLE);
  });

  it("the engine reports the unreadable store as ITS failure, with its own code", () => {
    const engine = createEligibilityEngine({ now: now() });
    const decision = engine.evaluate(goodProspect(), { batch: { unavailable: true, approved: false, source: "unavailable", message: "The store could not be read." } });
    const batchCheck = decision.failedChecks.find((f) => f.check === "batch_approval");
    assert.strictEqual(batchCheck.code, ELIGIBILITY_CODES.BATCH_STORE_UNAVAILABLE);
    assert.notStrictEqual(batchCheck.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED, "'we could not look' must never be reported as 'you did not approve'");
    assert.strictEqual(decision.batchSource, "unavailable");
  });
});

// ---------------------------------------------------------------------------

describe("E-5 at the final M8E gate", () => {
  it("1. no durable approval ⇒ refused, whatever else is in order", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
    assert.strictEqual(decision.dial, null);
  });

  it("2. THE MILESTONE: the caller says approved and the store says no ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, {
      ...context,
      batch: { approved: true, stale: false, batchHash: "whatever", approvedBy: "Peter Dang", source: "durable" },
    });

    assert.strictEqual(decision.authorised, false, "a caller-supplied approval must not clear the batch gate");
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
    assert.strictEqual(decision.batchSource, "durable", "the gate reports the source it actually used");
    assert.strictEqual(decision.dial, null);
  });

  it("3. a durable approval for exactly this business ⇒ the batch gate passes and a slip is minted", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    const identity = await approveOne(store, prospect, { clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    assert.strictEqual(decision.batchSource, "durable");
    assert.strictEqual(decision.batchKey, identity.batchKey);
    assert.ok(isAuthorisedDial(decision.dial));
  });

  it("4. an approval covering a different number ⇒ refused as stale", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await approveOne(store, prospect, { clock, e164: OTHER_NUMBER });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
    const batchCheck = decision.failedChecks.find((f) => f.check === "batch_approval");
    assert.match(batchCheck.message, /does not describe what would be called/i);
  });

  it("5. approved, then suppressed ⇒ STILL refused, and by suppression", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await approveOne(store, prospect, { clock });

    await store.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state }),
      e164: NUMBER,
      actor: "founder",
      actorKind: "human",
      note: "Asked never to be contacted again.",
      suppressedAt: new Date(WEDNESDAY_2PM).toISOString(),
    });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED, "batch approval must never outrank an opt-out");
  });

  it("6. approved, and the DNCR wash never happened ⇒ STILL refused, and the batch is NOT stale", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ washed: false });
    await approveOne(store, prospect, { clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.ok([ELIGIBILITY_CODES.DNCR_UNKNOWN, ELIGIBILITY_CODES.DNCR_STALE].includes(decision.code), decision.code);

    // THE SEPARATION, PINNED. The membership is exactly what was approved; it is
    // the world that changed. A founder must not be sent to re-approve a list
    // that has not moved.
    assert.strictEqual(decision.failedChecks.some((f) => f.check === "batch_approval"), false);
  });

  it("7. approved, outside the calling window ⇒ STILL refused, batch approval intact", async () => {
    const store = createInMemoryAcquisitionStore();
    const midnight = "2026-08-05T16:00:00Z";
    const { clock, prospect, engineOptions, context } = gateHarness({ iso: midnight });
    await approveOne(store, prospect, { clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
    assert.strictEqual(decision.failedChecks.some((f) => f.check === "batch_approval"), false);
  });

  it("8. approved, attempt policy unapproved ⇒ STILL refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await approveOne(store, prospect, { clock });

    const decision = await createDialAuthoriser({
      now: clock,
      store,
      engineOptions: { ...engineOptions, attemptPolicy: createAttemptPolicy() },
    }).authorise(prospect, context);

    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.POLICY_UNAPPROVED);
  });

  it("9. the approval store being unreadable refuses with its own code, not with 'not approved'", async () => {
    const base = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    const store = {
      ...base,
      async listDecisions() {
        throw new Error("connection terminated unexpectedly");
      },
    };
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, AUTHORISATION_CODES.BATCH_APPROVAL_STORE_UNAVAILABLE);
    assert.strictEqual(decision.batchSource, "unavailable");
    assert.strictEqual(decision.dial, null);
  });

  it("10. an unreadable approval store still does not outrank a known opt-out", async () => {
    const base = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await base.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state }),
      e164: NUMBER,
      actor: "founder",
      actorKind: "human",
      note: "Never again.",
      suppressedAt: new Date(WEDNESDAY_2PM).toISOString(),
    });
    const store = {
      ...base,
      async listDecisions() {
        throw new Error("connection terminated unexpectedly");
      },
    };
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED, "suppression outranks our own read failure");
  });

  it("11. only the gate mints a slip — an approval carries nothing that could dial", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    const identity = await approveOne(store, p);
    const state = await loadBatchApproval({ store, batchKey: identity.batchKey });

    assert.strictEqual(isAuthorisedDial(state.approval), false);
    for (const [key, value] of Object.entries(state.approval)) {
      assert.notStrictEqual(typeof value, "function", `${key} on a durable approval must not be callable`);
    }
    for (const forbidden of ["dial", "call", "place", "dispatch", "ring", "send", "execute", "start"]) {
      assert.strictEqual(typeof state.approval[forbidden], "undefined");
    }
  });
});

// ---------------------------------------------------------------------------

describe("E-5 fail-closed ratchets", () => {
  const gateSrc = () => fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
  const approvalSrc = () => fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-batch-approval.js"), "utf8");

  it("the gate never spreads the caller's context without removing `batch` first", () => {
    const code = gateSrc()
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");

    assert.ok(/batch:\s*callerBatch\s*=\s*null,\s*\.\.\.callerContext/.test(code), "the caller's batch must be destructured off the context");
    assert.ok(!/evaluate\(prospect,\s*\{\s*\.\.\.context\b/.test(code), "spreading the raw context would put a caller-supplied approval back in front of the engine");
    assert.ok(/batch:\s*batchApproval/.test(code), "the durable approval must be bound last and unconditionally");
  });

  it("the gate actually reads durable approval — the call cannot be deleted quietly", () => {
    assert.match(gateSrc(), /resolveBatchApprovalForProspect\(/);
  });

  it("a durable approval can only be minted with actorKind human, written in one place", () => {
    const matches = approvalSrc().match(/actorKind:\s*"(\w+)"/g) || [];
    assert.ok(matches.length > 0);
    for (const m of matches) assert.strictEqual(m, 'actorKind: "human"', "a system actor must never be able to record a batch approval");
  });

  it("the approval module cannot place, schedule or prepare a call", () => {
    const src = approvalSrc();
    for (const pattern of [/require\(["'](twilio|axios|node-fetch|nodemailer|retell-sdk|@retell)/, /\bfetch\s*\(/, /https?\.request\s*\(/]) {
      assert.ok(!pattern.test(src), `the approval module must not contain ${pattern}`);
    }
    const exported = Object.keys(require("../src/services/acquisition-batch-approval"));
    for (const forbidden of ["dial", "call", "dispatch", "place", "ring", "send", "execute", "start"]) {
      assert.ok(!exported.includes(forbidden), `the approval module must not export ${forbidden}`);
    }
  });

  it("the membership hash does NOT cover eligibility — a compliance change must not read as a membership change", () => {
    const src = approvalSrc();
    const hashBlock = src.slice(src.indexOf("const membershipHash = contentHash("), src.indexOf("return Object.freeze({\n    ok: true"));
    for (const forbidden of ["eligible", "code:", "washedAt", "suppressed", "attempts"]) {
      assert.ok(!hashBlock.includes(forbidden), `membershipHash must not include ${forbidden} — see this module's header`);
    }
  });

  it("an authorised decision always says the approval came from durable state", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await approveOne(store, prospect, { clock });
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    assert.strictEqual(decision.batchSource, "durable");
  });

  it("the engine labels a caller-built approval as such, so nothing can claim it was durable", () => {
    const engine = createEligibilityEngine({ now: now() });
    const decision = engine.evaluate(goodProspect(), { batch: { approved: true, batchHash: "x", approvedBy: FOUNDER } });
    assert.strictEqual(decision.batchSource, "caller");
  });

  it("A-L9 is not closed by this milestone: nothing here names a second approver role", () => {
    const src = approvalSrc();
    assert.ok(!/secondApprover|coApprover|approvers\s*:/i.test(src), "A-L9 — who else may approve, and whether a threshold needs two — is still an open governance question");
  });
});

// ---------------------------------------------------------------------------

describe("E-5 the founder-facing batch flow, end to end", () => {
  it("assembles, includes, submits, approves in process, and then approves durably", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = now();
    const p = goodProspect();
    const evidenceRows = evidenceFor(p, clock);
    const duplicateResolution = resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]);

    const washStore = createWashStore({ now: clock, mode: "fixture" });
    washStore.wash(NUMBER);
    const engine = createEligibilityEngine({
      now: clock,
      washStore,
      suppression: require("../src/services/acquisition-suppression").createSuppressionList({ now: clock }),
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }),
      counselApproved: true,
    });

    let batch = assembleBatch({
      prospects: [p],
      evaluate: (prospect, ctx) => engine.evaluate(prospect, { ...ctx, batch: { approved: true, batchHash: "assembly", approvedBy: FOUNDER } }),
      evidenceFor: () => evidenceRows,
      duplicateResolution,
      now: clock,
      batchId: "pilot-1",
    });

    batch = recordFounderAction(batch, { prospectId: p.prospectId, action: "approve_record", actor: FOUNDER, now: clock }).batch;
    batch = submitForApproval(batch, { actor: FOUNDER, now: clock }).batch;
    const approvedInProcess = approveBatch(batch, { founder: FOUNDER, now: clock });
    assert.strictEqual(approvedInProcess.ok, true, approvedInProcess.message);

    // ── AND NOW THE PART E-5 ADDS ────────────────────────────────────
    const identity = canonicalBatchIdentity({ members: membersFromBatch(approvedInProcess.batch), label: batch.batchId });
    assert.strictEqual(identity.ok, true);
    assert.strictEqual(identity.recordCount, 1);

    const durable = await recordBatchApproval({ store, now: clock, identity, approvedBy: FOUNDER, reason: "First pilot batch." });
    assert.strictEqual(durable.created, true);

    // The in-process approval object is gone; only the store remains.
    const verdict = await resolveBatchApprovalForProspect({ store, prospectId: p.prospectId, e164: NUMBER });
    assert.strictEqual(verdict.approved, true);
    assert.strictEqual(verdict.batchKey, identity.batchKey);
  });

  it("lists what has been approved, newest first, with what each one covers", async () => {
    const store = createInMemoryAcquisitionStore();
    const a = goodProspect();
    const b = goodProspect({ name: "Southside Locks", suburb: "Prahran", phone: "(03) 5550 1099" });

    await recordBatchApproval({ store, now: now(), identity: canonicalBatchIdentity({ members: [memberOf(a)], label: "monday" }), approvedBy: FOUNDER, reason: "One." });
    await recordBatchApproval({ store, now: now("2026-08-06T04:00:00Z"), identity: canonicalBatchIdentity({ members: [memberOf(b, OTHER_NUMBER)], label: "tuesday" }), approvedBy: FOUNDER, reason: "Two." });

    const listed = await listBatchApprovals({ store });
    assert.strictEqual(listed.available, true);
    assert.strictEqual(listed.batches.length, 2);
    assert.strictEqual(listed.batches[0].approval.label, "tuesday", "newest first");
    assert.strictEqual(listed.batches[0].approval.members.length, 1);
  });
});
