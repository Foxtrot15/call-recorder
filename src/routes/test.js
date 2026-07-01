const axios = require("axios");
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
const { createDraft }  = require("../services/gmail");
const { createEvent }  = require("../services/gcal");
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
    skip_drafts = false,
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

    // ── Gmail draft + Calendar event ─────────────────────────
    try {
      if (!skip_drafts && analysis && direction === "inbound") {
        const callerName  = analysis.caller?.name  || From;
        const callerEmail = analysis.caller?.email || null;
        const intent      = analysis.intent        || "general_enquiry";
        const summary     = analysis.summary       || "Call received";
        const action      = analysis.action        || "";
        const isReturning = contactContext !== null;

        if (callerEmail) {
          const firstName = callerName.split(" ")[0];

          // Build a natural follow-up email using Claude
          const emailRes = await axios.post(
            "https://api.anthropic.com/v1/messages",
            {
              model: "claude-haiku-4-5-20251001",
              max_tokens: 400,
              system: `You are writing a follow-up email on behalf of a small business owner to a client they just spoke with on the phone.
Write a SHORT, natural, professional email directly to the client.
- Address them by first name
- Refer to specifics from the call (dates, prices, what was agreed)
- Write in first person as if you are the business owner
- Do NOT summarise the call in third person
- Do NOT say "as discussed" more than once
- Keep it to 3-5 sentences max
- End with a warm sign-off
- No subject line, just the email body`,
              messages: [{
                role: "user",
                content: `Write a follow-up email to ${firstName} based on this call summary: ${summary}\n\nKey facts from call: ${JSON.stringify(analysis.facts || {})}\n\nNext action: ${action || "follow up"}`,
              }],
            },
            {
              headers: {
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
              },
            }
          );

          const emailBody = emailRes.data?.content?.[0]?.text?.trim() || 
            `Hi ${firstName},\n\nGreat speaking with you today. ${action || "I'll be in touch shortly."}\n\nKind regards`;

          const subject = isReturning 
            ? `Following up — ${callerName}` 
            : `Great speaking with you today, ${firstName}`;

          await createDraft(clientId, { to: callerEmail, subject, body: emailBody });
          console.log("📧 Draft created for " + callerEmail);
        }

        // Fire calendar for meetings, appointments, site visits, consultations
        const needsCalendar = intent === "schedule_meeting" || 
          (analysis.follow_up?.type === "meeting") ||
          (analysis.facts?.appointment_date || analysis.facts?.visit_date || analysis.facts?.meeting_date || analysis.facts?.consultation_date);
          
        if (needsCalendar && (analysis.follow_up?.detail || analysis.action)) {
          const eventDetail = analysis.follow_up?.detail || analysis.action || summary;
          const desc = summary + "\n\nContact: " + From + (callerEmail ? " | " + callerEmail : "") + "\n\n" + eventDetail;
          await createEvent(clientId, {
            title:         `${callerName} — ${intent === "schedule_meeting" ? "Meeting" : "Appointment"}`,
            description:   desc,
            attendeeEmail: callerEmail || null,
          });
          console.log("📅 Calendar event created for " + callerName);
        }
      }
    } catch (err) {
      console.error("⚠️  Gmail/Calendar failed:", err.message);
    }

    // ── Send notification email ───────────────────────────────
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
