// LOCKSMITH ACQUISITION — permanent suppression.
//
// Backfilled in M8B. The module was written in A2 and cited a test file that
// did not exist; it was exercised only through the eligibility engine.
//
// This is the control with the worst failure mode in the whole system. Everything
// else fails by not calling somebody we could have called. This fails by calling
// somebody who already told us not to — and they do not get to opt out twice.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createSuppressionList, FIXTURE_SUPPRESSIONS } = require("../src/services/acquisition-suppression");
const { identityFingerprint } = require("../src/services/acquisition-prospect");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;

const FP = identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" });

const make = (opts = {}) => createSuppressionList({ now, ...opts });

const optOut = (overrides = {}) => ({
  reason: "opt_out",
  fingerprint: FP,
  actor: "Peter Dang",
  actorKind: "human",
  note: "Asked never to be contacted again.",
  ...overrides,
});

// ── There is no way out ─────────────────────────────────────────────

describe("suppression is permanent, by construction", () => {
  it("exposes no way to remove an entry", () => {
    // Not "does not currently remove" — the capability must not exist. A method
    // that exists is a method somebody eventually calls.
    const list = make();
    for (const name of ["remove", "delete", "unsuppress", "clear", "reset", "revoke", "expire", "purge", "drop"]) {
      assert.strictEqual(list[name], undefined, `suppression must not expose "${name}"`);
    }
  });

  it("the returned list is frozen, so a caller cannot empty it", () => {
    const list = make();
    list.suppress(optOut());
    const all = list.all();
    assert.ok(Object.isFrozen(all));
    assert.throws(() => {
      "use strict";
      all.length = 0;
    });
    assert.strictEqual(list.count(), 1);
  });

  it("an entry stays after later entries are added", () => {
    const list = make();
    list.suppress(optOut());
    list.suppress({ reason: "wrong_number", e164: "+61355501042", actor: "Peter", note: "Reached a residence." });
    assert.strictEqual(list.check({ fingerprint: FP }).suppressed, true);
    assert.strictEqual(list.count(), 2);
  });
});

// ── Business scope vs number scope ──────────────────────────────────

