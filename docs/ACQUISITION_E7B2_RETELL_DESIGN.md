# E-7B2 — the Retell acquisition provider

**Status:** **E-7B2A COMPLETE** (offline adapter + audit) · **E-7B2B1 COMPLETE**
(offline agent contract + outcome/reconciliation return path, §14) · **E-10A
COMPLETE** (the acquisition agent specified locally, §19) · **E-10C COMPLETE**
(response-engine / agent resource split, §20) · **E-10D(i) COMPLETE** — the
**acquisition response engine is PROVISIONED** on the dev Retell account, §21.
· **E-11A COMPLETE** — the acquisition webhook ingress is built, mounted in source and DORMANT (§22).
· **E-12A COMPLETE** — leave-no-message is now a PROVIDER setting, configured locally (§23).
· **E-12B COMPLETE** — the provisioned response engine is pinned against silent drift, the voice catalogue was read once, and the founder has **SELECTED the acquisition voice** (§24).
· **E-12C STOPPED AT THE DEPLOYMENT GATE** — there is exactly one environment and it is production, so the webhook was **NOT exposed** and no URL exists (§25).
**E-7B2B live activation NOT STARTED. E-7 REMAINS OPEN.** Acquisition calling is
PAUSED, no live provider exists, **the acquisition AGENT is NOT PROVISIONED**,
**voice is SELECTED** (Sunny, via `RETELL_ACQUISITION_VOICE_ID`, §24.7), webhook
is UNRESOLVED, the voicemail hang-up is **CONFIGURED LOCALLY but NEVER OBSERVED
ON A REAL CALL**, no outbound acquisition number is provisioned, and no
acquisition webhook route is exposed. **A response engine cannot ring anybody.**

**Owns (source of truth for):** how an authorised acquisition dial becomes a
Retell outbound call, what E-7B2B still requires, and why the adapter built in
E-7B2A cannot place a call.

---

## 1. The finding that reframed the milestone

The brief described `call-recorder` as a **secondary repository** to be audited
read-only, and asked where the cross-repo boundary lies.

**There is no second repository.** Both working copies point at the same
remote — `github.com/Foxtrot15/call-recorder.git`. They are two checkouts of one
repository on different branches:

| working copy | branch |
|---|---|
| `call-recorder-locksmith-acquisition` | `feature/locksmith-pilot-acquisition-foundation` |
| `call-recorder` | `feature/locksmith-pilot-m7e-live-diagnostics-validation` |

So the boundary is not cross-repo. It is **cross-branch**, and most of what
matters is already on our side:

| module | on the acquisition branch? |
|---|---|
| `src/services/retell-adapter.js` | **yes** — with `createPhoneCall` |
| `src/services/voice-platform-port.js` | **yes** |
| `src/config/retell.js` | **yes** — with `canPlaceCall` |
| `src/routes/retell-webhook-handler.js` | **yes** — byte-identical to M7E |
| `src/services/onboarding-call-service.js` | **yes** — byte-identical to M7E |

M7E has 32 commits we do not have, but they are diagnostics and sandbox work
(`retell-call-diagnostics`, `retell-web-sandbox`, `retell-multipart`,
`retrieveCallForDiagnostics`). **None is required to place an outbound call.**

**No cross-repo change is required, and none was made.**

---

## 2. The existing outbound mechanism

One exists and is production-shaped.

`retell-adapter.js` is the only file that knows Retell's HTTP shape. It exposes
`createPhoneCall` → `POST /v2/create-phone-call`, gated by `canPlaceCall`, which
demands `RETELL_ENABLED`, an API key, `RETELL_LIVE_CALLS_ENABLED=true` and an
outbound number. Above it sits `voice-platform-port.js`, a provider-neutral
result type: `{ ok, resource, providerRequestId }` or
`{ ok: false, error: { code, retryable } }`.

The one live consumer is `onboarding-call-service.js`, which sends:

```js
{ from_number, to_number, override_agent_id, metadata, retell_llm_dynamic_variables }
```

and reads `call_id` back off the response as `response.resource.id`.

**Two properties of that adapter are worth recording**, because both are load-
bearing for us:

1. **`fetchImpl` must be injected.** Absent it, every method refuses with
   `provider_misconfigured` before any gate is even consulted. Constructing the
   adapter cannot reach the network.
2. **`onboarding-call-service.js` constructs it without a `fetchImpl`** (line
   190). The runtime's own live path is therefore currently inert too. That is a
   finding about the runtime branch, not a defect we introduced or fixed.

---

## 3. The conflict we had to resolve: `retryable`

`voice-platform-port.js` marks **`provider_timeout`, `provider_unreachable`,
`provider_error` and `provider_rate_limited` as RETRYABLE** — "may be retried
with the same idempotency key".

For an onboarding call to a client who asked for it, that is correct: the cost
of a duplicate is mild annoyance.

**For a cold acquisition call it is the exact failure E-7A forbids.** A timeout
cannot distinguish *never arrived* from *arrived, placed the call, and the
answer was lost*. Retrying resolves that ambiguity in the one direction that
cannot be undone — two telephone calls to a business that never asked to hear
from us.

**So the acquisition provider discards `retryable` entirely.** It is not read,
not mapped, and not passed upward. A test asserts the flag never appears on a
result. `RETELL_MAX_RETRIES` exists in `config/retell.js` (default 2) but is
**carried and never acted on** — no code loops on it, verified by search.

---

## 4. Architecture

```
M8E gate → AuthorisedDial (genuine, frozen, 60s)
   → acquisition-dial-execution   durable stop #1 · claim · durable stop #2
      → RetellAcquisitionProvider   payload + response mapping   ← E-7B2A
         → [ no transport wired ]                                ← E-7B2B
            → retell-adapter.createPhoneCall
               → Retell
```

The provider is a **mechanism**. It cannot see DNCR, suppression, batch
approval, duplicate resolution, attempt policy, the calling window, holidays or
eligibility, because the execution object it receives contains none of them.

### 4.1 Why it is a separate file

`acquisition-dial-provider.js` carries a ratchet asserting it exports exactly
`createDisabledDialProvider` and `createFakeDialProvider`. Adding a third
factory there would have meant **relaxing the ratchet that says no live provider
exists**. The ratchet is right. `acquisition-retell-provider.js` lives beside
it, under its own equivalent ratchets.

### 4.2 Why it takes an injected transport

If the provider imported `retell-adapter.js`, the acquisition path would import
a module that can reach the network, and the E-7A network ratchets would have to
be narrowed. Instead `createRetellAcquisitionProvider({ routing, transport })`
takes the submitter as an argument. **Nothing in this repository constructs
one** — a test walks every `acquisition-*.js` and asserts no caller exists.

---

## 5. The request contract

```js
{
  from_number:      routing.fromNumber,     // server-side config, never the caller
  to_number:        execution.destination,  // straight off the slip. No override exists
  override_agent_id: routing.agentId,       // server-side config
  metadata: {
    aida_purpose:      "locksmith_acquisition",
    aida_execution_id: execution.executionId,
    aida_prospect_id:  execution.prospectId,
  },
  retell_llm_dynamic_variables: { business_name, authorised_at },
}
```

`buildRetellCallPayload` is pure — same execution, same payload, always. It
refuses a missing or malformed destination, and refuses a destination equal to
the outbound number.

**There is no parameter, override, fallback or second number anywhere in it.** A
caller who wants a different number must obtain a different authorisation.

---

## 6. The response contract

