// LOCKSMITH ACQUISITION — attempt and wash policy.
//
// Backfilled in M8B. Exercised only through eligibility until M8J gave it a
// durable history to read.
//
// For most of this project's life the property that mattered here was that the
// policy defaulted to NOT APPROVED and that an unapproved policy blocked: G9's
// "3 attempts" was written as an illustration, G8's cooldown was literally "N
// days", and the retry spacing was proposed during A1 by nobody in particular.
//
// The founder has now decided A-L6, A-L7 and A-L8 (approval
// AL6-AL7-AL8-2026-08-10), so these tests changed shape. They no longer assert
// "nobody has agreed to this". They assert the approved policy IS what the
// founder said, that the retired placeholders cannot come back, and that a
// business which said no is never cold-called again.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createAttemptPolicy, POLICY_RULES, OUTCOME_RULES, ATTEMPT_CONSUMPTION, CALL_OUTCOMES, FOUNDER_APPROVAL } = require("../src/services/acquisition-attempt-policy");
const { foldOutcomes } = require("../src/services/acquisition-history");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;
const DAY = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(AT.getTime() - n * DAY).toISOString();

const PROSPECT = "pr_policy_test_0001";

/** A durable history built by the REAL fold, from rows shaped like the table. */
const durable = (...events) =>
  foldOutcomes(
    PROSPECT,
    events.map(([outcome, ago], i) => ({
      outcome,
      reachedTheBusiness: ["not_interested", "declined", "callback", "booked", "qualified", "opt_out"].includes(outcome),
      recordedAt: daysAgo(ago),
      e164: "+61355501042",
      actor: "tester",
      actorKind: "human",
      seq: i,
    }))
  );

const approvedPolicy = () => createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" });

// ── Approval ────────────────────────────────────────────────────────

describe("the policy is not in force until somebody puts their name to it", () => {
  it("defaults to unapproved", () => {
    const policy = createAttemptPolicy();
    assert.strictEqual(policy.approved, false);
    assert.strictEqual(policy.approvedBy, null);
  });

  it("`approved: true` with nobody named is not an approval", () => {
    // The exact shape of a config file somebody edited in a hurry.
    for (const approvedBy of [undefined, null, "", "   ", 42]) {
      const policy = createAttemptPolicy({ approved: true, approvedBy });
      assert.strictEqual(policy.approved, false, `approvedBy=${JSON.stringify(approvedBy)} must not count as an approval`);
    }
    assert.match(createAttemptPolicy({ approved: true }).describeGap(), /nobody was named/);
  });

  it("a named approver puts it in force", () => {
    const policy = approvedPolicy();
    assert.strictEqual(policy.approved, true);
    assert.strictEqual(policy.approvedBy, "Peter Dang");
    assert.match(policy.describeGap(), /was approved by Peter Dang/);
  });
});

// ── A-L6 / A-L7 / A-L8: the approved numbers ────────────────────────

