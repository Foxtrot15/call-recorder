// LOCKSMITH ACQUISITION A1 — the append-only evidence ledger and decision log.
//
// These two stores are the load-bearing elements of the design: if evidence can
// be edited, or a decision can happen without a record, nothing else in the
// pipeline means anything. The tests below are adversarial on purpose — they
// try to mutate, forge, backdate and bypass.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createEvidenceLedger, assessEvidence, validateEntry, stableStringify, contentHash } = require("../src/services/acquisition-evidence");
const { createAuditLog, verifyRows, GENESIS_HASH } = require("../src/services/acquisition-audit");
const S = require("../src/services/acquisition-schema");

const FIXED = new Date("2026-08-01T00:00:00.000Z");
const now = () => FIXED;

function goodEntry(overrides = {}) {
  return {
    prospectId: "pr_test",
    kind: "phone",
    captureMode: "fixture",
    value: "(03) 5550 1042",
    observedAt: "2026-07-15T02:00:00.000Z",
    capturedBy: "test",
    source: { url: "https://example.com.au/contact" },
    ...overrides,
  };
}

describe("the evidence ledger refuses to exist without an injected clock", () => {
  it("throws rather than reading the wall clock", () => {
    assert.throws(() => createEvidenceLedger({}), /injected now\(\)/);
    assert.throws(() => createEvidenceLedger({ now: "nope" }), /injected now\(\)/);
  });

  it("refuses a sink that is not a function", () => {
    assert.throws(() => createEvidenceLedger({ now, sink: "nope" }), /sink must be a function/);
  });
});

describe("what evidence may be recorded", () => {
  it("records a well-formed entry and returns a frozen row", () => {
    const ledger = createEvidenceLedger({ now });
    const row = ledger.record(goodEntry());
    assert.ok(row.evidenceId.startsWith("ev_"));
    assert.strictEqual(row.sequence, 1);
    assert.strictEqual(row.recordedAt, FIXED.toISOString());
    assert.ok(Object.isFrozen(row));
    assert.ok(Object.isFrozen(row.source));
  });

  it("a returned row cannot be edited, even through a nested object", () => {
    const ledger = createEvidenceLedger({ now });
    const row = ledger.record(goodEntry());
    assert.throws(() => {
      "use strict";
      row.value = "tampered";
    });
    assert.throws(() => {
      "use strict";
      row.source.official = true;
    });
    assert.strictEqual(ledger.forProspect("pr_test")[0].value, "(03) 5550 1042");
  });

  it("evidence must say which prospect, what kind, what value, when and who", () => {
    const ledger = createEvidenceLedger({ now });
    const cases = [
      [{ prospectId: null }, /which prospect/],
      [{ kind: "vibes" }, /not a kind of evidence/],
      [{ value: "  " }, /what was actually observed/],
      [{ observedAt: "not a date" }, /valid observation timestamp/],
      [{ capturedBy: null }, /who or what captured it/],
    ];
    for (const [override, pattern] of cases) {
      assert.throws(() => ledger.record(goodEntry(override)), pattern, JSON.stringify(override));
    }
  });

  it("evidence without provenance is refused — an assertion is not evidence", () => {
    const ledger = createEvidenceLedger({ now });
    assert.throws(() => ledger.record(goodEntry({ source: undefined })), /could not be used/);
    assert.throws(() => ledger.record(goodEntry({ source: "not a url" })), /could not be used/);
  });

  it("refuses live-fetched capture, enforcing the offline boundary at the store", () => {
    const ledger = createEvidenceLedger({ now });
    assert.throws(() => ledger.record(goodEntry({ captureMode: "live_fetch" })), /cannot capture evidence from a live website/);
  });

  it("refuses a capture mode it does not know", () => {
    const ledger = createEvidenceLedger({ now });
    assert.throws(() => ledger.record(goodEntry({ captureMode: "scraped" })), /not a way this system can capture/);
  });

  it("labels fixture evidence as not authoritative, and operator evidence as authoritative", () => {
    const ledger = createEvidenceLedger({ now });
    assert.strictEqual(ledger.record(goodEntry({ captureMode: "fixture" })).authoritative, false);
    assert.strictEqual(ledger.record(goodEntry({ captureMode: "operator_entry" })).authoritative, true);
    assert.strictEqual(ledger.record(goodEntry({ captureMode: "operator_import" })).authoritative, true);
  });

  it("records whether the source was official, so provenance cannot be re-read later", () => {
    const ledger = createEvidenceLedger({ now });
    const official = ledger.record(goodEntry({ source: { url: "https://theirsite.example.com.au/contact" } }));
    const notOfficial = ledger.record(goodEntry({ source: { url: "https://www.hotfrog.com.au/company/x" } }));
    assert.strictEqual(official.source.official, true);
    assert.strictEqual(notOfficial.source.official, false);
  });
});

