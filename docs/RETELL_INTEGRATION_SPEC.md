# AIDA — Retell provider and provisioning foundation (M3)

**Status:** built, dormant, **not deployed, no SQL applied, no external resource created.**
**Branch:** `feature/locksmith-pilot-m3-retell-foundation`
**Flags:** `RETELL_ENABLED`, `RETELL_WEBHOOK_ENABLED`, `RETELL_LIVE_WRITES_ENABLED`, `RETELL_LIVE_CALLS_ENABLED` — all unset everywhere; `RETELL_DRY_RUN` defaults on.
**Related:** [LOCKSMITH_ONBOARDING_SPEC.md](LOCKSMITH_ONBOARDING_SPEC.md) (M2) · [LOCKSMITH_PILOT_SPEC.md](LOCKSMITH_PILOT_SPEC.md) (M1)

---

## 1. What M3 is

A complete but inert provider integration that turns an **approved canonical
locksmith profile** into a **deterministic Retell provisioning plan** — preview,
validate, diff, dry-run, plan, and (when someday permitted) execute idempotently.

**The canonical profile stays the source of truth. Retell is an execution
provider, not the owner of the locksmith's configuration.** Nothing in the
domain layer imports Retell; everything goes through a provider-neutral port.

**Nothing external was created, called or mutated. No API request was made to
Retell at any point.**

## 2. Official documentation reviewed

Reviewed **2026-08-01**, official Retell sources only:

| Page | Used for |
|---|---|
| `docs.retellai.com/api-references/create-agent` | agent fields, `response_engine`, `voice_id`, `language`, `webhook_url`, `post_call_analysis_data` shape, `version`/`base_version`/`assigned_tags`, timing bounds, `{{variable}}` syntax |
| `docs.retellai.com/api-references/create-retell-llm` | `general_prompt`, `general_tools`, `states`, `begin_message`, `knowledge_base_ids`, `default_dynamic_variables`, `llm_id`, `version` |
| `docs.retellai.com/api-references/create-conversation-flow` | `nodes`, `start_speaker`, `model_choice`, `global_prompt`, `conversation_flow_id` (recorded as an alternative engine type; not used) |
| `docs.retellai.com/api-references/create-knowledge-base` | multipart contract, `knowledge_base_name` (<40 chars), `knowledge_base_texts`, `status` enum |
| `docs.retellai.com/api-references/create-phone-call` | `/v2/create-phone-call`, `from_number`, `to_number`, `override_agent_id`, `override_agent_version`, `metadata`, `retell_llm_dynamic_variables`, `call_id`, `call_status` |
| `docs.retellai.com/api-references/update-phone-number` | binding via `inbound_agents`/`outbound_agents` weight objects, `inbound_webhook_url` |
| `docs.retellai.com/features/webhook` | the eight voice event types, `{ event, call }` envelope, `call_ended` field set, **3 retries / 10-second timeout**, 2xx expected with no body |
| `docs.retellai.com/features/secure-webhook` | `X-Retell-Signature`, `v={ts},d={hex}`, HMAC-SHA256 over the raw body, 5-minute replay window, the official `Retell.verify(rawBody, apiKey, signature)` sample and `express.raw` requirement |
| `github.com/RetellAI/retell-typescript-sdk` (README) | **Node 20 LTS or later**, `new Retell({ apiKey })`, error classes (`BadRequestError`… `RateLimitError`, `APIConnectionError`) exposing `status`/`name`/`headers`, `maxRetries` default 2, 1-minute default timeout |
| npm registry metadata for `retell-sdk` | current version **5.53.0**, Apache-2.0 |

### API uncertainties (recorded, not guessed)

1. **Signature construction.** The docs state the ingredients (raw body +
   timestamp, HMAC-SHA256, API key as secret) but not the exact byte-level
   concatenation order. **We therefore do not reimplement it** — see §4.
2. **Rate limits / concurrency.** No official published limit page was found
   (`/api-references/errors` 404s). The port treats 429 as retryable and the
   adapter caps retries; actual limits must be confirmed before bulk use.
3. **Idempotency keys.** Retell does not document request idempotency. We send
   `X-Aida-Idempotency-Key` for provider-side correlation only and rely on **our
   own registry** for real idempotency.
4. **Test-case APIs.** No current official test-case API was confirmed, so the
   generated receptionist test plan (M4 Part 21) stays local and provider-neutral.
