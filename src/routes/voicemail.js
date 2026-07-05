const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const supabase = require("../services/supabase");

ffmpeg.setFfmpegPath(require("@ffmpeg-installer/ffmpeg").path);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Converts a webm audio buffer to an mp3 buffer via temp files (fluent-ffmpeg
// needs real file paths, not streams, for reliable format detection).
function convertWebmToMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmpId = crypto.randomBytes(8).toString("hex");
    const inputPath = path.join(os.tmpdir(), `vm-in-${tmpId}.webm`);
    const outputPath = path.join(os.tmpdir(), `vm-out-${tmpId}.mp3`);

    const cleanup = () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    };

    fs.writeFile(inputPath, inputBuffer, (writeErr) => {
      if (writeErr) return reject(writeErr);

      ffmpeg(inputPath)
        .audioCodec("libmp3lame")
        .audioBitrate("64k")
        .format("mp3")
        .on("error", (err) => {
          cleanup();
          reject(err);
        })
        .on("end", () => {
          fs.readFile(outputPath, (readErr, mp3Buffer) => {
            cleanup();
            if (readErr) return reject(readErr);
            resolve(mp3Buffer);
          });
        })
        .save(outputPath);
    });
  });
}

// POST /voicemail/upload — client records their greeting in the browser (webm),
// converted server-side to mp3 before storage (Twilio's <Play> doesn't support webm).
router.post("/upload", upload.single("audio"), async (req, res) => {
  const clientId = req.clientId;

  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  try {
    console.log(`🎙️ Converting greeting to mp3 for ${clientId}...`);
    const mp3Buffer = await convertWebmToMp3(req.file.buffer);

    const fileName = `voicemail-${clientId}-${Date.now()}.mp3`;

    const { data, error } = await supabase.storage
      .from("voicemail-greetings")
      .upload(fileName, mp3Buffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (error) throw error;

    const { data: urlData } = supabase.storage
      .from("voicemail-greetings")
      .getPublicUrl(fileName);

    // Store reference in client settings
    const { data: existing } = await supabase
      .from("client_settings")
      .select("id")
      .eq("client_id", clientId)
      .single();

    const payload = {
      client_id: clientId,
      voicemail_url: urlData.publicUrl,
      voicemail_updated_at: new Date().toISOString(),
    };

    if (existing) {
      await supabase.from("client_settings").update(payload).eq("id", existing.id);
    } else {
      await supabase.from("client_settings").insert(payload);
    }

    console.log(`🎙️ Voicemail greeting saved for ${clientId}: ${urlData.publicUrl}`);
    res.json({ success: true, url: urlData.publicUrl });

  } catch (err) {
    console.error("⚠️  Voicemail upload failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /voicemail/status — clientId comes from the operator session (req.clientId)
router.get("/status", async (req, res) => {
  const clientId = req.clientId;
  try {
    const { data } = await supabase
      .from("client_settings")
      .select("voicemail_url")
      .eq("client_id", clientId)
      .single();

    res.json({
      hasGreeting: !!data?.voicemail_url,
      url: data?.voicemail_url || null,
    });
  } catch {
    res.json({ hasGreeting: false, url: null });
  }
});

// POST /voicemail/delete — remove the saved greeting, falls back to TTS
router.post("/delete", async (req, res) => {
  const clientId = req.clientId;

  try {
    await supabase
      .from("client_settings")
      .update({ voicemail_url: null, voicemail_updated_at: new Date().toISOString() })
      .eq("client_id", clientId);

    console.log(`🗑️  Voicemail greeting cleared for ${clientId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("⚠️  Voicemail delete failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
