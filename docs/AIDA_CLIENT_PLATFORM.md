# AIDA Client Platform

**Status:** built and tested locally on `feature/aida-client-platform`. Nothing
is deployed. **SQL CREATED (ACP1 + ACP2 + ACP3) — NOT APPLIED ANYWHERE.** No provider resource was
touched and the real acquisition Retell agent is parked and was not contacted.
Provisioning **executes end to end against fake adapters only** — no real
provider adapter exists, and no switch turns a fake one into a real one.

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
| 0 model | `client-blueprint.js`, `blueprint-diff.js`, `stable-json.js`, `config-access.js`, `provisioning-model.js`, `provisioning-execution-contract.js`, `execution-model.js`, `fixtures/clients.js` | No |
| 1 authority | `blueprint-authority.js`, `config-patch.js`, `migrate-locksmith-profile.js`, `integrations.js`, `blueprint-store-postgres.js`, `config-audit.js`, `provisioning-diff.js`, `provisioning-plan-authority.js`, `provisioning-readiness.js`, `store-binding.js`, `execution-preflight.js`, `execution-claim.js`, `provider-mutation-port.js`, `resource-registry-writer.js`, `provisioning-executor.js`, `reconciliation-engine.js` | No |
| 2 behaviour | `behaviour-spec.js` | No |
| 3 provider | `provider-compiler-retell.js`, `provisioning-desired-state.js` | Yes — they build provider payloads |
| 4 tooling | `client-cli.js`, `config-service.js`, `provisioning-service.js`, `provision-cli.js` | Yes — they compose the compiler to show a person its output |

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

1. **AI disclosure.** Resolved by founder ruling — see the section below.
   Outbound discloses in the opening; inbound keeps the client greeting; both
   answer truthfully when asked. A blueprint has no field that changes any of
   it.
2. **The mandatory prohibited claims** — guaranteed arrival time, guaranteed
   price, guaranteed outcome, legal or regulatory advice, insurance coverage
   assurance, and claiming to be human. A client may *add* prohibitions. They
   cannot remove one; validation refuses.

---

## AI disclosure — FOUNDER RULING, 2026-08-16, IMPLEMENTED

P13 raised this and deferred it. It is now decided and built.

| | Opening line | If the caller asks |
|---|---|---|
| **Outbound** — AIDA telephoned a stranger | **Must disclose.** Not client-disableable | Must answer truthfully |
| **Inbound** — the caller rang this business | **No forced disclosure.** The client keeps their own greeting | Must answer truthfully |

The inbound half preserves what ships today. The legacy receptionist opens with
*"Northside Lock and Key, this is Mel, how can I help?"* and the migrated
blueprint now produces that **byte-identically**, because the legacy greeting is
literal words and is carried across as `callHandling.greetingLine` rather than
mistaken for a style instruction. Migrating a real client no longer changes what
a real caller hears.

The same client's outbound opening is *"Hi, this is Mel, an AI assistant calling
on behalf of Northside Lock and Key. Do you have a moment?"*

**Why the mandatory half is structural, not merely required.** The outbound
disclosure clause and the answer-truthfully instruction are assembled from
constants in `provider-compiler-retell.js`. No blueprint field feeds them, no
patch path reaches them, and only `name` and `who` are interpolated — a ratchet
parses the template literal and asserts exactly that. There is nothing to switch
off, which is a stronger guarantee than a validation rule that refuses to let
somebody switch it off.

Ten sabotage attempts are tested, including a `greetingLine` reading *"You are
speaking to a human"* and an invented `disclosure: { whenAsked: false }` block.
All ten fail.

**Versioned.** The compiled spec carries
`disclosure.policyRef: "aida-disclosure-policy-2026-08-16"`, so a later ruling
produces a different behaviour hash rather than quietly reinterpreting
configurations somebody has already approved.

**Two fields, three rules:**

```js
spec.disclosure = {
  whenAsked: true,                                  // always, both directions
  inOpening: { inbound: false, outbound: true },    // the ruling
  policyRef: "aida-disclosure-policy-2026-08-16",
}
```

`knowledge.prohibitedClaims` still carries `claiming_to_be_human` as one of the
six mandatory prohibitions a client may not remove.

---

## Durable configuration architecture

**SQL CREATED — NOT APPLIED TO DEV, NOT APPLIED TO PRODUCTION, NOT APPLIED
ANYWHERE.** Nothing in this repository applies SQL, and a ratchet asserts no
source file even references the migration.

### The chain

