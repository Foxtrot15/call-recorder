# E-7B1 — Durable dispatch authority and durable emergency stop

**Status of this document:** DESIGN READY — **SQL AWAITING FOUNDER APPROVAL.**
Written 2026-08-11, after E-7A was pushed.

**Nothing in this document has been applied.** No `.sql` file exists for it, no
migration has been run, no dev row has been written, and no live provider has
been built. E-7 remains **OPEN**.

**Owns (source of truth for):** the proposed durable schema that must exist
before any live acquisition provider can be added, and why.

> This **supersedes** the sketch in
> [ACQUISITION_SQL_RUNBOOK.md](ACQUISITION_SQL_RUNBOOK.md) §14.3. That sketch
> proposed `unique (authorisation_id)`. **That proposal is wrong on two counts**
> and is corrected here — see §3.

---

## 1. What E-7A actually guarantees, and where it stops

| guarantee | scope |
|---|---|
| forged / cloned / substituted slips refused | **absolute** — identity, not shape |
| one slip → at most one provider submission | **one process only** |
| 10 concurrent consumptions → one submission | **one process only** |
| 60-second expiry, future-dated refused | absolute |
| no automatic retry | absolute |
| no live provider, no network, no credentials | absolute |
| kill switch rechecked before dispatch | **only if a caller passes one in** |

The two words that matter are **one process**. Everything else survives E-7B1
unchanged.

---

## 2. Audit — what already exists

### 2.1 `acquisition_call_queue` (laq2, applied to dev, **0 rows**)

```
id                  uuid primary key default gen_random_uuid()
prospect_id         text not null references acquisition_prospects on delete cascade
e164                text not null check (e164 ~ '^\+61[0-9]{6,12}$')
worker_id           text not null
lease_token         text not null unique
granted_at          timestamptz not null
expires_at          timestamptz not null
released_at         timestamptz
release_reason      text
request_id          text unique
qualification_score integer
eligibility_snapshot jsonb
created_at          timestamptz not null default now()

unique index idx_acq_queue_one_live_lease on (prospect_id) where released_at is null
index idx_acq_queue_worker  on (worker_id)  where released_at is null
index idx_acq_queue_expires on (expires_at) where released_at is null
RLS enabled, no policies (service_role only)
```

**What its rows represent:** *reservations* — "this worker intends to consider
this prospect next, and nobody else should pick it up meanwhile". Its own
comment is explicit that `eligibility_snapshot` is **"NOT what authorises the
call"**.

**Why it should not hold dispatch state.** It could be bent to: `request_id`
is unique, and the partial index already enforces one live lease per prospect.
But:

1. A lease is an *intention*; a dispatch is an *irreversible act*. Collapsing
   them makes an audit unable to answer "did we actually ring them?"
2. `released_at` / `release_reason` model giving a reservation back. A dispatch
   is never given back.
3. There is no status, provider, provider-reference or error column, and adding
   them is the same migration cost as a clean table — with semantic damage.
4. `on delete cascade` on `prospect_id` is right for a reservation and **wrong**
   for a dispatch record, which must outlive the prospect row exactly as
   `acquisition_contact_outcomes` does (`on delete restrict`).

**Recommendation: do not overload it.**

### 2.2 The `AuthorisedDial` slip — every field currently available

```
kind             "authorised-dial"
authorisationId  "ad_<sha256(prospectId|e164|authorisedAt|decision)[0:20]>"
prospectId
businessName
e164             the number the gate cleared
authorisedAt     ISO instant
decision         "eligible"
note             prose
```

**Absent from the slip:** `batchKey`, campaign identity, policy version. Those
exist on the *decision* (`decision.batchKey` is populated) but are **not carried
onto the slip**, so a durable row built from the slip alone cannot bind the
approval that permitted it.

### 2.3 Kill switch — current shape and every caller

The switch is `context.campaign.killSwitchEngaged`, a **caller-supplied object**.

