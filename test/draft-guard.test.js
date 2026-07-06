// Regression tests for the deterministic grounding guard
// (src/services/draft-guard.js). These are the tests that FAIL if
// hallucinated companies, people, appointments, or products appear in a
// draft that the evidence doesn't support.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { validateDraft } = require("../src/services/draft-guard");

// A real-world-shaped voicemail: plumbing enquiry, no company, no appointment.
const VOICEMAIL = {
  transcript:
    "Hi, this is Mark Reilly, I've got a blocked drain at my place in Epping. " +
    "Can you give me a call back on 0412 111 222? My email is mark@example.com. Thanks.",
  analysis: {
    caller: { name: "Mark Reilly", email: "mark@example.com" },
    intent: "quote_request",
    summary: "Mark Reilly called about a blocked drain in Epping and asked for a callback.",
    facts: { suburb: "Epping", job_type: "blocked drain" },
  },
  allowlist: ["Mark", "Mark Reilly"],
};

const NOISY = {
  transcript: "uh yeah hi it's um [inaudible] about the the thing on um yeah call me back thanks bye",
  analysis: { caller: { name: null, email: "x@y.com" }, summary: "Unclear message requesting a callback.", facts: {} },
  allowlist: ["there"],
};

describe("guard fails drafts containing hallucinations", () => {
  it("hallucinated COMPANY name → rejected (the observed incident)", () => {
    const draft =
      "Hi Mark,\n\nGreat to hear from you. As discussed with the team at Streamline Software, " +
      "we'll get your drain sorted.\n\nKind regards";
    const v = validateDraft(draft, VOICEMAIL);
    assert.strictEqual(v.ok, false);
    assert.ok(v.ungroundedEntities.some((e) => /Streamline Software/i.test(e)), `expected Streamline Software flagged, got ${JSON.stringify(v.ungroundedEntities)}`);
  });

  it("hallucinated PERSON → rejected", () => {
    const draft = "Hi Mark,\n\nThanks for your message. I'll ask Alex to call you about the drain.\n\nKind regards";
    const v = validateDraft(draft, VOICEMAIL);
    assert.strictEqual(v.ok, false);
    assert.ok(v.ungroundedEntities.includes("Alex"), `expected Alex flagged, got ${JSON.stringify(v.ungroundedEntities)}`);
  });

  it("hallucinated APPOINTMENT (day + time not in transcript) → rejected", () => {
    const draft = "Hi Mark,\n\nThanks for your message about the drain. I'll see you Tuesday at 2pm as arranged.\n\nKind regards";
    const v = validateDraft(draft, VOICEMAIL);
    assert.strictEqual(v.ok, false);
    assert.ok(v.ungroundedTemporals.includes("tuesday"), `expected tuesday flagged, got ${JSON.stringify(v.ungroundedTemporals)}`);
    assert.ok(v.ungroundedTemporals.some((t) => t.includes("2pm")), "expected 2pm flagged");
  });

  it("hallucinated PRODUCT → rejected", () => {
    const draft = "Hi Mark,\n\nThanks for your message. Our Premium Drain Care Plan would suit you perfectly.\n\nKind regards";
    const v = validateDraft(draft, VOICEMAIL);
    assert.strictEqual(v.ok, false);
    assert.ok(v.ungroundedEntities.some((e) => /Premium Drain Care Plan/i.test(e)));
  });

  it("noisy recording: any invented specifics are rejected", () => {
    const draft = "Hi,\n\nThanks for calling about your Rheem hot water system. I'll see you Friday.\n\nKind regards";
    const v = validateDraft(draft, NOISY);
    assert.strictEqual(v.ok, false);
    assert.ok(v.ungroundedEntities.includes("Rheem"));
    assert.ok(v.ungroundedTemporals.includes("friday"));
  });
});

describe("guard passes grounded drafts", () => {
  it("honest voicemail acknowledgement using only transcript facts → ok", () => {
    const draft =
      "Hi Mark,\n\nThanks for your message about the blocked drain at your place in Epping — sorry I missed your call. " +
      "I'll give you a ring back as soon as possible to sort it out.\n\nKind regards";
    const v = validateDraft(draft, VOICEMAIL);
    assert.strictEqual(v.ok, true, `unexpected flags: ${JSON.stringify(v)}`);
  });

  it("answered call: confirming a time that IS in the transcript → ok", () => {
    const evidence = {
      transcript: "Speaker 1: It's Sarah Chen, hot water system issue.\nSpeaker 0: I can come Tuesday at 2pm.\nSpeaker 1: Tuesday at 2pm works.",
      analysis: { caller: { name: "Sarah Chen" }, facts: { appointment_date: "Tuesday", appointment_time: "2pm" } },
      allowlist: ["Sarah", "Sarah Chen"],
    };
    const draft = "Hi Sarah,\n\nGreat speaking with you today — confirming I'll be out Tuesday at 2pm to look at the hot water system.\n\nKind regards";
    const v = validateDraft(draft, evidence);
    assert.strictEqual(v.ok, true, `unexpected flags: ${JSON.stringify(v)}`);
  });

  it("safe fallback template is always grounded (never rejected)", () => {
    const prompts = require("../src/services/prompts");
    for (const mode of ["voicemail", "answered"]) {
      const body = prompts.buildFallbackEmailBody({ mode, firstName: "Mark" });
      const v = validateDraft(body, VOICEMAIL);
      assert.strictEqual(v.ok, true, `fallback (${mode}) must pass its own guard: ${JSON.stringify(v)}`);
    }
  });

  it("empty draft trivially passes (nothing claimed)", () => {
    assert.strictEqual(validateDraft("", VOICEMAIL).ok, true);
  });
});
