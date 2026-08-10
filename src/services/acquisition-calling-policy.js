// AIDA Locksmith Acquisition — the calling-policy gate (A2).
//
//   createCallingPolicy({ now, policy, holidays, suppression, caps })
//   gate.evaluate({ timezone, e164, fingerprint, campaign, history })
//
// The pipeline's ninth step is "calling-policy checks applied". This module
// answers ONE question — *may this business be called at this instant?* — and
// returns a structured decision, never a bare boolean.
//
// WHERE THIS MUST NOT LIVE
// Not in a route, not in a scheduler, not in a Retell or Twilio handler, not in
// a provider adapter. It is a pure domain service with an injected clock and
// injected collaborators, so that campaign selection, call dispatch, retry
// scheduling, founder review tooling and test simulations all ask the SAME
// evaluator and cannot drift into disagreeing about whether a call is lawful.
// A second implementation of this logic anywhere else is a bug.
//
// ── THE POLICY IS DERIVED, NOT INVENTED ────────────────────────────
// The permitted window comes from docs/OUTBOUND_BDM_ARCHITECTURE.md §2.2 and
// the G10 row in §5 — Mon–Fri 09:00–20:00, Sat 09:00–17:00, never Sundays or
// public holidays, in the RECIPIENT's local time — encoded once as
// CALLING_WINDOWS in src/config/acquisition.js. This module reads that; it does
// not restate it and it does not make one up.
//
//   ⚠ THAT POLICY IS FOUNDER-ADOPTED, NOT LAWYER-APPROVED (M8M). Until M8M
//   every decision carried `policy.counselApproved: false` and the eligibility
//   engine refused everything, because the window was documented and nobody had
//   signed it off. The founder has since ADOPTED it as AIDA's operating policy
//   rather than obtaining a legal opinion, so the decision now carries the whole
//   approval artifact — who adopted it, when, under what version, on what basis,
//   and `isLegalAdvice: false`.
//
//   That last field is the point. A reviewer reading a PERMITTED verdict needs
//   to see, on the verdict, that no lawyer reviewed this. See
//   acquisition-calling-approval.js, which cannot construct an approval that
//   claims otherwise.
//
// ── FAIL CLOSED, EVERYWHERE ────────────────────────────────────────
// Every uncertainty resolves to "do not call":
//   * no timezone            → refuse. Never fall back to server local time.
//   * unusable timezone      → refuse.
//   * no calling window      → refuse.
//   * holiday lookup unknown → refuse. A failed holiday lookup must never be
//                              read as "not a holiday".
//   * no holiday provider    → refuse, because the default provider is the null
//                              one, which knows nothing about every date.
// Forgetting to wire something up stops calls. It does not disable a check.
//
// ── PRECEDENCE ─────────────────────────────────────────────────────
// Permanent blocks are evaluated before temporary ones, so a suppressed
// business is reported as suppressed rather than as "outside calling hours" —
// which would imply, catastrophically, that calling later would be fine.
//
// Pure + dep-free (node's built-in Intl only). See test/acquisition-calling-policy.test.js.

const { CALLING_WINDOWS, DEFAULT_CAPS } = require("../config/acquisition");
const { createNullHolidayProvider, describeCoverage } = require("./acquisition-holidays");
const { createCallingPolicyApproval } = require("./acquisition-calling-approval");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKDAY_KEYS = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

// How far ahead nextPermittedAt will look before giving up. Bounded so the
// search always terminates; 30 days comfortably clears any run of holidays.
const LOOKAHEAD_DAYS = 30;

// Stable reason codes. Callers switch on these; the human-readable message is
// for people and may be reworded without breaking anything.
const POLICY_CODES = Object.freeze({
  PERMITTED: "permitted",
  SUPPRESSED: "suppressed_permanently",
  TIMEZONE_MISSING: "timezone_missing",
  TIMEZONE_INVALID: "timezone_invalid",
  POLICY_MISSING: "policy_missing",
  CAMPAIGN_BLOCKED: "campaign_blocked",
  KILL_SWITCH: "kill_switch_engaged",
  ATTEMPT_CAP: "attempt_cap_reached",
  TOO_SOON: "too_soon_since_last_attempt",
  RECENT_CONTACT: "recent_contact_cooldown",
  HOLIDAY_UNKNOWN: "holiday_coverage_unknown",
  PUBLIC_HOLIDAY: "public_holiday",
  PROHIBITED_DAY: "prohibited_day",
  BEFORE_HOURS: "before_permitted_hours",
  AFTER_HOURS: "after_permitted_hours",
});

