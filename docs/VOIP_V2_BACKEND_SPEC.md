# VoIP v2 — Backend Specification

**Status:** spec for Phase 1 (M1); nothing here is implemented except the
Phase 0 placeholders. **Owns:** API contracts, data model, guard semantics,
and config for the VoIP backend. Rationale lives in
[VOIP_V2_ARCHITECTURE.md](VOIP_V2_ARCHITECTURE.md) (D1–D6, INV-1–6, §10–14);
sequencing/gates in [VOIP_V2_IMPLEMENTATION_PLAN.md](VOIP_V2_IMPLEMENTATION_PLAN.md)
(D7–D12). This doc is deliberately concrete: request/response shapes, error
codes, and invariant enforcement points, so Phase 1 is implementation, not
re-design.

---

## 1. Gating (D7) — the contract every route obeys

```
enabled(server)  = process.env.VOIP_V2_ENABLED === "true"   // strict string
enabled(client)  = clients.voip_enabled === true            // default false
voipActive(c)    = enabled(server) && enabled(client) && activeDeviceCount(c) > 0
```

- `VOIP_V2_ENABLED` unset/anything-but-"true" ⇒ every `/voip/*`, `/voice/*`,
  `/devices*` route **passes through** (Express falls to 404, byte-identical
  to today) and `inbound.js` never evaluates the v2 branch.
- Flag parsing lives in one module (`src/config/voip.js`, exists since
  Phase 0) — no route re-implements it.

## 2. Identity (INV-6)

One helper, used everywhere, no exceptions:

```
clientIdentity(slug) = "client_" + slug.replace(/-/g, "_")
// e.g. "pilot-plumbing" → "client_pilot_plumbing"
```

- Derived only from `clients.slug` resolved server-side (session or
  `getClientByTwilioNumber`) — never from request input.
- Reverse mapping is never needed server-side; webhooks carry `CallSid`/`To`
  and resolve the client the existing way.

## 3. Data model (applied by a human, like `create_personal_contacts.sql`)

### 3.1 New table `devices` — born with RLS (D8)

```sql
-- REVIEW ONLY — do not run until Phase 1 entry. Same pattern as
-- create_personal_contacts.sql: create + constraints + RLS in ONE transaction.
begin;
create table if not exists public.devices (
  id                 uuid        primary key default gen_random_uuid(),
  client_id          text        not null,             -- clients.slug
  auth_user_id       uuid,                              -- Supabase auth user
  platform           text        not null check (platform in ('ios','android')),
  push_token_hash    text        not null,              -- sha256 hex; raw token lives only in Twilio's binding
  label              text,                              -- "Pete's iPhone 15"
  app_version        text,
  os_version         text,
  last_registered_at timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  revoked_at         timestamptz,                       -- soft revocation
  created_at         timestamptz not null default now(),
  constraint devices_client_token_key unique (client_id, push_token_hash)
);
create index if not exists devices_client_active_idx
  on public.devices (client_id) where revoked_at is null;
alter table public.devices enable row level security;
comment on table public.devices is
  'RLS enabled, no policies: only service_role (the app server) may access. VoIP v2 device registrations — see docs/VOIP_V2_BACKEND_SPEC.md.';
commit;
```

`activeDeviceCount(client_id)` = rows where `revoked_at is null` and
`last_registered_at > now() - interval '30 days'`.

### 3.2 Column additions (nullable, backward-compatible; pipeline ignores them)

```sql
-- REVIEW ONLY — Phase 1 entry.
alter table public.clients add column if not exists voip_enabled boolean not null default false;
alter table public.calls   add column if not exists answered_via text;      -- 'voip' | 'voicemail' | 'bridge'
alter table public.calls   add column if not exists dial_status  text;      -- raw DialCallStatus
alter table public.calls   add column if not exists answered_at  timestamptz;
```

## 4. Environment & startup validation (D9)

