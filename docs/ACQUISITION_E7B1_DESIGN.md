# E-7B1 — Durable dispatch authority and durable emergency stop

**Status of this document:** **IMPLEMENTED OFFLINE — LAQ5 NOT APPLIED.**
Revision 3, 2026-08-11 (Phase 2A), after founder approval of revision 2.

**The code exists and its tests are green. The SQL exists and has been applied
nowhere.** `supabase/sql/laq5_create_dispatch_authority.sql` is written and
statically verified; it has **not** been run against dev or production. Dev
still holds **21** rows and neither laq5 table exists there. No live provider has
been built. E-7 remains **OPEN**.

| piece | state |
|---|---|
| `dispatchId` + `batchKey` on the slip | **implemented**, tested |
| `acquisition-dispatch-store.js` (atomic claim) | **implemented**, tested |
| `acquisition-calling-state.js` (durable stop) | **implemented**, tested |
| `acquisition-dispatch-resolution.js` (outcome→release) | **implemented**, tested |
| executor wiring (preflight → claim → recheck) | **implemented**, tested |
| `laq5` migration + `12_laq5_verify.sql` | **written, NOT APPLIED** |
| live provider | **absent by design** |

**Owns (source of truth for):** the proposed durable schema that must exist
before any live acquisition provider can be added, and why.

> **Supersedes** the sketch in
> [ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md) §14.3, which proposed
> `unique (authorisation_id)` — wrong on two counts, see §3.
>
> **Revision 2 supersedes revision 1 of this document**, which proposed
> `unique (prospect_id) where completed_at is null`. Founder review rejected
> `completed_at` as the predicate, and two further findings in §6 and §7 changed
> the design again — **a per-prospect lock is not sufficient on its own.**

---

## 1. What E-7A guarantees, and where it stops

| guarantee | scope |
|---|---|
| forged / cloned / substituted slips refused | **absolute** — identity, not shape |
| one slip → at most one provider submission | **one process only** |
| 60-second expiry, future-dated refused | absolute |
| no automatic retry | absolute |
| no live provider, no network, no credentials | absolute |
| kill switch rechecked before dispatch | **only if a caller passes one in** |

The two words that matter are **one process**.

---

## 2. Audit — what already exists

### 2.1 `acquisition_call_queue` (laq2, applied to dev, **0 rows**)

```
id uuid pk | prospect_id text fk->prospects ON DELETE CASCADE
e164 text check ~ '^\+61[0-9]{6,12}$' | worker_id text
lease_token text unique | granted_at | expires_at | released_at | release_reason
request_id text unique | qualification_score int | eligibility_snapshot jsonb
created_at

unique index (prospect_id) where released_at is null
RLS enabled, no policies
```

Rows represent **reservations**. Its own comment says `eligibility_snapshot` is
**"NOT what authorises the call"**.

**Rejected as the dispatch store.** A lease is an *intention*; a dispatch is an
*irreversible act*. `released_at`/`release_reason` model giving a reservation
back, which a dispatch never is. There is no status, provider or provider-ref
column. And `on delete cascade` is **wrong** for a record that a business may
have been rung — contact outcomes use `on delete restrict` for exactly this.

### 2.2 The `AuthorisedDial` slip today

```
kind, authorisationId, prospectId, businessName, e164, authorisedAt, decision, note
```

**Absent:** `batchKey`, campaign identity, policy version.

### 2.3 Kill switch — current shape and every caller

| supplier | what it does |
|---|---|
| `acquisition-eligibility.js` §6 | reads `campaign.killSwitchEngaged === true` |
| `acquisition-calling-policy.js:339` | same field, its own copy |
| `acquisition-dial-execution.js:285` | calls an **optional** injected `killSwitch()` |
| `scripts/acquisition-batch.js:59` | `--campaign` names one; supplies no stop |

No durable campaign or kill-switch store exists. And the default is dangerous:

```js
add(pass("campaign", campaign ? "The campaign permits this business."
                              : "No campaign restrictions apply."));
```

**A missing campaign PASSES.** Absence means go.

---

## 3. Why `unique (authorisation_id)` was wrong (runbook §14.3)

