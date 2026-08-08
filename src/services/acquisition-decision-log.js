// AIDA Locksmith Acquisition — appending to the decision chain safely (M8I).
//
//   readChainState({ store })                     the authoritative head
//   hydrateLog({ store, now })                    a log that continues it
//   appendDecisionSerialised({ store, now, mint }) append, or lose and re-try
//   MAX_APPEND_ATTEMPTS / ChainContentionError
//
// ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────
// It is NOT the thing that makes concurrent appends safe. That is one line of
// SQL — `unique (prev_hash)` on acquisition_decisions, applied by
// supabase/sql/laq3_serialise_decision_chain.sql — and it holds whether or not
// this file is used, whether the caller is Node, psql or a future service in
// another language, and whether or not anybody read the comments.
//
// This module is the CLIENT-SIDE ETIQUETTE that turns the database's refusal
// into a correct outcome instead of a crash: re-read the head, re-mint, try
// again, and give up loudly rather than quietly. Nothing here is trusted. In
// particular there is no in-process mutex, no queue, no "only one writer at a
// time" flag — a lock inside one Node process says nothing about the second
// process, and a guard that is only sometimes right is worse than none, because
// it invites people to rely on it.
//
// ── WHY A LOSER CANNOT SIMPLY RE-INSERT ─────────────────────────────
// A decision row's entryHash covers its own prevHash and sequence, and its
// auditId is derived from that hash. So a row minted against head H is not a
// row that can be appended after H+1; it names a predecessor that already has a
// successor. Retrying means rebuilding the row against the NEW head, which is
// why `mint` is a callback rather than a value. Handing this function a
// pre-built row would make retrying impossible.
//
// ── AND WHY THE LOSING ROW IS NOT CLEANED UP ────────────────────────
// Because there is nothing to clean up. A lost race is a rejected INSERT: the
// row was never durably written. No decision row is ever deleted or rewritten
// to resolve contention — the table is append-only, and "repair the fork by
// removing a row" is the one operation this design exists to make unnecessary.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────
// Retries are BOUNDED. Under pathological contention this throws rather than
// looping, and it throws rather than returning a falsy result, because the
// failure mode being defended against is a caller who reports success for a
// decision that was never stored. An unbounded retry would turn contention into
// a spin that never finishes and never reports.
//
// See test/acquisition-decision-log.test.js.

const { createAuditLog } = require("./acquisition-audit");
const { assertStoreContract } = require("./acquisition-store");

// Five is chosen against the shape of the contention, not as a round number.
// Each attempt is one head read plus one insert; the winner of a race always
// succeeds on its first attempt, so N writers hitting the same head at the same
// instant resolve in at most N attempts for the unluckiest. Five covers a pilot
// with a handful of workers with room to spare, and anything beyond that is not
// contention any more — it is a chain being written to faster than it can be
// read, which is a design problem that a sixth retry would hide.
const MAX_APPEND_ATTEMPTS = 5;

/** Thrown when the retries are used up. Distinct so callers can name it. */
class ChainContentionError extends Error {
  constructor(attempts) {
    super(
      `Could not append to the decision chain: ${attempts} attempt(s) all lost the race for the chain head. ` +
        `Nothing was written. The decision has NOT been recorded and must not be treated as recorded.`
    );
    this.name = "ChainContentionError";
    this.code = "chain_contention";
    this.attempts = attempts;
  }
}

/**
 * The head of the chain, read from the database on every call.
 *
 * NOT CACHED, NOT DERIVED FROM A LIST. Both shortcuts have the same failure:
 * they answer with a head that was true a moment ago, and every row minted
 * against a stale head is a fork attempt. The read is one indexed row.
 */
async function readChainState({ store }) {
  assertStoreContract(store, "decision store");
  const head = await store.readChainHead();
  if (head === null || head === undefined) return { head: null, sequence: 0, entryHash: null };
  if (!Number.isFinite(head.sequence) || head.sequence < 1) {
    // A head that cannot be continued. Refused here rather than passed to
    // createAuditLog, so the message names the row instead of the argument.
    throw new Error(`The stored chain head has an unusable sequence (${String(head.sequence)}). Investigate before appending; do not reset the chain.`);
  }
  return { head, sequence: head.sequence, entryHash: head.entryHash };
}

/**
 * A log positioned at the CURRENT persisted head, ready to mint the next row.
 *
 * Returns the state it hydrated from as well, so a caller can tell whether the
 * head moved under it between two operations.
 */
async function hydrateLog({ store, now }) {
  if (typeof now !== "function") throw new Error("hydrateLog requires an injected now().");
  const state = await readChainState({ store });
  return {
    log: createAuditLog({ now, initialHead: state.entryHash, initialSequence: state.sequence }),
    head: state.head,
  };
}

/**
 * Append one decision, re-reading the head and re-minting if somebody else got
 * there first.
 *
 * @param {object}   store         the durable store
 * @param {function} now           injected clock
 * @param {function} mint          ({ log, head, attempt }) => row | null
 *                                 May be async. Called ONCE PER ATTEMPT against
 *                                 a freshly hydrated log. Return null to abort
 *                                 — which is how a caller re-checks a
 *                                 precondition that the winning writer may have
 *                                 just invalidated. Re-checking matters: the
 *                                 process that beat us may have done the very
 *                                 thing we were about to do.
 * @param {number}   [maxAttempts]
 * @param {function} [onConflict]  ({ attempt, head }) => void, for observability
 *
 * @returns {{ appended:boolean, replayed:boolean, aborted:boolean,
 *             decision:object|null, attempts:number, conflicts:number }}
 * @throws  {ChainContentionError} when the attempts are exhausted
 */
async function appendDecisionSerialised({ store, now, mint, maxAttempts = MAX_APPEND_ATTEMPTS, onConflict = null } = {}) {
  assertStoreContract(store, "decision store");
  if (typeof now !== "function") throw new Error("appendDecisionSerialised requires an injected now().");
  if (typeof mint !== "function") {
    throw new Error("appendDecisionSerialised requires a mint({ log, head, attempt }) callback — a pre-built row cannot be retried, because its hash names the head it was built against.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    // The upper bound is as deliberate as the lower one. "Retry until it works"
    // is how contention becomes an outage nobody gets paged for.
    throw new Error("appendDecisionSerialised maxAttempts must be an integer between 1 and 20 — retries are bounded on purpose.");
  }

  let conflicts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { log, head } = await hydrateLog({ store, now });
    const row = await mint({ log, head, attempt });

    // The caller looked at the new head and decided the work is already done,
    // or no longer applies. Not a failure.
    if (row === null || row === undefined) {
      return { appended: false, replayed: false, aborted: true, decision: null, attempts: attempt, conflicts };
    }

    const result = await store.appendDecision(row);

    if (result && result.created) {
      return { appended: true, replayed: false, aborted: false, decision: result.decision || row, attempts: attempt, conflicts };
    }

    // Same decision, already durable. Idempotent replay, not a race.
    if (result && !result.conflict) {
      return { appended: false, replayed: true, aborted: false, decision: result.decision || null, attempts: attempt, conflicts };
    }

    // Lost the race. The head has moved; go and read where it moved to.
    conflicts += 1;
    if (onConflict) onConflict({ attempt, head, reason: (result && result.reason) || "head_taken" });
  }

  throw new ChainContentionError(maxAttempts);
}

module.exports = {
  appendDecisionSerialised,
  hydrateLog,
  readChainState,
  ChainContentionError,
  MAX_APPEND_ATTEMPTS,
};
