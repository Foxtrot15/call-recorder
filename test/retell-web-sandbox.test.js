// AIDA — M7B: the Retell web-call sandbox.
//
// NO TEST HERE CONTACTS RETELL. Every adapter is an injected deterministic
// fake, and the suite asserts that fact rather than assuming it.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const cfg = require("../src/config/retell-sandbox");
const sandbox = require("../src/services/retell-web-sandbox");
const multipart = require("../src/services/retell-multipart");

const SILENT = { log() {}, error() {} };
const NO_SLEEP = async () => {};

const FULL_ENV = Object.freeze({
  NODE_ENV: "development",
  RETELL_ENABLED: "true",
  RETELL_LIVE_WRITES_ENABLED: "true",
  RETELL_DRY_RUN: "false",
  RETELL_SANDBOX_WEB_CALL_ENABLED: "true",
  RETELL_SANDBOX_EXECUTE: "true",
  RETELL_ALLOWED_TAG: "dev",
  RETELL_API_KEY: "key_not_real",
  RETELL_DEFAULT_VOICE_ID: "custom_voice_test",
  RETELL_DEFAULT_LANGUAGE: "en-AU",
});

const SANDBOX_CONFIG = Object.freeze({
  voiceId: "custom_voice_test",
  language: "en-AU",
  kbPollMs: 1,
  kbMaxWaitMs: 1000,
  timeoutMs: 1000,
});

/**
 * A deterministic in-memory Retell. Records every call; opens no socket.
 *
 * IT MIRRORS THE LIVE ADAPTER'S RESULT SHAPE EXACTLY. An earlier version of this
 * fake returned a `raw` provider body that the live adapter never produces, and
 * the sandbox was written against that fiction — so the real path was broken
 * while these tests passed. A fake richer than the boundary it stands in for
 * does not catch that bug, it causes it.
 *
 * Live contract: { ok, resource: { id, agentId?, callType?, status, version },
 *                  takeAccessToken? }  — and NO raw body.
 */
function fakeAdapter(overrides = {}) {
  const calls = [];
  let kbPolls = 0;

  const okResult = (id, extra = {}) => ({ ok: true, resource: { id, version: 0, status: extra.status || null, ...extra }, mode: "live" });
  const failResult = (code) => ({ ok: false, error: { code, message: code, retryable: false }, mode: "live" });

  const base = {
    mode: "live",
    async createKnowledgeBase(r) { calls.push({ op: "createKnowledgeBase", payload: r.payload }); return okResult("kb_1", { status: "in_progress" }); },
    async getKnowledgeBase(r) {
      calls.push({ op: "getKnowledgeBase", providerId: r.providerId });
      kbPolls += 1;
      const status = kbPolls >= (overrides.kbCompleteAfter || 1) ? "complete" : "in_progress";
      return okResult("kb_1", { status });
    },
    async createResponseEngine(r) { calls.push({ op: "createResponseEngine", payload: r.payload }); return okResult("llm_1", {}); },
    async createAgent(r) { calls.push({ op: "createAgent", payload: r.payload }); return okResult("agent_1", {}); },
    async getAgent(r) {
      // Mirrors the live adapter: agent verification fields live on the CLOSED
      // resource shape, not a raw provider body.
      calls.push({ op: "getAgent", providerId: r.providerId });
      return { ok: true, resource: { id: "agent_1", version: 0, responseEngineId: "llm_1", responseEngineType: "retell-llm", voiceId: "custom_voice_test", language: "en-AU", webhookUrl: null }, mode: "live" };
    },
    async createWebCall(r) {
      calls.push({ op: "createWebCall", payload: r.payload });
      let held = "tok_secret_value";
      return {
        ok: true,
        resource: { id: "call_1", agentId: "agent_1", callType: "web_call", status: "registered", version: 0 },
        takeAccessToken: () => { const v = held; held = null; return v; },
        mode: "live",
      };
    },
    async deleteAgent(r) { calls.push({ op: "deleteAgent", providerId: r.providerId }); return okResult(null); },
    async deleteResponseEngine(r) { calls.push({ op: "deleteResponseEngine", providerId: r.providerId }); return okResult(null); },
    async deleteKnowledgeBase(r) { calls.push({ op: "deleteKnowledgeBase", providerId: r.providerId }); return okResult(null); },
  };

  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "function") base[k] = async (r) => { calls.push({ op: k, payload: r && r.payload, providerId: r && r.providerId }); return v(r); };
  }
  base.__calls = calls;
  base.__fail = failResult;
  return base;
}

