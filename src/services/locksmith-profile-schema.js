// AIDA Locksmith Receptionist — the canonical business profile schema (M2).
//
// THE SOURCE OF TRUTH for how a locksmith receptionist is configured. Retell,
// Twilio, the review UI, future pricing enforcement and future provisioning are
// all *consumers* of this shape — none of them defines it. Nothing in this file
// mentions a vendor, and nothing here may ever be shaped to suit one: when a
// provisioning adapter needs a different form, the adapter translates.
//
// The twelve sections (A-L in docs/LOCKSMITH_ONBOARDING_SPEC.md §3) are declared
// as data, not code, so the validator, the review renderer, the extraction
// adapter and the tests all iterate the same declaration. Adding a field means
// editing SECTIONS once.
//
// Enum values are closed sets. An unrecognised value is rejected outright
// rather than passed through — an LLM extraction adapter inventing
// "sometimes_urgent" must fail loudly, not quietly configure a receptionist.
//
// Pure + dep-free.

const SCHEMA_VERSION = "locksmith-profile-2026-08-01";

// ── Closed enums ────────────────────────────────────────────────────

const TONES = Object.freeze([
  "straightforward_efficient",
  "warm_reassuring",
  "professional",
  "friendly_australian_trade",
  "custom_reviewed",
]);

// Australia only — this is an Australian product and a wrong timezone silently
// breaks every after-hours rule.
const TIMEZONES = Object.freeze([
  "Australia/Melbourne",
  "Australia/Sydney",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Perth",
  "Australia/Hobart",
  "Australia/Darwin",
]);

const SERVICE_IDS = Object.freeze([
  "residential_lockout",
  "automotive_lockout",
  "lost_car_keys",
  "car_key_replacement",
  "rekeying",
  "lock_installation",
  "broken_key_extraction",
  "safe_opening",
  "commercial_locksmith",
  "access_control",
  "break_in_security",
  "key_cutting",
  "other_reviewed_service",
]);

const SERVICE_LABELS = Object.freeze({
  residential_lockout: "Residential lockouts",
  automotive_lockout: "Automotive lockouts",
  lost_car_keys: "Lost car keys",
  car_key_replacement: "Car-key replacement",
  rekeying: "Rekeying",
  lock_installation: "Lock installation",
  broken_key_extraction: "Broken-key extraction",
  safe_opening: "Safe opening",
  commercial_locksmith: "Commercial locksmith work",
  access_control: "Access control",
  break_in_security: "Break-in or property-security work",
  key_cutting: "Key cutting",
  other_reviewed_service: "Other reviewed service",
});

const OUTSIDE_AREA_ACTIONS = Object.freeze([
  "collect_details_for_confirmation",
  "politely_decline",
  "transfer_for_manual_assessment",
  "other_reviewed_action",
]);

const URGENCY_CLASSIFICATIONS = Object.freeze(["urgent", "priority", "standard", "non_urgent"]);

const URGENCY_ACTIONS = Object.freeze([
  "transfer_immediately",
  "notify_urgently_and_collect",
  "collect_and_notify",
  "collect_for_business_hours",
  "decline_politely",
]);

const NOTIFICATION_PRIORITIES = Object.freeze(["immediate", "high", "normal", "digest"]);

const UNANSWERED_TRANSFER_ACTIONS = Object.freeze([
  "try_backup_number",
  "take_message_and_notify",
  "take_message_only",
]);

const NOTIFICATION_TIMINGS = Object.freeze(["immediate", "end_of_call", "hourly_digest", "daily_digest"]);

const RETENTION_PREFERENCES = Object.freeze([
  "keep_indefinitely_until_changed",
  "keep_12_months",
  "keep_6_months",
  "keep_3_months",
  "delete_after_summary",
]);

const DAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

// Caller-information fields AIDA may be told to collect. Closed set: a field
// AIDA doesn't know how to ask for is a field it will not collect.
const CALLER_INFO_FIELDS = Object.freeze([
  "caller_name",
  "callback_number",
  "suburb",
  "street_address",
  "property_type",
  "problem_description",
  "property_secure",
  "desired_timing",
  "vehicle_make",
  "vehicle_model",
  "vehicle_year",
  "proof_of_ownership_reminder",
  "other_reviewed_question",
]);

