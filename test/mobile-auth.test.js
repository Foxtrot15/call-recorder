// Mobile Authentication Compatibility layer — dual-mode (browser cookie vs
// mobile Bearer) client auth. Proves, per docs/MOBILE_API_CONTRACT.md:
//
//   * ONE validation path serves both transports (createRequireClientAuth);
//   * bearer requests never fall back to cookies (a bad header is a 401,
//     even with a perfectly valid cookie session on the same request);
//   * cookie behaviour is byte-identical to the pre-mobile dashboard
//     (transparent B1 refresh, same 401 bodies, same cookie names/flags);
//   * login/refresh/logout each behave correctly in both modes;
//   * logout revocation is best-effort and never fails the request;
//   * /devices/revoke tenant-scoping rejects malformed ids before any DB call.
//
// Same style as the rest of the suite: pure/lazy modules + injected fakes,
// runs without node_modules or a network — every backend call is a fake.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  extractBearerToken,
  resolveClientCredentials,
  wantsTokenResponse,
  sessionTokenBody,
} = require("../src/services/client-session");
const { createRequireClientAuth } = require("../src/middleware/auth");
const { createClientAuthHandlers } = require("../src/routes/client-auth-handlers");
const { revokeClientSession } = require("../src/services/client-auth");
const { isValidDeviceId, revokeDevice } = require("../src/services/devices");

// ── shared fakes ─────────────────────────────────────────────────────────────

function fakeReq({ authorization, cookies, body, ip } = {}) {
  const headers = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return { headers, cookies: cookies || {}, body: body || {}, ip: ip || "203.0.113.7" };
}

function fakeRes() {
  const out = { statusCode: 200, body: undefined, cookiesSet: [], cookiesCleared: [] };
  const res = {
    out,
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; },
    cookie(name, value, opts) { out.cookiesSet.push({ name, value, opts }); },
    clearCookie(name) { out.cookiesCleared.push(name); },
  };
  return res;
}

const USER = { id: "u-1", email: "client@example.com" };
const CLIENT_ROW = { slug: "pilot-plumbing", name: "Pilot Plumbing", real_number: "+61400000000" };

// Middleware deps: "AT-valid"/"AT-rotated" are live access tokens, "RT-valid"
// is a live refresh token; everything else is dead.
function middlewareDeps(overrides = {}) {
  const calls = { getUser: [], refresh: [], findClient: [] };
  const deps = {
    calls,
    getUser: async (t) => {
      calls.getUser.push(t);
      return t === "AT-valid" || t === "AT-rotated" ? USER : null;
    },
    refreshClientSession: async (rt) => {
      calls.refresh.push(rt);
      if (rt !== "RT-valid") throw new Error("Session refresh failed: Invalid Refresh Token");
      return {
        accessToken: "AT-rotated", refreshToken: "RT-rotated",
        email: USER.email, user: USER, expiresIn: 3600, expiresAt: 1234567890,
      };
    },
    findClientByAuthUserId: async (id) => {
      calls.findClient.push(id);
      return id === USER.id ? CLIENT_ROW : null;
    },
    ...overrides,
  };
  return deps;
}

async function runMiddleware(deps, req) {
  const mw = createRequireClientAuth(deps);
  const res = fakeRes();
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { res, nexted, req };
}

// ── transport policy (pure) ──────────────────────────────────────────────────

