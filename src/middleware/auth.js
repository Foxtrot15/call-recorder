const crypto = require("crypto");

// Heavy deps (twilio, the Supabase client) are required lazily so this
// module's decision logic stays loadable in the dep-free unit-test
// environment — same convention as services/devices.js.

// Validates X-Twilio-Signature on webhook routes.
// Requires TWILIO_AUTH_TOKEN and BASE_URL env vars (both already exist).
// Lazily built on first request; behaviour is identical to constructing it
// at load (NODE_ENV is read once, at the same effective time — startup).
let _twilioWebhook = null;
function twilioWebhook(req, res, next) {
  if (!_twilioWebhook) {
    _twilioWebhook = require("twilio").webhook({
      validate: process.env.NODE_ENV !== "development",
    });
  }
  return _twilioWebhook(req, res, next);
}

// ── Dashboard login session ─────────────────────────────────
// Stateless, signed cookie — no session table needed, survives Railway
// restarts. Cookie value is "ok.<expiry>.<hmac>"; a forged or expired
// cookie fails the signature/expiry check and is treated as logged out.
const SESSION_COOKIE = "aida_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — refusing to sign/verify sessions");
  }
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function issueSessionCookie(res) {
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `ok.${expiresAt}`;
  const token = `${payload}.${sign(payload)}`;
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

function isValidSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [marker, expiresAtStr, signature] = parts;
  if (marker !== "ok") return false;

  const payload = `${marker}.${expiresAtStr}`;
  let expected;
  try {
    expected = sign(payload);
  } catch (err) {
    console.error("⚠️ ", err.message);
    return false; // fail closed: no usable secret means no valid sessions
  }
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const expiresAt = parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  return true;
}

function requireLogin(req, res, next) {
  if (!isValidSession(req)) {
    // Page navigation (browser asking for HTML) -> redirect to login page.
    // API/fetch call -> 401 JSON, so the dashboard's own fetch() calls fail
    // cleanly instead of receiving an HTML redirect body as "data".
    if (req.method === "GET" && req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.redirect("/login.html");
    }
    return res.status(401).json({ error: "Not authenticated" });
  }

  // The operator dashboard manages exactly one client (this deployment's
  // business) — OPERATOR_CLIENT_ID is that client's slug, resolved here
  // server-side so downstream routes never trust a client-supplied clientId.
  const clientId = process.env.OPERATOR_CLIENT_ID;
  if (!clientId) {
    console.error("⚠️  OPERATOR_CLIENT_ID is not set — refusing to resolve the operator session's client");
    return res.status(500).json({ error: "Operator dashboard is not configured (missing OPERATOR_CLIENT_ID)" });
  }
  req.clientId = clientId;
  next();
}

// ── Client-facing session (different from the operator login above) ────
// Clients authenticate via Supabase Auth (email/password). The access token
// arrives either in the httpOnly cookie (browser dashboard) or as
// `Authorization: Bearer <token>` (mobile app) — resolveClientCredentials in
// services/client-session.js owns the transport rule (any Authorization
// header ⇒ bearer mode, cookies ignored; otherwise cookie mode). Both modes
// share THIS one validation path: verify against Supabase, resolve client_id
// server-side — a client can never claim a different clientId by editing a
// request themselves.
//
// B1 (session refresh), cookie mode only: when the access JWT is
// missing/expired but the refresh cookie is present, the session is refreshed
// transparently here — new (rotated) tokens are set on THIS response and the
// request proceeds. The browser dashboard never sees the hourly JWT expiry at
// all. Bearer mode never refreshes transparently (the app wouldn't see the
// rotated pair); it gets a coded 401 and calls POST /client-auth/refresh.
const {
  setClientSessionCookies,
  clearClientSessionCookies,
  evaluateClientSession,
  resolveClientCredentials,
} = require("../services/client-session");

// Factory so tests can inject the Supabase boundary; the exported
// requireClientAuth below is this factory over the real services, and is the
// ONLY client-auth middleware — bearer support must never fork into a
// second implementation.
function createRequireClientAuth(deps = {}) {
  const getUser = deps.getUser
    || (async (token) => {
      const supabase = require("../services/supabase");
      return (await supabase.auth.getUser(token)).data?.user || null;
    });
  const findClientByAuthUserId = deps.findClientByAuthUserId
    || (async (userId) => {
      const supabase = require("../services/supabase");
      const { data, error } = await supabase
        .from("clients")
        .select("slug, name, real_number")
        .eq("auth_user_id", userId)
        .single();
      return error ? null : data;
    });
  // Lazy default avoids loading the auth service on the operator path.
  const refreshSession = deps.refreshClientSession
    || ((token) => require("../services/client-auth").refreshClientSession(token));

  return async function requireClientAuth(req, res, next) {
    const creds = resolveClientCredentials({
      authorizationHeader: req.headers?.authorization,
      cookies: req.cookies,
    });

    // Verify the access token (if any) against Supabase.
    let user = null;
    if (creds.accessToken) {
      try {
        user = await getUser(creds.accessToken);
      } catch (err) {
        console.error("⚠️  access-token verification errored:", err.message);
        user = null; // fail closed — an unverifiable token is an invalid token
      }
    }

    const verdict = evaluateClientSession({
      hasAccessToken: Boolean(creds.accessToken),
      accessValid: Boolean(user),
      hasRefreshToken: Boolean(creds.refreshToken),
    });

    if (verdict === "reject") {
      // Bearer rejections carry a machine-readable code so the app knows
      // "refresh, then re-login" without parsing prose. Cookie-mode body is
      // byte-identical to the pre-mobile behaviour.
      if (creds.mode === "bearer") {
        return res.status(401).json({ error: "Invalid or expired access token", code: "invalid_token" });
      }
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (verdict === "refresh") {
      // Cookie mode only: bearer requests never carry a refresh token here.
      try {
        const session = await refreshSession(creds.refreshToken);
        setClientSessionCookies(res, session); // rotated pair replaces both cookies
        user = session.user;
      } catch (err) {
        // Refresh token dead (revoked, rotated out, or >30d idle): clear the
        // corpses so the browser stops retrying, and end the session honestly.
        console.log("Client session refresh failed:", err.message);
        clearClientSessionCookies(res);
        return res.status(401).json({ error: "Session expired or invalid — please log in again" });
      }
    }

    const client = await findClientByAuthUserId(user.id);
    if (!client) {
      return res.status(403).json({ error: "No client account linked to this login" });
    }

    // Downstream routes use req.clientId — resolved here, server-side,
    // never taken from a query param or request body.
    req.clientId = client.slug;
    req.client = client;
    req.clientAuth = { mode: creds.mode, user }; // for /client-auth/me and logging
    next();
  };
}

const requireClientAuth = createRequireClientAuth();

// Exports at the bottom, after every definition — the previous
// exports-before-definition layout worked only via function hoisting and was
// flagged as a refactor hazard (backlog P2-6); fixed while touching this file.
module.exports = { twilioWebhook, requireLogin, issueSessionCookie, clearSessionCookie, requireClientAuth, createRequireClientAuth };
