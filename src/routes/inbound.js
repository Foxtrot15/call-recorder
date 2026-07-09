const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;
const supabase = require("../services/supabase");
const { getClientByTwilioNumber } = require("../services/clients");
const { fetchLoopGuardData, checkOutboundDialTarget } = require("../services/loop-guard");
const { fetchGreetingUrl, appendVoicemailTwiml } = require("../services/voicemail-twiml");
const { evaluateVoipDelivery, appendClientDialTwiml } = require("../services/voip-dial");

router.post("/voice", async (req, res) => {
  const twiml = new VoiceResponse();
  const {
    CallSid,
    From,
    To,
    ForwardedFrom,
    Direction,
  } = req.body;

  // Resolve which client this call belongs to, based on the Twilio number
  // that was actually dialed — this works the same for both the missed-call
  // path and the outbound-bridge path, since To is always the Twilio number
  // on this first webhook either way.
  let client = await getClientByTwilioNumber(To);
  if (!client) {
    // No matching client row — this means a Twilio number is live and
    // receiving calls but isn't registered in the clients table. That's a
    // real misconfiguration, not a normal runtime condition, so it's
    // logged loudly. Falling back to 'default' rather than hanging up on
    // the caller — a possibly-misattributed call beats a dead line — but
    // this should never happen in practice once clients are set up
    // correctly, and seeing this log means something needs fixing.
    console.error(`🚨 No client found for Twilio number ${To} — falling back to 'default'. Check the clients table.`);
    client = {
      slug: "default",
      real_number: process.env.CLIENT_REAL_NUMBER,
      twilio_number: To,
    };
  }
  const CLIENT_ID = client.slug;

  const caller  = From;
  // Owner recognition normalises BOTH sides to E.164 before comparing, so a
  // format difference (Twilio sends From as +61.. E.164, while real_number may
  // be stored as 04.. local or with spaces) no longer breaks the bridge. This
  // is the durable fix for the strict `caller === client.real_number` that
  // regressed when real_number moved from the CLIENT_REAL_NUMBER env var to the
  // clients table. Call flow is unchanged: isYou still selects bridge vs voicemail.
  const normCaller = normaliseForMatch(caller);
  const normOwner  = normaliseForMatch(client.real_number);
  const isYou = normCaller !== null && normCaller === normOwner;

  // Near-miss diagnostic: fires only when the call was NOT recognised as the
  // owner yet the last 8 digits match — i.e. it's almost certainly the owner in
  // a format normaliseForMatch didn't reconcile. This stays silent for ordinary
  // callers (whose digits differ) and never logs a full number.
  if (!isYou) {
    const tail = (n) => (n ? String(n).replace(/\D/g, "").slice(-8) : "");
    if (tail(caller) && tail(caller) === tail(client.real_number)) {
      console.warn(
        `⚠️  Owner bridge not recognised despite matching trailing digits: ` +
        `From ${describeNumberSafely(caller)} vs real_number ${describeNumberSafely(client.real_number)} ` +
        `(client ${CLIENT_ID}) — check the number format in the clients table.`
      );
    }
  }

  if (isYou) {
    // ── OUTBOUND BRIDGE ──────────────────────────────────────
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
    return res.type("text/xml").send(twiml.toString());
  }

  // ── VOIP DELIVERY (Phase 1c, flag-gated — spec §6, INV-3) ──
  // Runs strictly AFTER the owner bridge (a CFU'd owner calling their own
  // Twilio number must reach the dial-out bridge, never their own app) and
  // strictly BEFORE the voicemail block. evaluateVoipDelivery never throws
  // and returns deliver:false unless VOIP_V2_ENABLED=true AND
  // clients.voip_enabled AND an active device exists — so on every
  // production deploy today this is one boolean check and nothing more.
  // Belt-and-braces: the whole delivery attempt is ALSO wrapped in
  // try/catch — any failure falls through to the unchanged v1 voicemail.
  try {
    const voip = await evaluateVoipDelivery(client, { callerNumber: From });
    if (voip.deliver) {
      console.log(`voip.dial.start client=${CLIENT_ID} record=${voip.record} call=${CallSid}`);
      // Same row shape as the v1 insert below; status 'ringing' marks the
      // app-delivery attempt. No v2-only columns here — the insert must
      // succeed even before phase1c_add_answered_via.sql is applied.
      // Insert failure is logged but does NOT abort delivery: ringing the
      // owner's app matters more than the bookkeeping row (the recording
      // pipeline upserts by call_sid later and repairs it).
      const { error: insertErr } = await supabase.from("calls").insert({
        call_sid:           CallSid,
        caller_number:      From,
        twilio_number:      To,
        client_real_number: ForwardedFrom || null,
        client_id:          CLIENT_ID,
        direction:          Direction || "inbound",
        status:             "ringing",
        started_at:         new Date().toISOString(),
      });
      if (insertErr) console.error(`⚠️  voip: ringing-row insert failed for ${CallSid}: ${insertErr.message}`);
      appendClientDialTwiml(twiml, { identity: voip.identity, record: voip.record });
      return res.type("text/xml").send(twiml.toString());
    }
  } catch (err) {
    console.error("⚠️  voip: delivery attempt failed — falling back to v1 voicemail:", err.message);
  }

  // ── MISSED CALL — with conditional call forwarding (**61*/**62*/**67*),
  // Twilio only ever receives calls the client didn't answer. There is no
  // live dial-through to the client's mobile, so every call reaching here
  // goes straight to Aida voicemail. (This also means the forwarding-loop
  // risk that existed with unconditional **21* forwarding cannot occur —
  // Twilio never dials the client's phone.)
  console.log(`📭 Missed call reaching Aida voicemail: ${caller}`);

  await supabase.from("calls").insert({
    call_sid:           CallSid,
    caller_number:      From,
    twilio_number:      To,
    client_real_number: ForwardedFrom || null,
    client_id:          CLIENT_ID,
    direction:          Direction || "inbound",
    status:             "in-progress",
    started_at:         new Date().toISOString(),
  });

  // Voicemail TwiML — extracted to services/voicemail-twiml.js (Phase 1c)
  // so /voip/dial-result's fallback renders the IDENTICAL flow. The helper
  // is byte-identical to the previous inline code (INV-3), pinned by
  // test/voip-phase1c.test.js.
  const greetingUrl = await fetchGreetingUrl(CLIENT_ID);
  appendVoicemailTwiml(twiml, { greetingUrl });

  res.type("text/xml").send(twiml.toString());
});

