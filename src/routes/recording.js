const express = require("express");
const router = express.Router();
const transcribeAudio  = require("../services/transcribe");
const analyseCall      = require("../services/analyse");
const sendNotification = require("../services/notify");
const supabase         = require("../services/supabase");
const { draftFollowUpEmail, maybeCreateCalendarEvent } = require("../services/followup");
const { deriveCallMode } = require("../services/prompts");
const { isPersonalCall } = require("../services/personal-filter");
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

  // Idempotency claim — only the first delivery of this recording proceeds.
  // Blocks duplicate Twilio webhook retries and replayed/forged requests.
  const { data: claimed, error: claimErr } = await supabase
    .rpc("claim_recording", { p_call_sid: CallSid, p_recording_sid: RecordingSid });
  if (claimErr) {
    console.error("⚠️  Claim check failed:", claimErr.message);
    return;
  }
  if (!claimed) {
    console.log(`↩️  Duplicate/late recording callback ignored: ${RecordingSid}`);
    return;
  }

  // Persist the recording URL immediately so a crashed pipeline is recoverable later
  await supabase.from("calls")
    .update({ recording_url: RecordingUrl })
    .eq("call_sid", CallSid);

  console.log(`📼 Recording complete: ${RecordingSid} (${RecordingDuration}s)`);

  try {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await client.calls(CallSid).fetch();

    const { data: existingRecord } = await supabase
      .from("calls")
      .select("direction, from_number, to_number, client_id, caller_number, twilio_number, client_real_number")
      .eq("call_sid", CallSid)
      .single();

    // client_id was resolved and stamped onto the calls row by /voice at
    // the moment the call came in. Falling back to 'default' only covers
    // rows created before this column existed — any new call should
    // always have a real value here.
    const CLIENT_ID = existingRecord?.client_id || "default";
    // NOTE: existingRecord.client_real_number actually stores Twilio's
    // ForwardedFrom header (unreliable across AU carriers, per earlier
    // testing) — not the client's real number. Kept on the env var here
    // deliberately; giving this its own proper per-client lookup is part
    // of the fuller pipeline thread-through pass, not this one.
    const CLIENT_REAL = process.env.CLIENT_REAL_NUMBER;

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

    // ── Pipeline pause check — if Aida is switched off in the dashboard,
    // skip transcription/analysis/drafts/calendar/notification entirely
    // (saves Deepgram + Claude cost, not just the email). The call is
    // still logged so nothing is silently lost, and the raw recording
    // stays available via recording_url if you want to review it later.
    if (direction === "inbound") {
      let pipelineEnabled = true;
      try {
        const { data: settings } = await supabase
          .from("client_settings")
          .select("pipeline_enabled")
          .eq("client_id", CLIENT_ID)
          .single();
        pipelineEnabled = settings?.pipeline_enabled !== false;
      } catch (err) {
        console.error("⚠️  Pipeline setting lookup failed, defaulting to enabled:", err.message);
      }
      if (!pipelineEnabled) {
        console.log(`⏸️  Aida paused — logging call without processing: ${From}`);
        const { error: pausedErr } = await supabase
          .from("calls")
          .upsert({
            call_sid:      CallSid,
            recording_sid: RecordingSid,
            from_number:   From,
            to_number:     To,
            direction,
            duration:      parseInt(RecordingDuration, 10),
            summary:       "Aida was paused when this call came in — not transcribed or processed.",
            crm_verified:  false,
            status:        "new",
            recorded_at:   new Date().toISOString(),
          }, { onConflict: "call_sid" });
        if (pausedErr) console.error("⚠️  Failed to save paused call:", pausedErr.message);
        return;
      }
    }

    // ── Transcribe ────────────────────────────────────────────
    const audioUrl   = `${RecordingUrl}.mp3`;
    const transcript = await transcribeAudio(audioUrl);

    if (!transcript) {
      console.error("⚠️  Empty transcript returned");
      return;
    }

    // ── Personal call check — log it, but skip AI analysis, drafts,
    // calendar, and notification. Now that every missed call reaches Aida
    // voicemail (conditional forwarding), this stops family/friends'
    // messages from generating business follow-up emails.
    if (direction === "inbound") {
      let isPersonal = false;
      try {
        isPersonal = await isPersonalCall(CLIENT_ID, From);
      } catch (err) {
        console.error("⚠️  Personal contact check failed:", err.message);
      }
      if (isPersonal) {
        console.log(`👪 Personal contact — logging only, skipping automation: ${From}`);
        const { error: personalErr } = await supabase
          .from("calls")
          .upsert({
            call_sid:      CallSid,
            recording_sid: RecordingSid,
            from_number:   From,
            to_number:     To,
            direction,
            duration:      parseInt(RecordingDuration, 10),
            transcript,
            intent:        "personal",
            crm_verified:  true,
            status:        "complete",
            recorded_at:   new Date().toISOString(),
          }, { onConflict: "call_sid" });
        if (personalErr) console.error("⚠️  Failed to save personal call:", personalErr.message);
        return;
      }
    }

    // ── Load contact history for context ─────────────────────
    let contactContext = null;
    let contact = null;
    try {
      if (direction === "inbound") {
        contact = await getOrCreateContact(CLIENT_ID, From);
        const history = await getContactHistory(CLIENT_ID, From);
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
      businessProfile = await getBusinessProfile(CLIENT_ID);
    } catch (err) {
      console.error("⚠️  Business profile lookup failed:", err.message);
    }

    // ── Analyse with Claude (with contact context) ────────────
    // Mode matters: inbound recordings are VOICEMAILS (no conversation
    // happened); only the operator bridge (outbound) is an answered call.
    const callMode = deriveCallMode({ direction });
    let analysis = null;
    try {
      analysis = await analyseCall(transcript, contactContext, businessProfile, callMode);
      console.log(`🤖 Analysis complete for ${CallSid} (${callMode})`);
    } catch (err) {
      console.error("⚠️  Analysis failed (call still saved):", err.message);
    }

    // ── Update contact profile ────────────────────────────────
    try {
      if (direction === "inbound" && analysis) {
        await updateContactFromCall(CLIENT_ID, From, analysis, new Date().toISOString());
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

    const { data, error } = await supabase
      .from("calls")
      .upsert({ call_sid: CallSid, ...payload }, { onConflict: "call_sid" })
      .select()
      .single();
    if (error) throw error;
    const savedId = data.id;

    console.log(`💾 Call saved: ${savedId}`);

    // ── Update business profile if needed ────────────────────
    try {
      const needsUpdate = await shouldUpdateProfile(CLIENT_ID);
      if (needsUpdate) {
        await generateBusinessProfile(CLIENT_ID);
      }
    } catch (err) {
      console.error("⚠️  Business profile update failed:", err.message);
    }

    // ── Gmail draft + Calendar event ─────────────────────────
    // Single implementation in services/followup.js: mode-aware grounded
    // prompt → draft-guard validation → safe fallback if the model
    // fabricated. Calendar events require a concrete transcript-extracted
    // date (never invent appointments).
    try {
      if (analysis && direction === "inbound") {
        const draftRes = await draftFollowUpEmail(CLIENT_ID, {
          mode: callMode,
          transcript,
          analysis,
          isReturning: contactContext !== null,
        });
        if (draftRes.created) {
          console.log(`📧 Draft created${draftRes.guarded ? " (guard rejected LLM draft — safe fallback used)" : ""}`);
        } else {
          console.log(`📧 No draft: ${draftRes.reason}`);
        }

        const calRes = await maybeCreateCalendarEvent(CLIENT_ID, { analysis, fromNumber: From });
        if (calRes.created) console.log("📅 Calendar event created");
      }
    } catch (err) {
      console.error("⚠️  Gmail/Calendar automation failed:", err.message);
    }

    // ── Send notification email ───────────────────────────────
    try {
      const duration = formatDuration(RecordingDuration);
      const contactDisplay = direction === "outbound"
        ? (analysis?.caller?.name || To)
        : (analysis?.caller?.name || From);

      await sendNotification(CLIENT_ID, {
        direction,
        duration,
        from:        contactDisplay,
        summary:     analysis?.summary || null,
        transcript,
        dashboardUrl: process.env.BASE_URL,
      });

      console.log("✅ Notification sent");
    } catch (err) {
      console.error("⚠️  Notification failed (call still saved):", err.message);
    }

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
