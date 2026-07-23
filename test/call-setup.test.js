// WCS-1a regression tests — divert-code template engine + setup status
// machine (src/services/divert-codes.js). Pure module only: no DB, no
// Supabase, no Twilio, no network — runs on a bare checkout without
// node_modules (house rule), proven by the dep-hygiene test at the bottom.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  TEMPLATE_VERSION,
  RECOMMENDED_DISCLAIMER,
  LOOPS,
  LOOP_KEYS,
  CANCEL_ALL,
  NO_ANSWER_DELAY_OPTIONS,
  DEFAULT_NO_ANSWER_DELAY_SECONDS,
  CARRIERS,
  PLATFORMS,
  renderTemplate,
  validateTargetNumber,
  validateOptionalAuNumber,
  validateProfileInputs,
  validateSetupInputs,
  buildDivertCodes,
  STATUSES,
  STATUS_ACTIONS,
  applyStatusAction,
} = require("../src/services/divert-codes");

// Deliberately fake AU number (+61 + 9 digits) — never a real client's.
const TARGET = "+61400000000";
const ALL_LOOPS = { no_answer: true, busy: true, unreachable: true };

function build(overrides = {}) {
  return buildDivertCodes({
    targetNumber: TARGET,
    carrier: "telstra",
    phonePlatform: "iphone",
    loops: ALL_LOOPS,
    noAnswerDelaySeconds: 20,
    ...overrides,
  });
}

describe("registry integrity (the option lists the future UI renders)", () => {
  it("exposes exactly the specced carriers and platforms", () => {
    assert.deepStrictEqual(Object.keys(CARRIERS).sort(), ["aldi", "amaysim", "boost", "optus", "other", "telstra", "vodafone"]);
    assert.deepStrictEqual(Object.keys(PLATFORMS).sort(), ["desk_voip", "iphone", "other", "other_android", "pixel", "samsung"]);
    assert.deepStrictEqual(LOOP_KEYS, ["no_answer", "busy", "unreachable"], "stable presentation order");
  });

  it("every carrier has a label, a known confidence tier, and at least one note", () => {
    for (const [key, c] of Object.entries(CARRIERS)) {
      assert.ok(typeof c.label === "string" && c.label.length, `${key} label`);
      assert.ok(["standard", "varies", "unknown"].includes(c.confidence), `${key} confidence`);
      assert.ok(Array.isArray(c.notes) && c.notes.length >= 1, `${key} notes`);
    }
  });

  it("big-three are 'standard'; MVNOs are 'varies'; other is 'unknown'", () => {
    for (const k of ["telstra", "optus", "vodafone"]) assert.strictEqual(CARRIERS[k].confidence, "standard", k);
    for (const k of ["boost", "amaysim", "aldi"]) assert.strictEqual(CARRIERS[k].confidence, "varies", k);
    assert.strictEqual(CARRIERS.other.confidence, "unknown");
  });

  it("templates and version are the specced shapes", () => {
    assert.strictEqual(LOOPS.no_answer.activateTemplate, "**61*{target}**{seconds}#");
    assert.strictEqual(LOOPS.busy.activateTemplate, "**67*{target}#");
    assert.strictEqual(LOOPS.unreachable.activateTemplate, "**62*{target}#");
    assert.strictEqual(LOOPS.no_answer.cancelCode, "##61#");
    assert.strictEqual(LOOPS.busy.cancelCode, "##67#");
    assert.strictEqual(LOOPS.unreachable.cancelCode, "##62#");
    assert.strictEqual(CANCEL_ALL.code, "##002#");
    assert.ok(typeof TEMPLATE_VERSION === "string" && TEMPLATE_VERSION.length, "templateVersion for snapshots");
    assert.deepStrictEqual(NO_ANSWER_DELAY_OPTIONS, [15, 20, 25, 30]);
    assert.ok(NO_ANSWER_DELAY_OPTIONS.includes(DEFAULT_NO_ANSWER_DELAY_SECONDS), "default delay must be offerable");
  });
});

