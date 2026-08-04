# M8A — Launch-Ready Locksmith Onboarding Journey

**Status:** built dormant. **Flag:** `LOCKSMITH_ONBOARDING_ENABLED` — unset in
every environment, so every route 404s before any auth runs.
**SQL:** none new. Reuses `supabase/sql/lpm2_create_locksmith_onboarding.sql`
(**still not applied**). **Nothing deployed. No customer onboarded. No call
placed. No message sent.**

This document owns: the setup step declaration, the working-draft lifecycle, the
review/approval flow for a *typed* setup, contradiction detection, the
version-history and rollback contract, and the voice-teaching compatibility
argument.

It does **not** own: the canonical profile schema
([LOCKSMITH_ONBOARDING_SPEC.md](LOCKSMITH_ONBOARDING_SPEC.md)), the change-request
domain ([LOCKSMITH_CLIENT_PORTAL_SPEC.md](LOCKSMITH_CLIENT_PORTAL_SPEC.md)),
provisioning ([RETELL_INTEGRATION_SPEC.md](RETELL_INTEGRATION_SPEC.md)) or
environment variables ([../DEPLOYMENT.md](../DEPLOYMENT.md)).

---

## 1. The gap this closes

Everything downstream of "a draft profile exists" was already built and working:
versioning, review, per-section confirmation, the approval guard, the audit
trail, the compiler, the test-plan generator.

**Nothing created that first draft except an operator pasting a call
transcript.** The evidence, taken against the code at `423b97e`:

| Claim | Evidence |
|---|---|
| The only client-facing onboarding routes were review and approval | `src/routes/locksmith-onboarding.js:33-37` |
| The only transcript ingestion path was operator-only | `src/routes/locksmith-onboarding.js:47`, behind `requireLogin` |
| Session creation was unreachable | `grep -rn "createSession(" src/ scripts/ test/` outside its own module → zero hits; `locksmith-onboarding-session.js:210` had no caller |
| The M5 portal was display-only | `grep -c "<form\|<input\|<button\|<select\|<textarea" src/views/locksmith-portal-page.js` → **0**; its three POST endpoints had no UI |
| Test status could never be non-empty | `src/routes/locksmith-portal-handlers.js:118` calls `projectTestStatus([], …)` with a hardcoded empty array |
| A notification recipient could not be added without SQL | `locksmith-portal-handlers.js:261,270` pass `current.destinations` straight through; `locksmith-notification-preferences.js:614` returns `{}` when absent. No code path writes a destination |
| The M7A feedback loop had no HTTP consumer | `createChangeApplicationService`, `createApprovalService` and the change-extraction module were imported only by `scripts/frankston-demo.js` and tests |
| The v1 questionnaire persisted nothing | `public/onboarding.html:833` — `localStorage.setItem(…)` and `console.log`. Pure UI |

So onboarding a real locksmith required a founder with SQL access. That is the
launch blocker M8A removes.

---

## 2. Information architecture

Eleven stages. Seven collect answers; four are decisions.

| # | Stage | Kind | Owns |
|---|---|---|---|
| 1 | Your business | form | Name callers hear, legal name, public number, owner name and email, receptionist name, greeting, state, description |
| 2 | The work you take | form | Tri-state per service, proof-of-ownership reminder, exclusions in the owner's words |
| 3 | Where you go | form | Covered / stretch-to / won't-go suburbs, the unlisted-suburb rule, a smaller after-hours area |
| 4 | When you work | form | Day-by-day hours, after-hours availability and terms, public holidays, approved callback estimates |
| 5 | How we handle a job | form | Urgency presets, what to collect on every call, pricing authority, things never to say |
| 6 | Reaching you | form | Transfer recipient, backup, permitted hours, unanswered fallback, notification recipients and timing |
| 7 | How we sound | form | Tone, phrases to use or avoid, recording preference, retention, redaction |
| 8 | Check it over | review | Read-back, blockers vs warnings, contradictions, the safety floor |
| 9 | Approve | approve | Per-section confirmation, versioned approval, audit event |
| 10 | Test it | test | Generated test-call checklist, truthful test status |
| 11 | Go live | activate | Remaining blockers, next steps, and a control that stays disabled |

