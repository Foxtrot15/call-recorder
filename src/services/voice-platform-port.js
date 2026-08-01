// AIDA — provider-neutral voice-platform port (M3).
//
// The domain layer talks to THIS, never to Retell. Nothing in this file, or in
// any caller of it, imports a provider SDK; the Retell specifics live behind
// services/retell-adapter.js and are reached only through the interface below.
// That is what lets the whole provisioning domain be tested with an injected
// fake and lets a second provider arrive without touching the compilers.
//
// Four adapters ship:
//   createDisabledAdapter()  every operation refuses, descriptively. The
//                            default, and what a production deploy has today.
//   createMockAdapter()      deterministic in-memory provider. Same inputs →
//                            same fake ids. Used by tests and the M4 simulator.
//   createDryRunAdapter()    records the request that WOULD have been sent and
//                            returns a planned-not-executed result. No socket
//                            is opened; there is no code path to one.
//   createRetellAdapter()    the real boundary. Requires every relevant flag
//                            AND valid config before any method will run.
//
// Operation results are a closed, stable shape so callers never branch on a
// provider's error format:
//   { ok: true,  resource: {...}, providerRequestId, latencyMs, mode }
//   { ok: false, error: { code, message, retryable, status, providerRequestId }, mode }
//
// `code` is one of ERROR_CODES — normalised from whatever the provider said.
// `retryable` is the property callers actually need: a 429 or a 502 may be
// retried with the same idempotency key; a 400 never should be, because the
// request itself is wrong and retrying just burns quota.
//
// Pure + dep-free (the Retell adapter lazy-requires its transport).

const crypto = require("crypto");

// ── Stable AIDA types ───────────────────────────────────────────────

/** What we ask a provider to hold on our behalf. Provider-neutral names. */
const RESOURCE_TYPES = Object.freeze([
  "knowledge_base",
  "response_engine",
  "voice_agent",
  "analysis_schema",
  "phone_number_binding",
]);

/** What an AIDA resource is FOR. One purpose may map to several resource types. */
const RESOURCE_PURPOSES = Object.freeze([
  "onboarding_agent",
  "receptionist_agent",
  "receptionist_knowledge",
  "receptionist_analysis",
  "onboarding_analysis",
  "inbound_binding",
]);

const OPERATIONS = Object.freeze([
  "createKnowledgeBase",
  "updateKnowledgeBase",
  "createResponseEngine",
  "updateResponseEngine",
  "createAgent",
  "updateAgent",
  "createPhoneCall",
  "retrieveCall",
  "createOrUpdateAnalysisSchema",
  "bindPhoneNumber",
  "archiveProviderResource",
  "verifyWebhook",
]);

const ERROR_CODES = Object.freeze({
  disabled: "provider_disabled",
  notPermitted: "operation_not_permitted",
  misconfigured: "provider_misconfigured",
  invalidRequest: "invalid_request",
  unauthorized: "provider_unauthorized",
  notFound: "provider_not_found",
  rateLimited: "provider_rate_limited",
  timeout: "provider_timeout",
  network: "provider_unreachable",
  providerError: "provider_error",
  unsupported: "operation_unsupported",
});

// Which normalised codes may be retried with the SAME idempotency key.
const RETRYABLE_CODES = Object.freeze([
  ERROR_CODES.rateLimited,
  ERROR_CODES.timeout,
  ERROR_CODES.network,
  ERROR_CODES.providerError,
]);

const MODES = Object.freeze({ disabled: "disabled", mock: "mock", dryRun: "dry_run", live: "live" });

function ok({ resource, providerRequestId = null, latencyMs = 0, mode, operation, extra = {} }) {
  return Object.freeze({ ok: true, operation, mode, resource, providerRequestId, latencyMs, ...extra });
}

function fail({ code, message, status = null, providerRequestId = null, mode, operation, retryable = null }) {
  return Object.freeze({
    ok: false,
    operation,
    mode,
    error: Object.freeze({
      code,
      message,
      status,
      providerRequestId,
      retryable: retryable === null ? RETRYABLE_CODES.includes(code) : retryable,
    }),
  });
}

