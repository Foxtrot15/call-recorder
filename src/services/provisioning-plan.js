// AIDA — provisioning-plan domain (M3).
//
// A PLAN is the artefact that stands between "the locksmith approved their
// settings" and "something was created at a provider". It is deterministic,
// diffable, hashable, and refuses to exist for anything unapproved.
//
// The properties that matter, each of which is a test:
//
//   * A draft or needs-review profile CANNOT produce an executable plan.
//   * A profile that is not provisioning-ready is BLOCKED, with named reasons.
//   * Every plan points at ONE immutable approved profile version.
//   * Re-planning identical inputs yields an identical plan hash.
//   * An existing matching resource yields a NO-OP, not a duplicate.
//   * A plan goes STALE the moment the approved profile version moves, and a
//     stale plan cannot execute.
//   * Idempotency keys are stable across retries, so a partial failure is
//     resumable without creating a second agent.
//   * Provider ids are recorded ONLY after a confirmed success.
//
// Execution requires every gate simultaneously (integration enabled, live
// writes enabled, valid key, authorised operator, current approval, non-stale
// profile, explicit request). NOTHING EXECUTES DURING M3 — executePlan() is
// written, gated and tested against mock/dry-run adapters only.
//
// Pure core + thin adapter, house style.

const crypto = require("crypto");
const { idempotencyKey, payloadHash, stableStringify, MODES, ERROR_CODES } = require("./voice-platform-port");

const PLAN_STATUSES = Object.freeze([
  "created",
  "validated",
  "blocked",
  "approved_for_execution",
  "executing",
  "completed",
  "partially_failed",
  "failed",
  "superseded",
  "rolled_back",
]);

const PLAN_TRANSITIONS = Object.freeze({
  created: ["validated", "blocked", "superseded"],
  validated: ["approved_for_execution", "blocked", "superseded"],
  blocked: ["validated", "superseded"],
  approved_for_execution: ["executing", "blocked", "superseded"],
  executing: ["completed", "partially_failed", "failed"],
  completed: ["superseded", "rolled_back"],
  partially_failed: ["executing", "failed", "superseded"], // resumable
  failed: ["superseded"],
  superseded: [],
  rolled_back: ["superseded"],
});

const ACTION_KINDS = Object.freeze(["create", "update", "noop", "archive", "unsupported"]);

/** The resources a locksmith receptionist needs, in dependency order. */
const DESIRED_RESOURCE_ORDER = Object.freeze([
  { purpose: "receptionist_knowledge", resourceType: "knowledge_base", operation: "createKnowledgeBase", updateOperation: "updateKnowledgeBase" },
  { purpose: "receptionist_agent", resourceType: "response_engine", operation: "createResponseEngine", updateOperation: "updateResponseEngine" },
  { purpose: "receptionist_agent", resourceType: "voice_agent", operation: "createAgent", updateOperation: "updateAgent" },
]);

function canTransition(from, to) {
  return Boolean(PLAN_TRANSITIONS[from]) && PLAN_TRANSITIONS[from].includes(to);
}

// ── Planning ────────────────────────────────────────────────────────

/**
 * Build the desired-state resource list from a compiled receptionist.
 * Each entry carries its own payload hash and idempotency key, so diffing and
 * retrying are both mechanical.
 */
function buildDesiredResources({ compiled, retellPayload, clientId, planScopeId }) {
  const desired = [];

  const byResource = {
    knowledge_base: retellPayload.knowledge,
    response_engine: retellPayload.responseEngine,
    voice_agent: retellPayload.agent,
  };

  for (const entry of DESIRED_RESOURCE_ORDER) {
    const payload = byResource[entry.resourceType];
    if (!payload) continue;
    const hash = payloadHash(payload);
    desired.push(
      Object.freeze({
        purpose: entry.purpose,
        resourceType: entry.resourceType,
        operation: entry.operation,
        updateOperation: entry.updateOperation,
        payload,
        payloadHash: hash,
        idempotencyKey: idempotencyKey({ clientId, purpose: entry.purpose, resourceType: entry.resourceType, payloadHash: hash, planId: planScopeId }),
      })
    );
  }
  return desired;
}

/**
 * Diff desired state against what the registry says already exists.
 * An existing resource whose payload hash matches is a NO-OP — that is what
 * makes re-planning safe and repeated execution harmless.
 */
