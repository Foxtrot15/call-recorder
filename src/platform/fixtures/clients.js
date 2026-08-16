// AIDA PLATFORM — three fictional clients, and one more for the demo (P7/P8/P9/P12).
//
// ── WHAT THESE PROVE ────────────────────────────────────────────────
// Locksmith A carries the existing pilot's behaviour, so the new model can be
// checked for parity against what already works. Locksmith B is the same trade
// with genuinely different answers, which is what catches "the platform quietly
// hardcodes one locksmith". Plumber C is a different trade entirely, built from
// configuration alone. Garage Door D exists to show a fourth client costs
// nothing but a file.
//
// EVERY ONE OF THEM IS FICTIONAL. No real business, no real telephone number
// (all in the +61 3 5550 xxxx reserved-for-fiction range), no real address.
//
// ── THE HARD REQUIREMENT ────────────────────────────────────────────
// There is no `if (vertical === 'plumber')` anywhere in src/platform. The
// plumber differs because its CONFIGURATION differs. A ratchet checks this by
// walking the platform source, because it is the one property that would be
// easiest to break and hardest to notice.

const { emptyBlueprint, MANDATORY_PROHIBITED_CLAIMS } = require("../client-blueprint");

const weekdays = (open, close) => ({
  monday: { open, close },
  tuesday: { open, close },
  wednesday: { open, close },
  thursday: { open, close },
  friday: { open, close },
});

