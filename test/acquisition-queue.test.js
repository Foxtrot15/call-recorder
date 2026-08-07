// LOCKSMITH ACQUISITION M8B — the outbound call queue boundary.
//
// The properties that matter here are the ones that would let somebody be
// called who should not have been: a stale eligibility verdict trusted, a
// suppression that arrived after ingestion ignored, the same prospect handed to
// two workers, a retry doubling the day's calls, or a dialler quietly appearing
// inside a module that is supposed to be inert.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createCallQueue, ORDERING_EXPLANATION, MAX_SELECTION } = require("../src/services/acquisition-queue");
const { createProspect, transitionProspect } = require("../src/services/acquisition-prospect");
const { qualifyProspect } = require("../src/services/acquisition-qualification");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z"); // Fri 13:00 Melbourne — inside the window
const now = () => AT;

const TRADE_EVIDENCE = [{ evidenceId: "ev_1", kind: "trade_category", value: "Locksmith — 24 hour emergency lockouts and rekeying" }];
const evidenceFor = () => TRADE_EVIDENCE;

/** A prospect that qualifies, parked in a queueable state. */
function approved(overrides = {}) {
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

/** A stand-in eligibility engine. Real composition is covered end-to-end in the walkthrough. */
function allowAll() {
  return (prospect, context) =>
    Object.freeze({
      eligible: true,
      code: "eligible",
      message: "This business can be called now.",
      canonicalNumber: "+61355501042",
      localTime: "13:00",
      prospectId: prospect.prospectId,
      businessName: prospect.businessName,
      evaluatedAt: (context.at || AT).toISOString(),
      failedChecks: [],
    });
}

function blockOn(predicate, code = "suppressed_permanently", message = "This business must never be called.") {
  return (prospect, context) => {
    if (predicate(prospect, context)) {
      return Object.freeze({ eligible: false, code, message, prospectId: prospect.prospectId, businessName: prospect.businessName, failedChecks: [] });
    }
    return allowAll()(prospect, context);
  };
}

const makeQueue = (evaluate = allowAll(), opts = {}) => createCallQueue({ now, evaluate, ...opts });

// ── Construction ────────────────────────────────────────────────────

describe("construction", () => {
  it("refuses to exist without a clock", () => {
    assert.throws(() => createCallQueue({ evaluate: allowAll() }), /injected now/);
  });

  it("refuses to exist without an eligibility engine — it must not decide permission itself", () => {
    assert.throws(() => createCallQueue({ now }), /must not decide eligibility itself/);
  });
});

// ── The central property: eligibility is re-run, never trusted ──────

describe("eligibility is re-decided at the selection instant", () => {
  it("ignores an eligibility verdict already sitting on the record", () => {
    // The exact shape a naive implementation would read and believe.
    const forged = Object.freeze({
      ...approved(),
      eligibility: { eligible: true, code: "eligible", message: "forged" },
      eligible: true,
      callable: true,
    });
    const queue = makeQueue(blockOn(() => true));
    const result = queue.selectNext({ prospects: [forged], limit: 1, workerId: "w1", evidenceFor });
    assert.strictEqual(result.selected.length, 0, "a forged verdict on the record must count for nothing");
    assert.strictEqual(result.skipped[0].code, "not_eligible");
  });

  it("a prospect suppressed AFTER it entered consideration is not returned", () => {
    const p = approved();
    const suppressed = new Set();
    const queue = makeQueue(blockOn((x) => suppressed.has(x.prospectId)));

    const before = queue.preview({ prospects: [p], limit: 5, evidenceFor });
    assert.strictEqual(before.next.length, 1, "it should be callable to begin with");

    // The opt-out arrives between ingestion and selection.
    suppressed.add(p.prospectId);

    const after = queue.selectNext({ prospects: [p], limit: 5, workerId: "w1", evidenceFor });
    assert.strictEqual(after.selected.length, 0);
    assert.strictEqual(after.skipped[0].code, "not_eligible");
    assert.match(after.skipped[0].message, /never be called/);
  });

  it("asks the engine about the instant being selected for, not about now", () => {
    const seen = [];
    const queue = makeQueue((prospect, context) => {
      seen.push(context.at);
      return allowAll()(prospect, context);
    });
    const future = new Date("2026-08-11T23:30:00.000Z");
    queue.preview({ prospects: [approved()], limit: 1, at: future, evidenceFor });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].toISOString(), future.toISOString(), "a scheduler asking about Tuesday must be answered about Tuesday");
  });

  it("re-evaluates on every call — two selections mean two evaluations", () => {
    let calls = 0;
    const queue = makeQueue((prospect, context) => {
      calls += 1;
      return allowAll()(prospect, context);
    });
    const p = approved();
    queue.preview({ prospects: [p], limit: 1, evidenceFor });
    queue.preview({ prospects: [p], limit: 1, evidenceFor });
    assert.strictEqual(calls, 2, "a cached verdict would show up as one");
  });

  it("an engine that returns nothing is a refusal, not a pass", () => {
    const queue = makeQueue(() => null);
    const result = queue.selectNext({ prospects: [approved()], limit: 1, workerId: "w1", evidenceFor });
    assert.strictEqual(result.selected.length, 0);
    assert.strictEqual(result.skipped[0].code, "not_eligible");
  });
});

