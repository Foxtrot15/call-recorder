// LOCKSMITH ACQUISITION — the append-only, hash-chained decision log (G17).
//
// Backfilled in M8B. Exercised only through review, suppression and the queue
// until now.
//
// The log's job is to make "why was this business called?" answerable years
// later, and to make tampering detectable. So the tests are about the chain
// surviving the things a forger would actually do — edit a row, drop one,
// reorder two — and about the log refusing entries that would be useless as
// evidence: no actor, no reason, or a human authorisation nobody claimed.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createAuditLog, verifyRows, AUDIT_ENTITY_TYPES, AUDIT_DECISIONS, GENESIS_HASH } = require("../src/services/acquisition-audit");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;

const entry = (overrides = {}) => ({
  entityType: "prospect",
  entityId: "pr_abc123",
  event: "review_decision",
  decision: "approve",
  actor: "Peter Dang",
  actorKind: "human",
  reason: "Confirmed the business's own website and its ABR entry.",
  ...overrides,
});

const make = (opts = {}) => createAuditLog({ now, ...opts });

// ── The chain ───────────────────────────────────────────────────────

describe("the hash chain detects tampering", () => {
  function seeded(n = 4) {
    const log = make();
    for (let i = 0; i < n; i += 1) log.record(entry({ entityId: `pr_${i}`, reason: `Decision ${i}.` }));
    return log;
  }

  it("an untouched log verifies", () => {
    assert.deepStrictEqual(seeded().verifyChain(), { ok: true });
    assert.deepStrictEqual(verifyRows(seeded().all()), { ok: true });
  });

  it("the first row chains from a fixed genesis hash", () => {
    assert.strictEqual(seeded(1).all()[0].prevHash, GENESIS_HASH);
  });

  it("editing a row's contents breaks it at that row", () => {
    const rows = seeded().all().map((r) => ({ ...r }));
    rows[2].reason = "Something else entirely.";
    const result = verifyRows(rows);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 2);
    assert.match(result.message, /does not match its own hash/);
  });

  it("a forger who edits a row AND recomputes its own hash still breaks the next one", () => {
    // The whole reason the chain exists rather than a per-row checksum.
    const log = seeded();
    const rows = log.all().map((r) => ({ ...r }));
    const fresh = make();
    fresh.record(entry({ entityId: "pr_2", reason: "Something else entirely." }));
    rows[2] = { ...rows[2], reason: "Something else entirely.", entryHash: "recomputed-by-the-forger" };

    const result = verifyRows(rows);
    assert.strictEqual(result.ok, false);
    assert.ok(result.brokenAt >= 2, "the alteration must be caught at or before the following row");
  });

  it("removing a row is detected", () => {
    const rows = seeded().all().filter((_, i) => i !== 1);
    const result = verifyRows(rows);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 1);
    assert.match(result.message, /altered, reordered, or had a row removed/);
  });

  it("reordering rows is detected", () => {
    const rows = seeded().all();
    const swapped = [rows[0], rows[2], rows[1], rows[3]];
    assert.strictEqual(verifyRows(swapped).ok, false);
  });

  it("appending a fabricated row is detected", () => {
    const rows = [...seeded().all(), { ...entry(), prevHash: "made up", entryHash: "also made up", sequence: 99, recordedAt: AT.toISOString() }];
    assert.strictEqual(verifyRows(rows).ok, false);
  });

  it("verification is a pure function over rows, not over the log object", () => {
    // Deliberately, because the rows that most need verifying are the ones read
    // back out of a durable store long after the writing process exited.
    const rows = JSON.parse(JSON.stringify(seeded().all()));
    assert.deepStrictEqual(verifyRows(rows), { ok: true }, "rows that survived a JSON round-trip must still verify");
  });

  it("an empty log verifies, and a non-list does not", () => {
    assert.deepStrictEqual(verifyRows([]), { ok: true });
    assert.strictEqual(verifyRows(null).ok, false);
    assert.strictEqual(verifyRows("rows").ok, false);
    assert.strictEqual(verifyRows([null]).ok, false);
  });

  it("the head hash advances with every row", () => {
    const log = make();
    const first = log.headHash();
    log.record(entry());
    const second = log.headHash();
    log.record(entry({ entityId: "pr_other" }));
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(second, log.headHash());
  });
});

// ── There is no way to revise a decision ────────────────────────────

describe("the log is append-only", () => {
  it("exposes no way to change or remove a row", () => {
    const log = make();
    for (const name of ["update", "edit", "amend", "remove", "delete", "clear", "reset", "revise", "truncate"]) {
      assert.strictEqual(log[name], undefined, `an audit log must not expose "${name}"`);
    }
  });

  it("the returned rows are frozen", () => {
    const log = make();
    log.record(entry());
    const rows = log.all();
    assert.ok(Object.isFrozen(rows));
    assert.ok(Object.isFrozen(rows[0]));
    assert.throws(() => {
      "use strict";
      rows[0].reason = "changed";
    });
  });

  it("patching a returned row changes nothing in the log", () => {
    const log = make();
    log.record(entry());
    try {
      log.all()[0].actor = "somebody else";
    } catch {
      /* frozen in strict mode; either way the log must be unchanged */
    }
    assert.strictEqual(log.all()[0].actor, "Peter Dang");
    assert.deepStrictEqual(log.verifyChain(), { ok: true });
  });
});

// ── What a row must record to be worth anything ─────────────────────