| Retell answer | provider result | dispatch row |
|---|---|---|
| `ok` with `call_id` | `accepted`, `providerRef = call_id` | `provider_status: submitted`, `provider_ref` set, **`resolved_at` still null** |
| definitive rejection (`invalid_request`, `provider_unauthorized`, `provider_not_found`, `operation_not_permitted`, `provider_disabled`, `provider_misconfigured`, `operation_unsupported`, `provider_rate_limited`) | `refused` | `provider_status: refused`, **unresolved** |
| `provider_timeout` / `provider_unreachable` / `provider_error` | **throws `AmbiguousSubmission`** | `provider_status: unknown`, `submitted_at` null, **unresolved** |
| unrecognised code | **throws** — fails towards ambiguity | as above |
| `ok` but **no `call_id`** | **throws** | as above |

**Ambiguity is thrown rather than returned, deliberately.** The executor's
contract is that a provider which throws yields `provider_status: 'unknown'`
with no `submitted_at` — the one status laq5 permits to stand alone, precisely
because not knowing whether the provider was reached is what it means. Returning
a refusal instead would assert `submitted_at` and would be a **lie in the
ledger**.

---

## 7. No SQL is required

LAQ5 already carries every field:

| need | LAQ5 column |
|---|---|
| which provider | `provider` |
| was it a live one | `provider_live` |
| submission state | `provider_status` — `pending`/`submitted`/`refused`/`unknown` |
| **the Retell `call_id`** | **`provider_ref`** (text, clipped to 200) |
| when we reached it | `submitted_at` |
| why it failed | `error_code` |

`recordProviderResult({ store, dispatchId, providerStatus, providerRef, errorCode })`
already accepts the reference and already refuses to set `resolved_at`. The
invariant **one `dispatchId` → at most one submission → at most one `call_id`**
holds through the existing partial unique indexes and the single-use rule.

**No new table, column, index, constraint, function or callback store.**

---

## 8. Correlating an ambiguous submission — CLOSED

**This was an open gap when E-7B2A was first built, and a founder check caught
it before push.** The provider received `executionId` and not `dispatchId`, and
`executionId` is `ex_` + a 20-hex truncation of `sha256(dispatchId)` — a
**one-way** derivation. So if the create-call response was lost, `provider_ref`
was never written, and a webhook arriving later carried a `call_id` we had never
seen with nothing tying it to the dispatch. Recovery would have meant listing
unresolved rows and recomputing the executor's private hash for each: a second
copy of a derivation that must never diverge, and a scan where a lookup belongs.

**Fixed.** The exact LAQ5 `dispatchId` now travels, unhashed and untruncated:

| field | value | role |
|---|---|---|
| `metadata.aida_dispatch_id` | **the exact `slip.dispatchId`** | the durable LAQ5 identity and external reconciliation key |
| `metadata.aida_execution_id` | `executionId`, unchanged | names this attempt in logs |

They are different things and neither replaces the other. The executor's
submission carries `dispatchId` verbatim off the genuine slip — not
caller-supplied, not recomputed, not hashed, not truncated, not transformed —
and `buildRetellCallPayload` **refuses to build a payload without it**, because
a request whose lost response would be unreconcilable should be unbuildable
rather than merely unusual.

A ratchet pins it: `metadata.aida_dispatch_id === slip.dispatchId`, with the
executionId, the authorisationId, a hash of the dispatchId and a truncation of
it all explicitly rejected as substitutes. Substituting `executionId` in the
source fails six tests, including the lost-response scenario.

---

## 9. Webhook and outcome path — audited, not built

`retell-webhook-handler.js` is mature and reusable:

- signature verified **before** the body is parsed;
- envelope validated; unknown event types ignored rather than trusted;
- **fingerprint idempotency** — a duplicate delivery returns 204 and re-runs
  nothing;
- `resolveBinding(providerCallId)` resolves a call id to its owner **before**
  any decision, so a mismatch fails closed at the edge;
- processing happens **after** the 204, so acknowledgement is never delayed.

Event vocabulary: `call_started`, `call_ended`, `call_analyzed`. The transcript
is acted on at `call_ended`; analysis arrives at `call_analyzed`.

`disconnection_reason` maps (existing `normaliseEndReason`):

| Retell | ours |
|---|---|
| `dial_no_answer` | `no_answer` |
| `voicemail_reached`, `machine_detected` | `voicemail` |
| `user_hangup` | `caller_ended` |
| `agent_hangup` | `agent_ended` |
| `dial_busy` | `busy` |
| `dial_failed` | `dial_failed` |
| `inactivity`, `max_duration_reached` | `timed_out` |
| `error` | `provider_error` |

**What this vocabulary cannot express** is the answer acquisition actually
needs. `not_interested`, `declined`, `opt_out` and `callback_requested` are
**not** disconnection reasons — every one of them ends in `user_hangup` or
`agent_hangup`. They must come from **post-call analysis**
(`post_call_analysis_data` on the agent, surfaced at `call_analyzed`), which
means a structured analysis schema, which means the acquisition agent (§10).

**An opt-out heard on a call is permanent and append-only.** Deriving it from an
LLM transcript reading is a decision with consequences that cannot be taken
back, and it is **not** made here. E-7B2B must decide explicitly how an opt-out
is confirmed before any call is placed.

**Missed or delayed webhook:** the dispatch stays unresolved and holds both
locks. `listUnresolvedDispatches` is the operator's report. **Nothing re-calls
because a webhook did not arrive** — that is the whole point of resolution being
a human or an outcome, never a timer.

---

## 10. The acquisition agent must be a NEW agent

Two agent compilers already exist:

- `locksmith-receptionist-compiler.js` — **inbound** receptionist for a
  locksmith's own customers;
- `locksmith-onboarding-agent-compiler.js` — **outbound to a consenting client**
  who requested a setup interview.

**Neither is appropriate for cold acquisition**, and reusing either would be a
compliance problem, not merely a quality one:

| | receptionist | onboarding | acquisition needs |
|---|---|---|---|
| who is called | inbound caller | a client who asked | a business that did not ask |
| identity disclosure | none needed | already knows us | **must identify itself and its purpose** |
| objective | serve a caller | gather configuration | introduce a service |
| opt-out handling | not modelled | not needed | **must honour and record one** |
| callback | not modelled | not needed | **14-day window (A-L8)** |
| routing assumptions | customer service | interview flow | **none of either** |

A **third, purpose-built acquisition agent** is required, with its own system
prompt, disclosure, objection handling, opt-out capture and analysis schema.

**No agent was created.** Creating one is a network write (`createAgent`) and
belongs to E-7B2B. AI disclosure wording remains deliberately out of scope and
uninvented — it is a founder/compliance decision, not an engineering one.

---

## 11. Configuration E-7B2B will require

Names only. **No value was populated, and no credential was read.**

| variable | why |
|---|---|
| `RETELL_API_KEY` | existing. Also the webhook signing secret |
| `RETELL_ENABLED` | existing |
| `RETELL_LIVE_CALLS_ENABLED` | existing. Part of `canPlaceCall` |
| `RETELL_WEBHOOK_ENABLED` | existing |
| **`RETELL_ACQUISITION_AGENT_ID`** | **new** — the acquisition agent (§10) |
| **`RETELL_ACQUISITION_FROM_NUMBER`** | **new** — acquisition must not dial from the onboarding number |

`canPlaceCall` currently requires `RETELL_OUTBOUND_ONBOARDING_NUMBER`
specifically. **Acquisition needs its own capability gate**, not a reuse of the
onboarding one, so that enabling setup calls can never enable acquisition calls
as a side effect.

---

## 12. What E-7B2A did NOT do

- **No network request of any kind.** No Retell, Twilio, DNCR or Outscraper
  contact; no call, SMS or email.
- **No live provider.** `live` is the literal `false` — not a parameter, not
  derived from whether a transport was supplied. A caller passing `live: true`
  gets `false`.
- **No transport wired.** Without one, `submit()` refuses with
  `acquisition_retell_transport_absent`.
- **No agent created, no number bound, no credential read, no env var read.**
- **No SQL, no DEV write, no production contact.** DEV residue stays 23 and
  calling stays `paused` at revision 1.
