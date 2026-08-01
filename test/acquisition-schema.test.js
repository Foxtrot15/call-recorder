// LOCKSMITH ACQUISITION A1 — the shared vocabulary.
//
// Enum drift is the quiet failure in a system like this: a label map that
// forgets a value renders "undefined" to a founder mid-decision, and a
// transition table with an unreachable state hides a dead end until someone is
// stuck in it. These tests keep the vocabulary internally consistent.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const S = require("../src/services/acquisition-schema");

/** Every enum value must have a label, and every label must have a value. */
function assertLabelsMatch(values, labels, name) {
  for (const value of values) {
    assert.ok(labels[value], `${name}: "${value}" has no label`);
  }
  for (const key of Object.keys(labels)) {
    assert.ok(values.includes(key), `${name}: label "${key}" has no matching value`);
  }
}

describe("labels cover every enum value", () => {
  it("discovery origins", () => assertLabelsMatch(S.DISCOVERY_ORIGINS, S.DISCOVERY_ORIGIN_LABELS, "DISCOVERY_ORIGINS"));
  it("source types", () => assertLabelsMatch(S.SOURCE_TYPES, S.SOURCE_TYPE_LABELS, "SOURCE_TYPES"));
  it("evidence kinds", () => assertLabelsMatch(S.EVIDENCE_KINDS, S.EVIDENCE_KIND_LABELS, "EVIDENCE_KINDS"));
  it("prospect states", () => assertLabelsMatch(S.PROSPECT_STATES, S.PROSPECT_STATE_LABELS, "PROSPECT_STATES"));
  it("rejection reasons", () => assertLabelsMatch(S.REVIEW_REJECTION_REASONS, S.REVIEW_REJECTION_LABELS, "REVIEW_REJECTION_REASONS"));
  it("suppression reasons", () => assertLabelsMatch(S.SUPPRESSION_REASONS, S.SUPPRESSION_REASON_LABELS, "SUPPRESSION_REASONS"));
  it("phone kinds", () => assertLabelsMatch(S.PHONE_KINDS, S.PHONE_KIND_LABELS, "PHONE_KINDS"));
  it("DNCR results", () => assertLabelsMatch(S.DNCR_RESULTS, S.DNCR_RESULT_LABELS, "DNCR_RESULTS"));
  it("eligibility decisions", () => assertLabelsMatch(S.ELIGIBILITY_DECISIONS, S.ELIGIBILITY_DECISION_LABELS, "ELIGIBILITY_DECISIONS"));
  it("batch states", () => assertLabelsMatch(S.BATCH_STATES, S.BATCH_STATE_LABELS, "BATCH_STATES"));
});

describe("source authority", () => {
  it("ranks every source type exactly once", () => {
    assert.deepStrictEqual([...S.SOURCE_AUTHORITY_ORDER].sort(), [...S.SOURCE_TYPES].sort());
    assert.strictEqual(new Set(S.SOURCE_AUTHORITY_ORDER).size, S.SOURCE_AUTHORITY_ORDER.length);
  });

  it("puts the official sources at the top of the ranking", () => {
    const officialRanks = S.OFFICIAL_SOURCE_TYPES.map((t) => S.SOURCE_AUTHORITY_ORDER.indexOf(t));
    const otherRanks = S.SOURCE_TYPES.filter((t) => !S.OFFICIAL_SOURCE_TYPES.includes(t)).map((t) => S.SOURCE_AUTHORITY_ORDER.indexOf(t));
    assert.ok(Math.max(...officialRanks) < Math.min(...otherRanks), "an official source must outrank every unofficial one");
  });

  it("ranks unknown last", () => {
    assert.strictEqual(S.SOURCE_AUTHORITY_ORDER[S.SOURCE_AUTHORITY_ORDER.length - 1], "unknown");
  });

  it("every official source type is a real source type", () => {
    for (const t of S.OFFICIAL_SOURCE_TYPES) assert.ok(S.SOURCE_TYPES.includes(t));
  });
});

