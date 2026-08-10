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
// For most of this project's life the repository did NOT contain approved
// values, and the gap was easy to miss because plausible numbers were already
// sitting in DEFAULT_CAPS. The documents illustrated rather than decided:
//
//   G9 (max attempts)        "Hard ceiling on attempts per contact per campaign
//                            (e.g. 3)". The "e.g." was doing a lot of work.
//   G8 (recent contact)      "Don't call the same person within N days". N was
//                            literally the letter N.
//   retry spacing            Appeared nowhere in any document.
//   outcome handling         §9 was explicit for opt-out (permanent) and
//                            wrong-person (do not re-dial that number), and
//                            vague for everything else — "not interested" got
//                            "a long cooldown" with no duration.
//   DNCR 30-day wash         §2.2 and G4, cited to the Do Not Call Register Act
//                            — a statutory period, not a preference.
//
// So this module carries a per-rule `approved` flag and a `source` string, and
// the whole policy still defaults to `approved: false`. The eligibility engine
// treats an unapproved policy as a BLOCKER. That is the difference between "we
// have not decided yet" and "we decided 3, apparently, at some point, in a
// config file".
//
// ── A-L6 / A-L7 / A-L8 ARE NOW DECIDED ──────────────────────────────
// The founder has since chosen these values outright; see FOUNDER_APPROVAL
// below, which every rule it settles cites by reference rather than restating.
// Three things about that closure are worth stating here, because each replaces
// a placeholder that a reader might otherwise expect to still find:
//
//   1. A no-answer does NOT consume a counted attempt; a voicemail DOES. The
//      cap is 2 COUNTED attempts, so ringing out is not the same as trying.
//   2. `not_interested` and `declined` are no longer 180- and 90-day cooldowns.
//      They are PERMANENT — the business is never cold-acquired again — and
//      they remain two distinct labels, because "they said no" and "they were
//      not interested" are different facts even when the consequence is one.
//   3. The generic 30-day post-contact cooldown is RETIRED as a binding rule,
//      not re-tuned. A real conversation ends in a specific outcome, and that
//      outcome governs. Retired rules are kept here with `value: null` and
//      `retired: true` precisely so the old numbers cannot quietly return.
//
// Turning the policy on is still `createAttemptPolicy({ approved: true, ... })`
// with an explicit `approvedBy` — a decision with a name on it — and it is now
// ALSO refused if any individual rule, outcome or consumption entry is still
// unapproved. An approval cannot outrun the things it is approving.
//
// Pure + dep-free. See test/acquisition-attempt-policy.test.js.

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
 * The founder's decision on A-L6, A-L7 and A-L8, recorded ONCE so that every
 * rule it settles can cite it by reference. An approval that is restated in
 * seven places is an approval that can drift in six of them.
 */
const FOUNDER_APPROVAL = Object.freeze({
  ref: "AL6-AL7-AL8-2026-08-10",
  approvedBy: "Peter Dang",
  approvedAt: "2026-08-10",
  covers: Object.freeze(["A-L6", "A-L7", "A-L8"]),
  statement:
    "Maximum 2 counted attempts per business; at least 2 days between ordinary attempts; a no-answer does not consume a counted attempt and a voicemail does; not_interested and declined both mean the business is never cold-acquired again; an explicitly requested callback is honoured for 14 days; the generic 30-day post-contact cooldown is retired as a binding rule.",
});

/** Every rule the founder settled cites this rather than restating it. */
const BY_FOUNDER = `Founder approval ${FOUNDER_APPROVAL.ref} (${FOUNDER_APPROVAL.approvedBy}, ${FOUNDER_APPROVAL.approvedAt})`;

/**
 * The rules in force. Every one carries where it came from and whether somebody
 * with authority agreed to it.
 *
 * `direction` says what a per-campaign override is ALLOWED to do, which is the
 * mechanism behind A-L4's "a campaign may be stricter, never looser":
 *
 *   ceiling  an override may only LOWER the value (fewer calls)
 *   floor    an override may only RAISE it (more waiting)
 *
 * A `retired: true` rule carries `value: null` and ignores overrides entirely.
 * It is kept rather than deleted so the number it used to hold cannot come back
 * by accident, and so a reader looking for "the 30-day cooldown" finds an
 * explicit statement that it was retired instead of finding nothing.
 */
