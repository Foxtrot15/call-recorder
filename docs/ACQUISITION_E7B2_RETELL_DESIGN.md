# E-7B2 — the Retell acquisition provider

**Status:** **E-7B2A COMPLETE (offline adapter + audit). E-7B2B NOT STARTED.
E-7 REMAINS OPEN. Acquisition calling is PAUSED and no live provider exists.**

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
