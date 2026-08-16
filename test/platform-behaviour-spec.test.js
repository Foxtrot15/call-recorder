// AIDA PLATFORM P5 — the behaviour compiler, and the boundary it holds.
//
//   Client Blueprint  ->  Agent Behaviour Spec  ->  Provider payload
//                              (under test)
//
// Two properties matter, and both are load-bearing:
//
//   NO PROVIDER ANYTHING. If a Retell id can reach this object the boundary is
//   decorative, and swapping voice providers stops being a change to the last
//   step only.
//
//   DETERMINISTIC. Same meaning, same hash. That is what makes "has this
//   client's behaviour changed?" a cheap and honest question — the same idea as
//   the acquisition response-engine pin, where something that already exists
//   remotely can be compared against what the repository currently believes.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { compileBehaviourSpec, stableStringify, BEHAVIOUR_SPEC_VERSION } = require("../src/platform/behaviour-spec");
const { locksmithA, locksmithB, plumberC, garageDoorD, FIXTURE_CLIENTS } = require("../src/platform/fixtures/clients");

const compile = (bp) => compileBehaviourSpec(bp);

describe("behaviour spec — it compiles every client", () => {
  it("compiles all four fixtures without special-casing any of them", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const { spec, behaviourHash } = compile(make());
      assert.equal(spec.specVersion, BEHAVIOUR_SPEC_VERSION, clientId);
      assert.match(behaviourHash, /^[0-9a-f]{64}$/, clientId);
      assert.ok(spec.services.length > 0, clientId);
    }
  });

  it("requires a blueprint", () => {
    for (const junk of [null, undefined, 42, "spec", []]) {
      assert.throws(() => compileBehaviourSpec(junk), /blueprint/);
    }
  });

  it("carries the trading name and assistant name the caller will hear", () => {
    const { spec } = compile(locksmithA());
    assert.equal(spec.business.tradingName, "Northside Lock & Key");
    assert.equal(spec.assistant.name, "Aida");
    assert.equal(spec.greeting.namesAssistant, true);
  });

  it("carries provenance so a spec can be traced to the exact approved words", () => {
    const bp = locksmithA();
    bp.metadata.configVersion = 7;
    const { spec } = compile(bp);
    assert.equal(spec.sourceBlueprint.clientId, "northside_locks");
    assert.equal(spec.sourceBlueprint.configVersion, 7);
    assert.equal(spec.sourceBlueprint.schemaVersion, bp.schemaVersion);
  });
});

describe("behaviour spec — no provider identifier can reach it", () => {
  const PROVIDER_PATTERNS = [
    /custom_voice_/i,
    /\bagent_[0-9a-f]{16,}/i,
    /\bllm_[0-9a-f]{16,}/i,
    /11labs/i,
    /\bretell\b/i,
    /\btwilio\b/i,
    /cartesia/i,
    /elevenlabs/i,
    /api[._-]?key/i,
    /webhook_url/i,
    /https?:\/\//i,
  ];

  it("holds none of them for any fixture", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const { spec } = compile(make());
      const json = JSON.stringify(spec);
      for (const pattern of PROVIDER_PATTERNS) {
        assert.ok(!pattern.test(json), `${clientId}: spec matched ${pattern}`);
      }
    }
  });

  it("holds none of them even when the blueprint smuggles one into free text", () => {
    const bp = locksmithA();
    // A voice profileRef that looks like a provider id is refused by validation,
    // but free text is not validated. The spec must not have a FIELD for one.
    const { spec } = compile(bp);
    assert.equal("voiceId" in spec, false);
    assert.equal("llmId" in spec, false);
    assert.equal("agentId" in spec, false);
    assert.equal("webhookUrl" in spec, false);
    assert.equal("provider" in spec, false);
  });

  it("describes booking by capability, never by vendor", () => {
    const { spec } = compile(plumberC());
    assert.equal(spec.booking.enabled, true);
    assert.equal(spec.booking.capability, "booking");
    assert.equal("adapterRef" in spec.booking, false);
    assert.equal("vendor" in spec.booking, false);
  });

  it("describes integrations as capability + on/off, with no adapter reference", () => {
    const { spec } = compile(plumberC());
    assert.ok(spec.capabilities.length > 0);
    for (const c of spec.capabilities) {
      assert.deepEqual(Object.keys(c).sort(), ["capability", "enabled"]);
    }
  });

  it("keeps the transfer number, which is business configuration rather than a provider detail", () => {
    // Deliberate: the assistant genuinely needs to know where a transfer goes.
    const { spec } = compile(locksmithA());
    assert.equal(spec.escalation.primaryNumber, "+61355500111");
    assert.equal(spec.escalation.backupNumber, "+61355500112");
  });
});