describe("the ledger is append-only", () => {
  it("exposes no way to update or delete", () => {
    const ledger = createEvidenceLedger({ now });
    assert.strictEqual(typeof ledger.update, "undefined");
    assert.strictEqual(typeof ledger.delete, "undefined");
    assert.strictEqual(typeof ledger.remove, "undefined");
    assert.strictEqual(typeof ledger.clear, "undefined");
    assert.ok(Object.isFrozen(ledger));
  });

  it("a correction is a NEW row that supersedes the old one; both remain", () => {
    const ledger = createEvidenceLedger({ now });
    const first = ledger.record(goodEntry({ value: "(03) 5550 0000" }));
    const corrected = ledger.record(goodEntry({ value: "(03) 5550 1042", supersedes: first.evidenceId }));

    assert.strictEqual(ledger.forProspect("pr_test").length, 2, "both rows survive");
    const current = ledger.currentForProspect("pr_test");
    assert.strictEqual(current.length, 1);
    assert.strictEqual(current[0].evidenceId, corrected.evidenceId);
  });

  it("refuses a correction that points at evidence which does not exist", () => {
    const ledger = createEvidenceLedger({ now });
    assert.throws(() => ledger.record(goodEntry({ supersedes: "ev_nonexistent" })), /no such evidence exists/);
  });

  it("the array returned by all() cannot be used to mutate the ledger", () => {
    const ledger = createEvidenceLedger({ now });
    ledger.record(goodEntry());
    const rows = ledger.all();
    assert.throws(() => {
      "use strict";
      rows.push({});
    });
    assert.strictEqual(ledger.count(), 1);
  });
});

describe("a failing sink fails the write", () => {
  it("does not keep a row the durable store rejected", () => {
    const ledger = createEvidenceLedger({
      now,
      sink: () => {
        throw new Error("database unavailable");
      },
    });
    assert.throws(() => ledger.record(goodEntry()), /database unavailable/);
    assert.strictEqual(ledger.count(), 0, "no evidence may be believed that was never stored");
  });

  it("passes the frozen row to the sink", () => {
    const seen = [];
    const ledger = createEvidenceLedger({ now, sink: (row) => seen.push(row) });
    ledger.record(goodEntry());
    assert.strictEqual(seen.length, 1);
    assert.ok(Object.isFrozen(seen[0]));
  });
});

