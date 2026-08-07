// LOCKSMITH ACQUISITION — the public-holiday provider.
//
// Backfilled in M8B. Exercised only through the calling policy until now.
//
// This is an INTERFACE with two implementations and a hand-compiled fixture
// behind one of them, so the tests are mostly about what it refuses to claim:
// a date outside coverage, a state it does not carry, and a calendar that has
// run out must all answer `known: false`, which the gate reads as "do not
// call". Answering "not a holiday" to any of them is a call on Christmas Day.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createFixtureHolidayProvider, createNullHolidayProvider, describeCoverage, FIXTURE_HOLIDAYS_2026, FIXTURE_COVERAGE } = require("../src/services/acquisition-holidays");

// ── The two implementations satisfy one contract ────────────────────

describe("both providers satisfy the same interface", () => {
  const providers = [
    ["fixture", createFixtureHolidayProvider()],
    ["null", createNullHolidayProvider()],
  ];

  for (const [label, provider] of providers) {
    it(`${label}: exposes name, authoritative, coverage, regions and isHoliday`, () => {
      assert.strictEqual(typeof provider.name, "string");
      assert.strictEqual(typeof provider.authoritative, "boolean");
      assert.ok("coverage" in provider);
      assert.ok(Array.isArray(provider.regions));
      assert.strictEqual(typeof provider.isHoliday, "function");
    });

    it(`${label}: every answer carries known, holiday and name`, () => {
      const answer = provider.isHoliday("2026-06-15");
      for (const key of ["known", "holiday", "name"]) assert.ok(key in answer, `${label} omitted ${key}`);
      assert.strictEqual(typeof answer.known, "boolean");
      assert.strictEqual(typeof answer.holiday, "boolean");
    });

    it(`${label}: is not authoritative — neither has been checked by anyone responsible`, () => {
      assert.strictEqual(provider.authoritative, false);
    });

    it(`${label}: never answers holiday:true while known:false`, () => {
      // "We do not know, and also it is a holiday" is not a coherent answer,
      // and a caller reading only one of the two fields would be misled.
      for (const date of ["2026-01-01", "2026-06-15", "2027-06-15", "not a date", "2025-12-25"]) {
        const a = provider.isHoliday(date);
        if (!a.known) assert.strictEqual(a.holiday, false, `${label} claimed a holiday it does not know about on ${date}`);
      }
    });
  }
});

// ── The null provider is the safe default ───────────────────────────

describe("the null provider knows nothing, loudly", () => {
  const provider = createNullHolidayProvider();

  it("answers known:false for every date, including ordinary ones", () => {
    for (const date of ["2026-06-15", "2026-12-25", "2026-01-01", "1999-01-01"]) {
      const a = provider.isHoliday(date);
      assert.strictEqual(a.known, false, `${date} should be unknown`);
      assert.strictEqual(a.holiday, false);
      assert.match(a.reason, /No public-holiday calendar/);
    }
  });

  it("this is why forgetting to wire a calendar stops calls rather than disabling the check", () => {
    // The gate's default provider. If it answered "not a holiday", omitting the
    // calendar would silently remove the holiday check altogether.
    assert.strictEqual(provider.coverage, null);
    assert.deepStrictEqual([...provider.regions], []);
  });
});

// ── The fixture calendar ────────────────────────────────────────────

describe("the fixture calendar", () => {
  const vic = createFixtureHolidayProvider({ regions: ["national", "vic"] });

  it("knows the national holidays in its coverage", () => {
    for (const [date, name] of [["2026-01-01", "New Year's Day"], ["2026-01-26", "Australia Day"], ["2026-04-25", "Anzac Day"], ["2026-12-25", "Christmas Day"]]) {
      const a = vic.isHoliday(date);
      assert.strictEqual(a.known, true, `${date} should be known`);
      assert.strictEqual(a.holiday, true, `${date} should be a holiday`);
      assert.strictEqual(a.name, name);
    }
  });

  it("knows an ordinary day is an ordinary day", () => {
    const a = vic.isHoliday("2026-06-15");
    assert.strictEqual(a.known, true);
    assert.strictEqual(a.holiday, false);
  });

  it("carries only the state calendars it was asked for", () => {
    // A Victorian holiday must not block New South Wales, and a provider built
    // without vic must not report Melbourne Cup Day.
    const national = createFixtureHolidayProvider({ regions: ["national"] });
    assert.strictEqual(vic.isHoliday("2026-11-03").holiday, true, "Melbourne Cup Day is a Victorian holiday");
    assert.strictEqual(national.isHoliday("2026-11-03").holiday, false, "…and is not a national one");
    assert.strictEqual(national.isHoliday("2026-11-03").known, true, "it is a known non-holiday for that scope, not an unknown");
  });

  it("every state-scoped entry is genuinely scoped, not silently national", () => {
    const national = createFixtureHolidayProvider({ regions: ["national"] });
    for (const [date, entry] of Object.entries(FIXTURE_HOLIDAYS_2026)) {
      if (entry.scope === "national") continue;
      assert.strictEqual(national.isHoliday(date).holiday, false, `${date} (${entry.name}) is scoped "${entry.scope}" but a national-only provider reported it`);
    }
  });
});

