// AIDA — M7B: Retell provider contract conformance.
//
// Every assertion here is traceable to official documentation reviewed on
// 2026-08-01 (pages listed in docs/RETELL_INTEGRATION_SPEC.md). These tests
// exist because fixture tests cannot catch a wire-format mismatch: a mock
// accepts whatever shape it is handed, so four of the five contract bugs M7B
// found were invisible to a green suite.
//
// NO TEST HERE CONTACTS RETELL. Requests are built and captured; the transport
// is never invoked.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

require("../src/services/locksmith-extraction-fixture");
const profileExtraction = require("../src/services/locksmith-extraction");
const interviewSpec = require("../src/services/locksmith-interview-spec");
const { compileReceptionist, toRetellPayload } = require("../src/services/locksmith-receptionist-compiler");
const plans = require("../src/services/provisioning-plan");
const port = require("../src/services/voice-platform-port");
const multipart = require("../src/services/retell-multipart");
const dynamicVars = require("../src/services/retell-dynamic-variables");
const { getRetellConfig } = require("../src/config/retell");

const SILENT = { log() {}, error() {} };

function baseProfile() {
  const r = profileExtraction.extractLocksmithProfile({ transcript: interviewSpec.DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
  assert.ok(r.ok);
  return r.profile;
}

function compiled(env = {}) {
  const config = getRetellConfig({ RETELL_DEFAULT_VOICE_ID: "retell-Cimo", ...env });
  const c = compileReceptionist({
    profile: baseProfile(), profileVersion: 2, profileStatus: "approved",
    clientId: "demo-locksmith", templateVersion: config.receptionistTemplateVersion,
    config, generatedAt: "2026-08-01T00:00:00Z",
  });
  assert.ok(c.ok, "compile must succeed");
  return { compiled: c, payload: toRetellPayload({ compiled: c, config }), config };
}

function planFrom({ payload, compiled: c }, existingResources = []) {
  return plans.createPlan({
    clientId: "demo-locksmith", approvedProfileVersion: 2, profileStatus: "approved",
    provisioningReady: true, compiled: c, retellPayload: payload, existingResources,
    templateVersions: {}, createdAt: "2026-08-01T00:00:00Z",
  });
}

// ── Retell LLM (POST /create-retell-llm, application/json) ──────────

describe("Retell LLM contract", () => {
  test("sends the documented response-engine fields", () => {
    const { payload } = compiled();
    const e = payload.responseEngine;
    assert.equal(typeof e.general_prompt, "string");
    assert.ok(e.general_prompt.length > 0);
    assert.ok("begin_message" in e);
    assert.ok(Array.isArray(e.general_tools));
    assert.equal(typeof e.default_dynamic_variables, "object");
    assert.ok(Array.isArray(e.knowledge_base_ids), "the KB attaches to the LLM, not the agent");
  });

  test("every default dynamic variable is a string", () => {
    // Provider: "All values ... must be strings. Numbers, booleans, or other
    // data types are not supported."
    const { payload } = compiled();
    for (const [k, v] of Object.entries(payload.responseEngine.default_dynamic_variables)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
    }
  });

  test("the knowledge base is attached by reference, resolved at execution", () => {
    const { payload } = compiled();
    assert.ok(port.isRef(payload.responseEngine.knowledge_base_ids[0]));
  });

  test("the created llm_id is captured and reused", async () => {
    const c = compiled({ RETELL_INBOUND_DEMO_NUMBER: "+61491570156" });
    const plan = planFrom(c);
    const sent = [];
    const mock = port.createMockAdapter();
    const spy = { ...mock, mode: mock.mode };
    for (const op of ["createKnowledgeBase", "createResponseEngine", "createAgent", "bindPhoneNumber"]) {
      spy[op] = async (req) => { sent.push({ op, payload: req.payload }); return mock[op](req); };
    }
    const provisioned = [];
    const result = await plans.executePlan({ plan, adapter: spy, onResourceProvisioned: async (r) => provisioned.push(r), logger: SILENT });
    assert.equal(result.status, "completed");

    const engineId = provisioned.find((r) => r.resourceType === "response_engine").providerResourceId;
    assert.ok(engineId, "the llm_id must be captured on success");
    const agentSent = sent.find((s) => s.op === "createAgent");
    assert.equal(agentSent.payload.response_engine.llm_id, engineId, "the agent must receive the captured llm_id");
  });
});

// ── Agent (POST /create-agent) ──────────────────────────────────────

describe("agent contract", () => {
  test("response_engine carries the documented type and a resolvable llm_id", () => {
    const { payload } = compiled();
    assert.equal(payload.agent.response_engine.type, "retell-llm");
    assert.ok(port.isRef(payload.agent.response_engine.llm_id));
  });

  test("llm_id is NEVER null", () => {
    // Regression: it was hard-coded null with a comment claiming it would be
    // filled in later. Nothing filled it in.
    const { payload } = compiled();
    assert.notEqual(payload.agent.response_engine.llm_id, null);
  });

  test("voice_id is populated, because the provider requires it", () => {
    const { payload } = compiled();
    assert.equal(payload.agent.voice_id, "retell-Cimo");
  });

  test("post_call_analysis_data is on the AGENT, not the LLM", () => {
    const { payload } = compiled();
    assert.ok(Array.isArray(payload.agent.post_call_analysis_data));
    assert.ok(!("post_call_analysis_data" in payload.responseEngine));
  });

  test("analysis items use documented preset names and valid custom shapes", () => {
    const { payload } = compiled();
    const presets = payload.agent.post_call_analysis_data.filter((i) => i.type === "system-presets");
    for (const p of presets) {
      assert.ok(["call_summary", "call_successful", "user_sentiment"].includes(p.name), `${p.name} is not a documented preset`);
    }
    for (const item of payload.agent.post_call_analysis_data) {
      assert.ok(["system-presets", "string", "enum", "boolean", "number"].includes(item.type));
      assert.ok(typeof item.name === "string" && item.name.length > 0);
      if (item.type === "enum") assert.ok(Array.isArray(item.choices) && item.choices.length > 0);
    }
  });

  test("subscribes only to webhook events we handle", () => {
    const { payload } = compiled();
    const allowed = ["call_started", "call_ended", "call_analyzed", "transcript_updated", "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"];
    for (const e of payload.agent.webhook_events) assert.ok(allowed.includes(e), `${e} is not a documented event`);
  });

  test("data storage follows the client's approved privacy decision", () => {
    const { payload } = compiled();
    assert.ok(["everything", "everything_except_pii", "basic_attributes_only"].includes(payload.agent.data_storage_setting));
    // The demo business has not consented to recording, so the stricter setting
    // applies rather than a deployment-wide default.
    assert.equal(payload.agent.data_storage_setting, "everything_except_pii");
  });

  test("an unresolved llm_id fails before any request is sent", async () => {
    const c = compiled();
    const plan = planFrom(c);
    let agentCalled = false;
    const mock = port.createMockAdapter();
    const spy = { ...mock, mode: mock.mode, createAgent: async (r) => { agentCalled = true; return mock.createAgent(r); } };
    const skip = new Set(plan.actions.filter((a) => a.resourceType === "response_engine").map((a) => a.idempotencyKey));
    const result = await plans.executePlan({ plan, adapter: spy, alreadyDone: skip, logger: SILENT });
    assert.equal(agentCalled, false, "no agent request may be sent without a resolved llm_id");
    assert.ok(result.results.some((r) => (r.unresolvedRefs || []).includes("receptionist_agent:response_engine")));
  });

  test("a dry-run placeholder can never reach a live provider", async () => {
    const c = compiled();
    const plan = planFrom(c);
    // Force a placeholder into a non-dry-run execution.
    const poisoned = JSON.parse(JSON.stringify(plan));
    const agentAction = poisoned.actions.find((a) => a.resourceType === "voice_agent");
    agentAction.payload.response_engine.llm_id = `${port.DRY_RUN_REF_PLACEHOLDER}receptionist_agent:response_engine>`;

    let called = false;
    const mock = port.createMockAdapter();
    const spy = { ...mock, mode: mock.mode, createAgent: async (r) => { called = true; return mock.createAgent(r); } };
    const result = await plans.executePlan({ plan: poisoned, adapter: spy, logger: SILENT });
    assert.equal(called, false, "a placeholder must never be sent");
    assert.ok(result.results.some((r) => r.placeholderInLiveMode === true));
  });
});

// ── Knowledge base (multipart) ──────────────────────────────────────

describe("knowledge base contract", () => {
  test("is encoded as multipart/form-data, not JSON", () => {
    const r = multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "aida-demo-v2", texts: [{ title: "Business information", text: "We cover Brunswick." }] });
    assert.equal(r.ok, true);
    assert.match(r.request.contentType, /^multipart\/form-data; boundary=/);
    assert.equal(r.request.path, "/create-knowledge-base");
  });

  test("knowledge_base_texts is ONE field holding a JSON array", () => {
    // VERIFIED AGAINST THE LIVE PROVIDER, 2026-08-02.
    //
    // M7B sent indexed sub-fields (knowledge_base_texts[0][title]) — the
    // conventional multipart encoding for an array of objects. The live API
    // rejects that. Sending one item per repeated field returns the decisive
    // error {"status":"error","message":"not an array"}, proving the server
    // JSON-parses this field. A single JSON-encoded array returns 201.
    const r = multipart.buildCreateKnowledgeBaseRequest({
      knowledgeBaseName: "aida-demo-v2",
      texts: [{ title: "A", text: "one" }, { title: "B", text: "two" }],
    });

    assert.deepEqual(r.request.fieldNames, ["knowledge_base_name", "knowledge_base_texts"]);

    const body = r.request.body.toString("utf8");
    assert.match(body, /name="knowledge_base_texts"/);
    assert.ok(!/knowledge_base_texts\[\d\]/.test(body), "indexed sub-fields are rejected by the provider");

    // The field value must parse as an array of {title, text}.
    const value = body.split('name="knowledge_base_texts"')[1].split("\r\n\r\n")[1].split("\r\n--")[0];
    const parsed = JSON.parse(value);
    assert.ok(Array.isArray(parsed), "the provider requires an array");
    assert.deepEqual(parsed, [{ title: "A", text: "one" }, { title: "B", text: "two" }]);
  });

  test("the adapter puts the multipart bytes on the wire, not JSON", async () => {
    // VERIFIED AGAINST THE LIVE PROVIDER, 2026-08-02.
    //
    // buildRequest hard-coded `Content-Type: application/json` and
    // JSON.stringify(body), so a multipart request was stringified into a JSON
    // string and sent as JSON. The provider answered 400. The `contentType`
    // declared on each ENDPOINTS entry was decorative because nothing read it —
    // the multipart builder's work never reached the wire.
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };

    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, headers: init.headers, body: init.body };
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ knowledge_base_id: "kb_1", status: "in_progress" }) };
    };
    const adapter = createRetellAdapter({ config: getRetellConfig(env), env, fetchImpl });
    const built = multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "t", texts: [{ title: "A", text: "one" }] });

    await adapter.createKnowledgeBase({ payload: built.request, idempotencyKey: "i" });

    assert.match(captured.headers["Content-Type"], /^multipart\/form-data; boundary=/, "the multipart content type must survive");
    assert.ok(captured.headers["Content-Type"].includes(built.request.boundary), "the generated boundary must be sent");
    assert.ok(Buffer.isBuffer(captured.body), "the body must remain the encoded Buffer");
    assert.ok(!captured.headers["Content-Type"].startsWith("application/json"));
  });

  test("JSON endpoints are unaffected by the multipart branch", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = init;
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ llm_id: "llm_1" }) };
    };
    const adapter = createRetellAdapter({ config: getRetellConfig(env), env, fetchImpl });
    await adapter.createResponseEngine({ payload: { general_prompt: "x" }, idempotencyKey: "i" });

    assert.equal(captured.headers["Content-Type"], "application/json");
    assert.equal(typeof captured.body, "string");
    assert.deepEqual(JSON.parse(captured.body), { general_prompt: "x" });
  });

  test("a multipart endpoint refuses a payload that was not built by the multipart builder", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };
    const adapter = createRetellAdapter({ config: getRetellConfig(env), env, fetchImpl: async () => ({ ok: true, status: 201, headers: { get: () => null }, json: async () => ({}) }) });
    // A plain object would previously have been silently JSON-encoded.
    await assert.rejects(
      async () => adapter.createKnowledgeBase({ payload: { knowledge_base_name: "t" }, idempotencyKey: "i" }),
      /requires a multipart request/
    );
  });

  test("urls are also sent as a JSON array, not indexed fields", () => {
    const r = multipart.buildCreateKnowledgeBaseRequest({
      knowledgeBaseName: "aida-demo-v2",
      texts: [{ title: "A", text: "one" }],
      urls: ["https://example.com/a", "https://example.com/b"],
    });
    assert.ok(r.request.fieldNames.includes("knowledge_base_urls"));
    assert.ok(!r.request.fieldNames.some((f) => /knowledge_base_urls\[\d\]/.test(f)));
  });

  test("the encoding is deterministic", () => {
    const args = { knowledgeBaseName: "aida-demo-v2", texts: [{ title: "A", text: "one" }] };
    assert.equal(
      multipart.buildCreateKnowledgeBaseRequest(args).request.boundary,
      multipart.buildCreateKnowledgeBaseRequest(args).request.boundary
    );
  });

  test("the boundary appears only as a delimiter, never inside content", () => {
    const r = multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "n", texts: [{ title: "t", text: "x".repeat(500) }] });
    const body = r.request.body.toString("utf8");
    const occurrences = body.split(r.request.boundary).length - 1;
    // One opening delimiter per part, plus the closing delimiter. Any extra
    // would mean the boundary collided with content and truncated the request.
    assert.equal(occurrences, r.request.fieldNames.length + 1, "boundary must appear once per part plus the terminator");
    // And the content itself is intact.
    assert.ok(body.includes("x".repeat(500)), "the payload must survive encoding");
  });

  test("refuses a name over the provider's 40-character limit rather than truncating", () => {
    // Truncating would let two clients collide on the same name.
    const r = multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "x".repeat(40), texts: [{ title: "t", text: "b" }] });
    assert.equal(r.ok, false);
    assert.equal(r.code, "kb_name_too_long");
  });

  test("refuses an incomplete text item", () => {
    assert.equal(multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "n", texts: [{ title: "t" }] }).code, "kb_text_incomplete");
    assert.equal(multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "n", texts: [] }).code, "kb_empty");
  });

  test("the compiled KB name fits the provider limit", () => {
    const { payload } = compiled();
    assert.ok(payload.knowledge.knowledge_base_name.length <= multipart.MAX_KB_NAME);
  });

  test("processing is asynchronous and an incomplete KB is not usable", () => {
    assert.equal(multipart.assessKnowledgeBase("in_progress").usable, false);
    assert.equal(multipart.assessKnowledgeBase("in_progress").terminal, false);
    assert.equal(multipart.assessKnowledgeBase("complete").usable, true);
    assert.equal(multipart.assessKnowledgeBase("error").usable, false);
    assert.equal(multipart.assessKnowledgeBase("error").terminal, true);
    assert.equal(multipart.assessKnowledgeBase("refreshing_in_progress").usable, false);
    assert.equal(multipart.assessKnowledgeBase("nonsense").code, "unknown_status");
  });

  test("a changed knowledge base is replaced, because no update endpoint exists", () => {
    const c = compiled();
    const first = planFrom(c);
    const existing = first.actions.map((a) => ({
      purpose: a.purpose, resource_type: a.resourceType,
      provider_resource_id: `prov_${a.resourceType}`, payload_hash: "older", active: true,
    }));
    const second = planFrom(c, existing);
    const kb = second.actions.find((a) => a.resourceType === "knowledge_base");
    assert.equal(kb.kind, "create");
    assert.equal(kb.replacesProviderId, "prov_knowledge_base");
  });
});

