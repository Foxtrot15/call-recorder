// AIDA — the Retell adapter boundary (M3).
//
// THE ONLY FILE THAT KNOWS RETELL'S HTTP SHAPE. Everything above it speaks the
// provider-neutral port (services/voice-platform-port.js).
//
// ─────────────────────────────────────────────────────────────────────
// TRANSPORT DECISION: native fetch, not the SDK
// ─────────────────────────────────────────────────────────────────────
// The official SDK (retell-sdk) requires Node 20+; this repo declares
// "node": ">=18". Rather than silently raise the floor for every deploy, the
// write path uses Node's built-in fetch (stable since Node 18) against the
// documented REST endpoints, with an explicit AbortController timeout.
//
// The ONE thing not reimplemented is signature verification — see
// services/retell-webhook-verify.js for why that delegates to the SDK. Writes
// are safe to implement directly because their contract is fully published and
// a mistake produces a 4xx, whereas a mistaken verifier produces a forged
// event that looks genuine.
//
// EVERY method re-checks its own preconditions. Adapter selection is not
// permission: even if something hands this adapter to a caller, an unset flag
// still refuses. There is no method here that can run during tests — the
// suite never constructs this adapter with live capability, and `fetchImpl`
// must be injected for any request to be attempted at all.
//
// Endpoints below are quoted from the official API reference reviewed
// 2026-08-01 (docs/RETELL_INTEGRATION_SPEC.md §2 lists the pages).

const {
  ERROR_CODES,
  MODES,
  ok,
  fail,
  normaliseProviderError,
} = require("./voice-platform-port");
const { canWriteLive, canPlaceCall, redactSecrets } = require("../config/retell");

// Documented paths, verified against docs.retellai.com on 2026-08-01.
//
// TRANSPORT IS NOT UNIFORM. /create-knowledge-base and
// /add-knowledge-base-sources are multipart/form-data; everything else is JSON.
// Sending the KB as ordinary JSON — which this adapter previously did — is
// rejected by the provider, so `contentType` is now explicit per endpoint and
// the request builder refuses to guess.
//
// THERE IS NO KNOWLEDGE-BASE UPDATE ENDPOINT. The documented surface is create,
// add-sources and delete-source; a wholesale PATCH does not exist. The previous
// `updateKnowledgeBase: PATCH /update-knowledge-base/:id` was invented. A KB
// change is therefore CREATE-AND-REPOINT: build a new knowledge base, attach it
// to a new response engine, and leave the old one to be superseded in the
// registry — the same shape as the rest of AIDA's rollback model.
const ENDPOINTS = Object.freeze({
  createKnowledgeBase: { method: "POST", path: "/create-knowledge-base", contentType: "multipart/form-data" },
  addKnowledgeBaseSources: { method: "POST", path: "/add-knowledge-base-sources/:id", contentType: "multipart/form-data" },
  deleteKnowledgeBaseSource: { method: "DELETE", path: "/delete-knowledge-base-source/:id/source/:sourceId" },
  getKnowledgeBase: { method: "GET", path: "/get-knowledge-base/:id" },
  createResponseEngine: { method: "POST", path: "/create-retell-llm" },
  updateResponseEngine: { method: "PATCH", path: "/update-retell-llm/:id" },
  createConversationFlow: { method: "POST", path: "/create-conversation-flow" },
  createAgent: { method: "POST", path: "/create-agent" },
  updateAgent: { method: "PATCH", path: "/update-agent/:id" },
  createPhoneCall: { method: "POST", path: "/v2/create-phone-call" },
  // Web call. A DIFFERENT capability from createPhoneCall: browser audio, no
  // number, no dialling, no carrier. Gated separately (config/retell-sandbox.js)
  // precisely so testing a browser microphone never requires switching on the
  // ability to ring a real telephone.
  createWebCall: { method: "POST", path: "/v2/create-web-call" },
  // Retrieval + deletion, verified 2026-08-01. Deletes return 204; a missing
  // resource returns 422 ("Cannot find requested asset under given api key"),
  // not 404 — which is why cleanup treats 422 as already-gone.
  getResponseEngine: { method: "GET", path: "/get-retell-llm/:id" },
  getAgent: { method: "GET", path: "/get-agent/:id" },
  deleteKnowledgeBase: { method: "DELETE", path: "/delete-knowledge-base/:id" },
  deleteResponseEngine: { method: "DELETE", path: "/delete-retell-llm/:id" },
  deleteAgent: { method: "DELETE", path: "/delete-agent/:id" },
  retrieveCall: { method: "GET", path: "/v2/get-call/:id" },
  bindPhoneNumber: { method: "PATCH", path: "/update-phone-number/:id" },
});

