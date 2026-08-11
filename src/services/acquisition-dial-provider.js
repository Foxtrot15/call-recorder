// AIDA Locksmith Acquisition — the dial provider interface (E-7A).
//
//   createDisabledDialProvider()   the default. Refuses everything.
//   createFakeDialProvider()       deterministic, offline, test-only.
//   assertDialProvider(p)          shape check with a useful message.
//
// ── WHAT A PROVIDER IS ──────────────────────────────────────────────
// A provider is an EXECUTION MECHANISM. It is handed a destination and asked to
// submit one call. It is not a policy engine, and the interface is shaped so it
// could not become one without somebody widening it on purpose.
//
// It receives exactly this, and it is frozen before it arrives:
//
//   executionId     correlation, minted by the executor
//   destination     the E.164 the M8E gate cleared. Not "a number".
//   prospectId      which business, for the audit trail
//   businessName    for a human reading a log
//   authorisedAt    when permission was established
//   metadata        campaign/policy labels, inert
//
// IT DOES NOT RECEIVE, and must never learn to ask for:
//
//   * the eligibility context, or anything it could reinterpret
//   * permission booleans of any kind
//   * a second number, a fallback number, or any way to choose one
//   * batch approval, duplicate, DNCR or suppression authority
//
// A provider that cannot see a permission cannot grant one, and a provider that
// is given one number cannot dial another.
//
// ── WHY THE DEFAULT REFUSES ─────────────────────────────────────────
// There is no live provider in this repository and E-7A does not add one. The
// default is not "no provider configured, fall back to something" — it is a
// provider that exists, is wired in, and answers no. That way the seam is
// genuinely exercised in production shape while remaining incapable of calling
// anybody, and turning calling ON is a code change somebody has to write and a
// reviewer has to see, not an environment variable somebody can set.
//
// THERE IS DELIBERATELY NO `if (credentials) → live provider` PATH. No API key
// is read here, no endpoint is named, no transport is imported. See the ratchets
// in test/acquisition-dial-execution.test.js.

const { createHash } = require("node:crypto");

/**
 * Why a disabled provider refused. Distinct from every compliance refusal in
 * the eligibility vocabulary, because it means the opposite thing: compliance
 * said yes and the mechanism said no.
 */
const PROVIDER_DISABLED = "acquisition_provider_disabled";

/** The provider result vocabulary. Small on purpose. */
const PROVIDER_STATUS = Object.freeze({
  ACCEPTED: "accepted",
  REFUSED: "refused",
});

const REQUIRED_PROVIDER_KEYS = Object.freeze(["name", "live", "submit"]);

/**
 * A provider must SAY whether it is live.
 *
 * `live` is not derived, inferred or defaulted. A provider author has to state
 * it, and the executor's live-call ratchet asserts that every provider this
 * repository can construct states `false`.
 */
function assertDialProvider(provider, label = "dial provider") {
  if (!provider || typeof provider !== "object") {
    throw new Error(`${label}: a provider is required. The default is createDisabledDialProvider().`);
  }
  for (const key of REQUIRED_PROVIDER_KEYS) {
    if (!(key in provider)) throw new Error(`${label}: missing ${key}.`);
  }
  if (typeof provider.submit !== "function") throw new Error(`${label}: submit must be a function.`);
  if (typeof provider.live !== "boolean") throw new Error(`${label}: live must be stated as a boolean.`);
  return provider;
}

/**
 * THE DEFAULT. Always refuses, reaches nothing, and says why.
 *
 * It is not a stub standing in for something missing. It is the correct
 * production behaviour for as long as E-7 is open: acquisition calling is off,
 * and this is the object that says so at the moment it would have mattered.
 */
function createDisabledDialProvider() {
  return Object.freeze({
    name: "disabled",
    live: false,
    describe: () =>
      "Acquisition calling is disabled. No provider adapter exists in this repository, " +
      "and enabling one is a founder-authorised code milestone, not a configuration change.",
    submit() {
      return Object.freeze({
        status: PROVIDER_STATUS.REFUSED,
        accepted: false,
        reason: PROVIDER_DISABLED,
        message:
          "The acquisition dial provider is disabled. Compliance may well have permitted this call; " +
          "the mechanism to place it does not exist yet.",
        providerRef: null,
      });
    },
  });
}

/**
 * TEST AND PROOF ONLY. Records what WOULD have been submitted.
 *
 * Deterministic: the reference is a hash of the execution it was given, so a
 * proof run twice produces an identical transcript. No clock, no entropy, no
 * network, no filesystem.
 *
 * `submissions` is the point of it — an offline proof can assert that exactly
 * one submission happened and that its destination is the one the gate cleared.
 *
 * @param {string}  [behaviour] "accept" (default) | "refuse" | "throw"
 */
function createFakeDialProvider({ behaviour = "accept", refusalReason = "fake_provider_refused" } = {}) {
  const submissions = [];

  return Object.freeze({
    name: "fake",
    live: false,
    describe: () => "A deterministic offline fake. It records submissions and reaches nothing.",
    /** Everything it was asked to submit, in order. Frozen entries. */
    submissions,
    submissionCount: () => submissions.length,

    submit(execution) {
      // Recorded BEFORE any branch, so a throwing fake still proves exactly how
      // many times a provider was reached. A retry bug must be visible here.
      submissions.push(execution);

      if (behaviour === "throw") {
        throw new Error("fake provider transport failure");
      }
      if (behaviour === "refuse") {
        return Object.freeze({
          status: PROVIDER_STATUS.REFUSED,
          accepted: false,
          reason: refusalReason,
          message: "The fake provider was configured to refuse.",
          providerRef: null,
        });
      }
      return Object.freeze({
        status: PROVIDER_STATUS.ACCEPTED,
        accepted: true,
        reason: null,
        message: "The fake provider recorded this submission. NO CALL WAS PLACED.",
        providerRef: `fake_${createHash("sha256").update(String(execution.executionId)).digest("hex").slice(0, 16)}`,
      });
    },
  });
}

module.exports = {
  createDisabledDialProvider,
  createFakeDialProvider,
  assertDialProvider,
  PROVIDER_DISABLED,
  PROVIDER_STATUS,
};
