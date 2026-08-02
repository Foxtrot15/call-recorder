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
    assert.equal(vars.caller_number_spoken, "oh four nine one, five seven oh, one one oh");
    assert.equal(vars.caller_number, undefined);
    assert.equal(vars.caller_number_e164, undefined);
    assert.equal(JSON.stringify(vars).includes(CALLER), false, "the caller's E.164 number must never be sent to the model");
  });

  test("the caller's number is withheld entirely unless asked for", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    assert.equal(d.body.call_inbound.dynamic_variables.caller_number_spoken, undefined);
  });

  test("the transfer number keeps BOTH forms, machine and spoken", async () => {
    const d = await inbound.decideInboundCall({ parsed: inboundBody(), resolveContext: async () => CONTEXT });
    const vars = d.body.call_inbound.dynamic_variables;
    assert.equal(vars.current_transfer_number, TRANSFER, "the machine form stays canonical");
    assert.equal(vars.current_transfer_number_spoken, "oh four nine one, five seven oh, oh oh six");
    assert.equal(vars.current_backup_number_spoken, "oh three, nine oh oh oh, oh oh oh oh");
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
    assert.equal(all.includes("oh four nine one"), false, "a spoken number reached a log line");
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
    // M7F-A configures nothing at Retell. The binding payload still carries no
    // inbound_webhook_url; enabling that is a later, explicit decision.
    const compiler = fs.readFileSync(require.resolve("../src/services/locksmith-receptionist-compiler"), "utf8");
    assert.equal(/inbound_webhook_url/.test(compiler), false, "M7F-A must not start writing a webhook URL to the provider");
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
    assert.equal(vars.caller_number_spoken, "oh four nine one, five seven oh, one one oh");
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
