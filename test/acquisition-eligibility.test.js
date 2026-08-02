// LOCKSMITH ACQUISITION A2 — the unified contact eligibility engine.
//
// One question, one answer: can this prospect enter the outbound call queue
// right now? These tests pin the precedence (permanent beats temporary), the
// default-deny posture (a missing collaborator blocks rather than skips), and
// the composition (every check delegates to the module that owns it).

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { createEligibilityEngine, ELIGIBILITY_CODES, CHECK_ORDER } = require("../src/services/acquisition-eligibility");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider, createNullHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { resolveDuplicates } = require("../src/services/acquisition-dedupe");
const { createProspect, transitionProspect, identityFingerprint } = require("../src/services/acquisition-prospect");

const MELBOURNE = "Australia/Melbourne";
// Wednesday 14:00 in Melbourne — squarely inside the permitted window.
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z";
const NUMBER = "+61355501042";

const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

/** A fully-formed, human-approved prospect with complete evidence. */
function goodProspect({ name = "Northside Lock & Key", phone = "(03) 5550 1042", suburb = "Brunswick", timezone = MELBOURNE } = {}) {
  const built = createProspect({
    businessName: name,
    tradeCategory: "Locksmith",
    suburb,
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone,
    phones: [{ raw: phone }],
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

/** Everything wired up and permitted — the baseline the tests perturb. */
function happyPath({ iso = WEDNESDAY_2PM, prospect = null } = {}) {
  const clock = now(iso);
  const p = prospect || goodProspect();
  const evidenceRows = evidenceFor(p, clock);

  const suppression = createSuppressionList({ now: clock });
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  washStore.wash(NUMBER);

  const duplicateResolution = resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], evidenceCount: evidenceRows.length, hasOfficialSource: true }]);

  const engine = createEligibilityEngine({
    now: clock,
    washStore,
    suppression,
    holidays: createFixtureHolidayProvider(),
    attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
    counselApproved: true,
  });

  const context = {
    evidenceRows,
    duplicateResolution,
    batch: { approved: true, batchHash: "abc123def456", approvedBy: "Peter" },
  };

  return { engine, prospect: p, context, suppression, washStore, evidenceRows, duplicateResolution, clock };
}

describe("the eligible case", () => {
  it("clears a complete, reviewed, washed, unsuppressed prospect inside the window", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, context);
    assert.strictEqual(d.eligible, true, d.message);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.ELIGIBLE);
    assert.deepStrictEqual([...d.failedChecks], []);
    assert.strictEqual(d.canonicalNumber, NUMBER);
  });

  it("returns structured output with everything a caller needs", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, context);
    for (const key of ["eligible", "code", "message", "temporary", "failedChecks", "passedChecks", "nextEligibleAt", "requiredFounderAction", "policyVersion", "localTime", "provenance"]) {
      assert.ok(key in d, `missing ${key}`);
    }
    assert.strictEqual(d.localTime.time, "14:00");
    assert.strictEqual(d.localTime.weekday, "wed");
  });

  it("carries provenance so a founder can trace the decision", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, context);
    assert.strictEqual(d.provenance.prospectId, prospect.prospectId);
    assert.strictEqual(d.provenance.hasOfficialSource, true);
    assert.ok(d.provenance.evidenceCount > 0);
    assert.ok(d.provenance.sourceRefs.length > 0);
  });

  it("records which checks passed", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, context);
    for (const check of CHECK_ORDER) assert.ok(d.passedChecks.includes(check), `${check} should have passed`);
  });

  it("the decision is frozen", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, context);
    assert.ok(Object.isFrozen(d));
    assert.throws(() => {
      "use strict";
      d.eligible = true;
    });
  });
});

