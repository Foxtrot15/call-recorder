# E-9 — durable unique Retell call binding

**Status: DESIGN READY. SQL AWAITING FOUNDER APPROVAL. NOTHING IS APPLIED.**

**The constraint described here does not exist.** No migration file has been
written, nothing has been applied to dev or production, and no claim anywhere in
this repository says otherwise. E-7 remains OPEN, DNCR-1 remains OPEN, calling
remains PAUSED.

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

## 4. Proposed migration — LAQ6, NOT WRITTEN

```sql
-- PROPOSED. NOT APPLIED. NOT WRITTEN AS A MIGRATION FILE.
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