describe("template rendering", () => {
  it("fills target and seconds", () => {
    assert.strictEqual(
      renderTemplate("**61*{target}**{seconds}#", { target: TARGET, seconds: 25 }),
      "**61*+61400000000**25#"
    );
  });

  it("null seconds removes the whole optional **{seconds} segment (carrier default)", () => {
    assert.strictEqual(
      renderTemplate("**61*{target}**{seconds}#", { target: TARGET, seconds: null }),
      "**61*+61400000000#"
    );
  });

  it("throws loudly on an unresolved placeholder (a broken template edit must never emit a garbage dial string)", () => {
    assert.throws(() => renderTemplate("**61*{targe}#", { target: TARGET, seconds: null }), /unresolved placeholder/i);
    assert.throws(() => renderTemplate("**61*{target}**{secondz}#", { target: TARGET, seconds: 20 }), /unresolved placeholder/i);
  });
});

describe("code generation (gsm_codes mode)", () => {
  it("generates the exact activate codes for all three loops", () => {
    const r = build();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.mode, "gsm_codes");
    assert.deepStrictEqual(
      r.result.activate.map((a) => [a.loop, a.code]),
      [
        ["no_answer", "**61*+61400000000**20#"],
        ["busy", "**67*+61400000000#"],
        ["unreachable", "**62*+61400000000#"],
      ]
    );
  });

  it("generates matching cancel codes plus the cancel-all code with its warning", () => {
    const r = build();
    assert.deepStrictEqual(
      r.result.cancel.map((c) => [c.loop, c.code]),
      [
        ["no_answer", "##61#"],
        ["busy", "##67#"],
        ["unreachable", "##62#"],
      ]
    );
    assert.strictEqual(r.result.cancelAll.code, "##002#");
    assert.match(r.result.cancelAll.warning, /every diversion/i, "cancel-all must warn it is line-wide");
  });

  it("subset selection emits only the selected loops (busy only)", () => {
    const r = build({ loops: { no_answer: false, busy: true, unreachable: false } });
    assert.deepStrictEqual(r.result.activate.map((a) => a.code), ["**67*+61400000000#"]);
    assert.deepStrictEqual(r.result.cancel.map((c) => c.code), ["##67#"]);
    assert.strictEqual(r.result.cancelAll.code, "##002#", "cancel-all reference is always included");
  });

  it("normalises the target before rendering (local AU format in, E.164 in codes)", () => {
    const r = build({ targetNumber: "0400 000 000", loops: { busy: true } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.target, TARGET);
    assert.strictEqual(r.result.activate[0].code, "**67*+61400000000#");
  });

  it("carries snapshot provenance and carrier context", () => {
    const r = build({ carrier: "boost" });
    assert.strictEqual(r.result.templateVersion, TEMPLATE_VERSION);
    assert.strictEqual(r.result.carrier, "boost");
    assert.strictEqual(r.result.carrierLabel, "Boost Mobile");
    assert.strictEqual(r.result.confidence, "varies");
    assert.ok(r.result.dialHint, "mobile platforms get a dial hint");
  });
});

describe("no-answer delay handling", () => {
  it("accepts each supported delay value", () => {
    for (const s of NO_ANSWER_DELAY_OPTIONS) {
      const r = build({ noAnswerDelaySeconds: s, loops: { no_answer: true } });
      assert.strictEqual(r.ok, true, `delay ${s}`);
      assert.strictEqual(r.result.activate[0].code, `**61*+61400000000**${s}#`);
      assert.strictEqual(r.result.noAnswerDelaySeconds, s);
    }
  });

  it("null/undefined delay = carrier default: no **seconds segment in the code", () => {
    for (const s of [null, undefined]) {
      const r = build({ noAnswerDelaySeconds: s, loops: { no_answer: true } });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.result.activate[0].code, "**61*+61400000000#");
      assert.strictEqual(r.result.noAnswerDelaySeconds, null);
    }
  });

  it("rejects out-of-set and wrong-type delays", () => {
    for (const bad of [17, 0, -5, 31, 999, 20.5, "20", true]) {
      const r = build({ noAnswerDelaySeconds: bad });
      assert.strictEqual(r.ok, false, `delay ${JSON.stringify(bad)} must be rejected`);
      assert.ok(r.errors.some((e) => /noAnswerDelaySeconds/.test(e)), `error names the field for ${JSON.stringify(bad)}`);
    }
  });

  it("a delay with no_answer unselected is ignored, not an error (kept in the profile for later)", () => {
    const r = build({ loops: { busy: true }, noAnswerDelaySeconds: 25 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.noAnswerDelaySeconds, null);
    assert.ok(!r.result.activate.some((a) => a.code.includes("**25")), "no code may carry the ignored delay");
  });
});