**3.1 It legitimately collides.** `authorisationId` is
`sha256(prospectId|e164|authorisedAt|decision)`. Measured: two distinct
authorisations at the same millisecond both produce `ad_22629b517b12cd411800`.
E-7A's own suite asserts that collision as a feature. It is also fully
**guessable**, so it is not a secret.

**3.2 It does not stop the double call.** Two workers minting their *own*
authorisations get different ids, both claim, both dial. Measured:
`ad_1a568dbe478e6ade3820` vs `ad_ff1c32adbc2958437725`. And
`minDaysBetweenAttempts: 2` cannot catch it — it reads
`acquisition_contact_outcomes`, and neither worker has recorded an outcome yet.

---

## 4. Random `dispatchId` — the durable identity

**Generation:** `crypto.randomUUID()` from `node:crypto`, called once inside
`mintAuthorisedDial`, per genuine mint.

- **Random, never derived** — no input from prospect, number, clock or decision.
- **Collision-resistant** — 122 random bits from the platform CSPRNG.
- **A native `uuid` primary key**, no encoding decisions.
- **Not a bearer credential.** Holding the string authorises nothing: execution
  still requires the object itself, which the module-private `WeakSet` gates.
  Knowing a `dispatchId` lets somebody *burn* an authorisation by pre-claiming
  it — a denial of service on one fictional call, never a way to place one.
- `authorisationId` **stays exactly as it is** — derived, deterministic,
  correlation and fingerprint only, explicitly **not** unique in the schema.

**Invariant to pin as a test:** same prospect, same number, same millisecond,
two genuine mints → **different `dispatchId`s**, and the same `authorisationId`.
Both halves matter: the first is the new guarantee, the second documents that
the old id was never capable of it.

> **Phase-2 note.** E-7A's test *"the execution id is deterministic for one
> authorisation"* must be re-pointed at `authorisationId`, with a new test
> asserting `dispatchId` is **not** deterministic. That is a deliberate ratchet
> change and belongs in its own commit.

---

## 5. `batchKey` binding — and the proof that it may be `NOT NULL`

The founder asked for proof that no legitimate dial path lacks a batchKey.
Measured, not argued:

| case | authorised | code | batchKey |
|---|---|---|---|
| durable approval written | **true** | `eligible` | `ba_12b05a86df32ab9740052811d8dc36ec` |
| no approval written | false | `founder_batch_approval_missing` | `null` |
| caller asserts `{approved:true, batchKey:'ba_forged'}` | false | `founder_batch_approval_missing` | `ba_forged` *(echoed, refused)* |

The engine's check is unconditional — `!batch || batch.approved !== true` fails —
and the M8E gate discards `context.batch` and binds the durable read itself.

**Therefore: no authorised decision exists without a durable batchKey, so
`batch_key` may be `NOT NULL`.**

One nuance worth recording: on a **refused** decision `batchKey` can be the
caller's echoed hint (row 3). It is only ever durable on an **authorised** one,
and a slip is only minted when authorised — so the slip's batchKey is always the
durable value.

**Substitution proofs required in Phase 2** (each an explicit test):
destination, prospect and batchKey all come from the frozen slip and from
nowhere else; a clone is refused by identity before any field is read; and
`batchKey` / `batch_key` join `FORBIDDEN_OPTION_KEYS` so a caller offering one
is refused rather than ignored.

---

## 6. The dispatch lifecycle, and what `resolved_at` means

Founder revision: `completed_at` is rejected. **Provider completion is not
resolution.**

### 6.1 Two orthogonal axes, not one state machine

Seven named states collapse cleanly into two independent questions:

**What did the mechanism do?** — `provider_status` ∈
`pending` · `submitted` · `refused` · `unknown`, plus `submitted_at`.

**Is the business question settled?** — `resolved_at` + `resolution`.

`resolved_at` is the **only** thing the lock reads. `provider_status` never
releases it.

| situation | provider_status | submitted_at | resolved_at |
|---|---|---|---|
| claimed, provider not yet reached | `pending` | null | **null** |
| crashed before reaching the provider | `pending` | null | **null** |
| submission in progress | `pending` | null | **null** |
| provider accepted | `submitted` | set | **null** |
| provider definitively rejected | `refused` | set | **null** |
| response lost / ambiguous / crash after send | `unknown` | null *or* set | **null** |
| durable contact outcome recorded | *(unchanged)* | *(unchanged)* | **set**, `outcome_recorded` |
| operator adjudicated an abnormal dispatch | *(unchanged)* | *(unchanged)* | **set**, `operator_closed` |

