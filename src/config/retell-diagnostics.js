// AIDA — Retell READ-ONLY diagnostics configuration (M7E).
//
// ─────────────────────────────────────────────────────────────────────
// A THIRD GATE, WEAKER THAN THE OTHER TWO, AND NARROWER THAN BOTH.
// ─────────────────────────────────────────────────────────────────────
//
// RETELL_LIVE_WRITES_ENABLED grants permission to CREATE and DELETE provider
// resources. RETELL_SANDBOX_EXECUTE grants permission to run the sandbox, which
// spends money. Reading one finished call back needs neither, and requiring
// them would be actively harmful: an engineer asking "why did that call drop?"
// would have to switch on the ability to create agents in order to answer it.
//
// So this gate authorises exactly one documented endpoint —
// GET /v2/get-call/{call_id} — and nothing else. There is no mutation method
// reachable from the diagnostics path at all; the absence is structural, not a
// flag check.
//
// WHAT IT ADDS THAT THE WRITE GATES DO NOT HAVE
// A finished call is a real conversation between real people. So production is
// refused outright, the tag must be "dev", and transcript CONTENT is a third,
// separate switch that stays off even when the other two are on.
//
// WHAT IT DELIBERATELY DOES NOT REQUIRE
//   RETELL_LIVE_WRITES_ENABLED   nothing is created, updated or deleted
//   RETELL_LIVE_CALLS_ENABLED    no call is placed
//   RETELL_SANDBOX_*             this is not the sandbox
//   RETELL_DRY_RUN=false         dry-run promises not to CHANGE anything, and a
//                                read keeps that promise already
//   a phone number, a webhook, recording, a database, an Anthropic key
//
// M7D LESSON, APPLIED HERE. The sandbox's gate tests originally spawned the
// script with a restricted environment. That worked only while the repository's
// .env was empty of Retell values; once the sandbox was genuinely configured —
// exactly when those tests mattered — the script loaded the real .env and a
// fail-closed test reported the gates OPEN. So the gate here is a PURE FUNCTION
// of an env object, tests assert it directly, and the script is a thin printer
// over it.
//
// Pure + dep-free: reads env, touches nothing, never returns a secret.

const { getRetellConfig, canReadDiagnostics } = require("./retell");

const DIAGNOSTICS_CONFIG_VERSION = "retell-diagnostics-config-2026-08-02";

function strictTrue(value) {
  return value === "true";
}

function positiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

const DEFAULTS = Object.freeze({
  // Polite. Retell publishes no polling guidance for analysis readiness, so
  // these are AIDA's choices, not provider requirements.
  analysisPollMs: 5000,
  analysisMaxWaitMs: 60000,
});

/**
 * A call id, checked for shape only.
 *
 * Deliberately permissive about the exact prefix — Retell's ids are opaque and
 * a format assumption here would reject a valid id for a cosmetic reason. What
 * it does refuse is empty, oversized, or anything with a path separator or
 * whitespace, since the value goes into a URL path.
 */
function validateCallId(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "no call id was given" };
  const value = raw.trim();
  if (!value) return { ok: false, reason: "the call id was empty" };
  if (value.length > 200) return { ok: false, reason: "the call id is implausibly long" };
  if (!/^[A-Za-z0-9_\-.]+$/.test(value)) return { ok: false, reason: "the call id contains characters an id does not have" };
  return { ok: true, callId: value };
}

function getDiagnosticsConfig(env = process.env) {
  const retell = getRetellConfig(env);
  return Object.freeze({
    diagnosticsConfigVersion: DIAGNOSTICS_CONFIG_VERSION,
    enabled: strictTrue(env.RETELL_DIAGNOSTICS_ENABLED),
    executeRequested: strictTrue(env.RETELL_DIAGNOSTICS_EXECUTE),
    includeContentRequested: strictTrue(env.RETELL_DIAGNOSTICS_INCLUDE_CONTENT),
    analysisPollMs: positiveInt(env.RETELL_DIAGNOSTICS_POLL_MS, DEFAULTS.analysisPollMs, { min: 1000, max: 60000 }),
    analysisMaxWaitMs: positiveInt(env.RETELL_DIAGNOSTICS_MAX_WAIT_MS, DEFAULTS.analysisMaxWaitMs, { min: 1000, max: 600000 }),
    // Presence only. The key is never carried on this object, so dumping the
    // config cannot print it.
    hasApiKey: Boolean(retell.apiKey),
    retellEnabled: retell.enabled,
    allowedTag: retell.allowedTag,
    liveWritesEnabled: retell.liveWritesEnabled,
    liveCallsEnabled: retell.liveCallsEnabled,
    nodeEnv: env.NODE_ENV || "development",
  });
}

