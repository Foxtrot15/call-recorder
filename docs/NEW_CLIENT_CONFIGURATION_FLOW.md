# New client configuration flow

What an eventual UI does, screen by screen, and which call sits behind each
button. Written so the UI can be built without reading the domain code, and so
the domain can refuse anything the UI gets wrong.

**Nothing here provisions anything.** The last screen shows a person what a
provider *would* be told. Sending it is a separate, explicitly authorised act
that does not exist yet.

---

## Before any screen: who is looking

The UI never sends a client id as authority. `src/middleware/auth.js` resolves
`req.clientId` server-side from a verified session, and `config-access.js` turns
that into a principal. The `:clientId` in a URL says which client the caller
*wants*; a mismatch is one indistinguishable 403.

| Signed in as | Role | Can |
|---|---|---|
| a client user | `client_editor` (default) | view, preview, draft, propose, validate |
| a client owner | `client_owner` | + approve |
| the founder | `operator` | + activate, restore, and read across clients |
| a future voice interviewer | `voice_agent` | propose. Nothing else |

The API is gated off entirely until `PLATFORM_CONFIG_API_ENABLED="true"`.

---

## Screen 1 — Configuration overview

> *"This is what Aida currently says for your business."*

```
GET /api/clients/:clientId/config/active
GET /api/clients/:clientId/config/versions
```

Shows the active version number, who approved it and when, and the history
beneath it. Every row carries a status: `draft`, `validated`, `approved`,
`active`, `superseded`.

**The one sentence the UI must get right:** *active* means this is the
configuration AIDA considers current. It does not mean anything was sent to a
telephone provider.

If there is no active version, the API returns 404 rather than an empty object.
A client with no active configuration is a real state, not an empty one.

---

## Screen 2 — Edit

> *"Change what Aida says."*

```
POST  /api/clients/:clientId/config/drafts        (start from the active version)
PATCH /api/clients/:clientId/config/drafts/:v     (save)
```

Editing **never** changes what is live. The first save creates a new version in
`draft` status; the active one is untouched and stays untouched until somebody
activates a successor.

Sections the UI exposes: identity, services, service area, hours, call handling
(greeting, what to collect, urgency rules, escalation), knowledge (approved
facts, prohibited claims, pricing policy), booking, voice, compliance,
integrations.

Sections it must **not** expose: `metadata`, `identity.clientId`,
`identity.vertical`, `schemaVersion`. The PATCH handler strips them; the
authority refuses them; the database refuses them.

### Two people editing at once

Send `expectedUpdatedAt` — the `metadata.updatedAt` the UI last read — with
every save.

- match → the save lands
- mismatch → **409**, and the UI must say *"somebody else has changed this;
  reload"* rather than retrying

A brand-new draft has `updatedAt: null`. That is a real value to send back, not
an absence: sending it means *"it had never been edited when I opened it"*.
Omitting the field skips the check entirely, which is only correct for a
single-editor flow.

---

## Screen 3 — Check

> *"Is this configuration usable?"*

```
POST /api/clients/:clientId/config/drafts/:v/validate
```

- **200** — moves the draft to `validated`, with any warnings
- **422** — a list of `{ path, message }`, one per problem

Each error points at a field the UI can highlight. The ones worth designing for,
because each is silent on a real call:

| Error | Say to the user |
|---|---|
| `callHandling.escalation.primaryNumber` | "Something transfers, but there's no number to transfer to." |
| `compliance.recordingDisclosure` | "You're recording callers without telling them." |
| `knowledge.prohibitedClaims` | "This claim can't be removed — it applies to every AIDA client." |
| `voice.profileRef` | "That's a provider's voice id. Choose a voice profile instead." |
| `booking.capabilityTarget` | "Bookings point at a system you haven't enabled." |
| `hours.weekly.<day>` | "Say what happens on this day, even if it's closed." |

Editing after validation drops the version back to `draft`, so it must be
validated again. That is deliberate: approval always applies to a body that
passed.

---

## Screen 4 — Review the difference

> *"Here is exactly what changes."*

```
GET /api/clients/:clientId/config/versions/:v/diff
GET /api/clients/:clientId/config/versions/:v/diff?from=N
```

A domain diff, not a text diff: `hours.weekly.saturday.close 13:00 -> 16:00`,
not a unified diff of a 200-line object. The person approving is a business
owner, and a diff they will approve without reading is the same as no approval.

Deterministic — the same pair of versions always produces the same list in the
same order.

---

## Screen 5 — Hear it

> *"This is what Aida will actually say."*

```
GET /api/clients/:clientId/config/preview/:v?direction=inbound
GET /api/clients/:clientId/config/preview/:v?direction=outbound
```

Returns the **literal opening line** and the whole prompt, plus four hashes.
Show the opening line prominently and large — it is the first thing a real
caller hears.

The two directions differ, by founder ruling:

- **inbound** — the client's own greeting, no forced AI disclosure
- **outbound** — always discloses; there is no setting for it

Refuses with **422** if the configuration is invalid. A preview of something
that cannot ship is misleading.

`ready: false` with `unresolved: ["voiceId", …]` means deployment facts are
missing. Show the names. Never substitute a placeholder — that is how the wrong
voice reaches a real caller.

---

## Screen 6 — Approve

