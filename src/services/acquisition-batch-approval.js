// AIDA Locksmith Acquisition — durable founder batch approval (E-5).
//
//   canonicalBatchIdentity({ members, ... })      what exactly is being approved
//   membersFromBatch(batch)                       the included rows, as members
//   recordBatchApproval({ store, now, ... })      the durable, append-only YES
//   loadBatchApproval({ store, batchKey })        the authoritative read
//   listBatchApprovals({ store })                 every batch ever approved
//   revokeBatchApproval({ store, now, ... })      withdraw, without erasing
//   resolveBatchApprovalForProspect({ ... })      what the M8E gate asks
//
// Until E-5 the founder's approval lived in the object the caller passed:
// `context.batch = { approved: true }`. It was checked, it was hashed, and it
// died with the process. Nothing could answer, afterwards, WHICH businesses a
// given approval had actually covered — the same gap E-2 closed for review
// decisions, on the one artifact that says a human said yes.
//
// ── WHAT A BATCH APPROVAL MEANS, AND WHAT IT DOES NOT ───────────────
// It means: THE FOUNDER APPROVED THIS EXACT SET OF BUSINESSES, ON THESE EXACT
// NUMBERS, FOR CONSIDERATION.
//
// It is NOT permission to dial. It never becomes permission to dial. Every
// actual call must still pass DNCR, suppression, the calling window, holidays,
// the attempt policy, duplicate and review state, lifecycle, campaign and kill
// switch, AND the M8E final gate, all evaluated at the instant of the call.
// Only that gate mints an AuthorisedDial. A batch approval that outranked any
// of those would be a compliance snapshot with a long shelf life, which is the
// precise thing this project refuses to build.
//
// ── NO NEW TABLE, AND THE REASON IS NOT LAZINESS ────────────────────
// An approval is a DECISION. `acquisition_decisions` is the append-only,
// hash-chained ledger this repository already keeps decisions in; its
// `entity_type` CHECK has admitted 'batch' since laq1, its `detail` column is
// jsonb, and `(entity_type, entity_id)` is indexed. laq3's `unique (prev_hash)`
// already makes concurrent appends safe.
//
// So a durable approval is two possible rows for one entity:
//
//   batch_approval_recorded   decision: approve   who, when, and the exact
//                                                 membership and hash approved
//   batch_approval_withdrawn  decision: reject    who withdrew it, and why
//
// Current state is a fold over the rows for one entity_id — exactly how the
// review queue (M8H), suppression and outcomes already work. A `batches` table
// with an `approved` boolean would have been a status column over a decision,
// and this project's rule is that decisions are appended, never edited.
//
// ── IDENTITY IS THE CONTENT, NOT A NAME ─────────────────────────────
// entity_id is `ba_<membershipHash>`, derived from the membership itself. A
// changed batch is therefore a DIFFERENT entity with no approval of its own,
// and no amount of replaying an old approval object can reach it. A random
// batch id would have protected nothing: it would name a container whose
// contents could be swapped after the founder looked at them.
//
// ── AND THE HASH DELIBERATELY EXCLUDES COMPLIANCE STATE ─────────────
// THE MOST IMPORTANT DESIGN DECISION IN THIS FILE.
//
// acquisition-batch.js's `batchHash` covers each row's eligibility code as well
// as its identity, which is right for the founder's screen: it answers "has
// anything changed since you looked at this?".
//
// It is WRONG as the thing a durable approval binds to. A DNCR wash expiring, a
// suppression arriving, an attempt cap filling up or a calling window closing
// would all change that hash, and the batch would read as STALE — as though the
// founder's decision had gone bad, when in fact the membership is exactly what
// they approved and it is the world that moved. The founder would be asked to
// re-approve an unchanged list, and would learn to do it without looking.
//
// So `membershipHash` covers only WHO and ON WHAT NUMBER, plus the schema,
// campaign and policy version. That gives two distinct, separately reportable
// states, which is the distinction E-5 exists to draw:
//
//   BATCH STALE                      the membership changed. The approval does
//                                    not cover this list. Re-approve.
//   APPROVED, PROSPECT INELIGIBLE    the membership is exactly what was
//                                    approved; something else refuses the call
//                                    right now. Nothing to re-approve.
//
// ── FAIL CLOSED, AND SAY WHOSE FAULT IT IS ──────────────────────────
// An unreadable approval store yields `batch_approval_store_unavailable`, never
// "not approved". The two are different facts: one is about this batch, the
// other is about us, and reporting ours as theirs would send a founder looking
// for an approval that already exists.
//
// Pure apart from the injected store. See test/acquisition-batch-approval.test.js.

