// AIDA PLATFORM — the provisioning vocabulary (P19).
//
// ── THE RULE THIS SUBSYSTEM EXISTS TO ENFORCE ───────────────────────
//
//   ACTIVE CONFIGURATION IS NOT DEPLOYMENT.
//
// A configuration becoming active means AIDA now considers it current for that
// client. It creates no Retell agent, no response engine, no number, alters no
// routing and enables no call. Provisioning is a SEPARATE authority with its
// own plan, its own approval and its own execution gate:
//
//   active config -> desired state -> diff -> plan -> validate
//                 -> human review -> approve -> execution authority
//                 -> ONE provider mutation
//
// This batch builds everything up to and including approve. The last arrow
// does not exist, and nothing here can reach a provider.
//
// ── WHY EXPLICIT ENUMS RATHER THAN AN ACTION BLOB ───────────────────
// A plan is the thing a person says yes to before a machine changes a
// stranger's telephone service. "Here is some JSON, approve it" is not a
// review. Every concept below is a named, closed set so a plan can be
// rendered, diffed, hashed and argued with.

// ── PROVIDERS ───────────────────────────────────────────────────────
//
// This MIRRORS an existing database CHECK — provider_resources declares
// `check (provider in ('retell','mock','dry_run'))` — so the domain can refuse
// early what the database would refuse late. It is a vocabulary the schema
// already owns, not a dependency on a vendor: nothing here imports, calls or
// knows anything about Retell beyond the string being a permitted value, and
// `mock` and `dry_run` exist so a plan can be built and reviewed without a real
// vendor being involved at all.
//
// Kept as ONE named declaration so the boundary ratchet can exempt this single
// line and still fail on a provider being named anywhere else in the domain.
const PROVIDERS = Object.freeze(["retell", "mock", "dry_run"]);   // mirrors provider_resources CHECK

/**
 * ── PURPOSE AND TYPE (P19A) ─────────────────────────────────────────
 *
 * Deliberately the EXISTING vocabulary from voice-platform-port.js. A
 * platform-configured client is a receptionist; inventing
 * `platform_client_agent` beside `receptionist_agent` would create two
 * registries for one idea, and the founder's instruction was not to.
 *
 * The important consequence is a feature, not a clash. provider_resources
 * carries:
 *
 *   pr_one_active_per_purpose
 *     UNIQUE (client_id, provider, purpose, resource_type) WHERE active
 *
 * so if the legacy locksmith compiler and this platform both try to own one
 * client's receptionist agent, THE DATABASE REFUSES THE SECOND. That is
 * exactly right: a business has one receptionist, and two systems quietly
 * creating two agents is the failure this index was built to prevent. The
 * diff engine reports it as a conflict for a person rather than resolving it.
 *
 * Acquisition purposes are NOT in this list. Acquisition is AIDA's own
 * outbound activity under the reserved `aida-acquisition` client id, and a
 * client's provisioning must never be able to name one.
 */
const CLIENT_RESOURCE_PURPOSES = Object.freeze([
  "receptionist_agent",
  "receptionist_knowledge",
  "receptionist_analysis",
  "inbound_binding",
]);

/** Purposes this platform must never provision for a tenant. */
const FORBIDDEN_CLIENT_PURPOSES = Object.freeze([
  "acquisition_agent",
  "acquisition_response_engine",
  "onboarding_agent",
  "onboarding_analysis",
]);

const RESOURCE_TYPES = Object.freeze([
  "knowledge_base",
  "response_engine",
  "voice_agent",
  "analysis_schema",
  "phone_number_binding",
]);

/**
 * Which (purpose, type) pairs a client plan may contain, and whether this
 * batch actually produces one.
 *
 * `produced: false` is a decision with a reason, not an omission.
 */
