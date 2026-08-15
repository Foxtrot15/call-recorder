-- ===========================================================================
-- 18 - LPM4 VERIFIER, COMPACT. READ-ONLY. One statement, ~400 characters.
--
-- WHY A THIRD VERIFIER. Files 16 and 17 are correct and both failed to reach
-- the database intact. 16 returned only its last result set, because the
-- Supabase editor shows only the last statement of a batch. 17 was one
-- statement but 6.6KB, and the paste corrupted twice, each time reporting a
-- syntax error at LINE 1 on a fragment that began mid-statement.
--
-- The file was never the problem: no control characters, no CRLF, longest line
-- 109, balanced quotes and parens, one statement. The problem is that a large
-- block of SQL travelling through a chat window and a browser editor is a
-- fragile transport, and the correct response to a fragile transport is to
-- send less through it.
--
-- So this asks for the raw material instead of computing verdicts in SQL.
-- pg_get_constraintdef returns the whole definition; every value can be read
-- off it directly. Short enough to survive, and it answers more than the long
-- version did.
--
-- ASCII only. No apostrophe outside a string literal. No semicolon inside one.
-- ===========================================================================

select 'constraint' as kind, conname::text as name, pg_get_constraintdef(oid) as detail
from pg_constraint where conrelid = 'public.provider_resources'::regclass
union all
select 'index', indexname::text, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'provider_resources'
union all
select 'rowcount', 'provider_resources', count(*)::text from public.provider_resources;
