// AIDA — Retell custom-tool handler: create_locksmith_enquiry (M7J).
//
// ─── THE CONTRACT (verified 2026-08-03) ─────────────────────────────
// docs.retellai.com/build/single-multi-prompt/custom-function:
//
//   REQUEST   POST, application/json, header X-Retell-Signature (HMAC-SHA256,
//             the same scheme as the webhooks, signed with the API key).
//             Body: { name, call, args } where `call` carries call_id, agent_id,
//             agent_name, call_status, metadata, retell_llm_dynamic_variables,
//             transcript, transcript_object.
//   RESPONSE  2xx means success. The body is converted to text for the LLM.
//             Capped at 15,000 characters.
//   RETRIES   NONE. "Custom functions are not retried — if the request fails or
//             times out, the agent receives the error message."
//   TIMEOUT   120000 ms default, configurable.
//
// ─── WHY A FAILURE STILL ANSWERS 2xx ────────────────────────────────
// Because Retell hands the agent "the error message" on a non-2xx, and an agent
// holding an opaque error improvises — which is exactly how a caller gets told
// their details were saved when they were not.
//
// So AUTHENTICITY failures answer 4xx (the request is not ours; there is no
// conversation to be honest to), while OPERATIONAL failures answer 200 with
// `saved: false` and a sentence the agent is instructed to say. The agent is
// never left to invent wording for a failure.
//
// ─── WHAT IS TRUSTED ────────────────────────────────────────────────
// TRUSTED: `call.agent_id`, and only because the signature was verified first.
// NOT TRUSTED, ever: any client id, tenant, environment or idempotency key in
// the body. Ownership is resolved from agent_id through the SAME registry the
// inbound webhook uses — a tool that accepted a client id from the model would
// let a prompt injection file a job under another locksmith.
//
// Injected deps throughout: no database import, no Supabase, testable on a bare
// checkout.

const { verifyRetellWebhook } = require("../services/retell-webhook-verify");
const { canVerifyToolWebhook, getRetellConfig } = require("../config/retell");
const { captureEnquiry, toToolResponse } = require("../services/locksmith-caller-enquiry");

const TOOL_HANDLER_VERSION = "retell-tools-handler-2026-08-03";

/** The tool this handler serves. A body naming anything else is refused. */
const TOOL_NAME = "create_locksmith_enquiry";

// Verification outcomes → HTTP. Mirrors the inbound webhook so an operator
// reading logs across both surfaces sees one vocabulary.
const VERIFY_STATUS = Object.freeze({
  invalid_signature: 401,
  missing_signature: 401,
  disabled: 503,
  unavailable: 503,
  bad_content_type: 415,
  too_large: 413,
  stale: 401,
});

/**
 * The response an agent gets when AIDA cannot help but the request WAS ours.
 * Always 200, always truthful, always with wording the agent may use verbatim.
 */
function operationalRefusal(res, body) {
  return res.status(200).json(body);
}

/**
 * @param {object}   deps
 * @param {Function} deps.resolveInbound  async ({agentId}) => { ok, resolution, context }
 *                   The SAME resolver the inbound webhook uses. Injected so this
 *                   module needs no database.
 * @param {Function} deps.store           async ({row}) => { ok, created, id }
 * @param {Function} deps.audit           optional, fire-and-forget after the response
 */
