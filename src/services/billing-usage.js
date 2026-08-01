// AIDA — usage metering (M6).
//
// Turns call records into billable usage, and billable usage into provider
// meter events. Nothing here contacts Stripe; it produces the events the port
// would send.
//
// ─── ONE ARITHMETIC, NOT TWO ────────────────────────────────────────
// The portal's usage panel and the invoice MUST agree. They do, because both
// read services/locksmith-portal-readmodel.js `projectUsage` — this module
// consumes that projection rather than recounting the rows. A client who sees
// 47 minutes in the portal and 52 on the invoice will not believe either
// number again, and they would be right not to.
//
// ─── WHAT IS BILLABLE ───────────────────────────────────────────────
// A call under BILLABLE_MINIMUM_SECONDS (6s) is not a conversation. It is a
// wrong number, a hang-up, or a carrier artefact. Those are excluded from both
// the count and the minutes — otherwise a run of robocalls bills a locksmith
// for work AIDA did not do.
//
// Minutes are rounded UP per call, not across the month. Per-call rounding is
// what the client sees on each row, so summing rounded rows is the only total
// that reconciles line by line. It is also slightly more expensive than
// month-level rounding, so it is stated plainly rather than buried.
//
// Pure + dep-free core; thin adapter at the bottom.

const { BILLABLE_MINIMUM_SECONDS } = require("./locksmith-portal-readmodel");

const METERING_VERSION = "billing-usage-2026-08-01";

// Stripe meter event names. Max 100 chars (Stripe API limit); these are short
// and stable, because renaming a meter orphans its historical events.
const METERS = Object.freeze({
  calls: "aida_calls",
  minutes: "aida_minutes",
});

// Stripe accepts meter event timestamps within the past 35 calendar days and
// up to 5 minutes in the future. A late backfill beyond that window is silently
// useless, so we detect it and refuse rather than pretending it was reported.
const MAX_BACKFILL_DAYS = 35;
const MAX_FUTURE_SECONDS = 5 * 60;

// ── Per-call billability ────────────────────────────────────────────

/**
 * Is this call billable, and for how much?
 *
 * `reason` is recorded on every exclusion so a client disputing an invoice can
 * be shown exactly which calls were not charged and why.
 */
function assessCall(call) {
  const seconds = Number.isFinite(call.durationSeconds) ? call.durationSeconds : 0;

  if (seconds < BILLABLE_MINIMUM_SECONDS) {
    return { billable: false, reason: "too_short", seconds, minutes: 0, detail: `Under ${BILLABLE_MINIMUM_SECONDS} seconds — not charged.` };
  }
  // A test call the client made themselves, during setup, is ours to absorb.
  // Charging someone to check that the thing they are paying for works is a
  // small amount of money and a large amount of resentment.
  if (call.isSetupTest === true) {
    return { billable: false, reason: "setup_test", seconds, minutes: 0, detail: "Your own test call during setup — not charged." };
  }
  if (call.outcome === "spam") {
    return { billable: false, reason: "spam", seconds, minutes: 0, detail: "Marked as spam — not charged." };
  }

  return { billable: true, reason: null, seconds, minutes: Math.ceil(seconds / 60), detail: null };
}

/**
 * Aggregate a period's calls into the billable totals.
 *
 * Takes projected calls (from the portal read model), so the portal and the
 * invoice cannot diverge.
 */
function meterPeriod({ calls = [], periodStart = null, periodEnd = null }) {
  const assessed = calls.map((c) => ({ call: c, assessment: assessCall(c) }));
  const billable = assessed.filter((a) => a.assessment.billable);

  const excludedByReason = {};
  for (const a of assessed) {
    if (a.assessment.billable) continue;
    excludedByReason[a.assessment.reason] = (excludedByReason[a.assessment.reason] || 0) + 1;
  }

  const totalMinutes = billable.reduce((sum, a) => sum + a.assessment.minutes, 0);
  const totalSeconds = billable.reduce((sum, a) => sum + a.assessment.seconds, 0);

  return {
    meteringVersion: METERING_VERSION,
    periodStart,
    periodEnd,
    billableCalls: billable.length,
    // Per-call rounding, summed. Stated in the return value so a caller cannot
    // mistake this for seconds/60.
    billableMinutes: totalMinutes,
    billableSeconds: totalSeconds,
    roundingBasis: "per_call_rounded_up",
    excludedCalls: assessed.length - billable.length,
    excludedByReason,
    lines: assessed.map((a) => ({
      callId: a.call.id,
      at: a.call.at,
      seconds: a.assessment.seconds,
      minutes: a.assessment.minutes,
      billable: a.assessment.billable,
      excludedReason: a.assessment.reason,
      excludedDetail: a.assessment.detail,
    })),
  };
}

