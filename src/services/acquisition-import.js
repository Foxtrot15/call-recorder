// AIDA Locksmith Acquisition — the real-source import pipeline (M8F).
//
//   importBusinessCsv({ text, profileName, now, ledger, ... })
//     → { ok, outcomes, summary, problems }
//
// One file in; per-row outcomes and an operator summary out. This is the
// boundary between "a CSV a founder exported" and "prospects the acquisition
// engine already knows how to handle".
//
// ── IT ADDS NO NEW PIPELINE. THAT IS THE POINT. ─────────────────────
// Everything after mapping is the machinery that already exists and is already
// proven: acquisition-phone normalises, acquisition-discovery admits the
// candidate and writes evidence through the ledger, acquisition-dedupe finds
// duplicates, acquisition-qualification scores. This module sequences them.
//
// The alternative — an importer that built prospects itself — would have been a
// second definition of what a prospect is, a second provenance path, and a
// second place for suppression to be forgotten. There is exactly one of each.
//
// ── NOTHING HERE CONTACTS ANYTHING ──────────────────────────────────
// No network client is imported, no URL is fetched, no provider is reachable.
// A website column is a STRING that gets normalised and compared; it is never
// visited. Ratchets in the test file assert this rather than trusting the
// comment.
//
// ── A BAD ROW MUST NOT KILL THE BATCH ───────────────────────────────
// Every row is processed inside its own try/catch and yields an outcome. A
// nine-hundred-row file with three broken rows imports eight hundred and
// ninety-seven and tells you about the three. An importer that threw on the
// first malformed number would make real files unusable, and the fix for that
// is always to loosen validation — which is how bad numbers get called.
//
// Pure + dep-free. See test/acquisition-import.test.js.

const { parseCsv } = require("./acquisition-csv");
const { getImportProfile, validateMapping, mapRow } = require("./acquisition-import-profiles");
const { classifyBusiness } = require("./acquisition-classify");
const { normalisePhone } = require("./acquisition-phone");
const { admitCandidate } = require("./acquisition-discovery");
const { identityFingerprint } = require("./acquisition-prospect");
const { compareRecords } = require("./acquisition-dedupe");

/**
 * Per-row outcomes.
 *
 * Reuses the existing review vocabulary where one fits (`not_a_locksmith` is a
 * REVIEW_REJECTION_REASON already) and adds only what an import can produce and
 * nothing else can.
 */
const IMPORT_OUTCOMES = Object.freeze({
  IMPORTED: "imported",
  MERGED: "merged",
  DUPLICATE: "duplicate",
  INVALID_PHONE: "invalid_phone",
  MISSING_PHONE: "missing_phone",
  INSUFFICIENT_DATA: "insufficient_data",
  NOT_LOCKSMITH: "not_locksmith",
  REVIEW_REQUIRED: "review_required",
  FAILED: "failed",
});

const outcome = (row, status, message, extra = {}) =>
  Object.freeze({
    line: row ? row.line : null,
    businessName: row ? row.businessName : null,
    status,
    message,
    ...extra,
  });

/**
 * Turn a mapped record into the candidate shape acquisition-discovery admits.
 *
 * PER-CLAIM SOURCE ATTRIBUTION is required by admitCandidate when a candidate
 * cites more than one source, and it is required for a good reason: a name from
 * the business's own site and a phone from a map listing are not equally well
 * known. An import cites the listing for everything it read from the listing,
 * and says so per claim rather than letting the strongest source cover facts it
 * did not supply.
 */
