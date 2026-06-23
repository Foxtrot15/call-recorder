
const express = require("express");
const router  = express.Router();
const { google } = require("googleapis");
const { storeToken, getToken } = require("../services/token");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = `${process.env.BASE_URL}/auth/google/callback`;

function getOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

// ── Start Google OAuth flow ──────────────────────────────────
// GET /auth/google?clientId=xxx
router.get("/google", (req, res) => {
  const clientId = req.query.clientId || "default";
  const oauth2Client = getOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    state: clientId, // pass clientId through OAuth flow
  });

  res.redirect(url);
});

// ── Google OAuth callback ────────────────────────────────────
// GET /auth/google/callback
router.get("/google/callback", async (req, res) => {
  const { code, state: clientId, error } = req.query;

  if (error) {
    console.error("OAuth error:", error);
    return res.redirect(`/?auth=error&provider=google`);
  }

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Get user email
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    await storeToken(clientId, "google", {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiry:       tokens.expiry_date,
      email:        userInfo.email,
    });

    console.log(`✅ Google OAuth connected for client ${clientId}: ${userInfo.email}`);
    res.redirect(`/?auth=success&provider=google&email=${encodeURIComponent(userInfo.email)}`);

  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.redirect(`/?auth=error&provider=google`);
  }
});

// ── Check connection status ──────────────────────────────────
// GET /auth/status?clientId=xxx
router.get("/status", async (req, res) => {
  const clientId = req.query.clientId || "default";
  const google = await getToken(clientId, "google");
  res.json({
    google: google ? { connected: true, email: google.email } : { connected: false },
  });
});

// ── Disconnect ───────────────────────────────────────────────
// POST /auth/disconnect
router.post("/disconnect", async (req, res) => {
  const { clientId, provider } = req.body;
  const supabase = require("../services/supabase");
  await supabase.from("connections").delete()
    .eq("client_id", clientId)
    .eq("provider", provider);
  res.json({ success: true });
});

module.exports = router;
