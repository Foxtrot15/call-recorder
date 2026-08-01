// AIDA Locksmith Acquisition — the append-only evidence ledger (A1).
//
//   createEvidenceLedger({ now, sink })   an append-only store
//   ledger.record(entry)                  write once; returns the frozen row
//   ledger.forProspect(id)                read back, in write order
//
// This is the artifact that answers "why did AIDA call this business?" — and,
// if it ever comes to it, the artifact a regulator complaint is answered with.
// docs/OUTBOUND_BDM_COMPLIANCE_ENGINE.md §6 makes the contract explicit:
// append-only, write-once, durable before the caller proceeds, and ON THE
// CRITICAL PATH — a failed evidence write must fail the operation it was
// evidencing, never be swallowed.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT HAVE
// There is no update method. There is no delete method. There is no "correct
// this row" affordance. An audit trail you can amend is not an audit trail —
// so a mistaken entry is superseded by a NEW entry (supersedes: <id>) and both
// remain visible. That is a domain decision encoded as a missing function,
// which is much harder to undo by accident than a comment asking people not to.
//
// Rows are deep-frozen on the way out, so a caller that tries to patch a
// returned row mutates nothing (and throws in strict mode). Tests assert this.
//
// Dep-free apart from node:crypto, which is core. Nothing here touches the
// network or the DB; a real store plugs in via the injected `sink`.
// See test/acquisition-evidence.test.js.

const crypto = require("node:crypto");
const S = require("./acquisition-schema");
const { classifySource } = require("./acquisition-source");

// Bound the size of anything we store verbatim. An evidence excerpt is proof of
// what a page said, not a copy of the page.
const MAX_VALUE_LENGTH = 500;
const MAX_EXCERPT_LENGTH = 1000;
const MAX_NOTE_LENGTH = 500;

/** Deep-freeze so a returned row cannot be edited through a nested object. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  }
  return value;
}

// How deep a hashable structure may be. Evidence values and audit `detail`
// blobs are caller-supplied, and a cyclic or pathologically nested object would
// otherwise recurse until the stack blows — a RangeError from inside the
// hashing helper, which tells whoever hits it nothing at all.
const MAX_HASH_DEPTH = 32;

/**
 * Stable stringify: keys sorted at every level, so two logically identical
 * entries hash identically regardless of property insertion order. Without
 * this, the content hash would depend on how the caller happened to build the
 * object, and duplicate detection would silently stop working.
 *
 * Refuses cycles and excessive depth with a NAMED domain error rather than a
 * stack overflow. Both stores hash caller-supplied structures on the write
 * path, so this is the difference between "your detail object has a cycle" and
 * an unexplained crash mid-write.
 */
function stableStringify(value, depth = 0, seen = null) {
  if (depth > MAX_HASH_DEPTH) {
    const err = new Error(`Cannot hash a structure more than ${MAX_HASH_DEPTH} levels deep.`);
    err.code = "value_too_deep";
    throw err;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  // Cycle detection tracks the CURRENT PATH, not every object ever visited, so
  // the same object appearing twice as siblings stays legal — that is a normal
  // shape (two claims citing one source object), not a cycle.
  const path = seen || new Set();
  if (path.has(value)) {
    const err = new Error("Cannot hash a structure that contains a cycle.");
    err.code = "value_cyclic";
    throw err;
  }
  path.add(value);

  let out;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => stableStringify(v, depth + 1, path)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], depth + 1, path)}`).join(",")}}`;
  }

  path.delete(value);
  return out;
}

function contentHash(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 32);
}

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function isIsoInstant(value) {
  if (typeof value !== "string") return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/**
 * Validate an evidence entry before it is written.
 * Returns { ok:true, clean } or { ok:false, code, message }.
 */
function validateEntry(entry, { config }) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, code: "entry_invalid", message: "An evidence entry must be an object." };
  }

  const prospectId = clip(entry.prospectId, 120);
  if (!prospectId) return { ok: false, code: "prospect_id_missing", message: "Evidence must say which prospect it is about." };

  if (!S.EVIDENCE_KINDS.includes(entry.kind)) {
    return { ok: false, code: "kind_unknown", message: `"${String(entry.kind).slice(0, 40)}" is not a kind of evidence this system records.` };
  }

  if (!S.CAPTURE_MODES.includes(entry.captureMode)) {
    return { ok: false, code: "capture_mode_unknown", message: `"${String(entry.captureMode).slice(0, 40)}" is not a way this system can capture evidence.` };
  }

  // The offline boundary, enforced at the point of storage rather than only at
  // the point of fetching. Even if a future adapter forgot its gate, the
  // evidence it produced cannot be written.
  if (entry.captureMode === "live_fetch") {
    return {
      ok: false,
      code: "live_capture_unavailable",
      message: "This build cannot capture evidence from a live website. Evidence must come from a fixture, an operator entry, or an import.",
    };
  }

  const value = clip(entry.value, MAX_VALUE_LENGTH);
  if (!value) return { ok: false, code: "value_missing", message: "Evidence must record what was actually observed." };

  const observedAt = entry.observedAt;
  if (!isIsoInstant(observedAt)) {
    return { ok: false, code: "observed_at_invalid", message: "Evidence must carry a valid observation timestamp." };
  }

  // Source is mandatory: evidence without provenance is an assertion, and the
  // entire point of this ledger is that assertions are not evidence.
  const source = classifySource(entry.source);
  if (!source.ok) {
    return { ok: false, code: "source_invalid", message: `The source for this evidence could not be used: ${source.message}` };
  }

  const capturedBy = clip(entry.capturedBy, 120);
  if (!capturedBy) return { ok: false, code: "captured_by_missing", message: "Evidence must record who or what captured it." };

  return {
    ok: true,
    clean: {
      prospectId,
      kind: entry.kind,
      captureMode: entry.captureMode,
      value,
      excerpt: clip(entry.excerpt, MAX_EXCERPT_LENGTH),
      note: clip(entry.note, MAX_NOTE_LENGTH),
      observedAt: new Date(observedAt).toISOString(),
      capturedBy,
      supersedes: clip(entry.supersedes, 120),
      source: {
        sourceType: source.sourceType,
        official: source.official,
        url: source.url,
        domain: source.domain,
        register: source.register,
        identifier: source.identifier,
        label: source.label,
        caveats: source.caveats,
      },
      // Fixture-derived evidence is labelled forever. A later screen that shows
      // a prospect can then say out loud that nothing here was verified by a
      // human, which is the difference between a demo and a claim.
      authoritative: entry.captureMode === "operator_entry" || entry.captureMode === "operator_import",
    },
  };
}

