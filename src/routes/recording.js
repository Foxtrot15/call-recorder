const express = require("express");
const router = express.Router();
const transcribeAudio = require("../services/transcribe");
const sendSMS = require("../services/sms");
const supabase = require("../services/supabase");

router.post("/complete", async (req, res) => {
  res.sendStatus(200);

  const { RecordingUrl, RecordingSid, CallSid, RecordingDuration } = req.body;

  if (!RecordingUrl) {
    console.error("⚠️  No RecordingUrl in webhook payload");
    return;
  }

  console.log(`📼 Recording complete: ${RecordingSid} (${RecordingDuration}s)`);

  try {
    // Fetch call details from Twilio
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await client.calls(CallSid).fetch();
    const From = call.from;
    const To   = call.to;

    // Transcribe
    const audioUrl  = `${RecordingUrl}.mp3`;
    const transcript = await transcribeAudio(audioUrl);

    if (!transcript) {
      console.error("⚠️  Empty transcript returned");
      return;
    }

    const direction = From === process.env.CLIENT_REAL_NUMBER ? "outbound" : "inbound";

    // ── Save to Supabase ──────────────────────────────────────
    const { data, error } = await supabase.from("calls").insert({
      call_sid:     CallSid,
      recording_sid: RecordingSid,
      from_number:  From,
      to_number:    To,
      direction,
      duration:     parseInt(RecordingDuration, 10),
      transcript,
      status:       "new",
      recorded_at:  new Date().toISOString(),
    }).select().single();

    if (error) {
      console.error("❌ Supabase error:", error.message);
    } else {
      console.log(`💾 Call saved to database: ${data.id}`);
    }

    // ── Send WhatsApp ─────────────────────────────────────────
    const duration = formatDuration(RecordingDuration);
    const header   = `📞 ${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration})\nFrom: ${From}\nTo: ${To}\n\n`;
    const chunks   = chunkText(header + transcript, 1500);

    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
      await sendSMS(prefix + chunks[i]);
    }

    console.log(`✅ Transcript sent (${chunks.length} message)`);
  } catch (err) {
    console.error("❌ Pipeline error:", err.message);
  }
});

function formatDuration(seconds) {
  const s = parseInt(seconds, 10);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${s}s`;
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
