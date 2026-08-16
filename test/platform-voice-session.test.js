// AIDA VOICE CONFIGURATION P38-P42, P45 — the engine, the planner, the intents,
// the simulator, and the handoff to the UI.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const V = require("../src/platform/voice/voice-session-model");
const I = require("../src/platform/voice/voice-intents");
const PLANNER = require("../src/platform/voice/voice-planner");
const { createDeterministicInterpreter, createScriptedInterpreter, parseTime, INTERPRETER_CONTRACT } = require("../src/platform/voice/voice-interpreter-port");
const { runVoiceCommand, COMMANDS, FORBIDDEN_FLAGS, USAGE } = require("../src/platform/voice/voice-cli");
const { voicePrincipal } = require("../src/platform/config-access");
const { locksmithA, plumberC, garageDoorD } = require("../src/platform/fixtures/clients");
const { emptyBlueprint, DAYS, URGENCY_LEVELS, BLUEPRINT_STATUSES } = require("../src/platform/client-blueprint");
const { SCENARIOS } = require("./fixtures/voice-transcripts");
const { clock, buildPlatform, activate, seedDraft, buildEngine, P } = require("./helpers/voice-harness");

const ROOT = path.join(__dirname, "..");

async function liveSession({ blueprint = garageDoorD(), clientId = "rolladoor_repairs", interpreter = null, active = true } = {}) {
  const now = clock();
  const platform = buildPlatform({ now });
  const version = active
    ? await activate(platform.configService, clientId, blueprint)
    : await seedDraft(platform.configService, clientId, blueprint);
  const engine = buildEngine({ ...platform, interpreter });
  const started = await engine.start({
    principal: voicePrincipal({ clientId }), clientId, blueprint: version, hasActiveVersion: active,
  });
  const say = async (t) => { now.tick(15000); return engine.hear({ sessionId: started.sessionId, transcript: t }); };
  return { platform, engine, started, say, now, clientId, version };
}

// ════════════════════════════════════════════════════════════════════
// P38 — THE SESSION MODEL
// ════════════════════════════════════════════════════════════════════

describe("P38 session model — a conversation with an audit trail", () => {
  it("declares every state, and every state has a meaning a person could read", () => {
    for (const state of V.SESSION_STATES) {
      assert.ok(V.STATE_MEANING[state], `${state} has no meaning`);
      assert.ok(V.STATE_TRANSITIONS[state], `${state} has no transitions declared`);
    }
    assert.equal(Object.keys(V.STATE_TRANSITIONS).length, V.SESSION_STATES.length);
  });

  it("declares transitions only to states that exist", () => {
    for (const [from, tos] of Object.entries(V.STATE_TRANSITIONS)) {
      for (const to of tos) assert.ok(V.SESSION_STATES.includes(to), `${from} -> ${to} is not a state`);
    }
  });

  it("keeps the tenant on the session and never on a turn", () => {
    const session = V.emptySession({ sessionId: "s1", clientId: "c1", actorId: "a" });
    const turn = V.emptyTurn({ turnNumber: 1, role: "caller", text: "hello" });
    assert.equal(session.clientId, "c1");
    assert.ok(!("clientId" in turn), "a turn carries a tenant");
    assert.equal(session.source, "voice");
  });

  it("uses three turn roles and no more", () => {
    assert.deepEqual([...V.TURN_ROLES], ["caller", "assistant", "system"]);
  });

  it("requires a spoken confirmation for high risk and nothing else", () => {
    assert.equal(V.requiresSpokenConfirmation("high"), true);
    assert.equal(V.requiresSpokenConfirmation("medium"), false);
    assert.equal(V.requiresSpokenConfirmation("low"), false);
    for (const r of V.RISK_CLASSES) assert.ok(V.RISK_MEANING[r], `${r} has no meaning`);
  });

  it("declares an audit event for everything worth recording", () => {
    for (const needed of ["voice_session_started", "voice_change_proposed", "voice_change_confirmed",
      "voice_change_rejected", "voice_draft_created", "voice_session_cancelled"]) {
      assert.ok(V.VOICE_AUDIT_EVENTS.includes(needed), `no ${needed} event`);
    }
  });

  it("records the whole conversation as turns, in order, with no audio", async () => {
    const { say, engine, started } = await liveSession();
    await say("We close at four on Saturdays now.");
    const session = await engine.get({ sessionId: started.sessionId });
    assert.ok(session.turns.length >= 3);
    session.turns.forEach((t, i) => {
      assert.equal(t.turnNumber, i + 1);
      assert.ok(V.TURN_ROLES.includes(t.role));
      assert.ok(!("audio" in t) && !("recordingUrl" in t));
    });
    assert.equal(session.turns.filter((t) => t.role === "caller").length, 1);
  });
});

