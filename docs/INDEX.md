# Aida — Documentation Index

**This is the single source of truth for Aida's documentation.** Every document
in the repo is catalogued here, grouped by purpose, with its status and who owns
which facts. Start here.

> **What is Aida?** A per-tenant service that captures phone calls for small
> businesses — records them via Twilio, transcribes (Deepgram), analyses (Claude),
> and drives follow-up (Gmail drafts, Calendar events, CRM contacts, notification
> emails). Today it captures **missed/voicemail** calls (inbound) via carrier
> conditional forwarding. Two major capabilities are designed but not built:
> **VoIP v2** (capture *answered* calls) and the **Outbound AI BDM**.

---

## Reading paths (start by what you're doing)

| I want to… | Read, in order |
|---|---|
| **Understand the current system** | [ARCHITECTURE.md](ARCHITECTURE.md) → [../SECURITY_REVIEW.md](../SECURITY_REVIEW.md) |
| **Deploy a change** | [../PRODUCTION_ROLLOUT.md](../PRODUCTION_ROLLOUT.md) → [../DEPLOYMENT.md](../DEPLOYMENT.md) → run `npm run smoke` ([../smoke/README.md](../smoke/README.md)) → [../TEST_PLAN.md](../TEST_PLAN.md) |
| **Apply RLS** | [../supabase/sql/RLS_APPLY_CHECKLIST.md](../supabase/sql/RLS_APPLY_CHECKLIST.md) |
| **Onboard a pilot client** | [../CLIENT_ONBOARDING_RUNBOOK.md](../CLIENT_ONBOARDING_RUNBOOK.md) |
| **Fix something that broke** | [../INCIDENT_RESPONSE.md](../INCIDENT_RESPONSE.md) |
| **Get the executive picture** | [../EXECUTIVE_SUMMARY.md](../EXECUTIVE_SUMMARY.md) |
| **Plan the next engineering work** | [ENGINEERING_BACKLOG.md](ENGINEERING_BACKLOG.md) → [../PHASE_5_PLAN.md](../PHASE_5_PLAN.md) |
| **Build VoIP v2** | [VOIP_V2_IMPLEMENTATION_PLAN.md](VOIP_V2_IMPLEMENTATION_PLAN.md) → [VOIP_V2_ARCHITECTURE.md](VOIP_V2_ARCHITECTURE.md) → [VOIP_V2_BACKEND_SPEC.md](VOIP_V2_BACKEND_SPEC.md) / [VOIP_V2_MOBILE_APP_SPEC.md](VOIP_V2_MOBILE_APP_SPEC.md) → [VOIP_V2_PRODUCTION_OPS.md](VOIP_V2_PRODUCTION_OPS.md) |
| **Build the mobile app against the API** | [MOBILE_API_CONTRACT.md](MOBILE_API_CONTRACT.md) → [VOIP_V2_MOBILE_APP_SPEC.md](VOIP_V2_MOBILE_APP_SPEC.md) |
| **Build the outbound BDM** | [OUTBOUND_BDM_ARCHITECTURE.md](OUTBOUND_BDM_ARCHITECTURE.md) → [OUTBOUND_BDM_COMPLIANCE_ENGINE.md](OUTBOUND_BDM_COMPLIANCE_ENGINE.md) |
| **Audit the docs themselves** | [DOCS_AUDIT.md](DOCS_AUDIT.md) |
| **Do engineering work in this repo (any kind)** | [../.claude/skills/aida-orchestrate/SKILL.md](../.claude/skills/aida-orchestrate/SKILL.md) — the engineering operating system (workflow, delegation, verification, safety boundaries) |

---

## Document catalogue

Status legend: ✅ current · 🟡 partially superseded (see audit) · 🔴 obsolete · 📐 design (not built) · 🧭 index

