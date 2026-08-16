// AIDA PLATFORM — the provisioning service (P23).
//
//   createProvisioningService({ configService, planStore, resourceReader, now, providerRefs })
//
// The one entry point the application layer uses for provisioning. Every
// operation takes a PRINCIPAL, checks authority first, and returns a result.
//
// ── WHAT IT DOES NOT HAVE ───────────────────────────────────────────
// There is no `execute`. Not a disabled one, not a placeholder that throws —
// none. A method that exists and refuses is a method somebody eventually makes
// work in a hurry; a method that does not exist has to be written, reviewed
// and committed. `describeExecutionContract` returns the twelve preconditions a
// future executor must satisfy, and it is a description, not a door.
//
// ── AND WHAT IT CANNOT REACH ────────────────────────────────────────
// No transport, no provider client, no dial executor, no calling state, no
// acquisition module. The ratchets read this file's imports.

const { compileDesiredState } = require("./provisioning-desired-state");
const { diffProvisioning, reconcile } = require("./provisioning-diff");
const { createPlanAuthority, describeStaleness, PLAN_CODES } = require("./provisioning-plan-authority");
const { assessClientReadiness } = require("./provisioning-readiness");
const { describeExecutionContract } = require("./provisioning-execution-contract");
const { authorise, ACCESS_CODES } = require("./config-access");

const PROVISIONING_OUTCOMES = Object.freeze({
  OK: "ok",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  INVALID: "invalid",
  CONFLICT: "conflict",
  UNAVAILABLE: "unavailable",
});

const ok = (value = {}) => Object.freeze({ ok: true, outcome: PROVISIONING_OUTCOMES.OK, ...value });
const no = (outcome, code, message, extra = {}) => Object.freeze({ ok: false, outcome, code, message, ...extra });

const OUTCOME_BY_PLAN_CODE = Object.freeze({
  [PLAN_CODES.NOT_FOUND]: PROVISIONING_OUTCOMES.NOT_FOUND,
  [PLAN_CODES.CROSS_TENANT]: PROVISIONING_OUTCOMES.FORBIDDEN,
  [PLAN_CODES.NOT_A_PERSON]: PROVISIONING_OUTCOMES.FORBIDDEN,
  [PLAN_CODES.INVALID]: PROVISIONING_OUTCOMES.INVALID,
  [PLAN_CODES.STALE]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.HASH_MISMATCH]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.NOT_A_DRAFT]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.NOT_VALIDATED]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.NOT_APPROVED]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.ALREADY_APPROVED]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.TERMINAL]: PROVISIONING_OUTCOMES.CONFLICT,
  [PLAN_CODES.STORE_UNAVAILABLE]: PROVISIONING_OUTCOMES.UNAVAILABLE,
});

