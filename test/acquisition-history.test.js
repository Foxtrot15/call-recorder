// LOCKSMITH ACQUISITION M8J — durable contact history (E-1), and A-L7.
//
// Two things are being held apart here, and the separation is the whole point.
//
// FACTS. acquisition-history.js reads acquisition_contact_outcomes and returns
// what happened, in order. It computes no `attempts` count, because counting
// requires deciding whether an unanswered call is an attempt, and that is A-L7,
// which nobody has answered.
//
// POLICY. acquisition-attempt-policy.js does the counting, from a table whose
// entries carry their own `approved` flags — so the open question stays visible
// in `describeGap()` and in the eligibility block, instead of disappearing into
// `outcomes.length` inside a row reader.
//
// The last describe block is a ratchet against exactly that disappearing.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { readContactHistory, loadHistoryIndex, unavailableHistory, isDurableHistory, HISTORY_SOURCES } = require("../src/services/acquisition-history");
const { createAttemptPolicy, ATTEMPT_CONSUMPTION, CALL_OUTCOMES } = require("../src/services/acquisition-attempt-policy");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createDialAuthoriser } = require("../src/services/acquisition-authorisation");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider } = require("../src/services/acquisition-holidays");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createProspect, transitionProspect } = require("../src/services/acquisition-prospect");

const PROSPECT_ID = "pr_history_0001";
const NUMBER = "+61355507401";
const now = () => new Date("2026-08-05T04:00:00.000Z"); // Wed 14:00 Melbourne

const outcome = (over = {}) => ({
  prospectId: PROSPECT_ID,
  outcome: "no_answer",
  reachedTheBusiness: false,
  e164: NUMBER,
  lifecycleFrom: "queued",
  lifecycleTo: "attempted",
  hops: [],
  effect: "counts_as_attempt",
  effectApproved: false,
  suppressionApplied: false,
  actor: "tester",
  actorKind: "system",
  note: "fixture",
  recordedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  id: "o1",
  ...over,
});

async function storeWith(rows) {
  const store = createInMemoryAcquisitionStore();
  for (const r of rows) await store.appendOutcome(r);
  return store;
}

// ---------------------------------------------------------------------------

