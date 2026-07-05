# Aida smoke suite

One command to verify the core app is alive after a deploy. Black-box HTTP checks
against a running instance — no framework dependencies (uses Node's built-in
`node:test` + `fetch`, Node 18+).

## Run it

```bash
# against a deployed instance
SMOKE_BASE_URL=https://your-app.up.railway.app DASHBOARD_PASSWORD=... npm run smoke

# against local dev (defaults to http://localhost:3000)
DASHBOARD_PASSWORD=... npm run smoke

# with the deployment's own env (verifies server env vars directly too)
railway run npm run smoke

# fast env-only check, no server needed
npm run smoke:preflight
```

Exit code is `0` if everything passes, non-zero otherwise — so it drops straight
into CI or a deploy step.

## Configuration (all via env)

| Var | Required | Purpose |
|---|---|---|
| `SMOKE_BASE_URL` | no (default `http://localhost:3000`) | Instance to test |
| `DASHBOARD_PASSWORD` | for operator checks | Operator login |
| `SMOKE_CLIENT_EMAIL` / `SMOKE_CLIENT_PASSWORD` | optional | Enables the positive client-login check against a seeded test client |
| `SMOKE_TIMEOUT_MS` | no (default `10000`) | Per-request timeout |

## What it checks

1. **Preflight** — runner env present; critical server env (only when run with server env).
2. **Health** — `GET /health`.
3. **Operator auth** — anon rejected (401), wrong password (401), correct login sets session, and `OPERATOR_CLIENT_ID` proven configured (operator route returns 200, not the "not configured" 500).
4. **Calls API + DB connectivity** — `GET /calls` returns an array (proves Supabase is reachable).
5. **Settings** — `GET /settings/pipeline` (read-only).
6. **Voicemail** — `GET /voicemail/status` (read-only).
7. **Google** — `GET /auth/status`.
8. **Client auth** — anon rejected, bad creds rejected, real login (if configured).
9. **Invite → signup** — operator-gated minting, token issuance, and signup token
   verification against a random non-existent slug (proves the flow + DB without
   creating a user).

## Safety

The suite performs **no mutating writes**: it never toggles the pipeline, uploads
or deletes a voicemail greeting, or creates a real signup. The invite/signup check
uses a random non-existent slug so it fails at the clients lookup *before* any user
is created. Safe to run against production on every deploy.

## Not covered here — see `MANUAL_CHECKLIST.md`

Twilio webhooks and live phone calls are **not** automated (they need a real
inbound call and carrier forwarding). Run the manual checklist for those after the
automated suite passes.
