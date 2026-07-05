// Environment verification.
//
// Two distinct concerns, deliberately kept separate:
//
// 1. RUNNER — vars the smoke suite itself needs to do its job. Missing these
//    means the suite can't run properly; they hard-fail the preflight check.
//
// 2. SERVER — vars the deployed app needs. These are only visible here when the
//    suite runs WITH the server's environment (e.g. `railway run npm run smoke`
//    or a local `.env`). When smoke-testing a remote URL you generally DON'T
//    have them, so this list is informational: the authoritative server-side
//    checks are behavioral (e.g. OPERATOR_CLIENT_ID is proven set by an operator
//    route returning 200 instead of the "not configured" 500).

const RUNNER_REQUIRED = [
  { name: "DASHBOARD_PASSWORD", why: "operator login for authenticated checks" },
];

const RUNNER_OPTIONAL = [
  { name: "SMOKE_BASE_URL", why: "target instance URL (default http://localhost:3000)" },
  { name: "SMOKE_CLIENT_EMAIL", why: "enables the positive client-login check" },
  { name: "SMOKE_CLIENT_PASSWORD", why: "enables the positive client-login check" },
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

function checkEnv(env = process.env) {
  const missingRunner = RUNNER_REQUIRED.filter((v) => !env[v.name]).map((v) => v.name);
  const serverSet = SERVER_EXPECTED.map((v) => ({ ...v, set: Boolean(env[v.name]) }));
  const serverMissingCritical = serverSet.filter((v) => v.critical && !v.set).map((v) => v.name);
  const serverPresent = serverSet.some((v) => v.set); // did we run with server env at all?
  return { missingRunner, serverSet, serverMissingCritical, serverPresent };
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

  lines.push("\nServer (only visible when run with the server's env, e.g. `railway run`):");
  if (!result.serverPresent) {
    lines.push("  · none present — testing a remote URL; server env verified behaviorally instead.");
  } else {
    for (const v of result.serverSet) {
      const mark = v.set ? "✔" : v.critical ? "✖" : "·";
      lines.push(`  ${mark} ${v.name}${v.critical ? " (critical)" : ""}`);
    }
  }

  if (result.missingRunner.length) {
    lines.push(`\n✖ Missing runner-required: ${result.missingRunner.join(", ")}`);
  }
  if (result.serverPresent && result.serverMissingCritical.length) {
    lines.push(`✖ Missing critical server vars: ${result.serverMissingCritical.join(", ")}`);
  }
  lines.push("──────────────────────────────────────────────────────");
  return lines.join("\n");
}

module.exports = { checkEnv, formatReport, RUNNER_REQUIRED, RUNNER_OPTIONAL, SERVER_EXPECTED };
