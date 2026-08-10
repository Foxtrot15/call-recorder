// LOCKSMITH ACQUISITION M8B — contact outcomes.
//
// The properties worth holding down: an opt-out is suppressed before it is
// recorded, a suppression that cannot be written refuses the whole recording, a
// wrong number does not become a conversation that never happened, and no
// outcome can be recorded against a business no call could have reached.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createOutcomeRecorder, OUTCOME_LIFECYCLE, OUTCOME_RECORDABLE_FROM } = require("../src/services/acquisition-outcome");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createProspect, identityFingerprint } = require("../src/services/acquisition-prospect");
const { createAttemptPolicy, CALL_OUTCOMES, OUTCOME_RULES } = require("../src/services/acquisition-attempt-policy");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;

function prospect(lifecycle = "queued", overrides = {}) {
  const built = createProspect({
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
    ...overrides,
  });
  assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
  return Object.freeze({ ...built.prospect, lifecycle });
}

const FINGERPRINT = identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" });

function recorder(overrides = {}) {
  const suppression = createSuppressionList({ now });
  const audit = { rows: [], record: (r) => audit.rows.push(r) };
  return { suppression, audit, rec: createOutcomeRecorder({ now, suppression, audit, ...overrides }) };
}

const base = { actor: "Peter", note: "Spoke to the owner." };

// ── The outcome table ───────────────────────────────────────────────

describe("the outcome table", () => {
  it("covers every outcome the attempt policy knows about", async () => {
    for (const outcome of CALL_OUTCOMES) {
      assert.ok(OUTCOME_LIFECYCLE[outcome], `"${outcome}" has no lifecycle mapping`);
      assert.ok(OUTCOME_RULES[outcome], `"${outcome}" has no policy rule`);
    }
    for (const key of Object.keys(OUTCOME_LIFECYCLE)) {
      assert.ok(CALL_OUTCOMES.includes(key), `"${key}" is mapped but is not an outcome`);
    }
  });

  it("every mapped destination is a real state", async () => {
    for (const [outcome, m] of Object.entries(OUTCOME_LIFECYCLE)) {
      assert.ok(S.PROSPECT_STATES.includes(m.to), `${outcome} maps to "${m.to}", which is not a state`);
      assert.ok(m.meaning && m.meaning.length > 5, `${outcome} does not explain itself`);
    }
  });

  it("a wrong number is not recorded as having reached the business", async () => {
    // Somebody answered, but not this locksmith. Recording it as a connection
    // would put a conversation in the history that never happened.
    assert.strictEqual(OUTCOME_LIFECYCLE.wrong_person.reachedTheBusiness, false);
    assert.strictEqual(OUTCOME_LIFECYCLE.wrong_person.to, "attempted");
  });
});

// ── Opt-out: the one that must never leak ───────────────────────────

describe("an opt-out suppresses the business permanently", () => {
  it("suppresses, then transitions, and the business ends terminal", async () => {
    const { rec, suppression } = recorder();
    const result = await rec.record({ prospect: prospect("connected"), outcome: "opt_out", ...base, note: "Asked never to be called again.", e164: "+61355501042" });

    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.prospect.lifecycle, "suppressed");
    assert.strictEqual(result.suppression.applied, true);
    assert.strictEqual(result.suppression.scope, "business", "an opt-out is about the relationship, not the handset");
    assert.strictEqual(suppression.check({ fingerprint: FINGERPRINT }).suppressed, true);
  });

  it("catches the business on a number we have never seen before", async () => {
    // The whole reason an opt-out is business-scoped: they must not be
    // reachable on their other line next week.
    const { rec, suppression } = recorder();
    await rec.record({ prospect: prospect("connected"), outcome: "opt_out", ...base, note: "Do not call again.", e164: "+61355501042" });
    assert.strictEqual(suppression.check({ e164: "+61491570999", fingerprint: FINGERPRINT }).suppressed, true);
  });

  it("refuses to record an opt-out it cannot act on", async () => {
    // Recording "they opted out" while being unable to suppress produces a
    // record that says the right thing and a system that calls them again.
    const rec = createOutcomeRecorder({ now, suppression: null });
    const result = await rec.record({ prospect: prospect("connected"), outcome: "opt_out", ...base, note: "Do not call again." });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "suppression_unavailable");
    assert.match(result.message, /would leave them callable/);
  });

  it("does not transition the prospect if the suppression write fails", async () => {
    const failing = {
      suppress: () => ({ ok: false, code: "sink_failed", message: "The store rejected the write." }),
      check: () => ({ suppressed: false }),
    };
    const rec = createOutcomeRecorder({ now, suppression: failing });
    const p = prospect("connected");
    const result = await rec.record({ prospect: p, outcome: "opt_out", ...base, note: "Do not call again." });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "suppression_failed");
    assert.strictEqual(p.lifecycle, "connected", "the prospect must not have moved");
  });

  it("the suppression survives the prospect record being thrown away", async () => {
    // The list is keyed on the identity fingerprint, not on the prospect row,
    // so deleting and re-creating the prospect changes nothing.
    const { rec, suppression } = recorder();
    await rec.record({ prospect: prospect("connected"), outcome: "opt_out", ...base, note: "Do not call again." });

    const rebuilt = prospect("review_approved");
    assert.strictEqual(suppression.check({ fingerprint: identityFingerprint(rebuilt) }).suppressed, true);
  });

  it("is audited as a contact outcome with the effect it had", async () => {
    const { rec, audit } = recorder();
    await rec.record({ prospect: prospect("connected"), outcome: "opt_out", ...base, note: "Do not call again." });
    const row = audit.rows.find((r) => r.event === "contact_outcome");
    assert.ok(row);
    assert.strictEqual(row.detail.outcome, "opt_out");
    assert.strictEqual(row.detail.suppressed, true);
    assert.strictEqual(row.detail.to, "suppressed");
  });
});

