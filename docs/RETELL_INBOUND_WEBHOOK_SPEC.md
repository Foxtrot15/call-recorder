# Retell Inbound-Call Webhook — M7F-A

**Status:** implemented, dormant, locally verified. **Nothing external was
contacted.** No number purchased, imported or bound; no call created; no webhook
exposed; no tunnel; no DNS change; no SQL applied; no deploy; nothing pushed.

M7F identified three technical blockers before an Australian inbound call could
be attempted. This milestone removes all three in code.

| Blocker | State |
|---|---|
| Signature verification impossible — SDK absent | **resolved** (§1) |
| No `call_inbound` response path | **resolved** (§2–4) |
| Provisioning SQL unapplied | **reviewed, not applied** — and no longer blocks inbound (§6) |

---

## 1. The SDK decision

`retell-sdk@5.53.0` installed. Verified against the registry on 2026-08-02:
the package exists, is Apache-2.0, and `5.60.0` is the current `latest`.

**Pinned to 5.53.0, not 5.60.0**, because `package.json` already declared that
exact version and a version bump is a separate decision with its own review. The
newer release is noted, not adopted.

Installed with `--no-save --no-package-lock` so neither `package.json` nor the
historical `package-lock.json` changed; the dependency was already declared as an
`optionalDependency`, so a normal deploy install resolves it without any
manifest edit.

**Used for signature verification and nothing else.** Tests assert that the
adapter, the port, both compilers, the provisioning plan, the sandbox, the
diagnostics service, the inbound core and the inbound handler all contain no
`require("retell-sdk")`. Provisioning and web-call creation remain on native
`fetch` with an injected transport. The browser SDK (`retell-client-js-sdk`)
remains absent server-side and is asserted to stay that way.

### The Node floor, finally decided

M3 recorded this as deferred: *"installing the SDK means adopting Node 20+"*.

The SDK's README requires **Node 20 LTS or later**, but it publishes **no
`engines` field**, so npm will not enforce it. Reading
`node_modules/retell-sdk/lib/webhook_auth.js` shows why it matters concretely:
verification uses `globalThis.crypto.subtle` and throws *"Webhook verification
requires a runtime with the Web Crypto API"* when absent — which is a real
failure mode on Node 18, not a theoretical one.

`engines.node` is therefore raised from `>=18` to **`>=20`**. The repository
pinned no Node version anywhere (no `.nvmrc`, no Dockerfile, no Railway config),
so the declaration in `package.json` is the only signal a deploy platform reads.
Leaving it at `>=18` while shipping code that needs 20 would be leaving a trap.

### What the SDK actually does

Read from source rather than inferred (`lib/webhook_auth.js`, 2026-08-02):

* Signature format `v={timestamp},d={digest}`.
* Digest is HMAC-SHA256 over **`body + timestamp`** concatenated, keyed with the
  API key, hex-encoded — **always exactly 64 characters**.
* Both `sign` and `verify` are **async**.
* The SDK applies its own 5-minute window as well as ours.

One small correction followed. Our header parser accepted 16–256 hex characters;
the digest is always 64. Not a security hole — the SDK rejects a wrong-length
digest regardless — but it meant a malformed header was reported as
`invalid_signature` (a failed cryptographic check) rather than
`malformed_signature` (a header that was never well-formed). Those are different
operational problems and should not look identical in a log. Tightened, with
wrong-length cases added to the refusal tests.

---

## 2. Route separation — a dedicated route

`POST /webhooks/retell/inbound`, separate from `POST /webhooks/retell`.

Four reasons, any one sufficient:

1. **Provider contract.** This URL is set on the phone **number**
   (`inbound_webhook_url`); the event webhook is set on the **agent**
   (`webhook_url`). They are configured in different places and can point at
   different hosts. One route cannot be two URLs.
2. **Response shape.** This answers **200 with a JSON body that configures the
   call**. The event webhook answers **204 with no body**. The brief requires
   that the generic path never returns the inbound shape; the surest guarantee is
   that it cannot.
3. **Latency.** This runs before the caller is answered, with a 10-second budget,
   and failure can disconnect them. The event path deliberately touches the
   database for idempotency. Sharing a handler would put a database round trip in
   front of a ringing phone.
4. **Blast radius.** A bug in post-call auditing must not be able to affect how a
   live call is answered.

They share raw-body capture and signature verification, and nothing else.

