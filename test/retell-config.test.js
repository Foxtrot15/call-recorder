// LOCKSMITH M3 — Retell configuration, the provider port, and webhook security.
//
// Pure modules; runs without node_modules. Nothing in this file can reach the
// network: the live adapter is only ever constructed without a transport, and
// the assertion that it refuses is itself a test.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const cfg = require("../src/config/retell");
const port = require("../src/services/voice-platform-port");
const verify = require("../src/services/retell-webhook-verify");
const { createRetellAdapter } = require("../src/services/retell-adapter");
const events = require("../src/services/provider-webhook-events");
const { createRetellWebhookHandler } = require("../src/routes/retell-webhook-handler");

const FULL_ENV = {
  RETELL_ENABLED: "true",
  RETELL_API_KEY: "key_ABC123SECRET",
  RETELL_LIVE_WRITES_ENABLED: "true",
  RETELL_LIVE_CALLS_ENABLED: "true",
  RETELL_DRY_RUN: "false",
  RETELL_DEFAULT_VOICE_ID: "retell-Example",
  RETELL_OUTBOUND_ONBOARDING_NUMBER: "+61491570006",
  RETELL_WEBHOOK_ENABLED: "true",
  RETELL_WEBHOOK_BASE_URL: "https://example.com.au",
};

// ── Configuration ───────────────────────────────────────────────────

describe("retell configuration — dormant by default", () => {
  it("every dangerous capability is off with an empty env", () => {
    const c = cfg.getRetellConfig({});
    assert.strictEqual(c.enabled, false);
    assert.strictEqual(c.webhookEnabled, false);
    assert.strictEqual(c.liveWritesEnabled, false);
    assert.strictEqual(c.liveCallsEnabled, false);
    assert.strictEqual(c.dryRun, true, "dry-run is ON by default");
    assert.strictEqual(c.hasApiKey, false);
    assert.strictEqual(c.outboundOnboardingNumber, null);
    assert.strictEqual(c.inboundDemoNumber, null);
    assert.strictEqual(c.defaultVoiceId, null, "no voice id may be invented");
    assert.strictEqual(c.recordingEnabled, false, "recording stays off pending legal wording");
  });

  it("only the exact string \"true\" enables each dangerous flag", () => {
    for (const [flag, fn] of [
      ["RETELL_ENABLED", cfg.isRetellEnabled],
      ["RETELL_WEBHOOK_ENABLED", cfg.isWebhookEnabled],
      ["RETELL_LIVE_WRITES_ENABLED", cfg.isLiveWritesEnabled],
      ["RETELL_LIVE_CALLS_ENABLED", cfg.isLiveCallsEnabled],
    ]) {
      assert.strictEqual(fn({ [flag]: "true" }), true, `${flag}=true must enable`);
      for (const v of ["TRUE", "True", "1", "yes", "on", "false", "", undefined]) {
        assert.strictEqual(fn({ [flag]: v }), false, `${flag}=${JSON.stringify(v)} must NOT enable`);
      }
      assert.strictEqual(fn({}), false, `${flag} unset must not enable`);
    }
  });

  it("dry-run is inverted: only the exact string \"false\" leaves it", () => {
    assert.strictEqual(cfg.isDryRun({}), true);
    assert.strictEqual(cfg.isDryRun({ RETELL_DRY_RUN: "false" }), false);
    for (const v of ["FALSE", "0", "no", "off", "true", ""]) {
      assert.strictEqual(cfg.isDryRun({ RETELL_DRY_RUN: v }), true, `${JSON.stringify(v)} must keep dry-run on`);
    }
  });

  it("rejects a base URL that is not a bare https origin", () => {
    assert.strictEqual(cfg.parseBaseUrl(undefined), cfg.DEFAULT_API_BASE_URL);
    assert.strictEqual(cfg.parseBaseUrl("https://api.retellai.com"), "https://api.retellai.com");
    for (const bad of ["http://api.retellai.com", "https://api.retellai.com/v2", "https://api.retellai.com/?x=1", "not a url", "ftp://x.com", "https://x.com/#f"]) {
      assert.strictEqual(cfg.parseBaseUrl(bad), null, `${bad} must be refused`);
    }
  });

  it("an invalid base URL is fatal once the integration is enabled", () => {
    const { fatal } = cfg.assessRetellConfig({ ...FULL_ENV, RETELL_API_BASE_URL: "http://insecure.example" });
    assert.ok(fatal.some((f) => f.name === "RETELL_API_BASE_URL"));
  });

  it("contributes nothing to startup output while disabled", () => {
    assert.deepStrictEqual(cfg.assessRetellConfig({}), { enabled: false, fatal: [], warnings: [] });
    assert.deepStrictEqual(cfg.assessRetellConfig({ RETELL_API_KEY: "k", RETELL_LIVE_CALLS_ENABLED: "true" }).fatal, []);
  });

  it("a missing API key is fatal once enabled", () => {
    const { fatal } = cfg.assessRetellConfig({ RETELL_ENABLED: "true" });
    assert.ok(fatal.some((f) => f.name === "RETELL_API_KEY"));
  });

  it("enabling live writes without a voice id is fatal", () => {
    const { fatal } = cfg.assessRetellConfig({ RETELL_ENABLED: "true", RETELL_API_KEY: "k", RETELL_LIVE_WRITES_ENABLED: "true" });
    assert.ok(fatal.some((f) => f.name === "RETELL_DEFAULT_VOICE_ID"));
  });

  it("enabling live calls without a from-number is fatal", () => {
    const { fatal } = cfg.assessRetellConfig({ RETELL_ENABLED: "true", RETELL_API_KEY: "k", RETELL_LIVE_CALLS_ENABLED: "true" });
    assert.ok(fatal.some((f) => f.name === "RETELL_OUTBOUND_ONBOARDING_NUMBER"));
  });
});