// ── Phone binding (weighted agents) ─────────────────────────────────

describe("phone binding contract", () => {
  test("uses inbound_agents, never the deprecated single-id fields", () => {
    const { payload } = compiled({ RETELL_INBOUND_DEMO_NUMBER: "+61491570156" });
    const b = payload.inboundBinding;
    assert.ok(Array.isArray(b.inbound_agents));
    assert.ok(!("inbound_agent_id" in b));
    assert.ok(!("outbound_agent_id" in b));
  });

  test("a single agent takes the whole documented weight of 1", () => {
    const { payload } = compiled({ RETELL_INBOUND_DEMO_NUMBER: "+61491570156" });
    assert.equal(payload.inboundBinding.inbound_agents[0].weight, 1);
    assert.equal(plans.validateAgentWeights(payload.inboundBinding.inbound_agents.map((a) => ({ ...a, agent_id: "resolved" }))).ok, true);
  });

  test("weights must total exactly 1", () => {
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 0.5 }]).code, "weights_not_one");
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 0.6 }, { agent_id: "b", weight: 0.4 }]).ok, true);
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 0.6 }, { agent_id: "b", weight: 0.6 }]).code, "weights_not_one");
  });

  test("rejects an invalid weight, a missing agent id and a bad version", () => {
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 0 }]).code, "invalid_weight");
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 1.01 }]).code, "invalid_weight");
    assert.equal(plans.validateAgentWeights([{ weight: 1 }]).code, "missing_agent_id");
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 1, agent_version: { bad: true } }]).code, "invalid_version");
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 1, agent_version: 3 }]).ok, true);
    assert.equal(plans.validateAgentWeights([{ agent_id: "a", weight: 1, agent_version: "latest_published" }]).ok, true);
  });

  test("no binding is emitted when no number is configured", () => {
    const { payload } = compiled();
    assert.equal(payload.inboundBinding, null);
    assert.ok(!planFrom(compiled()).actions.some((a) => a.purpose === "inbound_binding"));
  });
});

