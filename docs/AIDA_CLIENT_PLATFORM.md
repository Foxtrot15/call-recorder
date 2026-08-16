# AIDA Client Platform

**Status:** built and tested locally on `feature/aida-client-platform`. Nothing
is deployed, no migration exists or has been applied, and no provider resource
was touched. The real acquisition Retell agent is parked and was not contacted.

---

## What this is

AIDA was a locksmith receptionist that could be adapted to other businesses by
editing code. This turns it into a platform where most new businesses are
represented as **validated, versioned configuration**, and where adding one
requires no code at all.

The test of that claim is `scripts/dev/platform-new-client-walkthrough.js`,
which takes an electrician — a trade no module, fixture or test mentions — from
nothing to a compiled provider payload without a line of code being written for
it.

## What P1 actually found

102 files under `src/` mention locksmiths, which suggests the coupling is
everywhere. It is not. `src/services/locksmith-profile-schema.js` was already
vertical-neutral about urgency classifications, urgency actions, hours,
transfer, notifications, pricing, caller information, forbidden promises and
privacy. The vertical lived in **one place**: a hardcoded `SERVICE_IDS` enum
listing lockouts and key cutting.

So the change is narrow and specific: **services become client-defined**, and
everything a decision switches on keeps a platform-owned vocabulary.

---

## The layers

```
  Client Blueprint        what the business told us            src/platform/client-blueprint.js
        |
  Blueprint Authority     versions, approval, activation       src/platform/blueprint-authority.js
        |
  Agent Behaviour Spec    what the assistant should do         src/platform/behaviour-spec.js
        |
  Provider payload        what Retell needs to be told         src/platform/provider-compiler-retell.js
```

Each arrow points one way. The behaviour spec exists so that swapping voice
providers is a change to the last step only, and so that *"what will the
assistant say?"* can be answered, reviewed and diffed without anybody reading a
vendor's JSON.

`test/platform-boundaries.test.js` declares the layer of every file and fails if
a new module is added without one — so nothing escapes the rules by being
unlisted.

| Layer | Files | May know about a provider? |
|---|---|---|
| 0 model | `client-blueprint.js`, `blueprint-diff.js`, `stable-json.js`, `config-access.js`, `fixtures/clients.js` | No |
| 1 authority | `blueprint-authority.js`, `config-patch.js`, `migrate-locksmith-profile.js`, `integrations.js`, `blueprint-store-postgres.js`, `config-audit.js` | No |
| 2 behaviour | `behaviour-spec.js` | No |
| 3 provider | `provider-compiler-retell.js` | Yes — the only one |
| 4 tooling | `client-cli.js`, `config-service.js` | Yes — they compose the compiler to show a person its output |

---

## What a client may configure

Everything about **what the assistant says and collects**:

- identity, greeting style, assistant name, timezone
- **services** — client-defined: slug, name, aliases, urgency category, notes,
  exclusions, qualification requirements
- service area — regions, suburbs, postcodes, radius, exclusions, and what to do
  outside it
- hours, after-hours policy, public holidays, closed periods
- what is collected on every call and per service, plus extra questions
- urgency rules — condition, level, action, transfer eligibility, exact wording
- escalation — numbers, permitted hours, eligible services, timeout, retries
- approved facts and their sources; prohibited claims (**additions only**)
- pricing disclosure policy and wording; uncertainty policy
- booking, and which **capability** it targets
- voice reference (provider-independent), language, pronunciation, tone
- recording, disclosure wording, retention, redaction
- which integration **capabilities** are enabled
- a bounded `extensions` bag (≤4KB, may not shadow a validated section)

## What a client may never configure

Not by editing, not by voice, not by import, not by patch:

| Authority | Owned by |
|---|---|
| DNCR wash | the wash store |
| Suppression | append-only suppression |
| Dial authorisation | the M8E pre-dial gate |
| Calling global stop | durable calling state |
| Dispatch uniqueness | the dispatch store |
| Webhook authenticity | signature verification |
| Lifecycle truth | the prospect state machine |
| Provider resource uniqueness | `pr_one_active_per_purpose`, a database index |

No module under `src/platform` imports any of them, and none may import from
`src/services` at all. A ratchet reads the source to prove it.

**Two things are platform-owned and cannot be switched off by anybody:**

1. **AI disclosure.** Every compiled spec carries
   `assistant.disclosesAiWhenAsked: true`, and the literal first sentence of
   every call names the business and says "an AI assistant". A blueprint has no
   field that could change this. **This is a policy decision, not a settled
   requirement — see the section below before merging.**
2. **The mandatory prohibited claims** — guaranteed arrival time, guaranteed
   price, guaranteed outcome, legal or regulatory advice, insurance coverage
   assurance, and claiming to be human. A client may *add* prohibitions. They
   cannot remove one; validation refuses.

---

## ⚠ AI disclosure — FOUNDER / PLATFORM POLICY, REVIEW BEFORE LIVE MERGE

