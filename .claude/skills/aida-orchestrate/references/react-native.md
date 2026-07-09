# React Native workflow — what a browser can prove, and what it can't

Aida's mobile app (VoIP v2 Phase 2+, `docs/VOIP_V2_MOBILE_APP_SPEC.md`) exists
to answer real phone calls. **Browser success never proves mobile VoIP
success** — the entire hard part (push wake-up, CallKit/ConnectionService,
audio, background/killed states) has no browser equivalent. This file draws
the verification boundary so nobody reports "verified" on evidence that
cannot support the claim.

## The two verification worlds

### Browser/curl/unit-verifiable (normal workflow applies)

| Work | How to verify |
|---|---|
| API contracts (`docs/MOBILE_API_CONTRACT.md` endpoints) | unit tests + curl/fetch against a dev server; assert bodies, codes, error `code` values |
| Backend integration (routes, guards, flags, devices table) | `npm test` + smoke + targeted regression |
| Documentation | link check + review |
| Web dashboard changes made alongside app work | [browser-verification.md](browser-verification.md) |
| Auth API sanity (token login, refresh rotation, `GET /client-auth/me`, logout revocation) | curl sequence against dev server — this IS meaningful pre-device verification of the contract the app consumes |

### Device/emulator-ONLY (never claim these from a browser or curl)

- React Native login flow (the app's own screens and state machine)
- token refresh inside the app lifecycle (foreground/background timers)
- Keychain (iOS) / Android Keystore storage behaviour
- Twilio Voice SDK registration (`voice.register`)
- device registration flow end-to-end (`pushTokenHash` from a real push token)
- APNS / FCM / PushKit delivery — and its failure modes
- CallKit (iOS) / ConnectionService (Android) incoming-call UI
- incoming call UI and answer/decline paths
- audio routing (earpiece/speaker/bluetooth)
- background behaviour (app backgrounded at ring time)
- killed-app behaviour (force-stopped app woken by push — the hardest case,
  especially Android OEM battery killers)

## Workflow requirements (binding for all RN work)

1. **Simulator/emulator first, where possible.** Every feature that CAN run
   on the iOS Simulator / Android Emulator is proven there before device
   time is spent. Known limits: iOS Simulator has no real PushKit/VoIP push
   delivery and no real Keychain hardware backing; emulators need Play
   Services images for FCM. State per feature which limit applies.
2. **Real-device testing before pilot.** No feature in the device-only list
   is "done" for pilot purposes until it has passed on physical hardware —
   the Phase 3 (TestFlight) and Phase 4 (failure drills) gates in
   `docs/VOIP_V2_IMPLEMENTATION_PLAN.md` own this.
3. **iOS and Android are separate claims.** Every device-only behaviour is
   tracked per-platform in the ledger (`- [ ] X (iOS)` / `- [ ] X (Android)`).
   The platforms differ exactly where it matters most: push transport
   (PushKit vs FCM), call UI (CallKit vs ConnectionService), and
   background-kill policies. Never let a green iOS run tick an Android box.
4. **The backend contract is verified backend-side first.** Before debugging
   anything on-device, prove the API behaves per `MOBILE_API_CONTRACT.md`
   with curl/unit tests — device debugging is 10× slower than backend
   debugging; never use a phone to discover a 401.
5. **Failure drills are deliberate, not incidental** (Phase 4 / M4): decline,
   airplane mode, force-stop, token expiry at ring, double-answer race —
   each drill must terminate in v1 voicemail (INV-2), and each is a ledger
   line of its own.
6. **App repo boundary:** the RN app is expected to live in a separate repo
   (plan §7, Q6 — final call at Phase 2 entry). This skill governs the
   backend repo either way; if the app repo materialises, port the ledger and
   safety-boundary conventions there rather than assuming this file is loaded.

## What Fable vs delegates do in RN work

Same routing as [delegation.md](delegation.md): Fable designs the app's auth
token lifecycle, SDK integration seams, and CallKit/ConnectionService
architecture (Twilio/VoIP design is Fable-reserved); lower-cost agents write
screens, styles, boilerplate, and tests from Fable's specs. Device/emulator
runs are driven by whoever holds the hardware — usually Peter for physical
devices; write him precise, numbered test scripts (the same ≤5-minute
checklist discipline as browser verification) and treat his observations as
the evidence.

## Reporting discipline

An RN status report always separates three columns of truth:
**backend-verified** (curl/unit/smoke), **simulator-verified**, and
**device-verified (per platform)**. A feature's overall state is its weakest
required column — and for anything on the device-only list, backend/browser
columns are supporting evidence, never the claim itself.
