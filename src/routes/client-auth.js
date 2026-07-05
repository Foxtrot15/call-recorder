const express = require("express");
const router = express.Router();
const { signupClient, loginClient } = require("../services/client-auth");

// POST /client-auth/signup — { clientId, email, password }
router.post("/signup", async (req, res) => {
  const { clientId, email, password } = req.body;

  if (!clientId || !email || !password) {
    return res.status(400).json({ error: "Missing clientId, email, or password" });
  }

  try {
    const result = await signupClient(email, password, clientId);
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