// ════════════════════════════════════════════════════════════════════
// P39 — INTENTS
// ════════════════════════════════════════════════════════════════════

describe("P39 intents — a closed vocabulary with typed payloads", () => {
  it("covers every intent the founder named", () => {
    for (const named of ["SET_BUSINESS_HOURS", "ADD_SERVICE", "UPDATE_SERVICE", "REMOVE_SERVICE",
      "SET_SERVICE_AREA", "EXCLUDE_SERVICE_AREA", "SET_GREETING", "SET_CALLBACK_POLICY",
      "SET_TRANSFER_RULE", "SET_AFTER_HOURS_POLICY", "ADD_APPROVED_FACT", "REMOVE_APPROVED_FACT",
      "SET_PRICING_POLICY", "SET_BOOKING_SETTING", "SET_VOICE_PREFERENCE",
      "SET_INTEGRATION_REQUIREMENT", "SET_COMPLIANCE_WORDING", "PROPOSE_OUTBOUND_SETTING"]) {
      assert.ok(I.CONFIGURATION_INTENTS.includes(named), `missing intent ${named}`);
    }
    for (const named of ["CONFIRM", "REJECT", "CORRECT", "UNDO_PROPOSED_CHANGE",
      "ASK_WHAT_IS_CONFIGURED", "ASK_WHAT_WILL_CHANGE", "FINISH_CONFIGURATION", "CANCEL"]) {
      assert.ok(I.CONVERSATIONAL_INTENTS.includes(named), `missing conversational intent ${named}`);
    }
    assert.equal(I.UNKNOWN_INTENT, "UNKNOWN_INTENT");
  });

  it("gives every configuration intent a section, a risk and a reason", () => {
    for (const intent of I.CONFIGURATION_INTENTS) {
      const spec = I.INTENT_SPEC[intent];
      assert.ok(spec.section, `${intent} has no section`);
      assert.ok(V.RISK_CLASSES.includes(spec.risk), `${intent} has risk "${spec.risk}"`);
      assert.ok(spec.why && spec.why.length > 15, `${intent} does not say why it matters`);
      assert.ok(Object.keys(spec.fields).length > 0, `${intent} has no payload contract`);
    }
  });

  it("marks the changes that would hurt most as high risk", () => {
    for (const dangerous of ["REMOVE_SERVICE", "EXCLUDE_SERVICE_AREA", "SET_TRANSFER_RULE",
      "SET_URGENCY_RULE", "SET_COMPLIANCE_WORDING", "PROPOSE_OUTBOUND_SETTING"]) {
      assert.equal(I.riskOf(dangerous), "high", `${dangerous} is not high risk`);
    }
    // And something ordinary is not, so the assertion above means something.
    assert.equal(I.riskOf("SET_VOICE_PREFERENCE"), "low");
  });

  it("builds option lists FROM the blueprint's vocabularies", () => {
    const urgency = I.INTENT_SPEC.SET_URGENCY_RULE;
    const errors = [];
    urgency.fields.level("not_a_level", errors);
    assert.ok(errors.length > 0);
    assert.ok(errors[0].message.includes(URGENCY_LEVELS[0]), "the error does not quote the domain vocabulary");
    for (const level of URGENCY_LEVELS) {
      const e = [];
      urgency.fields.level(level, e);
      assert.deepEqual(e, [], `${level} was rejected`);
    }
  });

  it("refuses an unknown field rather than ignoring it", () => {
    const result = I.validateIntentPayload("SET_DAY_CLOSED", { day: "sunday", status: "active", clientId: "other" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "status"));
    assert.ok(result.errors.some((e) => e.field === "clientId"));
  });

  it("refuses a day that is not a day, and a period that ends before it starts", () => {
    assert.equal(I.validateIntentPayload("SET_BUSINESS_HOURS", { day: "caturday", periods: [{ start: "09:00", end: "16:00" }] }).ok, false);
    assert.equal(I.validateIntentPayload("SET_BUSINESS_HOURS", { day: "monday", periods: [{ start: "17:00", end: "09:00" }] }).ok, false);
    for (const day of DAYS) {
      assert.equal(I.validateIntentPayload("SET_BUSINESS_HOURS", { day, periods: [{ start: "09:00", end: "16:00" }] }).ok, true);
    }
  });

  it("refuses a transfer number that is not a full international number", () => {
    assert.equal(I.validateIntentPayload("SET_TRANSFER_RULE", { number: "0355 500 399" }).ok, false);
    assert.equal(I.validateIntentPayload("SET_TRANSFER_RULE", { number: "+61355500399" }).ok, true);
  });

  it("describes every intent twice — for a list, and for a sentence", () => {
    for (const intent of I.CONFIGURATION_INTENTS) {
      const payload = SAMPLE[intent];
      if (!payload) continue;
      const written = I.describeIntent(intent, payload);
      const spoken = I.describeIntentSpoken(intent, payload);
      assert.ok(written.length > 3, `${intent} has no written description`);
      assert.ok(spoken.length > 3, `${intent} has no spoken description`);
      // The spoken form must complete "I'll …", so it starts with a verb —
      // which in practice means lower case and not the section's noun.
      assert.equal(spoken[0], spoken[0].toLowerCase(), `${intent} spoken form is not a verb phrase: "${spoken}"`);
    }
  });

  it("speaks times as a person would", () => {
    assert.equal(I.spokenTime("16:00"), "4pm");
    assert.equal(I.spokenTime("09:00"), "9am");
    assert.equal(I.spokenTime("12:00"), "12pm");
    assert.equal(I.spokenTime("00:30"), "12:30am");
  });
});

