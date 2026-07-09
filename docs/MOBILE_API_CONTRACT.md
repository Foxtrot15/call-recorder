# Mobile API Contract — Client Authentication & VoIP Endpoints

**Status:** ✅ implemented · **Owns:** the stable request/response contract the
React Native app builds against, and the dual-mode (browser cookie vs mobile
Bearer) authentication semantics. Backend design rationale lives in
[VOIP_V2_BACKEND_SPEC.md](VOIP_V2_BACKEND_SPEC.md); app behaviour in
[VOIP_V2_MOBILE_APP_SPEC.md](VOIP_V2_MOBILE_APP_SPEC.md).

> **Stability promise:** fields documented here are additive-only. New fields
> may appear in responses; documented fields, status codes, and error `code`
> values will not change meaning. The app must ignore unknown fields.
>
> **Why not a generated OpenAPI spec?** The server is plain Express with no
> schema/validation layer to introspect. Every "automatic" generator for this
> stack (swagger-jsdoc annotations, traffic-capture generators) is a second
> hand-maintained description of the same routes — exactly the duplicated
> maintenance we're avoiding. This document is the single contract source;
> if the backend ever adopts a schema-first router, generate the spec from
> that and retire this section.

---

## 1. Authentication model (one implementation, two transports)

All client endpoints are guarded by **one** middleware
(`requireClientAuth`, `src/middleware/auth.js`) with one validation path:
verify the Supabase access token, resolve `clientId` **server-side** from
`clients.auth_user_id` — never from request input. Only the *transport*
differs:

| | **Browser (cookie mode)** | **Mobile (bearer mode)** |
|---|---|---|
| Credential | httpOnly cookies `aida_client_session` (access) + `aida_client_refresh` (refresh) | `Authorization: Bearer <access_token>` header |
| Set by | server, on login/refresh | app, from Keychain/Keystore |
| Access expiry | ~1 h (Supabase JWT) | same token, same expiry |
| Refresh | **transparent** — middleware rotates cookies mid-request; the browser never sees the expiry | **explicit** — app gets `401 {"code":"invalid_token"}`, calls `POST /client-auth/refresh`, retries once |
| CSRF exposure | mitigated: `sameSite=lax`, `httpOnly`, `secure` | none — headers are never attached cross-site by the browser |
| XSS exposure | none — httpOnly, page JS never sees tokens | n/a in-app; **never use token mode from web JS** (it would put tokens where XSS can reach) |

**The transport rule (no mixing, ever):** if a request carries *any*
`Authorization` header, it is a bearer request — cookies on that request are
**ignored**, and a malformed/wrong-scheme header is a `401`, *not* a fallback
to cookie auth. Requests without the header are cookie requests, exactly as
before this layer existed. One request is always exactly one mode.

### Mobile token lifecycle

1. **Login** with `mode: "tokens"` → store `access_token` + `refresh_token`
   in **iOS Keychain / Android Keystore** (e.g. `react-native-keychain`).
   Never in AsyncStorage, never in JS-readable plain storage.
2. Send `Authorization: Bearer <access_token>` on every API call.
3. On `401 code=invalid_token` (or pre-emptively near `expires_at`):
   `POST /client-auth/refresh { refresh_token }`.
4. **Rotation:** every refresh returns a **new pair**; the old refresh token
   is consumed (Supabase revokes it after a short reuse-grace window, and
   reuse outside that window revokes the whole session family — replay
   protection). Persist **both** new tokens to the keystore *before* issuing
   the next request; a lost rotated refresh token means re-login.
5. On refresh `401 code=invalid_refresh_token`: session is over → wipe
   keystore, show Login.
6. **Logout:** `POST /client-auth/logout` with the Bearer header (+
   `refresh_token` in the body if you still hold one), then wipe the
   keystore regardless of the response.

---

## 2. Error envelope

Every non-2xx response is `{ "error": "<human message>", "code": "<machine code>"? }`.
`code` values (stable):

| `code` | Where | Meaning / app action |
|---|---|---|
| `invalid_token` | any bearer-authed endpoint, 401 | access token invalid/expired → refresh, retry once, else re-login |
| `invalid_credentials` | login, 401 | wrong email/password |
| `missing_refresh_token` | refresh, 401 | no token supplied |
| `invalid_refresh_token` | refresh, 401 | refresh token dead/rotated-out → re-login |
| `rate_limited` | login/refresh, 429 | back off; retry after ≥ 1 min |

Cookie-mode failures keep their historical prose-only bodies (`{"error":
"Not authenticated"}` etc.) — the dashboard predates `code` and its contract
is frozen. Bearer-mode 401s from `requireClientAuth` always carry `code`.

---

## 3. Endpoints

### 3.1 `POST /client-auth/login`

Public. Rate-limited **10/min per IP** (429 `rate_limited`).

Request:
```json
{ "email": "user@example.com", "password": "…", "mode": "tokens" }
```
`mode: "tokens"` selects the mobile response. Omit it (or send anything else)
for the browser behaviour: tokens go into httpOnly cookies, body is
`{ "success": true, "email": "…" }`, unchanged from before.

Response `200` (token mode — **no cookies are set**):
```json
{
  "success": true,
  "email": "user@example.com",
  "token_type": "Bearer",
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "expires_in": 3600,
  "expires_at": 1767950000
}
```
`expires_in` seconds / `expires_at` unix-seconds for the access token.

Errors: `400` missing email/password · `401 invalid_credentials` ·
`429 rate_limited`.

### 3.2 `POST /client-auth/refresh`

Public (the refresh token *is* the credential). Rate-limited **60/min per IP**.