### Architecture & product
| Doc | Status | Purpose | Owns (source of truth for) |
|---|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | ✅ | How the current system works end-to-end: routes, services, data model, pipeline | Current system structure, data model |
| [LOCKSMITH_PILOT_SPEC.md](LOCKSMITH_PILOT_SPEC.md) | ✅📐 | **AIDA Locksmith Receptionist** (Niche Drops) — M1 public product shell at `/locksmith-receptionist`: page sections, config/flags, demo-data boundary, stubbed enquiry submission, mobile + a11y review, founder placeholders. Built dormant, not deployed | Locksmith pilot product scope, config, demo-data rules, enquiry-form status |
| [LOCKSMITH_FEEDBACK_LOOP_SPEC.md](LOCKSMITH_FEEDBACK_LOOP_SPEC.md) | ✅📐 | **M7A conversational feedback loop** — LLM-backed delta change extraction beside the fixture, shared change-application and approval services, late-resolved provider references, inbound phone binding. Plus the **M7B contract correction**: five Retell contract mismatches found against official docs and fixed. Dormant; **no sandbox execution, no provider resource, no call** | Change extraction, change application, approval service, provider reference resolution, Retell contract conformance |
| [RETELL_SANDBOX_VALIDATION_PLAN.md](RETELL_SANDBOX_VALIDATION_PLAN.md) | 📐 | The **not yet executed** procedure for first real Retell validation, plus the implemented `scripts/retell-web-sandbox.js` runner: why web calls are gated separately from telephone calls, every sandbox gate, resource order, browser path and its limits, the three separate proofs (A: API issuance / B: dashboard audio / C: AIDA browser flow) and which are executed (A and C PASSED live 2026-08-02; B not performed), the isolated browser harness, manifest, cleanup, expected cost | Future sandbox procedure, provider cost expectations |
| [RETELL_CALL_DIAGNOSTICS_SPEC.md](RETELL_CALL_DIAGNOSTICS_SPEC.md) | ✅📐 | **M7E Australian phone speech + read-only Retell call diagnostics** — canonical E.164 versus derived display/spoken presentation, Australian mobile/landline/13/1300/1800 grouping, why raw E.164 must never be read aloud, machine-only versus model-facing number variables, the future inbound `from_number` path, the Get Call contract (reviewed 2026-08-02), evidence-versus-inference diagnostics, labelled heuristic thresholds, transcript privacy, post-call-analysis readiness, and the read-only gate. Built dormant; **no external request, no provider resource, no call, no number, no webhook, no SQL, no deployment** | Phone-number presentation, spoken-number rules, dynamic-variable number separation, Get Call diagnostic contract, diagnostics gates, post-call-analysis handling |
| [RETELL_LIVE_DIAGNOSTICS_VALIDATION.md](RETELL_LIVE_DIAGNOSTICS_VALIDATION.md) | ✅ | **M7E-LV live read-only validation (2026-08-02)** — the retained M7D web call read back through `GET /v2/get-call`, read-only, no mutation. Corrects the M7D dropout narrative: the call ended cleanly on a provider-classified `user_hangup` with a complete final turn, and the truncation was **mid-call**, which the first implementation could not see. Records the pre-execution proof, sanitised lifecycle/latency/analysis result, four corrections, privacy verification and what remains unproven. **No real call, agent or resource id, no transcript** | Live diagnostic evidence for the M7D dropout, observed Get Call behaviour, live-vs-documented divergences |
| [LOCKSMITH_BILLING_SPEC.md](LOCKSMITH_BILLING_SPEC.md) | ✅📐 | **M6 usage metering, the A$49 offer and billing** — Stripe doc review (Metronome vs Billing Meters decision), five danger gates, four-tier plan catalogue, usage metering, best-fit tier, founding offer, account lifecycle, threshold notices, Stripe port + webhook boundary, billing page, profitability guardrails. Built dormant and **uncommitted**; SQL written, **not applied**; no Stripe object created, **no payment taken** | Plan prices, metering rules, billing danger gates, account lifecycle, Stripe integration boundary, profitability model |
| [LOCKSMITH_CLIENT_PORTAL_SPEC.md](LOCKSMITH_CLIENT_PORTAL_SPEC.md) | ✅📐 | **M5 client portal + configuration management** — authenticated portal at `/client/locksmith` (7 tabs), channel-neutral change-request domain shared by UI and the future voice configuration agent, layered voice-auth policy, notification preferences with cost visibility, call-forwarding journey over the verified divert-codes module, founder client-operations view, nine read models. Built dormant; SQL written, **not applied**; no configuration call placed, no agent number connected | Client portal surfaces, change-request domain, UI/voice configuration parity, notification preferences, call-forwarding journey, portal read models |
| [LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md](LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md) | ✅📐 | **M4 autonomous onboarding call runtime** — call consent, client call page, start-call service, lifecycle ingestion, transcript→review automation, approval→provisioning bridge, mock end-to-end simulator, generated receptionist test plan, Micro complexity assessment. Built dormant and **uncommitted**; SQL written, **not applied**; no call placed | Onboarding call consent, call lifecycle, transcript automation, provisioning bridge, mock simulator |
| [RETELL_INTEGRATION_SPEC.md](RETELL_INTEGRATION_SPEC.md) | ✅📐 | **M3 Retell provider + provisioning foundation** — official docs reviewed, SDK/transport decision, four danger gates, provider-neutral port and adapters, receptionist + onboarding-agent compilers, post-call analysis, provisioning plan lifecycle, resource registry, webhook signature architecture, founder preview. Built dormant; SQL written, **not applied**; no external resource created | Retell integration boundary, provider port, compilers, provisioning plan, webhook verification |
| [LOCKSMITH_ONBOARDING_SPEC.md](LOCKSMITH_ONBOARDING_SPEC.md) | ✅📐 | **M2 autonomous onboarding foundation** — canonical locksmith business profile (12 sections), profile + session lifecycles, transcript ingestion boundary, extraction adapter contract, review/approval experience, founder console, provisioning-readiness rules, Retell webhook signature requirement. Built dormant; SQL written, **not applied** | Canonical profile schema, profile/session lifecycles, extraction contract, approval guard, provisioning readiness |
| [../EXECUTIVE_SUMMARY.md](../EXECUTIVE_SUMMARY.md) | ✅ | One-page status: what was fixed, what's risky, what's next | Executive status |
| [../README.md](../README.md) | ✅ | Project orientation → points into `docs/` | Repo entry point |

