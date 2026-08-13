// LOCKSMITH ACQUISITION E-10A — the outbound agent, specified and unprovisioned.
//
// Eighteen conversations a real locksmith might actually have, run through the
// classification path that will decide what goes in the permanent record. Plus
// the ratchets — because the prompt is the one artefact in this system that a
// well-meaning edit can weaken without breaking anything.
//
// Nothing here creates an agent, reads a credential, or reaches a network.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  ACQUISITION_AGENT_SPEC,
  DEFAULT_IDENTITY,
  PERMITTED_CLAIMS,
  FORBIDDEN_CLAIMS,
  PRICE_RULE,
  VOICEMAIL_POLICY,
  buildAcquisitionOpening,
  buildAcquisitionAgentPrompt,
  buildAcquisitionAnalysisFields,
  describeAcquisitionAgentPayload,
} = require("../src/services/acquisition-agent-spec");

const {
  validateAcquisitionAnalysis,
  classifyAnalysedOutcome,
  ANALYSED_OUTCOMES,
  ANALYSIS_CODES,
  EXPLICIT_OPT_OUT_RULE,
} = require("../src/services/acquisition-agent-contract");

const { classifyTechnicalOutcome } = require("../src/services/acquisition-call-events");

const PROMPT = buildAcquisitionAgentPrompt();
const OPENING = buildAcquisitionOpening();

/** Analysis as Retell would return it, from a conversation. */
const analysis = (over = {}) => ({
  reached_human: true,
  outcome: "no_meaningful_conversation",
  explicit_opt_out: false,
  callback_requested: false,
  requested_callback_at: null,
  confidence: "high",
  reason: "fixture",
  evidence_ref: "turn:5",
  ...over,
});

/** Validate then classify, the way the return path does. */
function decide(raw) {
  const v = validateAcquisitionAnalysis(raw);
  if (!v.ok) return { held: true, code: v.code, outcome: null };
  const mapped = classifyAnalysedOutcome(v.analysis);
  return { held: !mapped.outcome, code: null, outcome: mapped.outcome, callbackAt: mapped.callbackAt || null };
}

// ---------------------------------------------------------------------------
// THE EIGHTEEN CONVERSATIONS
// ---------------------------------------------------------------------------

