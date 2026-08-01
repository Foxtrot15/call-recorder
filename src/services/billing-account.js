// AIDA — billing account lifecycle and profitability guardrails (M6).
//
// The states a paying client moves through, what may happen in each, and the
// checks that stop us selling a plan that loses money.
//
// ─── THE CENTRAL RULE ───────────────────────────────────────────────
// A FAILED PAYMENT DOES NOT STOP AIDA ANSWERING THE PHONE.
//
// This is a deliberate product decision, not an oversight. The client is a
// locksmith whose customers are locked out of their homes. Cutting off their
// receptionist because a card expired would strand people at their front door
// at 2am over a A$49 payment, and it would be the last thing that business
// ever bought from us. Non-payment is handled by telling the client, escalating
// to a human, and eventually ending the relationship deliberately — never by a
// silent automated cut-off.
//
// `serviceActive` is therefore a separate axis from `paymentHealthy`, and only
// `suspended` and `closed` — both of which require a human decision — stop the
// phone being answered.
//
// Pure + dep-free core, thin adapter at the bottom.

const plans = require("./billing-plans");

const ACCOUNT_VERSION = "billing-account-2026-08-01";

// ── Lifecycle ───────────────────────────────────────────────────────

const ACCOUNT_STATES = Object.freeze({
  none: { label: "No billing account", serviceActive: true, paymentHealthy: true, terminal: false },
  // Using AIDA during the pilot with no card on file. Service runs.
  pilot_unbilled: { label: "Pilot — not being charged", serviceActive: true, paymentHealthy: true, terminal: false },
  // Customer exists at the provider; no subscription yet.
  customer_created: { label: "Setting up billing", serviceActive: true, paymentHealthy: true, terminal: false },
  // Subscription created, first payment not yet settled.
  pending_first_payment: { label: "Waiting for your first payment", serviceActive: true, paymentHealthy: true, terminal: false },
  active: { label: "Active", serviceActive: true, paymentHealthy: true, terminal: false },
  // A payment failed. Service continues. This is the whole point.
  past_due: { label: "Payment didn't go through", serviceActive: true, paymentHealthy: false, terminal: false },
  // Repeated failures. Still answering. A human is now involved.
  collections: { label: "We need to sort out payment", serviceActive: true, paymentHealthy: false, terminal: false },
  // A human decided to stop. Never reached automatically.
  suspended: { label: "Paused", serviceActive: false, paymentHealthy: false, terminal: false },
  cancelled: { label: "Cancelled", serviceActive: false, paymentHealthy: true, terminal: true },
  closed: { label: "Closed", serviceActive: false, paymentHealthy: true, terminal: true },
});

const ACCOUNT_STATE_KEYS = Object.freeze(Object.keys(ACCOUNT_STATES));

const ACCOUNT_TRANSITIONS = Object.freeze({
  none: ["pilot_unbilled", "customer_created"],
  pilot_unbilled: ["customer_created", "closed"],
  customer_created: ["pending_first_payment", "pilot_unbilled", "closed"],
  pending_first_payment: ["active", "past_due", "cancelled"],
  active: ["past_due", "cancelled", "suspended"],
  past_due: ["active", "collections", "cancelled", "suspended"],
  collections: ["active", "suspended", "cancelled"],
  suspended: ["active", "cancelled", "closed"],
  cancelled: ["closed", "customer_created"],
  closed: [],
});

// Transitions no automated process may make. Each stops a locksmith's phone
// being answered, so each needs a person to decide it.
const HUMAN_ONLY_TRANSITIONS = Object.freeze(["suspended"]);

function canTransition(from, to) {
  return Boolean(ACCOUNT_TRANSITIONS[from]) && ACCOUNT_TRANSITIONS[from].includes(to);
}

/**
 * Attempt a transition. `actor` matters: a system actor cannot suspend.
 */
function evaluateTransition({ from, to, actor = "system", reason = null }) {
  if (!ACCOUNT_STATE_KEYS.includes(to)) {
    return { ok: false, code: "unknown_state", message: `"${String(to).slice(0, 30)}" is not an account state.` };
  }
  if (!canTransition(from, to)) {
    return { ok: false, code: "bad_transition", message: `An account cannot go from ${from} to ${to}.` };
  }
  if (HUMAN_ONLY_TRANSITIONS.includes(to) && actor === "system") {
    return {
      ok: false,
      code: "requires_human",
      message: "Suspending a client stops their phone being answered. That needs a person to decide it, not a cron job.",
    };
  }
  return {
    ok: true,
    from,
    to,
    serviceActive: ACCOUNT_STATES[to].serviceActive,
    paymentHealthy: ACCOUNT_STATES[to].paymentHealthy,
    auditEvent: { kind: "account_state_change", from, to, actor, reason: reason ? String(reason).slice(0, 500) : null },
  };
}

