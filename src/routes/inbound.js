const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

router.post("/voice", async (req, res) => {
  const twiml = new VoiceResponse();
  const {
    CallSid,
    From,
    To,
    ForwardedFrom,
    Direction,
  } = req.body;

  const caller  = From;
  const isYou   = caller === process.env.CLIENT_REAL_NUMBER;
  const CLIENT_ID = "default"; // per-client in future

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
    direction:          Direction || "inbound",
    status:             "in-progress",
    started_at:         new Date().toISOString(),
  });

  // Check for a custom recorded greeting
  let greetingUrl = null;
  try {
    const { data } = await supabase
      .from("client_settings")
      .select("voicemail_url")
      .eq("client_id", CLIENT_ID)
      .single();
    greetingUrl = data?.voicemail_url || null;
  } catch (err) {
    console.error("⚠️  Could not load custom greeting:", err.message);
  }

  if (greetingUrl) {
    twiml.play(greetingUrl);
  } else {
    const fallbackGreeting = process.env.VOICEMAIL_GREETING ||
      "Sorry, I can't get to the phone right now. Please leave a message with your name, number, and reason for calling, and I'll get back to you as soon as possible.";
    twiml.say({ voice: "Polly.Amy", language: "en-AU" }, fallbackGreeting);
  }

  twiml.record({
    maxLength: 180,           // auto-hangup safety net at 3 minutes
    playBeep: true,
    trim: "trim-silence",
    recordingStatusCallback: `${process.env.BASE_URL}/recording/complete`,
    recordingStatusCallbackMethod: "POST",
    action: `${process.env.BASE_URL}/inbound/voicemail-complete`,
    // No explicit finishOnKey — caller controls when they're done by hanging up.
    // Twilio's <Record> also ends automatically on ~4s of silence.
  });
  twiml.say(
    { voice: "Polly.Amy", language: "en-AU" },
    "Sorry, I didn't catch that. Goodbye."
  );

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
router.post("/connect", (req, res) => {
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

module.exports = router;