// ── Timezone handling ───────────────────────────────────────────────
//
// All conversions go through Intl, which carries the IANA database and handles
// daylight saving correctly. No UTC offset is ever written down or arithmetic'd
// by hand — that is precisely how an off-by-one-hour bug becomes a call placed
// at 08:30 on the morning the clocks changed.

function isUsableTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock fields an instant maps to in a given zone.
 * hourCycle h23 avoids the "24:00" that some ICU builds emit for midnight.
 */
function localParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(instant);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekday = String(get("weekday")).slice(0, 3).toLowerCase();

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/** The zone's UTC offset, in ms, at a given instant — derived from Intl. */
function offsetAt(instant, timeZone) {
  const p = localParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which a given local wall-clock time occurs in a zone.
 *
 * Two-pass: guess using the offset at the naive instant, then correct using the
 * offset that actually applies at the guessed instant. The second pass is what
 * makes daylight-saving boundaries come out right — the offset before and after
 * a transition differ, and a single pass would use the wrong one for times near
 * it. The result is verified by round-tripping through localParts.
 */
function zonedTimeToInstant({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = new Date(naive - offsetAt(new Date(naive), timeZone));
  instant = new Date(naive - offsetAt(instant, timeZone));

  // Spring-forward gap: the requested wall-clock time does not exist that day.
  // The round trip lands after it, which is the correct conservative answer —
  // the first real instant at or after the window opens.
  const check = localParts(instant, timeZone);
  return { instant, exact: check.hour === hour && check.minute === minute, landedAt: check };
}

function parseHhMm(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]), minutesOfDay: Number(m[1]) * 60 + Number(m[2]) };
}

/** Advance a local calendar date by n days, without touching timezones. */
function addLocalDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function dateString({ year, month, day }) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function weekdayKeyFor(dateParts, timeZone) {
  // Midday avoids any chance of a DST shift moving the date across midnight.
  const probe = zonedTimeToInstant({ ...dateParts, hour: 12, minute: 0 }, timeZone).instant;
  return localParts(probe, timeZone).weekday;
}

// ── The gate ────────────────────────────────────────────────────────

/**
 * Create the calling-policy evaluator.
 *
 * @param {function} now           injected clock, () => Date. Required.
 * @param {object}   [policy]      weekday → { from, to }. Defaults to the
 *                                 repo-documented CALLING_WINDOWS.
 * @param {object}   [holidays]    a holiday provider. Defaults to the NULL
 *                                 provider, which knows nothing — so an
 *                                 un-wired gate refuses every date.
 * @param {object}   [suppression] the suppression list. Its matching logic is
 *                                 used, never reimplemented here.
 * @param {object}   [caps]        attempt/cooldown ceilings.
 * @param {object}   [callingPolicyApproval] the founder approval artifact from
 *                                 acquisition-calling-approval. Defaults to an
 *                                 UNAPPROVED one, so an un-wired gate reports
 *                                 the window as unadopted — see the header.
 */
