// Shared harness for the provisioning EXECUTION tests — test infrastructure.
//
// Builds a complete offline platform: config service, plan authority, desired
// state compiler, durable execution store, provider_resources registry, and an
// executor. Every provider adapter it can reach is a fake, and there is no code
// path from here to a network.

const { createConfigService } = require("../../src/platform/config-service");
const { createInMemoryBlueprintStore } = require("../../src/platform/blueprint-authority");
const { createInMemoryConfigAudit } = require("../../src/platform/config-audit");
const { createPlanAuthority, createInMemoryPlanStore } = require("../../src/platform/provisioning-plan-authority");
const { compileDesiredState } = require("../../src/platform/provisioning-desired-state");
const { diffProvisioning } = require("../../src/platform/provisioning-diff");
const { createProvisioningExecutor } = require("../../src/platform/provisioning-executor");
const { createInMemoryExecutionStore } = require("../../src/platform/execution-claim");
const { createInMemoryResourceRegistry } = require("../../src/platform/resource-registry-writer");
const { createPrincipal, executionPrincipal } = require("../../src/platform/config-access");

const PROVIDER_REFS = Object.freeze({
  llmId: "llm_fake0000",
  voiceId: "custom_voice_fake0000",
  webhookUrl: "https://example.invalid/hooks",
});

const ENVIRONMENT_TAG = "fake-env";

function fixedClock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 60000) => { t += ms; return new Date(t); };
  return now;
}

function principals(clientId) {
  return {
    editor: createPrincipal({ role: "client_editor", actorId: "editor@x.invalid", clientId }),
    owner: createPrincipal({ role: "client_owner", actorId: "owner@x.invalid", clientId }),
    operator: createPrincipal({ role: "operator", actorId: "Peter Dang", clientId, crossTenant: true }),
    // The only one that may execute, and it must be built on purpose.
    executor: executionPrincipal({ clientId, actorId: "Peter Dang" }),
  };
}

function buildPlatform({ providerRefs = PROVIDER_REFS, environmentTag = ENVIRONMENT_TAG, now = fixedClock() } = {}) {
  const audit = createInMemoryConfigAudit({ now });
  const configService = createConfigService({ store: createInMemoryBlueprintStore(), now, audit, providerRefs });
  const planStore = createInMemoryPlanStore();
  const planAuthority = createPlanAuthority({ store: planStore, now });
  const registry = createInMemoryResourceRegistry();
  const executionStore = createInMemoryExecutionStore();

  const desiredStateCompiler = (version) => compileDesiredState({ version, providerRefs });

  const executor = createProvisioningExecutor({
    planAuthority, configService, desiredStateCompiler,
    executionStore, registry, now, environmentTag, audit,
  });

  return {
    now, audit, configService, planStore, planAuthority, registry, executionStore,
    executor, desiredStateCompiler, providerRefs, environmentTag,
  };
}

/** Take a client to an ACTIVE configuration through the real service path. */
async function activateConfig(platform, clientId, blueprint) {
  const p = principals(clientId);
  const draft = await platform.configService.createDraft({ principal: p.editor, clientId, blueprint });
  if (!draft.ok) throw new Error(`createDraft: ${JSON.stringify(draft)}`);
  const v = draft.configVersion;
  const validated = await platform.configService.validate({ principal: p.editor, clientId, configVersion: v });
  if (!validated.ok) throw new Error(`validate: ${JSON.stringify(validated)}`);
  const approved = await platform.configService.approve({ principal: p.owner, clientId, configVersion: v });
  if (!approved.ok) throw new Error(`approve: ${JSON.stringify(approved)}`);
  const activated = await platform.configService.activate({ principal: p.operator, clientId, configVersion: v });
  if (!activated.ok) throw new Error(`activate: ${JSON.stringify(activated)}`);
  return v;
}

/** Build, validate and approve a plan, tagged for the fake environment. */
async function approvePlan(platform, clientId, { providerTag = ENVIRONMENT_TAG } = {}) {
  const p = principals(clientId);
  const active = await platform.configService.getActive({ principal: p.operator, clientId });
  if (!active.ok) throw new Error(`no active config: ${JSON.stringify(active)}`);
  const version = active.version;

  const desired = platform.desiredStateCompiler(version);
  const current = await platform.registry.listForClient(clientId);
  const diff = diffProvisioning({ desired, current });
  if (!diff.ok) throw new Error(`diff: ${JSON.stringify(diff)}`);

  const created = await platform.planAuthority.createPlan({
    clientId, diff,
    configContentHash: version.metadata.contentHash ?? null,
    createdBy: "Peter Dang",
  });
  if (!created.ok) throw new Error(`createPlan: ${JSON.stringify(created)}`);

  // The plan records which environment it is for. Gate 11 re-reads the runtime
  // tag late and compares.
  const tagged = { ...created.plan, providerTag };
  await platform.planStore.replacePlan(tagged);

  const currentConfig = {
    configVersion: version.metadata.configVersion,
    behaviourHash: null,
    configContentHash: version.metadata.contentHash ?? null,
  };
  const validated = await platform.planAuthority.validatePlan({ clientId, planId: tagged.planId, currentConfig });
  if (!validated.ok) throw new Error(`validatePlan: ${JSON.stringify(validated)}`);
  const approved = await platform.planAuthority.approvePlan({
    clientId, planId: tagged.planId, approvedBy: "Peter Dang", currentConfig,
  });
  if (!approved.ok) throw new Error(`approvePlan: ${JSON.stringify(approved)}`);
  return approved.plan;
}

/** Everything up to the moment before execution. */
async function readyToExecute(platform, clientId, blueprint, options = {}) {
  await activateConfig(platform, clientId, blueprint);
  const plan = await approvePlan(platform, clientId, options);
  return { plan, principals: principals(clientId) };
}

module.exports = {
  buildPlatform, activateConfig, approvePlan, readyToExecute, principals,
  fixedClock, PROVIDER_REFS, ENVIRONMENT_TAG,
};
