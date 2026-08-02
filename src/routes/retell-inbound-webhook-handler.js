// AIDA — Retell inbound-call webhook handler (M7F-A).
//
// Express-free and injectable, so the whole security boundary is testable with
// fake req/res objects and no server. See routes/retell-inbound-webhook.js for
// the route-separation rationale.
//
// RESPONSE POLICY — chosen against the documented fallback behaviour:
//
//   200  every outcome we can answer at all, INCLUDING refusals. A refusal
//        returns a valid empty { call_inbound: {} }, which means "no
//        overrides" — the call proceeds on the agent the number is bound to,
//        with no runtime variables.
//   400  the body is not the documented inbound shape. Retrying will not help.
//   401  missing, malformed, stale or invalid signature.
//   413  over the configured byte limit.
//   503  webhook disabled or verifier unavailable.
//
// Why refusals are 200 and not 4xx: Retell retries a non-2xx three times and
// then, if the number has no bound inbound agent, DISCONNECTS THE CALLER. A
// locksmith's customer being hung up on because our client lookup missed is a
// worse outcome than that customer reaching a receptionist without on-call
// context. Unauthenticated requests are a different matter and still get 401 —
// we would rather Retell retry than answer an unverified caller.
//
// NOTHING HERE TOUCHES THE DATABASE. The inbound response is built from the
// injected resolver and pure functions only.

const { getRetellConfig } = require("../config/retell");
const { verifyRetellWebhook, VERIFY_RESULTS } = require("../services/retell-webhook-verify");
const inbound = require("../services/retell-inbound-call");

const VERIFY_STATUS = Object.freeze({
  [VERIFY_RESULTS.missingSignature]: 401,
  [VERIFY_RESULTS.malformedSignature]: 401,
  [VERIFY_RESULTS.staleSignature]: 401,
  [VERIFY_RESULTS.invalidSignature]: 401,
  [VERIFY_RESULTS.badContentType]: 400,
  [VERIFY_RESULTS.oversize]: 413,
  [VERIFY_RESULTS.disabled]: 503,
  [VERIFY_RESULTS.unavailable]: 503,
});

/**
 * @param {object} deps
 * @param {Function} deps.resolveContext  async (request) => context | null.
 *        The ONLY place this handler can learn about a client. Injected rather
 *        than imported so the inbound path has no database dependency at all —
 *        a deployment that has not applied the provisioning SQL can still serve
 *        inbound calls.
 */
