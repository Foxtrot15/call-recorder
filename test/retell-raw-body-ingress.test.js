// RETELL RAW-BODY INGRESS (E-12L) — driven through the real Express stack.
//
// ── THE DEFECT ──────────────────────────────────────────────────────
// `express.json()` was mounted globally above both Retell webhook routes. For
// any `application/json` request it parsed the body, replaced `req.body` with
// an object and marked the request consumed — and body-parser's raw parser
// skips a consumed request (body-parser/lib/types/raw.js:60). So each route's
// own `express.raw()` did nothing, the handler received an object rather than a
// Buffer, and `String(object)` handed the verifier the literal nine characters
// `[object Object]`.
//
// Retell signs the bytes it transmits. A digest over the real body can never
// match a digest over `[object Object]`, so a genuine signed delivery could not
// verify — on either webhook.
//
// ── WHY EVERY EXISTING TEST PASSED ──────────────────────────────────
// Because they build their own `req`. Thirty-three E-11A proofs hand the
// handler `{ headers, body: Buffer.from(...) }` directly, which is the one
// shape the real server did not produce. A test that constructs its own request
// cannot discover a bug in how requests are constructed.
//
// And the live negative smoke passed too: an unsigned request is rejected for
// being unsigned whatever its body looks like. Nothing in a rejection path
// depends on the bytes being right. Only a VALID signature would have exposed
// it, and none has ever been received.
//
// ── SO THESE TESTS SEND REAL HTTP ───────────────────────────────────
// A real listening server built by the real `buildApp()`, real requests over a
// socket, and a verifier spy that records exactly what it was given. No
// fabricated `req`. No fabricated signature — the spy asserts the BYTES, and
// Retell's cryptography is never reimplemented here.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// The real app needs these to construct its routes; no request is made to them.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://wvwemitmmsdytyutaqbm.supabase.co";
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "fixture_service_key_not_real";

const ACQ_PATH = "/webhooks/retell/acquisition";
const ONB_PATH = "/webhooks/retell";

