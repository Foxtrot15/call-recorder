# AIDA Locksmith Acquisition — the acquisition engine (A1 · A2 · M8B)

**Status:** built dormant, **not deployed**. All SQL written, **not applied**. No
website crawled, no external API called, no number washed, no call placed.
**Scope:** the whole pipeline from sourced lead to a callable queue candidate —
discovery, source identification, evidence capture, human review, normalisation,
deduplication, qualification, the compliance gate, permanent suppression, founder
batch approval, the dormant call queue, and contact outcomes.
**Owns (source of truth for):** the acquisition vocabulary, the offline
boundary, the discovery adapter contract, the evidence ledger, the append-only
decision log, the prospect lifecycle, the human review step, the qualification
model, the queue boundary and the outcome model.

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
| `supabase/sql/laq1_create_acquisition_prospects.sql` | Four additive tables — **written, not applied** |
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

## A2.3 ⚠ Limitations that must be resolved before anything dials

**1. The permitted window is documented, not counsel-approved.**
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

| Rule | Value | Approved? | Source |
|---|---|---|---|
| DNCR wash validity | 30 days | **Yes** | Statutory — DNC Register Act 2006 / Industry Standard 2017, §2.2 & G4 |
| Max attempts | 3 | **No** | G9 says *"(e.g. 3)"* — an illustration, not a decision |
| Retry spacing | 2 days | **No** | **No source at all.** Proposed during A1 |
| Recent-contact cooldown | 30 days | **No** | G8 says *"within N days"* — N is literally the letter N |
| "Not interested" cooldown | 180 days | **No** | §9 says "a long cooldown", duration unspecified |
| Declined cooldown / callback window | 90 / 14 days | **No** | No source |

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

| # | Decision | Blocks | Current behaviour |
|---|---|---|---|
| **A-L1** | **Counsel sign-off on the permitted calling window** (Phase 0). | Any dialling | Window applied with `counselApproved: false` on every decision |
| **A-L2** | **An authoritative public-holiday source**, and which state calendars are carried per prospect. | Any dialling outside 2026 / outside VIC | Fixture, VIC + national, 2026 only; everything else refuses |
| **A-L3** | Whether the **AFL Grand Final Friday** and other proclaimed holidays are in scope. | Accuracy of the VIC calendar | Absent, so those dates are treated as ordinary |
| **A-L4** | Confirmation that the caps (**3 attempts, 2 days apart, 30-day contact cooldown**) are the intended commercial policy. | Campaign design | `DEFAULT_CAPS` applied as ceilings |
| **A-L5** | Whether calling a business's **1300/1800 number** carries the same obligations as a geographic one. | Wash scope | Treated identically — everything is washed |
| **A-L6** | **Attempt limits, retry spacing and cooldown durations** — G9's "3" is an illustration, G8's "N days" is unspecified, and retry spacing has no source at all. | Any dialling | Policy defaults to unapproved; the engine blocks every prospect |
| **A-L7** | Whether an **unanswered call or a voicemail consumes an attempt**. | Attempt accounting | Proposed as "counts as an attempt", unapproved |
| **A-L8** | The **"not interested" cooldown duration** — §9 says "a long cooldown" without saying how long. | Retry policy | Proposed 180 days, unapproved |
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

| Outcome | Reached the business? | Ends at | Consequence |
|---|---|---|---|
| `no_answer`, `voicemail` | no | `attempted` | counts as an attempt (**unapproved**, A-L7) |
| `wrong_person` | **no** | `attempted` | suppresses the **number** (approved) |
| `callback` | yes | `callback_requested` | reschedule (**unapproved**) |
| `not_interested`, `declined` | yes | `not_interested` | cooldown (**unapproved**, A-L8) |
| `opt_out` | yes | `suppressed` | suppresses the **business** (approved) |
| `booked`, `qualified` | yes | `interested` | stop calling (approved) |

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

## 23. What M8B deliberately does not do

- **Does not place, schedule or prepare a call.** There is no dialler.
- **Does not send SMS or email.**
- **Does not scrape anything.** The offline boundary is unchanged and still a
  hardcoded constant with no environment override.
- **Does not query the DNC Register.** Results are imported from an attested
  file; there is no live mode.
- **Does not apply any SQL.** `laq1` and `laq2` are both written and unapplied.
- **Does not build a dashboard.**
- **Does not wire qualification into the eligibility engine.** Commercial fit
  and legal permission stay separate questions with separate owners.

## 24. What a future milestone must do before anything dials

Everything in §A2.9 (A-L1 … A-L9) still stands and still blocks. In addition:

| # | Requirement | Why |
|---|---|---|
| **M-1** | Apply `laq1`, then `laq2`, and re-verify RLS | Both are unapplied; ordering matters |
| **M-2** | Replace the in-memory stores with the LAQ2 tables | Suppression that lives in a process is not suppression |
| **M-3** | Build a lease reaper | An expired lease should be released with a row saying so, not evaporate |
| **M-4** | Re-run eligibility **at the moment of dialling** | The queue's snapshot is for audit, not authorisation — a wash can expire between reservation and call |
| **M-5** | Decide the `service_area` / `operating_status` capture path | The discovery contract derives neither, so both are permanently unknown today |
| **M-6** | Replace the holiday fixture with an authoritative source | Coverage ends 2026-12-31 and the calendar refuses everything after it |

**M-4 is the one that matters most.** Nothing in the queue authorises a call. A
future dispatcher that trusted `eligibility_snapshot` would reintroduce exactly
the staleness this milestone was built to eliminate.
