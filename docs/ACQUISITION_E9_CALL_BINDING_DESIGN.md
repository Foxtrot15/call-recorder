# E-9 — durable unique Retell call binding

**Status: IMPLEMENTED LOCALLY / DEV MIGRATION PENDING. E-9 IS NOT CLOSED.**

**The constraint described here does not exist in any database.** Phase 2 wrote
the migration (`supabase/sql/laq6_bind_provider_call_once.sql`) and it has been
applied to **neither dev nor production** — nothing in this repository can
execute DDL, and a test asserts that. E-7 remains OPEN, DNCR-1 remains OPEN,
A-L2 remains OPEN, calling remains PAUSED at revision 1, dev residue is 23.

> Sections 1–8 are the **Phase 1 audit** and describe the state before the
> migration was written. Phase 2 begins at §9, and revises §4: the founder
> required a second invariant, because a unique index cannot catch the
> same-dispatch race.

**Owns (source of truth for):** why one Retell `call_id` must belong to at most
one acquisition dispatch, why application code cannot guarantee that, and the
exact migration proposed to make the database guarantee it instead.

---

## 1. What `provider_ref` is today

```sql
provider_ref      text          -- laq5 line 135. Nullable, unconstrained.
```

No unique index, no CHECK, no foreign key. The five indexes laq5 creates are on
`(prospect_id) where resolved_at is null`, `(destination_e164) where resolved_at
is null`, `(prospect_id, claimed_at desc)`, `(authorisation_id)` and
`(claimed_at) where resolved_at is null`. **None touches `provider_ref`.**

### 1.1 Every writer

| writer | path | what it sets |
|---|---|---|
| `recordProviderResult` (`acquisition-dispatch-store.js:213`) | executor, after a provider answers | `provider_status`, `provider_ref`, `error_code`, `submitted_at` |
| E-7B2B1 reconciliation (`acquisition-call-events.js:194`) | authenticated webhook, after a lost response | `provider_ref` **only** |

Both go through `store.updateDialExecution`.

### 1.2 Can it change after a first non-null binding?

**Yes — the database permits it.** The laq5 guard's immutable list is
`dispatch_id`, `authorisation_id`, `prospect_id`, `destination_e164`,
`batch_key`, `authorised_at`, `claimed_at`, `claimed_by`. **`provider_ref` is
not in it**, and the guard's only other rules are "a resolved dispatch cannot be
reopened" and "provider status is forward-only out of `pending`". An UPDATE
touching `provider_ref` alone passes all three.

So **R1 → R2 is refused by application code and by nothing else.**

---

## 2. The exact race

There are two distinct cases, and only one of them is currently checked at all.

### 2.1 Same dispatch, different call id — checked, but not atomic

`acquisition-call-events.js:187` reads `dispatch.providerRef` and writes only if
it is null. Read-then-write across two processes: both can read null and both
can write. When both write the **same** R the outcome is identical and harmless.
When they write **different** values one silently wins.

### 2.2 Different dispatches, same call id — **NOT CHECKED AT ALL**

This is the finding that matters, and it is stronger than "the check is not
atomic": **there is no check.** The code inspects the current dispatch's own
`providerRef` and never asks whether R is already bound to some *other*
dispatch. No SELECT anywhere looks for it. Adding one would not fix it either —
it would just be a second read-then-write.

Two authenticated webhooks naming different dispatches and the same `call_id`
would today bind both, and the ledger would assert that one telephone call
belongs to two businesses.

### 2.3 Is it reachable?

Not from genuine Retell traffic. The binding key is `metadata.aida_dispatch_id`,
which **we** set at create time, and one call carries one metadata object — so
two different dispatch ids for one `call_id` is not something Retell can
produce. Webhooks are signature-verified, so forgery is out of scope.

**That is an argument about likelihood, not about correctness.** The ledger's
job is to be right about which business may have been rung, and "our reasoning
says this cannot happen" is a weaker guarantee than "the database refuses it".
Before live acquisition webhooks, it should be the database.

