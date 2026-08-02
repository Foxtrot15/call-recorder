# Retell Call Diagnostics & Australian Phone Speech — M7E

**Status:** built, dormant. **No live execution occurred during M7E.**

> **M7E-LV (2026-08-02) has since exercised the read path against the real
> provider**, read-only, on one retained call. It corrected the dropout
> narrative in Part 8 and found four defects fixtures had not exposed. Read
> [RETELL_LIVE_DIAGNOSTICS_VALIDATION.md](RETELL_LIVE_DIAGNOSTICS_VALIDATION.md)
> alongside this document; where the two disagree, the live result wins.

No Retell resource was created, updated or deleted. No call was created, placed
or received. No phone number was purchased, imported or bound. No webhook was
enabled. No SQL was applied and no database was connected. Nothing was deployed
and nothing was pushed.

This milestone closes the two findings M7D left open:

1. Australian numbers stored in canonical E.164 were spoken as
   *"plus six one, four nine one…"*. **Fixed.**
2. A mid-sentence audio dropout could not be attributed to anything. **Not
   fixed — made investigable.** The evidence needed to answer it now exists;
   the answer itself does not, and this document does not pretend otherwise.

---

## Part 1 — Canonical E.164 versus spoken presentation

### The rule

| Layer | Form | Example |
|---|---|---|
| Storage, provider operations, validation, audit | **E.164** | `+61491234567` |
| Anything a human reads | **Australian display** | `0491 234 567` |
| Anything a model may say | **Spoken** | `oh four nine one, two three four, five six seven` |

**Storage did not change.** `normaliseAuNumber()` in
`src/services/locksmith-profile.js` remains the single canonical gate, and every
stored number is still E.164. Display and spoken forms are **derived at the
point of use and never stored**.

That is not a stylistic choice. It is what makes a corrected digit safe: change
the canonical number and every presentation regenerates from it. There is no
second copy to go stale because there is no copy at all.

### Why raw E.164 must never be read aloud

An Australian caller hearing *"plus six one, four nine one…"* is being read a
number in a form they do not use, in a context where a single misheard digit
means the locksmith never rings them back. M7D's operator described it as
sounding "a bit weird"; the real cost is a lost callback.

The product already knew how to do this conversion — `validateChange()` produced
a `readBackText` for change-request confirmations. It existed on the
**configuration** path and not on the **runtime** path, which is exactly why the
live agent had nothing better to read.

### The shared service

`src/services/au-phone-speech.js` — `describeAuNumber(raw, { purpose })` returns:

| Field | Meaning |
|---|---|
| `ok` | a spoken form was produced |
| `e164` | the canonical value, **never altered** |
| `display` | Australian local form, or `null` |
| `spoken` | natural spoken form, or `null` |
| `masked` | last three digits only, for logs and reports |
| `numberType` | `mobile` · `landline` · `service_1300` · `service_1800` · `service_13` · `international` |
| `localised` | whether an Australian form was produced |
| `transferEligible` | whether the canonical rule would accept it as a transfer target |
| `fallback` | why there is no spoken form: `empty_value` · `not_text` · `not_australian` · `unrecognised_format` |

Both the change-request read-back and the receptionist runtime now use it. There
is no second implementation to drift.

### Australian number handling

| Input | Display | Spoken |
|---|---|---|
| `+61491234567` | `0491 234 567` | `oh four nine one, two three four, five six seven` |
| `+61391234567` | `03 9123 4567` | `oh three, nine one two three, four five six seven` |
| `+61291234567` | `02 9123 4567` | `oh two, nine one two three, four five six seven` |
| `+61731234567` | `07 3123 4567` | `oh seven, three one two three, four five six seven` |
| `+61881234567` | `08 8123 4567` | `oh eight, eight one two three, four five six seven` |
| `1300 123 456` | `1300 123 456` | `one three oh oh, one two three, four five six` |
| `1800 123 456` | `1800 123 456` | `one eight oh oh, one two three, four five six` |
| `13 12 34` | `13 12 34` | `one three, one two, three four` |