/**
 * Every condition for a LIVE READ, evaluated together.
 *
 * Returns all blockers rather than the first, so someone configuring this gets
 * the whole list instead of discovering them one run at a time.
 */
function evaluateDiagnosticsGate(env = process.env, { callId = null } = {}) {
  const c = getDiagnosticsConfig(env);
  const capability = canReadDiagnostics(env);
  const blockers = [];

  if (c.nodeEnv === "production") blockers.push("NODE_ENV is production. Diagnostics never run in production.");
  if (!c.retellEnabled) blockers.push("RETELL_ENABLED is not \"true\".");
  if (!c.enabled) blockers.push("RETELL_DIAGNOSTICS_ENABLED is not \"true\".");
  if (!c.executeRequested) blockers.push("RETELL_DIAGNOSTICS_EXECUTE is not \"true\".");
  // Raw value, not the parsed one: getRetellConfig falls back to "dev" for an
  // unrecognised tag, so "production" would otherwise read as dev and satisfy
  // this. Unset means dev (the intended default); set-and-wrong is refused.
  if (env.RETELL_ALLOWED_TAG !== undefined && env.RETELL_ALLOWED_TAG !== "dev") {
    blockers.push(`RETELL_ALLOWED_TAG is "${String(env.RETELL_ALLOWED_TAG).slice(0, 30)}", not "dev".`);
  } else if (c.allowedTag !== "dev") {
    blockers.push(`RETELL_ALLOWED_TAG is "${c.allowedTag}", not "dev".`);
  }
  if (!c.hasApiKey) blockers.push("RETELL_API_KEY is not set.");

  // The call id is part of the gate, not a later validation step: a diagnostics
  // run with no target has nothing to read, and "list every call" is not an
  // option this tool offers.
  const id = validateCallId(callId);
  if (!id.ok) blockers.push(`No call to read — ${id.reason}. Pass --fetch-call "<call-id>".`);

  return {
    allowed: blockers.length === 0,
    blockers,
    config: c,
    callId: id.ok ? id.callId : null,
    // The adapter's own capability check, surfaced so the script can show that
    // the gate and the thing that actually enforces it agree. They are computed
    // independently on purpose; a disagreement is a bug worth seeing.
    capability,
    notRequired: Object.freeze([
      "RETELL_LIVE_WRITES_ENABLED — nothing is created, updated or deleted",
      "RETELL_LIVE_CALLS_ENABLED — no call is placed",
      "RETELL_DRY_RUN=false — a read changes nothing, so dry-run is already honoured",
      "RETELL_SANDBOX_* — this is not the sandbox and creates no resources",
      "RETELL_OUTBOUND_ONBOARDING_NUMBER / RETELL_INBOUND_DEMO_NUMBER — no number is used",
      "RETELL_WEBHOOK_BASE_URL — no webhook is configured or received",
      "RETELL_DEFAULT_VOICE_ID — no agent is created",
      "ANTHROPIC_API_KEY — reading a call needs no model key",
      "SUPABASE_* — nothing is read from or written to a database",
    ]),
  };
}

/**
 * May transcript CONTENT be shown?
 *
 * Requires BOTH the environment variable and an explicit command-line flag —
 * the same two-signal rule the sandbox uses for keeping paid resources alive,
 * for the same reason: an environment variable set once and forgotten must
 * never be why a customer's words appear on someone's screen.
 */
function evaluateContentDisclosure(env = process.env, { commandLineFlag = false } = {}) {
  const envRequested = strictTrue(env.RETELL_DIAGNOSTICS_INCLUDE_CONTENT);
  if ((env.NODE_ENV || "development") === "production") {
    return { include: false, reason: "transcript content is never shown in production" };
  }
  if (commandLineFlag && envRequested) {
    return { include: true, reason: "both RETELL_DIAGNOSTICS_INCLUDE_CONTENT and --include-content were given" };
  }
  if (commandLineFlag && !envRequested) {
    return { include: false, reason: "--include-content was given but RETELL_DIAGNOSTICS_INCLUDE_CONTENT is not \"true\"" };
  }
  if (!commandLineFlag && envRequested) {
    return { include: false, reason: "RETELL_DIAGNOSTICS_INCLUDE_CONTENT is set but --include-content was not given on the command line" };
  }
  return { include: false, reason: "transcript content is withheld by default" };
}

module.exports = {
  DIAGNOSTICS_CONFIG_VERSION,
  DEFAULTS,
  validateCallId,
  getDiagnosticsConfig,
  evaluateDiagnosticsGate,
  evaluateContentDisclosure,
};