5. **`en-AU` language support.** Documented as "a locale like `en-US`"; the
   supported locale list must be confirmed in the dashboard before first live
   provisioning. Default is `en-AU` with this caveat recorded.
6. **Voice ids** are account-specific; no default is invented (§3).

### Deliberately abstracted because provider behaviour may change

The response-engine type, per-endpoint API versions, phone-number binding shape,
analysis-schema location (Retell folds it into the agent), and the absence of a
delete/archive endpoint are all isolated in `services/retell-adapter.js`. The
domain speaks resource **purposes**, not Retell nouns.

## 3. Dependency decision

**`retell-sdk` is declared as an `optionalDependency` at exactly `5.53.0` and is
NOT installed by this work. `package-lock.json` was not staged, regenerated or
touched.**

Two transports, chosen separately and for different reasons:

- **Writes use native `fetch`.** The SDK requires **Node 20+**; this repo
  declares `"node": ">=18"`. Silently raising the floor for every deploy — to
  gain a client for endpoints whose REST contract is fully published — is a bad
  trade. `fetch` has been stable since Node 18, and a mistake in a write path
  produces a 4xx, not a security failure.
- **Signature verification delegates to the SDK.** A mistaken verifier either
  rejects every genuine event (an outage) or accepts a forged one. Because the
  official docs express verification *only* through `Retell.verify`, and the
  byte-level construction is not published unambiguously,
  `services/retell-webhook-verify.js` **calls the official helper via a lazy
  require and fails closed (`verifier_unavailable`) when the SDK is absent.** A
  test asserts the module contains no `createHmac` — it must never improvise.

**Founder decision required:** installing the SDK means adopting Node 20+. Until
then the webhook cannot verify, which is safe because it is dormant.

## 4. Configuration (`src/config/retell.js`)

Four independent danger gates plus one inverted gate, all strict-parse:

| Variable | Default | Enables |
|---|---|---|
| `RETELL_ENABLED` | off | the integration exists at all |
| `RETELL_WEBHOOK_ENABLED` | off | inbound provider events are processed |
| `RETELL_LIVE_WRITES_ENABLED` | off | resources may be created/updated at Retell |
| `RETELL_LIVE_CALLS_ENABLED` | off | phone calls may be placed (**spends money**) |
| `RETELL_DRY_RUN` | **on** | inverted — only `"false"` leaves dry-run |

They are separate rather than one "production" switch because enabling a
*preview* must not grant permission to create agents, and creating agents must
not grant permission to dial a customer. A misconfiguration should cost a 500,
never a phone call.

**M7E added a read-only gate**, weaker than all of the above and narrower than
any of them:

| Variable | Default | Enables |
|---|---|---|
| `RETELL_DIAGNOSTICS_ENABLED` | off | reading one finished call back is possible |
| `RETELL_DIAGNOSTICS_EXECUTE` | off | and may actually contact Retell |
| `RETELL_DIAGNOSTICS_INCLUDE_CONTENT` | off | transcript **text** may be shown (also needs a CLI flag) |

`canReadDiagnostics()` authorises exactly one documented endpoint —
`GET /v2/get-call/{call_id}` — and requires `NODE_ENV` to not be production and
`RETELL_ALLOWED_TAG=dev`. It deliberately requires **neither**
`RETELL_LIVE_WRITES_ENABLED` nor `RETELL_LIVE_CALLS_ENABLED` nor
`RETELL_DRY_RUN=false`: asking "why did that call drop?" must never require
permission to create agents, and dry-run is a promise not to *change* anything,
which a read already keeps. See
[RETELL_CALL_DIAGNOSTICS_SPEC.md](RETELL_CALL_DIAGNOSTICS_SPEC.md).

Also modelled: API key, base URL (https origin only, no path/query/fragment),
timeout, max retries, webhook payload limit, default voice id (**no default —
missing blocks live writes**), language, response-engine type, both template
versions, outbound/inbound number placeholders (**never defaulted**), public
webhook base URL, environment tag, recording default (**off**, pending legal
wording), transcript retention, and per-endpoint API versions.

**Never logged:** API keys, full phone numbers, full transcripts, raw signatures,
client configuration. `redactSecrets()` is the shared scrubber; `maskPhone()`
leaves only the last two digits; `toSafeConfigSummary()` reports key *presence*.