Grouping rules:

* **Zero is "oh"**, never "zero" — that is how an Australian reads a number.
* **Digits are spelled as words.** No TTS engine can then decide `491234567`
  is a quantity. This is why the spoken form contains no digit characters at all.
* **Commas mark the groups.** Every engine already treats a comma as a pause; we
  do not rely on one inferring that eleven digits is a phone number.
* **No `double` or `triple` compression.** `0491 570 006` has a natural "double
  oh" and it is still spoken `oh oh`. Compression is clever and ambiguous;
  no product rule supports it.
* **No SSML.** Retell's prompt fields have no validated SSML contract in this
  codebase, so nothing emits markup. Plain deterministic text only.

### Refusals

An input that cannot be confidently localised gets **no spoken form at all** —
not a partial one, not an invented one:

| Input | Result |
|---|---|
| `""`, `"   "`, `null` | `fallback: empty_value` |
| a non-string | `fallback: not_text` |
| `"0491 234 56"`, `"not a number"` | `fallback: unrecognised_format` |
| `+14155550123` (valid, foreign) | `fallback: not_australian`, `e164` preserved |
| `+61491234567x12` (extension) | refused — the domain permits no extensions |

A non-Australian number is refused **deliberately**. Reading `+1 415…` aloud is
the exact failure being removed, and giving a foreign number an Australian
grouping would be worse. The prompt tells the agent to ask the caller to confirm
the number instead.

### The 13 family

`normaliseAuNumber()` refuses `13xxxx` on purpose — you cannot transfer a caller
to a 13 number. A business may still have one and a receptionist may still need
to say it, so this module recognises 13 numbers for **presentation only** and
marks them `transferEligible: false`.

Recognising a number and being willing to dial it are different questions.
Conflating them is how a 13 number would quietly become a transfer target, and a
test asserts the canonical rule still refuses all three written forms.

### A bug this surfaced

`normaliseAuNumber()` could not re-normalise its own 1300/1800 output.
`normaliseAuNumber("1800 123 456")` gave `+611800123456`; feeding that back gave
`01800123456` and returned `null`. Any stored service number therefore
evaporated whenever anything re-validated it — `toQueryableColumns` wrote null,
and complexity scoring concluded no transfer number was configured.

Fixed by stripping the country code first and only then deciding whether a trunk
zero belongs. The old `readBackText` had the same fault in reverse: it produced
`0 1 3 0 0 1 2 3 4 5 6`, inventing a leading zero that is not part of the number.

---

## Part 2 — Machine-only versus model-facing number variables

### The variables

| Variable | Audience | Delivered |
|---|---|---|
| `current_transfer_number` | machines | per call |
| `current_backup_number` | machines | per call |
| `current_transfer_number_spoken` | **the model** | per call, **derived** |
| `current_backup_number_spoken` | **the model** | per call, **derived** |
| `caller_number_spoken` | **the model** | not yet deliverable — see below |

All are in `DYNAMIC_VARIABLE_ALLOWLIST` and all are in `RUNTIME_ONLY_KEYS`, so
none can be baked into `default_dynamic_variables` at provisioning time. Every
value is a string, as the provider requires.

### The spoken form is derived, never supplied

`buildInboundCallVariables()` takes canonical numbers only. The spoken twin is
computed inside it. There is **no parameter** through which a caller could supply
a spoken value, so a spoken value that disagrees with its canonical number cannot
exist.

`validateDynamicVariables()` additionally refuses any `*_spoken` key whose value
contains a number in international form. Refused rather than converted: silently
fixing it would hide whichever caller built the wrong value.

An unlocalisable number produces **no spoken variable**, and the compiled default
for that key is `""`. Nothing renders a placeholder.

### The transfer tool never receives a number from the model

`attempt_urgent_transfer` takes `enquiry_id` and `urgency`. `get_on_call_recipient`
returns "an opaque recipient reference, never a phone number". The server
resolves the destination from canonical E.164 on its own side.

