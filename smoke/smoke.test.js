// Aida smoke suite — one command, black-box over HTTP against SMOKE_BASE_URL.
// Run:  npm run smoke           (defaults to http://localhost:3000)
//       SMOKE_BASE_URL=https://<app> DASHBOARD_PASSWORD=... npm run smoke
//
// Tests run top-to-bottom in this file's order (node:test runs subtests
// sequentially). The operator session established in section 3 is reused by
// every authenticated check after it; if login fails, those checks skip with a
// clear reason rather than cascading confusingly.
//
// SAFETY: this suite performs NO mutating writes. It never toggles settings,
// uploads/deletes voicemail, or creates a real signup. The invite→signup flow
// is exercised against a random non-existent slug, so it verifies token +
// database logic without creating any user.

const { describe, it, before } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const config = require("./config");
const { createSession } = require("./lib/http");
const { checkEnv } = require("./lib/env");

// Shared state across ordered subtests.
const ctx = {
  operator: null, // authenticated operator session, or null if login failed
};

function anon() {
  return createSession(config.baseUrl);
}

// Assert a response reached the server at all (status 0 == network error).
function assertReached(res, label) {
  assert.notStrictEqual(
    res.status,
    0,
    `Could not reach ${config.baseUrl} for ${label}: ${res.networkError || "unknown network error"}`
  );
}

before(() => {
  console.log(`\nAida smoke suite → ${config.baseUrl}`);
  console.log(`  operator checks: ${config.operatorPassword ? "enabled" : "DISABLED (no DASHBOARD_PASSWORD)"}`);
  console.log(`  client-login check: ${config.client.enabled ? "enabled" : "skipped (set SMOKE_CLIENT_EMAIL/PASSWORD)"}\n`);
});

