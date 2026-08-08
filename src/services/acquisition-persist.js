// AIDA Locksmith Acquisition — persisting an imported prospect (M8G).
//
//   persistImportedProspect({ prospect, evidence, store, now })
//     → { outcome, prospectId, created, phonesAdded, evidenceAdded, ... }
//
// M8F could turn a CSV into clean, deduplicated, explainable prospects. They
// evaporated when the process exited. This is what makes them survive, into the
// laq1 tables that have existed since M8D with nothing writing to them.
//
// ── THERE IS NO CROSS-TABLE TRANSACTION, SO ORDER IS THE DESIGN ─────
// The Supabase adapter issues one statement per call; it cannot wrap three
// tables in a transaction. Pretending otherwise would be worse than not having
// one, so the ordering is chosen to make every partial state either harmless or
// visibly incomplete, and re-running is the repair:
//
//   1. PROSPECT first, always. Both other tables carry a foreign key to it, so
//      nothing else can even be attempted until it exists. A crash here leaves
//      nothing at all.
//
//   2. PHONES second. A prospect with no phone rows is already a state the
//      review step understands and refuses to approve — "phone_unverifiable" is
//      an existing rejection reason. A crash here leaves a business that cannot
//      be called, which is the safe direction.
//
//   3. EVIDENCE last, and this is the deliberate one. Evidence is append-only:
//      it can never be corrected, only added to. Writing it last means a crash
//      leaves FEWER claims than we hold rather than claims we cannot revise.
//      The opposite ordering would bake a permanent record of a business whose
//      prospect row failed to appear.
//
// ── EVERY STEP IS IDEMPOTENT, SO RETRY IS THE REPAIR ────────────────
// The prospect upserts on its deterministic id, phones on laq1's
// unique(prospect_id, raw), evidence on the ledger's content hash. Running the
// same import twice adds nothing; running it again after a partial failure adds
// exactly what was missing. There is no reconciliation job, because there is
// nothing for one to do.
//
// ── PARTIAL FAILURE IS REPORTED, NEVER SWALLOWED ────────────────────
// A step that throws stops this prospect and returns `partial` with the stage
// that failed named. The batch continues to the next business — one bad row
// must not cost the other eight hundred — and the caller is told exactly what
// is on disk.
//
// NOTHING HERE CONTACTS ANYBODY. No provider, no network, no dialler, and
// persisting a business does not make it callable: it lands as `discovered`,
// unreviewed, unwashed, and still behind every gate.
//
// See test/acquisition-persist.test.js.

const { normalisePhone } = require("./acquisition-phone");
const { assertStoreContract } = require("./acquisition-store");

/** What happened to one business. Existing vocabulary where it fits. */
const PERSIST_OUTCOMES = Object.freeze({
  CREATED: "created",
  UPDATED: "updated",
  UNCHANGED: "unchanged",
  PARTIAL: "partial",
  FAILED: "failed",
  /** Held back for a human: it may be a business we already have. */
  REVIEW_REQUIRED: "review_required",
});

/**
 * Persist one imported prospect and everything that belongs to it.
 *
 * @param {object}   prospect  a prospect built by acquisition-prospect
 * @param {object[]} evidence  the ledger rows recorded for it
 * @param {object}   store     a durable store
 * @param {function} now
 */