describe("capability gates", () => {
  it("live writes are refused under the shipped configuration, with reasons", () => {
    const verdict = cfg.canWriteLive({});
    assert.strictEqual(verdict.allowed, false);
    assert.ok(verdict.reasons.length >= 4);
    assert.ok(verdict.reasons.some((r) => /RETELL_ENABLED/.test(r)));
    assert.ok(verdict.reasons.some((r) => /RETELL_API_KEY/.test(r)));
    assert.ok(verdict.reasons.some((r) => /DRY_RUN/.test(r)));
  });

  it("placing a call is strictly harder than writing", () => {
    const writeOnly = { ...FULL_ENV, RETELL_LIVE_CALLS_ENABLED: "false" };
    assert.strictEqual(cfg.canWriteLive(writeOnly).allowed, true);
    assert.strictEqual(cfg.canPlaceCall(writeOnly).allowed, false, "writing must not imply calling");
    assert.strictEqual(cfg.canPlaceCall(FULL_ENV).allowed, true);
  });

  it("dry-run alone blocks every live write even when all flags are set", () => {
    const dry = { ...FULL_ENV, RETELL_DRY_RUN: "true" };
    assert.strictEqual(cfg.canWriteLive(dry).allowed, false);
    assert.strictEqual(cfg.canPlaceCall(dry).allowed, false);
  });

  it("webhook verification requires the API key, because the key IS the signing secret", () => {
    assert.strictEqual(cfg.canVerifyWebhook({ RETELL_ENABLED: "true", RETELL_WEBHOOK_ENABLED: "true" }).allowed, false);
    assert.strictEqual(cfg.canVerifyWebhook(FULL_ENV).allowed, true);
  });
});

describe("secret redaction", () => {
  it("never emits an API key", () => {
    const out = cfg.redactSecrets({ apiKey: "key_ABC123", api_key: "key_ABC123", authorization: "Bearer key_ABC123", nested: { secret: "s3cr3t" } });
    const serialised = JSON.stringify(out);
    assert.ok(!serialised.includes("key_ABC123"), "API key leaked");
    assert.ok(!serialised.includes("s3cr3t"));
    assert.strictEqual(out.apiKey, cfg.REDACTED);
  });

  it("masks phone numbers to the last two digits", () => {
    assert.match(cfg.maskPhone("+61491570006"), /^\+61.*06$/);
    assert.ok(!cfg.maskPhone("+61491570006").includes("491570"));
    const out = cfg.redactSecrets({ to_number: "+61491570006", from_number: "+61390000000" });
    assert.ok(!JSON.stringify(out).includes("491570006"));
  });

  it("replaces bulk content with a size marker rather than the content", () => {
    const out = cfg.redactSecrets({ transcript: "AIDA: hello ".repeat(50), general_prompt: "x".repeat(500) });
    assert.match(out.transcript, /^\[transcript:\d+ chars\]$/);
    assert.match(out.general_prompt, /^\[general_prompt:\d+ chars\]$/);
  });

  it("the safe config summary reports key PRESENCE, never the key", () => {
    const summary = cfg.toSafeConfigSummary(FULL_ENV);
    assert.strictEqual(summary.apiKeyConfigured, true);
    assert.ok(!("apiKey" in summary));
    assert.ok(!JSON.stringify(summary).includes("key_ABC123SECRET"));
    assert.ok(!JSON.stringify(summary).includes("491570006"), "the outbound number must be masked");
  });
});

