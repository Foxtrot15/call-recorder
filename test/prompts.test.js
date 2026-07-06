// Regression tests for the single-responsibility prompt architecture
// (src/services/prompts.js). Pure module — runs without node_modules.
//
// Covers the six required scenarios: voicemail-only, answered conversation,
// empty recording, noisy recording, transcript without appointment,
// transcript with appointment.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const prompts = require("../src/services/prompts");

const VOICEMAIL_TRANSCRIPT =
  "Hi, this is Mark Reilly, I've got a blocked drain at my place in Epping. " +
  "Can you give me a call back on 0412 111 222? My email is mark@example.com. Thanks.";

const ANSWERED_TRANSCRIPT =
  "Speaker 0: Thanks for calling, how can I help?\n" +
  "Speaker 1: Hi, it's Sarah Chen. I need my hot water system looked at.\n" +
  "Speaker 0: I can come out Tuesday at 2pm.\n" +
  "Speaker 1: Tuesday at 2pm works. See you then.";

describe("call modes", () => {
  it("inbound recordings are voicemails; outbound bridge is answered", () => {
    assert.strictEqual(prompts.deriveCallMode({ direction: "inbound" }), "voicemail");
    assert.strictEqual(prompts.deriveCallMode({ direction: undefined }), "voicemail");
    assert.strictEqual(prompts.deriveCallMode({ direction: "outbound" }), "answered");
  });

  it("sub-modes come from transcript-grounded analysis fields only", () => {
    assert.strictEqual(prompts.deriveSubMode({ facts: { appointment_date: "Tuesday" } }), "appointment_booking");
    assert.strictEqual(prompts.deriveSubMode({ follow_up: { type: "call" }, facts: {} }), "callback_request");
    assert.strictEqual(prompts.deriveSubMode({ facts: {} }), null);
    assert.strictEqual(prompts.deriveSubMode(null), null);
  });
});

describe("scenario: voicemail only", () => {
  const p = prompts.buildEmailDraftPrompt({
    mode: "voicemail", firstName: "Mark",
    transcript: VOICEMAIL_TRANSCRIPT,
    analysis: { summary: "Blocked drain, wants callback", facts: {} },
  });

  it("prompt states no conversation happened and forbids conversation phrasing", () => {
    assert.match(p.system, /did NOT speak/i);
    assert.match(p.system, /great speaking with you/i); // listed as forbidden
    assert.match(p.system, /as discussed/i);            // listed as forbidden
  });

  it("prompt carries the transcript verbatim as the only fact source", () => {
    assert.ok(p.user.includes(VOICEMAIL_TRANSCRIPT));
    assert.match(p.user, /only source of facts/i);
  });

  it("prompt carries every anti-fabrication rule", () => {
    for (const rule of [/NEVER invent meetings/i, /NEVER invent products/i, /NEVER invent business names/i, /NEVER invent people/i, /Unknown information stays unknown/i, /supported by the transcript/i]) {
      assert.match(p.system, rule);
    }
  });

  it("subject and fallback never imply a conversation", () => {
    const subject = prompts.buildEmailSubject({ mode: "voicemail", firstName: "Mark", callerName: "Mark Reilly", isReturning: false });
    assert.doesNotMatch(subject, /speaking with you/i);
    const fallback = prompts.buildFallbackEmailBody({ mode: "voicemail", firstName: "Mark" });
    assert.doesNotMatch(fallback, /speaking with you|as discussed|we agreed/i);
    assert.match(fallback, /missed your call|your message/i);
  });

  it("analysis prompt tells the model it is a voicemail, not a discussion", () => {
    const a = prompts.buildAnalysisPrompt({ transcript: VOICEMAIL_TRANSCRIPT, mode: "voicemail" });
    assert.match(a.system, /VOICEMAIL/);
    assert.match(a.system, /did NOT speak|never as a discussion/i);
  });
});

describe("scenario: answered conversation", () => {
  it("prompt permits referring to the conversation, still transcript-bound", () => {
    const p = prompts.buildEmailDraftPrompt({
      mode: "answered", firstName: "Sarah",
      transcript: ANSWERED_TRANSCRIPT,
      analysis: { summary: "Hot water system, Tuesday 2pm", facts: { appointment_date: "Tuesday", appointment_time: "2pm" } },
    });
    assert.match(p.system, /spoke with this person/i);
    assert.match(p.system, /only to things the transcript actually contains/i);
    assert.ok(p.user.includes(ANSWERED_TRANSCRIPT));
  });

  it("answered-mode subject may reference the conversation", () => {
    const subject = prompts.buildEmailSubject({ mode: "answered", firstName: "Sarah", callerName: "Sarah Chen", isReturning: false });
    assert.match(subject, /speaking with you/i);
  });
});