> *"I've read this and I'm happy for Aida to say it."*

```
POST /api/clients/:clientId/config/drafts/:v/approve   { reason }
```

Requires `client_owner` or `operator`. The approver's name and reason are
recorded permanently, and the approved body is frozen — the database refuses any
later change to it.

The response carries `isLive: false`. **The UI must not present approval as
going live.** A good pattern: *"Approved. Not live yet — the AIDA team will
activate it."*

---

## Screen 7 — Activate

> *"Make this the current configuration."*

```
POST /api/clients/:clientId/config/versions/:v/activate
```

**Operator only.** The previous active version is superseded first, so there is
never a moment with two.

The response says so explicitly:

```json
{ "providerUpdated": false,
  "meaning": "This is now the configuration AIDA considers current for this client.",
  "note": "No provider resource was created or updated. Provisioning is a separate, explicitly authorised act." }
```

If activation is interrupted, the client is left with **zero** active versions —
never two. The UI should show *"activation incomplete"* and offer to retry;
re-running is safe and idempotent.

---

## Screen 8 — History

```
GET /api/clients/:clientId/config/history
```

Every event, including refusals: who tried to approve and was not allowed, what
the voice agent proposed, what failed validation. An audit log containing only
successes describes a system where nothing ever goes wrong.

Never contains a blueprint body, a transcript, or an integration credential.

---

## The voice path, when it exists

A voice interviewer submits a **proposal**, never an edit:

```
POST /api/clients/:clientId/config/proposals
{ "patch": { "explanation": "We now close at 4pm Saturday.",
             "transcriptRef": "call_…",
             "operations": [ { "op": "set",
                               "path": "hours.weekly.saturday",
                               "value": { "open": "08:00", "close": "16:00" } } ] } }
```

It comes back as a **draft** with a diff and a validation result, and
`requiresHumanApproval: true`. The UI should read the diff back to the caller —
*"so that's Saturday closing at four instead of one, is that right?"* — and then
route it to whoever approves.

The reason it can only ever be a proposal: speech-to-intent mishears things.
*"Don't service Brunswick"* and *"don't service Brunswick East"* differ by one
word and by a suburb's worth of revenue, and the person who finds out is a
customer being told no.

A voice principal cannot approve, activate, validate, edit a draft, read the
active version or preview. It holds exactly one capability.

---

## Screen 9 — Provisioning (operator console)

> *"What would change at the provider, and has anybody agreed to it?"*

```
GET  /api/clients/:clientId/config/provisioning/diff
GET  /api/clients/:clientId/config/provisioning/desired
GET  /api/clients/:clientId/config/provisioning/plans
GET  /api/clients/:clientId/config/provisioning/plans/:planId/actions
GET  /api/clients/:clientId/config/provisioning/readiness
GET  /api/clients/:clientId/config/provisioning/execution-contract

POST /api/clients/:clientId/config/provisioning/plans                  operator
POST /api/clients/:clientId/config/provisioning/plans/:planId/validate operator
POST /api/clients/:clientId/config/provisioning/plans/:planId/approve  operator
POST /api/clients/:clientId/config/provisioning/plans/:planId/cancel   operator
```

A client may **see** what provisioning would do to their own service. Only an
operator may build, validate or approve a plan.

**Render the actions as a list a person can argue with**, not as JSON. Each
carries a purpose, a resource type, a classification and a reason.

| Classification | Show it as |
|---|---|
| `create` | "will be created" |
| `no_change` | "already correct — nothing will happen" |
| `update` | "will be changed" |
| `replace` | "will be recreated with a new id" |
| `retire` | "will be retired" |
| `reconcile_required` | **stop the user.** "We cannot tell what exists at the provider. Somebody must look before anything else happens." |

Send `expectedPlanHash` with the approval — the hash of the plan actually
displayed. A **409** means the plan moved between the screen and the button:
reload and re-read, never retry.

The approval response carries `providerMutated: false` and `executable: false`.
**The UI must not present approving a plan as provisioning anything.** A good
pattern: *"Approved. Nothing has been created yet — provisioning is a separate
step that does not exist in this build."*

## Screen 10 — Readiness

```
GET /api/clients/:clientId/config/provisioning/readiness
```

`ready` is always `false` and the response also carries `isPermission: false`.
**Do not build a "Go live" button from this.** Render the dimensions as a
checklist so a person can see what is missing: client record, configuration,
provisioning, provider, phone, routing, integrations, compliance.

## What the UI must never build

- A button that provisions, deploys or "pushes to Retell". No endpoint does it.
- A toggle for AI disclosure. It is platform policy, not configuration.
- A client id field in a request. Authority comes from the session.
- A merge on conflict. A 409 means reload, never retry-with-force.
- An "approve and activate" combined button. They are two decisions, made by two
  roles, on purpose.
- **Any button that provisions, deploys or "pushes to Retell".** There is no
  execute endpoint and no executor; `provisioning:execute` is held by nobody.
- A "Go live" button driven by readiness. Readiness is a view, never a
  permission.
- Anything that treats an approved provisioning plan as a completed one.

---

## Status

The HTTP API is **gated off** and wired to the in-memory store, because
`acp1_create_client_configuration.sql` **has not been applied anywhere**. Every
call above works today against that store; pointing it at Postgres is one line
once the migration is applied and reviewed.