// ── Provider port ───────────────────────────────────────────────────

describe("provider port — disabled adapter", () => {
  it("refuses every operation, descriptively, without throwing", async () => {
    const adapter = port.createDisabledAdapter({ reasons: ["the integration is off"] });
    for (const op of port.OPERATIONS) {
      if (op === "verifyWebhook") continue;
      const result = await adapter[op]({});
      assert.strictEqual(result.ok, false, `${op} must refuse`);
      assert.strictEqual(result.error.code, port.ERROR_CODES.disabled);
      assert.strictEqual(result.error.retryable, false, "a disabled provider is not a retryable condition");
      assert.match(result.error.message, /the integration is off/);
    }
  });

  it("refuses webhook verification too", async () => {
    const v = await port.createDisabledAdapter().verifyWebhook({});
    assert.strictEqual(v.verified, false);
  });
});

describe("provider port — mock adapter", () => {
  it("is deterministic: the same request yields the same id", async () => {
    const a = await port.createMockAdapter().createAgent({ payload: { name: "x" } });
    const b = await port.createMockAdapter().createAgent({ payload: { name: "x" } });
    assert.strictEqual(a.resource.id, b.resource.id);
    const c = await port.createMockAdapter().createAgent({ payload: { name: "y" } });
    assert.notStrictEqual(a.resource.id, c.resource.id);
  });

  it("can be told to fail deterministically", async () => {
    const adapter = port.createMockAdapter({ failures: { createAgent: { status: 429 } } });
    const result = await adapter.createAgent({ payload: {} });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, port.ERROR_CODES.rateLimited);
    assert.strictEqual(result.error.retryable, true);
  });

  it("never verifies a webhook unless a test explicitly says so", async () => {
    const adapter = port.createMockAdapter();
    assert.strictEqual((await adapter.verifyWebhook({})).verified, false);
    assert.strictEqual((await adapter.verifyWebhook({ mockVerified: true })).verified, true);
  });

  it("does not echo the request payload back to the caller", async () => {
    const result = await port.createMockAdapter().createAgent({ payload: { general_prompt: "secret business rules" } });
    assert.ok(!JSON.stringify(result.resource).includes("secret business rules"));
  });
});

