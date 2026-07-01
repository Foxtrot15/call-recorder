const axios = require("axios");
const express = require("express");
const router = express.Router();
const transcribeAudio  = require("../services/transcribe");
const analyseCall      = require("../services/analyse");
const sendNotification = require("../services/notify");
const supabase         = require("../services/supabase");
const { createDraft }  = require("../services/gmail");
const { createEvent }  = require("../services/gcal");
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

router.post("/complete", async (req, res) => {
  res.sendStatus(200);
  const { RecordingUrl, RecordingSid, CallSid, RecordingDuration } = req.body;

  if (!RecordingUrl) {
    console.error("⚠️  No RecordingUrl in webhook payload");
    return;
  }

  console.log(`📼 Recording complete: ${RecordingSid} (${RecordingDuration}s)`);

  try {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await client.calls(CallSid).fetch();

    const CLIENT_REAL = process.env.CLIENT_REAL_NUMBER;
    const GOOGLE_CLIENT_ID = "default";

    const { data: existingRecord } = await supabase
      .from("calls")
      .select("direction, from_number, to_number")
      .eq("call_sid", CallSid)
      .single();

    let From, To, direction;

    if (existingRecord && existingRecord.direction === "outbound") {
      From      = existingRecord.from_number;
      To        = existingRecord.to_number;
      direction = "outbound";
    } else {
      From      = call.from;
      To        = CLIENT_REAL;
      direction = "inbound";
    }

    console.log(`📞 ${direction}: ${From} → ${To}`);

    // ── Transcribe ────────────────────────────────────────────
    const audioUrl   = `${RecordingUrl}.mp3`;
    const transcript = await transcribeAudio(audioUrl);

    if (!transcript) {
      console.error("⚠️  Empty transcript returned");
      return;
    }

    // ── Load contact history for context ─────────────────────
    let contactContext = null;
    let contact = null;
    try {
      if (direction === "inbound") {
        contact = await getOrCreateContact(GOOGLE_CLIENT_ID, From);
        const history = await getContactHistory(GOOGLE_CLIENT_ID, From);
        if (history.length > 0) {
          contactContext = buildContactContext(contact, history);
          console.log(`👤 Found ${history.length} previous calls from ${From}`);
        }
      }
    } catch (err) {
      console.error("⚠️  Contact history lookup failed:", err.message);
    }

    // ── Load business profile ────────────────────────────────
    let businessProfile = null;
    try {
      businessProfile = await getBusinessProfile(GOOGLE_CLIENT_ID);
    } catch (err) {
      console.error("⚠️  Business profile lookup failed:", err.message);
    }

    // ── Analyse with Claude (with contact context) ────────────
    let analysis = null;
    try {
      analysis = await analyseCall(transcript, contactContext, businessProfile);
      console.log(`🤖 Analysis complete for ${CallSid}`);
    } catch (err) {
      console.error("⚠️  Analysis failed (call still saved):", err.message);
    }

    // ── Update contact profile ────────────────────────────────
    try {
      if (direction === "inbound" && analysis) {
        await updateContactFromCall(GOOGLE_CLIENT_ID, From, analysis, new Date().toISOString());
        console.log(`👤 Contact profile updated for ${From}`);
      }
    } catch (err) {
      console.error("⚠️  Contact update failed:", err.message);
    }

    // ── Upsert Supabase call record ───────────────────────────
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

    // ── Update business profile if needed ────────────────────
    try {
      const needsUpdate = await shouldUpdateProfile(GOOGLE_CLIENT_ID);
      if (needsUpdate) {
        await generateBusinessProfile(GOOGLE_CLIENT_ID);
      }
    } catch (err) {
      console.error("⚠️  Business profile update failed:", err.message);
    }

    // ── Gmail draft + Calendar event ─────────────────────────
    try {
      if (analysis && direction === "inbound") {
        const callerName  = analysis.caller?.name  || From;
        const callerEmail = analysis.caller?.email || null;
        const intent      = analysis.intent        || "general_enquiry";
        const summary     = analysis.summary       || "Call received";
        const action      = analysis.action        || "";

        if (callerEmail) {
          const firstName = callerName.split(" ")[0];
          const isReturning = contactContext !== null;

          // Generate a natural email written TO the client
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
- Keep it to 3-5 sentences max
- End with a warm sign-off
- No subject line, just the email body`,
              messages: [{
                role: "user",
                content: `Write a follow-up email to ${firstName} based on this call summary: ${summary}\n\nKey facts: ${JSON.stringify(analysis.facts || {})}\n\nNext action: ${action || "follow up"}${isReturning ? "\n\nNote: This is a returning client." : ""}`,
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

          await createDraft(GOOGLE_CLIENT_ID, { to: callerEmail, subject, body: emailBody });
          console.log("📧 Draft created for " + callerEmail);
        }

        const needsCalendar = intent === "schedule_meeting" ||
          analysis.follow_up?.type === "meeting" ||
          (analysis.facts?.appointment_date || analysis.facts?.visit_date || analysis.facts?.meeting_date);

        if (needsCalendar && (analysis.follow_up?.detail || analysis.action)) {
          const eventDetail = analysis.follow_up?.detail || analysis.action || summary;
          const desc = summary + "\n\nContact: " + From + (callerEmail ? " | " + callerEmail : "") + "\n\n" + eventDetail;
          await createEvent(GOOGLE_CLIENT_ID, {
            title:         callerName + " — Appointment",
            description:   desc,
            attendeeEmail: callerEmail || null,
          });
          console.log("📅 Calendar event created for " + callerName);
        }
      }
    } catch (err) {
      console.error("⚠️  Gmail/Calendar automation failed:", err.message);
    }

    // ── Send notification email ───────────────────────────────
    const duration = formatDuration(RecordingDuration);
    const contactDisplay = direction === "outbound"
      ? (analysis?.caller?.name || To)
      : (analysis?.caller?.name || From);

    await sendNotification(GOOGLE_CLIENT_ID, {
      direction,
      duration,
      from:        contactDisplay,
      summary:     analysis?.summary || null,
      transcript,
      dashboardUrl: process.env.BASE_URL,
    });

    console.log("✅ Notification sent");

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

module.exports = router;