// ── Qualification and eligibility stay distinct ─────────────────────

describe("worth calling and allowed to be called are separate answers", () => {
  it("an unqualified prospect is skipped as unqualified, not as ineligible", () => {
    const plumber = approved({ businessName: "Lockyer Valley Plumbing", tradeCategory: "Plumbing" });
    const queue = makeQueue();
    const result = queue.preview({ prospects: [plumber], limit: 5, evidenceFor: () => [] });
    assert.strictEqual(result.next.length, 0);
    assert.strictEqual(result.skipped[0].code, "not_qualified");
  });

  it("a qualified but blocked prospect is skipped as ineligible, not as unqualified", () => {
    const queue = makeQueue(blockOn(() => true, "dncr_listed", "This number is on the Do Not Call Register."));
    const result = queue.preview({ prospects: [approved()], limit: 5, evidenceFor });
    assert.strictEqual(result.skipped[0].code, "not_eligible");
  });

  it("both skip codes are ones the vocabulary knows and both carry a label", () => {
    const queue = makeQueue(blockOn((p) => p.businessName.includes("Blocked")));
    const result = queue.preview({
      prospects: [approved(), approved({ businessName: "Blocked Locksmiths", suburb: "Kew" }), approved({ businessName: "Ace Plumbing", suburb: "Kew", tradeCategory: "Plumbing" })],
      limit: 5,
      evidenceFor: (id) => (id ? TRADE_EVIDENCE : []),
    });
    assert.ok(result.skipped.length >= 1);
    for (const s of result.skipped) {
      assert.ok(S.QUEUE_SKIP_CODES.includes(s.code), `"${s.code}" is not a known skip code`);
      assert.strictEqual(s.label, S.QUEUE_SKIP_LABELS[s.code]);
    }
  });

  it("eligibility decides who is in the list; qualification decides where they sit", () => {
    assert.strictEqual(ORDERING_EXPLANATION.by, "qualification");
    assert.match(ORDERING_EXPLANATION.note, /Eligibility decides who is in the list at all, never where they sit/);
  });
});

// ── Lifecycle gating ────────────────────────────────────────────────

describe("only records a call can start from are considered", () => {
  it("refuses every state that is not queueable, naming why", () => {
    const queue = makeQueue();
    for (const lifecycle of S.PROSPECT_STATES.filter((s) => !S.QUEUEABLE_STATES.includes(s))) {
      const result = queue.preview({ prospects: [approved({ lifecycle })], limit: 5, evidenceFor });
      assert.strictEqual(result.next.length, 0, `${lifecycle} must not be selectable`);
      assert.ok(["already_engaged", "lifecycle_not_queueable"].includes(result.skipped[0].code), `${lifecycle} → ${result.skipped[0].code}`);
    }
  });

  it("a suppressed record never even reaches the eligibility engine", () => {
    let evaluated = 0;
    const queue = makeQueue((p, c) => {
      evaluated += 1;
      return allowAll()(p, c);
    });
    queue.preview({ prospects: [approved({ lifecycle: "suppressed" })], limit: 5, evidenceFor });
    assert.strictEqual(evaluated, 0, "a suppressed business must be refused before we go asking whether it is callable");
  });

  it("a customer is never in a prospecting queue", () => {
    const queue = makeQueue();
    const result = queue.preview({ prospects: [approved({ lifecycle: "customer" })], limit: 5, evidenceFor });
    assert.strictEqual(result.next.length, 0);
    assert.strictEqual(result.skipped[0].code, "already_engaged");
  });

  it("accepts the states a retry legitimately comes from", () => {
    const queue = makeQueue();
    for (const lifecycle of ["review_approved", "queued", "attempted", "callback_requested"]) {
      const result = queue.preview({ prospects: [approved({ lifecycle })], limit: 5, evidenceFor });
      assert.strictEqual(result.next.length, 1, `${lifecycle} should be selectable`);
    }
  });
});