const { contentHash } = require("./acquisition-evidence");
const { assertStoreContract } = require("./acquisition-store");
const { appendDecisionSerialised, ChainContentionError } = require("./acquisition-decision-log");
const { DEFAULT_CAPS } = require("../config/acquisition");
const S = require("./acquisition-schema");

/** The shape of the durable record. Bumped only when the fold has to change. */
const APPROVAL_SCHEMA_VERSION = "acq-batch-approval-1";

const ENTITY_TYPE = "batch";

// Deliberately NOT `batch_approved` / `batch_approval_revoked`. Those two names
// are already used by acquisition-batch.js's in-process audit entries, which are
// a record of what happened inside one session and are NOT authority. If a
// future path ever persists those, they must not be mistaken for this. A test
// pins that a `batch_approved` row confers nothing.
const EVENT_APPROVED = "batch_approval_recorded";
const EVENT_WITHDRAWN = "batch_approval_withdrawn";

const BATCH_APPROVAL_CODES = Object.freeze({
  /** A durable approval exists and covers exactly this membership. */
  CURRENT: "batch_approval_current",
  /** No durable approval exists for this membership. */
  MISSING: "founder_batch_approval_missing",
  /** An approval exists for this batch label, but not for these contents. */
  STALE: "batch_membership_changed",
  /** It existed and a human withdrew it. */
  WITHDRAWN: "batch_approval_withdrawn",
  /** The approval is real but this prospect is not in it. */
  NOT_A_MEMBER: "prospect_not_in_approved_batch",
  /** OUR failure, never a finding about the batch. */
  STORE_UNAVAILABLE: "batch_approval_store_unavailable",
});

const STATUS = Object.freeze({ APPROVED: "approved", WITHDRAWN: "withdrawn", NONE: "none", UNKNOWN: "unknown" });

const MAX_TEXT = 500;