**Status: unresolved product-policy decision. Do not merge to a live path
without a founder ruling.**

The platform currently puts AI disclosure in the **literal first spoken
sentence of every call, for every client, inbound and outbound**, and gives a
blueprint no field that could change it.

That is **stricter than what AIDA ships today**, and the existing product
policy does *not* unambiguously require it for both directions. The evidence:

| | Existing policy | Existing implementation | Platform |
|---|---|---|---|
| **Outbound** (acquisition / BDM) | **Requires it.** Unprompted, in the opening — `LOCKSMITH_ACQUISITION_SPEC.md` §"It discloses", `OUTBOUND_BDM_ARCHITECTURE.md` ("identity + on-behalf-of + AI disclosure + recording notice + reason, all within the first breath"). Recorded as **founder product policy, not a legal requirement** | matches | matches |
| **Inbound** (locksmith receptionist) | **Silent.** No document requires first-sentence disclosure for an inbound receptionist | `locksmith-receptionist-compiler.js` sets `begin_message` to the client's own greeting **verbatim**. The approved demonstration greeting is *"Northside Lock and Key, this is Mel, how can I help?"* — **no AI disclosure**, and none anywhere in the inbound prompt | **diverges — the platform adds it** |

So a locksmith migrated onto the platform would start disclosing in its opening
line where today it does not. That is a change to what a real caller hears, and
it belongs to the founder, not to this batch.

**What was deliberately NOT done:** the ambiguity was not resolved by making
disclosure client-disableable. A configurable AI disclosure is a switch
somebody eventually turns off, and the outbound side has an explicit policy
requiring it. It stays platform-owned and on.

**The decision to make before merge — pick one:**

1. **Adopt it as written.** First-sentence disclosure for every client, both
   directions. Nothing to change; record the policy and note that inbound
   greetings will change for existing clients.
2. **Split it by direction.** Mandatory first-sentence for outbound (as today's
   policy already requires); for inbound, disclose *plainly when asked* but let
   the client keep their own opening line. This needs a platform-owned rule
   keyed on direction — **not** a client-facing switch.
3. **Keep it on, soften placement.** Disclosure guaranteed within the first
   exchange rather than the first sentence.

Whichever is chosen, `assistant.disclosesAiWhenAsked` should stay `true` and
stay unconfigurable. The open question is *placement in the opening line*, not
*whether the assistant admits what it is*.

Tracked in `test/platform-p13-audit.test.js` — the sabotage tests assert the
disclosure survives every attempt to configure it away, so option 2 or 3 is a
deliberate code change with a failing test, not a quiet drift.

---

## The four versioning rules

1. **A draft is not active.** Editing configuration never changes what the
   assistant says.
2. **Approved is immutable.** Once a person has said yes to a specific set of
   words, those words cannot change underneath the approval. Every edit of an
   approved version is a new version needing its own approval. Approved and
   active bodies come back deep-frozen, and approval re-validates rather than
   trusting an earlier verdict.
3. **Stale writes are refused, not merged.** Two people editing from version 12
   is normal; the second silently overwriting the first is how a business loses
   a change nobody notices for a month. Omitting `expectedUpdatedAt` skips the
   check; passing `null` asserts *"it had never been edited when I read it"* —
   these mean different things, and conflating them was a live bug.
4. **Configuration is not permission.** Activating a blueprint enables no
   calling, unpauses nothing and provisions nothing.

Approval requires a **named human**. `system`, `aida`, `bot`, `automation`,
`cron` and friends are refused — configuration cannot approve itself.

Restore never resurrects: it copies an old body into a **new draft** that must
be validated and approved like anything else, because *"put back what we had in
March"* is a proposal, not a fact.

---

## Voice configuration, and why it stops at a draft

Eventually a business owner will telephone AIDA and say *"we don't do Saturday
mornings any more"*. `src/platform/config-patch.js` is the shape that request
must take.

It must never be:

```
  voice request -> active configuration
```

It is always:

```
  voice request -> proposed patch -> new DRAFT -> validation
                -> diff -> human review -> approval -> activation
```

Speech-to-intent mishears things. *"Don't service Brunswick"* and *"don't
service Brunswick East"* differ by one word and by a suburb's worth of revenue,
and the person who finds out is a customer being told no.

Patchable paths are an **allowlist**, because *"could a mishearing change
something dangerous?"* should be answered by what is reachable rather than by
what somebody remembered to forbid. `metadata`, `identity.clientId`,
`identity.vertical` and `schemaVersion` are unreachable. A batch with one bad
operation applies none of it. A proposal that would change nothing is refused
rather than versioned. A mishearing that produces an invalid blueprint still
becomes a draft, plainly marked invalid, because the reviewer needs to see what
was heard.

There is no speech recognition in this batch. This is the contract such an agent
will call, built first so the eventual voice work has something safe to aim at.

---

## Integrations

A blueprint says *"this client wants bookings"*. It does not say Google
Calendar, and it must never learn to: moving a business from one system to
another should be a change of adapter, not a reopening of their configuration
and a fresh round of approval.