describe("the founder-approved attempt policy (A-L6 / A-L7 / A-L8)", () => {
  it("records the approval itself, with a reference and a date", () => {
    assert.strictEqual(FOUNDER_APPROVAL.approvedBy, "Peter Dang");
    assert.ok(/^AL6-AL7-AL8-\d{4}-\d{2}-\d{2}$/.test(FOUNDER_APPROVAL.ref), "the approval needs a citable reference");
    assert.deepStrictEqual([...FOUNDER_APPROVAL.covers], ["A-L6", "A-L7", "A-L8"]);
  });

  it("nothing in the policy is left undecided", () => {
    const policy = approvedPolicy();
    assert.deepStrictEqual([...policy.unapprovedRules], [], "a rule nobody agreed to would block every call");
    assert.deepStrictEqual([...policy.unapprovedOutcomes], []);
    assert.deepStrictEqual([...policy.unapprovedConsumption], []);
  });

  it("an approval cannot outrun its contents — one unapproved entry and it is not in force", () => {
    // Simulated by reaching past the public API: if a future rule is added
    // without an approval, `approved` must go false rather than stay true.
    const policy = approvedPolicy();
    assert.strictEqual(policy.approved, true);
    const anyUnapproved = Object.values(policy.rules).some((r) => !r.approved);
    assert.strictEqual(anyUnapproved, false, "if this ever fails, `approved` must have gone false with it");
  });

  it("the approved factory carries the approval reference as its version", () => {
    const { createFounderApprovedAttemptPolicy } = require("../src/services/acquisition-attempt-policy");
    const policy = createFounderApprovedAttemptPolicy();
    assert.strictEqual(policy.approved, true);
    assert.strictEqual(policy.approvedBy, "Peter Dang");
    assert.strictEqual(policy.version, FOUNDER_APPROVAL.ref, "a decision must be traceable to the approval that authorised it");
    assert.strictEqual(policy.value("maxAttemptsPerProspect"), 2);
  });

  it("the engine still defaults to unapproved — it may not help itself to the approval", () => {
    assert.strictEqual(createAttemptPolicy().approved, false);
  });

  it("A-L6: the cap is 2 counted attempts and the spacing is 2 days", () => {
    const policy = approvedPolicy();
    assert.strictEqual(policy.value("maxAttemptsPerProspect"), 2);
    assert.strictEqual(policy.value("minDaysBetweenAttempts"), 2);
    assert.strictEqual(POLICY_RULES.maxAttemptsPerProspect.approved, true);
    assert.strictEqual(POLICY_RULES.minDaysBetweenAttempts.approved, true);
  });

  it("A-L8: an explicitly requested callback is honoured for 14 days", () => {
    assert.strictEqual(approvedPolicy().value("callbackHonourDays"), 14);
  });

  it("the statutory wash period is untouched by the founder's decision", () => {
    assert.strictEqual(approvedPolicy().value("washValidityDays"), 30);
    assert.match(POLICY_RULES.washValidityDays.source, /Act|Standard/i);
  });

  it("every rule carries a value or an explicit retirement, and a source", () => {
    for (const [key, rule] of Object.entries(POLICY_RULES)) {
      if (rule.retired === true) assert.strictEqual(rule.value, null, `${key} is retired and must hold no value`);
      else assert.ok(Number.isFinite(rule.value), `${key} has no value`);
      assert.strictEqual(rule.approved, true, `${key} is still unapproved`);
      assert.ok(rule.source && rule.source.length > 3, `${key} does not say where it came from`);
    }
  });
});

// ── The retired placeholders cannot come back ───────────────────────

describe("the superseded placeholders are retired, not merely re-tuned", () => {
  it("the 3-attempt placeholder is gone and cannot return through config", () => {
    const { DEFAULT_CAPS } = require("../src/config/acquisition");
    assert.strictEqual(DEFAULT_CAPS.maxAttemptsPerProspect, 2, "config must not still carry the illustrative 3");
    assert.strictEqual(POLICY_RULES.maxAttemptsPerProspect.value, 2);
  });

  it("an override may make a campaign stricter but never looser", () => {
    const stricter = createAttemptPolicy({ approved: true, approvedBy: "Peter Dang", rules: { maxAttemptsPerProspect: 1 } });
    assert.strictEqual(stricter.value("maxAttemptsPerProspect"), 1, "a campaign may try less often");

    // The whole point: the retired 3 must not come back this way.
    const looser = createAttemptPolicy({ approved: true, approvedBy: "Peter Dang", rules: { maxAttemptsPerProspect: 3 } });
    assert.strictEqual(looser.value("maxAttemptsPerProspect"), 2, "an override may not raise the approved cap");
    assert.ok(
      looser.refusedOverrides.some((o) => o.key === "maxAttemptsPerProspect" && o.requested === 3),
      "a refused override must be recorded, not silently dropped"
    );
  });

  it("spacing may be lengthened but not shortened", () => {
    assert.strictEqual(createAttemptPolicy({ rules: { minDaysBetweenAttempts: 7 } }).value("minDaysBetweenAttempts"), 7);
    assert.strictEqual(createAttemptPolicy({ rules: { minDaysBetweenAttempts: 0 } }).value("minDaysBetweenAttempts"), 2);
  });

  it("the generic 30-day post-contact cooldown no longer controls anything", () => {
    const policy = approvedPolicy();
    assert.strictEqual(POLICY_RULES.recentContactCooldownDays.retired, true);
    assert.strictEqual(policy.value("recentContactCooldownDays"), null);

    // A business spoken to yesterday, with no refusing outcome, is not blocked
    // by a generic silence rule any more.
    const result = policy.assess({ attempts: 1, lastContactAt: daysAgo(1) }, { now });
    assert.notStrictEqual(result.code, "recent_contact_cooldown", "the retired rule must not still be blocking");
  });

  it("the 180- and 90-day decline cooldowns are retired", () => {
    assert.strictEqual(POLICY_RULES.notInterestedCooldownDays.retired, true);
    assert.strictEqual(POLICY_RULES.declinedCooldownDays.retired, true);
    assert.strictEqual(POLICY_RULES.notInterestedCooldownDays.value, null);
    assert.strictEqual(POLICY_RULES.declinedCooldownDays.value, null);
  });

  it("a retired rule ignores an override outright", () => {
    const policy = createAttemptPolicy({ rules: { recentContactCooldownDays: 30 } });
    assert.strictEqual(policy.value("recentContactCooldownDays"), null, "a retired rule must not be revivable");
    assert.ok(policy.refusedOverrides.some((o) => o.key === "recentContactCooldownDays"));
  });
});