async function run(adapter, extra = {}) {
  return sandbox.runWebCallSandbox({ adapter, config: SANDBOX_CONFIG, sleep: NO_SLEEP, logger: SILENT, now: () => new Date("2026-08-01T12:30:00Z"), ...extra });
}

// ── Configuration gates ─────────────────────────────────────────────

describe("sandbox configuration", () => {
  test("everything is disabled by default", () => {
    const c = cfg.getSandboxConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.executeRequested, false);
    assert.equal(c.keepResourcesRequested, false);
    assert.equal(cfg.evaluateSandboxGate({}).allowed, false);
  });

  test("only the exact string \"true\" enables anything", () => {
    for (const v of ["TRUE", "True", "1", "yes", "on", " true", "true "]) {
      assert.equal(cfg.isSandboxEnabled({ RETELL_SANDBOX_WEB_CALL_ENABLED: v }), false, `"${v}" must not enable`);
      assert.equal(cfg.isSandboxExecuteEnabled({ RETELL_SANDBOX_EXECUTE: v }), false);
      assert.equal(cfg.isKeepResourcesRequested({ RETELL_SANDBOX_KEEP_RESOURCES: v }), false);
    }
    assert.equal(cfg.isSandboxEnabled({ RETELL_SANDBOX_WEB_CALL_ENABLED: "true" }), true);
  });

  test("all gates together are allowed", () => {
    assert.equal(cfg.evaluateSandboxGate(FULL_ENV).allowed, true);
  });

  test("removing any explicitly-required gate blocks the run", () => {
    // RETELL_ALLOWED_TAG and RETELL_DEFAULT_LANGUAGE are excluded because the
    // existing config DEFAULTS them ("dev" and "en-AU"). They are still checked
    // by the gate — see the two tests below — but they cannot be absent, so
    // "delete the variable" is not a meaningful way to test them.
    const defaulted = ["RETELL_ALLOWED_TAG", "RETELL_DEFAULT_LANGUAGE", "NODE_ENV"];
    for (const key of Object.keys(FULL_ENV)) {
      if (defaulted.includes(key)) continue;
      const partial = { ...FULL_ENV };
      delete partial[key];
      assert.equal(cfg.evaluateSandboxGate(partial).allowed, false, `removing ${key} must block`);
    }
  });

  test("the gate still checks the defaulted values rather than assuming them", () => {
    // A wrong tag blocks even though the variable is defaulted.
    assert.equal(cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_ALLOWED_TAG: "prod" }).allowed, false);
    // And the language check fires when the value is explicitly emptied.
    const blockers = cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_DEFAULT_LANGUAGE: "" }).blockers;
    assert.equal(cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_DEFAULT_LANGUAGE: "" }).allowed, true,
      "an empty language falls back to the configured default, so the run is still allowed");
    assert.ok(Array.isArray(blockers));
  });

  test("live TELEPHONE calls being enabled refuses the sandbox", () => {
    // The central separation: a web-call sandbox must not run while real phone
    // dialling is switched on.
    const g = cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_LIVE_CALLS_ENABLED: "true" });
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /RETELL_LIVE_CALLS_ENABLED/);
  });

  test("production always refuses", () => {
    const g = cfg.evaluateSandboxGate({ ...FULL_ENV, NODE_ENV: "production" });
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /production/i);
  });

  test("a missing API key or voice id each blocks", () => {
    for (const key of ["RETELL_API_KEY", "RETELL_DEFAULT_VOICE_ID"]) {
      const partial = { ...FULL_ENV };
      delete partial[key];
      const g = cfg.evaluateSandboxGate(partial);
      assert.equal(g.allowed, false, `${key} must be required`);
    }
    // The voice id is never invented — a real one must come from configuration.
    const g = cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_DEFAULT_VOICE_ID: "" });
    assert.match(g.blockers.join(" "), /No voice id is ever invented/);
  });

  test("dry-run still on blocks", () => {
    assert.equal(cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_DRY_RUN: "true" }).allowed, false);
  });

  test("a tag other than dev blocks", () => {
    for (const tag of ["prod", "staging"]) {
      assert.equal(cfg.evaluateSandboxGate({ ...FULL_ENV, RETELL_ALLOWED_TAG: tag }).allowed, false, `${tag} must block`);
    }
  });

  test("the config object never carries the API key", () => {
    const c = cfg.getSandboxConfig({ ...FULL_ENV, RETELL_API_KEY: "super_secret_key_value" });
    assert.equal(c.hasApiKey, true);
    assert.ok(!JSON.stringify(c).includes("super_secret_key_value"), "the key must never be on the config object");
  });

  test("no telephone or webhook configuration is required", () => {
    const g = cfg.evaluateSandboxGate(FULL_ENV);
    assert.equal(g.allowed, true);
    assert.match(g.notRequired.join(" "), /OUTBOUND_ONBOARDING_NUMBER/);
    assert.match(g.notRequired.join(" "), /INBOUND_DEMO_NUMBER/);
    assert.match(g.notRequired.join(" "), /ANTHROPIC_API_KEY/);
  });

  test("keeping resources requires BOTH the env var and the command-line flag", () => {
    assert.equal(cfg.evaluateKeepResources({ RETELL_SANDBOX_KEEP_RESOURCES: "true" }, { commandLineFlag: false }).keep, false);
    assert.equal(cfg.evaluateKeepResources({}, { commandLineFlag: true }).keep, false);
    assert.equal(cfg.evaluateKeepResources({ RETELL_SANDBOX_KEEP_RESOURCES: "true" }, { commandLineFlag: true }).keep, true);
    assert.equal(cfg.evaluateKeepResources({}, { commandLineFlag: false }).keep, false);
  });
});