- **E-7 is not closed. DNCR-1 is not closed. A-L2 is not closed.**

---

## 13. E-7B2B — the remaining work

1. **Create the acquisition agent** (§10) with its analysis schema, disclosure
   and opt-out capture. Network write.
2. **Provision an acquisition outbound number** and its own capability gate
   (§11).
3. **Wire a transport** — the one line E-7B2A deliberately leaves undone — and
   flip `live` to `true`, which will **fail the live-call-impossibility ratchet
   until somebody updates it on purpose**. That is the design.
4. ~~**Add `dispatchId` to the provider submission**~~ — **DONE in the E-7B2A
   correlation fix.** The exact LAQ5 key travels in `aida_dispatch_id` (§8).
5. **Decide how an opt-out is confirmed** from a call (§9). Policy, not code.
6. **Build the webhook → outcome → resolution path**, in that order: durable
   contact outcome first, dispatch resolution second.
7. **DNCR-1 operational readiness** — activation, first real wash, attestation.
8. **A founder-authorised live proof**, to one number, once.

**Items 1–6 are engineering and could be done today. Item 7 is an external
dependency with a lead time and is the only one nobody here can accelerate.**

---

## 14. E-7B2B1 — the return path, offline

**Status: COMPLETE, OFFLINE. E-7 REMAINS OPEN. No agent provisioned, no number
provisioned, no route exposed, calling still PAUSED.**

A call that cannot yet be placed still needs a way home. E-7B2B1 builds it:
verified event → exact dispatch → bound call id → classified outcome → durable
outcome → and only then the lock.

### 14.1 What the audit found, and what it did not require

| question | answer |
|---|---|
| webhook signature verification | **exists** — `retell-webhook-verify.js`, delegating to the SDK, with stale-window, size and content-type checks. **Reused, not reimplemented** |
| durable webhook idempotency | **exists** — `provider_webhook_events` (lpm3) is unique on `fingerprint`, and a 23505 is treated as a duplicate. **Survives restart** |
| is `call.metadata` available | **yes** — `validateEventEnvelope` returns the whole raw call object, so `metadata.aida_dispatch_id` is recoverable on every handled event |
| can LAQ5 bind a call id after a lost response | **yes.** `provider_ref` is **not** in the guard's immutable identity list, so it can be set later provided `resolved_at` is null and `provider_status` is not changed |
| new SQL required | **NO** |
| new HTTP route required | **NO** — the handler is a pure function and nothing mounts it |

### 14.2 The LAQ5 constraint that shaped the design

The guard makes `provider_status` **forward-only out of `pending`**. A dispatch
left `unknown` by a lost response therefore **cannot be promoted** to
`submitted` — and it is not. Only `provider_ref` is bound.

That is the honest outcome anyway: `unknown` records what we knew *at
submission*, which a later webhook does not change. What changes is that we now
know **which call it was**. Promoting the status would have needed a trigger
change, which is a SQL gate, which this milestone does not cross.

### 14.3 Phases — why a hang-up is not an answer

`call_ended` routinely arrives **before** `call_analyzed`, and outcomes are
append-only. So a technical outcome is written **only** where no analysis could
change it:

| Retell `disconnection_reason` | outcome |
|---|---|
| `dial_no_answer` | `no_answer` |
| `voicemail_reached`, `machine_detected` | `voicemail` |
| `dial_busy` | `no_answer` — nobody was reached |
| `user_hangup`, `agent_hangup`, `inactivity`, `max_duration_reached` | **nothing.** Somebody talked to us; what they said decides |
| `error`, `dial_failed` | **nothing.** We cannot tell whether a telephone rang |

Writing "they hung up" at `call_ended` would put a technical fact where a
business conclusion belongs, in a table that cannot be corrected. So the
connected cases wait, and if the analysis never arrives the dispatch stays
unresolved and an operator sees it. **Nothing re-calls because a webhook did not
arrive.**

### 14.4 The opt-out is held to a higher standard than anything else

`explicit_opt_out: true` is accepted **only** with `confidence: high` **and**
transcript evidence. Anything weaker returns the whole analysis as
`analysis_opt_out_unsupported` — **not downgraded to a decline, and not
dropped**. Nothing is recorded and a human decides.

The asymmetry is deliberate: an opt-out written in error is permanent and
append-only; an opt-out missed is corrected by the next conversation. Those
costs are not equal.

`not_interested`, `declined` and `opt_out` stay **distinct**. A callback is a
callback, never a suppression.

### 14.5 Separation of powers

The handler **classifies**. It never writes a suppression and never sets
`resolved_at` — ratchets assert both. Suppression belongs to
`acquisition-outcome.js`, which already owns it; the ordering (outcome first,
lock second) belongs to `acquisition-dispatch-resolution.js`, which already owns
that. E-7B2B1 adds no third place for either rule to live.

### 14.6 THE GAP THIS MILESTONE FOUND — **CLOSED BY E-8**

> **Closed 2026-08-13 by E-8, with no SQL.** The dispatch claim now establishes
> `queued`, a definite provider acceptance or a later authenticated webhook
> establishes `attempted`, and the analysis reporting a person was reached
> establishes `connected`. The outcome guard was not weakened. See
> [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md) §14. The
> description below is what was true when this section was written.

**Nothing in the pipeline currently makes a prospect contactable.**

`acquisition-outcome` refuses to record against anything not `queued`,
`attempted`, `connected` or `callback_requested` — "no call could have been made
to it, so there is no outcome to record". The lifecycle is
`review_approved → queued → attempted`, and **no batch selection sets `queued`
and no dispatch sets `attempted`.**

So today the return path would refuse every outcome. It refuses **safely** —
nothing written, both locks held, a human sees it — and that refusal is proven
rather than assumed. But it means **E-7B2B must set `queued` at batch selection
and `attempted` at dispatch** before any live call, and that belongs to the
dispatch side: a webhook asserting "a call was attempted" would be the wrong
module making the claim.

### 14.7 Residual gap for live activation, reported not fixed

`provider_ref` has **no unique index**. Two dispatches bound to one Retell
`call_id` is prevented by application logic (a conflicting id is refused and the
first is never overwritten) and made implausible by single-use dispatch, but it
is **not prevented by the database**. Adding
`unique (provider_ref) where provider_ref is not null` is defence in depth for
E-7B2B and requires founder approval, so it is **not written here**.

Likewise `lpm3` (the webhook-event idempotency table) must be **applied wherever
acquisition webhooks are processed**. It is not part of laq1–laq5.

---

## 19. E-10A — the acquisition agent, specified and unprovisioned

**Status: LOCAL AGENT SPEC COMPLETE. Retell acquisition agent NOT PROVISIONED.
No outbound number. No webhook route. Calling PAUSED. E-7 OPEN.**

`src/services/acquisition-agent-spec.js` builds the opening, the
`general_prompt`, the `post_call_analysis_data` fields and the exact
`create-agent` payload — and sends none of it. `describeAcquisitionAgentPayload`
returns the request that *would* go, carrying a `_note` saying it has not.

### 19.1 Disclosure — a product decision, stated as one

The agent says it is an AI assistant **unprompted, in the opening**, and answers
plainly if asked whether it is AI, a robot, automated or a person. It may never
claim to be human. Ratchets enforce all three.

**This is recorded as founder product policy, not as a legal requirement.**
Nothing here claims Australian law mandates the words "AI assistant" — M8M
already established that this repository does not manufacture legal positions,
and that rule holds here.

### 19.2 THE IDENTITY MODEL — three roles, three fields

**Settled by founder decision.** The first draft named the product as the
caller; that is corrected.

| role | value | what it is |
|---|---|---|
| `assistantName` | **Aida** | the thing speaking |
| `companyName` | **Niche Drops** | **the business placing the call** |
| `productName` | **AIDA** | **the product being discussed** |

