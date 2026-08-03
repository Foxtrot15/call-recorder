// AIDA — caller enquiry capture (M7J).
//
// ─── WHAT THIS IS ───────────────────────────────────────────────────
// The decision core behind the `create_locksmith_enquiry` tool: a CALLER's job
// enquiry, taken by the receptionist agent mid-call.
//
// NOT services/locksmith-enquiry.js. That is the landing-page pilot form, where
// a LOCKSMITH BUSINESS asks to join (businessName, missedCallHandling,
// consent…). Same word, different universe. Nothing is shared between them on
// purpose — a marketing lead and a 3am lockout must not meet in one validator.
//
// ─── THE ONE RULE THAT MATTERS ──────────────────────────────────────
// The agent may only tell a caller their details were saved if a row was
// actually written. So this module never returns an optimistic result: every
// outcome is one of OUTCOMES below, each carries `saved` as a hard boolean, and
// each carries `agentMessage` — the sentence the agent is allowed to say for
// that outcome and no other. A failure produces wording that admits the failure.
//
// ─── IDEMPOTENCY ────────────────────────────────────────────────────
// Retell does NOT retry custom functions (verified 2026-08-03), but the MODEL
// can call the tool twice in one call and a caller repeating themselves is
// normal. The key is derived here, server-side, from the provider call id plus
// a hash of the meaningful arguments:
//
//   * same enquiry twice on one call  → one row, second call reports duplicate
//   * a DIFFERENT second enquiry      → a second row, because it is a second job
//
// The key is never accepted from the request. A model-supplied idempotency key
// is a model-controlled dedupe decision, which is the same class of mistake as
// letting it supply its own client id.
//
// Pure + dep-free: hashing uses node's crypto, and every store is injected.

const crypto = require("crypto");

const ENQUIRY_VERSION = "locksmith-caller-enquiry-2026-08-03";

// Mirrors the tool schema the compiler emits and the columns the SQL creates.
// One list, so a field cannot exist in the tool and not the table.
const REQUIRED_FIELDS = Object.freeze(["caller_name", "callback_number", "suburb", "problem_description"]);
const OPTIONAL_FIELDS = Object.freeze([
  "street_address", "property_type", "service_id", "problem_description",
  "property_secure", "desired_timing", "urgency",
]);

const PROPERTY_TYPES = Object.freeze(["residential", "commercial", "automotive"]);

const BOUNDS = Object.freeze({
  caller_name: 200,
  suburb: 200,
  street_address: 300,
  problem_description: 2000,
  desired_timing: 200,
  service_id: 60,
});

/**
 * Every outcome, exhaustive. `saved` is the fact; `agentMessage` is the ONLY
 * thing the agent may say about it.
 *
 * The messages are deliberately plain. A caller who is locked out does not need
 * an apology paragraph, and an agent that dresses up a failure is an agent that
 * leaves someone waiting for a call that will never come.
 */
const OUTCOMES = Object.freeze({
  saved: {
    code: "saved",
    saved: true,
    status: 200,
    agentMessage: "Your details are recorded and the locksmith will get them.",
  },
  duplicate: {
    code: "duplicate",
    saved: true,
    status: 200,
    // Truthful either way: the row exists. Saying "already recorded" stops the
    // agent reading the whole thing back a second time.
    agentMessage: "That is already recorded — no need to repeat it.",
  },
  invalid: {
    code: "invalid",
    saved: false,
    status: 200,
    agentMessage: "I could not record that yet — something was missing or unclear. Ask the caller for what is missing and try once more.",
  },
  unavailable: {
    code: "unavailable",
    saved: false,
    status: 200,
    agentMessage: "I could not save that just now. Tell the caller honestly that you could not record it and that they should ring the locksmith directly.",
  },
  failed: {
    code: "failed",
    saved: false,
    status: 200,
    agentMessage: "I could not save that just now. Tell the caller honestly that you could not record it and that they should ring the locksmith directly.",
  },
});

// ── Normalisation ───────────────────────────────────────────────────

function text(raw, max) {
  if (typeof raw !== "string") return "";
  // Control characters are never speech; they are how structure gets smuggled
  // into a value that will later be rendered somewhere.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
  return max && cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned;
}

/** Tri-state: true, false, or null when the caller never said. */
function tribool(raw) {
  if (raw === true || raw === "true" || raw === "yes") return true;
  if (raw === false || raw === "false" || raw === "no") return false;
  return null;
}

function pick(raw, allowed) {
  const value = text(raw, 60).toLowerCase();
  return allowed.includes(value) ? value : null;
}

/**
 * Validate and normalise the tool arguments.
 *
 * The callback number is normalised to canonical E.164 through the SAME gate
 * every other number in the product uses — a number AIDA cannot ring is worse
 * than no number, and a second normaliser here would be a second idea of what
 * is dialable.
 */
function validateEnquiryArgs(args, deps = {}) {
  const normaliseAuNumber = deps.normaliseAuNumber || require("./locksmith-profile").normaliseAuNumber;
  const serviceIds = deps.serviceIds || require("./locksmith-profile-schema").SERVICE_IDS;
  const urgencies = deps.urgencies || require("./locksmith-profile-schema").URGENCY_CLASSIFICATIONS;

  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const errors = [];

  const values = {
    caller_name: text(source.caller_name, BOUNDS.caller_name),
    suburb: text(source.suburb, BOUNDS.suburb),
    problem_description: text(source.problem_description, BOUNDS.problem_description),
    street_address: text(source.street_address, BOUNDS.street_address) || null,
    desired_timing: text(source.desired_timing, BOUNDS.desired_timing) || null,
    property_type: pick(source.property_type, PROPERTY_TYPES),
    service_id: pick(source.service_id, serviceIds),
    urgency: pick(source.urgency, urgencies),
    property_secure: tribool(source.property_secure),
    callback_number: null,
  };

  for (const field of ["caller_name", "suburb", "problem_description"]) {
    if (!values[field]) errors.push({ field, code: "missing", message: `${field} is required.` });
  }

  const rawNumber = typeof source.callback_number === "string" ? source.callback_number : "";
  if (!rawNumber.trim()) {
    errors.push({ field: "callback_number", code: "missing", message: "callback_number is required." });
  } else {
    const canonical = normaliseAuNumber(rawNumber);
    if (!canonical) {
      errors.push({ field: "callback_number", code: "not_dialable", message: "callback_number is not a dialable Australian number." });
    } else {
      values.callback_number = canonical;
    }
  }

  return { ok: errors.length === 0, values, errors };
}

