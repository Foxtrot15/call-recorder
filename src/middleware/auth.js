const twilio = require("twilio");

// Validates X-Twilio-Signature on webhook routes.
// Requires TWILIO_AUTH_TOKEN and BASE_URL env vars (both already exist).
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV !== "development",
});

module.exports = { twilioWebhook };

// NOTE: internalAuth (shared-secret header) was removed from here — it doesn't
// work for /test/inject or /voicemail/upload because the dashboard calls both
// directly from browser JS, with no session of its own. Putting the secret in
// the frontend defeats the purpose. Real fix: add dashboard login (see TODOs
// in server.js). Until then, both endpoints remain open — acceptable while
// you are the only dashboard user, not once a client has the URL.
