// AIDA Locksmith Acquisition — duplicate resolution (A2).
//
//   compareRecords(a, b)        one pair → a typed, explained decision
//   resolveDuplicates(records)  many → clusters, canonical picks, review queue
//
// The pipeline's sixth step is "duplicates resolved". The harm being prevented
// is concrete: two records for one business means that business is dialled
// twice, which is the single most reliable way to turn a lawful call into a
// complaint (failure mode F7 in docs/OUTBOUND_BDM_ARCHITECTURE.md).
//
// ── THIS IS NOT A FUZZY MATCHER ─────────────────────────────────────
// There is no similarity score, no edit distance, no threshold anybody has to
// take on faith. Every decision is produced by a table of NAMED SIGNALS, and
// the signals that fired are returned with the decision. When a founder is
// asked to resolve a possible duplicate, they are told exactly which facts
// agreed and which disagreed — "same number, different ABN" is reviewable;
// "0.82 confidence" is not.
//
// Decision strength is a WORD, not a number, for the same reason: "conclusive"
// and "moderate" describe what the evidence supports. A number invites a
// threshold, and a threshold invites somebody to tune it until the merges look
// tidy.
//
// ── SIMILAR NAMES ARE NOT EVIDENCE ──────────────────────────────────
// "Melbourne Mobile Locksmith" and "Melbourne Locksmith Mobile" share every
// token and may be two unrelated businesses; locksmith trading names are built
// almost entirely from a small pool of trade and locality words. So a name
// match only counts when the name contains at least one DISTINCTIVE token —
// something that is not a trade word, a locality, or a service adjective. A
// name made only of generic tokens identifies nothing and is treated that way.
//
// ── NOTHING IS EVER DESTROYED ───────────────────────────────────────
// This module returns PROPOSALS. It does not mutate records, delete anything,
// or discard evidence. A consolidation proposal carries the union of every
// source reference, every discovered number and every timestamp from every
// record in the cluster, so consolidating loses no provenance — the duplicate
// records remain, linked to the canonical one.
//
// ── ORDER INDEPENDENCE ──────────────────────────────────────────────
// compareRecords(a, b) and compareRecords(b, a) return the same decision, and
// resolveDuplicates sorts by prospectId before clustering, so shuffling the
// input cannot change which record becomes canonical. Asserted by test.
//
// Pure + dep-free. See test/acquisition-dedupe.test.js.

const { identityFingerprint } = require("./acquisition-prospect");

// ── Decisions ───────────────────────────────────────────────────────

const DUPLICATE_DECISIONS = Object.freeze([
  "exact_duplicate",
  "probable_same_business",
  "same_business_different_location",
  "possible_duplicate_requires_review",
  "distinct",
  "insufficient_evidence",
]);

const DUPLICATE_DECISION_LABELS = Object.freeze({
  exact_duplicate: "The same business, recorded twice",
  probable_same_business: "Almost certainly the same business",
  same_business_different_location: "The same business at a different location",
  possible_duplicate_requires_review: "Might be a duplicate — needs a human",
  distinct: "Different businesses",
  insufficient_evidence: "Not enough information to tell",
});

// Only an exact duplicate may be consolidated without a person looking. Every
// other "same business" verdict still goes to a founder, because merging two
// records is how a second location's phone number quietly disappears.
const AUTO_CONSOLIDATION_SAFE = Object.freeze(["exact_duplicate"]);

const REVIEW_REQUIRED = Object.freeze([
  "probable_same_business",
  "same_business_different_location",
  "possible_duplicate_requires_review",
]);

const STRENGTHS = Object.freeze(["conclusive", "strong", "moderate", "weak", "none"]);

// ── Name analysis ───────────────────────────────────────────────────
//
// Tokens that appear in a large share of locksmith trading names and therefore
// distinguish nothing. A name whose tokens are ALL in this set is generic.
const GENERIC_TOKENS = new Set([
  // trade
  "locksmith", "locksmiths", "lock", "locks", "key", "keys", "locking",
  "security", "safe", "safes", "access", "alarm", "alarms", "door", "doors",
  // service adjectives
  "mobile", "emergency", "express", "rapid", "fast", "quick", "247", "24", "7",
  "hour", "hours", "hourly", "auto", "automotive", "residential", "commercial",
  "local", "near", "me", "cheap", "affordable", "best", "pro", "pros", "expert",
  "experts", "service", "services", "solutions", "group", "works", "centre",
  "center", "supply", "supplies", "repairs", "repair", "cutting",
  // geography that appears in trading names
  "melbourne", "victoria", "vic", "australia", "australian", "city", "metro",
  "north", "south", "east", "west", "northern", "southern", "eastern", "western",
  "inner", "outer", "greater", "bayside", "and", "of", "the", "a",
]);

