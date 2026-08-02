// AIDA — inbound client resolution (M7F-B1).
//
// ─── THE QUESTION ───────────────────────────────────────────────────
// A phone rings. Retell tells us one thing we can trust: which agent_id the
// call is for. From that alone we must decide WHOSE call this is, and therefore
// whose transfer number the agent may be given.
//
// Getting this wrong is the worst failure mode in the product. A caller offered
// the wrong locksmith's number does not hear an error — the call sounds
// completely normal, and someone's 3am emergency is routed to a stranger.
//
// ─── WHAT IS TRUSTED, AND WHAT IS NOT ───────────────────────────────
// TRUSTED:  agent_id, and only because the request carrying it was
//           signature-verified against our API key before this module ran.
// NOT TRUSTED, ever:
//   * any client id appearing in the request body. The documented inbound
//     payload carries none, and if a future one did, it would be provider- or
//     caller-influenced rather than ours.
//   * dynamic variables. Those are our OUTPUT, never our input.
//   * business name, phone text, SIP headers, prompt content. Ownership is a
//     database fact, not something inferred from prose.
//
// ─── ONE MAPPING SOURCE ─────────────────────────────────────────────
// `provider_resources` is the canonical registry and this module adds no second
// identity model. The chain is:
//
//   agent_id → provider_resources (purpose receptionist_agent, type voice_agent)
//            → client_id + profile_version
//            → the client's APPROVED profile
//            → transfer configuration
//
// ─── THE CONSTRAINT THAT DOES NOT EXIST ─────────────────────────────
// `pr_one_active_per_purpose` is unique on (client_id, provider, purpose,
// resource_type). It guarantees one active agent PER CLIENT. It does NOT
// guarantee one client per agent — there is no unique constraint, and no index,
// on provider_resource_id.
//
// So the database will happily hold the same agent under two tenants, and this
// module must be the thing that notices. Every ambiguity is REFUSED. Nothing
// here picks a winner, sorts by recency, or prefers the "more complete" row:
// when the mapping is not certain, no variables are emitted at all.
//
// Pure + dep-free. All data access is injected, so this never imports Supabase
// and can be driven entirely from fixtures.

const RESOLVER_VERSION = "retell-inbound-resolver-2026-08-02";

/** Every outcome this resolver can produce. Exhaustive on purpose. */
const RESOLUTION = Object.freeze({
  resolved: "resolved",
  unknownAgent: "unknown_agent",
  ambiguousAgent: "ambiguous_agent",
  supersededAgent: "superseded_agent",
  wrongEnvironment: "wrong_environment",
  inactiveClient: "inactive_client",
  unapprovedProfile: "unapproved_profile",
  registryUnavailable: "registry_unavailable",
});

/** Only a receptionist voice agent may answer an inbound customer call. */
const EXPECTED_PURPOSE = "receptionist_agent";
const EXPECTED_RESOURCE_TYPE = "voice_agent";

function outcome(resolution, { detail = null, clientId = null, context = null, versionDrift = false } = {}) {
  return Object.freeze({
    ok: resolution === RESOLUTION.resolved,
    resolution,
    // Present ONLY when resolved. A refusal never names a tenant, so a log line
    // about a failed resolution cannot become a tenant-existence oracle.
    clientId: resolution === RESOLUTION.resolved ? clientId : null,
    context,
    // Short, constant-ish, never containing caller data or a phone number.
    detail,
    versionDrift,
    version: RESOLVER_VERSION,
  });
}

/**
 * Build the resolver.
 *
 * @param {object} access                     the injected data-access boundary
 * @param {Function} access.findResourcesByProviderId
 *        async (agentId, opts) => rows[]. MUST return every match across all
 *        clients, active and inactive, or ambiguity becomes invisible.
 * @param {Function} access.getApprovedProfile
 *        async (clientId) => { version, status, profile } | null
 * @param {Function} [access.getClientStatus]
 *        async (clientId) => { active: boolean } | null. Optional: when absent,
 *        a client is treated as active, which is the pre-existing behaviour
 *        everywhere else in the product.
 * @param {string} [expectedTag]  the environment tag this deployment may serve.
 */
