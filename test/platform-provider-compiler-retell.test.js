// AIDA PLATFORM P6 — the only module allowed to know what Retell is.
//
// What these tests are guarding:
//
//   PREVIEW MEANS PREVIEW. This module builds objects. It imports no transport
//   and can send nothing. A compiler that can also send is a compiler that will
//   eventually send by accident.
//
//   PROVIDER IDS ARE INJECTED, NEVER INVENTED. Anything missing is reported by
//   name rather than defaulted, because a payload that quietly substitutes a
//   placeholder is how the wrong voice reaches a real caller.
//
//   TWO RESOURCES, NOT ONE. E-10C established this the hard way: the prompt
//   belongs to a response engine and the agent REFERENCES it. Sent as one
//   object it creates an agent with no brain.
//
// Nothing here reaches the network. The real acquisition agent is parked and
// untouched.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { compileRetellPreview, RETELL_COMPILER_VERSION } = require("../src/platform/provider-compiler-retell");
const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
const { locksmithA, locksmithB, plumberC, garageDoorD, FIXTURE_CLIENTS } = require("../src/platform/fixtures/clients");

/** Fake deployment facts. None of these exists; nothing is sent anywhere. */
const FAKE_REFS = Object.freeze({
  llmId: "llm_fake000000000000000000000",
  voiceId: "custom_voice_fake0000000000000000",
  webhookUrl: "https://example.invalid/hooks/retell",
  agentNamePrefix: "aida",
});

const preview = (make = locksmithA, refs = FAKE_REFS, direction = "inbound") =>
  compileRetellPreview({ spec: compileBehaviourSpec(make()).spec, providerRefs: refs, direction });

describe("retell compiler — it compiles every client through one path", () => {
  it("produces a payload for all four fixtures", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const out = preview(make);
      assert.equal(out.compilerVersion, RETELL_COMPILER_VERSION, clientId);
      assert.equal(out.ready, true, `${clientId} unresolved: ${out.unresolved.join(", ")}`);
      assert.ok(out.responseEngine.general_prompt.length > 200, clientId);
    }
  });

  it("requires a behaviour spec", () => {
    for (const junk of [undefined, null, 42, "spec"]) {
      assert.throws(() => compileRetellPreview({ spec: junk, providerRefs: FAKE_REFS }), /behaviour spec/);
    }
    assert.throws(() => compileRetellPreview(), /behaviour spec/);
  });

  it("splits into two resources, and the agent references the engine rather than embedding it", () => {
    const out = preview();
    assert.ok(out.responseEngine.general_prompt, "the prompt belongs to the response engine");
    assert.equal("general_prompt" in out.agent, false, "and must not be duplicated onto the agent");
    assert.deepEqual(out.agent.response_engine, { type: "retell-llm", llm_id: FAKE_REFS.llmId });
  });

  it("names the agent after the client, its direction and its configuration version", () => {
    const bp = plumberC();
    bp.metadata.configVersion = 4;
    const spec = compileBehaviourSpec(bp).spec;
    assert.equal(compileRetellPreview({ spec, providerRefs: FAKE_REFS }).agent.agent_name, "aida-riverside_plumbing-inbound-v4");
    assert.equal(compileRetellPreview({ spec, providerRefs: FAKE_REFS, direction: "outbound" }).agent.agent_name, "aida-riverside_plumbing-outbound-v4");
  });

  it("refuses a direction nobody defined, rather than guessing one", () => {
    const spec = compileBehaviourSpec(plumberC()).spec;
    for (const bad of ["both", "INBOUND", "", null]) {
      assert.throws(() => compileRetellPreview({ spec, providerRefs: FAKE_REFS, direction: bad }), /direction/);
    }
  });
});

