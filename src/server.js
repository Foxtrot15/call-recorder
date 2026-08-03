require("dotenv").config();
// Validate critical config before building the app — fails closed with a clear
// message if a security-critical env var is missing/invalid (see config/startup-check.js).
require("./config/startup-check").validateStartupConfig();
const express = require("express");
const path    = require("path");
const cookieParser = require("cookie-parser");
const app     = express();
app.set("trust proxy", true);

// ── SIGNATURE-VERIFYING WEBHOOKS GO FIRST ───────────────────────────
//
// These three mount their own `express.raw` parser because verification must
// see the EXACT bytes the provider signed. They must therefore be registered
// BEFORE the global body parsers below.
//
// They used to sit after them, and the comments claimed they sat "apart from
// the JSON parser" — they sat BELOW it, which is the opposite. body-parser
// marks a request `_body = true` once it has read the stream, and every later
// parser skips a request already marked. So `express.json()` consumed the body,
// `express.raw()` skipped, and `req.body` arrived as a PARSED OBJECT rather than
// a Buffer. Verification then hashed `String({...})` — the literal
// "[object Object]" — and every correctly signed request was rejected as
// `invalid_signature`.
//
// Found on the deployed Railway sandbox (M7F-B2): unsigned and forged requests
// were refused correctly, so the security boundary looked healthy, while a
// GENUINE Retell webhook could never have been accepted. Neither of the two
// passing checks touches the body, which is why the bug hid behind them.
app.use(require("./routes/stripe-webhook"));      // M6, dormant behind BILLING_* flags
app.use(require("./routes/retell-webhook"));      // M3 event webhook, dormant
app.use(require("./routes/retell-inbound-webhook")); // M7F-A inbound, dormant
app.use(require("./routes/retell-tools"));        // M7J custom tools, dormant

// ── Global parsers, for every ordinary route ────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

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
// Locksmith billing (M6): the client's billing page and plan controls, behind
// requireClientAuth. Dormant — without BILLING_ENABLED="true" every path 404s
// before any auth runs, so with the flag off there is no route from which a
// card could be charged (see docs/LOCKSMITH_BILLING_SPEC.md).
app.use(require("./routes/billing"));
// The three signature-verifying webhooks (Stripe M6, Retell event M3, Retell
// INBOUND M7F-A) are mounted ABOVE the body parsers — see the note there.
//
// The inbound webhook is deliberately a SEPARATE route from the Retell event
// webhook: its URL is set on the phone NUMBER, it fires before a caller is
// answered, and its 200 JSON response configures that call, where the event
// webhook is set on the AGENT and answers 204 with no body. Keeping them apart
// is what makes it impossible for the generic path to return the inbound shape,
// and keeps a database round trip away from a ringing phone.

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
