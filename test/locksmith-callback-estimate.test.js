// AIDA — M7I-C: approved callback estimates, and the zeros in a spoken number.
//
// TWO FOUNDER FINDINGS FROM THE LIVE M7I CALL (call ended user_hangup, 185s):
//
//   1. Zeros did not sound natural. The agent read a callback number back as
//      the DIGIT STRING "0467 745 066". That satisfied the old instruction
//      ("digit by digit, in groups") while handing pronunciation to the voice
//      engine, which says zeros inconsistently. au-phone-speech.js was never in
//      that path — no transfer number was spoken on that call at all.
//
//   2. It could not give any callback timeframe, because the product had no
//      way to represent one. notifications.timing is about alerting the
//      LOCKSMITH and is not the same fact.
//
// NO TEST HERE CONTACTS RETELL.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const speech = require("../src/services/au-phone-speech");
const rc = require("../src/services/locksmith-receptionist-compiler");
const S = require("../src/services/locksmith-profile-schema");
const { validateProfile, assessProvisioning } = require("../src/services/locksmith-profile");
const { buildSandboxProfile } = require("../src/services/locksmith-sandbox-profile");
const cfg = require("../src/config/retell");

const CONFIG = cfg.getRetellConfig({ RETELL_DEFAULT_VOICE_ID: "voice_fixture", RETELL_DEFAULT_LANGUAGE: "en-AU" });

function compile(mutate = () => {}, { toolFree = true } = {}) {
  const profile = buildSandboxProfile();
  mutate(profile);
  const compiled = rc.compileReceptionist({
    profile, profileVersion: 2, profileStatus: "approved", clientId: "sandbox-fixture-locksmith",
    templateVersion: "t", config: CONFIG, generatedAt: "2026-08-03T00:00:00.000Z", toolFree,
  });
  assert.equal(compiled.ok, true, compiled.message || JSON.stringify(compiled.errors || compiled));
  return compiled;
}

const sectionText = (compiled, id) => {
  const s = compiled.spec.sections.find((x) => x.id === id);
  assert.ok(s, `missing section ${id}`);
  return s.lines.join("\n");
};

// ── Part 1: consecutive zeros and grouping ──────────────────────────

describe("spoken numbers — consecutive zeros stay one word per digit", () => {
  // Regression cover for the rendering M7I-C evaluated and deliberately KEPT.
  // Collapsing repeats into "double oh" was implemented and reverted: it was
  // never the defect the founder heard, and it breaks the digit-recovery check
  // that proves no digit was lost. See the comment above digitsToWords().
  test("a double zero is \"zero zero\", never \"double oh\"", () => {
    // The exact number in the sandbox profile's transfer field.
    assert.equal(speech.describeAuNumber("+61491570006").spoken, "zero four nine one, five seven zero, zero zero six");
  });

  test("a triple zero is three words, never \"triple oh\"", () => {
    assert.equal(speech.describeAuNumber("+61491570000").spoken, "zero four nine one, five seven zero, zero zero zero");
  });

  test("no repeated digit of any kind is compressed", () => {
    for (const n of ["+61455123456", "+61400044400", "+61399991000", "+61467745066"]) {
      assert.equal(/\b(double|triple|quadruple)\b/i.test(speech.describeAuNumber(n).spoken), false, `${n} must not compress`);
    }
  });

  test("every digit survives the round trip, in order", () => {
    // The invariant that one-word-per-digit exists to protect: a dropped digit
    // in a callback number means nobody gets called back.
    const WORD_TO_DIGIT = Object.fromEntries(Object.entries(speech.DIGIT_WORDS).map(([d, w]) => [w, d]));
    for (const n of ["+61491570006", "+61400044400", "+61467745066", "+611300123456", "+611800111222"]) {
      const d = speech.describeAuNumber(n);
      const recovered = d.spoken.split(/[\s,]+/).filter(Boolean).map((w) => WORD_TO_DIGIT[w]).join("");
      assert.equal(recovered, d.display.replace(/\s/g, ""), `${n} lost, gained or reordered a digit`);
    }
  });

  test("grouping is unchanged and commas remain the only pause", () => {
    assert.deepEqual(speech.describeAuNumber("+61491570006").spoken.split(", ").length, 3);
    assert.equal(speech.describeAuNumber("+61399991000").display, "03 9999 1000");
    assert.doesNotMatch(speech.describeAuNumber("+61491570006").spoken, /[<>&]/, "no SSML may appear");
  });

  test("grouping and number types are unchanged", () => {
    assert.equal(speech.describeAuNumber("+61491570006").numberType, "mobile");
    assert.equal(speech.describeAuNumber("+61399991000").numberType, "landline");
    assert.equal(speech.describeAuNumber("+611300123456").numberType, "service_1300");
    assert.equal(speech.describeAuNumber("+611800111222").numberType, "service_1800");
    assert.equal(speech.describeAuNumber("131234").numberType, "service_13");
    // 13 numbers stay sayable but never dialable.
    assert.equal(speech.describeAuNumber("131234").transferEligible, false);
  });

  test("zero is \"zero\", and no \"oh\" survives anywhere (M7I-C2)", () => {
    assert.equal(speech.DIGIT_WORDS[0], "zero");
    for (const n of ["+61491570006", "+61400044400", "+61391234567", "+611300123456", "+611800123456", "131234"]) {
      assert.equal(/\boh\b/.test(speech.describeAuNumber(n).spoken), false, `${n} still says "oh"`);
    }
  });

  test("E.164 storage and the no-raw-E.164 guard are untouched", () => {
    const d = speech.describeAuNumber("0491 570 006");
    assert.equal(d.e164, "+61491570006", "canonical storage form is preserved");
    assert.equal(speech.containsE164(d.spoken), false);
    assert.equal(d.display, "0491 570 006");
  });
});

