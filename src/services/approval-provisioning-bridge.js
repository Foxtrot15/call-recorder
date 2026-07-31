// AIDA — approval → provisioning bridge (M4).
//
// When a locksmith approves their profile, this generates (or refreshes) the
// deterministic provisioning plan and marks the journey provisioning-ready.
//
// WHAT IT DOES NOT DO: execute anything. Approval makes a configuration
// ELIGIBLE to be built; a human operator still has to run it, and the M3
// execution gate still has to pass. Nothing here can reach a provider.
//
// Plan staleness is handled here too: if the client later changes their
// profile, the old plan is superseded rather than left looking current.

const { getRetellConfig } = require("../config/retell");
const { compileReceptionist, toRetellPayload } = require("./locksmith-receptionist-compiler");
const plans = require("./provisioning-plan");
const registry = require("./provider-resource-registry");
const store = require("./locksmith-profile-store");
const { assessProvisioning } = require("./locksmith-profile");
const { buildAuditEvent } = require("./locksmith-profile-store");

const TABLE = "provisioning_plans";

const BRIDGE_OUTCOMES = Object.freeze({
  ready: "provisioning_ready",
  blocked: "provisioning_blocked",
  notApproved: "not_approved",
  stale: "superseded_stale_plan",
  unchanged: "plan_unchanged",
});

// What the CLIENT is told. Deliberately truthful and free of provider nouns:
// they approved settings, they did not order an agent.
const CLIENT_STATUS_MESSAGES = Object.freeze({
  provisioning_ready: "Your receptionist configuration has been approved and is being prepared.",
  provisioning_blocked: "Your settings were approved, but something still needs attention before your receptionist can be built. We'll be in touch.",
  not_approved: "Your settings haven't been approved yet.",
});

function createApprovalBridge(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const storeApi = deps.store || store;
  const registryApi = deps.registry || registry;
  const planStore = deps.planStore || createPlanAdapter();
  const compile = deps.compile || compileReceptionist;
  const toPayload = deps.toRetellPayload || toRetellPayload;
  const audit = deps.recordAuditEvent || store.recordAuditEvent;
  const now = deps.now || (() => new Date());

  /**
   * Called after a successful approval. Confirms the approval is current and
   * authorised, compiles, plans, links the plan, and supersedes any stale plan.
   */
  async function onProfileApproved({ clientId, sessionId = null, approvedVersion, actor }) {
    const config = getRetellConfig(env);

    // 1. Re-read the approved version rather than trusting the caller — the
    //    bridge must not act on a version that is no longer approved.
    const approvedRow = await storeApi.getApprovedVersion(clientId);
    if (!approvedRow) {
      return { ok: false, outcome: BRIDGE_OUTCOMES.notApproved, clientMessage: CLIENT_STATUS_MESSAGES.not_approved, message: "This client has no approved profile." };
    }
    if (approvedVersion && approvedRow.version !== approvedVersion) {
      // A newer approval landed while we were working. The caller's version is
      // already stale; act on what is actually approved.
      logger.log(`provisioning.bridge.version_moved from=${approvedVersion} to=${approvedRow.version}`);
    }
    if (!actor || actor.clientId !== clientId) {
      return { ok: false, outcome: BRIDGE_OUTCOMES.notApproved, message: "Not authorised to prepare provisioning for this client." };
    }

    const assessment = assessProvisioning(approvedRow.profile);

    // 2. Supersede any plan that targets an older version. A stale plan left
    //    looking current is how the wrong configuration gets built.
    const supersededCount = await planStore.supersedeStale(clientId, approvedRow.version, now().toISOString());
    if (supersededCount > 0) {
      await audit(buildAuditEvent({
        clientId, sessionId, eventType: "provisioning.plan_superseded", actorType: actor.type, actorId: actor.id,
        reason: `approved profile moved to version ${approvedRow.version}`, source: "approval_bridge",
        detail: { supersededCount },
      }));
    }

    // 3. Compile and plan.
    const compiled = compile({
      profile: approvedRow.profile,
      profileVersion: approvedRow.version,
      profileStatus: approvedRow.status,
      clientId,
      templateVersion: config.receptionistTemplateVersion,
      config,
      generatedAt: now().toISOString(),
    });

    const retellPayload = compiled.ok ? toPayload({ compiled, config }) : null;

    let existingResources = [];
    try {
      existingResources = await registryApi.listResources(clientId, { provider: config.provider });
    } catch (err) {
      if (!/not provisioned/i.test(err.message)) throw err;
      existingResources = [];
    }

    const plan = plans.createPlan({
      clientId,
      approvedProfileVersion: approvedRow.version,
      profileStatus: approvedRow.status,
      provisioningReady: assessment.ready,
      compiled,
      retellPayload,
      existingResources,
      templateVersions: {
        receptionist: config.receptionistTemplateVersion,
        onboarding: config.onboardingTemplateVersion,
      },
      provider: config.provider,
      createdBy: actor.id || null,
      createdAt: now().toISOString(),
    });

    // 4. An identical current plan is not rewritten — re-approving unchanged
    //    settings must not churn the plan table.
    const existingPlan = await planStore.findCurrent(clientId, approvedRow.version);
    if (existingPlan && plan.planHash && existingPlan.plan_hash === plan.planHash) {
      return {
        ok: true,
        outcome: BRIDGE_OUTCOMES.unchanged,
        planHash: plan.planHash,
        clientMessage: CLIENT_STATUS_MESSAGES.provisioning_ready,
        plan,
      };
    }

    const stored = await planStore.create(buildPlanFields({ plan, compiled, sessionId, config, actor }, now().toISOString()));

    const outcome = plan.blockingReasons.length ? BRIDGE_OUTCOMES.blocked : BRIDGE_OUTCOMES.ready;
    await audit(buildAuditEvent({
      clientId, sessionId, profileVersion: approvedRow.version,
      eventType: outcome === BRIDGE_OUTCOMES.ready ? "provisioning.plan_created" : "provisioning.plan_blocked",
      actorType: actor.type, actorId: actor.id, source: "approval_bridge",
      detail: { planHash: plan.planHash, actions: plan.estimatedApiOperations, blockers: plan.blockingReasons.length },
    }));

    return {
      ok: true,
      outcome,
      planId: stored ? stored.id : null,
      planHash: plan.planHash,
      plan,
      // Truthful either way. "Being prepared" never means "is live".
      clientMessage: outcome === BRIDGE_OUTCOMES.ready ? CLIENT_STATUS_MESSAGES.provisioning_ready : CLIENT_STATUS_MESSAGES.provisioning_blocked,
      executedAnything: false,
    };
  }

  return { onProfileApproved };
}

