# AIDA Locksmith Acquisition — the acquisition engine (A1 · A2 · M8B · M8C)

**Status:** built dormant, **not deployed**. SQL **applied to dev** — `laq1` +
`laq2` (M8D, 2026-08-07) and `laq3` (M8I, 2026-08-08) — **none to production**.
No website crawled, no external API called, no number washed, no call placed.
**Scope:** the whole pipeline from sourced lead to a callable queue candidate —
discovery, source identification, evidence capture, human review, normalisation,
deduplication, qualification, the compliance gate, permanent suppression, founder
batch approval, the dormant call queue, and contact outcomes.
**Owns (source of truth for):** the acquisition vocabulary, the offline
boundary, the discovery adapter contract, the evidence ledger, the append-only
decision log, the prospect lifecycle, the human review step, the qualification
model, the queue boundary and the outcome model.

> **Dated update — 2026-08-10 (A-L6 / A-L7 / A-L8).** The founder has approved
> the outbound attempt policy (approval `AL6-AL7-AL8-2026-08-10`). **2 counted
> attempts** per business, **2 days** minimum spacing; a **no-answer does not**
> consume a counted attempt and a **voicemail does**; `not_interested` and
> `declined` are **permanent no-recontact** rather than 180-/90-day cooldowns,
> stay distinct labels, and are **not** recorded as opt-outs; an explicitly
> requested **callback is honoured for 14 days** and then fails closed; the
> generic **30-day post-contact cooldown is retired**. **No SQL was required** —
> the permanence is a predicate over rows `acquisition_contact_outcomes` already
> stores. `attempt_policy_unapproved` no longer blocks when the approved policy
> is supplied. See §42; every table below dated earlier is a snapshot.
>
> **Dated update — 2026-08-08 (M8J).** Two undocumented first-call blockers are
> closed. **E-2**: a persisted prospect can now durably reach review_approved
> through a compare-and-set projection of the durable review decision — before
> this, nothing wrote the lifecycle column at all and every persisted prospect
> was permanently `discovered`. **E-1**: attempt history is now derived from
> `acquisition_contact_outcomes` by one authoritative path, and the final gate
> refuses to authorise when it cannot be read. **A-L7 remains open and M8J
> deliberately did not answer it** — see §41.5. There is now ONE live blocker
> list, [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md); the tables in §A2.9, §24 and §34 are milestone snapshots and
> are labelled as such.
>
> **Dated update — 2026-08-08 (M8I).** The decision chain is safe for concurrent
> writers, and the safety is in Postgres rather than in Node: `laq3` adds
> `unique (prev_hash)` to `acquisition_decisions`, applied to dev and proven with
> two genuinely overlapping processes. **§39.6's SINGLE WRITER limitation is
> closed** — see §40, which also records why a lock, a serialisable transaction
> and an RPC were each rejected, and what would have to change if the chain is
> ever partitioned.
>
> **Dated update — 2026-08-07 (M8C).** Acquisition state is now durable: see
> §25 onward. Three defects were found and fixed before any SQL was applied,
> the most serious being a business-scoped opt-out that recorded the dialled
> number and never compared it (§26 D3). Both migrations are **applied to dev**
> as of M8D (2026-08-07) and **not to production**;
> [ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md) owns how to apply them.
>
> **Dated update — 2026-08-07 (M8B).** Two corrections to what this document
> previously said. (1) The section headed *"A2 (in progress, uncommitted)"* was
> stale: A2 was committed in `1794af3`, and every module it described is in the
> tree with tests. (2) A1's claim that the pipeline stops at review is no longer
> the whole picture — §15 onward describes what M8B added. Nothing was removed
> or weakened; the offline boundary, the compliance precedence and the
> suppression semantics are unchanged.

> **Companion documents.** [OUTBOUND_BDM_ARCHITECTURE.md](OUTBOUND_BDM_ARCHITECTURE.md)
> owns *which* compliance gates exist and *why* (Australian law, §2/§5).
> [OUTBOUND_BDM_COMPLIANCE_ENGINE.md](OUTBOUND_BDM_COMPLIANCE_ENGINE.md) owns the
> reusable gate-engine contract. This document owns what was actually **built**
> for the locksmith pilot's acquisition track, and it does not restate the law —
> where a rule is cited here, that document is the authority.

---

## 1. The permanent principle

The acquisition engine must not become a scrape-and-blast system. It is a
controlled, auditable pipeline:

```text
Business discovered
        ↓
Official business source identified          ← A1
        ↓
Business identity and phone evidence captured
        ↓
Source and context human-reviewed
        ↓
Phone number normalised
        ↓
Duplicates resolved
        ↓
DNCR wash performed                          ← A2
        ↓
Internal suppression checked
        ↓
Calling-policy checks applied
        ↓
A plain-language eligibility decision produced
        ↓
Founder explicitly approves a campaign batch
        ↓
AIDA may call later
        ↓
Every attempt, outcome and opt-out is audited
```

**A1 delivers the first four steps.** Everything below the line is A2 and
beyond. The load-bearing consequence, asserted by test: *an approved prospect is
not a callable prospect.* Review approval means a human accepted the identity
and the source. Nothing more.

## 2. What was built

| File | Purpose |
|---|---|
| `src/config/acquisition.js` | Flags (all default OFF) and **the offline boundary** |
| `src/services/acquisition-schema.js` | The shared vocabulary — every enum, in one place |
| `src/services/acquisition-source.js` | Official business source identification |
| `src/services/acquisition-evidence.js` | The append-only evidence ledger |
| `src/services/acquisition-audit.js` | The append-only, hash-chained decision log (G17) |
| `src/services/acquisition-prospect.js` | The prospect domain model and state machine |
| `src/services/acquisition-discovery.js` | The discovery adapter contract |
| `src/services/acquisition-discovery-fixture.js` | The one adapter that ships: a deterministic fixture |
| `src/services/acquisition-review.js` | Human review of source and context |
| `supabase/sql/laq1_create_acquisition_prospects.sql` | Four additive tables — **applied to dev in M8D**, not to production |
| `scripts/acquisition-dry-run.js` | Offline end-to-end walkthrough |

Six test files (`test/acquisition-*.test.js`) cover the above.

## 3. The offline boundary

The single most important design decision in A1.

`EXTERNAL_ACCESS_SUPPORTED` in `src/config/acquisition.js` is a **hardcoded
`false`**. It is not read from the environment and there is deliberately no
environment variable that can flip it. Every external system the engine will
eventually need is named explicitly and individually disabled:

```js
EXTERNAL_SYSTEMS = { web_fetch, search_api, directory_api,
                     business_register, dncr_api, telephony, messaging }  // all false
```

Three independent mechanisms enforce it:

1. **`assertExternalAccessAllowed(system, why)`** throws for every system, and
   refuses unknown system names by default rather than passing them through.
2. **The discovery registry refuses network adapters.**
   `registerDiscoveryAdapter` requires every adapter to declare
   `requiresNetwork: true | false` — an adapter that will not say is rejected —
   and throws if a `true` adapter is registered while the boundary is closed.
   The registration fails; it does not register-then-warn.
3. **The database refuses live-captured evidence.** `capture_mode`'s CHECK
   constraint omits `'live_fetch'`, and `validateEntry` rejects it before the
   write. Even if a future adapter forgot its gate, the evidence it produced
   could not be stored.

> **Why a constant and not a flag.** "We have not written the crawler yet" is a
> state that changes the moment somebody writes a crawler. "The registry rejects
> network adapters, and the constant that would permit them is hardcoded with no
> env override" is a state that changes only through a reviewable code change
> that deletes a line with a comment explaining why it exists. A flag named
> `ACQUISITION_LIVE=true` in a production environment is not a review.

## 4. Flags

All strict-parse (only the exact string `"true"` enables — the D7 house rule)
and all default **OFF**.

| Flag | Default | Governs |
|---|---|---|
| `ACQUISITION_ENABLED` | OFF | The master switch. Discovery, review and (in A2) wash and eligibility all check it |
| `ACQUISITION_REVIEW_ENABLED` | OFF | The human review workflow |
| `ACQUISITION_DNCR_MODE` | `disabled` | `disabled` \| `fixture` \| `import`. **There is no `live`** |

`acquisitionReady(capability, env)` is the single predicate the pipeline uses.
It requires the master switch **and** the specific capability, and returns a
reason when refusing — a silent `false` is impossible to debug.

`ACQUISITION_DNCR_MODE=live` is the plausible typo that matters, so it is
handled explicitly: it resolves to `disabled` and reports a **config fault**
rather than throwing. A misconfiguration must degrade to "cannot call anybody",
not to "the server will not boot" — and must never silently accept a mode
nobody validated.

## 5. Source authority — what counts as official

A phone number copied from an aggregator is the single most common way an
outbound system dials a number that was reassigned two years ago. Aggregators
republish stale data indefinitely and have no correction path. So source tier is
a first-class concept, and only two types are **official**:

| Tier | Types | Official? |
|---|---|---|
| Strongest | `government_register`, `official_website` | **Yes** |
| Middle | `verified_directory`, `map_listing`, `unverified_directory` | No |
| Weakest | `social_profile`, `aggregator`, `unknown` | No |

Classification is a **pure function of the reference string** — no fetch, no
HEAD request, no DNS lookup. Matching is on the *registrable domain* (honouring
Australian three-label domains like `example.com.au`), so `vic.yellowpages.com.au`
cannot dodge a host-table entry.

Notable behaviours, each asserted by test:

- A **website-builder subdomain** (`*.wixsite.com`, `*.business.site`) is
  official-*with-a-caveat*, never silently trusted: the page may well be the
  business's own, but the domain is not evidence of that.
- A **front-page link** to a directory is flagged as pointing at the site, not at
  this business's listing on it.
- An operator **cannot simply assert** an official source. `{ sourceType:
  "official_website" }` with no URL is refused — that is exactly the
  unverifiable assertion this pipeline exists to prevent.
- Unreadable references are kept as a **data-quality signal**, not swallowed.

## 6. Evidence — the spine

A prospect is not "a row we found". It is a claim about a business plus the
proof we hold for it.

**`acquisition-evidence.js` has no update method and no delete method.** That is
a domain decision encoded as a missing function. A mistaken entry is superseded
by a new entry (`supersedes`), and both remain visible; a correction that points
at evidence which does not exist is refused, so the trail never has a dangling
reference.

Other enforced properties:

- **Deep-frozen rows.** A caller that tries to patch a returned row mutates
  nothing and throws in strict mode.
- **Durable-before-visible.** If the injected sink throws, the row never enters
  the ledger. A system must not believe it holds evidence it never persisted.
- **Provenance is mandatory.** Evidence with no usable source is refused — an
  assertion is not evidence.
- **Stable content hashing.** Keys are sorted at every level, so two logically
  identical entries hash identically regardless of property insertion order.
- **`authoritative` is false for fixture data, forever.** A screen can therefore
  say out loud that nothing here was verified by a human.

### Per-claim attribution, and why it is strict

Each evidence row records the source *that particular claim* came from — not the
prospect's best source. If a business name came from its own website but the
phone came from an aggregator, recording both as "official website" would
manufacture confidence the pipeline exists to withhold.

So a candidate citing **more than one source must say which source each fact
came from**. If it does not, the candidate is **refused** rather than guessed at
(`claim_source_ambiguous`). A candidate with exactly one source is unambiguous
and needs no declaration.

## 7. The decision log (G17)

`acquisition-audit.js` is the append-only master audit: every review decision,
and in A2 every gate decision and batch approval.

Evidence and decisions are **separate stores** on purpose. Evidence is about the
world and can legitimately be superseded when the world changes. Decisions are
about us and can never be revised — "we approved this on the 3rd" does not stop
being true because we later wish it were not. One table with a `kind` column
would eventually grow an UPDATE path for the evidence case that also reached the
decision rows.

Every row requires **who** (`actor`), **whether it was a person**
(`actorKind`), **why** (`reason`), what and which. `actorKind` defaults to
`system` for anything that is not exactly `"human"` — the defaulting direction
that cannot manufacture human authorisation.

**The hash chain.** Each row carries the hash of the row before it. `verifyRows`
is a *pure function over rows* — deliberately, because the rows that most need
verifying are the ones read back out of a durable store long after the writing
process exited. It detects alteration, removal and reordering, and reports the
index of the first break. A forger who edits a row *and* recomputes its own hash
still breaks the following row.

## 8. The prospect lifecycle

```text
discovered ──► evidence_captured ──► review_pending ──► review_approved
     │                │                    │      └───► review_rejected
     │                │                    │
     └────────────────┴────────────────────┴──────────► suppressed  (terminal)
```

The transition table is a **whitelist**. Everything not listed is refused —
including seemingly harmless jumps like `discovered → review_approved`, because
skipping evidence capture is exactly the shortcut that must not exist. Every
transition requires a named actor and a reason, and appends to an immutable
history.

Suppression is reachable from every state and is **terminal**: nothing brings a
suppressed prospect back, because suppression is permanent and cross-campaign by
design.

Two naming notes that matter:

- `state` on a prospect is the **Australian state** (VIC, NSW). The lifecycle is
  `lifecycle`. Conflating them would put `review_approved` in an address field.
- `timezone` is a **compliance input**, not a display field — calling hours are
  checked in the business's local time — so a prospect without one fails
  validation.

## 9. Discovery

One adapter ships: `fixture-v1`, deterministic, `requiresNetwork: false`.

The contract a future adapter must also satisfy:

1. Return **candidates**, never prospects.
2. **Declare provenance.** A candidate with no usable source is refused here,
   not stored and cleaned up later.
3. **Never guess.** A business with no published phone yields a candidate with
   no phone, which becomes a review gap — not a plausible-looking number.
4. **Be deterministic** for the same input.

There is deliberately **no discovery origin meaning "scraped" or "purchased"** —
a purchased list is exactly the artefact the permanent principle forbids.

Partial results are the expected outcome, not a failure: real datasets contain
records that cannot be used, and hiding them would hide the data-quality signal.
Every rejection carries a code and a plain-language message.

### The fixture dataset

Sixteen invented Melbourne locksmiths. Every phone number is drawn from the
ranges the ACMA reserves for fiction — geographic numbers of the form
`(0X) 5550 XXXX` and mobiles in the `0491 570 XXX` block — and every own-domain
is under RFC 2606's reserved `example.*`. A fixture in a system that will one
day place phone calls should never contain a number that could ring; this is
asserted by test, so a future addition cannot quietly introduce one.

The dataset is **deliberately messy**, because a fixture where everything is
clean proves the happy path and hides every gate. It contains a business with no
official source, a phone that came only from an aggregator, a duplicate, a
business with no phone, a premium-rate number, a short service number, an SEO
lead-generation page, a record with ambiguous claim attribution, and one whose
source is unreadable. Each exists to make a specific gate fire.

## 10. Human review

The step that makes this a controlled pipeline. Four properties:

1. **The packet shows the weaknesses first.** `blockers`, `sourceCaveats`,
   `unusableSources` and `unevidencedClaims` come before the claims in the
   object's own key order — asserted by test.
2. **Approval is not offered when the record cannot support it.** `canApprove`
   is false with a stated reason, so a UI cannot render a button it should not.
3. **Approval is also *refused*, not merely unoffered.** `recordReviewDecision`
   re-checks the same conditions against **current** evidence, not against the
   packet the reviewer was looking at. A stale packet, a UI bug and a direct API
   call all hit the same wall. This duplication is the compliance engine's
   runtime-revalidation pattern, for the same reason.
4. **Every decision is audited before it takes effect.** If the audit write
   throws, the transition does not happen.

Additional constraints: the reviewer must be a **named person** (literal
`"system"`, `"AIDA"`, `"bot"`, `"automation"`, `"auto"` are refused); a
rejection requires a **reason code**, not just free text, so the dataset can be
measured; and `needs_more_evidence` leaves the prospect waiting rather than
inventing a state whose only purpose is to be transitioned out of.

Questions are phrased as **questions**, with the context a reviewer needs held
separately from the question itself — a reviewer who is asked "is this a
locksmith?" checks; one shown a ticked box labelled "verified" agrees.

## 11. Data model

Four additive tables in `supabase/sql/laq1_create_acquisition_prospects.sql`.
**Written, not applied.**

| Table | Purpose |
|---|---|
| `acquisition_prospects` | The candidate business and its lifecycle |
| `acquisition_prospect_phones` | Published numbers, one row each |
| `acquisition_evidence` | Append-only: what we know and where from |
| `acquisition_decisions` | Append-only, hash-chained: what we decided |

Encoded contracts:

- **RLS enabled in the same transaction** on all four (D8), with **no
  policies** — service_role only.
- **No `client_id` column, deliberately.** These are Niche Drops' own
  prospecting records about businesses that are not clients. A `client_id` would
  imply a tenant relationship that does not exist and would invite a
  "let clients see their prospects" feature that must never exist — a client
  must never see which other businesses we are approaching.
- **Append-only is enforced by trigger**, not by withheld grants. These tables
  are reached by `service_role`, which *has* UPDATE and DELETE; a trigger makes
  the refusal a property of the table, so a future migration or an ad-hoc
  console session cannot quietly rewrite history.
- **`capture_mode` CHECK omits `'live_fetch'`** — the offline boundary reaching
  all the way into the schema.
- The transition **whitelist** lives in the application, not in CHECK
  constraints: a state machine expressed in SQL constraints produces something
  nobody can read and everybody works around.

## 12. Verification

```bash
npm test                                        # the full suite
node --test "test/acquisition-*.test.js"        # the acquisition suite alone

node scripts/acquisition-dry-run.js             # A1 — discovery, evidence, review
node scripts/acquisition-batch-dry-run.js       # A2 — wash, eligibility, batch approval
node scripts/acquisition-m8b-walkthrough.js     # M8B — the whole machine, end to end
node scripts/acquisition-m8b-walkthrough.js --verbose
```

The M8B walkthrough **exits non-zero** if any of the invariants it exists to
demonstrate fails, so it is a test as well as a demonstration; the suite runs it.

The dry run prints what a founder would see and ends with an explicit list of
**what has not happened** — no website fetched, no register queried, no wash, no
suppression check, no calling-hours check, no batch, no call, no message, no
database write.

## 13. What A1 deliberately does not do

- **Does not normalise phone numbers.** The number is stored exactly as
  published; rewriting it before a human has seen it would destroy the thing
  being reviewed. Normalisation is A2, after review.
- **Does not resolve duplicates.** The fixture contains a duplicate pair, and
  A1 admits both. Resolution is A2.
- **Does not wash against the DNC Register**, consult a suppression list, or
  check calling hours.
- **Does not assemble or approve a campaign batch.**
- **Does not place, schedule or prepare a call.** There is no dialler in this
  build, and no code path that reaches telephony.

---

# A2 — calling policy, eligibility and founder approval

> **Status:** committed in `1794af3`, with tests. Nothing dials. (This heading
> previously read "in progress, uncommitted", and was stale — corrected
> 2026-08-07.)

## A2.1 What exists so far

| File | Purpose |
|---|---|
| `src/services/acquisition-phone.js` | AU normalisation to E.164 + classification |
| `src/services/acquisition-dncr.js` | The DNCR wash port (`disabled` / `fixture` / `import`) |
| `src/services/acquisition-suppression.js` | Permanent, cross-campaign suppression (G5) |
| `src/services/acquisition-holidays.js` | Provider-neutral public-holiday interface + fixture |
| `src/services/acquisition-calling-policy.js` | **The calling-policy gate (G10)** |

## A2.2 The calling-policy gate

One reusable domain service — `createCallingPolicy({...}).evaluate({...})` —
answers *may this business be called at this instant?* and returns a structured
decision: `allowed`, a stable `code`, a human-readable `message`, the evaluated
`timezone` and `localTime`, `nextPermittedAt` where deterministically
calculable, the `policy` inputs that were applied, and whether the block is
`temporary`.

It lives in `src/services/`, **not** in a route, scheduler, provider adapter or
Retell/Twilio handler, so campaign selection, dispatch, retry scheduling,
founder tooling and simulations all ask the same evaluator. A second
implementation of this logic anywhere else is a bug.

