// AIDA — M7F-A: the secure Retell inbound-call webhook.
//
// NO TEST HERE CONTACTS RETELL. Signature verification is exercised two ways:
// through an injected fake verifier (so the suite still runs on a checkout with
// no node_modules, per the house rule), and — when the official SDK happens to
// be installed — through a REAL cryptographic round-trip using the SDK's own
// `sign`, which needs no network.
//
// The second kind is what M7D would have wanted: a fake verifier can only prove
// our plumbing, never that we hold the provider's contract correctly.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const inbound = require("../src/services/retell-inbound-call");
const { createInboundWebhookHandler, resolveFailureMode } = require("../src/routes/retell-inbound-webhook-handler");
const cfg = require("../src/config/retell");
const verifyModule = require("../src/services/retell-webhook-verify");
const dynamicVars = require("../src/services/retell-dynamic-variables");
const speech = require("../src/services/au-phone-speech");

const SILENT = { log() {}, error() {} };

// ACMA fictitious range only — 0491 570 006–156 can never reach a real person.
const CALLER = "+61491570110";
const TRANSFER = "+61491570006";
const AGENT_ID = "agent_fixture_inbound_0001";

const ENV = Object.freeze({
  NODE_ENV: "development",
  RETELL_ENABLED: "true",
  RETELL_WEBHOOK_ENABLED: "true",
  RETELL_INBOUND_WEBHOOK_ENABLED: "true",
  RETELL_API_KEY: "key_fixture_not_real",
  RETELL_WEBHOOK_BASE_URL: "https://aida-sandbox.example.com",
});

function inboundBody(overrides = {}) {
  return {
    event: "call_inbound",
    event_timestamp: 1785600000000,
    call_inbound: {
      agent_id: AGENT_ID,
      agent_version: 0,
      from_number: CALLER,
      to_number: "+61491570156",
      ...overrides,
    },
  };
}

const CONTEXT = Object.freeze({
  clientId: "demo-locksmith",
  transferPrimary: TRANSFER,
  transferBackup: "+61390000000",
  businessStatus: "open",
  onCallState: "primary",
  callKind: "inbound_enquiry",
  environment: "dev",
});

/**
 * Minimal fake req/res — the handler is express-free by design.
 *
 * The default signature header carries a CURRENT timestamp. With a fixed `v=1`
 * the preflight replay check refuses it as stale before verification is even
 * attempted, which is correct behaviour but masks whatever the test meant to
 * exercise.
 */
function fakeExchange(body, { headers = {} } = {}) {
  const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const freshSignature = `v=${Date.now()},d=${"a".repeat(64)}`;
  const res = { statusCode: null, payload: undefined, ended: false };
  return {
    raw,
    req: { body: raw, headers: { "content-type": "application/json", "x-retell-signature": freshSignature, ...headers } },
    res: {
      status(code) { res.statusCode = code; return this; },
      json(payload) { res.payload = payload; res.ended = true; return this; },
      end() { res.ended = true; return this; },
    },
    out: res,
  };
}

const PASS = async () => verifyModule.verdict(verifyModule.VERIFY_RESULTS.verified);
const FAIL = async () => verifyModule.verdict(verifyModule.VERIFY_RESULTS.invalidSignature);

// ── Request shape ───────────────────────────────────────────────────

describe("inbound request validation", () => {
  test("the documented shape is accepted", () => {
    const v = inbound.validateInboundRequest(inboundBody());
    assert.equal(v.ok, true);
    assert.equal(v.request.agentId, AGENT_ID);
    assert.equal(v.request.agentVersion, 0);
    assert.equal(v.request.fromNumber, CALLER);
  });

  test("a call_ended payload is refused — this route answers one contract only", () => {
    const v = inbound.validateInboundRequest({ event: "call_ended", call: { call_id: "x" } });
    assert.equal(v.ok, false);
    assert.equal(v.code, inbound.REJECT_CODES.notInbound);
  });

  test("a missing agent_id is refused", () => {
    const v = inbound.validateInboundRequest(inboundBody({ agent_id: undefined }));
    assert.equal(v.ok, false);
    assert.equal(v.code, inbound.REJECT_CODES.missingAgent);
  });

  test("malformed bodies are refused, never coerced", () => {
    for (const bad of [null, "text", 42, [], { event: "call_inbound" }, { event: "call_inbound", call_inbound: [] }]) {
      assert.equal(inbound.validateInboundRequest(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
    }
  });

  test("oversized provider strings are bounded, not trusted", () => {
    const v = inbound.validateInboundRequest(inboundBody({ agent_id: "a".repeat(500) }));
    assert.equal(v.ok, false);
  });

  test("custom SIP headers are noticed but never read", () => {
    const v = inbound.validateInboundRequest(inboundBody({ custom_sip_headers: { "x-evil": "ignore me" } }));
    assert.equal(v.ok, true);
    assert.equal(v.request.hasCustomSipHeaders, true);
    assert.equal(JSON.stringify(v.request).includes("ignore me"), false);
  });

  test("a non-integer agent_version is dropped rather than coerced", () => {
    assert.equal(inbound.validateInboundRequest(inboundBody({ agent_version: "1" })).request.agentVersion, null);
  });
});

// ── The response contract ───────────────────────────────────────────

describe("the documented provider response shape", () => {
  test("a resolved call returns call_inbound.dynamic_variables", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    assert.equal(d.ok, true);
    assert.equal(d.status, 200);
    assert.deepEqual(Object.keys(d.body), ["call_inbound"]);
    assert.ok(d.body.call_inbound.dynamic_variables);
    assert.equal(d.body.call_inbound.dynamic_variables.current_business_status, "open");
  });

  test("the client id travels in metadata, never in a dynamic variable", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    assert.equal(d.body.call_inbound.metadata.aida_client_id, "demo-locksmith");
    // Metadata is stored against the call and is NOT injected into the prompt,
    // which is exactly why the client id belongs there.
    assert.equal(JSON.stringify(d.body.call_inbound.dynamic_variables).includes("demo-locksmith"), false);
  });

  test("every dynamic-variable value is a string, as the provider requires", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    for (const [k, v] of Object.entries(d.body.call_inbound.dynamic_variables)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
    }
  });

  test("no unresolved placeholder can reach the provider", async () => {
    const stale = { ...CONTEXT, businessStatus: "{{runtime}}" };
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => stale, logger: SILENT });
    assert.equal(d.ok, false);
    assert.equal(JSON.stringify(d.body).includes("{{"), false);
  });
});