describe("precedence — permanent blocks outrank temporary ones", () => {
  it("suppression is decisive even when the call is also outside hours", () => {
    // 20:30 local — after close — AND suppressed. The decisive reason must be
    // suppression: "outside calling hours" reads as try-again-tomorrow.
    const { engine, prospect, context, suppression } = happyPath({ iso: "2026-08-05T10:30:00Z" });
    suppression.suppress({
      reason: "opt_out",
      fingerprint: identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state }),
      actor: "Peter",
      actorKind: "human",
      note: "Asked not to be contacted again.",
    });
    const d = engine.evaluate(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.SUPPRESSED);
    assert.strictEqual(d.temporary, false);
    assert.strictEqual(d.decisiveCheck, "suppression");
    assert.strictEqual(d.nextEligibleAt, null, "a permanent block has no next time");
  });

  it("DNCR outranks a duplicate question and a closed window", () => {
    const { engine, prospect, context, washStore } = happyPath({ iso: "2026-08-05T10:30:00Z" });
    // Re-wash as listed by using a store whose fixture register contains it.
    const clock = now("2026-08-05T10:30:00Z");
    const listedStore = createWashStore({ now: clock, mode: "fixture" });
    listedStore.wash("+61355504488"); // on the fixture register
    const listedProspect = goodProspect({ phone: "(03) 5550 4488" });
    const engine2 = createEligibilityEngine({
      now: clock,
      washStore: listedStore,
      suppression: createSuppressionList({ now: clock }),
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
      counselApproved: true,
    });
    const evidenceRows = evidenceFor(listedProspect, clock);
    const d = engine2.evaluate(listedProspect, {
      evidenceRows,
      duplicateResolution: resolveDuplicates([{ ...listedProspect, numbers: [{ e164: "+61355504488" }], hasOfficialSource: true }]),
      batch: { approved: true, batchHash: "x", approvedBy: "Peter" },
    });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DNCR_LISTED);
    assert.strictEqual(d.temporary, false);
    assert.ok(washStore, "baseline store exists");
  });

  it("an invalid record outranks everything", () => {
    const { engine, context } = happyPath();
    const incomplete = createProspect({
      businessName: "Nameless Locks",
      tradeCategory: "Locksmith",
      suburb: "Brunswick",
      state: "VIC",
      timezone: MELBOURNE,
      phones: [],
      sourceRefs: [{ url: "https://x.example.com.au/" }],
      origin: "fixture",
      discoveredAt: "2026-07-15T02:00:00.000Z",
    }).prospect;
    const d = engine.evaluate(incomplete, { ...context, evidenceRows: [] });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.RECORD_INVALID);
    assert.strictEqual(d.decisiveCheck, "record_valid");
  });

  it("the decisive reason is the highest-precedence failure, not the first noticed", () => {
    const { engine, prospect, context, suppression } = happyPath({ iso: "2026-08-09T02:00:00Z" }); // Sunday
    suppression.suppress({
      reason: "complaint",
      fingerprint: identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state }),
      actor: "Peter",
      note: "Complained about a call.",
    });
    const d = engine.evaluate(prospect, context);
    assert.strictEqual(d.decisiveCheck, "suppression");
    assert.ok(d.failedChecks.length >= 2, "the window failure is still reported");
    assert.ok(d.failedChecks.some((f) => f.check === "calling_window"));
  });

  it("check order is the documented precedence", () => {
    assert.deepStrictEqual(
      [...CHECK_ORDER],
      ["record_valid", "phone_usable", "suppression", "dncr", "duplicate", "campaign", "policy_approval", "batch_approval", "attempts", "calling_window"]
    );
  });
});

describe("DNCR", () => {
  it("blocks a number that has never been washed", () => {
    const clock = now();
    const p = goodProspect();
    const engine = createEligibilityEngine({
      now: clock,
      washStore: createWashStore({ now: clock, mode: "fixture" }), // never washed
      suppression: createSuppressionList({ now: clock }),
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
      counselApproved: true,
    });
    const d = engine.evaluate(p, {
      evidenceRows: evidenceFor(p, clock),
      duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], hasOfficialSource: true }]),
      batch: { approved: true, batchHash: "x", approvedBy: "Peter" },
    });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DNCR_UNKNOWN);
    assert.ok(d.requiredFounderAction.some((a) => /Do Not Call Register/.test(a)));
  });

  it("blocks a wash that has gone stale, distinguishing it from never-checked", () => {
    // Washed on 1 July; evaluated 5 August — 35 days later, past the 30-day rule.
    const washClock = now("2026-07-01T04:00:00Z");
    const store = createWashStore({ now: washClock, mode: "fixture" });
    store.wash(NUMBER);

    const evalClock = now("2026-08-05T04:00:00Z");
    const p = goodProspect();
    const engine = createEligibilityEngine({
      now: evalClock,
      washStore: store,
      suppression: createSuppressionList({ now: evalClock }),
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
      counselApproved: true,
    });
    const d = engine.evaluate(p, {
      evidenceRows: evidenceFor(p, evalClock),
      duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], hasOfficialSource: true }]),
      batch: { approved: true, batchHash: "x", approvedBy: "Peter" },
    });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DNCR_STALE);
    assert.strictEqual(d.temporary, true);
    assert.match(d.message, /30 days|has to be done again/);
  });

  it("blocks everything when no wash store is wired up at all", () => {
    const clock = now();
    const p = goodProspect();
    const engine = createEligibilityEngine({
      now: clock,
      suppression: createSuppressionList({ now: clock }),
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
      counselApproved: true,
    });
    const d = engine.evaluate(p, { evidenceRows: evidenceFor(p, clock), duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }] }]), batch: { approved: true, batchHash: "x", approvedBy: "P" } });
    assert.strictEqual(d.eligible, false);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DNCR_UNKNOWN);
  });
});

