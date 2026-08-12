# Acquisition SQL Runbook — applying LAQ1, LAQ2, LAQ3, LAQ4 and LAQ5 to dev

**Status:** **APPLIED TO DEV** — LAQ1 + LAQ2 on 2026-08-07 (M8D), LAQ3 on
2026-08-08 (M8I), **LAQ4 on 2026-08-10 (M8K)** and **LAQ5 on 2026-08-12
(E-7B1)**, against project ref `wvwemitmmsdytyutaqbm`. **NOT applied to
production.** Nothing in this repository applies SQL, and a test asserts that —
every step below is something a human runs by hand, and every step below was run
by hand.

**Owns (source of truth for):** the order LAQ1, LAQ2, LAQ3, LAQ4 and LAQ5 are
applied in, how each is verified, and what can and cannot be rolled back.
**LAQ5 is applied to dev and not to production** — see §15.

> **The §12 and §13 heading below still reads "there is no LAQ5" in its own
> section text. That was true of E-5 and M8L and is left standing as the
> milestone snapshot it is.** LAQ5 exists because **E-7B1** needed it, not
> because either of those did: neither E-5 (durable founder batch approval) nor
> M8L (durable duplicate resolution) required **any SQL**, and neither wrote
> **any row to dev**. See **§12**, **§13** and **§15**.

> **LAQ4 is APPLIED TO DEV** (2026-08-10, by hand) **and NOT applied to
> production.** Dev holds exactly one permanent fictional wash row from the
> behavioural probe, and the durable path has been proven restart-safe against
> real Postgres across two separate OS processes. See **§11**.

> **Apply to the dev Supabase project only.** Production is out of scope for
> this runbook, for M8C, for M8D and for M8I.

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
| `08_laq3_preflight.sql` | LAQ3 pre-flight: no duplicate `prev_hash`, the index name is free, the chain state recorded (§10) |
| `09_laq3_verify.sql` | LAQ3 structure: the index exists, is UNIQUE, covers exactly `(prev_hash)`, and nothing else moved |
| `10_laq4_preflight.sql` | LAQ4 pre-flight: laq2's refusal function exists, the wash table and its index names are free, the RLS posture is intact, row counts recorded (§11) |
| `11_laq4_verify.sql` | LAQ4 structure: table, constraints, indexes, both triggers — plus §5, a behavioural probe that **writes one permanent fictional row**. §5 has been run once against dev and **must not be run there again** |

---

## 0. What you are about to create

| Migration | Creates | Alters |
|---|---|---|
| `laq1_create_acquisition_prospects.sql` | `acquisition_prospects`, `acquisition_prospect_phones`, `acquisition_evidence`, `acquisition_decisions` | nothing |
| `laq2_create_acquisition_queue.sql` | `acquisition_suppressions`, `acquisition_qualifications`, `acquisition_call_queue`, `acquisition_contact_outcomes` | widens the `lifecycle` CHECK on `acquisition_prospects` |
| `laq4_create_dncr_washes.sql` (§11) | `acquisition_dncr_washes` | nothing |

Nine tables. All RLS-enabled with **no policies**, meaning service_role only.
None has a `client_id`, and none is reachable from any client-facing route.

(LAQ3 creates no table — it adds one unique index. See §10.)

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

- Nothing starts calling. **Applying the schema changed none of that**, and it
  still does not: the calling policy (A-L1) and the attempt policy (A-L6) have
  since been adopted by the founder — **neither is legal advice** — but
  **DNCR-1** is still open, so no wash exists and `dncr_not_checked` blocks every
  prospect regardless. The full current list is
  [ACQUISITION_BLOCKER_REGISTER.md](ACQUISITION_BLOCKER_REGISTER.md).
- Update the status line at the top of
  [LOCKSMITH_ACQUISITION_SPEC.md](LOCKSMITH_ACQUISITION_SPEC.md).
  *Done for dev on 2026-08-07.*
- Run the lease reaper manually once and confirm it reports zero:
  a sweep that reaps something on an empty queue means something is wrong.

### What dev holds now

