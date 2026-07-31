// AIDA Locksmith Receptionist — canonical profile validation and the
// deterministic provisioning-readiness calculation (M2).
//
// Two jobs, deliberately separated:
//   validateProfile(profile)     — is this a well-formed profile? Structural
//                                  and enum correctness. Rejects unknown enum
//                                  values outright (an extraction adapter must
//                                  never widen the vocabulary by inventing one).
//   assessProvisioning(profile)  — is it SAFE to build a receptionist from
//                                  this? Every blocker is a specific missing or
//                                  unsafe fact, named in plain English so the
//                                  review page can print it.
//
// A profile can be valid and still not provisioning-ready: that is the normal
// state of a fresh draft. Readiness is deterministic — same profile in, same
// blockers out, no clock, no randomness, no I/O — so the review page, the
// approval guard and the tests all agree by construction.
//
// Normalisation note: this module normalises phone numbers to E.164 but never
// strips or escapes markup. Escaping happens at render time
// (src/views/escape.js); mangling input here would corrupt legitimate values
// like "Smith & Sons" and would give a false sense that stored data is safe.
//
// Pure + dep-free. See test/locksmith-profile.test.js.

const S = require("./locksmith-profile-schema");

const MAX_SHORT_TEXT = 200;
const MAX_LONG_TEXT = 2000;
const MAX_LIST_ITEMS = 100;

// ── Small helpers ───────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function text(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isBool(v) {
  return v === true || v === false;
}

/**
 * Normalise an Australian number to E.164, or return null when it is not a
 * number we could actually ring. Transfer targets are safety-critical: a number
 * we cannot dial is worse than no number, because it looks configured.
 */
function normaliseAuNumber(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return null;

  let national = cleaned;
  if (cleaned.startsWith("+61")) national = `0${cleaned.slice(3)}`;
  else if (cleaned.startsWith("61") && cleaned.length === 11) national = `0${cleaned.slice(2)}`;

  // Mobiles and landlines: the leading 0 is a trunk prefix and is dropped.
  if (/^0[2-478]\d{8}$/.test(national)) return `+61${national.slice(1)}`;
  // 1300/1800 service numbers: the leading 1 is PART OF THE NUMBER, not a trunk
  // prefix, so all ten digits are kept (+61 1300 XXX XXX). Dropping it produces
  // a number that looks plausible and rings nothing.
  if (/^1300\d{6}$/.test(national) || /^1800\d{6}$/.test(national)) return `+61${national}`;
  return null; // 13xxxx short numbers are deliberately not transfer targets
}

function isValidEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= MAX_SHORT_TEXT;
}

// "HH:MM", 24-hour. Times are always paired with an explicit timezone on the
// profile — a bare local time is how after-hours rules go wrong.
function isValidTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// ── Validation ──────────────────────────────────────────────────────

// Issues come in two kinds, and the difference decides who has to act:
//
//   "structure" — the data is MALFORMED. An unknown enum value, a wrong type,
//                 a time that isn't a time, wording that breaks a hard safety
//                 rule. A human cannot fix this by answering a question; it
//                 means whatever produced the profile is wrong. Extraction
//                 rejects its adapter's whole output on any of these.
//
//   "review"    — the data is INCOMPLETE or CONTRADICTORY. A missing greeting,
//                 no transfer number, a service listed as both accepted and
//                 declined. This is exactly what the review step exists to
//                 resolve, so extraction passes it through as a draft and the
//                 review page shows it. Approval still refuses it.
//
// Both are errors for approval purposes; only "structure" rejects an extraction.
function createIssues() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(section, field, message) {
      errors.push({ section, field, message, kind: "structure" });
    },
    review(section, field, message) {
      errors.push({ section, field, message, kind: "review" });
    },
    warn(section, field, message) {
      warnings.push({ section, field, message });
    },
  };
}

function checkEnum(issues, section, field, value, allowed, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    // Absent is a question for the locksmith, not a broken adapter.
    if (required) issues.review(section, field, `${field} is required.`);
    return null;
  }
  if (!allowed.includes(value)) {
    // Deliberately loud: an unknown enum is a rejected profile, never a
    // silently-dropped field.
    issues.error(section, field, `"${String(value).slice(0, 60)}" is not a recognised ${field} value.`);
    return null;
  }
  return value;
}