describe("retell compiler — provider ids are injected, never invented", () => {
  it("reports each missing reference by name instead of defaulting it", () => {
    const out = compileRetellPreview({ spec: compileBehaviourSpec(locksmithA()).spec, providerRefs: {} });
    assert.equal(out.ready, false);
    assert.deepEqual([...out.unresolved].sort(), ["llmId", "voiceId", "webhookUrl"]);
    assert.equal(out.agent.voice_id, null);
    assert.equal(out.agent.webhook_url, null);
    assert.equal(out.agent.response_engine.llm_id, null);
  });

  it("reports a missing voice on its own rather than silently borrowing a default", () => {
    // The E-12B lesson: a shared default voice id is how the wrong voice
    // reaches a caller, so absence must be loud.
    const out = preview(locksmithA, { ...FAKE_REFS, voiceId: null });
    assert.equal(out.ready, false);
    assert.deepEqual([...out.unresolved], ["voiceId"]);
    assert.equal(out.agent.voice_id, null);
  });

  it("treats an empty string as missing, not as a value", () => {
    const out = preview(locksmithA, { ...FAKE_REFS, voiceId: "", webhookUrl: "" });
    assert.equal(out.ready, false);
    assert.deepEqual([...out.unresolved].sort(), ["voiceId", "webhookUrl"]);
  });

  it("holds no hardcoded provider identifier of its own", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "platform", "provider-compiler-retell.js"),
      "utf8",
    );
    // A literal id in this file is a default waiting to be used by accident.
    assert.ok(!/custom_voice_[0-9a-f]{8}/i.test(source), "no literal voice id");
    assert.ok(!/\bllm_[0-9a-f]{8}/i.test(source), "no literal llm id");
    assert.ok(!/\bagent_[0-9a-f]{8}/i.test(source), "no literal agent id");
    assert.ok(!/https:\/\/api\.retellai\.com/i.test(source), "no API base URL");
  });

  it("has nowhere to put an API key", () => {
    const out = preview();
    const json = JSON.stringify(out);
    assert.ok(!/api[._-]?key/i.test(json));
    assert.ok(!/authorization/i.test(json));
    assert.ok(!/bearer/i.test(json));
  });
});

describe("retell compiler — preview means preview", () => {
  it("imports no transport of any kind", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "platform", "provider-compiler-retell.js"),
      "utf8",
    );
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./behaviour-spec", "crypto"]);
  });

  it("exports no FUNCTION that could send", () => {
    // Verb forms against callables. A bare substring sweep flagged the
    // CALL_DIRECTIONS vocabulary, which is a noun and cannot do anything —
    // the same self-catching shape the P8 ratchets had to be scoped out of.
    const module = require("../src/platform/provider-compiler-retell");
    const ACTING = /^(send|post|create|provision|deploy|publish|dial|call|update|delete)([A-Z]|$)/;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== "function") continue;
      assert.ok(!ACTING.test(name), `the compiler must not export a function called "${name}"`);
    }
    for (const bad of ["sendPayload", "createAgent", "dialOut", "publish"]) {
      assert.ok(ACTING.test(bad), `the check would not catch "${bad}"`);
    }
  });

  it("returns frozen objects, so a caller cannot doctor a payload after review", () => {
    const out = preview();
    assert.ok(Object.isFrozen(out));
    assert.ok(Object.isFrozen(out.responseEngine));
    assert.ok(Object.isFrozen(out.agent));
    assert.ok(Object.isFrozen(out.unresolved));
  });
});

