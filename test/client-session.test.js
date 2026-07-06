// Unit tests for B1 client session refresh policy
// (src/services/client-session.js — pure, runs without node_modules).
//
// Proves: cookie security flags, lifetimes, rotation-aware set/clear
// behaviour, and the middleware's authenticated/refresh/reject decision
// table — including the case that motivated B1: expired access token with a
// live refresh token must attempt refresh, not 401.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_MAX_AGE_MS,
  REFRESH_COOKIE_MAX_AGE_MS,
  accessCookieOptions,
  refreshCookieOptions,
  setClientSessionCookies,
  clearClientSessionCookies,
  evaluateClientSession,
} = require("../src/services/client-session");

function fakeRes() {
  const calls = { set: [], cleared: [] };
  return {
    calls,
    cookie(name, value, opts) { calls.set.push({ name, value, opts }); },
    clearCookie(name) { calls.cleared.push(name); },
  };
}

describe("cookie policy", () => {
  it("access cookie keeps its existing name (backward compatibility)", () => {
    assert.strictEqual(ACCESS_COOKIE, "aida_client_session");
  });

  it("both cookies are httpOnly + secure + sameSite=lax (no JS access, no cross-site sends)", () => {
    for (const opts of [accessCookieOptions(), refreshCookieOptions()]) {
      assert.strictEqual(opts.httpOnly, true);
      assert.strictEqual(opts.secure, true);
      assert.strictEqual(opts.sameSite, "lax");
    }
  });

  it("refresh cookie outlives the access cookie (30d vs 7d)", () => {
    assert.strictEqual(accessCookieOptions().maxAge, ACCESS_COOKIE_MAX_AGE_MS);
    assert.strictEqual(refreshCookieOptions().maxAge, REFRESH_COOKIE_MAX_AGE_MS);
    assert.ok(REFRESH_COOKIE_MAX_AGE_MS > ACCESS_COOKIE_MAX_AGE_MS);
    assert.strictEqual(ACCESS_COOKIE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000, "access lifetime unchanged from pre-B1");
  });
});

describe("setting / clearing", () => {
  it("sets both cookies with the right values and flags", () => {
    const res = fakeRes();
    setClientSessionCookies(res, { accessToken: "AT", refreshToken: "RT" });
    assert.strictEqual(res.calls.set.length, 2);
    const access = res.calls.set.find((c) => c.name === ACCESS_COOKIE);
    const refresh = res.calls.set.find((c) => c.name === REFRESH_COOKIE);
    assert.strictEqual(access.value, "AT");
    assert.strictEqual(refresh.value, "RT");
    assert.strictEqual(access.opts.httpOnly, true);
    assert.strictEqual(refresh.opts.maxAge, REFRESH_COOKIE_MAX_AGE_MS);
  });

  it("omits the refresh cookie when no refresh token is provided (never overwrites with empty)", () => {
    const res = fakeRes();
    setClientSessionCookies(res, { accessToken: "AT" });
    assert.strictEqual(res.calls.set.length, 1);
    assert.strictEqual(res.calls.set[0].name, ACCESS_COOKIE);
  });

  it("clear removes BOTH cookies (logout / dead refresh token)", () => {
    const res = fakeRes();
    clearClientSessionCookies(res);
    assert.deepStrictEqual(res.calls.cleared.sort(), [ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });
});

describe("middleware decision table (evaluateClientSession)", () => {
  it("valid access token → authenticated (existing behaviour preserved)", () => {
    assert.strictEqual(
      evaluateClientSession({ hasAccessToken: true, accessValid: true, hasRefreshToken: true }),
      "authenticated"
    );
    assert.strictEqual(
      evaluateClientSession({ hasAccessToken: true, accessValid: true, hasRefreshToken: false }),
      "authenticated"
    );
  });

  it("THE B1 CASE: expired access token + refresh token → refresh, not reject", () => {
    assert.strictEqual(
      evaluateClientSession({ hasAccessToken: true, accessValid: false, hasRefreshToken: true }),
      "refresh"
    );
  });

  it("access cookie gone (7d) but refresh alive (30d) → refresh — idle dashboards resume", () => {
    assert.strictEqual(
      evaluateClientSession({ hasAccessToken: false, accessValid: false, hasRefreshToken: true }),
      "refresh"
    );
  });

  it("nothing usable → reject (pre-B1 behaviour for logged-out users unchanged)", () => {
    assert.strictEqual(
      evaluateClientSession({ hasAccessToken: false, accessValid: false, hasRefreshToken: false }),
      "reject"
    );
    assert.strictEqual(
      evaluateClientSession({ hasAccessToken: true, accessValid: false, hasRefreshToken: false }),
      "reject"
    );
  });
});
