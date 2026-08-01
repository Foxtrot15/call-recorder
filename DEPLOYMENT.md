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

### AIDA Locksmith Receptionist (all optional — added 2026-07)

Public product page at `/locksmith-receptionist`. **Dormant by default** — with
`LOCKSMITH_PILOT_ENABLED` unset (the production state today) both routes 404 and
the feature is invisible. Everything else is optional: once enabled the page
renders with visible `[TO BE CONFIRMED: …]` placeholders instead of any invented
detail, and the enquiry form stays disabled. Nothing here is validated at
startup. Semantics owned by
[docs/LOCKSMITH_PILOT_SPEC.md](docs/LOCKSMITH_PILOT_SPEC.md) §5.

| Variable | Used by | Notes |
|---|---|---|
| `LOCKSMITH_PILOT_ENABLED` | public page + enquiry route | Strict string `"true"` serves them; anything else (including unset) = both routes 404. **Unset in production today.** |
| `LOCKSMITH_ENQUIRY_ENABLED` | enquiry submissions | Strict string `"true"` enables. **Leave unset:** M1 has no persistence sink, so submissions answer a truthful 503. See spec §7 for what must exist first. |
| `LOCKSMITH_DEMO_PHONE` | hero "Call the live demo" CTA | E.164. Until set, no `tel:` link is rendered at all. |
| `LOCKSMITH_CONTACT_EMAIL` | footer contact | Until set, no `mailto:` link is rendered. |
| `NICHE_DROPS_ABN` | footer | Placeholder until supplied. |
| `NICHE_DROPS_PRIVACY_URL` / `NICHE_DROPS_TERMS_URL` | footer links | Placeholder text until supplied — never rendered as a live `href`. |
| `LOCKSMITH_CONTACT_REGION` | footer | Defaults to `Melbourne, Victoria, Australia`. |
| `LOCKSMITH_SETUP_PRICE` / `LOCKSMITH_MONTHLY_PRICE` / `LOCKSMITH_INCLUDED_DAYS` | pricing section | Whole dollars / days; a non-positive-integer value falls back to 149 / 299 / 14. |
| `LOCKSMITH_PILOT_LIMIT` / `LOCKSMITH_PILOT_REGION` | founding-pilot line | Default 3 / `Melbourne`. |

### Locksmith autonomous onboarding (M2 — added 2026-08)

Client review/approval + founder console. **Dormant by default and gated
separately from the public page**: enabling the shop window never enables the
workshop. Semantics owned by
[docs/LOCKSMITH_ONBOARDING_SPEC.md](docs/LOCKSMITH_ONBOARDING_SPEC.md).

| Variable | Used by | Notes |
|---|---|---|
| `LOCKSMITH_ONBOARDING_ENABLED` | review + founder routes | Strict string `"true"` mounts them; anything else (including unset) = every path 404s before any auth runs. **Unset in production today.** |

**Deploy precondition:** these routes also need
`supabase/sql/lpm2_create_locksmith_onboarding.sql` applied by a human first.
Until then every adapter fails closed with "locksmith onboarding tables not
provisioned", so enabling the flag alone cannot half-open the feature.

### Retell voice provider (M3 — added 2026-08, dormant)

**Four independent danger gates, all strict-parse and all OFF by default**, plus
an inverted dry-run gate that is ON by default. They are separate on purpose:
enabling a preview must not grant permission to create agents, and creating
agents must not grant permission to dial a customer. Semantics owned by
[docs/RETELL_INTEGRATION_SPEC.md](docs/RETELL_INTEGRATION_SPEC.md).