## 5. Provider port and adapters (`src/services/voice-platform-port.js`)

The domain talks to the port; only `retell-adapter.js` knows Retell.

| Adapter | Behaviour |
|---|---|
| **disabled** | every operation refuses with a reason. The default and the production state. |
| **mock** | deterministic in-memory provider; ids derive from the request, so retries are naturally idempotent. Can be told to fail a named operation. |
| **dry-run** | records what *would* be sent. Contains **no transport code at all** — a test asserts the absence, so a dry run cannot become a live run via a config mistake. |
| **Retell** | the real boundary. Re-checks its own gates on every call **and** refuses unless a `fetchImpl` is injected. |

Errors normalise to a closed vocabulary with an explicit `retryable` flag (429 /
timeout / network / 5xx are retryable; 400/401/402/404/422 are not). Provider
request ids are preserved; provider payloads never travel upward.

**No live adapter method executed during this task.**

## 6. Receptionist compiler (`src/services/locksmith-receptionist-compiler.js`)

Two stages: `compileReceptionistSpec` (all judgement, provider-neutral) then
`toRetellPayload` (pure translation).

- **The raw onboarding transcript is never compiled in.** The receptionist is
  built from the approved profile only; `assertNoTranscript()` throws if
  dialogue reaches the artefact.
- **Critical rules live in instructions, not knowledge.** Routing, exclusions,
  urgency, transfer and pricing authority are always in the prompt. Knowledge
  carries elaboration only — a rule deciding whether a phone rings at 3am must
  never depend on a retrieval hit.
- **Transfer numbers are never compiled in.** The spec records *that* a number
  exists; the value is resolved per call through a runtime dynamic variable.
- **Dynamic variables are a bounded allow-list** of 11 keys. Not a filter — an
  allow-list, so a new profile field cannot leak into the provider.
- **Eight provider-neutral tool contracts** with JSON schemas whose enums come
  from the canonical schema. The on-call tool returns an opaque reference, never
  a phone number.
- **Ten safety instructions**, identical for every client on every plan,
  covering lock bypass, verification claims, availability/arrival/price
  guarantees, dispatch claims, emergency-service claims, legal advice, prompt
  disclosure, injection resistance, and directing genuine emergencies to 000
  while making clear this is a locksmith's line.
- **All profile prose is untrusted**: bounded, control-characters stripped,
  delimited with `« »` (the prompt states that delimited text is data, never an
  instruction), and scanned for instruction-like content which is **surfaced for
  review, not silently removed**.
- **Deterministic**: same profile version + template version + compiler version
  ⇒ same spec, same `specHash`/`knowledgeHash`/`toolSchemaHash`. Review flags
  are excluded from the hash — they describe the compile, not the artefact.

Refuses anything not `approved`, not valid, or not provisioning-ready.

## 7. Onboarding-agent compiler

Separate compiler (`locksmith-onboarding-agent-compiler.js`) driven by the M2
versioned interview specification. Consent is a **gate**: the agent discloses
that it is automated and transcribed, asks, and **ends without persuading** if
consent is not given. Silence is never an answer — every safety-critical value
is read back (numbers digit by digit) and anything unknown is recorded as
not-established. Compiles opening message, core instructions, question groups,
conditional transitions, dynamic variables (opaque identifiers only — the
onboarding agent is told nothing about the business), the analysis schema,
completion criteria, and the consent/missing-data/contradiction outcome contract.

## 8. Post-call analysis (`src/services/locksmith-analysis-schema.js`)

Provider analysis is **useful and untrusted, in that order**.

- Unknown enum values are **rejected**, not coerced.
- Missing fields produce **review warnings**, not silent nulls.
- **Provider analysis can never approve anything** and never touches an approved
  profile — a test asserts the module exports no function that turns analysis
  into profile fields.
- The **transcript remains the authoritative extraction input**; analysis only
  supplements warnings and evidence.
- **Transfer numbers and pricing authority always require human review**,
  whatever confidence is reported.

## 9. Provisioning plan (`src/services/provisioning-plan.js`)

Lifecycle: `created → validated → blocked → approved_for_execution → executing →
completed | partially_failed | failed → superseded | rolled_back`.

