const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const { storeToken, getToken } = require("../services/token");
const { requireLogin } = require("../middleware/auth");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = `${process.env.BASE_URL}/auth/google/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

// ── Start Google OAuth flow ──────────────────────────────────
// Gated by requireLogin so clientId always comes from the authenticated
// operator session (req.clientId), never a client-suppliable query param.
// It's carried across the redirect through Google via `state`, since that's
// the only way to get a value back to the public callback below.
router.get("/google", requireLogin, (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",
    prompt:        "consent",
    state:         req.clientId,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// ── Google OAuth callback ────────────────────────────────────
// Must stay public — Google redirects here directly, outside any session.
// clientId comes from `state`, which /google above only ever sets from an
// authenticated req.clientId, so it can't be forged into a different tenant.
router.get("/google/callback", async (req, res) => {
  const { code, state: clientId, error } = req.query;

  if (error) {
    console.error("OAuth error:", error);
    return res.redirect(`/?auth=error&provider=google`);
  }

  try {
    // Exchange code for tokens using axios
    const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    const tokens = tokenRes.data;

    // Get user email
    const userRes = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      timeout: 10000,
    });

    const email = userRes.data.email;

    await storeToken(clientId, "google", {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiry:       tokens.expiry_date || (Date.now() + 3600000),
      email,
    });

    console.log(`✅ Google OAuth connected for client ${clientId}: ${email}`);
    res.redirect(`/?auth=success&provider=google&email=${encodeURIComponent(email)}`);

  } catch (err) {
    console.error("OAuth callback error:", err.response?.data || err.message);
    res.redirect(`/?auth=error&provider=google`);
  }
});

// ── Check connection status ──────────────────────────────────
router.get("/status", requireLogin, async (req, res) => {
  const tokenData = await getToken(req.clientId, "google");
  res.json({
    google: tokenData ? { connected: true, email: tokenData.email } : { connected: false },
  });
});

// ── Disconnect ───────────────────────────────────────────────
router.post("/disconnect", requireLogin, async (req, res) => {
  // clientId comes from req.clientId, not the request body — previously this
  // trusted a client-supplied clientId directly, letting any operator-
  // authenticated caller disconnect a different tenant's connection.
  const { provider } = req.body;
  const supabase = require("../services/supabase");
  await supabase.from("connections").delete()
    .eq("client_id", req.clientId)
    .eq("provider", provider);
  res.json({ success: true });
});

module.exports = router;
