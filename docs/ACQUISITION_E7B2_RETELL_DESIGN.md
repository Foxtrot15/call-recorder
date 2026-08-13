# E-7B2 — the Retell acquisition provider

**Status:** **E-7B2A COMPLETE** (offline adapter + audit) · **E-7B2B1 COMPLETE**
(offline agent contract + outcome/reconciliation return path, §14) · **E-10A
COMPLETE** (the acquisition agent specified locally, §19). **E-7B2B live
activation NOT STARTED. E-7 REMAINS OPEN.** Acquisition calling is PAUSED, no
live provider exists, **the Retell acquisition agent is NOT PROVISIONED**, no
outbound acquisition number is provisioned, and no acquisition webhook route is
exposed.

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
