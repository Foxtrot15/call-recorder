# AIDA Locksmith — Usage Metering, the A$49 Offer and Billing (M6)

**Status: dormant and UNCOMMITTED.** Every route 404s unless
`BILLING_ENABLED="true"`. No SQL applied. No Stripe object created. **No payment
has been taken and no card can be charged from the shipped configuration.**

Milestone chain: [M1](LOCKSMITH_PILOT_SPEC.md) → [M2](LOCKSMITH_ONBOARDING_SPEC.md)
→ [M3](RETELL_INTEGRATION_SPEC.md) → [M4](LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md)
→ [M5](LOCKSMITH_CLIENT_PORTAL_SPEC.md) → **M6 billing**.

---

## 1. Stripe documentation review

Reviewed against official `docs.stripe.com` only. Findings that shaped the build:

### Usage-based billing: Metronome vs Billing Meters

Stripe now states that *"Metronome is Stripe's primary usage-based billing
platform for all new integrations"*, while confirming it *"will continue to
fully support basic usage-based billing for existing users."*

**Decision: basic usage-based billing (Billing Meters).** Stripe's own stated
best fit for it is *"businesses with pay-as-you-go pricing models… billed based
on usage thresholds"*, which is exactly AIDA's shape: a tiered subscription with
an included allowance and overage. The limitations Stripe lists for it —
no real-time usage visibility, high-volume ingestion, multi-dimensional
metering, real-time credit burndown — are aimed at enterprise volume. AIDA is a
handful of pilot locksmiths at A$49–399/month. Adopting Metronome for that would
be a large integration serving a problem we do not have.

**Migration trigger, recorded so the decision can be revisited deliberately:**
move to Metronome if AIDA needs real-time credit burndown, multi-dimensional
metering, or exceeds the ingestion volume basic metering comfortably handles.

### Meter events API

`POST /v1/billing/meter_events`

| Field | Rule |
|---|---|
| `event_name` | required, max 100 chars |
| `payload` | required; must carry `stripe_customer_id` and `value` |
| `identifier` | optional, max 100 chars, deduplicated over **a rolling window of at least 24 hours** |
| `timestamp` | optional; **within the past 35 calendar days**, up to **5 minutes** in the future |

Stripe processes meter events **asynchronously**, so aggregated usage may lag
what we sent. Consequences encoded in the build:

- We supply `identifier` ourselves and derive it deterministically. Letting
  Stripe generate one throws away the only protection against double-billing a
  retried batch.
- The 24-hour dedup window is not enough on its own — re-metering a period a
  week later would bill twice. `billing_meter_events` has a **non-expiring**
  unique index on `identifier`.
- Usage older than 35 days is **refused and reported**, never silently dropped:
  usage we cannot meter is revenue we cannot charge, and someone must know.

### Webhook signatures

Header `Stripe-Signature`, format `t=…,v1=…`. The signed string must be the raw
body **in UTF-8 without any changes**. Stripe recommends the official library's
`constructEvent()`.

**We do not implement the HMAC.** The published page does not fully specify the
algorithm, and a verifier that looks right but is wrong accepts forged events
silently — an unverified billing webhook lets anyone who finds the URL mark an
invoice paid or cancel a subscription. Same decision, same reason, as the Retell
verifier in M3. The route mounts `express.raw` so the handler sees the exact
signed bytes.

### Coupons

`duration=repeating` + `duration_in_months`, with `amount_off` and `currency`.
This is how the founding offer is expressed (§4).

---

## 2. Danger gates

Five independent gates, all strict-parse, all defaulting to the safe value.

| Flag | Default | Effect |
|---|---|---|
| `BILLING_ENABLED` | off | the integration exists at all |
| `BILLING_LIVE_WRITES_ENABLED` | off | may create/update Stripe objects |
| `BILLING_CHARGES_ENABLED` | off | **may charge a card** |
| `BILLING_WEBHOOK_ENABLED` | off | processes inbound events |
| `BILLING_DRY_RUN` | **on** | inverted: only `"false"` turns it off |

Modes degrade rather than half-work: `disabled → mock → dry_run → live`.
Charging requires four flags, a secret key and a webhook secret
**simultaneously** — a test asserts that removing any single one stops it.

**The Stripe mode is derived from the key, never declared.** A `sk_live_` key
outside `NODE_ENV=production` refuses to charge, and a `sk_test_` key *in*
production is flagged too — "I thought it was pointing at test" is the standard
way this goes wrong. Keys are never returned in full; only a `sk_test_…f456`
style hint.

