// LOCKSMITH ACQUISITION M8L — durable duplicate resolution.
//
// M8L succeeds only if a caller who has every reason to know a record is a
// duplicate cannot authorise a call to it by analysing that record on its own.
//
// ── THE BUG BEING CLOSED, REPRODUCED FIRST ──────────────────────────
// The first describe block below builds the exact object every dry run, proof
// and test used to build — `resolveDuplicates([oneProspect])` — and shows that
// it declares a known duplicate unique. That is not a contrived attack: it is
// what the whole repository did, honestly, using the same module that would have
// caught the duplicate, pointed at nothing.
//
// The collaborators are the real modules throughout. A test that faked the
// review queue would prove nothing about what refuses a call.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveDuplicateStateForProspect,
  summariseDuplicateState,
  DUPLICATE_STATE,
  DUPLICATE_STATE_CODES,
} = require("../src/services/acquisition-duplicate-state");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { openReviewItem, resolveReviewItem, REVIEW_DECISIONS, STATUS } = require("../src/services/acquisition-review-queue");
const { createDialAuthoriser, isAuthorisedDial, AUTHORISATION_CODES } = require("../src/services/acquisition-authorisation");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { resolveDuplicates, duplicateStatusFor } = require("../src/services/acquisition-dedupe");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createProspect, transitionProspect, identityFingerprint } = require("../src/services/acquisition-prospect");
const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
const { projectReviewResolution } = require("../src/services/acquisition-review-projection");
const { FOUNDER_CALLING_POLICY, createCallingPolicyApproval } = require("../src/services/acquisition-calling-approval");

const MELBOURNE = "Australia/Melbourne";
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";
const OTHER_NUMBER = "+61355501099";
const FOUNDER = "Peter Dang";

const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

function makeProspect({ name = "Northside Lock & Key", phone = "(03) 5550 1042", suburb = "Brunswick" } = {}) {
  let p = createProspect({
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
  }).prospect;
  for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
    p = transitionProspect(p, to, { actor: FOUNDER, reason: "test", now: now() }).prospect;
  }
  return p;
}

function evidenceFor(prospect, clock = now()) {
  const ledger = createEvidenceLedger({ now: clock });
  for (const [kind, value] of [
    ["business_name", prospect.businessName],
    ["trade_category", "Locksmith"],
    ["phone", prospect.phones[0].raw],
  ]) {
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "test", source: { url: "https://northsidelockandkey.example.com.au/contact" } });
  }
  return ledger.forProspect(prospect.prospectId);
}

/** Everything the M8E gate needs except the two durable answers. */
function gateHarness({ iso = WEDNESDAY_2PM, prospect = null, washed = true, e164 = NUMBER, holidays = null, callingPolicyApproval = FOUNDER_CALLING_POLICY } = {}) {
  const clock = now(iso);
  const p = prospect || makeProspect();
  const evidenceRows = evidenceFor(p, clock);
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  if (washed) washStore.wash(e164);
  return {
    clock,
    prospect: p,
    engineOptions: { washStore, holidays: holidays || createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }), callingPolicyApproval },
    // NO duplicateResolution, and no batch. Both are durable now.
    context: { evidenceRows },
  };
}

/** Persist the prospect and durably approve a batch holding it. */
async function makeCallable(store, prospect, clock = now(), e164 = NUMBER) {
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164 }] });
  const r = await recordBatchApproval({ store, now: clock, identity, approvedBy: FOUNDER, reason: "M8L tests." });
  assert.strictEqual(r.ok, true, r.message);
  return identity;
}

/** An ambiguous candidate, held for review exactly as the import would hold it. */
async function openDuplicateReview(store, candidate, { clock = now(), possibleMatches = ["pr_canonical_business"] } = {}) {
  const opened = await openReviewItem({
    candidate,
    reason: "This may be the same business as one already known.",
    signals: ["same_phone_number", "different_locality"],
    possibleMatches,
    store,
    now: clock,
  });
  assert.strictEqual(opened.created, true, "the review item must actually open");
  return opened;
}

