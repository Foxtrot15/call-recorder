// AIDA — M7I: known, excluded and unknown suburbs are three different answers.
//
// THE DEFECT THIS PINS DOWN
//
// A caller said "I'm in Springvale" and was told the business does not service
// Springvale. Springvale was in no list at all — it was UNKNOWN, and the
// receptionist turned it into a refusal.
//
// Two things produced that. The live agent was not built by this compiler at
// all (see test/retell-web-sandbox.test.js), and the compiler's own unknown
// branch was rendered from `serviceAreas.outsideAreaAction` — so the perfectly
// valid value `politely_decline` compiled a refusal into the unknown case while
// the surrounding sentence said not to refuse.
//
// The product rule is absolute: an unknown suburb is NEVER an immediate
// refusal. These tests assert it holds for EVERY value the schema allows,
// including ones no fixture happens to use.
//
// Pure. NO TEST HERE CONTACTS RETELL.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const rc = require("../src/services/locksmith-receptionist-compiler");
const S = require("../src/services/locksmith-profile-schema");
const { buildSandboxProfile } = require("../src/services/locksmith-sandbox-profile");
const cfg = require("../src/config/retell");

const CONFIG = cfg.getRetellConfig({ RETELL_DEFAULT_VOICE_ID: "voice_fixture", RETELL_DEFAULT_LANGUAGE: "en-AU" });

/** Compile a profile, optionally with the service-area section overridden. */
function compile(serviceAreaPatch = {}, { toolFree = true } = {}) {
  const profile = buildSandboxProfile();
  Object.assign(profile.serviceAreas, serviceAreaPatch);

  const compiled = rc.compileReceptionist({
    profile,
    profileVersion: 2,
    profileStatus: "approved",
    clientId: "sandbox-fixture-locksmith",
    templateVersion: "t",
    config: CONFIG,
    generatedAt: "2026-08-03T00:00:00.000Z",
    toolFree,
  });
  assert.equal(compiled.ok, true, compiled.message || JSON.stringify(compiled));
  return compiled;
}

/** Just the compiled service-area block, which is where every rule lives. */
function areaSection(compiled) {
  const section = compiled.spec.sections.find((s) => s.id === "service_area");
  assert.ok(section, "the compiled spec must have a service_area section");
  return section.lines.join("\n");
}

// Wording that would turn a caller away. If any of these can be produced for an
// UNKNOWN suburb, the founder's defect is back.
const REFUSAL_WORDING = [
  /Do not take the job/,
  /suggest they try a locksmith closer to them/,
  /it is outside the area the business covers, and/,
];

// ── The action resolver, on its own ─────────────────────────────────

describe("resolveUnknownAreaAction — a refusal is not expressible", () => {
  test("politely_decline is downgraded, and the downgrade is reported", () => {
    const r = rc.resolveUnknownAreaAction("politely_decline");
    assert.equal(r.action, "collect_details_for_confirmation");
    assert.equal(r.degradedFrom, "politely_decline");
  });

  test("every non-refusal action is honoured exactly as configured", () => {
    for (const action of ["collect_details_for_confirmation", "transfer_for_manual_assessment", "other_reviewed_action"]) {
      const r = rc.resolveUnknownAreaAction(action);
      assert.equal(r.action, action, `${action} must be honoured`);
      assert.equal(r.degradedFrom, null);
    }
  });

  test("an unset or unrecognised action falls back safely, and is not a downgrade", () => {
    for (const bad of [null, undefined, "", "wing_it", 7]) {
      const r = rc.resolveUnknownAreaAction(bad);
      assert.equal(r.action, "collect_details_for_confirmation", `${String(bad)} must fall back safely`);
      assert.equal(r.degradedFrom, null, "there was nothing to override");
    }
  });

  test("an inherited Object key is not mistaken for a configured action", () => {
    // `TABLE[key]` walks the prototype chain, so "constructor" would return a
    // truthy function — passing the guard and rendering
    // "function Object() { [native code] }" into a live prompt.
    for (const key of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
      const r = rc.resolveUnknownAreaAction(key);
      assert.equal(r.action, "collect_details_for_confirmation", `${key} must not be honoured as an action`);
      assert.equal(typeof rc.UNKNOWN_AREA_INSTRUCTION[r.action], "string");
    }
  });

  test("the unknown table cannot express a refusal at all", () => {
    assert.equal("politely_decline" in rc.UNKNOWN_AREA_INSTRUCTION, false);
    for (const text of Object.values(rc.UNKNOWN_AREA_INSTRUCTION)) {
      for (const refusal of REFUSAL_WORDING) {
        assert.equal(refusal.test(text), false, `"${text}" must not refuse`);
      }
    }
  });

  test("every schema action is either honoured or explicitly a refusal", () => {
    // Guards the enum against drift: a new OUTSIDE_AREA_ACTIONS value must be
    // classified deliberately, not silently fall through to the default.
    for (const action of S.OUTSIDE_AREA_ACTIONS) {
      const known = action in rc.UNKNOWN_AREA_INSTRUCTION || rc.REFUSAL_AREA_ACTIONS.includes(action);
      assert.ok(known, `${action} is unclassified — decide whether it may answer an unknown suburb`);
    }
  });
});