**Saying a number and dialling one are separate operations**, and M7E kept them
separate. A test asserts the transfer tool's parameter list.

### Prompt rules

A dedicated *Saying a phone number* section is now compiled into every
receptionist prompt:

* Australian callers expect an Australian reading — say "oh four nine one",
  never "plus six one, four nine one".
* Read a supplied spoken version exactly as written, and nothing else.
* Never read a number beginning with a plus sign, and never convert one yourself.
* Never say a variable name or anything in double curly braces.
* With no spoken version available, ask the caller for the number rather than
  reading a raw value.

A regression test compiles a receptionist whose transfer number is
`+61491234567` and asserts that string appears **nowhere** in the prompt, the
begin message, the knowledge base or the compiled spec. It may still appear in a
machine-only tool argument, which is where canonical E.164 belongs.

### The sandbox prompt

M7D's live call said "plus six one" because of one line in
`src/services/retell-web-sandbox.js`, which interpolated
`{{current_transfer_number}}` and asked for it "digit by digit". It now uses
`{{current_transfer_number_spoken}}` and instructs the agent to read it verbatim.

A second test walks every `{{variable}}` named in the sandbox prompt and asserts
each one is actually delivered — the generalisation of M7D's `{{caller_suburb}}`
defect, where an unsupplied variable was read aloud as literal text.

### The future inbound path

An inbound **phone** call receives per-call dynamic variables through exactly one
mechanism: the inbound webhook, in `call_inbound.dynamic_variables`, answered
2xx within 10 seconds. **No webhook is enabled, and M7E did not enable one.**

The deterministic conversion is ready: given a canonical `from_number`,
`buildInboundCallVariables({ callerNumber })` produces `caller_number_spoken`.
Only the spoken form is sent — the agent has no use for a caller's E.164 value,
so sending it would be exposure without a purpose.

Until the webhook exists this path is **prepared, not live**, and the compiled
default is `""` rather than `{{runtime}}` precisely so nothing can render.

---

## Part 3 — Official Retell contracts reviewed

**Reviewed 2026-08-02**, official documentation only. No blog posts, community
examples or copied payloads.

| Page | Used for |
|---|---|
| `docs.retellai.com/api-references/get-call` | the entire call response object |
| `docs.retellai.com/features/webhook` | event names and analysis timing |
| `docs.retellai.com/features/post-call-analysis` | custom analysis categories |

### Get Call

`GET /v2/get-call/{call_id}` — already the path in `retell-adapter.js`.

The response is a **discriminated union**: `V2WebCallResponse` or
`V2PhoneCallResponse`, both extending `V2CallBase`.

**Required** on the base: `call_id`, `agent_id`, `agent_version`, `call_status`.
A web call additionally requires `call_type: "web_call"` and **`access_token`**.
A phone call requires `call_type: "phone_call"`, `from_number`, `to_number` and
`direction`.

**Everything else is optional** — `start_timestamp`, `end_timestamp`,
`duration_ms`, `transcript`, `transcript_object`, `latency`,
`disconnection_reason`, `call_analysis`, `call_cost`, `llm_token_usage`. Nothing
in this implementation assumes any of them exists; a missing field is reported as
missing rather than defaulted to something that reads like a measurement.

`call_status`: `registered` · `not_connected` · `ongoing` · `ended` · `error`.
`direction` (phone only): `inbound` · `outbound`.

### Disconnection reasons

Thirty-three documented values, recorded verbatim in
`DISCONNECTION_REASONS`. A test asserts every one maps to an AIDA category, so an
unmapped value is genuinely undocumented rather than an oversight.

The mapping is a **renaming, not an inference** — each entry restates what the
provider already said, grouped. That is why a category derived through it carries
evidence level `provider_classified`, and nothing else does.

An **undocumented** reason maps to `unknown` and the raw string is preserved in
`rawDisconnectionReason`. Notably a future `error_*` value is *not* guessed into
`provider_error` just because it looks like one.

### Latency