Twenty rows across five milestones. Every one describes an invented business on
an invented number; they are the only acquisition data on dev, and none is to be
removed — see §7.4.

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
| `acquisition_decisions` | **2** — `m8i_concurrency_probe_a` (seq 3) and `_b` (seq 4) for `pr_m8i_race_probe_0001` | M8I |

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

---

## 10. LAQ3 — one successor per chain head (M8I)

**Applied to dev 2026-08-08. Not applied to production.**

`supabase/sql/laq3_serialise_decision_chain.sql`. One additive unique index:

```sql
create unique index uq_acq_decisions_prev_hash
  on public.acquisition_decisions (prev_hash);
```

No table altered, no column added, no data rewritten, no trigger touched, no
foreign key changed, no policy created. A fork in the hash chain *is* two rows
sharing a predecessor, so uniqueness on `prev_hash` makes that state
structurally impossible — including for a future caller who bypasses the Node
helper entirely, which is the property a lock or an RPC cannot offer. See §40
of [LOCKSMITH_ACQUISITION_SPEC.md](LOCKSMITH_ACQUISITION_SPEC.md).

### 10.1 Order

1. **Pre-flight** — `supabase/sql/verification/08_laq3_preflight.sql`. Read-only,
   one statement, every arm a bare `SELECT`. Confirms no duplicate `prev_hash`
   exists (the index cannot build over a chain that has already forked), the
   index name is free, no *other* index already covers exactly `(prev_hash)`,
   and records the row count and head for comparison afterwards.
   **Any `STOP` means do not apply.** A duplicate `prev_hash` is a data question
   to answer before it becomes a schema question.
2. **Chain verifier** — `NODE_PATH=../call-recorder/node_modules node
   scripts/dev/acquisition-chain-verify.js`. Read-only; re-hashes every row.
   Run it *before* the schema changes so a later failure cannot be blamed on the
   migration. This is the one check the pre-flight SQL cannot do: verifying a
   hash chain means recomputing sha256 over each row's body with the writer's
   own `stableStringify`.
3. **Apply** the migration. Expect
   `NOTICE: laq3: created uq_acq_decisions_prev_hash.`
4. **Verify** — `supabase/sql/verification/09_laq3_verify.sql`. V5 and V6 must
   **match** the pre-flight values: an additive index changes no data, and if the
   head moved between the two runs something else wrote to the log.
5. **Re-run the chain verifier.**

### 10.2 Why the guard is not `create unique index if not exists`

`IF NOT EXISTS` is idempotent in the shallowest sense: it succeeds whenever an
index of that **name** exists, no matter what that index actually does. An
earlier hand-made `uq_acq_decisions_prev_hash` over the wrong column, or a
non-unique one, would be silently accepted and the invariant would not exist
while every report said it did.

The migration instead reads `pg_get_indexdef` and refuses loudly if what it
finds is not a unique btree on exactly `(prev_hash)`. Re-running is safe because
the guard checks the **definition**, not the name.

### 10.3 Rollback

```sql
drop index if exists public.uq_acq_decisions_prev_hash;
```

Destroys no data. It also removes the guarantee and returns the table to the M8H
single-writer limitation, so it is a decision, not a tidy-up.

### 10.4 The concurrency proof, and its one honest gap

`scripts/dev/acquisition-concurrency-proof/run.js` starts two separate OS
processes released by a shared wall-clock barrier and checks what the database
did to them. It is gated on an **attestation, not a check**:

```
NODE_PATH=../call-recorder/node_modules \
M8I_LAQ3_INDEXDEF="CREATE UNIQUE INDEX uq_acq_decisions_prev_hash ON public.acquisition_decisions USING btree (prev_hash)" \
node scripts/dev/acquisition-concurrency-proof/run.js
```

PostgREST exposes `public`, not the catalog, so the script cannot confirm the
index for itself — and every behavioural probe for "is uniqueness enforced"
requires attempting the very insert that would cause the damage if it is not.
Running it before laq3 would not race: both processes would succeed and fork the
dev chain permanently. So the operator pastes the **definition** printed by V3
rather than ticking a box, because a checkbox can be ticked without looking.

Result, 2026-08-08: both processes read head `seq 2 c27ba5a6…`, both minted a
successor to it, both INSERTs fired in the same millisecond, A won, B was refused
`head_taken`, re-read, re-minted and appended `seq 4` on its first retry. 15/15.

