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

## 7. What this milestone did not do

No database connection was opened. No statement was executed. No credentials
were read. The file was reviewed as text only.