function toCandidate(record, profile) {
  /**
   * `sourceType`, not `type` — and this mattered.
   *
   * acquisition-source reads `sourceType`. An earlier version of this function
   * passed `type`, which nothing read, so the listing was classified purely by
   * its hostname; an unrecognised host falls through to `official_website`, and
   * every imported directory phone was recorded as officially sourced with
   * `authoritative: true`.
   *
   * The declaration is honoured because it is WEAKER than the hostname alone
   * would suggest. A profile knows what kind of source its export came from and
   * the URL cannot say so on its own.
   */
  const listing = {
    url: record.sourceUrl || null,
    label: profile.sourceLabel,
    sourceType: profile.sourceType,
    identifier: record.sourceId || null,
    register: null,
  };

  // The website is recorded as a source ONLY when the row actually carried one.
  // It is not visited, and claiming it published anything would be a lie about
  // where the facts came from — so it is cited for nothing, and exists in the
  // record so a later verification step can use it.
  //
  // The website is recorded as `unverified_directory` rather than
  // `official_website` DESPITE almost certainly being the business's own site.
  // Nothing here has opened it. Classifying it as official would assert a
  // verification that did not happen, and it is cited for no claim anyway.
  const refs = [listing];
  if (record.website) refs.push({ url: record.website, label: "Business website (not verified by this build)", sourceType: "unverified_directory" });

  const evidenceSources = {
    business_name: listing,
    legal_name: listing,
    abn: listing,
    trade_category: listing,
    address: listing,
    phone: listing,
  };

  return {
    businessName: record.businessName,
    legalName: record.legalName,
    tradeCategory: record.tradeCategory,
    suburb: record.suburb,
    state: record.state,
    postcode: record.postcode,
    region: record.suburb ? `${record.suburb}${record.state ? `, ${record.state}` : ""}` : null,
    timezone: record.timezone,
    phones: record.phones.map((p) => ({ raw: p.raw, label: p.label })),
    sourceRefs: refs,
    evidenceSources,
    observedAt: record.observedAt || null,
  };
}

/**
 * Import one CSV.
 *
 * @param {string}   text        the raw file contents
 * @param {string}   profileName which mapping to read it with
 * @param {function} now
 * @param {object}   ledger      the evidence ledger — the ONLY provenance store
 * @param {object[]} [existing]  prospects already known, for duplicate detection
 * @param {function} [qualify]   optional qualifier, run per admitted prospect
 * @param {function} [evaluate]  optional eligibility engine, for compliance state
 */
