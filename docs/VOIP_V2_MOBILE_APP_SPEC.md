# VoIP v2 — Mobile App Specification

**Status:** spec for Phase 2–3 (M2–M3); no app code exists. **Owns:** the app's
behaviour contract — screens, lifecycle rules, platform obligations, and
acceptance criteria. Platform rationale (why native, why React Native, why
CallKit/ConnectionService are non-negotiable) lives in
[VOIP_V2_ARCHITECTURE.md](VOIP_V2_ARCHITECTURE.md) §5–9; backend contracts in
[VOIP_V2_BACKEND_SPEC.md](VOIP_V2_BACKEND_SPEC.md).

> **Hard entry gate (B1): ✅ cleared.** Client session refresh landed, and the
> mobile-auth compatibility layer with it: token-mode login/refresh, Bearer
> auth on every client endpoint, `GET /client-auth/me`, `/devices/revoke`.
> The app builds against [MOBILE_API_CONTRACT.md](MOBILE_API_CONTRACT.md).

---

## 1. Stack (affirms D2)

- **React Native, bare workflow** (Expo prebuild acceptable; Expo Go is not —
  VoIP push and ConnectionService need real native config).
- `@twilio/voice-react-native-sdk` (official Twilio SDK).
- **Platform order:** iOS first, unless pilot client #1 (B5) carries Android.
- **Repo:** separate repository (plan §7 recommendation; final call at Phase 2
  entry). CI: EAS or fastlane → TestFlight / Play closed testing.

## 2. Screens (MVP — deliberately minimal)

| Screen | Contents |
|---|---|
| **Login** | Email/password → `/client-auth/login` with `mode: "tokens"`; pair stored in Keychain/Keystore ([MOBILE_API_CONTRACT.md](MOBILE_API_CONTRACT.md) §1). No signup in-app (accounts come from the invite flow). |
| **Home / status** | Registration state ("Ready to receive calls" / warnings), device label, business name, logout. This screen is a diagnostic, not a product surface. |
| **Incoming call** | NOT ours — native CallKit (iOS) / CallStyle full-screen (Android) UI. We render nothing at ring time. |
| **In-call** | Caller number/name, duration, mute, speaker, hang up. Nothing else at MVP. |
| **Settings (minimal)** | Device label edit, re-register button, revoke-this-device, diagnostics view (last push ack, token expiry, SDK registration state). |

Out of scope at MVP (V2+): call history, contact browsing, outbound dialling,
multi-device management, transcripts.

## 3. Lifecycle contracts (the part that must be exactly right)

### 3.1 Registration
On **every** app launch AND foreground AND push-token rotation:
1. Ensure session valid (refresh via B1 mechanism; if irrecoverable → Login).
2. `POST /voice/token { platform }` → Access Token (TTL 1h).
3. `voice.register(accessToken)` — Twilio creates/updates the push binding.
4. `POST /devices/register { platform, pushTokenHash: sha256(rawPushToken), label, appVersion, osVersion }`.
   The raw push token never leaves the device except to Twilio's SDK.

### 3.2 Token refresh
Refresh (steps 2–3) on: app launch, app foreground, SDK token-expiry event,
and a timer at ~45min while foregrounded. Never cache past TTL. A refresh
failure while backgrounded is acceptable — the push still arrives (binding
outlives the token) and the app refreshes on wake; a refresh failure at
**answer time** must surface as decline (Twilio then routes to voicemail per
INV-2 — never leave the caller in dead air).

### 3.3 iOS — the non-negotiable contract
- On PushKit VoIP push: **synchronously** call
  `reportNewIncomingCall` (CallKit) **before any other work** — before
  network, before JS if possible (native module handles it). Violating this
  gets the app terminated and can stop ALL future VoIP pushes (architecture
  F3 — the platform death penalty).
- VoIP pushes are used **only** for calls (App Store review enforces).
- Entitlements: `UIBackgroundModes: voip, audio`; mic permission with a
  purpose string that mentions call answering.
- After reporting the call: fetch/verify token, `POST /voip/push-ack`, then
  accept/decline via CallKit actions wired to the Twilio SDK.

