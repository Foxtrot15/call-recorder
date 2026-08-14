// AIDA — provider-resource registry (M3).
//
// What AIDA believes exists at a provider, and why. This is the record that
// makes provisioning idempotent: the plan diffs against it, execution writes to
// it only after a confirmed success, and superseding is a state change rather
// than a delete.
//
// RULES
//   * NEVER stores an API key. Nothing in a registry row is a credential.
//   * At most ONE active resource per (client, provider, purpose, type) —
//     enforced by a partial unique index in SQL, not just here.
//   * History is preserved. Superseding sets a flag and a timestamp; nothing is
//     physically deleted during ordinary operation.
//   * Provider metadata is bounded and scrubbed before storage.
//   * Provider ids are internal. They are not exposed to clients, and the
//     founder console masks them.
//
// Table: supabase/sql/lpm3_create_retell_provisioning.sql (REVIEW ONLY).
// Pure builders + thin lazy-require adapter, house style.

const { redactSecrets } = require("../config/retell");

const TABLE = "provider_resources";
const MAX_METADATA_BYTES = 4 * 1024;

const RESOURCE_TYPES = Object.freeze([
  "knowledge_base",
  "response_engine",
  "voice_agent",
  "analysis_schema",
  "phone_number_binding",
]);

const PURPOSES = Object.freeze([
  "onboarding_agent",
  "receptionist_agent",
  "receptionist_knowledge",
  "receptionist_analysis",
  "onboarding_analysis",
  "inbound_binding",
  // ── E-12F: cold acquisition ──
  // Added to the ALLOWLIST only. Acquisition is deliberately not in
  // provisioning-plan.js's DESIRED_RESOURCE_ORDER — that list is three
  // hardcoded receptionist entries — so naming a purpose here cannot cause
  // anything to be provisioned as a side effect of planning a receptionist.
  //
  // The database carries the same list as a CHECK constraint, and until
  // supabase/sql/lpm4_acquisition_provider_resources.sql is applied by hand it
  // will REJECT these two values. That is the correct failure: the app may
  // build the row, and the database refuses to store it, rather than either
  // side quietly disagreeing.
  "acquisition_agent",
  "acquisition_response_engine",
]);

/**
 * Bound and scrub provider metadata before it is stored. Provider bodies are
 * not ours and may contain anything; we keep a small, redacted subset.
 */
function boundMetadata(raw) {
  if (!raw || typeof raw !== "object") return null;
  const scrubbed = redactSecrets(raw);
  let serialised = JSON.stringify(scrubbed);
  if (serialised.length > MAX_METADATA_BYTES) {
    return { truncated: true, note: `provider metadata exceeded ${MAX_METADATA_BYTES} bytes and was dropped` };
  }
  return scrubbed;
}

/** Column payload for a newly provisioned resource. */
function buildResourceFields({
  clientId,
  provider,
  resourceType,
  purpose,
  providerResourceId,
  providerVersion = null,
  providerTag = null,
  profileVersion,
  planId = null,
  idempotencyKey,
  payloadHash,
  metadata = null,
}, nowIso = new Date().toISOString()) {
  if (!clientId) throw new Error("provider resource requires clientId");
  if (!RESOURCE_TYPES.includes(resourceType)) throw new Error(`unknown resource type "${resourceType}"`);
  if (!PURPOSES.includes(purpose)) throw new Error(`unknown purpose "${purpose}"`);
  if (!providerResourceId) throw new Error("a provider resource id is only recorded after a confirmed success");
  if (!idempotencyKey) throw new Error("provider resource requires an idempotency key");

  return {
    client_id: clientId,
    provider,
    resource_type: resourceType,
    purpose,
    provider_resource_id: String(providerResourceId).slice(0, 200),
    provider_version: providerVersion === null || providerVersion === undefined ? null : String(providerVersion).slice(0, 50),
    provider_tag: providerTag ? String(providerTag).slice(0, 50) : null,
    active: true,
    profile_version: profileVersion,
    provisioning_plan_id: planId,
    idempotency_key: String(idempotencyKey).slice(0, 100),
    payload_hash: payloadHash,
    provider_metadata: boundMetadata(metadata),
    created_at: nowIso,
    updated_at: nowIso,
    superseded_at: null,
    last_synced_at: nowIso,
    last_failure_code: null,
    last_failure_at: null,
  };
}

/** Column payload for superseding. History is kept; only the flag moves. */
function buildSupersedeFields({ supersededByPlanId = null } = {}, nowIso = new Date().toISOString()) {
  return {
    active: false,
    superseded_at: nowIso,
    updated_at: nowIso,
    superseded_by_plan_id: supersededByPlanId,
  };
}

