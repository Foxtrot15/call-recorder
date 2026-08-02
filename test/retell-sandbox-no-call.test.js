// AIDA — M7H: provision-only sandbox runs (--no-call).
//
// The sandbox runner could provision resources or keep them, but never both
// without also creating a call:
//
//   --execute --keep-resources           kept the resources AND created a
//                                        billable web call
//   --execute --browser --keep-resources created no call during provisioning,
//                                        but --browser ALWAYS cleaned up and
//                                        ignored --keep-resources entirely
//
// So an agent could not be created for the Retell dashboard — to bind a number
// to later — without spending a call to do it.
//
// NO TEST HERE CONTACTS RETELL. The mode resolver is pure, and the orchestration
// tests inject a recording fake adapter.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cfg = require("../src/config/retell-sandbox");
const sandbox = require("../src/services/retell-web-sandbox");

const SILENT = { log() {}, error() {} };
const NO_SLEEP = async () => {};

const SANDBOX_CONFIG = Object.freeze({ voiceId: "custom_voice_test", language: "en-AU", kbPollMs: 1, kbMaxWaitMs: 1000, timeoutMs: 1000 });

// ── The pure mode resolver ──────────────────────────────────────────

describe("run-mode resolution", () => {
  test("no flags is assessment, and creates nothing", () => {
    const m = cfg.evaluateRunMode({});
    assert.equal(m.ok, true);
    assert.equal(m.mode, "assess");
    assert.equal(m.createCall, false);
    assert.equal(m.startBrowser, false);
  });

  test("--execute alone keeps the original behaviour: one web call", () => {
    const m = cfg.evaluateRunMode({ execute: true });
    assert.equal(m.mode, "web_call");
    assert.equal(m.createCall, true, "default behaviour must be unchanged");
    assert.equal(m.startBrowser, false);
  });

  test("--execute --no-call provisions and creates NO call", () => {
    const m = cfg.evaluateRunMode({ execute: true, noCall: true });
    assert.equal(m.ok, true);
    assert.equal(m.mode, "provision");
    assert.equal(m.createCall, false);
    assert.equal(m.startBrowser, false, "and starts no browser harness either");
  });

  test("--execute --browser is unchanged", () => {
    const m = cfg.evaluateRunMode({ execute: true, browser: true });
    assert.equal(m.mode, "browser");
    assert.equal(m.createCall, false);
    assert.equal(m.startBrowser, true);
  });

  test("--no-call and --browser are mutually exclusive", () => {
    const m = cfg.evaluateRunMode({ execute: true, noCall: true, browser: true });
    assert.equal(m.ok, false);
    assert.equal(m.mode, null);
    assert.equal(m.createCall, false, "a refusal must not leave a call enabled");
    assert.equal(m.startBrowser, false);
    assert.match(m.errors.join(" "), /mutually exclusive/);
  });

  test("--no-call without --execute is refused", () => {
    const m = cfg.evaluateRunMode({ noCall: true });
    assert.equal(m.ok, false);
    assert.match(m.errors.join(" "), /only meaningful with --execute/);
  });

  test("--browser without --execute is refused", () => {
    assert.equal(cfg.evaluateRunMode({ browser: true }).ok, false);
  });

  test("every refusal fails closed — never a call, never a browser", () => {
    const contradictions = [
      { execute: true, noCall: true, browser: true },
      { noCall: true },
      { browser: true },
      { noCall: true, browser: true },
    ];
    for (const flags of contradictions) {
      const m = cfg.evaluateRunMode(flags);
      assert.equal(m.ok, false, JSON.stringify(flags));
      assert.equal(m.createCall, false);
      assert.equal(m.startBrowser, false);
    }
  });
});

// ── Orchestration ───────────────────────────────────────────────────

