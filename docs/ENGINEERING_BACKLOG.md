# Engineering Backlog

_Prioritised proposals from a read-only audit of `src/`, `public/`, `smoke/`, and
`package.json`. **No runtime code was changed** — every item is a proposal for
approval. Findings were confirmed with file:line references; I've applied my own
prioritisation and flagged confidence where a claim needs a quick human check._

Related: [../PHASE_5_PLAN.md](../PHASE_5_PLAN.md) (owns several of these already —
noted per item), [../SECURITY_REVIEW.md](../SECURITY_REVIEW.md) (owns the security
risk register), [ARCHITECTURE.md](ARCHITECTURE.md).

Priority: **P0** ship before the next client/deploy · **P1** near-term
(correctness/trust) · **P2** maintainability · **P3** tooling/tests/scale.

---

## P0 — cheap, high-risk, do first

| # | Item | Where | Why it's P0 | Effort |
|---|---|---|---|---|
| P0-1 | **No `.gitignore` in the repo** | repo root | `.env` is untracked only by luck; one `git add .` commits secrets (Supabase service key, Twilio token, session/encryption secrets). | Trivial |
| P0-2 | **`ENCRYPTION_KEY` fails open, not closed** | `services/token.js:5` | If unset, the AES key silently becomes 32 spaces — OAuth tokens encrypted under a trivially-guessable key. Everywhere else (e.g. `SESSION_SECRET`) fails closed. Also flagged in SECURITY_REVIEW #3. | Small (throw at startup if unset/≠32 bytes) |

Both are one-line-ish changes with outsized risk reduction. P0-2 overlaps
PHASE_5_PLAN item 6; P0-1 is new.

## P1 — correctness & user trust

| # | Item | Where | Why it matters | Confidence |
|---|---|---|---|---|
| P1-1 | **Business Profile page saves nowhere** | `public/index.html:1614` posts to `/profile`; no such route exists | The operator-entered business name/tone/sign-off silently 404s (`.catch(()=>{})`) and lives only in localStorage; the AI emails use the *auto-generated* `business_profiles` table instead. Looks like a working feature; isn't. | High — verified no `/profile` route exists |
| P1-2 | **Onboarding form captures nothing server-side** | `public/onboarding.html:832` | Submissions save to localStorage + console only; the "we'll be in touch within 24 hours" screen has no backend capture — leads are lost. | High |
| P1-3 | **`crm_notes` never saved** | `index.html` CRM card refs `crm-notes-${id}` that the template never renders (`renderCRMReview`) | The notes field the PATCH sends is always null; "suggested action" clicks no-op. | Medium — worth a 2-min UI check |
| P1-4 | **`/test/inject-batch` is dead *and* broken** | `routes/test.js:209` | Self-`fetch`es its own gated endpoint without the session cookie → 401, but never checks `injRes.ok` and reports `{success:true}` regardless. Harmless while unused; a trap if someone wires it up. | High |
| P1-5 | **Core pipeline has no retry / dead-letter** | `routes/recording.js:23-354` | The transcribe→analyse→draft→calendar→notify chain runs once, in-process; a transient Deepgram/Claude/Gmail outage drops that lead permanently (`status:"error"`, no retry). It *does* ack Twilio immediately (good — no retry storm), but the work itself has no resilience. | High — this is the core value path |

P1-1/P1-2/P1-3 are "looks-built-but-isn't" gaps — highest trust risk. Decide per
item: implement the backend, or remove the UI so it doesn't imply a feature.

## P2 — maintainability (duplication & fragility)

| # | Item | Where | Proposal |
|---|---|---|---|
| P2-1 | **Triplicated OAuth token refresh** | identical `refreshAccessToken` + refresh-and-store in `gmail.js:4`, `gcal.js:4`, `notify.js:4` | Extract one `getAccessToken(clientId, provider)` (in `token.js` or a `google-auth.js`); all three call it. A revoked-token fix applied to one copy and missed in the others is the exact hazard. |
| P2-2 | **Duplicated Claude email-drafting block** | `routes/recording.js:265-320` vs `routes/test.js:114-171` | Extract `services/followup.js` (`draftFollowUpEmail`, `maybeCreateCalendarEvent`). Prompts have **already drifted** between the two, so `/test/inject` no longer tests real behaviour. |
| P2-3 | **`notify.js` re-implements Gmail send** | `notify.js:36-63` duplicates `gmail.js` `buildRaw`+`sendEmail` | Have `notify.js` call `gmail.js` once P2-1 unifies token refresh. |
| P2-4 | **Contact double-fetch + no upsert (race)** | `contacts.js:4-24, 46-51` | `getOrCreateContact` (select-then-insert) then `updateContactFromCall` re-selects the same row; two round-trips and a concurrency window that can create two contact rows per phone. Use `upsert(..., {onConflict:'client_id,phone'})` (as `personal_contacts` already does) and pass the fetched row through. |
| P2-5 | **Per-client `real_number` not used** | `recording.js:73` | `client_real_number` actually stores Twilio's unreliable `ForwardedFrom`, and `CLIENT_REAL` reads a global env var — multi-tenant attribution silently works only because there's one client. Source it from the `clients` row (already selected in `clients.js`). |
| P2-6 | **`module.exports` before definition** | `middleware/auth.js:93` vs `:102` | Works via function hoisting; a refactor to an arrow fn breaks exports silently. Move exports to the bottom. |
| P2-7 | **Transitional tenant filter** | `calls.js:13-20` | Cross-tenant read path (`clientId OR 'default' OR NULL`) until the Phase 5 backfill ships. Already tracked (PHASE_5 item 1-2); collapse to `.eq()` after backfill. |