// ── Dynamic variables ───────────────────────────────────────────────

describe("dynamic variable contract", () => {
  test("runtime-sensitive values are refused as provisioning-time defaults", () => {
    const r = dynamicVars.validateDynamicVariables({ current_transfer_number: "+61491570006" }, { scope: "default" });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /must be supplied per call/i);
  });

  test("the same values are accepted per call", () => {
    const r = dynamicVars.validateDynamicVariables({ current_transfer_number: "+61491570006" }, { scope: "per_call" });
    assert.equal(r.ok, true);
    assert.equal(r.variables.current_transfer_number, "+61491570006");
  });

  test("THE TRANSFER-NUMBER DESIGN DOES NOT DEPEND ON A DEFAULT VARIABLE", () => {
    // M3 kept transfer numbers out of compiled artefacts and resolved them "at
    // call time". The provider docs confirm an inbound call can only receive
    // per-call variables through the inbound webhook — so no transfer number
    // may be shipped as a default, and none is.
    const { payload } = compiled();
    const defaults = payload.responseEngine.default_dynamic_variables;
    assert.ok(!("current_transfer_number" in defaults), "a transfer number must never be baked into the agent");
    assert.ok(!("current_backup_number" in defaults));
    for (const value of Object.values(defaults)) {
      assert.ok(!/\+?61\d{9}/.test(value), "no phone number may appear in any default variable");
    }
  });

  test("no unresolved runtime sentinel is shipped as a default", () => {
    // The compiler declares runtime values as "{{runtime}}". An unsupplied
    // variable renders literally in the prompt, so shipping the sentinel would
    // read "{{runtime}}" aloud to a caller.
    const { payload } = compiled();
    assert.deepEqual(dynamicVars.findUnresolvedRuntimeValues(payload.responseEngine.default_dynamic_variables), []);
  });

  test("a key outside the allow-list is refused", () => {
    assert.equal(dynamicVars.validateDynamicVariables({ arbitrary_key: "x" }, { scope: "per_call" }).ok, false);
  });

  test("secrets, transcripts and prompts can never be sent", () => {
    for (const key of ["api_key", "secret_token", "raw_transcript", "system_prompt"]) {
      assert.equal(dynamicVars.validateDynamicVariables({ [key]: "x" }, { scope: "per_call" }).ok, false, `${key} must be refused`);
    }
  });

  test("non-string values are coerced, objects refused", () => {
    assert.equal(dynamicVars.buildInboundCallVariables({ businessStatus: "open" }).variables.current_business_status, "open");
    assert.equal(dynamicVars.validateDynamicVariables({ call_kind: { a: 1 } }, { scope: "per_call" }).ok, false);
  });

  test("the inbound webhook response matches the documented shape", () => {
    const r = dynamicVars.buildInboundWebhookResponse({
      variables: { current_transfer_number: "+61491570006" },
      metadata: { aida_call: "c1" },
    });
    assert.equal(r.ok, true);
    assert.ok(r.response.call_inbound, "the provider expects a call_inbound object");
    assert.equal(r.response.call_inbound.dynamic_variables.current_transfer_number, "+61491570006");
    assert.equal(r.response.call_inbound.metadata.aida_call, "c1");
    assert.equal(r.timeoutSeconds, 10, "the provider allows 10 seconds");
  });

  test("metadata is not injected into the prompt", () => {
    const r = dynamicVars.buildInboundWebhookResponse({ variables: {}, metadata: { internal_id: "x" } });
    assert.ok(!r.response.call_inbound.dynamic_variables, "metadata must not become a variable");
    assert.ok(r.response.call_inbound.metadata);
  });
});

