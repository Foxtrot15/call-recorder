# Aida — Incident Response

_First stop for every incident: Railway → service → Deployments → View logs.
Second stop for anything call-related: Twilio Console → Monitor → Debugger._

## General triage order

1. Is the service up? (`GET /health` → `{"status":"ok"}` — public, no auth.)
2. Did anything change recently? (deploy, env var, Supabase change, RLS apply)
3. Match symptoms to a scenario below. Change **one thing at a time**.

---

## Scenario 1 — Operator dashboard breaks

| Symptom | Likely cause | Action |
|---|---|---|
| Redirected to login, password rejected | `DASHBOARD_PASSWORD`/`SESSION_SECRET` unset or changed | Check Railway vars; log: `⚠️  DASHBOARD_PASSWORD is not set` |
| Everything returns 500 `Operator dashboard is not configured` | `OPERATOR_CLIENT_ID` missing | Set it in Railway (restarts service); log: `⚠️  OPERATOR_CLIENT_ID is not set` |
| Page loads, calls list empty, history exists | Tenant scope mismatch or RLS applied against an old build | DevTools → `/calls` response. 200 + `[]` → compare `OPERATOR_CLIENT_ID` with `select distinct client_id from calls`. If the page is requesting `supabase.co` directly → an old cached build; hard-refresh, confirm deployed commit |
| Calls list 500 | Server query failure | Log: `⚠️  Calls list failed: <reason>` — usually Supabase connectivity or key |
| Edits don't save | PATCH failing | Network tab: 404 = id outside tenant scope; 500 = log `⚠️  Call update failed` |
| Voicemail/Google cards suddenly empty | `OPERATOR_CLIENT_ID` changed but data lives under the old slug | Either revert the var or migrate rows (backfill script pattern) |

Escalation: redeploy last known-good build (Railway → Deployments → Redeploy).

## Scenario 2 — Calls stop recording / going to voicemail

Work **outside-in**:

1. **Client's handset:** did conditional forwarding get cancelled (new SIM,
   carrier reset)? Have them re-dial `**61*<number>#` etc.
2. **Twilio Debugger:** errors against the number?
   - `11200` (webhook HTTP failure) → app down or `BASE_URL` wrong. Check `/health`.
   - `11205`/timeouts → app slow/crashed; check Railway logs + restarts.
   - `12300` (invalid TwiML) → an exception mid-handler; find the stack trace in logs.
   - **No entries at all** → the call never reached Twilio: forwarding is off,
     or the number's webhook config was changed. Verify Voice webhook is
     `POST <BASE_URL>/inbound/voice`.
3. **Signature validation:** if Twilio gets 403s, someone set webhook auth
   wrong or the auth token was rotated in Twilio without updating
   `TWILIO_AUTH_TOKEN` in Railway. (`NODE_ENV=development` disables validation
   — never use that as a production fix.)
4. **Wrong tenant, not missing calls:** log `🚨 No client found for Twilio
   number +61...` → calls are processing under `'default'`; fix the
   `clients.twilio_number` value (exact E.164 match).
5. **Recording arrives, pipeline dies:** logs after `📼 Recording complete:` —
   `⚠️  Claim check failed` (Supabase RPC `claim_recording` missing/erroring),
   Deepgram auth/quota, or `❌ Pipeline error: <stage>`. Recording URL is
   persisted on the calls row (`recording_url`), so audio is recoverable even
   when the pipeline fails — nothing is lost, reprocess later.

## Scenario 3 — Gmail / Calendar / notification email stops

All three share one Google token per tenant (`connections` table).

1. Log says `No Google token found for client <slug>` → **slug mismatch**: the
   token row's `client_id` isn't the slug the pipeline resolved. Compare
   `select client_id, provider, email from connections` with the calls rows'
   `client_id`. Fix = reconnect Google under the right slug (operator
   dashboard) or migrate the row.
2. `⚠️  Notification email failed: <401/invalid_grant>` → refresh token revoked
   (Google security event, password change, or consent removed) → reconnect
   via operator dashboard → Connect Google.
3. Decryption errors from `services/token.js` → `ENCRYPTION_KEY` changed since
   the token was stored. Old ciphertexts are unrecoverable — reconnect Google
   to store fresh tokens under the current key.
4. Drafts/events missing but notification works → not an outage: drafts need a
   caller email in the transcript; events need a date. Check the call's
   `analysis` JSON before assuming breakage.

## Scenario 4 — RLS blocked something

Only possible after `phase2_enable_rls.sql` was applied.

1. **Expected reality:** the server uses the service-role key and bypasses RLS
   entirely. If something broke at the same time RLS was applied, the affected
   consumer is NOT the server — find what it is (an old dashboard build still
   open in a browser tab is the classic one: symptom is empty lists + console
   errors against `supabase.co`; fix is hard-refresh, not rollback).
2. Confirm which requests fail: PostgREST calls with the anon key return empty
   arrays/permission errors — that is RLS **working**.
3. If the pipeline itself broke (step-8 sequence dies on DB writes): verify
   `SUPABASE_SERVICE_KEY` in Railway is really the service key and not the
   anon key (`role":"service_role"` vs `"anon"` inside the JWT payload —
   decode at jwt.io).
4. True emergency only: run the disable block at the bottom of
   `phase2_enable_rls.sql`, restore service, then diagnose properly. Re-apply
   RLS the same day — disabled RLS re-opens the leaked-anon-key exposure
   (SECURITY_REVIEW.md #1).

## Contact/reference card

- App health: `https://<app>/health`
- Railway logs: service → Deployments → latest → Logs
- Twilio Debugger: Console → Monitor → Logs → Errors
- Supabase: Dashboard → project → Logs (PostgREST + Auth), SQL Editor
- Known log strings and their meanings: see TEST_PLAN.md step diagnostics
