const express = require("express");
const path    = require("path");
const cookieParser = require("cookie-parser");

const { twilioWebhook, requireLogin } = require("./middleware/auth");

/**
 * Build the application without starting it.
 *
 * ── WHY THIS IS A FUNCTION NOW (E-12L) ──────────────────────────────
 * It used to be a module-level `app` beside an `app.listen(...)`, so importing
 * this file started a server. No test could import it, so no test ever
 * exercised the real middleware stack — and the ordering defect below lived
 * here for two milestones while 33 webhook tests passed, because every one of
 * them handed the handler a `req` object it had built itself.
 *
 * A test that constructs its own request cannot discover a bug in how requests
 * are constructed.
 */
function buildApp() {
  const app = express();
  app.set("trust proxy", true);

  // ── RAW-BODY WEBHOOKS COME FIRST. THIS ORDER IS THE SECURITY MODEL. ──
  //
  // Retell signs the exact bytes it transmits, so verification has to see those
  // bytes. It previously could not.
  //
  // `express.json()` was mounted globally above these routes. For any
  // `application/json` request it parsed the body, set `req.body` to an object
  // and marked the request consumed — and body-parser's raw parser skips a
  // request that is already consumed (body-parser/lib/types/raw.js:60). So the
  // `express.raw()` on each webhook route did nothing, the handler received an
  // object instead of a Buffer, and `String(object)` handed the verifier the
  // literal text "[object Object]".
  //
  // A signature computed over the real body can never match a digest computed
  // over "[object Object]", so a genuine signed delivery could not verify. The
  // negative smoke passed throughout — an unsigned request is rejected for
  // being unsigned no matter what the body looks like — which is exactly why
  // this survived a green suite and a green live probe.
  //
  // Mounting these two routers before any body parser is the whole fix. They
  // own their own `express.raw()`, with their own content-type and byte cap.
  //
  // Nothing else may go above this line without the same justification: above
  // it, `req.body` does not exist.
  app.use(require("./routes/retell-webhook"));
  app.use(require("./routes/acquisition-retell-webhook"));

  // ── Everything below here gets a parsed body, as it always did. ──────
  // Twilio is unaffected by the move: its signature is computed over the URL
  // and the sorted POST parameters, not over raw bytes, so it needs
  // `urlencoded` to have run — and it is mounted below, as before.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(cookieParser());

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

// AIDA client platform — configuration API (P17). Gated OFF by default:
// without PLATFORM_CONFIG_API_ENABLED="true" every path 404s exactly as if
// this file did not exist. It provisions nothing and cannot place a call.
app.use(require("./routes/platform-config"));
// The two Retell webhooks are mounted at the TOP of this function, above every
// body parser, because signature verification needs the transmitted bytes. See
// the comment there. Both remain dormant behind their flags — the acquisition
// one behind a third flag of its own — and moving them changed neither gate.

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

  return app;
}

/**
 * Boot: read the environment, refuse to start on missing security-critical
 * config, then listen. Unchanged in behaviour — only moved, so that importing
 * this module builds nothing and starts nothing.
 */
function start() {
  require("dotenv").config();
  // Fails closed with a clear message if a security-critical env var is missing
  // or invalid (see config/startup-check.js).
  require("./config/startup-check").validateStartupConfig();
  const app = buildApp();
  const PORT = process.env.PORT || 3000;
  return app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
}

// Only when run directly. `require("./server")` gives you the builder and does
// not open a socket, which is what lets tests drive the real middleware stack.
if (require.main === module) start();

module.exports = { buildApp, start };