```
  UI / future voice configurator / operator API
                    |
          Client Configuration Service      config-service.js
                    |                       authority + audit on every operation
          tenant + capability authority     config-access.js
                    |
          durable versioned store           blueprint-store-postgres.js
                    |
   draft -> validate -> diff -> approve -> activate
                    |
          Agent Behaviour Spec compiler     behaviour-spec.js
                    |
          provider configuration PREVIEW    provider-compiler-retell.js
```

**No live provider write follows activation.** "Active" means *this is the
configuration AIDA considers current for this client*. It does not mean
*deploy this to Retell*.

### Storage model

Two tables, `supabase/sql/acp1_create_client_configuration.sql`.

`platform_config_versions` — the row **is** the version. There is no separate
"current pointer" table, because a pointer and a status are two truths that can
disagree.

Lifecycle is **normalised into columns**: tenancy, version identity, schema
version, status, provenance (`created_at/by`, `source`), lineage (`supersedes`,
`restored_from`, `superseded_by`), the CAS token (`updated_at`), validation,
approval (`approved_at/by/hash`, reason), activation (`activated_at/by`) and
supersession. Those are the fields a decision switches on.

The blueprint **body** is one `jsonb` column, minus its metadata. It is not a
blob store: the application validates against `client-blueprint.js` before every
write, and the database asserts the body agrees with the row about who owns it
and which schema it is. Metadata therefore lives in exactly one place, stripped
on write and reassembled on read.

`platform_config_events` — append-only history, including **refusals**. Version
rows cannot answer "who tried and was refused", "what did the voice agent
propose" or "who has been reading this".

### Database invariants

| Invariant | Mechanism |
|---|---|
| One active version per client | `pcv_one_active_per_client` — a partial unique index. Two active versions are **unreachable**, whatever the application does |
| A version number belongs to one client | `unique (client_id, config_version)` |
| Lineage cannot cross tenants | Three composite self-referential FKs on `(client_id, …)` — cross-client lineage is **unrepresentable**, not merely checked |
| Approved content cannot be swapped | `pcv_approved_hash_is_content_hash` — a row whose body changed after approval cannot satisfy the database |
| Approved / active / superseded content is frozen | `pcv_guard_frozen_rows` trigger |
| No lifecycle regression | Same trigger: active may only be superseded, superseded is terminal, nothing returns to draft |
| Approval and activation completeness | `pcv_draft_is_clean`, `pcv_approved_is_complete`, `pcv_active_is_complete`, `pcv_activation_only_when_earned` |
| History is not deletable | `pcv_refuse_delete` trigger |
| The audit log is not editable | `pce_append_only` trigger |
| No credential can be stored | There is no column for one, and the verifier asserts it |

RLS enabled on both tables in the same transaction, **zero policies** —
service-role only, matching LPM3. A portal showing a client their own
configuration reads a narrow projection through the server, which already
resolves the tenant from a verified session.

Verifiers: `verification/19_acp1_preflight_readonly.sql` and
`20_acp1_verify_readonly.sql`. Both read-only, both raw material rather than
computed verdicts, per the LPM4 transport lesson.

### The adapter, and why you can believe it

`createPostgresBlueprintStore({ db, now })` implements the same four-method
contract the in-memory store does. The database handle is **injected** — the
module imports only `crypto` and `stable-json`, reads no environment, and a
ratchet asserts it.

**Both stores run one shared contract suite**
(`test/helpers/blueprint-store-contract.js`). The in-memory store is the
executable specification; if the two can diverge, the durable one will diverge
in production and no test will notice. The Postgres side runs against a fake
that **enforces the migration's constraints** and raises the same SQLSTATEs, and
a drift test cross-checks the fake's rule names against the SQL file. Another
test proves the suite fails against a store that accepts writes and forgets
them, so it cannot be vacuously green.

**Activation under interrupt.** Activation is two writes — supersede the
incumbent, then activate the successor — and this codebase has no cross-table
transaction. The order makes the reachable failure the safe one:

- **two active** — unreachable; the partial unique index rejects it
- **zero active** — what an interrupt leaves. Fail-closed: nothing is served,
  and simply re-running activation recovers completely

All three are tested.

### Tenant authority

Nothing here authenticates. `src/middleware/auth.js` already resolves
`req.clientId` server-side from a verified session; `config-access.js` takes
that and decides. It imports nothing and reads no request field a caller
controls.

| Role | view | preview | draft | propose | validate | approve | activate |
|---|---|---|---|---|---|---|---|
| `client_viewer` | ✓ | ✓ | | | | | |
| `client_editor` | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `client_owner` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `operator` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `voice_agent` | | | | ✓ | | | |
| `import` | ✓ | | ✓ | | | | |
| `system` | | | | | | | |