### 10.5 A verifier defect worth remembering

V12 first shipped asserting "16 columns" on `acquisition_decisions`. The table
has **17**, and has had 17 in every commit since the one that created it. The
schema was never wrong; the count was.

A verifier that cries wolf is worse than no verifier, because the next false
alarm gets waved through. V12 now compares the column **set** against laq1's,
and `test/acquisition-decision-log.test.js` parses that list out of the migration
and fails if the verifier disagrees with it. A number in a SQL file cannot be
kept honest by review.

---

## 11. LAQ4 — durable DNCR wash storage (M8K)

`supabase/sql/laq4_create_dncr_washes.sql`. **APPLIED TO DEV on 2026-08-10, by
hand. NOT applied to production.** Sections 11.1–11.6 record what was done and
how to do it again on a fresh database; **§11.7 records the live dev state and
the durability proof**.

One new table, `public.acquisition_dncr_washes`, plus one trigger function, two
triggers, three indexes and RLS. **No existing table is altered**, no column is
added to one, no data is rewritten and no existing trigger is touched.

### 11.1 What it stores, and what it deliberately does not

It stores WASH EVENTS: `e164`, `result` (`listed` / `not_listed`), `washed_at`,
`attested_by`, `mode`, `authoritative`, `batch_ref`, `source`, `recorded_at`.

**Nothing stores a boolean "washed".** Freshness is recomputed at read time from
`washed_at` by `acquisition-dncr.js`, so a wash that crosses the statutory
30-day window becomes unusable without any row changing and without anything
having had to notice. A stale wash decays to **unknown**, which vetoes — never
to its last answer, which would authorise calls on expired evidence.

There is no `unknown` value in the `result` CHECK, on purpose. Unknown is the
ABSENCE of a usable row, not a row; storing it would invite a reader to treat
"we recorded that we do not know" as a check having been performed.

### 11.2 Prerequisites

**LAQ2 is a hard prerequisite.** LAQ4 attaches laq2's
`public.acquisition_refuse_mutation()` to its new table instead of defining a
second refusal function. The pre-flight checks that function exists; if it
returns zero rows, **do not run laq4**.

### 11.3 Order

1. **Pre-flight** — `supabase/sql/verification/10_laq4_preflight.sql`.
   Read-only. Confirms laq2's function exists, the table and index names are
   free, RLS is on with no policies across all eight existing tables, and
   records the row counts. **Record section 8's output**; §11.4 compares
   against it.
2. **Apply** — `supabase/sql/laq4_create_dncr_washes.sql`, in the Supabase SQL
   editor, against dev, in one transaction.
3. **Verify** — `supabase/sql/verification/11_laq4_verify.sql`, sections 1–4.
   Read-only. Every count outside the new table must equal the pre-flight's,
   and `acquisition_dncr_washes` must hold **zero rows**.
4. **Optionally probe** — section 5 of the same file. **It writes.** See §11.5.

### 11.4 What "applied cleanly" looks like

- `acquisition_dncr_washes` exists with RLS **on** and **zero** policies.
- Two triggers: `acq_dncr_no_future_wash` (insert) and
  `acq_dncr_washes_no_update` (update or delete).
- Three indexes: `_idem` (unique), `_latest`, `_batch` (partial).
- Zero rows in the new table, and every other acquisition count unchanged —
  **still 20** fictional rows across the eight pre-existing tables.

### 11.5 The behavioural probe leaves a permanent row

Section 5 of the verification proves the four refusals — future wash, fixture
claiming authority, missing attester, duplicate import — and to do so it must
first insert one row that succeeds. **That row cannot then be deleted**, because
the table is append-only, which is the very property being proven.

So the probe is optional and commented out. Running it takes dev from 20
fictional rows to **21**, against the fictional number `+61355509999`. If you
run it, update the count in the blocker register.

### 11.6 Rollback

LAQ4 is additive and creates one table nothing else references:

```sql
drop table if exists public.acquisition_dncr_washes;
drop function if exists public.acquisition_reject_future_wash();
```

**Do not drop `public.acquisition_refuse_mutation()`** — laq2 created it and
four other tables still depend on it.