| Variable | Used by | Notes |
|---|---|---|
| `RETELL_ENABLED` | the whole integration | Strict `"true"`. **Unset in production today.** |
| `RETELL_WEBHOOK_ENABLED` | `POST /webhooks/retell` | Strict `"true"`. Both this AND `RETELL_ENABLED` are required or the route 404s. |
| `RETELL_LIVE_WRITES_ENABLED` | provisioning execution | Strict `"true"`. Permits creating/updating Retell resources. |
| `RETELL_LIVE_CALLS_ENABLED` | outbound onboarding calls | Strict `"true"`. **Placing calls spends money.** |
| `RETELL_DRY_RUN` | all write paths | **Inverted and ON by default** — only `"false"` leaves dry-run. While on, nothing leaves the process. |
| `RETELL_API_KEY` | auth + webhook signature verification | The API key *is* the webhook signing secret. Never logged, never rendered. |
| `RETELL_API_BASE_URL` | provider transport | https origin only, no path/query/fragment. Invalid ⇒ fatal at startup once enabled. |
| `RETELL_DEFAULT_VOICE_ID` | agent creation | **No default is invented.** Missing ⇒ live writes are fatal at startup. |
| `RETELL_DEFAULT_LANGUAGE` | agent creation | Defaults `en-AU`; confirm against Retell's supported locales before first live provisioning. |
| `RETELL_OUTBOUND_ONBOARDING_NUMBER` | outbound calls | E.164. Missing ⇒ live calls are fatal at startup. |
| `RETELL_INBOUND_DEMO_NUMBER` | inbound phone binding | The number the receptionist answers on. When set, the provisioning plan emits an `inbound_binding` action; when unset, no binding is planned and the last mile is uncovered. **Never defaulted or invented.** |
| `RETELL_WEBHOOK_BASE_URL` | agent `webhook_url` | Public https base. Missing while webhooks are on ⇒ warning. |
| `RETELL_ALLOWED_TAG` | environment separation | `dev` \| `staging` \| `prod`. |
| `RETELL_TIMEOUT_MS` / `RETELL_MAX_RETRIES` / `RETELL_WEBHOOK_MAX_BYTES` | transport + webhook | Defaults 30000 / 2 / 524288. |
| `RETELL_RECORDING_ENABLED` | recording default | **Off by default pending the founder's legal wording.** Transcription is separate from recording. |
| `RETELL_TRANSCRIPT_RETENTION` | retention preference | Mirrors the canonical profile enum. No retention job exists yet. |

**Deploy preconditions** (all currently unmet, deliberately):
1. `supabase/sql/lpm2_create_locksmith_onboarding.sql` then
   `supabase/sql/lpm3_create_retell_provisioning.sql`, applied by a human.
2. A Retell account, API key and dashboard voice id.
3. **Node 20+** if webhook verification is needed: the official `retell-sdk`
   (declared as an `optionalDependency`, not installed) requires it, and the
   verifier fails closed without it rather than improvising an HMAC.

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

### Retell provider contracts (M7B — corrected 2026-08-01)

The Retell request shapes were reconciled against official documentation. If you
are deploying anything that touches provisioning, the corrections that change
operational behaviour are:

- **Phone binding uses weighted agent arrays.** `inbound_agents`, with weights
  totalling exactly 1. `inbound_agent_id` is not a current field and is rejected
  before a request is built.
- **The knowledge base is multipart/form-data and cannot be updated.** A content
  change creates a new knowledge base and supersedes the old one in the registry,
  so expect KB resources to accumulate at the provider until deleted manually.
- **Runtime-sensitive dynamic variables are not shipped as defaults.** Transfer
  numbers, on-call state and business status must arrive per call through the
  **inbound call webhook**, which must answer 2xx within **10 seconds**. Until
  that webhook is implemented and reachable, a live receptionist would have no
  transfer number at call time.
- **`RETELL_DEFAULT_VOICE_ID` is genuinely required.** The provider requires
  `voice_id` on agent creation; it is no longer emitted as null.

**None of this has been validated against a live Retell account.** See
[docs/RETELL_SANDBOX_VALIDATION_PLAN.md](docs/RETELL_SANDBOX_VALIDATION_PLAN.md)
for the procedure, prerequisites, billable actions and cleanup.