describe("the prompt forbids the digit-string read-back that actually failed", () => {
  const prompt = () => sectionText(compile(), "saying_numbers");

  test("it demands WORDS and names the failing form", () => {
    const p = prompt();
    assert.match(p, /WRITE IT AS WORDS, never as digits/);
    assert.match(p, /never "0467 745 066"/);
  });

  test("it teaches the SAME convention au-phone-speech produces", () => {
    // Both paths must agree, or a caller cannot check the read-back against
    // what they just said.
    const p = prompt();
    assert.match(p, /Say every digit separately/);
    assert.match(p, /Do not compress repeats into "double" or "triple"/);
    assert.match(p, /Say "zero" for 0, never "oh"/);
    // "oh" may appear ONLY where the prompt is prohibiting it. Any line that
    // mentions it without a prohibition is teaching it by example.
    for (const line of p.split("\n")) {
      if (!/\boh\b/.test(line)) continue;
      assert.match(line, /\b(never|not)\b/, `"oh" appears without a prohibition: ${line}`);
    }
    // And the example in the prompt is exactly what the module would emit.
    assert.equal(speech.describeAuNumber("+61467745066").spoken, "zero four six seven, seven four five, zero six six");
    assert.match(p, /"zero four six seven, seven four five, zero six six"/);
  });

  test("the capture rule points at it instead of contradicting it", () => {
    const capture = sectionText(compile(), "caller_info");
    assert.match(capture, /spelled out as words/);
    assert.equal(/digit by digit and confirm it/.test(capture), false, "the old wording invited a digit string");
  });
});

// ── Part 2: the callback estimate ───────────────────────────────────

describe("an approved callback estimate is quoted, and only that", () => {
  const text = () => sectionText(compile(), "callback_estimate");

  test("the sandbox's three approved windows are compiled", () => {
    const t = text();
    assert.match(t, /ONLY timeframe you may give: around 20 to 40 minutes/);
    assert.match(t, /urgent, the approved estimate is around 5 to 15 minutes/);
    assert.match(t, /Outside ordinary hours, the approved estimate is around 30 to 60 minutes/);
  });

  test("the window comes from the profile, not from the compiler", () => {
    const t = sectionText(compile((p) => {
      p.hours.callbackEstimate = { standard: { minMinutes: 45, maxMinutes: 90 }, urgent: null, afterHours: null, wording: null };
    }), "callback_estimate");
    assert.match(t, /around 45 to 90 minutes/);
    assert.equal(/20 to 40/.test(t), false, "no compiler-side default may leak in");
  });

  test("a single-minute window reads naturally", () => {
    const t = sectionText(compile((p) => {
      p.hours.callbackEstimate = { standard: { minMinutes: 1, maxMinutes: 1 } };
    }), "callback_estimate");
    assert.match(t, /around 1 minute\b/);
    assert.equal(/1 minutes/.test(t), false);
  });

  test("approved wording is carried as quoted data", () => {
    const t = sectionText(compile((p) => {
      p.hours.callbackEstimate.wording = "We usually ring back within the half hour.";
    }), "callback_estimate");
    assert.match(t, /Approved wording: «We usually ring back within the half hour\.»/);
  });

  test("when only a standard window exists, after-hours is not invented", () => {
    const t = sectionText(compile((p) => {
      p.hours.callbackEstimate = { standard: { minMinutes: 20, maxMinutes: 40 } };
    }), "callback_estimate");
    assert.match(t, /The same estimate applies outside ordinary hours; do not adjust it yourself/);
    assert.equal(/Outside ordinary hours, the approved estimate/.test(t), false);
  });
});

