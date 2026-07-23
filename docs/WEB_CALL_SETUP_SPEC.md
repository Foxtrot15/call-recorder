# WEB-CALL-SETUP-1 — guided phone-diversion setup (WCS)

_Milestone spec + build state. Created 2026-07-23 (WCS-1a). Owns: the
call-setup module contract, divert-code template semantics, and the setup
status machine. The manual onboarding procedure and human-facing forwarding
codes stay owned by [../CLIENT_ONBOARDING_RUNBOOK.md](../CLIENT_ONBOARDING_RUNBOOK.md)
(step 7); this milestone productises that step inside the client dashboard._

> **Build state (updated 2026-07-23):**
> **WCS-1a ✅ built** (commit `980a6ad`) — pure module + tests, imported by nothing.
> **WCS-1b-i ✅ built (uncommitted pending approval)** — review-only SQL files (**NOT applied**), routing-profile adapter (dormant, imported by nothing), additive validators.
> **WCS-1b-ii 📐 designed, not built** — flag config, client-auth routes, server mount.
> **WCS-1c 📐 designed, not built** — client-dashboard UI + browser verification.
> No SQL has been applied anywhere, no route exists, no UI has changed.

---

## 1. Purpose & product stance

Give a logged-in small-business client a guided path to set up **conditional**
call diversion (missed / busy / unreachable) from their existing mobile number
to their AIDA/Twilio number, then record how far they got — so Aida feels
installed and testable instead of arriving as a page of carrier codes.

Non-negotiable framing, encoded in `src/services/divert-codes.js`:

- Carrier codes are **recommended templates, not guaranteed truth**. Every
  generated payload carries the "try these codes first / carrier support may
  vary" disclaimer and a per-carrier confidence tier
  (`standard` | `varies` | `unknown`). Nothing in the product may say
  "guaranteed" (tested).
- **Desk phone / VoIP platforms never receive GSM codes** — diversion for
  those lives in the provider's own settings, so they get a `manual_help`
  result with no dial strings at all (tested).
- `user_claimed_done` and `test_passed` are **self-reported claims, not
  platform-verified facts** — the user telling us what happened on their
  handset. The UI and any reporting must label them that way. Automatic
  verification (a `calls` row arriving after a claim) is a designed future
  integration point, deliberately not built (no pipeline changes).

## 2. What exists today (WCS-1a + WCS-1b-i)

| Piece | Where | State |
|---|---|---|
| Template engine + registries + validation + status machine | `src/services/divert-codes.js` | ✅ pure, dep-free, **imported by nothing at runtime** (dormant by construction). WCS-1b-i added two additive validators: `validateProfileInputs` (profile fields without the target — saves must work pre-provisioning) and `validateOptionalAuNumber` (business_number); `validateSetupInputs` now delegates, behaviour unchanged |
| Routing-profile adapter | `src/services/routing-profile.js` | ✅ built, **imported by nothing** (dormant). Pure field-builders + thin lazy-supabase functions; upsert-on-`client_id` saves with reset semantics; optimistic-concurrency status updates; `getClientAidaNumber` is the module's ONLY touch of `clients` and is SELECT-only; no id-based access anywhere |
| Table DDL | `supabase/sql/wcs1b_create_client_phone_routing_profiles.sql` | ✅ review-only file, **NOT applied**. RLS same transaction, `unique(client_id)`, status check constraint |
| Dev addendum | `supabase/sql/dev/dev_add_twilio_number.sql` | ✅ review-only, dev project only, **NOT applied** (dev `clients` lacks `twilio_number`; seeds a fake number) |
| Regression tests (63 across the two WCS files) | `test/call-setup.test.js`, `test/routing-profile.test.js` | ✅ green; run without node_modules; heavy-dep hygiene tests in both |
| This spec + INDEX rows | `docs/` | ✅ |

