const express = require("express");
const router  = express.Router();
const twilio  = require("twilio");
const supabase = require("../services/supabase");
const { fetchLoopGuardData, decidePstnDial } = require("../services/loop-guard");

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

    // ── VoIP loop guard (INV-1, Phase 1a) ─────────────────────
    // This endpoint places PSTN calls to BOTH the owner's real number and
    // the destination. If either belongs to a CFU'd (voip_enabled) client,
    // the carrier forwards our own call straight back to /inbound/voice and
    // it loops — so the dial is refused outright. Also D10/P2-5: the owner's
    // number is sourced from the clients row (req.clientId from the operator
    // session), with the legacy env var only as a logged fallback.
    const guardData = await fetchLoopGuardData(req.clientId);
    const verdict = decidePstnDial({
      clientRow:     guardData.clientRow,
      voipClients:   guardData.voipClients,
      destination:   e164,
      envRealNumber: process.env.CLIENT_REAL_NUMBER,
    });
    if (verdict.blocked) {
      console.error(`🚨 LOOP GUARD: refused PSTN dial — ${verdict.reason}`);
      return res.status(409).json({
        error: "Call refused: this number is served by the VoIP app — a regular phone call to it would loop.",
        detail: verdict.reason,
      });
    }
    if (!verdict.ownerNumber) {
      return res.status(500).json({ error: "No owner number configured (clients.real_number / CLIENT_REAL_NUMBER)" });
    }
    const ownerNumber = verdict.ownerNumber;

    const call = await client.calls.create({
      to:   ownerNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response>
        <Say voice="Polly.Amy" language="en-AU">Connecting your recorded call now.</Say>
        <Dial record="record-from-answer-dual"
              recordingStatusCallback="${process.env.BASE_URL}/recording/complete"
              recordingStatusCallbackMethod="POST">
          <Number>${e164}</Number>
        </Dial>
      </Response>`,
    });

    // ── Store call record immediately with destination number ──
    await supabase.from("calls").insert({
      call_sid:           call.sid,
      from_number:        ownerNumber,
      to_number:          e164,
      client_real_number: ownerNumber,
      direction:          "outbound",
      status:             "in-progress",
      started_at:         new Date().toISOString(),
    });

    console.log(`📞 Outbound call initiated: ${ownerNumber} → ${e164} (${call.sid}) [owner number: ${verdict.ownerNumberSource}]`);
    res.json({ success: true });

  } catch (err) {
    console.error("❌ Initiate call error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
