// AIDA Locksmith Receptionist — transcript → canonical draft profile (M2).
//
//   extractLocksmithProfile({ transcript, existingProfile, schemaVersion })
//
// Provider-neutral. M2 ships ONE adapter: a deterministic fixture that reads a
// realistic mock interview. No model is called — no OpenAI, no Anthropic, no
// Retell (explicitly deferred). A future LLM adapter registers here and the
// profile domain model does not change; that is the point of the seam.
//
// Every adapter's output goes through the SAME gate before it becomes a draft:
//   1. structural + enum validation (locksmith-profile.js) — an adapter that
//      invents an enum value is rejected, never partially applied;
//   2. missing-field detection against the safety-critical set;
//   3. contradiction detection where it can be decided mechanically;
//   4. a review-warning list for a human to read.
//
// Extraction NEVER approves anything and never touches an approved profile. Its
// entire output is a draft proposal plus a list of reasons to look closely.
//
// Pure + dep-free. See test/locksmith-extraction.test.js.

const S = require("./locksmith-profile-schema");
const { validateProfileStructure, assessProvisioning, normaliseAuNumber } = require("./locksmith-profile");

// ── Adapter registry ────────────────────────────────────────────────

const adapters = new Map();

/**
 * Register an extraction adapter.
 * @param {string} name    e.g. "fixture-v1", later "llm-claude-v1"
 * @param {function} fn    ({ transcript, existingProfile, schemaVersion }) => profile
 */
function registerExtractionAdapter(name, fn) {
  if (!name || typeof name !== "string") throw new Error("adapter needs a name");
  if (typeof fn !== "function") throw new Error("adapter must be a function");
  adapters.set(name, fn);
}

function listExtractionAdapters() {
  return [...adapters.keys()];
}

// ── Post-extraction analysis ────────────────────────────────────────

// The facts an onboarding interview exists to establish. A gap here is a
// question the locksmith still has to answer — it is reported, never guessed.
const REQUIRED_FACTS = Object.freeze([
  { path: "identity.spokenName", label: "The name AIDA says when answering" },
  { path: "identity.receptionistName", label: "What the receptionist calls herself" },
  { path: "identity.greeting", label: "The greeting" },
  { path: "identity.timezone", label: "Business timezone" },
  { path: "identity.tone", label: "Preferred tone" },
  { path: "transfer.primaryNumber", label: "Primary transfer number" },
  { path: "transfer.unansweredAction", label: "What happens when a transfer is not answered" },
  { path: "serviceAreas.outsideAreaAction", label: "What happens to callers outside the service area" },
  { path: "pricing.mayMentionPricing", label: "Whether AIDA may mention pricing" },
  { path: "pricing.humanConfirmsEveryPrice", label: "Whether a human confirms every price" },
  { path: "hours.timezone", label: "Timezone for the business hours" },
]);

function valueAt(obj, path) {
  return path.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
}

function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Facts the interview did not establish. */
function detectMissingFields(profile) {
  const missing = [];
  for (const fact of REQUIRED_FACTS) {
    if (isMissing(valueAt(profile, fact.path))) missing.push({ path: fact.path, label: fact.label });
  }
  const accepted = (Array.isArray(profile.servicesAccepted) ? profile.servicesAccepted : []).filter((s) => s && s.enabled);
  if (accepted.length === 0) missing.push({ path: "servicesAccepted", label: "At least one service the locksmith accepts" });
  const areas = profile.serviceAreas || {};
  if (isMissing(areas.primary)) missing.push({ path: "serviceAreas.primary", label: "Primary service area" });
  if (isMissing(profile.urgencyRules)) missing.push({ path: "urgencyRules", label: "What counts as urgent" });
  return missing;
}

/**
 * Contradictions decidable without a human. Each one is a place where the
 * locksmith said two incompatible things, or where the draft would make AIDA
 * behave inconsistently. These are warnings for review — never auto-resolved,
 * because picking a side would mean guessing what the business actually does.
 */
