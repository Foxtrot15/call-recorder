const express = require("express");
const router  = express.Router();
const twilio  = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

router.post("/initiate", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' number" });

  try {
    const digits = to.replace(/\D/g, "");
    const e164 = digits.startsWith("04") ? "+61" + digits.slice(1) : "+" + digits;

    await client.calls.create({
      to:   process.env.CLIENT_REAL_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Say voice="Polly.Amy" language="en-AU">Connecting your recorded call now.</Say><Dial record="record-from-answer-dual" recordingStatusCallback="${process.env.BASE_URL}/recording/complete" recordingStatusCallbackMethod="POST"><Number>${e164}</Number></Dial></Response>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Initiate call error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
