# Acquisition Blocker Register — the one current list

**Status of this document:** LIVE. Last recomputed **2026-08-13**, at the close
of **E-7B1**, which is now **CLOSED as engineering on dev**: LAQ5 applied by
hand, the durable dispatch authority and durable emergency stop proven against
real Postgres — including a genuine two-process race that Postgres, not Node,
arbitrated — and the live schema **structurally verified 14/14 PASS** (§11).
Dev is at **23 rows**, acquisition calling is **paused at revision 1** and has
never been anything else, there is still **no live provider**, and **E-7 remains
OPEN**. Also on 2026-08-13, **E-7B2A** built the Retell provider adapter
**offline** — it constructs the exact outbound request, maps every answer, and
**cannot send one**: no transport is wired anywhere, `live` is a literal
`false`, and no SQL or cross-repo change was needed (§12). On 2026-08-11 **E-7A**
built the provider-disabled dial execution seam (§10). Before that, on 2026-08-10: **M8L** closed
the caller-supplied duplicate-resolution gap, **E-5** closed durable founder batch
approval — **neither needed SQL** — the founder approved the attempt policy
(**A-L6 / A-L7 / A-L8 closed**, approval `AL6-AL7-AL8-2026-08-10`), and **M8M**
closed **A-L1** and **A-L3** by founder operating policy.

**Owns (source of truth for):** what currently stands between a persisted
prospect and one authorised outbound acquisition call, and who has to resolve
each item.

> **This register supersedes every blocker table inside
> [LOCKSMITH_ACQUISITION_SPEC.md](LOCKSMITH_ACQUISITION_SPEC.md).** Those tables
> are milestone SNAPSHOTS — §A2.9 records what A2 knew, §24 what M8B knew, §34
> what M8C knew — and they are labelled as such. They drifted precisely because
> three present-tense tables described one moving thing. When this register and
> a snapshot disagree, **this register is right**.

**Nothing in this repository can place a call.** `EXTERNAL_SYSTEMS.telephony` is
a hardcoded `false` with no environment override.

**E-7A changed one clause of that sentence and no more.** An execution verb now
exists — exactly one, in `acquisition-dial-execution.js` — and it can be reached
only with a genuine M8E authorisation. It still cannot call anybody: the default
provider **refuses**, the only other provider is an offline **fake**, no adapter
reaches a network, and a ratchet fails the build if any provider declares itself
live. So the statement holds, and it now holds for a tested reason rather than
for want of anything to test. The items below are what would still have to be
true *if* a real provider existed.

---

## 1. Compliance policy and data — what engineering cannot decide alone

> **M8M changed the AUTHORITY behind A-L1, not the standard of care.** The
> permitted calling window is now covered by a **founder operating policy**, not
> by a lawyer's opinion. That is a weaker claim than the one it replaced and the
> code says so everywhere it can: the approval carries `isLegalAdvice: false` and
> a disclaimer, no refusal message asks for counsel any more, and a ratchet fails
> the build if anything relabels it as legal sign-off. **No lawyer has reviewed
> the calling rules encoded in this repository.** See §9.

| ID | Blocker | Status | Effect while open |
|---|---|---|---|
| ~~**A-L1**~~ | Sign-off on the permitted calling window | **CLOSED — founder operating policy, NOT legal advice** (`acq-calling-policy-2026-08-10`, Peter Dang). AIDA follows the published Australian telemarketing calling-hours framework and applies it to AI voice acquisition calls on the same terms. `counsel_approval_missing` is gone from the live path; an un-adopted policy still refuses with `calling_policy_unapproved`. Obtaining an actual legal review remains available and would be a **new, separate artifact** — not a relabelling of this one. |
| **A-L2** | An authoritative public-holiday source, and which state calendars are carried | **OPEN — and NOT closed by A-L3** | Hand-compiled fixture, national + VIC, `authoritative: false`, covering **2026 only**. From **2027-01-01 the gate refuses every date.** Choosing not to call on holidays does not tell us which days those are. Also **M-6**. |
| ~~**A-L3**~~ | Should AIDA call on public holidays at all? | **CLOSED — founder decision.** **No cold acquisition call on a public holiday applicable to the recipient**, and none when holiday coverage is unknown. The published rules leave a holiday window technically available; AIDA declines to use it. This settles the POLICY only — the DATA question is **A-L2**, still open, and AFL Grand Final Friday is still absent from the fixture rather than guessed. |
| **A-L5** | Do 1300/1800 numbers carry the same DNCR obligations as geographic ones? | **OPEN** | Treated identically — everything is washed. Conservative. |
| **DNCR-1** | Who holds the DNCR account, performs the wash, and may attest an import | **OPEN — account activation + first real wash + attestation outstanding.** A DNCR **Access Seeker account application has been submitted**; activation approval has not yet come back, so no real wash has been performed and nothing has been attested. The engineering to store one is done and proven (**E-3**). | No real wash can enter the system, so `dncr_not_checked` blocks every prospect. |

## 2. Founder / commercial

| ID | Blocker | Status | Effect while open |
|---|---|---|---|
| ~~**A-L6**~~ | Attempt cap, retry spacing, recent-contact cooldown | **CLOSED — founder approved** (`AL6-AL7-AL8-2026-08-10`, Peter Dang). **2 counted attempts** per business; **2 days** minimum between ordinary attempts; the generic **30-day post-contact cooldown is RETIRED**, not re-tuned — a real conversation ends in a specific outcome and that outcome governs. `attempt_policy_unapproved` no longer blocks when the approved policy is supplied. |
| ~~**A-L7**~~ | Does a no-answer or a voicemail consume an attempt? | **CLOSED — founder approved.** A **no-answer does NOT** consume one of the 2 counted attempts; a **voicemail DOES**. M8J built the counting so it could go either way, and answering it changed a predicate over the stored rows — no backfill, no migration, no recount. The ratchet now pins the ANSWER: changing either value fails the build unless the approval changes with it. |
| ~~**A-L8**~~ | The "not interested" consequence (and `declined`, `callback`) | **CLOSED — founder approved.** `not_interested` and `declined` are **permanent no-recontact**, not 180-/90-day cooldowns: the business is never cold-acquired again. Both labels stay **distinct** for analytics and audit. Neither is recorded as an `opt_out` — see §2.1. An explicitly requested **callback is honoured for 14 days** and then fails closed. |
| **A-L10** | Is there a ceiling on repeated *uncounted* no-answer redials? | **OPEN — raised by the A-L6/A-L7/A-L8 closure.** Because a no-answer consumes no counted attempt, the cap alone no longer bounds how often a never-answering business may be rung; only the 2-day spacing does. **Not blocking a FIRST call** (an untried business has no history), but it wants an answer before any repeated campaign. Deliberately left as a decision rather than given an invented number. |
| **A-L4** | Are the approved A-L6 numbers the intended *commercial* policy? | **OPEN** | Caps applied as ceilings; a campaign may be stricter, never looser — now **enforced**, not merely intended: an override that would loosen an approved rule is clamped back and recorded in `refusedOverrides`. Not blocking. |
| **A-L9** | Who besides the founder may approve a batch; is a second approver needed above a threshold? | **OPEN — deliberately untouched by E-5** | Single named founder or operator per approval, `maxBatchSize: 25` — now **enforced**, not merely configured: a batch of 26 cannot be identified and therefore cannot be approved. E-5 invented no second approver role and no automatic approval, and a ratchet fails the build if one appears. Governance, not blocking one call. |

### 2.1 A decline is not an opt-out, and is not stored as one

A-L8 makes `not_interested` and `declined` permanent. It would have been easy to
implement that by writing an `opt_out` suppression row, because permanent
suppression already exists and already works. **That would have been a lie in
the data.**

