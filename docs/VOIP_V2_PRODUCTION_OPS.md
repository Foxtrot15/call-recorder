# VoIP v2 — Production Operations, Cost & Scaling

_Companion to [VOIP_V2_ARCHITECTURE.md](VOIP_V2_ARCHITECTURE.md). That document
designs the call-delivery architecture; this one covers running it as a production
SaaS: cost model, call-quality SLOs, monitoring, scaling limits, and push
reliability. Figures are compiled mid-2026 and marked **(verify at
implementation)** where they drift — Twilio revises marginal rates and per-region
limits programmatically._

---

## 1. Cost model

### Per-minute rates (Twilio AU, USD — Twilio publishes AU pricing in USD even when billed in AUD)

| Item | Rate | Note |
|---|---|---|
| Inbound PSTN → AU local Twilio number | $0.0100/min | The carrier-forwarded leg |
| Twilio Client / Voice SDK leg (either direction) | $0.0040/min | The IP leg to the app |
| Call recording (processing) | $0.0025/min | |
| Recording storage | $0.0005/min | first 10,000 min/mo free per parent account |
| AU local number rental | $3.00/mo | **fixed per client** — matters at low volume (§4) |
| Deepgram (batch transcription) | $0.0043/min | streaming is $0.0077/min |
| Claude (Haiku analysis) | ~$0.01/call | depends on prompt size |

**Billing subtlety that shapes the model:** in a 2-leg answered call (customer PSTN
↔ Twilio ↔ app Client leg), **both legs bill concurrently** for the call duration —
you pay inbound PSTN *and* the Client leg in parallel, not sequentially.

### Illustrative: one 5-minute answered call

| Component | Calc | USD |
|---|---|---|
| Inbound PSTN leg | 5 × $0.0100 | $0.050 |
| Client (app) leg | 5 × $0.0040 | $0.020 |
| Recording (processing + storage) | 5 × $0.0030 | $0.015 |
| Deepgram (batch) | 5 × $0.0043 | $0.022 |
| Claude analysis | ~ | $0.013 |
| **Per call (excl. number rental)** | | **≈ $0.12** |
| **Per 1,000 answered calls** | | **≈ $120** |

Number rental is separate and **fixed**: at 300 clients that's ~$900/mo of baseline
cost before a single minute of usage — a real line in unit economics, not a
rounding error (§4). *(verify at implementation — recording tiers, Deepgram plan,
and real Claude prompt size all move this.)*

