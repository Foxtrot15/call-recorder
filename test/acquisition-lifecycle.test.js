// LOCKSMITH ACQUISITION M8J — the durable lifecycle projection (E-2).
//
// Before M8J, `upsertProspect` deliberately never sent `lifecycle` — right, so
// a re-run CSV cannot drag a reviewed business back to `discovered` — and
// NOTHING ELSE sent it either. A persisted prospect was permanently
// `discovered`, and the eligibility engine's `review_approved` check could not
// be satisfied by anything in the database.
//
// These tests hold the two halves apart: the import still cannot touch the
// column, and one explicit compare-and-set operation can.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { createInMemoryAcquisitionStore, STORE_METHODS, LIFECYCLE_TRANSITION_CODES, PERSISTABLE_LIFECYCLE_STATES } = require("../src/services/acquisition-store");
const { projectReviewResolution, reconcileReviewProjections, lifecycleForReviewDecision, PROJECTION_CODES } = require("../src/services/acquisition-review-projection");
const { openReviewItem, resolveReviewItem, REVIEW_DECISIONS } = require("../src/services/acquisition-review-queue");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const S = require("../src/services/acquisition-schema");

const ticking = (start = Date.UTC(2026, 7, 8, 9, 0, 0)) => {
  let t = start;
  return () => new Date((t += 1000));
};
const now = () => new Date("2026-08-08T09:00:00.000Z");

const PROSPECT_ID = "pr_lifecycle_0001";

const prospectRow = (overrides = {}) => ({
  prospectId: PROSPECT_ID,
  schemaVersion: "acq-1",
  businessName: "Lifecycle Test Locksmiths",
  tradeCategory: "Locksmith",
  suburb: "Coburg",
  state: "VIC",
  postcode: "3058",
  timezone: "Australia/Melbourne",
  origin: "operator_import",
  discoveredAt: "2026-08-01T00:00:00.000Z",
  lifecycle: "discovered",
  history: [],
  ...overrides,
});

const candidate = () => ({
  prospectId: PROSPECT_ID,
  businessName: "Lifecycle Test Locksmiths",
  tradeCategory: "Locksmith",
  suburb: "Coburg",
  state: "VIC",
  postcode: "3058",
  timezone: "Australia/Melbourne",
  phones: [{ raw: "(03) 5550 7301", label: "Listed" }],
  origin: "operator_import",
});

async function storeWithProspect(lifecycle = "discovered") {
  const store = createInMemoryAcquisitionStore();
  await store.upsertProspect(prospectRow({ lifecycle }));
  return store;
}

// ---------------------------------------------------------------------------

describe("the import still cannot move a lifecycle", () => {
  it("upsertProspect ignores lifecycle and history on an existing row", async () => {
    const store = await storeWithProspect("review_approved");
    await store.upsertProspect(prospectRow({ lifecycle: "discovered", history: [], businessName: "Renamed By CSV" }));

    const after = await store.loadProspect(PROSPECT_ID);
    assert.equal(after.lifecycle, "review_approved", "a re-run CSV must not undo a human's review");
    assert.equal(after.businessName, "Renamed By CSV", "but it may still refresh what it legitimately learned");
  });

  it("the durable adapter never sends lifecycle in an upsert", () => {
    const src = read("src/services/acquisition-store.js");
    const start = src.indexOf("const toProspectRow");
    const mapper = src.slice(start, src.indexOf("});", start) + 3);
    assert.doesNotMatch(mapper, /\blifecycle\b/, "toProspectRow must not carry lifecycle — that is what makes the import safe");
    assert.doesNotMatch(mapper, /\bhistory\b/, "nor the journal");
  });

  it("there is no generic setLifecycle escape hatch on any store", async () => {
    const store = createInMemoryAcquisitionStore();
    for (const forbidden of ["setLifecycle", "updateLifecycle", "forceLifecycle", "setProspectState", "updateProspect"]) {
      assert.equal(typeof store[forbidden], "undefined", `${forbidden}() would be a way round the state machine`);
    }
    assert.ok(STORE_METHODS.includes("transitionProspectLifecycle"));
  });
});