That rollback is only safe *before real washes exist*. Once an attested wash is
stored, dropping this table destroys the evidence that calls were lawfully made,
and the rollback becomes a restore rather than a drop.

### 11.7 What dev holds now, and what was proven

**LAQ4 applied to dev 2026-08-10.** The behavioural probe ran once and left one
permanent fictional row:

| field | value |
|---|---|
| `e164` | `+61355509999` (fictional, belongs to no business) |
| `result` | `not_listed` |
| `washed_at` | `2026-08-09T00:00:00Z` |
| `attested_by` | `laq4-verify` |
| `mode` / `authoritative` | `import` / `true` |
| `batch_ref` | `laq4-verify-batch` |
| `source` | `verification probe` |

**Dev fictional residue is now 21 rows across nine tables** (was 20 across
eight). `acquisition_decisions` is still 4 — laq4 wrote no decision.

**The durability proof is `scripts/dev/acquisition-dncr-proof/`, and it is
READ-ONLY.** Baseline, then two genuinely separate OS processes, then a
later-instant evaluation of the same row. 33 checks, zero residue, and the wash
ledger's sha256 is identical before and after:

- **Process A** hydrates from dev, gets `not_listed` / authoritative / usable at
  +6 days, and the DNCR gate passes. A control proves the answer came from
  Postgres: a store built without a durable read knows nothing about the number.
- **Process B**, a new process after A exited, recovers the same row field for
  field and gets the same answer.
- **The same row at +42 days** decays to `unknown` — not to `not_listed` — and
  eligibility refuses with `dncr_wash_stale`, telling the founder to wash it
  *again*. **No row changed**: freshness is a question about when you ask.

`.process-a-saw.json` is a handoff file, not a cache: B re-reads Postgres and
compares against it. It is gitignored.

**A rerun caveat:** the fixed `washed_at` means re-running section 5d against dev
now raises 23505 rather than inserting. That is 5e's demonstration, not 5d's, and
is why §11.5 says not to run it there again.

### 11.8 What LAQ4 still does not close

**E-3 is closed on dev and open for production**, which is not applied. And
**DNCR-1 remains external**: nobody holds a DNCR account, so no *real* wash has
ever entered this system. The row above is fictional and attested by a
verification probe, not by a person who washed a real list. Nothing in this
repository can contact the Register.

---

## 12. E-5 — durable batch approval needed NO SQL

**There is no LAQ5.** This section exists so that the question is answered here,
in the document that owns migration state, rather than being re-asked later.

E-5 makes founder batch approval durable and restart-safe. The audit that opened
it asked whether `acquisition_decisions` could represent a batch approval safely,
rather than assuming it could, and the answer was yes on every count:

| what E-5 needed | what already provides it | applied |
|---|---|---|
| `entity_type` admitting `'batch'` | **LAQ1** — it is in the CHECK as originally written, alongside `prospect`, `phone`, `queue`, `suppression`, `campaign`, `system` | dev, 2026-08-07 |
| a structured membership record | `acquisition_decisions.detail jsonb` — a 25-business membership is small | dev, 2026-08-07 |
| lookup by batch | `idx_acq_decisions_entity (entity_type, entity_id)` | dev, 2026-08-07 |
| a historical approval that cannot be edited | trigger `acq_decisions_no_update` | dev, 2026-08-07 |
| tamper-evidence | the `prev_hash` chain | dev, 2026-08-07 |
| concurrent approvals that cannot fork | `unique (prev_hash)` | **LAQ3**, dev, 2026-08-08 |

So **no table, no `ALTER`, no CHECK change, no index, no constraint and no
function** were written or applied for E-5. `02_laq1_verify.sql` V3.11 already
checks the `entity_type` constraint; nothing new needs verifying, because
nothing new was created.

### 12.1 The residue question, answered before it arises

A durable batch approval is a row in `acquisition_decisions`, which is
**append-only and enforced as such by trigger**. Writing one against dev to
demonstrate E-5 would therefore have created a **permanent** fictional approval
row that could never be removed — the same class of residue §11.7 documents for
LAQ4's one wash row.

