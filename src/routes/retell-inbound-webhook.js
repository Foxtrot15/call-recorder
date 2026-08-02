// AIDA — Retell INBOUND-call webhook route (M7F-A).
//
//   POST /webhooks/retell/inbound
//
// ─── WHY A DEDICATED ROUTE, NOT A BRANCH IN THE EVENT WEBHOOK ───────
// Four reasons, any one of which would be sufficient:
//
//   1. PROVIDER CONTRACT. This URL is set on the PHONE NUMBER
//      (`inbound_webhook_url`); the event webhook is set on the AGENT
//      (`webhook_url`). They are configured in different places and can be
//      pointed at different hosts. One route cannot be two URLs.
//
//   2. RESPONSE SHAPE. This must answer 200 with a JSON body that CONFIGURES
//      THE CALL. The event webhook answers 204 with no body. The brief is
//      explicit that the generic path must never return the inbound shape, and
//      the surest way to guarantee that is for it to be unable to.
//
//   3. LATENCY. This runs BEFORE the caller is answered, with a 10-second
//      budget, and a failure can DISCONNECT them. The event path deliberately
//      touches the database for idempotency. Sharing a handler would put a
//      database round trip in front of a ringing phone.
//
//   4. BLAST RADIUS. A bug in post-call auditing should not be able to affect
//      how a live call is answered.
//
// They share what should be shared — raw-body capture and signature
// verification — and nothing else.
//
// ORDER OF OPERATIONS, unchanged from the event route:
//   1. flag gate                (404 if dormant)
//   2. raw body, size-capped
//   3. content type check
//   4. SIGNATURE VERIFICATION   ← before anything is parsed
//   5. JSON.parse
//   6. inbound-shape validation
//   7. decide + respond         ← no database, no provider call
//
// NEVER LOGGED: the API key, the signature header, the raw body, caller
// numbers, transcript content.

const express = require("express");
const router = express.Router();

const { isRetellEnabled, isInboundWebhookEnabled, getRetellConfig, INBOUND_WEBHOOK_PATH } = require("../config/retell");
const { createInboundWebhookHandler } = require("./retell-inbound-webhook-handler");

/**
 * Router-level gate. Requires its OWN flag in addition to RETELL_ENABLED:
 * being willing to record events is not the same as being willing to decide,
 * in real time, how a stranger's phone call is handled.
 */
function retellInboundGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isRetellEnabled(env) || !isInboundWebhookEnabled(env)) return next("router");
    next();
  };
}

router.use(retellInboundGate());

const config = getRetellConfig();
router.post(
  INBOUND_WEBHOOK_PATH,
  // Raw bytes: the signature was computed over exactly these, and
  // JSON.stringify(req.body) would produce different ones.
  express.raw({ type: "application/json", limit: config.webhookMaxBytes }),
  createInboundWebhookHandler()
);

module.exports = router;
module.exports.retellInboundGate = retellInboundGate;
