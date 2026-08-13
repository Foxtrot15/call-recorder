// AIDA Locksmith Acquisition — the contact lifecycle bridge (E-8).
//
//   establishContactFact({ store, prospectId, fact, actor, reason, at })
//   CONTACT_FACTS / CONTACT_LADDER / LIFECYCLE_FACT_CODES
//
// ── THE PROBLEM THIS CLOSES ─────────────────────────────────────────
// acquisition-outcome refuses to record against anything that is not `queued`,
// `attempted`, `connected` or `callback_requested`: "no call could have been
// made to it, so there is no outcome to record."
//
// That guard is right and is NOT weakened here. The defect was on the other
// side: the ONLY durable lifecycle writer in the repository was the M8H/E-2
// review projection, which stops at `review_approved`. Nothing ever wrote
// `queued` and nothing ever wrote `attempted`, so a real Retell outcome would
// have been correctly refused and no business could ever be recorded as called.
//
// ── LIFECYCLE STATE MUST REPRESENT FACTS ────────────────────────────
// The rule this file exists to enforce, and the reason each mapping below is
// argued rather than assumed:
//
//   a durable dispatch claim      is a RESERVATION, not a call
//   a provider timeout            is not evidence a call happened
//   a provider acknowledgement    is not evidence a human answered
//   a call_started event          is not evidence a human answered
//   a call ending                 is not a business outcome
//
// Advancing a state because it makes a later write convenient would put a
// falsehood in the permanent record of what we did to a business. The whole
// point of the guard we are unblocking is to stop exactly that.
//
// ── WHY THE QUEUE IS NOT USED ───────────────────────────────────────
// `queued` is documented as "selected into an approved calling batch", and
// acquisition_call_queue exists to hold reservations. But the first-call flow
// does not go through it: it is batch approval -> M8E authorisation -> dispatch
// claim, and the queue table holds zero rows. Introducing a lease merely
// because a state shares its name would add a second reservation system whose
// only job is to justify a word. The LAQ5 dispatch claim IS the durable
// reservation — it requires an approved batch, it requires a passing
// eligibility decision, and it exclusively holds the business and the number
// until it is resolved. That is what `queued` describes.

const { PROSPECT_STATES, ENGAGEMENT_STATES } = require("./acquisition-schema");

/** The facts a contact attempt can establish. Nothing else may be established here. */
const CONTACT_FACTS = Object.freeze({
  QUEUED: "queued",
  ATTEMPTED: "attempted",
  CONNECTED: "connected",
  CALLBACK_REQUESTED: "callback_requested",
});

/**
 * The forward ladder, in the order the state machine allows.
 *
 * review_approved -> queued -> attempted -> connected
 *
 * A fact further up implies every fact below it: you cannot have spoken to
 * somebody without having called them. So establishing `connected` walks the
 * intermediate steps rather than skipping them, and each hop is a separate
 * compare-and-set that records its own actor and reason.
 */
const CONTACT_LADDER = Object.freeze(["queued", "attempted", "connected"]);

/** The only state a prospect may enter the ladder from. */
const LADDER_ENTRY = "review_approved";

const LIFECYCLE_FACT_CODES = Object.freeze({
  ESTABLISHED: "contact_fact_established",
  ALREADY: "contact_fact_already_true",
  BEYOND: "contact_fact_already_surpassed",
  UNKNOWN_FACT: "contact_fact_unknown",
  PROSPECT_MISSING: "contact_fact_prospect_missing",
  NOT_REACHABLE: "contact_fact_not_reachable",
  STORE_UNAVAILABLE: "contact_fact_store_unavailable",
  REFUSED: "contact_fact_refused",
});

const refuse = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, changed: false, ...extra });

/**
 * Establish a contact fact durably, walking only legal transitions.
 *
 * IDEMPOTENT. A fact that is already true returns ok with `changed: false`, and
 * so does a prospect that is already further along — this never walks a
 * lifecycle BACKWARDS. A business that reached `connected` does not become
 * `attempted` again because a duplicate call_started arrived, and events do
 * arrive out of order.
 *
 * @param {object}   store      the durable store
 * @param {string}   prospectId
 * @param {string}   fact       a CONTACT_FACTS value
 * @param {string}   actor
 * @param {string}   reason     WHY this fact is true — the evidence, not the intent
 * @param {string}   [at]       ISO instant
 */
