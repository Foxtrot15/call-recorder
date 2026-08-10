// LOCKSMITH ACQUISITION M8B — the founder/operator read model.
//
// The dangerous number here is "callable now". These tests exist mostly to stop
// it being optimistic: unknown must never be counted as callable, a cached
// verdict must never be reported, and the categorisation must agree with the
// batch screen rather than being a second opinion.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { summarisePipeline, describePipeline } = require("../src/services/acquisition-readmodel");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { createCallQueue } = require("../src/services/acquisition-queue");
const { createProspect } = require("../src/services/acquisition-prospect");
const { CATEGORIES } = require("../src/services/acquisition-batch");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;

const TRADE_EVIDENCE = [{ evidenceId: "e1", kind: "trade_category", value: "Locksmith — 24 hour emergency lockouts" }];
const evidenceFor = () => TRADE_EVIDENCE;

function prospect(overrides = {}) {
  const { lifecycle = "review_approved", ...rest } = overrides;
  const built = createProspect({
    businessName: "Northside Lock & Key",
    tradeCategory: "Locksmith — 24 hour emergency lockouts",
    abn: "51 824 753 556",
    suburb: "Brunswick",
    state: "VIC",
    postcode: "3056",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 1042" }],
    sourceRefs: [{ url: "https://northsidelockandkey.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
    ...rest,
  });
  assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
  return Object.freeze({ ...built.prospect, lifecycle });
}

const eligible = () => (p) => Object.freeze({ eligible: true, code: "eligible", message: "This business can be called now.", canonicalNumber: "+61355501042", localTime: "13:00", prospectId: p.prospectId, businessName: p.businessName, failedChecks: [] });

const blockedWith = (code, message, failedChecks = []) => (p) => Object.freeze({ eligible: false, code, message, prospectId: p.prospectId, businessName: p.businessName, failedChecks });

const summarise = (opts) => summarisePipeline({ at: AT, evidenceFor, ...opts });

// ── Totals ──────────────────────────────────────────────────────────

describe("the headline numbers", () => {
  it("counts prospects, qualified and callable now", () => {
    const s = summarise({ prospects: [prospect(), prospect({ businessName: "Bravo Locks", suburb: "Fitzroy" })], evaluate: eligible() });
    assert.strictEqual(s.totals.prospects, 2);
    assert.strictEqual(s.totals.qualified, 2);
    assert.strictEqual(s.totals.callableNow, 2);
    assert.strictEqual(s.totals.blocked, 0);
  });

  it("an unqualified prospect is counted but not qualified", () => {
    const locksmith = prospect();
    const plumber = prospect({ businessName: "Ace Plumbing", suburb: "Kew", tradeCategory: "Plumbing" });
    const s = summarise({
      prospects: [locksmith, plumber],
      evaluate: eligible(),
      // Evidence is per prospect: handing the plumber the locksmith's trade
      // evidence would qualify it, which is exactly the mistake this asserts against.
      evidenceFor: (id) => (id === locksmith.prospectId ? TRADE_EVIDENCE : []),
    });
    assert.strictEqual(s.totals.prospects, 2);
    assert.strictEqual(s.totals.qualified, 1, "the plumber must not be counted as qualified");
    assert.ok(s.qualification.verdicts.disqualified >= 1);
  });

  it("qualification tiers and verdicts add up to the prospect count", () => {
    const list = [prospect(), prospect({ businessName: "Bravo Locks", suburb: "Fitzroy" }), prospect({ businessName: "Ace Plumbing", suburb: "Kew", tradeCategory: "Plumbing" })];
    const s = summarise({ prospects: list, evaluate: eligible() });
    assert.strictEqual(Object.values(s.qualification.tiers).reduce((a, b) => a + b, 0), 3);
    assert.strictEqual(Object.values(s.qualification.verdicts).reduce((a, b) => a + b, 0), 3);
  });

  it("lifecycle counts add up to the prospect count", () => {
    const list = [prospect(), prospect({ lifecycle: "queued", businessName: "B", suburb: "Kew" }), prospect({ lifecycle: "suppressed", businessName: "C", suburb: "Kew" })];
    const s = summarise({ prospects: list, evaluate: eligible() });
    assert.strictEqual(Object.values(s.lifecycle).reduce((a, b) => a + b, 0), 3);
    assert.strictEqual(s.lifecycle.queued, 1);
    assert.strictEqual(s.lifecycle.suppressed, 1);
  });
});

// ── Unknown is never callable ───────────────────────────────────────

describe("unknown permission is never reported as callable", () => {
  it("with no eligibility engine, everything is unknown and nothing is callable", () => {
    const s = summarise({ prospects: [prospect(), prospect({ businessName: "B", suburb: "Kew" })] });
    assert.strictEqual(s.totals.callableNow, 0);
    assert.strictEqual(s.totals.blocked, 0);
    assert.strictEqual(s.totals.permissionUnknown, 2);
    assert.match(s.note, /permission is UNKNOWN/);
    assert.match(s.note, /Nothing here may be read as callable/);
  });

  it("an engine that returns nothing is unknown, not permitted", () => {
    const s = summarise({ prospects: [prospect()], evaluate: () => null });
    assert.strictEqual(s.totals.callableNow, 0);
    assert.strictEqual(s.totals.permissionUnknown, 1);
  });

  it("every row reports eligible as null when it was never established", () => {
    const s = summarise({ prospects: [prospect()] });
    assert.strictEqual(s.rows[0].eligible, null, "null means unknown; false would mean we checked");
  });

  it("says out loud that nothing has been called", () => {
    const s = summarise({ prospects: [prospect()], evaluate: eligible() });
    assert.match(s.note, /Nothing has been called/);
    assert.match(s.note, /no dialler in this build/);
  });
});

// ── Blocked, and why ────────────────────────────────────────────────

describe("blocked prospects are grouped by why", () => {
  it("uses the same categorisation the founder batch screen uses", () => {
    const s = summarise({ prospects: [prospect()], evaluate: blockedWith("suppressed_permanently", "This business must never be called.") });
    assert.strictEqual(s.blocked.permanentlySuppressed, 1);
    assert.strictEqual(s.totals.blocked, 1);
    assert.strictEqual(s.totals.callableNow, 0);
  });

  it("every category it can report is one the batch module defines", () => {
    const known = new Set(CATEGORIES.map((c) => c.key));
    const s = summarise({ prospects: [prospect()], evaluate: blockedWith("dncr_listed", "On the Register.") });
    for (const key of Object.keys(s.blocked)) assert.ok(known.has(key), `"${key}" is not a batch category`);
  });

  it("orders the breakdown by size, so the biggest problem is first", () => {
    const list = [prospect({ businessName: "A", suburb: "Kew" }), prospect({ businessName: "B", suburb: "Carlton" }), prospect({ businessName: "C", suburb: "Fitzroy" })];
    const s = summarise({
      prospects: list,
      evaluate: (p) => (p.businessName === "C" ? blockedWith("dncr_listed", "On the Register.")(p) : blockedWith("calling_policy_unapproved", "Waiting on a calling policy.")(p)),
    });
    assert.strictEqual(s.blockedBreakdown[0].count, 2);
    assert.strictEqual(s.blockedBreakdown[0].key, "policyBlocked");
    assert.ok(s.blockedBreakdown.every((b) => b.label));
  });

  it("omits categories nothing is in, rather than listing a wall of zeroes", () => {
    const s = summarise({ prospects: [prospect()], evaluate: blockedWith("dncr_listed", "On the Register.") });
    assert.strictEqual(s.blockedBreakdown.length, 1);
  });

  it("each row names what blocked it and in what words", () => {
    const s = summarise({ prospects: [prospect()], evaluate: blockedWith("suppressed_permanently", "This business must never be called.") });
    assert.strictEqual(s.rows[0].blockedBy, "suppressed_permanently");
    assert.strictEqual(s.rows[0].blockedCategory, "permanentlySuppressed");
    assert.match(s.rows[0].blockedMessage, /never be called/);
  });
});

// ── Re-evaluation ───────────────────────────────────────────────────

describe("the summary is computed now, not remembered", () => {
  it("a prospect suppressed since the last summary is no longer callable", () => {
    const p = prospect();
    let suppressed = false;
    const evaluate = (x) => (suppressed ? blockedWith("suppressed_permanently", "This business must never be called.")(x) : eligible()(x));

    assert.strictEqual(summarise({ prospects: [p], evaluate }).totals.callableNow, 1);
    suppressed = true;
    assert.strictEqual(summarise({ prospects: [p], evaluate }).totals.callableNow, 0);
  });

  it("asks the engine about the instant being summarised", () => {
    const seen = [];
    summarise({ prospects: [prospect()], evaluate: (p, c) => { seen.push(c.at); return eligible()(p); }, at: new Date("2026-08-11T23:30:00.000Z") });
    assert.strictEqual(seen[0].toISOString(), "2026-08-11T23:30:00.000Z");
  });
});

// ── Suppression and leases ──────────────────────────────────────────

describe("suppression and leases are reported without being conflated with prospects", () => {
  it("counts suppression entries separately from prospects", () => {
    const suppression = createSuppressionList({ now });
    suppression.suppress({ reason: "opt_out", fingerprint: "somebody-else#kew|vic", actor: "Peter", note: "Asked not to be contacted." });

    const s = summarise({ prospects: [prospect()], evaluate: eligible(), suppression });
    // The entry is for a business that is not in the prospect list at all —
    // which is normal, and why the field is not called "suppressed".
    assert.strictEqual(s.totals.suppressionEntries, 1);
    assert.strictEqual(s.totals.prospects, 1);
    assert.ok(!("suppressed" in s.totals), "a field called `suppressed` would get summed with the prospect counts");
  });

  it("reports null rather than zero when no suppression list was supplied", () => {
    // Zero would read as "nobody has opted out", which is a different and
    // much more dangerous claim than "we did not look".
    const s = summarise({ prospects: [prospect()], evaluate: eligible() });
    assert.strictEqual(s.totals.suppressionEntries, null);
    assert.strictEqual(s.totals.leased, null);
  });

  it("counts prospects currently held by a worker", () => {
    const queue = createCallQueue({ now, evaluate: eligible() });
    queue.selectNext({ prospects: [prospect()], limit: 1, workerId: "worker-a", evidenceFor });
    const s = summarise({ prospects: [prospect()], evaluate: eligible(), queue });
    assert.strictEqual(s.totals.leased, 1);
  });
});

// ── Outcomes ────────────────────────────────────────────────────────

describe("the outcome distribution", () => {
  it("is derived from the lifecycle, so it cannot drift from it", () => {
    const list = [
      prospect({ lifecycle: "attempted", businessName: "A", suburb: "Kew" }),
      prospect({ lifecycle: "not_interested", businessName: "B", suburb: "Carlton" }),
      prospect({ lifecycle: "customer", businessName: "C", suburb: "Fitzroy" }),
      prospect({ lifecycle: "customer", businessName: "D", suburb: "Coburg" }),
    ];
    const s = summarise({ prospects: list, evaluate: eligible() });
    assert.strictEqual(s.outcomes.attempted, 1);
    assert.strictEqual(s.outcomes.not_interested, 1);
    assert.strictEqual(s.outcomes.customer, 2);
    assert.strictEqual(s.totals.engaged, 4);

    for (const state of S.ENGAGEMENT_STATES) {
      assert.strictEqual(s.outcomes[state], s.lifecycle[state], `${state} disagrees between the two views`);
    }
  });

  it("covers every engagement state, including the ones at zero", () => {
    const s = summarise({ prospects: [prospect()], evaluate: eligible() });
    for (const state of S.ENGAGEMENT_STATES) assert.strictEqual(typeof s.outcomes[state], "number");
  });
});

// ── Rendering and robustness ────────────────────────────────────────

describe("rendering and robustness", () => {
  it("renders a founder-readable summary that repeats the caveat", () => {
    const text = describePipeline(summarise({ prospects: [prospect(), prospect({ businessName: "B", suburb: "Kew" })], evaluate: blockedWith("dncr_listed", "On the Register."), suppression: createSuppressionList({ now }) }));
    assert.match(text, /Prospects:\s+2/);
    assert.match(text, /Blocked \(2\)/);
    assert.match(text, /On the Do Not Call Register/);
    assert.match(text, /Nothing has been called/);
  });

  it("renders the unknown-permission caveat when there was no engine", () => {
    assert.match(describePipeline(summarise({ prospects: [prospect()] })), /permission is UNKNOWN/);
  });

  it("survives an empty pipeline and malformed rows", () => {
    const empty = summarise({ prospects: [], evaluate: eligible() });
    assert.strictEqual(empty.totals.prospects, 0);
    assert.ok(describePipeline(empty).length > 0);

    const messy = summarise({ prospects: [null, "x", 7, [], prospect()], evaluate: eligible() });
    assert.strictEqual(messy.totals.prospects, 1);
    assert.strictEqual(describePipeline(null), "No summary.");
  });

  it("returns a frozen summary", () => {
    const s = summarise({ prospects: [prospect()], evaluate: eligible() });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.totals));
    assert.throws(() => {
      "use strict";
      s.totals.callableNow = 99;
    });
  });

  it("reaches no network and imports nothing that is not local", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-readmodel"), "utf8");
    for (const forbidden of ["twilio", "retell", "fetch(", "axios", "require(\"http", "require('http", "https://api.", "express"]) {
      assert.ok(!src.includes(forbidden), `the read model must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });
});
