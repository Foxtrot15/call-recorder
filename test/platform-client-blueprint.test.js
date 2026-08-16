// AIDA PLATFORM P2 — the Client Blueprint, and what it refuses to accept.
//
// The point of a validated schema is that the failures happen HERE, at build
// time, rather than in the four seconds a caller waits for an answer. So these
// tests are mostly about invalid input: every check below corresponds to a way
// a real configuration could be wrong and still look fine in a form.
//
// No network, no Supabase, no provider. Pure objects.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  BLUEPRINT_SCHEMA_VERSION,
  emptyBlueprint,
  validateBlueprint,
  URGENCY_LEVELS,
  CALLER_INFO_FIELDS,
  MANDATORY_PROHIBITED_CLAIMS,
  INTEGRATION_CAPABILITIES,
} = require("../src/platform/client-blueprint");

const { locksmithA, locksmithB, plumberC, garageDoorD, FIXTURE_CLIENTS } = require("../src/platform/fixtures/clients");

/** Errors are objects; assert on the path so a reworded message does not fail a test. */
const paths = (result) => result.errors.map((e) => e.path);
const failsAt = (result, path) => {
  assert.equal(result.ok, false, `expected invalid, got valid`);
  assert.ok(paths(result).includes(path), `expected an error at "${path}", got: ${paths(result).join(", ")}`);
};

describe("client blueprint — valid configurations", () => {
  it("accepts every fixture client", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const result = validateBlueprint(make());
      assert.equal(result.ok, true, `${clientId} should be valid but: ${JSON.stringify(result.errors)}`);
    }
  });

  it("accepts four different businesses across three different trades", () => {
    const verticals = new Set(Object.values(FIXTURE_CLIENTS).map((m) => m().identity.vertical));
    assert.ok(verticals.size >= 3, `expected at least three verticals, got ${[...verticals].join(", ")}`);
  });

  it("stamps the schema version, so an old blueprint is detectable rather than silently misread", () => {
    assert.equal(emptyBlueprint().schemaVersion, BLUEPRINT_SCHEMA_VERSION);
    const bp = locksmithA();
    bp.schemaVersion = "aida-client-blueprint-1999-01-01";
    failsAt(validateBlueprint(bp), "schemaVersion");
  });

  it("warns rather than fails when a client has no urgency rules", () => {
    const bp = locksmithA();
    bp.callHandling.urgencyRules = [];
    bp.serviceArea.outsideAreaAction = "politely_decline"; // remove the other transfer trigger
    const result = validateBlueprint(bp);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(result.warnings.some((w) => w.path === "callHandling.urgencyRules"));
  });
});

describe("client blueprint — required fields", () => {
  it("rejects a bare empty blueprint, listing what is missing rather than guessing", () => {
    const result = validateBlueprint(emptyBlueprint());
    assert.equal(result.ok, false);
    for (const required of [
      "identity.clientId",
      "identity.legalName",
      "identity.assistantName",
      "identity.vertical",
      "identity.timezone",
      "services",
      "serviceArea",
      "hours.timezone",
      "callHandling.collectAlways",
      "knowledge.uncertaintyPolicy",
      "knowledge.pricingDisclosure",
      "booking.enabled",
      "outbound.enabled",
    ]) {
      assert.ok(paths(result).includes(required), `expected a missing-field error at "${required}"`);
    }
  });

  it("requires an assistant name, because the caller hears it", () => {
    const bp = locksmithA();
    bp.identity.assistantName = null;
    failsAt(validateBlueprint(bp), "identity.assistantName");
  });

  it("requires a timezone, because hours without one mean nothing", () => {
    const bp = locksmithA();
    bp.identity.timezone = null;
    failsAt(validateBlueprint(bp), "identity.timezone");
  });

  it("refuses a blueprint whose hours are in a different timezone from its identity", () => {
    const bp = locksmithA();
    bp.hours.timezone = "Australia/Perth";
    failsAt(validateBlueprint(bp), "hours.timezone");
  });

  it("rejects a non-object", () => {
    for (const junk of [null, undefined, 42, "blueprint", []]) {
      assert.equal(validateBlueprint(junk).ok, false, `${JSON.stringify(junk)} should not validate`);
    }
  });
});

