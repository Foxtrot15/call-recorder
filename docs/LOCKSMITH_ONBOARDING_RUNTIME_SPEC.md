# AIDA — autonomous onboarding call runtime (M4)

**Status:** built, **UNCOMMITTED**, dormant, not deployed, no SQL applied, no call placed.
**Branch:** `feature/locksmith-pilot-m4-onboarding-runtime`
**Related:** [RETELL_INTEGRATION_SPEC.md](RETELL_INTEGRATION_SPEC.md) (M3) · [LOCKSMITH_ONBOARDING_SPEC.md](LOCKSMITH_ONBOARDING_SPEC.md) (M2)

---

## 1. What M4 is

M4 connects the M2 onboarding workflow to the dormant M3 Retell integration, so
the whole journey can be exercised end to end **in mock/dry-run mode**:

> locksmith requests a call → consents → AIDA rings → interview runs →
> signed webhooks arrive → transcript ingested idempotently → extraction creates
> a draft → gaps and contradictions flagged → locksmith reviews and approves →
> provisioning plan generated → receptionist ready for controlled provisioning.

**No real call was placed. No provider was contacted. No SQL was applied.**
`scripts/locksmith-mock-journey.js` proves the whole flow against the real
services and an in-memory database.

## 2. Consent (`src/services/onboarding-call-consent.js`)

Permission to make **one** onboarding call, to **this** number, **now**.

- **Not cold-marketing consent**, and nothing here produces a record that could
  be read as such. The disclosure says so explicitly.
- **Never pre-ticked.** `buildConsent` accepts only an explicit boolean `true` —
  `"on"`, `"true"`, `1` and a present-but-defaulted key are all refused. The
  page markup carries no `checked` attribute on any consent input, and a test
  asserts both.
- **Number-bound.** Consent is to ring a specific normalised E.164 number. A
  different number is a new decision, not an amendment (`destination_number_changed`).
- **Versioned wording.** The disclosure version the client actually saw is
  stored. Wording is never edited in place.
- **Transcription and recording are separate.** Transcription is required and
  disclosed plainly; recording is optional and **defaults off**.
- Revoked, expired (24h) or attempt-exhausted (3) consent cannot start a call.
- The number is shown back to the client **in full** so they can check it; the
  IP, user agent and fingerprint stay internal.

**We do not claim to settle Australian recording law** — see §9.

## 3. Client onboarding-call page (`src/views/locksmith-call-page.js`)

Headline: **"Talk with AIDA to configure your receptionist"**. Behind
`requireClientAuth`.

Explains: what the interview covers, that AIDA repeats important details back,
that **the call will be transcribed**, that recording is separate and optional,
and that **nothing goes live until the owner reviews and approves it**.

Thirteen states from `not_ready` to `provisioning_ready`, `failed` and
`cancelled`, rendered as a **server-side timeline** so core status is readable
with JavaScript disabled. When the provider is disabled the page says so
truthfully and the request button is disabled — it never shows a button that
would silently do nothing.

## 4. Start-call service (`src/services/onboarding-call-service.js`)

```js
requestOnboardingCall({ clientId, sessionId, requestedBy, consentId })
```

Verifies ownership, session state, and a valid current consent; normalises the
number; enforces the attempt limit and a **calling window** (08:00–20:00 local);
is **idempotent** on a deterministic `request_key` so a double-submitted form
cannot dial twice; refuses when a call is already active; sends the provider
**opaque identifiers only** (the tenant slug is hashed, no business profile is
included); uses only the onboarding-agent template; records the call **before**
contacting any provider; and binds the provider call id **only after a confirmed
success**.

**Live mode cannot activate accidentally.** Placing a call needs
`RETELL_ENABLED` + `RETELL_LIVE_CALLS_ENABLED` + `RETELL_LIVE_WRITES_ENABLED` +
`RETELL_DRY_RUN=false` + an API key + a voice id + an outbound number,
simultaneously. Absent any one, the adapter is disabled/dry-run and no network
call exists. Mock mode is reachable **only** when the caller passes it
explicitly — never from env. Tests assert all of this.

**There is no cold-outreach path here and none may be added.**

## 5. Lifecycle ingestion (`src/services/onboarding-call-lifecycle.js`)

Provider events → normalised internal events → call state.

Handles the realities: duplicates (Retell retries 3×), late arrivals,
out-of-order deliveries, and analysis arriving after `call_ended`. A late
lower-ranked event is **reconciled and recorded, not applied** — it never drags
the call backwards. A genuinely invalid transition is **surfaced** with an audit
event, never silently swallowed.

**One dropped webhook must not strand an onboarding:** a transcript or an
analysis is conclusive evidence the call finished, so those are accepted
directly from `created`/`dialling`/`connected` even if `call_ended` was lost.

A provider call id binds to exactly one session (unique in SQL). Cross-client
mismatches fail closed. End reasons are normalised, with the provider's own
label preserved rather than an unknown reason being invented into one of ours.
Duration and cost are recorded when supplied. **Recording URLs are stored as
references and never downloaded** — a test asserts the module contains no
transport.

## 6. Transcript → review automation

