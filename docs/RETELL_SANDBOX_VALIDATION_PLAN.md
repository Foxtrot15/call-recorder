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
9. **Speak a fictional locksmith scenario**, exercising all **three** service-area
   states — a covered suburb, an explicitly declined suburb, and a suburb on
   **no list at all**. _(Updated 2026-08-03, M7I: this step previously said "one
   in-area suburb and one out-of-area suburb". That two-state framing is the
   defect itself — the first live call refused a caller in Springvale, a suburb
   nobody had classified, because unknown had been folded into out-of-area. An
   unknown suburb must produce an apology, an admission of uncertainty, details
   taken and a promise that the locksmith will confirm — never a refusal.)_
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

---

# M7C — AIDA browser web-call proof (Proof C integration)

**Status: BUILT, NOT EXECUTED.** No `RETELL_API_KEY` exists in this environment,
so no Retell request was made, no resource created, and no call placed.
**Proof C remains unexecuted.**

## The three proofs, and why they are not interchangeable

| | What it proves | Status |
|---|---|---|
| **Proof A** | AIDA's backend creates a Retell web call and receives a valid call id and access token | **Unexecuted** (built in M7B) |
| **Proof B** | The configured agent can speak, listen, use the LLM and use the knowledge base — via Retell's **dashboard** | **Unexecuted** |
| **Proof C** | AIDA's **own browser** receives the backend-issued token and completes a voice session through AIDA's integration | **Unexecuted** (built in M7C) |

**A + B is not C.** The dashboard creates its own web call through its own path;
it exercises none of AIDA's token issuance, handoff or browser integration.
Proof C is the only one that tests them as a single flow.

## What M7C built

`src/services/retell-browser-harness.js` — a standalone loopback server and a
single self-contained page.

### Architecture

```
browser (localhost)                 harness (127.0.0.1, one run)        Retell
  │                                        │                              │
  │  GET /            ── page, no call ──▶ │                              │
  │  ◀── HTML + SDK import ───────────────  │                              │
  │                                        │                              │
  │  [operator clicks Start]               │                              │
  │  POST /api/web-call ──────────────────▶│                              │
  │       x-aida-sandbox-key               │  createSandboxWebCall()       │
  │                                        │  → shared adapter (fetch) ──▶ │
  │                                        │  ◀── call_id + access_token ──│
  │  ◀── {callId, agentId, callType,       │                              │
  │       accessToken, tokenWindowSeconds} │                              │
  │                                        │                              │
  │  RetellWebClient.startCall({token}) ─────────────────────────────────▶│
  │  ◀────────────────── two-way audio ───────────────────────────────────│
```

**It is not a route in `src/server.js`.** Mounting it there would create a
production route defended only by a flag, and "the flag was off" is weaker than
"the code is not deployed". This binds to `127.0.0.1`, lives for one run, and is
started only by the sandbox script.

### The 30-second window shapes the whole design

A web-call access token is invalidated ~30 seconds after creation
(`docs.retellai.com/deploy/web-call`, reviewed 2026-08-01). So the call is
**created by the click**, not during provisioning: `--browser` tells the runner
to provision the agent and stop, and the harness mints the call when the browser
asks. Minting it earlier and hoping someone opens a browser in time is a race
that cannot be won.

### Browser SDK

- **Package:** `retell-client-js-sdk` (official)
- **Where:** a `<script type="module">` import in the served page **only**
- **Why browser-only:** joining a web call needs microphone capture and a WebRTC
  session — things that exist only in a browser. The server never joins a call;
  it only creates one, and that is plain REST.
- **How it consumes the token:** `client.startCall({ accessToken })`, then
  `client.stopCall()`.
- **Not installed:** loaded from a pinned ESM CDN specifier, so
  `package.json`/`package-lock.json` are untouched. `--sdk <specifier>` overrides
  it, and an offline alternative is an isolated `npm install` **outside** the
  repository.
- **Browser constraints found:** microphone access requires a secure context
  (`localhost` qualifies); the browser prompts for permission on first use; audio
  playback may need a user gesture — which the Start button provides.

A test asserts **no** module under `src/services`, `src/config`, `src/routes` or
`scripts` imports the browser SDK, and that the domain layer contains no browser
concepts (`RetellWebClient`, `startCall(`, `navigator.mediaDevices`).

### Endpoint and security controls

| Control | Behaviour |
|---|---|
| Binding | `127.0.0.1` only — never a configurable interface |
| Page load | `GET /` creates **nothing** |
| `GET /api/web-call` | **405** — a prefetch or crawler cannot spend money |
| Auth | `x-aida-sandbox-key`, constant-time compared |
| Key delivery | URL **fragment**, which browsers never send to a server; removed from the address bar on load |
| Rate | **one call per run**; a second POST is 429 |
| Trigger | explicit button click only |
| Lifetime | closes after the run; 15-minute hard ceiling |
| Labelling | the page states in a banner that it is an internal sandbox placing a real billable call |