// ── The three states, compiled ──────────────────────────────────────

describe("a KNOWN suburb is confidently confirmed", () => {
  test("the covered lists are named in the INSTRUCTIONS, not just knowledge", () => {
    const lines = areaSection(compile());
    assert.match(lines, /Core area: Frankston, Frankston South, Seaford, Carrum Downs, Langwarrin\./);
    assert.match(lines, /Will sometimes travel to: Mornington, Mount Eliza\./);
    assert.match(lines, /LISTED ABOVE AS COVERED — say yes, the business covers it\./);
  });

  test("after-hours coverage is stated rather than assumed", () => {
    assert.match(areaSection(compile()), /After hours the area is smaller: Frankston, Frankston South, Seaford\./);
  });
});

describe("an EXCLUDED suburb is politely declined", () => {
  test("the declined list is named and the answer is a polite no", () => {
    const lines = areaSection(compile());
    assert.match(lines, /Does not travel to: Dandenong, Geelong\./);
    assert.match(lines, /IN THE "does not travel to" LIST — say politely that it is not an area the business covers/);
  });

  test("with no declined list the case is explicitly not applicable", () => {
    const lines = areaSection(compile({ declined: [] }));
    assert.match(lines, /NOT APPLICABLE — no suburb has been ruled out\./);
    assert.equal(/Does not travel to:/.test(lines), false);
  });

  test("declining a suburb never becomes a rule about unknown ones", () => {
    // The excluded branch is stated inline and does not read outsideAreaAction,
    // so changing that field cannot change what an excluded caller is told.
    for (const action of S.OUTSIDE_AREA_ACTIONS) {
      const lines = areaSection(compile({ outsideAreaAction: action, outsideAreaWording: "We do not cover that area." }));
      assert.match(lines, /IN THE "does not travel to" LIST — say politely/, `${action} must not change the excluded branch`);
    }
  });
});

describe("an UNKNOWN suburb is NEVER an immediate refusal", () => {
  test("the unknown case is named as distinct from excluded", () => {
    const lines = areaSection(compile());
    assert.match(lines, /NOT IN ANY LIST ABOVE — this is UNKNOWN, which is NOT the same as excluded\./);
    assert.match(lines, /Do not say it is outside the area, and do not say it is covered\./);
  });

  test("it apologises, admits uncertainty, collects details and promises nothing", () => {
    // Exactly the four behaviours the product requirement asks for.
    const lines = areaSection(compile());
    assert.match(lines, /Apologise/);
    assert.match(lines, /not completely sure whether the business covers that suburb/);
    assert.match(lines, /take their name, number, suburb and what they need/);
    assert.match(lines, /the locksmith will confirm whether they can come out shortly/);
    assert.match(lines, /Do not promise that they will\./);
  });

  test("NO configured action can produce a refusal for an unknown suburb", () => {
    // The heart of it. Every value the schema permits, including the one the
    // founder's defect ran through.
    for (const action of S.OUTSIDE_AREA_ACTIONS) {
      const lines = areaSection(compile({ outsideAreaAction: action, outsideAreaWording: "That is outside our area." }));
      const unknownLine = lines.split("\n").find((l) => l.includes("NOT IN ANY LIST ABOVE"));
      assert.ok(unknownLine, `${action} must still produce an unknown branch`);
      for (const refusal of REFUSAL_WORDING) {
        assert.equal(refusal.test(unknownLine), false, `${action} produced a refusal: ${unknownLine}`);
      }
      assert.match(unknownLine, /Apologise/, `${action} must still apologise`);
    }
  });

  test("an action that never reached the validator is still safe", () => {
    // compileReceptionist refuses an out-of-enum action outright, which is the
    // first line of defence. This is the second: compileReceptionistSpec runs
    // without validation, so a future caller that skips it — or a stored profile
    // written before an enum change — still cannot produce a refusal.
    for (const action of [null, undefined, "", "wing_it", "politely_decline ", "constructor", "toString", "__proto__", "valueOf", 7, {}]) {
      const profile = buildSandboxProfile();
      profile.serviceAreas.outsideAreaAction = action;
      const spec = rc.compileReceptionistSpec({ profile, profileVersion: 2, clientId: "c", templateVersion: "t", toolFree: true });
      const unknownLine = spec.sections
        .find((s) => s.id === "service_area")
        .lines.find((l) => l.includes("NOT IN ANY LIST ABOVE"));
      assert.ok(unknownLine, `${String(action)} must still produce an unknown branch`);
      for (const refusal of REFUSAL_WORDING) {
        assert.equal(refusal.test(unknownLine), false, `${String(action)} produced a refusal: ${unknownLine}`);
      }
    }
  });

  test("the never-refuse floor is present under every configuration", () => {
    for (const action of S.OUTSIDE_AREA_ACTIONS) {
      const lines = areaSection(compile({ outsideAreaAction: action }));
      assert.match(lines, /NEVER refuse a caller only because their suburb is not on a list/, `missing under ${action}`);
      assert.match(lines, /They are not a complete map of everywhere it will go\./);
    }
  });

  test("proximity implies neither coverage nor exclusion", () => {
    assert.match(areaSection(compile()), /Never infer that a suburb is covered OR excluded because it sounds close to one that is listed\./);
  });
});

