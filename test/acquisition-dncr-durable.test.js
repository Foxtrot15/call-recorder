// LOCKSMITH ACQUISITION M8K — durable Do Not Call Register wash storage (E-3).
//
// Until M8K the wash store was an in-process Map: a wash a human performed,
// attested and imported did not survive the process exiting. After a restart
// every number read back as "unknown", which vetoes — so the failure direction
// was always safe, but a real wash could never authorise anything across a
// restart either.
//
// The property under test throughout is the one the whole module exists for:
// THREE STATES, NEVER TWO. "not on the Register", "on the Register", and "we do
// not know" — where not-knowing is itself split into never-washed, expired, and
// could-not-read. Collapsing any of those into "fine" is the mistake that
// produces mass unlawful calling.
//
// laq4 is WRITTEN AND NOT APPLIED anywhere, so these run against the in-memory
// adapter, which implements the same contract including laq4's idempotency rule.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createWashStore, hydrateWashStore, importWashResults, unavailableWashStore, canonicalNumber, DNCR_WASH_VALIDITY_DAYS } = require("../src/services/acquisition-dncr");
const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createEligibilityEngine, ELIGIBILITY_CODES } = require("../src/services/acquisition-eligibility");

const DAY = 24 * 3600 * 1000;
const AT = new Date("2026-08-10T03:00:00.000Z");
const now = () => AT;
const clockAt = (offsetDays) => () => new Date(AT.getTime() + offsetDays * DAY);
const daysAgo = (n) => new Date(AT.getTime() - n * DAY).toISOString();

const NUMBER = "+61355501042";

const batch = (over = {}) => ({
  washedAt: daysAgo(1),
  batchRef: "wash-2026-08-09",
  attestedBy: "Peter Dang",
  results: [{ e164: NUMBER, result: "not_listed" }],
  ...over,
});

/** Import a batch and hand back a store hydrated from what was persisted. */
async function persistedThenHydrated(over = {}, { clock = now } = {}) {
  const store = createInMemoryAcquisitionStore();
  const result = await importWashResults({ store, batch: batch(over), now });
  assert.strictEqual(result.ok, true, `import failed: ${result.message || ""}`);
  return { store, wash: await hydrateWashStore({ store, now: clock }) };
}

// ── The three states ────────────────────────────────────────────────

describe("what a durable wash can say", () => {
  it("a fresh not_listed is usable, and authoritative because a human attested it", async () => {
    const { wash } = await persistedThenHydrated();
    const a = wash.assess(NUMBER);
    assert.strictEqual(a.result, "not_listed");
    assert.strictEqual(a.usable, true);
    assert.strictEqual(a.fresh, true);
    assert.strictEqual(a.authoritative, true, "an attested import is the only authoritative source");
  });

  it("a fresh listed is usable and blocks", async () => {
    const { wash } = await persistedThenHydrated({ results: [{ e164: NUMBER, result: "listed" }] });
    const a = wash.assess(NUMBER);
    assert.strictEqual(a.result, "listed");
    assert.strictEqual(a.usable, true);
  });

  it("a number nobody washed is unknown, not clear", async () => {
    const { wash } = await persistedThenHydrated();
    const a = wash.assess("+61355509999");
    assert.strictEqual(a.result, "unknown");
    assert.strictEqual(a.usable, false);
  });

  it("a wash past its validity decays to unknown, NOT to its last answer", async () => {
    // Persisted as not_listed, then read 31 days later. It must not still say
    // "not listed" — an expired check is not a check.
    const { wash } = await persistedThenHydrated({}, { clock: clockAt(DNCR_WASH_VALIDITY_DAYS + 1) });
    const a = wash.assess(NUMBER);
    assert.strictEqual(a.result, "unknown", "a stale wash must not report its old value");
    assert.strictEqual(a.usable, false);
    assert.strictEqual(a.priorResult, "not_listed", "but what it used to say stays visible for a human");
  });

  it("freshness is evaluated at READ time — nothing rewrites a row when time passes", async () => {
    const { store, wash } = await persistedThenHydrated();
    assert.strictEqual(wash.assess(NUMBER).usable, true);

    const rowsBefore = await store.listWashes({ e164: NUMBER });
    const laterRead = await hydrateWashStore({ store, now: clockAt(DNCR_WASH_VALIDITY_DAYS + 1) });
    assert.strictEqual(laterRead.assess(NUMBER).usable, false, "the same row is unusable later");

    const rowsAfter = await store.listWashes({ e164: NUMBER });
    assert.deepStrictEqual(rowsAfter, rowsBefore, "no row may change merely because time passed");
  });
});