Declared in `src/services/locksmith-onboarding-steps.js` as `STAGES`.

### The three questions a step answers

Each field carries `read` and `apply` rather than a dot path, because several
canonical fields are not scalars — services are a tri-state across two arrays,
hours are a day grid, urgency rules are objects behind presets. A path-setter
would have forced those shapes into the UI. The declaration owns both directions
instead, so the renderer, the validator, the resume path and a future voice agent
agree by construction.

`apply` never mutates its argument; it returns a new profile. The approved
profile is read fresh on every request and must survive being read.

---

## 3. Voice-teaching compatibility (Release 2)

The requirement: Release 2 lets an owner ring a configuration number, explain a
change, and get the same versioned draft. That must not need a second onboarding
model.

It does not, because:

1. **The questions are declared once.** Every step names the
   `locksmith-interview-spec.js` question groups it covers, and every field
   carries a `spoken` form — the sentence a voice agent asks. A test asserts that
   every interview group with `mustEstablish` keys is reachable from some step,
   so the two channels cannot drift apart silently.
2. **The service is channel-neutral.** `createOnboardingDraftService` takes plain
   data. `sourceChannel` is recorded and never branched on. `client_ui` and
   `initial_voice_onboarding` reach the same `saveStep`, the same validators, the
   same versioning and the same audit trail. A test drives the whole first step
   through the voice channel to prove it.
3. **Confirmation accepts both vocabularies.** The review page sends a step id;
   an API or voice caller may send a raw profile section key. Both resolve to the
   same set of ticks.
4. **Authorisation is identical.** Voice does not get a weaker rule: the actor's
   tenant must match the target tenant, on every entry point.

What Release 2 still has to build: the call runtime, the interview policy, and
read-back evidence for safety-critical fields. None of it requires changing this
service.

---

## 4. The working-draft lifecycle

A working draft is a `locksmith_business_profiles` row with `status = "draft"`.
**No new table.** It inherits the RLS-at-birth and the one-approved-per-client
partial unique index already written in `lpm2`.

```
        startDraft
            │
            ▼
      ┌──────────┐  saveStep (many)     writes ONLY where status = 'draft'
      │  draft   │◄────────────┐
      └────┬─────┘             │
           │ submitForReview   │ reopenForEditing (clears every tick)
           ▼                   │
   ┌───────────────┐───────────┘
   │ needs_review  │  confirmSection (×7 steps → 12 sections)
   └───────┬───────┘
           │ approve  ← the M2 approval guard, unmodified
           ▼
     ┌──────────┐  supersedes the previous approved version
     │ approved │
     └──────────┘
           │ rollbackToVersion → copies into a NEW draft; this row is untouched
           ▼
      (new draft)
```

### The safety property

`store.updateDraftProfile` filters on `.eq("status", "draft")`. `needs_review`,
`approved`, `superseded` and `rejected` rows are unreachable from the setup
surface, so no amount of form traffic can alter a configuration that is live or
under review. A zero-row update is reported as a conflict, never as a silent
success. A test drives all four non-draft statuses through it and asserts each is
refused.

### Design decisions

- **`startDraft` is idempotent.** An owner with two tabs open, or a voice agent
  reconnecting after a dropout, lands on the same draft rather than forking.
- **`startDraft` seeds from the approved profile when one exists**, so "change my
  setup" starts from what is live. That is what makes this one journey rather
  than two: first-time setup and a later edit are the same entry point.
- **`startDraft` reports a submitted version rather than forking past it.** The
  first implementation did fork, seeding a new draft from the approved profile —
  or from blank, for a first-time client — so an owner who opened setup after
  submitting saw an empty form and would reasonably conclude they had lost
  everything. Now the page redirects to review.
- **Reopening uses `needs_review → draft`**, already a legal transition and until
  M8A never used. Every confirmation is cleared in the same write, because a tick
  recorded against words that have since changed is worse than no tick.
- **Rollback copies rather than resurrects.** History stays byte-identical; the
  restored settings go through review and approval like any other change.
- **A draft is written even when incomplete.** Submission, review and approval
  each re-check, so an incomplete draft is inert.

---

## 5. Review: three kinds of problem, kept apart