Guarantees, each a test: a draft cannot produce an executable plan; a non-ready
profile is blocked with named reasons; every plan points at one immutable
approved version; identical inputs produce an identical `planHash`; existing
matching resources become **no-ops**; a plan goes stale the moment the approved
version moves; idempotency keys are stable so a partial failure **resumes**
rather than duplicating; provider ids are stored **only** after a confirmed
success; execution halts at the first non-retryable failure rather than creating
orphans.

`evaluateExecutionGate` requires *simultaneously*: integration enabled, live
writes enabled, dry-run off, valid API key, authorised operator, plan approved
and current, non-stale profile, explicit request. **Under the shipped
configuration it refuses with four reasons.**

Rollback is planned, never executed: Retell exposes no delete endpoint, so
rollback means superseding registry entries and re-planning from the previous
approved version.

## 10. Provider-resource registry

`provider_resources` records what AIDA believes exists at a provider. **Never
stores an API key** (no column exists). At most one active resource per
(client, provider, purpose, type) — enforced by a partial unique index.
Superseding is a flag plus a timestamp; history is preserved. Metadata is
redacted and bounded. Provider ids are internal; the founder console masks them
and clients never see them.

## 11. Webhook architecture

Route: `POST /webhooks/retell`, mounted separately from every product route and
dormant unless **both** `RETELL_ENABLED` and `RETELL_WEBHOOK_ENABLED` are `true`.

Order of operations *is* the security model: flag gate → raw body (size-capped
via `express.raw`) → content type → **signature verification** → parse →
envelope validation → fingerprint/idempotency → **fast 2xx** → processing
delegated afterwards.

- Missing/malformed/stale/invalid signature → 401. Oversize → 413. Bad content
  type or unparseable body → 400. Disabled or verifier unavailable → 503.
- Retell retries 3× on non-2xx after 10s, so acknowledgement never waits on our
  work; a processor that throws cannot affect the sent response.
- **Idempotency without a provider event id:** Retell's `{ event, call }`
  envelope carries none, so the fingerprint is a SHA-256 over provider + event
  type + call id + a hash of the *meaningful* payload (status, disconnection
  reason, transcript digest, analysis presence). Retries collide; genuine new
  events do not. The fingerprint is globally unique in SQL.
- Only the **eight officially documented voice event types** are known.
  `transcript_updated` is deliberately unmapped (partial mid-call text).
  Unknown events are recorded minimally and ignored with a 2xx.
- **Raw webhook bodies are not stored.** Metadata holds counts, digests and
  flags — `transcript_present`/`transcript_chars` rather than the transcript,
  `recording_present` rather than the URL.
- No unauthenticated debugging endpoint exists.

## 12. Founder provisioning preview

`GET /locksmith-founder/provisioning/:clientId` (operator-only) shows config
flags, approved version, readiness, compiler/template versions, the **compiled
prompt**, knowledge content, tool schemas, dynamic variables, safety and
suspicious-prose warnings, the plan with create/update/no-op/archive counts and
hash, existing resources, and audit history.

Never shown: the API key (presence only), full transfer numbers (masked), raw
provider ids (masked), or unescaped prompt/profile text.

The live-execution control is **hidden unless every gate passes** and carries an
explicit "this would mutate an external provider and may incur charges" warning.
It cannot appear under the shipped configuration. `POST …/dry-run` and
`POST …/mock-execute` (development/test only) exercise the real planning and
registry code against non-network adapters.

## 13. SQL

**`supabase/sql/lpm3_create_retell_provisioning.sql` — REVIEW ONLY, NOT APPLIED.
No database was connected.**

Four additive tables: `provider_resources`, `provisioning_plans`,
`provisioning_actions`, `provider_webhook_events`. RLS enabled at birth on all
four, **no policies** (service-role only). Partial unique indexes enforce
one-active-resource-per-purpose, one-active-plan-per-client, and
one-success-per-idempotency-key. A verification query asserts **no column
anywhere is named like a credential**.

**Application order:** `lpm2_create_locksmith_onboarding.sql` **then**
`lpm3_create_retell_provisioning.sql` (this file references
`locksmith_onboarding_sessions`). Independent of the other pending files.

## 14. External steps still required

1. A Retell account and API key (Railway env only).
2. A **voice id** from the dashboard — no default is invented.
3. Confirm `en-AU` is a supported language value.
4. A public HTTPS webhook base URL.
5. Apply the M2 then M3 SQL.
6. Decide on Node 20+ so the official SDK (and therefore webhook verification)
   can be installed.