function detectContradictions(profile) {
  const found = [];
  const add = (code, message) => found.push({ code, message });

  const accepted = new Set(
    (Array.isArray(profile.servicesAccepted) ? profile.servicesAccepted : [])
      .filter((s) => s && s.enabled === true)
      .map((s) => s.serviceId)
  );
  const declined = new Set((Array.isArray(profile.servicesDeclined) ? profile.servicesDeclined : []).map((s) => s && s.serviceId));

  for (const id of accepted) {
    if (declined.has(id)) add("service_both_ways", `${S.SERVICE_LABELS[id] || id} is listed as both accepted and declined.`);
  }

  // A service marked transfer-eligible that the business does not accept.
  const eligible = Array.isArray(profile.transfer && profile.transfer.eligibleServices) ? profile.transfer.eligibleServices : [];
  for (const id of eligible) {
    if (!accepted.has(id)) add("transfer_service_not_accepted", `Transfers are allowed for ${S.SERVICE_LABELS[id] || id}, which is not an accepted service.`);
  }

  const hours = profile.hours || {};
  // Urgency rules that transfer immediately while transfers are limited to
  // business hours: an after-hours lockout would hit a rule that cannot fire.
  const permitted = profile.transfer && profile.transfer.permittedHours;
  const immediateRules = (Array.isArray(profile.urgencyRules) ? profile.urgencyRules : []).filter((r) => r && r.action === "transfer_immediately");
  if (immediateRules.length && permitted && permitted.businessHoursOnly === true && hours.afterHoursAvailable === true) {
    add(
      "transfer_hours_conflict",
      "Some urgent calls transfer immediately, but transfers are limited to business hours while the business takes after-hours work."
    );
  }

  // After-hours work claimed with no after-hours rule anywhere.
  if (hours.afterHoursAvailable === false && immediateRules.length > 0) {
    add("after_hours_conflict", "Urgent calls are set to transfer immediately, but the business is recorded as not available after hours.");
  }

  // Areas that appear in both the covered and declined lists.
  const areas = profile.serviceAreas || {};
  const declinedAreas = new Set((Array.isArray(areas.declined) ? areas.declined : []).map((a) => String(a).trim().toLowerCase()));
  for (const area of Array.isArray(areas.primary) ? areas.primary : []) {
    if (declinedAreas.has(String(area).trim().toLowerCase())) add("area_both_ways", `"${area}" is listed as both covered and not covered.`);
  }

  // Pricing that AIDA may state while nobody confirms it.
  const pricing = profile.pricing || {};
  if (pricing.mayMentionPricing === true && pricing.humanConfirmsEveryPrice === false && (!Array.isArray(pricing.indicativePrices) || pricing.indicativePrices.length === 0)) {
    add("pricing_unbounded", "AIDA may mention pricing and no human confirms prices, but no approved wording was given.");
  }

  return found;
}

/** Human-facing review warnings: softer than a contradiction, still worth a look. */
function buildReviewWarnings(profile, { missing, contradictions }) {
  const warnings = [];
  const add = (code, message, severity = "review") => warnings.push({ code, message, severity });

  for (const m of missing) add(`missing_${m.path}`, `Not established during the interview: ${m.label}.`, "blocking");
  for (const c of contradictions) add(c.code, c.message, "contradiction");

  const assessment = assessProvisioning(profile);
  for (const w of assessment.warnings) add(w.code, w.message, "advisory");

  // Safety-critical values always get a look, even when they extracted cleanly:
  // a transcribed phone number is exactly the kind of thing speech-to-text gets
  // subtly wrong, and nobody notices until an urgent call goes nowhere.
  const transfer = profile.transfer || {};
  if (transfer.primaryNumber) {
    add("verify_transfer_number", `Read the primary transfer number back carefully — it came from speech and must be confirmed digit by digit.`, "confirm");
  }
  if (!transfer.backupNumber) add("no_backup_number", "No backup transfer number was given.", "advisory");

  return warnings;
}

// ── The gate every adapter passes through ───────────────────────────