| Question | Answered by |
|---|---|
| Is this shape legal? | `validateProfile` |
| Is anything missing that would stop us building it? | `assessProvisioning` |
| Is anything here at odds with something else here? | `detectContradictions` (new) |

The third is the one a form cannot catch field by field, because each answer is
individually fine. Every finding names the step that fixes it, so the review page
links to the box rather than describing it.

| Code | Severity | What it catches |
|---|---|---|
| `suburb_in_two_lists` | blocker | The same suburb covered and declined (case-insensitive) |
| `transfer_is_public_number` | blocker | Urgent callers sent back to the line they just rang |
| `after_hours_area_declined` | blocker | A "won't go" suburb on the after-hours list |
| `service_accepted_and_declined` | blocker | Possible from extraction or rollback, not from the wizard |
| `backup_missing` | blocker | "Try the second number" with no second number |
| `transfer_rule_without_number` | blocker | Calls set to go straight through, with nowhere to go |
| `backup_is_public_number` | warning | The backup is the public line |
| `after_hours_areas_without_after_hours` | warning | After-hours detail on a business that says it does not work after hours |
| `after_hours_estimate_without_after_hours` | warning | As above, for callback estimates |
| `pricing_wording_unusable` | warning | Pricing wording that can never be spoken |

A warning the owner cannot distinguish from a blocker teaches them to ignore
both, so the two render as separate lists with different non-colour markers, and
a test asserts no code appears in both.

### Confirmation coverage

The owner ticks the **seven steps** they filled in; the approval guard counts the
**twelve** canonical profile sections. Each step declares `profileSections`, and
one tick records every section that step owns. Three tests hold this together:
every claimed section exists, the union equals `CONFIRMATION_KEYS`, and no
section is claimed twice. Without them, a safety-critical section could become
unreachable and approval permanently blocked — or worse, silently skipped.

`forbiddenPromises` has no editable field: it is the always-on safety floor,
shown in full on the review page and described as unchangeable. It is confirmed
with step 5, which is where the owner is told what we will never say.

---

## 6. Approval, and why it is not on the M2 review page

The M2 review page is keyed on an onboarding **session** — "one attempt to
onboard a locksmith by voice". Its state machine
(`locksmith-onboarding-session.js:31-41`) requires `transcript_received` and
`extraction_pending` on the way to `needs_review`. A typed setup has no
transcript, and inventing a fake one to satisfy the machine would corrupt the
meaning of every session row.

So review and approval for a typed setup live on the setup surface —
**on the same store functions and behind the same guard**. `approve` delegates
wholesale to `store.approveVersion`, which runs tenant authorisation, staleness,
lifecycle, full profile validation, every provisioning blocker and every required
confirmation. The setup service adds no rule of its own and relaxes none.

Approval makes settings *eligible to be built*. It does not switch a phone over,
and the response says so (`activated: false`).

---

## 7. Activation stays gated

There is no route that activates anything. `GET …/activate` renders a page and
stops; a test asserts the path is not POSTable.

The page separates **blockers** (the client's work: finish the answers, approve
them, fix anything in the settings) from **next steps** (our work: the number
switch-over, the joint test call). An earlier version listed the switch-over as a
blocker, which made the blocker list permanently non-empty, the "ready" branch
dead code, and a client who had done everything asked of them was told
"Not ready yet". The control stays disabled either way — switching a real
business's phone over is arranged on a call with a person.

---

## 8. Mobile and accessibility

320px is a real target: this form is filled in on a phone, in a van, between
jobs. Enforced by test, not by intention:

- every media query widens (`min-width` only) — the base styles *are* the mobile
  styles;
- no fixed pixel width exceeds 296px (320 minus the 12px gutters);
- inputs are 16px, so iOS does not zoom on focus and throw the layout;
- tap targets are ≥44px on `.input`, `.choice`, `.checkbox` and `.btn`;
- long values wrap rather than forcing a horizontal scroll.

Accessibility is structural rather than decorative: a real `<label for>` per
input, `<fieldset>`/`<legend>` for every group of related controls,
`aria-describedby` wiring help and error text, `aria-invalid` on failure, focus
moved to the first invalid control, one `aria-current="step"` in an ordered stage
list, a skip link, and a single polite live region. `prefers-reduced-motion` and
`prefers-contrast` are honoured. No state is signalled by colour alone.

