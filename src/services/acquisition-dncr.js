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
function createWashStore({ now, mode = null, audit = null, env = process.env, initialRecords = null } = {}) {
  if (typeof now !== "function") {
    throw new Error("createWashStore requires an injected now() — wash freshness must be deterministic in tests.");
  }

  const resolved = mode ? { mode, faults: [] } : resolveDncrMode(env);
  const activeMode = ["disabled", "fixture", "import"].includes(resolved.mode) ? resolved.mode : "disabled";

  // e164 → the most recent wash record for that number.
  const records = new Map();

  // ── Hydration from durable rows (M8K) ────────────────────────────
  //
  // Pre-loaded at the async boundary and handed in, the same shape M8E used for
  // durable suppression and M8J for durable contact history: assess() stays
  // synchronous because the eligibility engine is synchronous by design.
  //
  // "Most recent" is by when the wash was PERFORMED, not when it was recorded.
  // Importing an old wash today must not displace a fresher one already held.
  if (Array.isArray(initialRecords)) {
    for (const row of initialRecords) {
      if (!row || typeof row.e164 !== "string" || !isIsoInstant(row.washedAt)) continue;
      const held = records.get(row.e164);
      if (held && Date.parse(held.washedAt) >= Date.parse(row.washedAt)) continue;
      records.set(
        row.e164,
        Object.freeze({
          e164: row.e164,
          result: row.result,
          washedAt: row.washedAt,
          mode: row.mode || activeMode,
          batchRef: row.batchRef || null,
          importedFrom: row.attestedBy || null,
          authoritative: row.authoritative === true,
          recordedAt: row.recordedAt || null,
        })
      );
    }
  }

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
    // Whether this store could actually read what it is supposed to know.
    // TRUE here; the only false comes from unavailableWashStore().
    available: true,
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

// ── Durable storage (M8K / E-3) ─────────────────────────────────────

/**
 * The canonical key for a wash.
 *
 * A wash is recorded against a TELEPHONE, not against a spelling of one.
 * "(03) 5550 1042", "03 5550 1042" and "+61355501042" are the same number, and
 * if they produced three keys then washing one spelling would leave the others
 * reading as never-checked — which vetoes, so it fails safe, but it also means
 * a real wash would silently fail to authorise anything.
 */
function canonicalNumber(raw) {
  const { normalisePhone } = require("./acquisition-phone");
  const parsed = normalisePhone(raw);
  return parsed && parsed.ok && parsed.e164 ? parsed.e164 : null;
}

/**
 * A wash store that COULD NOT BE READ.
 *
 * Deliberately not "an empty store". An empty store answers "unknown" for every
 * number, which is the same answer this gives — but it answers it as a FACT
 * ("we have not washed this"), and the difference matters the moment somebody
 * reads a report or writes a retry. Not knowing whether we hold a wash is a
 * system failure and says so, with `unavailable: true`, so eligibility can name
 * it as `dncr_store_unavailable` rather than as "never checked".
 *
 * It cannot be written to. A store that failed to read must not accept an
 * import and appear to have worked.
 */
function unavailableWashStore(reason, { mode = "import" } = {}) {
  const refuse = () => ({ ok: false, code: "wash_store_unavailable", message: reason });
  return Object.freeze({
    mode,
    available: false,
    reason,
    faults: Object.freeze([{ code: "wash_store_unavailable", message: reason }]),
    wash: refuse,
    washAll: () => ({ washed: 0, listed: 0, unknown: 0, results: [] }),
    importResults: refuse,
    count: () => 0,
    assess() {
      return Object.freeze({
        result: "unknown",
        resultLabel: S.DNCR_RESULT_LABELS.unknown,
        usable: false,
        fresh: false,
        unavailable: true,
        washedAt: null,
        ageDays: null,
        mode,
        authoritative: false,
        reason: `The Do Not Call Register wash records could not be read, so it is unknown whether this number has been checked. ${reason}`.trim(),
      });
    },
    assertLiveWashUnavailable: () => assertExternalAccessAllowed("dncr_api", "wash numbers against the Do Not Call Register"),
  });
}

/**
 * Build a wash store from durable rows — the production path.
 *
 * Loads every wash the store holds and hands them to createWashStore as
 * hydration, so assess() can stay synchronous inside the eligibility engine.
 *
 * FAILS CLOSED. If the read throws — no table, no credentials, no network —
 * this returns unavailableWashStore rather than an empty one. The distinction
 * is the entire point of the function: an empty Map presented as a successful
 * read is indistinguishable from "nobody is on the Register", and that mistake
 * authorises calls.
 */
async function hydrateWashStore({ store, now, mode = "import", audit = null, env = process.env } = {}) {
  if (typeof now !== "function") throw new Error("hydrateWashStore requires an injected now().");
  if (!store || typeof store.listWashes !== "function") {
    return unavailableWashStore("No durable wash store was supplied.", { mode });
  }
  let rows;
  try {
    rows = await store.listWashes({});
  } catch (err) {
    return unavailableWashStore(`The wash ledger could not be read: ${err.message}`, { mode });
  }
  if (!Array.isArray(rows)) {
    return unavailableWashStore("The wash ledger returned no readable rows.", { mode });
  }
  return createWashStore({ now, mode, audit, env, initialRecords: rows });
}

/**
 * Persist the results of a wash a human performed against the real Register.
 *
 * Validates the WHOLE batch before writing any of it, on the same reasoning as
 * the in-memory importResults: a half-applied import leaves some numbers washed
 * and some not, with nothing recording which.
 *
 * Numbers are canonicalised on the way in, so a file that spells the same
 * number two ways lands on one key.
 *
 * @param {object} batch.washedAt    when the wash was actually performed
 * @param {string} batch.batchRef    the operator's reference for it
 * @param {string} batch.attestedBy  who attests these are the real results
 * @param {Array}  batch.results     [{ e164, result }]
 */
async function importWashResults({ store, batch, now, audit = null, source = null } = {}) {
  if (typeof now !== "function") throw new Error("importWashResults requires an injected now().");
  if (!store || typeof store.appendWash !== "function") {
    return { ok: false, code: "store_unavailable", message: "There is no durable wash store to import into." };
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
  if (typeof batch.attestedBy !== "string" || !batch.attestedBy.trim()) {
    return { ok: false, code: "attestation_missing", message: "An import must record who attests that these are the results of a real wash." };
  }
  if (!Array.isArray(batch.results) || batch.results.length === 0) {
    return { ok: false, code: "results_missing", message: "An import must contain at least one result." };
  }

  // Validate everything, canonicalise everything, write nothing yet.
  const problems = [];
  const prepared = [];
  batch.results.forEach((record, i) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      problems.push({ index: i, message: "Each wash result must be an object." });
      return;
    }
    const e164 = canonicalNumber(record.e164);
    if (!e164) {
      problems.push({ index: i, message: `"${String(record.e164).slice(0, 30)}" is not a number we can record a wash against.` });
      return;
    }
    if (record.result !== "listed" && record.result !== "not_listed") {
      problems.push({ index: i, message: `A wash result must be "listed" or "not_listed", not "${String(record.result).slice(0, 30)}".` });
      return;
    }
    prepared.push({
      e164,
      result: record.result,
      washedAt: new Date(batch.washedAt).toISOString(),
      attestedBy: batch.attestedBy.trim(),
      mode: "import",
      batchRef: batch.batchRef || null,
      source: source || batch.source || null,
      recordedAt: now().toISOString(),
    });
  });

  if (problems.length) {
    return { ok: false, code: "results_invalid", message: `${problems.length} of ${batch.results.length} results could not be read; nothing was imported.`, problems };
  }

  let imported = 0;
  let duplicates = 0;
  for (const row of prepared) {
    const written = await store.appendWash(row);
    if (written && written.created === false) duplicates += 1;
    else imported += 1;
  }

  if (audit) {
    audit.record({
      entityType: "system",
      entityId: batch.batchRef || "dncr-import",
      event: "dncr_results_imported",
      decision: "record",
      actor: batch.attestedBy.trim(),
      actorKind: "human",
      reason: `Imported ${imported} Do Not Call Register wash results performed on ${batch.washedAt}${duplicates ? ` (${duplicates} already held)` : ""}.`,
      detail: {
        washedAt: batch.washedAt,
        count: prepared.length,
        imported,
        duplicates,
        listed: prepared.filter((r) => r.result === "listed").length,
      },
    });
  }

  return {
    ok: true,
    imported,
    duplicates,
    total: prepared.length,
    listed: prepared.filter((r) => r.result === "listed").length,
  };
}

module.exports = {
  createWashStore,
  hydrateWashStore,
  importWashResults,
  unavailableWashStore,
  canonicalNumber,
  validateImportRecord,
  FIXTURE_REGISTER,
  DNCR_WASH_VALIDITY_DAYS,
};