describe("content hashing is stable", () => {
  it("does not depend on property insertion order", () => {
    assert.strictEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
    assert.strictEqual(contentHash({ a: 1, b: [1, { c: 2, d: 3 }] }), contentHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it("changes when the content changes", () => {
    assert.notStrictEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
  });

  it("refuses a cycle with a named error rather than a stack overflow", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    try {
      stableStringify(cyclic);
      assert.fail("should have thrown");
    } catch (err) {
      assert.strictEqual(err.code, "value_cyclic");
      assert.ok(!(err instanceof RangeError), "must be a domain error, not a stack overflow");
    }
  });

  it("refuses a pathologically deep structure", () => {
    let deep = {};
    const root = deep;
    for (let i = 0; i < 60; i += 1) {
      deep.next = {};
      deep = deep.next;
    }
    try {
      stableStringify(root);
      assert.fail("should have thrown");
    } catch (err) {
      assert.strictEqual(err.code, "value_too_deep");
    }
  });

  it("allows the same object appearing twice as siblings — that is not a cycle", () => {
    const shared = { url: "https://example.com.au/" };
    assert.doesNotThrow(() => stableStringify({ a: shared, b: shared }));
  });

  it("a cyclic audit detail fails the write cleanly instead of crashing", () => {
    const log = createAuditLog({ now });
    const detail = { note: "x" };
    detail.self = detail;
    try {
      log.record(goodAudit({ detail }));
      assert.fail("should have thrown");
    } catch (err) {
      assert.strictEqual(err.code, "value_cyclic");
    }
    assert.strictEqual(log.count(), 0, "a decision that could not be hashed must not be stored");
  });
});

describe("assessing what evidence a prospect holds", () => {
  it("reports the required kinds that are missing", () => {
    const ledger = createEvidenceLedger({ now });
    ledger.record(goodEntry({ kind: "business_name", value: "X Locks" }));
    const assessment = assessEvidence(ledger.forProspect("pr_test"));
    assert.strictEqual(assessment.hasAllRequired, false);
    assert.deepStrictEqual([...assessment.missingRequired].sort(), ["phone", "trade_category"]);
  });

  it("distinguishes a phone from the business's own site from one off an aggregator", () => {
    const official = createEvidenceLedger({ now });
    official.record(goodEntry({ kind: "phone", source: { url: "https://theirsite.example.com.au/contact" } }));
    assert.strictEqual(assessEvidence(official.forProspect("pr_test")).phoneFromOfficialSource, true);

    const aggregated = createEvidenceLedger({ now });
    aggregated.record(goodEntry({ kind: "phone", source: { url: "https://www.hotfrog.com.au/company/x" } }));
    assert.strictEqual(assessEvidence(aggregated.forProspect("pr_test")).phoneFromOfficialSource, false);
  });

  it("says plainly that nothing was human-verified when it was all fixture data", () => {
    const ledger = createEvidenceLedger({ now });
    ledger.record(goodEntry({ captureMode: "fixture" }));
    assert.strictEqual(assessEvidence(ledger.forProspect("pr_test")).humanVerified, false);
  });

  it("handles an empty evidence set without throwing", () => {
    const assessment = assessEvidence([]);
    assert.strictEqual(assessment.total, 0);
    assert.strictEqual(assessment.hasAllRequired, false);
    assert.deepStrictEqual([...assessment.missingRequired], [...S.REQUIRED_EVIDENCE_KINDS]);
  });
});

// ── The decision log ────────────────────────────────────────────────

function goodAudit(overrides = {}) {
  return {
    entityType: "prospect",
    entityId: "pr_test",
    event: "review_approved",
    decision: "approve",
    actor: "Peter",
    actorKind: "human",
    reason: "Checked the site and the register.",
    ...overrides,
  };
}

describe("the decision log", () => {
  it("requires an injected clock", () => {
    assert.throws(() => createAuditLog({}), /injected now\(\)/);
  });

  it("requires who, why, what and which — every time", () => {
    const log = createAuditLog({ now });
    assert.throws(() => log.record(goodAudit({ actor: null })), /who or what made the decision/);
    assert.throws(() => log.record(goodAudit({ reason: "  " })), /must record why/);
    assert.throws(() => log.record(goodAudit({ entityId: null })), /which thing it is about/);
    assert.throws(() => log.record(goodAudit({ event: null })), /must name the event/);
    assert.throws(() => log.record(goodAudit({ decision: "maybe" })), /not a decision this log understands/);
    assert.throws(() => log.record(goodAudit({ entityType: "invoice" })), /not something this log records/);
  });

  it("records whether a human or the system decided", () => {
    const log = createAuditLog({ now });
    assert.strictEqual(log.record(goodAudit({ actorKind: "human" })).actorKind, "human");
    assert.strictEqual(log.record(goodAudit({ actorKind: undefined })).actorKind, "system");
    // Anything that is not exactly "human" is treated as the system — the
    // defaulting direction that cannot manufacture human authorisation.
    assert.strictEqual(log.record(goodAudit({ actorKind: "person" })).actorKind, "system");
  });

  it("exposes no way to update or delete", () => {
    const log = createAuditLog({ now });
    assert.strictEqual(typeof log.update, "undefined");
    assert.strictEqual(typeof log.delete, "undefined");
    assert.ok(Object.isFrozen(log));
  });

  it("chains rows so the log cannot be silently altered", () => {
    const log = createAuditLog({ now });
    const a = log.record(goodAudit({ event: "one" }));
    const b = log.record(goodAudit({ event: "two" }));
    assert.strictEqual(a.prevHash, GENESIS_HASH);
    assert.strictEqual(b.prevHash, a.entryHash);
    assert.deepStrictEqual(log.verifyChain(), { ok: true });
  });

  // verifyRows is the pure verifier the durable store would use on rows read
  // back out of a database — which is the only place tampering can actually
  // happen. These tests feed it exactly the corrupted shapes a bad store or a
  // bad actor would produce.
  it("verifyRows detects a row whose contents were altered", () => {
    const log = createAuditLog({ now });
    log.record(goodAudit({ event: "one" }));
    log.record(goodAudit({ event: "two" }));
    log.record(goodAudit({ event: "three" }));

    const tampered = log.all().map((r, i) => (i === 1 ? { ...r, reason: "something else entirely" } : r));
    const verdict = verifyRows(tampered);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.brokenAt, 1);
    assert.match(verdict.message, /contents have been altered/);
  });

  it("verifyRows detects a removed row", () => {
    const log = createAuditLog({ now });
    log.record(goodAudit({ event: "one" }));
    log.record(goodAudit({ event: "two" }));
    log.record(goodAudit({ event: "three" }));

    const withHole = log.all().filter((_, i) => i !== 1);
    const verdict = verifyRows(withHole);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.brokenAt, 1);
    assert.match(verdict.message, /altered, reordered, or had a row removed/);
  });

  it("verifyRows detects reordering", () => {
    const log = createAuditLog({ now });
    log.record(goodAudit({ event: "one" }));
    log.record(goodAudit({ event: "two" }));
    const swapped = [log.all()[1], log.all()[0]];
    assert.strictEqual(verifyRows(swapped).ok, false);
  });

  it("verifyRows accepts an untouched chain, and an empty one", () => {
    const log = createAuditLog({ now });
    assert.deepStrictEqual(verifyRows(log.all()), { ok: true });
    log.record(goodAudit());
    assert.deepStrictEqual(verifyRows(log.all()), { ok: true });
  });

  it("a forger who recomputes one row's hash still breaks the following row", () => {
    const crypto = require("node:crypto");
    const { stableStringify: stringify } = require("../src/services/acquisition-evidence");
    const log = createAuditLog({ now });
    log.record(goodAudit({ event: "one" }));
    log.record(goodAudit({ event: "two" }));

    // Edit row 0 AND fix its own hash — the diligent forgery.
    const rows = log.all();
    const { entryHash, auditId, ...body } = rows[0];
    const forgedBody = { ...body, reason: "a reason nobody gave" };
    const forgedHash = crypto.createHash("sha256").update(stringify(forgedBody)).digest("hex");
    const forged = [{ ...forgedBody, entryHash: forgedHash, auditId }, rows[1]];

    // Row 0 now verifies against itself, but row 1 still points at the old hash.
    const verdict = verifyRows(forged);
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.brokenAt, 1, "the break surfaces at the next row in the chain");
  });

  it("a failing sink fails the write, so no decision is believed that was not stored", () => {
    const log = createAuditLog({
      now,
      sink: () => {
        throw new Error("audit store down");
      },
    });
    assert.throws(() => log.record(goodAudit()), /audit store down/);
    assert.strictEqual(log.count(), 0);
  });

  it("can be read back by entity and by correlation id", () => {
    const log = createAuditLog({ now });
    log.record(goodAudit({ entityId: "pr_a", correlationId: "batch_1" }));
    log.record(goodAudit({ entityId: "pr_b", correlationId: "batch_1" }));
    log.record(goodAudit({ entityId: "pr_a", correlationId: "batch_2" }));
    assert.strictEqual(log.forEntity("prospect", "pr_a").length, 2);
    assert.strictEqual(log.forCorrelation("batch_1").length, 2);
  });
});