**No such row was written.** E-5's restart proof
(`scripts/dev/acquisition-batch-approval-proof/`) runs two genuinely separate OS
processes against a **file-backed store**, because what it has to prove is a
property of the fold over append-only rows and that fold does not know which
durable thing the rows came out of. The Supabase adapter's own row mapping for
`acquisition_decisions` is already proven by `test/acquisition-store.test.js` and
by the M8H/M8I exercises in §10.

**Dev's fictional row count is unchanged by E-5.** `acquisition_decisions` still
holds exactly the rows §9 and §10 describe.

### 12.2 If a real approval is ever recorded on dev

It would be a **permanent decision row**, and it should be treated as a founder
decision rather than an engineering step. Before running
`node scripts/acquisition-batch.js approve …` against dev, note that:

- the row cannot be deleted, and the `UPDATE`/`DELETE` trigger will refuse;
- **withdrawing** an approval appends a second row rather than removing the
  first, which is correct and also means a withdrawal doubles the residue;
- the approval names a real person, so it should name the person who actually
  made the decision;
- `preview` writes nothing and should be run and read first.

---

## 13. M8L — durable duplicate resolution needed NO SQL either

**Still no LAQ5.** M8L makes duplicate resolution durable, attributable and
restart-safe by READING WHAT WAS ALREADY BEING WRITTEN. It adds no event type, no
column and no table.

The M8H review queue has stored these decisions in `acquisition_decisions` since
2026-08-08 — `review_opened` and `review_resolved`, keyed by the candidate's
prospect id, carrying `reviewDecision` and `mergeTarget` in `detail jsonb`. Those
five outcomes are exactly the five duplicate states M8L has to answer, so the
work was a read path, not a schema.

| what M8L needed | what already provides it | applied |
|---|---|---|
| durable review decisions | **LAQ1** `acquisition_decisions`, `entity_type` admits `prospect` | dev, 2026-08-07 |
| structured decision detail | `detail jsonb` | dev, 2026-08-07 |
| lookup by prospect | `idx_acq_decisions_entity (entity_type, entity_id)` | dev, 2026-08-07 |
| a stored prospect row | **LAQ1** `acquisition_prospects` | dev, 2026-08-07 |
| decisions that cannot be edited | trigger `acq_decisions_no_update` | dev, 2026-08-07 |

### 13.1 Residue

**No dev write, and none is needed.** M8L's restart proof
(`scripts/dev/acquisition-duplicate-proof/`) runs two genuinely separate OS
processes against a **file-backed store**, because what it proves is a property
of the fold over append-only review rows — and both the M8H review queue and the
M8I decision chain were already proven against real dev Postgres (§10). A dev run
would append **permanent** review rows to an append-only table to demonstrate a
fold that needs none.

**Dev's fictional row count is unchanged by M8L.** Still 21 rows across nine
tables; `acquisition_decisions` still 4.

### 13.2 If duplicate reviews are ever resolved on dev

`node scripts/acquisition-review.js resolve …` appends a **permanent** decision
row, and since M8L that row also decides whether the business can ever be called.
Two consequences worth knowing before running it:

- the decision cannot be deleted or edited — the trigger refuses;
- `merge_into_existing` makes the candidate permanently un-callable and names the
  canonical business; there is no "unmerge" and there should not be one.

`node scripts/acquisition-review.js duplicates` is read-only and creates no
residue. Run it first.

---

## 14. E-7A — the dial execution seam needed NO SQL, and applied none

**E-7A added no table, no column, no constraint, no function and no migration.
Nothing was applied to dev. Nothing was applied to production.**

### 14.1 Why it needed none

E-7A builds the seam that consumes an M8E `AuthorisedDial` and asks a provider
for one call. The only piece of that which genuinely wants durable state is
**single-consumption** — "this authorisation has already been spent" — and E-7A
does not claim durable single-consumption. It claims a **process-local** one, in
a `WeakSet`, and says so in the code, in the tests and in the register.

Everything else the seam does is a pure function of the slip it was handed:
identity verification, expiry, the caller-override guard, the provider contract
and the result vocabulary. None of that is state.

So there was nothing to migrate, and inventing a table to look thorough would
have created exactly the thing the milestone is careful about: a durable record
implying a guarantee the code does not make.

### 14.2 What E-7A wrote to dev

Nothing.