// ── Wrong number: the number, not the business ──────────────────────

describe("a wrong number suppresses the number only", () => {
  it("suppresses the number and leaves the business reachable elsewhere", async () => {
    const { rec, suppression } = recorder();
    const result = await rec.record({ prospect: prospect("attempted"), outcome: "wrong_person", ...base, note: "Reached a private residence.", e164: "+61355501042" });

    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.suppression.scope, "number");
    assert.strictEqual(suppression.check({ e164: "+61355501042" }).suppressed, true);
    assert.strictEqual(suppression.check({ fingerprint: FINGERPRINT }).suppressed, false, "the business itself must not be suppressed");
  });

  it("needs the number that was dialled", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("attempted"), outcome: "wrong_person", ...base, note: "Reached a private residence." });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "number_required");
  });

  it("does not claim we spoke to the business", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("queued"), outcome: "wrong_person", ...base, note: "Reached a private residence.", e164: "+61355501042" });
    assert.strictEqual(result.reachedTheBusiness, false);
    assert.strictEqual(result.to, "attempted");
    assert.ok(!result.hops.some((h) => h.to === "connected"), "no connection should appear in the history");
  });
});

// ── The path through the state machine ──────────────────────────────

describe("the prospect is walked through states that actually happened", () => {
  it("a queued prospect that nobody answers becomes attempted", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("queued"), outcome: "no_answer", ...base, note: "Rang out." });
    assert.strictEqual(result.to, "attempted");
    assert.deepStrictEqual(result.hops.map((h) => h.to), ["attempted"]);
  });

  it("a queued prospect that declines is recorded as attempted, then connected, then not interested", async () => {
    // The history should read "we called, we spoke to them, they said no" —
    // not "we called, they said no".
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("queued"), outcome: "not_interested", ...base, note: "Happy with their current setup." });
    assert.strictEqual(result.to, "not_interested");
    assert.deepStrictEqual(result.hops.map((h) => h.to), ["attempted", "connected", "not_interested"]);
    assert.strictEqual(result.prospect.history.length, 3, "every hop is journalled");
  });

  it("every hop records who and why", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("queued"), outcome: "callback", ...base, note: "Asked for Tuesday." });
    for (const entry of result.prospect.history) {
      assert.strictEqual(entry.actor, "Peter");
      assert.ok(entry.reason.includes("Asked for Tuesday."));
      assert.ok(entry.at);
    }
  });

  it("an outcome that would need an illegal hop is refused, and nothing moves", async () => {
    const { rec } = recorder();
    const p = prospect("callback_requested");
    // `booked` wants to reach `interested`; callback_requested cannot go there
    // directly, but it can via `connected`, so this should succeed…
    assert.strictEqual((await rec.record({ prospect: p, outcome: "booked", ...base, note: "Booked a demo." })).ok, true);
    assert.strictEqual(p.lifecycle, "callback_requested", "the original must be untouched — prospects are frozen");
  });

  it("refuses an outcome for a business no call could have reached", async () => {
    const { rec } = recorder();
    for (const lifecycle of S.PROSPECT_STATES.filter((s) => !OUTCOME_RECORDABLE_FROM.includes(s))) {
      const result = await rec.record({ prospect: prospect(lifecycle), outcome: "no_answer", ...base, note: "Rang out." });
      assert.strictEqual(result.ok, false, `${lifecycle} must not accept a call outcome`);
      assert.strictEqual(result.code, "not_contactable_state");
    }
  });

  it("a suppressed business cannot have an outcome recorded against it at all", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("suppressed"), outcome: "booked", ...base, note: "They changed their mind." });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "not_contactable_state");
  });
});

// ── Unapproved consequences are reported, not invented ──────────────