function buildPlanFields({ plan, compiled, sessionId, config, actor }, nowIso) {
  return {
    client_id: plan.clientId,
    provider: plan.provider,
    status: plan.blockingReasons.length ? "blocked" : "validated",
    approved_profile_version: plan.approvedProfileVersion,
    session_id: sessionId,
    compiler_version: compiled && compiled.ok ? compiled.provenance.compilerVersion : null,
    receptionist_template_version: config.receptionistTemplateVersion,
    onboarding_template_version: config.onboardingTemplateVersion,
    plan_hash: plan.planHash,
    spec_hash: compiled && compiled.ok ? compiled.hashes.specHash : null,
    knowledge_hash: compiled && compiled.ok ? compiled.hashes.knowledgeHash : null,
    tool_schema_hash: compiled && compiled.ok ? compiled.hashes.toolSchemaHash : null,
    actions: plan.actions.map((a) => ({ kind: a.kind, purpose: a.purpose, resourceType: a.resourceType, payloadHash: a.payloadHash || null })),
    blocking_reasons: plan.blockingReasons,
    warnings: plan.warnings,
    estimated_api_operations: plan.estimatedApiOperations,
    created_by: actor.id || null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// ── DB adapter ──────────────────────────────────────────────────────

const { tableMissing, provisioningError } = require("./provider-resource-registry");

function createPlanAdapter() {
  return {
    async create(fields) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`creating the provisioning plan failed: ${error.message}`);
      }
      return data;
    },
    async findCurrent(clientId, approvedVersion) {
      const supabase = require("./supabase");
      const { data, error } = await supabase
        .from(TABLE).select("*")
        .eq("client_id", clientId)
        .eq("approved_profile_version", approvedVersion)
        .is("superseded_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`plan lookup failed: ${error.message}`);
      }
      return data && data.length ? data[0] : null;
    },
    async supersedeStale(clientId, currentApprovedVersion, nowIso) {
      const supabase = require("./supabase");
      const { data, error } = await supabase
        .from(TABLE)
        .update({ status: "superseded", superseded_at: nowIso, updated_at: nowIso })
        .eq("client_id", clientId)
        .neq("approved_profile_version", currentApprovedVersion)
        .is("superseded_at", null)
        .select("id");
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`superseding stale plans failed: ${error.message}`);
      }
      return data ? data.length : 0;
    },
    async findForClient(clientId, { limit = 20 } = {}) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(limit);
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`plan list failed: ${error.message}`);
      }
      return data || [];
    },
  };
}

module.exports = {
  TABLE,
  BRIDGE_OUTCOMES,
  CLIENT_STATUS_MESSAGES,
  createApprovalBridge,
  buildPlanFields,
  createPlanAdapter,
};
