# Aida — Pilot Client Onboarding Runbook (manual)

_How to onboard pilot client #1 with the codebase as of `1cdeaaa`. Everything
here is manual/operator-driven by design — there is no onboarding UI yet._

## ⚠️ Read this first: the OPERATOR_CLIENT_ID fork

The operator dashboard (settings, voicemail recording, Google connect, pipeline
toggle) manages **exactly one tenant**: whatever `OPERATOR_CLIENT_ID` points at.
The client dashboard (`/client-dashboard.html`) only shows contacts. So for
pilot client #1, decide up front:

**Option A — the pilot client IS this deployment's tenant (recommended for pilot #1).**
Treat the deployment as single-tenant for them: run the backfill
(`supabase/sql/phase5_backfill_default.sql`) if you want history under their
slug — or skip history — and set `OPERATOR_CLIENT_ID=<their-slug>` in Railway.
You (operator) use the operator dashboard on their behalf; they use the client
dashboard. Simple, no workarounds.

**Option B — keep `default` as your own tenant, add the pilot as a second slug.**
Their calls pipeline works fine (tenant is resolved from the Twilio number),
BUT they have no way to get a Google connection, voicemail greeting, or
pipeline setting — those are operator-dashboard functions keyed to
`OPERATOR_CLIENT_ID`. Workaround: temporarily flip `OPERATOR_CLIENT_ID` to
their slug, do steps 5–6 below through the operator dashboard, flip it back.
Ugly but functional; each flip restarts the service. A real multi-tenant
operator UI is future work (out of Phase 5 scope).

## Step 1 — Twilio number

1. Buy an AU number in the Twilio console (Phone Numbers → Buy — voice-capable).
2. Configure it: Voice → "A call comes in" → **Webhook**,
   `https://<BASE_URL>/inbound/voice`, **HTTP POST**.
3. Verify Geo Permissions allow AU dialing only (toll-fraud posture — the code
   also enforces AU-only in `/inbound/connect`).
4. Note the number in E.164 (`+61...`) — it must match the DB row exactly;
   tenant resolution is a string equality on `twilio_number`.

## Step 2 — clients table row

Run in Supabase SQL Editor (adjust values):

```sql
insert into public.clients (slug, name, twilio_number, real_number, timezone, pipeline_enabled)
values ('pilot-plumbing', 'Pilot Plumbing Pty Ltd', '+61XXXXXXXXX', '+61YYYYYYYYY', 'Australia/Melbourne', true);
```

Slug rules: kebab-case, **no dots** (invite tokens use `.` as a delimiter and
creation will refuse dotted slugs), never `default`.

Without this row, calls to the number still work but land under the `'default'`
fallback with the loud log `🚨 No client found for Twilio number ...` — that log
appearing after onboarding means the number in the row doesn't match exactly.

## Step 3 — client dashboard login (invite + signup)

There is no signup page; use the browser console + curl.

1. **Mint the invite** — while logged into the operator dashboard, open DevTools
   console on that page (same origin attaches the session cookie) and run:
   ```js
   fetch('/client-auth/invite', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ clientId: 'pilot-plumbing' })
   }).then(r => r.json()).then(console.log)
   ```
   Copy the `token` from the response. Valid 72h, single effective use.
2. **Create their login** (their email, a password you agree on or they choose):
   ```bash
   curl -X POST https://<app>/client-auth/signup \
     -H "Content-Type: application/json" \
     -d '{"token":"<TOKEN>","email":"owner@pilotplumbing.com.au","password":"<STRONG-PW>"}'
   ```
   Expect `{"success":true,...}`. Errors are explicit: no such slug / already
   linked / invalid token.
3. **Verify:** they (or you) log in at `https://<app>/client-dashboard.html`.
   Note: sessions currently last ~1 hour before re-login (known, Phase 5 item 5).

## Step 4 — pipeline test before going live

From the operator dashboard session, inject a fake call for their slug:
```js
fetch('/test/inject', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientId: 'pilot-plumbing',
    transcript: 'Speaker 0: Hi, it\'s Sarah, I need a quote for a hot water system, my number is 0400 111 222.',
    skip_notify: true, skip_drafts: true
  })
}).then(r => r.json()).then(console.log)
```
Expect `success:true` with an analysis object; the contact then appears in
their client dashboard.

## Step 5 — Google connect (Gmail drafts, Calendar, notification email)

Requires `OPERATOR_CLIENT_ID=<their-slug>` (see the fork above). In the
operator dashboard: Connections → Connect Google → complete OAuth **signed
into the client's Google account** (drafts/events/notifications land in
whichever account consents). Confirm the card shows connected with their email.

## Step 6 — voicemail greeting

Same requirement as step 5. Operator dashboard → voicemail card → record the
greeting (their voice ideally — record on a call with them, or have them do it
at your screen). Fallback if skipped: the `VOICEMAIL_GREETING` env text via TTS.

## Step 7 — call forwarding on the client's mobile

The model is **conditional** forwarding — Twilio only receives calls they
don't answer (missed/busy/unreachable). Have them dial, on their handset:

| Dial | Forwards when |
|---|---|
| `**61*<TWILIO_NUMBER>#` | unanswered |
| `**62*<TWILIO_NUMBER>#` | unreachable/off |
| `**67*<TWILIO_NUMBER>#` | busy |

To cancel later: `##61#`, `##62#`, `##67#` (or `##002#` cancels all).
Do **not** use `*21*` (unconditional) — every call would bypass their phone.
Carrier note: these GSM codes work on Telstra/Optus/Vodafone; some MVNOs need
forwarding enabled via their app first.

## Step 8 — go-live verification

1. Ring their mobile from another phone; don't answer.
2. Confirm the greeting plays (their recorded one, not TTS), leave a message.
3. Watch logs for the step-8 sequence in TEST_PLAN.md.
4. Confirm: call in operator dashboard, notification email in their inbox,
   contact visible in their client dashboard.
5. Save the Twilio number in their phone as "Aida" so they recognise it.

## Offboarding (if the pilot ends)

Client dials the `##`-codes to cancel forwarding → release or repoint the
Twilio number → optionally null out `clients.auth_user_id` to disable their
login → their data stays in place under their slug.