/**
 * Run an adapter and validate what it produced.
 *
 * Returns:
 *   { ok:true, profile, missingFields, contradictions, warnings, extractionVersion, provisioning }
 *   { ok:false, code, message, errors? }
 *
 * `ok:true` means "this is a usable DRAFT", never "this is approved" — the
 * caller still has to create a draft version and route it to a human.
 */
function extractLocksmithProfile({ transcript, existingProfile = null, schemaVersion = S.SCHEMA_VERSION, adapter = "fixture-v1", clientId = null }) {
  if (schemaVersion !== S.SCHEMA_VERSION) {
    return { ok: false, code: "unsupported_schema", message: `This build understands schema ${S.SCHEMA_VERSION}, not "${String(schemaVersion).slice(0, 60)}".` };
  }
  const fn = adapters.get(adapter);
  if (!fn) return { ok: false, code: "unknown_adapter", message: `No extraction adapter named "${String(adapter).slice(0, 60)}".` };
  if (typeof transcript !== "string" || !transcript.trim()) {
    return { ok: false, code: "empty_transcript", message: "Cannot extract from an empty transcript." };
  }

  // An approved profile is read-only input. Adapters receive a deep copy so a
  // buggy or hostile adapter cannot mutate the caller's approved configuration
  // through a shared reference.
  const existingCopy = existingProfile ? JSON.parse(JSON.stringify(existingProfile)) : null;

  let produced;
  try {
    produced = fn({ transcript, existingProfile: existingCopy, schemaVersion });
  } catch (err) {
    return { ok: false, code: "adapter_failed", message: `Extraction adapter failed: ${err.message}` };
  }
  if (!produced || typeof produced !== "object" || Array.isArray(produced)) {
    return { ok: false, code: "adapter_output_invalid", message: "The extraction adapter did not return a profile object." };
  }

  // Force our schema version onto the output: an adapter does not get to claim
  // a different one.
  produced.schemaVersion = S.SCHEMA_VERSION;

  // Tenant identity is CONTEXT, never something inferred from speech. The
  // caller knows which client this session belongs to; an adapter that tried to
  // set a different clientId is overruled here, so a hostile or confused
  // transcript can never retarget a draft at another tenant.
  if (clientId) {
    if (!produced.identity || typeof produced.identity !== "object") produced.identity = {};
    produced.identity.clientId = clientId;
  }

  // STRUCTURE only. A malformed profile is rejected wholesale — half-applying
  // an adapter's output is how an unknown enum value ends up configuring a
  // receptionist. An INCOMPLETE profile is accepted: an interview where the
  // owner didn't answer everything is the normal case, and those gaps become
  // missing fields and blocking review warnings below rather than a failure.
  const validation = validateProfileStructure(produced);
  if (!validation.ok) {
    return { ok: false, code: "adapter_output_invalid", message: "The extracted profile did not pass validation.", errors: validation.errors };
  }

  const missingFields = detectMissingFields(produced);
  const contradictions = detectContradictions(produced);
  const warnings = buildReviewWarnings(produced, { missing: missingFields, contradictions });
  const provisioning = assessProvisioning(produced);

  return {
    ok: true,
    profile: produced,
    missingFields,
    contradictions,
    warnings,
    provisioning,
    extractionVersion: adapter,
    // Explicit and asserted by test: extraction never approves.
    approved: false,
  };
}

/**
 * Same gate, but tolerant of an adapter whose output fails validation: returns
 * the errors as review warnings instead of rejecting. Used ONLY by the founder
 * console's diagnostic view so a broken adapter can be inspected. Never used to
 * create a draft.
 */
function diagnoseExtraction(args) {
  const result = extractLocksmithProfile(args);
  if (result.ok) return result;
  return {
    ok: false,
    code: result.code,
    message: result.message,
    warnings: (result.errors || []).map((e) => ({ code: `invalid_${e.section}`, message: `${e.section}: ${e.message}`, severity: "blocking" })),
  };
}

module.exports = {
  registerExtractionAdapter,
  listExtractionAdapters,
  extractLocksmithProfile,
  diagnoseExtraction,
  detectMissingFields,
  detectContradictions,
  buildReviewWarnings,
  REQUIRED_FACTS,
  normaliseAuNumber,
};