---

## 3. Plans

| Plan | Monthly | Included | Overage |
|---|---|---|---|
| Micro | A$49 | 40 calls / 80 min | A$1.50/call, A$0.75/min |
| Solo | A$99 | 120 calls / 260 min | A$1.20/call, A$0.60/min |
| Growth | A$199 | 260 calls / 550 min | A$0.90/call, A$0.50/min |
| Pro | A$399 | 520 calls / 1100 min | A$0.70/call, A$0.40/min |

**All amounts are integer cents.** Never floats — a rounding error in a billing
system is not a rounding error, it is a dispute.

**Calls and minutes are metered independently**, and overage is charged on both.
They are not interchangeable: a hundred ten-second hang-ups cost almost nothing;
twenty twelve-minute conversations cost real money. Metering one dimension lets
a client be badly mispriced in either direction.

Prices exist in `services/billing-plans.js` and nowhere else — not in the
database, not in a view. A price written twice eventually disagrees with itself,
and the disagreement would be between what a client was shown and what they were
charged.

### Best fit

**The recommendation is always the cheapest total for the client's real usage.**

> **Defect found and fixed.** The first version recommended the cheapest
> *comfortable* plan — one with headroom to spare. At 130 calls and 280 minutes
> it recommended Growth (A$199) over Solo (A$123), because Solo was slightly
> over its allowance. Telling a locksmith to pay 62% more "for headroom" is an
> upsell wearing the costume of advice. Headroom is now reported, never acted
> on: when the cheapest plan is running close to its limits, the page names the
> next plan up **and the exact extra cost**, then leaves the choice to them.

---

## 4. The founding offer

**First two months at A$49, whatever plan you are on.**

Modelled as a discount off the tier price, not as a fifth plan — a separate plan
would mean migrating the client at month three, with a subscription change, a
proration and an opportunity to get it wrong. A discount simply expires.

- Expressed to Stripe as `duration=repeating`, `duration_in_months=2`,
  `amount_off` in AUD cents, per tier.
- **Overage is still charged.** An unbounded free tier is how a cheap pilot
  becomes an expensive one.
- Never produces a negative discount on Micro (which is already A$49).
- `requiresFounderApproval: true` — a fact about the offer, not a licence to
  apply it automatically.

---

## 5. Metering

| Rule | Why |
|---|---|
| Calls under **6 seconds** are never charged | Wrong numbers and hang-ups are not work. The constant is shared with the portal read model — a test asserts they are the same value. |
| The client's own **setup test calls** are never charged | Charging someone to check the thing they are paying for works is a small amount of money and a large amount of resentment. |
| **Spam** is never charged | |
| Minutes round **up per call**, then sum | Per-call rounding is what the client sees on each row, so summing rounded rows is the only total that reconciles line by line. It is slightly more expensive than month-level rounding, so `roundingBasis` states it rather than burying it. |
| Every exclusion is **itemised with a reason** | A client told "3 calls weren't charged" who can see *which* will trust the ones that were. |

**One arithmetic, not two.** The portal's usage panel and the invoice both read
`projectUsage` from the M5 read model. A client who sees 47 minutes in the portal
and 52 on the invoice will not believe either number again, and would be right.

### Threshold notices

Fire at 80% and 100% of each allowance, plus once when overage passes A$20.
Each fires **once per period** — a job that re-notifies every hour trains people
to ignore the notice that mattered.

**No notice ever says or implies the service stops.** A test asserts that no
message matches `/suspend|cut off|stopped|disabled|blocked/i` and that every
notice carries `serviceContinues: true`. The 100% notice states the rate:
*"AIDA keeps answering — further calls are charged at your plan's usage rate."*

---

## 6. Account lifecycle

Ten states. The one that matters:

> ### A FAILED PAYMENT DOES NOT STOP AIDA ANSWERING THE PHONE.
>
> This is a product decision, not an oversight. The client is a locksmith whose
> customers are locked out of their homes. Cutting off their receptionist over
> an expired card would strand people at their front door at 2am over A$49, and
> it would be the last thing that business ever bought from us.

`serviceActive` is a separate axis from `paymentHealthy`. `past_due` and
`collections` both keep answering. Only `suspended` stops service, and:

- **No automated actor can reach it.** `evaluateTransition` refuses
  `actor: "system"` with *"Suspending a client stops their phone being answered.
  That needs a person to decide it, not a cron job."*
