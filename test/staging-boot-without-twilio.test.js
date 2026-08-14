// STAGING BOOT — the server must start without Twilio credentials.
//
// ── WHAT HAPPENED ───────────────────────────────────────────────────
// The first staging deploy passed its configuration check ("Config check
// passed (10 warnings)") and then died anyway:
//
//   Error: username is required
//     at .../twilio/lib/base/BaseTwilio.js
//     at /app/src/routes/call.js:7:16
//
// `routes/call.js` built a Twilio client at MODULE SCOPE. Requiring the module
// constructed it, the SDK refused an undefined account sid, and the throw
// happened during `server.js`'s import of the router — before anything was
// mounted. One unconfigured integration took down every unrelated route,
// including the acquisition webhook, which never touches Twilio.
//
// ── WHY NOT JUST ADD THE CREDENTIALS ────────────────────────────────
// Because staging deliberately has none. A runtime that cannot authenticate to
// Twilio cannot dial a customer by accident, and that property is worth more
// than the convenience of a uniform environment. The fix is for the server to
// boot without optional integrations, not for every environment to hold every
// credential.
//
// ── THE RULE ────────────────────────────────────────────────────────
// Importing a module must not construct an external client. Build it on first
// use, fail closed when it cannot be built, and never substitute a placeholder
// credential.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Load a module with a given env, restoring the real one afterwards. */
function loadWith(env, relPath) {
  const saved = {};
  const keys = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const abs = require.resolve(path.join(SRC, relPath));
    delete require.cache[abs];
    return require(abs);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    const abs = require.resolve(path.join(SRC, relPath));
    delete require.cache[abs];
  }
}

// Supabase must be present or its own client throws for unrelated reasons —
// this file is about Twilio, so the other required config is supplied.
const STAGING_ENV = Object.freeze({
  SUPABASE_URL: "https://wvwemitmmsdytyutaqbm.supabase.co",
  SUPABASE_SERVICE_KEY: "fixture_service_key_not_a_real_credential",
});

// ---------------------------------------------------------------------------
// 1-3. IMPORTING MUST NOT CONSTRUCT
// ---------------------------------------------------------------------------