// ── Restart safety ──────────────────────────────────────────────────

describe("a wash survives the process that imported it", () => {
  it("import → exit → fresh process → same answer", async () => {
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch(), now });

    // The importing process is gone. Nothing is carried over but the store.
    const afterRestart = await hydrateWashStore({ store, now });
    const a = afterRestart.assess(NUMBER);
    assert.strictEqual(a.result, "not_listed");
    assert.strictEqual(a.usable, true);
    assert.strictEqual(a.authoritative, true);
  });

  it("and decays on schedule in that fresh process, without being touched", async () => {
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(29) }), now });

    assert.strictEqual((await hydrateWashStore({ store, now })).assess(NUMBER).usable, true, "29 days old — still good");
    assert.strictEqual((await hydrateWashStore({ store, now: clockAt(2) })).assess(NUMBER).usable, false, "31 days old — expired");
  });

  it("a process-local store cannot override what the durable ledger holds", async () => {
    // The attack: a stale in-process store that still believes a number is
    // clear, alongside a durable ledger that says it is listed.
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch({ results: [{ e164: NUMBER, result: "listed" }] }), now });

    const optimistic = createWashStore({ now, mode: "fixture" });
    optimistic.wash(NUMBER); // fixture says not_listed — and is never authoritative
    assert.strictEqual(optimistic.assess(NUMBER).result, "not_listed");
    assert.strictEqual(optimistic.assess(NUMBER).authoritative, false, "a fixture answer is never authoritative");

    const durable = await hydrateWashStore({ store, now });
    assert.strictEqual(durable.assess(NUMBER).result, "listed", "the durable ledger is what decides");
  });
});

// ── Idempotency and ordering ────────────────────────────────────────

describe("importing the same paperwork twice", () => {
  it("does not duplicate rows", async () => {
    const store = createInMemoryAcquisitionStore();
    const first = await importWashResults({ store, batch: batch(), now });
    const second = await importWashResults({ store, batch: batch(), now });

    assert.strictEqual(first.imported, 1);
    assert.strictEqual(second.imported, 0);
    assert.strictEqual(second.duplicates, 1, "the repeat must be reported, not silently written");
    assert.strictEqual((await store.listWashes({ e164: NUMBER })).length, 1);
  });

  it("a NEWER wash becomes authoritative", async () => {
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(20), results: [{ e164: NUMBER, result: "not_listed" }] }), now });
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(1), batchRef: "later", results: [{ e164: NUMBER, result: "listed" }] }), now });

    const wash = await hydrateWashStore({ store, now });
    assert.strictEqual(wash.assess(NUMBER).result, "listed", "the most recently PERFORMED wash decides");
    assert.strictEqual((await store.listWashes({ e164: NUMBER })).length, 2, "and both stay auditable");
  });

  it("an OLDER wash imported later cannot displace a newer one", async () => {
    // Paperwork arrives out of order: a June wash is filed after an August one.
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(1), results: [{ e164: NUMBER, result: "listed" }] }), now });
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(25), batchRef: "old-paperwork", results: [{ e164: NUMBER, result: "not_listed" }] }), now });

    const wash = await hydrateWashStore({ store, now });
    assert.strictEqual(wash.assess(NUMBER).result, "listed", "the newest EVENT decides, not the newest filing");
    assert.strictEqual(wash.assess(NUMBER).washedAt, daysAgo(1));
  });

  it("the authoritative single-number read agrees with the hydrated index", async () => {
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(20) }), now });
    await importWashResults({ store, batch: batch({ washedAt: daysAgo(2), batchRef: "newer", results: [{ e164: NUMBER, result: "listed" }] }), now });

    const latest = await store.latestWashFor(NUMBER);
    assert.strictEqual(latest.result, "listed");
    assert.strictEqual(latest.washedAt, daysAgo(2));
    assert.strictEqual((await hydrateWashStore({ store, now })).assess(NUMBER).result, latest.result);
  });

  it("history is kept — three washes, three rows", async () => {
    const store = createInMemoryAcquisitionStore();
    for (const [days, result] of [[25, "not_listed"], [15, "listed"], [2, "not_listed"]]) {
      await importWashResults({ store, batch: batch({ washedAt: daysAgo(days), batchRef: `run-${days}`, results: [{ e164: NUMBER, result }] }), now });
    }
    const rows = await store.listWashes({ e164: NUMBER });
    assert.strictEqual(rows.length, 3, "a wash ledger is a history, not a current value");
  });
});