describe("provider port — dry-run adapter", () => {
  it("records what would be sent and executes nothing", async () => {
    const recorder = [];
    const adapter = port.createDryRunAdapter({ recorder });
    const result = await adapter.createAgent({ payload: { a: 1 } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.executed, false);
    assert.strictEqual(result.wouldSend, true);
    assert.strictEqual(result.resource.id, null, "a dry run must not invent a provider id");
    assert.strictEqual(recorder.length, 1);
    assert.strictEqual(recorder[0].operation, "createAgent");
  });

  it("has no code path to a network call", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/services/voice-platform-port.js"), "utf8");
    const dryRunSection = source.slice(source.indexOf("function createDryRunAdapter"), source.indexOf("// ── Adapter selection"));
    assert.ok(!/fetch|http|require\(/.test(dryRunSection), "the dry-run adapter must contain no transport");
  });
});

describe("provider port — error normalisation", () => {
  it("maps provider statuses to a closed vocabulary with correct retryability", () => {
    const cases = [
      [400, port.ERROR_CODES.invalidRequest, false],
      [401, port.ERROR_CODES.unauthorized, false],
      [402, port.ERROR_CODES.invalidRequest, false],
      [404, port.ERROR_CODES.notFound, false],
      [422, port.ERROR_CODES.invalidRequest, false],
      [429, port.ERROR_CODES.rateLimited, true],
      [500, port.ERROR_CODES.providerError, true],
      [503, port.ERROR_CODES.providerError, true],
    ];
    for (const [status, code, retryable] of cases) {
      const n = port.normaliseProviderError({ status });
      assert.strictEqual(n.code, code, `status ${status}`);
      assert.strictEqual(n.retryable, retryable, `status ${status} retryable`);
    }
  });

  it("distinguishes a timeout from an unreachable host", () => {
    assert.strictEqual(port.normaliseProviderError({ status: null, cause: "timeout" }).code, port.ERROR_CODES.timeout);
    assert.strictEqual(port.normaliseProviderError({ status: null, cause: "ECONNREFUSED" }).code, port.ERROR_CODES.network);
  });

  it("preserves the provider request id and truncates the provider message", () => {
    const n = port.normaliseProviderError({ status: 400, body: { message: "x".repeat(500) }, providerRequestId: "req_123" });
    assert.strictEqual(n.providerRequestId, "req_123");
    assert.ok(n.message.length < 300);
  });
});

describe("idempotency keys and hashing", () => {
  it("the same logical operation always produces the same key", () => {
    const args = { clientId: "c", purpose: "receptionist_agent", resourceType: "voice_agent", payloadHash: "abc", planId: "p1" };
    assert.strictEqual(port.idempotencyKey(args), port.idempotencyKey({ ...args }));
  });

  it("any input change produces a different key", () => {
    const base = { clientId: "c", purpose: "receptionist_agent", resourceType: "voice_agent", payloadHash: "abc", planId: "p1" };
    const key = port.idempotencyKey(base);
    for (const field of ["clientId", "purpose", "resourceType", "payloadHash", "planId"]) {
      assert.notStrictEqual(port.idempotencyKey({ ...base, [field]: "different" }), key, `${field} must affect the key`);
    }
  });

  it("payload hashing is insensitive to property order", () => {
    assert.strictEqual(port.payloadHash({ a: 1, b: 2 }), port.payloadHash({ b: 2, a: 1 }));
    assert.notStrictEqual(port.payloadHash({ a: 1 }), port.payloadHash({ a: 2 }));
  });
});

// ── Live adapter inertness ──────────────────────────────────────────

describe("the live Retell adapter cannot act during tests", () => {
  it("refuses every write when no transport is injected, even with every flag set", async () => {
    const adapter = createRetellAdapter({ config: cfg.getRetellConfig(FULL_ENV), env: FULL_ENV, logger: { error() {}, log() {} } });
    for (const op of ["createAgent", "createResponseEngine", "createKnowledgeBase", "createPhoneCall"]) {
      const result = await adapter[op]({ payload: {}, providerId: "x" });
      assert.strictEqual(result.ok, false, `${op} must refuse`);
      assert.strictEqual(result.error.code, port.ERROR_CODES.misconfigured);
      assert.match(result.error.message, /no HTTP transport/);
    }
  });

  it("refuses when the capability gate fails, before considering transport", async () => {
    const adapter = createRetellAdapter({ config: cfg.getRetellConfig({}), env: {}, fetchImpl: () => { throw new Error("network was reached"); } });
    const result = await adapter.createAgent({ payload: {} });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, port.ERROR_CODES.notPermitted);
  });

  it("reports unsupported operations rather than improvising them", async () => {
    const adapter = createRetellAdapter({ config: cfg.getRetellConfig(FULL_ENV), env: FULL_ENV });
    for (const op of ["archiveProviderResource", "createOrUpdateAnalysisSchema"]) {
      const result = await adapter[op]({});
      assert.strictEqual(result.error.code, port.ERROR_CODES.unsupported);
      assert.strictEqual(result.error.retryable, false);
    }
  });

  it("puts the API key in the Authorization header and nowhere else", () => {
    const { buildRequest } = require("../src/services/retell-adapter");
    const req = buildRequest({ config: cfg.getRetellConfig(FULL_ENV), endpoint: { method: "POST", path: "/create-agent" }, body: { a: 1 }, idempotencyKey: "aida_x" });
    assert.strictEqual(req.headers.Authorization, "Bearer key_ABC123SECRET");
    assert.ok(!req.body.includes("key_ABC123SECRET"), "the key must never appear in a body");
    assert.strictEqual(req.headers["X-Aida-Idempotency-Key"], "aida_x");
  });
});