function createProvisioningService({
  configService, planStore, resourceReader = null, now, providerRefs = {}, provider = "retell", audit = null,
} = {}) {
  if (!configService) throw new Error("createProvisioningService requires the configuration service");
  const plans = createPlanAuthority({ store: planStore, now });

  const gate = (principal, operation, clientId) => {
    const decision = authorise({ principal, operation, clientId });
    return decision.ok ? null : no(PROVISIONING_OUTCOMES.FORBIDDEN, decision.code, decision.message);
  };
  const relayPlan = (r) => no(OUTCOME_BY_PLAN_CODE[r.code] || PROVISIONING_OUTCOMES.INVALID, r.code, r.message,
    r.blockingReasons ? { blockingReasons: r.blockingReasons } : {});

  async function record(eventType, { principal, clientId, detail }) {
    if (!audit || typeof audit.append !== "function") return;
    try {
      await audit.append({
        clientId, eventType,
        actor: principal ? principal.actorId : null,
        actorRole: principal ? principal.role : null,
        source: principal && principal.role === "operator" ? "operator" : "ui",
        metadata: detail ? { detail: String(detail).slice(0, 500) } : null,
      });
    } catch { /* an audit sink being down must not take provisioning down */ }
  }

  /** The active configuration, plus what a plan binds to. */
  async function activeBinding(principal, clientId) {
    const active = await configService.getActive({ principal, clientId });
    if (!active.ok) return { ok: false, relay: no(PROVISIONING_OUTCOMES.NOT_FOUND, "no_active_configuration",
      "this client has no active configuration, so there is nothing to provision") };
    const version = active.version;
    return {
      ok: true,
      version,
      binding: {
        configVersion: version.metadata.configVersion,
        contentHash: version.metadata.contentHash ?? null,
        configContentHash: version.metadata.contentHash ?? null,
      },
    };
  }

  /** Durable provider_resources rows for this client. Read-only, injected. */
  async function currentResources(clientId) {
    if (!resourceReader || typeof resourceReader.listForClient !== "function") return [];
    return resourceReader.listForClient(clientId);
  }

  // ── the diff ──────────────────────────────────────────────────────

  async function getDiff({ principal, clientId, direction = "inbound" }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;

    const bound = await activeBinding(principal, clientId);
    if (!bound.ok) return bound.relay;

    const desired = compileDesiredState({ version: bound.version, providerRefs, provider, direction });
    if (!desired.ok) return no(PROVISIONING_OUTCOMES.INVALID, desired.code, desired.message, desired.errors ? { errors: desired.errors } : {});

    const diff = diffProvisioning({ desired, current: await currentResources(clientId) });
    if (!diff.ok) return no(PROVISIONING_OUTCOMES.CONFLICT, diff.code, diff.message);

    return ok({
      clientId,
      configVersion: diff.configVersion,
      behaviourHash: diff.behaviourHash,
      desiredHash: diff.desiredHash,
      actions: diff.actions,
      counts: diff.counts,
      summary: diff.summary,
      isNoOp: diff.isNoOp,
      requiresReconciliation: diff.requiresReconciliation,
      mutatingCount: diff.mutatingCount,
      unresolvedProviderRefs: desired.unresolved,
      deliberatelyAbsent: desired.deliberatelyAbsent,
      // Repeated at every layer, on purpose.
      providerContacted: false,
      note: "A description of what WOULD change. Nothing was sent to any provider.",
    });
  }

  async function getDesiredPayloads({ principal, clientId, direction = "inbound" }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;
    const bound = await activeBinding(principal, clientId);
    if (!bound.ok) return bound.relay;
    const desired = compileDesiredState({ version: bound.version, providerRefs, provider, direction });
    if (!desired.ok) return no(PROVISIONING_OUTCOMES.INVALID, desired.code, desired.message);
    return ok({
      clientId, configVersion: desired.configVersion, behaviourHash: desired.behaviourHash,
      desiredHash: desired.desiredHash, ready: desired.ready, unresolved: desired.unresolved,
      resources: desired.resources.map((r) => ({
        purpose: r.purpose, resourceType: r.resourceType,
        payloadHash: r.payloadHash, dependencyHash: r.dependencyHash,
        dependsOn: r.dependsOn, provenance: r.provenance, payload: r.payload,
      })),
      providerContacted: false,
    });
  }

  // ── plans ─────────────────────────────────────────────────────────

  async function createPlan({ principal, clientId, direction = "inbound", notes = null }) {
    const denied = gate(principal, "provisioning:create", clientId);
    if (denied) return denied;

    const diffResult = await getDiff({ principal, clientId, direction });
    if (!diffResult.ok) return diffResult;

    const bound = await activeBinding(principal, clientId);
    if (!bound.ok) return bound.relay;

    const created = await plans.createPlan({
      clientId,
      diff: {
        ok: true, clientId, provider,
        configVersion: diffResult.configVersion,
        behaviourHash: diffResult.behaviourHash,
        desiredHash: diffResult.desiredHash,
        actions: diffResult.actions,
        counts: diffResult.counts,
        mutatingCount: diffResult.mutatingCount,
        isNoOp: diffResult.isNoOp,
        requiresReconciliation: diffResult.requiresReconciliation,
      },
      configContentHash: bound.binding.configContentHash,
      createdBy: principal.actorId,
      notes,
    });
    if (!created.ok) return relayPlan(created);
    await record("provisioning_plan_created", { principal, clientId, detail: created.plan.planId });
    return ok({ plan: created.plan, executable: false });
  }

  async function getPlan({ principal, clientId, planId }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;
    const got = await plans.getPlan(clientId, planId);
    if (!got.ok) return relayPlan(got);
    const bound = await activeBinding(principal, clientId);
    const staleness = describeStaleness(got.plan, bound.ok ? { ...bound.binding, behaviourHash: null } : null);
    return ok({ plan: got.plan, staleness, executable: false });
  }

  async function listPlans({ principal, clientId }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;
    const listed = await plans.listPlans(clientId);
    return listed.ok ? ok({ plans: listed.plans }) : relayPlan(listed);
  }

  async function validatePlan({ principal, clientId, planId }) {
    const denied = gate(principal, "provisioning:validate", clientId);
    if (denied) return denied;
    const bound = await activeBinding(principal, clientId);
    const currentConfig = bound.ok
      ? { configVersion: bound.binding.configVersion, behaviourHash: null, configContentHash: bound.binding.configContentHash }
      : null;
    const result = await plans.validatePlan({ clientId, planId, currentConfig });
    if (!result.ok) return relayPlan(result);
    return ok({ plan: result.plan, executable: false });
  }

  async function approvePlan({ principal, clientId, planId, reason = null, expectedPlanHash = null }) {
    const denied = gate(principal, "provisioning:approve", clientId);
    if (denied) {
      await record("provisioning_plan_refused", { principal, clientId, detail: denied.code });
      return denied;
    }
    const bound = await activeBinding(principal, clientId);
    const currentConfig = bound.ok
      ? { configVersion: bound.binding.configVersion, behaviourHash: null, configContentHash: bound.binding.configContentHash }
      : null;
    const result = await plans.approvePlan({
      clientId, planId, approvedBy: principal.actorId, reason, expectedPlanHash, currentConfig,
    });
    if (!result.ok) {
      await record("provisioning_plan_refused", { principal, clientId, detail: result.code });
      return relayPlan(result);
    }
    await record("provisioning_plan_approved", { principal, clientId, detail: planId });
    return ok({
      plan: result.plan,
      // Two sentences that must never be collapsed into one.
      executable: false,
      providerMutated: false,
      meaning: "A person has agreed to this set of provider mutations.",
      note: "PROVISIONING PLAN APPROVED does not mean PROVIDER MUTATION EXECUTED. No executor exists.",
    });
  }

  async function cancelPlan({ principal, clientId, planId, reason = null }) {
    const denied = gate(principal, "provisioning:create", clientId);
    if (denied) return denied;
    const result = await plans.cancelPlan({ clientId, planId, reason });
    return result.ok ? ok({ plan: result.plan }) : relayPlan(result);
  }

  /** Asks whether a plan COULD execute. Performs nothing, authorises nobody. */
  async function checkExecutable({ principal, clientId, planId, providerTag = null, expectedProviderTag = null }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;
    const bound = await activeBinding(principal, clientId);
    const currentConfig = bound.ok
      ? { configVersion: bound.binding.configVersion, behaviourHash: null, configContentHash: bound.binding.configContentHash }
      : null;
    const result = await plans.assertExecutable({ clientId, planId, currentConfig, providerTag, expectedProviderTag });
    return result.ok ? ok(result) : relayPlan(result);
  }

  // ── reconciliation (read-only, fake observations for now) ──────────

  async function reconcileResources({ principal, clientId, observations = {} }) {
    const denied = gate(principal, "provisioning:reconcile", clientId);
    if (denied) return denied;
    const current = await currentResources(clientId);
    const results = current.map((row) => {
      const key = `${row.purpose}:${row.resourceType ?? row.resource_type}`;
      // `undefined` means the provider could not be asked. That is NOT the
      // same as null, which means "asked, and it is not there".
      const observed = Object.prototype.hasOwnProperty.call(observations, key) ? observations[key] : undefined;
      return { key, ...reconcile({ recorded: row, observed }) };
    });
    return ok({
      clientId,
      results,
      needsAttention: results.filter((r) => r.result !== "match").length,
      providerContacted: false,
      note: "Reconciliation is read-only by design and currently runs against injected observations. No provider was contacted.",
    });
  }

  // ── readiness ─────────────────────────────────────────────────────

  async function readiness({ principal, clientId, clientRecord = null, phoneNumber = null, inboundBinding = null, direction = "inbound" }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;

    const active = await configService.getActive({ principal, clientId });
    const version = active.ok ? active.version : null;
    const desired = version ? compileDesiredState({ version, providerRefs, provider, direction }) : null;

    const listed = await plans.listPlans(clientId);
    const open = listed.ok
      ? listed.plans.filter((p) => ["draft", "validated", "approved"].includes(p.status)).slice(-1)[0] || null
      : null;
    const fullPlan = open ? (await plans.getPlan(clientId, open.planId)).plan : null;

    const binding = version
      ? { configVersion: version.metadata.configVersion, behaviourHash: null, configContentHash: version.metadata.contentHash ?? null }
      : null;

    const assessment = assessClientReadiness({
      clientId,
      clientRecord,
      activeConfig: version ? { configVersion: version.metadata.configVersion, behaviourHash: desired ? desired.behaviourHash : null } : null,
      plan: fullPlan,
      planStaleness: fullPlan ? describeStaleness(fullPlan, binding) : null,
      desiredState: desired && desired.ok ? desired : null,
      currentResources: await currentResources(clientId),
      phoneNumber,
      inboundBinding,
      integrations: version
        ? (version.integrations || []).map((i) => ({ capability: i.capability, enabled: i.enabled, adapterRegistered: false }))
        : [],
    });
    return ok({ readiness: assessment });
  }

  /** The future executor's contract. A description; there is no door here. */
  function executionContract({ principal, clientId }) {
    const denied = gate(principal, "provisioning:view", clientId);
    if (denied) return denied;
    return ok({ contract: describeExecutionContract() });
  }

  return Object.freeze({
    getDiff, getDesiredPayloads,
    createPlan, getPlan, listPlans, validatePlan, approvePlan, cancelPlan,
    checkExecutable, reconcileResources, readiness, executionContract,
  });
}

module.exports = { createProvisioningService, PROVISIONING_OUTCOMES };