async function persistImportedProspect({ prospect, evidence = [], store, now } = {}) {
  if (typeof now !== "function") throw new Error("persistImportedProspect requires an injected now().");
  assertStoreContract(store, "persistence store");
  if (!prospect || typeof prospect !== "object") {
    return Object.freeze({ outcome: PERSIST_OUTCOMES.FAILED, prospectId: null, stage: "input", message: "There is no prospect to persist." });
  }

  const result = {
    prospectId: prospect.prospectId,
    businessName: prospect.businessName,
    created: false,
    phonesAdded: 0,
    phonesAlreadyPresent: 0,
    evidenceAdded: 0,
    evidenceAlreadyPresent: 0,
  };

  // ── 1. The prospect ───────────────────────────────────────────────
  let upserted;
  try {
    upserted = await store.upsertProspect({
      prospectId: prospect.prospectId,
      schemaVersion: prospect.schemaVersion,
      businessName: prospect.businessName,
      legalName: prospect.legalName,
      abn: prospect.abn,
      tradeCategory: prospect.tradeCategory,
      suburb: prospect.suburb,
      state: prospect.state,
      postcode: prospect.postcode,
      region: prospect.region,
      timezone: prospect.timezone,
      origin: prospect.origin,
      discoveredAt: prospect.discoveredAt,
      discoveredBy: prospect.discoveredBy,
      notes: prospect.notes,
      updatedAt: now().toISOString(),
    });
  } catch (err) {
    return Object.freeze({
      ...result,
      outcome: PERSIST_OUTCOMES.FAILED,
      stage: "prospect",
      message: `The prospect could not be stored, so nothing else was attempted: ${err.message}`,
    });
  }
  result.created = upserted.created === true;

  // ── 2. The phones ─────────────────────────────────────────────────
  //
  // Normalised BEFORE anything is written, and the raw string is what is
  // stored: laq1 keeps the number as published because that is the thing a
  // reviewer checks against the source. The E.164 form lives in the evidence
  // and is recomputed wherever it is compared.
  for (const phone of prospect.phones || []) {
    const normalised = normalisePhone(phone.raw);
    if (!normalised.ok || !normalised.callable) {
      // Kept out of the phone table rather than stored and filtered later. An
      // uncallable number in a table called "phones" is a trap for whatever
      // reads it next.
      continue;
    }
    try {
      const written = await store.upsertProspectPhone({
        prospectId: prospect.prospectId,
        raw: phone.raw,
        label: phone.label || null,
        evidenceId: phone.evidenceId || null,
      });
      if (written.created) result.phonesAdded += 1;
      else result.phonesAlreadyPresent += 1;
    } catch (err) {
      return Object.freeze({
        ...result,
        outcome: PERSIST_OUTCOMES.PARTIAL,
        stage: "phones",
        message: `The prospect was stored but a phone row was not: ${err.message}. Re-running the import will add what is missing.`,
      });
    }
  }

  // ── 3. The evidence, last and append-only ────────────────────────
  for (const row of evidence) {
    try {
      const written = await store.appendEvidence(row);
      if (written.created) result.evidenceAdded += 1;
      else result.evidenceAlreadyPresent += 1;
    } catch (err) {
      return Object.freeze({
        ...result,
        outcome: PERSIST_OUTCOMES.PARTIAL,
        stage: "evidence",
        message: `The prospect and its numbers were stored but an evidence row was not: ${err.message}. Re-running the import will append what is missing.`,
      });
    }
  }

  const changed = result.created || result.phonesAdded > 0 || result.evidenceAdded > 0;
  return Object.freeze({
    ...result,
    outcome: result.created ? PERSIST_OUTCOMES.CREATED : changed ? PERSIST_OUTCOMES.UPDATED : PERSIST_OUTCOMES.UNCHANGED,
    stage: "complete",
    message: result.created
      ? `Stored "${prospect.businessName}" with ${result.phonesAdded} number(s) and ${result.evidenceAdded} evidence row(s).`
      : changed
        ? `"${prospect.businessName}" was already known; added ${result.phonesAdded} number(s) and ${result.evidenceAdded} evidence row(s).`
        : `"${prospect.businessName}" was already known and nothing about it had changed.`,
    note: "Persisting a business does not make it callable. It is stored as `discovered`, unreviewed and unwashed, and every gate still applies.",
  });
}

/**
 * The businesses this file might already be about (M8G).
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────
 * M8F deduplicates WITHIN one import run: it compares each row against the
 * businesses it has admitted so far. Across runs it had nothing to compare
 * against, and that is survivable only while prospects are deterministic.
 *
 * They are — `prospectId` is derived from name and locality — so re-importing
 * the SAME file twice upserts the same row and adds nothing. But a name that
 * drifts produces a different id: "…Locksmiths" and "…Locksmiths Pty Ltd" are
 * one business with two ids, and the second import would have created a second
 * prospect row. In-run dedupe caught that; nothing caught it a week later.
 *
 * So before importing, the store is asked which businesses this file could
 * already be about, and the answer is handed to the importer as `existing`.
 * The comparison itself stays where it belongs, in acquisition-dedupe.
 *
 * ── NARROW, NOT A TABLE SCAN ────────────────────────────────────────
 * Queried by the file's own source ids and normalised numbers rather than by
 * loading every prospect. Both are indexed identity keys, and a business the
 * file shares neither with is not a business the file is about.
 */