describe("no approved estimate means saying so, not guessing", () => {
  const noEstimate = () => sectionText(compile((p) => { p.hours.callbackEstimate = null; }), "callback_estimate");

  test("absent is the default for every existing profile", () => {
    assert.equal(S.emptyProfile().hours.callbackEstimate, null);
  });

  test("it says it cannot give a reliable timeframe", () => {
    const t = noEstimate();
    assert.match(t, /NO approved callback window/);
    assert.match(t, /cannot give a reliable timeframe/);
    assert.match(t, /Do not estimate, do not guess, and do not offer a range of your own/);
  });

  test("no minute range appears anywhere in that branch", () => {
    assert.equal(/\d+ to \d+ minutes/.test(noEstimate()), false);
  });

  test("a malformed estimate degrades to the no-estimate branch rather than half-quoting", () => {
    // compileReceptionistSpec skips validation, so this is the second line of
    // defence behind validateProfile.
    for (const broken of [{}, { standard: null }, { standard: { minMinutes: 10 } }, { standard: { minMinutes: 30, maxMinutes: 10 } }, "soon"]) {
      const profile = buildSandboxProfile();
      profile.hours.callbackEstimate = broken;
      const spec = rc.compileReceptionistSpec({ profile, profileVersion: 2, clientId: "c", templateVersion: "t", toolFree: true });
      const t = spec.sections.find((s) => s.id === "callback_estimate").lines.join("\n");
      assert.match(t, /NO approved callback window/, `${JSON.stringify(broken)} must not produce a quotable window`);
    }
  });
});

describe("callback is never a guarantee and never an arrival time", () => {
  for (const withEstimate of [true, false]) {
    const label = withEstimate ? "with an approved window" : "with no approved window";
    const t = () => sectionText(compile((p) => { if (!withEstimate) p.hours.callbackEstimate = null; }), "callback_estimate");

    test(`${label}: callback and arrival are held apart`, () => {
      assert.match(t(), /A CALLBACK is the locksmith ringing the caller back\. It is NOT the locksmith arriving/);
      assert.match(t(), /you cannot give an arrival time/);
    });

    test(`${label}: a guarantee is refused outright`, () => {
      assert.match(t(), /Never guarantee a callback/);
      assert.match(t(), /it is an estimate and not a promise/);
    });

    test(`${label}: it never claims the callback was set in motion`, () => {
      assert.match(t(), /Never say the callback has been booked, scheduled, queued or requested/);
    });

    test(`${label}: it does not fabricate current availability`, () => {
      assert.match(t(), /never claim to know how many jobs are on right now/);
    });
  }

  test("the arrival-time forbidden promise is still enforced", () => {
    const compiled = compile();
    assert.ok(compiled.spec.forbiddenPromises.some((f) => f.promiseId === "guaranteed_arrival_time"));
    assert.match(compiled.spec.safety.join("\n"), /Never guarantee that someone will attend, when they will arrive/);
  });
});