function createInboundResolver({ access, expectedTag = null, logger = console } = {}) {
  if (!access || typeof access.findResourcesByProviderId !== "function") {
    throw new Error("the inbound resolver requires access.findResourcesByProviderId");
  }
  if (typeof access.getApprovedProfile !== "function") {
    throw new Error("the inbound resolver requires access.getApprovedProfile");
  }

  /**
   * @param {object} identity
   * @param {string} identity.agentId       from the verified request
   * @param {number} [identity.agentVersion]
   * @param {string} [identity.callId]      PROVENANCE ONLY — never ownership
   */
  return async function resolveInboundContext({ agentId, agentVersion = null, callId = null } = {}) {
    if (!agentId || typeof agentId !== "string") {
      return outcome(RESOLUTION.unknownAgent, { detail: "no agent id was supplied" });
    }

    // ── 1. Reverse lookup ─────────────────────────────────────────
    let rows;
    try {
      rows = await access.findResourcesByProviderId(agentId, {
        provider: "retell",
        resourceType: EXPECTED_RESOURCE_TYPE,
        purpose: EXPECTED_PURPOSE,
      });
    } catch (err) {
      // The registry being unreachable is NOT the same as the agent being
      // unknown, and conflating them would turn an outage into a silent
      // misclassification. Reported distinctly so an operator can tell them
      // apart; the caller-facing behaviour is identical either way.
      logger.error(`retell.inbound.registry_unavailable code=${/not provisioned/i.test(err.message) ? "not_provisioned" : "query_failed"}`);
      return outcome(RESOLUTION.registryUnavailable, { detail: "the provider registry could not be read" });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return outcome(RESOLUTION.unknownAgent, { detail: "no registry row names this agent" });
    }

    // ── 2. Ambiguity, before anything else is considered ──────────
    const active = rows.filter((r) => r && r.active !== false);

    if (active.length === 0) {
      // Rows exist but none is active: this agent was replaced by a later
      // provisioning run. Distinct from "unknown" because it means a stale
      // number binding is still pointing at a retired agent — an operator
      // problem with a specific fix, not a mystery.
      return outcome(RESOLUTION.supersededAgent, { detail: `${rows.length} registry row(s) exist but none is active` });
    }

    const distinctClients = new Set(active.map((r) => r.client_id));
    if (distinctClients.size > 1) {
      // THE ONE THAT MATTERS. Never pick a winner.
      logger.error(`retell.inbound.ambiguous_agent clients=${distinctClients.size}`);
      return outcome(RESOLUTION.ambiguousAgent, { detail: `${distinctClients.size} clients claim this agent` });
    }
    if (active.length > 1) {
      // Same client, several active rows. The partial unique index should make
      // this impossible; if it happens the index is missing or disabled, and
      // trusting the data would be unwise.
      logger.error("retell.inbound.ambiguous_agent duplicate_active_rows");
      return outcome(RESOLUTION.ambiguousAgent, { detail: `${active.length} active rows for one client` });
    }

    const row = active[0];
    const clientId = row.client_id;
    if (!clientId) {
      return outcome(RESOLUTION.ambiguousAgent, { detail: "the registry row names no client" });
    }

    // ── 3. Environment ────────────────────────────────────────────
    // A dev agent must never be served by production, and vice versa. Checked
    // before any client data is loaded, so a cross-environment request cannot
    // even cause a profile read.
    if (expectedTag) {
      const rowTag = row.provider_tag || null;
      if (rowTag !== expectedTag) {
        logger.error(`retell.inbound.wrong_environment expected=${expectedTag} got=${rowTag || "none"}`);
        return outcome(RESOLUTION.wrongEnvironment, { detail: `resource tag ${rowTag || "unset"} does not match ${expectedTag}` });
      }
    }

    // ── 4. Client status ──────────────────────────────────────────
    if (typeof access.getClientStatus === "function") {
      let status;
      try {
        status = await access.getClientStatus(clientId);
      } catch {
        return outcome(RESOLUTION.registryUnavailable, { detail: "the client record could not be read" });
      }
      if (status && status.active === false) {
        return outcome(RESOLUTION.inactiveClient, { detail: "the client is not active" });
      }
    }

    // ── 5. Approved profile ───────────────────────────────────────
    // Client-specific runtime values come from an APPROVED profile or from
    // nowhere. A draft is, by definition, configuration nobody has agreed to
    // put in front of a caller.
    let approved;
    try {
      approved = await access.getApprovedProfile(clientId);
    } catch {
      return outcome(RESOLUTION.registryUnavailable, { detail: "the approved profile could not be read" });
    }
    if (!approved || !approved.profile) {
      return outcome(RESOLUTION.unapprovedProfile, { detail: "no approved profile exists for this client" });
    }
    if (approved.status && approved.status !== "approved") {
      return outcome(RESOLUTION.unapprovedProfile, { detail: `the newest profile is "${approved.status}", not approved` });
    }

    // ── 6. Version drift, reported but not fatal ──────────────────
    // The agent was updated at the provider since we recorded it. The IDENTITY
    // is not in doubt — it is the same resource under the same id — so refusing
    // would degrade a call over a bookkeeping difference. Surfaced for audit.
    const recordedVersion = row.provider_version === null || row.provider_version === undefined ? null : String(row.provider_version);
    const liveVersion = agentVersion === null || agentVersion === undefined ? null : String(agentVersion);
    const versionDrift = Boolean(recordedVersion !== null && liveVersion !== null && recordedVersion !== liveVersion);
    if (versionDrift) logger.error(`retell.inbound.version_drift recorded=${recordedVersion} live=${liveVersion}`);

    // ── 7. The minimum needed to build runtime variables ──────────
    // Deliberately narrow. The inbound webhook needs transfer routing and
    // nothing else; handing it the whole profile would put a business's entire
    // configuration one mistake away from a provider payload.
    const transfer = (approved.profile && approved.profile.transfer) || {};

    return outcome(RESOLUTION.resolved, {
      clientId,
      versionDrift,
      context: Object.freeze({
        clientId,
        profileVersion: approved.version || row.profile_version || null,
        // CANONICAL E.164. The variable builder derives the spoken form; this
        // module never formats a number and never emits one to the model.
        transferPrimary: transfer.primaryNumber || null,
        transferBackup: transfer.backupNumber || null,
        environment: row.provider_tag || null,
        // Provenance only. Recorded so an audit row can be tied to a call; it
        // plays no part in deciding ownership.
        callId: callId || null,
      }),
    });
  };
}

/**
 * The default production data-access boundary.
 *
 * Lazily required so the resolver module itself stays dep-free and the whole
 * decision path remains testable on a checkout with no database and no
 * node_modules.
 */
function createRegistryAccess() {
  return {
    async findResourcesByProviderId(agentId, opts) {
      return require("./provider-resource-registry").findResourcesByProviderId(agentId, opts);
    },
    async getApprovedProfile(clientId) {
      const row = await require("./locksmith-profile-store").getApprovedVersion(clientId);
      if (!row) return null;
      return { version: row.version, status: row.status, profile: row.profile };
    },
  };
}

module.exports = {
  RESOLVER_VERSION,
  RESOLUTION,
  EXPECTED_PURPOSE,
  EXPECTED_RESOURCE_TYPE,
  createInboundResolver,
  createRegistryAccess,
};