const CLIENT_RESOURCE_SHAPES = Object.freeze([
  {
    purpose: "receptionist_agent",
    resourceType: "response_engine",
    produced: true,
    dependsOn: [],
    why: "The prompt lives on a response engine. E-10C established the hard way that sending prompt and agent as one object creates an agent with no brain.",
  },
  {
    purpose: "receptionist_agent",
    resourceType: "voice_agent",
    produced: true,
    dependsOn: [{ purpose: "receptionist_agent", resourceType: "response_engine" }],
    why: "The agent carries the voice and the webhook and REFERENCES the engine, so it cannot be built until the engine has a provider id.",
  },
  {
    purpose: "receptionist_analysis",
    resourceType: "analysis_schema",
    produced: false,
    dependsOn: [],
    why: "The provider carries post-call analysis ON THE AGENT itself rather than as a separate resource. Creating one would be inventing a resource that does not exist.",
  },
  {
    purpose: "receptionist_knowledge",
    resourceType: "knowledge_base",
    produced: false,
    dependsOn: [],
    why: "The platform compiles approved facts into the prompt. A knowledge base is a second place for a client's words to live, and two sources of truth about what a business claims is worse than one.",
  },
  {
    purpose: "inbound_binding",
    resourceType: "phone_number_binding",
    produced: false,
    dependsOn: [{ purpose: "receptionist_agent", resourceType: "voice_agent" }],
    why: "DELIBERATELY DEFERRED. A telephone number is a billable, portable, externally-visible asset with its own lifecycle; binding one is not part of the same transaction as writing a prompt. Readiness reports it as absent rather than a plan silently acquiring one.",
  },
]);

const PRODUCED_SHAPES = Object.freeze(CLIENT_RESOURCE_SHAPES.filter((s) => s.produced));

/**
 * Can a resource of this type be changed in place, or must a new one be made?
 *
 * This is a PROVIDER fact, not a preference. Getting it wrong in the
 * optimistic direction means an update that silently does nothing; getting it
 * wrong in the other means a duplicate resource.
 */
const RESOURCE_MUTABILITY = Object.freeze({
  response_engine: "updatable",
  voice_agent: "updatable",
  knowledge_base: "updatable",
  analysis_schema: "replace_only",
  phone_number_binding: "replace_only",
});

// ── ACTIONS ─────────────────────────────────────────────────────────
const PROVISIONING_ACTIONS = Object.freeze([
  "create",
  "update",
  "replace",
  "retire",
  "no_change",
  "reconcile_required",
]);

/** Actions that would cause a provider mutation if a plan were ever executed. */
const MUTATING_ACTIONS = Object.freeze(["create", "update", "replace", "retire"]);

// ── PLAN LIFECYCLE ──────────────────────────────────────────────────
//
// `executing`, `completed`, `failed` and `unknown` are declared but
// UNREACHABLE in this batch: nothing can execute. They exist now so the state
// machine is designed before anything can move through it, and so a later
// executor cannot invent a shape nobody reviewed.
const PLAN_STATUSES = Object.freeze([
  "draft",
  "validated",
  "approved",
  "executing",
  "completed",
  "failed",
  "unknown",
  "cancelled",
  "superseded",
]);

const PLAN_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "unknown", "cancelled", "superseded"]);
const PLAN_EXECUTION_STATUSES = Object.freeze(["executing", "completed", "failed", "unknown"]);

// ── PROVIDER OUTCOMES (P21A) ────────────────────────────────────────
//
// The acquisition lesson, generalised. A timeout does NOT mean nothing was
// created: the provider may have built the resource and lost the answer on the
// way back. Calling create again is how one authorised write becomes two
// agents, and unlike a duplicate response engine, a duplicate AGENT is a thing
// that can speak to a stranger.
const PROVIDER_OUTCOMES = Object.freeze([
  "definite_success",
  "definite_failure",
  "ambiguous",
  "provider_success_persist_failed",
  "durable_exists_provider_unverified",
]);

/** What each outcome means for the resource, and what may happen next. */
const OUTCOME_RULES = Object.freeze({
  definite_success: {
    resourceState: "recorded",
    mayRetryCreate: false,
    requiresHuman: false,
    note: "The provider confirmed, and the id was recorded.",
  },
  definite_failure: {
    resourceState: "absent",
    // The ONLY outcome from which a create may be re-attempted, because the
    // provider explicitly said it did not happen.
    mayRetryCreate: true,
    requiresHuman: false,
    note: "The provider explicitly refused. Nothing exists remotely.",
  },
  ambiguous: {
    resourceState: "unknown",
    mayRetryCreate: false,
    requiresHuman: true,
    note: "A timeout or lost response. The resource may or may not exist. LOOK before anybody sends anything else.",
  },
  provider_success_persist_failed: {
    resourceState: "unknown",
    mayRetryCreate: false,
    requiresHuman: true,
    note: "The provider created it and the durable write failed. An unrecorded resource that EXISTS is far more dangerous than a recorded one that does not.",
  },
  durable_exists_provider_unverified: {
    resourceState: "unknown",
    mayRetryCreate: false,
    requiresHuman: false,
    note: "The registry says it exists. Nobody has asked the provider. A database row is not proof a remote resource is still there.",
  },
});

