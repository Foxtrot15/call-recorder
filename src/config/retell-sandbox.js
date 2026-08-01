// AIDA — Retell WEB-CALL sandbox configuration (M7B).
//
// ─────────────────────────────────────────────────────────────────────
// A SEPARATE GATE FROM THE TELEPHONE-CALL GATE. DELIBERATELY.
// ─────────────────────────────────────────────────────────────────────
//
// RETELL_LIVE_CALLS_ENABLED governs PHONE calls. It requires
// RETELL_OUTBOUND_ONBOARDING_NUMBER, it can dial a real handset, and enabling it
// is the single most expensive mistake available in this codebase.
//
// A web call is a different thing: browser audio, no number, no dialling, no
// carrier. Forcing it through the phone-call gate would mean switching on the
// ability to ring real telephones in order to test a browser microphone — so
// this sandbox has its own gate, and it REFUSES TO RUN if the phone-call gate is
// on. That refusal is not belt-and-braces; it is the point. If someone has
// enabled live phone calls, this is not a sandbox any more and the script
// should not pretend otherwise.
//
// Every flag is strict-parse (only the exact string "true"), every flag
// defaults OFF, and the execution gate requires all of them simultaneously.
//
// Pure + dep-free: reads env, touches nothing, never returns a secret.

const { getRetellConfig } = require("./retell");

const SANDBOX_CONFIG_VERSION = "retell-sandbox-config-2026-08-01";

