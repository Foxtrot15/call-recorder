// AIDA Locksmith — M6 usage metering, plans, the founding offer and billing.
//
// Runs on a bare checkout: no node_modules (in particular no `stripe`), no
// database, no network. Handlers are exercised through the injected-deps
// factories with fake req/res, the house pattern.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config/billing");
const plans = require("../src/services/billing-plans");
const usage = require("../src/services/billing-usage");
const account = require("../src/services/billing-account");
const port = require("../src/services/stripe-port");
const { createStripeWebhookHandlers } = require("../src/routes/stripe-webhook-handler");
const { createBillingHandlers } = require("../src/routes/billing-handlers");
const billingView = require("../src/views/billing-page");

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, contentType: null,
    status(c) { this.statusCode = c; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    type(t) { this.contentType = t; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
}

const SILENT = { log() {}, error() {} };

// ── Danger gates ────────────────────────────────────────────────────

describe("billing danger gates", () => {
  test("everything is off by default", () => {
    const c = config.getBillingConfig({});
    assert.equal(c.mode, "disabled");
    assert.equal(c.canCharge, false);
    assert.equal(c.chargesRealMoney, false);
  });

  test("every flag is strict-parse", () => {
    for (const v of ["TRUE", "True", "1", "yes", "on", " true"]) {
      assert.equal(config.isBillingEnabled({ BILLING_ENABLED: v }), false);
      assert.equal(config.isChargesEnabled({ BILLING_CHARGES_ENABLED: v }), false);
      assert.equal(config.isLiveWritesEnabled({ BILLING_LIVE_WRITES_ENABLED: v }), false);
    }
    assert.equal(config.isBillingEnabled({ BILLING_ENABLED: "true" }), true);
  });

  test("dry run is ON unless explicitly \"false\", so a typo stays safe", () => {
    assert.equal(config.isDryRun({}), true);
    assert.equal(config.isDryRun({ BILLING_DRY_RUN: "TRUE" }), true);
    assert.equal(config.isDryRun({ BILLING_DRY_RUN: "no" }), true);
    assert.equal(config.isDryRun({ BILLING_DRY_RUN: "false" }), false);
  });

  test("charging needs four flags, a key and a webhook secret simultaneously", () => {
    const full = {
      BILLING_ENABLED: "true", BILLING_LIVE_WRITES_ENABLED: "true", BILLING_CHARGES_ENABLED: "true",
      BILLING_DRY_RUN: "false", STRIPE_SECRET_KEY: "sk_test_abcdefghij", STRIPE_WEBHOOK_SECRET: "whsec_x",
    };
    assert.equal(config.getBillingConfig(full).canCharge, true);

    // Remove any single one and charging stops.
    for (const key of Object.keys(full)) {
      const partial = { ...full };
      delete partial[key];
      assert.equal(config.getBillingConfig(partial).canCharge, false, `removing ${key} must stop charging`);
    }
  });

  test("mode degrades rather than half-working", () => {
    assert.equal(config.resolveBillingMode({ BILLING_ENABLED: "true" }).mode, "mock");
    assert.equal(config.resolveBillingMode({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_abc" }).mode, "dry_run");
  });

  test("the mode is derived from the key, never declared", () => {
    assert.equal(config.keyMode("sk_live_abc"), "live");
    assert.equal(config.keyMode("sk_test_abc"), "test");
    assert.equal(config.keyMode("pk_live_abc"), "unknown");
    assert.equal(config.keyMode(""), "unknown");
  });

  test("a secret key is never returned in full", () => {
    const described = config.describeKey("sk_test_51ABCDEFGHIJKLMNOP");
    assert.ok(!described.hint.includes("51ABCDEFGHIJKLMNOP"));
    assert.equal(described.mode, "test");
  });

  test("a live key outside production refuses to charge", () => {
    const check = config.checkEnvironmentAgreement({ STRIPE_SECRET_KEY: "sk_live_abc", NODE_ENV: "development" });
    assert.equal(check.ok, false);
    assert.match(check.problems.join(" "), /Refusing to charge outside production/);

    const cfg = config.getBillingConfig({
      BILLING_ENABLED: "true", BILLING_LIVE_WRITES_ENABLED: "true", BILLING_CHARGES_ENABLED: "true",
      BILLING_DRY_RUN: "false", STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_WEBHOOK_SECRET: "whsec_x", NODE_ENV: "development",
    });
    assert.equal(cfg.canCharge, false, "the whole config must refuse, not just the check");
  });

  test("a test key in production is caught too", () => {
    const check = config.checkEnvironmentAgreement({ STRIPE_SECRET_KEY: "sk_test_abc", NODE_ENV: "production", BILLING_CHARGES_ENABLED: "true" });
    assert.equal(check.ok, false);
    assert.match(check.problems.join(" "), /would silently not be real/);
  });

  test("the router gates exit so disabled deploys 404", () => {
    let exited = null;
    config.billingRouterGate({})({}, {}, (a) => { exited = a; });
    assert.equal(exited, "router");

    // The webhook needs BOTH flags.
    let webhookExit = null;
    config.billingWebhookGate({ BILLING_ENABLED: "true" })({}, {}, (a) => { webhookExit = a; });
    assert.equal(webhookExit, "router");
  });
});

// ── Plans and money ─────────────────────────────────────────────────

describe("plan catalogue", () => {
  test("has the four advertised tiers at the advertised prices", () => {
    assert.deepEqual(plans.PLAN_IDS, ["micro", "solo", "growth", "pro"]);
    assert.equal(plans.getPlan("micro").monthlyCents, 4900);
    assert.equal(plans.getPlan("solo").monthlyCents, 9900);
    assert.equal(plans.getPlan("growth").monthlyCents, 19900);
    assert.equal(plans.getPlan("pro").monthlyCents, 39900);
  });

  test("every amount is an integer number of cents", () => {
    for (const plan of plans.PLANS) {
      for (const field of ["monthlyCents", "overagePerCallCents", "overagePerMinuteCents"]) {
        assert.ok(Number.isInteger(plan[field]), `${plan.id}.${field} must be an integer`);
      }
    }
  });

  test("formats money without floating-point artefacts", () => {
    assert.equal(plans.formatAud(4900), "A$49");
    assert.equal(plans.formatAud(12345), "A$123.45");
    assert.equal(plans.formatAud(5), "A$0.05");
    assert.equal(plans.formatAud(0), "A$0");
    // The classic: 0.1 + 0.2. Integer cents make it a non-event.
    assert.equal(plans.formatAud(10 + 20), "A$0.30");
  });

  test("overage is charged on calls and minutes independently", () => {
    const p = plans.priceMonth({ planId: "micro", calls: 60, minutes: 150 });
    assert.equal(p.overCalls, 20);
    assert.equal(p.overMinutes, 70);
    assert.equal(p.callOverageCents, 20 * 150);
    assert.equal(p.minuteOverageCents, 70 * 75);
    assert.equal(p.overageCents, p.callOverageCents + p.minuteOverageCents);
  });

  test("usage inside the allowance costs exactly the plan price", () => {
    const p = plans.priceMonth({ planId: "solo", calls: 100, minutes: 200 });
    assert.equal(p.totalCents, 9900);
    assert.equal(p.withinAllowance, true);
  });

  test("an unknown plan is refused, not defaulted", () => {
    assert.equal(plans.priceMonth({ planId: "enterprise", calls: 1, minutes: 1 }).ok, false);
    assert.equal(plans.getPlan("enterprise"), null);
  });
});

describe("best-fit plan", () => {
  test("always recommends the cheapest total for the client's real usage", () => {
    const fit = plans.bestFitPlan({ calls: 130, minutes: 280, currentPlanId: "micro" });
    assert.equal(fit.recommended.planId, fit.ranked[0].planId);
    for (const p of fit.plans) {
      assert.ok(fit.recommended.totalCents <= p.totalCents, `${p.planId} is cheaper than the recommendation`);
    }
  });

  test("never upsells for headroom", () => {
    // Regression: an earlier version preferred the cheapest COMFORTABLE plan
    // and recommended Growth (A$199) over Solo (A$123) at this usage — a 62%
    // price rise dressed as advice.
    const fit = plans.bestFitPlan({ calls: 130, minutes: 280 });
    assert.equal(fit.recommended.planId, "solo");
    assert.ok(fit.headroomWarning, "tight headroom must still be disclosed");
    assert.equal(fit.headroomWarning.planId, "solo");
    assert.ok(fit.headroomWarning.alternative.extraCentsThisMonth > 0, "the alternative's extra cost must be stated");
  });

  test("a tie goes to the smaller plan", () => {
    // During the founding offer every plan's subscription is A$49, so the
    // cheapest is whichever has no overage — and among equals, the smallest.
    const fit = plans.bestFitPlan({ calls: 1, minutes: 1, monthIndex: 0 });
    assert.equal(fit.recommended.planId, "micro");
  });

  test("names the direction of a switch honestly", () => {
    const up = plans.bestFitPlan({ calls: 400, minutes: 900, currentPlanId: "micro" });
    assert.equal(up.direction, "upgrade");
    const down = plans.bestFitPlan({ calls: 5, minutes: 10, currentPlanId: "pro" });
    assert.equal(down.direction, "downgrade");
    assert.ok(down.savingCents > 0);
  });
});

describe("founding offer", () => {
  test("is A$49 a month for two months on every plan", () => {
    for (const id of plans.PLAN_IDS) {
      const o = plans.applyFoundingOffer(id, { monthIndex: 0 });
      assert.equal(o.payableMonthlyCents, 4900, `${id} must pay A$49 during the offer`);
      assert.equal(o.offerActive, true);
    }
  });

  test("expires after exactly two months", () => {
    assert.equal(plans.applyFoundingOffer("growth", { monthIndex: 1 }).offerActive, true);
    assert.equal(plans.applyFoundingOffer("growth", { monthIndex: 2 }).offerActive, false);
    assert.equal(plans.applyFoundingOffer("growth", { monthIndex: 2 }).payableMonthlyCents, 19900);
  });

  test("never produces a negative discount on a plan cheaper than the offer", () => {
    const o = plans.applyFoundingOffer("micro", { monthIndex: 0 });
    assert.equal(o.discountCents, 0);
    assert.equal(o.payableMonthlyCents, 4900);
  });

  test("does not discount usage charges", () => {
    assert.equal(plans.FOUNDING_OFFER.coversOverage, false);
    const p = plans.priceMonth({ planId: "micro", calls: 60, minutes: 150, monthIndex: 0 });
    assert.ok(p.overageCents > 0, "overage is still charged during the offer");
    assert.equal(p.subscriptionCents, 4900);
    assert.equal(p.totalCents, 4900 + p.overageCents);
  });

  test("requires a human to grant", () => {
    assert.equal(plans.FOUNDING_OFFER.requiresFounderApproval, true);
  });
});

// ── Usage metering ──────────────────────────────────────────────────

describe("usage metering", () => {
  const calls = [
    { id: 1, at: "2026-07-30T02:14:00Z", durationSeconds: 200, outcome: "transferred" },
    { id: 2, at: "2026-07-30T14:02:00Z", durationSeconds: 4, outcome: "message_taken" },
    { id: 3, at: "2026-07-29T19:40:00Z", durationSeconds: 61, outcome: "callback_promised" },
    { id: 4, at: "2026-07-28T10:00:00Z", durationSeconds: 120, outcome: "spam" },
    { id: 5, at: "2026-07-27T10:00:00Z", durationSeconds: 90, isSetupTest: true },
  ];

  test("a call too short to be a conversation is not charged", () => {
    const a = usage.assessCall({ durationSeconds: 4 });
    assert.equal(a.billable, false);
    assert.equal(a.reason, "too_short");
  });

  test("the client's own setup test is not charged", () => {
    const a = usage.assessCall({ durationSeconds: 90, isSetupTest: true });
    assert.equal(a.billable, false);
    assert.equal(a.reason, "setup_test");
  });

  test("spam is not charged", () => {
    assert.equal(usage.assessCall({ durationSeconds: 120, outcome: "spam" }).billable, false);
  });

  test("minutes round up per call, and the basis is stated", () => {
    assert.equal(usage.assessCall({ durationSeconds: 61 }).minutes, 2);
    assert.equal(usage.assessCall({ durationSeconds: 60 }).minutes, 1);
    assert.equal(usage.assessCall({ durationSeconds: 200 }).minutes, 4);
    assert.equal(usage.meterPeriod({ calls }).roundingBasis, "per_call_rounded_up");
  });

  test("every exclusion is itemised so an invoice can be defended", () => {
    const m = usage.meterPeriod({ calls });
    assert.equal(m.billableCalls, 2);
    assert.equal(m.excludedCalls, 3);
    assert.deepEqual(m.excludedByReason, { too_short: 1, spam: 1, setup_test: 1 });
    for (const line of m.lines.filter((l) => !l.billable)) {
      assert.ok(line.excludedDetail, "every excluded call must say why");
    }
  });

  test("the portal's minimum and billing's minimum are the same constant", () => {
    const rm = require("../src/services/locksmith-portal-readmodel");
    assert.equal(usage.BILLABLE_MINIMUM_SECONDS, rm.BILLABLE_MINIMUM_SECONDS);
  });
});

describe("meter events", () => {
  const now = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
  const m = usage.meterPeriod({ calls: [{ id: 1, at: "2026-07-30T02:14:00Z", durationSeconds: 200 }] });

  test("carry the fields Stripe requires", () => {
    const r = usage.buildMeterEvents({ clientId: "acme", stripeCustomerId: "cus_1", usage: m, nowSeconds: now });
    assert.equal(r.ok, true);
    for (const e of r.events) {
      assert.ok(e.event_name && e.event_name.length <= 100);
      assert.ok(e.identifier && e.identifier.length <= 100);
      assert.ok(e.payload.stripe_customer_id, "the payload must carry stripe_customer_id");
      assert.ok(e.payload.value !== undefined, "the payload must carry value");
      assert.ok(Number.isInteger(e.timestamp));
    }
  });

  test("identifiers are deterministic, so a retry cannot double-bill", () => {
    const a = usage.buildMeterEvents({ clientId: "acme", stripeCustomerId: "cus_1", usage: m, nowSeconds: now });
    const b = usage.buildMeterEvents({ clientId: "acme", stripeCustomerId: "cus_1", usage: m, nowSeconds: now });
    assert.deepEqual(a.events.map((e) => e.identifier), b.events.map((e) => e.identifier));
  });

  test("identifiers are tenant-scoped", () => {
    assert.notEqual(usage.meterIdentifier("acme", "aida_calls", 1), usage.meterIdentifier("other", "aida_calls", 1));
  });

  test("usage older than Stripe's 35-day window is refused and reported, not dropped", () => {
    const old = usage.meterPeriod({ calls: [{ id: 9, at: "2026-05-01T10:00:00Z", durationSeconds: 300 }] });
    const r = usage.buildMeterEvents({ clientId: "acme", stripeCustomerId: "cus_1", usage: old, nowSeconds: now });
    assert.equal(r.events.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, "too_old");
  });

  test("a future timestamp beyond Stripe's tolerance is refused", () => {
    assert.equal(usage.checkTimestamp(now + 600, now).ok, false);
    assert.equal(usage.checkTimestamp(now + 60, now).ok, true);
  });

  test("a client with no Stripe customer produces no events", () => {
    const r = usage.buildMeterEvents({ clientId: "acme", stripeCustomerId: null, usage: m, nowSeconds: now });
    assert.equal(r.ok, false);
    assert.equal(r.code, "no_customer");
  });
});

describe("threshold notices", () => {
  const plan = plans.getPlan("micro");

  test("fire at 80% and again at 100%", () => {
    const at80 = usage.evaluateThresholds({ usage: { billableCalls: 32, billableMinutes: 0 }, plan, alreadyNotified: [] });
    assert.ok(at80.notices.some((n) => n.key === "calls_approaching"));
    assert.ok(!at80.notices.some((n) => n.key === "calls_reached"));

    const at100 = usage.evaluateThresholds({ usage: { billableCalls: 40, billableMinutes: 0 }, plan, alreadyNotified: [] });
    assert.ok(at100.notices.some((n) => n.key === "calls_reached"));
  });

  test("fire once per period", () => {
    const again = usage.evaluateThresholds({
      usage: { billableCalls: 40, billableMinutes: 80 }, plan,
      alreadyNotified: ["calls_approaching", "calls_reached", "minutes_approaching", "minutes_reached"],
    });
    assert.equal(again.notices.length, 0);
  });

  test("never say or imply the service stops", () => {
    const notices = usage.evaluateThresholds({ usage: { billableCalls: 45, billableMinutes: 90 }, plan, alreadyNotified: [], overageCents: 5000 }).notices;
    assert.ok(notices.length > 0);
    for (const n of notices) {
      assert.equal(n.serviceContinues, true);
      assert.ok(!/suspend|cut off|stopped|disabled|blocked/i.test(n.message), `"${n.message}" implies service loss`);
    }
  });

  test("the 100% notice states the rate rather than just alarming", () => {
    const n = usage.evaluateThresholds({ usage: { billableCalls: 40, billableMinutes: 0 }, plan, alreadyNotified: [] })
      .notices.find((x) => x.key === "calls_reached");
    assert.match(n.message, /keeps answering/i);
    assert.match(n.message, /charged/i);
  });
});

// ── Account lifecycle ───────────────────────────────────────────────

describe("billing account lifecycle", () => {
  test("a payment failure NEVER stops the phone being answered", () => {
    for (const state of ["past_due", "collections"]) {
      const d = account.describeAccount(state);
      assert.equal(d.serviceActive, true, `${state} must keep answering`);
      assert.equal(d.phoneStillAnswered, true);
      assert.match(d.detail, /still answering your phone/i);
    }
  });

  test("only a human can suspend a client", () => {
    const bySystem = account.evaluateTransition({ from: "collections", to: "suspended", actor: "system" });
    assert.equal(bySystem.ok, false);
    assert.equal(bySystem.code, "requires_human");

    const byHuman = account.evaluateTransition({ from: "collections", to: "suspended", actor: "founder" });
    assert.equal(byHuman.ok, true);
  });

  test("no automated path reaches a state that stops service", () => {
    // Exhaustive: from every state, every system-actor transition must leave
    // the phone being answered.
    for (const from of account.ACCOUNT_STATE_KEYS) {
      for (const to of account.ACCOUNT_TRANSITIONS[from] || []) {
        const r = account.evaluateTransition({ from, to, actor: "system" });
        if (!r.ok) continue;
        if (account.ACCOUNT_STATES[to].serviceActive === false) {
          // cancelled/closed are reachable by system only from an explicit
          // client cancellation, which is the client's own decision.
          assert.ok(["cancelled", "closed"].includes(to), `system reached service-stopping state ${to} from ${from}`);
        }
      }
    }
  });

  test("an unknown state is refused", () => {
    assert.equal(account.evaluateTransition({ from: "active", to: "on_fire" }).ok, false);
  });
});

describe("profitability guardrails", () => {
  test("every plan makes money at 100% of its own included usage", () => {
    const audit = account.auditCatalogue();
    assert.equal(audit.ok, true, `catalogue problems: ${audit.problems.join(" | ")}`);
    for (const row of audit.rows) {
      assert.equal(row.atFullAllowance.lossMaking, false, `${row.name} loses money at full allowance`);
      assert.equal(row.atFullAllowance.healthy, true, `${row.name} margin is below the floor`);
    }
  });

  test("every overage rate covers what the extra usage costs us", () => {
    for (const row of account.auditCatalogue().rows) {
      assert.equal(row.overageCoversCost, true, `${row.name} charges less per minute than a minute costs`);
    }
  });

  test("the cost model is labelled an estimate wherever it surfaces", () => {
    assert.equal(account.COST_MODEL.estimated, true);
    assert.equal(account.auditCatalogue().estimated, true);
    assert.equal(account.assessMargin({ planId: "micro", calls: 10, minutes: 20 }).estimated, true);
    assert.match(account.assessFoundingOffer("solo").note, /estimate/i);
  });

  test("the founding offer pays back within a year on every plan", () => {
    for (const id of plans.PLAN_IDS) {
      const o = account.assessFoundingOffer(id);
      assert.equal(o.affordable, true, `${id} offer is not affordable: payback ${o.paybackMonths} months`);
    }
  });

  test("a loss-making configuration is detected rather than silently sold", () => {
    // Halve every price and the audit must object.
    const brokenModel = { ...account.COST_MODEL, voicePerMinuteCents: 200 };
    const audit = account.auditCatalogue(brokenModel);
    assert.equal(audit.ok, false);
    assert.ok(audit.problems.length > 0);
  });
});

// ── Stripe port ─────────────────────────────────────────────────────

describe("stripe port", () => {
  test("is disabled by default and refuses every operation", async () => {
    const p = port.createStripePort({ env: {} });
    assert.equal(p.mode, "disabled");
    for (const op of ["createCustomer", "createSubscription", "reportMeterEvent", "createBillingPortalSession"]) {
      const r = await p[op]({ clientId: "a" });
      assert.equal(r.ok, false);
      assert.equal(r.code, "billing_disabled");
    }
  });

  test("only the live adapter contains transport code", () => {
    // The safety property: a mode-resolution bug must not be able to make a
    // dry run reach the network, because the code to do so is not there.
    for (const [name, fn] of [["disabled", port.disabledAdapter], ["mock", port.mockAdapter], ["dryRun", port.dryRunAdapter]]) {
      assert.ok(!/require\(["']stripe["']\)/.test(fn.toString()), `${name} adapter must contain no stripe require`);
    }
    assert.ok(/require\(["']stripe["']\)/.test(port.liveAdapter.toString()), "the live adapter is the one that talks to Stripe");
  });

  test("the module loads with the stripe package absent", () => {
    let stripeInstalled = true;
    try { require.resolve("stripe"); } catch { stripeInstalled = false; }
    assert.equal(stripeInstalled, false, "this test is only meaningful without node_modules");
    assert.ok(port.createStripePort({ env: {} }), "the port must still load");
  });

  test("dry run builds the exact request and sends nothing", async () => {
    const p = port.createStripePort({ env: { BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_abcdefghij" } });
    assert.equal(p.mode, "dry_run");
    const r = await p.createSubscription({ clientId: "acme", stripeCustomerId: "cus_1", priceId: "price_1" });
    assert.equal(r.sent, false);
    assert.equal(r.wouldSend.path, "/v1/subscriptions");
    assert.equal(r.wouldSend.body.customer, "cus_1");
  });

  test("mutating requests carry a deterministic idempotency key", () => {
    const a = port.buildCreateSubscriptionRequest({ clientId: "acme", stripeCustomerId: "cus_1", priceId: "price_1" });
    const b = port.buildCreateSubscriptionRequest({ clientId: "acme", stripeCustomerId: "cus_1", priceId: "price_1" });
    assert.equal(a.idempotencyKey, b.idempotencyKey);
    const other = port.buildCreateSubscriptionRequest({ clientId: "other", stripeCustomerId: "cus_1", priceId: "price_1" });
    assert.notEqual(a.idempotencyKey, other.idempotencyKey);
  });

  test("the tenant travels with every Stripe object", () => {
    assert.equal(port.buildCreateCustomerRequest({ clientId: "acme" }).body.metadata.aida_client_id, "acme");
    assert.equal(port.buildCreateSubscriptionRequest({ clientId: "acme", priceId: "p" }).body.metadata.aida_client_id, "acme");
  });

  test("the founding offer is expressed as Stripe documents it", () => {
    const r = port.buildFoundingOfferCouponRequest({ planId: "growth", amountOffCents: 15000, durationMonths: 2 });
    assert.equal(r.body.duration, "repeating");
    assert.equal(r.body.duration_in_months, 2);
    assert.equal(r.body.amount_off, 15000);
    assert.equal(r.body.currency, "aud");
  });

  test("the Stripe API version is pinned", () => {
    assert.match(port.STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}/);
  });

  test("the mock's portal URL is obviously not a real one", () => {
    const mock = port.mockAdapter();
    return mock.createBillingPortalSession({ clientId: "a", stripeCustomerId: "cus_1" }).then((r) => {
      assert.ok(!r.result.url.includes("stripe.com"), "a mock URL that looks real will eventually be clicked in production");
      assert.match(r.result.url, /example\.com/);
    });
  });

  test("no adapter but live can verify a webhook signature", async () => {
    for (const env of [{}, { BILLING_ENABLED: "true" }, { BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_abc" }]) {
      const p = port.createStripePort({ env });
      const r = await p.verifyWebhook({ rawBody: "{}", signatureHeader: "t=1,v1=x", webhookSecret: "whsec_x" });
      assert.equal(r.ok, false, `${p.mode} must not claim to have verified a signature`);
    }
  });
});

// ── Webhook ─────────────────────────────────────────────────────────

describe("stripe webhook", () => {
  function handlersWith(overrides = {}) {
    return createStripeWebhookHandlers({
      logger: SILENT,
      env: { STRIPE_WEBHOOK_SECRET: "whsec_test" },
      config: { mode: "live" },
      port: { async verifyWebhook() { return { ok: true, event: overrides.event || { id: "evt_1", type: "invoice.paid", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "pending_first_payment", failedPaymentAttempts: 0 }),
        saveAccount: async (...args) => { if (overrides.onSave) overrides.onSave(...args); return { ok: true }; },
        evaluateTransition: account.evaluateTransition,
        describeAccount: account.describeAccount,
      },
      ...overrides,
    });
  }

  test("an invalid signature is rejected before the payload is read", async () => {
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: {}, config: { mode: "live" },
      port: { async verifyWebhook() { return { ok: false, code: "invalid_signature" }; } },
    });
    const res = fakeRes();
    await h.webhook({ body: Buffer.from('{"id":"evt_1"}'), headers: {} }, res);
    assert.equal(res.statusCode, 400);
    // Terse on purpose: a detailed reason tells an attacker how close they got.
    assert.ok(!JSON.stringify(res.body).includes("invalid_signature"));
  });

  test("an empty or oversized body is refused", async () => {
    const h = handlersWith();
    const empty = fakeRes();
    await h.webhook({ body: Buffer.alloc(0), headers: {} }, empty);
    assert.equal(empty.statusCode, 400);

    const huge = fakeRes();
    await h.webhook({ body: Buffer.alloc(300000), headers: {} }, huge);
    assert.equal(huge.statusCode, 413);
  });

  test("acknowledges before processing, so Stripe does not retry", async () => {
    const order = [];
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" },
      port: { async verifyWebhook() { return { ok: true, event: { id: "evt_2", type: "invoice.paid", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        loadAccount: async () => { order.push("processed"); return { clientId: "acme", state: "pending_first_payment", failedPaymentAttempts: 0 }; },
        saveAccount: async () => ({ ok: true }),
        evaluateTransition: account.evaluateTransition,
      },
    });
    const res = fakeRes();
    const origJson = res.json.bind(res);
    res.json = (b) => { order.push("responded"); return origJson(b); };
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "t=1,v1=x" } }, res);
    assert.deepEqual(order, ["responded", "processed"]);
  });

  test("a replayed event is acknowledged but not reprocessed", async () => {
    let processCount = 0;
    const seen = new Set();
    const make = () => createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" }, seenEvents: seen,
      port: { async verifyWebhook() { return { ok: true, event: { id: "evt_same", type: "invoice.paid", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        loadAccount: async () => { processCount += 1; return { clientId: "acme", state: "pending_first_payment", failedPaymentAttempts: 0 }; },
        saveAccount: async () => ({ ok: true }),
        evaluateTransition: account.evaluateTransition,
      },
    });
    const h = make();
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    const second = fakeRes();
    await make().webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, second);
    assert.equal(second.body.duplicate, true);
    assert.equal(processCount, 1, "a replay must not transition the account twice");
  });

  test("the tenant comes from metadata we set, never from an arbitrary field", async () => {
    let saved = null;
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" },
      port: {
        async verifyWebhook() {
          return {
            ok: true,
            event: {
              id: "evt_3", type: "invoice.paid",
              // A hostile-looking customer field alongside our own metadata.
              data: { object: { customer: "victim-tenant", client_id: "victim-tenant", metadata: { aida_client_id: "acme" } } },
            },
          };
        },
      },
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "pending_first_payment", failedPaymentAttempts: 0 }),
        saveAccount: async (clientId) => { saved = clientId; return { ok: true }; },
        evaluateTransition: account.evaluateTransition,
      },
    });
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    assert.equal(saved, "acme");
  });

  test("an unrecognised event type is acknowledged and ignored", async () => {
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" },
      port: { async verifyWebhook() { return { ok: true, event: { id: "evt_x", type: "radar.early_fraud_warning.created", data: { object: {} } } }; } },
    });
    const res = fakeRes();
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.handled, false);
  });

  test("a failed payment moves to past_due, and repeated ones to collections — never to suspended", async () => {
    const transitions = [];
    const build = (state, attempts, id) => createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" }, seenEvents: new Set(),
      port: { async verifyWebhook() { return { ok: true, event: { id, type: "invoice.payment_failed", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state, failedPaymentAttempts: attempts }),
        saveAccount: async (_c, patch) => { transitions.push({ state: patch.state, attempts: patch.failed_payment_attempts }); return { ok: true }; },
        evaluateTransition: account.evaluateTransition,
      },
    });
    // The real sequence: active → past_due, stay past_due, then → collections.
    await build("active", 0, "evt_a").webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    await build("past_due", 1, "evt_b").webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    await build("past_due", 3, "evt_c").webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());

    assert.deepEqual(transitions.map((t) => t.state), ["past_due", undefined, "collections"]);
    assert.ok(!transitions.some((t) => t.state === "suspended"), "no payment failure may ever suspend a client");
  });

  test("a repeat failure still increments the attempt counter even though the state does not change", async () => {
    // Regression: the counter used to be written only alongside a successful
    // state transition. A second failure while already past_due is a
    // self-transition, which the machine refuses — so nothing was recorded, the
    // counter never reached 2, and `collections` was unreachable. A client
    // would sit in past_due forever and never be chased.
    let patch = null;
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" }, seenEvents: new Set(),
      port: { async verifyWebhook() { return { ok: true, event: { id: "evt_repeat", type: "invoice.payment_failed", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "past_due", failedPaymentAttempts: 1 }),
        saveAccount: async (_c, p) => { patch = p; return { ok: true }; },
        evaluateTransition: account.evaluateTransition,
      },
    });
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    assert.ok(patch, "a repeat failure must still be recorded");
    assert.equal(patch.failed_payment_attempts, 2);
    assert.equal(patch.state, undefined, "the state does not change on a self-transition");
  });

  test("a successful payment clears the failure counter", async () => {
    let patch = null;
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" }, seenEvents: new Set(),
      port: { async verifyWebhook() { return { ok: true, event: { id: "evt_ok", type: "invoice.paid", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "past_due", failedPaymentAttempts: 3 }),
        saveAccount: async (_c, p) => { patch = p; return { ok: true }; },
        evaluateTransition: account.evaluateTransition,
      },
    });
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    assert.equal(patch.state, "active");
    assert.equal(patch.failed_payment_attempts, 0);
  });

  test("escalation follows the state machine, not the attempt counter alone", async () => {
    // Regression: choosing collections purely on attempts >= 2 produced an
    // illegal active → collections transition whenever the counter and the
    // state were out of step, and an illegal transition is dropped with a log
    // line — so the client would silently stop being chased.
    const transitions = [];
    const h = createStripeWebhookHandlers({
      logger: SILENT, env: { STRIPE_WEBHOOK_SECRET: "whsec_test" }, config: { mode: "live" }, seenEvents: new Set(),
      port: { async verifyWebhook() { return { ok: true, event: { id: "evt_skew", type: "invoice.payment_failed", data: { object: { metadata: { aida_client_id: "acme" } } } } }; } },
      accounts: {
        // Counter says 3, state says active — out of step.
        loadAccount: async () => ({ clientId: "acme", state: "active", failedPaymentAttempts: 3 }),
        saveAccount: async (_c, patch) => { transitions.push(patch.state); return { ok: true }; },
        evaluateTransition: account.evaluateTransition,
      },
    });
    await h.webhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "s" } }, fakeRes());
    assert.deepEqual(transitions, ["past_due"], "must take the legal step rather than an illegal shortcut");
  });
});

