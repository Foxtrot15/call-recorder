const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * OUTBOUND BRIDGE HANDLER
 *
 * Flow:
 *   Client dials Twilio bridge number
 *   → Twilio prompts: "Enter the number you want to call, followed by hash"
 *   → Client enters destination
 *   → Twilio connects + records the call
 *   → Recording webhook fires on completion
 *
 * Twilio webhook: POST /outbound/voice
 * Set this as a SEPARATE Twilio number's "A call comes in" webhook,
 * or use the same number with a menu — your choice.
 *
 * TIP: Save the Twilio bridge number in the client's phone as
 * "📞 Bridge" so they just tap it before dialling any number.
 */

// Step 1 — Client calls the bridge number
router.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    numDigits: 11,           // UK mobile = 11 digits. Adjust for your market.
    action: "/outbound/connect",
    method: "POST",
    timeout: 15,
    finishOnKey: "#",
  });

  gather.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "Enter the number you want to call, then press hash."
  );

  // If no input received
  twiml.say("No number entered. Goodbye.");
  twiml.hangup();

  res.type("text/xml").send(twiml.toString());
});

// Step 2 — Digits received, connect + record
router.post("/connect", (req, res) => {
  const twiml = new VoiceResponse();
  const destination = req.body.Digits;

  if (!destination) {
    twiml.say("No number received. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Normalise to E.164 for UK numbers (07xxx → +447xxx)
  const e164 = normaliseUK(destination);

  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    "Connecting your call now."
  );

  const dial = twiml.dial({
    record: "record-from-answer-dual",
    recordingStatusCallback: `${process.env.BASE_URL}/recording/complete`,
    recordingStatusCallbackMethod: "POST",
    trim: "trim-silence",
  });

  dial.number(e164);

  res.type("text/xml").send(twiml.toString());
});

// ─── Helpers ──────────────────────────────────────────────
function normaliseUK(number) {
  const digits = number.replace(/\D/g, "");
  if (digits.startsWith("07") && digits.length === 11) {
    return "+44" + digits.slice(1);
  }
  if (digits.startsWith("44")) return "+" + digits;
  if (digits.startsWith("+")) return digits;
  return "+" + digits; // fallback
}

module.exports = router;