Documented components: `e2e`, `asr`, `llm`, `llm_websocket_network_rtt`, `tts`,
`knowledge_base`, `s2s`. Each is a `CallLatency` with optional `p50`, `p90`,
`p95`, `p99`, `max`, `min`, `num`, `values`.

`values` — the full unbounded measurement array — is **deliberately dropped**. It
is not needed to answer "was this slow", and a report that grows with call length
stops being readable.

### Transcript timing

`transcript_object` is `Utterance[]`: `role` (`agent` · `user` ·
`transfer_target`), `content`, and `words[]` with per-word `start`/`end` in
seconds. `transcript_with_tool_calls` adds `tool_call_invocation`,
`tool_call_result`, `node_transition`, `dtmf`, `sms` and `injected` entries.

**Word timings are what make the timeline useful.** They give the moment a turn
actually stopped, which is the difference between "the agent stopped talking" and
"the call ended".

### Post-call analysis

`call_analysis` fields, all optional: `call_summary`, `in_voicemail`,
`user_sentiment` (`Negative` · `Positive` · `Neutral` · `Unknown` — capitalised
exactly so), `call_successful`, `custom_analysis_data`.

The API reference does **not** document `agent_sentiment` or
`agent_task_completion_rating`; neither is used.

Custom analysis categories: Text · Selector · Boolean · Number, which the API
expresses as `type: "string" | "enum" | "boolean" | "number"`. Both vocabularies
are accepted so a schema copied from either place validates.

**Documented timing:** `call_ended` carries every field of the call object
**except `call_analysis`**; `call_analyzed` fires separately with it. Webhooks are
triggered in order but are **not blocking**, so `call_ended` can arrive before
`call_analyzed` completes.

The documentation does **not** state how long analysis takes, nor the conditions
under which it is not produced. Those are recorded as unknown rather than guessed.

---

## Part 4 — The diagnostics service

`src/services/retell-call-diagnostics.js`. Contacts nothing; it is handed a
parsed Get Call body.

### Evidence, not conclusions

Every statement is tagged as exactly one of:

| Level | Meaning | Example |
|---|---|---|
| `provider_classified` | Retell itself said what happened | *disconnection_reason was `user_hangup`* |
| `observed` | the provider returned this fact | *the last completed turn was the caller's* |
| `unproven` | consistent with the evidence, established by none of it | *connection instability is possible* |

**A cause is assigned only from a documented provider classification.** There is
no path in `buildDropoutEvidenceReport()` that promotes an observation to a cause.
Tests assert this directly, including that the report never says "caused by" for
an unexplained dropout.

Specifically:

* An incomplete final sentence does **not** prove a network failure.
* Audio stopping does **not** prove a Retell fault.
* Elevated latency and a disconnect are **not linked** by any field in the
  response, and the report says so.

`ended` with no `disconnection_reason` is categorised `incomplete_evidence` —
**not** `normal_completion`. An absence of evidence and a clean finish must not
be spelled the same way.

### Categories

`normal_completion` · `user_disconnected` · `agent_disconnected` · `transfer` ·
`voicemail` · `provider_error` · `timeout` · `silence_timeout` ·
`maximum_duration` · `not_connected` · `account_limit` · `blocked` ·
`manually_stopped` · `taken_over` · `in_progress` · `incomplete_evidence` ·
`unknown`.

### Diagnostic heuristics — NOT provider guarantees

Retell publishes no acceptable-latency figure and these are not one. They are the
values above which a human should go and look:

| Threshold | Default |
|---|---|
| `llmP95Ms` | 3000 |
| `ttsP95Ms` | 2000 |
| `e2eP95Ms` | 4000 |
| `knowledgeBaseP95Ms` | 3000 |
| `shortCallMs` | 5000 |
| `incompleteTurnMinChars` | 15 |

All are configurable. Every breach carries
`thresholdSource: "aida_diagnostic_heuristic"` and the note *"not a provider
guarantee"*, and **the source label itself cannot be overridden** — a test proves
an attempt to relabel it as an official SLA is ignored.