// ── The downgrade is visible, and the wording follows its branch ────

describe("a configured refusal is downgraded loudly, never silently", () => {
  test("politely_decline raises a review flag naming the field", () => {
    const compiled = compile({ outsideAreaAction: "politely_decline" });
    const flag = compiled.reviewFlags.find((f) => f.code === "unknown_area_refusal_downgraded");
    assert.ok(flag, "the downgrade must be surfaced for review");
    assert.equal(flag.field, "serviceAreas.outsideAreaAction");
    assert.match(flag.message, /unknown, not excluded/);
    // And it tells the owner how to get the behaviour they asked for.
    assert.match(flag.message, /add the ones it refuses to the declined list/);
  });

  test("no flag is raised when nothing was overridden", () => {
    for (const action of ["collect_details_for_confirmation", "transfer_for_manual_assessment"]) {
      const compiled = compile({ outsideAreaAction: action });
      assert.equal(compiled.reviewFlags.some((f) => f.code === "unknown_area_refusal_downgraded"), false, `${action} must not flag`);
    }
  });

  test("decline wording is shown to EXCLUDED callers, never as unknown-suburb wording", () => {
    // The owner wrote this for people they turn away. Presenting it as approved
    // wording for an unknown suburb would smuggle the refusal back in as prose.
    const lines = areaSection(compile({ outsideAreaAction: "politely_decline", outsideAreaWording: "Sorry, we do not cover that area." }));
    assert.match(lines, /Approved wording for a suburb on that list: «Sorry, we do not cover that area\.»/);
    assert.equal(/Approved wording for an unknown suburb/.test(lines), false);
  });

  test("non-refusal wording is shown to UNKNOWN callers", () => {
    const lines = areaSection(compile({ outsideAreaAction: "collect_details_for_confirmation", outsideAreaWording: "I can have the locksmith confirm." }));
    assert.match(lines, /Approved wording for an unknown suburb: «I can have the locksmith confirm\.»/);
    assert.equal(/Approved wording for a suburb on that list/.test(lines), false);
  });

  test("the downgrade does not weaken the compiled safety floor", () => {
    const compiled = compile({ outsideAreaAction: "politely_decline" });
    assert.equal(compiled.safety.passed, true);
    assert.deepEqual(compiled.safety.missingForbiddenPromises, []);
  });
});

// ── The knowledge base must not read as a closed list ───────────────

describe("the retrieved suburb list does not read as a closed set", () => {
  test("it says outright that it is not exhaustive", () => {
    const knowledge = compile().spec.knowledge.text;
    assert.match(knowledge, /NOT a complete list of everywhere the business will go/);
    assert.match(knowledge, /A suburb missing from it is unknown, not excluded\./);
  });

  test("that holds whether or not tools are compiled", () => {
    for (const toolFree of [true, false]) {
      assert.match(compile({}, { toolFree }).spec.knowledge.text, /unknown, not excluded/, `toolFree=${toolFree}`);
    }
  });

  test("the DECIDING rules stay in instructions, not knowledge", () => {
    // A retrieval miss must never change what the receptionist may do.
    const compiled = compile();
    assert.equal(/NEVER refuse a caller only because/.test(compiled.spec.knowledge.text), false);
    assert.match(areaSection(compiled), /NEVER refuse a caller only because/);
  });
});

// ── The schema was not changed to achieve any of this ───────────────

describe("the serviceAreas schema is untouched", () => {
  test("the action enum still has exactly its four original values", () => {
    assert.deepEqual([...S.OUTSIDE_AREA_ACTIONS], [
      "collect_details_for_confirmation",
      "politely_decline",
      "transfer_for_manual_assessment",
      "other_reviewed_action",
    ]);
  });

  test("the serviceAreas shape is unchanged — no field was added", () => {
    assert.deepEqual(Object.keys(S.emptyProfile().serviceAreas).sort(), [
      "afterHoursAreas",
      "declined",
      "extended",
      "outsideAreaAction",
      "outsideAreaWording",
      "primary",
      "radiusKm",
    ]);
  });

  test("a profile using every action still validates and is provisioning-ready", () => {
    const { validateProfile, assessProvisioning } = require("../src/services/locksmith-profile");
    for (const action of S.OUTSIDE_AREA_ACTIONS) {
      const p = buildSandboxProfile();
      p.serviceAreas.outsideAreaAction = action;
      // other_reviewed_action requires wording; supply it rather than skipping.
      p.serviceAreas.outsideAreaWording = "Reviewed wording for these callers.";
      assert.equal(validateProfile(p).ok, true, `${action} must validate`);
      assert.equal(assessProvisioning(p).ready, true, `${action} must stay provisioning-ready`);
    }
  });
});