// ── Meter events ────────────────────────────────────────────────────

/**
 * Build the meter events for a period.
 *
 * Stripe's contract (docs.stripe.com/api/billing/meter-event/create):
 *   POST /v1/billing/meter_events
 *   event_name  required, max 100 chars
 *   payload     required, must carry stripe_customer_id and value
 *   identifier  optional, max 100 chars, deduplicated over a rolling window of
 *               at least 24 hours
 *   timestamp   optional, within the past 35 days and up to 5 minutes ahead
 *
 * The identifier is DETERMINISTIC — derived from the client, meter and call —
 * so a retry, a redeploy mid-batch or a double-clicked founder button cannot
 * bill the same call twice. That is the whole reason the field exists, and
 * letting Stripe generate one would throw the protection away.
 */
function buildMeterEvents({ clientId, stripeCustomerId, usage, nowSeconds }) {
  if (!stripeCustomerId) {
    return { ok: false, code: "no_customer", message: "This client has no Stripe customer yet." };
  }

  const events = [];
  const skipped = [];

  for (const line of usage.lines) {
    if (!line.billable) continue;

    const ts = toUnixSeconds(line.at);
    const window = checkTimestamp(ts, nowSeconds);
    if (!window.ok) {
      // Reported rather than silently dropped: usage we cannot meter is
      // revenue we cannot charge, and someone needs to know.
      skipped.push({ callId: line.callId, reason: window.code, detail: window.detail });
      continue;
    }

    events.push({
      event_name: METERS.calls,
      identifier: meterIdentifier(clientId, METERS.calls, line.callId),
      timestamp: ts,
      payload: { stripe_customer_id: stripeCustomerId, value: "1" },
    });
    events.push({
      event_name: METERS.minutes,
      identifier: meterIdentifier(clientId, METERS.minutes, line.callId),
      timestamp: ts,
      payload: { stripe_customer_id: stripeCustomerId, value: String(line.minutes) },
    });
  }

  return { ok: true, events, skipped, meterNames: Object.values(METERS) };
}

/**
 * A stable, unique-per-(client, meter, call) identifier, within Stripe's
 * 100-character limit. The client id is hashed rather than embedded because a
 * tenant slug is unbounded and would blow the limit for a long business name.
 */
function meterIdentifier(clientId, meterName, callId) {
  const { createHash } = require("crypto");
  const tenant = createHash("sha256").update(String(clientId)).digest("hex").slice(0, 16);
  const id = `${meterName}_${tenant}_${String(callId)}`;
  return id.length <= 100 ? id : id.slice(0, 100);
}

