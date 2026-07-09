---
name: aida-orchestrate
description: >
  AIDA's engineering operating system — the binding execution protocol for ALL
  implementation work in this repo: backend changes, VoIP phases, auth work,
  dashboard fixes, React Native development, refactors, test/doc writing, and
  recon. USE THIS whenever a task involves changing code, investigating the
  codebase, or planning an implementation batch. Covers delegation to
  lower-cost models, the requirements ledger, verification stack (unit + smoke
  + browser), React Native device-vs-browser rules, and the safety boundaries
  around Aida's live production system.
---

# AIDA Orchestrate — the engineering operating system

**Why this exists:** Aida is a **live production system** capturing real
customers' phone calls for a real business. The cost of a mistake is not a
broken preview — it is a lost lead, a privacy breach, or a dead phone line.
Every rule below is either a production-safety mechanism or a credit-economy
mechanism (Peter's standing instruction: use lower-cost models wherever they
suffice; reserve Fable for judgment). Treat this file as binding procedure.

## Iron laws

1. **PRIME DIRECTIVE — the v1 missed-call pipeline must not break.** Every
   change is additive, flag-gated, or provably behaviour-preserving for the
   existing inbound → voicemail → transcribe → analyse → follow-up path.
   When in doubt, put it behind a flag (`VOIP_V2_ENABLED` + per-client
   `clients.voip_enabled` is the established two-level pattern, D7).
2. **THE SHIP GATE — Peter approves, or it doesn't leave the machine.**
   Local commits are free. Push, merge to main, deploy, Supabase SQL
   execution, Railway env changes, Twilio routing changes — never without
   Peter's explicit approval. The full list, including production-sensitive
   *code areas* that need approval even for local design changes, lives in
   [references/safety-boundaries.md](references/safety-boundaries.md) —
   re-read it before any commit that touches auth, prompts, RLS, billing, or
   call routing.
3. **`docs/INDEX.md` is the entry point to truth — and live code outranks
   every doc.** Start every batch by reading INDEX.md and the owning doc for
   each fact you need (env vars → DEPLOYMENT.md, security posture →
   SECURITY_REVIEW.md, mobile API → docs/MOBILE_API_CONTRACT.md, VoIP
   contracts → docs/VOIP_V2_BACKEND_SPEC.md). **Never spec from memory.
   Never trust a stale doc over the code** — several docs carry known-stale
   sections (dated update notes mark them); when a doc and the code disagree,
   the code is the truth and the doc gets a dated correction in the same batch.
4. **EVIDENCE CONTRACT.** Every recon/review finding needs quoted code +
   `file:line`. Negative claims ("X isn't wired") need the exact grep patterns
   tried. No evidence → the finding is discarded, not "probably true"-ed into
   a spec.
5. **REQUIREMENTS LEDGER.** Every implementation batch opens
   `.agent/LEDGER.md` (fixed path, gitignored, overwritten per batch) with one
   checkbox per requirement. No batch is complete while an open `- [ ]` box
   remains. Details in [references/workflow.md](references/workflow.md) §Ledger.
6. **ONE LOGICAL COMMIT PER SLICE.** Each completed engineering slice — a
   coherent unit that stands alone (a route + its tests + its docs) — is one
   local commit with a message explaining why. Never giant mixed commits;
   never commit halfway states; never commit directly on `main`.
7. **IMPLEMENTATION ≠ REVIEW.** Whoever wrote a change does not get the last
   word on it. Every batch ends with an adversarial review pass (attack auth,
   tenant isolation, flag gating, the pipeline) done *as a reviewer*, plus the
   verification stack in [references/workflow.md](references/workflow.md).
   Findings get fixed before reporting, not disclosed as caveats.
8. **PHASE RE-READ.** On entering a phase, re-read its reference file (map
   below). Instructions decay over a long session; the re-read is mandatory
   no matter how well you remember it.

