// AIDA — Retell dynamic variables (M7B).
//
// Verified against docs.retellai.com/build/dynamic-variables on 2026-08-01.
//
// ─── THE DISTINCTION THAT MATTERS ───────────────────────────────────
//
//   default_dynamic_variables       set on the Retell LLM. A FALLBACK, used
//                                   only when a call does not supply its own.
//   retell_llm_dynamic_variables    supplied PER CALL. Overrides the defaults.
//
// How per-call values arrive depends on the call type:
//   * outbound phone call — in the create-phone-call request
//   * web call            — in the create-web-call request
//   * INBOUND phone call  — ONLY via the inbound call webhook, in the response
//                           body as call_inbound.dynamic_variables
//
// That last one is the important one, and it changes an M3 design assumption.
//
// ─── WHY THE TRANSFER NUMBER CANNOT BE A DEFAULT ────────────────────
// M3 deliberately kept transfer numbers OUT of compiled artefacts, resolving
// them "at call time through a dynamic variable". Correct instinct, but the
// mechanism was never built: a compiled default is baked into the LLM at
// provisioning time, which is exactly what M3 was trying to avoid, and it
// cannot reflect who is actually on call right now.
//
// A locksmith's on-call number changes between provisioning runs. Baking it in
// means a call at 2am is transferred to whoever was on call the day the agent
// was last built. The inbound webhook is the only mechanism that can answer
// "who should this call go to, right now".
//
// Two further provider facts drive the code below:
//   * ALL VALUES MUST BE STRINGS. Numbers and booleans are not supported.
//   * An unsupplied variable renders as the literal {{name}} in the prompt
//     rather than erroring — so a missing transfer number would put the text
//     "{{transfer_primary}}" in front of a caller.
//
// Pure + dep-free.

const VARIABLES_VERSION = "retell-dynamic-variables-2026-08-01";

// The keys AIDA may ever send.
//
// Imported from the compiler rather than restated: the compiler already owns
// DYNAMIC_VARIABLE_ALLOWLIST, and a second copy here would be a second
// vocabulary to keep in step. Required lazily so this module still loads
// standalone.
function allowedKeys() {
  return require("./locksmith-receptionist-compiler").DYNAMIC_VARIABLE_ALLOWLIST;
}

const ALLOWED_KEYS = Object.freeze(allowedKeys().slice());

// Values that change between provisioning runs — the ones the compiler emits
// with a "{{runtime}}" sentinel. Sending these as provisioning-time defaults is
// a correctness bug, not a style preference, so they are named and enforced.
//
// The sentinel itself is the hazard the provider docs exposed: an unsupplied
// variable renders as literal text in the prompt, so a call that fails to
// supply a transfer number would put "{{runtime}}" in front of a caller rather
// than failing loudly.
const RUNTIME_ONLY_KEYS = Object.freeze([
  "current_transfer_number",
  "current_backup_number",
  // The spoken twins are runtime-only for the same reason as their canonical
  // originals AND one more: a spoken form baked in at provisioning time would
  // survive a correction to the number it describes. Derived per call, there is
  // nothing to go stale.
  "current_transfer_number_spoken",
  "current_backup_number_spoken",
  "caller_number_spoken",
  "current_business_status",
  "on_call_state",
  "call_kind",
]);

/** The compiler's placeholder for a value only known per call. */
const RUNTIME_SENTINEL = "{{runtime}}";

// Never acceptable in a dynamic variable, because everything here ends up
// inside a prompt the model can be induced to repeat.
const FORBIDDEN_SUBSTRINGS = Object.freeze([
  "api_key", "apikey", "secret", "token", "password", "authorization",
  "transcript", "prompt", "instruction", "system_prompt",
]);

const MAX_VALUE_LENGTH = 500;

function keyLooksForbidden(key) {
  const k = String(key).toLowerCase();
  return FORBIDDEN_SUBSTRINGS.some((bad) => k.includes(bad));
}

/**
 * Validate a dynamic-variable map for the provider.
 *
 * @param {object} vars
 * @param {"default"|"per_call"} scope
 */
function validateDynamicVariables(vars, { scope = "per_call" } = {}) {
  const errors = [];
  const clean = {};

  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    return { ok: false, errors: ["Dynamic variables must be an object of string values."], variables: {} };
  }

  for (const [key, raw] of Object.entries(vars)) {
    if (!ALLOWED_KEYS.includes(key)) {
      errors.push(`"${String(key).slice(0, 40)}" is not an allowed dynamic variable.`);
      continue;
    }
    if (keyLooksForbidden(key)) {
      errors.push(`"${key}" names something that must never be sent to the provider.`);
      continue;
    }
    if (scope === "default" && RUNTIME_ONLY_KEYS.includes(key)) {
      // Refused rather than warned. A stale transfer number sends an emergency
      // call to the wrong person, and it fails silently — the call connects,
      // just to somebody who is not on call.
      errors.push(`"${key}" changes between calls and must be supplied per call, not as a provisioning-time default.`);
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "object") {
      errors.push(`"${key}" must be a string; objects and arrays are not supported by the provider.`);
      continue;
    }
    // The provider requires strings. Coerced, because the allow-list has
    // already bounded what can appear here.
    const value = String(raw);
    if (value.length > MAX_VALUE_LENGTH) {
      errors.push(`"${key}" is too long (${value.length} characters, limit ${MAX_VALUE_LENGTH}).`);
      continue;
    }
    // A key named "_spoken" is the one the agent is told it may read aloud, so
    // an E.164 value in it is precisely the M7D defect wearing a safe name.
    // Refused rather than converted: silently fixing it would hide whichever
    // caller built the wrong value.
    if (key.endsWith("_spoken") && /\+\d{6,15}/.test(value)) {
      errors.push(`"${key}" carries a number in international form; spoken values must come from services/au-phone-speech.js.`);
      continue;
    }
    clean[key] = value;
  }

  return { ok: errors.length === 0, errors, variables: clean };
}

