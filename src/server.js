require("dotenv").config();
// Validate critical config before building the app — fails closed with a clear
// message if a security-critical env var is missing/invalid (see config/startup-check.js).
require("./config/startup-check").validateStartupConfig();
const express = require("express");
const path    = require("path");
const cookieParser = require("cookie-parser");
const app     = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", true);

const { twilioWebhook, requireLogin } = require("./middleware/auth");

// Public: login page + the login/logout endpoints themselves.
// Must be registered before the gated "/" route below.
app.use("/login", require("./routes/login"));
app.use("/client-auth", require("./routes/client-auth")); // Client signup/login, also public
// Public product page for the locksmith pilot (GET /locksmith-receptionist +
// its enquiry POST). No auth, no tenant data, no pipeline contact — it renders
// config + demonstration data only. DORMANT by default: without
// LOCKSMITH_PILOT_ENABLED="true" both paths 404, byte-identical to the routes
// not existing (see docs/LOCKSMITH_PILOT_SPEC.md).
app.use(require("./routes/locksmith"));
// Locksmith autonomous onboarding (M2): client review/approval behind
// requireClientAuth, founder console behind requireLogin. Also dormant —
// without LOCKSMITH_ONBOARDING_ENABLED="true" every path 404s before any auth
// runs (see docs/LOCKSMITH_ONBOARDING_SPEC.md).
app.use(require("./routes/locksmith-onboarding"));
// Locksmith client portal (M5): the authenticated day-to-day surface, entirely
// behind requireClientAuth. Also dormant — without LOCKSMITH_PORTAL_ENABLED
// ="true" every path 404s before any auth runs. The portal flag is deliberately
// independent of the public-page flag: the marketing shell and a client's live
// call history are different surfaces with different risk, and switching one on
// must never switch the other on (see docs/LOCKSMITH_CLIENT_PORTAL_SPEC.md).
app.use(require("./routes/locksmith-portal"));
// Retell webhook (M3). Dormant: without RETELL_ENABLED and
// RETELL_WEBHOOK_ENABLED both "true" the path 404s before any handler runs.
// Mounted with its own express.raw body parser so signature verification sees
// the exact bytes — this is why it sits apart from the JSON parser above.
app.use(require("./routes/retell-webhook"));
// Acquisition Retell webhook (E-11A). Dormant behind a THIRD flag,
// RETELL_ACQUISITION_WEBHOOK_ENABLED, so switching onboarding webhooks on can
// never switch acquisition ingestion on with them. No Retell agent points at
// this path, no webhook_url is configured, and nothing is deployed.
app.use(require("./routes/acquisition-retell-webhook"));

// Dashboard page requires login. Registered before express.static so it
// takes priority over static's automatic "serve index.html for /" behaviour.
app.get(["/", "/index.html"], requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Everything else in /public (login.html, onboarding.html) stays public —
// onboarding.html in particular is meant to be sent to new clients who
// don't have a dashboard password yet.
app.use(express.static(path.join(__dirname, "../public")));

app.use("/inbound",           twilioWebhook, require("./routes/inbound"));
app.use("/outbound",          twilioWebhook, require("./routes/outbound"));
app.use("/recording",         twilioWebhook, require("./routes/recording"));
app.use("/call",              requireLogin, require("./routes/call"));
app.use("/calls",             requireLogin, require("./routes/calls"));
app.use("/auth",              require("./routes/auth")); // login gating applied selectively inside — only /google/callback stays public, for the OAuth redirect
app.use("/test",              requireLogin, require("./routes/test"));
app.use("/personal-contacts", requireLogin, require("./routes/personal-contacts"));
app.use("/voicemail",         requireLogin, require("./routes/voicemail"));
app.use("/settings",          requireLogin, require("./routes/settings"));
app.use("/client-dashboard",  require("./routes/client-dashboard")); // gated internally via requireClientAuth
// VoIP v2 (flag-gated; VOIP_V2_ENABLED unset/false in every production
// deploy today, so all of these are 404 pass-throughs exactly as before):
// Phase 1b real routes (/voice/token, /devices/register, GET /devices),
// Phase 1c Twilio webhooks (/voip/dial-result — signature-gated per route),
// then Phase 0 placeholders for the not-yet-built remainder.
app.use(require("./routes/voip"));
app.use("/voip", require("./routes/voip-webhooks"));
app.use(require("./routes/voip-scaffold"));
app.get("/health", (req, res) => res.json({ status: "ok" }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
