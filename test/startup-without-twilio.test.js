// AIDA — M7F-B2: the server must start without Twilio.
//
// The Railway sandbox crashed at boot with `username is required`, thrown by
// the Twilio constructor from MODULE SCOPE in routes/call.js. Importing a route
// killed the process, so a deployment with no telephony credentials could not
// serve anything — including the Retell inbound webhook, which has nothing to
// do with Twilio.
//
// NO TEST HERE MAKES A NETWORK REQUEST. The Twilio client is only ever built
// through an injected factory.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const twilioClient = require("../src/services/twilio-client");

/**
 * Load routes/call.js with its UNRELATED dependencies stubbed.
 *
 * `services/supabase.js` also builds its client at module scope and throws
 * `supabaseUrl is required` without credentials. That is a SEPARATE latent
 * issue — it is not what crashed Railway, because the deployment does have
 * Supabase credentials and the original stack trace got past that require on
 * its way to the Twilio line. It is deliberately not changed here.
 *
 * Stubbing it, rather than setting a fake SUPABASE_URL, keeps this test honest:
 * the question is whether TWILIO's absence breaks the import, and a fabricated
 * credential would blur that.
 */
function loadCallRoute() {
  const supabasePath = require.resolve("../src/services/supabase.js");
  const hadSupabase = require.cache[supabasePath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: () => ({}) } };
  delete require.cache[require.resolve("../src/routes/call.js")];
  try {
    return require("../src/routes/call.js");
  } finally {
    delete require.cache[require.resolve("../src/routes/call.js")];
    if (hadSupabase) require.cache[supabasePath] = hadSupabase;
    else delete require.cache[supabasePath];
  }
}

/** Run a function with the Twilio variables removed, then restore them. */
function withoutTwilio(fn) {
  const KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"];
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    return fn();
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

describe("importing routes without Twilio credentials", () => {
  test("routes/call.js constructs no Twilio client at import time", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "routes", "call.js"), "utf8");
    for (const line of source.split("\n")) {
      // A top-level statement starts at column 0. An indented one is inside a
      // function, which is the pattern working as intended.
      if (/^\s/.test(line)) continue;
      assert.equal(/=\s*twilio\s*\(/.test(line), false, "no Twilio client may be built at module scope");
      assert.equal(/^const\s+twilio\s*=\s*require\("twilio"\)/.test(line), false, "the SDK must not be required at module scope either");
    }
  });

  test("routes/call.js can be required with every Twilio variable absent", () => {
    withoutTwilio(() => {
      const router = loadCallRoute();
      assert.equal(typeof router.use, "function");
    });
  });

  test("the Retell inbound webhook loads without Twilio", () => {
    withoutTwilio(() => {
      delete require.cache[require.resolve("../src/routes/retell-inbound-webhook.js")];
      const router = require("../src/routes/retell-inbound-webhook.js");
      assert.equal(typeof router.use, "function");
      // And is still dormant by default, which Twilio's absence must not change.
      let nexted = "unset";
      router.retellInboundGate({})({}, {}, (x) => { nexted = x; });
      assert.equal(nexted, "router");
    });
  });

  test("no server-loaded module builds a Twilio client at module scope", () => {
    // services/sms.js does — but it has ZERO importers (confirmed dead code,
    // see PHASE_5_PLAN.md), so it is never loaded by the server. Deleting it is
    // a separate decision; this test asserts only that nothing reachable from
    // server.js has the problem.
    const server = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
    const routed = [...server.matchAll(/require\("\.\/(routes|services|middleware|config)\/([\w-]+)"\)/g)]
      .map((m) => path.join(ROOT, "src", m[1], `${m[2]}.js`))
      .filter((p) => fs.existsSync(p));

    assert.ok(routed.length > 10, "expected server.js to mount many modules");
    for (const file of routed) {
      const source = fs.readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (/^\s/.test(line)) continue;
        assert.equal(/=\s*twilio\s*\(/.test(line), false, `${path.basename(file)} builds a Twilio client at module scope`);
      }
    }
  });
});