### Precedence — permanent before temporary

1. `suppressed_permanently` — **always wins.** Reported as suppression even when
   the call is also outside hours, because "outside calling hours" reads as *try
   again tomorrow*, and tomorrow it would be called.
2. `kill_switch_engaged` / `campaign_blocked`
3. `attempt_cap_reached` (permanent) → `too_soon_since_last_attempt`,
   `recent_contact_cooldown` (temporary)
4. `timezone_missing` / `timezone_invalid` (permanent until data is fixed)
5. `policy_missing`
6. `holiday_coverage_unknown` → `public_holiday`
7. `prohibited_day` → `before_permitted_hours` / `after_permitted_hours`
8. `permitted`

### Fail-closed behaviour

Every uncertainty resolves to *do not call*: no timezone, an unusable timezone,
no configured window, an unusable window, and — critically — **a holiday lookup
that returns `known: false`**. A failed holiday lookup is never read as "not a
holiday". The gate's default holiday provider is the *null* provider, which
knows nothing about every date, so **forgetting to wire up a calendar stops
calls rather than silently disabling the check**.

### Timezone handling

All conversion goes through `Intl` (the IANA database built into Node); no UTC
offset is ever written down or arithmetic'd by hand. `zonedTimeToInstant` is
two-pass — guess with the offset at the naive instant, correct with the offset
that actually applies at the guess — then round-trips through `localParts` to
verify. That is what makes daylight-saving boundaries come out right, and it is
asserted: a 09:00 Melbourne opening resolves to `23:00Z` under AEST and
`22:00Z` under AEDT.

There is **no fallback to server local time anywhere**. A missing timezone
returns `localTime: null`, because producing a local time would mean some clock
was consulted and the only one available is the server's. A child-process test
runs the identical evaluation under `TZ=UTC`, `TZ=Pacific/Honolulu` and
`TZ=Asia/Kathmandu` and requires byte-identical output.

## A2.3 ⚠ Limitations that must be resolved before anything dials — SNAPSHOT as at A2

> **Item 1 is SUPERSEDED by §46 (M8M).** The founder has since adopted the window
> as a versioned operating policy rather than obtaining a legal opinion, and
> `counselApproved` no longer exists. The entry is left as written because this
> section records what A2 knew. **It remains true that no lawyer has reviewed the
> calling rules in this repository** — M8M changed who approves them, not that.
> Item 2 (the holiday calendar) is **still open** as A-L2.

**1. The permitted window is documented, not counsel-approved.** *(Superseded — see §46.)*
The hours come from [OUTBOUND_BDM_ARCHITECTURE.md](OUTBOUND_BDM_ARCHITECTURE.md)
§2.2 and the G10 row in §5 — Mon–Fri 09:00–20:00, Sat 09:00–17:00, never Sundays
or public holidays, recipient-local — encoded once as `CALLING_WINDOWS` in
`src/config/acquisition.js`. They were **derived from the repository, not
invented here.** But that document carries an explicit disclaimer that its
compliance content is an engineering synthesis of public sources, not legal
advice, and its **Phase 0 states: "Nothing dials until this is signed off."**

Accordingly every decision carries `policy.counselApproved: false`. It is in the
decision rather than in a comment because a reviewer reading a `permitted`
verdict needs to see it there. It becomes true only when passed explicitly.

**2. The public-holiday calendar is a hand-compiled fixture covering 2026 only.**
There is no holiday dataset in this repository and no maintained dependency was
added. `acquisition-holidays.js` is therefore an *interface* with two
implementations: a fixture and a null provider.

- It is **not** sourced from an authoritative feed and has not been checked by
  anyone with legal responsibility.
- The AFL Grand Final Friday holiday is proclaimed annually and its 2026 date
  was not fixed at time of writing, so it is **deliberately absent rather than
  guessed** — a guessed holiday is a call placed on a real one.
- Coverage ends 2026-12-31. From 2027-01-01 the provider answers `known: false`
  and the gate refuses to dial. The calendar expiring should stop calls loudly,
  not degrade into calling on Christmas Day 2027.

Replacing it with a provider backed by the data.gov.au Australian public
holidays dataset (or a maintained library) requires implementing the same two
methods — `coverage` and `isHoliday` — and changes nothing in the gate.

## A2.4 Duplicate resolution

`src/services/acquisition-dedupe.js`. **Not a fuzzy matcher** — there is no
similarity score, no edit distance and no threshold. Decisions come from a table
of **named signals**, and the signals that fired are returned alongside the
verdict, because "same number, different ABN" is reviewable and "0.82
confidence" is not. Strength is a *word* (`conclusive`/`strong`/`moderate`/
`weak`), since a number invites a threshold and a threshold invites tuning.

| Decision | Meaning | Auto-merge? | Founder review? |
|---|---|---|---|
| `exact_duplicate` | Same number **and** same identity, or same number **and** same ABN | **Yes** | No |
| `probable_same_business` | Same identity or ABN, weaker corroboration | No | Yes |
| `same_business_different_location` | Same entity/name, different locality — separate branches | No | Yes |
| `possible_duplicate_requires_review` | Conflicting evidence (e.g. same number, different ABN) | No | Yes |
| `distinct` | Different registered entities, or nothing identifying shared | No | No |
| `insufficient_evidence` | Not enough on at least one record to compare | No | No |

**Similar names are not evidence.** Locksmith trading names are built almost
entirely from a small pool of trade and locality words, so a name match counts
only when it contains a *distinctive* token. "Melbourne Mobile Locksmith" and
"Mobile Locksmith Melbourne" are `distinct`.

**Only `exact_duplicate` auto-consolidates.** Everything weaker goes to a
person, because a wrong merge is invisible afterwards.

**Nothing is destroyed.** Consolidation returns a *proposal* carrying the union
of every source reference, number, name, ABN and timestamp in the cluster.

**Order independence** is asserted: `compareRecords(a,b) === compareRecords(b,a)`,
and clustering sorts by id before running, so canonical choice cannot depend on
input order. Canonical is picked by official source → ABN → evidence count →
earliest discovery → id.

> **Two kinds of duplicate.** A1 derives `prospectId` from the identity
> fingerprint, so two records for one business in one suburb **already share an
> id** (an "identity collision"). A cluster can also hold genuinely different
> ids linked by shared evidence. Counting only distinct ids reported the first
> kind as *zero duplicates removed* — a founder told "nothing was merged" about
> a list that contained the same business twice.

## A2.5 The unified eligibility engine

`src/services/acquisition-eligibility.js` answers one question — *can this
prospect enter the outbound call queue now?* — and **composes** the modules that
own each check. There is no second copy of suppression matching, DNCR freshness,
timezone conversion or holiday lookup; a parallel implementation would drift,
and the copy that drifted would be the one that authorised a call.

### Precedence — permanent beats temporary

1. invalid or unsafe record · 2. **permanent suppression** · 3. DNCR/legal ·
4. duplicate requiring resolution · 5. campaign or founder block ·
6. attempt/wash restrictions · 7. timezone/holiday/calling window · 8. eligible

The decisive code is the **highest-precedence** failure, not the first noticed.
If a suppressed business were reported as "outside calling hours", the message
reads as *try again tomorrow* — and tomorrow it would be called. All computable
checks still run, so `failedChecks` shows everything at once.

**Default-deny.** No wash store, no holiday calendar, no suppression list, no
attempt-policy approval, no batch approval, no timezone — each blocks. Forgetting
to wire a collaborator makes prospects ineligible; it never skips a check.

**The composition boundary.** The internal calling gate is built *without*
suppression, campaign or caps: the engine owns those at their own precedence.
Passing them would make the gate short-circuit on suppression and never evaluate
the window, hiding a problem the founder still has to fix and returning
`localTime: null`. The gate keeps those checks for **standalone** callers (a
future dispatch gate must check everything itself).

**Freshness is evaluated at the evaluation instant.** `washStore.assess(e164,
{ at })` takes the instant being asked about, so a scheduler asking "can this be
called next Tuesday?" is told whether the wash is valid *then* — not today.

## A2.6 Founder batch review and approval

`src/services/acquisition-batch.js`. Rows carry the eligibility decision
produced by the engine; a UI renders them and **must never re-derive**
eligibility, or there would be two answers to the only question that matters.

Categories: can be called now · blocked only by timing · duplicates merged ·
possible duplicates needing a decision · must never be contacted · on the DNCR ·
not checked against the DNCR · timezone problem · holiday · outside hours ·
attempt/cooling-off · waiting on a policy decision · needs review.

Founder actions: `approve_record`, `reject_record`, `suppress_record`,
`defer_record`, `resolve_duplicate`. **There is no "start calling" action.**
Including a record the engine says is not callable is refused; rejecting or
suppressing requires a reason.

> **Rows are keyed by `rowId`, not `prospectId`.** Because identity collisions
> share a `prospectId`, keying actions by it meant rejecting one row silently
> rejected another the founder never looked at. When a `prospectId` collides,
> *every* one of its rows is suffixed (`#1`, `#2`), and passing the bare
> colliding id is **refused** as `ambiguous_row` rather than guessed.

### Approval and staleness

Approval is explicit, records actor and timestamp, requires a **named person**
(`system`/`AIDA`/`bot` are refused), and re-checks that every included record is
still eligible and every duplicate resolved. It binds to a **hash** over who
would be called, on what number, and why they were callable.

If any of that changes — a record edited, a wash expired, a suppression
arrived, an eligibility result flipped — the hash no longer matches and
`checkApprovalFreshness` reports **stale**. That is the difference between "the
founder approved this batch" and "the founder approved something once and we
have been calling ever since". Approval is **revocable**, always, because
nothing has dispatched.

**The approved batch is inert.** It states on its own artifact: *"Inclusion in a
future calling batch. This approval does not place, schedule or trigger any
call."* Tests assert the module exports nothing matching
`dispatch|dial|call|start|send|queue|execute|trigger`, references no provider,
and that an approved batch contains no callable behaviour.

## A2.7 ⚠ Attempt and wash policy is NOT approved

`src/services/acquisition-attempt-policy.js` defaults to **`approved: false`**,
and the eligibility engine treats an unapproved policy as a **blocker**. Reading
the source documents exactly:

> **SNAPSHOT — SUPERSEDED 2026-08-10.** This is what A2 proposed and what
> nobody had agreed to at the time. Every "**No**" below was answered by
> approval `AL6-AL7-AL8-2026-08-10`, and three of these values were **retired
> rather than approved**. It is kept to show what the placeholders were; it is
> **not** a record of anything ever being in force. See **§42** for the values
> actually in force.

| Rule | Value | Approved? | Source |
|---|---|---|---|
| DNCR wash validity | 30 days | **Yes** | Statutory — DNC Register Act 2006 / Industry Standard 2017, §2.2 & G4 |
| Max attempts | 3 | **No** → superseded, now **2 counted** | G9 says *"(e.g. 3)"* — an illustration, not a decision |
| Retry spacing | 2 days | **No** → now approved at **2 days** | **No source at all.** Proposed during A1 |
| Recent-contact cooldown | 30 days | **No** → **RETIRED**, not approved | G8 says *"within N days"* — N is literally the letter N |
| "Not interested" cooldown | 180 days | **No** → **RETIRED**; now permanent no-recontact | §9 says "a long cooldown", duration unspecified |
| Declined cooldown / callback window | 90 / 14 days | **No** → decline **RETIRED** (permanent); callback approved at **14 days** | No source |

Outcome handling: `opt_out` → permanent business suppression and `wrong_person`
→ number suppression are **approved** (§5 G5, §9 state them outright). Whether an
unanswered call or a voicemail consumes an attempt is **undecided**.

Approval requires `createAttemptPolicy({ approved: true, approvedBy: "<name>" })`
— `approved: true` with nobody named is **not** an approval and stays out of
force.

## A2.8 A2 cannot dispatch calls

Stated plainly, and enforced rather than promised:

- No module in the acquisition engine imports a transport, a provider SDK, or
  any non-local module. Tests assert every `require` is relative and that no
  file references Twilio, Retell, an HTTP client, or a URL.
- The offline boundary (`EXTERNAL_ACCESS_SUPPORTED = false`) is unchanged and
  still hardcoded, covering `telephony` and `messaging` among others.
- There is no dispatcher, scheduler, queue worker or dialler anywhere in A1 or
  A2, and no function that could become one by configuration.
- The terminal artifact of the entire pipeline is a frozen, hash-bound,
  revocable **approved batch** — data describing an intention, not an instruction.

## A2.9 Founder / legal decisions still required

> **SNAPSHOT — what A2 knew. Not current truth.** The live list is [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md),
> which is recomputed each milestone. Several rows below have moved since; this
> table is kept because the REASONING in it is still the reasoning.

