// Environment verification.
//
// Two distinct concerns, deliberately kept separate:
//
// 1. RUNNER — vars the smoke suite itself needs to do its job. Missing these
//    means the suite can't run properly; they hard-fail the preflight check.
//
// 2. SERVER — vars the deployed app needs. These are only meaningful when the
//    suite runs WITH the server's environment. Whether that's the case is
//    decided EXPLICITLY (see serverEnvDecision), not by guessing from which
//    vars happen to be set — so a stray var in a dev shell can't trigger a
//    false "missing critical server var" against a remote target. When testing
//    a remote URL, server env is skipped and verified behaviorally instead
//    (e.g. OPERATOR_CLIENT_ID is proven set by an operator route returning 200
//    instead of the "not configured" 500).

const config = require("../config");

const RUNNER_REQUIRED = [
  { name: "DASHBOARD_PASSWORD", why: "operator login for authenticated checks" },
];

const RUNNER_OPTIONAL = [
  { name: "SMOKE_BASE_URL", why: "target instance URL (default http://localhost:3000)" },
  { name: "SMOKE_CLIENT_EMAIL", why: "enables the positive client-login check" },
  { name: "SMOKE_CLIENT_PASSWORD", why: "enables the positive client-login check" },
  { name: "SMOKE_CHECK_SERVER_ENV", why: "force server-env checks on/off (default: auto)" },
];

const SERVER_EXPECTED = [
  { name: "SUPABASE_URL", critical: true },
  { name: "SUPABASE_SERVICE_KEY", critical: true },
  { name: "SESSION_SECRET", critical: true },
  { name: "OPERATOR_CLIENT_ID", critical: true },
  { name: "DASHBOARD_PASSWORD", critical: true },
  { name: "ENCRYPTION_KEY", critical: true },
  { name: "BASE_URL", critical: false },
  { name: "ANTHROPIC_API_KEY", critical: false },
  { name: "DEEPGRAM_API_KEY", critical: false },
  { name: "GOOGLE_CLIENT_ID", critical: false },
  { name: "GOOGLE_CLIENT_SECRET", critical: false },
  { name: "TWILIO_ACCOUNT_SID", critical: false },
  { name: "TWILIO_AUTH_TOKEN", critical: false },
  { name: "TWILIO_PHONE_NUMBER", critical: false },
  { name: "CLIENT_REAL_NUMBER", critical: false },
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isLocalTarget(baseUrl) {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

// Railway injects these into the process when you use `railway run ...`, so
// their presence means the deployed service's env is actually available here.
function railwayEnvPresent(env) {
  return Boolean(
    env.RAILWAY_ENVIRONMENT ||
      env.RAILWAY_ENVIRONMENT_NAME ||
      env.RAILWAY_PROJECT_ID ||
      env.RAILWAY_SERVICE_ID
  );
}

// Decide whether server-side env vars should be checked at all.
// Explicit override wins; otherwise check only when the server's env is
// genuinely present here (local target or Railway-injected). Remote target
// with no override → skip (checked behaviorally by the HTTP suite instead).
function serverEnvDecision(baseUrl = config.baseUrl, env = process.env) {
  const override = env.SMOKE_CHECK_SERVER_ENV;
  if (override != null && override !== "") {
    const on = /^(1|true|yes|on)$/i.test(override);
    return { check: on, reason: `forced ${on ? "on" : "off"} via SMOKE_CHECK_SERVER_ENV` };
  }
  if (isLocalTarget(baseUrl)) return { check: true, reason: "local target" };
  if (railwayEnvPresent(env)) return { check: true, reason: "Railway environment detected" };
  return { check: false, reason: "remote target — server env not present here" };
}

function checkEnv({ baseUrl = config.baseUrl, env = process.env } = {}) {
  const missingRunner = RUNNER_REQUIRED.filter((v) => !env[v.name]).map((v) => v.name);

  const decision = serverEnvDecision(baseUrl, env);
  const serverSet = SERVER_EXPECTED.map((v) => ({ ...v, set: Boolean(env[v.name]) }));
  const serverMissingCritical = decision.check
    ? serverSet.filter((v) => v.critical && !v.set).map((v) => v.name)
    : [];

  return {
    missingRunner,
    serverChecked: decision.check,
    serverDecisionReason: decision.reason,
    serverSet,
    serverMissingCritical,
  };
}

function formatReport(result = checkEnv()) {
  const lines = [];
  lines.push("── Environment preflight ─────────────────────────────");

  lines.push("\nRunner (needed by the smoke suite):");
  for (const v of RUNNER_REQUIRED) {
    lines.push(`  ${process.env[v.name] ? "✔" : "✖"} ${v.name} — ${v.why}`);
  }
  for (const v of RUNNER_OPTIONAL) {
    lines.push(`  ${process.env[v.name] ? "✔" : "·"} ${v.name} — ${v.why}`);
  }

  lines.push(`\nServer env checks: ${result.serverChecked ? "ON" : "SKIPPED"} — ${result.serverDecisionReason}`);
  if (result.serverChecked) {
    for (const v of result.serverSet) {
      const mark = v.set ? "✔" : v.critical ? "✖" : "·";
      lines.push(`  ${mark} ${v.name}${v.critical ? " (critical)" : ""}`);
    }
  }

  if (result.missingRunner.length) {
    lines.push(`\n✖ Missing runner-required: ${result.missingRunner.join(", ")}`);
  }
  if (result.serverChecked && result.serverMissingCritical.length) {
    lines.push(`✖ Missing critical server vars: ${result.serverMissingCritical.join(", ")}`);
  }
  lines.push("──────────────────────────────────────────────────────");
  return lines.join("\n");
}

module.exports = {
  checkEnv,
  formatReport,
  serverEnvDecision,
  RUNNER_REQUIRED,
  RUNNER_OPTIONAL,
  SERVER_EXPECTED,
};
