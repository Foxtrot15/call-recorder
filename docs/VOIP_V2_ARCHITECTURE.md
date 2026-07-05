# Aida VoIP v2 — Technical Design Document

**Status:** DRAFT — architecture/research only. No implementation exists. Nothing in
this document changes v1 behaviour until explicitly implemented and enabled per client.
**Author context:** written as the source of truth for phased implementation. Each
section is intended to be implementable without re-deriving decisions.
**Prime directive:** the v1 missed-call pipeline (conditional forwarding → Twilio
voicemail → Deepgram → Claude → Gmail/Calendar/CRM) works in production and MUST NOT
break. VoIP v2 is additive and per-client opt-in.

---

## Table of contents

1. [v1 recap and what v2 adds](#1-v1-recap)
2. [The routing loop problem — exact mechanics](#2-the-routing-loop-problem)
3. [The core architectural decision](#3-core-architectural-decision)
4. [System invariants](#4-system-invariants)
5. [Platform research: iOS](#5-platform-research-ios)
6. [Platform research: Android](#6-platform-research-android)
7. [Platform comparison summary](#7-platform-comparison-summary)
8. [Browser/PWA vs native](#8-browser-vs-native)
9. [Framework recommendation](#9-framework-recommendation)
10. [Authentication, tokens, and device management](#10-authentication-and-devices)
11. [Complete call flow](#11-complete-call-flow)
12. [Recording architecture](#12-recording-architecture)
13. [Failure mode catalogue](#13-failure-modes)
14. [Impact on the existing architecture](#14-existing-architecture-impact)
15. [MVP → V2 → V3](#15-mvp-v2-v3)
16. [Per-client cutover and rollback runbook](#16-cutover-runbook)
17. [Open questions](#17-open-questions)

---

## 1. v1 recap

Today (post-`1cdeaaa`):

```
Customer → owner's mobile number → rings owner's handset natively
                                  → (only if unanswered/busy/unreachable)
                                    carrier conditional forwarding **61/**62/**67
                                  → Twilio number → /inbound/voice
                                  → client resolved by twilio_number
                                  → Aida voicemail greeting → <Record>
                                  → /recording/complete (idempotent via claim_recording)
                                  → Deepgram → Claude → contacts/business-profile
                                  → Gmail draft / Calendar / notification email
```

**What v1 cannot see: every call the owner answers.** Answered calls complete
natively on the handset; the carrier never forwards them; Aida never knows they
happened. For a CRM/assistant product that is most of the interesting traffic.

**v2 goal:** capture answered calls too, with these hard constraints:
- Customers keep dialling the owner's existing mobile number. No advertised Twilio number.
- Answering must feel like a normal phone call (native incoming-call UI, lock screen,
  background, ringtone), not a web page.
- After the call, the existing pipeline runs unchanged.

## 2. The routing loop problem

### Why answered-call capture forces unconditional forwarding

Conditional forwarding (v1) only diverts calls the handset *didn't* answer. To put
Twilio in the media path of *answered* calls, Twilio must receive the call **before
the owner does** — which means **unconditional forwarding (CFU, `*21*`)**: the
carrier diverts every inbound call to the Twilio number immediately; the handset's
GSM line never rings for inbound calls at all.

### Why the naive design loops

Naive v2: Twilio receives the forwarded call, then delivers it by **dialling the
owner's mobile number** over the PSTN:

```
Customer → +61-OWNER (CFU active) ──carrier──▶ +61-TWILIO → /inbound/voice
                                                  │
                                                  ▼  <Dial>+61-OWNER</Dial>   ← the mistake
Twilio ──PSTN──▶ +61-OWNER (CFU active) ──carrier──▶ +61-TWILIO → /inbound/voice (again)
                                                  │
                                                  ▼  <Dial>+61-OWNER</Dial>
                                                 ... infinite
```

The mechanics, precisely:

1. A CFU rule lives **in the carrier network, keyed to the MSISDN** (the mobile
   number). It has no concept of *who* is calling or *why*. Any PSTN call to that
   number — including one originated by our own Twilio account — is diverted before
   the handset is ever paged.
2. So Twilio's delivery dial never reaches the handset. It arrives back at
   `/inbound/voice` as a brand-new inbound call (new `CallSid`, `ForwardedFrom` =
   owner's number when the carrier passes it, which AU carriers do unreliably).
3. If that webhook follows the same logic, it dials the owner again → another
   diverted leg → another webhook. Each cycle creates two billable call legs and the
   loop runs until something times out or trips Twilio's abuse detection.

### Why loop *detection* is not a solution

You can detect the loop (match `ForwardedFrom`, watermark the caller ID, count legs
per time window) and stop the spiral — but detection cannot make the owner's phone
ring. **While CFU is active, the owner's mobile number is unreachable by PSTN, by
definition.** There is no header, caller ID trick, or retry strategy that changes
that. The delivery leg must not be a PSTN call to that number. Full stop.

(Detection is still worth having as defence-in-depth — see the guards in §4 — but it
is a tripwire, not a routing strategy.)

### The escape hatch

Deliver the call **off the PSTN entirely**: over IP, to an application endpoint
(a Twilio Voice SDK "Client" identity) registered by an app on the owner's phone.
Carrier forwarding rules cannot see an IP leg. The loop becomes impossible *by
construction*, not by mitigation:

```
Customer → +61-OWNER (CFU) ──carrier──▶ +61-TWILIO → /inbound/voice
                                            │
                                            ▼  <Dial><Client>client_xyz</Client></Dial>
Twilio ──APNs VoIP push / FCM──▶ owner's app → native incoming-call UI → answered
                                            │  (media over IP: WebRTC/Twilio SDK)
                                            ▼  on failure/timeout/decline
                                        existing Aida voicemail (v1 flow, unchanged)
```

## 3. Core architectural decision

> **DECISION D1:** Answered-call delivery uses Twilio Programmable Voice SDK
> ("Twilio Client") to a native mobile app, dialled via `<Dial><Client>` from the
> existing `/inbound/voice` webhook. The PSTN is never used for the delivery leg.
> Fallback for every delivery failure is the existing v1 voicemail flow — never a
> PSTN redial.

Supporting decisions, argued in later sections:

- **D2:** Native app (React Native + official Twilio Voice RN SDK), not browser/PWA (§8–9).
- **D3:** Recording stays entirely in Twilio via `record` on the `<Dial>` verb (§12).
- **D4:** One Twilio identity per business (`client_<slug>`), multiple device
  bindings under it; devices tracked in our own table (§10).
- **D5:** VoIP is a per-client feature flag; clients without it (or with no live
  device registrations) behave exactly as v1 (§4, INV-3).
- **D6:** Twilio delivers the wake-up pushes itself (APNs VoIP / FCM) using Push
  Credentials configured in the Twilio console; our backend never sends call pushes.
  This removes an entire class of push-delivery code and failure modes from our side.

## 4. System invariants

These are the rules that keep v2 from breaking v1 or looping. Every implementation
phase must preserve all of them; they belong in code review checklists and, where
marked, as runtime guards.

| # | Invariant | Enforcement |
|---|---|---|
| INV-1 | While a client has CFU active (`voip_enabled = true`), the platform must **never place a PSTN call to that client's `real_number`**. This includes `/call/initiate`, which today dials `CLIENT_REAL_NUMBER` and would loop. | Runtime guard: any code path about to dial a number checks it against the client's `real_number` when `voip_enabled`; refuses and logs `🚨 LOOP GUARD`. Plus code review rule. |
| INV-2 | Every delivery failure (timeout, decline, offline, no devices, push failure) falls through to the **existing voicemail flow** — never a redial, never a second `<Dial>`. | The `<Dial action>` handler has exactly two branches: completed → end; anything else → voicemail TwiML. |
| INV-3 | VoIP is opt-in per client. `voip_enabled = false` (or no active device registrations) ⇒ byte-identical v1 behaviour. Conditional-forwarding clients are untouched. | Branch guard at the top of the new code path in `/inbound/voice`. |
| INV-4 | The recording → `/recording/complete` → pipeline contract does not change. v2 produces recordings through the same webhook with the same idempotency (`claim_recording`). | No changes to `recording.js` interface; `<Dial record>` reuses the same `recordingStatusCallback`. |
| INV-5 | Loop tripwire (defence-in-depth): `/inbound/voice` rejects with a logged error any call whose `From` equals one of our own Twilio numbers, and rate-limits repeated inbound legs for the same (`From`,`To`) pair within a few seconds. | Runtime check; alerts loudly, answers with a polite failure message, never dials. |
| INV-6 | Client identity strings are derived deterministically from the slug (`client_` + slug with `-` → `_`), never from user input. | Single helper function, used everywhere. |

## 5. Platform research: iOS

### Required pieces

| Piece | Role | Mandatory? |
|---|---|---|
| **CallKit** (`CXProvider`, `CXCallController`) | Native incoming-call UI: full-screen ring on lock screen, banner when unlocked, native in-call screen, call audio session priority, Bluetooth/CarPlay/Watch surfaces, integration with the phone's call history (optional) | Yes — this *is* the "feels like a normal call" requirement |
| **PushKit** (VoIP pushes) | Wakes the app for an incoming call from background **or fully terminated** state, with high priority | Yes — ordinary APNs pushes cannot reliably launch call UI from terminated state |
| **Twilio Voice iOS SDK** (or the RN SDK wrapping it) | Registration (binds identity → APNs VoIP token via Twilio), signalling, WebRTC media, `CallInvite` handling | Yes |
| APNs **VoIP Services certificate/key** uploaded to Twilio as a **Push Credential** | Lets Twilio send the VoIP push directly | Yes |
| `UIBackgroundModes: voip, audio` | Background execution during calls | Yes |
| Microphone permission (`NSMicrophoneUsageDescription`) | Call audio | Yes (one-time prompt) |

### The iOS 13+ contract (unchanged through iOS 18)

When a VoIP push arrives, the app **must synchronously report an incoming call to
CallKit** (`reportNewIncomingCall`) inside the push handler, *before* doing anything
else (network fetches come after). If it doesn't, iOS terminates the app, and
repeated violations cause the system to **stop delivering VoIP pushes to that app
entirely**. Consequences for our design:

- The push payload (which Twilio controls) is sufficient to ring — the app must not
  need a server round-trip before showing the call UI. Caller display name comes
  from the push (`From` number); contact enrichment can update the UI afterwards.
- VoIP pushes may be used **only** for calls (App Store review enforces this).
  Any non-call notification (e.g. "new voicemail transcribed") must use regular APNs.

### Background / lock screen / battery

- **Terminated app:** PushKit relaunches it; ringing works. This is the single
  biggest reliability advantage over Android.
- **Lock screen:** full native call UI (slide to answer), identical to a carrier call
  apart from a small app badge/label.
- **Silent switch / Focus:** behaves like a phone call — Focus modes and the silent
  switch can suppress the *ringtone*, but the call still presents. Same failure
  surface as a native call, which is the right bar.
- **Battery:** no polling, no persistent socket needed; PushKit is push-driven, so
  idle battery cost is ~zero. In-call cost is comparable to any VoIP call.
- **Low Power Mode:** VoIP pushes still deliver (high priority).
- **Known edge:** China App Store builds have CallKit restrictions — irrelevant for
  the AU market, noted for completeness.

### Reliability verdict

Excellent. Apple's model is restrictive but deterministic: if the device has any
usable network, the call rings, even from terminated state. The main residual risks
are (a) user disabled notifications for the app — CallKit still works, as VoIP push
≠ notification, (b) no network (falls to voicemail by design), (c) the iOS 13
contract being violated by buggy code (CI-testable).

## 6. Platform research: Android

### Required pieces

| Piece | Role | Mandatory? |
|---|---|---|
| **FCM high-priority *data* message** | Wakes the app for an incoming call. Must be a data message (notification-type messages are tray-delivered and Doze-delayed); high priority exempts it from Doze batching | Yes |
| **Telecom Framework / self-managed `ConnectionService`** (`MANAGE_OWN_CALLS`) | Registers the app as a calling app with the OS: native audio routing, correct interaction with carrier calls (hold/busy signalling), Bluetooth, and — critically since Jan 2025 — qualifies the app for full-screen incoming-call UI | Yes (see policy note) |
| **`CallStyle` notification + full-screen intent** | The actual incoming-call presentation: full-screen ring when locked, heads-up when unlocked | Yes |
| **Twilio Voice Android SDK** (or RN SDK) | Registration (identity → FCM token binding via Twilio), signalling, media | Yes |
| FCM server key/config uploaded to Twilio as a **Push Credential** | Twilio sends the FCM message | Yes |
| Foreground service, type `phoneCall` (`FOREGROUND_SERVICE_PHONE_CALL`) | Keeps the process alive with mic access during the call | Yes |
| Runtime permissions | `POST_NOTIFICATIONS` (Android 13+), `RECORD_AUDIO`; `USE_FULL_SCREEN_INTENT` (see below) | Yes |

### The Android 14/15 + Play policy landscape (as of 2025-01-22 enforcement)

`USE_FULL_SCREEN_INTENT` is now **granted by default only to apps whose core
function is calling or alarms**; Play revokes it for others, and the system then
silently downgrades the full-screen ring to a heads-up banner. Aida's app *is* a
calling app (self-managed ConnectionService, CallStyle notifications), so it
qualifies — but this must be declared correctly in the Play listing, and the app
should detect-and-degrade (`NotificationManager.canUseFullScreenIntent()`), falling
back to a high-priority `CATEGORY_CALL` heads-up notification with answer/decline
actions.

### Background / lock screen / battery

- **Terminated app:** a high-priority FCM data message *can* start the process and
  post the call UI — **unless** the app is in the "force-stopped" state (user swiped
  it away on some OEMs, or explicitly force-stopped it, or an aggressive OEM
  "battery optimizer" killed it). In that state FCM is not delivered until the user
  next opens the app. This is Android's structural reliability gap.
- **OEM battery killers:** Xiaomi/Huawei/Oppo/Vivo/OnePlus aggressively kill
  background apps beyond AOSP rules. Mitigations: onboarding checklist per OEM
  (disable optimization for Aida), `setExactAndAllowWhileIdle`-class exemptions are
  NOT applicable to calls — the honest mitigation is the voicemail fallback: a
  killed app means the call becomes a v1-style voicemail, which is degraded but not
  lost.
- **Lock screen:** full-screen intent gives a native-feeling ring screen; with
  ConnectionService the OS treats it as a real call for audio focus and Bluetooth.
- **Battery:** push-driven like iOS; idle cost ~zero; in-call foreground service is
  standard VoIP cost.

### Reliability verdict

Good on Pixel/Samsung with defaults; materially worse on aggressive OEMs and after
force-stop. Design consequence: **Android reliability is a UX-managed risk, not a
solved problem** — the product must treat "phone didn't ring, went to Aida
voicemail" as an acceptable degraded mode (it is: that's exactly v1 behaviour), and
onboarding must include the OEM checklist.

## 7. Platform comparison summary

| Dimension | iOS | Android |
|---|---|---|
| Wake from terminated | ✅ PushKit, deterministic | ⚠️ FCM data message; fails after force-stop / OEM kills |
| Lock-screen native ring | ✅ CallKit, system UI | ✅ full-screen intent (calling-app qualification required) |
| OS treats it as a real call | ✅ CallKit | ✅ self-managed ConnectionService |
| Push transport | Twilio → APNs VoIP (via Push Credential) | Twilio → FCM high-priority data (via Push Credential) |
| Hard platform rules | Report to CallKit synchronously on every VoIP push (iOS 13+, unchanged through 18); VoIP pushes for calls only | FSI restricted to calling/alarm apps (Play, Jan 2025); FGS type `phoneCall`; `POST_NOTIFICATIONS` runtime permission |
| Battery (idle) | ~zero | ~zero |
| Worst-case failure | No network → voicemail | Killed app → voicemail (more frequent than iOS) |
| Relative implementation risk | Lower (strict but documented) | Higher (fragmentation, OEM variance) |

**Sequencing implication:** ship iOS first unless pilot client #1 carries Android —
the platform with deterministic wake behaviour is the right place to debug the
*product*, before taking on Android's *platform* variance. (Decide per §17 Q2.)

## 8. Browser vs native

**A browser/PWA cannot deliver this experience. This is a hard platform limit, not
an engineering-effort question.**

| Requirement | Browser/PWA reality |
|---|---|
| Ring when the app isn't open | iOS Safari/PWA has no PushKit and no CallKit access; Web Push (iOS 16.4+) requires the PWA installed to Home Screen, shows only a standard notification banner — no ring, no full-screen call UI, easily missed |
| Ring on the lock screen | Impossible on iOS web. Android Chrome can show a notification; no full-screen incoming-call surface, no Telecom integration |
| Answer without unlocking / app-launch delay | Tapping a web notification opens a browser tab, *then* JS boots, *then* WebRTC connects — 5–15 s of dead air against a 15–20 s dial timeout |
| Reliable background execution | Service workers are aggressively evicted on both platforms; no VoIP-class background privilege exists for web |
| Native call semantics (audio focus, Bluetooth, carrier-call interaction) | Not available to web apps |

The only case where browser calling works acceptably is a **desk-bound agent with
the tab open** (classic contact-centre softphone, Twilio Voice JS SDK). That is not
Aida's user — a tradesperson's phone in a pocket. A web dashboard "answer on
desktop" feature is a plausible V3 add-on; it cannot be the primary channel.

## 9. Framework recommendation

Candidates: native Swift + Kotlin ×2, React Native, Flutter, Capacitor.

- **Capacitor** — eliminated: it's a web view; the call UI/push/Telecom work would
  all be native plugins anyway, inheriting §8's problems for the app shell plus
  plugin-maintenance burden with no vendor SDK.
- **Flutter** — viable ecosystem (`twilio_voice` community package) but **no
  first-party Twilio SDK**; the calling-critical layer would rest on community
  maintenance. Rejected for a calling-first product.
- **Two native apps** — best control, double the surface area and maintenance for a
  solo-operator project. Rejected on cost; revisit only if RN hits a wall.
- **React Native** — **Twilio ships an official Voice React Native SDK (2.x)**:
  GA, wraps the native iOS/Android Voice SDKs, includes CallKit integration and
  Android call notifications, supports Expo. One codebase, JS/TS skills reuse
  (the whole existing stack is JS), and the escape hatch of dropping to the
  underlying native SDKs if needed.

> **DECISION D2 (final): React Native + `@twilio/voice-react-native-sdk`**, bare
> workflow (not Expo Go — VoIP push and ConnectionService need real native config;
> Expo prebuild is acceptable). App codebase lives in a new repo or `app/`
> directory — decision Q6 in §17.

## 10. Authentication and devices

### Principles

- Reuse the existing client identity system: an app user *is* a client-dashboard
  user (Supabase Auth via `/client-auth/login`, `requireClientAuth` semantics).
  No new identity provider.
- Twilio **Access Tokens** are short-lived credentials minted by our server; the
  app never holds Twilio account credentials.
- Our server is the source of truth for *which devices may ring*; Twilio's
  registration bindings are a projection of that.

### Access token endpoint

- `POST /voice/token` (new route, gated by the client session — same middleware
  family as `/client-dashboard`).
- Server mints a Twilio `AccessToken` with a `VoiceGrant`:
  - `identity = client_<slug_with_underscores>` (INV-6),
  - `incomingAllow = true`,
  - `pushCredentialSid` = APNs or FCM credential depending on the device platform
    (sent by the app in the request).
- **TTL: 1 hour** (Twilio max is 24 h; keep it short — revocation is TTL-bounded,
  see below). App refreshes on: launch, foreground, registration, and token-expiry
  events from the SDK.
- New env: `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` (Access Tokens are signed
  with an API key, not the account auth token), `TWILIO_APNS_PUSH_CREDENTIAL_SID`,
  `TWILIO_FCM_PUSH_CREDENTIAL_SID`.
- **Dependency:** the client-session refresh problem (Phase 5 item 5 — sessions die
  after ~1 h) must be fixed before the app ships, or the app re-prompts for login
  hourly. This is now a blocking prerequisite, not a nice-to-have.

### Device registry (new table: `devices`)

One row per installed app instance:

| Column | Purpose |
|---|---|
| `id` (uuid) | PK |
| `client_id` (slug) | Tenant owner |
| `auth_user_id` | Which login registered it |
| `platform` (`ios` \| `android`) | Push credential selection |
| `push_token_hash` | Dedup/rotation detection (store a hash; the raw token lives only in Twilio's binding) |
| `label` | "Pete's iPhone 15" — user-facing device management |
| `app_version`, `os_version` | Support/debug |
| `last_registered_at`, `last_seen_at` | Staleness detection |
| `revoked_at` (nullable) | Soft revocation |

### Registration flow

1. App logs in (client session) → `POST /voice/token` → receives Access Token.
2. App calls SDK `register(accessToken)` — **Twilio** creates/updates the binding
   (identity ↔ APNs/FCM token). Our server does not talk to APNs/FCM.
3. App calls `POST /devices/register` with platform/label/token-hash → server
   upserts the `devices` row. (Two registrations by design: Twilio's binding makes
   ringing work; our row makes *management* work.)
4. Re-register on every app launch and on push-token rotation (OS rotates tokens;
   the SDK surfaces this).

### Multiple devices / simultaneous logins

- All of a client's devices bind to the **same identity**. Twilio rings **all
  active bindings simultaneously**; first `accept()` wins; the others receive a
  cancel push and dismiss their UI. This is exactly the desired "your phone and
  your iPad both ring" behaviour, with zero server logic.
- Practical binding limits exist at Twilio (~order of 10 per identity); enforce our
  own cap (5) at `/devices/register` with a clear error.
- Simultaneous logins are therefore allowed and useful, not a conflict case.

### Revocation and expiry

- **Revoke a device** (lost phone, ex-employee): set `revoked_at`; server calls the
  SDK-equivalent unregistration (Twilio REST: delete the binding) so it stops
  ringing immediately. The device's cached Access Token dies within ≤ 1 h (TTL);
  its next `/voice/token` call is refused (session revoked / device row revoked).
- **Expired token at ring time:** the incoming push still arrives (push delivery is
  keyed to the binding, not the token). The SDK needs a valid token to *accept*;
  the app's on-push handler refreshes the token via `/voice/token` in parallel with
  showing the CallKit/Telecom UI (UI first — iOS contract, §5). If refresh fails
  (no session), the app must decline gracefully → INV-2 voicemail.
- **Offline device:** binding remains; push is undelivered or late; the `<Dial>`
  timeout (§11) bounds the customer's wait; voicemail fallback fires. Late-arriving
  pushes after the dial ended are answered by a `CancelledCallInvite` from Twilio —
  the app must handle "ring arrived but call already gone" by dismissing silently.
- **Stale devices:** any device not registered for N days (30) is auto-revoked by a
  cleanup job or lazily at next token request — prevents zombie bindings ringing
  into the void and eating the dial timeout. (Note: Twilio bindings also expire on
  their own after long inactivity; our cleanup just keeps the two views consistent.)

## 11. Complete call flow

### Happy path

```
 1. Customer dials +61-OWNER (the number on the van/website — unchanged)
 2. Carrier CFU (*21*) diverts immediately → +61-TWILIO        [~1–2 s, customer hears ringback]
 3. Twilio → POST /inbound/voice (signature-validated, as today)
 4. Server: client = getClientByTwilioNumber(To)                [existing]
 5. Server: pre-dial checks (all existing services):
      a. personal contact? (isPersonalCall(client, From))       → see §12: dial WITHOUT record
      b. pipeline paused? (client_settings.pipeline_enabled)    → still deliver call; skip pipeline later (existing behaviour)
      c. voip_enabled && ≥1 active device?  NO → v1 voicemail path (INV-3)
 6. Server inserts calls row: { call_sid, client_id, caller_number, direction:
    inbound, status: ringing, answered_via: pending }
 7. Server responds with TwiML (illustrative sketch, not implementation):
      <Dial answerOnBridge="true" timeout="20"
            record="record-from-answer-dual"
            recordingStatusCallback="/recording/complete"
            action="/voip/dial-result">
        <Client>client_pilot_plumbing</Client>
      </Dial>
    answerOnBridge keeps real ringback playing to the customer until answer.
 8. Twilio sends APNs-VoIP / FCM push to every active binding   [~1–3 s]
 9. App wakes (even from terminated on iOS): synchronously reports to
    CallKit / posts CallStyle+FSI notification. Owner sees a native incoming
    call: "0412 345 678 — via Aida". Total customer wait so far: ~2 extra
    ring cycles vs. a direct call. This latency is inherent; set expectations.
10. Owner answers → SDK accept() → WebRTC media bridges → normal conversation.
    Other devices get cancel → dismiss.
11. Call ends (either side) → Twilio fires /voip/dial-result with
    DialCallStatus=completed → respond <Hangup/>; server marks calls row
    { status: complete-pending-recording, answered_via: voip, answered_at }.
12. Recording completes → POST /recording/complete → claim_recording →
    EXISTING PIPELINE VERBATIM: Deepgram → Claude → contacts → business
    profile → Gmail draft → Calendar → notification email → dashboard.
```

Step 12 is the whole point of the architecture: the pipeline cannot tell a v2
answered call from a v1 voicemail except by the `answered_via` column.

### Failure branches (all terminate in INV-2's voicemail, never a redial)

| Branch | Trigger | Customer experience | System behaviour |
|---|---|---|---|
| **Timeout / no answer** | 20 s dial timeout expires (owner busy IRL, phone in truck) | ~20 s ringback, then Aida greeting | `action` fires, `DialCallStatus=no-answer` → voicemail TwiML (greeting + `<Record>` with same callbacks). calls row: `answered_via: voicemail`, `dial_status: no-answer` |
| **Explicit decline** | Owner taps Decline | Ringback cut short (~5 s), straight to greeting — *faster* than timeout, good UX | `DialCallStatus=busy` → same voicemail branch |
| **App killed (iOS)** | — | Indistinguishable from happy path — PushKit relaunches | Normal flow |
| **App killed/force-stopped (Android)** | OEM killer, user force-stop | Rings 20 s → voicemail | Push undelivered; timeout branch. Mitigation: OEM onboarding checklist; `last_seen_at` staleness surfacing in dashboard ("your phone hasn't checked in for 3 days") |
| **Phone offline** (no data/airplane) | — | Rings 20 s → voicemail | Same as above. Note: with CFU active there is no GSM fallback ring — offline means voicemail, full stop. Must be explained to the owner at onboarding |
| **Token expired at ring** | Session dead, refresh fails | Ring UI appears then self-dismisses; call → voicemail after timeout | App declines; log + push a normal notification "Aida couldn't take the call — open the app to re-login" |
| **Network loss mid-call** | Owner drives into a dead zone | Audio dies; SDK attempts ICE restart/reconnect (~30 s window); else call ends | Twilio ends the call; recording preserves everything up to the drop; pipeline runs on the partial call. Owner sees the number in the dashboard/notification and can ring back — **from the app (V2 feature) or their handset's normal dialler** (outbound calls from the handset are unaffected by CFU) |
| **Second simultaneous inbound call** | Customer B calls while owner talks to A | B hears ringback then voicemail (decline-when-busy via CallKit/Telecom busy state), or immediate voicemail if we pre-check an active-call flag | MVP: let it ring all devices; owner's OS shows call-waiting-style UI; if unanswered → voicemail. Refinement is a V2 concern |
| **Twilio platform outage** | Rare | Carrier CFU still delivers to Twilio's number: if Twilio is down at the webhook level, carrier hears failure → customer gets carrier-level failure tone | Accepted platform risk, same exposure as v1. Document status page in INCIDENT_RESPONSE.md when v2 ships |
| **All pushes late (>20 s)** | Extreme network weirdness | Voicemail; then owner's phone shows a ghost ring | App receives `CancelledCallInvite` → dismiss silently; optionally show "missed call via Aida" local notification pointing at the dashboard entry |

### Voicemail fallback detail

The fallback TwiML is **exactly the v1 block** (custom greeting lookup →
`<Play>`/`<Say>` → `<Record maxLength=180 recordingStatusCallback=/recording/complete
action=/inbound/voicemail-complete>`). Implementation note for later: extract v1's
greeting+record TwiML into a shared helper used by both the v1 path and the v2
`action` handler, so there is one voicemail implementation, not two (this refactor
touches `inbound.js` and is the *only* change to existing flow — INV-3 gate above it).

## 12. Recording architecture

> **DECISION D3: recording stays 100 % in Twilio.** `record-from-answer-dual` on the
> `<Dial>`, same `recordingStatusCallback` as today.

| Consideration | Twilio-side (chosen) | On-device |
|---|---|---|
| Pipeline compatibility | Identical to v1 — same webhook, same idempotency, zero pipeline changes (INV-4) | New upload path, new race conditions, new idempotency story |
| Survives app death mid-call | ✅ recording continues server-side to the moment the call drops | ❌ lost or truncated |
| Dual-channel (agent/customer separation for diarization) | ✅ `record-from-answer-dual` | ❌ single mixed channel from the mic/earpiece, worse Deepgram results |
| Battery/CPU on handset | none | continuous encode + upload on a phone that's also doing WebRTC |
| Upload reliability | n/a (already in Twilio) | retries, partial uploads, storage pressure, user kills app before upload |
| Platform policy | n/a | iOS call recording APIs are effectively unavailable to third parties; would require recording our own WebRTC streams in-app — possible but pure added complexity |
| Legal posture | Recording happens at the platform level under the business's Twilio account — consistent, auditable | Device-level recording varies by OS behaviour and is harder to make consistent |

On-device recording has **no advantage** in this architecture and five disadvantages.
The only scenario where it would matter — capturing calls that never touch Twilio —
doesn't exist here, because CFU puts every inbound call through Twilio by design.

Two recording-policy refinements enabled by v2 (both cheap, both worth doing at MVP):

1. **Personal-contact pre-check:** v1 filters personal calls *after* transcription.
   In v2 we know `From` before dialling — if `isPersonalCall()` is true, issue the
   `<Dial>` **without** the `record` attribute: the owner's mum gets a normal
   un-recorded call through the app, and no transcript ever exists. Strictly better
   privacy than v1.
2. **Scope note for legal review (§17 Q1):** v1 recorded only voicemails (caller
   knowingly leaves a message after a beep). v2 records live two-party
   conversations — a materially different consent posture under Australian state
   surveillance/listening-devices laws, which vary by state. This needs a real
   legal answer before pilot cutover, including whether a recording announcement is
   required and what it does to the "invisible Aida" product goal.

## 13. Failure modes

Beyond the call-flow branches (§11), the systemic failure catalogue:

| # | Failure | Cause | User experience | Backend behaviour | Recovery |
|---|---|---|---|---|---|
| F1 | CFU silently dropped | Carrier reset, SIM swap, plan change, dual-SIM confusion | Calls ring the handset natively again; Aida sees nothing; owner may not notice for days | No signal at all — absence of traffic | Detection: dashboard warning when a voip_enabled client has zero inbound legs for N hours during business hours; onboarding teaches the `*#21#` status-check code |
| F2 | Push binding rot | OS rotated push token; app not launched for weeks; binding expired | Phone doesn't ring; calls → voicemail | Dial times out every call | `last_registered_at` staleness alert; re-register on every launch; regular APNs (non-VoIP) nudge "open Aida to stay connected" |
| F3 | iOS contract violation | Code path fails to report to CallKit on a push | iOS kills app; after repeats, silently stops all VoIP pushes → phone never rings again until reinstall | Looks identical to F2 from the server | CI test for the handler; SDK does this correctly out of the box — do not hand-roll the push handler |
| F4 | Loop guard trip | Regression re-introduces a PSTN dial to `real_number`, or a second Aida-like service forwards into us | One failed call; customer hears error message | INV-5 tripwire: reject, log `🚨 LOOP GUARD`, alert | Fix the regression; the tripwire caps blast radius to single calls |
| F5 | Recording callback lost | Twilio retry exhaustion, server down at callback time | Call happened, no transcript/email | calls row stuck without recording; `recording_url` never set | Existing `claim_recording` handles dupes; add a reconciliation job (V2): poll Twilio Recordings API for calls stuck > 1 h |
| F6 | Access-token endpoint down | Server outage | Existing calls unaffected (tokens cached); new registrations/answers fail after TTL → voicemail | 5xx on `/voice/token` | Standard uptime concern; voicemail degradation is automatic |
| F7 | Push credential expiry | APNs key revoked / FCM key rotated without updating Twilio | All devices on that platform stop ringing | Dial timeouts platform-wide | Ops runbook entry: credentials have no natural expiry (APNs .p8 keys don't expire) but console changes must be change-controlled |
| F8 | Owner answers on two devices | Race between accept() calls | One device wins; the other shows a brief connecting state then drops | Twilio resolves the race; loser gets cancelled | SDK-handled; test explicitly in QA |
| F9 | Battery-optimized Android silently degrades | OEM policy change via OTA update | Gradual increase in voicemail-instead-of-ring for that client | Statistical, not per-event | Per-client answer-rate metric in dashboard (V2); OEM checklist re-run |
| F10 | Customer withheld/blocked number | `From` empty or anonymous | Call rings with "No Caller ID"; pipeline gets no contact key | `getOrCreateContact(null)` no-ops (existing) | Already handled by v1 semantics; verify in QA |

## 14. Existing architecture impact

### Unchanged (do not touch)

- `services/`: `transcribe.js`, `analyse.js`, `contacts.js`, `business-profile.js`,
  `personal-filter.js`, `gmail.js`, `gcal.js`, `notify.js`, `token.js`,
  `supabase.js`, `client-auth.js`, `invite.js`, `clients.js`
- `routes/`: `recording.js` (the entire pipeline), `client-dashboard.js`,
  `calls.js`, `settings.js`, `voicemail.js`, `personal-contacts.js`, `login.js`,
  `auth.js` (Google OAuth), `client-auth.js`
- The operator dashboard and client dashboard web apps
- All Phase 1–4 security work (v2 *depends* on it: token endpoint auth = client
  sessions; invite flow = how app users get accounts)

### Modified (exactly two files, both behind INV-3 gates)

1. **`routes/inbound.js`** — insert the v2 branch after client resolution:
   `voip_enabled && activeDevices ? dialClient() : existingVoicemailFlow()`, and
   extract the voicemail TwiML into a shared helper. The v1 path must remain
   byte-equivalent for non-VoIP clients.
2. **`routes/call.js`** — INV-1 guard: refuse to dial `real_number` for
   voip_enabled clients (this endpoint is a live loop hazard the moment CFU turns
   on). Its replacement (app-originated outbound) is V2 scope.

### New backend surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /voice/token` | client session | Mint Twilio Access Token (VoiceGrant + push credential) |
| `POST /devices/register` | client session | Upsert device row |
| `POST /devices/revoke` | client session (own devices) / operator | Revoke + unbind |
| `GET /devices` | client session / operator | List for management UI |
| `POST /voip/dial-result` | Twilio signature | `<Dial action>` — completed vs. fallback-to-voicemail |
| `POST /voip/call-status` | Twilio signature | Optional status callbacks (ringing/answered/completed) for the calls row lifecycle |

### Database changes (descriptive — no SQL per current constraints)

- New table `devices` (§10).
- `clients`: add `voip_enabled` (boolean, default false).
- `calls`: add `answered_via` (`voip` \| `voicemail` \| `bridge`), `dial_status`,
  `answered_at`. All nullable/backward-compatible; the pipeline ignores them.

### Auth changes

- None structural — the app authenticates as a client-dashboard user. **Blocking
  prerequisite:** Phase 5 item 5 (refresh-token/session longevity), because an app
  that logs out hourly cannot hold a live registration trustworthily.

### Env / deployment

- New env: `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
  `TWILIO_APNS_PUSH_CREDENTIAL_SID`, `TWILIO_FCM_PUSH_CREDENTIAL_SID`.
- Twilio console: create API key, upload APNs VoIP key (.p8) and FCM credentials as
  Push Credentials. Change-controlled (F7).
- Apple: Developer account, App ID with Push/VoIP entitlements, APNs key,
  TestFlight for the pilot. App Review notes: CallKit apps get scrutiny — VoIP push
  used strictly for calls, background modes justified.
- Google: Play Console, calling-app declaration (FSI qualification), closed testing
  track for pilot.
- Server stays on Railway unchanged.

## 15. MVP-V2-V3

### MVP — "one owner's iPhone rings"

Smallest production-ready slice. Scope discipline is the deliverable.

**In:**
- Backend: `voip_enabled` flag + `devices` table + `/voice/token` +
  `/devices/register` + inbound branch + `/voip/dial-result` + INV-1/INV-5 guards.
- App (RN, **one platform** — per Q2, default iOS): login (existing client auth),
  device registration, receive call (CallKit UI), answer/decline, in-call screen
  with mute/speaker/hang-up, token refresh. Nothing else — no call history, no
  settings, no contacts (the web dashboards already exist for that).
- Personal-contact pre-check (no-record dial).
- Pilot cutover runbook execution (§16).

**Out (explicitly):** Android (or iOS, whichever isn't first), outbound calls from
app, multi-device management UI, in-app history, transfer, real-time anything.

**MVP acceptance criteria:**
1. Answered call → full pipeline artifacts (transcript, summary, email, CRM) within
   the same SLA as v1 voicemails, with `answered_via = voip`.
2. App terminated (swiped away) → still rings.
3. Decline → customer in voicemail ≤ 8 s from decline.
4. Airplane mode → customer in voicemail ≤ 25 s; no crash, no ghost UI on
   reconnect.
5. A conditional-forwarding (non-VoIP) client's calls are byte-identical to
   pre-MVP behaviour.
6. `/call/initiate` refuses to dial a voip_enabled client's `real_number` (INV-1
   verified by test).
7. Personal contact calls through, un-recorded.

**Suggested implementation phases for MVP** (each independently verifiable):
- **M1** Backend complete behind the flag; verified with Twilio's quickstart app as
  a stand-in client (no app code yet).
- **M2** RN app skeleton: auth + token + registration (verify binding exists via
  Twilio console).
- **M3** Inbound e2e on TestFlight on the pilot phone.
- **M4** Failure drills: every §11 branch exercised deliberately.
- **M5** Cutover per §16.

### V2 — "product, not prototype"

- Second platform (Android, with OEM onboarding checklist + answer-rate telemetry).
- Outbound calls from the app (Twilio Client outbound with the business's Twilio
  number — or verified `real_number` — as caller ID). Retires the `/call/initiate`
  PSTN hazard and the dial-the-bridge UX.
- Multi-device management UI (list/revoke in dashboards; the backend already
  supports it from MVP).
- Recording reconciliation job (F5), answer-rate and ring-latency metrics,
  `last_seen` staleness warnings (F1/F2 detection).
- Call-waiting/busy handling policy.
- Voicemail-transcript push notification (regular APNs/FCM, not VoIP push).

### V3 — "Aida answers first" (strategic options, decide later)

- Real-time transcription via Twilio Media Streams → Deepgram streaming; live
  in-call context card on the owner's screen.
- AI screening/concierge: Aida answers, qualifies ("who's calling, what about?"),
  then warm-transfers to the owner's app with context — the delivery leg
  architecture (this document) is exactly the transfer target it needs.
- Browser answering for desk workers (Voice JS SDK) as a secondary endpoint.
- Multi-staff routing (ring groups: multiple identities per business).
- **Number porting** as the forwarding-killer: port the business number to Twilio
  outright — no CFU, no carrier variance, no loop surface at all. Rejected for
  MVP/V2 because porting a personal mobile number moves the owner's *entire* phone
  life into the app (their handset's native line dies). It becomes attractive the
  day Aida issues dedicated business numbers instead of riding personal mobiles.

## 16. Cutover runbook

Per-client go-live (MVP, expand into CLIENT_ONBOARDING_RUNBOOK.md at implementation
time):

1. Pre-flight: app installed, logged in, device row active, test call to the
   Twilio number directly (rings app? answer works? recording lands?).
2. Set `voip_enabled = true` for the client.
3. On the owner's handset: dial `*21*<TWILIO_NUMBER>#` (activates CFU).
4. **Cancel the conditional codes** (`##61#`, `##62#`, `##67#`) — CFU supersedes
   them, but stale conditionals cause confusing carrier states when CFU is later
   removed. Leave a clean slate.
5. Verify with `*#21#` (interrogation code shows CFU status).
6. Live test: answered call e2e; declined call → voicemail e2e.
7. **Rollback** (any failure): `##21#` (cancel CFU) → re-dial the three `**6x*`
   conditional codes → `voip_enabled = false`. Client is back on v1 in under two
   minutes, with zero server deploys.

## 17. Open questions

Must be answered before (or during) MVP implementation:

| # | Question | Blocks | Notes |
|---|---|---|---|
| Q1 | **Legal: recording answered calls in AU.** Which states require all-party consent for this configuration? Is an announcement required, and is a "calls may be recorded" greeting acceptable product-wise? Does the personal-contact no-record dial change the analysis? | Pilot cutover (M5) | Get real legal advice; v1's voicemail-only recording was a much safer posture |
| Q2 | Pilot client #1's handset platform → which platform is MVP? | M2 | The §7 recommendation (iOS first) yields to reality if the pilot carries Android |
| Q3 | CFU behaviour on the pilot's specific carrier/MVNO: activation codes honoured? CLI (`From`) preserved through the forward? per-minute forwarding charges to the owner? `*#21#` supported? | M5; also pricing model | Test with a $2 SIM of the same carrier before touching the pilot's phone |
| Q4 | Cost model per answered minute: CFU leg (owner's carrier) + Twilio inbound PSTN + Twilio Client leg + recording + Deepgram + Claude. What does a 10-min call cost, and does pricing absorb it? | Business viability | Assemble from current Twilio AU + Deepgram + Anthropic price lists at implementation time — prices drift, don't hardcode from this doc |
| Q5 | Session/refresh work (Phase 5 #5): confirm it lands **before** M2, and decide cookie-vs-header token transport for the app (RN fetch + httpOnly cookies is workable but header tokens are cleaner for mobile) | M2 | May motivate a small `/client-auth` addition: token-in-body login response for app clients |
| Q6 | App code location: monorepo `app/` dir vs separate repo? CI for app builds (EAS? fastlane?)? | M2 | Monorepo keeps context together for AI-assisted implementation; EAS is the low-ops default for RN |
| Q7 | Dual-SIM owners: which SIM's number is forwarded; does the app UX need to surface "which line is Aida on"? | Onboarding docs | At minimum an onboarding question |
| Q8 | What does the customer hear during the ~4–6 s CFU + push + wake latency — pure ringback (answerOnBridge) or a brief brand chime? | UX polish, M3 | Default: pure ringback; anything else reveals the product |
| Q9 | Call-waiting policy when the owner is mid-call (busy → instant voicemail vs. ring-through)? | Can ship MVP with "ring-through, OS handles it" and decide from real usage | |
| Q10 | Operator visibility: does the operator dashboard need live device/registration status per client at MVP, or is SQL-peeking acceptable until V2 management UI? | Dashboard scope | Recommend: defer to V2 |
| Q11 | App Store identity: ships under whose developer account, what app name/branding, and is a generic "Aida Business Calls" listing acceptable for review as a calling app on both stores? | M3 (TestFlight) / V2 (Play) | Play's calling-app FSI declaration needs the listing to *look like* a calling app |
| Q12 | Do we keep the `isYou` DTMF outbound bridge working for voip_enabled clients (owner dials Twilio number from handset — still loop-safe since it's owner-originated), or retire it at cutover in favour of "wait for V2 app outbound"? | M5 runbook | Keeping it costs nothing and preserves an outbound-recording path during MVP |

---

*End of document. Implementation should proceed phase-gated (M1–M5), each phase
verified against the acceptance criteria in §15 and the invariants in §4 before the
next begins. Any design change discovered during implementation must be reflected
back into this document first.*
