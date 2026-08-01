// AIDA — billing route handlers (M6).
//
// Express-free and injectable, the house pattern.
//
// Tenant key is req.clientId from the verified client session, everywhere.
// Nothing reads a client id, plan id or amount from the request in a way that
// could change what someone is charged: a plan CHANGE names a plan, and the
// price for that plan is looked up in the catalogue, never taken from the body.
// Accepting an amount from a browser is how a client pays A$0.01 a month.

const { getBillingConfig } = require("../config/billing");
const plans = require("../services/billing-plans");
const usageService = require("../services/billing-usage");
const accounts = require("../services/billing-account");
const readModel = require("../services/locksmith-portal-readmodel");
const { createStripePort } = require("../services/stripe-port");
const { renderBillingPage } = require("../views/billing-page");
const { createRateLimiter } = require("../services/rate-limit");

const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    // form-action allows Stripe because the "manage payment" control leaves for
    // the hosted billing portal. Nothing else is permitted.
    "form-action 'self' https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "no-store, private",
});

const ACTION_LIMIT = 30;
const ACTION_WINDOW_MS = 5 * 60 * 1000;
const PRUNE_EVERY = 100;

function isJsonRequest(req) {
  const type = (req.headers && (req.headers["content-type"] || req.headers["Content-Type"])) || "";
  return String(type).toLowerCase().includes("application/json");
}

