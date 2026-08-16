// AIDA PLATFORM P24–P26 — the one-shot executor, and every way it stops.
//
// Four sentences, proven from several directions each:
//
//   APPROVED PLAN                 is not   EXECUTED PLAN
//   UNKNOWN                       is not   FAILURE
//   PROVIDER SUCCESS + DB FAILURE is not   SAFE TO RETRY
//   AMBIGUOUS OUTCOME             is never AUTOMATICALLY RETRIED
//
// Every provider here is a fake. Nothing in this file can open a socket.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const H = require("./helpers/provisioning-harness");
const M = require("../src/platform/execution-model");
const { assertExecutionPreflight, validateDependencyOrder, PREFLIGHT_CODES } = require("../src/platform/execution-preflight");
const { createExecutionClaimAuthority, createInMemoryExecutionStore, CLAIM_CODES } = require("../src/platform/execution-claim");
const {
  createProviderMutationPort, createFakeProviderAdapter, describeAdapterConformance, validateMutationRequest,
} = require("../src/platform/provider-mutation-port");
const { createResourceRegistryWriter, createInMemoryResourceRegistry, REGISTRY_CODES } = require("../src/platform/resource-registry-writer");
const { createPrincipal, executionPrincipal, ROLES, principalFromRequest, authorise } = require("../src/platform/config-access");
const { garageDoorD, plumberC } = require("../src/platform/fixtures/clients");

const ROOT = path.join(__dirname, "..");
const CID = "rolladoor_repairs";

const ENGINE = "receptionist_agent:response_engine";
const AGENT = "receptionist_agent:voice_agent";

/** A platform with a client already approved and ready to execute. */
async function ready({ behaviours = {}, adapterName = "fake" } = {}) {
  const platform = H.buildPlatform();
  const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD());
  const adapter = createFakeProviderAdapter({ behaviours, name: adapterName });
  return { platform, plan, principals, adapter };
}

const run = (platform, principals, plan, adapter) =>
  platform.executor.execute({ principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: adapter });

// ════════════════════════════════════════════════════════════════════
// P24 — THE MODEL
// ════════════════════════════════════════════════════════════════════

describe("P24 model — UNKNOWN is a first-class state", () => {
  it("declares unknown and persist-failed as statuses, not error strings", () => {
    assert.ok(M.ACTION_EXECUTION_STATUSES.includes("unknown"));
    assert.ok(M.ACTION_EXECUTION_STATUSES.includes("persist_failed_after_provider_success"));
    assert.ok(M.ACTION_EXECUTION_STATUSES.includes("provider_failed_definite"));
    // And they are DIFFERENT things.
    assert.notEqual("unknown", "provider_failed_definite");
  });

  it("treats both as unresolved, so they block further work", () => {
    for (const s of ["claimed", "provider_succeeded", "unknown", "persist_failed_after_provider_success"]) {
      assert.ok(M.UNRESOLVED_ACTION_STATUSES.includes(s), `${s} must block`);
    }
    for (const s of ["completed", "provider_failed_definite", "not_started"]) {
      assert.ok(!M.UNRESOLVED_ACTION_STATUSES.includes(s), `${s} must not block`);
    }
  });

  it("permits NO automatic retry, for any outcome at all", () => {
    for (const outcome of M.PROVIDER_OUTCOMES) {
      assert.equal(M.OUTCOME_RULES[outcome].mayRetryAutomatically, false, `${outcome} must not auto-retry`);
    }
  });

  it("stops the execution on both failure and ambiguity, and only ambiguity needs a human", () => {
    assert.equal(M.OUTCOME_RULES.definite_success.stopsExecution, false);
    assert.equal(M.OUTCOME_RULES.definite_failure.stopsExecution, true);
    assert.equal(M.OUTCOME_RULES.unknown.stopsExecution, true);
    assert.equal(M.OUTCOME_RULES.unknown.requiresHuman, true);
    assert.equal(M.OUTCOME_RULES.definite_failure.requiresHuman, false);
  });

  it("gives the provider request id a deterministic, attempt-independent identity", () => {
    const args = { clientId: CID, planHash: "a".repeat(64), actionKey: ENGINE, desiredPayloadHash: "b".repeat(64), actionKind: "create" };
    assert.equal(M.providerRequestId(args), M.providerRequestId(args));
    assert.match(M.providerRequestId(args), /^[0-9a-f]{64}$/);
    assert.notEqual(M.providerRequestId(args), M.providerRequestId({ ...args, desiredPayloadHash: "c".repeat(64) }));
    assert.notEqual(M.providerRequestId(args), M.providerRequestId({ ...args, actionKey: AGENT }));
  });

  it("distinguishes three retirement modes rather than pretending retire means one thing", () => {
    assert.deepEqual([...M.RETIREMENT_MODES], ["provider_disabled", "provider_deleted", "registry_inactive"]);
    assert.match(M.RETIREMENT_MEANING.registry_inactive, /THE PROVIDER WAS NOT ASKED/);
    assert.match(M.RETIREMENT_MEANING.provider_disabled, /still EXISTS/);
  });

  it("surfaces an unrecorded provider resource as loudly as a return value can", () => {
    const summary = M.describeExecutionOutcome(
      { executionId: "exec_1", status: "manual_reconciliation_required" },
      [{ actionKey: ENGINE, status: "persist_failed_after_provider_success", providerResourceId: "prov_9" }],
    );
    assert.equal(summary.unrecordedProviderResources.length, 1);
    assert.match(summary.unrecordedProviderResources[0].warning, /EXISTS AT THE PROVIDER AND IS NOT RECORDED/);
    assert.match(summary.nextStep, /Do NOT re-run/);
  });
});

