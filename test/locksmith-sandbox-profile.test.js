// AIDA — M7I-B: the tool-free production-style sandbox profile.
//
// Every finding from the first two live inbound calls has an assertion here.
// NO TEST CONTACTS RETELL.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { buildSandboxProfile, SANDBOX_CLIENT_ID, TRANSFER_PRIMARY } = require("../src/services/locksmith-sandbox-profile");
const { validateProfile, assessProvisioning } = require("../src/services/locksmith-profile");
const rc = require("../src/services/locksmith-receptionist-compiler");
const cfg = require("../src/config/retell");
const speech = require("../src/services/au-phone-speech");

const CONFIG = cfg.getRetellConfig({ RETELL_DEFAULT_VOICE_ID: "voice_fixture", RETELL_DEFAULT_LANGUAGE: "en-AU" });

function compile({ toolFree = true } = {}) {
  const compiled = rc.compileReceptionist({
    profile: buildSandboxProfile(),
    profileVersion: 2,
    profileStatus: "approved",
    clientId: SANDBOX_CLIENT_ID,
    templateVersion: CONFIG.receptionistTemplateVersion,
    config: CONFIG,
    generatedAt: "2026-08-03T00:00:00.000Z",
    toolFree,
  });
  assert.equal(compiled.ok, true, compiled.message || JSON.stringify(compiled));
  return { compiled, payload: rc.toRetellPayload({ compiled, config: CONFIG }) };
}

const prompt = () => compile().payload.responseEngine.general_prompt;

// ── The profile ─────────────────────────────────────────────────────

describe("the sandbox profile", () => {
  test("validates and is provisioning-ready against the production schema", () => {
    const p = buildSandboxProfile();
    const v = validateProfile(p);
    assert.equal(v.ok, true, JSON.stringify(v.errors || []));
    assert.equal(assessProvisioning(p).ready, true);
  });

  test("is clearly fictional and no longer Harbour Locksmith Demo", () => {
    const p = buildSandboxProfile();
    assert.equal(p.identity.legalName, "AIDA Locksmith Sandbox");
    assert.equal(/Harbour/i.test(JSON.stringify(p)), false);
    assert.match(p.identity.description, /not a real business/i);
  });

  test("every phone number is in the ACMA fictitious range", () => {
    for (const n of JSON.stringify(buildSandboxProfile()).match(/\+61\d{9}/g) || []) {
      assert.match(n, /^\+61491570(0(0[6-9]|[1-9]\d)|1[0-5]\d)$/, `${n} must be fictitious`);
    }
  });

  test("recording is off, and that survives compilation", () => {
    assert.equal(buildSandboxProfile().privacy.callsMayBeRecorded, false);
    assert.equal(compile().compiled.spec.privacy.callsMayBeRecorded, false);
    assert.notEqual(compile().payload.agent.data_storage_setting, "everything");
  });

  test("the greeting makes no time-of-day claim", () => {
    // The live agent greeted an evening caller with "Good afternoon".
    assert.equal(/good (morning|afternoon|evening)/i.test(buildSandboxProfile().identity.greeting), false);
  });
});

// ── Service areas: three distinct states ────────────────────────────

