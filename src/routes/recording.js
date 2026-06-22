const express = require("express");
const router = express.Router();
const transcribeAudio = require("../services/transcribe");
const sendSMS = require("../services/sms");

/**
 * RECORDING COMPLETE WEBHOOK
 *
 * Fired by Twilio when a recording finishes processing.
 * Picks up the recording URL, transcribes it, then SMS's
 * the transcript to TRANSCRIPT_RECIPIENT_NUMBER.
 *
 * Twilio webhook: POST /recording/complete
 */
router.post("/complete", async (req, res) => {
  // Acknowledge Twilio immediately (must respond < 15s)
  res.sendStatus(200);

  const {
    RecordingUrl,
    RecordingSid,
    CallSid,
    RecordingDuration,
  } = req.body;

  if (!RecordingUrl) {
    console.error("⚠️  No RecordingUrl in webhook payload");
    return;
  }

  console.log(`📼 Recording complete: ${RecordingSid} (${RecordingDuration}s)`);

  try {
    // Fetch call details to get From/To
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await client.calls(CallSid).fetch();
    const From = call.from;
    const To   = call.to;

    // Deepgram needs the .mp3 version — Twilio appends format
    const audioUrl = `${RecordingUrl}.mp3`;

    const transcript = await transcribeAudio(audioUrl);

    if (!transcript) {
      console.error("⚠️  Empty transcript returned");
      return;
    }

    // Build the SMS payload
    const direction = isOutbound(From) ? "Outbound" : "Inbound";
    const duration  = formatDuration(RecordingDuration);
    const header    = `📞 ${direction} call (${duration})\nFrom: ${From}\nTo: ${To}\n\n`;

    // Split into chunks — SMS limit is 1600 chars per Twilio segment group
    const chunks = chunkText(header + transcript, 1500);

    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
      await sendSMS(prefix + chunks[i]);
    }

    console.log(`✅ Transcript sent (${chunks.length} SMS)`);
  } catch (err) {
    console.error("❌ Pipeline error:", err.message);
  }
});

// ─── Helpers ──────────────────────────────────────────────
function isOutbound(from) {
  // If the call came from the client's real number it's outbound
  return from === process.env.CLIENT_REAL_NUMBER;
}

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
