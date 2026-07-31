# AIDA Locksmith Receptionist — autonomous onboarding (M2)

**Status:** built, dormant, **not deployed, not committed to `main`, no SQL applied.**
**Branch:** `feature/locksmith-pilot-m2-onboarding`
**Flag:** `LOCKSMITH_ONBOARDING_ENABLED` — unset in every environment; every route 404s.
**Owns:** the canonical locksmith profile schema, profile + session lifecycles,
transcript ingestion, the extraction adapter contract, review/approval, and the
provisioning-readiness rules.
**Related:** [LOCKSMITH_PILOT_SPEC.md](LOCKSMITH_PILOT_SPEC.md) (M1 public page)

---

## 1. Purpose

A locksmith should be able to get a working AI receptionist by **having one
conversation**, not by filling in a forty-field configuration form or writing
prompts. M2 builds the internal foundation for that:

> Locksmith speaks with AIDA → the call is transcribed → structured settings are
> extracted → AIDA shows *"Here is what I understood about your business"* → the
> locksmith confirms or corrects each section → the profile is approved → the
> approved profile becomes eligible for provisioning.

Nothing goes live without explicit approval, and the customer never sees a
prompt or an AI setting.

This autonomy is the commercial mechanism, not a nicety: AIDA can serve small
owner-operators cheaply **because onboarding configures itself**. The saving
comes from standardised configuration, never from a worse receptionist — that
commitment is written into `PROVISIONAL_COMMERCIAL_MODEL.qualityCommitment` and
asserted by a test.

**M2 connects to nothing.** No Retell, no Twilio, no Stripe, no model provider.

## 2. What M2 actually contains

| Capability | State |
|---|---|
| Canonical profile schema (12 sections) | Built, validated, versioned |
| Profile lifecycle + approval guard | Built |
| Onboarding session lifecycle | Built |
| Transcript ingestion boundary | Built, operator-only entry point |
| Extraction adapter interface | Built, provider-neutral |
| Deterministic fixture adapter | Built — the only adapter that ships |
| Interview specification + demo transcript | Built (a specification, not an agent) |
| Client review + approval page | Built |
| Founder console | Built |
| SQL for three tables | **Written, reviewed, NOT applied** |
| Live voice interview, Retell, billing | **Not built** — see §12 |

## 3. The canonical profile

`src/services/locksmith-profile-schema.js` declares the twelve sections as data;
`src/services/locksmith-profile.js` validates them and computes readiness.

**Retell is an adapter target, not the source of truth.** Nothing in the schema
mentions a vendor, and no vendor's shape may leak into it — when a provisioning
adapter needs something different, the adapter translates.

| § | Section | Key | Blocks launch |
|---|---|---|---|
| A | Business identity | `identity` | yes |
| B | Services accepted | `servicesAccepted` | yes |
| C | Services declined | `servicesDeclined` | no |
| D | Service areas | `serviceAreas` | yes |
| E | Business hours | `hours` | yes |
| F | Urgency rules | `urgencyRules` | yes |
| G | Transfer + fallback | `transfer` | yes |
| H | Notifications | `notifications` | no |
| I | Pricing boundaries | `pricing` | yes |
| J | Caller information | `callerInfo` | yes |
| K | Forbidden promises | `forbiddenPromises` | yes |
| L | Privacy + recording | `privacy` | no |

All twelve require an explicit reviewer confirmation before approval.

### Design rules the schema enforces

- **Enums are closed sets.** An unrecognised value is refused outright, never
  passed through. An extraction adapter inventing `sometimes_urgent` fails
  loudly rather than quietly configuring a receptionist.
- **Two kinds of problem, deliberately separated.** `structure` = malformed
  (wrong type, unknown enum, a time that isn't a time) → the extraction gate
  rejects the adapter's whole output. `review` = incomplete or contradictory (no
  transfer number, a service both accepted and declined) → passed through as a
  draft, shown on the review page, and refused at approval. An interview where
  the owner didn't answer everything is the normal case; treating it as an
  adapter bug would make the product unusable.
- **Nothing is inferred.** AIDA never treats an unlisted service as accepted, a
  nearby suburb as covered, or an unanswered question as a "no".
- **The forbidden-promise floor is not configurable.** All eight restrictions
  must be present and enabled on every approved profile — they are not the
  locksmith's to switch off during onboarding.
- **Pricing defaults safely.** Both `mayMentionPricing` and
  `humanConfirmsEveryPrice` must be explicit booleans; unset is *ambiguous*, not
  permissive.
