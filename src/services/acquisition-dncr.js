// AIDA Locksmith Acquisition — the Do Not Call Register wash port (A2).
//
//   createWashStore({ now, mode, audit })
//   store.wash(e164)                 record a wash result for one number
//   store.importResults(batch)       load a wash a human performed out-of-band
//   store.assess(e164)               what we can rely on, right now
//
// The pipeline's seventh step is "DNCR wash performed". Under the Do Not Call
// Register Act 2006 and the Telemarketing and Research Calls Industry Standard
// 2017, an unsolicited telemarketing call to a number on the Register is
// prohibited unless the list was washed against the Register within the last
// 30 days and the number was absent (or consent/an exemption applies). See
// docs/OUTBOUND_BDM_ARCHITECTURE.md §2.2 — that document is the authority on
// the rule; this module is the mechanism.
//
// THERE IS NO LIVE CLIENT IN THIS BUILD.
// Three modes exist, and "live" is not one of them:
//
//   disabled  the default. Every wash returns "unknown". Because unknown is a
//             VETO downstream, a build that has not been configured for DNCR
//             cannot call anybody. That is the correct default, not a degraded
//             one — the failure direction has to be "nobody gets called".
//
//   fixture   a deterministic in-repo register, for tests and the dry run.
//             Results carry authoritative:false FOREVER, so a fixture result
//             can never be presented as, or mistaken for, a real wash.
//
//   import    results from a wash a human actually performed against the real
//             Register, loaded as data. This is how a real wash enters the
//             system without this process holding DNCR credentials or making a
//             network call.
//
// THREE SEPARATE THINGS, NEVER CONFLATED
//   1. "not_listed"  we washed, and the number was absent from the Register.
//   2. "listed"      we washed, and the number was present.
//   3. "unknown"     we have not washed, or the wash we hold cannot be relied
//                    upon any more.
// Collapsing (3) into (1) — treating "we never checked" as "it's fine" — is the
// single mistake that produces mass unlawful calling, so `unknown` is a
// first-class result with its own label and its own veto.
//
// FRESHNESS IS EVALUATED AT READ TIME, NOT AT WRITE TIME.
// assess() recomputes the age of the wash against the injected clock every time
// it is called. A wash that was fresh when a batch was assembled and stale by
// the time it is read comes back as unusable without anything having to
// re-write it. This is the W1 failure from the architecture doc's red-team, and
// it is why nothing caches a boolean "washed" flag.
//
// Pure + dep-free. See test/acquisition-dncr.test.js.

const S = require("./acquisition-schema");
const { DNCR_WASH_VALIDITY_DAYS, resolveDncrMode, assertExternalAccessAllowed } = require("../config/acquisition");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── The fixture register ────────────────────────────────────────────
//
// Numbers this fixture treats as being ON the Register. Every entry is one of
// the invented fixture businesses' fictional numbers (see
// acquisition-discovery-fixture.js) — no real number appears here.
const FIXTURE_REGISTER = Object.freeze([
  "+61355504488", // Dandenong Lock Centre — clean on evidence, vetoed here
  "+61355506612", // Geelong Lock Pros
]);

function isIsoInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Validate one imported wash record.
 * An import is the ONLY way a real result enters the system, so it is checked
 * hard: a malformed import that was accepted leniently would be worse than no
 * import at all, because it would look like evidence.
 */
function validateImportRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, message: "Each wash result must be an object." };
  }
  if (typeof record.e164 !== "string" || !/^\+61\d{6,12}$/.test(record.e164)) {
    return { ok: false, message: `"${String(record.e164).slice(0, 30)}" is not an Australian number in +61 form.` };
  }
  if (record.result !== "listed" && record.result !== "not_listed") {
    return { ok: false, message: `A wash result must be "listed" or "not_listed", not "${String(record.result).slice(0, 30)}".` };
  }
  return { ok: true };
}

/**
 * Create a wash store.
 *
 * @param {function} now     injected clock
 * @param {string}   [mode]  overrides the env-resolved mode (tests, dry run)
 * @param {object}   [audit] the append-only decision log
 * @param {object}   [env]
 */
