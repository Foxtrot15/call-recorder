# AIDA Voice Configuration Agent

**Status:** built and tested locally on `feature/aida-voice-configuration-agent`.
No speech provider, no language model, no telephone, no network. Every
interpreter is deterministic and injected. **Nothing here can approve, activate,
provision or place a call**, and the reason is structural rather than a check
somebody remembered.

---

## 1. What it is for

A business owner telephones AIDA and says *"we close at four on Saturdays now"*.
Twenty seconds later they hang up, and a **draft configuration version** is
waiting for somebody to review.

That is the whole product. The hard part is not understanding the sentence — it
is making sure a misheard sentence cannot change how a business's telephone is
answered without a person reading it first.

```
   CONVENTIONAL UI                      VOICE CONFIGURATION AGENT
          │                                       │
          └──────────────────┬────────────────────┘
                             │
                    config-service.js          ← ONE authority
                             │
                    versioned DRAFT
                             │
                        validate
                             │
                       review diff
                             │
                  human approval  (a named person)
                             │
                       activate   (an operator)
```

The voice agent occupies exactly one arrow: conversation → draft. It has no
others.

## 2. Session lifecycle

| State | Meaning |
|---|---|
| `collecting` | Listening and proposing. Nothing is committed. |
| `clarifying` | One thing was ambiguous and AIDA asked rather than guessed. |
| `confirming` | A higher-risk change is waiting for the caller to say yes in words. |
| `reviewing` | The caller asked what has been proposed so far. |
| `ready_to_create_draft` | Everything is resolved. A draft has **not** been written yet. |
| `draft_created` | A draft exists and a person must review it. **The ceiling.** |
| `cancelled` | The caller stopped. No draft was written. |
| `refused` | The session asked for something a configuration conversation may not do. |

**There is no `approved`, `active`, `provisioned` or `live` state, and no
transition that could reach one.** `draft_created` has an empty transition list,
so it is terminal by construction. A test walks the entire state machine
breadth-first and asserts nothing resembling an authority is reachable.

## 3. The interview planner

`voice-planner.js` decides what to ask next by looking at what the blueprint is
**missing**, not by marching through a questionnaire.

- **A complete existing client is asked nothing.** `planNextQuestion` returns
  `null` and the session opens with *"What would you like to change?"* — so a
  targeted edit costs two turns.
- **A new client is interviewed** in order: identity → services → service area →
  hours → after-hours → caller information → transfer → pricing → knowledge →
  booking → integrations → voice → compliance.
- **Urgency is asked using the client's own service names**, and only after
  there are services to name.
- Priority order: an unresolved question beats a pending confirmation beats a
  new topic.

There is **no vertical branching**. A plumber differs from a locksmith by what
its blueprint already contains, and a ratchet asserts no voice module mentions a
trade in code.

## 4. The interpretation contract

```
interpretTurn({ transcript, context }) -> Interpretation
```

| Field | Meaning |
|---|---|
| `intent` | one of the closed vocabulary. Anything unrecognised is `UNKNOWN_INTENT`, never a guess |
| `payload` | validated against the intent's contract, or `null` |
| `confidence` | 0..1. Drives whether to **ask**. Never authorises a change |
| `ambiguities` | each becomes a spoken question |
| `assumptions` | anything filled in the caller did not say — **surfaced, never silent** |
| `clarificationRequest` | the single question to ask |

A malformed interpretation collapses to `UNKNOWN_INTENT` and a question. It
never becomes a silent no-op, because a caller whose sentence vanished says it
again and assumes it worked.

**Confidence is not permission.** A test drives a `SET_TRANSFER_RULE` at
confidence 1.0 and asserts the session still refuses to finish without a spoken
confirmation. A model that is confidently wrong about a transfer number is the
exact failure that separation exists for.

Three adapters ship, all fake: `createDeterministicInterpreter` (rules),
`createScriptedInterpreter` (fixture playback, used by golden transcripts), and
`createRefusingInterpreter` (proves the engine degrades to asking rather than
crashing when the port is dead).

## 5. Structured intents

**22 configuration intents**, **10 conversational**, **7 explicitly refused**,
plus `UNKNOWN_INTENT`. Each configuration intent declares a section, a risk
class, a reason it matters, and a typed payload contract.

```js
SET_BUSINESS_HOURS  { day: "saturday", periods: [{ start: "09:00", end: "16:00" }] }
ADD_SERVICE         { name, aliases?, urgency?, qualificationRequirements?, exclusions? }
EXCLUDE_SERVICE_AREA{ suburbs: [...] }
```

There is deliberately **no generic `{ path, value }` conversational
operation**. That shape makes every mishearing a valid operation, and makes
*"set metadata.status to active"* a sentence the system is willing to parse.
Unknown payload keys are an **error**, not ignored — a payload carrying `status`
or `clientId` is one somebody built wrong.

Option lists are built **from** the blueprint's own vocabularies, so a new
urgency level is understood here the day it is added there.

## 6. Proposal and confirmation