`submitted_at` earns its column by distinguishing *"crashed before we called the
provider"* from *"crashed after"* — the single most important fact for an
operator deciding whether a phone rang.

### 6.2 The exact definition

> **`resolved_at` is set only when the business-level question — *did we contact
> this business, and what happened* — has a durable answer that the normal M8J
> attempt/history policy can take over from.**

Two and only two ways to set it:

- **`outcome_recorded`** — a row exists in `acquisition_contact_outcomes` for
  this prospect. The normal policy now governs.
- **`operator_closed`** — a human adjudicated an abnormal dispatch, named
  themselves in `resolved_by`, and said why in `resolution_note`.

### 6.3 No automatic resolution. None.

The lock is **never** released because a provider request returned, a status
said completed, an exception was thrown, or a timeout elapsed.

**One carve-out was considered and is recommended for REJECTION:**
auto-resolving dispatches where `provider_live = false`, on the grounds that a
fake or disabled provider provably cannot ring a phone. It is *true today* and
would keep dev proofs from leaving permanent locks. It is rejected because it
makes "did this ring?" depend on a boolean the provider itself supplies, and the
first live adapter to mis-declare `live: false` would silently inherit
auto-resolution. **A fictional prospect left permanently locked in dev is a
feature: it is the mechanism visibly working.**

### 6.4 The safety example, pinned

```
worker A   claim prospect P                     -> row: resolved_at NULL
           provider accepts                     -> provider_status='submitted',
                                                   submitted_at set,
                                                   resolved_at STILL NULL
           (durable contact outcome NOT yet written)

worker B   re-authorises P (new dispatchId, valid slip)
           INSERT into acquisition_dial_executions
           -> 23505 on idx_acq_dial_exec_one_unresolved_prospect
           -> CONFLICT -> NO PROVIDER INVOCATION
```

Worker B is refused **by the database**, because the only field the index reads
is `resolved_at`, and nothing about the provider touched it.

---

## 7. Destination-level concurrency — a required second invariant

The founder asked three questions. All three were tested.

**7.1 Can the same E.164 exist on two prospects? — YES.**
`acquisition_prospect_phones` has `unique (prospect_id, raw)` — **scoped per
prospect**. It stores `raw` *as published*; there is **no normalised `e164`
column on it at all**. The only `e164` index in the entire acquisition schema is
on `acquisition_suppressions`. **The database has no notion that a number
belongs to one business, and cannot see the collision.**

**7.2 Can a review/merge race permit it? — It does not even need a race.**
`resolveDuplicates` only compares *the records it is handed*. Two prospects
imported in separate batches are never compared, so neither gets a review item —
and M8L clears a persisted prospect that has no review row.

**7.3 Could two prospects therefore dispatch to the same number? — YES. Measured:**

```
prospect A pr_2e2ba7f1e00018c6742c  authorised: true  -> +61355501042
prospect B pr_2204923f7831389c5f82  authorised: true  -> +61355501042
BOTH AUTHORISED TO THE SAME NUMBER? true
```

Both durable, both `duplicateSource: durable`, both eligible. Dedupe *would*
have flagged them (`same_phone_number`, moderate) **if they had ever been
compared** — they weren't.

**A per-prospect lock does not stop this. The same handset would be rung twice.**

### 7.4 Recommendation: add the destination invariant

```sql
unique index (destination_e164) where resolved_at is null
```

**Benefit.** This becomes the **only place in the whole schema where a
normalised E.164 carries a uniqueness guarantee**, and it closes the exact
failure the pipeline exists to prevent (F7 — one business dialled twice), for a
case no other layer can currently see.

**What it legitimately blocks.** Two genuinely distinct businesses sharing one
handset — a shared answering service, a serviced office, a franchise
switchboard. The second must wait until the first resolves.

**Why that is correct anyway.** The *person answering* is the same person. Two
calls to one handset about two "different businesses" is precisely the
complaint-generating behaviour, whatever the CRM thinks. And the block is
**temporary** (until resolution), never permanent.

---

## 8. Outcome → resolution: atomicity and failure model

### 8.1 There are no cross-table transactions, and the repo already says so

`acquisition-durable.js:302`:

> *"There is no cross-table transaction available here. Supabase's PostgREST
> client issues one statement per call, so 'suppress and record the outcome'
> cannot be made atomic from this side. That leaves a choice about which half
> may survive alone, and the two are not equally bad."*

The existing answer was **suppression first, outcome second**, because the
survivable half must be the safe one. E-7B1 follows the same reasoning, and the
same precedent, in the same direction.

### 8.2 The ordering

```
1. write acquisition_contact_outcomes   (the business fact)
2. THEN set resolved_at / resolution    (release the lock)
```

| failure | result | verdict |
|---|---|---|
| step 1 fails | no outcome, **lock held** | safe — manual work, no second call |
| step 1 succeeds, step 2 fails | outcome recorded, **lock still held** | safe — manual work, no second call |
| both succeed | outcome recorded, lock released, M8J takes over | normal |

**The forbidden state — lock released, outcome missing — is unreachable**,
because releasing the lock is strictly the second write.

### 8.3 Is an RPC or database function necessary? — No.

An RPC would buy true atomicity and eliminate the manual-work case. It is **not
required**, because ordering already guarantees the only property that matters:
*a crash may create manual work; it must never create a second call.* Adding a
stored procedure would introduce a second place where dispatch semantics live,
in a language the rest of the acquisition domain does not use, to optimise the
case the founder explicitly deprioritised. **Recommend: no RPC.**

---

## 9. Crash and ambiguous-provider behaviour

| event | row | lock | automatic action |
|---|---|---|---|
| claim, then crash before provider | `pending`, `submitted_at` null | **held** | **none** |
| crash mid-submission | `pending` or `unknown` | **held** | **none** |
| provider accepted, then crash | `submitted`, `submitted_at` set | **held** | **none** |
| provider response lost | `unknown` | **held** | **none** |
| provider definitively refused | `refused` | **held** | **none** |

The authorisation is **spent** in every row of that table. A reaper may
**report** long-unresolved dispatches; it must never re-dispatch or resolve one.
This preserves E-7A exactly: *a refused or failed execution still consumes the
capability.*

---

## 10. The atomic claim

```
claimAuthorisedDial(slip) -> CLAIMED | ALREADY_CLAIMED | CONFLICT | STORE_UNAVAILABLE
```

A single `INSERT`. No SELECT-then-INSERT anywhere — the database arbitrates.

| condition | result | may dispatch? |
|---|---|---|
| insert succeeds | `CLAIMED` | **yes** |
| `23505` on `dispatch_id` (PK) | `ALREADY_CLAIMED` | no — replay |
| `23505` on the unresolved-**prospect** index | `CONFLICT` | no — §6.4 |
| `23505` on the unresolved-**destination** index | `CONFLICT` | no — §7 |
| any other error, timeout, unreachable | `STORE_UNAVAILABLE` | **no** |

Executor ordering becomes:

```
identity -> in-process claim -> expiry -> DURABLE STOP -> DURABLE CLAIM -> provider
```

The durable stop is read **before** the claim, so an emergency stop does not
leave a trail of claimed-but-never-dispatched rows holding locks.

---

## 11. The durable emergency stop

### 11.1 Singleton key

`scope text primary key check (scope = 'global')` — explicit, self-documenting,
and consistent with a schema that already uses text keys with CHECK constraints
throughout (`entity_type`, `lifecycle`, `outcome`). If per-campaign stops are
ever wanted, the CHECK widens and the primary key already accommodates it, with
`'global'` keeping precedence. **First version is global only.**

### 11.2 The current-state row is self-sufficient

The safety decision reads **one row** and depends on **no other write**:

```
scope | state | revision | changed_by | changed_at | reason
```

`revision` increments by exactly one per change, so a missing history entry is
*detectable* without the safety decision ever depending on history existing.

### 11.3 Audit ordering — a failure can never enable calling

History goes to `acquisition_decisions` (`entity_type` already admits
`'campaign'` and `'system'` — **no SQL needed for the audit trail**).

**The order depends on the direction of the change, and both orders fail safe:**

| change | order | if the second write fails |
|---|---|---|
| **enabling** (`paused` → `enabled`) | **audit first**, then state | state stays `paused` — **calling stays off** |
| **pausing** (`enabled` → `paused`) | **state first**, then audit | calling is **already stopped** |