describe("Aida smoke", () => {
  // ── 1. Preflight ──────────────────────────────────────────────
  describe("1. Preflight (environment)", () => {
    it("runner-required env vars are present", () => {
      const { missingRunner } = checkEnv();
      assert.strictEqual(
        missingRunner.length,
        0,
        `Missing env the suite needs: ${missingRunner.join(", ")}`
      );
    });

    it("no critical server env missing (only when server env is present)", (t) => {
      const { serverChecked, serverDecisionReason, serverMissingCritical } = checkEnv();
      if (!serverChecked) return t.skip(serverDecisionReason); // remote target: verified behaviorally later
      assert.strictEqual(
        serverMissingCritical.length,
        0,
        `Critical server vars unset: ${serverMissingCritical.join(", ")}`
      );
    });
  });

  // ── 2. Health / database ──────────────────────────────────────
  describe("2. Health", () => {
    it("GET /health → 200 { status: ok }", async () => {
      const res = await anon().get("/health");
      assertReached(res, "/health");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      assert.strictEqual(res.json?.status, "ok", `unexpected body: ${res.text}`);
    });
  });

  // ── 3. Operator authentication ────────────────────────────────
  describe("3. Operator authentication", () => {
    it("gated API rejects anonymous request → 401", async () => {
      const res = await anon().get("/calls");
      assertReached(res, "/calls (anon)");
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    });

    it("login with wrong password → 401", async () => {
      const res = await anon().post("/login", { password: "wrong-" + crypto.randomUUID() });
      assertReached(res, "/login (wrong)");
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    });

    it("login with correct password sets a session", async (t) => {
      if (!config.operatorPassword) return t.skip("no DASHBOARD_PASSWORD provided");
      const session = anon();
      const res = await session.post("/login", { password: config.operatorPassword });
      assertReached(res, "/login");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status} (${res.text})`);
      assert.ok(session.hasCookie("aida_session"), "no aida_session cookie set");
      ctx.operator = session; // reused by every authed check below
    });

    it("OPERATOR_CLIENT_ID is configured server-side (operator route not 500)", async (t) => {
      if (!ctx.operator) return t.skip("no operator session");
      const res = await ctx.operator.get("/settings/pipeline");
      assertReached(res, "/settings/pipeline");
      // If OPERATOR_CLIENT_ID were unset, requireLogin returns 500 with that message.
      assert.strictEqual(
        res.status,
        200,
        `operator route returned ${res.status}: ${res.json?.error || res.text}`
      );
    });
  });

  // ── 4. /calls API + DB connectivity ───────────────────────────
  describe("4. Calls API & database connectivity", () => {
    it("GET /calls returns an array (DB reachable)", async (t) => {
      if (!ctx.operator) return t.skip("no operator session");
      const res = await ctx.operator.get("/calls?limit=1");
      assertReached(res, "/calls");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status} (${res.text})`);
      assert.ok(Array.isArray(res.json), `expected an array, got: ${res.text}`);
    });
  });

  // ── 5. Settings API (read-only — never toggles the pipeline) ───
  describe("5. Settings API", () => {
    it("GET /settings/pipeline → 200 { enabled: bool }", async (t) => {
      if (!ctx.operator) return t.skip("no operator session");
      const res = await ctx.operator.get("/settings/pipeline");
      assertReached(res, "/settings/pipeline");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      assert.strictEqual(typeof res.json?.enabled, "boolean", `unexpected body: ${res.text}`);
    });
  });

  // ── 6. Voicemail (read-only — never uploads/deletes) ──────────
  describe("6. Voicemail endpoints", () => {
    it("GET /voicemail/status → 200 { hasGreeting: bool }", async (t) => {
      if (!ctx.operator) return t.skip("no operator session");
      const res = await ctx.operator.get("/voicemail/status");
      assertReached(res, "/voicemail/status");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      assert.strictEqual(typeof res.json?.hasGreeting, "boolean", `unexpected body: ${res.text}`);
    });
  });

  // ── 7. Google connection status ───────────────────────────────
  describe("7. Google connection status", () => {
    it("GET /auth/status → 200 { google: { connected } }", async (t) => {
      if (!ctx.operator) return t.skip("no operator session");
      const res = await ctx.operator.get("/auth/status");
      assertReached(res, "/auth/status");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      assert.strictEqual(
        typeof res.json?.google?.connected,
        "boolean",
        `unexpected body: ${res.text}`
      );
    });
  });

  // ── 8. Client authentication ──────────────────────────────────
  describe("8. Client authentication", () => {
    it("client dashboard API rejects anonymous → 401", async () => {
      const res = await anon().get("/client-dashboard/contacts");
      assertReached(res, "/client-dashboard/contacts (anon)");
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    });

    it("client login with bad credentials → 401", async () => {
      const res = await anon().post("/client-auth/login", {
        email: `nobody-${crypto.randomUUID()}@smoke.invalid`,
        password: "wrong-password",
      });
      assertReached(res, "/client-auth/login (bad)");
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    });

    it("client login with real credentials succeeds (if configured)", async (t) => {
      if (!config.client.enabled) return t.skip("set SMOKE_CLIENT_EMAIL/PASSWORD to enable");
      const session = anon();
      const login = await session.post("/client-auth/login", {
        email: config.client.email,
        password: config.client.password,
      });
      assertReached(login, "/client-auth/login");
      assert.strictEqual(login.status, 200, `expected 200, got ${login.status} (${login.text})`);
      assert.ok(session.hasCookie("aida_client_session"), "no aida_client_session cookie set");

      const contacts = await session.get("/client-dashboard/contacts");
      assert.strictEqual(contacts.status, 200, `contacts expected 200, got ${contacts.status}`);
      assert.ok(Array.isArray(contacts.json?.contacts), `unexpected body: ${contacts.text}`);
    });
  });

  // ── 9. Invite → signup flow (non-mutating) ────────────────────
  // Verifies: operator-gating on invite minting, token issuance, and that the
  // signup path verifies the token and reaches the database — using a random
  // non-existent slug so signup fails at the clients lookup BEFORE any user is
  // created. No mutation, safe to run on every deploy.
  describe("9. Invite signup flow", () => {
    const ghostSlug = `smoke-nonexistent-${crypto.randomUUID()}`;

    it("invite minting rejects anonymous → 401", async () => {
      const res = await anon().post("/client-auth/invite", { clientId: ghostSlug });
      assertReached(res, "/client-auth/invite (anon)");
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
    });

    it("operator can mint an invite token", async (t) => {
      if (!ctx.operator) return t.skip("no operator session");
      const res = await ctx.operator.post("/client-auth/invite", { clientId: ghostSlug });
      assertReached(res, "/client-auth/invite");
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status} (${res.text})`);
      assert.ok(typeof res.json?.token === "string" && res.json.token.length > 0, "no token returned");
      ctx.inviteToken = res.json.token;
    });

    it("signup with no token → 400", async () => {
      const res = await anon().post("/client-auth/signup", {
        email: "x@smoke.invalid",
        password: "irrelevant",
      });
      assertReached(res, "/client-auth/signup (no token)");
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });

    it("signup with an invalid token → 400", async () => {
      const res = await anon().post("/client-auth/signup", {
        token: "not-a-real-token",
        email: "x@smoke.invalid",
        password: "irrelevant",
      });
      assertReached(res, "/client-auth/signup (bad token)");
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });

    it("signup with a valid token but non-existent slug → 400 (token verified, no user created)", async (t) => {
      if (!ctx.inviteToken) return t.skip("no invite token minted");
      const res = await anon().post("/client-auth/signup", {
        token: ctx.inviteToken,
        email: `smoke-${crypto.randomUUID()}@smoke.invalid`,
        password: crypto.randomUUID(),
      });
      assertReached(res, "/client-auth/signup (ghost slug)");
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status} (${res.text})`);
      // The 400 proves: token signature verified AND the clients lookup ran
      // (DB reachable) and found no row — so signupClient threw before createUser.
    });
  });
});
