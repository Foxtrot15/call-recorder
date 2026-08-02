# AIDA Locksmith — Conversational Feedback Loop (M7)

**Status: dormant, uncommitted, and NOT validated against a real provider.**
No SQL applied. No Stripe/Retell/Twilio resource created. No payment taken.
No production flag enabled.

Milestone chain: [M1](LOCKSMITH_PILOT_SPEC.md) → [M2](LOCKSMITH_ONBOARDING_SPEC.md)
→ [M3](RETELL_INTEGRATION_SPEC.md) → [M4](LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md)
→ [M5](LOCKSMITH_CLIENT_PORTAL_SPEC.md) → [M6](LOCKSMITH_BILLING_SPEC.md)
→ **M7 feedback loop**

---

## 1. What M7 closes

The architecture audit found three hard breaks between the code and the
product vision. M7 closes two and a half of them:

| Audit finding | M7 status |
|---|---|
| Conversation → structure did not exist (fixture only) | **Closed** — `locksmith-change-extraction.js` with a real Claude adapter beside the fixture |
| Change requests had no consumer | **Closed** — `locksmith-change-application.js` + `locksmith-approval-service.js` |
| Nothing reached the runtime (no execution, no `inbound_binding`) | **Half closed** — the plan now emits `inbound_binding`, dependencies resolve, and execution is reachable behind its gates. **Unvalidated against a real Retell account.** |

---

## 2. The loop

```
"We now service Frankston."
   │
   ├─ locksmith-change-extraction.js      claude-v1 | fixture-v1
   │    model proposes a DELTA;  code computes the RESULT
   │    quarantines ambiguity, injection, unsupported targets
   │    → { changes[], quarantined[], provenance, readBack }
   │
   ├─ locksmith-change-request.js         validateChange  (ONE validator)
   │
   ├─ locksmith-change-application.js     ← the missing consumer
   │    deep-copies → new DRAFT version → diff → read-back → audit
   │    approved version untouched
   │
   ├─ locksmith-approval-service.js       ← lifted out of the HTTP handler
   │    authorisation · confirmations · concurrency · safety floors · audit
   │    system actors can NEVER approve
   │
   ├─ locksmith-receptionist-compiler.js  instructions + knowledge + binding
   ├─ provisioning-plan.js                diff → idempotent actions → execute
   │    knowledge_base → response_engine → voice_agent → inbound_binding
   │
   └─ planRollback()                      re-point to the previous version
```

Every stage takes plain data. No stage knows which channel it came from beyond
recording a `sourceChannel` string.

---

## 3. Extraction design

### The model proposes a delta; the code computes the result

The model returns `{ operation: "add", values: ["Frankston"] }`. It **never**
returns the resulting list.

This is the single most important design decision in the module. If the model
were asked for the full resulting list it would have to reproduce every existing
suburb — and a model that drops one has silently removed a service area nobody
asked to remove, arriving inside a change the client *did* ask for. Asking for a
delta makes that failure mode **impossible rather than unlikely**. A test asserts
every pre-existing area survives an extraction whose adapter returns only the new
suburb.

### Contamination protections

`LLM_PROMPT_CONTAMINATION_INVESTIGATION.md` documents three loops (L1–L3) where a
prior Claude output re-enters a prompt and reinforces itself. This extractor
cannot form one:

| Protection | Enforcement |
|---|---|
| Only verbatim client words + **approved** profile values as input | No summary, analysis blob or prior extraction is read |
| Client words delimited as data | `«…»`, declared in the system prompt, per the M3 compiler convention |
| Instruction-like prose quarantined | Reuses `INSTRUCTION_LIKE` from the compiler so the two cannot drift |
| Stateless | No history, no few-shot examples that could be mistaken for the client's own configuration |

Tests assert the system prompt contains **no client data** and that no
`profile_summary` / `extraction_fields` / `context_summary` text appears in
either message.

### Quarantine over invention

Nothing ambiguous produces a change. Unsupported targets, unknown operations,
unrecognised suburbs, no-op changes and changes that would empty the service-area
list are all quarantined with a reason a person can read.

`SUPPORTED_TARGETS` is currently `["serviceAreas"]`. Widening it is a deliberate
act with its own tests — a wrong pricing rule is worse than an unhandled one.

### Read-back

Produced in `spoken` and `written` forms together, so a future voice agent and
the portal cannot describe the same change differently.

---

## 4. Defects found and fixed

M7 found four real defects, three of them on the path it was building.