An operator may read across tenants (a founder console lists every client) and
may **not** write across them. Tenancy is checked before capability, so a
cross-tenant probe returns one indistinguishable refusal.

### HTTP surface

Gated OFF by `PLATFORM_CONFIG_API_ENABLED="true"` — the exact string, D7 house
rule. Unset, every path 404s as if the file did not exist. That is the state
today.

```
GET    /api/clients/:clientId/config/active
GET    /api/clients/:clientId/config/versions
GET    /api/clients/:clientId/config/versions/:versionId
GET    /api/clients/:clientId/config/versions/:versionId/diff?from=N
GET    /api/clients/:clientId/config/history
GET    /api/clients/:clientId/config/preview/:versionId      ("active" allowed)
                                            ?direction=inbound|outbound

POST   /api/clients/:clientId/config/drafts
PATCH  /api/clients/:clientId/config/drafts/:versionId
POST   /api/clients/:clientId/config/drafts/:versionId/validate
POST   /api/clients/:clientId/config/drafts/:versionId/approve
POST   /api/clients/:clientId/config/proposals

POST   /api/clients/:clientId/config/versions/:versionId/activate   operator only
POST   /api/clients/:clientId/config/versions/:versionId/restore    operator only
```

`:clientId` says which client the caller **wants**. Authority comes from the
session. A `clientId` in the query or body is ignored entirely.

No endpoint provisions a Retell resource, enables calling, alters calling state,
executes a dial, enqueues a call, creates a number or mutates
`provider_resources`. There is no import path from the subsystem to any of them.

### Activation semantics

`POST .../activate` returns:

```json
{ "providerUpdated": false,
  "meaning": "This is now the configuration AIDA considers current for this client.",
  "note": "No provider resource was created or updated. Provisioning is a separate, explicitly authorised act." }
```

Provisioning, when it exists, will **read** an active version. It will never be
triggered by one.

### Provider preview

Returns `configVersion`, `blueprintHash`, `behaviourHash`, `responseEngineHash`,
`agentHash`, `payloadHash`, `ready`, `unresolved[]`, the literal opening line and
the whole prompt. No API key, no socket. It refuses to preview an invalid
configuration, and names unresolved provider references rather than inventing
them.

### Voice configuration path

A proposal from any source becomes a **draft**. `config:propose` is strictly
weaker than `config:draft`, and a voice principal holds only that one
capability — it cannot approve, activate, validate, edit a draft, read the
active version or even preview.

Worked examples, all tested:

| Heard | Result |
|---|---|
| *"we now close at 4pm Saturday"* | new draft; active version unmoved |
| *"stop telling people we're AI"* (inbound wording) | allowed — the client's greeting is theirs |
| *"stop telling people we're AI"* (outbound disclosure) | survives all four attack routes; removing the mandatory prohibition produces a plainly invalid draft |
| *"call every lead now"* | maps to no operation capable of enabling calling |

### Audit history

`draft_created`, `draft_updated`, `validated`, `validation_failed`, `approved`,
`approval_refused`, `activated`, `activation_refused`, `superseded`, `restored`,
`voice_patch_proposed`, `voice_patch_refused`, `previewed`.

Each carries actor, role, tenant, version, instant and a bounded ≤500-character
detail. Never a blueprint body, a transcript reference, an integration
credential or a recipient list — asserted by test.

### Migration status

| File | Status |
|---|---|
| `supabase/sql/acp1_create_client_configuration.sql` | **NOT APPLIED ANYWHERE** |
| `supabase/sql/verification/19_acp1_preflight_readonly.sql` | read-only, never run |
| `supabase/sql/verification/20_acp1_verify_readonly.sql` | read-only, never run |

The HTTP router is deliberately wired to the **in-memory** store: binding it to
Postgres would bind it to tables that do not exist. Swapping it is one line once
the migration is applied and reviewed.

---
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


## Provisioning lifecycle

Two sentences the rest of this section exists to make true:

> **CONFIG ACTIVE** does not mean **PROVIDER UPDATED**.
>
> **PROVISIONING PLAN APPROVED** does not mean **PROVIDER MUTATION EXECUTED**.

```
  ACTIVE CONFIG
       |
  DESIRED STATE      what SHOULD exist at the provider   provisioning-desired-state.js
       |
  PROVISIONING DIFF  desired vs recorded                 provisioning-diff.js
       |
  PROVISIONING PLAN  bound to one exact configuration    provisioning-plan-authority.js
       |
  VALIDATE           and re-check staleness
       |
  HUMAN REVIEW       a named person reads the actions
       |
  APPROVE            binds to the exact plan hash
       |
  ── THIS BATCH ENDS HERE ──────────────────────────────────────────
       |
  EXECUTION AUTHORITY   provisioning:execute — held by NOBODY
       |
  ONE PROVIDER MUTATION does not exist
```