They are three separate fields and stay that way. Merging any two to make a
sentence flow would put back the ambiguity this correction removes, and the
prompt states each role explicitly so the agent cannot say "AIDA is my company"
or describe Niche Drops as the receptionist.

Current opening concept:

> "Hi, this is Aida, an AI assistant from Niche Drops. I'm calling about AIDA,
> our AI receptionist for locksmiths. We help with missed and after-hours calls,
> and I was just calling to see if that might be useful for your business."

**This wording is not frozen.** It is founder-tunable concept copy and is
expected to be refined for speech. No test asserts it verbatim.

### 19.2a The ratchets test MEANING, not copy

`describeOpeningSemantics()` reports what an opening conveys **relative to the
configured identity**, and the ratchets assert that. Rewording, reordering,
splitting into two sentences, or writing "artificial intelligence" instead of
"AI" all pass; dropping a required fact fails.

Two collisions had to be handled, and both come from the same source — **"Aida"
is a substring of "AIDA"**:

- a plain check for the assistant's name matched an opening that only named the
  **product**, so self-identification now requires a frame: *"this is Aida"*,
  *"I'm Aida"*, *"my name is Aida"*;
- a plain check for the product matched the **assistant's** introduction, so the
  product now requires a product frame — *"about AIDA"*, *"we provide AIDA"*,
  *"AIDA handles…"*. An appositive frame (*"AIDA, our AI receptionist"*) is
  deliberately **not** accepted, because it is indistinguishable from *"Aida, an
  AI assistant"*.

Proven both ways: four plausible founder rewordings are **accepted**, and seven
openings that each lose exactly one required fact are **rejected**.

### 19.3 The tagline may not be spoken

`tagline: "Never lose another after-hours locksmith enquiry"` is an **absolute**,
and no infrastructure here justifies one. It is on the forbidden list and a
ratchet asserts it never appears in the prompt.

Copy on a page somebody chose to visit is not the same act as a promise made
down a telephone to a stranger who did not.

### 19.4 Price is never hardcoded and never raised first

`DEFAULT_PRICING` is `provisional: true` and env-overridable, and its own comment
says there is **exactly one numeric source**. A prompt is not it.

The agent never introduces price. If asked, it quotes **only** figures passed in
as data at compile time, always framed as founding-pilot pricing confirmed at
setup; given none, it says so and offers to have details sent. A ratchet asserts
no amount appears in the spec source.

### 19.5 Voicemail — leave no message, for now

**Recommendation: hang up.** Three reasons, the third decisive:

1. a voicemail **consumes a counted attempt** under A-L7 and a no-answer does
   not, so a message spends half a business's permitted contact on a recording
   nobody agreed to receive;
2. no recorded acquisition message has ever been written or reviewed here, and a
   first live proof is the wrong moment to hear one for the first time;
3. **machine detection is a provider behaviour we have never configured or
   observed.** Drafting a message that assumes it works reliably would be
   inventing a capability.

**No template is provided.** `VOICEMAIL_POLICY.template` is `null`, and a test
asserts it.

### 19.6 The analysis schema, and what is deliberately absent

Retell `post_call_analysis_data` in this repository's existing shape
(`type`/`name`/`description`, `choices` for enums): `reached_human`,
`final_outcome` (closed enum), `explicit_opt_out`, `callback_requested`,
`requested_callback_at`, `confidence`, `transcript_evidence`, `brief_reason`,
plus the two system presets.

**`voicemail` and `no_answer` are NOT in the outcome enum.** They are machine
facts derived from `disconnection_reason` at `call_ended` (§14.3), and letting
the analysis assert them as well would put one fact behind two sources that can
disagree. The enum is the conversation vocabulary only.

The field descriptions carry the conservative rule to the model itself:
`explicit_opt_out` says being busy or uninterested is **not** an opt-out and to
answer false when unsure; `transcript_evidence` says it is **required** when an
opt-out is reported.

### 19.7 Proven offline

**37 tests.** Eighteen conversations — interested, "how does it work", price,
not interested, declined, "don't call me again", busy, callback tomorrow, wrong
person, "are you a robot", "are you a real person", hostile, voicemail, no
answer, "maybe another time", already has a receptionist, missed calls are a
problem, unsupported feature — each run through the real validate-and-classify
path.

Ratchets fail the build if the opening loses its disclosure, the prompt permits
claiming to be human, AIDA identity disappears, pitching continues after an
opt-out or a clear refusal, "busy" becomes a refusal, the outcome enum opens to
free text, an opt-out is accepted without evidence, or any guarantee appears.
The guarantee ratchet was checked by planting one: it fires.

---

## 20. E-10C — two Retell resources, and the order between them

**Status: RESOURCE SPLIT COMPLETE, OFFLINE. Acquisition response engine NOT
PROVISIONED. Acquisition agent NOT PROVISIONED. Voice UNRESOLVED. Webhook
UNRESOLVED. Voicemail provider enforcement UNRESOLVED. Calling PAUSED.**

### 20.1 The defect E-10B found

`describeAcquisitionAgentPayload` returned **one** object carrying agent fields
**and** `general_prompt` **and** `begin_message`. Wrong against Retell's API and
against this repository's own convention — both existing compilers already
split the two:

| resource | endpoint | carries |
|---|---|---|
| response engine | `POST /create-retell-llm` | `general_prompt`, `begin_message`, `default_dynamic_variables`, `general_tools` |
| agent | `POST /create-agent` | `agent_name`, `response_engine {type, llm_id}`, `voice_id`, `language`, `webhook_url`, `post_call_analysis_data` |

Sent as it was, it would have created **an agent with no brain** — `llm_id`
null — while the prompt went to an endpoint that does not accept one.

### 20.2 THE PROVISIONING HAZARD, and why acquisition is NOT in the shared list

`provisioning-plan.js` exposes `DESIRED_RESOURCE_ORDER`, and it is tempting to
add two acquisition rows to it. **That would have been a landmine.**

`buildDesiredResources` looks each entry up in a `byResource` map keyed by
**`resourceType`** and built from **one compiled receptionist**. An acquisition
entry with `resourceType: "response_engine"` would therefore be handed the
**receptionist's** engine payload and emitted as an acquisition-purposed row
carrying receptionist content — a wrong resource with a convincing name.

There is **no executor** — nothing dispatches `operation` to an adapter, so
nothing could have been created either way. But "it cannot run yet" is a poor
reason to leave a trap where the next person will step on it.

So acquisition has its **own** `ACQUISITION_RESOURCE_ORDER`, in the acquisition
module, and `provisioning-plan.js` does not mention acquisition at all. A test
asserts that, and another walks `src/services`, `src/routes` and `scripts`
proving **nothing anywhere constructs acquisition resources**. Provisioning
acquisition must be an explicit act, never a side effect of planning a
receptionist.

### 20.3 The dependency, expressed rather than remembered

```
acquisition response engine  →  llm_id  →  acquisition agent
        (no dependency)                     (dependsOn: response_engine)
```

`describeAcquisitionRetellResources({ llmId })` binds a supplied id into exactly
one field, `agent.response_engine.llm_id`, and the engine never carries its own
id. Until a real one is supplied it stays `null` and the agent is **not
provisionable** — reported as a named blocker rather than inferred.

### 20.4 Readiness is computed, and says what is missing

```
createAgentReady: false
blockers:
  - no acquisition response-engine id has been supplied (create the engine first)
  - voice_id is unresolved — a founder must choose one
  - webhook_url is unresolved — the acquisition route is not exposed
unverifiedAfterCreation:
  - hang-up on a detected answering machine is configured but has never been
    observed on a real call
```

**Computed from the blockers, not hardcoded.** A flag that can never say yes is
one people learn to ignore.

