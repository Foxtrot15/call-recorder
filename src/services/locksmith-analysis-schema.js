// AIDA — post-call analysis schema for onboarding calls (M3).
//
// Retell (or any provider) can run a model over the finished call and hand back
// structured fields. That output is USEFUL and UNTRUSTED, in that order.
//
// THE RULES THIS FILE EXISTS TO ENFORCE
//   * The TRANSCRIPT is the authoritative extraction input. Provider analysis
//     supplements it: it can raise warnings and point a reviewer at evidence,
//     it cannot become the profile.
//   * Provider analysis can NEVER approve anything, and can never touch an
//     approved profile. There is no code path from this module to an approval.
//   * Unknown enum values are rejected, not coerced. A model that invents
//     "mostly_urgent" must fail validation loudly.
//   * Missing fields produce review warnings rather than silent nulls.
//   * Transfer numbers and pricing authority ALWAYS require human review,
//     whatever confidence the provider reports. Those two are the fields where
//     a confident mistake is most expensive.
//
// Pure + dep-free.

const S = require("./locksmith-profile-schema");

const ANALYSIS_SCHEMA_VERSION = "locksmith-onboarding-analysis-2026-08-01";

const CALL_OUTCOMES = Object.freeze([
  "completed",
  "consent_refused",
  "owner_requested_human",
  "incomplete_owner_ended",
  "incomplete_technical",
  "wrong_person",
  "voicemail",
]);

const CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);

/**
 * Fields that must be reviewed by a human no matter what the provider says.
 * Not a heuristic — a fixed list, because "the model was confident" is not a
 * reason to dial an unverified number at 3am.
 */
const ALWAYS_REVIEW_FIELDS = Object.freeze(["transfer_primary_number", "transfer_backup_number", "pricing_authority"]);

/**
 * The provider-facing schema, in Retell's documented post_call_analysis_data
 * shape (type/name/description, `choices` for enums). Kept in one place so the
 * onboarding compiler and the validator below cannot drift apart.
 */
function buildOnboardingAnalysisFields() {
  return Object.freeze([
    { type: "system-presets", name: "call_summary" },
    { type: "system-presets", name: "call_successful" },

    { type: "boolean", name: "consent_provided", description: "Did the owner explicitly agree to continue after the automated-assistant and transcription disclosure?" },
    { type: "boolean", name: "onboarding_completed", description: "Did the interview cover every required section and finish with the read-back?" },
    { type: "enum", name: "call_outcome", description: "How the call ended.", choices: [...CALL_OUTCOMES] },
    { type: "boolean", name: "owner_requested_human", description: "Did the owner ask to speak to a person or to stop?" },

    { type: "string", name: "business_spoken_name", description: "The name the owner said callers should hear." },
    { type: "string", name: "business_legal_name", description: "The legal or invoicing name, if different." },
    { type: "string", name: "receptionist_name", description: "What the owner wants the receptionist to call itself." },
    { type: "string", name: "timezone_hint", description: "The state or city the owner named, for timezone purposes." },

    { type: "string", name: "services_accepted", description: "Comma-separated list of the work the owner said they take." },
    { type: "string", name: "services_declined", description: "Comma-separated list of the work the owner explicitly ruled out." },
    { type: "string", name: "service_areas_primary", description: "Comma-separated core suburbs or regions." },
    { type: "string", name: "service_areas_declined", description: "Comma-separated areas the owner will not travel to." },
    { type: "string", name: "outside_area_action", description: "What the owner said should happen to callers outside the area." },

    { type: "string", name: "ordinary_hours", description: "The ordinary trading hours as stated." },
    { type: "boolean", name: "after_hours_available", description: "Did the owner say they take after-hours call-outs?" },
    { type: "string", name: "urgency_rules", description: "What the owner said counts as urgent." },

    { type: "string", name: "transfer_primary_number", description: "The number the owner confirmed for urgent transfers, as read back." },
    { type: "string", name: "transfer_backup_number", description: "The backup number, as read back." },
    { type: "string", name: "transfer_fallback", description: "What the owner said should happen when nobody answers." },

    { type: "string", name: "notification_recipients", description: "Where the owner wants call summaries sent." },
    { type: "enum", name: "pricing_authority", description: "Whether AIDA may discuss price.", choices: ["may_not_mention", "may_use_approved_wording", "unclear"] },
    { type: "string", name: "required_caller_information", description: "What the owner said they need before attending." },
    { type: "string", name: "additional_forbidden_promises", description: "Anything extra the owner said AIDA must never say." },
    { type: "enum", name: "tone_preference", description: "The tone the owner asked for.", choices: [...S.TONES, "unclear"] },
    { type: "boolean", name: "recording_preference", description: "Did the owner agree to calls being recorded (as distinct from transcribed)?" },

    { type: "string", name: "missing_answers", description: "Comma-separated list of topics the owner did not answer or did not know." },
    { type: "string", name: "contradictions", description: "Any place the owner gave two incompatible answers, and how it was resolved." },
    { type: "string", name: "low_confidence_items", description: "Anything you captured but are not confident about, especially numbers." },
  ]);
}

// ── Validation of provider output ───────────────────────────────────

