// AIDA PLATFORM P19–P22 — the provisioning domain.
//
// The rule the whole subsystem exists to enforce:
//
//   ACTIVE CONFIGURATION IS NOT DEPLOYMENT.
//   AND: A DATABASE ROW IS NOT PROOF A REMOTE RESOURCE EXISTS.
//   AND: UNKNOWN IS NEVER CREATE.
//
// Everything here is pure. No network, no provider, no database.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const M = require("../src/platform/provisioning-model");
const { compileDesiredState } = require("../src/platform/provisioning-desired-state");
const { diffProvisioning, reconcile, trustworthiness } = require("../src/platform/provisioning-diff");
const {
  createPlanAuthority, createInMemoryPlanStore, planHashOf, describeStaleness, PLAN_CODES,
} = require("../src/platform/provisioning-plan-authority");
const { assessClientReadiness } = require("../src/platform/provisioning-readiness");
const { describeExecutionContract, EXECUTION_PRECONDITIONS } = require("../src/platform/provisioning-execution-contract");
const { plumberC, garageDoorD, locksmithA } = require("../src/platform/fixtures/clients");

const ROOT = path.join(__dirname, "..");
const REFS = Object.freeze({ llmId: "llm_x", voiceId: "custom_voice_x", webhookUrl: "https://example.invalid/h" });

function clock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 60000) => { t += ms; return new Date(t); };
  return now;
}

/** A blueprint dressed as an active version. */
function activeVersion(make = plumberC, configVersion = 1) {
  const bp = make();
  bp.metadata = { ...bp.metadata, configVersion, status: "active", contentHash: "c".repeat(64) };
  return bp;
}

const desiredFor = (make = plumberC, v = 1, refs = REFS) =>
  compileDesiredState({ version: activeVersion(make, v), providerRefs: refs });

/** A durable provider_resources row that AIDA definitely created. */
const recordedRow = (purpose, resourceType, payloadHash, extra = {}) => ({
  client_id: "riverside_plumbing",
  provider: "retell",
  purpose,
  resourceType,
  provider_resource_id: `prov_${purpose}_${resourceType}`,
  payload_hash: payloadHash,
  active: true,
  lastOutcome: "definite_success",
  providerMetadata: { producedBy: "aida-client-platform", configVersion: 1, behaviourHash: "b".repeat(64) },
  ...extra,
});

// ════════════════════════════════════════════════════════════════════
// P19 — THE MODEL
// ════════════════════════════════════════════════════════════════════

describe("P19 model — the vocabulary is closed and reuses what exists", () => {
  it("reuses the EXISTING receptionist purposes rather than inventing a parallel set", () => {
    const port = fs.readFileSync(path.join(ROOT, "src", "services", "voice-platform-port.js"), "utf8");
    for (const purpose of M.CLIENT_RESOURCE_PURPOSES) {
      assert.ok(port.includes(`"${purpose}"`), `"${purpose}" must already exist in voice-platform-port.js`);
    }
    for (const type of M.RESOURCE_TYPES) {
      assert.ok(port.includes(`"${type}"`), `"${type}" must already exist in voice-platform-port.js`);
    }
  });

  it("refuses acquisition and onboarding purposes for a client plan", () => {
    for (const forbidden of M.FORBIDDEN_CLIENT_PURPOSES) {
      const result = M.describeResourceShape(forbidden, "voice_agent");
      assert.equal(result.ok, false, `"${forbidden}" must not be a client purpose`);
      assert.match(result.reason, /another authority|not a known/);
    }
    assert.ok(M.FORBIDDEN_CLIENT_PURPOSES.includes("acquisition_agent"));
  });

  it("declares WHY each unproduced shape is absent, rather than just omitting it", () => {
    const unproduced = M.CLIENT_RESOURCE_SHAPES.filter((s) => !s.produced);
    assert.ok(unproduced.length >= 3);
    for (const shape of unproduced) {
      assert.ok(shape.why && shape.why.length > 40, `${shape.purpose}/${shape.resourceType} needs a stated reason`);
    }
    const phone = M.CLIENT_RESOURCE_SHAPES.find((s) => s.resourceType === "phone_number_binding");
    assert.equal(phone.produced, false, "a plan must never quietly acquire a telephone number");
    assert.match(phone.why, /DELIBERATELY DEFERRED/);
  });

  it("produces exactly the two-resource split the provider actually needs", () => {
    assert.equal(M.PRODUCED_SHAPES.length, 2);
    const keys = M.PRODUCED_SHAPES.map((s) => `${s.purpose}:${s.resourceType}`).sort();
    assert.deepEqual(keys, ["receptionist_agent:response_engine", "receptionist_agent:voice_agent"]);
    const agent = M.PRODUCED_SHAPES.find((s) => s.resourceType === "voice_agent");
    assert.deepEqual(agent.dependsOn, [{ purpose: "receptionist_agent", resourceType: "response_engine" }]);
  });

  it("states mutability per resource type, because it is a provider fact", () => {
    for (const type of M.RESOURCE_TYPES) {
      assert.ok(["updatable", "replace_only"].includes(M.RESOURCE_MUTABILITY[type]), `${type} needs a mutability`);
    }
  });

  it("declares execution statuses that nothing in this batch can reach", () => {
    for (const s of ["executing", "completed", "failed", "unknown"]) {
      assert.ok(M.PLAN_STATUSES.includes(s));
      assert.ok(M.PLAN_EXECUTION_STATUSES.includes(s));
    }
  });

  it("refuses a desired resource carrying a credential", () => {
    const bad = {
      clientId: "x_client", configVersion: 1, behaviourHash: "a".repeat(64),
      payloadHash: "b".repeat(64), dependencyHash: "c".repeat(64), provider: "retell",
      purpose: "receptionist_agent", resourceType: "voice_agent", dependsOn: [],
      payload: { api_key: "sk_live_something" },
    };
    const result = M.validateDesiredResource(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /credential/.test(e.message)));
  });
});