function clip(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Names that must never appear as a batch approver.
 *
 * Batch approval is the one decision in this pipeline that exists ONLY to be a
 * human's. A system actor approving a batch would make the check self-satisfying
 * — the pipeline asking itself for permission and receiving it. The list covers
 * the obvious impersonations rather than pretending to be exhaustive; the real
 * protection is that `actorKind` is written as `human` and nothing here can set
 * it to anything else.
 */
const NON_HUMAN_APPROVERS = /^(system|automation|automated|auto|aida|bot|robot|ai|agent|assistant|claude|gpt|llm|service|cron|scheduler|worker|daemon)$/i;

// ── Canonical identity ──────────────────────────────────────────────

/**
 * One member of a batch: a business and the number that would be dialled.
 *
 * `rowId` and not `prospectId` alone, because A1 derives prospectId from the
 * identity fingerprint and two records for the same business in the same suburb
 * share one. Keying membership by prospectId would silently collapse two rows
 * into one and change the hash depending on which survived.
 */
function normaliseMember(raw) {
  if (!raw || typeof raw !== "object") return null;
  const prospectId = clip(raw.prospectId, 120);
  const rowId = clip(raw.rowId, 140) || prospectId;
  const e164 = clip(raw.e164 || raw.canonicalNumber, 40);
  if (!prospectId || !rowId || !e164) return null;
  return { rowId, prospectId, e164 };
}

/** The included rows of an assembled batch, as members. */
function membersFromBatch(batch) {
  if (!batch || !Array.isArray(batch.rows)) return [];
  return batch.rows
    .filter((r) => r.disposition === "included")
    .map((r) => normaliseMember({ rowId: r.rowId, prospectId: r.prospectId, e164: r.canonicalNumber }))
    .filter(Boolean);
}

/**
 * The deterministic identity of exactly what a founder would be approving.
 *
 * DETERMINISTIC MEANS DETERMINISTIC: no clock, no random id, no assembly
 * timestamp, no incidental ordering. The same businesses on the same numbers
 * under the same campaign and policy always produce the same key, in any
 * process, in any order, on any day. That is what makes an approval recorded on
 * Monday recognisable on Friday by a process that has never seen the batch.
 *
 * @param {Array}  members        [{ rowId, prospectId, e164 }]
 * @param {string} [campaignId]   part of the contract if a campaign is named
 * @param {string} [policyVersion]
 * @param {string} [label]        a human name. NOT part of the hash — renaming
 *                                a batch must not invalidate an approval, and
 *                                naming two different lists the same thing must
 *                                not make them one.
 * @param {number} [maxBatchSize] the pilot ceiling; A-L9 owns raising it
 */
function canonicalBatchIdentity({ members, campaignId = null, policyVersion = null, label = null, maxBatchSize = DEFAULT_CAPS.maxBatchSize } = {}) {
  const list = Array.isArray(members) ? members.map(normaliseMember) : null;

  if (!list || list.length === 0) {
    return { ok: false, code: "batch_empty", message: "A batch has to contain at least one business with a callable number." };
  }
  const bad = list.findIndex((m) => m === null);
  if (bad !== -1) {
    return { ok: false, code: "member_invalid", message: `Row ${bad + 1} of this batch has no prospect id or no number, so it cannot be part of what is approved.` };
  }

  const seen = new Set();
  for (const m of list) {
    if (seen.has(m.rowId)) {
      return { ok: false, code: "member_duplicated", message: `"${m.rowId}" appears twice in this batch. A membership has to name each row once.` };
    }
    seen.add(m.rowId);
  }

  // THE PILOT CEILING, ENFORCED RATHER THAN DOCUMENTED (L). maxBatchSize was a
  // config value nothing read. Approving one batch must not become a way to
  // approve a larger one than the configured maximum permits.
  const ceiling = Number.isInteger(maxBatchSize) && maxBatchSize > 0 ? maxBatchSize : DEFAULT_CAPS.maxBatchSize;
  if (list.length > ceiling) {
    return {
      ok: false,
      code: "batch_too_large",
      message: `This batch holds ${list.length} businesses and the approved maximum is ${ceiling}. Split it, or raise the ceiling deliberately — A-L9 is the open question about who may approve batches above the pilot size, and it has not been answered.`,
      recordCount: list.length,
      maxBatchSize: ceiling,
    };
  }

  // Canonical order. Sorting by rowId, which is unique within a batch, so the
  // material cannot depend on the order the caller happened to hold them in.
  const ordered = [...list].sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));

  const membershipHash = contentHash({
    v: APPROVAL_SCHEMA_VERSION,
    schemaVersion: S.SCHEMA_VERSION,
    campaignId: campaignId || null,
    policyVersion: policyVersion || null,
    // WHO, and ON WHAT NUMBER. Nothing about whether they may be called today —
    // see the header. Compliance is re-derived at M8E, every time.
    members: ordered,
  });

  return Object.freeze({
    ok: true,
    approvalSchemaVersion: APPROVAL_SCHEMA_VERSION,
    schemaVersion: S.SCHEMA_VERSION,
    batchKey: `ba_${membershipHash}`,
    membershipHash,
    campaignId: campaignId || null,
    policyVersion: policyVersion || null,
    label: clip(label, 120),
    maxBatchSize: ceiling,
    recordCount: ordered.length,
    members: Object.freeze(ordered.map((m) => Object.freeze({ ...m }))),
  });
}

/**
 * Re-derive an identity's hash from its own members and check it matches.
 *
 * A hand-built `{ batchKey, members }` is not an identity; it is a claim. This
 * is what makes the claim checkable, so nothing can approve one membership under
 * another one's key.
 */
function verifyIdentity(identity) {
  if (identity && identity.ok === false && typeof identity.code === "string") {
    // A refusal from canonicalBatchIdentity, handed straight on. Passed through
    // rather than flattened into "identity_invalid": an operator who assembled
    // 26 businesses needs to be told the ceiling is 25, not that their object
    // is the wrong shape.
    return identity;
  }
  if (!identity || identity.ok !== true || !identity.batchKey) {
    return { ok: false, code: "identity_invalid", message: "A batch approval needs an identity from canonicalBatchIdentity()." };
  }
  // ── THE CEILING IS RE-DERIVED, NEVER TAKEN FROM THE IDENTITY ──────
  //
  // maxBatchSize is deliberately NOT part of the hash — it is policy, not
  // membership, and a ceiling change must not invalidate an existing approval.
  // The cost is that an identity could carry `maxBatchSize: 1000` and still hash
  // correctly, so trusting the field here would let a caller raise the pilot
  // ceiling simply by writing a larger number on the object.
  //
  // So it is clamped: a caller may be STRICTER than the configured maximum and
  // never looser — the same rule A-L4 applies to attempt caps.
  const claimed = Number.isInteger(identity.maxBatchSize) && identity.maxBatchSize > 0 ? identity.maxBatchSize : DEFAULT_CAPS.maxBatchSize;
  const rebuilt = canonicalBatchIdentity({
    members: identity.members,
    campaignId: identity.campaignId,
    policyVersion: identity.policyVersion,
    label: identity.label,
    maxBatchSize: Math.min(claimed, DEFAULT_CAPS.maxBatchSize),
  });
  if (!rebuilt.ok) return rebuilt;
  if (rebuilt.batchKey !== identity.batchKey || rebuilt.membershipHash !== identity.membershipHash) {
    return {
      ok: false,
      code: "identity_mismatch",
      message: `This batch identity does not match its own membership: it claims ${identity.batchKey} and its ${identity.members.length} members hash to ${rebuilt.batchKey}. Re-derive it rather than editing it.`,
    };
  }
  return rebuilt;
}