/** LOCKSMITH A — carries the existing pilot's behaviour. */
function locksmithA() {
  const bp = emptyBlueprint({ clientId: "northside_locks", vertical: "locksmith" });

  bp.identity = {
    ...bp.identity,
    legalName: "Northside Lock & Key Pty Ltd",
    tradingName: "Northside Lock & Key",
    assistantName: "Aida",
    locale: "en-AU",
    timezone: "Australia/Melbourne",
    country: "AU",
    description: "A locksmith serving Melbourne's northern suburbs, including after-hours lockouts.",
    businessPhone: "+61355500101",
  };

  bp.services = [
    { serviceId: "residential_lockout", name: "Residential lockout", aliases: ["locked out of my house", "locked out of home"], enabled: true, urgencyCategory: "emergency", description: "Locked out of a house or unit.", qualificationRequirements: ["proof of residence on arrival"], exclusions: [] },
    { serviceId: "automotive_lockout", name: "Car lockout", aliases: ["locked out of my car", "keys in the car"], enabled: true, urgencyCategory: "emergency", description: "Locked out of a vehicle.", qualificationRequirements: ["proof of ownership on arrival"], exclusions: [] },
    { serviceId: "lost_car_keys", name: "Lost car keys", aliases: ["lost my car key"], enabled: true, urgencyCategory: "urgent", exclusions: ["European luxury vehicles"] },
    { serviceId: "rekeying", name: "Rekeying", aliases: ["change the locks"], enabled: true, urgencyCategory: "standard" },
    { serviceId: "lock_installation", name: "Lock installation", aliases: ["new lock", "fit a lock"], enabled: true, urgencyCategory: "standard" },
    { serviceId: "broken_key_extraction", name: "Broken key extraction", aliases: ["key snapped in the lock"], enabled: true, urgencyCategory: "urgent" },
    { serviceId: "break_in_repair", name: "Break-in repair", aliases: ["broken into", "burglary"], enabled: true, urgencyCategory: "emergency", description: "Securing a property after a break-in." },
    { serviceId: "key_cutting", name: "Key cutting", enabled: true, urgencyCategory: "non_urgent" },
    { serviceId: "safe_opening", name: "Safe opening", enabled: false, urgencyCategory: "standard" },
  ];

  bp.serviceArea = {
    ...bp.serviceArea,
    regions: ["Melbourne"],
    suburbs: ["Brunswick", "Coburg", "Preston", "Northcote", "Thornbury", "Fitzroy North"],
    postcodes: ["3056", "3058", "3072", "3070", "3071"],
    exclusions: ["Mornington Peninsula"],
    radiusKm: 25,
    remoteServiceAvailable: false,
    outsideAreaAction: "collect_details_for_confirmation",
    outsideAreaWording: "That's a bit outside our usual area — I'll take your details and someone will confirm whether we can get to you.",
  };

  bp.hours = {
    timezone: "Australia/Melbourne",
    weekly: { ...weekdays("08:00", "17:00"), saturday: { open: "09:00", close: "13:00" }, sunday: { closed: true } },
    closedPeriods: [{ from: "2026-12-25", to: "2026-12-26", reason: "Christmas" }],
    afterHours: { available: true, policy: "Emergency lockouts only, with an after-hours fee confirmed before dispatch.", surchargeApplies: true },
    publicHolidays: { byArrangement: true },
  };

  bp.callHandling = {
    ...bp.callHandling,
    greetingStyle: "Warm and brief. Name the business, say you are an AI assistant, ask how you can help.",
    collectAlways: ["caller_name", "callback_number", "suburb", "problem_description"],
    collectByService: {
      residential_lockout: ["service_address", "on_site_now", "access_notes"],
      automotive_lockout: ["service_address", "on_site_now"],
      break_in_repair: ["service_address", "on_site_now"],
    },
    additionalQuestions: [
      { id: "vehicle_details", question: "What make, model and year is the car?", appliesToServices: ["automotive_lockout", "lost_car_keys"] },
    ],
    urgencyRules: [
      { ruleId: "locked_out_at_night", when: "someone is locked out and it is outside business hours", level: "emergency", action: "transfer_immediately", transferEligible: true, wording: "I'll put you straight through." },
      { ruleId: "locked_out_with_child", when: "a child or pet is locked inside", level: "emergency", action: "transfer_immediately", transferEligible: true },
      { ruleId: "recent_break_in", when: "the property has just been broken into", level: "emergency", action: "transfer_immediately", transferEligible: true },
      { ruleId: "broken_key", when: "a key has snapped in a lock and the person cannot get in", level: "urgent", action: "notify_urgently_and_collect", transferEligible: false },
      { ruleId: "routine_work", when: "the work can wait for business hours", level: "standard", action: "collect_for_business_hours", transferEligible: false },
    ],
    escalation: {
      primaryNumber: "+61355500111",
      backupNumber: "+61355500112",
      permittedHours: { always: true },
      eligibleServices: ["residential_lockout", "automotive_lockout", "break_in_repair"],
      minimumUrgency: "urgent",
      timeoutSeconds: 30,
      preTransferWording: "I'm putting you through to one of our locksmiths now.",
      unansweredAction: "try_backup_number",
      maxAttempts: 2,
    },
    callbackPolicy: "Offer a callback within the hour during business hours.",
    unavailableAction: "take_message_and_notify",
    intentTaxonomy: [
      { intentId: "emergency_lockout", label: "Emergency lockout", examples: ["I'm locked out", "I can't get in"] },
      { intentId: "quote_request", label: "Quote request", examples: ["how much to change a lock"] },
      { intentId: "existing_job", label: "Existing job", examples: ["someone came yesterday"] },
    ],
  };

  bp.knowledge = {
    approvedFacts: [
      { factId: "licensed", statement: "We are a licensed locksmith business.", sourceRef: "business_docs" },
      { factId: "after_hours", statement: "We attend emergency lockouts after hours.", sourceRef: "business_docs" },
      { factId: "no_locksmith_advice", statement: "We do not advise on how to open locks over the phone.", sourceRef: "business_docs" },
    ],
    sourceReferences: [{ refId: "business_docs", description: "Owner-supplied business description, reviewed 2026-08", url: null }],
    prohibitedClaims: [...MANDATORY_PROHIBITED_CLAIMS, "never_miss_a_call", "guaranteed_entry_without_damage"],
    uncertaintyPolicy: "say_unsure_and_take_message",
    pricingDisclosure: "callout_fee_only",
    pricingWording: "There's a call-out fee, and the locksmith confirms the full price before starting any work.",
  };

  bp.booking = { ...bp.booking, enabled: false };

  bp.voice = { profileRef: "warm_female_au", language: "en-AU", pronunciationHints: [], tone: "warm, calm, unhurried" };

  bp.outbound = { ...bp.outbound, enabled: false };

  bp.integrations = [
    { capability: "sms", enabled: true, adapterRef: "sms_default", notes: "Job notifications to the on-call locksmith." },
    { capability: "email", enabled: true, adapterRef: "email_default", notes: "End-of-day summary." },
    { capability: "crm", enabled: false, adapterRef: null, notes: null },
    { capability: "calendar", enabled: false, adapterRef: null, notes: null },
  ];

  return bp;
}

