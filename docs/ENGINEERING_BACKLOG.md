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

> ### ✅ Completed on branch `hardening/p0-autonomous`
> - **P0-1** `.gitignore` added.
> - **P0-2** `ENCRYPTION_KEY` fail-closed + startup config validation
>   (`src/config/startup-check.js`). ⚠️ **Deploy precondition:** `ENCRYPTION_KEY`
>   must be set (≥32 chars) in Railway or the app now refuses to start; if it was
>   previously unset, affected clients must reconnect Google.
> - **P3 tooling:** `.env.example`, `engines` pin, `npm test`, CI workflow.
> - **P3 tests:** unit tests for invite tokens + startup validation (12/12).
> - **Docs:** README rewritten; `outbound.js` investigated (below); doc linkcheck clean.
>
> Everything below remains open (proposals only — no runtime change made to them).

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
| P1-6 | **Personal-contacts feature silently broken — table doesn't exist** | `services/personal-filter.js` + `routes/personal-contacts.js` + `recording.js:143` + `index.html:1226` | The `public.personal_contacts` table was never created (proven by RLS apply error 42P01), and the service discards every Supabase error — so the UI's privacy promise ("Aida won't record future calls from this number") is confirmed with `{success:true}` while nothing is saved, and flagged callers are still recorded/transcribed/emailed. See the dedicated investigation below. | High — proven by DB error |