- The database agrees: `ba_suspension_is_attributed` requires `suspended_by` and
  `suspended_at`, so suspension can never be an anonymous automated action.
- A test walks **every** state pair exhaustively and asserts no system-actor
  transition reaches a service-stopping state except the client's own
  cancellation.

> **Two defects found and fixed here.** The webhook chose `collections` purely
> from the attempt count, producing an illegal `active → collections`
> transition whenever counter and state were out of step — and an illegal
> transition is dropped with a log line, so the client would silently stop being
> chased. Escalation now follows the machine. Separately, the attempt counter
> was only written alongside a successful transition; a repeat failure while
> already `past_due` is a self-transition, which the machine refuses, so
> **nothing was recorded, the counter never reached 2, and `collections` was
> unreachable**. The counter is now updated independently of the state change.

---

## 7. Profitability guardrails

`auditCatalogue()` checks every plan against an estimated cost model.

**A plan is a promise that the client may use the whole allowance.** A plan that
only works while nobody uses it is not a plan, it is a trap that springs on the
most engaged customers. So the check is margin **at 100% of included usage**.

> **The guardrail caught a real mispricing in this milestone.** The first
> allowances (Growth 300/660, Pro 700/1600) put Growth at a 14% margin and made
> **Pro lose money at 100% of its own included usage**. Allowances were cut to
> 260/550 and 520/1100 until the audit passed. All four plans now sit at 28–50%
> margin at full allowance, and every overage rate covers what the extra usage
> costs us.

The cost model is **labelled an estimate everywhere it surfaces**
(`estimated: true`, a version string, and a note on the offer assessment). Real
per-minute provider invoices must replace it before anything is charged.

---

## 8. Stripe port

Four adapters: `disabled`, `mock`, `dry_run`, `live`.

**Only the live adapter contains transport code** — a test asserts the other
three contain no `require("stripe")` at all. This is not "does not call it", it
is "does not have it": no mode-resolution bug can make a dry run reach the
network. The whole module loads with the `stripe` package absent (the house rule
that tests run without `node_modules`).

Dry run returns **the exact request** the live call would send, built by the
same code — not an approximation assembled separately.

Other properties:
- Deterministic `Idempotency-Key` on every mutating request, derived from intent
  rather than time. A retried subscription creation cannot create a second one.
- The tenant travels in `metadata.aida_client_id` on every Stripe object, so a
  webhook can identify the client without a lookup table — and the webhook reads
  the tenant **only** from that metadata, never from an arbitrary payload field.
- API version pinned. An unpinned integration changes behaviour when Stripe
  ships a new version, silently, in production.
- The mock's portal URL is `example.com`, deliberately not a plausible Stripe
  URL — a mock URL that looks real is one someone eventually clicks in
  production.

### Webhook order of operations

1. verify signature — before anything reads the payload
2. check event id — replays are acknowledged, not reprocessed
3. **acknowledge (200)**
4. process — after the response

Stripe treats a slow endpoint as a failure and retries, which is how one payment
becomes three state transitions. A test wraps `res.json` and asserts the order is
`["responded", "processed"]`.

---

## 9. Database

`supabase/sql/lpm6_create_billing.sql` — **REVIEW ONLY, NOT APPLIED.**

`billing_accounts`, `billing_usage_periods`, `billing_meter_events`. RLS enabled
in the same transaction, no policies (D8).

- **No card data.** No PAN, CVV, expiry, or payment-method token. Stripe holds
  all of it; we hold a customer id, which cannot charge anything without the
  secret key. A verification probe asserts no such column exists.
- **No price columns.** Prices live in code, in one place.
- `bme_identifier_unique` is the non-expiring deduplication guarantee that
  Stripe's 24-hour window does not provide.
- `bup_minutes_at_least_calls` — under per-call round-up, N calls produce at
  least N minutes. A lower total means the aggregation is wrong.

Deferred deliberately: an invoices table (Stripe is the system of record;
a copy can disagree with what the client was actually charged), dunning
schedule state (non-payment is a human process in the pilot), and **tax** — GST
handling needs advice we do not have, and guessing at tax treatment in a
migration is worse than leaving it out.

---

## 10. Tests

`test/billing.test.js` — 81 tests, no `node_modules`, no database, no network.
Full suite: **1025/1025**.

---

## 11. What M6 deliberately does not do

- Charge anything. No card can be charged from the shipped configuration.
- Create any Stripe object.
- Apply any SQL.
- Handle GST or any tax.
- Copy invoices locally.
- Stop a client's phone being answered for any payment reason whatsoever.
