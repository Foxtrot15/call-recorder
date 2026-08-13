// AIDA Locksmith Acquisition — the Retell webhook route (E-11A).
//
//   POST /webhooks/retell/acquisition
//
// ── DORMANT, AND BEHIND ITS OWN SWITCH ──────────────────────────────
// Flag-off is byte-identical to the route not existing: the gate calls
// next("router") and the path 404s.
//
// It needs THREE flags, and the third is the point:
//
//   RETELL_ENABLED                       the integration at all
//   RETELL_WEBHOOK_ENABLED               webhooks at all
//   RETELL_ACQUISITION_WEBHOOK_ENABLED   THIS path
//
// The third exists because enabling onboarding webhooks must never enable
// acquisition ingestion as a side effect. It is the same reason acquisition
// keeps its own resource order rather than joining the receptionist's, and the
// same reason it will need its own capability gate before it can dial.
//
// ── WHY A SEPARATE PATH FROM /webhooks/retell ───────────────────────
// Retell attaches a webhook_url per AGENT, so the acquisition agent will point
// here and nothing else will. Sharing the onboarding ingress would mean every
// acquisition delivery traversing a handler whose binding model is
// "which onboarding session is this?" — see the handler's header.
//
// ── NOT DEPLOYED ────────────────────────────────────────────────────
// Mounting it in source is not exposing it. No agent points at it, no Retell
// webhook_url is configured, the flag is off by default, and nothing has been
// deployed. `RETELL_ACQUISITION_WEBHOOK_URL` is deliberately undocumented as a
// value — there is no deployed route for it to name yet.

const express = require("express");
const router = express.Router();

const { isRetellEnabled, isWebhookEnabled, getRetellConfig } = require("../config/retell");
const { createAcquisitionWebhookHandler } = require("./acquisition-retell-webhook-handler");

const ACQUISITION_WEBHOOK_PATH = "/webhooks/retell/acquisition";

/** THIS path needs its own flag, not just the shared webhook one. */
function isAcquisitionWebhookEnabled(env = process.env) {
  return env.RETELL_ACQUISITION_WEBHOOK_ENABLED === "true";
}

function acquisitionWebhookGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isRetellEnabled(env) || !isWebhookEnabled(env) || !isAcquisitionWebhookEnabled(env)) {
      return next("router");
    }
    next();
  };
}

router.use(acquisitionWebhookGate());

// express.raw gives the exact bytes the signature was computed over.
// JSON.stringify(req.body) would produce different bytes and every signature
// would fail.
const config = getRetellConfig();
router.post(
  ACQUISITION_WEBHOOK_PATH,
  express.raw({ type: "application/json", limit: config.webhookMaxBytes }),
  createAcquisitionWebhookHandler()
);

module.exports = router;
module.exports.acquisitionWebhookGate = acquisitionWebhookGate;
module.exports.isAcquisitionWebhookEnabled = isAcquisitionWebhookEnabled;
module.exports.ACQUISITION_WEBHOOK_PATH = ACQUISITION_WEBHOOK_PATH;