**Revised by E-12A.** This list previously carried a fourth blocker, *"provider
behaviour on an answering machine is unverified"*, which was **unsatisfiable by
construction**: the behaviour cannot be observed until an agent exists and has
been telephoned, and the agent could not be created until the behaviour had been
observed. E-12A settles the half that can be settled in advance — whether the
hang-up is actually in the payload — and moves the half that cannot into
`unverifiedAfterCreation`, where it is still reported by name rather than
deleted. See §23.2.

`webhook_url` reads only `config.acquisitionWebhookUrl` — passing the
receptionist's `webhookBaseUrl` leaves it **null**, so the acquisition agent
cannot inherit another family's webhook by accident.

### 20.5 The old API is gone, not aliased

`describeAcquisitionAgentPayload` no longer exists. Its name promised one agent
payload while the truth is two unrelated API resources with a dependency between
them, and a misleading name is worse than a rename.

### 20.6 Unchanged by this milestone

Language `en-AU`. Voice unresolved and never invented. No pricing injected. No
pronunciation encoded. Opening unchanged and still tunable — E-10C is
architecture, not copy. Voicemail stays no-message with a `null` template.

> **Superseded by E-12A (§23).** As of E-10C there was no voicemail,
> machine-detection or hang-up field anywhere in this repository's Retell
> surface. E-12A adds exactly one — `voicemail_option.action.type: "hangup"` —
> on the acquisition agent, and nowhere else.

---

## 21. E-10D(i) — the acquisition response engine, provisioned

**Status: ACQUISITION RESPONSE ENGINE PROVISIONED (dev Retell account,
2026-08-13). ACQUISITION AGENT NOT PROVISIONED. Voice UNRESOLVED. Webhook
UNRESOLVED. Outbound number NOT PROVISIONED. Voicemail provider enforcement
UNVERIFIED. Calling PAUSED. E-7 OPEN. DNCR-1 OPEN.**

The first authorised Retell network write in this chain, and the smallest one
available: a Retell LLM holding a prompt and an opening. **It has no voice, no
agent, no telephone number and no webhook — it cannot ring anybody and cannot be
rung.**

| | |
|---|---|
| operation | `createResponseEngine` — **one request, no retry** |
| account tag | `dev` (the script refuses `prod`) |
| result | **created**, 907 ms, resource version 0 |
| id | recorded as `RETELL_ACQUISITION_LLM_ID` in the deployment environment — **deliberately not in git** |
| spec version | `acq-agent-spec-2026-08-13` |

### 21.1 Two things had to be built to do this at all

**A transport.** Nothing in this branch injects a `fetchImpl`, which is exactly
what has kept the repository structurally incapable of a live write. The script
supplies one **for one command, run by hand**. Wiring a transport into the
running service would hand that capability to everything, permanently, and no
milestone has asked for that. The service remains inert.

**A narrowed ratchet.** `acquisition-agent-resources.test.js` asserted that
*nothing anywhere* builds acquisition resources — correct while provisioning was
unauthorised. The rule it protects is unchanged (acquisition is never
provisioned as a side effect of something else), so the exception is **one
named filename**, not a relaxed pattern. A second provisioning caller appearing
anywhere still fails the build.

### 21.2 How "no agent was created" is known

**Structurally, not by asking Retell.** Four ratchets read the only file that
can reach the provider and assert:

- it calls `createResponseEngine` and **exactly one** `adapter.create*` in the
  whole file;
- it contains **no** `createAgent`, `updateAgent`, `createPhoneCall`,
  `createWebCall`, `bindPhoneNumber` or `deleteAgent` path;
- it has **no retry, backoff, timer or loop**;
- it sends `resources.responseEngine` and **cannot reach `resources.agent`**;
- it **defaults to preview** — sending is opt-in via an explicit flag — and
  refuses the `prod` tag.

A second network call to list agents would have been a second unauthorised
request; the code path is the stronger evidence anyway.

### 21.3 Ambiguity handling, which fortunately went unused

A timeout or lost response does **not** mean nothing was created — Retell may
have built the engine and lost the answer coming back. The script therefore
separates a **definitive** refusal (4xx: nothing created, safe to correct and
run again) from an **ambiguous** one (timeout, unreachable, provider error, or
success carrying no id), and on ambiguity it exits telling the operator to look
in the dashboard **before** anything else is sent. It never retries.

The write succeeded first time, so none of that fired. It is recorded because
the next milestone creates an agent under the same rule.

### 21.4 What did NOT happen

No agent. No phone number. No webhook exposed. No voice chosen or listed. No
transport wired into the acquisition executor. No provider set `live: true`. No
calling-state change. No DEV write, no SQL. No prospect, Twilio or DNCR contact.
No call, SMS or email. Production untouched.

---

## 22. E-11A — the acquisition webhook ingress, built and dormant

**Status: CLOSED ON DEV. Route IMPLEMENTED AND MOUNTED IN SOURCE, NOT DEPLOYED,
NOT EXPOSED, DORMANT BY DEFAULT. Retell webhook_url UNSET. **LPM3 APPLIED TO
DEV** (§22.5) — the durable idempotency schema is present. Response engine
PROVISIONED · agent NOT PROVISIONED · number NOT PROVISIONED · providers
`live:false` · calling PAUSED · E-7 OPEN · DNCR-1 OPEN.**

### 22.1 A dedicated route, not the shared ingress

`POST /webhooks/retell/acquisition`, alongside the onboarding
`POST /webhooks/retell` rather than inside it.

Retell attaches `webhook_url` **per agent**, so the acquisition agent will point
here and nothing else will. Sharing the onboarding ingress would mean every
acquisition delivery traversing `decideEventHandling`, whose binding model asks
*"which onboarding session is this?"* and answers `record_unbound` when there is
none — so acquisition events would be recorded and never processed, or filed
against the wrong domain.

### 22.2 What is reused, and what is deliberately not

**Reused:** `verifyRetellWebhook` — the one signature implementation; this
handler verifies nothing itself and a ratchet asserts it contains no `crypto`,
`createHmac` or `timingSafeEqual`. Also reused: `provider-webhook-events` for
envelope validation, the deterministic fingerprint, and the durable LPM3 record.

**Not reused:** `decideEventHandling` and the onboarding processor contract.
Acquisition is bound by `metadata.aida_dispatch_id` and by nothing else.

### 22.3 Its own third flag

`RETELL_ENABLED` · `RETELL_WEBHOOK_ENABLED` · **`RETELL_ACQUISITION_WEBHOOK_ENABLED`**

The third exists so that switching onboarding webhooks on can never switch
acquisition ingestion on with them — the same reason acquisition keeps its own
resource order, and the same reason it will need its own capability gate before
it can dial. Off by default; the gate `next("router")`s and the path 404s.

### 22.4 Order, and the one transient answer

```
signature → parse → envelope → is it ours? → fingerprint → correlate → 204 → work
```

The first three mutate nothing. **The "is it ours?" check sits before the
fingerprint write**, so somebody else's traffic on a shared provider account
never fills our event log.

| answer | when |
|---|---|
| **204** | processed, duplicate, ignored, not-ours, **and permanent acquisition conflicts** |
| 400 | malformed body or envelope |
| 401 | missing, stale or invalid signature |
| 413 | oversize |
| **503** | webhook disabled, verifier unavailable, **or our storage is down** — the only genuinely transient cases |

**A permanent call-id conflict returns 204 on purpose.** Retell retries non-2xx;
a conflict will be refused identically for ever, so a 5xx would turn one
operator's problem into a stream of them. It is recorded in the durable log as
`failed` — needing a human — while the HTTP answer says "heard you, stop
resending".

### 22.5 LPM3 — APPLIED TO DEV, 2026-08-13

**Applied by hand by the founder** (`supabase/sql/lpm3_create_retell_provisioning.sql`), completing without SQL error. Production has **not** received it.