---

## 3. Is there any legitimate shared `call_id`?

Audited, and **no**.

- One `create-phone-call` returns one `call_id`. One dispatch makes at most one
  submission — E-7A/E-7B1 single-use.
- **Nothing retries, ever.**
- Acquisition performs no transfer, so no `transfer_bridged` leg arises.
- A `call_id` is unique at the provider and is never recycled.

### 3.1 Therefore the index is NOT partial on `resolved_at`

The prospect and destination indexes are `where resolved_at is null` because a
business may legitimately be dispatched again after an outcome is recorded. **A
`call_id` may never be rebound, not even after resolution** — it names one real
telephone call for ever. So uniqueness must hold across the whole table.

This is the one place E-9 deliberately differs in shape from laq5's other two
unique indexes, and the difference is the point.

---

## 4. Proposed migration — LAQ6

> **Superseded by §9.** This index is necessary and **not sufficient**: it
> cannot catch two workers who both read NULL and want *different* references.
> Phase 2 adds a write-once guard alongside it. The file now exists at
> `supabase/sql/laq6_bind_provider_call_once.sql` and **is not applied**.

```sql
create unique index if not exists idx_acq_dial_exec_provider_ref
  on public.acquisition_dial_executions (provider_ref)
  where provider_ref is not null;
```

**On the `WHERE` clause, precisely:** Postgres unique indexes treat NULLs as
distinct by default, so a plain `unique (provider_ref)` would *already* permit
many unbound rows. The predicate is therefore about **index size and explicit
intent**, not about NULL correctness — most dispatch rows never bind a ref, and
the index should not carry them. Stating this because "the WHERE clause is what
allows the NULLs" is a plausible-sounding and wrong reason to include it.

### 4.1 What the migration does and does not do

| | |
|---|---|
| creates | one partial unique index |
| alters | nothing — no column, no CHECK, no trigger, no table |
| RLS | untouched; no policy added |
| rows | **rewrites none, creates none, deletes none** |
| bootstrap / calling state | untouched |
| the approved proof dispatch | untouched and **still unresolved** |

**It must fail rather than dedupe.** `create unique index` on data containing a
duplicate raises `23505` and rolls back. That is the desired behaviour: a
historical conflict is evidence of the defect and must be looked at by a human,
never silently repaired by a migration.

### 4.2 Pre-flight, run read-only on 2026-08-13

```
rows: 1
  {"dispatch_id":"20e8681f-…","provider_ref":null,"provider_status":"pending","resolved_at":null}
non-null provider_ref count: 0
duplicate non-null provider_ref values: NONE
```

Dev is clean: nothing to conflict with, so the index would build.

---

## 5. The migration alone is NOT sufficient

**This is the part that would be missed.**

`updateDialExecution` reports failures through `fail()`
(`acquisition-store.js:805`), which throws a **new** `Error` carrying only a
message — `error.code` and `error.constraint` are discarded. Compare
`appendDialExecution`, which deliberately maps `23505` to named per-constraint
errors so a replay can be told from a lost race.

So a uniqueness violation on the new index would arrive at the webhook handler
as a generic throw, and `acquisition-call-events.js:197` maps any throw to
`acquisition_event_store_unavailable` — a **transient-sounding** code for a
**permanent** conflict. An operator would be told to retry something that must
never be retried.

The Postgres message text does survive inside the wrapped message (`duplicate
key value violates unique constraint "idx_acq_dial_exec_provider_ref"`), so
detection by string matching would work — but the ledger's arbitration should
not depend on a substring surviving an error wrapper.

**Phase 2 must therefore include**, in this order:

1. the migration;
2. `updateDialExecution` surfacing a unique violation distinguishably, mirroring
   the insert path rather than inventing a second convention;
3. the webhook handler mapping it to an explicit conflict code.

---

## 6. Proposed service semantics