describe("client blueprint — invalid service definitions", () => {
  it("requires at least one service", () => {
    const bp = locksmithA();
    bp.services = [];
    failsAt(validateBlueprint(bp), "services");
  });

  it("refuses a catalogue where every service is disabled", () => {
    const bp = locksmithA();
    bp.services = bp.services.map((s) => ({ ...s, enabled: false }));
    failsAt(validateBlueprint(bp), "services");
  });

  it("refuses duplicate service ids", () => {
    const bp = locksmithA();
    bp.services.push({ ...bp.services[0] });
    failsAt(validateBlueprint(bp), `services[${bp.services.length - 1}].serviceId`);
  });

  it("refuses a service id that is not a lower_snake slug", () => {
    for (const bad of ["Residential Lockout", "residential-lockout", "1lockout", "", "  "]) {
      const bp = locksmithA();
      bp.services[0].serviceId = bad;
      failsAt(validateBlueprint(bp), "services[0].serviceId");
    }
  });

  it("requires an urgency category from the platform vocabulary, not an invented one", () => {
    const bp = plumberC();
    bp.services[0].urgencyCategory = "super_urgent";
    failsAt(validateBlueprint(bp), "services[0].urgencyCategory");
    assert.ok(!URGENCY_LEVELS.includes("super_urgent"));
  });

  it("requires enabled to be stated explicitly rather than inferred from absence", () => {
    const bp = locksmithA();
    delete bp.services[0].enabled;
    failsAt(validateBlueprint(bp), "services[0].enabled");
  });

  it("requires a caller-facing name", () => {
    const bp = locksmithA();
    bp.services[0].name = null;
    failsAt(validateBlueprint(bp), "services[0].name");
  });

  it("refuses aliases that are not strings", () => {
    const bp = locksmithA();
    bp.services[0].aliases = ["fine", 7];
    failsAt(validateBlueprint(bp), "services[0].aliases");
  });
});

describe("client blueprint — invalid hours", () => {
  it("requires every day of the week to be stated, closed included", () => {
    const bp = locksmithA();
    delete bp.hours.weekly.sunday;
    failsAt(validateBlueprint(bp), "hours.weekly.sunday");
  });

  it("rejects a day that is not a day", () => {
    const bp = locksmithA();
    bp.hours.weekly.someday = { open: "09:00", close: "17:00" };
    failsAt(validateBlueprint(bp), "hours.weekly.someday");
  });

  it("rejects malformed times", () => {
    for (const bad of ["9:00", "0900", "25:00", "09:60", "nine", ""]) {
      const bp = locksmithA();
      bp.hours.weekly.monday = { open: bad, close: "17:00" };
      failsAt(validateBlueprint(bp), "hours.weekly.monday.open");
    }
  });

  it("rejects a day that closes before it opens", () => {
    const bp = locksmithA();
    bp.hours.weekly.monday = { open: "17:00", close: "08:00" };
    failsAt(validateBlueprint(bp), "hours.weekly.monday");
  });

  it("accepts an explicitly closed day", () => {
    const bp = locksmithA();
    bp.hours.weekly.monday = { closed: true };
    assert.equal(validateBlueprint(bp).ok, true);
  });

  it("requires after-hours availability to be answered yes or no", () => {
    const bp = locksmithA();
    bp.hours.afterHours.available = null;
    failsAt(validateBlueprint(bp), "hours.afterHours.available");
  });
});