function validateIdentity(profile, issues) {
  const id = isPlainObject(profile.identity) ? profile.identity : {};
  if (!isPlainObject(profile.identity)) {
    issues.error("identity", "identity", "Business identity section is missing.");
  }
  for (const field of ["clientId", "legalName", "spokenName", "receptionistName", "greeting"]) {
    if (!text(id[field])) issues.review("identity", field, `${field} is required.`);
  }
  for (const field of ["legalName", "spokenName", "receptionistName", "website", "businessPhone"]) {
    if (text(id[field]).length > MAX_SHORT_TEXT) {
      issues.error("identity", field, `${field} must be ${MAX_SHORT_TEXT} characters or fewer.`);
    }
  }
  if (text(id.greeting).length > MAX_LONG_TEXT) issues.error("identity", "greeting", "Greeting is too long.");
  if (text(id.description).length > MAX_LONG_TEXT) issues.error("identity", "description", "Description is too long.");

  checkEnum(issues, "identity", "timezone", id.timezone, S.TIMEZONES, { required: true });
  const tone = checkEnum(issues, "identity", "tone", id.tone, S.TONES, { required: true });
  if (tone === "custom_reviewed" && !text(id.toneWording)) {
    issues.review("identity", "toneWording", "A custom tone needs the reviewed wording AIDA should use.");
  }
  if (id.businessPhone && !normaliseAuNumber(id.businessPhone)) {
    issues.error("identity", "businessPhone", "Business phone is not a valid Australian number.");
  }
}

function validateServicesAccepted(profile, issues) {
  const list = Array.isArray(profile.servicesAccepted) ? profile.servicesAccepted : [];
  if (!Array.isArray(profile.servicesAccepted)) {
    issues.error("servicesAccepted", "servicesAccepted", "Services accepted must be a list.");
    return;
  }
  if (list.length > MAX_LIST_ITEMS) issues.error("servicesAccepted", "servicesAccepted", "Too many services.");

  const seen = new Set();
  list.forEach((svc, i) => {
    if (!isPlainObject(svc)) {
      issues.error("servicesAccepted", `[${i}]`, "Each accepted service must be an object.");
      return;
    }
    const id = checkEnum(issues, "servicesAccepted", `[${i}].serviceId`, svc.serviceId, S.SERVICE_IDS, { required: true });
    if (id) {
      if (seen.has(id)) issues.error("servicesAccepted", `[${i}].serviceId`, `${id} is listed more than once.`);
      seen.add(id);
    }
    if (!isBool(svc.enabled)) issues.error("servicesAccepted", `[${i}].enabled`, "enabled must be true or false.");
    if (!isBool(svc.mayBeUrgent)) issues.error("servicesAccepted", `[${i}].mayBeUrgent`, "mayBeUrgent must be true or false.");
    if (svc.mustCollect !== undefined) {
      if (!Array.isArray(svc.mustCollect)) {
        issues.error("servicesAccepted", `[${i}].mustCollect`, "mustCollect must be a list.");
      } else {
        for (const f of svc.mustCollect) {
          checkEnum(issues, "servicesAccepted", `[${i}].mustCollect`, f, S.CALLER_INFO_FIELDS);
        }
      }
    }
    if (text(svc.notes).length > MAX_LONG_TEXT) issues.error("servicesAccepted", `[${i}].notes`, "Notes are too long.");
  });
}

function validateServicesDeclined(profile, issues) {
  const list = Array.isArray(profile.servicesDeclined) ? profile.servicesDeclined : [];
  if (!Array.isArray(profile.servicesDeclined)) {
    issues.error("servicesDeclined", "servicesDeclined", "Services declined must be a list.");
    return;
  }
  const accepted = new Set(
    (Array.isArray(profile.servicesAccepted) ? profile.servicesAccepted : [])
      .filter((s) => isPlainObject(s) && s.enabled)
      .map((s) => s.serviceId)
  );
  list.forEach((svc, i) => {
    if (!isPlainObject(svc)) {
      issues.error("servicesDeclined", `[${i}]`, "Each declined service must be an object.");
      return;
    }
    const id = checkEnum(issues, "servicesDeclined", `[${i}].serviceId`, svc.serviceId, S.SERVICE_IDS, { required: true });
    // A service cannot be both offered and refused — that is a contradiction
    // the locksmith has to resolve, not something to guess at.
    if (id && accepted.has(id)) {
      issues.review("servicesDeclined", `[${i}].serviceId`, `${S.SERVICE_LABELS[id]} is listed as both accepted and declined.`);
    }
  });
}

