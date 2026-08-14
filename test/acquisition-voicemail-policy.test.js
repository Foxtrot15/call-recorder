// LOCKSMITH ACQUISITION E-12A — hang up on an answering machine, and prove the
// provider is the one doing it.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────
// "Leave no message" has been founder policy since E-10A, and until now it was
// carried entirely by a sentence in the general_prompt. That is an instruction
// to a language model: advisory, in competition with everything else in the
// context, and unfalsifiable until the call where it loses. The cost of losing
// is specific — a sales pitch recorded onto a stranger's answering machine, and
// one of the two counted attempts (A-L7) spent doing it.
//
// E-12A moves the authority to the provider. Retell ends the call itself on
// detection, without consulting the model. The prompt sentence stays as defence
// in depth; it is no longer the thing being relied on.
//
// ── WHAT THESE RATCHETS ARE FOR ─────────────────────────────────────
// Two failure modes, and they pull in opposite directions. One is the policy
// quietly weakening — a message action appearing, a template being filled in,
// caller config being allowed to override the action. The other is this
// configuration leaking sideways onto the receptionist or the onboarding agent,
// neither of which is a cold-calling surface and neither of which the founder
// authorised to change.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildAcquisitionAgent,
  buildAcquisitionResponseEngine,
  describeAcquisitionRetellResources,
  ACQUISITION_VOICEMAIL_OPTION,
  VOICEMAIL_POLICY,
} = require("../src/services/acquisition-agent-spec");

const { TECHNICAL_OUTCOME_MAP, classifyTechnicalOutcome } = require("../src/services/acquisition-call-events");
const { ATTEMPT_CONSUMPTION } = require("../src/services/acquisition-attempt-policy");

const ACQ_LLM = "llm_acquisition_fixture_0001";
const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");

// ---------------------------------------------------------------------------
// 1-2. DETECTION IS ON, AND THE ACTION IS HANG UP
// ---------------------------------------------------------------------------

describe("E-12A: the acquisition agent hangs up on a detected answering machine", () => {
  it("1. voicemail detection is configured on the agent payload", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.ok("voicemail_option" in agent, "configuring the option is what enables detection");
    assert.ok(agent.voicemail_option && typeof agent.voicemail_option === "object");
    assert.ok(agent.voicemail_option.action, "an option with no action configures nothing");
  });

  it("2. the action is hangup, exactly", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.strictEqual(agent.voicemail_option.action.type, "hangup");
    // Shape asserted whole, so an extra key cannot ride along beside it.
    assert.deepStrictEqual(agent.voicemail_option, { action: { type: "hangup" } });
  });

  it("2b. the exported constant and the payload cannot drift apart", () => {
    assert.deepStrictEqual(buildAcquisitionAgent({ llmId: ACQ_LLM }).voicemail_option, ACQUISITION_VOICEMAIL_OPTION);
    assert.ok(Object.isFrozen(ACQUISITION_VOICEMAIL_OPTION));
    assert.ok(Object.isFrozen(ACQUISITION_VOICEMAIL_OPTION.action));
  });

  it("2c. the policy object names the provider as the authority, not the prompt", () => {
    assert.strictEqual(VOICEMAIL_POLICY.providerAction, "hangup");
    assert.match(VOICEMAIL_POLICY.providerAuthority, /voicemail_option/);
  });
});

// ---------------------------------------------------------------------------
// 3-5. NOTHING IS DELIVERED TO THE MACHINE
// ---------------------------------------------------------------------------