describe("adapter selection is pessimistic", () => {
  it("returns the disabled adapter when the integration is off", () => {
    const adapter = port.selectAdapter({ config: cfg.getRetellConfig({}), capability: cfg.canWriteLive({}) });
    assert.strictEqual(adapter.mode, port.MODES.disabled);
  });

  it("returns the dry-run adapter while dry-run is on, even with full config", () => {
    const env = { ...FULL_ENV, RETELL_DRY_RUN: "true" };
    const adapter = port.selectAdapter({ config: cfg.getRetellConfig(env), capability: cfg.canWriteLive(env) });
    assert.strictEqual(adapter.mode, port.MODES.dryRun);
  });

  it("only an explicit caller can select the mock adapter", () => {
    assert.strictEqual(port.selectAdapter({ config: cfg.getRetellConfig({}), explicitMode: port.MODES.mock }).mode, port.MODES.mock);
    assert.notStrictEqual(port.selectAdapter({ config: cfg.getRetellConfig({}) }).mode, port.MODES.mock);
  });
});

// ── Webhook signature boundary ──────────────────────────────────────

describe("webhook signature header parsing", () => {
  it("accepts the documented v={ts},d={hex} shape", () => {
    const parsed = verify.parseSignatureHeader("v=1754006400000,d=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    assert.ok(parsed);
    assert.strictEqual(parsed.timestampMs, 1754006400000);
  });

  it("refuses anything else rather than reading it leniently", () => {
    const bads = [
      "", "abc", "v=,d=abc", "d=abc,v=123", "v=123", "v=123,d=nothex!!",
      `v=1,d=${"a".repeat(300)}`, "x".repeat(600),
      // WRONG-LENGTH DIGESTS. The digest is HMAC-SHA256, so it is always
      // exactly 64 hex characters — the SDK's own parser enforces that
      // (lib/webhook_auth.js, read 2026-08-02). A short or long digest is a
      // malformed header, not a failed cryptographic check, and reporting it as
      // the latter would make two different operational problems look identical.
      `v=1,d=${"a".repeat(32)}`,
      `v=1,d=${"a".repeat(63)}`,
      `v=1,d=${"a".repeat(65)}`,
    ];
    for (const bad of bads) {
      assert.strictEqual(verify.parseSignatureHeader(bad), null, `${bad.slice(0, 30)} must be refused`);
    }
  });

  it("accepts exactly 64 hex characters, in either case", () => {
    assert.ok(verify.parseSignatureHeader(`v=1754006400000,d=${"a".repeat(64)}`));
    assert.ok(verify.parseSignatureHeader(`v=1754006400000,d=${"A".repeat(64)}`));
  });

  it("enforces the documented 5-minute replay window", () => {
    const now = 1754006400000;
    assert.strictEqual(verify.isWithinReplayWindow(now, now), true);
    assert.strictEqual(verify.isWithinReplayWindow(now - 4 * 60 * 1000, now), true);
    assert.strictEqual(verify.isWithinReplayWindow(now - 6 * 60 * 1000, now), false, "a 6-minute-old signature is a replay");
    assert.strictEqual(verify.isWithinReplayWindow(now + 6 * 60 * 1000, now), false, "far-future skew is refused too");
  });
});

describe("webhook verification fails closed", () => {
  const body = JSON.stringify({ event: "call_started", call: { call_id: "call_1" } });
  const headers = (extra = {}) => ({ "content-type": "application/json", "x-retell-signature": "v=1754006400000,d=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", ...extra });
  const now = () => 1754006400000;

  it("refuses when the webhook is disabled", async () => {
    const v = await verify.verifyRetellWebhook({ rawBody: body, headers: headers(), deps: { env: {}, now } });
    assert.strictEqual(v.verified, false);
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.disabled);
  });

  it("refuses a missing signature", async () => {
    const h = headers();
    delete h["x-retell-signature"];
    const v = await verify.verifyRetellWebhook({ rawBody: body, headers: h, deps: { env: FULL_ENV, now } });
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.missingSignature);
  });

  it("refuses a non-JSON content type", async () => {
    const v = await verify.verifyRetellWebhook({ rawBody: body, headers: headers({ "content-type": "text/plain" }), deps: { env: FULL_ENV, now } });
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.badContentType);
  });

  it("refuses an oversized payload before verifying anything", async () => {
    const huge = "x".repeat(600 * 1024);
    const v = await verify.verifyRetellWebhook({ rawBody: huge, headers: headers(), deps: { env: FULL_ENV, now } });
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.oversize);
  });

  it("refuses a stale signature", async () => {
    const v = await verify.verifyRetellWebhook({ rawBody: body, headers: headers(), deps: { env: FULL_ENV, now: () => 1754006400000 + 10 * 60 * 1000 } });
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.staleSignature);
  });

  it("refuses when the official verifier is unavailable — it does NOT improvise an HMAC", async () => {
    const v = await verify.verifyRetellWebhook({ rawBody: body, headers: headers(), deps: { env: FULL_ENV, now, verifier: null } });
    assert.strictEqual(v.verified, false);
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.unavailable);
    assert.match(v.detail, /official retell-sdk verifier is not installed/);
  });

  it("accepts only when the official verifier returns true", async () => {
    const good = await verify.verifyRetellWebhook({ rawBody: body, headers: headers(), deps: { env: FULL_ENV, now, verifier: async () => true } });
    assert.strictEqual(good.verified, true);
    const bad = await verify.verifyRetellWebhook({ rawBody: body, headers: headers(), deps: { env: FULL_ENV, now, verifier: async () => false } });
    assert.strictEqual(bad.result, verify.VERIFY_RESULTS.invalidSignature);
  });

  it("treats a throwing verifier as a failure, never as a pass", async () => {
    const v = await verify.verifyRetellWebhook({ rawBody: body, headers: headers(), deps: { env: FULL_ENV, now, verifier: async () => { throw new Error("boom"); } } });
    assert.strictEqual(v.verified, false);
    assert.strictEqual(v.result, verify.VERIFY_RESULTS.invalidSignature);
    assert.ok(!/boom/.test(JSON.stringify(v)), "the verifier's message must not propagate");
  });

  it("passes the RAW body to the verifier, not a re-serialised object", async () => {
    let seen = null;
    await verify.verifyRetellWebhook({ rawBody: Buffer.from(body), headers: headers(), deps: { env: FULL_ENV, now, verifier: async (b) => { seen = b; return true; } } });
    assert.strictEqual(seen, body, "re-serialising would change the bytes and break every signature");
  });

  it("does not reimplement the HMAC anywhere in the module", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/services/retell-webhook-verify.js"), "utf8");
    assert.ok(!/createHmac/.test(source), "the verifier must delegate to the official SDK, not guess the construction");
  });
});

