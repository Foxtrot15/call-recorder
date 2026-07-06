-- ============================================================================
-- Create the missing `personal_contacts` table (backlog item P1-6).
--
-- Context: the personal-contacts feature is fully wired in code —
-- src/services/personal-filter.js, routes/personal-contacts.js (mounted at
-- server.js:39), the recording pipeline gate (recording.js:143), and the
-- dashboard's flagAsPersonal() — but this table was never created. That was
-- proven when the Phase 2 RLS apply failed with:
--   ERROR 42P01: relation "public.personal_contacts" does not exist
-- Because personal-filter.js discards Supabase errors, the feature fails
-- silently today: /add reports success while saving nothing, and flagged
-- callers are still recorded and processed. Creating this table fixes the
-- feature with ZERO code changes.
--
-- Design notes (each mirrors what the code already does):
--   * unique (client_id, phone) — REQUIRED: addPersonalContact upserts with
--     onConflict:"client_id,phone", which errors (42P10) without it.
--   * client_id is text — the app stores the client slug (CLIENT_ID =
--     clients.slug). No FK: clients.slug's uniqueness isn't guaranteed by a
--     constraint we can see from the repo; add one later if desired.
--   * phone is text, stored space-stripped by the service.
--   * created_at — /list orders by it descending.
--   * RLS enabled in the same transaction — this table was skipped by the
--     Phase 2 apply (it didn't exist), and must not be born as the one
--     unprotected table. No policies = deny-by-default for anon/authenticated;
--     the app's service_role bypasses RLS, same as every other table.
--
-- Run in the Supabase SQL Editor. Run the verification queries after.
-- ============================================================================

begin;

create table if not exists public.personal_contacts (
  id          uuid        primary key default gen_random_uuid(),
  client_id   text        not null,
  phone       text        not null,
  label       text,
  created_at  timestamptz not null default now(),
  constraint personal_contacts_client_phone_key unique (client_id, phone)
);

alter table public.personal_contacts enable row level security;

comment on table public.personal_contacts is
  'RLS enabled, no policies: only service_role (the app server) may access this table. Numbers the client flagged as personal — calls from them are logged but skip business automation. See src/services/personal-filter.js.';

-- Speeds up the per-call lookup in isPersonalCall (eq client_id + eq phone);
-- the unique constraint above already provides the composite index, so this
-- is intentionally NOT duplicated with a separate index.

commit;

-- ----------------------------------------------------------------------------
-- Verification — run after the block above commits.
-- ----------------------------------------------------------------------------
-- 1. Table exists with RLS on (expect one row, rowsecurity = t):
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'personal_contacts';

-- 2. The upsert path the code relies on works (then clean up):
--    insert into public.personal_contacts (client_id, phone, label)
--    values ('default', '+61400000000', 'smoke-test')
--    on conflict (client_id, phone) do update set label = excluded.label;
--    delete from public.personal_contacts
--    where client_id = 'default' and phone = '+61400000000';

-- 3. App-level check: dashboard → flag a caller as personal → GET
--    /personal-contacts/list should now return it (previously always []).

-- ----------------------------------------------------------------------------
-- Rollback — only if something unexpected breaks. The feature returns to its
-- current silent no-op state (worse, but known).
-- ----------------------------------------------------------------------------
-- begin;
-- drop table if exists public.personal_contacts;
-- commit;
