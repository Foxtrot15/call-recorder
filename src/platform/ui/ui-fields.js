// AIDA PLATFORM UI — the Blueprint editor, declared rather than hand-built (P31).
//
//   EDITOR_SECTIONS            every section, in order, with its fields
//   fieldsFor(sectionKey)
//   readSection(blueprint, sectionKey)     -> values for the form
//   applySection(blueprint, key, values)   -> a new blueprint (pure)
//
// ── WHY DECLARATIVE ─────────────────────────────────────────────────
// Same reason src/services/locksmith-enquiry.js declares its FIELDS: a form
// hand-written in markup drifts from the schema it edits, and the drift is
// invisible until somebody cannot enter something they were promised. Here the
// fields are derived from client-blueprint.js's own vocabularies — the option
// list for urgency IS URGENCY_LEVELS, not a copy of it — so adding a level to
// the domain adds it to the form, and a test asserts no vocabulary is copied.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────
// It does not validate. validateBlueprint() is the authority and the screen
// shows what IT said. A `required` marker here is a courtesy that renders an
// asterisk-free "(required)" and nothing more; it never decides whether a save
// is allowed, and a test asserts a blueprint that fails domain validation is
// still refused by the service no matter what this file says.
//
// It also does not decide what is editable. LOCKED fields are listed here for
// DISPLAY, and the enforcement is client-blueprint.js and config-patch.js.

const B = require("../client-blueprint");
const V = require("./ui-vocabulary");
const R = require("./ui-repeatable");

/** An option list built FROM a domain vocabulary, never a copy of one. */
const options = (values, labels = {}) =>
  Object.freeze(values.map((v) => Object.freeze({ value: v, label: labels[v] || humanise(v) })));

const humanise = (v) =>
  String(v).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const field = (spec) =>
  Object.freeze({
    type: "text",
    required: false,
    hint: null,
    locked: false,
    lockReason: null,
    ...spec,
  });

const locked = (spec) =>
  field({ ...spec, locked: true, lockReason: spec.lockReason || V.LOCKED_FIELDS[spec.path] || null });

// ════════════════════════════════════════════════════════════════════
// SECTIONS
// ════════════════════════════════════════════════════════════════════

const IDENTITY = Object.freeze([
  locked({ name: "clientId", path: "identity.clientId", label: "Client id", hint: "Resolved from your session. This is never taken from a form." }),
  field({ name: "legalName", path: "identity.legalName", label: "Legal name", required: true, hint: "The registered business name." }),
  field({ name: "tradingName", path: "identity.tradingName", label: "Trading name", hint: "What customers call you, if it differs." }),
  field({ name: "assistantName", path: "identity.assistantName", label: "Assistant name", required: true,
    hint: "The name a caller hears. AIDA introduces itself with this." }),
  locked({ name: "vertical", path: "identity.vertical", label: "Trade", hint: "Changing the trade of an existing client is a new client, not an edit." }),
  field({ name: "locale", path: "identity.locale", label: "Locale", required: true, hint: "For example en-AU." }),
  field({ name: "timezone", path: "identity.timezone", label: "Timezone", required: true,
    hint: "Hours are meaningless without it. For example Australia/Sydney." }),
  field({ name: "country", path: "identity.country", label: "Country", required: true }),
  field({ name: "description", path: "identity.description", type: "textarea", label: "What the business does",
    hint: "One or two sentences the assistant can use to describe you." }),
  field({ name: "website", path: "identity.website", type: "url", label: "Website" }),
  field({ name: "businessPhone", path: "identity.businessPhone", type: "tel", label: "Business phone",
    hint: "E.164 format, for example +61355500399." }),
]);

