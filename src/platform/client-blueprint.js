// AIDA PLATFORM — the Client Blueprint (P2).
//
//   emptyBlueprint({ clientId, vertical })   a valid-shaped starting point
//   validateBlueprint(blueprint)             { ok, errors[], warnings[] }
//   BLUEPRINT_SCHEMA_VERSION
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────
// The one description of what differs between two businesses AIDA answers the
// telephone for. A locksmith and a plumber should differ by the contents of
// this object and by nothing else in the codebase.
//
// ── WHY IT IS NOT A JSON BLOB ───────────────────────────────────────
// The tempting way to "make it generic" is one loose `config` object per
// client. That moves every mistake from build time to the moment somebody is
// on the phone: a misspelt urgency level becomes an unclassified emergency, a
// missing transfer number becomes silence, and nothing tells you until it
// happens. So every field a decision depends on is named, typed and validated,
// and the only free-form space is a bounded `extensions` bag that no routing,
// safety or approval logic may read.
//
// This mirrors `locksmith-profile-schema.js`, deliberately. That schema was
// already right about almost everything; auditing it (P1) found the vertical
// coupling concentrated in ONE place — a hardcoded SERVICE_IDS enum listing
// lockouts and key cutting. Urgency levels, urgency actions, hours, transfer,
// notifications, pricing, caller info, forbidden promises and privacy were all
// already vertical-neutral.
//
// So the change here is narrow and specific: SERVICES BECOME CLIENT-DEFINED,
// and everything else keeps its platform-owned vocabulary.
//
// ── WHAT A CLIENT MAY NEVER CONFIGURE ───────────────────────────────
// Nothing in this file grants permission to do anything. A blueprint describes
// how AIDA should SPEAK and what it should COLLECT. It cannot:
//
//   - authorise an outbound call            (M8E pre-dial gate owns that)
//   - suppress or unsuppress a business     (append-only suppression owns it)
//   - assert a DNCR wash                    (the wash store owns it)
//   - unpause calling                       (durable calling state owns it)
//   - claim a dispatch                      (the dispatch store owns it)
//   - mark a webhook authentic              (signature verification owns it)
//
// A ratchet asserts this module imports none of them.

const BLUEPRINT_SCHEMA_VERSION = "aida-client-blueprint-2026-08-16";

// ── PLATFORM-OWNED VOCABULARY ───────────────────────────────────────
// Not client-configurable. A client chooses WHICH of their services is urgent;
// they do not invent a fifth urgency level, because downstream routing,
// notification priority and reporting all switch on these exact values.

const URGENCY_LEVELS = Object.freeze(["emergency", "urgent", "priority", "standard", "non_urgent"]);

const URGENCY_ACTIONS = Object.freeze([
  "transfer_immediately",
  "notify_urgently_and_collect",
  "collect_and_notify",
  "collect_for_business_hours",
  "decline_politely",
]);

const OUTSIDE_AREA_ACTIONS = Object.freeze([
  "collect_details_for_confirmation",
  "politely_decline",
  "transfer_for_manual_assessment",
]);

const UNAVAILABLE_ACTIONS = Object.freeze([
  "take_message_and_notify",
  "offer_callback",
  "transfer_to_backup",
  "state_hours_and_end",
]);

const UNANSWERED_TRANSFER_ACTIONS = Object.freeze([
  "try_backup_number",
  "take_message_and_notify",
  "take_message_only",
]);

const PRICING_DISCLOSURE = Object.freeze([
  "never_discuss",
  "callout_fee_only",
  "indicative_ranges",
  "confirmed_at_booking",
]);

const UNCERTAINTY_POLICIES = Object.freeze([
  "say_unsure_and_take_message",
  "say_unsure_and_transfer",
  "say_unsure_and_offer_callback",
]);

