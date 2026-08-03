-- ============================================================================
-- M7K: notification delivery bookkeeping on locksmith_enquiries.
--
-- REVIEW ONLY — NOT APPLIED. No database was connected by the assistant.
--
-- ─── WHY `sending` IS ADDED ────────────────────────────────────────────────
-- The M7J table allowed pending / not_required / sent / failed. That is enough
-- to RECORD an outcome and not enough to PREVENT a double send.
--
-- The guard is a claim: one statement moves a row from 'pending' to 'sending'
-- and reports how many rows it changed. Exactly one caller can win that, so
-- exactly one caller sends. Without an intermediate state, two concurrent tool
-- calls both read 'pending', both send, and the locksmith gets the same job
-- twice at 3am. Checking-then-sending is not a substitute: the gap between the
-- read and the write is the bug.
--
-- This is the "strongly justified" case the brief allows for. No other state is
-- added. `not_required` already existed and is kept.
--
-- ─── AUDIT COLUMNS ─────────────────────────────────────────────────────────
-- Attempt count, provider, provider reference and the last failure code, so
-- "what happened to that enquiry" is answerable from the row itself rather than
-- only from a log line that may have rotated. NO SECRET is stored: there is no
-- column for an auth token, an API key or a message body.
--
-- Additive and reversible. Existing rows keep 'pending' and are unaffected.
--
-- APPLICATION ORDER: after m7j_create_locksmith_enquiries.sql.
-- ============================================================================

-- ── 1. Allow the claim state ───────────────────────────────────────────────
alter table public.locksmith_enquiries
  drop constraint if exists locksmith_enquiries_notification_state_check;

alter table public.locksmith_enquiries
  add constraint locksmith_enquiries_notification_state_check
  check (notification_state in ('pending','sending','not_required','sent','failed'));

-- ── 2. Delivery bookkeeping ────────────────────────────────────────────────
alter table public.locksmith_enquiries
  add column if not exists notification_attempts   integer     not null default 0
    check (notification_attempts >= 0 and notification_attempts <= 100),
  add column if not exists notification_provider   text
    check (notification_provider is null or notification_provider in ('twilio_sms','dry_run')),
  add column if not exists notification_reference  text
    check (notification_reference is null or length(notification_reference) <= 200),
  add column if not exists notification_failed_at  timestamptz,
  add column if not exists last_notification_code  text
    check (last_notification_code is null or length(last_notification_code) <= 100);

-- ── 3. The sent/notified_at pairing still has to hold ──────────────────────
-- Unchanged in meaning: only 'sent' may carry a notified_at, and it must.
-- Re-stated because the state list it implicitly depends on has widened.
alter table public.locksmith_enquiries
  drop constraint if exists le_notified_consistency;

alter table public.locksmith_enquiries
  add constraint le_notified_consistency check (
    (notification_state = 'sent' and notified_at is not null)
    or (notification_state <> 'sent' and notified_at is null)
  );

-- A failure must record when it failed; anything else must not claim one.
alter table public.locksmith_enquiries
  add constraint le_failed_consistency check (
    (notification_state = 'failed' and notification_failed_at is not null)
    or (notification_state <> 'failed' and notification_failed_at is null)
  );

-- Rows still waiting to be delivered, for an operator and for the future
-- retry milestone. Partial: the index stays small no matter how many enquiries
-- accumulate, because only the unfinished ones are in it.
create index if not exists le_notification_pending_idx
  on public.locksmith_enquiries (client_id, environment, created_at)
  where notification_state in ('pending','sending','failed');

comment on column public.locksmith_enquiries.notification_state is
  'pending -> sending -> sent|failed. The pending->sending claim is the double-send guard: exactly one caller can win it. not_required is for enquiries that deliberately notify nobody.';
comment on column public.locksmith_enquiries.notification_attempts is
  'Incremented on each claim. A retry milestone reads this; M7K never retries.';
comment on column public.locksmith_enquiries.notification_reference is
  'The provider message id, or a dry-run marker. Never a token, key or message body.';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--
-- -- 1. The widened state list.
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.locksmith_enquiries'::regclass
--    and conname like '%notification_state%';
--
-- -- 2. The new columns.
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_name = 'locksmith_enquiries'
--    and column_name like 'notification%' or column_name = 'last_notification_code'
--  order by column_name;
--
-- -- 3. Existing rows are untouched and still pending.
-- select notification_state, count(*) from public.locksmith_enquiries group by 1;
--
-- -- 4. The claim is genuinely exclusive (safe; rolls itself back).
-- begin;
--   -- Two identical claims; the SECOND must report 0 rows.
--   update public.locksmith_enquiries set notification_state = 'sending'
--    where id = (select id from public.locksmith_enquiries where notification_state = 'pending' limit 1)
--      and notification_state = 'pending';
--   -- ^ expect UPDATE 1
--   update public.locksmith_enquiries set notification_state = 'sending'
--    where id = (select id from public.locksmith_enquiries where notification_state = 'sending' limit 1)
--      and notification_state = 'pending';
--   -- ^ expect UPDATE 0
-- rollback;
--
-- -- 5. A 'sent' row without notified_at must be refused (must raise):
-- -- update public.locksmith_enquiries set notification_state = 'sent' where id = (select id from public.locksmith_enquiries limit 1);
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- alter table public.locksmith_enquiries drop constraint if exists le_failed_consistency;
-- drop index if exists public.le_notification_pending_idx;
-- alter table public.locksmith_enquiries
--   drop column if exists notification_attempts,
--   drop column if exists notification_provider,
--   drop column if exists notification_reference,
--   drop column if exists notification_failed_at,
--   drop column if exists last_notification_code;
-- alter table public.locksmith_enquiries
--   drop constraint if exists locksmith_enquiries_notification_state_check;
-- alter table public.locksmith_enquiries
--   add constraint locksmith_enquiries_notification_state_check
--   check (notification_state in ('pending','not_required','sent','failed'));
