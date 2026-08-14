// AIDA Locksmith Acquisition — "does the agent already exist?" (E-12F).
//
//   await readAcquisitionAgentResource({ client })      → row | null
//   await recordAcquisitionAgentResource({ ... })       → the recorded row
//   describeAcquisitionProvisioningState(row)           → a founder-readable verdict
//
// ── THE QUESTION THIS ANSWERS ───────────────────────────────────────
// Before creating the acquisition agent, something must be able to say whether
// one already exists. Without that, a second run of the provisioning runner
// creates a second agent — and unlike a duplicate response engine, a duplicate
// AGENT is a thing that can telephone people.
//
// ── IT REUSES provider_resources. IT INVENTS NOTHING. ───────────────
// LPM3's table already models everything this needs, and one thing in
// particular that is better than anything an application check could offer:
//
//   pr_one_active_per_purpose
//     UNIQUE (client_id, provider, purpose, resource_type) WHERE active
//
// That is the one-agent guard, and it is enforced by the DATABASE. A second
// active acquisition agent is not "prevented by a check we remembered to
// write"; it is refused by an index. This module reads and writes through the
// existing `provider-resource-registry` helpers so the row shape stays the
// registry's business rather than becoming a second opinion about it.
//
// ── WHAT IS NOT DONE YET, AND SAYS SO ───────────────────────────────
// The database's `purpose` CHECK still lists only receptionist and onboarding
// values. Until supabase/sql/lpm4_acquisition_provider_resources.sql is applied
// by hand, an insert here is REJECTED BY POSTGRES. That is deliberate: the
// failure is loud and at the storage layer, rather than the app and the
// database quietly disagreeing about what may exist.
//
// ── NO TENANT, SO A NAMED SENTINEL ──────────────────────────────────
// `client_id` scopes every other resource to the locksmith who owns it.
// Acquisition is OUR outbound activity and belongs to no client, so it uses a
// reserved sentinel rather than borrowing a real tenant's slug — which would
// have filed our cold-calling agent under somebody's business.

const registry = require("./provider-resource-registry");

/** Acquisition belongs to no tenant. Reserved, and never a real clients.slug. */
const ACQUISITION_CLIENT_ID = "aida-acquisition";

const ACQUISITION_PROVIDER = "retell";
const AGENT_PURPOSE = "acquisition_agent";
const AGENT_RESOURCE_TYPE = "voice_agent";
const ENGINE_PURPOSE = "acquisition_response_engine";
const ENGINE_RESOURCE_TYPE = "response_engine";

/** The migration that must be applied before any of this can be stored. */
const REQUIRED_MIGRATION = "supabase/sql/lpm4_acquisition_provider_resources.sql";

const PROVISIONING_STATES = Object.freeze({
  NOT_PROVISIONED: "not_provisioned",
  PROVISIONED: "provisioned",
  RECONCILIATION_REQUIRED: "reconciliation_required",
  UNKNOWN: "unknown",
});

/** Lazy, per call — this module must be importable with no database at all. */
const db = (client) => client || require("./supabase");

/**
 * The active acquisition-agent record, or null.
 *
 * Reads only `active = true` rows: a superseded agent is history, not an
 * answer to "does one exist now?".
 */
async function readAcquisitionAgentResource({ client = null, clientId = ACQUISITION_CLIENT_ID } = {}) {
  const { data, error } = await db(client)
    .from(registry.TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("provider", ACQUISITION_PROVIDER)
    .eq("purpose", AGENT_PURPOSE)
    .eq("resource_type", AGENT_RESOURCE_TYPE)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    const err = new Error(`acquisition provisioning authority unreadable: ${error.message}`);
    err.code = "authority_unreadable";
    err.cause = error;
    throw err;
  }
  return data || null;
}

/**
 * Record an agent that the provider has ALREADY confirmed it created.
 *
 * Called only after a definite success with an id. There is no "record an
 * attempt" path on purpose: a row here asserts that a real agent exists at
 * Retell, and writing one before the provider confirmed would make the guard
 * refuse a create that never happened.
 */
