# Retell sandbox validation plan

**Status: NOT EXECUTED.** Nothing in this document has been run. No Retell
account is connected, no API key exists in this environment, no resource has
been created, and no phone or web call has been placed.

This is the procedure for the first real provider validation, written while the
contracts were being corrected so that the plan reflects what the code now
actually sends.

---

## Why a web call first, not a phone number

The first validation should use **`POST /v2/create-web-call`**, before buying or
importing an Australian phone number.

- A web call needs no number, so it costs less and commits to nothing.
- It exercises the parts most likely to be wrong — knowledge base, LLM, agent,
  dynamic variables, transcript, analysis — without the phone-binding contract
  in the way.
- An Australian number is a recurring cost and a porting decision; making it a
  prerequisite for learning whether the agent payload is even accepted is the
  wrong order.
- Phone binding can then be validated separately, once the agent is known good.

---

## Prerequisites (all currently absent)

| Requirement | Status |
|---|---|
| Retell account | exists (a custom voice has been selected) |
| `RETELL_API_KEY` | not set in this environment |
| Confirmed `voice_id` from the dashboard | selected by the founder; supplied via `RETELL_DEFAULT_VOICE_ID`, never hard-coded |
| Confirmed language/locale (is `en-AU` supported?) | unverified |
| Publicly reachable `RETELL_WEBHOOK_BASE_URL` | not available |
| Node runtime compatible with the Retell SDK | unverified |
| **Explicit user permission to create billable resources** | **not given** |

`ANTHROPIC_API_KEY` is **not** required for provider-contract validation. It is
only needed later, for the real Claude extraction adapter, which is a separate
concern.

---

## Sequence

Run with `RETELL_ALLOWED_TAG=dev`. The execution gate refuses `prod`.

1. **Create a knowledge base** — one temporary KB, multipart, one text item.
   Capture `knowledge_base_id`.
2. **Poll until `status` is `complete`.** Record how long it takes; this is
   currently unknown and affects whether provisioning can be synchronous.
3. **Create the Retell LLM**, attaching `knowledge_base_ids`. Capture `llm_id`
   and `version`.
4. **Confirm `llm_id` was captured** before continuing. The reference resolver
   fails closed here, so a missing id stops the run rather than sending null.
5. **Create the agent** with `response_engine: {type: "retell-llm", llm_id}` and
   a real `voice_id`. Capture `agent_id` and `version`.
6. **Create a web call** for that agent.
7. **Supply controlled dynamic variables** — a fictitious transfer number from
   the ACMA range (0491 570 006–156) and a fictitious business name. **Never a
   real client's data.**
8. **Join in the browser** using `access_token`.
9. **Speak a fictional locksmith scenario**, including one in-area suburb and
   one out-of-area suburb, to test the service-area boundary.
10. **Retrieve the call** and record `call_status`.
11. **Verify transcript and analysis** against `post_call_analysis_data`: are
    the custom enum fields populated, and with valid values?
12. **Verify no cross-client data** appears anywhere in the transcript,
    analysis, or knowledge retrieval.
13. **Delete or archive** every temporary resource (see cleanup below).
14. **Record actual cost.**

### What to watch for specifically

These are the assumptions most likely to break, in order:

1. Multipart KB encoding accepted verbatim.
2. `general_prompt` accepted at its compiled length.
3. `en-AU` supported, or silently coerced to `en-US`.
4. Whether `{{variable}}` placeholders resolve as documented.
5. Whether an unsupplied variable really renders literally — the failure mode
   that would read `{{runtime}}` aloud to a caller.
6. Analysis timing: attached to `call_ended` or only to `call_analyzed`.

---

## Expected billable actions

Every step below costs money. None has been incurred.

| Action | Cost |
|---|---|
| Knowledge base creation/storage | provider-dependent, likely small |
| LLM + agent creation | typically free to create |
| **Web call minutes** | **charged per minute — the main cost** |
| Phone number (deferred) | recurring monthly |
| Inbound call minutes (deferred) | per minute |

Keep the first web call short. A minute is enough to prove the contract.

---

## Cleanup

Run immediately after recording results:

1. Delete the web call record if the provider allows it; otherwise note the id.
2. Delete the temporary knowledge base.
3. Delete or archive the agent and the Retell LLM.
4. **CORRECTED 2026-08-01:** Retell DOES document delete endpoints —
   `DELETE /delete-agent/{id}`, `DELETE /delete-retell-llm/{id}` (documented
   as removing all versions) and `DELETE /delete-knowledge-base/{id}`, each
   returning 204. An earlier draft of this plan claimed otherwise. There is
   still **no** documented delete-call endpoint, so a web-call record remains
   in the dashboard.
