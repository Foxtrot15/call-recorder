// AIDA Locksmith Receptionist — autonomous onboarding configuration (M2).
//
// Separate from src/config/locksmith.js on purpose: that module configures the
// public marketing page, this one configures the internal onboarding machinery
// (review/founder routes, ingestion limits, the provisional commercial model).
// They share nothing and are flagged independently, so enabling the shop window
// never enables the workshop.
//
// FLAG (D7 strict parse, dormant by default):
//   LOCKSMITH_ONBOARDING_ENABLED  only the exact string "true" mounts the
//                                 review + founder routes. Anything else,
//                                 including unset, 404s them — byte-identical
//                                 to this feature not existing.
//
// Pure + dep-free. See test/locksmith-onboarding-session.test.js.

// ── Flags ───────────────────────────────────────────────────────────
function isOnboardingEnabled(env = process.env) {
  return env.LOCKSMITH_ONBOARDING_ENABLED === "true";
}

// Re-running the deterministic extraction mutates a draft, so it is restricted
// to non-production environments (Part 10: "development/test only").
function isExtractionRerunAllowed(env = process.env) {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

// Router-level gate — same contract as voipRouterGate/locksmithRouterGate:
// next("router") exits the whole router before any auth or handler runs.
function onboardingRouterGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isOnboardingEnabled(env)) return next("router");
    next();
  };
}

// ── Ingestion limits ────────────────────────────────────────────────
// A real onboarding interview is ~10-20 minutes of speech. 200 KB of text is
// roughly 30,000 words — far beyond any legitimate transcript, and small
// enough that a hostile payload can't exhaust memory before the size check.
const MAX_TRANSCRIPT_BYTES = 200 * 1024;
const MIN_TRANSCRIPT_BYTES = 40; // below this it cannot be a real interview
const MAX_TRANSCRIPT_TURNS = 2000;
const MAX_METADATA_BYTES = 8 * 1024;

// Providers whose transcripts this boundary will accept. "fixture" is the
// deterministic test/founder path that exists today; "retell" is reserved so
// the enum does not change when the real integration lands (nothing dispatches
// on it yet — see docs/LOCKSMITH_ONBOARDING_SPEC.md §6).
const TRANSCRIPT_PROVIDERS = Object.freeze(["fixture", "retell", "manual"]);

// ── Provisional commercial model ────────────────────────────────────
// NOT BINDING AND NOT IMPLEMENTED. No billing code reads this; nothing here is
// rendered as a contractual term. It exists so the numbers behind the M2
// design live in one reviewable place instead of being scattered through
// prose, and so a future billing milestone has a single thing to replace.
//
// Every value is marked provisional and must be confirmed against measured
// call economics before it is published as a plan limit (Part: "Do not publish
// unsupported final plan limits as binding contractual terms").
const PROVISIONAL_COMMERCIAL_MODEL = Object.freeze({
  provisional: true,
  status: "unconfirmed — requires measured call economics + billing before publication",
  currency: "A$",
  signupAmount: 49,
  initialServiceMonths: 2,
  monthOneCreditAmount: 49, // promotional credit; signup payment covers month two
  renewalFromAmount: 49, // from month three, monthly, cancellable before renewal
  microPlan: Object.freeze({
    provisional: true,
    name: "Micro",
    approximateAnsweredCalls: 15,
    receptionistMinuteAllowance: "protective allowance — value not yet set",
    overflowRule: "higher usage may move the customer to the smallest published tier covering their usage",
  }),
  // The commitment that constrains the whole design: a cheap plan is cheap
  // because onboarding is autonomous and configuration is standardised, NOT
  // because the receptionist is worse.
  qualityCommitment:
    "Every plan receives the same core call quality. Lower pricing comes from standardised " +
    "configuration and autonomous onboarding, never from a deliberately degraded receptionist.",
});

function getOnboardingConfig(env = process.env) {
  return Object.freeze({
    enabled: isOnboardingEnabled(env),
    extractionRerunAllowed: isExtractionRerunAllowed(env),
    maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
    minTranscriptBytes: MIN_TRANSCRIPT_BYTES,
    maxTranscriptTurns: MAX_TRANSCRIPT_TURNS,
    maxMetadataBytes: MAX_METADATA_BYTES,
    providers: TRANSCRIPT_PROVIDERS,
    commercial: PROVISIONAL_COMMERCIAL_MODEL,
  });
}

module.exports = {
  isOnboardingEnabled,
  isExtractionRerunAllowed,
  onboardingRouterGate,
  getOnboardingConfig,
  MAX_TRANSCRIPT_BYTES,
  MIN_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_TURNS,
  MAX_METADATA_BYTES,
  TRANSCRIPT_PROVIDERS,
  PROVISIONAL_COMMERCIAL_MODEL,
};
