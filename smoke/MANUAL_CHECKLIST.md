# Aida manual smoke checklist — Twilio & live calls

The automated suite (`npm run smoke`) covers auth, APIs, and DB connectivity. It
deliberately does **not** touch Twilio or place phone calls — those need a real
inbound call, carrier forwarding, and human ears. Run this checklist after the
automated suite passes green.

Reference for expected log lines and deeper diagnosis: `../TEST_PLAN.md` step 8.

## Prerequisites
- [ ] `npm run smoke` passed against the target instance.
- [ ] Railway deploy log shows `✅ Server listening on port ...`.
- [ ] The client under test has a `clients` row with the correct `twilio_number`.

## 1. Inbound missed call → voicemail → pipeline
- [ ] From a second phone, call the client's number and let it go unanswered so it
      forwards to the Twilio number.
- [ ] Leave a ~15s message that includes a name and a callback request.
- [ ] Watch Railway logs for, in order:
  - [ ] `📭 Missed call reaching Aida voicemail: +61...`
  - [ ] `📼 Recording complete: RE... (XXs)`
  - [ ] `🤖 Analysis complete for CA...`
  - [ ] `💾 Call saved: <uuid>`
  - [ ] `📧 Notification email sent to <operator gmail>`
- [ ] Call appears in the operator dashboard with transcript + summary.
- [ ] Notification email arrived.
- [ ] (If the message named an email/appointment) Gmail draft / Calendar event created.

## 2. Voicemail greeting playback
- [ ] The caller heard the client's recorded greeting (not the TTS fallback), if one is set.

## 3. Twilio signature validation
- [ ] In Twilio Console → Monitor → Debugger, no `11200`/`12300`/signature errors on the number.
- [ ] Confirm the number's Voice webhook is `POST <BASE_URL>/inbound/voice`.

## 4. Outbound bridge (only if used)
- [ ] Owner calls the Twilio bridge number, is prompted, dials a destination, call connects and records.
- [ ] Recording flows through the same pipeline (transcript + notification).

## 5. Tenant resolution sanity
- [ ] No `🚨 No client found for Twilio number +61...` in logs (would mean the
      `clients.twilio_number` doesn't exactly match the dialed number).

## Failure → where to look
- Nothing in logs at all → Twilio Debugger; webhook config / `BASE_URL`.
- Stops after `📼 Recording complete` → check `⚠️ Claim check failed`, Deepgram, or `❌ Pipeline error: <stage>`.
- Everything logs but no email → `⚠️ Notification email failed: ...` → see `../INCIDENT_RESPONSE.md` § Gmail.
