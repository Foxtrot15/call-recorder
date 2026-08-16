// AIDA VOICE CONFIGURATION — what a caller can mean (P39, P39A).
//
//   CONFIGURATION_INTENTS / CONVERSATIONAL_INTENTS / ALL_INTENTS
//   INTENT_SPEC     risk, section, payload contract, and why
//   validateIntentPayload(intent, payload) -> { ok, errors[] }
//   describeIntent(intent, payload)        -> a sentence a person can check
//
// ── WHY A CLOSED VOCABULARY ─────────────────────────────────────────
// The tempting design is one operation — `{ path, value }` — and a language
// model that fills it in. That makes every mishearing a valid operation, and it
// makes "set metadata.status to active" a sentence the system is willing to
// parse. So the conversational contract is a closed list of things a caller may
// MEAN, each with a validated payload, and anything outside it is
// UNKNOWN_INTENT — which leads to a question, never to a guess.
//
// These compile DOWN to config-patch primitives later (voice-patch-compiler.js).
// The patch layer stays the single write contract; this is the layer that
// decides whether a sentence deserves to become one.
//
// ── RISK IS DECLARED PER INTENT, NOT INFERRED ───────────────────────
// Each intent carries the risk class that decides whether an explicit spoken
// confirmation is required. Removing a service, changing where calls transfer,
// changing recording wording and touching outbound are HIGH — because the
// person who discovers a mishearing is a customer being told no, or a stranger
// being telephoned, and neither of them can see the review screen.
//
// This module imports the blueprint's own vocabularies so a new urgency level
// is understood here the day it is added there, and imports nothing else.

