// AIDA Locksmith Acquisition — contact outcomes (M8B).
//
//   const recorder = createOutcomeRecorder({ now, suppression, audit, attemptPolicy })
//   recorder.record({ prospect, outcome, actor, note, e164 })
//   recorder.recordConversion({ prospect, actor, reason })
//   recorder.describeOutcome(outcome)
//
// Records what happened when a locksmith was approached, moves the prospect to
// the state that fact implies, and applies the consequences that are already
// approved policy.
//
// ── NOTHING HERE CALLS ANYBODY ──────────────────────────────────────
// This module records outcomes; it does not produce them. It is written now,
// ahead of the caller, because the state machine and the suppression
// consequences are the part that has to be right BEFORE anything dials — not
// bolted on afterwards by whoever is building the dialler and is thinking about
// audio.
//
// ── THE OUTCOME IS THE FACT; THE STATE IS ITS CONSEQUENCE ───────────
// Callers say what happened ("they asked us not to call again"). They do not
// say what state the prospect should be in. If they did, two callers would
// eventually disagree, and the one that was wrong would be the one that left a
// business callable after an opt-out.
//
// The mapping is a table, and the path is walked through the SAME whitelist
// every other transition uses (acquisition-prospect.transitionProspect). If any
// hop in the path is illegal, the whole recording is refused and nothing
// changes — a half-applied outcome is worse than a rejected one.
//
// ── DURABLE BEFORE VISIBLE ──────────────────────────────────────────
// An opt-out suppresses the business BEFORE the prospect is transitioned. If
// the suppression write fails, the recording fails and the prospect stays where
// it was. The alternative — transition first, suppress second — has a failure
// mode where a business is marked "handled" while remaining callable, which is
// the exact accident that produces a second call to somebody who opted out.
//
// The same ordering as acquisition-evidence (the ledger refuses to believe it
// holds evidence it never persisted) and acquisition-review (the audit write
// precedes the transition).
//
// ── APPROVED CONSEQUENCES ARE APPLIED; UNAPPROVED ONES ARE REPORTED ─
// acquisition-attempt-policy owns which follow-on rules are actually settled
// policy. Two are: an opt-out suppresses the business permanently, and a wrong
// number suppresses the number. Those are applied here. The cooldown durations
// are NOT approved (see A2.7 / A-L6, A-L8), so this module records the outcome,
// says which rule would apply, and states plainly that its duration is not
// agreed — it never quietly invents one.
//
// Recording an outcome always succeeds where the transition is legal, even when
// the follow-on policy is unapproved. Losing the record of what a locksmith
// said because a cooldown duration is undecided would be absurd.
//
// Pure + dep-free. See test/acquisition-outcome.test.js.

const S = require("./acquisition-schema");
const { transitionProspect, identityFingerprint } = require("./acquisition-prospect");
const { createAttemptPolicy, OUTCOME_RULES, CALL_OUTCOMES } = require("./acquisition-attempt-policy");

const MAX_TEXT = 500;

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// What each outcome MEANS about the relationship, and therefore where the
// prospect ends up.
//
// `reachedTheBusiness` is the load-bearing column. It is not "did the phone get
// answered" — it is "did we speak to this business". `wrong_person` answers no
// to the second even though it answers yes to the first, which is why it lands
// on `attempted` rather than `connected`: we never reached this locksmith, we
// reached whoever now holds a number we thought was theirs. Recording that as a
// connection would put a conversation in the history that never happened.
const OUTCOME_LIFECYCLE = Object.freeze({
  no_answer: Object.freeze({ reachedTheBusiness: false, to: "attempted", meaning: "Nobody answered." }),
  voicemail: Object.freeze({ reachedTheBusiness: false, to: "attempted", meaning: "It went to voicemail." }),
  wrong_person: Object.freeze({ reachedTheBusiness: false, to: "attempted", meaning: "Somebody answered, but the number does not reach this business." }),
  callback: Object.freeze({ reachedTheBusiness: true, to: "callback_requested", meaning: "They asked us to call back." }),
  not_interested: Object.freeze({ reachedTheBusiness: true, to: "not_interested", meaning: "They are not interested." }),
  declined: Object.freeze({ reachedTheBusiness: true, to: "not_interested", meaning: "They declined." }),
  opt_out: Object.freeze({ reachedTheBusiness: true, to: "suppressed", meaning: "They asked never to be contacted again." }),
  booked: Object.freeze({ reachedTheBusiness: true, to: "interested", meaning: "They booked a follow-up." }),
  qualified: Object.freeze({ reachedTheBusiness: true, to: "interested", meaning: "They are a fit and want to proceed." }),
});