describe("duplicates", () => {
  it("blocks a record whose duplicate relationship is unresolved", () => {
    const { engine, prospect, context } = happyPath();
    const other = goodProspect({ name: "Bayside Emergency Locksmiths", suburb: "Brighton" });
    const resolution = resolveDuplicates([
      { ...prospect, numbers: [{ e164: NUMBER }], hasOfficialSource: true },
      { ...other, numbers: [{ e164: NUMBER }], hasOfficialSource: true },
    ]);
    const d = engine.evaluate(prospect, { ...context, duplicateResolution: resolution });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DUPLICATE_REVIEW);
    assert.ok(d.requiredFounderAction.some((a) => /same business/.test(a)));
  });

  it("blocks when duplicates have not been analysed", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, { ...context, duplicateResolution: null });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DUPLICATE_REVIEW);
  });
});

describe("timezone, holidays and the calling window", () => {
  it("blocks an invalid timezone, permanently", () => {
    const { engine, context } = happyPath();
    const d = engine.evaluate(goodProspect({ timezone: "Mars/Olympus" }), context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
    assert.strictEqual(d.temporary, false);
    assert.ok(d.failedChecks.some((f) => f.detail && f.detail.windowCode === "timezone_invalid"));
  });

  it("blocks when the holiday calendar does not cover the date", () => {
    const { engine, prospect, context } = happyPath({ iso: "2027-02-03T02:00:00Z" });
    const d = engine.evaluate(prospect, context);
    assert.ok(d.failedChecks.some((f) => f.detail && f.detail.windowCode === "holiday_coverage_unknown"));
    assert.strictEqual(d.nextEligibleAt, null, "a date we cannot verify has no computable next time");
  });

  it("blocks a public holiday and offers the next permitted time", () => {
    const { engine, prospect, context } = happyPath({ iso: "2026-04-25T02:00:00Z" }); // Anzac Day
    const d = engine.evaluate(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
    assert.ok(d.failedChecks.some((f) => f.detail && f.detail.windowCode === "public_holiday"));
    assert.ok(d.nextEligibleAt, "a holiday lifts, so there is a next time");
  });

  it("blocks before and after permitted hours with a next time", () => {
    for (const [iso, expected] of [["2026-08-04T22:30:00Z", "before_permitted_hours"], ["2026-08-05T10:30:00Z", "after_permitted_hours"]]) {
      const { engine, prospect, context } = happyPath({ iso });
      const d = engine.evaluate(prospect, context);
      assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED, iso);
      assert.ok(d.failedChecks.some((f) => f.detail && f.detail.windowCode === expected), iso);
      assert.ok(d.nextEligibleAt, iso);
      assert.strictEqual(d.temporary, true);
    }
  });

  it("blocks every date when no holiday calendar is loaded", () => {
    const clock = now();
    const p = goodProspect();
    const engine = createEligibilityEngine({
      now: clock,
      washStore: (() => { const s = createWashStore({ now: clock, mode: "fixture" }); s.wash(NUMBER); return s; })(),
      suppression: createSuppressionList({ now: clock }),
      holidays: createNullHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
      counselApproved: true,
    });
    const d = engine.evaluate(p, { evidenceRows: evidenceFor(p, clock), duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], hasOfficialSource: true }]), batch: { approved: true, batchHash: "x", approvedBy: "P" } });
    assert.strictEqual(d.eligible, false);
  });
});