// ── Malformed and unattested input ──────────────────────────────────

describe("what an import refuses", () => {
  const rejected = async (over) => {
    const store = createInMemoryAcquisitionStore();
    const r = await importWashResults({ store, batch: batch(over), now });
    assert.strictEqual(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
    assert.strictEqual((await store.listWashes({})).length, 0, "a refused import must write nothing");
    return r;
  };

  it("a wash dated in the future", async () => {
    const r = await rejected({ washedAt: new Date(AT.getTime() + DAY).toISOString() });
    assert.strictEqual(r.code, "washed_at_future");
  });

  it("a wash with no date at all", async () => {
    assert.strictEqual((await rejected({ washedAt: "sometime last week" })).code, "washed_at_invalid");
  });

  it("a wash nobody attested", async () => {
    assert.strictEqual((await rejected({ attestedBy: "   " })).code, "attestation_missing");
    assert.strictEqual((await rejected({ attestedBy: null })).code, "attestation_missing");
  });

  it("an empty batch", async () => {
    assert.strictEqual((await rejected({ results: [] })).code, "results_missing");
  });

  it("a result that is neither listed nor not_listed", async () => {
    assert.strictEqual((await rejected({ results: [{ e164: NUMBER, result: "probably fine" }] })).code, "results_invalid");
  });

  it("a number that is not a number", async () => {
    assert.strictEqual((await rejected({ results: [{ e164: "not a phone", result: "not_listed" }] })).code, "results_invalid");
  });

  it("ONE bad row rejects the WHOLE batch — a half-applied wash is worse than none", async () => {
    const r = await rejected({
      results: [
        { e164: NUMBER, result: "not_listed" },
        { e164: "+61355501099", result: "maybe" },
      ],
    });
    assert.strictEqual(r.code, "results_invalid");
    assert.match(r.message, /nothing was imported/);
  });
});

// ── Number formatting drift ─────────────────────────────────────────

describe("a wash is recorded against a telephone, not a spelling of one", () => {
  it("every spelling of the same number canonicalises to one key", () => {
    for (const spelling of ["(03) 5550 1042", "03 5550 1042", "+61 3 5550 1042", "0355501042"]) {
      assert.strictEqual(canonicalNumber(spelling), NUMBER, `${spelling} must canonicalise to ${NUMBER}`);
    }
  });

  it("a wash imported in one format is found when looked up in another", async () => {
    const store = createInMemoryAcquisitionStore();
    await importWashResults({ store, batch: batch({ results: [{ e164: "(03) 5550 1042", result: "not_listed" }] }), now });
    const wash = await hydrateWashStore({ store, now });
    assert.strictEqual(wash.assess(NUMBER).result, "not_listed", "the stored key must be canonical");
  });

  it("the same number spelled two ways in one file is one wash, not two", async () => {
    const store = createInMemoryAcquisitionStore();
    const r = await importWashResults({
      store,
      batch: batch({ results: [{ e164: "(03) 5550 1042", result: "not_listed" }, { e164: "+61355501042", result: "not_listed" }] }),
      now,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await store.listWashes({ e164: NUMBER })).length, 1, "one telephone, one wash row");
    assert.strictEqual(r.duplicates, 1);
  });
});

// ── Fail closed ─────────────────────────────────────────────────────

describe("when the wash ledger cannot be read", () => {
  const brokenStore = { listWashes: async () => { throw new Error("connection refused"); } };

  it("hydration yields an UNAVAILABLE store, never an empty one", async () => {
    const wash = await hydrateWashStore({ store: brokenStore, now });
    assert.strictEqual(wash.available, false);
    const a = wash.assess(NUMBER);
    assert.strictEqual(a.unavailable, true, "this is a fault in the system, not a fact about the number");
    assert.strictEqual(a.usable, false);
    assert.match(a.reason, /could not be read/);
  });

  it("an unavailable store refuses to be written to", async () => {
    const wash = unavailableWashStore("the ledger is unreachable.");
    assert.strictEqual(wash.wash(NUMBER).ok, false);
    assert.strictEqual(wash.importResults({}).ok, false, "a store that could not read must not appear to accept an import");
  });

  it("a missing store is unavailable, not empty", async () => {
    assert.strictEqual((await hydrateWashStore({ store: null, now })).available, false);
    assert.strictEqual((await hydrateWashStore({ store: { listWashes: async () => null }, now })).available, false);
  });

  it("eligibility names it dncr_store_unavailable rather than 'never checked'", () => {
    const engine = createEligibilityEngine({ now, washStore: unavailableWashStore("the ledger is unreachable.") });
    const d = engine.evaluate(
      { prospectId: "p1", businessName: "B", timezone: "Australia/Melbourne", lifecycle: "review_approved", phones: [{ raw: "(03) 5550 1042" }], sourceRefs: [] },
      {}
    );
    const dncr = d.failedChecks.find((f) => f.check === "dncr");
    assert.ok(dncr, "an unreadable ledger must block");
    assert.strictEqual(dncr.code, ELIGIBILITY_CODES.DNCR_UNAVAILABLE);
    assert.notStrictEqual(dncr.code, ELIGIBILITY_CODES.DNCR_UNKNOWN, "'we could not look' is not 'nobody has looked'");
    assert.match(dncr.requiredFounderAction, /Restore access/);
  });

  it("importing into a store that cannot write is refused", async () => {
    const r = await importWashResults({ store: {}, batch: batch(), now });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "store_unavailable");
  });
});

