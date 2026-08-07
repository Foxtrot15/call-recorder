// LOCKSMITH ACQUISITION — the Do Not Call Register wash port.
//
// Backfilled in M8B. Exercised only through eligibility until now.
//
// The invariant this file exists for: UNKNOWN MUST NEVER READ AS CLEAR. Every
// way of not knowing — never washed, wash switched off, wash expired, wash
// dated in the future — has to come back unusable. A single path where absence
// of a "listed" result is treated as permission is a call to somebody on the
// Register.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createWashStore, validateImportRecord, FIXTURE_REGISTER, DNCR_WASH_VALIDITY_DAYS } = require("../src/services/acquisition-dncr");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;
const DAY = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(AT.getTime() - n * DAY).toISOString();

const NUMBER = "+61355501042";

const importBatch = (overrides = {}) => ({
  washedAt: daysAgo(1),
  batchRef: "test-batch",
  attestedBy: "Peter Dang",
  results: [{ e164: NUMBER, result: "not_listed" }],
  ...overrides,
});

// ── Unknown fails closed ────────────────────────────────────────────

describe("unknown never reads as clear", () => {
  it("a number that was never washed is unknown and unusable", () => {
    const store = createWashStore({ now, mode: "import" });
    const result = store.assess(NUMBER, { at: AT });
    assert.strictEqual(result.result, "unknown");
    assert.strictEqual(result.usable, false);
    assert.strictEqual(result.fresh, false);
    assert.notStrictEqual(result.result, "not_listed", "absence of a listing is not a clearance");
  });

  it("with the check switched off, every number is unknown — not clear", () => {
    const store = createWashStore({ now, mode: "disabled" });
    const result = store.assess(NUMBER, { at: AT });
    assert.strictEqual(result.result, "unknown");
    assert.strictEqual(result.usable, false);
    assert.match(result.reason, /switched off/);
  });

  it("switching the check off cannot be a way to make numbers callable", () => {
    // The tempting bug: "the DNCR check is disabled, so skip it" reads as
    // permission. It must read as "we have not checked".
    const disabled = createWashStore({ now, mode: "disabled" });
    assert.strictEqual(disabled.wash(NUMBER).result, "unknown");
    assert.strictEqual(disabled.assess(NUMBER, { at: AT }).usable, false);
  });

  it("an unparseable mode resolves to disabled rather than to something permissive", () => {
    for (const mode of ["live", "LIVE", "enabled", "yes", "", "true"]) {
      const store = createWashStore({ now, mode });
      assert.strictEqual(store.assess(NUMBER, { at: AT }).usable, false, `mode "${mode}" must not clear anything`);
    }
  });

  it("there is no live mode to fall into", () => {
    assert.ok(!S.DNCR_RESULTS.includes("live"));
    const store = createWashStore({ now, mode: "live" });
    assert.notStrictEqual(store.mode, "live");
    assert.throws(() => store.assertLiveWashUnavailable(), /./, "the live path must be an explicit, loud failure");
  });

  it("an unknown result is a distinct label from a clean one", () => {
    assert.notStrictEqual(S.DNCR_RESULT_LABELS.unknown, S.DNCR_RESULT_LABELS.not_listed);
    assert.match(S.DNCR_RESULT_LABELS.unknown, /Not checked/);
  });
});

// ── Freshness decays to unknown, not to its last value ──────────────