5. Confirm no resource carries a real client identifier.
6. Revoke the sandbox API key if it will not be reused.

---

## What this plan does NOT do

- It does not connect a production number.
- It does not use a real client's profile — only the demonstration fixture.
- It does not enable `RETELL_LIVE_CALLS_ENABLED` for outbound calls.
- It does not validate billing, which is a separate provider entirely.
- It does not make the receptionist live for anyone.

---

# M7B — Implemented sandbox runner (2026-08-01)

`scripts/retell-web-sandbox.js` now exists. **It has not been executed.** No
Retell request has been made, no resource created, no call placed.

## Why a web call is separated from a telephone call

`RETELL_LIVE_CALLS_ENABLED` governs **telephone** calls. It requires
`RETELL_OUTBOUND_ONBOARDING_NUMBER`, it can ring a real handset, and enabling it
is the most expensive mistake available in this codebase.

A web call is a different capability: browser audio, no number, no dialling, no
carrier. Routing it through the telephone gate would mean **switching on the
ability to ring real telephones in order to test a browser microphone**.

So the sandbox has its own gate, and it **refuses to run while
`RETELL_LIVE_CALLS_ENABLED=true`**. That refusal is the point, not
belt-and-braces: if live telephone calls are enabled, this is not a sandbox any
more.

The adapter reflects the same separation — `createWebCall` is guarded by
`canWriteLive`, never `canPlaceCall`.

## Every gate

All must hold simultaneously. Each is strict-parse (`"true"` exactly).

| Gate | Required value |
|---|---|
| `NODE_ENV` | **not** `production` |
| `RETELL_ENABLED` | `true` |
| `RETELL_LIVE_WRITES_ENABLED` | `true` |
| `RETELL_DRY_RUN` | `false` |
| `RETELL_SANDBOX_WEB_CALL_ENABLED` | `true` |
| `RETELL_SANDBOX_EXECUTE` | `true` |
| `RETELL_ALLOWED_TAG` | `dev` (defaults to `dev`) |
| `RETELL_API_KEY` | present |
| `RETELL_DEFAULT_VOICE_ID` | present — **never invented** |
| `RETELL_DEFAULT_LANGUAGE` | present (defaults to `en-AU`) |
| `RETELL_LIVE_CALLS_ENABLED` | **not** `true` |
| recording | disabled |
| webhooks | disabled |

**Not required:** `RETELL_OUTBOUND_ONBOARDING_NUMBER`,
`RETELL_INBOUND_DEMO_NUMBER`, `RETELL_WEBHOOK_BASE_URL`, and
**`ANTHROPIC_API_KEY`** — provider-contract validation needs no model key.

Tuning: `RETELL_SANDBOX_TIMEOUT_MS` (30000), `RETELL_SANDBOX_KB_POLL_MS` (3000),
`RETELL_SANDBOX_KB_MAX_WAIT_MS` (180000).

## The voice id is configuration, not code

The founder's selected voice is read from `RETELL_DEFAULT_VOICE_ID`. It is
**not hard-coded anywhere**, and the sandbox refuses to run without it rather
than substituting a default — an invented voice id is a call in the wrong voice,
or a rejected request, and neither is worth guessing at.

## Commands

Assessment only — contacts nothing, spends nothing, prints gates and the plan:

    node scripts/retell-web-sandbox.js

Execute — creates temporary resources and one web call:

    node scripts/retell-web-sandbox.js --execute

Execute and deliberately keep the resources for dashboard testing. Requires
`RETELL_SANDBOX_KEEP_RESOURCES=true` **and** the flag — two independent signals,
because a forgotten environment variable must never be the reason a paid
resource is still alive next month:

    node scripts/retell-web-sandbox.js --execute --keep-resources

Clean up later from the manifest:

    node scripts/retell-web-sandbox.js --cleanup-manifest "PATH_PRINTED_BY_THE_RUN"

Production always refuses, before anything else is evaluated.

## Resource order

1. knowledge base (multipart, fictional content) → capture `knowledge_base_id`
2. poll `get-knowledge-base` until `complete` — **never proceed while
   `in_progress`**; `error` and timeout both fail the run