| supplier | what it does |
|---|---|
| `acquisition-eligibility.js` §6 | reads `campaign.killSwitchEngaged === true` |
| `acquisition-calling-policy.js:339` | same field, its own copy of the check |
| `acquisition-dial-execution.js:285` | calls an **optional** injected `killSwitch()` |
| `scripts/acquisition-batch.js:59` | `--campaign` names one; supplies no stop |

**There is no durable campaign or kill-switch store.** `acquisition-store.js`
has no method for one.

**The dangerous default, verified in code:**

```js
} else {
  add(pass("campaign", campaign ? "The campaign permits this business."
                                : "No campaign restrictions apply."));
}
```

**A missing campaign PASSES.** Absence means go. That is precisely the shape a
durable stop must not inherit.

---

## 3. The correction — why `unique (authorisation_id)` is the wrong key

Runbook §14.3 proposed a dispatch table keyed `unique (authorisation_id)`.
Two independent defects, both verified rather than reasoned about:

### 3.1 `authorisationId` is derived, and legitimately collides

```
authorisationId = sha256(prospectId | e164 | authorisedAt | decision)
```

Two **genuinely distinct** authorisations of the same prospect, on the same
number, at the same millisecond produce the **same id**. Measured:

```
authorisation A id : ad_22629b517b12cd411800
authorisation B id : ad_22629b517b12cd411800
distinct objects?  : true
COLLIDE?           : true
```

E-7A's own test suite *asserts this collision as a feature*, because it makes
proof transcripts comparable. As a correlation id that is fine. As a **primary
uniqueness key it is a defect**: the second distinct authorisation would be
refused as already-claimed, and the dispatch ledger would record two different
authorisations as one.

It is also **fully guessable** — recomputable by anyone knowing the prospect,
number and instant. It must never be treated as a secret or a bearer token.

### 3.2 It does not stop the threat that actually causes a double call

Uniqueness on an authorisation id prevents **replay of one authorisation**. It
does **not** prevent two workers each minting *their own* authorisation for the
same business:

```
worker A (t=04:00:00.000): ad_1a568dbe478e6ade3820
worker B (t=04:00:00.350): ad_ff1c32adbc2958437725
same id? false
-> BOTH claim successfully. BOTH dial the same locksmith.
```

And the attempt policy cannot catch it: `minDaysBetweenAttempts: 2` is computed
from `acquisition_contact_outcomes`, and **neither worker has recorded an
outcome yet**, so both read "never contacted" and both pass.

**So there are two distinct threats, and the design must close both:**

| | threat | closed by |
|---|---|---|
| **T1** | one authorisation dispatched twice | `primary key (dispatch_id)` |
| **T2** | two authorisations, same business, concurrently | `unique (prospect_id) where completed_at is null` |

T2 is the one that rings a phone twice. **The §14.3 sketch closed only T1.**

---

## 4. Proposed schema — `laq5`

### 4.1 Identity change required in code first

The slip must carry a **random** dispatch identity, minted at authorisation:

```js
dispatchId: randomUUID()   // node:crypto, per authorisation, never derived
```

`authorisationId` **stays exactly as it is** — derived, deterministic,
correlation-only. The two coexist and mean different things.

> **Phase-2 note:** E-7A's test *"the execution id is deterministic for one
> authorisation"* pins the derived value. It must be re-pointed at
> `authorisationId`, and a new test must assert `dispatchId` is **not**
> deterministic. That is a deliberate change to a ratchet and must be visible in
> its own commit.

### 4.2 `acquisition_dial_executions`