/**
 * The per-call variables for ONE inbound call, answered from the inbound
 * webhook.
 *
 * Takes the values resolved at that moment — who is on call, whether the
 * business is open — rather than anything compiled earlier.
 */
function buildInboundCallVariables({ transferPrimary = null, transferBackup = null, businessStatus = null, onCallState = null, callKind = null, callerNumber = null }) {
  // Required lazily so this module still loads standalone, per the house rule.
  const { describeAuNumber } = require("./au-phone-speech");

  const vars = {};

  // The spoken forms are DERIVED here and are not parameters. That is the whole
  // guarantee: a caller cannot supply a spoken value that disagrees with the
  // canonical number, because there is no way to supply one at all. M7D read a
  // transfer number aloud as "plus six one, four nine one..." — this is where
  // that is fixed for every call type at once.
  //
  // An unlocalisable number yields NO spoken variable rather than a fallback
  // string. Omitting it is safe because the compiled default is "", and the
  // prompt tells the agent to ask the caller to confirm a number it was not
  // given. A partial or invented reading would not be.
  if (transferPrimary) {
    vars.current_transfer_number = transferPrimary;
    const spoken = describeAuNumber(transferPrimary, { purpose: "transfer_primary" });
    if (spoken.spoken) vars.current_transfer_number_spoken = spoken.spoken;
  }
  if (transferBackup) {
    vars.current_backup_number = transferBackup;
    const spoken = describeAuNumber(transferBackup, { purpose: "transfer_backup" });
    if (spoken.spoken) vars.current_backup_number_spoken = spoken.spoken;
  }
  // The caller's own number, for reading a callback number back to them.
  //
  // ONLY the spoken form is sent. The agent has no use for the caller's E.164
  // value — nothing it can do requires dialling — so sending it would be
  // exposure without a purpose. Not deliverable for an inbound PHONE call until
  // the inbound webhook is enabled (M7F); see the module header.
  if (callerNumber) {
    const spoken = describeAuNumber(callerNumber, { purpose: "caller" });
    if (spoken.spoken) vars.caller_number_spoken = spoken.spoken;
  }

  if (businessStatus) vars.current_business_status = businessStatus;
  if (onCallState) vars.on_call_state = onCallState;
  if (callKind) vars.call_kind = callKind;

  return validateDynamicVariables(vars, { scope: "per_call" });
}

/**
 * Would this variable set leave a runtime placeholder visible to a caller?
 *
 * The compiler emits "{{runtime}}" as the declared default. If a call does not
 * override it, that literal string is what the model reads — and repeats. This
 * is the check that turns a silent embarrassment into a caught error.
 */
function findUnresolvedRuntimeValues(variables) {
  return Object.entries(variables || {})
    .filter(([, v]) => typeof v === "string" && (v === RUNTIME_SENTINEL || /\{\{[a-z_]+\}\}/i.test(v)))
    .map(([k]) => k);
}

/**
 * The webhook response body Retell expects for an inbound call.
 *
 * Contract (verified 2026-08-01): respond 2xx within 10 seconds with a
 * `call_inbound` object; `dynamic_variables` inside it are injected into the
 * call. Retries 3 times, then falls back to the number's configured agent.
 *
 * The 10-second budget is why this builder is pure and does no I/O: whatever
 * the caller needs must already be in hand.
 */
function buildInboundWebhookResponse({ variables = {}, metadata = null, overrideAgentId = null, reject = false }) {
  const validated = validateDynamicVariables(variables, { scope: "per_call" });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }

  const callInbound = {};
  if (Object.keys(validated.variables).length) callInbound.dynamic_variables = validated.variables;
  // Metadata is stored against the call and is NOT injected into the prompt —
  // a useful place for an internal id precisely because the model never sees it.
  if (metadata && typeof metadata === "object") callInbound.metadata = metadata;
  if (overrideAgentId) callInbound.override_agent_id = overrideAgentId;
  if (reject === true) callInbound.reject = true;

  return { ok: true, response: { call_inbound: callInbound }, timeoutSeconds: 10 };
}

/**
 * Which compiled variables are safe to send as provisioning-time defaults.
 * Anything runtime-sensitive is stripped and reported.
 */
function splitDefaultsFromRuntime(compiledVariables) {
  const defaults = {};
  const runtimeOnly = [];
  for (const [k, v] of Object.entries(compiledVariables || {})) {
    if (RUNTIME_ONLY_KEYS.includes(k)) { runtimeOnly.push(k); continue; }
    if (!ALLOWED_KEYS.includes(k)) continue;
    if (v === null || v === undefined) continue;
    defaults[k] = String(v);
  }
  return { defaults, runtimeOnly };
}

module.exports = {
  VARIABLES_VERSION,
  ALLOWED_KEYS,
  RUNTIME_ONLY_KEYS,
  FORBIDDEN_SUBSTRINGS,
  MAX_VALUE_LENGTH,
  validateDynamicVariables,
  buildInboundCallVariables,
  buildInboundWebhookResponse,
  splitDefaultsFromRuntime,
  findUnresolvedRuntimeValues,
  RUNTIME_SENTINEL,
  keyLooksForbidden,
};
