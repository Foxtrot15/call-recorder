# New client implementation checklist

Everything needed to put a new business onto AIDA. If a step here requires
writing code, the platform has a gap — say so rather than writing the code.

The one worked example is `scripts/dev/platform-new-client-walkthrough.js`,
which does all of this for a fictional electrician.

---

## Before you start

- [ ] The business has agreed, and somebody at that business is named as the
      person who will **approve** their configuration. An approval without a
      person is not an approval, and the authority refuses `system`, `aida`,
      `bot`, `automation`, `cron` and similar.
- [ ] You have a `clientId`: lower_snake, starting with a letter, ≤60
      characters. It is permanent — no patch can change it.
- [ ] You have a `vertical` slug. It is a label. **Nothing branches on it**, so
      pick something readable rather than something the code will recognise.

---

## 1. Describe the business

```bash
node scripts/client.js init harbour_electrical electrical > harbour.json
```

Fill it in with the owner. The sections, and the questions worth asking aloud:

- [ ] **identity** — legal name, trading name (what the caller hears), the
      assistant's name, timezone, a description in the owner's own words.
- [ ] **services** — every job they take. Slug, caller-facing name, **aliases**
      (what a caller actually says: "water everywhere", "locked out of my
      house"), urgency category, notes, exclusions.
      - Jobs they explicitly **refuse** belong here too, with `enabled: false`
        and the reason in `description`. "We don't do automotive" is an
        instruction to the assistant, not an absence.
- [ ] **serviceArea** — regions, suburbs, postcodes, radius, exclusions, and
      what to do with someone outside it. *"Nothing"* is not an answer to a
      caller.
- [ ] **hours** — every day of the week stated, closed days included. After
      hours: available or not, the policy, whether a surcharge applies.
- [ ] **callHandling**
      - greeting **style** (an instruction, not the words — the spoken opening
        line is built by the platform and always discloses AI)
      - what is collected on **every** call
      - what is collected **per service**
      - extra questions, each scoped to the services it applies to. Leave
        `appliesToServices` empty only if it genuinely belongs on every call.
      - **urgency rules** — condition in plain words, level, action, whether it
        transfers, and the exact wording to say
      - **escalation** — primary and backup numbers in E.164, permitted hours,
        eligible services, minimum urgency, timeout, retries, pre-transfer
        wording
- [ ] **knowledge** — approved facts with a source for each; prohibited claims
      (additions to the mandatory six); uncertainty policy; pricing disclosure
      and wording.
- [ ] **compliance** — are calls recorded? If yes, the disclosure wording is
      **required**. Retention for transcripts and recordings; redaction.
- [ ] **booking** — on or off. If on: appointment types, required information,
      constraints, and which **capability** it targets.
- [ ] **voice** — a provider-independent `profileRef` (e.g. `warm_female_au`),
      language, pronunciation hints for local place names, tone.
- [ ] **integrations** — which capabilities are enabled. Capabilities, never
      vendors.
- [ ] **outbound** — leave `enabled: false`. This is a capability description
      and grants no permission; outbound calling is a separate authority.

### Migrating an existing locksmith instead

```js
const { migrateLocksmithProfile } = require("./src/platform/migrate-locksmith-profile");
const result = migrateLocksmithProfile(legacyProfile);
```

- [ ] **Read the whole report.** `notes[]`, `unmapped[]` and `defaultsApplied[]`
      are the interesting output — one entry per thing that did not carry across
      cleanly. Work through every one with the owner.
- [ ] Legacy urgency stopped at `urgent`. Decide, deliberately, whether any rule
      deserves the platform's `emergency` level. Nothing was promoted for you.
- [ ] Choose a voice. The migration deliberately leaves `voice.profileRef` null,
      because the legacy `tone` field is a speaking style and not a voice.

---

## 2. Validate

```bash
node scripts/client.js validate harbour_electrical --store harbour.json
```

- [ ] Zero errors. Every error names a path; fix the configuration, not the
      validator.
- [ ] Read the warnings. They are not blocking, but "no urgency rules" means
      every call is treated the same way.

Failures worth recognising, because each is silent on a real call:

| Error | What it means |
|---|---|
| `callHandling.escalation.primaryNumber` required | something transfers and there is nowhere to transfer to |
| `compliance.recordingDisclosure` required | you are recording callers without telling them |
| `knowledge.prohibitedClaims` mandatory | a claim was removed that no client may remove |
| `voice.profileRef` looks like a provider id | a vendor's voice id ended up in the blueprint |
| `booking.capabilityTarget` no enabled integration | bookings point at a capability nobody enabled |
| `hours.weekly.<day>` required | a day was omitted rather than stated closed |

---

## 3. Review the diff and preview

```bash
node scripts/client.js diff harbour_electrical --to 2 --store harbour.json
node scripts/client.js preview harbour_electrical --store harbour.json \
  --llm-id <llm> --voice-id <voice> --webhook-url <url>
```

- [ ] Read the **first spoken sentence** aloud. It names the business and says
      "an AI assistant". If that reads badly, fix the trading name or the
      assistant name.
      - ⚠ **For an INBOUND client, check this against the founder ruling on AI
        disclosure placement.** The platform puts the disclosure in the first
        sentence for everybody; the existing inbound receptionist does not.
        See "AI disclosure — FOUNDER / PLATFORM POLICY" in
        [AIDA_CLIENT_PLATFORM.md](AIDA_CLIENT_PLATFORM.md). Do not resolve it
        by making the disclosure optional.
- [ ] Read the whole prompt. Everything in it came from the configuration; if
      something is wrong, the configuration is wrong.
- [ ] Check **"What you also ask, depending on the job"**. A question that
      belongs to one service must not be in the always-ask list.
- [ ] Record the **behaviour hash**. It is how you will later answer "has this
      client's behaviour changed?" without reading anything.

If provider references are missing, the preview exits non-zero and names each
one. Supply them; never guess. A substituted placeholder is how the wrong voice
reaches a real caller.

---

## 4. Approval

```bash
node scripts/client.js approve harbour_electrical --version 1 \
  --by "Nadia Farrell" --reason "Read the whole thing aloud with the owner." \
  --store harbour.json
```

- [ ] A **named person** approved, and the reason records what they actually
      did.
- [ ] They saw the diff or the preview before approving. This is the whole point
      of the step.
- [ ] Understand that this does **not** put anything live.

---

## 5. Activation

Deliberately not a CLI command. Activation is called from a caller that can show
somebody what is about to change:

```js
await authority.activateApprovedVersion({ clientId, configVersion, activatedBy });
```

- [ ] Only an **approved** version can activate.
- [ ] The previous active version is superseded first, so there is never a
      moment with two.
- [ ] The activated body is immutable. The next change is a new version.

---

## 6. Integrations

- [ ] For each enabled capability, register an adapter **for this client**:
      ```js
      registry.register({ clientId, capability, adapterRef, adapter });
      ```
- [ ] The adapter implements the **whole** port. A partial one is refused at
      registration, naming what is missing.
- [ ] Recipients, credentials and endpoints live with the **adapter**, not in
      the blueprint. If you migrated a locksmith, its notification recipients
      were carried into `integrations[].notes` as readable text and reported —
      move them to the adapter and confirm them.
- [ ] Confirm a capability the blueprint has **not** enabled does not resolve.

---

## 7. Provisioning — not part of this platform

The compiler builds objects. It imports no transport and can send nothing.

- [ ] Creating provider resources is a separate, hand-run, explicitly authorised
      act, subject to `pr_one_active_per_purpose` — a **database** unique index,
      not an application check somebody has to remember.
- [ ] Two resources, not one: the response engine holds the prompt and the agent
      references it. Sent as one object it creates an agent with no brain.
- [ ] Record the `responseEngineHash` and `agentHash` from the preview. They are
      what a later drift check compares against.

---

## 8. Calling — a different authority entirely

Nothing in this checklist enables a call, and nothing in the platform can.

- [ ] Inbound answering, outbound calling, DNCR, suppression, dial
      authorisation, the global calling stop and dispatch uniqueness are all
      separate authorities with their own gates.
- [ ] `outbound.enabled` in a blueprint is a **description**, not a permission.
      Setting it true changes what the assistant may say about itself and
      nothing about what it may do.

---

## When you are done

- [ ] The client has exactly one active version.
- [ ] `versions <clientId>` shows who created, approved and activated it, and
      when.
- [ ] You wrote no code. If you did, note what the platform could not express —
      that is the next thing to build.