3. Retell LLM with `knowledge_base_ids` attached → capture `llm_id`, `version`
4. agent with the **real** `llm_id`, recording off, no webhook, no number →
   capture `agent_id`, `version`
5. `get-agent` and verify `response_engine.llm_id`, `voice_id`, `language`
6. **one** web call → capture `call_id`, `call_status`
7. verify the call is bound to the sandbox agent

Nothing existing is updated — including the dashboard's auto-created agent.
Fresh resources every time, so the whole provisioning path is exercised.

## The browser conversation — chosen path and an honest limitation

**Selected: Option 1 — an isolated client outside this repository.**

The official browser SDK is `retell-client-js-sdk`
(`retellWebClient.startCall({ accessToken })` / `.stopCall()`). Microphone
access requires a secure context; `localhost` qualifies.

It is **not** installed here, and must not be: adding it would modify the
historical `package-lock.json`. Create a throwaway directory **outside the
repository**, install `retell-client-js-sdk` there, and serve a page bound to
`localhost` only.

### The constraint that shapes everything

> **A web-call access token is invalidated ~30 seconds after creation.**

This is why `scripts/retell-web-sandbox.js` **does not print the token**: by the
time anyone read it from a terminal and pasted it into a browser it would
already be dead, and printing a secret that cannot work is all cost and no
benefit.

A working browser session therefore has to create the web call **at the moment
the browser is ready** — the page asks a local server for a token on click, the
server calls create-web-call then, and the SDK starts immediately. Any design
that mints the token in advance is fighting the 30-second window.

Rules for that local page, if built:

- token delivered server-side, held in memory, never written to disk or a database
- bound to `localhost` only, never available in production
- the API key never reaches the browser, the HTML, or any log
- Start and Stop controls, call id and status shown, key never shown
- clearly labelled a **billable Retell sandbox call**
- server shuts down after the sandbox

### The fallback, and what it does not prove

If the isolated client cannot be built, the resources can be created via the API
and the conversation held using **Retell's dashboard Test control** on the newly
created temporary agent.

**That is a weaker proof and must not be reported as equivalent.** The dashboard
creates its own web call through its own path. It would demonstrate that the
*agent, LLM and knowledge base* are correct and that the voice works — it would
demonstrate **nothing** about AIDA's `create-web-call` request.

| Proof | Established by |
|---|---|
| Agent / LLM / KB provisioning is correct | the API run, either way |
| `POST /v2/create-web-call` is correct | **only** the isolated client path |
| Human audio quality and voice choice | either path |

## Manifest

Written to the OS temp directory (`aida-retell-sandbox/` under `os.tmpdir()`),
deliberately **outside the repository** so it cannot be committed. The path is
printed.

Contains: timestamps, resource ids, names, versions, call id and status,
per-step durations, knowledge-base processing duration, validation results and
cleanup state.

Contains **no** API key, **no** access token, **no** transcript, **no** recording
URL and no customer information. `buildManifest` scans its own output for
forbidden keys and **throws rather than writing a manifest that would leak one**.

## Cleanup

Automatic after validation unless resources are deliberately kept. Order is
dependency-safe: **agent → response engine → knowledge base** (deleting an
engine an agent still points at is the kind of thing a provider may reject).

Idempotent. Retell returns **422** — not 404 — for a missing asset
("Cannot find requested asset under given api key"), so both are treated as
already-deleted.

**There is no documented delete-call endpoint.** The web-call record stays in the
dashboard, and the script says so rather than implying it was removed.

On partial failure the script prints every remaining provider id, preserves the
manifest, gives the exact retry command, and **exits non-zero**.

## Expected cost

| Action | Cost |
|---|---|
| knowledge base | small / storage |
| LLM + agent creation | typically free |
| **one web call** | **per-minute — the real cost** |
| phone number | **none — none is bought** |

Keep the call short. A minute proves the contract.

## Remaining unknowns

Still not known, and only a real run will tell:

1. Whether the multipart encoding is accepted verbatim.
2. Actual knowledge-base processing time.
3. Whether `en-AU` is honoured or silently coerced — the agent verification
   reports a language mismatch rather than failing, precisely so this is
   observable rather than fatal.
4. Whether the configured custom voice id is valid for this account.
5. Whether `{{variable}}` placeholders resolve as documented.
6. Real error and rate-limit shapes.
7. Whether `delete-retell-llm` genuinely removes all versions as documented.

---

# M7B review corrections (2026-08-01)

