// AIDA — Retell webhook route (M3).
//
//   POST /webhooks/retell
//
// Deliberately mounted on its own path, separate from every product route, and
// DORMANT: without RETELL_ENABLED=true AND RETELL_WEBHOOK_ENABLED=true the gate
// exits the router before any handler runs and the path 404s.
//
// ORDER OF OPERATIONS IS THE SECURITY MODEL:
//   1. flag gate                     (404 if dormant)
//   2. raw body, size-capped         (express.raw, hard byte limit)
//   3. content type check
//   4. SIGNATURE VERIFICATION        ← before anything is parsed
//   5. JSON.parse                    ← only now is the body trusted enough
//   6. envelope validation
//   7. fingerprint + idempotency
//   8. fast 2xx acknowledgement      ← the provider is not kept waiting
//   9. processing delegated onward
//
// Retell retries up to 3 times with a 10-second timeout, so acknowledgement
// must not wait on our own work. Long processing is handed to the injected
// `processor` after the response is sent.
//
// NEVER LOGGED: the API key, the signature header, the raw body, transcript
// content.

const express = require("express");
const router = express.Router();

const { isRetellEnabled, isWebhookEnabled, getRetellConfig } = require("../config/retell");
const { createRetellWebhookHandler } = require("./retell-webhook-handler");

/**
 * Router-level gate. Same next("router") contract as every other dormant
 * feature in this repo: flag-off is byte-identical to the route not existing.
 */
function retellWebhookGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isRetellEnabled(env) || !isWebhookEnabled(env)) return next("router");
    next();
  };
}

router.use(retellWebhookGate());

// Raw body, capped. express.raw gives us the exact bytes the signature was
// computed over — JSON.stringify(req.body) would produce different bytes and
// every signature would fail.
const config = getRetellConfig();
router.post(
  "/webhooks/retell",
  express.raw({ type: "application/json", limit: config.webhookMaxBytes }),
  createRetellWebhookHandler()
);

module.exports = router;
module.exports.retellWebhookGate = retellWebhookGate;
