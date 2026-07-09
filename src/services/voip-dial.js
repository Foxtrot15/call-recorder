// VoIP delivery decision + <Dial><Client> TwiML (Phase 1c, spec §6 / §5.5).
//
// THE PRODUCTION-SAFETY CONTRACT (INV-3):
//   evaluateVoipDelivery must return { deliver: false } unless every gate
//   passes, and must NEVER throw. Any DB/device/guard failure, missing
//   column, missing table, or unexpected state degrades to "not deliverable"
//   — the caller then takes the untouched v1 voicemail path. A customer call
//   can be lost to voicemail unnecessarily; it can never be lost to a 500.
//
// With VOIP_V2_ENABLED unset/false (every production deploy), the server
// flag is checked FIRST and nothing else runs: zero extra DB queries per
// inbound call.

const { isVoipV2Enabled } = require("../config/voip");
const { clientIdentity } = require("./voip-identity");

// Pure decision — the full gate table, unit-tested.
function decideVoipDelivery({ serverEnabled, clientVoipEnabled, activeDeviceCount, isPersonal }) {
  const deliver =
    serverEnabled === true &&
    clientVoipEnabled === true &&
    Number.isFinite(activeDeviceCount) &&
    activeDeviceCount > 0;
  // Personal contacts still get the call delivered — but WITHOUT the record
  // attribute, so no recording/transcript ever exists (spec §12: strictly
  // better privacy than v1).
  return { deliver, record: !isPersonal };
}

// FROZEN dial contract (spec §11 step TwiML; pinned by tests):
//   answerOnBridge keeps real ringback playing until the app answers;
//   timeout 20s then <Dial action> fires; action is the INV-2 enforcement
//   point; the child is ALWAYS <Client> — never <Number> (the whole point:
//   an IP leg cannot be caught by carrier forwarding, so no loop is possible
//   by construction).
function appendClientDialTwiml(twiml, { identity, record = true, env = process.env }) {
  const attrs = {
    answerOnBridge: true,
    timeout: 20,
    action: "/voip/dial-result",
    method: "POST",
  };
  if (record) {
    attrs.record = "record-from-answer-dual";
    attrs.recordingStatusCallback = `${env.BASE_URL}/recording/complete`;
    attrs.recordingStatusCallbackMethod = "POST";
  }
  const dial = twiml.dial(attrs);
  dial.client(identity);
}

// INV-2: the /voip/dial-result response has EXACTLY two shapes.
//   completed        → <Hangup/> (call is over; recording flows through the
//                      unchanged pipeline via recordingStatusCallback)
//   anything else    → the SHARED v1 voicemail TwiML — greeting, <Record>,
//                      closing <Say>. No third branch. No <Dial> may ever
//                      appear here (never a PSTN redial).
function renderDialResult(twiml, { dialCallStatus, greetingUrl = null, env = process.env }) {
  if (dialCallStatus === "completed") {
    twiml.hangup();
    return { branch: "completed" };
  }
  const { appendVoicemailTwiml } = require("./voicemail-twiml");
  appendVoicemailTwiml(twiml, { greetingUrl, env });
  return { branch: "voicemail" };
}

// Default dependency loaders (lazy so this module stays test-loadable).
function defaultDeps() {
  const devices = require("./devices");
  const { isPersonalCall } = require("./personal-filter");
  return {
    enabled: () => isVoipV2Enabled(),
    isClientVoipEnabled: devices.isClientVoipEnabled,   // 42703-safe → false
    countActiveDevices: devices.countActiveDevices,     // 42P01-safe → 0
    isPersonalCall,                                     // throws on failure — caught below
  };
}

/**
 * Decide whether THIS inbound call should be delivered to the app.
 * Never throws (see contract above). Deps injectable for tests.
 * @returns { deliver, record, identity }
 */
async function evaluateVoipDelivery(client, { callerNumber } = {}, deps = defaultDeps()) {
  try {
    // Gate 1 (free): server kill switch. Production today exits here —
    // no DB work is ever added to the live inbound path.
    if (!deps.enabled()) return { deliver: false };

    // Gate 2: per-client flag (D7), 42703-safe.
    if (!(await deps.isClientVoipEnabled(client.slug))) return { deliver: false };

    // Gate 3: at least one active device to ring.
    const activeDeviceCount = await deps.countActiveDevices(client.slug);

    // Personal-contact pre-check: failure means "treat as not personal"
    // (same convention as the recording pipeline) — recording a personal
    // call is the lesser harm vs dropping delivery entirely.
    let isPersonal = false;
    try {
      isPersonal = await deps.isPersonalCall(client.slug, callerNumber);
    } catch (err) {
      console.error("⚠️  voip: personal-contact check failed (treating as not personal):", err.message);
    }

    const decision = decideVoipDelivery({
      serverEnabled: true,
      clientVoipEnabled: true,
      activeDeviceCount,
      isPersonal,
    });
    if (!decision.deliver) return { deliver: false };

    return { deliver: true, record: decision.record, identity: clientIdentity(client.slug) };
  } catch (err) {
    // INV-3: any unexpected failure = v1 voicemail, loudly.
    console.error("⚠️  voip: delivery evaluation failed — falling back to v1 voicemail:", err.message);
    return { deliver: false };
  }
}

module.exports = {
  decideVoipDelivery,
  appendClientDialTwiml,
  renderDialResult,
  evaluateVoipDelivery,
};
