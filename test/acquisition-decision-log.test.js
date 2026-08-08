// LOCKSMITH ACQUISITION M8I — serialising the decision chain, and the ratchets.
//
// Two halves.
//
// First: the behaviour. Two writers that both hydrated the same head, and what
// has to happen to the loser. These run against the in-memory store, which
// enforces the SAME uniqueness rule Postgres does — if it did not, every test
// here would pass against a store that permits the fork the real one refuses,
// and the suite would be proving nothing about the code that ships.
//
// Second: the ratchets. Assertions whose only job is to fail if somebody later
// removes the protection — the SQL invariant, the authoritative head read, the
// conflict discrimination, the retry bound. Each says in its message what was
// lost, because a ratchet that fires without explaining itself gets deleted.
//
// Nothing here touches a database, a network or a provider.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { createInMemoryAcquisitionStore, STORE_METHODS } = require("../src/services/acquisition-store");
const { createAuditLog, verifyRows, GENESIS_HASH } = require("../src/services/acquisition-audit");
const { appendDecisionSerialised, hydrateLog, readChainState, ChainContentionError, MAX_APPEND_ATTEMPTS } = require("../src/services/acquisition-decision-log");

const now = () => new Date("2026-08-08T09:00:00.000Z");
// A clock that moves, for the cases where two rows must not be byte-identical.
const ticking = (start = Date.UTC(2026, 7, 8, 9, 0, 0)) => {
  let t = start;
  return () => new Date((t += 1000));
};

const entry = (overrides = {}) => ({
  entityType: "prospect",
  entityId: "p1",
  event: "review_opened",
  decision: "defer",
  actor: "test",
  reason: "because the test needs a reason and the log insists on one",
  ...overrides,
});

// ---------------------------------------------------------------------------

describe("reading the chain head", () => {
  it("an empty chain has no head, and hydrates from genesis", async () => {
    const store = createInMemoryAcquisitionStore();
    assert.equal(await store.readChainHead(), null);

    const state = await readChainState({ store });
    assert.deepEqual(state, { head: null, sequence: 0, entryHash: null });

    const { log } = await hydrateLog({ store, now });
    const row = log.record(entry());
    assert.equal(row.prevHash, GENESIS_HASH);
    assert.equal(row.sequence, 1);
  });

  it("the head is the highest sequence, not the last row inserted", async () => {
    // A store can hand rows back in any order — PostgREST makes no promise
    // without an ORDER BY, and a seeded store has whatever order it was given.
    const store = createInMemoryAcquisitionStore();
    const log = createAuditLog({ now: ticking() });
    const rows = [log.record(entry()), log.record(entry({ event: "b" })), log.record(entry({ event: "c" }))];
    for (const r of [rows[1], rows[2], rows[0]]) await store.appendDecision(r);

    const head = await store.readChainHead();
    assert.equal(head.sequence, 3);
    assert.equal(head.entryHash, rows[2].entryHash);
  });

  it("a chain longer than the listDecisions page still reports the true head", async () => {
    // THE DEFECT THIS MILESTONE FIXES, stated as a test.
    //
    // M8H took the head from the last element of listDecisions(), whose default
    // limit is 1000. At 1000 rows that is still right by luck; at 1001 the
    // "head" is row 1000, every append after it is minted against a dead head,
    // and with laq3 applied the first one is refused as a fork attempt. Without
    // laq3 it would simply have forked.
    const store = createInMemoryAcquisitionStore();
    const log = createAuditLog({ now: ticking() });
    const written = [];
    for (let i = 0; i < 1200; i += 1) {
      const row = log.record(entry({ entityId: `p${i}`, event: `e${i}` }));
      written.push(row);
      await store.appendDecision(row);
    }

    const page = await store.listDecisions({});
    assert.equal(page.length, 1000, "the page is capped — that is the premise, not a bug");
    assert.equal(page[page.length - 1].sequence, 1000);

    const head = await store.readChainHead();
    assert.equal(head.sequence, 1200);
    assert.equal(head.entryHash, written[1199].entryHash);

    // And an append past the cap continues the chain rather than forking it.
    const appended = await appendDecisionSerialised({ store, now: ticking(), mint: ({ log: l }) => l.record(entry({ event: "past_the_cap" })) });
    assert.equal(appended.appended, true);
    assert.equal(appended.decision.sequence, 1201);
    assert.equal(appended.decision.prevHash, written[1199].entryHash);
  });

  it("refuses a head whose sequence could not have been written", async () => {
    const store = createInMemoryAcquisitionStore();
    store.readChainHead = async () => ({ entryHash: "a".repeat(64), sequence: 0 });
    await assert.rejects(() => readChainState({ store }), /unusable sequence/);
  });
});

