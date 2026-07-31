// AIDA Locksmith Receptionist — the deterministic extraction adapter (M2).
//
// Converts the demonstration interview transcript into a canonical draft
// profile using nothing but pattern matching. NO MODEL IS CALLED. Same input,
// same output, every time — which is what makes the whole M2 workflow testable
// without a call, a key or a network.
//
// This is not a general-purpose transcript parser and does not pretend to be.
// It recognises the phrases the demonstration interview contains, and where a
// transcript does not contain a phrase it recognises, it leaves the field null
// so the missing-field detector can report it. That behaviour — silence
// produces a gap, never a guess — is exactly what a future LLM adapter must
// also do, so the fixture doubles as the reference implementation of the
// contract.
//
// The seam: register another adapter under a different name and the domain
// model, validation, versioning, review UI and approval guard are unchanged.
//
// Pure + dep-free.

const S = require("./locksmith-profile-schema");
const { registerExtractionAdapter } = require("./locksmith-extraction");
const { normaliseAuNumber } = require("./locksmith-profile");

const ADAPTER_NAME = "fixture-v1";

// Spoken digits → figures. Australians read phone numbers aloud one digit at a
// time, which is exactly how they arrive in a transcript.
const SPOKEN_DIGITS = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/**
 * Pull a phone number out of a spoken read-back line. Only read-back lines are
 * used as the source, because that is the line the owner explicitly confirmed —
 * the same discipline a real adapter must follow.
 */
function spokenNumberFrom(line) {
  const words = line.toLowerCase().match(/[a-z]+/g) || [];
  const digits = words.map((w) => SPOKEN_DIGITS[w]).filter(Boolean).join("");
  if (digits.length < 9) return null;
  return normaliseAuNumber(digits.slice(0, 10));
}

function findLine(lines, pattern) {
  return lines.find((l) => pattern.test(l)) || null;
}

function ownerReplyAfter(lines, pattern) {
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx === -1) return null;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^Owner:/i.test(lines[i])) return lines[i].replace(/^Owner:\s*/i, "").trim();
    if (/^AIDA:/i.test(lines[i])) return null; // AIDA moved on; the question went unanswered
  }
  return null;
}

function acceptedService(serviceId, { notes = null, mayBeUrgent = false, mustCollect = [] } = {}) {
  return {
    serviceId,
    publicName: S.SERVICE_LABELS[serviceId],
    enabled: true,
    availability: null,
    notes,
    mayBeUrgent,
    mustCollect,
  };
}

/**
 * The adapter. Signature is the registry contract:
 *   ({ transcript, existingProfile, schemaVersion }) => profile
 *
 * `existingProfile` is honoured as a base so a re-extraction over an existing
 * draft preserves anything the transcript does not mention — it never deletes a
 * value a human already corrected.
 */
