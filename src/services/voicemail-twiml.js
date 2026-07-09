// Shared voicemail TwiML (Phase 1c — the INV-3 seam).
//
// Extracted VERBATIM from routes/inbound.js /voice so that BOTH consumers
// render the identical voicemail flow:
//   * v1: /inbound/voice missed-call path (every production call today)
//   * v2: /voip/dial-result fallback branch (INV-2: every failed app
//     delivery terminates here — never a redial)
//
// INV-3 CONTRACT: appendVoicemailTwiml must produce byte-identical TwiML to
// the pre-1c inline code for non-VoIP clients. The op sequence and every
// attribute below are FROZEN and pinned by test/voip-phase1c.test.js — do
// not "improve" them without updating that test and re-verifying against a
// real Twilio call.
//
// Split: fetchGreetingUrl does the DB lookup (lazy supabase, error → null,
// same log line as before); appendVoicemailTwiml is pure (works on any
// object with play/say/record methods), so the frozen contract is provable
// in unit tests without the twilio lib.

const DEFAULT_GREETING =
  "Sorry, I can't get to the phone right now. Please leave a message with your name, number, and reason for calling, and I'll get back to you as soon as possible.";

async function fetchGreetingUrl(clientId) {
  try {
    const supabase = require("./supabase"); // lazy — keeps this module test-loadable
    const { data } = await supabase
      .from("client_settings")
      .select("voicemail_url")
      .eq("client_id", clientId)
      .single();
    return data?.voicemail_url || null;
  } catch (err) {
    console.error("⚠️  Could not load custom greeting:", err.message);
    return null;
  }
}

function appendVoicemailTwiml(twiml, { greetingUrl = null, env = process.env } = {}) {
  if (greetingUrl) {
    twiml.play(greetingUrl);
  } else {
    const fallbackGreeting = env.VOICEMAIL_GREETING || DEFAULT_GREETING;
    twiml.say({ voice: "Polly.Amy", language: "en-AU" }, fallbackGreeting);
  }

  twiml.record({
    maxLength: 180,           // auto-hangup safety net at 3 minutes
    playBeep: true,
    trim: "trim-silence",
    recordingStatusCallback: `${env.BASE_URL}/recording/complete`,
    recordingStatusCallbackMethod: "POST",
    action: `${env.BASE_URL}/inbound/voicemail-complete`,
    // No explicit finishOnKey — caller controls when they're done by hanging up.
    // Twilio's <Record> also ends automatically on ~4s of silence.
  });
  twiml.say(
    { voice: "Polly.Amy", language: "en-AU" },
    "Sorry, I didn't catch that. Goodbye."
  );
}

module.exports = { fetchGreetingUrl, appendVoicemailTwiml, DEFAULT_GREETING };
