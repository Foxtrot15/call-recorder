# Second client onboarding checklist

Taking a business that is **not** the pilot locksmith from "they said yes" to a
working assistant.

This is the honest version: it ends before the thing that would make the
telephone ring, because that thing does not exist yet. Everything up to it does,
and is proven end to end offline by
`test/platform-provisioning-service.test.js` ("a fictional garage-door business,
end to end, offline").

Two sentences to keep in front of you the whole way:

> **CONFIG ACTIVE** does not mean **PROVIDER UPDATED**.
>
> **PROVISIONING PLAN APPROVED** does not mean **PROVIDER MUTATION EXECUTED**.

---

## Stage 0 — prerequisites that are not configuration

- [ ] **A durable `clients` row exists, with the slug you will use everywhere.**
      `clients.slug` is the single canonical tenant key — `provider_resources`,
      the portal, the config versions and the plans all use it, and
      **provisioning never invents one from a business name**. Readiness
      reports its absence as the first blocker.
- [ ] **A named person at the business** who will approve their configuration.
      An approval without a person is not an approval, and the authority
      refuses `system`, `aida`, `bot`, `cron` and similar.
- [ ] **A named operator** who will activate and who will approve provisioning.
      They are deliberately different capabilities from approving the wording.

**Blocked here?** Nothing further is possible. Stop and create the client
record.

---

## Stage 1 — configuration

Follow [NEW_CLIENT_IMPLEMENTATION_CHECKLIST.md](NEW_CLIENT_IMPLEMENTATION_CHECKLIST.md)
in full, or the screens in
[NEW_CLIENT_CONFIGURATION_FLOW.md](NEW_CLIENT_CONFIGURATION_FLOW.md).

- [ ] draft → validate → read the diff → **a named person approves** →
      **an operator activates**
- [ ] Read the **first spoken sentence** aloud. Inbound keeps the business's own
      greeting; outbound always discloses AI.
- [ ] Record the **behaviour hash**. It is how you will later answer "has
      anything changed?" without reading anything.

At the end of this stage the client has an **active configuration** and
**nothing exists at any provider**. That is correct and expected.

---

## Stage 2 — deployment facts

Provisioning needs things that are not configuration and are never guessed:

- [ ] a **response engine / LLM id** for this client
- [ ] a **voice id** — chosen and auditioned deliberately, never inherited from
      a shared default
- [ ] a **webhook URL** for the environment being provisioned
- [ ] a **provider tag** naming that environment

The preview reports missing ones **by name** (`unresolved: ["voiceId", …]`) and
refuses to be ready. Supply them; never substitute a placeholder — that is how
the wrong voice reaches a real caller.

---

## Stage 3 — the provisioning diff

```
GET /api/clients/:clientId/config/provisioning/diff
GET /api/clients/:clientId/config/provisioning/desired
```

- [ ] Expect **two** actions for a new client: `create` a response engine and
      `create` a voice agent, in that order.
- [ ] Confirm `providerContacted: false`.
- [ ] Read `deliberatelyAbsent`. It should include the **phone number binding**
      — a plan never silently acquires a number.

Classifications worth recognising:

| You see | It means |
|---|---|
| `no_change` on everything | the client is already provisioned and nothing has changed — this is the healthy steady state |
| `reconcile_required` | **stop.** The recorded state is not trustworthy. Somebody must establish what exists at the provider before anything else happens |
| `retire` | a recorded resource the configuration no longer wants |
| `update` after a config change | expected; the payload moved |

**`reconcile_required` is never resolved by planning again.** It is not a
create, and re-creating is how one authorised write becomes two agents.

---

## Stage 4 — the plan

```
POST /api/clients/:clientId/config/provisioning/plans           operator
POST .../plans/:planId/validate                                 operator
POST .../plans/:planId/approve   { reason, expectedPlanHash }   operator
```

- [ ] The plan binds to **one exact configuration** — version, behaviour hash
      and content hash.
- [ ] Validation re-checks staleness. So does approval; validating earlier is
      not evidence the configuration has not moved since.
- [ ] Send `expectedPlanHash` — the hash of the plan you actually read. A
      mismatch is a **409**, meaning the plan moved between the screen and the
      button.
- [ ] The response says `providerMutated: false` and `executable: false`. It
      means a person has agreed to a set of mutations. **Nothing has been
      performed.**

If the configuration changes at any point, the approved plan goes **stale** and
can never execute. Build a new one; it supersedes the old.

---

## Stage 5 — readiness

```
GET /api/clients/:clientId/config/provisioning/readiness
```

- [ ] `ready` will be **false**. It is hardcoded false and always will be until
      an executor exists. **Readiness is a view, never a permission.**
- [ ] Work the blockers in order. A healthy pre-execution client reads:

```
client_record   present
configuration   active
provisioning    approved
provider        absent          ← nothing has been created yet
phone           absent          ← a separate authority
routing         absent          ← nothing routes a call yet
integrations    satisfied
compliance      satisfied
```

That state is **"provision-ready but not provisioned"**, and it is where this
checklist ends today.

---

## Stage 6 — execution — DOES NOT EXIST

- [ ] There is no execute endpoint, no executor, and no role holds
      `provisioning:execute`.
- [ ] `GET .../provisioning/execution-contract` returns the **twelve
      preconditions** a future executor must satisfy. Reading a contract is not
      signing one.

Before anybody builds it, all of the following must be true, in order:
authority → approved → plan hash exact → configuration still exact →
tenant/resource ownership exact → provider tag re-read immediately before the
write → the one-active database index accepts it → a final stop gate →
**exactly one** mutation → durable result recorded → ambiguity recorded as
`unknown` → **no automatic retry**.

---

## Before any of this can run against a real database

- [ ] Apply **ACP1** (`acp1_create_client_configuration.sql`) — preflight `19`,
      apply, verify `20`.
- [ ] Apply **ACP2** (`acp2_create_platform_provisioning_plans.sql`) — preflight
      `21`, apply, verify `22`.
- [ ] Switch the store binding to `postgres` mode. It **refuses** unless a
      schema probe confirms ACP1 is present, and it never falls back to memory.
- [ ] Set `PLATFORM_CONFIG_API_ENABLED="true"` — the exact string.

**All four SQL files are currently applied nowhere.**

---

## What "done" looks like today

A non-locksmith business with an active, approved configuration; an approved
provisioning plan describing exactly two provider mutations; a readiness view
naming precisely what is missing; and **not one byte sent to any provider**.
