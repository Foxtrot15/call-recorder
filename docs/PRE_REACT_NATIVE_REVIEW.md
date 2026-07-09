# Pre-React-Native Engineering Review

**Date:** 2026-07-09 · **Status:** recommendations only — nothing here is
implemented. **Question asked:** *if React Native development starts tomorrow,
what backend or workflow improvements would still provide strong engineering
value?* Scope: API consistency, mobile contracts, auth, observability,
maintainability, developer experience, testing and deployment workflow,
documentation quality. Speculative redesigns deliberately excluded (see §4).

Evidence base: the codebase at commit `2c84ab2`, `docs/INDEX.md` and its
owned docs, `docs/ENGINEERING_BACKLOG.md`, `PHASE_5_PLAN.md`,
`SECURITY_REVIEW.md`, and the git branch state.

---

## 1. Must do before React Native starts

### M1. Ship the accumulated local work (Peter gate: merge + deploy)
`origin/main` does not contain B1 session refresh, the mobile-auth layer
(Bearer transport, token-mode login/refresh, `GET /client-auth/me`,
`POST /devices/revoke`), or VoIP Phases 1a–1c — all of it lives only in local
commits on `feature/voip-phase-1a-loop-guard` (`git log origin/main..HEAD`).
The app's first line of code calls `POST /client-auth/login {mode:"tokens"}`;
until this branch is merged, deployed, and smoke-tested, there is no server
anywhere that speaks the mobile contract. **Everything else on this list is
downstream of this step.** Deploy order per `PRODUCTION_ROLLOUT.md` /
`DEPLOYMENT.md`; all VoIP behaviour stays dormant (flags off), so the deploy
risk is the auth layer only — which has full regression coverage (153 unit
tests) plus the smoke suite.

### M2. Stand up a development environment where the VoIP flags can be ON
Today there is exactly one environment: production. The Phase 2 exit gate
("dev-environment answered call rings a real device",
`VOIP_V2_IMPLEMENTATION_PLAN.md` §4) is unreachable without a second one, and
production must keep `VOIP_V2_ENABLED` unset. Concretely:
- a dev Supabase project with `phase1a/1b/1c` SQL applied (human-applied, as
  always) and a seeded test client + login;
- a dev deployment (second Railway service or a tunnel-exposed local server —
  Twilio webhooks need a public HTTPS `BASE_URL`) with `VOIP_V2_ENABLED=true`
  and Twilio API-key/push-credential vars;
- `SMOKE_BASE_URL` + credentials wired into CI secrets so the existing
  self-skipping smoke job (`.github/workflows/ci.yml:62`) finally runs on
  every push.
This is also what makes the browser-verification workflow and mobile-contract
curl checks safe — no more verifying against production or nothing.

### M3. Extend the smoke suite to cover the mobile contract
`smoke/smoke.test.js` §8 covers cookie login only; the bearer contract the
app depends on has zero deploy-time verification. Add non-mutating checks:
token-mode login → `GET /client-auth/me` with the Bearer token → body-mode
refresh (rotated pair) → logout. All are safe under the suite's no-mutation
policy (a login/refresh/logout cycle on the seeded smoke client creates
nothing). This is the cheapest possible insurance that a backend change never
silently breaks the app in production.

