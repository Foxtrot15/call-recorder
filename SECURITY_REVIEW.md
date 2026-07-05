# Aida — Security Review

_Reviewed at commit `1cdeaaa` (2026-07-05). Scope: authentication, tenant isolation, database exposure. Reviewer: architectural review session, Phases 1–4 + /calls API._

## Root cause summary

The login failures, the disabled RLS, and the `"default"` clientId sprawl were **one architectural problem**: tenant identity was never a first-class, server-derived concept, and a single shared service-role Supabase client doubled as a user-authentication client. Calling `auth.signUp`/`signInWithPassword` on that singleton silently replaced its service-role credentials with the logged-in user's JWT for **all** subsequent server queries — which is why RLS "had to be" disabled, and why auth behaved nondeterministically (state depended on whether anyone had logged in since the last restart).

A second, initially hidden driver: `public/index.html` embedded the Supabase **anon key** and read/wrote the `calls` table directly from the browser. Disabling RLS was load-bearing for that path too.

## Fixed (in commit `1cdeaaa`)

| # | Issue | Fix |
|---|---|---|
| 1 | Shared service client contaminated by user logins | Admin client created with `persistSession:false, autoRefreshToken:false`; login moved to a per-call throwaway client; signup moved to stateless `auth.admin.createUser` |
| 2 | New users created unconfirmed with no confirmation flow → could never log in | `admin.createUser({ email_confirm: true })` |
| 3 | Signup link step silently matched zero rows → "login works but 403" | Pre-check of the `clients` row, `IS NULL`-guarded update verified to touch exactly one row, Auth-user rollback on failure |
| 4 | Public signup bound any email to any tenant slug (account takeover of unclaimed tenants) | Invite-token gating: HMAC-SHA256, 72h TTL, timing-safe compare, fail-closed without `SESSION_SECRET`; minting requires operator login; single-use via the link guard |
| 5 | Operator routes trusted `clientId` from body/query (cross-tenant read/write, incl. `/auth/disconnect` deleting any tenant's Google connection) | `req.clientId` resolved server-side from `OPERATOR_CLIENT_ID` in `requireLogin`; all body/query `clientId` reads removed from operator routes |
| 6 | `/auth/google` OAuth initiation was public and accepted arbitrary `clientId` | Now behind `requireLogin`; OAuth `state` seeded only from `req.clientId` |
| 7 | Anon key embedded in `index.html`; browser had full read/write on `calls` via PostgREST | Server-side `/calls` API (list + field-whitelisted PATCH) behind operator session; anon key and `supabaseFetch` removed from all browser code |

## Open risks (ranked)

1. **RLS is still disabled** (SQL generated, not applied). Until applied, the previously-shipped anon key — public knowledge to anyone who ever loaded the old dashboard — still grants full PostgREST read/write on all tables. **Applying `supabase/sql/phase2_enable_rls.sql` after the deploy smoke test is the single highest-value remaining action.** Prereq (no browser DB access) is now met.
2. **No rate limiting** on `/login` (single shared password!), `/client-auth/login`, or `/client-auth/signup`. Brute force and email enumeration (Supabase error strings pass through) are unthrottled. Phase 5 item.
3. **`ENCRYPTION_KEY` weak-key footgun** (`services/token.js`): if unset, the AES-256-GCM key silently becomes 32 spaces. Tokens encrypt "successfully" with a known key. Should fail closed like `SESSION_SECRET` does. Verify the var is set in Railway today.
4. **Client sessions die after ~1h**: the Supabase refresh token is discarded at login; the 7-day cookie outlives the access token inside it. UX/availability issue, not a breach vector. Phase 5 item.
5. **Operator auth is one shared password** with no user identity, no rotation story, no audit trail. Acceptable single-operator pilot posture; revisit before adding staff.
6. **Invite tokens are bearer instruments**, not email-bound. Whoever holds one claims the slug (within 72h, once). Distribute over a private channel.
7. **`OPERATOR_CLIENT_ID` is unvalidated** against the `clients` table (startup validation designed but deferred under the runtime-code freeze). A typo silently splits reads/writes across two slugs.
8. **`/test/inject`** runs the full analysis/draft/notification pipeline on arbitrary input and accepts any `clientId`. Operator-gated, but consider disabling in production once testing settles.

## Accepted / by design

- Voicemail greetings live at public storage URLs — required, Twilio `<Play>` fetches unauthenticated. Filenames are non-enumerable (`voicemail-<slug>-<timestamp>.mp3`). Bucket policy is separate from table RLS.
- Server uses the service-role key for all DB access with app-layer tenant scoping; RLS (once applied) is defense-in-depth, not the primary control.
- `outbound.js` (parallel UK-hardcoded bridge, no tenant attribution) and `sms.js` (dead code) are known cruft, deletion deferred by instruction.

## Post-RLS hardening (optional)

Rotating the leaked anon key requires rotating the project JWT secret, which **also invalidates `SUPABASE_SERVICE_KEY`** — coordinate the Railway update in the same window. RLS alone already renders the old anon key useless against tables.
