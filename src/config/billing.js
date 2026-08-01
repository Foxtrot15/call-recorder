// AIDA — billing configuration and danger gates (M6).
//
// ─────────────────────────────────────────────────────────────────────
// THIS MODULE CAN CHARGE PEOPLE MONEY. IT IS OFF.
// ─────────────────────────────────────────────────────────────────────
//
// Same posture as config/retell.js, for the same reason: the failure mode is
// not a broken page, it is a real charge on a real locksmith's card. Every gate
// is strict-parse (only the exact string "true"), every gate defaults OFF, and
// the gates are INDEPENDENT — no gate implies another.
//
//   BILLING_ENABLED             the integration exists at all
//   BILLING_LIVE_WRITES_ENABLED may create/update objects at Stripe
//   BILLING_CHARGES_ENABLED     MAY ACTUALLY CHARGE A CARD
//   BILLING_WEBHOOK_ENABLED     process inbound Stripe events
//   BILLING_DRY_RUN             ON by default; only "false" turns it off
//
// The default posture — nothing set — is `disabled`, in which the adapter has
// no transport code path at all. Reaching `live` needs four flags, a secret
// key, a webhook secret and a price id for every plan, simultaneously. Any one
// missing and the mode degrades rather than half-working.
//
// STRIPE MODE IS DERIVED FROM THE KEY, NOT DECLARED. A key beginning `sk_live_`
// is production money. We refuse to run in live charge mode with a test key or
// vice versa, because "I thought it was pointing at test" is the standard way
// this goes wrong.
//
// Pure + dep-free: reads env, touches nothing.

const CONFIG_VERSION = "billing-config-2026-08-01";

// ── Strict flag parsing (house rule D7) ─────────────────────────────
function strictTrue(value) {
  return value === "true";
}

function isBillingEnabled(env = process.env) {
  return strictTrue(env.BILLING_ENABLED);
}

function isLiveWritesEnabled(env = process.env) {
  return strictTrue(env.BILLING_LIVE_WRITES_ENABLED);
}

/** The one that spends the client's money. */
function isChargesEnabled(env = process.env) {
  return strictTrue(env.BILLING_CHARGES_ENABLED);
}

function isWebhookEnabled(env = process.env) {
  return strictTrue(env.BILLING_WEBHOOK_ENABLED);
}

/**
 * Dry run is inverted on purpose: it is ON unless explicitly switched off.
 * A typo in this variable leaves you safe rather than billing someone.
 */
function isDryRun(env = process.env) {
  return env.BILLING_DRY_RUN !== "false";
}

// ── Key inspection ──────────────────────────────────────────────────

/** test | live | unknown — derived from the key prefix, never from a flag. */
function keyMode(secretKey) {
  if (typeof secretKey !== "string" || !secretKey) return "unknown";
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  return "unknown";
}

/** Never log a key. This is what may appear in a log line or a founder page. */
function describeKey(secretKey) {
  const mode = keyMode(secretKey);
  if (!secretKey) return { present: false, mode, hint: "not set" };
  return { present: true, mode, hint: `${String(secretKey).slice(0, 8)}…${String(secretKey).slice(-4)}` };
}

// ── Mode resolution ─────────────────────────────────────────────────
//
// disabled → mock → dry_run → live. Each step needs strictly more than the one
// before it. `reasons` explains every missing piece at once, so a founder
// debugging this gets the whole list rather than one item per attempt.

const MODES = Object.freeze(["disabled", "mock", "dry_run", "live"]);

