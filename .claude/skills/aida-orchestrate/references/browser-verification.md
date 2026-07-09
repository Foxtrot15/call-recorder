# Browser verification — first-class phase for web-visible changes

Peter manually verifies **after** browser verification has already passed —
his time is the most expensive resource in the loop. A change to web-visible
behaviour is not "done" because tests pass; it is done when a browser agent
has driven the affected workflow and returned clean evidence.

## When it applies

Required whenever web-visible behaviour changes on:

- operator dashboard (calls list, call detail, status/instruction edits)
- CRM / contacts (verify, dismiss, notes)
- settings (pipeline toggle)
- voicemail settings (greeting status/upload)
- web authentication (operator login, client login, session persistence)
- call history views
- business profile
- onboarding pages
- client dashboard (contacts)
- any other workflow a browser can reach

**Do NOT browser-test:**

- SQL migrations / `supabase/sql` files
- backend-only refactors with no UI-visible surface
- RLS internals
- auth internals with no UI flow (e.g. bearer-mode middleware — curl/unit
  territory; but the *login page* IS a UI flow)
- documentation-only changes
- pure unit-test work
- native React Native call behaviour — never browser-testable, see
  [react-native.md](react-native.md)

If the change is web-visible but no browser tooling or runnable target exists
in the session, say so explicitly in the report — a skipped verification is
reported as skipped, never implied as passed.

## Target & credentials

- **Local (preferred):** `npm install` (one-time — the repo convention keeps
  node_modules absent), a populated `.env`, then `npm run dev` →
  `http://localhost:3000`. If `.env` is missing values, ask Peter — never
  invent or hardcode credentials.
- **Configured test URL:** `SMOKE_BASE_URL` if a staging instance exists.
- **Production:** read-only checks only (the same discipline as the smoke
  suite — no PATCHes, no uploads, no signups), and only when Peter asks.
- **Credentials:** operator = `DASHBOARD_PASSWORD`; client =
  `SMOKE_CLIENT_EMAIL` / `SMOKE_CLIENT_PASSWORD`. Read from env at use time.
  **Never echo credentials into output, reports, or screenshots.**

## The verification checklist (every run)

1. Launch the target; hard-reload before judging any state.
2. Log in with the safe test credentials (the mode the change affects:
   operator, client, or both).
3. Navigate the affected workflow end-to-end — click, don't just read markup.
4. Verify **UI behaviour** against the spec (what should now happen, what
   "broken" would look like — the spec must say both).
5. Verify **API behaviour**: watch the network panel; assert the expected
   requests fire with the expected status codes; no unexpected 4xx/5xx.
6. Verify **persistence**: refresh the page; the changed state must survive.
7. Verify the **browser console** has no new/unexpected errors.
8. Exercise a **negative branch**, not just the happy path (bad input, empty
   state, logged-out access).
9. **Capture screenshots** of each verified state.
10. Compare observed behaviour against the spec line by line.

## The fix loop (binding)

```
browser agent finds an issue
  → do NOT report completion to Peter
  → findings return to Fable (format below)
  → Fable diagnoses and fixes (or routes the fix per delegation.md)
  → browser verification runs AGAIN, full checklist
  → repeat until clean, or until a genuine blocker is found
      (blocker = needs Peter: credentials, prod-only data, a product decision)
```

Only a clean run — or an explicitly-stated blocker — ends the loop. "Probably
fine now" does not.

## Report format (agent → Fable)

Per verified item: **verdict (PASS/FAIL/BLOCKED)** + one-line observation +
screenshot reference. For failures: exact reproduction steps, the network
request/response involved (method, path, status), console errors verbatim,
and what the spec expected instead. End with a ≤5-step checklist Peter can
click through in under 5 minutes. Total ≤300 words + the checklist. No prose
padding — Fable reads this in its own context.

## Agent prompt template (model: sonnet)

```
You are the BROWSER VERIFIER for Aida (a call-capture SaaS dashboard). Drive
the running app in a browser and verify the changes below. Do the work
yourself; do not spawn agents.

TARGET: <http://localhost:3000 | SMOKE_BASE_URL value> (already running: <yes/no — if no, start it with npm run dev>)
LOGIN: operator = DASHBOARD_PASSWORD from .env; client = SMOKE_CLIENT_EMAIL /
SMOKE_CLIENT_PASSWORD. Read at use time; NEVER echo credentials or include
them in screenshots.
PRODUCTION RULE: if the target is not localhost, perform READ-ONLY checks only.

CHANGES TO VERIFY:
<per change: page/route, what should now happen, what "broken" would look like>

METHOD: hard-reload before judging; click through the workflow; watch network
requests + status codes; check console for new errors; refresh to prove
persistence; exercise one negative branch; screenshot each verified state.

Report per the format in browser-verification.md: verdict + evidence per item,
failure details with request/response and console output, then a ≤5-step
Peter checklist. ≤300 words + checklist.
```
