// AIDA Locksmith Acquisition — attempt and wash policy (A2).
//
//   createAttemptPolicy({ approved, rules, source })
//   policy.assess({ attempts, lastAttemptAt, lastOutcome, ... }, { now })
//
// Owns the answers to: how many times may a business be tried, how far apart,
// how long a wash may be relied on, and what each call outcome does to the
// record afterwards.
//
// ── WHY THIS IS A SEPARATE MODULE THAT DEFAULTS TO UNAPPROVED ───────
// The repository does NOT contain approved values for most of this, and the
// gap is easy to miss because plausible numbers are already sitting in
// DEFAULT_CAPS. Reading the source documents carefully:
//
//   G9 (max attempts)        "Hard ceiling on attempts per contact per campaign
//                            (e.g. 3)". The "e.g." is doing a lot of work —
//                            that is an ILLUSTRATION, not a decision.
//   G8 (recent contact)      "Don't call the same person within N days". N is
//                            literally the letter N. Nobody has chosen it.
//   retry spacing            Appears nowhere in any document.
//   outcome handling         §9 is explicit for opt-out (permanent) and
//                            wrong-person (do not re-dial that number), and
//                            vague for everything else — "not interested" gets
//                            "a long cooldown" with no duration.
//   DNCR 30-day wash         §2.2 and G4, cited to the Do Not Call Register Act
//                            — a statutory period, not a preference.
//
// So this module carries a per-rule `approved` flag and a `source` string, and
// the whole policy defaults to `approved: false`. The eligibility engine treats
// an unapproved policy as a BLOCKER: nothing is eligible until a human has
// actually chosen these numbers. That is the difference between "we have not
// decided yet" and "we decided 3, apparently, at some point, in a config file".
//
// Turning the policy on is `createAttemptPolicy({ approved: true, rules, ... })`
// with an explicit `approvedBy` — a decision with a name on it.
//
// Pure + dep-free. See test/acquisition-eligibility.test.js.

const { DEFAULT_CAPS, DNCR_WASH_VALIDITY_DAYS } = require("../config/acquisition");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Call outcomes, matching the `outcomes.category` vocabulary in the BDM data
// model (docs/OUTBOUND_BDM_ARCHITECTURE.md §11).
const CALL_OUTCOMES = Object.freeze([
  "booked",
  "qualified",
  "not_interested",
  "opt_out",
  "wrong_person",
  "callback",
  "voicemail",
  "no_answer",
  "declined",
]);

/**
 * The PROPOSED rules. Every one carries where it came from and whether anybody
 * with authority has agreed to it.
 *
 * `approved: true` appears only where a document states a value outright rather
 * than illustrating one. Today that is exactly one rule: the statutory DNCR
 * wash period.
 */
const PROPOSED_RULES = Object.freeze({
  maxAttemptsPerProspect: Object.freeze({
    value: DEFAULT_CAPS.maxAttemptsPerProspect,
    approved: false,
    source: "OUTBOUND_BDM_ARCHITECTURE.md §5 G9 — \"(e.g. 3)\", an illustration, not a decision",
  }),
  minDaysBetweenAttempts: Object.freeze({
    value: DEFAULT_CAPS.minDaysBetweenAttempts,
    approved: false,
    source: "No source. Proposed during A1 implementation; no document specifies retry spacing",
  }),
  recentContactCooldownDays: Object.freeze({
    value: DEFAULT_CAPS.recentContactCooldownDays,
    approved: false,
    source: "OUTBOUND_BDM_ARCHITECTURE.md §5 G8 — \"within N days\", N unspecified",
  }),
  washValidityDays: Object.freeze({
    value: DNCR_WASH_VALIDITY_DAYS,
    approved: true,
    source: "Do Not Call Register Act 2006 / Telemarketing Industry Standard 2017, via OUTBOUND_BDM_ARCHITECTURE.md §2.2 and G4 — a statutory period",
  }),
  notInterestedCooldownDays: Object.freeze({
    value: 180,
    approved: false,
    source: "OUTBOUND_BDM_ARCHITECTURE.md §9 — \"suppress for a long cooldown\", duration unspecified",
  }),
  declinedCooldownDays: Object.freeze({
    value: 90,
    approved: false,
    source: "No source. Proposed",
  }),
  callbackHonourDays: Object.freeze({
    value: 14,
    approved: false,
    source: "No source. Proposed",
  }),
});

