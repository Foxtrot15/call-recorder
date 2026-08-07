// LOCKSMITH ACQUISITION A1 — the prospect domain model and its state machine.
//
// The state machine is a whitelist: these tests exist to prove that the
// shortcuts which would matter — jumping straight to approved, promoting
// without a named actor, escaping suppression — are refused rather than merely
// undocumented.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createProspect, validateProspect, transitionProspect, assessProspect, identityFingerprint, prospectIdFor } = require("../src/services/acquisition-prospect");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const S = require("../src/services/acquisition-schema");

const FIXED = new Date("2026-08-01T00:00:00.000Z");
const now = () => FIXED;

function input(overrides = {}) {
  return {
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042", label: "Contact page" }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
    ...overrides,
  };
}

describe("creating a prospect", () => {
  it("builds a valid, frozen prospect that starts at the beginning", () => {
    const result = createProspect(input());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.prospect.lifecycle, "discovered");
    assert.deepStrictEqual([...result.prospect.history], []);
    assert.ok(Object.isFrozen(result.prospect));
  });

  it("a caller cannot hand us a prospect that is already approved", () => {
    const result = createProspect(input({ lifecycle: "review_approved", history: [{ forged: true }] }));
    assert.strictEqual(result.prospect.lifecycle, "discovered");
    assert.strictEqual(result.prospect.history.length, 0);
  });

  it("requires a business name, an origin and a timezone", () => {
    assert.strictEqual(createProspect(input({ businessName: "   " })).ok, false);
    assert.strictEqual(createProspect(input({ origin: "scraped" })).ok, false);

    const noTz = createProspect(input({ timezone: null }));
    assert.strictEqual(noTz.ok, false);
    assert.ok(noTz.errors.some((e) => /calling hours are checked/.test(e.message)), "timezone is a compliance input");
  });

  it("returns errors rather than throwing, so one bad record cannot kill a batch", () => {
    for (const bad of [null, undefined, 0, "", [], { businessName: 5 }]) {
      assert.doesNotThrow(() => createProspect(bad));
    }
  });

  it("never invents a phone number — no published number means an empty list", () => {
    const result = createProspect(input({ phones: [] }));
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual([...result.prospect.phones], []);
  });

  it("stores the phone number exactly as published, without normalising it", () => {
    const result = createProspect(input({ phones: [{ raw: "  (03) 5550 1042  " }] }));
    // Whitespace is tidied; the FORMAT is untouched — normalisation happens
    // after review, and rewriting the number first would destroy the thing
    // being reviewed.
    assert.strictEqual(result.prospect.phones[0].raw, "(03) 5550 1042");
  });

  it("accepts plain strings as phones", () => {
    const result = createProspect(input({ phones: ["(03) 5550 1042"] }));
    assert.strictEqual(result.prospect.phones[0].raw, "(03) 5550 1042");
  });

  it("keeps the Australian state separate from the lifecycle state", () => {
    const result = createProspect(input());
    assert.strictEqual(result.prospect.state, "VIC");
    assert.strictEqual(result.prospect.lifecycle, "discovered");
  });
});