function validateServiceAreas(profile, issues) {
  const a = isPlainObject(profile.serviceAreas) ? profile.serviceAreas : {};
  if (!isPlainObject(profile.serviceAreas)) {
    issues.error("serviceAreas", "serviceAreas", "Service areas section is missing.");
    return;
  }
  for (const key of ["primary", "extended", "declined"]) {
    if (a[key] !== undefined && !Array.isArray(a[key])) {
      issues.error("serviceAreas", key, `${key} must be a list of suburbs or regions.`);
    } else if (Array.isArray(a[key])) {
      if (a[key].length > MAX_LIST_ITEMS) issues.error("serviceAreas", key, `Too many entries in ${key}.`);
      for (const entry of a[key]) {
        if (!text(entry)) issues.error("serviceAreas", key, `${key} contains an empty entry.`);
        else if (text(entry).length > MAX_SHORT_TEXT) issues.error("serviceAreas", key, `${key} entry is too long.`);
      }
    }
  }
  const declined = new Set((Array.isArray(a.declined) ? a.declined : []).map((x) => text(x).toLowerCase()));
  for (const area of Array.isArray(a.primary) ? a.primary : []) {
    if (declined.has(text(area).toLowerCase())) {
      issues.review("serviceAreas", "primary", `"${text(area)}" is listed as both covered and declined.`);
    }
  }
  if (a.radiusKm !== null && a.radiusKm !== undefined) {
    if (!Number.isFinite(a.radiusKm) || a.radiusKm <= 0 || a.radiusKm > 500) {
      issues.error("serviceAreas", "radiusKm", "Radius must be a positive number of kilometres (max 500).");
    }
  }
  // Routing-critical: what happens to an out-of-area caller must be an explicit
  // choice, never inferred from prose (Part 3.D).
  checkEnum(issues, "serviceAreas", "outsideAreaAction", a.outsideAreaAction, S.OUTSIDE_AREA_ACTIONS, { required: true });
  if (a.outsideAreaAction === "other_reviewed_action" && !text(a.outsideAreaWording)) {
    issues.review("serviceAreas", "outsideAreaWording", "A custom out-of-area action needs reviewed wording.");
  }
  if (a.afterHoursAreas !== null && a.afterHoursAreas !== undefined && !Array.isArray(a.afterHoursAreas)) {
    issues.error("serviceAreas", "afterHoursAreas", "After-hours areas must be a list, or null to match the primary areas.");
  }
}

function validateDayHours(issues, section, label, value) {
  if (!isPlainObject(value)) {
    issues.error(section, label, `${label} must be an object.`);
    return;
  }
  if (value.closed === true) return;
  if (!isValidTime(value.open) || !isValidTime(value.close)) {
    issues.error(section, label, `${label} needs an open and close time as HH:MM, or closed: true.`);
    return;
  }
  if (minutesOf(value.close) <= minutesOf(value.open)) {
    // Overnight trading is real, but it must be stated as after-hours
    // availability rather than a close time that precedes the open time.
    issues.review(section, label, `${label} closes at or before it opens — record overnight work as after-hours availability.`);
  }
}

function validateHours(profile, issues) {
  const h = isPlainObject(profile.hours) ? profile.hours : {};
  if (!isPlainObject(profile.hours)) {
    issues.error("hours", "hours", "Hours section is missing.");
    return;
  }
  checkEnum(issues, "hours", "timezone", h.timezone, S.TIMEZONES, { required: true });
  const identityTz = isPlainObject(profile.identity) ? profile.identity.timezone : null;
  if (h.timezone && identityTz && h.timezone !== identityTz) {
    issues.review("hours", "timezone", "Hours timezone does not match the business timezone.");
  }

  const ordinary = isPlainObject(h.ordinary) ? h.ordinary : {};
  if (!isPlainObject(h.ordinary)) issues.error("hours", "ordinary", "Ordinary hours must be given per day.");
  for (const day of Object.keys(ordinary)) {
    if (!S.DAYS.includes(day)) {
      issues.error("hours", "ordinary", `"${day}" is not a day of the week.`);
      continue;
    }
    validateDayHours(issues, "hours", day, ordinary[day]);
  }

  if (h.afterHoursAvailable !== null && h.afterHoursAvailable !== undefined && !isBool(h.afterHoursAvailable)) {
    issues.error("hours", "afterHoursAvailable", "After-hours availability must be true or false.");
  }
  if (h.publicHolidays !== null && h.publicHolidays !== undefined) {
    if (!isPlainObject(h.publicHolidays)) {
      issues.error("hours", "publicHolidays", "Public-holiday rule must be an object.");
    } else if (h.publicHolidays.byArrangement !== true) {
      validateDayHours(issues, "hours", "publicHolidays", h.publicHolidays);
    }
  }
  const byService = isPlainObject(h.byService) ? h.byService : {};
  for (const serviceId of Object.keys(byService)) {
    checkEnum(issues, "hours", "byService", serviceId, S.SERVICE_IDS);
    const perDay = isPlainObject(byService[serviceId]) ? byService[serviceId] : {};
    for (const day of Object.keys(perDay)) {
      if (!S.DAYS.includes(day)) {
        issues.error("hours", "byService", `"${day}" is not a day of the week.`);
        continue;
      }
      validateDayHours(issues, "hours", `${serviceId}/${day}`, perDay[day]);
    }
  }
}