The "final turn appears incomplete" check — a turn that does not end in terminal
punctuation — is a **heuristic** and is labelled as one everywhere it appears. A
model can end a turn without punctuation, and a caller can be interrupted by
design.

### What cannot be determined from a Get Call response

Reported honestly rather than implied:

* **Why** an unexplained mid-turn stop happened. No field reports it.
* **Browser-side or transport events** — a websocket close, local audio failure,
  a dropped connection. None is observable in this response at all.
* **Whether latency contributed** to a disconnect.
* **How long analysis will take**, or whether it will arrive.

---

## Part 5 — Transcript privacy

A diagnostic summary gets written to disk and pasted into tickets. It must be
safe to hand to somebody who is not entitled to the conversation.

**Never emitted, by default or otherwise:** full transcript, `transcript_object`,
`transcript_with_tool_calls`, recording URLs, `public_log_url`,
`knowledge_base_retrieved_contents_url`, `access_token`, the API key, custom SIP
headers, or a full phone number.

**Emitted instead** — turn *structure*, which is what actually answers "did the
agent get cut off":

* speaker role and turn index
* start / end / duration in seconds, from word timings
* character and word counts
* whether the turn ends in terminal punctuation
* tool-call occurrence (count, never arguments)
* whether the final turn appears structurally incomplete

Phone numbers are masked to the last three digits (`•••••• 006`). Dynamic
variables are reported by **name only** — one of their values is a phone number.
Unmodelled provider fields are reported by name, never by value.

`findSensitiveLeaks()` walks the finished summary looking for URLs, token-like
strings, forbidden field names and international numbers. The script refuses to
print or write a summary that trips it. Tests prove it fires on planted values,
so it is not vacuously passing.

Transcript **content** requires:

1. `RETELL_DIAGNOSTICS_INCLUDE_CONTENT=true`, **and**
2. `--include-content` on the command line, **and**
3. `NODE_ENV` not `production` — refused outright there.

Even then, content is returned on a **separate `content` channel** that is
stripped before anything is written to the report file, and it carries a warning.
Custom text analysis fields report their length and never their value.

---

## Part 6 — Post-call analysis

`src/services/retell-call-analysis.js`.

### Readiness is not a boolean

| State | Meaning |
|---|---|
| `ready` | `call_analysis` returned with at least one populated documented field |
| `pending` | ended (or ongoing) and analysis has not appeared — `call_analyzed` fires separately |
| `not_applicable` | the call never connected; **polling would not end** |
| `unknown` | something that fits none of the above |
| `provider_error` | the read itself failed |

Collapsing these into "not ready" is what turns a bounded poll into an indefinite
one. `not_applicable` is terminal for exactly that reason.

An empty `call_analysis` object counts as `pending`, not `ready` — a consumer
trusting "ready" would read nulls.

### Bounded polling

`pollForAnalysis()` derives its attempt count from `maxWaitMs / intervalMs`.
There is no "wait until" branch, so a provider that never produces analysis costs
a known amount of time. A provider error ends the poll on the first failure —
retrying a 401 for a minute gives the same answer more expensively.

### Untrusted, structurally

Provider analysis is **useful and untrusted, in that order** — the same posture
`locksmith-analysis-schema.js` already states.

It can never modify a profile, approve a change request, alter routing or pricing,
trigger billing, override deterministic extraction, create a lead, or replace the
transcript as evidence. There is **no code path from this module to a write**: it
has no dependencies at all, exports no mutating verb, and returns
`{ ok, analysis, errors, warnings }` — data, never a decision. Tests assert each
of these structurally.

Type mismatches are **flagged, never coerced**. A model answering `"yes"` where a
boolean was requested has told us something about the model; casting it to `true`
throws that away. An undocumented `user_sentiment` is rejected rather than mapped
to `Unknown`, because `Unknown` is itself a documented value and mapping would
erase the difference between the model saying it and the model inventing nonsense.

---

## Part 7 — The read-only path

### Commands

