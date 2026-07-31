// AIDA — Retell provider configuration (M3).
//
// Retell is an EXECUTION PROVIDER, never the owner of a locksmith's
// configuration. The canonical profile (src/services/locksmith-profile-schema.js)
// is the source of truth; everything here describes how we *talk to* Retell and
// under what conditions we are allowed to.
//
// FOUR INDEPENDENT DANGER GATES, all dormant by default, all strict-parse
// (D7 house rule — only the exact string "true" enables):
//   RETELL_ENABLED             the integration exists at all
//   RETELL_WEBHOOK_ENABLED     inbound provider events are processed
//   RETELL_LIVE_WRITES_ENABLED resources may be created/updated at Retell
//   RETELL_LIVE_CALLS_ENABLED  phone calls may be placed (spends money)
//
// Plus one inverted gate:
//   RETELL_DRY_RUN             defaults ON. Only the exact string "false"
//                              leaves dry-run. Dry-run means plans are
//                              produced and nothing leaves the process.
//
// The gates are deliberately separate rather than one "production" switch:
// enabling the integration to *preview* a plan must not also grant permission
// to create agents, and creating agents must not grant permission to dial a
// customer. A misconfiguration should cost a 500, never a phone call.
//
// FAIL CLOSED: an invalid value is not a warning, it is off. assessRetellConfig
// reports fatal problems in the same { fatal, warnings } shape as
// config/startup-check.js and config/voip.js so they merge cleanly.
//
// NEVER LOGGED, anywhere in this integration: API keys, full phone numbers,
// full transcripts, raw webhook signatures, client business configuration.
// redactSecrets() below is the shared scrubber.
//
// Pure + dep-free. See test/retell-config.test.js.

const PROVIDER = "retell";

// Documented default from Retell's API reference (docs reviewed 2026-08-01 —
// see docs/RETELL_INTEGRATION_SPEC.md §2 for the page list).
const DEFAULT_API_BASE_URL = "https://api.retellai.com";

// Retell versions per-endpoint rather than globally: create-phone-call lives
// under /v2 while agent/LLM endpoints are unversioned. We therefore store the
// base URL and let the adapter own each path, rather than pretending there is
// one API version. Recorded here so the decision is visible.
const ENDPOINT_API_VERSIONS = Object.freeze({
  createPhoneCall: "v2",
  agent: null,
  responseEngine: null,
  knowledgeBase: null,
  phoneNumber: null,
});

// Template versions are CODE artefacts, not deployment settings: a template
// change is a code change that must alter the compiled hash. They are exposed
// here (with env override for emergency pinning) so every consumer reads one
// source.
const ONBOARDING_TEMPLATE_VERSION = "retell-onboarding-template-2026-08-01";
const RECEPTIONIST_TEMPLATE_VERSION = "retell-receptionist-template-2026-08-01";

// Retell's documented response-engine types.
const RESPONSE_ENGINE_TYPES = Object.freeze(["retell-llm", "custom-llm", "conversation-flow"]);

// Environment tags keep dev provisioning out of the production account's way.
const ALLOWED_TAGS = Object.freeze(["dev", "staging", "prod"]);

const DEFAULTS = Object.freeze({
  timeoutMs: 30000,
  maxRetries: 2,
  // A call_ended payload carries a full transcript; 512 KB is generous for that
  // and still bounds a hostile body. Anything larger is refused before parsing.
  webhookMaxBytes: 512 * 1024,
  language: "en-AU",
  responseEngineType: "retell-llm",
  tag: "dev",
  recordingEnabled: false, // recording stays off until the founder's legal wording is settled
  transcriptRetention: "keep_12_months", // mirrors the canonical profile enum
});

// ── Strict parsing ──────────────────────────────────────────────────

/** Only the exact string "true". Anything else — including unset — is false. */
function strictTrue(value) {
  return value === "true";
}

/** Inverted gate: only the exact string "false" turns dry-run off. */
function strictDryRun(value) {
  return value !== "false";
}

function positiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * A base URL is only acceptable if it is https and has no path, query or
 * fragment — a "base URL" carrying a path is how a request ends up somewhere
 * unintended. Returns null when unusable, which assessRetellConfig turns fatal.
 */
function parseBaseUrl(raw) {
  if (!raw) return DEFAULT_API_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.search || url.hash) return null;
  if (url.pathname && url.pathname !== "/") return null;
  return `${url.protocol}//${url.host}`;
}

function parsePublicUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// ── Flags ───────────────────────────────────────────────────────────

function isRetellEnabled(env = process.env) {
  return strictTrue(env.RETELL_ENABLED);
}
function isWebhookEnabled(env = process.env) {
  return strictTrue(env.RETELL_WEBHOOK_ENABLED);
}
function isLiveWritesEnabled(env = process.env) {
  return strictTrue(env.RETELL_LIVE_WRITES_ENABLED);
}
function isLiveCallsEnabled(env = process.env) {
  return strictTrue(env.RETELL_LIVE_CALLS_ENABLED);
}
function isDryRun(env = process.env) {
  return strictDryRun(env.RETELL_DRY_RUN);
}

// ── Config assembly ─────────────────────────────────────────────────

function getRetellConfig(env = process.env) {
  const apiKey = env.RETELL_API_KEY || null;
  const baseUrl = parseBaseUrl(env.RETELL_API_BASE_URL);

  return Object.freeze({
    provider: PROVIDER,

    enabled: isRetellEnabled(env),
    webhookEnabled: isWebhookEnabled(env),
    liveWritesEnabled: isLiveWritesEnabled(env),
    liveCallsEnabled: isLiveCallsEnabled(env),
    dryRun: isDryRun(env),

    // Presence only. The key itself never leaves this module except through
    // the adapter's request builder, and never appears in a config dump.
    hasApiKey: Boolean(apiKey),
    apiKey,

    apiBaseUrl: baseUrl,
    apiBaseUrlValid: baseUrl !== null,
    endpointApiVersions: ENDPOINT_API_VERSIONS,

    timeoutMs: positiveInt(env.RETELL_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 1000, max: 120000 }),
    maxRetries: positiveInt(env.RETELL_MAX_RETRIES, DEFAULTS.maxRetries, { min: 0, max: 5 }),
    webhookMaxBytes: positiveInt(env.RETELL_WEBHOOK_MAX_BYTES, DEFAULTS.webhookMaxBytes, { min: 1024, max: 5 * 1024 * 1024 }),

    // No invented default: a voice id must come from the Retell dashboard.
    // Missing it blocks live provisioning rather than guessing an identifier.
    defaultVoiceId: env.RETELL_DEFAULT_VOICE_ID || null,
    defaultLanguage: env.RETELL_DEFAULT_LANGUAGE || DEFAULTS.language,
    responseEngineType: RESPONSE_ENGINE_TYPES.includes(env.RETELL_RESPONSE_ENGINE_TYPE)
      ? env.RETELL_RESPONSE_ENGINE_TYPE
      : DEFAULTS.responseEngineType,

    onboardingTemplateVersion: env.RETELL_ONBOARDING_TEMPLATE_VERSION || ONBOARDING_TEMPLATE_VERSION,
    receptionistTemplateVersion: env.RETELL_RECEPTIONIST_TEMPLATE_VERSION || RECEPTIONIST_TEMPLATE_VERSION,

    // Placeholders. No number is ever defaulted — a wrong from_number dials
    // from someone else's line, and a wrong demo number dials a stranger.
    outboundOnboardingNumber: env.RETELL_OUTBOUND_ONBOARDING_NUMBER || null,
    inboundDemoNumber: env.RETELL_INBOUND_DEMO_NUMBER || null,

    webhookBaseUrl: parsePublicUrl(env.RETELL_WEBHOOK_BASE_URL),
    allowedTag: ALLOWED_TAGS.includes(env.RETELL_ALLOWED_TAG) ? env.RETELL_ALLOWED_TAG : DEFAULTS.tag,

    recordingEnabled: strictTrue(env.RETELL_RECORDING_ENABLED), // default off, legal review pending
    transcriptRetention: env.RETELL_TRANSCRIPT_RETENTION || DEFAULTS.transcriptRetention,
  });
}

// ── Capability gates ────────────────────────────────────────────────
// Each returns { allowed, reasons[] }. A refusal always says why, because a
// silent "nothing happened" is indistinguishable from a bug.

function canPlan(env = process.env) {
  // Planning is always allowed: it is pure computation over the canonical
  // profile and touches no network. This exists so callers can express intent
  // symmetrically rather than special-casing.
  return { allowed: true, reasons: [] };
}