const BOOLEAN_FIELDS = ["consent_provided", "onboarding_completed", "owner_requested_human", "after_hours_available", "recording_preference"];
const ENUM_FIELDS = {
  call_outcome: CALL_OUTCOMES,
  pricing_authority: ["may_not_mention", "may_use_approved_wording", "unclear"],
  tone_preference: [...S.TONES, "unclear"],
};
const STRING_FIELDS = [
  "business_spoken_name", "business_legal_name", "receptionist_name", "timezone_hint",
  "services_accepted", "services_declined", "service_areas_primary", "service_areas_declined",
  "outside_area_action", "ordinary_hours", "urgency_rules", "transfer_primary_number",
  "transfer_backup_number", "transfer_fallback", "notification_recipients",
  "required_caller_information", "additional_forbidden_promises", "missing_answers",
  "contradictions", "low_confidence_items",
];

const MAX_FIELD_CHARS = 2000;

/**
 * Validate and normalise a provider analysis payload.
 *
 * Returns { ok, analysis, errors[], warnings[], reviewRequired[] }.
 *
 * `ok:false` means the payload was malformed enough that we will not use it at
 * all — we still keep the transcript, so nothing is lost. `ok:true` never means
 * "trusted": it means "safe to show a reviewer alongside the transcript".
 */
function validateProviderAnalysis(raw) {
  const errors = [];
  const warnings = [];
  const analysis = {};

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, analysis: null, errors: [{ field: "analysis", message: "Provider analysis was not an object." }], warnings: [], reviewRequired: [...ALWAYS_REVIEW_FIELDS] };
  }

  for (const field of BOOLEAN_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) {
      warnings.push({ code: `missing_${field}`, message: `The provider did not report ${field}.`, severity: "review" });
      analysis[field] = null;
      continue;
    }
    if (typeof value !== "boolean") {
      errors.push({ field, message: `${field} must be a boolean, got ${typeof value}.` });
      continue;
    }
    analysis[field] = value;
  }

  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const value = raw[field];
    if (value === undefined || value === null || value === "") {
      warnings.push({ code: `missing_${field}`, message: `The provider did not report ${field}.`, severity: "review" });
      analysis[field] = null;
      continue;
    }
    if (!allowed.includes(value)) {
      // Rejected, not coerced. An invented value is a signal the model is
      // improvising, and improvised configuration is exactly what we refuse.
      errors.push({ field, message: `"${String(value).slice(0, 60)}" is not a recognised ${field} value.` });
      continue;
    }
    analysis[field] = value;
  }

  for (const field of STRING_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null || value === "") {
      analysis[field] = null;
      continue;
    }
    if (typeof value !== "string") {
      errors.push({ field, message: `${field} must be text.` });
      continue;
    }
    // Stored verbatim but bounded. Escaping happens at render time, as
    // everywhere else in this codebase.
    analysis[field] = value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
  }

  // Consent is the one field whose absence is not merely a warning: a call we
  // cannot show consent for is a call we treat as unconsented.
  if (analysis.consent_provided !== true) {
    warnings.push({
      code: "consent_not_confirmed_by_analysis",
      message: "The provider analysis does not confirm the owner agreed to continue. The transcript must be checked before this draft is used.",
      severity: "blocking",
    });
  }

  if (analysis.owner_requested_human === true) {
    warnings.push({ code: "owner_requested_human", message: "The owner asked for a person during the call. Follow up before sending them a review link.", severity: "blocking" });
  }

  if (analysis.call_outcome && analysis.call_outcome !== "completed") {
    warnings.push({ code: `outcome_${analysis.call_outcome}`, message: `The call ended as "${analysis.call_outcome}" rather than completing.`, severity: "review" });
  }

  if (analysis.low_confidence_items) {
    warnings.push({ code: "low_confidence_items", message: "The provider flagged items it was unsure about. Check these against the transcript.", severity: "review" });
  }

  // Always-review fields, regardless of confidence or presence.
  const reviewRequired = ALWAYS_REVIEW_FIELDS.map((field) => ({
    field,
    reason: field.startsWith("transfer")
      ? "A transfer number heard over the phone must be confirmed by a human before any call is routed to it."
      : "Pricing authority must be confirmed by a human before the receptionist is allowed to discuss money.",
  }));

  return { ok: errors.length === 0, analysis: errors.length === 0 ? Object.freeze(analysis) : null, errors, warnings, reviewRequired, schemaVersion: ANALYSIS_SCHEMA_VERSION };
}

/**
 * Convert a validated analysis into review warnings that sit ALONGSIDE the
 * transcript-derived draft. Deliberately returns warnings only — there is no
 * function in this module that returns profile fields, because provider
 * analysis is not permitted to become configuration.
 */
function toSupplementaryWarnings(validated) {
  if (!validated || !validated.ok) return [];
  const out = [...validated.warnings];

  if (validated.analysis.missing_answers) {
    out.push({ code: "provider_missing_answers", message: `The provider noted unanswered topics: ${validated.analysis.missing_answers}`, severity: "review" });
  }
  if (validated.analysis.contradictions) {
    out.push({ code: "provider_contradictions", message: `The provider noted contradictions: ${validated.analysis.contradictions}`, severity: "contradiction" });
  }
  for (const item of validated.reviewRequired) {
    out.push({ code: `always_review_${item.field}`, message: item.reason, severity: "confirm" });
  }
  return out;
}

module.exports = {
  ANALYSIS_SCHEMA_VERSION,
  CALL_OUTCOMES,
  CONFIDENCE_LEVELS,
  ALWAYS_REVIEW_FIELDS,
  MAX_FIELD_CHARS,
  buildOnboardingAnalysisFields,
  validateProviderAnalysis,
  toSupplementaryWarnings,
};
