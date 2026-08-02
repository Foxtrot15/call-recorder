# Retell Provisioning SQL — Review and Application Checklist

**Reviewed:** 2026-08-02 (M7F-A). **NOT APPLIED.** No database was connected and
no statement was executed. This document exists so a human can apply it
deliberately, verify it, and undo it.

File: `supabase/sql/lpm3_create_retell_provisioning.sql` (263 lines)

---

## 1. What it creates

Four tables, all in `public`:

| Table | Purpose |
|---|---|
| `provider_resources` | the registry of Retell resources AIDA has created (knowledge bases, response engines, agents, bindings) |
| `provisioning_plans` | a planned set of provider operations for one approved profile version |
| `provisioning_actions` | the individual steps of a plan and their outcomes |
| `provider_webhook_events` | received provider events, for idempotency and audit |

Indexes: `pr_client_idx`, `pr_plan_idx`, `pp_client_created_idx`,
`pp_profile_version_idx`, `pa_plan_idx`, `pwe_call_idx`, `pwe_status_idx`,
`pwe_session_idx`.

## 2. RLS

**Every one of the four tables runs `enable row level security` in the same
migration that creates it, and no policy is created.**

That is the house rule (D8, "RLS at birth") working as intended, and it is
deliberately restrictive: with RLS on and no policies, only the `service_role`
key can read or write. There is no window in which a table exists unprotected,
and no anon/authenticated access is possible until somebody writes a policy on
purpose.

## 3. Safety and reversibility

| Property | Assessment |
|---|---|
| Idempotent | **Yes** — `create table if not exists`, `create index if not exists` throughout |
| Destructive statements | **None** — no `drop`, no `truncate`, no `alter ... drop column` |
| Existing data touched | **None** — creates only; no backfill, no migration of existing rows |
| Rerunnable | **Yes** — a second run is a no-op |
| Superseded by a later migration | **No** — it is the newest Retell migration in `supabase/sql/` |

**Rollback** is `drop table` in reverse dependency order. It is destructive of
whatever the tables have accumulated, which on a fresh application is nothing.

## 4. Which runtime paths need it

| Path | Needs these tables? |
|---|---|
| **`call_inbound` webhook (M7F-A)** | **NO** — see §5 |
| `call_ended` / `call_analyzed` event webhook | **Yes** — `provider_webhook_events` for fingerprint idempotency |
| Provisioning execution (create agent etc.) | Yes — plans, actions, resources |
| Read-only call diagnostics | **No** — reads from the provider, stores nothing |
| Australian phone speech | **No** — pure |
| The receptionist compiler | **No** — pure |

## 5. `call_inbound` does NOT depend on this SQL

Worth stating plainly, because it changes the order of operations for the first
inbound call.

The inbound webhook answers from the injected resolver and pure functions only.
`services/retell-inbound-call.js` has no database import, and
`routes/retell-inbound-webhook-handler.js` has none either; tests assert both.

This separation is deliberate rather than incidental. The inbound webhook runs
**before a caller is answered**, with a 10-second budget, and Retell's documented
fallback is that after three failed attempts it connects to the number's bound
agent — or, if there is none, **disconnects the caller**. Putting a database
round trip in front of a ringing phone would mean a database problem could hang
up on a locksmith's customer.

**So a first inbound call can be attempted with this SQL unapplied.** What is
lost is post-call event recording and idempotency, not the ability to answer.

## 6. Founder application checklist

Apply only when you want post-call event processing and provisioning execution.

**Before**
1. Confirm the target project is the **dev** Supabase project, not production.
2. Take a snapshot/backup, or confirm the project holds nothing you would miss.
3. Read the file top to bottom — 263 lines, no destructive statements.
4. Confirm no other session is mid-migration.

**Apply**
5. Open the Supabase SQL editor for the dev project.
6. Paste the **entire** contents of `supabase/sql/lpm3_create_retell_provisioning.sql`.
7. Run once. Expect success with no rows returned.

**Verify**
8. Confirm all four tables exist:
   ```sql
   select table_name from information_schema.tables
   where table_schema = 'public'
     and table_name in ('provider_resources','provisioning_plans',
                        'provisioning_actions','provider_webhook_events')
   order by table_name;
   ```
   Expect exactly four rows.

9. Confirm RLS is enabled on every one:
   ```sql
   select relname, relrowsecurity from pg_class
   where relname in ('provider_resources','provisioning_plans',
                     'provisioning_actions','provider_webhook_events');
   ```
   Expect `relrowsecurity = true` for all four. **If any is false, stop** — that
   table is readable by anyone holding an anon key.

10. Confirm there are no policies (service_role only is intended):
    ```sql
    select tablename, policyname from pg_policies
    where tablename in ('provider_resources','provisioning_plans',
                        'provisioning_actions','provider_webhook_events');
    ```
    Expect **zero rows**.