describe("E-10A: eighteen conversations a locksmith might actually have", () => {
  it("1. an interested locksmith becomes qualified, never booked", () => {
    const r = decide(analysis({ outcome: "interested", reason: "Wants to hear more; asked how it handles urgent jobs." }));
    assert.strictEqual(r.outcome, "qualified", "nothing on a first call can confirm a booking");
  });

  it("2. \"how does it work?\" is not an outcome on its own", () => {
    const r = decide(analysis({ outcome: "no_meaningful_conversation", reason: "Asked how it works; call cut off before answering." }));
    assert.strictEqual(r.held, true, "a question is not a decision");
  });

  it("3. asking about price does not decide anything, and the agent may not raise it", () => {
    const r = decide(analysis({ outcome: "interested", reason: "Asked what it costs, then asked to think about it." }));
    assert.strictEqual(r.outcome, "qualified");
    assert.strictEqual(PRICE_RULE.proactive, false, "the agent must never introduce price itself");
    assert.strictEqual(PRICE_RULE.neverInvent, true);
  });

  it("4. not interested is permanent, and distinct", () => {
    const r = decide(analysis({ outcome: "not_interested", reason: "Said they're not interested." }));
    assert.strictEqual(r.outcome, "not_interested");
  });

  it("5. declined stays declined — never collapsed into not_interested", () => {
    const r = decide(analysis({ outcome: "declined", reason: "Heard the offer and said no thanks." }));
    assert.strictEqual(r.outcome, "declined");
  });

  it("6. \"don't call me again\" is an opt-out, with evidence", () => {
    const r = decide(analysis({
      outcome: "declined", explicit_opt_out: true, confidence: "high",
      evidence_ref: "turn:3 — \"don't call me again\"", reason: "Asked not to be contacted again.",
    }));
    assert.strictEqual(r.outcome, "opt_out", "the strongest statement wins");
  });

  it("7. \"I'm busy\" is NOT a refusal and NOT an opt-out", () => {
    const r = decide(analysis({ outcome: "no_meaningful_conversation", reason: "On a job, couldn't talk." }));
    assert.strictEqual(r.held, true, "a bad moment is not an answer about the offer");
    assert.notStrictEqual(r.outcome, "opt_out");
    assert.notStrictEqual(r.outcome, "not_interested");
    assert.notStrictEqual(r.outcome, "declined");
  });

  it("8. \"call me tomorrow afternoon\" is a callback, carrying the time", () => {
    const r = decide(analysis({
      outcome: "callback_requested", callback_requested: true,
      requested_callback_at: "2026-08-06T04:00:00Z", reason: "Asked for tomorrow afternoon.",
    }));
    assert.strictEqual(r.outcome, "callback");
    assert.strictEqual(r.callbackAt, "2026-08-06T04:00:00Z");
  });

  it("9. the wrong person is wrong_person, not a sales target", () => {
    const r = decide(analysis({ outcome: "wrong_person", reason: "Number reaches a private residence." }));
    assert.strictEqual(r.outcome, "wrong_person");
    assert.match(ACQUISITION_AGENT_SPEC.behaviours.gatekeeper.forbidden, /Pitching them personally/);
  });

  it("10-11. \"are you a robot?\" and \"are you a real person?\" must be answered plainly", () => {
    // Not an outcome — a disclosure obligation. Pinned on the prompt.
    assert.match(PROMPT, /If they ask whether you are AI, a robot, automated, or a real person/i);
    assert.match(PROMPT, /Answer immediately and plainly: yes, you are an AI assistant/i);
    assert.match(PROMPT, /Never say or imply that you are a person, human/i);
    assert.match(PROMPT, /This rule has no exceptions/i);
  });

  it("12. a hostile recipient is not silently turned into an opt-out", () => {
    const r = decide(analysis({ outcome: "not_interested", reason: "Annoyed at being called; said he wasn't interested." }));
    assert.strictEqual(r.outcome, "not_interested", "anger is not a request never to be contacted");
    assert.match(ACQUISITION_AGENT_SPEC.behaviours.hostile.forbidden, /Any continuation/);
  });

  it("13. voicemail comes from the machine, not from the analysis", () => {
    assert.strictEqual(classifyTechnicalOutcome("voicemail_reached"), "voicemail");
    assert.strictEqual(classifyTechnicalOutcome("machine_detected"), "voicemail");
    assert.ok(!ANALYSED_OUTCOMES.includes("voicemail"), "one fact must not have two sources that can disagree");
  });

  it("14. no answer likewise", () => {
    assert.strictEqual(classifyTechnicalOutcome("dial_no_answer"), "no_answer");
    assert.ok(!ANALYSED_OUTCOMES.includes("no_answer"));
  });

  it("15. \"maybe another time\" is ambiguous and writes nothing", () => {
    const r = decide(analysis({ outcome: "no_meaningful_conversation", reason: "Said maybe another time, nothing definite." }));
    assert.strictEqual(r.held, true);
    assert.ok(EXPLICIT_OPT_OUT_RULE.doesNotCount.includes("maybe later"));
  });

  it("16. already has a receptionist — a real decline, not an opt-out", () => {
    const r = decide(analysis({ outcome: "declined", reason: "Already uses an answering service." }));
    assert.strictEqual(r.outcome, "declined");
  });

  it("17. missed calls ARE a problem for them — interested", () => {
    const r = decide(analysis({ outcome: "interested", reason: "Says he misses several calls a week on jobs." }));
    assert.strictEqual(r.outcome, "qualified");
  });

  it("18. an unsupported feature question may not be answered with a promise", () => {
    // The agent has no way to say yes to this, and the prompt forbids inventing one.
    assert.ok(FORBIDDEN_CLAIMS.some((c) => /Integrations, CRM connections or features that are not built/.test(c)));
    assert.match(PROMPT, /What you must never claim/);
    assert.match(PROMPT, /features that are not built/i);
  });
});

// ---------------------------------------------------------------------------
// THE OPENING
// ---------------------------------------------------------------------------

describe("E-10A: the opening discloses, unprompted", () => {
  it("names the assistant, says AI assistant, names the company, and says why", () => {
    assert.match(OPENING, /this is Aida/i, "the assistant names itself");
    assert.match(OPENING, /an AI assistant/i, "the disclosure");
    assert.match(OPENING, /calling from AIDA/i, "the company");
    assert.match(OPENING, /locksmith businesses handle missed and after-hours calls/i, "what we do");
    assert.match(OPENING, /see if that might be useful for your business/i, "why we are calling");
  });

  it("is what the agent opens with, and is in the payload's begin_message", () => {
    assert.ok(PROMPT.includes(OPENING), "the prompt must open with the same words");
    assert.strictEqual(describeAcquisitionAgentPayload().begin_message, OPENING);
  });

  it("survives identity being reconfigured, because the parts are named", () => {
    const o = buildAcquisitionOpening({ assistantName: "Ada", company: "Niche Drops" });
    assert.match(o, /this is Ada/);
    assert.match(o, /an AI assistant/, "the disclosure is not a configurable detail");
    assert.match(o, /calling from Niche Drops/);
  });
});

// ---------------------------------------------------------------------------
// RATCHETS — the prompt is the artefact a well-meaning edit can weaken
// ---------------------------------------------------------------------------