describe("client blueprint — invalid service area", () => {
  it("requires the area to be defined some way", () => {
    const bp = locksmithA();
    bp.serviceArea = { ...bp.serviceArea, regions: [], suburbs: [], postcodes: [], radiusKm: null };
    failsAt(validateBlueprint(bp), "serviceArea");
  });

  it("requires an out-of-area action, because 'nothing' is not an answer to a caller", () => {
    const bp = locksmithA();
    bp.serviceArea.outsideAreaAction = null;
    failsAt(validateBlueprint(bp), "serviceArea.outsideAreaAction");
  });

  it("rejects an out-of-area action outside the platform vocabulary", () => {
    const bp = locksmithA();
    bp.serviceArea.outsideAreaAction = "just_go_anyway";
    failsAt(validateBlueprint(bp), "serviceArea.outsideAreaAction");
  });

  it("rejects a non-positive radius", () => {
    for (const bad of [0, -5, "20"]) {
      const bp = locksmithA();
      bp.serviceArea.radiusKm = bad;
      failsAt(validateBlueprint(bp), "serviceArea.radiusKm");
    }
  });
});

describe("client blueprint — call handling", () => {
  it("requires something to be collected on every call", () => {
    const bp = locksmithA();
    bp.callHandling.collectAlways = [];
    failsAt(validateBlueprint(bp), "callHandling.collectAlways");
  });

  it("refuses a caller-info field the platform does not define", () => {
    const bp = locksmithA();
    bp.callHandling.collectAlways = ["caller_name", "medicare_number"];
    failsAt(validateBlueprint(bp), "callHandling.collectAlways[1]");
    assert.ok(!CALLER_INFO_FIELDS.includes("medicare_number"));
  });

  it("refuses per-service collection for a service that does not exist", () => {
    const bp = locksmithA();
    bp.callHandling.collectByService.imaginary_service = ["caller_name"];
    failsAt(validateBlueprint(bp), "callHandling.collectByService.imaginary_service");
  });

  it("refuses duplicate urgency rule ids", () => {
    const bp = plumberC();
    bp.callHandling.urgencyRules.push({ ...bp.callHandling.urgencyRules[0] });
    const last = bp.callHandling.urgencyRules.length - 1;
    failsAt(validateBlueprint(bp), `callHandling.urgencyRules[${last}].ruleId`);
  });

  it("refuses an urgency action outside the platform vocabulary", () => {
    const bp = plumberC();
    bp.callHandling.urgencyRules[0].action = "wake_the_owner_up";
    failsAt(validateBlueprint(bp), "callHandling.urgencyRules[0].action");
  });

  it("refuses an urgency rule with no stated condition", () => {
    const bp = plumberC();
    bp.callHandling.urgencyRules[0].when = null;
    failsAt(validateBlueprint(bp), "callHandling.urgencyRules[0].when");
  });

  it("refuses transfer-eligible escalation for a service that does not exist", () => {
    const bp = locksmithA();
    bp.callHandling.escalation.eligibleServices = ["residential_lockout", "unicorn_grooming"];
    failsAt(validateBlueprint(bp), "callHandling.escalation.eligibleServices[1]");
  });

  it("refuses a transfer rule with nowhere to transfer — the failure that is silent on the call", () => {
    const bp = plumberC();
    bp.callHandling.escalation.primaryNumber = null;
    failsAt(validateBlueprint(bp), "callHandling.escalation.primaryNumber");
  });

  it("also catches the transfer-with-no-number case when the trigger is the service area", () => {
    const bp = locksmithB(); // outsideAreaAction: transfer_for_manual_assessment
    bp.callHandling.urgencyRules = bp.callHandling.urgencyRules.map((r) =>
      r.action === "transfer_immediately" ? { ...r, action: "collect_and_notify" } : r,
    );
    bp.callHandling.escalation.primaryNumber = null;
    failsAt(validateBlueprint(bp), "callHandling.escalation.primaryNumber");
  });

  it("requires transfer numbers in E.164", () => {
    for (const bad of ["03 5550 0111", "0355500111", "+61 3 5550 0111", "tel:+61355500111"]) {
      const bp = locksmithA();
      bp.callHandling.escalation.primaryNumber = bad;
      failsAt(validateBlueprint(bp), "callHandling.escalation.primaryNumber");
    }
  });
});

