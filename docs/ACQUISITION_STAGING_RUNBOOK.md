# Acquisition staging — the non-production runtime

**Status: SERVICE CREATED. FIRST DEPLOY CRASHED; BOOT FIX APPLIED AND PUSHED.
DURABLE WEBHOOK STORE WIRED LOCALLY (E-12D, unpushed). No domain generated.
Acquisition webhook NOT yet reachable. NO LIVE AUTHENTICATED WEBHOOK HAS EVER
BEEN RECEIVED. Agent NOT PROVISIONED. Calling PAUSED. Production untouched.**

**Owns (source of truth for):** how the staging Railway service is configured,
why each variable is present or deliberately absent, and what staging is allowed
to do.

---

## 1. Why staging exists

E-12C needed a genuine public HTTPS URL for `POST /webhooks/retell/acquisition`
so the acquisition agent can be created **once**, correctly, with its real
`webhook_url`. The audit found the repository had **exactly one environment, and
it was production** — so a second one had to be built rather than borrowed.

| | production | staging |
|---|---|---|
| Railway service | existing | `heroic-friendship` |
| environment | production | `staging` |
| branch | `main` | `feature/locksmith-pilot-acquisition-foundation` |
| Supabase | production | **DEV only** — `wvwemitmmsdytyutaqbm` |
| Twilio | configured | **deliberately absent** |
| purpose | real customer calls | acquisition webhook ingress |

**Staging means non-production DATA, not relaxed security.** `NODE_ENV=production`
is set on purpose: `middleware/auth.js:15` disables Twilio signature validation
when `NODE_ENV === "development"`, and `config/locksmith-onboarding.js:25`
unlocks behaviour on `development`/`test`. Neither may happen on a public host.

---

## 2. The variables, and why each one is there

### Set

| variable | why |
|---|---|
| `NODE_ENV=production` | production-grade auth and signature validation (§1) |
| `RAILPACK_NODE_VERSION=22` | Node pin — see §4 |
| `SUPABASE_URL` | `https://wvwemitmmsdytyutaqbm.supabase.co` — DEV only |
| `SUPABASE_SERVICE_KEY` | DEV service-role key. **Fatal at startup if missing** |
| `SESSION_SECRET` | **Fatal if missing.** Staging-only value — a shared secret would let a staging cookie verify against production |
| `ENCRYPTION_KEY` | **Fatal if missing or `< 32` chars** (`config/startup-check.js:23`, re-checked in `services/token.js:19`, which uses `raw.slice(0, 32)`) |
| `RETELL_ENABLED=true` | the integration at all |
| `RETELL_WEBHOOK_ENABLED=true` | webhooks at all |
| `RETELL_ACQUISITION_WEBHOOK_ENABLED=true` | **this** path — the third flag exists so onboarding webhooks can never enable acquisition ingestion |
| `RETELL_API_KEY` | the API key **is** the webhook signing secret; verification is impossible without it |
| `RETELL_ALLOWED_TAG=staging` | environment separation (defaults to `dev`; `staging` is valid and accurate) |
| `RETELL_ACQUISITION_LLM_ID` | the provisioned response engine |
| `RETELL_ACQUISITION_VOICE_ID` | Sunny — the founder's selection |

### Deliberately absent

Omission is the safety mechanism. These are all `RECOMMENDED`, not `CRITICAL`,
so the server boots with warnings rather than errors — **10 warnings is the plan
working, not a problem to fix.**

| omitted | consequence |
|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` / `CLIENT_REAL_NUMBER` | staging **structurally cannot dial anybody**. Not a flag — there is no credential |
| `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `GOOGLE_*` | no analysis, transcription or Google account reachable |
| `OPERATOR_CLIENT_ID`, `DASHBOARD_PASSWORD` | operator login disabled |
| `BASE_URL` | Twilio callbacks / OAuth only; the Retell webhook does not use it |
| `RETELL_LIVE_WRITES_ENABLED`, `RETELL_LIVE_CALLS_ENABLED` | no agent creation, no calls |
| `RETELL_DRY_RUN` | **inverted gate** — unset means dry-run is **ON** |
| `RETELL_DEFAULT_VOICE_ID`, `RETELL_OUTBOUND_ONBOARDING_NUMBER` | receptionist/onboarding concerns; acquisition has its own keys |
| `ACQUISITION_ENABLED` | the acquisition engine stays **off**. The ingress does not depend on it — verified, it is referenced by neither the route nor the handler |
| `VOIP_V2_ENABLED`, `LOCKSMITH_*_ENABLED` | those routes 404 |

Two guarantees are **not** environment-driven at all, which is why they are the
strongest ones here: `EXTERNAL_ACCESS_SUPPORTED` and
`EXTERNAL_SYSTEMS.telephony` are hardcoded `false` in `config/acquisition.js`.
No Railway variable can change them.

### Added later, once a domain exists

