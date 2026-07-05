# Aida — Phase 5 Plan

_Prerequisite state: commit `1cdeaaa` deployed, smoke test passed (DEPLOYMENT.md), RLS applied per `supabase/sql/RLS_APPLY_CHECKLIST.md`. Items are ordered; dependencies noted._

## 1. Data backfill: `'default'` → real tenant slug

**When:** only when moving off `OPERATOR_CLIENT_ID=default` (e.g. onboarding the operator's business as a real `clients` row, or onboarding a second tenant).
**How:** `supabase/sql/phase5_backfill_default.sql` (reviewed, parameterized, transactional — **not yet applied**). Must be executed in the same change window as flipping `OPERATOR_CLIENT_ID` in Railway, or dashboard reads and pipeline writes split across two slugs.
**Risk:** unique-constraint collisions if rows already exist under both slugs — the script aborts cleanly on violation; resolve duplicates manually and re-run.

## 2. Remove the transitional tenant filter in `src/routes/calls.js`

**Depends on:** item 1. Collapse `scopeToTenant()`'s `OR 'default' OR NULL` to a plain `.eq("client_id", req.clientId)` in both GET and PATCH. Two-line change; until then legacy rows stay visible, which is intentional.

## 3. `OPERATOR_CLIENT_ID` startup validation (`src/server.js`)

Warn-only while `default` remains legitimate: at boot, log an error if unset; log a warning if no `clients` row matches. Upgrade to fail-fast **after** item 1, when a real slug is required to exist. Designed and approved in principle; deferred under the runtime-code freeze.

## 4. Rate limiting (`express-rate-limit`)

`POST /login`, `/client-auth/login`, `/client-auth/signup`. Tight budgets (e.g. 10/15min per IP) — all three are human-frequency endpoints. Also normalise signup/login error messages to stop email enumeration. Small dependency addition; no route logic changes.

## 5. Client session refresh (`services/client-auth.js`, `middleware/auth.js`, `routes/client-auth.js`)

Store the Supabase refresh token (second httpOnly cookie); in `requireClientAuth`, refresh when the access token is expired/near expiry and re-issue cookies. Fixes the ~1-hour client-dashboard session death (refresh token is currently discarded at login). The most intricate remaining item — do it in isolation.

## 6. `ENCRYPTION_KEY` fail-closed (`services/token.js`)

Throw at module load if unset/short instead of silently padding spaces (mirrors the `SESSION_SECRET` pattern). One guard clause; verify the var is actually set in Railway **before** deploying the guard.

## 7. `test.js` tidy

Default `clientId` to `req.clientId` instead of `"default"`; keep the explicit body override (its purpose is testing arbitrary tenants). Consider an env flag to disable `/test` entirely in production.

## 8. Deferred deletions / consolidation

- `src/services/sms.js` — dead (zero imports). Delete.
- `src/routes/outbound.js` — superseded UK-hardcoded bridge; `inbound.js` owns the AU bridge path. Delete the route + `server.js` mount, and remove the corresponding Twilio number webhook if one still points at `/outbound/voice`. **Verify in Twilio console first.**
- README rewrite: still describes the original SMS-transcript MVP; env table and flow diagrams are stale.

## 9. Post-RLS hardening (optional)

Anon-key rotation = project JWT secret rotation = **service key rotates too**; update `SUPABASE_SERVICE_KEY` in Railway in the same window. Only worth scheduling deliberately.

## Explicitly out of scope for Phase 5

- Multi-client operator dashboard (client picker / per-tenant operator accounts) — next architectural step after Phase 5, not cleanup.
- Migrating operator auth onto Supabase Auth with roles — desirable long-term convergence; design before touching.
