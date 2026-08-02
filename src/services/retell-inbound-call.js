// AIDA — Retell inbound-call webhook decision core (M7F-A).
//
// ─── WHAT THIS ANSWERS ──────────────────────────────────────────────
// Retell fires this webhook BEFORE a caller is answered. Our response body
// configures that specific call: which dynamic variables the agent gets, which
// agent takes it, or whether it is rejected outright.
//
// Verified against docs.retellai.com/features/inbound-call-webhook, reviewed
// 2026-08-02:
//
//   REQUEST   { event: "call_inbound", event_timestamp,
//               call_inbound: { agent_id, agent_version, from_number,
//                               to_number, custom_sip_headers } }
//
//   RESPONSE  { call_inbound: { dynamic_variables?, metadata?,
//                               override_agent_id?, override_agent_version?,
//                               reject?, agent_override? } }
//
//   10-second timeout, retried up to 3 times. If every attempt fails Retell
//   falls back to the number's configured inbound agent, and if there is none
//   it DISCONNECTS THE CALL.
//
// That fallback shapes the whole design: a slow or throwing webhook does not
// merely lose runtime context, it can drop a locksmith's customer. So nothing
// here does I/O, and nothing here can throw into the response path.
//
// ─── WHAT "FAIL CLOSED" MEANS HERE ──────────────────────────────────
// It is worth being precise, because the obvious reading is wrong.
//
// The danger is not "a call we cannot attribute". The danger is EMITTING
// VARIABLES WE CANNOT ATTRIBUTE — sending client B's transfer number to client
// A's caller would route somebody's emergency to a stranger, silently, and the
// call would sound completely normal.
//
// So the default failure mode is WITHHOLD, not REJECT: return a valid empty
// response, let the number's bound agent answer with its compiled profile, and
// send no runtime values at all. A caller reaching a receptionist that lacks
// on-call context is a degraded call. A caller hearing a disconnect is a lost
// customer, and a caller being given another business's transfer number is
// worse than both.
//
// REJECT remains available and is a deliberate configuration choice, not a
// default. Both are tested.
//
// Pure + dep-free. No database, no provider call, no clock beyond an injected
// one. See routes/retell-inbound-webhook.js for the transport.

const dynamicVars = require("./retell-dynamic-variables");

const INBOUND_VERSION = "retell-inbound-call-2026-08-02";

const INBOUND_EVENT = "call_inbound";

/** What to do when the call cannot be attributed to a known client. */
const FAILURE_MODES = Object.freeze({
  withhold: "withhold_variables",
  reject: "reject_call",
});

const REJECT_CODES = Object.freeze({
  notInbound: "not_an_inbound_event",
  malformed: "malformed_inbound_payload",
  missingAgent: "missing_agent_id",
  unknownAgent: "unknown_agent",
  unknownClient: "unknown_client",
  notProvisioned: "client_not_provisioned",
  resolverFailed: "resolver_failed",
});

// A provider payload is not ours. Bound every string we read from it.
const MAX_ID_LENGTH = 200;
const MAX_NUMBER_LENGTH = 40;

function boundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/**
 * Validate the documented inbound request shape.
 *
 * Deliberately strict about `event`: this route must never be handed a
 * call_ended payload and quietly answer it with an inbound response body.
 */
function validateInboundRequest(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: REJECT_CODES.malformed, message: "the inbound webhook body was not an object" };
  }
  if (parsed.event !== INBOUND_EVENT) {
    return {
      ok: false,
      code: REJECT_CODES.notInbound,
      message: `expected event "${INBOUND_EVENT}", got ${JSON.stringify(String(parsed.event || "")).slice(0, 40)}`,
    };
  }
  const inbound = parsed.call_inbound;
  if (!inbound || typeof inbound !== "object" || Array.isArray(inbound)) {
    return { ok: false, code: REJECT_CODES.malformed, message: "call_inbound was missing or not an object" };
  }

  const agentId = boundedString(inbound.agent_id, MAX_ID_LENGTH);
  if (!agentId) {
    return { ok: false, code: REJECT_CODES.missingAgent, message: "call_inbound.agent_id is required" };
  }

  return {
    ok: true,
    request: Object.freeze({
      agentId,
      // Documented as an integer; anything else is dropped rather than coerced.
      agentVersion: Number.isInteger(inbound.agent_version) ? inbound.agent_version : null,
      // E.164 as the provider sends it. CANONICAL, machine-facing, and never
      // handed to the model — only its derived spoken form ever is.
      fromNumber: boundedString(inbound.from_number, MAX_NUMBER_LENGTH),
      toNumber: boundedString(inbound.to_number, MAX_NUMBER_LENGTH),
      eventTimestamp: Number.isFinite(parsed.event_timestamp) ? parsed.event_timestamp : null,
      // Present in the contract and deliberately NOT read. SIP headers are
      // attacker-influenceable on some carriers, and nothing here needs them.
      hasCustomSipHeaders: Boolean(inbound.custom_sip_headers && typeof inbound.custom_sip_headers === "object"),
    }),
  };
}