### Operations
| Doc | Status | Purpose | Owns |
|---|---|---|---|
| [../PRODUCTION_ROLLOUT.md](../PRODUCTION_ROLLOUT.md) | ✅ | Ordered deploy sequence + rollback decision tree | Deploy procedure, rollback |
| [../DEPLOYMENT.md](../DEPLOYMENT.md) | ✅ | Env var reference, deploy order, current transitional state | **Env var reference** |
| [../TEST_PLAN.md](../TEST_PLAN.md) | 🟡 | Manual smoke steps (predates the automated suite) | Manual/e2e verification steps |
| [../smoke/README.md](../smoke/README.md) | ✅ | Automated smoke suite usage | `npm run smoke` |
| [../smoke/MANUAL_CHECKLIST.md](../smoke/MANUAL_CHECKLIST.md) | ✅ | Twilio / live-call checks the suite can't automate | Live-call verification |
| [../INCIDENT_RESPONSE.md](../INCIDENT_RESPONSE.md) | ✅ | Playbooks: dashboard / calls / Google / RLS failures | Incident playbooks |

### Security & compliance
| Doc | Status | Purpose | Owns |
|---|---|---|---|
| [../SECURITY_REVIEW.md](../SECURITY_REVIEW.md) | ✅ | Findings: fixed, open (ranked), accepted | **Security posture & risk register** |
| [../supabase/sql/RLS_APPLY_CHECKLIST.md](../supabase/sql/RLS_APPLY_CHECKLIST.md) | ✅ | Gated RLS application + negative proof | **RLS procedure** |
| [../supabase/sql/phase2_enable_rls.sql](../supabase/sql/phase2_enable_rls.sql) | ✅ | The RLS enable script — **applied 2026-07-06** (via an existence-guarded variant; `personal_contacts` didn't exist yet and was covered at creation instead) | RLS SQL |
| [../supabase/sql/phase5_backfill_default.sql](../supabase/sql/phase5_backfill_default.sql) | ✅📐 | The `'default'` tenant backfill (not yet applied) | Backfill SQL |
| [../supabase/sql/create_personal_contacts.sql](../supabase/sql/create_personal_contacts.sql) | ✅ | Creates the `personal_contacts` table with RLS (P1-6) — **applied 2026-07-06**, post-apply smoke green | personal_contacts schema |
| [LLM_PROMPT_CONTAMINATION_INVESTIGATION.md](LLM_PROMPT_CONTAMINATION_INVESTIGATION.md) | ✅ | Root cause of the hallucinated-draft incident: prompt-input map, feedback loops, fix architecture | LLM prompt provenance & grounding rules |
| [../supabase/sql/cleanup_test_contamination.sql](../supabase/sql/cleanup_test_contamination.sql) | ✅📐 | Purges cached test-fixture contamination from calls/profile/contacts (not yet applied) | Contamination cleanup SQL |
| [../supabase/sql/phase1a_add_voip_enabled.sql](../supabase/sql/phase1a_add_voip_enabled.sql) | ✅📐 | Adds `clients.voip_enabled` (D7 flag; loop-guard INV-1) — not yet applied | voip_enabled column SQL |
| [../supabase/sql/phase1b_create_devices.sql](../supabase/sql/phase1b_create_devices.sql) | ✅📐 | Creates the `devices` table with RLS-at-birth (D8) — not yet applied | devices schema |
| [../supabase/sql/phase1c_add_answered_via.sql](../supabase/sql/phase1c_add_answered_via.sql) | ✅📐 | Adds `calls.answered_via/dial_status/answered_at` (nullable, v2 bookkeeping) — not yet applied | calls v2 columns SQL |
| [../supabase/sql/dev/dev_minimal_schema.sql](../supabase/sql/dev/dev_minimal_schema.sql) | ✅ | **DEV-ONLY** minimal `clients` schema + `dev-client` seed for the local VoIP E2E stack (RLS same-transaction, no PII; never for production) — applied to the dev Supabase project 2026-07-12, followed in order by phase1a + phase1b | dev Supabase schema |
| [../supabase/sql/wcs1b_create_client_phone_routing_profiles.sql](../supabase/sql/wcs1b_create_client_phone_routing_profiles.sql) | ✅📐 | Creates `client_phone_routing_profiles` with RLS-at-birth (D8) for WEB-CALL-SETUP-1 — **not yet applied** | client_phone_routing_profiles schema |
| [../supabase/sql/dev/dev_add_twilio_number.sql](../supabase/sql/dev/dev_add_twilio_number.sql) | ✅📐 | **DEV-ONLY** addendum: adds `clients.twilio_number` + fake seed to the dev project (call-setup generate target) — **not yet applied** | dev twilio_number addendum |
| [../supabase/sql/lpm2_create_locksmith_onboarding.sql](../supabase/sql/lpm2_create_locksmith_onboarding.sql) | ✅📐 | Creates `locksmith_onboarding_sessions`, `locksmith_business_profiles` (versioned, one-approved-per-client partial unique index) and the append-only `locksmith_onboarding_events`, all with RLS-at-birth (D8) — **not yet applied** | Locksmith onboarding schema |
| [../supabase/sql/lpm3_create_retell_provisioning.sql](../supabase/sql/lpm3_create_retell_provisioning.sql) | ✅📐 | Creates `provider_resources`, `provisioning_plans`, `provisioning_actions` and `provider_webhook_events` with RLS-at-birth and partial unique indexes (one active resource per purpose, one active plan per client, one success per idempotency key) — **not yet applied; apply after lpm2** | Retell provisioning schema |
| [../supabase/sql/lpm4_create_onboarding_call_runtime.sql](../supabase/sql/lpm4_create_onboarding_call_runtime.sql) | ✅📐 | Creates `onboarding_call_consents` (affirmative-consent check constraints, number-bound, versioned disclosure) and `onboarding_calls` (unique provider-call binding, one active call per session) with RLS-at-birth — **not yet applied; apply after lpm3** | Onboarding call runtime schema |

### Onboarding
| Doc | Status | Purpose | Owns |
|---|---|---|---|
| [../CLIENT_ONBOARDING_RUNBOOK.md](../CLIENT_ONBOARDING_RUNBOOK.md) | ✅ | Manual pilot onboarding: Twilio, clients row, invite, forwarding codes | **Onboarding procedure** |

### Planning & future
| Doc | Status | Purpose | Owns |
|---|---|---|---|
| [../PHASE_5_PLAN.md](../PHASE_5_PLAN.md) | ✅ | Ordered cleanup backlog with dependencies | Phase 5 scope |
| [ENGINEERING_BACKLOG.md](ENGINEERING_BACKLOG.md) | ✅ | Prioritised tech-debt / tooling / scalability proposals | Engineering backlog |
| [VOIP_V2_ARCHITECTURE.md](VOIP_V2_ARCHITECTURE.md) | 📐 | Answered-call capture via Twilio Voice SDK + native app | VoIP v2 design (D1–D6, INV-1–6) |
| [VOIP_V2_IMPLEMENTATION_PLAN.md](VOIP_V2_IMPLEMENTATION_PLAN.md) | ✅ | Phases, gates, blocking prerequisites, decisions D7–D12 | VoIP v2 sequencing & decisions D7+ |
| [VOIP_V2_BACKEND_SPEC.md](VOIP_V2_BACKEND_SPEC.md) | 📐 | Route contracts, `devices` data model, guard semantics, env/config | VoIP v2 backend contracts |
| [VOIP_V2_MOBILE_APP_SPEC.md](VOIP_V2_MOBILE_APP_SPEC.md) | 📐 | App behaviour contract: lifecycle, platform obligations, failure UX | VoIP v2 app contracts |
| [MOBILE_API_CONTRACT.md](MOBILE_API_CONTRACT.md) | ✅ | Stable mobile API contract: dual-mode auth (cookie/Bearer), client-auth + VoIP endpoint shapes, token lifecycle | **Mobile API request/response contract & auth transport rules** |
| [PRE_REACT_NATIVE_REVIEW.md](PRE_REACT_NATIVE_REVIEW.md) | ✅ | Principal-engineer review before RN work: must/should/can-wait recommendations | **Pre-RN prioritisation** |
| [VOIP_V2_PHASE_0_SCAFFOLD.md](VOIP_V2_PHASE_0_SCAFFOLD.md) | ✅ | Inventory + safety argument for the dormant Phase 0 code | Phase 0 scaffold state |
| [VOIP_V2_PRODUCTION_OPS.md](VOIP_V2_PRODUCTION_OPS.md) | 📐 | VoIP cost model, quality SLOs, monitoring, scaling, push reliability | VoIP v2 ops |
| [WEB_CALL_SETUP_SPEC.md](WEB_CALL_SETUP_SPEC.md) | ✅📐 | WEB-CALL-SETUP-1: guided conditional-diversion setup (missed/busy/unreachable). WCS-1a pure template engine + status machine built dormant (`src/services/divert-codes.js`, imported by nothing); routes/SQL/UI designed only | Call-setup module contract, divert-code templates, setup status machine |
| [OUTBOUND_BDM_ARCHITECTURE.md](OUTBOUND_BDM_ARCHITECTURE.md) | 📐 | Outbound AI BDM strategy + Australian compliance | Outbound BDM design |
| [OUTBOUND_BDM_COMPLIANCE_ENGINE.md](OUTBOUND_BDM_COMPLIANCE_ENGINE.md) | 📐 | Reusable compliance-as-code engine (interfaces, gates, evidence) | Compliance engine design |

### Meta
| Doc | Status | Purpose |
|---|---|---|
| [INDEX.md](INDEX.md) | 🧭 | This file |
| [DOCS_AUDIT.md](DOCS_AUDIT.md) | ✅ | Duplicates, contradictions, gaps, merge recommendations |
| [../.claude/skills/aida-orchestrate/SKILL.md](../.claude/skills/aida-orchestrate/SKILL.md) | ✅ | **Engineering operating system** — binding workflow: phases, requirements ledger, model/delegation routing, browser & React Native verification, safety boundaries |

---

## Documentation hierarchy

```mermaid
flowchart TD
    INDEX["📇 INDEX.md<br/>(you are here)"]

    subgraph NOW["Current system (built)"]
        ARCH["ARCHITECTURE.md"]
        SEC["SECURITY_REVIEW.md"]
        EXEC["EXECUTIVE_SUMMARY.md"]
    end

    subgraph OPS["Operate & deploy"]
        ROLL["PRODUCTION_ROLLOUT.md"]
        DEPLOY["DEPLOYMENT.md"]
        SMOKE["smoke/ suite"]
        TEST["TEST_PLAN.md"]
        INC["INCIDENT_RESPONSE.md"]
        RLS["RLS_APPLY_CHECKLIST.md"]
        ONB["CLIENT_ONBOARDING_RUNBOOK.md"]
    end

    subgraph NEXT["Plan & future (designed)"]
        P5["PHASE_5_PLAN.md"]
        BACK["ENGINEERING_BACKLOG.md"]
        VOIP["VOIP_V2_ARCHITECTURE.md"]
        BDM["OUTBOUND_BDM_ARCHITECTURE.md"]
    end

    INDEX --> NOW
    INDEX --> OPS
    INDEX --> NEXT
    ARCH --> SEC
    ROLL --> DEPLOY --> SMOKE --> TEST
    ROLL --> RLS
    P5 --> BACK
    NEXT --> VOIP
    NEXT --> BDM
```

---

## The roadmap — how the phases link together

Aida's work is organised as numbered phases. Phases 1–4 are shipped (commit
`1cdeaaa`); Phase 5 is the remaining cleanup; VoIP v2 and the BDM are the next
major products.