// A call outcome can only be recorded against a prospect a call could actually
// have been made to. "They said no" about a business that was never queued is
// either a mis-keyed record or somebody calling outside the queue, and both
// need to be noticed rather than absorbed.
const OUTCOME_RECORDABLE_FROM = Object.freeze(["queued", "attempted", "connected", "callback_requested"]);

/**
 * Create an outcome recorder.
 *
 * @param {function} now
 * @param {object}   [suppression]    the suppression list. Without it, outcomes
 *                                    whose approved consequence is a
 *                                    suppression are REFUSED — see below.
 * @param {object}   [audit]          the append-only decision log
 * @param {object}   [attemptPolicy]  defaults to the unapproved proposed policy
 */
function createOutcomeRecorder({ now, suppression = null, audit = null, attemptPolicy = null } = {}) {
  if (typeof now !== "function") throw new Error("createOutcomeRecorder requires an injected now().");

  const policy = attemptPolicy || createAttemptPolicy();

  /**
   * Walk a prospect from where it is to where the outcome says it belongs.
   *
   * Every hop goes through the ordinary whitelist. Returns the final prospect
   * and the hops taken, or a refusal — never a partially-moved prospect.
   */
  function walk(prospect, target, { reachedTheBusiness, actor, reason, remediation }) {
    const path = [];

    // A call was attempted, so `attempted` is on the way to everything — unless
    // we are already there or past it.
    if (prospect.lifecycle === "queued") path.push("attempted");
    // Reaching the business is a fact worth recording in its own right, so the
    // history reads "we called, we spoke to them, they said no" rather than
    // "we called, they said no".
    if (reachedTheBusiness && target !== "attempted" && prospect.lifecycle !== "connected" && target !== "suppressed") {
      path.push("connected");
    }
    if (path[path.length - 1] !== target) path.push(target);

    let current = prospect;
    const hops = [];
    for (const to of path) {
      if (current.lifecycle === to) continue;
      const step = transitionProspect(current, to, { actor, reason, now, remediation });
      if (!step.ok) {
        return {
          ok: false,
          code: step.code,
          message: `That outcome would move this business from "${S.PROSPECT_STATE_LABELS[current.lifecycle]}" to "${S.PROSPECT_STATE_LABELS[to]}", which is not allowed. ${step.message}`,
        };
      }
      hops.push({ from: current.lifecycle, to });
      current = step.prospect;
    }
    return { ok: true, prospect: current, hops };
  }

  /**
   * Record what happened on a contact attempt.
   *
   * @param {object} prospect
   * @param {string} outcome    a CALL_OUTCOMES code
   * @param {string} actor      who is recording it
   * @param {string} note       what actually happened, in words
   * @param {string} [e164]     the number that was dialled — REQUIRED for
   *                            `wrong_person`, whose consequence is about a
   *                            number rather than a business
   * @param {object} [remediation]  passed through for remediation-gated moves
   */
  // ASYNC SINCE M8C. The suppression collaborator may be the pure in-memory
  // list (returns a result object) or the durable service (returns a promise of
  // one). `await` handles both identically, so this module composes with either
  // without knowing which it was given — and the "suppress before you
  // transition" ordering below now spans a durable write rather than a Map
  // insert, which is the whole point.
  async function record({ prospect, outcome, actor, actorKind = "system", note, e164 = null, remediation = null } = {}) {
    if (!prospect || typeof prospect !== "object" || Array.isArray(prospect)) {
      return { ok: false, code: "prospect_invalid", message: "There is no prospect to record an outcome against." };
    }
    if (!CALL_OUTCOMES.includes(outcome)) {
      return { ok: false, code: "outcome_unknown", message: `"${String(outcome).slice(0, 40)}" is not an outcome this system records.` };
    }

    const who = clip(actor, 120);
    if (!who) return { ok: false, code: "actor_missing", message: "An outcome has to record who observed it." };

    const what = clip(note, MAX_TEXT);
    if (!what) return { ok: false, code: "note_missing", message: "An outcome has to record what actually happened." };

    if (!OUTCOME_RECORDABLE_FROM.includes(prospect.lifecycle)) {
      return {
        ok: false,
        code: "not_contactable_state",
        message: `This business is "${S.PROSPECT_STATE_LABELS[prospect.lifecycle] || prospect.lifecycle}" — no call could have been made to it, so there is no outcome to record. If a call was made, it happened outside the queue and that is the thing to look at.`,
      };
    }

    const mapping = OUTCOME_LIFECYCLE[outcome];
    const rule = OUTCOME_RULES[outcome];

    // ── The approved consequences, applied BEFORE the transition ────
    const fingerprint = identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state });
    const number = clip(e164, 20);
    let suppressionResult = null;

    if (rule.effect === "suppress_business_permanently" || rule.effect === "suppress_number") {
      if (!suppression) {
        // Refusing is the only safe answer. Recording "they opted out" while
        // being unable to act on it produces a record that says the right thing
        // and a system that will call them again.
        return {
          ok: false,
          code: "suppression_unavailable",
          message: "This outcome must permanently suppress the business or the number, and no suppression list is available. Refusing to record it, because recording it without acting on it would leave them callable.",
        };
      }

      const numberScoped = rule.effect === "suppress_number";
      if (numberScoped && !number) {
        return { ok: false, code: "number_required", message: "A wrong-number outcome suppresses the number that was dialled, so it needs that number." };
      }

      suppressionResult = await suppression.suppress({
        reason: numberScoped ? "wrong_number" : "opt_out",
        e164: number,
        // A business-wide suppression needs the identity, or the same locksmith
        // is reachable on its other line next week.
        fingerprint: numberScoped ? null : fingerprint,
        actor: who,
        actorKind,
        note: what,
      });

      if (!suppressionResult.ok) {
        return { ok: false, code: "suppression_failed", message: `The outcome was not recorded because the suppression could not be written: ${suppressionResult.message}`, suppression: suppressionResult };
      }
    }

    // ── The transition ──────────────────────────────────────────────
    const reason = `${mapping.meaning} ${what}`.trim();
    const moved = walk(prospect, mapping.to, { reachedTheBusiness: mapping.reachedTheBusiness, actor: who, reason, remediation });
    if (!moved.ok) return moved;

    // ── What follows, and whether anybody has agreed to it ──────────
    const consequence = describeConsequence(outcome, rule, policy);

    if (audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId,
        event: "contact_outcome",
        decision: "record",
        actor: who,
        actorKind: actorKind === "human" ? "human" : "system",
        reason,
        detail: {
          outcome,
          effect: rule.effect,
          effectApproved: rule.approved,
          from: prospect.lifecycle,
          to: moved.prospect.lifecycle,
          hops: moved.hops,
          suppressed: Boolean(suppressionResult),
          e164: number,
        },
      });
    }

    return Object.freeze({
      ok: true,
      prospect: moved.prospect,
      outcome,
      outcomeMeaning: mapping.meaning,
      reachedTheBusiness: mapping.reachedTheBusiness,
      from: prospect.lifecycle,
      to: moved.prospect.lifecycle,
      hops: Object.freeze(moved.hops.map((h) => Object.freeze({ ...h }))),
      suppression: suppressionResult ? Object.freeze({ applied: true, scope: suppressionResult.entry.scope, reason: suppressionResult.entry.reason, entry: suppressionResult.entry }) : Object.freeze({ applied: false }),
      consequence,
      recordedAt: now().toISOString(),
      message: `${mapping.meaning} ${consequence.message}`,
    });
  }

  /**
   * A prospect became a client. Not a call outcome — it happens after the
   * conversation, often days later — so it is a separate entry point rather
   * than a tenth CALL_OUTCOMES value nobody would think to look for.
   */
  function recordConversion({ prospect, actor, reason, remediation = null } = {}) {
    if (!prospect || typeof prospect !== "object" || Array.isArray(prospect)) {
      return { ok: false, code: "prospect_invalid", message: "There is no prospect to convert." };
    }
    const who = clip(actor, 120);
    if (!who) return { ok: false, code: "actor_missing", message: "A conversion has to record who confirmed it." };
    const why = clip(reason, MAX_TEXT);
    if (!why) return { ok: false, code: "reason_missing", message: "A conversion has to record what was agreed." };

    const step = transitionProspect(prospect, "customer", { actor: who, reason: why, now, remediation });
    if (!step.ok) return step;

    if (audit) {
      audit.record({
        entityType: "prospect",
        entityId: prospect.prospectId,
        event: "converted",
        decision: "record",
        actor: who,
        actorKind: "human",
        reason: why,
        detail: { from: prospect.lifecycle },
      });
    }

    return Object.freeze({
      ok: true,
      prospect: step.prospect,
      from: prospect.lifecycle,
      to: "customer",
      // Worth saying out loud: they are out of the prospecting pool entirely,
      // and the state machine enforces it.
      message: "This business is now a client. It can no longer appear in a prospecting queue.",
    });
  }

  return Object.freeze({
    record,
    recordConversion,
    describeOutcome: (outcome) => describeConsequence(outcome, OUTCOME_RULES[outcome], policy),
    outcomes: CALL_OUTCOMES,
    lifecycleFor: (outcome) => OUTCOME_LIFECYCLE[outcome] || null,
  });
}

