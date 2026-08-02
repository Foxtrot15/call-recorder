// LOCKSMITH ACQUISITION A2 — duplicate resolution.
//
// The harm being prevented is dialling one business twice. These tests pin the
// conservative direction: a merge happens only on conclusive evidence, similar
// names are not evidence, conflicting evidence goes to a person, and nothing is
// ever destroyed.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const dedupe = require("../src/services/acquisition-dedupe");
const { compareRecords, resolveDuplicates, duplicateStatusFor, distinctiveTokens } = dedupe;

/** Compact record builder. */
function R({ id, name, suburb = "Brunswick", state = "VIC", abn = null, phones = [], official = false, evidence = 0, discovered = "2026-07-15T02:00:00.000Z", sources = [] }) {
  return {
    prospectId: id,
    businessName: name,
    suburb,
    state,
    abn,
    numbers: phones.map((e164) => ({ e164 })),
    hasOfficialSource: official,
    evidenceCount: evidence,
    discoveredAt: discovered,
    sourceRefs: sources,
  };
}

describe("distinctive tokens", () => {
  it("strips trade, service and locality words", () => {
    assert.deepStrictEqual(distinctiveTokens("Melbourne Mobile Locksmith"), []);
    assert.deepStrictEqual(distinctiveTokens("Emergency Locksmiths Melbourne 24/7"), []);
    assert.deepStrictEqual(distinctiveTokens("Locksmith Near Me 24/7 Melbourne"), []);
  });

  it("keeps the part of a name that actually identifies a business", () => {
    assert.deepStrictEqual(distinctiveTokens("Northside Lock & Key"), ["northside"]);
    assert.deepStrictEqual(distinctiveTokens("Dandenong Lock Centre"), ["dandenong"]);
  });

  it("ignores corporate form", () => {
    assert.deepStrictEqual(distinctiveTokens("Northside Lock and Key Pty Ltd"), ["northside"]);
  });
});