// ── A-L7: what consumes a counted attempt ───────────────────────────

describe("A-L7 — what consumes one of the two counted attempts", () => {
  const policy = approvedPolicy();

  it("a no-answer does NOT consume one; a voicemail DOES", () => {
    assert.strictEqual(ATTEMPT_CONSUMPTION.no_answer.countsTowardCap, false);
    assert.strictEqual(ATTEMPT_CONSUMPTION.voicemail.countsTowardCap, true);
    assert.strictEqual(ATTEMPT_CONSUMPTION.no_answer.approved, true);
    assert.strictEqual(ATTEMPT_CONSUMPTION.voicemail.approved, true);
  });

  it("three no-answers do not spend the two attempts merely by ringing", () => {
    const history = durable(["no_answer", 30], ["no_answer", 20], ["no_answer", 10]);
    assert.strictEqual(policy.countAttempts(history), 0, "ringing out is not an attempt spent");
    assert.strictEqual(policy.assess({ history }, { now }).ok, true, "and the business is still callable");
  });

  it("two voicemails reach the ceiling", () => {
    const history = durable(["voicemail", 30], ["voicemail", 10]);
    assert.strictEqual(policy.countAttempts(history), 2);
    const result = policy.assess({ history }, { now });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "attempt_cap_reached");
    assert.strictEqual(result.temporary, false, "a reached cap does not lift with time");
  });

  it("a mixed sequence counts only the voicemails", () => {
    const history = durable(["no_answer", 40], ["voicemail", 30], ["no_answer", 20], ["voicemail", 10]);
    assert.strictEqual(policy.countAttempts(history), 2, "two voicemails count; two no-answers do not");
    assert.strictEqual(policy.assess({ history }, { now }).code, "attempt_cap_reached");
  });

  it("one voicemail among no-answers leaves one attempt left", () => {
    const history = durable(["no_answer", 40], ["voicemail", 30], ["no_answer", 20]);
    assert.strictEqual(policy.countAttempts(history), 1);
    assert.strictEqual(policy.assess({ history }, { now }).ok, true);
  });

  it("an outcome nobody has classified is counted, not waved through", () => {
    const history = durable(["no_answer", 10]);
    const spiked = { ...history, outcomes: [...history.outcomes, { outcome: "something_new", recordedAt: daysAgo(5), reachedTheBusiness: false }] };
    assert.strictEqual(policy.countAttempts(spiked), 1, "an unrecognised outcome must not be free");
  });
});

// ── Retry spacing ───────────────────────────────────────────────────

