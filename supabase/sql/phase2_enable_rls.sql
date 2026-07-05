-- ============================================================================
-- Phase 2: Enable Row Level Security (deny-by-default) on all application
-- tables.
--
-- Context: the Node server is the ONLY consumer of these tables, and every
-- request path (Twilio webhooks, operator dashboard, client dashboard) goes
-- through src/services/supabase.js, the shared service-role client. Supabase's
-- service_role Postgres role has BYPASSRLS, so nothing in this script affects
-- any existing query. The client-facing login (services/client-auth.js) only
-- ever verifies a user's token via supabase.auth.getUser() / signInWithPassword
-- against Supabase Auth (GoTrue) — it never uses that token to query these
-- tables directly. So there is currently no code path running as `anon` or
-- `authenticated` against Postgres; this script only forecloses one that
-- doesn't exist yet.
--
-- Safe to run with zero application downtime and zero code changes.
-- Run in the Supabase SQL Editor (or `supabase db execute` if the CLI is
-- linked to this project). Run the verification queries at the bottom
-- immediately after.
-- ============================================================================

begin;

alter table public.clients            enable row level security;
alter table public.client_settings    enable row level security;
alter table public.calls              enable row level security;
alter table public.contacts           enable row level security;
alter table public.personal_contacts  enable row level security;
alter table public.business_profiles  enable row level security;
alter table public.connections        enable row level security;

-- Enabling RLS with zero policies already denies ALL access to `anon` and
-- `authenticated` (Postgres default-deny; service_role is unaffected via
-- BYPASSRLS). These comments exist so "no policies" reads as "deliberate,"
-- not "someone forgot," to anyone inspecting the schema later.
comment on table public.clients           is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';
comment on table public.client_settings   is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';
comment on table public.calls             is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';
comment on table public.contacts          is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';
comment on table public.personal_contacts is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';
comment on table public.business_profiles is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';
comment on table public.connections       is 'RLS enabled, no policies: only service_role (the app server) may access this table. See src/services/supabase.js.';

commit;

-- ----------------------------------------------------------------------------
-- Verification — run after the block above commits.
-- `rowsecurity` should be `t` (true) for all 7 rows.
-- ----------------------------------------------------------------------------
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'clients', 'client_settings', 'calls', 'contacts',
    'personal_contacts', 'business_profiles', 'connections'
  )
order by tablename;

-- Confirms zero policies exist (expected for deny-by-default — nothing to
-- enumerate, since we're relying on RLS-enabled-with-no-policies, not on
-- explicit deny rules).
select schemaname, tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename in (
    'clients', 'client_settings', 'calls', 'contacts',
    'personal_contacts', 'business_profiles', 'connections'
  );

-- ----------------------------------------------------------------------------
-- Rollback — only if the app breaks after running this and you need to buy
-- time. If you ever need this, something in the app is querying Postgres
-- with a non-service-role key — track that down rather than leaving RLS off.
-- ----------------------------------------------------------------------------
-- begin;
-- alter table public.clients            disable row level security;
-- alter table public.client_settings    disable row level security;
-- alter table public.calls              disable row level security;
-- alter table public.contacts           disable row level security;
-- alter table public.personal_contacts  disable row level security;
-- alter table public.business_profiles  disable row level security;
-- alter table public.connections        disable row level security;
-- commit;
