# Acquisition Blocker Register — the one current list

**Status of this document:** LIVE. Last recomputed **2026-08-10**, after **E-5**
closed (durable founder batch approval, no SQL) and after the founder approved
the attempt policy (**A-L6 / A-L7 / A-L8 closed**, approval
`AL6-AL7-AL8-2026-08-10`).

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
a hardcoded `false` with no environment override, no execution verb exists in
the acquisition tree, and four ratchets fail the build if one appears. The items
below are what would still have to be true *if* one did.

---

## 1. Legal / counsel — nobody in engineering can close these

| ID | Blocker | Status | Effect while open |
|---|---|---|---|
| **A-L1** | Counsel sign-off on the permitted calling window | **OPEN** | `counsel_approval_missing` blocks **every** prospect. Binding. |
| **A-L2** | An authoritative public-holiday source, and which state calendars are carried | **OPEN** | Hand-compiled fixture, national + VIC, `authoritative: false`, covering **2026 only**. From **2027-01-01 the gate refuses every date.** Also **M-6**. |
| **A-L3** | Are AFL Grand Final Friday and other proclaimed holidays in scope? | **OPEN** | Absent from the fixture rather than guessed, so those dates read as ordinary. |
| **A-L5** | Do 1300/1800 numbers carry the same DNCR obligations as geographic ones? | **OPEN** | Treated identically — everything is washed. Conservative. |
| **DNCR-1** | Who holds the DNCR account, performs the wash, and may attest an import | **OPEN** | No wash can enter the system, so `dncr_not_checked` blocks every prospect. |

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
| **M-4** | Re-run eligibility at the moment of dialling | **MECHANISM DONE (M8E), NO CALLER.** `createDialAuthoriser` re-runs the whole engine at the authorisation instant against durable suppression (M8E) and durable contact history (M8J). It has no caller because there is no dialler. Closes when **E-7** lands and uses it. |
| **M-5** | `service_area` / `operating_status` capture path | **OPEN.** The discovery contract derives neither. |
| ~~**M-6**~~ | Authoritative public-holiday source | **OPEN** — tracked as **A-L2**, because the blocker is the source decision, not the code. |
| ~~**M-7**~~ | Cross-process suppression visibility | **CLOSED in M8E.** Proven across two real processes against dev Postgres. |
| ~~**E-1**~~ | Derive attempt history from `acquisition_contact_outcomes` | **CLOSED in M8J.** `acquisition-history.js` is the one derivation; the authoriser reads it every time and refuses on `contact_history_unavailable`. Proven read-only against real Postgres, 16/16, zero residue. |
| ~~**E-2**~~ | Persist the review decision onto the prospect lifecycle | **CLOSED in M8J.** `transitionProspectLifecycle` is a compare-and-set; `acquisition-review-projection.js` projects the durable decision and repairs a lag without recording a second decision. Proven against real dev Postgres 2026-08-09 under founder approval — a `review_approved → review_pending → review_approved` round trip on one existing fictional row; post-run verification 16/16, zero further residue. **No row created anywhere**; the approved residue was 2 history entries and a bumped `updated_at`. |
| ~~**E-3**~~ | Durable DNCR wash storage | **CLOSED ON DEV in M8K — proven restart-safe against real Postgres.** `laq4` applied to dev 2026-08-10; **not applied to production**. An attested wash persisted on dev was read back by **two genuinely separate OS processes**, gave the same answer both times, and the *same row* evaluated 42 days after the wash decays to `unknown` and refuses with `dncr_wash_stale` — **without any row changing**, because freshness is computed at read time. 33 read-only checks, zero residue. The path fails closed: an unreadable ledger yields `dncr_store_unavailable`, kept distinct from "never checked", never an empty Map read as success. 39 offline tests cover the states dev's single row cannot be in. **Open for production**, which has no acquisition schema at all. |
| ~~**E-5**~~ | Durable batch approval | **CLOSED in E-5, offline — no SQL required.** A founder approval is now an append-only row in `acquisition_decisions` (`entity_type: 'batch'`, which the laq1 CHECK has admitted since it was written), keyed by `ba_<membershipHash>` — an identity derived from the membership itself. `acquisition-authorisation` destructures `context.batch` off the caller's context and **discards** it; the approval is read from the store or it does not exist. Proven across two genuinely separate OS processes, 9/9 and 26/26, **zero database residue**. See §5. |
| **E-6** | `service_area` / `operating_status` — same item as M-5 | **OPEN.** |
| **E-7** | The dialler, accepting only an `AuthorisedDial` slip | **ABSENT BY DESIGN.** Nothing to fix; nothing to build until §1 and §2 close. |

