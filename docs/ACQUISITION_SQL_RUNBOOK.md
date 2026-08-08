# Acquisition SQL Runbook — applying LAQ1 and LAQ2 to dev

**Status:** **APPLIED TO DEV** on 2026-08-07 (M8D), against project ref
`wvwemitmmsdytyutaqbm`. **NOT applied to production.** Nothing in this
repository applies SQL, and a test asserts that — every step below is something
a human runs by hand, and every step below was run by hand.

**Owns (source of truth for):** the order LAQ1 and LAQ2 are applied in, how each
is verified, and what can and cannot be rolled back.

> **Apply to the dev Supabase project only.** Production is out of scope for
> this runbook, for M8C and for M8D.

**The verification assets referenced below are checked in**, under
`supabase/sql/verification/`. They are read-only or self-rolling-back, ASCII
only, and were run in this order against dev:

| File | What it does |
|---|---|
| `01_preflight.sql` | Confirms nothing acquisition-shaped exists yet |
| `02_laq1_verify.sql` | LAQ1 structure: tables, RLS, policies, constraints, indexes, triggers |
| `03_laq1_verify_detail.sql` | The LAQ1 checks `02` cannot make: trigger **enabled** state, row counts, CHECK bodies |
| `04_laq2_verify.sql` | LAQ2 structure, including the partial unique index and RESTRICT/CASCADE split |
| `05_behavioural_probes.sql` | 30 behavioural probes (§6) |
| `06_probe_cleanup_check.sql` | Proves §6 left nothing behind |
| `07_restart_proof_verify.sql` | Proves §7 left exactly its three intentional rows |

---

## 0. What you are about to create

| Migration | Creates | Alters |
|---|---|---|
| `laq1_create_acquisition_prospects.sql` | `acquisition_prospects`, `acquisition_prospect_phones`, `acquisition_evidence`, `acquisition_decisions` | nothing |
| `laq2_create_acquisition_queue.sql` | `acquisition_suppressions`, `acquisition_qualifications`, `acquisition_call_queue`, `acquisition_contact_outcomes` | widens the `lifecycle` CHECK on `acquisition_prospects` |

Eight tables. All RLS-enabled with **no policies**, meaning service_role only.
None has a `client_id`, and none is reachable from any client-facing route.

**Order matters.** LAQ2 reuses the trigger function LAQ1 defines and ALTERs a
constraint LAQ1 creates. It raises immediately if LAQ1 has not been applied
rather than failing part-way through, but do not rely on that — apply in order.

---

## 1. Pre-flight

Run each of these and confirm the expected answer before touching anything.

```sql
-- 1.1  You are on the DEV project, not production.
select current_database(), current_user;
```

Confirm against the dev project reference in your Supabase dashboard URL. If
this is the production project, **stop**.

```sql
-- 1.2  Nothing acquisition-shaped exists yet.
select tablename from pg_tables
 where schemaname = 'public' and tablename like 'acquisition\_%'
 order by tablename;
```
Expect **zero rows**. If rows come back, a previous attempt got part-way; read
§8 before continuing.

```sql
-- 1.3  gen_random_uuid() is available (pgcrypto or PG13+ builtin).
select gen_random_uuid();
```
Expect a UUID. If it errors: `create extension if not exists pgcrypto;`

```sql
-- 1.4  Note the current state so §8 has something to compare against.
select count(*) from pg_tables where schemaname = 'public';
```
Write the number down.

---

## 2. Apply LAQ1

Paste the **entire contents** of `supabase/sql/laq1_create_acquisition_prospects.sql`
into the Supabase SQL editor and run it once.

It is wrapped in `begin; … commit;` — it either all lands or none of it does.

Expect: `Success. No rows returned.`

---

## 3. Verify LAQ1

```sql
-- 3.1  Four tables exist and RLS is ON for every one.
select relname, relrowsecurity
  from pg_class
 where relname in ('acquisition_prospects','acquisition_prospect_phones',
                   'acquisition_evidence','acquisition_decisions')
 order by relname;
```
Expect 4 rows, `relrowsecurity = true` on all of them.

```sql
-- 3.2  No policies. Deny-by-default, service_role only.
select tablename, policyname from pg_policies
 where tablename like 'acquisition\_%';
```
Expect **zero rows**. Any row here is a client-facing read path that must not
exist — stop and investigate.