| | what it means | how it is enforced |
|---|---|---|
| `opt_out` | the person **asked us to stop contacting them** | an `opt_out` row on the append-only suppression list, business-wide |
| `not_interested` / `declined` | the business **said no to being acquired** | derived from the durable outcome row every time eligibility is computed — **no suppression row is written** |

A business declining a pitch has not made a do-not-contact request, and
recording one on their behalf would fabricate a request nobody made — in an
append-only table, where it cannot be taken back. So the two stay apart: the
consequence for cold acquisition is identical, the record of what happened is
not, and `consequence.enforcedBy` says which mechanism did the work.

The permanence needs no schema of its own. `acquisition_contact_outcomes`
already stores the outcome, and the refusal is recomputed from it on every read,
which is why it survives a restart, a re-import and a brand new process. **No
SQL was required to close A-L8.**

---

## 3. Engineering

| ID | Work | Status |
|---|---|---|
| ~~**M-1**~~ | Apply LAQ1, LAQ2, verify RLS | **DONE on dev.** LAQ1+LAQ2 M8D 2026-08-07; **LAQ3 M8I 2026-08-08**. **Production: none applied.** |
| ~~**M-2**~~ | Replace in-memory stores with the tables | **DONE.** M8C built the adapters, M8D applied the schema, M8G/M8H wrote through them. |
| ~~**M-3**~~ | Lease reaper | **DONE, dormant.** No timer and no scheduler; `sweep()` runs when a human runs it. |
| **M-4** | Re-run eligibility at the moment of dialling | **MECHANISM DONE (M8E), CALLER IS NOW E-7A — STILL OPEN.** `createDialAuthoriser` re-runs the whole engine at the authorisation instant against durable suppression (M8E) and durable contact history (M8J). Since E-7A it **has** a caller: the executor accepts nothing else, and refuses a slip older than **60 seconds** so an authorisation cannot become a standing permission. It stays open because the caller cannot yet place a call. Closes with **E-7B**. |
| **M-5** | `service_area` / `operating_status` capture path | **OPEN.** The discovery contract derives neither. |
| **E-8** | Nothing makes a prospect CONTACTABLE | **OPEN — found by E-7B2B1, and it blocks a first call.** An outcome may only be recorded from `queued`, `attempted`, `connected` or `callback_requested`, and the lifecycle is `review_approved → queued → attempted`. **No batch selection sets `queued` and no dispatch sets `attempted`**, so the return path would refuse every outcome — safely (nothing written, both locks held), but it would refuse. Belongs to the dispatch side, not the webhook: a webhook asserting "a call was attempted" is the wrong module making that claim. See §13.1. |
| ~~**M-6**~~ | Authoritative public-holiday source | **OPEN** — tracked as **A-L2**, because the blocker is the source decision, not the code. |
| ~~**M-7**~~ | Cross-process suppression visibility | **CLOSED in M8E.** Proven across two real processes against dev Postgres. |
| ~~**E-1**~~ | Derive attempt history from `acquisition_contact_outcomes` | **CLOSED in M8J.** `acquisition-history.js` is the one derivation; the authoriser reads it every time and refuses on `contact_history_unavailable`. Proven read-only against real Postgres, 16/16, zero residue. |
| ~~**E-2**~~ | Persist the review decision onto the prospect lifecycle | **CLOSED in M8J.** `transitionProspectLifecycle` is a compare-and-set; `acquisition-review-projection.js` projects the durable decision and repairs a lag without recording a second decision. Proven against real dev Postgres 2026-08-09 under founder approval — a `review_approved → review_pending → review_approved` round trip on one existing fictional row; post-run verification 16/16, zero further residue. **No row created anywhere**; the approved residue was 2 history entries and a bumped `updated_at`. |
| ~~**E-3**~~ | Durable DNCR wash storage | **CLOSED ON DEV in M8K — proven restart-safe against real Postgres.** `laq4` applied to dev 2026-08-10; **not applied to production**. An attested wash persisted on dev was read back by **two genuinely separate OS processes**, gave the same answer both times, and the *same row* evaluated 42 days after the wash decays to `unknown` and refuses with `dncr_wash_stale` — **without any row changing**, because freshness is computed at read time. 33 read-only checks, zero residue. The path fails closed: an unreadable ledger yields `dncr_store_unavailable`, kept distinct from "never checked", never an empty Map read as success. 39 offline tests cover the states dev's single row cannot be in. **Open for production**, which has no acquisition schema at all. |
| ~~**E-5**~~ | Durable batch approval | **CLOSED in E-5, offline — no SQL required.** A founder approval is now an append-only row in `acquisition_decisions` (`entity_type: 'batch'`, which the laq1 CHECK has admitted since it was written), keyed by `ba_<membershipHash>` — an identity derived from the membership itself. `acquisition-authorisation` destructures `context.batch` off the caller's context and **discards** it; the approval is read from the store or it does not exist. Proven across two genuinely separate OS processes, 9/9 and 26/26, **zero database residue**. See §5. |
| ~~**M8L**~~ | Durable duplicate resolution | **CLOSED — no SQL.** `context.duplicateResolution` is no longer authority anywhere a call can be decided. The M8E gate destructures it off the caller's context and reads the **M8H review decision** instead — the same rows a human already wrote. Proven across two separate OS processes, 13/13 and 22/22, **zero database residue**. See §8. |
| **E-6** | `service_area` / `operating_status` — same item as M-5 | **OPEN.** |
| ~~**E-7B1**~~ | Durable dispatch authority + durable emergency stop | **CLOSED ON DEV 2026-08-12 — LAQ5 applied by hand, proven against real Postgres.** `dispatchId` (random UUID) and `batchKey` travel on every genuine slip; the atomic claim is one INSERT **the database arbitrates**, and that was proven by **two separate OS processes** racing to claim one business on one handset — one claimed, one was refused naming the prospect lock. Replay, the prospect lock and the destination lock all refused as designed. The emergency stop is read from the store **twice** per dispatch, `killSwitch` is a forbidden caller option, and the executor refused a caller who supplied one. **No provider result can release a lock** — `resolved_at` is set only by a recorded contact outcome or a named operator, and the proof row is still unresolved. Dev residue **21 → 23** (bootstrap state row + one fictional dispatch); decisions unchanged at 4, queue at 0, calling **paused**. The live schema was then **structurally verified 14/14 PASS** on 2026-08-13, read-only — including both partial unique index predicates and both guard triggers being BEFORE, ROW-level, covering UPDATE and DELETE, and **enabled** (§11). **Production: not applied.** [Runbook §15](ACQUISITION_SQL_RUNBOOK.md), design: [ACQUISITION_E7B1_DESIGN.md](ACQUISITION_E7B1_DESIGN.md). |
| **E-7B2A** | The Retell provider adapter, offline | **COMPLETE — OFFLINE, NO TRANSPORT, `live: false`.** `acquisition-retell-provider.js` builds the exact outbound call request and maps every answer Retell can give, and **cannot send one**: it imports no transport, reads no environment, holds no credential, names no host, and states `live` as a literal `false` a caller cannot override. Its submitter is **injected**, and a ratchet walks every `acquisition-*.js` proving nothing constructs one. **No SQL** — laq5's `provider_ref` already carries a `call_id`. **No cross-repo change** — there is no second repository (§12). The one substantive decision: the shared voice port marks `provider_timeout` **retryable**, and this provider **discards that flag**, raising ambiguity instead so an unknown submission leaves the dispatch unresolved for a human rather than ringing a business twice. 34 offline proofs. [ACQUISITION_E7B2_RETELL_DESIGN.md](ACQUISITION_E7B2_RETELL_DESIGN.md) |
| **E-7B2B1** | Acquisition agent contract + the offline return path | **COMPLETE — OFFLINE. No agent provisioned, no number provisioned, no route exposed, no SQL.** The return path exists end to end as a pure function: verified event → **direct** lookup on the exact `aida_dispatch_id` → call-id binding → classification → durable outcome → **and only then** the lock. It reuses the existing signature verification and the existing `provider_webhook_events` fingerprint idempotency rather than building second ones, and it **writes no suppression and sets no `resolved_at` itself** — both belong to services that already own them. A hang-up is **not** an answer: `call_ended` settles only `no_answer`, `voicemail` and `busy`, because it routinely arrives before `call_analyzed` and outcomes are append-only. An opt-out needs **high confidence and transcript evidence** or the whole analysis is held for a human — never downgraded to a decline. 45 offline proofs. See §13 and [ACQUISITION_E7B2_RETELL_DESIGN.md](ACQUISITION_E7B2_RETELL_DESIGN.md) §14. |
| **E-7B2B** | Live Retell integration | **NOT STARTED — founder-authorised, after DNCR readiness.** Needs a purpose-built acquisition agent (the receptionist and onboarding agents are both wrong for cold calling, §12), its own outbound number and capability gate, a wired transport, `dispatchId` in Retell metadata so an ambiguous submission is reconcilable, an explicit decision on how an opt-out is confirmed, and the webhook → outcome → resolution path in that order. |
| **E-7** | The dialler, accepting only an `AuthorisedDial` slip | **PARTIAL — E-7A COMPLETE, LIVE PROVIDER ABSENT BY DESIGN.** The execution **seam** is built, provider-disabled: `acquisition-dial-execution.js` is the only thing that may consume a slip, the default provider **refuses**, and the only other provider is an offline fake. **No real provider adapter exists, no network path exists, and no live call is possible.** E-7 does **not** close until a later founder-authorised milestone (**E-7B**) connects a real provider after DNCR operational readiness. See §10. |

