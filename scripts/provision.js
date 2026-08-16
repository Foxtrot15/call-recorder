#!/usr/bin/env node
// ============================================================================
// AIDA PLATFORM — the operator provisioning CLI (P28).
//
//   node scripts/provision.js help
//   node scripts/provision.js inspect   riverside_plumbing --demo
//   node scripts/provision.js plan      riverside_plumbing --demo
//   node scripts/provision.js execute   riverside_plumbing --demo --fake-provider
//   node scripts/provision.js reconcile riverside_plumbing --demo --fake-provider
//
// ── THIS IS THE SHELL, NOT THE LOGIC ────────────────────────────────
// Read argv, build an entirely in-memory platform, call
// src/platform/provision-cli.js, print, exit. Every decision lives there,
// where it is tested without spawning a process.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────
// The only provider adapter it can construct is a FAKE. There is no --live, no
// --retell, no --force, no --retry-unknown, and no environment variable that
// changes any of that. Nothing here opens a socket, and the store is in-memory
// because ACP1, ACP2 and ACP3 have been applied nowhere.
//
// Running this changes nothing outside this process.
// ============================================================================

const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const P = (m) => require(path.join(ROOT, "src/platform", m));

const { runProvisionCommand } = P("provision-cli");
const { createConfigService } = P("config-service");
const { createInMemoryBlueprintStore } = P("blueprint-authority");
const { createInMemoryConfigAudit } = P("config-audit");
const { createPlanAuthority, createInMemoryPlanStore } = P("provisioning-plan-authority");
const { compileDesiredState } = P("provisioning-desired-state");
const { createProvisioningExecutor } = P("provisioning-executor");
const { createInMemoryExecutionStore } = P("execution-claim");
const { createInMemoryResourceRegistry } = P("resource-registry-writer");
const { createFakeProviderAdapter } = P("provider-mutation-port");
const { diffProvisioning } = P("provisioning-diff");
const { createPrincipal } = P("config-access");
const { FIXTURE_CLIENTS } = require(path.join(ROOT, "src/platform/fixtures/clients"));

const argv = process.argv.slice(2);
const wants = (flag) => argv.includes(flag);

// Deployment facts. For a REAL client these are absent, reported by name and
// never invented — a plan can still be built and reviewed, and a preview simply
// says what is missing.
const REAL_PROVIDER_REFS = {
  llmId: null,
  voiceId: null,
  webhookUrl: null,
};

// For --demo they are supplied, and they are VISIBLY fake. A demonstration
// against a fake adapter needs references, and inventing plausible-looking ones
// would be the actual sin — "fake" is in every value, and the host is a
// reserved-invalid TLD that cannot resolve even by accident.
const DEMO_PROVIDER_REFS = {
  llmId: "llm_fake0000000000",
  voiceId: "custom_voice_fake0000",
  webhookUrl: "https://example.invalid/hooks",
};
const ENVIRONMENT_TAG = "local-fake";

// The demonstration seed approves what a person would have to approve, with a
// named actor and a reason, exactly as the authority requires — because a
// demonstration that stops at "no approved plan" demonstrates the refusal and
// nothing else. It is a FIXTURE, not a capability: the CLI itself has no
// approve command, and nothing here lets a request approve anything.
async function seedDemo(platform) {
  const seeded = [];
  for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
    const editor = createPrincipal({ role: "client_editor", actorId: "demo seed", clientId });
    const owner = createPrincipal({ role: "client_owner", actorId: "Peter Dang", clientId });
    const operator = createPrincipal({ role: "operator", actorId: "Peter Dang", clientId, crossTenant: true });
    const draft = await platform.configService.createDraft({ principal: editor, clientId, blueprint: make() });
    const v = draft.configVersion;
    await platform.configService.validate({ principal: editor, clientId, configVersion: v });
    await platform.configService.approve({ principal: owner, clientId, configVersion: v, reason: "demonstration seed" });
    await platform.configService.activate({ principal: operator, clientId, configVersion: v });

    const active = await platform.configService.getActive({ principal: operator, clientId });
    if (!active.ok) continue;
    const version = active.version;

    const desired = platform.desiredStateCompiler(version);
    const current = await platform.registry.listForClient(clientId);
    const diff = diffProvisioning({ desired, current });
    if (!diff.ok) continue;

    const created = await platform.planAuthority.createPlan({
      clientId, diff,
      configContentHash: version.metadata.contentHash ?? null,
      createdBy: "Peter Dang",
    });
    if (!created.ok) continue;

    // The plan records the environment it was built for. Gate 11 re-reads the
    // runtime tag immediately before the write and compares the two.
    await platform.planStore.replacePlan({ ...created.plan, providerTag: ENVIRONMENT_TAG });

    const currentConfig = {
      configVersion: version.metadata.configVersion,
      behaviourHash: null,
      configContentHash: version.metadata.contentHash ?? null,
    };
    const validated = await platform.planAuthority.validatePlan({ clientId, planId: created.plan.planId, currentConfig });
    if (!validated.ok) continue;
    const approved = await platform.planAuthority.approvePlan({
      clientId, planId: created.plan.planId,
      approvedBy: "Peter Dang", reason: "demonstration seed", currentConfig,
    });
    if (approved.ok) seeded.push(clientId);
  }
  return seeded;
}

(async () => {
  const now = () => new Date();
  const PROVIDER_REFS = wants("--demo") ? DEMO_PROVIDER_REFS : REAL_PROVIDER_REFS;
  const audit = createInMemoryConfigAudit({ now });
  const configService = createConfigService({ store: createInMemoryBlueprintStore(), now, audit, providerRefs: PROVIDER_REFS });
  const planStore = createInMemoryPlanStore();
  const planAuthority = createPlanAuthority({ store: planStore, now });
  const registry = createInMemoryResourceRegistry();
  const executionStore = createInMemoryExecutionStore();
  const desiredStateCompiler = (version) => compileDesiredState({ version, providerRefs: PROVIDER_REFS });

  const executor = createProvisioningExecutor({
    planAuthority, configService, desiredStateCompiler,
    executionStore, registry, now, environmentTag: ENVIRONMENT_TAG, audit,
  });

  const platform = {
    configService, planStore, planAuthority, registry, executionStore,
    executor, desiredStateCompiler, audit,
    // The ONLY adapter this script can build.
    fakeProviderAdapter: createFakeProviderAdapter({ name: "cli-fake" }),
    observations: {},
  };

  try {
    if (wants("--demo")) {
      const seeded = await seedDemo(platform);
      // Say it out loud. An operator who sees an execution succeed should never
      // have to wonder whether a person approved the plan or a script did.
      process.stdout.write(
        `--demo seeded ${seeded.length} demonstration client(s) with FAKE provider references, ` +
        `and approved their plans as a fixture. No human reviewed them.\n\n`,
      );
    }
  } catch (error) {
    process.stdout.write(`could not seed the demonstration clients: ${error.message}\n`);
    process.exit(1);
  }

  const forCommand = argv.filter((a) => a !== "--demo");
  const { exitCode, lines } = await runProvisionCommand({ argv: forCommand, platform });
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(exitCode);
})();
