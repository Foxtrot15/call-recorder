// Session-lifecycle handlers for /client-auth (login, refresh, logout, me),
// factory-built so tests inject the Supabase-backed services and prove both
// transports without a network. routes/client-auth.js wires the real deps;
// this module owns the dual-mode (browser cookie vs mobile token) behaviour.
//
// The mode rule per endpoint (full contract: docs/MOBILE_API_CONTRACT.md):
//   login   — body { mode: "tokens" } ⇒ tokens in JSON, NO cookies set.
//             Anything else ⇒ cookies set, token-free JSON (unchanged).
//   refresh — body { refresh_token } ⇒ token transport: rotated pair in
//             JSON, cookies untouched (set OR cleared — a mobile call must
//             never disturb a browser session sharing the jar). No body
//             token ⇒ cookie transport, exactly as before.
//   logout  — Authorization header ⇒ bearer mode: revoke server-side
//             (best effort), never touches cookies. Cookie mode: revoke
//             best-effort AND clear both cookies (as before). Always 200 —
//             logout is idempotent and must not strand a client.
//   me      — either transport via requireClientAuth; identity echo for
//             "is my stored session still good?" checks at app launch.

const {
  setClientSessionCookies,
  clearClientSessionCookies,
  resolveClientCredentials,
  wantsTokenResponse,
  sessionTokenBody,
} = require("../services/client-session");
const { createRateLimiter } = require("../services/rate-limit");

// Login/refresh are the credential-guessing and token-mint surfaces — the
// same cheap-abuse class D11 throttles on the VoIP endpoints. Keyed per IP;
// limits sized so no legitimate client (or the smoke suite) ever meets them.
const LOGIN_LIMIT = { limit: 10, windowMs: 60 * 1000 };
const REFRESH_LIMIT = { limit: 60, windowMs: 60 * 1000 };

function createClientAuthHandlers(deps = {}) {
  // Lazy service defaults keep this module loadable in dep-free unit tests.
  const svc = () => require("../services/client-auth");
  const loginClient = deps.loginClient || ((...a) => svc().loginClient(...a));
  const refreshClientSession = deps.refreshClientSession || ((...a) => svc().refreshClientSession(...a));
  const revokeClientSession = deps.revokeClientSession || ((...a) => svc().revokeClientSession(...a));
  const loginLimiter = deps.loginLimiter || createRateLimiter(LOGIN_LIMIT);
  const refreshLimiter = deps.refreshLimiter || createRateLimiter(REFRESH_LIMIT);

  // Unlike the VoIP limiters (which sit behind auth), these guard PUBLIC
  // endpoints where an attacker can mint unlimited keys by rotating spoofed
  // X-Forwarded-For values — prune expired windows periodically so the
  // in-memory map can't be grown without bound.
  let checksSincePrune = 0;
  function throttled(limiter, req, res) {
    if (++checksSincePrune >= 256 && typeof limiter.prune === "function") {
      checksSincePrune = 0;
      limiter.prune();
    }
    const rl = limiter.check(req.ip || "?");
    if (rl.allowed) return false;
    res.status(429).json({ error: "Too many attempts — retry shortly", code: "rate_limited" });
    return true;
  }

  // POST /client-auth/login — { email, password, mode? }
  async function login(req, res) {
    if (throttled(loginLimiter, req, res)) return;

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    try {
      const result = await loginClient(email, password);
      if (wantsTokenResponse(req.body)) {
        // Mobile transport: the pair goes to Keychain/Keystore, not a cookie
        // jar — setting cookies here would just leave orphans on the device.
        return res.json(sessionTokenBody(result));
      }
      // B1: persist BOTH tokens. The access JWT dies after ~1h; the refresh
      // cookie lets requireClientAuth (and POST /refresh) mint a new one
      // transparently instead of forcing hourly re-logins.
      setClientSessionCookies(res, result);
      res.json({ success: true, email: result.email });
    } catch (err) {
      console.error("Client login error:", err.message);
      res.status(401).json({ error: err.message, code: "invalid_credentials" });
    }
  }

  // POST /client-auth/refresh — exchange the refresh token for a new session.
  // Supabase ROTATES refresh tokens: the returned pair replaces the old one
  // entirely, so whichever transport is used must persist BOTH new tokens.
  async function refresh(req, res) {
    if (throttled(refreshLimiter, req, res)) return;

    const fromBody = req.body?.refresh_token || null;
    const { refreshToken: fromCookie } = resolveClientCredentials({ cookies: req.cookies });
    const refreshToken = fromBody || fromCookie;

    if (!refreshToken) {
      return res.status(401).json({ error: "No refresh token", code: "missing_refresh_token" });
    }

    try {
      const session = await refreshClientSession(refreshToken);
      if (fromBody) {
        // Token transport: rotated pair in the body; cookies untouched.
        return res.json(sessionTokenBody(session));
      }
      // Cookie transport: rotated pair replaces both cookies; body stays
      // token-free so page JS never touches raw tokens.
      setClientSessionCookies(res, session);
      res.json({ success: true, email: session.email });
    } catch (err) {
      // A dead/rotated-out refresh token means the session is over.
      console.error("Client session refresh failed:", err.message);
      if (!fromBody) {
        // Cookie mode: clear both cookies so the browser stops retrying with
        // a corpse. Token mode must NOT clear cookies — the dead token came
        // from the request body, not the jar.
        clearClientSessionCookies(res);
      }
      res.status(401).json({ error: "Session expired — please log in again", code: "invalid_refresh_token" });
    }
  }

  // POST /client-auth/logout — optional body { refresh_token } (mobile).
  // No auth middleware on purpose: a client with an already-dead session must
  // still be able to log out cleanly. Revocation is best-effort; the response
  // is always 200 so clients unconditionally discard local state.
  async function logout(req, res) {
    const creds = resolveClientCredentials({
      authorizationHeader: req.headers?.authorization,
      cookies: req.cookies,
    });
    const refreshToken = req.body?.refresh_token || creds.refreshToken || null;

    try {
      const result = await revokeClientSession({ accessToken: creds.accessToken, refreshToken });
      if (result?.revoked) console.log(`client-auth.logout revoked via=${result.via} mode=${creds.mode}`);
    } catch (err) {
      console.log("Logout revocation error (continuing):", err.message);
    }

    if (creds.mode === "cookie") clearClientSessionCookies(res);
    res.json({ success: true });
  }

  // GET /client-auth/me — behind requireClientAuth (either transport).
  function me(req, res) {
    res.json({
      success: true,
      email: req.clientAuth?.user?.email || null,
      client: {
        id: req.clientId,
        name: req.client?.name || null,
      },
      authMode: req.clientAuth?.mode || null,
    });
  }

  return { login, refresh, logout, me };
}

module.exports = { createClientAuthHandlers, LOGIN_LIMIT, REFRESH_LIMIT };