// ── Leases ──────────────────────────────────────────────────────────

describe("leases stop the same prospect being called twice", () => {
  it("a second worker asking at the same instant gets nothing rather than the same record", () => {
    const p = approved();
    const queue = makeQueue();
    const first = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-a", evidenceFor });
    assert.strictEqual(first.selected.length, 1);

    const second = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-b", evidenceFor });
    assert.strictEqual(second.selected.length, 0, "worker-b must not receive a prospect worker-a holds");
    assert.strictEqual(second.skipped[0].code, "already_leased");
    assert.match(second.skipped[0].message, /worker-a/);
  });

  it("two workers dividing a list get disjoint sets", () => {
    const list = [approved({ businessName: "Alpha Locksmiths", suburb: "Carlton" }), approved({ businessName: "Bravo Lock & Key", suburb: "Fitzroy" }), approved({ businessName: "Charlie Locks", suburb: "Kew" })];
    const queue = makeQueue();
    const a = queue.selectNext({ prospects: list, limit: 2, workerId: "worker-a", evidenceFor });
    const b = queue.selectNext({ prospects: list, limit: 2, workerId: "worker-b", evidenceFor });

    const aIds = a.selected.map((r) => r.prospectId);
    const bIds = b.selected.map((r) => r.prospectId);
    assert.strictEqual(aIds.length, 2);
    assert.strictEqual(bIds.length, 1);
    assert.strictEqual(aIds.filter((id) => bIds.includes(id)).length, 0, "the two workers overlap");
  });

  it("an expired lease frees the prospect — a dead worker strands nothing", () => {
    const p = approved();
    const queue = makeQueue(allowAll(), { leaseTtlMs: 60_000 });
    queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-a", evidenceFor });

    const later = new Date(AT.getTime() + 61_000);
    const result = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-b", at: later, evidenceFor });
    assert.strictEqual(result.selected.length, 1, "the lease should have expired");
    assert.strictEqual(queue.activeLeases({ at: later }).length, 1);
  });

  it("releasing gives the prospect back", () => {
    const p = approved();
    const queue = makeQueue();
    const first = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-a", evidenceFor });
    const token = first.selected[0].lease.token;

    assert.deepStrictEqual(queue.release(token), { ok: true, prospectId: p.prospectId, event: "released" });
    const second = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-b", evidenceFor });
    assert.strictEqual(second.selected.length, 1);
  });

  it("a released prospect is still re-checked, not waved through", () => {
    const p = approved();
    let blocked = false;
    const queue = makeQueue(blockOn(() => blocked));
    const first = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-a", evidenceFor });
    queue.release(first.selected[0].lease.token);
    blocked = true;
    const second = queue.selectNext({ prospects: [p], limit: 1, workerId: "worker-b", evidenceFor });
    assert.strictEqual(second.selected.length, 0);
  });

  it("an unknown or already-ended lease says so instead of pretending to succeed", () => {
    const queue = makeQueue();
    assert.strictEqual(queue.release("lease_nope_1").ok, false);
    assert.strictEqual(queue.release("lease_nope_1").code, "lease_not_found");
    assert.strictEqual(queue.release(null).code, "token_required");

    const first = queue.selectNext({ prospects: [approved()], limit: 1, workerId: "w", evidenceFor });
    const token = first.selected[0].lease.token;
    assert.strictEqual(queue.complete(token).ok, true);
    assert.strictEqual(queue.complete(token).ok, false, "completing twice must not silently succeed");
  });

  it("a selection has to name the worker taking it", () => {
    const queue = makeQueue();
    for (const workerId of [null, "", "   ", undefined]) {
      const result = queue.selectNext({ prospects: [approved()], limit: 1, workerId, evidenceFor });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, "worker_required");
    }
  });

  it("previewing reserves nothing", () => {
    const queue = makeQueue();
    const p = approved();
    queue.preview({ prospects: [p], limit: 5, evidenceFor });
    assert.deepStrictEqual([...queue.activeLeases()], []);
    assert.strictEqual(queue.selectNext({ prospects: [p], limit: 1, workerId: "w", evidenceFor }).selected.length, 1);
  });
});

