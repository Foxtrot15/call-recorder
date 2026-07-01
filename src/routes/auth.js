const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const { storeToken, getToken } = require("../services/token");

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
router.get("/google", (req, res) => {
  const clientId = req.query.clientId || "default";
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",
    prompt:        "consent",
    state:         clientId,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// ── Google OAuth callback ────────────────────────────────────
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
router.get("/status", async (req, res) => {
  const clientId = req.query.clientId || "default";
  const tokenData = await getToken(clientId, "google");
  res.json({
    google: tokenData ? { connected: true, email: tokenData.email } : { connected: false },
  });
});

// ── Disconnect ───────────────────────────────────────────────
router.post("/disconnect", async (req, res) => {
  const { clientId, provider } = req.body;
  const supabase = require("../services/supabase");
  await supabase.from("connections").delete()
    .eq("client_id", clientId)
    .eq("provider", provider);
  res.json({ success: true });
});

module.exports = router;
