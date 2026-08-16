// AIDA PLATFORM — the one-shot provisioning executor (P24–P26).
//
//   createProvisioningExecutor({ ... }).execute({ principal, clientId, planId, providerAdapter })
//
// ── WHAT IT DOES, IN ORDER, AND STOPS ───────────────────────────────
//
//   approved plan
//     -> 18 preflight gates            execution-preflight.js
//     -> durable execution claim       execution-claim.js
//     -> per action, in dependency order:
//          durable action claim        BEFORE the provider is contacted
//          exactly one mutation        provider-mutation-port.js
//          classify the outcome        definite_success | definite_failure | unknown
//          on success: registry write  resource-registry-writer.js
//     -> resolve the execution
//
// ── THE THREE THINGS IT WILL NOT DO ─────────────────────────────────
//
//   1. IT DOES NOT LOOP. One authorised action, one send. There is no retry
//      anywhere in this file, for any outcome, including a definite failure.
//
//   2. IT DOES NOT CONTINUE PAST AN AMBIGUOUS OR FAILED ACTION. A plan is a
//      sequence somebody approved as a whole; half of it is not what they
//      approved, and continuing past an UNKNOWN means acting while the state
//      of a resource that may exist is undetermined.
//
//   3. IT DOES NOT COMPENSATE. If the engine is created and the agent then
//      fails definitely, the engine is NOT deleted. Provider APIs have no
//      cross-resource transaction, so a "rollback" is just another unreviewed
//      mutation. The partial state is recorded truthfully and a person decides.
//
// ── AND WHAT IT CANNOT DO ───────────────────────────────────────────
// It never constructs a provider client. The adapter is handed in, and the
// only adapters that exist are fakes. There is no environment variable, flag
// or credential that changes that: wiring real transport is a separate code
// milestone. A ratchet reads this file's imports.

const { assertExecutionPreflight } = require("./execution-preflight");
const { createExecutionClaimAuthority } = require("./execution-claim");
const { createProviderMutationPort } = require("./provider-mutation-port");
const { createResourceRegistryWriter, REGISTRY_CODES } = require("./resource-registry-writer");
const { OUTCOME_RULES, describeExecutionOutcome, RETIREMENT_MODES } = require("./execution-model");

const EXECUTOR_OUTCOMES = Object.freeze({
  OK: "ok",
  REFUSED: "refused",
  STOPPED: "stopped",
  UNAVAILABLE: "unavailable",
});

const ok = (value = {}) => Object.freeze({ ok: true, outcome: EXECUTOR_OUTCOMES.OK, ...value });
const no = (outcome, code, message, extra = {}) => Object.freeze({ ok: false, outcome, code, message, ...extra });

