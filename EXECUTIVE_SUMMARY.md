# Aida — Executive Summary (architecture remediation, 2026-07-05)

## What this was

Aida grew from a single-tenant call-recording MVP into a partially multi-tenant
product. Three symptoms — new client logins failing, RLS "temporarily" disabled,
and `"default"` tenant fallbacks everywhere — were diagnosed as **one
architectural fault**: tenant identity was never server-derived, and the shared
service-role database client doubled as a user-login client, silently losing its
admin credentials whenever a client logged in. A second buried fault: the
operator dashboard shipped the database's anon key to every browser and
read/wrote the calls table directly, which is what RLS was actually disabled *for*.

## What was fixed (commit `1cdeaaa`, ~420 lines, committed, NOT yet pushed)

1. **Auth isolation** — the admin DB client can no longer be contaminated by
   logins; user auth runs on disposable clients; signups use the stateless
   admin API and are auto-confirmed (the "new users can't log in" bug).
2. **Signup integrity** — the account-takeover-by-slug hole is closed with
   operator-minted, HMAC-signed, expiring invite tokens; the user↔client link
   is verified and rolled back on failure instead of silently no-op'ing.
3. **Tenant identity** — every operator route derives the tenant from the
   session (`OPERATOR_CLIENT_ID`), never from request input; a live
   cross-tenant hole in `/auth/disconnect` was closed as a side effect.
4. **Database exposure** — the anon key and all direct browser→database access
   are gone; the dashboard now uses an authenticated server API with a
   field-level write whitelist. RLS enable script is written and reviewed.
5. **The inbound call pipeline was not touched** — by explicit constraint,
   across all phases.

## What is still risky (ranked, details in SECURITY_REVIEW.md)

1. **The fix isn't live** — everything above is committed but unpushed; and
   **RLS is still off**, so the previously-leaked anon key keeps working until
   the new build is deployed and `phase2_enable_rls.sql` is applied.
2. **`ENCRYPTION_KEY` may be unset** — if so, stored Google tokens are
   encrypted with a known trivial key. One-minute check in Railway.
3. **No rate limiting** on any login/signup endpoint; operator auth is a single
   shared password.
4. **Client sessions die after ~1 hour** (refresh token discarded) — a real
   client will experience this as "the app keeps logging me out."
5. Transitional debt, deliberate and documented: `'default'` tenant data,
   the legacy-row filter in the calls API, warn-only config validation.

## Must be done before the first real client

| # | Action | Reference |
|---|---|---|
| 1 | Push + deploy `1cdeaaa` (env var already set) | PRODUCTION_ROLLOUT.md |
| 2 | Pass the 9-step smoke test, esp. the live-call step | TEST_PLAN.md |
| 3 | Apply RLS + negative-proof the old anon key is dead | supabase/sql/RLS_APPLY_CHECKLIST.md |
| 4 | Verify `ENCRYPTION_KEY` is set and strong | SECURITY_REVIEW.md #3 |
| 5 | Decide the tenant model for pilot #1 (the OPERATOR_CLIENT_ID fork) | CLIENT_ONBOARDING_RUNBOOK.md |
| 6 | Rate-limit the three auth endpoints | PHASE_5_PLAN.md #4 |
| 7 | Client session refresh (or the pilot lives with hourly re-login) | PHASE_5_PLAN.md #5 |

Items 1–5 are non-negotiable; 6–7 are strongly recommended before handing a
login to a paying client.

## Document map

| Doc | Purpose |
|---|---|
| PRODUCTION_ROLLOUT.md | Tomorrow's exact sequence + rollback decision tree |
| TEST_PLAN.md | Smoke steps, expected results, log-level diagnostics |
| supabase/sql/RLS_APPLY_CHECKLIST.md | Gated RLS application |
| CLIENT_ONBOARDING_RUNBOOK.md | Manual pilot onboarding, end to end |
| INCIDENT_RESPONSE.md | Dashboard / calls / Google / RLS failure playbooks |
| SECURITY_REVIEW.md | Full findings: fixed, open, accepted |
| PHASE_5_PLAN.md | Ordered cleanup backlog with dependencies |
| DEPLOYMENT.md | Env vars, deploy order, current transitional state |
| supabase/sql/phase5_backfill_default.sql | Future data migration (guarded, not applied) |