// ── Phone-speech reuse ──────────────────────────────────────────────

describe("Australian phone speech through the shared service", () => {
  test("the caller's number is sent SPOKEN ONLY — never in E.164", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(), resolveContext: async () => CONTEXT, includeCallerNumber: true,
    });
    const vars = d.body.call_inbound.dynamic_variables;
    assert.equal(vars.caller_number_spoken, "zero four nine one, five seven zero, one one zero");
    assert.equal(vars.caller_number, undefined);
    assert.equal(vars.caller_number_e164, undefined);
    assert.equal(JSON.stringify(vars).includes(CALLER), false, "the caller's E.164 number must never be sent to the model");
  });

  test("the caller's number is withheld entirely unless asked for", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    assert.equal(d.body.call_inbound.dynamic_variables.caller_number_spoken, undefined);
  });

  test("the transfer number is sent ONLY as its spoken form", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    const vars = d.body.call_inbound.dynamic_variables;
    assert.equal(vars.current_transfer_number_spoken, "zero four nine one, five seven zero, zero zero six");
    assert.equal(vars.current_backup_number_spoken, "zero three, nine zero zero zero, zero zero zero zero");
    // M7G: the canonical values never enter the model's context.
    assert.equal(vars.current_transfer_number, undefined);
    assert.equal(vars.current_backup_number, undefined);
    assert.equal(JSON.stringify(vars).includes(TRANSFER), false);
  });

  test("NO raw E.164 anywhere in a resolved inbound response", async () => {
    // The blanket assertion, deliberately not narrowed. Covers variables AND
    // metadata, which is where a client identifier lives and a number must not.
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(), resolveContext: async () => CONTEXT, includeCallerNumber: true,
    });
    assert.equal(speech.containsE164(JSON.stringify(d.body)), false, JSON.stringify(d.body));
    assert.equal(speech.containsE164(JSON.stringify(d.body.call_inbound.metadata)), false);
  });

  test("the resolved response carries only the minimum variables", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    // The CONTEXT fixture also supplies runtime state, so those keys are
    // expected. What must be ABSENT is any canonical number.
    assert.deepEqual(
      Object.keys(d.body.call_inbound.dynamic_variables).sort(),
      ["call_kind", "current_backup_number_spoken", "current_business_status", "current_transfer_number_spoken", "on_call_state"]
    );
    for (const forbidden of ["current_transfer_number", "current_backup_number", "caller_number", "caller_number_e164"]) {
      assert.equal(forbidden in d.body.call_inbound.dynamic_variables, false, `${forbidden} must not be sent`);
    }
  });

  test("the canonical numbers remain available to server-side transfer execution", async () => {
    // What changed is what the MODEL is told, not what AIDA holds. The resolver
    // still returns the canonical values to the server, which is what a transfer
    // implementation will use.
    const { createInboundResolver, RESOLUTION } = require("../src/services/retell-inbound-resolver");
    const resolve = createInboundResolver({
      expectedTag: "dev",
      logger: SILENT,
      access: {
        async findResourcesByProviderId() {
          return [{ client_id: "demo-locksmith", provider: "retell", resource_type: "voice_agent", purpose: "receptionist_agent", provider_resource_id: AGENT_ID, provider_tag: "dev", active: true, profile_version: 3 }];
        },
        async getApprovedProfile() {
          return { version: 3, status: "approved", profile: { transfer: { primaryNumber: TRANSFER, backupNumber: "+61390000000" } } };
        },
      },
    });
    const result = await resolve({ agentId: AGENT_ID });
    assert.equal(result.resolution, RESOLUTION.resolved);
    assert.equal(result.context.transferPrimary, TRANSFER, "the server still gets the dialable number");
    assert.equal(result.context.transferBackup, "+61390000000");
  });

  test("no SPOKEN variable ever carries a number in international form", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(), resolveContext: async () => CONTEXT, includeCallerNumber: true,
    });
    for (const [k, v] of Object.entries(d.body.call_inbound.dynamic_variables)) {
      if (!k.endsWith("_spoken")) continue;
      assert.equal(speech.containsE164(v), false, `${k} leaked an E.164 number`);
    }
  });

  test("a foreign caller number yields no spoken variable rather than a guess", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody({ from_number: "+14155550123" }),
      resolveContext: async () => CONTEXT,
      includeCallerNumber: true,
    });
    assert.equal(d.body.call_inbound.dynamic_variables.caller_number_spoken, undefined);
  });

  test("it does NOT build its own variables — the shared service is used", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-inbound-call"), "utf8");
    assert.match(source, /buildInboundCallVariables/);
    assert.match(source, /buildInboundWebhookResponse/);
    // A parallel builder would be a second vocabulary to keep in step.
    assert.equal(/DYNAMIC_VARIABLE_ALLOWLIST\s*=/.test(source), false);
    assert.equal(/describeAuNumber\(/.test(source), false, "spoken forms come from the shared variable builder, not from here");
  });

  test("runtime-only values never become provisioned defaults", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(), resolveContext: async () => CONTEXT, includeCallerNumber: true,
    });
    const { defaults, runtimeOnly } = dynamicVars.splitDefaultsFromRuntime(d.body.call_inbound.dynamic_variables);
    assert.deepEqual(defaults, {}, "every value sent per call must be runtime-only");
    for (const key of Object.keys(d.body.call_inbound.dynamic_variables)) {
      assert.ok(runtimeOnly.includes(key), `${key} must be runtime-only`);
    }
  });
});

// ── Fail-closed behaviour ───────────────────────────────────────────

