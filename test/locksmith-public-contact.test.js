// AIDA — M7L-A: a public contact number is not a transfer destination.
//
// THE LIVE DEFECT (call_eedf9e0d7036673ed5f4c983aa8): the SMS notification
// failed, the agent correctly said so, advised the caller to "contact the
// locksmith directly" — and then had no number to give when asked for one.
//
// Two numbers exist on a profile and they are NOT interchangeable:
//
//   identity.businessPhone   PUBLIC. Already in the schema, already validated,
//                            already in the review UI — never compiled.
//   transfer.primaryNumber   INTERNAL routing. Often a personal mobile. Never
//                            spoken, and never a substitute for a public number.
//
// NO TEST HERE CONTACTS RETELL, TWILIO OR A DATABASE.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const rc = require("../src/services/locksmith-receptionist-compiler");
const speech = require("../src/services/au-phone-speech");
const notify = require("../src/services/locksmith-notification");
const enquiry = require("../src/services/locksmith-caller-enquiry");
const { validateProfile } = require("../src/services/locksmith-profile");
const { buildSandboxProfile, SANDBOX_CLIENT_ID, TRANSFER_PRIMARY } = require("../src/services/locksmith-sandbox-profile");
const cfg = require("../src/config/retell");

const CONFIG = cfg.getRetellConfig({ RETELL_DEFAULT_VOICE_ID: "voice_fixture", RETELL_DEFAULT_LANGUAGE: "en-AU" });

// ACMA fictitious throughout — reserved, unreachable, never a real subscriber.
const PUBLIC_NUMBER = "+61491570123";

function compile(mutate = () => {}, { toolFree = false } = {}) {
  const profile = buildSandboxProfile();
  mutate(profile);
  const compiled = rc.compileReceptionist({
    profile, profileVersion: 2, profileStatus: "approved", clientId: SANDBOX_CLIENT_ID,
    templateVersion: "t", config: CONFIG, generatedAt: null, toolFree,
  });
  assert.equal(compiled.ok, true, compiled.message || JSON.stringify(compiled.errors || compiled));
  return compiled;
}

const section = (compiled, id) => {
  const s = compiled.spec.sections.find((x) => x.id === id);
  assert.ok(s, `missing section ${id}`);
  return s.lines.join("\n");
};

const promptOf = (compiled) => rc.toRetellPayload({ compiled, config: CONFIG }).responseEngine.general_prompt;

// ── The schema already supports it ──────────────────────────────────

describe("the schema already has a public contact number", () => {
  test("identity.businessPhone exists and is validated as an AU number", () => {
    const S = require("../src/services/locksmith-profile-schema");
    assert.ok("businessPhone" in S.emptyProfile().identity, "no schema addition was needed");

    const p = buildSandboxProfile();
    p.identity.businessPhone = "not a number";
    const v = validateProfile(p);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "businessPhone"));
  });

  test("a valid public number still validates", () => {
    const p = buildSandboxProfile();
    p.identity.businessPhone = PUBLIC_NUMBER;
    assert.equal(validateProfile(p).ok, true, JSON.stringify(validateProfile(p).errors || []));
  });
});

// ── With a public number ────────────────────────────────────────────

