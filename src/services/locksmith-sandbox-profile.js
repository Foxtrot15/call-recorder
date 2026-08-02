// AIDA — the founder-test sandbox locksmith profile (M7I-B).
//
// ─── WHAT THIS IS ───────────────────────────────────────────────────
// One realistic, complete, FICTIONAL locksmith profile that compiles through
// the production receptionist compiler. It replaces the "Harbour Locksmith
// Demo" content that the contract-validation agent carried, so a founder-only
// live call exercises a receptionist shaped like a real one.
//
// It is DEVELOPMENT ONLY and deliberately says so out loud. The business does
// not exist, the numbers are from the ACMA fictitious range 0491 570 006–156
// which can never reach a person, and the compiled agent has NO TOOLS — see
// the capability note below.
//
// ─── WHY THE SERVICE AREAS LOOK LIKE THIS ───────────────────────────
// The first live call refused Springvale because the knowledge base named only
// "Frankston and surrounding suburbs", and the model read a positive scope as a
// closed list. So this profile deliberately exercises all THREE states:
//
//   Frankston      — in `primary`   → covered, say yes
//   Dandenong      — in `declined`  → excluded, say no politely
//   Springvale     — in NEITHER     → UNKNOWN, take details and let the
//                                     locksmith confirm. Not a refusal.
//
// `outsideAreaAction: "collect_details_for_confirmation"` is an existing schema
// value; no schema change was needed for any of this.
//
// ─── WHAT THE AGENT CANNOT DO ───────────────────────────────────────
// The compiled tools (create_locksmith_enquiry, check_service_area, transfer,
// notify…) point at endpoints that do not exist yet, so this profile is
// compiled in TOOL-FREE mode. The agent therefore cannot save an enquiry, look
// a suburb up, notify anyone or transfer a call — and the compiled prompt says
// so rather than pretending otherwise. Claiming "I've sent that through" when
// nothing was sent is the failure mode this guards against.
//
// Pure + dep-free.

const SANDBOX_PROFILE_VERSION = "locksmith-sandbox-profile-2026-08-03";

/** The fictional client this profile belongs to. */
const SANDBOX_CLIENT_ID = "sandbox-fixture-locksmith";

// ACMA fictitious range only.
const TRANSFER_PRIMARY = "+61491570006";
const TRANSFER_BACKUP = "+61491570007";

/**
 * Build the profile. A function rather than a frozen constant so each caller
 * gets its own copy — the approval path mutates status fields, and a shared
 * object would let one test's approval leak into another's.
 */