describe("bearer token extraction", () => {
  it("accepts a well-formed header, scheme case-insensitively (RFC 7235)", () => {
    assert.strictEqual(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
    assert.strictEqual(extractBearerToken("bearer tok"), "tok");
    assert.strictEqual(extractBearerToken("BEARER tok"), "tok");
  });

  it("rejects missing/malformed headers and wrong schemes", () => {
    for (const bad of [undefined, null, "", "Bearer", "Bearer ", "Basic dXNlcg==",
      "Bearer two tokens", "Bearertok", "tok"]) {
      assert.strictEqual(extractBearerToken(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe("credential resolution (the one transport rule)", () => {
  it("no Authorization header → cookie mode with both cookie tokens", () => {
    const creds = resolveClientCredentials({
      cookies: { [ACCESS_COOKIE]: "AT", [REFRESH_COOKIE]: "RT" },
    });
    assert.deepStrictEqual(creds, { mode: "cookie", accessToken: "AT", refreshToken: "RT" });
  });

  it("Authorization header present → bearer mode, cookies on the request IGNORED", () => {
    const creds = resolveClientCredentials({
      authorizationHeader: "Bearer HEADER-TOKEN",
      cookies: { [ACCESS_COOKIE]: "COOKIE-TOKEN", [REFRESH_COOKIE]: "RT" },
    });
    assert.deepStrictEqual(creds, { mode: "bearer", accessToken: "HEADER-TOKEN", refreshToken: null });
  });

  it("malformed Authorization header → bearer mode with NO token — never a silent cookie fallback", () => {
    const creds = resolveClientCredentials({
      authorizationHeader: "Basic dXNlcjpwdw==",
      cookies: { [ACCESS_COOKIE]: "COOKIE-TOKEN" },
    });
    assert.strictEqual(creds.mode, "bearer");
    assert.strictEqual(creds.accessToken, null);
  });

  it("nothing at all → cookie mode, empty-handed", () => {
    assert.deepStrictEqual(resolveClientCredentials({}), { mode: "cookie", accessToken: null, refreshToken: null });
  });
});

describe("token-mode opt-in + response shape", () => {
  it("only an explicit mode:'tokens' opts in — existing browser bodies never do", () => {
    assert.strictEqual(wantsTokenResponse({ email: "e", password: "p", mode: "tokens" }), true);
    for (const body of [undefined, null, {}, { mode: "cookies" }, { mode: true }, { mode: "TOKENS" }]) {
      assert.strictEqual(wantsTokenResponse(body), false, JSON.stringify(body));
    }
  });

  it("sessionTokenBody: one shape for login and refresh, snake_case, Bearer-typed", () => {
    const body = sessionTokenBody({
      email: "c@x.com", accessToken: "AT", refreshToken: "RT", expiresIn: 3600, expiresAt: 99,
    });
    assert.deepStrictEqual(body, {
      success: true, email: "c@x.com", token_type: "Bearer",
      access_token: "AT", refresh_token: "RT", expires_in: 3600, expires_at: 99,
    });
  });
});

// ── middleware: one path, two transports ─────────────────────────────────────

describe("requireClientAuth — bearer transport", () => {
  it("valid bearer token authenticates, resolves tenant server-side, touches no cookies", async () => {
    const deps = middlewareDeps();
    const { res, nexted, req } = await runMiddleware(deps, fakeReq({ authorization: "Bearer AT-valid" }));
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.clientId, "pilot-plumbing");
    assert.strictEqual(req.client.name, "Pilot Plumbing");
    assert.strictEqual(req.clientAuth.mode, "bearer");
    assert.strictEqual(req.clientAuth.user.email, USER.email);
    assert.deepStrictEqual(res.out.cookiesSet, []);
    assert.deepStrictEqual(res.out.cookiesCleared, []);
  });

  it("expired/invalid bearer token → 401 with machine-readable code, NO transparent refresh", async () => {
    const deps = middlewareDeps();
    const { res, nexted } = await runMiddleware(deps, fakeReq({ authorization: "Bearer AT-expired" }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.out.statusCode, 401);
    assert.strictEqual(res.out.body.code, "invalid_token");
    assert.deepStrictEqual(deps.calls.refresh, [], "bearer mode must never attempt a refresh");
    assert.deepStrictEqual(res.out.cookiesCleared, [], "bearer failures must not clear browser cookies");
  });

  it("MIXED: invalid bearer + perfectly valid session cookies → 401 (no cookie fallback)", async () => {
    const deps = middlewareDeps();
    const { res, nexted } = await runMiddleware(deps, fakeReq({
      authorization: "Bearer AT-forged",
      cookies: { [ACCESS_COOKIE]: "AT-valid", [REFRESH_COOKIE]: "RT-valid" },
    }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.out.statusCode, 401);
    assert.deepStrictEqual(deps.calls.getUser, ["AT-forged"], "cookie token must never be tried");
  });

  it("MIXED: valid bearer + stale cookies → bearer wins, no cookie refresh side-effects", async () => {
    const deps = middlewareDeps();
    const { res, nexted } = await runMiddleware(deps, fakeReq({
      authorization: "Bearer AT-valid",
      cookies: { [ACCESS_COOKIE]: "AT-expired", [REFRESH_COOKIE]: "RT-expired" },
    }));
    assert.strictEqual(nexted, true);
    assert.deepStrictEqual(deps.calls.refresh, []);
    assert.deepStrictEqual(res.out.cookiesSet, []);
  });

  it("valid token but no linked client row → 403 (tenant link is mandatory in both modes)", async () => {
    const deps = middlewareDeps({ findClientByAuthUserId: async () => null });
    const { res, nexted } = await runMiddleware(deps, fakeReq({ authorization: "Bearer AT-valid" }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.out.statusCode, 403);
  });

  it("verification backend throwing fails CLOSED (401), not open", async () => {
    const deps = middlewareDeps({ getUser: async () => { throw new Error("supabase down"); } });
    const { res, nexted } = await runMiddleware(deps, fakeReq({ authorization: "Bearer AT-valid" }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.out.statusCode, 401);
  });
});

describe("requireClientAuth — cookie transport (dashboard regression)", () => {
  it("valid access cookie authenticates exactly as before", async () => {
    const deps = middlewareDeps();
    const { res, nexted, req } = await runMiddleware(deps, fakeReq({
      cookies: { [ACCESS_COOKIE]: "AT-valid", [REFRESH_COOKIE]: "RT-valid" },
    }));
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.clientId, "pilot-plumbing");
    assert.strictEqual(req.clientAuth.mode, "cookie");
    assert.deepStrictEqual(deps.calls.refresh, [], "no refresh while the access token is live");
  });

  it("B1: expired access + live refresh cookie → transparent refresh, rotated pair set, request proceeds", async () => {
    const deps = middlewareDeps();
    const { res, nexted, req } = await runMiddleware(deps, fakeReq({
      cookies: { [ACCESS_COOKIE]: "AT-expired", [REFRESH_COOKIE]: "RT-valid" },
    }));
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.clientId, "pilot-plumbing");
    const names = res.out.cookiesSet.map((c) => c.name).sort();
    assert.deepStrictEqual(names, [ACCESS_COOKIE, REFRESH_COOKIE].sort(), "rotated pair replaces BOTH cookies");
    const access = res.out.cookiesSet.find((c) => c.name === ACCESS_COOKIE);
    assert.strictEqual(access.value, "AT-rotated");
    assert.strictEqual(access.opts.httpOnly, true);
  });

  it("expired access + dead refresh cookie → 401, both cookies cleared, pre-mobile message unchanged", async () => {
    const deps = middlewareDeps();
    const { res, nexted } = await runMiddleware(deps, fakeReq({
      cookies: { [ACCESS_COOKIE]: "AT-expired", [REFRESH_COOKIE]: "RT-dead" },
    }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.out.statusCode, 401);
    assert.strictEqual(res.out.body.error, "Session expired or invalid — please log in again");
    assert.deepStrictEqual(res.out.cookiesCleared.sort(), [ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });

  it("no credentials at all → 401 with the pre-mobile body", async () => {
    const deps = middlewareDeps();
    const { res, nexted } = await runMiddleware(deps, fakeReq({}));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.out.statusCode, 401);
    assert.deepStrictEqual(res.out.body, { error: "Not authenticated" });
  });
});

// ── login / refresh / logout handlers, both transports ──────────────────────

const allow = { check: () => ({ allowed: true }) };
const deny = { check: () => ({ allowed: false, retryAfterMs: 1000 }) };

const SESSION = {
  userId: USER.id, email: USER.email,
  accessToken: "AT-new", refreshToken: "RT-new",
  expiresIn: 3600, expiresAt: 1234567890,
};

function handlerDeps(overrides = {}) {
  const calls = { login: [], refresh: [], revoke: [] };
  return {
    calls,
    loginClient: async (email, password) => {
      calls.login.push({ email, password });
      if (password !== "correct") throw new Error("Login failed: Invalid login credentials");
      return { ...SESSION };
    },
    refreshClientSession: async (rt) => {
      calls.refresh.push(rt);
      if (rt !== "RT-valid") throw new Error("Session refresh failed: Invalid Refresh Token");
      return { ...SESSION, user: USER };
    },
    revokeClientSession: async (tokens) => {
      calls.revoke.push(tokens);
      return { revoked: true, via: "access" };
    },
    loginLimiter: allow,
    refreshLimiter: allow,
    ...overrides,
  };
}

describe("POST /client-auth/login", () => {
  it("browser login: cookies set, body token-free and shaped exactly as before", async () => {
    const deps = handlerDeps();
    const h = createClientAuthHandlers(deps);
    const res = fakeRes();
    await h.login(fakeReq({ body: { email: USER.email, password: "correct" } }), res);
    assert.deepStrictEqual(res.out.body, { success: true, email: USER.email });
    const names = res.out.cookiesSet.map((c) => c.name).sort();
    assert.deepStrictEqual(names, [ACCESS_COOKIE, REFRESH_COOKIE].sort());
    assert.strictEqual(JSON.stringify(res.out.body).includes("AT-new"), false, "no raw tokens for page JS");
  });

  it("mobile login (mode:'tokens'): full pair + expiry in JSON, NO cookies set", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.login(fakeReq({ body: { email: USER.email, password: "correct", mode: "tokens" } }), res);
    assert.deepStrictEqual(res.out.body, {
      success: true, email: USER.email, token_type: "Bearer",
      access_token: "AT-new", refresh_token: "RT-new", expires_in: 3600, expires_at: 1234567890,
    });
    assert.deepStrictEqual(res.out.cookiesSet, [], "token mode must not leave cookie orphans");
  });

  it("bad credentials → 401 in both modes; token mode leaks no partial session", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    for (const body of [
      { email: USER.email, password: "wrong" },
      { email: USER.email, password: "wrong", mode: "tokens" },
    ]) {
      const res = fakeRes();
      await h.login(fakeReq({ body }), res);
      assert.strictEqual(res.out.statusCode, 401);
      assert.strictEqual(JSON.stringify(res.out.body).includes("AT-new"), false);
      assert.deepStrictEqual(res.out.cookiesSet, []);
    }
  });

  it("missing fields → 400 before any auth backend call", async () => {
    const deps = handlerDeps();
    const h = createClientAuthHandlers(deps);
    const res = fakeRes();
    await h.login(fakeReq({ body: { email: USER.email } }), res);
    assert.strictEqual(res.out.statusCode, 400);
    assert.deepStrictEqual(deps.calls.login, []);
  });

  it("rate-limited → 429 with code, before credentials are even read", async () => {
    const deps = handlerDeps({ loginLimiter: deny });
    const h = createClientAuthHandlers(deps);
    const res = fakeRes();
    await h.login(fakeReq({ body: { email: USER.email, password: "correct" } }), res);
    assert.strictEqual(res.out.statusCode, 429);
    assert.strictEqual(res.out.body.code, "rate_limited");
    assert.deepStrictEqual(deps.calls.login, []);
  });
});

describe("POST /client-auth/refresh", () => {
  it("browser refresh (cookie transport): rotated pair re-set as cookies, body token-free", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.refresh(fakeReq({ cookies: { [REFRESH_COOKIE]: "RT-valid" } }), res);
    assert.deepStrictEqual(res.out.body, { success: true, email: USER.email });
    const names = res.out.cookiesSet.map((c) => c.name).sort();
    assert.deepStrictEqual(names, [ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });

  it("mobile refresh (body transport): rotated pair in JSON, cookies completely untouched", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.refresh(fakeReq({ body: { refresh_token: "RT-valid" } }), res);
    assert.strictEqual(res.out.body.access_token, "AT-new");
    assert.strictEqual(res.out.body.refresh_token, "RT-new");
    assert.strictEqual(res.out.body.token_type, "Bearer");
    assert.strictEqual(res.out.body.expires_in, 3600);
    assert.deepStrictEqual(res.out.cookiesSet, []);
    assert.deepStrictEqual(res.out.cookiesCleared, []);
  });

  it("expired/replayed refresh token, cookie transport → 401 and BOTH cookies cleared", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.refresh(fakeReq({ cookies: { [REFRESH_COOKIE]: "RT-dead" } }), res);
    assert.strictEqual(res.out.statusCode, 401);
    assert.strictEqual(res.out.body.code, "invalid_refresh_token");
    assert.deepStrictEqual(res.out.cookiesCleared.sort(), [ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });

  it("expired refresh token, body transport → 401 but the browser cookie jar is NOT disturbed", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.refresh(fakeReq({
      body: { refresh_token: "RT-dead" },
      cookies: { [ACCESS_COOKIE]: "AT-valid", [REFRESH_COOKIE]: "RT-valid" },
    }), res);
    assert.strictEqual(res.out.statusCode, 401);
    assert.deepStrictEqual(res.out.cookiesCleared, [], "a bad body token must not log the browser out");
  });

  it("no refresh token anywhere → 401 with code", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.refresh(fakeReq({}), res);
    assert.strictEqual(res.out.statusCode, 401);
    assert.strictEqual(res.out.body.code, "missing_refresh_token");
  });

  it("body token takes precedence over cookie (explicit beats ambient)", async () => {
    const deps = handlerDeps();
    const h = createClientAuthHandlers(deps);
    const res = fakeRes();
    await h.refresh(fakeReq({
      body: { refresh_token: "RT-valid" },
      cookies: { [REFRESH_COOKIE]: "RT-other" },
    }), res);
    assert.deepStrictEqual(deps.calls.refresh, ["RT-valid"]);
  });

  it("rate-limited → 429", async () => {
    const h = createClientAuthHandlers(handlerDeps({ refreshLimiter: deny }));
    const res = fakeRes();
    await h.refresh(fakeReq({ body: { refresh_token: "RT-valid" } }), res);
    assert.strictEqual(res.out.statusCode, 429);
  });
});

describe("POST /client-auth/logout", () => {
  it("browser logout: revokes with cookie tokens, clears BOTH cookies, 200", async () => {
    const deps = handlerDeps();
    const h = createClientAuthHandlers(deps);
    const res = fakeRes();
    await h.logout(fakeReq({ cookies: { [ACCESS_COOKIE]: "AT-valid", [REFRESH_COOKIE]: "RT-valid" } }), res);
    assert.deepStrictEqual(res.out.body, { success: true });
    assert.deepStrictEqual(res.out.cookiesCleared.sort(), [ACCESS_COOKIE, REFRESH_COOKIE].sort());
    assert.deepStrictEqual(deps.calls.revoke, [{ accessToken: "AT-valid", refreshToken: "RT-valid" }]);
  });

  it("mobile logout: bearer header + body refresh token drive revocation; cookies untouched", async () => {
    const deps = handlerDeps();
    const h = createClientAuthHandlers(deps);
    const res = fakeRes();
    await h.logout(fakeReq({
      authorization: "Bearer AT-valid",
      body: { refresh_token: "RT-valid" },
      cookies: { [ACCESS_COOKIE]: "browser-AT", [REFRESH_COOKIE]: "browser-RT" },
    }), res);
    assert.deepStrictEqual(res.out.body, { success: true });
    assert.deepStrictEqual(res.out.cookiesCleared, [], "a mobile logout must never kill a browser session");
    assert.deepStrictEqual(deps.calls.revoke, [{ accessToken: "AT-valid", refreshToken: "RT-valid" }]);
  });

  it("logout with nothing (already logged out) is still a clean 200 — idempotent", async () => {
    const h = createClientAuthHandlers(handlerDeps());
    const res = fakeRes();
    await h.logout(fakeReq({}), res);
    assert.strictEqual(res.out.statusCode, 200);
    assert.deepStrictEqual(res.out.body, { success: true });
  });

  it("revocation blowing up never fails the logout (best-effort by contract)", async () => {
    const h = createClientAuthHandlers(handlerDeps({
      revokeClientSession: async () => { throw new Error("supabase down"); },
    }));
    const res = fakeRes();
    await h.logout(fakeReq({ cookies: { [ACCESS_COOKIE]: "AT-valid" } }), res);
    assert.deepStrictEqual(res.out.body, { success: true });
    assert.ok(res.out.cookiesCleared.includes(ACCESS_COOKIE), "cookies still cleared");
  });
});

describe("GET /client-auth/me", () => {
  it("echoes the middleware-resolved identity for either transport", () => {
    const h = createClientAuthHandlers(handlerDeps());
    for (const mode of ["cookie", "bearer"]) {
      const res = fakeRes();
      const req = fakeReq({});
      req.clientId = CLIENT_ROW.slug;
      req.client = CLIENT_ROW;
      req.clientAuth = { mode, user: USER };
      h.me(req, res);
      assert.deepStrictEqual(res.out.body, {
        success: true,
        email: USER.email,
        client: { id: "pilot-plumbing", name: "Pilot Plumbing" },
        authMode: mode,
      });
    }
  });
});

// ── server-side revocation (logout semantics) ────────────────────────────────

describe("revokeClientSession", () => {
  it("live access token: one local-scope signOut, done", async () => {
    const signedOut = [];
    const r = await revokeClientSession({ accessToken: "AT" }, {
      adminSignOut: async (jwt) => { signedOut.push(jwt); return { error: null }; },
      refreshClientSession: async () => { throw new Error("must not be called"); },
    });
    assert.deepStrictEqual(r, { revoked: true, via: "access" });
    assert.deepStrictEqual(signedOut, ["AT"]);
  });

  it("dead access token + live refresh token: burns the refresh via rotation, then revokes", async () => {
    const signedOut = [];
    const r = await revokeClientSession({ accessToken: "AT-dead", refreshToken: "RT" }, {
      adminSignOut: async (jwt) => {
        signedOut.push(jwt);
        return jwt === "AT-fresh" ? { error: null } : { error: new Error("bad jwt") };
      },
      refreshClientSession: async (rt) => {
        assert.strictEqual(rt, "RT");
        return { accessToken: "AT-fresh", refreshToken: "RT-fresh" };
      },
    });
    assert.deepStrictEqual(r, { revoked: true, via: "refresh" });
    assert.deepStrictEqual(signedOut, ["AT-dead", "AT-fresh"]);
  });

  it("everything dead: reports revoked:false but NEVER throws (logout must not fail)", async () => {
    const r = await revokeClientSession({ accessToken: "AT-dead", refreshToken: "RT-dead" }, {
      adminSignOut: async () => { throw new Error("bad jwt"); },
      refreshClientSession: async () => { throw new Error("Invalid Refresh Token"); },
    });
    assert.strictEqual(r.revoked, false);
  });

  it("no credentials: no-op, no throw", async () => {
    const r = await revokeClientSession({}, {
      adminSignOut: async () => { throw new Error("must not be called"); },
    });
    assert.strictEqual(r.revoked, false);
  });
});

// ── /devices/revoke tenant-scoping (pure part) ──────────────────────────────

describe("device revocation input handling", () => {
  it("only well-formed UUIDs are even considered", () => {
    assert.strictEqual(isValidDeviceId("123e4567-e89b-12d3-a456-426614174000"), true);
    for (const bad of [undefined, null, "", "not-a-uuid", "123e4567e89b12d3a456426614174000",
      { toString: () => "123e4567-e89b-12d3-a456-426614174000" }, 42]) {
      assert.strictEqual(isValidDeviceId(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("a malformed deviceId short-circuits to notFound BEFORE any DB access", async () => {
    // revokeDevice only lazy-requires supabase after validation, so this
    // resolves without a database — proving injection-shaped ids die early
    // and indistinguishably from unknown ids (no existence oracle).
    const r = await revokeDevice("pilot-plumbing", "1 OR 1=1");
    assert.deepStrictEqual(r, { notFound: true });
  });
});
