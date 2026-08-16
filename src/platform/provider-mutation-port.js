// AIDA PLATFORM — the generic provider mutation port (P25A).
//
//   createResource / updateResource / retireResource
//
// ── WHAT THE EXECUTOR IS ALLOWED TO KNOW ────────────────────────────
// Three verbs and three outcomes. The executor never learns an HTTP method, a
// URL, a header, a status code or a vendor's error vocabulary. If it did, the
// safety logic would be entangled with one provider's quirks and the next
// provider would require rewriting the part that must not change.
//
// ── THE THREE OUTCOMES, AND WHY ONLY THREE ──────────────────────────
//
//   definite_success   the provider confirmed, and gave an id
//   definite_failure   the provider explicitly refused; nothing was created
//   unknown            it may or may not have happened
//
// A transport that returns anything else is making a judgement it is not
// qualified to make. In particular there is no "retryable" — the acquisition
// work found that a shared port marking timeouts retryable is exactly how a
// cold call gets placed twice, and the same reasoning applies to a resource
// that can answer a telephone.
//
// ── WHAT COUNTS AS UNKNOWN ──────────────────────────────────────────
// Anything where the request may have reached the provider: a timeout after
// sending, a connection reset after the write, a malformed response to an
// accepted request, or an error nobody can classify. The default for an
// unrecognised failure is UNKNOWN, not failure — erring towards "it might
// exist" costs a person five minutes; erring the other way creates a second
// resource that can speak to a stranger.
//
// ── NO REAL ADAPTER EXISTS ──────────────────────────────────────────
// This module defines a shape and provides FAKES. It imports nothing — no
// http, no client, no environment — and a ratchet asserts it. Wiring a real
// provider is a separate, explicit code milestone; there is no flag, no
// environment variable and no credential that turns a fake into a real one.

const { PROVIDER_OUTCOMES, AMBIGUITY_REASONS } = require("./execution-model");

/** The operations any adapter must implement to be usable at all. */
const REQUIRED_ADAPTER_OPERATIONS = Object.freeze(["createResource", "updateResource", "retireResource"]);

/** What each adapter operation must be given. Declared as data so it is testable. */
const MUTATION_REQUEST_FIELDS = Object.freeze({
  createResource: ["clientId", "purpose", "resourceType", "payload", "providerRequestId"],
  updateResource: ["clientId", "purpose", "resourceType", "payload", "providerRequestId", "providerResourceId"],
  retireResource: ["clientId", "purpose", "resourceType", "providerRequestId", "providerResourceId", "retirementMode"],
});

const outcome = (kind, extra = {}) => Object.freeze({ outcome: kind, ...extra });

/** A definite success must carry the id, or it is not a success anybody can use. */
const definiteSuccess = (providerResourceId, detail = null) =>
  outcome("definite_success", { providerResourceId, detail });
const definiteFailure = (detail) => outcome("definite_failure", { providerResourceId: null, detail });
const unknown = (ambiguityReason, detail = null) =>
  outcome("unknown", { providerResourceId: null, ambiguityReason, detail });

/** Does this object satisfy the port? */
function describeAdapterConformance(adapter) {
  if (!adapter || typeof adapter !== "object") {
    return { ok: false, missing: [...REQUIRED_ADAPTER_OPERATIONS], reason: "not an object" };
  }
  const missing = REQUIRED_ADAPTER_OPERATIONS.filter((op) => typeof adapter[op] !== "function");
  return { ok: missing.length === 0, missing, reason: missing.length ? `missing ${missing.join(", ")}` : null };
}

/** Validate a request against the port before an adapter ever sees it. */
function validateMutationRequest(operation, request) {
  const required = MUTATION_REQUEST_FIELDS[operation];
  if (!required) return { ok: false, missing: [], reason: `"${operation}" is not a port operation` };
  const missing = required.filter((f) => request[f] === undefined || request[f] === null || request[f] === "");
  return { ok: missing.length === 0, missing, reason: missing.length ? `missing ${missing.join(", ")}` : null };
}

/**
 * Wrap an adapter so the executor's contract with it is enforced in one place:
 * the request is validated first, the result is classified, and anything the
 * adapter throws or returns unrecognisably becomes UNKNOWN rather than failure.
 */