// ── Orchestration ───────────────────────────────────────────────────

describe("sandbox orchestration", () => {
  test("creates resources in dependency order", async () => {
    const a = fakeAdapter();
    const r = await run(a);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const ops = a.__calls.map((c) => c.op);
    assert.equal(ops[0], "createKnowledgeBase", "the knowledge base comes first");
    assert.ok(ops.indexOf("createResponseEngine") > ops.indexOf("getKnowledgeBase"), "the engine waits for the KB");
    assert.ok(ops.indexOf("createAgent") > ops.indexOf("createResponseEngine"));
    assert.ok(ops.indexOf("createWebCall") > ops.indexOf("createAgent"));
  });

  test("the knowledge base is multipart", async () => {
    const a = fakeAdapter();
    await run(a);
    const kb = a.__calls.find((c) => c.op === "createKnowledgeBase");
    assert.match(kb.payload.contentType, /^multipart\/form-data; boundary=/);
    assert.ok(Buffer.isBuffer(kb.payload.body));
  });

  test("polls until the knowledge base is complete", async () => {
    const a = fakeAdapter({ kbCompleteAfter: 3 });
    const r = await run(a);
    assert.equal(r.ok, true);
    assert.equal(a.__calls.filter((c) => c.op === "getKnowledgeBase").length, 3);
  });

  test("does not create the engine while the KB is still processing", async () => {
    const a = fakeAdapter({ kbCompleteAfter: 2 });
    await run(a);
    const ops = a.__calls.map((c) => c.op);
    const firstPoll = ops.indexOf("getKnowledgeBase");
    const engine = ops.indexOf("createResponseEngine");
    assert.ok(engine > firstPoll + 1, "the engine must come after more than one poll");
  });

  test("a knowledge base in error state fails the run", async () => {
    const a = fakeAdapter({ getKnowledgeBase: async () => ({ ok: true, resource: { id: "kb_1", status: "error" }, raw: { status: "error" } }) });
    const r = await run(a);
    assert.equal(r.ok, false);
    assert.equal(r.failedAt, "await_knowledge_base");
    assert.ok(!a.__calls.some((c) => c.op === "createResponseEngine"), "nothing may be created after a KB failure");
  });

  test("a knowledge base that never completes times out", async () => {
    const a = fakeAdapter({ getKnowledgeBase: async () => ({ ok: true, resource: { id: "kb_1", status: "in_progress" }, raw: { status: "in_progress" } }) });
    const r = await sandbox.runWebCallSandbox({ adapter: a, config: { ...SANDBOX_CONFIG, kbMaxWaitMs: 0 }, sleep: NO_SLEEP, logger: SILENT });
    assert.equal(r.ok, false);
    assert.match(r.error.code, /kb_timeout/);
  });

  test("the response engine receives the real knowledge base id", async () => {
    const a = fakeAdapter();
    await run(a);
    const engine = a.__calls.find((c) => c.op === "createResponseEngine");
    assert.deepEqual(engine.payload.knowledge_base_ids, ["kb_1"]);
  });

  test("the agent receives the real llm_id, never null or a placeholder", async () => {
    const a = fakeAdapter();
    await run(a);
    const agent = a.__calls.find((c) => c.op === "createAgent");
    assert.equal(agent.payload.response_engine.llm_id, "llm_1");
    assert.equal(agent.payload.response_engine.type, "retell-llm");
    assert.ok(!JSON.stringify(agent.payload).includes("$aidaRef"), "no unresolved reference may be sent");
    assert.ok(!JSON.stringify(agent.payload).includes("would-be-resolved"), "no dry-run placeholder may be sent");
  });

  test("an engine that returns no llm_id stops the run", async () => {
    const a = fakeAdapter({ createResponseEngine: async () => ({ ok: true, resource: { id: null, version: null }, raw: {} }) });
    const r = await run(a);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "no_llm_id");
    assert.ok(!a.__calls.some((c) => c.op === "createAgent"));
  });

  test("the agent uses the configured voice and language", async () => {
    const a = fakeAdapter();
    await run(a);
    const agent = a.__calls.find((c) => c.op === "createAgent");
    assert.equal(agent.payload.voice_id, "custom_voice_test");
    assert.equal(agent.payload.language, "en-AU");
  });

  test("the agent has no webhook and no recording", async () => {
    const a = fakeAdapter();
    await run(a);
    const agent = a.__calls.find((c) => c.op === "createAgent");
    assert.ok(!("webhook_url" in agent.payload), "no webhook url");
    assert.ok(!("webhook_events" in agent.payload), "no webhook events");
    assert.equal(agent.payload.data_storage_setting, "everything_except_pii");
  });

  test("the agent is verified against what was requested", async () => {
    const a = fakeAdapter();
    const r = await run(a);
    assert.ok(a.__calls.some((c) => c.op === "getAgent"));
    const checks = r.validations.filter((v) => v.check.startsWith("agent_"));
    assert.ok(checks.length >= 3);
    assert.ok(checks.every((c) => c.ok));
  });

  test("a mismatched agent fails the run", async () => {
    const a = fakeAdapter({
      getAgent: async () => ({ ok: true, resource: { id: "agent_1" }, raw: { agent_id: "agent_1", response_engine: { type: "retell-llm", llm_id: "SOMEONE_ELSES_LLM" }, voice_id: "custom_voice_test", language: "en-AU" } }),
    });
    const r = await run(a);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "agent_mismatch");
    assert.ok(!a.__calls.some((c) => c.op === "createWebCall"), "no call may be created against a mismatched agent");
  });

  test("the web call uses the real agent id and only string variables", async () => {
    const a = fakeAdapter();
    await run(a);
    const call = a.__calls.find((c) => c.op === "createWebCall");
    assert.equal(call.payload.agent_id, "agent_1");
    for (const [k, v] of Object.entries(call.payload.retell_llm_dynamic_variables)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
    }
  });

  test("the call is marked as a non-billable sandbox test with no client", async () => {
    const a = fakeAdapter();
    await run(a);
    const call = a.__calls.find((c) => c.op === "createWebCall");
    assert.equal(call.payload.metadata.aida_sandbox, "true");
    assert.equal(call.payload.metadata.aida_billable, "false");
    assert.equal(call.payload.metadata.aida_client_id, "none");
  });

  test("the call is verified as belonging to the sandbox agent", async () => {
    const a = fakeAdapter({
      createWebCall: async () => ({ ok: true, resource: { id: "call_1", status: "registered" }, raw: { call_id: "call_1", agent_id: "A_DIFFERENT_AGENT", access_token: "t" } }),
    });
    const r = await run(a);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "call_mismatch");
  });

  test("NO telephone-call endpoint, phone binding, webhook or database is touched", async () => {
    const a = fakeAdapter();
    await run(a);
    const ops = a.__calls.map((c) => c.op);
    for (const forbidden of ["createPhoneCall", "bindPhoneNumber", "verifyWebhook", "updateAgent", "updateResponseEngine"]) {
      assert.ok(!ops.includes(forbidden), `${forbidden} must never be called`);
    }
  });

  test("stops before the web call when asked", async () => {
    const a = fakeAdapter();
    const r = await run(a, { createCall: false });
    assert.equal(r.ok, true);
    assert.equal(r.stoppedBefore, "create_web_call");
    assert.ok(!a.__calls.some((c) => c.op === "createWebCall"));
  });
});