---

## 4. What is applied where

| | dev (`wvwemitmmsdytyutaqbm`) | production |
|---|---|---|
| `laq1_create_acquisition_prospects.sql` | **applied** 2026-08-07 (M8D) | **not applied** |
| `laq2_create_acquisition_queue.sql` | **applied** 2026-08-07 (M8D) | **not applied** |
| `laq3_serialise_decision_chain.sql` | **applied** 2026-08-08 (M8I) | **not applied** |
| `laq4_create_dncr_washes.sql` | **applied** 2026-08-10 (M8K) | **not applied** |
| `laq5_create_dispatch_authority.sql` | **applied** 2026-08-12 (E-7B1) | **not applied** |

Dev holds **23 fictional proof rows** across eleven tables (M8D/M8E/M8G/M8H/M8I,
M8K's one wash row, and E-7B1's two). See [ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md)
§9, §11.7 and §15.

**E-7B1 added exactly two rows, and they are the only rows laq5 has produced.**
One is the migration's own bootstrap: `acquisition_calling_state`, scope
`global`, state **`paused`**, revision 1, `changed_by = 'laq5-migration'`. The
other is `acquisition_dial_executions` dispatch
`20e8681f-0c72-45f6-b4ea-484f6e0cc3c0`, claimed by the winner of the two-process
race for fictional prospect `pr_3740207ebbc0a379910f` on fictional number
`+61355509999`, provider `disabled`, `provider_live = false`. It is
**permanently unresolved by design** — it holds both locks, and that is what
makes the locks demonstrable afterwards. Neither row is evidence anybody was
called; no provider was invoked at any point.

**M8K added exactly one row**, and it is the only row laq4 has ever produced:
`+61355509999`, `not_listed`, washed `2026-08-09T00:00:00Z`, attested by
`laq4-verify`, batch `laq4-verify-batch`. It is fictional, it belongs to no
business, and it is **not a real DNCR wash** — it was written by the migration's
behavioural probe, not by anybody who washed a list. It is append-only and
cannot be removed. The M8K durability proof is **read-only** and added nothing.

**E-5 added none of them, and required no migration.** It writes to
`acquisition_decisions`, which laq1 already created with an `entity_type` CHECK
admitting `'batch'`; nothing was applied to dev or production for it. Its restart
proof runs against a file-backed store and touches no database at all. **A real
approval on dev would be a permanent decision row** in an append-only table, so
none has been written and none should be without a decision to write it.

**M8J's E-2 proof added none of them.** It is the only exercise so far that
UPDATEd an existing row rather than appending one: two entries on
`pr_3740207ebbc0a379910f`'s `history` journal and a bumped `updated_at`, with
the lifecycle left exactly where it was found. The total was **20** when M8J ran
and is **21** now — M8K's one permanent `acquisition_dncr_washes` row is the
difference, and it is the only row added since. `acquisition_decisions` is still
**4**, and no append-only table was touched by M8J or by E-5.

---

## 5. E-5 — durable batch approval, closed

**Both conditions that made it a blocker are now false, and no SQL was needed.**

### 5.1 What it was

The batch machinery assembled, hashed and detected staleness, and the
eligibility engine refused `founder_batch_approval_missing` unless
`context.batch.approved === true`. What did not exist was any durable record —
the approval lived in the object the caller passed. So:

- the approving process had to be the authorising process, because a batch
  approved this morning left nothing for an afternoon worker to read;
- nobody could attest afterwards which businesses an approval had covered;
- and, worst, `{ approved: true }` was *assertable*. An object with no author,
  no timestamp and no membership cleared the one check that exists to record
  that a named human looked at a specific list and said yes.

### 5.2 What it is now

A founder approval is an append-only row in `acquisition_decisions`:

| | |
|---|---|
| `entity_type` | `batch` — admitted by the laq1 CHECK since it was written |
| `entity_id` | `ba_<membershipHash>` — **derived from the membership**, not a name |
| `event` | `batch_approval_recorded` / `batch_approval_withdrawn` |
| `decision` | `approve` / `reject`, `actor_kind` always `human` |
| `detail` | the exact members, the hash, the label, campaign, policy version, the ceiling |

Current state is a fold over the rows for one `entity_id` — the same shape the
review queue (M8H), suppression and outcomes already use. `unique (prev_hash)`
from laq3 makes concurrent approvals safe; the loser re-reads, finds the batch
already approved, and writes nothing.

**No new table, no `ALTER`, no CHECK change, no index, no function.** See §5.5.

### 5.3 The two hashes, and why they are different

This is the design decision the milestone turns on.

| | covers | answers |
|---|---|---|
| `batchHash` (`acquisition-batch.js`) | membership **and each row's eligibility** | "has anything changed since you looked at this screen?" |
| `membershipHash` (`acquisition-batch-approval.js`) | **who, and on what number**, plus schema/campaign/policy version | "is this the exact list that was approved?" |

Binding the durable approval to the first would have made a DNCR wash expiring,
a suppression arriving or a calling window closing all read as *the founder's
decision has gone stale* — and a founder asked to re-approve an unchanged list
every day learns to do it without reading it. So the durable approval binds to
membership only, which yields two separately reportable states:

- **BATCH STALE** — the membership changed. The approval does not cover this
  list. Re-approve. (`batch_membership_changed`, or simply a different key with
  no approval against it.)
- **APPROVED, PROSPECT CURRENTLY INELIGIBLE** — the membership is exactly what
  was approved; something else refuses the call right now. Nothing to
  re-approve, and the batch check does not even appear in `failedChecks`.

### 5.4 What a batch approval is not

It is **not permission to dial, and it never becomes permission to dial.** It
clears one check out of nine. Suppression, DNCR and its freshness, duplicates,
lifecycle, campaign and kill switch, counsel and attempt policy, holidays and
the calling window are all still evaluated at the instant of every call, and
only the M8E gate mints an `AuthorisedDial`. A test pins that an approved batch
does not outrank an opt-out recorded after it.

An unreadable approval store is `batch_approval_store_unavailable` — the gate's
own failure, never "not approved", for the same reason `contact_history_unavailable`
is distinct from `attempt_or_wash_restriction`.

### 5.5 Why no SQL was required

Every structure needed already existed and is already applied to dev:

- `acquisition_decisions.entity_type` **already admits `'batch'`** (laq1 line 199);
- `detail` is `jsonb`, and a 25-member list is small;
- `(entity_type, entity_id)` is indexed (`idx_acq_decisions_entity`);
- append-only is enforced by trigger, so a historical approval cannot be edited;
- the chain is hash-linked, so a removed or altered approval is detectable;
- `unique (prev_hash)` (laq3) already serialises concurrent writers.

A `batches` table with an `approved` boolean would have been a status column
over a decision, and this project's rule is that decisions are appended, never
edited. The one thing genuinely new is the *identity*, and that is a pure
function, not a schema.

### 5.6 What was proven, and where

- **63 offline tests** in `test/acquisition-batch-approval.test.js`.
- **A two-process restart proof**, `scripts/dev/acquisition-batch-approval-proof/`:
  process A approves and exits; process B is a fresh OS process that reads the
  approval back, authorises through the real M8E gate with **no `context.batch`
  at all**, and then proves a mutated batch is not covered by it. **9/9 and
  26/26.**
- **Zero database residue.** The proof runs against a file-backed store, because
  what E-5 has to prove is a property of the fold over append-only rows and not
  of any particular adapter — and demonstrating it against dev would have
  appended a permanent approval row to an append-only table to show something
  that needs none. The adapter's own row mapping is covered by
  `test/acquisition-store.test.js` and the M8H/M8I proofs.

### 5.7 What is still open

**A-L9 is untouched and remains open.** E-5 supports exactly one named founder
or operator per approval. It does not invent a second approver role, a threshold
above which two are required, or any automatic approval — a ratchet fails the
build if a `secondApprover`/`approvers` concept appears without that decision
being made. `maxBatchSize` stays at **25** and is now *enforced* rather than
merely configured: an oversized batch cannot be identified, and therefore cannot
be approved.

---

## 6. First-call readiness matrix

Recomputed 2026-08-10, after the A-L6/A-L7/A-L8 founder approval.

| # | Gate | After M8J | Now | Why |
|---|---|---|---|---|
| 1 | Prospect persisted | 🟢 | 🟢 | M8G; proven against real Postgres |
| 2 | Ambiguous candidates reach a human | 🟢 | 🟢 | M8H queue, M8I concurrency-safe |
| 3 | Record complete + valid | 🟢 | 🟢 | `assessProspect`; timezone mandatory in code and in `laq1` |
| 4 | Reviewed → `review_approved`, durably | 🟢 | 🟢 | **E-2**, proven on dev 2026-08-09 |
| 5 | Qualified | 🟢 | 🟢 | Ordering only, never permission |
| 6 | Duplicates resolved | 🟠 | 🟢 | **M8L closed it.** The answer is the M8H review decision, read from `acquisition_decisions` at the gate. `context.duplicateResolution` is discarded, so `resolveDuplicates([oneProspect])` — which the whole repo used to build, and which declares a known duplicate unique — no longer clears anything. Merged candidates are not a second calling target; unresolved and rejected identities refuse. See §8 |
| 7 | DNCR-cleared | 🟠 | 🟠 | **E-3 closed on dev** — storage is durable, restart-safe and fail-closed, proven against real Postgres. Still AMBER, and now for **one** reason rather than two: **DNCR-1**, nobody holds a Register account, so no real wash exists to store |
| 8 | Permitted day/time | 🟠 | 🟠 | **A-L1 and A-L3 closed** by founder policy (§9): the window is adopted, versioned and attributed, and holidays are refused outright. Still AMBER for **one** reason — **A-L2**, the holiday calendar is a hand-compiled 2026-only fixture, so from 2027-01-01 the gate refuses every date |
| 9 | **Attempts permitted** | 🟠 | 🟢 | **A-L6 / A-L7 / A-L8 approved.** The values are decided and cited, the count comes from durable rows, a decline is permanent, and the policy refuses to call itself approved while anything inside it is not. No engineering deficiency remains |
| 10 | Not suppressed | 🟢 | 🟢 | Append-only, DB-enforced, cross-process proven |
| 11 | Campaign / kill switch | 🟢 | 🟢 | Own precedence in gate and engine |
| 12 | Founder batch approval | 🟠 | 🟢 | **E-5 closed.** Durable, restart-safe and proven across two OS processes. `context.batch` is discarded by the gate; the approval is read from `acquisition_decisions` or it does not exist. Membership-bound, so a compliance change does not fake staleness. **A-L9** is still open but is governance, not a defect |
| 13 | Final M8E authorisation | 🟢 | 🟢 | Durable suppression **and** durable history; unforgeable slip; fails closed on either read |
| 14 | Future dial request | 🔴 | 🔴 | **E-7 — still RED, and correctly so. E-7A built the seam, E-7B1 made the dispatch durable on dev; there is still no live provider.** The executor refuses everything that is not a genuine M8E slip, spends each slip once — **now enforced by Postgres across processes, not by one process's memory** — reads a durable stop it cannot be handed, and reaches an offline provider that is disabled by default. **Nothing here can call anybody.** Turns AMBER only when a real adapter lands under **E-7B** |

**Gate 6 moved AMBER → GREEN.** M8L closed it. The amber was never "we do not
detect duplicates" — `acquisition-dedupe` has been careful since A2. It was that
the ANSWER was whatever the caller had computed, and the object every dry run and
proof actually built (`resolveDuplicates([oneProspect])`) declares a known
duplicate unique because it is the only record in it. The gate now reads what a
human decided, or refuses.

**Gate 12 moved AMBER → GREEN.** E-5 closed it: an approval survives the process
that made it, names exactly what it covered, cannot be asserted by a caller, and
cannot be stretched over a batch whose membership has changed. It is GREEN as an
*engineering* gate. It does not mean anything may be called — see §5.4 — and
**A-L9 remains open** as a governance question about who else may approve and
whether a larger batch needs a second approver.

**Gate 9 moved AMBER → GREEN** on 2026-08-10. Its amber was always a policy amber
rather than a defect, and the policy has now been decided.

**Gate 7 lost one of its two reasons.** M8K closed **E-3** on dev: a wash now
survives a restart, proven across two separate OS processes against real
Postgres. It stays AMBER for the remaining reason, which is not engineering —
**DNCR-1**, nobody holds a Register account, so there is no real wash to store.
**Every engineering item behind gate 7 is now done on dev.**

**Gate 14 stays RED after E-7A, and that is the honest reading.** E-7A built the
execution seam and deliberately left it incapable of calling anybody: the default
provider refuses, the only alternative is an offline fake, and a ratchet fails the
build if any provider declares itself live. A seam that cannot dial is not a
dialler, so the gate does not move. What E-7A removed is the *engineering unknown*
— "what would consume a slip, and could it be tricked?" now has a tested answer.

**One RED remains, and it is the one that should be last.**

---

## 7. The shortest honest path to one call

1. **DNCR-1** — **account activation, then the first real wash and its
   attestation.** The Access Seeker application is in; activation has not come
   back. Somewhere durable to put a wash already exists (**E-3**, closed on dev),
   and `scripts/acquisition-dncr-import.js` loads it. **This is still the only
   blocker that stops the first call outright.**
2. **A-L2** — an authoritative holiday source. Has its own 2027-01-01 deadline,
   and until then the fixture covers the pilot period.
3. **E-7B** — a real provider adapter behind the E-7A seam, and an explicitly
   founder-authorised live proof. **E-7A is done** (the seam, its refusals, its
   single-use rule and its ratchets, §10) and **E-7B1 is done on dev** (durable
   cross-process dispatch authority and a durable emergency stop, applied and
   proven 2026-08-12). What is left on this item is **the adapter itself**, plus
   applying laq1–laq5 to production, which has no acquisition schema at all.

**M-5** is not on this path at all. **A-L10** is not on it either: a business
that has never been called has no history for an uncounted-redial ceiling to
bound.