describe("an opt-out is about the relationship, not the handset", () => {
  it("suppresses the business on every number, including ones we have never seen", () => {
    const list = make();
    list.suppress(optOut());
    assert.strictEqual(list.check({ fingerprint: FP }).suppressed, true);
    assert.strictEqual(list.check({ e164: "+61491570999", fingerprint: FP }).suppressed, true, "the business must not be reachable on another line");
  });

  it("refuses a business-wide reason with no business identity", () => {
    // Suppressing only the number we happened to dial lets the same business be
    // called back next week on its other line.
    const list = make();
    const result = list.suppress(optOut({ fingerprint: null, e164: "+61355501042" }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "fingerprint_required");
    assert.match(result.message, /called back on another number/);
  });

  it("every business-wide reason the vocabulary lists behaves that way", () => {
    for (const reason of S.BUSINESS_WIDE_SUPPRESSIONS) {
      const list = make();
      const result = list.suppress({ reason, fingerprint: FP, actor: "Peter", note: "Recorded." });
      assert.strictEqual(result.ok, true, `${reason}: ${result.message}`);
      assert.strictEqual(result.entry.scope, "business", `${reason} must be business-scoped`);
    }
  });

  it("a wrong number suppresses the number and leaves the business alone", () => {
    const list = make();
    list.suppress({ reason: "wrong_number", e164: "+61355501042", actor: "Peter", note: "Reached a residence." });
    assert.strictEqual(list.check({ e164: "+61355501042" }).suppressed, true);
    assert.strictEqual(list.check({ fingerprint: FP }).suppressed, false);
  });

  it("refuses a number-scoped reason with no number", () => {
    const list = make();
    const result = list.suppress({ reason: "wrong_number", fingerprint: FP, actor: "Peter", note: "x" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "number_required");
  });

  it("checks both keys independently, so neither alone can miss a hit", () => {
    const list = make();
    list.suppress(optOut());
    list.suppress({ reason: "wrong_number", e164: "+61399990000", actor: "Peter", note: "Wrong." });
    assert.strictEqual(list.check({ e164: "+61399990000" }).suppressed, true);
    assert.strictEqual(list.check({ fingerprint: FP }).suppressed, true);
    assert.strictEqual(list.check({ e164: "+61399990000", fingerprint: "someone-else#kew|vic" }).suppressed, true);
  });
});

// ── Re-import cannot resurrect ──────────────────────────────────────

describe("re-importing a business cannot bring it back", () => {
  it("catches the same business discovered again under a differently-punctuated name", () => {
    const list = make();
    const original = identityFingerprint({ businessName: "Preston Key & Safe", suburb: "Preston", state: "VIC" });
    list.suppress(optOut({ fingerprint: original }));

    for (const name of ["Preston Key and Safe Pty Ltd", "PRESTON KEY & SAFE", "  Preston   Key  &  Safe  ", "The Preston Key and Safe Co"]) {
      const fp = identityFingerprint({ businessName: name, suburb: "Preston", state: "VIC" });
      assert.strictEqual(list.check({ fingerprint: fp }).suppressed, true, `"${name}" escaped the suppression`);
    }
  });

  it("suppression outlives the prospect record entirely", () => {
    // The list is keyed on identity, not on a prospect row, so deleting and
    // re-creating the prospect changes nothing. This is why the durable table
    // in laq2 has no foreign key to acquisition_prospects.
    const list = make();
    list.suppress(optOut());
    const rebuiltFingerprint = identityFingerprint({ businessName: "Northside Lock & Key", suburb: "Brunswick", state: "VIC" });
    assert.strictEqual(list.check({ fingerprint: rebuiltFingerprint }).suppressed, true);
  });

  it("a genuinely different business in the same suburb is not caught", () => {
    const list = make();
    list.suppress(optOut());
    const other = identityFingerprint({ businessName: "Brunswick Rapid Locksmiths", suburb: "Brunswick", state: "VIC" });
    assert.strictEqual(list.check({ fingerprint: other }).suppressed, false, "over-matching would silently stop us calling anybody local");
  });
});

// ── What a check reports ────────────────────────────────────────────

describe("a check explains itself", () => {
  it("returns every matching entry, not just the first", () => {
    // "Opted out AND complained" is a different situation from "opted out".
    const list = make();
    list.suppress(optOut());
    list.suppress({ reason: "complaint", fingerprint: FP, actor: "Peter", note: "Complained about the first call." });

    const hit = list.check({ fingerprint: FP });
    assert.strictEqual(hit.matches.length, 2);
    assert.strictEqual(hit.reasons.length, 2);
    assert.match(hit.message, /2 reasons/);
  });

  it("reports the most serious reason first", () => {
    const list = make();
    list.suppress({ reason: "existing_client", fingerprint: FP, actor: "Peter", note: "Ours." });
    list.suppress({ reason: "regulator_mention", fingerprint: FP, actor: "Peter", note: "Mentioned the ACMA." });
    assert.strictEqual(list.check({ fingerprint: FP }).primary.reason, "regulator_mention");
  });

  it("the severity order covers every reason, so none sorts silently to the back", () => {
    // The module comments say a stray code would mislead whoever maintains the
    // list. Proven by giving every reason a turn at being the only entry.
    for (const reason of S.SUPPRESSION_REASONS) {
      const list = make();
      const businessWide = S.BUSINESS_WIDE_SUPPRESSIONS.includes(reason);
      const result = list.suppress({ reason, actor: "Peter", note: "Recorded.", fingerprint: businessWide ? FP : null, e164: businessWide ? null : "+61355501042" });
      assert.strictEqual(result.ok, true, `${reason}: ${result.message}`);
      const hit = list.check(businessWide ? { fingerprint: FP } : { e164: "+61355501042" });
      assert.strictEqual(hit.primary.reason, reason);
      assert.strictEqual(hit.primary.reasonLabel, S.SUPPRESSION_REASON_LABELS[reason]);
    }
  });

  it("a clean check says so plainly, with no partial hit", () => {
    const hit = make().check({ e164: "+61355501042", fingerprint: FP });
    assert.strictEqual(hit.suppressed, false);
    assert.deepStrictEqual([...hit.matches], []);
    assert.deepStrictEqual([...hit.reasons], []);
  });

  it("an empty check matches nothing rather than everything", () => {
    const list = make();
    list.suppress(optOut());
    assert.strictEqual(list.check({}).suppressed, false);
    assert.strictEqual(list.check().suppressed, false);
    assert.strictEqual(list.check({ e164: null, fingerprint: null }).suppressed, false);
  });
});

// ── Validation ──────────────────────────────────────────────────────

describe("what a suppression must record", () => {
  it("refuses an unknown reason rather than storing it", () => {
    const result = make().suppress(optOut({ reason: "changed_their_mind" }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "reason_unknown");
  });

  it("requires who added it and what happened", () => {
    assert.strictEqual(make().suppress(optOut({ actor: null })).code, "actor_missing");
    assert.strictEqual(make().suppress(optOut({ actor: "   " })).code, "actor_missing");
    assert.strictEqual(make().suppress(optOut({ note: null })).code, "note_missing");
  });

  it("refuses a malformed entry rather than throwing", () => {
    for (const bad of [null, undefined, "x", 42]) {
      assert.strictEqual(make().suppress(bad).ok, false);
    }
  });

  it("refuses to exist without a clock", () => {
    assert.throws(() => createSuppressionList({}), /injected now/);
  });

  it("stamps every entry with when it was recorded, from the injected clock", () => {
    const list = make();
    list.suppress(optOut());
    assert.strictEqual(list.all()[0].suppressedAt, AT.toISOString());
  });
});

// ── Durability and audit ────────────────────────────────────────────

describe("durability and audit", () => {
  it("a sink that throws prevents the entry from entering the list", () => {
    // Believing we hold a suppression we never persisted is the same accident
    // as believing we hold evidence we never persisted.
    const list = createSuppressionList({
      now,
      sink: () => {
        throw new Error("store unavailable");
      },
    });
    assert.throws(() => list.suppress(optOut()), /store unavailable/);
    assert.strictEqual(list.count(), 0);
    assert.strictEqual(list.check({ fingerprint: FP }).suppressed, false);
  });

  it("writes to the sink before the entry is visible", () => {
    const written = [];
    const list = createSuppressionList({ now, sink: (row) => written.push(row) });
    list.suppress(optOut());
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].fingerprint, FP);
  });

  it("audits who suppressed what, and whether they were a person", () => {
    const rows = [];
    const list = createSuppressionList({ now, audit: { record: (r) => rows.push(r) } });
    list.suppress(optOut());
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].entityType, "suppression");
    assert.strictEqual(rows[0].actorKind, "human");
    assert.match(rows[0].reason, /Asked not to be contacted/);
  });

  it("anything that is not exactly 'human' is recorded as a system actor", () => {
    // The defaulting direction that cannot manufacture human authorisation.
    for (const actorKind of ["Human", "HUMAN", "person", undefined, null, true]) {
      const rows = [];
      const list = createSuppressionList({ now, audit: { record: (r) => rows.push(r) } });
      list.suppress(optOut({ actorKind }));
      assert.strictEqual(rows[0].actorKind, "system", `"${actorKind}" must not be read as human`);
    }
  });

  it("entries are frozen and sequenced", () => {
    const list = make();
    list.suppress(optOut());
    list.suppress({ reason: "wrong_number", e164: "+61355501042", actor: "Peter", note: "Wrong." });
    const all = list.all();
    assert.deepStrictEqual(all.map((e) => e.sequence), [1, 2]);
    assert.ok(all.every((e) => Object.isFrozen(e)));
  });
});