describe("behaviour spec — deterministic output and a stable hash", () => {
  it("produces an identical hash for the same blueprint compiled twice", () => {
    for (const make of Object.values(FIXTURE_CLIENTS)) {
      const a = compile(make());
      const b = compile(make());
      assert.equal(a.behaviourHash, b.behaviourHash);
      assert.equal(stableStringify(a.spec), stableStringify(b.spec));
    }
  });

  it("is unaffected by the order keys were written in", () => {
    // Rebuild every object in the tree with its keys in the opposite order —
    // the shape a different form, editor or import would produce.
    const reverseKeys = (v) => {
      if (Array.isArray(v)) return v.map(reverseKeys);
      if (v === null || typeof v !== "object") return v;
      return Object.fromEntries(Object.entries(v).reverse().map(([k, val]) => [k, reverseKeys(val)]));
    };

    const bp = locksmithA();
    const reordered = reverseKeys(bp);
    assert.notEqual(
      JSON.stringify(bp),
      JSON.stringify(reordered),
      "the fixture should genuinely have been reordered, or this test proves nothing",
    );
    assert.equal(compile(bp).behaviourHash, compile(reordered).behaviourHash);
  });

  it("is unaffected by the order lists were written in", () => {
    const bp = plumberC();
    const shuffled = JSON.parse(JSON.stringify(bp));
    shuffled.services.reverse();
    shuffled.callHandling.urgencyRules.reverse();
    shuffled.serviceArea.suburbs.reverse();
    shuffled.knowledge.approvedFacts.reverse();
    shuffled.integrations.reverse();
    shuffled.callHandling.collectAlways.reverse();
    assert.equal(compile(bp).behaviourHash, compile(shuffled).behaviourHash);
  });

  it("changes the hash when the MEANING changes", () => {
    const base = compile(locksmithA()).behaviourHash;
    const cases = {
      "a suburb dropped": (bp) => { bp.serviceArea.suburbs = bp.serviceArea.suburbs.filter((s) => s !== "Brunswick"); },
      "a service disabled": (bp) => { bp.services[0].enabled = false; },
      "an urgency level raised": (bp) => { bp.callHandling.urgencyRules[3].level = "emergency"; },
      "the pricing policy changed": (bp) => { bp.knowledge.pricingDisclosure = "never_discuss"; },
      "the greeting reworded": (bp) => { bp.callHandling.greetingStyle = "Say hello, then get to the point."; },
      "the transfer number changed": (bp) => { bp.callHandling.escalation.primaryNumber = "+61355500199"; },
      "an approved fact added": (bp) => { bp.knowledge.approvedFacts.push({ factId: "z", statement: "We are open on Anzac Day.", sourceRef: "business_docs" }); },
      "a prohibition added": (bp) => { bp.knowledge.prohibitedClaims.push("we_are_the_cheapest"); },
      "Saturday closed": (bp) => { bp.hours.weekly.saturday = { closed: true }; },
      "the assistant renamed": (bp) => { bp.identity.assistantName = "Alex"; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
      const bp = locksmithA();
      mutate(bp);
      assert.notEqual(compile(bp).behaviourHash, base, `${label} should change the behaviour hash`);
    }
  });

  it("does NOT change the hash when only provenance moves", () => {
    // The same client re-approving unchanged words must not look like a change.
    const a = locksmithA();
    a.metadata.configVersion = 3;
    a.metadata.approvedBy = "Peter Dang";
    a.metadata.approvedAt = "2026-08-16T09:00:00.000Z";

    const b = locksmithA();
    b.metadata.configVersion = 9;
    b.metadata.approvedBy = "Someone Else";
    b.metadata.approvedAt = "2027-01-01T00:00:00.000Z";

    assert.equal(compile(a).behaviourHash, compile(b).behaviourHash);
    assert.notEqual(compile(a).spec.sourceBlueprint.configVersion, compile(b).spec.sourceBlueprint.configVersion);
  });

  it("hashes two clients with genuinely identical behaviour identically", () => {
    const a = locksmithA();
    const b = locksmithA();
    b.identity.clientId = "a_different_client_entirely";
    b.metadata.configVersion = 42;
    assert.equal(compile(a).behaviourHash, compile(b).behaviourHash);
  });

  it("gives four genuinely different businesses four different hashes", () => {
    const hashes = Object.entries(FIXTURE_CLIENTS).map(([id, make]) => [id, compile(make()).behaviourHash]);
    assert.equal(new Set(hashes.map(([, h]) => h)).size, hashes.length);
  });

  it("returns a frozen spec", () => {
    const { spec } = compile(locksmithA());
    assert.ok(Object.isFrozen(spec));
  });
});

describe("behaviour spec — stableStringify", () => {
  it("sorts keys recursively", () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: 4, c: 3 } }),
      stableStringify({ a: { c: 3, d: 4 }, b: 1 }),
    );
    assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it("preserves array order, because a list's order can be meaningful", () => {
    assert.notEqual(stableStringify([1, 2, 3]), stableStringify([3, 2, 1]));
  });

  it("handles the primitives that appear in a blueprint", () => {
    assert.equal(stableStringify(null), "null");
    assert.equal(stableStringify(true), "true");
    assert.equal(stableStringify(7), "7");
    assert.equal(stableStringify("x"), '"x"');
  });
});

