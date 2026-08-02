# Live Read-Only Retell Diagnostics Validation — M7E-LV

**Validation date:** 2026-08-02
**Branch:** `feature/locksmith-pilot-m7e-live-diagnostics-validation`
**Starting commit:** `9369621` (M7E)

**Read-only.** The only external operation performed was `GET` against the
documented Get Call endpoint, for **one specific retained call**, twice (the
second run verified two corrections — see *Corrections* below).

**No provider mutation of any kind.** No resource created, updated or deleted.
No call created. No web call. No telephone call. No phone number purchased,
imported, updated or bound. No webhook enabled or changed. No SQL. No database
connection. No deployment. Nothing pushed.

The call id, agent id and every other real provider identifier are deliberately
**not recorded in this repository**.

---

## 1. What was validated

M7E built the call-diagnostics and post-call-analysis implementation and tested
it against fixtures only. This milestone pointed it at a real provider record —
the retained web call from M7D's live browser validation, the one during which
the operator reported the agent "dropping out mid sentence".

Two questions:

1. Does the implementation read and sanitise a real Get Call response correctly?
2. What does the provider record actually say about that dropout?

The answer to the second turned out to contradict what M7E had assumed.

---

## 2. Documentation reviewed

Official Retell documentation only, **reviewed 2026-08-02**:

| Page | Used for |
|---|---|
| `docs.retellai.com/api-references/get-call` | response shape, required vs optional fields, error statuses |
| `docs.retellai.com/features/webhook` | `call_ended` / `call_analyzed` and analysis timing |
| `docs.retellai.com/features/post-call-analysis` | custom analysis categories |

New facts recorded this round:

* **Not found is `422`**, not `404`, with body
  `{"status": "error", "message": "Cannot find requested asset under given api key."}`.
  Worth noting against M7D's observation that the *delete* endpoints returned
  `404` live where the docs said `422` — the documented and live behaviours in
  this family have already diverged once.
* **Authentication failure is `401`** with the same `{status, message}` shape.
* **Rate limiting is not documented for this endpoint.** Only `200`, `400`,
  `401`, `422` and `500` are listed. Retell's rate limits remain unconfirmed.
* **`access_token` is documented as REQUIRED on a web-call response regardless
  of call status** — the schema does not relax it for an ended call. This is
  exactly why the body is passed through a one-shot reader and why the summary
  strips it unconditionally.
* **Retention is not documented.** The retained call was still readable, which
  is an observation about one call, not a policy.

---

## 3. Pre-execution proof

Before any network call, the live path was exercised with a **fake transport**
to establish, rather than assume, what it would do:

| Property | Result |
|---|---|
| Requests issued | exactly 1 |
| HTTP method | `GET` |
| Path | `/v2/get-call/{call_id}` |
| Request body | none |
| Adapter methods reachable from the script | `retrieveCallForDiagnostics`, and nothing else |
| List-calls endpoint anywhere in the adapter | none exists |
| Empty / whitespace / missing call id | gate refuses |
| Gate with writes, calls and sandbox all off | **allowed** |
| Gate with `NODE_ENV=production` | refused |
| Gate missing any diagnostics flag | refused |
| Forbidden values reaching a summary (9 planted) | 0 |
| Transcript content channel with flag off | `null` |

The write, call and sandbox flags were explicitly set to `false` **in the shell
process only** for this validation. `.env` was not modified; `dotenv` does not
overwrite variables already present in `process.env`, so the process values won.

That detail matters beyond hygiene: the live read succeeded with
`RETELL_LIVE_WRITES_ENABLED=false`, which demonstrates in practice what M7E only
asserted in design — **reading a call back requires no permission to create
anything**.

The default assessment command was run first: it contacted nothing, created no
file, printed no secret, reported the gates accurately and exited 0.

---

## 4. Sanitised result