// ── The durable read ────────────────────────────────────────────────

/** Fold one batch's rows into its current approval state. */
function foldApproval(rows, batchKey) {
  const relevant = rows
    .filter((r) => r.event === EVENT_APPROVED || r.event === EVENT_WITHDRAWN)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));

  if (relevant.length === 0) {
    return Object.freeze({ available: true, reason: null, batchKey, status: STATUS.NONE, approval: null, history: Object.freeze([]) });
  }

  const last = relevant[relevant.length - 1];
  const lastApproved = [...relevant].reverse().find((r) => r.event === EVENT_APPROVED) || null;

  const history = Object.freeze(
    relevant.map((r) => Object.freeze({ event: r.event, actor: r.actor, actorKind: r.actorKind, reason: r.reason, at: r.recordedAt, auditId: r.auditId }))
  );

  if (last.event === EVENT_WITHDRAWN) {
    return Object.freeze({
      available: true,
      reason: null,
      batchKey,
      status: STATUS.WITHDRAWN,
      approval: null,
      withdrawnBy: last.actor,
      withdrawnAt: last.recordedAt,
      withdrawnReason: last.reason,
      // The approval that WAS given is kept and readable. It happened.
      previousApproval: lastApproved ? approvalFromRow(lastApproved) : null,
      history,
    });
  }

  return Object.freeze({
    available: true,
    reason: null,
    batchKey,
    status: STATUS.APPROVED,
    approval: approvalFromRow(last),
    history,
  });
}

/** One durable row, as the approval it records. */
function approvalFromRow(row) {
  const d = row.detail || {};
  return Object.freeze({
    batchKey: d.batchKey || row.entityId,
    membershipHash: d.membershipHash || null,
    approvalSchemaVersion: d.approvalSchemaVersion || null,
    label: d.label || null,
    campaignId: d.campaignId || null,
    policyVersion: d.policyVersion || null,
    recordCount: Number.isFinite(d.recordCount) ? d.recordCount : Array.isArray(d.members) ? d.members.length : 0,
    maxBatchSize: Number.isFinite(d.maxBatchSize) ? d.maxBatchSize : null,
    members: Object.freeze(Array.isArray(d.members) ? d.members.map((m) => Object.freeze({ ...m })) : []),
    approvedBy: row.actor,
    approvedAt: row.recordedAt,
    approverKind: row.actorKind,
    reason: row.reason,
    note: d.note || null,
    auditId: row.auditId,
    sequence: row.sequence,
    authorises: d.authorises || null,
  });
}

/**
 * The authoritative state of one batch, read from the store every time.
 *
 * NEVER THROWS ON A READ FAILURE. It returns `available: false`, because the
 * caller that matters is the pre-dial gate and a thrown error there is far too
 * easy to catch into "not approved". See resolveBatchApprovalForProspect.
 */
async function loadBatchApproval({ store, batchKey } = {}) {
  assertStoreContract(store, "batch approval store");
  const key = clip(batchKey, 140);
  if (!key) {
    return Object.freeze({ available: true, reason: null, batchKey: null, status: STATUS.NONE, approval: null, history: Object.freeze([]) });
  }
  let rows;
  try {
    rows = await store.listDecisions({ entityType: ENTITY_TYPE, entityId: key });
  } catch (err) {
    return Object.freeze({ available: false, reason: err.message, batchKey: key, status: STATUS.UNKNOWN, approval: null, history: Object.freeze([]) });
  }
  return foldApproval(rows || [], key);
}