~~**A-L1**~~ and ~~**A-L3**~~ left this list on 2026-08-10 — closed by founder
policy, **not by legal advice** (§9). ~~**E-5**~~ and ~~**M8L**~~ left it the
same day, closed. ~~**A-L6 / A-L7 / A-L8**~~ the same day, approved.

**Item 3 is the only engineering work left before a call**, and it is the one
that should be built last. Items 1–2 are decisions and data with lead times.

---

## 8. M8L — durable duplicate resolution, closed

**No SQL. No new event. No second truth source.** The answer was already being
written; nothing was reading it at the moment it mattered.

### 8.1 What it was

`acquisition-dedupe` has been careful since A2 — named signals, no similarity
score, no threshold, and only an exact duplicate may consolidate without a
person. Default-deny held too: no `duplicateResolution` meant refusal.

The gap was not detection and was not a forgotten check. It was that the ANSWER
came from `context.duplicateResolution` — the output of `resolveDuplicates()`
over a record set **the caller chose**. And:

```js
resolveDuplicates([theOneProspect])   // nothing to compare against
```

is a perfectly valid resolution in which nothing is a duplicate of anything. It
is what every test, every dry run and both dev proofs actually built, and it
cleared the gate. The same module that would have caught the duplicate, pointed
at nothing.

Nor was any of it durable. A founder's judgement about an ambiguous identity —
the one decision in this pipeline most obviously a human's — was recomputed in
memory on every run.

### 8.2 What it is now

The M8H review decisions, which have recorded exactly this since M8H:

| review outcome | durable duplicate state | at the gate |
|---|---|---|
| item still open, or `needs_more_information` | unresolved | `duplicate_requires_resolution` |
| `approve_as_new` | a distinct business | passes |
| `merge_into_existing` (+ `mergeTarget`) | merged | `duplicate_of_canonical`, canonical named |
| `reject_duplicate` | rejected as a duplicate | `duplicate_of_canonical` |
| `reject_not_locksmith` | rejected, not a duplicate matter | `review_decision_rejected` |
| no review item, **and a stored prospect row** | cleared at import | passes |
| no review item, **no row** | never assessed | `duplicate_never_assessed` |

Inventing a `duplicate_resolved` event beside the review queue would have created
a second truth source that could disagree with it, and the disagreement would be
discovered by a call to the wrong business.

### 8.3 The one inference, stated plainly

**A prospect with no review item is treated as cleared only if a prospect ROW
exists.** `acquisition-persist` writes a row only for candidates the import did
NOT hold; a candidate with a duplicate concern is held, a review item opens, and
no row is written (M8H). A row therefore means dedupe ran over the whole import
and did not flag this business, or a human approved it as new.

The converse is what makes it safe: a prospect object that exists only in a
caller's memory has never been compared against anything, and is refused as
`duplicate_never_assessed` rather than passing because no review happens to name
it. **Absence of a review is evidence only when there is a row whose existence
required one not to be needed.**

### 8.4 Merge, distinct, reject

- **Merged** — the candidate never becomes a prospect; what it knew was attached
  to the canonical business (M8H `attachMergedListing`). The canonical is the
  only callable identity, and the refusal names it. Proven to hold even when a
  row for the candidate exists anyway and the lifecycle projection has run —
  a merge moves no lifecycle, so the durable merge decision is what refuses.
- **Approved as new** — the identity question is settled and nothing else is.
  The record must still be stored, and every other gate still applies.
- **Rejected** — not callable. An exact re-import does **not** resurrect it:
  `openReviewItem` finds the resolved item and refuses to reopen, and even if
  something did persist the row, the durable rejection still refuses at the gate.
  Whether *materially new* evidence should reopen a rejection is deliberately
  **not** modelled — it is a real question and M8L does not pretend to answer it.

### 8.5 Fail closed

`duplicate_resolution_store_unavailable` is distinct from
`duplicate_requires_resolution`, for the same reason `contact_history_unavailable`
is distinct from `attempt_or_wash_restriction`. There is no fallback to the
caller's object, to "no duplicate known", or to empty state. Suppression still
outranks it, so a known opt-out is still reported as an opt-out.

### 8.6 What was proven

- **43 offline tests** in `test/acquisition-duplicate-state.test.js`, including
  one that reproduces the original defect before closing it.
- **A two-process restart proof**, `scripts/dev/acquisition-duplicate-proof/`:
  **13/13 and 22/22**. Process A has a human merge one candidate, approve another
  as distinct, and leave a third undecided, then exits. Process B authorises the
  canonical business from durable state with no `duplicateResolution` in its
  context at all, refuses the merged candidate, refuses the undecided one **while
  being handed a clean caller-supplied resolution**, and refuses a record that
  exists only in memory.
- **Zero database residue.** No dev write, and none is needed: the M8H review
  queue and the M8I decision chain were both already proven against real dev
  Postgres, and a dev proof here would append permanent review rows to an
  append-only table to demonstrate a fold.

### 8.7 Limitations

- `summariseDuplicateState` folds the log in memory with the same 5000-row cap
  `listReviewItems` carries. The gate never calls it.
- A capped page fails in the **safe** direction: an approval or resolution
  outside the page is not found, and the gate refuses.
- Whether materially changed evidence should reopen a rejected identity is
  **open and unmodelled** — see §8.4.

---

## 9. M8M — the founder-approved calling policy

**A-L1 and A-L3 are closed by a founder decision. No lawyer has reviewed
anything in this repository, and nothing here should be read as saying one has.**

### 9.1 What changed, precisely

Not the rules. The **authority behind them**.

Until M8M the eligibility engine refused every prospect with
`counsel_approval_missing` — "the permitted calling hours have not been signed
off by a lawyer" — which was accurate, and was a blocker only an external lawyer
could clear. The founder has decided not to obtain a legal opinion for the pilot
and to operate instead under a written, versioned policy of their own.

So the gate did not disappear and was not hardcoded open. `counselApproved` is
**gone** from the engine, not renamed and not aliased: a caller passing it now
supplies an option that changes nothing, and the gate refuses with
`calling_policy_unapproved` until a real approval artifact is supplied.

### 9.2 What is encoded

| | |
|---|---|
| Version | `acq-calling-policy-2026-08-10` |
| Adopted by | Peter Dang, 2026-08-10 |
| Kind | `founder_operating_policy` — **never** `legal_advice` |
| Basis | The published Australian telemarketing calling-hours framework (Do Not Call Register Act 2006; the Telemarketing and Research Calls Industry Standard), adopted as AIDA's operating policy |
| Applies to | **AI voice acquisition calls, governed as telemarketing calls.** No separate AI window, no separate AI attempt rule |
| Window | Mon–Fri **09:00–20:00**, Sat **09:00–17:00**, **no Sunday** — recipient-local, open inclusive, close exclusive. **Unchanged**: M8M adopted the window that was already encoded and tested, it did not move a boundary |
| Holidays | **No cold acquisition call on an applicable public holiday**, and none when coverage is unknown |
| Timezone | Missing or unusable **fails closed**. Never the server's |

AI disclosure wording is **deliberately out of scope** and none was invented.

### 9.3 The honesty machinery

Because "approved" is the word most likely to be misread later:

- `kind` and `isLegalAdvice` are **not parameters**. No argument to
  `createCallingPolicyApproval` can produce an artifact claiming a lawyer
  reviewed it, and a test proves it.
- The artifact carries a `disclaimer` saying in terms that it is not legal advice
  and has not been reviewed by a lawyer, and it travels with every decision.
- No refusal message asks for counsel any more — a ratchet asserts the words
  *lawyer*, *counsel* and *legal advice* do not appear in the policy refusal.
- `approved: true` alone is not an approval. It needs a **named human** (a system
  actor is refused by name), a **date**, a **version** and a **basis** — the same
  rule the attempt policy already enforces.
- Default-deny survived: `createCallingPolicyApproval()` is unapproved, so an
  engine built without one refuses everything.