// ════════════════════════════════════════════════════════════════════
// P24A — AUTHORITY
// ════════════════════════════════════════════════════════════════════

describe("P24A authority — approve is not execute", () => {
  it("exactly ONE role holds provisioning:execute", () => {
    const holders = Object.entries(ROLES).filter(([, caps]) => caps.includes("provisioning:execute")).map(([r]) => r);
    assert.deepEqual(holders, ["operator_executor"]);
  });

  it("the voice agent never has it", () => {
    assert.ok(!ROLES.voice_agent.includes("provisioning:execute"));
    assert.deepEqual([...ROLES.voice_agent], ["config:propose"]);
  });

  it("a normal client editor never has it", () => {
    for (const role of ["client_viewer", "client_editor", "client_owner", "import", "system"]) {
      assert.ok(!ROLES[role].includes("provisioning:execute"), `${role} must not execute`);
    }
  });

  it("an ordinary operator — who may APPROVE — may not execute", () => {
    assert.ok(ROLES.operator.includes("provisioning:approve"), "the operator approves");
    assert.ok(!ROLES.operator.includes("provisioning:execute"), "and that does not imply executing");
  });

  it("NO HTTP request can produce an execution principal", () => {
    const shapes = [
      { clientId: CID, operatorSession: true, session: { operatorId: "P", authenticated: true } },
      { clientId: CID, clientAuth: { user: { email: "x@y.invalid" } }, client: { platform_role: "operator_executor" } },
      { clientId: CID, clientAuth: { user: { email: "x@y.invalid" } }, client: { platform_role: "operator" } },
      { clientId: CID, operatorSession: true, session: {}, body: { role: "operator_executor" } },
      { clientId: CID, operatorSession: true, session: {}, query: { role: "operator_executor" } },
    ];
    for (const req of shapes) {
      const p = principalFromRequest(req);
      assert.notEqual(p && p.role, "operator_executor", `a request produced ${p && p.role}`);
      assert.equal(authorise({ principal: p, operation: "provisioning:execute", clientId: CID }).ok, false);
    }
  });

  it("an execution principal must be built deliberately, and is tenant-scoped", () => {
    const p = executionPrincipal({ clientId: CID, actorId: "Peter Dang" });
    assert.equal(p.role, "operator_executor");
    assert.equal(authorise({ principal: p, operation: "provisioning:execute", clientId: CID }).ok, true);
    assert.equal(authorise({ principal: p, operation: "provisioning:execute", clientId: "somebody_else" }).ok, false);
  });

  it("refuses to execute when the actor merely approved", async () => {
    const { platform, plan, principals, adapter } = await ready();
    const result = await platform.executor.execute({
      principal: principals.operator, clientId: CID, planId: plan.planId, providerAdapter: adapter,
    });
    assert.equal(result.ok, false);
    const gate = result.blockers.find((b) => b.number === 2);
    assert.ok(gate, "gate 2 must be the one that refused");
    assert.equal(gate.code, PREFLIGHT_CODES.NO_EXECUTE_CAPABILITY);
    assert.equal(adapter.calls.length, 0, "nothing may be sent");
  });
});

// ════════════════════════════════════════════════════════════════════
// P24B — THE EIGHTEEN GATES
// ════════════════════════════════════════════════════════════════════