// ── Webhook event domain ────────────────────────────────────────────

describe("webhook events — validation and idempotency", () => {
  const call = { call_id: "call_abc", call_status: "ended", transcript: "AIDA: hello\nOwner: hi" };

  it("only the officially documented event types are known", () => {
    assert.deepStrictEqual(events.KNOWN_EVENT_TYPES, [
      "call_started", "call_ended", "call_analyzed", "transcript_updated",
      "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended",
    ]);
  });

  it("accepts a well-formed envelope", () => {
    const r = events.validateEventEnvelope({ event: "call_ended", call });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.known, true);
    assert.strictEqual(r.providerCallId, "call_abc");
  });

  it("treats an unknown event as acceptable-but-unhandled, not an error", () => {
    const r = events.validateEventEnvelope({ event: "call_teleported", call });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.known, false);
  });

  it("rejects malformed envelopes and implausible call ids", () => {
    assert.strictEqual(events.validateEventEnvelope(null).ok, false);
    assert.strictEqual(events.validateEventEnvelope({ call }).ok, false);
    assert.strictEqual(events.validateEventEnvelope({ event: "call_ended" }).ok, false);
    assert.strictEqual(events.validateEventEnvelope({ event: "call_ended", call: { call_id: "" } }).code, events.REJECT_CODES.missingCallId);
    assert.strictEqual(events.validateEventEnvelope({ event: "call_ended", call: { call_id: "a b" } }).code, events.REJECT_CODES.invalidCallId);
    assert.strictEqual(events.validateEventEnvelope({ event: "call_ended", call: { call_id: "x".repeat(300) } }).code, events.REJECT_CODES.invalidCallId);
  });

  it("fingerprints are stable for a retry and different for a real change", () => {
    const a = events.eventFingerprint({ eventType: "call_ended", providerCallId: "call_abc", call });
    const b = events.eventFingerprint({ eventType: "call_ended", providerCallId: "call_abc", call: { ...call } });
    assert.strictEqual(a, b, "a retried delivery must fingerprint identically");

    assert.notStrictEqual(a, events.eventFingerprint({ eventType: "call_analyzed", providerCallId: "call_abc", call }));
    assert.notStrictEqual(a, events.eventFingerprint({ eventType: "call_ended", providerCallId: "other", call }));
    assert.notStrictEqual(a, events.eventFingerprint({ eventType: "call_ended", providerCallId: "call_abc", call: { ...call, transcript: "different" } }));
  });

  it("the fingerprint never embeds transcript content", () => {
    const fp = events.eventFingerprint({ eventType: "call_ended", providerCallId: "c", call });
    assert.ok(!fp.includes("hello"));
    assert.match(fp, /^[a-f0-9]{64}$/);
  });

  it("event metadata carries counts and flags, never content", () => {
    const meta = events.boundEventMetadata({ ...call, recording_url: "https://provider.example/rec.wav", call_analysis: { x: 1 } });
    assert.strictEqual(meta.transcript_present, true);
    assert.ok(meta.transcript_chars > 0);
    assert.strictEqual(meta.recording_present, true);
    assert.strictEqual(meta.analysis_present, true);
    const serialised = JSON.stringify(meta);
    assert.ok(!serialised.includes("hello"), "transcript content leaked into metadata");
    assert.ok(!serialised.includes("rec.wav"), "recording URL leaked into metadata");
  });

  it("maps only events we are confident about, and leaves mid-call updates unmapped", () => {
    assert.strictEqual(events.toInternalEvent("call_ended"), "onboarding_call.ended");
    assert.strictEqual(events.toInternalEvent("call_analyzed"), "onboarding_call.analysis_received");
    assert.strictEqual(events.toInternalEvent("transcript_updated"), null, "partial mid-call transcripts are deliberately not acted on");
    assert.strictEqual(events.toInternalEvent("invented_event"), null);
  });

  it("decides duplicates, unknowns, unbound calls and mismatches distinctly", () => {
    const envelope = { ok: true, known: true, eventType: "call_ended", providerCallId: "call_abc", call };
    assert.strictEqual(events.decideEventHandling({ envelope, existingEvent: { id: 1 } }).action, "duplicate");
    assert.strictEqual(events.decideEventHandling({ envelope: { ...envelope, known: false } }).action, "ignore");
    assert.strictEqual(events.decideEventHandling({ envelope, binding: null }).action, "record_unbound");
    assert.strictEqual(
      events.decideEventHandling({ envelope: { ...envelope, expectedClientId: "a" }, binding: { clientId: "b" } }).action,
      "reject"
    );
    assert.strictEqual(events.decideEventHandling({ envelope, binding: { clientId: "a", sessionId: "s" } }).action, "process");
  });
});

