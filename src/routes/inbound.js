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

  // Start recording the call (dual-channel captures both sides)
  twiml.record({
    recordingStatusCallback: `${process.env.BASE_URL}/recording/complete`,
    recordingStatusCallbackMethod: "POST",
    recordingStatusCallbackEvent: ["completed"],
    trim: "trim-silence",
    playBeep: false,   // silent recording — remove if you want a beep
  });

  // Forward to the client's real number
  const dial = twiml.dial({
    callerId: req.body.From,   // show original caller ID where possible
    record: "record-from-answer-dual",
    recordingStatusCallback: `${process.env.BASE_URL}/recording/complete`,
    recordingStatusCallbackMethod: "POST",
  });

  dial.number(process.env.CLIENT_REAL_NUMBER);

  res.type("text/xml").send(twiml.toString());
});

module.exports = router;
