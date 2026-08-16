// AIDA PLATFORM — the durable execution claim (P25).
//
//   createExecutionClaimAuthority({ store, now })
//     .claimExecution / claimAction / resolveAction / resolveExecution
//     .listExecutions / listActions / findUnresolved
//
// ── THE PROPERTY ────────────────────────────────────────────────────
//
//   TWO PROCESSES CANNOT EXECUTE THE SAME APPROVED ACTION.
//
// Not "are unlikely to". The claim is a durable INSERT taken BEFORE the
// provider is contacted, and the uniqueness that makes it a claim lives in the
// database:
//
//   pae_one_unresolved_per_action
//     UNIQUE (client_id, action_key) WHERE status IN (unresolved…)
//
//   pex_one_unresolved_per_client
//     UNIQUE (client_id) WHERE status IN (unresolved…)
//
// An in-process mutex would protect one Node process from itself, which is not
// the failure that produces a second agent. Two workers, two containers, or one
// operator running a CLI while a job runs — those are the cases, and only the
// database can arbitrate them.
//
// ── WHY THE CLAIM COMES FIRST ───────────────────────────────────────
// If the provider were called first and the claim written after, a crash in
// between would leave a resource that exists and no record that anything was
// attempted. Claiming first inverts the danger: a crash leaves a claim with no
// provider call, which reads as UNKNOWN and stops everything until a person
// looks. That is the safe direction.
//
// ── NOTHING HERE CONTACTS A PROVIDER ────────────────────────────────
// This module records intentions and outcomes. It imports no transport and a
// ratchet asserts it.

const {
  UNRESOLVED_EXECUTION_STATUSES, UNRESOLVED_ACTION_STATUSES,
  ACTION_EXECUTION_STATUSES, EXECUTION_STATUSES,
  providerRequestId, executionIdFor, validateActionExecution,
} = require("./execution-model");

const CLAIM_CODES = Object.freeze({
  OK: "ok",
  ALREADY_CLAIMED: "already_claimed",
  UNRESOLVED_EXISTS: "an_unresolved_execution_or_action_exists",
  NOT_FOUND: "claim_not_found",
  CROSS_TENANT: "cross_tenant_claim_refused",
  INVALID: "claim_invalid",
  STORE_UNAVAILABLE: "execution_store_unavailable",
});

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });
const okay = (value) => Object.freeze({ ok: true, code: CLAIM_CODES.OK, ...value });
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * An in-memory store that ENFORCES the same uniqueness the migration declares.
 * A fake that accepted everything would let the contract pass while the real
 * guarantee existed only in a .sql file nobody ran.
 */