// After the voicemail recording finishes
router.post("/voicemail-complete", (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: "Polly.Amy", language: "en-AU" },
    "Thanks, your message has been received. Goodbye."
  );
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// Outbound: digits received, connect + record
router.post("/connect", async (req, res) => {
  const twiml = new VoiceResponse();
  const destination = req.body.Digits;
  if (!destination) {
    twiml.say("No number received. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  const e164 = normaliseAU(destination);

  // Only allow dialing Australian mobiles/landlines — blocks toll-fraud abuse
  // of this bridge via spoofed caller ID (defense-in-depth alongside Twilio's
  // Geo Permissions, which restrict this at the account level too).
  const AU_MOBILE_OR_LANDLINE = /^\+61[2378]\d{8}$|^\+614\d{8}$/;
  if (!AU_MOBILE_OR_LANDLINE.test(e164)) {
    console.log(`🚫 Blocked outbound dial to non-AU/invalid number: ${destination}`);
    twiml.say(
      { voice: "Polly.Amy", language: "en-AU" },
      "Sorry, only Australian numbers can be dialled. Goodbye."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // VoIP loop guard (INV-1, Phase 1a): refuse to bridge to any CFU'd
  // (voip_enabled) client's real number — the carrier would forward our own
  // PSTN leg back to /inbound/voice and loop. No-op while no client has
  // voip_enabled (today's entire fleet); on guard-data failure we fail closed
  // for safety-by-refusal is wrong HERE (it would break the working bridge on
  // a transient DB blip), so a fetch error is logged and treated as no-VoIP —
  // acceptable because CFU cutover and this guard ship together per runbook.
  try {
    const { voipClients } = await fetchLoopGuardData(null);
    const guard = checkOutboundDialTarget(e164, voipClients);
    if (guard.blocked) {
      console.error(`🚨 LOOP GUARD: refused bridge dial — ${guard.reason}`);
      twiml.say(
        { voice: "Polly.Amy", language: "en-AU" },
        "Sorry, that number can only be reached through the app. Goodbye."
      );
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }
  } catch (err) {
    console.error("⚠️  Loop-guard check failed (bridging anyway):", err.message);
  }

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
  if (digits.startsWith("04") && digits.length === 10) return "+61" + digits.slice(1); // mobile: 04xx xxx xxx
  if (digits.startsWith("0")  && digits.length === 10) return "+61" + digits.slice(1); // landline: 0[2378] xxxx xxxx
  if (digits.startsWith("61") && digits.length === 11) return "+" + digits;            // already has country code, no leading 0
  return "+" + digits; // malformed — will fail the AU_MOBILE_OR_LANDLINE check above, which is intentional
}

// Normalise a phone number to E.164 for owner-recognition comparison, or null
// if absent/empty. Reuses normaliseAU — idempotent on E.164 (+61.. → +61..),
// lifts local formats (04.. / spaced / no-+ → +61..) — so the owner is matched
// regardless of how real_number happens to be stored.
function normaliseForMatch(n) {
  if (!n) return null;
  return normaliseAU(String(n));
}

// Privacy-safe descriptor for diagnostic logs: reveals only the format shape
// (leading +, digit count, last 3 digits) — enough to spot a format mismatch,
// not enough to identify the caller. Never log the full number.
function describeNumberSafely(n) {
  if (!n) return "(empty)";
  const digits = String(n).replace(/\D/g, "");
  return `${String(n).trim().startsWith("+") ? "+" : ""}${digits.length}d…${digits.slice(-3)}`;
}

module.exports = router;
