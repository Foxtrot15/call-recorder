const express = require("express");
const router = express.Router();
const multer = require("multer");
const supabase = require("../services/supabase");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /voicemail/upload — client records their greeting in the browser
router.post("/upload", upload.single("audio"), async (req, res) => {
  const clientId = req.body.clientId || "default";

  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  try {
    const fileName = `voicemail-${clientId}-${Date.now()}.webm`;

    const { data, error } = await supabase.storage
      .from("voicemail-greetings")
      .upload(fileName, req.file.buffer, {
        contentType: "audio/webm",
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

// GET /voicemail/status?clientId=default
router.get("/status", async (req, res) => {
  const clientId = req.query.clientId || "default";
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

module.exports = router;