describe("failing closed", () => {
  test("an unknown client withholds variables and keeps the call alive", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => null, logger: SILENT });
    assert.equal(d.ok, false);
    assert.equal(d.code, inbound.REJECT_CODES.unknownClient);
    // 200 with an empty body: the call proceeds on the bound agent with NO
    // runtime values. A 4xx would cost three retries and then disconnect a
    // locksmith's customer.
    assert.equal(d.status, 200);
    assert.deepEqual(d.body, { call_inbound: {} });
    assert.equal(d.variableKeys.length, 0);
  });

  test("reject mode is available and returns the documented reject flag", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(), resolveContext: async () => null,
      failureMode: inbound.FAILURE_MODES.reject, logger: SILENT,
    });
    assert.equal(d.body.call_inbound.reject, true);
    assert.equal(d.rejected, true);
  });

  test("withhold is the DEFAULT, and reject requires an explicit exact value", () => {
    assert.equal(resolveFailureMode({}), inbound.FAILURE_MODES.withhold);
    assert.equal(resolveFailureMode({ RETELL_INBOUND_UNKNOWN_CLIENT_ACTION: "REJECT" }), inbound.FAILURE_MODES.withhold);
    assert.equal(resolveFailureMode({ RETELL_INBOUND_UNKNOWN_CLIENT_ACTION: "true" }), inbound.FAILURE_MODES.withhold);
    assert.equal(resolveFailureMode({ RETELL_INBOUND_UNKNOWN_CLIENT_ACTION: "reject" }), inbound.FAILURE_MODES.reject);
  });

  test("a throwing resolver never becomes a 500", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(),
      resolveContext: async () => { throw new Error("database is on fire"); },
      logger: SILENT,
    });
    assert.equal(d.status, 200);
    assert.equal(d.code, inbound.REJECT_CODES.resolverFailed);
    assert.equal(JSON.stringify(d).includes("database is on fire"), false, "the internal error must not leak");
  });

  test("a context with no client id is refused", async () => {
    const d = await inbound.decideInboundCall({
      parsed: inboundBody(), resolveContext: async () => ({ transferPrimary: TRANSFER }), logger: SILENT,
    });
    assert.equal(d.ok, false);
    assert.equal(d.code, inbound.REJECT_CODES.notProvisioned);
  });

  test("a refusal never carries a variable", async () => {
    for (const resolver of [async () => null, async () => ({}), async () => { throw new Error("x"); }]) {
      const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: resolver, logger: SILENT });
      assert.equal(JSON.stringify(d.body).includes("dynamic_variables"), false);
      assert.equal(JSON.stringify(d.body).includes(TRANSFER), false);
    }
  });
});

// ── The HTTP boundary ───────────────────────────────────────────────

describe("the handler: signature before anything else", () => {
  test("a verified inbound call is answered 200 with the provider shape", async () => {
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({ verify: PASS, env: ENV, logger: SILENT, resolveContext: async () => CONTEXT });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 200);
    assert.ok(x.out.payload.call_inbound.dynamic_variables);
  });

  test("an invalid signature is 401 and nothing is parsed or resolved", async () => {
    let resolverCalled = false;
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: FAIL, env: ENV, logger: SILENT,
      resolveContext: async () => { resolverCalled = true; return CONTEXT; },
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 401);
    assert.equal(resolverCalled, false, "verification must happen before any business logic");
    assert.equal(JSON.stringify(x.out.payload).includes("dynamic_variables"), false);
  });

  test("a missing signature is 401", async () => {
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: async () => verifyModule.verdict(verifyModule.VERIFY_RESULTS.missingSignature),
      env: ENV, logger: SILENT,
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 401);
  });

  test("an unavailable verifier is 503, never an open door", async () => {
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: async () => verifyModule.verdict(verifyModule.VERIFY_RESULTS.unavailable),
      env: ENV, logger: SILENT,
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 503);
  });

  test("an oversize body is 413 and a bad content type is 400", async () => {
    for (const [result, expected] of [[verifyModule.VERIFY_RESULTS.oversize, 413], [verifyModule.VERIFY_RESULTS.badContentType, 400]]) {
      const x = fakeExchange(inboundBody());
      const handler = createInboundWebhookHandler({ verify: async () => verifyModule.verdict(result), env: ENV, logger: SILENT });
      await handler(x.req, x.res);
      assert.equal(x.out.statusCode, expected);
    }
  });

  test("unparseable JSON is 400", async () => {
    const x = fakeExchange("{not json");
    const handler = createInboundWebhookHandler({ verify: PASS, env: ENV, logger: SILENT });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 400);
    assert.equal(x.out.payload.error, "malformed_json");
  });

  test("a call_ended payload sent here is 400, not answered with an inbound body", async () => {
    const x = fakeExchange({ event: "call_ended", call: { call_id: "call_x" } });
    const handler = createInboundWebhookHandler({ verify: PASS, env: ENV, logger: SILENT, resolveContext: async () => CONTEXT });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 400);
    assert.equal(x.out.payload.error, "not_an_inbound_event");
    assert.equal(JSON.stringify(x.out.payload).includes("call_inbound"), false);
  });

  test("the handler touches no database", () => {
    const source = fs.readFileSync(require.resolve("../src/routes/retell-inbound-webhook-handler"), "utf8");
    assert.equal(/supabase|findEventByFingerprint|recordEvent|provider_webhook_events/.test(source), false);
    const core = fs.readFileSync(require.resolve("../src/services/retell-inbound-call"), "utf8");
    assert.equal(/supabase|require\(["']\.\/supabase/.test(core), false);
  });

  test("audit runs after the response and cannot delay it", async () => {
    let respondedAt = null;
    let auditedAt = null;
    const x = fakeExchange(inboundBody());
    x.res.json = function (payload) { respondedAt = process.hrtime.bigint(); x.out.payload = payload; return this; };
    const handler = createInboundWebhookHandler({
      verify: PASS, env: ENV, logger: SILENT, resolveContext: async () => CONTEXT,
      audit: async () => { auditedAt = process.hrtime.bigint(); },
    });
    await handler(x.req, x.res);
    await new Promise((r) => setImmediate(r));
    assert.ok(respondedAt !== null && auditedAt !== null);
    assert.ok(auditedAt > respondedAt, "the audit must not precede the response");
  });

  test("nothing sensitive reaches a log line", async () => {
    const lines = [];
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: PASS, env: ENV, resolveContext: async () => CONTEXT, includeCallerNumber: true,
      logger: { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) },
    });
    await handler(x.req, x.res);
    const all = lines.join("\n");
    assert.equal(all.includes(CALLER), false, "a caller number reached a log line");
    assert.equal(all.includes(TRANSFER), false, "a transfer number reached a log line");
    assert.equal(all.includes(ENV.RETELL_API_KEY), false);
    assert.equal(all.includes("zero four nine one"), false, "a spoken number reached a log line");
    assert.ok(all.includes("retell.inbound.answered"));
  });
});

// ── Latency ─────────────────────────────────────────────────────────

