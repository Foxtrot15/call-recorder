// AIDA — M7F-B2: signature-verifying webhooks must receive the RAW body.
//
// ─── THE BUG THIS EXISTS FOR ────────────────────────────────────────
// server.js mounted `express.json()` globally ABOVE the three webhook routes.
// body-parser marks a request `_body = true` once it has read the stream, and
// every later parser skips a request already marked — so `express.json()`
// consumed the body, each route's own `express.raw()` skipped, and `req.body`
// arrived as a PARSED OBJECT instead of a Buffer.
//
// Verification then hashed `String({...})`, the literal "[object Object]", and
// every correctly signed webhook was rejected as `invalid_signature`.
//
// ─── WHY THE EXISTING SUITE MISSED IT ───────────────────────────────
// Every other webhook test calls the handler directly with a hand-built
// `req.body` Buffer. That bypasses Express entirely, so it can prove the
// handler's logic and can NEVER prove the mounting is right — the same lesson
// M7D taught about fakes that differ from the boundary they stand in for.
//
// So these tests drive a REAL Express app over a REAL socket. That is the only
// arrangement in which this class of defect is visible.
//
// Loopback only. No external host, no provider, no database.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const express = require("express");
const { INBOUND_WEBHOOK_PATH } = require("../src/config/retell");
const { createInboundWebhookHandler } = require("../src/routes/retell-inbound-webhook-handler");

const KEY = "key_fixture_not_real_for_raw_body_test";
const ENV = Object.freeze({
  NODE_ENV: "development",
  RETELL_ENABLED: "true",
  RETELL_INBOUND_WEBHOOK_ENABLED: "true",
  RETELL_API_KEY: KEY,
  RETELL_ALLOWED_TAG: "dev",
});

// ACMA fictitious range only.
const BODY = JSON.stringify({
  event: "call_inbound",
  event_timestamp: 1785600000000,
  call_inbound: { agent_id: "agent_raw_body_fixture", agent_version: 0, from_number: "+61491570110", to_number: "+61491570156" },
});

let sdk = null;
try { sdk = require("retell-sdk"); } catch { sdk = null; }

/**
 * An app shaped like server.js: the webhook mounted relative to a global JSON
 * parser. `webhooksFirst` is the thing under test.
 */
function buildApp({ webhooksFirst }) {
  const app = express();
  const bodyShape = {};

  const router = express.Router();
  router.post(
    INBOUND_WEBHOOK_PATH,
    express.raw({ type: "application/json", limit: 512 * 1024 }),
    (req, res, next) => { bodyShape.isBuffer = Buffer.isBuffer(req.body); next(); },
    createInboundWebhookHandler({ env: ENV, logger: { log() {}, error() {} }, resolveContext: async () => null })
  );

  if (webhooksFirst) app.use(router);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  if (!webhooksFirst) app.use(router);

  return { app, bodyShape };
}

function post(port, headers) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path: INBOUND_WEBHOOK_PATH, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(BODY), ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => { let parsed = null; try { parsed = JSON.parse(data); } catch { parsed = data; } resolve({ status: res.statusCode, body: parsed }); });
      }
    );
    req.on("error", (e) => resolve({ status: "ERR", body: e.message }));
    req.write(BODY);
    req.end();
  });
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, port: server.address().port };
}

describe("a correctly signed webhook must be ACCEPTED through a real Express stack", () => {
  test("mounted BEFORE the global JSON parser: raw Buffer, 200", { skip: !sdk }, async () => {
    const { app, bodyShape } = buildApp({ webhooksFirst: true });
    const { server, port } = await listen(app);
    try {
      const signature = await sdk.sign(BODY, KEY);
      const res = await post(port, { "x-retell-signature": signature });
      assert.equal(bodyShape.isBuffer, true, "express.raw must have produced a Buffer");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { call_inbound: {} });
    } finally { server.close(); }
  });

  test("mounted AFTER it: body is not a Buffer and a GENUINE signature is rejected", { skip: !sdk }, async () => {
    // This is the deployed failure, reproduced. It is kept as a test so the
    // ordering can never silently regress: if someone moves the webhook mounts
    // back below the parsers, the test above fails and this one explains why.
    const { app, bodyShape } = buildApp({ webhooksFirst: false });
    const { server, port } = await listen(app);
    try {
      const signature = await sdk.sign(BODY, KEY);
      const res = await post(port, { "x-retell-signature": signature });
      assert.equal(bodyShape.isBuffer, false, "express.json() consumed the stream first");
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "invalid_signature");
    } finally { server.close(); }
  });

  test("the refusals look IDENTICAL either way — which is why this hid", async () => {
    // Unsigned and forged requests never touch the body, so both orderings
    // refuse them correctly. Two of three checks passing is exactly what made
    // the deployed service look healthy while no real webhook could work.
    for (const webhooksFirst of [true, false]) {
      const { app } = buildApp({ webhooksFirst });
      const { server, port } = await listen(app);
      try {
        const unsigned = await post(port, {});
        assert.equal(unsigned.status, 401);
        assert.equal(unsigned.body.error, "missing_signature");

        const forged = await post(port, { "x-retell-signature": `v=${Date.now()},d=${"a".repeat(64)}` });
        assert.equal(forged.status, 401);
        assert.equal(forged.body.error, "invalid_signature");
      } finally { server.close(); }
    }
  });
});

describe("server.js mounts the raw-body webhooks above the parsers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const lineOf = (needle) => source.split("\n").findIndex((l) => l.includes(needle) && !l.trimStart().startsWith("//"));

  const WEBHOOKS = ["routes/stripe-webhook", "routes/retell-webhook", "routes/retell-inbound-webhook"];

  test("every signature-verifying webhook is mounted before express.json()", () => {
    const jsonLine = lineOf("express.json()");
    assert.ok(jsonLine > 0, "express.json() should be mounted");
    for (const hook of WEBHOOKS) {
      const hookLine = lineOf(hook);
      assert.ok(hookLine > 0, `${hook} should be mounted`);
      assert.ok(hookLine < jsonLine, `${hook} is mounted at line ${hookLine + 1}, after express.json() at ${jsonLine + 1} — its express.raw parser will be skipped`);
    }
  });

  test("and before express.urlencoded(), which marks the body the same way", () => {
    const urlencodedLine = lineOf("express.urlencoded");
    for (const hook of WEBHOOKS) {
      assert.ok(lineOf(hook) < urlencodedLine, `${hook} must precede express.urlencoded`);
    }
  });
});