| check | after E-7A |
|---|---|
| `acquisition_decisions` | **4 rows** — unchanged |
| total dev fictional residue | **21 rows across nine tables** — unchanged |
| `acquisition_call_queue` | **0 rows** — untouched, and not used by E-7A |
| migrations applied | **none** |
| production | **untouched — still no acquisition schema at all** |

The proof (`node scripts/acquisition-dial-proof.js`) uses an **in-memory** store
that dies with the process. It reads no `.env`, constructs no Supabase client,
and cannot reach Postgres.

### 14.3 The SQL E-7B WILL need — stated now so it can be reviewed before it is written

Durable cross-process single-consumption is the one thing E-7A cannot honestly
provide, and it is a hard requirement before any live provider. Two options,
both additive:

**Option A — a dedicated execution ledger (preferred).**

```
create table public.acquisition_dial_executions (
  id                uuid primary key default gen_random_uuid(),
  authorisation_id  text not null unique,        -- THE invariant
  execution_id      text not null unique,
  prospect_id       text not null references public.acquisition_prospects (prospect_id),
  e164              text not null check (e164 ~ '^\+61[0-9]{6,12}$'),
  provider          text not null,
  provider_live     boolean not null,
  status            text not null,
  provider_ref      text,
  authorised_at     timestamptz not null,
  executed_at       timestamptz not null default now()
);
```

**Option B — extend `acquisition_call_queue`** with `dispatched_at`,
`execution_id` and `authorisation_id`, plus a unique index on
`authorisation_id`. Cheaper, but it overloads a table that currently models
*reservations*, and a lease is not a dispatch.

**The invariant either way:** the second dispatch of one authorisation is refused
by a **unique-constraint violation in the database**, not by application memory.
Same shape as `laq3`'s `unique (prev_hash)` — a fork made structurally
impossible rather than merely discouraged.

**Neither option was written, applied, or approved in E-7A.** They are stated
here so the schema conversation can happen before the code exists, not after.

> ## ⚠ SUPERSEDED 2026-08-11 — THIS SKETCH IS WRONG. See [ACQUISITION_E7B1_DESIGN.md](ACQUISITION_E7B1_DESIGN.md).
>
> The E-7B1 design review found two defects in the proposal above, and both were
> measured rather than argued:
>
> **1. `authorisation_id` cannot be the unique key.** It is a sha256 of
> `(prospectId, e164, authorisedAt, decision)`, so two *genuinely distinct*
> authorisations of the same prospect at the same millisecond produce the **same
> id** — E-7A's own suite asserts that collision as a feature, because it makes
> proof transcripts comparable. As a correlation id that is fine; as a
> uniqueness key it would refuse a valid authorisation and record two
> authorisations as one. The durable key must be a **random** `dispatch_id`
> minted per authorisation, with `authorisation_id` kept, non-unique, for
> correlation.
>
> **2. Uniqueness on the authorisation does not stop the double call.** It
> prevents replay of *one* authorisation. It does not prevent two workers each
> minting *their own* authorisation for the same business seconds apart — both
> get different ids, both claim, both dial. The attempt policy cannot catch it
> either: `minDaysBetweenAttempts` is computed from
> `acquisition_contact_outcomes`, and neither worker has recorded an outcome
> yet, so both read "never contacted".
>
> The corrected design closes **both** threats: `primary key (dispatch_id)` for
> replay, and `unique (prospect_id) where completed_at is null` for concurrent
> duplicate authorisation. **Option B is rejected outright** — a lease is not a
> dispatch, and `on delete cascade` is wrong for a record that a business may
> have been rung.

### 14.4 Also outstanding for E-7B

A **durable kill switch**. Today the emergency stop is a context field a caller
supplies; the executor re-reads an injected one immediately before the provider,
which closes the window between minting and dispatch but still depends on the
caller passing a reader in. Before a live call, the stop must be something the
executor reads for itself and that no caller can decline to provide. Whether that
is a row, a flag table or a campaign record is an open design question — and it
is a **blocker on E-7B, not on E-7A**, because nothing can currently dial.


---

## 15. LAQ5 — APPLIED TO DEV 2026-08-12, proven against real Postgres

**`supabase/sql/laq5_create_dispatch_authority.sql`** was applied by hand in the
Supabase SQL editor on **2026-08-12**, against dev `wvwemitmmsdytyutaqbm`. The
editor returned *Success. No rows returned.*