7. Confirm published rate limits before any bulk operation.
8. Legal wording for recording/transcription (carried over from M2).

---

# M7B — Contract correction (2026-08-01)

**Documentation review date: 1 August 2026.** Official `docs.retellai.com` only —
no blog posts, community examples, Stack Overflow, or payloads copied from
earlier milestones.

**No sandbox execution was performed. No Retell resource was created. No phone
or web call was placed.** This section records what the documentation says and
what the code now does; it is not evidence that either works against the live
API.

## Pages reviewed

| Page | Used for |
|---|---|
| `/api-references/create-retell-llm` | Response-engine request and response |
| `/api-references/create-agent` | Agent request, response engine, analysis, storage |
| `/api-references/update-phone-number` | Inbound/outbound agent binding |
| `/api-references/create-knowledge-base` | KB transport, fields, status lifecycle |
| `/api-references/add-knowledge-base-sources` | Whether KB update exists |
| `/api-references/create-web-call` | Web-call contract for future validation |
| `/build/dynamic-variables` | Defaults vs per-call variables |
| `/features/inbound-call-webhook` | How inbound calls receive variables |

## Findings: five contract mismatches

M3 and M7A shipped assumptions that the documentation contradicts. Fixture tests
could not have caught any of them — a mock accepts whatever shape it is handed.

### 1. Phone binding used a field that does not exist

`inbound_agent_id` is not a current field. Binding uses **weighted agent
arrays**:

```
PATCH /update-phone-number/{phone_number}
{ "inbound_agents": [ { "agent_id": "...", "agent_version": 3, "weight": 1 } ] }
```

Each `weight` must be `> 0` and `<= 1`, and the weights in an array **must total
exactly 1**. `outbound_agents`, `inbound_sms_agents` and `outbound_sms_agents`
follow the same shape.

**Corrected.** `validateAgentWeights()` enforces the contract before any request
is built, and a binding with invalid weights fails without contacting anything.

### 2. The knowledge base is multipart, not JSON

`POST /create-knowledge-base` is **`multipart/form-data`**. The adapter sent
JSON. `knowledge_base_texts` is an array of `{title, text}` objects, encoded as
indexed fields.

**Corrected** in `src/services/retell-multipart.js`, kept separate from any
transport so the wire format is testable without a network stack — the only way
to gain confidence in an encoding we cannot yet exercise for real.

### 3. There is no knowledge-base update endpoint

The documented surface is create, `add-knowledge-base-sources`, and
delete-source. `PATCH /update-knowledge-base/:id` — which the adapter declared —
does not exist.

**Corrected.** A changed KB is now a **create-and-replace**: `updateOperation` is
`null`, the diff emits a `create` carrying `replacesProviderId`, and the old
resource is superseded in the registry.

### 4. Knowledge-base processing is asynchronous

Creation returns `status: "in_progress"`. States are `in_progress`, `complete`,
`error`, `refreshing_in_progress`. A KB is **not usable until `complete`**.

**Modelled** in `assessKnowledgeBase()`. Attaching an incomplete KB would give an
agent answering callers from a partially-indexed corpus — worse than none,
because it looks like it is working.

### 5. `llm_id` was null, and nothing filled it in

`response_engine` requires `type` and, for `retell-llm`, `llm_id`. The compiler
emitted `llm_id: null` with a comment claiming it would be filled in later.

**Corrected** via the reference-resolution system: the agent carries a token
resolved from the response engine created earlier in the same run. An
unresolvable reference fails before any request; a dry-run placeholder reaching
a live payload fails too.

## Confirmed contracts

**`POST /create-retell-llm`** — `application/json`. `general_prompt`,
`begin_message`, `general_tools`, `states`, `starting_state`,
`default_dynamic_variables`, `knowledge_base_ids` all optional. Returns
`llm_id`, `version` (integer), `is_published`.

> `knowledge_base_ids` belongs on the **LLM**, not the agent. AIDA previously
> created a knowledge base and never attached it to anything. Now attached by
> reference.