const B = require("../client-blueprint");

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isArr = (v) => Array.isArray(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBool = (v) => typeof v === "boolean";

// ── the field validators, small and named ───────────────────────────

const str = (name, { max = 400 } = {}) => (v, errs) => {
  if (!isStr(v)) errs.push({ field: name, message: `${name} is required` });
  else if (v.length > max) errs.push({ field: name, message: `${name} is longer than ${max} characters` });
};
const optionalStr = (name, { max = 2000 } = {}) => (v, errs) => {
  if (v === undefined || v === null) return;
  if (!isStr(v)) errs.push({ field: name, message: `${name} must be text` });
  else if (v.length > max) errs.push({ field: name, message: `${name} is longer than ${max} characters` });
};
const oneOf = (name, values) => (v, errs) => {
  if (!values.includes(v)) errs.push({ field: name, message: `${name} must be one of: ${values.join(", ")}` });
};
const optionalOneOf = (name, values) => (v, errs) => {
  if (v === undefined || v === null) return;
  if (!values.includes(v)) errs.push({ field: name, message: `${name} must be one of: ${values.join(", ")}` });
};
const strList = (name, { max = 60 } = {}) => (v, errs) => {
  if (v === undefined || v === null) return;
  if (!isArr(v)) { errs.push({ field: name, message: `${name} must be a list` }); return; }
  if (v.length > max) errs.push({ field: name, message: `${name} has more than ${max} entries` });
  v.forEach((x, i) => { if (!isStr(x)) errs.push({ field: `${name}[${i}]`, message: "must be text" }); });
};
const requiredStrList = (name, opts) => (v, errs) => {
  if (!isArr(v) || v.length === 0) { errs.push({ field: name, message: `${name} is required and must have at least one entry` }); return; }
  strList(name, opts)(v, errs);
};
const time = (name) => (v, errs) => {
  if (!isStr(v) || !TIME.test(v)) errs.push({ field: name, message: `${name} must be a 24-hour time such as 16:00` });
};
const phone = (name) => (v, errs) => {
  if (!isStr(v) || !E164.test(v)) errs.push({ field: name, message: `${name} must be a full international number such as +61355500399` });
};
const bool = (name) => (v, errs) => {
  if (!isBool(v)) errs.push({ field: name, message: `${name} must be yes or no` });
};

/** Opening periods for one day, or an explicit "closed". */
const periods = (name) => (v, errs) => {
  if (!isArr(v)) { errs.push({ field: name, message: `${name} must be a list of periods` }); return; }
  if (v.length === 0) { errs.push({ field: name, message: `${name} is empty — say "closed" explicitly instead` }); return; }
  if (v.length > 4) errs.push({ field: name, message: `${name} has more than four periods in one day` });
  v.forEach((p, i) => {
    if (!isObj(p)) { errs.push({ field: `${name}[${i}]`, message: "must be a period" }); return; }
    time(`${name}[${i}].start`)(p.start, errs);
    time(`${name}[${i}].end`)(p.end, errs);
    if (TIME.test(p.start || "") && TIME.test(p.end || "") && p.start >= p.end) {
      errs.push({ field: `${name}[${i}]`, message: `opens at ${p.start} and closes at ${p.end}` });
    }
  });
};

// ── the intents ─────────────────────────────────────────────────────

const intent = (spec) => Object.freeze({ risk: "medium", ...spec, fields: Object.freeze(spec.fields || {}) });

/**
 * Every configuration intent. `section` is the blueprint area it will touch,
 * used by the planner to know what has been covered and by the compiler to know
 * where the patch lands.
 */
const INTENT_SPEC = Object.freeze({
  // ── hours ──
  SET_BUSINESS_HOURS: intent({
    section: "hours", risk: "medium",
    why: "Changes when a caller is told the business is open.",
    fields: {
      day: oneOf("day", [...B.DAYS]),
      periods: periods("periods"),
    },
  }),
  SET_DAY_CLOSED: intent({
    section: "hours", risk: "medium",
    why: "Says a day is closed, which is an answer rather than an omission.",
    fields: { day: oneOf("day", [...B.DAYS]) },
  }),
  SET_AFTER_HOURS_POLICY: intent({
    section: "hours", risk: "medium",
    why: "Decides what happens to a call outside opening hours.",
    fields: {
      available: bool("available"),
      policy: optionalStr("policy"),
    },
  }),

  // ── services ──
  ADD_SERVICE: intent({
    section: "services", risk: "medium",
    why: "Adds work the assistant will accept.",
    fields: {
      name: str("name", { max: 120 }),
      aliases: strList("aliases"),
      urgency: optionalOneOf("urgency", [...B.URGENCY_LEVELS]),
      qualificationRequirements: strList("qualificationRequirements"),
      exclusions: strList("exclusions"),
    },
  }),
  UPDATE_SERVICE: intent({
    section: "services", risk: "medium",
    why: "Changes how existing work is described or classified.",
    fields: {
      serviceRef: str("serviceRef", { max: 120 }),
      name: optionalStr("name", { max: 120 }),
      urgency: optionalOneOf("urgency", [...B.URGENCY_LEVELS]),
      aliases: strList("aliases"),
      enabled: (v, errs) => { if (v !== undefined && !isBool(v)) errs.push({ field: "enabled", message: "must be yes or no" }); },
    },
  }),
  REMOVE_SERVICE: intent({
    // HIGH: the person who finds out is a customer being told no by a business
    // that does the job.
    section: "services", risk: "high",
    why: "Stops the assistant offering work the business may still do.",
    fields: { serviceRef: str("serviceRef", { max: 120 }) },
  }),

  // ── service area ──
  SET_SERVICE_AREA: intent({
    section: "serviceArea", risk: "medium",
    why: "Says where the business will travel.",
    fields: {
      suburbs: strList("suburbs"),
      regions: strList("regions"),
      postcodes: strList("postcodes"),
    },
  }),
  EXCLUDE_SERVICE_AREA: intent({
    // HIGH: refusing an area is refusing revenue, and one misheard suburb name
    // is a different suburb.
    section: "serviceArea", risk: "high",
    why: "Stops the assistant accepting work in a place.",
    fields: { suburbs: requiredStrList("suburbs") },
  }),

  // ── call handling ──
  SET_GREETING: intent({
    section: "callHandling", risk: "medium",
    why: "Changes the first words a caller hears.",
    fields: { greeting: str("greeting", { max: 400 }) },
  }),
  SET_CALLBACK_POLICY: intent({
    section: "callHandling", risk: "medium",
    why: "Decides what the assistant promises about calling back.",
    fields: { policy: str("policy", { max: 1000 }) },
  }),
  SET_TRANSFER_RULE: intent({
    // HIGH: a wrong number here is a ringing telephone nobody owns.
    section: "callHandling", risk: "high",
    why: "Changes where an urgent call is sent.",
    fields: {
      number: phone("number"),
      whichNumber: optionalOneOf("whichNumber", ["primary", "backup"]),
    },
  }),
  SET_URGENCY_RULE: intent({
    // HIGH: emergency classification decides whether somebody is telephoned at
    // 3am, or is not.
    section: "callHandling", risk: "high",
    why: "Changes what counts as an emergency.",
    fields: {
      when: str("when", { max: 300 }),
      level: oneOf("level", [...B.URGENCY_LEVELS]),
      action: oneOf("action", [...B.URGENCY_ACTIONS]),
    },
  }),
  SET_CALLER_INFORMATION: intent({
    section: "callHandling", risk: "low",
    why: "Changes what the assistant asks every caller for.",
    fields: { collect: requiredStrList("collect") },
  }),

  // ── knowledge and pricing ──
  ADD_APPROVED_FACT: intent({
    section: "knowledge", risk: "medium",
    why: "Adds something the assistant may state as fact.",
    fields: { statement: str("statement", { max: 1000 }) },
  }),
  REMOVE_APPROVED_FACT: intent({
    section: "knowledge", risk: "medium",
    why: "Stops the assistant stating something.",
    fields: { factRef: str("factRef", { max: 1000 }) },
  }),
  SET_PRICING_POLICY: intent({
    section: "knowledge", risk: "medium",
    why: "Decides whether and how the assistant discusses money.",
    fields: {
      disclosure: oneOf("disclosure", [...B.PRICING_DISCLOSURE]),
      wording: optionalStr("wording"),
    },
  }),

  // ── booking, integrations, voice ──
  SET_BOOKING_SETTING: intent({
    section: "booking", risk: "medium",
    why: "Decides whether the assistant takes bookings.",
    fields: {
      enabled: bool("enabled"),
      capabilityTarget: optionalOneOf("capabilityTarget", [...B.INTEGRATION_CAPABILITIES]),
    },
  }),
  SET_INTEGRATION_REQUIREMENT: intent({
    section: "integrations", risk: "medium",
    why: "Says which capability the business wants connected.",
    fields: {
      capability: oneOf("capability", [...B.INTEGRATION_CAPABILITIES]),
      enabled: bool("enabled"),
    },
  }),
  SET_VOICE_PREFERENCE: intent({
    section: "voice", risk: "low",
    why: "Changes how the assistant sounds, provider-independently.",
    fields: {
      tone: optionalStr("tone", { max: 200 }),
      language: optionalStr("language", { max: 40 }),
    },
  }),

  // ── compliance and outbound ──
  SET_COMPLIANCE_WORDING: intent({
    // HIGH: what a caller is told about recording is a legal position, not a
    // preference.
    section: "compliance", risk: "high",
    why: "Changes what callers are told about recording and privacy.",
    fields: { recordingDisclosure: str("recordingDisclosure", { max: 1000 }) },
  }),
  PROPOSE_OUTBOUND_SETTING: intent({
    // HIGH: outbound is calling strangers. Note that this only ever proposes
    // BUSINESS configuration — it cannot enable calling, and voice-policy.js
    // refuses any attempt to use it for that.
    section: "outbound", risk: "high",
    why: "Describes outbound calling configuration. It cannot start any calling.",
    fields: {
      proposition: optionalStr("proposition"),
      optOutWording: optionalStr("optOutWording"),
    },
  }),

  // ── identity ──
  SET_BUSINESS_IDENTITY: intent({
    section: "identity", risk: "medium",
    why: "Changes the business's own details.",
    fields: {
      legalName: optionalStr("legalName", { max: 200 }),
      tradingName: optionalStr("tradingName", { max: 200 }),
      assistantName: optionalStr("assistantName", { max: 100 }),
    },
  }),
});

const CONFIGURATION_INTENTS = Object.freeze(Object.keys(INTENT_SPEC));

/**
 * Intents that steer the conversation rather than change configuration. They
 * carry no payload contract because they carry no configuration.
 */
const CONVERSATIONAL_INTENTS = Object.freeze([
  "CONFIRM",
  "REJECT",
  "CORRECT",
  "UNDO_PROPOSED_CHANGE",
  "ASK_WHAT_IS_CONFIGURED",
  "ASK_WHAT_WILL_CHANGE",
  "ANSWER_CLARIFICATION",
  "FINISH_CONFIGURATION",
  "CANCEL",
  "SMALL_TALK",
]);

/**
 * The one that matters most. A sentence nobody modelled becomes this, and this
 * leads to a question. It never leads to a patch, and a ratchet asserts the
 * compiler refuses it.
 */
const UNKNOWN_INTENT = "UNKNOWN_INTENT";

/** Requests the platform will not carry out at all. Named so refusal is specific. */
const REFUSED_INTENTS = Object.freeze([
  "REQUEST_APPROVAL",
  "REQUEST_ACTIVATION",
  "REQUEST_PROVISIONING",
  "REQUEST_CALLING",
  "REQUEST_DISABLE_AI_DISCLOSURE",
  "REQUEST_BYPASS_AUTHORITY",
  "REQUEST_OTHER_TENANT",
]);

const ALL_INTENTS = Object.freeze([
  ...CONFIGURATION_INTENTS, ...CONVERSATIONAL_INTENTS, ...REFUSED_INTENTS, UNKNOWN_INTENT,
]);

const isConfigurationIntent = (i) => CONFIGURATION_INTENTS.includes(i);
const riskOf = (i) => (INTENT_SPEC[i] ? INTENT_SPEC[i].risk : "high");
const sectionOf = (i) => (INTENT_SPEC[i] ? INTENT_SPEC[i].section : null);

/**
 * Validate a payload against its intent's contract. Unknown keys are an error
 * rather than ignored: a payload carrying `status` or `clientId` is a payload
 * somebody built wrong, and silently dropping it hides that.
 */
function validateIntentPayload(intentName, payload) {
  const spec = INTENT_SPEC[intentName];
  if (!spec) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze([{ field: "intent", message: `${intentName} carries no configuration payload contract` }]),
    });
  }
  if (!isObj(payload)) {
    return Object.freeze({ ok: false, errors: Object.freeze([{ field: "payload", message: "a payload object is required" }]) });
  }

  const errors = [];
  for (const [field, check] of Object.entries(spec.fields)) check(payload[field], errors);

  const allowed = Object.keys(spec.fields);
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) errors.push({ field: key, message: `${intentName} has no field "${key}"` });
  }

  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