/**
 * Decide the response for one inbound call.
 *
 * @param {object}   parsed          the parsed request body
 * @param {Function} resolveContext  async (request) => context | null. Injected,
 *                                   so this module needs no database. The
 *                                   context is AIDA's own resolved state:
 *                                   { clientId, transferPrimary, transferBackup,
 *                                     businessStatus, onCallState, callKind }
 * @param {string}   failureMode     FAILURE_MODES.*
 * @param {boolean}  includeCallerNumber  send caller_number_spoken. Default off:
 *                                   the agent only needs it if the prompt asks
 *                                   it to read the caller's number back.
 */
async function decideInboundCall({
  parsed,
  resolveContext,
  failureMode = FAILURE_MODES.withhold,
  includeCallerNumber = false,
  logger = console,
} = {}) {
  const validated = validateInboundRequest(parsed);
  if (!validated.ok) {
    return refuse(validated.code, validated.message, failureMode);
  }
  const request = validated.request;

  let context = null;
  if (typeof resolveContext === "function") {
    try {
      context = await resolveContext(request);
    } catch (err) {
      // A resolver that throws must not become a 500. Retell would retry three
      // times and then drop the caller; a withheld-variable answer keeps the
      // call alive on the bound agent.
      logger.error(`retell.inbound.resolver_failed code=${REJECT_CODES.resolverFailed}`);
      return refuse(REJECT_CODES.resolverFailed, "the client resolver failed", failureMode);
    }
  }

  if (!context || typeof context !== "object") {
    return refuse(REJECT_CODES.unknownClient, "no client is bound to this agent", failureMode);
  }
  if (!context.clientId) {
    return refuse(REJECT_CODES.notProvisioned, "the resolved context carries no client id", failureMode);
  }

  // ── Build the variables through the SHARED path ──────────────────
  // Not a parallel builder: this is the same function the sandbox uses, so the
  // allow-list, the string coercion, the runtime-vs-default split and the
  // derivation of every spoken form are exercised here exactly as they are
  // everywhere else. The spoken forms are DERIVED inside it and cannot be
  // supplied, so no caller of this module can emit a number in E.164 form to
  // the model.
  const built = dynamicVars.buildInboundCallVariables({
    transferPrimary: context.transferPrimary || null,
    transferBackup: context.transferBackup || null,
    businessStatus: context.businessStatus || null,
    onCallState: context.onCallState || null,
    callKind: context.callKind || null,
    // Only ever the SPOKEN form leaves this function — buildInboundCallVariables
    // does not emit a canonical caller number at all.
    callerNumber: includeCallerNumber ? request.fromNumber : null,
  });

  if (!built.ok) {
    // The shared validator refused something. Withhold rather than send a
    // partially-validated set: a half-correct transfer number is the worst
    // possible outcome.
    logger.error(`retell.inbound.variables_rejected count=${built.errors.length}`);
    return refuse(REJECT_CODES.notProvisioned, "the resolved variables failed shared validation", failureMode);
  }

  // Belt and braces: an unresolved "{{runtime}}" placeholder would be read
  // aloud verbatim by the agent. Never send one.
  const unresolved = dynamicVars.findUnresolvedRuntimeValues(built.variables);
  if (unresolved.length) {
    logger.error(`retell.inbound.unresolved_placeholders keys=${unresolved.join(",")}`);
    return refuse(REJECT_CODES.notProvisioned, "unresolved runtime placeholders", failureMode);
  }

  const response = dynamicVars.buildInboundWebhookResponse({
    variables: built.variables,
    // Stored against the call and NEVER injected into the prompt — which is
    // exactly why the client id belongs here and not in a dynamic variable.
    metadata: { aida_client_id: String(context.clientId), aida_environment: String(context.environment || "dev") },
    overrideAgentId: context.overrideAgentId || null,
    reject: false,
  });

  if (!response.ok) {
    logger.error("retell.inbound.response_build_failed");
    return refuse(REJECT_CODES.notProvisioned, "the response failed validation", failureMode);
  }

  return Object.freeze({
    ok: true,
    status: 200,
    body: response.response,
    clientId: String(context.clientId),
    variableKeys: Object.freeze(Object.keys(built.variables)),
    code: null,
    version: INBOUND_VERSION,
  });
}

/**
 * The refusal path. ALWAYS a valid 200 response body, never a 5xx.
 *
 * A non-2xx here costs three provider retries and then, if the number has no
 * bound agent, the caller is disconnected. Answering "no variables" keeps the
 * call alive on the agent the number is already bound to, which is the safe
 * degradation. `reject_call` is available when a deployment genuinely wants an
 * unattributable call refused.
 */
function refuse(code, message, failureMode) {
  const rejecting = failureMode === FAILURE_MODES.reject;
  const built = dynamicVars.buildInboundWebhookResponse(
    rejecting ? { reject: true } : { variables: {} }
  );
  return Object.freeze({
    ok: false,
    status: 200,
    // buildInboundWebhookResponse returns { call_inbound: {} } for an empty
    // set, which is a valid documented response meaning "no overrides".
    body: built.ok ? built.response : { call_inbound: {} },
    clientId: null,
    variableKeys: Object.freeze([]),
    code,
    message,
    rejected: rejecting,
    version: INBOUND_VERSION,
  });
}

module.exports = {
  INBOUND_VERSION,
  INBOUND_EVENT,
  FAILURE_MODES,
  REJECT_CODES,
  validateInboundRequest,
  decideInboundCall,
};