function createCallingPolicy({
  now,
  policy = CALLING_WINDOWS,
  holidays = null,
  suppression = null,
  caps = DEFAULT_CAPS,
  callingPolicyApproval = null,
  policySource = "src/config/acquisition.js CALLING_WINDOWS, adopted by the founder calling policy (M8M)",
} = {}) {
  if (typeof now !== "function") {
    throw new Error("createCallingPolicy requires an injected now() — a policy that reads the wall clock cannot be tested against a fixed date.");
  }

  // No provider means the null provider, not "skip the holiday check".
  const holidayProvider = holidays || createNullHolidayProvider();

  // No approval means an UNAPPROVED one, not an approved default.
  const callingApproval = callingPolicyApproval || createCallingPolicyApproval();

  function decision(fields) {
    return Object.freeze({
      allowed: false,
      temporary: true,
      nextPermittedAt: null,
      ...fields,
      policy: Object.freeze({
        source: policySource,
        // The whole approval artifact, not a boolean. It carries who adopted the
        // policy, when, its version, its basis and isLegalAdvice: false (M8M).
        approval: callingApproval,
        approved: callingApproval.approved,
        version: callingApproval.version,
        isLegalAdvice: callingApproval.isLegalAdvice,
        windows: policy,
        holidayCalendar: holidayProvider.name,
        holidayCalendarAuthoritative: holidayProvider.authoritative === true,
        caps,
      }),
    });
  }

  /**
   * The first instant at or after `from` that falls inside a permitted window.
   * Returns null when it cannot be determined — an unknown holiday inside the
   * lookahead makes every later date unknowable too, so guessing past it would
   * be inventing an answer.
   */
  function findNextPermitted(fromInstant, timeZone) {
    const start = localParts(fromInstant, timeZone);
    let cursor = { year: start.year, month: start.month, day: start.day };

    for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
      const dayParts = offset === 0 ? cursor : addLocalDays(cursor, offset);
      const localDate = dateString(dayParts);
      const weekday = weekdayKeyFor(dayParts, timeZone);

      const window = policy && policy[weekday];
      if (!window) continue; // no window that weekday (Sunday)

      const holiday = holidayProvider.isHoliday(localDate);
      if (!holiday.known) return null; // cannot know; do not pretend to
      if (holiday.holiday) continue;

      const open = parseHhMm(window.from);
      const close = parseHhMm(window.to);
      if (!open || !close || close.minutesOfDay <= open.minutesOfDay) continue;

      const opensAt = zonedTimeToInstant({ ...dayParts, hour: open.hour, minute: open.minute }, timeZone).instant;
      const closesAt = zonedTimeToInstant({ ...dayParts, hour: close.hour, minute: close.minute }, timeZone).instant;

      if (fromInstant.getTime() < opensAt.getTime()) return opensAt;
      if (fromInstant.getTime() < closesAt.getTime()) return fromInstant; // already inside
    }
    return null;
  }

  /**
   * May this business be called right now?
   *
   * @param {object} input
   * @param {string} input.timezone     IANA identifier. Required; no fallback.
   * @param {string} [input.e164]       the number, for number-scoped suppression
   * @param {string} [input.fingerprint] the business identity, for business-scoped suppression
   * @param {object} [input.campaign]   { id, approved, killSwitchEngaged, blocked, blockReason }
   * @param {object} [input.history]    { attempts, lastAttemptAt, lastContactAt }
   * @param {Date}   [input.at]         evaluate at this instant instead of now()
   */
  function evaluate({ timezone, e164 = null, fingerprint = null, campaign = null, history = null, at = null } = {}) {
    const instant = at instanceof Date && Number.isFinite(at.getTime()) ? at : now();

    const inputs = Object.freeze({
      timezone: timezone || null,
      e164,
      fingerprint,
      campaignId: campaign && campaign.id ? campaign.id : null,
      attempts: history && Number.isFinite(history.attempts) ? history.attempts : 0,
      lastAttemptAt: history && history.lastAttemptAt ? history.lastAttemptAt : null,
      lastContactAt: history && history.lastContactAt ? history.lastContactAt : null,
      evaluatedAt: instant.toISOString(),
    });

    // ── 1. PERMANENT: suppression always wins ──────────────────────
    //
    // Checked first and reported as itself. If this came after the hours check,
    // a suppressed business contacted at 21:00 would be reported as "outside
    // calling hours", which reads as "try again tomorrow" — the worst possible
    // wrong answer, because tomorrow it would be called.
    if (suppression && (e164 || fingerprint)) {
      const hit = suppression.check({ e164, fingerprint });
      if (hit.suppressed) {
        return decision({
          allowed: false,
          temporary: false,
          code: POLICY_CODES.SUPPRESSED,
          message: `This business must never be called. ${hit.message}`,
          suppression: Object.freeze({ reasons: hit.reasons, primary: hit.primary.reason, scope: hit.primary.scope }),
          timezone: timezone || null,
          localTime: null,
          inputs,
        });
      }
    }

    // ── 2. PERMANENT-ISH: campaign-level blocks ────────────────────
    if (campaign) {
      if (campaign.killSwitchEngaged === true) {
        return decision({
          allowed: false,
          temporary: true,
          code: POLICY_CODES.KILL_SWITCH,
          message: "Calling is stopped: the kill switch is engaged. Nothing will be dialled until a person turns it off.",
          timezone: timezone || null,
          localTime: null,
          inputs,
        });
      }
      if (campaign.blocked === true) {
        return decision({
          allowed: false,
          temporary: false,
          code: POLICY_CODES.CAMPAIGN_BLOCKED,
          message: `This business is excluded from the campaign${campaign.blockReason ? `: ${campaign.blockReason}` : "."}`,
          timezone: timezone || null,
          localTime: null,
          inputs,
        });
      }
      if (campaign.approved === false) {
        return decision({
          allowed: false,
          temporary: true,
          code: POLICY_CODES.CAMPAIGN_BLOCKED,
          message: "This campaign has not been approved, so nothing in it may be called yet.",
          timezone: timezone || null,
          localTime: null,
          inputs,
        });
      }
    }

    // ── 3. Attempt caps ────────────────────────────────────────────
    const attempts = inputs.attempts;
    if (caps && Number.isFinite(caps.maxAttemptsPerProspect) && attempts >= caps.maxAttemptsPerProspect) {
      return decision({
        allowed: false,
        temporary: false,
        code: POLICY_CODES.ATTEMPT_CAP,
        message: `We have already tried this business ${attempts} time${attempts === 1 ? "" : "s"}. The limit is ${caps.maxAttemptsPerProspect}, so there will be no more attempts.`,
        timezone: timezone || null,
        localTime: null,
        inputs,
      });
    }

    // ── 4. Timezone. Required. NEVER fall back to server local time ─
    if (!timezone || typeof timezone !== "string" || !timezone.trim()) {
      return decision({
        allowed: false,
        temporary: false,
        code: POLICY_CODES.TIMEZONE_MISSING,
        message:
          "We do not know this business's timezone, so we cannot tell whether calling now is inside permitted hours. " +
          "Calling hours are checked in the business's own local time, so this is not something that can be assumed.",
        timezone: null,
        localTime: null,
        inputs,
      });
    }
    if (!isUsableTimeZone(timezone)) {
      return decision({
        allowed: false,
        temporary: false,
        code: POLICY_CODES.TIMEZONE_INVALID,
        message: `"${String(timezone).slice(0, 60)}" is not a timezone this system recognises, so permitted hours cannot be checked.`,
        timezone,
        localTime: null,
        inputs,
      });
    }

    const local = localParts(instant, timezone);
    const localTime = Object.freeze({
      iso: instant.toISOString(),
      date: local.date,
      time: local.time,
      weekday: local.weekday,
      minutesOfDay: local.minutesOfDay,
    });

    // ── 5. Cooldowns (need no timezone, but read better reported here) ─
    if (caps && Number.isFinite(caps.minDaysBetweenAttempts) && inputs.lastAttemptAt) {
      const since = instant.getTime() - Date.parse(inputs.lastAttemptAt);
      const days = since / MS_PER_DAY;
      if (Number.isFinite(days) && days < caps.minDaysBetweenAttempts) {
        const readyAt = new Date(Date.parse(inputs.lastAttemptAt) + caps.minDaysBetweenAttempts * MS_PER_DAY);
        const next = findNextPermitted(readyAt, timezone);
        return decision({
          allowed: false,
          temporary: true,
          code: POLICY_CODES.TOO_SOON,
          message: `We tried this business less than ${caps.minDaysBetweenAttempts} day${caps.minDaysBetweenAttempts === 1 ? "" : "s"} ago. Calling again this soon is harassment, not persistence.`,
          nextPermittedAt: next ? next.toISOString() : null,
          timezone,
          localTime,
          inputs,
        });
      }
    }

    if (caps && Number.isFinite(caps.recentContactCooldownDays) && inputs.lastContactAt) {
      const since = instant.getTime() - Date.parse(inputs.lastContactAt);
      const days = since / MS_PER_DAY;
      if (Number.isFinite(days) && days < caps.recentContactCooldownDays) {
        const readyAt = new Date(Date.parse(inputs.lastContactAt) + caps.recentContactCooldownDays * MS_PER_DAY);
        const next = findNextPermitted(readyAt, timezone);
        return decision({
          allowed: false,
          temporary: true,
          code: POLICY_CODES.RECENT_CONTACT,
          message: `We spoke to this business within the last ${caps.recentContactCooldownDays} days. They are left alone until that period is up.`,
          nextPermittedAt: next ? next.toISOString() : null,
          timezone,
          localTime,
          inputs,
        });
      }
    }

    // ── 6. Is there a window for this weekday at all? ──────────────
    const window = policy && policy[local.weekday];
    if (!policy || Object.keys(policy).length === 0) {
      return decision({
        allowed: false,
        temporary: false,
        code: POLICY_CODES.POLICY_MISSING,
        message: "No permitted calling hours are configured, so nothing may be called.",
        timezone,
        localTime,
        inputs,
      });
    }
    if (!window) {
      const next = findNextPermitted(instant, timezone);
      return decision({
        allowed: false,
        temporary: true,
        code: POLICY_CODES.PROHIBITED_DAY,
        message: `No calls are made on a ${fullWeekday(local.weekday)}. It is ${fullWeekday(local.weekday)} ${local.time} where this business is.`,
        nextPermittedAt: next ? next.toISOString() : null,
        timezone,
        localTime,
        inputs,
      });
    }

    // ── 7. Public holiday. An unknown answer REFUSES. ──────────────
    const holiday = holidayProvider.isHoliday(local.date);
    if (!holiday.known) {
      return decision({
        allowed: false,
        temporary: true,
        code: POLICY_CODES.HOLIDAY_UNKNOWN,
        message:
          `${holiday.reason || `We cannot tell whether ${local.date} is a public holiday.`} ` +
          "No call is made when that is unknown, because calling on a public holiday is a breach.",
        nextPermittedAt: null,
        timezone,
        localTime,
        holidayCoverage: describeCoverage(holidayProvider),
        inputs,
      });
    }
    if (holiday.holiday) {
      const next = findNextPermitted(instant, timezone);
      return decision({
        allowed: false,
        temporary: true,
        code: POLICY_CODES.PUBLIC_HOLIDAY,
        message: `${local.date} is ${holiday.name} where this business is, and no calls are made on public holidays.`,
        holiday: Object.freeze({ name: holiday.name, date: local.date }),
        nextPermittedAt: next ? next.toISOString() : null,
        timezone,
        localTime,
        inputs,
      });
    }

    // ── 8. Inside the window? ──────────────────────────────────────
    const open = parseHhMm(window.from);
    const close = parseHhMm(window.to);
    if (!open || !close || close.minutesOfDay <= open.minutesOfDay) {
      return decision({
        allowed: false,
        temporary: false,
        code: POLICY_CODES.POLICY_MISSING,
        message: `The permitted calling window for ${fullWeekday(local.weekday)} is not a usable time range, so nothing may be called.`,
        timezone,
        localTime,
        inputs,
      });
    }

    if (local.minutesOfDay < open.minutesOfDay) {
      const next = findNextPermitted(instant, timezone);
      return decision({
        allowed: false,
        temporary: true,
        code: POLICY_CODES.BEFORE_HOURS,
        message: `It is ${local.time} where this business is. Calling starts at ${window.from} on a ${fullWeekday(local.weekday)}.`,
        window: Object.freeze({ ...window, weekday: local.weekday }),
        nextPermittedAt: next ? next.toISOString() : null,
        timezone,
        localTime,
        inputs,
      });
    }

    if (local.minutesOfDay >= close.minutesOfDay) {
      const next = findNextPermitted(instant, timezone);
      return decision({
        allowed: false,
        temporary: true,
        code: POLICY_CODES.AFTER_HOURS,
        message: `It is ${local.time} where this business is. Calling stops at ${window.to} on a ${fullWeekday(local.weekday)}.`,
        window: Object.freeze({ ...window, weekday: local.weekday }),
        nextPermittedAt: next ? next.toISOString() : null,
        timezone,
        localTime,
        inputs,
      });
    }

    // ── Permitted ──────────────────────────────────────────────────
    return decision({
      allowed: true,
      temporary: false,
      code: POLICY_CODES.PERMITTED,
      message: `It is ${local.time} on a ${fullWeekday(local.weekday)} where this business is, inside the permitted window of ${window.from}–${window.to}.`,
      window: Object.freeze({ ...window, weekday: local.weekday }),
      // Present even when permitted: "now" is the answer to "when may we call?".
      nextPermittedAt: instant.toISOString(),
      timezone,
      localTime,
      inputs,
    });
  }

  return Object.freeze({ evaluate, findNextPermitted, codes: POLICY_CODES });
}

const WEEKDAY_NAMES = Object.freeze({
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
  thu: "Thursday", fri: "Friday", sat: "Saturday",
});
function fullWeekday(key) {
  return WEEKDAY_NAMES[key] || key;
}

module.exports = {
  createCallingPolicy,
  POLICY_CODES,
  // exported for tests and reuse; all pure
  localParts,
  zonedTimeToInstant,
  isUsableTimeZone,
  WEEKDAY_KEYS,
  LOOKAHEAD_DAYS,
};