/** A sentence a person can check against what they said. */
function describeIntent(intentName, payload = {}) {
  const p = payload || {};
  switch (intentName) {
    case "SET_BUSINESS_HOURS": {
      const list = (p.periods || []).map((x) => `${x.start}-${x.end}`).join(", ");
      return `${cap(p.day)} hours become ${list}`;
    }
    case "SET_DAY_CLOSED": return `${cap(p.day)} becomes closed`;
    case "SET_AFTER_HOURS_POLICY":
      return p.available ? "Calls are answered after hours" : "Calls are not answered after hours";
    case "ADD_SERVICE": return `Add "${p.name}"${p.urgency ? ` as ${p.urgency}` : ""}`;
    case "UPDATE_SERVICE": return `Change "${p.serviceRef}"${p.urgency ? ` to ${p.urgency}` : ""}`;
    case "REMOVE_SERVICE": return `Stop offering "${p.serviceRef}"`;
    case "SET_SERVICE_AREA": return `Service area becomes ${[...(p.suburbs || []), ...(p.regions || [])].join(", ")}`;
    case "EXCLUDE_SERVICE_AREA": return `Stop servicing ${(p.suburbs || []).join(", ")}`;
    case "SET_GREETING": return `The greeting becomes "${p.greeting}"`;
    case "SET_CALLBACK_POLICY": return `Callback policy becomes "${p.policy}"`;
    case "SET_TRANSFER_RULE": return `Transfer ${p.whichNumber === "backup" ? "backup " : ""}calls to ${p.number}`;
    case "SET_URGENCY_RULE": return `"${p.when}" is treated as ${p.level}`;
    case "SET_CALLER_INFORMATION": return `Always collect ${(p.collect || []).join(", ")}`;
    case "ADD_APPROVED_FACT": return `The assistant may say "${p.statement}"`;
    case "REMOVE_APPROVED_FACT": return `Stop saying "${p.factRef}"`;
    case "SET_PRICING_POLICY": return `Pricing policy becomes "${String(p.disclosure).replace(/_/g, " ")}"`;
    case "SET_BOOKING_SETTING": return p.enabled ? "Take bookings" : "Do not take bookings";
    case "SET_INTEGRATION_REQUIREMENT": return `${p.enabled ? "Enable" : "Disable"} ${p.capability}`;
    case "SET_VOICE_PREFERENCE": return `Voice ${[p.tone && `tone ${p.tone}`, p.language && `language ${p.language}`].filter(Boolean).join(", ")}`;
    case "SET_COMPLIANCE_WORDING": return `Callers are told "${p.recordingDisclosure}"`;
    case "PROPOSE_OUTBOUND_SETTING": return "Outbound calling configuration";
    case "SET_BUSINESS_IDENTITY":
      return `Business details: ${[p.legalName, p.tradingName, p.assistantName].filter(Boolean).join(", ")}`;
    default: return intentName;
  }
}