**A real legal review, if one is ever obtained, is a separate artifact.** It
should be added alongside this one, not by relabelling it.

### 9.4 Policy versus data — the distinction that keeps A-L2 open

**A-L3 asked whether AIDA should call on public holidays. That is now answered:
no.** It is a policy question and the founder settled it conservatively.

**A-L2 asks whether we know which days those are. That is a data question and it
is untouched.** The calendar is still a hand-compiled fixture, still
`authoritative: false`, still national + VIC, still **2026 only**, and AFL Grand
Final Friday is still absent rather than guessed. From **2027-01-01** the gate
answers `holiday_coverage_unknown` and refuses every date.

A test pins both halves at once: with the policy adopted, a decision reports
`policy.approved: true` **and** `policy.holidayCalendarAuthoritative: false`.
Deciding not to call on holidays did not improve the calendar.

### 9.5 What this did NOT touch

The attempt policy (A-L6/A-L7/A-L8) is unchanged. **DNCR is unchanged**: every
callable number is still washed, a fresh authoritative `not_listed` is still
required, and listed / unknown / stale / unavailable all still block — **DNCR-1
is still open and is now the only blocker that stops the first call outright.**
Suppression still outranks every temporary calling-window block. E-5, M8L, M8J
and M8K all still apply, and only the M8E gate mints an `AuthorisedDial`.

**53 offline tests** in `test/acquisition-calling-approval.test.js`, including
boundary sweeps at 09:00/08:59, 19:59/20:00, Saturday 16:59/17:00, and every hour
of a Melbourne Sunday.

---

## 10. E-7A — the provider-disabled dial execution seam

**Status: ENGINEERING SEAM BUILT / LIVE PROVIDER DISABLED. E-7 remains OPEN.**

E-7A answers one question that had never been answered: *if M8E mints a genuine
`AuthorisedDial`, what exactly is allowed to consume it and ask for a call?*

It answers it while remaining **incapable of calling anybody**. That is not a
side effect of being unfinished — it is the deliverable. The seam is built in
production shape, wired to a provider that refuses.

### 10.1 What E-7A does NOT mean

- It does **not** close E-7.
- There is **no real provider adapter** in this repository — no Retell, no
  Twilio, no HTTP, no webhook, no generic transport.
- There is **no network path**. The two execution files import nothing but each
  other, the authorisation gate, and `node:crypto`.
- No environment variable, credential or config value can turn calling on.
  There is deliberately no "if credentials exist, go live" branch.
- Nothing was written to dev. Nothing was written to production. **No SQL was
  written or applied.** No prospect, provider, Register or person was contacted.

Enabling a live provider is **E-7B**: a separate, founder-authorised milestone,
after DNCR operational readiness.

### 10.2 The security model changed, because the old one proved less than it claimed

M8E's slip was authenticated by a **brand** — a symbol property. The symbol was
exported, and **object spread copies own symbol properties**. So:

| attempt | old `isAuthorisedDial` |
|---|---|
| hand-forged with the exported symbol | **passed** |
| a spread clone of a genuine slip | **passed**, and the copy was **not frozen** |
| the same clone with a rewritten number | **passed** |
| `Object.assign` copy | **passed** |
| JSON round-trip / `structuredClone` | refused |

A caller could take a slip for a number the gate cleared, clone it, point it at
a different number, and hold something the check called genuine. Nothing dialled,
so nothing happened — but E-7A gives a slip somewhere to be spent, and it must
not inherit that.

**E-7A authenticates by IDENTITY.** The mint step registers each frozen slip in a
module-private `WeakSet`, and `isGenuineAuthorisedDial` asks whether this is
*that object* — not whether it looks like one. A copy is a different object and
fails. `isAuthorisedDial` keeps its old meaning and its old callers; it is simply
no longer the check that may authorise execution.

**M8E was strengthened, not weakened, and nothing about the gate was relaxed to
make E-7A easier.**

### 10.3 The execution contract

```
M8E .authorise()  ->  genuine slip  ->  executeAuthorisedDial()  ->  provider
                                            |
                       DisabledDialProvider (default) | FakeDialProvider (tests)
```

`executeAuthorisedDial({ authorisedDial, provider, now, killSwitch, maxAgeMs, audit })`
refuses, in order:

| code | means |
|---|---|
| `caller_override_rejected` | the caller supplied a destination or a compliance answer |
| `authorisation_invalid` | not a slip M8E minted — forged, cloned, or JSON-revived |
| `authorisation_consumed` | already spent |
| `authorisation_expired` | older than `maxAgeMs` (default **60s**) |
| `kill_switch_engaged` | an emergency stop was active **at execution time** |
| `provider_refused` | compliance said yes; the mechanism said no |
| `provider_failed` | the provider threw. Outcome **unknown**, and not retried |
| `provider_accepted` | a provider took it. **Still not evidence anybody was called** |

**AUTHORISED is not CALLED. PROVIDER-DISABLED is not COMPLIANCE-REFUSED.** Those
are separate states because collapsing them is how a founder reads "blocked" and
believes a business refused them.

### 10.4 What a provider may and may not see

A provider receives exactly `executionId`, `destination`, `prospectId`,
`businessName`, `authorisedAt` and an inert `metadata` object, frozen. It never
receives eligibility context, permission booleans, a second number, or batch /
duplicate / DNCR / suppression authority. **A provider is an execution mechanism,
not a policy engine**, and it cannot dial a number it was not given.

### 10.5 Single use — and exactly how far that guarantee reaches

One slip may be handed to a provider **at most once**. The claim is made against
object identity **synchronously, before the first await**, so concurrent
executions cannot both pass. Ten concurrent attempts produce one submission.
A refusal still spends the slip: "at most one submission" is the invariant worth
having, and un-spending on refusal would let a caller poll a disabled provider.

> ### ⚠ THIS WAS PROCESS-LOCAL — CLOSED ON DEV BY E-7B1, 2026-08-12
>
> As written in E-7A, consumption lived in a `WeakSet` in one module in one
> process, and **a second process knew nothing about the first.** That is no
> longer the only defence: **E-7B1's uniquely-constrained dispatch row is
> applied to dev and proven**, and two genuinely separate OS processes racing
> for one business produced one claim and one database refusal.
>
> The in-process `WeakSet` remains, and remains process-local — it is now the
> **cheap first refusal**, not the guarantee. The guarantee is the partial unique
> index. **Production has no laq5 and therefore still has only the process-local
> check**, so this warning stands in full for production.

### 10.6 TOCTOU and expiry

The slip always described itself as permission "as at authorisedAt...
re-authorise rather than storing this". Nothing enforced it. E-7A enforces it at
execution: a slip older than **60 seconds** is refused as `authorisation_expired`.

Sixty seconds because the honest window is "long enough to hand a slip to a
provider, and no longer". The queue's 5-minute lease is the wrong comparison — a
lease reserves a prospect so nobody else takes it, while this asserts the world
has not changed, and **somebody can opt out in four minutes**. A slip dated in
the future is refused too, rather than treated as fresh.

### 10.7 No automatic retry, ever

A provider timeout is genuinely ambiguous: rejected, or accepted with the answer
lost. Retrying resolves it in the one direction that cannot be undone — two calls
to one business. So a provider failure returns `provider_failed` with an
**unknown** provider status and **stops**. A ratchet asserts the execution path
contains no retry, backoff, timer or loop of any kind.

### 10.8 It records no contact and consumes no attempt

A fake submission is **not** an attempt, a voicemail, a no-answer or a connected
call. The executor does not import `acquisition-outcome`, cannot reach
`appendOutcome`, and leaves the derived contact history reading zero. The attempt
policy (a no-answer does not consume a counted attempt, a voicemail does) is
untouched and unreachable from here. Audit entries, when a log is supplied, say
`dial_execution_submitted` with the reason "**NOT evidence that anybody was
contacted**".

### 10.9 Kill switch