function importBusinessCsv({ text, profileName, now, ledger, existing = [], qualify = null, evaluate = null, capturedBy = "operator-import" } = {}) {
  if (typeof now !== "function") throw new Error("importBusinessCsv requires an injected now().");
  if (!ledger || typeof ledger.record !== "function") throw new Error("importBusinessCsv requires an evidence ledger; provenance is not optional.");

  const resolved = getImportProfile(profileName);
  if (!resolved.ok) {
    return Object.freeze({ ok: false, outcomes: Object.freeze([]), summary: null, problems: Object.freeze([resolved]) });
  }
  const profile = resolved.profile;

  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return Object.freeze({ ok: false, outcomes: Object.freeze([]), summary: null, problems: parsed.problems, headers: parsed.headers });
  }

  // MAPPING IS VALIDATED BEFORE ANY ROW IS READ. A founder who exported the
  // wrong columns hears about it once, not nine hundred times.
  const mapping = validateMapping(profile, parsed.headers);
  if (!mapping.ok) {
    return Object.freeze({ ok: false, outcomes: Object.freeze([]), summary: null, problems: mapping.problems, mapping });
  }

  const outcomes = [];
  const admitted = [];
  const known = [...existing];
  const seenSourceIds = new Map();

  for (const row of parsed.rows) {
    try {
      const record = mapRow(profile, row.values, { line: row.line });

      // ── A business with no name is not a business record ──
      if (!record.businessName) {
        outcomes.push(outcome(record, IMPORT_OUTCOMES.INSUFFICIENT_DATA, "This row has no business name, so there is nothing to identify."));
        continue;
      }

      // ── A repeated source id within ONE file is the export's own duplicate ──
      if (record.sourceId) {
        const first = seenSourceIds.get(record.sourceId);
        if (first !== undefined) {
          outcomes.push(outcome(record, IMPORT_OUTCOMES.DUPLICATE, `The same source id appeared on line ${first}, so this is the same listing twice in one file.`, { duplicateOfLine: first }));
          continue;
        }
        seenSourceIds.set(record.sourceId, record.line);
      }

      // ── Classification, before anything is built ──
      const classification = classifyBusiness(record);
      if (classification.verdict === "aggregator" || classification.verdict === "not_locksmith") {
        outcomes.push(outcome(record, IMPORT_OUTCOMES.NOT_LOCKSMITH, classification.message, { classification }));
        continue;
      }

      // ── Phones. Landlines are kept: AIDA is voice-first. ──
      //
      // The engine's CALLABLE_PHONE_KINDS has always included landline, and a
      // published business landline is the number a locksmith answers. Only
      // premium and short numbers are excluded, and those are excluded because
      // dialling them can cost the recipient money.
      const normalised = record.phones.map((p) => ({ ...p, ...normalisePhone(p.raw) }));
      const usable = normalised.filter((p) => p.ok && p.callable);
      const invalid = normalised.filter((p) => !p.ok);

      if (record.phones.length === 0) {
        outcomes.push(outcome(record, IMPORT_OUTCOMES.MISSING_PHONE, "The listing published no phone number, so this business cannot be called and is not worth queueing.", { classification }));
        continue;
      }
      if (usable.length === 0) {
        outcomes.push(
          outcome(record, IMPORT_OUTCOMES.INVALID_PHONE, `No usable number: ${normalised.map((p) => `"${p.raw}" (${p.kindLabel || p.kind})`).join(", ")}.`, {
            classification,
            invalidCount: invalid.length,
          })
        );
        continue;
      }

      // ── Build the prospect and write its evidence, through the ONE path ──
      const candidate = toCandidate(record, profile);
      const built = admitCandidate(candidate, {
        origin: profile.origin,
        adapterName: `import:${profile.name}`,
        ledger,
        now,
        capturedBy,
        captureMode: profile.captureMode,
      });

      if (!built.ok) {
        outcomes.push(outcome(record, IMPORT_OUTCOMES.FAILED, built.message, { code: built.code, errors: built.errors || null, classification }));
        continue;
      }

      const prospect = built.prospect;

      // ── Duplicate against everything already known, this file included ──
      //
      // The dedupe module's own vocabulary is used verbatim. `exact_duplicate`
      // and `probable_same_business` are safe to consolidate without asking;
      // `same_business_different_location` is a real BRANCH and must stay a
      // separate prospect, because a second shopfront is a second business to
      // call. Anything weaker goes to a human.
      const comparisons = known
        .map((other) => ({ other, decision: compareRecords(shapeForDedupe(prospect, usable), shapeForDedupe(other, other.__usable || [])) }))
        .filter((c) => c.decision && c.decision.decision !== "distinct" && c.decision.decision !== "insufficient_evidence");

      const conclusive = comparisons.find((c) => c.decision.autoConsolidationSafe === true);
      if (conclusive) {
        outcomes.push(
          outcome(record, IMPORT_OUTCOMES.MERGED, `Already known as "${conclusive.other.businessName}" (${conclusive.decision.label}): ${conclusive.decision.reasons.join(" ")} Anything genuinely new about it is attached to the existing business rather than creating a second one.`, {
            mergedInto: conclusive.other.prospectId,
            duplicateDecision: conclusive.decision.decision,
            signals: conclusive.decision.signals,
            classification,
            // CARRIED, NOT DISCARDED (M8H). Until now a merge threw the
            // listing away, including a number the business had started
            // publishing. The candidate and its claims ride along so the
            // persistence layer can attach what is genuinely new to the
            // canonical business. Nothing here decides to; it only makes it
            // possible.
            mergedCandidate: Object.freeze({ ...prospect }),
            mergedEvidence: Object.freeze([...built.evidence]),
          })
        );
        continue;
      }

      const branch = comparisons.find((c) => c.decision.decision === "same_business_different_location");
      const possible = comparisons.find((c) => c.decision.founderReviewRequired === true);

      const enriched = Object.freeze({
        ...prospect,
        __usable: usable,
        __classification: classification,
      });
      known.push(enriched);
      admitted.push(enriched);

      const qualification = qualify ? qualify(prospect, built.evidence) : null;
      const eligibility = evaluate ? evaluate(prospect, built.evidence) : null;

      const needsReview =
        possible !== undefined ||
        classification.verdict === "needs_review" ||
        record.notes.length > 0 ||
        !record.timezone;

      outcomes.push(
        outcome(record, needsReview ? IMPORT_OUTCOMES.REVIEW_REQUIRED : IMPORT_OUTCOMES.IMPORTED, needsReview ? reviewMessage(possible, classification, record) : `Imported as "${prospect.businessName}" with ${usable.length} callable number(s).`, {
          prospectId: prospect.prospectId,
          fingerprint: identityFingerprint(prospect),
          classification,
          qualification,
          eligibility,
          phones: Object.freeze(usable.map((p) => Object.freeze({ raw: p.raw, e164: p.e164, kind: p.kind }))),
          possibleDuplicateOf: possible ? possible.other.prospectId : null,
          branchOf: branch ? branch.other.prospectId : null,
          notes: record.notes,
        })
      );
    } catch (err) {
      // The batch continues. A row that broke the importer is a defect worth
      // seeing, not a reason to lose the other eight hundred.
      outcomes.push(outcome({ line: row.line, businessName: null }, IMPORT_OUTCOMES.FAILED, `This row could not be processed: ${err.message}`));
    }
  }

  return Object.freeze({
    ok: true,
    profile: profile.name,
    outcomes: Object.freeze(outcomes),
    prospects: Object.freeze(admitted.map((p) => Object.freeze({ ...p, __usable: undefined, __classification: undefined }))),
    summary: summariseImport(parsed, outcomes, admitted),
    mapping,
    problems: parsed.problems,
  });
}