function createProvisioningExecutor({
  planAuthority, configService, desiredStateCompiler, executionStore, registry,
  now, environmentTag = null, audit = null,
} = {}) {
  if (!planAuthority) throw new Error("createProvisioningExecutor requires the plan authority");
  if (typeof now !== "function") throw new Error("createProvisioningExecutor requires an injected now()");

  const claims = createExecutionClaimAuthority({ store: executionStore, now });
  const registryWriter = createResourceRegistryWriter({ registry, now });

  async function record(eventType, { principal, clientId, detail, executionId, actionKey }) {
    if (!audit || typeof audit.append !== "function") return;
    try {
      await audit.append({
        clientId,
        eventType,
        actor: principal ? principal.actorId : null,
        actorRole: principal ? principal.role : null,
        source: "operator",
        // Ids and hashes only. Never a payload, never a credential.
        metadata: {
          executionId: executionId ?? null,
          actionKey: actionKey ?? null,
          detail: detail ? String(detail).slice(0, 400) : null,
        },
      });
    } catch { /* an audit sink being down must not take provisioning down */ }
  }

  /**
   * @param {object} providerAdapter  handed in explicitly. Only fakes exist.
   */
  async function execute({ principal, clientId, planId, providerAdapter = null, attemptOrdinal = 1 }) {
    await record("execution_requested", { principal, clientId, detail: planId });

    // ── gather everything the preflight needs, without touching anything ──
    const planResult = await planAuthority.getPlan(clientId, planId);
    const plan = planResult.ok ? planResult.plan : null;

    const activeResult = await configService.getActive({ principal, clientId });
    const version = activeResult.ok ? activeResult.version : null;
    const activeConfig = version
      ? {
        configVersion: version.metadata.configVersion,
        configContentHash: version.metadata.contentHash ?? null,
        behaviourHash: null,
      }
      : null;

    const desired = version && desiredStateCompiler ? desiredStateCompiler(version) : null;
    const priorExecutions = await claims.listExecutions(clientId);
    const priorActions = await claims.listActions(clientId);

    // ── the durable claim. Taken BEFORE the gates evaluate gate 16, because
    //    the claim IS one of the gates and must be a real attempt. If it is
    //    refused, the gates report it and nothing is sent. ──
    let claimed = null;
    let claimResult = { acquired: false, detail: "not attempted" };
    if (plan) {
      const attempt = await claims.claimExecution({ clientId, plan, actor: principal ? principal.actorId : null, environmentTag, attemptOrdinal });
      claimResult = attempt.ok
        ? { acquired: true, detail: attempt.execution.executionId }
        : { acquired: false, detail: `${attempt.code}: ${attempt.message}` };
      if (attempt.ok) claimed = attempt.execution;
    }

    const preflight = assertExecutionPreflight({
      principal, clientId, plan, activeConfig, desired,
      environmentTag, priorExecutions, priorActions,
      claim: claimResult, providerAdapter,
    });

    if (!preflight.ok) {
      // Release the claim if we took one, so a refusal on some OTHER gate does
      // not leave the client permanently blocked by our own bookkeeping.
      if (claimed) {
        await claims.resolveExecution({
          clientId, executionId: claimed.executionId, status: "abandoned",
          detail: `preflight refused: ${preflight.summary}`,
        });
      }
      await record("execution_refused", { principal, clientId, detail: preflight.summary, executionId: claimed ? claimed.executionId : null });
      return no(EXECUTOR_OUTCOMES.REFUSED, "execution_preflight_failed",
        "the executor refused before contacting anything", {
          gates: preflight.gates, blockers: preflight.blockers, blockerCount: preflight.blockerCount,
        });
    }

    await record("execution_claimed", { principal, clientId, executionId: claimed.executionId });

    const port = createProviderMutationPort({ adapter: providerAdapter, name: providerAdapter.name || "fake" });
    const results = [];
    let stopped = null;

    // ── one action at a time, in the order the plan records ──
    for (let i = 0; i < plan.actions.length; i += 1) {
      const action = plan.actions[i];

      // Nothing to do, nothing to send, nothing to claim.
      if (action.action === "no_change") {
        results.push({ actionKey: action.key, action: action.action, status: "completed", providerContacted: false });
        continue;
      }
      if (action.action === "reconcile_required") {
        stopped = { reason: "reconcile_required", actionKey: action.key };
        break;
      }

      // ── THE CLAIM, BEFORE THE PROVIDER ──
      const claimAction = await claims.claimAction({ clientId, executionId: claimed.executionId, plan, action, actionOrdinal: i });
      if (!claimAction.ok) {
        stopped = { reason: "action_claim_refused", actionKey: action.key, detail: claimAction.message };
        break;
      }
      const claimedAction = claimAction.action;

      // ── EXACTLY ONE MUTATION ──
      const request = buildRequest({ clientId, action, claimedAction, desired, environmentTag });
      await record("provider_attempted", { principal, clientId, executionId: claimed.executionId, actionKey: action.key });

      const result = await sendOnce(port, action.action, request);
      const rule = OUTCOME_RULES[result.outcome];

      if (result.outcome === "unknown") {
        await claims.resolveAction({
          clientId, executionId: claimed.executionId, actionKey: action.key,
          status: "unknown", ambiguityReason: result.ambiguityReason, detail: result.detail,
        });
        await record("provider_unknown", { principal, clientId, executionId: claimed.executionId, actionKey: action.key, detail: result.ambiguityReason });
        results.push({ actionKey: action.key, action: action.action, status: "unknown", ambiguityReason: result.ambiguityReason, providerContacted: true });
        stopped = { reason: "provider_unknown", actionKey: action.key };
        break;
      }

      if (result.outcome === "definite_failure") {
        await claims.resolveAction({
          clientId, executionId: claimed.executionId, actionKey: action.key,
          status: "provider_failed_definite", detail: result.detail,
        });
        await record("provider_failed", { principal, clientId, executionId: claimed.executionId, actionKey: action.key, detail: result.detail });
        results.push({ actionKey: action.key, action: action.action, status: "provider_failed_definite", detail: result.detail, providerContacted: true });
        stopped = { reason: "provider_failed_definite", actionKey: action.key };
        break;
      }

      // ── definite success. The resource EXISTS. Now the dangerous half. ──
      await claims.resolveAction({
        clientId, executionId: claimed.executionId, actionKey: action.key,
        status: "provider_succeeded", providerResourceId: result.providerResourceId,
      });
      await record("provider_succeeded", { principal, clientId, executionId: claimed.executionId, actionKey: action.key });

      const written = action.action === "retire"
        ? await registryWriter.recordRetired({
          clientId, provider: plan.provider, purpose: action.purpose, resourceType: action.resourceType,
          providerResourceId: result.providerResourceId,
          retirementMode: action.retirementMode || "registry_inactive",
        })
        : await registryWriter.recordProvisioned({
          clientId, provider: plan.provider, providerTag: environmentTag,
          purpose: action.purpose, resourceType: action.resourceType,
          providerResourceId: result.providerResourceId,
          payloadHash: action.desiredPayloadHash,
          provenance: provenanceFor(desired, action),
          actionKind: action.action,
          idempotencyKey: claimedAction.providerRequestId,
        });

      if (!written.ok) {
        const isPersistFailure = written.code === REGISTRY_CODES.PERSIST_FAILED;
        await claims.resolveAction({
          clientId, executionId: claimed.executionId, actionKey: action.key,
          status: isPersistFailure ? "persist_failed_after_provider_success" : "manual_reconciliation_required",
          providerResourceId: result.providerResourceId,
          detail: written.message,
        });
        await record("registry_persist_failed", {
          principal, clientId, executionId: claimed.executionId, actionKey: action.key,
          detail: `provider_resource_id=${result.providerResourceId}`,
        });
        results.push({
          actionKey: action.key, action: action.action,
          status: isPersistFailure ? "persist_failed_after_provider_success" : "manual_reconciliation_required",
          providerResourceId: result.providerResourceId,
          providerContacted: true,
          warning: written.message,
        });
        stopped = { reason: "registry_persist_failed", actionKey: action.key, providerResourceId: result.providerResourceId };
        break;
      }

      await claims.resolveAction({
        clientId, executionId: claimed.executionId, actionKey: action.key,
        status: "completed", providerResourceId: result.providerResourceId,
      });
      await record("registry_recorded", { principal, clientId, executionId: claimed.executionId, actionKey: action.key });
      results.push({
        actionKey: action.key, action: action.action, status: "completed",
        providerResourceId: result.providerResourceId, providerContacted: true,
      });
    }

    // ── resolve the execution truthfully ──
    const executionStatus = !stopped
      ? "completed"
      : stopped.reason === "provider_failed_definite"
        ? "failed"
        : stopped.reason === "provider_unknown"
          ? "unknown"
          : "manual_reconciliation_required";

    await claims.resolveExecution({
      clientId, executionId: claimed.executionId, status: executionStatus,
      detail: stopped ? `${stopped.reason} at ${stopped.actionKey}` : null,
    });
    if (executionStatus === "completed") {
      await record("execution_completed", { principal, clientId, executionId: claimed.executionId });
    } else if (executionStatus !== "failed") {
      await record("manual_review_required", { principal, clientId, executionId: claimed.executionId, detail: stopped.reason });
    }

    const finalActions = (await claims.listActions(clientId)).filter((a) => a.executionId === claimed.executionId);
    const finalExecution = (await claims.listExecutions(clientId)).find((e) => e.executionId === claimed.executionId);

    const summary = describeExecutionOutcome(finalExecution, finalActions);
    const body = {
      executionId: claimed.executionId,
      status: executionStatus,
      usedFakeProvider: port.isFake === true,
      adapterName: port.adapterName,
      results: Object.freeze(results),
      summary,
      // Repeated at the boundary, like everywhere else in this subsystem.
      note: port.isFake
        ? "A FAKE provider was used. No real provider was contacted; no real resource exists."
        : "No real provider adapter exists in this build.",
    };

    if (executionStatus === "completed") return ok(body);
    return no(EXECUTOR_OUTCOMES.STOPPED, `execution_${executionStatus}`,
      stopped ? `stopped at ${stopped.actionKey}: ${stopped.reason}` : "stopped", body);
  }

  return Object.freeze({ execute, claims, registryWriter });
}