describe("a wash expires into unknown", () => {
  const stored = () => {
    const store = createWashStore({ now, mode: "import" });
    const result = store.importResults(importBatch({ washedAt: daysAgo(2) }));
    assert.strictEqual(result.ok, true, result.message);
    return store;
  };

  it("a fresh wash is usable", () => {
    const result = stored().assess(NUMBER, { at: AT });
    assert.strictEqual(result.result, "not_listed");
    assert.strictEqual(result.usable, true);
    assert.strictEqual(result.fresh, true);
  });

  it("an expired wash decays to unknown, not to its last answer", () => {
    // Decaying to "not_listed" would silently authorise calls on evidence that
    // expired — the whole point of a validity period.
    const later = new Date(AT.getTime() + (DNCR_WASH_VALIDITY_DAYS + 1) * DAY);
    const result = stored().assess(NUMBER, { at: later });
    assert.strictEqual(result.result, "unknown");
    assert.strictEqual(result.usable, false);
    assert.strictEqual(result.priorResult, "not_listed", "the prior answer is reported, but is not the answer");
    assert.match(result.reason, /has to be done again/);
  });

  it("the boundary is the validity period, evaluated at the instant asked about", () => {
    const store = createWashStore({ now, mode: "import" });
    store.importResults(importBatch({ washedAt: AT.toISOString() }));

    const justInside = new Date(AT.getTime() + (DNCR_WASH_VALIDITY_DAYS - 1) * DAY + 1000);
    const justOutside = new Date(AT.getTime() + DNCR_WASH_VALIDITY_DAYS * DAY + 1000);
    assert.strictEqual(store.assess(NUMBER, { at: justInside }).usable, true);
    assert.strictEqual(store.assess(NUMBER, { at: justOutside }).usable, false);
  });

  it("a scheduler asking about next month is told about next month, not today", () => {
    // The documented property: assess(e164, { at }) takes the instant being
    // asked about, so "can this be called on the 20th?" is answered for the 20th.
    const store = stored();
    assert.strictEqual(store.assess(NUMBER, { at: AT }).usable, true);
    assert.strictEqual(store.assess(NUMBER, { at: new Date(AT.getTime() + 60 * DAY) }).usable, false);
  });

  it("a wash dated in the future is not fresh", () => {
    const store = createWashStore({ now, mode: "import" });
    store.importResults(importBatch({ washedAt: daysAgo(1) }));
    // Asked about an instant BEFORE the wash happened: negative age must not
    // pass a "less than 30 days old" test.
    const before = new Date(AT.getTime() - 5 * DAY);
    assert.strictEqual(store.assess(NUMBER, { at: before }).usable, false);
  });
});

// ── Listed always vetoes ────────────────────────────────────────────

describe("a listed number is a veto", () => {
  it("reports listed, and never as usable-and-clear", () => {
    const store = createWashStore({ now, mode: "import" });
    store.importResults(importBatch({ results: [{ e164: NUMBER, result: "listed" }] }));
    const result = store.assess(NUMBER, { at: AT });
    assert.strictEqual(result.result, "listed");
    assert.strictEqual(result.resultLabel, S.DNCR_RESULT_LABELS.listed);
  });

  it("the fixture register is a list of numbers, all in +61 form", () => {
    assert.ok(FIXTURE_REGISTER.length > 0);
    for (const n of FIXTURE_REGISTER) assert.match(n, /^\+61\d{6,12}$/);
  });

  it("fixture mode returns listed for a number on the fixture register", () => {
    const store = createWashStore({ now, mode: "fixture" });
    const listed = store.wash(FIXTURE_REGISTER[0]);
    assert.strictEqual(listed.result, "listed");
  });

  it("a fixture result is never authoritative, whatever it says", () => {
    const store = createWashStore({ now, mode: "fixture" });
    store.wash(FIXTURE_REGISTER[0]);
    store.wash(NUMBER);
    assert.strictEqual(store.assess(FIXTURE_REGISTER[0], { at: AT }).authoritative, false);
    assert.strictEqual(store.assess(NUMBER, { at: AT }).authoritative, false);
  });
});

// ── Imports are checked hard ────────────────────────────────────────