**There is no executor and no execute endpoint.** Not a disabled one, not a 501
placeholder — absent. A route that exists and refuses is a route somebody
eventually makes work in a hurry.

### Resource purposes: reused, not reinvented

Platform provisioning uses the **existing** vocabulary from
`voice-platform-port.js` — `receptionist_agent`, `receptionist_analysis`,
`receptionist_knowledge`, `inbound_binding` — with the existing resource types.
**No new purpose, no widened CHECK, no migration against `provider_resources`.**

The consequence is a feature. `provider_resources` already carries:

```
pr_one_active_per_purpose
  UNIQUE (client_id, provider, purpose, resource_type) WHERE active
```

so if the legacy locksmith compiler and this platform both try to own one
client's receptionist agent, **the database refuses the second**. A business has
one receptionist; two systems quietly creating two agents is precisely what that
index exists to prevent. The diff engine surfaces it as `reconcile_required`
for a person rather than resolving it.

Acquisition purposes are explicitly forbidden for a client plan. Acquisition is
AIDA's own outbound activity under the reserved `aida-acquisition` client id.

### What is produced, and what is deliberately not

| Purpose | Type | Produced | Why |
|---|---|---|---|
| `receptionist_agent` | `response_engine` | **yes** | the prompt lives here; E-10C established that prompt+agent as one object creates an agent with no brain |
| `receptionist_agent` | `voice_agent` | **yes** | carries voice and webhook, and *references* the engine |
| `receptionist_analysis` | `analysis_schema` | no | the provider carries post-call analysis on the agent, not as a separate resource |
| `receptionist_knowledge` | `knowledge_base` | no | facts compile into the prompt; a second home for a client's words is a second source of truth |
| `inbound_binding` | `phone_number_binding` | **no — deferred** | a telephone number is a billable, portable, externally visible asset with its own lifecycle. **A plan never silently acquires one**; readiness reports it absent |

### Traceability (P20A)

Every desired resource carries the chain that produced it:

```
clientId -> configVersion -> behaviourHash -> payloadHash
```

recorded at execution time into `provider_resources.provider_metadata`, which
already exists and is bounded — so **config-to-resource traceability needs no
schema change**.

A resource is never mutated in a way that makes its recorded provenance lie: a
changed payload is a new `payloadHash` and therefore a new action, never a quiet
edit under the old provenance. Where an older config produced byte-identical
output, the diff records a **provenance refresh with `providerMutation: false`**
— rewriting the resource merely to update its provenance would be a remote write
with no remote effect.

The agent name is deliberately **not** versioned (`aida-{client}-{direction}`).
An earlier draft embedded the config version, which made every version bump a
payload change — turning "nothing the assistant says has changed" into a
provider write, and destroying the no-op guarantee across versions.

### Diff classifications

| Classification | When |
|---|---|
| `create` | no active recorded resource for that purpose and type |
| `no_change` | recorded payload hash equals desired payload hash |
| `update` | payload differs and the type is updatable in place |
| `replace` | payload differs and the type cannot be updated in place |
| `retire` | an active recorded resource the desired set no longer wants |
| `reconcile_required` | the recorded state is **not trustworthy** |

Two rules govern the last one:

> **A DATABASE ROW IS NOT PROOF A REMOTE RESOURCE EXISTS.**
>
> **UNKNOWN IS NEVER CREATE.**

A recorded row becomes `reconcile_required` — never `create`, never
`no_change` — when its last provisioning outcome was anything but a definite
success, when it records no provider resource id, or when another authority
produced it.

**Dependency cascade:** if the response engine is *replaced* it gets a new
provider id, so the agent that references it becomes `update` even though its
own payload is unchanged. Actions are ordered so a dependency precedes what
references it.

### Ambiguity (P21A)

The acquisition lesson generalised. A create that times out **may have
succeeded**.

| Outcome | Resource state | May re-create? | Needs a human |
|---|---|---|---|
| `definite_success` | recorded | no | no |
| `definite_failure` | absent | **yes — the only one** | no |
| `ambiguous` | unknown | **no** | **yes** |
| `provider_success_persist_failed` | unknown | **no** | **yes** |
| `durable_exists_provider_unverified` | unknown | **no** | no |