| Field | Value |
|---|---|
| Call found | **yes** |
| Call type | `web_call` |
| Direction | n/a (web call) |
| Call status | `ended` |
| Connected | **yes** — 18 transcript turns returned |
| Agent association | resolved, agent version 0 |
| Duration | ~107.8 s; `duration_ms` and the start/end timestamps agree exactly |
| Disconnection reason | **`user_hangup`** (documented value) |
| Category | `user_disconnected` — evidence level `provider_classified` |
| Provider error | **none** |
| Latency present | `e2e`, `asr`, `llm`, `tts`, `knowledge_base` |
| Latency absent | `llm_websocket_network_rtt`, `s2s` (documented optional) |
| Heuristic thresholds exceeded | **none** |
| Post-call analysis | **`ready` on the first read** — no polling required |
| Caller / callee numbers | absent (a web call carries neither) |

### Latency, rounded

`e2e` p50 ≈ 1.17 s / p95 ≈ 2.49 s · `asr` p50 ≈ 0.21 s · `llm` p50 ≈ 0.51 s,
p95 ≈ 0.93 s · `tts` p50 ≈ 0.19 s · `knowledge_base` p50 ≈ 0.05 s.

Healthy throughout, and healthy *after* the truncation as well as before it.

### Post-call analysis, sanitised

`call_summary` present (351 characters — **length only; the text was not printed
and is not recorded here**). `user_sentiment: Neutral`, `call_successful: true`,
`in_voicemail: false`. Two custom string fields were returned, matching the
schema the M7D sandbox agent was configured with.

Field names, types and the documented `user_sentiment` capitalisation all
matched. **The analysis was treated as untrusted**: it was validated and
displayed, and nothing in the code path can apply it to a profile, an approval,
routing, pricing or billing.

---

## 5. The dropout: what the record establishes

### The M7E assumption was wrong

M7E predicted the retained call would show "ended, connected, final agent turn
visibly unfinished, no `disconnection_reason` at all", and wrote a conclusion for
exactly that shape.

**None of that was true.** The provider classified the disconnect itself
(`user_hangup`), the final agent turn **does** end in terminal punctuation, and
the call ran a full ~108 seconds across 18 balanced turns.

### But something did happen — mid-call, not at the end

Two agent turns around the 25-second mark stop **without terminal punctuation**,
and two turns **start before the previous turn ends** (overlaps of ~1.1 s and
~0.5 s). A substantial agent turn stopping unfinished, immediately followed by
overlapping speech, is the structural signature of a truncated or interrupted
turn — and it sits precisely where the operator reported hearing a dropout.

### What the implementation got wrong

**The first read reported no truncation at all.** `finalTurnAppearsIncomplete`
examined only the *last* turn, so a tool built to answer "was the agent cut off?"
answered "no" while the evidence sat in a timeline it had already computed.

The assumption baked into that design was that a truncation must also be a
disconnection. They are different events, and this record contains one without
the other. Fixed — see *Corrections*.

### Answers

| Question | Answer | Evidence level |
|---|---|---|
| Was the call found? | yes | observed |
| Was it a web call? | yes | observed |
| Did it connect? | yes | observed |
| Final status? | `ended` | observed |
| Documented disconnection reason? | yes — `user_hangup` | **provider_classified** |
| Who produced the final completed turn? | the agent | observed |
| Unfinished **final** agent turn? | **no** | observed |
| Unfinished **mid-call** agent turns? | **yes, two** | observed |
| Overlapping speech? | yes, two instances | observed |
| Latency metrics present? | yes, five components | observed |
| Explicit provider error? | **no** | observed |
| Post-call analysis? | yes, ready | observed |
| Does the record establish a dropout cause? | **the ENDING, yes. The mid-call truncation, no.** | — |

### Conclusion

> Retell classified this call as `user_disconnected` (`user_hangup`). Separately,
> two agent turns mid-call do not end in terminal punctuation; that is consistent
> with a truncated turn, and no provider field explains it.

### What remains unproven

* **Why those mid-call turns are unfinished.** A truncation that does not end the
  call is reported by no field in the Get Call response. Barge-in (the caller
  speaking over the agent, which the overlap timings are equally consistent
  with), audio loss, a transport hiccup and endpointing behaviour are
  **indistinguishable from this record**.
* Whether the operator's earlier connectivity problems are related. Still
  circumstantial — and now weaker, because the remaining ~80 seconds ran cleanly
  with healthy latency.
* Retell's retention policy. One call was readable; that is not a policy.
* Rate-limit behaviour, which is neither documented nor exercised.