function validateUrgencyRules(profile, issues) {
  const list = Array.isArray(profile.urgencyRules) ? profile.urgencyRules : [];
  if (!Array.isArray(profile.urgencyRules)) {
    issues.error("urgencyRules", "urgencyRules", "Urgency rules must be a list.");
    return;
  }
  const seen = new Set();
  list.forEach((rule, i) => {
    if (!isPlainObject(rule)) {
      issues.error("urgencyRules", `[${i}]`, "Each urgency rule must be an object.");
      return;
    }
    const id = text(rule.ruleId);
    if (!id) issues.review("urgencyRules", `[${i}].ruleId`, "Each rule needs an identifier.");
    else if (seen.has(id)) issues.error("urgencyRules", `[${i}].ruleId`, `Rule "${id}" is defined more than once.`);
    seen.add(id);

    if (!text(rule.condition)) issues.review("urgencyRules", `[${i}].condition`, "Each rule needs a condition.");
    checkEnum(issues, "urgencyRules", `[${i}].classification`, rule.classification, S.URGENCY_CLASSIFICATIONS, { required: true });
    checkEnum(issues, "urgencyRules", `[${i}].action`, rule.action, S.URGENCY_ACTIONS, { required: true });
    checkEnum(issues, "urgencyRules", `[${i}].notificationPriority`, rule.notificationPriority, S.NOTIFICATION_PRIORITIES, { required: true });
    if (!isBool(rule.transferEligible)) {
      issues.error("urgencyRules", `[${i}].transferEligible`, "transferEligible must be true or false.");
    }
    if (rule.action === "transfer_immediately" && rule.transferEligible !== true) {
      issues.review("urgencyRules", `[${i}]`, `Rule "${id}" transfers immediately but is not transfer-eligible.`);
    }
    if (text(rule.approvedWording).length > MAX_LONG_TEXT) {
      issues.error("urgencyRules", `[${i}].approvedWording`, "Approved wording is too long.");
    }
    // AIDA is not an emergency service and must never imply one is coming.
    if (/\b(ambulance|police|fire brigade|000|triple zero)\b/i.test(text(rule.approvedWording))) {
      issues.error(
        "urgencyRules",
        `[${i}].approvedWording`,
        "Approved wording must not reference emergency services — AIDA cannot promise their attendance."
      );
    }
  });
}

function validateTransfer(profile, issues) {
  const t = isPlainObject(profile.transfer) ? profile.transfer : {};
  if (!isPlainObject(profile.transfer)) {
    issues.error("transfer", "transfer", "Transfer section is missing.");
    return;
  }
  const primary = t.primaryNumber ? normaliseAuNumber(t.primaryNumber) : null;
  if (!t.primaryNumber) {
    issues.review("transfer", "primaryNumber", "A primary transfer number is required.");
  } else if (!primary) {
    issues.error("transfer", "primaryNumber", "Primary transfer number is not a valid Australian number.");
  }
  if (t.backupNumber) {
    const backup = normaliseAuNumber(t.backupNumber);
    if (!backup) issues.error("transfer", "backupNumber", "Backup transfer number is not a valid Australian number.");
    else if (backup === primary) issues.review("transfer", "backupNumber", "Backup number is the same as the primary number.");
  }
  if (t.permittedHours !== null && t.permittedHours !== undefined) {
    const p = t.permittedHours;
    if (!isPlainObject(p)) {
      issues.error("transfer", "permittedHours", "Permitted transfer hours must be an object.");
    } else if (p.always !== true && p.businessHoursOnly !== true) {
      if (!isValidTime(p.from) || !isValidTime(p.to)) {
        issues.error("transfer", "permittedHours", "Permitted transfer hours need from/to times as HH:MM.");
      }
    }
  }
  if (t.eligibleServices !== undefined) {
    if (!Array.isArray(t.eligibleServices)) {
      issues.error("transfer", "eligibleServices", "Eligible services must be a list.");
    } else {
      for (const s of t.eligibleServices) checkEnum(issues, "transfer", "eligibleServices", s, S.SERVICE_IDS);
    }
  }
  if (t.requiredUrgency) {
    checkEnum(issues, "transfer", "requiredUrgency", t.requiredUrgency, S.URGENCY_CLASSIFICATIONS);
  }
  if (t.timeoutSeconds !== null && t.timeoutSeconds !== undefined) {
    if (!Number.isInteger(t.timeoutSeconds) || t.timeoutSeconds < 10 || t.timeoutSeconds > 120) {
      issues.error("transfer", "timeoutSeconds", "Transfer timeout must be between 10 and 120 seconds.");
    }
  }
  if (t.maxAttempts !== null && t.maxAttempts !== undefined) {
    if (!Number.isInteger(t.maxAttempts) || t.maxAttempts < 1 || t.maxAttempts > 5) {
      issues.error("transfer", "maxAttempts", "Maximum transfer attempts must be between 1 and 5.");
    }
  }
  checkEnum(issues, "transfer", "unansweredAction", t.unansweredAction, S.UNANSWERED_TRANSFER_ACTIONS, { required: true });
  if (t.unansweredAction === "try_backup_number" && !t.backupNumber) {
    issues.review("transfer", "backupNumber", "The unanswered action is to try the backup number, but no backup number is set.");
  }
  if (t.collectDetailsFirst !== null && t.collectDetailsFirst !== undefined && !isBool(t.collectDetailsFirst)) {
    issues.error("transfer", "collectDetailsFirst", "collectDetailsFirst must be true or false.");
  }
  if (text(t.preTransferWording).length > MAX_LONG_TEXT) {
    issues.error("transfer", "preTransferWording", "Pre-transfer wording is too long.");
  }
}