- **Phone numbers are normalised to E.164 and validated.** Australian numbers
  only. Mobiles/landlines drop the trunk `0`; 1300/1800 keep all ten digits
  (the leading `1` is part of the number — getting this wrong produces a number
  that looks configured and rings nothing).
- **`extensions` is a small bag for non-critical additions only.** Reserved keys
  and oversized blobs are rejected, so it cannot become a shadow schema.

## 4. Profile lifecycle

```
draft ──▶ needs_review ──▶ approved ──▶ superseded
  │            │
  └────────────┴──▶ rejected
```

1. **A draft never overwrites an approved profile.** Extraction always INSERTs a
   new version.
2. **Approval is explicit**, actor-attributed and timestamped.
3. **Corrections create a new version**; approved rows are immutable.
4. **Superseded and rejected versions are retained** — they are the audit trail
   and the rollback path.
5. **At most one approved version per client**, enforced in the app *and* by a
   partial unique index (`lbp_one_approved_per_client`).
6. Every status change records **actor, timestamp, reason and source**.
7. **Optimistic concurrency:** the review page carries the draft's `updatedAt`;
   approval sends it back as `expectedUpdatedAt`. If the draft moved, approval
   is refused as `stale_review` rather than approving text nobody read.

## 5. Session lifecycle

```
created → interview_ready → interview_in_progress → transcript_received
        → extraction_pending → needs_review → approved
```
`cancelled` and `failed` are reachable from every live state; all three terminal
states are terminal. A session cannot skip the transcript, the extraction or the
review — asserted by test.

**M2 does not require a live call.** A session can be created, fed a fixture
transcript, extracted and reviewed entirely offline.

## 6. Transcript ingestion

```js
receiveOnboardingTranscript({ clientId, sessionId, provider, providerCallId, transcript, metadata })
```

Provider-neutral: `provider` is data, not a branch. Guarantees, each a test:

- **Idempotent** — the same content, or the same `providerCallId`, delivered
  twice is accepted once and reported as `duplicate`. Webhooks retry.
- **Never silently replaces** — a *different* transcript for a session that
  already has one is refused (`transcript_exists`). The database enforces it too
  (`.is("transcript_sha256", null)` on the write closes the check-then-act race).
- **Client/session must match** — a mismatch reports `session_not_found`, never
  "belongs to another tenant". Existence is itself tenant information.
- **Size-bounded** — 40 bytes to 200 KB, max 2000 lines, metadata under 8 KB.
- **Untrusted input** — control characters are stripped (never speech; a null
  byte would truncate Postgres text), markup is NOT: a locksmith who says
  `<script>` said that, and mangling evidence would create a false belief that
  stored text is render-safe. **Escaping happens at every render site.**
- **Audited** — receipt, duplicate and rejection each emit an event carrying a
  digest and byte count, never the transcript.

### ⚠️ Future Retell webhook — signature verification is mandatory

**M2 exposes NO public ingestion endpoint.** The only entry point is
`POST /locksmith-founder/sessions/:sessionId/transcript`, behind the operator
login.

When the Retell webhook is built it **must not** reuse that route. It needs its
own route that, *before* calling `receiveOnboardingTranscript`:

1. verifies the provider's signature header against a shared secret held only in
   Railway env (the `twilioWebhook` middleware is the in-repo precedent);
2. rejects unsigned or stale requests with 401/403 and no body detail;
3. rate-limits by source;
4. treats the payload as untrusted regardless of the signature.

Until that exists, no public webhook may be created.

## 7. Extraction adapter

```js
extractLocksmithProfile({ transcript, existingProfile, schemaVersion, adapter, clientId })
```

**No model is called in M2.** One adapter ships: `fixture-v1`, deterministic
pattern-matching over the demonstration interview. A test asserts no
OpenAI/Anthropic/Retell adapter is registered.

Every adapter passes the same gate:

1. structure-only validation — malformed output is rejected **wholesale**, never
   half-applied;
2. the schema version is overwritten (an adapter cannot claim a different one);
3. `clientId` is stamped from the **caller**, so a hostile transcript cannot
   retarget a draft at another tenant;
4. missing-field detection against the safety-critical set;
5. mechanical contradiction detection (service both ways, area both ways,
   transfer-hours conflict, after-hours conflict, unbounded pricing);
6. a severity-tagged review-warning list;
7. `approved: false`, always.