| # | Decision | Blocks | Current behaviour |
|---|---|---|---|
| ~~**A-L1**~~ | **Counsel sign-off on the permitted calling window** (Phase 0). *(Superseded by §46: closed as a founder operating policy, not legal advice.)* | Any dialling | Window applied with `counselApproved: false` on every decision |
| **A-L2** | **An authoritative public-holiday source**, and which state calendars are carried per prospect. | Any dialling outside 2026 / outside VIC | Fixture, VIC + national, 2026 only; everything else refuses |
| ~~**A-L3**~~ | Whether the **AFL Grand Final Friday** and other proclaimed holidays are in scope. *(The POLICY question — call on holidays at all? — is closed by §46: no. The DATA question stays open as A-L2, and this date is still absent rather than guessed.)* | Accuracy of the VIC calendar | Absent, so those dates are treated as ordinary |
| **A-L4** | Confirmation that the caps (**3 attempts, 2 days apart, 30-day contact cooldown**) are the intended commercial policy. | Campaign design | `DEFAULT_CAPS` applied as ceilings |
| **A-L5** | Whether calling a business's **1300/1800 number** carries the same obligations as a geographic one. | Wash scope | Treated identically — everything is washed |
| ~~**A-L6**~~ | **Attempt limits, retry spacing and cooldown durations** — G9's "3" is an illustration, G8's "N days" is unspecified, and retry spacing has no source at all. | Any dialling | **CLOSED 2026-08-10** — 2 counted attempts, 2 days spacing, generic cooldown retired (§42) |
| ~~**A-L7**~~ | Whether an **unanswered call or a voicemail consumes an attempt**. | Attempt accounting | **CLOSED 2026-08-10** — no-answer does not, voicemail does (§42) |
| ~~**A-L8**~~ | The **"not interested" cooldown duration** — §9 says "a long cooldown" without saying how long. | Retry policy | **CLOSED 2026-08-10** — there is no duration; it is permanent no-recontact (§42) |
| **A-L9** | Who besides the founder may **approve a batch**, and whether a second approver is needed above a size threshold (the architecture's two-person rule, G12). | Batch governance | Single named founder only |

---

## 14. Open questions carried into A2 and beyond

| # | Question | Default until answered |
|---|---|---|
| A-Q1 | Is a **verified directory** (licence/ABN-checked) ever sufficient on its own, or is the business's own site always required? | Own site or register required |
| A-Q2 | Does a **1300/1800 service number** carry the same DNCR obligations as a geographic number in practice? | Treat identically — wash everything |
| A-Q3 | How long may a **review approval** stand before the evidence behind it is considered stale? | Re-check at batch assembly (A2) |
| A-Q4 | Who may act as a **reviewer** besides the founder, and does a second reviewer become necessary at volume? | Founder only in the pilot |
| A-Q5 | What **provenance evidence** is required before an `operator_import` origin may be trusted? | Documented source + attestation |

---

*A1 is foundation, not capability. Nothing here can call anybody: there is no
dialler, no scheduler, no wash, and no batch. The next milestone (A2) adds
normalisation, deduplication, the DNCR wash port, suppression, calling-policy
checks, the plain-language eligibility decision, and founder batch approval —
and still does not place a call.*

---

# M8B — the acquisition machine

> **Status:** built dormant. SQL written, **not applied**. Nothing calls, texts,
> emails, scrapes, or contacts a provider. The terminal artifact is a list of
> prospects with lease tokens — data describing an intention.

A1 and A2 produced a pipeline that could decide whether a business was *allowed*
to be called. M8B answers the two questions that were still missing — *is it
worth calling?* and *who is next?* — and closes the loop with what happened when
we approached it.

## 15. What M8B added

| File | Purpose |
|---|---|
| `src/services/acquisition-qualification.js` | Deterministic, explainable locksmith qualification |
| `src/services/acquisition-queue.js` | The dormant outbound call queue |
| `src/services/acquisition-outcome.js` | Contact outcomes and their approved consequences |
| `src/services/acquisition-readmodel.js` | The founder/operator pipeline summary |
| `src/services/acquisition-m8b-fixtures.js` | A second adversarial dataset (does **not** self-register) |
| `scripts/acquisition-m8b-walkthrough.js` | The offline end-to-end walkthrough |
| `supabase/sql/laq2_create_acquisition_queue.sql` | Four additive tables — **written, not applied** |

Extended: `acquisition-schema.js` (engagement states, remediation table,
qualification and queue vocabulary), `acquisition-prospect.js`
(remediation-gated transitions), `acquisition-audit.js` (the `queue` entity
type).

Backfilled: dedicated test files for `acquisition-phone`,
`acquisition-suppression`, `acquisition-dncr`, `acquisition-holidays`,
`acquisition-attempt-policy` and `acquisition-audit`, which had none.

## 16. The prospect lifecycle, in full

```text
discovered ─► evidence_captured ─► review_pending ─┬─► review_rejected
                                                   │
                                                   └─► review_approved ─► queued ─► attempted
                                                                            ▲          │
                                (lease expired, batch revoked) ─────────────┘          │
                                                                                       ▼
                                                    callback_requested ◄──────────  connected
                                                            │                          │
                                                            ▼                          ▼
                                                         queued              interested ─► customer
                                                                             not_interested
                                                                             disqualified

any state ───────────────────────────────────────────────────────────► suppressed  (terminal)
```

Two halves of **one** machine, deliberately. A record with
`lifecycle: review_approved` and a separate `engagement: not_interested` is a
record with two answers to "may we contact this business", and the wrong one
eventually wins.

Notable guards:

- **`customer` can only become `suppressed`.** A client is not a prospect and
  must never reappear in a prospecting queue.
- **`queued` can always be released** back to `review_approved`. If it could
  not, a revoked batch or an expired lease would strand the record forever.
- **`suppressed` remains terminal.** No transition, and no remediation, revives
  it. There is no un-suppress anywhere: not in the module, not in the schema,
  not in the database.

### Remediation-gated transitions

Three moves re-approach a business that has already given or received an answer,
so they require a **named human approver and a justification** on top of the
actor and reason every transition already carries:

| Transition | Why it is gated |
|---|---|
| `not_interested → queued` | Re-approaching a business that already said no |
| `not_interested → customer` | Recording a sale to a business that declined |
| `disqualified → review_pending` | Reopening a business we decided not to pursue |

An approver named `system`, `AIDA`, `bot`, `automation`, `auto`, `robot`,
`service`, `cron` or `scheduler` is refused: a remediation signed by the
automation that wants it is not a control.

**Suppression is deliberately absent from that table**, and a test asserts it
can never be added. A suppression recorded in error is superseded by a
`manual_exclusion` note explaining the error; the business is not resurrected,
because the one bug you cannot recover from is un-suppressing somebody who
opted out — they do not get to opt out twice, and the second call is the one
that becomes a complaint.

## 17. Qualification

`src/services/acquisition-qualification.js` answers *is this worth approaching,
and how does it compare?* — and nothing else. It knows nothing about
suppression, the DNCR, calling hours or holidays, and a test greps its output to
keep it that way. If a high score could ever be read as a green light,
eventually it would be.

**There is no model.** The score is the sum of a fixed table of named signals,
each returned with the points it contributed and a sentence saying why it fired.
`compareQualifications(a, b)` answers "why is this locksmith above that one?" by
naming the signals that differ — which is the question, and "0.82 confidence" is
not an answer to it.

### Facts and inferences do not mix

A **fact** is observed and points at evidence. An **inference** must name the
facts it was drawn from, may never read another inference (so the reasoning is
one layer deep and cannot become circular), and is worth half as much by
construction. A prospect cannot climb the list on conclusions alone.

### Unknown never helps

Every signal resolves to `yes`, `no` or `unknown`; only `yes` scores. Unknowns
are listed by name. Three things are reported as **never observable** on every
single assessment, whether or not the rest of the record is complete:

- how many calls they take
- how many calls they miss
- what happens now when they cannot answer

There is deliberately **no call-volume signal to score**. It is the most
tempting number to invent here and the one we genuinely cannot see from outside.
Omitting these from a report when everything else looked good would read as "we
checked and it was fine".

Operator attestations (`technicianCount`, `serviceAreaSuburbCount`, …) are
reported in `attested`, separately from observations — a founder reading a
ranking is entitled to know that "12 technicians" came from a person.

### Bigger is not worse

No row in the table awards negative points, and a test asserts none ever will. A
business with more calls may be a **better** AIDA customer. A sole operator and
a twelve-van business both qualify, and the fixture contains both to prove it.

What gets excluded is a different thing that happens to be big:

| Disqualifier | Fires when |
|---|---|
| `not_a_locksmith` | Nothing in the name, category or trade evidence says locksmith |
| `lead_generation_page` | The source is a lead-resale funnel — calling it reaches a broker |
| `national_call_centre` | A national coverage claim **and** no local number or locality |
| `no_callable_number_kind` | Every published number is premium or short |
| `outside_target_market` | Not a market we serve (a neutral reason, not a judgement) |
| `already_a_client` | Ours already |

Exclusions are **overrides, not penalties**: a ruled-out record still scores, and
still sorts last.

Matching is whole-word over a normalised string. This is load-bearing rather
than fussy: substring matching qualified "Blockbuster Video" as a locksmith.

### Bands and ranking

`priority ≥ 95 · standard ≥ 65 · marginal ≥ 40 · excluded` over a table whose
maximum is 136. The bar for `qualified` is derived from the `standard` band
rather than repeated, so the two cannot drift. The bands are calibrated against
the achievable range: the first draft's thresholds put 8 of 10 locksmiths in
`priority`, and a band that does not divide the population is decoration.

Ranking is a **total order** with six named tie-breakers — score, official
source, facts established, fewer unknowns, found earlier, then `prospectId`. The
last one is what makes it total; without it two equal prospects swap places
between runs.

## 18. The call queue

`src/services/acquisition-queue.js`. **It cannot place a call.** No dialler, no
scheduler, no provider client, no transport, and no function that could become
one by configuration. Tests assert it reaches no network, imports nothing
non-local, and exports nothing that reads like a dispatcher.

### It holds no cached eligibility

The most important property in the file. A verdict computed at ingestion is a
statement about the world at ingestion time — calling hours pass, washes expire,
batch approvals go stale, and somebody opts out at 4pm. So `evaluate` is called
for **every candidate on every selection**, with `at` set to the instant being
asked about, and any `eligibility` sitting on an incoming record is ignored
outright. A test forges exactly the shape a naive implementation would believe.

`preview()` runs the identical assessment, so a screen can never show a
different order from the one workers get.

### Two questions, never merged

Qualification and eligibility meet here and stay separate. A prospect is skipped
as `not_qualified` **or** as `not_eligible`, never as "low score", because those
need completely different actions from a founder. Ordering is qualification's;
permission is eligibility's.

### Leases and idempotency

`selectNext` reserves what it returns against a **named worker** for a bounded
time. A second worker asking at the same instant gets different prospects. An
expired lease frees the record, so a dead worker strands nothing — the failure
mode is "called later than intended", never "called twice at once". A
`requestId` makes selection idempotent: a timeout between a worker and the queue
must not silently double the day's calls.

### One business, one place in the queue

A1 derives `prospectId` from the identity fingerprint, so two records for the
same locksmith in the same suburb **share an id**. Candidates therefore collapse
by `prospectId`, deterministically, with the dropped record reported as
`identity_collision`. This was found by the walkthrough, not by a unit test: the
queue offered the same business twice and leased it twice, and because leases
are keyed by `prospectId`, the second grant silently overwrote the first.

### Storage

The in-memory lease table is the domain model, not the storage. The durable form
is `acquisition_call_queue` in `laq2`, where "one live lease per business" is a
partial unique index — a constraint the database enforces even when two
processes genuinely race, which application code cannot.

## 19. Contact outcomes

`src/services/acquisition-outcome.js`. Callers say **what happened**, never what
state the prospect should be in. If they said both, two callers would eventually
disagree, and the one that was wrong would be the one that left a business
callable after an opt-out.

The path is walked through the same whitelist every other transition uses. If
any hop is illegal the whole recording is refused and nothing moves — a
half-applied outcome is worse than a rejected one.

Consequences below are as approved on **2026-08-10** (`AL6-AL7-AL8-2026-08-10`).

| Outcome | Reached the business? | Ends at | Consequence |
|---|---|---|---|
| `no_answer` | no | `attempted` | **does NOT consume** a counted attempt (A-L7) |
| `voicemail` | no | `attempted` | **consumes** a counted attempt (A-L7) |
| `wrong_person` | **no** | `attempted` | suppresses the **number** |
| `callback` | yes | `callback_requested` | honour the requested callback for **14 days**, then fail closed (A-L8) |
| `not_interested`, `declined` | yes | `not_interested` | **permanent no-recontact** for cold acquisition — *not* a cooldown, and *not* an opt-out (A-L8) |
| `opt_out` | yes | `suppressed` | suppresses the **business** — the only one that writes a suppression row |
| `booked`, `qualified` | yes | `interested` | stop calling |

`wrong_person` deliberately lands on `attempted`, not `connected`. Somebody
answered, but not this locksmith — recording it as a connection would put a
conversation in the history that never happened.

**Suppression happens before the transition.** If the write fails, the recording
fails and the prospect stays where it was. Transitioning first has a failure
mode where a business is marked handled while remaining callable. With no
suppression list available at all, an opt-out is **refused** rather than
recorded: a record that says the right thing attached to a system that will call
them anyway is worse than no record.

An outcome cannot be recorded against a business no call could have reached.
"They said no" about a record that was never queued is either mis-keyed or
somebody calling outside the queue, and both need noticing.

Conversion to `customer` is a separate entry point, not a tenth outcome: it
happens after the conversation, often days later.

## 20. Suppression semantics (unchanged, now durable)

- **Permanent.** No remove, delete, unsuppress or clear exists in the module,
  and `laq2` enforces it with the append-only trigger rather than by withheld
  grants.
- **Business-scoped by default.** An opt-out is a statement about the
  relationship, not about a handset, so it catches every number the business has
  now or publishes later. Only `wrong_number` and `dncr_listed` are
  number-scoped.
- **Normalisation happens before comparison.** `laq2` CHECK-constrains `e164` to
  `+61` form, because comparing published spellings means "(03) 5550 2287" and
  "03-5550-2287" are different numbers and the second one gets called.
- **It survives the prospect record.** `acquisition_suppressions` has **no
  foreign key** to `acquisition_prospects` — a cascade would let a deleted
  prospect erase its own opt-out, and a non-cascading key would be removed by
  whoever needed to delete. It is keyed on values a re-import reproduces.

## 21. The founder read model

`src/services/acquisition-readmodel.js` computes nothing itself. Blocked
prospects are categorised by `acquisition-batch.categoriseDecision` — the same
function the founder batch screen uses — because two screens categorising the
same refusal differently is a support conversation nobody can resolve.

It re-evaluates rather than caching, for the same reason the queue does.

Three shapes chosen against the dangerous direction of error:

- With **no eligibility engine**, permission is `UNKNOWN` for every prospect.
  Not callable, not blocked — the optimistic guess is the dangerous one.
- `suppressionEntries` is **null, never zero**, when no list was supplied. Zero
  reads as "nobody has opted out", which is a far stronger claim than "we did
  not look". It is not called `suppressed` because the count includes businesses
  that are not in the prospect list at all.
- The outcome distribution is **derived from the lifecycle**, not kept alongside
  it. A second tally would drift, and the drifted one would be believed.

There is deliberately **no dashboard**: no HTML, no route, no client bundle. The
backend contract is the thing that has to be right, and a screen built before it
settles gets rebuilt.

## 22. The walkthrough

```bash
node scripts/acquisition-m8b-walkthrough.js
node scripts/acquisition-m8b-walkthrough.js --verbose
```

Thirteen invented businesses through the whole machine, offline. It **exits
non-zero** if two workers get the same prospect, if the re-imported record
escapes suppression, if the re-import is judged callable, or if the audit chain
breaks — so it is a test, not only a demonstration, and
`test/acquisition-m8b-walkthrough.test.js` runs it.

What it demonstrates on data rather than in prose:

- Two spellings of one number normalise to one string, which is what lets dedupe
  work and what stops an opt-out being escaped by reformatting.
- A Perth locksmith is not callable at 07:30 its time while a Melbourne one is
  at 09:30 theirs.
- Melbourne Cup Day blocks Victoria and leaves New South Wales alone.
- The 2026 calendar refuses 2027 rather than degrading into calling on Christmas
  Day.
- Eligibility permits the plumber and the lead-resale page; qualification
  removes them. Two questions, two answers.
- A locksmith opts out, is re-imported under a different name and punctuation,
  resolves to the same identity, and never reappears in the queue.

Every number is in an ACMA fiction range and every own-domain is under
`example.*`, both asserted by test. Directory hostnames are deliberately real,
because source classification is a pure function of the reference string and an
invented directory domain would not classify as a directory — the record would
stop exercising the gate it exists for. Nothing is fetched from any of them; the
offline boundary makes that impossible.

The run ends with an explicit list of what did **not** happen.

> The walkthrough **simulates** counsel sign-off (A-L1) and attempt-policy
> approval (A-L6), loudly, because without them the eligibility engine blocks
> every prospect and the run would stop at step 7. Neither has been obtained.
>
> **Superseded (§42, §46):** both have since been decided by the founder — the
> attempt policy on 2026-08-10 and the calling policy the same day — so the
> walkthrough now supplies the real artifacts rather than simulating them.
> Neither is legal advice.

## 23. What M8B deliberately does not do

- **Does not place, schedule or prepare a call.** There is no dialler.
- **Does not send SMS or email.**
- **Does not scrape anything.** The offline boundary is unchanged and still a
  hardcoded constant with no environment override.
- **Does not query the DNC Register.** Results are imported from an attested
  file; there is no live mode.
- **Does not apply any SQL.** `laq1` and `laq2` were written and unapplied at
  M8B; a human applied them to dev in M8D. No code in this repository runs SQL.
- **Does not build a dashboard.**
- **Does not wire qualification into the eligibility engine.** Commercial fit
  and legal permission stay separate questions with separate owners.

## 24. What a future milestone must do before anything dials

> **SNAPSHOT — what M8B knew, with one row struck through in M8D.** The live
> list is [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md). M-1, M-2 and M-3 are now done on dev and M-4's mechanism
> exists; see the register rather than this table.

Everything in §A2.9 (A-L1 … A-L9) still stands and still blocks. In addition:

| # | Requirement | Why |
|---|---|---|
| ~~**M-1**~~ | ~~Apply `laq1`, then `laq2`, and re-verify RLS~~ | **DONE on dev in M8D.** Still outstanding for production |
| **M-2** | Replace the in-memory stores with the LAQ2 tables | Suppression that lives in a process is not suppression |
| **M-3** | Build a lease reaper | An expired lease should be released with a row saying so, not evaporate |
| **M-4** | Re-run eligibility **at the moment of dialling** | The queue's snapshot is for audit, not authorisation — a wash can expire between reservation and call |
| **M-5** | Decide the `service_area` / `operating_status` capture path | The discovery contract derives neither, so both are permanently unknown today |
| **M-6** | Replace the holiday fixture with an authoritative source | Coverage ends 2026-12-31 and the calendar refuses everything after it |

**M-4 is the one that matters most.** Nothing in the queue authorises a call. A
future dispatcher that trusted `eligibility_snapshot` would reintroduce exactly
the staleness this milestone was built to eliminate.

---

# M8C — durable state and restart-safe suppression

> **Status:** built. `laq1` and `laq2` are written and **still not applied**.
> Nothing calls, texts, emails, scrapes or contacts a provider.

The suppressions, leases and outcomes M8B produced lived in process memory. Kill
the process and the locksmith who opted out this morning was callable this
afternoon. M8C is that, fixed, and the proof that it is fixed.

## 25. What M8C added

| File | Purpose |
|---|---|
| `src/services/acquisition-store.js` | The store contract, an in-memory implementation, and a lazy-Supabase adapter |
| `src/services/acquisition-durable.js` | Durable suppression, queue, outcomes, and the lease reaper |
| `test/acquisition-restart.test.js` | The process-restart proof |
| `test/acquisition-store.test.js` | Contract parity, adapter translation, and the safety ratchets |
| `docs/ACQUISITION_SQL_RUNBOOK.md` | Exact manual apply/verify steps — **stops before application** |

## 26. Three defects the audit found first

**D1 — LAQ1's `acquisition_decisions.entity_type` CHECK omitted `'queue'`,**
which M8B had added to the code. Every queue selection, release and completion
row would have been rejected the moment the decision log was persisted. The
migration test cross-checked five other enums against the code and not this one.
That check now exists, along with ones for audit decisions, evidence kinds and
capture modes.

**D2 — LAQ2's `acquisition_contact_outcomes` used `ON DELETE CASCADE`** on an
append-only table. The cascade fires the refuse-mutation trigger and aborts with
"outcomes is append-only", which is a true but baffling thing to be told when
you asked to delete a prospect — and it made "they asked us not to call again"
deletable by deleting the row it points at. Now `RESTRICT`.

**D3 — a business-scoped opt-out recorded the dialled number and never matched
on it.** The fingerprint is built from the trading name and the locality, so it
drifts: re-import the same locksmith as "Preston South" rather than "Preston",
and the identical phone number came back **not suppressed**. The M8B walkthrough
passed only because its re-import happened to produce a byte-identical
fingerprint. A business-scoped entry now matches on the identity **or** its
recorded number; either is enough, and the number is the more stable key.

Both migrations were amended in place. They had never been applied at the time,
so a compensating migration would only have preserved a history that never
happened. That window is now closed: they are applied to dev, and any further
correction must be a new additive migration rather than an edit in place.

## 27. The architecture: reads sync, writes async

`suppression.check()` is called once per candidate per selection by
`acquisition-eligibility`, `-batch`, `-queue` and `-readmodel`, all synchronous.
Making it async would have rippled through four modules and roughly seven
hundred tests to buy nothing.

So the durable layer **wraps** the pure cores rather than rewriting them:

- an in-memory index, **hydrated from the store at construction**, serves every
  read synchronously;
- writes go through the store and are awaited.

The only changes to existing modules are two additive hydration parameters
(`initialEntries`, `initialLeases`) and making outcome recording async so it can
await a suppression that may now be a durable write. `await` handles the pure
list and the durable service identically, so the recorder composes with either
without knowing which it was given.

### The limitation, stated

A suppression written by a **second process** is not visible here until
`rehydrate()` is called. The pilot is single-process; this is accepted, not
solved. What still holds across processes is the part that matters: the
database's partial unique index refuses a second live lease whatever any cache
believes, and the suppression table is append-only, so nothing another process
does can un-suppress anybody.

## 28. Durable suppression

Hydrated at construction, written durably before becoming visible. If the store
write fails the entry is **refused and is not visible in memory either** — the
alternative ordering has a failure mode where this process believes a business
is suppressed, the next one does not, and the difference is a phone call.

There is no delete, remove, unsuppress, clear or purge anywhere: not in the
domain API, not in the store contract, and `assertStoreContract` **refuses to
construct** a store that offers one.

## 29. Durable queue and leases

Lease acquisition is atomic because it is an INSERT racing
`idx_acq_queue_one_live_lease`, not a read-then-write in application code. A
23505 is reported as "somebody else has it", which is a normal outcome of a
selection rather than an error.

`requestId` idempotency moved into the store. A Map stops working at exactly
the moment a worker is most likely to retry — a restart mid-run — which is the
one case idempotency exists for.

Eligibility is still re-run at selection. `eligibility_snapshot` is written for
the audit trail and is **never read back as authority**; whatever eventually
dials must re-evaluate, because a wash can expire between reservation and call.

### Expired leases behave differently from M8B, deliberately

`idx_acq_queue_one_live_lease` is partial on `released_at is null`. Expiry
cannot be in the predicate — an index predicate must be immutable and cannot
reference `now()`. So an expired-but-unreleased lease **still holds the slot**,
in Postgres and in the in-memory store alike; the two must agree or the restart
proof is about the wrong thing.

Reclaiming therefore goes through the reaper. The operational consequence is
real: **if nobody sweeps, a crashed worker's leases stay held.** The read model
surfaces exactly that as `leasesAwaitingReaping`, a number that only grows when
nothing is sweeping.

## 30. The lease reaper

Dormant by default — `enabled` is false unless a caller passes true, and there
is no timer, interval or scheduler anywhere in the module. `sweep()` runs when
something calls it and never otherwise.

It reads expired leases and releases them. It does not evaluate eligibility,
does not select, does not re-queue, and holds nothing that could dial. A
released prospect becomes available to the next selection, which re-runs
eligibility from scratch — so a business suppressed while its lease was held is
refused by the engine, not resurrected by the reaper. Asserted by test.

Idempotent: releasing an already-released lease matches zero rows and is counted
as `alreadyGone`. `dryRun` reports what a sweep would do without doing it.

## 31. Durable outcomes, and the failure semantics

There is no cross-table transaction available. PostgREST issues one statement
per call, so "suppress and record the outcome" cannot be made atomic from this
side. That is a choice about which half may survive alone, and the two are not
equally bad:

| Failure | Consequence |
|---|---|
| suppression written, outcome row lost | The business is **safe**. The narrative has a gap, recoverable from the hash-chained decision log. |
| outcome row written, suppression lost | The record says "they asked us never to call again" and the engine hands them to a worker tomorrow. |

So **suppression goes first, and if it fails the outcome is refused** — not
recorded with a warning, refused, so the caller has to deal with it. If the
suppression lands and the outcome row then fails, the error reports
`suppressionApplied: true` and says in words that the business is not callable
and only the record is missing. Nothing is rolled back: un-applying a
suppression to keep two tables tidy trades a missing narrative for a callable
business.

Both paths are asserted by test.

## 32. The restart proof

`test/acquisition-restart.test.js`. `freshServices()` discards every service
object — suppression, queue, outcomes, eligibility, audit — and rebuilds them
around the **same store**, which is what a restart does to a process sitting in
front of a database that does not restart with it.

The sequence: ingest, qualify, confirm callable, lease, opt out, **restart**,
then re-import three ways (different punctuation, a second source with a drifted
suburb, a freshly created identity). All three are still suppressed and none is
offered to a worker.

Two guards stop it being self-congratulatory:

- the rebuilt audit log is asserted **empty**, so a pass cannot come from state
  that never left memory;
- a **control test throws the store away too** and confirms the business *does*
  come back callable — the failure M8C prevents, demonstrated by removing the
  thing that prevents it.

Also proven: a live lease survives recreation and cannot be re-issued to a
second worker; an expired lease is reclaimable once reaped and not before;
`requestId` idempotency survives a restart; outcomes and read-model counts
survive recreation.

No database is contacted. The in-memory store is the reference implementation of
the contract the Supabase adapter implements, and the adapter's translation is
covered separately with an injected fake client. §7 of the runbook repeats the
proof against the real database, by hand, after the SQL is applied.

## 33. What M8C deliberately does not do

- **Does not apply any SQL.** Both migrations were unapplied at M8C, and a test
  asserts nothing in `src/` or `scripts/` opens or executes a `.sql` file. That
  test still holds: M8D applied them to dev **by hand**, not by code.
- **Does not add a scheduler.** The reaper is dormant and has no timer.
- **Does not build an administrative remediation flow.** Suppression stays
  permanent with no way out; §7 of the runbook shows the deliberate,
  trigger-disabling admin action needed to remove even a test probe.
- **Does not build the dialler.**
- **Does not connect to Supabase.** The adapter exists, is contract-tested with
  a fake client, and has never been pointed at a project.

## 34. Remaining blockers as at M8C — SNAPSHOT, superseded

> **DO NOT READ THIS AS CURRENT.** It records what was true on 2026-08-07, when
> M8C was written and no SQL had been applied to anything. The live list is
> [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md).
>
> Four rows below are now wrong, and were corrected in M8J rather than quietly
> edited here:
>
> - **M-1** says "not applied". LAQ1 + LAQ2 were applied to dev in **M8D**
>   (2026-08-07) and LAQ3 in **M8I** (2026-08-08). Production: still none.
> - the sentence "the tables do not exist yet" was true for about a day.
> - **M-2** "needs M-1" — M-1 is done on dev.
> - **M-4** "still required" UNDERSTATES M8E: the mechanism is built and
>   re-runs the whole engine at the authorisation instant. What it lacks is a
>   caller, because there is no dialler.

| # | Blocker | Status after M8C (HISTORICAL) |
|---|---|---|
| **A-L1** | Counsel sign-off on the calling window | Open. Blocks every prospect. |
| **A-L6** | Attempt caps, retry spacing, cooldowns | Open. Blocks every prospect. |
| **M-1** | Apply LAQ1 then LAQ2, verify RLS | Runbook written; **not applied** |
| **M-2** | Replace in-memory stores with the tables | Code done; needs M-1 |
| **M-3** | Lease reaper | Built, dormant; needs an operator to run it |
| **M-4** | Re-run eligibility at the moment of dialling | Still required. The stored snapshot is audit-only and a test asserts it is never read back. |
| **M-5** | `service_area` / `operating_status` capture path | Open |
| **M-6** | Authoritative public-holiday source | Open; the fixture expires 2026-12-31 |
| ~~**M-7**~~ | ~~Cross-process suppression visibility~~ | **CLOSED in M8E.** Proven across two real processes against dev Postgres: B held stale memory, A committed an opt-out, B's gate still refused. See §36. |

---

## 35. M8D — the durable layer, proven against real Postgres

M8C built the durable layer and proved it against an in-memory store. M8D
applied `laq1` and `laq2` to the **dev** Supabase project by hand and re-proved
the same invariants against real Postgres. **No production access, no dialler,
no prospect or provider contacted.**

**Owns (source of truth for):** what has been proven against a real database, as
opposed to against a test double.

### 35.1 What was proven

| Stage | Result |
|---|---|
| Pre-flight | Clean: no acquisition objects, no partial prior apply, no name collisions |
| LAQ1 applied + verified | 13/13 structural checks, plus trigger-**enabled** state, row counts and CHECK bodies |
| LAQ2 applied + verified | 18/18 structural checks, including the partial unique index and the RESTRICT/CASCADE split |
| Behavioural probes | **30/30**, each asserting a specific SQLSTATE |
| Restart proof | **13/13**, across two real processes |

The probes and the restart proof are described in
[ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md) §6 and §7. The assets
are checked in under `supabase/sql/verification/` and
`scripts/dev/acquisition-restart-proof/`.

### 35.2 The three invariants that mattered most

- **A suppression survives its prospect being deleted** (probe P30, and again in
  the restart proof). `acquisition_suppressions` holds no foreign key at all, so
  a deleted prospect cannot erase its own opt-out.
- **A re-imported business is still suppressed** after a process restart, with
  its trading name, suburb, source and number formatting all drifted and its
  prospect identity regenerated. This is the failure this whole design exists to
  prevent: a business that opted out being re-imported months later and called.
- **A reaped prospect is re-evaluated, not re-queued.** Releasing an expired
  lease returns a business to the pool; it does not return it to eligibility.

### 35.3 Two defects found and corrected

- **Runbook §6.3 could not test what it claimed.** A flat
  `begin; … -- must FAIL; … -- must FAIL; rollback;` block only ever reaches its
  first expected failure — the first exception aborts the transaction and every
  later statement returns `25P02`. Fixed by rewriting §6 around nested
  PL/pgSQL `BEGIN … EXCEPTION` blocks, which Postgres wraps in savepoints.
- **The first probe harness relied on a temp table surviving a statement
  boundary.** It does not, in the Supabase SQL editor. Rewritten as a single
  `DO` block that ends in a deliberate `RAISE EXCEPTION` carrying the report —
  which also makes the rollback a property of statement atomicity rather than of
  a trailing `rollback;` being reached.

Neither was a schema defect. `laq1` and `laq2` were applied unmodified.

### 35.4 What M8D deliberately does not do

- **Does not build, enable or prepare a dialler.** There is still no dialler.
- **Does not touch production.** The restart-proof harness refuses to start
  unless the Supabase URL carries the dev project ref.
- **Does not resolve M-7.** Cross-process suppression staleness is unchanged and
  remains the blocker below.
- **Does not disable an append-only trigger.** Verification check F8 asserts all
  four are still enabled.

### 35.5 Dev residue, intentional

Three rows remain on dev by design — one suppression, one contact outcome, and
the prospect they point at, all `m8d-restart-probe`, describing an invented
business on an invented number. They cannot be removed without disabling an
append-only trigger, and that trade was made deliberately: see runbook §7.4.

---

## 36. M8E — the final pre-dial authorisation gate, and the end of M-7

**Owns (source of truth for):** where a suppression answer may come from a cache
and where it may not.

### 36.1 The rule, in two lines

> **EARLY FILTER.** The hydrated suppression index may reject cheaply, anywhere:
> discovery, ranking, batching, the queue, the founder's screens.
>
> **FINAL AUTHORISATION.** An authoritative durable suppression read is
> mandatory. No future dialler may bypass it.

The index keeps its speed and loses its authority at exactly one point.

### 36.2 What M-7 actually was

Sharper than M8C recorded it. The suppression index is hydrated once, at
construction, from a single `listSuppressions()`. `rehydrate()` is exported —
and had **no callers anywhere in the repository**. The only `rehydrate()` calls
that existed were the queue's own, rebuilding leases.

So staleness was not "until the next round". A process that started on Monday
held Monday's view of who had opted out for as long as it lived.

### 36.3 The gate

`createDialAuthoriser({ now, store, engineOptions }).authorise(prospect, ctx)` —
`src/services/acquisition-authorisation.js`.

It reads suppression from the store **every time**, for the one business it is
asked about, then re-runs the whole eligibility engine against that answer. DNCR
and its freshness, duplicates, campaign and kill-switch, counsel and attempt
policy, batch approval, timezone, holidays and the calling window are all
re-evaluated at authorisation time by the modules that own them. A stored
`eligibility_snapshot` is never consulted; it remains audit-only.

It returns a structured decision. On refusal it names the reason in the
**existing** `ELIGIBILITY_CODES` vocabulary — `suppressed_permanently`,
`no_usable_number`, `dncr_not_checked`, `outside_calling_policy` — because a
parallel `BLOCKED_*` vocabulary would mean two names for every refusal and a
translation table between them.

**One code is genuinely new.** `suppression_store_unavailable` describes the
*gate's* failure, not the prospect's:

> If authoritative suppression state cannot be read, the answer is **BLOCKED**,
> not "probably safe". "We could not establish whether this business opted out"
> is not a fact about the business and must never be reported as one.

### 36.4 Three decisions worth recording

**Pre-fetch, then re-run.** `suppression.check()` is synchronous and has four
callers. Making it async would ripple through all of them and every test that
drives them — the cost M8C refused to pay. So the durable read happens at the
boundary, once, and the engine is built around the result.

**The database narrows; the domain decides.** `lookupSuppression()` selects
`fingerprint = $1 or e164 = $2` and returns rows. Writing the matching rule in
SQL would be a second copy of `acquisition-suppression.check()`, and the copy
that drifted would be the one that authorised a call. The predicate is a
provable superset of all three matching rules, and a test asserts the narrowed
verdict equals the whole-table verdict.

**No pre-built engine parameter.** An engine binds suppression at construction
and `evaluate()` cannot override it, so a caller passing one would hand over the
stale index — and the gate would read the database, discard the answer, and
authorise from memory while reporting `suppressionSource: "durable"`. The
factory takes collaborators and builds the engine itself.

### 36.5 Where the authoritative read happens, and how often

**Once per authorisation, at the irreversible boundary.** Explicitly **not**:

- not once per discovered prospect,
- not once per ranking calculation,
- not once per dashboard render,
- not once per queue candidate.

Expected volume is therefore bounded by *calls that could be placed*, not by
prospects considered. At the pilot's ceiling — tens of calls a day — that is
**tens of reads a day**, each two indexed equality lookups on
`idx_acq_suppressions_fingerprint` and `idx_acq_suppressions_e164`. Discovery
and ranking over hundreds of prospects still touch the database zero times.

### 36.6 Bypass prevention

An authorised decision carries an **`AuthorisedDial`** slip stamped with a
module-private Symbol. It cannot be forged, it is frozen, and every field on it
is inert. A future dialler whose signature demands one cannot be handed a
prospect that skipped the gate.

Four ratchets fail the build if that erodes: only the gate may mint a slip; no
acquisition module may reach a provider; any acquisition module that grows an
execution verb must import the authoriser; and no execution verb exists yet.

### 36.7 The proof

Two real Node processes, real dev Postgres, a file handshake so the sequence is
deterministic rather than timed. `scripts/dev/acquisition-crossprocess-proof/`.

| | |
|---|---|
| B1 | B hydrated while the business was **not** suppressed |
| A1–A3 | A, a separate process, committed the opt-out and read it back |
| B2 | **B's memory remained stale** — it never rehydrated, and nothing calls `rehydrate()` |
| B3 | Postgres held the opt-out |
| **B4** | **the gate refused, from durable state, despite B's stale memory** |
| B5 | no dial permission was minted |
| B6 | a drifted re-import was still refused |
| B7 | an unreadable store was **blocked**, not assumed safe |
| B8–B9 | the gate exposes a decision and nothing that acts |

Number-scoped suppression, business-scoped-without-number, DNCR, window,
holiday, batch and counsel refusals are proven offline against the in-memory
store, which is the same contract the Supabase adapter implements.

### 36.8 What M8E deliberately does not do

- **Does not build, enable or prepare a dialler.** There is still no dialler,
  and a ratchet asserts it.
- **Does not make the hydrated index authoritative anywhere.** It is a cache,
  and after M8E it is documented as one.
- **Does not add a scheduler, a poller, a bus or a TTL.** Each of those fails
  open when it breaks; this fails closed by construction.
- **Does not apply SQL.** `laq2` had already created both indexes this read
  needs.

### 36.9 Dev residue

**One row**, approved in advance: one fictional `opt_out`,
actor `m8e-crossprocess-probe`. No prospect row and no outcome row — because
suppressions carry no foreign key, which is the same property M8E defends.

---

## 37. M8F — real-source lead intake

**Owns (source of truth for):** how a real business export becomes canonical
prospects, which source profiles this build reads, and what importing does and
does not authorise.

### 37.1 What it is, and what it is not

A founder exports locksmiths from a directory tool, drops the CSV in, and gets
clean deduplicated prospects with provenance attached. **Nothing is contacted at
any point** — not the prospect, not a provider, and not the businesses' own
websites.

**There is still no live discovery.** No search API, no Google call, no
Outscraper call, no crawler. `EXTERNAL_ACCESS_SUPPORTED` is still hardcoded
`false` and the discovery registry still refuses any adapter that declares
`requiresNetwork: true`. The export happens outside this system, by a human.

### 37.2 It adds no second pipeline

The importer produces **candidates** and hands them to the discovery admission
path that already existed. Everything after mapping is machinery that was
already proven: `acquisition-phone` normalises, `acquisition-discovery` admits
and writes evidence through the ledger, `acquisition-dedupe` finds duplicates,
`acquisition-qualification` scores, `acquisition-eligibility` decides.

An importer that built prospects itself would have been a second definition of
what a prospect is, a second provenance path, and a second place for suppression
to be forgotten. There is exactly one of each.

### 37.3 Supported source profiles

| Profile | Reads | Source type |
|---|---|---|
| `outscraper-google-maps` | Outscraper / Google Maps business exports | `map_listing` |
| `manual-csv` | A hand-curated CSV | `unverified_directory` |

A profile is the only place a column name appears. Each accepts several
spellings per field, because export tools disagree and a founder should not have
to rename columns by hand.

**Deliberately not imported**, though the export carries them: reviews, review
text, reviewer names, photos, owner names, harvested emails, popular times. None
is needed to decide whether a locksmith may lawfully be called, and importing
personal data nobody needs is how a prospecting file becomes a privacy problem.

### 37.4 Unknown stays unknown

A missing column produces `null` — never a guess, never an empty string
pretending to be a value.

**Timezone is the sharpest case and the rule is absolute.** It is a compliance
input: calling hours are checked in the business's local time, so a guessed
timezone guesses whether a call is lawful. It is derived from an **explicit
state column** and from nothing else. No state, no timezone — and eligibility
refuses the prospect until a human supplies one. A postcode never produces a
timezone.

Where a row contradicts itself — a NSW state with a VIC postcode — **both values
are kept and the contradiction is recorded**. Which one is wrong is not knowable
from the row.

### 37.5 Landlines are business numbers

**A published business landline is the number a locksmith answers, and it is
kept.**

The engine's `CALLABLE_PHONE_KINDS` has always been
`["mobile", "landline", "service"]`; the audit confirmed nothing in this
repository ever filtered landlines. The filtering the founder remembers belonged
to an **SMS-first** outreach method. AIDA is voice-first. In the fixture export,
10 of 12 usable numbers are landlines — an SMS-era filter would have discarded
most of the file.

Only **premium-rate (`190x`)** and **short** numbers are refused, and only
because dialling them can cost the recipient money.

Multiple published numbers are all retained. One cell holding several numbers is
split on commas, semicolons and slashes.

### 37.6 Deduplication

Uses `acquisition-dedupe`'s existing named-signal vocabulary verbatim.

| Decision | What the importer does |
|---|---|
| `exact_duplicate`, `probable_same_business` | **MERGED** — evidence attaches to the existing prospect |
| `same_business_different_location` | **kept separate** — a branch is a second business to call |
| anything weaker | **REVIEW_REQUIRED**, with the signals that fired |

A repeated source id within one file is caught before any of that, as the
export's own duplicate.

**A re-import merges; it does not multiply.** Running the same file twice
imports nothing new.

### 37.7 Locksmith / noise classification

Deterministic and explainable — named signals, no score, **no LLM**. Not because
a model would classify badly, but because this decides who gets phoned: a table
gives the same answer twice, can be diffed when it changes, and can be argued
with by someone holding the row. A model may later *propose* rows for review; it
may never be what admits one.

Facts and inferences stay apart. "The source's category column says Locksmith"
is a fact; "therefore it is a locksmith" is an inference, and both are labelled.

**The precedence that matters:** a lead-generation funnel's category column says
"Locksmith" — that is the entire point of it — so **category can never be what
rules one out**. An aggregator marker in the business *name* ("near me",
"compare quotes", "find a") is decisive on its own, regardless of category. The
same words in a description are weaker and buy a human review instead.

### 37.8 Official-website authority — contract only

The precedence **official website > verified directory > unverified directory /
aggregator** is already owned by `acquisition-source`, and an imported map
listing is classified as `map_listing`, which is not official.

**No website is fetched.** The website column is normalised and compared as a
string; it is never visited. It is recorded as a source reference but cited for
no claim, because this build has not read it — attributing a phone number to a
site nobody opened would manufacture exactly the confidence the pipeline exists
to withhold.

Live website verification remains **out of scope and unbuilt**.

### 37.9 The import command

> **Superseded in part by M8G (§38).** At M8F this command had no write mode,
> because there was nowhere to write to. It now has one. The paragraph that
> said "dry run is the only mode" was true when written and is no longer;
> §38.4 is the current description.

```
node scripts/acquisition-import.js --file <csv> --source outscraper-google-maps
```

Without `--write` the command reads a file and prints a report. It stores
nothing, reads no credential, and imports no provider or network client.

### 37.10 What importing does NOT do

An imported prospect is **not callable**, and tests pin every part of this:

- it has not been reviewed, so it fails record validity;
- its number has not been washed, so DNCR-unknown blocks it;
- suppression still overrides it — **a re-import cannot resurrect a business
  that opted out**;
- there is no dialler, and the M8E authorisation gate still stands between any
  prospect and a call.

---

## 38. M8G — persisted prospects, and what a re-import may and may not do

**Owns (source of truth for):** how an imported prospect reaches the database,
what a second import of the same business does, and what persistence does not
authorise.

M8F could turn a CSV into clean, deduplicated, explainable prospects. They
evaporated when the process exited. M8G writes them into the `laq1` tables,
which had been applied to dev since M8D with nothing writing to them.

**No new SQL.** Every field M8F produces maps onto columns already applied.
`acquisition_prospects.timezone` is `NOT NULL` and `createProspect` already
refuses a prospect without one, so the strictest column matches the domain
rather than fighting it.

### 38.1 The two modes

| | **DRY RUN** (default) | **WRITE** (`--write`) |
|---|---|---|
| Persists | nothing | prospect, phones, evidence |
| Credentials | **none read** | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` |
| Project | n/a | **dev only**, refuses any other ref |
| Contacts anyone | no | no |
| Approves compliance | no | **no** |

**`--write`, and nothing else.** Not `--live`, which reads like "go live" and
would one day be typed by somebody who meant "use real data"; not `--commit`,
which is a git verb here. Omitting it can only produce a report, and no
environment variable or default can turn a dry run into a write. A dry run never
reaches the credential branch, so it never reads one.

**Writing does not make a business callable.** It lands `discovered`,
unreviewed and unwashed, and still faces review, qualification, DNCR,
suppression, the calling policy and the M8E authorisation gate.

### 38.2 Persistence order, because there is no transaction

The Supabase adapter issues one statement per call and cannot wrap three tables
in a transaction. Pretending otherwise would be worse than not having one, so
the order is chosen to make every partial state safe:

1. **Prospect first.** Both other tables key to it; a crash here leaves nothing.
2. **Phones second.** A prospect with no numbers is a state review already
   refuses to approve.
3. **Evidence last** — the deliberate one. Evidence is append-only and can never
   be corrected. Writing it last means a crash leaves *fewer* claims than we
   hold, rather than permanent claims about a business whose row never appeared.

**Retry is the repair.** Re-running adds exactly what is missing. There is no
reconciliation job because there is nothing for one to do.

### 38.3 Idempotency keys

| Table | Key | Effect |
|---|---|---|
| `acquisition_prospects` | deterministic `prospect_id` | upsert; the same business is one row |
| `acquisition_prospect_phones` | `unique(prospect_id, raw)` (laq1) | a re-published number is not stored twice |
| `acquisition_evidence` | **`content_hash`** | identical claims never multiply |

**Evidence deduplicates on content, not on id.** The ledger's `evidenceId` folds
in a sequence number and a timestamp, so the same fact re-imported carries a
**new id and the same hash**. Deduplicating on the id would have appended a row
per import forever, into a table that cannot be cleaned up.

### 38.4 What a second import does

| Case | Result |
|---|---|
| Exact same file | Recognised and merged; nothing written |
| Drifted name / suburb / number formatting | Recognised from the store, **no new prospect** |
| Genuinely new phone on a new business | Stored once |
| A genuine branch (different suburb + number) | Stays a **separate** prospect |
| **Possible duplicate** | **Held for a human. Not persisted.** |

`loadExistingForImport` closes a gap M8F could not see: in-run, the importer
compares a row against the rows above it; across runs it had nothing. Ids are
deterministic, so the same file twice is safe — but a **drifting name** produces
a different id, and "…Locksmiths" and "…Locksmiths Pty Ltd" would have become
two prospects a week apart. The store is now asked which businesses a file might
already be about, narrowed by source id and normalised number.

**A possible duplicate is reported, not stored.** Dedupe has three answers and
the middle one means the evidence does not decide. Persisting it anyway is
exactly what happened on the first real run — see §38.7. Storing it would be
deciding by default, in the direction that cannot be undone.

### 38.5 The provenance fix (`bc008e9`)

Found by this milestone's audit, before anything was written.

`acquisition-source` reads a declared type from **`sourceType`**. The importer
passed `type`, which nothing reads, so listings were classified by hostname
alone — and **an unrecognised host falls through to `official_website`**, the
most authoritative classification there is. Every imported directory phone was
stored as officially sourced with `official: true`, and
`assessEvidence.phoneFromOfficialSource` reported a directory number as
officially sourced. Source authority is the control this pipeline was built
around, and it was failing **open**.

The fix is in `acquisition-source`, not only the importer: a declared type is
now honoured **when it is weaker than the host suggests**. Lowering your own
authority can only add caution; raising it is the unverifiable assertion the
module already refuses, and still refuses.

**An imported directory phone is not official-site evidence**, and a test
asserts `phoneFromOfficialSource === false` for one.

### 38.6 Suppression is unaffected by any of this

A re-import cannot weaken it. Proven across two real processes: a business
carrying the existing M8E fictional opt-out, presented as a freshly imported,
drifted record, is refused by eligibility and then by the **M8E authorisation
gate reading authoritative durable state**. Pre-dial permission is still decided
there and nowhere else.

### 38.7 Dev residue — including what was not planned

**LAQ1/LAQ2 are applied to dev only. Production is untouched.**

| Table | Rows | Planned? |
|---|---|---|
| `acquisition_prospects` | **2** — `pr_0b9f51cfe79018067bf1`, `pr_f546eb7194421d554527` | 1 approved, **1 not** |
| `acquisition_prospect_phones` | **1** | yes |
| `acquisition_evidence` | **9** | 4 approved, **5 not** |
| suppressions / outcomes / queue / qualifications created by M8G | **0** | yes |

**The unplanned rows, and why they remain.** The first real run of the drifted
re-import returned `review_required`, and the pre-fix code persisted it — giving
the same invented business a second prospect row and five more evidence rows.
That is the duplicate explosion this milestone exists to prevent, and the real
proof is what found it.

Cleanup was attempted and correctly refused:

- `acquisition_evidence` is **append-only** — `DELETE is not permitted`;
- evidence pins the prospect through **`ON DELETE RESTRICT`**;
- **no trigger was disabled and no foreign key weakened.**

Both rows describe the same invented business on invented numbers. The fix is
committed and re-verified: the drifted import now creates nothing.

### 38.8 Known limitation — open for M8H

**When an import merges a listing into a business already stored, nothing from
that listing is persisted — including a genuinely new number it published.** The
merged row is reported with the signals that produced the merge, and a human
attaches the number.

This is deliberate and conservative: attaching a callable number on the strength
of a merge writes something nobody confirmed, and a wrong one cannot be unwritten
cheaply. **Merge enrichment is not complete**, and automatic attachment on a
*conclusive* merge is the obvious next step. It is listed as an open item rather
than described as done.

---

## 39. M8H — the review queue, and merges that add rather than discard

**Owns (source of truth for):** what reaches a human, how they decide it, what a
merge is allowed to change, and the single-writer limit on the decision log.

M8G left two practical gaps. Ambiguous candidates — the ones actually needing a
person — were the only part of an import that did not survive the process. And a
conclusive merge discarded everything the listing carried, including a number
the business had started publishing.

**No new SQL.** Both are built on `acquisition_decisions`, applied since M8D.

### 39.1 A review item is two decisions, not a row with a status

| Event | `decision` | Carries |
|---|---|---|
| `review_opened` | `defer` | the candidate, the duplicate signals, the possible matches, the reason |
| `review_resolved` | `approve` / `reject` | what a human decided, who they were, why |

Current state is a fold over the rows for one `entity_id` — the same shape
suppression and outcomes already use. The table is append-only and hash-chained,
so the queue inherits an audit trail rather than needing one.

**A review item is deliberately not a prospect row.** The schema has
`review_pending`, and using it would be wrong here for one specific reason: the
commonest review item is *"this may be a duplicate of a business we already
have"*, and writing it as a prospect creates exactly the duplicate row M8G
removed.

### 39.2 What enters review, and what does not

| Enters review | Does not |
|---|---|
| Possible duplicate of a stored business | Conclusive duplicate — merged automatically |
| Classification `needs_review` (lock-adjacent) | Clear locksmith — imported |
| A row contradicting itself (state vs postcode) | Aggregator, other trade — excluded outright |
| | No name, no usable number — refused outright |

**Idempotent.** Re-importing the same unresolved candidate finds the open item
and returns it. A founder who runs the same file twice is not asked twice, and a
nightly import does not build a queue nobody can face. A **resolved** item is not
reopened by the same evidence arriving again — that is the value of having
recorded the decision.

### 39.3 Resolving

```
node scripts/acquisition-review.js list [--status open|resolved]
node scripts/acquisition-review.js show <review-id>
node scripts/acquisition-review.js resolve <review-id> --decision <d> --by "<name>" --reason "<why>"
```

| Decision | Effect |
|---|---|
| `approve_as_new` | Persists through the **same M8G path**, then projects the lifecycle to `review_approved`. **This was aspirational until M8J** — the command printed it and did not do it; see §41.1 |
| `merge_into_existing` | Attaches via the same enrichment path; `--target` required |
| `reject_not_locksmith` | Recorded; no prospect created |
| `reject_duplicate` | Recorded; no prospect created |
| `needs_more_information` | Note appended; item stays **open** |

`--by` and `--reason` are required and there is no `--auto`. The queue exists
because the classifier could not decide; a command that let it decide anyway
would be the classifier deciding with extra steps. Every resolution is recorded
with `actorKind: "human"`.

A **stale** resolution is refused, naming who decided it and when, so a second
operator working from a list they loaded ten minutes ago is told what happened
rather than wondering why nothing changed.

### 39.4 Merge enrichment

When dedupe concludes a listing is a business already stored:

- the **canonical prospect id is kept**;
- genuinely new normalised phones are attached, **once**;
- genuinely new evidence is appended, **once**;
- the raw published value is preserved, because that is what a reviewer checks
  against the source.

**The claims are re-recorded under the canonical prospect**, not re-pointed. A
candidate's evidence names the candidate's id; editing that field would leave a
content hash matching nothing, so the same fact would append again on every
future import, forever, into an append-only table.

**Additive only.** A merge never touches the canonical prospect's own fields. A
directory row spelling the suburb differently is not evidence the stored record
is wrong — it is evidence two sources disagree, and the ledger is where a
disagreement belongs.

**And it cannot upgrade source authority.** Re-recorded claims keep the merged
listing's own source, which is a directory. A weaker source cannot overwrite a
stronger one because it overwrites nothing: both rows remain and `assessEvidence`
still reads the strongest. This is the M8G provenance defect's mirror image.

### 39.5 Suppression is untouched by all of it

Proven: a suppressed business still blocks after merge enrichment; the M8E gate
still refuses; a review resolution cannot erase or mutate a suppression; and
**approving a candidate as new does not un-suppress it** — approval is about
identity, permission is decided at the gate from durable state.

### 39.6 Continuing the decision chain — and the limit on it

Nothing persisted decisions before M8H, so the chain only ever lived inside one
process and starting from genesis each time was correct. A durable queue changes
that: a fresh process must **continue** the chain it finds.

`createAuditLog({ initialHead, initialSequence })` hydrates from the last stored
row. `verifyRows()` is **unchanged** — hydration makes a restart continuous, it
does not make verification more forgiving.

> **SUPERSEDED BY §40 (M8I, 2026-08-08).** `laq3` puts
> `unique (prev_hash)` on `acquisition_decisions` and the limitation below no
> longer holds. It is kept because the reasoning is still the reasoning, and a
> constraint that is quietly deleted teaches the next reader nothing.
>
> ~~**SINGLE WRITER. This is not concurrency safety and must not be read as
> it.**~~
>
> - ~~A fresh **sequential** process can safely continue the chain.~~
> - ~~**Two concurrent writers could still fork it** from the same head.~~
> - ~~M8H does **not** solve distributed or concurrent append serialisation.~~
> - ~~Before multiple acquisition workers may write decisions concurrently, this
>   must be replaced or protected by a **database-level serialisation
>   mechanism** — an advisory lock, a serialisable transaction, or a chain head
>   held in a row updated under a constraint. None of those is built.~~
>
> M8I chose none of those three. All of them assume a client that can hold a
> transaction open, and this one cannot; §40.2 has the comparison.

### 39.7 One defect the real proof found

`recorded_at` is a `timestamptz`. It is written as `...000Z` and returned as
`...+00:00` — the same instant, a different string, and therefore a different
sha256. `sequence` is a `bigint` and returns as a string.

Either one silently breaks `verifyChain()`, which then reports an **untampered**
log as altered. That is the worst failure available to an integrity control,
because it destroys trust in the one thing that was supposed to be trustworthy,
and it would have been found by somebody investigating a breach that never
happened. Both are canonicalised on read, and a test pins the shape.

The in-memory store could not reproduce it — it hands back the same object. Only
real Postgres did.

### 39.8 Dev residue

**2 new rows in `acquisition_decisions`**, both fictional, from the review-queue
proof: one `review_opened`, one `review_resolved`, for
`rv_pr_m8h_review_probe_0001`.

No prospect, phone, evidence, suppression, outcome, queue or qualification row
was created, and no existing M8D/M8E/M8G row was modified. Prospect persistence
was proven against real Postgres in M8G and merge enrichment is proven offline
against the store contract; neither was worth new permanent residue.

### 39.9 Known limitations

- ~~**Single writer**, as above. The binding one.~~ **Closed by M8I** — see
  §40. Concurrent appends are refused by the database, and the refusal is
  recovered from rather than swallowed.
- `listReviewItems` folds the whole decision log in memory. Fine at pilot
  volume; a queue of tens of thousands would want the fold materialised. Still
  open, and now the largest unbounded read left (§40.10).
- A rejection is not reconsidered when *materially changed* evidence arrives —
  the same candidate id is simply not re-asked. Distinguishing "same question"
  from "new information about the same business" needs a comparison the
  architecture does not currently express.


---

## 40. M8I — the decision chain is safe for concurrent writers

**Owns (source of truth for):** how two processes append to
`acquisition_decisions` at the same time, and why the protection is in Postgres
rather than in Node.

**This section supersedes §39.6's SINGLE WRITER limitation.** That warning was
accurate when it was written and is no longer the state of the system; §39.6 is
left in place and marked, because a limitation that is quietly deleted teaches
the next reader nothing.

### 40.1 A fork is exactly two rows sharing a predecessor

Every decision row names its parent in `prev_hash`. M8H made a fresh process
*continue* the chain across a restart. Two processes reading the same head `H`
could still both mint a successor to it:

```
H --> A     two valid-looking rows, one broken history, and verifyChain()
 \          reporting a fork forever, in a table where nothing can be deleted.
  --> B
```

So the invariant is not something to coordinate around. It is something to make
**unrepresentable**:

```sql
create unique index uq_acq_decisions_prev_hash
  on public.acquisition_decisions (prev_hash);
```

That is the whole of `laq3_serialise_decision_chain.sql`. One additive index; no
table altered, no column added, no data rewritten, no trigger touched.

### 40.2 Why an index, and not a lock, a transaction or an RPC

This system reaches Postgres only through PostgREST. Every client call is one
statement in its own implicit transaction and Node cannot hold a transaction
open across calls, which rules out the usual three:

| mechanism | why not |
|---|---|
| `pg_advisory_xact_lock` | transaction-scoped — released before the INSERT is issued. A session-level lock is worse: PostgREST pools connections, so it may be held on a different backend. |
| `SELECT … FOR UPDATE` | same problem; the row lock dies at statement end. |
| `SERIALIZABLE` + retry | needs client-controlled isolation. Not available. |

A database function *would* work, and this system already has that pattern
(`claim_recording`). It was still not chosen, for one reason: **a function is a
path, and a path can be gone around.** Any future caller with an INSERT grant
could write a forking row without touching it. An index constrains the *table*,
so there is no route past it — including for the caller who has not read this
document.

It also settles genesis for free. The first row carries `prev_hash` = 64 zeroes,
so uniqueness permits exactly one genesis row, ever. A process that lost its way
and restarted the log from scratch is refused by the database rather than
quietly beginning a second history alongside the real one.

### 40.3 One global chain — and what would break the invariant

`acquisition_decisions` is today a **single global chain**: the head is read with
no entity filter and every event links to the one before it. `unique (prev_hash)`
is correct precisely because of that.

> **If the chain is ever partitioned** — per tenant, per client, per run — this
> index becomes wrong. Two partitions would legitimately each have a first row
> and legitimately each extend their own head. The invariant would have to
> become `unique (chain_key, prev_hash)`, and the partitioning change and the
> index change **must land together**. Do not introduce chain partitioning
> quietly.

### 40.4 Two unique violations that mean opposite things

Once the table carries two uniqueness rules, `23505` is ambiguous, and M8H's
"any unique violation means it is already there" became actively dangerous:

| constraint | meaning | response |
|---|---|---|
| `audit_id` | the **same** decision written twice — a retried request, a replayed job | idempotent; return the row that is already there |
| `prev_hash` | a **different** decision claiming a head somebody else has already extended | the writer **lost the race**; re-read, re-mint, retry |

Reporting the second as success would drop a decision on the floor while telling
the caller it was stored. An unrecognised `23505` is treated as a lost race, not
as success: refusing to append is recoverable, claiming to have appended is not.

### 40.5 The head is read on its own

M8H derived the head from the last element of `listDecisions()`. That was right
for eighteen rows and silently wrong from the thousand-and-first: the list is
capped, so at the cap the "last element" is the 1000th row, every later append
would hydrate a long-dead head, and with laq3 applied the first one is refused
as a fork attempt. Without laq3 it would simply have forked.

`readChainHead()` is now part of the store contract — `order(sequence desc)
limit 1`, **no entity filter**, one indexed row. A test drives a synthetic
history of 1200 rows and asserts the page truncates while the head does not.

### 40.6 The retry, and what it is not

`appendDecisionSerialised({ store, now, mint })` re-reads the head, re-mints and
re-tries. Three things about it are deliberate:

- **`mint` is a callback, not a row.** A row's `entry_hash` covers its own
  `prev_hash` and `sequence`, and its `audit_id` derives from that hash, so a
  row minted against `H` cannot be appended after `H+1`. Handing this function a
  pre-built row would make retrying impossible.
- **`mint` may return `null` to abort**, which is how a caller re-checks a
  precondition the winner may have just invalidated. `resolveReviewItem` re-runs
  its stale-resolution check on every retry — otherwise a lost race could append
  a second human decision to an item already decided.
- **Retries are bounded** (5; `maxAttempts` outside 1–20 is refused) and
  exhaustion **throws** rather than returning a falsy result. The failure being
  defended against is a caller who reports success for a decision that was never
  stored.

**Nothing in Node is trusted.** There is no mutex, no queue, no "one writer at a
time" flag — a lock inside one process says nothing about the second process,
and a guard that is only sometimes right invites people to rely on it. The
protection is the index; the helper only makes losing survivable. A ratchet
fails the build if a process-local lock is introduced here.

**A losing row is never cleaned up, because there is nothing to clean up.** A
lost race is a rejected INSERT. No decision row is deleted or rewritten to
resolve contention.

### 40.7 The real proof: two processes, one head, zero drift

Two **separate OS processes**, released by a shared wall-clock barrier. Each did
all its slow work first — construct the client, read the head, mint the row —
then spun to the instant and issued the INSERT with nothing in the way. Starting
B after A finished would have proven nothing; that is the M8H restart case.

```
[A] head: seq 2  c27ba5a6...    [B] head: seq 2  c27ba5a6...
[A] minted seq 3 -> c27ba5a6    [B] minted seq 3 -> c27ba5a6
[A] fired 1786171313232 (drift 0ms), answered in 627ms
[B] fired 1786171313232 (drift 0ms), answered in 969ms
[A] WON the head.
[B] LOST (head_taken). Re-read, re-minted, RECOVERED on attempt 1 -> seq 4.
```

Both INSERTs left in the same millisecond and their request windows overlapped.
15/15 assertions passed: same head observed, same `prev_hash` claimed, genuine
overlap, exactly one first-attempt survivor, the other refused as `head_taken`
and not as a duplicate, the loser following the winner's `entry_hash`, sequence
gapless 1..4, no `prev_hash` with two successors, and the whole chain verifying.

### 40.8 Dev residue

**2 new rows in `acquisition_decisions`**, both fictional, for the invented
`pr_m8i_race_probe_0001`:

| seq | audit_id | event | actor |
|---|---|---|---|
| 3 | `au_18efdf46da3b4697dc82` | `m8i_concurrency_probe_a` | `m8i-proof-a` |
| 4 | `au_07638d6d007eee7e08f9` | `m8i_concurrency_probe_b` | `m8i-proof-b` |

Decision rows 2 → 4; total fictional dev residue 18 → 20. No prospect, phone,
evidence, suppression, outcome, queue or qualification row was created, and no
existing M8D/M8E/M8G/M8H row was modified — rows 1 and 2 still re-hash to their
stored `entry_hash`, which is what "untouched" means for this table.

### 40.9 One defect this milestone found in its own verification

`09_laq3_verify.sql` V12 originally asserted "16 columns" on
`acquisition_decisions`. The table has **17**, and has had 17 in every commit
since the one that created it. The count was a miscount; the schema was never
wrong.

A verifier that cries wolf is worse than no verifier, because the next false
alarm gets waved through. V12 now compares the **column set** against laq1's,
alphabetically — a count cannot distinguish "one added" from "one added and one
dropped" — and a test parses the list out of the migration and fails if the
verifier's literal disagrees with it. A number in a SQL file cannot be kept
honest by review.

### 40.10 Known limitations

- **`listReviewItems` folds the decision log in memory** with a 5000-row cap.
  Fine at pilot volume, and now the largest unbounded read left: a queue of tens
  of thousands would want the fold materialised. Carried forward from §39.9.
- **The concurrency proof's laq3 gate is an attestation, not a check.** PostgREST
  exposes `public`, not the catalog, so the proof cannot confirm the index for
  itself, and every behavioural probe for "is uniqueness enforced" requires
  attempting the insert that causes the damage if it is not. The operator pastes
  the index *definition* from V3 rather than ticking a box.
- **Retry starvation is bounded but not impossible.** Five writers contending on
  one head could exhaust an unlucky one's attempts. It fails closed and says so;
  it does not queue. At pilot volume there is one writer.
- **A rejection is not reconsidered** when materially changed evidence arrives.
  Unchanged from §39.9.


---

## 41. M8J — the two blockers nobody had written down

**Owns (source of truth for):** how a review decision reaches the prospect
lifecycle, and where attempt history comes from.

The A-L policy audit found that A-L1 and A-L6 were described everywhere as *the*
binding blockers, and that this was incomplete. Two capability gaps sat
underneath them, both undocumented, and either would have made an approval
worthless on the day it arrived.

### 41.1 E-2 — a reviewed prospect could not stay reviewed

`recordReviewDecision` (A1) moved an in-memory prospect object to
`review_approved`. Nothing persisted it. `upsertProspect` deliberately never
sends `lifecycle` — correctly, because a re-run CSV must not drag a reviewed
business back to `discovered` — and **nothing else sent it either**. A persisted
prospect was permanently `discovered`, so the eligibility engine's
`review_approved` check could never be satisfied by anything in the database.

Counsel could have signed off A-L1 and not one prospect would have become
eligible.

Two smaller defects were found in the same place and fixed:

- `approve_as_new` **persisted nothing**. The CLI printed *"will create a new
  prospect"*, §39 claimed it *"persists through the same M8G path"*, and the code
  only handled `merge_into_existing`. It now uses that path, as advertised.
- the domain state machine and the column CHECK are **two independent
  constraints**, and the narrower one has to win. A transition can be legal in
  the domain and impossible in the database, and that is now refused by name
  rather than surfacing as a raw 23514. Writing this correctly took two
  attempts: the first mirrored **laq1's** CHECK, which laq2 drops and re-adds
  with all fourteen states — so the code would have refused
  `review_approved -> queued`, which dev has permitted since M8D, and the
  ratchet guarding it would have passed while being wrong. The ratchet now
  parses the LAST definition across the applied migrations and asserts the
  domain, the store's list and the effective CHECK all three agree.

### 41.2 The lifecycle projection is a compare-and-set

`store.transitionProspectLifecycle({ prospectId, expectedFrom, to, actor, reason })`
is the ONLY way the column moves. In Postgres it is one statement:

```sql
update acquisition_prospects set lifecycle = $to, history = $journal
 where prospect_id = $id and lifecycle = $expectedFrom
```

Two `.eq()` filters on one `.update()`, so predicate and write see the same row
version. `.select()` returns what was actually touched, and **zero rows is the
interesting answer** — the row is re-read to distinguish "somebody else moved
it" from "it is already where we wanted it". Both need different responses and
neither is success.

The journal append reads `history` first, which is not a race: it rides on the
same CAS, so a lost entry and a lost transition are the same event.

There is deliberately **no `setLifecycle(anything)`**. A test asserts it, and
asserts that `toProspectRow` still carries neither `lifecycle` nor `history`.

### 41.3 Decision first, projection second — the order IS the design

There is no multi-statement transaction over PostgREST. The append to
`acquisition_decisions` and the update to `acquisition_prospects` are two
writes, and either can be the last to succeed. One order is recoverable:

| order | failure leaves |
|---|---|
| **decision → projection** | a durable, attributable record of what was decided, and a lifecycle that has not caught up. Repairable by anyone, later. Eligibility stays **blocked** meanwhile. |
| projection → decision | a business marked APPROVED with **no record of who approved it or why**. Unattributable, and it fails **open**. |

So the decision is the truth and the column is a projection of it.
`projectReviewResolution` walks the prospect one legal hop at a time, journalling
each; `reconcileReviewProjections` sweeps for lags and repairs them.

**Repair appends nothing.** It reads the existing resolution. A repeated
resolution goes through `resolveReviewItem`, which already refuses with
`already_resolved` and names who decided it, so neither path can produce a second
human decision. A ratchet fails the build if the projection module learns to
write to the log.

A half-walked path is left where it stopped rather than rolled back — it is
closer to the truth than `discovered`, and the next run continues from there.

### 41.4 E-1 — attempt history was never read

`evaluate(prospect, { history })` took a caller-supplied object, and **no
production call site supplied one**: not the authoriser, the queue, the batch
assembler, the read model or the importer. Every prospect evaluated as though it
had never been called. Approving A-L6 would have enforced caps against zero.

`acquisition-history.js` is now the one derivation, from
`acquisition_contact_outcomes`, which has held the data since laq2 and needed no
schema change.

Outcomes are **totally ordered** — `recorded_at`, then `created_at`, then `id` —
because two outcomes can share a millisecond and "the latest outcome" must not
be whichever row the query returned last. `lastReachedAt` uses only rows where
`reached_the_business` is true: three unanswered rings are not a conversation,
and a recent-contact cooldown that counted them would silence a business nobody
spoke to.

### 41.5 Facts here, policy there — the seam that let A-L7 be answered later

**The history contains no `attempts` count.**

`attempts = outcomes.length` is one line, and the audit suggested it. It would
also have answered **A-L7** — does an unanswered call or a voicemail consume an
attempt? — by accident, inside a row reader, invisibly to every review that
followed.

So the counting lives in `acquisition-attempt-policy.js`, in
`ATTEMPT_CONSUMPTION`, where each outcome carries its own `approved` flag beside
every other unapproved rule. `no_answer`, `voicemail` and `wrong_person` are
`countsTowardCap: true, approved: false`. `describeGap()` names them, the
eligibility block quotes them, and a ratchet fails the build if they flip to true
without a recorded approval.

**Whichever way A-L7 is decided, the stored data is already right.** The answer
changes a predicate over the outcome list, not a persisted number: no backfill,
no migration, no recount. A test asserts both answers can be computed from the
same rows.

**M8J decided nothing.** It made the decision possible to implement in one place
and impossible to make by accident.

### 41.6 Unknown is not never

An unreadable history returns `available: false`, never `{ outcomes: [] }`.
Those are opposite claims — *we could not find out* versus *we checked and there
was nothing* — and only the second authorises a call.

- `assess()` refuses an unavailable history with `history_unavailable`.
- The eligibility engine reports `contact_history_unavailable`, distinct from
  `attempt_or_wash_restriction`: that one says "we know, and the answer is no".
- The **authoriser sets `historyRequired: true`**, so the final pre-dial decision
  cannot be reached with a caller-built history or none at all. A caller who
  supplies one is ignored; the gate's own read wins. Proven by a test that
  passes a clean history over three durable no-answers and is still refused.
- Every decision carries `historySource`: `durable` | `caller` | `unavailable` |
  `absent`. The read model surfaces it per row, so a preview may run without one
  and still cannot let it read as "never called".

### 41.7 No new SQL

The lifecycle column, its CHECK (widened by laq2 to all fourteen states), the
`history` journal and the outcomes table all already existed. `acquisition_prospects` carries **no append-only trigger** —
the four triggers guard evidence, decisions, suppressions and outcomes — so it
is legitimately updatable, which is exactly why the guard had to be a CAS rather
than a hope.

### 41.8 Proof, and dev residue

**E-1 was proven against real dev Postgres, read-only, 16/16, ZERO RESIDUE.** It
folds the fictional outcome row M8D already left behind and asserts the
round-trip: `timestamptz` back to a parseable instant, `reached_the_business`
back as a real boolean, `lastReachedAt` derived only from reached rows, the same
answer twice, an unreadable store refusing, and A-L7 still open. That last class
of defect — a value that survives the in-memory store and not the database — is
what M8H hit and why the read proof was worth running at all.

**E-2 was proven against real dev Postgres on 2026-08-09, under explicit founder
approval**, because it is the first thing in this system that UPDATEs a row
rather than appending one. `scripts/dev/acquisition-lifecycle-proof/run.js`
performed a round trip `review_approved → review_pending → review_approved` on
`pr_3740207ebbc0a379910f` — already fictional, already on dev since M8D, and
already at `review_approved`, which is what let the trip end where it began. It
refuses to run without `M8J_LIFECYCLE_PROOF_WRITE=yes`.

The **permanent dev residue is exactly what was approved, and nothing else**:

| | before | after |
|---|---|---|
| `lifecycle` | `review_approved` | `review_approved` (unchanged) |
| `history` | 0 entries | **2 entries** — the two hops, each with actor `m8j-proof` and a reason |
| `updated_at` | `2026-08-07T13:04:02.910734+00:00` | `2026-08-09T00:36:42.287+00:00` |

**No row was created in any table and no append-only table was written to.** The
eight acquisition tables held **20 rows** in total **as at M8J** — the figure is
**21** now, because M8K's behavioural probe later added one permanent wash row to
a ninth table (§43.7); nothing else has been added since, and E-5 added nothing.
`acquisition_decisions` is still **4** rows, and the decision chain still verifies end to end with its
head at the M8I concurrency probe — the projection wrote no second decision,
which is the property §41.1 exists to guarantee.

`verify.js` re-checks that world read-only, **16/16, zero residue**: the two
transitions it attempts are both refused inside Node before any statement is
sent (`already_at_target` and `stale_lifecycle` are decided before the UPDATE).
It also proves the read path end to end — a gap-free record carrying the
lifecycle read back from Postgres now PASSES `record_valid`, and the identical
record at `review_pending` is refused, so the pass is not vacuous.

One probe in the first run was wrong and the code was right. `run.js` L3 asked
for `expectedFrom: review_pending, to: review_approved` while the row was
already `review_approved` and expected `stale_lifecycle`; it got
`already_at_target`. That ordering is deliberate — a reconciler cannot know
whether its previous attempt landed, so a repair that finds its target already
reached must not be reported as a conflict. A genuine stale case needs a target
the row is not already at. Both readings are now pinned by a test in
`test/acquisition-lifecycle.test.js` rather than left to be rediscovered.

### 41.9 Known limitations — SNAPSHOT as at M8J, largely superseded

> Three of these have since been closed. **E-3** closed in M8K (§43), **E-5** in
> §44 and **caller-supplied duplicate resolution** in §45; the entries are left
> as written because this section records what M8J knew.
> [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md) is the live
> list and wins wherever it disagrees.

- **E-5 — durable batch approval** is still open. `context.batch` is
  caller-supplied and there is no batch table. Not a hard blocker for one
  attended founder-approved call; a blocker for anything unattended or repeated.
  See the register §5. **— CLOSED in §44, with no SQL.**
- **E-3 — durable DNCR wash storage** is still open. The wash store is an
  in-process `Map`; a wash does not survive a restart. **— CLOSED on dev in §43.**
- **Duplicate resolution** is still caller-supplied, the same shape of gap E-1
  just closed for history. **— CLOSED in §45, with no SQL.**
- `listOutcomes` has no explicit limit and inherits PostgREST's page cap. Scoped
  per prospect it is small; the unfiltered call is the one to watch.
- `listReviewItems` still folds the log in memory with a 5000-row cap (§40.10).

---

## 42. A-L6 / A-L7 / A-L8 — the founder attempt policy, approved

**Approval `AL6-AL7-AL8-2026-08-10`, Peter Dang.** This section is the values
actually in force. Every table dated earlier in this document is a snapshot of
what was proposed before this approval existed, and is labelled as such.

### 42.1 What was decided

| Question | Decision | Was |
|---|---|---|
| Maximum **counted** attempts per business | **2** | 3, illustrative |
| Minimum spacing between ordinary attempts | **2 days** | 2 days, unsourced |
| Does a **no-answer** consume a counted attempt? | **No** | proposed yes |
| Does a **voicemail** consume one? | **Yes** | proposed yes |
| `not_interested` | **permanent** no cold re-acquisition | 180-day cooldown |
| `declined` | **permanent** no cold re-acquisition | 90-day cooldown |
| Requested **callback** | honoured **14 days**, then fails closed | 14 days, unsourced |
| Generic post-contact cooldown | **RETIRED** as a binding rule | 30 days |

The statutory 30-day DNCR wash validity is untouched — it was never the
founder's to decide.

### 42.2 Counting is a predicate, not a stored number

M8J deliberately kept the attempt COUNT out of the row reader so that A-L7 could
be answered without touching data. That paid off exactly as designed: answering
it changed one predicate in `acquisition-attempt-policy.js` and **no stored row
changed at all**. No backfill, no migration, no recount.

```
no_answer → no_answer → no_answer          0 counted attempts — still callable
voicemail → voicemail                      2 counted attempts — cap reached
no_answer → voicemail → no_answer → voicemail   2 counted attempts — cap reached
```

The **retry-spacing clock** starts at the last recorded call event of ANY kind,
including a no-answer. An uncounted attempt still rang somebody's phone, and the
two days are owed from the ringing rather than from the bookkeeping.

### 42.3 A decline is permanent, and is not an opt-out

`not_interested` and `declined` both mean the business is never cold-acquired
again. Three properties matter and each is tested:

1. **Permanent.** No `readyAt`, no `temporary: true`, still refused years later.
2. **Distinct.** The two labels stay separate in the stored vocabulary and in
   the explanation a human reads, because "they weren't interested" and "they
   said no" are different facts even when today's consequence is one.
3. **Not an opt-out.** No suppression row is written. An opt-out is a request
   the *person* made; a decline is an answer the *business* gave, and recording
   one as the other would fabricate a do-not-contact request nobody made — in an
   append-only table, where it could not be taken back.

The refusal is recomputed from the durable outcome row on every read, which is
why it survives a restart, a re-import and a brand new process without anything
else having to remember it. **This is why A-L8 needed no SQL.** A new
suppression *reason* would have needed an `alter … check` against `laq2`; a new
lifecycle state would have needed one against `laq1`. Neither was necessary.

A refusal is found **anywhere in the history**, not read off the latest outcome.
Reading only the latest is the failure this shape prevents: one later row — a
stray no-answer from an in-flight call, a corrected import — would otherwise
push the refusal off the end and make the business callable again.

### 42.4 An invited callback is not a cold call

A callback the recipient explicitly asked for is honoured despite the ordinary
2-day spacing and despite the counted-attempt cap, because neither rule is about
a call the business requested. It is bounded hard by the 14-day honour window;
past that the request has lapsed and the policy returns
`callback_window_expired` rather than letting the business fall back into the
cold-calling pool. An expired invitation is not a permission.

### 42.5 What stops the placeholders coming back

- Retired rules are kept with `value: null` and `retired: true` rather than
  deleted, and they ignore overrides outright.
- `DEFAULT_CAPS.maxAttemptsPerProspect` is **2**; the illustrative 3 is gone
  from config as well as from the policy.
- A per-campaign override may make a rule **stricter, never looser** (A-L4).
  An override that would raise the cap or shorten the spacing is clamped back to
  the approved value and recorded in `refusedOverrides`.
- The policy refuses to report itself approved while **any** rule, outcome or
  consumption entry is still unapproved. An approval cannot outrun its contents.
- A named approver is still required. Approved *values* are not an approved
  *policy*, and the eligibility engine still defaults to the unapproved one, so
  a build that forgets to supply the approved policy refuses to call anybody.

### 42.6 What this did NOT decide

**A-L10, raised here and left open:** because a no-answer consumes no counted
attempt, the cap no longer bounds how many times a never-answering business may
be rung — only the 2-day spacing does. That wants an answer before any repeated
campaign. It does not block a first call, since a business that has never been
called has no history for such a ceiling to bound, and it has deliberately not
been given an invented number.

**A-L1 is untouched and still binding.** So is **DNCR-1**.

---

## 43. M8K — durable DNCR wash storage (E-3), closed on dev

**`laq4_create_dncr_washes.sql` was applied to DEV on 2026-08-10, by hand.
NOT applied to production.** The durable path has since been proven against real
Postgres across two genuinely separate OS processes — see §43.6. **E-3 is closed
on dev and open for production**, which has no acquisition schema at all.

### 43.1 The gap it closes

Until now the wash store was an in-process `Map`. A wash a human performed,
attested and imported did not survive the process exiting: after a restart every
number read back as `unknown`, which vetoes. The failure direction was always
safe, but it also meant a real wash could never actually authorise anything
across a restart, and the DNCR gate could not go green even in principle.

### 43.2 A ledger, not a flag

The obvious schema is one row per number with a boolean `washed`. It cannot
answer the only question that matters, which is not "was it washed" but "is what
we know still good enough to rely on **right now**".

So `acquisition_dncr_washes` stores wash EVENTS and nothing derived from them —
`washed_at`, `result`, `attested_by`, `mode`, `authoritative`, `batch_ref`,
`source`, `recorded_at` — and freshness is recomputed at read time on every
call. A wash that crosses the statutory 30 days becomes unusable **without any
row changing and without anything having had to notice**. Nothing decays in the
database, and nothing is ever rewritten because time passed.

A stale wash decays to `unknown`, never to its last answer. There is no
`unknown` in the `result` CHECK, deliberately: unknown is the ABSENCE of a
usable row, not a row, and storing it would invite somebody to read "we recorded
that we do not know" as a check having been performed.

### 43.3 Three states, and now four reasons

| State | Meaning |
|---|---|
| `not_listed` | we washed, and the number was absent from the Register |
| `listed` | we washed, and it was present |
| `unknown` — never washed | nobody has checked this number |
| `unknown` — stale | we checked, and the check has expired |
| `unknown` — **unavailable** | **we could not read the ledger at all** |

The last is new in M8K and is kept apart from the others. All of them veto, so
the call is refused either way — but "never checked" is a fact about the number
and "could not read" is a fault in this system, and a founder shown the first
would go and wash a number that may already have been washed. Eligibility names
it `dncr_store_unavailable`, and `hydrateWashStore` returns an explicitly
unavailable store rather than an empty one. **An empty `Map` presented as a
successful read is indistinguishable from "nobody is on the Register", and that
mistake authorises calls.** An unavailable store also refuses to be written to,
so a failed read cannot accept an import and appear to have worked.

### 43.4 Ordering, idempotency and canonical numbers

- **The newest wash wins by when it was PERFORMED, not when it was recorded.**
  Paperwork arrives out of order; a June wash filed after an August one must not
  displace it. `latestWashFor` orders on `washed_at`.
- **Re-importing the same run does not duplicate.** laq4's unique index covers
  `(e164, washed_at, result, coalesce(batch_ref,''))` — `coalesce` because NULLs
  are distinct in a Postgres unique index, so without it two imports with no
  batch reference would both be allowed. A 23505 is reported as `created: false`.
- **A wash is recorded against a telephone, not a spelling of one.** Numbers are
  canonicalised through `acquisition-phone.js` on the way in, so a file that
  writes the same number two ways produces one row.
- **A future `washed_at` is refused by a trigger**, not only by the application.
  It is the one input error that silently EXTENDS how long we believe we may
  call somebody. It is a trigger rather than a CHECK because Postgres does not
  allow `now()` in a check constraint.
- **A fixture result can never be authoritative.** `authoritative` is derived
  from `mode` in both adapters and enforced by a CHECK that ties the two
  together, so test data cannot be presented as a real wash.

### 43.5 What M8K is not

No DNCR account, endpoint, credential, API, SOAP, SFTP or scrape — and ratchets
in `test/acquisition-dncr-durable.test.js` fail the build if one appears,
including a check that the string `"live"` never becomes a mode. The wash still
happens **out of band**, performed by a person against the real Register, and
enters as attested data. `scripts/acquisition-dncr-import.js` loads it, dry-run
by default, `--write` typed in full, `--attested-by` mandatory.

**The official export's shape is unknown to this repository**, so it does not
pretend otherwise. The CLI defines a small canonical AIDA format
(`e164,result`); mapping a real DNCR export is **pending a sample from the
founder** and belongs beside the other import profiles when one arrives.

**DNCR-1 is untouched.** Nobody holds the account, so no wash can be attested
yet. M8K gives an attested wash somewhere durable to live; it does not produce
one.

### 43.6 The dev proof — two processes, one row, two answers

`scripts/dev/acquisition-dncr-proof/` is **read-only**: a baseline, two separate
OS processes, and a later-instant evaluation. **33 checks, zero residue**, and
the wash ledger's sha256 is byte-identical before and after.

The subject is the one fictional row laq4's behavioural probe left on dev:
`+61355509999`, `not_listed`, washed `2026-08-09T00:00:00Z`, attested
`laq4-verify`, `mode: import`, `authoritative: true`. It is not a real wash.

| | evaluated at | answer |
|---|---|---|
| Process A | washed_at **+6 days** | `not_listed`, authoritative, usable → **DNCR gate passes** |
| Process B (new process) | washed_at **+6 days** | identical, field for field |
| Process B | washed_at **+42 days** | `unknown` (was `not_listed`), unusable → **`dncr_wash_stale`** |

Three things make this a proof rather than a demonstration:

1. **The knowledge came from Postgres.** A control in process A builds a wash
   store with no durable read; it answers `unknown` and holds zero records. The
   number is only known once the ledger is read.
2. **Process B is a different OS process** — asserted on pid — started after A
   exited. Nothing survives A but the row and a small handoff file, and B
   re-reads Postgres and compares against it rather than trusting it.
3. **Nothing changed to make the wash expire.** The +42-day answer comes from
   the *same hydrated store* as the +6-day one, and the ledger hash is identical
   afterwards. Freshness is a question about when you ask, not a property
   stored on the row and not a background job that rewrites it.

The stale refusal is also specific: `dncr_wash_stale`, not `dncr_not_checked`
and not `dncr_store_unavailable`, and the founder is told to wash the number
**again** rather than for the first time.

### 43.7 What dev holds, and what it does not mean

**21 fictional rows across nine tables** — the 20 from M8D/M8E/M8G/M8H/M8I plus
M8K's single wash row. `acquisition_decisions` is still **4**: laq4 wrote no
decision. The durability proof added nothing.

**That row is not evidence anybody may be called.** It is fictional, attested by
a verification probe rather than by a person who washed a real list, and it
belongs to no business. **DNCR-1 is still open**: nobody holds a Register
account, so no real wash has ever entered this system. M8K built the place a
real wash will live and proved that place works.

Mapping a genuine DNCR export is still **pending a real sample** — the CLI's
canonical `e164,result` format is what exists until one arrives. There is no
live DNCR API, SOAP, SFTP or account anywhere in this repository, and ratchets
fail the build if one appears.

### 43.8 A verifier defect, found and fixed

Section 5 of `11_laq4_verify.sql` originally wrote its probe row with
`now() - interval '1 day'` and then told the operator to "re-run 5d verbatim" to
demonstrate the idempotency index.

**That was wrong in the direction that reads as a pass.** `washed_at` is part of
the unique key `(e164, washed_at, result, coalesce(batch_ref,''))`, so a second
run a minute later carried a different `washed_at`, produced a different key, and
would have inserted a **second permanent row** — leaving the operator believing
they had proven duplicates were impossible while creating one.

Every timestamp in that section is now a literal, 5d and 5e are byte-identical
on purpose, and the section carries a warning that it has already been run
against dev and must not be run there again.

---

## 44. E-5 — durable founder batch approval, closed with no SQL

**No migration was written and none was applied.** Every durable structure this
milestone needs already existed and has been on dev since M8D/M8I. E-5 is closed
offline and proven across two genuinely separate OS processes; see §44.8.

### 44.1 The gap it closes

The batch machinery had worked since A2. `acquisition-batch.js` assembled a
reviewable batch, hashed it, refused to approve one containing an ineligible
record, and detected staleness; the eligibility engine refused
`founder_batch_approval_missing` unless a batch approval was present. All of it
lived in memory.

Three consequences, in ascending order of seriousness:

1. **A restart lost it.** A batch approved this morning left nothing behind for
   an afternoon worker to read.
2. **Nobody could attest what an approval had covered.** The membership was
   never written down — the same class of gap E-2 closed for review decisions.
3. **It was assertable.** `context.batch = { approved: true }` cleared the check.
   An object with no author, no timestamp and no membership satisfied the one
   gate whose entire purpose is to record that a named human looked at a
   specific list of businesses and said yes.

The third is why E-5 is a correctness item and not only a durability one.

### 44.2 Why acquisition_decisions, and why no new table

An approval is a **decision**, and this repository already keeps decisions in one
append-only, hash-chained ledger. The audit asked whether that table could
represent this safely rather than assuming it, and every property needed was
already there:

| requirement | what already provides it |
|---|---|
| `entity_type` admits `batch` | **laq1**, in the CHECK as written — no ALTER needed |
| structured membership | `detail jsonb`; 25 members is small |
| efficient lookup | `idx_acq_decisions_entity (entity_type, entity_id)` |
| a historical approval cannot be edited | `acq_decisions_no_update` trigger |
| a removed or altered approval is detectable | the `prev_hash` chain |
| concurrent approvals cannot fork | `unique (prev_hash)` — **laq3**, applied M8I |

So a durable approval is one or two rows per batch:

```
batch_approval_recorded    approve   who, when, why, and the exact membership
batch_approval_withdrawn   reject    who withdrew it, and why
```

and current state is a fold over the rows for one `entity_id` — exactly how the
review queue (§39), suppression and outcomes already work. A `batches` table with
an `approved` boolean would have been a status column over a decision.

**The event names are deliberately not `batch_approved`/`batch_approval_revoked`.**
Those two are already used by `acquisition-batch.js` for its in-process session
audit. A test pins that a persisted `batch_approved` row confers nothing.

### 44.3 Batch identity is the content

`entity_id` is `ba_<membershipHash>`, derived from the membership itself:

```
membershipHash = contentHash({
  v: "acq-batch-approval-1",
  schemaVersion,
  campaignId,
  policyVersion,
  members: [{ rowId, prospectId, e164 }] sorted by rowId,
})
```

Deterministic, with **no clock, no random id and no assembly timestamp**, and
independent of the order the caller held the rows in. A changed batch is
therefore a *different entity with no approval of its own*, and no amount of
replaying an approval object can reach it. A random batch id would have protected
nothing — it names a container whose contents can be swapped after the founder
looks at them.

`rowId` rather than `prospectId` alone, because A1 derives `prospectId` from the
identity fingerprint and two records for one business in one suburb share it.

The **label is not in the hash**: renaming a batch must not invalidate an
approval, and naming two different lists the same thing must not make them one.

### 44.4 Two hashes, and the distinction that required them

The single most consequential decision in the milestone.

| | covers | answers |
|---|---|---|
| `batchHash` (`acquisition-batch.js`) | membership **and each row's eligibility** | "has anything changed since you looked at this screen?" |
| `membershipHash` (`acquisition-batch-approval.js`) | **who, and on what number**, plus schema/campaign/policy version | "is this the exact list that was approved?" |

`batchHash` is right for the founder's screen and wrong for a durable approval.
A DNCR wash expiring, a suppression arriving, an attempt cap filling or a window
closing all change it — so a durable approval bound to it would read STALE while
the membership was untouched. A founder asked to re-approve an unchanged list
daily learns to approve without reading.

So the durable approval binds to membership only, and the two states stay apart:

- **BATCH STALE** — the membership changed; the approval does not describe what
  would be called. Re-approve.
- **APPROVED, PROSPECT CURRENTLY INELIGIBLE** — the membership is exactly what
  was approved and something else refuses the call right now. Nothing to
  re-approve, and `batch_approval` does not even appear in `failedChecks`.

A test asserts the second directly: with a durable approval in place and no
DNCR wash, the refusal is `dncr_not_checked` and the batch check is absent.

### 44.5 What changed at the M8E gate

`createDialAuthoriser` now performs a **third** authoritative read, on the same
terms as durable suppression (M8E) and durable contact history (M8J). The
caller's `batch` is **removed from the context in the same statement that
captures it**, so it cannot reach the engine:

```js
const { batch: callerBatch = null, ...callerContext } = context || {};
// ...
const batchApproval = await resolveBatchApprovalForProspect({
  store, prospectId, e164, batchKey: callerBatch ? callerBatch.batchKey : null,
});
const eligibility = active.evaluate(prospect, {
  ...callerContext, at: instant, history: contactHistory, batch: batchApproval,
});
```

Its `batchKey` survives as a *reference* that narrows the lookup and confers
nothing: if the store says there is no approval, there is none, whatever the
object claimed.

Two paths exist and both are durable:

- **named** — the caller knows the batch key;
- **search** — the caller knows only a prospect. This is the restart path: a
  fresh worker does not have to be told which batch to trust.

The number is compared as well as the business. An approved business whose
callable number has since changed is refused as `batch_membership_changed`,
because membership is who **and** on what number.

Decisions now carry `batchSource: durable | caller | unavailable | absent`,
mirroring `historySource`. A ratchet asserts every authorised decision reports
`durable`.

### 44.6 Fail closed, and whose failure it is

`batch_approval_store_unavailable` is a new eligibility code, distinct from
`founder_batch_approval_missing` for exactly the reason
`contact_history_unavailable` is distinct from `attempt_or_wash_restriction`:
one says *we looked and this batch was never approved*, the other says *we could
not look*. A founder told the first goes and approves; a founder told the second
goes and fixes the store. Reporting ours as theirs sends them to the wrong place.

It is reported at the batch check's own precedence, so a **suppressed business is
still reported as suppressed** even when the approval store is unreadable. A test
pins that.

The write path fails closed too: an approval is not appended against a store
whose current state could not be read first.

### 44.7 The operator command

```
node scripts/acquisition-batch.js preview --prospect <id> [--prospect <id> ...]
node scripts/acquisition-batch.js approve <batch-key> \
      --prospect <id> [...] --by "<name>" --reason "<why>"
node scripts/acquisition-batch.js show <batch-key>
node scripts/acquisition-batch.js list [--status approved|withdrawn]
node scripts/acquisition-batch.js revoke <batch-key> --by "<name>" --reason "<why>"
```

`approve` makes you name the prospects **again**, next to the key. That looks
redundant and is the safety property: the key is derived from the membership, so
re-deriving it from what you name and comparing it against what you typed is what
proves the list has not moved since `preview` printed it. A command taking only a
key would be approving a name.

- `preview` writes nothing and prints the exact membership, the hash, and whether
  it is already approved.
- `--by` and `--reason` are required. There is no `--yes`, no `--all`, no default
  approver, and a system actor (`system`, `aida`, `bot`, `ai`, `claude`, …) is
  refused by name.
- Approving the same unchanged batch twice is **idempotent** — the second run
  writes nothing and says so.
- A stale batch is refused with both keys printed and an instruction to re-run
  `preview`.
- Dev-only, and it has no provider, network or dialler.

### 44.8 The proof

`scripts/dev/acquisition-batch-approval-proof/`, two genuinely separate OS
processes. **Process A: 9/9. Process B: 26/26.**

Process A invents a batch, approves it, proves the approval is idempotent, proves
a system actor cannot make one, and **exits** — its heap gone before B starts.
Process B never sees an approval object. It reads the approval back, confirms the
same person, instant, hash and membership, and then:

| | |
|---|---|
| B8–B9 | the real M8E gate **authorises**, with `batchSource: durable`, from a context containing no `batch` at all, and only then mints a slip |
| B10a–b | an un-approved business fails **only** the batch check, and asserting an approval in the context changes nothing |
| B11–B13 | adding a business yields a different key, and the old approval does not stretch to cover it |
| B14 | an approved business on a **different number** is refused as stale |
| B15–B17 | an opt-out recorded **after** approval still refuses, the batch approval is still valid, and no slip is minted |
| B18–B19 | an unreadable store is `unavailable`, never "not approved" |
| B20–B24 | withdrawal takes effect immediately, deletes nothing, and the chain still verifies |

**Zero database residue.** The store is a JSON file, deliberately: what E-5 has
to prove is a property of the fold over append-only rows, which does not know
which durable thing the rows came from. Proving it against dev would have
appended a **permanent** approval row to an append-only table to demonstrate
something that needs none, and the adapter's row mapping is already covered by
`test/acquisition-store.test.js` and the M8H/M8I proofs.

An earlier version of probe B10 reused the first business's collaborators, so
DNCR refused before the batch gate was reached: it printed a refusal that proved
nothing about E-5. It now wires the second business so every other check passes,
and the batch gate is the only thing that can refuse.

### 44.9 The pilot ceiling, now enforced

`maxBatchSize: 25` was a config value **nothing read**. It is now enforced at
identity: a batch of 26 cannot be identified and therefore cannot be approved,
and the refusal names A-L9 rather than inventing a larger number. The value is
unchanged.

### 44.10 A-L9 is deliberately still open

E-5 supports one named founder or operator per approval. It invents **no** second
approver role, **no** threshold above which two are required, and **no**
automatic or AI approval. `actorKind: "human"` is written in one place and a
ratchet asserts it is the only value that appears; another fails the build if a
`secondApprover`/`approvers` concept is introduced without the decision being
made.

### 44.11 Known limitations

- `listBatchApprovals` folds the log in memory with a 5000-row cap, the same
  honest bound `listReviewItems` carries (§40.10). Fine at 25-business batches;
  a campaign with thousands would want the fold materialised.
- **No approval has ever been written to dev or production**, and one would be
  permanent. E-5 is closed as engineering; the first real approval is a founder
  decision, not a milestone step.
- Duplicate resolution is still caller-supplied — the last remaining input of
  that shape, and the natural successor to this work. **— CLOSED in §45**, which
  is exactly what it became.

---

## 45. M8L — durable duplicate resolution, closed with no SQL

**No migration, no new decision event, and no second truth source.** The answer
M8L needed had been written to `acquisition_decisions` since M8H; nothing was
reading it at the moment it mattered. Proven across two genuinely separate OS
processes — see §45.7.

### 45.1 The gap, and why it was not a missing check

`acquisition-dedupe` has been careful since A2: named signals rather than a
similarity score, no threshold anybody has to take on faith, and only an exact
duplicate may consolidate without a person looking. Default-deny held as well —
an absent `duplicateResolution` refused.

The defect was in where the answer came from. `context.duplicateResolution` is
the output of `resolveDuplicates()` over a record set **the caller chose**, and

```js
resolveDuplicates([theOneProspect])
```

is a valid resolution object in which nothing can be a duplicate of anything,
because there is nothing to compare against. That is the object every test, every
dry run and both dev proofs actually built, and it cleared the gate. It was the
same careful module that would have caught the duplicate, pointed at nothing.

A test in `test/acquisition-duplicate-state.test.js` reproduces exactly this
before closing it: two differently-named businesses publishing one number are
flagged `possible_duplicate_requires_review` when analysed together, and `unique`
when either is analysed alone.

None of it was durable either. A founder's judgement about an ambiguous identity
was recomputed in memory on every run and never consulted at the final gate.

### 45.2 Why the M8H review decisions, and why no new event

The review queue has recorded this since M8H, in the append-only decision log,
keyed by the candidate's prospect id. Its five outcomes ARE the five states M8L
has to answer:

| review outcome | durable duplicate state | reported at the gate |
|---|---|---|
| open, or `needs_more_information` | unresolved | `duplicate_requires_resolution` |
| `approve_as_new` | a distinct business | passes |
| `merge_into_existing` + `mergeTarget` | merged | `duplicate_of_canonical`, canonical named |
| `reject_duplicate` | rejected as a duplicate | `duplicate_of_canonical` |
| `reject_not_locksmith` | rejected, not about duplication | `review_decision_rejected` |

A `duplicate_resolved` event alongside them would have been a second truth source
that could disagree with the review queue, and the disagreement would be
discovered by a call to the wrong business. So M8L adds no event, no column and
no table — `acquisition-duplicate-state.js` reads what a human already decided.

### 45.3 The one inference, stated plainly

A prospect with **no** review item is treated as durably cleared — but only if a
prospect **row** exists for it.

`acquisition-persist` writes a row only for candidates the import did NOT hold. A
candidate with a duplicate concern is held, a review item opens, and no row is
written (§39). A row therefore means dedupe ran across the whole import and did
not flag this business, or a human approved it as new. Either is a real,
durable clearance.

The converse is what makes it safe. A prospect object that exists only in a
caller's memory has never been compared against anything and is refused as
`duplicate_never_assessed`, rather than passing because no review happens to name
it. **Absence of a review is evidence only when there is a row whose existence
required one not to be needed.**

This is the one place M8L infers rather than reads, and it is written down here
because it is load-bearing.

### 45.4 What changed at the M8E gate

`createDialAuthoriser` now performs a **fourth** authoritative read, on the same
terms as durable suppression (§36), durable contact history (§41) and the durable
batch approval (§44):

```js
const { batch: callerBatch = null, duplicateResolution: _callerDuplicates = null, ...callerContext } = context || {};
// ...
const duplicateState = await resolveDuplicateStateForProspect({ store, prospectId: prospect.prospectId });
const eligibility = active.evaluate(prospect, {
  ...callerContext, at: instant, history: contactHistory, batch: batchApproval, duplicateState,
});
```

`duplicateResolution` is captured only so the rest-spread cannot carry it
through. **No caller hint is accepted and none is needed**: a prospect names
itself and review items are keyed by that same id, so there is deliberately no
parameter that could point the lookup somewhere more convenient. A test asserts
the signature takes exactly `{ store, prospectId }`.

When a durable `duplicateState` is present the engine does not consult
`duplicateResolution` at all — not as a tiebreak, not merged with. Two sources
for one question is how they come to disagree.

Decisions now carry `duplicateSource: durable | caller | unavailable | absent`,
alongside `historySource` and `batchSource`. A ratchet asserts every authorised
decision reports `durable`, and two more assert the gate contains no
`resolveDuplicates(` or `duplicateStatusFor(` call of its own.

### 45.5 Merge, distinct, reject

- **Merged.** The candidate never becomes a prospect; what it knew is attached to
  the canonical business (§39 `attachMergedListing`). The canonical is the only
  callable identity and the refusal names it. This holds even if a row for the
  candidate exists anyway and the lifecycle projection has run — a merge moves no
  lifecycle (§41.1), so the durable merge decision is what refuses.
- **Approved as new.** The identity question is settled and nothing else is. The
  record must still be stored, and every other gate still applies.
- **Rejected.** Not callable. An exact re-import does not resurrect it:
  `openReviewItem` finds the resolved item and refuses to reopen it, and even if
  something did persist the row the durable rejection still refuses at the gate.
  `reject_not_locksmith` is reported as itself rather than dressed up as a
  duplicate — and it is checked here at all because the lifecycle that would
  otherwise block it is a PROJECTION of the same decision, and a projection that
  has not landed must not leave a rejected business callable.

**Whether materially new evidence should reopen a rejected identity is
deliberately not modelled.** It is a real question; M8L does not pretend to
answer it.

### 45.6 Fail closed

`duplicate_resolution_store_unavailable` is a new eligibility code, distinct from
`duplicate_requires_resolution` for the same reason `contact_history_unavailable`
is distinct from `attempt_or_wash_restriction`: one says a person has to decide,
the other says we could not find out whether one already had.

There is no fallback to the caller's object, to "no duplicate known", or to empty
state. Both durable reads — the review decisions and the prospect row — are
covered, so an unreadable prospects table is `unavailable` and not
`never_assessed`. It is reported at the duplicate check's own precedence, so a
suppressed business is still reported as suppressed.

### 45.7 The proof

`scripts/dev/acquisition-duplicate-proof/`, two genuinely separate OS processes.
**Process A: 13/13. Process B: 22/22.**

Process A stores a canonical business, holds three ambiguous candidates for
review, has a named human **merge** one and **approve another as new**, leaves a
third **undecided**, records a founder batch approval so B's gate run is testing
the duplicate check rather than tripping over E-5, and exits.

Process B never sees a resolution object:

| | |
|---|---|
| B1–B6 | the decisions survived, naming the same person, instant and canonical target; the chain verifies |
| B7–B9 | the canonical business is **authorised** with `duplicateSource: durable` from a context containing no `duplicateResolution`, and only then is a slip minted |
| B10–B11 | the merged candidate is refused `duplicate_of_canonical`; no slip |
| B12 | a caller-supplied clean `resolveDuplicates([candidate])` changes **nothing** |
| B13 | an undecided identity is refused however clean the caller's analysis is |
| B14 | a record that exists only in memory is refused as never assessed |
| B15–B17 | an opt-out recorded after the resolution still refuses, the resolution is untouched, no slip |
| B18–B19b | an unreadable store is `unavailable` with its own code, and still does not outrank a known opt-out |
| B20 | the founder read model counts every bucket |

**Zero database residue.** The store is a JSON file: what M8L proves is a
property of the fold over append-only review rows, and the M8H review queue and
M8I decision chain were both already proven against real dev Postgres. A dev run
would append permanent review rows to an append-only table to demonstrate a fold.

Probe B19 was wrong first. It asserted the store-unavailable code against the
business a previous step had just suppressed, and suppression rightly outranks a
read failure — it failed for the correct reason. It now uses an unsuppressed
subject, and B19b pins the precedence that caught it.

### 45.8 The operator surface

`node scripts/acquisition-review.js duplicates` — read-only, and deliberately
part of the review CLI rather than a new command, because these are the same
decisions that CLI already resolves. It counts unresolved / distinct / merged /
rejected, names each merge's canonical target, and shows the actor, date and
reason on every decided one.

### 45.9 Known limitations

- `summariseDuplicateState` folds the log in memory with the same 5000-row cap
  `listReviewItems` carries (§40.10). The gate never calls it.
- A capped page fails in the safe direction: a resolution outside the page is not
  found and the gate refuses.
- Whether materially changed evidence reopens a rejected identity is open — §45.5.
- **`context.duplicateResolution` is still accepted by the eligibility engine**
  for preview surfaces (the batch screen, the queue preview, the read model, the
  walkthrough and the dry runs). That is deliberate: those answer "what does this
  list look like", not "may this be called". It is labelled
  `duplicateSource: "caller"` so nothing can mistake it, and the M8E gate
  discards it.

---

## 46. M8M — the founder-approved calling policy

**A-L1 and A-L3 are closed by a founder decision, not by legal advice. No lawyer
has reviewed the calling rules encoded in this repository.** That sentence is the
most important one in this section, and the code is built so that it stays true
in the reading as well as in the fact.

### 46.1 What changed: the authority, not the rules

Until M8M every prospect was refused with `counsel_approval_missing` — "the
permitted calling hours have not been signed off by a lawyer". That was accurate
for A2 and it was a blocker only an external lawyer could clear.

The founder decided not to obtain a legal opinion for the pilot, and to operate
under a written, versioned policy instead: AIDA follows the published Australian
telemarketing calling-hours framework, applies it to AI voice acquisition calls
on the same terms as any other telemarketing call, and takes the narrower option
wherever the published rules leave room.

So the question the gate asks changed — from *has a lawyer approved this?* to
*has a named human adopted a policy, in a stated version, on a stated basis?* —
and the answer it accepts changed with it. **The window did not change.**

### 46.2 The artifact

`src/services/acquisition-calling-approval.js`:

| | |
|---|---|
| Version | `acq-calling-policy-2026-08-10` |
| Adopted by | Peter Dang, 2026-08-10 |
| Kind | `founder_operating_policy` |
| `isLegalAdvice` | **`false`** |
| Basis | Do Not Call Register Act 2006; the Telemarketing and Research Calls Industry Standard — adopted as AIDA's operating policy |
| Applies to | AI voice acquisition calls to Australian businesses, recipient-local time |
| Holiday rule | No cold acquisition call on an applicable public holiday; none when coverage is unknown |

`createCallingPolicyApproval()` with no arguments is **not approved**, exactly as
`counselApproved` defaulted to false and as `createAttemptPolicy()` still does.
An engine built without an approval refuses every prospect. Forgetting to wire
the policy stops calls; it does not skip the check.

And `approved: true` alone is not an approval. It needs a **named human** — a
system actor (`system`, `aida`, `ai`, `claude`, …) is refused by name — plus a
**date**, a **version** and a **basis**. `describeGap()` reports every missing
piece at once rather than one per fix.

### 46.3 Why "approved" is fenced so heavily

The failure mode being defended against is not a bug. It is a future reader
finding `approved: true` and concluding the calling window was legally cleared.
It was not; it was adopted. So:

- `kind` and `isLegalAdvice` are **not parameters**. There is no argument that
  produces an artifact claiming a lawyer reviewed anything, and a test constructs
  one trying — passing `kind: "legal_advice", isLegalAdvice: true` — and asserts
  both are ignored.
- The artifact carries a `disclaimer` naming what it is not, and it travels on
  every calling-policy decision as `policy.approval`.
- A ratchet asserts the words *lawyer*, *counsel* and *legal advice* appear in no
  policy refusal message.
- A ratchet asserts `counselApproved`, `counsel_approval_missing` and
  `COUNSEL_UNAPPROVED` have all left the engine's live code.

**A real legal review, if one is ever obtained, is a different artifact.** It
should be added alongside this one rather than by relabelling it.

### 46.4 The retired gate

`counselApproved` is **gone**, not renamed and not aliased. An alias would have
let a caller keep satisfying the gate the old way and a reader keep believing the
old thing. A caller passing `counselApproved: true` now supplies an option that
changes nothing, and a test at the M8E gate proves it authorises nothing.

`ELIGIBILITY_CODES.COUNSEL_UNAPPROVED` → `CALLING_POLICY_UNAPPROVED`
(`"calling_policy_unapproved"`). The category mapping in `acquisition-batch.js`
follows it; historical references in §A2.3, §A2.9 and §22 are left as written,
because those sections record what A2 and M8B knew.

### 46.5 The window, unchanged and re-pinned

Mon–Fri **09:00–20:00**, Sat **09:00–17:00**, **no Sunday**; recipient-local IANA
timezone; **open inclusive, close exclusive**; DST via `Intl`, never by hand.

M8M adopted what was already encoded in `CALLING_WINDOWS` and already tested. No
boundary moved. What M8M added is a ratchet that pins each one, so a future
loosening is a deliberate act rather than an edit:

| probe | expected |
|---|---|
| 09:00 Melbourne exactly | permitted — open is INCLUSIVE |
| 08:59 | `before_permitted_hours` |
| 19:59 / 20:00 exactly | permitted / `after_permitted_hours` — close is EXCLUSIVE |
| Saturday 16:59 / 17:00 | permitted / refused |
| every hour of a Melbourne Sunday | `prohibited_day`, all 24 |
| Monday 09:00 immediately after | permitted — so the Sunday sweep is not vacuous |
| same instant, Melbourne vs Perth | permitted vs `before_permitted_hours` |

`CALLING_WINDOWS.sun` being `undefined` is asserted with a message saying that
adding one is a founder decision, not a code change. Three more ratchets assert
the gate never reads `process.env.TZ`, `resolvedOptions().timeZone` or
`getTimezoneOffset` — a server-clock fallback is the classic way this breaks.

### 46.6 Policy versus data: why A-L2 stays open

**A-L3 asked whether AIDA should call on public holidays. Answered: no.** The
published rules leave a holiday window technically available and AIDA declines to
use it. That is a policy question and it is closed.

**A-L2 asks whether we know which days those are. Untouched.** The calendar is
still the hand-compiled fixture: `authoritative: false`, national + VIC, **2026
only**, with AFL Grand Final Friday deliberately absent rather than guessed. From
**2027-01-01** it answers `known: false` and the gate refuses every date with
`holiday_coverage_unknown`.

A single test pins both halves: with the policy adopted, one decision reports
`policy.approved: true` **and** `policy.holidayCalendarAuthoritative: false`.
Choosing not to call on holidays did not improve the calendar, and the register
must not be allowed to claim it did.

### 46.7 AI semantics

AIDA applies its telemarketing operating policy to AI voice acquisition calls.
There is **no separate AI calling window and no separate AI attempt rule** — a
ratchet asserts no `aiWindow`/`aiCaps`-shaped concept exists, and that the
approval's `windows` is the *same object* as `CALLING_WINDOWS` rather than a copy
that could drift.

**No AI-disclosure wording was invented.** That is a real question and M8M
deliberately does not answer it; a ratchet fails the build if disclosure script
text appears in this module.

### 46.8 What M8M did not touch

The attempt policy (A-L6/A-L7/A-L8) is unchanged. **DNCR is unchanged** — every
callable number washed, fresh authoritative `not_listed` required, listed /
unknown / stale / unavailable all blocking — and **DNCR-1 is still open**.
Suppression still outranks every temporary calling-window block (proven on a
Sunday, where "try again tomorrow" would have been exactly the wrong message for
an opt-out). E-5, M8L, M8J and M8K all still apply, and only the M8E gate mints
an `AuthorisedDial`.

**No SQL.** Nothing here is durable state; it is engine configuration. **No dev
write.**

### 46.9 Known limitations

- **No lawyer has reviewed this.** The basis is a lay reading of published
  sources, adopted deliberately and labelled everywhere. If the reading is wrong,
  the code is faithfully wrong.
- The holiday calendar remains the weakest input — **A-L2**, with a hard
  2027-01-01 cliff that is a refusal rather than a degradation.
- The approval lives in code, not in `acquisition_decisions`. It is versioned and
  attributed but it is not append-only, so a future change is a commit rather
  than a durable event. That is acceptable while the policy is a constant and one
  person adopts it; it would want revisiting alongside **A-L9**.

---

## 47. E-7A — the provider-disabled dial execution seam

**Status: ENGINEERING SEAM BUILT / LIVE PROVIDER DISABLED.**
**E-7 remains OPEN. This is not permission to call anybody, and it cannot.**

> The authoritative status for every blocker named here is
> [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md) §10. This
> section is the milestone snapshot.

### 47.1 The question E-7A exists to answer

Since M8E the repository could mint an `AuthorisedDial` — a permission slip
produced only by a gate that had just read durable suppression, contact history,
batch approval and duplicate resolution. Nothing could consume one, because
nothing existed that consumed one. The comments said "a future dialler", and the
ratchets asserted no such thing had been built.

That left a real question unanswered: **what would consume it, and could that
thing be tricked?** E-7A answers it, and answers it while the answer is still
cheap — before a provider exists, when getting it wrong costs nothing.

### 47.2 What was built

| file | what it is |
|---|---|
| `src/services/acquisition-dial-execution.js` | the one execution entry point |
| `src/services/acquisition-dial-provider.js` | the provider interface, plus a **disabled** and a **fake** implementation |
| `scripts/acquisition-dial-proof.js` | the offline founder proof |
| `test/acquisition-dial-execution.test.js` | 57 offline tests |

### 47.3 The authenticity model had to change first

M8E authenticated a slip by a **branded symbol property**. The symbol is
exported from the module, and **object spread copies own symbol properties**, so
a spread clone of a genuine slip passed the check — and, being a fresh object,
was **not frozen**, so its destination could then be rewritten.

That was harmless while nothing consumed a slip. It would not have been harmless
afterwards, so E-7A fixed it before building the consumer:

- the mint step registers each frozen slip in a module-private `WeakSet`
- `isGenuineAuthorisedDial(value)` asks whether this is **that object**
- a forgery, a spread clone, an `Object.assign` copy, a JSON round-trip, a
  `structuredClone` and a hand-copied property set are all refused
- `isAuthorisedDial` is unchanged and still means what it always meant; it is
  simply no longer the check that may authorise execution

**Nothing in M8E was relaxed.** The gate reads exactly what it read before and
refuses exactly what it refused before.

### 47.4 The pipeline

```
M8E authoritative reads  ->  genuine AuthorisedDial  ->  AcquisitionDialExecutor
                                                              |
                                                     provider interface
                                                              |
                                 DisabledDialProvider  |  FakeDialProvider
```

No provider call is reachable from eligibility, review, batch or import code — a
ratchet asserts that exactly one acquisition module contains a provider
submission, and that it imports the authorisation gate.

### 47.5 What the executor refuses

`caller_override_rejected`, `authorisation_invalid`, `authorisation_consumed`,
`authorisation_expired`, `kill_switch_engaged`, `provider_refused`,
`provider_failed` — and `provider_accepted` when a provider took it.

These are **deliberately distinct states**. Authorised is not called. A disabled
provider is not a compliance refusal. A provider failure is not a refusal at all;
it is an unknown.

### 47.6 The provider contract

A provider receives `executionId`, `destination`, `prospectId`, `businessName`,
`authorisedAt` and an inert `metadata` object — frozen, and nothing else. It gets
no eligibility context, no permission booleans, no second number, and no batch,
duplicate, DNCR or suppression authority. **It is an execution mechanism, not a
policy engine.**

Every provider must state `live` as a boolean, and a ratchet asserts every
provider this repository can construct states `false`. A future real adapter must
either declare itself live and **fail that test**, or lie in source — which is a
visible change somebody has to make on purpose.

### 47.7 Single use, and the limitation that comes with it

One slip, at most one submission. The claim is made against object identity
**synchronously before the first await**, so ten concurrent executions produce
one submission. A refusal still spends the slip.

**This is process-local.** A second process has its own `WeakSet`. Durable
cross-process single-consumption requires a uniquely-constrained row, which
requires SQL, which is **E-7B**. It is acceptable in E-7A for one reason only:
no live provider exists. See the blocker register §10.5 for the full statement.

### 47.8 Expiry

A slip older than **60 seconds** is refused. The slip always described itself as
permission "as at `authorisedAt`", and E-7A is the first thing able to enforce
that. A slip dated in the future is refused too.

### 47.9 No retry

A provider failure returns an explicit uncertain state and stops. An ambiguous
timeout may mean the call was placed; retrying is how one authorisation becomes
two calls to one business. A ratchet asserts the execution path contains no
retry, backoff, timer or loop.

### 47.10 Nothing here is contact

A fake submission records no outcome, consumes no attempt, and leaves the derived
contact history at zero. The executor does not import the outcome recorder and
cannot reach `appendOutcome`. **Dispatch requested is not prospect contacted**,
and the result object says so on every result.

### 47.11 What did not happen

No SQL was written or applied. Nothing was written to dev or production — the
proof uses an in-memory store. No provider, prospect, Register, Outscraper,
Retell or Twilio was contacted. No call, SMS or email. `acquisition_decisions`
is still 4 rows and dev's fictional residue is still 21.

### 47.12 Honest limitations

- **Single-consumption is process-local** (§47.7). The headline one.
- **There is no durable kill switch.** The executor re-reads an injected one
  immediately before the provider, but the switch is still a caller-supplied
  context field. E-7B needs a stop no caller can decline to pass in.
- **The 60-second window is a judgement**, not a derived constant. It is short
  because the slip asserts the world has not changed, and the world can change.
- **The seam has never run against a real provider**, by design. Everything
  known about its behaviour under a live adapter is inference.


---

## 48. E-7B1 — durable dispatch authority and a durable emergency stop

**Status: IMPLEMENTED OFFLINE. LAQ5 WRITTEN, APPLIED NOWHERE. E-7 remains OPEN.**

> Authoritative status: [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md).
> Full design and the exact SQL: [ACQUISITION_E7B1_DESIGN.md](ACQUISITION_E7B1_DESIGN.md).

### 48.1 What E-7A left open, and why it mattered

E-7A said its single-consumption guarantee was a `WeakSet` in one module in one
process, and that it was safe only because no live provider existed. E-7B1 closes
that, and two design reviews changed the answer twice before any code was written.

### 48.2 The identity had to change first

`authorisationId` is `sha256(prospectId|e164|authorisedAt|decision)`. Two
**genuinely distinct** authorisations of one business at the same millisecond
produce the **same value** — measured, and asserted by E-7A own suite as a
feature, because it makes proof transcripts comparable. A colliding key cannot
arbitrate a claim: the second legitimate authorisation would be refused as a
replay of the first.

So every genuine slip now carries **`dispatchId`**, a `crypto.randomUUID()`
derived from nothing, alongside the unchanged fingerprint. It is **not a bearer
credential** — execution still requires the object the module-private WeakSet
gates, and knowing a dispatchId lets somebody burn an authorisation, never place
a call.

The slip also carries **`batchKey`**, taken from the durable approval, which is
why `batch_key` is `NOT NULL`: no authorised decision exists without one, and
the mint throws rather than produce a slip a NOT NULL column would later reject.

### 48.3 Two locks, because one is not enough

```
unique (prospect_id)      where resolved_at is null
unique (destination_e164) where resolved_at is null
```

The first stops two workers each minting their own authorisation for one
business — which the attempt policy cannot catch, because
`minDaysBetweenAttempts` reads `acquisition_contact_outcomes` and neither
worker has recorded an outcome yet.

The second stops the same handset being rung via two prospect rows.
`acquisition_prospect_phones` is `unique (prospect_id, raw)`, stores the number
*as published*, and has **no normalised e164 column at all**; `resolveDuplicates`
only compares the records it is handed. Two fictional locksmiths sharing one
number were **both measured as authorised** to it. This index is the only place
in the schema where a normalised E.164 carries a uniqueness rule.

It intentionally blocks two genuinely separate businesses on a shared answering
service from simultaneous unresolved dispatches. Accepted for the pilot: the
person picking up is the same person.

### 48.4 `resolved_at`, and why provider completion is not it

> **`resolved_at` is set only when the business-level question — did we contact
> this business, and what happened — has a durable answer the M8J attempt policy
> can take over from.**

Two ways, and only two: `outcome_recorded` and `operator_closed`.
`recordProviderResult` has **no such parameter**, and a ratchet asserts it never
gains one. A provider that accepted, refused, threw or vanished writes a status
and releases **nothing**.

### 48.5 The executor ordering

```
identity -> expiry -> DURABLE STOP (preflight) -> in-process claim
         -> DURABLE CLAIM -> DURABLE STOP (again) -> provider
```

The stop is read **twice**. A pause landing between the two reads stops the call
and **leaves the dispatch claimed and unresolved** — releasing it automatically
would mean a paused system quietly re-arming itself when unpaused.
`killSwitch` is now a **forbidden** caller option: code still passing one is
refused, because silently dropping it would look exactly like it being honoured.

### 48.6 Outcome then lock, never the other way

There are no cross-table transactions (`acquisition-durable.js:302`, since M8C).
So the outcome is written first and the lock released second. A failed outcome
leaves the lock held; a failed release leaves the lock held with the business
properly accounted for. **Lock released with outcome missing is unreachable.**
**No RPC was added** — it would optimise away the failure mode that was
deliberately chosen as acceptable.

### 48.7 What is still impossible

Applying LAQ5 does **not** enable calling. A call needs `state = enabled`
**and** a provider with `live: true`. The bootstrap row is `paused`, a test
asserts the migration never writes `enabled`, and every constructible provider
reports `live: false`. **Both locks remain shut.**

### 48.8 Honest limitations

- **LAQ5 is applied nowhere.** Until it is, the durable claim throws and
  `dispatch_store_unavailable` blocks — the correct direction to fail.
- **The in-memory store MODELS laq5 rather than substituting for it.** The static
  proofs that the real indexes exist and are predicated on `resolved_at` live in
  `test/acquisition-laq5-migration.test.js`; neither file is sufficient alone.
- **Nothing has run against real Postgres.** Every concurrency guarantee here is
  proven against a model plus the migration text, not against a database.
- **A resolved dispatch is releasable only by a human or an outcome**, so an
  abandoned dispatch holds a business until somebody acts. That is intended, and
  it is real operational work.

---

## E-10A — the outbound acquisition agent (local spec, 2026-08-13)

**The agent is NOT PROVISIONED.** `src/services/acquisition-agent-spec.js`
builds everything Retell will eventually be sent and sends none of it.

**Three names, three roles.** `assistantName` **Aida** is the thing speaking,
`companyName` **Niche Drops** is the business placing the call, and
`productName` **AIDA** is the product being discussed. Separate fields, never
merged: the agent is *from Niche Drops* and is *calling about AIDA*.

**It discloses.** Unprompted, in the opening: *"Hi, this is Aida, an AI
assistant from Niche Drops. I'm calling about AIDA, our AI receptionist for
locksmiths. We help with missed and after-hours calls, and I was just calling to
see if that might be useful for your business."* If asked whether it is AI, a
robot, automated or a person, it answers plainly and may never claim to be
human. **Founder product policy — this repository makes no claim that any law
requires those words.**

**The wording above is concept copy and remains founder-tunable.** Nothing
asserts it verbatim; the ratchets test what an opening *conveys* — assistant
named, AI disclosed, calling business named, product identified, purpose and
missed/after-hours value clear, still concise, never presenting the product as
the caller or the assistant as human.

**It takes a no the first time.** One acknowledgement, then the call ends — no
second pitch after "not interested", no second close after a decline, and after
an opt-out nothing at all except agreeing and hanging up. "Busy" and "not now"
are **not** refusals.

**It cannot promise things AIDA cannot do.** Permitted claims trace to what the
product page actually says. Forbidden: guarantees of any kind, unbuilt
integrations, human equivalence — and **the marketing tagline**, which is an
absolute that no infrastructure justifies.

**It never raises price**, and quotes only figures passed in as data.

**It leaves no voicemail.** A message costs a counted attempt under A-L7, none
has ever been written or reviewed, and machine detection has never been observed
working here. No template was invented.

Three things are open and recorded in
[ACQUISITION_E7B2_RETELL_DESIGN.md](ACQUISITION_E7B2_RETELL_DESIGN.md) §19: the
**AIDA / Niche Drops** naming discrepancy, the AI-disclosure wording being
product policy rather than legal advice, and how an opt-out is finally confirmed
from a transcript.