/**
 * What follows from an outcome, and whether it is settled policy.
 *
 * The unapproved cases say so in the message a founder reads. An outcome whose
 * follow-on rule nobody has agreed to is not a bug — it is a decision still
 * outstanding — but it must not look like a rule that is in force.
 */
function describeConsequence(outcome, rule, policy) {
  if (!rule) return Object.freeze({ effect: null, approved: false, applied: false, message: "There is no recorded consequence for this outcome." });

  if (rule.effect === "suppress_business_permanently") {
    return Object.freeze({ effect: rule.effect, approved: true, applied: true, message: "This business must never be contacted again, on any number, in any campaign." });
  }
  if (rule.effect === "suppress_number") {
    return Object.freeze({ effect: rule.effect, approved: true, applied: true, message: "That number must never be dialled again. The business may still be reachable on another number." });
  }
  if (rule.effect === "stop_calling") {
    return Object.freeze({ effect: rule.effect, approved: true, applied: true, message: "No further calls — this prospect has moved past cold outreach." });
  }

  // Everything else depends on a duration or a cap.
  //
  // TWO DIFFERENT QUESTIONS, and conflating them was a bug caught in review.
  // `rule.approved` is PROVENANCE: does this rule have an independent source
  // (statute, or a document that states it outright)? It is a fixed property of
  // the rule and approval never changes it. `policy.approved` is FORCE: has a
  // named human agreed to the proposed values? A founder approving the attempt
  // policy is exactly how a rule with no external source comes into force, so
  // requiring both would make that approval unable to approve anything.
  const days = rule.ruleKey ? policy.value(rule.ruleKey) : null;
  const approved = rule.approved === true || policy.approved === true;
  return Object.freeze({
    effect: rule.effect,
    approved,
    applied: false,
    ruleKey: rule.ruleKey || null,
    proposedDays: days,
    // Carried whether or not it is in force: "approved by Peter, on no external
    // source" is a materially different position from "approved, statutory",
    // and a reader is entitled to tell them apart.
    source: rule.source,
    hasIndependentSource: rule.approved === true,
    approvedBy: rule.approved !== true && policy.approved === true ? policy.approvedBy : null,
    message: approved
      ? `${rule.effect} applies${days ? ` for ${days} days` : ""}${rule.approved === true ? "" : ` — approved by ${policy.approvedBy}, on no external source (${rule.source})`}.`
      : `What happens next is not settled: "${rule.effect}"${days ? ` was proposed as ${days} days` : ""}, but nobody has approved it (${rule.source}). Until they do, the eligibility engine blocks this prospect anyway.`,
  });
}

module.exports = {
  createOutcomeRecorder,
  OUTCOME_LIFECYCLE,
  OUTCOME_RECORDABLE_FROM,
};
