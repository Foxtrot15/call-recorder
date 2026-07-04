const twilio = require("twilio");
const crypto = require("crypto");

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

module.exports = { twilioWebhook, requireLogin, issueSessionCookie, clearSessionCookie };