describe("staging boot: routes load without Twilio credentials", () => {
  it("1. routes/call.js loads with no TWILIO_ACCOUNT_SID", () => {
    assert.doesNotThrow(() => loadWith({ ...STAGING_ENV, TWILIO_AUTH_TOKEN: "token_only" }, "routes/call.js"));
  });

  it("2. routes/call.js loads with no TWILIO_AUTH_TOKEN", () => {
    assert.doesNotThrow(() => loadWith({ ...STAGING_ENV, TWILIO_ACCOUNT_SID: "ACfixture" }, "routes/call.js"));
  });

  it("2b. routes/call.js loads with neither — the exact staging condition", () => {
    assert.doesNotThrow(() => loadWith({ ...STAGING_ENV }, "routes/call.js"));
  });

  it("3. every Twilio-touching route imported by server.js loads credential-free", () => {
    // The deploy died on the first of these. It must not die on the next one.
    for (const rel of [
      "routes/call.js",
      "routes/inbound.js",
      "routes/outbound.js",
      "routes/recording.js",
      "routes/voip-webhooks.js",
      "routes/voip.js",
      "middleware/auth.js",
    ]) {
      assert.doesNotThrow(() => loadWith({ ...STAGING_ENV }, rel), `${rel} must not construct a client at import`);
    }
  });

  it("3b. no module mounted by server.js calls twilio() at module scope", () => {
    // Structural, so a future `const client = twilio(...)` fails here rather
    // than in a deploy log. Indentation distinguishes module scope from a call
    // inside a function, which is the pattern recording.js already uses.
    const server = read("server.js");
    const mounted = [...server.matchAll(/require\("\.\/(routes\/[a-z0-9-]+|middleware\/[a-z0-9-]+)"\)/g)].map((m) => `${m[1]}.js`);
    assert.ok(mounted.length > 5, "sanity: found the mounted modules");
    for (const rel of mounted) {
      const file = path.join(SRC, rel);
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, "utf8");
      const offenders = body.split(/\r?\n/).filter((l) => /^(const|let|var)\s+\w+\s*=\s*twilio\s*\(/.test(l));
      assert.deepStrictEqual(offenders, [], `${rel} constructs Twilio at module scope`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4-6. FAIL CLOSED, WITHOUT INVENTING CREDENTIALS
// ---------------------------------------------------------------------------

describe("staging boot: Twilio-dependent behaviour fails closed", () => {
  it("4. POST /call/initiate answers 503 when telephony is unconfigured", async () => {
    const router = loadWith({ ...STAGING_ENV }, "routes/call.js");
    const layer = router.stack.find((l) => l.route && l.route.path === "/initiate");
    assert.ok(layer, "sanity: the route exists");

    let status = null;
    let body = null;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    await layer.route.stack[0].handle({ body: { to: "0400000000" }, clientId: "fixture" }, res, () => {});

    assert.strictEqual(status, 503, "unconfigured telephony must refuse, not attempt");
    assert.match(body.error, /not configured/i);
  });

  it("4b. it refuses BEFORE doing any work — no database read, no dial", async () => {
    // The 503 is returned above the loop-guard lookup, so an unconfigured
    // deployment does not touch Supabase to answer a call it cannot place.
    const body = read("routes/call.js");
    // The CALL SITE, not the import on line 5 — an earlier version of this
    // assertion matched the require and passed for the wrong reason.
    const guardAt = body.indexOf("await fetchLoopGuardData(");
    const refuseAt = body.indexOf("Telephony is not configured");
    assert.ok(refuseAt > 0, "the refusal exists");
    assert.ok(guardAt > 0, "the loop-guard call exists");
    assert.ok(refuseAt < guardAt, "the refusal must come before the loop-guard query");
  });

  it("5. with credentials present the client is still built from the same vars", () => {
    const body = read("routes/call.js");
    assert.match(body, /process\.env\.TWILIO_ACCOUNT_SID/);
    assert.match(body, /process\.env\.TWILIO_AUTH_TOKEN/);
    assert.match(body, /twilio\(accountSid,\s*authToken\)/, "same two values, same constructor");
    // Still cached for the process, as it was when it sat at module scope.
    assert.match(body, /if \(_client\) return _client/);
    // And the production dial path is untouched.
    assert.match(body, /client\.calls\.create\(/);
  });

  it("6. there is no dummy, placeholder or fallback credential", () => {
    const body = read("routes/call.js");
    assert.ok(!/TWILIO_ACCOUNT_SID\s*\|\|/.test(body), "no fallback account sid");
    assert.ok(!/TWILIO_AUTH_TOKEN\s*\|\|/.test(body), "no fallback auth token");
    assert.ok(!/["']AC0{10,}["']|["']fake|["']dummy|["']placeholder/i.test(body), "no invented credential");
    // Returning null is the whole point: no client rather than a broken one.
    assert.match(body, /return null/);
  });
});

// ---------------------------------------------------------------------------
// 7. THE ACQUISITION INGRESS IS INDEPENDENT OF TELEPHONY
// ---------------------------------------------------------------------------

describe("staging boot: the acquisition webhook does not depend on Twilio", () => {
  it("10. the acquisition route loads credential-free and keeps its path", () => {
    const route = loadWith({ ...STAGING_ENV }, "routes/acquisition-retell-webhook.js");
    assert.strictEqual(route.ACQUISITION_WEBHOOK_PATH, "/webhooks/retell/acquisition");
    assert.strictEqual(route.isAcquisitionWebhookEnabled({}), false, "still off by default");
  });

  it("10b. it references no Twilio symbol at all", () => {
    for (const rel of ["routes/acquisition-retell-webhook.js", "routes/acquisition-retell-webhook-handler.js"]) {
      assert.ok(!/twilio/i.test(read(rel)), `${rel} must be telephony-free`);
    }
  });

  it("11. this fix introduced no outbound acquisition capability", () => {
    const dial = require("../src/services/acquisition-dial-provider");
    const retell = require("../src/services/acquisition-retell-provider");
    assert.strictEqual(dial.createDisabledDialProvider().live, false);
    assert.strictEqual(dial.createFakeDialProvider().live, false);
    assert.strictEqual(
      retell.createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "+61355500001" } }).live,
      false
    );
    assert.strictEqual(require("../src/config/acquisition").EXTERNAL_SYSTEMS.telephony, false);
  });
});

// ---------------------------------------------------------------------------
// 8. THE RUNBOOK RECORDS THE BUILDER CORRECTION
// ---------------------------------------------------------------------------

describe("staging boot: the documented staging configuration", () => {
  const runbook = fs.readFileSync(path.join(__dirname, "..", "docs", "ACQUISITION_STAGING_RUNBOOK.md"), "utf8");

  it("7. staging keeps NODE_ENV=production", () => {
    assert.match(runbook, /NODE_ENV=production/);
    assert.ok(!/NODE_ENV=development/.test(runbook), "staging is non-production DATA, not relaxed security");
  });

  it("8. it specifies RAILPACK_NODE_VERSION=22", () => {
    assert.match(runbook, /RAILPACK_NODE_VERSION=22/);
  });

  it("9. NIXPACKS_NODE_VERSION is recorded as superseded, not recommended", () => {
    // Naming the wrong variable is how the next person repeats the mistake, so
    // it must appear ONLY as a correction.
    assert.match(runbook, /NIXPACKS_NODE_VERSION/, "the failed attempt is recorded");
    assert.match(runbook, /Railpack/i);
    assert.ok(
      !/^\s*NIXPACKS_NODE_VERSION=22\s*$/m.test(runbook),
      "it must not appear as a variable to set"
    );
  });
});