## Model & delegation routing (credit economy)

Peter pays per credit; Fable is the expensive model. The routing rule:

**Fable-reserved (never delegate the judgment):** architecture, security,
authentication, Twilio/VoIP design, compliance, implementation planning,
specs, adversarial review, final decisions, and Peter-facing reports. Writing
these IS the orchestrator's job — delegating them saves nothing because the
prompt would have to contain the whole content.

**Delegate to lower-cost agents/models (haiku/sonnet) when available:**
repository exploration, documentation extraction, repetitive implementation,
test writing from a written spec, link checking, summarisation, mechanical
refactors, browser verification. Use the `Explore` agent type for read-only
recon; pass `model: "haiku"` for mechanical work and `model: "sonnet"` for
implementation from a spec.

**The counter-rule — don't delegate at a loss.** Every spawn starts cold and
re-derives context. A single-seam edit, a one-file read, or a script you can
run in one Bash call is cheaper done inline than the delegation prompt would
cost. Delegate when the work is *voluminous or mechanical*; do it inline when
it's small and you already hold the context. When a batch involves reading
many files whose contents you don't need verbatim — delegate. Full routing
table and prompt templates: [references/delegation.md](references/delegation.md).

## Phase map

| Phase | What happens | Re-read |
|---|---|---|
| 0. Orient | INDEX.md + owning docs + memory; confirm branch | this file |
| 1. Recon | Ground the task in `file:line` evidence (delegate broad sweeps) | [references/delegation.md](references/delegation.md) §Recon |
| 2. Spec + Ledger | Fable writes the spec; open `.agent/LEDGER.md` | [references/workflow.md](references/workflow.md) §Spec |
| 3. Implement | Flag-gated, house-style, dep-free-testable | [references/workflow.md](references/workflow.md) §Implement |
| 4. Verify | Syntax → `npm test` → link check → regression → adversarial review | [references/workflow.md](references/workflow.md) §Verify |
| 5. Browser verify | Web-visible change? Browser agent loop until clean | [references/browser-verification.md](references/browser-verification.md) |
| 6. Smoke | Per the required/not-required matrix | [references/workflow.md](references/workflow.md) §Smoke |
| 7. Report + gate | Ledger check → commit → report to Peter → WAIT | [references/workflow.md](references/workflow.md) §Report |

React Native work adds a device/emulator dimension on top of this map —
[references/react-native.md](references/react-native.md) defines what can be
browser-verified and what can only be proven on a device.

## AIDA house rules (the repo's non-negotiables)

- **Tests run WITHOUT node_modules.** `npm test` is `node --test` on a bare
  checkout. Any `src/` module a test imports must lazy-require heavy deps
  (`twilio`, `@supabase/supabase-js`) inside functions. Test route/middleware
  logic via injected-deps factories (`createRequireClientAuth(deps)` pattern),
  never supertest. Pure decision cores + thin DB adapters is the house style.
- **SQL never runs from here.** Schema changes ship as reviewed files in
  `supabase/sql/` (like `phase1b_create_devices.sql`), applied by a human.
  New tables are born with RLS in the same transaction (D8) — no exceptions.
- **Secrets live in Railway env only.** Never in the repo, never echoed into
  agent output, never in test fixtures. `DEPLOYMENT.md` owns the env var list;
  update it in the same commit that introduces a new var.
- **Docs single-source rule:** each fact has one owning doc; everyone else
  links. Adding a doc means adding its INDEX.md catalogue row in the same
  commit.
- **Match surrounding code**: CommonJS, comment density that explains *why*,
  structured single-line log tags (`voip.token.mint client=…`).

## Invocation

Future sessions: invoke with `/aida-orchestrate` (or the Skill tool) at the
start of any implementation task, then follow the phase map. If the session
was compacted mid-batch, re-read this file and `.agent/LEDGER.md` before
resuming — the ledger, not conversation memory, is the state of record.