// ---------------------------------------------------------------------------

describe("the compare-and-set transition", () => {
  it("applies a legal transition and journals it", async () => {
    const store = await storeWithProspect("review_pending");
    const r = await store.transitionProspectLifecycle({
      prospectId: PROSPECT_ID,
      expectedFrom: "review_pending",
      to: "review_approved",
      actor: "Peter",
      reason: "Reviewed the listing and the licence number; this is the business it says it is.",
      at: "2026-08-08T09:00:00.000Z",
    });

    assert.equal(r.ok, true);
    assert.equal(r.code, LIFECYCLE_TRANSITION_CODES.TRANSITIONED);
    assert.equal(r.prospect.lifecycle, "review_approved");
    assert.deepEqual(
      { from: r.entry.from, to: r.entry.to, actor: r.entry.actor },
      { from: "review_pending", to: "review_approved", actor: "Peter" }
    );
    assert.equal((await store.loadProspect(PROSPECT_ID)).history.length, 1);
  });

  it("refuses an illegal transition", async () => {
    const store = await storeWithProspect("discovered");
    const r = await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "discovered", to: "review_approved", actor: "Peter", reason: "Skipping the queue." });
    assert.equal(r.ok, false);
    assert.equal(r.code, LIFECYCLE_TRANSITION_CODES.TRANSITION_ILLEGAL);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "discovered");
  });

  it("refuses a STALE expectedFrom rather than overwriting", async () => {
    const store = await storeWithProspect("review_pending");
    // Somebody else got there first.
    await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "review_pending", to: "review_rejected", actor: "Sam", reason: "Not a locksmith; it is a hardware shop." });

    const stale = await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "review_pending", to: "review_approved", actor: "Peter", reason: "Working from a list I loaded ten minutes ago." });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE);
    assert.equal(stale.from, "review_rejected");
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "review_rejected", "the first decision stands");
  });

  it("is idempotent at the target — a repair may run twice", async () => {
    const store = await storeWithProspect("review_approved");
    const again = await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "review_pending", to: "review_approved", actor: "reconciler", reason: "Repairing a projection that may not have landed." });
    assert.equal(again.ok, true);
    assert.equal(again.code, LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET);
    assert.equal(again.changed, false);
    assert.equal((await store.loadProspect(PROSPECT_ID)).history.length, 0, "an idempotent no-op writes no journal entry");
  });

  it("allows an ENGAGEMENT state, because laq2 widened the CHECK to hold them", async () => {
    // This test was written the other way round first, asserting that
    // `review_approved -> queued` is impossible because laq1's CHECK stops at
    // the pre-engagement states. laq1's CHECK is not the one that exists: laq2
    // drops and re-adds it with all fourteen, and laq2 has been applied to dev
    // since M8D. Refusing here would have been the code disagreeing with the
    // database about what the database allows.
    const store = await storeWithProspect("review_approved");
    const r = await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "review_approved", to: "queued", actor: "queue", reason: "Selected into an approved calling batch." });
    assert.equal(r.ok, true);
    assert.equal(r.code, LIFECYCLE_TRANSITION_CODES.TRANSITIONED);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "queued");
  });

  it("requires who and why, like every other state change", async () => {
    const store = await storeWithProspect("review_pending");
    for (const bad of [{ actor: "", reason: "x" }, { actor: "Peter", reason: "" }]) {
      const r = await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "review_pending", to: "review_approved", ...bad });
      assert.equal(r.ok, false);
      assert.equal(r.code, LIFECYCLE_TRANSITION_CODES.INPUT_INVALID);
    }
  });

  it("reports a missing prospect rather than creating one", async () => {
    const store = createInMemoryAcquisitionStore();
    const r = await store.transitionProspectLifecycle({ prospectId: "pr_nope", expectedFrom: "review_pending", to: "review_approved", actor: "Peter", reason: "It should be here." });
    assert.equal(r.ok, false);
    assert.equal(r.code, LIFECYCLE_TRANSITION_CODES.PROSPECT_MISSING);
  });
});

// ---------------------------------------------------------------------------

