// AIDA — M7E: Australian phone-number speech.
//
// The defect these tests exist for was found on a LIVE call, not in a suite:
// the receptionist read a transfer number as "plus six one, four nine one...".
// Every canonical value therefore has an assertion here for what a caller
// actually HEARS, not just for what is stored.
//
// Pure module; nothing here contacts anything.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const speech = require("../src/services/au-phone-speech");
const { normaliseAuNumber } = require("../src/services/locksmith-profile");
const changeRequest = require("../src/services/locksmith-change-request");
const dynamicVars = require("../src/services/retell-dynamic-variables");
const compiler = require("../src/services/locksmith-receptionist-compiler");
const cfg = require("../src/config/retell");
const sandbox = require("../src/services/retell-web-sandbox");
require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

const CONFIG = cfg.getRetellConfig({});

function compileDemoReceptionist(mutate = null) {
  const extracted = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
  assert.equal(extracted.ok, true);
  const profile = JSON.parse(JSON.stringify(extracted.profile));
  if (mutate) mutate(profile);
  const compiled = compiler.compileReceptionist({
    profile,
    profileVersion: 1,
    profileStatus: "approved",
    clientId: "demo-locksmith",
    templateVersion: CONFIG.receptionistTemplateVersion,
    config: CONFIG,
    generatedAt: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(compiled.ok, true, compiled.message || "");
  return compiled;
}

/** Every digit the input carried must survive into the spoken form. */
function spokenDigits(spoken) {
  const words = { oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  return spoken.split(/[\s,]+/).filter(Boolean).map((w) => {
    assert.ok(words[w] !== undefined, `"${w}" is not a digit word — the spoken form must contain nothing else`);
    return words[w];
  }).join("");
}

describe("Australian mobile numbers", () => {
  test("the M7D number is spoken as an Australian would say it", () => {
    const d = speech.describeAuNumber("+61491234567");
    assert.equal(d.ok, true);
    assert.equal(d.e164, "+61491234567");
    assert.equal(d.display, "0491 234 567");
    assert.equal(d.spoken, "oh four nine one, two three four, five six seven");
    assert.equal(d.numberType, "mobile");
    assert.equal(d.localised, true);
  });

  test("never says \"plus\" or \"six one\" for an Australian number", () => {
    const d = speech.describeAuNumber("+61491234567");
    assert.ok(!d.spoken.includes("plus"), "the trunk prefix must not be spoken as an international one");
    assert.doesNotMatch(d.spoken, /^six one/);
    assert.equal(speech.containsE164(d.spoken), false);
  });

  test("an already-local mobile produces the identical result", () => {
    const fromLocal = speech.describeAuNumber("0491 234 567");
    const fromE164 = speech.describeAuNumber("+61491234567");
    assert.deepEqual({ ...fromLocal }, { ...fromE164 });
  });

  test("zero is \"oh\", never \"zero\"", () => {
    const d = speech.describeAuNumber("+61491570006");
    assert.equal(d.spoken, "oh four nine one, five seven oh, oh oh six");
    assert.ok(!d.spoken.includes("zero"));
  });
});

describe("Australian geographic landlines", () => {
  const cases = [
    { e164: "+61391234567", display: "03 9123 4567", spoken: "oh three, nine one two three, four five six seven" },
    { e164: "+61291234567", display: "02 9123 4567", spoken: "oh two, nine one two three, four five six seven" },
    { e164: "+61731234567", display: "07 3123 4567", spoken: "oh seven, three one two three, four five six seven" },
    { e164: "+61881234567", display: "08 8123 4567", spoken: "oh eight, eight one two three, four five six seven" },
  ];

  for (const c of cases) {
    test(`${c.e164} reads as ${c.display}`, () => {
      const d = speech.describeAuNumber(c.e164);
      assert.equal(d.ok, true);
      assert.equal(d.numberType, "landline");
      assert.equal(d.display, c.display);
      assert.equal(d.spoken, c.spoken);
    });
  }

  test("the area code is its own group, as an Australian says it", () => {
    const d = speech.describeAuNumber("+61391234567");
    assert.equal(d.spoken.split(", ")[0], "oh three");
  });
});

describe("13, 1300 and 1800", () => {
  test("1300 keeps all ten digits and never gains a trunk zero", () => {
    const d = speech.describeAuNumber("1300 123 456");
    assert.equal(d.e164, "+611300123456");
    assert.equal(d.display, "1300 123 456");
    assert.equal(d.spoken, "one three oh oh, one two three, four five six");
    assert.equal(d.numberType, "service_1300");
    assert.ok(!d.display.startsWith("0"), "the leading 1 is part of a 1300 number, not a trunk prefix");
  });

  test("1800 behaves the same way", () => {
    const d = speech.describeAuNumber("1800 123 456");
    assert.equal(d.e164, "+611800123456");
    assert.equal(d.display, "1800 123 456");
    assert.equal(d.spoken, "one eight oh oh, one two three, four five six");
    assert.equal(d.numberType, "service_1800");
  });

  test("a 13 number is SAYABLE but not a transfer target", () => {
    const d = speech.describeAuNumber("13 12 34");
    assert.equal(d.ok, true);
    assert.equal(d.display, "13 12 34");
    assert.equal(d.spoken, "one three, one two, three four");
    assert.equal(d.numberType, "service_13");
    // The canonical rule refuses it, and this module does not overrule that.
    assert.equal(d.transferEligible, false);
    assert.equal(normaliseAuNumber("13 12 34"), null);
  });

  test("recognising a 13 number did not widen the canonical normaliser", () => {
    for (const value of ["131234", "13 12 34", "+61131234"]) {
      assert.equal(normaliseAuNumber(value), null, `${value} must still be refused as a transfer target`);
    }
  });

  test("mobiles and landlines remain transfer-eligible", () => {
    assert.equal(speech.describeAuNumber("+61491234567").transferEligible, true);
    assert.equal(speech.describeAuNumber("+61391234567").transferEligible, true);
  });
});

describe("punctuation, spacing and other input forms", () => {
  const equivalents = ["+61491234567", "0491234567", "0491 234 567", "(04) 9123 4567", "04-9123-4567", "+61 491 234 567", "61491234567"];

  test("every written form of the same number converges", () => {
    const expected = "oh four nine one, two three four, five six seven";
    for (const value of equivalents) {
      assert.equal(speech.describeAuNumber(value).spoken, expected, `${value} did not converge`);
    }
  });

  test("the canonical value round-trips through itself", () => {
    // The bug this covers: normaliseAuNumber could not re-normalise its own
    // 1300/1800 output, so a stored service number evaporated on revalidation.
    for (const value of ["0491 234 567", "(03) 9123 4567", "1300 123 456", "1800 123 456"]) {
      const once = normaliseAuNumber(value);
      assert.ok(once, `${value} should normalise`);
      assert.equal(normaliseAuNumber(once), once, `${once} must survive being normalised again`);
    }
  });
});

describe("refusals", () => {
  test("an empty value produces no spoken form and says why", () => {
    for (const value of ["", "   ", null, undefined]) {
      const d = speech.describeAuNumber(value);
      assert.equal(d.ok, false);
      assert.equal(d.spoken, null);
      assert.equal(d.fallback, "empty_value");
    }
  });

  test("a non-string is refused rather than coerced", () => {
    const d = speech.describeAuNumber(61491234567);
    assert.equal(d.ok, false);
    assert.equal(d.fallback, "not_text");
  });

  test("an invalid number never becomes a plausible spoken number", () => {
    for (const value of ["not a number", "0491 234 56", "04912345678", "+61", "0000000000"]) {
      const d = speech.describeAuNumber(value);
      assert.equal(d.ok, false, `${value} must not produce a spoken form`);
      assert.equal(d.spoken, null);
      assert.equal(d.display, null);
    }
  });

  test("a non-Australian number is refused rather than given an Australian shape", () => {
    const d = speech.describeAuNumber("+14155550123");
    assert.equal(d.ok, false);
    assert.equal(d.numberType, "international");
    assert.equal(d.spoken, null, "reading a foreign number aloud is the exact failure being removed");
    assert.equal(d.fallback, "not_australian");
    // The canonical value is still carried, so a machine can still use it.
    assert.equal(d.e164, "+14155550123");
  });

  test("an extension is refused, because the domain does not permit one", () => {
    assert.equal(normaliseAuNumber("+61491234567x12"), null);
    assert.equal(speech.describeAuNumber("+61491234567 x12").ok, false);
  });
});

describe("digits are never lost, added or altered", () => {
  const values = ["+61491234567", "+61391234567", "+61291234567", "+61731234567", "+61881234567", "+611300123456", "+611800123456", "+61131234"];

  test("the spoken form contains exactly the national digits, in order", () => {
    for (const value of values) {
      const d = speech.describeAuNumber(value);
      assert.equal(d.ok, true, `${value} should localise`);
      assert.equal(spokenDigits(d.spoken), d.display.replace(/\s/g, ""), `${value} lost or gained a digit`);
    }
  });

  test("the display form contains exactly the same digits as the spoken form", () => {
    for (const value of values) {
      const d = speech.describeAuNumber(value);
      assert.equal(d.display.replace(/\D/g, "").length, spokenDigits(d.spoken).length);
    }
  });

  test("no digit compression — \"double\" and \"triple\" never appear", () => {
    // 0491 570 006 has a natural "double oh". Compressing it would be clever and
    // ambiguous; product rules do not support it, so it must not happen.
    const d = speech.describeAuNumber("+61491570006");
    assert.ok(!/double|triple/i.test(d.spoken));
    assert.equal(d.spoken, "oh four nine one, five seven oh, oh oh six");
  });

  test("the canonical value is never altered by describing it", () => {
    for (const value of values) {
      assert.equal(speech.describeAuNumber(value).e164, value);
    }
  });

  test("output is deterministic", () => {
    for (const value of values) {
      assert.deepEqual({ ...speech.describeAuNumber(value) }, { ...speech.describeAuNumber(value) });
    }
  });
});

describe("no SSML and no markup", () => {
  test("spoken output is plain text with commas only", () => {
    for (const value of ["+61491234567", "+61391234567", "+611300123456"]) {
      const spoken = speech.describeAuNumber(value).spoken;
      assert.doesNotMatch(spoken, /[<>&]/, "no SSML or markup may reach a Retell prompt");
      assert.doesNotMatch(spoken, /\d/, "digits are spelled as words so no engine can read them as a quantity");
    }
  });
});

describe("masking", () => {
  test("only the last three digits survive", () => {
    assert.equal(speech.maskAuNumber("+61491234567"), "•••••• 567");
    assert.equal(speech.maskAuNumber("0491 234 567"), "•••••• 567");
  });

  test("a too-short value masks to nothing rather than partially", () => {
    assert.equal(speech.maskAuNumber("12"), null);
    assert.equal(speech.maskAuNumber(null), null);
  });

  test("a masked number is not a number", () => {
    assert.equal(speech.containsE164(speech.maskAuNumber("+61491234567")), false);
  });
});

describe("the change-request read-back uses the shared service", () => {
  test("a mobile read-back is the local display form, not spaced E.164", () => {
    const result = changeRequest.validateChange({ target: "transferPrimary", value: "0491 570 006" });
    assert.equal(result.ok, true);
    assert.equal(result.change.value, "+61491570006", "storage stays canonical");
    assert.equal(result.change.readBackText, "0491 570 006");
    assert.equal(result.change.readBackSpoken, "oh four nine one, five seven oh, oh oh six");
  });

  test("a 1300 read-back no longer invents a leading zero", () => {
    const result = changeRequest.validateChange({ target: "transferPrimary", value: "1300 123 456" });
    assert.equal(result.ok, true);
    assert.equal(result.change.value, "+611300123456");
    assert.equal(result.change.readBackText, "1300 123 456");
    assert.ok(!result.change.readBackText.startsWith("0"), "the old implementation produced \"0 1 3 0 0 ...\"");
  });

  test("no read-back ever contains a number in international form", () => {
    for (const value of ["0491 570 006", "(03) 9000 0000", "1300 123 456", "1800 123 456"]) {
      const result = changeRequest.validateChange({ target: "transferPrimary", value });
      assert.equal(speech.containsE164(result.change.readBackText), false, `${value} leaked E.164 into the written read-back`);
      assert.equal(speech.containsE164(result.change.readBackSpoken), false, `${value} leaked E.164 into the spoken read-back`);
    }
  });

  test("correcting one digit regenerates the whole spoken form", () => {
    const before = changeRequest.validateChange({ target: "transferPrimary", value: "0491 570 006" });
    const after = changeRequest.validateChange({ target: "transferPrimary", value: "0491 570 007" });
    assert.notEqual(before.change.readBackSpoken, after.change.readBackSpoken);
    assert.equal(after.change.readBackSpoken, "oh four nine one, five seven oh, oh oh seven");
    // Nothing is cached anywhere: the spoken form is a pure function of the
    // canonical value, so there is no stale copy that could survive.
    assert.equal(speech.spokenAuNumber(after.change.value), after.change.readBackSpoken);
  });
});

describe("runtime dynamic variables", () => {
  test("a transfer number arrives ONLY as its spoken form", () => {
    const built = dynamicVars.buildInboundCallVariables({ transferPrimary: "+61491570006", transferBackup: "+61391234567" });
    assert.equal(built.ok, true);
    assert.equal(built.variables.current_transfer_number_spoken, "oh four nine one, five seven oh, oh oh six");
    assert.equal(built.variables.current_backup_number_spoken, "oh three, nine one two three, four five six seven");

    // M7G: the canonical values are NOT sent. A dynamic variable goes into the
    // model's context, and consumer analysis found nothing there that uses
    // them — the prompt names no variables, and the transfer tool resolves its
    // destination server-side from an enquiry id.
    assert.equal(built.variables.current_transfer_number, undefined);
    assert.equal(built.variables.current_backup_number, undefined);
  });

  test("NO variable the model receives contains a number in international form", () => {
    const built = dynamicVars.buildInboundCallVariables({
      transferPrimary: "+61491570006", transferBackup: "+61391234567",
      callerNumber: "+61491570110", businessStatus: "open", onCallState: "primary", callKind: "inbound_enquiry",
    });
    for (const [key, value] of Object.entries(built.variables)) {
      assert.equal(speech.containsE164(value), false, `${key} carries an E.164 number`);
    }
    assert.equal(speech.containsE164(JSON.stringify(built.variables)), false);
  });

  test("the keys stay allow-listed so a demonstrated need can pass one explicitly", () => {
    // Removing them from the DEFAULT set is not the same as forbidding them.
    // buildInboundWebhookResponse still accepts a canonical value, so a future
    // requirement can supply one without reversing this decision wholesale.
    const explicit = dynamicVars.buildInboundWebhookResponse({ variables: { current_transfer_number: "+61491570006" } });
    assert.equal(explicit.ok, true);
    assert.equal(explicit.response.call_inbound.dynamic_variables.current_transfer_number, "+61491570006");
    assert.ok(dynamicVars.ALLOWED_KEYS.includes("current_transfer_number"));
    assert.ok(dynamicVars.RUNTIME_ONLY_KEYS.includes("current_transfer_number"));
  });

  test("the spoken form cannot be supplied — only derived", () => {
    // Passing a spoken value is not part of the interface, so a caller cannot
    // create a spoken form that disagrees with the canonical number.
    const built = dynamicVars.buildInboundCallVariables({
      transferPrimary: "+61491570006",
      current_transfer_number_spoken: "nine nine nine",
    });
    assert.equal(built.variables.current_transfer_number_spoken, "oh four nine one, five seven oh, oh oh six");
  });

  test("an unlocalisable number yields no spoken variable rather than a guess", () => {
    const built = dynamicVars.buildInboundCallVariables({ transferPrimary: "+14155550123" });
    assert.equal(built.ok, true);
    assert.equal(built.variables.current_transfer_number_spoken, undefined);
  });

  test("a caller number is sent SPOKEN ONLY — the agent never gets the E.164", () => {
    const built = dynamicVars.buildInboundCallVariables({ callerNumber: "+61491570110" });
    assert.equal(built.variables.caller_number_spoken, "oh four nine one, five seven oh, one one oh");
    assert.equal(built.variables.caller_number, undefined);
    assert.equal(built.variables.caller_number_e164, undefined);
  });

  test("every value is a string, as the provider requires", () => {
    const built = dynamicVars.buildInboundCallVariables({ transferPrimary: "+61491570006", businessStatus: "open", callKind: "lockout" });
    for (const [k, v] of Object.entries(built.variables)) {
      assert.equal(typeof v, "string", `${k} must be a string`);
    }
  });

  test("an E.164 value in a _spoken key is refused, not converted", () => {
    const result = dynamicVars.validateDynamicVariables({ current_transfer_number_spoken: "+61491570006" }, { scope: "per_call" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /international form/);
    assert.equal(result.variables.current_transfer_number_spoken, undefined);
  });

  test("spoken numbers are runtime-only and refused as provisioning defaults", () => {
    for (const key of ["current_transfer_number_spoken", "current_backup_number_spoken", "caller_number_spoken"]) {
      assert.ok(dynamicVars.RUNTIME_ONLY_KEYS.includes(key), `${key} must be runtime-only`);
      const result = dynamicVars.validateDynamicVariables({ [key]: "oh four" }, { scope: "default" });
      assert.equal(result.ok, false, `${key} must not be acceptable as a default`);
    }
  });

  test("no runtime-sensitive number reaches the saved defaults", () => {
    const { defaults, runtimeOnly } = dynamicVars.splitDefaultsFromRuntime({
      business_name: "Harbour Locksmith Demo",
      current_transfer_number: "+61491570006",
      current_transfer_number_spoken: "oh four nine one, five seven oh, oh oh six",
      caller_number_spoken: "oh four nine one, five seven oh, one one oh",
    });
    assert.equal(defaults.current_transfer_number, undefined);
    assert.equal(defaults.current_transfer_number_spoken, undefined);
    assert.equal(defaults.caller_number_spoken, undefined);
    assert.equal(defaults.business_name, "Harbour Locksmith Demo");
    for (const key of ["current_transfer_number", "current_transfer_number_spoken", "caller_number_spoken"]) {
      assert.ok(runtimeOnly.includes(key));
    }
  });

  test("an unresolved placeholder is detected before it can reach a caller", () => {
    const found = dynamicVars.findUnresolvedRuntimeValues({
      current_transfer_number_spoken: "{{runtime}}",
      current_business_status: "open",
    });
    assert.deepEqual(found, ["current_transfer_number_spoken"]);
  });
});

describe("PROMPT REGRESSION — no raw E.164 in caller-facing prose", () => {
  const CANONICAL = "+61491234567";

  test("the compiled receptionist prompt contains no number in international form", () => {
    const compiled = compileDemoReceptionist((profile) => {
      profile.transfer.primaryNumber = CANONICAL;
      profile.transfer.backupNumber = "+61391234567";
    });
    const payload = compiler.toRetellPayload({ compiled, config: CONFIG });
    const prompt = payload.responseEngine.general_prompt;

    assert.ok(!prompt.includes(CANONICAL), "the canonical transfer number must never appear in the prompt");
    assert.equal(speech.containsE164(prompt), false, `prompt contained: ${(prompt.match(/\+\d{6,15}/g) || []).join(", ")}`);
    assert.equal(speech.containsE164(payload.responseEngine.begin_message || ""), false);
  });

  test("no number in international form survives anywhere in the compiled artefacts", () => {
    const compiled = compileDemoReceptionist((profile) => {
      profile.transfer.primaryNumber = CANONICAL;
    });
    const payload = compiler.toRetellPayload({ compiled, config: CONFIG });
    // The knowledge base is retrieval-backed prose the agent may read out, so
    // it is scanned with the prompt rather than trusted separately.
    assert.equal(speech.containsE164(JSON.stringify(payload)), false);
    assert.equal(speech.containsE164(JSON.stringify(compiled.spec)), false);
  });

  test("the prompt tells the agent what to do when it has no spoken number", () => {
    const compiled = compileDemoReceptionist();
    const prompt = compiler.toRetellPayload({ compiled, config: CONFIG }).responseEngine.general_prompt;
    assert.match(prompt, /never say a number that starts with a plus sign|Never read out a number that begins with a plus sign/i);
    assert.match(prompt, /ask the caller/i);
    assert.match(prompt, /double curly braces/i);
  });

  test("the transfer TOOL still receives canonical E.164 — machines are unaffected", () => {
    // The tool contract carries no number at all: the model passes an enquiry
    // id and the server resolves the destination. Saying a number and dialling
    // one are separate operations, and this proves they stayed separate.
    const compiled = compileDemoReceptionist((profile) => { profile.transfer.primaryNumber = CANONICAL; });
    const transferTool = compiled.spec.tools.find((t) => t.name === "attempt_urgent_transfer");
    assert.ok(transferTool, "the transfer tool must exist");
    assert.deepEqual(Object.keys(transferTool.parameters.properties).sort(), ["enquiry_id", "urgency"]);

    // And the canonical value is still the stored one, untouched by any of this.
    const stored = changeRequest.validateChange({ target: "transferPrimary", value: CANONICAL });
    assert.equal(stored.change.value, CANONICAL);
  });

  test("the SANDBOX prompt speaks NO transfer number — canonical or spoken", () => {
    // CHANGED BY M7I, deliberately, and this is a real behaviour change.
    //
    // The sandbox used to carry a hand-written line naming
    // {{current_transfer_number_spoken}}, so a tester could ask "who would you
    // put me through to?" and hear the M7E spoken form. That line existed only
    // in the sandbox — the production receptionist has always said the opposite:
    // "You will be given it at the time; do not read it out to the caller."
    //
    // The sandbox now compiles the production receptionist, so it inherits the
    // production rule. That is stricter than what this test originally asserted:
    // the M7D defect ("plus six one, four nine one…") is impossible because
    // there is no number variable in the prompt to read at all, not merely
    // because the safe twin was chosen. The spoken form is still DELIVERED per
    // call (asserted below) and still unit-tested throughout this file.
    const payload = sandbox.buildSandboxResponseEnginePayload({ knowledgeBaseId: "kb_test", defaults: {} });
    assert.ok(!payload.general_prompt.includes("{{current_transfer_number}}"), "the canonical variable must never be read aloud");
    assert.ok(!payload.general_prompt.includes("{{current_transfer_number_spoken}}"), "the sandbox no longer quotes a transfer number at all");
    assert.equal(speech.containsE164(payload.general_prompt), false);
    // And the prompt still forbids constructing a reading, which is the rule
    // that protects any number the agent DOES end up saying.
    assert.match(payload.general_prompt, /never convert one yourself/i);
    assert.match(payload.general_prompt, /do not read it out to the caller/i);
  });

  test("every variable the sandbox prompt names is actually delivered", () => {
    // The M7D {{caller_suburb}} defect: an unsupplied variable renders
    // literally, so the agent read the placeholder aloud as text.
    const payload = sandbox.buildSandboxResponseEnginePayload({ knowledgeBaseId: "kb_test", defaults: {} });
    const named = [...payload.general_prompt.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]);
    const delivered = new Set([
      ...Object.keys(sandbox.buildSandboxWebCallPayload({ agentId: "agent_test" }).retell_llm_dynamic_variables),
      ...Object.keys(payload.default_dynamic_variables || {}),
    ]);
    for (const name of named) {
      assert.ok(delivered.has(name), `{{${name}}} is named in the sandbox prompt but never supplied — it would be read aloud`);
    }
    // The compiled prompt names none, so the check above is vacuous unless it is
    // pinned. Nothing named means nothing that can render literally.
    assert.deepEqual(named, [], "the compiled prompt must name no dynamic variable");
  });

  test("the spoken transfer number is still DELIVERED per call, prompt or no prompt", () => {
    // The delivery path is what M7E built. It must stay proven even though the
    // sandbox prompt no longer quotes the value.
    const vars = sandbox.buildSandboxWebCallPayload({ agentId: "agent_test" }).retell_llm_dynamic_variables;
    assert.match(vars.current_transfer_number_spoken, /^oh four nine one, /);
    assert.equal(speech.containsE164(vars.current_transfer_number_spoken), false);
    assert.equal(vars.current_transfer_number, undefined, "the canonical value never enters model context");
  });
});

describe("the compiler's allow-list and prompt", () => {
  test("the spoken keys are allow-listed", () => {
    for (const key of ["current_transfer_number_spoken", "current_backup_number_spoken", "caller_number_spoken"]) {
      assert.ok(compiler.DYNAMIC_VARIABLE_ALLOWLIST.includes(key), `${key} must be allow-listed`);
    }
  });

  test("the allow-list and the dynamic-variable module agree", () => {
    assert.deepEqual([...dynamicVars.ALLOWED_KEYS].sort(), [...compiler.DYNAMIC_VARIABLE_ALLOWLIST].sort());
  });

  test("caller_number_spoken is declared empty, not as a placeholder", () => {
    // An unsupplied variable renders LITERALLY, so declaring "{{runtime}}" for
    // something no channel can deliver yet would put it in front of a caller.
    const vars = compiler.buildDynamicVariables({
      profile: { identity: { legalName: "Harbour Locksmith Demo" }, transfer: { primaryNumber: "+61491570006" } },
      profileVersion: 1,
      clientId: "client_test",
    });
    assert.equal(vars.caller_number_spoken, "");
    assert.equal(vars.current_transfer_number_spoken, "{{runtime}}");
  });
});
