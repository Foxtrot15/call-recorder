# Railway Sandbox Deployment Plan — M7F-B1

**Status: PREPARED, NOT EXECUTED.** Nothing was deployed. No service was created,
no public endpoint exists, no DNS was changed, no tunnel was started, no SQL was
applied, and nothing was pushed. This is the plan a founder follows after
approving it.

---

## 1. Node version — the decision and its evidence

| Signal | Value |
|---|---|
| Technical minimum | **Node 20** — the Retell verifier uses `globalThis.crypto.subtle` and throws without it |
| Node 20 status | **END OF LIFE, 30 April 2026** |
| SDK requirement | "Node.js 20 LTS or later (**non-EOL**) versions" |
| Node 22 | Maintenance LTS, EOL **30 April 2027** |
| Node 24 | Active LTS, EOL 30 April 2028 |
| Developer machine | Node 24.14.1 |

**Pinned: Node 22**, via `.nvmrc`. `engines.node` is `>=22`.

The instruction was to prefer Node 20 LTS unless there is a documented reason
not to. There is one, and it is decisive: **Node 20 is already end-of-life**, so
pinning it would deploy an unpatched runtime and would violate the SDK's own
stated requirement of a *non-EOL* version.

Node 24 has a longer runway and would also be defensible. It was **not** chosen,
because it is also the version on the developer's machine, and "it works on my
laptop" is not a deployment rationale. 22 is the most conservative version that
is still supported.

**Why a pin was needed at all.** Railway's builder reads `.nvmrc` and
`.node-version` *before* `engines`. `engines.node: ">=22"` is a **constraint, not
a selection** — it tells the platform which versions are acceptable, and lets the
platform choose among them. Before this milestone the repository contained no
`.nvmrc`, no `.node-version`, no Dockerfile and no Railway configuration, so the
deployed Node version was entirely the platform's default. A test now asserts
`.nvmrc` exists, is non-EOL, satisfies `engines`, and is the only Node selection
signal in the repository.

---

## 2. Service configuration

| Setting | Value |
|---|---|
| Service name | `aida-retell-sandbox` |
| Project | **A SEPARATE Railway project** from production |
| Source | this branch |
| Build | Nixpacks (default) |
| Node | 22, from `.nvmrc` |
| Start command | `npm start` (`node src/server.js`) |
| Public URL | Railway-assigned `https://<service>.up.railway.app` |
| Custom domain | **none** — a throwaway subdomain is the point |
| Health endpoint | `GET /health` |
| Inbound webhook | `POST /webhooks/retell/inbound` |
| Event webhook | `POST /webhooks/retell` — **not needed** for the inbound proof; leave dormant |

> **Corrected 2026-08-02 (M7F-B2).** Leaving the event webhook dormant is right,
> and it used not to work: the inbound webhook's signature verification asked
> `RETELL_WEBHOOK_ENABLED` — the *event* flag — for permission, so a sandbox
> configured exactly as this document instructs returned **503
> `verification_disabled`** on every request, and the security proof below would
> have failed at step 3. The inbound surface now uses its own capability
> (`canVerifyInboundWebhook`), so `RETELL_INBOUND_WEBHOOK_ENABLED` alone is
> sufficient — which is what the separate flag was always supposed to mean.
| Resource tag | `dev` |

A separate *project*, not merely a separate service, so no production variable
can be inherited by accident.

---

## 3. Environment variables

**Required**

| Variable | Value |
|---|---|
| `NODE_ENV` | `development` |
| `RETELL_ENABLED` | `true` |
| `RETELL_INBOUND_WEBHOOK_ENABLED` | `true` |
| `RETELL_API_KEY` | the **dev** Retell key |
| `RETELL_WEBHOOK_BASE_URL` | the assigned Railway HTTPS URL |
| `RETELL_ALLOWED_TAG` | `dev` |
| `SESSION_SECRET` | a fresh throwaway value |
| `ENCRYPTION_KEY` | a fresh throwaway value |

**Explicitly forbidden**