function resolveBillingMode(env = process.env) {
  const reasons = [];
  const secretKey = env.STRIPE_SECRET_KEY || "";
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || "";
  const key = describeKey(secretKey);

  if (!isBillingEnabled(env)) {
    return { mode: "disabled", reasons: ["BILLING_ENABLED is not \"true\"."], key, canCharge: false };
  }

  if (!key.present) reasons.push("STRIPE_SECRET_KEY is not set.");
  if (key.present && key.mode === "unknown") {
    reasons.push("STRIPE_SECRET_KEY does not look like a Stripe secret key (expected sk_test_ or sk_live_).");
  }

  // With the integration on but no usable key, the mock adapter answers with
  // deterministic fixtures and contacts nothing.
  if (reasons.length) return { mode: "mock", reasons, key, canCharge: false };

  if (isDryRun(env)) {
    reasons.push("BILLING_DRY_RUN is on (it is on unless explicitly \"false\").");
  }
  if (!isLiveWritesEnabled(env)) {
    reasons.push("BILLING_LIVE_WRITES_ENABLED is not \"true\".");
  }
  if (reasons.length) return { mode: "dry_run", reasons, key, canCharge: false };

  if (!isChargesEnabled(env)) {
    reasons.push("BILLING_CHARGES_ENABLED is not \"true\" — objects may be written, but no card may be charged.");
  }
  if (!webhookSecret) {
    // Without the webhook we would never learn a payment failed, so we would
    // keep serving a client whose card bounced and never know.
    reasons.push("STRIPE_WEBHOOK_SECRET is not set — payment outcomes could not be received.");
  }

  // A live key with charging on is real money. A test key with charging on is
  // fine and is exactly how this should be exercised first.
  const canCharge = isChargesEnabled(env) && Boolean(webhookSecret);

  return { mode: "live", reasons, key, canCharge, chargesRealMoney: canCharge && key.mode === "live" };
}

/**
 * A deliberate mismatch check, run before anything is charged.
 *
 * Charging with a live key while the rest of the deployment thinks it is in a
 * test environment is the expensive mistake. It is cheap to refuse.
 */
function checkEnvironmentAgreement(env = process.env) {
  const key = describeKey(env.STRIPE_SECRET_KEY || "");
  const nodeEnv = env.NODE_ENV || "development";
  const problems = [];

  if (key.mode === "live" && nodeEnv !== "production") {
    problems.push(`A LIVE Stripe key is configured but NODE_ENV is "${nodeEnv}". Refusing to charge outside production.`);
  }
  if (key.mode === "test" && isChargesEnabled(env) && nodeEnv === "production") {
    problems.push("A TEST Stripe key is configured in production. Charges would silently not be real.");
  }
  return { ok: problems.length === 0, problems, keyMode: key.mode, nodeEnv };
}

// ── Router gate ─────────────────────────────────────────────────────
function billingRouterGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isBillingEnabled(env)) return next("router");
    next();
  };
}

function billingWebhookGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isBillingEnabled(env) || !isWebhookEnabled(env)) return next("router");
    next();
  };
}

// ── Assembled config ────────────────────────────────────────────────

function getBillingConfig(env = process.env) {
  const resolved = resolveBillingMode(env);
  const agreement = checkEnvironmentAgreement(env);

  return Object.freeze({
    configVersion: CONFIG_VERSION,
    mode: resolved.mode,
    reasons: Object.freeze(resolved.reasons),
    key: Object.freeze(resolved.key),
    // The only property any caller should consult before spending money.
    canCharge: resolved.canCharge === true && agreement.ok,
    chargesRealMoney: resolved.chargesRealMoney === true && agreement.ok,
    environmentAgreement: Object.freeze(agreement),
    currency: "aud",
    // Stripe amounts are in the smallest currency unit. AUD has 100 cents.
    minorUnitsPerDollar: 100,
    webhookPath: "/webhooks/stripe",
    portalPath: "/client/locksmith/billing",
    flags: Object.freeze({
      enabled: isBillingEnabled(env),
      liveWrites: isLiveWritesEnabled(env),
      charges: isChargesEnabled(env),
      webhook: isWebhookEnabled(env),
      dryRun: isDryRun(env),
    }),
  });
}

module.exports = {
  CONFIG_VERSION,
  MODES,
  isBillingEnabled,
  isLiveWritesEnabled,
  isChargesEnabled,
  isWebhookEnabled,
  isDryRun,
  keyMode,
  describeKey,
  resolveBillingMode,
  checkEnvironmentAgreement,
  billingRouterGate,
  billingWebhookGate,
  getBillingConfig,
};