/** ONE call. Deliberately not a helper that could be looped. */
async function sendOnce(port, actionKind, request) {
  if (actionKind === "retire") return port.retireResource(request);
  if (actionKind === "update") return port.updateResource(request);
  // create and replace both CREATE a resource. A replace differs in what
  // happens afterwards — the old one is retired by a separate action — not in
  // what is sent now.
  return port.createResource(request);
}

function buildRequest({ clientId, action, claimedAction, desired, environmentTag }) {
  const want = desired && desired.ok
    ? desired.resources.find((r) => `${r.purpose}:${r.resourceType}` === action.key)
    : null;
  const base = {
    clientId,
    purpose: action.purpose,
    resourceType: action.resourceType,
    providerRequestId: claimedAction.providerRequestId,
    providerTag: environmentTag,
  };
  if (action.action === "retire") {
    return {
      ...base,
      providerResourceId: action.providerResourceId,
      retirementMode: action.retirementMode || "registry_inactive",
    };
  }
  if (action.action === "update") {
    return { ...base, payload: want ? want.payload : null, providerResourceId: action.providerResourceId };
  }
  return { ...base, payload: want ? want.payload : null };
}

function provenanceFor(desired, action) {
  if (!desired || !desired.ok) return null;
  const want = desired.resources.find((r) => `${r.purpose}:${r.resourceType}` === action.key);
  return want ? want.provenance : null;
}

module.exports = { createProvisioningExecutor, EXECUTOR_OUTCOMES, RETIREMENT_MODES };