**Verified by me, read-only over PostgREST** — existence only:

| table | dev |
|---|---|
| `provider_webhook_events` | **PRESENT**, 0 rows |
| `provisioning_plans` | **PRESENT**, 0 rows |
| `provider_resources` | **PRESENT**, 0 rows |

**Verified by the founder in the SQL editor** — I cannot read `pg_constraint` or
`pg_class` through PostgREST and do not claim to have:

- `pwe_fingerprint_key`, `contype = u` — the UNIQUE fingerprint constraint;
- RLS enabled with **0 policies** on all three tables.

That constraint **is** the durable idempotency authority: a redelivered Retell
delivery collides on it and is acknowledged without being processed twice. The
arbitration is the database, not this process.

**A NAME CORRECTION.** The earlier E-11A report listed `retell_resources` as
absent. That table has never existed under that name — the real one is
**`provider_resources`**, as `provider-resource-registry.js:23` and lpm3 itself
both say. The conclusion at the time was still right, because
`provider_webhook_events` and `provisioning_plans` were genuinely absent, but the
name was wrong and the probe was weaker than it looked.

Acquisition residue is **unchanged at 23** — lpm3 creates no acquisition row and
touches no acquisition table.

### 22.6 What did NOT happen

No Retell request of any kind — the response engine was not recreated, no agent,
no number, no remote webhook configuration, no voice listing. Nothing deployed,
no tunnel, no public host. `RETELL_ACQUISITION_WEBHOOK_URL` is named as a
concept and **deliberately unpopulated** — there is no deployed route for it to
name. No transport wired into the executor, no provider `live: true`, no
calling-state change, no DEV write, no SQL, production untouched.

---

## 23. E-12A — hang up on an answering machine, and mean it

**Status: CONFIGURED LOCALLY. NOT LIVE-VERIFIED. No Retell request was made.
Agent still NOT PROVISIONED. Voice UNRESOLVED. Webhook UNRESOLVED. Number NOT
PROVISIONED. Calling PAUSED. E-7 OPEN. DNCR-1 OPEN.**

Founder policy: **if Retell detects voicemail, hang up. Leave no message.**

### 23.1 The gap, stated accurately

The policy has existed since E-10A as `VOICEMAIL_POLICY`, and the honest finding
of this milestone is that **it was carried by nothing that reaches the provider**.

`VOICEMAIL_POLICY` is a specification object consumed by documents and tests.
`buildAcquisitionAgentPrompt` has never emitted a word of it into
`general_prompt` — verified by an assertion, not by reading. So the position
before E-12A was not "enforcement is weak because a prompt is only guidance". It
was **no enforcement at all**: nothing on the wire, in either resource, said
anything about an answering machine.

That matters for what it would have cost. Detection would not have happened, the
call would have run its opening into a recording, and under **A-L7 a voicemail
consumes one of the two counted attempts** — half the contact this business is
ever permitted, spent on a message nobody agreed to receive.

### 23.2 The setting

On the acquisition **agent** (`POST /create-agent`), and nowhere else:

```json
"voicemail_option": { "action": { "type": "hangup" } }
```

Retell ends the call itself on detection. The model is not consulted, so the
failure mode stops being possible rather than becoming unlikely.

**It is a frozen module constant, not a config field.** Every other field on this
payload falls back to a caller-supplied value; this one deliberately does not. A
caller able to supply the action could supply a static-text one and turn "leave
no message" into a message, from outside the file where the policy is written
and reviewed. Changing it has to be an edit to that line. A ratchet feeds six
hostile config shapes in and asserts the payload is unmoved.

**No message exists by any route.** No `static_text`, no prompt-generated
message, no callback, no `text` key to fill in by accident. `template` stays
`null`. Enabling any of them is a separate founder decision.

**The prompt was deliberately NOT changed — DECIDED, not open.** Adding the
sentence to `general_prompt` would edit the response engine, which is **already
provisioned** at `llm_111ed…`; the local spec would then disagree with the live
resource and require an `updateResponseEngine` network write.

**Founder decision, 2026-08-13: do not add it, and leave the response engine
unchanged.** Machine detection is owned by the provider, the LLM prompt is not
the detection authority, and an update to the live engine is not justified by
defence-in-depth wording alone. The provider setting is therefore the only thing
carrying this policy, which is the stronger arrangement.

The engine is **byte-identical** to the one that was provisioned: building it
from this commit and from `31075f2` produces the same object, same 5373-character
`general_prompt`, same `begin_message`. **There is no local/remote drift.**

### 23.3 Acquisition only

`voicemail_option` is emitted from **exactly one file in `src/`**, asserted by a
directory walk rather than a grep of the two files anyone would think to check.
The receptionist and onboarding compilers are untouched — proven twice: their
sources contain no such field, and the receptionist's **actually compiled**
`toRetellPayload` output is built in the test and inspected. The shared
`retell-adapter` and `voice-platform-port` gained no voicemail knowledge; the
adapter serialises whatever payload it is handed, which is why no shared schema
or validator change was required.

### 23.4 Readiness — configured is not observed

| | |
|---|---|
| Configured locally | **YES** — `voicemailProviderPolicyConfigured`, computed by reading the payload |
| Observed on a real call | **NO** — `voicemailProviderBehaviourObserved`, a hardcoded `false` |

The second is hardcoded on purpose: nothing in this repository can observe a real
call, so nothing here may compute it true. It moved out of `blockers` into
`unverifiedAfterCreation` for the reason given in §20.4 — as a create-agent gate
it could never be opened. **It is reported, not retired.**

`createAgentReady` is still **false** in the real world: `voice_id` and
`webhook_url` remain unresolved, and E-12A cleared neither. A ratchet pins that
separately from the fixture-supplied case, so the milestone cannot be misread as
having moved the agent closer to existing than it did.

### 23.4a Two different gates, previously conflated

**Founder correction, 2026-08-13.** The closing report for E-12A listed the
outbound number, DNCR-1 and A-L2 among "remaining blockers before agent
creation". That was wrong, and the distinction matters because conflating the
two makes agent creation look further away than it is and makes a live call look
closer than it is.

**To create the agent resource** (`POST /create-agent`) — and nothing more:

| | |
|---|---|
| `llm_id` wired into provisioning | `llm_111ed…`, held in the environment, **not in git** |
| `voice_id` selected | **UNRESOLVED** — a founder choice |
| `webhook_url` selected/deployed | **UNRESOLVED** — required only while the policy is *create the agent correctly once*, since the alternative is creating it now and updating it later |

**NOT required to create the agent** — these gate the *first live call*, not the
existence of a Retell resource:

- an outbound acquisition **number**
- **DNCR-1** first wash — **still OPEN**
- **A-L2** authoritative holiday source — **still OPEN**
- a wired live **transport**, `live: true` on a provider
- **calling-state enable** (still `paused`, revision 1)
- founder-authorised proof call, and the remaining compliance gates
- **E-7** — **still OPEN**

An agent that exists cannot ring anybody: it has no number, no transport, and
calling is paused. Creating it is a provisioning step, not an activation step.
This paragraph changes no status — DNCR-1, A-L2 and E-7 all remain OPEN.

### 23.5 Outcome and attempt semantics — unchanged

`voicemail_reached` and `machine_detected` still map to the durable outcome
`voicemail`; `dial_no_answer` and `dial_busy` still map to `no_answer`. No new
vocabulary. Under A-L7 **voicemail still consumes a counted attempt and
no_answer still does not** — the rule counts the machine being *reached*, not a
recording being *delivered*, so hanging up changes nothing about the accounting.
E-8/E-11A ordering is untouched: technical outcome → `attempted` → outcome →
attempt policy → dispatch resolved last.

No retry, no second call, no automatic callback was introduced.

### 23.6 Out of scope, deliberately