The engine already evaluates `campaign.killSwitchEngaged` at authorisation time,
and M8E mints no slip while a stop is engaged. E-7A reads an injected
`killSwitch()` **again, immediately before the provider**, so a stop thrown
*after* a slip was minted still stops the call. It is not a second kill-switch
system: no state is kept and the refusal reuses the engine's own
`kill_switch_engaged`.

**That gap is closed on dev as of 2026-08-12.** When E-7A shipped there was no
*durable, authoritative* kill-switch source and the switch was a context field a
caller supplied. **E-7B1 replaced it**: `acquisition_calling_state` is a
single-row durable stop the executor reads **itself**, twice per dispatch, and
`killSwitch` is now a **forbidden** caller option — code still passing one is
refused with `caller_override_rejected` rather than quietly ignored. Proven
against dev: the bootstrap row reads `paused`, and a caller supplying
`killSwitch: () => ({ engaged: false })` was refused. **Production still has no
such row**, where an absent row reads as STOPPED.

### 10.10 Proof

`node scripts/acquisition-dial-proof.js` — offline, fictional, in-memory. Prints
**DRY EXECUTION / NO CALL SENT**, shows the exact submission a provider would
receive, then demonstrates replay refusal, destination-substitution refusal, and
the default disabled executor's refusal. It reads no credentials, contacts
nothing, and writes nothing anywhere.

**57 offline tests** in `test/acquisition-dial-execution.test.js`, covering the
forgery matrix, replay, concurrency, expiry, the provider contract, the network
ratchets and the live-call impossibility ratchet.

### 10.11 What E-7B still needs

1. ~~**Durable single-consumption**~~ — **DONE ON DEV (E-7B1, 2026-08-12).**
   The partial unique index arbitrates, proven by a two-process race.
   **Production: outstanding.**
2. ~~**A durable kill switch** the executor reads rather than is handed~~ —
   **DONE ON DEV (E-7B1, 2026-08-12).** **Production: outstanding.**
3. **A real provider adapter**, marked live, which will deliberately fail the
   live-call ratchet until somebody updates it on purpose.
4. **DNCR-1 operational readiness** — activation, a real wash, an attestation.
5. **An explicitly founder-authorised live proof**, to one number, once.

**The SQL E-7A predicted, and what was actually built.** E-7A sketched "a
uniquely-constrained dispatch record — either a new `acquisition_dial_executions`
table with `unique (authorisation_id)`, or `acquisition_call_queue` gaining
`dispatched_at` and `execution_id`". **LAQ5 took the first option and went
further**: `unique (authorisation_id)` alone would have stopped one
authorisation being spent twice, and nothing else. It would not have stopped two
*different* authorisations for the same business, or two different businesses
sharing one handset. So the load-bearing constraints are the two **partial**
unique indexes on `(prospect_id)` and `(destination_e164)` `where resolved_at is
null`. The invariant held either way: **an INSERT that violates uniqueness is
the second dispatch being refused by the database**, not by application memory —
and on 2026-08-12 that is exactly what two racing OS processes saw.

---

## 11. E-7B1 — closed as engineering on dev, 2026-08-13

**Status: CLOSED ON DEV. E-7 REMAINS OPEN. NOTHING HERE CAN CALL ANYBODY.**

E-7A left two questions it could not answer in one process: what stops a second
process spending the same authorisation, and where does an emergency stop live
that a caller cannot decline to pass in. E-7B1 answers both with a database
constraint and a durable row, and both answers were checked against real
Postgres rather than asserted.

### 11.1 What was proven, and how

| | |
|---|---|
| **Two-OS-process race** | pids 16700 and 2092, two connections, no shared memory, both busy-waiting to one wall-clock instant, same business, same handset. **One CLAIMED, one CONFLICT (prospect).** One row. Postgres arbitrated — this is not a claim about Node's event loop |
| T1 replay | same `dispatch_id` again → `ALREADY_CLAIMED` |
| T2 prospect lock | same prospect, different dispatch, different number → `CONFLICT`, scope `prospect` |
| T3 destination lock | different prospect, same number → `CONFLICT`, scope `destination` — the case a per-prospect lock cannot see |
| T4 | proven **structurally**, not written: both partial indexes confirmed to hold nothing matching it. A successful claim would leave a second permanent row and only one is approved |
| durable stop | read back `paused`, revision 1, attributed — and reported as a **decision**, not a read failure |
| caller override | a supplied `killSwitch` was refused with `caller_override_rejected`. It is a **forbidden** option, not an ignored one |
| the proof row | `resolved_at` null, `resolution` null, `provider_status` pending, holding both locks. **No provider result can release it** |
| **live schema** | **14/14 PASS**, read-only, 2026-08-13 — both partial unique index predicates, both guard triggers BEFORE / ROW / UPDATE+DELETE / correct function / **enabled**, the singleton, and calling PAUSED |

`23 passed, 0 failed` in the scripted proof, `6/6` in the race, `14/14` in the
schema verification, **2428 tests green across the whole repository**.

### 11.2 The two defects found, both in the PROOF rather than the code

Recorded because a milestone that reports only its successes teaches nothing.

1. **The harness store shim carried a hand-transcribed copy of the store
   contract that had drifted from it** — naming `getProspect`/`listProspects`,
   which the contract does not have, and omitting `findRequest`, `loadProspect`
   and `findProspects`, which it does. `assertStoreContract` threw and every
   calling-state read came back `acquisition_calling_state_unavailable`. **The
   system was right** — an unusable store must block — but a proof that fails
   for its own reasons proves nothing. The shim now derives the list from
   `STORE_METHODS`.
2. **The read-only verifier matched trigger definition TEXT** against
   `'%BEFORE UPDATE OR DELETE%'`, the phrase the migration uses.
   `pg_get_triggerdef` reconstructs definitions in Postgres's canonical event
   order, so dev renders `BEFORE DELETE OR UPDATE` and the check reported
   `**FAIL**` against a correct schema. It was testing the printer. It now reads
   `tgtype` bits and `tgenabled`, and a ratchet rejects any future phrase match.

Neither defect was in `acquisition-dispatch-store`, `acquisition-calling-state`,
`acquisition-dial-execution` or LAQ5. **Nothing was changed to make a proof
pass.**

### 11.3 What closing E-7B1 does NOT mean

- **E-7 is still OPEN and gate 14 is still RED.** A call needs `state = enabled`
  **and** a provider with `live: true`. This milestone made the first lock
  **real** rather than absent. It did not open it, and it built no enable path.
- **No live provider exists.** Every constructible provider reports
  `live: false`; a ratchet fails the build if one declares otherwise.
- **Calling has never been enabled.** The state row has read `paused` since
  creation and its revision is still **1** — no write has ever touched it.
- **Production has no acquisition schema at all**, so laq1–laq5 all remain
  unapplied there and the durable claim correctly throws.
- **DNCR-1 is unchanged and is still the only blocker that stops a first call
  outright** — the Access Seeker application is in, activation has not come
  back, and no real wash or attestation exists.
- **A-L2 is unchanged.** The holiday calendar is a hand-compiled 2026-only
  fixture, `authoritative: false`, and from 2027-01-01 the gate refuses every
  date.

---

## 12. E-7B2A — the Retell provider that cannot call, 2026-08-13

**Status: COMPLETE, OFFLINE. E-7 REMAINS OPEN. Calling is PAUSED at revision 1.**

### 12.1 The audit finding that reframed it

The milestone was scoped as a cross-repository integration against
`C:/Users/HyperBit/Documents/GitHub/call-recorder`, with a hard stop if changes
were needed there.

**There is no second repository.** Both working copies point at the same
remote, `github.com/Foxtrot15/call-recorder.git`. They are two checkouts of one
repository on different branches — ours, and
`feature/locksmith-pilot-m7e-live-diagnostics-validation`.

