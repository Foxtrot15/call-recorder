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
const {
  idempotencyKey, payloadHash, stableStringify, MODES, ERROR_CODES,
  REF, ref, isRef, resolveRefs, DRY_RUN_REF_PLACEHOLDER,
} = require("./voice-platform-port");

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
  // updateOperation is deliberately null: Retell has no knowledge-base update
  // endpoint (verified 2026-08-01). A changed KB is created afresh and the old
  // one superseded — see the !want.updateOperation branch in diffResources.
  { purpose: "receptionist_knowledge", resourceType: "knowledge_base", operation: "createKnowledgeBase", updateOperation: null },
  { purpose: "receptionist_agent", resourceType: "response_engine", operation: "createResponseEngine", updateOperation: "updateResponseEngine" },
  { purpose: "receptionist_agent", resourceType: "voice_agent", operation: "createAgent", updateOperation: "updateAgent" },
  // The last mile. Without this a plan builds an agent that no caller can
  // reach: M7 found the purpose and the adapter operation both existed while
  // the plan never emitted the action, so provisioning "succeeded" and the
  // phone stayed dead.
  //
  // Binding is an UPDATE to a phone number that already exists at the provider
  // — AIDA does not purchase numbers as part of a configuration change. The
  // number arrives from config; if it is absent the entry is skipped and the
  // plan says so, rather than inventing one.
  { purpose: "inbound_binding", resourceType: "phone_number", operation: "bindPhoneNumber", updateOperation: "bindPhoneNumber" },
]);

// ── Late-resolved dependencies ──────────────────────────────────────
//
// Some payload fields cannot be known at plan time because they are provider
// ids produced DURING execution: an agent needs its response engine's id, and a
// phone binding needs the agent's id.
//
// The plan model originally assumed every payload was fully known upfront.
// executePlan even carried the comment "later resources depend on earlier ids"
// with no mechanism to pass one — so `llm_id` went to Retell as null and the
// binding action did not exist at all.
//
// A payload may contain a reference token (see REF/ref/resolveRefs in
// services/voice-platform-port.js). It is resolved against the ids produced
// earlier in the SAME execution, immediately before the provider call.
//
// The payload HASH is computed over the UNRESOLVED payload, so diffing and
// idempotency stay deterministic across runs.

function canTransition(from, to) {
  return Boolean(PLAN_TRANSITIONS[from]) && PLAN_TRANSITIONS[from].includes(to);
}

/** Deep scan for a dry-run placeholder that must never reach a live provider. */
function containsPlaceholder(node) {
  if (typeof node === "string") return node.startsWith(DRY_RUN_REF_PLACEHOLDER);
  if (Array.isArray(node)) return node.some(containsPlaceholder);
  if (node && typeof node === "object") return Object.values(node).some(containsPlaceholder);
  return false;
}

/**
 * Validate a weighted agent binding before it is sent.
 *
 * Retell requires each weight in (0, 1] and the array to total exactly 1
 * (verified 2026-08-01). A binding that violates this is either rejected or —
 * worse — accepted with a distribution nobody intended, silently sending a
 * share of a locksmith's calls somewhere else.
 */
const WEIGHT_TOLERANCE = 1e-9;