```
RETELL_ACQUISITION_WEBHOOK_URL=https://<railway-domain>/webhooks/retell/acquisition
```

Leaving it unset is safe: `webhook_url` resolves to `null`, `createAgentReady`
stays **false**, and no write or call path opens.

---

## 3. First deploy — passed configuration, then crashed

```
✅ Config check passed (10 warnings)
Error: username is required
    at .../twilio/lib/base/BaseTwilio.js
    at /app/src/routes/call.js:7:16
```

The configuration plan was right; the code was not. `routes/call.js` built a
Twilio client at **module scope**, so merely importing the router constructed it,
and the SDK refused an undefined account sid. The throw happened while
`server.js` was importing routes — **before anything was mounted** — so one
unconfigured integration took down every unrelated route with it, including the
acquisition webhook, which never touches Twilio.

**The fix was not to add credentials.** Staging having no Twilio credentials is
the point: a runtime that cannot authenticate cannot dial a customer by
accident. The client is now built on first use and returns `null` when
credentials are absent, and `POST /call/initiate` answers **503** before doing
any work. No placeholder sid, no empty-string token, no fallback — a client that
exists but cannot authenticate would postpone a configuration mistake until the
moment somebody tries to place a real call.

This follows the pattern the repository already used for the same dependency:
`routes/recording.js` builds its client inside the handler, and
`middleware/auth.js` memoises `twilio.webhook()` on first request.

**Latent, not fixed:** `services/sms.js:2` has the same module-scope
construction. It is **imported by nothing** (DEPLOYMENT.md already calls it
dead), so it never loads and cannot crash a deploy. A ratchet now fails the
build if any module mounted by `server.js` constructs Twilio at module scope,
which would catch someone importing it.

---

## 4. Node version — `NIXPACKS_NODE_VERSION` was the wrong variable

The first deploy ran **Node v18.20.8** despite `NIXPACKS_NODE_VERSION=22`.

Railway now builds with **Railpack**, not Nixpacks, and Railpack reads
**`RAILPACK_NODE_VERSION`**. The Nixpacks variable is simply ignored.

```
REMOVE:  NIXPACKS_NODE_VERSION=22
ADD:     RAILPACK_NODE_VERSION=22
```

This is a **Railway variable change only**. `package.json` `engines` is
deliberately untouched at `>=18`: tightening it would be a repo-wide change made
to satisfy one environment, and it would affect production.

Nothing in this repository selects a builder — there is no `nixpacks.toml`,
`railpack.json`, `.nvmrc` or `.node-version`. The pin is entirely Railway-side,
so **read the build log and confirm the resolved version** rather than trusting
the variable was honoured.

---

## 5. What staging can and cannot do

Verified against the exact variable set: **0 fatal startup errors, 0 Retell
config errors, 10 expected warnings.**

| | |
|---|---|
| acquisition webhook ingress | **ON** |
| Retell signature verification | **REQUIRED** — no bypass exists (§6) |
| `canWriteLive` (create an agent) | **refused** |
| `canPlaceCall` (dial) | **refused** |
| acquisition engine | **off** — `acquisition_disabled` |
| all dial providers | `live: false` |
| `RETELL_DRY_RUN` | **on** |
| Twilio | **no credential exists** |
| database | DEV only |

---

## 6. Signature verification is not relaxed on staging

The deployed ingress requires a genuine Retell signature. The handler delegates
to the single `verifyRetellWebhook` and implements no crypto of its own. There
is **no** `NODE_ENV === "development"` bypass, no `allowUnsigned`-style flag and
no query-string secret substitute. When the SDK is unavailable the verifier
returns `verifier_unavailable` and the route answers 503 — it **fails closed
rather than improvising an HMAC**.

---

## 7. The durable return path — wired as of E-12D

The route previously built its handler with no store, so a verified event acked
`204` and then recorded `acquisition_event_store_unavailable`. **E-12D wired it**
(design §26): the route now composes the existing durable store, suppression
list and outcome recorder on **first request**, not at import — production has no
acquisition schema, so composing at load would have made a production database
query out of a module simply existing.

**Still not proven live.** Every proof is offline. Staging is where this path is
deliberately allowed to write acquisition rows to DEV for the first time, and
that is a genuine threshold: before it, no runtime could write an acquisition row
from a webhook; after it, one can.

---

## 8. Next steps, in order

1. **Fix the Node pin** — remove `NIXPACKS_NODE_VERSION`, add
   `RAILPACK_NODE_VERSION=22`, redeploy, confirm the log shows Node 22.
2. **Generate a Railway domain** once the service boots clean.
3. **Set `RETELL_ACQUISITION_WEBHOOK_URL`** to that domain + the path.
4. **Probe the public route** — unsigned and malformed requests must be rejected
   without writing anything.
5. **Wire the durable store** (§7) — its own milestone.
6. Only then: create the acquisition agent.

Calling stays **paused at revision 1** throughout. DEV acquisition residue stays
at **23 rows**.