// ---------------------------------------------------------------------------

describe("M8L the hole being closed", () => {
  it("resolveDuplicates over one record calls a known duplicate unique", () => {
    // Two differently-named businesses publishing ONE number — a shared
    // answering service, or a rebrand. acquisition-dedupe refuses to guess and
    // sends it to a human, which is exactly the case that must not be cleared
    // by an analysis that never saw the other record.
    const a = makeProspect();
    const b = makeProspect({ name: "Redgum Security Co", suburb: "Coburg" });

    // Analysed together, the pair is flagged.
    const both = resolveDuplicates([
      { ...a, numbers: [{ e164: NUMBER }] },
      { ...b, numbers: [{ e164: NUMBER }] },
    ]);
    const together = duplicateStatusFor(a.prospectId, both);
    assert.strictEqual(together.blocked, true, "the pair really is a duplicate concern");
    assert.strictEqual(together.requiresReview, true);

    // Analysed alone — the object every caller actually built — it is clean.
    const alone = resolveDuplicates([{ ...a, numbers: [{ e164: NUMBER }] }]);
    assert.strictEqual(duplicateStatusFor(a.prospectId, alone).blocked, false);
    assert.strictEqual(duplicateStatusFor(a.prospectId, alone).code, "unique");
  });

  it("and the engine used to accept that as resolution", () => {
    const a = makeProspect();
    const engine = createEligibilityEngine({ now: now() });
    const decision = engine.evaluate(a, { duplicateResolution: resolveDuplicates([{ ...a, numbers: [{ e164: NUMBER }] }]) });
    assert.strictEqual(decision.passedChecks.includes("duplicate"), true, "this is the behaviour M8L keeps for previews and removes from the gate");
    assert.strictEqual(decision.duplicateSource, "caller", "and it is now labelled so nothing mistakes it for durable");
  });
});

// ---------------------------------------------------------------------------