// ── Idempotency ─────────────────────────────────────────────────────

describe("a retried request does not double the day's calls", () => {
  it("the same requestId returns the identical selection and reserves nothing more", () => {
    const list = [approved({ businessName: "Alpha Locksmiths", suburb: "Carlton" }), approved({ businessName: "Bravo Lock & Key", suburb: "Fitzroy" })];
    const queue = makeQueue();

    const first = queue.selectNext({ prospects: list, limit: 1, workerId: "w1", requestId: "req-42", evidenceFor });
    const retry = queue.selectNext({ prospects: list, limit: 1, workerId: "w1", requestId: "req-42", evidenceFor });

    assert.deepStrictEqual(retry, first, "a retry must be the same answer, not a second reservation");
    assert.strictEqual(queue.activeLeases().length, 1, "the retry reserved a second prospect");
  });

  it("a different requestId is a genuinely new request", () => {
    const list = [approved({ businessName: "Alpha Locksmiths", suburb: "Carlton" }), approved({ businessName: "Bravo Lock & Key", suburb: "Fitzroy" })];
    const queue = makeQueue();
    queue.selectNext({ prospects: list, limit: 1, workerId: "w1", requestId: "req-1", evidenceFor });
    const second = queue.selectNext({ prospects: list, limit: 1, workerId: "w1", requestId: "req-2", evidenceFor });
    assert.strictEqual(second.selected.length, 1);
    assert.strictEqual(queue.activeLeases().length, 2);
  });

  it("without a requestId each call is a fresh selection", () => {
    const list = [approved({ businessName: "Alpha Locksmiths", suburb: "Carlton" }), approved({ businessName: "Bravo Lock & Key", suburb: "Fitzroy" })];
    const queue = makeQueue();
    queue.selectNext({ prospects: list, limit: 1, workerId: "w1", evidenceFor });
    queue.selectNext({ prospects: list, limit: 1, workerId: "w1", evidenceFor });
    assert.strictEqual(queue.activeLeases().length, 2);
  });
});

// ── Ordering ────────────────────────────────────────────────────────

