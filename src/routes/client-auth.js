const express = require("express");
const router = express.Router();
const { signupClient, loginClient, refreshClientSession } = require("../services/client-auth");
const { createInviteToken, verifyInviteToken } = require("../services/invite");
const { requireLogin } = require("../middleware/auth");
const {
  REFRESH_COOKIE,
  setClientSessionCookies,
  clearClientSessionCookies,
} = require("../services/client-session");

// POST /client-auth/invite — { clientId }  (operator-only)
// Mints an invite token for one client slug. There's no separate "used" flag —
// single-use falls out of signupClient's existing auth_user_id-is-null guard:
// once a slug is linked, a repeat signup with the same token is rejected.
router.post("/invite", requireLogin, (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Missing clientId" });

  try {
    const token = createInviteToken(clientId);
    res.json({ success: true, token, clientId });
  } catch (err) {
    console.error("Invite creation error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /client-auth/signup — { token, email, password }
// clientId is never taken from the request body directly — it only ever
// comes from a verified invite token, so a caller can't claim an arbitrary
// unclaimed tenant slug just by guessing/enumerating it.
router.post("/signup", async (req, res) => {
  const { token, email, password } = req.body;

  if (!token || !email || !password) {
    return res.status(400).json({ error: "Missing token, email, or password" });
  }

  const invite = verifyInviteToken(token);
  if (!invite) {
    return res.status(400).json({ error: "Invalid or expired invite token" });
  }

  try {
    const result = await signupClient(email, password, invite.clientId);
    res.json({ success: true, userId: result.userId, email: result.email });
  } catch (err) {
    console.error("Client signup error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /client-auth/login — { email, password }
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const result = await loginClient(email, password);
    // B1: persist BOTH tokens. The access JWT dies after ~1h; the refresh
    // cookie lets requireClientAuth (and POST /refresh) mint a new one
    // transparently instead of forcing hourly re-logins.
    setClientSessionCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    res.json({ success: true, email: result.email });
  } catch (err) {
    console.error("Client login error:", err.message);
    res.status(401).json({ error: err.message });
  }
});

// POST /client-auth/refresh — exchange the refresh token for a new session.
// Dual transport (VoIP plan Q5):
//   * Browser: refresh token read from the httpOnly cookie; new tokens are
//     set as cookies only — the JSON body stays token-free, so page JS never
//     touches raw tokens.
//   * Future mobile app (Phase 2): sends { refresh_token } in the body (from
//     Keychain/Keystore — apps have no cookie jar worth trusting) and gets
//     the rotated pair back in the JSON body.
// The browser dashboard rarely needs this endpoint — requireClientAuth
// refreshes transparently — but it exists for the app and for explicit
// "wake up" refreshes.
router.post("/refresh", async (req, res) => {
  const fromBody = req.body?.refresh_token || null;
  const fromCookie = req.cookies?.[REFRESH_COOKIE] || null;
  const refreshToken = fromBody || fromCookie;

  if (!refreshToken) {
    return res.status(401).json({ error: "No refresh token" });
  }

  try {
    const session = await refreshClientSession(refreshToken);
    setClientSessionCookies(res, session);
    if (fromBody) {
      // App transport: it needs the rotated pair back explicitly.
      return res.json({
        success: true,
        email: session.email,
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
      });
    }
    res.json({ success: true, email: session.email });
  } catch (err) {
    // A dead/rotated-out refresh token means the session is over — clear
    // both cookies so the browser stops retrying with a corpse.
    console.error("Client session refresh failed:", err.message);
    clearClientSessionCookies(res);
    res.status(401).json({ error: "Session expired — please log in again" });
  }
});

router.post("/logout", (req, res) => {
  clearClientSessionCookies(res);
  res.json({ success: true });
});

module.exports = router;