// ── The DNCR gate, every state, offline ─────────────────────────────
//
// The live proof in scripts/dev/acquisition-dncr-proof/ covers the two states
// dev's single fictional row can actually be in — fresh and, at a later
// evaluation instant, stale. The rest are pinned here rather than by writing
// more rows to dev: a `listed` row in particular would be permanent, and there
// is no reason to keep one when a fixture proves the same thing.

describe("what the DNCR gate does in each state", () => {
  const PHONE = "(03) 5550 1042";

  function gate(washStore, at = AT) {
    const engine = createEligibilityEngine({ now: () => at, washStore });
    const decision = engine.evaluate(
      {
        prospectId: "pr_gate_probe",
        businessName: "Gate Probe Locksmiths",
        timezone: "Australia/Melbourne",
        lifecycle: "review_approved",
        phones: [{ raw: PHONE }],
        sourceRefs: [],
      },
      {}
    );
    return {
      failed: (decision.failedChecks || []).find((f) => f.check === "dncr"),
      passed: (decision.passedChecks || []).includes("dncr"),
      decision,
    };
  }

  it("store unavailable => dncr_store_unavailable", () => {
    const g = gate(unavailableWashStore("the ledger is unreachable."));
    assert.strictEqual(g.failed.code, ELIGIBILITY_CODES.DNCR_UNAVAILABLE);
  });

  it("no durable row => dncr_not_checked", async () => {
    const empty = await hydrateWashStore({ store: createInMemoryAcquisitionStore(), now });
    assert.strictEqual(empty.available, true, "an empty ledger is readable — it just holds nothing");
    const g = gate(empty);
    assert.strictEqual(g.failed.code, ELIGIBILITY_CODES.DNCR_UNKNOWN);
  });

  it("a stale row => dncr_wash_stale, and asks for another wash", async () => {
    const { wash } = await persistedThenHydrated({}, { clock: clockAt(DNCR_WASH_VALIDITY_DAYS + 5) });
    const g = gate(wash, new Date(AT.getTime() + (DNCR_WASH_VALIDITY_DAYS + 5) * DAY));
    assert.strictEqual(g.failed.code, ELIGIBILITY_CODES.DNCR_STALE);
    assert.match(g.failed.requiredFounderAction, /again/i);
  });

  it("listed => blocked, permanently, on the number itself", async () => {
    const { wash } = await persistedThenHydrated({ results: [{ e164: PHONE, result: "listed" }] });
    const g = gate(wash);
    assert.strictEqual(g.failed.code, ELIGIBILITY_CODES.DNCR_LISTED);
    assert.strictEqual(g.failed.temporary, false, "being on the Register is not a delay");
  });

  it("a fresh authoritative not_listed clears the DNCR gate — and ONLY that gate", async () => {
    const { wash } = await persistedThenHydrated({ results: [{ e164: PHONE, result: "not_listed" }] });
    const g = gate(wash);

    assert.strictEqual(g.passed, true, "the DNCR check passes");
    assert.ok(!g.failed, "and contributes no failure");

    // The point: clearing DNCR is not clearing anything else. This prospect is
    // still refused, by every other gate that has not been satisfied, and a
    // cleared wash must never read as permission to call.
    assert.strictEqual(g.decision.eligible, false, "one gate passing is not eligibility");
    const stillFailing = g.decision.failedChecks.map((f) => f.check);
    for (const check of ["suppression", "duplicate", "policy_approval", "batch_approval"]) {
      assert.ok(stillFailing.includes(check), `${check} must still be refusing`);
    }
    assert.ok(!stillFailing.includes("dncr"), "dncr is the only one the wash was allowed to settle");
  });
});