describe("latency", () => {
  test("the decision completes far inside the provider's 10-second budget", async () => {
    // A LOCAL measurement of OUR work only. It proves the code path does no
    // I/O; it says nothing about internet or deployed latency.
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100; i += 1) {
      await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    }
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 100;
    assert.ok(perCallMs < 50, `expected well under 50ms of local work per call, got ${perCallMs.toFixed(2)}ms`);
  });

  test("the response is built without awaiting any storage", () => {
    const source = fs.readFileSync(require.resolve("../src/routes/retell-inbound-webhook-handler"), "utf8");
    const beforeResponse = source.split("res.status(decision.status)")[0];
    assert.equal(/await\s+audit|await\s+record|await\s+.*supabase/.test(beforeResponse), false);
  });
});

// ── The inbound webhook URL ─────────────────────────────────────────

describe("inbound webhook URL configuration", () => {
  test("it is built from an explicit HTTPS base", () => {
    const r = cfg.buildInboundWebhookUrl(ENV);
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://aida-sandbox.example.com/webhooks/retell/inbound");
  });

  test("a missing base URL yields no URL and says why", () => {
    const r = cfg.buildInboundWebhookUrl({});
    assert.equal(r.ok, false);
    assert.equal(r.url, null);
    assert.match(r.reason, /RETELL_WEBHOOK_BASE_URL/);
  });

  test("plain HTTP is refused", () => {
    const r = cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "http://aida-sandbox.example.com" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /https/);
  });

  test("localhost and private addresses are refused", () => {
    for (const host of ["https://localhost", "https://127.0.0.1", "https://[::1]", "https://10.0.0.5", "https://192.168.1.10", "https://172.16.4.2", "https://myhost"]) {
      const r = cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: host });
      assert.equal(r.ok, false, `${host} must be refused — the provider could never reach it`);
    }
  });

  test("a query string or fragment is refused", () => {
    assert.equal(cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "https://x.example.com?a=1" }).ok, false);
    assert.equal(cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "https://x.example.com#f" }).ok, false);
  });

  test("the path is stable and trailing slashes do not change it", () => {
    const a = cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "https://x.example.com" }).url;
    const b = cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "https://x.example.com/" }).url;
    const c = cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "https://x.example.com///" }).url;
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a, `https://x.example.com${cfg.INBOUND_WEBHOOK_PATH}`);
  });

  test("the inbound URL is DISTINCT from the event webhook URL", () => {
    const inboundUrl = cfg.buildInboundWebhookUrl(ENV).url;
    const eventUrl = cfg.buildEventWebhookUrl(ENV).url;
    assert.notEqual(inboundUrl, eventUrl);
    assert.ok(inboundUrl.endsWith("/webhooks/retell/inbound"));
    assert.ok(eventUrl.endsWith("/webhooks/retell"));
  });

  test("the insecure escape hatch is unreachable from configuration", () => {
    // allowInsecure exists for isolated path tests only. No env value turns it
    // on, so no deployment can accidentally register an http:// webhook.
    const source = fs.readFileSync(require.resolve("../src/config/retell"), "utf8");
    assert.equal(/allowInsecure\s*[:=]\s*(strictTrue|env\.|process\.env)/.test(source), false);
    assert.equal(cfg.buildInboundWebhookUrl({ RETELL_WEBHOOK_BASE_URL: "http://x.example.com" }).ok, false);
  });

  test("NO provider write happens by default — the URL is computed, not sent", () => {
    // M7F-A asserted the compiler emitted NO inbound_webhook_url at all. M7F-B1
    // adds it deliberately, so that assertion is superseded by a stronger one:
    // the URL appears only when every gate is open, and the default
    // configuration still emits nothing. Full gate coverage is in the
    // "inbound_webhook_url in the provisioning plan" suite below.
    const rc = require("../src/services/locksmith-receptionist-compiler");
    require("../src/services/locksmith-extraction-fixture");
    const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
    const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

    const config = cfg.getRetellConfig({});
    const profile = JSON.parse(JSON.stringify(extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo" }).profile));
    const compiled = rc.compileReceptionist({
      profile, profileVersion: 1, profileStatus: "approved", clientId: "demo",
      templateVersion: config.receptionistTemplateVersion, config, generatedAt: "2026-08-02T00:00:00.000Z",
    });
    const payload = rc.toRetellPayload({ compiled, config });

    assert.equal(payload.inboundWebhook.included, false);
    assert.equal(payload.inboundBinding, null, "no number configured, so no binding at all");
    assert.equal(JSON.stringify(payload).includes("inbound_webhook_url"), false);
  });
});

// ── Gates ───────────────────────────────────────────────────────────

describe("gates", () => {
  test("the inbound webhook has its own flag, off by default", () => {
    assert.equal(cfg.isInboundWebhookEnabled({}), false);
    assert.equal(cfg.isInboundWebhookEnabled({ RETELL_INBOUND_WEBHOOK_ENABLED: "true" }), true);
    for (const v of ["TRUE", "1", "yes", " true"]) {
      assert.equal(cfg.isInboundWebhookEnabled({ RETELL_INBOUND_WEBHOOK_ENABLED: v }), false, `"${v}" must not enable it`);
    }
  });

  test("enabling post-call events does NOT enable the inbound webhook", () => {
    const eventsOnly = { RETELL_ENABLED: "true", RETELL_WEBHOOK_ENABLED: "true" };
    assert.equal(cfg.isWebhookEnabled(eventsOnly), true);
    assert.equal(cfg.isInboundWebhookEnabled(eventsOnly), false);
  });
});

// ── Real signature round-trip ───────────────────────────────────────