/** What a client sees. Never alarming when nothing is actually wrong. */
function describeAccount(state, { attempts = 0 } = {}) {
  const meta = ACCOUNT_STATES[state] || ACCOUNT_STATES.none;
  const detail = {
    past_due: "Your last payment didn't go through. AIDA is still answering your phone — update your card when you get a moment.",
    collections: "We've tried your card a few times without luck. AIDA is still answering your phone. We'll be in touch to sort it out.",
    suspended: "Your receptionist is paused. Get in touch and we'll turn it back on.",
    pending_first_payment: "We're waiting on your first payment to clear. Everything is running in the meantime.",
    pilot_unbilled: "You're on the pilot and aren't being charged yet.",
  }[state] || null;

  return {
    state,
    label: meta.label,
    detail,
    serviceActive: meta.serviceActive,
    paymentHealthy: meta.paymentHealthy,
    // The reassurance a client most needs when they see a payment problem.
    phoneStillAnswered: meta.serviceActive,
    attempts,
  };
}

// ── Profitability guardrails ────────────────────────────────────────
//
// What it costs US to run a client, so a plan cannot be sold below cost and a
// discount cannot be approved that never pays back.
//
// These are ESTIMATES and are labelled as such. They are here to catch an
// obviously loss-making configuration, not to pretend at precision we do not
// have. Real per-minute provider costs must replace these before anything is
// charged for real.

const COST_MODEL = Object.freeze({
  version: "cost-model-estimate-2026-08-01",
  // Provisional. Replace with measured provider invoices before going live.
  estimated: true,
  voicePerMinuteCents: 18,
  telephonyPerMinuteCents: 2,
  transcriptionPerMinuteCents: 3,
  analysisPerCallCents: 4,
  smsPerMessageCents: 5,
  // Fixed monthly cost of carrying a client at all: number rental, storage,
  // a share of support.
  perClientMonthlyCents: 350,
  // Payment processing. Stripe AU domestic card pricing is a percentage plus a
  // fixed fee; both are provisional here.
  paymentPercent: 0.0175,
  paymentFixedCents: 30,
});

function variableCostCents({ calls, minutes, smsMessages = 0 }, model = COST_MODEL) {
  return (
    minutes * (model.voicePerMinuteCents + model.telephonyPerMinuteCents + model.transcriptionPerMinuteCents) +
    calls * model.analysisPerCallCents +
    smsMessages * model.smsPerMessageCents
  );
}

function paymentFeeCents(revenueCents, model = COST_MODEL) {
  return Math.round(revenueCents * model.paymentPercent) + model.paymentFixedCents;
}

/**
 * Margin on one client-month.
 *
 * Returns cents and a percentage, plus `healthy`, so a caller does not have to
 * decide what "too thin" means in three different places.
 */
const MIN_HEALTHY_MARGIN = 0.25;

function assessMargin({ planId, calls, minutes, smsMessages = 0, monthIndex = null }, model = COST_MODEL) {
  const price = plans.priceMonth({ planId, calls, minutes, monthIndex });
  if (!price.ok) return price;

  const revenue = price.totalCents;
  const variable = variableCostCents({ calls, minutes, smsMessages }, model);
  const fixed = model.perClientMonthlyCents;
  const fees = paymentFeeCents(revenue, model);
  const cost = variable + fixed + fees;
  const margin = revenue - cost;

  return {
    ok: true,
    planId,
    estimated: model.estimated,
    costModelVersion: model.version,
    revenueCents: revenue,
    variableCostCents: variable,
    fixedCostCents: fixed,
    paymentFeeCents: fees,
    totalCostCents: cost,
    marginCents: margin,
    marginRatio: revenue > 0 ? Math.round((margin / revenue) * 100) / 100 : 0,
    healthy: revenue > 0 && margin / revenue >= MIN_HEALTHY_MARGIN,
    lossMaking: margin < 0,
  };
}

/**
 * Does each plan make money at the usage its own allowance permits?
 *
 * This is the check that matters: a plan is a PROMISE that a client may use the
 * whole allowance. If the plan loses money at 100% of its own included usage,
 * it is mispriced, and we would rather find that here than from a bank
 * statement.
 */
