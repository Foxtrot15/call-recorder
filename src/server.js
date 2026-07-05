require("dotenv").config();
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
app.use("/auth",              require("./routes/auth")); // login gating applied selectively inside — /google and /google/callback must stay public for the OAuth redirect
app.use("/test",              requireLogin, require("./routes/test"));
app.use("/personal-contacts", requireLogin, require("./routes/personal-contacts"));
app.use("/voicemail",         requireLogin, require("./routes/voicemail"));
app.use("/settings",          requireLogin, require("./routes/settings"));
app.get("/health", (req, res) => res.json({ status: "ok" }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