function createProviderMutationPort({ adapter, name = "unnamed" } = {}) {
  const conformance = describeAdapterConformance(adapter);
  if (!conformance.ok) {
    throw new Error(`createProviderMutationPort: adapter "${name}" ${conformance.reason}`);
  }

  async function invoke(operation, request) {
    const valid = validateMutationRequest(operation, request);
    if (!valid.ok) {
      // A malformed request never reaches the provider, so nothing can have
      // been created: this is a DEFINITE failure and the one case where the
      // executor may safely conclude nothing happened.
      return definiteFailure(`request rejected before sending: ${valid.reason}`);
    }

    let raw;
    try {
      raw = await adapter[operation](request);
    } catch (error) {
      // A throw from a transport is exactly the ambiguous case: the request may
      // have been sent. Never failure.
      return unknown("transport_ambiguity", (error && error.message) || String(error));
    }

    if (!raw || typeof raw !== "object" || !PROVIDER_OUTCOMES.includes(raw.outcome)) {
      return unknown("malformed_response_after_accepted_request",
        "the adapter returned something that is not a classified outcome");
    }
    if (raw.outcome === "definite_success" && !raw.providerResourceId) {
      // A "success" with no id is not usable, and the resource may exist.
      return unknown("malformed_response_after_accepted_request",
        "the adapter reported success without a provider resource id");
    }
    if (raw.outcome === "unknown" && !AMBIGUITY_REASONS.includes(raw.ambiguityReason)) {
      return unknown("transport_ambiguity", raw.detail || "the adapter reported unknown without a recognised reason");
    }
    return Object.freeze({ ...raw });
  }

  return Object.freeze({
    adapterName: name,
    isFake: adapter.isFake === true,
    createResource: (request) => invoke("createResource", request),
    updateResource: (request) => invoke("updateResource", request),
    retireResource: (request) => invoke("retireResource", request),
  });
}

// ── FAKE ADAPTERS ───────────────────────────────────────────────────
//
// The only adapters that exist. Each is explicitly marked `isFake: true`, and
// the executor records that marking on every execution, so a run against a
// real provider could never be mistaken for one of these afterwards.

/**
 * @param {object} behaviours  actionKey -> "definite_success" | "definite_failure" |
 *                             "unknown" | { outcome, ambiguityReason, detail, throws }
 */
function createFakeProviderAdapter({ behaviours = {}, name = "fake", idPrefix = "fake_res" } = {}) {
  const calls = [];
  const created = new Map();
  let counter = 0;

  const decide = (key) => behaviours[key] ?? behaviours["*"] ?? "definite_success";

  async function act(operation, request) {
    calls.push({ operation, request: { ...request } });
    const key = `${request.purpose}:${request.resourceType}`;
    const behaviour = decide(key);
    const spec = typeof behaviour === "string" ? { outcome: behaviour } : behaviour;

    if (spec.throws) throw new Error(spec.detail || "the fake adapter was told to throw");

    if (spec.outcome === "definite_failure") {
      return definiteFailure(spec.detail || "the fake adapter was told to refuse");
    }
    if (spec.outcome === "unknown") {
      return unknown(spec.ambiguityReason || "timeout_after_request_sent",
        spec.detail || "the fake adapter was told to be ambiguous");
    }
    if (spec.outcome === "malformed") {
      return { outcome: "definite_success" };   // no id — the port must catch this
    }

    // definite_success. A deterministic id derived from the request identity, so
    // a fake run is reproducible and a re-send is visibly the same request.
    const id = spec.providerResourceId || `${idPrefix}_${key.replace(/[^a-z_]/gi, "")}_${(counter += 1)}`;
    if (operation === "retireResource") {
      created.delete(request.providerResourceId);
      return definiteSuccess(request.providerResourceId, `retired via ${request.retirementMode}`);
    }
    if (operation === "updateResource") {
      // An UPDATE keeps the SAME provider id — that is what makes it an update.
      created.set(request.providerResourceId, { ...request });
      return definiteSuccess(request.providerResourceId, "updated in place");
    }
    created.set(id, { ...request });
    return definiteSuccess(id, "created");
  }

  return {
    isFake: true,
    name,
    calls,
    created,
    createResource: (r) => act("createResource", r),
    updateResource: (r) => act("updateResource", r),
    retireResource: (r) => act("retireResource", r),
  };
}

/** An adapter that refuses everything. Useful for proving nothing proceeds. */
function createRefusingProviderAdapter({ detail = "provider unavailable" } = {}) {
  return createFakeProviderAdapter({ name: "refusing", behaviours: { "*": { outcome: "definite_failure", detail } } });
}

module.exports = {
  createProviderMutationPort,
  createFakeProviderAdapter,
  createRefusingProviderAdapter,
  describeAdapterConformance,
  validateMutationRequest,
  definiteSuccess,
  definiteFailure,
  unknown,
  REQUIRED_ADAPTER_OPERATIONS,
  MUTATION_REQUEST_FIELDS,
};