`RETELL_LIVE_WRITES_ENABLED` · `RETELL_LIVE_CALLS_ENABLED` ·
`RETELL_SANDBOX_EXECUTE` · `RETELL_SANDBOX_WEB_CALL_ENABLED` ·
`RETELL_RECORDING_ENABLED` · `RETELL_WEBHOOK_ENABLED` (the inbound webhook does
**not** need it, and setting it would mount the event route, whose idempotency
needs database tables that are deliberately unapplied — so it could only 503) ·
`RETELL_OUTBOUND_ONBOARDING_NUMBER` · `RETELL_INBOUND_DEMO_NUMBER` ·
`ANTHROPIC_API_KEY` · production `SUPABASE_*` · production `TWILIO_*` ·
`STRIPE_*`.

The inbound webhook needs none of them. A sandbox holding production credentials
is not a sandbox — and note that `RETELL_LIVE_WRITES_ENABLED` being absent is
also what keeps `inbound_webhook_url` out of any binding payload the sandbox
might compile.

---

## 4. Does the proof need a database?

**Yes — for the *resolved* case only.** This is the one place the plan needs a
decision rather than a default.

The resolver reads `provider_resources` and the approved-profile table. Without
them:

| Check | Works without a DB? |
|---|---|
| Unsigned → 401 | **yes** |
| Bad signature → 401 | **yes** |
| Signed, unknown agent → 200 empty | **yes** — the registry read fails and is classified `registry_unavailable`, which withholds variables exactly like `unknown_agent` |
| Signed, known agent → 200 with variables | **no** |
| Wrong environment → 200 empty | **no** |

So a database-free sandbox proves the **security boundary** completely, and the
**resolution path** not at all.

**Recommendation: deploy in two steps.**

**Step 1 — no database.** Prove signature verification, the fail-closed
behaviour, and that a valid signature over an unknown agent yields an empty
response. This is the whole security surface and needs no SQL.

**Step 2 — a dedicated sandbox Supabase project.** Only if you want the resolved
case proved before the first phone call. Use a **new Supabase project**, never
production and never a schema inside production; apply the migrations in §5;
insert one fictional client and one fictional registry row. **No production data,
ever** — this database exists to hold made-up rows.

Step 1 is worth doing on its own. Step 2 can wait until the number step, since
the same resolution is exercised by the first real inbound call anyway.

---

## 5. Verification, in order

1. `GET /health` → **200** `{"status":"ok"}`.
2. **Flag off first.** With `RETELL_INBOUND_WEBHOOK_ENABLED` unset, `POST` to the
   inbound path → **404**. Dormant must be indistinguishable from absent. Set the
   flag afterwards.
3. `node scripts/retell-inbound-smoke.js --target https://<service>.up.railway.app`

   Expects: unsigned → 401 · bad signature → 401 · signed unknown agent → 200
   `{"call_inbound":{}}` · no secret or E.164 in any response · every response
   inside the budget.

   The harness signs with the **official SDK** using `RETELL_API_KEY` from your
   own environment. It never accepts a key on the command line — a command line
   ends up in shell history — and never prints one.

4. Only after step 2 of §4, add `--known-agent <id>` and `--wrong-env-agent <id>`
   to prove the resolved and wrong-environment cases.

**Stop immediately if** the unsigned request returns anything other than 401, or
a response body contains a phone number in international form.

---

## 6. Rollback

1. Delete the Railway service. There is no DNS record and, in step 1, no data.
2. If a sandbox Supabase project was created, delete the project outright rather
   than dropping tables — it contains only fictional rows and is cheaper to
   discard than to clean.
3. Unset `RETELL_WEBHOOK_BASE_URL` locally.

Nothing at Retell needs undoing: this milestone registers no webhook URL, creates
no resource and binds no number.

---

## 7. Cost

| Item | Cost |
|---|---|
| Railway sandbox service | usage-based; small on a hobby/developer plan, and zero once deleted |
| Sandbox Supabase project | free tier is sufficient for a handful of fictional rows |
| Retell | **nothing** — no resource is created |
| Telephony | **nothing** — no number exists |

---

## 8. What this does not do

No number is purchased, imported, bound or released. No call is created or
received. No webhook URL is registered at Retell. No recording is enabled. No
production credential is used. No SQL is applied by any step above — §5 step 4
depends on the migrations in
[RETELL_SQL_APPLICATION_CHECKLIST.md](RETELL_SQL_APPLICATION_CHECKLIST.md), which
remain unapplied and require their own approval.