const DAYS = Object.freeze(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

/**
 * How long a client keeps what was said. Platform-owned because retention is a
 * compliance position rather than a preference, and because "keep forever" must
 * be a deliberate choice with a name rather than the absence of one.
 */
const RETENTION_PERIODS = Object.freeze([
  "keep_indefinitely_until_changed",
  "keep_12_months",
  "keep_6_months",
  "keep_3_months",
  "delete_after_summary",
]);

const BLUEPRINT_STATUSES = Object.freeze(["draft", "validated", "approved", "active", "superseded"]);

/**
 * Capability names, not vendors. A client says "we want bookings"; which
 * calendar it lands in is an adapter concern (P11), and swapping the adapter
 * must never require reopening the blueprint.
 */
const INTEGRATION_CAPABILITIES = Object.freeze([
  "crm",
  "calendar",
  "booking",
  "job_management",
  "sms",
  "email",
  "webhook",
]);

/**
 * Standard information an assistant may collect. Platform-owned because the
 * downstream record has columns, and because "collect their Medicare number"
 * should require a conversation rather than a config edit.
 */
const CALLER_INFO_FIELDS = Object.freeze([
  "caller_name",
  "callback_number",
  "service_address",
  "suburb",
  "problem_description",
  "urgency_signal",
  "access_notes",
  "preferred_time",
  "property_type",
  "on_site_now",
  "email",
  "reference_number",
]);

/**
 * Claims no assistant may make for any client in any vertical. A client may ADD
 * prohibitions; they may not remove these, and validation enforces that.
 */
const MANDATORY_PROHIBITED_CLAIMS = Object.freeze([
  "guaranteed_arrival_time",
  "guaranteed_price",
  "guaranteed_outcome",
  "legal_or_regulatory_advice",
  "insurance_coverage_assurance",
  "claiming_to_be_human",
]);

// ── Helpers ─────────────────────────────────────────────────────────

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isBool = (v) => typeof v === "boolean";
const isArr = (v) => Array.isArray(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SLUG = /^[a-z][a-z0-9_]{1,60}$/;

/**
 * The one place in the domain that may name a voice vendor, and it names them
 * only to REFUSE them. A provider voice id in the blueprint would make the
 * whole model provider-specific, so the prefixes are listed here as a
 * rejection rather than an integration. Kept as a named constant so the
 * boundary ratchet can exempt this single declaration and still fail on any
 * other mention of a provider anywhere in src/platform.
 */
const PROVIDER_VOICE_ID_PREFIXES = /^(11labs-|custom_voice_|retell-|cartesia-|openai-)/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** A blueprint with every required container present and nothing invented. */
function emptyBlueprint({ clientId = null, vertical = null } = {}) {
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,

    identity: {
      clientId,
      legalName: null,
      tradingName: null,
      assistantName: null,
      vertical,
      locale: "en-AU",
      timezone: null,
      country: "AU",
      description: null,
      website: null,
      businessPhone: null,
    },

    // Client-defined. This is the field the P1 audit found was the vertical.
    services: [],

    serviceArea: {
      regions: [],
      suburbs: [],
      postcodes: [],
      exclusions: [],
      radiusKm: null,
      travelNotes: null,
      remoteServiceAvailable: null,
      outsideAreaAction: null,
      outsideAreaWording: null,
    },

    hours: {
      timezone: null,
      weekly: {},              // day -> { open, close } | { closed: true }
      closedPeriods: [],       // { from, to, reason }
      afterHours: {
        available: null,
        policy: null,          // free text, reviewed
        surchargeApplies: null,
      },
      publicHolidays: null,    // { closed:true } | { open, close } | { byArrangement:true }
    },

    callHandling: {
      greetingStyle: null,     // free text, reviewed
      collectAlways: [],       // CALLER_INFO_FIELDS
      collectByService: {},    // serviceId -> CALLER_INFO_FIELDS[]
      additionalQuestions: [], // { id, question, appliesToServices[] }
      urgencyRules: [],        // { ruleId, when, level, action, transferEligible, wording }
      escalation: {
        primaryNumber: null,
        backupNumber: null,
        permittedHours: null,  // { always:true } | { from, to } | { businessHoursOnly:true }
        eligibleServices: [],
        minimumUrgency: null,
        timeoutSeconds: null,
        preTransferWording: null,
        unansweredAction: null,
        maxAttempts: null,
      },
      callbackPolicy: null,
      unavailableAction: null,
      intentTaxonomy: [],      // { intentId, label, examples[] }
    },

    knowledge: {
      approvedFacts: [],       // { factId, statement, sourceRef }
      sourceReferences: [],    // { refId, description, url }
      prohibitedClaims: [...MANDATORY_PROHIBITED_CLAIMS],
      uncertaintyPolicy: null,
      pricingDisclosure: null,
      pricingWording: null,
    },

    booking: {
      enabled: null,
      appointmentTypes: [],    // { typeId, label, durationMinutes, services[] }
      requiredInformation: [],
      constraints: {
        minimumNoticeMinutes: null,
        maximumDaysAhead: null,
        slotGranularityMinutes: null,
      },
      capabilityTarget: null,  // an INTEGRATION_CAPABILITIES name, not a vendor
    },

    voice: {
      profileRef: null,        // provider-independent reference, resolved later
      language: "en-AU",
      pronunciationHints: [],  // { term, hint }
      tone: null,
    },

    // Recording and retention. Here rather than in an operations config
    // because whether a call is recorded changes what the assistant SAYS in
    // its first ten seconds, and that is this object's subject.
    compliance: {
      callsMayBeRecorded: null,
      recordingDisclosure: null,   // the words said aloud, required if recorded
      transcriptRetention: null,
      recordingRetention: null,
      redactSensitiveData: null,
      privacyPolicyReference: null,
    },

    // CAPABILITY ONLY. Never permission — see the header.
    outbound: {
      enabled: null,
      campaignType: null,
      proposition: null,
      qualificationCriteria: [],
      disclosureWording: null,
      optOutWording: null,
    },

    integrations: [],          // { capability, enabled, adapterRef, notes }

    extensions: {},

    metadata: {
      configVersion: null,
      status: "draft",
      createdAt: null,
      createdBy: null,
      supersedes: null,
      approvedAt: null,
      approvedBy: null,
      activatedAt: null,
      source: null,            // ui | voice | api | import
    },
  };
}

// ── Validation ──────────────────────────────────────────────────────

function validateBlueprint(bp) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!isObj(bp)) return Object.freeze({ ok: false, errors: [{ path: "", message: "blueprint must be an object" }], warnings: [] });
  if (bp.schemaVersion !== BLUEPRINT_SCHEMA_VERSION) {
    err("schemaVersion", `expected ${BLUEPRINT_SCHEMA_VERSION}`);
  }

  // ── identity ──
  const id = bp.identity;
  if (!isObj(id)) err("identity", "required");
  else {
    if (!isStr(id.clientId) || !SLUG.test(id.clientId)) err("identity.clientId", "required, lower_snake slug");
    if (!isStr(id.legalName)) err("identity.legalName", "required");
    if (!isStr(id.assistantName)) err("identity.assistantName", "required — the name the caller hears");
    if (!isStr(id.vertical) || !SLUG.test(id.vertical)) err("identity.vertical", "required, lower_snake slug");
    if (!isStr(id.timezone)) err("identity.timezone", "required — hours are meaningless without it");
    if (!isStr(id.locale)) err("identity.locale", "required");
    if (!isStr(id.country)) err("identity.country", "required");
    if (id.businessPhone != null && !E164.test(id.businessPhone)) err("identity.businessPhone", "must be E.164");
  }

  // ── services: the client-defined catalogue ──
  if (!isArr(bp.services) || bp.services.length === 0) {
    err("services", "at least one service is required — an assistant with no services cannot help anybody");
  } else {
    const seen = new Set();
    bp.services.forEach((s, i) => {
      const p = `services[${i}]`;
      if (!isObj(s)) { err(p, "must be an object"); return; }
      if (!isStr(s.serviceId) || !SLUG.test(s.serviceId)) err(`${p}.serviceId`, "required, lower_snake slug");
      else if (seen.has(s.serviceId)) err(`${p}.serviceId`, `duplicate "${s.serviceId}"`);
      else seen.add(s.serviceId);
      if (!isStr(s.name)) err(`${p}.name`, "required — what a caller would call it");
      if (!isBool(s.enabled)) err(`${p}.enabled`, "required boolean");
      if (!isStr(s.urgencyCategory) || !URGENCY_LEVELS.includes(s.urgencyCategory)) {
        err(`${p}.urgencyCategory`, `required, one of ${URGENCY_LEVELS.join(", ")}`);
      }
      if (s.aliases != null && (!isArr(s.aliases) || s.aliases.some((a) => !isStr(a)))) {
        err(`${p}.aliases`, "must be an array of non-empty strings");
      }
      if (s.qualificationRequirements != null && !isArr(s.qualificationRequirements)) {
        err(`${p}.qualificationRequirements`, "must be an array");
      }
      if (s.exclusions != null && !isArr(s.exclusions)) err(`${p}.exclusions`, "must be an array");
    });
    if (bp.services.every((s) => s && s.enabled === false)) {
      err("services", "every service is disabled — the assistant could not accept any work");
    }
  }

  const serviceIds = new Set((isArr(bp.services) ? bp.services : []).filter(isObj).map((s) => s.serviceId).filter(isStr));

  // ── service area ──
  const area = bp.serviceArea;
  if (!isObj(area)) err("serviceArea", "required");
  else {
    const hasArea =
      (isArr(area.regions) && area.regions.length) ||
      (isArr(area.suburbs) && area.suburbs.length) ||
      (isArr(area.postcodes) && area.postcodes.length) ||
      Number.isFinite(area.radiusKm);
    if (!hasArea) err("serviceArea", "define at least one of regions, suburbs, postcodes or radiusKm");
    if (!isStr(area.outsideAreaAction) || !OUTSIDE_AREA_ACTIONS.includes(area.outsideAreaAction)) {
      err("serviceArea.outsideAreaAction", `required, one of ${OUTSIDE_AREA_ACTIONS.join(", ")}`);
    }
    if (area.radiusKm != null && !(Number.isFinite(area.radiusKm) && area.radiusKm > 0)) {
      err("serviceArea.radiusKm", "must be a positive number when present");
    }
  }

  // ── hours ──
  const hours = bp.hours;
  if (!isObj(hours)) err("hours", "required");
  else {
    if (!isStr(hours.timezone)) err("hours.timezone", "required");
    else if (isObj(id) && isStr(id.timezone) && hours.timezone !== id.timezone) {
      err("hours.timezone", `must match identity.timezone (${id.timezone})`);
    }
    if (!isObj(hours.weekly)) err("hours.weekly", "required");
    else {
      for (const day of DAYS) {
        const d = hours.weekly[day];
        const p = `hours.weekly.${day}`;
        if (d === undefined) { err(p, "required — state closed explicitly rather than omitting the day"); continue; }
        if (!isObj(d)) { err(p, "must be an object"); continue; }
        if (d.closed === true) continue;
        if (!isStr(d.open) || !TIME.test(d.open)) err(`${p}.open`, "HH:MM required");
        if (!isStr(d.close) || !TIME.test(d.close)) err(`${p}.close`, "HH:MM required");
        if (TIME.test(d.open || "") && TIME.test(d.close || "") && d.open >= d.close) {
          err(p, `open ${d.open} is not before close ${d.close}`);
        }
      }
      for (const key of Object.keys(hours.weekly)) {
        if (!DAYS.includes(key)) err(`hours.weekly.${key}`, "not a day of the week");
      }
    }
    if (!isObj(hours.afterHours)) err("hours.afterHours", "required");
    else if (!isBool(hours.afterHours.available)) err("hours.afterHours.available", "required boolean");
  }

  // ── call handling ──
  const ch = bp.callHandling;
  if (!isObj(ch)) err("callHandling", "required");
  else {
    if (!isArr(ch.collectAlways) || ch.collectAlways.length === 0) {
      err("callHandling.collectAlways", "collect at least one thing — otherwise nobody can be called back");
    } else {
      ch.collectAlways.forEach((f, i) => {
        if (!CALLER_INFO_FIELDS.includes(f)) err(`callHandling.collectAlways[${i}]`, `unknown field "${f}"`);
      });
    }
    if (isObj(ch.collectByService)) {
      for (const [sid, fields] of Object.entries(ch.collectByService)) {
        if (!serviceIds.has(sid)) err(`callHandling.collectByService.${sid}`, "unknown serviceId");
        if (!isArr(fields)) err(`callHandling.collectByService.${sid}`, "must be an array");
        else fields.forEach((f, i) => {
          if (!CALLER_INFO_FIELDS.includes(f)) err(`callHandling.collectByService.${sid}[${i}]`, `unknown field "${f}"`);
        });
      }
    }
    if (!isArr(ch.urgencyRules)) err("callHandling.urgencyRules", "must be an array");
    else {
      const ruleIds = new Set();
      ch.urgencyRules.forEach((r, i) => {
        const p = `callHandling.urgencyRules[${i}]`;
        if (!isObj(r)) { err(p, "must be an object"); return; }
        if (!isStr(r.ruleId) || !SLUG.test(r.ruleId)) err(`${p}.ruleId`, "required, lower_snake slug");
        else if (ruleIds.has(r.ruleId)) err(`${p}.ruleId`, `duplicate "${r.ruleId}"`);
        else ruleIds.add(r.ruleId);
        if (!isStr(r.when)) err(`${p}.when`, "required — the condition in plain words");
        if (!URGENCY_LEVELS.includes(r.level)) err(`${p}.level`, `one of ${URGENCY_LEVELS.join(", ")}`);
        if (!URGENCY_ACTIONS.includes(r.action)) err(`${p}.action`, `one of ${URGENCY_ACTIONS.join(", ")}`);
        if (r.transferEligible != null && !isBool(r.transferEligible)) err(`${p}.transferEligible`, "must be boolean");
      });
    }
    const esc = ch.escalation;
    if (!isObj(esc)) err("callHandling.escalation", "required");
    else {
      if (esc.primaryNumber != null && !E164.test(esc.primaryNumber)) err("callHandling.escalation.primaryNumber", "must be E.164");
      if (esc.backupNumber != null && !E164.test(esc.backupNumber)) err("callHandling.escalation.backupNumber", "must be E.164");
      if (esc.unansweredAction != null && !UNANSWERED_TRANSFER_ACTIONS.includes(esc.unansweredAction)) {
        err("callHandling.escalation.unansweredAction", `one of ${UNANSWERED_TRANSFER_ACTIONS.join(", ")}`);
      }
      if (esc.minimumUrgency != null && !URGENCY_LEVELS.includes(esc.minimumUrgency)) {
        err("callHandling.escalation.minimumUrgency", `one of ${URGENCY_LEVELS.join(", ")}`);
      }
      if (isArr(esc.eligibleServices)) {
        esc.eligibleServices.forEach((s, i) => {
          if (!serviceIds.has(s)) err(`callHandling.escalation.eligibleServices[${i}]`, `unknown serviceId "${s}"`);
        });
      }
      // A transfer action with nowhere to transfer is the failure that is
      // silent on the call rather than loud in a config screen.
      const wantsTransfer =
        (isArr(ch.urgencyRules) && ch.urgencyRules.some((r) => isObj(r) && r.action === "transfer_immediately")) ||
        (isObj(area) && area.outsideAreaAction === "transfer_for_manual_assessment");
      if (wantsTransfer && !isStr(esc.primaryNumber)) {
        err("callHandling.escalation.primaryNumber", "required — something transfers, and there is no number to transfer to");
      }
    }
    if (ch.unavailableAction != null && !UNAVAILABLE_ACTIONS.includes(ch.unavailableAction)) {
      err("callHandling.unavailableAction", `one of ${UNAVAILABLE_ACTIONS.join(", ")}`);
    }
  }

  // ── knowledge ──
  const k = bp.knowledge;
  if (!isObj(k)) err("knowledge", "required");
  else {
    if (!isArr(k.prohibitedClaims)) err("knowledge.prohibitedClaims", "must be an array");
    else {
      for (const must of MANDATORY_PROHIBITED_CLAIMS) {
        if (!k.prohibitedClaims.includes(must)) {
          err("knowledge.prohibitedClaims", `"${must}" is mandatory for every client and may not be removed`);
        }
      }
    }
    if (!isStr(k.uncertaintyPolicy) || !UNCERTAINTY_POLICIES.includes(k.uncertaintyPolicy)) {
      err("knowledge.uncertaintyPolicy", `required, one of ${UNCERTAINTY_POLICIES.join(", ")}`);
    }
    if (!isStr(k.pricingDisclosure) || !PRICING_DISCLOSURE.includes(k.pricingDisclosure)) {
      err("knowledge.pricingDisclosure", `required, one of ${PRICING_DISCLOSURE.join(", ")}`);
    }
    if (isArr(k.approvedFacts)) {
      const refIds = new Set((isArr(k.sourceReferences) ? k.sourceReferences : []).filter(isObj).map((r) => r.refId));
      k.approvedFacts.forEach((f, i) => {
        const p = `knowledge.approvedFacts[${i}]`;
        if (!isObj(f)) { err(p, "must be an object"); return; }
        if (!isStr(f.factId)) err(`${p}.factId`, "required");
        if (!isStr(f.statement)) err(`${p}.statement`, "required");
        if (f.sourceRef != null && !refIds.has(f.sourceRef)) err(`${p}.sourceRef`, `unknown reference "${f.sourceRef}"`);
      });
    }
  }

  // ── booking ──
  const b = bp.booking;
  if (!isObj(b)) err("booking", "required");
  else if (!isBool(b.enabled)) err("booking.enabled", "required boolean — say no explicitly");
  else if (b.enabled === true) {
    if (!isArr(b.appointmentTypes) || b.appointmentTypes.length === 0) {
      err("booking.appointmentTypes", "required when booking is enabled");
    } else {
      b.appointmentTypes.forEach((t, i) => {
        const p = `booking.appointmentTypes[${i}]`;
        if (!isObj(t)) { err(p, "must be an object"); return; }
        if (!isStr(t.typeId) || !SLUG.test(t.typeId)) err(`${p}.typeId`, "required, lower_snake slug");
        if (!isStr(t.label)) err(`${p}.label`, "required");
        if (!(Number.isInteger(t.durationMinutes) && t.durationMinutes > 0)) err(`${p}.durationMinutes`, "positive integer required");
        if (isArr(t.services)) t.services.forEach((s, j) => {
          if (!serviceIds.has(s)) err(`${p}.services[${j}]`, `unknown serviceId "${s}"`);
        });
      });
    }
    if (!isStr(b.capabilityTarget) || !INTEGRATION_CAPABILITIES.includes(b.capabilityTarget)) {
      err("booking.capabilityTarget", `required when booking is enabled, one of ${INTEGRATION_CAPABILITIES.join(", ")}`);
    } else {
      const declared = (isArr(bp.integrations) ? bp.integrations : []).filter(isObj);
      const match = declared.find((x) => x.capability === b.capabilityTarget && x.enabled === true);
      if (!match) err("booking.capabilityTarget", `no enabled "${b.capabilityTarget}" integration is declared`);
    }
  }

  // ── voice ──
  const v = bp.voice;
  if (!isObj(v)) err("voice", "required");
  else {
    if (!isStr(v.language)) err("voice.language", "required");
    // A provider voice id here would make the blueprint provider-specific,
    // which is the boundary this whole model exists to hold.
    if (isStr(v.profileRef) && PROVIDER_VOICE_ID_PREFIXES.test(v.profileRef)) {
      err("voice.profileRef", "looks like a PROVIDER voice id — the blueprint holds a provider-independent reference");
    }
  }

  // ── compliance ──
  const comp = bp.compliance;
  if (!isObj(comp)) err("compliance", "required");
  else {
    if (!isBool(comp.callsMayBeRecorded)) {
      err("compliance.callsMayBeRecorded", "required boolean — recording is not a question to leave unanswered");
    } else if (comp.callsMayBeRecorded === true && !isStr(comp.recordingDisclosure)) {
      // Recording a caller without telling them is the compliance failure that
      // is invisible until it is a complaint.
      err("compliance.recordingDisclosure", "required when calls are recorded — the caller has to be told, in words");
    }
    for (const field of ["transcriptRetention", "recordingRetention"]) {
      if (comp[field] != null && !RETENTION_PERIODS.includes(comp[field])) {
        err(`compliance.${field}`, `one of ${RETENTION_PERIODS.join(", ")}`);
      }
    }
    if (comp.redactSensitiveData != null && !isBool(comp.redactSensitiveData)) {
      err("compliance.redactSensitiveData", "must be boolean");
    }
  }

  // ── outbound: capability only ──
  const ob = bp.outbound;
  if (!isObj(ob)) err("outbound", "required");
  else if (!isBool(ob.enabled)) err("outbound.enabled", "required boolean");
  else if (ob.enabled === true) {
    if (!isStr(ob.proposition)) err("outbound.proposition", "required when outbound is enabled");
    if (!isStr(ob.disclosureWording)) err("outbound.disclosureWording", "required — a cold call discloses what it is");
    if (!isStr(ob.optOutWording)) err("outbound.optOutWording", "required — a person must be able to end it permanently");
  }

  // ── integrations ──
  if (!isArr(bp.integrations)) err("integrations", "must be an array");
  else {
    const seen = new Set();
    bp.integrations.forEach((x, i) => {
      const p = `integrations[${i}]`;
      if (!isObj(x)) { err(p, "must be an object"); return; }
      if (!INTEGRATION_CAPABILITIES.includes(x.capability)) err(`${p}.capability`, `one of ${INTEGRATION_CAPABILITIES.join(", ")}`);
      else if (seen.has(x.capability)) err(`${p}.capability`, `duplicate "${x.capability}"`);
      else seen.add(x.capability);
      if (!isBool(x.enabled)) err(`${p}.enabled`, "required boolean");
    });
  }

  // ── extensions: bounded, and never load-bearing ──
  if (!isObj(bp.extensions)) err("extensions", "must be an object");
  else {
    const reserved = ["identity", "services", "serviceArea", "hours", "callHandling", "knowledge", "booking", "voice", "compliance", "outbound", "integrations", "metadata", "schemaVersion"];
    for (const key of Object.keys(bp.extensions)) {
      if (reserved.includes(key)) err(`extensions.${key}`, "reserved — this would be an end-run around a validated field");
    }
    if (JSON.stringify(bp.extensions).length > 4096) err("extensions", "must stay under 4KB");
  }

  // ── metadata ──
  const m = bp.metadata;
  if (!isObj(m)) err("metadata", "required");
  else if (!BLUEPRINT_STATUSES.includes(m.status)) err("metadata.status", `one of ${BLUEPRINT_STATUSES.join(", ")}`);

  // ── advisory ──
  if (isObj(ch) && isArr(ch.urgencyRules) && ch.urgencyRules.length === 0) {
    warn("callHandling.urgencyRules", "no urgency rules — every call will be treated the same way");
  }
  if (isObj(k) && isArr(k.approvedFacts) && k.approvedFacts.length === 0) {
    warn("knowledge.approvedFacts", "no approved facts — the assistant can describe the business only in general terms");
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  });
}

module.exports = {
  BLUEPRINT_SCHEMA_VERSION,
  emptyBlueprint,
  validateBlueprint,
  URGENCY_LEVELS,
  URGENCY_ACTIONS,
  OUTSIDE_AREA_ACTIONS,
  UNAVAILABLE_ACTIONS,
  UNANSWERED_TRANSFER_ACTIONS,
  PRICING_DISCLOSURE,
  UNCERTAINTY_POLICIES,
  INTEGRATION_CAPABILITIES,
  CALLER_INFO_FIELDS,
  MANDATORY_PROHIBITED_CLAIMS,
  BLUEPRINT_STATUSES,
  RETENTION_PERIODS,
  DAYS,
};