describe("retry spacing", () => {
  const policy = approvedPolicy();

  it("refuses to call again inside 2 days, and says when it may", () => {
    const result = policy.assess({ attempts: 1, lastAttemptAt: daysAgo(0) }, { now });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "retry_spacing");
    assert.strictEqual(result.temporary, true);
    assert.ok(result.readyAt instanceof Date, "a temporary block must say when it lifts");
    assert.ok(result.readyAt.getTime() > AT.getTime());
    assert.match(result.message, /harassment, not persistence/);
  });

  it("allows a retry once 2 days have passed", () => {
    assert.strictEqual(policy.assess({ attempts: 1, lastAttemptAt: daysAgo(3) }, { now }).ok, true);
  });

  it("the clock starts at the last call EVENT, including an uncounted no-answer", () => {
    // The business was rung yesterday and did not answer. That consumed no
    // counted attempt, but it still rang their phone, so 2 days are owed.
    const history = durable(["no_answer", 1]);
    const result = policy.assess({ history }, { now });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "retry_spacing", "an uncounted attempt still starts the spacing clock");
  });
});

// ── A-L8: a decline is permanent ────────────────────────────────────

describe("A-L8 — not_interested and declined are permanent, not cooldowns", () => {
  const policy = approvedPolicy();

  for (const outcome of ["not_interested", "declined"]) {
    it(`${outcome} permanently prevents another cold acquisition call`, () => {
      const result = policy.assess({ history: durable([outcome, 1]) }, { now });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, "acquisition_declined");
      assert.strictEqual(result.temporary, false, "permanent — it must not lift with time");
      assert.strictEqual(result.readyAt, null, "there is no date on which this becomes callable");
    });

    it(`${outcome} is still refused years later`, () => {
      const longAgo = () => new Date(AT.getTime() + 5 * 365 * DAY);
      const result = policy.assess({ history: durable([outcome, 1]) }, { now: longAgo });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, "acquisition_declined");
    });

    it(`${outcome} is NOT recorded or reported as an opt-out`, () => {
      const result = policy.assess({ history: durable([outcome, 1]) }, { now });
      assert.notStrictEqual(result.code, "opted_out", "a decline is not a request to stop contacting");
      assert.strictEqual(OUTCOME_RULES[outcome].effect, "no_further_acquisition");
      assert.notStrictEqual(OUTCOME_RULES[outcome].effect, "suppress_business_permanently");
      assert.ok(!/opt/i.test(result.message), "the explanation must not describe this as an opt-out");
    });
  }

  it("the two remain analytically distinct even though the consequence is one", () => {
    const ni = policy.assess({ history: durable(["not_interested", 1]) }, { now });
    const de = policy.assess({ history: durable(["declined", 1]) }, { now });
    assert.strictEqual(ni.outcome, "not_interested");
    assert.strictEqual(de.outcome, "declined");
    assert.notStrictEqual(ni.message, de.message, "the two must not collapse into one explanation");
    // And the stored vocabulary keeps them apart.
    assert.ok(CALL_OUTCOMES.includes("not_interested") && CALL_OUTCOMES.includes("declined"));
  });

  it("an explicit opt-out stays separate, and stronger", () => {
    const result = policy.assess({ history: durable(["opt_out", 1]) }, { now });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "opted_out");
    assert.strictEqual(result.temporary, false);
    assert.match(result.message, /asked not to be contacted/);
    assert.strictEqual(OUTCOME_RULES.opt_out.effect, "suppress_business_permanently");
  });

  it("a refusal ANYWHERE in the history is permanent — a later event cannot bury it", () => {
    // The failure this prevents: read only the latest outcome and a stray
    // later row makes a business that said no callable again.
    const history = durable(["not_interested", 30], ["no_answer", 2]);
    assert.strictEqual(history.latestOutcome, "no_answer", "the latest outcome is deliberately not the refusal");
    const result = policy.assess({ history }, { now });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "acquisition_declined", "the refusal must still be found");
  });

  it("a decline outranks everything a fresh-looking history would otherwise allow", () => {
    // Zero counted attempts, spacing long past — and still refused.
    const history = durable(["declined", 400]);
    const result = policy.assess({ history }, { now });
    assert.strictEqual(policy.countAttempts(history), 1);
    assert.strictEqual(result.code, "acquisition_declined");
  });

  it("survives a restart: the same durable rows in a new policy give the same answer", () => {
    const rows = durable(["not_interested", 10]);
    const first = approvedPolicy().assess({ history: rows }, { now });
    const afterRestart = createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" }).assess({ history: rows }, { now });
    assert.strictEqual(first.code, "acquisition_declined");
    assert.deepStrictEqual(afterRestart.code, first.code);
  });

  it("a caller cannot talk the policy out of a durable refusal with a clean snapshot", () => {
    // The stale-caller attack: durable history says declined; the caller hands
    // in a spotless set of loose fields alongside it. The durable rows win.
    const result = policy.assess(
      { history: durable(["declined", 5]), attempts: 0, lastAttemptAt: null, lastContactAt: null, lastOutcome: "no_answer" },
      { now }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "acquisition_declined");
  });
});