function createBillingHandlers(deps = {}) {
  const env = deps.env || process.env;
  const config = deps.config || getBillingConfig(env);
  const port = deps.port || createStripePort({ env, config });
  const rm = deps.readModel || readModel;
  const meter = deps.usage || usageService;
  const accountsApi = deps.accounts || accounts;
  const catalogue = deps.plans || plans;
  const render = deps.render || renderBillingPage;
  const logger = deps.logger || console;
  const limiter = deps.limiter || createRateLimiter({ limit: ACTION_LIMIT, windowMs: ACTION_WINDOW_MS });
  let sincePrune = 0;

  function rateLimited(req, res) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    if ((sincePrune += 1) >= PRUNE_EVERY) {
      sincePrune = 0;
      limiter.prune();
    }
    if (limiter.check(key).allowed) return false;
    res.status(429).json({ error: "Too many requests." });
    return true;
  }

  /** How many whole months since billing started — drives the founding offer. */
  function monthIndexFor(account, now = new Date()) {
    if (!account || !account.offerStartedAt) return null;
    const started = new Date(account.offerStartedAt);
    if (Number.isNaN(started.getTime())) return null;
    return Math.max(0, (now.getFullYear() - started.getFullYear()) * 12 + (now.getMonth() - started.getMonth()));
  }

  async function buildBillingModel(clientId, { now = new Date() } = {}) {
    const account = await accountsApi.loadAccount(clientId, { supabase: deps.supabase });
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const callList = await rm.fetchCalls(clientId, { supabase: deps.supabase, limit: 300, since: periodStart });
    const usage = meter.meterPeriod({ calls: callList.calls, periodStart, periodEnd: null });

    // A client with no plan yet is shown Micro, because that is what they would
    // start on — not because they are being charged for it.
    const planId = account.planId || "micro";
    const plan = catalogue.getPlan(planId);
    const monthIndex = monthIndexFor(account, now);

    const price = catalogue.priceMonth({ planId, calls: usage.billableCalls, minutes: usage.billableMinutes, monthIndex });
    const fit = catalogue.bestFitPlan({ calls: usage.billableCalls, minutes: usage.billableMinutes, currentPlanId: planId, monthIndex });
    const offer = monthIndex === null ? null : catalogue.applyFoundingOffer(planId, { monthIndex });

    return {
      account: accountsApi.describeAccount(account.state, { attempts: account.failedPaymentAttempts }),
      rawAccount: account,
      usage: { ...usage, billableMinimumSeconds: meter.BILLABLE_MINIMUM_SECONDS },
      price,
      plan,
      fit,
      offer,
      catalogue: catalogue.publicCatalogue({ monthIndex }),
      monthIndex,
    };
  }

  // ── GET /client/locksmith/billing ─────────────────────────────────
  async function billingPage(req, res) {
    try {
      const model = await buildBillingModel(req.clientId, { now: deps.now ? deps.now() : new Date() });
      res.set(PAGE_SECURITY_HEADERS);
      res.type("html").send(
        render({
          ...model,
          // Built on demand, never stored: portal sessions are short-lived.
          portalUrl: null,
          businessName: (req.client && req.client.name) || null,
          mode: config.mode,
        })
      );
    } catch (err) {
      if (err.code === "billing_unavailable") {
        res.set(PAGE_SECURITY_HEADERS);
        return res.status(503).type("html").send("<h1>Billing isn't switched on yet</h1><p>Nothing is being charged.</p>");
      }
      logger.error(`[billing] page failed for ${req.clientId}: ${err.message}`);
      res.status(500).type("html").send("<h1>Something went wrong</h1>");
    }
  }

  // ── POST /client/locksmith/billing/portal-session ─────────────────
  // Creates a Stripe hosted-portal session and returns its URL.
  async function portalSession(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ error: "Send application/json." });
    if (rateLimited(req, res)) return;

    try {
      const account = await accountsApi.loadAccount(req.clientId, { supabase: deps.supabase });
      if (!account.stripeCustomerId) {
        return res.status(409).json({ error: "There's no payment account set up yet.", code: "no_customer" });
      }

      const result = await port.createBillingPortalSession({
        clientId: req.clientId,
        stripeCustomerId: account.stripeCustomerId,
        returnUrl: `${env.BASE_URL || ""}/client/locksmith/billing`,
      });

      if (!result.ok) return res.status(503).json({ error: "Payment management isn't available right now.", code: result.code });
      // dry_run returns the request rather than a session; say so plainly
      // instead of handing back a URL that does not exist.
      if (result.sent === false) {
        return res.json({ mode: result.mode, url: null, wouldSend: result.wouldSend, message: result.message });
      }
      return res.json({ mode: result.mode, url: result.result.url });
    } catch (err) {
      if (err.code === "billing_unavailable") return res.status(503).json({ error: "Billing isn't switched on yet." });
      logger.error(`[billing] portal session failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ error: "Could not open payment management." });
    }
  }

  // ── POST /client/locksmith/billing/plan ───────────────────────────
  // Change plan. The PLAN ID comes from the request; the PRICE never does.
  async function changePlan(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ error: "Send application/json." });
    if (rateLimited(req, res)) return;

    const planId = req.body && req.body.planId;
    const plan = catalogue.getPlan(planId);
    if (!plan) return res.status(400).json({ error: "That isn't one of our plans.", plans: catalogue.PLAN_IDS });

    try {
      const account = await accountsApi.loadAccount(req.clientId, { supabase: deps.supabase });

      // A plan change is not a charge, so it does not need the charge gate —
      // but it does need somewhere to apply it.
      if (!account.stripeSubscriptionId) {
        await accountsApi.saveAccount(req.clientId, { plan_id: planId }, { supabase: deps.supabase });
        logger.log(`[billing] plan_selected client=${req.clientId} plan=${planId} (no subscription yet)`);
        return res.json({ planId, applied: "recorded", message: `You're set to start on ${plan.name}.` });
      }

      const result = await port.updateSubscription({
        clientId: req.clientId,
        subscriptionId: account.stripeSubscriptionId,
        // Price ids come from configuration, never from the client.
        changes: { metadata: { aida_plan: planId } },
      });

      if (!result.ok) return res.status(503).json({ error: "Could not change your plan right now.", code: result.code });

      await accountsApi.saveAccount(req.clientId, { plan_id: planId }, { supabase: deps.supabase });
      logger.log(`[billing] plan_changed client=${req.clientId} plan=${planId} mode=${result.mode}`);
      return res.json({ planId, applied: result.mode, message: `You're now on ${plan.name}.` });
    } catch (err) {
      if (err.code === "billing_unavailable") return res.status(503).json({ error: "Billing isn't switched on yet." });
      logger.error(`[billing] plan change failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ error: "Could not change your plan." });
    }
  }

  return { billingPage, portalSession, changePlan, buildBillingModel, monthIndexFor, PAGE_SECURITY_HEADERS };
}

module.exports = { createBillingHandlers, PAGE_SECURITY_HEADERS, isJsonRequest };