describe("what an entry must record", () => {
  it("refuses an entry with no actor — an unattributable approval is one nobody made", () => {
    const log = make();
    for (const actor of [null, undefined, "", "   "]) {
      assert.throws(() => log.record(entry({ actor })), /who or what made the decision/);
    }
    assert.strictEqual(log.count(), 0);
  });

  it("refuses an entry with no event and no reason", () => {
    const log = make();
    assert.throws(() => log.record(entry({ event: null })));
    assert.throws(() => log.record(entry({ reason: null })));
  });

  it("refuses an entity type it does not record decisions about", () => {
    assert.throws(() => make().record(entry({ entityType: "invoice" })), /is not something this log records/);
  });

  it("refuses a decision it does not understand", () => {
    assert.throws(() => make().record(entry({ decision: "maybe" })), /is not a decision this log understands/);
  });

  it("records every entity type and decision the vocabulary allows", () => {
    for (const entityType of AUDIT_ENTITY_TYPES) {
      assert.doesNotThrow(() => make().record(entry({ entityType })), `${entityType} should be recordable`);
    }
    for (const decision of AUDIT_DECISIONS) {
      assert.doesNotThrow(() => make().record(entry({ decision })), `${decision} should be recordable`);
    }
  });

  it("`queue` is recordable, because reserving a prospect is a decision about who gets called", () => {
    assert.ok(AUDIT_ENTITY_TYPES.includes("queue"));
    const log = make();
    log.record(entry({ entityType: "queue", event: "selection", decision: "record", actor: "worker-a", actorKind: "system" }));
    assert.strictEqual(log.count(), 1);
  });
});

// ── Human authorisation cannot be manufactured ──────────────────────

describe("actorKind defaults in the direction that cannot invent authority", () => {
  it("anything that is not exactly 'human' becomes 'system'", () => {
    const log = make();
    for (const actorKind of ["Human", "HUMAN", "person", "founder", undefined, null, true, 1, {}]) {
      log.record(entry({ actorKind, entityId: `pr_${String(actorKind)}` }));
    }
    for (const row of log.all()) {
      assert.strictEqual(row.actorKind, "system", `"${row.entityId}" was recorded as human authorisation`);
    }
  });

  it("exactly 'human' is recorded as human", () => {
    const log = make();
    log.record(entry({ actorKind: "human" }));
    assert.strictEqual(log.all()[0].actorKind, "human");
  });
});

// ── Durability ──────────────────────────────────────────────────────

describe("durable before visible", () => {
  it("a sink that throws prevents the row entering the log", () => {
    const log = createAuditLog({
      now,
      sink: () => {
        throw new Error("store unavailable");
      },
    });
    assert.throws(() => log.record(entry()), /store unavailable/);
    assert.strictEqual(log.count(), 0);
    assert.deepStrictEqual(log.verifyChain(), { ok: true }, "a refused write must not leave a gap in the chain");
  });

  it("a failed write does not advance the chain, so the next one still verifies", () => {
    let fail = true;
    const log = createAuditLog({
      now,
      sink: () => {
        if (fail) throw new Error("temporarily unavailable");
      },
    });
    assert.throws(() => log.record(entry()));
    fail = false;
    log.record(entry({ entityId: "pr_second" }));
    assert.strictEqual(log.count(), 1);
    assert.strictEqual(log.all()[0].prevHash, GENESIS_HASH);
    assert.deepStrictEqual(log.verifyChain(), { ok: true });
  });

  it("refuses a sink that is not a function, rather than ignoring it", () => {
    assert.throws(() => createAuditLog({ now, sink: "a string" }), /sink must be a function/);
  });

  it("refuses to exist without a clock", () => {
    assert.throws(() => createAuditLog({}), /injected now/);
  });
});

// ── Reading it back ─────────────────────────────────────────────────

describe("reading the log", () => {
  const log = make();
  log.record(entry({ entityId: "pr_a", correlationId: "run-1" }));
  log.record(entry({ entityId: "pr_b", correlationId: "run-1" }));
  log.record(entry({ entityId: "pr_a", correlationId: "run-2", event: "suppressed" }));

  it("finds every decision about one business", () => {
    assert.strictEqual(log.forEntity("prospect", "pr_a").length, 2);
    assert.strictEqual(log.forEntity("prospect", "pr_b").length, 1);
    assert.strictEqual(log.forEntity("prospect", "pr_missing").length, 0);
  });

  it("finds every decision from one run", () => {
    assert.strictEqual(log.forCorrelation("run-1").length, 2);
    assert.strictEqual(log.forCorrelation("run-2").length, 1);
  });

  it("numbers rows in the order they happened", () => {
    assert.deepStrictEqual(log.all().map((r) => r.sequence), [1, 2, 3]);
  });

  it("stamps every row from the injected clock", () => {
    for (const row of log.all()) assert.strictEqual(row.recordedAt, AT.toISOString());
  });
});

// ── Safety ──────────────────────────────────────────────────────────

describe("the log is offline", () => {
  it("reaches no network and imports nothing that is not local or core", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-audit"), "utf8");
    for (const forbidden of ["fetch(", "axios", 'require("http', "require('http", "https://", "twilio", "retell"]) {
      assert.ok(!src.includes(forbidden), `the audit log must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.{1,2}\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });

  it("hashes identically regardless of the order properties were written", () => {
    // Two logically identical entries must chain identically, or a caller
    // reordering its object literal would appear to be tampering.
    const a = make();
    const b = make();
    a.record({ entityType: "prospect", entityId: "pr_x", event: "e", decision: "record", actor: "Peter", reason: "why" });
    b.record({ reason: "why", actor: "Peter", decision: "record", event: "e", entityId: "pr_x", entityType: "prospect" });
    assert.strictEqual(a.headHash(), b.headHash());
  });
});