describe("M8L durable state answers all five questions", () => {
  it("UNRESOLVED — an open review item blocks", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    await openDuplicateReview(store, candidate);

    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.UNRESOLVED);
    assert.strictEqual(state.blocked, true);
    assert.strictEqual(state.code, DUPLICATE_STATE_CODES.REQUIRES_RESOLUTION);
    assert.strictEqual(state.source, "durable");
  });

  it("UNRESOLVED — needs_more_information leaves it open", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    await openDuplicateReview(store, candidate);
    const r = await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.NEEDS_MORE_INFORMATION, actor: FOUNDER, reason: "I cannot tell from this.", now: now() });
    assert.strictEqual(r.ok, true, r.message);

    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.UNRESOLVED);
    assert.strictEqual(state.blocked, true);
  });

  it("RESOLVED_DISTINCT — approve_as_new, once the prospect is stored", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    await openDuplicateReview(store, candidate);
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: FOUNDER, reason: "Different business — different owner.", now: now() });

    // The decision alone is not enough: nothing may be called from a record that
    // does not exist durably.
    const before = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(before.blocked, true);
    assert.strictEqual(before.code, DUPLICATE_STATE_CODES.NEVER_ASSESSED);

    await store.upsertProspect(candidate);
    const after = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(after.state, DUPLICATE_STATE.RESOLVED_DISTINCT);
    assert.strictEqual(after.resolved, true);
    assert.strictEqual(after.decidedBy, FOUNDER);
  });

  it("MERGED — the canonical business is the callable one, and it is named", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    const canonical = makeProspect({ name: "Brunswick Lock Specialists", suburb: "Brunswick" });
    await store.upsertProspect(canonical);
    await openDuplicateReview(store, candidate, { possibleMatches: [canonical.prospectId] });
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, actor: FOUNDER, reason: "Same business, two listings.", mergeTarget: canonical.prospectId, now: now() });

    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.MERGED);
    assert.strictEqual(state.blocked, true);
    assert.strictEqual(state.code, DUPLICATE_STATE_CODES.OF_CANONICAL);
    assert.strictEqual(state.canonicalId, canonical.prospectId);

    // And the canonical business is unaffected by being a merge target.
    const target = await resolveDuplicateStateForProspect({ store, prospectId: canonical.prospectId });
    assert.strictEqual(target.resolved, true, "the canonical identity stays callable");
  });

  it("REJECTED — as a duplicate", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    await openDuplicateReview(store, candidate);
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: FOUNDER, reason: "We already have them.", now: now() });

    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.REJECTED);
    assert.strictEqual(state.code, DUPLICATE_STATE_CODES.OF_CANONICAL);
  });

  it("REJECTED — as not a locksmith, reported as itself", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    await openDuplicateReview(store, candidate);
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH, actor: FOUNDER, reason: "They are a hardware shop.", now: now() });

    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.REJECTED);
    assert.strictEqual(state.code, DUPLICATE_STATE_CODES.REVIEW_REJECTED, "a rejection that is not about duplication must not be dressed up as one");
  });

  it("NEVER_ASSESSED — a record that exists only in memory", async () => {
    const store = createInMemoryAcquisitionStore();
    const state = await resolveDuplicateStateForProspect({ store, prospectId: makeProspect().prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.NEVER_ASSESSED);
    assert.strictEqual(state.blocked, true);
    assert.match(state.message, /never been assessed|has ever compared/i);
  });

  it("RESOLVED_DISTINCT — a stored prospect that was never contested", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = makeProspect();
    await store.upsertProspect(p);
    const state = await resolveDuplicateStateForProspect({ store, prospectId: p.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.RESOLVED_DISTINCT);
    assert.strictEqual(state.canonicalId, p.prospectId);
  });

  it("takes no caller hint — there is no parameter to point it elsewhere", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-duplicate-state.js"), "utf8");
    const sig = /async function resolveDuplicateStateForProspect\(\{([^}]*)\}/.exec(src);
    assert.ok(sig, "the signature must be readable");
    assert.deepStrictEqual(
      sig[1].split(",").map((s) => s.trim().split(/[=:]/)[0].trim()).filter(Boolean).sort(),
      ["prospectId", "store"],
      "a hint parameter is a way to point the lookup somewhere more convenient"
    );
  });
});

// ---------------------------------------------------------------------------

describe("M8L survives a restart", () => {
  it("a resolution recorded by one process is read by services built after it", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    const canonical = makeProspect({ name: "Brunswick Lock Specialists", suburb: "Brunswick" });
    await store.upsertProspect(canonical);
    await openDuplicateReview(store, candidate, { possibleMatches: [canonical.prospectId] });
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, actor: FOUNDER, reason: "Same business.", mergeTarget: canonical.prospectId, now: now() });

    // Everything that held the decision in memory is destroyed; only the rows
    // survive, exactly as a database would.
    const restarted = createInMemoryAcquisitionStore({
      seed: { decisions: await store.listDecisions({}), prospects: [canonical] },
    });

    const state = await resolveDuplicateStateForProspect({ store: restarted, prospectId: candidate.prospectId });
    assert.strictEqual(state.state, DUPLICATE_STATE.MERGED);
    assert.strictEqual(state.canonicalId, canonical.prospectId);
    assert.strictEqual(state.decidedBy, FOUNDER);
  });

  it("an exact re-import does not resurrect a rejected candidate", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    await openDuplicateReview(store, candidate);
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: FOUNDER, reason: "Already known.", now: now() });

    // The same file, imported again. The review queue refuses to reopen it.
    const reopened = await openReviewItem({ candidate, reason: "Same import, run twice.", store, now: now() });
    assert.strictEqual(reopened.created, false);
    assert.match(reopened.message, /Not reopened/i);

    // And even if something did persist it, the durable rejection still refuses.
    await store.upsertProspect(candidate);
    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.blocked, true);
    assert.strictEqual(state.state, DUPLICATE_STATE.REJECTED);
  });

  it("a merged candidate stays un-callable even after the lifecycle projection runs", async () => {
    const store = createInMemoryAcquisitionStore();
    const candidate = makeProspect();
    const canonical = makeProspect({ name: "Brunswick Lock Specialists", suburb: "Brunswick" });
    await store.upsertProspect(canonical);
    await store.upsertProspect(candidate); // the row that should not exist, existing anyway
    await openDuplicateReview(store, candidate, { possibleMatches: [canonical.prospectId] });
    await resolveReviewItem({ store, reviewId: `rv_${candidate.prospectId}`, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, actor: FOUNDER, reason: "Same business.", mergeTarget: canonical.prospectId, now: now() });

    // A merge moves no lifecycle, so nothing else would have blocked it.
    const projected = await projectReviewResolution({ store, reviewId: `rv_${candidate.prospectId}`, now: now() });
    assert.strictEqual(projected.ok, true);
    assert.strictEqual(projected.changed, false);

    const state = await resolveDuplicateStateForProspect({ store, prospectId: candidate.prospectId });
    assert.strictEqual(state.blocked, true, "the durable merge is what refuses it, not the lifecycle");
  });
});

