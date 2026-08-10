// LOCKSMITH ACQUISITION M8M — the founder-approved calling policy.
//
// M8M replaced a blocker only an external lawyer could clear with one a named
// human clears by adopting a written, versioned policy. That is a WEAKER claim
// than the one it replaced, and most of this file exists to make sure the
// weaker claim cannot quietly be read as the stronger one.
//
// Two things are being held apart throughout:
//
//   POLICY    AIDA does not cold-call on a public holiday. DECIDED, closed.
//   DATA      do we actually know whether this date is a holiday? Still a
//             fixture, still 2026-only, still not authoritative — A-L2.
//
// Choosing not to call on holidays is not the same as knowing which days those
// are, and a test below pins that the second did not become true because the
// first did.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  createCallingPolicyApproval,
  FOUNDER_CALLING_POLICY,
  CALLING_POLICY_APPROVAL_VERSION,
  APPROVAL_KIND,
} = require("../src/services/acquisition-calling-approval");

const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");
const { createCallingPolicy, POLICY_CODES } = require("../src/services/acquisition-calling-policy");
const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createDialAuthoriser, isAuthorisedDial } = require("../src/services/acquisition-authorisation");
const { createWashStore } = require("../src/services/acquisition-dncr");
const { createFixtureHolidayProvider, createNullHolidayProvider } = require("../src/services/acquisition-holidays");
const { createAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { createProspect, transitionProspect, identityFingerprint } = require("../src/services/acquisition-prospect");
const { canonicalBatchIdentity, recordBatchApproval } = require("../src/services/acquisition-batch-approval");
const { openReviewItem, resolveReviewItem, REVIEW_DECISIONS } = require("../src/services/acquisition-review-queue");
const { CALLING_WINDOWS } = require("../src/config/acquisition");

const MELBOURNE = "Australia/Melbourne";
const NUMBER = "+61355501042";
const FOUNDER = "Peter Dang";

// Wednesday 2026-08-05, 14:00 Melbourne — comfortably inside the window.
const WEDNESDAY_2PM = "2026-08-05T04:00:00Z";
const now = (iso = WEDNESDAY_2PM) => () => new Date(iso);

function makeProspect({ tz = MELBOURNE } = {}) {
  let p = createProspect({
    businessName: "M8M Policy Locksmiths",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: tz,
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [{ url: "https://m8m.example.com.au/contact" }],
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
    ledger.record({ prospectId: prospect.prospectId, kind, captureMode: "fixture", value, observedAt: "2026-07-15T02:00:00.000Z", capturedBy: "t", source: { url: "https://m8m.example.com.au/contact" } });
  }
  return ledger.forProspect(prospect.prospectId);
}

function gateHarness({ iso = WEDNESDAY_2PM, prospect = null, washed = true, holidays = null, approval = FOUNDER_CALLING_POLICY } = {}) {
  const clock = now(iso);
  const p = prospect || makeProspect();
  const washStore = createWashStore({ now: clock, mode: "fixture" });
  if (washed) washStore.wash(NUMBER);
  return {
    clock,
    prospect: p,
    engineOptions: {
      washStore,
      holidays: holidays === undefined ? createFixtureHolidayProvider() : holidays || createFixtureHolidayProvider(),
      attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }),
      callingPolicyApproval: approval,
    },
    context: { evidenceRows: evidenceFor(p, clock) },
  };
}

/** Everything E-5 and M8L need, so the calling policy is what is under test. */
async function makeCallable(store, prospect, clock = now()) {
  await store.upsertProspect(prospect);
  const identity = canonicalBatchIdentity({ members: [{ rowId: prospect.prospectId, prospectId: prospect.prospectId, e164: NUMBER }] });
  const r = await recordBatchApproval({ store, now: clock, identity, approvedBy: FOUNDER, reason: "M8M tests." });
  assert.strictEqual(r.ok, true, r.message);
}

// ---------------------------------------------------------------------------

