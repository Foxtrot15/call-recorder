// AIDA — Stripe webhook route (M6). Wiring only.
//
//   POST /webhooks/stripe
//
// Dormant twice over: without BILLING_ENABLED="true" AND
// BILLING_WEBHOOK_ENABLED="true", next("router") exits before any handler runs
// and the path 404s exactly as if this file did not exist.
//
// Mounted with its own express.raw body parser, and mounted BEFORE the global
// express.json() in server.js, so the handler sees the exact bytes Stripe
// signed. Parsing and re-serialising the JSON changes the signed string and
// every signature check would fail — the same reason the Retell webhook sits
// apart from the JSON parser.
//
// No client or operator session is involved: authentication IS the signature.

const express = require("express");
const router = express.Router();

const { billingWebhookGate } = require("../config/billing");
const { createStripeWebhookHandlers } = require("./stripe-webhook-handler");
const { MAX_BODY_BYTES } = require("./stripe-webhook-handler");

const handlers = createStripeWebhookHandlers();

router.use(billingWebhookGate());

router.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json", limit: MAX_BODY_BYTES }),
  handlers.webhook
);

module.exports = router;
