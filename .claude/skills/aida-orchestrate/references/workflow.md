# Workflow — phases, ledger, verification stack

Re-read the relevant section when ENTERING the phase (Iron Law 8). Agent
prompt templates live in [delegation.md](delegation.md); browser specifics in
[browser-verification.md](browser-verification.md); the approval boundaries in
[safety-boundaries.md](safety-boundaries.md).

## §Orient (phase 0)

1. Read `docs/INDEX.md`, then the owning doc for every fact the task touches.
   Do not skim from memory of a previous session — docs move.
2. `git status` + `git log --oneline -5`: confirm the branch (feature branch,
   never `main`), confirm a clean tree, note whether prior work is committed.
3. If `.agent/LEDGER.md` exists with open boxes, a previous batch is
   unfinished — surface that to Peter before starting new work on top.

## §Recon (phase 1)

Ground every claim the spec will rely on in current code: quoted snippet +
`file:line`. Delegate broad sweeps (many files, naming-convention hunts) to an
`Explore` agent per [delegation.md](delegation.md) §Recon; read single known
files inline. Evidence contract applies to your own recon exactly as it does
to agents': negative claims list the greps tried.

Known truth hierarchy: **live code > dated update notes in docs > doc body
text**. `SECURITY_REVIEW.md`, `DEPLOYMENT.md` and `TEST_PLAN.md` carry
transitional/stale sections — check for dated update notes before trusting a
sentence.

## §Spec + Ledger (phase 2)

A spec is execution-ready when someone with zero session context could
implement it: exact files and line anchors (from recon, never memory),
before/after behaviour including negative cases, checkable acceptance
criteria, and honesty gates (what to STOP and report rather than improvise).

**The Requirements Ledger — open it here.** Overwrite `.agent/LEDGER.md`
(fixed path, gitignored — never committed, never per-batch files) with one
checkbox line per requirement — every spec item AND every instruction in
Peter's message, verbatim enough to be checkable:

```
- [ ] open
- [x] done (file:line or commit)
- [~] deferred: <reason Peter approved>
```

Rules: lines are never deleted mid-batch, only ticked or deferred. New
feedback mid-batch → append lines. The ledger survives compaction and session
breaks — trust it over conversation memory. **No batch is complete while an
open box remains** (checked again at §Report). Clear/delete the file only
after the batch is committed and reported.

## §Implement (phase 3)

- Route work per [delegation.md](delegation.md): mechanical/voluminous →
  lower-cost agents with disjoint file lists; judgment-bearing seams
  (auth, tenant scoping, TwiML, guards) → Fable.
- Risky or not-yet-live behaviour goes behind the two-level flag pattern
  (server env kill switch + per-client column, D7). Flag-off behaviour must be
  byte-identical to the code not existing.
- Honour the house rules (SKILL.md): dep-free testability, lazy requires,
  pure cores + injected fakes, RLS-at-birth for any new table's SQL file.
- Agents never commit. Fable commits, one logical slice at a time, after §Verify.

## §Verify (phase 4) — the standard stack, in order

| Step | Command / act | When |
|---|---|---|
| 1. Syntax | `node --check` every touched `.js` | any script/config touched |
| 2. Unit tests | `npm test` (full suite, not just touched files) | any `src/` or `test/` change |
| 3. Doc links | link-check script over `*.md` (write a 20-line checker in the scratchpad if none exists; verify relative links resolve) | any doc change |
| 4. Targeted regression | prove the specific invariant your change threatens (e.g. flag-off pass-through, cookie-mode bodies unchanged, voicemail TwiML frozen-equality) | judgement — see below |
| 5. Adversarial review | attack your own diff: auth bypass, tenant crossover, flag leaks, replay, fail-open paths, pipeline breakage. Fix findings now, don't footnote them | every implementation batch |
| 6. Browser verification | [browser-verification.md](browser-verification.md) | web-visible behaviour changed |
| 7. Smoke | see §Smoke matrix | per matrix |

Targeted regression means: name the existing behaviour your diff could have
broken, and point to (or add) the test that proves it didn't. The repo's
precedents: frozen-TwiML string-equality tests, flag-gate pass-through tests,
"cookie-mode body byte-identical" assertions.

## §Smoke matrix (phase 6)

`npm run smoke` is black-box HTTP against a **running instance**
(`smoke/README.md`). It performs no mutating writes and is safe against
production. Locally it needs `npm install` once, a `.env`, and a running
server — if no runnable target exists, say so explicitly in the report; never
claim smoke passed when it didn't run.

**Smoke required before reporting complete:**
- auth changes (operator, client, bearer — anything in `middleware/auth.js`,
  `routes/client-auth*`, `services/client-auth*`, `services/client-session*`)
- dashboard API changes (`/calls`, `/client-dashboard`, `/settings`,
  `/voicemail`, `/personal-contacts`)
- call pipeline changes (`inbound.js`, `recording.js`, `call.js`, TwiML
  helpers, `analyse`/`followup`/`notify` chain)
- production-facing route changes (anything mounted in `server.js`)
- RLS-adjacent changes (tenant scoping, `req.clientId` derivation, SQL files)
- prompt-generation changes (`services/prompts.js`, `followup.js`,
  `draft-guard.js`, `business-profile.js`)

**Smoke NOT required:**
- documentation-only work
- skill-only work (`.claude/`)
- non-runtime planning docs, ledgers, memory
- test-only additions that touch no `src/` file

**Manual live-Twilio checklist** (`smoke/MANUAL_CHECKLIST.md`): only when call
routing is involved (Twilio webhooks, TwiML, forwarding, number config) — and
it is run by Peter at deploy time, not simulated from here.

## §Report + ship gate (phase 7)

1. **Ledger check:** read `.agent/LEDGER.md`. Any open `- [ ]` → the batch is
   NOT done; finish or get Peter's explicit deferral (`[~]` with reason).
2. Commit the final slice (one logical commit; message says why; end with the
   Co-Authored-By line).
3. Report to Peter: outcome first, then what changed, verification evidence
   (test counts, smoke result or why not run, browser findings), deferred
   items, and — separately flagged — anything awaiting his approval gates.
4. **WAIT.** Push/merge/deploy/SQL happen only on Peter's explicit
   instruction. His silence, or him testing, is not approval.
5. After the batch is complete and committed: clear `.agent/LEDGER.md`.

Feedback from Peter before approval → new ledger lines, back to phase 3.