// ── Running out of calendar is a refusal, not a clearance ───────────

describe("the calendar expiring stops calls rather than degrading", () => {
  const vic = createFixtureHolidayProvider();

  it("a date after coverage ends is unknown", () => {
    const a = vic.isHoliday("2027-01-05");
    assert.strictEqual(a.known, false);
    assert.strictEqual(a.holiday, false);
    assert.match(a.reason, /only covers/);
  });

  it("Christmas Day 2027 is unknown, not 'not a holiday'", () => {
    // The specific accident the design exists to prevent.
    const a = vic.isHoliday("2027-12-25");
    assert.strictEqual(a.known, false, "a lapsed calendar must never clear Christmas Day");
  });

  it("a date before coverage begins is unknown too", () => {
    assert.strictEqual(vic.isHoliday("2025-12-25").known, false);
  });

  it("the boundaries themselves are inside coverage", () => {
    assert.strictEqual(vic.isHoliday(FIXTURE_COVERAGE.from).known, true);
    assert.strictEqual(vic.isHoliday(FIXTURE_COVERAGE.to).known, true);
  });

  it("an unreadable date is unknown, never assumed ordinary", () => {
    for (const bad of ["", "tomorrow", "2026-13-45", "15/06/2026", null, undefined, 20260615, {}]) {
      const a = vic.isHoliday(bad);
      assert.strictEqual(a.known, false, `${JSON.stringify(bad)} should be unknown`);
      assert.strictEqual(a.holiday, false);
    }
  });
});

// ── The data itself ─────────────────────────────────────────────────

describe("the fixture data is honest about what it is", () => {
  it("every entry is a real date inside the declared coverage, with a name and a scope", () => {
    for (const [date, entry] of Object.entries(FIXTURE_HOLIDAYS_2026)) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${date} is not a date`);
      assert.ok(date >= FIXTURE_COVERAGE.from && date <= FIXTURE_COVERAGE.to, `${date} is outside the declared coverage`);
      assert.ok(entry.name && entry.name.length > 2, `${date} has no name`);
      assert.ok(entry.scope, `${date} has no scope`);
    }
  });

  it("the AFL Grand Final Friday is deliberately absent rather than guessed", () => {
    // Proclaimed annually; its 2026 date was not fixed at time of writing. A
    // guessed holiday is a call placed on a real one — and its absence means
    // that date is treated as ordinary, which is the documented trade (A-L3).
    const names = Object.values(FIXTURE_HOLIDAYS_2026).map((e) => e.name.toLowerCase());
    assert.ok(!names.some((n) => n.includes("grand final")), "a guessed Grand Final date would be worse than none");
  });

  it("describes itself as a fixture, so a decision can say so out loud", () => {
    const text = describeCoverage(createFixtureHolidayProvider());
    assert.match(text, /hand-compiled fixture/);
    assert.match(text, /not an authoritative feed/);
    assert.ok(text.includes(FIXTURE_COVERAGE.from) && text.includes(FIXTURE_COVERAGE.to));
  });

  it("describes the absence of a calendar as blocking, not as neutral", () => {
    const text = describeCoverage(createNullHolidayProvider());
    assert.match(text, /no date can be cleared for calling/);
    assert.strictEqual(describeCoverage(null), text, "a missing provider must read the same as an empty one");
  });
});

// ── Safety ──────────────────────────────────────────────────────────

describe("the provider is offline and deterministic", () => {
  it("the same date twice gives the same answer", () => {
    const vic = createFixtureHolidayProvider();
    assert.deepStrictEqual(vic.isHoliday("2026-11-03"), vic.isHoliday("2026-11-03"));
  });

  it("reaches no network and imports nothing that is not local", () => {
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-holidays"), "utf8");
    for (const forbidden of ["fetch(", "axios", 'require("http', "require('http", "https://", "data.gov.au/api"]) {
      assert.ok(!src.includes(forbidden), `the holiday provider must not reference ${forbidden}`);
    }
  });

  it("providers and their data are frozen", () => {
    assert.ok(Object.isFrozen(createFixtureHolidayProvider()));
    assert.ok(Object.isFrozen(createNullHolidayProvider()));
    assert.ok(Object.isFrozen(FIXTURE_COVERAGE));
    assert.ok(Object.isFrozen(FIXTURE_HOLIDAYS_2026));
  });
});
