// AIDA — Retell post-call analysis retrieval and validation (M7E).
//
// Retell can run a model over a finished call and hand back structured fields.
// M7D configured `post_call_analysis_data` on the sandbox agent but never
// retrieved a result, so this is the first time AIDA looks at one.
//
// ─── THE POSTURE, UNCHANGED ─────────────────────────────────────────
// Provider analysis is USEFUL and UNTRUSTED, in that order — the same rule
// services/locksmith-analysis-schema.js already states for onboarding calls.
// Nothing in this module can reach a profile, an approval, routing, pricing or
// billing. There is no code path from here to a write. The transcript remains
// the authoritative evidence; analysis is a pointer to where to look.
//
// ─── READINESS IS NOT A BOOLEAN ─────────────────────────────────────
// Verified against docs.retellai.com on 2026-08-02: `call_ended` carries every
// field of the call object EXCEPT `call_analysis`, and `call_analyzed` fires
// separately with it. Webhooks are triggered in order but are not blocking, so
// "ended" and "analysed" are genuinely different moments.
//
// That makes "no analysis" ambiguous, and the ambiguity matters:
//   * a call that ended seconds ago is PENDING
//   * a call that never connected has nothing to analyse — it is not pending,
//     and waiting for it is waiting forever
//   * a call that ended long ago with no analysis is UNKNOWN, not "false"
//
// Collapsing those three into "not ready" is what turns a bounded poll into an
// indefinite one, which is why they are separate states here.
//
// Pure + dep-free. Contacts nothing; it is handed a parsed Get Call body.

const CALL_ANALYSIS_VERSION = "retell-call-analysis-2026-08-02";

/**
 * Documented `call_analysis` fields (docs.retellai.com/api-references/get-call,
 * reviewed 2026-08-02). ALL are optional — the object can exist with any subset
 * populated, so nothing here treats a missing field as an error.
 */
const BUILT_IN_FIELDS = Object.freeze(["call_summary", "in_voicemail", "user_sentiment", "call_successful", "custom_analysis_data"]);

/** Documented enum for `user_sentiment`. Capitalised exactly as the provider does. */
const USER_SENTIMENTS = Object.freeze(["Negative", "Positive", "Neutral", "Unknown"]);

const ANALYSIS_STATES = Object.freeze({
  ready: "ready",
  pending: "pending",
  notApplicable: "not_applicable",
  unknown: "unknown",
  providerError: "provider_error",
});

/**
 * Call statuses that mean no conversation happened, so no analysis will ever
 * arrive. Documented `call_status` values; see retell-call-diagnostics.js for
 * the full enum.
 */
const NO_CONVERSATION_STATUSES = Object.freeze(["registered", "not_connected", "error"]);

/**
 * The expected type of a custom analysis field.
 *
 * Two vocabularies exist and both are real: the API's `post_call_analysis_data`
 * entries use `type: "string" | "enum" | "boolean" | "number"` (which is what
 * services/locksmith-analysis-schema.js emits), while the dashboard documents
 * the same four as Text / Selector / Boolean / Number. Both are accepted so a
 * schema copied from either place validates, rather than failing on a spelling.
 */
const TYPE_ALIASES = Object.freeze({
  string: "string", text: "string",
  enum: "enum", selector: "enum",
  boolean: "boolean",
  number: "number",
  "system-presets": "system_preset",
});

function normaliseExpectedType(raw) {
  if (typeof raw !== "string") return null;
  return TYPE_ALIASES[raw.trim().toLowerCase()] || null;
}

/**
 * Classify analysis readiness from a Get Call body.
 *
 * @param {object|null} body        parsed Get Call response, or null
 * @param {object} [options]
 * @param {string} [options.providerErrorCode] set when the read itself failed
 * @returns {{state, reason, hasCustomData, fieldsPresent[]}}
 */
