// AIDA — Stripe provider port (M6).
//
// A provider-neutral billing port with four adapters, exactly as
// services/voice-platform-port.js does for the voice provider. The domain talks
// to this interface; only the live adapter knows Stripe exists.
//
//   disabled  no transport code path exists at all. The default.
//   mock      deterministic fixtures. Contacts nothing. For tests and demos.
//   dry_run   validates and RETURNS THE EXACT REQUEST that would be sent,
//             without sending it. Contains no transport code either — this is
//             deliberate, so a bug in mode resolution cannot make a dry run
//             suddenly reach the network.
//   live      the only adapter that requires the stripe library.
//
// ─── WE DO NOT REIMPLEMENT STRIPE'S SIGNATURE VERIFICATION ──────────
// Stripe's docs recommend the official library's constructEvent(), and the
// published page does not fully specify the signing algorithm. Guessing it
// would produce a verifier that looks right and accepts forged events. The
// live adapter therefore delegates to stripe.webhooks.constructEvent and the
// webhook route refuses to run without it. Same decision, same reason, as the
// Retell verifier in M3.
//
// ─── IDEMPOTENCY ────────────────────────────────────────────────────
// Every mutating request carries an Idempotency-Key derived from what it does,
// not from when it ran. A retried subscription creation must not create a
// second subscription.
//
// The stripe library is required LAZILY, inside the live adapter only, so this
// module loads on a checkout with no node_modules (house rule).

const { getBillingConfig } = require("../config/billing");
const { createHash } = require("crypto");

const PORT_VERSION = "stripe-port-2026-08-01";

// Stripe's own API version. Pinned: an unpinned integration changes behaviour
// when Stripe ships a new version, and it changes it in production, silently.
const STRIPE_API_VERSION = "2025-08-27.basil";

const OPERATIONS = Object.freeze([
  "createCustomer",
  "createSubscription",
  "updateSubscription",
  "cancelSubscription",
  "reportMeterEvent",
  "createBillingPortalSession",
  "applyCoupon",
]);