// ---------------------------------------------------------------------------

describe("two writers, one head", () => {
  it("the loser is told it lost — not told it succeeded", async () => {
    const store = createInMemoryAcquisitionStore();

    // Both hydrate the SAME head, which is what concurrency means here.
    const a = await hydrateLog({ store, now: ticking() });
    const b = await hydrateLog({ store, now: ticking(Date.UTC(2026, 7, 8, 10, 0, 0)) });
    const rowA = a.log.record(entry({ event: "written_by_a" }));
    const rowB = b.log.record(entry({ event: "written_by_b" }));
    assert.equal(rowA.prevHash, rowB.prevHash, "the premise: both claim the same predecessor");

    const first = await store.appendDecision(rowA);
    assert.equal(first.created, true);

    const second = await store.appendDecision(rowB);
    assert.equal(second.created, false);
    assert.equal(second.conflict, "head_taken");
    assert.equal(second.decision, null, "there is no row to hand back — nothing was written");

    // And the log is one chain, not two.
    assert.equal((await store.listDecisions({})).length, 1);
    assert.equal(verifyRows(await store.listDecisions({})).ok, true);
  });

  it("a genuine replay of the same row is idempotent, not a conflict", async () => {
    const store = createInMemoryAcquisitionStore();
    const { log } = await hydrateLog({ store, now });
    const row = log.record(entry());

    const first = await store.appendDecision(row);
    const again = await store.appendDecision(row);

    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.reason, "duplicate_entry");
    assert.equal(again.conflict, undefined, "a replay is not a lost race and must not be reported as one");
    assert.equal(again.decision.auditId, row.auditId);
  });

  it("the loser re-mints against the new head and the chain stays single", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();

    // B starts from head H. A slips in and takes H before B's insert lands.
    const stolen = [];
    const outcome = await appendDecisionSerialised({
      store,
      now: clock,
      mint: async ({ log, attempt }) => {
        if (attempt === 1) {
          // The interleaving, made deterministic: A wins the head B is about to
          // claim, in the window between B hydrating and B inserting.
          const a = await hydrateLog({ store, now: clock });
          const rowA = a.log.record(entry({ event: "a_got_there_first" }));
          await store.appendDecision(rowA);
          stolen.push(rowA);
        }
        return log.record(entry({ event: "b_eventually" }));
      },
    });

    assert.equal(outcome.appended, true);
    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.conflicts, 1);
    assert.equal(outcome.decision.prevHash, stolen[0].entryHash, "B followed A rather than replacing it");

    const rows = await store.listDecisions({});
    assert.equal(rows.length, 2);
    assert.equal(verifyRows(rows).ok, true);
  });

  it("nothing is deleted or rewritten to resolve the race", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    const before = [];

    await appendDecisionSerialised({
      store,
      now: clock,
      mint: async ({ log, attempt }) => {
        if (attempt === 1) {
          const a = await hydrateLog({ store, now: clock });
          const rowA = a.log.record(entry({ event: "winner" }));
          await store.appendDecision(rowA);
          before.push(...(await store.listDecisions({})));
        }
        return log.record(entry({ event: "loser_retried" }));
      },
    });

    const after = await store.listDecisions({});
    assert.equal(after.length, before.length + 1, "the retry APPENDED; it did not replace");
    assert.deepEqual(after[0], before[0], "the winning row is byte-identical afterwards");
  });

  it("four writers racing the same head all end up in one verifiable chain", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();

    // Genuinely interleaved: every writer hydrates before any writer inserts.
    const hydrated = await Promise.all([1, 2, 3, 4].map(() => hydrateLog({ store, now: clock })));
    const heads = new Set(hydrated.map((h) => (h.head ? h.head.entryHash : null)));
    assert.equal(heads.size, 1, "the premise: all four saw the same head");

    let appended = 0;
    for (let i = 0; i < 4; i += 1) {
      const outcome = await appendDecisionSerialised({ store, now: clock, mint: ({ log }) => log.record(entry({ event: `writer_${i}` })) });
      if (outcome.appended) appended += 1;
    }

    assert.equal(appended, 4);
    const rows = await store.listDecisions({});
    assert.equal(rows.length, 4);
    assert.equal(verifyRows(rows).ok, true);
    assert.deepEqual(rows.map((r) => r.sequence), [1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------

describe("the retry is bounded, and failure is loud", () => {
  it("throws rather than returning a falsy result when the attempts run out", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();

    // A head that moves before every attempt. No number of retries wins.
    const contended = {
      ...store,
      appendDecision: async () => ({ created: false, conflict: "head_taken", reason: "head_taken", decision: null }),
    };

    await assert.rejects(
      () => appendDecisionSerialised({ store: contended, now: clock, mint: ({ log }) => log.record(entry()) }),
      (err) => {
        assert.ok(err instanceof ChainContentionError);
        assert.equal(err.code, "chain_contention");
        assert.equal(err.attempts, MAX_APPEND_ATTEMPTS);
        assert.match(err.message, /has NOT been recorded/);
        return true;
      }
    );
    assert.equal((await store.listDecisions({})).length, 0, "nothing was written");
  });

  it("refuses an unbounded or absurd retry budget", async () => {
    const store = createInMemoryAcquisitionStore();
    for (const bad of [0, -1, 1000, Infinity, null, 2.5]) {
      await assert.rejects(
        () => appendDecisionSerialised({ store, now, mint: ({ log }) => log.record(entry()), maxAttempts: bad }),
        /bounded on purpose/,
        `maxAttempts ${String(bad)} was accepted`
      );
    }
  });

  it("a pre-built row cannot be passed, because a pre-built row cannot be retried", async () => {
    const store = createInMemoryAcquisitionStore();
    const { log } = await hydrateLog({ store, now });
    const row = log.record(entry());
    await assert.rejects(() => appendDecisionSerialised({ store, now, mint: row }), /cannot be retried/);
  });

  it("mint may look at the new head and decide the work is already done", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();

    const outcome = await appendDecisionSerialised({
      store,
      now: clock,
      mint: async ({ log, attempt }) => {
        if (attempt === 1) {
          const a = await hydrateLog({ store, now: clock });
          await store.appendDecision(a.log.record(entry({ event: "somebody_else_did_it" })));
          return log.record(entry({ event: "mine" }));
        }
        return null; // on re-check: already handled
      },
    });

    assert.deepEqual(
      { appended: outcome.appended, aborted: outcome.aborted, decision: outcome.decision },
      { appended: false, aborted: true, decision: null }
    );
    assert.equal((await store.listDecisions({})).length, 1);
  });

  it("reports each conflict to the caller's observer", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    const seen = [];
    const contended = { ...store, appendDecision: async () => ({ created: false, conflict: "head_taken", reason: "head_taken", decision: null }) };

    await appendDecisionSerialised({ store: contended, now: clock, mint: ({ log }) => log.record(entry()), maxAttempts: 3, onConflict: (c) => seen.push(c.attempt) }).catch(() => {});
    assert.deepEqual(seen, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------

describe("genesis is settled by the same rule", () => {
  it("a second chain cannot be started alongside the real one", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = createAuditLog({ now });
    await store.appendDecision(first.record(entry()));

    // A process that lost its way and restarted the log from scratch.
    const restarted = createAuditLog({ now: ticking() });
    const rogue = restarted.record(entry({ event: "second_genesis" }));
    assert.equal(rogue.prevHash, GENESIS_HASH);

    const result = await store.appendDecision(rogue);
    assert.equal(result.created, false);
    assert.equal(result.conflict, "head_taken", "a second genesis is a fork at row zero and is refused as one");
  });
});

// ---------------------------------------------------------------------------

describe("the review queue under two writers", () => {
  const { openReviewItem, resolveReviewItem, loadReviewItem, listReviewItems, REVIEW_DECISIONS, STATUS, EVENT_RESOLVED } = require("../src/services/acquisition-review-queue");

  const candidate = () => ({
    prospectId: "pr_race_0001",
    businessName: "Race Condition Locksmiths",
    tradeCategory: "Locksmith",
    suburb: "Coburg",
    state: "VIC",
    postcode: "3058",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 7101", label: "Listed" }],
    origin: "operator_import",
  });

  it("opening the same review twice under contention produces one item, not two", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();

    // A second importer opens the same review in the window between this one
    // hydrating and inserting. The retry re-checks and stands down.
    const inner = store.appendDecision.bind(store);
    let raced = false;
    store.appendDecision = async (row) => {
      if (!raced) {
        raced = true;
        await openReviewItem({ candidate: candidate(), reason: "the other importer got here first", store: { ...store, appendDecision: inner }, now: clock });
      }
      return inner(row);
    };

    const result = await openReviewItem({ candidate: candidate(), reason: "this importer lost the race", store, now: clock });
    assert.equal(result.created, false);
    assert.match(result.message, /Another process opened this/);

    const items = await listReviewItems({ store: { ...store, appendDecision: inner } });
    assert.equal(items.length, 1, "one review item, not two");
    assert.equal(verifyRows(await store.listDecisions({})).ok, true);
  });

  it("two operators resolving at once produce one resolution, and the loser is told", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    await openReviewItem({ candidate: candidate(), reason: "ambiguous", store, now: clock });

    const inner = store.appendDecision.bind(store);
    const plain = { ...store, appendDecision: inner };
    let raced = false;
    store.appendDecision = async (row) => {
      if (!raced && row.event === EVENT_RESOLVED) {
        raced = true;
        await resolveReviewItem({ store: plain, reviewId: "rv_pr_race_0001", decision: REVIEW_DECISIONS.REJECT_DUPLICATE, actor: "Alex", reason: "Same business as pr_0001, different suite number.", now: clock });
      }
      return inner(row);
    };

    const second = await resolveReviewItem({ store, reviewId: "rv_pr_race_0001", decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Sam", reason: "Looks like a genuinely separate shopfront to me.", now: clock });

    assert.equal(second.ok, false);
    assert.equal(second.code, "already_resolved");
    assert.match(second.message, /Alex/, "the refusal must name who did decide it");

    const item = await loadReviewItem({ store: plain, reviewId: "rv_pr_race_0001" });
    assert.equal(item.status, STATUS.RESOLVED);
    assert.equal(item.decision, REVIEW_DECISIONS.REJECT_DUPLICATE);
    assert.equal(item.decidedBy, "Alex");

    const resolutions = (await plain.listDecisions({})).filter((r) => r.event === EVENT_RESOLVED);
    assert.equal(resolutions.length, 1, "a second human decision must not be appended to an item already decided");
    assert.equal(verifyRows(await plain.listDecisions({})).ok, true);
  });

  it("a resolution that cannot be recorded is reported as a failure, never as a resolution", async () => {
    const store = createInMemoryAcquisitionStore();
    const clock = ticking();
    await openReviewItem({ candidate: candidate(), reason: "ambiguous", store, now: clock });

    const inner = store.appendDecision.bind(store);
    const plain = { ...store, appendDecision: inner };
    store.appendDecision = async (row) => (row.event === EVENT_RESOLVED ? { created: false, conflict: "head_taken", reason: "head_taken", decision: null } : inner(row));

    const result = await resolveReviewItem({ store, reviewId: "rv_pr_race_0001", decision: REVIEW_DECISIONS.APPROVE_AS_NEW, actor: "Sam", reason: "Separate shopfront, verified on the ABN lookup.", now: clock });

    assert.equal(result.ok, false);
    assert.equal(result.code, "chain_contention");
    assert.match(result.message, /still open/);

    const item = await loadReviewItem({ store: plain, reviewId: "rv_pr_race_0001" });
    assert.equal(item.status, STATUS.OPEN, "the item must still be waiting — nothing was written");
  });
});

// ---------------------------------------------------------------------------
// ── Ratchets ────────────────────────────────────────────────────────
//
// These exist to fail. Each one guards a property that is invisible in normal
// operation and catastrophic when absent.

describe("ratchets: the protection cannot be quietly removed", () => {
  const MIGRATION = "supabase/sql/laq3_serialise_decision_chain.sql";
  const STORE = "src/services/acquisition-store.js";
  const HELPER = "src/services/acquisition-decision-log.js";

  it("the migration still creates a UNIQUE index on exactly (prev_hash)", () => {
    const sql = read(MIGRATION);
    assert.match(
      sql,
      /create\s+unique\s+index\s+uq_acq_decisions_prev_hash\s+on\s+public\.acquisition_decisions\s*\(\s*prev_hash\s*\)/i,
      "The whole invariant is this one statement. Without it two processes can append different successors to the same head and the chain forks permanently, in a table where nothing can be deleted."
    );
  });

  it("the migration does not use CREATE UNIQUE INDEX IF NOT EXISTS", () => {
    // It succeeds whenever an index of that NAME exists, whatever that index
    // does — so a wrong index from an earlier hand-application would be
    // accepted and every report would say the invariant holds while it does not.
    //
    // Comments stripped first: the file NAMES the form it rejects, in prose,
    // which is the most useful thing that comment can say.
    const executable = read(MIGRATION)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    assert.doesNotMatch(executable, /create\s+unique\s+index\s+if\s+not\s+exists/i);
    assert.match(executable, /pg_get_indexdef/, "the guard must check the existing object's DEFINITION, not its name");
  });

  it("the store reads the head with a descending single-row query", () => {
    const src = read(STORE);
    const adapter = src.indexOf("function createSupabaseAcquisitionStore");
    assert.ok(adapter > 0, "the Supabase adapter must still exist to be checked");
    const head = src.slice(src.indexOf("async readChainHead()", adapter));
    const body = head.slice(0, head.indexOf("\n    },"));
    assert.match(body, /order\(\s*["']sequence["']\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/, "the head must be the highest sequence");
    assert.match(body, /\.limit\(1\)/, "one row");
    assert.doesNotMatch(body, /entity_type|entity_id/, "the chain is global — a filtered head is the head of a subsequence and minting against it points into the middle of the log");
  });

  it("only the serialised helper calls appendDecision directly", () => {
    // A domain module that inserts on its own has no retry, so it either
    // crashes on a lost race or — worse, if somebody adds a catch — reports a
    // decision as recorded that was refused.
    for (const rel of fs.readdirSync(path.join(ROOT, "src/services")).filter((f) => f.startsWith("acquisition-")).map((f) => `src/services/${f}`)) {
      if (rel.endsWith("acquisition-decision-log.js") || rel.endsWith("acquisition-store.js")) continue;
      assert.doesNotMatch(read(rel), /\bstore\.appendDecision\s*\(/, `${rel} appends to the chain without the retry path`);
    }
  });

  it("no caller derives the head from the end of a list", () => {
    // The M8H shape, which was right until the list was capped.
    const forbidden = /listDecisions\([^)]*\)\s*\)?\s*;?[\s\S]{0,120}?\[\s*\w+\.length\s*-\s*1\s*\]/;
    for (const rel of fs.readdirSync(path.join(ROOT, "src/services")).filter((f) => f.startsWith("acquisition-")).map((f) => `src/services/${f}`)) {
      assert.doesNotMatch(read(rel), forbidden, `${rel} takes the chain head from the last element of a capped page`);
    }
  });

  it("a prev_hash collision is never reported as created", async () => {
    const store = createInMemoryAcquisitionStore();
    const { log } = await hydrateLog({ store, now });
    const head = log.record(entry());
    await store.appendDecision(head);

    const rival = createAuditLog({ now: ticking() }).record(entry({ event: "rival" }));
    const result = await store.appendDecision({ ...rival, prevHash: head.prevHash, auditId: "au_definitely_different" });
    assert.notEqual(result.created, true, "swallowing this as success drops a decision on the floor while telling the caller it was stored");
  });

  it("the store distinguishes the two unique violations by name", () => {
    const src = read(STORE);
    assert.match(src, /uq_acq_decisions_prev_hash/, "the adapter must recognise the laq3 index by name");
    assert.match(src, /audit_id/, "and the idempotency constraint separately");
    // The M8H line that is now wrong: any 23505 returning created:false with no
    // conflict would report a fork as a replay.
    assert.doesNotMatch(src, /if\s*\(uniqueViolation\(error\)\)\s*return\s*\{\s*created:\s*false,\s*decision:\s*\{\s*\.\.\.row\s*\}\s*\}/);
  });

  it("an unrecognised unique violation fails closed, not open", () => {
    const src = read(STORE);
    const i = src.indexOf("unique_violation_unrecognised");
    assert.ok(i > 0, "there must be a branch for a 23505 that matches neither constraint");
    assert.match(src.slice(i - 200, i + 60), /conflict:\s*"head_taken"/, "an unknown collision must be treated as a lost race, because refusing to append is recoverable and claiming to have appended is not");
  });

  it("no process-local lock is presented as the serialisation mechanism", () => {
    // A mutex inside one Node process says nothing about the second process,
    // and a guard that is only sometimes right invites people to rely on it.
    const src = read(HELPER);
    for (const forbidden of [/\bnew\s+Mutex\b/, /\basync-mutex\b/, /\bsemaphore\b/i, /\bglobal(This)?\.\w*lock/i, /let\s+\w*[Ll]ock(ed)?\s*=\s*(false|true)/]) {
      assert.doesNotMatch(src, forbidden, `${String(forbidden)} — the serialisation is the database's, and nothing here may imply otherwise`);
    }
    assert.match(src, /unique \(prev_hash\)/, "the module must name where the actual protection lives");
  });

  it("verifyRows is not weakened", () => {
    const src = read("src/services/acquisition-audit.js");
    assert.match(src, /if \(body\.prevHash !== expectedPrev\)/, "the link check");
    assert.match(src, /if \(hashRow\(body\) !== entryHash\)/, "the content check");
    // A fork must still be reported by the verifier even with the index in
    // place, because the index protects the future and the verifier reads the past.
    const forked = [{ ...{}, sequence: 1 }];
    void forked;
    assert.equal(verifyRows([{ prevHash: "x".repeat(64), entryHash: "y", sequence: 1 }]).ok, false);
  });

  it("the append-only triggers are not disabled anywhere", () => {
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.isDirectory() && !["node_modules", ".git"].includes(e.name)) walk(`${dir}/${e.name}`, out);
        else if (e.isFile() && /\.(js|sql)$/.test(e.name)) out.push(`${dir}/${e.name}`);
      }
      return out;
    };
    const files = [...walk("src"), ...walk("scripts"), ...walk("supabase")];
    assert.ok(files.length > 20, "the walk found suspiciously little to check");

    for (const rel of files) {
      assert.doesNotMatch(read(rel), /disable\s+trigger/i, `${rel} disables an append-only trigger`);
    }

    // ── The one legitimate exception, named rather than excluded by wildcard ──
    //
    // The M8D probe harness attempts an UPDATE and a DELETE on the decision log
    // ON PURPOSE, inside nested BEGIN...EXCEPTION blocks, to prove the trigger
    // refuses them. A ratchet that banned the string outright would delete the
    // test that proves the property it is guarding.
    const PROBE = "supabase/sql/verification/05_behavioural_probes.sql";
    for (const rel of files.filter((f) => f !== PROBE)) {
      assert.doesNotMatch(read(rel), /delete\s+from\s+(public\.)?acquisition_decisions/i, `${rel} deletes from the decision log — a fork is never repaired by removing a row`);
      assert.doesNotMatch(read(rel), /update\s+(public\.)?acquisition_decisions\s+set/i, `${rel} updates the decision log`);
    }

    // And the exception is only an exception while it stays an expected failure.
    const probe = read(PROBE);
    assert.match(probe, /exception when others then/, "the probe's writes must be inside expected-failure handlers");
    assert.match(probe, /sqlstate = '23001'/, "and must assert the append-only SQLSTATE");
    assert.doesNotMatch(probe, /^\s*commit\s*;/im, "the probe must never commit");
  });

  it("the contract still requires readChainHead of every store", () => {
    assert.ok(STORE_METHODS.includes("readChainHead"));
    assert.ok(STORE_METHODS.includes("appendDecision"));
    // And no store may offer a way to remove a decision.
    const store = createInMemoryAcquisitionStore();
    for (const forbidden of ["deleteDecision", "removeDecision", "rewriteChain", "resetChain", "truncateDecisions"]) {
      assert.equal(typeof store[forbidden], "undefined", `a store exposing ${forbidden}() could repair a fork by destroying evidence`);
    }
  });

  it("the verifier's expected column list matches the laq1 DDL exactly", () => {
    // THE RATCHET AGAINST THE MISTAKE THIS FILE ALREADY MADE ONCE.
    //
    // 09_laq3_verify V12 originally asserted "16 columns", which was a miscount
    // — laq1 has defined 17 since the commit that created it, and dev has
    // always had exactly those. The check therefore reported REVIEW against a
    // perfectly correct schema, which is the worst thing a verifier can do: it
    // spends the reader's trust on a false alarm, and the next false alarm gets
    // waved through.
    //
    // A number in a SQL file cannot be kept honest by review. This derives the
    // truth from the migration and fails if the verifier disagrees with it.
    const ddl = read("supabase/sql/laq1_create_acquisition_prospects.sql");
    const block = /create table if not exists public\.acquisition_decisions \(([\s\S]*?)\n\);/.exec(ddl);
    assert.ok(block, "the acquisition_decisions DDL must still be findable in laq1");

    const columns = [];
    for (const raw of block[1].split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("--")) continue;
      const m = /^([a-z_][a-z0-9_]*)\s+\S/.exec(line);
      if (m && !["check", "constraint", "primary", "unique", "foreign", "references"].includes(m[1])) columns.push(m[1]);
    }
    assert.ok(columns.length > 10, `parsed only ${columns.length} columns — the parser, not the schema, is wrong`);

    const expected = [...columns].sort().join(",");
    const verifier = read("supabase/sql/verification/09_laq3_verify.sql");
    // The literal is wrapped across lines with || for readability; rejoin the
    // fragments. Only bare comma-separated identifiers count — the file also
    // contains string_agg delimiters and prose with commas in it.
    const v12 = verifier.slice(verifier.indexOf("select 'V12'"));
    const literal = (v12.match(/'[a-z_]+(?:,[a-z_]+)*,?'/g) || [])
      .map((s) => s.slice(1, -1))
      .filter((s) => s.includes(",") && s !== ",")
      .join("");
    assert.equal(literal, expected, "09_laq3_verify V12 no longer lists the columns laq1 defines. Update the literal — do not relax the check.");

    // And no count-based assertion has crept back in.
    assert.doesNotMatch(verifier, /count\(\*\)\s*=\s*1[0-9]\s+then 'PASS'[\s\S]{0,80}column/i, "a bare column count cannot tell an addition from an add-plus-drop");
  });

  it("the migration records the single-global-chain assumption it depends on", () => {
    const sql = read(MIGRATION);
    assert.match(sql, /chain_key/, "if the chain is ever partitioned the invariant must become unique (chain_key, prev_hash), and the migration has to say so");
  });
});
