// AIDA — plan catalogue, best-fit tiers and the founding offer (M6).
//
// The single source of truth for what AIDA costs. Prices appear here once and
// nowhere else: the portal, the public page, the Stripe port and the
// profitability guardrails all read this module. A price written twice is a
// price that will eventually disagree with itself, and the version a client
// sees would not be the version they are charged.
//
// ALL AMOUNTS ARE INTEGER CENTS (AUD). Never floats. 0.1 + 0.2 !== 0.3, and a
// rounding error in a billing system is not a rounding error, it is a dispute.
//
// Pure + dep-free.

const CATALOGUE_VERSION = "billing-plans-2026-08-01";
const CURRENCY = "aud";

function dollars(n) {
  return Math.round(n * 100);
}

/**
 * The four tiers.
 *
 * `includedCalls` and `includedMinutes` are BOTH allowances, and a client
 * exceeding either one is over. Calls and minutes are not interchangeable: a
 * hundred ten-second hang-ups cost us almost nothing, and twenty twelve-minute
 * conversations cost real money. Metering only one of them lets a client be
 * badly mispriced in either direction.
 *
 * `assumedMinutesPerCall` records what each tier's allowance implies, so the
 * guardrails can check the tier is internally coherent rather than a number
 * someone liked the look of.
 */
const PLANS = Object.freeze([
  Object.freeze({
    id: "micro",
    name: "Micro",
    monthlyCents: dollars(49),
    includedCalls: 40,
    includedMinutes: 80,
    overagePerCallCents: dollars(1.5),
    overagePerMinuteCents: dollars(0.75),
    assumedMinutesPerCall: 2,
    audience: "A solo locksmith who mostly answers their own phone and wants the overflow caught.",
    // The complexity ceiling from M4. A business above these bounds is not a
    // Micro business, whatever its call volume looks like this month.
    complexityBound: "micro",
    order: 1,
  }),
  Object.freeze({
    id: "solo",
    name: "Solo",
    monthlyCents: dollars(99),
    includedCalls: 120,
    includedMinutes: 260,
    overagePerCallCents: dollars(1.2),
    overagePerMinuteCents: dollars(0.6),
    assumedMinutesPerCall: 2.17,
    audience: "A one-van business where AIDA answers most calls.",
    complexityBound: "standard",
    order: 2,
  }),
  Object.freeze({
    id: "growth",
    name: "Growth",
    monthlyCents: dollars(199),
    includedCalls: 260,
    includedMinutes: 550,
    overagePerCallCents: dollars(0.9),
    overagePerMinuteCents: dollars(0.5),
    assumedMinutesPerCall: 2.12,
    audience: "Two or three vans, after-hours cover, real call volume.",
    complexityBound: "standard",
    order: 3,
  }),
  Object.freeze({
    id: "pro",
    name: "Pro",
    monthlyCents: dollars(399),
    includedCalls: 520,
    includedMinutes: 1100,
    overagePerCallCents: dollars(0.7),
    overagePerMinuteCents: dollars(0.4),
    assumedMinutesPerCall: 2.12,
    audience: "A small firm running AIDA as the front desk.",
    complexityBound: "complex",
    order: 4,
  }),
]);

// The Growth and Pro allowances above were originally 300/660 and 700/1600.
// auditCatalogue() in services/billing-account.js rejected both: Growth landed
// at a 14% margin and Pro LOST MONEY at 100% of its own included usage. A plan
// is a promise that the client may use the whole allowance, so a plan that only
// works while nobody uses it is not a plan, it is a trap that springs on the
// most engaged customers. The allowances were cut until the audit passed.
// If the cost model changes, re-run the audit before changing these by hand.

const PLAN_IDS = Object.freeze(PLANS.map((p) => p.id));
const PLANS_BY_ID = Object.freeze(Object.fromEntries(PLANS.map((p) => [p.id, p])));

function getPlan(planId) {
  return PLANS_BY_ID[planId] || null;
}

// ── The founding offer ──────────────────────────────────────────────
//
// "Your first two months are A$49, whatever tier you're on."
//
// Modelled as a discount off the tier price rather than as a fifth plan. A
// separate plan would mean migrating the client at month three — a subscription
// change, a proration, and an opportunity to get it wrong. A discount simply
// expires.