```bash
# Assessment. Contacts nothing, creates nothing, spends nothing.
node scripts/retell-call-diagnostics.js

# Read ONE call. This is the only command that contacts Retell.
node scripts/retell-call-diagnostics.js --fetch-call "<call-id>"

# Bounded wait for post-call analysis.
node scripts/retell-call-diagnostics.js --fetch-call "<id>" --await-analysis

# Show transcript TEXT. Also requires the environment variable.
node scripts/retell-call-diagnostics.js --fetch-call "<id>" --include-content

# Write the sanitised summary to a temp file (never the transcript).
node scripts/retell-call-diagnostics.js --fetch-call "<id>" --write-report
```

**The default command was run during M7E verification. It contacted nothing,
created nothing and printed no secret.** No `--fetch-call` was run.

### Gates

`RETELL_DIAGNOSTICS_ENABLED` · `RETELL_DIAGNOSTICS_EXECUTE` ·
`RETELL_DIAGNOSTICS_INCLUDE_CONTENT` — all strict-parse (only the exact string
`"true"`), all default off.

A live read requires all of: `NODE_ENV` not production · `RETELL_ENABLED=true` ·
`RETELL_DIAGNOSTICS_ENABLED=true` · `RETELL_DIAGNOSTICS_EXECUTE=true` ·
`RETELL_ALLOWED_TAG=dev` · `RETELL_API_KEY` present · a valid `--fetch-call`
argument.

It **deliberately does not require**: `RETELL_LIVE_WRITES_ENABLED`,
`RETELL_LIVE_CALLS_ENABLED`, `RETELL_DRY_RUN=false`, any `RETELL_SANDBOX_*`, a
phone number, a webhook, recording, `RETELL_DEFAULT_VOICE_ID`, a database, or
`ANTHROPIC_API_KEY`.

Asking *"why did that call drop?"* must never require permission to create agents.
Dry-run is a promise not to **change** anything, which a read already keeps.

> **Tag handling.** `getRetellConfig` falls back to `"dev"` for an unrecognised
> tag, so `RETELL_ALLOWED_TAG=production` would otherwise read as dev and satisfy
> the gate. The diagnostics gate therefore checks the **raw** value: unset means
> dev (the intended default), but set-and-wrong is refused.

### What it cannot do

The only provider method reachable is `retrieveCallForDiagnostics`, behind
`canReadDiagnostics`. There is no create, update, delete, call-placement,
number-binding or list-calls path in the script at all — **the absence is
structural, not a flag check**, and a test greps the script to prove no mutation
method is even named in it.

The API key and the Authorization header are never logged; a test drives a 404
through the adapter and asserts the key appears in no log line.

The Get Call body reaches the diagnostics service through a **one-shot reader**,
the same pattern the web-call access token uses. The body is held in a closure,
so `JSON.stringify(result)` cannot serialise it into a manifest or a log line,
and a second read returns `null`. This matters because a Get Call response for a
web call carries `access_token` as a **required** field.

---

## Part 8 — What remains unproven

### The M7D dropout — **partly answered by M7E-LV**

> M7E did not diagnose it. **M7E-LV read the retained call back** and corrected
> most of what this section originally assumed. Full sanitised result:
> [RETELL_LIVE_DIAGNOSTICS_VALIDATION.md](RETELL_LIVE_DIAGNOSTICS_VALIDATION.md).

The provider record shows the call **ended cleanly on a `user_hangup`** after
~108 seconds and 18 turns, with a final agent turn that **does** end in terminal
punctuation, no provider error, and healthy latency throughout. The prediction
written here — "final agent turn visibly unfinished, no disconnection reason" —
was wrong on both counts.

The truncation was **mid-call**: two agent turns around the 25-second mark stop
without terminal punctuation, overlapping the caller's speech. **Why** they are
unfinished is still not established — a truncation that does not end the call is
reported by no field in the Get Call response, so barge-in, audio loss, a
transport hiccup and endpointing are indistinguishable from this record.

