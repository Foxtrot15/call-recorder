// AIDA PLATFORM — the operator provisioning CLI's logic (P28).
//
//   runProvisionCommand({ argv, platform, io })  -> { exitCode, lines[] }
//
//   provision plan       <clientId>              build a plan from the active config
//   provision inspect    <clientId>              show the diff, plans and readiness
//   provision execute    <clientId> --fake-provider
//   provision reconcile  <clientId> --fake-provider
//
// ── THE FLAGS THAT DO NOT EXIST ─────────────────────────────────────
// There is no --live, no --retell, no --force and no --retry-unknown. Not
// hidden, not disabled — absent, and a test asserts each of those strings is
// rejected as an unknown flag rather than quietly ignored.
//
// `--fake-provider` is REQUIRED for execute and reconcile. It is not a safety
// toggle that defaults to something dangerous; it is the only value it can
// take, and typing it is an acknowledgement of what the run is. When a real
// adapter eventually exists it will need its own flag, its own review and its
// own code — not a change to this one's default.
//
// ── AND THE PRINCIPAL ───────────────────────────────────────────────
// `execute` builds an `operator_executor` principal explicitly. That role
// cannot be produced by principalFromRequest, so no HTTP request can reach
// this authority however it is shaped.

const { compileDesiredState } = require("./provisioning-desired-state");
const { diffProvisioning } = require("./provisioning-diff");
const { reconcileClient, buildRepairPlan } = require("./reconciliation-engine");
const { assessClientReadiness } = require("./provisioning-readiness");
const { describeStaleness } = require("./provisioning-plan-authority");
const { executionPrincipal, createPrincipal } = require("./config-access");

const COMMANDS = Object.freeze(["plan", "inspect", "execute", "reconcile", "help"]);

/** Flags this CLI understands. Anything else is refused, by name. */
const KNOWN_FLAGS = Object.freeze(["--fake-provider", "--actor", "--observations", "--json"]);

/**
 * Flags that must NEVER exist. Listed so an attempt to use one gets a specific
 * refusal explaining why, rather than a generic "unknown flag" that reads like
 * a typo.
 */
const FORBIDDEN_FLAGS = Object.freeze({
  "--live": "There is no live provider transport in this build. Wiring one is a separate code milestone with its own review.",
  "--retell": "No real provider adapter exists. Only fakes do.",
  "--force": "Nothing here can be forced. Every refusal names a gate; fix the gate.",
  "--retry-unknown": "An ambiguous provider result is NEVER retried automatically. Observe the provider and reconcile.",
  "--no-preflight": "The preflight is not optional.",
  "--skip-gates": "The gates are not optional.",
});

const USAGE = [
  "aida provision — plan and (with a fake provider) execute client provisioning",
  "",
  "  plan      <clientId>                     build a provisioning plan from the active configuration",
  "  inspect   <clientId>                     show the diff, the plans and the readiness view",
  "  execute   <clientId> --fake-provider     run an approved plan against a FAKE provider",
  "  reconcile <clientId> --fake-provider     compare the registry with fake provider observations",
  "",
  "  --fake-provider is required for execute and reconcile, and is the only",
  "  provider this build has. There is no --live, no --retell, no --force and",
  "  no --retry-unknown.",
].join("\n");

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) flags[arg] = true;
    else { flags[arg] = next; i += 1; }
  }
  return { flags, positional };
}