describe("ordering is deterministic and explained", () => {
  const list = () => [
    approved({ businessName: "Weak Locks", suburb: "Kew", abn: null, sourceRefs: [{ url: "https://www.yellowpages.com.au/vic/kew/weak-locks" }] }),
    approved({ businessName: "Strong Locksmiths", suburb: "Carlton", abn: "22 222 222 222", phones: [{ raw: "(03) 5550 2222" }, { raw: "1300 555 022" }] }),
    approved({ businessName: "Middle Lock & Key", suburb: "Fitzroy", abn: "33 333 333 333" }),
  ];

  it("the same set produces the same order however it arrives", () => {
    const queue = makeQueue();
    const forward = queue.preview({ prospects: list(), limit: 10, evidenceFor }).next.map((r) => r.businessName);
    const backward = queue.preview({ prospects: list().reverse(), limit: 10, evidenceFor }).next.map((r) => r.businessName);
    assert.deepStrictEqual(backward, forward);
    assert.ok(forward.length >= 2, "the fixture should produce a real ordering to check");
  });

  it("every returned row says why it ranked where it did and why it is callable", () => {
    const queue = makeQueue();
    const next = queue.preview({ prospects: list(), limit: 10, evidenceFor }).next;
    assert.ok(next.length >= 2, "the fixture should produce more than one row to check");
    next.forEach((row, i) => {
      assert.ok(row.whyRanked.length > 0, `${row.businessName} does not explain its rank`);
      assert.ok(row.whyCallable && row.whyCallable.length > 0, `${row.businessName} does not explain its permission`);
      assert.ok(S.QUALIFICATION_TIERS.includes(row.tier));
      assert.strictEqual(row.position, i + 1, "position must match the row's place in the list");
    });
  });

  it("carries the tie-break sequence, so a screen need not guess how the order was made", () => {
    const queue = makeQueue();
    const ordering = queue.preview({ prospects: list(), limit: 10, evidenceFor }).ordering;
    assert.ok(ordering.tieBreakers.length >= 2);
    assert.strictEqual(ordering.tieBreakers[ordering.tieBreakers.length - 1].key, "prospectId");
    for (const t of ordering.tieBreakers) assert.ok(t.label && t.direction);
  });

  it("preview and selectNext agree about who is next", () => {
    const queue = makeQueue();
    const set = list();
    const previewed = queue.preview({ prospects: set, limit: 2, evidenceFor }).next.map((r) => r.prospectId);
    const selected = queue.selectNext({ prospects: set, limit: 2, workerId: "w1", evidenceFor }).selected.map((r) => r.prospectId);
    assert.deepStrictEqual(selected, previewed);
  });

  it("uses the number the eligibility engine cleared, not one picked off the record", () => {
    const queue = makeQueue();
    const row = queue.preview({ prospects: [approved()], limit: 1, evidenceFor }).next[0];
    assert.strictEqual(row.e164, "+61355501042");
  });
});

// ── Limits and malformed input ──────────────────────────────────────

describe("limits and bad input", () => {
  it("caps a single selection rather than evaluating forever", () => {
    const queue = makeQueue();
    const result = queue.selectNext({ prospects: [approved()], limit: MAX_SELECTION + 1, workerId: "w1", evidenceFor });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "limit_too_large");
  });

  it("refuses a nonsensical limit instead of guessing one", () => {
    const queue = makeQueue();
    for (const limit of [0, -1, 1.5, "two", null]) {
      assert.strictEqual(queue.selectNext({ prospects: [approved()], limit, workerId: "w1", evidenceFor }).code, "limit_invalid");
    }
  });

  it("skips malformed records rather than throwing — one bad row must not stop the queue", () => {
    const queue = makeQueue();
    const result = queue.preview({ prospects: [null, "x", 7, [], approved()], limit: 10, evidenceFor });
    assert.strictEqual(result.next.length, 1);
    assert.strictEqual(result.considered, 1);
  });

  it("an empty list is an empty queue, not an error", () => {
    const queue = makeQueue();
    const result = queue.preview({ prospects: [], limit: 10, evidenceFor });
    assert.deepStrictEqual([...result.next], []);
    assert.strictEqual(result.eligibleCount, 0);
  });

  it("reports how many eligible prospects were left behind", () => {
    const queue = makeQueue();
    const set = [approved({ businessName: "A Locksmiths", suburb: "Kew" }), approved({ businessName: "B Locksmiths", suburb: "Carlton" }), approved({ businessName: "C Locksmiths", suburb: "Fitzroy" })];
    const result = queue.selectNext({ prospects: set, limit: 1, workerId: "w1", evidenceFor });
    assert.strictEqual(result.eligibleCount, 3);
    assert.strictEqual(result.remaining, 2);
  });
});

// ── The queue is inert ──────────────────────────────────────────────