describe("client blueprint — knowledge and claims", () => {
  it("refuses to let a client remove a mandatory prohibited claim", () => {
    for (const mandatory of MANDATORY_PROHIBITED_CLAIMS) {
      const bp = locksmithA();
      bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== mandatory);
      failsAt(validateBlueprint(bp), "knowledge.prohibitedClaims");
    }
  });

  it("keeps 'claiming_to_be_human' mandatory for every vertical", () => {
    assert.ok(MANDATORY_PROHIBITED_CLAIMS.includes("claiming_to_be_human"));
    for (const make of Object.values(FIXTURE_CLIENTS)) {
      assert.ok(make().knowledge.prohibitedClaims.includes("claiming_to_be_human"));
    }
  });

  it("lets a client ADD prohibitions", () => {
    const bp = locksmithA();
    bp.knowledge.prohibitedClaims.push("we_are_the_cheapest");
    assert.equal(validateBlueprint(bp).ok, true);
  });

  it("refuses an approved fact citing a source that does not exist", () => {
    const bp = locksmithA();
    bp.knowledge.approvedFacts[0].sourceRef = "a_document_nobody_has";
    failsAt(validateBlueprint(bp), "knowledge.approvedFacts[0].sourceRef");
  });

  it("requires a pricing disclosure policy and an uncertainty policy", () => {
    const bp = locksmithA();
    bp.knowledge.pricingDisclosure = "haggle";
    bp.knowledge.uncertaintyPolicy = "make_something_up";
    const result = validateBlueprint(bp);
    failsAt(result, "knowledge.pricingDisclosure");
    failsAt(result, "knowledge.uncertaintyPolicy");
  });
});

describe("client blueprint — invalid integration references", () => {
  it("refuses booking enabled with no appointment types", () => {
    const bp = plumberC();
    bp.booking.appointmentTypes = [];
    failsAt(validateBlueprint(bp), "booking.appointmentTypes");
  });

  it("refuses an appointment type pointing at a service that does not exist", () => {
    const bp = plumberC();
    bp.booking.appointmentTypes[0].services = ["leaking_tap", "helicopter_repair"];
    failsAt(validateBlueprint(bp), "booking.appointmentTypes[0].services[1]");
  });

  it("refuses booking aimed at a capability that is not declared", () => {
    const bp = plumberC();
    bp.integrations = bp.integrations.filter((x) => x.capability !== "booking");
    failsAt(validateBlueprint(bp), "booking.capabilityTarget");
  });

  it("refuses booking aimed at a capability that is declared but disabled", () => {
    const bp = plumberC();
    bp.integrations = bp.integrations.map((x) => (x.capability === "booking" ? { ...x, enabled: false } : x));
    failsAt(validateBlueprint(bp), "booking.capabilityTarget");
  });

  it("refuses booking aimed at a vendor name instead of a capability", () => {
    const bp = plumberC();
    bp.booking.capabilityTarget = "servicem8";
    failsAt(validateBlueprint(bp), "booking.capabilityTarget");
    assert.ok(!INTEGRATION_CAPABILITIES.includes("servicem8"));
  });

  it("refuses an integration capability the platform does not define", () => {
    const bp = locksmithA();
    bp.integrations.push({ capability: "carrier_pigeon", enabled: true, adapterRef: null, notes: null });
    failsAt(validateBlueprint(bp), `integrations[${bp.integrations.length - 1}].capability`);
  });

  it("refuses two declarations of the same capability", () => {
    const bp = locksmithA();
    bp.integrations.push({ capability: "sms", enabled: false, adapterRef: null, notes: null });
    failsAt(validateBlueprint(bp), `integrations[${bp.integrations.length - 1}].capability`);
  });
});

describe("client blueprint — the provider boundary", () => {
  it("refuses a provider voice id in the blueprint", () => {
    for (const providerId of [
      "11labs-Adrian",
      "custom_voice_000000000000000000000000",
      "retell-sunny",
      "cartesia-aurora",
      "openai-alloy",
    ]) {
      const bp = locksmithA();
      bp.voice.profileRef = providerId;
      failsAt(validateBlueprint(bp), "voice.profileRef");
    }
  });

  it("accepts a provider-independent voice reference", () => {
    const bp = locksmithA();
    bp.voice.profileRef = "warm_female_au";
    assert.equal(validateBlueprint(bp).ok, true);
  });

  it("holds no provider identifier in any fixture", () => {
    const providerish = /(custom_voice_|agent_[0-9a-f]{20,}|llm_[0-9a-f]{20,}|11labs-|retell)/i;
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const json = JSON.stringify(make());
      assert.ok(!providerish.test(json), `${clientId} carries something that looks like a provider id`);
    }
  });
});