function nameTokens(businessName) {
  if (typeof businessName !== "string") return [];
  return businessName
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(pty|ltd|limited|proprietary|inc|incorporated|co|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Tokens that actually identify a business, as opposed to describing the trade. */
function distinctiveTokens(businessName) {
  return nameTokens(businessName).filter((t) => !GENERIC_TOKENS.has(t));
}

function sameTokenSet(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const t of setA) if (!setB.has(t)) return false;
  return true;
}

// ── Record normalisation ────────────────────────────────────────────

function normaliseAbn(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

/**
 * Reduce a prospect (or a plain record) to the fields duplicate resolution
 * reasons about. Accepts either an A1 prospect or a caller-built record; the
 * numbers must already be normalised E.164 (acquisition-phone.js), because
 * comparing published strings would make "(03) 5550 1042" and "+61355501042"
 * look like different numbers.
 */
function toRecord(input) {
  if (!input || typeof input !== "object") return null;

  const numbers = [];
  const source = Array.isArray(input.numbers) ? input.numbers : Array.isArray(input.phones) ? input.phones : [];
  for (const n of source) {
    const e164 = typeof n === "string" ? n : n && (n.e164 || null);
    if (typeof e164 === "string" && e164.startsWith("+61")) numbers.push(e164);
  }

  const businessName = typeof input.businessName === "string" ? input.businessName : null;
  const suburb = lower(input.suburb);
  const state = lower(input.state);

  return Object.freeze({
    prospectId: input.prospectId || null,
    businessName,
    fingerprint: input.fingerprint || identityFingerprint({ businessName, suburb: input.suburb, state: input.state }),
    suburb,
    state,
    postcode: lower(input.postcode),
    abn: normaliseAbn(input.abn),
    numbers: Object.freeze([...new Set(numbers)].sort()),
    distinctive: Object.freeze(distinctiveTokens(businessName)),
    // Provenance, carried through untouched so a consolidation proposal can
    // preserve it. Never used for matching.
    sourceRefs: Object.freeze(Array.isArray(input.sourceRefs) ? [...input.sourceRefs] : []),
    discoveredAt: input.discoveredAt || null,
    hasOfficialSource: input.hasOfficialSource === true,
    evidenceCount: Number.isFinite(input.evidenceCount) ? input.evidenceCount : 0,
    lifecycle: input.lifecycle || null,
  });
}

// ── Pairwise comparison ─────────────────────────────────────────────

function sharedNumbers(a, b) {
  const setB = new Set(b.numbers);
  return a.numbers.filter((n) => setB.has(n));
}

/**
 * Compare two records.
 *
 * Returns a frozen decision: { decision, label, strength, signals, reasons,
 * autoConsolidationSafe, founderReviewRequired, evidence }.
 *
 * Symmetric: compare(a,b) and compare(b,a) give the same decision, the same
 * strength and the same signal set.
 */
function compareRecords(rawA, rawB) {
  const a = toRecord(rawA);
  const b = toRecord(rawB);

  if (!a || !b) {
    return decide("insufficient_evidence", "none", [], ["One or both records could not be read."], { a: null, b: null });
  }

  const signals = [];
  const reasons = [];

  // ── Gather signals ───────────────────────────────────────────────
  const shared = sharedNumbers(a, b);
  const bothHaveNumbers = a.numbers.length > 0 && b.numbers.length > 0;

  if (shared.length > 0) {
    signals.push("same_phone_number");
    reasons.push(`Both records carry the same phone number (${shared.join(", ")}).`);
  } else if (bothHaveNumbers) {
    signals.push("different_phone_numbers");
    reasons.push("The phone numbers do not overlap.");
  }

  const sameFingerprint = Boolean(a.fingerprint) && a.fingerprint === b.fingerprint;
  if (sameFingerprint) {
    signals.push("same_identity_fingerprint");
    reasons.push("The business name and locality are the same.");
  }

  const bothHaveAbn = Boolean(a.abn) && Boolean(b.abn);
  if (bothHaveAbn && a.abn === b.abn) {
    signals.push("same_abn");
    reasons.push(`Both records carry the same ABN (${a.abn}).`);
  } else if (bothHaveAbn) {
    signals.push("different_abn");
    reasons.push(`The ABNs differ (${a.abn} and ${b.abn}), so these are different registered entities.`);
  }

  const nameMatches = sameTokenSet(a.distinctive, b.distinctive);
  const nameIsIdentifying = a.distinctive.length > 0 && b.distinctive.length > 0;
  if (nameMatches && nameIsIdentifying) {
    signals.push("same_distinctive_name");
    reasons.push(`Both trade under the same distinctive name ("${a.distinctive.join(" ")}").`);
  } else if (!nameIsIdentifying) {
    signals.push("name_not_identifying");
    reasons.push("At least one name is made only of trade and locality words, so the name identifies nothing on its own.");
  }

  const sameLocality = a.suburb !== null && a.suburb === b.suburb && a.state === b.state;
  const differentLocality = a.suburb !== null && b.suburb !== null && (a.suburb !== b.suburb || a.state !== b.state);
  if (differentLocality) {
    signals.push("different_locality");
    reasons.push(`The localities differ (${a.suburb || "?"} and ${b.suburb || "?"}).`);
  }

  const evidence = Object.freeze({
    sharedNumbers: Object.freeze(shared),
    aNumbers: a.numbers,
    bNumbers: b.numbers,
    aFingerprint: a.fingerprint,
    bFingerprint: b.fingerprint,
    aAbn: a.abn,
    bAbn: b.abn,
    aDistinctive: a.distinctive,
    bDistinctive: b.distinctive,
  });

  const has = (s) => signals.includes(s);
  const out = (decision, strength) => decide(decision, strength, signals, reasons, evidence);

  // ── The decision table. Order is the precedence. ─────────────────

  // Nothing to go on at all.
  const aHasAnything = a.numbers.length > 0 || a.abn || nameIsIdentifying;
  const bHasAnything = b.numbers.length > 0 || b.abn || nameIsIdentifying;
  if (!aHasAnything || !bHasAnything) {
    reasons.push("There is not enough identifying information on at least one record to compare them.");
    return out("insufficient_evidence", "none");
  }

  // CONFLICTING EVIDENCE FIRST. Different ABNs are two registered entities; a
  // shared number on top of that is a genuine conflict (a shared answering
  // service? a rebrand mid-registration? a data error?) and is exactly the
  // thing a person must adjudicate — never a silent merge, never a silent split.
  if (has("different_abn") && has("same_phone_number")) {
    reasons.push("Same number but different ABNs — this contradiction has to be resolved by a person.");
    return out("possible_duplicate_requires_review", "moderate");
  }

  // Different ABNs, nothing shared: two entities. Believe the register.
  if (has("different_abn")) {
    return out("distinct", "conclusive");
  }

  // Same ABN is the registered entity agreeing with itself.
  if (has("same_abn")) {
    if (has("same_phone_number") || sameFingerprint) return out("exact_duplicate", "conclusive");
    if (differentLocality) {
      reasons.push("Same registered entity in two localities — most likely two branches, which are separate calling targets.");
      return out("same_business_different_location", "strong");
    }
    return out("probable_same_business", "strong");
  }

  // Same number AND same name+locality: the same record twice.
  if (has("same_phone_number") && sameFingerprint) {
    return out("exact_duplicate", "conclusive");
  }

  if (has("same_phone_number")) {
    // Same number, same distinctive name, different suburb → one business
    // listed at two locations. They must be consolidated for DIALLING (the
    // number is one number) but they are not obviously one record.
    if (has("same_distinctive_name") && differentLocality) {
      reasons.push("One business listed in two localities on one number. Whatever else is decided, that number must only be dialled once.");
      return out("same_business_different_location", "strong");
    }
    if (has("same_distinctive_name")) {
      return out("probable_same_business", "strong");
    }
    // Same number, unrelated names. A shared answering service or switchboard
    // is a real arrangement among small trades, so this is NOT a merge.
    reasons.push("The same number is published for two differently-named businesses — possibly a shared answering service, possibly a rebrand.");
    return out("possible_duplicate_requires_review", "moderate");
  }

  // No shared number from here down.

  if (sameFingerprint) {
    // Same name and same suburb, but the numbers disagree (or one is missing).
    if (has("different_phone_numbers")) {
      reasons.push("Same name and suburb but different numbers — one may be out of date, or these may be two lines of one business.");
      return out("probable_same_business", "moderate");
    }
    return out("probable_same_business", "strong");
  }

  if (has("same_distinctive_name") && differentLocality) {
    reasons.push("Same distinctive name in two localities, with nothing else in common.");
    return out("same_business_different_location", "moderate");
  }

  if (has("same_distinctive_name") && sameLocality) {
    return out("probable_same_business", "moderate");
  }

  if (has("same_distinctive_name")) {
    return out("possible_duplicate_requires_review", "weak");
  }

  // Names made only of generic words, nothing else agreeing: not evidence.
  if (has("name_not_identifying") && !has("same_phone_number") && !has("same_abn")) {
    reasons.push("Nothing identifying is shared between these records.");
    return out("distinct", "moderate");
  }

  return out("distinct", "strong");
}

function decide(decision, strength, signals, reasons, evidence) {
  return Object.freeze({
    decision,
    label: DUPLICATE_DECISION_LABELS[decision],
    strength,
    signals: Object.freeze([...signals].sort()),
    reasons: Object.freeze([...reasons]),
    autoConsolidationSafe: AUTO_CONSOLIDATION_SAFE.includes(decision),
    founderReviewRequired: REVIEW_REQUIRED.includes(decision),
    evidence,
  });
}

// ── Clustering ──────────────────────────────────────────────────────

/**
 * Pick the canonical record for a cluster, deterministically.
 *
 * Preference order, each a tiebreak for the last:
 *   1. has an official source        — the record we can stand behind
 *   2. has an ABN                    — registered identity
 *   3. more evidence rows            — more of it was actually verified
 *   4. earlier discovery             — first sighting
 *   5. prospectId, lexicographically — a total order, so ties never depend
 *                                      on input order
 */
function pickCanonical(records) {
  return [...records].sort((x, y) => {
    if (x.hasOfficialSource !== y.hasOfficialSource) return x.hasOfficialSource ? -1 : 1;
    if (Boolean(x.abn) !== Boolean(y.abn)) return x.abn ? -1 : 1;
    if (x.evidenceCount !== y.evidenceCount) return y.evidenceCount - x.evidenceCount;
    const xd = x.discoveredAt || "";
    const yd = y.discoveredAt || "";
    if (xd !== yd) return xd < yd ? -1 : 1;
    return String(x.prospectId) < String(y.prospectId) ? -1 : 1;
  })[0];
}

/**
 * Resolve duplicates across a set of records.
 *
 * Clusters are formed ONLY from links that are safe to form automatically
 * (exact duplicates). Everything weaker is reported as a pending relationship
 * for a founder to adjudicate — a "probable" link is never allowed to silently
 * collapse two records, because a wrong merge is invisible afterwards.
 *
 * Returns { clusters, pairs, pendingReview, canonicalOf, stats }.
 * Nothing is mutated; nothing is discarded.
 */
function resolveDuplicates(rawRecords) {
  const input = (Array.isArray(rawRecords) ? rawRecords : []).map(toRecord).filter(Boolean);

  // Deterministic order, so clustering and canonical choice cannot depend on
  // the order the caller happened to supply.
  const records = [...input].sort((x, y) => (String(x.prospectId) < String(y.prospectId) ? -1 : 1));

  const pairs = [];
  const pendingReview = [];

  // Union-find over auto-safe links only.
  const parent = new Map(records.map((r) => [r.prospectId, r.prospectId]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    // Lexicographic root keeps the structure order-independent.
    if (rx < ry) parent.set(ry, rx);
    else parent.set(rx, ry);
  };

  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      const result = compareRecords(a, b);
      if (result.decision === "distinct" || result.decision === "insufficient_evidence") continue;

      const pair = Object.freeze({
        a: a.prospectId,
        b: b.prospectId,
        aName: a.businessName,
        bName: b.businessName,
        ...result,
      });
      pairs.push(pair);

      if (result.autoConsolidationSafe) union(a.prospectId, b.prospectId);
      else if (result.founderReviewRequired) pendingReview.push(pair);
    }
  }

  // Build clusters from the auto-safe links.
  const grouped = new Map();
  for (const record of records) {
    const root = find(record.prospectId);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(record);
  }

  const clusters = [];
  const canonicalOf = new Map();

  for (const [, members] of [...grouped.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const canonical = pickCanonical(members);

    // TWO DIFFERENT KINDS OF DUPLICATE, and they must be counted differently.
    //
    // A1 derives prospectId from the identity fingerprint, so two records for
    // the same business in the same suburb ALREADY share an id — the store's
    // unique constraint would reject the second insert. Those are "identity
    // collisions": redundant records, not separate calling targets.
    //
    // A cluster can also hold records with genuinely different ids that were
    // linked by a shared number plus an agreeing ABN. Those are distinct rows
    // that must be consolidated so the business is dialled once.
    //
    // Counting only distinct ids would report the first kind as zero duplicates
    // removed, which is how a founder is told "nothing was merged" about a list
    // that contained the same business twice.
    const distinctIds = [...new Set(members.map((m) => m.prospectId))];
    const duplicateIds = distinctIds.filter((id) => id !== canonical.prospectId);
    const identityCollisions = members.length - distinctIds.length;

    for (const member of members) canonicalOf.set(member.prospectId, canonical.prospectId);

    clusters.push(
      Object.freeze({
        canonicalId: canonical.prospectId,
        canonicalName: canonical.businessName,
        memberIds: Object.freeze(members.map((m) => m.prospectId)),
        distinctIds: Object.freeze(distinctIds),
        duplicateIds: Object.freeze(duplicateIds),
        // Records beyond the canonical one, however they collided.
        redundantRecordCount: members.length - 1,
        identityCollisions,
        size: members.length,
        // EVERYTHING every member knew, preserved. Consolidating must never be
        // the reason a source URL or a discovered number stops existing.
        preserved: Object.freeze({
          numbers: Object.freeze([...new Set(members.flatMap((m) => m.numbers))].sort()),
          sourceRefs: Object.freeze(members.flatMap((m) => m.sourceRefs)),
          discoveredAt: Object.freeze(members.map((m) => ({ prospectId: m.prospectId, discoveredAt: m.discoveredAt }))),
          names: Object.freeze([...new Set(members.map((m) => m.businessName).filter(Boolean))]),
          abns: Object.freeze([...new Set(members.map((m) => m.abn).filter(Boolean))]),
        }),
        autoConsolidated: members.length > 1,
      })
    );
  }

  // Which records a founder must look at before the batch can be trusted.
  const needsReviewIds = new Set(pendingReview.flatMap((p) => [p.a, p.b]));

  return Object.freeze({
    clusters: Object.freeze(clusters),
    pairs: Object.freeze(pairs),
    pendingReview: Object.freeze(pendingReview),
    needsReviewIds: Object.freeze([...needsReviewIds].sort()),
    canonicalOf,
    stats: Object.freeze({
      records: records.length,
      clusters: clusters.length,
      // Every record beyond the canonical one in each cluster — whether it
      // collided on identity or was linked by shared evidence.
      exactDuplicatesRemoved: clusters.reduce((n, c) => n + c.redundantRecordCount, 0),
      identityCollisions: clusters.reduce((n, c) => n + c.identityCollisions, 0),
      pendingReview: pendingReview.length,
    }),
  });
}

/**
 * The duplicate status of ONE record, for the eligibility engine.
 * `blocked` is true when a founder must adjudicate before this record may be
 * called, or when it is a non-canonical member of a cluster (calling it would
 * dial the canonical record's number a second time).
 */
function duplicateStatusFor(prospectId, resolution) {
  if (!resolution) return Object.freeze({ blocked: false, code: "no_duplicate_analysis", message: "Duplicates have not been analysed.", requiresReview: false });

  const pending = resolution.pendingReview.filter((p) => p.a === prospectId || p.b === prospectId);
  if (pending.length > 0) {
    const first = pending[0];
    const other = first.a === prospectId ? first.bName : first.aName;
    return Object.freeze({
      blocked: true,
      requiresReview: true,
      code: "duplicate_requires_resolution",
      message: `This might be the same business as "${other}". ${first.reasons[0]} A person has to decide before either is called.`,
      relationships: Object.freeze(pending.map((p) => ({ with: p.a === prospectId ? p.b : p.a, decision: p.decision, label: p.label, strength: p.strength, reasons: p.reasons }))),
    });
  }

  const canonical = resolution.canonicalOf.get(prospectId);
  if (canonical && canonical !== prospectId) {
    return Object.freeze({
      blocked: true,
      requiresReview: false,
      code: "duplicate_of_canonical",
      message: `This is a duplicate of another record, which is the one that will be called. Calling both would dial the same business twice.`,
      canonicalId: canonical,
    });
  }

  return Object.freeze({ blocked: false, requiresReview: false, code: "unique", message: "No duplicate of this record was found.", canonicalId: prospectId });
}

module.exports = {
  compareRecords,
  resolveDuplicates,
  duplicateStatusFor,
  toRecord,
  distinctiveTokens,
  pickCanonical,
  DUPLICATE_DECISIONS,
  DUPLICATE_DECISION_LABELS,
  AUTO_CONSOLIDATION_SAFE,
  REVIEW_REQUIRED,
  STRENGTHS,
  GENERIC_TOKENS,
};