describe("behaviour spec — what it carries forward from the blueprint", () => {
  it("drops disabled services entirely", () => {
    const { spec } = compile(locksmithA()); // safe_opening is disabled
    const ids = spec.services.map((s) => s.serviceId);
    assert.ok(!ids.includes("safe_opening"));
    assert.ok(ids.includes("residential_lockout"));
  });

  it("folds always-collected and per-service fields into one list per service", () => {
    const { spec } = compile(locksmithA());
    const lockout = spec.services.find((s) => s.serviceId === "residential_lockout");
    const keyCutting = spec.services.find((s) => s.serviceId === "key_cutting");

    for (const always of ["caller_name", "callback_number", "suburb", "problem_description"]) {
      assert.ok(lockout.collect.includes(always), `lockout should collect ${always}`);
      assert.ok(keyCutting.collect.includes(always), `key cutting should collect ${always}`);
    }
    assert.ok(lockout.collect.includes("service_address"), "lockout adds an address");
    assert.ok(!keyCutting.collect.includes("service_address"), "key cutting does not");
  });

  it("does not duplicate a field that is both always-collected and per-service", () => {
    const bp = locksmithA();
    bp.callHandling.collectByService.residential_lockout.push("caller_name");
    const { spec } = compile(bp);
    const lockout = spec.services.find((s) => s.serviceId === "residential_lockout");
    assert.equal(lockout.collect.filter((f) => f === "caller_name").length, 1);
  });

  it("states AI disclosure for every client, whether or not the blueprint mentions it", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const { spec } = compile(make());
      assert.equal(spec.assistant.disclosesAiWhenAsked, true, clientId);
    }
  });

  it("keeps AI disclosure true even if a blueprint tries to say otherwise", () => {
    const bp = locksmithA();
    bp.assistant = { disclosesAiWhenAsked: false };       // not a real field
    bp.extensions = { disclosesAiWhenAsked: false };      // nor here
    const { spec } = compile(bp);
    assert.equal(spec.assistant.disclosesAiWhenAsked, true);
  });

  it("carries outbound as a description with no permission attached", () => {
    const { spec } = compile(locksmithA());
    assert.equal(spec.outbound.enabled, false);
    const outboundKeys = Object.keys(spec.outbound).join(" ");
    assert.ok(!/authoris|authoriz|approved|permitted|allowed/i.test(outboundKeys));
  });

  it("has nowhere at all to express permission", () => {
    const { spec } = compile(plumberC());
    const json = JSON.stringify(spec);
    for (const key of ["callingEnabled", "dialAuthorised", "authorisation", "dncr", "suppression", "approvedToCall"]) {
      assert.ok(!json.includes(`"${key}"`), `the spec must not carry "${key}"`);
    }
  });
});

describe("behaviour spec — three trades, one compiler", () => {
  it("has no vertical branching to test, so a plumber differs only by its answers", () => {
    const locksmith = compile(locksmithA()).spec;
    const plumber = compile(plumberC()).spec;
    const doors = compile(garageDoorD()).spec;

    // Same SHAPE.
    assert.deepEqual(Object.keys(locksmith).sort(), Object.keys(plumber).sort());
    assert.deepEqual(Object.keys(locksmith).sort(), Object.keys(doors).sort());

    // Different CONTENT.
    assert.notDeepEqual(locksmith.services.map((s) => s.serviceId), plumber.services.map((s) => s.serviceId));
    assert.equal(locksmith.business.vertical, "locksmith");
    assert.equal(plumber.business.vertical, "plumbing");
    assert.equal(doors.business.vertical, "garage_doors");
  });

  it("gives the plumber a gas emergency the locksmith does not have", () => {
    const plumber = compile(plumberC()).spec;
    const gasRule = plumber.urgency.rules.find((r) => r.ruleId === "gas_smell");
    assert.ok(gasRule);
    assert.equal(gasRule.level, "emergency");
    assert.equal(gasRule.action, "transfer_immediately");

    const locksmith = compile(locksmithA()).spec;
    assert.ok(!locksmith.urgency.rules.some((r) => r.ruleId === "gas_smell"));
  });

  it("lets two locksmiths differ as much as two trades do", () => {
    const a = compile(locksmithA()).spec;
    const b = compile(locksmithB()).spec;
    assert.equal(a.business.vertical, b.business.vertical);
    assert.notEqual(compile(locksmithA()).behaviourHash, compile(locksmithB()).behaviourHash);
    assert.equal(a.availability.afterHours.available, true);
    assert.equal(b.availability.afterHours.available, false);
    assert.equal(a.knowledge.pricing.disclosure, "callout_fee_only");
    assert.equal(b.knowledge.pricing.disclosure, "never_discuss");
    assert.equal(a.booking.enabled, false);
    assert.equal(b.booking.enabled, true);
  });
});
