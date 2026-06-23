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
    const From          = call.from;
    const To            = call.to;
    const ForwardedFrom = call.forwardedFrom || null; // client's real mobile

    // ── Transcribe ────────────────────────────────────────────
    const audioUrl   = `${RecordingUrl}.mp3`;
    const transcript = await transcribeAudio(audioUrl);

    if (!transcript) {
      console.error("⚠️  Empty transcript returned");
      return;
    }

    const direction = From === process.env.CLIENT_REAL_NUMBER ? "outbound" : "inbound";

    // ── Analyse with Claude ───────────────────────────────────
    let analysis = null;
    try {
      analysis = await analyseCall(transcript);
      console.log(`🤖 Analysis complete for ${CallSid}`);
    } catch (err) {
      console.error("⚠️  Analysis failed (call still saved):", err.message);
    }

    // ── Upsert Supabase record ────────────────────────────────
    // Try update first (record created by inbound.js), fall back to insert
    const payload = {
      recording_sid:      RecordingSid,
      from_number:        From,
      to_number:          To,
      client_real_number: ForwardedFrom,
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
    const header   = `📞 ${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration})\nFrom: ${From}\nTo: ${To}\n\n`;
    const body     = analysis?.summary
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
