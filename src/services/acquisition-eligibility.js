// AIDA Locksmith Acquisition — the unified contact eligibility engine (A2).
//
//   createEligibilityEngine({ ... }).evaluate(prospect, context)
//
// Answers exactly one question:
//
//     Can this prospect legally and operationally enter the outbound call
//     queue right now?
//
// ── IT COMPOSES; IT DOES NOT REIMPLEMENT ────────────────────────────
// Every check delegates to the module that owns it. There is no second copy of
// suppression matching, DNCR freshness, timezone conversion or holiday
// lookup anywhere in this file — a parallel implementation would drift, and the
// copy that drifted would be the one that authorised a call.
//
//   record validity      acquisition-prospect.assessProspect (A1)
//   phone                acquisition-phone.normaliseProspectPhones
//   duplicates           acquisition-dedupe.duplicateStatusFor
//   DNCR + freshness     acquisition-dncr  (assess, recomputed at read time)
//   suppression          acquisition-suppression.check
//   attempts + washes    acquisition-attempt-policy.assess
//   tz / holiday / hours acquisition-calling-policy.evaluate
//   counsel approval     carried on the calling policy's decision
//   batch approval       supplied by the caller (acquisition-batch)
//
// ── PRECEDENCE IS EXPLICIT, AND PERMANENT BEATS TEMPORARY ───────────
// Checks are ordered, and the DECISIVE reason is the highest-precedence
// failure — never merely the first one noticed. This matters more than it
// looks: if a suppressed business were reported as "outside calling hours",
// the message reads as *try again tomorrow*, and tomorrow it would be called.
//
//   1  invalid or unsafe record
//   2  permanent suppression
//   3  DNCR / legal block
//   4  duplicate requiring resolution
//   5  campaign or founder block   (includes unapproved policy + batch)
//   6  attempt / wash restrictions
//   7  timezone / holiday / calling-window restrictions
//   8  eligible
//
// ALL computable checks are run, so a founder sees every problem at once rather
// than fixing them one refresh at a time. The decisive code comes from the
// precedence order; `failedChecks` carries the rest.
//
// ── DEFAULT-DENY ────────────────────────────────────────────────────
// Anything missing is a block: no wash store, no holiday calendar, no attempt
// policy approval, no batch approval, no timezone. Forgetting to wire a
// collaborator makes prospects ineligible; it never skips a check.
//
// Pure + dep-free. See test/acquisition-eligibility.test.js.

const { assessProspect } = require("./acquisition-prospect");
const { normaliseProspectPhones } = require("./acquisition-phone");
const { duplicateStatusFor } = require("./acquisition-dedupe");
const { createCallingPolicy } = require("./acquisition-calling-policy");
const { createAttemptPolicy } = require("./acquisition-attempt-policy");
const { isDurableHistory } = require("./acquisition-history");

// Ordered. The index IS the precedence.
const CHECK_ORDER = Object.freeze([
  "record_valid",
  "phone_usable",
  "suppression",
  "dncr",
  "duplicate",
  "campaign",
  "policy_approval",
  "batch_approval",
  "attempts",
  "calling_window",
]);

const ELIGIBILITY_CODES = Object.freeze({
  ELIGIBLE: "eligible",
  RECORD_INVALID: "record_invalid",
  RECORD_NOT_APPROVED: "record_not_reviewed",
  NO_USABLE_NUMBER: "no_usable_number",
  SUPPRESSED: "suppressed_permanently",
  DNCR_LISTED: "dncr_listed",
  DNCR_UNKNOWN: "dncr_not_checked",
  DNCR_STALE: "dncr_wash_stale",
  // M8K. "We could not read the wash ledger" is a THIRD state, kept apart from
  // "this number has never been checked". Both veto, so the call is refused
  // either way — but one is a fact about the number and the other is a fault in
  // this system, and a founder reading "never checked" would go and wash a
  // number that may already have been washed.
  DNCR_UNAVAILABLE: "dncr_store_unavailable",
  DUPLICATE_REVIEW: "duplicate_requires_resolution",
  DUPLICATE_OF_CANONICAL: "duplicate_of_canonical",
  CAMPAIGN_BLOCKED: "campaign_blocked",
  KILL_SWITCH: "kill_switch_engaged",
  POLICY_UNAPPROVED: "attempt_policy_unapproved",
  COUNSEL_UNAPPROVED: "counsel_approval_missing",
  BATCH_UNAPPROVED: "founder_batch_approval_missing",
  ATTEMPTS_BLOCKED: "attempt_or_wash_restriction",
  // M8J / E-1. Distinct from ATTEMPTS_BLOCKED on purpose: that says "we know,
  // and the answer is no". This says "we could not find out", which is a fact
  // about the system and must never be reported as a fact about the business.
  HISTORY_UNAVAILABLE: "contact_history_unavailable",
  WINDOW_BLOCKED: "outside_calling_policy",
});