function toUnixSeconds(iso) {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function checkTimestamp(ts, nowSeconds) {
  if (ts === null) return { ok: false, code: "bad_timestamp", detail: "The call has no usable timestamp." };
  const ageDays = (nowSeconds - ts) / 86400;
  if (ageDays > MAX_BACKFILL_DAYS) {
    return { ok: false, code: "too_old", detail: `${Math.floor(ageDays)} days old; Stripe accepts ${MAX_BACKFILL_DAYS}.` };
  }
  if (ts - nowSeconds > MAX_FUTURE_SECONDS) {
    return { ok: false, code: "in_future", detail: "Timestamp is more than 5 minutes ahead." };
  }
  return { ok: true };
}

// ── Threshold notices ───────────────────────────────────────────────

/**
 * Has this client crossed a point worth telling them about?
 *
 * Notices fire at 80% and 100% of an allowance, and once more when overage
 * charges pass a dollar figure worth noticing. The rules:
 *
 *   * Each threshold fires ONCE per period. `alreadyNotified` is passed in and
 *     respected, because a cron that re-notifies every hour trains people to
 *     ignore the notice that actually mattered.
 *   * The 100% notice is not a warning, it is a fact plus a number. "You've
 *     used your included calls; from here each call is A$1.20" is actionable.
 *     "You have exceeded your limit" is alarming and tells them nothing.
 *   * Nothing is ever switched off at a threshold. AIDA keeps answering. The
 *     alternative — stopping a locksmith's phone from being answered because
 *     they had a busy month — would be an absurd thing to do to a customer.
 */
const THRESHOLDS = Object.freeze([
  { key: "approaching", ratio: 0.8 },
  { key: "reached", ratio: 1.0 },
]);

const OVERAGE_NOTICE_CENTS = 2000; // A$20

function evaluateThresholds({ usage, plan, alreadyNotified = [], overageCents = 0 }) {
  const notices = [];
  const callRatio = plan.includedCalls ? usage.billableCalls / plan.includedCalls : 0;
  const minuteRatio = plan.includedMinutes ? usage.billableMinutes / plan.includedMinutes : 0;

  for (const t of THRESHOLDS) {
    for (const [dimension, ratio, used, included, unit] of [
      ["calls", callRatio, usage.billableCalls, plan.includedCalls, "calls"],
      ["minutes", minuteRatio, usage.billableMinutes, plan.includedMinutes, "minutes"],
    ]) {
      const key = `${dimension}_${t.key}`;
      if (ratio < t.ratio || alreadyNotified.includes(key)) continue;
      notices.push({
        key,
        dimension,
        threshold: t.key,
        used,
        included,
        message:
          t.key === "reached"
            ? `You've used all ${included} ${unit} included in your plan. AIDA keeps answering — further ${unit} are charged at your plan's usage rate.`
            : `You've used ${used} of your ${included} included ${unit} this month.`,
        // Explicit, because the commonest fear on seeing one of these is that
        // the phone is about to stop being answered.
        serviceContinues: true,
      });
    }
  }

  if (overageCents >= OVERAGE_NOTICE_CENTS && !alreadyNotified.includes("overage_notice")) {
    notices.push({
      key: "overage_notice",
      dimension: "cost",
      threshold: "cost",
      message: "Your usage charges this month have passed A$20. You can see the breakdown in your portal, and switching plan may cost less.",
      serviceContinues: true,
    });
  }

  return { notices, callRatio: round2(callRatio), minuteRatio: round2(minuteRatio) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Adapter ─────────────────────────────────────────────────────────

const TABLE = "billing_usage_periods";

function tableMissing(err) {
  const msg = err && (err.message || err.details || "");
  return Boolean(err && err.code === "42P01") || /relation .* does not exist|could not find the table|schema cache/i.test(String(msg));
}

function provisioningError() {
  const e = new Error("Billing tables are not provisioned yet. Apply supabase/sql/lpm6_create_billing.sql.");
  e.code = "billing_unavailable";
  return e;
}

async function loadPeriod(clientId, periodStart, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const { data, error } = await db.from(TABLE).select("*").eq("client_id", clientId).eq("period_start", periodStart).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  return data || null;
}

async function savePeriod(clientId, fields, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const row = { ...fields, client_id: clientId, metering_version: METERING_VERSION, updated_at: new Date().toISOString() };
  const { data, error } = await db.from(TABLE).upsert(row, { onConflict: "client_id,period_start" }).select().maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  return { ok: true, saved: data };
}

module.exports = {
  METERING_VERSION,
  METERS,
  MAX_BACKFILL_DAYS,
  MAX_FUTURE_SECONDS,
  THRESHOLDS,
  OVERAGE_NOTICE_CENTS,
  BILLABLE_MINIMUM_SECONDS,
  assessCall,
  meterPeriod,
  buildMeterEvents,
  meterIdentifier,
  checkTimestamp,
  toUnixSeconds,
  evaluateThresholds,
  loadPeriod,
  savePeriod,
  tableMissing,
  provisioningError,
  TABLE,
};