describe("comparing two records", () => {
  it("same number and same name/locality is an exact duplicate", () => {
    const r = compareRecords(
      R({ id: "a", name: "Northside Lock & Key", phones: ["+61355501042"] }),
      R({ id: "b", name: "Northside Lock and Key Pty Ltd", phones: ["+61355501042"] })
    );
    assert.strictEqual(r.decision, "exact_duplicate");
    assert.strictEqual(r.strength, "conclusive");
    assert.strictEqual(r.autoConsolidationSafe, true);
    assert.ok(r.signals.includes("same_phone_number"));
    assert.ok(r.signals.includes("same_identity_fingerprint"));
  });

  it("same fingerprint with different numbers is probable, not certain", () => {
    const r = compareRecords(
      R({ id: "a", name: "Northside Lock & Key", phones: ["+61355501042"] }),
      R({ id: "b", name: "Northside Lock & Key", phones: ["+61355509999"] })
    );
    assert.strictEqual(r.decision, "probable_same_business");
    assert.strictEqual(r.autoConsolidationSafe, false, "a probable match must never merge itself");
    assert.strictEqual(r.founderReviewRequired, true);
  });

  it("same ABN in two suburbs is treated as two locations, not one record", () => {
    const r = compareRecords(
      R({ id: "a", name: "Citywide Locks", suburb: "Brunswick", abn: "51 824 753 556" }),
      R({ id: "b", name: "Citywide Locks", suburb: "Frankston", abn: "51824753556" })
    );
    assert.strictEqual(r.decision, "same_business_different_location");
    assert.strictEqual(r.autoConsolidationSafe, false);
    assert.ok(r.signals.includes("same_abn"));
  });

  it("different ABNs are different registered entities", () => {
    const r = compareRecords(
      R({ id: "a", name: "Citywide Locks", abn: "51824753556" }),
      R({ id: "b", name: "Citywide Locks", abn: "29002589460" })
    );
    assert.strictEqual(r.decision, "distinct");
    assert.strictEqual(r.strength, "conclusive");
  });

  it("different ABNs but the same number is conflicting evidence for a person", () => {
    const r = compareRecords(
      R({ id: "a", name: "Alpha Locks", abn: "51824753556", phones: ["+61355501042"] }),
      R({ id: "b", name: "Beta Locks", abn: "29002589460", phones: ["+61355501042"] })
    );
    assert.strictEqual(r.decision, "possible_duplicate_requires_review");
    assert.strictEqual(r.founderReviewRequired, true);
    assert.ok(r.reasons.some((x) => /resolved by a person/.test(x)));
  });

  it("the same number for two differently-named businesses is not a merge", () => {
    // A shared answering service is a real arrangement among small trades.
    const r = compareRecords(
      R({ id: "a", name: "Northside Lock & Key", phones: ["+61355501042"] }),
      R({ id: "b", name: "Bayside Emergency Locksmiths", suburb: "Brighton", phones: ["+61355501042"] })
    );
    assert.strictEqual(r.decision, "possible_duplicate_requires_review");
    assert.strictEqual(r.autoConsolidationSafe, false);
    assert.ok(r.reasons.some((x) => /shared answering service/.test(x)));
  });

  it("similar generic names alone are NOT evidence of a duplicate", () => {
    const r = compareRecords(
      R({ id: "a", name: "Melbourne Mobile Locksmith", suburb: "Coburg", phones: ["+61491570018"] }),
      R({ id: "b", name: "Mobile Locksmith Melbourne", suburb: "Werribee", phones: ["+61355509999"] })
    );
    assert.strictEqual(r.decision, "distinct");
    assert.ok(r.signals.includes("name_not_identifying"));
  });

  it("a distinctive name in two suburbs with nothing else shared needs a look", () => {
    const r = compareRecords(
      R({ id: "a", name: "Northside Lock & Key", suburb: "Brunswick", phones: ["+61355501042"] }),
      R({ id: "b", name: "Northside Lock & Key", suburb: "Geelong", phones: ["+61355506612"] })
    );
    assert.strictEqual(r.decision, "same_business_different_location");
    assert.strictEqual(r.founderReviewRequired, true);
  });

  it("unrelated businesses are distinct", () => {
    const r = compareRecords(
      R({ id: "a", name: "Northside Lock & Key", phones: ["+61355501042"] }),
      R({ id: "b", name: "Dandenong Lock Centre", suburb: "Dandenong", phones: ["+61355504488"] })
    );
    assert.strictEqual(r.decision, "distinct");
  });

  it("records with nothing identifying give insufficient_evidence", () => {
    const r = compareRecords(R({ id: "a", name: "Mobile Locksmith" }), R({ id: "b", name: "Emergency Locksmith" }));
    assert.strictEqual(r.decision, "insufficient_evidence");
  });

  it("never throws on rubbish input", () => {
    for (const bad of [null, undefined, 0, "", []]) {
      assert.doesNotThrow(() => compareRecords(bad, R({ id: "a", name: "X Locks" })));
      assert.strictEqual(compareRecords(bad, R({ id: "a", name: "X Locks" })).decision, "insufficient_evidence");
    }
  });

  it("is symmetric — argument order changes nothing", () => {
    const pairs = [
      [R({ id: "a", name: "Northside Lock & Key", phones: ["+61355501042"] }), R({ id: "b", name: "Northside Lock and Key Pty Ltd", phones: ["+61355501042"] })],
      [R({ id: "a", name: "Alpha Locks", abn: "51824753556", phones: ["+61355501042"] }), R({ id: "b", name: "Beta Locks", abn: "29002589460", phones: ["+61355501042"] })],
      [R({ id: "a", name: "Citywide Locks", suburb: "Brunswick", abn: "51824753556" }), R({ id: "b", name: "Citywide Locks", suburb: "Frankston", abn: "51824753556" })],
      [R({ id: "a", name: "Northside Lock & Key" }), R({ id: "b", name: "Dandenong Lock Centre", suburb: "Dandenong" })],
    ];
    for (const [x, y] of pairs) {
      const forward = compareRecords(x, y);
      const backward = compareRecords(y, x);
      assert.strictEqual(forward.decision, backward.decision, `${x.businessName} vs ${y.businessName}`);
      assert.strictEqual(forward.strength, backward.strength);
      assert.deepStrictEqual([...forward.signals], [...backward.signals]);
    }
  });

  it("explains itself with named signals rather than a score", () => {
    const r = compareRecords(
      R({ id: "a", name: "Northside Lock & Key", phones: ["+61355501042"] }),
      R({ id: "b", name: "Northside Lock and Key Pty Ltd", phones: ["+61355501042"] })
    );
    assert.ok(Array.isArray(r.signals) && r.signals.length > 0);
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
    assert.ok(dedupe.STRENGTHS.includes(r.strength), "strength is a word, not a number");
    assert.strictEqual(typeof r.strength, "string");
    assert.strictEqual(r.score, undefined, "there must be no opaque score");
    assert.strictEqual(r.confidence, undefined);
  });
});