describe("the fold reports facts", () => {
  it("orders outcomes oldest first and names the latest", async () => {
    const store = await storeWith([
      outcome({ id: "o2", outcome: "voicemail", recordedAt: "2026-08-03T00:00:00.000Z", createdAt: "2026-08-03T00:00:00.000Z" }),
      outcome({ id: "o1", outcome: "no_answer", recordedAt: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z" }),
      outcome({ id: "o3", outcome: "not_interested", reachedTheBusiness: true, recordedAt: "2026-08-04T00:00:00.000Z", createdAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const h = await readContactHistory({ store, prospectId: PROSPECT_ID });

    assert.equal(h.available, true);
    assert.deepEqual(h.outcomes.map((o) => o.outcome), ["no_answer", "voicemail", "not_interested"]);
    assert.equal(h.latestOutcome, "not_interested");
    assert.equal(h.totalOutcomes, 3);
  });

  it("breaks a same-millisecond tie deterministically rather than by query order", async () => {
    const same = "2026-08-01T00:00:00.000Z";
    const rows = [
      outcome({ id: "b", outcome: "voicemail", recordedAt: same, createdAt: "2026-08-01T00:00:02.000Z" }),
      outcome({ id: "a", outcome: "no_answer", recordedAt: same, createdAt: "2026-08-01T00:00:01.000Z" }),
    ];
    const forwards = await readContactHistory({ store: await storeWith(rows), prospectId: PROSPECT_ID });
    const backwards = await readContactHistory({ store: await storeWith([...rows].reverse()), prospectId: PROSPECT_ID });

    assert.deepEqual(forwards.outcomes.map((o) => o.outcome), ["no_answer", "voicemail"]);
    assert.deepEqual(backwards.outcomes.map((o) => o.outcome), forwards.outcomes.map((o) => o.outcome), "the answer must not depend on the order rows came back in");
    assert.equal(forwards.latestOutcome, "voicemail");
  });

  it("lastEventAt is the last thing that happened, reached or not", async () => {
    const store = await storeWith([
      outcome({ id: "o1", outcome: "not_interested", reachedTheBusiness: true, recordedAt: "2026-08-01T00:00:00.000Z" }),
      outcome({ id: "o2", outcome: "no_answer", reachedTheBusiness: false, recordedAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const h = await readContactHistory({ store, prospectId: PROSPECT_ID });
    assert.equal(h.lastEventAt, "2026-08-04T00:00:00.000Z");
  });

  it("lastReachedAt counts ONLY rows where we spoke to the business", async () => {
    // Three unanswered rings are not a conversation, and a "recent contact"
    // cooldown that treated them as one would silence a business nobody spoke to.
    const store = await storeWith([
      outcome({ id: "o1", outcome: "not_interested", reachedTheBusiness: true, recordedAt: "2026-08-01T00:00:00.000Z" }),
      outcome({ id: "o2", outcome: "no_answer", reachedTheBusiness: false, recordedAt: "2026-08-03T00:00:00.000Z" }),
      outcome({ id: "o3", outcome: "wrong_person", reachedTheBusiness: false, recordedAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const h = await readContactHistory({ store, prospectId: PROSPECT_ID });
    assert.equal(h.lastReachedAt, "2026-08-01T00:00:00.000Z", "wrong_person answered the phone but was not this business");
    assert.equal(h.reachedCount, 1);
  });

  it("counts by outcome, and never by 'attempts'", async () => {
    const store = await storeWith([
      outcome({ id: "o1", outcome: "no_answer" }),
      outcome({ id: "o2", outcome: "no_answer", recordedAt: "2026-08-02T00:00:00.000Z" }),
      outcome({ id: "o3", outcome: "voicemail", recordedAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    const h = await readContactHistory({ store, prospectId: PROSPECT_ID });
    assert.deepEqual(h.countsByOutcome, { no_answer: 2, voicemail: 1 });
    assert.equal(h.attempts, undefined, "an attempts count here would decide A-L7 inside a row reader");
  });

  it("never attributes another business's outcomes", async () => {
    const store = await storeWith([outcome({ id: "o1" }), outcome({ id: "o2", prospectId: "pr_someone_else", outcome: "opt_out", reachedTheBusiness: true })]);
    const h = await readContactHistory({ store, prospectId: PROSPECT_ID });
    assert.equal(h.totalOutcomes, 1);
    assert.equal(h.latestOutcome, "no_answer");
  });

  it("a business never called has an EMPTY history, which is available", async () => {
    const h = await readContactHistory({ store: createInMemoryAcquisitionStore(), prospectId: PROSPECT_ID });
    assert.equal(h.available, true);
    assert.equal(h.totalOutcomes, 0);
    assert.equal(h.latestOutcome, null);
  });

  it("survives a restart: the same store gives the same history to a fresh reader", async () => {
    const store = await storeWith([outcome({ id: "o1" }), outcome({ id: "o2", outcome: "voicemail", recordedAt: "2026-08-02T00:00:00.000Z" })]);
    const first = await readContactHistory({ store, prospectId: PROSPECT_ID });
    const second = await readContactHistory({ store, prospectId: PROSPECT_ID });
    assert.deepEqual(second.outcomes, first.outcomes);
    assert.equal(second.lastEventAt, first.lastEventAt);
  });
});

// ---------------------------------------------------------------------------

describe("unreadable is not empty", () => {
  it("a throwing store yields unavailable, not zero", async () => {
    const store = createInMemoryAcquisitionStore();
    store.listOutcomes = async () => { throw new Error("connection reset"); };
    const h = await readContactHistory({ store, prospectId: PROSPECT_ID });

    assert.equal(h.available, false);
    assert.equal(h.source, HISTORY_SOURCES.UNAVAILABLE);
    assert.match(h.reason, /connection reset/);
    assert.equal(h.totalOutcomes, 0, "the shape is empty, and `available:false` is what stops it being read as empty");
  });

  it("the attempt policy REFUSES on an unavailable history", () => {
    const policy = createAttemptPolicy({ approved: true, approvedBy: "Peter" });
    const r = policy.assess({ history: unavailableHistory("the database was unreachable", PROSPECT_ID) }, { now });
    assert.equal(r.ok, false);
    assert.equal(r.code, "history_unavailable");
    assert.match(r.message, /"unknown" is not "never"/);
  });

  it("an index returns unavailable for an id it was never given", async () => {
    const index = await loadHistoryIndex({ store: createInMemoryAcquisitionStore(), prospectIds: ["pr_a"] });
    assert.equal(index.for("pr_b").available, false);
    assert.match(index.for("pr_b").reason, /unknown rather than empty/);
  });

  it("only this module can mint a durable history", () => {
    assert.equal(isDurableHistory({ available: true, outcomes: [], source: "durable" }), false, "a hand-made lookalike is not evidence");
    assert.equal(isDurableHistory(unavailableHistory("x")), true);
  });
});

// ---------------------------------------------------------------------------

describe("the policy counts, and durable history wins", () => {
  const approved = () => createAttemptPolicy({ approved: true, approvedBy: "Peter" });

  it("counts attempts from the outcome list under its own rules", async () => {
    const store = await storeWith([
      outcome({ id: "o1", outcome: "no_answer" }),
      outcome({ id: "o2", outcome: "voicemail", recordedAt: "2026-08-02T00:00:00.000Z" }),
    ]);
    const history = await readContactHistory({ store, prospectId: PROSPECT_ID });
    // Under the approved A-L7 answer the no-answer is free and the voicemail
    // is not, so two stored events are one counted attempt.
    assert.equal(approved().countAttempts(history), 1);
  });

  it("an unrecognised outcome is counted, not silently free", () => {
    const policy = approved();
    const fabricated = { available: true, outcomes: [{ outcome: "something_new", reachedTheBusiness: false, recordedAt: "2026-08-01T00:00:00.000Z" }] };
    assert.equal(policy.countAttempts(fabricated), 1);
  });

  it("a stale caller-supplied attempts count cannot override the durable history", async () => {
    const store = await storeWith([
      outcome({ id: "o1", outcome: "voicemail" }),
      outcome({ id: "o2", outcome: "voicemail", recordedAt: "2026-08-02T00:00:00.000Z" }),
    ]);
    const history = await readContactHistory({ store, prospectId: PROSPECT_ID });

    // The caller insists nothing has happened. The database says two voicemails.
    const r = approved().assess({ attempts: 0, lastAttemptAt: null, history }, { now });
    assert.equal(r.ok, false);
    assert.equal(r.code, "attempt_cap_reached", "the cap is 2; the durable count reached it whatever the caller passed");
  });

  it("a durable refusal outranks a clean caller-supplied snapshot", async () => {
    // The same attack, aimed at the permanent decline rather than the count.
    const store = await storeWith([
      outcome({ id: "o1", outcome: "not_interested", reachedTheBusiness: true, recordedAt: "2026-08-04T00:00:00.000Z" }),
    ]);
    const history = await readContactHistory({ store, prospectId: PROSPECT_ID });
    const r = approved().assess({ attempts: 0, lastOutcome: "no_answer", history }, { now });
    assert.equal(r.ok, false);
    assert.equal(r.code, "acquisition_declined", "a business that said no stays refused");
    assert.equal(r.temporary, false);
  });
});

// ---------------------------------------------------------------------------

describe("every real authorisation path uses durable history", () => {
  const SOURCE = { url: "https://historytest.example.com.au/contact" };

  function goodProspect() {
    let p = createProspect({
      businessName: "History Test Locksmiths",
      tradeCategory: "Locksmith",
      suburb: "Coburg",
      state: "VIC",
      postcode: "3058",
      region: "Melbourne",
      timezone: "Australia/Melbourne",
      phones: [{ raw: "(03) 5550 7401" }],
      sourceRefs: [SOURCE],
      origin: "fixture",
      discoveredAt: "2026-07-15T02:00:00.000Z",
    }).prospect;
    for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
      p = transitionProspect(p, to, { actor: "Peter", reason: "test", now }).prospect;
    }
    return p;
  }

  function evidenceFor(prospect) {
    const ledger = createEvidenceLedger({ now });
    for (const [kind, value] of [["business_name", prospect.businessName], ["trade_category", "Locksmith"], ["phone", "(03) 5550 7401"]]) {
      ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "test", source: SOURCE });
    }
    return ledger.forProspect(prospect.prospectId);
  }

  function ctx(p, extra = {}) {
    const evidenceRows = evidenceFor(p);
    return {
      evidenceRows,
      duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]),
      // A caller-supplied approval, which the ENGINE accepts for a preview and
      // the AUTHORISER discards (E-5). The authoriser tests below seed a real
      // one into the store with approveIn(); this one is here so the direct
      // engine case at the end of the block gets past the batch check.
      batch: { approved: true, batchHash: "x", approvedBy: "P" },
      ...extra,
    };
  }

  /**
   * E-5 + M8L: the durable state the authoriser will actually read.
   *
   * The prospect row is not ceremony. Since M8L a record that has never been
   * compared against the businesses already held is refused as
   * `duplicate_never_assessed`, and the stored row is that comparison.
   */
  async function approveIn(store, p) {
    await store.upsertProspect(p);
    const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
    const identity = canonicalBatchIdentity({ members: [{ rowId: p.prospectId, prospectId: p.prospectId, e164: NUMBER }] });
    const r = await recordBatchApproval({ store, now, identity, approvedBy: "Peter Dang", reason: "Approved for the history tests." });
    assert.equal(r.ok, true, r.message);
  }
  function engineOptions(clock) {
    const wash = createWashStore({ now: clock, mode: "fixture" });
    wash.wash(NUMBER);
    return { washStore: wash, holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), counselApproved: true };
  }

  it("the authoriser blocks when the contact history cannot be read", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    await approveIn(store, p);
    store.listOutcomes = async () => { throw new Error("outcomes table unreachable"); };

    const authoriser = createDialAuthoriser({ now, store, engineOptions: engineOptions(now) });
    const d = await authoriser.authorise(p, ctx(p));

    assert.equal(d.authorised, false);
    assert.equal(d.code, ELIGIBILITY_CODES.HISTORY_UNAVAILABLE);
    assert.equal(d.dial, null, "no permission slip is minted on an unknown history");
  });

  it("the authoriser reports historySource: durable on a real decision", async () => {
    const store = createInMemoryAcquisitionStore();
    const p = goodProspect();
    await approveIn(store, p);
    const authoriser = createDialAuthoriser({ now, store, engineOptions: engineOptions(now) });
    const d = await authoriser.authorise(p, ctx(p));
    assert.equal(d.authorised, true, JSON.stringify(d.failedChecks));
    assert.equal(d.historySource, "durable");
    assert.equal(d.batchSource, "durable");
  });

  it("a caller-supplied history cannot reach the authoriser's engine", async () => {
    // Two voicemails and a no-answer are durable, against THIS prospect's real
    // id. Under the approved A-L7 answer that is two counted attempts — the
    // cap. The caller passes a clean history hoping to wash them away.
    const subject = goodProspect();
    const store = await storeWith([
      outcome({ id: "o1", prospectId: subject.prospectId, outcome: "voicemail" }),
      outcome({ id: "o2", prospectId: subject.prospectId, outcome: "voicemail", recordedAt: "2026-08-02T00:00:00.000Z" }),
      outcome({ id: "o3", prospectId: subject.prospectId, recordedAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    await approveIn(store, subject);
    const authoriser = createDialAuthoriser({ now, store, engineOptions: engineOptions(now) });
    const d = await authoriser.authorise(subject, ctx(subject, { history: { attempts: 0, lastAttemptAt: null, lastContactAt: null, lastOutcome: null } }));

    assert.equal(d.authorised, false, "the durable two voicemails reached the cap; the caller's zero was ignored");
    assert.equal(d.code, ELIGIBILITY_CODES.ATTEMPTS_BLOCKED, "and the cap is what refused it, not the batch gate");
    assert.equal(d.historySource, "durable", "the gate's own read wins");
    assert.equal(d.dial, null);
  });

  it("an engine that REQUIRES durable history refuses a hand-made one", () => {
    const engine = createEligibilityEngine({ now, historyRequired: true, ...engineOptions(now), suppression: createSuppressionList({ now }) });
    const p = goodProspect();
    const d = engine.evaluate(p, ctx(p, { history: { attempts: 0 } }));
    const blocked = d.failedChecks.find((f) => f.check === "attempts");
    assert.equal(blocked.code, ELIGIBILITY_CODES.HISTORY_UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// ── The A-L7 ratchet ────────────────────────────────────────────────

describe("ratchets: A-L7 is decided, and the answer cannot drift", () => {
  // M8J built the machinery to count either way and deliberately answered
  // nothing. The founder has since answered it (approval AL6-AL7-AL8-2026-08-10)
  // and these ratchets now pin the ANSWER rather than the silence. Changing
  // either value is still a policy decision, not a code change.
  it("a no-answer does not consume an attempt; a voicemail does — both approved", () => {
    assert.equal(ATTEMPT_CONSUMPTION.no_answer.countsTowardCap, false, "A-L7: ringing out is not an attempt spent");
    assert.equal(ATTEMPT_CONSUMPTION.voicemail.countsTowardCap, true, "A-L7: a message left is an attempt spent");
    for (const outcomeName of ["no_answer", "voicemail"]) {
      assert.equal(ATTEMPT_CONSUMPTION[outcomeName].approved, true, `${outcomeName} is decided and must say so`);
      assert.match(ATTEMPT_CONSUMPTION[outcomeName].source, /Founder approval AL6-AL7-AL8/, `${outcomeName} must cite the approval that settled it`);
    }
  });

  it("nothing in the consumption table is left undecided", () => {
    const policy = createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" });
    assert.equal(policy.approved, true);
    assert.deepEqual([...policy.unapprovedConsumption], []);
  });

  it("an unnamed policy still blocks, even though the values are settled", () => {
    // Approved VALUES are not the same as an approved POLICY: somebody still
    // has to put their name to it.
    const policy = createAttemptPolicy();
    assert.equal(policy.approved, false);
    const engine = createEligibilityEngine({ now, counselApproved: true });
    const d = engine.evaluate({ ...{ prospectId: "p", businessName: "B", timezone: "Australia/Melbourne", lifecycle: "review_approved", phones: [{ raw: "(03) 5550 7401" }], sourceRefs: [], history: [] } }, {});
    const policyCheck = d.failedChecks.find((f) => f.check === "policy_approval");
    assert.ok(policyCheck, "an unapproved policy must still block");
  });

  it("the history fold contains no attempt counting at all", () => {
    // The one-line implementation the A-L audit suggested would have decided
    // A-L7 by accident. This is the ratchet against it coming back.
    const src = read("src/services/acquisition-history.js")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    for (const forbidden of [/attempts\s*[:=]/, /outcomes\.length\s*[,;)]/, /countAttempts/]) {
      assert.doesNotMatch(src, forbidden, `counting belongs to the attempt policy, not to the row reader (${forbidden})`);
    }
  });

  it("answering A-L7 changed a predicate, not the stored rows", async () => {
    // The property M8J was built for, now demonstrated by an actual decision:
    // the same three durable rows, read by the approved policy, give a
    // different count than the old proposal did — with no backfill, no
    // migration and no recount of history.
    const store = await storeWith([
      outcome({ id: "o1", outcome: "no_answer" }),
      outcome({ id: "o2", outcome: "voicemail", recordedAt: "2026-08-02T00:00:00.000Z" }),
      outcome({ id: "o3", outcome: "not_interested", reachedTheBusiness: true, recordedAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    const history = await readContactHistory({ store, prospectId: PROSPECT_ID });
    assert.equal(history.outcomes.length, 3, "three facts are stored, whatever the policy makes of them");

    // Under the approved answer the no-answer is free; the other two count.
    assert.equal(createAttemptPolicy().countAttempts(history), 2);

    // The rows themselves say nothing about attempts — that is the seam.
    assert.deepEqual(
      history.outcomes.map((o) => o.outcome),
      ["no_answer", "voicemail", "not_interested"]
    );
  });

  it("every call outcome has a consumption rule, and every rule is a real outcome", () => {
    for (const o of CALL_OUTCOMES) assert.ok(ATTEMPT_CONSUMPTION[o], `${o} has no attempt-consumption rule`);
    for (const o of Object.keys(ATTEMPT_CONSUMPTION)) assert.ok(CALL_OUTCOMES.includes(o), `${o} is not a call outcome`);
  });
});

// ---------------------------------------------------------------------------

describe("ratchets: nothing bypasses the durable history provider", () => {
  it("the authoriser reads it and makes it mandatory", () => {
    const src = read("src/services/acquisition-authorisation.js");
    assert.match(src, /readContactHistory/, "the final gate must do its own durable read");
    assert.match(src, /historyRequired:\s*true/, "and must refuse a caller-built one");
  });

  it("no acquisition module derives an attempts count outside the attempt policy", () => {
    const dir = path.join(ROOT, "src/services");
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("acquisition-") && n.endsWith(".js"))) {
      if (f === "acquisition-attempt-policy.js") continue;
      const code = fs
        .readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
        .join("\n");
      assert.doesNotMatch(code, /attempts\s*=\s*[\w.]*outcomes[\w.]*\.length/, `${f} counts attempts itself — that is A-L7's question and it belongs to the policy`);
    }
  });

  it("the read model reports where its history came from rather than implying zero", () => {
    const src = read("src/services/acquisition-readmodel.js");
    assert.match(src, /historySource/, "a preview may run without durable history, but it may not hide that");
  });
});
