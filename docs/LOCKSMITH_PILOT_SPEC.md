# AIDA Locksmith Receptionist — pilot spec (M1: public product shell)

**Product:** AIDA Locksmith Receptionist · **Provider:** Niche Drops
**Status:** M1 built, not deployed, not committed to `main`.
**Branch:** `feature/locksmith-pilot-m1`
**Public route:** `GET /locksmith-receptionist`

> **Build state (2026-07-31).** Everything on the page is real code reading real
> configuration, but the *content* is demonstration data and the enquiry form
> has no persistence sink. No telephony, no AI agent, no prospect mining, no
> billing and no client onboarding exist for this product yet — see
> [§10 Deferred](#10-deferred-explicitly-out-of-m1).

---

## 1. Purpose

A locksmith who lands on this page should be able to work out, in one scroll,
what AIDA does for their business, what a call actually produces, what it
costs, and how to ask to join the pilot. M1 exists so the product looks
legitimate and is explainable *before* any of the expensive machinery
(outbound calling, prospect mining, DNCR washing, live telephony, onboarding,
billing) is built.

Positioning — the sentence the whole page serves:

> AIDA answers missed and after-hours locksmith calls, captures the customer's
> location and lock problem, determines urgency, and transfers or alerts the
> locksmith according to the business's rules.

Outcomes the copy is allowed to claim: fewer missed enquiries, more after-hours
jobs captured, urgent calls escalated quickly, details captured consistently,
fewer interruptions from unsuitable enquiries, no night receptionist to employ.
It does not claim revenue figures, guarantees, or generic "AI automation".

## 2. M1 scope

**In:** one public page (hero, how-it-works, scenarios, capabilities, example
calls, dashboard preview, pricing, pilot enquiry form, trust/footer), the
configuration module behind it, the demonstration dataset, server-side form
validation, a stubbed submission boundary, tests, and this document.

**Out:** everything in [§10](#10-deferred-explicitly-out-of-m1).

## 3. Architecture

Follows the repo's existing shape (`config/` + `services/` + `routes/`, plain
CommonJS, no template engine, no frontend framework, no new dependency).

| File | Role |
|---|---|
| `src/config/locksmith.js` | **Owns every changeable value**: names, demo phone, pricing, pilot limit, ABN, contact, CTA destinations, both feature flags, placeholder reporting |
| `src/services/locksmith-demo.js` | The demonstration dataset — scenarios, capabilities, how-it-works steps, example calls, dashboard metrics + recent calls |
| `src/services/locksmith-enquiry.js` | Form field contract (single source for renderer *and* validator), server-side validation, submission boundary |
| `src/views/locksmith-page.js` | Pure `(config, demo, fields) → HTML` renderer |
| `src/views/escape.js` | Shared output escaper (the repo previously served only static HTML and had none) |
| `src/routes/locksmith-handlers.js` | The two handlers, express-free and injectable-deps, so they're testable without `node_modules` |
| `src/routes/locksmith.js` | Express wiring only: the flag gate + two routes |
| `public/locksmith/locksmith.css` | Mobile-first stylesheet, scoped to `body.locksmith` |
| `public/locksmith/locksmith.js` | Progressive-enhancement form behaviour (idle / submitting / success / error) |

**Why rendered rather than a static file in `public/`.** The page has to read
pricing, the pilot limit and the (currently unresolved) founder details from
one configuration source. A static HTML file would hardcode them — exactly what
the brief forbids. Rendering is a string concatenation over frozen data, with
no template engine added.

**Why `src/views/` is a new directory.** A renderer is neither a route nor a
domain service; putting it in `services/` would blur what that directory means.
Two small files, no framework.

**Isolation.** Every locksmith module is new. The only change to an existing
runtime file is one additive `app.use(...)` in `src/server.js`. No locksmith
module imports Supabase, Twilio, axios or googleapis (asserted in
`test/locksmith-enquiry.test.js`), reads tenant data, or touches the v1
missed-call pipeline. The feature is not linked from any existing page.

## 4. Public routes

| Route | Auth | Behaviour |
|---|---|---|
| `GET /locksmith-receptionist` | public | Renders the page. Sets its own CSP (`default-src 'self'`, no `unsafe-inline`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Cache-Control: public, max-age=60` |
| `POST /locksmith-receptionist/enquiry` | public | JSON in, JSON out. Rate limited to 5 per 10 min per IP (the existing `services/rate-limit.js`). Validates server-side, then hands to the submission boundary |

Mounted before `express.static`, with no auth middleware attached — it is
deliberately a public marketing page. Existing mounts are unchanged; the
`requireLogin` gate on `/` still precedes `express.static` (asserted in tests).

Response codes: `200 received` · `400 invalid` (with per-field errors) ·
`429 rate_limited` · `502 error` · `503 disabled` / `503 unavailable`.

## 5. Configuration

All optional — the app starts and the page renders with none of them set.
Names only; values live in Railway env (see [../DEPLOYMENT.md](../DEPLOYMENT.md),
which owns the env var reference).

| Variable | Default | Effect |
|---|---|---|
| `LOCKSMITH_PILOT_ENABLED` | **off** | Only the exact string `true` serves the page; anything else (including unset) 404s both routes via `next("router")` |
| `LOCKSMITH_ENQUIRY_ENABLED` | **off** | Only the exact string `true` enables submissions |
| `LOCKSMITH_DEMO_PHONE` | placeholder | Demo number. Unset ⇒ the CTA renders as unavailable with a visible placeholder and **no** `tel:` link |
| `LOCKSMITH_CONTACT_EMAIL` | placeholder | Footer contact; unset ⇒ placeholder, never a `mailto:` |
| `NICHE_DROPS_ABN` | placeholder | Footer ABN |
| `NICHE_DROPS_PRIVACY_URL` / `NICHE_DROPS_TERMS_URL` | placeholder | Footer links; unset ⇒ placeholder text, never an `href` |
| `LOCKSMITH_CONTACT_REGION` | `Melbourne, Victoria, Australia` | Footer region |
| `LOCKSMITH_SETUP_PRICE` / `LOCKSMITH_MONTHLY_PRICE` / `LOCKSMITH_INCLUDED_DAYS` | 149 / 299 / 14 | Pricing (whole dollars; junk values fall back to the default) |
| `LOCKSMITH_PILOT_LIMIT` / `LOCKSMITH_PILOT_REGION` | 3 / `Melbourne` | Founding-pilot scarcity line |

**Both flags are dormant-by-default and strict-parse** (D7): only the exact
string `"true"` enables, so neither the page nor submissions can go live through
a sloppy env value. Flag-off is byte-identical to the feature not existing — the
gate runs `next("router")` before any handler, so a deploy without the variable
behaves exactly as it did before this code landed. The pilot has not launched;
it becomes visible only when Peter sets the variable deliberately.

Pricing is **provisional**, shown as founding-pilot pricing limited to the
first three Melbourne locksmith businesses, and no payment is taken anywhere on
the page.

## 6. Demonstration-data boundary

Everything visible on the page that looks like a customer record is invented
and labelled:

- 4 scenarios, 4 example calls and 6 dashboard rows each carry `demo: true` and
  print a "Demonstration data" tag.
- The dashboard is headed **"Demonstration workspace — example locksmith
  calls"** and states that the figures are illustrative and represent no real
  business.
- Callers are first name + initial only. There are **no** phone numbers, email
  addresses, street addresses, surnames, ABNs, testimonials, reviews or
  customer logos anywhere in the dataset (asserted by test).
- Transcripts are hand-written mock scripts, labelled as such. `audioUrl` is
  `null` on every example call — the slot exists so a real recording can be
  attached later without changing the shape. M1 embeds no `<audio>`, `<video>`
  or third-party player, and the page loads nothing off-site.
- In every example transcript AIDA tells the caller it is an automated
  assistant.

## 7. Form submission status — what remains before it can be enabled

**Today: nothing is stored.** `createEnquirySubmitter()` is the interface a real
sink will implement; M1 injects none, so a valid submission returns
`503 disabled` (flag off) or `503 unavailable` (flag on, no sink) and the page
tells the visitor honestly and points at the footer contact. No table exists, no
migration ships with this milestone, and no SQL was written or applied.

Complete before turning `LOCKSMITH_ENQUIRY_ENABLED=true`:

1. **Decide the sink** — a Supabase table, or an email/notification to Niche
   Drops, or both. (Email-only avoids storing prospect PII at rest.)
2. **If a table:** write `supabase/sql/<name>.sql` with RLS enabled in the same
   transaction (D8), review it, and have a human apply it per the
   RLS_APPLY_CHECKLIST procedure. Never from an agent session.
3. **Injection point:** pass `{ sink }` into `createEnquirySubmitter` in
   `src/routes/locksmith-handlers.js`. Nothing else changes.
4. **Retention + privacy:** publish the privacy policy URL and decide how long
   enquiry data is kept. Consent copy is already collected and required.
5. **Abuse:** the per-IP rate limit is in memory (single Railway instance, same
   caveat as D11). Add a honeypot/captcha only if spam actually appears —
   captchas are an accessibility cost.
6. **Notification:** decide who gets told about a new enquiry, and how.

Until all of that exists, the flag stays off and the page carries a visible
"online enquiries aren't switched on yet" notice.

## 8. Local setup, testing and review

```bash
npm install                       # one-time; the repo convention keeps node_modules absent
npm run dev                       # http://localhost:3000/locksmith-receptionist
npm test                          # full suite (dep-free, no node_modules needed)
node --test test/locksmith-*.test.js   # this feature only
```

The page needs no `.env` entries to render — with an empty env it shows
placeholders and the disabled-form notice, which is exactly the M1 state.

**Tests** (107 across three files, all dep-free — no supertest, no express
import in any test):

| File | Covers |
|---|---|
| `test/locksmith-config.test.js` | Both flags and the router gate, placeholder resolution, pricing/pilot overrides and junk-value fallback, config immutability, demo-data labelling and the no-invented-details rules |
| `test/locksmith-page.test.js` | All nine sections render; hero copy and CTAs; config-driven pricing; no invented phone number/ABN/contact; demo labelling; disclosures; accessibility contract (one `h1`, landmarks, labels, `aria-live`, non-colour urgency); output escaping incl. a hostile-config injection attempt; no fixed-width table; touch targets |
| `test/locksmith-enquiry.test.js` | Field contract; required fields; email/AU-phone/website validation; consent; forged choice values; hostile input kept verbatim; the submission boundary's four outcomes; GET returns 200 + security headers; POST invalid/success/failure/disabled/throwing-submitter/rate-limit; and isolation assertions that existing mounts, the `/` login gate and existing pages are untouched |

**Lint / type check:** the repo has neither an ESLint config nor a `tsconfig`
(CI runs `node --check` over `src` and `smoke`, then `npm test`). Nothing new
was introduced for this milestone; every new file passes `node --check`.

**Smoke:** `npm run smoke` is black-box HTTP against a running instance and was
**not** run for this batch — nothing is deployed and there is no staging target
for this branch. It should be run against the deploy target when Peter chooses
to ship, since this adds a route mounted in `server.js`.

## 9. Mobile and accessibility review

Reviewed in a browser against a local instance mounting the real router, at
**320, 375, 390, 768 and 1280 px** (measured in same-origin fixed-width frames
so the real media queries apply):

- No horizontal overflow at any width (`scrollWidth === clientWidth` in all
  five); no element wider than its viewport.
- The recent-calls table restacks below 900px: each row becomes a block and
  every cell prints its column name from `data-label`. **No column is ever
  hidden** — the seven fields are present in both modes. Above 900px it is a
  real table with `scope="col"` headers inside an `overflow-x` wrapper.
- Metrics: 2 columns at 320–599, 3 above. Steps: 1 → 2 → 5 columns.
- Inputs and buttons are ≥48px tall with 16px text (no iOS zoom-on-focus).
- Skip link moves from off-screen to visible on focus; focus rings are a 3px
  outline and were confirmed visually; all 32 focusable elements are reachable
  and none is `display:none` or `tabindex="-1"`.
- Transcripts use `<details>`/`<summary>` — keyboard-operable, no hover-only
  content anywhere on the page.
- One `h1`, `h2` per section, `h3` for cards; `header`/`nav`/`main`/`footer`
  landmarks; every control has a `label for` or sits in a `fieldset`/`legend`.
- Errors: `role="alert"` summary that takes focus, per-field messages,
  `aria-invalid`, and a `role="status" aria-live="polite"` region for
  submitting/success/error. Urgency always pairs a word with a non-colour
  marker (`!!` / `!` / `–`).
- Measured contrast: every sampled pair ≥ 6.49:1 (AA needs 4.5:1).
- Form states driven end-to-end in the browser: empty submit → 10 field errors
  + focused summary; valid submit → the shipped `503 disabled` message; success
  and 502-failure states exercised via review-only endpoints in the local
  harness (the failure state keeps what the visitor typed so they can retry).
- Console: no page errors (the only entry was an unrelated browser extension).

## 10. Deferred (explicitly out of M1)

Outbound AI calls · live inbound calls · Retell · GoHighLevel · Twilio
provisioning · locksmith crawling · Google Maps ingestion · DNCR washing ·
prospect databases · campaign scheduling · live call recordings · client
authentication or portal access · self-service agent configuration · Stripe
billing · automated onboarding · other niches · mobile app · white-label
reseller · custom voice models · production deployment.

## 11. Unresolved founder placeholders

These render as visible `[TO BE CONFIRMED: …]` markers on the page and are
listed by `unresolvedPlaceholders()`. Supply them (or decide to omit the
section) before the page is shown to a real prospect:

1. **Live demo phone number** — until set there is no `tel:` link and the CTA
   is visibly unavailable. Needs a Twilio number and a working demo agent,
   neither of which exists in M1.
2. **Niche Drops ABN**.
3. **Australian contact email** for the footer.
4. **Privacy policy URL** — also a precondition for enabling the form (§7).
5. **Terms URL**.

_Resolved 2026-08-01:_ `LOCKSMITH_PILOT_ENABLED` is dormant by default (§5).
The page is committed in the dormant state and only becomes reachable when the
variable is set to `"true"` deliberately.