function createWashStore({ now, mode = null, audit = null, env = process.env } = {}) {
  if (typeof now !== "function") {
    throw new Error("createWashStore requires an injected now() — wash freshness must be deterministic in tests.");
  }

  const resolved = mode ? { mode, faults: [] } : resolveDncrMode(env);
  const activeMode = ["disabled", "fixture", "import"].includes(resolved.mode) ? resolved.mode : "disabled";

  // e164 → the most recent wash record for that number.
  const records = new Map();

  function store(e164, result, { batchRef, washedAt, authoritative, importedFrom = null }) {
    const row = Object.freeze({
      e164,
      result,
      washedAt,
      mode: activeMode,
      batchRef: batchRef || null,
      importedFrom,
      // Only a wash a human really performed against the real Register is
      // authoritative. Fixture results never are, whatever else is true.
      authoritative: Boolean(authoritative) && activeMode === "import",
      recordedAt: now().toISOString(),
    });
    records.set(e164, row);
    return row;
  }

  /**
   * Wash one number.
   *
   * In `disabled` mode this contacts nothing and records nothing — it returns
   * "unknown", which is the honest answer and a veto downstream.
   */
  function wash(e164) {
    if (typeof e164 !== "string" || !e164.startsWith("+61")) {
      return { ok: false, code: "number_invalid", message: "A wash needs an Australian number in +61 form." };
    }

    if (activeMode === "disabled") {
      return {
        ok: true,
        result: "unknown",
        resultLabel: S.DNCR_RESULT_LABELS.unknown,
        mode: activeMode,
        authoritative: false,
        message: "The Do Not Call Register check is switched off, so this number has not been checked.",
      };
    }

    if (activeMode === "fixture") {
      const listed = FIXTURE_REGISTER.includes(e164);
      const row = store(e164, listed ? "listed" : "not_listed", {
        batchRef: "fixture",
        washedAt: now().toISOString(),
        authoritative: false,
      });
      if (audit) {
        audit.record({
          entityType: "phone",
          entityId: e164,
          event: "dncr_wash",
          decision: "record",
          actor: "dncr-fixture",
          actorKind: "system",
          reason: `Fixture wash: ${S.DNCR_RESULT_LABELS[row.result]}.`,
          detail: { result: row.result, mode: activeMode, authoritative: false },
        });
      }
      return { ok: true, result: row.result, resultLabel: S.DNCR_RESULT_LABELS[row.result], mode: activeMode, authoritative: false, washedAt: row.washedAt };
    }

    // activeMode === "import": washing is not something this process DOES, it
    // is something it RECORDS. Asking it to wash is a programming error, and
    // the message says what to do instead.
    return {
      ok: false,
      code: "import_mode_cannot_wash",
      message: "In import mode this system does not perform washes — it records the results of a wash a person performed. Use importResults().",
    };
  }

  /**
   * Load the results of a wash performed out-of-band against the real Register.
   *
   * @param {object} batch
   * @param {string} batch.washedAt      when the wash was actually performed
   * @param {string} batch.batchRef      the operator's reference for it
   * @param {string} batch.attestedBy    the person attesting these are the real results
   * @param {Array}  batch.results       [{ e164, result }]
   */
  function importResults(batch) {
    if (activeMode !== "import") {
      return { ok: false, code: "not_import_mode", message: `Wash results can only be imported in import mode; this build is in "${activeMode}" mode.` };
    }
    if (!batch || typeof batch !== "object") {
      return { ok: false, code: "batch_invalid", message: "An import needs a batch object." };
    }
    if (!isIsoInstant(batch.washedAt)) {
      return { ok: false, code: "washed_at_invalid", message: "An import must say when the wash was actually performed — the timestamp is the evidence." };
    }
    if (new Date(batch.washedAt).getTime() > now().getTime()) {
      return { ok: false, code: "washed_at_future", message: "A wash cannot have been performed in the future." };
    }
    // WHO says these are the real results. Without it, an imported file is
    // indistinguishable from a made-up one.
    if (typeof batch.attestedBy !== "string" || !batch.attestedBy.trim()) {
      return { ok: false, code: "attestation_missing", message: "An import must record who attests that these are the results of a real wash." };
    }
    if (!Array.isArray(batch.results) || batch.results.length === 0) {
      return { ok: false, code: "results_missing", message: "An import must contain at least one result." };
    }

    // Validate EVERY record before storing ANY. A half-applied import would
    // leave some numbers washed and some not, with nothing recording which.
    const problems = [];
    batch.results.forEach((record, i) => {
      const check = validateImportRecord(record);
      if (!check.ok) problems.push({ index: i, message: check.message });
    });
    if (problems.length) {
      return { ok: false, code: "results_invalid", message: `${problems.length} of ${batch.results.length} results could not be read; nothing was imported.`, problems };
    }

    const stored = batch.results.map((record) =>
      store(record.e164, record.result, {
        batchRef: batch.batchRef || null,
        washedAt: new Date(batch.washedAt).toISOString(),
        authoritative: true,
        importedFrom: batch.attestedBy.trim(),
      })
    );

    if (audit) {
      audit.record({
        entityType: "system",
        entityId: batch.batchRef || "dncr-import",
        event: "dncr_results_imported",
        decision: "record",
        actor: batch.attestedBy.trim(),
        actorKind: "human",
        reason: `Imported ${stored.length} Do Not Call Register wash results performed on ${batch.washedAt}.`,
        detail: {
          washedAt: batch.washedAt,
          count: stored.length,
          listed: stored.filter((r) => r.result === "listed").length,
        },
      });
    }

    return { ok: true, imported: stored.length, listed: stored.filter((r) => r.result === "listed").length };
  }

  /**
   * What we can rely on for this number at a given instant.
   *
   * Freshness is recomputed on every call, so a wash that has crossed 30 days
   * comes back unusable without anything having had to notice.
   *
   * @param {Date} [opts.at]  evaluate freshness AT this instant instead of now.
   *   Required by anything that asks a question about the future: a scheduler
   *   deciding "can this be called next Tuesday?" must be told whether the wash
   *   will still be valid THEN, not whether it is valid today. Without this a
   *   scheduler would happily queue a call for a date on which the wash has
   *   already expired — precisely the W1 failure in the architecture red-team.
   */
  function assess(e164, { at = null } = {}) {
    const evaluatedAt = at instanceof Date && Number.isFinite(at.getTime()) ? at : now();
    const row = records.get(e164);
    if (!row) {
      return Object.freeze({
        result: "unknown",
        resultLabel: S.DNCR_RESULT_LABELS.unknown,
        usable: false,
        fresh: false,
        washedAt: null,
        ageDays: null,
        mode: activeMode,
        authoritative: false,
        reason:
          activeMode === "disabled"
            ? "The Do Not Call Register check is switched off, so this number has never been checked."
            : "This number has not been checked against the Do Not Call Register.",
      });
    }

    const ageMs = evaluatedAt.getTime() - new Date(row.washedAt).getTime();
    const ageDays = Math.floor(ageMs / MS_PER_DAY);
    const fresh = ageMs >= 0 && ageDays < DNCR_WASH_VALIDITY_DAYS;

    if (!fresh) {
      // A stale wash is NOT a "listed"/"not_listed" answer any more. It decays
      // to unknown, which vetoes — rather than to its last value, which would
      // silently authorise calls on evidence that expired.
      return Object.freeze({
        result: "unknown",
        resultLabel: S.DNCR_RESULT_LABELS.unknown,
        usable: false,
        fresh: false,
        washedAt: row.washedAt,
        ageDays,
        mode: row.mode,
        authoritative: row.authoritative,
        priorResult: row.result,
        reason: `The Do Not Call Register check for this number is ${ageDays} days old. A check may only be relied on for ${DNCR_WASH_VALIDITY_DAYS} days, so it has to be done again.`,
      });
    }

    return Object.freeze({
      result: row.result,
      resultLabel: S.DNCR_RESULT_LABELS[row.result],
      // Usable means "this is an answer we may act on". A fixture result is a
      // real answer for testing purposes but is never authoritative, and the
      // eligibility engine is what decides whether that is good enough.
      usable: true,
      fresh: true,
      washedAt: row.washedAt,
      ageDays,
      mode: row.mode,
      authoritative: row.authoritative,
      batchRef: row.batchRef,
      reason:
        row.result === "listed"
          ? `This number is on the Do Not Call Register (checked ${ageDays} day${ageDays === 1 ? "" : "s"} ago).`
          : `This number was not on the Do Not Call Register when it was checked ${ageDays} day${ageDays === 1 ? "" : "s"} ago.`,
    });
  }

  /** Wash every callable number on a set of prospects. Returns a summary. */
  function washAll(e164List) {
    const list = Array.isArray(e164List) ? e164List : [];
    const results = list.map((e164) => ({ e164, ...wash(e164) }));
    return {
      washed: results.filter((r) => r.ok).length,
      listed: results.filter((r) => r.result === "listed").length,
      unknown: results.filter((r) => r.result === "unknown").length,
      results,
    };
  }

  return Object.freeze({
    mode: activeMode,
    faults: Object.freeze(resolved.faults || []),
    wash,
    washAll,
    importResults,
    assess,
    count: () => records.size,
    // Present so a future live adapter has an obvious place to fail loudly.
    assertLiveWashUnavailable: () => assertExternalAccessAllowed("dncr_api", "wash numbers against the Do Not Call Register"),
  });
}

module.exports = {
  createWashStore,
  validateImportRecord,
  FIXTURE_REGISTER,
  DNCR_WASH_VALIDITY_DAYS,
};