/** Records every operation, so "no call was created" is provable, not assumed. */
function recordingAdapter() {
  const calls = [];
  const api = {
    operations: calls,
    createKnowledgeBase: async () => { calls.push("createKnowledgeBase"); return ok({ id: "kb_fixture", status: "in_progress" }); },
    getKnowledgeBase: async () => { calls.push("getKnowledgeBase"); return ok({ id: "kb_fixture", status: "complete" }); },
    createResponseEngine: async () => { calls.push("createResponseEngine"); return ok({ id: "llm_fixture", version: 0 }); },
    createAgent: async () => { calls.push("createAgent"); return ok({ id: "agent_fixture", version: 0 }); },
    getAgent: async () => {
      calls.push("getAgent");
      return ok({ id: "agent_fixture", responseEngineId: "llm_fixture", responseEngineType: "retell-llm", voiceId: "custom_voice_test", language: "en-AU", webhookUrl: null });
    },
    createWebCall: async () => { calls.push("createWebCall"); return ok({ id: "call_fixture", agentId: "agent_fixture", callType: "web_call", status: "registered" }); },
    deleteKnowledgeBase: async () => { calls.push("deleteKnowledgeBase"); return ok({ id: "kb_fixture" }); },
    deleteResponseEngine: async () => { calls.push("deleteResponseEngine"); return ok({ id: "llm_fixture" }); },
    deleteAgent: async () => { calls.push("deleteAgent"); return ok({ id: "agent_fixture" }); },
  };
  return api;
}

function ok(resource) {
  return { ok: true, resource: Object.freeze(resource), providerRequestId: null, latencyMs: 0, mode: "mock", operation: "fixture" };
}

async function run({ createCall }) {
  const adapter = recordingAdapter();
  const result = await sandbox.runWebCallSandbox({
    adapter, config: SANDBOX_CONFIG, logger: SILENT, sleep: NO_SLEEP,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    createCall,
  });
  return { adapter, result };
}

describe("provision-only runs create no call", () => {
  test("createCall:false provisions all three resources", async () => {
    const { adapter, result } = await run({ createCall: false });
    assert.equal(result.ok, true, JSON.stringify(result.results));
    assert.equal(result.created.knowledgeBaseId, "kb_fixture");
    assert.equal(result.created.responseEngineId, "llm_fixture");
    assert.equal(result.created.agentId, "agent_fixture");
    assert.ok(adapter.operations.includes("createAgent"));
  });

  test("and NO call operation is ever invoked", async () => {
    const { adapter, result } = await run({ createCall: false });
    assert.equal(adapter.operations.includes("createWebCall"), false, "no web call may be created");
    assert.equal(adapter.operations.some((o) => /Call/i.test(o)), false, "no call operation of any kind");
    assert.equal(result.created.callId, null, "and no call id is recorded");
  });

  test("no access token is requested or emitted", async () => {
    const { result } = await run({ createCall: false });

    // A token only exists on a createWebCall result, which never happened.
    // Asserted on SUBSTANCE rather than on the string "access_token", which
    // legitimately appears in the proof-semantics prose describing what a web
    // call WOULD establish.
    assert.equal(typeof result.takeAccessToken, "undefined");
    assert.equal(result.created.callId, null);

    // And no token-shaped VALUE anywhere in the output.
    const json = JSON.stringify(result);
    assert.equal(/[A-Za-z0-9_\-.]{40,}/.test(json), false, "no token-like string may appear");
  });

  test("Proof A is correctly NOT claimed when no call was made", async () => {
    const withoutCall = await run({ createCall: false });
    const withCall = await run({ createCall: true });
    // The run must not report that it proved the create-web-call API when it
    // deliberately never called it.
    assert.equal(withoutCall.result.proofs.proofA_createWebCallApi.established, false);
    assert.equal(withCall.result.proofs.proofA_createWebCallApi.established, true);
  });

  test("the default path still creates one web call — unchanged", async () => {
    const { adapter, result } = await run({ createCall: true });
    assert.equal(adapter.operations.includes("createWebCall"), true);
    assert.equal(result.created.callId, "call_fixture");
  });
});

// ── Retention ───────────────────────────────────────────────────────