The inbound route has its **own flag**, `RETELL_INBOUND_WEBHOOK_ENABLED`, in
addition to `RETELL_ENABLED`. Being willing to record events is not the same as
being willing to decide, in real time, how a stranger's phone call is handled.

---

## 3. The provider contract

Verified against `docs.retellai.com/features/inbound-call-webhook`, 2026-08-02.

**Request**

```json
{
  "event": "call_inbound",
  "event_timestamp": 1780012672105,
  "call_inbound": {
    "agent_id": "agent_…",
    "agent_version": 1,
    "from_number": "+61…",
    "to_number": "+61…",
    "custom_sip_headers": { "x-my-header": "value" }
  }
}
```

**Response** (all fields optional)

```json
{
  "call_inbound": {
    "dynamic_variables": { "…": "…" },
    "metadata": { "…": "…" },
    "override_agent_id": "agent_…",
    "override_agent_version": 1,
    "reject": false
  }
}
```

**10-second timeout, retried up to 3 times.** If every attempt fails, Retell
connects the call to the number's bound inbound agent — and if there is none,
**disconnects the caller**.

`custom_sip_headers` is recognised and **deliberately never read**. SIP headers
are attacker-influenceable on some carriers and nothing here needs them; only
their presence is recorded.

---

## 4. What "fail closed" means here

The obvious reading is wrong, so it is worth being precise.

The danger is **not** "a call we cannot attribute". The danger is **emitting
variables we cannot attribute** — sending client B's transfer number to client
A's caller would route somebody's emergency to a stranger, silently, and the call
would sound completely normal.

So the default failure mode is **withhold**, not reject:

| Situation | Response | Effect |
|---|---|---|
| Resolved client | `200` + variables | normal |
| Unknown client / unresolvable | `200` + `{"call_inbound":{}}` | call connects on the bound agent with **no** runtime values |
| Resolver threw | `200` + `{"call_inbound":{}}` | same; the internal error never leaks |
| Variables failed shared validation | `200` + `{"call_inbound":{}}` | never a partial set |
| Unresolved `{{runtime}}` placeholder | `200` + `{"call_inbound":{}}` | a placeholder would be read aloud verbatim |
| Bad/missing/stale signature | `401` | Retell retries, then falls back to the bound agent |
| Wrong event on this route | `400` | the event route exists for that payload |
| Body over the byte limit | `413` | |
| Verifier unavailable | `503` | fail closed, never an open door |

A caller reaching a receptionist that lacks on-call context is a degraded call.
A caller hearing a disconnect is a lost customer. A caller being given another
business's transfer number is worse than both.

`reject` remains available via `RETELL_INBOUND_UNKNOWN_CLIENT_ACTION=reject`
(strict-parse, exact string). Both modes are tested.

---

## 5. Dynamic variables and phone speech

No parallel builder. The route calls the same
`buildInboundCallVariables()` → `buildInboundWebhookResponse()` path the sandbox
uses, so the allow-list, string coercion, runtime-vs-default split and every
spoken-form derivation are exercised exactly as they are everywhere else.

Consequences, all asserted by tests:

* **The caller's number is sent SPOKEN ONLY.** `caller_number_spoken` is derived
  from the canonical `from_number`; `caller_number` is never emitted. The agent
  has no use for an E.164 value it cannot dial.
* It is **withheld entirely** unless `includeCallerNumber` is set.
* A foreign or unlocalisable number yields **no** spoken variable rather than a
  guess.
* The transfer number keeps **both** forms: `current_transfer_number` (machine,
  canonical) and `current_transfer_number_spoken`.
* **No `_spoken` variable can carry an E.164 number** — the shared validator
  refuses it rather than converting it.
* Every emitted key is runtime-only: `splitDefaultsFromRuntime` on the response
  yields `{}` defaults, so nothing sent per call can leak into a provisioned
  default.
* The client id travels in `metadata`, which is stored against the call and
  **never injected into the prompt** — which is precisely why it belongs there
  and not in a dynamic variable.

---

## 6. Latency, idempotency and the database

**The inbound response path touches no database.** Tests assert that neither the
handler nor the decision core imports Supabase or the event tables.

A local measurement over 100 iterations shows the decision completing in well
under 50 ms of our own work, because it performs no I/O. **That measures our code
only** and says nothing about internet or deployed latency.

Audit is optional, injected, and runs **after** the response via a floating
promise; a test asserts the audit callback cannot run before the response.