// Retell surfaces a request id on responses; preserving it is what makes a
// support conversation possible later.
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-retell-request-id"];

function pickRequestId(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * Build the request. The API key goes into the Authorization header here and
 * nowhere else — it is never placed in a body, a query string, a log line, a
 * dynamic variable or an error.
 */
function buildRequest({ config, endpoint, body, idempotencyKey }) {
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
  };
  // Retell does not document an idempotency header. We still send our key as a
  // correlation header so it appears in provider-side request logs, and we rely
  // on OUR registry (unique on the key) for actual idempotency rather than
  // assuming provider support that is not documented.
  if (idempotencyKey) headers["X-Aida-Idempotency-Key"] = idempotencyKey;

  // ── TRANSPORT IS NOT UNIFORM ──────────────────────────────────────
  //
  // The knowledge-base endpoints are multipart/form-data; everything else is
  // JSON. This builder previously hard-coded `Content-Type: application/json`
  // and `JSON.stringify(body)`, so a multipart request built by
  // services/retell-multipart.js was stringified into a JSON string and sent
  // as JSON — the encoding never reached the wire, and the provider answered
  // 400. The `contentType` declared on each ENDPOINTS entry was decorative
  // because nothing read it.
  //
  // Verified against the live provider on 2026-08-02: the same bytes sent with
  // the multipart content type and its boundary are accepted (201).
  if (endpoint.contentType === "multipart/form-data") {
    // The multipart builder produces { contentType, body } — the content type
    // carries the generated boundary, so it MUST come from the built request
    // and can never be a constant.
    if (!body || typeof body.contentType !== "string" || !body.body) {
      throw new Error(`${endpoint.path} requires a multipart request built by services/retell-multipart.js`);
    }
    return {
      method: endpoint.method,
      headers: { ...headers, "Content-Type": body.contentType },
      body: body.body,
    };
  }

  return {
    method: endpoint.method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: endpoint.method === "GET" ? undefined : JSON.stringify(body || {}),
  };
}

function resolvePath(endpoint, pathParam) {
  if (!endpoint.path.includes(":id")) return endpoint.path;
  if (!pathParam) throw new Error(`${endpoint.path} requires a path parameter`);
  return endpoint.path.replace(":id", encodeURIComponent(pathParam));
}

/**
 * The Retell adapter. `fetchImpl` MUST be supplied for any network attempt;
 * when it is absent every method refuses with `misconfigured`. That is the
 * structural guarantee that constructing this adapter in a test cannot reach
 * the network even if every flag were somehow set.
 */