### Token handling

- Returned **only** in the response to the authenticated initiating POST
- **Never** logged — the harness logs the call id and agent id, never the token
- **Never** persisted — no manifest field, no database, no file
- **Never** in a URL, and never in the HTML source
- **Never** in an error report — displayed errors scrub anything token-shaped
- Cleared in the page (`token = null`) whether the call connected or failed
- The adapter exposes it through a **one-shot reader**: `takeAccessToken()`
  returns it once then forgets it, so `JSON.stringify(result)` cannot serialise
  it and a second reader gets `null`

### Dynamic variables

Built through the **shared runtime path** — `buildInboundCallVariables()` from
`services/retell-dynamic-variables.js`, the same function the production inbound
webhook would call. No parallel test-only object.

Values used (all fictional, all strings, all supplied **per call** rather than
baked into the agent's defaults):

| Variable | Value |
|---|---|
| `current_transfer_number` | an ACMA fictitious number (reserved range, never allocated) |
| `current_business_status` | `open` |
| `on_call_state` | `demo_on_call` |
| `call_kind` | `residential_lockout` |

A test asserts every key is allow-listed **and** appears in `RUNTIME_ONLY_KEYS`,
which is what proves the transfer number is not baked into the provisioned
agent.

### Browser states

`idle → requesting call from AIDA… → connecting… → connected (microphone live)
→ connected (agent ready) → agent speaking ⇄ listening → disconnecting… →
ended`, plus `error` and `failed`. Driven by the documented SDK events:
`call_started`, `call_ready`, `agent_start_talking`, `agent_stop_talking`,
`call_ended`, `error`.

## Two defects M7C found in the M7B work

Both were invisible to a green suite, and both had the same root cause: **the
test fakes were richer than the real provider boundary.**

1. **The access token never reached callers.** The sandbox read
   `callResponse.raw.access_token`. The live adapter has no `raw` — only the
   hand-written fakes did. Against a real account the token would always have
   been `undefined`, and `verify_web_call` would have failed. Fixed with the
   one-shot reader.

2. **A web call was recorded under its agent's id.** `extractResource` scanned
   `agent_id` before `call_id`, and a call response carries both. So
   `resource.id` was the agent. Fixed by resolving call operations first.

The mock adapter in `voice-platform-port.js` now mirrors the live result shape
exactly, so this class of bug cannot recur silently.

## How to execute Proof C

```
RETELL_ENABLED=true RETELL_LIVE_WRITES_ENABLED=true RETELL_DRY_RUN=false \
RETELL_SANDBOX_WEB_CALL_ENABLED=true RETELL_SANDBOX_EXECUTE=true \
RETELL_ALLOWED_TAG=dev RETELL_API_KEY=... RETELL_DEFAULT_VOICE_ID=... \
node scripts/retell-web-sandbox.js --execute --browser
```

It provisions the knowledge base, LLM and agent, prints a loopback URL
containing the harness key, and waits. Open the URL, press **Start test call**,
grant microphone access, speak, then press **Disconnect** and `Ctrl+C`.
Resources are cleaned up automatically.

### What to check while connected

- two-way audio (you hear the agent; it responds to you)
- the agent uses the **configured voice** and **language**
- **knowledge-base influence** — ask whether they do automotive key replacement;
  the demonstration knowledge says they do not
- **dynamic-variable influence** — ask where the locksmith is coming from, or
  what happens next; the per-call variables should shape the answer
- it never quotes a price, never promises an arrival time, and admits to being
  automated

Record those observations yourself: **the script can confirm the backend issued
a call to the browser, but only the person at the browser can confirm that audio
worked.**

---

# M7D — Live Retell validation (EXECUTED 2026-08-02)

**Proof A and Proof C both established against the real provider.** Proof B was
not performed. Four provider or integration mismatches were found and fixed;
every one of them had been invisible to a fully green test suite.

## What was executed

| Proof | Result |
|---|---|
| **A — backend API issuance** | **PASSED, live.** Knowledge base, response engine and agent created; agent retrieved and verified; web call created with a valid call id and access token, bound to the intended agent |
| **B — Retell dashboard behaviour** | **NOT PERFORMED.** The dashboard Test control was never used; it was unnecessary once Proof C succeeded through AIDA's own path |
| **C — AIDA browser flow** | **PASSED, live.** AIDA's backend issued the token, AIDA's own harness page consumed it, the browser joined the intended agent and held a real two-way voice conversation |

Proof C is the one that matters, and it did not depend on Proof B.

## The four mismatches

### 1. `knowledge_base_texts` must be a JSON array in ONE field

M7B sent indexed sub-fields (`knowledge_base_texts[0][title]`) — the
conventional multipart encoding for an array of objects. The live API rejects
it. Sending one item per repeated field returns the decisive error:

    {"status":"error","message":"not an array"}

so the server JSON-parses that field. A single JSON-encoded array returns 201.

### 2. The adapter never put the multipart bytes on the wire

`buildRequest` hard-coded `Content-Type: application/json` and
`JSON.stringify(body)`, so the multipart request was stringified into a JSON
string. The `contentType` declared on each endpoint was decorative because
nothing read it. Fixed; JSON endpoints are unaffected.

### 3. Agent verification read a `raw` body that does not exist

Verification read `response.raw`, which only the hand-written test fakes
returned. Every check reported `(none)` against a correctly-created agent. The
adapter now surfaces named verification fields on its closed resource shape —
`responseEngineId`, `voiceId`, `language`, `webhookUrl` — rather than leaking a
provider body.

### 4. The sandbox prompt referenced an undeliverable variable

The prompt said *"The caller is in {{caller_suburb}}"*. `caller_suburb` is not in
`DYNAMIC_VARIABLE_ALLOWLIST` and was never sent, and an unsupplied variable
**renders literally** — so the live agent was reading that placeholder as text.
Replaced with variables that are genuinely delivered per call.

### The common cause

All four came from the same place: **the test fakes were richer than the real
provider boundary.** A fake accepts whatever shape it is handed, so it cannot
catch a wire-format error — it conceals one. The port's mock adapter now mirrors
the live result shape exactly.

## Manual browser checks — confirmed by the operator

| # | Check | Result |
|---|---|---|
| 1 | Two-way audio | **Pass** |
| 2 | Expected custom voice and `en-AU` | **Pass** |
| 3 | Knowledge-base influence — "do you do automotive key replacement?" answered **no**, a fact present only in the KB | **Pass** |
| 4 | Dynamic-variable influence — the per-call transfer number was used | **Pass** (see the open finding below) |
| 5 | Safety rules — refused to quote a price and refused to explain lock-picking | **Pass** |
| 6 | Clean disconnect | **Pass** |

The provider also accepted `en-AU` and the configured custom voice id, both of
which M7B had listed as unvalidated assumptions.

## Open findings (not fixed here — not provider mismatches)

**Transfer numbers are read aloud in E.164.** The runtime dynamic variable
carries `+61491570006`, so the agent says *"plus six one, four nine one…"* — the
operator reported the number "sounded a bit weird". An Australian caller expects
*"zero four nine one…"*.

The product already knows how to do this: `validateChange` produces a
`readBackText` that converts `+61` → `0` and spaces the digits for
change-request read-backs. That conversion exists on the configuration path but
not on the runtime path. **A caller hearing their locksmith's callback number
misread is a real defect**, and it should be fixed before any receptionist goes
live — but it is a product issue, not a provider incompatibility, so it was
recorded rather than folded into this milestone.

**One unexplained mid-sentence audio dropout.** The operator reported the agent
cutting out once mid-sentence. Not diagnosed. The most likely cause is the local
connection — it dropped earlier in the same session, which is also what made a
cleanup pass fail — but this is **not** established, and it should not be
written off until it has been watched for on a later run.

## Resources created and deleted

| Resource | Purpose | State |
|---|---|---|
| 2 × probe knowledge bases | diagnosing the multipart encoding | **deleted** |
| 3 × sandbox sets (KB + LLM + agent) | the three validation runs | **all deleted** |
| 2 × web calls | Proof C conversations | cannot be deleted — Retell documents no delete-call endpoint; the records remain in the dashboard |

The account was verified clean afterwards: zero knowledge bases, and the only
remaining agent is the pre-existing **Niche Drops Lead Intake Agent**, which was
never touched.

**One cleanup pass failed** with `provider_unreachable` on all three deletes
when the operator's connection dropped. The script behaved correctly: it
reported the failure, printed the resource ids and exited non-zero rather than
claiming success. The resources were then deleted directly using those ids.

## What remains unvalidated

- **Proof B** — the dashboard path was never exercised.
- **Inbound telephone calls** — no number was bought, imported or bound.
- **The inbound webhook** — no webhook was configured, so per-call variable
  delivery *for a phone call* is still unproven. Proof C delivered variables
  through `create-web-call`, which is a different mechanism.
- **Post-call analysis** — `post_call_analysis_data` was configured on the agent
  but no analysis result was retrieved or inspected.
- **Provider error and rate-limit shapes** beyond the 400/422/500 responses seen
  during diagnosis.

---

# M7E — the two open findings (2026-08-02, NO live execution)

M7E addressed both findings above. **It made no external request**, created,
updated or deleted no Retell resource, created no call, bought or bound no
number, enabled no webhook, applied no SQL, connected to no database, deployed
nothing and pushed nothing. Full detail:
[RETELL_CALL_DIAGNOSTICS_SPEC.md](RETELL_CALL_DIAGNOSTICS_SPEC.md).

## Finding 1 — transfer numbers read aloud in E.164: **FIXED**

The runtime path had no spoken form to read, so it read the canonical one. The
conversion existed only on the configuration path.

`src/services/au-phone-speech.js` now derives both a display form
(`0491 570 006`) and a spoken form (`zero four nine one, five seven zero, zero zero
six`) from the canonical E.164 value, and **both the change-request read-back and
the receptionist runtime use it**. Storage is unchanged: every number is still
E.164, and the presentations are derived at the point of use and never stored, so
a corrected digit cannot leave a stale spoken form behind.

The sandbox prompt line that produced the live defect —
`{{current_transfer_number}}`, "read it digit by digit" — now reads
`{{current_transfer_number_spoken}}` verbatim. A regression test compiles a
receptionist whose transfer number is `+61491234567` and asserts that string
appears nowhere in the prompt, the begin message, the knowledge base or the
compiled spec.

**Not yet confirmed aloud.** The fix is proven in tests, not in a caller's ear.
It should be heard on a live call before any receptionist takes real traffic.

## Finding 2 — the mid-sentence dropout

> **Superseded by M7E-LV (2026-08-02).** The retained call was read back from
> the provider and several statements below turned out to be wrong. Corrections
> are marked inline; the full sanitised result is in
> [RETELL_LIVE_DIAGNOSTICS_VALIDATION.md](RETELL_LIVE_DIAGNOSTICS_VALIDATION.md).

M7E built the instrument, not the answer, and does not claim otherwise.

`src/services/retell-call-diagnostics.js` turns a Get Call response into evidence
tagged `provider_classified`, `observed` or `unproven`. **A cause is assigned only
from a documented provider classification**; there is no path that promotes an
observation to a cause. An incomplete final sentence does not prove a network
failure, and audio stopping does not prove a Retell fault.

~~For the M7D shape specifically — ended, connected, final agent turn visibly
unfinished, no `disconnection_reason` at all~~

**CORRECTED.** That description of the retained call was a guess, and it was
wrong on both counts. The provider record shows the call **ended cleanly on a
`user_hangup`**, with a final agent turn that **does** end in terminal
punctuation, after nearly 108 seconds and 18 turns. There was no missing
disconnection reason and no unfinished final turn.

The truncation the operator heard was **mid-call, not at the end** — two agent
turns around the 25-second mark stop without terminal punctuation, overlapping
the caller's speech. Why they are unfinished remains unestablished: no provider
field reports a truncation that does not end the call.

~~The operator's connection dropped earlier in that session, which is what made a
cleanup pass fail. That remains circumstantial and unproven.~~

**Still unproven, and now less likely to be the whole story**: the call ran to
its natural end with healthy latency throughout (no AIDA heuristic exceeded), so
whatever happened at ~25 seconds did not degrade the remaining 80 seconds.

The read **has been performed** — see the M7E-LV document. It needed
`RETELL_DIAGNOSTICS_ENABLED=true` and `RETELL_DIAGNOSTICS_EXECUTE=true`, and it
ran with `RETELL_LIVE_WRITES_ENABLED=false`, confirming in practice that reading
a call back requires no permission to create agents.

~~Note that Retell's retention of a call from 2026-08-02 is not something this
milestone verified; the read may return nothing.~~ **Retention confirmed**: the
call was still retrievable in full, including transcript, latency and analysis.

The call id is deliberately not recorded in this repository.

## Post-call analysis — ~~implemented, not run~~ **retrieved live**

`src/services/retell-call-analysis.js` distinguishes `ready`, `pending`,
`not_applicable` (the call never connected, so polling would never end),
`unknown` and `provider_error`, and validates built-in and custom fields against
the schema AIDA asked for. Polling is bounded by construction.

**M7E-LV retrieved a real analysis object.** It came back `ready` on the first
read — no polling was needed — with `call_summary`, `user_sentiment`,
`call_successful` and `in_voicemail` all populated and two custom fields
returned. The built-in field names, types and the `user_sentiment` capitalisation
all matched the documented contract.
