# RLS Application Checklist

Applies `phase2_enable_rls.sql` — enables deny-by-default Row Level Security on all
7 application tables. The server (service-role key) bypasses RLS entirely, so when
the preconditions hold, this is a zero-downtime, zero-code-change action.

## Preconditions — ALL must be true before running

- [ ] Commit `1cdeaaa` (or later) is **deployed and live** on Railway — this is the
      build where `public/index.html` no longer talks to Supabase directly.
      ⚠️ Applying RLS while an older build is live breaks the dashboard's calls
      list instantly (it used the anon key, which deny-by-default RLS cuts off).
- [ ] Full smoke test in `DEPLOYMENT.md` passed — especially step 2 (calls list
      via `/calls`) and step 8 (live inbound call end-to-end).
- [ ] `grep -ri "supabase.co\|apikey\|eyJhbGci" public/` returns nothing
      (no browser page holds DB credentials).
- [ ] You have the Supabase SQL Editor open on the **correct project**
      (`SUPABASE_URL` in Railway matches the project ref you're editing).
- [ ] You know where the rollback block is (bottom of `phase2_enable_rls.sql`,
      commented out).

## Apply

1. [ ] Paste the whole of `phase2_enable_rls.sql` into the SQL Editor and run it.
       It is wrapped in `begin`/`commit` — all-or-nothing.
2. [ ] First verification select: `rowsecurity = t` for all 7 tables
       (`calls`, `clients`, `client_settings`, `connections`, `contacts`,
       `business_profiles`, `personal_contacts`).
3. [ ] Second verification select: **zero** policies listed (deny-by-default is
       the design — no policies is correct, and the table comments say so).

## Post-apply verification (within minutes of applying)

- [ ] Operator dashboard: calls list loads; save a status change on one call.
- [ ] Client dashboard: client login works; contacts load.
- [ ] Live inbound test call: logged, transcribed, notification email arrives.
      (Proves the webhook pipeline's service-role writes are unaffected.)
- [ ] Negative proof — the old exposure is actually closed: from any terminal,
      `curl "https://<project-ref>.supabase.co/rest/v1/calls?select=id&limit=1" -H "apikey: <old-anon-key>" -H "Authorization: Bearer <old-anon-key>"`
      must return an **empty array** (`[]`) or a permission error — anything but
      call data.

## If something breaks

1. Identify what failed — the only things RLS can affect are requests reaching
   Postgres **without** the service-role key. The server has exactly one client
   (`src/services/supabase.js`, service-role); browser pages have none. So a
   breakage means some other consumer exists (old build still cached in a
   browser tab? another tool hitting PostgREST?). Find it before rolling back
   if at all possible.
2. Emergency rollback: run the commented-out `disable row level security` block
   at the bottom of `phase2_enable_rls.sql`. This restores the pre-RLS exposure
   — treat it as temporary and re-apply after fixing the real cause.

## Afterwards

- [ ] Note the date applied here: ______
- [ ] Optional hardening (schedule deliberately, don't improvise): rotating the
      leaked anon key requires rotating the project JWT secret, which **also
      invalidates the service key** — update `SUPABASE_SERVICE_KEY` in Railway
      in the same window or the whole app loses DB access.