function createInMemoryExecutionStore() {
  const executions = [];
  const actions = [];
  const state = { failNextWrite: null };

  const refuse = (constraint, message) => {
    const error = new Error(message);
    error.code = "23505";
    error.constraint = constraint;
    throw error;
  };

  return {
    kind: "memory",
    _failNextWrite(message) { state.failNextWrite = message; },

    async listExecutions(clientId) { return executions.filter((e) => e.clientId === clientId).map(clone); },
    async listActions(clientId) { return actions.filter((a) => a.clientId === clientId).map(clone); },

    async putExecution(execution) {
      if (state.failNextWrite) { const m = state.failNextWrite; state.failNextWrite = null; throw new Error(m); }
      // pex_one_unresolved_per_client
      if (UNRESOLVED_EXECUTION_STATUSES.includes(execution.status)) {
        const clash = executions.find(
          (e) => e.clientId === execution.clientId
            && e.executionId !== execution.executionId
            && UNRESOLVED_EXECUTION_STATUSES.includes(e.status),
        );
        if (clash) refuse("pex_one_unresolved_per_client",
          `${execution.clientId} already has an unresolved execution (${clash.executionId})`);
      }
      if (executions.some((e) => e.clientId === execution.clientId && e.executionId === execution.executionId)) {
        refuse("pex_execution_id_unique", `execution ${execution.executionId} already exists`);
      }
      executions.push(clone(execution));
      return clone(execution);
    },

    async replaceExecution(execution) {
      if (state.failNextWrite) { const m = state.failNextWrite; state.failNextWrite = null; throw new Error(m); }
      const i = executions.findIndex((e) => e.clientId === execution.clientId && e.executionId === execution.executionId);
      if (i === -1) throw new Error("replaceExecution: no such execution");
      executions[i] = clone(execution);
      return clone(execution);
    },

    async putAction(action) {
      if (state.failNextWrite) { const m = state.failNextWrite; state.failNextWrite = null; throw new Error(m); }
      // pae_one_unresolved_per_action — THE no-second-resource guard.
      if (UNRESOLVED_ACTION_STATUSES.includes(action.status)) {
        const clash = actions.find(
          (a) => a.clientId === action.clientId
            && a.actionKey === action.actionKey
            && UNRESOLVED_ACTION_STATUSES.includes(a.status),
        );
        if (clash) refuse("pae_one_unresolved_per_action",
          `${action.clientId} already has an unresolved action for ${action.actionKey} (${clash.executionId})`);
      }
      if (actions.some((a) => a.clientId === action.clientId && a.executionId === action.executionId && a.actionKey === action.actionKey)) {
        refuse("pae_action_unique", `${action.actionKey} is already claimed in ${action.executionId}`);
      }
      actions.push(clone(action));
      return clone(action);
    },

    async replaceAction(action) {
      if (state.failNextWrite) { const m = state.failNextWrite; state.failNextWrite = null; throw new Error(m); }
      const i = actions.findIndex(
        (a) => a.clientId === action.clientId && a.executionId === action.executionId && a.actionKey === action.actionKey,
      );
      if (i === -1) throw new Error("replaceAction: no such action");
      // Re-check the unresolved uniqueness on transition INTO an unresolved state.
      if (UNRESOLVED_ACTION_STATUSES.includes(action.status)) {
        const clash = actions.find(
          (a, j) => j !== i && a.clientId === action.clientId && a.actionKey === action.actionKey
            && UNRESOLVED_ACTION_STATUSES.includes(a.status),
        );
        if (clash) refuse("pae_one_unresolved_per_action",
          `${action.clientId} already has an unresolved action for ${action.actionKey}`);
      }
      actions[i] = clone(action);
      return clone(action);
    },
  };
}