// ---------------------------------------------------------------------------

describe("M8L fail closed", () => {
  const unreadable = (base) => ({
    ...base,
    async listDecisions() {
      throw new Error("connection terminated unexpectedly");
    },
  });

  it("an unreadable store is `unavailable`, never `no duplicate known`", async () => {
    const state = await resolveDuplicateStateForProspect({ store: unreadable(createInMemoryAcquisitionStore()), prospectId: "pr_x" });
    assert.strictEqual(state.unavailable, true);
    assert.strictEqual(state.resolved, false);
    assert.strictEqual(state.state, DUPLICATE_STATE.UNAVAILABLE);
    assert.strictEqual(state.code, DUPLICATE_STATE_CODES.STORE_UNAVAILABLE);
    assert.match(state.message, /could not be established/i);
  });

  it("an unreadable prospect table is also unavailable, not 'never assessed'", async () => {
    const base = createInMemoryAcquisitionStore();
    const store = { ...base, async loadProspect() { throw new Error("prospects table unreachable"); } };
    const state = await resolveDuplicateStateForProspect({ store, prospectId: "pr_x" });
    assert.strictEqual(state.unavailable, true);
    assert.strictEqual(state.code, DUPLICATE_STATE_CODES.STORE_UNAVAILABLE);
  });

  it("the engine reports it as OUR failure, with its own code", () => {
    const engine = createEligibilityEngine({ now: now() });
    const decision = engine.evaluate(makeProspect(), { duplicateState: { unavailable: true, blocked: true, resolved: false, state: "unavailable", code: DUPLICATE_STATE_CODES.STORE_UNAVAILABLE, message: "The store could not be read." } });
    const check = decision.failedChecks.find((f) => f.check === "duplicate");
    assert.strictEqual(check.code, ELIGIBILITY_CODES.DUPLICATE_STORE_UNAVAILABLE);
    assert.notStrictEqual(check.code, ELIGIBILITY_CODES.DUPLICATE_REVIEW, "'we could not look' must never read as 'a person has to decide'");
    assert.strictEqual(decision.duplicateSource, "unavailable");
  });

  it("a durable state present means the caller's resolution is not consulted at all", () => {
    const p = makeProspect();
    const engine = createEligibilityEngine({ now: now() });
    const decision = engine.evaluate(p, {
      // The caller says clean...
      duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }] }]),
      // ...and durable state says a person has not decided.
      duplicateState: { blocked: true, resolved: false, unavailable: false, state: "unresolved", code: DUPLICATE_STATE_CODES.REQUIRES_RESOLUTION, message: "A person has been asked and has not decided." },
    });
    const check = decision.failedChecks.find((f) => f.check === "duplicate");
    assert.strictEqual(check.code, ELIGIBILITY_CODES.DUPLICATE_REVIEW);
    assert.strictEqual(decision.duplicateSource, "durable");
  });
});