### 3.4 Android — the honest-degrade platform
- FCM **high-priority data** message → self-managed `ConnectionService`
  (`MANAGE_OWN_CALLS`) → CallStyle notification + full-screen intent.
- Permissions: `RECORD_AUDIO`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`
  (default-granted to calling apps per Jan-2025 policy), foreground service
  type `phoneCall`.
- **Onboarding must include battery-optimisation allowlisting** with
  OEM-specific guidance (Xiaomi/Huawei/Oppo/Vivo/OnePlus). Force-stop has no
  workaround: the call rings 20s server-side then falls to voicemail (INV-2).
  The Home screen shows a warning when the last push-ack is older than the
  last server-side dial attempt (staleness signal, D12).

### 3.5 Push-ack (the funnel metric)
The instant the push wakes the app (both platforms), fire-and-forget
`POST /voip/push-ack { callSid, receivedAt }`. This is the only way the
backend can distinguish "push sent" from "device actually woke" — it powers
the D12 ring-delivery metric and staleness detection (F1/F9).

### 3.6 Multi-device
All devices bind the same identity (`client_<slug>`); Twilio rings all active
bindings; first `accept()` wins; the rest receive a cancel and must dismiss
silently (no missed-call spam for a call a colleague answered — SDK handles
the race, F8; QA must test it explicitly).

## 4. Failure UX (mirrors architecture §11 — app side of each branch)

| Scenario | App behaviour |
|---|---|
| Decline | Single tap; SDK reject; nothing else. Caller reaches voicemail ≤8s. |
| Push arrives after Twilio gave up (>20s) | SDK delivers `CancelledCallInvite` → dismiss silently. Never show "missed call" for a call that reached voicemail — v1 already emails the owner the transcript. |
| Token expired at ring | Attempt refresh inside the CallKit window; on failure decline (→ voicemail). Log it. |
| Network loss mid-call | SDK reconnection (~30s window) with "reconnecting" UI; on failure the call ends — server's `<Dial action>` handles the rest. **The app never re-dials.** |
| Session dead (post-B1 refresh failed) | Home shows "signed out — calls go to voicemail until you log in". Truthful, not alarming. |

## 5. Security requirements

- Session/token storage: iOS Keychain / Android Keystore (via RN keychain
  lib). Nothing in AsyncStorage.
- No Twilio account credentials in the app, ever — only short-lived Access
  Tokens minted by `/voice/token` (per-client identity, 1h TTL).
- Push token: raw value only to the Twilio SDK; sha256 to our backend.
- No analytics/crash SDK at MVP that ships call metadata off-device (privacy
  posture matches the recording-consent stance, B2).
- Certificate pinning: not at MVP (Railway cert rotation risk > MITM risk for
  a pilot); revisit at V2.

## 6. Store obligations (blockers to schedule early — Q11)

- **Apple:** Developer account; App ID with Voice-over-IP + Push entitlements;
  APNs VoIP key (.p8) uploaded to Twilio as Push Credential (change-controlled
  per F7); TestFlight for Phase 3. Review will check: VoIP pushes only for
  calls, CallKit used, mic purpose string.
- **Google:** Play Console; calling-app declaration (needed for
  `USE_FULL_SCREEN_INTENT` default grant); closed-testing track; FCM
  credentials in Twilio.
- Listing identity/branding (Q11) must be settled before Phase 3 submission.

## 7. Acceptance criteria (app's share of architecture §15)

1. App **terminated** (not force-stopped), phone locked → incoming call rings
   with native UI, answerable, two-way audio (iOS: deterministic; Android:
   best-effort per §3.4).
2. Answered call → full v1 pipeline artifacts with `answered_via='voip'`
   within v1 SLA.
3. Decline → caller hears voicemail greeting ≤8s.
4. Airplane mode → caller reaches voicemail ≤25s; app shows staleness warning
   on next open.
5. Two devices: first answer wins; second dismisses silently.
6. Push-ack logged for ≥95% of delivered calls in drills (D12 baseline).
7. Hourly-logout does NOT occur (B1 verified in-app across a 24h soak).