```mermaid
flowchart LR
    P1["Phase 1<br/>Supabase auth<br/>isolation ✅"]
    P2["Phase 2<br/>Enable RLS<br/>✅ applied 2026-07-06"]
    P3["Phase 3<br/>Invite-gated<br/>signup ✅"]
    P4["Phase 4<br/>Session-derived<br/>clientId ✅"]
    P5["Phase 5<br/>Cleanup<br/>⏳ pending"]
    V2["VoIP v2<br/>answered calls<br/>📐 design"]
    BDM["Outbound BDM<br/>📐 design"]

    P1 --> P3 --> P4 --> P2 --> P5 --> V2
    P5 --> BDM

    click P2 "../supabase/sql/RLS_APPLY_CHECKLIST.md"
    click P5 "../PHASE_5_PLAN.md"
    click V2 "VOIP_V2_ARCHITECTURE.md"
    click BDM "OUTBOUND_BDM_ARCHITECTURE.md"
```

Note the ordering nuance (from SECURITY_REVIEW.md): Phase 2 (RLS) was
intentionally deferred until after the Phase 5 item that removed the browser's
direct Supabase access, because enabling RLS while the old dashboard was live
would have broken it. **Status: RLS was applied 2026-07-06** (deny-by-default,
no policies; `personal_contacts` created same day with RLS on) and the full
smoke suite passed against production afterwards (17/17 active checks).
Remaining sign-off: the anon-role negative proof from
[RLS_APPLY_CHECKLIST.md](../supabase/sql/RLS_APPLY_CHECKLIST.md).

---

## Single-source-of-truth rules

To stop the same fact drifting across documents, each fact has **one owner**;
everything else links to it rather than restating it.

| Fact | Owned by | Everyone else should… |
|---|---|---|
| Environment variables | `DEPLOYMENT.md` | link, not re-list |
| Deploy order & rollback | `PRODUCTION_ROLLOUT.md` | link |
| RLS procedure & anon-key/service-key rotation caveat | `RLS_APPLY_CHECKLIST.md` | link |
| Security risks (open/fixed/accepted) | `SECURITY_REVIEW.md` | link |
| Onboarding steps & forwarding codes | `CLIENT_ONBOARDING_RUNBOOK.md` | link |
| Current transitional state (`OPERATOR_CLIENT_ID=default`, transitional filter) | `DEPLOYMENT.md` | link |
| Data model / schema | `ARCHITECTURE.md` | link |

See [DOCS_AUDIT.md](DOCS_AUDIT.md) for where this is currently violated and the
plan to fix it.

---

_Maintenance: when you add a doc, add a row to the catalogue above and place it in
the hierarchy. When you change an owned fact, change it in the owning doc only._