On a completed transcript: the M2 provider-neutral intake is called (idempotent,
and it **refuses to overwrite an existing transcript**), the configured
extraction adapter runs, the output is validated against the canonical schema, a
**new draft version** is inserted, warnings are produced (missing fields,
contradictions, safety-critical confirms, suspicious input), and the session is
walked through its **legal path** — `transcript_received → extraction_pending →
needs_review`. (The simulator caught a bug here: jumping straight to
`needs_review` fails M2's strict machine silently and strands the client at "on
the call".)

**Never auto-approves. Never replaces an approved profile.** Deterministic
fixture extraction remains the only adapter; no OpenAI or Anthropic connection
exists. Retell post-call analysis **supplements warnings only** and can never
approve anything.

## 7. Approval → provisioning bridge

On approval: re-reads what is actually approved, confirms authorisation and
readiness, supersedes any plan targeting an older version, compiles, and
generates the deterministic plan linked to client + approved version + session +
template versions. An identical re-approval produces `plan_unchanged` rather
than churning the table.

**It cannot execute** — a test asserts the module contains no reference to
`executePlan`. The client sees a truthful message: *"Your receptionist
configuration has been approved and is being prepared."*

## 8. Mock end-to-end simulator

```bash
NODE_ENV=development node scripts/locksmith-mock-journey.js
```

24 steps through the **real** services and handlers against an in-memory
database and the deterministic mock provider. Proves: explicit consent, refusal
of non-explicit consent, idempotent call request, lifecycle events, duplicate
and out-of-order handling, analysis that cannot approve, review page rendering,
12/12 section confirmations, a correction clearing its confirmation, approval
refused while unconfirmed, approval, plan generation, mock provisioning,
re-planning producing no work, retry creating no duplicates, live execution
still refused, test-plan generation, and the complexity assessment.

Refuses to run unless `NODE_ENV` is `development` or `test`. Contains no
transport.

## 9. Security and privacy

Client auth on every client route; tenant separation on every query; the repo's
JSON-only + SameSite CSRF posture; explicit non-pre-ticked consent; signed
provider webhooks (M3); request-size limits; idempotent processing; **no
transcript or full phone number in ordinary logs**; no recording download;
escaped transcript rendering; bounded provider metadata; normalised external
errors; feature flags failing closed; live call/write impossible by default;
the simulator unavailable outside development/test; audit events carrying no
unnecessary PII; stale-approval and stale-plan guards; no founder silent
approval override; **no public onboarding-call endpoint and no public transcript
endpoint**.

### Unresolved Australian legal wording — founder review required

1. **Call recording.** Recording defaults **off** and stays off. Consent
   captures a *preference*; we make no claim about whether it satisfies the law
   in any state. Required before recording is switched on.
2. **Transcription disclosure.** The onboarding agent discloses transcription
   plainly; `legalReviewPending: true` marks the wording as unreviewed.
3. **Consent retention.** Consent rows carry a phone number, an IP and a user
   agent. No retention job exists; one needs the same review as transcript
   retention.
4. **The "not marketing" statement.** Drafted in plain English, not reviewed
   against the Spam Act or the Do Not Call Register regime. M4 makes no outbound
   marketing call, so nothing depends on it yet.

## 10. SQL

**`supabase/sql/lpm4_create_onboarding_call_runtime.sql` — REVIEW ONLY, NOT APPLIED.**

Two additive tables: `onboarding_call_consents`, `onboarding_calls`. RLS at
birth, no policies. Unique provider-call binding, unique request key per client,
a partial unique index for one active call per session, and check constraints
that make an unconsented consent row impossible to store.

**Why not reuse `calls`:** that table is the v1 missed-call pipeline's record —
a customer rang a locksmith. An onboarding call is the opposite direction and a
different subject. Reusing it would put consent and provisioning columns onto
the row type the prime-directive pipeline reads. The v1 pipeline is untouched.

**Application order:** `lpm2` → `lpm3` → `lpm4`.

## 11. Generated receptionist test plan

`generateTestPlan(profile)` produces 18 client-specific cases covering accepted
and declined services, in/out of area, ordinary and after hours, urgent transfer,
non-urgent quote, unapproved pricing, guaranteed arrival, **lock-bypass refusal**,
**prompt injection**, transfer failure, missing details, corrections and abuse.

`evaluateCase()` does deterministic local checks — forbidden phrasing, a leaked
transfer number, an unapproved dollar figure — and is **honest that a mechanical
pass is not a full pass** (`needsHumanReview: true`). No official Retell
test-case API was confirmed, so `toProviderDryRun()` produces the payload and
creates nothing.

## 12. Micro complexity assessment

A **provisional, non-billing** signal: does this configuration fit the
standardised Micro setup? Outputs `micro_compatible`, `minimum_operational_tier`
(micro/standard/bespoke), reasons, manual-review requirement and unsupported
complexity.

It **does not price, charge or reject anyone** — a complex profile is flagged
for review and a likely higher tier, never turned away. It cannot mutate a
profile. **Every customer receives the same core voice quality**; the cheap plan
is cheap because onboarding is autonomous and configuration is standardised. That
sentence is restated on every assessment and asserted by a test.

Calibration note: the bounds were loosened during development after an ordinary
solo locksmith (core area + stretch area + smaller after-hours area) was flagged
above Micro. Flagging every normal customer would have defeated the purpose.

## 13. External steps still required

Everything in [RETELL_INTEGRATION_SPEC.md §14](RETELL_INTEGRATION_SPEC.md), plus:
apply `lpm4`, settle the recording/transcription legal wording, and decide the
calling-window policy against the client's own timezone rather than server time.