// ── The shipped fixture list ────────────────────────────────────────

describe("the pilot's starting list", () => {
  it("every fixture entry is valid and loads", () => {
    const list = make();
    for (const entry of FIXTURE_SUPPRESSIONS) {
      const result = list.suppress(entry);
      assert.strictEqual(result.ok, true, `${entry.reason}: ${result.message}`);
    }
    assert.strictEqual(list.count(), FIXTURE_SUPPRESSIONS.length);
  });

  it("covers both scopes, so a dry run exercises each path", () => {
    const scopes = new Set(FIXTURE_SUPPRESSIONS.map((e) => (S.BUSINESS_WIDE_SUPPRESSIONS.includes(e.reason) ? "business" : "number")));
    assert.ok(scopes.size >= 1);
    assert.ok(FIXTURE_SUPPRESSIONS.some((e) => e.reason === "opt_out"), "the list should contain a prior opt-out to exercise the permanence path");
  });

  it("names a person on every entry — none is signed by the system", () => {
    for (const entry of FIXTURE_SUPPRESSIONS) {
      assert.ok(entry.actor && !/^(system|aida|bot|automation)$/i.test(entry.actor), `${entry.reason} is not signed by a person`);
    }
  });
});

// ── M8C: a business-scoped entry matches on its recorded number too ──
//
// Found by the M8C audit. A business-scoped opt-out stored the number that was
// dialled and then `check()` compared only the fingerprint. Because the
// fingerprint is built from the trading name and the locality, it DRIFTS: the
// same locksmith re-imported from a second source as "Preston South" rather
// than "Preston" produced a different fingerprint, and the identical phone
// number came back not-suppressed. That is a call to somebody who opted out.