function diffResources({ desired, existing }) {
  const byKey = new Map();
  for (const row of existing || []) {
    if (row.active === false) continue;
    byKey.set(`${row.purpose}:${row.resource_type}`, row);
  }

  const actions = [];
  for (const want of desired) {
    const key = `${want.purpose}:${want.resourceType}`;
    const have = byKey.get(key);

    if (!have) {
      actions.push({ kind: "create", ...want, existingProviderId: null, reason: "no active provider resource exists for this purpose" });
    } else if (have.payload_hash === want.payloadHash) {
      actions.push({ kind: "noop", ...want, existingProviderId: have.provider_resource_id, reason: "the provider already holds this exact configuration" });
    } else {
      actions.push({
        kind: "update",
        ...want,
        existingProviderId: have.provider_resource_id,
        reason: "the configuration changed since this resource was created",
        previousPayloadHash: have.payload_hash,
      });
    }
    byKey.delete(key);
  }

  // Anything left is active at the provider but no longer desired.
  for (const [key, row] of byKey) {
    actions.push({
      kind: "archive",
      purpose: row.purpose,
      resourceType: row.resource_type,
      existingProviderId: row.provider_resource_id,
      reason: `no longer part of the desired configuration (${key})`,
      // Retell exposes no delete endpoint; archiving is an AIDA-registry
      // operation. Recorded as such so the plan does not promise a provider
      // call that cannot be made.
      providerSupported: false,
    });
  }

  return actions;
}

/**
 * Create a provisioning plan. Pure: no I/O, no clock (the caller supplies
 * `createdAt`), so the same inputs always hash identically.
 */
function createPlan({
  clientId,
  approvedProfileVersion,
  profileStatus,
  provisioningReady,
  compiled,
  retellPayload,
  existingResources = [],
  templateVersions = {},
  provider = "retell",
  createdBy = null,
  createdAt = null,
  planScopeId = null,
}) {
  const blockingReasons = [];
  const warnings = [];

  if (profileStatus !== "approved") {
    blockingReasons.push({ code: "profile_not_approved", message: `A plan may only be built from an approved profile (this one is "${profileStatus}").` });
  }
  if (!provisioningReady) {
    blockingReasons.push({ code: "profile_not_provisioning_ready", message: "The approved profile is not provisioning-ready." });
  }
  if (!compiled || !compiled.ok) {
    blockingReasons.push({ code: "compile_failed", message: compiled ? `${compiled.code}: ${compiled.message}` : "The receptionist did not compile." });
  }
  if (!Number.isInteger(approvedProfileVersion) || approvedProfileVersion < 1) {
    blockingReasons.push({ code: "no_profile_version", message: "A plan must reference a specific approved profile version." });
  }

  // A blocked plan is still a real, inspectable artefact — the founder needs to
  // see WHY, and the client needs a truthful status.
  if (blockingReasons.length) {
    return Object.freeze({
      status: "blocked",
      clientId,
      provider,
      approvedProfileVersion: approvedProfileVersion || null,
      templateVersions,
      desiredResources: [],
      existingResources: existingResources.map(toPublicResource),
      actions: [],
      blockingReasons,
      warnings,
      estimatedApiOperations: 0,
      planHash: null,
      idempotencyScope: null,
      createdBy,
      createdAt,
      executable: false,
    });
  }

  const desired = buildDesiredResources({ compiled, retellPayload, clientId, planScopeId });
  const actions = diffResources({ desired, existing: existingResources });

  for (const flag of compiled.reviewFlags || []) {
    if (flag.code === "instruction_like") {
      warnings.push({ code: "suspicious_profile_prose", message: flag.message, field: flag.field, severity: "review" });
    } else {
      warnings.push({ code: flag.code, message: flag.message, field: flag.field, severity: "advisory" });
    }
  }
  const unsupported = actions.filter((a) => a.providerSupported === false);
  for (const item of unsupported) {
    warnings.push({ code: "provider_unsupported_action", message: `${item.kind} of ${item.resourceType} is not supported by ${provider}; it will be recorded in the AIDA registry only.`, severity: "advisory" });
  }

  const executableActions = actions.filter((a) => a.kind === "create" || a.kind === "update");

  // The hash covers what would be SENT and to which version — not the warnings,
  // not the timestamps, not the actor. Re-planning the same approved profile
  // with the same templates must produce the same hash.
  const hashable = {
    clientId,
    provider,
    approvedProfileVersion,
    templateVersions,
    specHash: compiled.hashes.specHash,
    knowledgeHash: compiled.hashes.knowledgeHash,
    toolSchemaHash: compiled.hashes.toolSchemaHash,
    actions: actions.map((a) => ({ kind: a.kind, purpose: a.purpose, resourceType: a.resourceType, payloadHash: a.payloadHash || null })),
  };
  const planHash = crypto.createHash("sha256").update(stableStringify(hashable)).digest("hex");

  return Object.freeze({
    status: "validated",
    clientId,
    provider,
    approvedProfileVersion,
    templateVersions,
    desiredResources: desired.map((d) => Object.freeze({ purpose: d.purpose, resourceType: d.resourceType, payloadHash: d.payloadHash, idempotencyKey: d.idempotencyKey })),
    existingResources: existingResources.map(toPublicResource),
    actions: Object.freeze(actions.map((a) => Object.freeze(a))),
    createActions: actions.filter((a) => a.kind === "create").length,
    updateActions: actions.filter((a) => a.kind === "update").length,
    noopActions: actions.filter((a) => a.kind === "noop").length,
    archiveActions: actions.filter((a) => a.kind === "archive").length,
    unsupportedActions: unsupported.length,
    blockingReasons: [],
    warnings,
    estimatedApiOperations: executableActions.length,
    planHash,
    idempotencyScope: planScopeId || null,
    createdBy,
    createdAt,
    executable: executableActions.length > 0,
  });
}

