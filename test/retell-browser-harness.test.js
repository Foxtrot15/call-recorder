// AIDA — M7C: the isolated browser web-call harness (Proof C integration).
//
// NO TEST HERE CONTACTS RETELL. The harness's `createCall` is injected, so the
// HTTP surface is exercised end to end over loopback without a provider.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const harnessModule = require("../src/services/retell-browser-harness");
const sandbox = require("../src/services/retell-web-sandbox");
const port = require("../src/services/voice-platform-port");

const SILENT = { log() {}, error() {} };
const TOKEN = "tok_super_secret_value";

function okCall() {
  return { ok: true, callId: "call_1", agentId: "agent_1", callType: "web_call", callStatus: "registered", accessToken: TOKEN };
}

/** Start a real loopback server, run a request against it, shut it down. */
async function withHarness(overrides, fn) {
  const created = [];
  const harness = harnessModule.createBrowserHarness({
    agentId: "agent_1",
    language: "en-AU",
    logger: SILENT,
    createCall: async () => { created.push(1); return (overrides && overrides.createCall ? overrides.createCall() : okCall()); },
    ...(overrides && overrides.harness ? overrides.harness : {}),
  });
  const started = await harnessModule.startBrowserHarness(harness, { logger: SILENT });
  try {
    return await fn({ harness, started, created, key: harness.harnessKey });
  } finally {
    await started.close();
  }
}