```
HEARD → INTERPRETED → PROPOSED → (CLARIFIED) → (CONFIRMED) → DRAFT
```

Every arrow is a place something can stop.

Risk is declared **per intent**, not inferred from edit size. The line is not
"how big is the change" — it is "who finds out, and how".

| Risk | Requires a spoken yes? | Examples |
|---|---|---|
| low | no | voice tone, caller information |
| medium | no | hours, pricing, adding a service |
| **high** | **yes** | remove a service, exclude a suburb, change a transfer number, change emergency classification, compliance wording, outbound |

A removed service is a customer being told no by a business that does the job. A
changed transfer number is a ringing telephone nobody owns. Neither person can
see the review screen.

**Conversational confirmation is not application approval.** A confirmed change
still only produces a draft.

Corrections **supersede** rather than accumulate: saying "five", then "four",
produces one change, and the superseded one is kept and marked rather than
deleted. Two contradictory patches for one path is how a caller's correction
becomes a coin toss.

## 7. Draft creation

On "that's all", the session:

1. summarises the changes **from structured objects**, not remembered text
2. states anything still unresolved
3. **refuses to finish** while a required ambiguity or an unconfirmed high-risk
   change remains
4. compiles confirmed changes to `config-patch` operations
5. calls `configService.proposePatch` with a **voice principal**
6. returns the draft version and says a person must review it

Step 5 is the only write this entire subsystem performs. A test asserts the
engine calls exactly one method on the configuration service — `proposePatch` —
and nothing else.

## 8. Human review

A voice draft is **a draft**. It appears in the dashboard, version history,
review screen and blueprint editor exactly like a typed one; the only difference
anywhere is the History column reading *"Voice configuration agent"*.

The voice principal cannot approve its own draft — a test sends the approval and
gets a 403, then approves it as a named human and gets a 200.

## 9. Platform policy guards

`voice-policy.js` runs on **both** the interpreted intent and the raw
transcript. Two independent checks, because one of them is a model.

| Refused | Owned by |
|---|---|
| approval | a named person reviewing the draft |
| activation | an operator |
| provisioning | a separately authorised provisioning operation |
| calling | the calling authority, which no conversation can reach |
| DNCR | the Do Not Call authority |
| suppression | the append-only suppression list |
| dial | the pre-dial authorisation gate |
| AI disclosure | platform policy |
| mandatory prohibitions | platform policy |
| compliance wording | the review screen |
| another tenant | the session's own client |
| authority bypass | the application's own authority model |

Every refusal names **who can** do it, because "no" on its own is a caller
phoning back and finding a phrasing that works.

Relying on the closed intent vocabulary alone would not be enough: an
interpreter will map *"approve it for me"* onto **something**, and the something
it picks will be whatever is nearest. This makes the nearest thing a refusal.

### AI disclosure, preserved

| | Opening | If asked |
|---|---|---|
| **Outbound** | must disclose. **No toggle** | always truthfully |
| **Inbound** | client's greeting, no forced disclosure | always truthfully |

*"Don't tell people you're AI"* is refused with an explanation that it is a
platform requirement, and an offer to change the wording. A greeting claiming to
be a person, and an approved fact claiming to be a person, are both refused.

### Calling, patterned carefully

A business talks about calls all day. *"We call customers back within the hour"*
is a callback **policy** and must pass; *"just call everyone once"* must not.
The discriminator is an imperative to place calls, and a "back" exclusion keeps
every callback policy on the allowed side. Both directions are tested — false
refusals make a safety feature something people route around.

## 10. Tenant isolation

`clientId` is bound at session creation from the authorised caller and **never
read from a transcript**. A session that hears *"actually change it for the
other business"* refuses, keeps its own client, and the other client gains
nothing — asserted by reading the other client's version list afterwards.

Merely *mentioning* another business is allowed. Refusing every mention would
make the assistant unusable.

## 11. Privacy and transcript retention

**Recommendation: do not retain full transcripts.**

What the session keeps is the **structured meaning** of each turn and the
assistant's own words. What it does not keep, anywhere in the domain model, is
audio, a recording reference, or a second copy of the caller's words beyond the
turn itself.

The audit sink **refuses** a forbidden key — `transcript`, `audio`,
`recording`, `apiKey`, `secret`, `token`, `cardNumber`, `cvv` and the rest —
by throwing, because that is a programming error at a call site and hiding it
helps nobody. A secret-**shaped value** is redacted instead, because that one
arrives from a caller's mouth and is not anybody's mistake.

A caller reading a card number to an assistant is a caller whose card number
must not end up in an audit row.

**Durable session storage is deliberately not built.** Sessions are in-memory
behind a store contract. Giving them a table would mean either widening ACP1's
`event_type` CHECK or creating a new migration, and ACP1's applied state is an
open question in another worktree. `VOICE_AUDIT_SCHEMA_NOTE` records that, and
recommends a separate `acp4_voice_sessions` migration rather than a widening of
ACP1. **The artefact that must survive a configuration call — the draft —
already has durable storage.**