So an audit failure can only ever leave calling *off*, never on. And because the
state row carries its own `changed_by` / `changed_at` / `reason` / `revision`,
an orphaned or missing decision row costs history, never safety.

### 11.4 Bootstrap and failure modes

| question | answer |
|---|---|
| state after migration | **`paused`** — the only value the migration writes |
| does migrating enable calling? | **No.** |
| row missing? | **BLOCK** — absence is never permission |
| two rows? | **Impossible** — `scope` is the PK and the CHECK admits one value |
| DB unreachable? | **BLOCK** |
| any value other than `enabled`? | **BLOCK** |
| caller override? | **Impossible** — the executor reads the store itself; there is no parameter |
| founder enables | one attributed `UPDATE`, `revision + 1`, audited first |
| founder emergency-stops | the same `UPDATE` back to `'paused'`, state first |

**Two independent locks remain after this migration:** calling needs
`state='enabled'` **and** a provider with `live: true`. E-7B1 builds neither.

---

## 12. Append-only vs mutable

| | pattern | why |
|---|---|---|
| **dial executions** | immutable identity, mutable status/resolution | The lock is a *partial unique index on unresolved rows*. A pure event ledger would make "is anything unresolved" a fold, and **a fold cannot be a unique index** — the invariant would go back to application memory, which is the thing E-7B1 exists to remove. |
| **calling state** | mutable current row + append-only history elsewhere | The hot path (every dispatch) needs one indexed read, not a fold of the most contended table in the schema. |

Deliberately **not** forced into one pattern, and enforced by trigger rather
than convention (§13).

---

## 13. Exact proposed DDL — `laq5`

**Not written. Not applied. Awaiting approval.**

