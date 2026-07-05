# Documentation Audit

_A review of every markdown document in the repo: duplicates, contradictions,
obsolete assumptions, gaps, and merge recommendations. Findings are ranked;
recommendations are actionable but **not yet applied** to the source docs (except
the new INDEX/ARCHITECTURE/this file), so nothing existing was rewritten without
review._

Scanned: `README.md`, `EXECUTIVE_SUMMARY.md`, `DEPLOYMENT.md`,
`PRODUCTION_ROLLOUT.md`, `TEST_PLAN.md`, `SECURITY_REVIEW.md`, `PHASE_5_PLAN.md`,
`CLIENT_ONBOARDING_RUNBOOK.md`, `INCIDENT_RESPONSE.md`,
`supabase/sql/RLS_APPLY_CHECKLIST.md`, `smoke/README.md`,
`smoke/MANUAL_CHECKLIST.md`, `docs/VOIP_V2_ARCHITECTURE.md`,
`docs/OUTBOUND_BDM_ARCHITECTURE.md`.

---

## 1. Obsolete (highest priority)

| # | Doc | Problem | Status |
|---|---|---|---|
| O1 | `README.md` | Described the original MVP: SMS'd transcripts, UK numbers (`normaliseUK`), unconditional `*21*` forwarding — while the live system emails via Gmail, uses AU numbers, and conditional forwarding. | ✅ **Resolved** — README rewritten to describe the current system and point into `docs/`. |
| O2 | `README.md` env table | Listed `TRANSCRIPT_RECIPIENT_NUMBER` as core (only used by dead `sms.js`); omitted the real critical vars. | ✅ **Resolved** — README now defers env to `DEPLOYMENT.md` / `.env.example`. |

## 2. Contradictions

| # | Between | Contradiction | Resolution |
|---|---|---|---|
| C1 | `README.md` ↔ `ARCHITECTURE.md`/code | Forwarding model: unconditional (README) vs conditional (reality). | ✅ **Resolved** — README now states conditional forwarding; `ARCHITECTURE.md` authoritative for v1, `VOIP_V2_ARCHITECTURE.md` for the deliberate future `*21*`. |
| C2 | `README.md` ↔ `DEPLOYMENT.md` | `TRANSCRIPT_RECIPIENT_NUMBER` "required" vs "legacy/unused". | ✅ **Resolved** — README defers to `DEPLOYMENT.md`. |
| C3 | Multiple ↔ each other | The RLS "apply only after browser Supabase access removed" rule and the anon-key/service-key co-rotation caveat are restated in ≥5 docs; risk that one is updated and others drift. | Designate `RLS_APPLY_CHECKLIST.md` as owner; others link. (Now recorded in INDEX single-source-of-truth table.) |

## 3. Duplication / overlap

| # | Docs | Overlap | Recommendation |
|---|---|---|---|
| D1 | `TEST_PLAN.md` ↔ `smoke/` suite | `TEST_PLAN.md` predates the automated suite; its steps 1–7,9 are now automated by `npm run smoke`, step 8 (live call) duplicates `smoke/MANUAL_CHECKLIST.md`. | Reposition `TEST_PLAN.md` as an index: "automated → `npm run smoke`; manual → `smoke/MANUAL_CHECKLIST.md`", keeping only the deep log-diagnostic reference that the others cite. Don't delete (INCIDENT_RESPONSE + MANUAL_CHECKLIST link to its step-8 diagnostics). |
| D2 | `DEPLOYMENT.md` ↔ `PRODUCTION_ROLLOUT.md` | Both cover deploy order + rollback. | `PRODUCTION_ROLLOUT.md` owns the *procedure*; `DEPLOYMENT.md` owns the *reference* (env table, transitional state). Trim rollback prose from DEPLOYMENT to a link. |
| D3 | Transitional-state description (`OPERATOR_CLIENT_ID=default`, calls.js filter) | Restated in `DEPLOYMENT.md`, `PHASE_5_PLAN.md`, `EXECUTIVE_SUMMARY.md`, now `ARCHITECTURE.md`. | `DEPLOYMENT.md` owns it; others link. |
| D4 | Env var lists | `DEPLOYMENT.md`, `smoke/README.md`, `smoke/lib/env.js` each enumerate env vars. | `DEPLOYMENT.md` owns the canonical list; smoke docs link and only list what the *runner* needs. |

## 4. Gaps (missing docs) — highest-value additions

| # | Missing | Why it matters | Status |
|---|---|---|---|
| G1 | Current-system architecture | No doc described the live system end-to-end; onboarding a new engineer meant reading all of `src/`. | ✅ **Created** `ARCHITECTURE.md` this pass. |
| G2 | Documentation index / roadmap | Docs were scattered across root, `docs/`, `smoke/`, `supabase/sql/` with no map. | ✅ **Created** `INDEX.md` this pass. |
| G3 | Data model / schema | Tables only existed implicitly in code; no migration files or schema doc. | Partially filled in `ARCHITECTURE.md §6`. **Recommend** a real schema/migrations file in Supabase-tracked SQL. |
| G4 | Local dev setup / CONTRIBUTING | No documented "clone → env → run locally" path; Node version floor undocumented. | **Recommend** a short `CONTRIBUTING.md` (see ENGINEERING_BACKLOG tooling section). |
| G5 | Decision log (ADRs) | Key choices (session-derived clientId, Retell-for-BDM, Twilio-Client-for-VoIP) are spread across docs. | **Recommend** a lightweight `docs/decisions/` ADR folder going forward. |
| G6 | Glossary | Terms (operator vs client, slug/clientId, "Aida", pipeline) used without a single definition. | **Recommend** a short glossary section in `ARCHITECTURE.md` or `INDEX.md`. |

## 5. Merge recommendations

- **Verification docs:** `TEST_PLAN.md` + `smoke/README.md` + `smoke/MANUAL_CHECKLIST.md`
  form one logical topic split across three files. Don't physically merge (they
  serve different moments), but cross-link them under a single "Verification"
  heading in `INDEX.md` (done) and reposition `TEST_PLAN.md` per D1.
- **Deploy docs:** keep `PRODUCTION_ROLLOUT.md` (procedure) and `DEPLOYMENT.md`
  (reference) separate but de-duplicate rollback per D2.

## 6. README.md rewrite — ✅ applied

The root `README.md` has been rewritten to accurately describe the current
system (email/CRM pipeline, AU conditional forwarding, correct quick-start) and
now points into the documentation index. This resolves O1/O2/C1/C2 above. See
the current `README.md`.

## 7. Applied vs proposed

| Applied | Still proposed (needs approval) |
|---|---|
| `docs/INDEX.md`, `docs/ARCHITECTURE.md`, `docs/DOCS_AUDIT.md`, `docs/ENGINEERING_BACKLOG.md` (new); **README rewrite (O1/O2/C1/C2)** — low-risk doc accuracy fix applied during autonomous hardening | TEST_PLAN reposition (D1); DEPLOYMENT/ROLLOUT de-dup (D2); schema file (G3); CONTRIBUTING (G4); ADR folder (G5); glossary (G6) |

The README rewrite was applied because it's pure documentation accuracy (no
runtime effect) and was an explicit objective. The remaining proposals touch
multiple existing docs and are left for review.