const POLICY_RULES = Object.freeze({
  maxAttemptsPerProspect: Object.freeze({
    value: 2,
    approved: true,
    direction: "ceiling",
    source: `${BY_FOUNDER} — A-L6: at most 2 COUNTED attempts per business. Supersedes the "(e.g. 3)" illustration in OUTBOUND_BDM_ARCHITECTURE.md §5 G9, which was never a decision`,
  }),
  minDaysBetweenAttempts: Object.freeze({
    value: 2,
    approved: true,
    direction: "floor",
    source: `${BY_FOUNDER} — A-L6: at least 2 days between ordinary attempts`,
  }),
  recentContactCooldownDays: Object.freeze({
    value: null,
    approved: true,
    retired: true,
    source: `${BY_FOUNDER} — A-L6: RETIRED as a binding rule. Once a real conversation happens the call ends in a specific outcome and that outcome governs; a generic post-contact silence was a placeholder standing in for outcomes we had not modelled. Supersedes the 30-day value and OUTBOUND_BDM_ARCHITECTURE.md §5 G8's unspecified "N days"`,
  }),
  washValidityDays: Object.freeze({
    value: DNCR_WASH_VALIDITY_DAYS,
    approved: true,
    direction: "ceiling",
    source: "Do Not Call Register Act 2006 / Telemarketing Industry Standard 2017, via OUTBOUND_BDM_ARCHITECTURE.md §2.2 and G4 — a statutory period",
  }),
  notInterestedCooldownDays: Object.freeze({
    value: null,
    approved: true,
    retired: true,
    source: `${BY_FOUNDER} — A-L8: RETIRED. "Not interested" is no longer a 180-day cooldown; it is permanent no-recontact, expressed as an outcome effect rather than a duration`,
  }),
  declinedCooldownDays: Object.freeze({
    value: null,
    approved: true,
    retired: true,
    source: `${BY_FOUNDER} — A-L8: RETIRED. "Declined" is no longer a 90-day cooldown; it is permanent no-recontact`,
  }),
  callbackHonourDays: Object.freeze({
    value: 14,
    approved: true,
    direction: "ceiling",
    source: `${BY_FOUNDER} — A-L8: an explicitly requested callback is honoured for 14 days`,
  }),
});

/**
 * A callback the recipient ASKED FOR is invited contact, not a cold acquisition
 * attempt. That is why it is an exception to ordinary retry spacing and to the
 * counted-attempt cap: neither of those rules is about a call the business
 * requested. Stated as a named, sourced rule rather than buried in a branch,
 * because it is the one place this module lets a call through that the plain
 * numbers would have stopped.
 *
 * It is bounded hard by `callbackHonourDays`. Past that window the invitation
 * has gone stale and this module refuses rather than quietly falling back to
 * cold-call permission it does not have.
 */
const CALLBACK_IS_INVITED_CONTACT = Object.freeze({
  value: true,
  approved: true,
  source: `${BY_FOUNDER} — A-L8: "if the recipient explicitly requests a callback, honour that callback"; the recipient invited the contact`,
});

/**
 * WHICH OUTCOMES CONSUME A COUNTED ATTEMPT — i.e. A-L7, now DECIDED.
 *
 * ── WHY THIS TABLE EXISTS AND WHY IT LIVES HERE ─────────────────────
 * E-1 gave this module a durable contact history: the ordered list of what
 * actually happened to a business, read from acquisition_contact_outcomes.
 * Turning that list into a NUMBER requires deciding whether an unanswered call
 * and a voicemail count, and that was A-L7.
 *
 * The obvious implementation, `attempts = outcomes.length`, would have answered
 * it by accident inside a row reader. So the count is computed HERE, from a
 * table where each entry carries its own `approved` flag and its source.
 *
 * The decision changed a PREDICATE over the outcome list, not a persisted
 * number — exactly as M8J designed for. No backfill, no migration, no recount:
 * the stored rows were already correct and remain untouched.
 */