function validateNotifications(profile, issues) {
  const n = isPlainObject(profile.notifications) ? profile.notifications : {};
  if (!isPlainObject(profile.notifications)) {
    issues.error("notifications", "notifications", "Notifications section is missing.");
    return;
  }
  for (const key of ["sms", "urgentOnly", "standardSummary", "backup"]) {
    const list = n[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.error("notifications", key, `${key} must be a list.`);
      continue;
    }
    for (const entry of list) {
      // SMS-capable lists hold phone numbers; the mixed lists accept either.
      if (key === "sms" && !normaliseAuNumber(entry)) {
        issues.error("notifications", key, "SMS recipients must be valid Australian numbers.");
      } else if (key !== "sms" && !normaliseAuNumber(entry) && !isValidEmail(entry)) {
        issues.error("notifications", key, `${key} entries must be a valid Australian number or email address.`);
      }
    }
  }
  if (n.email !== undefined) {
    if (!Array.isArray(n.email)) issues.error("notifications", "email", "Email recipients must be a list.");
    else for (const e of n.email) if (!isValidEmail(e)) issues.error("notifications", "email", `"${String(e).slice(0, 60)}" is not a valid email address.`);
  }
  if (n.timing) checkEnum(issues, "notifications", "timing", n.timing, S.NOTIFICATION_TIMINGS);
}

function validatePricing(profile, issues) {
  const p = isPlainObject(profile.pricing) ? profile.pricing : {};
  if (!isPlainObject(profile.pricing)) {
    issues.error("pricing", "pricing", "Pricing section is missing.");
    return;
  }
  // Pricing authority is never ambiguous: both switches must be explicit
  // booleans, because "unset" would let a receptionist improvise a quote.
  if (!isBool(p.mayMentionPricing)) {
    issues.review("pricing", "mayMentionPricing", "State explicitly whether AIDA may mention pricing.");
  }
  if (!isBool(p.humanConfirmsEveryPrice)) {
    issues.review("pricing", "humanConfirmsEveryPrice", "State explicitly whether a human confirms every price.");
  }
  if (p.mayMentionPricing === true) {
    if (!text(p.disclaimer)) {
      issues.review("pricing", "disclaimer", "If AIDA may mention pricing, a disclaimer is required.");
    }
    const prices = Array.isArray(p.indicativePrices) ? p.indicativePrices : [];
    if (p.indicativePrices !== undefined && !Array.isArray(p.indicativePrices)) {
      issues.error("pricing", "indicativePrices", "Indicative prices must be a list.");
    }
    prices.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        issues.error("pricing", `indicativePrices[${i}]`, "Each indicative price must be an object.");
        return;
      }
      checkEnum(issues, "pricing", `indicativePrices[${i}].serviceId`, entry.serviceId, S.SERVICE_IDS, { required: true });
      if (!text(entry.wording)) issues.review("pricing", `indicativePrices[${i}].wording`, "Approved wording is required.");
      // A price AIDA states as fixed is a promise the locksmith may not be able
      // to keep on a job sight-unseen.
      if (/\bfixed price|guaranteed price|no more than\b/i.test(text(entry.wording)) && p.humanConfirmsEveryPrice !== true) {
        issues.error(
          "pricing",
          `indicativePrices[${i}].wording`,
          "Wording promises a fixed price but a human is not confirming every price."
        );
      }
    });
  }
  if (p.neverState !== undefined && !Array.isArray(p.neverState)) {
    issues.error("pricing", "neverState", "Pricing that must never be stated should be a list.");
  }
}