describe("the lazy Twilio factory", () => {
  test("reports missing configuration instead of throwing", () => {
    const result = twilioClient.getTwilioClient({ env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.client, null);
    assert.match(result.reason, /TWILIO_ACCOUNT_SID/);
    assert.match(result.reason, /TWILIO_AUTH_TOKEN/);
  });

  test("names each missing setting individually", () => {
    assert.deepEqual(twilioClient.missingTwilioSettings({}), ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]);
    assert.deepEqual(twilioClient.missingTwilioSettings({ TWILIO_ACCOUNT_SID: "AC1" }), ["TWILIO_AUTH_TOKEN"]);
    assert.deepEqual(twilioClient.missingTwilioSettings({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" }), []);
  });

  test("isTwilioConfigured needs both credentials", () => {
    assert.equal(twilioClient.isTwilioConfigured({}), false);
    assert.equal(twilioClient.isTwilioConfigured({ TWILIO_ACCOUNT_SID: "AC1" }), false);
    assert.equal(twilioClient.isTwilioConfigured({ TWILIO_AUTH_TOKEN: "t" }), false);
    assert.equal(twilioClient.isTwilioConfigured({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" }), true);
  });

  test("the client is built ONLY when invoked, and only once", () => {
    twilioClient.resetTwilioClient();
    let built = 0;
    const factory = (sid, token) => { built += 1; return { sid, token, calls: { create: async () => ({}) } }; };
    const env = { TWILIO_ACCOUNT_SID: "AC_fixture", TWILIO_AUTH_TOKEN: "token_fixture" };

    assert.equal(built, 0, "importing must build nothing");
    const first = twilioClient.getTwilioClient({ env, factory });
    assert.equal(first.ok, true);
    assert.equal(built, 1);

    const second = twilioClient.getTwilioClient({ env, factory });
    assert.equal(second.client, first.client, "memoised");
    assert.equal(built, 1, "a second call must not rebuild");
    twilioClient.resetTwilioClient();
  });

  test("changing credentials builds a fresh client", () => {
    twilioClient.resetTwilioClient();
    let built = 0;
    const factory = (sid) => { built += 1; return { sid }; };
    twilioClient.getTwilioClient({ env: { TWILIO_ACCOUNT_SID: "AC_one", TWILIO_AUTH_TOKEN: "t" }, factory });
    twilioClient.getTwilioClient({ env: { TWILIO_ACCOUNT_SID: "AC_two", TWILIO_AUTH_TOKEN: "t" }, factory });
    assert.equal(built, 2);
    twilioClient.resetTwilioClient();
  });

  test("a constructor failure is reported, not swallowed, and never echoes a credential", () => {
    twilioClient.resetTwilioClient();
    const factory = () => { throw new Error("username is required: AC_secret_value"); };
    const result = twilioClient.getTwilioClient({ env: { TWILIO_ACCOUNT_SID: "AC_secret_value", TWILIO_AUTH_TOKEN: "t" }, factory });
    assert.equal(result.ok, false);
    // A present-but-malformed credential is a different problem from an absent
    // one and must not read as "telephony is switched off".
    assert.match(result.reason, /could not be constructed/);
    assert.equal(result.reason.includes("AC_secret_value"), false, "the provider message may echo a credential");
    twilioClient.resetTwilioClient();
  });

  test("no placeholder or dummy credential exists in production code", () => {
    const source = fs.readFileSync(require.resolve("../src/services/twilio-client"), "utf8");
    assert.equal(/\bAC[0-9a-f]{32}\b/.test(source), false);
    assert.equal(/["']AC(test|dummy|placeholder|xxx)/i.test(source), false);
    // The default must be "unavailable", never a fabricated credential.
    assert.equal(/\|\|\s*["']AC/.test(source), false);
    const route = fs.readFileSync(path.join(ROOT, "src", "routes", "call.js"), "utf8");
    assert.equal(/\|\|\s*["']AC/.test(route), false);
  });

  test("the SDK is required lazily, inside a function", () => {
    const source = fs.readFileSync(require.resolve("../src/services/twilio-client"), "utf8");
    for (const line of source.split("\n")) {
      if (/^\s/.test(line)) continue;
      assert.equal(/require\("twilio"\)/.test(line), false, "no module-scope require of the SDK");
    }
    assert.match(source, /require\("twilio"\)/, "but it is required somewhere, inside a function");
  });
});

describe("Twilio-dependent operations fail safely when disabled", () => {
  /** The /call/initiate handler, reached without a server. */
  function initiateHandler() {
    const router = loadCallRoute();
    const layer = router.stack.find((l) => l.route && l.route.path === "/initiate");
    assert.ok(layer, "the /initiate route must exist");
    return layer.route.stack[0].handle;
  }

  test("/call/initiate answers 503 rather than crashing", async () => {
    await withoutTwilio(async () => {
      twilioClient.resetTwilioClient();
      const handler = initiateHandler();
      const out = {};
      const res = {
        status(code) { out.status = code; return this; },
        json(payload) { out.payload = payload; return this; },
      };
      // A missing `to` short-circuits first, so supply one and let the loop
      // guard fail on its own terms if it must — what matters is that no
      // Twilio construction throws out of the handler.
      await handler({ body: { to: "0491570006" }, clientId: "demo" }, res).catch(() => {});
      assert.notEqual(out.status, undefined, "the handler must answer, not throw");
      assert.notEqual(out.status, 200);
    });
  });

  test("a missing destination is still rejected before anything else", async () => {
    await withoutTwilio(async () => {
      const handler = initiateHandler();
      const out = {};
      const res = { status(c) { out.status = c; return this; }, json(p) { out.payload = p; return this; } };
      await handler({ body: {} }, res);
      assert.equal(out.status, 400);
    });
  });
});

describe("configuration posture is unchanged", () => {
  const startup = require("../src/config/startup-check");

  test("the core Twilio variables are warnings, not fatal", () => {
    const env = {
      SUPABASE_URL: "https://fixture.supabase.co",
      SUPABASE_SERVICE_KEY: "service_key_fixture",
      SESSION_SECRET: "session_secret_fixture",
      ENCRYPTION_KEY: "a".repeat(32),
      // VOIP_V2_ENABLED deliberately unset: its Twilio API-key variables are
      // fail-closed ONLY when that feature is switched on (decision D9), and
      // that behaviour must not be weakened by this milestone.
    };
    const assessed = startup.assessConfig(env);
    const fatalNames = assessed.fatal.map((f) => f.name);
    for (const name of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]) {
      assert.equal(fatalNames.includes(name), false, `${name} must not block startup`);
      assert.ok(assessed.warnings.some((w) => w.name === name), `${name} should still warn`);
    }
    assert.deepEqual(fatalNames, [], "nothing should be fatal in this configuration");
  });

  test("VoIP v2 Twilio secrets stay fail-closed when that feature is ON", () => {
    const env = {
      SUPABASE_URL: "https://fixture.supabase.co",
      SUPABASE_SERVICE_KEY: "service_key_fixture",
      SESSION_SECRET: "session_secret_fixture",
      ENCRYPTION_KEY: "a".repeat(32),
      VOIP_V2_ENABLED: "true",
    };
    const fatalNames = startup.assessConfig(env).fatal.map((f) => f.name);
    assert.ok(fatalNames.includes("TWILIO_API_KEY_SID"), "enabling VoIP must still demand its secrets");
    assert.ok(fatalNames.includes("TWILIO_API_KEY_SECRET"));
  });

  test("webhook signature verification is untouched and still lazy", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "middleware", "auth.js"), "utf8");
    assert.match(source, /require\("twilio"\)\.webhook\(/);
    // Validation is disabled only in development, exactly as before.
    assert.match(source, /validate:\s*process\.env\.NODE_ENV\s*!==\s*"development"/);
    // And nothing at module scope constructs it.
    for (const line of source.split("\n")) {
      if (/^\s/.test(line)) continue;
      assert.equal(/=\s*require\("twilio"\)\.webhook/.test(line), false);
    }
  });
});

describe("no provider contact", () => {
  test("nothing in the new factory opens a socket", () => {
    const source = fs.readFileSync(require.resolve("../src/services/twilio-client"), "utf8");
    assert.equal(/fetch\(|https?\.request|axios/.test(source), false);
  });

  test("the factory returns a refusal without any injected transport", () => {
    // With no credentials there is nothing to construct, so no code path can
    // reach the network even if the SDK were present.
    assert.equal(twilioClient.getTwilioClient({ env: {} }).ok, false);
  });
});