// ── Billing handlers and page ───────────────────────────────────────

describe("billing handlers", () => {
  function handlersWith(overrides = {}) {
    return createBillingHandlers({
      logger: SILENT,
      env: {},
      config: { mode: "mock" },
      port: port.mockAdapter(),
      readModel: { fetchCalls: async () => ({ calls: [], total: 0, truncated: false }) },
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "active", planId: "micro", stripeCustomerId: "cus_1", stripeSubscriptionId: null, failedPaymentAttempts: 0, offerStartedAt: null }),
        saveAccount: async () => ({ ok: true }),
        describeAccount: account.describeAccount,
      },
      ...overrides,
    });
  }

  test("state-changing POSTs require a JSON content type", async () => {
    const h = handlersWith();
    for (const fn of ["portalSession", "changePlan"]) {
      const res = fakeRes();
      await h[fn]({ headers: { "content-type": "text/plain" }, body: {}, clientId: "acme" }, res);
      assert.equal(res.statusCode, 415);
    }
  });

  test("the billing page is never cached", async () => {
    const h = handlersWith();
    const res = fakeRes();
    await h.billingPage({ clientId: "acme", client: { name: "Acme" }, headers: {}, query: {} }, res);
    assert.match(res.headers["Cache-Control"], /no-store/);
    assert.match(res.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  });

  test("a plan change takes the plan id from the request but never the price", async () => {
    let saved = null;
    const h = handlersWith({
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "active", planId: "micro", stripeCustomerId: "cus_1", stripeSubscriptionId: null, failedPaymentAttempts: 0 }),
        saveAccount: async (_c, patch) => { saved = patch; return { ok: true }; },
        describeAccount: account.describeAccount,
      },
    });
    const res = fakeRes();
    // A hostile body offering its own price.
    await h.changePlan({ headers: { "content-type": "application/json" }, body: { planId: "solo", monthlyCents: 1, price: 0 }, clientId: "acme", ip: "127.0.0.1" }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(saved, { plan_id: "solo" });
    assert.ok(!("monthlyCents" in saved) && !("price" in saved), "no price may reach storage from a request");
  });

  test("an unknown plan is refused", async () => {
    const h = handlersWith();
    const res = fakeRes();
    await h.changePlan({ headers: { "content-type": "application/json" }, body: { planId: "free" }, clientId: "acme", ip: "1" }, res);
    assert.equal(res.statusCode, 400);
  });

  test("a portal session in dry-run mode returns no URL rather than a fake one", async () => {
    const h = handlersWith({ port: port.dryRunAdapter([]), config: { mode: "dry_run" } });
    const res = fakeRes();
    await h.portalSession({ headers: { "content-type": "application/json" }, body: {}, clientId: "acme", ip: "1" }, res);
    assert.equal(res.body.url, null);
    assert.ok(res.body.wouldSend);
  });

  test("a client with no Stripe customer gets a clear 409, not a crash", async () => {
    const h = handlersWith({
      accounts: {
        loadAccount: async () => ({ clientId: "acme", state: "pilot_unbilled", planId: null, stripeCustomerId: null, stripeSubscriptionId: null, failedPaymentAttempts: 0 }),
        saveAccount: async () => ({ ok: true }),
        describeAccount: account.describeAccount,
      },
    });
    const res = fakeRes();
    await h.portalSession({ headers: { "content-type": "application/json" }, body: {}, clientId: "acme", ip: "1" }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "no_customer");
  });

  test("unprovisioned billing tables answer 503, and say nothing is being charged", async () => {
    const h = handlersWith({
      accounts: {
        loadAccount: async () => { const e = new Error("no table"); e.code = "billing_unavailable"; throw e; },
        describeAccount: account.describeAccount,
      },
    });
    const res = fakeRes();
    await h.billingPage({ clientId: "acme", headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /Nothing is being charged/);
  });
});