const FOUNDING_OFFER = Object.freeze({
  id: "founding_two_months_49",
  name: "Founding pilot — first two months at A$49",
  effectiveMonthlyCents: dollars(49),
  durationMonths: 2,
  // Only for the first clients, and only while the pilot is open. This is a
  // fact about the offer, not a licence to apply it automatically.
  requiresFounderApproval: true,
  // The offer covers the SUBSCRIPTION only. Overage is still charged, because
  // an unbounded free tier is how a "cheap" pilot becomes an expensive one.
  coversOverage: false,
  terms: [
    "The first two monthly payments are A$49 each, whatever plan you are on.",
    "From the third month the plan's normal price applies.",
    "Usage beyond your plan's included calls or minutes is charged as usual.",
    "You can change plan or cancel at any time.",
  ],
});

/**
 * What the offer is worth on a given plan, and what the client actually pays.
 *
 * Returns integer cents throughout. A plan cheaper than the offer price gets a
 * zero discount rather than a negative one — we do not pay people to use AIDA.
 */
function applyFoundingOffer(planId, { monthIndex = 0 } = {}) {
  const plan = getPlan(planId);
  if (!plan) return null;

  const active = monthIndex < FOUNDING_OFFER.durationMonths;
  const discountCents = active ? Math.max(0, plan.monthlyCents - FOUNDING_OFFER.effectiveMonthlyCents) : 0;

  return {
    planId,
    monthIndex,
    offerActive: active,
    listMonthlyCents: plan.monthlyCents,
    discountCents,
    payableMonthlyCents: plan.monthlyCents - discountCents,
    monthsRemaining: active ? FOUNDING_OFFER.durationMonths - monthIndex : 0,
    // Overage is never discounted; stated here so no caller has to infer it.
    overageDiscounted: false,
  };
}

/** The total the offer costs us across its life, for the guardrails. */
function foundingOfferCostCents(planId) {
  const plan = getPlan(planId);
  if (!plan) return 0;
  return Math.max(0, plan.monthlyCents - FOUNDING_OFFER.effectiveMonthlyCents) * FOUNDING_OFFER.durationMonths;
}

// ── Cost of a month on a plan ───────────────────────────────────────

/**
 * What one month costs, given usage. Pure integer arithmetic.
 *
 * Overage is charged on BOTH dimensions independently. Charging on whichever
 * is larger would under-bill a client who is over on both, and charging on
 * their sum would double-count the same call.
 */
function priceMonth({ planId, calls, minutes, monthIndex = null }) {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, code: "unknown_plan", message: `"${String(planId).slice(0, 30)}" is not a plan.` };

  const overCalls = Math.max(0, calls - plan.includedCalls);
  const overMinutes = Math.max(0, minutes - plan.includedMinutes);
  const callOverageCents = overCalls * plan.overagePerCallCents;
  const minuteOverageCents = overMinutes * plan.overagePerMinuteCents;

  const offer = monthIndex === null ? null : applyFoundingOffer(planId, { monthIndex });
  const subscriptionCents = offer ? offer.payableMonthlyCents : plan.monthlyCents;

  return {
    ok: true,
    planId,
    subscriptionCents,
    listSubscriptionCents: plan.monthlyCents,
    discountCents: offer ? offer.discountCents : 0,
    overCalls,
    overMinutes,
    callOverageCents,
    minuteOverageCents,
    overageCents: callOverageCents + minuteOverageCents,
    totalCents: subscriptionCents + callOverageCents + minuteOverageCents,
    withinAllowance: overCalls === 0 && overMinutes === 0,
    offerActive: Boolean(offer && offer.offerActive),
  };
}

// ── Best fit ────────────────────────────────────────────────────────

/**
 * Which plan should this client be on?
 *
 * THE RECOMMENDATION IS THE CHEAPEST TOTAL FOR THEIR ACTUAL USAGE. Full stop.
 * A tie goes to the smaller plan, so the client keeps the lower commitment.
 *
 * An earlier version preferred the cheapest *comfortable* plan — one with
 * headroom below `comfortRatio`. That produced a genuinely bad recommendation:
 * at 130 calls and 280 minutes it recommended Growth at A$199 over Solo at
 * A$123, because Solo was slightly over its allowance. Telling a locksmith to
 * pay 62% more "for headroom" is an upsell wearing the costume of advice, and a
 * billing page that does that is not trusted again.
 *
 * Headroom still matters, so it is reported rather than acted on: when the
 * cheapest plan is running close to its limits, `headroomWarning` names the
 * next plan up and states the exact price difference, and the client decides.
 *
 * Returns every plan priced, so the portal can show the comparison rather than
 * an answer the client has to take on trust.
 */
