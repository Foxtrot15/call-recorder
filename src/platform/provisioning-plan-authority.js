// AIDA PLATFORM — provisioning plans, and what makes one executable (P22).
//
//   createPlanAuthority({ store, now })
//     .createPlan / getPlan / listPlans / validatePlan / approvePlan
//     .cancelPlan / assertExecutable
//
// ── FIVE INVARIANTS ─────────────────────────────────────────────────
//
// 1. A PLAN BINDS TO ONE EXACT CONFIGURATION. Not "this client", not "the
//    latest" — this client at this config version with this behaviour hash.
//
// 2. IF THE CONFIGURATION MOVES, THE PLAN IS STALE. Approving a plan is
//    approving a set of provider mutations computed from specific words. If
//    the words change afterwards the approval no longer describes reality, and
//    a stale plan can never execute. It is not silently regenerated either —
//    regeneration would produce actions nobody approved.
//
// 3. ACTIONS ARE FROZEN AT APPROVAL, AND THE APPROVAL BINDS TO THE PLAN HASH.
//    The hash covers the actions and the configuration binding. A plan whose
//    body changed after approval cannot satisfy its own approval record.
//
// 4. EDITING IS NOT EXECUTION AUTHORITY. Whoever built the plan does not
//    thereby gain the right to run it, and approving does not either. Three
//    separate capabilities, checked by config-access.
//
// 5. NOTHING HERE EXECUTES. There is no execute operation, no provider import
//    and no transport. `assertExecutable` answers a QUESTION — it performs
//    nothing, and its name says so.
//
// ── EXECUTION STATUSES ARE DECLARED BUT UNREACHABLE ─────────────────
// `executing`, `completed`, `failed` and `unknown` exist in the vocabulary so
// the state machine is designed before anything can move through it. No
// operation in this module can set them. A test asserts that.

const crypto = require("crypto");
const { stableStringify } = require("./stable-json");
const {
  PLAN_STATUSES, PLAN_EXECUTION_STATUSES, PROVISIONING_ACTIONS, MUTATING_ACTIONS,
} = require("./provisioning-model");

const PLAN_CODES = Object.freeze({
  OK: "ok",
  NOT_FOUND: "plan_not_found",
  CROSS_TENANT: "cross_tenant_plan_refused",
  INVALID: "plan_invalid",
  NOT_A_DRAFT: "plan_is_not_a_draft",
  NOT_VALIDATED: "plan_is_not_validated",
  NOT_APPROVED: "plan_is_not_approved",
  ALREADY_APPROVED: "plan_is_already_approved",
  STALE: "plan_is_stale",
  HASH_MISMATCH: "plan_hash_does_not_match_its_approval",
  NOT_A_PERSON: "approver_is_not_a_person",
  TERMINAL: "plan_is_in_a_terminal_state",
  NOT_EXECUTABLE: "plan_is_not_executable",
  UNRESOLVED_REFS: "provider_references_unresolved",
  STORE_UNAVAILABLE: "provisioning_store_unavailable",
});

/** The same rejection every other approval in this codebase uses. */
const NON_HUMAN_APPROVERS = /^(system|automation|automated|auto|aida|bot|robot|ai|agent|assistant|claude|gpt|llm|service|cron|scheduler|worker|daemon)$/i;

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });
const okay = (value) => Object.freeze({ ok: true, code: PLAN_CODES.OK, ...value });
const clone = (v) => JSON.parse(JSON.stringify(v));

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.getOwnPropertyNames(value).forEach((k) => deepFreeze(value[k]));
  return Object.freeze(value);
}

/**
 * What a person is actually saying yes to. Covers the actions AND the exact
 * configuration they were computed from — so an approval cannot be carried
 * over to a different configuration that happens to produce a similar plan.
 */
function planHashOf(plan) {
  return crypto.createHash("sha256").update(stableStringify({
    clientId: plan.clientId,
    provider: plan.provider,
    configVersion: plan.configVersion,
    configContentHash: plan.configContentHash,
    behaviourHash: plan.behaviourHash,
    desiredHash: plan.desiredHash,
    actions: plan.actions.map((a) => ({
      key: a.key,
      action: a.action,
      purpose: a.purpose,
      resourceType: a.resourceType,
      desiredPayloadHash: a.desiredPayloadHash,
      currentPayloadHash: a.currentPayloadHash,
      dependencyHash: a.dependencyHash ?? null,
    })),
  })).digest("hex");
}