async function loadExistingForImport({ store, text, profileName, limit = 500 } = {}) {
  assertStoreContract(store, "import store");
  const { parseCsv } = require("./acquisition-csv");
  const { getImportProfile, mapRow } = require("./acquisition-import-profiles");

  const resolved = getImportProfile(profileName);
  if (!resolved.ok) return [];
  const parsed = parseCsv(text);
  if (!parsed.ok) return [];

  const sourceIds = new Set();
  const numbers = new Set();
  for (const row of parsed.rows) {
    const record = mapRow(resolved.profile, row.values, { line: row.line });
    if (record.sourceId) sourceIds.add(record.sourceId);
    for (const phone of record.phones) {
      const n = normalisePhone(phone.raw);
      if (n.ok && n.callable) numbers.add(n.e164);
    }
  }

  const found = new Map();
  for (const sourceId of sourceIds) {
    for (const p of await store.findProspects({ sourceId, limit })) found.set(p.prospectId, p);
  }
  for (const e164 of numbers) {
    for (const p of await store.findProspects({ e164, limit })) found.set(p.prospectId, p);
  }

  // acquisition-dedupe compares numbers, so each candidate is returned with the
  // ones actually stored for it rather than with none.
  const withPhones = [];
  for (const p of found.values()) {
    const phones = await store.listProspectPhones(p.prospectId);
    withPhones.push({
      ...p,
      phones,
      numbers: phones.map((ph) => normalisePhone(ph.raw)).filter((n) => n.ok && n.callable).map((n) => ({ e164: n.e164 })),
    });
  }
  return withPhones;
}

/**
 * Persist a whole import result.
 *
 * Takes what importBusinessCsv returned plus the ledger it wrote into, and
 * stores every prospect it admitted. One failing business does not stop the
 * others; each outcome is returned.
 */
async function persistImportResult({ result, ledger, store, now } = {}) {
  if (!result || !result.ok) throw new Error("persistImportResult needs a successful import result.");
  if (!ledger || typeof ledger.forProspect !== "function") throw new Error("persistImportResult needs the ledger the import wrote into.");

  /**
   * A POSSIBLE DUPLICATE IS NOT PERSISTED, AND THIS IS THE WHOLE POINT.
   *
   * The dedupe module has three answers, not two. `exact_duplicate` and
   * `probable_same_business` merge; `distinct` is a new business; and in
   * between sits `possible_duplicate_requires_review`, which means the evidence
   * genuinely does not decide.
   *
   * The real proof found what happens if that middle answer is persisted
   * anyway. A drifted re-import — Pty Ltd name, different suburb spelling, same
   * number — came back as review_required, was written, and the invented
   * business had TWO prospect rows. Every subsequent import would compare
   * against both, and a business that drifts twice would have three. That is
   * the duplicate explosion this milestone exists to prevent, arriving through
   * the one door dedupe deliberately left ajar.
   *
   * So a possible duplicate is REPORTED and not stored. Nothing is lost: the
   * row is in the import outcome with the signals that fired and the prospect
   * it might be, which is exactly what a human needs to decide. Storing it
   * would be deciding, by default, in the direction that cannot be undone —
   * evidence is append-only and a prospect carrying it cannot be deleted.
   */
  const heldForReview = new Set(
    (result.outcomes || [])
      .filter((o) => o.possibleDuplicateOf)
      .map((o) => o.prospectId)
      .filter(Boolean)
  );

  const persisted = [];
  for (const prospect of result.prospects) {
    if (heldForReview.has(prospect.prospectId)) {
      const outcome = result.outcomes.find((o) => o.prospectId === prospect.prospectId);
      persisted.push(
        Object.freeze({
          prospectId: prospect.prospectId,
          businessName: prospect.businessName,
          outcome: PERSIST_OUTCOMES.REVIEW_REQUIRED,
          stage: "held",
          created: false,
          phonesAdded: 0,
          evidenceAdded: 0,
          possibleDuplicateOf: outcome ? outcome.possibleDuplicateOf : null,
          message: `Not stored: this may be the same business as one already known. ${outcome ? outcome.message : ""} A human decides whether it is a second business or the same one spelled differently.`,
        })
      );
      continue;
    }
    persisted.push(
      await persistImportedProspect({
        prospect,
        evidence: ledger.forProspect(prospect.prospectId),
        store,
        now,
      })
    );
  }

  const by = (outcome) => persisted.filter((p) => p.outcome === outcome).length;
  return Object.freeze({
    persisted: Object.freeze(persisted),
    summary: Object.freeze({
      attempted: persisted.length,
      created: by(PERSIST_OUTCOMES.CREATED),
      updated: by(PERSIST_OUTCOMES.UPDATED),
      unchanged: by(PERSIST_OUTCOMES.UNCHANGED),
      partial: by(PERSIST_OUTCOMES.PARTIAL),
      failed: by(PERSIST_OUTCOMES.FAILED),
      heldForReview: by(PERSIST_OUTCOMES.REVIEW_REQUIRED),
      phonesAdded: persisted.reduce((n, p) => n + (p.phonesAdded || 0), 0),
      evidenceAdded: persisted.reduce((n, p) => n + (p.evidenceAdded || 0), 0),
    }),
  });
}

module.exports = { persistImportedProspect, persistImportResult, loadExistingForImport, PERSIST_OUTCOMES };