function validateCallerInfo(profile, issues) {
  const c = isPlainObject(profile.callerInfo) ? profile.callerInfo : {};
  if (!isPlainObject(profile.callerInfo)) {
    issues.error("callerInfo", "callerInfo", "Caller-information section is missing.");
    return;
  }
  if (!Array.isArray(c.always)) {
    issues.error("callerInfo", "always", "Always-collected fields must be a list.");
  } else {
    for (const f of c.always) checkEnum(issues, "callerInfo", "always", f, S.CALLER_INFO_FIELDS);
  }
  const byService = isPlainObject(c.byService) ? c.byService : {};
  for (const serviceId of Object.keys(byService)) {
    checkEnum(issues, "callerInfo", "byService", serviceId, S.SERVICE_IDS);
    if (!Array.isArray(byService[serviceId])) {
      issues.error("callerInfo", "byService", `${serviceId} must map to a list of fields.`);
      continue;
    }
    for (const f of byService[serviceId]) checkEnum(issues, "callerInfo", "byService", f, S.CALLER_INFO_FIELDS);
  }
}

function validateForbiddenPromises(profile, issues) {
  const list = Array.isArray(profile.forbiddenPromises) ? profile.forbiddenPromises : [];
  if (!Array.isArray(profile.forbiddenPromises)) {
    issues.error("forbiddenPromises", "forbiddenPromises", "Forbidden promises must be a list.");
    return;
  }
  const enabled = new Set();
  list.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      issues.error("forbiddenPromises", `[${i}]`, "Each forbidden promise must be an object.");
      return;
    }
    const id = checkEnum(issues, "forbiddenPromises", `[${i}].promiseId`, entry.promiseId, S.FORBIDDEN_PROMISE_IDS, { required: true });
    if (!isBool(entry.enabled)) issues.error("forbiddenPromises", `[${i}].enabled`, "enabled must be true or false.");
    if (id && entry.enabled === true) enabled.add(id);
  });
  // The mandatory floor. Turning one of these off is not a configuration
  // choice a locksmith gets to make through onboarding.
  for (const required of S.MANDATORY_FORBIDDEN_PROMISES) {
    if (!enabled.has(required)) {
      issues.review("forbiddenPromises", required, `"${S.FORBIDDEN_PROMISE_LABELS[required]}" must be forbidden.`);
    }
  }
}

function validatePrivacy(profile, issues) {
  const p = isPlainObject(profile.privacy) ? profile.privacy : {};
  if (!isPlainObject(profile.privacy)) {
    issues.error("privacy", "privacy", "Privacy section is missing.");
    return;
  }
  if (p.callsMayBeRecorded !== null && p.callsMayBeRecorded !== undefined && !isBool(p.callsMayBeRecorded)) {
    issues.error("privacy", "callsMayBeRecorded", "Recording preference must be true or false.");
  }
  // We model the client's stated preference and flag the legal dependency; we
  // do NOT decide whether their disclosure is legally sufficient (spec §13).
  if (p.callsMayBeRecorded === true && !text(p.recordingDisclosure)) {
    issues.review("privacy", "recordingDisclosure", "Recording requires the disclosure wording callers will hear.");
  }
  if (p.transcriptRetention) checkEnum(issues, "privacy", "transcriptRetention", p.transcriptRetention, S.RETENTION_PREFERENCES);
  if (p.recordingRetention) checkEnum(issues, "privacy", "recordingRetention", p.recordingRetention, S.RETENTION_PREFERENCES);
  if (p.redactSensitiveData !== null && p.redactSensitiveData !== undefined && !isBool(p.redactSensitiveData)) {
    issues.error("privacy", "redactSensitiveData", "Redaction preference must be true or false.");
  }
}

function validateExtensions(profile, issues) {
  const ext = profile.extensions;
  if (ext === undefined || ext === null) return;
  if (!isPlainObject(ext)) {
    issues.error("extensions", "extensions", "Extensions must be an object.");
    return;
  }
  for (const key of Object.keys(ext)) {
    if (S.RESERVED_EXTENSION_KEYS.includes(key)) {
      issues.error("extensions", key, `"${key}" is a validated profile field and cannot live in extensions.`);
    }
  }
  if (JSON.stringify(ext).length > 4096) {
    issues.error("extensions", "extensions", "Extensions must stay small — move structured data into a real section.");
  }
}

/**
 * Full structural + enum validation. Returns { ok, errors, warnings } where
 * errors are keyed by section so the review page can show them in place.
 */
