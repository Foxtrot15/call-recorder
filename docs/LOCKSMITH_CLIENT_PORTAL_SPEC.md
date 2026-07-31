# AIDA Locksmith — Client Portal and Configuration Management (M5)

**Status: dormant.** Every route 404s unless `LOCKSMITH_PORTAL_ENABLED="true"`.
No SQL has been applied. No external service was contacted. No configuration
call has been placed and no configuration-agent number is connected.

Milestone chain: [M1 public shell](LOCKSMITH_PILOT_SPEC.md) →
[M2 onboarding](LOCKSMITH_ONBOARDING_SPEC.md) →
[M3 Retell provisioning](RETELL_INTEGRATION_SPEC.md) →
[M4 call runtime](LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md) → **M5 client portal**.

---

## 1. What M5 is

The authenticated surface a paying locksmith uses day to day, and the
channel-neutral machinery behind every configuration change.

| Surface | Path | Auth |
|---|---|---|
| Client portal (7 tabs) | `/client/locksmith?tab=…` | `requireClientAuth` |
| Change requests | `POST /client/locksmith/change-requests` | `requireClientAuth` |
| Notification preferences | `POST /client/locksmith/notifications` | `requireClientAuth` |
| Forwarding instructions | `POST /client/locksmith/forwarding/instructions` | `requireClientAuth` |
| Operator client operations | `GET /locksmith-founder/clients[/:clientId]` | `requireLogin` |

Tabs: Overview, Setup, Calls, Enquiries, Settings, Test centre, Support.

---

## 2. The architecture rule this milestone implements

AIDA is intended to become a voice-operated business system. The rule, which
governs M5 and everything after it:

1. Every important client configuration capability must be representable and
   safely manageable through the authenticated UI.
2. It must also be capable of being requested later through a dedicated AIDA
   configuration voice agent.
3. Both must use the **same** canonical domain services, validation, versioning,
   testing and approval workflow.
4. Voice must not become a second independent configuration store.
5. Raw transcripts must never directly alter the live receptionist, prompt or
   knowledge base.
6. No critical production change becomes active without structured validation
   and explicit client approval.

### How the code enforces it, not just documents it

| Rule | Enforcement |
|---|---|
| One domain for both channels | `services/locksmith-change-request.js` is the only path to a configuration change. The portal handler contributes exactly one thing: `sourceChannel: "client_ui"`. A test asserts the UI and voice channels produce byte-identical validated payloads for the same change. |
| No second store | One `locksmith_change_requests` table for all six channels, with `source_channel` recording origin. There is no per-channel table. |
| Transcripts are evidence, not configuration | The schema has a `transcript_reference` column and **no transcript text column**. A SQL verification probe asserts no column named `transcript` exists on any M5 table. |
| Voice is traceable | `lcr_voice_requires_session` CHECK: a request from a voice channel without a `voice_session_id` cannot be inserted. Enforced by the database, not by convention. |
| Nothing goes live unapproved | Safety-critical targets carry `required_confirmations`; the founder operations view has no approve control at all (asserted by test: no `<button>`, no `<form>`). |

### The fourth agent

`services/voice-configuration-session.js` reserves the boundary for a dedicated
configuration agent. It is deliberately **separate** from the public
receptionist, the outbound sales agent and the initial onboarding agent
(`OTHER_AGENT_ROLES`, asserted by test).

It was built now, alongside the change-request domain, because a domain that has
only ever been driven by an HTML form grows form-shaped assumptions that are
expensive to remove later. **Nothing in it places or receives a call.**

---

## 3. Voice authentication — deferred, not designed away

Caller ID alone is never sufficient. Numbers are spoofable and handsets are
shared. `AUTH_FACTORS` are ordered by strength:

| Factor | Strength | Spoofable |
|---|---|---|
| `recognised_caller_number` | 1 | yes |
| `account_pin` | 2 | no |
| `one_time_code` | 3 | no |
| `portal_confirmation` | 4 | no |
| `verified_callback` | 4 | no |

`AUTH_POLICY` scales the requirement to the risk:

- **read-only** — strength ≥ 2
- **ordinary change** (greeting, tone, notification recipients) — strength ≥ 3
- **safety-critical change** — strength ≥ 4 **and** portal-side confirmation

The safety-critical set is *derived* from `CHANGE_TARGETS`, not restated, so the
two cannot drift (asserted by test). The reasoning behind the strictest tier:
someone who answered the owner's phone must not be able to reroute the owner's
emergency calls to themselves.

---

## 4. Change request lifecycle

Ten states: `draft → submitted → needs_clarification → accepted →
applied_to_draft → awaiting_client_approval → approved`, plus `rejected`,
`cancelled`, `superseded`.

Six source channels: `client_ui`, `voice_configuration_agent`,
`initial_voice_onboarding`, `founder_operator`, `api`, `system_generated`.

Each target in `CHANGE_TARGETS` declares three properties:

- `safetyCritical` — needs the strongest authentication and a read-back
- `readBack` — must be repeated back digit by digit (phone numbers)
- `invalidatesTests` — approving it makes existing receptionist test results
  stale rather than passing