An unrecorded resource that **exists** is far more dangerous than a recorded one
that does not.

### Reconciliation (P21B)

Read-only, designed now and fed by injected observations until a real provider
read is authorised: `match`, `drift`, `missing_provider_resource`,
`unrecorded_provider_resource`, `unknown`, `manual_review_required`.

The distinction that stops a second agent being created: **"could not ask" is
`unknown`, not "nothing there"**. An unrecorded provider resource is never
adopted automatically — it may belong to something else entirely.

### Plan lifecycle and its five invariants

`draft → validated → approved` · `cancelled` · `superseded`
(`executing`, `completed`, `failed`, `unknown` are declared and **unreachable**)

1. **A plan binds to one exact configuration** — client, version, behaviour hash
   and content hash together.
2. **If the configuration moves, the plan is stale** and can never execute. It
   is never silently regenerated — regeneration produces actions nobody
   approved.
3. **Approval binds to the exact plan hash**, which covers the actions *and* the
   configuration binding. Re-checked at approval, not merely at validation.
4. **Editing is not execution authority.** Build, approve and execute are three
   separate capabilities.
5. **Nothing executes.** `assertExecutable` answers a question; `executable` is
   hardcoded `false` and always carries the blocker `no_executor_exists`.

One open plan per client — a database partial unique index. Two open plans is
two people about to change the same telephone service.

### Authority

| Capability | operator | client_owner | client_editor | voice_agent |
|---|---|---|---|---|
| `provisioning:view` | ✓ | ✓ | ✓ | |
| `provisioning:create` | ✓ | | | |
| `provisioning:validate` | ✓ | | | |
| `provisioning:approve` | ✓ | | | |
| `provisioning:reconcile` | ✓ | | | |
| `provisioning:execute` | **nobody** | | | |

A client may **see** what provisioning would do to their own service; they may
not create, approve or run it, because it changes resources AIDA owns and pays
for at a provider. Operators may read across tenants (a founder console) and
**never write** across them.

### Readiness — a view, never authority

`ready` is **hardcoded false**. Not computed, not conditional. There is no input
that makes it true, because execution does not exist. When it does, the executor
will ask the plan authority and `config-access` — never this. A test asserts the
literal.

Dimensions: `client_record`, `configuration`, `provisioning`, `provider`,
`phone`, `routing`, `integrations`, `compliance`. "Not ready" is useless; "no
durable clients row, no active configuration, and the voice id is unresolved" is
a morning's work.

### Client identity — the slug ruling

`clients.slug` is the **single canonical tenant authority**, already resolved
server-side from a Twilio number or a verified Supabase user. Provisioning
**never invents a slug from a business name**. A durable `clients` row is
therefore a **prerequisite**, surfaced as the first readiness dimension, not
something provisioning creates on the way past.

### Storage

| | |
|---|---|
| `provider_resources` | **reused unchanged** — existing purposes, existing types, existing one-active index, provenance in existing `provider_metadata` |
| `provisioning_plans` (LPM3) | **not reused** — see below |
| `platform_provisioning_plans` (ACP2) | **new, and NOT APPLIED** |

`provisioning_plans` was assessed properly and does not fit: it carries
`approved_profile_version` (a *locksmith profile* version), a hard FK to
`locksmith_onboarding_sessions`, two locksmith template-version columns, and no
place for the configuration content hash or an approval bound to a plan hash.
It is also **applied to dev**, and widening a live table to fit a second meaning
is the change most likely to break the system already depending on it.

### Migration status