The post-call event path is **unchanged**: fingerprint idempotency, duplicate
detection, 204 acknowledgement, and 503 on genuine storage failure so Retell
retries. Nothing about M7F-A weakens it.

**`call_inbound` does not require the provisioning SQL.** See
[RETELL_SQL_APPLICATION_CHECKLIST.md](RETELL_SQL_APPLICATION_CHECKLIST.md) §5.

---

## 7. The inbound webhook URL

Derived from `RETELL_WEBHOOK_BASE_URL` as `<base>/webhooks/retell/inbound`.

Refused: a missing base, plain HTTP, a query string or fragment, and any
loopback or private host — `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`,
`10/8`, `192.168/16`, `172.16–31/12`, `0.0.0.0`, and any bare hostname with no
dot. A provider-facing URL pointing at `127.0.0.1` does not degrade, it silently
never fires, and the symptom (calls answered with no runtime context) looks
nothing like the cause.

An `allowInsecure` escape hatch exists for isolated path tests and is
**unreachable from configuration** — no environment variable feeds it, and a test
asserts that.

**M7F-A writes no webhook URL to Retell.** The binding payload still carries no
`inbound_webhook_url`, and a test asserts the compiler does not emit one.
Enabling that is a later, explicit decision. Unbinding later sets it to `null`.

---

## 8. Railway sandbox deployment plan — PREPARED, NOT EXECUTED

Nothing below was run. No service created, no tunnel, no DNS change.

**Why Railway over a tunnel.** The project already deploys there. A sandbox
service gives a stable HTTPS URL with real TLS and no local process exposed to
the internet; a tunnel exposes a local machine and rotates URLs, which makes a
signature failure hard to distinguish from a stale URL.

**Service**
1. New Railway service, e.g. `aida-retell-sandbox`, in a **separate project**
   from production so no variable can be inherited by accident.
2. Deploy the M7F-A branch.
3. Railway assigns `https://<service>.up.railway.app`. **Do not attach a custom
   domain** — a throwaway subdomain is the point.

**Environment — only what the inbound webhook needs**

| Variable | Value |
|---|---|
| `NODE_ENV` | `development` |
| `RETELL_ENABLED` | `true` |
| `RETELL_INBOUND_WEBHOOK_ENABLED` | `true` |
| `RETELL_API_KEY` | the dev key |
| `RETELL_WEBHOOK_BASE_URL` | the assigned Railway HTTPS URL |
| `RETELL_ALLOWED_TAG` | `dev` |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | fresh throwaway values |

**Deliberately absent:** production Supabase credentials, production Twilio
credentials, `RETELL_LIVE_WRITES_ENABLED`, `RETELL_LIVE_CALLS_ENABLED`,
`RETELL_SANDBOX_*`, `RETELL_RECORDING_ENABLED`, `ANTHROPIC_API_KEY`. The inbound
webhook needs none of them, and a sandbox holding production credentials is not a
sandbox.

**Verify, in order**
4. `GET /health` → `200 {"status":"ok"}`.
5. `POST /webhooks/retell/inbound` with **no** signature → **401**. If this
   returns 200, stop — verification is not running.
6. Same with a **tampered** signature → **401**.
7. Same with a **correctly signed** body (sign locally with the SDK's `sign`
   using the same key) → **200** and `{"call_inbound":{…}}`.
8. Confirm the response contains **no** `caller_number` in E.164 form.
9. With the flag off, confirm the path **404s** — dormant must be indistinguishable
   from absent.

**Rollback**
10. Delete the Railway service. There is no DNS record to remove and no data to
    clean up, since the sandbox holds no database.
11. Unset `RETELL_WEBHOOK_BASE_URL` locally.

**Cost.** Railway bills by usage; an idle sandbox service is a small monthly
amount on a hobby/developer plan and stops entirely when the service is deleted.
No Retell cost — nothing is created there. No telephony cost — no number exists.

---

## 9. What is still required before an Australian inbound call

1. **A number.** Retell cannot sell one — `country_code` is `US`/`CA` only — so
   an Australian number must be **imported** over a SIP trunk (Twilio AU local
   ≈ A$2.50/mo, origination ≈ A$0.006/min).
2. The Railway sandbox actually deployed and its 401/200 checks passing.
3. `inbound_webhook_url` enabled in the binding payload — currently, and
   deliberately, not emitted.
4. A resolver implementation that maps an inbound `agent_id` to a real client.
   The seam exists and is injected; nothing is wired to it yet.
5. Founder approval for the paid number and the live call.
