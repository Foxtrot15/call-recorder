// AIDA PLATFORM — the existing locksmith, moved onto the platform (P7).
//
//   migrateLocksmithProfile(legacyProfile, { vertical })
//     -> { ok, blueprint, notes[], unmapped[], defaultsApplied[] }
//
// ── WHY THIS IS THE STAGE THAT PROVES THE MODEL ─────────────────────
// A generic model that cannot express the business it was generalised FROM is
// not generic, it is just different. So the input here is not an invented
// example: it is the profile the shipped extraction adapter produces from the
// demonstration interview — the same object the existing receptionist compiler
// builds a real agent from.
//
// ── NOTHING IS DROPPED SILENTLY ─────────────────────────────────────
// Three kinds of imperfection, and each is reported rather than swallowed:
//
//   notes[]            carried across, but changed shape on the way
//   unmapped[]         the platform has nowhere for it — a human decides
//   defaultsApplied[]  the platform needed an answer the old profile never
//                      asked for, so a default is standing in until reviewed
//
// A migration that returns a clean blueprint and an empty report is lying about
// at least one of those. The interesting output of this function is the report.
//
// ── AND IT PRODUCES A DRAFT ─────────────────────────────────────────
// Migrating is not approving. The blueprint comes back with status "draft" like
// anything else, and goes through validation, diff and human approval before it
// can be activated. Importing a config is exactly the moment somebody would
// want to skip that, which is exactly why it is not skippable.

const { emptyBlueprint, MANDATORY_PROHIBITED_CLAIMS, CALLER_INFO_FIELDS } = require("./client-blueprint");

const MIGRATION_VERSION = "aida-locksmith-migration-2026-08-16";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Legacy caller-info fields that have a direct platform equivalent. Anything
 * NOT here becomes an explicit additional question rather than vanishing —
 * "we stopped asking whether the property is secure" is not a detail to
 * discover from a transcript six months later.
 */
const CALLER_FIELD_MAP = Object.freeze({
  caller_name: "caller_name",
  callback_number: "callback_number",
  suburb: "suburb",
  street_address: "service_address",
  property_type: "property_type",
  problem_description: "problem_description",
  desired_timing: "preferred_time",
});

/** The words to ask for a legacy field the platform has no column for. */
const CARRIED_AS_QUESTION = Object.freeze({
  property_secure: "Is the property secure at the moment?",
  vehicle_make: "What make is the vehicle?",
  vehicle_model: "What model is it?",
  vehicle_year: "What year is it?",
  proof_of_ownership_reminder: "Please have proof of ownership or residence ready when the locksmith arrives.",
  other_reviewed_question: "Is there anything else we should know?",
});

/**
 * Legacy urgency had four levels and no "emergency". The platform added one
 * ABOVE urgent, so every legacy level keeps its meaning and nothing is
 * promoted by accident — a migration that quietly turned "urgent" into
 * "emergency" would change who gets telephoned at 2am.
 */
const URGENCY_MAP = Object.freeze({
  urgent: "urgent",
  priority: "priority",
  standard: "standard",
  non_urgent: "non_urgent",
});

/** Legacy tones are speaking styles; the platform keeps them as tone wording. */
const TONE_WORDING = Object.freeze({
  straightforward_efficient: "straightforward and efficient",
  warm_reassuring: "warm and reassuring",
  professional: "professional",
  friendly_australian_trade: "friendly, straightforward Australian trade",
});

/** lower_snake, because the platform's ids are slugs and legacy ids were not always. */
function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "c$1")
    .slice(0, 60);
}