---

## 4. What is applied where

| | dev (`wvwemitmmsdytyutaqbm`) | production |
|---|---|---|
| `laq1_create_acquisition_prospects.sql` | **applied** 2026-08-07 (M8D) | **not applied** |
| `laq2_create_acquisition_queue.sql` | **applied** 2026-08-07 (M8D) | **not applied** |
| `laq3_serialise_decision_chain.sql` | **applied** 2026-08-08 (M8I) | **not applied** |
| `laq4_create_dncr_washes.sql` | **applied** 2026-08-10 (M8K) | **not applied** |

Dev holds **21 fictional proof rows** across nine tables (M8D/M8E/M8G/M8H/M8I,
plus M8K's one wash row). See [ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md)
§9 and §11.7.

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
| 6 | Duplicates resolved | 🟠 | 🟠 | Default-deny, but `duplicateResolution` is caller-supplied |
| 7 | DNCR-cleared | 🟠 | 🟠 | **E-3 closed on dev** — storage is durable, restart-safe and fail-closed, proven against real Postgres. Still AMBER, and now for **one** reason rather than two: **DNCR-1**, nobody holds a Register account, so no real wash exists to store |
| 8 | Permitted day/time | 🟠 | 🟠 | Fully implemented. Needs **A-L1**, **A-L2**, **A-L3** |
| 9 | **Attempts permitted** | 🟠 | 🟢 | **A-L6 / A-L7 / A-L8 approved.** The values are decided and cited, the count comes from durable rows, a decline is permanent, and the policy refuses to call itself approved while anything inside it is not. No engineering deficiency remains |
| 10 | Not suppressed | 🟢 | 🟢 | Append-only, DB-enforced, cross-process proven |
| 11 | Campaign / kill switch | 🟢 | 🟢 | Own precedence in gate and engine |
| 12 | Founder batch approval | 🟠 | 🟢 | **E-5 closed.** Durable, restart-safe and proven across two OS processes. `context.batch` is discarded by the gate; the approval is read from `acquisition_decisions` or it does not exist. Membership-bound, so a compliance change does not fake staleness. **A-L9** is still open but is governance, not a defect |
| 13 | Final M8E authorisation | 🟢 | 🟢 | Durable suppression **and** durable history; unforgeable slip; fails closed on either read |
| 14 | Future dial request | 🔴 | 🔴 | **E-7.** No dialler, by design |

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

**One RED remains, and it is the one that should be last.**

---

## 7. The shortest honest path to one call

1. **A-L1** — counsel sign-off. Nothing moves without it.
2. **DNCR-1** — the account and the attestation procedure; then one imported
   wash. Somewhere durable to put it already exists (**E-3**, closed on dev),
   and `scripts/acquisition-dncr-import.js` loads it.
3. **A-L2 / A-L3** — the holiday source. Has its own 2027-01-01 deadline.
4. **E-7** — the dialler, accepting only an `AuthorisedDial`.

**M-5** is not on this path at all. **A-L10** is not on it either: a business
that has never been called has no history for an uncounted-redial ceiling to
bound.

~~**E-5**~~ left this list on 2026-08-10, closed. ~~**A-L6 / A-L7 / A-L8**~~ left
it the same day, approved.

**Item 4 is now the only engineering work left before a call**, and it is the one
that should be built last.

Items 1–3 are decisions with lead times. Only item 4 is code.