const ATTEMPT_CONSUMPTION = Object.freeze({
  // Reached nobody. The phone rang out; nobody was troubled and nothing was
  // said. The founder decided this does NOT spend one of the two attempts.
  //
  // NOTE the consequence, which is real: the cap alone no longer bounds how
  // many times a never-answering business may be rung. What bounds it is
  // `minDaysBetweenAttempts`, whose clock starts at the last recorded call
  // EVENT including a no-answer. Whether an uncounted redial should have its
  // own ceiling is A-L10, raised by this work and still open.
  no_answer: Object.freeze({ countsTowardCap: false, approved: true, source: `${BY_FOUNDER} — A-L7: an unanswered call does not consume one of the 2 counted attempts` }),

  // A message was left. Something was said to the business, so it counts.
  voicemail: Object.freeze({ countsTowardCap: true, approved: true, source: `${BY_FOUNDER} — A-L7: leaving a voicemail does consume a counted attempt` }),

  // Somebody answered and it was not this business. Counted because the call
  // was placed; moot in practice because §9 suppresses the NUMBER on this
  // outcome, so the count is not what stops the next call to it.
  wrong_person: Object.freeze({ countsTowardCap: true, approved: true, source: "Moot: OUTBOUND_BDM_ARCHITECTURE.md §9 suppresses the number on this outcome, so the count is not what prevents a re-dial" }),

  // We spoke to them. Nobody disputes that this is an attempt; what follows it
  // is governed by the cooldown rules above, not by the cap.
  not_interested: Object.freeze({ countsTowardCap: true, approved: true, source: "A conversation happened; that it was an attempt is not in question" }),
  declined: Object.freeze({ countsTowardCap: true, approved: true, source: "A conversation happened" }),
  callback: Object.freeze({ countsTowardCap: true, approved: true, source: "A conversation happened" }),
  booked: Object.freeze({ countsTowardCap: true, approved: true, source: "A conversation happened" }),
  qualified: Object.freeze({ countsTowardCap: true, approved: true, source: "A conversation happened" }),

  // An opt-out ends the relationship permanently. Whether it also consumed an
  // attempt is moot — suppression outranks the cap at a higher precedence — but
  // it is listed rather than omitted so every outcome has an entry.
  opt_out: Object.freeze({ countsTowardCap: true, approved: true, source: "Moot: suppression outranks the cap" }),
});

/**
 * What each outcome does to the record.
 *
 * ── THE THREE WAYS A BUSINESS STOPS BEING CALLED, KEPT APART ────────
 * They look alike from inside a single call and are completely different facts
 * afterwards, so they get three effects and three codes, never one:
 *
 *   suppress_business_permanently   opt_out — THE PERSON ASKED. The strongest
 *                                   statement, separately auditable, and the
 *                                   only one that belongs on the suppression
 *                                   list. Nothing below may be recorded as
 *                                   this: a business declining our pitch has
 *                                   not asked us to stop contacting them, and
 *                                   writing it down as though it had would
 *                                   fabricate a request nobody made.
 *
 *   no_further_acquisition          not_interested / declined — THE BUSINESS
 *                                   SAID NO to being acquired. Permanent for
 *                                   cold acquisition and derived from the
 *                                   durable outcome history, so it survives a
 *                                   restart, a re-import and a new process
 *                                   without a suppression row existing.
 *
 *   stop_calling                    booked / qualified — WE succeeded. Not a
 *                                   refusal at all; they stopped being a
 *                                   prospect by becoming something better.
 *
 * `not_interested` and `declined` share an effect but remain DISTINCT labels,
 * because analytics and audit need to tell "they heard it and weren't
 * interested" from "they said no" even when today's consequence is identical.
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
  not_interested: Object.freeze({
    effect: "no_further_acquisition",
    approved: true,
    source: `${BY_FOUNDER} — A-L8: a business that says it is not interested is never cold-acquired again. Supersedes the proposed 180-day cooldown, which was a duration standing in for a decision`,
  }),
  declined: Object.freeze({
    effect: "no_further_acquisition",
    approved: true,
    source: `${BY_FOUNDER} — A-L8: a business that declines is never cold-acquired again. Supersedes the proposed 90-day cooldown`,
  }),
  no_answer: Object.freeze({ effect: "does_not_consume_attempt", approved: true, source: `${BY_FOUNDER} — A-L7: ringing out is not an attempt spent` }),
  voicemail: Object.freeze({ effect: "counts_as_attempt", approved: true, source: `${BY_FOUNDER} — A-L7: a message left is an attempt spent` }),
  callback: Object.freeze({ effect: "reschedule", ruleKey: "callbackHonourDays", approved: true, source: `${BY_FOUNDER} — A-L8: honour an explicitly requested callback for 14 days` }),
  booked: Object.freeze({ effect: "stop_calling", approved: true, source: "A booked prospect is no longer a prospect" }),
  qualified: Object.freeze({ effect: "stop_calling", approved: true, source: "A qualified prospect hands off to the CRM" }),
});

/**
 * Effects that mean "do not place another cold acquisition call to this
 * business, ever". Scanned across the WHOLE history rather than read off the
 * latest outcome — see assess().
 */