// ---------------------------------------------------------------------------

describe("M8L at the final M8E gate", () => {
  it("1. a prospect nothing has ever assessed ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    // Batch approved, everything else fine — but no stored record.
    const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164: NUMBER }] });
    await recordBatchApproval({ store, now: clock, identity, approvedBy: FOUNDER, reason: "M8L." });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.DUPLICATE_NEVER_ASSESSED);
    assert.strictEqual(decision.dial, null);
  });

  it("2. THE MILESTONE: the caller supplies a clean resolution and the store says unresolved ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    await openDuplicateReview(store, prospect, { clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, {
      ...context,
      // Exactly the object the whole repository used to build.
      duplicateResolution: resolveDuplicates([{ ...prospect, numbers: [{ e164: NUMBER }], hasOfficialSource: true }]),
    });

    assert.strictEqual(decision.authorised, false, "a caller-supplied resolution must not clear the duplicate gate");
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.DUPLICATE_REVIEW);
    assert.strictEqual(decision.duplicateSource, "durable", "the gate reports the source it actually used");
    assert.strictEqual(decision.dial, null);
  });

  it("3. durably resolved as distinct ⇒ the duplicate gate passes and a slip is minted", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    await openDuplicateReview(store, prospect, { clock });
    await resolveReviewItem({ store, reviewId: `rv_${prospect.prospectId}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: FOUNDER, reason: "Different business.", now: clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    assert.strictEqual(decision.duplicateSource, "durable");
    assert.ok(isAuthorisedDial(decision.dial));
  });

  it("4. merged into a canonical business ⇒ refused, and the canonical is named", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    const canonical = makeProspect({ name: "Brunswick Lock Specialists", suburb: "Brunswick" });
    await store.upsertProspect(canonical);
    await makeCallable(store, prospect, clock);
    await openDuplicateReview(store, prospect, { clock, possibleMatches: [canonical.prospectId] });
    await resolveReviewItem({ store, reviewId: `rv_${prospect.prospectId}`, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, actor: FOUNDER, reason: "Same business.", mergeTarget: canonical.prospectId, now: clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.DUPLICATE_OF_CANONICAL);
    assert.match(decision.message, new RegExp(canonical.prospectId));
  });

  it("5. rejected as a duplicate ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    await openDuplicateReview(store, prospect, { clock });
    await resolveReviewItem({ store, reviewId: `rv_${prospect.prospectId}`, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: FOUNDER, reason: "Already known.", now: clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.DUPLICATE_OF_CANONICAL);
  });

  it("6. the duplicate store being unreadable refuses with its own code", async () => {
    const base = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(base, prospect, clock);
    const store = { ...base, async loadProspect() { throw new Error("prospects table unreachable"); } };

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.strictEqual(decision.code, AUTHORISATION_CODES.DUPLICATE_RESOLUTION_STORE_UNAVAILABLE);
    assert.strictEqual(decision.duplicateSource, "unavailable");
    assert.strictEqual(decision.dial, null);
  });
});

// ---------------------------------------------------------------------------

describe("M8L does not bypass any other gate", () => {
  /** Durably resolved as distinct, callable, and then something else goes wrong. */
  async function resolvedAndCallable(store, prospect, clock) {
    await makeCallable(store, prospect, clock);
    await openDuplicateReview(store, prospect, { clock });
    await resolveReviewItem({ store, reviewId: `rv_${prospect.prospectId}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: FOUNDER, reason: "Distinct.", now: clock });
  }

  it("resolved + suppressed ⇒ refused on suppression", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await resolvedAndCallable(store, prospect, clock);
    await store.appendSuppression({
      reason: "opt_out",
      scope: "business",
      fingerprint: identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state }),
      e164: NUMBER,
      actor: "founder",
      actorKind: "human",
      note: "Never again.",
      suppressedAt: new Date(WEDNESDAY_2PM).toISOString(),
    });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.SUPPRESSED);
  });

  it("resolved + no DNCR wash ⇒ refused on DNCR, and the duplicate check still passes", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ washed: false });
    await resolvedAndCallable(store, prospect, clock);

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, false);
    assert.ok([ELIGIBILITY_CODES.DNCR_UNKNOWN, ELIGIBILITY_CODES.DNCR_STALE].includes(decision.code), decision.code);
    assert.strictEqual(decision.failedChecks.some((f) => f.check === "duplicate"), false);
  });

  it("resolved + batch not approved ⇒ founder_batch_approval_missing", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await store.upsertProspect(prospect);
    await openDuplicateReview(store, prospect, { clock });
    await resolveReviewItem({ store, reviewId: `rv_${prospect.prospectId}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: FOUNDER, reason: "Distinct.", now: clock });

    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
  });

  it("resolved + outside the calling window ⇒ refused on the window", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ iso: "2026-08-05T16:00:00Z" });
    await resolvedAndCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("resolved + a public holiday ⇒ refused on the window", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ holidays: { isHoliday: () => true, describe: () => "A public holiday." } });
    await resolvedAndCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("resolved + attempt policy unapproved ⇒ refused on policy", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await resolvedAndCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions: { ...engineOptions, attemptPolicy: createAttemptPolicy() } }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.POLICY_UNAPPROVED);
  });

  it("resolved + calling policy not adopted ⇒ refused on the calling policy", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ callingPolicyApproval: createCallingPolicyApproval() });
    await resolvedAndCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.CALLING_POLICY_UNAPPROVED);
  });

  it("resolved + kill switch ⇒ refused on the campaign", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await resolvedAndCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, { ...context, campaign: { killSwitchEngaged: true } });
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.KILL_SWITCH);
  });

  it("resolved + lifecycle not review_approved ⇒ refused on the record", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = makeProspect();
    const notApproved = { ...p, lifecycle: "review_pending" };
    const { clock, prospect, engineOptions, context } = gateHarness({ prospect: notApproved });
    await resolvedAndCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.code, ELIGIBILITY_CODES.RECORD_NOT_APPROVED);
  });
});

// ---------------------------------------------------------------------------

describe("M8L fail-closed ratchets", () => {
  const gateSrc = () => fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
  const stateSrc = () => fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-duplicate-state.js"), "utf8");

  it("the gate destructures duplicateResolution off the caller's context", () => {
    const code = gateSrc()
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    const destructure = /const \{([^}]*)\}\s*=\s*context \|\| \{\};/.exec(code);
    assert.ok(destructure, "authorise() must destructure the caller's context");
    assert.match(destructure[1], /duplicateResolution:/, "a caller-supplied resolution must be taken away, not merely ignored");
    assert.ok(/duplicateState,?\s*\n?\s*\}\)/.test(code) || /duplicateState/.test(code), "the durable state must be bound");
  });

  it("the gate actually reads durable duplicate state — the call cannot be deleted quietly", () => {
    assert.match(gateSrc(), /resolveDuplicateStateForProspect\(/);
  });

  it("the gate never re-derives duplicates itself", () => {
    // Comments are stripped: the header explains the defect by naming
    // `resolveDuplicates([oneProspect])`, and that explanation is not a call.
    const code = gateSrc()
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    assert.ok(!/resolveDuplicates\(/.test(code), "the gate must read a human's decision, not recompute one from whatever records it happens to hold");
    assert.ok(!/duplicateStatusFor\(/.test(code));
  });

  it("an authorised decision always says the duplicate answer came from durable state", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    const decision = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(decision.authorised, true, JSON.stringify(decision.failedChecks));
    assert.strictEqual(decision.duplicateSource, "durable");
  });

  it("the engine labels a caller-built resolution as such", () => {
    const p = makeProspect();
    const decision = createEligibilityEngine({ now: now() }).evaluate(p, { duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }] }]) });
    assert.strictEqual(decision.duplicateSource, "caller");
  });

  it("the durable module writes nothing — it reads a decision somebody else made", () => {
    const src = stateSrc();
    for (const forbidden of ["appendDecision", "resolveReviewItem", "upsertProspect", "transitionProspectLifecycle", "appendSuppression"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\s*\\(`).test(src), `duplicate state must not call ${forbidden} — resolving is a human's job, in the review queue`);
    }
  });

  it("no AI or system actor can resolve an ambiguous identity here", () => {
    const src = stateSrc();
    assert.ok(!/autoResolve|autoMerge|resolveAutomatically|actorKind:\s*"system"/.test(src));
  });

  it("the durable module cannot place, schedule or prepare a call", () => {
    const src = stateSrc();
    for (const pattern of [/require\(["'](twilio|axios|node-fetch|nodemailer|retell-sdk|@retell)/, /\bfetch\s*\(/, /https?\.request\s*\(/]) {
      assert.ok(!pattern.test(src));
    }
    const exported = Object.keys(require("../src/services/acquisition-duplicate-state"));
    for (const forbidden of ["dial", "call", "dispatch", "place", "ring", "send", "execute", "start"]) {
      assert.ok(!exported.includes(forbidden));
    }
  });
});

// ---------------------------------------------------------------------------

describe("M8L the founder read model", () => {
  it("counts every bucket, and names the canonical target of a merge", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = now();
    const canonical = makeProspect({ name: "Brunswick Lock Specialists", suburb: "Brunswick" });
    await store.upsertProspect(canonical);

    const open = makeProspect({ name: "Still Deciding Locks", suburb: "Coburg" });
    const merged = makeProspect({ name: "Merged Locks", suburb: "Preston" });
    const rejected = makeProspect({ name: "Rejected Locks", suburb: "Thornbury" });
    const distinct = makeProspect({ name: "Distinct Locks", suburb: "Fitzroy" });

    for (const c of [open, merged, rejected, distinct]) await openDuplicateReview(store, c, { clock, possibleMatches: [canonical.prospectId] });
    await resolveReviewItem({ store, reviewId: `rv_${merged.prospectId}`, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, actor: FOUNDER, reason: "Same.", mergeTarget: canonical.prospectId, now: clock });
    await resolveReviewItem({ store, reviewId: `rv_${rejected.prospectId}`, decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: FOUNDER, reason: "Known.", now: clock });
    await resolveReviewItem({ store, reviewId: `rv_${distinct.prospectId}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: FOUNDER, reason: "Different.", now: clock });

    const summary = await summariseDuplicateState({ store });
    assert.strictEqual(summary.available, true);
    assert.strictEqual(summary.counts.total, 4);
    assert.strictEqual(summary.counts.unresolved, 1);
    assert.strictEqual(summary.counts.merged, 1);
    assert.strictEqual(summary.counts.rejectedDuplicate, 1);
    assert.strictEqual(summary.counts.resolvedDistinct, 1);

    const mergedRow = summary.items.find((i) => i.prospectId === merged.prospectId);
    assert.strictEqual(mergedRow.canonicalId, canonical.prospectId);
    assert.strictEqual(mergedRow.decidedBy, FOUNDER);
    assert.ok(mergedRow.decidedAt);
    assert.strictEqual(mergedRow.decisionReason, "Same.");
  });

  it("reports an unreadable store rather than an empty queue", async () => {
    const store = { ...createInMemoryAcquisitionStore(), async listDecisions() { throw new Error("unreachable"); } };
    const summary = await summariseDuplicateState({ store });
    assert.strictEqual(summary.available, false);
    assert.strictEqual(summary.counts, null);
    assert.match(summary.reason, /unreachable/);
  });
});
