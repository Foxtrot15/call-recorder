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
const { createPrincipal } = P("config-access");
const { FIXTURE_CLIENTS } = require(path.join(ROOT, "src/platform/fixtures/clients"));

const argv = process.argv.slice(2);
const wants = (flag) => argv.includes(flag);

// Deployment facts. Absent ones are reported by name and never invented — with
// none supplied, a plan can still be built and reviewed, and a preview simply
// says what is missing.
const PROVIDER_REFS = {
  llmId: null,
  voiceId: null,
  webhookUrl: null,
};
const ENVIRONMENT_TAG = "local-fake";

async function seedDemo(platform) {
  const now = () => new Date();
  for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
    const editor = createPrincipal({ role: "client_editor", actorId: "demo seed", clientId });
    const owner = createPrincipal({ role: "client_owner", actorId: "Peter Dang", clientId });
    const operator = createPrincipal({ role: "operator", actorId: "Peter Dang", clientId, crossTenant: true });
    const draft = await platform.configService.createDraft({ principal: editor, clientId, blueprint: make() });
    const v = draft.configVersion;
    await platform.configService.validate({ principal: editor, clientId, configVersion: v });
    await platform.configService.approve({ principal: owner, clientId, configVersion: v, reason: "demonstration seed" });
    await platform.configService.activate({ principal: operator, clientId, configVersion: v });
  }
  void now;
}

(async () => {
  const now = () => new Date();
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
    if (wants("--demo")) await seedDemo(platform);
  } catch (error) {
    process.stdout.write(`could not seed the demonstration clients: ${error.message}\n`);
    process.exit(1);
  }

  const forCommand = argv.filter((a) => a !== "--demo");
  const { exitCode, lines } = await runProvisionCommand({ argv: forCommand, platform });
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(exitCode);
})();