function reviewMessage(possible, classification, record) {
  const reasons = [];
  if (possible) reasons.push(`it may be the same business as "${possible.other.businessName}" (${possible.decision.signals.join(", ")})`);
  if (classification.verdict === "needs_review") reasons.push(classification.message);
  if (!record.timezone) reasons.push("no state was published, so there is no timezone and calling hours cannot be checked");
  for (const n of record.notes) reasons.push(n.message);
  return `Imported, but a human should look: ${reasons.join("; ")}.`;
}

/**
 * The shape acquisition-dedupe compares.
 *
 * `numbers` is taken from the prospect when it already carries them, which is
 * the case for candidates loaded FROM THE STORE (M8G's loadExistingForImport
 * attaches the stored phone rows, normalised). An earlier version always used
 * the in-run `usable` list, which is empty for a stored prospect — so a
 * business already in the database looked like a business with no phone, the
 * strongest dedupe signal never fired, and a listing that should have merged
 * conclusively came back as "possible duplicate" instead.
 */
function shapeForDedupe(prospect, usable) {
  const numbers =
    Array.isArray(prospect.numbers) && prospect.numbers.length > 0
      ? prospect.numbers
      : (usable || []).map((p) => ({ e164: p.e164 }));
  return {
    ...prospect,
    numbers,
    evidenceCount: 3,
    hasOfficialSource: false,
  };
}

/**
 * The operator summary.
 *
 * Answers what a founder asks after dropping a file in: how many are real, how
 * many can I call, what did you throw away and why.
 */
function summariseImport(parsed, outcomes, admitted) {
  const by = (status) => outcomes.filter((o) => o.status === status).length;

  const phones = outcomes.flatMap((o) => o.phones || []);
  const kinds = phones.reduce((acc, p) => {
    acc[p.kind] = (acc[p.kind] || 0) + 1;
    return acc;
  }, {});

  const classified = outcomes.filter((o) => o.classification).reduce((acc, o) => {
    acc[o.classification.verdict] = (acc[o.classification.verdict] || 0) + 1;
    return acc;
  }, {});

  const qualified = outcomes.filter((o) => o.qualification && o.qualification.verdict === "qualified").length;
  const complianceBlocked = outcomes.filter((o) => o.eligibility && o.eligibility.eligible === false).length;

  return Object.freeze({
    sourceRows: parsed.rows.length,
    parseProblems: parsed.problems.length,
    imported: by(IMPORT_OUTCOMES.IMPORTED),
    reviewRequired: by(IMPORT_OUTCOMES.REVIEW_REQUIRED),
    merged: by(IMPORT_OUTCOMES.MERGED),
    duplicate: by(IMPORT_OUTCOMES.DUPLICATE),
    notLocksmith: by(IMPORT_OUTCOMES.NOT_LOCKSMITH),
    missingPhone: by(IMPORT_OUTCOMES.MISSING_PHONE),
    invalidPhone: by(IMPORT_OUTCOMES.INVALID_PHONE),
    insufficientData: by(IMPORT_OUTCOMES.INSUFFICIENT_DATA),
    failed: by(IMPORT_OUTCOMES.FAILED),
    prospects: admitted.length,
    classification: Object.freeze(classified),
    phoneKinds: Object.freeze(kinds),
    qualified,
    complianceBlocked,
    note: "Importing a business does not make it callable. Every prospect here still faces review, qualification, DNCR, suppression and the calling policy, and nothing has been contacted.",
  });
}

module.exports = { importBusinessCsv, IMPORT_OUTCOMES, summariseImport };