### M4. Settle B5 and Q6 (decisions, not code)
Platform of pilot client #1 (B5) decides whether iOS or Android workflow
executes first; app repo location (Q6 — recommendation stands: separate repo,
since Railway deploys this repo's root). Both are entry-gate decisions for
Phase 2 that cost nothing to make and block scaffolding while open.

## 2. Should do during React Native development

### S1. Fix rate-limit keying (`trust proxy`)
`app.set("trust proxy", true)` (`src/server.js:12`) makes `req.ip` honour
client-supplied `X-Forwarded-For`, so the login/refresh limiters can be
key-rotated by an attacker (noted in SECURITY_REVIEW #2). Fix = set the hop
count to Railway's actual proxy depth. Deploy-coordinated and needs a quick
empirical check of Railway's forwarding chain — schedule with any normal
deploy window, verify webhook signature validation still passes afterwards.

### S2. Mobile-debugging observability
When a device misbehaves, the only tools will be Railway logs. Two cheap,
high-leverage additions, matching the existing `voip.*` structured-log style:
auth outcome logs (`auth.login mode=tokens ok client=…`, `auth.refresh fail
reason=…` — no tokens, no emails in cleartext beyond what exists) and a
per-request correlation id echoed in error responses so a screenshot of an
app error can be matched to a server log line. Implement as the app's first
integration bugs demand it — that's when the shape of what's needed is known.

### S3. Error-envelope consistency on older client endpoints
The mobile contract established `{error, code}`; older client-facing routes
(`/client-dashboard/contacts`, parts of `/client-auth` signup/invite) return
prose-only errors. Add `code` fields **additively** as the app starts
consuming each endpoint — not as a big-bang sweep (the browser dashboard
ignores the field either way).

### S4. Unify the triplicated Google token refresh (backlog P2-1)
`gmail.js` / `gcal.js` / `notify.js` each carry a copy of OAuth refresh; a
fix applied to one and missed in the others is the standing hazard, and the
class-detection rule in the orchestration skill exists because of exactly
this pattern. No RN dependency — do it in a quiet stretch, behind tests,
since it touches the live pipeline (smoke required).

### S5. Pipeline retry / dead-letter (backlog P1-5) — before pilot cutover
The transcribe→analyse→follow-up chain still runs once, in-process; a
transient Deepgram/Claude outage drops the lead. v1 has lived with this; v2
answered calls raise the stakes. It gates **pilot cutover** (Phase 5), not RN
development — but starting it during RN keeps it off the critical path. Keep
the design minimal: persist-and-retry, not queue infrastructure.

### S6. Remaining Phase 1 VoIP endpoints when the app needs them
`/voip/push-ack` (the D12 funnel metric) and `/voip/call-status` are still
scaffold 501s. Build them when the app work reaches SDK registration — they
are meaningless without a device to ack. (Product features — normal Peter
approval flow, listed here for sequencing only.)

## 3. Can safely wait until after pilot

- **Dashboard "looks-built-but-isn't" gaps** (P1-1 business profile save,
  P1-2 onboarding capture, P1-3 crm_notes) — real trust issues, zero RN
  interaction; batch as a web-quality pass.
- **Dead code removal** (`services/sms.js`; `routes/outbound.js` after the
  Twilio-console webhook check per the backlog investigation).
- **Pagination on `/calls`**, ESLint/Prettier, `analyse.js`/date-parsing unit
  tests (P3) — valuable, not RN-coupled.
- **Anon-key/JWT-secret rotation** (post-RLS optional hardening) and
  **operator auth on Supabase Auth** — deliberate, scheduled work.
- **D12 dashboards/alerts UI** — MVP monitoring is logs + the daily query by
  design.
- **Doc refreshes** of `EXECUTIVE_SUMMARY.md` / `TEST_PLAN.md` (both partly
  superseded; fix opportunistically when touched).

## 4. Explicitly NOT recommended (speculative redesigns rejected)

- No TypeScript migration, no framework change, no schema-first router or
  generated OpenAPI (re-evaluated and rejected in
  [MOBILE_API_CONTRACT.md](MOBILE_API_CONTRACT.md) — the hand-maintained
  contract is the cheaper honest option at this route count).
- No queue/broker infrastructure for S5 — a `calls`-table retry state is
  enough at pilot scale.
- No multi-instance scaling prep (in-memory rate limiters are fine for a
  single Railway instance and documented as such).
- No pre-emptive API versioning — the contract is additive-only by promise;
  version when the first breaking need actually appears.

---

*Owned by this doc: the pre-RN prioritisation. Individual items remain owned
by their home docs (backlog, security review, VoIP plan) — update those when
an item ships, and strike it here.*