That gap was also an implementation gap: `finalTurnAppearsIncomplete` examined
only the *last* turn, so the first live read reported no truncation at all. The
design had assumed a truncation must also be a disconnection; this call contains
one without the other. Mid-call detection and overlap detection were added, and
they deliberately do **not** touch `cause` — a cause explains how a call ended,
not that nothing went wrong before it.

### Still not validated

* **Inbound telephone calls.** No number has been purchased, imported or bound.
* **The inbound webhook.** Not enabled. Per-call variable delivery *for a phone
  call* therefore remains unproven — M7D's Proof C delivered variables through
  `create-web-call`, which is a different mechanism.
* ~~**Post-call analysis against the live provider.**~~ **Validated by M7E-LV**:
  a real analysis object was retrieved, `ready` on the first read with no polling
  needed. Field names, types and the `user_sentiment` capitalisation matched the
  documented contract.
* **Proof B** (the Retell dashboard path) — never performed.
* **Rate-limit behaviour.** Retell documents no rate-limit status for Get Call —
  only `200`, `400`, `401`, `422` and `500` — and none was encountered.
* **`caller_number_spoken` end to end** — the conversion is deterministic and
  tested, but nothing can deliver it until the inbound webhook exists.

### Documented error responses (reviewed 2026-08-02)

| Condition | Status | Body |
|---|---|---|
| Call not found | **`422`** | `{"status": "error", "message": "Cannot find requested asset under given api key."}` |
| Missing/invalid key | `401` | same `{status, message}` shape |
| Rate limited | **not documented** for this endpoint |

`422` maps to `invalid_request` in the port, not `notFound`. Left as is: the
provider's message is carried through, so a missing call reports understandably.
Worth noting that M7D observed the *delete* endpoints returning `404` where the
docs said `422` — documented and live behaviour in this family has already
diverged once, so neither should be assumed.

**`access_token` is documented as REQUIRED on a web-call response regardless of
call status** — the schema does not relax it for an ended call. That is precisely
why the body travels through a one-shot reader and the summary strips it
unconditionally, and M7E-LV confirmed live that it never reaches the output.

**Retention is not documented.** The M7D call was still fully readable months
later, which is an observation about one call and not a policy.

### Before M7F inbound telephony validation

1. A telephone number must be purchased or imported, and bound — none of which
   M7E did or is authorised to do.
2. The inbound webhook must be reachable on a public HTTPS URL and must answer
   2xx within 10 seconds.
3. `RETELL_WEBHOOK_ENABLED` and signature verification must be exercised; M7E
   touched neither.
4. `caller_number_spoken` should be verified aloud on a real inbound call — the
   conversion is proven in tests, not in a caller's ear.
5. The E.164 read-aloud fix should be confirmed on a live call before any
   receptionist takes real traffic.

---

## Files

**Created**

| File | Purpose |
|---|---|
| `src/services/au-phone-speech.js` | Australian display and spoken presentation |
| `src/services/retell-call-diagnostics.js` | sanitised diagnostics + dropout evidence report |
| `src/services/retell-call-analysis.js` | post-call analysis readiness, validation, bounded polling |
| `src/config/retell-diagnostics.js` | the read-only gate, as a pure function |
| `scripts/retell-call-diagnostics.js` | assessment by default; one read behind every gate |
| `test/fixtures/retell-call-responses.js` | 23 fixtures, documented fields only |
| `test/au-phone-speech.test.js` | 52 tests |
| `test/retell-call-diagnostics.test.js` | 81 tests |
| `test/retell-call-analysis.test.js` | 35 tests |

**Modified**

`locksmith-profile.js` (1300/1800 round-trip) · `locksmith-change-request.js`
(shared read-back) · `locksmith-receptionist-compiler.js` (allow-list, spoken
variables, prompt rules) · `retell-dynamic-variables.js` (derived spoken forms,
E.164 guard) · `retell-web-sandbox.js` (spoken prompt line) · `retell-adapter.js`
(read-only method, one-shot body) · `voice-platform-port.js` (mock mirrors live)
· `config/retell.js` (`canReadDiagnostics`).