The module reuses `normalisePhone` from `src/services/loop-guard.js` (the
exported pure copy; the shared `services/phone.js` dedup remains the known
follow-up flagged in that file's header).

### Module contract (source of truth is the code; this is the intent)

`buildDivertCodes({ targetNumber, carrier, phonePlatform, loops, noAnswerDelaySeconds })`
→ `{ ok: false, errors: [...] }` (all errors collected, not first-fail) or
`{ ok: true, result }` where `result.mode` is:

- **`gsm_codes`** — `activate[]` / `cancel[]` for the selected loops (stable
  order: no_answer, busy, unreachable), `cancelAll` (`##002#`, with a
  line-wide warning), carrier notes, dial hint, disclaimer, `templateVersion`.
- **`manual_help`** — desk/VoIP: reason + manual-help note + disclaimer,
  **no code fields at all**.

Templates (config-in-code, editable via normal review — deliberately **not**
a DB table until non-engineers need to edit them; the future profile row
snapshots the generated payload with `templateVersion` so what a user saw
survives template edits):

| Loop | Activate | Cancel |
|---|---|---|
| no_answer | `**61*{target}**{seconds}#` (`**{seconds}` segment omitted when delay = carrier default) | `##61#` |
| busy | `**67*{target}#` | `##67#` |
| unreachable | `**62*{target}#` | `##62#` |
| — cancel all — | | `##002#` |

Registries: carriers `telstra / optus / vodafone` (standard), `boost /
amaysim / aldi` (varies — MVNO/prepaid caveat), `other` (unknown); platforms
`iphone / samsung / pixel / other_android` (mobile), `desk_voip` (manual
path), `other` (unknown → still codes; diversion is a network feature).
No-answer delay: `15 | 20 | 25 | 30` seconds or `null` = carrier default
(default offering 20). A rendered template with any unresolved `{placeholder}`
**throws** — a broken template edit fails loudly, never emits a garbage code.

**`targetNumber` is the client's AIDA/Twilio number and must be derived
server-side (`clients.twilio_number`) by the WCS-1b route — never from user
input** — so Aida-branded instructions can't be pointed at an arbitrary
number. It must normalise to AU E.164 (`+61` + 9 digits).

### Status machine

Statuses: `not_started → instructions_generated → user_claimed_done →
test_passed`, plus `needs_help`. Pure `applyStatusAction(current, action)`:

| Action | Allowed from | → |
|---|---|---|
| `generate` | any status (regeneration is the universal recovery) | `instructions_generated` |
| `claim_done` | `instructions_generated` | `user_claimed_done` (self-reported) |
| `report_test_passed` | `user_claimed_done` | `test_passed` (self-reported) |
| `needs_help` | `instructions_generated`, `user_claimed_done`, `test_passed` | `needs_help` |
| `back_to_instructions` | `needs_help` | `instructions_generated` |
| `reset` | any status (profile edit invalidates generated codes) | `not_started` |

`needs_help` is not reachable from `not_started` (pre-generate help is a
support conversation, not a profile state).

## 3. Persistence semantics (fixed by WCS-1b-i) and WCS-1b-ii remaining scope

**Now-fixed persistence rules** (encoded in `routing-profile.js` and its tests):

- One profile per tenant: single-statement **upsert on `client_id`** — the
  caller passes `req.clientId` and nothing else; no id-based function exists
  and `toPublicProfile` never exposes the row id.
- **Every profile save resets**: snapshot (`generated_codes`,
  `target_number`), status (`not_started`), help note, and claim timestamps
  are cleared — edited inputs must never leave stale codes alive.
- **Generate snapshots the exact `buildDivertCodes` result** (incl.
  `templateVersion`) plus `target_number = result.target`; it also closes any
  open `needs_help` episode. Generate is last-write-wins (the machine's
  universal recovery), and never fabricates claim stamps.
- **Status updates are optimistic**: the UPDATE matches both `client_id` and
  the status the decision was made against; zero rows → conflict (route
  returns 409, client refetches). `claim_done` → `claimed_done_at`,
  `report_test_passed` → `test_passed_at` (both self-reported stamps);
  `needs_help` stores the note; leaving `needs_help` clears it.
- `getClientAidaNumber` (SELECT of `clients.twilio_number` only — the
  module's sole touch of `clients`) reports not-provisioned on any failure —
  fail closed, same philosophy as `devices.isClientVoipEnabled`.
- Until the SQL is applied, every table access throws a clear
  "not provisioned" error naming the SQL file (`devices.js` pattern).

**WCS-1b-ii — designed, NOT built (requires Peter's approval to start):**

- **Routes** `/call-setup/*` (GET/PUT profile, POST generate, POST status) via
  an injected-deps handler factory (`client-auth-handlers.js` pattern), each
  behind `requireClientAuth`, tenancy from `req.clientId` only; POSTs/PUT
  rate-limited (`services/rate-limit.js`, D11 pattern).
- **Flag** — strict-`"true"` `CALL_SETUP_ENABLED` with a `next("router")`
  gate (pattern: `src/config/voip.js:74`) as the router's first middleware,
  so flag-off is byte-identical to the routes not existing. One mount line in
  `server.js`; env var documented in `DEPLOYMENT.md` in the same commit;
  smoke run required (production-facing mount).

## 4. WCS-1c — designed, NOT built

Client-dashboard tab ("Phone setup") in `public/client-dashboard.html`:
status banner → details form (business number prefilled from
`req.client.real_number`, platform/carrier chips, loop toggles, delay picker)
→ generate → per-loop code blocks with copy + `tel:` links (as
`public/onboarding.html` step 5 already does) + collapsed cancel codes +
carrier-variance note → "I've dialled these" / "I need help" → test guidance
(runbook step 8) → self-reported "my test call showed up". Tab hidden when
the profile probe 404s (flag off). Desk/VoIP selections route to the
manual-help path instead of codes.

## 5. Out of scope for this milestone

All-calls divert (`*21*` — explicitly warned against in the runbook), carrier
verification (VoIP prerequisite **B3**'s SIM test will harden the registry),
automated phone-setting changes, live test-call automation, mobile app work,
M3C/M3D, recording/transcription pipeline changes, operator-dashboard surface,
and any change to `public/onboarding.html` (its hardcoded number/localStorage
gap is backlog **P1-2**; after WCS-1c it should point at this flow — separate
approval).

## 6. Risks / unknowns

- Code accuracy is **unverified by design** (no external research); the
  confidence tiers + disclaimer + editable templates are the containment.
- MVNO variance (Boost/Amaysim/Aldi) — enable-first caveat shipped in the
  registry notes; expect "needs_help" traffic from prepaid plans.
- Clients without a provisioned `twilio_number` must get a clear
  "not provisioned" failure (module already refuses; route wording is WCS-1b).
- Self-reported statuses can be wrong in both directions; the calls-table
  auto-verify slice is the honest fix later.

## 7. Verification record

**WCS-1a (2026-07-23):** `node --test test/call-setup.test.js` → 41/41 pass.
Full `npm test` → 194/194 pass. Dormancy proven: no `src/` file imports
`divert-codes`, no route or `server.js` mount references `call-setup`, and the
hygiene test fails if the module ever pulls twilio/@supabase into the require
cache. Committed `980a6ad`.

**WCS-1b-i (2026-07-23):** the two WCS test files → 63/63 pass (41 original
WCS-1a tests unmodified). Full `npm test` → 216/216 pass. Dormancy re-proven:
nothing imports `routing-profile`; no route files, no `server.js` change, no
flag config; adversarial greps confirm no `clients` write exists in new code
(single SELECT of `twilio_number`), no Twilio import, and both SQL files are
review-only (nothing applied).