**IVR / phone-tree navigation: NOT enabled.** Not coupled to the voicemail
surface — a separate agent field — so auditing it required no change.

**`call_screening_option`: NOT enabled.** It sits adjacent to voicemail detection
in Retell's agent object and is a plausible later optimisation for cold calling,
where a screening service answering first is common. Recorded here as a **future
founder decision**, not taken.

### 23.7 What did NOT happen

No Retell request of any kind: no agent created or updated, no response engine
created or updated, no voice listing, no webhook configured remotely, no number
provisioned. No Twilio, no DNCR, no prospect contacted. **Zero DEV writes** — no
SQL, LPM3 untouched, 23 acquisition rows, calling still paused at revision 1.
Production untouched.

---

## 24. E-12B — pinning what was provisioned, and reading the voice catalogue

**Status: DRIFT PIN ADDED. VOICE CATALOGUE READ (one read-only request).
ACQUISITION VOICE SELECTED — Sunny (§24.7). Agent still NOT PROVISIONED.
Response engine UNCHANGED and hash-pinned. Webhook NOT DEPLOYED / UNSET.
Voicemail hang-up configured locally, live behaviour UNVERIFIED. Number NOT
PROVISIONED. Calling PAUSED. E-7 OPEN. DNCR-1 OPEN.**

### 24.1 Why the prompt stopped being a local file

E-10D(i) created a real Retell response engine from this repository's
`buildAcquisitionResponseEngine()`. From that moment the copy stopped being an
artefact and became a **claim about a remote resource**. Editing `general_prompt`
here changes nothing at Retell, and nothing fails — the repository simply begins
describing behaviour `llm_111ed…` does not have, and the first place anybody
finds out is a telephone call to a stranger.

### 24.2 The pin

`PROVISIONED_RESPONSE_ENGINE.payloadHash` =
`b0b5e21e3fcf7bcd7db9bacc577250689f5096a8705b9dd0d3b4ac18115e0542`

Computed with **`payloadHash` from `voice-platform-port.js`** — sha256 over
`stableStringify`, the repository's existing canonical form with recursively
sorted keys. Deliberately **not a new convention**: `provisioning-plan.js` and
`provider-resource-registry.js` already hash provider payloads this way.

**The exact provisioned payload is reproducible**, which is what makes the pin
honest rather than decorative. The E-10D(i) script sent
`describeAcquisitionRetellResources().responseEngine` **with no arguments** — no
environment input, fully deterministic — and that payload hashes identically when
built from commit `d591262` (the provisioning commit), from `31075f2`, and from
today. Four fields, nothing else: `general_prompt`, `begin_message`,
`default_dynamic_variables`, `general_tools`.

The `llm_id` is **not** in the pin. It is deployment configuration and lives in
`RETELL_ACQUISITION_LLM_ID`; a ratchet asserts no `llm_…` value appears in the
tracked record.

### 24.3 What it does and does not forbid

It does **not** freeze the copy. E-10A deliberately refused to pin the opening to
an exact string so a comma could be moved for speech, and that reasoning stands.
What this forbids is moving it **silently**. A founder-approved rewording is
still a two-line change — edit the copy, re-pin the hash in the same commit — but
it now forces the third step that was previously invisible: **update the remote
engine**. The failure message says exactly that rather than merely reporting a
mismatch.

**Proven by planting real drift**, not by mutating a copy: adding two words to
`reasonForCalling` in the actual source made 8 assertions fail with the intended
message. The change was then reverted and the suite returns to green.

Scope is asserted in both directions. Changing `begin_message` (even one
character), `general_prompt`, `default_dynamic_variables` or `general_tools`
fails. Choosing a `voice_id`, setting `webhook_url`, supplying the `llm_id`, or
the E-12A `voicemail_option` — all **agent** fields, a different API resource —
must not move it, and do not. That matters immediately: **resolving the voice is
the very next milestone, and it must not read as prompt drift.**

### 24.4 The voice catalogue — one read, and an inconvenient answer

**One** authorised request: `GET /list-voices`, HTTP 200, **272 voices**. Zero
writes. The read was performed by a one-off script kept **operational rather than
committed** — it is a founder-review action, not a pipeline step, and committing
it would add a second Retell-capable file to the surface the safety story rests
on. The credential was read from the untracked environment and never printed.

Available metadata: `voice_id`, `voice_name`, `provider`, `gender`, `age`,
`accent`, `recommended`, `preview_audio_url`, `avatar_url`, `voice_type`.

**Only 2 of 272 voices carry Australian accent metadata, and both are male:**

| voice | id | provider | gender | age |
|---|---|---|---|---|
| Noah (en-AU) | `11labs-Noah` | elevenlabs | male | Middle Aged |
| Charlie (en-Au) | `11labs-charlie` | elevenlabs | male | Middle Aged |

Both are ElevenLabs, consistent with Retell's own guidance that ElevenLabs is
strongest for niche accents.

**There is no female preset voice with Australian accent metadata.** That is a
real constraint on the decision, not an oversight in the search: the accent field
was counted across the whole catalogue (202 American, 22 Mexican, 19 British, 2
Australian).

The existing receptionist/onboarding default **is** in the catalogue:
`custom_voice_018b4225b718ffc38a2e1da4d4`, *"Sunny - Australian Female"*,
ElevenLabs, `voice_type: custom`. Its name claims an Australian female, but it
carries **no `accent`, `gender` or `age` metadata at all** — so the claim rests
on the name, which is exactly the inference this milestone was told not to make.
Only a preview can settle it. It is reported, **not** selected, and reuse is not
assumed.

### 24.5 Aida / AIDA pronunciation — still not decided

Unchanged and deliberately not encoded. The available later copy decision is to
**omit the product name from the opening altogether** — the assistant introduces
itself as Aida and describes the product generically as an AI receptionist,
which removes the spoken Aida/AIDA collision without any pronunciation rule.

That is a **response-engine copy change** and would require an
`updateResponseEngine` plus a re-pin under §24.2. **Not authorised, not made.**

### 24.6 What did NOT happen

No Retell write of any kind: no agent, no engine update, no voice created,
cloned or modified, no number, no call. The response engine is byte-identical to
the provisioned one. No Twilio, no DNCR, no prospect contacted. **Zero DEV
writes** — 23 rows, calling paused at revision 1. Production untouched.

### 24.7 The founder chose Sunny — and why it needed its own key

**Selected 2026-08-13: "Sunny - Australian Female"**, ElevenLabs custom voice,
`voice_type: custom`. The acquisition voice is **RESOLVED**.

The evidence for its accent is **the founder's audition**, and the record says
so. Retell returned **no `accent`, `gender` or `age` metadata** for this voice —
its name is the only written claim, and §24.4 refused to infer an accent from a
name. Listening was always going to be the only thing that could settle it.

**The configured value lives in `RETELL_ACQUISITION_VOICE_ID`, not in source.**
`SELECTED_VOICE` in the spec records the *decision* — who chose, what they chose,
when, and where the value lives — and a ratchet asserts the id itself appears in
**neither the spec nor the config module**.

*(The id does appear once in §24.4, as part of what the read-only catalogue
actually returned. That is a finding about the provider's data, not a
configuration value, which is why it is written out there and elided as a config
value here. `RETELL_ACQUISITION_LLM_ID` is elided everywhere by contrast, because
that resource was **created by us on a specific dev account** rather than read
from a shared catalogue.)*

**Why a new key when the shared one already holds this voice.** That coincidence
is the trap. `RETELL_DEFAULT_VOICE_ID` is the **receptionist's** voice — what a
locksmith's own customers hear. Had acquisition read it, the two products would
be joined by accident, and the day somebody re-voices the receptionist they would
also re-voice every cold call to a stranger, with no test failing and nobody
deciding it. The same voice may be chosen for both; it has to be a coincidence
somebody typed twice, not an inheritance.