```sql
begin;

-- ===================================================================
-- DIAL EXECUTIONS -- the durable dispatch claim
-- ===================================================================
create table if not exists public.acquisition_dial_executions (
  -- Random per genuine M8E mint (crypto.randomUUID). NOT derived, so two
  -- distinct authorisations can never collide. Replay protection.
  dispatch_id       uuid        primary key,

  -- Derived fingerprint, deliberately NOT unique: two legitimate
  -- authorisations may share it. Correlation and audit only.
  authorisation_id  text        not null,

  -- RESTRICT, never CASCADE. A record that we may have rung a business must
  -- not become deletable by deleting the business.
  prospect_id       text        not null
                      references public.acquisition_prospects (prospect_id)
                      on delete restrict,

  -- The number the M8E gate cleared, normalised. This is the first and only
  -- place in the schema where a normalised E.164 carries a uniqueness rule.
  destination_e164  text        not null
                      check (destination_e164 ~ '^\+61[0-9]{6,12}$'),

  -- NOT NULL is proven, not assumed: no authorised decision exists without a
  -- durable founder batch approval. See design doc section 5.
  batch_key         text        not null,

  authorised_at     timestamptz not null,
  claimed_at        timestamptz not null default now(),
  claimed_by        text        not null,

  -- ---- What the MECHANISM did. Never releases the lock. ----
  provider          text        not null,
  provider_live     boolean     not null,
  provider_status   text        not null default 'pending'
                      check (provider_status in ('pending','submitted','refused','unknown')),
  submitted_at      timestamptz,
  provider_ref      text,
  error_code        text,

  -- ---- Whether the BUSINESS question is settled. The lock reads this. ----
  resolved_at       timestamptz,
  resolution        text
                      check (resolution in ('outcome_recorded','operator_closed')),
  resolved_by       text,
  resolution_note   text,

  created_at        timestamptz not null default now(),

  -- A resolution is all four fields or none of them.
  constraint acq_dial_exec_resolution_complete
    check ((resolved_at is null     and resolution is null     and resolved_by is null)
        or (resolved_at is not null and resolution is not null and resolved_by is not null)),

  -- 'submitted'/'refused' mean we definitely reached the provider.
  -- 'unknown' is allowed either way, because not knowing is the point of it.
  constraint acq_dial_exec_submission_consistent
    check ((provider_status = 'pending' and submitted_at is null)
        or (provider_status in ('submitted','refused') and submitted_at is not null)
        or (provider_status = 'unknown'))
);

-- ONE PROSPECT -> AT MOST ONE UNRESOLVED DISPATCH, across every process/host.
create unique index if not exists idx_acq_dial_exec_unresolved_prospect
  on public.acquisition_dial_executions (prospect_id)
  where resolved_at is null;

-- ONE DESTINATION -> AT MOST ONE UNRESOLVED DISPATCH. Two prospects can hold
-- the same number and neither the phones table nor dedupe will necessarily
-- notice; this is the only constraint that can see it.
create unique index if not exists idx_acq_dial_exec_unresolved_destination
  on public.acquisition_dial_executions (destination_e164)
  where resolved_at is null;

create index if not exists idx_acq_dial_exec_prospect
  on public.acquisition_dial_executions (prospect_id, claimed_at desc);
create index if not exists idx_acq_dial_exec_authorisation
  on public.acquisition_dial_executions (authorisation_id);
create index if not exists idx_acq_dial_exec_open
  on public.acquisition_dial_executions (claimed_at) where resolved_at is null;

-- ---- Guard: identity immutable, resolution terminal, never deletable ----
create or replace function public.acquisition_dial_exec_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'acquisition_dial_executions is not deletable: it records that a business may have been rung';
  end if;

  if new.dispatch_id      is distinct from old.dispatch_id
  or new.authorisation_id is distinct from old.authorisation_id
  or new.prospect_id      is distinct from old.prospect_id
  or new.destination_e164 is distinct from old.destination_e164
  or new.batch_key        is distinct from old.batch_key
  or new.authorised_at    is distinct from old.authorised_at
  or new.claimed_at       is distinct from old.claimed_at
  or new.claimed_by       is distinct from old.claimed_by then
    raise exception 'acquisition_dial_executions identity is immutable';
  end if;

  if old.resolved_at is not null then
    raise exception 'this dispatch was resolved at % and cannot be reopened', old.resolved_at;
  end if;

  if old.provider_status <> 'pending'
     and new.provider_status is distinct from old.provider_status then
    raise exception 'provider status is already terminal (%)', old.provider_status;
  end if;

  return new;
end $$;

drop trigger if exists acq_dial_exec_guard on public.acquisition_dial_executions;
create trigger acq_dial_exec_guard
  before update or delete on public.acquisition_dial_executions
  for each row execute function public.acquisition_dial_exec_guard();

-- ===================================================================
-- CALLING STATE -- the durable emergency stop. GLOBAL ONLY.
-- ===================================================================
create table if not exists public.acquisition_calling_state (
  scope       text        primary key check (scope = 'global'),

  -- No default. A row must SAY what it means.
  state       text        not null check (state in ('enabled','paused')),

  revision    integer     not null default 1 check (revision > 0),
  changed_by  text        not null,
  changed_at  timestamptz not null default now(),
  reason      text        not null
);

create or replace function public.acquisition_calling_state_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the acquisition calling state row may not be deleted';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'calling state revision must increment by exactly one (was %, got %)',
      old.revision, new.revision;
  end if;
  if coalesce(btrim(new.changed_by), '') = ''
  or coalesce(btrim(new.reason), '')     = '' then
    raise exception 'a calling state change must name who made it and why';
  end if;
  new.changed_at := now();
  return new;
end $$;

drop trigger if exists acq_calling_state_guard on public.acquisition_calling_state;
create trigger acq_calling_state_guard
  before update or delete on public.acquisition_calling_state
  for each row execute function public.acquisition_calling_state_guard();

-- ---- Bootstrap. PAUSED is the only value this migration ever writes. ----
insert into public.acquisition_calling_state (scope, state, revision, changed_by, reason)
values ('global', 'paused', 1, 'laq5-migration',
        'Acquisition calling is paused on creation. Enabling it is a deliberate, attributed founder action.')
on conflict (scope) do nothing;

-- ===================================================================
-- RLS, in the same transaction as creation (D8)
-- Enabled with NO policies: Postgres then denies every non-superuser role
-- outright. service_role bypasses RLS and is the only intended reader.
-- ===================================================================
alter table public.acquisition_dial_executions enable row level security;
alter table public.acquisition_calling_state   enable row level security;

commit;
```

---

## 14. Verification

A **proposed** file, to be named `12_laq5_verify.sql` under
`supabase/sql/verification/`, following the existing `11_laq4_verify.sql`.
**It does not exist and must not be created before the SQL is approved.**