**`POST /create-agent`** — `application/json`. Required: `response_engine` and
**`voice_id`**. The compiler previously emitted `voice_id: null` when
unconfigured, producing a request that could only be rejected.
`post_call_analysis_data` belongs on the **agent** (AIDA's placement was already
correct). `data_storage_setting` accepts `everything`,
`everything_except_pii`, `basic_attributes_only` — now driven by the client's
approved privacy decision rather than a deployment default, defaulting to the
stricter `everything_except_pii`.

**`POST /v2/create-web-call`** — `agent_id` required; accepts `agent_version`,
`retell_llm_dynamic_variables`, `metadata`. Returns `access_token`, `call_id`,
`call_status` (`registered`, `not_connected`, `ongoing`, `ended`, `error`).

## Dynamic variables — a design assumption corrected

| Mechanism | Where | Behaviour |
|---|---|---|
| `default_dynamic_variables` | on the Retell LLM | fallback only |
| `retell_llm_dynamic_variables` | create-phone-call / create-web-call | overrides defaults |
| `call_inbound.dynamic_variables` | **inbound webhook response** | the only route for an inbound call |

**All values must be strings.** An unsupplied variable renders as the literal
`{{name}}` in the prompt rather than erroring.

M3 kept transfer numbers out of compiled artefacts and resolved them "at call
time through a dynamic variable" — the right instinct, but the mechanism was
never built, and a *default* is baked in at provisioning time. A locksmith's
on-call number changes; baking it in transfers a 2am emergency to whoever was on
call the day the agent was last built.

`splitDefaultsFromRuntime()` now strips runtime-sensitive keys
(`current_transfer_number`, `current_backup_number`, `current_business_status`,
`on_call_state`, `call_kind`) from the defaults, and
`buildInboundWebhookResponse()` produces the documented `call_inbound` shape.
A test asserts **no phone number appears in any default variable**.

The inbound webhook must answer **2xx within 10 seconds** (3 retries, then
fallback). The builder is pure and does no I/O for that reason.

## Post-call analysis remains untrusted

Provider analysis may never approve a profile, apply a change, replace
deterministic validation, or override client confirmation. Presets are limited to
`call_summary`, `call_successful`, `user_sentiment`; custom items are validated
for type and name.

## Still unvalidated

Everything above is **documentation-derived**. Not yet proven against the live
API: whether the compiled `general_prompt` is accepted at its length; whether
`en-AU` is a supported locale; whether the multipart encoding is accepted
verbatim; whether an inbound webhook actually injects variables end to end;
real KB processing time; and error/rate-limit shapes.

## M7B — sandbox endpoints confirmed (2026-08-01)

Additional pages reviewed for the web-call sandbox:

| Page | Confirmed |
|---|---|
| `/api-references/get-knowledge-base` | `GET /get-knowledge-base/{id}`; status is one of `in_progress`, `complete`, `error`, `refreshing_in_progress` |
| `/api-references/delete-knowledge-base` | `DELETE /delete-knowledge-base/{id}` → 204 |
| `/api-references/delete-retell-llm` | `DELETE /delete-retell-llm/{id}` → 204, **removes all versions** |
| `/api-references/delete-agent` | `DELETE /delete-agent/{id}` → 204 |
| `/api-references/get-agent` | `GET /get-agent/{id}`, optional `version` query; returns `response_engine`, `voice_id`, `language`, `version` |
| `/api-references/create-web-call` | `POST /v2/create-web-call`; `agent_id` required; returns `access_token`, `call_id`, `call_status` |
| `/deploy/web-call` | Browser SDK is `retell-client-js-sdk`; `startCall({ accessToken })` / `stopCall()`; secure context required |

### Corrections to earlier claims

An earlier draft stated Retell exposes **no** delete endpoint for agents or
LLMs, and AIDA's rollback model was written around that. **That was wrong.**
Delete endpoints exist for knowledge bases, LLMs and agents. Rollback by
re-pointing remains a reasonable strategy for production resources, but it is a
choice now rather than a limitation.

There is still **no documented delete-call endpoint**, so a web-call record
cannot be removed.

### Deletion error shape

A missing asset returns **422**, not 404 — the body reads
"Cannot find requested asset under given api key". Cleanup treats both statuses
as already-deleted, which is what makes it idempotent.

### The 30-second access token

A web-call access token is invalidated roughly **30 seconds** after creation.
This is why the sandbox runner does not print it: it could not be pasted into a
browser in time, and printing an unusable secret is all cost and no benefit. A
real browser session must create the web call at the moment the browser is
ready, not in advance.

