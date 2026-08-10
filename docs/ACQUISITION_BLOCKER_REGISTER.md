# Acquisition Blocker Register — the one current list

**Status of this document:** LIVE. Last recomputed **2026-08-10**, after the
founder approved the attempt policy (**A-L6 / A-L7 / A-L8 closed**, approval
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
| **A-L9** | Who besides the founder may approve a batch; is a second approver needed above a threshold? | **OPEN** | Single named founder, `maxBatchSize: 25`. Governance, not blocking one call. |

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
| **E-5** | Durable batch approval | **OPEN.** `context.batch` is caller-supplied; there is no batch table. See §5. |
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

**M8J's E-2 proof added none of them.** It is the only exercise so far that
UPDATEd an existing row rather than appending one: two entries on
`pr_3740207ebbc0a379910f`'s `history` journal and a bumped `updated_at`, with
the lifecycle left exactly where it was found. The total is still **20**,
`acquisition_decisions` is still **4**, and no append-only table was touched.

---

## 5. E-5, and whether it blocks a FIRST call

Asked directly, because the previous audit called it blocking without examining it.

**It is not a hard blocker for one deliberately selected, founder-approved
first call. It is a scale and governance blocker.**

The batch machinery exists and works: `acquisition-batch.js` assembles, hashes
and detects staleness, and the eligibility engine refuses
`founder_batch_approval_missing` unless `context.batch.approved === true` with a
non-stale hash. What does not exist is a *table* — the approval lives in the
object the caller passes.

For one call, under a founder who is present, that is a real but bounded
limitation: the approval is in the same process that authorises the dial,
seconds apart, and the M8E slip is minted from an engine that saw it.

It becomes a blocker the moment either is true:

- **the approving process is not the authorising process** — a batch approved
  this morning and dialled by a worker this afternoon has no durable approval to
  read, and the worker would be constructing one;
- **more than a handful of calls** — nobody can attest afterwards which
  businesses a given approval actually covered, because the approval was never
  written down. That is the same class of gap E-2 just closed for review
  decisions.

So: **AMBER for the first controlled pilot call, RED before any unattended or
repeated dialling.** It was deliberately not built in M8J because it is separable
from E-1 and E-2 — neither depends on it — and building it would have meant new
SQL that the milestone explicitly preferred to avoid.

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
| 12 | Founder batch approval | 🟠 | 🟠 | See §5. AMBER for one attended call; RED beyond that. **E-5**, **A-L9** |
| 13 | Final M8E authorisation | 🟢 | 🟢 | Durable suppression **and** durable history; unforgeable slip; fails closed on either read |
| 14 | Future dial request | 🔴 | 🔴 | **E-7.** No dialler, by design |

**Gate 9 moved AMBER → GREEN.** Its amber was always a policy amber rather than
a defect, and the policy has now been decided.

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

**E-5** sits alongside 4, and **M-5** is not on this path at all. **A-L10** is
not on it either: a business that has never been called has no history for an
uncounted-redial ceiling to bound.

~~**A-L6 / A-L7 / A-L8**~~ left this list on 2026-08-10, approved.

Items 1–3 are decisions with lead times. Only item 4 is code.
