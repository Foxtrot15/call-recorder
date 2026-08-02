// AIDA Locksmith Acquisition — the public-holiday provider interface (A2).
//
//   createFixtureHolidayProvider({ regions })   deterministic, in-repo
//   createNullHolidayProvider()                 knows nothing, covers nothing
//   describeCoverage(provider)                  what a human should be told
//
// The calling-policy gate must not dial on a public holiday
// (docs/OUTBOUND_BDM_ARCHITECTURE.md §2.2, G10). That requires knowing which
// dates are holidays, which is data this repository does not otherwise have —
// there is no holiday dataset, no holiday dependency, and no upstream service
// the acquisition engine is allowed to call.
//
// SO THIS IS AN INTERFACE, NOT A DATASET.
// A provider answers two questions and nothing else:
//
//   coverage            { from, to } — the INCLUSIVE range of local dates this
//                       provider actually knows about. Outside it, it does not
//                       guess.
//   isHoliday(date, region)  { known, holiday, name } for a "YYYY-MM-DD" local
//                       date string.
//
// `known: false` is a first-class answer, and the calling-policy gate treats it
// as a REFUSAL TO DIAL, not as "probably fine". That is the whole reason
// coverage is explicit: a holiday calendar that silently returns "not a
// holiday" for every date it has never heard of is worse than no calendar,
// because it produces confident wrong answers on exactly the dates nobody
// loaded — next year's.
//
// NO NETWORK. A provider is pure data plus a lookup. The dispatch decision must
// never depend on an outbound request; see the offline boundary in
// src/config/acquisition.js.
//
// WHEN REAL DATA ARRIVES
// Swap the fixture for a provider backed by an authoritative source (the
// data.gov.au Australian public holidays dataset, or a maintained library) that
// implements the same two methods. Nothing in the calling-policy gate changes.
// Until then the fixture below is clearly labelled as a fixture and covers one
// year only, so the fail-closed path is exercised in normal use rather than
// being dead code nobody has run.
//
// Pure + dep-free. See test/acquisition-calling-policy.test.js.

// ── The fixture calendar ────────────────────────────────────────────
//
// Australian national holidays plus Victorian state holidays for 2026 — the
// pilot region is Melbourne, so VIC is the only state calendar carried.
//
// PROVENANCE AND LIMITATIONS, stated plainly because this is compliance data:
//   * Compiled by hand for the pilot. It is NOT sourced from an authoritative
//     feed and has NOT been checked by anyone with legal responsibility.
//   * Dates that move year to year (Easter, the AFL Grand Final Friday, Melbourne
//     Cup) are the ones most likely to be wrong or to change by proclamation.
//   * The AFL Grand Final Friday holiday is proclaimed each year and its 2026
//     date is not fixed at time of writing, so it is DELIBERATELY ABSENT rather
//     than guessed. A guessed holiday would be a call placed on a real one.
//   * Coverage is 2026 only. From 1 January 2027 this provider answers
//     `known: false` and the calling-policy gate refuses to dial. That is
//     intentional: the calendar expiring should stop calls, loudly, not degrade
//     into calling on Christmas Day 2027.
const FIXTURE_HOLIDAYS_2026 = Object.freeze({
  // ── National ──
  "2026-01-01": { name: "New Year's Day", scope: "national" },
  "2026-01-26": { name: "Australia Day", scope: "national" },
  "2026-04-03": { name: "Good Friday", scope: "national" },
  "2026-04-04": { name: "Easter Saturday", scope: "vic" },
  "2026-04-05": { name: "Easter Sunday", scope: "vic" },
  "2026-04-06": { name: "Easter Monday", scope: "national" },
  "2026-04-25": { name: "Anzac Day", scope: "national" },
  "2026-12-25": { name: "Christmas Day", scope: "national" },
  "2026-12-26": { name: "Boxing Day", scope: "national" },
  "2026-12-28": { name: "Boxing Day (observed)", scope: "national" },

  // ── Victoria ──
  "2026-03-09": { name: "Labour Day", scope: "vic" },
  "2026-06-08": { name: "King's Birthday", scope: "vic" },
  "2026-11-03": { name: "Melbourne Cup Day", scope: "vic" },
});

const FIXTURE_COVERAGE = Object.freeze({ from: "2026-01-01", to: "2026-12-31" });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A deterministic provider over the fixture calendar above.
 *
 * @param {string[]} [regions]  which scopes count. Defaults to national + VIC,
 *                              the pilot region. A prospect in another state
 *                              would need that state's calendar loaded; asking
 *                              for a scope this provider does not carry is a
 *                              coverage failure, not a silent "no holiday".
 */
function createFixtureHolidayProvider({ regions = ["national", "vic"] } = {}) {
  const scopes = new Set(regions.map((r) => String(r).toLowerCase()));

  return Object.freeze({
    name: "fixture-2026",
    // Surfaced so a decision can say out loud that its holiday data is a
    // hand-compiled fixture rather than an authoritative feed.
    authoritative: false,
    coverage: FIXTURE_COVERAGE,
    regions: Object.freeze([...scopes]),

    isHoliday(localDate) {
      if (typeof localDate !== "string" || !DATE_PATTERN.test(localDate)) {
        return { known: false, holiday: false, name: null, reason: "That is not a date this provider can read." };
      }
      if (localDate < FIXTURE_COVERAGE.from || localDate > FIXTURE_COVERAGE.to) {
        return {
          known: false,
          holiday: false,
          name: null,
          reason: `The public-holiday calendar only covers ${FIXTURE_COVERAGE.from} to ${FIXTURE_COVERAGE.to}, so we do not know whether ${localDate} is a public holiday.`,
        };
      }
      const entry = FIXTURE_HOLIDAYS_2026[localDate];
      if (!entry || !scopes.has(entry.scope)) return { known: true, holiday: false, name: null };
      return { known: true, holiday: true, name: entry.name, scope: entry.scope };
    },
  });
}

/**
 * A provider that knows nothing and admits it.
 *
 * Every date is `known: false`, so the calling-policy gate refuses to dial on
 * any date at all. This is the correct default for a deployment that has not
 * been given a holiday calendar — and it is what the gate falls back to when no
 * provider is injected, so forgetting to supply one stops calls rather than
 * quietly disabling the holiday check.
 */
function createNullHolidayProvider() {
  return Object.freeze({
    name: "none",
    authoritative: false,
    coverage: null,
    regions: Object.freeze([]),
    isHoliday(localDate) {
      return {
        known: false,
        holiday: false,
        name: null,
        reason: `No public-holiday calendar has been loaded, so we cannot tell whether ${localDate} is a public holiday.`,
      };
    },
  });
}

/** One sentence about what a provider does and does not know. */
function describeCoverage(provider) {
  if (!provider || !provider.coverage) return "No public-holiday calendar is loaded, so no date can be cleared for calling.";
  return (
    `Public holidays are checked against the "${provider.name}" calendar, which covers ` +
    `${provider.coverage.from} to ${provider.coverage.to}` +
    `${provider.authoritative ? "" : " and is a hand-compiled fixture, not an authoritative feed"}.`
  );
}

module.exports = {
  createFixtureHolidayProvider,
  createNullHolidayProvider,
  describeCoverage,
  FIXTURE_HOLIDAYS_2026,
  FIXTURE_COVERAGE,
};