Capabilities: `crm`, `calendar`, `booking`, `job_management`, `sms`, `email`,
`webhook`. Each declares operations and required fields as data.

- Adapters register **per client** as well as per capability, so an adapter
  holding one business's credentials is unreachable by another.
- Resolution consults the client's **active blueprint**. Registering an adapter
  does not grant access; configuration does.
- A partial adapter is refused at registration, naming what is missing.
- A malformed request fails against the port before the adapter sees it.
- An adapter throwing becomes a refusal the caller can act on, not an exception
  mid-conversation.

**There is no telephony capability and no operation that dials, transfers or
originates.** A client cannot configure their way to placing a call because the
port does not exist to be configured. Even SMS is `deliverMessage` rather than
`send`.

---

## The operator CLI

```bash
node scripts/client.js help
node scripts/client.js init acme_electrical electrical
node scripts/client.js versions northside_locks --demo
node scripts/client.js validate northside_locks --demo
node scripts/client.js diff northside_locks --from 1 --to 2 --demo
node scripts/client.js preview riverside_plumbing --demo \
  --llm-id llm_x --voice-id v_x --webhook-url https://example.invalid/h
node scripts/client.js approve northside_locks --version 2 --by "Peter Dang" --demo
```

**There is no `activate` command, and that is not an omission.** Putting a
configuration live is the moment a business's telephone starts being answered
differently, and it should require a person who has read a diff — not an
operator with shell history and a habit. `approve` exists because approval is a
record of a named human's decision.

`--demo` seeds the four fixture clients in memory. `--store FILE` loads versions
from JSON, read-only. There is no database connection: this batch designs the
domain before inventing SQL, and a CLI that could reach a database is a CLI that
could change one.

---

## Migrating the existing locksmith

`src/platform/migrate-locksmith-profile.js` converts a legacy
`locksmith-profile-2026-08-01` profile into a blueprint. Its input in the tests
is not an invented example — it is the profile the shipped extraction adapter
produces from the demonstration interview, and the parity tests assert it still
validates and is still provisioning-ready under the **old** rules first.

It reports three kinds of imperfection rather than swallowing them:

| Report | Meaning | Count on the demo profile |
|---|---|---|
| `notes[]` | carried across, but changed shape on the way | 8 |
| `unmapped[]` | the platform has nowhere for it — a human decides | 7 |
| `defaultsApplied[]` | an answer the platform needed that the old profile never asked for | 3 |

A migration that returns a clean blueprint and an empty report is lying about at
least one of them.

Notable behaviours:

- **Nothing is promoted.** Legacy urgency stopped at `urgent`; the platform
  added `emergency` above it. Every level maps to itself, with a note asking a
  person whether any deserve the new one. Promoting them automatically would
  change who gets telephoned at 2am.
- **Voice comes back unchosen.** Legacy `tone` is a speaking style, not a voice.
- **Declined services survive** as disabled services carrying their reason.
- **Caller-info fields with no platform column survive as explicit questions.**
- It produces a **draft**. Importing is exactly the moment somebody would want
  to skip approval, which is exactly why it is not skippable.

---

## Running it

```bash
# All platform tests (373)
NODE_PATH=../call-recorder/node_modules node --test "test/platform-*.test.js"

# The whole repo
NODE_PATH=../call-recorder/node_modules node --test "test/**/*.test.js"

# The end-to-end demonstration
node scripts/dev/platform-new-client-walkthrough.js
```

`node_modules` is absent in this worktree; `NODE_PATH` points at the sibling
checkout. The platform modules import nothing but `crypto`, so they run without
it.

---

## What is NOT built

Stated plainly so the next batch can be scoped against it.

- **No durable store.** `createInMemoryBlueprintStore()` is the only
  implementation. The store contract is four methods (`listVersions`,
  `getVersion`, `putVersion`, `replaceVersion`) and a Postgres one would satisfy
  it — but **no migration has been written, and none has been applied
  anywhere.**
- **No voice configuration agent.** The domain contract exists; the speech
  pipeline does not.
- **No provisioning.** The compiler builds objects and imports no transport. A
  compiler that can also send is a compiler that will eventually send by
  accident, so creating provider resources stays a separate, hand-run,
  explicitly-authorised act.
- **No UI.** The CLI is the only interface.
- **No real adapters.** Every integration adapter is an in-memory fake.
- **Not wired into `src/server.js`.** Nothing at runtime reads a blueprint yet.
- **No `activate` in the CLI**, by design — see above.

## Known pre-existing test failures

Two tests fail in this worktree at the base commit `7391717`, both in the parked
acquisition line and untouched by this batch:

- `acquisition-batch-approval.test.js` — "the membership hash does NOT cover
  eligibility"
- `acquisition-laq2-migration.test.js` — "the lifecycle CHECK lists exactly the
  states the application knows"

Neither reads anything under `src/platform`.