describe("M8M the approval artifact", () => {
  it("is not approved by default — default-deny survived the rename", () => {
    const a = createCallingPolicyApproval();
    assert.strictEqual(a.approved, false);
    assert.match(a.describeGap(), /not been approved/);
  });

  it("`approved: true` alone is not an approval", () => {
    assert.strictEqual(createCallingPolicyApproval({ approved: true }).approved, false);
  });

  it("needs a named human, a date, a version and a basis", () => {
    const base = { approved: true, approvedBy: FOUNDER, approvedAt: "2026-08-10", version: "v1", basis: "the published rules" };
    assert.strictEqual(createCallingPolicyApproval(base).approved, true);
    for (const missing of ["approvedBy", "approvedAt", "version", "basis"]) {
      const partial = { ...base, [missing]: null };
      assert.strictEqual(createCallingPolicyApproval(partial).approved, false, `${missing} must be required`);
      assert.match(createCallingPolicyApproval(partial).describeGap(), /not approved/);
    }
  });

  it("refuses a system actor — a pipeline cannot adopt its own calling policy", () => {
    for (const impostor of ["system", "aida", "AI", "claude", "bot", "automation", "scheduler"]) {
      const a = createCallingPolicyApproval({ approved: true, approvedBy: impostor, approvedAt: "2026-08-10", version: "v1", basis: "x" });
      assert.strictEqual(a.approved, false, `"${impostor}" must not be able to adopt the calling policy`);
      assert.match(a.describeGap(), /is not a person/);
    }
  });

  it("says every reason at once rather than one per fix", () => {
    const gap = createCallingPolicyApproval({ approved: true }).describeGap();
    assert.match(gap, /nobody is named/);
    assert.match(gap, /no approval date/);
    assert.match(gap, /no policy version/);
    assert.match(gap, /what the policy is based on/);
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(FOUNDER_CALLING_POLICY));
    assert.throws(() => {
      "use strict";
      FOUNDER_CALLING_POLICY.approved = false;
    });
  });
});

// ---------------------------------------------------------------------------

describe("M8M this is a founder policy, and cannot be made to say otherwise", () => {
  it("is always a founder operating policy, never legal advice", () => {
    assert.strictEqual(FOUNDER_CALLING_POLICY.kind, APPROVAL_KIND);
    assert.strictEqual(APPROVAL_KIND, "founder_operating_policy");
    assert.strictEqual(FOUNDER_CALLING_POLICY.isLegalAdvice, false);
  });

  it("no argument can turn it into a legal opinion", () => {
    const forged = createCallingPolicyApproval({
      approved: true,
      approvedBy: FOUNDER,
      approvedAt: "2026-08-10",
      version: "v1",
      basis: "x",
      kind: "legal_advice",
      isLegalAdvice: true,
    });
    assert.strictEqual(forged.kind, APPROVAL_KIND, "kind is not a parameter");
    assert.strictEqual(forged.isLegalAdvice, false, "isLegalAdvice is not a parameter");
  });

  it("carries a disclaimer saying no lawyer reviewed it", () => {
    assert.match(FOUNDER_CALLING_POLICY.disclaimer, /NOT legal advice/i);
    assert.match(FOUNDER_CALLING_POLICY.disclaimer, /has NOT been reviewed by a lawyer/i);
  });

  it("describes itself without claiming legal approval", () => {
    const text = FOUNDER_CALLING_POLICY.describe();
    assert.match(text, /operating policy/i);
    assert.match(text, /not legal advice/i);
    assert.ok(!/counsel|lawyer[- ]approved|legally cleared/i.test(text));
  });

  /** THE RATCHET. Nothing in the module may label this as legal sign-off. */
  it("the module never labels founder approval as legal or counsel approval", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-calling-approval.js"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    assert.ok(!/kind\s*[:=]\s*["'`]legal/i.test(code));
    assert.ok(!/isLegalAdvice\s*[:=]\s*true/.test(code));
    assert.ok(!/counselApproved/.test(code), "the old boolean must not come back through this module");
  });
});

// ---------------------------------------------------------------------------