const SAMPLE = {
  SET_BUSINESS_HOURS: { day: "saturday", periods: [{ start: "09:00", end: "16:00" }] },
  SET_DAY_CLOSED: { day: "sunday" },
  SET_AFTER_HOURS_POLICY: { available: true },
  ADD_SERVICE: { name: "Cable Replacement" },
  UPDATE_SERVICE: { serviceRef: "Cable Replacement", urgency: "urgent" },
  REMOVE_SERVICE: { serviceRef: "Cable Replacement" },
  SET_SERVICE_AREA: { suburbs: ["Brunswick"] },
  EXCLUDE_SERVICE_AREA: { suburbs: ["Frankston"] },
  SET_GREETING: { greeting: "Hello" },
  SET_CALLBACK_POLICY: { policy: "Within the hour" },
  SET_TRANSFER_RULE: { number: "+61355500399" },
  SET_URGENCY_RULE: { when: "Door stuck open", level: "emergency", action: "transfer_immediately" },
  SET_CALLER_INFORMATION: { collect: ["caller_name"] },
  ADD_APPROVED_FACT: { statement: "Trading since 1998." },
  REMOVE_APPROVED_FACT: { factRef: "Trading since 1998." },
  SET_PRICING_POLICY: { disclosure: "never_discuss" },
  SET_BOOKING_SETTING: { enabled: true },
  SET_INTEGRATION_REQUIREMENT: { capability: "calendar", enabled: true },
  SET_VOICE_PREFERENCE: { tone: "warm" },
  SET_COMPLIANCE_WORDING: { recordingDisclosure: "Calls may be recorded." },
  PROPOSE_OUTBOUND_SETTING: { proposition: "We fix doors" },
  SET_BUSINESS_IDENTITY: { tradingName: "Rolladoor" },
};

// ════════════════════════════════════════════════════════════════════
// P40 — THE PLANNER
// ════════════════════════════════════════════════════════════════════