function buildFailureFields({ code }, nowIso = new Date().toISOString()) {
  return {
    last_failure_code: String(code || "unknown").slice(0, 100),
    last_failure_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Shape for the founder console. The provider id is MASKED — an operator needs
 * to know a resource exists and roughly which one, not to be able to copy an id
 * out of a screenshot.
 */
function toOperatorResource(row) {
  if (!row) return null;
  const id = row.provider_resource_id || "";
  return Object.freeze({
    provider: row.provider,
    resourceType: row.resource_type,
    purpose: row.purpose,
    providerResourceIdMasked: id ? `${id.slice(0, 6)}…${id.slice(-4)}` : null,
    providerVersion: row.provider_version || null,
    providerTag: row.provider_tag || null,
    active: row.active !== false,
    profileVersion: row.profile_version || null,
    payloadHash: row.payload_hash ? row.payload_hash.slice(0, 12) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededAt: row.superseded_at || null,
    lastSyncedAt: row.last_synced_at || null,
    lastFailureCode: row.last_failure_code || null,
  });
}

/** Clients never see provider internals at all — only that setup has happened. */
function toClientResourceSummary(rows) {
  const active = (rows || []).filter((r) => r.active !== false);
  return Object.freeze({
    configured: active.length > 0,
    resourceCount: active.length,
    profileVersion: active.length ? active[0].profile_version : null,
  });
}

// ── DB adapter ──────────────────────────────────────────────────────

const { tableMissing: m2TableMissing } = require("./locksmith-profile-store");

function tableMissing(error) {
  return Boolean(error && (error.code === "42P01" || /provider_resources|provisioning_plans|provider_webhook_events.*does not exist/i.test(error.message || ""))) || m2TableMissing(error);
}

function provisioningError() {
  return new Error("provider provisioning tables not provisioned — apply supabase/sql/lpm3_create_retell_provisioning.sql first");
}

async function listResources(clientId, { provider = "retell", activeOnly = false } = {}) {
  const supabase = require("./supabase");
  let query = supabase.from(TABLE).select("*").eq("client_id", clientId).eq("provider", provider);
  if (activeOnly) query = query.eq("active", true);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`provider resource lookup failed: ${error.message}`);
  }
  return data || [];
}

/**
 * Record a confirmed-successful provisioning. Supersedes any existing active
 * row for the same purpose+type first, so the partial unique index can never be
 * violated and history is preserved in one step.
 */
async function recordProvisionedResource(fields, { supersedeExisting = true } = {}) {
  const supabase = require("./supabase");

  if (supersedeExisting) {
    const { error: supersedeError } = await supabase
      .from(TABLE)
      .update(buildSupersedeFields({ supersededByPlanId: fields.provisioning_plan_id }))
      .eq("client_id", fields.client_id)
      .eq("provider", fields.provider)
      .eq("purpose", fields.purpose)
      .eq("resource_type", fields.resource_type)
      .eq("active", true);
    if (supersedeError && !tableMissing(supersedeError)) {
      throw new Error(`superseding the previous resource failed: ${supersedeError.message}`);
    }
    if (supersedeError && tableMissing(supersedeError)) throw provisioningError();
  }

  const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`recording the provider resource failed: ${error.message}`);
  }
  return data;
}

/** Which idempotency keys have already succeeded — the resume set. */
async function completedIdempotencyKeys(clientId, { provider = "retell" } = {}) {
  const rows = await listResources(clientId, { provider });
  return new Set(rows.map((r) => r.idempotency_key).filter(Boolean));
}

async function recordFailure(clientId, { purpose, resourceType, provider = "retell", code }) {
  const supabase = require("./supabase");
  const { error } = await supabase
    .from(TABLE)
    .update(buildFailureFields({ code }))
    .eq("client_id", clientId)
    .eq("provider", provider)
    .eq("purpose", purpose)
    .eq("resource_type", resourceType)
    .eq("active", true);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`recording the provider failure failed: ${error.message}`);
  }
  return true;
}

module.exports = {
  TABLE,
  RESOURCE_TYPES,
  PURPOSES,
  MAX_METADATA_BYTES,
  boundMetadata,
  buildResourceFields,
  buildSupersedeFields,
  buildFailureFields,
  toOperatorResource,
  toClientResourceSummary,
  tableMissing,
  provisioningError,
  listResources,
  recordProvisionedResource,
  completedIdempotencyKeys,
  recordFailure,
};
