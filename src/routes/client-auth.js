const express = require("express");
const router = express.Router();
const { signupClient, loginClient } = require("../services/client-auth");
const { createInviteToken, verifyInviteToken } = require("../services/invite");
const { requireLogin } = require("../middleware/auth");

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
    res.cookie("aida_client_session", result.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — Supabase refresh handles longer sessions later if needed
    });
    res.json({ success: true, email: result.email });
  } catch (err) {
    console.error("Client login error:", err.message);
    res.status(401).json({ error: err.message });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("aida_client_session");
  res.json({ success: true });
});

module.exports = router;