describe("the queue cannot call anybody", () => {
  const queue = makeQueue();

  it("exports nothing that dispatches", () => {
    for (const key of Object.keys(queue)) {
      assert.ok(!/^(dial|dispatch|place|ring|start|send|execute|trigger|call)$/i.test(key), `"${key}" reads like something that places a call`);
    }
  });

  it("says on its own artifact that nothing was called", () => {
    const selection = queue.selectNext({ prospects: [approved()], limit: 1, workerId: "w1", evidenceFor });
    assert.match(selection.note, /Nothing here places, schedules or prepares a call/);
    assert.match(queue.preview({ prospects: [approved()], limit: 1, evidenceFor }).note, /no call is placed/);
  });

  it("reaches no network and imports nothing that is not local", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-queue"), "utf8");
    for (const forbidden of ["twilio", "retell", "fetch(", "axios", "XMLHttpRequest", "require(\"http", "require('http", "https://api.", "child_process"]) {
      assert.ok(!src.includes(forbidden), `the queue must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });

  it("returns frozen results a caller cannot patch into a bigger selection", () => {
    const selection = queue.selectNext({ prospects: [approved()], limit: 1, workerId: "w1", evidenceFor });
    assert.ok(Object.isFrozen(selection));
    assert.ok(Object.isFrozen(selection.selected));
    assert.throws(() => {
      "use strict";
      selection.selected.push({});
    });
  });
});

// ── Audit ───────────────────────────────────────────────────────────

describe("selections are audited", () => {
  function recorder() {
    const rows = [];
    return { rows, record: (r) => rows.push(r) };
  }

  it("records who took what, and why that many", () => {
    const audit = recorder();
    const queue = makeQueue(allowAll(), { audit });
    queue.selectNext({ prospects: [approved()], limit: 1, workerId: "worker-a", requestId: "req-9", evidenceFor });

    assert.strictEqual(audit.rows.length, 1);
    const row = audit.rows[0];
    assert.strictEqual(row.entityType, "queue");
    assert.strictEqual(row.actor, "worker-a");
    assert.strictEqual(row.actorKind, "system", "a queue worker is not a person and must not be recorded as one");
    assert.match(row.reason, /Reserved 1 of 1/);
    assert.deepStrictEqual(row.detail.prospectIds.length, 1);
  });

  it("records releases and completions against the prospect", () => {
    const audit = recorder();
    const queue = makeQueue(allowAll(), { audit });
    const first = queue.selectNext({ prospects: [approved()], limit: 1, workerId: "worker-a", evidenceFor });
    queue.release(first.selected[0].lease.token, { reason: "Shift ended." });

    const released = audit.rows.find((r) => r.event === "released");
    assert.ok(released, "a release must be auditable");
    assert.strictEqual(released.reason, "Shift ended.");
  });

  it("a retried request is not audited twice", () => {
    const audit = recorder();
    const queue = makeQueue(allowAll(), { audit });
    queue.selectNext({ prospects: [approved()], limit: 1, workerId: "w", requestId: "req-1", evidenceFor });
    queue.selectNext({ prospects: [approved()], limit: 1, workerId: "w", requestId: "req-1", evidenceFor });
    assert.strictEqual(audit.rows.filter((r) => r.event === "selection").length, 1);
  });
});

// ── Composition with the real qualification engine ──────────────────

describe("composed with the real qualification engine", () => {
  it("a genuinely stronger locksmith is offered before a weaker one", () => {
    const weak = approved({ businessName: "Thin Locks", suburb: "Kew", abn: null, sourceRefs: [{ url: "https://www.yellowpages.com.au/vic/kew/thin-locks" }] });
    const strong = approved({
      businessName: "Metro Emergency Locksmiths",
      suburb: "Richmond",
      abn: "44 444 444 444",
      phones: [{ raw: "(03) 5550 4444" }, { raw: "1300 555 044" }],
    });
    const queue = makeQueue();
    const next = queue.preview({
      prospects: [weak, strong],
      limit: 5,
      evidenceFor: () => [
        { evidenceId: "e1", kind: "trade_category", value: "Locksmith — 24 hour emergency lockouts" },
        { evidenceId: "e2", kind: "operating_status", value: "Trading" },
        { evidenceId: "e3", kind: "service_area", value: "Richmond, Hawthorn, Kew, Camberwell, Balwyn, Box Hill" },
      ],
    }).next;

    assert.strictEqual(next[0].businessName, "Metro Emergency Locksmiths");
    const why = queue.compareQualifications(next[0].qualification, next[1].qualification);
    assert.ok(why.reason.includes("ranks above"));
  });

  it("a precomputed qualification is honoured, but a precomputed eligibility never is", () => {
    // Qualification is pure and deterministic, so caching one is safe.
    // Eligibility depends on the instant, so caching one is never safe.
    const p = approved();
    const queue = makeQueue(blockOn(() => true));
    const result = queue.preview({
      prospects: [p],
      limit: 1,
      evidenceFor,
      qualificationFor: () => qualifyProspect(p, { evidenceRows: TRADE_EVIDENCE, at: AT }),
    });
    assert.strictEqual(result.next.length, 0, "the blocked engine must still have the last word");
    assert.strictEqual(result.skipped[0].code, "not_eligible");
  });
});

// ── The lifecycle move that follows a selection ─────────────────────

describe("moving a selected prospect into the queued state", () => {
  it("review_approved → queued is a legal transition with an actor and a reason", () => {
    const p = approved();
    const moved = transitionProspect(p, "queued", { actor: "acquisition-queue", reason: "Selected into an approved calling batch.", now });
    assert.strictEqual(moved.ok, true, moved.message);
    assert.strictEqual(moved.prospect.lifecycle, "queued");
  });

  it("a queued prospect can be released back when its lease ends", () => {
    const queued = Object.freeze({ ...approved(), lifecycle: "queued" });
    const released = transitionProspect(queued, "review_approved", { actor: "acquisition-queue", reason: "Lease expired without an attempt.", now });
    assert.strictEqual(released.ok, true, released.message);
  });
});

// ── One business, one place in the queue ────────────────────────────
//
// Found by the M8B walkthrough, not by a unit test: "Preston Key & Safe" and
// "Preston Key and Safe Pty Ltd" are one prospectId, because A1 derives the id
// from the identity fingerprint. The queue returned both and leased both — and
// because leases are keyed by prospectId, the second grant silently overwrote
// the first, so two workers each believed they held it.

describe("two records for one business collapse to one calling target", () => {
  /** Two differently-spelled records that resolve to the same prospectId. */
  const collidingPair = () => {
    const a = approved({ businessName: "Preston Key & Safe", suburb: "Preston", abn: "53 337 901 664" });
    const b = approved({ businessName: "Preston Key and Safe Pty Ltd", suburb: "Preston", abn: "53 337 901 664" });
    assert.strictEqual(a.prospectId, b.prospectId, "the fixture must actually collide, or this proves nothing");
    return [a, b];
  };

  it("offers the business once, not twice", () => {
    const queue = makeQueue();
    const next = queue.preview({ prospects: collidingPair(), limit: 10, evidenceFor }).next;
    assert.strictEqual(next.length, 1, `the same business was offered ${next.length} times`);
  });

  it("says why the other record was dropped", () => {
    const queue = makeQueue();
    const skipped = queue.preview({ prospects: collidingPair(), limit: 10, evidenceFor }).skipped;
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].code, "identity_collision");
    assert.match(skipped[0].message, /same business/);
  });

  it("leases it once, so two workers cannot both believe they hold it", () => {
    const queue = makeQueue();
    const selection = queue.selectNext({ prospects: collidingPair(), limit: 5, workerId: "worker-a", evidenceFor });
    assert.strictEqual(selection.selected.length, 1);
    assert.strictEqual(queue.activeLeases().length, 1);

    const other = queue.selectNext({ prospects: collidingPair(), limit: 5, workerId: "worker-b", evidenceFor });
    assert.strictEqual(other.selected.length, 0, "worker-b must not get the business worker-a holds");
  });

  it("picks the same representative every time, whatever order they arrive in", () => {
    const queue = makeQueue();
    const pair = collidingPair();
    const forward = queue.preview({ prospects: pair, limit: 5, evidenceFor }).next[0].businessName;
    const backward = queue.preview({ prospects: [...pair].reverse(), limit: 5, evidenceFor }).next[0].businessName;
    assert.strictEqual(backward, forward);
  });

  it("does not collapse genuinely different businesses", () => {
    const queue = makeQueue();
    const distinct = [approved({ businessName: "Alpha Locksmiths", suburb: "Carlton" }), approved({ businessName: "Bravo Lock & Key", suburb: "Fitzroy" })];
    assert.notStrictEqual(distinct[0].prospectId, distinct[1].prospectId);
    assert.strictEqual(queue.preview({ prospects: distinct, limit: 5, evidenceFor }).next.length, 2);
  });
});