`resolveAcquisitionVoiceId` therefore has **no fallback**. An unset key yields
`null`, `createAgentReady` stays false, and the blocker names the variable and
the chosen voice so a human knows what to set. Proven both ways: the receptionist
key alone leaves acquisition **voiceless** rather than borrowed, and it cannot
override an explicit acquisition choice. `RETELL_ACQUISITION_WEBHOOK_URL` is
separated on the same principle.

Selecting the voice **did not touch the response engine** — `voice_id` is an
agent field, the pinned hash is unchanged, and no `updateResponseEngine` is
required. Asserted directly, because if it were ever false, choosing a voice
would mean re-provisioning the engine.

**Resulting agent payload** (`webhook_url` is the one field still unresolved):

```json
{
  "agent_name": "aida-acquisition-agent-acq-agent-spec-2026-08-13",
  "response_engine": { "type": "retell-llm", "llm_id": "<RETELL_ACQUISITION_LLM_ID>" },
  "voice_id": "<RETELL_ACQUISITION_VOICE_ID — Sunny>",
  "language": "en-AU",
  "webhook_url": null,
  "voicemail_option": { "action": { "type": "hangup" } },
  "post_call_analysis_data": "<10 fields>"
}
```

**Remaining create-agent blockers: one.** `webhook_url` — the acquisition route
is implemented and mounted but not deployed. The `llm_id` exists and needs only
to be present in the provisioning environment. Voice is **no longer a blocker**.
The outbound number, DNCR-1, A-L2 and enabling calling remain **pre-live-call**
gates per §24.4a — unchanged, all still OPEN.

---

## 25. E-12C — the webhook was not exposed, and why

**Status: STOPPED AT THE DEPLOYMENT GATE. NOTHING DEPLOYED. NO RETELL REQUEST.
Acquisition webhook_url still UNSET. Agent still NOT PROVISIONED. Response
engine UNCHANGED and pin green. Calling PAUSED. E-7 OPEN. DNCR-1 OPEN.**

E-12C was to resolve a real public HTTPS URL for `POST /webhooks/retell/acquisition`.
It stopped at the audit, for a reason the brief named in advance.

### 25.1 There is exactly one environment, and it is production

The deployment authority is `DEPLOYMENT.md` and the repo's own review docs, not
inference:

- **Railway**, deploying **`main`** — "Push `main` → Railway auto-deploys."
- `docs/PRE_REACT_NATIVE_REVIEW.md` §M2: *"Today there is exactly one
  environment: production."*
- `docs/LOCKSMITH_PILOT_SPEC.md` §8: *"nothing is deployed and there is no
  staging target for this branch."*
- CI (`.github/workflows/ci.yml`) runs syntax and tests only; its smoke job
  **self-skips** because `SMOKE_BASE_URL` is unset — there is no staging URL to
  point it at.
- No `render.yaml`, `fly.toml`, `vercel.json`, `Procfile`, `Dockerfile` or
  Railway manifest is tracked. One git remote, no deploy hooks.

Standing up a non-production runtime therefore means **a second Railway service
or a tunnel** — the same doc's words — which is new material infrastructure and
a founder decision. Both of the brief's stop conditions applied, so nothing was
deployed and nothing was created.

**Deploying the acquisition branch to the production service to obtain a URL was
never an option**, and is worth stating rather than leaving implied: it would
put unreviewed acquisition code into the runtime that answers real customer
telephone calls, in order to obtain a hostname.

### 25.2 What deployment would actually expose

Not a webhook — **the whole Aida server**. `src/server.js` mounts operator
login, client auth, the Twilio inbound/outbound/recording webhooks, the calls
API and the dashboards in the same process. The locksmith page, onboarding,
portal, VoIP and both Retell webhooks are flag-gated dormant and would stay
dormant, and the Twilio routes are signature-gated — but the surface being made
public is the application, not the route. A second service is a **second full
deployment** needing its own environment, pointed at dev Supabase.

### 25.3 The safety property that made this worth checking carefully

The configuration that opens the ingress must not also be the configuration that
lets something out. Proven, not assumed — with **all three ingress flags on and
an API key present**:

| | |
|---|---|
| acquisition webhook enabled | **true** |
| `canWriteLive` (create an agent) | **refused** — live writes off, dry-run on |
| `canPlaceCall` (dial) | **refused** — live calls off, no outbound number |
| `isAcquisitionEnabled` | **false** |
| `acquisitionReady("dial")` | **refused** — `acquisition_disabled` |
| every provider `live` | **false** |
| `RETELL_DRY_RUN` | **on** (inverted gate) |
| `EXTERNAL_SYSTEMS.telephony` | **false** |

Enabling ingestion sets no provider live, creates no transport, enables no
dispatch, unpauses nothing, provisions no number and creates no agent. Each of
the three flags is individually load-bearing — drop any one and the path 404s.

### 25.4 Signature authority — no bypass exists to find later

The deployed ingress would still require a genuine Retell signature. The handler
delegates to the single `verifyRetellWebhook` and implements no crypto of its
own. There is **no** `NODE_ENV === "development"` bypass, no `allowUnsigned`
style flag, and no query-string secret substitute — asserted across the verifier,
the handler and the route. When the SDK is unavailable the verifier returns
`verifier_unavailable` and the route answers 503: it **fails closed rather than
improvising an HMAC**.

*Deployment precondition worth carrying forward:* verification needs **Node 20+
and `retell-sdk` installed**. It is declared as an `optionalDependency`, so a
deploy that skips optional dependencies would answer 503 to every delivery — a
loud failure, not a silent one, but it must be checked on the day.

### 25.5 The three acquisition ids — all still unset

| variable | status |
|---|---|
| `RETELL_ACQUISITION_LLM_ID` | **NOT SET** — the engine exists at Retell, but the id has not been placed in any environment |
| `RETELL_ACQUISITION_VOICE_ID` | **NOT SET** — Sunny is chosen (§24.7); the value has not been configured |
| `RETELL_ACQUISITION_WEBHOOK_URL` | **NOT SET** — and cannot be, until §25.1 is answered |

The boundary from E-12B was **verified rather than redesigned**: the acquisition
webhook_url resolves only from `RETELL_ACQUISITION_WEBHOOK_URL`, and
`RETELL_WEBHOOK_BASE_URL`, `RETELL_WEBHOOK_URL` and `BASE_URL` all leave it
`null`. No sibling worktree `.env` was modified and no `.env` was committed.

### 25.6 Readiness — three blockers, not one

Against the **real** current environment `createAgentReady` is **false** with all
three unset. Supplied as fixtures, the payload compiles and readiness becomes
true — which is a statement about wiring, not permission:

```json
{
  "agent_name": "aida-acquisition-agent-acq-agent-spec-2026-08-13",
  "response_engine": { "type": "retell-llm", "llm_id": "<RETELL_ACQUISITION_LLM_ID>" },
  "voice_id": "<RETELL_ACQUISITION_VOICE_ID — Sunny>",
  "language": "en-AU",
  "webhook_url": "<RETELL_ACQUISITION_WEBHOOK_URL — does not exist yet>",
  "voicemail_option": { "action": { "type": "hangup" } },
  "post_call_analysis_data": "<10 fields>"
}
```

The response engine was untouched: the pin is green at
`b0b5e21e…0542`, and supplying a voice and a webhook does not move it.

### 25.7 The one decision this needs

**Where should a non-production Aida run?** Everything else is downstream of it.
The realistic options are a second Railway service pointed at dev Supabase (a
real, ongoing hosting cost) or a tunnel to a locally-run instance (free, but the
URL dies with the process — acceptable for a first agent test, not for a pilot).

Until that is answered the acquisition agent cannot be created **correctly
once**, because its `webhook_url` would have to be either wrong or absent.