describe("with a public number configured, the agent may say it", () => {
  const compiled = () => compile((p) => { p.identity.businessPhone = PUBLIC_NUMBER; });

  test("the SPOKEN form is compiled, never the E.164", () => {
    const t = section(compiled(), "public_contact");
    const expected = speech.describeAuNumber(PUBLIC_NUMBER).spoken;
    assert.match(t, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(speech.containsE164(t), false, "no raw international form may reach the model");
    assert.equal(t.includes(PUBLIC_NUMBER), false);
  });

  test("spoken zero formatting is preserved (M7I-C2)", () => {
    const t = section(compiled(), "public_contact");
    assert.match(t, /zero four nine one/);
    assert.equal(/\boh\b/.test(t.split("\n")[0]), false, "the number itself must not say \"oh\"");
  });

  test("it is permitted for a caller who asks, and after a failure", () => {
    const t = section(compiled(), "public_contact");
    assert.match(t, /You may give that number to a caller who asks/);
    assert.match(t, /if you could not record or send something/);
  });

  test("it is the ONLY number that may be said aloud", () => {
    assert.match(section(compiled(), "public_contact"), /That is the ONLY number you may ever say out loud/);
  });

  test("the spec records that a public number exists, without carrying the E.164", () => {
    const spec = compiled().spec;
    assert.equal(spec.publicContact.hasNumber, true);
    assert.ok(spec.publicContact.spoken);
    assert.equal(speech.containsE164(JSON.stringify(spec.publicContact)), false);
  });
});

// ── Without one ─────────────────────────────────────────────────────

describe("with NO public number, the agent must not send them anywhere", () => {
  test("the sandbox profile has none today — this is the live case", () => {
    assert.equal(buildSandboxProfile().identity.businessPhone, null);
    assert.equal(compile().spec.publicContact.hasNumber, false);
  });

  test("it says plainly that it has no number to give", () => {
    const t = section(compile(), "public_contact");
    assert.match(t, /NO public contact number configured/);
    assert.match(t, /you do not have a contact number you are authorised to give out/);
  });

  test("it must NOT advise ringing the locksmith directly", () => {
    // The exact live defect: advice with no number attached.
    assert.match(section(compile(), "public_contact"), /Do not tell a caller to "ring the locksmith directly" when you cannot tell them how/);
  });

  test("no number of any kind appears in that branch", () => {
    const t = section(compile(), "public_contact");
    assert.equal(speech.containsE164(t), false);
    assert.equal(/\d{4}/.test(t), false, "no digit run that could be mistaken for a number");
  });
});

// ── The internal number is never public ─────────────────────────────

describe("an internal transfer destination is never offered as public", () => {
  test("a transfer number does NOT become the public number", () => {
    // The sandbox has a transfer number and no business phone. The public
    // section must still report none — inference is what would expose a
    // locksmith's personal mobile.
    const p = buildSandboxProfile();
    assert.ok(p.transfer.primaryNumber, "the fixture must have a transfer number");
    assert.equal(p.identity.businessPhone, null);
    assert.equal(compile().spec.publicContact.hasNumber, false, "it must not have been inferred");
  });

  test("the transfer number never appears in model context, spoken or canonical", () => {
    const p = compile((x) => { x.identity.businessPhone = PUBLIC_NUMBER; });
    const prompt = promptOf(p);
    assert.equal(prompt.includes(TRANSFER_PRIMARY), false);
    assert.equal(prompt.includes(speech.describeAuNumber(TRANSFER_PRIMARY).spoken), false,
      "not even the spoken form of the internal destination");
    assert.equal(speech.containsE164(prompt), false);
  });

  test("the prompt forbids giving out a transfer number, in BOTH branches", () => {
    for (const [label, mutate] of [["with a public number", (p) => { p.identity.businessPhone = PUBLIC_NUMBER; }], ["without one", () => {}]]) {
      const t = section(compile(mutate), "public_contact");
      assert.match(t, /transfer/i, `${label}: the prohibition must be present`);
      assert.match(t, /internal routing destination|not public/i, label);
    }
  });

  test("the existing transfer secrecy rule is untouched", () => {
    assert.match(promptOf(compile()), /do not read it out to the caller/i);
  });
});

// ── Failure wording is no longer unsupported advice ─────────────────

describe("notification failure states the failure, and offers only what exists", () => {
  test("the notification failure message no longer asserts direct contact", () => {
    const m = notify.OUTCOMES.failed.agentMessage;
    assert.match(m, /could not get a message through/);
    assert.match(m, /ONLY if you have one/);
    assert.equal(/ringing the locksmith directly is the surer option/.test(m), false, "the live wording that had no number behind it");
  });

  test("the capture failure messages are conditional too", () => {
    for (const code of ["unavailable", "failed"]) {
      const m = enquiry.OUTCOMES[code].agentMessage;
      assert.match(m, /ONLY if you have one/, `${code} must not assume a number exists`);
      assert.equal(/they should ring the locksmith directly\./.test(m), false, code);
    }
  });

  test("a failed notification still never claims delivery", () => {
    assert.equal(notify.OUTCOMES.failed.delivered, false);
    assert.equal(notify.OUTCOMES.failed.attempted, true, "we DID try — a different fact");
    assert.equal(/has been notified/.test(notify.OUTCOMES.failed.agentMessage), false);
  });

  test("no retry loop is introduced by any of this", () => {
    const prompt = promptOf(compile());
    assert.match(prompt, /TWO ATTEMPTS AT MOST for the same job/);
    assert.match(prompt, /Do not try a third time/);
  });
});

// ── Failure boundaries: before vs after provider contact ────────────

describe("a failure before provider contact is distinguishable from one after", () => {
  const SILENT = { log() {}, error() {} };
  const ENQ = { id: "enq_1", caller_name: "T", callback_number: "+61491570111", suburb: "S", problem_description: "d" };
  const store = () => {
    const row = { state: "pending", code: null };
    return {
      row,
      claim: async () => { row.state = "sending"; return { ok: true, claimed: true, state: "sending" }; },
      markSent: async () => { row.state = "sent"; },
      markSimulated: async () => { row.state = "simulated"; },
      markFailed: async ({ code }) => { row.state = "failed"; row.code = code; },
      markNotRequired: async () => { row.state = "not_required"; },
    };
  };
  const run = (deliver, s) => notify.notifyLocksmith({
    enquiry: ENQ, profile: buildSandboxProfile(),
    config: { enabled: true, provider: "twilio_sms", mode: "live", environment: "dev" },
    deps: { logger: SILENT, deliver, ...s },
  });

  test("BEFORE contact: the adapter refuses and the code says why", async () => {
    // recipient_not_permitted / no_sender_configured / client_unavailable all
    // return without touching the provider.
    for (const code of ["recipient_not_permitted", "no_sender_configured", "client_unavailable"]) {
      const s = store();
      const r = await run(async () => ({ ok: false, provider: "twilio_sms", reference: null, code }), s);
      assert.equal(r.outcome, "failed");
      assert.equal(r.delivered, false);
      assert.equal(s.row.state, "failed");
      assert.equal(s.row.code, code, "the boundary must be recoverable from the row");
    }
  });

  test("AFTER contact: a provider rejection is recorded with its own code", async () => {
    const s = store();
    // 21606 = "The From phone number is not a valid, SMS-capable number".
    const r = await run(async () => ({ ok: false, provider: "twilio_sms", reference: null, code: "21606" }), s);
    assert.equal(r.outcome, "failed");
    assert.equal(s.row.code, "21606");
    assert.equal(r.delivered, false, "a provider rejection is never a delivery");
  });

  test("neither kind of failure can produce notified:true", async () => {
    for (const code of ["client_unavailable", "21606", "30007"]) {
      const s = store();
      const r = await run(async () => ({ ok: false, provider: "twilio_sms", reference: null, code }), s);
      const body = enquiry.toToolResponse({ saved: true, outcome: "saved", agentMessage: "x", enquiryId: "enq_1", errors: [] }, r);
      assert.equal(body.notified, false, `${code} must never claim a notification`);
      assert.equal(body.notificationAttempted, true);
      assert.equal(body.notificationState, "failed");
    }
  });
});