// ── No external contact ─────────────────────────────────────────────

describe("no provider contact", () => {
  test("no live call is possible, whether or not a package is installed", async () => {
    // This asserted that retell-sdk was absent. M7F-A installs it deliberately
    // — for webhook signature verification only — so "the package is missing"
    // is no longer what keeps calls from happening, and a test that says
    // otherwise would be false comfort.
    //
    // The real invariant is structural and is asserted directly: the adapter
    // carries no transport unless one is injected, so constructing it in a test
    // cannot reach the network even with every flag set.
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const wideOpen = {
      NODE_ENV: "development", RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true",
      RETELL_LIVE_CALLS_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_ALLOWED_TAG: "dev",
      RETELL_API_KEY: "key_not_real", RETELL_DEFAULT_VOICE_ID: "voice_not_real",
      RETELL_OUTBOUND_ONBOARDING_NUMBER: "+61491570006",
    };
    const adapter = createRetellAdapter({ config: getRetellConfig(wideOpen), env: wideOpen, logger: { error() {} } });
    const result = await adapter.createPhoneCall({ payload: { to_number: "+61491570006" } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "provider_misconfigured");
    assert.match(result.error.message, /no HTTP transport/);

    // The browser SDK must never be installed server-side.
    assert.throws(() => require.resolve("retell-client-js-sdk"));
  });

  test("the shipped configuration cannot write to a provider", () => {
    const config = getRetellConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.liveWritesEnabled, false);
    const gate = plans.evaluateExecutionGate({
      plan: planFrom(compiled()), config, actor: { type: "client", clientId: "demo-locksmith" },
      currentApprovedVersion: 2, explicitRequest: true, capability: { allowed: false, reasons: [] },
    });
    assert.equal(gate.allowed, false);
  });

  test("the multipart and dynamic-variable builders make no network call", () => {
    // Both are pure: they load and run with no transport in scope at all.
    assert.ok(multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "n", texts: [{ title: "t", text: "b" }] }).ok);
    assert.ok(dynamicVars.buildInboundWebhookResponse({ variables: {} }).ok);
  });
});