/** LOCKSMITH B — same trade, deliberately different answers. */
function locksmithB() {
  const bp = emptyBlueprint({ clientId: "southbank_security", vertical: "locksmith" });

  bp.identity = {
    ...bp.identity,
    legalName: "Southbank Security Locksmiths Pty Ltd",
    tradingName: "Southbank Security",
    assistantName: "Mia",
    locale: "en-AU",
    timezone: "Australia/Melbourne",
    country: "AU",
    description: "Commercial locksmith and access-control specialists in Melbourne's CBD and inner south.",
    businessPhone: "+61355500201",
  };

  // Commercial-first: no automotive work at all, and access control instead.
  bp.services = [
    { serviceId: "commercial_lockout", name: "Commercial lockout", aliases: ["locked out of the office", "can't get into the shop"], enabled: true, urgencyCategory: "urgent" },
    { serviceId: "access_control", name: "Access control systems", aliases: ["swipe cards", "fobs", "electronic locks"], enabled: true, urgencyCategory: "standard" },
    { serviceId: "master_key_systems", name: "Master key systems", enabled: true, urgencyCategory: "standard" },
    { serviceId: "safe_servicing", name: "Safe servicing", enabled: true, urgencyCategory: "standard" },
    { serviceId: "door_hardware_repair", name: "Door hardware repair", aliases: ["door closer", "the door won't shut"], enabled: true, urgencyCategory: "priority" },
    { serviceId: "security_audit", name: "Security audit", enabled: true, urgencyCategory: "non_urgent" },
  ];

  bp.serviceArea = {
    ...bp.serviceArea,
    regions: ["Melbourne CBD"],
    suburbs: ["Southbank", "Docklands", "South Melbourne", "Port Melbourne", "Melbourne"],
    postcodes: ["3006", "3008", "3205", "3207", "3000"],
    exclusions: ["outer eastern suburbs"],
    radiusKm: 12,
    remoteServiceAvailable: true,
    outsideAreaAction: "transfer_for_manual_assessment",
    outsideAreaWording: "We mostly work in the CBD and inner south — let me put you through so someone can assess it properly.",
  };

  bp.hours = {
    timezone: "Australia/Melbourne",
    weekly: { ...weekdays("07:00", "18:00"), saturday: { closed: true }, sunday: { closed: true } },
    closedPeriods: [],
    afterHours: { available: false, policy: "No after-hours attendance. Commercial contracts are handled during business hours.", surchargeApplies: false },
    publicHolidays: { closed: true },
  };

  bp.callHandling = {
    ...bp.callHandling,
    greetingStyle: "Professional and efficient. Name the business, say you are an AI assistant, ask for the site and the issue.",
    collectAlways: ["caller_name", "callback_number", "service_address", "problem_description", "reference_number"],
    collectByService: { commercial_lockout: ["on_site_now", "access_notes"] },
    additionalQuestions: [
      { id: "site_contact", question: "Who is the site contact we should ask for on arrival?", appliesToServices: [] },
      { id: "building_access", question: "Is there building security we need to sign in with?", appliesToServices: ["commercial_lockout", "access_control"] },
    ],
    urgencyRules: [
      { ruleId: "premises_insecure", when: "a commercial premises cannot be locked and is standing open", level: "urgent", action: "transfer_immediately", transferEligible: true },
      { ruleId: "staff_locked_out", when: "staff cannot get into the premises during trading hours", level: "urgent", action: "notify_urgently_and_collect", transferEligible: false },
      { ruleId: "scheduled_work", when: "the work is planned rather than a problem", level: "non_urgent", action: "collect_for_business_hours", transferEligible: false },
    ],
    escalation: {
      primaryNumber: "+61355500211",
      backupNumber: null,
      permittedHours: { businessHoursOnly: true },
      eligibleServices: ["commercial_lockout"],
      minimumUrgency: "urgent",
      timeoutSeconds: 45,
      preTransferWording: "I'll put you through to our commercial team.",
      unansweredAction: "take_message_and_notify",
      maxAttempts: 1,
    },
    callbackPolicy: "Callback by end of next business day for non-urgent enquiries.",
    unavailableAction: "state_hours_and_end",
    intentTaxonomy: [
      { intentId: "site_emergency", label: "Site emergency", examples: ["the front door won't lock"] },
      { intentId: "new_contract", label: "New contract enquiry", examples: ["we're fitting out a new office"] },
    ],
  };

  bp.knowledge = {
    approvedFacts: [
      { factId: "commercial_only", statement: "We work with commercial and strata clients, not domestic callouts.", sourceRef: "sales_pack" },
      { factId: "access_control", statement: "We install and service electronic access-control systems.", sourceRef: "sales_pack" },
    ],
    sourceReferences: [{ refId: "sales_pack", description: "Commercial sales pack, reviewed 2026-08", url: null }],
    prohibitedClaims: [...MANDATORY_PROHIBITED_CLAIMS, "guaranteed_same_day_attendance"],
    uncertaintyPolicy: "say_unsure_and_transfer",
    pricingDisclosure: "never_discuss",
    pricingWording: "Pricing is quoted by our commercial team after we understand the site.",
  };

  bp.booking = {
    enabled: true,
    appointmentTypes: [
      { typeId: "site_assessment", label: "Site assessment", durationMinutes: 60, services: ["access_control", "master_key_systems", "security_audit"] },
      { typeId: "scheduled_repair", label: "Scheduled repair", durationMinutes: 90, services: ["door_hardware_repair", "safe_servicing"] },
    ],
    requiredInformation: ["service_address", "caller_name", "callback_number"],
    constraints: { minimumNoticeMinutes: 240, maximumDaysAhead: 30, slotGranularityMinutes: 30 },
    capabilityTarget: "calendar",
  };

  bp.voice = { profileRef: "neutral_professional_au", language: "en-AU", pronunciationHints: [{ term: "Southbank", hint: "SOUTH-bank" }], tone: "professional, precise" };

  bp.outbound = { ...bp.outbound, enabled: false };

  bp.integrations = [
    { capability: "calendar", enabled: true, adapterRef: "calendar_default", notes: "Site assessments." },
    { capability: "crm", enabled: true, adapterRef: "crm_default", notes: "Commercial pipeline." },
    { capability: "email", enabled: true, adapterRef: "email_default", notes: null },
    { capability: "sms", enabled: false, adapterRef: null, notes: null },
  ];

  return bp;
}

