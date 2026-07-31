// AIDA — Micro-plan complexity assessment (M4).
//
// A PROVISIONAL, NON-BILLING signal: does this approved configuration fit the
// standardised Micro setup that makes a cheap plan viable?
//
// WHAT THIS IS NOT
//   * It is not pricing enforcement. Nothing here charges anyone or blocks
//     anyone. `assessComplexity` is pure and cannot mutate a profile.
//   * It is not a quality tier. **Every customer gets the same core voice
//     quality.** The cheap plan is cheap because onboarding is autonomous and
//     the configuration is standardised — never because the receptionist is
//     worse. That sentence is asserted by a test so it cannot quietly drift.
//   * It is not a rejection. A complex profile is flagged for manual review and
//     a likely-higher tier, not turned away.
//
// The commercial numbers stay in config/locksmith-onboarding.js
// (PROVISIONAL_COMMERCIAL_MODEL) and out of the canonical business profile.
//
// Pure + dep-free.

const S = require("./locksmith-profile-schema");
const { normaliseAuNumber } = require("./locksmith-profile");
const { PROVISIONAL_COMMERCIAL_MODEL } = require("../config/locksmith-onboarding");

const ASSESSMENT_VERSION = "locksmith-complexity-2026-08-01";

// Provisional Micro boundaries. Changing these is a commercial decision, not a
// code cleanup — they live in one place and are labelled provisional.
const MICRO_BOUNDS = Object.freeze({
  provisional: true,
  maxBusinesses: 1,
  maxActiveReceptionistConfigs: 1,
  maxPrimaryTransferNumbers: 1,
  maxBackupTransferNumbers: 1,
  // primary + a stretch area + a smaller after-hours area. That combination is
  // what an ordinary solo locksmith actually has, so it must stay inside Micro;
  // a FOURTH distinct list is what suggests genuine multi-location routing.
  maxDistinctServiceAreaLists: 3,
  maxNotificationRecipients: 4,
  maxUrgencyRules: 8,
  maxServiceSpecificHours: 0, // per-service hours are a bespoke behaviour
  allowsCustomCrm: false,
  allowsMultiLocationRouting: false,
  allowsDispatchTree: false,
  allowsBespokeProviderTools: false,
  allowsCustomDepartments: false,
});

const TIERS = Object.freeze(["micro", "standard", "bespoke"]);

/**
 * Assess. Returns a frozen result and never touches the profile it is given.
 */
