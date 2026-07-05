const twilio = require("twilio");
const crypto = require("crypto");
const supabase = require("../services/supabase");

// Validates X-Twilio-Signature on webhook routes.
// Requires TWILIO_AUTH_TOKEN and BASE_URL env vars (both already exist).
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV !== "development",
});

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
  if (isValidSession(req)) return next();

  // Page navigation (browser asking for HTML) -> redirect to login page.
  // API/fetch call -> 401 JSON, so the dashboard's own fetch() calls fail
  // cleanly instead of receiving an HTML redirect body as "data".
  if (req.method === "GET" && req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.redirect("/login.html");
  }
  return res.status(401).json({ error: "Not authenticated" });
}

module.exports = { twilioWebhook, requireLogin, issueSessionCookie, clearSessionCookie, requireClientAuth };

// ── Client-facing session (different from the operator login above) ────
// Clients authenticate via Supabase Auth (email/password). Their access
// token is stored in its own cookie, verified against Supabase on every
// request, and used to resolve their client_id server-side — a client can
// never claim a different clientId by editing a request themselves.
const CLIENT_SESSION_COOKIE = "aida_client_session";

async function requireClientAuth(req, res, next) {
  const token = req.cookies?.[CLIENT_SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Session expired or invalid — please log in again" });
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("slug, name, real_number")
    .eq("auth_user_id", userData.user.id)
    .single();

  if (clientError || !client) {
    return res.status(403).json({ error: "No client account linked to this login" });
  }

  // Downstream routes use req.clientId — resolved here, server-side,
  // never taken from a query param or request body.
  req.clientId = client.slug;
  req.client = client;
  next();
}
