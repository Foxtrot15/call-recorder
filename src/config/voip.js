// VoIP v2 feature flag + config assessment (Phase 0 scaffold).
//
// This is the ONE place that decides whether VoIP v2 is enabled server-wide
// (decision D7 in docs/VOIP_V2_IMPLEMENTATION_PLAN.md). No route or service
// re-implements the flag parse. The flag is deliberately strict: only the
// exact string "true" enables — "1", "yes", "TRUE" etc. do NOT, so the
// feature cannot be switched on by a sloppy env value.
//
// While disabled (the default, and the only production state until Phase 1
// ships), everything here is inert: no validation, no warnings, no log noise.
// While enabled, the VoIP secrets are validated fail-closed at startup
// (decision D9 — same pattern as ENCRYPTION_KEY in startup-check.js).
//
// Pure + testable: nothing in this module touches the network or process
// state; see test/voip-config.test.js.

function isVoipV2Enabled(env = process.env) {
  return env.VOIP_V2_ENABLED === "true";
}

// Vars required the moment the server-wide flag is on (see
// docs/VOIP_V2_BACKEND_SPEC.md §4). Access Tokens are signed with an API key,
// never the account auth token.
const REQUIRED_WHEN_ENABLED = [
  { name: "TWILIO_API_KEY_SID", hint: "signs Twilio Access Tokens (VoIP v2)" },
  { name: "TWILIO_API_KEY_SECRET", hint: "signs Twilio Access Tokens (VoIP v2)" },
];

// At least one push credential is needed for any device to ring; a missing
// SID for the not-yet-shipped platform is only a warning.
const PUSH_CREDENTIALS = [
  { name: "TWILIO_APNS_PUSH_CREDENTIAL_SID", platform: "ios" },
  { name: "TWILIO_FCM_PUSH_CREDENTIAL_SID", platform: "android" },
];

// Pure assessment, mirroring startup-check's { fatal, warnings } shape so the
// two merge cleanly. When the flag is off this returns empty lists — VoIP
// must be invisible in the logs of non-VoIP deploys.
function assessVoipConfig(env = process.env) {
  if (!isVoipV2Enabled(env)) {
    return { enabled: false, fatal: [], warnings: [] };
  }

  const fatal = REQUIRED_WHEN_ENABLED.filter((v) => !env[v.name]).map((v) => ({
    name: v.name,
    hint: v.hint,
  }));

  const missingPush = PUSH_CREDENTIALS.filter((v) => !env[v.name]);
  const warnings = [];
  if (missingPush.length === PUSH_CREDENTIALS.length) {
    // No push credential at all: no device on any platform can ever ring.
    fatal.push({
      name: "TWILIO_*_PUSH_CREDENTIAL_SID",
      hint: "VOIP_V2_ENABLED=true but no push credential SID is set (APNS or FCM) — no device could ring",
    });
  } else {
    for (const v of missingPush) {
      warnings.push({
        name: v.name,
        hint: `${v.platform} devices cannot ring without it (fine if that platform hasn't shipped)`,
      });
    }
  }

  return { enabled: true, fatal, warnings };
}

module.exports = { isVoipV2Enabled, assessVoipConfig, REQUIRED_WHEN_ENABLED, PUSH_CREDENTIALS };
