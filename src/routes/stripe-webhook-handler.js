// AIDA — Stripe webhook handling (M6).
//
// Express-free and injectable, so the whole surface is testable without
// node_modules or a network.
//
// ─── SIGNATURE VERIFICATION IS NOT OPTIONAL AND NOT OURS ────────────
// An unverified billing webhook lets anyone who finds the URL mark an invoice
// paid, cancel a subscription, or flip an account to past_due. Verification is
// delegated to the official Stripe library via the port — we do not implement
// the HMAC, for the same reason M3 refused to implement Retell's: the published
// docs do not fully specify the algorithm, and a verifier that looks right but
// is wrong accepts forged events silently.
//
// The route mounts express.raw so `req.body` is the exact bytes Stripe signed.
// Any reserialisation changes the signed string and every event fails.
//
// ─── ORDER OF OPERATIONS ────────────────────────────────────────────
//   1. verify signature      — before anything else reads the payload
//   2. check event id        — replays are acknowledged, not reprocessed
//   3. acknowledge (200)     — Stripe retries anything slow
//   4. process               — after the response, never before it
//
// Stripe treats a slow endpoint as a failure and retries, which is how one
// payment becomes three state transitions. Acknowledge first, work second.

const { getBillingConfig } = require("../config/billing");
const { createStripePort } = require("../services/stripe-port");
const account = require("../services/billing-account");

// Only events we actually act on. An allow-list rather than a switch with a
// default: an unrecognised event should be acknowledged and ignored, not
// half-handled by a fallthrough branch.
const HANDLED_EVENTS = Object.freeze({
  "invoice.paid": "payment_succeeded",
  "invoice.payment_failed": "payment_failed",
  "customer.subscription.created": "subscription_created",
  "customer.subscription.updated": "subscription_updated",
  "customer.subscription.deleted": "subscription_cancelled",
});

const MAX_BODY_BYTES = 262144; // 256KB. Stripe events are far smaller.

function createStripeWebhookHandlers(deps = {}) {
  const env = deps.env || process.env;
  const config = deps.config || getBillingConfig(env);
  const port = deps.port || createStripePort({ env, config });
  const accounts = deps.accounts || account;
  const logger = deps.logger || console;
  // Event ids already processed. In production this must be a table, not a Set
  // — a restart empties a Set and replays would be reprocessed. The adapter
  // below is the seam for that; the Set is the test/dev default.
  const seen = deps.seenEvents || new Set();

  async function webhook(req, res) {
    const raw = req.body;

    if (!raw || !raw.length) {
      return res.status(400).json({ error: "Empty body." });
    }
    if (raw.length > MAX_BODY_BYTES) {
      logger.error(`[stripe-webhook] oversized body ${raw.length} bytes`);
      return res.status(413).json({ error: "Too large." });
    }

    const signature = req.headers && (req.headers["stripe-signature"] || req.headers["Stripe-Signature"]);
    const verified = await port.verifyWebhook({
      rawBody: raw,
      signatureHeader: signature,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    });

    if (!verified.ok) {
      // Deliberately terse. A detailed rejection reason tells an attacker how
      // close they got.
      logger.error(`[stripe-webhook] rejected code=${verified.code}`);
      return res.status(400).json({ error: "Signature verification failed." });
    }

    const event = verified.event;
    const eventId = event && event.id;

    // Replay: acknowledge so Stripe stops retrying, but do no work.
    if (eventId && seen.has(eventId)) {
      logger.log(`[stripe-webhook] replay id=${eventId} type=${event.type}`);
      return res.status(200).json({ received: true, duplicate: true });
    }
    if (eventId) seen.add(eventId);

    const action = HANDLED_EVENTS[event.type];

    // Acknowledge BEFORE processing. Stripe retries a slow endpoint.
    res.status(200).json({ received: true, handled: Boolean(action) });

    if (!action) {
      logger.log(`[stripe-webhook] ignored type=${event.type} id=${eventId}`);
      return;
    }

    try {
      await process(action, event);
    } catch (err) {
      // The response has already gone. Log loudly; a swallowed billing error is
      // a client whose payment state is silently wrong.
      logger.error(`[stripe-webhook] processing failed type=${event.type} id=${eventId}: ${err.message}`);
    }
  }

  /**
   * Where a failed payment sends an account.
   *
   * Escalation follows the state machine rather than the attempt count alone.
   * Choosing `collections` purely because attempts >= 2 produced an illegal
   * active → collections transition whenever the counter and the state were out
   * of step — and an illegal transition here is dropped with a log line, which
   * means a client stops being chased for payment and nobody notices.
   *
   * An account only reaches collections from past_due, which is the sequence
   * that actually happens: first failure moves to past_due, subsequent ones
   * escalate from there.
   */
  function failureTarget(current) {
    if (current.state === "past_due" && (current.failedPaymentAttempts || 0) >= 2) return "collections";
    if (current.state === "collections") return "collections";
    return "past_due";
  }

  /** Map a verified event onto an account transition. Never trusts the payload for tenancy. */
  async function process(action, event) {
    const object = (event.data && event.data.object) || {};
    // The tenant comes from metadata WE set when creating the customer, not
    // from anything a caller could influence.
    const clientId = (object.metadata && object.metadata.aida_client_id) || null;

    if (!clientId) {
      logger.error(`[stripe-webhook] no aida_client_id on ${event.type} id=${event.id}`);
      return;
    }

    const current = await accounts.loadAccount(clientId, { supabase: deps.supabase });
    const target = {
      payment_succeeded: "active",
      payment_failed: failureTarget(current),
      subscription_created: "pending_first_payment",
      subscription_updated: null,
      subscription_cancelled: "cancelled",
    }[action];

    // The attempt counter is updated INDEPENDENTLY of the state machine.
    //
    // A second failure while already past_due is a self-transition, which the
    // machine rightly refuses — but the attempt still happened. Tying the
    // counter to the transition meant a repeat failure recorded nothing at all,
    // so the counter never reached 2 and `collections` was unreachable: a
    // client would sit in past_due forever and never be chased.
    const patch = { last_stripe_event_id: event.id };
    if (action === "payment_failed") patch.failed_payment_attempts = (current.failedPaymentAttempts || 0) + 1;
    if (action === "payment_succeeded") patch.failed_payment_attempts = 0;

    if (target && target !== current.state) {
      const decision = accounts.evaluateTransition({ from: current.state, to: target, actor: "system", reason: `stripe:${event.type}` });
      if (decision.ok) {
        patch.state = target;
      } else {
        // A refused transition is information, not a failure to hide. It
        // usually means events arrived out of order, which Stripe does not
        // guarantee against. The counter update below still persists.
        logger.log(`[stripe-webhook] transition refused client=${clientId} ${current.state}->${target} code=${decision.code}`);
      }
    }

    await accounts.saveAccount(clientId, patch, { supabase: deps.supabase });
    logger.log(
      `[stripe-webhook] client=${clientId} ${current.state}->${patch.state || current.state} event=${event.type} attempts=${patch.failed_payment_attempts ?? current.failedPaymentAttempts}`
    );
  }

  return { webhook, process, HANDLED_EVENTS, MAX_BODY_BYTES };
}

module.exports = { createStripeWebhookHandlers, HANDLED_EVENTS, MAX_BODY_BYTES };
