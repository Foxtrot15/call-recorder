const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * INBOUND CALL HANDLER
 *
 * Flow:
 *   Caller → Twilio number → (record) → forward to CLIENT_REAL_NUMBER
 *
 * Twilio webhook: POST /inbound/voice
 * Set this as your Twilio number's "A call comes in" webhook.
 */
router.post("/voice", (req, res) => {
  const twiml = new VoiceResponse();
  const caller = req.body.From;
  const isYou  = caller === process.env.CLIENT_REAL_NUMBER;

  if (isYou) {
    // ── OUTBOUND BRIDGE ──────────────────────────────────────
    // You're calling your own Twilio number — prompt for destination
    const gather = twiml.gather({
      numDigits: 11,
      action: "/inbound/connect",
      method: "POST",
      timeout: 15,
      finishOnKey: "#",
    });

    gather.say(
      { voice: "Polly.Amy", language: "en-AU" },
      "Enter the number you want to call, then press hash."
    );

    twiml.say("No number entered. Goodbye.");
    twiml.hangup();

  } else {
    // ── INBOUND ──────────────────────────────────────────────
    // Someone else is calling — record and forward to your real number
    const dial = twiml.dial({
      callerId: caller,
      record: "record-from-answer-dual",
      recordingStatusCallback: `${process.env.BASE_URL}/recording/complete`,
      recordingStatusCallbackMethod: "POST",
      trim: "trim-silence",
    });

    dial.number(process.env.CLIENT_REAL_NUMBER);
  }

  res.type("text/xml").send(twiml.toString());
});

// Outbound: digits received, connect + record
router.post("/connect", (req, res) => {
  const twiml = new VoiceResponse();
  const destination = req.body.Digits;

  if (!destination) {
    twiml.say("No number received. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  const e164 = normaliseAU(destination);

  twiml.say(
    { voice: "Polly.Amy", language: "en-AU" },
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

function normaliseAU(number) {
  const digits = number.replace(/\D/g, "");
  if (digits.startsWith("04") && digits.length === 10) {
    return "+61" + digits.slice(1);
  }
  if (digits.startsWith("61")) return "+" + digits;
  if (digits.startsWith("+"))  return digits;
  return "+" + digits;
}

module.exports = router;