describe("M8M the policy actually encoded", () => {
  it("is versioned, dated and attributed to a named person", () => {
    assert.strictEqual(FOUNDER_CALLING_POLICY.approved, true);
    assert.strictEqual(FOUNDER_CALLING_POLICY.approvedBy, FOUNDER);
    assert.strictEqual(FOUNDER_CALLING_POLICY.approvedAt, "2026-08-10");
    assert.strictEqual(FOUNDER_CALLING_POLICY.version, CALLING_POLICY_APPROVAL_VERSION);
    assert.match(CALLING_POLICY_APPROVAL_VERSION, /^acq-calling-policy-\d{4}-\d{2}-\d{2}$/);
  });

  it("names the published framework it is based on", () => {
    assert.match(FOUNDER_CALLING_POLICY.basis, /Do Not Call Register Act 2006/);
    assert.match(FOUNDER_CALLING_POLICY.basis, /Industry Standard/);
  });

  it("says AI acquisition calls are governed as telemarketing calls", () => {
    assert.match(FOUNDER_CALLING_POLICY.basis, /AI voice acquisition calls/i);
    assert.match(FOUNDER_CALLING_POLICY.appliesTo, /AI voice acquisition calls/i);
  });

  it("takes the conservative option on holidays, and says so", () => {
    assert.match(FOUNDER_CALLING_POLICY.holidayRule, /No cold acquisition call on a public holiday/i);
    assert.match(FOUNDER_CALLING_POLICY.holidayRule, /holiday coverage is unknown/i);
    assert.match(FOUNDER_CALLING_POLICY.basis, /narrower option is taken/i);
  });

  /** THE RATCHET. The window is the founder decision; changing it is a decision. */
  it("pins the exact window: Mon–Fri 09:00–20:00, Sat 09:00–17:00, no Sunday", () => {
    for (const day of ["mon", "tue", "wed", "thu", "fri"]) {
      assert.deepStrictEqual({ ...CALLING_WINDOWS[day] }, { from: "09:00", to: "20:00" }, `${day} must be 09:00–20:00`);
    }
    assert.deepStrictEqual({ ...CALLING_WINDOWS.sat }, { from: "09:00", to: "17:00" });
    assert.strictEqual(CALLING_WINDOWS.sun, undefined, "SUNDAY CALLING IS NOT PERMITTED. Adding a sun window is a founder decision, not a code change.");
    assert.deepStrictEqual(Object.keys(CALLING_WINDOWS).sort(), ["fri", "mon", "sat", "thu", "tue", "wed"]);
  });

  it("the approval covers exactly those windows", () => {
    assert.deepStrictEqual(FOUNDER_CALLING_POLICY.windows, CALLING_WINDOWS);
  });
});

// ---------------------------------------------------------------------------

describe("M8M the window boundaries did not move", () => {
  const at = (iso) => createCallingPolicy({ now: () => new Date(iso), holidays: createFixtureHolidayProvider(), callingPolicyApproval: FOUNDER_CALLING_POLICY }).evaluate({ timezone: MELBOURNE });

  // 2026-08-05 is a Wednesday. Melbourne is UTC+10 in August (no DST).
  it("09:00 exactly is permitted — the open boundary is INCLUSIVE", () => {
    assert.strictEqual(at("2026-08-04T23:00:00Z").allowed, true, "09:00 Melbourne");
  });

  it("08:59 is refused", () => {
    assert.strictEqual(at("2026-08-04T22:59:00Z").code, POLICY_CODES.BEFORE_HOURS);
  });

  it("19:59 is permitted and 20:00 exactly is REFUSED — the close boundary is EXCLUSIVE", () => {
    assert.strictEqual(at("2026-08-05T09:59:00Z").allowed, true, "19:59 Melbourne");
    assert.strictEqual(at("2026-08-05T10:00:00Z").code, POLICY_CODES.AFTER_HOURS, "20:00 Melbourne must be refused");
  });

  it("Saturday closes at 17:00 exclusive, not 20:00", () => {
    // 2026-08-08 is a Saturday.
    assert.strictEqual(at("2026-08-08T06:59:00Z").allowed, true, "16:59 Saturday");
    assert.strictEqual(at("2026-08-08T07:00:00Z").code, POLICY_CODES.AFTER_HOURS, "17:00 Saturday must be refused");
  });

  it("Sunday is refused at every hour", () => {
    // Sunday 2026-08-09 in MELBOURNE runs 2026-08-08T14:00Z .. 2026-08-09T13:59Z
    // (UTC+10, no DST in August). Sweeping UTC hours on the 9th would spill into
    // Monday morning local, which is legitimately permitted — so the sweep is
    // built from the local day, not from the UTC date.
    const sundayStartUtc = Date.parse("2026-08-08T14:00:00Z");
    for (let h = 0; h < 24; h += 1) {
      const iso = new Date(sundayStartUtc + h * 3600000).toISOString();
      const d = at(iso);
      assert.strictEqual(d.allowed, false, `Sunday ${String(h).padStart(2, "0")}:00 Melbourne must be refused`);
      assert.strictEqual(d.code, POLICY_CODES.PROHIBITED_DAY, `Sunday ${h}:00 must be refused AS A PROHIBITED DAY, not as out-of-hours`);
    }
    // And the hour immediately after is Monday 09:00, which IS permitted — so
    // the sweep above is not passing because everything is refused.
    assert.strictEqual(at(new Date(sundayStartUtc + 33 * 3600000).toISOString()).allowed, true, "Monday 09:00");
  });

  it("uses the RECIPIENT's timezone, never the server's", () => {
    // 2026-08-04T23:30Z is Wednesday 09:30 in Melbourne (UTC+10, permitted) and
    // Wednesday 07:30 in Perth (UTC+8, before hours). Same instant, two answers,
    // decided by the RECIPIENT.
    const gate = createCallingPolicy({ now: () => new Date("2026-08-04T23:30:00Z"), holidays: createFixtureHolidayProvider(), callingPolicyApproval: FOUNDER_CALLING_POLICY });
    assert.strictEqual(gate.evaluate({ timezone: MELBOURNE }).allowed, true);
    assert.strictEqual(gate.evaluate({ timezone: "Australia/Perth" }).code, POLICY_CODES.BEFORE_HOURS);
  });

  it("refuses a missing timezone and never falls back to the server's", () => {
    const gate = createCallingPolicy({ now: now(), holidays: createFixtureHolidayProvider(), callingPolicyApproval: FOUNDER_CALLING_POLICY });
    assert.strictEqual(gate.evaluate({ timezone: null }).code, POLICY_CODES.TIMEZONE_MISSING);
    assert.strictEqual(gate.evaluate({ timezone: "" }).code, POLICY_CODES.TIMEZONE_MISSING);
    assert.strictEqual(gate.evaluate({ timezone: "Mars/Olympus" }).code, POLICY_CODES.TIMEZONE_INVALID);
  });

  /** THE RATCHET. A server-clock fallback is the classic way this breaks. */
  it("the gate never reads the host timezone", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-calling-policy.js"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    assert.ok(!/process\.env\.TZ/.test(code), "reading TZ would make the answer depend on where the server is");
    assert.ok(!/resolvedOptions\(\)\.timeZone/.test(code), "the host's zone is never the recipient's zone");
    assert.ok(!/getTimezoneOffset/.test(code), "hand offset arithmetic is how a DST bug becomes a call at 08:30");
  });
});

