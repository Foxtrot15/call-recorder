// AIDA PLATFORM — recording what now exists at a provider (P26).
//
//   createResourceRegistryWriter({ registry, now })
//     .recordProvisioned / recordRetired / listForClient
//
// ── THE DANGEROUS HALF ──────────────────────────────────────────────
// The provider call is the part everybody worries about. This is the part that
// actually loses things: the provider has confirmed, a resource EXISTS, and
// AIDA must write down what it is. If that write fails, the resource is real
// and unrecorded — and an unrecorded resource that exists is far more
// dangerous than a recorded one that does not, because nothing will ever
// reconcile something it has no idea about.
//
// So a failure here does NOT roll anything back and does NOT retry the
// provider. It returns a failure carrying the provider resource id as loudly
// as a return value can, and the executor turns that into
// `persist_failed_after_provider_success`, which blocks every future execution
// for that client until a person records it.
//
// ── ONE REGISTRY, NOT A SECOND ──────────────────────────────────────
// This writes to `provider_resources` — the canonical registry that already
// exists, with the purposes and resource types that already exist. It respects
// `pr_one_active_per_purpose`: at most one active resource per
// (client, provider, purpose, resource_type). Superseding is a flag and a
// timestamp, never a delete, so history survives.
//
// The registry handle is INJECTED. This module imports no database client.

const { RETIREMENT_MODES, RETIREMENT_MEANING } = require("./execution-model");

const REGISTRY_CODES = Object.freeze({
  OK: "ok",
  INVALID: "registry_record_invalid",
  CONFLICT: "an_active_resource_already_exists_for_this_purpose",
  CROSS_TENANT: "cross_tenant_registry_write_refused",
  // The one that matters. Never conflated with a provider failure.
  PERSIST_FAILED: "registry_persist_failed_after_provider_success",
});

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });
const okay = (value) => Object.freeze({ ok: true, code: REGISTRY_CODES.OK, ...value });

/**
 * An in-memory provider_resources, enforcing the constraint that matters.
 * A fake that allowed two active rows per purpose would let the tests pass
 * while the guarantee lived only in an index nobody exercised.
 */
function createInMemoryResourceRegistry() {
  const rows = [];
  const state = { failNextWrite: null };
  return {
    kind: "memory",
    _failNextWrite(message) { state.failNextWrite = message; },
    _rows() { return rows.map((r) => ({ ...r })); },

    async listForClient(clientId) {
      return rows.filter((r) => r.client_id === clientId).map((r) => ({ ...r }));
    },

    async insert(row) {
      if (state.failNextWrite) { const m = state.failNextWrite; state.failNextWrite = null; throw new Error(m); }
      // pr_one_active_per_purpose
      if (row.active !== false) {
        const clash = rows.find(
          (r) => r.active !== false
            && r.client_id === row.client_id && r.provider === row.provider
            && r.purpose === row.purpose && r.resource_type === row.resource_type,
        );
        if (clash) {
          const error = new Error(
            `pr_one_active_per_purpose: ${row.client_id} already has an active ${row.purpose}/${row.resource_type}`,
          );
          error.code = "23505";
          error.constraint = "pr_one_active_per_purpose";
          throw error;
        }
      }
      rows.push({ ...row });
      return { ...row };
    },

    async supersede({ clientId, provider, purpose, resourceType, at }) {
      if (state.failNextWrite) { const m = state.failNextWrite; state.failNextWrite = null; throw new Error(m); }
      let n = 0;
      for (const r of rows) {
        if (r.active !== false && r.client_id === clientId && r.provider === provider
            && r.purpose === purpose && r.resource_type === resourceType) {
          r.active = false;
          r.superseded_at = at;
          n += 1;
        }
      }
      return n;
    },
  };
}