function buildSandboxProfile() {
  return {
    schemaVersion: "locksmith-profile-2026-08-01",

    identity: {
      clientId: SANDBOX_CLIENT_ID,
      legalName: "AIDA Locksmith Sandbox",
      spokenName: "AIDA Locksmith Sandbox",
      receptionistName: "Aida",
      // No time-of-day claim: a fixed "Good afternoon" is wrong for most of the
      // day, and the first live call greeted an evening caller that way.
      greeting: "Thanks for calling AIDA Locksmith Sandbox, this is Aida.",
      timezone: "Australia/Melbourne",
      website: null,
      businessPhone: null,
      description: "A development sandbox used to test AIDA's locksmith receptionist. It is not a real business and does not attend jobs.",
      tone: "professional",
      toneWording: null,
    },

    servicesAccepted: [
      {
        serviceId: "residential_lockout",
        publicName: "Residential lockouts",
        enabled: true,
        availability: null,
        notes: null,
        mayBeUrgent: true,
        mustCollect: ["caller_name", "callback_number", "suburb", "street_address", "property_secure"],
      },
      {
        serviceId: "rekeying",
        publicName: "Rekeying and lock changes",
        enabled: true,
        availability: null,
        notes: null,
        mayBeUrgent: false,
        mustCollect: ["caller_name", "callback_number", "suburb", "problem_description"],
      },
      {
        serviceId: "break_in_security",
        publicName: "Securing a property after a break-in",
        enabled: true,
        availability: null,
        notes: null,
        mayBeUrgent: true,
        mustCollect: ["caller_name", "callback_number", "suburb", "street_address", "property_secure"],
      },
      {
        serviceId: "commercial_locksmith",
        publicName: "Commercial locksmithing",
        enabled: true,
        availability: null,
        notes: null,
        mayBeUrgent: true,
        mustCollect: ["caller_name", "callback_number", "suburb", "problem_description"],
      },
    ],

    // Automotive stays declined AND is the one fact kept only in the knowledge
    // base, so live retrieval remains testable on a phone call.
    servicesDeclined: [
      { serviceId: "automotive_lockout", reason: "No automotive work — no transponder equipment." },
      { serviceId: "car_key_replacement", reason: "No automotive key cutting or programming." },
      { serviceId: "lost_car_keys", reason: "No automotive work." },
      { serviceId: "safe_opening", reason: "Referred to a specialist." },
    ],

    serviceAreas: {
      // COVERED.
      primary: ["Frankston", "Frankston South", "Seaford", "Carrum Downs", "Langwarrin"],
      // COVERED, but further out.
      extended: ["Mornington", "Mount Eliza"],
      // EXPLICITLY EXCLUDED — the checklist's "declined suburb" case.
      declined: ["Dandenong", "Geelong"],
      radiusKm: null,
      afterHoursAreas: ["Frankston", "Frankston South", "Seaford"],
      // Anything in none of the lists above is UNKNOWN, and this is what to do
      // about it. Existing schema value; nothing was added for this milestone.
      outsideAreaAction: "collect_details_for_confirmation",
      outsideAreaWording: "I can take your details and have the locksmith confirm whether they can get to you.",
    },

    hours: {
      timezone: "Australia/Melbourne",
      ordinary: {
        monday: { open: "08:00", close: "17:00" },
        tuesday: { open: "08:00", close: "17:00" },
        wednesday: { open: "08:00", close: "17:00" },
        thursday: { open: "08:00", close: "17:00" },
        friday: { open: "08:00", close: "17:00" },
        saturday: { open: "09:00", close: "13:00" },
        sunday: { closed: true },
      },
      afterHoursAvailable: true,
      afterHoursNote: "After hours is lockouts and break-ins only, in the core area.",
      publicHolidays: { byArrangement: true },
      temporaryClosure: null,
      byService: {},
    },

    urgencyRules: [
      {
        ruleId: "after_hours_lockout",
        condition: "Caller is locked out of a home after hours",
        classification: "urgent",
        action: "transfer_immediately",
        transferEligible: true,
        notificationPriority: "immediate",
        approvedWording: "That one is urgent — let me get you to the locksmith.",
      },
      {
        ruleId: "break_in_property_open",
        condition: "A break-in has happened and the property cannot be secured",
        classification: "urgent",
        action: "transfer_immediately",
        transferEligible: true,
        notificationPriority: "immediate",
        approvedWording: "That needs someone now — let me get you to the locksmith.",
      },
      {
        ruleId: "locked_out_with_child_or_pet",
        condition: "Someone vulnerable, a child or an animal is shut inside",
        classification: "urgent",
        action: "transfer_immediately",
        transferEligible: true,
        notificationPriority: "immediate",
        approvedWording: "Let me get you straight to the locksmith.",
      },
      {
        ruleId: "business_hours_lockout",
        condition: "Caller is locked out during business hours and is safe",
        classification: "priority",
        action: "notify_urgently_and_collect",
        transferEligible: false,
        notificationPriority: "immediate",
        approvedWording: null,
      },
      {
        ruleId: "rekeying_enquiry",
        condition: "Caller wants rekeying, a lock change or a quote",
        classification: "standard",
        action: "collect_and_notify",
        transferEligible: false,
        notificationPriority: "normal",
        approvedWording: null,
      },
    ],

    transfer: {
      primaryNumber: TRANSFER_PRIMARY,
      backupNumber: TRANSFER_BACKUP,
      permittedHours: { always: true },
      eligibleServices: ["residential_lockout", "break_in_security", "commercial_locksmith"],
      requiredUrgency: "urgent",
      timeoutSeconds: 30,
      preTransferWording: "Putting you through to the locksmith now — one moment.",
      unansweredAction: "try_backup_number",
      maxAttempts: 2,
      collectDetailsFirst: true,
    },

    notifications: {
      sms: [TRANSFER_PRIMARY],
      email: [],
      urgentOnly: [],
      standardSummary: [],
      backup: [],
      timing: "immediate",
      contentPreferences: "Short summary: caller, suburb, job type, urgency.",
    },

    pricing: {
      mayMentionPricing: false,
      calloutWording: null,
      indicativePrices: [],
      afterHoursSurchargeWording: null,
      disclaimer: "The locksmith confirms all pricing directly.",
      neverState: ["Any figure, range or estimate", "That the business is the cheapest option"],
      humanConfirmsEveryPrice: true,
    },

    callerInfo: {
      always: ["caller_name", "callback_number", "suburb", "problem_description"],
      byService: {},
      otherQuestions: [],
    },

    // All eight are MANDATORY_FORBIDDEN_PROMISES — the schema refuses a profile
    // that omits any of them, which is the floor beneath every client.
    forbiddenPromises: [
      { promiseId: "guaranteed_technician_availability", enabled: true, note: null },
      { promiseId: "guaranteed_arrival_time", enabled: true, note: null },
      { promiseId: "fixed_price_without_approval", enabled: true, note: null },
      { promiseId: "claim_already_dispatched", enabled: true, note: null },
      { promiseId: "claim_licensing_or_identity_verified", enabled: true, note: null },
      { promiseId: "advise_illegal_entry", enabled: true, note: null },
      { promiseId: "promise_emergency_service_attendance", enabled: true, note: null },
      { promiseId: "legal_or_insurance_advice", enabled: true, note: null },
    ],

    privacy: {
      // Recording stays OFF. This drives Retell's data_storage_setting through
      // the compiler, so it is not merely a provider-side setting.
      callsMayBeRecorded: false,
      recordingDisclosure: null,
      transcriptRetention: "keep_12_months",
      recordingRetention: null,
      redactSensitiveData: true,
      customerContactConsentWording: null,
      privacyPolicyReference: null,
    },

    extensions: {},
  };
}

module.exports = {
  SANDBOX_PROFILE_VERSION,
  SANDBOX_CLIENT_ID,
  TRANSFER_PRIMARY,
  TRANSFER_BACKUP,
  buildSandboxProfile,
};