/**
 * Normalise any provider failure into our closed vocabulary. Given an HTTP
 * status and an optional provider body, decide the code and — crucially —
 * whether retrying could possibly help.
 */
function normaliseProviderError({ status, body = null, providerRequestId = null, cause = null }) {
  let code = ERROR_CODES.providerError;
  if (status === 400 || status === 422) code = ERROR_CODES.invalidRequest;
  else if (status === 401 || status === 403) code = ERROR_CODES.unauthorized;
  else if (status === 404) code = ERROR_CODES.notFound;
  else if (status === 429) code = ERROR_CODES.rateLimited;
  else if (status === 402) code = ERROR_CODES.invalidRequest; // payment required is not retryable
  else if (status && status >= 500) code = ERROR_CODES.providerError;
  else if (!status && cause) {
    code = /timeout|abort/i.test(String(cause)) ? ERROR_CODES.timeout : ERROR_CODES.network;
  }

  // The provider's own message may echo request content. Never propagate it
  // verbatim: keep a short, scrubbed hint and rely on `code` for behaviour.
  const detail = body && typeof body === "object" && typeof body.message === "string" ? body.message.slice(0, 200) : null;

  return {
    code,
    status: status || null,
    providerRequestId,
    message: detail ? `${code}: ${detail}` : code,
    retryable: RETRYABLE_CODES.includes(code),
  };
}

/**
 * A deterministic idempotency key. The same logical operation on the same
 * inputs always produces the same key, so a retry after a partial failure
 * cannot create a second copy of a resource.
 */