/** A service row. The list itself is repeatable — see `repeatable` below. */
const SERVICE_FIELDS = Object.freeze([
  field({ name: "serviceId", label: "Service id", required: true, hint: "lower_snake_case, and it never changes once callers are being routed by it." }),
  field({ name: "name", label: "Name", required: true, hint: "What a caller would call it." }),
  field({ name: "aliases", type: "list", label: "Also called", hint: "Other words callers use for the same thing." }),
  field({ name: "description", type: "textarea", label: "Description" }),
  // blankDefault: a service somebody is adding is one they offer. The other
  // required field here, urgencyCategory, deliberately has NO default — see
  // blankItem() in ui-repeatable.js for why guessing it is the wrong kindness.
  field({ name: "enabled", type: "boolean", label: "Offered", required: true, blankDefault: true,
    hint: "Turning this off removes it from what the assistant offers, without deleting it." }),
  field({ name: "urgencyCategory", type: "select", label: "Urgency", required: true, options: options(B.URGENCY_LEVELS) }),
  field({ name: "qualificationRequirements", type: "list", label: "Qualification requirements",
    hint: "What the assistant must establish before accepting this job." }),
  field({ name: "exclusions", type: "list", label: "Exclusions", hint: "Work you do NOT take, even though it sounds like this service." }),
]);

const SERVICE_AREA = Object.freeze([
  field({ name: "regions", path: "serviceArea.regions", type: "list", label: "Regions" }),
  field({ name: "suburbs", path: "serviceArea.suburbs", type: "list", label: "Suburbs" }),
  field({ name: "postcodes", path: "serviceArea.postcodes", type: "list", label: "Postcodes" }),
  field({ name: "exclusions", path: "serviceArea.exclusions", type: "list", label: "Excluded areas" }),
  field({ name: "radiusKm", path: "serviceArea.radiusKm", type: "number", label: "Travel radius (km)" }),
  field({ name: "remoteServiceAvailable", path: "serviceArea.remoteServiceAvailable", type: "boolean", label: "Remote service available" }),
  field({ name: "outsideAreaAction", path: "serviceArea.outsideAreaAction", type: "select", required: true,
    label: "When a caller is outside your area", options: options(B.OUTSIDE_AREA_ACTIONS) }),
  field({ name: "outsideAreaWording", path: "serviceArea.outsideAreaWording", type: "textarea", label: "Words used outside your area" }),
  field({ name: "travelNotes", path: "serviceArea.travelNotes", type: "textarea", label: "Travel notes" }),
]);

/**
 * Hours are a weekly grid rather than a field list. Every day is REQUIRED to
 * say something, because the domain refuses an omitted day: "closed" stated is
 * a decision, and a missing Sunday is a gap nobody notices until a Sunday.
 */
const HOURS_DAYS = Object.freeze(
  B.DAYS.map((day) =>
    Object.freeze({
      day,
      label: humanise(day),
      closedName: `hours_${day}_closed`,
      openName: `hours_${day}_open`,
      closeName: `hours_${day}_close`,
      path: `hours.weekly.${day}`,
    }),
  ),
);

const HOURS_OTHER = Object.freeze([
  field({ name: "timezone", path: "hours.timezone", label: "Timezone", required: true,
    hint: "Must match the timezone in Identity." }),
  field({ name: "afterHoursAvailable", path: "hours.afterHours.available", type: "boolean", required: true,
    label: "Available after hours", hint: "Say yes or no explicitly." }),
  field({ name: "afterHoursPolicy", path: "hours.afterHours.policy", type: "textarea", label: "After-hours policy" }),
  field({ name: "surchargeApplies", path: "hours.afterHours.surchargeApplies", type: "boolean", label: "After-hours surcharge applies" }),
]);