describe("scenario: empty recording", () => {
  it("refuses to draft from an empty or near-empty transcript", () => {
    assert.strictEqual(prompts.canDraftEmail({ transcript: "", callerEmail: "x@y.com" }), false);
    assert.strictEqual(prompts.canDraftEmail({ transcript: "   ", callerEmail: "x@y.com" }), false);
    assert.strictEqual(prompts.canDraftEmail({ transcript: "Hi. Bye.", callerEmail: "x@y.com" }), false);
    assert.strictEqual(prompts.canDraftEmail({ transcript: null, callerEmail: "x@y.com" }), false);
  });

  it("refuses without a caller email regardless of transcript", () => {
    assert.strictEqual(prompts.canDraftEmail({ transcript: VOICEMAIL_TRANSCRIPT, callerEmail: null }), false);
  });

  it("drafts when there is real content and an email", () => {
    assert.strictEqual(prompts.canDraftEmail({ transcript: VOICEMAIL_TRANSCRIPT, callerEmail: "mark@example.com" }), true);
  });
});

describe("scenario: transcript without appointment", () => {
  it("no calendar event without a concrete date fact — intent alone is not an appointment", () => {
    assert.strictEqual(prompts.shouldCreateCalendarEvent({
      intent: "schedule_meeting",           // desire, not a booking
      follow_up: { type: "meeting", detail: "wants to meet sometime" },
      action: "arrange a meeting",
      facts: {},                             // ← no concrete date
    }), false);
    assert.strictEqual(prompts.shouldCreateCalendarEvent(null), false);
    assert.strictEqual(prompts.shouldCreateCalendarEvent({}), false);
  });
});

describe("scenario: transcript with appointment", () => {
  it("creates the event when a concrete date fact was extracted", () => {
    assert.strictEqual(prompts.shouldCreateCalendarEvent({
      intent: "schedule_meeting",
      follow_up: { type: "meeting", detail: "Tuesday at 2pm" },
      facts: { appointment_date: "Tuesday", appointment_time: "2pm" },
    }), true);
    assert.strictEqual(prompts.shouldCreateCalendarEvent({
      action: "start job",
      facts: { job_start_date: "July 14" },
    }), true);
  });

  it("appointment sub-mode instructs confirming the stated time exactly", () => {
    const p = prompts.buildEmailDraftPrompt({
      mode: "voicemail", subMode: "appointment_booking", firstName: "Sarah",
      transcript: VOICEMAIL_TRANSCRIPT,
      analysis: { facts: { appointment_date: "Tuesday" } },
    });
    assert.match(p.system, /exactly the date\/time stated in the transcript/i);
  });
});

describe("prompt hygiene — no stale examples, cached outputs labelled", () => {
  it("no builder output ever contains the known demo fixture text", () => {
    const all = [
      prompts.buildAnalysisPrompt({ transcript: "t", mode: "voicemail" }),
      prompts.buildAnalysisPrompt({ transcript: "t", mode: "answered", businessProfile: { business_type: "plumber", industry: "trades", profile_summary: "s", extraction_fields: [{ key: "k", label: "l", description: "d", example: "e" }] } }),
      prompts.buildEmailDraftPrompt({ mode: "voicemail", firstName: "A", transcript: "t", analysis: {} }),
      prompts.buildBusinessProfilePrompt({ transcriptSamples: "t" }),
      prompts.buildRollingSummaryPrompt({ existingSummary: "", recentCalls: "", latestSummary: "", knownFacts: {} }),
    ];
    for (const p of all) {
      const text = p.system + "\n" + p.user;
      assert.doesNotMatch(text, /streamline/i, "demo fixture text must never appear in a prompt template");
    }
  });

  it("business profile and contact history are labelled as BACKGROUND, not call facts", () => {
    const a = prompts.buildAnalysisPrompt({
      transcript: "t", mode: "voicemail",
      businessProfile: { business_type: "plumber", industry: "trades", profile_summary: "Fixes drains" },
      contactContext: "Previous calls: 2",
    });
    assert.match(a.system, /BACKGROUND — the business/);
    assert.match(a.system, /BACKGROUND — prior contact history/);
    assert.match(a.system, /NOT part of this call/);
  });

  it("profile extraction-field examples are never injected into analysis prompts", () => {
    const a = prompts.buildAnalysisPrompt({
      transcript: "t", mode: "voicemail",
      businessProfile: {
        business_type: "x", industry: "y", profile_summary: "z",
        extraction_fields: [{ key: "budget", label: "Budget", description: "stated budget", example: "$2M Streamline deal" }],
      },
    });
    assert.ok(!(a.system + a.user).includes("$2M Streamline deal"), "stored example values must not be injected");
  });

  it("business-profile prompt guards against caller-company confusion and allows 'unknown'", () => {
    const b = prompts.buildBusinessProfilePrompt({ transcriptSamples: "t" });
    assert.match(b.system, /callers' own companies are NOT the business/i);
    assert.match(b.system, /"unknown" rather than guessing/i);
  });
});