/**
 * What each outcome does to the record. The two entries marked approved are the
 * ones §9 states outright; the rest are proposals about DURATION, even where
 * the DIRECTION is obvious.
 */
const OUTCOME_RULES = Object.freeze({
  opt_out: Object.freeze({
    effect: "suppress_business_permanently",
    approved: true,
    source: "OUTBOUND_BDM_ARCHITECTURE.md §5 G5 / §9 — opt-out is permanent and cross-campaign",
  }),
  wrong_person: Object.freeze({
    effect: "suppress_number",
    approved: true,
    source: "OUTBOUND_BDM_ARCHITECTURE.md §9 — \"don't re-dial the wrong number\"",
  }),
  not_interested: Object.freeze({ effect: "cooldown", ruleKey: "notInterestedCooldownDays", approved: false, source: "§9 — direction clear, duration unspecified" }),
  declined: Object.freeze({ effect: "cooldown", ruleKey: "declinedCooldownDays", approved: false, source: "No source" }),
  no_answer: Object.freeze({ effect: "counts_as_attempt", approved: false, source: "No source — whether an unanswered call consumes an attempt is undecided" }),
  voicemail: Object.freeze({ effect: "counts_as_attempt", approved: false, source: "No source; §16 Q6 leaves cold voicemail itself undecided" }),
  callback: Object.freeze({ effect: "reschedule", ruleKey: "callbackHonourDays", approved: false, source: "No source" }),
  booked: Object.freeze({ effect: "stop_calling", approved: true, source: "A booked prospect is no longer a prospect" }),
  qualified: Object.freeze({ effect: "stop_calling", approved: true, source: "A qualified prospect hands off to the CRM" }),
});

/**
 * Create an attempt/wash policy.
 *
 * @param {boolean} [approved]    whether a human has agreed these values. FALSE
 *                                by default and must be set deliberately.
 * @param {string}  [approvedBy]  who agreed. Required when approved is true.
 * @param {object}  [rules]       overrides, shape { key: number }
 * @param {string}  [version]     an identifier that appears in every decision
 */