const COMFORT_RATIO = 0.85;

function bestFitPlan({ calls, minutes, currentPlanId = null, monthIndex = null }) {
  const priced = PLANS.map((plan) => {
    const price = priceMonth({ planId: plan.id, calls, minutes, monthIndex });
    const callRatio = plan.includedCalls ? calls / plan.includedCalls : 0;
    const minuteRatio = plan.includedMinutes ? minutes / plan.includedMinutes : 0;
    const headroom = Math.max(callRatio, minuteRatio);
    return {
      planId: plan.id,
      name: plan.name,
      monthlyCents: plan.monthlyCents,
      totalCents: price.totalCents,
      overageCents: price.overageCents,
      withinAllowance: price.withinAllowance,
      usageRatio: Math.round(headroom * 100) / 100,
      comfortable: headroom <= COMFORT_RATIO,
    };
  });

  // Cheapest total wins; the smaller plan wins a tie.
  const ranked = priced.slice().sort((a, b) => a.totalCents - b.totalCents || a.monthlyCents - b.monthlyCents);
  const recommended = ranked[0];
  const current = currentPlanId ? priced.find((p) => p.planId === currentPlanId) : null;

  // Advisory only. Never changes the recommendation.
  let headroomWarning = null;
  if (recommended && !recommended.comfortable) {
    const bigger = ranked.find((p) => p.comfortable && getPlan(p.planId).order > getPlan(recommended.planId).order);
    headroomWarning = {
      planId: recommended.planId,
      usageRatio: recommended.usageRatio,
      message: `You're close to the limits on ${recommended.name}, so a busier month would cost more in usage charges.`,
      alternative: bigger
        ? {
            planId: bigger.planId,
            name: bigger.name,
            extraCentsThisMonth: Math.max(0, bigger.totalCents - recommended.totalCents),
            note: `${bigger.name} has more room but would have cost ${formatAud(Math.max(0, bigger.totalCents - recommended.totalCents))} more this month.`,
          }
        : null,
    };
  }

  return {
    recommended,
    plans: priced,
    ranked,
    current,
    // Only worth the client's attention when it actually changes something.
    shouldSwitch: Boolean(current && recommended && recommended.planId !== current.planId),
    savingCents: current && recommended ? Math.max(0, current.totalCents - recommended.totalCents) : 0,
    // Honest about direction: recommending a bigger plan is a price rise, and
    // labelling it "recommended" without saying so would be misleading.
    direction: current && recommended ? directionOf(current.planId, recommended.planId) : null,
    headroomWarning,
    comfortRatio: COMFORT_RATIO,
  };
}

function directionOf(fromId, toId) {
  const from = getPlan(fromId);
  const to = getPlan(toId);
  if (!from || !to || from.id === to.id) return "same";
  return to.order > from.order ? "upgrade" : "downgrade";
}

// ── Formatting ──────────────────────────────────────────────────────
// One formatter, so A$49 never renders as A$49.0 in one place and 4900 in
// another.

function formatAud(cents) {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  const body = part === 0 ? `A$${whole}` : `A$${whole}.${String(part).padStart(2, "0")}`;
  return negative ? `−${body}` : body;
}

/** The catalogue shaped for display. No prices are computed here. */
function publicCatalogue({ monthIndex = null } = {}) {
  return PLANS.map((plan) => {
    const offer = monthIndex === null ? null : applyFoundingOffer(plan.id, { monthIndex });
    return {
      id: plan.id,
      name: plan.name,
      audience: plan.audience,
      monthly: formatAud(plan.monthlyCents),
      monthlyCents: plan.monthlyCents,
      offerMonthly: offer && offer.offerActive ? formatAud(offer.payableMonthlyCents) : null,
      includedCalls: plan.includedCalls,
      includedMinutes: plan.includedMinutes,
      overagePerCall: formatAud(plan.overagePerCallCents),
      overagePerMinute: formatAud(plan.overagePerMinuteCents),
    };
  });
}

module.exports = {
  CATALOGUE_VERSION,
  CURRENCY,
  PLANS,
  PLAN_IDS,
  PLANS_BY_ID,
  COMFORT_RATIO,
  FOUNDING_OFFER,
  getPlan,
  applyFoundingOffer,
  foundingOfferCostCents,
  priceMonth,
  bestFitPlan,
  directionOf,
  formatAud,
  publicCatalogue,
  dollars,
};