describe("retell compiler — deterministic output and a stable hash", () => {
  it("produces byte-identical output for the same spec twice", () => {
    for (const make of Object.values(FIXTURE_CLIENTS)) {
      const a = preview(make);
      const b = preview(make);
      assert.equal(a.payloadHash, b.payloadHash);
      assert.equal(JSON.stringify(a.responseEngine), JSON.stringify(b.responseEngine));
      assert.equal(JSON.stringify(a.agent), JSON.stringify(b.agent));
    }
  });

  it("hashes each resource separately, the way they are created and updated", () => {
    const out = preview();
    for (const h of [out.responseEngineHash, out.agentHash, out.payloadHash]) {
      assert.match(h, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(out.responseEngineHash, out.agentHash);
    assert.notEqual(out.payloadHash, out.responseEngineHash);
  });

  it("changes the agent hash when the VOICE changes", () => {
    // The drift this exists to catch. A hash that cannot see the voice is a
    // drift detector blind to the drift that matters most.
    const base = preview();
    const swapped = preview(locksmithA, { ...FAKE_REFS, voiceId: "custom_voice_someoneelse0000000000" });
    assert.notEqual(swapped.agentHash, base.agentHash);
    assert.notEqual(swapped.payloadHash, base.payloadHash);
    assert.equal(swapped.responseEngineHash, base.responseEngineHash, "the prompt did not change");
  });

  it("changes the agent hash when the llm or webhook changes", () => {
    const base = preview();
    for (const [field, value] of [
      ["llmId", "llm_adifferentengine00000000"],
      ["webhookUrl", "https://example.invalid/somewhere-else"],
    ]) {
      const changed = preview(locksmithA, { ...FAKE_REFS, [field]: value });
      assert.notEqual(changed.agentHash, base.agentHash, `${field} must be visible to the hash`);
    }
  });

  it("changes the response engine hash when the words change", () => {
    const base = preview();
    const bp = locksmithA();
    bp.knowledge.approvedFacts.push({ factId: "new", statement: "We also cut keys while you wait.", sourceRef: "business_docs" });
    const changed = compileRetellPreview({ spec: compileBehaviourSpec(bp).spec, providerRefs: FAKE_REFS });
    assert.notEqual(changed.responseEngineHash, base.responseEngineHash);
  });

  it("gives four different businesses four different payloads", () => {
    const hashes = Object.values(FIXTURE_CLIENTS).map((make) => preview(make).payloadHash);
    assert.equal(new Set(hashes).size, hashes.length);
  });
});

describe("retell compiler — the prompt says what the blueprint said", () => {
  it("opens by naming the business and disclosing that it is AI", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const out = preview(make);
      const bp = make();
      assert.match(out.responseEngine.general_prompt, /AI assistant/i, clientId);
      assert.ok(out.responseEngine.general_prompt.includes(bp.identity.tradingName), clientId);
      assert.ok(out.responseEngine.general_prompt.includes(bp.identity.assistantName), clientId);
    }
  });

  it("makes the OUTBOUND opening disclose AI, for every client", () => {
    // Founder ruling 2026-08-16. Outbound telephones a stranger, so the
    // disclosure is in the opening and is assembled from constants here.
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const out = preview(make, FAKE_REFS, "outbound");
      assert.match(out.responseEngine.begin_message, /AI assistant/i, clientId);
      assert.ok(out.responseEngine.begin_message.includes(make().identity.tradingName), clientId);
    }
  });

  it("forces NO disclosure into an inbound opening", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const bp = make();
      bp.callHandling.greetingLine = `${bp.identity.tradingName}, how can I help?`;
      const out = compileRetellPreview({ spec: compileBehaviourSpec(bp).spec, providerRefs: FAKE_REFS, direction: "inbound" });
      assert.equal(out.responseEngine.begin_message, bp.callHandling.greetingLine, clientId);
      assert.ok(!/AI assistant/i.test(out.responseEngine.begin_message), clientId);
    }
  });

  it("still tells every assistant, both directions, to answer truthfully when asked", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      for (const direction of ["inbound", "outbound"]) {
        const out = preview(make, FAKE_REFS, direction);
        assert.match(out.responseEngine.general_prompt, /say plainly and immediately that you are an AI assistant/i, `${clientId} ${direction}`);
        assert.match(out.responseEngine.general_prompt, /Never claim to be human/i, `${clientId} ${direction}`);
      }
    }
  });

  it("does not read the greeting STYLE aloud as the opening line", () => {
    // The style is an instruction to the model, not something to say. Speaking
    // it would open every call with the assistant's own stage directions.
    const bp = locksmithA();
    bp.callHandling.greetingStyle = "Warm and brief. Name the business, say you are an AI assistant, ask how you can help.";
    const out = compileRetellPreview({ spec: compileBehaviourSpec(bp).spec, providerRefs: FAKE_REFS });
    assert.notEqual(out.responseEngine.begin_message, bp.callHandling.greetingStyle);
    assert.ok(!out.responseEngine.begin_message.includes("Name the business"));
    assert.ok(
      out.responseEngine.general_prompt.includes(bp.callHandling.greetingStyle),
      "the style still belongs in the prompt",
    );
  });

  it("lists every enabled service and no disabled one", () => {
    const out = preview(locksmithA);
    const prompt = out.responseEngine.general_prompt;
    for (const s of locksmithA().services) {
      if (s.enabled) assert.ok(prompt.includes(s.name), `expected "${s.name}" in the prompt`);
      else assert.ok(!prompt.includes(s.name), `"${s.name}" is disabled and must not appear`);
    }
  });

  it("carries the aliases a caller would actually use", () => {
    const prompt = preview(plumberC).responseEngine.general_prompt;
    for (const phrase of ["water everywhere", "sewage backing up", "gas leak", "toilet overflowing"]) {
      assert.ok(prompt.includes(phrase), `expected the alias "${phrase}"`);
    }
  });

  it("states the service area and what to do outside it", () => {
    const prompt = preview(locksmithA).responseEngine.general_prompt;
    assert.ok(prompt.includes("Brunswick"));
    assert.ok(prompt.includes("3056"));
    assert.ok(prompt.includes("Mornington Peninsula"));
    assert.ok(prompt.includes(locksmithA().serviceArea.outsideAreaWording));
  });

  it("states each urgency rule with its level and its action", () => {
    const prompt = preview(plumberC).responseEngine.general_prompt;
    assert.ok(prompt.includes("the caller can smell gas"));
    assert.ok(prompt.includes("emergency"));
    assert.ok(prompt.includes("transfer immediately"));
    assert.ok(prompt.includes("Please go outside now"));
  });

  it("states every prohibited claim", () => {
    const prompt = preview(locksmithA).responseEngine.general_prompt;
    for (const claim of locksmithA().knowledge.prohibitedClaims) {
      assert.ok(prompt.includes(claim.replace(/_/g, " ")), `expected "${claim}" among the prohibitions`);
    }
  });

  it("carries the client's pricing policy, and a different one for a different client", () => {
    assert.match(preview(locksmithA).responseEngine.general_prompt, /call-out fee only/i);
    assert.match(preview(locksmithB).responseEngine.general_prompt, /Do not discuss price/i);
    assert.match(preview(plumberC).responseEngine.general_prompt, /indicative ranges only/i);
    assert.match(preview(garageDoorD).responseEngine.general_prompt, /confirmed at booking/i);
  });

  it("tells the assistant never to guess", () => {
    for (const make of Object.values(FIXTURE_CLIENTS)) {
      const prompt = preview(make).responseEngine.general_prompt;
      assert.match(prompt, /Never guess/i);
      assert.match(prompt, /Never invent a fact/i);
    }
  });

  it("states the hours, including the closed days", () => {
    const prompt = preview(locksmithB).responseEngine.general_prompt;
    assert.match(prompt, /saturday: closed/i);
    assert.match(prompt, /sunday: closed/i);
    assert.match(prompt, /monday: 07:00/);
    assert.match(prompt, /After hours: not available/i);
  });
});