function createInboundWebhookHandler(deps = {}) {
  const verify = deps.verify || verifyRetellWebhook;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  // Two seams, deliberately.
  //
  //   resolveInbound   returns the resolver's full classified outcome
  //                    ({ ok, resolution, context }). Used in production, so
  //                    the audit can record WHY a call was not resolved —
  //                    "ambiguous agent" and "unknown agent" need completely
  //                    different operator responses and must not look alike.
  //   resolveContext   returns a bare context or null. Kept because most tests
  //                    care only about the answer, not the classification.
  const resolveInbound = deps.resolveInbound || null;
  const resolveContext = deps.resolveContext || (async () => null);
  const failureMode = deps.failureMode || resolveFailureMode(env);
  const includeCallerNumber = deps.includeCallerNumber === true;
  // Audit is fire-and-forget and happens AFTER the response. It must never be
  // able to delay or fail the answer to a ringing phone.
  const audit = deps.audit || null;

  return async function handleInboundWebhook(req, res) {
    const startedAt = deps.now ? deps.now() : Date.now();
    const config = getRetellConfig(env);
    const rawBody = req.body;
    const headers = normaliseHeaders(req.headers);

    // ── 1–4: verify before parsing ──
    let verdict;
    try {
      verdict = await verify({
        rawBody,
        headers,
        contentType: headers["content-type"],
        deps: { env, verifier: deps.verifier, now: deps.now },
      });
    } catch {
      logger.error("retell.inbound.verify_threw");
      return res.status(500).json({ error: "verification_error" });
    }

    if (!verdict.verified) {
      const status = VERIFY_STATUS[verdict.result] || 401;
      logger.error(`retell.inbound.rejected result=${verdict.result}`);
      return res.status(status).json({ error: verdict.result });
    }

    // ── 5: only now is the body trusted enough to parse ──
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    } catch {
      logger.error("retell.inbound.unparseable");
      return res.status(400).json({ error: "malformed_json" });
    }

    // ── 6: shape validation ──
    // A non-inbound event reaching this route is a configuration mistake worth
    // a 400: answering it with an inbound body would be answering the wrong
    // contract, and the event route exists for exactly that payload.
    const shape = inbound.validateInboundRequest(parsed);
    if (!shape.ok && shape.code === inbound.REJECT_CODES.notInbound) {
      logger.error(`retell.inbound.wrong_event code=${shape.code}`);
      return res.status(400).json({ error: shape.code });
    }

    // ── 7: decide and answer ──
    // `resolution` is captured alongside the context so the audit can name the
    // classification. Assigned inside the resolver wrapper rather than returned,
    // because decideInboundCall's contract is deliberately "a context or null".
    let resolution = null;
    const resolve = resolveInbound
      ? async (request) => {
        const result = await resolveInbound(request);
        resolution = result && result.resolution ? result.resolution : null;
        return result && result.ok ? result.context : null;
      }
      : resolveContext;

    let decision;
    try {
      decision = await inbound.decideInboundCall({ parsed, resolveContext: resolve, failureMode, includeCallerNumber, logger });
    } catch {
      // Structurally unreachable — decideInboundCall catches its own resolver
      // failures — but a throw here would disconnect a caller, so it is caught
      // and answered rather than allowed to become a 500.
      logger.error("retell.inbound.decide_threw");
      return res.status(200).json({ call_inbound: {} });
    }

    const elapsedMs = (deps.now ? deps.now() : Date.now()) - startedAt;

    // Names and counts only. Never a caller number, never a variable VALUE.
    logger.log(
      `retell.inbound.answered ok=${decision.ok} vars=${decision.variableKeys.length}` +
      `${resolution ? ` resolution=${resolution}` : ""}${decision.code ? ` code=${decision.code}` : ""} ms=${elapsedMs}`
    );

    res.status(decision.status).json(decision.body);

    // ── after the response: audit, never awaited ──
    //
    // Every outcome is audited, not just failures: "resolved" is the event that
    // makes an unexplained transfer traceable later, and a log that records only
    // problems cannot answer "which client did that call go to?".
    //
    // The event carries a classification and a client id, never a caller
    // number, a transfer number or a variable value.
    if (audit) {
      Promise.resolve()
        .then(() => audit({
          event: decision.ok ? "inbound_resolved" : "inbound_unresolved",
          resolution: resolution || (decision.ok ? "resolved" : decision.code || "unknown"),
          ok: decision.ok,
          code: decision.code || null,
          clientId: decision.clientId,
          agentId: shape.ok ? shape.request.agentId : null,
          variableCount: decision.variableKeys.length,
          elapsedMs,
        }))
        .catch(() => logger.error("retell.inbound.audit_failed"));
    }

    return undefined;
  };
}

/**
 * The failure mode, from configuration, strict-parse.
 *
 * Defaults to withholding variables rather than rejecting the call. See the
 * long note in services/retell-inbound-call.js — the danger is emitting
 * variables we cannot attribute, not answering a call we cannot attribute.
 */
function resolveFailureMode(env = process.env) {
  return env.RETELL_INBOUND_UNKNOWN_CLIENT_ACTION === "reject"
    ? inbound.FAILURE_MODES.reject
    : inbound.FAILURE_MODES.withhold;
}

function normaliseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value;
  return out;
}

module.exports = { createInboundWebhookHandler, VERIFY_STATUS, resolveFailureMode, normaliseHeaders };