const CALL_HANDLING = Object.freeze([
  field({ name: "greetingLine", path: "callHandling.greetingLine", type: "textarea", label: "Greeting",
    hint: "The words a caller hears first, spoken exactly. Leave blank to let AIDA compose one from your business name." }),
  field({ name: "greetingStyle", path: "callHandling.greetingStyle", type: "textarea", label: "Greeting style",
    hint: "An INSTRUCTION about tone, never spoken word for word." }),
  field({ name: "collectAlways", path: "callHandling.collectAlways", type: "checkboxes", required: true,
    label: "Always collect", options: options(B.CALLER_INFO_FIELDS),
    hint: "Collect at least one thing, or nobody can be called back." }),
  field({ name: "unavailableAction", path: "callHandling.unavailableAction", type: "select",
    label: "When nobody is available", options: options(B.UNAVAILABLE_ACTIONS) }),
  field({ name: "callbackPolicy", path: "callHandling.callbackPolicy", type: "textarea", label: "Callback policy" }),
  field({ name: "primaryNumber", path: "callHandling.escalation.primaryNumber", type: "tel", label: "Transfer number",
    hint: "E.164. Required if anything transfers — a transfer with nowhere to go is silence on the call." }),
  field({ name: "backupNumber", path: "callHandling.escalation.backupNumber", type: "tel", label: "Backup transfer number" }),
  field({ name: "unansweredAction", path: "callHandling.escalation.unansweredAction", type: "select",
    label: "If the transfer is not answered", options: options(B.UNANSWERED_TRANSFER_ACTIONS) }),
  field({ name: "minimumUrgency", path: "callHandling.escalation.minimumUrgency", type: "select",
    label: "Minimum urgency to transfer", options: options(B.URGENCY_LEVELS) }),
  field({ name: "preTransferWording", path: "callHandling.escalation.preTransferWording", type: "textarea",
    label: "What the assistant says before transferring" }),
]);

const URGENCY_RULE_FIELDS = Object.freeze([
  field({ name: "ruleId", label: "Rule id", required: true }),
  field({ name: "when", label: "When", required: true, hint: "The condition in plain words. \"Burning smell or sparking\"." }),
  field({ name: "level", type: "select", label: "Urgency", required: true, options: options(B.URGENCY_LEVELS) }),
  field({ name: "action", type: "select", label: "What the assistant does", required: true, options: options(B.URGENCY_ACTIONS) }),
  field({ name: "wording", type: "textarea", label: "Wording" }),
]);

const KNOWLEDGE = Object.freeze([
  field({ name: "uncertaintyPolicy", path: "knowledge.uncertaintyPolicy", type: "select", required: true,
    label: "When the assistant is unsure", options: options(B.UNCERTAINTY_POLICIES) }),
  field({ name: "pricingDisclosure", path: "knowledge.pricingDisclosure", type: "select", required: true,
    label: "Pricing policy", options: options(B.PRICING_DISCLOSURE) }),
  field({ name: "pricingWording", path: "knowledge.pricingWording", type: "textarea", label: "Pricing wording" }),
  locked({ name: "mandatoryProhibitions", path: "knowledge.prohibitedClaims.mandatory",
    type: "locked-list", label: "Claims no assistant may ever make",
    options: options(B.MANDATORY_PROHIBITED_CLAIMS) }),
  field({ name: "additionalProhibitions", path: "knowledge.prohibitedClaims", type: "list",
    label: "Additional prohibited claims", hint: "Anything else this assistant must never say. You may add; the six above cannot be removed." }),
]);

const KNOWLEDGE_FACT_FIELDS = Object.freeze([
  field({ name: "factId", label: "Fact id", required: true }),
  field({ name: "statement", type: "textarea", label: "Statement", required: true,
    hint: "Something the assistant may state as fact." }),
  field({ name: "sourceRef", label: "Reference id", hint: "Must match one of the references below." }),
]);

const KNOWLEDGE_REFERENCE_FIELDS = Object.freeze([
  field({ name: "refId", label: "Reference id", required: true }),
  field({ name: "description", label: "Description", required: true }),
  field({ name: "url", type: "url", label: "Link" }),
]);