// ---------------------------------------------------------------------------

describe("M8M holidays: the POLICY is closed, the DATA is not", () => {
  const gate = (holidays) => createCallingPolicy({ now: () => new Date("2026-04-25T02:00:00Z"), holidays, callingPolicyApproval: FOUNDER_CALLING_POLICY });

  it("refuses on a known public holiday — 12:00 on Anzac Day", () => {
    const d = gate(createFixtureHolidayProvider()).evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.PUBLIC_HOLIDAY);
  });

  it("refuses when holiday coverage is UNKNOWN, with its own code", () => {
    // 2027 is outside the fixture's coverage.
    const d = createCallingPolicy({ now: () => new Date("2027-03-03T02:00:00Z"), holidays: createFixtureHolidayProvider(), callingPolicyApproval: FOUNDER_CALLING_POLICY }).evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.HOLIDAY_UNKNOWN, "unknown coverage must never read as 'not a holiday'");
  });

  it("refuses with no holiday provider at all", () => {
    assert.strictEqual(gate(createNullHolidayProvider()).evaluate({ timezone: MELBOURNE }).code, POLICY_CODES.HOLIDAY_UNKNOWN);
    assert.strictEqual(gate(null).evaluate({ timezone: MELBOURNE }).code, POLICY_CODES.HOLIDAY_UNKNOWN);
  });

  /**
   * THE DISTINCTION, PINNED (C).
   *
   * The founder decided not to call on public holidays. That decision does not
   * make the calendar any better, and the register must not be allowed to claim
   * it did. A-L2 stays open on the DATA.
   */
  it("adopting the policy did not make the holiday data authoritative — A-L2 is still open", () => {
    const fixture = createFixtureHolidayProvider();
    assert.strictEqual(fixture.authoritative, false, "the fixture is hand-compiled and must say so");
    const d = createCallingPolicy({ now: now(), holidays: fixture, callingPolicyApproval: FOUNDER_CALLING_POLICY }).evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.policy.approved, true, "the POLICY is adopted");
    assert.strictEqual(d.policy.holidayCalendarAuthoritative, false, "and the DATA is still a fixture");
  });

  it("the calendar still expires at the end of 2026, loudly", () => {
    const { FIXTURE_COVERAGE } = require("../src/services/acquisition-holidays");
    assert.strictEqual(FIXTURE_COVERAGE.to, "2026-12-31");
    const d = createCallingPolicy({ now: () => new Date("2027-01-04T02:00:00Z"), holidays: createFixtureHolidayProvider(), callingPolicyApproval: FOUNDER_CALLING_POLICY }).evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.code, POLICY_CODES.HOLIDAY_UNKNOWN, "from 2027 the gate refuses every date until a real source lands");
  });
});