describe("signature verification through the official seam", () => {
  let sdk = null;
  try {
    // eslint-disable-next-line global-require
    sdk = require("retell-sdk");
  } catch {
    sdk = null;
  }

  test("the official verifier is discovered when the SDK is present", { skip: !sdk }, () => {
    assert.equal(typeof verifyModule.loadOfficialVerifier(), "function");
  });

  test("a REAL signed body verifies end to end", { skip: !sdk }, async () => {
    const body = JSON.stringify(inboundBody());
    const key = "key_fixture_not_real";
    const signature = await sdk.sign(body, key);

    const verdict = await verifyModule.verifyRetellWebhook({
      rawBody: Buffer.from(body, "utf8"),
      headers: { "content-type": "application/json", "x-retell-signature": signature },
      deps: { env: { ...ENV, RETELL_API_KEY: key } },
    });
    assert.equal(verdict.verified, true, verdict.result);
  });

  test("MUTATING ONE BYTE of the body invalidates the signature", { skip: !sdk }, async () => {
    const body = JSON.stringify(inboundBody());
    const key = "key_fixture_not_real";
    const signature = await sdk.sign(body, key);

    const verdict = await verifyModule.verifyRetellWebhook({
      rawBody: Buffer.from(`${body} `, "utf8"), // one trailing space
      headers: { "content-type": "application/json", "x-retell-signature": signature },
      deps: { env: { ...ENV, RETELL_API_KEY: key } },
    });
    assert.equal(verdict.verified, false);
    assert.equal(verdict.result, verifyModule.VERIFY_RESULTS.invalidSignature);
  });

  test("a signature made with a different key is rejected", { skip: !sdk }, async () => {
    const body = JSON.stringify(inboundBody());
    const signature = await sdk.sign(body, "some_other_key");

    const verdict = await verifyModule.verifyRetellWebhook({
      rawBody: Buffer.from(body, "utf8"),
      headers: { "content-type": "application/json", "x-retell-signature": signature },
      deps: { env: { ...ENV, RETELL_API_KEY: "key_fixture_not_real" } },
    });
    assert.equal(verdict.verified, false);
  });

  test("a genuinely signed but STALE signature is refused by our own replay window", { skip: !sdk }, async () => {
    const body = JSON.stringify(inboundBody());
    const key = "key_fixture_not_real";
    const signature = await sdk.sign(body, key);

    const verdict = await verifyModule.verifyRetellWebhook({
      rawBody: Buffer.from(body, "utf8"),
      headers: { "content-type": "application/json", "x-retell-signature": signature },
      // Ten minutes later — outside the documented 5-minute window.
      deps: { env: { ...ENV, RETELL_API_KEY: key }, now: () => Date.now() + 10 * 60 * 1000 },
    });
    assert.equal(verdict.verified, false);
    assert.equal(verdict.result, verifyModule.VERIFY_RESULTS.staleSignature);
  });

  test("the end-to-end handler accepts a really-signed inbound call", { skip: !sdk }, async () => {
    const body = JSON.stringify(inboundBody());
    const key = "key_fixture_not_real";
    const signature = await sdk.sign(body, key);
    const x = fakeExchange(body, { headers: { "x-retell-signature": signature } });

    const handler = createInboundWebhookHandler({
      env: { ...ENV, RETELL_API_KEY: key },
      logger: SILENT,
      resolveContext: async () => CONTEXT,
      includeCallerNumber: true,
    });
    await handler(x.req, x.res);

    assert.equal(x.out.statusCode, 200);
    const vars = x.out.payload.call_inbound.dynamic_variables;
    assert.equal(vars.caller_number_spoken, "zero four nine one, five seven zero, one one zero");
    assert.equal(JSON.stringify(x.out.payload).includes(CALLER), false);
  });

  test("with NO verifier available the same request is refused", async () => {
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      env: ENV, logger: SILENT, resolveContext: async () => CONTEXT,
      // Explicitly no verifier: the fail-closed path, whether or not the SDK
      // happens to be installed on this machine.
      verifier: null,
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 503);
    assert.equal(x.out.payload.error, verifyModule.VERIFY_RESULTS.unavailable);
  });
});

// ── Resolver integration (M7F-B1) ───────────────────────────────────

describe("the real resolver, through the handler", () => {
  const { RESOLUTION } = require("../src/services/retell-inbound-resolver");

  /** A resolveInbound seam returning the resolver's classified outcome. */
  const outcome = (resolution, context = null) => async () => ({
    ok: resolution === RESOLUTION.resolved,
    resolution,
    context,
    clientId: context ? context.clientId : null,
  });

  const RESOLVED = {
    clientId: "demo-locksmith",
    profileVersion: 3,
    transferPrimary: TRANSFER,
    transferBackup: null,
    environment: "dev",
    callId: null,
  };

  test("a resolved agent yields the documented variables", async () => {
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: PASS, env: ENV, logger: SILENT, resolveInbound: outcome(RESOLUTION.resolved, RESOLVED),
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 200);
    // The SPOKEN form, not the canonical one — see the M7G note in
    // buildInboundCallVariables.
    assert.equal(x.out.payload.call_inbound.dynamic_variables.current_transfer_number_spoken, "zero four nine one, five seven zero, zero zero six");
    assert.equal(x.out.payload.call_inbound.dynamic_variables.current_transfer_number, undefined);
    assert.equal(x.out.payload.call_inbound.metadata.aida_client_id, "demo-locksmith");
    assert.equal(speech.containsE164(JSON.stringify(x.out.payload)), false);
  });

  for (const resolution of [
    RESOLUTION.unknownAgent,
    RESOLUTION.ambiguousAgent,
    RESOLUTION.supersededAgent,
    RESOLUTION.wrongEnvironment,
    RESOLUTION.inactiveClient,
    RESOLUTION.unapprovedProfile,
    RESOLUTION.registryUnavailable,
  ]) {
    test(`${resolution} yields an empty call_inbound and NO variables`, async () => {
      const x = fakeExchange(inboundBody());
      const handler = createInboundWebhookHandler({
        verify: PASS, env: ENV, logger: SILENT, resolveInbound: outcome(resolution),
      });
      await handler(x.req, x.res);
      assert.equal(x.out.statusCode, 200, "a 4xx would cost three retries and then disconnect the caller");
      assert.deepEqual(x.out.payload, { call_inbound: {} });
      assert.equal(JSON.stringify(x.out.payload).includes(TRANSFER), false);
    });
  }

  test("the audit records the CLASSIFICATION, not just failure", async () => {
    const events = [];
    for (const resolution of [RESOLUTION.resolved, RESOLUTION.ambiguousAgent, RESOLUTION.wrongEnvironment]) {
      const x = fakeExchange(inboundBody());
      const handler = createInboundWebhookHandler({
        verify: PASS, env: ENV, logger: SILENT,
        resolveInbound: outcome(resolution, resolution === RESOLUTION.resolved ? RESOLVED : null),
        audit: async (e) => events.push(e),
      });
      await handler(x.req, x.res);
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(events.map((e) => e.resolution), [RESOLUTION.resolved, RESOLUTION.ambiguousAgent, RESOLUTION.wrongEnvironment]);
    // "ambiguous agent" and "unknown agent" need completely different operator
    // responses and must not look alike in the audit trail.
    assert.equal(events[0].event, "inbound_resolved");
    assert.equal(events[1].event, "inbound_unresolved");
    assert.equal(events[0].clientId, "demo-locksmith");
    assert.equal(events[1].clientId, null);
  });

  test("the audit carries no caller number, transfer number or variable value", async () => {
    const events = [];
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: PASS, env: ENV, logger: SILENT, includeCallerNumber: true,
      resolveInbound: outcome(RESOLUTION.resolved, RESOLVED),
      audit: async (e) => events.push(e),
    });
    await handler(x.req, x.res);
    await new Promise((r) => setImmediate(r));
    const json = JSON.stringify(events[0]);
    assert.equal(json.includes(CALLER), false);
    assert.equal(json.includes(TRANSFER), false);
    assert.equal(json.includes("zero four nine one"), false);
    // The transfer number's spoken form and the caller's spoken form. The
    // canonical transfer number is no longer sent at all (M7G), so this dropped
    // from three to two — the count is asserted precisely so a silent return of
    // the raw value would fail here as well as in the shape tests.
    assert.equal(events[0].variableCount, 2);
  });

  test("the audit still runs after the response", async () => {
    let responded = null;
    let audited = null;
    const x = fakeExchange(inboundBody());
    x.res.json = function (p) { responded = process.hrtime.bigint(); x.out.payload = p; return this; };
    const handler = createInboundWebhookHandler({
      verify: PASS, env: ENV, logger: SILENT, resolveInbound: outcome(RESOLUTION.resolved, RESOLVED),
      audit: async () => { audited = process.hrtime.bigint(); },
    });
    await handler(x.req, x.res);
    await new Promise((r) => setImmediate(r));
    assert.ok(audited > responded);
  });

  test("an invalid signature never reaches the resolver", async () => {
    let called = false;
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      verify: FAIL, env: ENV, logger: SILENT,
      resolveInbound: async () => { called = true; return { ok: true, resolution: "resolved", context: RESOLVED }; },
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 401);
    assert.equal(called, false);
  });

  test("the route composes the real resolver without importing Express into it", () => {
    const routeSource = fs.readFileSync(require.resolve("../src/routes/retell-inbound-webhook"), "utf8");
    assert.match(routeSource, /createInboundResolver/);
    assert.match(routeSource, /createRegistryAccess/);
    assert.match(routeSource, /resolveInbound/);
    // Composition lives at the boundary; the handler and core stay injectable.
    const handlerSource = fs.readFileSync(require.resolve("../src/routes/retell-inbound-webhook-handler"), "utf8");
    assert.equal(/createRegistryAccess/.test(handlerSource), false);
    const coreSource = fs.readFileSync(require.resolve("../src/services/retell-inbound-call"), "utf8");
    assert.equal(/retell-inbound-resolver/.test(coreSource), false);
  });
});