describe("P24B preflight — eighteen gates, fail closed", () => {
  it("evaluates all eighteen, in order, and fails closed on an empty call", () => {
    const result = assertExecutionPreflight({});
    assert.equal(result.gates.length, 18, "every gate must be evaluated, not short-circuited");
    assert.deepEqual(result.gates.map((g) => g.number), Array.from({ length: 18 }, (_, i) => i + 1));
    assert.equal(result.ok, false, "an empty call must fail closed");

    // Gates that demand POSITIVE evidence must all fail with nothing supplied.
    // The five that pass — 12, 13, 14, 15, 17 — check for the PRESENCE of a
    // blocking condition, and with no data there is none. That is a genuine
    // pass, not a fail-open, and the gates below are what actually stop it.
    const mustFail = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 18];
    for (const n of mustFail) {
      const g = result.gates.find((x) => x.number === n);
      assert.equal(g.passed, false, `gate ${n} (${g.name}) must not pass on empty input`);
    }
    assert.equal(result.blockerCount, mustFail.length);
  });

  it("the gates that CAN pass on empty input are only the absence-of-badness ones", () => {
    const result = assertExecutionPreflight({});
    const passed = result.gates.filter((g) => g.passed).map((g) => g.name);
    assert.deepEqual(passed.sort(), [
      "dependency_order_valid",
      "no_unknown_action",
      "no_unrecorded_provider_resource",
      "no_unresolved_prior_execution",
      "resource_ownership_exact",
    ]);
  });

  it("passes only when EVERY gate passes", async () => {
    const { platform, plan, principals, adapter } = await ready();
    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.ok, true, JSON.stringify(result.blockers || result));
  });

  it("refuses a stale plan immediately before execute", async () => {
    const { platform, plan, principals, adapter } = await ready();
    // The configuration moves after approval.
    const changed = garageDoorD();
    changed.hours.weekly.saturday = { closed: true };
    await H.activateConfig(platform, CID, changed);

    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.ok, false);
    const stale = result.blockers.filter((b) => [8, 9, 10].includes(b.number));
    assert.ok(stale.length >= 1, `expected a staleness gate, got ${result.blockers.map((b) => b.number)}`);
    assert.equal(adapter.calls.length, 0, "a stale plan must send nothing");
  });

  it("refuses a wrong provider tag, read late from the environment", async () => {
    const platform = H.buildPlatform({ environmentTag: "some-other-env" });
    const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD(), { providerTag: "fake-env" });
    const adapter = createFakeProviderAdapter({});
    const result = await platform.executor.execute({ principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: adapter });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.number === 11 && b.code === PREFLIGHT_CODES.WRONG_PROVIDER_TAG));
    assert.equal(adapter.calls.length, 0);
  });

  it("refuses a plan belonging to another tenant", async () => {
    const platform = H.buildPlatform();
    await H.readyToExecute(platform, CID, garageDoorD());
    await H.activateConfig(platform, "riverside_plumbing", plumberC());
    const theirPlan = await H.approvePlan(platform, "riverside_plumbing");

    const wrongTenant = executionPrincipal({ clientId: CID, actorId: "Peter Dang" });
    const adapter = createFakeProviderAdapter({});
    const result = await platform.executor.execute({
      principal: wrongTenant, clientId: "riverside_plumbing", planId: theirPlan.planId, providerAdapter: adapter,
    });
    assert.equal(result.ok, false);
    assert.equal(adapter.calls.length, 0);
  });

  it("refuses when no provider adapter is handed in — gate 18", async () => {
    const { platform, plan, principals } = await ready();
    const result = await platform.executor.execute({
      principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: null,
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.number === 18 && b.code === PREFLIGHT_CODES.EXECUTOR_DISABLED));
  });

  it("validates dependency order and catches an inverted plan", () => {
    assert.equal(validateDependencyOrder([
      { key: ENGINE, dependsOn: [] },
      { key: AGENT, dependsOn: [{ purpose: "receptionist_agent", resourceType: "response_engine" }] },
    ]).ok, true);

    const inverted = validateDependencyOrder([
      { key: AGENT, dependsOn: [{ purpose: "receptionist_agent", resourceType: "response_engine" }] },
      { key: ENGINE, dependsOn: [] },
    ]);
    assert.equal(inverted.ok, false);
    assert.match(inverted.why, /does not appear before it/);
  });

  it("names every gate it refused, so an operator gets the whole list", () => {
    const result = assertExecutionPreflight({ clientId: CID });
    assert.ok(result.summary.includes("1."));
    assert.ok(result.summary.includes("18."));
  });
});

// ════════════════════════════════════════════════════════════════════
// P25 — THE DURABLE CLAIM
// ════════════════════════════════════════════════════════════════════

describe("P25 claim — two processes cannot execute the same action", () => {
  function claims() {
    const now = H.fixedClock();
    const store = createInMemoryExecutionStore();
    return { store, now, authority: createExecutionClaimAuthority({ store, now }) };
  }
  const PLAN = {
    planId: "plan_1", clientId: CID, planHash: "a".repeat(64), configVersion: 1,
    configContentHash: "c".repeat(64), behaviourHash: "b".repeat(64), provider: "retell",
  };
  const ACTION = { key: ENGINE, action: "create", purpose: "receptionist_agent", resourceType: "response_engine", desiredPayloadHash: "d".repeat(64) };

  it("claims an execution and refuses a SECOND while it is unresolved", async () => {
    const { authority } = claims();
    const first = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "B", environmentTag: "t", attemptOrdinal: 2 });
    assert.equal(second.ok, false);
    assert.equal(second.code, CLAIM_CODES.UNRESOLVED_EXISTS);
  });

  it("claims an ACTION and refuses a second claim on the same resource", async () => {
    const { authority } = claims();
    const e1 = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
    const a1 = await authority.claimAction({ clientId: CID, executionId: e1.execution.executionId, plan: PLAN, action: ACTION, actionOrdinal: 0 });
    assert.equal(a1.ok, true, JSON.stringify(a1));

    // A second executor, somehow past the execution-level block, still cannot
    // claim the same action: the uniqueness is on (client, action_key).
    const a2 = await authority.claimAction({ clientId: CID, executionId: "exec_other", plan: PLAN, action: ACTION, actionOrdinal: 0 });
    assert.equal(a2.ok, false);
    assert.equal(a2.code, CLAIM_CODES.ALREADY_CLAIMED);
  });

  it("keeps blocking after an UNKNOWN, which is the whole point", async () => {
    const { authority } = claims();
    const e = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
    await authority.claimAction({ clientId: CID, executionId: e.execution.executionId, plan: PLAN, action: ACTION, actionOrdinal: 0 });
    await authority.resolveAction({
      clientId: CID, executionId: e.execution.executionId, actionKey: ENGINE,
      status: "unknown", ambiguityReason: "timeout_after_request_sent",
    });
    const again = await authority.claimAction({ clientId: CID, executionId: "exec_other", plan: PLAN, action: ACTION, actionOrdinal: 0 });
    assert.equal(again.ok, false, "an UNKNOWN action must stay claimed against");
    assert.equal(again.code, CLAIM_CODES.ALREADY_CLAIMED);
  });

  it("keeps blocking after a persist failure, because the resource EXISTS", async () => {
    const { authority } = claims();
    const e = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
    await authority.claimAction({ clientId: CID, executionId: e.execution.executionId, plan: PLAN, action: ACTION, actionOrdinal: 0 });
    await authority.resolveAction({
      clientId: CID, executionId: e.execution.executionId, actionKey: ENGINE,
      status: "persist_failed_after_provider_success", providerResourceId: "prov_9",
    });
    const again = await authority.claimAction({ clientId: CID, executionId: "exec_other", plan: PLAN, action: ACTION, actionOrdinal: 0 });
    assert.equal(again.ok, false);
  });

  it("releases the block once an action COMPLETES or definitely fails", async () => {
    for (const terminal of ["completed", "provider_failed_definite"]) {
      const { authority } = claims();
      const e = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
      await authority.claimAction({ clientId: CID, executionId: e.execution.executionId, plan: PLAN, action: ACTION, actionOrdinal: 0 });
      await authority.resolveAction({
        clientId: CID, executionId: e.execution.executionId, actionKey: ENGINE,
        status: terminal, providerResourceId: terminal === "completed" ? "prov_1" : null,
      });
      const again = await authority.claimAction({ clientId: CID, executionId: "exec_other", plan: PLAN, action: ACTION, actionOrdinal: 0 });
      assert.equal(again.ok, true, `${terminal} must release the block`);
    }
  });

  it("keeps one client's claims away from another's", async () => {
    const { authority } = claims();
    await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
    const other = await authority.claimExecution({
      clientId: "riverside_plumbing", plan: { ...PLAN, clientId: "riverside_plumbing" }, actor: "A", environmentTag: "t",
    });
    assert.equal(other.ok, true, "another client is not blocked");
  });

  it("refuses a plan belonging to a different client", async () => {
    const { authority } = claims();
    const r = await authority.claimExecution({ clientId: "riverside_plumbing", plan: PLAN, actor: "A", environmentTag: "t" });
    assert.equal(r.ok, false);
    assert.equal(r.code, CLAIM_CODES.CROSS_TENANT);
  });

  it("reports exactly what is unresolved, loudest first", async () => {
    const { authority } = claims();
    const e = await authority.claimExecution({ clientId: CID, plan: PLAN, actor: "A", environmentTag: "t" });
    await authority.claimAction({ clientId: CID, executionId: e.execution.executionId, plan: PLAN, action: ACTION, actionOrdinal: 0 });
    await authority.resolveAction({
      clientId: CID, executionId: e.execution.executionId, actionKey: ENGINE,
      status: "persist_failed_after_provider_success", providerResourceId: "prov_9",
    });
    const unresolved = await authority.findUnresolved(CID);
    assert.equal(unresolved.blocking, true);
    assert.equal(unresolved.unrecorded.length, 1);
    assert.equal(unresolved.unrecorded[0].providerResourceId, "prov_9");
  });
});