describe("E-12A: no message reaches the answering machine, by any route", () => {
  it("3. no voicemail message exists anywhere in the policy or the payload", () => {
    assert.strictEqual(VOICEMAIL_POLICY.leaveMessage, false);
    assert.strictEqual(VOICEMAIL_POLICY.template, null, "a template is a message waiting for someone to switch it on");
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    // No text-bearing key at any depth of the option.
    const flat = JSON.stringify(agent.voicemail_option);
    assert.ok(!/"text"|"prompt"|"message"|"audio"|"url"/i.test(flat), `nothing to say: ${flat}`);
  });

  it("4. no static_text voicemail action", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.notStrictEqual(agent.voicemail_option.action.type, "static_text");
    assert.ok(!("text" in agent.voicemail_option.action));
  });

  it("5. no generated / prompt-driven voicemail action", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    for (const banned of ["prompt", "generated", "static_text", "callback", "sales"]) {
      assert.notStrictEqual(agent.voicemail_option.action.type, banned);
    }
    // And the engine is not carrying a voicemail script the agent would speak.
    const engine = buildAcquisitionResponseEngine();
    assert.ok(!/voicemail_option/i.test(JSON.stringify(engine)), "the engine does not configure the provider");
  });

  it("5b. FINDING: the prompt never carried this policy at all", () => {
    // Worth stating plainly, because it is the opposite of what everyone
    // assumed. VOICEMAIL_POLICY has existed since E-10A and reads like an
    // instruction to the agent — but it is a spec object consumed by documents
    // and tests, and buildAcquisitionAgentPrompt has never emitted a word of it
    // into general_prompt. So before E-12A the "leave no message" rule was
    // carried by NOTHING that reaches the provider. It was not weak enforcement;
    // it was no enforcement.
    const engine = buildAcquisitionResponseEngine();
    assert.ok(!/voicemail|answering machine/i.test(engine.general_prompt), "if this starts failing, the prompt gained the text and this comment is stale");
    // Which makes the provider setting the ONLY thing enforcing it today.
    assert.strictEqual(buildAcquisitionAgent({ llmId: ACQ_LLM }).voicemail_option.action.type, "hangup");
    // NOT fixed here on purpose: general_prompt belongs to the response engine,
    // and that engine is already provisioned at Retell. Editing the prompt would
    // desynchronise the local spec from the live resource and require an
    // updateResponseEngine call, which E-12A does not authorise.
  });
});

// ---------------------------------------------------------------------------
// 6-7. THE OTHER TWO AGENT FAMILIES ARE UNTOUCHED
// ---------------------------------------------------------------------------

describe("E-12A: acquisition only — the receptionist and onboarding agents do not inherit this", () => {
  it("6. the receptionist compiler configures no voicemail behaviour", () => {
    const text = src("locksmith-receptionist-compiler.js");
    assert.ok(!/voicemail_option/.test(text), "the receptionist answers a locksmith's own callers; it is not cold-calling anyone");
  });

  it("7. the onboarding agent compiler configures no voicemail behaviour", () => {
    const text = src("locksmith-onboarding-agent-compiler.js");
    assert.ok(!/voicemail_option/.test(text), "onboarding interviews a client who asked to be interviewed");
  });

  it("6-7b. voicemail_option is EMITTED in exactly one place in src/", () => {
    // A shared default is the specific mistake this guards. If a second file
    // starts emitting the field, that is a decision to be argued for here.
    //
    // Refined by E-12E: emitting the field and READING it are different acts.
    // The agent-provisioning gate reads `agent.voicemail_option` precisely in
    // order to refuse a payload whose action is not "hangup" — banning that
    // would mean the safety check could not inspect the thing it guards. So
    // this matches the object-key form, and the reader is asserted separately
    // below.
    const dir = path.join(__dirname, "..", "src");
    const emitters = [];
    const readers = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".js")) continue;
        const body = fs.readFileSync(p, "utf8");
        const rel = path.relative(dir, p).replace(/\\/g, "/");
        if (/voicemail_option\s*:/.test(body)) emitters.push(rel);
        else if (/voicemail_option/.test(body)) readers.push(rel);
      }
    };
    walk(dir);
    assert.deepStrictEqual(emitters, ["services/acquisition-agent-spec.js"], "exactly one emitter");
    // Two non-emitters, both named. The provisioning gate READS the field in
    // order to refuse a payload whose action is not "hangup"; the proof plan
    // merely NAMES it in a Phase 0 checklist string. Neither can emit it, and
    // both would be worse for being forbidden to mention it.
    assert.deepStrictEqual(
      readers.sort(),
      ["services/acquisition-agent-provisioning.js", "services/acquisition-proof-plan.js"],
      "exactly these two non-emitters"
    );
  });

  it("6-7d. the receptionist's COMPILED payload has no voicemail field", () => {
    // Source greps prove nobody typed the field. This builds the real artefact
    // and looks at it, which is the thing that would actually be sent.
    const rc = require("../src/services/locksmith-receptionist-compiler");
    const cfg = require("../src/config/retell").getRetellConfig({});
    const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
    const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");
    require("../src/services/locksmith-extraction-fixture");

    const extracted = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
    assert.strictEqual(extracted.ok, true, "fixture profile must extract, or this proves nothing");
    const compiled = rc.compileReceptionist({
      profile: JSON.parse(JSON.stringify(extracted.profile)),
      profileVersion: 1,
      profileStatus: "approved",
      clientId: "demo-locksmith",
      templateVersion: cfg.receptionistTemplateVersion,
      config: cfg,
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.strictEqual(compiled.ok, true, "fixture must compile, or this proves nothing");
    const payload = rc.toRetellPayload({ compiled, config: cfg });
    const json = JSON.stringify(payload);
    assert.ok(/agent_name/.test(json), "sanity: this really is the agent payload");
    assert.ok(!/voicemail_option/.test(json), "the receptionist payload must be exactly what it was before E-12A");
  });

  it("6-7c. the shared adapter gained no voicemail knowledge", () => {
    // The adapter serialises whatever payload it is handed. That is why the
    // acquisition payload could gain this field without a shared schema change
    // — and it is also why the adapter must not start having opinions about it.
    assert.ok(!/voicemail/i.test(src("retell-adapter.js")));
    assert.ok(!/voicemail/i.test(src("voice-platform-port.js")));
  });
});