const BOOKING = Object.freeze([
  field({ name: "enabled", path: "booking.enabled", type: "boolean", required: true, label: "Take bookings",
    hint: "Say no explicitly if you do not." }),
  field({ name: "capabilityTarget", path: "booking.capabilityTarget", type: "select", label: "Bookings go to",
    options: options(B.INTEGRATION_CAPABILITIES),
    hint: "A capability, not a vendor. The capability must also be enabled under Integrations." }),
  field({ name: "minimumNoticeMinutes", path: "booking.constraints.minimumNoticeMinutes", type: "number", label: "Minimum notice (minutes)" }),
  field({ name: "maximumDaysAhead", path: "booking.constraints.maximumDaysAhead", type: "number", label: "Maximum days ahead" }),
  field({ name: "slotGranularityMinutes", path: "booking.constraints.slotGranularityMinutes", type: "number", label: "Slot size (minutes)" }),
]);

const VOICE = Object.freeze([
  field({ name: "profileRef", path: "voice.profileRef", label: "Voice reference",
    hint: "A provider-independent reference. A provider voice id is refused here on purpose — the blueprint never names a vendor." }),
  field({ name: "language", path: "voice.language", label: "Language", required: true }),
  field({ name: "tone", path: "voice.tone", label: "Tone" }),
]);

const OUTBOUND = Object.freeze([
  field({ name: "enabled", path: "outbound.enabled", type: "boolean", required: true, label: "Outbound calling configured" }),
  field({ name: "campaignType", path: "outbound.campaignType", label: "Campaign type" }),
  field({ name: "proposition", path: "outbound.proposition", type: "textarea", label: "Proposition" }),
  field({ name: "qualificationCriteria", path: "outbound.qualificationCriteria", type: "list", label: "Qualification criteria" }),
  locked({ name: "aiDisclosure", path: "outbound.aiDisclosure", type: "statement",
    label: "AI disclosure", statement: V.OUTBOUND_DISCLOSURE_SENTENCE,
    lockReason: "Platform policy. There is no toggle, and no blueprint can switch it off." }),
  field({ name: "disclosureWording", path: "outbound.disclosureWording", type: "textarea", label: "Your disclosure wording",
    hint: "You may choose the words. You may not choose whether it is said." }),
  field({ name: "optOutWording", path: "outbound.optOutWording", type: "textarea", label: "Opt-out wording",
    hint: "A person must be able to end contact permanently." }),
]);

const COMPLIANCE = Object.freeze([
  field({ name: "callsMayBeRecorded", path: "compliance.callsMayBeRecorded", type: "boolean", required: true,
    label: "Calls may be recorded", hint: "Recording is not a question to leave unanswered." }),
  field({ name: "recordingDisclosure", path: "compliance.recordingDisclosure", type: "textarea",
    label: "What callers are told about recording",
    hint: "Required if calls are recorded. These are the words said aloud." }),
  field({ name: "transcriptRetention", path: "compliance.transcriptRetention", type: "select",
    label: "Transcript retention", options: options(B.RETENTION_PERIODS) }),
  field({ name: "recordingRetention", path: "compliance.recordingRetention", type: "select",
    label: "Recording retention", options: options(B.RETENTION_PERIODS) }),
  field({ name: "redactSensitiveData", path: "compliance.redactSensitiveData", type: "boolean", label: "Redact sensitive data" }),
  field({ name: "privacyPolicyReference", path: "compliance.privacyPolicyReference", label: "Privacy policy reference" }),
  locked({ name: "dncr", path: "compliance.dncr", type: "statement", label: "Do Not Call register",
    statement: "DNCR washing, suppression lists and dial authority are separate safety systems. They are not configuration and cannot be edited here." }),
]);