function migrateLocksmithProfile(legacy, { vertical = "locksmith" } = {}) {
  const notes = [];
  const unmapped = [];
  const defaultsApplied = [];
  const note = (path, message) => notes.push({ path, message });
  const drop = (path, message, value) => unmapped.push({ path, message, value });
  const defaulted = (path, value, message) => defaultsApplied.push({ path, value, message });

  if (!isObj(legacy)) {
    return Object.freeze({
      ok: false,
      migrationVersion: MIGRATION_VERSION,
      blueprint: null,
      notes: Object.freeze([]),
      unmapped: Object.freeze([]),
      defaultsApplied: Object.freeze([]),
      message: "a legacy locksmith profile object is required",
    });
  }

  const L = {
    identity: legacy.identity || {},
    servicesAccepted: arr(legacy.servicesAccepted),
    servicesDeclined: arr(legacy.servicesDeclined),
    serviceAreas: legacy.serviceAreas || {},
    hours: legacy.hours || {},
    urgencyRules: arr(legacy.urgencyRules),
    transfer: legacy.transfer || {},
    notifications: legacy.notifications || {},
    pricing: legacy.pricing || {},
    callerInfo: legacy.callerInfo || {},
    forbiddenPromises: arr(legacy.forbiddenPromises),
    privacy: legacy.privacy || {},
    extensions: isObj(legacy.extensions) ? legacy.extensions : {},
  };

  const clientId = slugify(L.identity.clientId);
  if (clientId !== L.identity.clientId) {
    note("identity.clientId", `"${L.identity.clientId}" is not a platform slug and became "${clientId}" — check anything that joins on the old value`);
  }

  const bp = emptyBlueprint({ clientId, vertical });

  // ── identity ──
  bp.identity = {
    ...bp.identity,
    legalName: L.identity.legalName ?? null,
    tradingName: L.identity.spokenName ?? null,
    assistantName: L.identity.receptionistName ?? null,
    timezone: L.identity.timezone ?? null,
    description: L.identity.description ?? null,
    website: L.identity.website ?? null,
    businessPhone: L.identity.businessPhone ?? null,
  };

  // ── services: accepted and declined both survive ──
  const acceptedIds = new Set();
  bp.services = L.servicesAccepted.filter(isObj).map((s) => {
    const serviceId = slugify(s.serviceId);
    acceptedIds.add(serviceId);
    if (s.availability) {
      drop(`servicesAccepted.${s.serviceId}.availability`, "per-service availability has no platform equivalent — express it as hours or an urgency rule", s.availability);
    }
    return {
      serviceId,
      name: s.publicName ?? s.serviceId,
      aliases: [],
      enabled: s.enabled !== false,
      // Legacy said only "may this be urgent". The platform wants a category,
      // and urgent/standard is the honest reading of a boolean.
      urgencyCategory: s.mayBeUrgent === true ? "urgent" : "standard",
      description: s.notes ?? null,
      qualificationRequirements: [],
      exclusions: [],
    };
  });

  // A declined service is a real instruction to the assistant, so it stays as a
  // disabled service carrying its reason rather than disappearing.
  for (const d of L.servicesDeclined.filter(isObj)) {
    const serviceId = slugify(d.serviceId);
    if (acceptedIds.has(serviceId)) continue;
    bp.services.push({
      serviceId,
      name: d.serviceId,
      aliases: [],
      enabled: false,
      urgencyCategory: "standard",
      description: d.reason ? `Not offered. ${d.reason}` : "Not offered.",
      qualificationRequirements: [],
      exclusions: [],
    });
  }
  if (L.servicesDeclined.length) {
    note("servicesDeclined", `${L.servicesDeclined.length} declined services became disabled services carrying their reason`);
  }

  // ── service area ──
  const primary = arr(L.serviceAreas.primary);
  const extended = arr(L.serviceAreas.extended);
  bp.serviceArea = {
    ...bp.serviceArea,
    suburbs: [...new Set([...primary, ...extended])],
    exclusions: arr(L.serviceAreas.declined),
    radiusKm: L.serviceAreas.radiusKm ?? null,
    outsideAreaAction: L.serviceAreas.outsideAreaAction ?? null,
    outsideAreaWording: L.serviceAreas.outsideAreaWording ?? null,
    remoteServiceAvailable: false,
  };
  if (extended.length) {
    note("serviceAreas.extended", `the platform holds one suburb list, so ${extended.length} extended suburbs were merged into it`);
  }
  if (L.serviceAreas.outsideAreaAction === "other_reviewed_action") {
    drop("serviceAreas.outsideAreaAction", '"other_reviewed_action" is not a platform action — choose a real one', L.serviceAreas.outsideAreaAction);
    bp.serviceArea.outsideAreaAction = null;
  }
  const afterHoursAreas = L.serviceAreas.afterHoursAreas;
  if (Array.isArray(afterHoursAreas) && JSON.stringify([...afterHoursAreas].sort()) !== JSON.stringify([...primary].sort())) {
    drop("serviceAreas.afterHoursAreas", "a different service area after hours has no platform equivalent — express it as an urgency rule", afterHoursAreas);
  }

  // ── hours ──
  bp.hours = {
    timezone: L.hours.timezone ?? null,
    weekly: isObj(L.hours.ordinary) ? { ...L.hours.ordinary } : {},
    closedPeriods: [],
    afterHours: {
      available: typeof L.hours.afterHoursAvailable === "boolean" ? L.hours.afterHoursAvailable : null,
      policy: L.hours.afterHoursNote ?? null,
      surchargeApplies: isStr(L.pricing.afterHoursSurchargeWording) ? true : null,
    },
    publicHolidays: L.hours.publicHolidays ?? null,
  };
  if (isObj(L.hours.byService) && Object.keys(L.hours.byService).length) {
    drop("hours.byService", "per-service hours have no platform equivalent — express them as a service note or an urgency rule", L.hours.byService);
  }
  if (L.hours.temporaryClosure) {
    drop("hours.temporaryClosure", "temporary closures belong in closedPeriods with real dates", L.hours.temporaryClosure);
  }

  // ── call handling ──
  const collectAlways = [];
  const additionalQuestions = [];
  const carryField = (field, appliesToServices = []) => {
    if (CALLER_FIELD_MAP[field]) {
      const mapped = CALLER_FIELD_MAP[field];
      if (!collectAlways.includes(mapped) && appliesToServices.length === 0) collectAlways.push(mapped);
      return mapped;
    }
    const question = CARRIED_AS_QUESTION[field];
    if (question) {
      if (!additionalQuestions.some((q) => q.id === field)) {
        additionalQuestions.push({ id: field, question, appliesToServices });
        note(`callerInfo.${field}`, "no platform field for this, so it is carried as an explicit question");
      }
      return null;
    }
    drop(`callerInfo.${field}`, "unknown legacy caller-info field", field);
    return null;
  };

  for (const field of arr(L.callerInfo.always)) carryField(field);

  const collectByService = {};
  const addForService = (serviceId, fields) => {
    for (const field of arr(fields)) {
      const mapped = CALLER_FIELD_MAP[field];
      if (mapped) {
        if (collectAlways.includes(mapped)) continue;
        collectByService[serviceId] = collectByService[serviceId] || [];
        if (!collectByService[serviceId].includes(mapped)) collectByService[serviceId].push(mapped);
      } else {
        carryField(field, [serviceId]);
      }
    }
  };
  for (const [sid, fields] of Object.entries(isObj(L.callerInfo.byService) ? L.callerInfo.byService : {})) {
    addForService(slugify(sid), fields);
  }
  for (const s of L.servicesAccepted.filter(isObj)) {
    if (arr(s.mustCollect).length) addForService(slugify(s.serviceId), s.mustCollect);
  }
  for (const q of arr(L.callerInfo.otherQuestions)) {
    const id = slugify(typeof q === "string" ? q : q && q.id);
    const text = typeof q === "string" ? q : (q && q.question) || null;
    if (id && text) additionalQuestions.push({ id, question: text, appliesToServices: [] });
  }

  if (collectAlways.length === 0) {
    collectAlways.push("caller_name", "callback_number");
    defaulted("callHandling.collectAlways", ["caller_name", "callback_number"], "the old profile collected nothing on every call, and nobody can be rung back without these");
  }

  bp.callHandling = {
    ...bp.callHandling,
    greetingStyle: L.identity.greeting ?? null,
    collectAlways,
    collectByService,
    additionalQuestions,
    urgencyRules: L.urgencyRules.filter(isObj).map((r) => {
      if (r.notificationPriority) {
        drop(`urgencyRules.${r.ruleId}.notificationPriority`, "per-rule notification priority has no platform equivalent yet — it belongs with the notification adapter", r.notificationPriority);
      }
      return {
        ruleId: slugify(r.ruleId),
        when: r.condition ?? null,
        level: URGENCY_MAP[r.classification] ?? null,
        action: r.action ?? null,
        transferEligible: typeof r.transferEligible === "boolean" ? r.transferEligible : null,
        wording: r.approvedWording ?? null,
      };
    }),
    escalation: {
      primaryNumber: L.transfer.primaryNumber ?? null,
      backupNumber: L.transfer.backupNumber ?? null,
      permittedHours: L.transfer.permittedHours ?? null,
      eligibleServices: arr(L.transfer.eligibleServices).map(slugify),
      minimumUrgency: URGENCY_MAP[L.transfer.requiredUrgency] ?? null,
      timeoutSeconds: L.transfer.timeoutSeconds ?? null,
      preTransferWording: L.transfer.preTransferWording ?? null,
      unansweredAction: L.transfer.unansweredAction ?? null,
      maxAttempts: L.transfer.maxAttempts ?? null,
    },
    callbackPolicy: null,
    unavailableAction: null,
    intentTaxonomy: [],
  };

  if (isStr(L.identity.greeting)) {
    note("identity.greeting", "the legacy greeting became greeting STYLE; the spoken opening line is now built by the platform and always discloses that the assistant is AI");
  }
  if (L.transfer.collectDetailsFirst != null) {
    drop("transfer.collectDetailsFirst", "collect-before-transfer has no platform equivalent — express it in preTransferWording or an urgency rule", L.transfer.collectDetailsFirst);
  }

  // Legacy urgency levels stopped at "urgent". The platform has one above it,
  // and choosing which calls deserve it is a decision for a person.
  if (bp.callHandling.urgencyRules.some((r) => r.level === "urgent")) {
    note("urgencyRules", 'the platform added an "emergency" level above "urgent"; nothing was promoted automatically, so review whether any of these deserve it');
  }

  // ── knowledge ──
  const prohibited = [...MANDATORY_PROHIBITED_CLAIMS];
  for (const p of L.forbiddenPromises.filter(isObj)) {
    if (p.enabled === false) continue;
    const id = slugify(p.promiseId);
    if (id && !prohibited.includes(id)) prohibited.push(id);
  }
  for (const never of arr(L.pricing.neverState)) {
    const id = slugify(never);
    if (id && !prohibited.includes(id)) prohibited.push(id);
  }

  let pricingDisclosure;
  if (L.pricing.mayMentionPricing === false) pricingDisclosure = "never_discuss";
  else if (arr(L.pricing.indicativePrices).length) pricingDisclosure = "indicative_ranges";
  else if (isStr(L.pricing.calloutWording)) pricingDisclosure = "callout_fee_only";
  else if (L.pricing.mayMentionPricing === true) pricingDisclosure = "confirmed_at_booking";
  else {
    pricingDisclosure = "never_discuss";
    defaulted("knowledge.pricingDisclosure", "never_discuss", "the old profile did not say whether pricing may be mentioned, and silence is safer than a guess in the other direction");
  }

  bp.knowledge = {
    approvedFacts: [],
    sourceReferences: [],
    prohibitedClaims: prohibited,
    uncertaintyPolicy: "say_unsure_and_take_message",
    pricingDisclosure,
    pricingWording: L.pricing.calloutWording ?? L.pricing.disclaimer ?? null,
  };
  defaulted("knowledge.uncertaintyPolicy", "say_unsure_and_take_message", "the old profile had no equivalent, and taking a message is the least confident option available");
  if (arr(L.pricing.indicativePrices).length) {
    note("pricing.indicativePrices", `${L.pricing.indicativePrices.length} indicative prices are not carried as figures — the platform holds a disclosure policy and wording, so restate them there if they should be said aloud`);
  }
  if (isStr(L.pricing.afterHoursSurchargeWording)) {
    note("pricing.afterHoursSurchargeWording", "carried as hours.afterHours.surchargeApplies; restate the wording in pricingWording if it should be said aloud");
  }
  if (L.pricing.humanConfirmsEveryPrice === true) {
    note("pricing.humanConfirmsEveryPrice", "the platform expresses this as a disclosure policy rather than a flag");
  }

  // ── compliance ──
  bp.compliance = {
    callsMayBeRecorded: typeof L.privacy.callsMayBeRecorded === "boolean" ? L.privacy.callsMayBeRecorded : null,
    recordingDisclosure: L.privacy.recordingDisclosure ?? null,
    transcriptRetention: L.privacy.transcriptRetention ?? null,
    recordingRetention: L.privacy.recordingRetention ?? null,
    redactSensitiveData: typeof L.privacy.redactSensitiveData === "boolean" ? L.privacy.redactSensitiveData : null,
    privacyPolicyReference: L.privacy.privacyPolicyReference ?? null,
  };
  if (isStr(L.privacy.customerContactConsentWording)) {
    drop("privacy.customerContactConsentWording", "contact-consent wording has no platform equivalent yet", L.privacy.customerContactConsentWording);
  }

  // ── booking, voice, outbound ──
  bp.booking = { ...bp.booking, enabled: false };
  defaulted("booking.enabled", false, "the old profile had no booking concept, so it is off until somebody turns it on");

  bp.voice = {
    // Deliberately null. Legacy `tone` is a speaking style, not a voice, and
    // inventing a voice reference here would be a voice change nobody approved.
    profileRef: null,
    language: "en-AU",
    pronunciationHints: [],
    tone: L.identity.toneWording || TONE_WORDING[L.identity.tone] || null,
  };
  defaulted("voice.profileRef", null, "a voice must be chosen and approved deliberately — the old tone setting is a speaking style, not a voice");

  bp.outbound = { ...bp.outbound, enabled: false };

  // ── integrations: capability on/off, recipients stay with the adapter ──
  const integrations = [];
  const sms = arr(L.notifications.sms);
  const email = arr(L.notifications.email);
  if (sms.length) integrations.push({ capability: "sms", enabled: true, adapterRef: null, notes: `Legacy recipients: ${sms.join(", ")}. Confirm against adapter configuration.` });
  if (email.length) integrations.push({ capability: "email", enabled: true, adapterRef: null, notes: `Legacy recipients: ${email.join(", ")}. Confirm against adapter configuration.` });
  bp.integrations = integrations;
  for (const list of ["urgentOnly", "standardSummary", "backup"]) {
    if (arr(L.notifications[list]).length) {
      drop(`notifications.${list}`, "recipient routing belongs with the notification adapter, not in the blueprint", L.notifications[list]);
    }
  }
  if (L.notifications.timing || L.notifications.contentPreferences) {
    drop("notifications.timing/contentPreferences", "notification timing and content shape belong with the notification adapter", {
      timing: L.notifications.timing ?? null,
      contentPreferences: L.notifications.contentPreferences ?? null,
    });
  }

  // ── extensions ──
  bp.extensions = { ...L.extensions };

  // ── metadata: a DRAFT, like anything else ──
  bp.metadata = { ...bp.metadata, status: "draft", source: "import" };

  return Object.freeze({
    ok: true,
    migrationVersion: MIGRATION_VERSION,
    blueprint: bp,
    notes: Object.freeze(notes),
    unmapped: Object.freeze(unmapped),
    defaultsApplied: Object.freeze(defaultsApplied),
    requiresHumanReview: true,
  });
}

module.exports = { migrateLocksmithProfile, MIGRATION_VERSION, CALLER_FIELD_MAP, URGENCY_MAP, slugify };