describe("retention still needs both signals", () => {
  test("keeping resources requires the env var AND the command-line flag", () => {
    const withEnv = { RETELL_SANDBOX_KEEP_RESOURCES: "true" };
    assert.equal(cfg.evaluateKeepResources(withEnv, { commandLineFlag: true }).keep, true);
    assert.equal(cfg.evaluateKeepResources(withEnv, { commandLineFlag: false }).keep, false);
    assert.equal(cfg.evaluateKeepResources({}, { commandLineFlag: true }).keep, false);
    assert.equal(cfg.evaluateKeepResources({}, { commandLineFlag: false }).keep, false);
  });

  test("--no-call does not weaken that gate", () => {
    // Provision-only and retention are independent decisions. Asking for no
    // call must not imply keeping paid resources alive.
    assert.equal(cfg.evaluateKeepResources({}, { commandLineFlag: true }).keep, false);
    assert.match(cfg.evaluateKeepResources({}, { commandLineFlag: true }).reason, /RETELL_SANDBOX_KEEP_RESOURCES/);
  });

  test("strict parse: only the exact string \"true\" keeps resources", () => {
    for (const v of ["TRUE", "True", "1", "yes", " true"]) {
      assert.equal(cfg.evaluateKeepResources({ RETELL_SANDBOX_KEEP_RESOURCES: v }, { commandLineFlag: true }).keep, false, `"${v}" must not keep resources`);
    }
  });
});

// ── The script wiring ───────────────────────────────────────────────

describe("the script uses the resolver rather than re-deriving the mode", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "retell-web-sandbox.js"), "utf8");

  test("createCall comes from the resolver", () => {
    assert.match(source, /createCall:\s*RUN_MODE\.createCall/);
    assert.equal(/createCall:\s*!WANT_BROWSER/.test(source), false, "the old re-derivation must be gone");
  });

  test("the browser harness is gated on the resolver too", () => {
    assert.match(source, /RUN_MODE\.startBrowser\s*&&/);
  });

  test("contradictory flags refuse before any gate is read", () => {
    const refusalAt = source.indexOf("Refusing to run — contradictory flags");
    const gateAt = source.indexOf("evaluateSandboxGate(process.env)");
    assert.ok(refusalAt > 0 && gateAt > 0);
    assert.ok(refusalAt < gateAt, "an incoherent command must never reach a provider gate");
  });

  test("the default invocation still contacts nothing", () => {
    // The execute branch is the only path to a provider request, and it is
    // still guarded by --execute alone.
    assert.match(source, /if \(!WANT_EXECUTE\)/);
    assert.match(source, /No provider request was made and nothing was charged/);
  });
});

// ── Existing guarantees ─────────────────────────────────────────────

describe("existing sandbox guarantees are intact", () => {
  test("the sandbox still binds no number and configures no webhook", () => {
    const agent = sandbox.buildSandboxAgentPayload({ llmId: "l", voiceId: "v", language: "en-AU", names: sandbox.sandboxNames("s") });
    assert.equal("webhook_url" in agent, false);
    assert.equal("webhook_events" in agent, false);
    assert.equal(/phone_number|inbound_agents/.test(JSON.stringify(agent)), false);
  });

  test("recording stays off", () => {
    const agent = sandbox.buildSandboxAgentPayload({ llmId: "l", voiceId: "v", language: "en-AU", names: sandbox.sandboxNames("s") });
    // The sandbox never enables recording; data storage is the strictest useful
    // value rather than "everything".
    assert.equal(agent.data_storage_setting, "everything_except_pii");
    assert.equal(/"recording[^"]*":\s*true/.test(JSON.stringify(agent)), false);
  });

  test("resource names are obviously disposable and within the provider limit", () => {
    const names = sandbox.sandboxNames("20260802-000000");
    for (const n of Object.values(names)) {
      assert.match(n, /^AIDA Sandbox /);
      assert.ok(n.length < 40, `${n} must fit the provider's 40-character limit`);
    }
  });
});