function canWriteLive(env = process.env) {
  const config = getRetellConfig(env);
  const reasons = [];
  if (!config.enabled) reasons.push("RETELL_ENABLED is not \"true\"");
  if (!config.liveWritesEnabled) reasons.push("RETELL_LIVE_WRITES_ENABLED is not \"true\"");
  if (config.dryRun) reasons.push("RETELL_DRY_RUN is on (set it to \"false\" to leave dry-run)");
  if (!config.hasApiKey) reasons.push("RETELL_API_KEY is not set");
  if (!config.apiBaseUrlValid) reasons.push("RETELL_API_BASE_URL is not a valid https origin");
  if (!config.defaultVoiceId) reasons.push("RETELL_DEFAULT_VOICE_ID is not set");
  return { allowed: reasons.length === 0, reasons };
}

function canPlaceCall(env = process.env) {
  const write = canWriteLive(env);
  const config = getRetellConfig(env);
  const reasons = [...write.reasons];
  if (!config.liveCallsEnabled) reasons.push("RETELL_LIVE_CALLS_ENABLED is not \"true\"");
  if (!config.outboundOnboardingNumber) reasons.push("RETELL_OUTBOUND_ONBOARDING_NUMBER is not set");
  return { allowed: reasons.length === 0, reasons };
}

function canVerifyWebhook(env = process.env) {
  const config = getRetellConfig(env);
  const reasons = [];
  if (!config.enabled) reasons.push("RETELL_ENABLED is not \"true\"");
  if (!config.webhookEnabled) reasons.push("RETELL_WEBHOOK_ENABLED is not \"true\"");
  // Retell signs with the API key, so no key means no verification is possible
  // — and an unverifiable webhook must never be processed.
  if (!config.hasApiKey) reasons.push("RETELL_API_KEY is not set (it is the webhook signing secret)");
  return { allowed: reasons.length === 0, reasons };
}

// ── Startup assessment ──────────────────────────────────────────────

/**
 * Same { enabled, fatal, warnings } shape as assessVoipConfig. Silent while
 * the integration is off — a non-Retell deploy must see nothing in its logs.
 */
function assessRetellConfig(env = process.env) {
  if (!isRetellEnabled(env)) return { enabled: false, fatal: [], warnings: [] };

  const config = getRetellConfig(env);
  const fatal = [];
  const warnings = [];

  if (!config.hasApiKey) {
    fatal.push({ name: "RETELL_API_KEY", hint: "RETELL_ENABLED=true but no API key is set — every provider call and webhook verification would fail" });
  }
  if (!config.apiBaseUrlValid) {
    fatal.push({ name: "RETELL_API_BASE_URL", hint: "must be an https origin with no path, query or fragment" });
  }
  if (env.RETELL_ALLOWED_TAG && !ALLOWED_TAGS.includes(env.RETELL_ALLOWED_TAG)) {
    fatal.push({ name: "RETELL_ALLOWED_TAG", hint: `must be one of ${ALLOWED_TAGS.join(", ")}` });
  }
  if (env.RETELL_RESPONSE_ENGINE_TYPE && !RESPONSE_ENGINE_TYPES.includes(env.RETELL_RESPONSE_ENGINE_TYPE)) {
    fatal.push({ name: "RETELL_RESPONSE_ENGINE_TYPE", hint: `must be one of ${RESPONSE_ENGINE_TYPES.join(", ")}` });
  }

  if (config.liveWritesEnabled && !config.defaultVoiceId) {
    fatal.push({ name: "RETELL_DEFAULT_VOICE_ID", hint: "live writes are enabled but no voice id is configured — agent creation would fail" });
  }
  if (config.liveCallsEnabled && !config.outboundOnboardingNumber) {
    fatal.push({ name: "RETELL_OUTBOUND_ONBOARDING_NUMBER", hint: "live calls are enabled but there is no number to dial from" });
  }
  if (config.webhookEnabled && !config.webhookBaseUrl) {
    warnings.push({ name: "RETELL_WEBHOOK_BASE_URL", hint: "webhooks are enabled but no public base URL is set — agents cannot be told where to send events" });
  }
  if (config.liveWritesEnabled && config.dryRun) {
    warnings.push({ name: "RETELL_DRY_RUN", hint: "live writes are enabled but dry-run is still on — nothing will be sent" });
  }
  if (config.liveCallsEnabled && config.allowedTag === "prod" && !config.recordingEnabled) {
    // Informational only: recording-off is the intended default.
    warnings.push({ name: "RETELL_RECORDING_ENABLED", hint: "recording is off (the intended default until the legal wording is confirmed)" });
  }

  return { enabled: true, fatal, warnings };
}