function request(port_, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: port_, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Endpoint security ───────────────────────────────────────────────

describe("harness endpoint security", () => {
  test("binds to loopback only", async () => {
    await withHarness(null, async ({ started }) => {
      assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal(started.server.address().address, "127.0.0.1");
    });
  });

  test("a GET on the page creates NO call", async () => {
    await withHarness(null, async ({ started, created }) => {
      const res = await request(started.port, { path: "/" });
      assert.equal(res.status, 200);
      assert.match(res.body, /INTERNAL SANDBOX/);
      assert.equal(created.length, 0, "loading the page must never spend money");
    });
  });

  test("a GET on the call endpoint is refused and creates nothing", async () => {
    await withHarness(null, async ({ started, created }) => {
      const res = await request(started.port, { path: "/api/web-call" });
      assert.equal(res.status, 405);
      assert.equal(created.length, 0, "a prefetch or crawler must not create a call");
    });
  });

  test("an unauthenticated POST is rejected", async () => {
    await withHarness(null, async ({ started, created }) => {
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(res.status, 401);
      assert.equal(created.length, 0);
    });
  });

  test("a POST with the wrong key is rejected", async () => {
    await withHarness(null, async ({ started, created, key }) => {
      const wrong = "x".repeat(key.length);
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": wrong }, body: "{}" });
      assert.equal(res.status, 401);
      assert.equal(created.length, 0);
    });
  });

  test("an authenticated POST creates exactly one call", async () => {
    await withHarness(null, async ({ started, created, key }) => {
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      assert.equal(res.status, 201);
      assert.equal(created.length, 1);
    });
  });

  test("the harness stops at its call ceiling", async () => {
    await withHarness(null, async ({ harness, started, created, key }) => {
      // A single call could not complete the six manual validation checks the
      // harness exists for, so the limit is a small ceiling rather than one.
      // The ceiling still stops a stuck loop spending without bound.
      const limit = harness.state.maxCalls;
      assert.ok(limit >= 1 && limit <= 10, "the ceiling must stay small");

      for (let i = 0; i < limit; i++) {
        const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
        assert.equal(res.status, 201, `call ${i + 1} of ${limit} should succeed`);
      }

      const overLimit = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      assert.equal(overLimit.status, 429, "a stuck loop must not spend without bound");
      assert.equal(created.length, limit, "no call may be created beyond the ceiling");
    });
  });

  test("a provider failure surfaces as an error without a token", async () => {
    await withHarness({ createCall: () => ({ ok: false, code: "provider_error", message: "The provider did not create the call." }) }, async ({ started, key }) => {
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      assert.equal(res.status, 502);
      assert.ok(!res.body.includes("accessToken"));
    });
  });
});

// ── Browser-safe response ───────────────────────────────────────────

describe("browser-safe response", () => {
  test("carries only the minimum a browser needs", async () => {
    await withHarness(null, async ({ started, key }) => {
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      const body = JSON.parse(res.body);
      assert.deepEqual(Object.keys(body).sort(), ["accessToken", "agentId", "callId", "callType", "tokenWindowSeconds"]);
      assert.equal(body.callType, "web_call");
      assert.equal(body.tokenWindowSeconds, harnessModule.TOKEN_WINDOW_SECONDS);
    });
  });

  test("leaks nothing about the knowledge base, prompt or provider request", async () => {
    await withHarness(null, async ({ started, key }) => {
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      for (const forbidden of ["knowledge", "prompt", "llm_id", "general_prompt", "metadata", "api_key"]) {
        assert.ok(!res.body.includes(forbidden), `the response must not mention ${forbidden}`);
      }
    });
  });

  test("the token is returned only to the initiating request, and never cached", async () => {
    await withHarness(null, async ({ started, key }) => {
      const res = await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      assert.ok(res.body.includes(TOKEN), "the initiating browser does receive it");
      assert.match(res.headers["cache-control"], /no-store/);
    });
  });
});

// ── Token sinks ─────────────────────────────────────────────────────

describe("token handling", () => {
  test("the page HTML contains no token", () => {
    const page = harnessModule.renderHarnessPage({ agentId: "agent_1", language: "en-AU" });
    assert.ok(!page.includes(TOKEN));
    assert.ok(!/accessToken\s*[:=]\s*["'][A-Za-z0-9_-]{8,}/.test(page), "no token literal in source");
  });

  test("the page uses NO persistent storage sink", () => {
    const page = harnessModule.renderHarnessPage({});
    for (const sink of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
      assert.ok(!page.includes(sink), `${sink} must never be used`);
    }
  });

  test("the token is never placed in a URL", () => {
    const page = harnessModule.renderHarnessPage({});
    // The fetch has no query string, and nothing appends a token to a location.
    assert.ok(!/[?&](token|accessToken|access_token)=/.test(page));
    assert.ok(!/location\.(href|assign|replace)\s*[=(][^;]*token/i.test(page));
  });

  test("the page drops its token reference after use", () => {
    const page = harnessModule.renderHarnessPage({});
    assert.match(page, /token = null/, "the reference must be cleared whether or not the call connected");
  });

  test("the harness never logs the token", async () => {
    const logged = [];
    await withHarness({ harness: { logger: { log: (m) => logged.push(String(m)), error: (m) => logged.push(String(m)) } } }, async ({ started, key }) => {
      await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      const all = logged.join("\n");
      assert.ok(!all.includes(TOKEN), "no log line may contain the token");
      assert.ok(all.includes("call_1"), "but the call id is logged, which is safe");
    });
  });

  test("the sanitised view shows presence, never the value", () => {
    const safe = harnessModule.browserSafeResponse(okCall());
    const display = harnessModule.sanitiseForDisplay(safe);
    assert.ok(!JSON.stringify(display).includes(TOKEN));
    assert.match(display.accessToken, /not displayed/);
  });

  test("the state endpoint never exposes a token", async () => {
    await withHarness(null, async ({ started, key }) => {
      await request(started.port, { method: "POST", path: "/api/web-call", headers: { "x-aida-sandbox-key": key }, body: "{}" });
      const res = await request(started.port, { path: "/api/state" });
      assert.ok(!res.body.includes(TOKEN));
      assert.match(res.body, /callsCreated/);
    });
  });

  test("the adapter's one-shot reader cannot be harvested twice", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const { getRetellConfig } = require("../src/config/retell");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ call_id: "c1", agent_id: "a1", call_type: "web_call", access_token: TOKEN }) });
    const a = createRetellAdapter({ config: getRetellConfig(env), env, fetchImpl });
    const r = await a.createWebCall({ payload: {}, idempotencyKey: null });

    assert.ok(!JSON.stringify(r).includes(TOKEN), "the token is not an enumerable property");
    assert.equal(r.takeAccessToken(), TOKEN);
    assert.equal(r.takeAccessToken(), null, "a second read gets nothing");
  });
});