// ── Callback ────────────────────────────────────────────────────────

describe("an explicitly requested callback", () => {
  const policy = approvedPolicy();

  it("is honoured inside the window, despite ordinary retry spacing", () => {
    // Asked for a callback yesterday — inside the 2-day spacing rule, which
    // would otherwise refuse.
    const result = policy.assess({ history: durable(["callback", 1]) }, { now });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.code, "callback_honour");
    assert.strictEqual(result.invited, true);
    assert.match(result.message, /invited it/);
  });

  it("is honoured even when the counted-attempt cap is already reached", () => {
    const history = durable(["voicemail", 20], ["voicemail", 10], ["callback", 1]);
    assert.strictEqual(policy.countAttempts(history), 3, "the callback itself counted as a conversation");
    const result = policy.assess({ history }, { now });
    assert.strictEqual(result.ok, true, "a call they asked for is not a cold acquisition attempt");
    assert.strictEqual(result.code, "callback_honour");
  });

  it("lapses after 14 days, and then fails closed rather than becoming a cold call", () => {
    const result = policy.assess({ history: durable(["callback", 20]) }, { now });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "callback_window_expired");
    assert.strictEqual(result.temporary, false);
    assert.match(result.message, /not treated as permission for a fresh cold call/);
  });

  it("does not override a refusal recorded earlier", () => {
    const history = durable(["not_interested", 30], ["callback", 1]);
    assert.strictEqual(policy.assess({ history }, { now }).code, "acquisition_declined");
  });
});

// ── Outcome rules ───────────────────────────────────────────────────