describe("projecting a durable review decision", () => {
  async function resolvedStore(decision, { persist = true, lifecycle = "discovered" } = {}) {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    if (persist) await store.upsertProspect(prospectRow({ lifecycle }));
    await openReviewItem({ candidate: candidate(), reason: "Ambiguous category.", store, now: clock });
    await resolveReviewItem({
      store,
      reviewId: `rv_${PROSPECT_ID}`,
      decision,
      actor: "Peter",
      reason: "Checked the licence register and the shopfront photo; this is a locksmith.",
      now: clock,
    });
    return { store, clock };
  }

  it("an approved review walks the prospect to review_approved", async () => {
    const { store, clock } = await resolvedStore(REVIEW_DECISIONS.APPROVE_AS_NEW);
    const r = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });

    assert.equal(r.ok, true);
    assert.equal(r.code, PROJECTION_CODES.PROJECTED);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "review_approved");
    assert.deepEqual(r.applied.map((a) => a.to), ["evidence_captured", "review_pending", "review_approved"], "one legal hop at a time, each journalled");
  });

  it("a rejection lands on review_rejected where a prospect exists", async () => {
    const { store, clock } = await resolvedStore(REVIEW_DECISIONS.REJECT_NOT_LOCKSMITH);
    const r = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });
    assert.equal(r.ok, true);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "review_rejected");
  });

  it("a rejection with no persisted prospect is fine, not an error", async () => {
    const { store, clock } = await resolvedStore(REVIEW_DECISIONS.REJECT_DUPLICATE, { persist: false });
    const r = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });
    assert.equal(r.ok, true);
    assert.equal(r.code, PROJECTION_CODES.NO_PROSPECT_ROW);
  });

  it("a merge moves nothing — the candidate never becomes a prospect", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    await store.upsertProspect(prospectRow());
    await openReviewItem({ candidate: candidate(), reason: "Possible duplicate.", store, now: clock });
    await resolveReviewItem({ store, reviewId: `rv_${PROSPECT_ID}`, decision: REVIEW_DECISIONS.MERGE_INTO_EXISTING, mergeTarget: "pr_canonical", actor: "Peter", reason: "Same business, different suite number.", now: clock });

    const r = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });
    assert.equal(r.code, PROJECTION_CODES.NO_LIFECYCLE_EFFECT);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "discovered");
    assert.equal(lifecycleForReviewDecision(REVIEW_DECISIONS.MERGE_INTO_EXISTING), null);
  });

  it("an open item has nothing to project", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    await store.upsertProspect(prospectRow());
    await openReviewItem({ candidate: candidate(), reason: "Ambiguous.", store, now: clock });
    const r = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });
    assert.equal(r.ok, false);
    assert.equal(r.code, PROJECTION_CODES.NOT_RESOLVED);
  });
});

// ---------------------------------------------------------------------------