```sql
-- 3.3  Append-only is enforced by the table, not by convention.
--      Self-rolling-back: nothing survives this block.
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at)
  values ('pr_probe', 'Probe Locksmiths', 'Australia/Melbourne', 'fixture', now());

  insert into public.acquisition_evidence
    (evidence_id, sequence, prospect_id, kind, capture_mode, value,
     observed_at, recorded_at, captured_by, source_type, source_official, content_hash)
  values ('ev_probe', 1, 'pr_probe', 'business_name', 'fixture', 'Probe Locksmiths',
          now(), now(), 'runbook', 'official_website', true, 'probe');

  -- This must FAIL.
  update public.acquisition_evidence set value = 'changed' where evidence_id = 'ev_probe';
rollback;
```
Expect the UPDATE to raise
`ERROR: Table acquisition_evidence is append-only: UPDATE is not permitted.`
Then the `rollback` removes the probe rows regardless.

```sql
-- 3.4  The offline boundary reaches the database.
begin;
  insert into public.acquisition_evidence
    (evidence_id, sequence, prospect_id, kind, capture_mode, value,
     observed_at, recorded_at, captured_by, source_type, source_official, content_hash)
  values ('ev_live', 1, 'pr_probe', 'business_name', 'live_fetch', 'x',
          now(), now(), 'runbook', 'official_website', true, 'x');
rollback;
```
Expect `ERROR: … violates check constraint` on `capture_mode`. This build
cannot fetch a live page and the database refuses to store a row claiming it did.

```sql
-- 3.5  The decision log accepts a queue decision (the M8C correction).
begin;
  insert into public.acquisition_decisions
    (audit_id, sequence, entity_type, entity_id, event, decision,
     actor, actor_kind, reason, prev_hash, entry_hash, recorded_at)
  values ('ad_probe', 1, 'queue', 'pr_probe', 'selection', 'record',
          'runbook', 'system', 'probe', repeat('0',64), 'probe', now());
rollback;
```
Expect **success** (then rolled back). Before the M8C fix this raised a CHECK
violation and every queue audit row would have been rejected.

---

## 4. Apply LAQ2

Paste the entire contents of `supabase/sql/laq2_create_acquisition_queue.sql`
and run it once. Also wrapped in a single transaction.

Expect: `Success. No rows returned.`

If you see
`ERROR: laq2 requires laq1_create_acquisition_prospects.sql to have been applied first`
then §2 did not actually commit. Go back.

---

## 5. Verify LAQ2

```sql
-- 5.1  Four more tables, RLS on, still no policies anywhere.
select relname, relrowsecurity from pg_class
 where relname in ('acquisition_suppressions','acquisition_qualifications',
                   'acquisition_call_queue','acquisition_contact_outcomes')
 order by relname;

select tablename, policyname from pg_policies where tablename like 'acquisition\_%';
```
Expect 4 rows all `true`, then **zero** policies.

```sql
-- 5.2  The lifecycle CHECK now accepts the engagement states.
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at, lifecycle)
  values ('pr_probe2', 'Probe Two', 'Australia/Melbourne', 'fixture', now(), 'queued');
rollback;
```
Expect success. Then confirm nonsense is still refused:

```sql
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at, lifecycle)
  values ('pr_probe3', 'Probe Three', 'Australia/Melbourne', 'fixture', now(), 'ringing');
rollback;
```
Expect a CHECK violation.

---

## 6. Behavioural probes — the invariants that matter

**Checked in as `supabase/sql/verification/05_behavioural_probes.sql`.** Run that
file; the SQL below explains what it does and why it is shaped the way it is.

**Expected result: an ERROR whose message is a 30-line report ending
`SUMMARY: 30 of 30 passed, 0 failed.`** An error here is success — see
"the deliberate abort" below.

### 6.0 Why these are not flat `begin; … rollback;` blocks

An earlier version of this section was wrong, and the way it was wrong is worth
recording because it is an easy mistake to repeat.

It looked like this:

```sql
-- BROKEN. Do not copy this shape.
begin;
  insert into public.acquisition_suppressions (...) values (...);
  update public.acquisition_suppressions set note = 'changed' where actor = 'runbook';  -- must FAIL
  delete from public.acquisition_suppressions where actor = 'runbook';                  -- must FAIL
rollback;
```