| case | expected | code |
|---|---|---|
| first dispatch binds R | success | `acquisition_event_call_id_bound` |
| same dispatch, same R | **idempotent**, no write | `acquisition_event_call_id_bound` (unchanged) |
| same dispatch, different R | conflict, original not overwritten | `acquisition_event_call_id_conflict` (exists) |
| **different dispatch, same R** | **conflict, refused by the database** | **`acquisition_event_call_id_taken` (NEW)** |
| different dispatch, different R | allowed | — |

The fourth case needs its **own** code. Collapsing it into the existing
`call_id_conflict` would tell an operator "this dispatch already has a different
call" when the truth is "another dispatch already owns this call" — a different
problem with a different investigation.

Neither conflict may write an outcome, and neither may resolve a dispatch. Both
leave the locks held.

---

## 7. Concurrency proof design — **and its residue problem**

The proof must be two real OS processes racing to bind one R to **two different
dispatches**, with the database picking the winner — the same shape as the
E-7B1 race that proved the prospect lock.

**That requires two dispatch rows on dev, and dev has one.** Neither way of
getting a second one is free:

| option | residue | acceptable? |
|---|---|---|
| bind R to the existing approved proof row and to a new one | **mutates the approved row** (`provider_ref` null → R) **and +1 permanent row** | needs approval on both counts |
| insert two new fictional dispatches for the race | **+2 permanent rows** (23 → 25) | needs approval |
| insert one new fictional dispatch, race it against the existing row | mutates the approved row, +1 row (23 → 24) | needs approval |
| transactional `BEGIN … ROLLBACK` probe in the SQL editor | **zero residue** | proves the index refuses, but **single-process** |
| offline proof against the in-memory store modelling the index | zero residue | proves the service mapping, not the database |

`acquisition_dial_executions` refuses DELETE, so nothing inserted can be cleaned
up — that is the property laq5 exists to have.

**Recommendation:** a **transactional rollback probe** for the database
(zero residue, and it genuinely exercises the real index), plus **offline
two-process-shaped proofs** for the service mapping. A true two-process race
against real Postgres would add **+1 permanent row and mutate the approved proof
row**, and I am not proposing that without an explicit decision.

---

## 8. Expected DEV residue

**Zero additional permanent rows**, under the recommended proof design. Dev stays
at **23**, calling stays `paused` at revision 1, `acquisition_decisions` stays 4,
`acquisition_call_queue` stays 0, and the proof dispatch stays **unresolved with
`provider_ref` NULL**.

Any option that changes those numbers is listed in §7 and needs founder approval
first.

---

# PHASE 2 — implemented locally, 2026-08-13

**Status: IMPLEMENTED LOCALLY / DEV MIGRATION PENDING. NOTHING IS APPLIED.**
E-9 is **not closed**. E-7 OPEN, DNCR-1 OPEN, A-L2 OPEN, calling PAUSED.

## 9. The founder revision, and why Phase 1 was insufficient

Phase 1 proposed the uniqueness index and stopped there. That was not enough,
and the reason is worth stating precisely because it is easy to miss:

**A unique index cannot catch the same-dispatch race.** Two workers both read
`provider_ref` as NULL; one wants R1 and the other R2. Neither value collides
with anything, so the index never fires, and whichever commits second silently
wins. The index solves cross-dispatch collisions and is blind to this one.

So the value must be **write-once**, enforced where the race actually resolves.
Two invariants, not one:

| | invariant | enforced by |
|---|---|---|
| **A** | one non-null reference belongs to at most one dispatch | `idx_acq_dial_exec_provider_ref` |
| **B** | once bound, a reference may not change or be cleared | the laq5 guard, extended |

## 10. Provider scoping — audited, and the key is `provider_ref` alone

| question | answer |
|---|---|
| is `provider_ref` namespaced by AIDA? | **No.** It is the provider's own reference, stored verbatim |
| is it the raw Retell `call_id`? | **Yes** — `acquisition-retell-provider.js:233`. The fake provider writes `fake_<sha256(executionId)>`, self-namespaced and derived from a random dispatch id |
| could a future provider collide textually? | Conceivable, implausible, and **no second provider exists** |
| can `provider` change after binding? | **Not through the application.** `updateDialExecution` maps eight columns and `provider` is not among them, in the adapter or the in-memory twin. It is written once at INSERT |
| does `provider` need stickiness? | **Only if it were part of the key.** It is not |