function validateAgentWeights(agents, { field = "inbound_agents" } = {}) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return { ok: false, code: "no_agents", message: `${field} must list at least one agent.` };
  }
  let total = 0;
  for (const entry of agents) {
    if (!entry || typeof entry !== "object") return { ok: false, code: "bad_entry", message: `Every ${field} entry must be an object.` };
    if (!entry.agent_id || typeof entry.agent_id !== "string") {
      return { ok: false, code: "missing_agent_id", message: `Every ${field} entry needs a resolved agent_id.` };
    }
    if (typeof entry.weight !== "number" || !(entry.weight > 0) || entry.weight > 1) {
      return { ok: false, code: "invalid_weight", message: `Each weight must be greater than 0 and at most 1 (got ${JSON.stringify(entry.weight)}).` };
    }
    if (entry.agent_version !== undefined && entry.agent_version !== null) {
      const v = entry.agent_version;
      const versionOk = Number.isInteger(v) || (typeof v === "string" && v.length > 0 && v.length <= 40);
      if (!versionOk) return { ok: false, code: "invalid_version", message: "agent_version must be an integer or a version tag." };
    }
    total += entry.weight;
  }
  if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
    return { ok: false, code: "weights_not_one", message: `Agent weights must total exactly 1 (got ${total}).` };
  }
  return { ok: true, total };
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
    // Absent when no inbound number is configured. buildDesiredResources skips
    // a missing payload, so the plan simply carries no binding action and the
    // caller can see that the last mile is not covered.
    phone_number: retellPayload.inboundBinding || null,
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
    } else if (!want.updateOperation) {
      // The provider has no update endpoint for this resource type — verified
      // true of knowledge bases on 2026-08-01: the documented surface is
      // create, add-sources and delete-source, with no wholesale update.
      //
      // A changed payload therefore becomes a CREATE of a fresh resource, and
      // the previous one is superseded in the registry. `replacesProviderId`
      // records what it supersedes, so the registry can retire the old row
      // without the plan pretending it can edit something it cannot.
      actions.push({
        kind: "create",
        ...want,
        existingProviderId: null,
        replacesProviderId: have.provider_resource_id,
        reason: "the configuration changed and this provider resource cannot be updated in place",
        previousPayloadHash: have.payload_hash,
      });
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
async function executePlan({ plan, adapter, alreadyDone = new Set(), knownResources = [], onResourceProvisioned = async () => {}, onActionResult = async () => {}, logger = console }) {
  const results = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  // Provider ids available to later actions in this run.
  //
  // Seeded from the registry so a RESUMED execution can satisfy a reference to
  // a resource created on an earlier attempt. Without this, resuming after a
  // partial failure would fail on a dependency that already exists — the retry
  // would be less capable than the first attempt, which is exactly backwards.
  const provided = new Map();
  for (const row of knownResources || []) {
    if (row && row.active !== false && row.provider_resource_id) {
      provided.set(`${row.purpose}:${row.resource_type}`, row.provider_resource_id);
    }
  }

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

    // Fill in provider ids produced earlier in this run (or on a previous
    // attempt). A reference that cannot be satisfied is a hard failure: sending
    // a null agent id would create a binding that points nowhere, and a phone
    // number bound to nothing is a silently dead line.
    // A dry run creates nothing, so dependency ids do not exist. Placeholders
    // let the operator preview the full request shape instead of the run dying
    // on the first dependent action.
    const resolution = resolveRefs(action.payload, provided, {
      placeholder: adapter.mode === MODES.dryRun ? DRY_RUN_REF_PLACEHOLDER : null,
    });

    // A dry-run placeholder must never reach a live provider. The dry-run and
    // live paths share a request builder by design, so this asserts the one
    // property that sharing puts at risk: if a placeholder ever appeared in a
    // live payload it would be sent verbatim as an agent id.
    if (resolution.ok && adapter.mode !== MODES.dryRun && containsPlaceholder(resolution.payload)) {
      failed += 1;
      logger.error(`provisioning.action.placeholder_in_live purpose=${action.purpose} type=${action.resourceType}`);
      results.push({
        action: action.kind,
        purpose: action.purpose,
        resourceType: action.resourceType,
        outcome: "failed",
        errorCode: ERROR_CODES.invalidRequest,
        retryable: false,
        placeholderInLiveMode: true,
      });
      break;
    }
    if (!resolution.ok) {
      failed += 1;
      logger.error(`provisioning.action.unresolved purpose=${action.purpose} type=${action.resourceType} missing=${resolution.missing.join(",")}`);
      results.push({
        action: action.kind,
        purpose: action.purpose,
        resourceType: action.resourceType,
        outcome: "failed",
        errorCode: ERROR_CODES.invalidRequest,
        retryable: false,
        unresolvedRefs: resolution.missing,
      });
      break;
    }

    // A phone binding must satisfy the provider's weight contract before it is
    // sent. Checked post-resolution, because the agent_id it validates is the
    // one produced moments earlier in this run.
    if (action.purpose === "inbound_binding") {
      const weights = validateAgentWeights(resolution.payload.inbound_agents, { field: "inbound_agents" });
      if (!weights.ok) {
        failed += 1;
        logger.error(`provisioning.action.invalid_binding purpose=${action.purpose} code=${weights.code}`);
        results.push({
          action: action.kind,
          purpose: action.purpose,
          resourceType: action.resourceType,
          outcome: "failed",
          errorCode: ERROR_CODES.invalidRequest,
          retryable: false,
          bindingError: weights.code,
          bindingMessage: weights.message,
        });
        break;
      }
    }

    const response = await method({
      payload: resolution.payload,
      providerId: action.existingProviderId,
      idempotencyKey: action.idempotencyKey,
      purpose: action.purpose,
    });

    if (response.ok) {
      succeeded += 1;
      // Make this resource's id available to later actions in this run.
      if (response.resource && response.resource.id) {
        provided.set(`${action.purpose}:${action.resourceType}`, response.resource.id);
      }
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
  DESIRED_RESOURCE_ORDER,
  REF,
  ref,
  isRef,
  resolveRefs,
  validateAgentWeights,
  containsPlaceholder,
  planRollback,
  toPublicResource,
};