describe("tool-free honesty survives the new capability", () => {
  test("it may explain the window but not claim a callback was arranged", () => {
    const t = sectionText(compile(), "capability_limits");
    assert.match(t, /You may still explain the business's usual callback window in general terms/);
    assert.match(t, /You must NOT say that a callback has been arranged/);
  });

  test("the existing forbidden claims are intact", () => {
    const prompt = rc.toRetellPayload({ compiled: compile(), config: CONFIG }).responseEngine.general_prompt;
    for (const claim of ["I've logged that", "I've sent that through", "the locksmith has your details", "someone will call you back"]) {
      assert.ok(prompt.includes(claim), `${claim} must still be named as forbidden`);
    }
  });

  test("the capability section stays absent when tools ARE compiled", () => {
    const compiled = compile(() => {}, { toolFree: false });
    assert.equal(compiled.spec.sections.some((s) => s.id === "capability_limits"), false);
    // …but the callback rules apply in both modes.
    assert.ok(compiled.spec.sections.some((s) => s.id === "callback_estimate"));
  });
});

// ── Schema: additive, optional, validated ───────────────────────────

describe("the callbackEstimate schema addition is additive and safe", () => {
  test("no new section, and hours gained exactly one key", () => {
    assert.equal(S.SECTIONS.length, 12, "no new profile section was introduced");
    assert.deepEqual(Object.keys(S.emptyProfile().hours).sort(), [
      "afterHoursAvailable", "afterHoursNote", "byService", "callbackEstimate",
      "ordinary", "publicHolidays", "temporaryClosure", "timezone",
    ]);
  });

  test("a profile with NO estimate still validates and provisions", () => {
    const p = buildSandboxProfile();
    p.hours.callbackEstimate = null;
    assert.equal(validateProfile(p).ok, true);
    assert.equal(assessProvisioning(p).ready, true, "an absent estimate must never block provisioning");
  });

  test("the sandbox profile with all three windows validates", () => {
    const p = buildSandboxProfile();
    assert.equal(validateProfile(p).ok, true, JSON.stringify(validateProfile(p).errors || []));
    assert.equal(assessProvisioning(p).ready, true);
  });

  test("malformed windows are rejected with a field-level error", () => {
    const cases = [
      ["missing standard", { urgent: { minMinutes: 5, maxMinutes: 10 } }],
      ["min above max", { standard: { minMinutes: 40, maxMinutes: 20 } }],
      ["non-integer", { standard: { minMinutes: 1.5, maxMinutes: 20 } }],
      ["zero minutes", { standard: { minMinutes: 0, maxMinutes: 20 } }],
      ["absurdly long", { standard: { minMinutes: 10, maxMinutes: 600 } }],
      ["unknown field", { standard: { minMinutes: 10, maxMinutes: 20 }, whenever: true }],
      ["not an object", "twenty minutes"],
      ["non-text wording", { standard: { minMinutes: 10, maxMinutes: 20 }, wording: 42 }],
    ];
    for (const [label, value] of cases) {
      const p = buildSandboxProfile();
      p.hours.callbackEstimate = value;
      const v = validateProfile(p);
      assert.equal(v.ok, false, `${label} must not validate`);
      assert.ok(v.errors.some((e) => e.field === "callbackEstimate"), `${label} must name the field`);
    }
  });

  test("it is not confused with notifications.timing", () => {
    // notifications.timing is when the LOCKSMITH is alerted. Conflating the two
    // is the exact error this milestone was told to avoid.
    const p = buildSandboxProfile();
    assert.equal(p.notifications.timing, "immediate");
    assert.notEqual(p.hours.callbackEstimate, null);
    const t = sectionText(compile(), "callback_estimate");
    assert.equal(/immediate/.test(t), false, "notification timing must not leak into caller-facing callback wording");
  });
});

// ── Nothing else moved ──────────────────────────────────────────────

describe("M7I behaviours remain intact", () => {
  test("the three service-area states and the never-refuse floor survive", () => {
    const t = sectionText(compile(), "service_area");
    assert.match(t, /NOT IN ANY LIST ABOVE — this is UNKNOWN, which is NOT the same as excluded/);
    assert.match(t, /NEVER refuse a caller only because their suburb is not on a list/);
  });

  test("still zero tools, zero unresolved variables, no raw E.164", () => {
    const payload = rc.toRetellPayload({ compiled: compile(), config: CONFIG });
    assert.deepEqual(payload.responseEngine.general_tools, []);
    const surfaces = [payload.responseEngine.general_prompt, payload.responseEngine.begin_message || "", JSON.stringify(payload.knowledge)];
    for (const s of surfaces) assert.equal(speech.containsE164(s), false);
    assert.deepEqual([...new Set([...surfaces.join("\n").matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]))], []);
  });

  test("the compile raises no review flags", () => {
    assert.deepEqual(compile().reviewFlags, []);
  });
});