describe("E-10A ratchets: the prompt cannot quietly lose its obligations", () => {
  it("AI disclosure cannot be removed from the opening", () => {
    assert.match(OPENING, /\bAI assistant\b/, "the opening must disclose");
    assert.match(PROMPT, /You say this unprompted, at the start, before anything else/i);
    assert.match(PROMPT, /You never wait to be asked what you are/i);
  });

  it("the agent can never claim to be human", () => {
    for (const forbidden of [/\bI am (a )?human\b/i, /\bI'm (a )?human\b/i, /\bI am a person\b/i, /\bI'm a person\b/i, /\bnot an AI\b/i, /\breal person\b(?!\?)/i]) {
      const offending = PROMPT.split("\n").filter((l) => forbidden.test(l) && !/Never|never|ask whether/.test(l));
      assert.deepStrictEqual(offending, [], `the prompt must not permit "${forbidden}"`);
    }
    assert.match(PROMPT, /Never say or imply that you are a person, human/i);
  });

  it("AIDA identity cannot be omitted", () => {
    assert.match(OPENING, /AIDA/);
    assert.match(PROMPT, /on behalf of AIDA/i);
    assert.strictEqual(DEFAULT_IDENTITY.company.length > 0, true);
  });

  it("pitching after an explicit opt-out is forbidden in the strongest terms", () => {
    assert.match(PROMPT, /Agree immediately/i);
    assert.match(PROMPT, /Do not ask why\. Do not ask if they are sure\. Do not ask anything\. Do not offer anything\./i);
    assert.match(PROMPT, /Then END THE CALL/i);
    assert.match(ACQUISITION_AGENT_SPEC.behaviours.optOut.forbidden, /Asking why/);
    assert.match(ACQUISITION_AGENT_SPEC.behaviours.optOut.forbidden, /Asking if they are sure/);
  });

  it("pitching after a clear not-interested is forbidden", () => {
    assert.match(PROMPT, /Do not pitch again/i);
    assert.match(PROMPT, /One "no" is the whole answer/i);
    assert.match(ACQUISITION_AGENT_SPEC.behaviours.notInterested.forbidden, /Any second pitch/);
    assert.match(ACQUISITION_AGENT_SPEC.behaviours.declined.forbidden, /second close/i);
  });

  it("\"busy\" is explicitly NOT a refusal", () => {
    assert.match(PROMPT, /are NOT a refusal/i);
    assert.ok(EXPLICIT_OPT_OUT_RULE.doesNotCount.includes("busy"));
    assert.ok(EXPLICIT_OPT_OUT_RULE.doesNotCount.includes("not now"));
  });

  it("the analysis outcome is a closed enum, not free text", () => {
    const fields = buildAcquisitionAnalysisFields();
    const outcome = fields.find((f) => f.name === "final_outcome");
    assert.strictEqual(outcome.type, "enum");
    assert.deepStrictEqual([...outcome.choices].sort(), [...ANALYSED_OUTCOMES].sort());
    assert.strictEqual(validateAcquisitionAnalysis(analysis({ outcome: "sounded_keen" })).code, ANALYSIS_CODES.UNKNOWN_OUTCOME);
  });

  it("an opt-out without evidence or confidence is refused, not downgraded", () => {
    for (const weak of [{ confidence: "medium" }, { confidence: "low" }, { evidence_ref: null }]) {
      const r = decide(analysis({ explicit_opt_out: true, ...weak }));
      assert.strictEqual(r.held, true, JSON.stringify(weak));
      assert.strictEqual(r.code, ANALYSIS_CODES.UNSUPPORTED_OPT_OUT);
      assert.notStrictEqual(r.outcome, "declined", "never quietly downgraded");
    }
    // And the Retell field itself tells the model the conservative rule.
    const evidence = buildAcquisitionAnalysisFields().find((f) => f.name === "transcript_evidence");
    assert.match(evidence.description, /REQUIRED when explicit_opt_out is true/i);
    const optOut = buildAcquisitionAnalysisFields().find((f) => f.name === "explicit_opt_out");
    assert.match(optOut.description, /If you are unsure, answer false/i);
    assert.match(optOut.description, /is NOT an opt-out/i);
  });

  it("no unsupported guarantee may appear in the prompt", () => {
    // Scanned with the PROHIBITIONS SECTION REMOVED, not with an exception list.
    //
    // "# What you must never claim" exists precisely to name the things the
    // agent may not say, so it will always contain the words a naive scan is
    // looking for. Excluding that one section by heading keeps the rule
    // absolute everywhere it means anything, instead of accumulating
    // per-phrase exemptions that would eventually let a real promise through.
    const sections = PROMPT.split(/^# /m);
    const spoken = sections.filter((s) => !s.startsWith("What you must never claim")).join("\n# ");
    assert.ok(spoken.length > 500, "the sanitised prompt must still be most of the prompt");
    assert.ok(!/What you must never claim/.test(spoken), "the prohibitions section really was removed");

    for (const banned of [/\bguarantee(d|s)?\b/i, /\bnever miss(es)?\b/i, /\bnever lose\b/i, /\brisk[- ]free\b/i, /\bdouble your\b/i]) {
      const offending = spoken.split("\n").filter((l) => banned.test(l));
      assert.deepStrictEqual(offending, [], `the prompt must not promise "${banned}"`);
    }
  });

  it("the marketing tagline is explicitly forbidden as a spoken claim", () => {
    const { getLocksmithConfig } = require("../src/config/locksmith");
    const tagline = getLocksmithConfig({}).tagline;
    assert.match(tagline, /Never lose another/i, "the tagline really is an absolute");
    assert.ok(!PROMPT.includes(tagline), "an absolute written on a page a visitor chose to read is not a promise to make down a telephone");
    assert.ok(FORBIDDEN_CLAIMS.some((c) => /including the marketing tagline/i.test(c)));
  });

  it("every permitted claim traces to what the product page actually says", () => {
    const page = fs.readFileSync(path.join(__dirname, "..", "src", "views", "locksmith-page.js"), "utf8");
    for (const token of ["missed and after-hours", "location", "escalates urgent"]) {
      assert.ok(page.includes(token), `the page must actually say "${token}"`);
    }
    assert.ok(PERMITTED_CLAIMS.some((c) => /missed and after-hours/i.test(c)));
    assert.ok(PERMITTED_CLAIMS.some((c) => /escalates urgent jobs/i.test(c)));
  });

  it("price is never hardcoded into the spec", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-spec.js"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
    assert.ok(!/\b149\b|\b299\b/.test(code), "the numbers live in config, which declares itself provisional");
    // Without pricing supplied, the prompt quotes nothing.
    assert.match(PROMPT, /Do not quote a number — you have not been given one/i);
    // With pricing supplied, it quotes exactly what it was given.
    const withPrice = buildAcquisitionAgentPrompt({ pricing: { currency: "A$", setupAmount: 149, monthlyAmount: 299, commitment: "month-to-month" } });
    assert.match(withPrice, /A\$149 to set up and A\$299 a month/);
    assert.match(withPrice, /founding-pilot pricing confirmed at setup/i);
  });
});