```sql
-- 1. RLS on, zero policies
select relname, relrowsecurity from pg_class
 where relname in ('acquisition_dial_executions','acquisition_calling_state');
select count(*) from pg_policies
 where tablename in ('acquisition_dial_executions','acquisition_calling_state');  -- expect 0

-- 2. Calling is PAUSED, attributed, revision 1
select scope, state, revision, changed_by, reason from public.acquisition_calling_state;

-- 3. A second state row is impossible
--    insert ... values ('global',...)   -> expect 23505
--    insert ... values ('campaign-x',...) -> expect 23514 (check violation)

-- 4. The state row cannot be deleted, and revision cannot skip
--    delete from acquisition_calling_state          -> expect 'may not be deleted'
--    update ... set revision = revision + 2         -> expect 'increment by exactly one'
--    update ... set changed_by = ''                 -> expect 'must name who made it and why'

-- 5. ONE PROSPECT -> ONE UNRESOLVED DISPATCH
--    two rows, same prospect_id, resolved_at null   -> expect 23505

-- 6. ONE DESTINATION -> ONE UNRESOLVED DISPATCH
--    two rows, different prospect_id, same destination_e164, resolved_at null
--                                                   -> expect 23505

-- 7. Provider completion does NOT release the lock
--    update row1 set provider_status='submitted', submitted_at=now();
--    insert row2 for the same prospect              -> expect 23505  <-- THE POINT
--    update row1 set resolved_at=now(), resolution='outcome_recorded', resolved_by='op';
--    insert row2 again                              -> expect SUCCESS

-- 8. Identity immutable, resolution terminal, not deletable
--    update ... set destination_e164 = '+61355509999' -> expect 'identity is immutable'
--    update a resolved row                            -> expect 'cannot be reopened'
--    delete from acquisition_dial_executions          -> expect 'not deletable'

-- 9. Constraint pairs
--    resolved_at set with resolution null             -> expect 23514
--    provider_status='submitted' with submitted_at null -> expect 23514
```

---

## 15. Rollback

Both tables are new and additive; nothing existing is altered, so rollback is
`drop table ... cascade` (to remove the triggers) plus
`drop function public.acquisition_dial_exec_guard()` and
`public.acquisition_calling_state_guard()`, in one transaction.

**With the same caveat as every other acquisition migration: once a dispatch row
exists it is evidence that a business may have been rung, and dropping the table
destroys that evidence.** Roll back only before any real dispatch.

---

## 16. Expected dev proof residue — stated before it is created

Current dev: **21 fictional rows across nine tables**, `acquisition_decisions` = **4**.

| rows | table | permanence |
|---:|---|---|
| **+1** | `acquisition_calling_state` | the bootstrap `paused` row, written by the migration itself. Updated in place thereafter — **never grows** |
| **+1** | `acquisition_dial_executions` | one claim by worker A. Worker B's attempt is refused by the constraint and writes **nothing** |
| **+0** | — | the prospect-lock and destination-lock refusal proofs add no rows |
| **+1** | `acquisition_decisions` | **only if** the proof also exercises a founder enable/pause, which it need not |

**Expected total: 21 → 23**, or 24 if a state change is exercised.
`acquisition_decisions` stays **4** otherwise.

The one dispatch row will most likely remain **unresolved for ever**, holding a
permanent lock on one fictional prospect and one fictional number. That is
**correct and intended** — it is the mechanism visibly working, and resolving it
would require either a fabricated contact outcome (never) or an operator
resolution the proof does not need to perform.

---

## 17. Could any of this avoid new SQL?

| piece | without SQL? | verdict |
|---|---|---|
| kill-switch **history** | **Yes** — `entity_type` already admits `campaign`/`system` | **use it** |
| kill-switch **current state** | Yes, by folding the decision chain | **rejected** — a fold of the most contended table (`unique (prev_hash)`, capped pages) on the dispatch hot path |
| replay protection | only via `acquisition_call_queue.request_id` | **rejected** — §2.1 |
| unresolved-prospect lock | the queue's live-lease index is the right *shape* | **rejected** — a lease is not a dispatch, and its FK cascades |
| unresolved-destination lock | **nothing existing can express it** | **new SQL required** |

**New SQL is genuinely required:** two tables, two guard functions, two triggers,
five indexes, one bootstrap row.