## P3 — tooling, tests, scale

**Tooling** (mostly process gaps):
- **CI** — none (`.github/workflows` absent). At minimum run `npm run smoke:preflight` + `npm run smoke` against staging on PR. *(High process value.)*
- **`.env.example`** — none; `smoke/lib/env.js` already enumerates the full var list to seed it.
- **Linter/formatter** — no ESLint/Prettier or `lint` script.
- **`engines` field** — pin `"node": ">=18"` (code relies on global `fetch`/`node:test`).
- **`npm test` alias** — add `"test": "npm run smoke"` so the conventional command works.

**Missing tests** (no unit tests exist at all; only the black-box smoke suite):
- Highest value: `analyse.js` JSON-parse fallback chain (`analyse.js:85-96`); `token.js` encrypt/decrypt round-trip; `gcal.js` date parsing (`nextDayOfWeek`/`parseMonthDay`/`parseEventDate` — ad-hoc dd/mm vs mm/dd, "July 14", ISO).
- The webhook pipeline (`inbound.js`/`recording.js`) has zero automated coverage — deferred to the manual checklist. A staging-DB integration test is the real fix (pairs with P1-5's queue refactor).

**Scalability**:
- `business-profile.js:22` runs a scoped `count` on `calls` on *every* completed call just to check a threshold — cache a counter instead.
- `contacts.js:71` fires a *second* Claude call (rolling summary) per repeat caller, inside the synchronous webhook chain — throttle like the profile cadence.
- `calls.js` list has no cursor pagination (fine now; degrades past a few hundred calls/client).

## Dead code (cheap cleanup, low individual risk)

Confirmed zero references via full-tree grep:
- `services/sms.js` (whole file) — also PHASE_5 item 8.
- `gmail.js:89` `getAuthClient` (+ transitively `sendEmail`).
- `personal-filter.js:61` `looksPersonalFromAnalysis`.
- `business-profile.js:154` `buildExtractionPrompt` (and `analyse.js` re-implements it inline — drifted).
- `routes/outbound.js` — legacy UK bridge; confirm no live Twilio number points at `/outbound/voice`, then delete (PHASE_5 item 8). ⚠️ If it *is* live, it lacks the toll-fraud allow-list `inbound.js` has (`outbound.js` dials whatever `normaliseUK` returns) — that would upgrade it from cleanup to a **P1 security item**.

---

## Ranked top 10 (my prioritisation)

1. **`ENCRYPTION_KEY` fail-closed** (P0-2) — silent token compromise on misconfig.
2. **`.gitignore`** (P0-1) — secrets-leak prevention.
3. **Pipeline retry/queue** (P1-5) — the core value path drops leads on any transient outage.
4. **Business Profile & onboarding save nowhere** (P1-1, P1-2) — lost leads + features that only look built.
5. **CI + smoke on PR** (P3 tooling) — stops regressions shipping unseen.
6. **Triplicated token refresh** (P2-1) — a correctness/security fix will be applied to one copy and missed in others.
7. **Duplicated drafting block** (P2-2) — `/test/inject` no longer reflects production.
8. **Contact upsert race** (P2-4) — silent CRM data duplication.
9. **Confirm & remove `outbound.js`** (dead code) — or make it a P1 security item if live.
10. **Unit tests for `analyse`/`token`/date parsing** (P3) — the fragile, silent-failure code.

## Cross-references to existing plans

| Already owned by | Items |
|---|---|
| PHASE_5_PLAN.md | ENCRYPTION_KEY fail-closed (#6), backfill + transitional filter (#1-2), dead `sms.js`/`outbound.js` (#8), rate limiting (#4), session refresh (#5) |
| SECURITY_REVIEW.md | ENCRYPTION_KEY (#3), rate limiting (#2), session expiry (#4) — recommend adding `.gitignore` and the `outbound.js`-if-live note there |

_These are proposals. Implementing any of them is a separate, approved task — this
document changes no runtime code._