| Defect | Consequence | Found by |
|---|---|---|
| `validateChange` accepted any shape for `serviceAreas`, a **safety-critical** target; `buildDraftFromChanges` then assigned it directly | An object `{primary:[…]}` became a single list **element** — a profile whose service areas were one nameless object, matching no suburb, while the change request looked correctly applied | Reconciling the audit against the code |
| Adding a previously **declined** area produced an invalid draft | "We now service Frankston" was impossible for a business that had declined Frankston — covered and declined simultaneously | The demonstration, on real fixture data |
| `agent.response_engine.llm_id` hard-coded to `null` with a comment saying it would be "filled in after the engine exists" | **Nothing filled it in.** Every agent creation would have gone to Retell with a null response engine | Implementing `inbound_binding` |
| Plan omitted `inbound_binding` entirely, though the purpose and adapter operation both existed | Provisioning "succeeded" and the phone stayed dead | The audit, confirmed in code |

A fifth was found in the *test suite's* assumptions: resuming an execution with
`alreadyDone` alone cannot satisfy a dependency, because skipping an action
removes its id from scope. `executePlan` now accepts `knownResources`, and the
test was **strengthened** (a new case asserts an unresolvable dependency fails
loudly rather than sending a null id).

---

## 5. Late-resolved provider references

Some payload fields are provider ids that do not exist until an earlier resource
is created. The plan model assumed every payload was known upfront —
`executePlan` even carried the comment *"later resources depend on earlier ids"*
with no mechanism to pass one.

`REF` / `ref()` / `resolveRefs()` in `voice-platform-port.js`:

- A payload may carry `{ "$aidaRef": "purpose:resourceType" }`.
- `executePlan` resolves it from ids produced earlier in the run, seeded from
  `knownResources` so a **resume** can satisfy a dependency created on a previous
  attempt.
- **Hashing happens over the unresolved payload**, so diffing and idempotency
  stay deterministic across runs (a test asserts hash stability).
- An unresolvable reference is a **hard, non-retryable failure**. Sending a null
  agent id would bind a phone number to nothing — a dead line that looks
  provisioned.
- A **dry run** substitutes a visibly fake placeholder
  (`<would-be-resolved-at-execution:…>`) rather than failing, because failing
  would make dry-run useless for exactly the plans that most need previewing.

---

## 6. Knowledge-model boundaries

M7 deliberately does **not** build the missing knowledge model. It also does not
work around it:

- **Nothing was pushed into `extensions`.** That field remains stored-but-never-
  compiled. Using it as an escape hatch would put unversioned knowledge into the
  runtime through a side door, which is the exact failure the approval model
  exists to prevent.
- **No unversioned free-form prompt text was added.**

### Is `serviceAreas` sufficiently extensible for Frankston? — Yes.

`serviceAreas.primary` and `.declined` are plain string lists with no enum
constraint, so an arbitrary new suburb needs no schema change. This is why
service areas were the right first slice: they exercise the entire loop without
requiring the schema work below.

**By contrast, `servicesAccepted` would NOT have worked** — it validates against
the fixed `SERVICE_IDS` enum, so "we now do safe opening" is rejected until a
developer ships a new enum value.

### Required future model (documented, not built)

| Knowledge type | Why it needs more than a field | Shape it likely wants |
|---|---|---|
| **FAQs** | The knowledge base's "Common questions" is **four hardcoded strings** in `buildKnowledgeContent`. `buildKnowledgeAmendment` already produces well-formed amendments with nowhere to go | Versioned list of `{question, answer, approvedAt}`; projected into the KB, never free text |
| **Staff** | No section exists. Touches transfer routing and privacy (staff names are personal data) | `{name, role, reachable, hours}`; consider whether names reach callers at all |
| **Booking preferences** | No section. Interacts with urgency rules and transfer eligibility | `{acceptsBookings, leadTime, blackouts, confirmationWording}` |
| **General business knowledge** | The riskiest: free-form text that must reach the KB without becoming a prompt-injection vector or an unapproved instruction | Versioned, delimited, injection-screened, approved per item |
| **Custom instructions** | **Most dangerous.** A client-authored instruction is indistinguishable from a prompt injection at the model boundary | Strongly constrained templates, never raw text; must not be able to override safety floors |
| **Client-extensible services** | `SERVICE_IDS` is a closed enum consumed by analysis schemas, test plans and the compiler | Needs a per-client service registry with a stable id, plus migration of the analysis enum |

**Ordering recommendation:** FAQs first (highest client value, lowest risk,
`buildKnowledgeAmendment` already exists), custom instructions last (highest
risk, needs a constrained template model rather than free text).

---

## 7. The two knowledge models

AIDA currently has two, and they disagree by construction.

| | v1 `business_profiles` | Locksmith profile |
|---|---|---|
| Status | **Live in production** | Dormant |
| Source | LLM summary of the last 10 call transcripts | Client interview + explicit changes |
| Cadence | Auto-regenerated every 3 then every 20 calls | On client approval only |
| Versioned | **No** | Yes |
| Approved | **No** | Yes, per section |
| Audited | No | Yes |
| Reaches | The post-call **analysis** prompt | The receptionist's **call handling** |
| Rollback | None | Planned |