### Why the form is submitted as JSON

The repo's CSRF protection is that every state-changing endpoint requires
`Content-Type: application/json`, which a cross-site form post cannot set without
a preflight. Posting this form the ordinary way would mean accepting urlencoded
bodies and forfeiting exactly that protection. The `<form>` element is still a
real form — Enter submits it, assistive technology sees a form, every control is
labelled — only the transport is ours. A `<noscript>` says so plainly rather than
letting answers vanish.

The page's CSP is `style-src 'self'; script-src 'self'`, with no
`unsafe-inline`. Tests assert the rendered markup contains no inline style
attribute, no `<style>` block, no inline event handler and no script with a body.

---

## 9. Vocabulary

No provider name, internal id or implementation term reaches the client. A test
strips the markup from every rendered page and asserts none of ~20 forbidden
terms appears, and that no raw enum value is ever printed as an answer —
a review page that says `collect_details_for_confirmation` has not been read back.

Three things are stated in the UI because getting them wrong is expensive:

- the transfer number is **separate from the public business number**, and why;
- text-message delivery is built but **not switched on yet**, pending carrier
  approval, so summaries go by email today;
- a callback estimate is when a **person rings back**, not when anyone arrives,
  and is never spoken as a promise.

---

## 10. Founder walkthrough

`node scripts/locksmith-setup-walkthrough.js` runs the brief's scenario end to
end: blank state, seven steps, save and resume, a refused answer, a contradiction
caught and corrected, Frankston covered / Mornington extended / Dandenong
declined / Springvale unknown, no automotive work, proof of ownership, callback
estimates, after-hours handling, a notification recipient, transfer rules, tone,
review, submission, seven confirmations, approval, compilation, an 18-case test
checklist, the go-live gates and a rollback.

Substituted and stated in the output: an in-memory store, so no SQL is applied
and no database is touched. **Not** substituted: the step declaration, every
validator, `assessProvisioning`, the contradiction detector, the draft service,
the approval guard, the receptionist compiler and the test-plan generator. If it
prints "approved", the production guard approved it.

It refuses to run with `NODE_ENV=production`, and never contacts a provider,
places a call or sends a message.

---

## 11. What is still manual

| Step | Why it is not automated |
|---|---|
| Applying `lpm2_create_locksmith_onboarding.sql` | One-time schema change, applied by a human per the repo's iron law. Not per-customer, so the brief's "never require SQL for ordinary customer setup" holds |
| Creating the client row and invite | Existing procedure — [../CLIENT_ONBOARDING_RUNBOOK.md](../CLIENT_ONBOARDING_RUNBOOK.md) |
| Provisioning the receptionist at the provider | [RETELL_INTEGRATION_SPEC.md](RETELL_INTEGRATION_SPEC.md); gated, unexecuted |
| The number switch-over | Deliberate. Arranged on a call, with the owner listening |
| Recording test-call results | No result store exists. The test page generates the checklist and reports "no results recorded" truthfully rather than implying a pass |

---

## 12. Files

| File | Role |
|---|---|
| `src/services/locksmith-onboarding-steps.js` | The step declaration — one model for form and voice |
| `src/services/locksmith-onboarding-draft.js` | Channel-neutral draft service, contradiction detection, review summary |
| `src/services/locksmith-profile-store.js` | `getWorkingDraft`, `getSubmittedVersion`, `updateDraftProfile`, `submitDraftForReview`, `reopenDraft` |
| `src/routes/locksmith-setup-handlers.js` | Express-free handlers |
| `src/routes/locksmith-onboarding.js` | Route wiring, behind the existing gate |
| `src/views/locksmith-setup-page.js` | Server-rendered pages |
| `public/locksmith/setup.css` | Mobile-first stylesheet |
| `public/locksmith/setup.js` | ES5, no build step |
| `scripts/locksmith-setup-walkthrough.js` | The founder scenario |
| `test/locksmith-setup-journey.test.js` | Service layer |
| `test/locksmith-setup-ui.test.js` | Routes, rendering, mobile, accessibility, vocabulary |