P1-1/P1-2/P1-3/P1-6 are "looks-built-but-isn't" gaps — highest trust risk (P1-6
especially: it's a *privacy* promise). Decide per item: implement the backend,
or remove the UI so it doesn't imply a feature.

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
- `routes/outbound.js` — legacy UK bridge; see the dedicated investigation below.

---

## Investigation: Twilio outbound calls & `routes/outbound.js`

_Full-repo trace of every Twilio outbound-call creation site and every
`/outbound` reference. Read-only; no runtime change. Evidence is file:line so it
can be re-verified. No files deleted._

### A. Every place a Twilio outbound call / leg is created

There are three distinct mechanisms; only the first *originates* a call via the
REST API. The rest are TwiML `<Dial>` legs bridged during an existing inbound
webhook call.

| # | Site | Mechanism | Trigger / gate | Status |
|---|---|---|---|---|
| 1 | `routes/call.js:19` `client.calls.create({...})` | **REST API origination** — the only place the app *places* a new outbound call. Dials `CLIENT_REAL_NUMBER`, then bridges to the destination via inline TwiML `<Dial record>` (`call.js:22-29`). | Operator dashboard, `POST /call/initiate` behind `requireLogin`. | **Live, used.** |
| 2 | `routes/inbound.js:159-165` `twiml.dial(...).number(e164)` | **TwiML bridge leg** — the AU outbound bridge for the business owner: `/inbound/voice` `isYou` branch gathers digits (`inbound.js:45-51`) → `/inbound/connect` dials out with an **AU-only allow-list guard** (`inbound.js:144-153`). | Owner calls the Twilio number; `POST /inbound/connect`. | **Live, used** — this is the real outbound bridge. |
| 3 | `routes/outbound.js:67-74` `twiml.dial(...).number(e164)` | **TwiML bridge leg (duplicate)** — a second, UK-hardcoded bridge (`normaliseUK`, `en-GB`), no client resolution, **no destination allow-list**. | `POST /outbound/voice` → `/outbound/connect`. | **Orphaned** — see B/C. |
| 4 | `routes/call.js:22-29` inline `<Dial record>` TwiML | The `<Dial>` leg *inside* mechanism #1's REST call. | Same as #1. | **Live, used.** |
| — | `services/sms.js:8` `client.messages.create()` | SMS (not a call); dead file, zero imports (confirmed). | none | Dead (listed above). |
| — | `routes/recording.js:55` `client.calls(CallSid).fetch()` | A **read** (fetch call metadata), not an origination. | pipeline | n/a |

### B. Does any runtime code use `/outbound/voice`? — **No.**

Definitive from the repo. Every reference to `/outbound`:

| Reference | Meaning |
|---|---|
| `server.js:33` `app.use("/outbound", twilioWebhook, require("./routes/outbound"))` | The **only** wiring — mounts the router, making the endpoint exist/reachable. |
| `outbound.js:16` (comment), `outbound.js:30` `action:"/outbound/connect"` | The route referencing **itself**. |
| `public/index.html` `direction === 'outbound'`, `.badge-outbound` | Call-**direction labels** in the dashboard — unrelated to the route. |

No dashboard, onboarding page, `client.calls.create` `url`/`twiml`, or other
route sends any caller or Twilio number to `/outbound/voice`. The one thing that
*could* invoke it — a Twilio phone number whose voice webhook is set to
`<BASE_URL>/outbound/voice` — is **console-only configuration, not in the repo.**

### C. Classification

> **Legacy — conditional on one external check.** The repo half of the test is
> satisfied: **no runtime code references `/outbound/voice`.** If the production
> number's voice webhook points only at `/inbound/voice` (Twilio console), then
> `outbound.js` is unambiguously legacy dead weight. It cannot be declared
> *unquestionably* dead from the repo alone because that webhook mapping lives in
> the Twilio console.

It is a superseded UK-era duplicate of the AU bridge that now lives in
`inbound.js` (mechanism #2). It also lacks the toll-fraud allow-list that
`inbound.js/connect` enforces (#2 vs #3), so *if* it is reachable via a live
number, that gap is a real exposure (Twilio-signature-gated, so not open to the
public internet, but a caller controlling DTMF could bridge to arbitrary
premium/international numbers).

### D. Recommendation — retain / replace / remove (needs approval; touches Twilio routing)

1. **One external check first:** in the Twilio console, inspect every number's
   voice webhook. Confirm whether any points at `/outbound/voice`.
2. **If none (expected):** **Remove** in a future cleanup — delete
   `routes/outbound.js` and the `server.js:33` mount. Low risk once the console
   check confirms no number targets it. (Do not remove before that check.)
3. **If a number does point at it:** do **not** just delete — first **replace**:
   repoint that number's webhook to `/inbound/voice` (which handles the owner
   bridge correctly, with the allow-list and client resolution), then remove
   `outbound.js`. Until repointed, add the AU allow-list to `outbound.js`'s
   `/connect` as an interim toll-fraud guard — that interim step becomes a **P1
   security item**.
4. **Retain** is not recommended in any case — keeping a second, guard-less,
   UK-hardcoded bridge is a standing liability with no offsetting benefit.

**Net:** the safe default is **remove after the console check**; the only reason
to touch it sooner is if the check finds it live, which flips it to a security fix.

---

## Investigation: `services/personal-filter.js` — live, dead, or broken?

_Requested finding, triggered by the Phase 2 RLS apply failing with
`42P01: relation "public.personal_contacts" does not exist`. Every consumer
traced with file:line evidence. Read-only; no runtime change; no SQL run._

**Verdict: live-but-silently-broken.** The feature is fully wired at every
layer — UI, route, production pipeline — but its table was never created, and
because the service discards every Supabase error, it fails silently at all
four call sites. This is the **inverse of `outbound.js`** (mounted but
orphaned): here everything points at it, and only the storage is missing.

### A. It is fully wired (not dead code)

| Layer | Evidence |
|---|---|
| Server mount | `server.js:39` — `app.use("/personal-contacts", requireLogin, require("./routes/personal-contacts"))` |
| Routes | `routes/personal-contacts.js` — `/add`, `/remove`, `/list`, tenant-scoped via `req.clientId` |
| Production pipeline | `recording.js:10,143` — `isPersonalCall(CLIENT_ID, From)` runs for **every inbound recording**, gating all automation |
| Dashboard UI | `index.html:1226-1232` — `flagAsPersonal()` posts to `/personal-contacts/add` and tells the user *“Aida won't record future calls from this number.”* |

One exception: `looksPersonalFromAnalysis` (`personal-filter.js:61`) is
exported but imported **nowhere** — that single function is dead code (already
listed under Dead code above).

### B. The table doesn't exist — and why the failure is invisible

The RLS transaction abort (42P01) proves `public.personal_contacts` is absent
from the live database, and no `CREATE TABLE` for it exists anywhere in the
repo (there are no schema migrations for the base tables at all — doc-audit
gap G3).

supabase-js does **not throw** on query errors; it returns `{ data, error }`.
`personal-filter.js` destructures only `data` and ignores `error` in all four
functions, so:

| Call site | What actually happens today |
|---|---|
| `isPersonalCall` (`recording.js:143`) | Returns `false` for every call. The `try/catch` and the `⚠️ Personal contact check failed` log at `recording.js:145` **never fire** — no throw means no log. Fail-open, invisibly. |
| `addPersonalContact` (`/add`) | Upsert error discarded → route replies `{ success: true }` while saving **nothing**. The dashboard confirms success to the user. |
| `removePersonalContact` (`/remove`) | Same — silent no-op reporting success. |
| `getPersonalContacts` (`/list`) | Returns `[]` — indistinguishable from “no personal contacts yet.” |

### C. Why this is P1, not cleanup

The UI makes an explicit privacy promise and the pipeline comment
(`recording.js:137-139`) states the intent: stop family/friends' calls
generating business follow-up. In reality every call from a “flagged” number
is still **recorded, transcribed, sent to Claude, saved to the CRM, and turned
into follow-up email** — while the owner believes otherwise, because `/add`
reported success. Filed as **P1-6** above.

### D. Recommendation — create the missing table (needs approval: SQL)

The smallest fix needs **zero code change**: create the table and the feature
works exactly as written. A reviewed, **not-applied** script is provided at
[`../supabase/sql/create_personal_contacts.sql`](../supabase/sql/create_personal_contacts.sql).
It encodes three non-negotiables:

1. **Unique constraint on `(client_id, phone)`** — mandatory: `addPersonalContact`
   upserts with `onConflict: "client_id,phone"`, which errors (42P10) without it.
2. **`enable row level security` in the same transaction** — this table was
   skipped by the Phase 2 apply (didn't exist); it must not be born as the one
   unprotected table.
3. The exact columns the code touches: `id`, `client_id`, `phone`, `label`,
   `created_at` (ordered on by `/list`).

Code follow-ups:
- ✅ **Applied (this branch): stop discarding errors** in `personal-filter.js`
  — all four functions now throw on unexpected Supabase errors (`PGRST116`
  no-row excluded for the lookup), so `/add`/`/remove` return 500 instead of
  false success, `/list` can't pass an error off as an empty list, and the
  pipeline's existing catch at `recording.js:145` finally logs the failure.
  This is the change that would have surfaced the missing table months ago.
- Delete or wire up `looksPersonalFromAnalysis` (separate approval).
- Normalise `phone` with the same E.164 logic as owner recognition (currently
  only strips spaces; works today because both sides originate from Twilio's
  E.164 `From`, but breaks the moment someone types a local-format number).

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