describe("P40 planner — asks what is missing, and stops when nothing is", () => {
  it("asks a new client nothing it already knows", () => {
    const bp = emptyBlueprint({ clientId: "new_co", vertical: "plumbing" });
    const before = PLANNER.planNextQuestion({ blueprint: bp, mode: "setup" });
    assert.equal(before.topic, "identity");

    bp.identity.legalName = "New Co";
    bp.identity.assistantName = "Alex";
    const after = PLANNER.planNextQuestion({ blueprint: bp, mode: "setup" });
    assert.equal(after.topic, "services", "it asked about identity again");
  });

  it("asks a complete existing client NOTHING", () => {
    assert.equal(PLANNER.planNextQuestion({ blueprint: locksmithA(), mode: "edit" }), null);
    assert.equal(PLANNER.assessCoverage(locksmithA()).complete, true);
  });

  it("detects the mode from the configuration, not from a flag somebody set", () => {
    assert.equal(PLANNER.detectSessionMode({ blueprint: locksmithA(), hasActiveVersion: true }), "edit");
    assert.equal(PLANNER.detectSessionMode({ blueprint: emptyBlueprint({ clientId: "c" }), hasActiveVersion: false }), "setup");
    // A complete blueprint that is not yet ACTIVE is still setup: nothing is live.
    assert.equal(PLANNER.detectSessionMode({ blueprint: locksmithA(), hasActiveVersion: false }), "setup");
  });

  it("does not ask about urgency before it knows the services", () => {
    const bp = emptyBlueprint({ clientId: "c", vertical: "plumbing" });
    bp.identity.legalName = "C"; bp.identity.assistantName = "A";
    const question = PLANNER.planNextQuestion({ blueprint: bp, mode: "setup", coveredTopics: ["identity"] });
    assert.notEqual(question.topic, "urgency", "it asked which services are urgent before knowing any");
  });

  it("uses the client's own service names when it asks about urgency", () => {
    const bp = emptyBlueprint({ clientId: "c", vertical: "plumbing" });
    bp.services = [{ serviceId: "blocked_drains", name: "Blocked drains", enabled: true, urgencyCategory: "standard" }];
    const question = PLANNER.planNextQuestion({ blueprint: bp, mode: "setup", coveredTopics: ["identity", "services"] });
    assert.equal(question.topic, "urgency");
    assert.match(question.question, /Blocked drains/);
  });

  it("prioritises an unresolved question over everything else", () => {
    const question = PLANNER.planNextQuestion({
      blueprint: emptyBlueprint({ clientId: "c" }), mode: "setup",
      unresolved: [{ question: "What time on Saturday?", topic: "hours" }],
    });
    assert.equal(question.kind, "clarification");
    assert.equal(question.question, "What time on Saturday?");
  });

  it("prioritises a pending confirmation over a new topic", () => {
    const question = PLANNER.planNextQuestion({
      blueprint: emptyBlueprint({ clientId: "c" }), mode: "setup",
      pendingConfirmation: { question: "Shall I go ahead?", topic: "services" },
    });
    assert.equal(question.kind, "confirmation");
  });

  it("says why every topic matters, in words a person would use", () => {
    for (const topic of PLANNER.TOPICS) {
      assert.ok(topic.missingBecause.length > 20, `${topic.key} has no reason`);
      assert.ok(!/undefined|TODO/.test(topic.missingBecause));
    }
    assert.ok(PLANNER.TOPICS.length >= 13, `only ${PLANNER.TOPICS.length} topics`);
  });

  it("lists what is still outstanding for a review screen", () => {
    const outstanding = PLANNER.outstandingRequirements(emptyBlueprint({ clientId: "c" }));
    assert.ok(outstanding.length >= 8);
    for (const o of outstanding) { assert.ok(o.topic); assert.ok(o.because); assert.ok(o.question); }
    assert.deepEqual(PLANNER.outstandingRequirements(locksmithA()), []);
  });
});

// ════════════════════════════════════════════════════════════════════
// P40A / P40B — INTERVIEW AND TARGETED EDIT
// ════════════════════════════════════════════════════════════════════