describe("resolving a set of records", () => {
  const set = () => [
    R({ id: "pr_1", name: "Northside Lock & Key", phones: ["+61355501042"], official: true, evidence: 6 }),
    R({ id: "pr_1", name: "Northside Lock and Key Pty Ltd", phones: ["+61355501042"], evidence: 3 }),
    R({ id: "pr_2", name: "Dandenong Lock Centre", suburb: "Dandenong", phones: ["+61355504488"], evidence: 5 }),
    R({ id: "pr_3", name: "Alpha Locks", abn: "51824753556", phones: ["+61355507777"], evidence: 4 }),
    R({ id: "pr_4", name: "Beta Locks", abn: "29002589460", phones: ["+61355507777"], evidence: 4 }),
  ];

  it("merges exact duplicates and counts every redundant record", () => {
    const r = resolveDuplicates(set());
    assert.strictEqual(r.stats.records, 5);
    assert.strictEqual(r.stats.exactDuplicatesRemoved, 1);
    assert.strictEqual(r.stats.identityCollisions, 1, "the pair shares a derived prospectId");
  });

  it("does not merge a pair that needs a person", () => {
    const r = resolveDuplicates(set());
    assert.strictEqual(r.stats.pendingReview, 1);
    assert.deepStrictEqual([...r.needsReviewIds], ["pr_3", "pr_4"]);
    assert.strictEqual(r.pendingReview[0].decision, "possible_duplicate_requires_review");
  });

  it("preserves every source, number, name and timestamp when consolidating", () => {
    const r = resolveDuplicates([
      R({ id: "pr_1", name: "Northside Lock & Key", phones: ["+61355501042"], sources: [{ url: "https://a.example.com.au/" }], discovered: "2026-07-01T00:00:00.000Z", official: true }),
      R({ id: "pr_1", name: "Northside Lock and Key Pty Ltd", phones: ["+61355501042", "+61355501043"], sources: [{ url: "https://b.example.com.au/" }], discovered: "2026-07-20T00:00:00.000Z" }),
    ]);
    const cluster = r.clusters.find((c) => c.size > 1);
    assert.strictEqual(cluster.preserved.numbers.length, 2, "both numbers survive");
    assert.strictEqual(cluster.preserved.sourceRefs.length, 2, "both sources survive");
    assert.strictEqual(cluster.preserved.names.length, 2, "both names survive");
    assert.strictEqual(cluster.preserved.discoveredAt.length, 2, "both timestamps survive");
  });

  it("does not mutate the records it was given", () => {
    const records = set();
    const snapshot = JSON.parse(JSON.stringify(records));
    resolveDuplicates(records);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(records)), snapshot);
  });

  it("is deterministic regardless of input order", () => {
    const forward = resolveDuplicates(set());
    const reversed = resolveDuplicates([...set()].reverse());
    const shuffled = resolveDuplicates([set()[2], set()[0], set()[4], set()[1], set()[3]]);

    const shape = (r) => ({
      stats: r.stats,
      clusters: r.clusters.map((c) => ({ canonicalId: c.canonicalId, ids: [...c.distinctIds].sort(), size: c.size })),
      pending: [...r.needsReviewIds],
    });

    assert.deepStrictEqual(shape(reversed), shape(forward));
    assert.deepStrictEqual(shape(shuffled), shape(forward));
  });

  it("picks the canonical record by evidence quality, not by position", () => {
    const weakFirst = resolveDuplicates([
      R({ id: "pr_b", name: "X Locks", phones: ["+61355501042"], evidence: 1 }),
      R({ id: "pr_a", name: "X Locks", phones: ["+61355501042"], official: true, evidence: 9 }),
    ]);
    const strongFirst = resolveDuplicates([
      R({ id: "pr_a", name: "X Locks", phones: ["+61355501042"], official: true, evidence: 9 }),
      R({ id: "pr_b", name: "X Locks", phones: ["+61355501042"], evidence: 1 }),
    ]);
    assert.strictEqual(weakFirst.clusters[0].canonicalId, strongFirst.clusters[0].canonicalId);
  });

  it("handles an empty set without throwing", () => {
    const r = resolveDuplicates([]);
    assert.strictEqual(r.stats.records, 0);
    assert.deepStrictEqual([...r.clusters], []);
  });
});

describe("per-record duplicate status", () => {
  const resolution = () =>
    resolveDuplicates([
      R({ id: "pr_1", name: "Northside Lock & Key", phones: ["+61355501042"], official: true, evidence: 6 }),
      R({ id: "pr_3", name: "Alpha Locks", abn: "51824753556", phones: ["+61355507777"] }),
      R({ id: "pr_4", name: "Beta Locks", abn: "29002589460", phones: ["+61355507777"] }),
    ]);

  it("blocks a record whose duplicate relationship is unresolved", () => {
    const status = duplicateStatusFor("pr_3", resolution());
    assert.strictEqual(status.blocked, true);
    assert.strictEqual(status.requiresReview, true);
    assert.strictEqual(status.code, "duplicate_requires_resolution");
    assert.ok(status.relationships.length > 0);
  });

  it("clears a record with no duplicate", () => {
    const status = duplicateStatusFor("pr_1", resolution());
    assert.strictEqual(status.blocked, false);
    assert.strictEqual(status.code, "unique");
  });

  it("blocks when duplicates have not been analysed at all", () => {
    const status = duplicateStatusFor("pr_1", null);
    assert.strictEqual(status.requiresReview, false);
    assert.strictEqual(status.code, "no_duplicate_analysis");
  });
});