function createResourceRegistryWriter({ registry, now } = {}) {
  if (!registry || typeof registry.insert !== "function") {
    throw new Error("createResourceRegistryWriter requires an injected registry");
  }
  if (typeof now !== "function") throw new Error("createResourceRegistryWriter requires an injected now()");
  const stamp = () => now().toISOString();

  /**
   * Record a resource that the provider has DEFINITELY confirmed.
   *
   * @param {string} actionKind create | update | replace
   */
  async function recordProvisioned({
    clientId, provider, providerTag, purpose, resourceType,
    providerResourceId, payloadHash, provenance, actionKind, idempotencyKey,
  }) {
    if (!clientId || !providerResourceId || !payloadHash) {
      return fail(REGISTRY_CODES.INVALID, "clientId, providerResourceId and payloadHash are required");
    }
    if (provenance && provenance.clientId && provenance.clientId !== clientId) {
      return fail(REGISTRY_CODES.CROSS_TENANT, "the provenance names a different client");
    }

    const at = stamp();
    const row = {
      client_id: clientId,
      provider,
      provider_tag: providerTag ?? null,
      purpose,
      resource_type: resourceType,
      provider_resource_id: providerResourceId,
      payload_hash: payloadHash,
      active: true,
      idempotency_key: idempotencyKey ?? null,
      created_at: at,
      superseded_at: null,
      // The last provisioning outcome AIDA believes. The diff engine treats
      // anything but a definite success as untrustworthy.
      last_outcome: "definite_success",
      // Provenance in the EXISTING bounded jsonb column, so config-to-resource
      // traceability needs no schema change.
      provider_metadata: {
        producedBy: "aida-client-platform",
        clientId,
        configVersion: provenance ? provenance.configVersion : null,
        behaviourHash: provenance ? provenance.behaviourHash : null,
        payloadHash,
        schemaVersion: provenance ? provenance.schemaVersion : null,
        compilerVersion: provenance ? provenance.compilerVersion : null,
        actionKind,
        recordedAt: at,
      },
    };

    try {
      // An UPDATE keeps the same provider id, so the incumbent row for this
      // purpose is superseded and a fresh row records the new payload hash.
      // A REPLACE has a NEW provider id, and the old resource is retired by a
      // SEPARATE action — never implicitly here.
      if (actionKind === "update" || actionKind === "replace") {
        await registry.supersede({ clientId, provider, purpose, resourceType, at });
      }
      const written = await registry.insert(row);
      return okay({ row: written, providerResourceId });
    } catch (error) {
      if (error && error.code === "23505") {
        return fail(REGISTRY_CODES.CONFLICT, error.message, { providerResourceId, constraint: error.constraint });
      }
      // ── THE LOUD ONE ──
      // The provider succeeded. The write did not. The resource EXISTS.
      return fail(
        REGISTRY_CODES.PERSIST_FAILED,
        `THE PROVIDER RESOURCE EXISTS AND WAS NOT RECORDED. provider_resource_id=${providerResourceId} ` +
        `client=${clientId} purpose=${purpose} type=${resourceType}. Record it by hand. DO NOT re-run the provider mutation.`,
        {
          providerResourceId,
          clientId, purpose, resourceType, provider, providerTag: providerTag ?? null,
          payloadHash,
          cause: (error && error.message) || String(error),
          doNotRetryProvider: true,
        },
      );
    }
  }

  /**
   * Record a retirement. The MODE is explicit and never inferred: "retired"
   * means three different things depending on what the provider can do, and a
   * model that flattens them lies about whether the resource is still serving
   * traffic.
   */
  async function recordRetired({ clientId, provider, purpose, resourceType, providerResourceId, retirementMode }) {
    if (!RETIREMENT_MODES.includes(retirementMode)) {
      return fail(REGISTRY_CODES.INVALID, `retirementMode must be one of ${RETIREMENT_MODES.join(", ")}`);
    }
    const at = stamp();
    try {
      const n = await registry.supersede({ clientId, provider, purpose, resourceType, at });
      return okay({
        supersededRows: n,
        retirementMode,
        meaning: RETIREMENT_MEANING[retirementMode],
        // Said explicitly, because `registry_inactive` is the one people
        // misread as "it is gone".
        providerStillServing: retirementMode === "registry_inactive",
        providerResourceId: providerResourceId ?? null,
      });
    } catch (error) {
      return fail(REGISTRY_CODES.PERSIST_FAILED,
        `retirement was not recorded: ${(error && error.message) || error}`,
        { providerResourceId, doNotRetryProvider: true });
    }
  }

  async function listForClient(clientId) {
    return registry.listForClient(clientId);
  }

  return Object.freeze({ recordProvisioned, recordRetired, listForClient });
}

module.exports = { createResourceRegistryWriter, createInMemoryResourceRegistry, REGISTRY_CODES };
