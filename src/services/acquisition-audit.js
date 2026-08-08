// AIDA Locksmith Acquisition — the append-only decision log (A1).
//
//   createAuditLog({ now, sink })   an append-only, hash-chained decision log
//   log.record(entry)               write once; returns the frozen row
//   log.verifyChain()               detect any tampering after the fact
//
// This is G17 from docs/OUTBOUND_BDM_ARCHITECTURE.md — the append-only master
// audit that every gate decision, review decision and approval is written to.
// Where the evidence ledger (acquisition-evidence.js) records WHAT WE KNOW
// about a business, this records WHAT WE DECIDED and WHO DECIDED IT.
//
// The two are separate stores on purpose. Evidence is about the world and can
// legitimately be superseded when the world changes. Decisions are about us and
// can never be revised — "we approved this batch on the 3rd" does not stop
// being true because we later wish it were not.
//
// THE HASH CHAIN
// Each row carries the hash of the row before it. Removing or editing a row
// anywhere in the log breaks every hash after it, and verifyChain() finds the
// exact index where the break starts. This does not make tampering impossible —
// nothing in a single process can — but it makes silent tampering impossible,
// which is the property an audit trail actually needs. It also catches the
// far more likely case: a storage bug that drops or reorders rows.
//
// Like the evidence ledger: no update, no delete, deep-frozen rows, and a
// failing sink fails the write rather than being swallowed.
//
// Dep-free apart from node:crypto (core). See test/acquisition-audit.test.js.

const crypto = require("node:crypto");
const S = require("./acquisition-schema");
const { stableStringify } = require("./acquisition-evidence");

const MAX_TEXT = 1000;

// What kind of thing a decision is about.
//
// `queue` was added in M8B. Reserving a prospect for a worker, releasing it and
// completing it are decisions about who was going to be called and by whom, so
// they belong in this chain alongside the review and gate decisions rather than
// in a second log that could disagree with it.
const AUDIT_ENTITY_TYPES = Object.freeze(["prospect", "phone", "batch", "queue", "suppression", "campaign", "system"]);

// The decision itself. PASS/VETO/DEFER mirror the compliance-engine vocabulary
// so the gate stack and this log speak the same language; the rest cover events
// that are recorded but are not gate outcomes.
const AUDIT_DECISIONS = Object.freeze(["pass", "veto", "defer", "approve", "reject", "record", "error"]);

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  }
  return value;
}

const GENESIS_HASH = "0".repeat(64);

function hashRow(row) {
  return crypto.createHash("sha256").update(stableStringify(row)).digest("hex");
}

/**
 * Recompute a chain of audit rows and report the first break.
 *
 * A PURE FUNCTION over rows, deliberately: the rows that most need verifying
 * are the ones read back OUT of a durable store, long after the process that
 * wrote them exited. A verifier that only works on an in-memory log can never
 * catch the tampering that actually matters.
 *
 * Returns { ok:true } or { ok:false, brokenAt, message } where `brokenAt` is
 * the index of the FIRST row that does not verify.
 */
function verifyRows(rows) {
  if (!Array.isArray(rows)) return { ok: false, brokenAt: -1, message: "Audit rows must be a list." };
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== "object") {
      return { ok: false, brokenAt: i, message: `Audit row ${i} is not a record.` };
    }
    const { entryHash, auditId, ...body } = row;
    if (body.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, message: `Audit row ${i} does not follow the row before it — the log has been altered, reordered, or had a row removed.` };
    }
    if (hashRow(body) !== entryHash) {
      return { ok: false, brokenAt: i, message: `Audit row ${i} does not match its own hash — its contents have been altered.` };
    }
    expectedPrev = entryHash;
  }
  return { ok: true };
}

/**
 * Create an append-only, hash-chained decision log.
 *
 * @param {function} now      injected clock, () => Date
 * @param {function} [sink]   durable store; if it throws, the write is refused
 */
/**
 * @param {function} now
 * @param {function} [sink]           durable store; if it throws, the write is refused
 * @param {string}   [initialHead]    the entryHash of the last PERSISTED row (M8H)
 * @param {number}   [initialSequence] that row's sequence (M8H)
 *
 * ── CONTINUING A CHAIN ACROSS A RESTART (M8H) ───────────────────────
 * Until M8H nothing persisted decisions, so the chain only ever lived inside
 * one process and starting from genesis every time was correct. A durable
 * review queue changes that: a fresh process appending a resolution must
 * continue the chain it finds rather than begin a second one, or verifyRows()
 * would correctly report the combined log as altered.
 *
 * So `initialHead` and `initialSequence` are read from the last stored row.
 * verifyRows() is unchanged and still validates the whole sequence — hydration
 * makes a restart continuous, it does not make verification more forgiving.
 *
 * ── HYDRATION IS STILL NOT, BY ITSELF, CONCURRENCY SAFETY (M8I) ─────
 * This function will happily mint a successor to whatever head it was handed.
 * Two callers handed the same head both produce a row claiming the same
 * prev_hash, and nothing here can tell that apart from ordinary use — which is
 * correct, because the log is not the right place to arbitrate.
 *
 * The arbitration is one line of SQL: `unique (prev_hash)` on
 * acquisition_decisions (laq3, applied to dev in M8I). The database permits
 * exactly one successor per head and the loser gets a 23505; the retry that
 * turns that refusal into a correct outcome lives in
 * acquisition-decision-log.js. Read the head with store.readChainHead(), never
 * off the end of a listDecisions() page — that call is capped, and at the cap
 * the last element is the last of the PAGE, not of the chain.
 *
 * M8H's SINGLE WRITER limitation is closed. Note that an advisory lock, a
 * serialisable transaction and a chain-head row were each considered and
 * rejected: all three assume a client that can hold a transaction open across
 * calls, and PostgREST cannot. See spec §40.2.
 */