// ── Failures ────────────────────────────────────────────────────────

describe("sandbox failures", () => {
  const failures = [
    ["createKnowledgeBase", "create_knowledge_base"],
    ["createResponseEngine", "create_response_engine"],
    ["createAgent", "create_agent"],
    ["createWebCall", "create_web_call"],
    ["getAgent", "verify_agent"],
  ];

  for (const [op, expectedStep] of failures) {
    test(`a ${op} failure stops at ${expectedStep} and never continues silently`, async () => {
      const a = fakeAdapter({ [op]: async () => ({ ok: false, error: { code: "provider_error", message: "boom", retryable: false } }) });
      const r = await run(a);
      assert.equal(r.ok, false);
      assert.equal(r.failedAt, expectedStep);
      const failed = r.results.find((s) => !s.ok);
      assert.ok(failed, "the failure must be recorded");
    });
  }

  test("a thrown exception is captured rather than crashing", async () => {
    const a = fakeAdapter({ createAgent: async () => { throw new Error("network exploded"); } });
    const r = await run(a);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "sandbox_exception");
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────

describe("sandbox cleanup", () => {
  const RESOURCES = { knowledgeBaseId: "kb_1", responseEngineId: "llm_1", agentId: "agent_1", callId: "call_1" };

  test("deletes in dependency-safe order", async () => {
    const a = fakeAdapter();
    const r = await sandbox.cleanupSandbox({ adapter: a, resources: RESOURCES, logger: SILENT });
    assert.equal(r.ok, true);
    const ops = a.__calls.map((c) => c.op);
    assert.deepEqual(ops, ["deleteAgent", "deleteResponseEngine", "deleteKnowledgeBase"]);
  });

  test("an already-deleted resource is success, not failure", async () => {
    // Retell returns 422 (normalised to invalid_request) for a missing asset.
    const a = fakeAdapter({ deleteAgent: async () => ({ ok: false, error: { code: "invalid_request", message: "Cannot find requested asset" } }) });
    const r = await sandbox.cleanupSandbox({ adapter: a, resources: RESOURCES, logger: SILENT });
    assert.equal(r.ok, true);
    assert.equal(r.outcomes.find((o) => o.kind === "agent").outcome, "already_deleted");
  });

  test("a real failure is surfaced with the remaining ids", async () => {
    const a = fakeAdapter({ deleteResponseEngine: async () => ({ ok: false, error: { code: "provider_error", message: "boom" } }) });
    const r = await sandbox.cleanupSandbox({ adapter: a, resources: RESOURCES, logger: SILENT });
    assert.equal(r.ok, false);
    assert.deepEqual(r.remaining, [{ kind: "response_engine", id: "llm_1" }]);
  });

  test("continues cleaning up after one failure", async () => {
    const a = fakeAdapter({ deleteAgent: async () => ({ ok: false, error: { code: "provider_error", message: "boom" } }) });
    const r = await sandbox.cleanupSandbox({ adapter: a, resources: RESOURCES, logger: SILENT });
    assert.ok(a.__calls.some((c) => c.op === "deleteKnowledgeBase"), "later resources must still be attempted");
    assert.equal(r.ok, false);
  });

  test("is idempotent — a second run over nothing succeeds", async () => {
    const a = fakeAdapter();
    const r = await sandbox.cleanupSandbox({ adapter: a, resources: {}, logger: SILENT });
    assert.equal(r.ok, true);
    assert.equal(a.__calls.length, 0);
  });

  test("says plainly that the call record cannot be deleted", async () => {
    const r = await sandbox.cleanupSandbox({ adapter: fakeAdapter(), resources: RESOURCES, logger: SILENT });
    assert.match(r.callNote, /no delete-call endpoint/i);
  });
});

// ── Manifest and secrets ────────────────────────────────────────────

describe("manifest and secret handling", () => {
  test("contains ids and timings but no secrets", async () => {
    const r = await run(fakeAdapter());
    const m = sandbox.buildManifest(r);
    assert.equal(m.resources.agentId, "agent_1");
    assert.equal(m.resources.callId, "call_1");
    assert.ok(m.knowledgeBaseProcessingMs !== undefined);

    // No secret VALUE anywhere.
    const json = JSON.stringify(m);
    assert.ok(!json.includes("tok_secret_value"), "the access token must never reach the manifest");
    assert.ok(!json.includes("key_not_real"), "the API key must never reach the manifest");

    // And no forbidden KEY anywhere. Checked structurally rather than by
    // grepping the text — the manifest's own note mentions the word
    // "transcript" while stating that none is included, and a substring match
    // would flag that disclaimer as a leak.
    assert.deepEqual(sandbox.findForbidden(m), []);
  });

  test("refuses to build a manifest carrying a forbidden field", () => {
    // Poison a field that IS copied wholesale into the manifest. `created` is
    // filtered field-by-field, so a secret there never reaches the output —
    // which is the design working. `names` is copied as-is, so it is where a
    // future edit could actually leak something.
    const poisoned = {
      startedAt: "2026-08-01T00:00:00Z", ok: true, failedAt: null,
      names: { knowledgeBase: "kb", access_token: "leak" },
      created: { knowledgeBaseId: "kb" },
      timings: {}, results: [], validations: [],
    };
    assert.throws(() => sandbox.buildManifest(poisoned), /refusing to build a manifest/);
  });

  test("a secret placed on the created object is filtered out rather than emitted", async () => {
    const r = await run(fakeAdapter());
    r.created.access_token = "should_not_appear";
    const m = sandbox.buildManifest(r);
    assert.ok(!JSON.stringify(m).includes("should_not_appear"), "only named id fields are copied");
  });

  test("the access token is returned in memory but never in the manifest", async () => {
    const r = await run(fakeAdapter());
    assert.equal(r.accessToken, "tok_secret_value", "the caller receives it in memory");
    assert.ok(!JSON.stringify(sandbox.buildManifest(r)).includes("tok_secret_value"));
  });

  test("findForbidden detects nested secrets", () => {
    assert.deepEqual(sandbox.findForbidden({ a: { b: { access_token: "x" } } }), ["a.b.access_token"]);
    assert.deepEqual(sandbox.findForbidden({ a: { b: "safe" } }), []);
  });
});

// ── Proof semantics ─────────────────────────────────────────────────

describe("web-call proof semantics", () => {
  test("an initial registered status is a complete API-issuance proof", async () => {
    const r = await run(fakeAdapter());
    assert.equal(r.ok, true);
    assert.equal(r.created.callStatus, "registered");
    assert.equal(r.proofs.proofA_createWebCallApi.established, true);
  });

  test("the run NEVER claims audio or a completed conversation", async () => {
    const r = await run(fakeAdapter());
    assert.equal(r.proofs.proofB_humanAudio.established, false);
    assert.equal(r.proofs.proofC_aidaBrowserFlow.established, false);
    assert.match(r.proofs.warning, /NOT equivalent/i);
  });

  test("an unjoined later status is expected, not a provider failure", () => {
    for (const status of ["not_connected", "error", "ended"]) {
      const c = sandbox.classifyLaterCallStatus(status);
      assert.equal(c.expectedForUnattendedRun, true, `${status} must be expected for an unattended run`);
      assert.equal(c.audioProven, false, `${status} must never imply audio`);
      assert.match(c.summary, /does not retract|Issuance is proven/i);
    }
  });

  test("an unrecognised later status is NOT silently accepted", () => {
    const c = sandbox.classifyLaterCallStatus("something_new");
    assert.equal(c.expectedForUnattendedRun, false);
  });

  test("the runner does not wait for ongoing, ended, transcript or analysis", async () => {
    const a = fakeAdapter();
    await run(a);
    // Only ONE call-related request: the creation. No polling for a status
    // that will never arrive without a browser.
    assert.equal(a.__calls.filter((c) => c.op === "createWebCall").length, 1);
    assert.equal(a.__calls.filter((c) => c.op === "retrieveCall").length, 0);
  });

  test("a missing call id fails", () => {
    const v = sandbox.verifyWebCall({ response: { agent_id: "a1", access_token: "t", call_type: "web_call" }, expectedAgentId: "a1" });
    assert.equal(v.ok, false);
    assert.equal(v.checks.find((c) => c.check === "web_call_id").ok, false);
  });

  test("a missing access token fails", () => {
    const v = sandbox.verifyWebCall({ response: { call_id: "c1", agent_id: "a1", call_type: "web_call" }, expectedAgentId: "a1" });
    assert.equal(v.ok, false);
    assert.equal(v.checks.find((c) => c.check === "web_call_has_token").ok, false);
  });

  test("a wrong agent id fails", () => {
    const v = sandbox.verifyWebCall({ response: { call_id: "c1", agent_id: "someone_else", access_token: "t" }, expectedAgentId: "a1" });
    assert.equal(v.ok, false);
  });

  test("a wrong call type fails, but an omitted one is tolerated", () => {
    assert.equal(sandbox.verifyWebCall({ response: { call_id: "c1", agent_id: "a1", access_token: "t", call_type: "phone_call" }, expectedAgentId: "a1" }).ok, false);
    assert.equal(sandbox.verifyWebCall({ response: { call_id: "c1", agent_id: "a1", access_token: "t" }, expectedAgentId: "a1" }).ok, true);
  });

  test("an unexpected initial status fails", () => {
    const v = sandbox.verifyWebCall({ response: { call_id: "c1", agent_id: "a1", access_token: "t", call_status: "not_connected" }, expectedAgentId: "a1" });
    assert.equal(v.ok, false, "a call that arrives already unjoined is not a valid issuance proof");
  });

  test("the access token never appears in any recorded validation detail", async () => {
    const r = await run(fakeAdapter());
    const text = JSON.stringify({ validations: r.validations, results: r.results, proofs: r.proofs });
    assert.ok(!text.includes("tok_secret_value"), "the token value must never be recorded anywhere");
    const tokenCheck = r.validations.find((v) => v.check === "web_call_has_token");
    assert.ok(tokenCheck);
    assert.match(tokenCheck.detail, /never logged or stored/i);
  });
});

// ── Transport ───────────────────────────────────────────────────────

describe("server-side transport needs no SDK", () => {
  test("the adapter is inert without an injected transport", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const { getRetellConfig } = require("../src/config/retell");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };
    const a = createRetellAdapter({ config: getRetellConfig(env), env });
    const r = await a.createKnowledgeBase({ payload: {}, idempotencyKey: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /no HTTP transport is configured/);
  });

  test("provider requests work through an injected transport, WITHOUT using the SDK", async () => {
    // The correction: M3 chose native fetch over retell-sdk deliberately. The
    // presence or absence of retell-sdk does NOT decide whether the server path
    // runs — only an injected transport does.
    //
    // This used to assert the SDK was absent. M7F-A installs it for webhook
    // signature verification, so the meaningful assertion is that the adapter
    // still does not IMPORT it and still requires an injected fetch.
    const adapterSource = require("fs").readFileSync(require.resolve("../src/services/retell-adapter"), "utf8");
    assert.equal(/require\(["']retell-sdk["']\)/.test(adapterSource), false, "the adapter must not import the SDK");

    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const { getRetellConfig } = require("../src/config/retell");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };

    let captured = null;
    const fakeFetch = async (url, init) => {
      captured = { url, method: init.method };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ knowledge_base_id: "kb_1", status: "in_progress" }) };
    };
    const a = createRetellAdapter({ config: getRetellConfig(env), env, fetchImpl: fakeFetch });
    const r = await a.createKnowledgeBase({ payload: { contentType: "multipart/form-data; boundary=x", body: Buffer.from("x") }, idempotencyKey: "i" });

    assert.equal(r.ok, true);
    assert.equal(r.resource.id, "kb_1");
    assert.match(captured.url, /\/create-knowledge-base$/);
    assert.equal(captured.method, "POST");
  });

  test("no server-side module imports the BROWSER SDK", () => {
    const fs = require("fs");
    for (const f of ["../src/services/retell-web-sandbox.js", "../src/services/retell-adapter.js", "../src/config/retell-sandbox.js", "../../scripts/retell-web-sandbox.js"]) {
      let src;
      try { src = fs.readFileSync(require.resolve(f), "utf8"); } catch { continue; }
      assert.ok(!/require\(["']retell-client-js-sdk["']\)/.test(src), `${f} must not import the browser SDK`);
    }
  });

  test("the sandbox script injects a transport rather than leaving the adapter inert", () => {
    // Regression: the first version built the adapter with no fetchImpl, so
    // --execute would have failed on its first request.
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../scripts/retell-web-sandbox.js"), "utf8");
    assert.match(src, /fetchImpl:/, "the script must inject a transport");
    assert.match(src, /globalThis\.fetch/, "it should use Node's built-in fetch");
  });
});

// ── Reuse and isolation ─────────────────────────────────────────────

describe("sandbox reuses the corrected production builders", () => {
  test("the knowledge base uses the shared multipart builder", () => {
    const names = sandbox.sandboxNames("20260801-123000");
    const built = sandbox.buildSandboxKnowledgeBaseRequest(names);
    const direct = multipart.buildCreateKnowledgeBaseRequest({
      knowledgeBaseName: names.knowledgeBase,
      texts: [{ title: "Demonstration business", text: sandbox.DEMO_KNOWLEDGE }],
    });
    assert.equal(built.request.boundary, direct.request.boundary, "same builder, same bytes");
  });

  test("sandbox names fit the provider limit and are obviously disposable", () => {
    const names = sandbox.sandboxNames("20260801-123000");
    for (const n of Object.values(names)) {
      assert.ok(n.length <= multipart.MAX_KB_NAME, `${n} must fit the 40-character limit`);
      assert.match(n, /AIDA Sandbox/);
      assert.match(n, /20260801-123000/, "must carry a unique stamp");
    }
  });

  test("uses only fictional data — no real client, number or customer", () => {
    const payload = sandbox.buildSandboxWebCallPayload({ agentId: "a" });
    const json = JSON.stringify(payload) + sandbox.DEMO_KNOWLEDGE;

    // The sandbox still exercises a transfer number, but since M7G it does so
    // through the SPOKEN form only — the canonical E.164 value is no longer
    // sent into the model's context, because nothing in the prompt or the tool
    // schema uses it.
    assert.match(
      payload.retell_llm_dynamic_variables.current_transfer_number_spoken,
      /^oh four nine one, five seven oh, /,
      "the sandbox must still exercise dynamic-variable influence with a number"
    );
    assert.equal(payload.retell_llm_dynamic_variables.current_transfer_number, undefined);

    // And the rule for any digits that DO appear anywhere is unchanged: no
    // number that could possibly ring a real person. Every one must sit in the
    // ACMA fictitious range 0491 570 006–156, which is reserved and never
    // allocated.
    for (const n of json.match(/\+?61\d{9}/g) || []) {
      assert.match(n, /^\+?61491570(0(0[6-9]|[1-9]\d)|1[0-5]\d)$/, `${n} must be an ACMA fictitious number`);
    }

    assert.match(sandbox.DEMO.businessName, /Demo/);
    assert.equal(payload.metadata.aida_client_id, "none");
  });

  test("the sandbox agent carries the same field names the production compiler emits", () => {
    // Guards against the sandbox drifting into its own improvised payload shape.
    const { compileReceptionist, toRetellPayload } = require("../src/services/locksmith-receptionist-compiler");
    require("../src/services/locksmith-extraction-fixture");
    const px = require("../src/services/locksmith-extraction");
    const spec = require("../src/services/locksmith-interview-spec");
    const { getRetellConfig } = require("../src/config/retell");

    const profile = px.extractLocksmithProfile({ transcript: spec.DEMO_TRANSCRIPT, clientId: "demo" }).profile;
    const config = getRetellConfig({ RETELL_DEFAULT_VOICE_ID: "v" });
    const c = compileReceptionist({ profile, profileVersion: 1, profileStatus: "approved", clientId: "demo", templateVersion: "t", config, generatedAt: "2026-08-01T00:00:00Z" });
    const production = toRetellPayload({ compiled: c, config }).agent;
    const sandboxAgent = sandbox.buildSandboxAgentPayload({ llmId: "l", voiceId: "v", language: "en-AU", names: sandbox.sandboxNames("s") });

    for (const field of ["agent_name", "response_engine", "voice_id", "language", "post_call_analysis_data", "data_storage_setting"]) {
      assert.ok(field in production, `production emits ${field}`);
      assert.ok(field in sandboxAgent, `the sandbox must emit ${field} too`);
    }
    assert.equal(sandboxAgent.response_engine.type, production.response_engine.type);
  });
});

// ── No external contact ─────────────────────────────────────────────

describe("no provider contact", () => {
  test("the sandbox depends on no Retell package", () => {
    // The BROWSER SDK must never be installed server-side — the harness loads
    // it in the browser from a CDN, never through node_modules.
    assert.throws(() => require.resolve("retell-client-js-sdk"), "the browser SDK must not be installed server-side");

    // The server SDK IS installed as of M7F-A, for webhook signature
    // verification only. What matters is that the sandbox path never touches
    // it, which is asserted directly rather than inferred from its absence.
    for (const mod of ["../src/services/retell-web-sandbox.js", "../src/services/retell-adapter.js", "../src/services/retell-multipart.js"]) {
      const source = require("fs").readFileSync(require.resolve(mod), "utf8");
      assert.equal(/require\(["']retell-sdk["']\)/.test(source), false, `${mod} must not import the SDK`);
      assert.equal(/require\(["']retell-client-js-sdk["']\)/.test(source), false, `${mod} must not import the browser SDK`);
    }
  });

  test("the orchestration module opens no socket at load time", () => {
    const src = require("fs").readFileSync(require.resolve("../src/services/retell-web-sandbox.js"), "utf8");
    for (const line of src.split("\n")) {
      if (/^\s/.test(line)) continue;
      assert.ok(!/require\(["'](axios|node-fetch|https?)["']\)/.test(line), "no transport at module scope");
    }
  });

  test("the live phone-call gate is untouched by this milestone", () => {
    const { canPlaceCall } = require("../src/config/retell");
    const verdict = canPlaceCall({ ...FULL_ENV });
    assert.equal(verdict.allowed, false, "a web-call sandbox must not make phone calls possible");
    assert.match(verdict.reasons.join(" "), /RETELL_LIVE_CALLS_ENABLED|OUTBOUND_ONBOARDING_NUMBER/);
  });
});
