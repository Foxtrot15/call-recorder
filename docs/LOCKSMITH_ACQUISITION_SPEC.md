# AIDA Locksmith Acquisition — Prospect Intelligence and Evidence (A1)

**Status:** built dormant, **not deployed**. SQL written, **not applied**. No
website crawled, no external API called, no number washed, no call placed.
**Scope:** the first four steps of the acquisition pipeline — discovery, official
source identification, identity and phone evidence capture, and human review.
**Owns (source of truth for):** the acquisition vocabulary, the offline
boundary, the discovery adapter contract, the evidence ledger, the append-only
decision log, the prospect lifecycle, and the human review step.

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
npm test                              # the full suite
node --test "test/acquisition-*.test.js"
node scripts/acquisition-dry-run.js   # offline end-to-end walkthrough
node scripts/acquisition-dry-run.js --verbose
```

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