Sources: [Twilio Voice Pricing AU](https://www.twilio.com/en-us/voice/pricing/au),
[Voice SDK pricing FAQ](https://support.twilio.com/hc/en-us/articles/223180608-How-Does-Twilio-Voice-JavaScript-and-Mobile-SDK-Pricing-Work),
[recording cost](https://help.twilio.com/articles/223132527-How-much-does-it-cost-to-record-a-call-),
[Deepgram pricing](https://deepgram.com/pricing),
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).

## 2. Call-quality SLOs

Target thresholds for WebRTC voice, from Twilio Voice Insights guidance. These
become the alerting thresholds in §4.

| Metric | Good | Investigate | Source |
|---|---|---|---|
| MOS (mean opinion score) | ≥ 4.0 | < 3.5 (Insights flags); < 3.1 unusable | [Twilio MOS](https://www.twilio.com/docs/glossary/what-is-mean-opinion-score-mos) |
| Packet loss | < 1% | > 2–5% sustained | [WebRTC packet loss](https://www.digitalsamba.com/blog/packet-loss-in-webrtc) |
| Jitter | < 30 ms | > 30 ms (Insights flags high jitter) | [Voice Insights](https://www.twilio.com/docs/voice/voice-insights/advanced-features) |
| Round-trip time | < 150 ms | > 400 ms (3 of 5 samples) | same |

**Latency budget for the answer experience:** Twilio publishes no hard push→ring
SLA; realistically a push-delivered call takes a few seconds to ring from a
sleeping device (radio wake + OS scheduling), with multi-second outliers when the
device was in deep sleep/Doze. Design the customer's ringback experience (VoIP v2
`answerOnBridge`) to tolerate several seconds before the app rings, and **measure
the real distribution on target devices** — don't assume. *(verify at
implementation with real-device testing.)*

## 3. Reconnection & network resilience

The Twilio Voice SDK handles mid-call network changes largely for us — the design
just has to fall back correctly when recovery fails (VoIP v2 INV-2):

- **Network preference & handoff:** the SDK prefers ETHERNET > WIFI > VPN > CELLULAR
  and will move an in-progress call to a newly-available preferred network (Wi-Fi
  appearing mid-call), surfacing a `Reconnecting` state.
- **Recovery window:** the JS SDK allows **up to ~30 s** to recover a call after
  media/signalling loss before failing; a network change *during* reconnection
  re-triggers it (handles rapid Wi-Fi↔cellular flapping). Treat 30 s as directional
  for mobile; **verify per-platform**.
- **Restrictive networks:** provision Twilio's Network Traversal (TURN/ICE) so
  cellular/enterprise-Wi-Fi edge cases don't fail ICE.
- **Total loss:** the Client leg ends → the inbound `<Dial>` child completes → the
  `action` handler routes to voicemail (never a redial — INV-2). This is why the
  fallback must be wired to `<Dial action>`, so a dropped app leg never leaves the
  caller in dead air.

Source: [Voice SDK network connectivity](https://www.twilio.com/docs/voice/sdks/network-connectivity-requirements),
[JS Device docs](https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice).

## 4. Production monitoring

### What to monitor (and where it's hard)

| Signal | Source | Note |
|---|---|---|
| Call success / answer / abandonment rate | Twilio Call status callbacks (`initiated/ringing/answered/completed`) | Drives the calls-row lifecycle |
| MOS distribution, jitter/loss/RTT warnings | Twilio Voice Insights (Call Summary API, SDK quality events) | Alert on the §2 thresholds |
| Error/warning rates | Twilio Debugger (esp. `11200` = your webhook/app unreachable) | Alertable on spikes |
| **Push → ring → answer funnel** | **App-side telemetry (must build)** | Twilio does not expose push *delivery* confirmation — you cannot see delivery from the server side (§5). The app must ack receipt back to the backend. |
| Recording completion + pipeline latency | Your own metrics on `/recording/complete` | Ties into the existing pipeline |

**The funnel gap is the key operational insight:** neither Apple nor Google gives
the server proof that a push reached the device. So VoIP v2 must instrument the app
to **acknowledge push receipt** back to the backend; the difference between "push
sent" and "receipt acked within N seconds" is your real ring-delivery metric and
your trigger for the voicemail fallback and the "your phone hasn't checked in"
staleness alert.

**Event Streams caveat:** Twilio Event Streams is at-least-once, **may be delayed
up to 4 hours and arrive out of order** — good for analytics, **not** a real-time
source of truth for call state. Use status callbacks for real-time.

Sources: [Voice Insights](https://www.twilio.com/docs/voice/voice-insights),
[Debugger](https://www.twilio.com/docs/usage/troubleshooting/debugging-your-application),
[Voice webhooks](https://www.twilio.com/docs/usage/webhooks/voice-webhooks),
[Event Streams](https://www.twilio.com/docs/events).

### Suggested SLOs to alert on
- Ring-delivery (receipt-acked / push-sent) below target per platform → investigate.
- Answer rate dropping for a specific client → likely their forwarding dropped (VoIP F1) or their device is force-stopped (Android, §5).
- Low-MOS call fraction above ~5% → network/codec investigation.
- `11200` error spike → app/webhook unreachable → page on-call.

## 5. Scaling & concurrency

| Limit | Default | Scaling path |
|---|---|---|
| **CPS** (calls placed/sec) | **1 CPS** on an Individual profile | Self-serve increase only with an approved **Business** profile; beyond that, Twilio account team |
| Concurrent calls | Not CPS-bound | Effectively bounded by your infra once Business profile approved |
| Queue | — | Calls queued > 24 h are cancelled |

Notes for Aida's shape:
- **CPS ≠ concurrency.** Aida is inbound-heavy (calls *arrive*), so CPS matters less
  than for an outbound dialer — but the **Client-leg dial-out** during a burst of
  simultaneous missed calls does place calls, and could brush the ceiling before a
  Business profile is approved. **Get the Business profile approved early**, not
  during a scaling event.
- **Fixed number-rental cost scales linearly** with clients (§1) — 300 numbers ≈
  $900/mo baseline. Factor into per-client pricing.
- Pre-negotiate CPS/concurrency increases with Twilio ahead of growth; manual
  increases are not instant.

Source: [Twilio call rate limits](https://support.twilio.com/hc/en-us/articles/223180028-How-Fast-Can-I-Place-or-Receive-Phone-Calls-with-Twilio).

## 6. Push reliability (the hard part)

Detailed platform mechanics are in
[VOIP_V2_ARCHITECTURE.md §5–6](VOIP_V2_ARCHITECTURE.md); the operational summary:

| | iOS (APNs VoIP / PushKit) | Android (FCM high-priority data) |
|---|---|---|
| Wake from terminated | ✅ deterministic | ⚠️ works **unless force-stopped** — then no push wakes it until manual relaunch (OS-level, no workaround) |
| Hard rule | Must report to CallKit synchronously on every VoIP push or iOS kills the app and can **stop delivering VoIP pushes entirely** | FSI restricted to calling apps (Play, Jan 2025); Doze throttling if abused |
| Est. delivery gap (ticket vs device) | ~4–8% | ~12–18% (Doze/App Standby) — *blog-sourced, verify with own telemetry* |

**Three architectural consequences (all belong in the MVP):**
1. **App-side receipt ack** — the server can't see delivery, so the app must confirm
   receipt; absence of an ack within the budget triggers the voicemail fallback.
2. **Fallback path** is not optional — every "no ack" call must degrade to v1
   voicemail (already INV-2).
3. **Android onboarding must include battery-optimisation allowlisting** — force-stop
   has no programmatic workaround, so it's a UX/education problem: surface a
   "your phone hasn't checked in" warning (from the staleness metric in §4) and
   guide the client to allowlist Aida.

Sources: [PushKit/CallKit requirement](https://developer.apple.com/forums/thread/796519),
[FCM Doze/force-stop](https://support.google.com/googleplay/android-developer/thread/289345573),
[push delivery estimates](https://appycodes.dev/blog/push-notifications-expo-fcm-apns-2026/).

---

## 7. Deployment additions vs v1

- **Twilio console:** API key (Access Tokens), APNs VoIP Push Credential (.p8), FCM
  Push Credential, TwiML for `<Dial><Client>`, status-callback + `action` URLs.
- **New backend env:** `TWILIO_API_KEY_SID/SECRET`, `TWILIO_APNS_PUSH_CREDENTIAL_SID`,
  `TWILIO_FCM_PUSH_CREDENTIAL_SID` (see VOIP_V2_ARCHITECTURE §14).
- **App CI/CD:** TestFlight (iOS) + Play closed testing (Android); EAS or fastlane.
- **Monitoring wiring:** Voice Insights enablement, status-callback ingestion, and
  the app-side receipt-ack endpoint (§4).
- Server stays on Railway; the app is a separate build target (repo-location
  decision is VOIP_V2_ARCHITECTURE §17 Q6).

_This is design/ops planning, not implementation. Cost figures are illustrative and
must be re-verified against live Twilio/Deepgram/Anthropic pricing at build time._
