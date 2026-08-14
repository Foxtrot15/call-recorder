const express = require("express");
const router  = express.Router();
const twilio  = require("twilio");
const supabase = require("../services/supabase");
const { fetchLoopGuardData, decidePstnDial } = require("../services/loop-guard");

// ── WHY THE CLIENT IS BUILT LAZILY ──────────────────────────
// This used to be `const client = twilio(SID, TOKEN)` at module scope, and a
// deployment without Twilio credentials therefore died at IMPORT time with
// "username is required" — before `server.js` had finished mounting anything.
// One unconfigured integration took down every unrelated route with it,
// including the acquisition webhook, which never touches Twilio.
//
// Deferring construction to first use is the pattern this repository already
// follows for the same dependency: `routes/recording.js` builds its client
// inside the handler, and `middleware/auth.js` memoises `twilio.webhook()` on
// first request. Behaviour with credentials present is unchanged — the client
// is still built from the same two env vars and cached for the process.
//
// It returns null rather than a client when credentials are absent. There is
// deliberately no placeholder account sid, no empty-string token and no
// fallback: a Twilio client that exists but cannot authenticate would turn a
// configuration mistake into a runtime failure at the moment somebody tries to
// place a real call.
let _client = null;
function twilioClient() {
  if (_client) return _client;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  _client = twilio(accountSid, authToken);
  return _client;
}

router.post("/initiate", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Missing 'to' number" });

  // Fail closed before any work: no telephony configured means this deployment
  // cannot place calls, and says so rather than half-running the request.
  const client = twilioClient();
  if (!client) {
    return res.status(503).json({ error: "Telephony is not configured on this deployment." });
  }

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