// ── Redaction ───────────────────────────────────────────────────────

const REDACTED = "[redacted]";

/** Mask a phone number to its last two digits: "+61491570006" -> "+61•••••••06". */
function maskPhone(value) {
  if (typeof value !== "string" || value.length < 4) return REDACTED;
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.length < 4) return REDACTED;
  const head = digits.startsWith("+") ? digits.slice(0, 3) : digits.slice(0, 2);
  return `${head}${"•".repeat(Math.max(0, digits.length - head.length - 2))}${digits.slice(-2)}`;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|authorization|secret|token|signature|password)/i;
const PHONE_KEY_PATTERN = /(phone|number|from_number|to_number|msisdn|transfer)/i;
const BULK_KEY_PATTERN = /(transcript|recording_url|prompt|general_prompt|knowledge|profile)/i;

/**
 * Scrub an object before it reaches a log line, an error body or a view.
 * Recursive, depth-bounded, and conservative: an unrecognised key with a long
 * string value is truncated rather than trusted.
 */
function redactSecrets(value, { depth = 0 } = {}) {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…[truncated]` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactSecrets(v, { depth: depth + 1 }));
  if (typeof value !== "object") return REDACTED;

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else if (PHONE_KEY_PATTERN.test(key) && typeof raw === "string") {
      out[key] = maskPhone(raw);
    } else if (BULK_KEY_PATTERN.test(key)) {
      out[key] = typeof raw === "string" ? `[${key}:${raw.length} chars]` : "[omitted]";
    } else {
      out[key] = redactSecrets(raw, { depth: depth + 1 });
    }
  }
  return out;
}

/**
 * A config summary safe to render in the founder console. Deliberately reports
 * key PRESENCE, never the key, and masks both configured numbers.
 */
function toSafeConfigSummary(env = process.env) {
  const config = getRetellConfig(env);
  return Object.freeze({
    provider: config.provider,
    enabled: config.enabled,
    webhookEnabled: config.webhookEnabled,
    liveWritesEnabled: config.liveWritesEnabled,
    liveCallsEnabled: config.liveCallsEnabled,
    dryRun: config.dryRun,
    apiKeyConfigured: config.hasApiKey,
    apiBaseUrl: config.apiBaseUrl,
    apiBaseUrlValid: config.apiBaseUrlValid,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    webhookMaxBytes: config.webhookMaxBytes,
    defaultVoiceId: config.defaultVoiceId,
    defaultLanguage: config.defaultLanguage,
    responseEngineType: config.responseEngineType,
    onboardingTemplateVersion: config.onboardingTemplateVersion,
    receptionistTemplateVersion: config.receptionistTemplateVersion,
    outboundOnboardingNumber: config.outboundOnboardingNumber ? maskPhone(config.outboundOnboardingNumber) : null,
    inboundDemoNumber: config.inboundDemoNumber ? maskPhone(config.inboundDemoNumber) : null,
    webhookBaseUrlConfigured: Boolean(config.webhookBaseUrl),
    allowedTag: config.allowedTag,
    recordingEnabled: config.recordingEnabled,
    transcriptRetention: config.transcriptRetention,
    capabilities: {
      canWriteLive: canWriteLive(env),
      canPlaceCall: canPlaceCall(env),
      canVerifyWebhook: canVerifyWebhook(env),
    },
  });
}

module.exports = {
  PROVIDER,
  DEFAULT_API_BASE_URL,
  ENDPOINT_API_VERSIONS,
  ONBOARDING_TEMPLATE_VERSION,
  RECEPTIONIST_TEMPLATE_VERSION,
  RESPONSE_ENGINE_TYPES,
  ALLOWED_TAGS,
  DEFAULTS,
  strictTrue,
  strictDryRun,
  parseBaseUrl,
  isRetellEnabled,
  isWebhookEnabled,
  isLiveWritesEnabled,
  isLiveCallsEnabled,
  isDryRun,
  getRetellConfig,
  canPlan,
  canWriteLive,
  canPlaceCall,
  canVerifyWebhook,
  assessRetellConfig,
  redactSecrets,
  maskPhone,
  toSafeConfigSummary,
  REDACTED,
};