/**
 * Create an append-only evidence ledger.
 *
 * @param {object}   opts
 * @param {function} opts.now    () => Date. Injected — never read the clock
 *                               directly, so freshness logic is testable
 *                               against a frozen clock (the same rule the
 *                               compliance engine doc imposes on gates).
 * @param {function} [opts.sink] optional (row) => void|Promise. A durable
 *                               store. If it throws, record() throws — the
 *                               write is NOT kept in memory, so the ledger
 *                               never disagrees with the durable store.
 * @param {object}   [opts.config] acquisition config (reserved; carried for
 *                               future gates that vary by mode)
 */
function createEvidenceLedger({ now, sink = null, config = null } = {}) {
  if (typeof now !== "function") {
    throw new Error("createEvidenceLedger requires an injected now() — evidence timestamps must be deterministic in tests.");
  }
  if (sink !== null && typeof sink !== "function") {
    throw new Error("createEvidenceLedger sink must be a function when provided.");
  }

  const rows = [];
  let sequence = 0;

  function record(entry) {
    const validated = validateEntry(entry, { config });
    if (!validated.ok) {
      // Refusing to write is a hard failure, not a warning. A caller that
      // wanted evidence and did not get it must not proceed as though it did.
      const err = new Error(validated.message);
      err.code = validated.code;
      throw err;
    }

    const clean = validated.clean;
    const recordedAt = now().toISOString();

    // A superseding entry must point at a row that exists, or the audit trail
    // has a dangling reference and nobody can reconstruct the correction.
    if (clean.supersedes && !rows.some((r) => r.evidenceId === clean.supersedes)) {
      const err = new Error(`This entry says it supersedes "${clean.supersedes}", but no such evidence exists.`);
      err.code = "supersedes_unknown";
      throw err;
    }

    sequence += 1;
    const payload = { ...clean, recordedAt, sequence };
    const evidenceId = `ev_${contentHash(payload)}`;

    const row = deepFreeze({
      evidenceId,
      schemaVersion: S.SCHEMA_VERSION,
      sequence,
      recordedAt,
      contentHash: contentHash(clean),
      ...clean,
    });

    // Durable-before-visible: if the sink rejects, the row never enters `rows`.
    // The alternative — keep it in memory and retry later — is how a system
    // ends up believing it has evidence it never persisted.
    if (sink) sink(row);

    rows.push(row);
    return row;
  }

  function forProspect(prospectId) {
    const id = clip(prospectId, 120);
    return Object.freeze(rows.filter((r) => r.prospectId === id));
  }

  function byKind(prospectId, kind) {
    return Object.freeze(forProspect(prospectId).filter((r) => r.kind === kind));
  }

  /** Rows that have not been superseded by a later entry. */
  function currentForProspect(prospectId) {
    const all = forProspect(prospectId);
    const superseded = new Set(all.map((r) => r.supersedes).filter(Boolean));
    return Object.freeze(all.filter((r) => !superseded.has(r.evidenceId)));
  }

  return Object.freeze({
    record,
    forProspect,
    currentForProspect,
    byKind,
    all: () => Object.freeze([...rows]),
    count: () => rows.length,
  });
}

/**
 * Which required evidence a prospect holds, and what is still missing.
 * Used by review (to decide whether approval may even be offered) and by
 * eligibility (as a gate).
 */
function assessEvidence(evidenceRows) {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  const byKind = new Map();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind).push(row);
  }

  const missing = S.REQUIRED_EVIDENCE_KINDS.filter((kind) => !byKind.has(kind));
  const officialBacked = rows.filter((r) => r.source && r.source.official);
  const authoritative = rows.filter((r) => r.authoritative);

  // The phone number is the one fact where an unofficial source is not merely
  // weaker — it is the specific failure the design exists to prevent. Called
  // out separately so it can never be averaged away into an overall score.
  const phoneRows = byKind.get("phone") || [];
  const phoneFromOfficialSource = phoneRows.some((r) => r.source && r.source.official);

  return Object.freeze({
    kinds: Object.freeze([...byKind.keys()]),
    missingRequired: Object.freeze(missing),
    hasAllRequired: missing.length === 0,
    total: rows.length,
    officialBackedCount: officialBacked.length,
    hasOfficialBacking: officialBacked.length > 0,
    authoritativeCount: authoritative.length,
    // True only when a human actually verified something.
    humanVerified: authoritative.length > 0,
    phoneEvidenceCount: phoneRows.length,
    phoneFromOfficialSource,
  });
}

module.exports = {
  createEvidenceLedger,
  assessEvidence,
  validateEntry,
  contentHash,
  stableStringify,
  MAX_VALUE_LENGTH,
};