describe("the prospect transition table", () => {
  it("covers every state", () => {
    assert.deepStrictEqual(Object.keys(S.PROSPECT_TRANSITIONS).sort(), [...S.PROSPECT_STATES].sort());
  });

  it("only ever points at real states", () => {
    for (const [from, tos] of Object.entries(S.PROSPECT_TRANSITIONS)) {
      for (const to of tos) assert.ok(S.PROSPECT_STATES.includes(to), `${from} → ${to} is not a real state`);
    }
  });

  it("never allows a state to transition to itself", () => {
    for (const [from, tos] of Object.entries(S.PROSPECT_TRANSITIONS)) {
      assert.ok(!tos.includes(from), `${from} must not transition to itself`);
    }
  });

  it("every state except the start is reachable", () => {
    const reachable = new Set(["discovered"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reachable]) {
        for (const to of S.PROSPECT_TRANSITIONS[from] || []) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    for (const state of S.PROSPECT_STATES) assert.ok(reachable.has(state), `${state} is unreachable`);
  });

  it("suppression is the only terminal state a prospect can be driven into", () => {
    assert.deepStrictEqual([...S.PROSPECT_TRANSITIONS.suppressed], []);
  });
});

describe("the batch transition table", () => {
  it("covers every state and only points at real ones", () => {
    assert.deepStrictEqual(Object.keys(S.BATCH_TRANSITIONS).sort(), [...S.BATCH_STATES].sort());
    for (const [from, tos] of Object.entries(S.BATCH_TRANSITIONS)) {
      for (const to of tos) assert.ok(S.BATCH_STATES.includes(to), `${from} → ${to} is not a real batch state`);
    }
  });

  it("an approved batch can never be re-opened for edits", () => {
    // The founder approved a specific list of businesses. Re-opening it for
    // editing would mean the thing that was approved is not the thing that runs.
    assert.ok(!S.BATCH_TRANSITIONS.approved.includes("draft"));
    assert.ok(!S.BATCH_TRANSITIONS.approved.includes("awaiting_approval"));
  });

  it("rejection and expiry are final", () => {
    assert.deepStrictEqual([...S.BATCH_TRANSITIONS.rejected], []);
    assert.deepStrictEqual([...S.BATCH_TRANSITIONS.expired], []);
  });
});

describe("domain invariants encoded in the vocabulary", () => {
  it("required evidence is a subset of the evidence kinds", () => {
    for (const kind of S.REQUIRED_EVIDENCE_KINDS) assert.ok(S.EVIDENCE_KINDS.includes(kind));
  });

  it("a phone number is always required evidence", () => {
    assert.ok(S.REQUIRED_EVIDENCE_KINDS.includes("phone"));
  });

  it("business-wide suppressions are a subset of the suppression reasons", () => {
    for (const reason of S.BUSINESS_WIDE_SUPPRESSIONS) assert.ok(S.SUPPRESSION_REASONS.includes(reason));
  });

  it("an opt-out always applies to the whole business, not just one handset", () => {
    assert.ok(S.BUSINESS_WIDE_SUPPRESSIONS.includes("opt_out"));
    assert.ok(S.BUSINESS_WIDE_SUPPRESSIONS.includes("complaint"));
    assert.ok(S.BUSINESS_WIDE_SUPPRESSIONS.includes("regulator_mention"));
  });

  it("premium and short numbers are never callable", () => {
    assert.ok(!S.CALLABLE_PHONE_KINDS.includes("premium"));
    assert.ok(!S.CALLABLE_PHONE_KINDS.includes("short"));
    assert.ok(!S.CALLABLE_PHONE_KINDS.includes("invalid"));
    for (const kind of S.CALLABLE_PHONE_KINDS) assert.ok(S.PHONE_KINDS.includes(kind));
  });

  it("an unwashed number is \"unknown\", which is distinct from \"not listed\"", () => {
    assert.ok(S.DNCR_RESULTS.includes("unknown"));
    assert.notStrictEqual(S.DNCR_RESULT_LABELS.unknown, S.DNCR_RESULT_LABELS.not_listed);
    assert.match(S.DNCR_RESULT_LABELS.unknown, /Not checked/);
  });

  it("every enum is frozen so nothing can extend the vocabulary at run time", () => {
    for (const [name, value] of Object.entries(S)) {
      if (Array.isArray(value) || (value && typeof value === "object")) {
        assert.ok(Object.isFrozen(value), `${name} must be frozen`);
      }
    }
  });
});