describe("client blueprint — extensions are bounded and never load-bearing", () => {
  it("accepts a small free-form bag", () => {
    const bp = locksmithA();
    bp.extensions = { internalCrmCode: "NL-2019", ownerNickname: "Dave" };
    assert.equal(validateBlueprint(bp).ok, true);
  });

  it("refuses an extension key that shadows a validated section", () => {
    for (const reserved of ["services", "hours", "callHandling", "metadata", "schemaVersion"]) {
      const bp = locksmithA();
      bp.extensions = { [reserved]: { anything: true } };
      failsAt(validateBlueprint(bp), `extensions.${reserved}`);
    }
  });

  it("refuses an extensions bag over 4KB", () => {
    const bp = locksmithA();
    bp.extensions = { blob: "x".repeat(5000) };
    failsAt(validateBlueprint(bp), "extensions");
  });
});

describe("client blueprint — outbound is a capability, not a permission", () => {
  it("requires outbound.enabled to be stated", () => {
    const bp = locksmithA();
    bp.outbound.enabled = null;
    failsAt(validateBlueprint(bp), "outbound.enabled");
  });

  it("requires disclosure and opt-out wording before outbound may even be described", () => {
    const bp = locksmithA();
    bp.outbound = { ...bp.outbound, enabled: true, proposition: "We answer your phones." };
    const result = validateBlueprint(bp);
    failsAt(result, "outbound.disclosureWording");
    failsAt(result, "outbound.optOutWording");
  });

  it("has no field anywhere that could authorise a call", () => {
    // If one of these ever appears, the blueprint has stopped being a
    // description and become a permission — which is the whole thing this
    // model is built to prevent.
    const forbidden = [
      "callingEnabled",
      "dialAuthorised",
      "authorisation",
      "dncrWashed",
      "suppressionOverride",
      "callingState",
      "approvedToCall",
      "canDial",
    ];
    const json = JSON.stringify(emptyBlueprint());
    for (const key of forbidden) {
      assert.ok(!json.includes(`"${key}"`), `blueprint must not contain a "${key}" field`);
    }
    for (const make of Object.values(FIXTURE_CLIENTS)) {
      const body = JSON.stringify(make());
      for (const key of forbidden) assert.ok(!body.includes(`"${key}"`), `a fixture carries "${key}"`);
    }
  });

  it("keeps every fixture's outbound switched off", () => {
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      assert.equal(make().outbound.enabled, false, `${clientId} should not describe outbound as enabled`);
    }
  });
});

describe("client blueprint — the fixtures are fiction", () => {
  it("uses only reserved-for-fiction telephone numbers", () => {
    // +61 3 5550 xxxx is the Australian drama range. A real number in a fixture
    // is a real person answering a test call.
    const drama = /^\+61355500\d{3}$/;
    for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
      const bp = make();
      const numbers = [
        bp.identity.businessPhone,
        bp.callHandling.escalation.primaryNumber,
        bp.callHandling.escalation.backupNumber,
      ].filter(Boolean);
      assert.ok(numbers.length > 0, `${clientId} should carry at least one number`);
      for (const n of numbers) assert.ok(drama.test(n), `${clientId}: "${n}" is outside the fiction range`);
    }
  });

  it("gives every fixture a distinct clientId", () => {
    const ids = Object.values(FIXTURE_CLIENTS).map((m) => m().identity.clientId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("returns a fresh object each call, so one test cannot poison another", () => {
    const a = locksmithA();
    a.identity.legalName = "MUTATED";
    assert.notEqual(locksmithA().identity.legalName, "MUTATED");
    assert.notEqual(garageDoorD().identity.legalName, "MUTATED");
  });
});