function fail(check, code, message, { temporary = true, nextEligibleAt = null, requiredFounderAction = null, detail = null } = {}) {
  return Object.freeze({ check, ok: false, code, message, temporary, nextEligibleAt, requiredFounderAction, detail });
}
function pass(check, message, detail = null) {
  return Object.freeze({ check, ok: true, code: `${check}_ok`, message, temporary: false, nextEligibleAt: null, requiredFounderAction: null, detail });
}
function skip(check, message) {
  return Object.freeze({ check, ok: null, code: `${check}_skipped`, message, temporary: true, nextEligibleAt: null, requiredFounderAction: null, detail: null });
}

/**
 * Create the eligibility engine.
 *
 * @param {function} now
 * @param {object}   [washStore]      acquisition-dncr store
 * @param {object}   [suppression]    acquisition-suppression list
 * @param {object}   [holidays]       holiday provider (passed to calling policy)
 * @param {object}   [attemptPolicy]  defaults to the UNAPPROVED proposed policy
 * @param {object}   [callingPolicy]  built if not supplied
 * @param {boolean}  [counselApproved]
 * @param {string}   [policyVersion]
 */
function createEligibilityEngine({
  now,
  washStore = null,
  suppression = null,
  holidays = null,
  attemptPolicy = null,
  callingPolicy = null,
  counselApproved = false,
  policyVersion = "acq-a2-eligibility-v1",
  // M8J / E-1. A pre-loaded durable contact history index, and whether a
  // durable one is MANDATORY. The authoriser sets both; preview paths may run
  // without, and their decisions carry historySource so nothing reads a
  // missing history as "never called".
  historyIndex = null,
  historyRequired = false,
} = {}) {
  if (typeof now !== "function") {
    throw new Error("createEligibilityEngine requires an injected now().");
  }

  const attempts = attemptPolicy || createAttemptPolicy();

  // THE COMPOSITION BOUNDARY.
  //
  // The internal calling gate is built WITHOUT suppression, campaign or caps —
  // this engine owns those three, at their own precedence, using the same
  // services. Handing them to the gate as well would make it short-circuit on
  // suppression and return before it ever evaluated the window, which costs two
  // things that matter: `failedChecks` would hide the window problem a founder
  // still needs to fix, and `localTime` would come back null for every
  // suppressed prospect.
  //
  // The gate keeps those checks for STANDALONE callers — a future dispatch gate
  // asking "may I dial this, right now?" must check everything itself and must
  // not assume an eligibility engine ran first. Same module, two compositions.
  const window =
    callingPolicy ||
    createCallingPolicy({
      now,
      holidays,
      counselApproved,
      // Caps are deliberately empty: acquisition-attempt-policy owns them, and
      // two components applying the same cap would report it twice.
      caps: {},
    });

  /**
   * @param {object} prospect  an A1 prospect
   * @param {object} context
   * @param {Array}  [context.evidenceRows]
   * @param {object} [context.duplicateResolution]  from resolveDuplicates()
   * @param {object} [context.campaign]   { id, approved, killSwitchEngaged, blocked, blockReason }
   * @param {object} [context.history]    { attempts, lastAttemptAt, lastContactAt, lastOutcome }
   * @param {object} [context.batch]      { approved, batchHash, approvedBy, stale }
   * @param {Date}   [context.at]
   */
  function evaluate(prospect, context = {}) {
    const { evidenceRows = [], duplicateResolution = null, campaign = null, history = null, batch = null, at = null } = context;
    const instant = at instanceof Date && Number.isFinite(at.getTime()) ? at : now();

    const results = [];
    const add = (r) => {
      results.push(r);
      return r;
    };

    if (!prospect || typeof prospect !== "object") {
      return assemble({ prospect: null, results: [fail("record_valid", ELIGIBILITY_CODES.RECORD_INVALID, "There is no prospect record to assess.", { temporary: false })], instant, localTime: null, provenance: null });
    }

    // ── 1. Record validity ─────────────────────────────────────────
    const assessment = assessProspect(prospect, evidenceRows);
    if (assessment.gaps.length > 0) {
      add(
        fail("record_valid", ELIGIBILITY_CODES.RECORD_INVALID, `This record is not complete enough to call: ${assessment.gaps.map((g) => g.message).join(" ")}`, {
          temporary: false,
          requiredFounderAction: "Complete or reject this record.",
          detail: { gaps: assessment.gaps },
        })
      );
    } else if (prospect.lifecycle !== "review_approved") {
      add(
        fail("record_valid", ELIGIBILITY_CODES.RECORD_NOT_APPROVED, `A person has not yet accepted this record's identity and source — it is "${prospect.lifecycle}".`, {
          temporary: true,
          requiredFounderAction: "Review the prospect's source and context.",
        })
      );
    } else {
      add(pass("record_valid", "The record is complete and a person has accepted its identity and source."));
    }

    // ── 2. Phone ───────────────────────────────────────────────────
    const phones = normaliseProspectPhones(prospect);
    const canonical = phones.callable[0] || null;
    if (!canonical) {
      add(
        fail("phone_usable", ELIGIBILITY_CODES.NO_USABLE_NUMBER, phones.problems.length ? `There is no number we can call. ${phones.problems[0].message}` : "This record has no phone number at all.", {
          temporary: false,
          requiredFounderAction: "Find a callable number, or reject the record.",
          detail: { problems: phones.problems },
        })
      );
    } else {
      add(pass("phone_usable", `Calling ${canonical.e164} (${canonical.kindLabel.toLowerCase()}).`, { e164: canonical.e164, kind: canonical.kind }));
    }

    const fingerprint = prospect.prospectId ? assessmentFingerprint(prospect) : null;

    // ── 3. Suppression — permanent, outranks everything below ──────
    if (!suppression) {
      add(skip("suppression", "No suppression list is loaded, so nothing can be cleared for calling."));
      add(fail("suppression", ELIGIBILITY_CODES.SUPPRESSED, "No suppression list is loaded. Nothing may be called until one is, because we cannot tell who has asked us not to.", { temporary: false }));
    } else {
      const hit = suppression.check({ e164: canonical ? canonical.e164 : null, fingerprint });
      if (hit.suppressed) {
        add(
          fail("suppression", ELIGIBILITY_CODES.SUPPRESSED, `This business must never be called. ${hit.message}`, {
            temporary: false,
            detail: { reasons: hit.reasons, scope: hit.primary.scope },
          })
        );
      } else {
        add(pass("suppression", "This business is not on the suppression list."));
      }
    }

    // ── 4. DNCR ────────────────────────────────────────────────────
    if (!washStore) {
      add(fail("dncr", ELIGIBILITY_CODES.DNCR_UNKNOWN, "No Do Not Call Register check has been set up, so no number can be cleared for calling.", { temporary: true, requiredFounderAction: "Import a Do Not Call Register wash." }));
    } else if (!canonical) {
      add(skip("dncr", "There is no number to check against the Do Not Call Register."));
    } else {
      const wash = washStore.assess(canonical.e164, { at: instant });
      if (wash.result === "listed") {
        add(fail("dncr", ELIGIBILITY_CODES.DNCR_LISTED, `This number is on the Do Not Call Register, so it must not be called. ${wash.reason}`, { temporary: false, detail: { washedAt: wash.washedAt, mode: wash.mode } }));
      } else if (!wash.usable) {
        // Three reasons a wash is unusable, and they are not the same reason.
        const unavailable = wash.unavailable === true;
        const stale = !unavailable && wash.priorResult !== undefined;
        const code = unavailable ? ELIGIBILITY_CODES.DNCR_UNAVAILABLE : stale ? ELIGIBILITY_CODES.DNCR_STALE : ELIGIBILITY_CODES.DNCR_UNKNOWN;
        add(
          fail("dncr", code, wash.reason, {
            temporary: true,
            requiredFounderAction: unavailable
              ? "Restore access to the Do Not Call Register wash records. Nothing may be called until they can be read."
              : stale
                ? "Wash this number against the Do Not Call Register again."
                : "Wash this number against the Do Not Call Register.",
            detail: { washedAt: wash.washedAt, ageDays: wash.ageDays, mode: wash.mode, unavailable },
          })
        );
      } else {
        add(pass("dncr", wash.reason, { washedAt: wash.washedAt, ageDays: wash.ageDays, mode: wash.mode, authoritative: wash.authoritative }));
      }
    }

    // ── 5. Duplicates ──────────────────────────────────────────────
    const dup = duplicateStatusFor(prospect.prospectId, duplicateResolution);
    if (!duplicateResolution) {
      add(fail("duplicate", ELIGIBILITY_CODES.DUPLICATE_REVIEW, "Duplicates have not been resolved for this set of records, so we cannot tell whether calling this one would dial the same business twice.", { temporary: true, requiredFounderAction: "Run duplicate resolution." }));
    } else if (dup.blocked) {
      add(
        fail("duplicate", dup.code === "duplicate_of_canonical" ? ELIGIBILITY_CODES.DUPLICATE_OF_CANONICAL : ELIGIBILITY_CODES.DUPLICATE_REVIEW, dup.message, {
          temporary: true,
          requiredFounderAction: dup.requiresReview ? "Decide whether these records are the same business." : null,
          detail: dup,
        })
      );
    } else {
      add(pass("duplicate", "No duplicate of this record was found."));
    }

    // ── 6. Campaign ────────────────────────────────────────────────
    if (campaign && campaign.killSwitchEngaged === true) {
      add(fail("campaign", ELIGIBILITY_CODES.KILL_SWITCH, "Calling is stopped: the kill switch is engaged.", { temporary: true }));
    } else if (campaign && campaign.blocked === true) {
      add(fail("campaign", ELIGIBILITY_CODES.CAMPAIGN_BLOCKED, `This business is excluded from the campaign${campaign.blockReason ? `: ${campaign.blockReason}` : "."}`, { temporary: false }));
    } else if (campaign && campaign.approved === false) {
      add(fail("campaign", ELIGIBILITY_CODES.CAMPAIGN_BLOCKED, "This campaign has not been approved, so nothing in it may be called.", { temporary: true, requiredFounderAction: "Approve the campaign." }));
    } else {
      add(pass("campaign", campaign ? "The campaign permits this business." : "No campaign restrictions apply."));
    }

    // ── 7. Policy approval — counsel and attempt/wash ──────────────
    if (!counselApproved) {
      add(
        fail("policy_approval", ELIGIBILITY_CODES.COUNSEL_UNAPPROVED, "The permitted calling hours have not been signed off by a lawyer. Until they are, nothing may be called.", {
          temporary: true,
          requiredFounderAction: "Obtain Australian telecommunications counsel sign-off on the calling window (Phase 0).",
        })
      );
    } else if (!attempts.approved) {
      add(
        fail("policy_approval", ELIGIBILITY_CODES.POLICY_UNAPPROVED, attempts.describeGap(), {
          temporary: true,
          requiredFounderAction: "Decide and approve the attempt limits, retry spacing and cooldown periods.",
          detail: { unapprovedRules: attempts.unapprovedRules, unapprovedOutcomes: attempts.unapprovedOutcomes },
        })
      );
    } else {
      add(pass("policy_approval", `Calling hours are counsel-approved and attempt policy "${attempts.version}" was approved by ${attempts.approvedBy}.`));
    }

    // ── 8. Founder batch approval ──────────────────────────────────
    if (!batch || batch.approved !== true) {
      add(
        fail("batch_approval", ELIGIBILITY_CODES.BATCH_UNAPPROVED, "This prospect is not in a batch the founder has approved.", {
          temporary: true,
          requiredFounderAction: "Review and approve a calling batch containing this business.",
        })
      );
    } else if (batch.stale === true) {
      add(
        fail("batch_approval", ELIGIBILITY_CODES.BATCH_UNAPPROVED, "The approved batch is out of date — the records or their eligibility changed after it was approved, so the approval no longer covers what would be called.", {
          temporary: true,
          requiredFounderAction: "Re-review and re-approve the batch.",
        })
      );
    } else {
      add(pass("batch_approval", `Included in batch ${batch.batchHash ? batch.batchHash.slice(0, 12) : "(unnamed)"}, approved by ${batch.approvedBy || "unknown"}.`));
    }

    // ── 9. Attempts and washes ─────────────────────────────────────
    //
    // ── WHERE THE ATTEMPT HISTORY COMES FROM (M8J / E-1) ────────────
    // Three sources, in descending order of authority:
    //
    //   historyIndex   a durable index pre-loaded from
    //                  acquisition_contact_outcomes at the async boundary.
    //                  THE PRODUCTION SOURCE. The engine is synchronous by
    //                  design, so the read happens before it is called and the
    //                  answer is handed in — the same shape M8E used for the
    //                  durable suppression read.
    //   history        a durable history for this one prospect, handed in
    //                  directly. Equivalent authority; convenient for the
    //                  authoriser, which handles exactly one prospect.
    //   loose fields   { attempts, lastAttemptAt, ... } constructed by a
    //                  caller. Retained for the walkthrough, the dry runs and
    //                  unit tests. NOT a production path.
    //
    // `historyRequired` makes the third one a refusal rather than a fallback.
    // The authoriser sets it, so the final pre-dial decision cannot be reached
    // with a hand-made history or with none at all.
    const suppliedHistory = context.history || null;
    const indexedHistory = historyIndex && prospect.prospectId ? historyIndex.for(prospect.prospectId) : null;
    const durable = isDurableHistory(indexedHistory) ? indexedHistory : isDurableHistory(suppliedHistory) ? suppliedHistory : null;

    const historySource = durable ? (durable.available ? "durable" : "unavailable") : suppliedHistory ? "caller" : "absent";

    if (historyRequired && !durable) {
      // Neither a durable index nor a durable history reached a path that
      // demands one. Refused as the system's own failure — a caller-built
      // object is not evidence of what this business has already been through.
      add(
        fail("attempts", ELIGIBILITY_CODES.HISTORY_UNAVAILABLE, "No durable contact history was supplied, so we cannot tell how many times this business has already been called. Nothing is authorised on an unknown attempt history.", {
          temporary: true,
          requiredFounderAction: "Load the durable contact history before authorising a call.",
          detail: { historySource },
        })
      );
    } else {
      // A durable history, when present, is the ONLY source: assess() derives
      // attempts, last-attempt and last-contact from it and ignores anything
      // the caller also passed. See acquisition-attempt-policy.assess.
      const attemptInput = durable ? { history: durable } : history || {};
      const attemptResult = attempts.assess(attemptInput, { now: () => instant });
      if (!attemptResult.ok) {
        add(
          fail("attempts", attemptResult.code === "history_unavailable" ? ELIGIBILITY_CODES.HISTORY_UNAVAILABLE : ELIGIBILITY_CODES.ATTEMPTS_BLOCKED, attemptResult.message, {
            temporary: attemptResult.temporary,
            nextEligibleAt: attemptResult.readyAt ? attemptResult.readyAt.toISOString() : null,
            detail: { reason: attemptResult.code, historySource },
          })
        );
      } else {
        add(pass("attempts", attemptResult.message, { historySource }));
      }
    }

    // ── 10. Timezone, holidays, calling window ─────────────────────
    // Only timezone, holidays and hours reach the gate — see the composition
    // boundary above. Suppression, campaign and caps were settled earlier.
    const windowDecision = window.evaluate({
      timezone: prospect.timezone,
      at: instant,
    });

    const localTime = windowDecision.localTime;

    if (!windowDecision.allowed) {
      add(
        fail("calling_window", ELIGIBILITY_CODES.WINDOW_BLOCKED, windowDecision.message, {
          temporary: windowDecision.temporary,
          nextEligibleAt: windowDecision.nextPermittedAt,
          detail: { windowCode: windowDecision.code },
        })
      );
    } else {
      add(pass("calling_window", windowDecision.message, { window: windowDecision.window, nextPermittedAt: windowDecision.nextPermittedAt }));
    }

    return assemble({
      prospect,
      results,
      instant,
      localTime,
      canonical,
      windowDecision,
      provenance: {
        prospectId: prospect.prospectId,
        fingerprint,
        sourceRefs: prospect.sourceRefs,
        evidenceCount: evidenceRows.length,
        hasOfficialSource: assessment.sources.hasOfficialSource,
        officialSource: assessment.sources.officialSource ? assessment.sources.officialSource.label : null,
        discoveredAt: prospect.discoveredAt,
      },
      policyVersion,
      attemptPolicyVersion: attempts.version,
      counselApproved,
      historySource,
    });
  }

  function assemble({ prospect, results, instant, localTime, canonical = null, windowDecision = null, provenance, policyVersion: pv = policyVersion, attemptPolicyVersion = null, counselApproved: ca = counselApproved, historySource = "absent" }) {
    const failures = results.filter((r) => r.ok === false);
    const passed = results.filter((r) => r.ok === true).map((r) => r.check);

    // The decisive failure is the highest-precedence one, NOT the first found.
    const decisive =
      failures.length === 0
        ? null
        : [...failures].sort((x, y) => CHECK_ORDER.indexOf(x.check) - CHECK_ORDER.indexOf(y.check))[0];

    const eligible = failures.length === 0;

    // nextEligibleAt only means anything if EVERY block is temporary and each
    // one can say when it lifts. One permanent block ⇒ there is no such time.
    let nextEligibleAt = null;
    if (!eligible) {
      const anyPermanent = failures.some((f) => f.temporary === false);
      const times = failures.map((f) => f.nextEligibleAt).filter(Boolean);
      const allTimed = failures.every((f) => f.nextEligibleAt || f.temporary === false);
      if (!anyPermanent && times.length === failures.length && allTimed) {
        nextEligibleAt = times.sort()[times.length - 1]; // the last restriction to lift
      }
    } else if (windowDecision) {
      nextEligibleAt = windowDecision.nextPermittedAt;
    }

    return Object.freeze({
      eligible,
      code: eligible ? ELIGIBILITY_CODES.ELIGIBLE : decisive.code,
      message: eligible ? "This business can be called now." : decisive.message,
      temporary: eligible ? false : decisive.temporary,
      decisiveCheck: eligible ? null : decisive.check,

      failedChecks: Object.freeze(failures.map((f) => Object.freeze({ check: f.check, code: f.code, message: f.message, temporary: f.temporary, nextEligibleAt: f.nextEligibleAt, requiredFounderAction: f.requiredFounderAction, detail: f.detail }))),
      passedChecks: Object.freeze(passed),

      nextEligibleAt,
      requiredFounderAction: eligible ? null : Object.freeze([...new Set(failures.map((f) => f.requiredFounderAction).filter(Boolean))]),

      prospectId: prospect ? prospect.prospectId : null,
      businessName: prospect ? prospect.businessName : null,
      canonicalNumber: canonical ? canonical.e164 : null,

      policyVersion: pv,
      attemptPolicyVersion,
      counselApproved: ca,
      /** Where the attempt history came from: durable | caller | unavailable | absent. */
      historySource,
      evaluatedAt: instant.toISOString(),
      localTime,
      provenance: provenance ? Object.freeze(provenance) : null,
    });
  }

  return Object.freeze({ evaluate, checkOrder: CHECK_ORDER, codes: ELIGIBILITY_CODES });
}

/** The identity key suppression is recorded against. */
function assessmentFingerprint(prospect) {
  const { identityFingerprint } = require("./acquisition-prospect");
  return identityFingerprint({ businessName: prospect.businessName, suburb: prospect.suburb, state: prospect.state });
}

module.exports = {
  createEligibilityEngine,
  ELIGIBILITY_CODES,
  CHECK_ORDER,
  // Exported for the M8E authorisation gate, which has to look suppression up
  // by the SAME identity key this engine checks it against. A second derivation
  // of that key would be a second answer to "who is this business?", and the
  // one that drifted would be the one that authorised a call.
  assessmentFingerprint,
};