function strictTrue(value) {
  return value === "true";
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Conservative defaults. A knowledge base takes an unknown amount of time to
// process — that is one of the things this sandbox exists to measure — so the
// ceiling is generous while the poll interval stays polite.
const DEFAULTS = Object.freeze({
  timeoutMs: 30000,
  kbPollMs: 3000,
  kbMaxWaitMs: 180000,
});

function isSandboxEnabled(env = process.env) {
  return strictTrue(env.RETELL_SANDBOX_WEB_CALL_ENABLED);
}

/** The second, explicit switch. Enabling the sandbox is not the same as running it. */
function isSandboxExecuteEnabled(env = process.env) {
  return strictTrue(env.RETELL_SANDBOX_EXECUTE);
}

/**
 * Keeping resources costs money for as long as they exist.
 *
 * This env var alone is NOT sufficient — scripts/retell-web-sandbox.js requires
 * --keep-resources on the command line as well. An environment variable set once
 * and forgotten must never be the reason a paid resource is still alive next
 * month.
 */
function isKeepResourcesRequested(env = process.env) {
  return strictTrue(env.RETELL_SANDBOX_KEEP_RESOURCES);
}

function getSandboxConfig(env = process.env) {
  const retell = getRetellConfig(env);

  return Object.freeze({
    sandboxConfigVersion: SANDBOX_CONFIG_VERSION,
    enabled: isSandboxEnabled(env),
    executeRequested: isSandboxExecuteEnabled(env),
    keepResourcesRequested: isKeepResourcesRequested(env),
    timeoutMs: positiveInt(env.RETELL_SANDBOX_TIMEOUT_MS, DEFAULTS.timeoutMs),
    kbPollMs: positiveInt(env.RETELL_SANDBOX_KB_POLL_MS, DEFAULTS.kbPollMs),
    kbMaxWaitMs: positiveInt(env.RETELL_SANDBOX_KB_MAX_WAIT_MS, DEFAULTS.kbMaxWaitMs),
    // Presence only. The key itself is never carried on this object, so it
    // cannot be logged by dumping the config.
    hasApiKey: Boolean(retell.apiKey),
    voiceId: retell.defaultVoiceId,
    language: retell.defaultLanguage,
    allowedTag: retell.allowedTag,
    retellEnabled: retell.enabled,
    liveWritesEnabled: retell.liveWritesEnabled,
    liveCallsEnabled: retell.liveCallsEnabled,
    dryRun: retell.dryRun,
    recordingEnabled: retell.recordingEnabled === true,
    webhookEnabled: retell.webhookEnabled === true,
    nodeEnv: env.NODE_ENV || "development",
  });
}

/**
 * Every condition, evaluated together, with a reason for each failure.
 *
 * Returns ALL blockers rather than the first, so someone configuring this gets
 * the whole list instead of discovering them one run at a time.
 */
function evaluateSandboxGate(env = process.env) {
  const c = getSandboxConfig(env);
  const blockers = [];

  // ── Environment ──────────────────────────────────────────────────
  if (c.nodeEnv === "production") {
    blockers.push("NODE_ENV is production. The sandbox never runs in production.");
  }

  // ── The phone-call gate must be OFF ──────────────────────────────
  if (c.liveCallsEnabled) {
    blockers.push(
      "RETELL_LIVE_CALLS_ENABLED is \"true\". A web-call sandbox must not run while real telephone calls are enabled — turn it off first."
    );
  }

  // ── Provider gates ───────────────────────────────────────────────
  if (!c.retellEnabled) blockers.push("RETELL_ENABLED is not \"true\".");
  if (!c.liveWritesEnabled) blockers.push("RETELL_LIVE_WRITES_ENABLED is not \"true\" — the sandbox creates real provider resources.");
  if (c.dryRun) blockers.push("RETELL_DRY_RUN is on (it is on unless explicitly \"false\").");
  if (c.allowedTag !== "dev") blockers.push(`RETELL_ALLOWED_TAG is "${c.allowedTag}", not "dev".`);

  // ── Sandbox-specific gates ───────────────────────────────────────
  if (!c.enabled) blockers.push("RETELL_SANDBOX_WEB_CALL_ENABLED is not \"true\".");
  if (!c.executeRequested) blockers.push("RETELL_SANDBOX_EXECUTE is not \"true\".");

  // ── Required values ──────────────────────────────────────────────
  if (!c.hasApiKey) blockers.push("RETELL_API_KEY is not set.");
  if (!c.voiceId) blockers.push("RETELL_DEFAULT_VOICE_ID is not set. No voice id is ever invented.");
  if (!c.language) blockers.push("RETELL_DEFAULT_LANGUAGE is not set.");

  // ── Things that must stay off ────────────────────────────────────
  if (c.recordingEnabled) blockers.push("Recording is enabled. The sandbox runs with recording off.");
  if (c.webhookEnabled) blockers.push("Retell webhooks are enabled. The sandbox uses no webhook.");

  return {
    allowed: blockers.length === 0,
    blockers,
    config: c,
    // Stated explicitly so the report and the script agree on what is NOT
    // required, rather than each asserting it separately.
    notRequired: Object.freeze([
      "RETELL_OUTBOUND_ONBOARDING_NUMBER — no telephone call is placed",
      "RETELL_INBOUND_DEMO_NUMBER — no number is bought, imported or bound",
      "RETELL_WEBHOOK_BASE_URL — no webhook is configured",
      "ANTHROPIC_API_KEY — provider-contract validation needs no model key",
    ]),
  };
}

/**
 * May resources be kept alive after a run?
 *
 * Requires BOTH the environment variable and an explicit command-line flag.
 * Two independent signals, because the cost of getting this wrong is a paid
 * resource nobody remembers creating.
 */
function evaluateKeepResources(env = process.env, { commandLineFlag = false } = {}) {
  const envRequested = isKeepResourcesRequested(env);
  if (commandLineFlag && envRequested) {
    return { keep: true, reason: "both RETELL_SANDBOX_KEEP_RESOURCES and --keep-resources were given" };
  }
  if (commandLineFlag && !envRequested) {
    return { keep: false, reason: "--keep-resources was given but RETELL_SANDBOX_KEEP_RESOURCES is not \"true\"" };
  }
  if (!commandLineFlag && envRequested) {
    return { keep: false, reason: "RETELL_SANDBOX_KEEP_RESOURCES is set but --keep-resources was not given on the command line" };
  }
  return { keep: false, reason: "resources are cleaned up by default" };
}

module.exports = {
  SANDBOX_CONFIG_VERSION,
  DEFAULTS,
  isSandboxEnabled,
  isSandboxExecuteEnabled,
  isKeepResourcesRequested,
  getSandboxConfig,
  evaluateSandboxGate,
  evaluateKeepResources,
};