describe("identity fingerprint", () => {
  it("treats corporate-form noise as the same business", () => {
    const a = identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" });
    const b = identityFingerprint({ businessName: "Northside Lock and Key Pty Ltd", suburb: "Brunswick", state: "VIC" });
    assert.strictEqual(a, b);
    assert.strictEqual(prospectIdFor({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" }), prospectIdFor({ businessName: "Northside Lock and Key Pty Ltd", suburb: "Brunswick", state: "VIC" }));
  });

  it("keeps different businesses apart", () => {
    assert.notStrictEqual(
      identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" }),
      identityFingerprint({ businessName: "Southside Lock & Key", suburb: "Brunswick", state: "VIC" })
    );
  });

  it("keeps the same name in different suburbs apart", () => {
    assert.notStrictEqual(
      identityFingerprint({ businessName: "City Locks", suburb: "Brunswick", state: "VIC" }),
      identityFingerprint({ businessName: "City Locks", suburb: "Geelong", state: "VIC" })
    );
  });

  it("does not use the phone number — a business that changes numbers is the same business", () => {
    const a = identityFingerprint({ businessName: "City Locks", suburb: "Brunswick", state: "VIC", phones: ["1"] });
    const b = identityFingerprint({ businessName: "City Locks", suburb: "Brunswick", state: "VIC", phones: ["2"] });
    assert.strictEqual(a, b);
  });
});

describe("the state machine", () => {
  const start = createProspect(input()).prospect;

  const step = (prospect, to, overrides = {}) => transitionProspect(prospect, to, { actor: "Peter", reason: "because", now, ...overrides });

  it("walks the intended path", () => {
    let p = start;
    for (const to of ["evidence_captured", "review_pending", "review_approved"]) {
      const result = step(p, to);
      assert.strictEqual(result.ok, true, `${p.lifecycle} → ${to}: ${result.message || ""}`);
      p = result.prospect;
    }
    assert.strictEqual(p.lifecycle, "review_approved");
    assert.strictEqual(p.history.length, 3);
  });

  it("refuses to skip evidence capture and review", () => {
    const result = step(start, "review_approved");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "transition_not_allowed");
    assert.match(result.message, /cannot go from/);
  });

  it("names the states a prospect COULD move to, so the error is actionable", () => {
    const result = step(start, "review_approved");
    assert.match(result.message, /Evidence collected|Permanently excluded/);
  });

  it("suppression is terminal — nothing brings a suppressed prospect back", () => {
    const suppressed = step(start, "suppressed").prospect;
    for (const to of S.PROSPECT_STATES) {
      assert.strictEqual(step(suppressed, to).ok, false, `suppressed → ${to} must be refused`);
    }
  });

  it("every state can reach suppression", () => {
    for (const from of S.PROSPECT_STATES.filter((s) => s !== "suppressed")) {
      assert.ok(S.PROSPECT_TRANSITIONS[from].includes("suppressed"), `${from} must be able to become suppressed`);
    }
  });

  it("an approved prospect can be reopened for review but never jumps elsewhere", () => {
    let p = step(step(step(start, "evidence_captured").prospect, "review_pending").prospect, "review_approved").prospect;
    assert.strictEqual(step(p, "review_pending").ok, true);
    assert.strictEqual(step(p, "review_rejected").ok, false);
    assert.strictEqual(step(p, "discovered").ok, false);
  });

  it("requires a named actor and a reason on every transition", () => {
    assert.strictEqual(step(start, "evidence_captured", { actor: null }).code, "actor_missing");
    assert.strictEqual(step(start, "evidence_captured", { actor: "  " }).code, "actor_missing");
    assert.strictEqual(step(start, "evidence_captured", { reason: null }).code, "reason_missing");
  });

  it("requires an injected clock", () => {
    assert.strictEqual(step(start, "evidence_captured", { now: undefined }).code, "clock_missing");
  });

  it("records who, why and when in an append-only history", () => {
    const result = step(start, "evidence_captured", { actor: "Peter", reason: "Checked the site." });
    const entry = result.prospect.history[0];
    assert.deepStrictEqual({ ...entry }, { from: "discovered", to: "evidence_captured", at: FIXED.toISOString(), actor: "Peter", reason: "Checked the site." });
    assert.ok(Object.isFrozen(result.prospect.history));
  });

  it("does not mutate the prospect it was given", () => {
    const before = start.lifecycle;
    step(start, "evidence_captured");
    assert.strictEqual(start.lifecycle, before);
    assert.strictEqual(start.history.length, 0);
  });

  it("refuses unknown states in either direction", () => {
    assert.strictEqual(step(start, "callable").code, "state_unknown");
    assert.strictEqual(transitionProspect({ ...start, lifecycle: "nonsense" }, "suppressed", { actor: "a", reason: "b", now }).code, "state_unknown");
  });
});

describe("assessing a prospect", () => {
  function ledgerFor(prospect, rows) {
    const ledger = createEvidenceLedger({ now });
    for (const row of rows) {
      ledger.record({
        prospectId: prospect.prospectId,
        captureMode: "fixture",
        observedAt: "2026-07-15T02:00:00.000Z",
        capturedBy: "test",
        ...row,
      });
    }
    return ledger.forProspect(prospect.prospectId);
  }

  it("a complete record with an official source has no gaps", () => {
    const p = createProspect(input()).prospect;
    const evidence = ledgerFor(p, [
      { kind: "business_name", value: "Northside Lock & Key", source: { url: "https://northsidelockandkey.example.com.au/contact" } },
      { kind: "trade_category", value: "Locksmith", source: { url: "https://northsidelockandkey.example.com.au/contact" } },
      { kind: "phone", value: "(03) 5550 1042", source: { url: "https://northsidelockandkey.example.com.au/contact" } },
    ]);
    const assessment = assessProspect(p, evidence);
    assert.deepStrictEqual([...assessment.gaps], []);
    assert.strictEqual(assessment.reviewable, true);
  });

  it("reports a phone that came only from an aggregator", () => {
    const p = createProspect(input({ sourceRefs: [{ url: "https://theirsite.example.com.au/" }, { url: "https://www.hotfrog.com.au/company/x" }] })).prospect;
    const evidence = ledgerFor(p, [
      { kind: "business_name", value: "X", source: { url: "https://theirsite.example.com.au/" } },
      { kind: "trade_category", value: "Locksmith", source: { url: "https://theirsite.example.com.au/" } },
      { kind: "phone", value: "(03) 5550 1042", source: { url: "https://www.hotfrog.com.au/company/x" } },
    ]);
    const assessment = assessProspect(p, evidence);
    assert.ok(assessment.gaps.some((g) => g.code === "phone_not_official"));
    assert.strictEqual(assessment.reviewable, false);
  });

  it("reports a missing phone, a missing official source and missing evidence", () => {
    const p = createProspect(input({ phones: [], sourceRefs: [{ url: "https://www.yellowpages.com.au/vic/x/y" }] })).prospect;
    const assessment = assessProspect(p, []);
    const codes = assessment.gaps.map((g) => g.code);
    assert.ok(codes.includes("no_phone"));
    assert.ok(codes.includes("no_official_source"));
    assert.ok(codes.includes("no_evidence_business_name"));
    assert.strictEqual(assessment.reviewable, false);
  });
});

// ── M8B: the engagement half of the lifecycle ───────────────────────
//
// The acquisition half (discovered → review_approved) was A1's and is asserted
// above. These cover what M8B added: the states that describe what happened
// when we approached a business, and the guards that stop a scheduler quietly
// re-approaching somebody who already answered.

describe("the engagement lifecycle (M8B)", () => {
  const step = (prospect, to, overrides = {}) => transitionProspect(prospect, to, { actor: "Peter", reason: "because", now, ...overrides });

  /** A prospect parked in an arbitrary lifecycle state, for transition probing. */
  const at = (lifecycle) => Object.freeze({ ...createProspect(input()).prospect, lifecycle, history: Object.freeze([]) });

  it("an approved prospect can be queued, but nothing skips straight to a call outcome", () => {
    const approved = at("review_approved");
    assert.strictEqual(step(approved, "queued").ok, true);
    for (const to of ["attempted", "connected", "interested", "customer", "not_interested", "callback_requested"]) {
      assert.strictEqual(step(approved, to).ok, false, `review_approved → ${to} must be refused`);
    }
  });

  it("a queued prospect can always be released back to the approved pool", () => {
    // If releasing were impossible, a revoked batch or an expired lease would
    // strand the record in `queued` forever and it would never be called again.
    assert.strictEqual(step(at("queued"), "review_approved").ok, true);
  });

  it("a customer is not a prospect: the only way out is suppression", () => {
    const customer = at("customer");
    assert.deepStrictEqual([...S.PROSPECT_TRANSITIONS.customer], ["suppressed"]);
    for (const to of S.PROSPECT_STATES.filter((s) => s !== "suppressed")) {
      assert.strictEqual(step(customer, to).ok, false, `customer → ${to} must be refused`);
    }
  });

  it("suppression is still terminal now that there are more states to escape to", () => {
    const suppressed = step(at("discovered"), "suppressed").prospect;
    for (const to of S.PROSPECT_STATES) {
      assert.strictEqual(step(suppressed, to).ok, false, `suppressed → ${to} must be refused`);
    }
  });

  it("every engagement state can still reach suppression", () => {
    for (const from of S.ENGAGEMENT_STATES) {
      assert.ok(S.PROSPECT_TRANSITIONS[from].includes("suppressed"), `${from} must be able to become suppressed`);
    }
  });
});

describe("remediation-gated transitions (M8B)", () => {
  const step = (prospect, to, overrides = {}) => transitionProspect(prospect, to, { actor: "Peter", reason: "because", now, ...overrides });
  const at = (lifecycle) => Object.freeze({ ...createProspect(input()).prospect, lifecycle, history: Object.freeze([]) });

  const remediation = { approvedBy: "Peter Dang", justification: "They asked us to follow up after their new branch opened." };

  it("re-approaching a business that said no is refused without an administrative decision", () => {
    const result = step(at("not_interested"), "queued");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "remediation_required");
    assert.match(result.message, /already said no/);
  });

  it("…and permitted with one, which is recorded on the history entry", () => {
    const result = step(at("not_interested"), "queued", { remediation });
    assert.strictEqual(result.ok, true, result.message);
    const entry = result.prospect.history[result.prospect.history.length - 1];
    assert.deepStrictEqual({ ...entry.remediation }, remediation);
  });

  it("a remediation cannot be signed by the automation that wants it", () => {
    for (const approvedBy of ["system", "AIDA", "bot", "automation", "auto", "Scheduler"]) {
      const result = step(at("not_interested"), "queued", { remediation: { ...remediation, approvedBy } });
      assert.strictEqual(result.ok, false, `"${approvedBy}" must not be able to authorise a re-approach`);
      assert.strictEqual(result.code, "remediation_actor_invalid");
    }
  });

  it("a justification alone is not an approval, and an approver alone is not a reason", () => {
    assert.strictEqual(step(at("not_interested"), "queued", { remediation: { justification: "we want to" } }).code, "remediation_required");
    assert.strictEqual(step(at("not_interested"), "queued", { remediation: { approvedBy: "Peter Dang" } }).code, "remediation_required");
  });

  it("ordinary transitions are unaffected — no remediation is demanded or recorded", () => {
    const result = step(at("review_approved"), "queued");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.prospect.history[0].remediation, undefined);
  });

  it("no remediation can revive a suppressed business", () => {
    const suppressed = step(at("discovered"), "suppressed").prospect;
    for (const to of S.PROSPECT_STATES) {
      assert.strictEqual(step(suppressed, to, { remediation }).ok, false, `suppressed → ${to} must stay refused even with a remediation`);
    }
    // And the table must never grow an entry that would permit it.
    for (const key of Object.keys(S.REMEDIATION_TRANSITIONS)) {
      assert.ok(!key.startsWith("suppressed->"), `${key} would make suppression revivable`);
    }
  });
});
