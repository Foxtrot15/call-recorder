// AIDA PLATFORM P27/P28 — reconciliation, repair, audit, the CLI, and the
// architecture ratchets.
//
// The rule underneath all of it:
//
//   NOTHING HERE TURNS A DISAGREEMENT INTO A PROVIDER MUTATION.
//
// Reconciliation produces knowledge. Repair produces recommendations. Both are
// pure, and a person decides.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const H = require("./helpers/provisioning-harness");
const { reconcileClient, buildRepairPlan, REPAIR_ACTIONS, SUBREASONS } = require("../src/platform/reconciliation-engine");
const { runProvisionCommand, FORBIDDEN_FLAGS, KNOWN_FLAGS, COMMANDS, USAGE } = require("../src/platform/provision-cli");
const { createFakeProviderAdapter } = require("../src/platform/provider-mutation-port");
const { EXECUTION_AUDIT_EVENTS } = require("../src/platform/execution-model");
const { garageDoorD } = require("../src/platform/fixtures/clients");

const ROOT = path.join(__dirname, "..");
const CID = "rolladoor_repairs";
const ENGINE = "receptionist_agent:response_engine";
const AGENT = "receptionist_agent:voice_agent";

const row = (resourceType, id, hash) => ({
  client_id: CID, provider: "retell", purpose: "receptionist_agent",
  resource_type: resourceType, provider_resource_id: id, payload_hash: hash,
  active: true, last_outcome: "definite_success",
  provider_metadata: { producedBy: "aida-client-platform", configVersion: 1 },
});

// ════════════════════════════════════════════════════════════════════
// P27 — THE RECONCILIATION ENGINE
// ════════════════════════════════════════════════════════════════════

describe("P27 reconciliation — six results, with sub-reasons", () => {
  it("MATCH when the registry and the provider agree", () => {
    const r = reconcileClient({
      clientId: CID,
      registry: [row("voice_agent", "prov_1", "a".repeat(64))],
      observations: { [AGENT]: { providerResourceId: "prov_1", payloadHash: "a".repeat(64) } },
    });
    assert.equal(r.results[0].result, "match");
    assert.equal(r.results[0].subreason, "registry_and_provider_agree");
    assert.equal(r.inSync, true);
  });

  it("MISSING_PROVIDER_RESOURCE when the registry has one and the provider does not", () => {
    const r = reconcileClient({
      clientId: CID,
      registry: [row("voice_agent", "prov_1", "a".repeat(64))],
      observations: { [AGENT]: null },
    });
    assert.equal(r.results[0].result, "missing_provider_resource");
    assert.equal(r.results[0].subreason, "provider_reports_absent");
  });

  it("UNKNOWN when the provider was not asked — never 'absent'", () => {
    const r = reconcileClient({
      clientId: CID,
      registry: [row("voice_agent", "prov_1", "a".repeat(64))],
      observations: {},
    });
    assert.equal(r.results[0].result, "unknown");
    assert.equal(r.results[0].subreason, "provider_unreachable");
    assert.match(SUBREASONS.provider_unreachable, /not the same as absent/);
  });

  it("DRIFT when both exist and the payload hashes differ", () => {
    const r = reconcileClient({
      clientId: CID,
      registry: [row("voice_agent", "prov_1", "a".repeat(64))],
      observations: { [AGENT]: { providerResourceId: "prov_1", payloadHash: "b".repeat(64) } },
    });
    assert.equal(r.results[0].result, "drift");
    assert.equal(r.results[0].subreason, "payload_hash_differs");
  });

  it("MANUAL_REVIEW_REQUIRED when the two sides name different resources", () => {
    const r = reconcileClient({
      clientId: CID,
      registry: [row("voice_agent", "prov_1", "a".repeat(64))],
      observations: { [AGENT]: { providerResourceId: "prov_other", payloadHash: "a".repeat(64) } },
    });
    assert.equal(r.results[0].result, "manual_review_required");
    assert.equal(r.results[0].subreason, "identity_differs");
  });

  it("UNRECORDED_PROVIDER_RESOURCE after a persist failure — 'it exists and we never wrote it down'", () => {
    const r = reconcileClient({
      clientId: CID, registry: [],
      actions: [{ executionId: "exec_1", actionKey: ENGINE, status: "persist_failed_after_provider_success", providerResourceId: "prov_orphan" }],
      observations: { [ENGINE]: { providerResourceId: "prov_orphan", payloadHash: "a".repeat(64) } },
    });
    assert.equal(r.results[0].result, "unrecorded_provider_resource");
    assert.equal(r.results[0].subreason, "never_recorded_but_exists");
    assert.match(r.results[0].detail, /never adopt automatically/);
  });

  it("distinguishes an ambiguous execution that DID and DID NOT create", () => {
    const actions = [{ executionId: "exec_1", actionKey: ENGINE, status: "unknown", providerResourceId: null }];
    const present = reconcileClient({ clientId: CID, registry: [], actions, observations: { [ENGINE]: { providerResourceId: "prov_x", payloadHash: "a".repeat(64) } } });
    const absent = reconcileClient({ clientId: CID, registry: [], actions, observations: { [ENGINE]: null } });
    const unseen = reconcileClient({ clientId: CID, registry: [], actions, observations: {} });

    assert.equal(present.results[0].subreason, "ambiguous_execution_confirmed_present");
    assert.equal(absent.results[0].subreason, "ambiguous_execution_confirmed_absent");
    assert.equal(unseen.results[0].subreason, "ambiguous_execution_unobserved");
    // Three genuinely different answers to three genuinely different situations.
    assert.equal(new Set([present.results[0].result, absent.results[0].result, unseen.results[0].result]).size, 3);
  });

  it("reports a resource the provider has that AIDA never heard of", () => {
    const r = reconcileClient({
      clientId: CID, registry: [], actions: [],
      observations: { [AGENT]: { providerResourceId: "prov_stranger", payloadHash: "z".repeat(64) } },
    });
    assert.equal(r.results[0].result, "unrecorded_provider_resource");
    assert.equal(r.results[0].subreason, "provider_has_extra");
  });

  it("contacts nothing, and says so", () => {
    const r = reconcileClient({ clientId: CID, registry: [], observations: {} });
    assert.equal(r.providerContacted, false);
    assert.match(r.note, /read-only/);
  });

  it("only reports resources belonging to this client", () => {
    const foreign = { ...row("voice_agent", "prov_1", "a".repeat(64)), client_id: "somebody_else" };
    const r = reconcileClient({ clientId: CID, registry: [foreign], observations: {} });
    assert.equal(r.results.length, 0, "another tenant's row must be invisible");
  });
});