// ════════════════════════════════════════════════════════════════════
// P25A — THE PROVIDER PORT
// ════════════════════════════════════════════════════════════════════

describe("P25A provider port — three outcomes, and no fourth", () => {
  const REQUEST = {
    clientId: CID, purpose: "receptionist_agent", resourceType: "response_engine",
    payload: { general_prompt: "x" }, providerRequestId: "r".repeat(64),
  };

  it("refuses an adapter that does not implement the whole port", () => {
    assert.equal(describeAdapterConformance({}).ok, false);
    assert.equal(describeAdapterConformance(null).ok, false);
    assert.throws(() => createProviderMutationPort({ adapter: { createResource: async () => {} } }), /missing/);
    assert.equal(describeAdapterConformance(createFakeProviderAdapter({})).ok, true);
  });

  it("rejects a malformed request BEFORE sending, as a DEFINITE failure", async () => {
    const adapter = createFakeProviderAdapter({});
    const port = createProviderMutationPort({ adapter });
    const result = await port.createResource({ clientId: CID });
    assert.equal(result.outcome, "definite_failure", "nothing was sent, so nothing can exist");
    assert.equal(adapter.calls.length, 0);
    assert.match(result.detail, /rejected before sending/);
  });

  it("turns a THROWN transport error into UNKNOWN, never failure", async () => {
    const adapter = createFakeProviderAdapter({ behaviours: { "*": { throws: true, detail: "socket hang up" } } });
    const port = createProviderMutationPort({ adapter });
    const result = await port.createResource(REQUEST);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.ambiguityReason, "transport_ambiguity");
  });

  it("turns a success with NO resource id into UNKNOWN", async () => {
    const adapter = createFakeProviderAdapter({ behaviours: { "*": { outcome: "malformed" } } });
    const port = createProviderMutationPort({ adapter });
    const result = await port.createResource(REQUEST);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.ambiguityReason, "malformed_response_after_accepted_request");
  });

  it("turns an unrecognised response into UNKNOWN", async () => {
    const port = createProviderMutationPort({
      adapter: { createResource: async () => ({ status: "ok" }), updateResource: async () => ({}), retireResource: async () => ({}) },
    });
    const result = await port.createResource(REQUEST);
    assert.equal(result.outcome, "unknown");
  });

  it("has no concept of a retryable failure", () => {
    assert.deepEqual([...require("../src/platform/execution-model").PROVIDER_OUTCOMES],
      ["definite_success", "definite_failure", "unknown"]);
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provider-mutation-port.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/retryable/i.test(code), "the port must not carry a retryable concept");
  });

  it("validates every operation's required fields as data", () => {
    assert.equal(validateMutationRequest("createResource", REQUEST).ok, true);
    assert.equal(validateMutationRequest("retireResource", REQUEST).ok, false);
    assert.equal(validateMutationRequest("notAnOperation", REQUEST).ok, false);
  });

  it("marks every adapter it can build as a FAKE", () => {
    const port = createProviderMutationPort({ adapter: createFakeProviderAdapter({}), name: "fake" });
    assert.equal(port.isFake, true);
  });
});

