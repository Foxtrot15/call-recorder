# Acquisition SQL Runbook — applying LAQ1 and LAQ2 to dev

**Status:** written, **not executed**. Nothing in this repository applies SQL,
and a test asserts that. Every step below is something a human runs by hand.

**Owns (source of truth for):** the order LAQ1 and LAQ2 are applied in, how each
is verified, and what can and cannot be rolled back.

> **Apply to the dev Supabase project only.** Nothing here has been run against
> anything. Production is out of scope for this runbook and for M8C.

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

## 6. Self-rolling-back probes — the invariants that matter

Every block below ends in `rollback`. Nothing persists.

```sql
-- 6.1  ONE LIVE LEASE PER BUSINESS. This is the rule application code cannot
--      guarantee under a race, and the reason the index exists.
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at)
  values ('pr_lease', 'Lease Probe', 'Australia/Melbourne', 'fixture', now());

  insert into public.acquisition_call_queue
    (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
  values ('pr_lease', '+61355501042', 'worker-a', 'tok-a', now(), now() + interval '5 min');

  -- This must FAIL.
  insert into public.acquisition_call_queue
    (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
  values ('pr_lease', '+61355501042', 'worker-b', 'tok-b', now(), now() + interval '5 min');
rollback;
```
Expect
`ERROR: duplicate key value violates unique constraint "idx_acq_queue_one_live_lease"`.

```sql
-- 6.2  …and releasing the first frees the slot.
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at)
  values ('pr_lease2', 'Lease Probe 2', 'Australia/Melbourne', 'fixture', now());
  insert into public.acquisition_call_queue
    (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
  values ('pr_lease2', '+61355501042', 'worker-a', 'tok-c', now(), now() + interval '5 min');

  update public.acquisition_call_queue set released_at = now() where lease_token = 'tok-c';

  insert into public.acquisition_call_queue
    (prospect_id, e164, worker_id, lease_token, granted_at, expires_at)
  values ('pr_lease2', '+61355501042', 'worker-b', 'tok-d', now(), now() + interval '5 min');
rollback;
```
Expect both inserts to succeed.

```sql
-- 6.3  SUPPRESSION IS PERMANENT — the table refuses to forget.
begin;
  insert into public.acquisition_suppressions
    (reason, scope, fingerprint, e164, actor, actor_kind, note, suppressed_at)
  values ('opt_out', 'business', 'probe-locksmiths#preston|vic', '+61355502287',
          'runbook', 'human', 'Probe.', now());

  -- Both of these must FAIL.
  update public.acquisition_suppressions set note = 'changed' where actor = 'runbook';
  delete from public.acquisition_suppressions where actor = 'runbook';
rollback;
```
Expect
`ERROR: Table acquisition_suppressions is append-only: UPDATE is not permitted.`

```sql
-- 6.4  A business-scoped suppression cannot be stored without an identity.
begin;
  insert into public.acquisition_suppressions
    (reason, scope, e164, actor, note, suppressed_at)
  values ('opt_out', 'business', '+61355502287', 'runbook', 'Probe.', now());
rollback;
```
Expect a violation of `acq_suppression_scope_key`.

```sql
-- 6.5  A number that was not normalised is refused, so comparison stays sound.
begin;
  insert into public.acquisition_suppressions
    (reason, scope, e164, actor, note, suppressed_at)
  values ('wrong_number', 'number', '(03) 5550 1042', 'runbook', 'Probe.', now());
rollback;
```
Expect a CHECK violation on `e164`.

```sql
-- 6.6  DELETING A PROSPECT CANNOT ERASE ITS OPT-OUT.
--      The single most important probe in this runbook.
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at)
  values ('pr_del', 'Delete Probe', 'Australia/Melbourne', 'fixture', now());

  insert into public.acquisition_suppressions
    (reason, scope, fingerprint, e164, actor, actor_kind, note, suppressed_at)
  values ('opt_out', 'business', 'delete-probe#preston|vic', '+61355509999',
          'runbook', 'human', 'Probe.', now());

  delete from public.acquisition_prospects where prospect_id = 'pr_del';

  -- The suppression must STILL be here.
  select count(*) from public.acquisition_suppressions where actor = 'runbook';
rollback;
```
Expect the delete to succeed and the count to be **1**. There is no foreign key
from suppression to prospects, deliberately — a cascade would let a deleted
prospect erase its own opt-out, which is the accident the whole design prevents.

```sql
-- 6.7  An outcome cannot be erased by deleting the prospect either.
begin;
  insert into public.acquisition_prospects
    (prospect_id, business_name, timezone, origin, discovered_at)
  values ('pr_out', 'Outcome Probe', 'Australia/Melbourne', 'fixture', now());
  insert into public.acquisition_contact_outcomes
    (prospect_id, outcome, reached_the_business, lifecycle_from, lifecycle_to,
     actor, actor_kind, note, recorded_at)
  values ('pr_out', 'opt_out', true, 'queued', 'suppressed',
          'runbook', 'human', 'Probe.', now());

  -- This must FAIL.
  delete from public.acquisition_prospects where prospect_id = 'pr_out';
rollback;
```
Expect a foreign-key RESTRICT violation.

---

## 7. Prove suppression survives a restart, on the real database

This is the M8C invariant, checked against Postgres rather than a test double.

1. Point the app at dev with the acquisition flags on, in a Node REPL from the
   repository root:

```js
const { createSupabaseAcquisitionStore } = require("./src/services/acquisition-store");
const { createDurableSuppression } = require("./src/services/acquisition-durable");
const now = () => new Date();

const store = createSupabaseAcquisitionStore();
const s1 = await createDurableSuppression({ now, store });
await s1.suppress({
  reason: "opt_out",
  fingerprint: "restart-probe#preston|vic",
  e164: "+61355500001",
  actor: "runbook",
  actorKind: "human",
  note: "Restart probe — delete this row by hand afterwards.",
});
console.log(s1.check({ fingerprint: "restart-probe#preston|vic" }).suppressed); // true
```

2. **Exit the REPL entirely.** `process.exit()`, or close the terminal. The
   point is to destroy the heap.

3. Start a new REPL and build a completely fresh service:

```js
const { createSupabaseAcquisitionStore } = require("./src/services/acquisition-store");
const { createDurableSuppression } = require("./src/services/acquisition-durable");
const store = createSupabaseAcquisitionStore();
const s2 = await createDurableSuppression({ now: () => new Date(), store });

// Must be true. Note the drifted suburb — this is the re-import case.
console.log(s2.check({ e164: "+61355500001", fingerprint: "restart-probe#preston-south|vic" }).suppressed);
```

Expect `true`. If it prints `false`, **M8C has failed on the real database** and
nothing should proceed to a dialler.

4. The probe row is real and permanent by design. Remove it deliberately, as a
   one-off admin action, and record that you did:

```sql
-- Only because it is a runbook probe on DEV. Never do this to a real opt-out.
alter table public.acquisition_suppressions disable trigger acq_suppressions_no_update;
delete from public.acquisition_suppressions where actor = 'runbook';
alter table public.acquisition_suppressions enable trigger acq_suppressions_no_update;
```

> Leaving the trigger disabled is how permanence quietly stops being permanent.
> Re-enable it in the same session, then re-run 6.3 to confirm it bites again.

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
  prospect while either is.
- Update the status line at the top of
  [LOCKSMITH_ACQUISITION_SPEC.md](LOCKSMITH_ACQUISITION_SPEC.md), which
  currently says both migrations are unapplied.
- Run the lease reaper manually once and confirm it reports zero:
  a sweep that reaps something on an empty queue means something is wrong.