/** PLUMBER C — a different trade, built from configuration alone. */
function plumberC() {
  const bp = emptyBlueprint({ clientId: "riverside_plumbing", vertical: "plumbing" });

  bp.identity = {
    ...bp.identity,
    legalName: "Riverside Plumbing & Gas Pty Ltd",
    tradingName: "Riverside Plumbing",
    assistantName: "Ellie",
    locale: "en-AU",
    timezone: "Australia/Brisbane",
    country: "AU",
    description: "Residential plumbing and gas fitting across Brisbane's western suburbs.",
    businessPhone: "+61355500301",
  };

  bp.services = [
    { serviceId: "burst_pipe", name: "Burst pipe", aliases: ["pipe burst", "water everywhere", "flooding"], enabled: true, urgencyCategory: "emergency", description: "Water escaping under pressure.", qualificationRequirements: ["confirm the water meter can be turned off"] },
    { serviceId: "emergency_water_leak", name: "Emergency water leak", aliases: ["major leak", "water leaking through the ceiling"], enabled: true, urgencyCategory: "emergency" },
    { serviceId: "blocked_drain", name: "Blocked drain", aliases: ["drain is blocked", "sewage backing up", "gurgling drain"], enabled: true, urgencyCategory: "urgent", description: "Drains backing up or running slow." },
    { serviceId: "toilet_blockage", name: "Blocked toilet", aliases: ["toilet won't flush", "toilet overflowing"], enabled: true, urgencyCategory: "urgent" },
    { serviceId: "no_hot_water", name: "No hot water", aliases: ["hot water gone", "cold showers"], enabled: true, urgencyCategory: "priority" },
    { serviceId: "hot_water_system", name: "Hot water system repair or replacement", aliases: ["hot water unit", "water heater"], enabled: true, urgencyCategory: "priority" },
    { serviceId: "leaking_pipe", name: "Leaking pipe", aliases: ["dripping pipe", "slow leak"], enabled: true, urgencyCategory: "standard" },
    { serviceId: "leaking_tap", name: "Leaking tap", aliases: ["dripping tap", "tap won't turn off"], enabled: true, urgencyCategory: "non_urgent" },
    { serviceId: "general_plumbing", name: "General plumbing", enabled: true, urgencyCategory: "standard" },
    { serviceId: "gas_fitting", name: "Gas fitting", aliases: ["gas smell", "gas leak"], enabled: true, urgencyCategory: "emergency", description: "Gas work by a licensed gas fitter.", exclusions: ["bottled LPG appliances"] },
  ];

  bp.serviceArea = {
    ...bp.serviceArea,
    regions: ["Brisbane West"],
    suburbs: ["Toowong", "Indooroopilly", "Kenmore", "Chapel Hill", "Taringa", "St Lucia"],
    postcodes: ["4066", "4068", "4069", "4073"],
    exclusions: ["Gold Coast", "Sunshine Coast"],
    radiusKm: 20,
    remoteServiceAvailable: false,
    outsideAreaAction: "politely_decline",
    outsideAreaWording: "Sorry, we don't get out that far — you'd be better off with someone local.",
  };

  bp.hours = {
    timezone: "Australia/Brisbane",
    weekly: { ...weekdays("07:00", "16:30"), saturday: { open: "08:00", close: "12:00" }, sunday: { closed: true } },
    closedPeriods: [],
    afterHours: { available: true, policy: "Emergencies only — burst pipes, major leaks and gas.", surchargeApplies: true },
    publicHolidays: { byArrangement: true },
  };

  bp.callHandling = {
    ...bp.callHandling,
    greetingStyle: "Friendly and practical. Name the business, say you are an AI assistant, ask what's happening.",
    collectAlways: ["caller_name", "callback_number", "service_address", "problem_description"],
    collectByService: {
      burst_pipe: ["on_site_now", "access_notes"],
      gas_fitting: ["on_site_now"],
      emergency_water_leak: ["on_site_now", "access_notes"],
      hot_water_system: ["property_type"],
    },
    additionalQuestions: [
      { id: "water_off", question: "Have you been able to turn the water off at the meter?", appliesToServices: ["burst_pipe", "emergency_water_leak"] },
      { id: "gas_evacuate", question: "Is anyone still inside? Please go outside and don't use switches.", appliesToServices: ["gas_fitting"] },
      { id: "hot_water_age", question: "Roughly how old is the hot water system?", appliesToServices: ["no_hot_water", "hot_water_system"] },
    ],
    urgencyRules: [
      { ruleId: "gas_smell", when: "the caller can smell gas", level: "emergency", action: "transfer_immediately", transferEligible: true, wording: "Please go outside now and don't touch any switches. I'm putting you through straight away." },
      { ruleId: "uncontrolled_water", when: "water is escaping and cannot be turned off", level: "emergency", action: "transfer_immediately", transferEligible: true },
      { ruleId: "sewage_indoors", when: "sewage is coming back up inside the house", level: "urgent", action: "notify_urgently_and_collect", transferEligible: false },
      { ruleId: "no_hot_water_family", when: "a household has had no hot water for more than a day", level: "priority", action: "collect_and_notify", transferEligible: false },
      { ruleId: "dripping_tap", when: "it is a dripping tap or similar minor job", level: "non_urgent", action: "collect_for_business_hours", transferEligible: false },
    ],
    escalation: {
      primaryNumber: "+61355500311",
      backupNumber: "+61355500312",
      permittedHours: { always: true },
      eligibleServices: ["burst_pipe", "emergency_water_leak", "gas_fitting"],
      minimumUrgency: "emergency",
      timeoutSeconds: 25,
      preTransferWording: "I'm putting you through to our on-call plumber now.",
      unansweredAction: "try_backup_number",
      maxAttempts: 2,
    },
    callbackPolicy: "Same-day callback for priority jobs.",
    unavailableAction: "offer_callback",
    intentTaxonomy: [
      { intentId: "water_emergency", label: "Water emergency", examples: ["there's water everywhere"] },
      { intentId: "gas_emergency", label: "Gas emergency", examples: ["I can smell gas"] },
      { intentId: "routine_repair", label: "Routine repair", examples: ["my tap drips"] },
    ],
  };

  bp.knowledge = {
    approvedFacts: [
      { factId: "licensed_gas", statement: "Our gas work is done by a licensed gas fitter.", sourceRef: "trade_docs" },
      { factId: "hot_water_brands", statement: "We service and replace most common hot water systems.", sourceRef: "trade_docs" },
      { factId: "no_diy_advice", statement: "We don't talk people through plumbing repairs over the phone.", sourceRef: "trade_docs" },
    ],
    sourceReferences: [{ refId: "trade_docs", description: "Owner-supplied trade description, reviewed 2026-08", url: null }],
    prohibitedClaims: [...MANDATORY_PROHIBITED_CLAIMS, "guaranteed_no_excavation", "advice_on_making_a_gas_appliance_safe"],
    uncertaintyPolicy: "say_unsure_and_offer_callback",
    pricingDisclosure: "indicative_ranges",
    pricingWording: "I can give you a rough range, but the plumber confirms the price on site before starting.",
  };

  bp.booking = {
    enabled: true,
    appointmentTypes: [
      { typeId: "standard_visit", label: "Standard plumbing visit", durationMinutes: 60, services: ["leaking_pipe", "leaking_tap", "general_plumbing", "blocked_drain"] },
      { typeId: "hot_water_quote", label: "Hot water system quote", durationMinutes: 45, services: ["hot_water_system", "no_hot_water"] },
    ],
    requiredInformation: ["service_address", "caller_name", "callback_number", "preferred_time"],
    constraints: { minimumNoticeMinutes: 120, maximumDaysAhead: 21, slotGranularityMinutes: 30 },
    capabilityTarget: "booking",
  };

  bp.voice = { profileRef: "warm_female_au", language: "en-AU", pronunciationHints: [{ term: "Indooroopilly", hint: "in-doo-roo-PILL-ee" }], tone: "friendly, reassuring" };

  bp.outbound = { ...bp.outbound, enabled: false };

  bp.integrations = [
    { capability: "booking", enabled: true, adapterRef: "booking_default", notes: "Job scheduling." },
    { capability: "job_management", enabled: true, adapterRef: "jobs_default", notes: null },
    { capability: "sms", enabled: true, adapterRef: "sms_default", notes: "On-call notifications." },
    { capability: "email", enabled: false, adapterRef: null, notes: null },
  ];

  return bp;
}