/** Strip a registry row to what a plan may expose. Provider ids stay internal. */
function toPublicResource(row) {
  return Object.freeze({
    purpose: row.purpose,
    resourceType: row.resource_type,
    active: row.active !== false,
    profileVersion: row.profile_version || null,
    payloadHash: row.payload_hash || null,
    // Deliberately NOT the raw provider id — the founder console masks it and
    // clients never see it at all.
    providerResourceIdPresent: Boolean(row.provider_resource_id),
  });
}

// ── Staleness ───────────────────────────────────────────────────────

/**
 * A plan is stale when the client's approved profile has moved on. Checked
 * immediately before execution, not just at creation: the whole point is to
 * catch a change that happened while the plan sat waiting for approval.
 */
function assessStaleness({ plan, currentApprovedVersion }) {
  if (!plan) return { stale: true, reason: "no plan" };
  if (currentApprovedVersion === null || currentApprovedVersion === undefined) {
    return { stale: true, reason: "the client no longer has an approved profile" };
  }
  if (plan.approvedProfileVersion !== currentApprovedVersion) {
    return { stale: true, reason: `the plan targets profile version ${plan.approvedProfileVersion} but version ${currentApprovedVersion} is now approved` };
  }
  return { stale: false, reason: null };
}

// ── Execution gate ──────────────────────────────────────────────────

/**
 * Every condition that must hold before a plan may touch a provider.
 * Returns { allowed, reasons[] } — all reasons at once.
 */
function evaluateExecutionGate({ plan, config, actor, currentApprovedVersion, explicitRequest, capability }) {
  const reasons = [];

  if (!plan) return { allowed: false, reasons: ["there is no plan"] };
  if (plan.status !== "approved_for_execution") reasons.push(`the plan is "${plan.status}", not approved_for_execution`);
  if (plan.blockingReasons && plan.blockingReasons.length) reasons.push("the plan has blocking reasons");
  if (!plan.executable) reasons.push("the plan has nothing to execute");

  if (!actor || actor.type !== "operator") reasons.push("execution requires an authorised operator");
  if (explicitRequest !== true) reasons.push("execution requires an explicit request");

  const staleness = assessStaleness({ plan, currentApprovedVersion });
  if (staleness.stale) reasons.push(staleness.reason);

  if (!config || !config.enabled) reasons.push("RETELL_ENABLED is not \"true\"");
  if (config && !config.liveWritesEnabled) reasons.push("RETELL_LIVE_WRITES_ENABLED is not \"true\"");
  if (config && config.dryRun) reasons.push("RETELL_DRY_RUN is on");
  if (config && !config.hasApiKey) reasons.push("RETELL_API_KEY is not set");
  if (capability && !capability.allowed) reasons.push(...capability.reasons);

  return { allowed: reasons.length === 0, reasons };
}

// ── Execution ───────────────────────────────────────────────────────

/**
 * Execute a plan through the injected adapter.
 *
 * Resumable by construction: each action is keyed by its stable idempotency
 * key, and `alreadyDone` (from the registry) short-circuits anything that
 * already succeeded. A partial failure therefore resumes rather than
 * duplicating.
 *
 * Provider ids are handed to `onResourceProvisioned` ONLY on a confirmed
 * success — a failed or ambiguous response records nothing, because a stored id
 * for a resource that may not exist is worse than no id at all.
 */
