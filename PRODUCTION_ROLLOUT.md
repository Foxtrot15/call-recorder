# Aida — Production Rollout Runbook

_Rolling out commit `1cdeaaa` (auth isolation + /calls API) and then RLS.
Current state when this was written: commit exists locally on `main`,
**not pushed**; `OPERATOR_CLIENT_ID=default` already set in Railway._

## Exact order

### 1. Pre-push checks (5 min)
- [ ] Railway Variables: `OPERATOR_CLIENT_ID=default`, `SESSION_SECRET` set,
      `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` set, **`ENCRYPTION_KEY` set and
      non-trivial** (if it was never set, Google tokens are encrypted with a
      known weak key — see SECURITY_REVIEW.md #3; fix the var BEFORE deploy and
      expect to reconnect Google after, since old ciphertexts won't decrypt
      with a new key).
- [ ] `git log --oneline -1` shows `1cdeaaa` and `git status` is clean.

### 2. Push
- Push `main` from **GitHub Desktop** (or your normal method). ⚠️ This
  machine's terminal git credential is `peterd15-creator`, which has **no push
  access** to `Foxtrot15/call-recorder` — terminal `git push` returns 403.
- Railway auto-deploys `main` on push.

### 3. Deploy watch (2 min)
- Railway → Deployments → newest build → logs: `✅ Server listening on port ...`
- Build failure or crash-loop → **Rollback path A** below.

### 4. Smoke test (~20 min)
- Run `TEST_PLAN.md` steps 0–9 in order. Any hard failure → decision tree below.

### 5. Apply RLS (only after all 9 smoke steps pass)
- Follow `supabase/sql/RLS_APPLY_CHECKLIST.md` exactly, including the negative
  proof with the old anon key.

### 6. Post-RLS smoke (10 min)
- Re-run TEST_PLAN steps 2, 3, 7, 8.
- Record the RLS apply date in the checklist file.

### 7. Done — declare stable
- Only after this point start Phase 5 work (PHASE_5_PLAN.md).

## Rollback decision tree

```
Where did it fail?
│
├─ Build/boot (step 3): app won't start
│   → Railway → previous deployment → Redeploy. Diagnose env vars offline.
│     (OPERATOR_CLIENT_ID staying set is harmless to the old build.)
│
├─ Smoke steps 1–6 (operator dashboard/API)
│   → Is it env config (401/500 with clear log line)?
│      ├─ Yes → fix the Railway variable, restart, re-run the step. No rollback.
│      └─ No (code defect) → Rollback path A (redeploy previous build).
│        Old build restores the anon-key dashboard — accepted temporary state,
│        since RLS is not applied yet.
│
├─ Smoke step 7 (client login)
│   → Does NOT block the rollout (operator + pipeline are the product today).
│     Log it, continue, fix forward.
│
├─ Smoke step 8 (inbound pipeline) ← the only truly critical path
│   → Check Twilio Debugger first: webhook config problems are Twilio-side and
│     need no code rollback.
│   → If logs show a server-side pipeline failure introduced by the new build:
│     Rollback path A immediately (missed client calls are unrecoverable).
│
└─ Post-RLS smoke fails (step 5–6 of rollout)
    → Rollback path B: run the commented-out `disable row level security`
      block in phase2_enable_rls.sql. App code stays deployed (it never
      depended on RLS). Then find the non-service-role consumer before
      re-applying — the new build shouldn't have one.
```

**Rollback path A** — Railway → Deployments → last known-good → Redeploy.
**Rollback path B** — RLS disable block only; never combine with path A in one
step (change one variable at a time so you know what fixed it).

## Do-not list during rollout

- Don't apply RLS before the smoke test passes (checklist preconditions exist
  for a reason — the old build's dashboard dies under RLS).
- Don't rotate any Supabase keys during the rollout window.
- Don't run the Phase 5 backfill script — it's for a later change window,
  paired with changing `OPERATOR_CLIENT_ID` off `default`.