describe("attempts, retries and washes", () => {
  const withHistory = (history, iso = WEDNESDAY_2PM) => {
    const h = happyPath({ iso });
    return h.engine.evaluate(h.prospect, { ...h.context, history });
  };

  it("blocks at the attempt cap, permanently", () => {
    const d = withHistory({ attempts: 3 });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.ATTEMPTS_BLOCKED);
    assert.strictEqual(d.temporary, false);
  });

  it("blocks a retry that is too soon, with the time it lifts", () => {
    const d = withHistory({ attempts: 1, lastAttemptAt: "2026-08-04T04:00:00Z" });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.ATTEMPTS_BLOCKED);
    assert.strictEqual(d.temporary, true);
    assert.ok(d.failedChecks.some((f) => f.nextEligibleAt));
  });

  it("blocks during a recent-contact cooldown", () => {
    const d = withHistory({ attempts: 1, lastContactAt: "2026-07-30T04:00:00Z" });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.ATTEMPTS_BLOCKED);
  });

  it("blocks after an outcome that ends calling", () => {
    const d = withHistory({ attempts: 1, lastOutcome: "booked" });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.ATTEMPTS_BLOCKED);
    assert.strictEqual(d.temporary, false);
  });

  it("honours a not-interested cooldown", () => {
    const d = withHistory({ attempts: 1, lastAttemptAt: "2026-07-01T04:00:00Z", lastOutcome: "not_interested" });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.ATTEMPTS_BLOCKED);
    assert.strictEqual(d.temporary, true);
  });
});

describe("policy and founder approval", () => {
  it("blocks when the calling hours have no counsel sign-off", () => {
    const clock = now();
    const p = goodProspect();
    const engine = createEligibilityEngine({
      now: clock,
      washStore: (() => { const s = createWashStore({ now: clock, mode: "fixture" }); s.wash(NUMBER); return s; })(),
      suppression: createSuppressionList({ now: clock }),
      holidays: createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }),
      counselApproved: false,
    });
    const d = engine.evaluate(p, { evidenceRows: evidenceFor(p, clock), duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], hasOfficialSource: true }]), batch: { approved: true, batchHash: "x", approvedBy: "P" } });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.COUNSEL_UNAPPROVED);
    assert.ok(d.requiredFounderAction.some((a) => /counsel sign-off/i.test(a)));
  });

  it("blocks when the attempt and wash policy has not been approved — the DEFAULT", () => {
    const clock = now();
    const p = goodProspect();
    const engine = createEligibilityEngine({
      now: clock,
      washStore: (() => { const s = createWashStore({ now: clock, mode: "fixture" }); s.wash(NUMBER); return s; })(),
      suppression: createSuppressionList({ now: clock }),
      holidays: createFixtureHolidayProvider(),
      counselApproved: true,
      // attemptPolicy omitted → the proposed, unapproved policy
    });
    const d = engine.evaluate(p, { evidenceRows: evidenceFor(p, clock), duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: NUMBER }], hasOfficialSource: true }]), batch: { approved: true, batchHash: "x", approvedBy: "P" } });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.POLICY_UNAPPROVED);
    assert.match(d.message, /not been approved/);
    const detail = d.failedChecks.find((f) => f.check === "policy_approval").detail;
    assert.ok(detail.unapprovedRules.some((r) => r.key === "maxAttemptsPerProspect"));
    assert.ok(detail.unapprovedRules.some((r) => r.key === "minDaysBetweenAttempts"));
  });

  it("an attempt policy marked approved with nobody named is not in force", () => {
    const policy = createAttemptPolicy({ approved: true });
    assert.strictEqual(policy.approved, false);
    assert.match(policy.describeGap(), /nobody was named/);
  });

  it("blocks when the prospect is not in a founder-approved batch", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, { ...context, batch: null });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
    assert.ok(d.requiredFounderAction.some((a) => /approve a calling batch/i.test(a)));
  });

  it("blocks when the batch approval has gone stale", () => {
    const { engine, prospect, context } = happyPath();
    const d = engine.evaluate(prospect, { ...context, batch: { approved: true, stale: true, batchHash: "x", approvedBy: "Peter" } });
    assert.strictEqual(d.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
    assert.match(d.message, /out of date/);
  });

  it("the DNCR 30-day rule is the one approved attempt/wash value", () => {
    const policy = createAttemptPolicy();
    assert.strictEqual(policy.rules.washValidityDays.approved, true, "statutory");
    assert.strictEqual(policy.rules.maxAttemptsPerProspect.approved, false, "G9 says '(e.g. 3)'");
    assert.strictEqual(policy.rules.minDaysBetweenAttempts.approved, false, "no source at all");
    assert.strictEqual(policy.rules.recentContactCooldownDays.approved, false, "G8 says 'N days'");
  });
});