### The risk

v1 is *"unversioned LLM-generated text injected into prompts"* — precisely what
the locksmith approval model exists to prevent. Today they do not collide
because the locksmith stack is dormant and they feed different prompts. The
moment the receptionist goes live for a client who also has v1 history, two
systems describe the same business with different authority.

### Recommended convergence (not performed in M7)

1. **Canonical source of truth: the versioned locksmith profile.** Anything that
   affects *call handling* must come from it. This is non-negotiable — it is the
   only one with approval and rollback.
2. **Demote v1 to an observation, not a configuration.** Keep generating it; stop
   treating it as knowledge. Rename its role in the code to something like
   `observed_business_summary` so no future author mistakes it for approved
   configuration.
3. **Passive learning becomes a proposal source, not a write path.** The natural
   fit: feed observed call patterns into `locksmith-change-extraction.js` as a
   *suggestion* channel (`source_channel: "system_generated"`, already in
   `SOURCE_CHANNELS`), producing change requests the client reviews. That turns
   v1's real strength — noticing patterns across many calls — into the loop
   rather than around it.
4. **Migrate useful v1 knowledge once, under review.** A one-off extraction of
   each client's `profile_summary` into proposed profile sections, presented for
   approval. Never auto-applied.
5. **Prevent unapproved LLM text reaching call handling** with a code-level
   guard, not a convention: the receptionist compiler should refuse any input
   that did not come from an approved profile version. It nearly does this
   already — `compileReceptionist` takes `profileStatus` — so the guard is a
   short step, and worth taking before the receptionist goes live.

**Do not migrate in the same milestone that enables the receptionist.** Two
changes to what the business "knows", landing together, is how you get an
incident nobody can attribute.

---

## 8. What is genuinely unproven

**Nothing in M2–M7 has ever contacted Retell.** This environment has no
`RETELL_API_KEY` and no `ANTHROPIC_API_KEY`. Specifically unvalidated:

| Assumption | Risk if wrong |
|---|---|
| `POST /create-retell-llm` accepts our `general_prompt` / `general_tools` shape | Compiler rework |
| `POST /create-agent` accepts `response_engine: {type, llm_id}` | Compiler rework |
| ~~`PATCH /update-phone-number/{number}` binds via `inbound_agent_id`~~ | **DISPROVEN in M7B.** Binding uses the weighted `inbound_agents` array. Corrected. |
| ~~Knowledge base accepts JSON~~ | **DISPROVEN in M7B.** The endpoint is multipart/form-data and there is no update endpoint. Corrected. |
| ~~`default_dynamic_variables` suffice at call time~~ | **DISPROVEN in M7B.** Inbound calls receive variables only via the inbound webhook; defaults are baked in at provisioning time. Transfer numbers are now stripped from defaults. |
| Retell has no delete endpoint (so rollback = re-point + supersede) | Rollback model changes if deletion exists |

The endpoint paths in `retell-adapter.js` were taken from official documentation
during M3, but **paths existing is not the same as payload shapes being right**.

The Claude adapter is likewise unrun against the real API — though its risk is
much lower, since it reuses the v1 pipeline's proven request shape, and its
output is validated and quarantined before it can affect anything.

---

## 9. Tests

`test/locksmith-feedback-loop.test.js` — 51 tests. Full suite **1077/1077**, no
`node_modules` requirement, no database, no network, no model key.

Coverage of the milestone's required proofs:

| Required proof | Test |
|---|---|
| Real extractor output is validated | "turns a plain statement into a structured, validated change" |
| Ambiguous extraction does not mutate data | "ambiguous input produces no change at all", "never mutates the approved profile" |
| Draft creation preserves the approved version | "creates a new draft and leaves the approved version untouched" (byte-identical assertion) |
| Diff output is stable | "produces a stable diff" |
| Approval is channel-neutral | "is channel-neutral — voice and UI take the identical path" |
| Approval cannot bypass confirmations | "cannot approve without every section confirmed" |
| Provider execution remains gated | "execution stays gated in the shipped configuration" |
| `inbound_binding` included where required | "emits an inbound_binding action when a number is configured" |
| Repeated execution is idempotent | "re-executing an unchanged plan is a no-op", "the payload hash is stable" |
| Audit distinguishes channels | "records the source channel on the audit event" |
| Frankston works through shared services | "text in, changed receptionist configuration out" |

---

## 10. Demonstration

```bash
node scripts/frankston-demo.js                       # fixture extraction, dry run
node scripts/frankston-demo.js --adapter=claude-v1   # real model (needs a key)
node scripts/frankston-demo.js --execute             # real Retell (needs a sandbox)
```

Refuses to run with `NODE_ENV=production`. Never writes to a database. Contacts
no provider unless `--execute` is passed **and** every Retell gate is on **and**
`RETELL_ALLOWED_TAG` is not `prod`.