function validateProfile(profile) {
  const issues = createIssues();

  if (!isPlainObject(profile)) {
    issues.error("profile", "profile", "Profile must be an object.");
    return { ok: false, errors: issues.errors, warnings: issues.warnings };
  }
  if (profile.schemaVersion !== S.SCHEMA_VERSION) {
    issues.error("profile", "schemaVersion", `Unsupported schema version "${String(profile.schemaVersion).slice(0, 60)}".`);
  }

  validateIdentity(profile, issues);
  validateServicesAccepted(profile, issues);
  validateServicesDeclined(profile, issues);
  validateServiceAreas(profile, issues);
  validateHours(profile, issues);
  validateUrgencyRules(profile, issues);
  validateTransfer(profile, issues);
  validateNotifications(profile, issues);
  validatePricing(profile, issues);
  validateCallerInfo(profile, issues);
  validateForbiddenPromises(profile, issues);
  validatePrivacy(profile, issues);
  validateExtensions(profile, issues);

  return { ok: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings };
}

/**
 * Structure-only validation: is this profile WELL-FORMED, ignoring whether it
 * is finished? Used by the extraction gate, which must reject an adapter that
 * invents an enum value or returns the wrong type, but must NOT reject a draft
 * merely because the locksmith has not answered everything yet — an incomplete
 * draft is the normal output of a real interview and the reason review exists.
 *
 * Approval uses validateProfile() (both kinds) plus assessProvisioning().
 */
function validateProfileStructure(profile) {
  const full = validateProfile(profile);
  const structural = full.errors.filter((e) => e.kind === "structure");
  return { ok: structural.length === 0, errors: structural, warnings: full.warnings };
}

// ── Provisioning readiness ──────────────────────────────────────────

/**
 * Deterministic: is this profile safe to build a live receptionist from?
 *
 * Returns { ready, blockers[], warnings[] }. A blocker is a *specific* missing
 * or unsafe fact — never a generic "invalid". Anything safety-critical that is
 * missing blocks; a soft gap warns.
 *
 * Readiness deliberately does NOT consider approval status: that is the store's
 * job (an approved-but-unready profile must never provision, and a ready-but-
 * unapproved one must never provision either).
 */