describe("P40A/P40B — a new client is interviewed, an existing one is not", () => {
  it("opens a new client's session with a question", async () => {
    const bp = emptyBlueprint({ clientId: "riverside_plumbing", vertical: "plumbing" });
    bp.identity.timezone = "Australia/Melbourne"; bp.hours.timezone = "Australia/Melbourne";
    const { started } = await liveSession({ blueprint: bp, clientId: "riverside_plumbing", active: false });
    assert.match(started.spoken, /Let's get your assistant set up/);
    assert.ok(started.question, "no opening question");
    assert.equal(started.question.topic, "identity");
  });

  it("opens an existing client's session by listening", async () => {
    const { started } = await liveSession();
    assert.equal(started.spoken, "What would you like to change?");
    assert.equal(started.question, null, "an existing client was interviewed");
  });

  it("lets an existing client change one thing and finish in two turns", async () => {
    const { say } = await liveSession();
    await say("We close at four on Saturdays now.");
    const done = await say("That's it.");
    assert.equal(done.state, "draft_created");
    assert.equal(done.changeCount, 1);
  });

  it("walks a new client through the topics in order", async () => {
    const bp = emptyBlueprint({ clientId: "riverside_plumbing", vertical: "plumbing" });
    bp.identity.timezone = "Australia/Melbourne"; bp.hours.timezone = "Australia/Melbourne";
    const asked = [];
    let blueprint = bp;
    const covered = [];
    for (let i = 0; i < 6; i += 1) {
      const question = PLANNER.planNextQuestion({ blueprint, mode: "setup", coveredTopics: covered });
      if (!question) break;
      asked.push(question.topic);
      covered.push(question.topic);
    }
    assert.deepEqual(asked.slice(0, 4), ["identity", "services", "serviceArea", "hours"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// P41 / P41A / P41B — INTERPRETATION, AMBIGUITY, CORRECTION
// ════════════════════════════════════════════════════════════════════

describe("P41 interpretation — a port, a contract, and no model", () => {
  it("states what a real adapter must and must not do", () => {
    assert.match(INTERPRETER_CONTRACT.method, /interpretTurn/);
    assert.ok(INTERPRETER_CONTRACT.mustNot.length >= 4);
    assert.ok(INTERPRETER_CONTRACT.mustNot.some((m) => /confidence/.test(m)));
    assert.ok(INTERPRETER_CONTRACT.mustNot.some((m) => /never a guess|outside ALL_INTENTS/.test(m + INTERPRETER_CONTRACT.returns.intent)));
  });

  it("parses the times a person actually says", () => {
    assert.equal(parseTime("four"), "16:00");
    assert.equal(parseTime("4pm"), "16:00");
    assert.equal(parseTime("16:00"), "16:00");
    assert.equal(parseTime("9am"), "09:00");
    assert.equal(parseTime("9:30am"), "09:30");
    assert.equal(parseTime("nothing here"), null, "it invented a time");
  });

  it("surfaces an assumption rather than making it silently", async () => {
    const interpreter = createDeterministicInterpreter();
    const result = await interpreter.interpretTurn({ transcript: "We close at four on Saturdays.", context: { turnNumber: 1 } });
    assert.equal(result.intent, "SET_BUSINESS_HOURS");
    assert.ok(result.assumptions.length > 0, "it assumed the afternoon silently");
    assert.match(result.assumptions.join(" "), /afternoon/);
  });

  it("says the assumption out loud to the caller", async () => {
    const { say } = await liveSession();
    const heard = await say("We close at four on Saturdays now.");
    assert.match(heard.spoken, /I took "four" to mean the afternoon/);
  });

  it("ASKS rather than guessing when a time is genuinely ambiguous", async () => {
    const { say } = await liveSession();
    const heard = await say("We finish early on Saturday.");
    assert.equal(heard.clarificationRequested, true);
    assert.equal(heard.proposedChanges.length, 0, "it guessed");
    assert.match(heard.spoken, /What time/);
    assert.equal(heard.state, "clarifying");
  });
});

describe("P41B correction and negation", () => {
  it("replaces the earlier change rather than adding a contradictory second", async () => {
    const { say } = await liveSession();
    await say("We close at five on Saturdays now.");
    await say("We close at four on Saturdays now.");
    const done = await say("That's it.");
    assert.equal(done.changeCount, 1, "two contradictory changes survived");
    const live = done.proposedChanges.filter((c) => c.state === "confirmed");
    assert.equal(live.length, 1);
    assert.match(live[0].description, /16:00/);
    // The superseded one is kept, marked, not deleted.
    assert.ok(done.proposedChanges.some((c) => c.state === "superseded"));
  });

  it("handles \"no, I said four\" as a correction and asks what it should be", async () => {
    const { say } = await liveSession();
    await say("We close at five on Saturdays now.");
    const corrected = await say("No, I said four, not five.");
    assert.match(corrected.spoken, /what should/i);
    assert.equal(corrected.state, "clarifying");
  });

  it("drops the last change when the caller says don't", async () => {
    const { say } = await liveSession();
    await say("We close at four on Saturdays now.");
    const undone = await say("Undo that.");
    assert.equal(undone.proposedChanges.filter((c) => c.state === "confirmed" || c.state === "proposed").length, 0);
    assert.ok(undone.proposedChanges.some((c) => c.state === "rejected"));
  });

  it("keeps Sunday closed when the caller changes their mind about it", async () => {
    const { say } = await liveSession();
    await say("Sunday we are open nine to five.");
    const kept = await say("Actually keep Sunday closed.");
    // Either it proposed closed, or it asked. It must NOT hold both.
    const live = kept.proposedChanges.filter((c) => c.state === "confirmed" || c.state === "proposed");
    assert.ok(live.length <= 1, `${live.length} contradictory Sunday changes survived`);
  });
});

// ════════════════════════════════════════════════════════════════════
// P42 — PROPOSAL, CONFIRMATION, SUMMARY, FINISH
// ════════════════════════════════════════════════════════════════════

describe("P42 proposal and confirmation", () => {
  it("proposes a low-risk change without asking", async () => {
    const { say } = await liveSession();
    const heard = await say("We close at four on Saturdays now.");
    assert.equal(heard.change.state, "proposed");
    assert.equal(heard.change.awaitingConfirmation, false);
    assert.equal(heard.state, "collecting");
  });

  it("waits for a spoken yes before counting a high-risk change", async () => {
    const { say } = await liveSession();
    const heard = await say("We don't go to Frankston anymore.");
    assert.equal(heard.change.risk, "high");
    assert.equal(heard.change.awaitingConfirmation, true);
    assert.equal(heard.state, "confirming");
    assert.match(heard.spoken, /shall I go ahead/i);

    const confirmed = await say("Yes.");
    assert.equal(confirmed.proposedChanges.find((c) => c.risk === "high").state, "confirmed");
  });

  it("drops a high-risk change on a spoken no", async () => {
    const { say } = await liveSession();
    await say("We don't go to Frankston anymore.");
    const rejected = await say("No.");
    assert.equal(rejected.proposedChanges.find((c) => c.risk === "high").state, "rejected");
  });

  it("P42A — summarises from structured changes, not from remembered text", async () => {
    const { say } = await liveSession();
    await say("We close at four on Saturdays now.");
    await say("Stop quoting the call-out price.");
    const summary = await say("What have we changed?");
    assert.match(summary.summary, /Saturday hours become/);
    assert.match(summary.summary, /Pricing policy becomes/);
    assert.match(summary.summary, /haven't made any of this active/);
    // Every line traces to a change object.
    const bullets = summary.summary.split("\n").filter((l) => l.startsWith("•"));
    assert.equal(bullets.length, summary.proposedChanges.filter((c) => c.state !== "superseded" && c.state !== "rejected").length);
  });

  it("P42B — refuses to finish while a question is open", async () => {
    const { say } = await liveSession();
    await say("We finish early on Saturday.");
    const finish = await say("That's it.");
    assert.equal(finish.ok, false);
    assert.equal(finish.code, "unresolved_questions_remain");
    assert.equal(finish.draft, null);
    assert.match(finish.spoken, /Before I save this/);
  });

  it("P42B — refuses to finish with an unconfirmed high-risk change", async () => {
    const { say } = await liveSession();
    await say("We don't go to Frankston anymore.");
    const finish = await say("That's it.");
    assert.equal(finish.ok, false);
    assert.equal(finish.draft, null);
    assert.match(finish.spoken, /should I stop servicing Frankston/i);
  });

  it("P42B — creates a DRAFT and says a person must review it", async () => {
    const { say } = await liveSession();
    await say("We close at four on Saturdays now.");
    const done = await say("That's it.");
    assert.equal(done.state, "draft_created");
    assert.equal(done.draft.status, "draft");
    assert.equal(done.draft.requiresHumanApproval, true);
    assert.equal(done.draft.isLive, false);
    assert.match(done.spoken, /review and approve/);
    assert.equal(done.approved, false);
    assert.equal(done.active, false);
  });

  it("cannot continue after it has finished", async () => {
    const { say } = await liveSession();
    await say("We close at four on Saturdays now.");
    await say("That's it.");
    const after = await say("Actually also change Sunday.");
    assert.equal(after.ok, false);
    assert.equal(after.code, "session_is_closed");
  });

  it("saves nothing when nothing was agreed", async () => {
    const { say } = await liveSession();
    const done = await say("That's it.");
    assert.equal(done.ok, false);
    assert.equal(done.code, "nothing_was_confirmed");
    assert.equal(done.state, "cancelled");
    assert.equal(done.draft, null);
  });
});

// ════════════════════════════════════════════════════════════════════
// P45A — THE UI HANDOFF
// ════════════════════════════════════════════════════════════════════

describe("P45A UI handoff — a voice draft is a draft", () => {
  it("produces a version the UI renders exactly like a typed one", async () => {
    const { platform, say, clientId } = await liveSession();
    await say("We close at four on Saturdays now.");
    const done = await say("That's it.");

    const operator = P.operator(clientId);
    const got = await platform.configService.getVersion({ principal: operator, clientId, configVersion: done.draft.configVersion });
    assert.equal(got.ok, true);
    assert.equal(got.version.metadata.source, "voice");
    assert.equal(got.version.metadata.status, "draft");
    assert.ok(BLUEPRINT_STATUSES.includes(got.version.metadata.status));

    // The dashboard, history and review models all take it without special
    // casing. Byte-identical rendering is proven in the platform UI suite; here
    // we prove the SHAPE the UI needs is present.
    const VM = require("../src/platform/ui/ui-view-models");
    const history = VM.historyModel({
      clientId, principal: operator,
      versions: (await platform.configService.listVersions({ principal: operator, clientId })).versions,
    });
    const voiceRow = history.versions.find((v) => v.sourceKey === "voice");
    assert.ok(voiceRow, "the voice version does not appear in history");
    assert.equal(voiceRow.source, "Voice configuration agent");
    assert.equal(voiceRow.canEdit, true, "a voice draft must be editable like any other");
    assert.equal(voiceRow.isActive, false);

    const dashboard = VM.dashboardModel({
      clientId, principal: operator,
      active: (await platform.configService.getActive({ principal: operator, clientId })).version,
      draft: got.version,
    });
    assert.equal(dashboard.configuration.draftVersion, done.draft.configVersion);
    assert.equal(dashboard.configuration.hasOpenDraft, true);
  });

  it("puts the change on the review screen in words", async () => {
    const { platform, say, clientId } = await liveSession();
    await say("We close at four on Saturdays now.");
    const done = await say("That's it.");

    const operator = P.operator(clientId);
    const diff = await platform.configService.diff({ principal: operator, clientId, fromVersion: null, toVersion: done.draft.configVersion });
    const { presentDiff } = require("../src/platform/ui/ui-diff");
    const presented = presentDiff(diff.diff);

    const hours = presented.sections.find((s) => s.title === "Hours");
    assert.ok(hours, "the review screen shows no hours change");
    assert.equal(hours.changes[0].heading, "Saturday hours");
    // Only the closing time moved, so the review screen names which end it was
    // rather than reprinting an unchanged opening time as though it changed.
    assert.equal(hours.changes[0].before, "Close 12:00");
    assert.equal(hours.changes[0].after, "Close 16:00");
  });

  it("still requires a human to approve it", async () => {
    const { platform, say, clientId } = await liveSession();
    await say("We close at four on Saturdays now.");
    const done = await say("That's it.");

    // The voice principal cannot approve its own draft.
    const refused = await platform.configService.approve({
      principal: voicePrincipal({ clientId }), clientId, configVersion: done.draft.configVersion,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.outcome, "forbidden");

    // A named human can.
    await platform.configService.validate({ principal: P.editor(clientId), clientId, configVersion: done.draft.configVersion });
    const approved = await platform.configService.approve({
      principal: P.owner(clientId), clientId, configVersion: done.draft.configVersion, reason: "Read the diff.",
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));
  });
});

// ════════════════════════════════════════════════════════════════════
// P45 — THE SIMULATOR
// ════════════════════════════════════════════════════════════════════

describe("P45 simulator — local, deterministic, and unable to reach anything", () => {
  it("offers no live, model, approve, activate or provision flag", async () => {
    for (const [flag, why] of Object.entries(FORBIDDEN_FLAGS)) {
      const result = await runVoiceCommand({ argv: ["simulate", flag], scenarios: SCENARIOS });
      assert.equal(result.exitCode, 1, `${flag} was accepted`);
      assert.match(result.lines.join("\n"), new RegExp(`REFUSED: ${flag.replace(/-/g, "\\-")} does not exist`));
      assert.ok(why.length > 20, `${flag} has no reason`);
    }
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const result = await runVoiceCommand({ argv: ["simulate", "--nonsense", "x"], scenarios: SCENARIOS });
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join("\n"), /unknown flag/);
  });

  it("lists the golden transcripts", async () => {
    const result = await runVoiceCommand({ argv: ["scenarios"], scenarios: SCENARIOS });
    assert.equal(result.exitCode, 0);
    assert.match(result.lines.join("\n"), /locksmith-saturday-hours/);
    assert.match(result.lines.join("\n"), new RegExp(`${SCENARIOS.length} golden transcript`));
  });

  it("replays a transcript and ends at a draft", async () => {
    const now = clock();
    const platform = buildPlatform({ now });
    const version = await activate(platform.configService, "northside_locks", locksmithA());
    const result = await runVoiceCommand({
      argv: ["replay", "--scenario", "locksmith-saturday-hours"],
      platform: { ...platform, now, interpreter: createDeterministicInterpreter(), blueprint: version, hasActiveVersion: true },
      scenarios: SCENARIOS,
    });
    const out = result.lines.join("\n");
    assert.equal(result.exitCode, 0);
    assert.match(out, /Aida > /);
    assert.match(out, /state\s+draft_created/);
    assert.match(out, /approved\s+false\s+active\s+false/);
  });

  it("has no command that could approve, activate or provision", () => {
    assert.deepEqual([...COMMANDS].sort(), ["help", "replay", "scenarios", "simulate"]);
    assert.match(USAGE, /no --live, no --model, no --approve/);
    assert.match(USAGE, /ends at a DRAFT/);
  });

  it("the shell can build only a deterministic interpreter", () => {
    const shell = fs.readFileSync(path.join(ROOT, "scripts", "voice-config.js"), "utf8");
    assert.match(shell, /createDeterministicInterpreter/);
    const code = shell.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // Compared LITERALLY. "fetch(" is not a valid regular expression, and
    // building one from it threw instead of checking anything — so this sweep
    // was passing by crashing.
    for (const forbidden of ["openai", "anthropic", "retell", "twilio", "fetch(", "XMLHttpRequest", "https://"]) {
      assert.ok(!code.toLowerCase().includes(forbidden.toLowerCase()), `the shell mentions ${forbidden}`);
    }
    // Non-vacuity: the sweep is looking at real code.
    assert.ok(code.includes("createDeterministicInterpreter"));
    assert.ok(code.length > 1000, "the stripped shell is suspiciously small");
  });
});