function createAuditLog({ now, sink = null, initialHead = null, initialSequence = 0 } = {}) {
  if (typeof now !== "function") {
    throw new Error("createAuditLog requires an injected now() — audit timestamps must be deterministic in tests.");
  }
  if (sink !== null && typeof sink !== "function") {
    throw new Error("createAuditLog sink must be a function when provided.");
  }
  if (initialHead !== null && (typeof initialHead !== "string" || !/^[0-9a-f]{64}$/.test(initialHead))) {
    throw new Error("createAuditLog initialHead must be a 64-character hash from the last persisted row.");
  }
  if (!Number.isInteger(initialSequence) || initialSequence < 0) {
    throw new Error("createAuditLog initialSequence must be the last persisted row's sequence.");
  }
  if (initialHead !== null && initialSequence === 0) {
    // A hydrated chain that claims to start at sequence zero is describing a
    // head that cannot exist. Refused rather than written and discovered by a
    // verifier later.
    throw new Error("createAuditLog was given an initialHead but sequence 0 — a continued chain has a non-zero sequence.");
  }

  const rows = [];
  let sequence = initialSequence;
  let lastHash = initialHead === null ? GENESIS_HASH : initialHead;

  function record(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      const err = new Error("An audit entry must be an object.");
      err.code = "entry_invalid";
      throw err;
    }

    const entityType = entry.entityType;
    if (!AUDIT_ENTITY_TYPES.includes(entityType)) {
      const err = new Error(`"${String(entityType).slice(0, 40)}" is not something this log records decisions about.`);
      err.code = "entity_type_unknown";
      throw err;
    }

    const decision = entry.decision;
    if (!AUDIT_DECISIONS.includes(decision)) {
      const err = new Error(`"${String(decision).slice(0, 40)}" is not a decision this log understands.`);
      err.code = "decision_unknown";
      throw err;
    }

    const entityId = clip(entry.entityId, 120);
    if (!entityId) {
      const err = new Error("An audit entry must say which thing it is about.");
      err.code = "entity_id_missing";
      throw err;
    }

    const event = clip(entry.event, 120);
    if (!event) {
      const err = new Error("An audit entry must name the event.");
      err.code = "event_missing";
      throw err;
    }

    // WHO. A decision with no actor is unattributable, and an unattributable
    // approval is indistinguishable from one nobody made.
    const actor = clip(entry.actor, 120);
    if (!actor) {
      const err = new Error("An audit entry must record who or what made the decision.");
      err.code = "actor_missing";
      throw err;
    }

    // WHY. Enforced for the same reason: "veto" with no reason cannot be acted
    // on, argued with, or explained to a regulator.
    const reason = clip(entry.reason, MAX_TEXT);
    if (!reason) {
      const err = new Error("An audit entry must record why.");
      err.code = "reason_missing";
      throw err;
    }

    sequence += 1;
    const body = {
      schemaVersion: S.SCHEMA_VERSION,
      sequence,
      recordedAt: now().toISOString(),
      entityType,
      entityId,
      event,
      decision,
      actor,
      // Whether a human or the system decided. Recorded separately from the
      // actor name because "who" and "was it a person" are different questions
      // and the second one is the one that matters for an approval.
      actorKind: entry.actorKind === "human" ? "human" : "system",
      reason,
      // Structured proof, not a log string — the artifact a complaint is
      // answered with. Frozen with the row.
      detail: entry.detail && typeof entry.detail === "object" ? entry.detail : null,
      correlationId: clip(entry.correlationId, 120),
      prevHash: lastHash,
    };

    const entryHash = hashRow(body);
    const row = deepFreeze({ ...body, entryHash, auditId: `au_${entryHash.slice(0, 20)}` });

    // Durable-before-visible, exactly as the evidence ledger.
    if (sink) sink(row);

    rows.push(row);
    lastHash = entryHash;
    return row;
  }

  function forEntity(entityType, entityId) {
    const id = clip(entityId, 120);
    return Object.freeze(rows.filter((r) => r.entityType === entityType && r.entityId === id));
  }

  function forCorrelation(correlationId) {
    const id = clip(correlationId, 120);
    return Object.freeze(rows.filter((r) => r.correlationId === id));
  }

  return Object.freeze({
    record,
    verifyChain: () => verifyRows(rows),
    forEntity,
    forCorrelation,
    all: () => Object.freeze([...rows]),
    count: () => rows.length,
    headHash: () => lastHash,
  });
}

module.exports = {
  createAuditLog,
  verifyRows,
  AUDIT_ENTITY_TYPES,
  AUDIT_DECISIONS,
  GENESIS_HASH,
};