describe("a failed projection is repairable, and never corrupt", () => {
  /** Resolve for real, then break the projection write. */
  async function resolvedWithBrokenProjection() {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    await store.upsertProspect(prospectRow());
    await openReviewItem({ candidate: candidate(), reason: "Ambiguous.", store, now: clock });
    await resolveReviewItem({ store, reviewId: `rv_${PROSPECT_ID}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "Verified against the licence register.", now: clock });

    const working = store.transitionProspectLifecycle.bind(store);
    store.transitionProspectLifecycle = async () => ({ ok: false, code: LIFECYCLE_TRANSITION_CODES.PROSPECT_MISSING, message: "The database was unreachable." });
    return { store, clock, restore: () => { store.transitionProspectLifecycle = working; } };
  }

  it("the decision survives a projection failure and is not rewritten", async () => {
    const { store, clock } = await resolvedWithBrokenProjection();
    const before = await store.listDecisions({});

    const r = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });
    assert.equal(r.ok, false);
    assert.equal(r.code, PROJECTION_CODES.FAILED);
    assert.match(r.message, /The review decision stands/);

    assert.deepEqual(await store.listDecisions({}), before, "not one decision row was added, removed or altered");
  });

  it("eligibility stays BLOCKED while the projection has not landed — it never reads as approved", async () => {
    const { store, clock } = await resolvedWithBrokenProjection();
    await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });

    const engine = createEligibilityEngine({ now: clock });
    const prospect = await store.loadProspect(PROSPECT_ID);
    const d = engine.evaluate({ ...prospect, phones: [{ raw: "(03) 5550 7301" }] }, {});
    assert.notEqual(d.code, ELIGIBILITY_CODES.ELIGIBLE);
    assert.equal(prospect.lifecycle, "discovered", "the column is the projection, and it has not moved");
  });

  it("retrying repairs the lifecycle and appends NO second human decision", async () => {
    const { store, clock, restore } = await resolvedWithBrokenProjection();
    await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });
    const afterFailure = await store.listDecisions({});

    restore();
    const repaired = await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });

    assert.equal(repaired.ok, true);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "review_approved");
    assert.deepEqual(await store.listDecisions({}), afterFailure, "repair reads the decision; it does not record one");
  });

  it("re-resolving the same review is refused, so a repair cannot become a second decision", async () => {
    const { store, clock, restore } = await resolvedWithBrokenProjection();
    restore();
    const second = await resolveReviewItem({ store, reviewId: `rv_${PROSPECT_ID}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "Trying again because the lifecycle did not update.", now: clock });
    assert.equal(second.ok, false);
    assert.equal(second.code, "already_resolved");
  });

  it("the reconciler finds and repairs every lagging projection, and reports what it could not", async () => {
    const { store, clock, restore } = await resolvedWithBrokenProjection();
    await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });

    const broken = await reconcileReviewProjections({ store, now: clock });
    assert.equal(broken.ok, false);
    assert.equal(broken.failed.length, 1);

    restore();
    const fixed = await reconcileReviewProjections({ store, now: clock });
    assert.equal(fixed.ok, true);
    assert.equal(fixed.repaired.length, 1);
    assert.equal((await store.loadProspect(PROSPECT_ID)).lifecycle, "review_approved");

    const idempotent = await reconcileReviewProjections({ store, now: clock });
    assert.deepEqual(idempotent.repaired, [], "a second sweep changes nothing");
    assert.equal(idempotent.alreadyConsistent.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("the projection survives a restart", () => {
  it("a fresh set of services around the same store still sees review_approved", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    await store.upsertProspect(prospectRow());
    await openReviewItem({ candidate: candidate(), reason: "Ambiguous.", store, now: clock });
    await resolveReviewItem({ store, reviewId: `rv_${PROSPECT_ID}`, decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Peter", reason: "Verified.", now: clock });
    await projectReviewResolution({ store, reviewId: `rv_${PROSPECT_ID}`, now: clock });

    // The restart: every service is destroyed and rebuilt around the SAME
    // store, which is what a process restart does to a database that does not
    // restart with it.
    const freshEngine = createEligibilityEngine({ now: clock });
    const reloaded = await store.loadProspect(PROSPECT_ID);
    assert.equal(reloaded.lifecycle, "review_approved");

    const d = freshEngine.evaluate({ ...reloaded, phones: [{ raw: "(03) 5550 7301" }] }, {});
    const recordCheck = d.failedChecks.find((f) => f.check === "record_valid");
    assert.notEqual(recordCheck ? recordCheck.code : null, ELIGIBILITY_CODES.RECORD_NOT_APPROVED, "the reviewed state survived the restart");
  });
});

// ---------------------------------------------------------------------------

describe("ratchets: lifecycle", () => {
  /** Pull a `check (lifecycle in ('a','b',...))` list out of a migration. */
  const checkStatesIn = (sql) => {
    const m = /check \(lifecycle in \(([\s\S]*?)\)\)/.exec(sql);
    if (!m) return null;
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  };

  it("PERSISTABLE_LIFECYCLE_STATES matches the EFFECTIVE CHECK — laq2's, not laq1's", () => {
    // The near-miss this ratchet exists for, written down because it actually
    // happened while M8J was being built.
    //
    // laq1 creates the column with six states. laq2 DROPS that constraint and
    // re-adds it with fourteen, and laq2 has been applied to dev since M8D. A
    // list mirroring laq1 describes a constraint that no longer exists — it
    // would refuse `review_approved -> queued`, which the database permits —
    // and a ratchet that parsed laq1 would pass while being wrong.
    //
    // So this parses the LAST definition of the constraint across the applied
    // migrations, in order, which is what Postgres actually holds.
    const laq1 = checkStatesIn(read("supabase/sql/laq1_create_acquisition_prospects.sql"));
    const laq2 = checkStatesIn(read("supabase/sql/laq2_create_acquisition_queue.sql"));
    assert.ok(laq1, "laq1 must still define the lifecycle CHECK");
    assert.ok(laq2, "laq2 must still redefine it — if it stops, this ratchet is reading the wrong file");
    assert.notDeepEqual(laq1, laq2, "the premise: laq2 widens what laq1 created");

    assert.deepEqual([...PERSISTABLE_LIFECYCLE_STATES].sort(), laq2, "the store's list has drifted from the effective column CHECK");
  });

  it("the domain, the store's list and the effective CHECK all agree", () => {
    const laq2 = checkStatesIn(read("supabase/sql/laq2_create_acquisition_queue.sql"));
    assert.deepEqual([...S.PROSPECT_STATES].sort(), laq2, "a domain state the column cannot hold is a migration nobody wrote");
    assert.deepEqual([...PERSISTABLE_LIFECYCLE_STATES].sort(), [...S.PROSPECT_STATES].sort());
  });

  it("a state outside the effective CHECK is refused by name, not by Postgres", async () => {
    // The branch is not dead code just because the three lists agree today: the
    // domain can gain a state before a migration adds it, and that must fail
    // here rather than as a raw 23514 from the database.
    const store = await storeWithProspect("review_approved");
    const r = await store.transitionProspectLifecycle({ prospectId: PROSPECT_ID, expectedFrom: "review_approved", to: "teleported", actor: "x", reason: "y" });
    assert.equal(r.ok, false);
    assert.equal(r.code, LIFECYCLE_TRANSITION_CODES.INPUT_INVALID, "an unknown string is caught as invalid input first");
  });

  it("every persistable state is a real prospect state", () => {
    for (const state of PERSISTABLE_LIFECYCLE_STATES) {
      assert.ok(S.PROSPECT_STATES.includes(state), `${state} is not in PROSPECT_STATES`);
    }
  });

  it("the transition delegates to the shared whitelist rather than copying it", () => {
    const src = read("src/services/acquisition-store.js");
    assert.match(src, /S\.PROSPECT_TRANSITIONS\[from\]/, "the store must read the one state machine, not restate it");
    // A hardcoded pair list would be a second answer to 'what is legal'.
    assert.doesNotMatch(src, /review_pending\s*:\s*\[/, "no second transition table in the store");
  });

  it("the durable adapter guards the UPDATE with the lifecycle it read", () => {
    const src = read("src/services/acquisition-store.js");
    const body = src.slice(src.indexOf("async transitionProspectLifecycle", src.indexOf("function createSupabaseAcquisitionStore")));
    const fn = body.slice(0, body.indexOf("\n    async loadProspect"));
    assert.match(fn, /\.eq\("prospect_id", prospectId\)/);
    assert.match(fn, /\.eq\("lifecycle", from\)/, "without the second predicate this is a blind overwrite, not a compare-and-set");
    assert.match(fn, /data\.length === 0/, "zero rows updated must be inspected, not treated as success");
  });

  it("the projection never appends to the decision log", () => {
    // Comments stripped first: the module deliberately NAMES resolveReviewItem
    // in prose, to say that a repeated resolution is refused there rather than
    // duplicated here. Banning the word would delete the explanation.
    const src = read("src/services/acquisition-review-projection.js")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    for (const forbidden of [/appendDecision/, /appendDecisionSerialised/, /resolveReviewItem\s*\(/, /log\.record/]) {
      assert.doesNotMatch(src, forbidden, `repair must READ the decision, never write one (${forbidden})`);
    }
  });
});