describe("importing wash results", () => {
  it("only works in import mode", () => {
    for (const mode of ["disabled", "fixture"]) {
      const result = createWashStore({ now, mode }).importResults(importBatch());
      assert.strictEqual(result.ok, false, `${mode} must not accept an import`);
      assert.strictEqual(result.code, "not_import_mode");
    }
  });

  it("requires who attests that these are real results", () => {
    // Without it an imported file is indistinguishable from a made-up one.
    const store = createWashStore({ now, mode: "import" });
    for (const attestedBy of [null, undefined, "", "   ", 42]) {
      const result = store.importResults(importBatch({ attestedBy }));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, "attestation_missing");
    }
  });

  it("requires when the wash was actually performed", () => {
    const store = createWashStore({ now, mode: "import" });
    assert.strictEqual(store.importResults(importBatch({ washedAt: null })).code, "washed_at_invalid");
    assert.strictEqual(store.importResults(importBatch({ washedAt: "last Tuesday" })).code, "washed_at_invalid");
  });

  it("refuses a wash claimed to have happened in the future", () => {
    const store = createWashStore({ now, mode: "import" });
    const result = store.importResults(importBatch({ washedAt: new Date(AT.getTime() + DAY).toISOString() }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "washed_at_future");
  });

  it("imports nothing at all when any record is unreadable", () => {
    // A partially-applied import leaves some numbers washed and some not, with
    // no record of which — worse than a rejected one.
    const store = createWashStore({ now, mode: "import" });
    const result = store.importResults(importBatch({ results: [{ e164: NUMBER, result: "not_listed" }, { e164: "0355501042", result: "not_listed" }] }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "results_invalid");
    assert.strictEqual(store.count(), 0, "nothing may have been stored");
    assert.strictEqual(store.assess(NUMBER, { at: AT }).usable, false);
  });

  it("refuses an empty import rather than reporting success over nothing", () => {
    assert.strictEqual(createWashStore({ now, mode: "import" }).importResults(importBatch({ results: [] })).code, "results_missing");
  });

  it("validates each record: +61 form and a real result", () => {
    assert.strictEqual(validateImportRecord({ e164: NUMBER, result: "not_listed" }).ok, true);
    assert.strictEqual(validateImportRecord({ e164: NUMBER, result: "listed" }).ok, true);
    for (const bad of [null, "x", { e164: "0355501042", result: "listed" }, { e164: NUMBER, result: "unknown" }, { e164: NUMBER, result: "maybe" }, { e164: "+1415555010", result: "listed" }]) {
      assert.strictEqual(validateImportRecord(bad).ok, false, `${JSON.stringify(bad)} should not validate`);
    }
  });

  it("an imported result IS authoritative — a person attested to it", () => {
    const store = createWashStore({ now, mode: "import" });
    store.importResults(importBatch());
    assert.strictEqual(store.assess(NUMBER, { at: AT }).authoritative, true);
  });

  it("audits the import against the person who attested to it", () => {
    const rows = [];
    const store = createWashStore({ now, mode: "import", audit: { record: (r) => rows.push(r) } });
    store.importResults(importBatch({ results: [{ e164: NUMBER, result: "listed" }] }));
    const row = rows.find((r) => r.event === "dncr_results_imported");
    assert.ok(row);
    assert.strictEqual(row.actor, "Peter Dang");
    assert.strictEqual(row.actorKind, "human");
    assert.strictEqual(row.detail.listed, 1);
  });
});

// ── Construction and safety ─────────────────────────────────────────

describe("construction and safety", () => {
  it("refuses to exist without a clock, so freshness is deterministic", () => {
    assert.throws(() => createWashStore({}), /injected now/);
  });

  it("refuses a number that is not in +61 form rather than guessing", () => {
    const store = createWashStore({ now, mode: "fixture" });
    for (const bad of ["0355501042", "355501042", "", null, 42, "+1 415 555 0100"]) {
      assert.strictEqual(store.wash(bad).ok, false, `${bad} should be refused`);
    }
  });

  it("reaches no network and imports nothing that is not local", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-dncr"), "utf8");
    for (const forbidden of ["fetch(", "axios", 'require("http', "require('http", "https://", "XMLHttpRequest"]) {
      assert.ok(!src.includes(forbidden), `the wash port must not reference ${forbidden}`);
    }
    for (const m of src.match(/require\(["'][^"']+["']\)/g) || []) {
      // `./` and `../` are both local — the wash port reads ../config/acquisition
      // for the mode resolution and the offline-boundary assertion.
      assert.ok(/require\(["']\.{1,2}\//.test(m) || /node:/.test(m), `${m} is not a local or core require`);
    }
  });

  it("returns frozen assessments", () => {
    const store = createWashStore({ now, mode: "import" });
    store.importResults(importBatch());
    const result = store.assess(NUMBER, { at: AT });
    assert.ok(Object.isFrozen(result));
    assert.throws(() => {
      "use strict";
      result.usable = true;
    });
  });

  it("the statutory validity period is 30 days, as the Act requires", () => {
    assert.strictEqual(DNCR_WASH_VALIDITY_DAYS, 30);
  });
});