/**
 * Every batch this store has ever been told about, newest approval first.
 *
 * Folds the log in memory, exactly as listReviewItems does, and is honestly
 * bounded for the same reason: at pilot volume a batch is 25 businesses and
 * there are a handful of batches. A campaign with thousands would want the fold
 * materialised.
 *
 * THE CAP FAILS IN THE SAFE DIRECTION, which is why it is acceptable rather
 * than merely acknowledged. If an approval falls outside the page, the search
 * path does not find it and the gate REFUSES — an approved business reads as
 * un-approved, never the reverse. The named-batch path is unaffected: it filters
 * on entity_id in the database and returns one batch's rows.
 */
async function listBatchApprovals({ store, status = null, limit = 200 } = {}) {
  assertStoreContract(store, "batch approval store");
  let rows;
  try {
    rows = await store.listDecisions({ entityType: ENTITY_TYPE, limit: 5000 });
  } catch (err) {
    return Object.freeze({ available: false, reason: err.message, batches: Object.freeze([]) });
  }

  const byEntity = new Map();
  for (const r of rows || []) {
    if (r.event !== EVENT_APPROVED && r.event !== EVENT_WITHDRAWN) continue;
    if (!byEntity.has(r.entityId)) byEntity.set(r.entityId, []);
    byEntity.get(r.entityId).push(r);
  }

  const folded = [...byEntity.entries()].map(([key, list]) => foldApproval(list, key)).filter((f) => f.status !== STATUS.NONE);
  const filtered = status === null ? folded : folded.filter((f) => f.status === status);
  const at = (f) => (f.approval ? f.approval.approvedAt : f.withdrawnAt || "");

  return Object.freeze({
    available: true,
    reason: null,
    batches: Object.freeze(filtered.sort((a, b) => String(at(b)).localeCompare(String(at(a)))).slice(0, limit)),
  });
}

// ── The durable write ───────────────────────────────────────────────

/**
 * Record the founder's approval of one exact batch.
 *
 * IDEMPOTENT ON THE EXACT SAME BATCH. Running the command twice does not append
 * a second approval: the first is found and returned. That matters more than it
 * sounds — an operator who is not sure whether their command landed will run it
 * again, and two approval rows for one membership would make "who approved
 * this" a question with two answers.
 *
 * A CHANGED BATCH IS A DIFFERENT KEY and therefore needs its own approval. This
 * function cannot be used to move an approval onto different contents; there is
 * no parameter that would let it.
 *
 * @param {object}   store
 * @param {function} now
 * @param {object}   identity     from canonicalBatchIdentity()
 * @param {string}   approvedBy   a named person. Required.
 * @param {string}   reason       why. Required.
 * @param {string}   [note]
 */
