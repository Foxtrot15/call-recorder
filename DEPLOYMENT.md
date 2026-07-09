# Aida — Deployment Guide

_Last updated: 2026-07-05 (commit `1cdeaaa` — auth isolation, invite signup, session-derived clientId, server-side /calls API)._

## Required environment variables

| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | all DB access | |
| `SUPABASE_SERVICE_KEY` | all DB access | Service-role key. Server-only; never shipped to the browser. |
| `SESSION_SECRET` | operator login, invite tokens | Missing → all operator sessions and invites fail closed. |
| `OPERATOR_CLIENT_ID` | every operator route | `clients.slug` this deployment's dashboard manages. Currently `default` (transitional). Missing → operator routes return 500. **Set before deploying code that requires it.** |
| `DASHBOARD_PASSWORD` | operator login | Missing → login disabled. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | webhooks, recording fetch, outbound dial | Auth token also validates `X-Twilio-Signature`. |
| `TWILIO_PHONE_NUMBER` | `/call/initiate` | Outbound caller ID. |
| `CLIENT_REAL_NUMBER` | `/call/initiate`, recording fallback | Legacy single-tenant var; still load-bearing for outbound dial. |
| `BASE_URL` | Twilio callbacks, OAuth redirect | Public https URL of this deployment. |
| `DEEPGRAM_API_KEY` | transcription | |
| `ANTHROPIC_API_KEY` | analysis, drafts, summaries | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail/Calendar OAuth | |
| `ENCRYPTION_KEY` | OAuth token storage (`services/token.js`) | Must be a strong 32-char value. ⚠️ If unset, code silently derives a key of 32 spaces — see SECURITY_REVIEW.md. |
| `VOICEMAIL_GREETING` | inbound voicemail | Optional; TTS fallback text. |
| `PORT` | server | Optional, default 3000. |
| `NODE_ENV` | webhook signature check | `development` disables Twilio signature validation — never in production. |

### VoIP v2 (all optional while the feature is off — added 2026-07)

Validated at startup **only when `VOIP_V2_ENABLED="true"`** (decision D9);
when unset/false they are ignored entirely and every VoIP route 404s.
Semantics owned by [docs/VOIP_V2_BACKEND_SPEC.md](docs/VOIP_V2_BACKEND_SPEC.md) §4.

| Variable | Used by | Notes |
|---|---|---|
| `VOIP_V2_ENABLED` | server-wide VoIP kill switch | Strict string `"true"` enables; anything else = feature invisible. **Unset in production today.** |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | `/voice/token` Access Token signing | Fatal at startup iff enabled. Never the account auth token. |
| `TWILIO_APNS_PUSH_CREDENTIAL_SID` | iOS VoIP pushes | Fatal iff enabled; empty string allowed for a not-yet-shipped platform (warned). |
| `TWILIO_FCM_PUSH_CREDENTIAL_SID` | Android pushes | As above. |

Legacy/unused: `TWILIO_NUMBER`, `TRANSCRIPT_RECIPIENT_NUMBER` (only referenced by dead `src/services/sms.js`).

## Deploy order (matters)

1. **Set/confirm env vars in Railway first** — especially `OPERATOR_CLIENT_ID`, since the new code 500s operator routes without it. Saving a variable restarts the old code harmlessly.
2. Push `main` → Railway auto-deploys.
3. Watch deploy logs for `✅ Server listening on port ...` and no startup errors.
4. Run the smoke test below.
5. Only after smoke passes: apply RLS per `supabase/sql/RLS_APPLY_CHECKLIST.md`.

## Smoke test (in order — each step gates the next)

| # | Check | Proves |
|---|---|---|
| 1 | Incognito: `GET /calls` logged out → 401 JSON; `/` redirects to `/login.html` | Auth gate + env var wired |
| 2 | Operator login → dashboard loads, calls list populates | `GET /calls` API |
| 3 | Open a call → change status + instruction → save → refresh → persisted | `PATCH /calls/:id` |
| 4 | Contacts tab: verify one CRM card, dismiss another, refresh → state held | Remaining PATCH fields |
| 5 | Pipeline toggle off→on; log shows `⚙️ Aida pipeline ... for <slug>` | Settings on `req.clientId` |
| 6 | Voicemail status shows existing greeting; `/auth/status` shows Google connected | Legacy `'default'` rows resolving |
| 7 | Client dashboard: existing client logs in, contacts load | Client auth (Phase 1) intact |
| 8 | **Real missed call to the Twilio number — after step 7's login** → logged, transcribed, notification email arrives | Pipeline unbroken AND admin client not contaminated by a login (the original root bug) |
| 9 | `POST /client-auth/signup` with old-style body (`clientId`, no `token`) → 400 | Signup hole closed |

Step 8 is the critical one: doing a client login *before* the test call reproduces the exact sequence that used to poison the shared Supabase client.

## Rollback

- Code: redeploy the previous commit from Railway's deploy history (or `git revert` + push).
- `OPERATOR_CLIENT_ID` can stay set during a rollback — old code ignores it.
- RLS rollback (only if applied and something breaks): commented-out block at the bottom of `supabase/sql/phase2_enable_rls.sql`.

## Current transitional state (intentional, see PHASE_5_PLAN.md)

- `OPERATOR_CLIENT_ID=default` — all operator data continues under the legacy `'default'` tenant; no data backfill needed yet.
- `src/routes/calls.js` includes a transitional tenant filter (`clientId OR 'default' OR NULL`) so legacy call rows stay visible. Remove after the Phase 5 backfill.
- RLS SQL exists (`supabase/sql/phase2_enable_rls.sql`) but is **not applied**.