describe("determinism and isolation", () => {
  it("requires an injected clock", () => {
    assert.throws(() => createEligibilityEngine({}), /injected now\(\)/);
  });

  it("the same inputs always give the same decision", () => {
    const a = happyPath();
    const b = happyPath();
    const da = a.engine.evaluate(a.prospect, a.context);
    const db = b.engine.evaluate(b.prospect, b.context);
    assert.strictEqual(da.code, db.code);
    assert.strictEqual(da.eligible, db.eligible);
    assert.strictEqual(da.evaluatedAt, db.evaluatedAt);
  });

  it("gives an identical result under different host timezones", () => {
    const script = `
      const path = require("path");
      const root = ${JSON.stringify(path.join(__dirname, ".."))};
      const { createEligibilityEngine } = require(path.join(root, "src/services/acquisition-eligibility"));
      const { createSuppressionList } = require(path.join(root, "src/services/acquisition-suppression"));
      const { createWashStore } = require(path.join(root, "src/services/acquisition-dncr"));
      const { createFixtureHolidayProvider } = require(path.join(root, "src/services/acquisition-holidays"));
      const { createAttemptPolicy } = require(path.join(root, "src/services/acquisition-attempt-policy"));
      const { createEvidenceLedger } = require(path.join(root, "src/services/acquisition-evidence"));
      const { resolveDuplicates } = require(path.join(root, "src/services/acquisition-dedupe"));
      const { createProspect, transitionProspect } = require(path.join(root, "src/services/acquisition-prospect"));
      const clock = () => new Date("2026-08-04T22:30:00Z");
      let p = createProspect({ businessName: "Northside Lock & Key", tradeCategory: "Locksmith", suburb: "Brunswick", state: "VIC",
        region: "Melbourne", timezone: "Australia/Melbourne", phones: [{ raw: "(03) 5550 1042" }],
        sourceRefs: [{ url: "https://n.example.com.au/contact" }], origin: "fixture", discoveredAt: "2026-07-15T02:00:00.000Z" }).prospect;
      for (const to of ["evidence_captured","review_pending","review_approved"]) p = transitionProspect(p, to, { actor: "P", reason: "t", now: clock }).prospect;
      const ledger = createEvidenceLedger({ now: clock });
      const src = { url: "https://n.example.com.au/contact" };
      for (const [kind, value] of [["business_name","Northside Lock & Key"],["trade_category","Locksmith"],["phone","(03) 5550 1042"]])
        ledger.record({ prospectId: p.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "t", source: src });
      const store = createWashStore({ now: clock, mode: "fixture" }); store.wash("+61355501042");
      const engine = createEligibilityEngine({ now: clock, washStore: store, suppression: createSuppressionList({ now: clock }),
        holidays: createFixtureHolidayProvider(), attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter" }), counselApproved: true });
      const d = engine.evaluate(p, { evidenceRows: ledger.forProspect(p.prospectId),
        duplicateResolution: resolveDuplicates([{ ...p, numbers: [{ e164: "+61355501042" }], hasOfficialSource: true }]),
        batch: { approved: true, batchHash: "x", approvedBy: "Peter" } });
      process.stdout.write(JSON.stringify({ eligible: d.eligible, code: d.code, local: d.localTime, next: d.nextEligibleAt }));
    `;
    const run = (tz) => execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    const utc = run("UTC");
    assert.strictEqual(utc, run("Pacific/Honolulu"));
    assert.strictEqual(utc, run("Asia/Kathmandu"));
    const parsed = JSON.parse(utc);
    assert.strictEqual(parsed.local.time, "08:30");
    assert.strictEqual(parsed.eligible, false, "08:30 is before the window opens");
  });

  it("makes no network call and touches no provider", () => {
    for (const file of ["../src/services/acquisition-eligibility.js", "../src/services/acquisition-dedupe.js", "../src/services/acquisition-attempt-policy.js"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
      for (const dep of requires) {
        assert.ok(dep.startsWith("./") || dep.startsWith("../"), `${file} may only require local modules, found "${dep}"`);
      }
      const code = source.replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/\bfetch\(|axios|XMLHttpRequest|https?:\/\//.test(code), `${file} must contain no network call`);
      for (const forbidden of ["twilio", "retell", "sendgrid", "nodemailer", "supabase"]) {
        assert.ok(!new RegExp(forbidden, "i").test(code), `${file} must not reference ${forbidden}`);
      }
    }
  });

  it("does not reimplement suppression, DNCR, timezone or holiday logic", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/services/acquisition-eligibility.js"), "utf8");
    // It must DELEGATE: no local date-window arithmetic, no register table.
    assert.ok(!/Intl\.DateTimeFormat/.test(source), "timezone conversion belongs to the calling-policy module");
    assert.ok(!/FIXTURE_REGISTER|isHoliday\s*\(/.test(source), "holiday and register lookups belong to their own modules");
    assert.ok(/require\("\.\/acquisition-calling-policy"\)/.test(source));
    assert.ok(/require\("\.\/acquisition-dncr"\)|washStore/.test(source));
  });
});
