// Startup configuration validation.
//
// Called once from server.js immediately after dotenv loads, BEFORE the app is
// built. It fails closed on missing security-critical config (with a clear,
// actionable message) instead of letting the server boot into a broken or
// insecure state and surface a confusing error later.
//
// - CRITICAL vars: the app refuses to start (exit 1) if any are missing/invalid.
// - RECOMMENDED vars: logged as warnings; the app still starts (these gate
//   specific features that already degrade gracefully at request time).
//
// This is intentionally pure + testable: `assessConfig(env)` has no side effects;
// `validateStartupConfig(env)` does the logging and the exit.

// Security-critical: without these the app is either non-functional or insecure.
const CRITICAL = [
  { name: "SUPABASE_URL", check: (v) => !!v, hint: "Supabase project URL" },
  { name: "SUPABASE_SERVICE_KEY", check: (v) => !!v, hint: "Supabase service-role key" },
  { name: "SESSION_SECRET", check: (v) => !!v, hint: "signs operator sessions and invite tokens" },
  {
    name: "ENCRYPTION_KEY",
    check: (v) => typeof v === "string" && v.length >= 32,
    hint: "must be >= 32 characters — encrypts stored OAuth tokens (fail-closed)",
  },
];

// Feature-gating: missing these breaks a specific feature that already returns a
// clear error at request time, so they warn rather than block startup.
const RECOMMENDED = [
  { name: "OPERATOR_CLIENT_ID", hint: "operator dashboard resolves its tenant from this (routes 500 without it)" },
  { name: "DASHBOARD_PASSWORD", hint: "operator login is disabled without it" },
  { name: "BASE_URL", hint: "Twilio callbacks + OAuth redirect" },
  { name: "ANTHROPIC_API_KEY", hint: "call analysis / drafts" },
  { name: "DEEPGRAM_API_KEY", hint: "transcription" },
  { name: "GOOGLE_CLIENT_ID", hint: "Gmail/Calendar OAuth" },
  { name: "GOOGLE_CLIENT_SECRET", hint: "Gmail/Calendar OAuth" },
  { name: "TWILIO_ACCOUNT_SID", hint: "telephony + webhook signature validation" },
  { name: "TWILIO_AUTH_TOKEN", hint: "telephony + webhook signature validation" },
  { name: "TWILIO_PHONE_NUMBER", hint: "outbound calls" },
];

// Pure assessment — no logging, no exit. Returns what's wrong.
function assessConfig(env = process.env) {
  const fatal = CRITICAL.filter((v) => !v.check(env[v.name])).map((v) => ({ name: v.name, hint: v.hint }));
  const warnings = RECOMMENDED.filter((v) => !env[v.name]).map((v) => ({ name: v.name, hint: v.hint }));
  return { fatal, warnings };
}

function validateStartupConfig(env = process.env) {
  const { fatal, warnings } = assessConfig(env);

  for (const w of warnings) {
    console.warn(`⚠️  Config: ${w.name} is not set — ${w.hint}`);
  }

  if (fatal.length > 0) {
    console.error("\n❌ Refusing to start — missing/invalid critical configuration:");
    for (const f of fatal) {
      console.error(`   • ${f.name}: ${f.hint}`);
    }
    console.error("\nSet these (see DEPLOYMENT.md) and restart.\n");
    process.exit(1);
  }

  console.log(`✅ Config check passed${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})` : ""}`);
}

module.exports = { validateStartupConfig, assessConfig, CRITICAL, RECOMMENDED };