**`unique (provider, provider_ref)` was rejected.** It is the strictly correct
semantic, and it is only *sound* if `provider` is itself write-once — otherwise
flipping `provider` frees the reference and the index that was supposed to
arbitrate simply stops applying. That is more machinery, guarding a column
nothing can write, for a multi-provider case that does not exist.

`provider_ref` alone is **strictly stronger** and cannot be defeated by mutating
any other column. Its only cost is a hypothetical false conflict if a second
provider ever issued an identical string — and that **fails safe**: the bind is
refused, the dispatch keeps its locks and stays unresolved, a human reconciles.
It never admits a duplicate. If a second live provider is ever added, this is
revisited with evidence.

## 11. Files

| file | what it is |
|---|---|
| `supabase/sql/laq6_bind_provider_call_once.sql` | **the migration. NOT APPLIED** |
| `supabase/sql/verification/13_laq6_verify_readonly.sql` | structural verifier, **read-only**, safe to re-run anywhere |
| `supabase/sql/verification/14_laq6_mutation_probes.sql` | the six mutation probes, **`BEGIN … ROLLBACK`, zero residue** |

The migration adds one index and replaces one function body. It creates,
rewrites and deletes **no rows**, adds no policy, changes no RLS, and touches
neither the calling-state bootstrap nor the E-7B1 proof dispatch. **It fails
rather than dedupes**: `create unique index` against duplicate data raises 23505
and rolls back, because a historical duplicate is evidence that one telephone
call was attributed to two businesses and must be looked at, not deleted.

## 12. Error metadata — the change without which the migration misleads

`fail()` threw a bare `new Error(message)`, discarding `code` and `constraint`.
A unique violation and a dropped connection arrived indistinguishable, and the
caller mapped both to `store_unavailable` — a **transient-sounding** answer to a
**permanent** conflict, which invites a retry of the one thing that must never
be retried.

`fail()` now preserves `code`, `constraint`, `details`, `hint` and `cause`. The
message is byte-identical, so every existing caller behaves exactly as before.

## 13. Service mapping

| case | result | code |
|---|---|---|
| dispatch has NULL, bind R | success | `acquisition_event_call_id_bound` |
| dispatch has R, bind R | idempotent success | `acquisition_event_call_id_bound` |
| dispatch has R1, bind R2 | permanent conflict | `acquisition_event_call_id_conflict` |
| **D1 owns R, D2 binds R** | **permanent conflict, DB-refused** | **`acquisition_event_call_id_taken`** |
| D1→R1 and D2→R2 | allowed | — |
| genuine outage | still transient | `acquisition_event_store_unavailable` |

The pre-read survives as a **courtesy** — better messages, cheap idempotency —
and is explicitly not the authority. No conflict retries, resolves a dispatch,
or records an outcome.

## 14. Offline proofs — 25

Including the race a unique index cannot catch: two workers both shown a stale
NULL row, both passing the pre-read, exactly one binding surviving and the loser
mapped to a permanent conflict. The in-memory store **models** laq6 — raising
Postgres's own `23505` with the real constraint name, and the real write-once
token — so the service's classification is tested against the shapes the
database actually produces.

## 15. What was NOT proven, stated plainly

**No two-process race was run against live Postgres, and none is claimed.** The
founder decided against it, and the reasoning is recorded here rather than
glossed: `acquisition_dial_executions` refuses DELETE, so a live race needs
permanent fictional dispatch rows, and contaminating dev to demonstrate standard
unique-index arbitration is not a trade worth making. What stands in its place
is the real index and the real guard exercised against real Postgres by
`14_laq6_mutation_probes.sql`, plus offline tests for the service mapping.

**The database has not seen this migration yet.** Everything above is local.