const CALLER_INFO_LABELS = Object.freeze({
  caller_name: "Name",
  callback_number: "Callback number",
  suburb: "Suburb",
  street_address: "Street address",
  property_type: "Residential, commercial or automotive",
  problem_description: "Problem description",
  property_secure: "Whether the property is secure",
  desired_timing: "Desired timing",
  vehicle_make: "Vehicle make",
  vehicle_model: "Vehicle model",
  vehicle_year: "Vehicle year",
  proof_of_ownership_reminder: "Proof-of-ownership reminder",
  other_reviewed_question: "Other reviewed question",
});

// Section K. These are things AIDA must never say. The list is a floor, not a
// menu: MANDATORY_FORBIDDEN_PROMISES must all be present on every approved
// profile, because each one is a claim that could put a caller in danger, expose
// the locksmith to liability, or amount to unlicensed advice.
const FORBIDDEN_PROMISE_IDS = Object.freeze([
  "guaranteed_technician_availability",
  "guaranteed_arrival_time",
  "fixed_price_without_approval",
  "claim_already_dispatched",
  "claim_licensing_or_identity_verified",
  "advise_illegal_entry",
  "promise_emergency_service_attendance",
  "legal_or_insurance_advice",
]);

const FORBIDDEN_PROMISE_LABELS = Object.freeze({
  guaranteed_technician_availability: "Guaranteeing a technician is available",
  guaranteed_arrival_time: "Guaranteeing an arrival time",
  fixed_price_without_approval: "Quoting a fixed price that has not been approved",
  claim_already_dispatched: "Claiming a locksmith has already been dispatched",
  claim_licensing_or_identity_verified: "Claiming licensing or identity checks have happened",
  advise_illegal_entry: "Advising how to force entry",
  promise_emergency_service_attendance: "Promising police, fire or ambulance attendance",
  legal_or_insurance_advice: "Giving legal or insurance advice",
});

// Every one of these must be present and enabled on an approved profile.
const MANDATORY_FORBIDDEN_PROMISES = FORBIDDEN_PROMISE_IDS;

// ── Section declaration ─────────────────────────────────────────────
// `key`      — the profile object key and the DB jsonb column
// `blocking` — a section whose failure blocks provisioning readiness
// `confirm`  — requires an explicit reviewer confirmation before approval
//              (Part 4.8: transfer numbers, hours, exclusions, pricing
//              authority and forbidden promises are individually confirmed)
const SECTIONS = Object.freeze([
  { key: "identity", letter: "A", title: "Business identity and greeting", blocking: true, confirm: true },
  { key: "servicesAccepted", letter: "B", title: "Services accepted", blocking: true, confirm: true },
  { key: "servicesDeclined", letter: "C", title: "Services declined", blocking: false, confirm: true },
  { key: "serviceAreas", letter: "D", title: "Service areas", blocking: true, confirm: true },
  { key: "hours", letter: "E", title: "Hours and after-hours rules", blocking: true, confirm: true },
  { key: "urgencyRules", letter: "F", title: "Urgent-call rules", blocking: true, confirm: true },
  { key: "transfer", letter: "G", title: "Transfers and fallback", blocking: true, confirm: true },
  { key: "notifications", letter: "H", title: "Notifications", blocking: false, confirm: true },
  { key: "pricing", letter: "I", title: "Pricing boundaries", blocking: true, confirm: true },
  { key: "callerInfo", letter: "J", title: "Caller information", blocking: true, confirm: true },
  { key: "forbiddenPromises", letter: "K", title: "Forbidden promises", blocking: true, confirm: true },
  { key: "privacy", letter: "L", title: "Privacy and recording", blocking: false, confirm: true },
]);

const SECTION_KEYS = Object.freeze(SECTIONS.map((s) => s.key));
const BLOCKING_SECTION_KEYS = Object.freeze(SECTIONS.filter((s) => s.blocking).map((s) => s.key));
// Sections a reviewer must tick individually before approval is allowed.
const CONFIRMATION_KEYS = Object.freeze(SECTIONS.filter((s) => s.confirm).map((s) => s.key));