async function establishContactFact({ store, prospectId, fact, actor, reason, at = null } = {}) {
  if (!Object.values(CONTACT_FACTS).includes(fact)) {
    return refuse(LIFECYCLE_FACT_CODES.UNKNOWN_FACT, `"${String(fact).slice(0, 40)}" is not a contact fact this bridge may establish.`);
  }
  if (!store || typeof store.loadProspect !== "function" || typeof store.transitionProspectLifecycle !== "function") {
    return refuse(LIFECYCLE_FACT_CODES.STORE_UNAVAILABLE, "The prospect store cannot record a lifecycle fact, so none is claimed.");
  }
  if (!String(actor || "").trim()) return refuse(LIFECYCLE_FACT_CODES.REFUSED, "A lifecycle fact must record who established it.");
  if (!String(reason || "").trim()) return refuse(LIFECYCLE_FACT_CODES.REFUSED, "A lifecycle fact must record the evidence for it.");

  let prospect;
  try {
    prospect = await store.loadProspect(prospectId);
  } catch (err) {
    return refuse(LIFECYCLE_FACT_CODES.STORE_UNAVAILABLE, `The prospect could not be read, so no lifecycle fact was recorded: ${err.message}`);
  }
  if (!prospect) {
    return refuse(LIFECYCLE_FACT_CODES.PROSPECT_MISSING, `There is no persisted prospect "${String(prospectId).slice(0, 60)}" to record a contact fact against.`);
  }

  const from = prospect.lifecycle;
  if (from === fact) {
    return Object.freeze({ ok: true, code: LIFECYCLE_FACT_CODES.ALREADY, changed: false, from, to: fact, message: `This business is already "${fact}".` });
  }

  // ── callback_requested is not on the ladder ──────────────────────
  //
  // It is reachable from `attempted` or `connected` only — somebody has to have
  // been called before they can ask to be called back. So the attempt is
  // established first, and the callback is one further hop.
  if (fact === CONTACT_FACTS.CALLBACK_REQUESTED) {
    if (!["attempted", "connected"].includes(from)) {
      const groundwork = await establishContactFact({ store, prospectId, fact: CONTACT_FACTS.ATTEMPTED, actor, reason, at });
      if (!groundwork.ok) return groundwork;
    }
    return hop({ store, prospectId, to: CONTACT_FACTS.CALLBACK_REQUESTED, actor, reason, at, from });
  }

  const targetIndex = CONTACT_LADDER.indexOf(fact);
  const currentIndex = CONTACT_LADDER.indexOf(from);

  // Already further along. Not an error, and NOT walked backwards.
  if (currentIndex > targetIndex) {
    return Object.freeze({
      ok: true,
      code: LIFECYCLE_FACT_CODES.BEYOND,
      changed: false,
      from,
      to: from,
      message: `This business is already "${from}", which is past "${fact}". Nothing was moved backwards.`,
    });
  }

  // Somewhere off the ladder entirely — suppressed, not_interested, customer,
  // disqualified, still in review. None of those may be dragged into an
  // engagement state by a provider event.
  if (currentIndex === -1 && from !== LADDER_ENTRY) {
    return refuse(
      LIFECYCLE_FACT_CODES.NOT_REACHABLE,
      `This business is "${from}", which is not a state a contact attempt may advance from. Nothing was changed.`,
      { from }
    );
  }

  const startAt = currentIndex === -1 ? 0 : currentIndex + 1;
  const path = CONTACT_LADDER.slice(startAt, targetIndex + 1);

  let last = { from, to: from };
  for (const step of path) {
    const moved = await hop({ store, prospectId, to: step, actor, reason, at, from: last.to });
    if (!moved.ok) return moved;
    last = moved;
  }

  return Object.freeze({
    ok: true,
    code: LIFECYCLE_FACT_CODES.ESTABLISHED,
    changed: true,
    from,
    to: fact,
    path: Object.freeze(path),
    message: `This business is now "${fact}" (${from} -> ${path.join(" -> ")}). ${reason}`,
  });
}

/** One compare-and-set hop. Never invents a transition the machine forbids. */
async function hop({ store, prospectId, to, actor, reason, at, from }) {
  let moved;
  try {
    moved = await store.transitionProspectLifecycle({ prospectId, to, actor, reason, at });
  } catch (err) {
    return refuse(LIFECYCLE_FACT_CODES.STORE_UNAVAILABLE, `The lifecycle could not be advanced to "${to}": ${err.message}`, { from });
  }
  if (!moved || moved.ok !== true) {
    return refuse(
      LIFECYCLE_FACT_CODES.REFUSED,
      `The lifecycle refused to advance to "${to}": ${(moved && moved.message) || "no reason given"}`,
      { from, to }
    );
  }
  return Object.freeze({ ok: true, code: LIFECYCLE_FACT_CODES.ESTABLISHED, changed: moved.changed !== false, from, to });
}

module.exports = {
  establishContactFact,
  CONTACT_FACTS,
  CONTACT_LADDER,
  LADDER_ENTRY,
  LIFECYCLE_FACT_CODES,
  // Re-exported so a caller can assert the bridge and the machine agree.
  PROSPECT_STATES,
  ENGAGEMENT_STATES,
};