const cap = (s) => (isStr(s) ? s.charAt(0).toUpperCase() + s.slice(1) : String(s));

/**
 * The same change, as a VERB PHRASE that completes "I'll …".
 *
 * describeIntent() produces a noun phrase for the written summary — "Saturday
 * hours become 09:00-16:00" — which reads correctly in a list and produces
 * "I'll Saturday hours become…" when spoken. Two forms, because a review
 * screen and a telephone need different grammar, and gluing a prefix onto the
 * wrong one is how an assistant sounds broken.
 */
function describeIntentSpoken(intentName, payload = {}) {
  const p = payload || {};
  switch (intentName) {
    case "SET_BUSINESS_HOURS": {
      const list = (p.periods || []).map((x) => `${spokenTime(x.start)} to ${spokenTime(x.end)}`).join(", ");
      return `change ${cap(p.day)} to ${list}`;
    }
    case "SET_DAY_CLOSED": return `mark ${cap(p.day)} as closed`;
    case "SET_AFTER_HOURS_POLICY":
      return p.available ? "have calls answered after hours" : "stop answering calls after hours";
    case "ADD_SERVICE": return `add "${p.name}"${p.urgency ? ` as ${String(p.urgency).replace(/_/g, " ")}` : ""}`;
    case "UPDATE_SERVICE": return `update "${p.serviceRef}"${p.urgency ? ` to ${String(p.urgency).replace(/_/g, " ")}` : ""}`;
    case "REMOVE_SERVICE": return `stop offering "${p.serviceRef}"`;
    case "SET_SERVICE_AREA": return `add ${[...(p.suburbs || []), ...(p.regions || [])].join(", ")} to your service area`;
    case "EXCLUDE_SERVICE_AREA": return `stop servicing ${(p.suburbs || []).join(", ")}`;
    case "SET_GREETING": return `change the greeting to "${p.greeting}"`;
    case "SET_CALLBACK_POLICY": return `set the callback policy to "${p.policy}"`;
    case "SET_TRANSFER_RULE": return `send ${p.whichNumber === "backup" ? "backup " : ""}transfers to ${p.number}`;
    case "SET_URGENCY_RULE": return `treat "${p.when}" as ${String(p.level).replace(/_/g, " ")}`;
    case "SET_CALLER_INFORMATION": return `always take ${(p.collect || []).join(", ")}`;
    case "ADD_APPROVED_FACT": return `let the assistant say "${p.statement}"`;
    case "REMOVE_APPROVED_FACT": return `stop the assistant saying "${p.factRef}"`;
    case "SET_PRICING_POLICY": return p.disclosure === "never_discuss"
      ? "stop discussing pricing"
      : `change the pricing policy to "${String(p.disclosure).replace(/_/g, " ")}"`;
    case "SET_BOOKING_SETTING": return p.enabled ? "take bookings" : "stop taking bookings";
    case "SET_INTEGRATION_REQUIREMENT": return `${p.enabled ? "enable" : "disable"} ${p.capability}`;
    case "SET_VOICE_PREFERENCE": return `set the voice ${[p.tone && `tone to ${p.tone}`, p.language && `language to ${p.language}`].filter(Boolean).join(" and ")}`;
    case "SET_COMPLIANCE_WORDING": return `tell callers "${p.recordingDisclosure}"`;
    case "PROPOSE_OUTBOUND_SETTING": return "update the outbound configuration";
    case "SET_BUSINESS_IDENTITY":
      return `update the business details to ${[p.legalName, p.tradingName, p.assistantName].filter(Boolean).join(", ")}`;
    default: return String(intentName).toLowerCase().replace(/_/g, " ");
  }
}

/** "16:00" spoken as "4pm". A telephone does not read 24-hour clocks aloud well. */
function spokenTime(hhmm) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return String(hhmm);
  const h = Number(m[1]);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m[2] === "00" ? `${hour}${suffix}` : `${hour}:${m[2]}${suffix}`;
}

module.exports = {
  INTENT_SPEC,
  CONFIGURATION_INTENTS, CONVERSATIONAL_INTENTS, REFUSED_INTENTS, ALL_INTENTS, UNKNOWN_INTENT,
  validateIntentPayload, describeIntent, describeIntentSpoken, spokenTime,
  isConfigurationIntent, riskOf, sectionOf,
};