describe("carrier and platform validation", () => {
  it("accepts every registry carrier with a mobile platform", () => {
    for (const carrier of Object.keys(CARRIERS)) {
      const r = build({ carrier });
      assert.strictEqual(r.ok, true, carrier);
    }
  });

  it("rejects unknown, wrong-case, empty and non-string carriers", () => {
    for (const bad of ["TELSTRA", "three", "", null, undefined, 42]) {
      const r = build({ carrier: bad });
      assert.strictEqual(r.ok, false, `carrier ${JSON.stringify(bad)}`);
      assert.ok(r.errors.some((e) => /carrier must be one of/.test(e)), "error lists valid carriers");
    }
  });

  it("rejects prototype-chain keys — registry lookups must be own-property only", () => {
    for (const sneaky of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.strictEqual(build({ carrier: sneaky }).ok, false, `carrier ${sneaky}`);
      assert.strictEqual(build({ phonePlatform: sneaky }).ok, false, `platform ${sneaky}`);
    }
  });

  it("rejects unknown platforms", () => {
    for (const bad of ["blackberry", "IPHONE", "", null, 7]) {
      const r = build({ phonePlatform: bad });
      assert.strictEqual(r.ok, false, `platform ${JSON.stringify(bad)}`);
      assert.ok(r.errors.some((e) => /phonePlatform must be one of/.test(e)));
    }
  });

  it("collects ALL errors in one pass (UI shows everything at once)", () => {
    const r = buildDivertCodes({ targetNumber: "", carrier: "three", phonePlatform: "fax", loops: {}, noAnswerDelaySeconds: 7 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.length >= 4, `expected >=4 errors, got: ${JSON.stringify(r.errors)}`);
  });
});

describe("desk phone / VoIP: manual-help, never GSM codes", () => {
  it("returns manual_help mode with no code payload at all", () => {
    const r = build({ phonePlatform: "desk_voip" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.mode, "manual_help");
    assert.ok(!("activate" in r.result), "no activate codes for desk/VoIP");
    assert.ok(!("cancel" in r.result), "no cancel codes for desk/VoIP");
    assert.ok(!("cancelAll" in r.result), "no cancel-all for desk/VoIP");
    assert.ok(!JSON.stringify(r.result).includes("**6"), "no GSM dial string anywhere in the payload");
  });

  it("explains why and offers the manual path", () => {
    const r = build({ phonePlatform: "desk_voip" });
    assert.match(r.result.reason, /voip|desk/i);
    assert.ok(r.result.notes.some((n) => /help/i.test(n)), "manual-help note present");
    assert.match(r.result.disclaimer, /carrier support may vary/i, "disclaimer still carried");
  });
});

describe("loop selection validation (stale/invalid inputs)", () => {
  it("rejects zero selected loops", () => {
    const r = build({ loops: { no_answer: false, busy: false, unreachable: false } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /at least one/i.test(e)));
  });

  it("rejects unknown loop keys instead of silently dropping them (e.g. a stale all_calls)", () => {
    const r = build({ loops: { no_answer: true, all_calls: true } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /unknown loop key.*all_calls/i.test(e)));
  });

  it("rejects non-boolean loop values and non-object loops", () => {
    assert.strictEqual(build({ loops: { no_answer: "yes" } }).ok, false);
    for (const bad of [null, undefined, "all", ["no_answer"], 3]) {
      const r = build({ loops: bad });
      assert.strictEqual(r.ok, false, `loops ${JSON.stringify(bad)}`);
    }
  });
});

describe("target number validation", () => {
  it("rejects missing/empty targets with a provisioning-flavoured error", () => {
    for (const bad of [null, undefined, "", "   "]) {
      const v = validateTargetNumber(bad);
      assert.strictEqual(v.ok, false, JSON.stringify(bad));
      assert.match(v.error, /required|not provisioned/i);
    }
  });

  it("rejects junk and non-AU shapes", () => {
    for (const bad of ["hello", "12", "+1415555000", "0400"]) {
      const v = validateTargetNumber(bad);
      assert.strictEqual(v.ok, false, JSON.stringify(bad));
    }
  });

  it("normalises AU formats to E.164 and is idempotent on E.164", () => {
    assert.deepStrictEqual(validateTargetNumber("0400 000 000"), { ok: true, e164: "+61400000000" });
    assert.deepStrictEqual(validateTargetNumber("+61400000000"), { ok: true, e164: "+61400000000" });
    assert.deepStrictEqual(validateTargetNumber("03 4422 4989"), { ok: true, e164: "+61344224989" }, "geographic AU numbers too");
  });
});

describe("honest wording (recommended / try first / may vary)", () => {
  it("the disclaimer says recommended + try first + support may vary", () => {
    assert.match(RECOMMENDED_DISCLAIMER, /recommended/i);
    assert.match(RECOMMENDED_DISCLAIMER, /try these codes first/i);
    assert.match(RECOMMENDED_DISCLAIMER, /carrier support may vary/i);
  });

  it("both result modes carry the disclaimer and template version", () => {
    for (const r of [build(), build({ phonePlatform: "desk_voip" })]) {
      assert.strictEqual(r.result.disclaimer, RECOMMENDED_DISCLAIMER);
      assert.strictEqual(r.result.templateVersion, TEMPLATE_VERSION);
    }
  });

  it("MVNO results carry the enable-via-app/support caveat", () => {
    for (const carrier of ["boost", "amaysim", "aldi"]) {
      const r = build({ carrier });
      assert.ok(r.result.notes.some((n) => /enabled|app|support/i.test(n)), `${carrier} caveat`);
    }
  });

  it("no result text claims a guarantee", () => {
    for (const r of [build(), build({ carrier: "other" }), build({ phonePlatform: "desk_voip" })]) {
      assert.ok(!/guarantee/i.test(JSON.stringify(r.result)), "never promise 'guaranteed'");
    }
  });
});

describe("setup status machine", () => {
  it("declares exactly the five specced statuses", () => {
    assert.deepStrictEqual(STATUSES, [
      "not_started",
      "instructions_generated",
      "user_claimed_done",
      "test_passed",
      "needs_help",
    ]);
  });

  it("allows the happy path: generate → claim_done → report_test_passed", () => {
    assert.deepStrictEqual(applyStatusAction("not_started", "generate"), { ok: true, next: "instructions_generated" });
    assert.deepStrictEqual(applyStatusAction("instructions_generated", "claim_done"), { ok: true, next: "user_claimed_done" });
    assert.deepStrictEqual(applyStatusAction("user_claimed_done", "report_test_passed"), { ok: true, next: "test_passed" });
  });

  it("generate and reset are allowed from every status (regeneration/edit recovery)", () => {
    for (const s of STATUSES) {
      assert.deepStrictEqual(applyStatusAction(s, "generate"), { ok: true, next: "instructions_generated" }, `generate from ${s}`);
      assert.deepStrictEqual(applyStatusAction(s, "reset"), { ok: true, next: "not_started" }, `reset from ${s}`);
    }
  });

  it("needs_help is reachable only once instructions exist, and back_to_instructions only from needs_help", () => {
    for (const s of ["instructions_generated", "user_claimed_done", "test_passed"]) {
      assert.deepStrictEqual(applyStatusAction(s, "needs_help"), { ok: true, next: "needs_help" }, s);
    }
    assert.strictEqual(applyStatusAction("not_started", "needs_help").ok, false, "nothing to be stuck on pre-generate");
    assert.deepStrictEqual(applyStatusAction("needs_help", "back_to_instructions"), { ok: true, next: "instructions_generated" });
    for (const s of ["not_started", "instructions_generated", "user_claimed_done", "test_passed"]) {
      assert.strictEqual(applyStatusAction(s, "back_to_instructions").ok, false, s);
    }
  });

  it("denies skipping and re-claiming", () => {
    const denied = [
      ["not_started", "claim_done"],
      ["not_started", "report_test_passed"],
      ["instructions_generated", "report_test_passed"], // can't report a test before claiming setup done
      ["user_claimed_done", "claim_done"],
      ["test_passed", "claim_done"],
      ["test_passed", "report_test_passed"],
      ["needs_help", "claim_done"],
      ["needs_help", "report_test_passed"],
      ["needs_help", "needs_help"],
    ];
    for (const [from, action] of denied) {
      const r = applyStatusAction(from, action);
      assert.strictEqual(r.ok, false, `${action} from ${from}`);
      assert.match(r.error, new RegExp(`cannot ${action} from`), "error names the rejected transition");
    }
  });

  it("rejects unknown statuses and actions (stale rows / stale clients)", () => {
    assert.match(applyStatusAction("half_done", "generate").error, /unknown setup status/);
    assert.match(applyStatusAction("not_started", "launch").error, /unknown status action/);
    for (const sneaky of ["constructor", "__proto__", "toString"]) {
      assert.strictEqual(applyStatusAction("not_started", sneaky).ok, false, sneaky);
    }
    assert.strictEqual(applyStatusAction(null, "generate").ok, false);
    assert.strictEqual(applyStatusAction("not_started", null).ok, false);
  });

  it("every action's from-list and target are valid statuses (table integrity)", () => {
    for (const [action, rule] of Object.entries(STATUS_ACTIONS)) {
      assert.ok(STATUSES.includes(rule.to), `${action} target`);
      for (const f of rule.from) assert.ok(STATUSES.includes(f), `${action} from ${f}`);
    }
  });
});

describe("WCS-1b-i additive validators", () => {
  const PROFILE_OK = { carrier: "telstra", phonePlatform: "iphone", loops: ALL_LOOPS, noAnswerDelaySeconds: 20 };

  it("validateProfileInputs passes valid inputs with no target at all", () => {
    assert.deepStrictEqual(validateProfileInputs(PROFILE_OK), { ok: true, errors: [] });
    assert.strictEqual(validateProfileInputs({ ...PROFILE_OK, noAnswerDelaySeconds: null }).ok, true);
  });

  it("refactor parity: validateSetupInputs errors === validateProfileInputs errors + target error, in order", () => {
    const badInputs = { carrier: "three", phonePlatform: "fax", loops: { all_calls: true }, noAnswerDelaySeconds: 7 };
    const profile = validateProfileInputs(badInputs);
    const full = validateSetupInputs({ ...badInputs, targetNumber: "junk" });
    assert.deepStrictEqual(full.errors.slice(0, profile.errors.length), profile.errors, "profile errors identical and first");
    assert.strictEqual(full.errors.length, profile.errors.length + 1, "exactly one extra (target) error");
    assert.match(full.errors[full.errors.length - 1], /targetNumber/, "target error appended last");
  });

  it("validateProfileInputs rejects the same field problems as the full validator", () => {
    assert.ok(validateProfileInputs({ ...PROFILE_OK, carrier: "TELSTRA" }).errors.some((e) => /carrier must be one of/.test(e)));
    assert.ok(validateProfileInputs({ ...PROFILE_OK, phonePlatform: "fax" }).errors.some((e) => /phonePlatform must be one of/.test(e)));
    assert.ok(validateProfileInputs({ ...PROFILE_OK, loops: {} }).errors.some((e) => /at least one/i.test(e)));
    assert.ok(validateProfileInputs({ ...PROFILE_OK, noAnswerDelaySeconds: 17 }).errors.some((e) => /noAnswerDelaySeconds/.test(e)));
  });

  it("validateOptionalAuNumber: absent or blank is fine (optional field), e164 null", () => {
    for (const v of [null, undefined, "", "   "]) {
      assert.deepStrictEqual(validateOptionalAuNumber(v), { ok: true, e164: null }, JSON.stringify(v));
    }
  });

  it("validateOptionalAuNumber: normalises AU formats when present", () => {
    assert.deepStrictEqual(validateOptionalAuNumber("0400 111 222"), { ok: true, e164: "+61400111222" });
    assert.deepStrictEqual(validateOptionalAuNumber("+61400111222"), { ok: true, e164: "+61400111222" });
  });

  it("validateOptionalAuNumber: rejects junk and non-AU values", () => {
    for (const bad of ["hello", "12", "+1415555000", "0400"]) {
      const v = validateOptionalAuNumber(bad);
      assert.strictEqual(v.ok, false, JSON.stringify(bad));
      assert.match(v.error, /Australian E\.164/);
    }
  });
});

describe("dependency hygiene (dep-free house rule)", () => {
  it("loading and using the module never touches heavy deps (twilio / supabase-js)", () => {
    build(); // exercise the full generation path first
    const heavy = Object.keys(require.cache).filter((p) => /node_modules[\\/](twilio|@supabase)/.test(p));
    assert.deepStrictEqual(heavy, [], "divert-codes (incl. its loop-guard require) must stay pure");
  });
});