describe("outcome consequences", () => {
  it("every outcome has a rule, and every rule is for a real outcome", () => {
    for (const outcome of CALL_OUTCOMES) assert.ok(OUTCOME_RULES[outcome], `"${outcome}" has no rule`);
    for (const outcome of Object.keys(OUTCOME_RULES)) assert.ok(CALL_OUTCOMES.includes(outcome), `"${outcome}" is a rule for nothing`);
  });

  it("every outcome also says whether it consumes an attempt", () => {
    for (const outcome of CALL_OUTCOMES) assert.ok(ATTEMPT_CONSUMPTION[outcome], `"${outcome}" has no consumption rule`);
  });

  it("the two suppressing outcomes are approved, because the architecture states them outright", () => {
    assert.strictEqual(OUTCOME_RULES.opt_out.effect, "suppress_business_permanently");
    assert.strictEqual(OUTCOME_RULES.opt_out.approved, true);
    assert.strictEqual(OUTCOME_RULES.wrong_person.effect, "suppress_number");
    assert.strictEqual(OUTCOME_RULES.wrong_person.approved, true);
  });

  it("an opt-out suppresses the business, not the number that happened to be dialled", () => {
    assert.notStrictEqual(OUTCOME_RULES.opt_out.effect, "suppress_number");
  });

  it("no outcome still claims a cooldown, because no cooldown rule survives", () => {
    for (const [outcome, rule] of Object.entries(OUTCOME_RULES)) {
      assert.notStrictEqual(rule.effect, "cooldown", `${outcome} still names the retired cooldown mechanism`);
    }
  });

  it("every effect a rule names is one the policy actually implements", () => {
    const IMPLEMENTED = new Set(["suppress_business_permanently", "suppress_number", "no_further_acquisition", "does_not_consume_attempt", "counts_as_attempt", "reschedule", "stop_calling"]);
    for (const [outcome, rule] of Object.entries(OUTCOME_RULES)) {
      assert.ok(IMPLEMENTED.has(rule.effect), `${outcome} names an effect nothing handles: "${rule.effect}"`);
      if (rule.ruleKey) assert.ok(POLICY_RULES[rule.ruleKey], `${outcome} cites rule "${rule.ruleKey}", which does not exist`);
    }
  });

  it("an effect that stops calling is never described as temporary", () => {
    const policy = approvedPolicy();
    for (const outcome of ["not_interested", "declined", "opt_out", "booked", "qualified"]) {
      const result = policy.assess({ history: durable([outcome, 1]) }, { now });
      assert.strictEqual(result.ok, false, `${outcome} should stop calling`);
      assert.strictEqual(result.temporary, false, `${outcome} must not read as a delay`);
      assert.strictEqual(result.readyAt, null);
    }
  });
});

// ── Assessment ──────────────────────────────────────────────────────

describe("assessing a prospect's history", () => {
  const policy = approvedPolicy();
  const assess = (history) => policy.assess(history, { now });

  it("a prospect never tried before is clear", () => {
    assert.strictEqual(assess({}).ok, true);
    assert.strictEqual(assess({ attempts: 0 }).ok, true);
  });

  it("stops permanently once the attempt cap is reached", () => {
    const result = assess({ attempts: 2 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "attempt_cap_reached");
    assert.strictEqual(result.temporary, false, "a reached cap does not lift with time");
    assert.strictEqual(result.readyAt, null);
  });

  it("a terminal outcome stops calling regardless of how few attempts were made", () => {
    for (const outcome of ["booked", "qualified"]) {
      const result = assess({ attempts: 0, lastOutcome: outcome });
      assert.strictEqual(result.ok, false, `${outcome} should stop calling`);
      assert.strictEqual(result.code, "outcome_terminal");
      assert.strictEqual(result.temporary, false);
    }
  });

  it("an unreadable history is refused, not treated as never-called", () => {
    const result = assess({ history: { available: false, reason: "the store was unreachable." } });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "history_unavailable");
    assert.match(result.message, /"unknown" is not "never"/);
  });

  it("a reached cap outranks spacing — permanent before temporary", () => {
    assert.strictEqual(assess({ attempts: 2, lastAttemptAt: daysAgo(0) }).code, "attempt_cap_reached");
  });

  it("requires an injected clock rather than reading the machine's", () => {
    assert.throws(() => policy.assess({}, {}), /injected now/);
  });

  it("survives a malformed history rather than throwing", () => {
    for (const history of [{}, { attempts: "many" }, { lastAttemptAt: "yesterday" }, { lastOutcome: "nonsense" }, null, undefined]) {
      assert.doesNotThrow(() => policy.assess(history || {}, { now }));
    }
  });
});

// ── Safety ──────────────────────────────────────────────────────────

describe("the policy module is inert", () => {
  it("is frozen, so nothing can approve it after construction", () => {
    const policy = createAttemptPolicy();
    assert.ok(Object.isFrozen(policy));
    assert.throws(() => {
      "use strict";
      policy.approved = true;
    });
    assert.strictEqual(policy.approved, false);
  });

  it("reaches no network and imports nothing that is not local", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-attempt-policy"), "utf8");
    for (const forbidden of ["fetch(", "axios", 'require("http', "require('http", "https://", "twilio", "retell"]) {
      assert.ok(!src.includes(forbidden), `the attempt policy must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.{1,2}\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });
});