// An empty profile of the right shape — the starting point for extraction and
// the fallback when a section is absent. Frozen at every level so no caller can
// accidentally mutate the template into a shared-state bug.
function emptyProfile() {
  return {
    schemaVersion: SCHEMA_VERSION,
    identity: {
      clientId: null,
      legalName: null,
      spokenName: null,
      receptionistName: null,
      greeting: null,
      timezone: null,
      website: null,
      businessPhone: null,
      description: null,
      tone: null,
      toneWording: null,
    },
    servicesAccepted: [], // { serviceId, publicName, enabled, availability, notes, mayBeUrgent, mustCollect[] }
    servicesDeclined: [], // { serviceId, reason }
    serviceAreas: {
      primary: [],
      extended: [],
      declined: [],
      radiusKm: null,
      afterHoursAreas: null, // null = same as primary
      outsideAreaAction: null,
      outsideAreaWording: null,
    },
    hours: {
      timezone: null,
      ordinary: {}, // day -> { open: "08:00", close: "17:00" } | { closed: true }
      afterHoursAvailable: null,
      afterHoursNote: null,
      publicHolidays: null, // { closed: true } | { open: "09:00", close: "13:00" } | { byArrangement: true }
      temporaryClosure: null, // reserved for future dynamic availability
      byService: {}, // serviceId -> same shape as `ordinary`
    },
    urgencyRules: [], // { ruleId, condition, classification, action, transferEligible, notificationPriority, approvedWording }
    transfer: {
      primaryNumber: null,
      backupNumber: null,
      permittedHours: null, // { always: true } | { from: "07:00", to: "22:00" } | { businessHoursOnly: true }
      eligibleServices: [],
      requiredUrgency: null,
      timeoutSeconds: null,
      preTransferWording: null,
      unansweredAction: null,
      maxAttempts: null,
      collectDetailsFirst: null,
    },
    notifications: {
      sms: [],
      email: [],
      urgentOnly: [],
      standardSummary: [],
      backup: [],
      timing: null,
      contentPreferences: null,
    },
    pricing: {
      mayMentionPricing: null,
      calloutWording: null,
      indicativePrices: [], // { serviceId, wording }
      afterHoursSurchargeWording: null,
      disclaimer: null,
      neverState: [],
      humanConfirmsEveryPrice: null,
    },
    callerInfo: {
      always: [], // CALLER_INFO_FIELDS
      byService: {}, // serviceId -> CALLER_INFO_FIELDS[]
      otherQuestions: [],
    },
    forbiddenPromises: [], // { promiseId, enabled, note }
    privacy: {
      callsMayBeRecorded: null,
      recordingDisclosure: null,
      transcriptRetention: null,
      recordingRetention: null,
      redactSensitiveData: null,
      customerContactConsentWording: null,
      privacyPolicyReference: null,
    },
    // Small, deliberately-scoped extension bag for non-critical additions
    // (Part 4: "a small structured JSON component is acceptable for flexible,
    // non-critical extensions"). Nothing routing-, safety- or approval-related
    // may live here — validation rejects reserved keys.
    extensions: {},
  };
}

// Keys that may never appear in `extensions` — they would be an end-run around
// the validated, queryable fields above.
const RESERVED_EXTENSION_KEYS = Object.freeze([
  ...SECTION_KEYS,
  "schemaVersion",
  "transferNumber",
  "primaryNumber",
  "approved",
  "status",
  "provisioningReady",
]);

module.exports = {
  SCHEMA_VERSION,
  TONES,
  TIMEZONES,
  SERVICE_IDS,
  SERVICE_LABELS,
  OUTSIDE_AREA_ACTIONS,
  URGENCY_CLASSIFICATIONS,
  URGENCY_ACTIONS,
  NOTIFICATION_PRIORITIES,
  UNANSWERED_TRANSFER_ACTIONS,
  NOTIFICATION_TIMINGS,
  RETENTION_PREFERENCES,
  DAYS,
  CALLER_INFO_FIELDS,
  CALLER_INFO_LABELS,
  FORBIDDEN_PROMISE_IDS,
  FORBIDDEN_PROMISE_LABELS,
  MANDATORY_FORBIDDEN_PROMISES,
  SECTIONS,
  SECTION_KEYS,
  BLOCKING_SECTION_KEYS,
  CONFIRMATION_KEYS,
  RESERVED_EXTENSION_KEYS,
  emptyProfile,
};