## 12. Evaluation harness

**33 golden transcripts** across four families: locksmith (existing client),
plumber (new-client interview), garage door (existing client), and adversarial.

Each declares its whole final state — changes, unresolved questions, refusals,
final state, and the four safety flags — and the harness compares all of it. A
per-turn test passes while the third turn quietly undoes the first; what catches
that is what a caller experiences: *what did we end up with?*

| Metric | Value |
|---|---|
| golden match rate | 1.0 |
| change accuracy | 1.0 |
| clarification correctness | 1.0 |
| adversarial refusal rate | 1.0 |
| **unsafe action count** | **0** |
| **unconfirmed high-risk reaching a draft** | **0** |
| **cross-tenant leaks** | **0** |
| **forbidden patch operations** | **0** |
| `modelAccuracyMeasured` | **false** |

That last row is the one that stops the rest being misread. These numbers
measure the **session engine** — the state machine, the guards, the confirmation
rules, the patch compilation — against fixed transcripts and a deterministic
interpreter. There is no model here to be accurate, and a number called
"accuracy" on a slide would imply otherwise.

## 13. Local simulator

```bash
node scripts/voice-config.js scenarios
node scripts/voice-config.js replay --scenario locksmith-saturday-hours
node scripts/voice-config.js simulate --client rolladoor_repairs
node scripts/voice-config.js simulate --client rolladoor_repairs \
     --say "We close at four on Saturdays now." --say "That's it."
```

```
Aida > What would you like to change?
You  > We close at four on Saturdays now.
Aida > I'll change Saturday to 8am to 4pm. (I took "four" to mean the afternoon.) Anything else?
You  > We don't go to Frankston anymore.
Aida > I'll stop servicing Frankston. That's a bigger one — shall I go ahead with it?
You  > Yes.
Aida > Done. Anything else?
You  > That's it.
Aida > Here are the changes we've discussed:
       • Saturday hours become 08:00-16:00
       • Stop servicing Frankston
       I haven't made any of this active. It'll be saved as a draft for somebody to review.
       I've saved that as draft version 2.
```

No microphone, no speech recognition, no telephone, no model. **These flags do
not exist** and each is refused by name with a reason: `--live`, `--model`,
`--approve`, `--activate`, `--provision`, `--retell`.

## 14. Future live voice adapter

Documented, not implemented.

```
dedicated configuration phone number
   → voice provider (speech in, speech out)
   → transcript
   → interpretation adapter   ← implements interpretTurn(), nothing else
   → voice configuration session   ← unchanged
   → DRAFT
```

The live adapter receives **no access** to approve, activate, provision or dial.
It implements one method and returns an `Interpretation`. Everything downstream
is what is already built and tested.

What remains before a real model can be plugged in:

1. An adapter implementing `interpretTurn`, returning intents from the closed
   vocabulary and `UNKNOWN_INTENT` for everything else.
2. The evaluation harness re-run against it, with `modelAccuracyMeasured`
   becoming the honest place to report what it measures.
3. A decision on transcript retention (see §11) before any transcript leaves the
   process.
4. Latency and interruption handling, which a text simulator cannot exercise.

What remains before each client gets a configuration telephone number:

1. All of the above.
2. A number, which is a provisioning operation this subsystem cannot perform.
3. Caller authentication — the session binds a client at creation, and a
   telephone number is not proof of who is holding the telephone. **This is the
   open question**, and it is the one that decides whether the feature can ship.
4. A dedicated provider agent, separate from the receptionist and the
   acquisition agents.
5. Rate limiting and abuse handling on a public number.

## 15. What the voice agent can NEVER do

- approve a configuration
- activate a configuration
- provision anything at a provider
- enable, disable or change calling state
- place or authorise a call
- change DNCR, suppression or dial authority
- disable outbound AI disclosure, or make the assistant claim to be human
- remove any of the six mandatory prohibited claims
- change what callers are told about recording
- edit another client's configuration
- edit an approved or active version — everything becomes a **new draft**
- grant itself authority by anything said in a transcript

The last one is the general case, and the reason the rest hold: **the principal
comes from the authorised application context, never from what a caller says.**

---

## Modules

| File | Layer | What it decides |
|---|---|---|
| `voice-session-model.js` | 0 | states, transitions, risk classes, audit vocabulary |
| `voice-intents.js` | 0 | what a caller can mean, and the payload each meaning must carry |
| `voice-interpreter-port.js` | 1 | the interpretation contract, and three fake adapters |
| `voice-policy.js` | 1 | what a telephone call may never do |
| `voice-planner.js` | 1 | what to ask next |
| `voice-patch-compiler.js` | 1 | confirmed intents → `config-patch` operations |
| `voice-audit.js` | 1 | what a configuration call may remember |
| `voice-session.js` | 1 | the engine |
| `voice-evaluation.js` | 4 | the harness and its metrics |
| `voice-cli.js` | 4 | the local simulator's logic |