function createEnquiryToolHandler(deps = {}) {
  const verify = deps.verify || verifyRetellWebhook;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const resolveInbound = deps.resolveInbound || null;
  const store = deps.store || null;
  const audit = deps.audit || null;

  return async function handleEnquiryTool(req, res) {
    const startedAt = deps.now ? deps.now() : Date.now();
    const config = getRetellConfig(env);

    // ── 1. Verify BEFORE parsing. The raw bytes are what was signed. ──
    let verdict;
    try {
      verdict = await verify({
        rawBody: req.body,
        headers: normaliseHeaders(req.headers),
        contentType: normaliseHeaders(req.headers)["content-type"],
        deps: {
          env,
          verifier: deps.verifier,
          now: deps.now,
          // This surface's own capability. Reusing the inbound one would mean
          // enabling call handling silently enabled database writes.
          capability: deps.capability || canVerifyToolWebhook,
        },
      });
    } catch {
      logger.error("retell.tool.verify_threw");
      return res.status(500).json({ error: "verification_error" });
    }

    if (!verdict.verified) {
      // Not our request. There is no caller to be honest to, so this is a flat
      // refusal rather than an operational message.
      logger.error(`retell.tool.rejected tool=${TOOL_NAME} result=${verdict.result}`);
      return res.status(VERIFY_STATUS[verdict.result] || 401).json({ error: verdict.result });
    }

    // ── 2. Only now is the body trusted enough to parse ──
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body));
    } catch {
      logger.error("retell.tool.unparseable_body");
      return res.status(400).json({ error: "invalid_json" });
    }

    const body = parsed && typeof parsed === "object" ? parsed : {};
    const call = body.call && typeof body.call === "object" ? body.call : {};
    const args = body.args && typeof body.args === "object" ? body.args : {};

    // The route is per-tool, so a body naming a different function is either a
    // misconfiguration or someone probing. Refuse rather than guess.
    if (body.name && body.name !== TOOL_NAME) {
      logger.error(`retell.tool.wrong_tool expected=${TOOL_NAME}`);
      return res.status(400).json({ error: "wrong_tool" });
    }

    const agentId = typeof call.agent_id === "string" ? call.agent_id : null;
    const callId = typeof call.call_id === "string" ? call.call_id : null;

    if (!agentId) {
      logger.error("retell.tool.no_agent_id");
      return operationalRefusal(res, toToolResponse({ saved: false, outcome: "unavailable", agentMessage: UNAVAILABLE_MESSAGE, errors: [] }));
    }

    // ── 3. Ownership is resolved, never asserted by the caller ──
    let context = null;
    if (typeof resolveInbound === "function") {
      try {
        const resolution = await resolveInbound({ agentId, agentVersion: call.agent_version ?? null, callId });
        if (resolution && resolution.ok && resolution.context) context = resolution.context;
        else logger.error(`retell.tool.unresolved agent_resolution=${(resolution && resolution.resolution) || "none"}`);
      } catch {
        logger.error("retell.tool.resolver_failed");
      }
    }

    if (!context || !context.clientId) {
      // Refusing is the only safe answer: writing without a resolved tenant
      // files a stranger's job under somebody.
      return operationalRefusal(res, toToolResponse({ saved: false, outcome: "unavailable", agentMessage: UNAVAILABLE_MESSAGE, errors: [] }));
    }

    // ── 4. Capture ──
    const result = await captureEnquiry({
      args,
      context: {
        clientId: context.clientId,
        // The DEPLOYMENT's tag, never the body's. This is the sandbox/production
        // boundary and the model must not be able to move a row across it.
        environment: config.allowedTag,
        providerCallId: callId,
        providerAgentId: agentId,
        profileVersion: Number.isInteger(context.profileVersion) ? context.profileVersion : null,
      },
      deps: { store, logger },
    });

    const responseBody = toToolResponse(result);
    res.status(200).json(responseBody);

    // ── 5. Audit AFTER the response. Never delays a live conversation. ──
    if (typeof audit === "function") {
      Promise.resolve()
        .then(() =>
          audit({
            version: TOOL_HANDLER_VERSION,
            tool: TOOL_NAME,
            clientId: context.clientId,
            environment: config.allowedTag,
            providerCallId: callId,
            providerAgentId: agentId,
            outcome: result.outcome,
            saved: result.saved,
            enquiryId: result.enquiryId,
            // Field NAMES only — never the caller's values.
            missingFields: (result.errors || []).map((e) => e.field),
            latencyMs: (deps.now ? deps.now() : Date.now()) - startedAt,
          })
        )
        .catch(() => logger.error("retell.tool.audit_failed"));
    }
    return undefined;
  };
}

// One sentence, used for every operational failure, so the agent cannot end up
// with two different stories about the same outcome.
const UNAVAILABLE_MESSAGE =
  "I could not save that just now. Tell the caller honestly that you could not record it and that they should ring the locksmith directly.";

/** Header names lowercased; array values collapsed to the first. */
function normaliseHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

module.exports = {
  TOOL_HANDLER_VERSION,
  TOOL_NAME,
  VERIFY_STATUS,
  UNAVAILABLE_MESSAGE,
  createEnquiryToolHandler,
  normaliseHeaders,
};