async function recordBatchApproval({ store, now, identity, approvedBy, reason, note = null } = {}) {
  assertStoreContract(store, "batch approval store");
  if (typeof now !== "function") throw new Error("recordBatchApproval requires an injected now().");

  const verified = verifyIdentity(identity);
  if (!verified.ok) return { ok: false, code: verified.code, message: verified.message };

  const who = clip(approvedBy, 120);
  if (!who) {
    return { ok: false, code: "approver_missing", message: "A batch approval has to record which person made it. There is no default approver." };
  }
  if (NON_HUMAN_APPROVERS.test(who)) {
    return { ok: false, code: "approver_not_human", message: `Batch approval is a human decision. "${who}" is not a person.` };
  }
  const why = clip(reason);
  if (!why) {
    return { ok: false, code: "reason_required", message: "A batch approval has to record why, in a sentence somebody can read a year from now." };
  }

  const before = await loadBatchApproval({ store, batchKey: verified.batchKey });
  if (!before.available) {
    // FAIL CLOSED ON THE WRITE PATH TOO. If we cannot see whether this batch is
    // already approved, appending would risk a second approval row for one
    // membership — and would report a durable approval that was never read back.
    return { ok: false, code: BATCH_APPROVAL_CODES.STORE_UNAVAILABLE, message: `The approval store could not be read, so nothing was approved: ${before.reason}` };
  }
  if (before.status === STATUS.APPROVED) {
    return {
      ok: true,
      created: false,
      replayed: true,
      code: BATCH_APPROVAL_CODES.CURRENT,
      approval: before.approval,
      state: before,
      message: `This exact batch was already approved by ${before.approval.approvedBy} on ${before.approval.approvedAt}. Nothing was written.`,
    };
  }

  const detail = {
    approvalSchemaVersion: APPROVAL_SCHEMA_VERSION,
    batchKey: verified.batchKey,
    membershipHash: verified.membershipHash,
    label: verified.label,
    campaignId: verified.campaignId,
    policyVersion: verified.policyVersion,
    recordCount: verified.recordCount,
    maxBatchSize: verified.maxBatchSize,
    members: verified.members.map((m) => ({ ...m })),
    note: clip(note),
    // Stated on the durable artifact itself, so a reader a year from now cannot
    // mistake it for a permission to dial.
    authorises:
      "The founder approved this exact set of businesses and numbers for consideration. This is NOT permission to place a call: DNCR, suppression, calling hours, holidays, attempt policy, duplicates, lifecycle, campaign and the final M8E authorisation gate are all still evaluated at the moment of every call.",
  };

  let raced = null;
  let outcome;
  try {
    outcome = await appendDecisionSerialised({
      store,
      now,
      mint: async ({ log, attempt }) => {
        if (attempt > 1) {
          // Somebody won the race for the chain head. They may have been
          // approving this very batch — re-check rather than append a second
          // approval on top of theirs.
          const fresh = await loadBatchApproval({ store, batchKey: verified.batchKey });
          if (fresh.available && fresh.status === STATUS.APPROVED) {
            raced = fresh;
            return null;
          }
        }
        return log.record({
          entityType: ENTITY_TYPE,
          entityId: verified.batchKey,
          event: EVENT_APPROVED,
          decision: "approve",
          actor: who,
          // A BATCH APPROVAL IS A HUMAN DECISION, always. Written here and
          // nowhere else, so no caller can set it to "system".
          actorKind: "human",
          reason: why,
          detail,
          correlationId: verified.batchKey,
        });
      },
    });
  } catch (err) {
    if (err instanceof ChainContentionError) {
      return { ok: false, code: "chain_contention", message: `The decision log was too busy to record this after ${err.attempts} attempts. NOTHING WAS APPROVED. Try again.` };
    }
    throw err;
  }

  if (outcome.aborted || outcome.replayed) {
    const after = raced || (await loadBatchApproval({ store, batchKey: verified.batchKey }));
    return {
      ok: true,
      created: false,
      replayed: true,
      code: BATCH_APPROVAL_CODES.CURRENT,
      approval: after.approval,
      state: after,
      message: after.approval ? `Another process approved this exact batch first, at ${after.approval.approvedAt} by ${after.approval.approvedBy}.` : "Nothing was written.",
    };
  }

  const after = await loadBatchApproval({ store, batchKey: verified.batchKey });
  return {
    ok: true,
    created: true,
    replayed: false,
    code: BATCH_APPROVAL_CODES.CURRENT,
    approval: after.approval,
    state: after,
    message: `Approved ${verified.recordCount} business${verified.recordCount === 1 ? "" : "es"} as ${verified.batchKey}. This is not permission to call any of them.`,
  };
}

/**
 * Withdraw an approval.
 *
 * Appends; it does not delete. The approval happened, and an audit trail that
 * can make a decision disappear is not one. A withdrawn batch simply stops
 * being approved from the next read onwards.
 */
async function revokeBatchApproval({ store, now, batchKey, actor, reason } = {}) {
  assertStoreContract(store, "batch approval store");
  if (typeof now !== "function") throw new Error("revokeBatchApproval requires an injected now().");

  const who = clip(actor, 120);
  if (!who) return { ok: false, code: "actor_missing", message: "Withdrawing an approval has to record who did it." };
  const why = clip(reason);
  if (!why) return { ok: false, code: "reason_required", message: "Withdrawing an approval has to record why." };

  const before = await loadBatchApproval({ store, batchKey });
  if (!before.available) {
    return { ok: false, code: BATCH_APPROVAL_CODES.STORE_UNAVAILABLE, message: `The approval store could not be read, so nothing was withdrawn: ${before.reason}` };
  }
  if (before.status !== STATUS.APPROVED) {
    return { ok: false, code: "not_approved", message: `"${clip(batchKey, 140)}" is not currently approved, so there is nothing to withdraw.` };
  }

  let raced = null;
  let outcome;
  try {
    outcome = await appendDecisionSerialised({
      store,
      now,
      mint: async ({ log, attempt }) => {
        if (attempt > 1) {
          const fresh = await loadBatchApproval({ store, batchKey });
          if (fresh.available && fresh.status !== STATUS.APPROVED) {
            raced = fresh;
            return null;
          }
        }
        return log.record({
          entityType: ENTITY_TYPE,
          entityId: before.batchKey,
          event: EVENT_WITHDRAWN,
          decision: "reject",
          actor: who,
          actorKind: "human",
          reason: why,
          detail: {
            approvalSchemaVersion: APPROVAL_SCHEMA_VERSION,
            batchKey: before.batchKey,
            membershipHash: before.approval.membershipHash,
            withdrawnApprovalBy: before.approval.approvedBy,
            withdrawnApprovalAt: before.approval.approvedAt,
          },
          correlationId: before.batchKey,
        });
      },
    });
  } catch (err) {
    if (err instanceof ChainContentionError) {
      return { ok: false, code: "chain_contention", message: `The decision log was too busy to record this after ${err.attempts} attempts. The approval still stands.` };
    }
    throw err;
  }

  if (outcome.aborted) {
    return { ok: false, code: "not_approved", message: `"${before.batchKey}" was withdrawn by ${raced.withdrawnBy} while this was being recorded. Nothing was changed.` };
  }
  return { ok: true, state: await loadBatchApproval({ store, batchKey: before.batchKey }), message: `Withdrew the approval of ${before.batchKey}.` };
}