The boundary is therefore **cross-branch, and mostly already crossed**:
`retell-adapter.js` (with `createPhoneCall`), `voice-platform-port.js`,
`config/retell.js` (with `canPlaceCall`) and `retell-webhook-handler.js` are
**already on the acquisition branch**, the last two byte-identical to M7E. The
32 commits M7E has that we do not are diagnostics and sandbox work, none of it
required to place an outbound call.

**Nothing outside this working tree was modified, and nothing needed to be.**

### 12.2 The decision the milestone turns on

`voice-platform-port.js` marks `provider_timeout`, `provider_unreachable` and
`provider_error` as **retryable** — "may be retried with the same idempotency
key". For an onboarding call to a client who asked for one, that is right.

**For a cold acquisition call it is the precise mechanism by which one
authorisation becomes two telephone calls to a business that never asked to hear
from us.** A timeout cannot distinguish *never arrived* from *arrived, placed
the call, and the answer was lost*.

So the acquisition provider **discards `retryable` entirely** — not read, not
mapped, not passed upward, with a test asserting the flag never appears on a
result. An ambiguous answer is **raised**, not returned, because the executor's
contract is that a throwing provider yields `provider_status: 'unknown'` with no
`submitted_at` — the one status laq5 permits to stand alone. Returning a refusal
instead would assert we definitely reached the provider, and would be a lie in
the ledger.

`RETELL_MAX_RETRIES` exists in `config/retell.js` (default 2). Nothing reads it.

### 12.3 Why it still cannot call anybody

| | |
|---|---|
| `live` | the literal `false`. Not a parameter — a caller passing `live: true` gets `false` |
| transport | **injected, and nothing constructs one.** A ratchet walks every `acquisition-*.js` and fails if any caller appears, or if any of them imports `./retell-adapter` |
| without a transport | `submit()` refuses with `acquisition_retell_transport_absent` |
| imports | only `./acquisition-dial-provider`. No http, https, net, tls, fetch, axios, twilio, retell-sdk |
| environment | never read. No key, token, SID or host appears in the code |
| the E-7A registry | **untouched** — still exactly `createDisabledDialProvider` and `createFakeDialProvider`, which is why the provider lives in its own file rather than relaxing that ratchet |
| the durable stop | proven to yield **zero** submissions while paused, and zero when the state row is missing, even with a perfectly good provider wired |

### 12.4 The correlation gap — found by a founder check, fixed before push

E-7B2A was first built with the provider receiving `executionId` and **not**
`dispatchId`. That looked adequate and was not: `executionId` is `ex_` plus a
20-hex truncation of `sha256(dispatchId)`, a **one-way** derivation. If the
create-call response were lost, `provider_ref` would never be written and a
webhook arriving later would carry a `call_id` we had never seen, matchable only
by listing unresolved rows and recomputing the executor's private hash for each
— a second copy of a derivation that must never diverge, and a scan where a
lookup belongs.

**The founder's pre-push check caught it, and it is now fixed.** The exact LAQ5
`dispatchId` travels verbatim in `metadata.aida_dispatch_id` — not hashed, not
truncated, not derived, not caller-supplied — with `aida_execution_id` retained
beside it for logs. `buildRetellCallPayload` **refuses to build a payload
without the durable key**, so an unreconcilable request is unbuildable rather
than merely unusual.

A ratchet pins `metadata.aida_dispatch_id === slip.dispatchId` and explicitly
rejects the executionId, the authorisationId, a hash of the dispatchId and a
truncation of it as substitutes. Substituting `executionId` in the source fails
six tests, including the end-to-end lost-response scenario.

**The E-7A provider-contract test was widened deliberately**, not incidentally:
its closed-world key list now admits `dispatchId`, with the argument recorded in
place that a dispatch id is an **identity, not a permission** — the locks are
held by the row, the row is written by the executor, and no provider result can
release it.

### 12.5 The agent is a new agent, not a reused one

`locksmith-receptionist-compiler.js` serves a locksmith's **inbound** callers.
`locksmith-onboarding-agent-compiler.js` interviews a **consenting client**.
Neither identifies itself to a stranger, handles an objection, honours an
opt-out or records a callback, and cold acquisition needs all four. A **third,
purpose-built acquisition agent** is required. **None was created** — that is a
network write, and it belongs to E-7B2B. AI disclosure wording remains
deliberately uninvented.

Also recorded: `not_interested`, `declined`, `opt_out` and `callback_requested`
are **not** disconnection reasons. Every one of them ends the call as
`user_hangup` or `agent_hangup`, so they can only come from post-call analysis.
**How an opt-out is confirmed from a transcript is an open decision with
permanent, append-only consequences, and E-7B2A does not make it.**

---

## 13. E-7B2B1 — the return path, and the gap it found, 2026-08-13

**Status: COMPLETE, OFFLINE. E-7 REMAINS OPEN. Calling PAUSED at revision 1.
No agent provisioned. No number provisioned. No route exposed. No SQL.**

### 13.1 A NEW BLOCKER THIS MILESTONE FOUND

**Nothing in the pipeline makes a prospect contactable, so no outcome could be
recorded today.**

`acquisition-outcome` refuses anything not `queued`, `attempted`, `connected` or
`callback_requested`: *"no call could have been made to it, so there is no
outcome to record."* The lifecycle is `review_approved → queued → attempted`,
and **no batch selection sets `queued`; no dispatch sets `attempted`.**

The refusal is **safe** — nothing is written, both locks stay held, an operator
sees an unresolved dispatch — and it is now proven rather than assumed. But it
is a real gap on the path to a first call, and it belongs to the **dispatch**
side: a webhook asserting "a call was attempted" would be the wrong module
making that claim. **E-7B2B must close it.**

### 13.2 What was built

| | |
|---|---|
| agent contract | Local specification only. Identity, purpose, behaviour, prohibitions. **No agent created, no endpoint named, no credential read** |
| AI disclosure | **Deliberately undecided.** `decided: false`, `wording: null`. Inventing it would manufacture a compliance position nobody adopted |
| analysis schema | Closed enum + validator. **Prose is never the durable outcome** |
| correlation | `metadata.aida_dispatch_id` → **direct primary-key lookup**. No scan, no hash recomputation. A missing or unknown id writes nothing and guesses no prospect |
| call-id binding | One dispatch, at most one `call_id`. A conflicting id is **refused**, never overwritten |
| lost response | `provider_ref` bound after the fact; `provider_status` stays `unknown` because the laq5 guard makes it forward-only — and `unknown` remains the truth about what we knew when we submitted |
| ordering | Outcome first, lock second, through the service that already owns it |

### 13.3 The two refusals that matter most

**A hang-up is not an answer.** `call_ended` settles only `no_answer`,
`voicemail` and `dial_busy`. `user_hangup`, `agent_hangup`, `inactivity`,
`error` and `dial_failed` write **nothing** — because `call_ended` routinely
arrives before `call_analyzed`, outcomes are append-only, and a technical fact
written early cannot be corrected by the authoritative one later.

**An opt-out is held to a higher standard than anything else.** It needs
`confidence: high` **and** transcript evidence, or the whole analysis is
returned for human review — **not downgraded to a decline, not dropped**. An
opt-out written in error is permanent and append-only; one missed is corrected
by the next conversation. Those costs are not equal, so the rule leans towards
refusing. `not_interested`, `declined` and `opt_out` remain **distinct**, and a
callback is never a suppression.

### 13.4 Reported, not fixed

- **`provider_ref` has no unique index.** Two dispatches sharing one Retell
  `call_id` is refused by application logic and made implausible by single-use
  dispatch, but **the database does not prevent it**. Adding
  `unique (provider_ref) where provider_ref is not null` is defence in depth for
  **E-7B2B** and needs founder approval, so it is not written.
- **`lpm3` must be applied wherever acquisition webhooks are processed.** The
  durable fingerprint idempotency lives there and is not part of laq1–laq5.
