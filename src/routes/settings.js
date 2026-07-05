const express = require("express");
const router = express.Router();
const supabase = require("../services/supabase");

// GET /settings/pipeline — clientId comes from the operator session (req.clientId)
router.get("/pipeline", async (req, res) => {
  const clientId = req.clientId;
  try {
    const { data } = await supabase
      .from("client_settings")
      .select("pipeline_enabled")
      .eq("client_id", clientId)
      .single();

    // Default to enabled if no row exists yet (matches column default)
    const enabled = data?.pipeline_enabled !== false;
    res.json({ enabled });
  } catch {
    res.json({ enabled: true });
  }
});

// POST /settings/pipeline  { enabled }
router.post("/pipeline", async (req, res) => {
  const clientId = req.clientId;
  const enabled = !!req.body.enabled;

  try {
    const { data: existing } = await supabase
      .from("client_settings")
      .select("id")
      .eq("client_id", clientId)
      .single();

    if (existing) {
      await supabase
        .from("client_settings")
        .update({ pipeline_enabled: enabled })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("client_settings")
        .insert({ client_id: clientId, pipeline_enabled: enabled });
    }

    console.log(`⚙️  Aida pipeline ${enabled ? "enabled" : "paused"} for ${clientId}`);
    res.json({ success: true, enabled });
  } catch (err) {
    console.error("⚠️  Failed to update pipeline setting:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