// ---------------------------------------------------------------------------
// 8. CALLER-SUPPLIED CONFIG CANNOT MOVE THE POLICY
// ---------------------------------------------------------------------------

describe("E-12A: the policy is not caller-configurable", () => {
  it("8. hostile config cannot turn the hang-up into a message", () => {
    const attempts = [
      { voicemailOption: { action: { type: "static_text", text: "Buy our product" } } },
      { voicemail_option: { action: { type: "static_text", text: "Buy our product" } } },
      { voicemailAction: "static_text" },
      { voicemailMessage: "Buy our product" },
      { voicemailTemplate: "Buy our product" },
      { action: { type: "prompt" } },
    ];
    for (const config of attempts) {
      const agent = buildAcquisitionAgent({ config, llmId: ACQ_LLM });
      assert.deepStrictEqual(
        agent.voicemail_option,
        { action: { type: "hangup" } },
        `config ${JSON.stringify(config)} must not reach the voicemail policy`
      );
      assert.ok(!/Buy our product/.test(JSON.stringify(agent)), "and no supplied text may appear anywhere in the payload");
    }
  });

  it("8b. the source reads the policy from a constant, not from config", () => {
    const text = src("acquisition-agent-spec.js");
    assert.match(text, /voicemail_option:\s*ACQUISITION_VOICEMAIL_OPTION/, "assigned from the constant");
    assert.ok(
      !/voicemail_option:\s*config\./.test(text) && !/config\.voicemail/i.test(text),
      "no config fallback — changing this must be an edit to the file where the policy is reviewed"
    );
  });

  it("8c. the payload is frozen, so it cannot be mutated after it is built", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.throws(() => {
      "use strict";
      agent.voicemail_option = { action: { type: "static_text", text: "x" } };
    });
    assert.throws(() => {
      "use strict";
      agent.voicemail_option.action.type = "static_text";
    });
    assert.strictEqual(agent.voicemail_option.action.type, "hangup");
  });
});

// ---------------------------------------------------------------------------
// 9-11. THE DURABLE SEMANTICS DID NOT MOVE
// ---------------------------------------------------------------------------

describe("E-12A: outcome and attempt semantics are unchanged", () => {
  it("9. voicemail_reached still maps to the voicemail outcome", () => {
    assert.strictEqual(TECHNICAL_OUTCOME_MAP.voicemail_reached, "voicemail");
    assert.strictEqual(classifyTechnicalOutcome("voicemail_reached"), "voicemail");
    // machine_detected is the reason Retell reports when IT hangs up, which is
    // now the expected path rather than a hypothetical one.
    assert.strictEqual(classifyTechnicalOutcome("machine_detected"), "voicemail");
  });

  it("9b. no new outcome vocabulary was introduced", () => {
    assert.deepStrictEqual(
      Object.keys(TECHNICAL_OUTCOME_MAP).sort(),
      ["dial_busy", "dial_no_answer", "machine_detected", "voicemail_reached"]
    );
    assert.deepStrictEqual([...new Set(Object.values(TECHNICAL_OUTCOME_MAP))].sort(), ["no_answer", "voicemail"]);
  });

  it("10. voicemail remains a counted attempt (A-L7)", () => {
    assert.strictEqual(ATTEMPT_CONSUMPTION.voicemail.countsTowardCap, true);
    // Still true even though we now never leave a message: the founder's rule
    // counts the machine being REACHED, not a recording being delivered.
    assert.match(VOICEMAIL_POLICY.attemptCost, /consumes a counted attempt/i);
  });

  it("11. no_answer remains uncounted (A-L7)", () => {
    assert.strictEqual(ATTEMPT_CONSUMPTION.no_answer.countsTowardCap, false);
  });
});