function classifyAnalysisReadiness(body, { providerErrorCode = null } = {}) {
  if (providerErrorCode) {
    return Object.freeze({
      state: ANALYSIS_STATES.providerError,
      reason: `the provider read failed (${providerErrorCode})`,
      hasCustomData: false,
      fieldsPresent: [],
    });
  }
  if (!body || typeof body !== "object") {
    return Object.freeze({ state: ANALYSIS_STATES.unknown, reason: "no call body was returned", hasCustomData: false, fieldsPresent: [] });
  }

  const analysis = body.call_analysis;
  const status = typeof body.call_status === "string" ? body.call_status : null;

  if (analysis && typeof analysis === "object" && !Array.isArray(analysis)) {
    const fieldsPresent = BUILT_IN_FIELDS.filter((f) => analysis[f] !== undefined && analysis[f] !== null);
    if (fieldsPresent.length === 0) {
      // The object exists but carries nothing. Reported honestly rather than
      // counted as ready — a consumer that trusts "ready" would read nulls.
      return Object.freeze({ state: ANALYSIS_STATES.pending, reason: "call_analysis was returned but every documented field was empty", hasCustomData: false, fieldsPresent: [] });
    }
    const custom = analysis.custom_analysis_data;
    return Object.freeze({
      state: ANALYSIS_STATES.ready,
      reason: null,
      hasCustomData: Boolean(custom && typeof custom === "object" && !Array.isArray(custom) && Object.keys(custom).length),
      fieldsPresent,
    });
  }

  if (status && NO_CONVERSATION_STATUSES.includes(status)) {
    return Object.freeze({
      state: ANALYSIS_STATES.notApplicable,
      // Documented behaviour is silent on this, so the reason says what we
      // OBSERVED rather than asserting what the provider will do.
      reason: `call_status is "${status}", so there was no conversation to analyse; polling would not end`,
      hasCustomData: false,
      fieldsPresent: [],
    });
  }

  if (status === "ended") {
    return Object.freeze({
      state: ANALYSIS_STATES.pending,
      reason: "the call has ended and call_analysis has not appeared yet — call_analyzed fires separately from call_ended",
      hasCustomData: false,
      fieldsPresent: [],
    });
  }

  if (status === "ongoing") {
    return Object.freeze({ state: ANALYSIS_STATES.pending, reason: "the call is still in progress", hasCustomData: false, fieldsPresent: [] });
  }

  return Object.freeze({
    state: ANALYSIS_STATES.unknown,
    reason: status ? `call_status "${status}" is not one this build models` : "the response carried no call_status",
    hasCustomData: false,
    fieldsPresent: [],
  });
}

/**
 * Validate and sanitise a `call_analysis` object.
 *
 * `expectedCustomFields` is the schema AIDA asked the provider for, in the same
 * `{ type, name, description, choices }` shape the compilers emit. Supplying it
 * turns "the provider returned something" into "the provider returned what we
 * asked for"; omitting it still validates the built-in fields.
 *
 * A type mismatch is FLAGGED, never coerced. A model that answers "yes" where a
 * boolean was requested has told us something about the model, and silently
 * casting it to `true` would throw that away.
 *
 * `call_summary` is model-written prose about a real conversation, so it is
 * treated as content: length and presence are reported, the text is not, unless
 * `includeContent` is explicitly set.
 */
function validateCallAnalysis(analysis, { expectedCustomFields = [], includeContent = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return Object.freeze({ ok: false, analysis: null, errors: [{ field: "call_analysis", message: "call_analysis was not an object." }], warnings: [] });
  }

  const out = {};

  // ── Built-in fields ────────────────────────────────────────────────
  if (analysis.call_summary === undefined || analysis.call_summary === null) {
    out.callSummaryPresent = false;
    out.callSummaryLength = 0;
  } else if (typeof analysis.call_summary !== "string") {
    errors.push({ field: "call_summary", message: "call_summary must be text." });
    out.callSummaryPresent = false;
    out.callSummaryLength = 0;
  } else {
    out.callSummaryPresent = true;
    out.callSummaryLength = analysis.call_summary.length;
    if (includeContent) out.callSummary = analysis.call_summary;
  }

  for (const [field, key] of [["in_voicemail", "inVoicemail"], ["call_successful", "callSuccessful"]]) {
    const value = analysis[field];
    if (value === undefined || value === null) { out[key] = null; continue; }
    if (typeof value !== "boolean") {
      errors.push({ field, message: `${field} must be a boolean.` });
      continue;
    }
    out[key] = value;
  }

  if (analysis.user_sentiment === undefined || analysis.user_sentiment === null) {
    out.userSentiment = null;
  } else if (!USER_SENTIMENTS.includes(analysis.user_sentiment)) {
    // Rejected, not coerced — an invented sentiment is a schema failure, and
    // "Unknown" is itself a documented value, so mapping to it would erase the
    // difference between "the model said Unknown" and "the model said nonsense".
    errors.push({ field: "user_sentiment", message: `"${String(analysis.user_sentiment).slice(0, 40)}" is not a documented user_sentiment value.` });
  } else {
    out.userSentiment = analysis.user_sentiment;
  }

  // ── Custom fields ──────────────────────────────────────────────────
  const raw = analysis.custom_analysis_data;
  const custom = {};
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ field: "custom_analysis_data", message: "custom_analysis_data must be an object." });
    } else {
      const expected = new Map();
      for (const spec of expectedCustomFields || []) {
        if (spec && typeof spec.name === "string") expected.set(spec.name, spec);
      }
      // No schema supplied is not the same as "the provider sent something we
      // did not ask for". The M7E-LV live read reported every returned field as
      // "not in the requested schema" when in fact no schema had been given to
      // compare against — a message asserting a check the code never performed.
      const schemaSupplied = expected.size > 0;

      for (const [name, value] of Object.entries(raw)) {
        const spec = expected.get(name);
        if (!spec) {
          if (!schemaSupplied) {
            warnings.push({ code: "no_schema_supplied", message: `"${String(name).slice(0, 40)}" was returned; no expected schema was supplied, so its type was not checked.` });
            continue;
          }
          // Not an error: the agent's schema can legitimately be ahead of this
          // caller's expectations. Recorded so nothing arrives unnoticed.
          warnings.push({ code: "unexpected_custom_field", message: `The provider returned "${String(name).slice(0, 40)}", which was not in the requested schema.` });
          continue;
        }
        const type = normaliseExpectedType(spec.type);
        const checked = checkCustomValue({ name, value, type, spec });
        if (checked.error) { errors.push(checked.error); continue; }
        if (checked.warning) warnings.push(checked.warning);
        custom[name] = checked.value;
      }

      for (const [name] of expected) {
        if (!(name in raw)) warnings.push({ code: "missing_custom_field", message: `The provider did not return "${name}".` });
      }
    }
  }
  out.custom = custom;

  return Object.freeze({ ok: errors.length === 0, analysis: Object.freeze(out), errors, warnings });
}