// ── What the final gate asks ────────────────────────────────────────

/**
 * Is this business, on this number, covered by a durable founder approval RIGHT
 * NOW — and if not, why not, in terms a founder can act on?
 *
 * Returns the `context.batch` shape the eligibility engine expects, with
 * `source` set so nothing downstream can mistake a caller's claim for a durable
 * one. The engine never sees the caller's version: see acquisition-authorisation.
 *
 * @param {object} store
 * @param {string} prospectId
 * @param {string} [e164]      the number the gate has actually cleared
 * @param {string} [batchKey]  a REFERENCE, if the caller knows which batch.
 *                             Narrows the search; confers nothing.
 */
async function resolveBatchApprovalForProspect({ store, prospectId, e164 = null, batchKey = null } = {}) {
  assertStoreContract(store, "batch approval store");
  const id = clip(prospectId, 120);

  const refused = (code, message, extra = {}) =>
    Object.freeze({ approved: false, stale: false, unavailable: false, source: "durable", code, message, batchKey: null, batchHash: null, approvedBy: null, ...extra });

  if (!id) {
    return refused(BATCH_APPROVAL_CODES.MISSING, "This record has no prospect id, so no batch approval can be matched to it.");
  }

  // ── The reference path: the caller named a batch ──────────────────
  if (clip(batchKey, 140)) {
    const state = await loadBatchApproval({ store, batchKey });
    if (!state.available) {
      return Object.freeze({
        approved: false,
        stale: false,
        unavailable: true,
        source: "unavailable",
        code: BATCH_APPROVAL_CODES.STORE_UNAVAILABLE,
        message: `Whether this business is in a batch the founder approved could not be established, so no call is permitted. ${state.reason}`,
        batchKey: state.batchKey,
        batchHash: null,
        approvedBy: null,
      });
    }
    if (state.status === STATUS.WITHDRAWN) {
      return refused(
        BATCH_APPROVAL_CODES.WITHDRAWN,
        `The approval of ${state.batchKey} was withdrawn by ${state.withdrawnBy} on ${state.withdrawnAt}: ${state.withdrawnReason}`,
        { batchKey: state.batchKey }
      );
    }
    if (state.status !== STATUS.APPROVED) {
      return refused(BATCH_APPROVAL_CODES.MISSING, `No founder approval is stored for "${state.batchKey}". A batch approved in another process is only real if it was written down.`, { batchKey: state.batchKey });
    }
    return memberVerdict(state, id, e164);
  }

  // ── The search path: which approved batch, if any, holds this row ─
  //
  // This is the path a restarted process takes. It knows a prospect and nothing
  // else, and it must not have to be told which batch to trust.
  const all = await listBatchApprovals({ store, status: STATUS.APPROVED });
  if (!all.available) {
    return Object.freeze({
      approved: false,
      stale: false,
      unavailable: true,
      source: "unavailable",
      code: BATCH_APPROVAL_CODES.STORE_UNAVAILABLE,
      message: `Whether this business is in a batch the founder approved could not be established, so no call is permitted. ${all.reason}`,
      batchKey: null,
      batchHash: null,
      approvedBy: null,
    });
  }

  const holding = all.batches.filter((b) => b.approval && b.approval.members.some((m) => m.prospectId === id));
  if (holding.length === 0) {
    return refused(BATCH_APPROVAL_CODES.MISSING, "This prospect is not in any batch the founder has durably approved.");
  }

  // If more than one approved batch holds it, prefer one whose membership still
  // names the number being dialled. A batch approved against a number this
  // record no longer uses does not describe what would be called.
  const exact = holding.find((b) => b.approval.members.some((m) => m.prospectId === id && (!e164 || m.e164 === e164)));
  return memberVerdict(exact || holding[0], id, e164);
}