**An approved profile passed as `existingProfile` is deep-copied** before the
adapter sees it, so a buggy or hostile adapter cannot mutate a live
configuration through a shared reference — asserted by test.

The fixture is also the **reference implementation of the contract** a future LLM
adapter must satisfy: where the transcript does not say something, leave it
`null` and let it be reported as missing. Silence produces a gap, never a guess.

## 8. Review and approval

**Route:** `GET /client/locksmith-onboarding/:sessionId/review` — behind
`requireClientAuth`, `req.clientId` from the verified session only.

Headline: **"Here is what AIDA understood about your business"**. Each of the
twelve sections shows, in the same place every time: the extracted value, the
source, what is missing, warnings, its confirmation state, and whether it blocks
launch. The reviewer can confirm a section, correct a value, flag it for
discussion, save progress, reject the draft, or approve.

**A correction always clears that section's confirmation** — something just
disputed is not something confirmed.

### The approval guard refuses when

required sections are incomplete · transfer numbers are invalid · hours conflict
· no service is accepted · no service-area action exists · pricing permission is
ambiguous · forbidden promises are absent · any section confirmation is missing
· the reviewer is not authorised (403) · the draft changed since the page loaded
(409).

Every reason is returned **at once**, so a reviewer fixes them in one pass.

| Route | Method | Auth |
|---|---|---|
| `/client/locksmith-onboarding/:id/review` | GET | client |
| `/client/locksmith-onboarding/:id/confirm` | POST | client |
| `/client/locksmith-onboarding/:id/note` | POST | client |
| `/client/locksmith-onboarding/:id/approve` | POST | client |
| `/client/locksmith-onboarding/:id/reject` | POST | client |

## 9. Provisioning readiness

`assessProvisioning(profile)` → `{ ready, blockers[], warnings[] }`.
Deterministic: no clock, no randomness, no I/O — the review page, the approval
guard and the tests agree by construction.

**Blocks provisioning:** no accepted service · invalid/missing primary transfer
number · a fallback that names a backup that doesn't exist · no primary service
area · no out-of-area rule · no timezone · no open hours · no urgency rules ·
ambiguous pricing authority · any missing forbidden promise · no callback number
collected.

**Warns only:** no business description · no notification recipients · no
recording preference · no explicitly declined services · no caller name.

Readiness deliberately ignores approval status. A ready-but-unapproved profile
must never provision, and an approved-but-unready one cannot exist — the DB
constraint `lbp_approved_is_ready` refuses to store it.

## 10. Founder console

`/locksmith-founder/sessions` and `/locksmith-founder/sessions/:id`, behind the
existing operator login. Lists sessions, shows status, client, transcript
(escaped, line by line), extraction warnings, draft profile state, approval
state, **why provisioning is blocked**, and the audit history. Can mark a session
failed (reason required) and, **in development/test only**, re-run the
deterministic extraction — which creates a NEW draft and leaves any approved
version untouched.

**The console cannot approve on a client's behalf.** No override exists in M2.
Client approval is the entire safety mechanism; a quiet founder bypass would
make the audit trail a lie. If an override is ever needed it must be built as
its own action requiring a reason, emitting a distinctly-typed audit event, and
displayed as an override wherever the approval is shown — not as a second,
quieter approve button.

## 11. SQL

**File:** `supabase/sql/lpm2_create_locksmith_onboarding.sql`
**Applied: NO. Nothing was executed against any database.**

Three additive tables — `locksmith_onboarding_sessions`,
`locksmith_business_profiles`, `locksmith_onboarding_events`. Nothing existing is
altered, renamed or dropped.

- **RLS enabled in the same transaction** on all three, **no policies** —
  service_role only, matching the current deny-by-default posture. Deliberately
  no authenticated-user policy: these rows hold a business's full operating
  configuration and its transcribed interview.
- `client_id` is `clients.slug`, the repo's canonical tenant key.
- Safety-critical facts are **real columns with constraints**; the twelve
  sections are one app-validated jsonb body. Not an opaque blob — routing,
  service, approval and safety facts are queryable and checked.
- Constraints worth naming: `lbp_client_version_key` (dense versions),
  `lbp_one_approved_per_client` (partial unique index),
  `lbp_approved_has_evidence`, `lbp_rejected_has_reason`,
  `lbp_approved_is_ready`, `los_provider_call_key` (idempotent ingestion).