`buildDraftFromChanges` **deep-copies the approved profile first**. No path in
the module mutates a live configuration.

### The forbidden-promise floor

`MANDATORY_FORBIDDEN_PROMISES` cannot be removed through a change request from
any channel.

> **Defect found and fixed during M5.** The original guard inspected a
> caller-supplied `removing` hint. Submitting the complete new list with a
> mandatory entry simply *absent* removed it while declaring nothing. The check
> now validates the **resulting list** — every mandatory promise must be present
> — and four regression tests cover it, including one asserting the guard holds
> on the voice channel.

---

## 5. Read models

`services/locksmith-portal-readmodel.js` — nine projections, each a pure
function over rows with a thin fetcher beside it.

Overview · Call list · Enquiry list · Usage · Profile summary · Test status ·
Change requests · Launch readiness · Billing preview.

Design decisions worth keeping:

- **Enquiries are a view over `calls`, not a second table.** A separate store
  produces two counts of the same thing that drift apart the first time a call
  is reclassified — and one of them would be the one the invoice used.
- **Strict tenant scoping.** `routes/calls.js` widens to
  `client_id = X OR default OR NULL` so the operator dashboard keeps showing
  rows written before per-client stamping. The portal **must not** inherit that:
  those legacy rows belong to the original operator, and a locksmith seeing them
  would be a cross-tenant disclosure. `scopeStrict` is equality-only, and a test
  makes `.or()` throw if anything reaches for it.
- **Profile completeness is derived from `S.SECTIONS`**, not a hand-written
  list, and weighted 80/20 blocking-to-optional. A hand-written list drifts
  silently: the missing section simply stops being counted and the client sees
  "100% complete" for a profile that is not.
- **Usage arithmetic is the arithmetic M6 will bill on.** Calls under
  `BILLABLE_MINIMUM_SECONDS` (6s) are excluded from both counts and minutes, so
  a run of instant hang-ups cannot inflate an invoice.
- **Analysis output is treated as untrusted on the way out as well as in.**
  `validUrgency` gates the badge; an unrecognised classification cannot light up
  "needs attention" while the urgency column shows nothing.

---

## 6. Notification preferences

Three concepts kept deliberately separate — collapsing them is how notification
systems end up texting a customer's emergency line with a monthly summary:

- **Destination** — a verified place a message can go
- **Preference** — the client's decision about one event type
- **Intent** — the resolved "send this, there, now"

Ten notification types across two categories (`operational`, `administrative`),
plus a `promotional` category with no members yet, which exists so the rule
below has something to refuse.

Three channels: `portal` (always on, free, the floor), `email` (free),
`sms` (A$0.05, the only channel that costs anything).

### The transfer-number rule

A transfer number is frequently **not** the account holder's own phone — often a
partner, a second van, or an after-hours subcontractor.

- **Operational** alerts: always allowed. That is what the number is for.
- **Administrative**: blocked *until the client confirms the number is theirs*
  (`confirmedOwnNumber`). Sending billing detail to a subcontractor's phone
  leaks the business's commercial information; refusing outright would be wrong
  for the far more common solo trader whose mobile is both things at once.
- **Promotional**: refused permanently, not acknowledgeable.

### Other guarantees

- Conservative defaults: SMS only for `urgent_enquiry`, `missed_transfer` and
  `receptionist_health`.
- `MUST_REACH_A_HUMAN` types cannot be left portal-only — a locksmith who never
  opens the portal still needs to hear that AIDA stopped answering their phone.
- Quiet hours suppress **non-urgent SMS only** and may wrap midnight. A 2am
  lockout is the product working, not a disturbance.
- Every suppressed delivery records *why*, so the portal can answer "why didn't
  I get a text?".
- Intents carry masked destinations; raw numbers and addresses never appear.
- SMS cost is shown next to the toggle, with `basis` stating plainly whether it
  is a model or the client's own volume.

**Nothing sends.** There is no transport in M5. The output is a delivery intent.

---

## 7. Call forwarding

Eight states: `not_ready → ready_to_set_up → instructions_generated →
client_reports_done → verification_pending → confirmed_working`, plus
`needs_help` and `turned_off`.

**Every GSM code comes from the verified `services/divert-codes.js`.** This
module never writes a code and never edits the strings it gets back — a test
asserts byte-equality with calling `divert-codes` directly. Inventing a
diversion code would send a locksmith's emergency calls into a dead number.

**No placeholder number, ever.** Instructions cannot be generated until a real
provisioned AIDA number exists. A sample number in a set of dialling
instructions is worse than no instructions: it looks authoritative and it is
wrong. `deriveState` recomputes from the facts, so a stored state that outran
reality is corrected rather than shown.

Other refusals: diverting a number to itself (`self_divert`); a malformed
provisioned number, which is our fault and is logged internally while the client
sees a neutral message.

**A claim is not proof.** "I dialled the codes" and "diversion is active" are
different assertions. Verification is a real test call, and the record
distinguishes `observed_inbound_call` from `client_self_report`. AIDA places no
outbound call to verify — the client rings their own number.

---

## 8. Database

`supabase/sql/lpm5_create_client_portal.sql` — **REVIEW ONLY, NOT APPLIED.**