11. Confirm the indexes exist:
    ```sql
    select indexname from pg_indexes
    where schemaname = 'public'
      and indexname in ('pr_client_idx','pr_plan_idx','pp_client_created_idx',
                        'pp_profile_version_idx','pa_plan_idx','pwe_call_idx',
                        'pwe_status_idx','pwe_session_idx')
    order by indexname;
    ```
    Expect eight rows.

12. Re-run the whole migration once more. It must succeed and change nothing —
    that is the idempotency guarantee, and it is cheap to verify.

**Rollback**
13. Only if you need to undo it, and only on dev:
    ```sql
    drop table if exists public.provisioning_actions;
    drop table if exists public.provisioning_plans;
    drop table if exists public.provider_webhook_events;
    drop table if exists public.provider_resources;
    ```
    Reverse dependency order. **This destroys any recorded events and plans.**

**Stop immediately if**
14. You are connected to production; any table already exists with unexpected
    columns; RLS reports false after step 9; or any policy appears at step 10.

## 7. Inbound client resolution (added M7F-B1)

The resolver reads **two** tables, so `lpm3` alone is not enough.

### Ordered application plan

| # | File | Purpose | Prerequisite | Needed for |
|---|---|---|---|---|
| 1 | `lpm2_create_locksmith_onboarding.sql` | `locksmith_business_profiles` — the approved-profile lookup | none | **inbound answering** |
| 2 | `lpm3_create_retell_provisioning.sql` | `provider_resources` (agent → client), plans, actions, events | 1 | **inbound answering** |
| 3 | `lpm7_inbound_agent_resolution.sql` | reverse-lookup index + cross-tenant collision guard | 2 | **inbound answering** (see below) |

`lpm4`, `lpm5` and `lpm6` are unrelated to inbound resolution and are not
required for it.

### What each stage buys

| Capability | Needs |
|---|---|
| Signature verification, 401/503 behaviour | **nothing** |
| Verified call with an unknown agent → empty `call_inbound` | **nothing** — a registry read failure classifies as `registry_unavailable`, which withholds variables identically |
| Verified call **resolved** to a client with variables | 1 + 2 |
| Resolution that is fast and collision-proof | 1 + 2 + 3 |
| Post-call event recording and idempotency | 2 |
| Provisioning execution | 2 |

So the split is:

* **Required before the public webhook resolver proof:** nothing, for the
  security checks; 1 + 2 if you want the *resolved* case proved.
* **Required before the first inbound phone call:** 1 + 2, and 3 is strongly
  recommended — see the warning below.
* **Optional for answering, required for audit completeness:** the
  `provider_webhook_events` half of 2.

### `lpm7` — why it matters, and the check that must come first

`pr_one_active_per_purpose` is unique on `(client_id, provider, purpose,
resource_type)`. It guarantees **one active agent per client**. It does **not**
guarantee one client per agent: there is no unique constraint, and no index at
all, on `provider_resource_id`.

Two consequences:

1. The reverse lookup the inbound webhook performs is a **sequential scan**,
   in front of a ringing phone, inside a 10-second budget.
2. Nothing at the database level stops the same Retell agent appearing under two
   tenants. The application refuses that case — the resolver returns
   `ambiguous_agent` and emits no variables — but the invariant belongs in the
   database too.

**Before applying `lpm7`, run this. The unique index will fail if it finds
duplicates, and that failure is a report worth reading, not an obstacle:**

```sql
select provider, provider_resource_id,
       count(*)                         as active_rows,
       count(distinct client_id)        as distinct_clients,
       array_agg(distinct client_id)    as clients
from public.provider_resources
where active = true
group by provider, provider_resource_id
having count(*) > 1
order by distinct_clients desc;
```

Expect **zero rows**. Any row with `distinct_clients > 1` is a live
cross-tenant collision and must be resolved by superseding the wrong row
(`active = false`, `superseded_at = now()`) — **never by deleting history**.

**Verify after applying:**

```sql
select indexname from pg_indexes
where schemaname = 'public'
  and indexname in ('pr_provider_resource_lookup', 'pr_one_client_per_active_resource');
```

Expect two rows. Then re-run the migration once; it must succeed and change
nothing.

**Rollback:**

```sql
drop index if exists public.pr_one_client_per_active_resource;
drop index if exists public.pr_provider_resource_lookup;
```

Dropping these removes a safety guarantee and restores a sequential scan. It is
safe for the data, not for the invariant.

### RLS

`lpm7` creates **indexes only** — no table, so no new RLS surface. The RLS
posture of `provider_resources` (enabled, no policies, service_role only) is
established by `lpm3` and is unchanged.

## 8. What this milestone did not do

No database connection was opened. No statement was executed. No credentials
were read. Every file was reviewed as text only, and `lpm7` was **written** for
review rather than applied.
