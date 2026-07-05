# Aida Outbound AI BDM — Technical & Compliance Blueprint

**Status:** DRAFT — architecture, research, and compliance design only. No
implementation exists. Nothing here changes existing Aida behaviour until
explicitly built and enabled.
**Scope:** the master design spec for Aida's outbound AI Business Development
Manager (BDM), built on top of the existing inbound intelligence pipeline.
**Prime directive:** correctness, auditability, and Australian legal compliance
over speed. In this product a compliance defect is not a bug — it is a
regulator-facing liability with per-day penalties in the millions. Design
accordingly.

> ⚠️ **Legal disclaimer inside the design doc, on purpose:** the compliance
> content below is an engineering synthesis of public sources (cited in §2), not
> legal advice. Every "mandatory" gate here must be confirmed with an Australian
> telecommunications/privacy lawyer before the first cold call. Where the law is
> ambiguous, this document deliberately chooses the most conservative
> commercially viable option and says so.

---

## Table of contents

1. [What we're building and the core stance](#1-core-stance)
2. [Australian compliance research (source of truth)](#2-compliance-research)
3. [Compliance-by-architecture philosophy](#3-philosophy)
4. [The two pipelines and why they must never merge](#4-two-pipelines)
5. [The compliance gate stack](#5-gate-stack)
6. [Redundant safety: the dial lifecycle](#6-redundancy)
7. [Voice AI platform selection](#7-voice-ai)
8. [Agent personalities](#8-personalities)
9. [Conversation design](#9-conversation-design)
10. [Failure modes](#10-failure-modes)
11. [Data model](#11-data-model)
12. [Reporting & dashboards](#12-reporting)
13. [Reuse of existing Aida](#13-reuse)
14. [Implementation phases](#14-phases)
15. [Red-team: destroying our own design](#15-red-team)
16. [Open questions](#16-open-questions)

---

## 1. Core stance

Aida already turns inbound calls into structured intelligence: recording →
Deepgram → Claude analysis → contacts → business profile → Gmail/Calendar/CRM.
The outbound BDM is a **new capability that consumes that intelligence** and adds
the ability to *initiate* contact — following up warm leads, chasing quotes,
rebooking lapsed customers, and (separately and much more carefully) cold
prospecting.

Three non-negotiable design axioms, derived from the rest of this document:

- **AX-1 — Warm and cold are different products.** They share almost no
  compliance surface, conversation design, or risk profile. They are built as two
  isolated pipelines with a hard architectural boundary (§4).
- **AX-2 — No single failure may place an unlawful call.** Compliance is enforced
  by multiple independent layers, each able to veto a call, with the default
  answer being "do not dial" (§3, §5, §6).
- **AX-3 — Every call is fully reconstructable after the fact.** Who authorised
  it, which gates passed, what evidence of lawfulness existed, what was said, and
  what the outcome was. If we cannot prove a call was lawful, we treat it as if it
  was not (§5 legal logging, §11).

## 2. Compliance research

_Synthesised 2026-07 from the sources listed at the end of this section. Laws
change; re-verify at implementation time and before each market expansion._

### 2.1 The governing instruments

| Instrument | What it governs | Relevance to BDM |
|---|---|---|
| **Do Not Call Register Act 2006** + **Telemarketing & Research Calls Industry Standard 2017** | Unsolicited telemarketing to numbers on the DNC Register; calling hours; identity disclosure; call-back number retention | The spine of cold-call compliance |
| **Spam Act 2003** | Commercial *electronic* messages (email, SMS) — not voice, but Aida already sends email | Governs the email/SMS follow-ups the BDM triggers |
| **Australian Consumer Law (ACL)** | Misleading/deceptive conduct, unconscionable conduct, unfair practices | An AI that misrepresents who/what it is, or pressures, breaches ACL regardless of DNC status |
| **Privacy Act 1988 (APPs)** + 2024–2026 reforms | Collection, use, disclosure of personal information; direct-marketing use; automated decision-making transparency | Governs the *data* the BDM runs on and (from Dec 2026) ADM disclosure |
| **State/territory surveillance & listening-devices Acts (×7–8)** | Recording of private conversations; one-party vs all-party consent varies by state | Governs recording outbound calls — **the hardest single issue** |

### 2.2 The hard rules the system must encode

- **Permitted calling hours (national, absent consent to other times):**
  Mon–Fri **09:00–20:00**, Sat **09:00–17:00**, **no calls Sundays or national
  public holidays**. Hours are the **recipient's local time** — timezone is a
  compliance input, not a UX nicety.
- **DNC wash / "30-day rule":** unsolicited telemarketing calls to a number on
  the Register are prohibited unless the list was **washed against the Register
  within the last 30 days** and the number was absent, **or** you have consent, or
  an exemption applies. The wash timestamp is evidence and must be stored.
- **Consent** may be **express** (explicitly, freely given) or **inferred** (from
  an existing relationship/conduct where it's reasonable to expect the contact).
  Inferred consent is thin ice; the system treats express consent as the only
  fully safe basis and inferred consent as a lawyer-approved, per-scenario
  exception.
- **Identity disclosure:** the caller must, on request and proactively, identify
  who is calling and on whose behalf; a call-back number must remain contactable
  for **≥30 days** after the call.
- **Opt-out:** an opt-out ("do not call me again") must be honoured promptly and
  permanently, across all future campaigns and pipelines, for that business.
- **Recording consent:** outbound records **live two-party conversations**. State
  surveillance-devices law varies (some states one-party, some all-party). The
  conservative, uniform design: **a recording disclosure at the top of every
  outbound call**, with the call abandoned compliantly if the party objects.
- **Penalties are existential for an SMB tool:** ACMA enforcement runs to formal
  warnings → infringement notices → Federal Court penalties. Public 2025–2026
  figures cited penalties in the **hundreds of thousands to millions**, including
  a $1.5M company penalty **plus personal director liability** for mass unscrubbed
  calling. This is why AX-2 exists.

### 2.3 The AI-specific regulatory picture (as of mid-2026)

- There is **no federal statute that specifically regulates AI voice telemarketing
  yet.** AI callers are governed by the *human*-caller laws above, with no
  carve-outs and no AI exemptions. Being an AI does not lower the bar; it raises
  practical scrutiny.
- Australia (National AI Plan, Dec 2025) chose **technology-neutral regulation via
  existing laws + sector regulators + voluntary guidance**, rather than a
  standalone AI Act. A proposed **mandatory-guardrails-for-high-risk-AI** regime
  exists but is not law.
- **Privacy Act ADM transparency:** from **10 December 2026**, APP entities must
  disclose in their privacy policy where substantially automated decisions
  significantly affect people. An autonomous BDM that qualifies leads and decides
  who to pursue is plausibly in scope — design for disclosure now.
- **Direction of travel:** a proposed **right to opt out of direct marking** and
  tiered penalties for lacking a simple opt-out mechanism; a **Tranche 2** privacy
  reform is flagged with no ETA. AI-disclosure obligations have already landed in
  the *broadcasting* code (commercial radio, from 1 July 2026) — a strong signal
  that **voice AI disclosure is where telemarketing regulation is heading.**

> **DESIGN CONSEQUENCE (conservative default): the BDM proactively discloses that
> it is an automated/AI assistant at the start of every call, in both pipelines.**
> It is not yet legally mandated for phone, but (a) ACL anti-deception risk, (b)
> the clear regulatory trajectory, and (c) complaint-minimisation all point the
> same way. We would rather build disclosure in and remove it if counsel says we
> may, than retrofit it after a complaint.

**Sources:** [DNC Industry Standards](https://www.donotcall.gov.au/industry/industry-overview/industry-standards) ·
[ACMA Do Not Call Register](https://www.acma.gov.au/do-not-call-register) ·
[Using the register](https://www.donotcall.gov.au/industry/industry-overview/using-the-register/) ·
[Cold Calling Laws Australia 2026 (Nousu)](https://www.nousucollective.com/blog/cold-calling-laws-australia-spam-act-dncr-compliance) ·
[AU Telemarketing Law: AI Voice Agents (Waboom)](https://www.waboom.ai/blog/australia-telemarketing-law-ai-voice-agents) ·
[ACMA AI disclosure in commercial radio (2026)](https://www.acma.gov.au/articles/2026-02/ai-disclosure-required-under-new-commercial-radio-rules) ·
[Privacy Act ADM 2026 (Lexology)](https://www.lexology.com/library/detail.aspx?g=0f14cd7b-42a0-4def-ae8c-a1675e2f6c11) ·
[Privacy reform direct marketing (Privacy108)](https://privacy108.com.au/insights/privacy-act-reform-direct-marketing/) ·
[National AI Plan / technology-neutral approach (SoftwareSeni)](https://www.softwareseni.com/why-australia-abandoned-mandatory-ai-guardrails-for-technology-neutral-regulation-and-what-it-means/).

## 3. Compliance-by-architecture philosophy

Users **will** upload bad lists. Developers **will** ship bugs. The architecture
must make an unlawful call require *simultaneous* failure of multiple independent
systems, not a single slip.

Principles:

1. **Default-deny.** A number is un-callable until positively cleared. Missing
   data = do not call. An exception thrown anywhere in the gate stack = do not
   call (fail closed, exactly like the v1 `SESSION_SECRET` pattern).
2. **Independent layers, not one big check.** Import validation, scrub, scheduler,
   pre-dial runtime check, live monitor, and post-call audit are separate
   subsystems owned by separate code, each with veto power (§5–6). Redundancy is
   the point; a bug in one is caught by the next.
3. **Evidence-or-it-didn't-happen.** Every clearance writes an immutable audit
   record *before* the call proceeds. No evidence row → the pre-dial gate fails.
4. **The kill switch is sacred.** A global and per-campaign stop that halts
   dialling within seconds, reachable by the operator and by automated monitors,
   overriding everything.
5. **Cold is guilty until proven innocent.** Pipeline B carries the maximum gate
   set by default and cannot borrow Pipeline A's relaxations (§4).

## 4. Two pipelines

### 4.1 Definitions

- **Pipeline A — Warm.** Contact has an existing relationship or a lawful basis
  derived from prior *inbound* interaction Aida already recorded: missed
  enquiries, previous callers, existing customers, quote follow-ups, service
  reminders, referral and reactivation of *known* contacts.
- **Pipeline B — Cold.** No pre-existing relationship: uploaded prospect lists,
  ABN/directory/industry lists, purchased data.

### 4.2 Why they must be **physically** separate subsystems

Not two config flags on one pipeline — two isolated pipelines, ideally separate
services/queues/tables-scoping, so a bug in one cannot leak a contact into the
other's rules.

| Dimension | Pipeline A (Warm) | Pipeline B (Cold) | Why separation matters |
|---|---|---|---|
| **Compliance basis** | Existing relationship / prior inbound contact; consent often inferable, sometimes express | No relationship; requires DNC wash + strict standard; consent almost always absent | Mixing them risks applying warm relaxations to cold contacts — the single most likely path to an unlawful mass-call event |
| **DNC scrub** | Still checked, but existing-relationship exemptions may apply (lawyer-gated) | **Mandatory 30-day wash, no exceptions**, evidence stored | A shared code path invites "optimising away" the scrub for cold |
| **Conversation design** | Warm reopener ("you called us last week about…") | Cold intro + immediate identity + AI disclosure + reason + opt-out offer | Different prompts, different objection handling, different escalation |
| **Risk** | Low complaint rate; recipient expects contact | High complaint rate; every call is a potential ACMA complaint | Reporting and alerting thresholds differ by an order of magnitude |
| **Scheduling** | Can be responsive/near-real-time (lead just came in) | Batched, rate-limited, quota-capped, spread to avoid burst patterns | Different schedulers, different KPIs |
| **KPIs** | Booking rate, speed-to-lead, reactivation revenue | Contact rate, opt-out rate, complaint rate, cost-per-qualified-lead | A shared dashboard would blur the one metric (cold opt-out/complaint rate) that predicts regulatory trouble |
| **Escalation** | Warm transfer to owner is desirable and expected | Transfer only on genuine interest; over-eager transfer annoys uninterested prospects and raises complaints | Different transfer thresholds |
| **Kill-switch blast radius** | Pausing A costs warm revenue | Pausing B costs little and de-risks | Must be independently pausable; B should be the first thing an automated monitor kills |

### 4.3 The boundary rule

> **A contact may exist in at most one active pipeline at a time. Promotion from B
> to A happens only after a lawful, logged consent event (e.g. the prospect
> expressly agrees to be contacted). Demotion/あ opt-out removes them from both,
> permanently.** There is no code path that moves a contact from A's relaxed rules
> into a cold campaign.

## 5. Gate stack

Every gate is a veto point. Ordered from list-time to post-call. "Mandatory" =
the system must not dial without it; "Optional" = risk-reduction the operator can
tune.

| # | Gate | A | B | Mandatory? | What it does |
|---|---|---|---|---|---|
| G1 | **Import validation** | ✓ | ✓ | Mandatory | Schema/format check; reject malformed numbers; detect obviously-consumer vs business; require the uploader to attest to source & lawful basis (recorded in audit). Bad list stopped here. |
| G2 | **Source & consent-basis declaration** | ✓ | ✓ | Mandatory | Every list/contact must carry a declared lawful basis (existing customer, express consent, washed cold list…). No basis → quarantined, never queued. |
| G3 | **DNC scrub** | ✓ (relationship-exempt, lawyer-gated) | ✓ | **Mandatory (B)** | Wash against the DNC Register; store wash timestamp + result per number. |
| G4 | **Scrub freshness** | ✓ | ✓ | Mandatory (B) | Refuse to dial any number whose wash is >30 days old; auto-requeue for re-wash. Freshness is checked again at runtime (G12), not just at queue time. |
| G5 | **Opt-out / suppression list** | ✓ | ✓ | Mandatory | Global per-business opt-out DB + Aida-wide hard blacklist. Checked at import AND runtime. Permanent. |
| G6 | **Manual exclusions** | ✓ | ✓ | Optional→recommended | Operator/lawyer-curated do-not-contact entries (competitors, sensitive numbers, VIPs). |
| G7 | **Duplicate suppression** | ✓ | ✓ | Mandatory | One contact not queued twice concurrently; dedupe across campaigns. |
| G8 | **Recent-contact suppression** | ✓ | ✓ | Optional→recommended | Don't call the same person within N days regardless of campaign; harassment/annoyance guard (ACL). |
| G9 | **Max-attempts cap** | ✓ | ✓ | Mandatory | Hard ceiling on attempts per contact per campaign (e.g. 3), and per time window. Exhausted → close-out, no more dials. |
| G10 | **Calling-hours + timezone** | ✓ | ✓ | Mandatory | Recipient-local-time window (Mon–Fri 9–20, Sat 9–17, never Sun/public holidays), incl. AU state public-holiday calendar. Checked at schedule time AND runtime. |
| G11 | **Campaign approval** | optional | ✓ | Mandatory (B) | A cold campaign cannot dial until an authorised human approves it (scripts, list source, caps). Recorded with approver identity. |
| G12 | **Supervisor / second approval** | — | ✓ (large/purchased lists) | Optional→recommended | Two-person rule for high-risk cold campaigns above a size/source threshold. |
| G13 | **Runtime pre-dial validation** | ✓ | ✓ | Mandatory | Immediately before Twilio dials: re-check G3/G4/G5/G9/G10 against live data. This is the last line; it assumes everything upstream may be stale or buggy. |
| G14 | **Live compliance monitor** | ✓ | ✓ | Mandatory | During the call: detect opt-out phrases, complaint/regulator mentions, wrong-person, distress; can terminate mid-call and write suppression instantly. |
| G15 | **Post-call audit** | ✓ | ✓ | Mandatory | After the call: verify disclosures were made, opt-outs captured, outcome logged, recording+consent stored; flag anomalies for human review. |
| G16 | **Emergency kill switch** | ✓ | ✓ | Mandatory | Global + per-campaign + per-agent halt, human- and monitor-triggerable, stops in-flight queue within seconds. |
| G17 | **Legal logging / evidence store** | ✓ | ✓ | Mandatory | Append-only record of every gate decision, approval, consent artifact, and call. Retention ≥ statutory minimums. If G17 write fails, G13 fails (no evidence → no dial). |

**Mandatory core (both pipelines):** G1, G2, G5, G7, G9, G10, G13, G14, G15, G16,
G17. **Mandatory-for-cold additionally:** G3, G4, G11. Everything else is
risk-reduction that a conservative operator should still enable.

## 6. Redundancy — the dial lifecycle

Each stage can stop the call. A call reaches the customer only if **every** stage
says yes; **any** stage, or any unhandled error, means no dial.

```
Operator uploads list / warm lead arrives
        │
        ▼  G1 Import validation ─────────────► reject → quarantine (never queued)
        ▼  G2 Lawful-basis declaration ──────► missing → quarantine
        ▼  G3 DNC scrub (B mandatory) ───────► on register & no basis → suppress
        ▼  G5 Opt-out/blacklist check ───────► listed → permanent suppress
        ▼  G7 Dedup / G8 recent-contact ─────► collision → skip
        ▼  Queue creation (per pipeline, isolated)
        │
        ▼  G11/G12 Campaign approval (B) ────► unapproved → cannot start
        │
   ┌────▼ Scheduler validation ──────────────► outside hours / stale scrub → defer
   │    │  (G4 freshness, G10 hours+TZ, G9 caps re-checked)
   │    ▼  G13 RUNTIME pre-dial validation ──► ANY re-check fails → abort, log, requeue/suppress
   │    ▼  G16 kill-switch check ────────────► engaged → halt entire queue
   │    ▼  Twilio dial + voice agent
   │    ▼  G14 Live compliance monitor ──────► opt-out/complaint/wrong-person → terminate + suppress
   │    ▼  Call ends
   │    ▼  G15 Post-call audit ──────────────► anomaly → human review queue, agent auto-paused
   │    ▼  G17 Legal log written (was written incrementally throughout)
   └──── outcome → back into existing Aida CRM pipeline (if qualified)
```

Design note: **G13 deliberately re-does work already done upstream.** That is not
waste — it is the redundancy. Upstream data can go stale (a number added to the
opt-out list after queueing) or a bug can corrupt a queue; the runtime gate treats
all prior stages as untrusted and revalidates against live tables at the last
possible moment.

## 7. Voice AI platform

### Requirement

Low-latency (<~700 ms) full-duplex telephony voice agent, controllable enough to
enforce disclosure/opt-out mid-conversation, that integrates with Twilio (Aida's
existing carrier) and can hand control back to our backend for booking/transfer.

### Comparison (mid-2026)

| Platform | Model | Latency (median, 2026 third-party) | Fit for Aida | Notes |
|---|---|---|---|---|
| **Retell AI** | Managed stack, ~$0.07/min AI + telephony (~$0.13–0.31/min all-in) | ~580–620 ms out of the box | **Strong** | Purpose-built for outbound campaigns (reminders, qualification), SOC 2 Type II, low integration effort, opinionated guardrails. Fastest path to a compliant production agent. |
| **Vapi** | BYO-everything (LLM+STT+TTS+telephony), ~$0.05/min base, ~$0.18–0.22 real | ~500–600 ms tuned | Strong but heavier | Cheapest per-minute headline, most control, but you own the integration and the reliability of the assembled stack. More knobs = more ways to ship a compliance bug. |
| **Twilio ConversationRelay** | Twilio-native primitive + your LLM | Config-dependent | Viable, most control, most build | Since Aida is already 100% on Twilio, this keeps everything in one vendor and one billing/telephony trust boundary. But it's a primitive: you build IVR logic, LLM orchestration, and the guardrails yourself. |
| ElevenLabs Agents / Bland / others | Various | Varies | Situational | ElevenLabs = best voice quality; Bland = aggressive outbound but reputational/compliance concerns. Not recommended as the primary for a compliance-first AU product. |

### Recommendation

> **DECISION V1 (staged):**
> - **MVP/Pilot: Retell AI on top of Twilio.** It gets a *compliant, observable*
>   agent to production fastest, with managed latency and built-in guardrails, so
>   early effort goes into Aida's compliance gate stack (the hard part) rather
>   than assembling a voice stack. Twilio remains the carrier, so recording and
>   number management stay in the trust boundary Aida already uses.
> - **Re-evaluate at commercial scale.** If per-minute economics or control become
>   the bottleneck, **Twilio ConversationRelay** is the strategic fallback: it
>   collapses vendors (one carrier + voice + billing), keeps recording natively in
>   Twilio (consistent with the inbound pipeline and VOIP_V2), and removes a
>   third-party dependency from the compliance-critical path — at the cost of
>   building orchestration we'd otherwise rent.
>
> Abstract the voice provider behind an internal `VoiceAgentProvider` interface
> from day one so this swap is a module change, not a rewrite. The compliance
> gates (§5–6) live in **Aida's** backend, never in the voice vendor — the vendor
> is a dumb, replaceable mouth, not the brain or the gatekeeper.

## 8. Agent personalities

Personalities are **prompt + voice + objection-library + escalation-threshold**
bundles, selected per client from their existing Aida business profile
(`industry`/`business_type` already inferred by the inbound pipeline). All
personalities share a **non-negotiable compliance preamble** that cannot be
overridden by client customisation.

**Shared immutable preamble (every agent, both pipelines):** identity disclosure,
AI/automated-assistant disclosure, recording notice, immediate honouring of
opt-out/"not interested"/"remove me", no misleading claims, no pressure tactics,
respect for "call me later" and "wrong person," graceful gatekeeper handling.

| Personality | Tone | Language | Objection posture | Escalation threshold |
|---|---|---|---|---|
| **Professional** (default) | Calm, precise, low-pressure | Formal-neutral | Acknowledge → clarify → offer next step | Transfer on clear buying intent |
| **Friendly** | Warm, conversational | Casual, contractions | Empathy-first, softer | Transfer readily if rapport is high |
| **Trades** | Direct, practical, brief | Plain, no jargon, "no worries" | Fast, concrete (price/date/scope) | Transfer for quote/booking |
| **Medical** | Reassuring, careful, private | Formal, sensitive | Never diagnose; scope strictly to admin/booking | Escalate anything clinical to human immediately |
| **Real Estate** | Personable, market-aware | Semi-formal | Handle price/timing/appraisal asks | Transfer for appraisal/inspection booking |
| **Legal** | Formal, cautious, precise | Formal, hedged | **Never gives legal advice**; books consults only | Escalate any substantive legal question |
| **Mortgage Broker** | Confident, numerate, compliant | Semi-formal | Rates/borrowing capacity at a high level only; no personal financial advice | Escalate advice-shaped questions to a licensed human |

How prompts differ: the domain bundle changes vocabulary, the objection library,
what the agent may and may not say (medical/legal/mortgage carry hard "do-not"
lists reflecting professional-conduct and advice-licensing risk), and how eagerly
it transfers. What they do **not** change: the compliance preamble, opt-out
handling, or any gate. Client customisation is layered *above* the immutable core
and validated so it cannot weaken it.

## 9. Conversation design

Each block is a state in a state machine; the live monitor (G14) runs across all
states and can force-jump to OPT-OUT or TERMINATE from anywhere.

| Block | Warm (A) | Cold (B) |
|---|---|---|
| **Opening** | Reopener referencing the known prior interaction ("Hi, it's Aida calling on behalf of {business} — you enquired about {X} last {day}") | Identity + on-behalf-of + **AI disclosure** + recording notice + reason, all within the first breath, then a permission-to-continue check |
| **Qualification** | Confirm need, timing, budget/scope; enrich CRM | Lightweight: is this the right person/business, is there any interest at all — stop fast if not |
| **Objection handling** | Domain objection library; low pressure | Minimal; a soft "no" is a full stop, not a challenge |
| **Booking** | Offer concrete slots via existing Calendar integration; confirm + send confirmation | Only on genuine interest; otherwise capture callback preference |
| **Voicemail** | Leave a brief, identified message with call-back number (retained ≥30 days) | Leave identified message **or** (conservative default) don't leave one and mark attempt — decide per Q in §16 |
| **Transfer to human** | Warm transfer to owner's app (ties into VOIP_V2 delivery leg) when intent is clear | Only on strong interest; over-transfer raises complaints |
| **Opt-out** | Immediate: confirm, write global suppression (G5), apologise, end | Same, with extra care — this is the highest-frequency cold outcome and the one regulators care about |
| **"Not interested"** | Acknowledge, offer to note for later, end politely | Treat as near-opt-out; end promptly, suppress for a long cooldown |
| **"Call me later"** | Capture preferred time (respecting hours/TZ), reschedule | Same, but count against attempt cap |
| **"Wrong person"** | Apologise, correct the record, don't re-dial the wrong number | Same; flag list-quality issue on the campaign |
| **Gatekeeper** | Polite, honest about purpose, request the right person or a callback | Same; never deceive the gatekeeper (ACL) |
| **Multi-decision-maker** | Note all parties, book a time that includes them | Rare in cold; capture and hand to human |

Design rule: **the agent must always be able to end a call cleanly and lawfully
from any state.** "I'm ending the call now, sorry to bother you, you won't be
contacted again" is a valid terminal transition everywhere.

## 10. Failure modes

| # | Failure | Cause | User/recipient experience | Backend behaviour | Recovery |
|---|---|---|---|---|---|
| F1 | **Voice-vendor outage** (Retell) | Provider down | In-flight calls drop; new calls fail | Circuit-breaker halts dialling for that provider; queue pauses (fail closed, never fall back to an unguarded path) | Auto-resume on health; alert operator; `VoiceAgentProvider` abstraction allows failover to ConversationRelay if built |
| F2 | **Twilio outage** | Carrier down | No calls place | Whole outbound engine pauses | Same as inbound exposure; status-page monitor; auto-resume |
| F3 | **LLM timeout / slow** | Model latency spike | Awkward silence mid-call | Agent uses filler + short timeout; if exceeded, graceful "let me have someone call you back" → human queue | Log; if systemic, breaker pauses campaign |
| F4 | **Booking failure** | Calendar API error / conflict | Agent promised a slot it can't create | Agent falls back to "I'll confirm by text shortly"; creates a pending task; never asserts a booking that didn't persist | Reconciliation job retries; operator notified |
| F5 | **CRM unavailable** | Supabase/write error | Call happened, not recorded in CRM | Outcome buffered to a durable queue; **call still fully logged in the append-only legal store (G17) independently** | Replay buffer into CRM on recovery |
| F6 | **Calendar unavailable** | Google token/API down | No bookings possible | Booking block degrades to callback-capture; campaign can continue or pause per config | Existing token-refresh paths; retry |
| F7 | **Duplicate call** | Race / requeue bug | Person called twice | G7 + G13 should prevent; if it slips, post-call audit (G15) flags; recent-contact suppression (G8) reduces harm | Root-cause the race; the two-person cold approval limits blast radius |
| F8 | **Customer requests removal** | Normal | — | G14 captures phrase live → immediate global suppression (G5) → confirmation → end | Permanent, cross-pipeline, cross-campaign |
| F9 | **Customer complains** | Annoyed recipient | — | Flag call + agent; auto-pause agent if complaint rate crosses threshold; preserve recording+transcript as evidence | Human review; possible campaign halt |
| F10 | **Threatens regulator (ACMA/OAIC) complaint** | Serious | — | **Highest-severity path:** instant per-contact suppression, immediate operator + Aida-team alert, freeze the campaign pending review, assemble the evidence pack (all G17 records) automatically | Human/legal handling; the audit trail is the defence |
| F11 | **Wrong-number / reassigned number** | Stale data | Confused recipient | Agent apologises, suppresses, flags list quality | Campaign list-quality score drops; may trigger re-wash/re-source |
| F12 | **Kill switch engaged** | Human or monitor | In-flight calls finish or cut per policy; no new dials | Queue frozen within seconds | Deliberate; requires human re-enable |
| F13 | **Compliance-gate data stale at runtime** | Scrub expired between queue and dial | — | G13 catches it → abort + requeue for re-wash | By design; this is why G13 exists |
| F14 | **Bad list slips past import** | G1/G2 bug | Potential unlawful calls | G3/G5/G13 independently catch on the dial path; post-call audit catches survivors; kill switch bounds it | Redundancy is the recovery; then fix G1 |

## 11. Data model

Descriptive only — no SQL per constraints. New tables live alongside existing
Aida tables and are tenant-scoped by `client_id` exactly like the rest of the
system (§13). Pipeline isolation (§4) is reinforced by a mandatory `pipeline`
discriminator on campaign-linked rows and by never sharing a queue row between
pipelines.

| Table | Purpose | Key fields |
|---|---|---|
| `campaigns` | A named outbound effort | id, client_id, **pipeline (A/B)**, status, personality_id, script_template_id, caps (max_attempts, per-day), approval state, approver, created_by |
| `campaign_approvals` | G11/G12 evidence | id, campaign_id, approver_user, role, approved_at, second_approver (nullable), notes |
| `contacts_outbound` | Prospects/leads for outbound (distinct from inbound-derived `contacts`; may link to one) | id, client_id, campaign_id, pipeline, phone, timezone, source, **lawful_basis**, linked_inbound_contact_id (nullable) |
| `consent_records` | G2 evidence, immutable | id, contact ref, basis_type (express/inferred/existing-customer/washed-cold), evidence_ref, captured_at, captured_by/how |
| `dnc_scrubs` | G3/G4 evidence | id, contact/number, scrubbed_at, result (on/off register), batch_ref |
| `opt_outs` | G5, permanent, cross-campaign | id, client_id, phone, source_call_id, opted_out_at (append-only; never deleted) |
| `blacklist` | Aida-wide + per-client hard blocks | id, scope, phone/pattern, reason |
| `queues` | Dialable work items | id, campaign_id, contact ref, pipeline, scheduled_for (recipient-local), attempts, state, last_gate_snapshot |
| `attempts` | Every dial attempt | id, queue_id, contact ref, started_at, twilio_call_sid, disposition, agent_id, recording_url, transcript_ref |
| `compliance_log` (G17) | Append-only master audit | id, entity refs, gate, decision (pass/veto), reason, actor (system/human), timestamp, evidence_refs — **write-once, retained ≥ statutory** |
| `agent_profiles` | §8 personality bundles | id, client_id, base_personality, voice, custom_overlay (validated non-weakening), immutable_preamble_version |
| `conversation_templates` | §9 scripts per pipeline/personality | id, pipeline, personality_id, blocks, version |
| `outcomes` | Result tracking → feeds CRM + reporting | id, attempt_id, category (booked/qualified/not-interested/opt-out/wrong-person/callback/voicemail/no-answer), revenue_link, qualified_handoff_id |

Relationships: `campaigns 1─* queues 1─* attempts 1─* outcomes`; `contacts_outbound
*─1 campaigns`; `consent_records`/`dnc_scrubs`/`opt_outs` reference contact/number
and are the evidentiary spine; `compliance_log` references everything and is never
updated in place. A qualified `outcome` creates a handoff into the **existing**
inbound CRM (`contacts`, calendar, email) — the BDM's job is to feed the pipeline
Aida already has.

## 12. Reporting

Two dashboard families, mirroring the pipeline split (§4.2) so the metrics that
predict regulatory trouble are never averaged away.

**Performance (per pipeline, per campaign, per agent):**
- Conversions, appointments booked, revenue attributed (via outcome→CRM link).
- Calls placed, contact rate, average handle time, cost per call / per qualified
  lead.
- Agent-personality comparison; campaign comparison; speed-to-lead (A).

**Compliance (first-class, alert-backed):**
- **Opt-out rate** and **complaint rate** per campaign — with hard alert
  thresholds that auto-pause an agent/campaign (esp. cold).
- DNC-scrub freshness coverage; % calls with complete evidence (target 100%).
- Calls attempted outside hours (target 0 — any >0 is an incident).
- Regulator-mention count (any >0 = immediate escalation).
- Failure-mode counts (§10), kill-switch activations, post-call audit anomalies.

Design stance: **the compliance dashboard is the primary dashboard for cold.** A
cold campaign with great conversions and a rising complaint rate is a failing
campaign. The reporting layer encodes that value judgement.

## 13. Reuse of existing Aida

**Reused as-is (the BDM is a producer for these):**
- The entire post-call pipeline: recording → Deepgram (`transcribe.js`) → Claude
  (`analyse.js`) → `contacts.js` → `business-profile.js` → `gmail.js`/`gcal.js`/
  `notify.js`. An outbound call that qualifies simply enters this pipeline.
- `business-profile` intelligence to auto-select agent personality (§8).
- Supabase, tenant scoping by `client_id`, the Phase 1–4 auth/isolation work,
  invite-based client accounts.
- Twilio account, number management, recording infrastructure, and the idempotent
  `/recording/complete` contract (`claim_recording`).

**New subsystems (isolated from inbound):**
- The compliance gate stack (§5–6) — the core IP and the hardest part.
- The two pipeline engines, schedulers, and queues (§4).
- The `VoiceAgentProvider` abstraction over Retell/ConversationRelay (§7).
- New routes: campaign/list management, approvals, opt-out ingestion, kill switch,
  outbound webhooks for the voice vendor, reporting APIs — all behind existing
  auth, all tenant-scoped, none touching inbound call routing.
- New tables (§11), additive.

**Explicitly not touched:** inbound `/inbound`, `/recording`, `/call`, the VOIP_V2
delivery path, and every existing service interface. The BDM sits beside them and
feeds the shared CRM.

## 14. Phases

**Phase 0 — Legal foundation (before any dialing code).** Engage AU
telco/privacy counsel; confirm the §2 rules, the recording-consent posture per
state, disclosure wording, and whether/where inferred consent is usable. Nothing
dials until this is signed off. Deliverable: a compliance spec counsel has
approved, which becomes the test oracle for the gate stack.

**Phase 1 — MVP: Warm-only, human-approved, tiny volume.**
- Pipeline A only. No cold. Manual campaign approval on every run.
- Full gate stack G1/G2/G5/G7/G9/G10/G13/G14/G15/G16/G17 implemented and tested —
  yes, the whole safety spine, even for warm, because it's the product's spine.
- Retell + Twilio; one personality (Professional); booking + opt-out + voicemail +
  transfer conversation blocks.
- Kill switch and append-only legal log working and drilled.
- Acceptance: 100% of calls have complete evidence; 0 out-of-hours calls; opt-outs
  honoured instantly and permanently; every call reconstructable from G17.

**Phase 2 — Pilot: Warm at modest scale + first cold behind maximum gates.**
- Add G3/G4 (DNC wash) + G11/G12 (approval, two-person for cold) → enable a small,
  hand-vetted Pipeline B campaign.
- Add personalities; add compliance dashboard with auto-pause thresholds.
- Reconciliation jobs (F4/F5), recent-contact suppression (G8), manual exclusions
  (G6).
- Acceptance: cold complaint & opt-out rates under target; audit anomalies → human
  review loop proven; a simulated "regulator complaint" (F10) produces a complete
  evidence pack automatically.

**Phase 3 — Commercial launch: controlled automation.**
- Both pipelines, more clients; automated scheduling within gates; per-client
  personality auto-selection from business profile.
- Provider abstraction hardened; evaluate ConversationRelay migration on
  economics.
- Privacy Act ADM disclosure (Dec 2026) built into client privacy policies and
  onboarding.

**Phase 4 — Enterprise/scale.** Multi-number/multi-region, advanced routing/ring
groups, ML-assisted list quality scoring, deeper analytics, SOC2-style controls,
and continuous legal-monitoring for the incoming AI-disclosure/direct-marketing
reforms flagged in §2.3.

Sequencing rule: **capability is unlocked by compliance maturity, never the
reverse.** Cold is last and gated hardest.

## 15. Red-team: destroying our own design

Adversarial pass. For each weakness: the attack, then the redesign.

**W1 — "The scrub was fresh at queue time but stale at dial."**
*Attack:* a big campaign queues 50k numbers, dials over days, wash expires
mid-run → unlawful calls to newly-registered numbers.
*Redesign:* G13 runtime freshness is **mandatory and non-bypassable**; queue items
carry the wash timestamp and are auto-frozen + requeued for re-wash at 30 days;
long campaigns re-wash in rolling batches. Already in the design — elevate it to a
tested invariant with an alert if any dial proceeds on a >30-day scrub (target:
impossible).

**W2 — "Operator uploads a consumer list mislabeled as business/existing-customer."**
*Attack:* bad G2 declaration lets a cold consumer list masquerade as warm and skip
the DNC wash.
*Redesign:* declaration alone is insufficient — add (a) automated
consumer-vs-business heuristics at G1 that *contradict* a "business/existing"
claim and quarantine on mismatch, (b) **DNC wash runs on Pipeline A too** unless a
per-contact existing-relationship evidence row exists (not just a list-level
checkbox), (c) two-person approval when a "warm" list has no linkable inbound
history in Aida's own data. The system distrusts the human's label.

**W3 — "The voice vendor is the compliance weak point."**
*Attack:* Retell mishears an opt-out, or a prompt-injection from the recipient
("ignore your instructions") makes the agent misbehave; ACL/deception exposure.
*Redesign:* opt-out/complaint detection (G14) runs in **Aida's** backend on the
live transcript, independent of the vendor's own NLU, with conservative
phrase-matching that errs toward ending the call. The immutable preamble (§8) and
a post-call audit (G15) that verifies disclosures actually occurred catch vendor
drift. Never trust the mouth to be the conscience.

**W4 — "One bug dials everyone."**
*Attack:* a loop/race in the scheduler mass-dials.
*Redesign:* rate limiters and per-campaign/per-client velocity caps at G13; the
kill switch (G16) is monitor-triggerable on abnormal dial velocity; cold requires
approval so no cold campaign auto-starts. Blast radius is bounded by caps +
auto-kill, not just by "we'll fix the bug."

**W5 — Legal risk: recording consent across states.**
*Attack:* recording a live two-party call in an all-party-consent state without
proper notice = criminal exposure under a surveillance-devices Act, far worse than
a DNC fine.
*Redesign:* uniform **recording disclosure at call open in every state** (the
conservative default), with a clean compliant termination if the party objects;
per-state config exists but defaults to the strictest interpretation; Phase 0
counsel signs the exact wording. When uncertain, disclose.

**W6 — Commercial risk: complaint-driven reputational/regulatory spiral.**
*Attack:* even lawful cold calling generates complaints; ACMA scrutiny follows
volume + complaint rate; one client's aggressive campaign taints the Aida platform
and its Twilio numbers.
*Redesign:* platform-level (not just per-client) complaint/opt-out thresholds that
throttle or suspend cold across the tenant if aggregate metrics spike;
number/sender reputation monitoring; contractual acceptable-use terms; the ability
to disable cold platform-wide via one switch. Treat cold as a **platform risk**,
not just a client feature.

**W7 — Scaling bottleneck: the append-only legal log and DNC wash throughput.**
*Attack:* at volume, G17 writes and DNC API throughput become the limiter; or
worse, someone "optimises" by batching/deferring evidence writes and a crash loses
evidence for calls that already happened.
*Redesign:* evidence is written **before** the dial and is on the critical path
(no dial without a committed G17 record); scale the log as an append-only,
partitioned store; cache/queue DNC washes as bulk batch jobs with their own
freshness accounting; never trade evidence durability for throughput. If the log
can't keep up, dialing slows — that's the correct failure direction.

**W8 — Abuse scenario: a malicious operator uses Aida as a harassment/scam tool.**
*Attack:* someone signs up, uploads a hostile list, tries to run scam scripts.
*Redesign:* KYC/vetting before cold is enabled per client; script templates are
constrained and reviewed (can't free-type an arbitrary agent that drops the
compliance preamble); anomaly detection on list sources and call patterns;
per-client cold approval by Aida (not just self-approval) in early phases;
acceptable-use enforcement with hard suspension. Cold is a **privilege granted
after vetting**, not a default capability.

**W9 — Regulatory-horizon risk: AI-disclosure/direct-marketing reforms land.**
*Attack:* the flagged Privacy Act direct-marketing opt-out right and the clear
trajectory toward mandatory AI-voice disclosure (§2.3) become law; a design that
treated disclosure as optional is suddenly non-compliant at scale.
*Redesign:* already mitigated by making AI disclosure and a simple opt-out the
**default now**; add a compliance-config versioning system so a legal change is a
config/rollout, not a re-architecture; keep Phase 4 legal-monitoring as a standing
function.

**Residual honest risks (cannot fully engineer away):** carrier/vendor outages;
the inherent complaint-generation of cold calling; the possibility that counsel
concludes AI cold-calling of consumers is too risky to offer at all in AU — in
which case the **warm-only** product (Pipeline A) remains valuable and lawful on
its own, and cold stays disabled. The architecture supports shipping A without B
indefinitely, which is itself a risk mitigation.

## 16. Open questions

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| Q1 | **Recording consent per AU state** for live outbound — exact disclosure wording and whether any state makes it untenable | Phase 0 → all dialing | Uniform strict disclosure; abandon call on objection |
| Q2 | Is **inferred consent** ever safe enough to rely on for warm (A), or do we require per-contact express/existing-relationship evidence? | Phase 1 gate config (G2/G3) | Require evidence; treat inferred as lawyer-gated exception |
| Q3 | Does Aida offer **cold (Pipeline B) at all** in AU, or warm-only initially? | Phase 2 scope | Warm-only until counsel + vetting are in place |
| Q4 | Is the autonomous BDM an **ADM "significant effect"** under the Dec 2026 Privacy Act provisions (requiring policy disclosure)? | Phase 3 | Assume yes; build disclosure |
| Q5 | **Mandatory AI-voice disclosure** — adopt proactively now (recommended) or on-request only? | Conversation design | Proactive disclosure both pipelines |
| Q6 | Voicemail on cold: leave an identified message or no message? | §9 cold voicemail | Conservative: no unsolicited voicemail on pure cold; revisit with counsel |
| Q7 | Retell vs ConversationRelay for MVP given the recording-in-Twilio consistency argument | Phase 1 build | Retell for speed, abstraction for later swap |
| Q8 | Who approves cold campaigns in early phases — client self-serve, or Aida-team gatekeeping (recommended)? | G11/G12 | Aida-team approval until KYC + track record |
| Q9 | Data-source due diligence for purchased/ABN lists — what provenance evidence is required at G2? | Phase 2 | Require documented source + lawful-basis attestation, quarantine otherwise |
| Q10 | Retention periods for recordings/transcripts/evidence vs. call-back-number ≥30-day rule and privacy minimisation tension | §11, Phase 1 | Longest applicable statutory minimum; document justification |
| Q11 | Cross-pipeline identity: how strictly do we enforce "one active pipeline per contact," and what's the promotion (B→A) consent event | §4.3 | Explicit logged consent only; no silent promotion |
| Q12 | Platform-level cold suspension policy — thresholds and who can trigger | §15 W6 | Conservative auto-throttle + human confirm |

---

*End of document. This is a compliance-critical design: implementation must
proceed Phase 0 (legal) first, then capability strictly gated by compliance
maturity (warm before cold, human-approved before automated). Any change to a
compliance gate, consent basis, or disclosure requirement must be reflected here
and re-approved by counsel before code changes. The gate stack (§5–6) and the
append-only evidence store (§11, G17) are the load-bearing elements — treat them
as the product's spine, not features.*