function assessComplexity({ profile, profileVersion = null }) {
  const reasons = [];
  const unsupported = [];
  let manualReviewRequired = false;

  const transfer = profile.transfer || {};
  const areas = profile.serviceAreas || {};
  const hours = profile.hours || {};
  const notifications = profile.notifications || {};
  const urgencyRules = Array.isArray(profile.urgencyRules) ? profile.urgencyRules : [];
  const accepted = (Array.isArray(profile.servicesAccepted) ? profile.servicesAccepted : []).filter((s) => s && s.enabled);

  // ── Transfer topology ──
  const hasPrimary = Boolean(normaliseAuNumber(transfer.primaryNumber));
  const hasBackup = Boolean(normaliseAuNumber(transfer.backupNumber));
  if (!hasPrimary) {
    reasons.push({ code: "no_transfer_number", message: "No primary transfer number, so urgent calls have nowhere to go.", impact: "blocks_micro" });
    manualReviewRequired = true;
  }
  // More than a primary + one backup implies a dispatch tree, which is not a
  // standardised setup.
  const eligibleServices = Array.isArray(transfer.eligibleServices) ? transfer.eligibleServices : [];
  if (eligibleServices.length > 0 && eligibleServices.length < accepted.filter((s) => s.mayBeUrgent).length) {
    reasons.push({ code: "per_service_transfer_routing", message: "Transfers are restricted to a subset of urgent services, which is per-service routing rather than one on-call number.", impact: "above_micro" });
  }

  // ── Service areas ──
  // Only lists that describe WHERE THE VAN GOES count. `declined` is an
  // exclusion, not a routing destination, so a locksmith listing suburbs they
  // refuse is not thereby running multiple locations.
  const areaLists = [areas.primary, areas.extended, areas.afterHoursAreas].filter((l) => Array.isArray(l) && l.length > 0).length;
  if (areaLists > MICRO_BOUNDS.maxDistinctServiceAreaLists) {
    reasons.push({
      code: "multi_area_routing",
      message: `${areaLists} distinct service-area lists suggests multi-location routing rather than one van covering one patch.`,
      impact: "above_micro",
    });
    unsupported.push("multi_location_routing");
  }

  // ── Per-service hours ──
  const byService = hours.byService && typeof hours.byService === "object" ? Object.keys(hours.byService) : [];
  if (byService.length > MICRO_BOUNDS.maxServiceSpecificHours) {
    reasons.push({ code: "per_service_hours", message: `Different hours for ${byService.length} individual service(s) is bespoke availability handling.`, impact: "above_micro" });
    unsupported.push("per_service_hours");
  }

  // ── Notifications ──
  const recipientCount = ["sms", "email", "urgentOnly", "standardSummary", "backup"]
    .reduce((n, key) => n + (Array.isArray(notifications[key]) ? notifications[key].length : 0), 0);
  if (recipientCount > MICRO_BOUNDS.maxNotificationRecipients) {
    reasons.push({ code: "many_notification_recipients", message: `${recipientCount} notification recipients suggests a team rather than an owner-operator.`, impact: "above_micro" });
  }

  // ── Urgency complexity ──
  if (urgencyRules.length > MICRO_BOUNDS.maxUrgencyRules) {
    reasons.push({ code: "complex_urgency_rules", message: `${urgencyRules.length} urgency rules is more nuance than a standardised setup carries.`, impact: "above_micro" });
    manualReviewRequired = true;
  }

  // ── Extensions: the honest signal for "they asked for something bespoke" ──
  const extensions = profile.extensions && typeof profile.extensions === "object" ? Object.keys(profile.extensions) : [];
  if (extensions.length) {
    const crmish = extensions.filter((k) => /crm|integration|webhook|api|dispatch|department/i.test(k));
    if (crmish.length) {
      reasons.push({ code: "custom_integration_requested", message: `Custom integration fields present (${crmish.join(", ")}), which the standardised setup does not cover.`, impact: "above_micro" });
      unsupported.push("custom_integration");
      manualReviewRequired = true;
    }
  }

  // ── Pricing authority: approved wording needs a human eye every time ──
  if (profile.pricing && profile.pricing.mayMentionPricing === true) {
    reasons.push({ code: "pricing_wording_approved", message: "The receptionist is permitted to use approved pricing wording, which needs periodic review.", impact: "support_burden" });
    manualReviewRequired = true;
  }

  const blocking = reasons.filter((r) => r.impact === "blocks_micro");
  const aboveMicro = reasons.filter((r) => r.impact === "above_micro");

  const microCompatible = blocking.length === 0 && aboveMicro.length === 0;
  const minimumOperationalTier = blocking.length > 0
    ? "bespoke"
    : aboveMicro.length >= 3 || unsupported.length >= 2
      ? "bespoke"
      : aboveMicro.length > 0
        ? "standard"
        : "micro";

  return Object.freeze({
    assessmentVersion: ASSESSMENT_VERSION,
    provisional: true,
    profileVersion,
    microCompatible,
    minimumOperationalTier,
    reasons: Object.freeze(reasons),
    unsupportedComplexity: Object.freeze([...new Set(unsupported)]),
    manualReviewRequired,
    // Restated on every assessment so it cannot be lost in a refactor.
    qualityCommitment: PROVISIONAL_COMMERCIAL_MODEL.qualityCommitment,
    // Explicitly not a billing decision.
    billingEffect: "none — this assessment does not price, charge or restrict any customer",
    notes: Object.freeze([
      "Provisional. Confirm against measured call economics before it informs a published plan.",
      "A profile above Micro is not rejected; it is flagged for manual review and a likely higher tier.",
    ]),
  });
}

/** Founder-facing summary. Pure formatting. */
function toOperatorSummary(assessment) {
  return Object.freeze({
    tier: assessment.minimumOperationalTier,
    microCompatible: assessment.microCompatible,
    manualReviewRequired: assessment.manualReviewRequired,
    reasonCount: assessment.reasons.length,
    topReasons: Object.freeze(assessment.reasons.slice(0, 3).map((r) => r.message)),
    unsupported: assessment.unsupportedComplexity,
  });
}

module.exports = { ASSESSMENT_VERSION, MICRO_BOUNDS, TIERS, assessComplexity, toOperatorSummary };