// ---------------------------------------------------------------------------

describe("M8M at the final M8E gate", () => {
  it("1. adopted policy + inside the window + known non-holiday ⇒ authorised", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
    assert.ok(isAuthorisedDial(d.dial));
  });

  it("2. no adopted policy ⇒ refused, and it is the calling policy that refuses", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ approval: createCallingPolicyApproval() });
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.authorised, false);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.CALLING_POLICY_UNAPPROVED);
    assert.strictEqual(d.dial, null);
  });

  /** THE RATCHET. The old boolean is gone; passing it authorises nothing. */
  it("3. a caller passing the OLD counselApproved: true authorises nothing", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ approval: createCallingPolicyApproval() });
    await makeCallable(store, prospect, clock);

    const { callingPolicyApproval, ...withoutApproval } = engineOptions;
    const d = await createDialAuthoriser({
      now: clock,
      store,
      engineOptions: { ...withoutApproval, counselApproved: true },
    }).authorise(prospect, context);

    assert.strictEqual(d.authorised, false, "the retired boolean must not clear the policy gate");
    assert.strictEqual(d.code, ELIGIBILITY_CODES.CALLING_POLICY_UNAPPROVED);
    assert.strictEqual(d.dial, null);
  });

  it("4. outside hours ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ iso: "2026-08-05T16:00:00Z" }); // 02:00 Melbourne
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("5. Sunday ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ iso: "2026-08-09T02:00:00Z" }); // Sunday noon
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
    const check = d.failedChecks.find((f) => f.check === "calling_window");
    assert.ok(check, "the calling window must be the thing that refused");
  });

  it("6. a public holiday ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ iso: "2026-04-25T02:00:00Z" }); // Anzac Day
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("7. holiday coverage unknown ⇒ refused", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ holidays: createNullHolidayProvider() });
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.authorised, false);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.WINDOW_BLOCKED);
  });

  it("8. a missing or unusable timezone ⇒ refused", async () => {
    for (const tz of [null, "Mars/Olympus"]) {
      const store = createInMemoryAcquisitionStore();
      const p = { ...makeProspect(), timezone: tz };
      const { clock, engineOptions, context } = gateHarness({ prospect: p });
      await makeCallable(store, p, clock);
      const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(p, context);
      assert.strictEqual(d.authorised, false, `timezone ${tz} must refuse`);
    }
  });

  it("9. DNCR still refuses independently of the calling policy", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ washed: false });
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.ok([ELIGIBILITY_CODES.DNCR_UNKNOWN, ELIGIBILITY_CODES.DNCR_STALE].includes(d.code), d.code);
  });

  it("10. suppression outranks a temporary calling-window block", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness({ iso: "2026-08-09T02:00:00Z" }); // Sunday
    await makeCallable(store, prospect, clock);
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
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.SUPPRESSED, "'try again tomorrow' must never be the message for an opt-out");
  });

  it("11. the attempt policy still applies", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions: { ...engineOptions, attemptPolicy: createAttemptPolicy() } }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.POLICY_UNAPPROVED);
  });

  it("12. the durable batch approval still applies", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await store.upsertProspect(prospect); // stored, but no batch approved
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.BATCH_UNAPPROVED);
  });

  it("13. durable duplicate resolution still applies", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    await openReviewItem({ candidate: prospect, reason: "May be a duplicate.", possibleMatches: ["pr_other"], store, now: clock });
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.code, ELIGIBILITY_CODES.DUPLICATE_REVIEW);
  });

  it("14. an authorised decision carries the policy it was made under", async () => {
    const store = createInMemoryAcquisitionStore();
    const { clock, prospect, engineOptions, context } = gateHarness();
    await makeCallable(store, prospect, clock);
    const d = await createDialAuthoriser({ now: clock, store, engineOptions }).authorise(prospect, context);
    assert.strictEqual(d.authorised, true, JSON.stringify(d.failedChecks));
    // The engine's decision is what carries it; the slip carries only permission.
    const engine = createEligibilityEngine({ ...engineOptions, now: clock });
    const e = engine.evaluate(prospect, { ...context, duplicateState: { resolved: true, blocked: false, unavailable: false, state: "resolved_distinct", message: "ok" }, batch: { approved: true, source: "durable", batchHash: "x", approvedBy: FOUNDER } });
    assert.strictEqual(e.callingPolicy.version, CALLING_POLICY_APPROVAL_VERSION);
    assert.strictEqual(e.callingPolicy.isLegalAdvice, false);
    assert.strictEqual(e.callingPolicy.approvedBy, FOUNDER);
  });

  it("15. only the gate mints a slip — the approval carries nothing that could dial", () => {
    assert.strictEqual(isAuthorisedDial(FOUNDER_CALLING_POLICY), false);
    for (const forbidden of ["dial", "call", "place", "dispatch", "ring", "send", "execute", "start"]) {
      assert.strictEqual(typeof FOUNDER_CALLING_POLICY[forbidden], "undefined");
    }
  });
});