The starting profile is produced by the **real M2 extraction** of the demo
interview transcript, not a hand-written literal — an earlier hand-written one
failed validation on field shapes that had been guessed at, which is a good
argument for never hand-writing a fixture the pipeline can generate.

---

## 11. Remaining blockers before a voice configuration agent

1. **Retell validation** (§8). Build nothing further on unverified assumptions.
2. **Voice authentication.** `voice-configuration-session.js` has a complete
   layered policy and **zero enforcement points**. Caller ID is explicitly not
   authentication.
3. **A configuration agent + number**, separate from the receptionist, the
   onboarding agent and the outbound agent.
4. **Session persistence** — `voice-configuration-session.js` has no store.
5. **`SUPPORTED_TARGETS` widening**, each with its own tests and read-backs.
6. **Portal surfacing.** The M5 Support tab still only *creates* requests; the
   diff/approval UI for a change is not wired to these services yet.
7. **Turn-level conversation management** — clarification, correction
   mid-sentence, multi-change utterances. M7 handles one statement at a time.

---

## 12. M7B update — contract correction (2026-08-01)

The assumptions in §8 were checked against official documentation.
**Three of six were wrong**, and are now corrected in code:

| Assumption | Verdict |
|---|---|
| Phone binding via `inbound_agent_id` | **Wrong.** Weighted `inbound_agents` array, weights totalling 1 |
| Knowledge base accepts JSON | **Wrong.** `multipart/form-data`, and no update endpoint exists |
| `default_dynamic_variables` suffice for inbound calls | **Wrong.** Only the inbound webhook can supply per-call values |
| `response_engine: {type, llm_id}` | Correct |
| `post_call_analysis_data` on the agent | Correct |
| Retell has no agent/LLM delete endpoint | Consistent with the documented surface |

Two further defects surfaced while correcting these:

- **`voice_id` is required** and the compiler emitted `null` when unconfigured.
- **The knowledge base was never attached to anything.** `knowledge_base_ids`
  belongs on the LLM; AIDA created a KB and left it orphaned.

Full detail in [RETELL_INTEGRATION_SPEC.md](RETELL_INTEGRATION_SPEC.md#m7b--contract-correction-2026-08-01).

### Mock execution is not validation

Worth stating plainly, because a green suite invited the opposite conclusion:
**every one of these bugs passed 1077 tests.** A fixture accepts whatever shape
it is handed, so fixture tests prove the *plan* is coherent, never that the
*provider* would accept it. Dry-run proves even less — it does not send.

The new `test/retell-contracts.test.js` narrows the gap by asserting shapes
against the documented contract, but documentation conformance is still not
runtime conformance. See
[RETELL_SANDBOX_VALIDATION_PLAN.md](RETELL_SANDBOX_VALIDATION_PLAN.md) for the
procedure that would close it.

## 13. M7E update — one presentation service for both channels (2026-08-02)

The permanent architecture rule says UI and voice must share the same canonical
domain services. Phone-number *presentation* was the case where they did not.

`validateChange()` produced a `readBackText` for change-request confirmations —
`+61` → `0`, digits spaced. The **runtime receptionist path had no equivalent**,
so a live M7D call read a transfer number as *"plus six one, four nine one…"*.
One channel had the conversion and the other did not, which is precisely the
drift the rule exists to prevent.

`src/services/au-phone-speech.js` is now the single canonical presentation
service, and both paths use it:

| Layer | Form | Example |
|---|---|---|
| storage, provider operations, validation, audit | **E.164**, unchanged | `+61491234567` |
| anything a human reads | display | `0491 234 567` |
| anything a model may say | spoken | `zero four nine one, two three four, five six seven` |

Three properties make this safe rather than merely tidier:

* **Presentations are derived, never stored.** Change the canonical number and
  every presentation regenerates. There is no second copy to go stale.
* **The spoken form cannot be supplied, only derived.**
  `buildInboundCallVariables()` takes canonical numbers and computes the spoken
  twin itself; there is no parameter through which a disagreeing value could
  enter. `validateDynamicVariables()` additionally refuses any `*_spoken` key
  containing a number in international form — refused, not converted, because
  silently fixing it would hide whichever caller built it.
* **Saying a number and dialling one stayed separate.**
  `attempt_urgent_transfer` still takes `enquiry_id` and `urgency`;
  `get_on_call_recipient` still returns an opaque reference. The model never
  handles a phone number it could dial.

This also exposed a latent fault in the configuration path itself: the old
`readBackText` produced `0 1 3 0 0 1 2 3 4 5 6` for a stored 1300 number,
inventing a leading zero. Both channels now get `1300 123 456`.

Full detail:
[RETELL_CALL_DIAGNOSTICS_SPEC.md](RETELL_CALL_DIAGNOSTICS_SPEC.md).