/** A resource's believed state, as distinct from what a plan wants to do. */
const RESOURCE_STATES = Object.freeze(["absent", "recorded", "unknown", "retired"]);

// ── RECONCILIATION (P21B) ───────────────────────────────────────────
const RECONCILIATION_RESULTS = Object.freeze([
  "match",
  "drift",
  "missing_provider_resource",
  "unrecorded_provider_resource",
  "unknown",
  "manual_review_required",
]);

const RECONCILIATION_MEANING = Object.freeze({
  match: "The registry and the provider agree, including the payload hash.",
  drift: "Both exist and disagree. Somebody changed the resource outside AIDA, or a write half-landed.",
  missing_provider_resource: "The registry says it exists and the provider says it does not.",
  unrecorded_provider_resource: "The provider has a resource AIDA never recorded. Never adopt one automatically — it may belong to something else entirely.",
  unknown: "The provider could not be asked. Not the same as 'nothing there'.",
  manual_review_required: "Something a person must look at before anything else happens.",
});

// ── VALIDATION ──────────────────────────────────────────────────────

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/**
 * Credential shapes, named only in order to REFUSE them. Kept as ONE named
 * declaration so the boundary ratchet can exempt this single line and still
 * fail on a credential appearing anywhere else in src/platform — exactly the
 * treatment PROVIDER_VOICE_ID_PREFIXES gets in client-blueprint.js.
 */
const CREDENTIAL_SHAPED = /(api[_-]?key|"authorization"|bearer\s|sk_live|sk_test)/i;

/** Is this a (purpose, type) pair a CLIENT plan may legitimately contain? */
function describeResourceShape(purpose, resourceType) {
  if (FORBIDDEN_CLIENT_PURPOSES.includes(purpose)) {
    return { ok: false, reason: `"${purpose}" is not a client purpose — it belongs to another authority` };
  }
  if (!CLIENT_RESOURCE_PURPOSES.includes(purpose)) {
    return { ok: false, reason: `"${purpose}" is not a known client resource purpose` };
  }
  if (!RESOURCE_TYPES.includes(resourceType)) {
    return { ok: false, reason: `"${resourceType}" is not a known resource type` };
  }
  const shape = CLIENT_RESOURCE_SHAPES.find((s) => s.purpose === purpose && s.resourceType === resourceType);
  if (!shape) {
    return { ok: false, reason: `"${purpose}" does not use a "${resourceType}"` };
  }
  return { ok: true, shape };
}

/** A desired resource, checked before it can enter a plan. */
function validateDesiredResource(resource) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  if (!resource || typeof resource !== "object") {
    return { ok: false, errors: [{ field: "", message: "a desired resource must be an object" }] };
  }
  if (!isStr(resource.clientId)) err("clientId", "required");
  if (!Number.isInteger(resource.configVersion) || resource.configVersion < 1) err("configVersion", "positive integer required");
  if (!isHash(resource.behaviourHash)) err("behaviourHash", "64-char sha256 required");
  if (!isHash(resource.payloadHash)) err("payloadHash", "64-char sha256 required");
  if (!isHash(resource.dependencyHash)) err("dependencyHash", "64-char sha256 required");
  if (!PROVIDERS.includes(resource.provider)) err("provider", `one of ${PROVIDERS.join(", ")}`);

  const shape = describeResourceShape(resource.purpose, resource.resourceType);
  if (!shape.ok) err("purpose/resourceType", shape.reason);

  if (!resource.payload || typeof resource.payload !== "object") err("payload", "required");
  if (!Array.isArray(resource.dependsOn)) err("dependsOn", "must be an array");

  // The one that matters most: a desired payload must never carry a credential.
  const asText = JSON.stringify(resource.payload || {});
  if (CREDENTIAL_SHAPED.test(asText)) {
    err("payload", "a desired payload must never contain a credential");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  PROVIDERS,
  CLIENT_RESOURCE_PURPOSES,
  FORBIDDEN_CLIENT_PURPOSES,
  RESOURCE_TYPES,
  CLIENT_RESOURCE_SHAPES,
  PRODUCED_SHAPES,
  RESOURCE_MUTABILITY,
  PROVISIONING_ACTIONS,
  MUTATING_ACTIONS,
  PLAN_STATUSES,
  PLAN_TERMINAL_STATUSES,
  PLAN_EXECUTION_STATUSES,
  PROVIDER_OUTCOMES,
  OUTCOME_RULES,
  RESOURCE_STATES,
  RECONCILIATION_RESULTS,
  RECONCILIATION_MEANING,
  describeResourceShape,
  validateDesiredResource,
};