// ---------------------------------------------------------------------------

describe("M8M fail-closed ratchets", () => {
  const engineSrc = () => fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-eligibility.js"), "utf8");
  const strip = (s) =>
    s
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");

  it("the retired counsel gate is gone from the engine's live code", () => {
    const code = strip(engineSrc());
    assert.ok(!/counselApproved/.test(code), "restoring counselApproved as the authority must fail the build");
    assert.ok(!/counsel_approval_missing/.test(code));
    assert.ok(!/COUNSEL_UNAPPROVED/.test(code));
  });

  it("the engine still refuses when nothing was adopted", () => {
    const engine = createEligibilityEngine({ now: now() });
    const d = engine.evaluate(makeProspect(), {});
    assert.ok(d.failedChecks.some((f) => f.check === "policy_approval" && f.code === ELIGIBILITY_CODES.CALLING_POLICY_UNAPPROVED));
  });

  it("no refusal message asks for a lawyer any more", () => {
    const engine = createEligibilityEngine({ now: now() });
    const d = engine.evaluate(makeProspect(), {});
    const check = d.failedChecks.find((f) => f.check === "policy_approval");
    assert.ok(!/lawyer|counsel|legal advice|sign-off/i.test(check.message), check.message);
  });

  it("a passing policy check says plainly that it is not legal advice", () => {
    const engine = createEligibilityEngine({ now: now(), callingPolicyApproval: FOUNDER_CALLING_POLICY, attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: FOUNDER }) });
    const d = engine.evaluate(makeProspect(), {});
    assert.ok(d.passedChecks.includes("policy_approval"));
    assert.strictEqual(d.callingPolicy.isLegalAdvice, false);
  });

  it("the calling policy cannot be bypassed at M8E — the gate builds the engine itself", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-authorisation.js"), "utf8");
    const start = src.indexOf("function createDialAuthoriser");
    const signature = src.slice(start, src.indexOf(")", start));
    assert.ok(!/\bengine\b\s*=/.test(signature), "a pre-built engine could carry an approval the gate never saw");
    assert.match(src, /createEligibilityEngine\(\{ \.\.\.collaborators/);
  });

  it("the approval module reaches no network and imports only local or core", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-calling-approval.js"), "utf8");
    for (const forbidden of ["fetch(", "axios", "https://", "twilio", "retell"]) {
      assert.ok(!src.includes(forbidden), `the approval must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.{1,2}\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });

  it("M8M added no AI-specific window and no AI-specific attempt rule (D)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-calling-approval.js"), "utf8");
    const code = strip(src);
    assert.ok(!/aiWindow|aiWindows|AI_WINDOW|aiCaps|aiAttempt/i.test(code), "AI calls use the same window as any other telemarketing call");
    // The windows the approval covers ARE the shared ones, not a copy.
    assert.strictEqual(FOUNDER_CALLING_POLICY.windows, CALLING_WINDOWS);
  });

  it("M8M invented no AI-disclosure wording (D)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-calling-approval.js"), "utf8");
    assert.ok(!/disclosureScript|mustDisclose|disclosureWording|"You are speaking/i.test(src), "disclosure wording is deliberately out of scope for this milestone");
  });
});