// ── Webhook HTTP handler ────────────────────────────────────────────

describe("webhook handler — the security boundary end to end", () => {
  function fakeRes() {
    return {
      statusCode: null, body: null, ended: false,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
      end() { this.ended = true; return this; },
    };
  }
  const rawBody = Buffer.from(JSON.stringify({ event: "call_ended", call: { call_id: "call_abc", call_status: "ended" } }));
  const req = (overrides = {}) => ({
    body: rawBody,
    headers: { "content-type": "application/json", "x-retell-signature": "v=1,d=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" },
    ...overrides,
  });

  function eventsStub(overrides = {}) {
    return {
      ...events,
      findEventByFingerprint: async () => null,
      recordEvent: async () => ({ duplicate: false, row: {} }),
      markEventProcessed: async () => true,
      ...overrides,
    };
  }

  it("refuses an unverified event with 401 and never parses the body", async () => {
    let parsed = false;
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: false, result: verify.VERIFY_RESULTS.invalidSignature }),
      events: eventsStub({ validateEventEnvelope: () => { parsed = true; return { ok: true }; } }),
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req(), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(parsed, false, "the body must not be validated before verification passes");
  });

  it("maps each refusal to a sensible status", async () => {
    const cases = [
      [verify.VERIFY_RESULTS.missingSignature, 401],
      [verify.VERIFY_RESULTS.staleSignature, 401],
      [verify.VERIFY_RESULTS.oversize, 413],
      [verify.VERIFY_RESULTS.badContentType, 400],
      [verify.VERIFY_RESULTS.disabled, 503],
      [verify.VERIFY_RESULTS.unavailable, 503],
    ];
    for (const [result, expected] of cases) {
      const handler = createRetellWebhookHandler({ verify: async () => ({ verified: false, result }), events: eventsStub(), logger: { error() {}, log() {} } });
      const res = fakeRes();
      await handler(req(), res);
      assert.strictEqual(res.statusCode, expected, `${result} → ${expected}`);
    }
  });

  it("acknowledges a verified event with 204 BEFORE processing runs", async () => {
    // Retell retries on any non-2xx after a 10-second timeout, so the
    // acknowledgement must not wait on our work. What matters is the ORDER:
    // the response is sent, then processing starts.
    const order = [];
    const res = fakeRes();
    const originalEnd = res.end.bind(res);
    res.end = (...args) => { order.push("responded"); return originalEnd(...args); };

    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: true, result: verify.VERIFY_RESULTS.verified }),
      events: eventsStub(),
      resolveBinding: async () => ({ clientId: "demo", sessionId: "s1" }),
      processor: async () => { order.push("processed"); },
      logger: { error() {}, log() {} },
    });

    await handler(req(), res);
    await new Promise((r) => setImmediate(r)); // let the deferred work run

    assert.strictEqual(res.statusCode, 204);
    assert.deepStrictEqual(order, ["responded", "processed"], "the provider is acknowledged first, then we do our work");
  });

  it("a processor that throws never affects the already-sent response", async () => {
    let marked = null;
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: true, result: verify.VERIFY_RESULTS.verified }),
      events: eventsStub({ markEventProcessed: async (fp, opts) => { marked = opts; return true; } }),
      resolveBinding: async () => ({ clientId: "demo", sessionId: "s1" }),
      processor: async () => { throw new Error("downstream exploded"); },
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req(), res);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(res.statusCode, 204, "the acknowledgement stands");
    assert.strictEqual(marked.status, "failed");
    assert.strictEqual(marked.errorCode, "processing_error");
  });

  it("acknowledges a duplicate without reprocessing", async () => {
    let processed = false;
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: true, result: verify.VERIFY_RESULTS.verified }),
      events: eventsStub({ findEventByFingerprint: async () => ({ id: 1 }) }),
      processor: async () => { processed = true; },
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req(), res);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(processed, false);
  });

  it("rejects a cross-client mismatch with 400 and records it", async () => {
    let recorded = null;
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: true, result: verify.VERIFY_RESULTS.verified }),
      events: eventsStub({
        decideEventHandling: () => ({ action: "reject", code: events.REJECT_CODES.clientMismatch }),
        recordEvent: async (f) => { recorded = f; return { duplicate: false }; },
      }),
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req(), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, events.REJECT_CODES.clientMismatch);
    assert.strictEqual(recorded.processing_status, "failed");
  });

  it("rejects an unparseable body with 400", async () => {
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: true, result: verify.VERIFY_RESULTS.verified }),
      events: eventsStub(),
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req({ body: Buffer.from("{not json") }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "malformed_json");
  });

  it("returns 503 when the event store is unavailable, so the provider retries", async () => {
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: true, result: verify.VERIFY_RESULTS.verified }),
      events: eventsStub({ findEventByFingerprint: async () => { throw new Error("locksmith onboarding tables not provisioned"); } }),
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req(), res);
    assert.strictEqual(res.statusCode, 503);
  });

  it("never puts a secret, a signature or body content in the response", async () => {
    const handler = createRetellWebhookHandler({
      verify: async () => ({ verified: false, result: verify.VERIFY_RESULTS.invalidSignature, detail: "v=1,d=deadbeef" }),
      events: eventsStub(),
      logger: { error() {}, log() {} },
    });
    const res = fakeRes();
    await handler(req(), res);
    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes("deadbeef"), "the signature must never be echoed");
    assert.ok(!serialised.includes("call_abc"));
  });
});

describe("webhook route is dormant by default", () => {
  it("the gate exits the router unless BOTH flags are true", () => {
    const { retellWebhookGate } = require("../src/routes/retell-webhook");
    for (const env of [{}, { RETELL_ENABLED: "true" }, { RETELL_WEBHOOK_ENABLED: "true" }, { RETELL_ENABLED: "true", RETELL_WEBHOOK_ENABLED: "1" }]) {
      let called = "never";
      retellWebhookGate(env)({}, {}, (arg) => { called = arg; });
      assert.strictEqual(called, "router", `env ${JSON.stringify(env)} must 404`);
    }
    let called = "never";
    retellWebhookGate({ RETELL_ENABLED: "true", RETELL_WEBHOOK_ENABLED: "true" })({}, {}, (arg) => { called = arg; });
    assert.strictEqual(called, undefined);
  });
});