| | state |
|---|---|
| dev | **APPLIED** 2026-08-12 (E-7B1) |
| production | **NOT APPLIED** |
| rows it created on dev | **1** — the bootstrap `global` / `paused` / revision 1 row, `changed_by = 'laq5-migration'` |
| rows the scripted proof then added | **1** — the fictional unresolved dispatch claim, `20e8681f-0c72-45f6-b4ea-484f6e0cc3c0` |
| dev fictional residue | **21 → 23**, across eleven tables |
| `acquisition_decisions` | **unchanged at 4** — laq5 writes none, and the proof writes none |
| `acquisition_call_queue` | **unchanged at 0** |

It creates two tables, two guard functions, two triggers, five indexes and one
bootstrap row. Nothing existing was altered.

**The two load-bearing constraints** are partial unique indexes on
`(prospect_id)` and `(destination_e164)`, both `where resolved_at is null`.
`test/acquisition-laq5-migration.test.js` fails the build if either disappears,
or if either predicate is changed to something a provider result can flip.
**Both are now proven behaviourally against dev**, not just statically: see
§15.1.

**Applying it did not enable calling.** The bootstrap row is `paused`, a test
asserts the migration never writes `enabled` anywhere, and there is still no
provider in the repository that declares itself `live`. The proof re-read the
state at the end of its run and it is still `paused`, still revision 1.

### 15.1 What the scripted proof established, and what it did not

`scripts/dev/acquisition-dispatch-proof/` ran against dev on 2026-08-12 through
the **actual `acquisition-dispatch-store` code the executor uses**.

**Proven behaviourally against real Postgres:**

| | |
|---|---|
| the bootstrap stop | read back as `paused`, revision 1, attributed — and reported as `acquisition_calling_paused`, a decision, not a read failure |
| the executor while paused | refused a non-genuine slip (`authorisation_invalid`) and refused a caller-supplied `killSwitch` (`caller_override_rejected`); zero provider invocations |
| **the genuine two-process race** | two OS processes (pids 16700 and 2092), two connections, no shared memory, both firing at one wall-clock instant at the same business on the same handset: **one CLAIMED, one CONFLICT (prospect)**, one row in the ledger |
| T1 replay | same `dispatch_id` again → `ALREADY_CLAIMED` |
| T2 prospect lock | same prospect, different dispatch, different number → `CONFLICT`, scope `prospect` |
| T3 destination lock | different prospect, same number → `CONFLICT`, scope `destination` — the case a per-prospect lock cannot see |
| the row after all of it | `resolved_at` null, `resolution` null, `provider_status` `pending`, still holding both locks |
| census | 23 total, decisions 4, queue 0, calling still paused |

**23 checks passed, 0 failed**, plus 6 in the race.

**NOT proven against dev, and deliberately so:**

- **T4** (an independent prospect on an independent number would succeed) is
  proven **structurally** — both partial indexes were confirmed to hold nothing
  matching it — rather than by writing, because a successful claim leaves a
  second permanent row and only one is approved.
- **The guard triggers** — identity immutability, no-DELETE, no-reopen, the
  resolution/submission constraint pairs, and the calling-state tamper rules —
  are covered by `test/acquisition-laq5-migration.test.js` against the migration
  text and by the offline E-7B1 suite. Exercising them against dev needs the
  writes in **section 6 and section 7** of the verification script, which were
  **not run**: section 6 would commit a second permanent dispatch row, and
  section 7's probes would mutate the approved residue if any of them
  unexpectedly succeeded.
- **Sections 1–5** of `verification/12_laq5_verify.sql` (columns, RLS, index
  definitions, constraint and trigger definitions) are read-only introspection
  over `information_schema` and `pg_catalog`. **PostgREST cannot reach either**,
  so nothing in this repository can run them — they remain a **paste-by-hand**
  step for a human who wants to see the index predicates with their own eyes.
  The behavioural results above are what stands in for them today.

See [ACQUISITION_E7B1_DESIGN.md](ACQUISITION_E7B1_DESIGN.md) for the full
rationale, and §14.3 above for the superseded sketch it corrects.