// ════════════════════════════════════════════════════════════════════
// P28B — THE FAILURE MATRIX
// ════════════════════════════════════════════════════════════════════

describe("P28B failure matrix — every state truthful and recoverable", () => {
  it("1. definite failure before the provider accepted: stops, nothing created", async () => {
    const { platform, plan, principals, adapter } = await ready({
      behaviours: { [ENGINE]: { outcome: "definite_failure", detail: "invalid prompt" } },
    });
    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].status, "provider_failed_definite");
    assert.equal(result.results.length, 1, "the dependent action must NOT be attempted");
    assert.equal((await platform.registry.listForClient(CID)).length, 0);
  });

  it("2. UNKNOWN: stops, blocks, and never re-sends", async () => {
    const { platform, plan, principals, adapter } = await ready({
      behaviours: { [ENGINE]: { outcome: "unknown", ambiguityReason: "timeout_after_request_sent" } },
    });
    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.status, "unknown");
    assert.equal(result.results[0].status, "unknown");
    assert.equal(result.results[0].ambiguityReason, "timeout_after_request_sent");
    assert.equal(adapter.calls.length, 1, "EXACTLY ONE send — no retry");
    assert.equal(result.results.length, 1, "and nothing after it");
    const unresolved = await platform.executor.claims.findUnresolved(CID);
    assert.equal(unresolved.blocking, true);
    assert.equal(unresolved.ambiguous.length, 1);
  });

  it("3. provider success + registry failure: PERSIST_FAILED, id surfaced, no re-send", async () => {
    const { platform, plan, principals, adapter } = await ready();
    platform.registry._failNextWrite("disk on fire");
    const result = await run(platform, principals, plan, adapter);

    assert.equal(result.status, "manual_reconciliation_required");
    const failed = result.results[0];
    assert.equal(failed.status, "persist_failed_after_provider_success");
    assert.ok(failed.providerResourceId, "the id must be carried");
    assert.match(failed.warning, /EXISTS AND WAS NOT RECORDED/);
    assert.match(failed.warning, /DO NOT re-run/);
    assert.equal(adapter.calls.length, 1, "one send, and no attempt to undo it");
    assert.equal(result.summary.unrecordedProviderResources.length, 1);
  });

  it("4. dependency succeeds then the dependent fails: partial state, NO compensation", async () => {
    const { platform, plan, principals, adapter } = await ready({
      behaviours: { [AGENT]: { outcome: "definite_failure", detail: "voice id rejected" } },
    });
    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.status, "failed");

    const rows = await platform.registry.listForClient(CID);
    assert.equal(rows.length, 1, "the engine WAS created and recorded");
    assert.equal(rows[0].resource_type, "response_engine");

    // The engine is NOT deleted. Provider APIs have no cross-resource
    // transaction, so a compensating delete is just another unreviewed mutation.
    const retires = adapter.calls.filter((c) => c.operation === "retireResource");
    assert.equal(retires.length, 0, "nothing may be automatically compensated");
    assert.equal(result.results.map((r) => r.status).join(","), "completed,provider_failed_definite");
  });

  it("5. a stale plan immediately before execute sends nothing", async () => {
    const { platform, plan, principals, adapter } = await ready();
    const changed = garageDoorD();
    changed.identity.tradingName = "Renamed Doors";
    await H.activateConfig(platform, CID, changed);
    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.ok, false);
    assert.equal(adapter.calls.length, 0);
  });

  it("6. the configuration changing during preparation is caught by the desired-hash gate", async () => {
    const { platform, plan, principals, adapter } = await ready();
    const changed = garageDoorD();
    changed.services.push({ serviceId: "spring_service", name: "Spring service", aliases: [], enabled: true, urgencyCategory: "standard" });
    await H.activateConfig(platform, CID, changed);
    const result = await run(platform, principals, plan, adapter);
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.number === 10 || b.number === 8 || b.number === 9));
    assert.equal(adapter.calls.length, 0);
  });

  it("7. a duplicate executor race: the second is refused by the durable claim", async () => {
    const { platform, plan, principals, adapter } = await ready();
    const other = createFakeProviderAdapter({ name: "second" });
    const [a, b] = await Promise.all([
      run(platform, principals, plan, adapter),
      platform.executor.execute({ principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: other }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one execution may succeed");
    const loser = [a, b].find((r) => !r.ok);
    assert.ok(loser.blockers.some((x) => x.number === 16 || x.number === 13), "the loser is refused by the claim or the unresolved gate");
    assert.equal(adapter.calls.length + other.calls.length, 2, "two sends total: one per action of the ONE winner");
  });

  it("8. a wrong provider tag sends nothing", async () => {
    const platform = H.buildPlatform({ environmentTag: "production-ish" });
    const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD(), { providerTag: "fake-env" });
    const adapter = createFakeProviderAdapter({});
    const result = await platform.executor.execute({ principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: adapter });
    assert.equal(result.ok, false);
    assert.equal(adapter.calls.length, 0);
  });

  it("9. a wrong tenant sends nothing", async () => {
    const { platform, plan, adapter } = await ready();
    const stranger = executionPrincipal({ clientId: "riverside_plumbing", actorId: "P" });
    const result = await platform.executor.execute({ principal: stranger, clientId: CID, planId: plan.planId, providerAdapter: adapter });
    assert.equal(result.ok, false);
    assert.equal(adapter.calls.length, 0);
  });

  it("10. a resource that already exists collides on the one-active index", async () => {
    const platform = H.buildPlatform();
    const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD());
    // Somebody already recorded an active engine for this purpose.
    await platform.registry.insert({
      client_id: CID, provider: "retell", purpose: "receptionist_agent", resource_type: "response_engine",
      provider_resource_id: "prov_pre_existing", payload_hash: "e".repeat(64), active: true,
    });
    const adapter = createFakeProviderAdapter({});
    const result = await platform.executor.execute({ principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: adapter });
    assert.equal(result.status, "manual_reconciliation_required");
    assert.equal(result.results[0].status, "manual_reconciliation_required");
  });

  it("13. an unavailable provider observation is UNKNOWN, not absent", () => {
    const { reconcileClient } = require("../src/platform/reconciliation-engine");
    const registry = [{ client_id: CID, purpose: "receptionist_agent", resource_type: "voice_agent", provider_resource_id: "prov_1", payload_hash: "a".repeat(64), active: true }];
    const notAsked = reconcileClient({ clientId: CID, registry, observations: {} });
    const asked = reconcileClient({ clientId: CID, registry, observations: { [AGENT]: null } });
    assert.equal(notAsked.results[0].result, "unknown");
    assert.equal(asked.results[0].result, "missing_provider_resource");
    assert.notEqual(notAsked.results[0].result, asked.results[0].result);
  });
});