/** An in-memory plan store, mirroring the blueprint store's shape. */
function createInMemoryPlanStore() {
  const byClient = new Map();
  const list = (clientId) => byClient.get(clientId) || [];
  return {
    kind: "memory",
    async listPlans(clientId) { return list(clientId).map(clone); },
    async getPlan(clientId, planId) {
      const hit = list(clientId).find((p) => p.planId === planId);
      return hit ? clone(hit) : null;
    },
    async putPlan(plan) {
      const arr = list(plan.clientId);
      arr.push(clone(plan));
      byClient.set(plan.clientId, arr);
      return clone(plan);
    },
    async replacePlan(plan) {
      const arr = list(plan.clientId);
      const i = arr.findIndex((p) => p.planId === plan.planId);
      if (i === -1) throw new Error("replacePlan: no such plan");
      arr[i] = clone(plan);
      byClient.set(plan.clientId, arr);
      return clone(plan);
    },
  };
}

function createPlanAuthority({ store, now, planId } = {}) {
  if (!store) throw new Error("createPlanAuthority requires a store");
  if (typeof now !== "function") throw new Error("createPlanAuthority requires an injected now()");
  let counter = 0;
  const nextPlanId = () => (typeof planId === "function" ? planId() : `plan_${String(++counter).padStart(6, "0")}`);
  const stamp = () => now().toISOString();

  /** Every read is scoped by tenant, and a body that disagrees is refused. */
  async function load(clientId, id) {
    const plan = await store.getPlan(clientId, id);
    if (!plan) return null;
    if (plan.clientId !== clientId) return { crossTenant: true, plan };
    return { crossTenant: false, plan };
  }

  /**
   * Build a plan from a diff. The diff already carries its configuration
   * binding; this records it and freezes nothing yet.
   */
  async function createPlan({ clientId, diff, configContentHash = null, createdBy = null, notes = null }) {
    if (!clientId) return fail(PLAN_CODES.INVALID, "clientId is required");
    if (!diff || diff.ok !== true) return fail(PLAN_CODES.INVALID, "a successful provisioning diff is required");
    if (diff.clientId !== clientId) {
      return fail(PLAN_CODES.CROSS_TENANT, `the diff belongs to "${diff.clientId}", not "${clientId}"`);
    }
    for (const action of diff.actions) {
      if (!PROVISIONING_ACTIONS.includes(action.action)) {
        return fail(PLAN_CODES.INVALID, `unknown action "${action.action}"`);
      }
    }

    const plan = {
      planId: nextPlanId(),
      clientId,
      provider: diff.provider,
      status: "draft",

      // THE BINDING. All four together, so an approval cannot drift onto a
      // different configuration that happens to look similar.
      configVersion: diff.configVersion,
      configContentHash,
      behaviourHash: diff.behaviourHash,
      desiredHash: diff.desiredHash,

      actions: clone(diff.actions),
      counts: clone(diff.counts),
      mutatingCount: diff.mutatingCount,
      isNoOp: diff.isNoOp,
      requiresReconciliation: diff.requiresReconciliation,

      createdAt: stamp(),
      createdBy,
      notes,

      validatedAt: null,
      blockingReasons: [],
      approvedAt: null,
      approvedBy: null,
      approvedPlanHash: null,
      approvalReason: null,

      // Declared, and unreachable from this module.
      executionState: null,
      executedAt: null,
      executedBy: null,

      cancelledAt: null,
      supersededAt: null,
      supersededBy: null,
    };
    plan.planHash = planHashOf(plan);

    // A new plan supersedes any earlier open plan for the same client — two
    // open plans for one client is two people about to change the same
    // telephone service.
    for (const other of await store.listPlans(clientId)) {
      if (["draft", "validated", "approved"].includes(other.status)) {
        await store.replacePlan({ ...other, status: "superseded", supersededAt: stamp(), supersededBy: plan.planId });
      }
    }

    return okay({ plan: await store.putPlan(plan) });
  }

  async function getPlan(clientId, id) {
    const found = await load(clientId, id);
    if (!found) return fail(PLAN_CODES.NOT_FOUND, `no plan ${id} for ${clientId}`);
    if (found.crossTenant) return fail(PLAN_CODES.CROSS_TENANT, "plan belongs to another client");
    return okay({ plan: found.plan });
  }

  async function listPlans(clientId) {
    const all = await store.listPlans(clientId);
    return okay({
      plans: all
        .filter((p) => p.clientId === clientId)
        .map((p) => ({
          planId: p.planId, status: p.status, configVersion: p.configVersion,
          planHash: p.planHash, createdAt: p.createdAt, createdBy: p.createdBy,
          approvedAt: p.approvedAt, approvedBy: p.approvedBy,
          mutatingCount: p.mutatingCount, isNoOp: p.isNoOp,
        })),
    });
  }

  /**
   * Validation is a transition and a staleness check in one. `currentConfig`
   * is what the configuration authority says is active RIGHT NOW.
   */
  async function validatePlan({ clientId, planId: id, currentConfig }) {
    const got = await getPlan(clientId, id);
    if (!got.ok) return got;
    const plan = got.plan;

    if (["cancelled", "superseded", ...PLAN_EXECUTION_STATUSES].includes(plan.status)) {
      return fail(PLAN_CODES.TERMINAL, `plan ${id} is ${plan.status}`);
    }
    if (plan.status === "approved") {
      return fail(PLAN_CODES.ALREADY_APPROVED, `plan ${id} is already approved — validating again would change what was approved`);
    }

    const blocking = [];
    const stale = describeStaleness(plan, currentConfig);
    if (stale.stale) blocking.push({ code: PLAN_CODES.STALE, message: stale.why });
    if (plan.requiresReconciliation) {
      blocking.push({
        code: "reconciliation_required",
        message: "one or more resources could not be classified because their recorded state is not trustworthy",
      });
    }
    if (plan.planHash !== planHashOf(plan)) {
      blocking.push({ code: PLAN_CODES.HASH_MISMATCH, message: "the plan body no longer hashes to its recorded plan hash" });
    }

    const next = { ...clone(plan), blockingReasons: blocking };
    if (blocking.length) {
      const saved = await store.replacePlan({ ...next, status: "draft" });
      return fail(PLAN_CODES.INVALID, "the plan cannot be approved as it stands", { plan: saved, blockingReasons: blocking });
    }
    const saved = await store.replacePlan({ ...next, status: "validated", validatedAt: stamp() });
    return okay({ plan: saved });
  }

  /**
   * Approval freezes the actions and binds to the exact plan hash. A named
   * human only — a system cannot approve its own provider mutations.
   */
  async function approvePlan({ clientId, planId: id, approvedBy, reason = null, expectedPlanHash = null, currentConfig }) {
    const got = await getPlan(clientId, id);
    if (!got.ok) return got;
    const plan = got.plan;

    if (plan.status === "approved") return fail(PLAN_CODES.ALREADY_APPROVED, `plan ${id} is already approved`);
    if (plan.status !== "validated") return fail(PLAN_CODES.NOT_VALIDATED, `plan ${id} is ${plan.status} — validate it first`);

    const who = typeof approvedBy === "string" ? approvedBy.trim() : "";
    if (!who) return fail(PLAN_CODES.NOT_A_PERSON, "approval requires a named person");
    if (NON_HUMAN_APPROVERS.test(who)) {
      return fail(PLAN_CODES.NOT_A_PERSON, `"${who}" is not a person — provisioning cannot approve itself`);
    }

    // The reviewer states which plan they read. A mismatch means the plan
    // moved between the screen and the button.
    if (expectedPlanHash !== null && expectedPlanHash !== plan.planHash) {
      return fail(PLAN_CODES.HASH_MISMATCH, "this is not the plan that was reviewed", {
        expectedPlanHash, actualPlanHash: plan.planHash,
      });
    }
    // Re-check staleness AT THE MOMENT OF APPROVAL. Validating earlier is not
    // evidence the configuration has not moved since.
    const stale = describeStaleness(plan, currentConfig);
    if (stale.stale) return fail(PLAN_CODES.STALE, stale.why);

    const recomputed = planHashOf(plan);
    if (recomputed !== plan.planHash) {
      return fail(PLAN_CODES.HASH_MISMATCH, "the plan body changed after it was built");
    }

    const saved = await store.replacePlan({
      ...clone(plan),
      status: "approved",
      approvedAt: stamp(),
      approvedBy: who,
      approvalReason: reason,
      approvedPlanHash: recomputed,
    });
    return okay({ plan: deepFreeze(saved), executable: false, note: "Approved. Execution is a separate authority that does not exist yet." });
  }

  async function cancelPlan({ clientId, planId: id, reason = null }) {
    const got = await getPlan(clientId, id);
    if (!got.ok) return got;
    if (PLAN_EXECUTION_STATUSES.includes(got.plan.status)) {
      return fail(PLAN_CODES.TERMINAL, `plan ${id} is ${got.plan.status} and cannot be cancelled`);
    }
    const saved = await store.replacePlan({ ...clone(got.plan), status: "cancelled", cancelledAt: stamp(), notes: reason });
    return okay({ plan: saved });
  }

  /**
   * ── THE EXECUTION QUESTION, ASKED AND NEVER ANSWERED BY ACTING ────
   *
   * Returns whether every precondition a future executor must satisfy is met
   * RIGHT NOW. It performs nothing, mutates nothing and returns no capability.
   * `executable: true` from this function authorises nobody — the caller still
   * needs `provisioning:execute`, and no executor exists.
   */
  async function assertExecutable({ clientId, planId: id, currentConfig, providerTag = null, expectedProviderTag = null }) {
    const got = await getPlan(clientId, id);
    if (!got.ok) return got;
    const plan = got.plan;
    const blockers = [];

    if (plan.status !== "approved") blockers.push({ code: PLAN_CODES.NOT_APPROVED, message: `plan is ${plan.status}` });
    if (plan.approvedPlanHash !== plan.planHash) blockers.push({ code: PLAN_CODES.HASH_MISMATCH, message: "approval does not bind this body" });
    if (planHashOf(plan) !== plan.planHash) blockers.push({ code: PLAN_CODES.HASH_MISMATCH, message: "the plan body changed after approval" });

    const stale = describeStaleness(plan, currentConfig);
    if (stale.stale) blockers.push({ code: PLAN_CODES.STALE, message: stale.why });

    if (plan.requiresReconciliation) {
      blockers.push({ code: "reconciliation_required", message: "recorded provider state is not trustworthy" });
    }
    if (expectedProviderTag !== null && providerTag !== expectedProviderTag) {
      blockers.push({ code: "provider_tag_mismatch", message: `plan is for "${expectedProviderTag}", the environment says "${providerTag}"` });
    }
    // And the one that is always true in this batch.
    blockers.push({
      code: "no_executor_exists",
      message: "provisioning execution is not implemented. There is no code path from an approved plan to a provider.",
    });

    return okay({
      planId: plan.planId,
      executable: false,          // hardcoded. See the blocker above.
      blockers: Object.freeze(blockers),
      note: "assertExecutable answers a question. It is not a permission and it performs nothing.",
    });
  }

  return Object.freeze({
    createPlan, getPlan, listPlans, validatePlan, approvePlan, cancelPlan, assertExecutable,
  });
}

/**
 * Is this plan still describing the configuration that is active now?
 * Exported so the readiness view can ask without touching the store.
 */
function describeStaleness(plan, currentConfig) {
  if (!currentConfig) {
    return { stale: true, why: "there is no active configuration for this client, so the plan describes nothing current" };
  }
  if (currentConfig.configVersion !== plan.configVersion) {
    return { stale: true, why: `the plan was built for config v${plan.configVersion}; v${currentConfig.configVersion} is active now` };
  }
  if (currentConfig.behaviourHash && plan.behaviourHash && currentConfig.behaviourHash !== plan.behaviourHash) {
    return { stale: true, why: "the active configuration's behaviour hash has changed since the plan was built" };
  }
  if (plan.configContentHash && currentConfig.configContentHash && plan.configContentHash !== currentConfig.configContentHash) {
    return { stale: true, why: "the active configuration's content hash has changed since the plan was built" };
  }
  return { stale: false };
}

module.exports = {
  createPlanAuthority,
  createInMemoryPlanStore,
  planHashOf,
  describeStaleness,
  PLAN_CODES,
  NON_HUMAN_APPROVERS,
};