| Var | Purpose | Validation |
|---|---|---|
| `VOIP_V2_ENABLED` | server-wide kill switch | optional; strict `"true"` enables |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | sign Access Tokens (never the account auth token) | **fatal at startup iff enabled** |
| `TWILIO_APNS_PUSH_CREDENTIAL_SID` | iOS VoIP pushes | fatal iff enabled **and** any iOS device rows exist is too dynamic — rule: fatal iff enabled (both SIDs may be set even before both platforms ship; empty string allowed for the not-yet-shipped platform, warned) |
| `TWILIO_FCM_PUSH_CREDENTIAL_SID` | Android pushes | as above |

Behaviour when `VOIP_V2_ENABLED` is not `"true"`: **zero validation, zero
warnings** — the feature must be invisible in logs of non-VoIP deploys.
Implemented via `assessVoipConfig(env)` in `src/config/voip.js`, called from
`startup-check.js` (wired in Phase 0, returns "skipped" while disabled).

## 5. Routes

All new mounts. Existing routes are untouched except the two modifications in
§7. Every route below 404s (pass-through) while the server flag is off.

### 5.1 `POST /voice/token` — mint a Twilio Access Token
- **Auth:** client session (`requireClientAuth`; `req.clientId` = slug).
- **Rate limit (D11):** 10/min per session, 30/min per IP. 429 on breach.
- **Request:** `{ "platform": "ios" | "android" }`
- **Response 200:** `{ "token": "<jwt>", "identity": "client_x_y", "ttlSeconds": 3600 }`
  - `AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { identity, ttl: 3600 })`
  - `VoiceGrant{ incomingAllow: true, pushCredentialSid: platform === 'ios' ? APNS : FCM }`
- **Errors:** 400 unknown platform · 403 client `voip_enabled=false` · 503 flag
  off at server level after auth (should be unreachable — pass-through) ·
  500 config missing (should be unreachable given D9).

### 5.2 `POST /devices/register`
- **Auth:** client session. **Rate limit:** 10/min per session.
- **Request:** `{ platform, pushTokenHash, label?, appVersion?, osVersion? }`
  (`pushTokenHash` = sha256 hex computed **on the device**; server never sees
  the raw token).
- **Behaviour:** upsert on `(client_id, push_token_hash)`; refresh
  `last_registered_at`; clear `revoked_at` on re-register; enforce cap of
  **5 active devices** per client → 409 `{ error: "device limit reached" }`.
- **Response 200:** `{ device: { id, platform, label, lastRegisteredAt } }`

### 5.3 `POST /devices/revoke`
- **Auth:** client session (own devices) or operator session.
- **Request:** `{ deviceId }` → sets `revoked_at`, then calls Twilio REST to
  delete the binding for that identity/registration immediately (token dies
  within ≤1h TTL regardless).
- **Response 200:** `{ revoked: true }` · 404 unknown/foreign id (no
  existence leak across tenants).

### 5.4 `GET /devices`
- **Auth:** client session (own) or operator. Returns active devices with
  staleness (`lastRegisteredAt`), never token hashes.

### 5.5 `POST /voip/dial-result` — the INV-2 enforcement point
- **Auth:** Twilio signature (`twilioWebhook`), same as `/inbound`.
- Fired as `<Dial action>` after the Client leg ends. **Exactly two branches:**

```
if (DialCallStatus === "completed")  → respond <Hangup/>;
                                       update calls: { status, answered_via:'voip',
                                       dial_status, answered_at }
else (any other value)               → respond shared voicemail TwiML helper
                                       (greeting → <Record> → /inbound/voicemail-complete);
                                       update calls: { dial_status }
```

No third branch. No `<Dial>` may ever appear in the else path (INV-2: never a
PSTN redial). A unit test asserts the rendered else-TwiML contains no `<Dial>`.

### 5.6 `POST /voip/call-status` *(optional callbacks)*
- **Auth:** Twilio signature. Updates `calls` lifecycle (`ringing`→`in-progress`
  →ended) best-effort; failures logged, never 5xx to Twilio.

### 5.7 `POST /voip/push-ack` — the funnel metric (D12)
- **Auth:** client session (token from device keychain).
- **Request:** `{ callSid, receivedAt }` — app acks the moment the push wakes it.
- Persisted as a structured log line (MVP) keyed by CallSid:
  `push_sent_at` (from Twilio dial) vs `ack_received_at` = the real
  ring-delivery metric neither Apple nor Google will give us.

