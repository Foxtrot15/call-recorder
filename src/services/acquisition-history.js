// AIDA Locksmith Acquisition — durable contact history (M8J / E-1).
//
//   readContactHistory({ store, prospectId })      one prospect, from the table
//   loadHistoryIndex({ store, prospectIds })       many, for a sync evaluator
//   unavailableHistory(reason)                     the fail-closed value
//   HISTORY_SOURCES / isDurableHistory(h)
//
// Before M8J the attempt policy was handed `{ attempts, lastAttemptAt,
// lastContactAt, lastOutcome }` by whoever happened to be calling. Every
// production call site — the authoriser, the queue, the batch assembler, the
// read model — passed nothing at all, so every prospect evaluated as though it
// had never been called. Approving A-L6 would have enforced caps against zero.
//
// This module is the one place those facts come from, and the table is the only
// source: `acquisition_contact_outcomes`, which has recorded every outcome
// since laq2 and needed no schema change to answer this.
//
// ── FACTS HERE. POLICY IN acquisition-attempt-policy.js. ────────────
// THE MOST IMPORTANT LINE IN THIS FILE: **there is no `attempts` count here.**
//
// It is tempting — `attempts = outcomes.length` is one line, and the A-L audit
// even suggested it. It would also silently decide A-L7, which asks whether an
// unanswered call or a voicemail consumes an attempt. Nobody has answered that.
// Baking a count into the fold would answer it by accident, in a module whose
// name suggests it only reads rows, and the decision would be invisible in
// every review that followed.
//
// So this returns the ORDERED FACTS — what happened, in what order, whether we
// actually reached the business, and when — and the attempt policy counts them
// according to rules that carry their own `approved` flags. Whichever way A-L7
// is eventually decided, the data here is already right: the answer changes a
// predicate, not a stored number, and no backfill is needed.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────
// A read that fails returns `available: false`, and every consumer treats that
// as a BLOCK rather than as "no history". Those are opposite claims: one says
// we could not find out, the other says we checked and there was nothing. The
// second authorises a call.
//
// Pure apart from the store read. See test/acquisition-history.test.js.

const HISTORY_SOURCES = Object.freeze({
  DURABLE: "durable",
  UNAVAILABLE: "unavailable",
});

/** Only this module mints a durable history. Nothing else can claim the label. */
const DURABLE_HISTORY = Symbol("acquisition.durableHistory");

/**
 * The value every consumer must refuse to proceed on.
 *
 * Deliberately NOT `{ outcomes: [] }`. An empty history and an unreadable one
 * are different facts, and a shape that made them look alike would be a
 * fail-open waiting for a bad afternoon.
 */
function unavailableHistory(reason, prospectId = null) {
  return Object.freeze({
    [DURABLE_HISTORY]: true,
    available: false,
    source: HISTORY_SOURCES.UNAVAILABLE,
    prospectId,
    reason: reason || "The contact history could not be read.",
    outcomes: Object.freeze([]),
    latestOutcome: null,
    lastEventAt: null,
    lastReachedAt: null,
    countsByOutcome: Object.freeze({}),
    reachedCount: 0,
    totalOutcomes: 0,
  });
}

/** True only for a history this module produced. A hand-built object is not. */
function isDurableHistory(value) {
  return Boolean(value) && typeof value === "object" && value[DURABLE_HISTORY] === true;
}

/**
 * Deterministic order for two outcomes recorded at the same instant.
 *
 * `recorded_at` is a timestamptz supplied by the caller, and two outcomes for
 * one prospect can share a millisecond. `created_at` is the database's own
 * insert time and breaks most of the remainder; `id` breaks the rest. Without a
 * total order, "the latest outcome" is whichever row the query happened to
 * return last, and a cooldown would depend on it.
 */