/** Does the approved membership actually cover this business on this number? */
function memberVerdict(state, prospectId, e164) {
  const approval = state.approval;
  const mine = approval.members.filter((m) => m.prospectId === prospectId);

  if (mine.length === 0) {
    return Object.freeze({
      approved: false,
      stale: false,
      unavailable: false,
      source: "durable",
      code: BATCH_APPROVAL_CODES.NOT_A_MEMBER,
      message: `${approval.batchKey} is approved, but this business is not one of the ${approval.recordCount} in it.`,
      batchKey: approval.batchKey,
      batchHash: approval.membershipHash,
      approvedBy: approval.approvedBy,
    });
  }

  if (e164 && !mine.some((m) => m.e164 === e164)) {
    // THE NUMBER CHANGED SINCE APPROVAL. Membership is who AND on what number,
    // so this is a membership change and it is stale — not a compliance problem
    // and not something a re-run will fix. The founder approved calling this
    // business on a different number.
    return Object.freeze({
      approved: false,
      stale: true,
      unavailable: false,
      source: "durable",
      code: BATCH_APPROVAL_CODES.STALE,
      message: `The approval of ${approval.batchKey} covers this business on ${mine.map((m) => m.e164).join(", ")}, and the number that would be dialled is ${e164}. The approval does not describe what would be called. Re-assemble the batch and approve it again.`,
      batchKey: approval.batchKey,
      batchHash: approval.membershipHash,
      approvedBy: approval.approvedBy,
    });
  }

  return Object.freeze({
    approved: true,
    stale: false,
    unavailable: false,
    source: "durable",
    code: BATCH_APPROVAL_CODES.CURRENT,
    message: `In ${approval.batchKey}, approved by ${approval.approvedBy} on ${approval.approvedAt}.`,
    batchKey: approval.batchKey,
    batchHash: approval.membershipHash,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    recordCount: approval.recordCount,
  });
}

/**
 * Is a batch the caller is holding still the batch that was approved?
 *
 * The operator-facing question, and the one that separates the two staleness
 * answers. Compares CANONICAL IDENTITY, never eligibility — a batch whose
 * members have all become uncallable is still, precisely, the batch that was
 * approved.
 */
async function checkDurableFreshness({ store, identity } = {}) {
  const verified = verifyIdentity(identity);
  if (!verified.ok) return Object.freeze({ fresh: false, stale: true, code: verified.code, message: verified.message });

  const state = await loadBatchApproval({ store, batchKey: verified.batchKey });
  if (!state.available) {
    return Object.freeze({ fresh: false, stale: false, unavailable: true, code: BATCH_APPROVAL_CODES.STORE_UNAVAILABLE, message: `The approval store could not be read: ${state.reason}` });
  }
  if (state.status === STATUS.WITHDRAWN) {
    return Object.freeze({ fresh: false, stale: true, code: BATCH_APPROVAL_CODES.WITHDRAWN, message: `Withdrawn by ${state.withdrawnBy} on ${state.withdrawnAt}: ${state.withdrawnReason}` });
  }
  if (state.status !== STATUS.APPROVED) {
    return Object.freeze({
      fresh: false,
      stale: true,
      code: BATCH_APPROVAL_CODES.MISSING,
      message: `Nothing has been approved under ${verified.batchKey}. If a batch with these businesses was approved before, its membership has changed since — a different membership is a different batch and needs its own approval.`,
    });
  }
  return Object.freeze({
    fresh: true,
    stale: false,
    code: BATCH_APPROVAL_CODES.CURRENT,
    message: `Approved by ${state.approval.approvedBy} on ${state.approval.approvedAt}, covering exactly these ${state.approval.recordCount}.`,
    approval: state.approval,
  });
}

module.exports = {
  canonicalBatchIdentity,
  membersFromBatch,
  verifyIdentity,
  recordBatchApproval,
  loadBatchApproval,
  listBatchApprovals,
  revokeBatchApproval,
  resolveBatchApprovalForProspect,
  checkDurableFreshness,
  APPROVAL_SCHEMA_VERSION,
  BATCH_APPROVAL_CODES,
  STATUS,
  ENTITY_TYPE,
  EVENT_APPROVED,
  EVENT_WITHDRAWN,
  NON_HUMAN_APPROVERS,
};
