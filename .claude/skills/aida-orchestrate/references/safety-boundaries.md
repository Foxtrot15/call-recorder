# Safety boundaries — what needs Peter, what never happens, what's free

Aida runs in production for a real business. These boundaries are the
difference between "engineering velocity" and "an incident". Re-read this
file before any commit touching auth, prompts, RLS, billing, or call routing
(Iron Law 2).

## NEVER without Peter's explicit approval

- **push** (any branch, any remote)
- **merge** (especially anything into `main` — Railway auto-deploys `main`)
- **deploy** (Railway, or anything that changes what production runs)
- **execute Supabase SQL** against the live project (SQL ships as reviewed
  files in `supabase/sql/`, applied by a human per RLS_APPLY_CHECKLIST-style
  procedure)
- **modify Railway production variables**
- **modify Twilio production routing** (number webhooks, forwarding codes,
  TwiML apps)
- **change runtime production behaviour** in any other way

Approval is per action, explicit, and current — approval for one deploy does
not roll over to the next. Silence is not approval. Peter testing something
is not approval.

## Production-sensitive areas — Peter approves the CHANGE, not just the ship

Code or design changes in these areas get flagged to Peter before they're
treated as decided, even though committing locally is allowed:

- Supabase SQL / migrations intended for the live project
- RLS policy changes (current posture: deny-by-default, no policies,
  service-role only — weakening this is never a side effect)
- Twilio webhook or routing changes
- Railway env var changes (including *new required* vars — a deploy
  precondition is a production change)
- authentication behaviour changes (operator, client, bearer — anything that
  alters who gets in or how sessions live; the dual-transport contract in
  `docs/MOBILE_API_CONTRACT.md` is additive-only by promise)
- prompt-generation behaviour changes (`prompts.js`, `followup.js`,
  `draft-guard.js`, grounding rules — the contamination incident lives in
  `docs/LLM_PROMPT_CONTAMINATION_INVESTIGATION.md`; its fixes are load-bearing)
- payment/billing changes
- outbound BDM compliance logic (`docs/OUTBOUND_BDM_COMPLIANCE_ENGINE.md` —
  compliance gates are never "refactored" casually)
- live call-routing changes (anything that alters what happens when a real
  phone rings: `inbound.js` branches, loop guards INV-1/INV-5, dial targets)
- anything merged to `main`; anything deployed to Railway

## Standing rules (no approval can waive these)

- **Do not expose secrets.** Env values never appear in code, commits, agent
  prompts, reports, screenshots, or test fixtures. `DEPLOYMENT.md` documents
  *names*, never values. `.env` is gitignored — keep it that way.
- **Do not weaken RLS.** New tables are born with RLS in their creation
  transaction (D8). No policy is added or broadened as a convenience.
- **Do not bypass smoke tests.** If the workflow matrix says smoke is
  required and it can't run, the report says "smoke not run because X" —
  it never says "done" without it.
- **Keep risky work behind feature flags.** The two-level pattern (server
  env kill switch + per-client DB flag, both default off — D7) is the
  template. Flag-off must be byte-identical to the feature not existing.
- **Preserve the existing inbound/missed-call pipeline** unless Peter
  explicitly instructs otherwise. This is the prime directive: v1 capture is
  the business.
- **Loop-guard invariants stand independent of flags:** INV-1 (never PSTN-dial
  a CFU'd number) keys off `clients.voip_enabled` alone, deliberately — the
  kill switch disables the feature, not the loop physics. Never "simplify"
  that.

## Free to do without asking (Peter's standing grant)

- edit documentation; reorganise docs (keep INDEX.md + single-source rules
  intact in the same commit)
- create/edit Claude Code skills and reference documents
- create/refactor tests (respecting the dep-free convention)
- improve developer workflow (scripts, CI config as *files* — enabling live
  CI secrets is a Peter action)
- commit locally, one logical slice per commit, on a feature branch
- write scratch files in the session scratchpad; maintain `.agent/LEDGER.md`

When genuinely uncertain which side of a line something falls on, it falls on
the ask-Peter side — but bring a recommendation, not an open question.