Request (mobile): `{ "refresh_token": "<opaque>" }` → response `200` with the
same body shape as token-mode login (the **rotated** pair). Cookies are
**never touched** in this transport — a mobile refresh can't disturb a
browser session sharing the connection.

Request (browser): empty body; the refresh token is read from the httpOnly
cookie, rotated tokens are re-set as cookies, and the JSON body stays
token-free (`{ "success": true, "email": "…" }`).

Errors: `401 missing_refresh_token` · `401 invalid_refresh_token` (browser
transport additionally clears both cookies; body transport does not) ·
`429 rate_limited`.

Rotation semantics: see §1. Never call refresh concurrently from two places
with the same token — the second call is a replay.

### 3.3 `POST /client-auth/logout`

Public, idempotent, **always `200 { "success": true }`**.

- **Mobile:** send `Authorization: Bearer <access_token>` and, if held,
  `{ "refresh_token": "…" }`. The server best-effort revokes the session
  server-side (scope: this session only — other devices stay logged in): a
  live access token is signed out directly; a dead access token with a live
  refresh token is revoked by consuming the refresh token and signing out the
  resulting session. Wipe the keystore afterwards regardless.
- **Browser:** no header → both session cookies are cleared and the same
  best-effort revocation runs from the cookie tokens.

Revocation failures (Supabase down, tokens already dead) are logged, never
surfaced: local credential destruction is the part that must not fail.

### 3.4 `GET /client-auth/me`

Auth: **either transport** (`requireClientAuth`). The app's session probe at
launch: cheap, side-effect-free in bearer mode.

Response `200`:
```json
{
  "success": true,
  "email": "user@example.com",
  "client": { "id": "pilot-plumbing", "name": "Pilot Plumbing" },
  "authMode": "bearer"
}
```
Errors: `401` (per-mode bodies, §2) · `403` authenticated user with no linked
client row. In cookie mode a valid refresh cookie may transparently rotate the
session (Set-Cookie on this response) — normal B1 behaviour.

### 3.5 `POST /voice/token` *(VoIP-gated)*

Auth: either transport + per-client `voip_enabled`. Rate-limited 10/min per
session+IP. **While `VOIP_V2_ENABLED` ≠ `"true"` server-side, this route (and
all §3.5–3.8 routes) does not exist — requests 404.**

Request: `{ "platform": "ios" }` (`"ios" | "android"`).

Response `200`: `{ "token": "<twilio-access-token-jwt>", "identity": "client_pilot_plumbing", "ttlSeconds": 3600 }`

Errors: `400` bad platform · `401`/`403` auth / `voip_enabled=false` ·
`429` · `503` platform's push credential not configured · `500` mint failure.

### 3.6 `POST /devices/register` *(VoIP-gated)*

Auth: either transport + `voip_enabled`. Rate-limited 10/min.

Request:
```json
{
  "platform": "ios",
  "pushTokenHash": "<sha256 hex of the raw push token — 64 chars>",
  "label": "Pete's iPhone 15",
  "appVersion": "1.0.0",
  "osVersion": "18.2"
}
```
The raw push token must **never** be sent — hash it on-device (the raw value
goes only to Twilio's SDK). Upserts on `(client, pushTokenHash)`;
re-registration refreshes the record and clears any revocation. Cap: 5 active
devices → `409` for a *new* device (re-registration is always allowed).

Response `200`: `{ "device": { "id": "<uuid>", "platform": "ios", "label": "…", "appVersion": "…", "osVersion": "…", "lastRegisteredAt": "…", "createdAt": "…" } }`

Errors: `400` validation (message lists all failures) · `401`/`403` · `409`
device cap · `429` · `500`.

### 3.7 `GET /devices` *(VoIP-gated)*

Auth: either transport + `voip_enabled`.

Response `200`: `{ "devices": [ <device object as in §3.6>, … ] }` — active
(non-revoked) devices, newest registration first. Token hashes are never
returned.

### 3.8 `POST /devices/revoke` *(VoIP-gated)*

Auth: either transport + `voip_enabled`. Rate-limited 10/min. Tenant-scoped:
only the caller's own devices are reachable.

Request: `{ "deviceId": "<uuid>" }`

Response `200`: `{ "revoked": true }` (soft revocation — the device stops
counting as active immediately; any minted Twilio token dies within its 1 h
TTL; Twilio push-binding deletion is wired when app-side SDK registration
exists, Phase 2).

Errors: `404 {"error": "device not found"}` — deliberately identical for
unknown, foreign-tenant, malformed, and already-revoked ids (no cross-tenant
existence oracle) · `401`/`403` · `429` · `500`.

---

## 4. Security posture summary

- **Single auth path:** bearer and cookie modes share validation, refresh
  logic, and tenant resolution — there is no second implementation to drift.
- **Tenant isolation:** `req.clientId` is always derived server-side from the
  verified Supabase user; RLS remains deny-by-default underneath.
- **Replay:** refresh rotation with Supabase family-revocation on reuse;
  access tokens are short-lived (~1 h). Server-side logout revocation kills
  the session before natural expiry.
- **Storage expectations:** mobile pair in Keychain/Keystore only; browser
  pair in httpOnly cookies only. No token is ever exposed to page JS.
- **Brute force:** login/refresh per-IP rate limits (plus the VoIP endpoints'
  existing D11 limits).
- **Expiries:** access ~1 h (Supabase project setting; `expires_in` is
  authoritative per response). Refresh tokens live until rotated, revoked, or
  reuse-detected; the *browser cookie* holding one caps at 30 days idle.

## 5. Operator endpoints are out of scope

`requireLogin` (operator HMAC-cookie session) is unchanged and cookie-only —
the operator dashboard is web-only by design. The mobile app never uses it.