const INTEGRATION_FIELDS = Object.freeze([
  field({ name: "capability", type: "select", label: "Capability", required: true, options: options(B.INTEGRATION_CAPABILITIES) }),
  field({ name: "enabled", type: "boolean", label: "Enabled", required: true }),
  field({ name: "adapterRef", label: "Adapter", hint: "Left blank until an adapter exists." }),
  field({ name: "notes", type: "textarea", label: "Notes" }),
]);

// ════════════════════════════════════════════════════════════════════

const section = (spec) => Object.freeze({ fields: Object.freeze([]), repeatable: null, ...spec });

const EDITOR_SECTIONS = Object.freeze([
  section({ key: "identity", title: "Identity", blurb: "Who the business is, and the name a caller hears.", fields: IDENTITY }),
  section({
    key: "services", title: "Services", blurb: "What you do. Nothing here is a fixed list — these are yours.",
    repeatable: Object.freeze({ path: "services", itemNoun: "service", idField: "serviceId", fields: SERVICE_FIELDS,
      // Reordering IS meaningful: the assistant offers services in list order.
      reorderable: true }),
  }),
  section({ key: "serviceArea", title: "Service area", blurb: "Where you will travel, and what happens outside it.", fields: SERVICE_AREA }),
  section({ key: "hours", title: "Hours", blurb: "When you are open. Every day must say something.", fields: HOURS_OTHER, days: HOURS_DAYS }),
  section({
    key: "callHandling", title: "Call handling", blurb: "The greeting, what is collected, and when a call is transferred.",
    fields: CALL_HANDLING,
    repeatable: Object.freeze({ path: "callHandling.urgencyRules", itemNoun: "urgency rule", idField: "ruleId", fields: URGENCY_RULE_FIELDS, reorderable: true }),
  }),
  section({
    key: "knowledge", title: "Knowledge", blurb: "What the assistant may state as fact, and what it must never claim.",
    fields: KNOWLEDGE,
    repeatable: Object.freeze({ path: "knowledge.approvedFacts", itemNoun: "approved fact", idField: "factId", fields: KNOWLEDGE_FACT_FIELDS, reorderable: false }),
    secondaryRepeatable: Object.freeze({ path: "knowledge.sourceReferences", itemNoun: "reference", idField: "refId", fields: KNOWLEDGE_REFERENCE_FIELDS, reorderable: false }),
    // Ingestion does not exist, so the screen must not imply it does.
    notice: "There is no document upload. Facts are entered here and references are links you record — nothing is read, crawled or ingested from them.",
  }),
  section({ key: "booking", title: "Booking", blurb: "Appointment types and constraints.", fields: BOOKING,
    repeatable: Object.freeze({ path: "booking.appointmentTypes", itemNoun: "appointment type", idField: "typeId",
      fields: Object.freeze([
        field({ name: "typeId", label: "Type id", required: true }),
        field({ name: "label", label: "Label", required: true }),
        field({ name: "durationMinutes", type: "number", label: "Duration (minutes)", required: true }),
      ]), reorderable: true }) }),
  section({ key: "integrations", title: "Integrations", blurb: "Capabilities, not vendors.", fields: Object.freeze([]),
    repeatable: Object.freeze({ path: "integrations", itemNoun: "integration", idField: "capability", fields: INTEGRATION_FIELDS, reorderable: false }) }),
  section({ key: "voice", title: "Voice", blurb: "Language and tone. Provider details live in the operator preview.", fields: VOICE }),
  section({ key: "outbound", title: "Outbound", blurb: "Outbound calling configuration. Disclosure is not optional.", fields: OUTBOUND }),
  section({ key: "compliance", title: "Compliance", blurb: "Recording, retention and what callers are told.", fields: COMPLIANCE }),
]);

const SECTION_KEYS = Object.freeze(EDITOR_SECTIONS.map((s) => s.key));
const fieldsFor = (key) => (EDITOR_SECTIONS.find((s) => s.key === key) || { fields: [] }).fields;
const sectionFor = (key) => EDITOR_SECTIONS.find((s) => s.key === key) || null;

