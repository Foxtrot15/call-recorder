# Delegation — model routing, evidence contract, prompt templates

The economic rule (Peter's standing instruction): **lower-cost models wherever
they suffice; Fable only where judgment is the product.** But a spawn has a
fixed cost — a cold agent re-derives context — so tiny tasks are cheaper
inline. Delegate *volume and mechanism*; keep *judgment and small seams*.

## Routing table

| Work | Route | Why |
|---|---|---|
| Architecture, security, authentication design | **Fable, inline** | judgment is the product |
| Twilio/VoIP design (TwiML, guards, invariants INV-1..6) | **Fable, inline** | loop/consent/fraud stakes |
| Compliance reasoning (AU recording consent, BDM engine) | **Fable, inline** | legal-adjacent judgment |
| Implementation planning, specs, doctrine docs, this skill | **Fable, inline** | the spec IS the thinking |
| Adversarial review, final decisions, Peter-facing reports | **Fable, inline** | accountability |
| Security-critical code seams (auth middleware, tenant scoping, crypto) | **Fable, inline** | reviewing a delegate costs more than writing it |
| Repository exploration / broad recon | **Explore agent** (`model: haiku`, breadth stated) | volume, read-only |
| Documentation extraction / summarisation | **agent, `model: haiku`** | mechanical |
| Repetitive implementation from a written spec | **agent, `model: sonnet`** | volume, spec carries the judgment |
| Test writing from a written spec | **agent, `model: sonnet`** | volume; Fable reviews |
| Mechanical refactors (renames, extract-helper sweeps) | **agent, `model: sonnet`** | mechanical |
| Link checking, file counting, format sweeps | **inline script first**, agent only if genuinely large | a 20-line Bash/node script beats any spawn |
| Browser verification | **agent** (general-purpose, `model: sonnet`) with browser tools | volume + evidence gathering |

Inline-over-spawn test: *"Is the delegation prompt (context + spec + report
reading) more tokens than doing it myself?"* One file, one seam, ≤~20 lines,
context already in hand → inline. Many files, repeated pattern, or content you
don't need verbatim in your own context → delegate.

Never trade agent context quality for agent token savings: a delegated task
gets a FULL prompt (what Aida is, why the task is safe/benign, file:line
anchors, acceptance criteria). Under-contexted prompts produce weak results
and false-positive refusals; a refusal means respawn fresh with fuller
legitimate context, never argue in place and never silently absorb the work.

## Evidence contract (all recon and review, agents AND Fable)

- Every finding: quoted snippet (≤5 lines) + `file:line`.
- Every NEGATIVE finding ("X isn't wired", "no route exists"): the exact grep
  patterns and paths tried. Distinguish "verified absent" from "didn't look".
- No evidence → discard the finding.
- Verification is asymmetric: verify claims that would trigger new work
  ("X is broken" → build/fix) before acting; polish notes don't need a
  verification pass.

Cap every agent report at ~300 words — reports land in Fable's context, which
is the expensive one.

## AIDA class-detection (fix the class, guard the healthy)

When a defect or change is found on one surface, enumerate its siblings via
grep before finishing — the same idiom usually lives in more than one place.
Known AIDA instance pairs:

- **The two dashboards:** operator (`public/index.html`, `requireLogin`) vs
  client (`public/client-dashboard.html`, `requireClientAuth`) — auth-adjacent
  fixes usually have a twin.
- **The two auth transports:** cookie mode vs Bearer mode share one path by
  design — any auth change must be tested in BOTH modes, and a fix that forks
  them is a design smell.
- **The Google-service triplication:** `gmail.js` / `gcal.js` / `notify.js`
  each carry a copy of OAuth token refresh (backlog P2-1). A fix applied to
  one copy MUST be applied to all three until they're unified.
- **The two voicemail TwiML sites:** `inbound.js` voicemail flow and
  `voip-dial.js`/`dial-result` fallback share `voicemail-twiml.js` — never
  reintroduce a divergent copy.
- **The two test suites:** `test/` (unit, dep-free) and `smoke/` (black-box
  HTTP) — a contract change often needs both updated.
- **Rate limiters:** VoIP routes and client-auth handlers each hold limiter
  instances — a limiter policy fix applies to both.

The boundary: a surface WITHOUT the defect is not a sibling. Never change a
healthy surface's behaviour for "consistency" while doing something else —
especially anything in the live v1 pipeline.

## Prompt templates

### §Recon (Explore agent, model: haiku; sonnet if the question needs inference)

```
Recon task: <one-sentence goal>. Search breadth: <medium|very thorough>.

This is Aida, a Node/Express call-capture service (see docs/INDEX.md).
Ground the following in the codebase with exact evidence:
<numbered questions — where X is wired, what touches Y, signatures, data flow>

EVIDENCE CONTRACT (mandatory — findings without it will be discarded):
- Every finding: quoted snippet (≤5 lines) + file:line.
- Every NEGATIVE finding: the exact grep patterns and paths tried.
- Distinguish "verified absent" from "didn't look".

Do not editorialize or propose designs. Report ≤300 words.
```

### §Implementer (model: sonnet)

```
You are the IMPLEMENTER. Do the work yourself with Read/Edit — do NOT spawn
agents. Your report describes work already done. Branch: <branch>.

CONTEXT: Aida is a live multi-tenant call-capture service. This task is
<benign purpose>. Docs: <owning doc paths>.

FILES YOU OWN (touch nothing else):
<list — disjoint from any parallel agent>

SPEC:
<per file: change anchored to file:line; before/after behaviour; edge cases>

HOUSE RULES (non-negotiable):
- npm test runs WITHOUT node_modules: lazy-require twilio/@supabase/supabase-js
  inside functions; testable logic = pure core + injected deps.
- Match surrounding style (CommonJS, why-comments, structured log tags).
- New behaviour that could touch production flows goes behind the existing
  flag gates; flag-off must be byte-identical to before.
- Never touch secrets, .env, supabase/sql (SQL ships as review-only files),
  or anything in middleware/auth.js unless the spec names it.

ACCEPTANCE CRITERIA:
<checkable list — "npm test green", "flag-off path unchanged", specific asserts>

Do NOT commit. If the spec conflicts with the code you find, STOP and report
the conflict with file:line — don't improvise. Report ≤300 words: files
changed, one line each, conflicts found.
```

### §Verifier (model: haiku) — one claim, before it triggers work

```
Verify ONE claim. Do not explore beyond it.
CLAIM: "<exact claim>"
WHERE TO LOOK: <file:line from the original finding>
Answer TRUE / FALSE / PARTIALLY TRUE with a quoted snippet + file:line.
Negative claims: run the greps yourself and list them. ≤150 words.
```

### §Browser verification (model: sonnet)

Use the full template in [browser-verification.md](browser-verification.md) —
it carries the credential rules and the fix-loop contract.

## Operational notes

- Agents never commit; Fable commits after seam-review.
- Parallel implementers get disjoint file lists; shared files (server.js
  mounts, barrel-ish modules) are a final single wiring pass.
- Spawn independent agents in one message; end the turn after dispatch with a
  one-line status — completion re-invokes automatically. Don't poll.
- If an agent is interrupted, its partial work may be on disk: `git status` /
  `git diff` before assuming a clean tree.