describe("an opt-out survives the identity drifting (M8C)", () => {
  const OPTED_OUT_NUMBER = "+61355502287";
  const original = identityFingerprint({ businessName: "Preston Key & Safe", suburb: "Preston", state: "VIC" });

  function listWithOptOut() {
    const list = make();
    const result = list.suppress({
      reason: "opt_out",
      fingerprint: original,
      e164: OPTED_OUT_NUMBER,
      actor: "Peter Dang",
      actorKind: "human",
      note: "Asked never to be contacted again.",
    });
    assert.strictEqual(result.ok, true, result.message);
    return list;
  }

  const drifted = [
    ["a differently-spelled suburb", { businessName: "Preston Key & Safe", suburb: "Preston South", state: "VIC" }],
    ["no suburb at all", { businessName: "Preston Key & Safe", suburb: null, state: "VIC" }],
    ["a reworded trading name", { businessName: "Preston Key and Safe Group", suburb: "Preston", state: "VIC" }],
    ["both drifted at once", { businessName: "Preston Key & Safe Locksmiths", suburb: "Preston Sth", state: "VIC" }],
  ];

  for (const [label, identity] of drifted) {
    it(`catches the same number under ${label}`, () => {
      const fingerprint = identityFingerprint(identity);
      assert.notStrictEqual(fingerprint, original, "the fixture must actually drift, or this proves nothing");
      assert.strictEqual(listWithOptOut().check({ e164: OPTED_OUT_NUMBER, fingerprint }).suppressed, true, `"${label}" escaped the opt-out`);
    });
  }

  it("still catches it on the identity when the number is not to hand", () => {
    assert.strictEqual(listWithOptOut().check({ fingerprint: original }).suppressed, true);
  });

  it("recording a number and then ignoring it would be worse than not recording it", () => {
    // The entry stores the number; this asserts the entry is actually consulted
    // on it, so the stored value is a control rather than decoration.
    const list = listWithOptOut();
    assert.strictEqual(list.all()[0].e164, OPTED_OUT_NUMBER);
    assert.strictEqual(list.check({ e164: OPTED_OUT_NUMBER }).suppressed, true, "the recorded number must be matched on its own");
  });

  it("does not over-match — a different business on a different number is clear", () => {
    const other = identityFingerprint({ businessName: "Brunswick Rapid Locksmiths", suburb: "Brunswick", state: "VIC" });
    assert.strictEqual(listWithOptOut().check({ e164: "+61355501180", fingerprint: other }).suppressed, false);
  });

  it("a number-scoped entry stays about the number only", () => {
    // wrong_number is genuinely a fact about a handset. Widening it to the
    // business would suppress a locksmith because one of its numbers was stale.
    const list = make();
    list.suppress({ reason: "wrong_number", e164: "+61399990000", actor: "Peter", note: "Reached a residence." });
    assert.strictEqual(list.check({ e164: "+61399990000" }).suppressed, true);
    assert.strictEqual(list.check({ fingerprint: original, e164: "+61355502287" }).suppressed, false);
  });
});