- No FK to `clients` — same reasoning as
  `client_phone_routing_profiles`: `clients.slug` is not uniquely constrained in
  every environment. The exact `alter table` statements to add later are in the
  file.

**Application order:** self-contained; may be applied at any time relative to the
other pending files (`phase1a`, `phase1b`, `phase1c`, `wcs1b`). Apply only when
M3 begins, before `LOCKSMITH_ONBOARDING_ENABLED` is ever set. Until applied,
every adapter fails closed with *"locksmith onboarding tables not provisioned"*.

Verification queries and a commented rollback are in the file.

## 12. Security and privacy

- Transcripts and profiles are **sensitive business information**. Both review
  and founder pages send `Cache-Control: no-store, private` and
  `robots: noindex, nofollow`.
- **Tenant separation:** every client-facing query filters on `req.clientId`
  from the verified session. A cross-tenant request gets 404, never 403.
- **Escaping** at every render site (`src/views/escape.js`); the founder
  transcript view is the one page that shows raw speech and is tested for it.
- **CSRF:** the repo has no token library; its posture is httpOnly +
  `SameSite=Lax` cookies with JSON-only state changes. Every mutating handler
  here *enforces* `Content-Type: application/json` (415 otherwise), so the
  protection is asserted at the route rather than assumed.
- **Rate limits** on all onboarding actions (60 / 5 min per IP), with periodic
  pruning.
- **Logging:** audit `detail` carries digests and counts, never transcript text
  or phone numbers. `failure_detail` is operator-facing prose only. Provisioning
  errors naming a SQL file reach the operator console but never a client browser.
- **No secrets** in code, fixtures, prompts or audit rows.
- Audit events are append-only.

### Known legal-review items (not decided in code)

1. **Call recording** — law varies by state. We model the client's *preference*
   and require disclosure wording when recording is on; we do **not** decide
   whether their wording is legally sufficient.
2. **The onboarding call's own transcription disclosure** —
   `OPENING.transcriptionDisclosurePlaceholder = true` marks the wording as
   pending review.
3. **Transcript/recording retention** — the preference is recorded; **no
   retention job exists** and none ships in this migration.
4. **Privacy policy reference** — `privacy.privacyPolicyReference` is null
   pending the published policy (also an M1 placeholder).
5. **Customer-contact consent wording** — modelled, not drafted.

## 13. Local review

```bash
npm test                                   # full suite, no node_modules needed
node --test test/locksmith-*.test.js       # this feature only
```

The onboarding routes are dormant, so `npm run dev` will 404 them unless
`LOCKSMITH_ONBOARDING_ENABLED=true` is set **and** the SQL has been applied.
To look at the pages without a database, use the scratchpad harness described in
the M2 completion report, which mounts the real renderers and handlers over an
in-memory fake.

## 14. Demonstration data

`DEMO_TRANSCRIPT` in `src/services/locksmith-interview-spec.js` is a full mock
interview with a **fictional** Melbourne locksmith ("Northside Lock and Key"),
labelled by `DEMO_LABEL`.

- Phone numbers come from the **ACMA fictitious range** (0491 570 006–156):
  valid Australian mobiles by format, so they exercise the real validator, but
  permanently unallocated, so nothing can ring a real handset.
- The email domain is an **RFC 2606 reserved** `example.com` subdomain.
- Suburbs are real Melbourne suburbs attached to an invented business.
- No real customer, call, recording or ABN appears anywhere.

## 15. Provisional commercial model — NOT BINDING

Held in one place (`PROVISIONAL_COMMERCIAL_MODEL`) and read by **no billing
code**, because there is none. Every value is marked provisional and must be
confirmed against measured call economics before publication as a plan limit:

A$49 at signup · two-month initial service period · A$49 promotional credit in
month one · the signup payment covers month two · from month three, monthly
renewal from A$49 unless cancelled before renewal · a future "Micro" plan of
approximately 15 answered calls plus a protective receptionist-minute allowance
· higher usage may move the customer to the smallest published tier covering it.

None of this is rendered as a contractual term anywhere, and the M1 page's
pricing remains separately labelled as provisional founding-pilot pricing.

## 16. Deferred

Live Retell · live Twilio · real inbound calls · outbound sales calls ·
production numbers · production webhooks · OpenAI/Anthropic extraction ·
automated agent provisioning · automated test calls · Stripe charging · usage
billing · automatic tier movement · DNCR washing · locksmith crawling · prospect
outreach · public client signup · production deployment · mobile app · multiple
niches · white-label · custom voice models.