```sql
create table if not exists public.acquisition_dial_executions (
  -- Random, minted at authorisation. NOT derived, so two distinct
  -- authorisations can never collide. This is the T1 invariant.
  dispatch_id       uuid primary key,

  -- Derived, deliberately NOT unique: two legitimate authorisations may share
  -- it. Correlation and audit only.
  authorisation_id  text not null,

  -- RESTRICT, not CASCADE. A record that we rang a business must not become
  -- deletable by deleting the business, exactly as for contact outcomes.
  prospect_id       text not null
                      references public.acquisition_prospects (prospect_id) on delete restrict,

  destination_e164  text not null check (destination_e164 ~ '^\+61[0-9]{6,12}$'),

  -- The founder approval that permitted it. Nullable only because the slip does
  -- not carry it yet; it becomes NOT NULL once §4.1 lands.
  batch_key         text,

  authorised_at     timestamptz not null,
  claimed_at        timestamptz not null default now(),

  status            text not null default 'claimed'
                      check (status in ('claimed','submitted','refused','failed')),

  provider          text not null,
  provider_live     boolean not null,
  provider_ref      text,
  error_code        text,
  completed_at      timestamptz,

  created_at        timestamptz not null default now(),

  -- A terminal status must say when it ended; a claim must not pretend to have.
  constraint acq_dial_exec_completion
    check ((status = 'claimed' and completed_at is null)
        or (status <> 'claimed' and completed_at is not null))
);

-- T2. ONE IN-FLIGHT DISPATCH PER BUSINESS, across every process and host.
-- Same shape as the queue's one-live-lease index, and for the same reason:
-- two workers racing both read "nothing in flight" and both dial.
create unique index if not exists idx_acq_dial_exec_one_in_flight
  on public.acquisition_dial_executions (prospect_id)
  where completed_at is null;

create index if not exists idx_acq_dial_exec_prospect
  on public.acquisition_dial_executions (prospect_id, claimed_at desc);
create index if not exists idx_acq_dial_exec_authorisation
  on public.acquisition_dial_executions (authorisation_id);
```

### 4.3 `acquisition_calling_state` — the durable stop

```sql
create table if not exists public.acquisition_calling_state (
  -- Single-row enforcement: the only permitted key is true, and it is the
  -- primary key, so a second row is impossible rather than merely discouraged.
  id            boolean primary key default true check (id),

  -- 'paused' is the ONLY value this migration ever writes.
  state         text not null default 'paused'
                  check (state in ('enabled','paused')),

  changed_by    text not null,
  changed_at    timestamptz not null default now(),
  reason        text not null
);

-- The bootstrap row. Explicitly paused, explicitly attributed.
insert into public.acquisition_calling_state (id, state, changed_by, reason)
values (true, 'paused', 'laq5-migration',
        'Acquisition calling is paused on creation. Enabling it is a deliberate founder action.')
on conflict (id) do nothing;
```

**Global scope only.** A per-campaign stop is not built: there is one pilot, no
campaign table exists, and a second scope would mean a founder in an emergency
has to know which switch to hit. If campaigns arrive, the column added is
`scope`, and a global row keeps precedence.

### 4.4 Append-only vs mutable — decided separately, as they should be

| | pattern | why |
|---|---|---|
| **dial executions** | **immutable identity, mutable status** | A dispatch has a genuine in-flight period. A pure ledger would need a claim event and a completion event, and "is anything in flight for this prospect" would become a fold — which cannot be expressed as a unique index, and T2 is enforced *by* that index. So the row is claimed once and completed once. |
| **calling state** | **mutable current state + append-only history elsewhere** | The hot path (every dispatch) needs one indexed read, not a fold of an append-only chain. |

Enforced by trigger rather than convention:

```sql
create or replace function public.acquisition_dial_exec_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'acquisition_dial_executions is not deletable: it records that a business may have been rung';
  end if;
  -- Identity is immutable. Only the outcome of the attempt may be written.
  if new.dispatch_id      is distinct from old.dispatch_id
  or new.authorisation_id is distinct from old.authorisation_id
  or new.prospect_id      is distinct from old.prospect_id
  or new.destination_e164 is distinct from old.destination_e164
  or new.authorised_at    is distinct from old.authorised_at
  or new.claimed_at       is distinct from old.claimed_at then
    raise exception 'acquisition_dial_executions identity is immutable';
  end if;
  -- Forward only. A completed dispatch never returns to claimed.
  if old.status <> 'claimed' then
    raise exception 'acquisition_dial_executions row is already terminal (%)', old.status;
  end if;
  return new;
end $$;

create trigger acq_dial_exec_guard
  before update or delete on public.acquisition_dial_executions
  for each row execute function public.acquisition_dial_exec_guard();
```

**Kill-switch history needs no new table and no new SQL.**
`acquisition_decisions.entity_type` already admits `'campaign'` and `'system'`,
so every state change is recorded as an append-only, hash-chained decision row.
The state table answers "what is it now"; the decision chain answers "who
changed it, when, and why".

### 4.5 RLS

Identical to laq2 and laq4 — enabled in the same transaction as creation, **with
no policies**, which under Postgres denies every non-superuser role outright.
`service_role` bypasses RLS and is the only intended reader. No client policy,
no browser access, no anon grant.

```sql
alter table public.acquisition_dial_executions enable row level security;
alter table public.acquisition_calling_state   enable row level security;
```

---

## 5. The atomic claim

```
claimAuthorisedDial(slip) -> CLAIMED | ALREADY_CLAIMED | CONFLICT | STORE_UNAVAILABLE
```

A single `INSERT`. No SELECT-then-INSERT anywhere — the database arbitrates.

| SQLSTATE / condition | result | may dispatch? |
|---|---|---|
| insert succeeds | `CLAIMED` | **yes** |
| `23505` on `dispatch_id` (PK) | `ALREADY_CLAIMED` | no — T1 replay |
| `23505` on `idx_..._one_in_flight` | `CONFLICT` | no — T2, another worker holds this business |
| any other error, timeout, unreachable | `STORE_UNAVAILABLE` | **no** |

**No provider invocation may occur unless the claim returned `CLAIMED`.** An
unavailable store is a refusal, never a permission — the same fail-closed rule
as suppression, history, batch and duplicate reads.

Ordering inside the executor becomes:

```
identity → in-process claim → expiry → DURABLE STOP → DURABLE CLAIM → provider
```

The durable stop is read *before* the claim so that an emergency stop does not
leave a trail of claimed-but-never-dispatched rows.

---

## 6. Crash and ambiguity semantics — unchanged from E-7A

**Claim succeeds, process crashes before the provider call.**
The row stays `claimed`, `completed_at` null. The authorisation is **spent**.
The in-flight index keeps that business un-dialable until a human resolves the
row. **No automatic recovery, no sweeper that retries.** A reaper may *report*
stale claims; it must never re-dispatch one.

**Claim succeeds, provider called, response lost.**
Row moves to `failed` with `error_code`, `completed_at` set. The authorisation
is **spent** and the true outcome is **unknown**. No second submission, ever,
automatically. Re-dialling requires a fresh authorisation and a human decision.

This preserves E-7A exactly: *a refused or failed execution still consumes the
capability.* Safety over convenience, and the reason is unchanged — a retry
after an ambiguous timeout is how one authorisation becomes two calls.

---

## 7. Bootstrap — calling must be impossible after migration

| question | answer |
|---|---|
| state immediately after migration | **`paused`** — the only value the migration writes |
| does migrating enable calling? | **No.** |
| row missing? | **BLOCK.** Absence is never permission. |
| two rows? | **Impossible** — `id boolean primary key check (id)`. |
| DB unreachable? | **BLOCK.** |
| any value other than `enabled`? | **BLOCK.** Dispatch requires the explicit string. |
| founder enables | one deliberate `UPDATE ... set state='enabled'` with `changed_by` and `reason`, mirrored into `acquisition_decisions` |
| founder emergency-stops | the same `UPDATE` back to `'paused'` |