function createRetellAdapter({ config, fetchImpl = null, env = process.env, logger = console } = {}) {
  if (!config) throw new Error("retell adapter requires config");

  async function request(operation, { body = null, pathParam = null, idempotencyKey = null, capability }) {
    const gate = capability(env);
    if (!gate.allowed) {
      return fail({
        code: ERROR_CODES.notPermitted,
        message: `${operation} refused: ${gate.reasons.join("; ")}`,
        mode: MODES.live,
        operation,
        retryable: false,
      });
    }
    if (typeof fetchImpl !== "function") {
      // No transport was injected. Deliberate: the live adapter is inert unless
      // something explicitly hands it a fetch implementation.
      return fail({
        code: ERROR_CODES.misconfigured,
        message: `${operation} refused: no HTTP transport is configured for the Retell adapter`,
        mode: MODES.live,
        operation,
        retryable: false,
      });
    }

    const endpoint = ENDPOINTS[operation];
    if (!endpoint) {
      return fail({ code: ERROR_CODES.unsupported, message: `${operation} has no Retell endpoint`, mode: MODES.live, operation, retryable: false });
    }

    const url = `${config.apiBaseUrl}${resolvePath(endpoint, pathParam)}`;
    const init = buildRequest({ config, endpoint, body, idempotencyKey });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const providerRequestId = pickRequestId(response.headers);
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const normalised = normaliseProviderError({ status: response.status, body: parsed, providerRequestId });
        // Log the shape, never the content.
        logger.error(`retell.${operation}.failed status=${response.status} code=${normalised.code} req=${providerRequestId || "-"}`);
        return fail({ ...normalised, mode: MODES.live, operation });
      }

      return ok({
        resource: extractResource(operation, parsed),
        providerRequestId,
        latencyMs: Date.now() - startedAt,
        mode: MODES.live,
        operation,
        // Only a web call carries a token, and only ever as a one-shot reader.
        extra: operation === "createWebCall" ? { takeAccessToken: oneShotToken(parsed && parsed.access_token) } : {},
      });
    } catch (err) {
      const normalised = normaliseProviderError({ status: null, cause: err && err.name === "AbortError" ? "timeout" : err && err.message });
      logger.error(`retell.${operation}.error code=${normalised.code}`);
      return fail({ ...normalised, mode: MODES.live, operation });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reduce a provider response to the stable fields the domain needs. The full
   * provider body is deliberately dropped here so it cannot reach a view, a log
   * or a database column by accident.
   */
  function extractResource(operation, body) {
    if (!body || typeof body !== "object") return Object.freeze({ id: null, version: null });

    // Order matters. A call response carries BOTH call_id and agent_id, and a
    // generic "first id wins" scan picked agent_id — so a created web call was
    // recorded under its agent's id. For call operations the call IS the
    // resource, so it is resolved first.
    const isCall = operation === "createWebCall" || operation === "createPhoneCall" || operation === "retrieveCall";
    const id = isCall
      ? body.call_id || null
      : body.agent_id || body.llm_id || body.knowledge_base_id || body.conversation_flow_id || body.call_id || body.phone_number || null;

    // Agent operations surface the few fields a caller must be able to VERIFY.
    //
    // Verified against the live provider 2026-08-02: agent verification read
    // `response.raw`, which the live adapter never returns — only test fakes
    // did — so every check reported "(none)" and a correctly-created agent
    // failed verification.
    //
    // Named fields rather than the whole body: the port's contract is that
    // provider payloads do not leak upward, and "return everything" would undo
    // that to fix a narrow need.
    const isAgent = operation === "createAgent" || operation === "updateAgent" || operation === "getAgent";
    const engine = (isAgent && body.response_engine) || null;

    return Object.freeze({
      id,
      version: typeof body.version === "number" ? body.version : null,
      status: body.call_status || body.status || null,
      // The agent a call belongs to, so a caller can verify the association
      // without needing the raw body.
      agentId: isCall ? body.agent_id || null : null,
      callType: isCall ? body.call_type || null : null,
      // Agent verification fields.
      responseEngineType: engine ? engine.type || null : null,
      responseEngineId: engine ? engine.llm_id || engine.conversation_flow_id || null : null,
      voiceId: isAgent ? body.voice_id || null : null,
      language: isAgent ? (Array.isArray(body.language) ? body.language[0] : body.language) || null : null,
      webhookUrl: isAgent ? body.webhook_url || null : null,
      assignedTags: Array.isArray(body.assigned_tags) ? body.assigned_tags.slice(0, 10) : null,
      lastModified: body.last_modification_timestamp || null,
    });
  }

  /**
   * A web call's access token, exposed through a ONE-SHOT reader.
   *
   * The port deliberately does not return provider bodies — that is what keeps
   * secrets out of results a caller might log. But a web-call token has to reach
   * the browser, so it needs exactly one narrow channel.
   *
   * `takeAccessToken()` returns the token once and then forgets it. The value is
   * held in a closure, never as an enumerable property, so:
   *   * JSON.stringify(result) cannot serialise it
   *   * a debug dump of the result shows a function, not a secret
   *   * a second reader gets null, so it cannot be harvested twice
   *
   * This is the "clear in-memory references after use" requirement expressed in
   * the type rather than left to callers' discipline.
   */
  function oneShotToken(rawToken) {
    let held = typeof rawToken === "string" && rawToken.length ? rawToken : null;
    return function takeAccessToken() {
      const value = held;
      held = null;
      return value;
    };
  }

  return Object.freeze({
    mode: MODES.live,
    provider: "retell",

    createKnowledgeBase: (r) => request("createKnowledgeBase", { body: r.payload, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),
    addKnowledgeBaseSources: (r) => request("addKnowledgeBaseSources", { body: r.payload, pathParam: r.providerId, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),
    getKnowledgeBase: (r) => request("getKnowledgeBase", { pathParam: r.providerId, capability: canWriteLive }),
    createResponseEngine: (r) => request("createResponseEngine", { body: r.payload, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),
    updateResponseEngine: (r) => request("updateResponseEngine", { body: r.payload, pathParam: r.providerId, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),
    createAgent: (r) => request("createAgent", { body: r.payload, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),
    updateAgent: (r) => request("updateAgent", { body: r.payload, pathParam: r.providerId, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),
    bindPhoneNumber: (r) => request("bindPhoneNumber", { body: r.payload, pathParam: r.providerId, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),

    // ── Retrieval ────────────────────────────────────────────────────
    getResponseEngine: (r) => request("getResponseEngine", { pathParam: r.providerId, capability: canWriteLive }),
    getAgent: (r) => request("getAgent", { pathParam: r.providerId, capability: canWriteLive }),

    // ── Web call ─────────────────────────────────────────────────────
    // Guarded by canWriteLive, NOT canPlaceCall. canPlaceCall demands an
    // outbound telephone number and the live-phone-call flag; a web call needs
    // neither and must never require enabling telephone dialling.
    createWebCall: (r) => request("createWebCall", { body: r.payload, idempotencyKey: r.idempotencyKey, capability: canWriteLive }),

    // ── Deletion ─────────────────────────────────────────────────────
    deleteKnowledgeBase: (r) => request("deleteKnowledgeBase", { pathParam: r.providerId, capability: canWriteLive }),
    deleteResponseEngine: (r) => request("deleteResponseEngine", { pathParam: r.providerId, capability: canWriteLive }),
    deleteAgent: (r) => request("deleteAgent", { pathParam: r.providerId, capability: canWriteLive }),

    // Retell has no standalone analysis-schema resource: post_call_analysis_data
    // is a field on the agent. Modelled as unsupported here so the domain keeps
    // its provider-neutral vocabulary and the compiler folds the schema into the
    // agent payload instead.
    createOrUpdateAnalysisSchema: async () =>
      fail({
        code: ERROR_CODES.unsupported,
        message: "Retell has no separate analysis-schema resource; the schema is part of the agent payload",
        mode: MODES.live,
        operation: "createOrUpdateAnalysisSchema",
        retryable: false,
      }),

    // Spends money. Gated by canPlaceCall, which is strictly stronger than
    // canWriteLive.
    createPhoneCall: (r) => request("createPhoneCall", { body: r.payload, idempotencyKey: r.idempotencyKey, capability: canPlaceCall }),
    retrieveCall: (r) => request("retrieveCall", { pathParam: r.callId, capability: canWriteLive }),

    archiveProviderResource: async () =>
      fail({
        code: ERROR_CODES.unsupported,
        message: "Retell does not expose a delete/archive endpoint for agents or LLMs; superseding is tracked in the AIDA registry instead",
        mode: MODES.live,
        operation: "archiveProviderResource",
        retryable: false,
      }),

    verifyWebhook: async (args) => require("./retell-webhook-verify").verifyRetellWebhook(args),

    // Exposed for the founder console. Uses the shared scrubber.
    describeRequest: (operation, body) => redactSecrets({ operation, body }),
  });
}

module.exports = { createRetellAdapter, ENDPOINTS, pickRequestId, buildRequest, resolvePath };