// ── Call verification through the shared path ───────────────────────

describe("call creation verification", () => {
  test("resolves the CALL id, not the agent id", async () => {
    // Regression: extractResource scanned agent_id before call_id, so a web
    // call was recorded under its agent's id.
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const { getRetellConfig } = require("../src/config/retell");
    const env = { RETELL_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true", RETELL_DRY_RUN: "false", RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_ALLOWED_TAG: "dev" };
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ call_id: "call_abc", agent_id: "agent_1", call_type: "web_call", call_status: "registered", access_token: TOKEN }) });
    const a = createRetellAdapter({ config: getRetellConfig(env), env, fetchImpl });
    const r = await a.createWebCall({ payload: {}, idempotencyKey: null });
    assert.equal(r.resource.id, "call_abc");
    assert.equal(r.resource.agentId, "agent_1");
    assert.equal(r.resource.callType, "web_call");
  });

  test("a wrong agent id is rejected before the token is used", async () => {
    const adapter = { ...port.createMockAdapter(), createWebCall: async () => ({
      ok: true, resource: { id: "c1", agentId: "SOMEONE_ELSE", callType: "web_call", status: "registered" }, takeAccessToken: () => TOKEN,
    }) };
    const r = await sandbox.createSandboxWebCall({ adapter, agentId: "agent_1", logger: SILENT });
    assert.equal(r.ok, false);
    assert.equal(r.code, "call_verification_failed");
  });

  test("a wrong call type is rejected", async () => {
    const adapter = { ...port.createMockAdapter(), createWebCall: async () => ({
      ok: true, resource: { id: "c1", agentId: "agent_1", callType: "phone_call", status: "registered" }, takeAccessToken: () => TOKEN,
    }) };
    const r = await sandbox.createSandboxWebCall({ adapter, agentId: "agent_1", logger: SILENT });
    assert.equal(r.ok, false);
  });

  test("a missing token is rejected", async () => {
    const adapter = { ...port.createMockAdapter(), createWebCall: async () => ({
      ok: true, resource: { id: "c1", agentId: "agent_1", callType: "web_call", status: "registered" }, takeAccessToken: () => null,
    }) };
    const r = await sandbox.createSandboxWebCall({ adapter, agentId: "agent_1", logger: SILENT });
    assert.equal(r.ok, false);
  });

  test("no agent means no call attempt at all", async () => {
    let called = false;
    const adapter = { createWebCall: async () => { called = true; } };
    const r = await sandbox.createSandboxWebCall({ adapter, agentId: null, logger: SILENT });
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });

  test("dynamic variables come from the SHARED runtime builder", () => {
    const dyn = require("../src/services/retell-dynamic-variables");
    const vars = sandbox.buildSandboxDynamicVariables();

    // Every key must be allow-listed by the shared module, and every one must
    // be a RUNTIME key — proving the sandbox does not bake runtime-sensitive
    // values into the agent's provisioning-time defaults.
    for (const k of Object.keys(vars)) {
      assert.ok(dyn.ALLOWED_KEYS.includes(k), `${k} must be allow-listed`);
      assert.ok(dyn.RUNTIME_ONLY_KEYS.includes(k), `${k} must be supplied per call, not baked in`);
      assert.equal(typeof vars[k], "string", `${k} must be a string`);
    }
    assert.ok(Object.keys(vars).length > 0);
  });

  test("the web-call payload carries those variables and no real data", () => {
    const payload = sandbox.buildSandboxWebCallPayload({ agentId: "a1" });
    assert.deepEqual(Object.keys(payload.retell_llm_dynamic_variables), Object.keys(sandbox.buildSandboxDynamicVariables()));
    assert.equal(payload.metadata.aida_client_id, "none");
    // Only the ACMA fictitious range may appear.
    const numbers = JSON.stringify(payload).match(/\+?61\d{9}/g) || [];
    for (const n of numbers) assert.match(n, /^\+?61491570(0\d\d|1[0-5]\d)$/, `${n} must be an ACMA fictitious number`);
  });
});

