const express = require("express");
const router  = express.Router();
const analyseCall      = require("../services/analyse");
const sendNotification = require("../services/notify");
const supabase         = require("../services/supabase");
const {
  getOrCreateContact,
  getContactHistory,
  updateContactFromCall,
  buildContactContext,
} = require("../services/contacts");
const {
  getBusinessProfile,
  shouldUpdateProfile,
  generateBusinessProfile,
} = require("../services/business-profile");

// POST /test/inject
// Body: { transcript, from_number, direction, duration, clientId }
router.post("/inject", async (req, res) => {
  const {
    transcript,
    from_number = "+61400000000",
    direction   = "inbound",
    duration    = 60,
    clientId    = "default",
    skip_notify = false,
  } = req.body;

  if (!transcript) {
    return res.status(400).json({ error: "transcript is required" });
  }

  try {
    const From = from_number;
    const To   = process.env.CLIENT_REAL_NUMBER;

    // Load contact history
    let contactContext = null;
    let contact = null;
    try {
      contact = await getOrCreateContact(clientId, From);
      const history = await getContactHistory(clientId, From);
      if (history.length > 0) {
        contactContext = buildContactContext(contact, history);
      }
    } catch (err) {
      console.error("⚠️  Contact lookup failed:", err.message);
    }

    // Load business profile
    let businessProfile = null;
    try {
      businessProfile = await getBusinessProfile(clientId);
    } catch (err) {}

    // Analyse
    const analysis = await analyseCall(transcript, contactContext, businessProfile);
    console.log(`🤖 Test injection analysis complete`);

    // Save to calls table
    const { data, error } = await supabase
      .from("calls")
      .insert({
        call_sid:       `TEST-${Date.now()}`,
        from_number:    From,
        to_number:      To,
        direction,
        duration,
        transcript,
        analysis,
        caller_name:    analysis?.caller?.name    || null,
        caller_email:   analysis?.caller?.email   || null,
        caller_company: analysis?.caller?.company || null,
        intent:         analysis?.intent          || null,
        summary:        analysis?.summary         || null,
        crm_verified:   false,
        status:         "complete",
        recorded_at:    new Date().toISOString(),
        client_id:      clientId,
      })
      .select()
      .single();

    if (error) throw error;

    // Update contact profile
    await updateContactFromCall(clientId, From, analysis, new Date().toISOString());

    // Check if business profile needs update
    const needsUpdate = await shouldUpdateProfile(clientId);
    if (needsUpdate) {
      await generateBusinessProfile(clientId);
      console.log("🏢 Business profile updated");
    }

    // Send notification (optional)
    if (!skip_notify) {
      try {
        await sendNotification(clientId, {
          direction,
          duration:    `${Math.floor(duration/60)}m ${duration%60}s`,
          from:        analysis?.caller?.name || From,
          summary:     analysis?.summary || null,
          transcript,
          dashboardUrl: process.env.BASE_URL,
        });
      } catch (err) {
        console.error("⚠️  Notification failed:", err.message);
      }
    }

    res.json({
      success:  true,
      call_id:  data.id,
      analysis,
      contact_updated: true,
      business_profile_updated: needsUpdate,
    });

  } catch (err) {
    console.error("❌ Test injection error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /test/inject-batch
// Injects multiple calls at once
router.post("/inject-batch", async (req, res) => {
  const { calls, clientId = "default" } = req.body;
  if (!calls?.length) return res.status(400).json({ error: "calls array required" });

  const results = [];
  for (const call of calls) {
    try {
      const injRes = await fetch(`${process.env.BASE_URL}/test/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...call, clientId, skip_notify: true }),
      });
      const result = await injRes.json();
      results.push({ success: true, summary: result.analysis?.summary });
      // Small delay between calls
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      results.push({ success: false, error: err.message });
    }
  }

  res.json({ injected: results.length, results });
});

module.exports = router;