**The second expected failure is unreachable.** In Postgres the first exception
aborts the transaction, so the `DELETE` does not raise the append-only error at
all — it returns `25P02 current transaction is aborted, commands ignored until
end of transaction block`. The block appears to pass while testing only half of
what it claims. Every `-- must FAIL` after the first one in a flat transaction
is decoration.

The fix is a nested PL/pgSQL block. Postgres wraps `BEGIN … EXCEPTION … END` in
an implicit **savepoint**, so catching the expected exception rolls back only
that probe and the surrounding transaction survives:

```sql
begin
  update public.acquisition_evidence set value = 'x' where evidence_id = 'probe';
  -- reached only if the trigger failed to fire
  v_report := v_report || E'\nP01 FAIL  no error raised';
exception when others then
  v_report := v_report || E'\nP01 ' || case when sqlstate = '23001' then 'PASS ' else 'FAIL ' end
              || ' got ' || sqlstate;
end;
```

Two further things this shape buys:

- **Verdicts assert the specific SQLSTATE, not merely "an error happened".** A
  probe that raises the *wrong* error reads FAIL. The four that matter are
  `23001` restrict_violation (the append-only trigger), `23514` check_violation,
  `23505` unique_violation, `23503` foreign_key_violation.
- **All 30 probes run in one pass**, each reporting its own result, instead of
  the run stopping at the first expected failure.

### 6.1 The deliberate abort, and why there is no `rollback;`

The probe file is **one statement — a single `DO` block** — and it ends by
raising an exception that carries the report.

That is not a workaround for the editor, it is the stronger guarantee. An
earlier harness used a temporary table to collect results and a trailing
`rollback;` to undo the fixtures. It failed with
`42P01 relation "m8d_probe_results" does not exist`: the Supabase SQL editor
does not keep a `TEMPORARY` table alive across statement boundaries, so the
table was gone by the time the `DO` block ran, and the first probe's exception
handler died trying to record its result.

The current shape depends on nothing but **Postgres statement atomicity**: a
statement that ends in an uncaught exception is rolled back completely, whatever
the client does with transactions. It cannot leave fixture data behind even if
every statement is autocommitted. There is no `COMMIT` anywhere in the file.

### 6.2 What the 30 probes cover

| Probes | Invariant |
|---|---|
| P01–P08 | Append-only: **UPDATE and DELETE both refused**, on evidence, decisions, suppressions and outcomes — all eight arms, independently |
| P09–P10 | Derived state stays **mutable**: a lease can be released, a score recomputed. Had the trigger been attached here by mistake the queue would deadlock permanently |
| P11–P18 | CHECK constraints: `live_fetch` refused; unknown lifecycle refused; `queued` accepted; `queue` entity_type accepted; suppression scope key both directions; non-normalised E.164 refused; valid E.164 accepted |
| P19–P24 | **Second live lease refused**; releasing frees the slot; duplicate `lease_token`; duplicate `request_id`; one qualification per prospect; dangling `supersedes_id` |
| P25–P27 | FK **RESTRICT**: a prospect with an outcome, evidence or phone cannot be deleted |
| P28–P29 | FK **CASCADE**: qualification and queue rows follow their prospect |
| **P30** | **A suppression survives its prospect being deleted** |

P19 and P20 are deliberately separate. P19 proves the partial unique index
refuses a second live lease; P20 proves releasing frees the slot. A plain
`UNIQUE` index would pass P19 and fail P20 — only the pair distinguishes the
constraint that is actually wanted.

A single session cannot stage a true race. P19 proves the *constraint that
decides* one, which is the part application code cannot supply.

### 6.3 Afterwards

Run `supabase/sql/verification/06_probe_cleanup_check.sql`. It is read-only and
proves from the database side that the abort left nothing behind: eight tables
empty (C1–C8), and no row bearing a probe identifier (D1–D8).

**Result on dev, 2026-08-07:** 30/30 probes passed; cleanup 16/16 with all
counts zero.

---

## 7. Prove suppression survives a restart, on the real database

This is the M8C invariant, checked against Postgres rather than a test double.
It was run on dev on 2026-08-07 and **passed 13/13**.

**Checked in as `scripts/dev/acquisition-restart-proof/`** — `common.js`,
`phase1.js`, `phase2.js`, `cleanup.js`.

### 7.1 Two processes, not a REPL

An earlier version of this section asked you to type into a Node REPL, exit it,
and type into a second one. The scripts do the same thing reproducibly:

```bash
cd <acquisition worktree>
NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/phase1.js
# phase1 exits. The heap is gone.
NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/phase2.js
NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/cleanup.js
```

Then run `supabase/sql/verification/07_restart_proof_verify.sql`.

**Nothing is handed between phase 1 and phase 2** — no state file, no export.
Phase 2 re-derives the prospect ids from the same fixtures, because the identity
fingerprint is deterministic. That is what makes it a restart proof rather than
a restatement.

**Phase 2 opens with a false-positive guard (R0):** it builds the identical
services against an *empty in-memory* store and asserts they come up empty.
Without R0, every subsequent pass could be an artefact of state that never left
memory.

### 7.2 Environment

`NODE_PATH` points at the runtime worktree's `node_modules` so
`@supabase/supabase-js` resolves. **Nothing is installed into the acquisition
worktree and `package.json` is untouched** — the dep-free test convention holds.

Credentials are read from a dev `.env` by the script itself, so the service key
never reaches a command line, a shell history, or any output. Set
`ACQUISITION_ENV_FILE` to point at your own; the default is a sibling worktree.

**`loadEnv()` throws unless `SUPABASE_URL` contains the dev project ref, before
a client is constructed.** Pointing this at production fails closed.

### 7.3 What phase 2 proves

| | Proves |
|---|---|
| R0 | Empty store ⇒ empty services (false-positive guard) |
| R1 | The opt-out survived process death |
| R2 | **The re-imported business is still suppressed** — trading name, suburb, source and number formatting all drifted, prospect identity regenerated |
| R3 | Eligibility refuses it (`suppressed_permanently`) |
| R4 | **No lease is issued** |
| R5 | The active lease survived the restart |
| R6 | The active lease **cannot be duplicated** — a second acquire returns null via the partial unique index |
| R7 | An expired lease is **not** self-releasing; it stays held until reaped |
| R8 | The reaper released **only** the expired lease; the long lease is untouched |
| R9 | **A reaped prospect is re-evaluated, not auto-queued** — its lease is free, yet selection still refuses it |
| R10 | The outcome and its `suppression_applied` flag survived |
| R11 | The read model reports suppressed, rebuilt from the hydrated index |

R8 is a real distinction rather than a sweep that catches everything: one
business holds a 5-minute lease, the other 24 hours, and the sweep runs at
+10 minutes.

### 7.4 Cleanup leaves three rows, deliberately

**Do not disable the append-only triggers to remove them.** A previous version
of this section told you to, and it was wrong to.

The restart proof cannot roll back — its whole claim is that state survives
process death. What it writes is therefore real, and three rows cannot be
removed without switching enforcement off:

| Row | Why it stays |
|---|---|
| The suppression | `acq_suppressions_no_update` refuses DELETE |
| The DO_NOT_CALL outcome | `acq_outcomes_no_update` refuses DELETE |
| The prospect both point at | FK `ON DELETE RESTRICT` |

`cleanup.js` removes everything else, then **attempts the prospect delete and
reports the RESTRICT refusal rather than skipping it** — the refusal is the
evidence.

All three describe an invented business on an invented number and can never
match anything real. Leaving them costs nothing; the invariant *"the append-only
triggers on this database have never been disabled"* is worth more than an empty
table, and `07_restart_proof_verify.sql` check **F8** asserts exactly that.

> If you ever do need to remove such a row, that is a deliberate, logged,
> one-off admin decision — not a cleanup step, and not something this runbook
> will hand you a recipe for.

---

## 8. Rollback caveats — read before you need them

**These migrations are additive, which is not the same as reversible.**

| | |
|---|---|
| **LAQ2, before any data** | Reversible: drop the four tables, then restore the LAQ1 `lifecycle` CHECK to its six original states. Any prospect already in an engagement state will block the narrowed CHECK. |
| **LAQ1, before any data** | Reversible: drop the four tables and the `acquisition_refuse_mutation()` function. Drop LAQ2's tables first — they depend on it. |
| **Either, after data** | **Not reversible in any meaningful sense.** Dropping `acquisition_suppressions` destroys the record of who asked never to be contacted. There is no backup of it inside this system. |

The rollback statements, for completeness — **destructive, dev only**:

```sql
-- LAQ2 down. Destroys suppressions. Do not run this if anybody has opted out.
begin;
  drop table if exists public.acquisition_contact_outcomes;
  drop table if exists public.acquisition_call_queue;
  drop table if exists public.acquisition_qualifications;
  drop table if exists public.acquisition_suppressions;
  alter table public.acquisition_prospects drop constraint if exists acquisition_prospects_lifecycle_check;
  alter table public.acquisition_prospects add constraint acquisition_prospects_lifecycle_check
    check (lifecycle in ('discovered','evidence_captured','review_pending',
                         'review_approved','review_rejected','suppressed'));
commit;
```

```sql
-- LAQ1 down. Run only after LAQ2 down.
begin;
  drop table if exists public.acquisition_decisions;
  drop table if exists public.acquisition_evidence;
  drop table if exists public.acquisition_prospect_phones;
  drop table if exists public.acquisition_prospects;
  drop function if exists public.acquisition_refuse_mutation();
commit;
```

**What no rollback recovers:**

- A suppression that was dropped. Nothing else in the system holds it.
- The decision log's hash chain, if rows are removed — `verifyRows()` will
  report the break, correctly, forever.

**Preferred recovery from a bad apply:** roll forward with a new additive
migration, not backward. These files are cheap to fix while unapplied and
expensive to reverse afterwards.

---

## 9. After applying

- Nothing starts calling. Both the counsel sign-off (A-L1) and the attempt
  policy (A-L6) are still unapproved, and the eligibility engine blocks every
  prospect while either is. **Applying the schema changed none of that.**
- Update the status line at the top of
  [LOCKSMITH_ACQUISITION_SPEC.md](LOCKSMITH_ACQUISITION_SPEC.md).
  *Done for dev on 2026-08-07.*
- Run the lease reaper manually once and confirm it reports zero:
  a sweep that reaps something on an empty queue means something is wrong.

### What dev holds now

Eighteen rows across four milestones. Every one describes an invented business
on an invented number; they are the only acquisition data on dev, and none is to
be removed — see §7.4.

| Table | Rows | From |
|---|---|---|
| `acquisition_suppressions` | one `opt_out`, actor `m8d-restart-probe` | M8D |
| `acquisition_contact_outcomes` | one `opt_out`, actor `m8d-restart-probe` | M8D |
| `acquisition_prospects` | `M8D Restart Probe Locksmiths` | M8D |
| `acquisition_suppressions` | one `opt_out`, actor `m8e-crossprocess-probe` | M8E |
| `acquisition_prospects` | **2** — `pr_0b9f51cfe79018067bf1`, `pr_f546eb7194421d554527` | M8G |
| `acquisition_prospect_phones` | **1** | M8G |
| `acquisition_evidence` | **9** | M8G |
| `acquisition_decisions` | **2** — one review_opened, one review_resolved for `rv_pr_m8h_review_probe_0001` | M8H |

The M8E row cost **one** row rather than three, and the reason is the property
M8E exists to defend: suppressions carry no foreign key, so proving one needs no
prospect and no outcome to hang it on.

### The M8G rows that were not planned

M8G was approved for **one** invented business. It left **two** prospect rows
and nine evidence rows, and that overrun is recorded here rather than rounded
off.

The first real run of the drifted re-import returned `review_required`, and the
pre-fix code persisted it — giving the same invented business a second prospect
row (`…Pty Ltd`) and five further evidence rows. That is precisely the duplicate
explosion M8G exists to prevent, and running the proof against real Postgres is
what found it.

**Cleanup was attempted and correctly refused:**

```
delete acquisition_evidence   → Table acquisition_evidence is append-only:
                                 DELETE is not permitted.
delete acquisition_prospects  → violates foreign key constraint
                                 "acquisition_evidence_prospect_id_fkey"
```

Two phone rows *were* removable and were removed. **No trigger was disabled and
no foreign key weakened** — the refusals above are the controls working, and
bypassing them to tidy a fictional row would cost more than the row is worth.

The fix is committed and re-verified: a drifted re-import now creates nothing
and is held for a human.

`supabase/sql/verification/07_restart_proof_verify.sql` asserts exactly this,
and asserts that all four append-only triggers are still enabled.

### Before production

Everything in this runbook applies again, in order, with one addition: dev was
empty when LAQ1 ran and production will not be. Re-read §1 and §8 with that in
mind, and do not assume a clean `01_preflight.sql` — on production the expected
answer to "does anything acquisition-shaped exist" may legitimately change over
time.