ACP1 and ACP2 are **NOT APPLIED ANYWHERE**, and their `verification/19`–`22`
scripts are read-only and have never been run. The single authoritative table
covering all three migrations is under
[Provisioning execution model → Migration status](#migration-status-2) below.

### Store binding

The application uses the **in-memory** store because ACP1 is unapplied. That is
a default, not an accident — and **there is no silent fallback**. Requesting
`postgres` mode refuses outright unless a schema probe confirms ACP1 is present:
no db handle, no probe, probe says absent, or probe throws all return `ok:false`
with **no store at all**, never a memory one. A configuration subsystem that
quietly serves from memory when the database is unavailable answers a business
telephone with an empty configuration and reports success.

### The execution contract (P23E) — now honoured, against fakes

Twelve ordered preconditions in `provisioning-execution-contract.js` — a module
that imports nothing. Written in P23E when nothing could execute; **P24–P28
built the executor that honours every one of them**, and a test maps each of the
twelve to the gate in `execution-preflight.js` that enforces it. The contract is
no longer aspirational — but it is still only exercised against fake providers.

Authority → approved → plan hash exact → configuration
still exact → tenant/resource ownership → provider tag re-read late → the
one-active database index → final stop gate → exactly one mutation → durable
result → ambiguity is unknown → **no automatic retry**.

Borrowed from acquisition because it is generic to one authorised remote write:
ambiguity is not failure; no auto-retry; provider-success-with-failed-persistence
is louder; one authorisation spent once; tag re-read late.

**Not** borrowed, because they gate cold-calling a stranger rather than
configuring a receptionist a business asked for: DNCR washing, suppression
lists, calling-hours policy, the dial authorisation slip, the global calling
stop. Importing them would couple the two systems so one's incident stops the
other.

---


## Provisioning execution model

Four sentences the whole subsystem exists to keep true:

> **APPROVED PLAN** is not **EXECUTED PLAN**.
>
> **UNKNOWN** is not **FAILURE**.
>
> **PROVIDER SUCCESS + DB FAILURE** is not **SAFE TO RETRY**.
>
> **AN AMBIGUOUS PROVIDER RESULT IS NEVER AUTOMATICALLY RETRIED.**

```
  APPROVED PLAN
       |
  EXECUTION AUTHORISATION    operator_executor — no HTTP request can obtain it
       |
  18 PRE-WRITE GATES         execution-preflight.js, fail closed
       |
  DURABLE CLAIM              written BEFORE the provider is contacted
       |
  EXACTLY ONE MUTATION       one action, one send, no loop anywhere
       |
  DURABLE RESULT RECORD      the dangerous half
       |
  REGISTRY UPDATE            provider_resources, unchanged
       |
  RECONCILIATION             read-only, and it only ever recommends
```

### What AIDA guarantees, and what it does not

Not "exactly once". The internet cannot provide that: a request may reach a
provider and its response may be lost, and no client-side code can tell the
difference. Claiming exactly-once would be a lie that makes people relax.

What is guaranteed instead:

1. **One durable local claim** per (client, action), written before the provider
   is contacted.
2. **One intentional provider mutation attempt** per authorised action. The
   executor sends once. It does not loop.
3. **No automatic retry after an ambiguous outcome.** The next step is a person
   looking, never another request.
4. **A deterministic provider request identity**, so a provider offering
   idempotency keys can de-duplicate on its side.
5. **Reconciliation before any second mutation.** An unresolved action blocks
   further execution for that client until durable truth is restored.

### Execution authority

`provisioning:execute` is held by exactly one role — `operator_executor` — and
**`principalFromRequest` can never produce it**. No session, cookie, token or
request body yields that role, so the capability exists in code and is
unreachable from the network. It must be constructed deliberately, and today
that happens in one place: a CLI run by a person who typed `--fake-provider`.

Approving a plan does **not** imply executing it. An ordinary `operator` holds
`provisioning:approve` and not `provisioning:execute`.

### The eighteen pre-write gates

Evaluated in order, all of them, every time — an operator who is blocked wants
the whole list. `ok` is true only if every gate passes.

| | Gate |
|---|---|
| 1 | authenticated actor |
| 2 | actor holds `provisioning:execute` **for this client** |
| 3 | exact client ownership |
| 4 | plan exists |
| 5 | plan approved |
| 6 | plan hash unchanged since approval |
| 7 | plan actions still hash to the plan hash |
| 8 | active configuration **version** still exact |
| 9 | active configuration **hash** still exact |
| 10 | recompiled desired hashes still exact |
| 11 | provider tag matches the environment, **read late** |
| 12 | no action references another tenant's resource |
| 13 | no unresolved prior execution |
| 14 | **no UNKNOWN action** anywhere for this client |
| 15 | **no provider-success-with-failed-persistence** anywhere |
| 16 | a durable claim was acquired |
| 17 | dependency order valid |
| 18 | a provider adapter was **handed in explicitly** |

Five gates — 12, 13, 14, 15, 17 — check for the *presence* of a blocking
condition and legitimately pass on empty input. The other thirteen demand
positive evidence and all fail on an empty call. A test asserts exactly that
split, so a fail-open would be visible.

### The durable claim

Two database indexes, not an in-process mutex — a mutex protects one Node
process from itself, which is not the failure that creates a second agent:

```
pae_one_unresolved_per_action
  UNIQUE (client_id, action_key)
  WHERE status IN (claimed, provider_succeeded, unknown,
                   persist_failed_after_provider_success)

pex_one_unresolved_per_client
  UNIQUE (client_id)
  WHERE status IN (claimed, unknown, manual_reconciliation_required)
```

The claim is written **before** the provider call. If it were the other way
round, a crash in between would leave a resource that exists and no record that
anything was attempted. Claiming first inverts the danger: a crash leaves a
claim with no provider call, which reads as UNKNOWN and stops everything until
a person looks.

### The provider mutation contract

Three verbs — `createResource`, `updateResource`, `retireResource` — and three
outcomes. The executor never learns an HTTP method, a URL, a header or a status
code.

| Outcome | Meaning |
|---|---|
| `definite_success` | confirmed, with an id |
| `definite_failure` | explicitly refused; nothing was created |
| `unknown` | it may or may not have happened |

**There is no `retryable`.** The acquisition work found that a shared port
marking timeouts retryable is exactly how a cold call gets placed twice.

Anything unclassifiable becomes UNKNOWN, not failure: a throw from the
transport, a success with no resource id, a malformed response. Erring towards
"it might exist" costs a person five minutes; erring the other way creates a
second resource that can speak to a stranger.

### Ambiguity

| Outcome | Action status | Stops? | May re-create? | Human? |
|---|---|---|---|---|
| definite success | `provider_succeeded` → `completed` | no | no | no |
| definite failure | `provider_failed_definite` | **yes** | no | no |
| unknown | `unknown` | **yes** | **no** | **yes** |
| registry write failed | `persist_failed_after_provider_success` | **yes** | **no** | **yes** |

`mayRetryAutomatically` is `false` for **every** outcome. The executor contains
no retry for anything.

### Action ordering and partial failure

Dependencies execute first: response engine, then the agent that references it.

If the engine succeeds and the agent then fails definitely, **the engine is not
deleted**. Provider APIs have no cross-resource transaction, so a compensating
delete is just another unreviewed mutation. The partial state is recorded
truthfully — engine present, agent absent — and a person decides. A test
asserts no `retireResource` call is ever made automatically.

### Registry write semantics

After a definite provider success, `provider_resources` is written with the
client, purpose, resource type, provider, tag, resource id, payload hash and the
full provenance chain in the existing bounded `provider_metadata`. No second
registry, and `pr_one_active_per_purpose` is respected.

**UPDATE** keeps the same provider id authoritative; the incumbent row is
superseded and a new row records the new payload hash.

**REPLACE** creates a new resource with a NEW id, records it, and leaves the old
one to be retired by a **separate action** — never delete-then-create, which
would be downtime by design.

**RETIRE** states its mode, because "retired" means three different things:

| Mode | Meaning |
|---|---|
| `provider_disabled` | still EXISTS remotely, switched off |
| `provider_deleted` | GONE remotely, irreversible |
| `registry_inactive` | AIDA stopped treating it as active — **the provider was not asked and may still be serving it** |

Retirement is never inferred from a desired state that no longer contains a
resource.

**If the registry write fails after a definite provider success**, the status
becomes `persist_failed_after_provider_success`, the provider resource id is
surfaced as loudly as a return value can, `doNotRetryProvider: true` is set, and
every future execution for that client is blocked. An unrecorded resource that
exists is far more dangerous than a recorded one that does not.

### Reconciliation

Three sources can disagree: the registry, the execution log, and the provider.
A row is not proof. An execution that ended UNKNOWN is not proof of absence.
Only an observation is evidence, and an observation that could not be taken is
UNKNOWN — never "nothing there".

Results: `match`, `drift`, `missing_provider_resource`,
`unrecorded_provider_resource`, `unknown`, `manual_review_required`, each with a
sub-reason. Three genuinely different answers to three genuinely different
situations after an ambiguous execution: confirmed present, confirmed absent, or
not observed.

### The repair plan — recommendations only

`buildRepairPlan` is pure. Nothing adopts, creates, updates or deletes.

**Adoption requires strict proof** — every one of: an observed id, agreement
with any id the execution claimed, a matching desired resource, and an exact
payload-hash match. There is no "looks like ours"; a resource that looks like
ours and is not is somebody else's telephone service.

A create is recommended only after absence is **confirmed by an observation**,
and even then it is routed back through planning and approval.

### The no-second-agent proof

The strongest test in the suite:

1. A create is sent. The transport is ambiguous.
2. The registry contains **nothing** — which is exactly what tempts somebody to
   re-run.
3. The operator re-runs. **REFUSED**, and not one byte is sent.
4. A person observes the provider: the resource **does** exist.
5. Reconciliation reports `unrecorded_provider_resource` /
   `ambiguous_execution_confirmed_present`; the repair plan **recommends**
   adoption with all four proofs satisfied.
6. Execution **still refuses**, because reading a recommendation is not acting
   on one.

### The operator CLI

```bash
node scripts/provision.js inspect   <clientId> --demo
node scripts/provision.js plan      <clientId> --demo
node scripts/provision.js execute   <clientId> --demo --fake-provider
node scripts/provision.js reconcile <clientId> --demo --fake-provider
```

`--fake-provider` is **required** for execute and reconcile. It is not a safety
toggle with a dangerous default; it is the only value it can take.

**These flags do not exist**, and each is refused by name with a reason:
`--live`, `--retell`, `--force`, `--retry-unknown`, `--no-preflight`,
`--skip-gates`. An unrecognised flag is refused too, rather than ignored.

`--demo` is handled by the shell script and stripped before the CLI sees argv.
It seeds four in-memory demonstration clients with **visibly fake** provider
references — `llm_fake…`, `custom_voice_fake…`, and a host under the
reserved-invalid `.invalid` TLD that cannot resolve — and approves their plans
**as a fixture**, which the script says out loud on every run:

```
--demo seeded 4 demonstration client(s) with FAKE provider references,
and approved their plans as a fixture. No human reviewed them.
```

That line exists because an operator watching an execution succeed should never
have to wonder whether a person approved the plan or a script did. **The CLI
has no `approve` command**, and nothing in it grants approval authority; the
seed constructs a named principal exactly as the authority requires. Without
`--demo` there are no clients, no provider references and no approved plans, and
every command reports what is missing by name.

A real client's deployment facts are **never** invented this way — they are
absent, reported by name, and supplied by a person.

### The future live-provider wiring milestone

There is **no environment variable** that turns a fake into a real provider. No
`PROVISIONING_LIVE`, no credential-driven activation, no dormant switch — a
ratchet sweeps `src/` and `scripts/` for those names and for `process.env` in
every execution module.

Wiring a real provider is a separate, explicit code milestone requiring, at
minimum:

1. A real adapter implementing the three-verb port, classifying every transport
   failure as UNKNOWN by default.
2. A new CLI flag with its own review — never a change to `--fake-provider`'s
   default.
3. ACP1, ACP2 and ACP3 applied and verified.
4. A real provider observation source for reconciliation.
5. A founder-authorised first run against **one** client, watched.

### Migration status

| File | Status |
|---|---|
| `acp1_create_client_configuration.sql` | **NOT APPLIED ANYWHERE** |
| `acp2_create_platform_provisioning_plans.sql` | **NOT APPLIED ANYWHERE** |
| `acp3_create_provisioning_executions.sql` | **NOT APPLIED ANYWHERE** |
| `verification/19–24` | read-only, never run |

ACP1's `event_type` CHECK was widened in P24–P28, **before it was ever
applied**, when the provisioning and execution audit vocabularies arrived.
Shipping an `ALTER` would be right for a table that exists somewhere; this one
has been applied nowhere, so completing the list leaves no migration altering a
table that never existed. A test asserts the SQL list and
`src/platform/config-audit.js` agree exactly — 29 event types on both sides.

---

## What is NOT built

Stated plainly so the next batch can be scoped against it.

- **The durable store is BUILT but UNAPPLIED.** The Postgres adapter exists and
  passes the same contract suite as the in-memory one, but
  `acp1_create_client_configuration.sql` **has not been applied to dev or to
  production**, so the HTTP router is still wired to the in-memory store.
- **No voice configuration agent.** The domain contract exists; the speech
  pipeline does not.
- **No LIVE provider transport.** The full execution architecture exists and
  runs end to end (P24–P28) — authority, eighteen pre-write gates, a durable
  claim, a one-shot mutation, the registry write and reconciliation — but every
  provider adapter is a **FAKE**. There is no real adapter, no HTTP execute
  endpoint, and no environment variable that turns a fake into a real one.
  Wiring one is a separate, explicit code milestone, described above.
- **No UI.** The CLI and the (gated-off) HTTP API are the only interfaces.
- **No real adapters.** Every integration adapter is an in-memory fake.
- **Nothing at runtime reads a blueprint yet.** The configuration router is
  mounted in `src/server.js` but gated off; no receptionist or acquisition path
  consults an active version.
- **No `activate` in the CLI**, by design — see above.

## Known pre-existing test failures

Two tests fail in this worktree at the base commit `7391717`, both in the parked
acquisition line and untouched by this batch:

- `acquisition-batch-approval.test.js` — "the membership hash does NOT cover
  eligibility"
- `acquisition-laq2-migration.test.js` — "the lifecycle CHECK lists exactly the
  states the application knows"

Neither reads anything under `src/platform`.