// ════════════════════════════════════════════════════════════════════
// P20 — THE DESIRED-STATE COMPILER
// ════════════════════════════════════════════════════════════════════

describe("P20 desired state — deterministic, traceable, and pure", () => {
  it("compiles the two resources in dependency order", () => {
    const desired = desiredFor();
    assert.equal(desired.ok, true, JSON.stringify(desired));
    assert.equal(desired.resources.length, 2);
    assert.equal(desired.resources[0].resourceType, "response_engine");
    assert.equal(desired.resources[1].resourceType, "voice_agent");
    assert.deepEqual(desired.resources[1].dependsOn, [{ purpose: "receptionist_agent", resourceType: "response_engine" }]);
  });

  it("is deterministic — same active config, same hashes, every time", () => {
    const a = desiredFor();
    const b = desiredFor();
    assert.equal(a.desiredHash, b.desiredHash);
    for (let i = 0; i < a.resources.length; i += 1) {
      assert.equal(a.resources[i].payloadHash, b.resources[i].payloadHash);
      assert.equal(a.resources[i].dependencyHash, b.resources[i].dependencyHash);
    }
  });

  it("gives different clients different desired hashes", () => {
    const hashes = [plumberC, garageDoorD, locksmithA].map((m) => desiredFor(m).desiredHash);
    assert.equal(new Set(hashes).size, 3);
  });

  it("carries the whole provenance chain on every resource (P20A)", () => {
    const desired = desiredFor(plumberC, 7);
    for (const r of desired.resources) {
      assert.equal(r.provenance.producedBy, "aida-client-platform");
      assert.equal(r.provenance.clientId, "riverside_plumbing");
      assert.equal(r.provenance.configVersion, 7);
      assert.equal(r.provenance.behaviourHash, desired.behaviourHash);
      assert.equal(r.provenance.payloadHash, r.payloadHash);
      assert.ok(r.provenance.compilerVersion);
      assert.ok(r.provenance.specVersion);
    }
  });

  it("answers 'which configuration produced this resource' from the resource alone", () => {
    const r = desiredFor(plumberC, 4).resources[1];
    assert.deepEqual(
      { client: r.provenance.clientId, config: r.provenance.configVersion, behaviour: r.provenance.behaviourHash.slice(0, 8) },
      { client: "riverside_plumbing", config: 4, behaviour: r.behaviourHash.slice(0, 8) },
    );
  });

  it("moves the payload hash when the configuration changes, and not otherwise", () => {
    const base = desiredFor();
    const sameAgain = desiredFor();
    assert.equal(base.desiredHash, sameAgain.desiredHash);

    const changed = plumberC();
    changed.hours.weekly.saturday = { open: "08:00", close: "16:00" };
    changed.metadata = { ...changed.metadata, configVersion: 2, contentHash: "d".repeat(64) };
    const after = compileDesiredState({ version: changed, providerRefs: REFS });
    assert.notEqual(after.desiredHash, base.desiredHash);
  });

  it("reports unresolved provider references rather than inventing them", () => {
    const desired = desiredFor(plumberC, 1, {});
    assert.equal(desired.ok, true, "a desired set can still be COMPUTED");
    assert.equal(desired.ready, false);
    assert.deepEqual([...desired.unresolved].sort(), ["llmId", "voiceId", "webhookUrl"]);
  });

  it("records what was deliberately NOT provisioned", () => {
    const absent = desiredFor().deliberatelyAbsent;
    assert.ok(absent.some((a) => a.resourceType === "phone_number_binding"));
    for (const a of absent) assert.ok(a.why.length > 40);
  });

  it("refuses a version with no client or no config version", () => {
    assert.equal(compileDesiredState({ version: null }).ok, false);
    const noClient = plumberC();
    noClient.identity.clientId = null;
    noClient.metadata = { ...noClient.metadata, configVersion: 1 };
    assert.equal(compileDesiredState({ version: noClient, providerRefs: REFS }).code, "no_client");
    const noVersion = plumberC();
    assert.equal(compileDesiredState({ version: noVersion, providerRefs: REFS }).code, "no_config_version");
  });

  it("contains no credential, in any payload, for any fixture", () => {
    for (const make of [plumberC, garageDoorD, locksmithA]) {
      const json = JSON.stringify(desiredFor(make));
      for (const secret of ["api_key", "apiKey", "authorization", "bearer ", "sk_live"]) {
        assert.ok(!json.toLowerCase().includes(secret.toLowerCase()), `${secret} leaked`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P21 — THE DIFF
// ════════════════════════════════════════════════════════════════════

describe("P21 diff — classifications", () => {
  it("CREATE when nothing is recorded", () => {
    const diff = diffProvisioning({ desired: desiredFor(), current: [] });
    assert.equal(diff.ok, true);
    assert.equal(diff.actions.length, 2);
    assert.ok(diff.actions.every((a) => a.action === "create"));
    assert.equal(diff.isNoOp, false);
    assert.equal(diff.mutatingCount, 2);
  });

  it("NO_CHANGE when the recorded payload hashes match — the no-op proof (P23C)", () => {
    const desired = desiredFor();
    const current = desired.resources.map((r) => recordedRow(r.purpose, r.resourceType, r.payloadHash));
    const diff = diffProvisioning({ desired, current });

    assert.deepEqual(diff.actions.map((a) => a.action), ["no_change", "no_change"]);
    assert.equal(diff.isNoOp, true, "re-planning an unchanged configuration must be a no-op");
    assert.equal(diff.mutatingCount, 0);
    for (const a of diff.actions) {
      assert.notEqual(a.action, "create");
      assert.notEqual(a.action, "update");
      assert.notEqual(a.action, "replace");
    }
  });

  it("stays a no-op across repeated planning of the same configuration", () => {
    const desired = desiredFor();
    const current = desired.resources.map((r) => recordedRow(r.purpose, r.resourceType, r.payloadHash));
    for (let i = 0; i < 5; i += 1) {
      const again = diffProvisioning({ desired: desiredFor(), current });
      assert.equal(again.isNoOp, true, `run ${i + 1} must still be a no-op`);
    }
  });

  it("UPDATE when an updatable resource's payload changed", () => {
    const desired = desiredFor();
    const current = desired.resources.map((r) => recordedRow(r.purpose, r.resourceType, "9".repeat(64)));
    const diff = diffProvisioning({ desired, current });
    assert.ok(diff.actions.every((a) => a.action === "update"), JSON.stringify(diff.actions.map((a) => a.action)));
    assert.equal(M.RESOURCE_MUTABILITY.response_engine, "updatable");
  });

  it("RETIRE an active recorded resource the desired set no longer wants", () => {
    const desired = desiredFor();
    const current = [
      ...desired.resources.map((r) => recordedRow(r.purpose, r.resourceType, r.payloadHash)),
      recordedRow("receptionist_knowledge", "knowledge_base", "7".repeat(64)),
    ];
    const diff = diffProvisioning({ desired, current });
    const retire = diff.actions.find((a) => a.action === "retire");
    assert.ok(retire, "the orphan must be retired");
    assert.equal(retire.resourceType, "knowledge_base");
  });

  it("RECONCILE_REQUIRED — and never CREATE — when the recorded state is not trustworthy", () => {
    const desired = desiredFor();
    for (const outcome of ["ambiguous", "provider_success_persist_failed", "durable_exists_provider_unverified", null]) {
      const current = desired.resources.map((r) =>
        recordedRow(r.purpose, r.resourceType, r.payloadHash, { lastOutcome: outcome }));
      const diff = diffProvisioning({ desired, current });
      for (const a of diff.actions) {
        assert.equal(a.action, "reconcile_required", `outcome "${outcome}" must not classify as ${a.action}`);
        assert.notEqual(a.action, "create", "UNKNOWN IS NEVER CREATE");
      }
      assert.equal(diff.requiresReconciliation, true);
      assert.equal(diff.isNoOp, false);
    }
  });

  it("RECONCILE_REQUIRED when a row records no provider resource id", () => {
    const desired = desiredFor();
    const current = desired.resources.map((r) =>
      recordedRow(r.purpose, r.resourceType, r.payloadHash, { provider_resource_id: null }));
    const diff = diffProvisioning({ desired, current });
    assert.ok(diff.actions.every((a) => a.action === "reconcile_required"));
  });

  it("RECONCILE_REQUIRED when another authority produced the resource", () => {
    const desired = desiredFor();
    const current = desired.resources.map((r) =>
      recordedRow(r.purpose, r.resourceType, r.payloadHash, {
        providerMetadata: { producedBy: "locksmith-receptionist-compiler", configVersion: 1 },
      }));
    const diff = diffProvisioning({ desired, current });
    for (const a of diff.actions) {
      assert.equal(a.action, "reconcile_required");
      assert.match(a.reason, /produced by/);
    }
  });

  it("cascades: an unchanged agent is UPDATED when the engine it points at is replaced", () => {
    // Force the engine to replace_only, then prove the dependent agent moves
    // from no_change to update because the engine will have a new provider id.
    const original = M.RESOURCE_MUTABILITY.response_engine;
    try {
      const desired = desiredFor();
      const current = [
        recordedRow("receptionist_agent", "response_engine", "8".repeat(64)),
        recordedRow("receptionist_agent", "voice_agent", desired.resources[1].payloadHash),
      ];
      // With response_engine updatable, the agent stays no_change.
      const soft = diffProvisioning({ desired, current });
      assert.equal(soft.actions.find((a) => a.resourceType === "voice_agent").action, "no_change");

      // Now make it replace_only and re-diff.
      const mutable = { ...M.RESOURCE_MUTABILITY, response_engine: "replace_only" };
      const patched = require("../src/platform/provisioning-model");
      Object.defineProperty(patched, "RESOURCE_MUTABILITY", { value: mutable, configurable: true });
      delete require.cache[require.resolve("../src/platform/provisioning-diff")];
      const { diffProvisioning: freshDiff } = require("../src/platform/provisioning-diff");
      const hard = freshDiff({ desired, current });
      const engine = hard.actions.find((a) => a.resourceType === "response_engine");
      const agent = hard.actions.find((a) => a.resourceType === "voice_agent");
      assert.equal(engine.action, "replace");
      assert.equal(agent.action, "update");
      assert.equal(agent.cascaded, true);
      assert.match(agent.reason, /new provider id/);
    } finally {
      const patched = require("../src/platform/provisioning-model");
      Object.defineProperty(patched, "RESOURCE_MUTABILITY", { value: original, configurable: true });
      delete require.cache[require.resolve("../src/platform/provisioning-diff")];
      require("../src/platform/provisioning-diff");
    }
  });

  it("orders actions so a dependency comes before what references it", () => {
    const diff = diffProvisioning({ desired: desiredFor(), current: [] });
    assert.equal(diff.actions[0].resourceType, "response_engine");
    assert.equal(diff.actions[1].resourceType, "voice_agent");
  });

  it("REFUSES to plan against another tenant's resources", () => {
    const desired = desiredFor();
    const current = desired.resources.map((r) => ({ ...recordedRow(r.purpose, r.resourceType, r.payloadHash), client_id: "somebody_else" }));
    const diff = diffProvisioning({ desired, current });
    assert.equal(diff.ok, false);
    assert.equal(diff.code, "cross_tenant_resource");
  });

  it("ignores rows for a different provider, and inactive rows", () => {
    const desired = desiredFor();
    const current = [
      ...desired.resources.map((r) => ({ ...recordedRow(r.purpose, r.resourceType, r.payloadHash), provider: "mock" })),
      ...desired.resources.map((r) => ({ ...recordedRow(r.purpose, r.resourceType, r.payloadHash), active: false })),
    ];
    const diff = diffProvisioning({ desired, current });
    assert.ok(diff.actions.every((a) => a.action === "create"), "neither a mock row nor a retired row counts as present");
  });

  it("records a provenance refresh WITHOUT a provider mutation when an older config produced identical output", () => {
    const desired = desiredFor(plumberC, 5);
    const current = desired.resources.map((r) =>
      recordedRow(r.purpose, r.resourceType, r.payloadHash, {
        providerMetadata: { producedBy: "aida-client-platform", configVersion: 3 },
      }));
    const diff = diffProvisioning({ desired, current });
    for (const a of diff.actions) {
      assert.equal(a.action, "no_change");
      assert.deepEqual(a.provenanceRefresh, { from: 3, to: 5, providerMutation: false });
    }
    assert.equal(diff.isNoOp, true, "refreshing provenance is not a provider mutation");
  });
});

describe("P21A — the ambiguity state machine", () => {
  it("gives every outcome a rule, and only ONE permits re-creating", () => {
    for (const outcome of M.PROVIDER_OUTCOMES) {
      const rule = M.OUTCOME_RULES[outcome];
      assert.ok(rule, `${outcome} needs a rule`);
      assert.ok(M.RESOURCE_STATES.includes(rule.resourceState));
    }
    const retryable = M.PROVIDER_OUTCOMES.filter((o) => M.OUTCOME_RULES[o].mayRetryCreate);
    assert.deepEqual(retryable, ["definite_failure"],
      "only an explicit provider refusal permits another create");
  });

  it("maps every non-definite outcome to UNKNOWN, never to absent", () => {
    for (const outcome of ["ambiguous", "provider_success_persist_failed", "durable_exists_provider_unverified"]) {
      assert.equal(M.OUTCOME_RULES[outcome].resourceState, "unknown");
      assert.notEqual(M.OUTCOME_RULES[outcome].resourceState, "absent");
    }
  });

  it("requires a human for a lost response and for a failed persistence", () => {
    assert.equal(M.OUTCOME_RULES.ambiguous.requiresHuman, true);
    assert.equal(M.OUTCOME_RULES.provider_success_persist_failed.requiresHuman, true);
  });

  it("treats an untrusted row as untrusted, whatever else is true of it", () => {
    assert.equal(trustworthiness({ lastOutcome: "definite_success", providerResourceId: "x" }).trusted, true);
    assert.equal(trustworthiness({ lastOutcome: "ambiguous", providerResourceId: "x" }).trusted, false);
    assert.equal(trustworthiness({ lastOutcome: "definite_success", providerResourceId: null }).trusted, false);
    assert.equal(trustworthiness({ lastOutcome: null }).trusted, false);
    assert.equal(trustworthiness({ lastOutcome: "invented" }).trusted, false);
  });
});

describe("P21B — reconciliation", () => {
  const recorded = { providerResourceId: "prov_1", payloadHash: "a".repeat(64) };

  it("MATCH when both sides agree", () => {
    assert.equal(reconcile({ recorded, observed: { providerResourceId: "prov_1", payloadHash: "a".repeat(64) } }).result, "match");
    assert.equal(reconcile({ recorded: null, observed: null }).result, "match");
  });

  it("DRIFT when both exist and the payloads differ", () => {
    const r = reconcile({ recorded, observed: { providerResourceId: "prov_1", payloadHash: "b".repeat(64) } });
    assert.equal(r.result, "drift");
  });

  it("MISSING_PROVIDER_RESOURCE when the registry has one and the provider does not", () => {
    assert.equal(reconcile({ recorded, observed: null }).result, "missing_provider_resource");
  });

  it("UNRECORDED_PROVIDER_RESOURCE, and never an automatic adoption", () => {
    const r = reconcile({ recorded: null, observed: { providerResourceId: "prov_stranger" } });
    assert.equal(r.result, "unrecorded_provider_resource");
    assert.match(r.detail, /never adopt it automatically/);
  });

  it("UNKNOWN when the provider could not be asked — which is NOT 'nothing there'", () => {
    const r = reconcile({ recorded });                       // observed omitted
    assert.equal(r.result, "unknown");
    assert.notEqual(r.result, "missing_provider_resource");
    // The distinction that stops a second agent being created.
    assert.notEqual(reconcile({ recorded }).result, reconcile({ recorded, observed: null }).result);
  });

  it("MANUAL_REVIEW_REQUIRED when the two sides name different resources", () => {
    const r = reconcile({ recorded, observed: { providerResourceId: "prov_other", payloadHash: "a".repeat(64) } });
    assert.equal(r.result, "manual_review_required");
  });

  it("gives every declared result a meaning", () => {
    for (const name of M.RECONCILIATION_RESULTS) {
      assert.ok(M.RECONCILIATION_MEANING[name], `${name} needs a meaning`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P22 — THE PLAN AUTHORITY
// ════════════════════════════════════════════════════════════════════

describe("P22 plans — binding, staleness and approval", () => {
  function harness() {
    const now = clock();
    return { now, authority: createPlanAuthority({ store: createInMemoryPlanStore(), now }) };
  }
  const diffFor = (make = plumberC, v = 1) => diffProvisioning({ desired: desiredFor(make, v), current: [] });
  const CONFIG = (v = 1) => ({ configVersion: v, behaviourHash: desiredFor(plumberC, v).behaviourHash, configContentHash: "c".repeat(64) });

  async function approvedPlan(authority, v = 1) {
    const created = await authority.createPlan({
      clientId: "riverside_plumbing", diff: diffFor(plumberC, v), configContentHash: "c".repeat(64), createdBy: "Peter Dang",
    });
    await authority.validatePlan({ clientId: "riverside_plumbing", planId: created.plan.planId, currentConfig: CONFIG(v) });
    const approved = await authority.approvePlan({
      clientId: "riverside_plumbing", planId: created.plan.planId, approvedBy: "Peter Dang", currentConfig: CONFIG(v),
    });
    return approved.plan;
  }

  it("binds a plan to one exact configuration", async () => {
    const { authority } = harness();
    const created = await authority.createPlan({
      clientId: "riverside_plumbing", diff: diffFor(), configContentHash: "c".repeat(64), createdBy: "Peter Dang",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const plan = created.plan;
    assert.equal(plan.status, "draft");
    assert.equal(plan.configVersion, 1);
    assert.equal(plan.configContentHash, "c".repeat(64));
    assert.match(plan.behaviourHash, /^[0-9a-f]{64}$/);
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
  });

  it("refuses a diff belonging to another client", async () => {
    const { authority } = harness();
    const result = await authority.createPlan({ clientId: "rolladoor_repairs", diff: diffFor(plumberC), createdBy: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.code, PLAN_CODES.CROSS_TENANT);
  });

  it("supersedes an earlier open plan, so one client never has two", async () => {
    const { authority } = harness();
    const first = await authority.createPlan({ clientId: "riverside_plumbing", diff: diffFor(), createdBy: "x" });
    const second = await authority.createPlan({ clientId: "riverside_plumbing", diff: diffFor(), createdBy: "x" });
    const listed = await authority.listPlans("riverside_plumbing");
    const open = listed.plans.filter((p) => ["draft", "validated", "approved"].includes(p.status));
    assert.equal(open.length, 1);
    assert.equal(open[0].planId, second.plan.planId);
    assert.equal((await authority.getPlan("riverside_plumbing", first.plan.planId)).plan.status, "superseded");
  });

  it("STALE when the active configuration has moved on (P23B)", async () => {
    const { authority } = harness();
    const created = await authority.createPlan({
      clientId: "riverside_plumbing", diff: diffFor(plumberC, 1), configContentHash: "c".repeat(64), createdBy: "x",
    });
    const result = await authority.validatePlan({
      clientId: "riverside_plumbing", planId: created.plan.planId, currentConfig: CONFIG(2),
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockingReasons.some((b) => b.code === PLAN_CODES.STALE));
    assert.equal(result.plan.status, "draft", "a stale plan stays a draft — it is never silently regenerated");
  });

  it("STALE when there is no active configuration at all", () => {
    const stale = describeStaleness({ configVersion: 1 }, null);
    assert.equal(stale.stale, true);
    assert.match(stale.why, /no active configuration/);
  });

  it("STALE when the behaviour hash moved even at the same version number", () => {
    const stale = describeStaleness(
      { configVersion: 1, behaviourHash: "a".repeat(64) },
      { configVersion: 1, behaviourHash: "b".repeat(64) },
    );
    assert.equal(stale.stale, true);
  });

  it("approval requires a validated plan and a named person", async () => {
    const { authority } = harness();
    const created = await authority.createPlan({ clientId: "riverside_plumbing", diff: diffFor(), createdBy: "x" });
    const id = created.plan.planId;

    const early = await authority.approvePlan({ clientId: "riverside_plumbing", planId: id, approvedBy: "Peter Dang", currentConfig: CONFIG() });
    assert.equal(early.code, PLAN_CODES.NOT_VALIDATED);

    await authority.validatePlan({ clientId: "riverside_plumbing", planId: id, currentConfig: CONFIG() });
    for (const machine of ["system", "aida", "bot", "cron", "", "  "]) {
      const r = await authority.approvePlan({ clientId: "riverside_plumbing", planId: id, approvedBy: machine, currentConfig: CONFIG() });
      assert.equal(r.code, PLAN_CODES.NOT_A_PERSON, `"${machine}" must not approve provider mutations`);
    }
  });

  it("approval binds to the exact plan hash the reviewer read", async () => {
    const { authority } = harness();
    const created = await authority.createPlan({ clientId: "riverside_plumbing", diff: diffFor(), configContentHash: "c".repeat(64), createdBy: "x" });
    const id = created.plan.planId;
    await authority.validatePlan({ clientId: "riverside_plumbing", planId: id, currentConfig: CONFIG() });

    const wrong = await authority.approvePlan({
      clientId: "riverside_plumbing", planId: id, approvedBy: "Peter Dang",
      expectedPlanHash: "f".repeat(64), currentConfig: CONFIG(),
    });
    assert.equal(wrong.code, PLAN_CODES.HASH_MISMATCH);

    const right = await authority.approvePlan({
      clientId: "riverside_plumbing", planId: id, approvedBy: "Peter Dang",
      expectedPlanHash: created.plan.planHash, currentConfig: CONFIG(),
    });
    assert.equal(right.ok, true, JSON.stringify(right));
    assert.equal(right.plan.approvedPlanHash, created.plan.planHash);
  });

  it("re-checks staleness AT APPROVAL, not merely at validation", async () => {
    const { authority } = harness();
    const created = await authority.createPlan({ clientId: "riverside_plumbing", diff: diffFor(plumberC, 1), configContentHash: "c".repeat(64), createdBy: "x" });
    const id = created.plan.planId;
    await authority.validatePlan({ clientId: "riverside_plumbing", planId: id, currentConfig: CONFIG(1) });
    // The configuration moves between validating and approving.
    const result = await authority.approvePlan({
      clientId: "riverside_plumbing", planId: id, approvedBy: "Peter Dang", currentConfig: CONFIG(2),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, PLAN_CODES.STALE);
  });

  it("an approved plan is frozen and says it is not executable", async () => {
    const { authority } = harness();
    const plan = await approvedPlan(authority);
    assert.equal(plan.status, "approved");
    assert.equal(plan.approvedPlanHash, plan.planHash);
    assert.equal(planHashOf(plan), plan.planHash, "the hash still covers the body");
    assert.ok(Object.isFrozen(plan));
  });

  it("refuses to approve twice", async () => {
    const { authority } = harness();
    const plan = await approvedPlan(authority);
    const again = await authority.approvePlan({
      clientId: "riverside_plumbing", planId: plan.planId, approvedBy: "Peter Dang", currentConfig: CONFIG(),
    });
    assert.equal(again.code, PLAN_CODES.ALREADY_APPROVED);
  });

  it("refuses to re-validate an approved plan, which would change what was approved", async () => {
    const { authority } = harness();
    const plan = await approvedPlan(authority);
    const result = await authority.validatePlan({ clientId: "riverside_plumbing", planId: plan.planId, currentConfig: CONFIG() });
    assert.equal(result.code, PLAN_CODES.ALREADY_APPROVED);
  });

  it("blocks approval while reconciliation is required", async () => {
    const { authority } = harness();
    const desired = desiredFor();
    const current = desired.resources.map((r) => recordedRow(r.purpose, r.resourceType, r.payloadHash, { lastOutcome: "ambiguous" }));
    const created = await authority.createPlan({
      clientId: "riverside_plumbing", diff: diffProvisioning({ desired, current }), configContentHash: "c".repeat(64), createdBy: "x",
    });
    const result = await authority.validatePlan({ clientId: "riverside_plumbing", planId: created.plan.planId, currentConfig: CONFIG() });
    assert.equal(result.ok, false);
    assert.ok(result.blockingReasons.some((b) => b.code === "reconciliation_required"));
  });

  it("the plan hash covers the actions AND the configuration binding", () => {
    const base = {
      clientId: "riverside_plumbing", provider: "retell", configVersion: 1,
      configContentHash: "c".repeat(64), behaviourHash: "b".repeat(64), desiredHash: "d".repeat(64),
      actions: [{ key: "a:b", action: "create", purpose: "a", resourceType: "b", desiredPayloadHash: "1", currentPayloadHash: null }],
    };
    const original = planHashOf(base);
    assert.notEqual(planHashOf({ ...base, configVersion: 2 }), original, "a different config is a different plan");
    assert.notEqual(planHashOf({ ...base, behaviourHash: "e".repeat(64) }), original);
    assert.notEqual(planHashOf({ ...base, actions: [{ ...base.actions[0], action: "update" }] }), original);
    assert.equal(planHashOf({ ...base }), original, "and it is deterministic");
  });
});

describe("P22 — nothing here can execute", () => {
  it("the authority exposes no execute operation", () => {
    const authority = createPlanAuthority({ store: createInMemoryPlanStore(), now: clock() });
    for (const name of Object.keys(authority)) {
      assert.ok(!/^(execute|run|perform|apply|provision|deploy|send|dial)/i.test(name), `exposes "${name}"`);
    }
    assert.ok(!("execute" in authority));
    assert.ok("assertExecutable" in authority, "it may ASK, and asking is not doing");
  });

  it("assertExecutable always reports NOT executable, and says why", async () => {
    const now = clock();
    const authority = createPlanAuthority({ store: createInMemoryPlanStore(), now });
    const diff = diffProvisioning({ desired: desiredFor(), current: [] });
    const created = await authority.createPlan({ clientId: "riverside_plumbing", diff, configContentHash: "c".repeat(64), createdBy: "x" });
    const config = { configVersion: 1, behaviourHash: null, configContentHash: "c".repeat(64) };
    await authority.validatePlan({ clientId: "riverside_plumbing", planId: created.plan.planId, currentConfig: config });
    await authority.approvePlan({ clientId: "riverside_plumbing", planId: created.plan.planId, approvedBy: "Peter Dang", currentConfig: config });

    const result = await authority.assertExecutable({ clientId: "riverside_plumbing", planId: created.plan.planId, currentConfig: config });
    assert.equal(result.executable, false);
    assert.ok(result.blockers.some((b) => b.code === "no_executor_exists"));
    assert.match(result.note, /not a permission and it performs nothing/);
  });

  it("no plan status ever reaches an execution state", async () => {
    const now = clock();
    const authority = createPlanAuthority({ store: createInMemoryPlanStore(), now });
    const diff = diffProvisioning({ desired: desiredFor(), current: [] });
    const created = await authority.createPlan({ clientId: "riverside_plumbing", diff, configContentHash: "c".repeat(64), createdBy: "x" });
    const config = { configVersion: 1, behaviourHash: null, configContentHash: "c".repeat(64) };
    await authority.validatePlan({ clientId: "riverside_plumbing", planId: created.plan.planId, currentConfig: config });
    await authority.approvePlan({ clientId: "riverside_plumbing", planId: created.plan.planId, approvedBy: "Peter Dang", currentConfig: config });

    const listed = await authority.listPlans("riverside_plumbing");
    for (const p of listed.plans) {
      assert.ok(!M.PLAN_EXECUTION_STATUSES.includes(p.status), `a plan reached ${p.status}`);
    }
    const plan = (await authority.getPlan("riverside_plumbing", created.plan.planId)).plan;
    assert.equal(plan.executionState, null);
    assert.equal(plan.executedAt, null);
  });

  it("the plan authority imports nothing that could reach a provider", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provisioning-plan-authority.js"), "utf8");
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./provisioning-model", "./stable-json", "crypto"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// P23A + P23E — READINESS AND THE EXECUTION CONTRACT
// ════════════════════════════════════════════════════════════════════

describe("P23A readiness — a view, never authority", () => {
  it("is HARDCODED not ready, whatever is passed in", () => {
    const everythingPerfect = assessClientReadiness({
      clientId: "riverside_plumbing",
      clientRecord: { slug: "riverside_plumbing" },
      activeConfig: { configVersion: 1 },
      plan: { planId: "plan_1", status: "approved", mutatingCount: 0 },
      planStaleness: { stale: false },
      desiredState: { unresolved: [] },
      currentResources: [{ active: true, lastOutcome: "definite_success" }],
      phoneNumber: "+61355500399",
      inboundBinding: { bound: true },
      integrations: [],
      complianceIssues: [],
    });
    assert.equal(everythingPerfect.blockerCount, 0, "every dimension can report satisfied");
    assert.equal(everythingPerfect.ready, false, "and it is STILL not ready — readiness is never permission");
    assert.match(everythingPerfect.readyReason, /never a permission/);
  });

  it("the literal `ready: false` is in the source, not a computation", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provisioning-readiness.js"), "utf8");
    assert.match(source, /ready:\s*false/);
    // There must be no expression that could produce true.
    assert.ok(!/ready:\s*(blockers|!|Boolean|.*===)/.test(source), "ready must not be computed");
  });

  it("names the missing client record first, because nothing can be filed without it", () => {
    const r = assessClientReadiness({ clientId: "new_client" });
    const record = r.dimensions.find((d) => d.dimension === "client_record");
    assert.equal(record.status, "absent");
    assert.match(record.detail, /never invent one from a business name/);
  });

  it("reports a slug mismatch between the clients row and the request", () => {
    const r = assessClientReadiness({ clientId: "asked_for", clientRecord: { slug: "actually_is" } });
    assert.ok(r.dimensions.some((d) => d.dimension === "client_record" && d.status === "mismatch"));
  });

  it("reports each dimension separately so a person knows what to do next", () => {
    const r = assessClientReadiness({ clientId: "riverside_plumbing" });
    const named = new Set(r.dimensions.map((d) => d.dimension));
    for (const d of ["client_record", "configuration", "provisioning", "provider", "phone", "routing", "integrations", "compliance"]) {
      assert.ok(named.has(d), `missing dimension ${d}`);
    }
  });

  it("reports unresolved provider references by name", () => {
    const r = assessClientReadiness({
      clientId: "x_client", activeConfig: { configVersion: 1 },
      desiredState: { unresolved: ["voiceId", "webhookUrl"] },
    });
    const provider = r.dimensions.find((d) => d.status === "unresolved_references");
    assert.ok(provider);
    assert.match(provider.detail, /voiceId, webhookUrl/);
    assert.match(provider.detail, /never guessed/);
  });

  it("says a recorded resource is recorded, NOT verified", () => {
    const r = assessClientReadiness({
      clientId: "x_client", currentResources: [{ active: true, lastOutcome: "definite_success" }],
    });
    const provider = r.dimensions.find((d) => d.dimension === "provider");
    assert.match(provider.detail, /recorded is not the same as verified/);
  });

  it("treats an untrusted recorded resource as unknown", () => {
    const r = assessClientReadiness({
      clientId: "x_client", currentResources: [{ active: true, lastOutcome: "ambiguous" }],
    });
    assert.ok(r.dimensions.some((d) => d.dimension === "provider" && d.status === "unknown"));
  });

  it("says provisioning does not buy a telephone number", () => {
    const r = assessClientReadiness({ clientId: "x_client" });
    const phone = r.dimensions.find((d) => d.dimension === "phone");
    assert.match(phone.detail, /separate authority and provisioning does not buy one/);
  });
});

describe("P23E execution contract — specified, and absent", () => {
  it("declares twelve ordered preconditions", () => {
    const contract = describeExecutionContract();
    assert.equal(contract.implemented, false);
    assert.equal(contract.executorExists, false);
    assert.equal(contract.preconditionCount, 12);
    assert.deepEqual(EXECUTION_PRECONDITIONS.map((p) => p.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const p of EXECUTION_PRECONDITIONS) {
      assert.ok(p.gate && p.requires && p.why, `step ${p.step} is incomplete`);
    }
  });

  it("includes the gates the founder named, in order", () => {
    const gates = EXECUTION_PRECONDITIONS.map((p) => p.gate);
    for (const expected of [
      "authenticated_execution_authority", "plan_approved", "plan_hash_exact",
      "active_configuration_still_exact", "tenant_and_resource_ownership_exact",
      "provider_tag_and_environment_exact", "durable_one_resource_authority",
      "final_stop_gate", "exactly_one_provider_mutation", "durable_result_recorded",
      "ambiguity_is_unknown", "no_automatic_retry",
    ]) {
      assert.ok(gates.includes(expected), `missing gate ${expected}`);
    }
  });

  it("borrows the generic acquisition lessons and NOT the cold-calling gates", () => {
    const contract = describeExecutionContract();
    assert.ok(contract.borrowedFromAcquisition.some((b) => /ambiguity is not failure/.test(b)));
    assert.ok(contract.borrowedFromAcquisition.some((b) => /no auto-retry/.test(b)));
    for (const notBorrowed of ["DNCR washing", "suppression lists", "calling-hours policy", "the dial authorisation slip", "the global calling stop"]) {
      assert.ok(contract.deliberatelyNotBorrowed.includes(notBorrowed), `${notBorrowed} must be explicitly excluded`);
    }
    assert.match(contract.whyNotBorrowed, /not a cold call/);
  });

  it("imports nothing at all — it is a specification, not a door", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provisioning-execution-contract.js"), "utf8");
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports, []);

    // Strip comments AND string literals before looking for code. This file is
    // mostly prose explaining WHY each gate exists — including the acquisition
    // lesson about an env file overriding process.env — and a raw sweep
    // matched the explanation rather than any executable line.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/`(?:\\.|[^`\\])*`/g, "``");

    for (const forbidden of ["fetch(", "http", "axios", "process.env", "XMLHttpRequest"]) {
      assert.ok(!code.includes(forbidden), `the contract must contain no ${forbidden} in code`);
    }
    // Non-vacuity: the stripper must not blind the check to real code.
    const withCode = 'const x = "a harmless process.env mention";\nconst y = process.env.SECRET;'
      .replace(/"(?:\\.|[^"\\])*"/g, '""');
    assert.ok(withCode.includes("process.env"), "a genuine process.env read must still be caught");
  });

  it("exports no function that could perform anything", () => {
    const module = require("../src/platform/provisioning-execution-contract");
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== "function") continue;
      assert.ok(/^describe/.test(name), `${name} should only describe`);
    }
  });
});