## 6. Inbound branch (the one change to `inbound.js`)

After client resolution and owner-recognition, before the voicemail block:

```
if (voipActive(client)) {
  // pre-dial checks: isPersonalCall(client, From) → dial WITHOUT record attr
  insert calls row { status:'ringing', answered_via: null }
  respond:
    <Dial answerOnBridge="true" timeout="20"
          record="record-from-answer-dual"          // omitted for personal
          recordingStatusCallback="<BASE_URL>/recording/complete"
          action="/voip/dial-result">
      <Client>clientIdentity(slug)</Client>
    </Dial>
} else {
  existing voicemail flow — extracted to a shared helper, byte-identical output
}
```

- The voicemail TwiML extraction is refactor-with-proof: a test renders old vs
  new for a non-VoIP client and asserts string equality.
- INV-5 tripwire runs before everything: if `From` equals any of **our** Twilio
  numbers, or >3 legs for the same (From,To) within 10s — log
  `🚨 LOOP GUARD`, respond polite `<Say>` + `<Hangup/>`, never dial.

## 7. INV-1 guard in `routes/call.js` (D10) — ✅ implemented (Phase 1a)

Implemented on `feature/voip-phase-1a-loop-guard` as `services/loop-guard.js`
(pure decision core + thin DB adapter; 14 unit tests), wired into
`POST /call/initiate` (refuses all three loop cases: voip_enabled
caller-client, owner leg matching a voip_enabled client's number, destination
matching one) and the owner bridge `/inbound/connect` (destination check after
the AU allow-list). The `clients.voip_enabled` column ships as
`supabase/sql/phase1a_add_voip_enabled.sql` (review-only). Two deliberate
refinements over the original sketch:

1. **The guard is independent of `VOIP_V2_ENABLED`.** CFU is carrier-side
   state — the kill switch disables the feature, not the loop physics — so
   the guard keys off `clients.voip_enabled` alone.
2. **Fail-safe pre-provisioning.** Until the column SQL is applied, the 42703
   error is treated as "no VoIP clients" (correct: no cutover can precede the
   flag under the §16 runbook), with a one-time warning log.

Original sketch (kept for context):

```
const client = await getClientBySlug(req.clientId);        // clients row, NOT env
const target = normaliseForMatch(destination);
if (client.voip_enabled && target === normaliseForMatch(client.real_number)) {
  console.error("🚨 LOOP GUARD: refusing PSTN dial to CFU'd real_number", …);
  return res.status(409).json({ error: "This client answers via the app; dialling their real number would loop." });
}
```

- Comparison uses the same E.164 normalisation as owner recognition.
- This work item **includes P2-5**: `/call/initiate` stops reading
  `CLIENT_REAL_NUMBER` env and dials the client row's `real_number`.

## 8. Logging & minimal metrics (MVP scope per D12)

Structured single-line logs, greppable in Railway:
`voip.dial.start`, `voip.dial.result{status}`, `voip.push.ack{latencyMs}`,
`voip.loopguard.trip`, `voip.token.mint`, `voip.device.register/revoke`.
Daily staleness/answer-rate check is a documented SQL query in the runbook,
not a dashboard (V2).

## 9. Test requirements (Phase 1 exit gate)

1. Flag off ⇒ full smoke suite output byte-identical to pre-VoIP baseline.
2. Voicemail-TwiML helper equality test (see §6).
3. INV-1: `/call/initiate` 409s for a voip_enabled client's real_number
   (E.164 and local formats), still dials for non-VoIP clients.
4. INV-2: `/voip/dial-result` else-branch TwiML contains `<Record>` and no
   `<Dial>` for every non-`completed` DialCallStatus value.
5. INV-6: identity helper property tests (slug with hyphens, INV-6 examples).
6. Token endpoint: 403 for non-VoIP client; TTL 3600; correct pushCredentialSid
   per platform (assert on decoded JWT grants, no live Twilio call).
7. Device cap: 6th active registration → 409.
8. Rate limits: 429 semantics.
