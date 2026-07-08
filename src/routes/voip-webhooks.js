// VoIP v2 Twilio webhooks (Phase 1c) — currently just /voip/dial-result,
// the INV-2 enforcement point (backend spec §5.5).
//
// Chain per route:
//   1. flag gate — while VOIP_V2_ENABLED != "true", next("route") falls out
//      of this router so the path 404s exactly as today (disabled-state
//      contract). A dial-result can only legitimately arrive if WE issued a
//      <Dial action> while the flag was on; edge case of flipping the flag
//      off mid-call is accepted and documented (in-flight calls get a Twilio
//      error; the §16 rollback is carrier-code based, not flag based).
//   2. twilioWebhook — the SAME X-Twilio-Signature validation as /inbound
//      and /recording. Mounted per-route so unimplemented /voip/* paths keep
//      their scaffold/404 behaviour instead of gaining a 403.
//   3. handler — thin: all branch logic lives in voip-dial.renderDialResult
//      (pure, INV-2-tested: completed → <Hangup/>; ANYTHING else → the
//      shared v1 voicemail TwiML; no third branch; no <Dial> ever).
//
// The handler must ALWAYS answer 200 with TwiML — a 5xx here means a real
// caller hears a Twilio error. DB updates are best-effort and logged.

const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;
const { isVoipV2Enabled } = require("../config/voip");
const { twilioWebhook } = require("../middleware/auth");
const { getClientByTwilioNumber } = require("../services/clients");
const { fetchGreetingUrl } = require("../services/voicemail-twiml");
const { renderDialResult } = require("../services/voip-dial");

function flagGate(req, res, next) {
  if (!isVoipV2Enabled()) return next("route"); // fall out → 404, as today
  next();
}

router.post("/dial-result", flagGate, twilioWebhook, async (req, res) => {
  const { CallSid, DialCallStatus, To } = req.body || {};
  const twiml = new VoiceResponse();

  // Resolve the client the same way /inbound/voice does (To = our Twilio
  // number on the parent call). Failure → null → generic default greeting;
  // never an error to the caller.
  let clientId = "default";
  try {
    const client = await getClientByTwilioNumber(To);
    if (client) clientId = client.slug;
  } catch (err) {
    console.error("⚠️  dial-result client resolution failed:", err.message);
  }

  let greetingUrl = null;
  if (DialCallStatus !== "completed") {
    greetingUrl = await fetchGreetingUrl(clientId); // never throws; null on failure
  }

  const { branch } = renderDialResult(twiml, { dialCallStatus: DialCallStatus, greetingUrl });
  console.log(`voip.dial.result call=${CallSid} status=${DialCallStatus} branch=${branch}`);

  // Respond FIRST-priority: the TwiML below is what the caller experiences.
  res.type("text/xml").send(twiml.toString());

  // Best-effort call-row bookkeeping after the response. The v2 columns
  // (answered_via/dial_status/answered_at) may not be provisioned yet
  // (phase1c_add_answered_via.sql) — failures are logged, never surfaced.
  // Tenant-scoped defence-in-depth: the update is keyed by call_sid AND the
  // client resolved from To (both derived the same way as at dial time), so
  // even a forged-but-signed request can't touch another tenant's row.
  // A zero-row match is logged — bookkeeping is best-effort by design.
  try {
    const supabase = require("../services/supabase");
    const update =
      branch === "completed"
        ? { dial_status: DialCallStatus, answered_via: "voip", answered_at: new Date().toISOString() }
        : { dial_status: DialCallStatus || null };
    const { data, error } = await supabase
      .from("calls")
      .update(update)
      .eq("call_sid", CallSid)
      .eq("client_id", clientId)
      .select("id");
    if (error) console.error("⚠️  dial-result calls update failed (columns provisioned?):", error.message);
    else if (!data || data.length === 0) console.warn(`⚠️  dial-result: no calls row matched ${CallSid}/${clientId} (ringing insert failed or client mismatch)`);
  } catch (err) {
    console.error("⚠️  dial-result bookkeeping failed:", err.message);
  }
});

module.exports = router;