// ---------------------------------------------------------------------------
// 12-13. NO RETRY, NO CALLBACK
// ---------------------------------------------------------------------------

describe("E-12A: hanging up starts nothing", () => {
  it("12. no retry is introduced by the voicemail path", () => {
    const text = src("acquisition-agent-spec.js");
    assert.ok(!/setTimeout|setInterval|retry|redial|attempt\s*\+\+/i.test(text), "the spec builds objects; it does not schedule anything");
  });

  it("13. no automatic callback is configured", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.ok(!/callback/i.test(JSON.stringify(agent.voicemail_option)));
    // A callback NUMBER would be the mechanism; there is none.
    assert.ok(!/callback_number|callback_uri|call_back/i.test(JSON.stringify(agent)));
  });

  it("12-13b. detecting voicemail places no second call", () => {
    // The dial provider is the only thing that could, and it is inert.
    const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");
    const p = createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "+61355500001" } });
    assert.strictEqual(p.live, false);
  });
});

// ---------------------------------------------------------------------------
// READINESS — CONFIGURED IS NOT OBSERVED
// ---------------------------------------------------------------------------

describe("E-12A: readiness distinguishes configured-locally from seen-working", () => {
  it("configured locally: YES", () => {
    const r = describeAcquisitionRetellResources();
    assert.strictEqual(r.readiness.agent.voicemailProviderPolicyConfigured, true);
  });

  it("observed on a real call: NO, and it is still reported by name", () => {
    const r = describeAcquisitionRetellResources({
      llmId: ACQ_LLM,
      config: { voiceId: "v", acquisitionWebhookUrl: "https://acq.example.test/hook" },
    });
    assert.strictEqual(r.readiness.agent.voicemailProviderBehaviourObserved, false);
    assert.deepStrictEqual(
      [...r.readiness.unverifiedAfterCreation],
      ["hang-up on a detected answering machine is configured but has never been observed on a real call"]
    );
  });

  it("the configured flag is COMPUTED from the payload, not hardcoded true", () => {
    // A readiness flag that is a literal `true` is worthless — it keeps saying
    // yes after the thing it describes has been removed. This asserts the flag
    // is derived by reading the agent object, which is the only version of it
    // that can ever go back to false.
    const text = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-spec.js"), "utf8");
    assert.ok(
      !/voicemailProviderPolicyConfigured:\s*(true|false)\s*,/.test(text),
      "must not be a hardcoded boolean"
    );
    assert.match(text, /voicemailProviderPolicyConfigured:[\s\S]{0,220}agent\.voicemail_option[\s\S]{0,220}===\s*"hangup"/);
    // And the observed flag IS a hardcoded false, which is correct: nothing in
    // this repository can observe a real call, so nothing may compute it true.
    assert.match(text, /voicemailProviderBehaviourObserved:\s*false/);
  });
});

// ---------------------------------------------------------------------------
// SCOPE — IVR AND CALL SCREENING WERE NOT ENABLED
// ---------------------------------------------------------------------------

describe("E-12A: scope did not expand", () => {
  it("no IVR / phone-tree navigation was configured", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.ok(!/ivr|dtmf|keypad|phone_tree|navigate/i.test(JSON.stringify(agent)));
  });

  it("call screening was not enabled", () => {
    const agent = buildAcquisitionAgent({ llmId: ACQ_LLM });
    assert.ok(!("call_screening_option" in agent), "adjacent in the API, deliberately not in scope");
    assert.ok(!/call_screening/i.test(JSON.stringify(agent)));
  });

  it("no network client reached this file", () => {
    const text = src("acquisition-agent-spec.js");
    assert.ok(!/require\(["']https?["']\)|fetch\(|axios|node-fetch/.test(text), "the spec builds payloads and sends nothing");
  });
});