// ── Safety: no live DNCR anything ───────────────────────────────────

describe("M8K is storage and import only", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-dncr"), "utf8");

  it("there is no live mode, and no way to ask for one", () => {
    assert.ok(!/["']live["']/.test(src.replace(/^\s*\/\/.*$/gm, "")), "a live mode must not exist even as a string");
    const store = createWashStore({ now, mode: "live" });
    assert.strictEqual(store.mode, "disabled", "an unrecognised mode falls back to disabled, which vetoes everything");
  });

  it("reaches no network and no provider", () => {
    for (const forbidden of ["fetch(", "axios", "soap", "sftp", "ftp:", "https://", 'require("http', "require('http", "twilio"]) {
      assert.ok(!src.includes(forbidden), `the DNCR module must not reference ${forbidden}`);
    }
  });

  it("assumes no credentials, account or endpoint", () => {
    // Comments stripped: the module DISCUSSES credentials at length, in order
    // to say it holds none. What must not appear is executable code reading one.
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    for (const forbidden of ["DNCR_API_KEY", "DNCR_USERNAME", "DNCR_PASSWORD", "DNCR_ENDPOINT", "DNCR_URL", "apiKey", "credential"]) {
      assert.ok(!code.includes(forbidden), `M8K must not assume ${forbidden}`);
    }
  });

  it("imports nothing that is not local", () => {
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      assert.ok(/require\(["']\.{1,2}\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });

  it("disabled mode records nothing and clears nobody", () => {
    const store = createWashStore({ now, mode: "disabled" });
    assert.strictEqual(store.wash(NUMBER).result, "unknown");
    assert.strictEqual(store.count(), 0);
    assert.strictEqual(store.assess(NUMBER).usable, false);
  });

  it("a fixture wash is never authoritative, however fresh", () => {
    const store = createWashStore({ now, mode: "fixture" });
    store.wash(NUMBER);
    const a = store.assess(NUMBER);
    assert.strictEqual(a.fresh, true);
    assert.strictEqual(a.authoritative, false, "test data must never be presentable as a real wash");
  });
});