---

## 18. Status after Phase 2B

| item | status |
|---|---|
| **E-7A** | **COMPLETE** — pushed |
| **E-7B1** | **CLOSED as engineering on dev** — LAQ5 applied by hand 2026-08-12, proven against real Postgres, live schema structurally verified **14/14 PASS** 2026-08-13. **Production: not applied** |
| **E-7** | **OPEN** |
| **DNCR-1** | **OPEN** — application submitted; activation, first real wash and attestation outstanding |
| **A-L2** | **OPEN** — authoritative holiday data |

### 18.1 What is true right now

- `dispatchId` (random UUID) and `batchKey` are on every genuine slip.
- The executor reads the durable stop **twice** — once before spending anything,
  once immediately before the provider — and `killSwitch` is a **forbidden**
  caller option, so code still passing one is refused rather than ignored.
- The claim is one INSERT the database arbitrates. Two workers with their own
  authorisations for one business: one claims, one conflicts. Two prospects on
  one handset: same.
- **No provider result can set `resolved_at`.** `recordProviderResult` has no
  such parameter, and a ratchet asserts it never gains one.
- Outcome first, lock second. **Lock released with outcome missing is
  unreachable.** No RPC was added.
- **1463 acquisition tests green**, including 45 E-7B1 proofs and 37 static
  proofs about the migration text.

### 18.1b What Phase 2B added, against real dev Postgres

- **LAQ5 is applied to dev** (2026-08-12, by hand — nothing here applies SQL).
  The bootstrap row reads `global` / `paused` / revision 1 / `laq5-migration`.
- **The race is no longer a claim about Node.** Two OS processes, pids 16700 and
  2092, two connections, no shared memory, both busy-waiting to one wall-clock
  instant against the same business on the same handset: **one CLAIMED, one
  CONFLICT (prospect)**, one row. Postgres arbitrated.
- **T1/T2/T3 refused as designed** — replay, the prospect lock and the
  destination lock — through the real dispatch-store code, `23 passed, 0 failed`.
- **The proof row is permanently unresolved**, holding both locks. No provider
  result touched it, because none can.
- **Dev residue 21 → 23.** Decisions still 4, queue still 0, calling still paused.
- **One defect was found and fixed, in the PROOF, not the code under proof.**
  The harness's store shim carried a hand-transcribed copy of the store contract
  that had drifted — it named `getProspect`/`listProspects`, which the contract
  does not have, and omitted `findRequest`, `loadProspect` and `findProspects`,
  which it does. `assertStoreContract` threw, and every calling-state read came
  back `acquisition_calling_state_unavailable`. **The system was behaving
  correctly** — an unusable store must block — but a proof that fails for its
  own reasons proves nothing, so the shim now derives the list from
  `STORE_METHODS` and cannot drift again.

### 18.2 What is NOT true yet

- **Production has no laq5, and no acquisition schema at all.** Against
  production the durable claim throws and `dispatch_store_unavailable` blocks —
  the correct direction to fail.
- **No live provider exists.** The durable state is one of two locks; the second
  stays shut because every constructible provider reports `live: false`.
  **Calling was never enabled** — the state row has been `paused` since creation
  and its revision is still 1.
- **The guard triggers are not exercised against dev.** They are confirmed
  present, BEFORE, ROW-level, covering UPDATE and DELETE, running their own
  function and **enabled** (14/14 structural verification, 2026-08-13) — but
  present is not the same as refuses. Immutability, no-DELETE, no-reopen and the
  calling-state tamper rules are proven against the migration text
  (`test/acquisition-laq5-migration.test.js`) and offline. Sections 6 and 7 of
  the verification script, which would exercise them live, were **not run**:
  section 6 commits a second permanent row, and section 7 would mutate the
  approved residue if any probe unexpectedly succeeded.
- **DNCR-1 is unchanged.** No real wash, no attestation.

### 18.3 The two locks, stated plainly

A call needs **`state = enabled`** *and* **a provider with `live: true`**.
Phase 2A built neither an enable path into production nor a live adapter, and
**Phase 2B built neither either** — it applied the schema and left the state
`paused`. **Live acquisition calling remains impossible by construction**,
exactly as it was before this milestone. Applying laq5 made the first lock
*real* rather than absent; it did not open it.