describe("billing page copy", () => {
  const usageModel = { billableCalls: 45, billableMinutes: 135, excludedCalls: 2, excludedByReason: { too_short: 2 }, billableMinimumSeconds: 6, lines: [] };
  const plan = plans.getPlan("micro");
  const price = plans.priceMonth({ planId: "micro", calls: 45, minutes: 135 });
  const fit = plans.bestFitPlan({ calls: 45, minutes: 135, currentPlanId: "micro" });

  test("labels projected charges as estimates", () => {
    const html = billingView.renderBillingPage({
      account: account.describeAccount("active"), usage: usageModel, price, plan, fit,
      catalogue: plans.publicCatalogue(), offer: null, portalUrl: null, businessName: "Acme", mode: "mock",
    });
    assert.match(html, /<strong>Estimate\.<\/strong>/);
    assert.match(html, /Your invoice is the final figure/);
  });

  test("reassures that a payment problem has not stopped the phone", () => {
    const html = billingView.renderBillingPage({
      account: account.describeAccount("past_due"), usage: usageModel, price, plan, fit,
      catalogue: plans.publicCatalogue(), offer: null, portalUrl: null, businessName: "Acme", mode: "mock",
    });
    assert.match(html, /Your phone is still being answered/);
  });

  test("says plainly when it is not in live mode", () => {
    const html = billingView.renderBillingPage({
      account: account.describeAccount("active"), usage: usageModel, price, plan, fit,
      catalogue: plans.publicCatalogue(), offer: null, portalUrl: null, businessName: "Acme", mode: "dry_run",
    });
    assert.match(html, /no real charges are made/i);
  });

  test("escapes hostile content", () => {
    const X = '<img src=x onerror=alert(1)>"><script>alert(2)</script>';
    const html = billingView.renderBillingPage({
      account: { ...account.describeAccount("past_due"), label: X, detail: X }, usage: usageModel, price, plan, fit,
      catalogue: plans.publicCatalogue(), offer: null, portalUrl: X, businessName: X, mode: X,
    });
    assert.ok(!/<img[^>]*onerror/i.test(html));
    assert.ok(!/<script>alert/i.test(html));
  });
});