const NO_RECONTACT_EFFECTS = Object.freeze(["suppress_business_permanently", "no_further_acquisition", "stop_calling"]);

/** The refusal code each of those effects produces. Distinct on purpose. */
const NO_RECONTACT_CODES = Object.freeze({
  suppress_business_permanently: "opted_out",
  no_further_acquisition: "acquisition_declined",
  stop_calling: "outcome_terminal",
});

/**
 * Plain English for why a business will not be called again. The wording keeps
 * the three refusals distinct, because "they asked us to stop" and "they were
 * not interested" must never read as the same event to whoever is looking at
 * this later.
 */
function describeNoRecontact(outcome, effect) {
  if (effect === "suppress_business_permanently") {
    return "This business asked not to be contacted. That is permanent and applies to every number it has.";
  }
  if (effect === "stop_calling") {
    return `This prospect was already ${outcome === "booked" ? "booked" : "qualified and handed over"}, so it is no longer being called.`;
  }
  return outcome === "not_interested"
    ? "This business told us it was not interested. It is not cold-called for acquisition again — that decision is permanent, not a cooldown."
    : "This business declined. It is not cold-called for acquisition again — that decision is permanent, not a cooldown.";
}

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
  //
  // A-L4 says a campaign may be STRICTER, never looser, and that is enforced
  // here rather than trusted: an override that would loosen an approved rule is
  // clamped back to the approved value and recorded in `refusedOverrides`. This
  // is what stops the retired 3-attempt cap, or any other convenient number,
  // from returning through a config path.
  const merged = {};
  const refusedOverrides = [];
  for (const [key, rule] of Object.entries(POLICY_RULES)) {
    const override = rules[key];
    const supplied = Number.isFinite(override);

    if (supplied && rule.retired === true) {
      refusedOverrides.push({ key, requested: override, applied: null, why: "This rule is retired; it has no value to override." });
      merged[key] = Object.freeze({ ...rule, overridden: false });
      continue;
    }

    let value = rule.value;
    let overridden = false;
    if (supplied) {
      const looser = rule.direction === "ceiling" ? override > rule.value : rule.direction === "floor" ? override < rule.value : false;
      if (looser) {
        refusedOverrides.push({ key, requested: override, applied: rule.value, why: `A campaign may be stricter than the approved policy, never looser (${rule.direction}).` });
      } else {
        value = override;
        overridden = true;
      }
    }
    merged[key] = Object.freeze({ ...rule, value, overridden });
  }

  const unapprovedRules = Object.entries(merged)
    .filter(([, r]) => !r.approved)
    .map(([key, r]) => ({ key, value: r.value, source: r.source }));

  const unapprovedOutcomes = Object.entries(OUTCOME_RULES)
    .filter(([, r]) => !r.approved)
    .map(([outcome, r]) => ({ outcome, effect: r.effect, source: r.source }));

  // A-L7, surfaced the same way every other open question is (M8J).
  const unapprovedConsumption = Object.entries(ATTEMPT_CONSUMPTION)
    .filter(([, r]) => !r.approved)
    .map(([outcome, r]) => ({ outcome, countsTowardCap: r.countsTowardCap, source: r.source }));

  // The whole policy is usable only when a human has approved it, said who they
  // are, AND nothing inside it is still undecided. `approved: true` with no name
  // is not an approval; neither is an approval that covers a table still
  // carrying an unapproved entry. An approval cannot outrun its contents.
  const named = approved === true && typeof approvedBy === "string" && approvedBy.trim().length > 0;
  const nothingOutstanding = unapprovedRules.length === 0 && unapprovedOutcomes.length === 0 && unapprovedConsumption.length === 0;
  const effectivelyApproved = named && nothingOutstanding;

  const value = (key) => merged[key].value;

  /**
   * Count the attempts a durable history represents, under THIS policy.
   *
   * The whole point of the E-1 seam: the history is a list of facts and this is
   * the interpretation of it. An outcome with no entry in ATTEMPT_CONSUMPTION
   * is counted — an unrecognised outcome must not silently be free.
   */
  function countAttempts(history) {
    if (!history || !history.available || !Array.isArray(history.outcomes)) return 0;
    return history.outcomes.filter((o) => {
      const rule = ATTEMPT_CONSUMPTION[o.outcome];
      return rule ? rule.countsTowardCap === true : true;
    }).length;
  }

  /**
   * Assess attempt/wash restrictions for one prospect.
   *
   * ── DURABLE HISTORY WINS (M8J / E-1) ────────────────────────────────
   * When `history` is a durable history from acquisition-history.js it is the
   * ONLY source: `attempts`, `lastAttemptAt`, `lastContactAt` and `lastOutcome`
   * are derived from it and any values the caller also passed are ignored. A
   * caller holding a stale snapshot must not be able to talk this module out of
   * what the database says.
   *
   * An UNAVAILABLE history is refused outright — `history_unavailable`. Not
   * knowing how many times a business has been called is not the same as
   * knowing it has never been called, and only one of those permits a call.
   *
   * The loose parameters remain for the walkthrough, the dry runs and the unit
   * tests that construct a scenario directly. They are not a production path,
   * and a ratchet asserts that every real authorisation supplies a durable one.
   *
   * Returns { ok, code, message, temporary, readyAt } — readyAt is the instant
   * the restriction lifts, where that is calculable.
   */
  function assess({ attempts = 0, lastAttemptAt = null, lastContactAt = null, lastOutcome = null, history = null } = {}, { now } = {}) {
    if (typeof now !== "function") throw new Error("attemptPolicy.assess requires an injected now().");
    const instant = now();
    let historyOutcomes = [];
    let lastCallbackAt = null;

    if (history) {
      if (history.available !== true) {
        return {
          ok: false,
          code: "history_unavailable",
          temporary: true,
          readyAt: null,
          message: `We cannot tell how many times this business has already been called. ${history.reason || ""} No call is made on an unknown attempt history — "unknown" is not "never".`.trim(),
        };
      }
      attempts = countAttempts(history);
      // The RETRY-SPACING CLOCK starts at the last recorded call event of any
      // kind — including a no-answer, which no longer consumes a counted
      // attempt. That is deliberate: an uncounted attempt still rang somebody's
      // phone, and 2 days of quiet is owed from the ringing, not from the
      // bookkeeping. It is also the only thing bounding redials to a business
      // that never answers (A-L10).
      lastAttemptAt = history.lastEventAt;
      lastContactAt = history.lastReachedAt;
      lastOutcome = history.latestOutcome;
      historyOutcomes = Array.isArray(history.outcomes) ? history.outcomes : [];
      for (let i = historyOutcomes.length - 1; i >= 0; i -= 1) {
        if (historyOutcomes[i].outcome === "callback") {
          lastCallbackAt = historyOutcomes[i].recordedAt;
          break;
        }
      }
    }

    // ── A REFUSAL ANYWHERE IN THE HISTORY IS PERMANENT ──────────────
    //
    // Scanned across the WHOLE outcome list, not read off the latest entry.
    // Reading only the latest is the bug this shape exists to prevent: a
    // business that said "not interested" and later had one more event recorded
    // against it — a stray no-answer from an in-flight call, a corrected import,
    // any later row at all — would have its refusal silently fall off the end
    // and become callable again. A "no" does not expire because something else
    // happened afterwards.
    //
    // Nothing here depends on a suppression row existing, so it survives a
    // restart, a re-import and a brand new process on the durable rows alone.
    const scanned = historyOutcomes.length ? historyOutcomes : lastOutcome ? [{ outcome: lastOutcome, recordedAt: lastAttemptAt || lastContactAt || null }] : [];
    for (const event of scanned) {
      const rule = OUTCOME_RULES[event.outcome];
      if (!rule || !NO_RECONTACT_EFFECTS.includes(rule.effect)) continue;
      return {
        ok: false,
        code: NO_RECONTACT_CODES[rule.effect],
        outcome: event.outcome,
        effect: rule.effect,
        temporary: false,
        readyAt: null,
        message: describeNoRecontact(event.outcome, rule.effect),
      };
    }

    // ── AN INVITED CALLBACK IS NOT A COLD CALL ──────────────────────
    //
    // Checked BEFORE the cap and the spacing rule, because neither of those is
    // about a call the recipient asked us to make. Bounded hard by the honour
    // window: once it lapses this refuses outright rather than letting the
    // business fall back into the ordinary cold-calling pool, which would be
    // inventing a permission out of an expired invitation.
    if (lastOutcome === "callback" && CALLBACK_IS_INVITED_CONTACT.value === true) {
      const honourDays = value("callbackHonourDays");
      const requestedAt = Date.parse(lastCallbackAt || lastAttemptAt || lastContactAt || "");
      if (Number.isFinite(requestedAt) && Number.isFinite(honourDays)) {
        const expiresAt = new Date(requestedAt + honourDays * MS_PER_DAY);
        if (instant.getTime() <= expiresAt.getTime()) {
          return { ok: true, code: "callback_honour", temporary: false, readyAt: null, invited: true, expiresAt, message: `This business asked us to call back, and that request is still current (it lapses ${expiresAt.toISOString().slice(0, 10)}). A requested callback is honoured despite the ordinary spacing and attempt limits, because they invited it.` };
        }
        return { ok: false, code: "callback_window_expired", temporary: false, readyAt: null, message: `This business asked us to call back, but that was more than ${honourDays} days ago and the request has lapsed. It is not treated as permission for a fresh cold call; a person has to decide what happens next.` };
      }
    }

    const cap = value("maxAttemptsPerProspect");
    if (Number.isFinite(cap) && attempts >= cap) {
      return { ok: false, code: "attempt_cap_reached", temporary: false, readyAt: null, message: `We have already tried this business ${attempts} time${attempts === 1 ? "" : "s"}. The limit is ${cap}, so there will be no more attempts.` };
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
    attemptConsumption: ATTEMPT_CONSUMPTION,
    unapprovedRules: Object.freeze(unapprovedRules),
    unapprovedOutcomes: Object.freeze(unapprovedOutcomes),
    unapprovedConsumption: Object.freeze(unapprovedConsumption),
    /** Overrides that tried to loosen an approved rule and were clamped. */
    refusedOverrides: Object.freeze(refusedOverrides),
    founderApproval: FOUNDER_APPROVAL,
    countAttempts,
    value,
    assess,
    /** One sentence naming exactly what is still undecided. */
    describeGap() {
      if (effectivelyApproved) return `Attempt and wash policy "${version}" was approved by ${approvedBy.trim()}.`;
      if (named && !nothingOutstanding) {
        const outstanding = [
          ...unapprovedRules.map((r) => r.key),
          ...unapprovedOutcomes.map((r) => `${r.outcome} (effect)`),
          ...unapprovedConsumption.map((r) => `${r.outcome} (counts?)`),
        ].join(", ");
        return `The attempt and wash policy was approved by ${approvedBy.trim()}, but it still contains entries nobody has agreed to, so it is not in force: ${outstanding}.`;
      }
      if (approved === true) return "The attempt and wash policy was marked approved but nobody was named as approving it, so it is not in force.";
      const keys = unapprovedRules.map((r) => r.key).join(", ");
      const consumption = unapprovedConsumption.map((r) => r.outcome).join(", ");
      return (
        `The attempt and wash policy has not been approved. These values are proposals nobody has agreed to: ${keys || "(none)"}.` +
        (consumption ? ` And it is still undecided whether these outcomes consume an attempt (A-L7): ${consumption}.` : "")
      );
    },
  });
}

/**
 * The policy AS THE FOUNDER APPROVED IT.
 *
 * The approval reference is used as the version, so every eligibility decision
 * this produces carries `attemptPolicyVersion: "AL6-AL7-AL8-2026-08-10"` — a
 * decision can be traced back to the approval that authorised it without anyone
 * having to remember which numbers were in force that week.
 *
 * Callers pass this deliberately. The eligibility engine still defaults to the
 * unapproved policy, because a build that forgets to supply one must refuse to
 * call anybody rather than quietly help itself to the founder's approval.
 */
function createFounderApprovedAttemptPolicy(overrides = {}) {
  return createAttemptPolicy({
    approved: true,
    approvedBy: FOUNDER_APPROVAL.approvedBy,
    version: FOUNDER_APPROVAL.ref,
    ...overrides,
  });
}

module.exports = {
  createAttemptPolicy,
  createFounderApprovedAttemptPolicy,
  POLICY_RULES,
  OUTCOME_RULES,
  ATTEMPT_CONSUMPTION,
  CALL_OUTCOMES,
  FOUNDER_APPROVAL,
  CALLBACK_IS_INVITED_CONTACT,
  NO_RECONTACT_EFFECTS,
  NO_RECONTACT_CODES,
};
