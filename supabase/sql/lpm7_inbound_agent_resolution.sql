-- AIDA — inbound agent resolution guards (M7F-B1)
--
-- REVIEW ONLY. NOT APPLIED. See docs/RETELL_SQL_APPLICATION_CHECKLIST.md.
--
-- ─── WHY THIS EXISTS ────────────────────────────────────────────────
-- The inbound webhook resolves a ringing call to a tenant using one fact:
-- the Retell agent_id. That lookup runs against provider_resources in the
-- REVERSE direction to every other query in the product, and the existing
-- schema does not support it.
--
-- 1. THERE IS NO INDEX ON provider_resource_id.
--    pr_client_idx is (client_id, created_at) and pr_plan_idx is
--    (provisioning_plan_id). A lookup by provider_resource_id is a sequential
--    scan — in front of a ringing phone, inside a 10-second budget, after which
--    Retell retries three times and then disconnects the caller.
--
-- 2. THERE IS NO CONSTRAINT PREVENTING ONE AGENT FROM MAPPING TO TWO TENANTS.
--    pr_one_active_per_purpose is unique on
--    (client_id, provider, purpose, resource_type) WHERE active. That
--    guarantees ONE ACTIVE AGENT PER CLIENT. It says nothing about one client
--    per agent, so a data error, a botched restore or a hand-written row could
--    put the same Retell agent under two tenants and the database would accept
--    it.
--
--    The application already refuses an ambiguous mapping — services/
--    retell-inbound-resolver.js returns `ambiguous_agent` and emits no
--    variables — so this migration is defence in depth, not the only guard.
--    But "one locksmith's caller is offered another locksmith's transfer
--    number" is the worst outcome in the product, and it deserves an invariant
--    the database also believes.
--
-- ─── BEFORE APPLYING ────────────────────────────────────────────────
-- The unique index below WILL FAIL if duplicates already exist. That failure is
-- the point: it is a report, not an obstacle. Run the detection query in the
-- checklist first and resolve any duplicate deliberately, by superseding the
-- wrong row, before creating the index.
--
-- Idempotent, non-destructive, and reversible by dropping both indexes.

-- ── 1. Make the reverse lookup fast ─────────────────────────────────
-- Partial: only active rows are ever resolved against, and the inactive history
-- is read only by operator tooling where a scan is acceptable.
create index if not exists pr_provider_resource_lookup
  on public.provider_resources (provider, provider_resource_id)
  where active = true;

comment on index public.pr_provider_resource_lookup is
  'Inbound resolution: agent_id -> client. Runs before a caller is answered, so it must not be a sequential scan.';

-- ── 2. Make a cross-tenant collision impossible ─────────────────────
-- At most ONE ACTIVE ROW per (provider, provider_resource_id), across all
-- tenants. This is the mirror of pr_one_active_per_purpose: that one stops one
-- client having two agents, this one stops one agent having two clients.
--
-- NOTE ON SCOPE: AIDA provisions a separate Retell agent per purpose (a
-- receptionist agent and an onboarding agent are different resources with
-- different ids), so "one active row per provider resource id" matches how the
-- product actually behaves. If that ever changes — one Retell agent deliberately
-- serving two purposes for one client — this index must be revisited rather
-- than dropped, because the tenant-collision guarantee is the valuable half.
create unique index if not exists pr_one_client_per_active_resource
  on public.provider_resources (provider, provider_resource_id)
  where active = true;

comment on index public.pr_one_client_per_active_resource is
  'At most one active registry row per provider resource id, across ALL tenants. Stops one Retell agent resolving to two clients — the failure that would route an emergency to a stranger.';