/**
 * One custom field. Returns { value } or { error } — never a coerced value.
 *
 * Free text is length-reported rather than carried, for the same reason
 * `call_summary` is: a custom text field is model-written prose about a real
 * caller. `includeContent` is not honoured here at all; if an investigator
 * needs the words, the transcript path is the honest place to ask for them.
 */
function checkCustomValue({ name, value, type, spec }) {
  if (value === undefined || value === null) {
    return { value: null, warning: { code: "empty_custom_field", message: `"${name}" was returned empty.` } };
  }
  switch (type) {
    case "string":
    case "system_preset":
      if (typeof value !== "string") return { error: { field: name, message: `${name} must be text; got ${typeof value}.` } };
      return { value: { type: "string", present: true, length: value.length } };
    case "boolean":
      if (typeof value !== "boolean") return { error: { field: name, message: `${name} must be a boolean; got ${typeof value}.` } };
      return { value: { type: "boolean", value } };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: { field: name, message: `${name} must be a finite number; got ${typeof value}.` } };
      return { value: { type: "number", value } };
    case "enum": {
      if (typeof value !== "string") return { error: { field: name, message: `${name} must be one of its choices; got ${typeof value}.` } };
      const choices = Array.isArray(spec.choices) ? spec.choices : [];
      if (choices.length && !choices.includes(value)) {
        return { error: { field: name, message: `"${String(value).slice(0, 40)}" is not one of the choices requested for ${name}.` } };
      }
      return { value: { type: "enum", value } };
    }
    default:
      return { error: { field: name, message: `${name} was requested with an unrecognised type "${String(spec && spec.type).slice(0, 30)}".` } };
  }
}

/**
 * Poll a read function until analysis is ready, or give up.
 *
 * BOUNDED BY CONSTRUCTION. There is no "wait until" branch: the loop is driven
 * by an attempt count derived from maxWaitMs, so a provider that never produces
 * analysis costs a known amount of time rather than a hung process.
 *
 * `readCall` is injected and returns `{ ok, body?, errorCode? }`, so this
 * function performs no I/O and tests drive it with a fake clock.
 */
async function pollForAnalysis({ readCall, intervalMs = 5000, maxWaitMs = 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onAttempt = null }) {
  if (typeof readCall !== "function") throw new Error("pollForAnalysis requires a readCall function");
  const interval = Math.max(1000, Number(intervalMs) || 0);
  const budget = Math.max(interval, Number(maxWaitMs) || 0);
  const maxAttempts = Math.max(1, Math.floor(budget / interval));

  let attempt = 0;
  let last = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await readCall();
    if (!result || result.ok !== true) {
      const readiness = classifyAnalysisReadiness(null, { providerErrorCode: (result && result.errorCode) || "unknown_error" });
      // A provider error ends the poll immediately. Retrying a 401 or a 404 for
      // a minute produces the same answer more expensively.
      return Object.freeze({ outcome: "provider_error", attempts: attempt, readiness, body: null });
    }
    const readiness = classifyAnalysisReadiness(result.body);
    last = readiness;
    if (onAttempt) onAttempt({ attempt, readiness });

    if (readiness.state === ANALYSIS_STATES.ready) {
      return Object.freeze({ outcome: "ready", attempts: attempt, readiness, body: result.body });
    }
    if (readiness.state === ANALYSIS_STATES.notApplicable) {
      // Terminal. Waiting for analysis of a call that never connected is the
      // one case where polling genuinely cannot succeed.
      return Object.freeze({ outcome: "not_applicable", attempts: attempt, readiness, body: result.body });
    }
    if (attempt < maxAttempts) await sleep(interval);
  }

  return Object.freeze({
    outcome: "timeout",
    attempts: attempt,
    readiness: last || classifyAnalysisReadiness(null),
    body: null,
  });
}

module.exports = {
  CALL_ANALYSIS_VERSION,
  ANALYSIS_STATES,
  BUILT_IN_FIELDS,
  USER_SENTIMENTS,
  NO_CONVERSATION_STATUSES,
  TYPE_ALIASES,
  classifyAnalysisReadiness,
  validateCallAnalysis,
  pollForAnalysis,
};