async function runProvisionCommand({ argv = [], platform } = {}) {
  const lines = [];
  const say = (...text) => lines.push(...text);
  const done = (exitCode) => Object.freeze({ exitCode, lines: Object.freeze(lines) });

  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    say(USAGE);
    return done(command ? 0 : 1);
  }
  if (!COMMANDS.includes(command)) {
    say(`unknown command "${command}"`, "", USAGE);
    return done(1);
  }

  const { flags, positional } = parseArgs(rest);

  // ── the flags that must never work ──
  for (const [flag, why] of Object.entries(FORBIDDEN_FLAGS)) {
    if (flag in flags) {
      say(`REFUSED: ${flag} does not exist.`, why);
      return done(1);
    }
  }
  for (const flag of Object.keys(flags)) {
    if (!KNOWN_FLAGS.includes(flag)) {
      say(`unknown flag "${flag}"`, "", USAGE);
      return done(1);
    }
  }

  const clientId = positional[0];
  if (!clientId) { say(`${command} needs a clientId`, "", USAGE); return done(1); }
  if (!platform) { say("no platform available"); return done(1); }

  const actor = typeof flags["--actor"] === "string" ? flags["--actor"] : "operator";
  const operator = createPrincipal({ role: "operator", actorId: actor, clientId, crossTenant: true });

  const active = await platform.configService.getActive({ principal: operator, clientId });
  if (!active.ok && command !== "inspect") {
    say(`${clientId} has no active configuration — there is nothing to provision.`);
    return done(1);
  }
  const version = active.ok ? active.version : null;

  // ── inspect ──
  if (command === "inspect") {
    if (!version) { say(`${clientId}: no active configuration.`); return done(1); }
    const desired = platform.desiredStateCompiler(version);
    const current = await platform.registry.listForClient(clientId);
    const diff = diffProvisioning({ desired, current });

    say(`${clientId} — active configuration v${version.metadata.configVersion}`);
    say(`behaviour  ${desired.behaviourHash}`);
    say(`desired    ${desired.desiredHash}`);
    if (!desired.ready) say(`NOT READY — unresolved provider references: ${desired.unresolved.join(", ")}`);
    say("");
    say(`provisioning diff: ${diff.summary}`);
    for (const a of diff.actions) say(`  ${a.action.padEnd(20)} ${a.key}   ${a.reason}`);

    const plans = await platform.planAuthority.listPlans(clientId);
    say("", `plans: ${plans.plans.length}`);
    for (const p of plans.plans) say(`  ${p.planId}  ${p.status.padEnd(11)} v${p.configVersion}  ${p.mutatingCount} mutation(s)`);

    const unresolved = await platform.executor.claims.findUnresolved(clientId);
    if (unresolved.blocking) {
      say("", "BLOCKED — unresolved execution state:");
      for (const a of unresolved.actions) say(`  ${a.actionKey}  ${a.status}  ${a.providerResourceId || ""}`);
      for (const u of unresolved.unrecorded) {
        say(`  !! ${u.actionKey} EXISTS at the provider as ${u.providerResourceId} and was never recorded.`);
      }
    }

    const openPlan = plans.plans.filter((p) => ["draft", "validated", "approved"].includes(p.status)).slice(-1)[0] || null;
    const fullPlan = openPlan ? (await platform.planAuthority.getPlan(clientId, openPlan.planId)).plan : null;
    const readiness = assessClientReadiness({
      clientId,
      activeConfig: { configVersion: version.metadata.configVersion },
      plan: fullPlan,
      planStaleness: fullPlan
        ? describeStaleness(fullPlan, { configVersion: version.metadata.configVersion, configContentHash: version.metadata.contentHash ?? null })
        : null,
      desiredState: desired,
      currentResources: current,
    });
    say("", `readiness: ready=${readiness.ready} (${readiness.summary})`);
    return done(0);
  }

  // ── plan ──
  if (command === "plan") {
    const desired = platform.desiredStateCompiler(version);
    const current = await platform.registry.listForClient(clientId);
    const diff = diffProvisioning({ desired, current });
    if (!diff.ok) { say(`cannot plan: ${diff.message}`); return done(1); }

    const created = await platform.planAuthority.createPlan({
      clientId, diff, configContentHash: version.metadata.contentHash ?? null, createdBy: actor,
    });
    if (!created.ok) { say(`cannot plan: ${created.message}`); return done(1); }
    say(`${created.plan.planId} created as ${created.plan.status}`);
    say(`plan hash  ${created.plan.planHash}`);
    say(`actions    ${diff.summary}`);
    for (const a of created.plan.actions) say(`  ${a.action.padEnd(20)} ${a.key}`);
    say("", "Validate and approve it before anything can run. Approving is not executing.");
    return done(0);
  }

  // ── execute ──
  if (command === "execute") {
    if (flags["--fake-provider"] !== true) {
      say("REFUSED: execute requires --fake-provider.",
        "This build has no real provider adapter, and the flag is an acknowledgement of what the run is.");
      return done(1);
    }
    if (!platform.fakeProviderAdapter) {
      say("REFUSED: no fake provider adapter was supplied to the CLI.",
        "The executor never constructs one; it must be handed in.");
      return done(1);
    }

    const plans = await platform.planAuthority.listPlans(clientId);
    const approved = plans.plans.filter((p) => p.status === "approved").slice(-1)[0];
    if (!approved) { say(`${clientId} has no approved provisioning plan.`); return done(1); }

    // The one place an execution principal is built, deliberately.
    const principal = executionPrincipal({ clientId, actorId: actor });
    const result = await platform.executor.execute({
      principal, clientId, planId: approved.planId,
      providerAdapter: platform.fakeProviderAdapter,
    });

    if (!result.ok && result.blockers) {
      say(`REFUSED before contacting anything (${result.blockerCount} gate(s) failed):`);
      for (const b of result.blockers) say(`  ${String(b.number).padStart(2)}. ${b.name}  — ${b.detail || b.code}`);
      return done(1);
    }

    say(`execution ${result.executionId}  status=${result.status}`);
    say(`provider   ${result.adapterName}  (fake=${result.usedFakeProvider})`);
    for (const r of result.results) {
      say(`  ${r.status.padEnd(38)} ${r.actionKey}  ${r.providerResourceId || ""}`);
      if (r.warning) say(`     !! ${r.warning}`);
    }
    if (result.summary) {
      for (const u of result.summary.unrecordedProviderResources) {
        say("", `!!!! ${u.actionKey}: ${u.warning}  id=${u.providerResourceId}`);
      }
      for (const a of result.summary.ambiguousActions) {
        say("", `!!!! ${a.actionKey}: ${a.warning}  (${a.ambiguityReason})`);
      }
      say("", `next: ${result.summary.nextStep}`);
    }
    say("", result.note);
    return done(result.ok ? 0 : 1);
  }

  // ── reconcile ──
  if (command === "reconcile") {
    if (flags["--fake-provider"] !== true) {
      say("REFUSED: reconcile requires --fake-provider.",
        "Provider observation has no live implementation; only injected observations exist.");
      return done(1);
    }
    let observations = platform.observations || {};
    if (typeof flags["--observations"] === "string") {
      try {
        observations = JSON.parse(flags["--observations"]);
      } catch (error) {
        say(`--observations is not valid JSON: ${error.message}`);
        return done(1);
      }
    }

    const registry = await platform.registry.listForClient(clientId);
    const actions = await platform.executor.claims.listActions(clientId);
    const desired = version ? platform.desiredStateCompiler(version) : null;

    const reconciliation = reconcileClient({ clientId, registry, actions, desired, observations });
    const repair = buildRepairPlan(reconciliation, { desired });

    say(`${clientId} — reconciliation against ${Object.keys(observations).length} observation(s)`);
    say(`in sync: ${reconciliation.inSync}   needing attention: ${reconciliation.needsAttention}`);
    for (const r of reconciliation.results) {
      say(`  ${r.result.padEnd(30)} ${r.key}`);
      say(`     ${r.subreason}: ${r.detail}`);
    }
    say("", `repair recommendations (${repair.recommendations.length}) — NONE of them execute:`);
    for (const rec of repair.recommendations) {
      say(`  ${rec.action.padEnd(34)} ${rec.key}`);
      say(`     ${rec.why}`);
      if (rec.adoptionProof) {
        const failed = Object.entries(rec.adoptionProof).filter(([, v]) => !v).map(([k]) => k);
        if (failed.length) say(`     adoption proof FAILED on: ${failed.join(", ")}`);
      }
    }
    say("", reconciliation.note);
    return done(0);
  }

  /* istanbul ignore next — every command in COMMANDS is handled above */
  say(`"${command}" is listed but not implemented`);
  return done(1);
}

module.exports = { runProvisionCommand, parseArgs, COMMANDS, KNOWN_FLAGS, FORBIDDEN_FLAGS, USAGE };
