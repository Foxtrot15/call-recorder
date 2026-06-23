const express = require("express");
const router = express.Router();
const transcribeAudio = require("../services/transcribe");
const analyseCall     = require("../services/analyse");
const sendSMS         = require("../services/sms");
const supabase        = require("../services/supabase");

router.post("/complete", async (req, res) => {
  res.sendStatus(200);
  const { RecordingUrl, RecordingSid, CallSid, RecordingDuration } = req.body;

  if (!RecordingUrl) {
    console.error("⚠️  No RecordingUrl in webhook payload");
    return;
  }

  console.log(`📼 Recording complete: ${RecordingSid} (${RecordingDuration}s)`);

  try {
    // ── Fetch call details from Twilio ────────────────────────
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await client.calls(CallSid).fetch();

    const TWILIO_NUMBER     = process.env.TWILIO_NUMBER || process.env.CLIENT_TWILIO_NUMBER;
    const CLIENT_REAL       = process.env.CLIENT_REAL_NUMBER;

    // Debug — log raw call data
    console.log(`🔍 Raw: from=${call.from} to=${call.to} dir=${call.direction} fwd=${call.forwardedFrom}`);
    console.log(`🔍 Env: TWILIO_NUMBER=${TWILIO_NUMBER} CLIENT_REAL=${CLIENT_REAL}`);

    let From, To, direction;

    // Detect outbound: Twilio is the From (child leg dialling out)
    if (call.from === TWILIO_NUMBER || call.from?.replace(/\s/g,'') === TWILIO_NUMBER) {
      // Outbound call — from is client's real number, to is the person they called
      From      = CLIENT_REAL;
      To        = call.to;
      direction = "outbound";
    } else if (call.to === CLIENT_REAL || call.forwardedFrom) {
      // Inbound — someone called the Twilio number, got forwarded to client
      From      = call.from;
      To        = CLIENT_REAL;
      direction = "inbound";
    } else {
      // Fallback
      From      = call.from;
      To        = call.to;
      direction = call.direction?.includes("outbound") ? "outbound" : "inbound";
    }

    console.log(`📞 ${direction}: ${From} → ${To}`);

    // ── Transcribe ────────────────────────────────────────────
    const audioUrl   = `${RecordingUrl}.mp3`;
    const transcript = await transcribeAudio(audioUrl);

    if (!transcript) {
      console.error("⚠️  Empty transcript returned");
      return;
    }

    // ── Analyse with Claude ───────────────────────────────────
    let analysis = null;
    try {
      analysis = await analyseCall(transcript);
      console.log(`🤖 Analysis complete for ${CallSid}`);
    } catch (err) {
      console.error("⚠️  Analysis failed (call still saved):", err.message);
    }

    // ── Upsert Supabase record ────────────────────────────────
    const payload = {
      recording_sid:      RecordingSid,
      from_number:        From,
      to_number:          To,
      client_real_number: CLIENT_REAL,
      direction,
      duration:           parseInt(RecordingDuration, 10),
      transcript,
      analysis:           analysis || null,
      caller_name:        analysis?.caller?.name    || null,
      caller_email:       analysis?.caller?.email   || null,
      caller_company:     analysis?.caller?.company || null,
      intent:             analysis?.intent          || null,
      summary:            analysis?.summary         || null,
      crm_verified:       false,
      status:             "complete",
      recorded_at:        new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("calls")
      .select("id")
      .eq("call_sid", CallSid)
      .single();

    let savedId;
    if (existing) {
      const { data, error } = await supabase
        .from("calls")
        .update(payload)
        .eq("call_sid", CallSid)
        .select()
        .single();
      if (error) throw error;
      savedId = data.id;
    } else {
      const { data, error } = await supabase
        .from("calls")
        .insert({ call_sid: CallSid, ...payload })
        .select()
        .single();
      if (error) throw error;
      savedId = data.id;
    }

    console.log(`💾 Call saved: ${savedId}`);

    // ── Send WhatsApp ─────────────────────────────────────────
    const duration = formatDuration(RecordingDuration);
    const contactLabel = direction === "outbound"
      ? `To: ${To}`
      : `From: ${From}`;

    const header = `📞 ${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration})\n${contactLabel}\n\n`;
    const body   = analysis?.summary
      ? `${header}Summary: ${analysis.summary}\n\n${transcript}`
      : header + transcript;

    const chunks = chunkText(body, 1500);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
      await sendSMS(prefix + chunks[i]);
    }

    console.log(`✅ Transcript sent (${chunks.length} message(s))`);

  } catch (err) {
    console.error("❌ Pipeline error:", err.message);
    await supabase
      .from("calls")
      .update({ status: "error" })
      .eq("call_sid", CallSid);
  }
});

function formatDuration(seconds) {
  const s = parseInt(seconds, 10);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function chunkText(text, maxLen) {
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    chunks.push(text.slice(pos, pos + maxLen));
    pos += maxLen;
  }
  return chunks;
}

module.exports = router;