// ── Idempotency ─────────────────────────────────────────────────────

/**
 * Derive the key. Server-side only, never from the request.
 *
 * Built from the fields that identify the JOB, not from every field: a caller
 * adding "and I'm around the back" to the description is clarifying one job,
 * not raising a second. Timing, urgency and secure-state are excluded for the
 * same reason — they are the fields most likely to be refined mid-call.
 */
function deriveIdempotencyKey({ providerCallId, values }) {
  const identity = [
    String(providerCallId || "no-call"),
    values.callback_number || "",
    (values.caller_name || "").toLowerCase(),
    (values.suburb || "").toLowerCase(),
    (values.service_id || ""),
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 48);
}

// ── The capture decision ────────────────────────────────────────────

/**
 * Capture one enquiry.
 *
 * @param {object}   args        the tool arguments, untrusted
 * @param {object}   context     { clientId, environment, providerCallId,
 *                                 providerAgentId, profileVersion } — resolved
 *                               by the CALLER from the verified request, never
 *                               taken from `args`
 * @param {Function} deps.store  async ({row}) => { ok, created, id } | throws
 *
 * Returns { outcome, saved, enquiryId, agentMessage, errors } — never throws.
 * A tool that throws is a tool that leaves the agent guessing, and a guessing
 * agent tells the caller something comforting.
 */
async function captureEnquiry({ args, context = {}, deps = {} } = {}) {
  const logger = deps.logger || console;
  const store = deps.store;

  const result = (outcome, extra = {}) =>
    Object.freeze({
      version: ENQUIRY_VERSION,
      outcome: outcome.code,
      saved: outcome.saved,
      agentMessage: outcome.agentMessage,
      enquiryId: null,
      errors: [],
      ...extra,
    });

  if (!context.clientId) {
    // No tenant means no row can be written safely. Refused rather than
    // defaulted: a defaulted client id files a stranger's job under somebody.
    logger.error("locksmith.enquiry.no_client");
    return result(OUTCOMES.unavailable);
  }
  if (typeof store !== "function") {
    logger.error("locksmith.enquiry.no_store");
    return result(OUTCOMES.unavailable);
  }

  const validated = validateEnquiryArgs(args, deps);
  if (!validated.ok) {
    // Field NAMES only. The values are a member of the public's name, number
    // and address, and this line goes to a log aggregator.
    logger.log(`locksmith.enquiry.invalid fields=${validated.errors.map((e) => e.field).join(",")}`);
    return result(OUTCOMES.invalid, { errors: validated.errors });
  }

  const idempotencyKey = deriveIdempotencyKey({ providerCallId: context.providerCallId, values: validated.values });

  const row = {
    client_id: context.clientId,
    environment: context.environment || "dev",
    source: "voice_agent",
    provider: "retell",
    provider_call_id: context.providerCallId || null,
    provider_agent_id: context.providerAgentId || null,
    profile_version: Number.isInteger(context.profileVersion) ? context.profileVersion : null,
    ...validated.values,
    idempotency_key: idempotencyKey,
  };

  try {
    const stored = await store({ row });
    if (!stored || stored.ok !== true) {
      logger.error(`locksmith.enquiry.store_refused client=${context.clientId}`);
      return result(OUTCOMES.failed);
    }
    const outcome = stored.created === false ? OUTCOMES.duplicate : OUTCOMES.saved;
    logger.log(
      `locksmith.enquiry.${outcome.code} client=${context.clientId} env=${row.environment} ` +
        `call=${context.providerCallId || "-"} urgency=${row.urgency || "-"}`
    );
    return result(outcome, { enquiryId: stored.id || null });
  } catch (err) {
    logger.error(`locksmith.enquiry.store_failed client=${context.clientId} err=${err && err.message}`);
    return result(OUTCOMES.failed);
  }
}

/**
 * The JSON body returned to Retell.
 *
 * `saved` is the machine fact and `message` is what the agent may say. Both are
 * present so the prompt's rule ("only say it is saved when saved is true") can
 * be followed without the model having to interpret prose.
 *
 * Deliberately carries NO phone number, no address and no enquiry contents —
 * the response goes into the model's context, and echoing the caller's details
 * back there buys nothing the agent does not already have from the conversation.
 */
function toToolResponse(captureResult) {
  return {
    saved: captureResult.saved === true,
    outcome: captureResult.outcome,
    message: captureResult.agentMessage,
    ...(captureResult.enquiryId ? { reference: captureResult.enquiryId } : {}),
    ...(captureResult.errors && captureResult.errors.length
      ? { missing: captureResult.errors.map((e) => e.field) }
      : {}),
  };
}

module.exports = {
  ENQUIRY_VERSION,
  OUTCOMES,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  PROPERTY_TYPES,
  BOUNDS,
  validateEnquiryArgs,
  deriveIdempotencyKey,
  captureEnquiry,
  toToolResponse,
};