Three additive tables, RLS enabled in the same transaction with no policies
(service_role only, house rule D8):

- `locksmith_change_requests`
- `locksmith_notification_settings`
- `locksmith_call_forwarding`

Constraints that encode a rule rather than a preference:

| Constraint | What it prevents |
|---|---|
| `lcr_voice_requires_session` | An untraceable spoken configuration change |
| `lcr_decision_is_complete` | A decision recording who but not when, or vice versa |
| `lcr_has_changes` | An empty request sitting in a queue looking legitimate |
| `lcf_confirmed_requires_verification` | A client marked live on an empty claim |
| `lcr_client_request_idx` | A handler that forgets the tenant filter finding another client's row |

Deferred deliberately: enquiry working-state storage (the decision affects the
v1 pipeline's row type), a notification delivery log (nothing sends yet), any
authenticated-role RLS policy, and change-request retention.

---

## 9. Security posture

- **Flag independence.** `LOCKSMITH_PORTAL_ENABLED` is separate from
  `LOCKSMITH_PILOT_ENABLED`. Strict parse: only the exact string `"true"`.
  Gate exits via `next("router")`, so a disabled deploy is byte-identical to the
  routes not existing.
- **Tenant key** is `req.clientId` from the verified session, everywhere. A test
  passes a hostile `clientId` in both query and body and asserts the read model
  is still asked for the session's client.
- **`createRequest(clientId, fields)`** forces `client_id` over anything in the
  payload — the one place the two could disagree, and the session's client is
  the only one verified.
- **CSRF**: httpOnly + SameSite=Lax cookies, JSON-only state changes (415
  otherwise), asserted at the route.
- **Headers**: `Cache-Control: no-store, private`, CSP with
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `noindex`.
- **Output escaping**: every interpolated value goes through
  `escapeHtml`/`escapeAttr`; a test drives all seven tabs with hostile strings
  in every field and asserts no `<img onerror>` or `<script>` survives.
- **Customer numbers masked** in list views.
- **Founder view carries no personal data** — no customer numbers, no transcript
  text — and no approve control.
- **Graceful degradation**: an unprovisioned table degrades one panel and
  answers 503 on writes; it never blanks the portal or reads as a bug.

## 10. Accessibility

Mobile-first, verified in-browser at 320 / 375 / 390 / 768 / 1280 across all
seven tabs — 35 combinations, checked for horizontal overflow, overflowing
elements, text under 12px, form controls under 16px, touch targets under 44px,
heading count and heading-level skips. **Final run: 0 findings**, with the
harness proven to be measuring real styled content rather than an empty
document.

- Exactly one `<h1>` per tab; skip link; `aria-current="page"` on the active tab.
- **No state is signalled by colour alone** — every chip carries a text label
  and a non-colour marker.
- 16px minimum body text (avoids iOS zoom-on-focus), 44px minimum touch targets.
- Call table becomes card-per-row below 900px. The M1 review found 768px still
  too cramped for tabular mode.
- Tab nav scrolls horizontally rather than wrapping into a second row that
  pushes content below the fold on a 320px phone.
- `prefers-reduced-motion` respected.

---

## 11. Tests

`test/locksmith-client-portal.test.js` — 94 tests, no node_modules, no database,
no network. Handlers are exercised through the injected-deps factory with fake
`req`/`res`, never supertest.

Full suite: **944/944**.

### Defects found by review, fixed with regression tests

| Defect | Why it mattered | Found by |
|---|---|---|
| The forbidden-promise guard trusted a caller-supplied `removing` hint | Submitting a new list with a mandatory promise simply absent stripped it while declaring nothing — from any channel, including voice | Writing the test |
| `isUrgent` read the raw analysis blob, bypassing the enum validation on the line above it | An unrecognised urgency value lit up the "needs attention" badge while the urgency column showed nothing | Fixture with a bogus enum |
| Profile completeness used a hand-written section list that did not match the schema | Invented sections that do not exist and missed real ones; would have shown a misleading percentage | Checking against `S.SECTIONS` |
| Delivery fallback required `d.primary`, which `validateDestination` never sets | A client who added their email and switched on notifications had **every message silently suppressed** | Adversarial pass |
| `toPublicChangeRequest` produced no `summary`, but both views render one | Every request in every list read "Change request"; a client could not tell them apart without opening each | Adversarial pass |
| The portal used `.button`, a class that exists in no stylesheet | Primary calls-to-action rendered as unstyled inline links, 21–35px tall | Browser review at 320px |
| The responsive harness measured `about:blank` | The first "zero findings" run proved nothing; the real run found 11 issues | Sanity-checking a clean result |

---

## 12. What M5 deliberately does not do

- Place a configuration call or connect a configuration-agent number.
- Send any notification (no transport exists).
- Activate a call diversion (only the client can, on their own handset).
- Approve anything on a client's behalf.
- Apply any SQL.
- Store enquiry working-state (deferred — see §8).
- Price anything. Billing preview returns `available: false` until M6 supplies a
  plan catalogue; the projection takes plans as an argument rather than
  importing one, so M5 stays committable without M6.