Two review items were resolved before this work was committed.

## 1. No SDK is required to run the sandbox

An earlier M7B completion report claimed:

> "`retell-sdk` and `retell-client-js-sdk` are both absent, so the live path is
> unrunnable rather than merely gated."

**That was wrong, and it contradicted a decision M3 had already made and
documented.** The server-side adapter uses **Node's built-in `fetch`**, injected
as `fetchImpl`. The official `retell-sdk` is an `optionalDependency` used for
**webhook signature verification only** — and this sandbox configures no webhook,
so it is not involved at all.

| Path | SDK needed? |
|---|---|
| Sandbox server-side calls (KB, LLM, agent, web call, deletes) | **No.** Node 18+ native `fetch` |
| Webhook signature verification | Yes — `retell-sdk`, needs Node 20+. **Not used by the sandbox** |
| Browser client (Proof C below) | Yes — `retell-client-js-sdk`, outside this repo |

### The bug that claim was hiding

The adapter is deliberately **inert without an injected transport**: it returns
`provider_misconfigured` rather than reaching the network. The first version of
`scripts/retell-web-sandbox.js` built the adapter **without** `fetchImpl`, so
`--execute` would have failed on its very first request with
"no HTTP transport is configured" — the sandbox could never have worked.

Fixed: the script now injects `globalThis.fetch`, and refuses with a clear
message on a runtime older than Node 18. A regression test asserts the injection
is present, and another proves a request succeeds through an injected transport
with **no SDK installed**.

## 2. Three separate proofs, and what each one is worth

### Proof A — the create-web-call API path *(this runner, unattended)*

Establishes:

- the real agent id was accepted
- `POST /v2/create-web-call` was accepted
- a call id was returned
- an access token was returned — **never logged, never written to the manifest**
- the call is associated with the intended agent
- the call type is `web_call`
- dynamic variables were accepted in the request

The access token stays secret. The runner never describes this as a
conversation, because none happened.

**About the later call status.** No browser joins during an unattended run, so
the ~30-second token window passes unused and the call moves to
`not_connected`, `error` or `ended`. That is the **documented consequence of an
unattended test, not a provider-contract failure**, and it does not retract the
issuance proof already established. `classifyLaterCallStatus()` says exactly
that, and a test asserts an unjoined status is never reported as audio success.

A genuine creation error, a mismatched agent, a missing call id, a missing
access token, a wrong call type or a malformed response all still **fail**.

### Proof B — human audio and agent behaviour *(Retell's dashboard)*

Using the dashboard **Test** control on the API-created temporary agent proves:

- the selected custom voice works
- the configured language is accepted in practice
- the microphone/audio session works
- the LLM responds
- the knowledge base influences responses
- the fictional locksmith scenario behaves appropriately

It proves **nothing** about AIDA's `create-web-call` path, AIDA's access-token
handoff, AIDA's browser SDK integration, or AIDA's local browser client — the
dashboard creates its own call through its own path.

### Proof C — AIDA's complete browser flow *(later, not attempted)*

An isolated client using the official browser SDK would prove:

- the token is minted at click time
- the server-to-browser handoff works
- the browser joins inside the token window
- `startCall` succeeds
- microphone audio is transmitted
- `stopCall` succeeds
- AIDA's create-web-call and browser paths work as **one flow**

**Proof A + Proof B is NOT Proof C.** The runner carries this warning in its own
output so no report can quietly overstate what happened.

## 3. Runner success semantics

An unattended run succeeds when all of these hold, and nothing more is demanded:

1. knowledge base created
2. knowledge base reached `complete`
3. LLM created with the actual knowledge-base id
4. agent created with the actual LLM id
5. agent retrieved and verified
6. web call created
7. call id and agent association verified
8. access token received but not exposed
9. manifest written without secrets
10. cleanup or deliberate retention handled

The runner does **not** wait for `ongoing`, `ended`, a transcript or post-call
analysis. None of those can arrive without a browser, and waiting for them would
turn a successful API proof into a timeout.

## 4. Standing constraints

- No telephone-call gate is enabled; `RETELL_LIVE_CALLS_ENABLED` stays false and
  the sandbox refuses to run if it is true.
- No phone number is required, bought, imported or bound.
- No `ANTHROPIC_API_KEY` is required.
- No real customer data is used — the demonstration business is fictional.
- The custom voice id is read from `RETELL_DEFAULT_VOICE_ID` and appears nowhere
  in the repository.