// ── The inbound webhook URL in the binding plan (M7F-B1) ────────────

describe("inbound_webhook_url in the provisioning plan", () => {
  const rc = require("../src/services/locksmith-receptionist-compiler");
  require("../src/services/locksmith-extraction-fixture");
  const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
  const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

  const OPEN = Object.freeze({
    NODE_ENV: "development",
    RETELL_ENABLED: "true",
    RETELL_INBOUND_WEBHOOK_ENABLED: "true",
    RETELL_LIVE_WRITES_ENABLED: "true",
    RETELL_DRY_RUN: "false",
    RETELL_ALLOWED_TAG: "dev",
    RETELL_API_KEY: "key_fixture_not_real",
    RETELL_DEFAULT_VOICE_ID: "voice_fixture",
    RETELL_WEBHOOK_BASE_URL: "https://aida-sandbox.example.com",
    RETELL_INBOUND_DEMO_NUMBER: "+61491570006",
  });

  function payloadFor(envOverrides = {}) {
    const config = cfg.getRetellConfig({ ...OPEN, ...envOverrides });
    const profile = JSON.parse(JSON.stringify(extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo" }).profile));
    const compiled = rc.compileReceptionist({
      profile, profileVersion: 1, profileStatus: "approved", clientId: "demo",
      templateVersion: config.receptionistTemplateVersion, config, generatedAt: "2026-08-02T00:00:00.000Z",
    });
    return rc.toRetellPayload({ compiled, config });
  }

  test("included when every gate is open", () => {
    const p = payloadFor();
    assert.equal(p.inboundBinding.inbound_webhook_url, "https://aida-sandbox.example.com/webhooks/retell/inbound");
    assert.equal(p.inboundWebhook.included, true);
  });

  test("omitted by default, with the reason visible", () => {
    const p = payloadFor({ RETELL_ENABLED: undefined, RETELL_INBOUND_WEBHOOK_ENABLED: undefined, RETELL_LIVE_WRITES_ENABLED: undefined, RETELL_DRY_RUN: undefined, RETELL_WEBHOOK_BASE_URL: undefined });
    assert.equal(p.inboundBinding && p.inboundBinding.inbound_webhook_url, undefined);
    assert.equal(p.inboundWebhook.included, false);
    assert.ok(p.inboundWebhook.reason, "a dry-run preview must say WHY, or silence looks like the feature not existing");
  });

  const closers = [
    ["RETELL_ENABLED not true", { RETELL_ENABLED: "false" }, /RETELL_ENABLED/],
    ["inbound webhook flag off", { RETELL_INBOUND_WEBHOOK_ENABLED: "false" }, /RETELL_INBOUND_WEBHOOK_ENABLED/],
    ["live writes off", { RETELL_LIVE_WRITES_ENABLED: "false" }, /RETELL_LIVE_WRITES_ENABLED/],
    ["dry-run on", { RETELL_DRY_RUN: "true" }, /DRY_RUN/],
    ["tag mismatch", { RETELL_ALLOWED_TAG: "prod" }, /tag/],
    ["no base URL", { RETELL_WEBHOOK_BASE_URL: undefined }, /https|BASE_URL/],
    ["http base URL", { RETELL_WEBHOOK_BASE_URL: "http://aida-sandbox.example.com" }, /https/],
    ["localhost base URL", { RETELL_WEBHOOK_BASE_URL: "https://localhost" }, /reachable|https/],
    ["private host", { RETELL_WEBHOOK_BASE_URL: "https://10.0.0.4" }, /reachable|https/],
  ];

  for (const [name, override, reasonPattern] of closers) {
    test(`omitted when ${name}`, () => {
      const p = payloadFor(override);
      assert.equal(p.inboundBinding && p.inboundBinding.inbound_webhook_url, undefined, `${name} must not register a URL`);
      assert.equal(p.inboundWebhook.included, false);
      assert.match(p.inboundWebhook.reason, reasonPattern);
    });
  }

  test("changing ONLY the webhook URL produces a different binding payload", () => {
    const a = payloadFor();
    const b = payloadFor({ RETELL_WEBHOOK_BASE_URL: "https://aida-sandbox-2.example.com" });
    assert.notEqual(JSON.stringify(a.inboundBinding), JSON.stringify(b.inboundBinding));
    // Everything else about the binding is identical — the diff is the URL.
    assert.equal(a.inboundBinding.phone_number, b.inboundBinding.phone_number);
    assert.deepEqual(a.inboundBinding.inbound_agents, b.inboundBinding.inbound_agents);
  });

  test("hashing stays deterministic", () => {
    const { payloadHash } = require("../src/services/voice-platform-port");
    assert.equal(payloadHash(payloadFor().inboundBinding), payloadHash(payloadFor().inboundBinding));
    assert.notEqual(payloadHash(payloadFor().inboundBinding), payloadHash(payloadFor({ RETELL_WEBHOOK_BASE_URL: "https://other.example.com" }).inboundBinding));
  });

  test("unbinding can null the URL, per the documented contract", () => {
    // PATCH /update-phone-number accepts null for inbound_agents and
    // inbound_webhook_url to return a number to an unassigned state.
    const unbind = { phone_number: "+61491570006", inbound_agents: null, inbound_webhook_url: null };
    const { validateAgentWeights } = require("../src/services/provisioning-plan");
    assert.equal(validateAgentWeights(unbind.inbound_agents).ok, false, "an unbind is not a binding and must not validate as one");
    assert.equal(unbind.inbound_webhook_url, null);
  });

  test("the URL never reaches the prompt, the knowledge base or the defaults", () => {
    const p = payloadFor();
    assert.equal(p.responseEngine.general_prompt.includes("aida-sandbox"), false);
    assert.equal(JSON.stringify(p.responseEngine.default_dynamic_variables).includes("aida-sandbox"), false);
    assert.equal(JSON.stringify(p.knowledge).includes("aida-sandbox"), false);
    assert.equal(String(p.responseEngine.begin_message || "").includes("aida-sandbox"), false);
  });

  test("no provider request occurs from building a plan", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const adapter = createRetellAdapter({ config: cfg.getRetellConfig(OPEN), env: OPEN, logger: SILENT });
    payloadFor();
    // The adapter still has no transport, so nothing could have been sent.
    const r = await adapter.bindPhoneNumber({ payload: {}, providerId: "+61491570006", idempotencyKey: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /no HTTP transport/);
  });
});

// ── The SDK stays out of the domain ─────────────────────────────────

describe("the SDK is confined to signature verification", () => {
  const DOMAIN = [
    "../src/services/retell-adapter",
    "../src/services/voice-platform-port",
    "../src/services/locksmith-receptionist-compiler",
    "../src/services/provisioning-plan",
    "../src/services/retell-inbound-call",
    "../src/services/retell-call-diagnostics",
    "../src/services/retell-web-sandbox",
    "../src/routes/retell-inbound-webhook-handler",
  ];

  test("no provisioning or domain module imports retell-sdk", () => {
    for (const mod of DOMAIN) {
      const source = fs.readFileSync(require.resolve(mod), "utf8");
      assert.equal(/require\(["']retell-sdk["']\)/.test(source), false, `${mod} must not import the SDK`);
    }
  });

  test("only the verification module loads it", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-webhook-verify"), "utf8");
    assert.match(source, /require\("retell-sdk"\)/);
    // And it still refuses to improvise if the SDK vanishes.
    assert.equal(/createHmac/.test(source), false, "the verifier must never hand-roll an HMAC");
  });

  test("no browser SDK reaches server code", () => {
    for (const mod of DOMAIN) {
      const source = fs.readFileSync(require.resolve(mod), "utf8");
      assert.equal(/retell-client-js-sdk/.test(source), false, `${mod} must not import the browser SDK`);
    }
  });

  test("provisioning and web calls stay on native fetch", () => {
    const adapter = fs.readFileSync(require.resolve("../src/services/retell-adapter"), "utf8");
    assert.match(adapter, /fetchImpl/);
    assert.equal(/require\(["']retell-sdk["']\)/.test(adapter), false);
  });
});

// ── Verification capability (M7F-B2) ────────────────────────────────

describe("the inbound webhook verifies under its OWN flag", () => {
  // Exactly what docs/RETELL_SANDBOX_DEPLOYMENT_PLAN.md instructs. Note the
  // ABSENCE of RETELL_WEBHOOK_ENABLED: that flag governs the post-call EVENT
  // webhook, whose route is deliberately left dormant for the sandbox.
  const SANDBOX_ENV = Object.freeze({
    NODE_ENV: "development",
    RETELL_ENABLED: "true",
    RETELL_INBOUND_WEBHOOK_ENABLED: "true",
    RETELL_API_KEY: "key_fixture_not_real",
    RETELL_ALLOWED_TAG: "dev",
  });

  test("canVerifyInboundWebhook does NOT require the event webhook's flag", () => {
    // The defect: verification asked RETELL_WEBHOOK_ENABLED for permission, so
    // enabling inbound alone produced 503 verification_disabled on every
    // request — making the dedicated inbound flag a fiction.
    assert.equal(cfg.canVerifyInboundWebhook(SANDBOX_ENV).allowed, true);
    assert.equal(cfg.canVerifyWebhook(SANDBOX_ENV).allowed, false, "the EVENT capability still needs its own flag");
  });

  test("it requires the inbound flag, the integration flag and a key", () => {
    for (const [name, env] of [
      ["RETELL_ENABLED off", { ...SANDBOX_ENV, RETELL_ENABLED: "false" }],
      ["inbound flag off", { ...SANDBOX_ENV, RETELL_INBOUND_WEBHOOK_ENABLED: "false" }],
      ["no API key", { ...SANDBOX_ENV, RETELL_API_KEY: undefined }],
    ]) {
      assert.equal(cfg.canVerifyInboundWebhook(env).allowed, false, `${name} must refuse`);
    }
  });

  test("the deployed sandbox configuration answers 401, not 503", async () => {
    for (const [label, headers] of [
      ["unsigned", {}],
      ["bad signature", { "x-retell-signature": `v=${Date.now()},d=${"a".repeat(64)}` }],
    ]) {
      const x = fakeExchange(inboundBody(), { headers });
      // No injected `verify`: the REAL verification path, which is where the
      // capability is consulted.
      const handler = createInboundWebhookHandler({ env: SANDBOX_ENV, logger: SILENT, resolveContext: async () => null });
      await handler(x.req, x.res);
      assert.equal(x.out.statusCode, 401, `${label} must be 401, not 503 verification_disabled`);
      assert.notEqual(x.out.payload.error, "verification_disabled");
    }
  });

  test("a really-signed request is accepted under the sandbox configuration", async () => {
    let sdk = null;
    try { sdk = require("retell-sdk"); } catch { sdk = null; }
    if (!sdk) return; // dep-free checkout: the fake-verifier tests still cover the path

    const body = JSON.stringify(inboundBody());
    const signature = await sdk.sign(body, SANDBOX_ENV.RETELL_API_KEY);
    const x = fakeExchange(body, { headers: { "x-retell-signature": signature } });
    const handler = createInboundWebhookHandler({ env: SANDBOX_ENV, logger: SILENT, resolveContext: async () => null });
    await handler(x.req, x.res);

    assert.equal(x.out.statusCode, 200);
    assert.deepEqual(x.out.payload, { call_inbound: {} }, "unknown agent, so no variables");
  });

  test("turning the inbound flag off refuses with 503, never an open door", async () => {
    const x = fakeExchange(inboundBody());
    const handler = createInboundWebhookHandler({
      env: { ...SANDBOX_ENV, RETELL_INBOUND_WEBHOOK_ENABLED: "false" }, logger: SILENT,
    });
    await handler(x.req, x.res);
    assert.equal(x.out.statusCode, 503);
    assert.equal(x.out.payload.error, "verification_disabled");
  });

  test("the EVENT webhook's own behaviour is unchanged", async () => {
    const verify = require("../src/services/retell-webhook-verify");
    const body = JSON.stringify({ event: "call_ended", call: { call_id: "call_x" } });

    // Without RETELL_WEBHOOK_ENABLED the event path still refuses, exactly as
    // before — the default capability was not weakened.
    const refused = await verify.verifyRetellWebhook({
      rawBody: Buffer.from(body, "utf8"),
      headers: { "content-type": "application/json", "x-retell-signature": `v=${Date.now()},d=${"a".repeat(64)}` },
      deps: { env: SANDBOX_ENV },
    });
    assert.equal(refused.verified, false);
    assert.equal(refused.result, verify.VERIFY_RESULTS.disabled);

    // And with it, the event path reaches signature checking as before.
    const reached = await verify.verifyRetellWebhook({
      rawBody: Buffer.from(body, "utf8"),
      headers: { "content-type": "application/json", "x-retell-signature": `v=${Date.now()},d=${"a".repeat(64)}` },
      deps: { env: { ...SANDBOX_ENV, RETELL_WEBHOOK_ENABLED: "true" }, verifier: async () => false },
    });
    assert.equal(reached.result, verify.VERIFY_RESULTS.invalidSignature);
  });
});

// ── Deployment and runtime (M7F-B1) ─────────────────────────────────

describe("deployment and runtime", () => {
  const path = require("node:path");
  const ROOT = path.join(__dirname, "..");

  test("the declared engine and the deploy pin agree, and both are non-EOL", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const nvmrc = fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim();

    // Node 20 reached end of life on 30 April 2026, and the Retell SDK requires
    // a NON-EOL Node 20 or later. Pinning 20 would pin an unpatched runtime, so
    // 22 is the supported floor rather than the technical one.
    const pinned = Number(nvmrc);
    assert.ok(Number.isInteger(pinned), `.nvmrc must be a bare major version, got "${nvmrc}"`);
    assert.ok(pinned >= 22, `.nvmrc pins Node ${pinned}, which is end-of-life`);

    const floor = Number(String(pkg.engines.node).replace(/[^\d]/g, ""));
    assert.ok(floor >= 22, `engines.node is "${pkg.engines.node}", which permits an EOL runtime`);
    assert.ok(pinned >= floor, "the pinned version must satisfy the declared engine");
  });

  test("the running Node satisfies the declared engine", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const floor = Number(String(pkg.engines.node).replace(/[^\d]/g, ""));
    const running = Number(process.versions.node.split(".")[0]);
    assert.ok(running >= floor, `running Node ${running} is below the declared floor ${floor}`);
  });

  test("the Web Crypto API the verifier depends on is present", () => {
    // The SDK's verifier calls globalThis.crypto.subtle and throws without it.
    // That is the concrete reason the Node floor moved, so it is asserted
    // rather than assumed.
    assert.equal(typeof globalThis.crypto, "object");
    assert.equal(typeof globalThis.crypto.subtle.importKey, "function");
  });

  test("the deploy pin is the only Node selection signal in the repo", () => {
    // Nixpacks reads .nvmrc / .node-version before engines. A range like ">=22"
    // is a constraint, not a selection, so without a pin the platform picks.
    for (const competing of [".node-version", "Dockerfile", "nixpacks.toml"]) {
      assert.equal(fs.existsSync(path.join(ROOT, competing)), false, `${competing} would compete with .nvmrc`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, ".nvmrc")), true);
  });

  test("starting the app creates no call and no provider write", () => {
    // server.js mounts routers; nothing at module scope may reach a provider.
    const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
    for (const forbidden of ["createPhoneCall", "createWebCall", "bindPhoneNumber", "createAgent", "importPhoneNumber", "createPhoneNumber"]) {
      assert.equal(server.includes(forbidden), false, `server.js must not reference ${forbidden}`);
    }
    // And the inbound route composes a resolver, not a provider client.
    const route = fs.readFileSync(require.resolve("../src/routes/retell-inbound-webhook"), "utf8");
    assert.equal(/createRetellAdapter|fetchImpl/.test(route), false);
  });

  test("the smoke harness contacts nothing by default and embeds no key", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "retell-inbound-smoke.js"), "utf8");
    // The key is read from the environment and never accepted on the command
    // line, because a command line ends up in shell history.
    assert.match(source, /process\.env\.RETELL_API_KEY/);
    assert.equal(/valueOf\("--key"\)|--api-key/.test(source), false);
    // No hard-coded secret, and only the fictitious range appears.
    assert.equal(/\bkey_[A-Za-z0-9]{16,}/.test(source), false);
    for (const m of source.match(/\+61\d{9}/g) || []) {
      assert.match(m, /^\+6149157(00\d|0?1[0-5]\d)$/, `${m} is outside the ACMA fictitious range`);
    }
    // fetch is only reachable once a --target is supplied.
    assert.match(source, /if \(!TARGET\)/);
  });
});