// ════════════════════════════════════════════════════════════════════
// P27A — THE REPAIR PLAN
// ════════════════════════════════════════════════════════════════════

describe("P27A repair — recommendations, never actions", () => {
  const desiredWith = (hash) => ({
    ok: true,
    resources: [{ purpose: "receptionist_agent", resourceType: "response_engine", payloadHash: hash }],
  });

  it("executes nothing, adopts nothing, and says so at the top level", () => {
    const r = reconcileClient({ clientId: CID, registry: [row("voice_agent", "prov_1", "a".repeat(64))], observations: { [AGENT]: null } });
    const repair = buildRepairPlan(r);
    assert.equal(repair.executed, false);
    assert.equal(repair.automatic, false);
    assert.match(repair.note, /Nothing here adopts, creates, updates or deletes/);
    for (const rec of repair.recommendations) {
      assert.equal(rec.automatic, false);
      assert.equal(rec.requiresHuman, true);
    }
  });

  it("recommends adoption ONLY when every proof holds", () => {
    const hash = "a".repeat(64);
    const reconciliation = reconcileClient({
      clientId: CID, registry: [],
      actions: [{ executionId: "e1", actionKey: ENGINE, status: "unknown", providerResourceId: null }],
      observations: { [ENGINE]: { providerResourceId: "prov_x", payloadHash: hash } },
    });
    const good = buildRepairPlan(reconciliation, { desired: desiredWith(hash) });
    assert.equal(good.recommendations[0].action, "adopt_existing_resource");
    assert.ok(Object.values(good.recommendations[0].adoptionProof).every(Boolean));

    // Any single proof failing downgrades it to manual review.
    const wrongHash = buildRepairPlan(reconciliation, { desired: desiredWith("b".repeat(64)) });
    assert.equal(wrongHash.recommendations[0].action, "manual_review");
    const noDesired = buildRepairPlan(reconciliation, { desired: null });
    assert.equal(noDesired.recommendations[0].action, "manual_review");
  });

  it("refuses adoption when the observed id contradicts the one the execution claimed", () => {
    const hash = "a".repeat(64);
    const reconciliation = reconcileClient({
      clientId: CID, registry: [],
      actions: [{ executionId: "e1", actionKey: ENGINE, status: "persist_failed_after_provider_success", providerResourceId: "prov_we_made" }],
      observations: { [ENGINE]: { providerResourceId: "prov_something_else", payloadHash: hash } },
    });
    const repair = buildRepairPlan(reconciliation, { desired: desiredWith(hash) });
    assert.equal(repair.recommendations[0].action, "manual_review");
    assert.equal(repair.recommendations[0].adoptionProof.matchesClaimedId, false);
  });

  it("recommends a create only after CONFIRMED absence, and only as a recommendation", () => {
    const confirmed = buildRepairPlan(reconcileClient({
      clientId: CID, registry: [row("voice_agent", "prov_1", "a".repeat(64))], observations: { [AGENT]: null },
    }));
    const create = confirmed.recommendations.find((r) => r.action === "create_new_after_confirmed_missing");
    assert.ok(create);
    assert.equal(create.automatic, false);
    assert.match(create.note, /recommends that a person build and approve a new plan/);

    const unconfirmed = buildRepairPlan(reconcileClient({
      clientId: CID, registry: [row("voice_agent", "prov_1", "a".repeat(64))], observations: {},
    }));
    assert.ok(!unconfirmed.recommendations.some((r) => r.action === "create_new_after_confirmed_missing"));
  });

  it("recommends an UPDATE for drift, routed through a normal plan", () => {
    const repair = buildRepairPlan(reconcileClient({
      clientId: CID, registry: [row("voice_agent", "prov_1", "a".repeat(64))],
      observations: { [AGENT]: { providerResourceId: "prov_1", payloadHash: "b".repeat(64) } },
    }));
    const update = repair.recommendations.find((r) => r.action === "update_drift");
    assert.ok(update);
    assert.match(update.note, /reviewed like any other provider mutation/);
  });

  it("only ever recommends actions from the declared set", () => {
    const repair = buildRepairPlan(reconcileClient({
      clientId: CID,
      registry: [row("voice_agent", "prov_1", "a".repeat(64)), row("response_engine", "prov_2", "c".repeat(64))],
      observations: { [AGENT]: null, [ENGINE]: { providerResourceId: "prov_other", payloadHash: "c".repeat(64) } },
    }));
    for (const rec of repair.recommendations) {
      assert.ok(REPAIR_ACTIONS.includes(rec.action), `${rec.action} is not a declared repair action`);
    }
  });

  it("the engine and the repair generator are pure — no imports that could act", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "reconciliation-engine.js"), "utf8");
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./provisioning-model"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// P28C — THE AUDIT
// ════════════════════════════════════════════════════════════════════

describe("P28C audit — what happened, without what was said", () => {
  async function runWith(behaviours = {}) {
    const platform = H.buildPlatform();
    const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD());
    const adapter = createFakeProviderAdapter({ behaviours });
    const result = await platform.executor.execute({
      principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: adapter,
    });
    return { platform, result, events: await platform.audit.list(CID, { limit: 200 }) };
  }

  it("records the whole successful path", async () => {
    const { events } = await runWith();
    const types = events.map((e) => e.eventType);
    for (const expected of ["execution_requested", "execution_claimed", "provider_attempted", "provider_succeeded", "registry_recorded", "execution_completed"]) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
  });

  it("records a refusal, not just a success", async () => {
    const platform = H.buildPlatform();
    const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD());
    await platform.executor.execute({
      principal: principals.operator, clientId: CID, planId: plan.planId, providerAdapter: createFakeProviderAdapter({}),
    });
    const events = await platform.audit.list(CID, { limit: 200 });
    assert.ok(events.some((e) => e.eventType === "execution_refused"));
  });

  it("records an ambiguous provider result as its own event", async () => {
    const { events } = await runWith({ [ENGINE]: { outcome: "unknown", ambiguityReason: "timeout_after_request_sent" } });
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes("provider_unknown"));
    assert.ok(types.includes("manual_review_required"));
    assert.ok(!types.includes("provider_failed"), "an ambiguous result is not a failure");
  });

  it("records a persist failure as its own event", async () => {
    const platform = H.buildPlatform();
    const { plan, principals } = await H.readyToExecute(platform, CID, garageDoorD());
    platform.registry._failNextWrite("disk on fire");
    await platform.executor.execute({
      principal: principals.executor, clientId: CID, planId: plan.planId, providerAdapter: createFakeProviderAdapter({}),
    });
    const events = await platform.audit.list(CID, { limit: 200 });
    assert.ok(events.some((e) => e.eventType === "registry_persist_failed"));
  });

  it("declares every event type the executor emits", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provisioning-executor.js"), "utf8");
    const emitted = [...source.matchAll(/record\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(emitted.length >= 8, `expected several emitted events, found ${emitted.length}`);
    for (const e of new Set(emitted)) {
      assert.ok(EXECUTION_AUDIT_EVENTS.includes(e), `"${e}" is emitted but not declared`);
    }
  });

  it("logs NO payload, credential, prompt or transcript", async () => {
    const { events } = await runWith();
    const json = JSON.stringify(events);
    for (const forbidden of ["general_prompt", "begin_message", "api_key", "apiKey", "authorization", "Bearer", "Rolladoor Repairs Pty Ltd"]) {
      assert.ok(!json.includes(forbidden), `the audit leaked ${forbidden}`);
    }
  });

  it("keeps every metadata payload small and id-shaped", async () => {
    const { events } = await runWith();
    for (const e of events) {
      if (!e.metadata) continue;
      assert.ok(JSON.stringify(e.metadata).length <= 4096);
      for (const key of Object.keys(e.metadata)) {
        assert.ok(["executionId", "actionKey", "detail"].includes(key), `unexpected audit field "${key}"`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P28 — THE CLI
// ════════════════════════════════════════════════════════════════════

describe("P28 CLI — fake providers, and no flag that changes that", () => {
  async function platform({ behaviours = {} } = {}) {
    const p = H.buildPlatform({ environmentTag: "fake-env" });
    await H.activateConfig(p, CID, garageDoorD());
    p.fakeProviderAdapter = createFakeProviderAdapter({ behaviours, name: "cli-fake" });
    p.observations = {};
    return p;
  }
  const run = (argv, p) => runProvisionCommand({ argv, platform: p });
  const text = (r) => r.lines.join("\n");

  it("REFUSES --live, --retell, --force and --retry-unknown by name", async () => {
    const p = await platform();
    for (const [flag, why] of Object.entries(FORBIDDEN_FLAGS)) {
      const r = await run(["execute", CID, flag], p);
      assert.equal(r.exitCode, 1, `${flag} must be refused`);
      assert.ok(text(r).includes(`${flag} does not exist`), `${flag} must be named in the refusal`);
      assert.ok(text(r).includes(why.slice(0, 30)), `${flag} must explain why`);
    }
    assert.ok(Object.keys(FORBIDDEN_FLAGS).includes("--retry-unknown"));
  });

  it("declares none of the forbidden flags as known", () => {
    for (const flag of Object.keys(FORBIDDEN_FLAGS)) {
      assert.ok(!KNOWN_FLAGS.includes(flag), `${flag} must not be a known flag`);
    }
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const p = await platform();
    const r = await run(["execute", CID, "--yolo"], p);
    assert.equal(r.exitCode, 1);
    assert.ok(text(r).includes('unknown flag "--yolo"'));
  });

  it("REFUSES execute without --fake-provider", async () => {
    const p = await platform();
    const r = await run(["execute", CID], p);
    assert.equal(r.exitCode, 1);
    assert.match(text(r), /requires --fake-provider/);
    assert.equal(p.fakeProviderAdapter.calls.length, 0);
  });

  it("REFUSES reconcile without --fake-provider", async () => {
    const p = await platform();
    const r = await run(["reconcile", CID], p);
    assert.equal(r.exitCode, 1);
    assert.match(text(r), /requires --fake-provider/);
  });

  it("plans, then executes against the fake, and reports it was fake", async () => {
    const p = await platform();
    assert.equal((await run(["plan", CID], p)).exitCode, 0);
    const plans = await p.planAuthority.listPlans(CID);
    const planId = plans.plans[plans.plans.length - 1].planId;
    const full = (await p.planAuthority.getPlan(CID, planId)).plan;
    await p.planStore.replacePlan({ ...full, providerTag: "fake-env" });
    const active = await p.configService.getActive({ principal: H.principals(CID).operator, clientId: CID });
    const cfg = { configVersion: active.version.metadata.configVersion, behaviourHash: null, configContentHash: active.version.metadata.contentHash ?? null };
    await p.planAuthority.validatePlan({ clientId: CID, planId, currentConfig: cfg });
    await p.planAuthority.approvePlan({ clientId: CID, planId, approvedBy: "Peter Dang", currentConfig: cfg });

    const r = await run(["execute", CID, "--fake-provider"], p);
    assert.equal(r.exitCode, 0, text(r));
    assert.match(text(r), /fake=true/);
    assert.match(text(r), /completed/);
  });

  it("inspect shows the diff, the plans and the readiness view, and changes nothing", async () => {
    const p = await platform();
    const before = JSON.stringify(await p.registry.listForClient(CID));
    const r = await run(["inspect", CID], p);
    assert.equal(r.exitCode, 0, text(r));
    assert.match(text(r), /provisioning diff:/);
    assert.match(text(r), /readiness: ready=false/);
    assert.equal(JSON.stringify(await p.registry.listForClient(CID)), before);
  });

  it("inspect surfaces a blocking unresolved state loudly", async () => {
    const p = await platform({ behaviours: { [ENGINE]: { outcome: "unknown", ambiguityReason: "timeout_after_request_sent" } } });
    const plan = await H.approvePlan(p, CID);
    await p.executor.execute({
      principal: H.principals(CID).executor, clientId: CID, planId: plan.planId, providerAdapter: p.fakeProviderAdapter,
    });
    const r = await run(["inspect", CID], p);
    assert.match(text(r), /BLOCKED — unresolved execution state/);
  });

  it("reconcile prints recommendations and states that none of them execute", async () => {
    const p = await platform();
    p.observations = { [ENGINE]: { providerResourceId: "prov_stranger", payloadHash: "9".repeat(64) } };
    const r = await run(["reconcile", CID, "--fake-provider"], p);
    assert.equal(r.exitCode, 0, text(r));
    assert.match(text(r), /NONE of them execute/);
    assert.match(text(r), /unrecorded_provider_resource/);
  });

  it("has no execute-adjacent command hiding in the list", () => {
    assert.deepEqual([...COMMANDS].sort(), ["execute", "help", "inspect", "plan", "reconcile"]);
    assert.ok(!COMMANDS.includes("deploy"));
    assert.ok(!COMMANDS.includes("provision-live"));
    assert.match(USAGE, /There is no --live, no --retell, no --force and\s*\n?\s*no --retry-unknown/);
  });
});

// ════════════════════════════════════════════════════════════════════
// RATCHETS
// ════════════════════════════════════════════════════════════════════

describe("execution ratchets — nothing here can reach a provider", () => {
  const FILES = [
    "src/platform/execution-model.js",
    "src/platform/execution-preflight.js",
    "src/platform/execution-claim.js",
    "src/platform/provider-mutation-port.js",
    "src/platform/resource-registry-writer.js",
    "src/platform/provisioning-executor.js",
    "src/platform/reconciliation-engine.js",
    "src/platform/provision-cli.js",
    "scripts/provision.js",
  ];
  const TRANSPORT = [
    "@supabase/supabase-js", "twilio", "node-fetch", "axios", "undici", "got", "superagent",
    "retell-sdk", "retell-adapter", "voice-platform-port", "http", "https", "net", "tls",
  ];

  it("imports no transport, SDK or provider adapter", () => {
    for (const file of FILES) {
      const imports = [...fs.readFileSync(path.join(ROOT, file), "utf8")
        .matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      for (const bad of TRANSPORT) {
        assert.ok(!imports.some((i) => i === bad || i.endsWith(`/${bad}`) || i.includes(bad)),
          `${file} imports ${bad}`);
      }
    }
  });

  it("would CATCH a transport import if one were added", () => {
    for (const bad of [
      'const { createClient } = require("@supabase/supabase-js");',
      'const https = require("https");',
      'const Retell = require("retell-sdk");',
      'const fetch = require("node-fetch");',
    ]) {
      const imports = [...bad.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      assert.ok(TRANSPORT.some((t) => imports.some((i) => i === t || i.includes(t))), `would not catch: ${bad}`);
    }
  });

  it("calls no network global", () => {
    for (const file of FILES) {
      const code = fs.readFileSync(path.join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
      for (const g of ["fetch(", "XMLHttpRequest", "WebSocket(", ".request("]) {
        assert.ok(!code.includes(g), `${file} calls ${g}`);
      }
    }
  });

  it("NO environment variable can switch a fake into a real provider", () => {
    for (const file of FILES) {
      const code = fs.readFileSync(path.join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
      assert.ok(!code.includes("process.env"), `${file} reads process.env`);
    }
    // And nowhere in the repo is there a flag named like one.
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))]) {
      const source = fs.readFileSync(file, "utf8");
      for (const forbidden of ["PROVISIONING_LIVE", "PROVISIONING_ENABLED", "PROVIDER_LIVE", "RETELL_PROVISIONING"]) {
        assert.ok(!source.includes(forbidden), `${path.relative(ROOT, file)} mentions ${forbidden}`);
      }
    }
  });

  it("the executor never constructs a provider client — the adapter is handed in", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provisioning-executor.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/createFakeProviderAdapter|new\s+\w*Client|createClient/.test(code),
      "the executor must not build an adapter of any kind");
    assert.match(code, /providerAdapter/, "it takes one as an argument");
  });

  it("the only adapters that exist are marked isFake", () => {
    const { createFakeProviderAdapter: mk, createRefusingProviderAdapter } = require("../src/platform/provider-mutation-port");
    assert.equal(mk({}).isFake, true);
    assert.equal(createRefusingProviderAdapter().isFake, true);
    const port = require("../src/platform/provider-mutation-port");
    for (const [name, value] of Object.entries(port)) {
      if (typeof value !== "function" || !/^create.*Adapter$/.test(name)) continue;
      assert.equal(value({}).isFake, true, `${name} must produce a fake`);
    }
  });

  it("ACP3 is created and applied NOWHERE", () => {
    const sql = fs.readFileSync(path.join(ROOT, "supabase/sql/acp3_create_provisioning_executions.sql"), "utf8");
    assert.match(sql, /NOT APPLIED TO DEV/);
    assert.match(sql, /NOT APPLIED TO PRODUCTION/);
    assert.match(sql, /NOT APPLIED ANYWHERE/);

    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))]) {
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.ok(!code.includes("acp3_create_provisioning_executions"), `${path.relative(ROOT, file)} references it`);
    }
  });

  it("ACP3 alters no already-reviewed or applied table", () => {
    const statements = fs.readFileSync(path.join(ROOT, "supabase/sql/acp3_create_provisioning_executions.sql"), "utf8")
      .replace(/^--.*$/gm, "");
    for (const table of ["provider_resources", "provisioning_plans", "platform_config_versions", "platform_provisioning_plans"]) {
      assert.ok(!new RegExp(`alter table\\s+public\\.${table}`, "i").test(statements), `ACP3 alters ${table}`);
    }
    assert.ok(!/drop table/i.test(statements), "ACP3 drops nothing");
  });

  it("carries the no-second-agent index as a DATABASE partial unique index", () => {
    const sql = fs.readFileSync(path.join(ROOT, "supabase/sql/acp3_create_provisioning_executions.sql"), "utf8");
    assert.match(sql, /create unique index if not exists pae_one_unresolved_per_action[\s\S]{0,300}where status in \('claimed','provider_succeeded','unknown','persist_failed_after_provider_success'\)/);
    assert.match(sql, /create unique index if not exists pex_one_unresolved_per_client/);
  });

  it("no execution module exposes a function that could act outside its own contract", () => {
    const ACTING = /^(dial|send|post|deploy|publish|enable|disable|suppress|wash)([A-Z]|$)/;
    for (const name of ["execution-model", "execution-preflight", "execution-claim",
      "provider-mutation-port", "resource-registry-writer", "provisioning-executor",
      "reconciliation-engine", "provision-cli"]) {
      const module = require(`../src/platform/${name}`);
      for (const [exported, value] of Object.entries(module)) {
        if (typeof value !== "function") continue;
        assert.ok(!ACTING.test(exported), `${name} exports "${exported}"`);
      }
    }
    for (const bad of ["sendPayload", "deployAgent", "enableCalling", "dialOut"]) {
      assert.ok(ACTING.test(bad), `the check would not catch "${bad}"`);
    }
  });
});
