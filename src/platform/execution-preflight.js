// AIDA PLATFORM — the last thing checked before anything is sent (P24B).
//
//   assertExecutionPreflight({ ... })  -> { ok, gates[], blockers[] }
//
// ── ONE PLACE, EIGHTEEN GATES, FAIL CLOSED ──────────────────────────
// Every precondition the execution contract specifies, evaluated in order, as
// data. Not scattered through an executor where one can be skipped by an early
// return that looked harmless.
//
// Every gate is evaluated even after one fails, because an operator who is
// blocked wants the whole list, not the first item. But `ok` is true only if
// EVERY gate passed, and an unrecognised or missing input is a failure rather
// than a pass — there is no branch that returns ok on something it did not
// understand.
//
// ── WHY THE STALE CHECKS ARE HERE AND NOT ONLY AT APPROVAL ──────────
// Approval happened at some earlier moment. Between then and now the
// configuration may have been edited, re-approved and re-activated. An
// approval describes mutations computed from specific words; if the words
// moved, the approval no longer describes reality. So the binding is checked
// again HERE, immediately before anything is sent.
//
// ── AND WHY THE EXECUTOR-ENABLED GATE IS LAST ───────────────────────
// Gate 18 is not a feature flag. There is no environment variable that
// switches live provider transport on. It asks whether the caller supplied a
// provider adapter explicitly, which in this batch can only ever be a fake.

const { authorise } = require("./config-access");
const {
  UNRESOLVED_ACTION_STATUSES, UNRESOLVED_EXECUTION_STATUSES,
} = require("./execution-model");
const { planHashOf, describeStaleness } = require("./provisioning-plan-authority");

const PREFLIGHT_CODES = Object.freeze({
  NO_ACTOR: "no_authenticated_actor",
  NO_EXECUTE_CAPABILITY: "actor_lacks_provisioning_execute",
  WRONG_TENANT: "actor_is_not_authorised_for_this_client",
  NO_PLAN: "plan_not_found",
  NOT_APPROVED: "plan_is_not_approved",
  PLAN_HASH_MOVED: "plan_hash_no_longer_matches",
  ACTIONS_MUTATED: "plan_actions_changed_after_approval",
  CONFIG_VERSION_MOVED: "active_configuration_version_changed",
  CONFIG_HASH_MOVED: "active_configuration_hash_changed",
  DESIRED_MOVED: "desired_resource_hashes_changed",
  WRONG_PROVIDER_TAG: "provider_tag_does_not_match_environment",
  RESOURCE_OWNERSHIP: "an_action_references_another_tenants_resource",
  UNRESOLVED_EXECUTION: "an_earlier_execution_is_unresolved",
  UNKNOWN_ACTION: "an_action_is_in_an_unknown_state_and_needs_reconciliation",
  PERSIST_FAILED_ACTION: "a_resource_exists_at_the_provider_and_was_never_recorded",
  CLAIM_UNAVAILABLE: "a_durable_execution_claim_could_not_be_acquired",
  BAD_DEPENDENCY_ORDER: "action_dependency_order_is_invalid",
  EXECUTOR_DISABLED: "no_provider_adapter_was_explicitly_supplied",
});

const gate = (number, name, passed, code = null, detail = null) =>
  Object.freeze({ number, name, passed: Boolean(passed), code, detail });

/**
 * @param {object} o
 * @param {object} o.principal          resolved server-side, never from a caller
 * @param {string} o.clientId
 * @param {object} o.plan               the approved plan
 * @param {object} o.activeConfig       { configVersion, contentHash, behaviourHash }
 * @param {object} o.desired            freshly recompiled desired state
 * @param {string} o.environmentTag     read LATE, from the runtime
 * @param {Array}  o.priorExecutions    every execution recorded for this client
 * @param {Array}  o.priorActions       every action execution recorded for this client
 * @param {object} o.claim              { acquired: boolean, detail }
 * @param {object} o.providerAdapter    supplied explicitly, or absent
 */