function compareOutcomes(a, b) {
  const at = Date.parse(a.recordedAt || "") || 0;
  const bt = Date.parse(b.recordedAt || "") || 0;
  if (at !== bt) return at - bt;
  const ac = Date.parse(a.createdAt || "") || 0;
  const bc = Date.parse(b.createdAt || "") || 0;
  if (ac !== bc) return ac - bc;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

/** Reduce raw outcome rows to the facts the policy layer needs. */
function foldOutcomes(prospectId, rows) {
  const ordered = [...rows].sort(compareOutcomes).map((r) =>
    Object.freeze({
      outcome: r.outcome,
      // The load-bearing column. NOT "did the phone get answered" — a
      // wrong_person outcome answers yes to that and no to this, and a cooldown
      // that treated it as a conversation would be counting one that never
      // happened.
      reachedTheBusiness: r.reachedTheBusiness === true,
      recordedAt: r.recordedAt,
      e164: r.e164 || null,
      actor: r.actor,
      actorKind: r.actorKind,
    })
  );

  const countsByOutcome = {};
  for (const o of ordered) countsByOutcome[o.outcome] = (countsByOutcome[o.outcome] || 0) + 1;

  const reached = ordered.filter((o) => o.reachedTheBusiness);
  const latest = ordered.length ? ordered[ordered.length - 1] : null;

  return Object.freeze({
    [DURABLE_HISTORY]: true,
    available: true,
    source: HISTORY_SOURCES.DURABLE,
    prospectId,

    /** Every outcome, oldest first, totally ordered. */
    outcomes: Object.freeze(ordered),
    /** The most recent one — what "they said no last time" means. */
    latestOutcome: latest ? latest.outcome : null,
    /** When anything last happened to this business, reached or not. */
    lastEventAt: latest ? latest.recordedAt : null,
    /**
     * When we last actually SPOKE to them. Only reached_the_business rows
     * count, which is what a "recent contact" cooldown is about — three
     * unanswered rings are not a conversation.
     */
    lastReachedAt: reached.length ? reached[reached.length - 1].recordedAt : null,

    countsByOutcome: Object.freeze(countsByOutcome),
    reachedCount: reached.length,
    totalOutcomes: ordered.length,
    // Deliberately absent: `attempts`. See the header — that is A-L7's
    // question and it belongs to the attempt policy, not to a row reader.
  });
}

/**
 * Read one prospect's durable contact history.
 *
 * Never throws for a store failure: it returns the unavailable value, because a
 * caller that forgot a try/catch must still be told "unknown" rather than
 * crashing at the pre-dial boundary or, worse, catching and defaulting to zero.
 */
async function readContactHistory({ store, prospectId } = {}) {
  if (!store || typeof store.listOutcomes !== "function") {
    return unavailableHistory("No store was supplied, so no contact history could be read.", prospectId || null);
  }
  if (typeof prospectId !== "string" || !prospectId.trim()) {
    return unavailableHistory("A contact history needs a prospectId.", null);
  }
  try {
    const rows = await store.listOutcomes({ prospectId });
    if (!Array.isArray(rows)) {
      return unavailableHistory("The store returned no readable outcome list.", prospectId);
    }
    // Filtered again here. listOutcomes takes prospectId, but a future adapter
    // that ignored the filter would silently attribute another business's
    // opt-out to this one — the kind of bug that only shows up as a cooldown
    // nobody can explain.
    return foldOutcomes(prospectId, rows.filter((r) => r && r.prospectId === prospectId));
  } catch (err) {
    return unavailableHistory(`The contact history could not be read: ${err.message}`, prospectId);
  }
}

/**
 * Histories for many prospects, as a SYNCHRONOUS index.
 *
 * The eligibility engine is synchronous by deliberate design (see the store's
 * header — making the hot path async would ripple through four services). So
 * the async read happens once, at the boundary, and the engine is handed
 * something it can ask without awaiting. The same shape M8E used for the
 * durable suppression read.
 *
 * A prospect that was never asked for returns UNAVAILABLE, not empty. An index
 * cannot know whether an id it was not given has history.
 */
async function loadHistoryIndex({ store, prospectIds = [] } = {}) {
  const ids = [...new Set((Array.isArray(prospectIds) ? prospectIds : []).filter((id) => typeof id === "string" && id.trim()))];
  const entries = new Map();
  let failures = 0;

  for (const id of ids) {
    const history = await readContactHistory({ store, prospectId: id });
    if (!history.available) failures += 1;
    entries.set(id, history);
  }

  return Object.freeze({
    source: HISTORY_SOURCES.DURABLE,
    size: entries.size,
    failures,
    for(prospectId) {
      const hit = entries.get(prospectId);
      if (hit) return hit;
      return unavailableHistory(`No contact history was loaded for "${String(prospectId).slice(0, 60)}", so it is unknown rather than empty.`, prospectId || null);
    },
  });
}

module.exports = {
  readContactHistory,
  loadHistoryIndex,
  unavailableHistory,
  isDurableHistory,
  foldOutcomes,
  compareOutcomes,
  HISTORY_SOURCES,
};