### Web-call gating

`createWebCall` is guarded by `canWriteLive`, **never** `canPlaceCall`.
`canPlaceCall` demands `RETELL_LIVE_CALLS_ENABLED` and an outbound telephone
number; a web call needs neither, and requiring them would mean enabling real
telephone dialling to test browser audio.

---

# M7E — Get Call, diagnostics and post-call analysis (docs reviewed 2026-08-02)

## Pages reviewed

| Page | Reviewed | Used for |
|---|---|---|
| `docs.retellai.com/api-references/get-call` | 2026-08-02 | the whole call response object |
| `docs.retellai.com/features/webhook` | 2026-08-02 | event names, analysis timing |
| `docs.retellai.com/features/post-call-analysis` | 2026-08-02 | custom analysis categories |

Official documentation only. No blog posts, community examples or copied
payloads. **No API request was made during M7E.**

## The Get Call contract

`GET /v2/get-call/{call_id}` — already the path in `retell-adapter.js`, now
confirmed.

The response is a **discriminated union** of `V2WebCallResponse` and
`V2PhoneCallResponse`, both extending `V2CallBase`.

**Required** (base): `call_id`, `agent_id`, `agent_version`, `call_status`.
**Required** (web call): `call_type: "web_call"`, **`access_token`**.
**Required** (phone call): `call_type: "phone_call"`, `from_number`, `to_number`,
`direction`.

Everything else is **optional** — including `start_timestamp`, `end_timestamp`,
`duration_ms`, `transcript`, `transcript_object`, `latency`,
`disconnection_reason`, `call_analysis`, `call_cost` and `llm_token_usage`.
Nothing in this codebase assumes any of them is present.

`call_status`: `registered` / `not_connected` / `ongoing` / `ended` / `error`.
`direction`: `inbound` / `outbound`.
`user_sentiment`: `Negative` / `Positive` / `Neutral` / `Unknown` — capitalised
exactly so.

**33 documented `disconnection_reason` values**, recorded verbatim in
`DISCONNECTION_REASONS`. A test asserts every one maps to an AIDA category, so an
unmapped value is genuinely undocumented rather than an oversight. An
undocumented value maps to `unknown` with the raw string preserved; a future
`error_*` value is *not* guessed into `provider_error` because it looks like one.

**Latency** components: `e2e`, `asr`, `llm`, `llm_websocket_network_rtt`, `tts`,
`knowledge_base`, `s2s` — each with optional `p50`/`p90`/`p95`/`p99`/`max`/`min`/
`num`/`values`. `values` is deliberately dropped from summaries: unbounded, and
not needed to answer "was this slow".

**Transcript timing.** `transcript_object` is `Utterance[]` with `role`,
`content` and `words[]` carrying per-word `start`/`end` in seconds. Word timings
give the moment a turn actually stopped — the difference between "the agent
stopped talking" and "the call ended".

## Analysis timing

`call_ended` carries every field of the call object **except `call_analysis`**;
`call_analyzed` fires separately with it. Webhooks are triggered in order but are
**not blocking**, so `call_ended` can arrive first.

The documentation does **not** state how long analysis takes, nor the conditions
under which it is not produced. Both are recorded as unknown rather than guessed.

## Contract corrections found

None. Every M7E field name and enum was taken from the documentation and has not
been exercised against the live API, so this section records **no verified
behaviour** — unlike the M7B and M7D sections above, which do. The distinction
matters: M7D found four mismatches that documentation alone had not revealed.

## Adapter changes

* `retrieveCallForDiagnostics` — the same endpoint under `canReadDiagnostics`.
  A separate method rather than a flag on `retrieveCall`, so the capability is
  visible at every call site.
* `extra.takeCallBody()` — the parsed body through a **one-shot** closure, the
  same pattern as the web-call access token. `JSON.stringify(result)` cannot
  serialise it and a second read returns `null`. Necessary because a Get Call
  response for a web call carries `access_token` as a **required** field.
* The mock adapter's `retrieveCall` previously returned `{id, call_id,
  call_status}` while the live adapter returns `{id, version, status, agentId,
  callType}`. A consumer written against the mock would have read `call_status`
  and got `undefined` in production. **Fixed to mirror the live shape** — the
  same defect class M7D found four times over.