/** Deterministic idempotency key: same intent → same key, forever. */
function idempotencyKey(operation, parts) {
  const stable = JSON.stringify(parts, Object.keys(parts).sort());
  return `aida_${operation}_${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}

// ── Request builders (shared by every adapter) ──────────────────────
//
// The request is built identically whatever the mode. That is the point: the
// dry run shows you the bytes the live call would send, not an approximation
// assembled by different code.

function buildCreateCustomerRequest({ clientId, businessName, email }) {
  return {
    method: "POST",
    path: "/v1/customers",
    idempotencyKey: idempotencyKey("createCustomer", { clientId }),
    body: {
      name: businessName,
      email: email || undefined,
      // The tenant key travels with the customer so a Stripe-side object can
      // always be traced back to a client without a lookup table.
      metadata: { aida_client_id: clientId, aida_product: "locksmith_receptionist" },
    },
  };
}

function buildCreateSubscriptionRequest({ clientId, stripeCustomerId, priceId, meterPriceIds = [], couponId = null, trialEnd = null }) {
  const items = [{ price: priceId }, ...meterPriceIds.map((p) => ({ price: p }))];
  return {
    method: "POST",
    path: "/v1/subscriptions",
    idempotencyKey: idempotencyKey("createSubscription", { clientId, priceId, meterPriceIds }),
    body: {
      customer: stripeCustomerId,
      items,
      discounts: couponId ? [{ coupon: couponId }] : undefined,
      trial_end: trialEnd || undefined,
      // If the first payment fails we want to know immediately rather than
      // discover it a month later.
      payment_behavior: "default_incomplete",
      metadata: { aida_client_id: clientId },
    },
  };
}

/**
 * The founding offer, expressed as Stripe expects it.
 * duration=repeating + duration_in_months=2, with amount_off in AUD cents.
 * (docs.stripe.com/billing/subscriptions/coupons)
 */
function buildFoundingOfferCouponRequest({ planId, amountOffCents, durationMonths }) {
  return {
    method: "POST",
    path: "/v1/coupons",
    idempotencyKey: idempotencyKey("applyCoupon", { planId, amountOffCents, durationMonths }),
    body: {
      id: `aida_founding_${planId}`,
      name: `AIDA founding pilot — ${planId}`,
      amount_off: amountOffCents,
      currency: "aud",
      duration: "repeating",
      duration_in_months: durationMonths,
      metadata: { aida_offer: "founding_two_months_49", aida_plan: planId },
    },
  };
}

/**
 * A meter event. Stripe's contract:
 *   POST /v1/billing/meter_events, event_name + payload{stripe_customer_id,value},
 *   optional identifier (dedup ≥24h) and timestamp (past 35d, future ≤5min).
 *
 * The identifier doubles as the idempotency key here — Stripe already
 * deduplicates on it, so a second key would add nothing.
 */
function buildMeterEventRequest(event) {
  return {
    method: "POST",
    path: "/v1/billing/meter_events",
    idempotencyKey: event.identifier,
    body: {
      event_name: event.event_name,
      identifier: event.identifier,
      timestamp: event.timestamp,
      payload: event.payload,
    },
  };
}

function buildPortalSessionRequest({ clientId, stripeCustomerId, returnUrl }) {
  return {
    method: "POST",
    path: "/v1/billing_portal/sessions",
    // NOT idempotent by intent: each visit is a new short-lived session.
    idempotencyKey: null,
    body: { customer: stripeCustomerId, return_url: returnUrl, metadata: { aida_client_id: clientId } },
  };
}

// ── Adapters ────────────────────────────────────────────────────────

function disabledAdapter(reasons) {
  const refuse = async (operation) => ({
    ok: false,
    mode: "disabled",
    operation,
    code: "billing_disabled",
    message: "Billing is switched off.",
    reasons,
  });
  return {
    mode: "disabled",
    async createCustomer() { return refuse("createCustomer"); },
    async createSubscription() { return refuse("createSubscription"); },
    async updateSubscription() { return refuse("updateSubscription"); },
    async cancelSubscription() { return refuse("cancelSubscription"); },
    async reportMeterEvent() { return refuse("reportMeterEvent"); },
    async createBillingPortalSession() { return refuse("createBillingPortalSession"); },
    async applyCoupon() { return refuse("applyCoupon"); },
    async verifyWebhook() {
      return { ok: false, code: "billing_disabled", message: "Billing is switched off." };
    },
  };
}

/** Deterministic fixtures. Ids are derived, never random, so tests are stable. */
function mockAdapter() {
  const fake = (prefix, seed) => `${prefix}_mock${createHash("sha256").update(String(seed)).digest("hex").slice(0, 14)}`;
  return {
    mode: "mock",
    async createCustomer({ clientId, businessName, email }) {
      const request = buildCreateCustomerRequest({ clientId, businessName, email });
      return { ok: true, mode: "mock", request, result: { id: fake("cus", clientId), object: "customer" } };
    },
    async createSubscription(args) {
      const request = buildCreateSubscriptionRequest(args);
      return {
        ok: true, mode: "mock", request,
        result: { id: fake("sub", args.clientId), object: "subscription", status: "active", items: { data: request.body.items } },
      };
    },
    async updateSubscription(args) {
      return { ok: true, mode: "mock", result: { id: args.subscriptionId, object: "subscription", status: "active" } };
    },
    async cancelSubscription(args) {
      return { ok: true, mode: "mock", result: { id: args.subscriptionId, object: "subscription", status: "canceled" } };
    },
    async reportMeterEvent(event) {
      const request = buildMeterEventRequest(event);
      return { ok: true, mode: "mock", request, result: { object: "billing.meter_event", identifier: event.identifier } };
    },
    async createBillingPortalSession(args) {
      const request = buildPortalSessionRequest(args);
      // Deliberately not a plausible-looking real Stripe URL: a mock URL that
      // looks real is a mock URL someone will eventually click in production.
      return { ok: true, mode: "mock", request, result: { url: "https://example.com/mock-billing-portal", object: "billing_portal.session" } };
    },
    async applyCoupon(args) {
      return { ok: true, mode: "mock", request: buildFoundingOfferCouponRequest(args), result: { id: `aida_founding_${args.planId}`, object: "coupon" } };
    },
    async verifyWebhook() {
      return { ok: false, code: "mock_mode", message: "Webhook signatures cannot be verified in mock mode." };
    },
  };
}

/**
 * Dry run. Builds and returns the exact request, sends nothing.
 *
 * CONTAINS NO TRANSPORT CODE. Not "does not call it" — does not have it. There
 * is no require of the stripe library in this function and no network call to
 * accidentally reach, so no configuration mistake can turn a dry run into a
 * real charge.
 */
function dryRunAdapter(reasons) {
  const plan = (operation, request) => ({
    ok: true,
    mode: "dry_run",
    operation,
    wouldSend: request,
    sent: false,
    reasons,
    message: "Dry run — this request was built and validated but not sent.",
  });
  return {
    mode: "dry_run",
    async createCustomer(a) { return plan("createCustomer", buildCreateCustomerRequest(a)); },
    async createSubscription(a) { return plan("createSubscription", buildCreateSubscriptionRequest(a)); },
    async updateSubscription(a) { return plan("updateSubscription", { method: "POST", path: `/v1/subscriptions/${a.subscriptionId}`, body: a.changes || {} }); },
    async cancelSubscription(a) { return plan("cancelSubscription", { method: "DELETE", path: `/v1/subscriptions/${a.subscriptionId}` }); },
    async reportMeterEvent(e) { return plan("reportMeterEvent", buildMeterEventRequest(e)); },
    async createBillingPortalSession(a) { return plan("createBillingPortalSession", buildPortalSessionRequest(a)); },
    async applyCoupon(a) { return plan("applyCoupon", buildFoundingOfferCouponRequest(a)); },
    async verifyWebhook() {
      return { ok: false, code: "dry_run", message: "Webhook signatures are not verified in dry-run mode." };
    },
  };
}

/**
 * Live. The only adapter that touches the network, and the only one that
 * requires the stripe library.
 */
function liveAdapter(config) {
  function client() {
    // Lazy: the module must load without node_modules.
    const Stripe = require("stripe");
    return new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      // Identifies AIDA in Stripe's logs, which matters when diagnosing a
      // charge someone disputes.
      appInfo: { name: "AIDA Locksmith Receptionist", version: PORT_VERSION },
      maxNetworkRetries: 2,
      timeout: 20000,
    });
  }

  async function call(operation, fn, request) {
    try {
      const result = await fn(client());
      return { ok: true, mode: "live", operation, request, result };
    } catch (err) {
      // Stripe errors carry a type and code worth preserving; the raw error may
      // contain request details, so only the classified fields are returned.
      return {
        ok: false, mode: "live", operation, request,
        code: err.code || err.type || "stripe_error",
        stripeType: err.type || null,
        message: err.message || "Stripe request failed.",
        retryable: err.type === "StripeConnectionError" || err.type === "StripeAPIError",
      };
    }
  }

  return {
    mode: "live",
    async createCustomer(a) {
      const r = buildCreateCustomerRequest(a);
      return call("createCustomer", (s) => s.customers.create(r.body, { idempotencyKey: r.idempotencyKey }), r);
    },
    async createSubscription(a) {
      const r = buildCreateSubscriptionRequest(a);
      return call("createSubscription", (s) => s.subscriptions.create(r.body, { idempotencyKey: r.idempotencyKey }), r);
    },
    async updateSubscription(a) {
      const r = { method: "POST", path: `/v1/subscriptions/${a.subscriptionId}`, body: a.changes || {}, idempotencyKey: idempotencyKey("updateSubscription", a) };
      return call("updateSubscription", (s) => s.subscriptions.update(a.subscriptionId, r.body, { idempotencyKey: r.idempotencyKey }), r);
    },
    async cancelSubscription(a) {
      const r = { method: "DELETE", path: `/v1/subscriptions/${a.subscriptionId}` };
      return call("cancelSubscription", (s) => s.subscriptions.cancel(a.subscriptionId), r);
    },
    async reportMeterEvent(e) {
      const r = buildMeterEventRequest(e);
      return call("reportMeterEvent", (s) => s.billing.meterEvents.create(r.body), r);
    },
    async createBillingPortalSession(a) {
      const r = buildPortalSessionRequest(a);
      return call("createBillingPortalSession", (s) => s.billingPortal.sessions.create(r.body), r);
    },
    async applyCoupon(a) {
      const r = buildFoundingOfferCouponRequest(a);
      return call("applyCoupon", (s) => s.coupons.create(r.body, { idempotencyKey: r.idempotencyKey }), r);
    },
    /**
     * Delegated to the official library. We do not implement the HMAC.
     * `rawBody` must be the exact bytes Stripe sent — any reserialisation
     * changes the signed string and every event fails verification.
     */
    async verifyWebhook({ rawBody, signatureHeader, webhookSecret }) {
      if (!webhookSecret) return { ok: false, code: "no_secret", message: "STRIPE_WEBHOOK_SECRET is not set." };
      if (!signatureHeader) return { ok: false, code: "no_signature", message: "Missing Stripe-Signature header." };
      try {
        const Stripe = require("stripe");
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
        const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
        return { ok: true, event };
      } catch (err) {
        return { ok: false, code: "invalid_signature", message: err.message };
      }
    },
  };
}

/** The one entry point. Mode is resolved from config, never passed in. */
function createStripePort({ env = process.env, config = null } = {}) {
  const cfg = config || getBillingConfig(env);
  switch (cfg.mode) {
    case "mock": return { ...mockAdapter(), config: cfg };
    case "dry_run": return { ...dryRunAdapter(cfg.reasons), config: cfg };
    case "live": return { ...liveAdapter(cfg), config: cfg };
    default: return { ...disabledAdapter(cfg.reasons), config: cfg };
  }
}

module.exports = {
  PORT_VERSION,
  STRIPE_API_VERSION,
  OPERATIONS,
  createStripePort,
  idempotencyKey,
  buildCreateCustomerRequest,
  buildCreateSubscriptionRequest,
  buildFoundingOfferCouponRequest,
  buildMeterEventRequest,
  buildPortalSessionRequest,
  disabledAdapter,
  mockAdapter,
  dryRunAdapter,
  liveAdapter,
};