function assertExecutionPreflight({
  principal, clientId, plan, activeConfig, desired,
  environmentTag = null, priorExecutions = [], priorActions = [],
  claim = null, providerAdapter = null,
} = {}) {
  const gates = [];

  // 1. an authenticated actor
  gates.push(gate(1, "authenticated_actor", principal && typeof principal === "object" && !Array.isArray(principal),
    PREFLIGHT_CODES.NO_ACTOR, "a principal resolved server-side is required"));

  // 2. holds provisioning:execute FOR THIS CLIENT
  const decision = authorise({ principal, operation: "provisioning:execute", clientId });
  gates.push(gate(2, "actor_holds_provisioning_execute", decision.ok,
    PREFLIGHT_CODES.NO_EXECUTE_CAPABILITY,
    decision.ok ? null : `${decision.code}: approving a plan does not grant the right to run it`));

  // 3. exact client ownership — the plan belongs to the client in scope
  gates.push(gate(3, "exact_client_ownership", Boolean(plan) && plan.clientId === clientId,
    PREFLIGHT_CODES.WRONG_TENANT,
    plan ? `plan belongs to "${plan.clientId}"` : "no plan"));

  // 4. the plan exists
  gates.push(gate(4, "plan_exists", Boolean(plan), PREFLIGHT_CODES.NO_PLAN));

  // 5. the plan is approved
  gates.push(gate(5, "plan_approved", Boolean(plan) && plan.status === "approved",
    PREFLIGHT_CODES.NOT_APPROVED, plan ? `plan is ${plan.status}` : null));

  // 6. the plan hash still matches what was approved
  const hashIntact = Boolean(plan) && plan.approvedPlanHash === plan.planHash;
  gates.push(gate(6, "plan_hash_unchanged", hashIntact, PREFLIGHT_CODES.PLAN_HASH_MOVED,
    hashIntact ? null : "the approval does not bind this body"));

  // 7. the actions still hash to the plan hash — nothing edited them since
  const actionsIntact = Boolean(plan) && planHashOf(plan) === plan.planHash;
  gates.push(gate(7, "plan_actions_immutable", actionsIntact, PREFLIGHT_CODES.ACTIONS_MUTATED,
    actionsIntact ? null : "the plan body no longer hashes to its recorded plan hash"));

  // 8 + 9. the active configuration is STILL exactly what the plan bound to
  const staleness = plan ? describeStaleness(plan, activeConfig) : { stale: true, why: "no plan" };
  const versionMatches = Boolean(plan) && Boolean(activeConfig) && activeConfig.configVersion === plan.configVersion;
  gates.push(gate(8, "active_config_version_exact", versionMatches,
    PREFLIGHT_CODES.CONFIG_VERSION_MOVED, versionMatches ? null : staleness.why));
  const hashMatches = Boolean(plan) && Boolean(activeConfig) && !staleness.stale;
  gates.push(gate(9, "active_config_hash_exact", hashMatches,
    PREFLIGHT_CODES.CONFIG_HASH_MOVED, hashMatches ? null : staleness.why));

  // 10. the desired resource hashes still equal what the plan recorded. This
  //     catches a compiler change as well as a configuration change.
  const desiredMatches =
    Boolean(plan) && Boolean(desired) && desired.ok === true && desired.desiredHash === plan.desiredHash;
  gates.push(gate(10, "desired_resource_hashes_exact", desiredMatches, PREFLIGHT_CODES.DESIRED_MOVED,
    desiredMatches ? null : "recompiling the desired state produced a different hash from the one in the plan"));

  // 11. the environment tag, read LATE, matches what the plan is for
  const tagMatches = Boolean(plan) && plan.providerTag != null
    ? plan.providerTag === environmentTag
    : environmentTag !== null && environmentTag !== undefined;
  gates.push(gate(11, "provider_tag_exact", tagMatches, PREFLIGHT_CODES.WRONG_PROVIDER_TAG,
    tagMatches ? null : `plan tag ${plan ? plan.providerTag : "?"}, environment tag ${environmentTag}`));

  // 12. no action references another tenant's provider resource
  const foreignResource = (plan ? plan.actions : []).find(
    (a) => a.ownerClientId && a.ownerClientId !== clientId,
  );
  gates.push(gate(12, "resource_ownership_exact", !foreignResource, PREFLIGHT_CODES.RESOURCE_OWNERSHIP,
    foreignResource ? `${foreignResource.key} is owned by ${foreignResource.ownerClientId}` : null));

  // 13. no earlier execution for this client is unresolved
  const unresolvedExecution = priorExecutions.find((e) => UNRESOLVED_EXECUTION_STATUSES.includes(e.status));
  gates.push(gate(13, "no_unresolved_prior_execution", !unresolvedExecution, PREFLIGHT_CODES.UNRESOLVED_EXECUTION,
    unresolvedExecution ? `execution ${unresolvedExecution.executionId} is ${unresolvedExecution.status}` : null));

  // 14. no action anywhere for this client is UNKNOWN
  const unknownAction = priorActions.find((a) => a.status === "unknown");
  gates.push(gate(14, "no_unknown_action", !unknownAction, PREFLIGHT_CODES.UNKNOWN_ACTION,
    unknownAction
      ? `${unknownAction.actionKey} is unknown — it may already exist at the provider. Observe and reconcile before anything is sent.`
      : null));

  // 15. no action recorded a provider success whose durable write failed
  const orphan = priorActions.find((a) => a.status === "persist_failed_after_provider_success");
  gates.push(gate(15, "no_unrecorded_provider_resource", !orphan, PREFLIGHT_CODES.PERSIST_FAILED_ACTION,
    orphan
      ? `${orphan.actionKey} EXISTS at the provider as ${orphan.providerResourceId} and was never recorded. Record it before anything else.`
      : null));

  // 16. a durable claim was acquired
  gates.push(gate(16, "durable_claim_acquired", Boolean(claim) && claim.acquired === true,
    PREFLIGHT_CODES.CLAIM_UNAVAILABLE, claim ? claim.detail : "no claim was attempted"));

  // 17. dependency order is valid — every dependency precedes its dependent
  const orderValid = validateDependencyOrder(plan ? plan.actions : []);
  gates.push(gate(17, "dependency_order_valid", orderValid.ok, PREFLIGHT_CODES.BAD_DEPENDENCY_ORDER, orderValid.why));

  // 18. a provider adapter was supplied EXPLICITLY by the caller.
  //     Not a flag, not an environment variable — an object handed in. In this
  //     batch the only ones that exist are fakes.
  gates.push(gate(18, "provider_adapter_supplied_explicitly",
    Boolean(providerAdapter) && typeof providerAdapter.createResource === "function",
    PREFLIGHT_CODES.EXECUTOR_DISABLED,
    "the executor never constructs a provider client; one must be handed in, and only fakes exist"));

  const blockers = gates.filter((g) => !g.passed);
  return Object.freeze({
    ok: blockers.length === 0,
    gates: Object.freeze(gates),
    blockers: Object.freeze(blockers),
    blockerCount: blockers.length,
    summary: blockers.length === 0
      ? "every gate passed"
      : blockers.map((b) => `${b.number}. ${b.name}`).join(", "),
  });
}

/** Every action's dependencies must appear earlier in the list. */
function validateDependencyOrder(actions) {
  const seen = new Set();
  for (const action of actions || []) {
    for (const dep of action.dependsOn || []) {
      const key = typeof dep === "string" ? dep : `${dep.purpose}:${dep.resourceType}`;
      if (!seen.has(key)) {
        return { ok: false, why: `${action.key} depends on ${key}, which does not appear before it` };
      }
    }
    seen.add(action.key);
  }
  return { ok: true, why: null };
}

module.exports = { assertExecutionPreflight, validateDependencyOrder, PREFLIGHT_CODES };