/** Start the REAL app on an ephemeral port. */
async function listen(env, afterPurge = null) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Fresh module graph so flag reads at module load see this env.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  }
  // Anything that must survive the purge — a spy, say — is installed HERE,
  // after it and before the app is built. Installing before the purge simply
  // loses it, which is how the first version of this file failed.
  if (afterPurge) afterPurge();
  const { buildApp } = require("../src/server.js");
  const server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    async close() {
      await new Promise((r) => server.close(r));
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** A real HTTP request. Returns status and body text. */
function request(port, { method = "POST", path: p = ACQ_PATH, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const ENABLED = Object.freeze({
  RETELL_ENABLED: "true",
  RETELL_WEBHOOK_ENABLED: "true",
  RETELL_ACQUISITION_WEBHOOK_ENABLED: "true",
  RETELL_API_KEY: "fixture_key_not_a_real_credential",
});

const json = (o) => JSON.stringify(o);
const H = (extra = {}) => ({ "content-type": "application/json", ...extra });

// ---------------------------------------------------------------------------
// 1. THE BYTES REACH THE VERIFIER
// ---------------------------------------------------------------------------

describe("E-12L: the Retell routes receive the exact transmitted bytes", () => {
  let srv;
  let seen;

  before(async () => {
    seen = [];
    // Spy on the ONE signature authority. It records what it was handed and
    // refuses everything — no signature is fabricated anywhere in this file.
    // Installed after the module purge, or the purge would discard it.
    srv = await listen(ENABLED, () => {
      const verifyPath = require.resolve("../src/services/retell-webhook-verify.js");
      const real = require(verifyPath);
      require.cache[verifyPath].exports = {
        ...real,
        verifyRetellWebhook: async (input) => {
          seen.push({
            isBuffer: Buffer.isBuffer(input.rawBody),
            bytes: Buffer.isBuffer(input.rawBody) ? Buffer.from(input.rawBody) : null,
            asString: Buffer.isBuffer(input.rawBody) ? input.rawBody.toString("utf8") : String(input.rawBody),
            contentType: input.contentType,
          });
          return { verified: false, result: real.VERIFY_RESULTS.missingSignature };
        },
      };
    });
  });

  after(async () => {
    await srv.close();
    delete require.cache[require.resolve("../src/services/retell-webhook-verify.js")];
  });

  it('2-4. the ACQUISITION route gets a Buffer of the exact bytes, not "[object Object]"', async () => {
    seen.length = 0;
    const body = json({ event: "call_ended", call: { call_id: "c1", metadata: { aida_purpose: "locksmith_acquisition" } } });
    await request(srv.port, { path: ACQ_PATH, headers: H(), body });

    assert.strictEqual(seen.length, 1, "the verifier ran");
    assert.strictEqual(seen[0].isBuffer, true, "a Buffer — this is the whole defect");
    assert.strictEqual(seen[0].asString, body, "byte-for-byte what was transmitted");
    assert.notStrictEqual(seen[0].asString, "[object Object]");
  });

  it('2-4b. the ONBOARDING route gets the same treatment', async () => {
    seen.length = 0;
    const body = json({ event: "call_started", call: { call_id: "c2" } });
    await request(srv.port, { path: ONB_PATH, headers: H(), body });

    assert.strictEqual(seen.length, 1, "the verifier ran on the onboarding route too");
    assert.strictEqual(seen[0].isBuffer, true);
    assert.strictEqual(seen[0].asString, body);
  });

  it("5. whitespace survives — a reformatted body is a different signature", async () => {
    seen.length = 0;
    const pretty = '{\n  "event": "call_ended",\n  "call": { "call_id": "c3" }\n}';
    await request(srv.port, { path: ACQ_PATH, headers: H(), body: pretty });

    assert.strictEqual(seen[0].asString, pretty, "every space and newline preserved");
    assert.notStrictEqual(seen[0].asString, json(JSON.parse(pretty)), "not re-serialised");
  });

  it("6. key order survives — re-serialising would reorder and break the digest", async () => {
    seen.length = 0;
    const ordered = '{"zulu":1,"alpha":2,"mike":3}';
    await request(srv.port, { path: ACQ_PATH, headers: H(), body: ordered });

    assert.strictEqual(seen[0].asString, ordered);
    assert.strictEqual(seen[0].asString.indexOf("zulu") < seen[0].asString.indexOf("alpha"), true);
  });

  it("4b. exact byte equality, including a multi-byte character", async () => {
    seen.length = 0;
    const body = json({ event: "call_ended", note: "café — naïve" });
    await request(srv.port, { path: ACQ_PATH, headers: H(), body });

    assert.deepStrictEqual(seen[0].bytes, Buffer.from(body, "utf8"), "byte-identical");
  });

  it("7. nothing re-stringifies a parsed object before verification", () => {
    for (const rel of ["src/routes/acquisition-retell-webhook.js", "src/routes/retell-webhook.js", "src/server.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/^\s*\/\/.*$/gm, "");
      assert.ok(!/JSON\.stringify\(\s*req\.body/.test(src), `${rel} must not re-serialise the parsed body`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE REST OF THE APPLICATION STILL GETS PARSED JSON
// ---------------------------------------------------------------------------

describe("E-12L: moving the webhooks did not break ordinary body parsing", () => {
  let srv;
  before(async () => { srv = await listen(ENABLED); });
  after(async () => { await srv.close(); });

  it("1. a normal JSON route still receives a parsed object", async () => {
    // /client-auth/signup is a public JSON endpoint; it validates the parsed
    // body and answers 400 on a bad one. Reaching a validation answer at all
    // proves express.json() still ran for it.
    const res = await request(srv.port, {
      path: "/client-auth/signup",
      headers: H(),
      body: json({ clientId: "x" }),
    });
    assert.ok(res.status >= 400 && res.status < 500, `expected a validation answer, got ${res.status}`);
    assert.ok(!/\[object Object\]/.test(res.text));
  });

  it("18. a non-webhook GET still works", async () => {
    const res = await request(srv.port, { method: "GET", path: "/health", headers: {} });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.text), { status: "ok" });
  });

  it("25. no raw body is attached to unrelated routes", async () => {
    // express.raw is mounted per-webhook-route, never globally.
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.ok(!/app\.use\(\s*express\.raw/.test(server), "raw must never be global");
    assert.match(server, /app\.use\(express\.json\(\)\)/);
  });

  it("24. the webhook routes are mounted ABOVE both body parsers", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    // CALL forms, not mentions: the comment above the mounts explains the
    // defect and necessarily names `express.json()` while doing so.
    const retellAt = server.indexOf('app.use(require("./routes/retell-webhook"))');
    const acqAt = server.indexOf('app.use(require("./routes/acquisition-retell-webhook"))');
    const jsonAt = server.indexOf("app.use(express.json())");
    const urlAt = server.indexOf("app.use(express.urlencoded");
    assert.ok(retellAt > 0 && acqAt > 0 && jsonAt > 0 && urlAt > 0);
    assert.ok(retellAt < jsonAt, "onboarding webhook above express.json");
    assert.ok(acqAt < jsonAt, "acquisition webhook above express.json");
    assert.ok(retellAt < urlAt && acqAt < urlAt, "and above urlencoded");
  });

  it("19/24b. Twilio routes stay BELOW urlencoded — their signature needs parsed params", () => {
    // Twilio signs the URL plus sorted POST parameters, not raw bytes, so
    // moving it up would have broken what the Retell move fixed.
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    const urlAt = server.indexOf("express.urlencoded");
    for (const twilioRoute of ['"/inbound"', '"/outbound"', '"/recording"']) {
      assert.ok(server.indexOf(twilioRoute) > urlAt, `${twilioRoute} must stay below urlencoded`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. REJECTION SEMANTICS, THROUGH REAL HTTP
// ---------------------------------------------------------------------------

describe("E-12L: what the live probes saw, now reproduced locally", () => {
  let srv;
  before(async () => { srv = await listen(ENABLED); });
  after(async () => { await srv.close(); });

  it("8. unsigned well-formed JSON is rejected as unauthenticated", async () => {
    const res = await request(srv.port, { path: ACQ_PATH, headers: H(), body: json({ event: "call_ended" }) });
    assert.strictEqual(res.status, 401);
  });

  it("9/10. a signature-shaped header that is not one is still 401", async () => {
    const res = await request(srv.port, {
      path: ACQ_PATH,
      headers: H({ "x-retell-signature": "not-a-real-signature" }),
      body: json({ event: "call_ended" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("9b. UNSIGNED MALFORMED JSON IS NOW 401, NOT 400 — the deliberate change", async () => {
    // Before the fix, global express.json() met a malformed body first and
    // answered 400 before verification ran. That is why the live smoke recorded
    // 400 here while an unsigned well-formed body got 401.
    //
    // With the parser removed from the path, the route now verifies first, so
    // an unsigned malformed body is refused for the reason that actually
    // applies: it is unsigned. Auth-first is the E-11A contract, and this makes
    // the observable behaviour match it.
    const res = await request(srv.port, { path: ACQ_PATH, headers: H(), body: "{not json" });
    assert.strictEqual(res.status, 401, "auth-first: unsigned is unsigned regardless of shape");
  });

  it("16. the wrong content type is still rejected", async () => {
    const res = await request(srv.port, {
      path: ACQ_PATH,
      headers: { "content-type": "text/plain" },
      body: "probe=e12l",
    });
    assert.ok(res.status === 400 || res.status === 401 || res.status === 415, `got ${res.status}`);
    assert.ok(res.status < 500);
  });

  it("17. oversize is still refused, and the cap still exists", async () => {
    const { getRetellConfig } = require("../src/config/retell");
    const cap = getRetellConfig(ENABLED).webhookMaxBytes;
    assert.strictEqual(cap, 524288, "the byte cap was not weakened to get raw access");
    const res = await request(srv.port, {
      path: ACQ_PATH,
      headers: H(),
      body: `{"pad":"${"x".repeat(cap + 2048)}"}`,
    });
    assert.ok(res.status === 413 || res.status === 401, `got ${res.status}`);
  });

  it("1b. GET on the webhook path is not a webhook", async () => {
    const res = await request(srv.port, { method: "GET", path: ACQ_PATH, headers: {} });
    assert.ok(res.status === 404 || res.status === 405, `got ${res.status}`);
  });
});

// ---------------------------------------------------------------------------
// 4. DORMANCY IS UNCHANGED BY THE MOVE
// ---------------------------------------------------------------------------

describe("E-12L: flags off still means the routes do not exist", () => {
  it("21. the acquisition webhook 404s with its flag off", async () => {
    const srv = await listen({ ...ENABLED, RETELL_ACQUISITION_WEBHOOK_ENABLED: undefined });
    try {
      const res = await request(srv.port, { path: ACQ_PATH, headers: H(), body: json({ event: "x" }) });
      assert.strictEqual(res.status, 404, "byte-identical to the route not existing");
    } finally {
      await srv.close();
    }
  });

  it("22. the onboarding webhook 404s with its flag off, and acquisition is unaffected", async () => {
    const srv = await listen({ ...ENABLED, RETELL_WEBHOOK_ENABLED: undefined });
    try {
      // Both gates require RETELL_WEBHOOK_ENABLED, so both close.
      assert.strictEqual((await request(srv.port, { path: ONB_PATH, headers: H(), body: json({}) })).status, 404);
      assert.strictEqual((await request(srv.port, { path: ACQ_PATH, headers: H(), body: json({}) })).status, 404);
    } finally {
      await srv.close();
    }
  });

  it("21b. with everything off, the whole integration is invisible", async () => {
    const srv = await listen({ RETELL_ENABLED: undefined, RETELL_WEBHOOK_ENABLED: undefined, RETELL_ACQUISITION_WEBHOOK_ENABLED: undefined, RETELL_API_KEY: undefined });
    try {
      assert.strictEqual((await request(srv.port, { path: ACQ_PATH, headers: H(), body: json({}) })).status, 404);
      assert.strictEqual((await request(srv.port, { path: ONB_PATH, headers: H(), body: json({}) })).status, 404);
      // And the app still serves everything else.
      assert.strictEqual((await request(srv.port, { method: "GET", path: "/health", headers: {} })).status, 200);
    } finally {
      await srv.close();
    }
  });

  it("20. the app still builds with no Twilio credentials", async () => {
    const srv = await listen({ ...ENABLED, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined });
    try {
      assert.strictEqual((await request(srv.port, { method: "GET", path: "/health", headers: {} })).status, 200);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. NOTHING PERSISTED, AND NO SECOND CRYPTO
// ---------------------------------------------------------------------------

describe("E-12L: no unsigned request reaches acquisition state", () => {
  it("15/23. rejected requests never construct the durable layer", () => {
    // The composition is built on first request AFTER the gate; a rejected
    // request never reaches the handler that resolves it. Asserted structurally
    // because a DEV write is exactly what must not happen to prove it.
    const route = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "acquisition-retell-webhook.js"), "utf8");
    const gateAt = route.indexOf("router.use(acquisitionWebhookGate())");
    const mountAt = route.indexOf("createAcquisitionWebhookHandler({ resolveDeps");
    assert.ok(gateAt > 0 && mountAt > gateAt, "the gate precedes the handler mount");

    // And the durable layer is now built by the HANDLER, after verification —
    // not by the route entry before it. E-12D built it first, so an unsigned
    // request contacted the database and got a 503 where 401 was the truth.
    const handler = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "acquisition-retell-webhook-handler.js"), "utf8");
    const verifyAt = handler.search(/await verify\(/);
    const depsAt = handler.indexOf("resolveDeps()");
    assert.ok(verifyAt > 0 && depsAt > verifyAt, "deps are resolved only after verification");
  });

  it("13/14. both handlers verify before they parse", () => {
    for (const rel of ["src/routes/acquisition-retell-webhook-handler.js", "src/routes/retell-webhook-handler.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      const verifyAt = src.search(/await verify\(|verify\(\{/);
      const parseAt = src.indexOf("JSON.parse(");
      assert.ok(verifyAt > 0, `${rel}: verification found`);
      assert.ok(parseAt > verifyAt, `${rel}: JSON.parse must come after verification`);
    }
  });

  it("12. the tests reimplement no Retell cryptography", () => {
    // Usage forms, not mentions — the assertion above names these functions in
    // order to forbid them, and banning the word would mean deleting the check.
    const self = fs
      .readFileSync(__filename, "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/assert\.ok\(![^\n]*\n/g, "");
    for (const usage of [/require\(["'](node:)?crypto["']\)/, /\bcreateHmac\s*\(/, /\btimingSafeEqual\s*\(/]) {
      assert.ok(!usage.test(self), `${usage} must not appear — no second signature implementation`);
    }
    // And no real credential is read into the fixture environment.
    assert.ok(!/RETELL_API_KEY\s*=\s*process\.env/.test(self));
  });

  it("11. the verifier remains the single authority in both routes", () => {
    for (const rel of ["src/routes/acquisition-retell-webhook-handler.js", "src/routes/retell-webhook-handler.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      assert.match(src, /verifyRetellWebhook/, `${rel} uses the shared verifier`);
      assert.ok(!/createHmac|createHash\(/.test(src), `${rel} implements no crypto of its own`);
    }
  });
});