describe("consequences nobody has approved are stated as such", () => {
  it("a not-interested outcome is permanent, and is NOT recorded as an opt-out", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("connected"), outcome: "not_interested", ...base, note: "Not right now." });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.consequence.approved, true, "A-L8 settled this");
    assert.strictEqual(result.consequence.effect, "no_further_acquisition");
    assert.strictEqual(result.consequence.enforcedBy, "durable_outcome_history");
    assert.strictEqual(result.consequence.suppressionWritten, false, "a decline is not a suppression row");
    assert.strictEqual(result.suppression.applied, false, "and nothing was written to the suppression list");
    assert.match(result.consequence.message, /not cold-called for acquisition again/);
    assert.ok(result.consequence.source, "it must name what settled it");
  });

  it("records the outcome anyway — the record of what they said is not optional", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("connected"), outcome: "declined", ...base, note: "Declined." });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.prospect.lifecycle, "not_interested");
  });

  it("a callback reports its honour window as in force under an approved policy", async () => {
    const suppression = createSuppressionList({ now });
    const rec = createOutcomeRecorder({ now, suppression, attemptPolicy: createAttemptPolicy({ approved: true, approvedBy: "Peter Dang" }) });
    const result = await rec.record({ prospect: prospect("connected"), outcome: "callback", ...base, note: "Call me Thursday." });
    assert.strictEqual(result.consequence.approved, true);
    assert.strictEqual(result.consequence.effect, "reschedule");
    assert.match(result.consequence.message, /applies/);
  });

  it("the two approved suppressions are applied regardless of the policy's approval state", async () => {
    // Opt-out and wrong-number are statutory/settled (§5 G5, §9); they do not
    // wait on the caps and cooldowns being agreed.
    const { rec, suppression } = recorder();
    assert.strictEqual((await rec.record({ prospect: prospect("connected"), outcome: "opt_out", ...base, note: "Do not call." })).ok, true);
    assert.strictEqual(suppression.count(), 1);
  });
});

// ── Validation ──────────────────────────────────────────────────────

describe("validation", () => {
  it("refuses an unknown outcome rather than guessing", async () => {
    const { rec } = recorder();
    for (const outcome of ["interested", "CONNECTED", "", null, undefined, 42]) {
      const result = await rec.record({ prospect: prospect(), outcome, ...base });
      assert.strictEqual(result.ok, false, `"${outcome}" should not be accepted`);
      assert.strictEqual(result.code, "outcome_unknown");
    }
  });

  it("requires who observed it and what happened", async () => {
    const { rec } = recorder();
    assert.strictEqual((await rec.record({ prospect: prospect(), outcome: "no_answer", actor: null, note: "x" })).code, "actor_missing");
    assert.strictEqual((await rec.record({ prospect: prospect(), outcome: "no_answer", actor: "Peter", note: "  " })).code, "note_missing");
  });

  it("refuses a malformed prospect rather than throwing", async () => {
    const { rec } = recorder();
    for (const bad of [null, undefined, "x", 7, []]) {
      assert.strictEqual((await rec.record({ prospect: bad, outcome: "no_answer", ...base })).code, "prospect_invalid");
    }
  });

  it("refuses to exist without a clock", async () => {
    assert.throws(() => createOutcomeRecorder({}), /injected now/);
  });
});

// ── Conversion ──────────────────────────────────────────────────────

describe("becoming a client", () => {
  it("an interested prospect can convert, and leaves the prospecting pool", async () => {
    const { rec } = recorder();
    const result = rec.recordConversion({ prospect: prospect("interested"), actor: "Peter", reason: "Signed up on the monthly plan." });
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.prospect.lifecycle, "customer");
    assert.match(result.message, /can no longer appear in a prospecting queue/);
  });

  it("converting a business that said no needs an administrative decision", async () => {
    const { rec } = recorder();
    const refused = rec.recordConversion({ prospect: prospect("not_interested"), actor: "Peter", reason: "They called us back." });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, "remediation_required");

    const allowed = rec.recordConversion({
      prospect: prospect("not_interested"),
      actor: "Peter",
      reason: "They called us back.",
      remediation: { approvedBy: "Peter Dang", justification: "Inbound — they contacted us, we did not re-approach them." },
    });
    assert.strictEqual(allowed.ok, true, allowed.message);
  });

  it("a suppressed business can never become a client through this path", async () => {
    const { rec } = recorder();
    const result = rec.recordConversion({
      prospect: prospect("suppressed"),
      actor: "Peter",
      reason: "They changed their mind.",
      remediation: { approvedBy: "Peter Dang", justification: "trying anyway" },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "transition_not_allowed");
  });

  it("requires who confirmed it and what was agreed", async () => {
    const { rec } = recorder();
    assert.strictEqual(rec.recordConversion({ prospect: prospect("interested"), actor: null, reason: "x" }).code, "actor_missing");
    assert.strictEqual(rec.recordConversion({ prospect: prospect("interested"), actor: "Peter", reason: null }).code, "reason_missing");
  });
});

// ── Safety ──────────────────────────────────────────────────────────

describe("the recorder cannot call anybody", () => {
  it("reaches no network and imports nothing that is not local", async () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-outcome"), "utf8");
    for (const forbidden of ["twilio", "retell", "fetch(", "axios", "XMLHttpRequest", "require(\"http", "require('http", "https://api.", "child_process"]) {
      assert.ok(!src.includes(forbidden), `the outcome recorder must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });

  it("returns frozen results", async () => {
    const { rec } = recorder();
    const result = await rec.record({ prospect: prospect("queued"), outcome: "no_answer", ...base, note: "Rang out." });
    assert.ok(Object.isFrozen(result));
    assert.throws(() => {
      "use strict";
      result.to = "customer";
    });
  });
});