// ════════════════════════════════════════════════════════════════════
// P27B — THE NO-SECOND-AGENT PROOF
// ════════════════════════════════════════════════════════════════════

describe("P27B — the no-second-agent proof", () => {
  it("an operator who re-runs after an UNKNOWN is REFUSED, then recovers only through reconciliation", async () => {
    // ── 1. A create was sent. The transport was ambiguous. ──
    const { platform, plan, principals, adapter } = await ready({
      behaviours: { [ENGINE]: { outcome: "unknown", ambiguityReason: "connection_reset_after_write" } },
    });
    const first = await run(platform, principals, plan, adapter);
    assert.equal(first.status, "unknown");
    assert.equal(adapter.calls.length, 1);

    // ── 2. The registry contains NOTHING. ──
    assert.equal((await platform.registry.listForClient(CID)).length, 0,
      "no row exists, which is exactly what tempts somebody to re-run");

    // ── 3. The operator accidentally runs it again. ──
    const second = createFakeProviderAdapter({ name: "second-attempt" });
    const retry = await platform.executor.execute({
      principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: second,
    });

    // ── REFUSED. And nothing was sent. ──
    assert.equal(retry.ok, false, "a second attempt after UNKNOWN must be refused");
    assert.equal(second.calls.length, 0, "NOT ONE BYTE may be sent");
    const blocked = retry.blockers.find((b) => [13, 14].includes(b.number));
    assert.ok(blocked, `expected the unresolved/unknown gate, got ${retry.blockers.map((b) => b.number)}`);
    assert.match(blocked.detail || "", /unknown|unresolved/i);

    // ── 4. A person observes the provider. The resource DOES exist. ──
    const { reconcileClient, buildRepairPlan } = require("../src/platform/reconciliation-engine");
    const actions = await platform.executor.claims.listActions(CID);
    const active = await platform.configService.getActive({ principal: principals.operator, clientId: CID });
    const desired = platform.desiredStateCompiler(active.version);
    const engineWanted = desired.resources.find((r) => `${r.purpose}:${r.resourceType}` === ENGINE);

    const reconciliation = reconcileClient({
      clientId: CID,
      registry: await platform.registry.listForClient(CID),
      actions,
      desired,
      observations: { [ENGINE]: { providerResourceId: "prov_it_did_exist", payloadHash: engineWanted.payloadHash } },
    });

    const finding = reconciliation.results.find((r) => r.key === ENGINE);
    assert.equal(finding.result, "unrecorded_provider_resource");
    assert.equal(finding.subreason, "ambiguous_execution_confirmed_present");

    // ── 5. The repair plan RECOMMENDS adoption. It does not adopt. ──
    const repair = buildRepairPlan(reconciliation, { desired });
    const recommendation = repair.recommendations.find((r) => r.key === ENGINE);
    assert.equal(recommendation.action, "adopt_existing_resource");
    assert.equal(recommendation.automatic, false);
    assert.equal(recommendation.requiresHuman, true);
    assert.equal(repair.executed, false);
    assert.deepEqual(recommendation.adoptionProof, {
      hasObservedId: true, matchesClaimedId: true, hasDesiredResource: true, payloadHashMatches: true,
    });

    // ── 6. Until durable truth is restored, execution STILL refuses. ──
    const third = createFakeProviderAdapter({ name: "third-attempt" });
    const stillRefused = await platform.executor.execute({
      principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: third,
    });
    assert.equal(stillRefused.ok, false, "reading a recommendation is not acting on one");
    assert.equal(third.calls.length, 0);
  });

  it("refuses adoption when the payload does not match — no 'looks like ours'", async () => {
    const { reconcileClient, buildRepairPlan } = require("../src/platform/reconciliation-engine");
    const { platform, plan, principals, adapter } = await ready({
      behaviours: { [ENGINE]: { outcome: "unknown", ambiguityReason: "timeout_after_request_sent" } },
    });
    await run(platform, principals, plan, adapter);

    const active = await platform.configService.getActive({ principal: principals.operator, clientId: CID });
    const desired = platform.desiredStateCompiler(active.version);
    const reconciliation = reconcileClient({
      clientId: CID, registry: [], actions: await platform.executor.claims.listActions(CID), desired,
      // A resource exists — with a DIFFERENT payload. It is not ours.
      observations: { [ENGINE]: { providerResourceId: "prov_somebody_elses", payloadHash: "9".repeat(64) } },
    });
    const repair = buildRepairPlan(reconciliation, { desired });
    const recommendation = repair.recommendations.find((r) => r.key === ENGINE);
    assert.equal(recommendation.action, "manual_review", "a mismatched payload must never be adopted");
    assert.equal(recommendation.adoptionProof.payloadHashMatches, false);
    assert.equal(repair.adoptable, 0);
  });

  it("recommends a create ONLY after absence is confirmed by an observation", async () => {
    const { reconcileClient, buildRepairPlan } = require("../src/platform/reconciliation-engine");
    const { platform, plan, principals, adapter } = await ready({
      behaviours: { [ENGINE]: { outcome: "unknown", ambiguityReason: "timeout_after_request_sent" } },
    });
    await run(platform, principals, plan, adapter);
    const actions = await platform.executor.claims.listActions(CID);

    // Not observed: no create may be recommended.
    const unobserved = buildRepairPlan(reconcileClient({ clientId: CID, registry: [], actions, observations: {} }));
    assert.ok(!unobserved.recommendations.some((r) => r.action === "create_new_after_confirmed_missing"));

    // Observed as absent: now a create may be RECOMMENDED, through planning.
    const observed = buildRepairPlan(reconcileClient({ clientId: CID, registry: [], actions, observations: { [ENGINE]: null } }));
    const create = observed.recommendations.find((r) => r.action === "create_new_after_confirmed_missing");
    assert.ok(create, "confirmed absence permits recommending a new plan");
    assert.equal(create.automatic, false);
    assert.match(create.note, /does not create anything/);
  });
});