// ---------------------------------------------------------------------------
// VOICEMAIL AND PROVISIONING
// ---------------------------------------------------------------------------

describe("E-10A: voicemail and the unsent payload", () => {
  it("recommends leaving NO message, and invents no template", () => {
    assert.strictEqual(VOICEMAIL_POLICY.leaveMessage, false);
    assert.strictEqual(VOICEMAIL_POLICY.template, null, "no message is invented before machine detection is observed");
    assert.match(VOICEMAIL_POLICY.attemptCost, /consumes a counted attempt/i);
  });

  it("the payload is complete enough to review, and has been sent nowhere", () => {
    const p = describeAcquisitionAgentPayload({ config: { voiceId: "v", webhookBaseUrl: "https://example.test" } });
    assert.match(p.agent_name, /^aida-acquisition-/);
    assert.strictEqual(p.language, "en-AU");
    assert.ok(p.general_prompt.length > 500);
    assert.ok(Array.isArray(p.post_call_analysis_data));
    assert.match(p._note, /has not been sent to any provider and no agent exists/i);
  });

  it("the spec reaches no network, reads no environment, and creates no agent", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-spec.js"), "utf8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");
    assert.ok(!/process\.env/.test(src), "it must not read the environment");
    for (const p of [/\bfetch\s*\(/, /createAgent/, /require\(["'](axios|got|node-fetch|undici|twilio|retell-sdk)/, /require\(["']\.\/retell-adapter["']\)/, /https?:\/\/(?!example\.test)/]) {
      assert.ok(!p.test(code), `the spec must not contain ${p}`);
    }
    for (const r of [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])) {
      assert.ok(r.startsWith("./"), `may not import ${r}`);
    }
  });

  it("nothing in the repository constructs the agent from this spec", () => {
    const dir = path.join(__dirname, "..", "src", "services");
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "acquisition-agent-spec.js")) {
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      if (/describeAcquisitionAgentPayload\s*\(/.test(body)) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [], offenders.join("; "));
  });

  it("the spec defers to the E-7B2B1 contract rather than restating it", () => {
    const { ACQUISITION_AGENT_CONTRACT } = require("../src/services/acquisition-agent-contract");
    assert.strictEqual(ACQUISITION_AGENT_SPEC.governedBy, ACQUISITION_AGENT_CONTRACT.version);
    assert.strictEqual(ACQUISITION_AGENT_SPEC.purpose, "cold_acquisition");
  });
});