function assessProvisioning(profile) {
  const blockers = [];
  const warnings = [];
  const add = (code, message) => blockers.push({ code, message });

  const validation = validateProfile(profile);
  if (!validation.ok) {
    for (const err of validation.errors) {
      add(`invalid_${err.section}`, `${err.section}: ${err.message}`);
    }
  }

  const p = isPlainObject(profile) ? profile : {};
  const accepted = (Array.isArray(p.servicesAccepted) ? p.servicesAccepted : []).filter(
    (s) => isPlainObject(s) && s.enabled === true
  );

  // 1. At least one service, or there is nothing to answer for.
  if (accepted.length === 0) add("no_services_accepted", "No service is accepted — AIDA would have nothing to book.");

  // 2. A reachable transfer target.
  const transfer = isPlainObject(p.transfer) ? p.transfer : {};
  if (!normaliseAuNumber(transfer.primaryNumber)) {
    add("transfer_number_invalid", "A valid Australian primary transfer number is required.");
  }
  if (transfer.unansweredAction === "try_backup_number" && !normaliseAuNumber(transfer.backupNumber)) {
    add("transfer_backup_missing", "The fallback is to try the backup number, but it is missing or invalid.");
  }

  // 3. Somewhere to send the work, and a rule for callers outside it.
  const areas = isPlainObject(p.serviceAreas) ? p.serviceAreas : {};
  if (!Array.isArray(areas.primary) || areas.primary.filter((x) => text(x)).length === 0) {
    add("no_service_area", "No primary service area is set.");
  }
  if (!S.OUTSIDE_AREA_ACTIONS.includes(areas.outsideAreaAction)) {
    add("no_outside_area_action", "There is no rule for callers outside the service area.");
  }

  // 4. Hours, with an explicit timezone.
  const hours = isPlainObject(p.hours) ? p.hours : {};
  const openDays = Object.keys(isPlainObject(hours.ordinary) ? hours.ordinary : {}).filter(
    (d) => S.DAYS.includes(d) && isPlainObject(hours.ordinary[d]) && hours.ordinary[d].closed !== true
  );
  if (!S.TIMEZONES.includes(hours.timezone)) add("no_timezone", "No business timezone is set — after-hours rules cannot be applied.");
  if (openDays.length === 0) add("no_open_hours", "No ordinary business hours are set.");

  // 5. Urgency: at least one rule, or every call looks the same.
  const rules = Array.isArray(p.urgencyRules) ? p.urgencyRules : [];
  if (rules.length === 0) add("no_urgency_rules", "No urgency rules are defined — urgent and routine calls would be treated alike.");

  // 6. Pricing authority stated unambiguously.
  const pricing = isPlainObject(p.pricing) ? p.pricing : {};
  if (!isBool(pricing.mayMentionPricing) || !isBool(pricing.humanConfirmsEveryPrice)) {
    add("pricing_authority_ambiguous", "Pricing permission is ambiguous — state whether AIDA may mention pricing and who confirms it.");
  }

  // 7. The forbidden-promise floor.
  const enabledPromises = new Set(
    (Array.isArray(p.forbiddenPromises) ? p.forbiddenPromises : [])
      .filter((x) => isPlainObject(x) && x.enabled === true)
      .map((x) => x.promiseId)
  );
  const missingPromises = S.MANDATORY_FORBIDDEN_PROMISES.filter((id) => !enabledPromises.has(id));
  if (missingPromises.length) {
    add("forbidden_promises_missing", `Safety limits missing: ${missingPromises.map((id) => S.FORBIDDEN_PROMISE_LABELS[id]).join(", ")}.`);
  }

  // 8. Caller information — without a callback number a lead is unusable.
  const callerInfo = isPlainObject(p.callerInfo) ? p.callerInfo : {};
  const always = Array.isArray(callerInfo.always) ? callerInfo.always : [];
  if (!always.includes("callback_number")) add("no_callback_number", "A callback number is not being collected on every call.");
  if (!always.includes("caller_name")) warnings.push({ code: "no_caller_name", message: "The caller's name is not collected on every call." });

  // ── Soft gaps: worth fixing, not worth blocking ──
  const identity = isPlainObject(p.identity) ? p.identity : {};
  if (!text(identity.description)) warnings.push({ code: "no_description", message: "No business description — AIDA will sound generic." });
  const notifications = isPlainObject(p.notifications) ? p.notifications : {};
  const anyRecipient = ["sms", "email", "urgentOnly", "standardSummary", "backup"].some(
    (k) => Array.isArray(notifications[k]) && notifications[k].length > 0
  );
  if (!anyRecipient) warnings.push({ code: "no_notification_recipients", message: "Nobody is set to receive call summaries." });
  const privacy = isPlainObject(p.privacy) ? p.privacy : {};
  if (privacy.callsMayBeRecorded === null || privacy.callsMayBeRecorded === undefined) {
    warnings.push({ code: "recording_preference_unset", message: "No recording preference recorded." });
  }
  if (!Array.isArray(p.servicesDeclined) || p.servicesDeclined.length === 0) {
    // Not a blocker, but worth surfacing: AIDA never infers that an unlisted
    // service is accepted, so an empty exclusion list is safe but uninformative.
    warnings.push({ code: "no_declined_services", message: "No services are explicitly declined. AIDA will not offer anything that is not accepted." });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

/**
 * The queryable safety columns mirrored out of the profile for the DB row.
 * These exist so routing- and safety-critical facts are indexable and
 * inspectable in SQL rather than buried in a jsonb body (Part 4).
 */
function toQueryableColumns(profile) {
  const p = isPlainObject(profile) ? profile : {};
  const identity = isPlainObject(p.identity) ? p.identity : {};
  const transfer = isPlainObject(p.transfer) ? p.transfer : {};
  const pricing = isPlainObject(p.pricing) ? p.pricing : {};
  const hours = isPlainObject(p.hours) ? p.hours : {};
  const accepted = (Array.isArray(p.servicesAccepted) ? p.servicesAccepted : []).filter((s) => isPlainObject(s) && s.enabled === true);
  const assessment = assessProvisioning(p);

  return {
    business_timezone: S.TIMEZONES.includes(identity.timezone) ? identity.timezone : null,
    spoken_business_name: text(identity.spokenName) || null,
    transfer_primary_number: normaliseAuNumber(transfer.primaryNumber),
    transfer_backup_number: normaliseAuNumber(transfer.backupNumber),
    accepted_service_count: accepted.length,
    after_hours_available: isBool(hours.afterHoursAvailable) ? hours.afterHoursAvailable : null,
    pricing_may_be_mentioned: isBool(pricing.mayMentionPricing) ? pricing.mayMentionPricing : null,
    pricing_human_confirms: isBool(pricing.humanConfirmsEveryPrice) ? pricing.humanConfirmsEveryPrice : null,
    provisioning_ready: assessment.ready,
    blocking_reasons: assessment.blockers,
  };
}

module.exports = {
  validateProfile,
  validateProfileStructure,
  assessProvisioning,
  toQueryableColumns,
  normaliseAuNumber,
  isValidEmail,
  isValidTime,
  MAX_SHORT_TEXT,
  MAX_LONG_TEXT,
};