// ── reading and writing, by path ────────────────────────────────────

const getPath = (obj, path) =>
  String(path).split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

/** Pure: returns a NEW object. Never mutates what it was handed. */
function setPath(obj, path, value) {
  const keys = String(path).split(".");
  const out = Array.isArray(obj) ? obj.slice() : { ...obj };
  let cursor = out;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    const next = cursor[k];
    cursor[k] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : (next === undefined ? {} : next);
    cursor = cursor[k];
  }
  cursor[keys[keys.length - 1]] = value;
  return out;
}

/** The current values for one section's form, keyed by field name. */
function readSection(blueprint, key) {
  const s = sectionFor(key);
  if (!s) return {};
  const values = {};
  for (const f of s.fields) values[f.name] = f.path ? getPath(blueprint, f.path) : undefined;
  if (key === "hours") {
    const weekly = (blueprint && blueprint.hours && blueprint.hours.weekly) || {};
    for (const d of HOURS_DAYS) {
      const day = weekly[d.day] || {};
      values[d.closedName] = day.closed === true;
      values[d.openName] = day.open ?? null;
      values[d.closeName] = day.close ?? null;
    }
  }
  return values;
}

/**
 * Apply one section's submitted values. Locked fields are DROPPED rather than
 * refused, because a browser posting `identity.vertical` is not a decision a
 * person made — and the domain would refuse it anyway. A test proves both:
 * that this drops it, and that the service still refuses if it somehow arrives.
 */
function applySection(blueprint, key, values = {}) {
  const s = sectionFor(key);
  if (!s) return blueprint;
  let out = blueprint;

  for (const f of s.fields) {
    if (f.locked || !f.path) continue;
    if (!Object.prototype.hasOwnProperty.call(values, f.name)) continue;
    out = setPath(out, f.path, values[f.name]);
  }

  // Repeatables. This was missing entirely: the loop above walks only the
  // section's own fields, whose names are "legalName"-shaped, while a
  // repeatable posts "services[0].serviceId"-shaped keys. So every add,
  // removal, reorder and edit of a service, urgency rule, approved fact or
  // appointment type was posted by the browser, accepted by the server, and
  // dropped on the floor. The save returned 200 and changed nothing.
  //
  // A repeatable is only applied when the payload actually mentions it, so a
  // section saved by something that does not render the list — an older page,
  // a partial form — cannot silently empty it.
  for (const r of [s.repeatable, s.secondaryRepeatable]) {
    if (!r) continue;
    const mentioned = Object.keys(values).some((k) => k.startsWith(`${r.path}[`));
    if (!mentioned) continue;
    out = setPath(out, r.path, R.parseItems(values, r, getPath(blueprint, r.path)));
  }

  if (key === "hours") {
    const weekly = { ...((blueprint && blueprint.hours && blueprint.hours.weekly) || {}) };
    for (const d of HOURS_DAYS) {
      if (values[d.closedName] === true) weekly[d.day] = { closed: true };
      else if (values[d.openName] || values[d.closeName]) {
        weekly[d.day] = { open: values[d.openName] ?? null, close: values[d.closeName] ?? null };
      }
    }
    out = setPath(out, "hours.weekly", weekly);
  }

  return out;
}

/** Every field the editor exposes, flat — for ratchets and coverage checks. */
function allFields() {
  const flat = [];
  for (const s of EDITOR_SECTIONS) {
    for (const f of s.fields) flat.push({ section: s.key, ...f });
    for (const r of [s.repeatable, s.secondaryRepeatable]) {
      if (r) for (const f of r.fields) flat.push({ section: s.key, repeatable: r.path, ...f });
    }
  }
  return flat;
}

module.exports = {
  EDITOR_SECTIONS, SECTION_KEYS, HOURS_DAYS,
  fieldsFor, sectionFor, readSection, applySection, allFields,
  getPath, setPath, options, humanise,
};