async function executePlan({ plan, adapter, alreadyDone = new Set(), onResourceProvisioned = async () => {}, onActionResult = async () => {}, logger = console }) {
  const results = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const action of plan.actions) {
    if (action.kind === "noop") {
      skipped += 1;
      results.push({ action: action.kind, purpose: action.purpose, resourceType: action.resourceType, outcome: "noop" });
      continue;
    }
    if (action.kind === "archive" || action.kind === "unsupported") {
      skipped += 1;
      results.push({ action: action.kind, purpose: action.purpose, resourceType: action.resourceType, outcome: "recorded_locally", providerSupported: false });
      continue;
    }
    if (alreadyDone.has(action.idempotencyKey)) {
      skipped += 1;
      results.push({ action: action.kind, purpose: action.purpose, resourceType: action.resourceType, outcome: "already_done" });
      continue;
    }

    const operation = action.kind === "update" ? action.updateOperation : action.operation;
    const method = adapter[operation];
    if (typeof method !== "function") {
      failed += 1;
      results.push({ action: action.kind, purpose: action.purpose, resourceType: action.resourceType, outcome: "unsupported", errorCode: ERROR_CODES.unsupported });
      continue;
    }

    const response = await method({
      payload: action.payload,
      providerId: action.existingProviderId,
      idempotencyKey: action.idempotencyKey,
      purpose: action.purpose,
    });

    if (response.ok) {
      succeeded += 1;
      // Only now is anything recorded.
      if (response.resource && response.resource.id) {
        await onResourceProvisioned({
          purpose: action.purpose,
          resourceType: action.resourceType,
          providerResourceId: response.resource.id,
          providerVersion: response.resource.version,
          payloadHash: action.payloadHash,
          idempotencyKey: action.idempotencyKey,
          mode: response.mode,
        });
      }
      results.push({ action: action.kind, purpose: action.purpose, resourceType: action.resourceType, outcome: "succeeded", mode: response.mode, providerRequestId: response.providerRequestId || null });
    } else {
      failed += 1;
      logger.error(`provisioning.action.failed purpose=${action.purpose} type=${action.resourceType} code=${response.error.code} retryable=${response.error.retryable}`);
      results.push({
        action: action.kind,
        purpose: action.purpose,
        resourceType: action.resourceType,
        outcome: "failed",
        errorCode: response.error.code,
        retryable: response.error.retryable,
        providerRequestId: response.error.providerRequestId || null,
      });
      // Stop at the first hard failure: later resources depend on earlier ids,
      // and pressing on would create orphans.
      if (!response.error.retryable) break;
    }
    await onActionResult(results[results.length - 1]);
  }

  const status = failed === 0 ? "completed" : succeeded > 0 ? "partially_failed" : "failed";
  return Object.freeze({
    status,
    results: Object.freeze(results),
    summary: Object.freeze({ succeeded, failed, skipped, total: plan.actions.length }),
    resumable: status === "partially_failed",
  });
}

/**
 * Rollback planning. Retell exposes no delete endpoint for agents or LLMs, so
 * "rollback" means: re-point AIDA at the previous approved version and mark the
 * newer provider resources superseded in the registry. This returns the PLAN
 * for that, and executes nothing.
 */
function planRollback({ currentPlan, previousApprovedVersion, existingResources = [] }) {
  if (!previousApprovedVersion) {
    return { ok: false, code: "no_previous_version", message: "There is no earlier approved version to roll back to." };
  }
  const steps = existingResources
    .filter((r) => r.active !== false && r.profile_version === currentPlan.approvedProfileVersion)
    .map((r) => ({
      step: "supersede_registry_entry",
      purpose: r.purpose,
      resourceType: r.resource_type,
      note: "Marks the AIDA registry entry superseded. The provider resource is left in place — Retell has no delete endpoint — and is simply no longer referenced.",
    }));

  steps.push({
    step: "replan_from_previous_version",
    note: `Re-run planning against approved profile version ${previousApprovedVersion} and execute that plan to re-point the agent.`,
  });

  return { ok: true, targetVersion: previousApprovedVersion, steps: Object.freeze(steps), executesAnything: false };
}

module.exports = {
  PLAN_STATUSES,
  PLAN_TRANSITIONS,
  ACTION_KINDS,
  DESIRED_RESOURCE_ORDER,
  canTransition,
  buildDesiredResources,
  diffResources,
  createPlan,
  assessStaleness,
  evaluateExecutionGate,
  executePlan,
  planRollback,
  toPublicResource,
};
