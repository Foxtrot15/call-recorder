// LOCKSMITH ACQUISITION — attempt and wash policy.
//
// Backfilled in M8B. Exercised only through eligibility until now.
//
// The property that matters most here is that the policy defaults to NOT
// APPROVED, and that an unapproved policy blocks. Most of these numbers have no
// source: G9's "3 attempts" is written as an illustration, G8's cooldown is
// literally "N days", and the retry spacing was proposed during A1 by nobody in
// particular. A default of "in force" would turn a placeholder into a rule.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createAttemptPolicy, PROPOSED_RULES, OUTCOME_RULES, CALL_OUTCOMES } = require("../src/services/acquisition-attempt-policy");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;
const DAY = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(AT.getTime() - n * DAY).toISOString();

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
    const policy = createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" });
    assert.strictEqual(policy.approved, true);
    assert.strictEqual(policy.approvedBy, "Peter Dang");
    assert.match(policy.describeGap(), /was approved by Peter Dang/);
  });

  it("names exactly which values nobody has agreed to", () => {
    const gap = createAttemptPolicy().describeGap();
    assert.match(gap, /has not been approved/);
    for (const rule of createAttemptPolicy().unapprovedRules) {
      assert.ok(gap.includes(rule.key), `${rule.key} is unapproved but is not named in the gap description`);
    }
  });
});

// ── Provenance is recorded per rule ─────────────────────────────────

describe("every rule says where it came from", () => {
  it("each proposed rule carries a value and a source", () => {
    for (const [key, rule] of Object.entries(PROPOSED_RULES)) {
      assert.ok(Number.isFinite(rule.value), `${key} has no value`);
      assert.strictEqual(typeof rule.approved, "boolean", `${key} does not say whether it is approved`);
      assert.ok(rule.source && rule.source.length > 3, `${key} does not say where it came from`);
    }
  });

  it("the DNCR wash validity is the one rule with statutory backing", () => {
    const wash = Object.entries(PROPOSED_RULES).find(([k]) => /wash/i.test(k));
    assert.ok(wash, "there should be a wash-validity rule");
    assert.strictEqual(wash[1].approved, true, "the statutory 30 days is the one settled number");
    assert.match(wash[1].source, /Statutory|Act|Standard/i);
  });

  it("the caps and cooldowns are honest about having no source", () => {
    const unapproved = createAttemptPolicy().unapprovedRules;
    assert.ok(unapproved.length > 0, "if everything is approved, the disclaimer has quietly gone away");
    for (const rule of unapproved) {
      assert.ok(rule.source, `${rule.key} is unapproved but does not say why`);
    }
  });

  it("a caller may override a value, and the override is what applies", () => {
    const policy = createAttemptPolicy({ rules: { maxAttemptsPerProspect: 5 } });
    assert.strictEqual(policy.value("maxAttemptsPerProspect"), 5);
  });
});

// ── Outcome rules ───────────────────────────────────────────────────

describe("outcome consequences", () => {
  it("every outcome has a rule, and every rule is for a real outcome", () => {
    for (const outcome of CALL_OUTCOMES) assert.ok(OUTCOME_RULES[outcome], `"${outcome}" has no rule`);
    for (const outcome of Object.keys(OUTCOME_RULES)) assert.ok(CALL_OUTCOMES.includes(outcome), `"${outcome}" is a rule for nothing`);
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

  it("the cooldown durations are unapproved, and say so", () => {
    for (const outcome of ["not_interested", "declined", "callback"]) {
      assert.strictEqual(OUTCOME_RULES[outcome].approved, false, `${outcome} must not claim to be settled policy`);
      assert.ok(OUTCOME_RULES[outcome].source);
    }
  });

  it("whether an unanswered call consumes an attempt is still undecided", () => {
    for (const outcome of ["no_answer", "voicemail"]) {
      assert.strictEqual(OUTCOME_RULES[outcome].effect, "counts_as_attempt");
      assert.strictEqual(OUTCOME_RULES[outcome].approved, false, "A-L7 is open; this must not read as decided");
    }
  });

  it("every effect a rule names is one the policy actually implements", () => {
    const IMPLEMENTED = new Set(["suppress_business_permanently", "suppress_number", "cooldown", "counts_as_attempt", "reschedule", "stop_calling"]);
    for (const [outcome, rule] of Object.entries(OUTCOME_RULES)) {
      assert.ok(IMPLEMENTED.has(rule.effect), `${outcome} names an effect nothing handles: "${rule.effect}"`);
      if (rule.ruleKey) assert.ok(PROPOSED_RULES[rule.ruleKey], `${outcome} cites rule "${rule.ruleKey}", which does not exist`);
    }
  });
});

// ── Assessment ──────────────────────────────────────────────────────

describe("assessing a prospect's history", () => {
  const policy = createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" });
  const assess = (history) => policy.assess(history, { now });

  it("a prospect never tried before is clear", () => {
    assert.strictEqual(assess({}).ok, true);
    assert.strictEqual(assess({ attempts: 0 }).ok, true);
  });

  it("stops permanently once the attempt cap is reached", () => {
    const cap = policy.value("maxAttemptsPerProspect");
    const result = assess({ attempts: cap });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "attempt_cap_reached");
    assert.strictEqual(result.temporary, false, "a reached cap does not lift with time");
    assert.strictEqual(result.readyAt, null);
  });

  it("refuses to call again too soon, and says when it may", () => {
    const result = assess({ attempts: 1, lastAttemptAt: daysAgo(0) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "retry_spacing");
    assert.strictEqual(result.temporary, true);
    assert.ok(result.readyAt instanceof Date, "a temporary block must say when it lifts");
    assert.ok(result.readyAt.getTime() > AT.getTime());
    assert.match(result.message, /harassment, not persistence/);
  });

  it("allows a retry once the spacing has passed", () => {
    const spacing = policy.value("minDaysBetweenAttempts");
    assert.strictEqual(assess({ attempts: 1, lastAttemptAt: daysAgo(spacing + 1) }).ok, true);
  });

  it("leaves a business alone after recent contact", () => {
    const result = assess({ attempts: 1, lastContactAt: daysAgo(1) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "recent_contact_cooldown");
    assert.strictEqual(result.temporary, true);
  });

  it("honours the cooldown a declining outcome triggers", () => {
    const result = assess({ attempts: 1, lastOutcome: "not_interested", lastAttemptAt: daysAgo(1) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "outcome_cooldown");
    assert.match(result.message, /not interested/);
  });

  it("a terminal outcome stops calling regardless of how few attempts were made", () => {
    for (const outcome of ["booked", "qualified"]) {
      const result = assess({ attempts: 0, lastOutcome: outcome });
      assert.strictEqual(result.ok, false, `${outcome} should stop calling`);
      assert.strictEqual(result.code, "outcome_terminal");
      assert.strictEqual(result.temporary, false);
    }
  });

  it("a reached cap outranks a cooldown — permanent before temporary", () => {
    const cap = policy.value("maxAttemptsPerProspect");
    assert.strictEqual(assess({ attempts: cap, lastAttemptAt: daysAgo(0) }).code, "attempt_cap_reached");
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