async function recordAcquisitionAgentResource({
  client = null,
  clientId = ACQUISITION_CLIENT_ID,
  providerResourceId,
  providerVersion = null,
  providerTag = null,
  payload,
  idempotencyKey = null,
  now = () => new Date(),
} = {}) {
  if (!providerResourceId) throw new Error("an acquisition agent is only recorded after a confirmed provider success");
  if (!payload) throw new Error("recording an acquisition agent requires the exact payload that was sent");

  const { payloadHash } = require("./voice-platform-port");
  const fields = registry.buildResourceFields(
    {
      clientId,
      provider: ACQUISITION_PROVIDER,
      resourceType: AGENT_RESOURCE_TYPE,
      purpose: AGENT_PURPOSE,
      providerResourceId,
      providerVersion,
      providerTag,
      profileVersion: null,
      planId: null,
      idempotencyKey: idempotencyKey || `acq-agent-${providerResourceId}`,
      payloadHash: payloadHash(payload),
      metadata: null,
    },
    now().toISOString()
  );

  const { data, error } = await db(client).from(registry.TABLE).insert(fields).select().single();
  if (error) {
    const err = new Error(`acquisition agent could not be recorded: ${error.message}`);
    err.code = registry.uniqueViolation && registry.uniqueViolation(error) ? "already_provisioned" : "authority_write_failed";
    err.cause = error;
    err.requiredMigration = REQUIRED_MIGRATION;
    throw err;
  }
  return data;
}

/**
 * Turn a row (or its absence) into something a founder can act on.
 *
 * `reconciliation_required` is the state that matters. It describes the one
 * genuinely dangerous outcome: the provider created an agent and we failed to
 * record it, so the agent exists and nothing here knows its id. The correct
 * response is a human reading the Retell dashboard — never another create.
 */
function describeAcquisitionProvisioningState(row, { knownProviderId = null } = {}) {
  if (row && row.provider_resource_id) {
    return Object.freeze({
      state: PROVISIONING_STATES.PROVISIONED,
      providerResourceId: row.provider_resource_id,
      mayCreate: false,
      reason: "An acquisition agent is already recorded. A second one must never be created.",
    });
  }
  if (knownProviderId) {
    return Object.freeze({
      state: PROVISIONING_STATES.RECONCILIATION_REQUIRED,
      providerResourceId: knownProviderId,
      mayCreate: false,
      reason:
        "An agent id is known but no durable record exists — the provider succeeded and persistence did not. " +
        "Reconcile by hand. Do NOT create another agent.",
    });
  }
  return Object.freeze({
    state: PROVISIONING_STATES.NOT_PROVISIONED,
    providerResourceId: null,
    mayCreate: true,
    reason: "No acquisition agent is recorded.",
  });
}

/**
 * What to do when the provider's answer was lost.
 *
 * Deliberately NOT a retry, and deliberately not "assume nothing happened".
 * Retell may have created the agent and lost the reply on the way back.
 */
function describeAmbiguousCreate({ operation = "createAgent", providerRequestId = null } = {}) {
  return Object.freeze({
    state: PROVISIONING_STATES.UNKNOWN,
    operation,
    providerRequestId,
    mayCreate: false,
    retry: false,
    reason:
      "The provider's answer was lost. Whether the agent was created is UNKNOWN. " +
      "Look in the Retell dashboard before any further request. Do NOT retry.",
  });
}

module.exports = {
  ACQUISITION_CLIENT_ID,
  ACQUISITION_PROVIDER,
  AGENT_PURPOSE,
  AGENT_RESOURCE_TYPE,
  ENGINE_PURPOSE,
  ENGINE_RESOURCE_TYPE,
  REQUIRED_MIGRATION,
  PROVISIONING_STATES,
  readAcquisitionAgentResource,
  recordAcquisitionAgentResource,
  describeAcquisitionProvisioningState,
  describeAmbiguousCreate,
};
