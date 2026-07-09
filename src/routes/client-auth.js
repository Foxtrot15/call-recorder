const express = require("express");
const router = express.Router();
const { signupClient } = require("../services/client-auth");
const { createInviteToken, verifyInviteToken } = require("../services/invite");
const { requireLogin, requireClientAuth } = require("../middleware/auth");
const { createClientAuthHandlers } = require("./client-auth-handlers");

// Session lifecycle (login/refresh/logout/me) lives in client-auth-handlers.js
// — dual-transport behaviour (browser cookies vs mobile Bearer tokens) is
// documented there and in docs/MOBILE_API_CONTRACT.md.
const handlers = createClientAuthHandlers();

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

// POST /client-auth/login — { email, password, mode? } ("tokens" ⇒ JSON pair)
router.post("/login", handlers.login);

// POST /client-auth/refresh — cookie transport, or body { refresh_token }
router.post("/refresh", handlers.refresh);

// POST /client-auth/logout — both transports; best-effort server-side revoke
router.post("/logout", handlers.logout);

// GET /client-auth/me — session probe for either transport
router.get("/me", requireClientAuth, handlers.me);

module.exports = router;