function createExecutionClaimAuthority({ store, now } = {}) {
  if (!store) throw new Error("createExecutionClaimAuthority requires a store");
  if (typeof now !== "function") throw new Error("createExecutionClaimAuthority requires an injected now()");
  const stamp = () => now().toISOString();

  const classify = (error) => {
    const code = error && error.code;
    if (code === "23505") return CLAIM_CODES.ALREADY_CLAIMED;
    return CLAIM_CODES.STORE_UNAVAILABLE;
  };

  /**
   * Claim the right to execute a plan. Refuses outright if this client has any
   * unresolved execution — the durable half of "no second agent".
   */
  async function claimExecution({ clientId, plan, actor, environmentTag, attemptOrdinal = 1 }) {
    if (!clientId || !plan) return fail(CLAIM_CODES.INVALID, "clientId and plan are required");
    if (plan.clientId !== clientId) return fail(CLAIM_CODES.CROSS_TENANT, "the plan belongs to another client");

    const existing = await store.listExecutions(clientId);
    const unresolved = existing.find((e) => UNRESOLVED_EXECUTION_STATUSES.includes(e.status));
    if (unresolved) {
      return fail(CLAIM_CODES.UNRESOLVED_EXISTS,
        `${clientId} has an unresolved execution (${unresolved.executionId}, ${unresolved.status}). Reconcile before starting another.`,
        { unresolvedExecutionId: unresolved.executionId, unresolvedStatus: unresolved.status });
    }

    const execution = {
      executionId: executionIdFor({ clientId, planHash: plan.planHash, attemptOrdinal }),
      clientId,
      planId: plan.planId,
      planHash: plan.planHash,
      configVersion: plan.configVersion,
      configContentHash: plan.configContentHash ?? null,
      behaviourHash: plan.behaviourHash,
      provider: plan.provider,
      providerTag: environmentTag ?? null,
      actor: actor ?? null,
      status: "claimed",
      startedAt: stamp(),
      completedAt: null,
      attemptOrdinal,
    };
    try {
      return okay({ execution: await store.putExecution(execution) });
    } catch (error) {
      return fail(classify(error), error.message || String(error));
    }
  }

  /**
   * Claim ONE action. This is the write that must happen before the provider is
   * contacted, and the uniqueness that makes it a claim is the database's.
   */
  async function claimAction({ clientId, executionId, plan, action, actionOrdinal }) {
    const record = {
      clientId,
      executionId,
      planId: plan.planId,
      actionKey: action.key,
      actionOrdinal,
      actionKind: action.action,
      purpose: action.purpose,
      resourceType: action.resourceType,
      desiredPayloadHash: action.desiredPayloadHash ?? null,
      providerRequestId: providerRequestId({
        clientId,
        planHash: plan.planHash,
        actionKey: action.key,
        desiredPayloadHash: action.desiredPayloadHash ?? "",
        actionKind: action.action,
      }),
      providerResourceId: null,
      status: "claimed",
      ambiguityReason: null,
      claimedAt: stamp(),
      attemptedAt: null,
      resolvedAt: null,
      detail: null,
    };

    const valid = validateActionExecution(record);
    if (!valid.ok) return fail(CLAIM_CODES.INVALID, "the action execution record is not valid", { errors: valid.errors });

    try {
      return okay({ action: await store.putAction(record) });
    } catch (error) {
      return fail(classify(error), error.message || String(error));
    }
  }

  /** Move one action to a resolved (or explicitly unresolved) state. */
  async function resolveAction({ clientId, executionId, actionKey, status, providerResourceId = null, ambiguityReason = null, detail = null }) {
    if (!ACTION_EXECUTION_STATUSES.includes(status)) {
      return fail(CLAIM_CODES.INVALID, `unknown action status "${status}"`);
    }
    const all = await store.listActions(clientId);
    const current = all.find((a) => a.executionId === executionId && a.actionKey === actionKey);
    if (!current) return fail(CLAIM_CODES.NOT_FOUND, `no claimed action ${actionKey} in ${executionId}`);

    const next = {
      ...current,
      status,
      providerResourceId: providerResourceId ?? current.providerResourceId,
      ambiguityReason: ambiguityReason ?? current.ambiguityReason,
      detail: detail ?? current.detail,
      attemptedAt: current.attemptedAt || stamp(),
      resolvedAt: UNRESOLVED_ACTION_STATUSES.includes(status) ? null : stamp(),
    };
    try {
      return okay({ action: await store.replaceAction(next) });
    } catch (error) {
      return fail(classify(error), error.message || String(error));
    }
  }

  async function resolveExecution({ clientId, executionId, status, detail = null }) {
    if (!EXECUTION_STATUSES.includes(status)) return fail(CLAIM_CODES.INVALID, `unknown execution status "${status}"`);
    const all = await store.listExecutions(clientId);
    const current = all.find((e) => e.executionId === executionId);
    if (!current) return fail(CLAIM_CODES.NOT_FOUND, `no execution ${executionId}`);
    const next = {
      ...current,
      status,
      detail: detail ?? current.detail ?? null,
      completedAt: UNRESOLVED_EXECUTION_STATUSES.includes(status) ? null : stamp(),
    };
    try {
      return okay({ execution: await store.replaceExecution(next) });
    } catch (error) {
      return fail(classify(error), error.message || String(error));
    }
  }

  async function listExecutions(clientId) { return store.listExecutions(clientId); }
  async function listActions(clientId) { return store.listActions(clientId); }

  /** Everything a person must deal with before anything else may be sent. */
  async function findUnresolved(clientId) {
    const executions = (await store.listExecutions(clientId)).filter((e) => UNRESOLVED_EXECUTION_STATUSES.includes(e.status));
    const actions = (await store.listActions(clientId)).filter((a) => UNRESOLVED_ACTION_STATUSES.includes(a.status));
    return Object.freeze({
      executions: Object.freeze(executions),
      actions: Object.freeze(actions),
      blocking: executions.length > 0 || actions.length > 0,
      // Loudest first: a resource that exists and was never recorded.
      unrecorded: Object.freeze(actions.filter((a) => a.status === "persist_failed_after_provider_success")),
      ambiguous: Object.freeze(actions.filter((a) => a.status === "unknown")),
    });
  }

  return Object.freeze({
    claimExecution, claimAction, resolveAction, resolveExecution,
    listExecutions, listActions, findUnresolved,
  });
}

module.exports = { createExecutionClaimAuthority, createInMemoryExecutionStore, CLAIM_CODES };