// ════════════════════════════════════════════════════════════════════
// P28A — THE FAKE END-TO-END, AND THE NO-OP REPEAT
// ════════════════════════════════════════════════════════════════════

describe("P28A — Garage Door D, provisioned against a fake provider", () => {
  it("runs the whole flow and leaves exactly two active resources", async () => {
    const { platform, plan, principals, adapter } = await ready();
    const result = await run(platform, principals, plan, adapter);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "completed");
    assert.equal(result.usedFakeProvider, true);
    assert.match(result.note, /FAKE provider/);

    // Dependency order: engine first, agent second.
    assert.deepEqual(result.results.map((r) => r.actionKey), [ENGINE, AGENT]);
    assert.deepEqual(adapter.calls.map((c) => `${c.request.purpose}:${c.request.resourceType}`), [ENGINE, AGENT]);

    const rows = await platform.registry.listForClient(CID);
    const active = rows.filter((r) => r.active !== false);
    assert.equal(active.length, 2);
    assert.deepEqual(active.map((r) => r.resource_type).sort(), ["response_engine", "voice_agent"]);
    for (const row of active) {
      assert.equal(row.purpose, "receptionist_agent");
      assert.equal(row.last_outcome, "definite_success");
      assert.ok(row.provider_resource_id);
      assert.equal(row.provider_metadata.producedBy, "aida-client-platform");
      assert.equal(row.provider_metadata.clientId, CID);
      assert.ok(row.provider_metadata.behaviourHash);
    }
  });

  it("re-running the SAME configuration is a NO-OP with no provider mutation", async () => {
    const { platform, plan, principals, adapter } = await ready();
    await run(platform, principals, plan, adapter);
    const sendsAfterFirstRun = adapter.calls.length;

    // Re-plan against the now-populated registry.
    const secondPlan = await H.approvePlan(platform, CID);
    assert.equal(secondPlan.isNoOp, true, "an unchanged configuration must plan to a no-op");
    assert.equal(secondPlan.mutatingCount, 0);
    assert.ok(secondPlan.actions.every((a) => a.action === "no_change"));

    const second = createFakeProviderAdapter({ name: "second-run" });
    const result = await platform.executor.execute({
      principal: principals.executor, clientId: CID, planId: secondPlan.planId, providerAdapter: second,
    });
    assert.equal(result.ok, true);
    assert.equal(second.calls.length, 0, "a no-op plan must send NOTHING");
    assert.equal(adapter.calls.length, sendsAfterFirstRun, "and must not touch the first adapter either");
    assert.ok(result.results.every((r) => r.providerContacted === false));

    const active = (await platform.registry.listForClient(CID)).filter((r) => r.active !== false);
    assert.equal(active.length, 2, "still exactly two");
  });

  it("records the provenance chain on every resource it writes", async () => {
    const { platform, plan, principals, adapter } = await ready();
    await run(platform, principals, plan, adapter);
    const active = await platform.configService.getActive({ principal: principals.operator, clientId: CID });
    const desired = platform.desiredStateCompiler(active.version);

    for (const row of await platform.registry.listForClient(CID)) {
      const want = desired.resources.find((r) => r.resourceType === row.resource_type);
      assert.equal(row.provider_metadata.configVersion, active.version.metadata.configVersion);
      assert.equal(row.provider_metadata.behaviourHash, desired.behaviourHash);
      assert.equal(row.payload_hash, want.payloadHash);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P26A / P26B — UPDATE, REPLACE, RETIRE
// ════════════════════════════════════════════════════════════════════

describe("P26A/B — update keeps the id, replace does not, retire never lies", () => {
  function writer() {
    const now = H.fixedClock();
    const registry = createInMemoryResourceRegistry();
    return { registry, writer: createResourceRegistryWriter({ registry, now }) };
  }
  const BASE = {
    clientId: CID, provider: "retell", providerTag: "fake-env",
    purpose: "receptionist_agent", resourceType: "response_engine",
    provenance: { clientId: CID, configVersion: 1, behaviourHash: "b".repeat(64) },
  };

  it("an UPDATE keeps the same provider id authoritative", async () => {
    const adapter = createFakeProviderAdapter({});
    const port = createProviderMutationPort({ adapter });
    const result = await port.updateResource({
      clientId: CID, purpose: "receptionist_agent", resourceType: "response_engine",
      payload: { x: 1 }, providerRequestId: "r".repeat(64), providerResourceId: "prov_existing",
    });
    assert.equal(result.outcome, "definite_success");
    assert.equal(result.providerResourceId, "prov_existing", "an update must not change the id");
  });

  it("an UPDATE supersedes the old row and records the new payload hash", async () => {
    const { registry, writer: w } = writer();
    await w.recordProvisioned({ ...BASE, providerResourceId: "prov_1", payloadHash: "a".repeat(64), actionKind: "create" });
    await w.recordProvisioned({ ...BASE, providerResourceId: "prov_1", payloadHash: "c".repeat(64), actionKind: "update" });
    const rows = registry._rows();
    assert.equal(rows.length, 2, "history survives");
    const active = rows.filter((r) => r.active !== false);
    assert.equal(active.length, 1, "one active");
    assert.equal(active[0].payload_hash, "c".repeat(64));
    assert.equal(active[0].provider_resource_id, "prov_1");
  });

  it("a REPLACE records the NEW resource before the old one is retired — no delete-then-create", async () => {
    const { registry, writer: w } = writer();
    await w.recordProvisioned({ ...BASE, providerResourceId: "prov_old", payloadHash: "a".repeat(64), actionKind: "create" });
    const replaced = await w.recordProvisioned({ ...BASE, providerResourceId: "prov_new", payloadHash: "c".repeat(64), actionKind: "replace" });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    const active = registry._rows().filter((r) => r.active !== false);
    assert.equal(active.length, 1);
    assert.equal(active[0].provider_resource_id, "prov_new", "the replacement is recorded and active");
    // The OLD provider resource is not deleted here. Retiring it is a separate,
    // separately-represented action.
    assert.ok(registry._rows().some((r) => r.provider_resource_id === "prov_old" && r.active === false));
  });

  it("RETIRE states its mode, and registry_inactive says the provider was not asked", async () => {
    const { writer: w } = writer();
    await w.recordProvisioned({ ...BASE, providerResourceId: "prov_1", payloadHash: "a".repeat(64), actionKind: "create" });
    const inactive = await w.recordRetired({ ...BASE, providerResourceId: "prov_1", retirementMode: "registry_inactive" });
    assert.equal(inactive.ok, true);
    assert.equal(inactive.providerStillServing, true, "registry_inactive means it may STILL be serving");
    assert.match(inactive.meaning, /THE PROVIDER WAS NOT ASKED/);

    const deleted = await w.recordRetired({ ...BASE, providerResourceId: "prov_1", retirementMode: "provider_deleted" });
    assert.equal(deleted.providerStillServing, false);
    assert.match(deleted.meaning, /GONE/);
  });

  it("refuses a retirement mode nobody defined", async () => {
    const { writer: w } = writer();
    const r = await w.recordRetired({ ...BASE, providerResourceId: "prov_1", retirementMode: "deleted_probably" });
    assert.equal(r.ok, false);
    assert.equal(r.code, REGISTRY_CODES.INVALID);
  });

  it("a registry write failure after provider success is PERSIST_FAILED, and says do not retry", async () => {
    const { registry, writer: w } = writer();
    registry._failNextWrite("connection lost");
    const r = await w.recordProvisioned({ ...BASE, providerResourceId: "prov_orphan", payloadHash: "a".repeat(64), actionKind: "create" });
    assert.equal(r.ok, false);
    assert.equal(r.code, REGISTRY_CODES.PERSIST_FAILED);
    assert.equal(r.providerResourceId, "prov_orphan");
    assert.equal(r.doNotRetryProvider, true);
    assert.match(r.message, /EXISTS AND WAS NOT RECORDED/);
  });

  it("refuses a write whose provenance names a different client", async () => {
    const { writer: w } = writer();
    const r = await w.recordProvisioned({
      ...BASE, providerResourceId: "prov_1", payloadHash: "a".repeat(64), actionKind: "create",
      provenance: { clientId: "somebody_else", configVersion: 1 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, REGISTRY_CODES.CROSS_TENANT);
  });

  it("respects pr_one_active_per_purpose", async () => {
    const { writer: w } = writer();
    await w.recordProvisioned({ ...BASE, providerResourceId: "prov_1", payloadHash: "a".repeat(64), actionKind: "create" });
    const clash = await w.recordProvisioned({ ...BASE, providerResourceId: "prov_2", payloadHash: "c".repeat(64), actionKind: "create" });
    assert.equal(clash.ok, false);
    assert.equal(clash.code, REGISTRY_CODES.CONFLICT);
    assert.equal(clash.constraint, "pr_one_active_per_purpose");
  });
});