**No conclusion of internet, browser, Retell, LLM, TTS, endpointing or user
interruption failure is drawn.** None is supported by a provider field.

---

## 6. Corrections made

Four, all found by the live read and none of which fixtures had exposed.

### 1. Mid-call truncation was invisible — *contract/logic correction*

`summariseTimeline` examined only the final turn. It now reports
`incompleteTurns`, `midCallIncompleteCount`, `midCallIncompleteAgentCount`,
`overlaps` and `overlapCount` — structure only: index, role, character count and
timing, never content.

The evidence report surfaces mid-call truncation **without touching `cause`**. A
cause explains how a call *ended*; it does not certify that nothing went wrong
before that. Reporting only `user_hangup` would have closed a question that is
still open.

### 2. The script aborted on exit — *transport/runtime correction*

After printing its final line the process aborted with a libuv assertion
(`UV_HANDLE_CLOSING`), exiting `-1073740791` instead of `0`. `process.exit()` was
being called from a promise continuation while `fetch`'s keep-alive handles were
still closing; on Windows that trips an assertion rather than exiting quietly.

Now sets `process.exitCode` and lets the loop drain. A script whose success
reports as a crash is unusable in anything automated.

> `scripts/retell-web-sandbox.js` has the identical `main().then(process.exit)`
> pattern and the same latent hazard. **Not changed here** — it is M7B/M7D-
> validated code and changing it without a live sandbox re-run would be
> unverified. Recorded for a future milestone.

### 3. A misleading analysis warning — *honesty correction*

Every returned custom field was reported as *"not in the requested schema"* while
**no schema had been supplied to compare against**. The message asserted a check
that never ran. Now distinguishes `no_schema_supplied` from a genuine
`unexpected_custom_field`.

### 4. An undocumented live field — *tolerance, not a contract change*

The live response carried a top-level `tool_calls` field that the documentation
reviewed the same day does not list. Handled conservatively and **deliberately
not adopted**: reported by name so nothing arrives unnoticed, never consumed,
never copied into a summary. No validation was weakened to accommodate it.

### Fixtures

Two deterministic fictional fixtures were added: one reproducing the
clean-ending-with-mid-call-truncation *structure* (fictional prose, ACMA-safe),
one carrying an undocumented top-level field. **No real call content, real
identifier or real transcript appears in any test.**

The "fixtures carry only documented fields" rule now has one named exemption,
visible rather than silent, for the undocumented-field fixture.

---

## 7. Privacy verification

Checked in the visible output of both reads:

| Item | Result |
|---|---|
| `RETELL_API_KEY` | **not printed** (presence only) |
| Authorization / Bearer header | **not printed** |
| `access_token` | **not printed** — and documented as a required response field, so this was a real test |
| Full transcript | **not printed** — content mode was never enabled |
| Transcript excerpts | **none** — only role, timing and character counts |
| `recording_url`, `recording_multi_channel_url` | **not printed** |
| `public_log_url` | **not printed** |
| Founder voice id | **not printed** |
| Caller / callback / transfer numbers | none present; masking path verified separately |
| Dynamic-variable values | **not printed** (names only are ever emitted) |

The script's own `findSensitiveLeaks` guard ran over the real summary before
anything was printed, and passed. **No forbidden value was printed at any
point**, so no key rotation was required. No report file was written; no
provider response was saved to disk.

---

## 8. Status after this validation

**Answered:** the diagnostics implementation works against a real provider
response; post-call analysis retrieval works and returned `ready` immediately;
the retained call ended cleanly on a user hang-up; a mid-call truncation is real
and visible; retention held for this call.

**Still open:** why the mid-call truncation happened; Retell's rate-limit
behaviour; inbound telephone calls; the inbound webhook; `caller_number_spoken`
end to end; the M7E Australian-speech fix heard aloud on a live call.

### Before M7F inbound telephony

1. Nothing in this validation created, bound or purchased a number — all of that
   remains ahead.
2. The inbound webhook is still unbuilt and unverified; per-call variable
   delivery for a *phone* call remains unproven.
3. The E.164 read-aloud fix is proven in tests, **not in a caller's ear**.
4. Barge-in behaviour deserves explicit attention on the first inbound call, now
   that overlapping turns are known to occur and to be indistinguishable from
   truncation in the provider record.