function createAttemptPolicy({ approved = false, approvedBy = null, rules = {}, version = "proposed-v1" } = {}) {
  // Merge overrides. An overridden value is still unapproved unless the caller
  // also said so — supplying a number is not the same as agreeing to it.
  const merged = {};
  for (const [key, rule] of Object.entries(PROPOSED_RULES)) {
    const override = rules[key];
    merged[key] = Object.freeze({
      ...rule,
      value: Number.isFinite(override) ? override : rule.value,
      overridden: Number.isFinite(override),
    });
  }

  const unapprovedRules = Object.entries(merged)
    .filter(([, r]) => !r.approved)
    .map(([key, r]) => ({ key, value: r.value, source: r.source }));

  const unapprovedOutcomes = Object.entries(OUTCOME_RULES)
    .filter(([, r]) => !r.approved)
    .map(([outcome, r]) => ({ outcome, effect: r.effect, source: r.source }));

  // The whole policy is usable only when a human has approved it AND said who
  // they are. `approved: true` with no name is not an approval.
  const effectivelyApproved = approved === true && typeof approvedBy === "string" && approvedBy.trim().length > 0;

  const value = (key) => merged[key].value;

  /**
   * Assess attempt/wash restrictions for one prospect.
   * Returns { ok, code, message, temporary, readyAt } — readyAt is the instant
   * the restriction lifts, where that is calculable.
   */
  function assess({ attempts = 0, lastAttemptAt = null, lastContactAt = null, lastOutcome = null } = {}, { now } = {}) {
    if (typeof now !== "function") throw new Error("attemptPolicy.assess requires an injected now().");
    const instant = now();

    // A terminal outcome stops calling regardless of counts.
    if (lastOutcome && OUTCOME_RULES[lastOutcome] && OUTCOME_RULES[lastOutcome].effect === "stop_calling") {
      return { ok: false, code: "outcome_terminal", temporary: false, readyAt: null, message: `This prospect was already ${lastOutcome === "booked" ? "booked" : "qualified and handed over"}, so it is no longer being called.` };
    }

    const cap = value("maxAttemptsPerProspect");
    if (Number.isFinite(cap) && attempts >= cap) {
      return { ok: false, code: "attempt_cap_reached", temporary: false, readyAt: null, message: `We have already tried this business ${attempts} time${attempts === 1 ? "" : "s"}. The limit is ${cap}, so there will be no more attempts.` };
    }

    // Outcome-driven cooldowns.
    if (lastOutcome && OUTCOME_RULES[lastOutcome] && OUTCOME_RULES[lastOutcome].effect === "cooldown") {
      const days = value(OUTCOME_RULES[lastOutcome].ruleKey);
      const from = Date.parse(lastAttemptAt || lastContactAt || "");
      if (Number.isFinite(from) && Number.isFinite(days)) {
        const readyAt = new Date(from + days * MS_PER_DAY);
        if (instant.getTime() < readyAt.getTime()) {
          return { ok: false, code: "outcome_cooldown", temporary: true, readyAt, message: `They said ${lastOutcome === "not_interested" ? "they were not interested" : "no"} last time, so this business is left alone for ${days} days.` };
        }
      }
    }

    const spacing = value("minDaysBetweenAttempts");
    if (Number.isFinite(spacing) && lastAttemptAt) {
      const from = Date.parse(lastAttemptAt);
      if (Number.isFinite(from)) {
        const readyAt = new Date(from + spacing * MS_PER_DAY);
        if (instant.getTime() < readyAt.getTime()) {
          return { ok: false, code: "retry_spacing", temporary: true, readyAt, message: `We tried this business less than ${spacing} day${spacing === 1 ? "" : "s"} ago. Calling again this soon is harassment, not persistence.` };
        }
      }
    }

    const cooldown = value("recentContactCooldownDays");
    if (Number.isFinite(cooldown) && lastContactAt) {
      const from = Date.parse(lastContactAt);
      if (Number.isFinite(from)) {
        const readyAt = new Date(from + cooldown * MS_PER_DAY);
        if (instant.getTime() < readyAt.getTime()) {
          return { ok: false, code: "recent_contact_cooldown", temporary: true, readyAt, message: `We spoke to this business within the last ${cooldown} days. They are left alone until that period is up.` };
        }
      }
    }

    return { ok: true, code: "attempts_ok", temporary: false, readyAt: null, message: "Attempt limits and cooldowns allow another call." };
  }

  return Object.freeze({
    version,
    approved: effectivelyApproved,
    approvedBy: effectivelyApproved ? approvedBy.trim() : null,
    rules: Object.freeze(merged),
    outcomeRules: OUTCOME_RULES,
    unapprovedRules: Object.freeze(unapprovedRules),
    unapprovedOutcomes: Object.freeze(unapprovedOutcomes),
    value,
    assess,
    /** One sentence naming exactly what is still undecided. */
    describeGap() {
      if (effectivelyApproved) return `Attempt and wash policy "${version}" was approved by ${approvedBy.trim()}.`;
      if (approved === true) return "The attempt and wash policy was marked approved but nobody was named as approving it, so it is not in force.";
      const keys = unapprovedRules.map((r) => r.key).join(", ");
      return `The attempt and wash policy has not been approved. These values are proposals nobody has agreed to: ${keys}.`;
    },
  });
}

module.exports = {
  createAttemptPolicy,
  PROPOSED_RULES,
  OUTCOME_RULES,
  CALL_OUTCOMES,
};