**Two independent locks remain after this migration.** Calling requires
`state='enabled'` **and** a provider with `live: true`. E-7B1 builds neither a
live provider nor an enable path, so **live acquisition calling stays impossible
by default and by construction.**

---

## 8. Could this be done with no new SQL?

Honestly assessed, because the answer is "partly".

| piece | possible without SQL? | verdict |
|---|---|---|
| kill-switch **history** | **Yes** — `entity_type` already admits `campaign`/`system` | **use it**, no SQL needed |
| kill-switch **current state** | Yes, by folding the decision chain | **rejected** — puts a fold of the most contended table (`unique (prev_hash)`, capped pages needing explicit paging) on the dispatch hot path |
| **T1** replay protection | Only via `acquisition_call_queue.request_id` | **rejected** — semantic corruption (§2.1) |
| **T2** in-flight guard | `acquisition_call_queue`'s live-lease index is the right *shape* | **rejected** — same table, same corruption; a lease is not a dispatch |

**New SQL is genuinely required**, and the minimum is two tables, one trigger,
two indexes and one bootstrap row.

---

## 9. Verification and rollback

**Verification** — a **proposed** file, to be named `12_laq5_verify.sql` under
`supabase/sql/verification/`, following the existing `11_laq4_verify.sql`. **It
does not exist yet and must not be created before the SQL is approved:**

```sql
-- 1. RLS on, no policies
select relname, relrowsecurity from pg_class
 where relname in ('acquisition_dial_executions','acquisition_calling_state');
select count(*) from pg_policies
 where tablename in ('acquisition_dial_executions','acquisition_calling_state');  -- expect 0

-- 2. Calling is paused
select state, changed_by, reason from public.acquisition_calling_state;  -- expect 'paused'

-- 3. A second state row is impossible
--    insert ... values (true, 'enabled', ...) -> expect 23505

-- 4. Two in-flight dispatches for one prospect are impossible
--    insert two rows, same prospect_id, completed_at null -> expect 23505 on the second

-- 5. Identity is immutable and rows are not deletable
--    update ... set destination_e164 = ... -> expect 'identity is immutable'
--    delete from ...                       -> expect 'not deletable'
```

**Rollback.** Both tables are new and additive; nothing existing is altered, so
rollback is `drop table` in one transaction — with the same caveat as every
other acquisition migration: **once a dispatch row exists it is evidence that a
business may have been rung, and dropping the table destroys that evidence.**
Roll back only before any real dispatch.

---

## 10. Expected dev proof residue — stated before it is created

Current dev: **21 fictional rows across nine tables**, `acquisition_decisions` = **4**.

A future E-7B1 dev proof would permanently add:

| rows | table | why permanent |
|---:|---|---|
| **+1** | `acquisition_calling_state` | the bootstrap `paused` row, written by the migration itself |
| **+1** | `acquisition_dial_executions` | one claim by process A. Process B's attempt is refused by the constraint and writes **nothing** |
| **+1** | `acquisition_decisions` | only if the proof also exercises a founder enable/pause, which it need not |

**Expected total: 21 → 23**, or 24 if a state change is exercised.
`acquisition_decisions` stays **4** unless a state change is recorded.

The cross-process refusal proof adds **no** extra rows, which is the point: the
second worker is refused *by the database*, not by application memory.

---

## 11. Status after this phase

| item | status |
|---|---|
| **E-7A** | **COMPLETE** — pushed, provider-disabled seam |
| **E-7B1** | **DESIGN READY — SQL AWAITING FOUNDER APPROVAL** |
| **E-7** | **OPEN** |
| **DNCR-1** | **OPEN** — account application submitted; activation, first real wash and attestation outstanding |
| **A-L2** | **OPEN** — authoritative holiday data |

No SQL file has been created. No migration has been applied. No dev row has been
written. No live provider exists. Nothing has been contacted.
