# Aida — Manual Smoke Test Plan

_For commit `1cdeaaa`+. Run top to bottom; each step gates the next. All server
logs referenced are in Railway → service → Deployments → View logs._

## Step 0 — Boot check

**Do:** Watch the deploy log after Railway builds.
**Expect:** `✅ Server listening on port ...` and nothing else alarming.
**If it fails:** A crash at boot is almost certainly a missing env var —
`services/supabase.js` throws if `SUPABASE_URL` is malformed/absent. Check
Railway Variables against the table in `DEPLOYMENT.md`.

## Step 1 — Auth gate (logged out, incognito window)

**Do:** `GET https://<app>/calls` (paste in address bar), then visit `/`.
**Expect:** `/calls` → `{"error":"Not authenticated"}` with HTTP 401. `/` →
redirect to `/login.html`.
**If instead you get 500 `Operator dashboard is not configured`:** the session
was somehow valid but `OPERATOR_CLIENT_ID` is missing in Railway. Log line:
`⚠️  OPERATOR_CLIENT_ID is not set — refusing to resolve the operator session's client`.
**If you get call data back:** STOP — auth middleware isn't mounted; wrong build deployed.

## Step 2 — Operator login + calls list

**Do:** Log in at `/login.html` with `DASHBOARD_PASSWORD`. Dashboard should load
with the calls table populated.
**Expect:** Existing call history visible (legacy `'default'` rows included via
the transitional filter).
**If login fails:** 401 = wrong password; 500 = `SESSION_SECRET` or
`DASHBOARD_PASSWORD` unset (log: `⚠️  DASHBOARD_PASSWORD is not set` or
`⚠️  Could not issue session`).
**If the list is empty but history exists:** open DevTools → Network → `/calls`.
500 body + log `⚠️  Calls list failed: <supabase error>` = server-side query
problem. Empty `[]` with 200 = tenant filter finding nothing — check
`OPERATOR_CLIENT_ID` value and what `client_id` values actually exist in the
`calls` table.

## Step 3 — Call edit persists

**Do:** Open any call → change status + type an instruction → Save → hard-refresh.
**Expect:** Both changes survive the refresh.
**If not:** Network tab → `PATCH /calls/<id>`. 404 = the id fell outside the
tenant scope (check the call row's `client_id`); 400 `No updatable fields` =
frontend/backend field mismatch; 500 → log `⚠️  Call update failed: ...`.

## Step 4 — CRM verify / dismiss

**Do:** Contacts tab → verify one pending card, dismiss another → refresh.
**Expect:** Verified contact appears in the verified list; dismissed card gone;
badge count drops.
**If not:** Same diagnosis path as step 3 (all four CRM actions are the same
PATCH endpoint).

## Step 5 — Pipeline toggle

**Do:** Toggle Aida off, confirm the dialog, toggle back on.
**Expect:** Log shows `⚙️  Aida pipeline paused for default` then
`... enabled for default`.
**If the slug in the log isn't your `OPERATOR_CLIENT_ID` value:** env var typo.

## Step 6 — Voicemail + Google status resolve legacy rows

**Do:** Check the voicemail card shows "✓ Recorded" (if a greeting existed) and
the Gmail/Calendar card shows connected with the right email.
**Expect:** Both statuses match pre-deploy reality.
**If both show empty/disconnected but existed before:** classic slug mismatch —
the rows are under `'default'` but `OPERATOR_CLIENT_ID` is something else.
These two routes have NO transitional filter (only `/calls` does).

## Step 7 — Client dashboard login

**Do:** `/client-dashboard.html` → log in as the existing client account.
**Expect:** Contacts list loads with the business name in the header.
**If 401 "Session expired":** normal if the last login was >1h ago — log in
again (known limitation, Phase 5 item 5). **If 403 "No client account linked":**
the `clients.auth_user_id` link is missing — check
`select slug, auth_user_id from clients` in Supabase.

## Step 8 — Live inbound call (THE critical step)

**Do:** Immediately after step 7's login (deliberately — this reproduces the old
contamination trigger), ring the Twilio number from another phone, let it go to
voicemail, leave a ~15s message mentioning a name and a callback request.
**Expect this exact log sequence:**
1. `📭 Missed call reaching Aida voicemail: +61...`
2. `📼 Recording complete: RE... (XXs)`
3. `🤖 Analysis complete for CA...`
4. `💾 Call saved: <uuid>`
5. `📧 Notification email sent to <operator gmail>`
   (plus `📧 Draft created` / `📅 Calendar event created` only if the message
   contained an email/appointment)
**Then:** the call appears in the dashboard list with transcript + summary, and
the notification email arrives.
**Failure points:**
- Nothing in logs at all → Twilio webhook not firing: Twilio Console → Monitor →
  Debugger; check the number's voice webhook is `POST <BASE_URL>/inbound/voice`
  and `BASE_URL` matches the Railway domain.
- `🚨 No client found for Twilio number +61...` → the `clients` table has no row
  with that `twilio_number`; call still processed under `'default'` fallback.
- Log stops after `📼 Recording complete` → check for `⚠️  Claim check failed`
  (the `claim_recording` RPC) or Deepgram errors; `❌ Pipeline error: ...` gives
  the failing stage.
- Everything logs but no email → `⚠️  Notification email failed: ...`; usually
  Google token — see INCIDENT_RESPONSE.md § Gmail.
- **Empty transcript/insert failures ONLY on this step, after step 7 login →
  would indicate client contamination survived somehow. This should be
  impossible post-Phase-1; if seen, capture logs and stop the rollout.**

## Step 9 — Old signup path is closed

**Do:** From any terminal:
`curl -X POST https://<app>/client-auth/signup -H "Content-Type: application/json" -d '{"clientId":"default","email":"x@x.com","password":"xxxxxxxx"}'`
**Expect:** `{"error":"Missing token, email, or password"}` (400). No user created.
**Also:** `curl -X POST https://<app>/client-auth/invite -d '{}'` → 401
(invite minting requires operator session).

## Sign-off

All 9 pass → proceed to RLS per `supabase/sql/RLS_APPLY_CHECKLIST.md`, then
re-run steps 2, 3, 7, 8 as the post-RLS smoke.