function fixtureAdapter({ transcript, existingProfile = null }) {
  const base = existingProfile ? JSON.parse(JSON.stringify(existingProfile)) : S.emptyProfile();
  base.schemaVersion = S.SCHEMA_VERSION;

  const lines = String(transcript).split("\n").map((l) => l.trim()).filter(Boolean);
  const text = lines.join("\n");
  const has = (re) => re.test(text);

  // ── A. Identity ──
  const spoken = ownerReplyAfter(lines, /what's the business called/i);
  if (spoken) base.identity.spokenName = spoken.replace(/\.$/, "");
  const legal = ownerReplyAfter(lines, /name on your invoices/i);
  if (legal && /pty ltd/i.test(legal)) {
    // Strip the conversational lead-in ("It's ...", "Well it's ...") before the
    // company name, or the filler ends up in the legal name.
    const cleaned = legal.replace(/^(well,?\s*)?(it'?s|its)\s+/i, "");
    const match = cleaned.match(/([A-Z][A-Za-z'&. ]*?Pty Ltd)/);
    if (match) base.identity.legalName = match[1].trim();
  }
  if (!base.identity.legalName && base.identity.spokenName) base.identity.legalName = base.identity.spokenName;

  const receptionist = ownerReplyAfter(lines, /what should i call myself/i);
  if (receptionist) {
    const named = receptionist.match(/call yourself ([A-Z][a-z]+)/i) || receptionist.match(/\b([A-Z][a-z]+)\.?$/);
    if (named) base.identity.receptionistName = named[1];
  }
  const greetingReply = ownerReplyAfter(lines, /how would you like me to greet/i);
  if (greetingReply) {
    const quoted = greetingReply.match(/"([^"]+)"/);
    base.identity.greeting = quoted ? quoted[1] : greetingReply.replace(/^something like\s*/i, "").replace(/^"|"$/g, "");
  }
  const stateReply = ownerReplyAfter(lines, /which state are you based in/i);
  if (stateReply) {
    if (/victoria|melbourne/i.test(stateReply)) base.identity.timezone = "Australia/Melbourne";
    else if (/new south wales|sydney/i.test(stateReply)) base.identity.timezone = "Australia/Sydney";
    else if (/queensland|brisbane/i.test(stateReply)) base.identity.timezone = "Australia/Brisbane";
    else if (/south australia|adelaide/i.test(stateReply)) base.identity.timezone = "Australia/Adelaide";
    else if (/western australia|perth/i.test(stateReply)) base.identity.timezone = "Australia/Perth";
    else if (/tasmania|hobart/i.test(stateReply)) base.identity.timezone = "Australia/Hobart";
    else if (/northern territory|darwin/i.test(stateReply)) base.identity.timezone = "Australia/Darwin";
  }
  const description = ownerReplyAfter(lines, /how would you describe the business/i);
  if (description) base.identity.description = description;

  // ── Tone ──
  if (has(/friendly Australian trade tone|trade business, not a bank/i)) base.identity.tone = "friendly_australian_trade";
  else if (has(/warm and reassuring/i) && !has(/bit of both/i)) base.identity.tone = "warm_reassuring";
  else if (has(/straightforward/i)) base.identity.tone = "straightforward_efficient";

  // ── B. Services accepted ──
  const accepted = [];
  if (has(/residential lockouts.*\n.*Owner:\s*Yep|most of what we do at night/i)) {
    accepted.push(acceptedService("residential_lockout", { mayBeUrgent: true, mustCollect: ["caller_name", "callback_number", "suburb", "street_address", "property_secure"] }));
  }
  if (has(/we do a fair bit of commercial/i)) {
    accepted.push(acceptedService("commercial_locksmith", { mayBeUrgent: true, mustCollect: ["caller_name", "callback_number", "street_address", "problem_description"] }));
  }
  if (has(/Rekeying yes/i)) accepted.push(acceptedService("rekeying"));
  if (has(/lock installs yes/i)) accepted.push(acceptedService("lock_installation"));
  if (has(/broken keys yes/i)) accepted.push(acceptedService("broken_key_extraction"));
  if (has(/electric strikes, but not the full card system/i)) {
    accepted.push(acceptedService("access_control", { notes: "Basic hardware only (e.g. electric strikes). Not full card-access systems." }));
  }
  if (has(/that's a priority job for us/i)) {
    accepted.push(acceptedService("break_in_security", { mayBeUrgent: true, mustCollect: ["caller_name", "callback_number", "street_address", "property_secure"] }));
  }
  if (has(/Key cutting, but only at the shop/i)) {
    accepted.push(acceptedService("key_cutting", { notes: "In-shop during business hours only — never a call-out." }));
  }
  if (accepted.length) base.servicesAccepted = accepted;

  // ── C. Services declined ──
  const declined = [];
  if (has(/We don't touch cars at all/i)) {
    declined.push({ serviceId: "automotive_lockout", reason: "No automotive work — no transponder equipment." });
    declined.push({ serviceId: "lost_car_keys", reason: "No automotive work — no transponder equipment." });
    declined.push({ serviceId: "car_key_replacement", reason: "No automotive work — no transponder equipment." });
  }
  if (has(/Safes no/i)) declined.push({ serviceId: "safe_opening", reason: "Specialist work the business does not take." });
  if (declined.length) base.servicesDeclined = declined;

  // ── D. Service areas ──
  const areaReply = ownerReplyAfter(lines, /which suburbs do you cover/i);
  if (areaReply) {
    base.serviceAreas.primary = areaReply
      .replace(/\.\s*That's the core\.?$/i, "")
      .split(/,\s*/)
      .map((s) => s.trim().replace(/\.$/, ""))
      .filter(Boolean);
  }
  const extendedReply = ownerReplyAfter(lines, /anywhere you'll stretch to/i);
  if (extendedReply) {
    const names = extendedReply.match(/\b(Epping|Bundoora|[A-Z][a-z]+)\b/g) || [];
    base.serviceAreas.extended = names.filter((n) => !/Not|Commercial|If/i.test(n));
  }
  const declinedAreaReply = ownerReplyAfter(lines, /anywhere you definitely won't go/i);
  if (declinedAreaReply) {
    const names = declinedAreaReply.match(/\b(Frankston|Geelong)\b/g) || [];
    base.serviceAreas.declined = [...names, "Anywhere past the city"];
  }
  if (has(/at night just the core suburbs/i) && base.serviceAreas.primary.length) {
    base.serviceAreas.afterHoursAreas = [...base.serviceAreas.primary];
  }
  if (has(/Take their details\. Sometimes I'll do it if it's quiet/i)) {
    base.serviceAreas.outsideAreaAction = "collect_details_for_confirmation";
  }

  // ── E. Hours ──
  base.hours.timezone = base.identity.timezone;
  const weekday = ownerReplyAfter(lines, /normal hours, Monday to Friday/i);
  if (weekday && /eight to five/i.test(weekday)) {
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday"]) {
      base.hours.ordinary[day] = { open: "08:00", close: "17:00" };
    }
  }
  const saturday = ownerReplyAfter(lines, /^AIDA: Saturdays\?/i);
  if (saturday && /eight till one/i.test(saturday)) base.hours.ordinary.saturday = { open: "08:00", close: "13:00" };
  const sunday = ownerReplyAfter(lines, /^AIDA: Sundays\?/i);
  if (sunday && /closed/i.test(sunday)) base.hours.ordinary.sunday = { closed: true };
  const holidays = ownerReplyAfter(lines, /public holidays/i);
  if (holidays && /by arrangement|emergencies only/i.test(holidays)) base.hours.publicHolidays = { byArrangement: true };
  if (has(/that's half the business/i)) {
    base.hours.afterHoursAvailable = true;
    base.hours.afterHoursNote = "All night for lockouts and break-ins only.";
  }

  // ── F. Urgency rules ──
  const rules = [];
  if (has(/Especially if they're outside in the cold/i)) {
    rules.push({
      ruleId: "after_hours_lockout",
      condition: "Caller is locked out of a residence after hours",
      classification: "urgent",
      action: "transfer_immediately",
      transferEligible: true,
      notificationPriority: "immediate",
      approvedWording: "I'll put you through to the locksmith now — stay on the line.",
    });
  }
  if (has(/Straight through to me, any hour\. That's the top priority/i)) {
    rules.push({
      ruleId: "vulnerable_person",
      condition: "A child, elderly or unwell person is involved",
      classification: "urgent",
      action: "transfer_immediately",
      transferEligible: true,
      notificationPriority: "immediate",
      approvedWording: "I'm putting you straight through now.",
    });
  }
  if (has(/broken into and can't secure the house/i)) {
    rules.push({
      ruleId: "break_in_unsecured",
      condition: "Property has been broken into and cannot be secured",
      classification: "urgent",
      action: "transfer_immediately",
      transferEligible: true,
      notificationPriority: "immediate",
      approvedWording: "I'll get you through to the locksmith now.",
    });
  }
  if (has(/usually early morning rather than the middle of the night/i)) {
    rules.push({
      ruleId: "commercial_cannot_open",
      condition: "Commercial premises cannot open",
      classification: "priority",
      action: "notify_urgently_and_collect",
      transferEligible: true,
      notificationPriority: "high",
      approvedWording: "I'll take the details and get the locksmith onto this straight away.",
    });
  }
  if (has(/Those can wait\. Don't ring me for those/i)) {
    rules.push({
      ruleId: "quote_or_key_cut",
      condition: "Quote request, future lock replacement, or key duplication",
      classification: "non_urgent",
      action: "collect_for_business_hours",
      transferEligible: false,
      notificationPriority: "digest",
      approvedWording: "I'll take your details and the locksmith will come back to you during business hours.",
    });
  }
  if (rules.length) base.urgencyRules = rules;

  // ── G. Transfer ──
  // Only the READ-BACK lines are used as the source of a phone number: that is
  // the line the owner explicitly confirmed. A number heard once and never
  // confirmed is exactly the kind of thing speech-to-text gets wrong.
  const primaryReadBack = findLine(lines, /^AIDA: Let me read that back/i);
  if (primaryReadBack) base.transfer.primaryNumber = spokenNumberFrom(primaryReadBack);
  const backupReadBack = findLine(lines, /^AIDA: Reading the backup back/i);
  if (backupReadBack) base.transfer.backupNumber = spokenNumberFrom(backupReadBack);
  if (has(/Any time\. If it's genuinely urgent I want it/i)) base.transfer.permittedHours = { always: true };
  if (has(/Get their name, number and suburb first/i)) base.transfer.collectDetailsFirst = true;
  if (has(/Give it two goes/i)) base.transfer.maxAttempts = 2;
  // The fallback chain is derived from what was actually captured: only claim
  // "try the backup" when a backup number was confirmed, otherwise the profile
  // would reference a number that does not exist.
  if (has(/Take a message and text me straight away/i)) {
    base.transfer.unansweredAction = base.transfer.backupNumber ? "try_backup_number" : "take_message_and_notify";
  }
  base.transfer.timeoutSeconds = 30;
  base.transfer.requiredUrgency = "urgent";
  base.transfer.preTransferWording = "I'm putting you through to the locksmith now — one moment.";
  base.transfer.eligibleServices = base.servicesAccepted.filter((s) => s.mayBeUrgent).map((s) => s.serviceId);

  // ── H. Notifications ──
  if (has(/Text me on the main number, and email a copy to the office/i)) {
    base.notifications.timing = "immediate";
    base.notifications.contentPreferences = "Short summary: caller, suburb, job type, urgency.";
    if (base.transfer.primaryNumber) base.notifications.sms = [base.transfer.primaryNumber];
  }
  const emailReply = ownerReplyAfter(lines, /what's the office email/i);
  if (emailReply) {
    // Spoken email addresses arrive as words: "office at example dot com".
    // The trailing full stop of the sentence must go, or it becomes part of
    // the domain and the address silently fails validation.
    const spelled = emailReply
      .replace(/[.\s]+$/, "")
      .replace(/\s+at\s+/i, "@")
      .replace(/\s+dot\s+/gi, ".")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(spelled)) base.notifications.email = [spelled];
  }

  // ── I. Pricing ──
  if (has(/Keep it between us\. I'm not having a computer quote a job it hasn't seen/i)) {
    base.pricing.mayMentionPricing = false;
    base.pricing.humanConfirmsEveryPrice = true;
    base.pricing.neverState = ["Any figure, range or estimate", "That the business is the cheapest option"];
    base.pricing.disclaimer = "The locksmith confirms all pricing directly.";
  }

  // ── J. Caller information ──
  const alwaysCollect = [];
  if (has(/Name, number, suburb, and what's actually happened/i)) {
    alwaysCollect.push("caller_name", "callback_number", "suburb", "problem_description");
  }
  if (has(/Whether the house is secure matters too/i)) alwaysCollect.push("property_secure");
  if (has(/get the address before you put them through/i)) alwaysCollect.push("street_address");
  if (has(/Saves an argument on the doorstep/i)) alwaysCollect.push("proof_of_ownership_reminder");
  if (alwaysCollect.length) base.callerInfo.always = [...new Set(alwaysCollect)];

  // ── K. Forbidden promises ──
  // The mandatory floor is always applied: it is not derived from the
  // transcript, because it is not the owner's to switch off. Extra items the
  // owner adds are appended as notes on the closest existing restriction.
  base.forbiddenPromises = S.MANDATORY_FORBIDDEN_PROMISES.map((promiseId) => ({
    promiseId,
    enabled: true,
    note: null,
  }));
  if (has(/Don't tell them we're the cheapest/i)) {
    const target = base.forbiddenPromises.find((p) => p.promiseId === "fixed_price_without_approval");
    if (target) target.note = "Owner added: never claim the business is the cheapest option.";
  }
  if (has(/Definitely don't promise a time/i)) {
    const target = base.forbiddenPromises.find((p) => p.promiseId === "guaranteed_arrival_time");
    if (target) target.note = "Owner emphasised this one explicitly during onboarding.";
  }

  // ── L. Privacy ──
  if (has(/Just transcribed is fine/i)) {
    base.privacy.callsMayBeRecorded = false;
    base.privacy.recordingDisclosure = null;
  }
  if (has(/Twelve months, then get rid of them/i)) base.privacy.transcriptRetention = "keep_12_months";
  if (has(/Yeah, do that\./i) && has(/card numbers taken out automatically/i)) base.privacy.redactSensitiveData = true;
  base.privacy.privacyPolicyReference = null; // pending the published policy — see spec §11

  return base;
}

registerExtractionAdapter(ADAPTER_NAME, fixtureAdapter);

module.exports = { ADAPTER_NAME, fixtureAdapter, spokenNumberFrom };