// ── SDK boundary ────────────────────────────────────────────────────

describe("browser SDK boundary", () => {
  test("the browser SDK is not installed in this repository", () => {
    let present = true;
    try { require.resolve("retell-client-js-sdk"); } catch { present = false; }
    assert.equal(present, false, "installing it would modify the historical package-lock.json");
  });

  test("no server or domain module imports the browser SDK", () => {
    const fs = require("fs");
    const path = require("path");
    const roots = ["src/services", "src/config", "src/routes", "scripts"];
    for (const root of roots) {
      const dir = path.join(__dirname, "..", root);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".js")) continue;
        const src = fs.readFileSync(path.join(dir, f), "utf8");
        assert.ok(!/require\(["']retell-client-js-sdk["']\)/.test(src), `${root}/${f} must not require the browser SDK`);
        assert.ok(!/^\s*import .*retell-client-js-sdk/m.test(src), `${root}/${f} must not import the browser SDK`);
      }
    }
  });

  test("the SDK appears ONLY as a browser module import in the served page", () => {
    const page = harnessModule.renderHarnessPage({});
    assert.match(page, /import \{ RetellWebClient \} from "https:\/\/esm\.sh\/retell-client-js-sdk/);
    assert.match(page, /<script type="module">/);
  });

  test("the SDK specifier is configurable, not hard-wired", () => {
    const page = harnessModule.renderHarnessPage({ sdkSpecifier: "retell-client-js-sdk@9.9.9" });
    assert.match(page, /retell-client-js-sdk@9\.9\.9/);
  });

  test("the domain layer knows nothing of browser concepts", () => {
    const fs = require("fs");
    const path = require("path");
    for (const f of ["locksmith-receptionist-compiler.js", "provisioning-plan.js", "voice-platform-port.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
      for (const browserish of ["RetellWebClient", "startCall(", "stopCall(", "navigator.mediaDevices", "localStorage"]) {
        assert.ok(!src.includes(browserish), `${f} must not mention the browser concept "${browserish}"`);
      }
    }
  });
});

// ── Page behaviour ──────────────────────────────────────────────────

describe("harness page", () => {
  test("declares itself an internal sandbox", () => {
    const page = harnessModule.renderHarnessPage({});
    assert.match(page, /INTERNAL SANDBOX/);
    assert.match(page, /NOT A CUSTOMER INTERFACE/);
    assert.match(page, /billable/i);
  });

  test("has start, stop, state and error surfaces", () => {
    const page = harnessModule.renderHarnessPage({});
    for (const id of ['id="start"', 'id="stop"', 'id="state"', 'id="error"', 'id="mic"', 'id="callId"']) {
      assert.ok(page.includes(id), `missing ${id}`);
    }
  });

  test("subscribes to the documented SDK events", () => {
    const page = harnessModule.renderHarnessPage({});
    for (const ev of ["call_started", "call_ready", "agent_start_talking", "agent_stop_talking", "call_ended", "error"]) {
      assert.ok(page.includes(`"${ev}"`), `missing handler for ${ev}`);
    }
  });

  test("creates nothing until the button is clicked", () => {
    const page = harnessModule.renderHarnessPage({});
    const beforeHandler = page.split('$("start").addEventListener')[0];
    assert.ok(!beforeHandler.includes("/api/web-call"), "no call request outside the click handler");
    assert.ok(!beforeHandler.includes("startCall("), "no join outside the click handler");
  });

  test("redacts long token-shaped strings from displayed errors", () => {
    const page = harnessModule.renderHarnessPage({});
    assert.match(page, /\[redacted\]/);
  });

  test("is marked noindex and served without caching", async () => {
    await withHarness(null, async ({ started }) => {
      const res = await request(started.port, { path: "/" });
      assert.match(res.body, /noindex, nofollow/);
      assert.match(res.headers["cache-control"], /no-store/);
      assert.equal(res.headers["referrer-policy"], "no-referrer");
    });
  });
});