describe("service areas — included, declined and unknown are distinct", () => {
  test("an included suburb is named as covered", () => {
    const p = prompt();
    assert.match(p, /Core area: Frankston/);
    assert.match(p, /LISTED ABOVE AS COVERED — say yes/);
  });

  test("an extended-area suburb is also covered", () => {
    assert.match(prompt(), /Will sometimes travel to: Mornington, Mount Eliza/);
  });

  test("an explicitly declined suburb is named as not covered", () => {
    const p = prompt();
    assert.match(p, /Does not travel to: Dandenong, Geelong/);
    assert.match(p, /does not travel to" LIST — say politely/);
  });

  test("UNKNOWN is stated explicitly, and is NOT the same as excluded", () => {
    // The Springvale defect: a positive scope was read as a closed list.
    const p = prompt();
    assert.match(p, /NOT IN ANY LIST ABOVE — this is UNKNOWN, which is NOT the same as excluded/);
    assert.match(p, /Do not say it is outside the area, and do not say it is covered/);
  });

  test("the unknown case carries the approved confirm-later wording", () => {
    const p = prompt();
    assert.match(p, /the locksmith will confirm whether they can come out/);
    assert.match(p, /have the locksmith confirm whether they can get to you/);
  });

  test("Springvale is in NO list, so it lands in the unknown state", () => {
    const areas = buildSandboxProfile().serviceAreas;
    for (const list of ["primary", "extended", "declined"]) {
      assert.equal(areas[list].includes("Springvale"), false, `Springvale must not be in ${list}`);
    }
    // And the prompt never names it either way.
    assert.equal(/Springvale/i.test(prompt()), false);
  });

  test("proximity still never implies coverage OR exclusion", () => {
    assert.match(prompt(), /Never infer that a suburb is covered OR excluded because it sounds close/);
  });

  test("coverage is never promised for an unknown suburb", () => {
    assert.match(prompt(), /Do not promise that they will/);
  });

  test("the tool-free prompt does not tell the agent to use a tool it lacks", () => {
    const p = prompt();
    assert.equal(/use the service-area check/i.test(p), false);
    assert.equal(/check_service_area/.test(p), false);
  });
});

// ── Caller capture ──────────────────────────────────────────────────

describe("caller-information capture is not repetitive", () => {
  test("the question comes first, the details after", () => {
    assert.match(prompt(), /ANSWER THE CALLER'S QUESTION FIRST/);
  });

  test("it must not re-ask for something already given", () => {
    assert.match(prompt(), /If they have already told you something, do not ask for it again/);
  });

  test("it must not end every reply with a name-and-number request", () => {
    // The live call did exactly this, five times in thirteen turns.
    assert.match(prompt(), /Do not end every reply by asking for a name and number/);
  });

  test("one thing at a time, and only what is still missing", () => {
    assert.match(prompt(), /Ask for one thing at a time, and only for what you still do not have/);
  });
});

// ── Tone ────────────────────────────────────────────────────────────

describe("tone is pinned rather than left to the model", () => {
  const EXPECTED = [
    /Calm, concise and respectful/,
    /acknowledge it ONCE/,
    /Do not repeat empathy phrases/,
    /never tell them to calm down/,
    /Do not sound therapeutic and do not over-apologise/,
    /Never promise an outcome/,
  ];

  for (const re of EXPECTED) {
    test(`the compiled prompt carries ${re}`, () => assert.match(prompt(), re));
  }

  test("there is no arbitrary turn limit", () => {
    const p = prompt();
    assert.equal(/under six turns|six turns|turn limit/i.test(p), false);
    assert.match(p, /stop once the next step is clear/);
  });
});

// ── Tool-free mode ──────────────────────────────────────────────────

describe("tool-free mode is explicit and auditable", () => {
  test("the spec records it, and emits zero tools", () => {
    const { compiled, payload } = compile({ toolFree: true });
    assert.equal(compiled.spec.toolFree, true);
    assert.equal(compiled.spec.tools.length, 0);
    assert.equal(payload.responseEngine.general_tools.length, 0);
  });

  test("DEFAULT compilation is unchanged — tools are still emitted", () => {
    const { compiled, payload } = compile({ toolFree: false });
    assert.equal(compiled.spec.toolFree, false);
    assert.ok(compiled.spec.tools.length >= 7, "production behaviour must not change");
    assert.ok(payload.responseEngine.general_tools.length >= 7);
  });

  test("it never claims an enquiry was saved or sent", () => {
    const p = prompt();
    assert.match(p, /You have NO tools on this call/);
    for (const claim of ["I've logged that", "I've sent that through", "the locksmith has your details", "someone will call you back", "I've booked that in"]) {
      assert.ok(p.includes(claim), `the prompt must forbid "${claim}" by naming it`);
    }
    assert.match(p, /never say any of these, because none of them would be true/);
  });

  test("details may still be taken, just not claimed to have gone anywhere", () => {
    assert.match(prompt(), /You may still take the caller's details in conversation — just do not claim they went anywhere/);
  });

  test("the capability section is ABSENT in normal mode", () => {
    const p = compile({ toolFree: false }).payload.responseEngine.general_prompt;
    assert.equal(/You have NO tools on this call/.test(p), false);
  });
});

// ── Safety and knowledge ────────────────────────────────────────────

describe("safety survives", () => {
  test("all eight mandatory forbidden promises are enabled", () => {
    const S = require("../src/services/locksmith-profile-schema");
    const enabled = compile().compiled.spec.forbiddenPromises.map((f) => f.promiseId);
    for (const id of S.MANDATORY_FORBIDDEN_PROMISES) assert.ok(enabled.includes(id), `${id} must be forbidden`);
  });

  test("pricing authority is preserved", () => {
    const p = prompt();
    assert.match(p, /Never quote a fixed price, a maximum price, or a guarantee about cost/);
    assert.equal(buildSandboxProfile().pricing.humanConfirmsEveryPrice, true);
    assert.equal(buildSandboxProfile().pricing.mayMentionPricing, false);
    // The elaborating answer lives in knowledge, the RULE lives in instructions.
    assert.match(JSON.stringify(compile().compiled.spec.knowledge), /locksmith confirms pricing/i);
  });

  test("automotive is declined and the refusal lives in INSTRUCTIONS, not knowledge", () => {
    const declined = buildSandboxProfile().servicesDeclined.map((s) => s.serviceId);
    for (const id of ["automotive_lockout", "car_key_replacement", "lost_car_keys"]) {
      assert.ok(declined.includes(id), `${id} must be declined`);
    }
    // Deliberate, and a change from the demo KB. The compiler's own rule is
    // that exclusions never depend on a retrieval hit — "a rule that decides
    // whether someone's phone rings at 3am must never depend on retrieval".
    // So automotive is compiled into the prompt.
    assert.match(prompt(), /Automotive lockouts/);
    assert.match(prompt(), /do not take the job and do not imply the business might do it/);
  });

  test("a genuinely elaborative fact stays KB-ONLY, so retrieval remains testable", () => {
    // Automotive can no longer serve as the live retrieval probe, because it is
    // now an instruction. This one is elaboration, so it is knowledge-only —
    // and asking it on a call still proves retrieval works.
    const knowledge = JSON.stringify(compile().compiled.spec.knowledge);
    assert.match(knowledge, /proof it is my property/i);
    assert.match(knowledge, /the locksmith checks that on site/i);
    assert.equal(/proof it is my property/i.test(prompt()), false, "it must NOT be duplicated into the prompt");
  });

  test("the knowledge base does not point at a tool that does not exist", () => {
    const knowledge = JSON.stringify(compile({ toolFree: true }).compiled.spec.knowledge);
    assert.equal(/Use the service-area check/.test(knowledge), false);
    assert.match(knowledge, /service-area rules in the instructions/);
    // Normal mode still references it, because there the tool is emitted.
    assert.match(JSON.stringify(compile({ toolFree: false }).compiled.spec.knowledge), /Use the service-area check/);
  });

  test("the transfer tool contract is gone in tool-free mode, and no number is exposed", () => {
    const { compiled, payload } = compile();
    assert.equal(compiled.spec.tools.length, 0);
    assert.equal(speech.containsE164(JSON.stringify(payload)), false);
    assert.equal(JSON.stringify(payload).includes(TRANSFER_PRIMARY), false);
  });
});

// ── The variable contract ───────────────────────────────────────────

describe("the variable contract holds", () => {
  test("the compiled prompt has ZERO unresolved placeholders", () => {
    const named = [...new Set([...prompt().matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]))];
    assert.deepEqual(named, [], `unresolved: ${named.join(", ")}`);
  });

  test("no fabricated runtime variables are referenced", () => {
    const p = prompt();
    for (const v of ["current_business_status", "on_call_state", "call_kind"]) {
      assert.equal(p.includes(v), false, `${v} has no supplier and must not be referenced`);
    }
  });

  test("provisioned defaults carry nothing runtime-sensitive", () => {
    const defaults = compile().payload.responseEngine.default_dynamic_variables || {};
    const dv = require("../src/services/retell-dynamic-variables");
    for (const key of Object.keys(defaults)) {
      assert.equal(dv.RUNTIME_ONLY_KEYS.includes(key), false, `${key} must not be a provisioned default`);
    }
    assert.equal(/\{\{/.test(JSON.stringify(defaults)), false, "no placeholder may survive into defaults");
  });

  test("no raw E.164 on any model-facing surface", () => {
    const { payload } = compile();
    for (const [name, text] of [
      ["prompt", payload.responseEngine.general_prompt],
      ["begin_message", payload.responseEngine.begin_message || ""],
      ["defaults", JSON.stringify(payload.responseEngine.default_dynamic_variables)],
      ["knowledge", JSON.stringify(payload.knowledge)],
    ]) {
      assert.equal(speech.containsE164(String(text)), false, `${name} leaked an E.164 number`);
    }
  });
});