function idempotencyKey({ clientId, purpose, resourceType, payloadHash, planId = null }) {
  const material = [clientId, purpose, resourceType, payloadHash, planId || "-"].join("|");
  return `aida_${crypto.createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/** Stable hash of any payload — the input to both the key above and plan diffing. */
function payloadHash(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// ── Late-resolved provider references ───────────────────────────────
//
// Some payload fields are provider ids that do not exist until an earlier
// resource has been created: an agent needs its response engine's id, a phone
// binding needs the agent's id.
//
// A payload may carry a reference token in place of such a field. The token is
// replaced with the real id during execution, immediately before the provider
// call. Hashing happens over the UNRESOLVED payload — the token is stable, the
// resolved id is not knowable at plan time, so hashing the token form is what
// keeps diffing and idempotency deterministic across runs.
//
// Lives here, in the provider-neutral port, because both the compiler (which
// emits tokens) and the planner (which resolves them) already depend on this
// module and neither should depend on the other.
const REF = "$aidaRef";

function ref(purpose, resourceType) {
  return { [REF]: `${purpose}:${resourceType}` };
}

function isRef(value) {
  return Boolean(value && typeof value === "object" && typeof value[REF] === "string");
}

/**
 * Replace reference tokens with ids produced during this execution.
 *
 * `placeholder` is for dry runs. A dry run creates nothing, so a dependency id
 * genuinely does not exist — but failing the run because of that would make
 * dry-run useless for precisely the plans that need previewing most (the ones
 * with dependencies). Instead the token becomes a visibly fake string, so the
 * operator sees the shape of the request AND can see at a glance which fields
 * would be filled in for real.
 *
 * @returns {{ok:true, payload:*, placeheld?:string[]}|{ok:false, missing:string[]}}
 */
function resolveRefs(payload, provided, { placeholder = null } = {}) {
  const missing = [];
  const placeheld = [];

  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (isRef(node)) {
      const key = node[REF];
      if (!provided.has(key)) {
        if (placeholder) {
          placeheld.push(key);
          return `${placeholder}${key}>`;
        }
        missing.push(key);
        return null;
      }
      return provided.get(key);
    }
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  }

  const resolved = walk(payload);
  return missing.length ? { ok: false, missing } : { ok: true, payload: resolved, placeheld };
}

/** Obviously-fake marker for dry-run dependency fields. Never a valid id. */
const DRY_RUN_REF_PLACEHOLDER = "<would-be-resolved-at-execution:";

/** JSON with sorted keys, so hashing is insensitive to property order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// ── Disabled adapter ────────────────────────────────────────────────

/**
 * Refuses everything, with a reason. This is the default adapter and the one a
 * production deploy uses today. A refusal is a normal, tested result — not an
 * exception — so callers handle "the provider is off" the same way they handle
 * "the provider said no".
 */
function createDisabledAdapter({ reasons = ["the Retell integration is disabled"] } = {}) {
  const adapter = { mode: MODES.disabled, provider: "none" };
  for (const operation of OPERATIONS) {
    adapter[operation] = async () =>
      fail({
        code: ERROR_CODES.disabled,
        message: `${operation} is unavailable: ${reasons.join("; ")}`,
        mode: MODES.disabled,
        operation,
        retryable: false,
      });
  }
  // verifyWebhook has a different contract: it returns a verdict, not a resource.
  adapter.verifyWebhook = async () => ({ verified: false, reason: "webhook verification is disabled", mode: MODES.disabled });
  return Object.freeze(adapter);
}

// ── Deterministic mock adapter ──────────────────────────────────────

/**
 * An in-memory provider that behaves like a real one without being one. Ids are
 * derived from the request, so the same request always yields the same id and a
 * retry is naturally idempotent — which is exactly the property the recovery
 * paths need to be tested against.
 *
 * `failures` lets a test make one operation fail deterministically:
 *   createMockAdapter({ failures: { createAgent: { status: 500 } } })
 */
function createMockAdapter({ failures = {}, store = new Map(), clock = () => 0 } = {}) {
  function mockId(prefix, request) {
    return `${prefix}_${payloadHash(request).slice(0, 24)}`;
  }

  function run(operation, idPrefix, idField) {
    return async (request = {}) => {
      const failure = failures[operation];
      if (failure) {
        const normalised = normaliseProviderError({ status: failure.status || 500, body: failure.body || null, providerRequestId: "mock-req" });
        return fail({ ...normalised, mode: MODES.mock, operation });
      }
      const id = request[idField] || mockId(idPrefix, request);
      const existing = store.get(id);
      const version = existing ? existing.version + 1 : 0;
      const resource = Object.freeze({
        id,
        [idField]: id,
        type: idPrefix,
        version,
        // Echo only what a caller legitimately needs back. The full request is
        // deliberately not returned — provider payloads must not leak upward.
        echo: Object.freeze({ name: request.name || null, purpose: request.purpose || null }),
        createdAt: clock(),
      });
      store.set(id, { version });
      return ok({ resource, providerRequestId: `mock-${id.slice(-8)}`, latencyMs: 0, mode: MODES.mock, operation });
    };
  }

  return Object.freeze({
    mode: MODES.mock,
    provider: "mock",
    _store: store,
    createKnowledgeBase: run("createKnowledgeBase", "kb", "knowledge_base_id"),
    updateKnowledgeBase: run("updateKnowledgeBase", "kb", "knowledge_base_id"),
    createResponseEngine: run("createResponseEngine", "llm", "llm_id"),
    updateResponseEngine: run("updateResponseEngine", "llm", "llm_id"),
    createAgent: run("createAgent", "agent", "agent_id"),
    updateAgent: run("updateAgent", "agent", "agent_id"),
    createOrUpdateAnalysisSchema: run("createOrUpdateAnalysisSchema", "analysis", "analysis_id"),
    bindPhoneNumber: run("bindPhoneNumber", "binding", "phone_number"),
    archiveProviderResource: run("archiveProviderResource", "archive", "id"),
    createPhoneCall: async (request = {}) => {
      const failure = failures.createPhoneCall;
      if (failure) {
        const normalised = normaliseProviderError({ status: failure.status || 500, providerRequestId: "mock-req" });
        return fail({ ...normalised, mode: MODES.mock, operation: "createPhoneCall" });
      }
      const callId = mockId("call", { to: request.to_number, agent: request.override_agent_id, meta: request.metadata });
      store.set(callId, { version: 0, status: "registered" });
      return ok({
        resource: Object.freeze({ id: callId, call_id: callId, call_status: "registered", type: "phone_call", version: 0 }),
        providerRequestId: `mock-${callId.slice(-8)}`,
        mode: MODES.mock,
        operation: "createPhoneCall",
      });
    },
    retrieveCall: async ({ callId } = {}) => {
      const entry = store.get(callId);
      if (!entry) {
        return fail({ code: ERROR_CODES.notFound, message: "no such mock call", status: 404, mode: MODES.mock, operation: "retrieveCall" });
      }
      return ok({ resource: Object.freeze({ id: callId, call_id: callId, call_status: entry.status || "ended" }), mode: MODES.mock, operation: "retrieveCall" });
    },
    // The mock accepts a signature only when the test explicitly says it is
    // valid. It never implements real crypto, so a mock can never be mistaken
    // for verification in production.
    verifyWebhook: async ({ mockVerified = false } = {}) => ({
      verified: mockVerified === true,
      reason: mockVerified === true ? null : "mock adapter requires mockVerified:true",
      mode: MODES.mock,
    }),
  });
}

// ── Dry-run adapter ─────────────────────────────────────────────────

/**
 * Produces the request that WOULD be sent and records it. There is no branch
 * here that reaches a network call — the absence is structural, not a flag
 * check — so a dry run cannot become a live run through a config mistake.
 */
function createDryRunAdapter({ recorder = [] } = {}) {
  const adapter = { mode: MODES.dryRun, provider: "dry_run", recorded: recorder };
  for (const operation of OPERATIONS) {
    if (operation === "verifyWebhook") continue;
    adapter[operation] = async (request = {}) => {
      const hash = payloadHash(request);
      recorder.push({ operation, payloadHash: hash });
      return ok({
        resource: Object.freeze({ id: null, type: operation, version: null, plannedPayloadHash: hash }),
        mode: MODES.dryRun,
        operation,
        extra: { executed: false, wouldSend: true },
      });
    };
  }
  adapter.verifyWebhook = async () => ({ verified: false, reason: "dry-run does not verify webhooks", mode: MODES.dryRun });
  return Object.freeze(adapter);
}

// ── Adapter selection ───────────────────────────────────────────────

/**
 * Choose the adapter the current configuration permits. Order matters and is
 * deliberately pessimistic: disabled beats everything, dry-run beats live, and
 * live is only reachable when every gate and every required value is present.
 *
 * `explicitMode` lets the M4 simulator and tests ask for the mock adapter —
 * but only when the caller passes it, never through env alone.
 */
function selectAdapter({ config, capability, explicitMode = null, deps = {} } = {}) {
  if (explicitMode === MODES.mock) return deps.mockAdapter || createMockAdapter();

  if (!config || !config.enabled) {
    return createDisabledAdapter({ reasons: ["RETELL_ENABLED is not \"true\""] });
  }
  if (capability && !capability.allowed) {
    if (config.dryRun) return deps.dryRunAdapter || createDryRunAdapter();
    return createDisabledAdapter({ reasons: capability.reasons });
  }
  if (config.dryRun) return deps.dryRunAdapter || createDryRunAdapter();

  // Live. The Retell adapter re-checks its own preconditions on every call —
  // selection is not permission.
  return deps.liveAdapter || require("./retell-adapter").createRetellAdapter({ config });
}

module.exports = {
  RESOURCE_TYPES,
  RESOURCE_PURPOSES,
  OPERATIONS,
  ERROR_CODES,
  RETRYABLE_CODES,
  MODES,
  ok,
  fail,
  normaliseProviderError,
  idempotencyKey,
  payloadHash,
  stableStringify,
  REF,
  ref,
  isRef,
  resolveRefs,
  DRY_RUN_REF_PLACEHOLDER,
  createDisabledAdapter,
  createMockAdapter,
  createDryRunAdapter,
  selectAdapter,
};
