# Acquisition Blocker Register — the one current list

**Status of this document:** LIVE. Last recomputed **2026-08-08 (M8J)**.

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
| **A-L6** | Attempt cap, retry spacing, recent-contact cooldown | **OPEN** | `attempt_policy_unapproved` blocks **every** prospect. Binding. |
| **A-L7** | Does a no-answer or a voicemail consume an attempt? | **OPEN** | M8J built the counting so it can go either way and **decided nothing**. `ATTEMPT_CONSUMPTION.no_answer/.voicemail` carry `approved: false`; a ratchet fails the build if they flip without a recorded approval. Bundled into A-L6's gate. |
| **A-L8** | The "not interested" cooldown duration (and `declined`, `callback`) | **OPEN** | Proposed 180 / 90 / 14 days, unapproved. Bundled into A-L6's gate. |
| **A-L4** | Are the approved A-L6 numbers the intended *commercial* policy? | **OPEN** | Caps applied as ceilings; a campaign may be stricter, never looser. Not blocking. |
| **A-L9** | Who besides the founder may approve a batch; is a second approver needed above a threshold? | **OPEN** | Single named founder, `maxBatchSize: 25`. Governance, not blocking one call. |

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
| ~~**E-2**~~ | Persist the review decision onto the prospect lifecycle | **CLOSED in M8J.** `transitionProspectLifecycle` is a compare-and-set; `acquisition-review-projection.js` projects the durable decision and repairs a lag without recording a second decision. |
| **E-3** | Durable DNCR wash storage | **OPEN.** There is no wash table and no `dncr` column anywhere; the wash store is an in-process `Map`, so a wash does not survive a restart. Needs LAQ4. |
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

Dev holds **20 fictional proof rows** across M8D/M8E/M8G/M8H/M8I. See
[ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md) §9.

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

Recomputed 2026-08-08, after M8J.

| # | Gate | Before M8J | After M8J | Why |
|---|---|---|---|---|
| 1 | Prospect persisted | 🟢 | 🟢 | M8G; proven against real Postgres |
| 2 | Ambiguous candidates reach a human | 🟢 | 🟢 | M8H queue, M8I concurrency-safe |
| 3 | Record complete + valid | 🟢 | 🟢 | `assessProspect`; timezone mandatory in code and in `laq1` |
| 4 | **Reviewed → `review_approved`, durably** | 🔴 | 🟢 | **E-2.** Compare-and-set transition + projection + reconciliation; `approve_as_new` now actually persists the prospect, which it never did |
| 5 | Qualified | 🟢 | 🟢 | Ordering only, never permission |
| 6 | Duplicates resolved | 🟠 | 🟠 | Default-deny, but `duplicateResolution` is caller-supplied |
| 7 | DNCR-cleared | 🟠 | 🟠 | Port complete and fail-closed. Needs **DNCR-1** and **E-3** |
| 8 | Permitted day/time | 🟠 | 🟠 | Fully implemented. Needs **A-L1**, **A-L2**, **A-L3** |
| 9 | **Attempts permitted** | 🟠 | 🟠 | **Engineering input is now genuinely durable (E-1).** Still AMBER, and only because **A-L6 / A-L7 / A-L8** are unapproved — which is a decision, not a defect |
| 10 | Not suppressed | 🟢 | 🟢 | Append-only, DB-enforced, cross-process proven |
| 11 | Campaign / kill switch | 🟢 | 🟢 | Own precedence in gate and engine |
| 12 | Founder batch approval | 🟠 | 🟠 | See §5. AMBER for one attended call; RED beyond that. **E-5**, **A-L9** |
| 13 | Final M8E authorisation | 🟢 | 🟢 | Durable suppression **and now durable history**; unforgeable slip; fails closed on either read |
| 14 | Future dial request | 🔴 | 🔴 | **E-7.** No dialler, by design |

**One RED remains, and it is the one that should be last.** Gate 4 moved
RED → GREEN. Gate 9's amber is now purely a policy amber: the code counts real
attempts from real rows and refuses when it cannot read them.

---

## 7. The shortest honest path to one call

1. **A-L1** — counsel sign-off. Nothing moves without it.
2. **A-L6 / A-L7 / A-L8** — founder decides the caps and the two open outcome
   questions. One approval object, named approver.
3. **DNCR-1** — the account and the attestation procedure; then one imported
   wash. **E-3** if it must survive a restart.
4. **A-L2 / A-L3** — the holiday source. Has its own 2027-01-01 deadline.
5. **E-7** — the dialler, accepting only an `AuthorisedDial`.

**E-5** sits alongside 5, and **M-5** is not on this path at all.

Items 1–4 are decisions with lead times. Only item 5 is code.