/** GARAGE DOOR D — the "can a fourth client be just a file?" test. */
function garageDoorD() {
  const bp = emptyBlueprint({ clientId: "rolladoor_repairs", vertical: "garage_doors" });

  bp.identity = {
    ...bp.identity,
    legalName: "Rolladoor Repairs Pty Ltd",
    tradingName: "Rolladoor Repairs",
    assistantName: "Sam",
    locale: "en-AU",
    timezone: "Australia/Sydney",
    country: "AU",
    description: "Garage door and roller door repairs across Sydney's inner west.",
    businessPhone: "+61355500401",
  };

  bp.services = [
    { serviceId: "door_wont_open", name: "Garage door won't open", aliases: ["door stuck closed", "can't get the car out"], enabled: true, urgencyCategory: "urgent" },
    { serviceId: "door_wont_close", name: "Garage door won't close", aliases: ["door stuck open", "garage is open"], enabled: true, urgencyCategory: "emergency", description: "An open garage is a security problem." },
    { serviceId: "broken_spring", name: "Broken spring", enabled: true, urgencyCategory: "urgent" },
    { serviceId: "remote_not_working", name: "Remote not working", aliases: ["remote", "clicker"], enabled: true, urgencyCategory: "non_urgent" },
    { serviceId: "new_door_quote", name: "New door quote", enabled: true, urgencyCategory: "non_urgent" },
  ];

  bp.serviceArea = { ...bp.serviceArea, regions: ["Sydney Inner West"], suburbs: ["Marrickville", "Newtown", "Leichhardt", "Ashfield"], postcodes: ["2204", "2042", "2040", "2131"], radiusKm: 15, remoteServiceAvailable: false, outsideAreaAction: "politely_decline", outsideAreaWording: "Sorry, that's outside the area we cover." };

  bp.hours = { timezone: "Australia/Sydney", weekly: { ...weekdays("07:30", "16:00"), saturday: { open: "08:00", close: "12:00" }, sunday: { closed: true } }, closedPeriods: [], afterHours: { available: false, policy: null, surchargeApplies: false }, publicHolidays: { closed: true } };

  bp.callHandling = {
    ...bp.callHandling,
    greetingStyle: "Straightforward and quick. Name the business, say you are an AI assistant, ask what the door is doing.",
    collectAlways: ["caller_name", "callback_number", "service_address", "problem_description"],
    collectByService: { door_wont_close: ["on_site_now"] },
    additionalQuestions: [{ id: "door_type", question: "Is it a roller door, a tilt door or a sectional door?", appliesToServices: [] }],
    urgencyRules: [
      { ruleId: "garage_stuck_open", when: "the garage door is stuck open and the property is not secure", level: "emergency", action: "transfer_immediately", transferEligible: true },
      { ruleId: "car_trapped", when: "a car is trapped inside and the person needs it today", level: "urgent", action: "notify_urgently_and_collect", transferEligible: false },
      { ruleId: "remote_only", when: "only the remote is not working", level: "non_urgent", action: "collect_for_business_hours", transferEligible: false },
    ],
    escalation: { primaryNumber: "+61355500411", backupNumber: null, permittedHours: { businessHoursOnly: true }, eligibleServices: ["door_wont_close"], minimumUrgency: "emergency", timeoutSeconds: 30, preTransferWording: "Let me put you through.", unansweredAction: "take_message_and_notify", maxAttempts: 1 },
    callbackPolicy: "Next business day callback.",
    unavailableAction: "take_message_and_notify",
    intentTaxonomy: [{ intentId: "door_fault", label: "Door fault", examples: ["the door is making a noise"] }],
  };

  bp.knowledge = {
    approvedFacts: [{ factId: "brands", statement: "We repair most common garage door brands and motors.", sourceRef: "owner_notes" }],
    sourceReferences: [{ refId: "owner_notes", description: "Owner notes, reviewed 2026-08", url: null }],
    prohibitedClaims: [...MANDATORY_PROHIBITED_CLAIMS],
    uncertaintyPolicy: "say_unsure_and_take_message",
    pricingDisclosure: "confirmed_at_booking",
    pricingWording: "The technician confirms the price before any work starts.",
  };

  bp.booking = { ...bp.booking, enabled: false };
  bp.voice = { profileRef: "neutral_male_au", language: "en-AU", pronunciationHints: [], tone: "plain, practical" };
  bp.outbound = { ...bp.outbound, enabled: false };
  bp.integrations = [
    { capability: "sms", enabled: true, adapterRef: "sms_default", notes: null },
    { capability: "email", enabled: false, adapterRef: null, notes: null },
  ];

  return bp;
}

const FIXTURE_CLIENTS = Object.freeze({
  northside_locks: locksmithA,
  southbank_security: locksmithB,
  riverside_plumbing: plumberC,
  rolladoor_repairs: garageDoorD,
});

module.exports = { locksmithA, locksmithB, plumberC, garageDoorD, FIXTURE_CLIENTS };