function auditCatalogue(model = COST_MODEL) {
  const rows = plans.PLANS.map((plan) => {
    const atFull = assessMargin({ planId: plan.id, calls: plan.includedCalls, minutes: plan.includedMinutes }, model);
    const atHalf = assessMargin({ planId: plan.id, calls: Math.floor(plan.includedCalls / 2), minutes: Math.floor(plan.includedMinutes / 2) }, model);
    return {
      planId: plan.id,
      name: plan.name,
      atFullAllowance: { marginCents: atFull.marginCents, marginRatio: atFull.marginRatio, healthy: atFull.healthy, lossMaking: atFull.lossMaking },
      atHalfAllowance: { marginCents: atHalf.marginCents, marginRatio: atHalf.marginRatio, healthy: atHalf.healthy },
      // Does the overage rate at least cover what an extra minute costs us?
      overageCoversCost:
        plan.overagePerMinuteCents >= model.voicePerMinuteCents + model.telephonyPerMinuteCents + model.transcriptionPerMinuteCents,
    };
  });

  const problems = [];
  for (const r of rows) {
    if (r.atFullAllowance.lossMaking) problems.push(`${r.name} loses money at 100% of its own included usage.`);
    else if (!r.atFullAllowance.healthy) problems.push(`${r.name} margin is ${Math.round(r.atFullAllowance.marginRatio * 100)}% at full allowance, below the ${Math.round(MIN_HEALTHY_MARGIN * 100)}% floor.`);
    if (!r.overageCoversCost) problems.push(`${r.name} charges less per extra minute than an extra minute costs.`);
  }

  return { costModelVersion: model.version, estimated: model.estimated, rows, problems, ok: problems.length === 0 };
}

/**
 * Is the founding offer affordable on this plan?
 *
 * The offer costs us the discount now, and earns it back over the months the
 * client stays. `paybackMonths` is the honest number to look at before
 * approving one.
 */
function assessFoundingOffer(planId, { assumedMonthlyUsage = null, model = COST_MODEL } = {}) {
  const plan = plans.getPlan(planId);
  if (!plan) return { ok: false, code: "unknown_plan" };

  const usage = assumedMonthlyUsage || { calls: Math.floor(plan.includedCalls * 0.6), minutes: Math.floor(plan.includedMinutes * 0.6) };
  const discountCents = plans.foundingOfferCostCents(planId);

  // Margin during the offer, and after it.
  const during = assessMargin({ planId, ...usage, monthIndex: 0 }, model);
  const after = assessMargin({ planId, ...usage, monthIndex: plans.FOUNDING_OFFER.durationMonths }, model);

  const paybackMonths = after.marginCents > 0 ? Math.ceil(Math.abs(Math.min(0, during.marginCents) * plans.FOUNDING_OFFER.durationMonths + discountCents) / after.marginCents) : null;

  return {
    ok: true,
    planId,
    estimated: model.estimated,
    discountCents,
    marginDuringOfferCents: during.marginCents,
    marginAfterOfferCents: after.marginCents,
    lossDuringOffer: during.marginCents < 0,
    paybackMonths,
    // A guardrail, not a rule: a founder may still decide a long payback is
    // worth it for a reference customer. It must be a decision, not a default.
    affordable: after.marginCents > 0 && (paybackMonths === null || paybackMonths <= 12),
    note: "Costs are estimates until real provider invoices replace the cost model.",
  };
}

// ── Adapter ─────────────────────────────────────────────────────────

const TABLE = "billing_accounts";

function tableMissing(err) {
  const msg = err && (err.message || err.details || "");
  return Boolean(err && err.code === "42P01") || /relation .* does not exist|could not find the table|schema cache/i.test(String(msg));
}

function provisioningError() {
  const e = new Error("Billing tables are not provisioned yet. Apply supabase/sql/lpm6_create_billing.sql.");
  e.code = "billing_unavailable";
  return e;
}

async function loadAccount(clientId, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const { data, error } = await db.from(TABLE).select("*").eq("client_id", clientId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  if (!data) return { clientId, state: "none", planId: null, stripeCustomerId: null, stripeSubscriptionId: null, isDefault: true };
  return {
    clientId,
    state: ACCOUNT_STATE_KEYS.includes(data.state) ? data.state : "none",
    planId: data.plan_id || null,
    stripeCustomerId: data.stripe_customer_id || null,
    stripeSubscriptionId: data.stripe_subscription_id || null,
    offerId: data.offer_id || null,
    offerStartedAt: data.offer_started_at || null,
    failedPaymentAttempts: data.failed_payment_attempts || 0,
    isDefault: false,
    updatedAt: data.updated_at || null,
  };
}

async function saveAccount(clientId, patch, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const row = { ...patch, client_id: clientId, account_version: ACCOUNT_VERSION, updated_at: new Date().toISOString() };
  const { data, error } = await db.from(TABLE).upsert(row, { onConflict: "client_id" }).select().maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  return { ok: true, saved: data };
}

module.exports = {
  ACCOUNT_VERSION,
  ACCOUNT_STATES,
  ACCOUNT_STATE_KEYS,
  ACCOUNT_TRANSITIONS,
  HUMAN_ONLY_TRANSITIONS,
  COST_MODEL,
  MIN_HEALTHY_MARGIN,
  canTransition,
  evaluateTransition,
  describeAccount,
  variableCostCents,
  paymentFeeCents,
  assessMargin,
  auditCatalogue,
  assessFoundingOffer,
  loadAccount,
  saveAccount,
  tableMissing,
  provisioningError,
  TABLE,
};