describe("retell compiler — analysis fields follow the client, not a vertical", () => {
  it("offers the service ids that client actually has", () => {
    const out = preview(plumberC);
    const field = out.agent.post_call_analysis_data.find((f) => f.name === "service_requested");
    for (const s of plumberC().services) assert.ok(field.choices.includes(s.serviceId), s.serviceId);
    assert.ok(field.choices.includes("other"));
    assert.ok(field.choices.includes("none"));
    assert.ok(!field.choices.includes("residential_lockout"), "a plumber has no lockouts");
  });

  it("adds a booking field only for a client who takes bookings", () => {
    const names = (make) => preview(make).agent.post_call_analysis_data.map((f) => f.name);
    assert.ok(names(plumberC).includes("booking_requested"));
    assert.ok(names(locksmithB).includes("booking_requested"));
    assert.ok(!names(locksmithA).includes("booking_requested"), "this locksmith does not take bookings");
    assert.ok(!names(garageDoorD).includes("booking_requested"));
  });

  it("keeps the platform-wide fields for everybody", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const names = preview(make).agent.post_call_analysis_data.map((f) => f.name);
      for (const required of ["reached_person", "caller_intent", "urgency", "callback_number", "summary"]) {
        assert.ok(names.includes(required), `${clientId} is missing "${required}"`);
      }
    }
  });
});

describe("retell compiler — three trades, no vertical branching", () => {
  it("has no `if vertical ===` anywhere in it", () => {
    // The trade-literal sweep lives in test/platform-boundaries.test.js, which
    // strips comments first and covers every platform file. A copy here caught
    // this file's own explanatory prose — a ratchet failing on the writing that
    // describes it, rather than on the code.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "platform", "provider-compiler-retell.js"),
      "utf8",
    );
    assert.ok(!/vertical\s*[=!]==/.test(source));
    assert.ok(!/===\s*["'](locksmith|plumbing|plumber|garage_doors)["']/.test(source));
    assert.ok(!/switch\s*\(\s*[\w.]*vertical/.test(source));
  });

  it("produces the same payload SHAPE for every trade", () => {
    const shapes = Object.values(FIXTURE_CLIENTS).map((make) => {
      const out = preview(make);
      return JSON.stringify({ engine: Object.keys(out.responseEngine).sort(), agent: Object.keys(out.agent).sort() });
    });
    assert.equal(new Set(shapes).size, 1, "every client must compile to the same shape");
  });

  it("produces different CONTENT for every trade", () => {
    const prompts = Object.values(FIXTURE_CLIENTS).map((make) => preview(make).responseEngine.general_prompt);
    assert.equal(new Set(prompts).size, prompts.length);
    assert.match(prompts[0], /lockout/i);
    assert.match(prompts[2], /drain/i);
    assert.ok(!/drain/i.test(prompts[0]), "a locksmith's prompt has no drains in it");
    assert.ok(!/lockout/i.test(prompts[2]), "a plumber's prompt has no lockouts in it");
  });
});
