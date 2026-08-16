// AIDA VOICE CONFIGURATION — the session engine (P38, P41B, P42, P42A, P42B).
//
//   createVoiceSessionEngine({ configService, interpreter, store, now, audit })
//     .start({ principal, clientId, blueprint, hasActiveVersion })
//     .hear({ sessionId, transcript })
//     .summarise({ sessionId })
//     .finish({ sessionId })
//     .cancel({ sessionId })
//   createInMemoryVoiceSessionStore()
//
// ── WHAT THE ENGINE IS ──────────────────────────────────────────────
// The thing that turns a conversation into a reviewed draft, and refuses to
// turn it into anything else.
//
//   HEARD → INTERPRETED → PROPOSED → (CLARIFIED) → (CONFIRMED) → DRAFT
//
// Every arrow is a place something can stop. A sentence that was not understood
// stops at INTERPRETED and becomes a question. An ambiguous one stops at
// PROPOSED. A high-risk one stops until the caller says yes out loud. And the
// last arrow lands on a DRAFT — never on an approval, an activation or a
// provider.
//
// ── WHAT IT IS INJECTED, AND WHY ────────────────────────────────────
// It takes the configService, an interpreter and a clock. It imports no
// interpreter implementation, no provider, no executor and no HTTP surface —
// so the same engine runs against a scripted fixture in a test and against a
// language model one day, with nothing in between changing.
//
// It creates drafts by calling configService.proposePatch with a voice
// principal, which holds `config:propose` and nothing else. That is not a
// convention this file maintains: it is the only capability the role has, and
// approve/activate refuse it at the authority.

const V = require("./voice-session-model");
const I = require("./voice-intents");
const POLICY = require("./voice-policy");
const PLANNER = require("./voice-planner");
const { compileChangesToPatch } = require("./voice-patch-compiler");
const { voicePrincipal } = require("../config-access");

const SESSION_CODES = Object.freeze({
  OK: "ok",
  NO_SESSION: "no_such_session",
  CLOSED: "session_is_closed",
  UNRESOLVED: "unresolved_questions_remain",
  NOTHING_CONFIRMED: "nothing_was_confirmed",
  DRAFT_REFUSED: "configuration_service_refused_the_draft",
  INTERPRETER_FAILED: "interpretation_unavailable",
});

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });

// ════════════════════════════════════════════════════════════════════
// STORE
// ════════════════════════════════════════════════════════════════════

/**
 * Sessions live here. Deliberately in memory and deliberately behind a
 * contract: the durable artefact of a configuration call is the DRAFT, which
 * already belongs to the configuration subsystem and its own schema. A
 * conversation is scaffolding, and giving scaffolding a table before anybody
 * needs one is how a schema question gets answered by accident.
 */
function createInMemoryVoiceSessionStore() {
  const sessions = new Map();
  return Object.freeze({
    async get(sessionId) { return sessions.has(sessionId) ? JSON.parse(JSON.stringify(sessions.get(sessionId))) : null; },
    async put(session) { sessions.set(session.sessionId, JSON.parse(JSON.stringify(session))); return session; },
    async listForClient(clientId) {
      return [...sessions.values()].filter((s) => s.clientId === clientId).map((s) => JSON.parse(JSON.stringify(s)));
    },
    _size() { return sessions.size; },
  });
}

// ════════════════════════════════════════════════════════════════════
// ENGINE
// ════════════════════════════════════════════════════════════════════

function createVoiceSessionEngine({ configService, interpreter, store, now, audit = null, idSeed = 0 } = {}) {
  if (!configService) throw new Error("createVoiceSessionEngine requires a configService");
  if (!interpreter || typeof interpreter.interpretTurn !== "function") {
    throw new Error("createVoiceSessionEngine requires an interpreter with interpretTurn()");
  }
  if (!store) throw new Error("createVoiceSessionEngine requires a session store");
  if (typeof now !== "function") throw new Error("createVoiceSessionEngine requires an injected clock");

  let counter = idSeed;
  const nextId = (prefix) => `${prefix}_${String((counter += 1)).padStart(6, "0")}`;

  /** Safe audit only. No transcript, ever — see the privacy note in the docs. */
  async function record(eventType, session, metadata = {}) {
    if (!audit || typeof audit.append !== "function") return;
    for (const key of Object.keys(metadata)) {
      if (V.FORBIDDEN_AUDIT_KEYS.includes(key)) {
        throw new Error(`voice audit: "${key}" must never be recorded`);
      }
    }
    try {
      await audit.append({
        clientId: session.clientId,
        configVersion: session.baseConfigVersion ?? null,
        eventType,
        actor: session.actorId,
        actorRole: "voice_agent",
        source: "voice",
        metadata: { sessionId: session.sessionId, ...metadata },
      });
    } catch {
      // An audit sink being unavailable must not end a caller's session. The
      // session's own record of what it proposed is unaffected.
    }
  }

  const save = async (session) => {
    session.updatedAt = now().toISOString();
    await store.put(session);
    return session;
  };

  const speak = (session, text) => {
    session.turns.push(V.emptyTurn({ turnNumber: session.turns.length + 1, role: "assistant", text, at: now().toISOString() }));
    return text;
  };

  /** The reply shape every method returns: what to say, and what changed. */
  const reply = (session, spoken, extra = {}) =>
    Object.freeze({
      ok: true,
      sessionId: session.sessionId,
      state: session.state,
      spoken,
      proposedChanges: Object.freeze(session.proposedChanges.map((c) => Object.freeze({ ...c }))),
      unresolved: Object.freeze(session.unresolved.map((u) => Object.freeze({ ...u }))),
      refusals: Object.freeze(session.refusals.map((r) => Object.freeze({ ...r }))),
      draft: session.draft ? Object.freeze({ ...session.draft }) : null,
      // Repeated on every single reply, deliberately.
      approved: false,
      active: false,
      providerChanged: false,
      callingChanged: false,
      ...extra,
    });

  const openChanges = (session) => session.proposedChanges.filter((c) => c.state === "proposed" || c.state === "confirmed");
  const pendingHighRisk = (session) => session.proposedChanges.find((c) => c.state === "proposed" && c.awaitingConfirmation) || null;
  /** Questions that must be answered before a session may finish. */
  const blockingQuestions = (session) => (session.unresolved || []).filter((u) => u.blocking !== false);

  function transition(session, to) {
    const allowed = V.STATE_TRANSITIONS[session.state] || [];
    if (!allowed.includes(to)) {
      throw new Error(`voice session: ${session.state} -> ${to} is not a transition this session may make`);
    }
    session.state = to;
  }

  /** After anything happens, what state should the session be in? */
  function settle(session) {
    if (V.TERMINAL_STATES.includes(session.state)) return;
    if (blockingQuestions(session).length > 0) { if (session.state !== "clarifying") transition(session, "clarifying"); return; }
    if (pendingHighRisk(session)) { if (session.state !== "confirming") transition(session, "confirming"); return; }
    if (session.state !== "collecting") transition(session, "collecting");
  }

  // ── the spoken summary, generated from structured changes ──────────

  function summaryOf(session) {
    const counted = session.proposedChanges.filter((c) => c.state === "confirmed" || (c.state === "proposed" && !c.awaitingConfirmation));
    const waiting = session.proposedChanges.filter((c) => c.state === "proposed" && c.awaitingConfirmation);

    const lines = [];
    if (counted.length === 0 && waiting.length === 0) {
      lines.push("We haven't changed anything yet.");
    } else {
      lines.push("Here are the changes we've discussed:");
      for (const c of counted) lines.push(`• ${c.description}`);
      for (const c of waiting) lines.push(`• ${c.description} — I still need you to confirm that one`);
    }
    if (session.unresolved.length) {
      lines.push("There's still something I need from you:");
      for (const u of session.unresolved) lines.push(`• ${u.question}`);
    }
    if (session.refusals.length) {
      lines.push(`I couldn't do ${session.refusals.length === 1 ? "one thing" : `${session.refusals.length} things`} you asked about — ${session.refusals.map((r) => r.reason.replace(/_/g, " ")).join(", ")}.`);
    }
    lines.push("I haven't made any of this active. It'll be saved as a draft for somebody to review.");
    return lines.join("\n");
  }

  // ── proposing ──────────────────────────────────────────────────────

  function propose(session, interp) {
    const risk = I.riskOf(interp.intent);
    const description = I.describeIntent(interp.intent, interp.payload || {});
    const spokenPhrase = I.describeIntentSpoken(interp.intent, interp.payload || {});
    const needsConfirmation = V.requiresSpokenConfirmation(risk);

    const change = {
      changeId: nextId("chg"),
      intent: interp.intent,
      payload: interp.payload,
      section: I.sectionOf(interp.intent),
      risk,
      description,
      spokenPhrase,
      state: "proposed",
      awaitingConfirmation: needsConfirmation,
      assumptions: [...(interp.assumptions || [])],
      fromTurn: interp.transcriptRef,
      supersedes: null,
    };

    // A later change to the same thing replaces the earlier one rather than
    // sitting beside it. Two contradictory patches for one path is how a
    // caller's correction becomes a coin toss.
    const previous = session.proposedChanges.find(
      (c) => (c.state === "proposed" || c.state === "confirmed") && sameTarget(c, change),
    );
    if (previous) {
      previous.state = "superseded";
      previous.supersededBy = change.changeId;
      change.supersedes = previous.changeId;
    }

    session.proposedChanges.push(change);
    if (change.section && !session.coveredTopics.includes(change.section)) session.coveredTopics.push(change.section);
    return change;
  }

  /** Two changes target the same thing if they would write the same place. */
  function sameTarget(a, b) {
    if (a.intent !== b.intent) return false;
    const pa = a.payload || {};
    const pb = b.payload || {};
    if (a.intent === "SET_BUSINESS_HOURS" || a.intent === "SET_DAY_CLOSED") return pa.day === pb.day;
    if (a.intent === "ADD_SERVICE" || a.intent === "REMOVE_SERVICE" || a.intent === "UPDATE_SERVICE") {
      return String(pa.name || pa.serviceRef || "").toLowerCase() === String(pb.name || pb.serviceRef || "").toLowerCase();
    }
    if (a.intent === "EXCLUDE_SERVICE_AREA") {
      return JSON.stringify((pa.suburbs || []).map((s) => s.toLowerCase()).sort()) ===
             JSON.stringify((pb.suburbs || []).map((s) => s.toLowerCase()).sort());
    }
    // Single-valued settings: one per section is the whole target.
    return ["SET_PRICING_POLICY", "SET_GREETING", "SET_CALLBACK_POLICY", "SET_AFTER_HOURS_POLICY",
      "SET_BOOKING_SETTING", "SET_COMPLIANCE_WORDING", "SET_VOICE_PREFERENCE",
      "SET_CALLER_INFORMATION", "SET_TRANSFER_RULE", "SET_BUSINESS_IDENTITY"].includes(a.intent);
  }

  // ════════════════════════════════════════════════════════════════════

  return Object.freeze({
    async start({ principal, clientId, blueprint = null, hasActiveVersion = false, baseConfigVersion = null } = {}) {
      // The tenant is bound HERE, from the authorised caller, and never again.
      const session = V.emptySession({
        sessionId: nextId("vcs"),
        clientId,
        actorId: (principal && principal.actorId) || "voice caller",
        baseConfigVersion,
        mode: PLANNER.detectSessionMode({ blueprint, hasActiveVersion }),
        startedAt: now().toISOString(),
      });
      session.blueprintSnapshot = blueprint ? JSON.parse(JSON.stringify(blueprint)) : null;

      const opening = session.mode === "setup"
        ? "Let's get your assistant set up. I'll ask a few things, and nothing goes live until somebody at your business reviews it."
        : "What would you like to change?";
      speak(session, opening);

      const question = PLANNER.planNextQuestion({ blueprint, mode: session.mode, coveredTopics: [] });
      if (question) { speak(session, question.question); session.currentTopic = question.topic; }

      await save(session);
      await record("voice_session_started", session, { mode: session.mode });
      return reply(session, question ? `${opening}\n${question.question}` : opening, { question: question || null });
    },

    /** One caller turn. The whole conversational contract lives here. */
    async hear({ sessionId, transcript } = {}) {
      const session = await store.get(sessionId);
      if (!session) return fail(SESSION_CODES.NO_SESSION, "no such session");
      if (V.TERMINAL_STATES.includes(session.state)) {
        return fail(SESSION_CODES.CLOSED, `this session is ${session.state} and cannot continue`);
      }

      session.turns.push(V.emptyTurn({
        turnNumber: session.turns.length + 1, role: "caller", text: transcript, at: now().toISOString(),
      }));
      const turnNumber = session.turns.length;

      // ── interpret ──
      let interp;
      try {
        interp = await interpreter.interpretTurn({
          transcript,
          context: {
            turnNumber,
            clientId: session.clientId,
            mode: session.mode,
            awaitingAnswerFor: session.unresolved.length ? session.unresolved[0].topic : session.currentTopic,
            currentHours: (session.blueprintSnapshot && session.blueprintSnapshot.hours && session.blueprintSnapshot.hours.weekly) || null,
          },
        });
      } catch {
        // A dead interpreter is not a reason to guess. Ask again.
        const spoken = speak(session, "Sorry — I didn't catch that. Could you say it again?");
        await save(session);
        return reply(session, spoken, { interpreterFailed: true });
      }
      session.turns[turnNumber - 1].interpretation = summariseInterpretation(interp);

      // ── the guard, on BOTH the intent and the raw words ──
      const verdict = POLICY.assessRequest({ intent: interp.intent, payload: interp.payload || {}, transcript, session });
      if (!verdict.allowed) {
        session.refusals.push({
          reason: verdict.refusal.reason,
          detail: verdict.refusal.detail,
          owner: verdict.refusal.owner,
          fromTurn: turnNumber,
        });
        const spoken = speak(session, `${verdict.spoken} Is there anything about how AIDA answers your calls that I can change?`);
        settle(session);
        await save(session);
        await record("voice_change_blocked", session, { reason: verdict.refusal.reason });
        return reply(session, spoken, { refused: true, refusalReason: verdict.refusal.reason });
      }

      // ── conversational intents ──
      switch (interp.intent) {
        case "CANCEL": {
          transition(session, "cancelled");
          const spoken = speak(session, "No problem — I've stopped there and nothing has been saved.");
          await save(session);
          await record("voice_session_cancelled", session, {});
          return reply(session, spoken);
        }

        case "CONFIRM": {
          const waiting = pendingHighRisk(session);
          if (!waiting) {
            const spoken = speak(session, "Thanks. What else would you like to change?");
            settle(session); await save(session);
            return reply(session, spoken);
          }
          waiting.state = "confirmed";
          waiting.awaitingConfirmation = false;
          waiting.confirmedAtTurn = turnNumber;
          settle(session);
          const next = PLANNER.planNextQuestion({
            blueprint: session.blueprintSnapshot, mode: session.mode,
            coveredTopics: session.coveredTopics, unresolved: session.unresolved,
            pendingConfirmation: pendingConfirmationPrompt(session),
          });
          const spoken = speak(session, next ? `Done. ${next.question}` : "Done. Anything else?");
          await save(session);
          await record("voice_change_confirmed", session, { changeId: waiting.changeId, intent: waiting.intent, risk: waiting.risk });
          return reply(session, spoken);
        }

        case "REJECT":
        case "UNDO_PROPOSED_CHANGE": {
          const target = pendingHighRisk(session) || [...session.proposedChanges].reverse().find((c) => c.state === "proposed" || c.state === "confirmed");
          if (!target) {
            const spoken = speak(session, "Nothing to undo — we haven't changed anything yet. What would you like to do?");
            settle(session); await save(session);
            return reply(session, spoken);
          }
          target.state = "rejected";
          target.awaitingConfirmation = false;
          settle(session);
          const spoken = speak(session, `Right — I've dropped that. ${session.proposedChanges.some((c) => c.state === "confirmed" || c.state === "proposed") ? "Anything else?" : "What would you like to change?"}`);
          await save(session);
          await record("voice_change_rejected", session, { changeId: target.changeId, intent: target.intent });
          return reply(session, spoken);
        }

        case "ASK_WHAT_WILL_CHANGE":
        case "ASK_WHAT_IS_CONFIGURED": {
          if (session.state !== "reviewing" && !V.TERMINAL_STATES.includes(session.state)) transition(session, "reviewing");
          const text = summaryOf(session);
          session.summaryText = text;
          const spoken = speak(session, text);
          settle(session);
          await save(session);
          return reply(session, spoken, { summary: text });
        }

        case "FINISH_CONFIGURATION":
          return this.finish({ sessionId });

        case "CORRECT": {
          // A correction with no new content: ask what it should be instead of
          // guessing which of several changes was meant.
          const last = [...session.proposedChanges].reverse().find((c) => c.state === "proposed" || c.state === "confirmed");
          if (!last) {
            const spoken = speak(session, "Sorry — what would you like it to be?");
            settle(session); await save(session);
            return reply(session, spoken);
          }
          session.unresolved.push({
            id: nextId("q"), topic: last.section,
            question: `Sorry — what should ${last.description.toLowerCase()} be instead?`,
            blocking: true,
            fromTurn: turnNumber, correcting: last.changeId,
          });
          settle(session);
          const spoken = speak(session, session.unresolved[session.unresolved.length - 1].question);
          await save(session);
          await record("voice_clarification_requested", session, { topic: last.section || null });
          return reply(session, spoken);
        }

        case "SMALL_TALK": {
          const spoken = speak(session, "Happy to chat, but I'm best at the setup. What would you like to change?");
          settle(session); await save(session);
          return reply(session, spoken);
        }

        default: break;
      }

      // ── unknown, or ambiguous: ASK. Never guess. ──
      if (interp.intent === I.UNKNOWN_INTENT || (interp.ambiguities && interp.ambiguities.length)) {
        const question = (interp.ambiguities && interp.ambiguities[0] && interp.ambiguities[0].question)
          || interp.clarificationRequest
          || "Sorry — could you say that another way?";

        // An answer to something already asked replaces the question rather
        // than stacking a second one on top of it.
        if (session.unresolved.length && interp.intent === I.UNKNOWN_INTENT && !interp.ambiguities.length) {
          session.unresolved[0].attempts = (session.unresolved[0].attempts || 0) + 1;
        } else {
          // A question raised by a REAL ambiguity blocks finishing: AIDA
          // understood a change and needs one detail to get it right.
          //
          // A question raised because a sentence was not understood at all does
          // NOT block. Somebody remarking on the weather should not leave a
          // caller unable to end the call, and treating "I didn't follow that"
          // as a required answer is how a session becomes impossible to finish.
          const blocking = Boolean(interp.ambiguities && interp.ambiguities.length);
          session.unresolved.push({
            id: nextId("q"),
            topic: (interp.ambiguities && interp.ambiguities[0] && interp.ambiguities[0].field) || session.currentTopic,
            question,
            options: (interp.ambiguities && interp.ambiguities[0] && interp.ambiguities[0].options) || [],
            blocking,
            fromTurn: turnNumber,
          });
        }
        settle(session);
        const spoken = speak(session, question);
        await save(session);
        await record("voice_clarification_requested", session, { topic: session.currentTopic || null });
        return reply(session, spoken, { clarificationRequested: true });
      }

      // ── a configuration intent that survived everything ──
      if (!I.isConfigurationIntent(interp.intent)) {
        const spoken = speak(session, "I'm not sure what to do with that. What would you like to change?");
        settle(session); await save(session);
        return reply(session, spoken);
      }

      // An answer arriving resolves the question it answers.
      if (session.unresolved.length) {
        const resolvedQuestion = session.unresolved.shift();
        if (resolvedQuestion.correcting) {
          const original = session.proposedChanges.find((c) => c.changeId === resolvedQuestion.correcting);
          if (original && (original.state === "proposed" || original.state === "confirmed")) {
            original.state = "superseded";
          }
        }
      }

      const change = propose(session, interp);
      settle(session);

      const assumptionNote = change.assumptions.length ? ` (I ${change.assumptions.join(", and ")}.)` : "";
      const confirmNote = change.awaitingConfirmation
        ? ` That's a bigger one — shall I go ahead with it?`
        : "";
      const next = !change.awaitingConfirmation
        ? PLANNER.planNextQuestion({
          blueprint: session.blueprintSnapshot, mode: session.mode,
          coveredTopics: session.coveredTopics, unresolved: session.unresolved,
        })
        : null;

      const spoken = speak(session,
        `I'll ${change.spokenPhrase}.${assumptionNote}${confirmNote}${next ? ` ${next.question}` : (change.awaitingConfirmation ? "" : " Anything else?")}`);
      if (next) session.currentTopic = next.topic;

      await save(session);
      await record("voice_change_proposed", session, { changeId: change.changeId, intent: change.intent, risk: change.risk, section: change.section });
      return reply(session, spoken, { change: Object.freeze({ ...change }) });
    },

    async summarise({ sessionId } = {}) {
      const session = await store.get(sessionId);
      if (!session) return fail(SESSION_CODES.NO_SESSION, "no such session");
      const text = summaryOf(session);
      session.summaryText = text;
      await save(session);
      return reply(session, text, { summary: text });
    },

    /**
     * The end of the call. Refuses while anything is unresolved, then hands the
     * confirmed changes to the CONFIGURATION AUTHORITY as a patch. That call is
     * the only write this whole subsystem performs, and it produces a DRAFT.
     */
    async finish({ sessionId } = {}) {
      const session = await store.get(sessionId);
      if (!session) return fail(SESSION_CODES.NO_SESSION, "no such session");
      if (V.TERMINAL_STATES.includes(session.state)) {
        return fail(SESSION_CODES.CLOSED, `this session is already ${session.state}`);
      }

      // 1 & 2: summarise, and say what is still open.
      const summary = summaryOf(session);
      session.summaryText = summary;

      // 3: refuse to finish on an unresolved ambiguity — a REQUIRED one.
      const blocking = blockingQuestions(session);
      if (blocking.length > 0) {
        const question = blocking[0].question;
        settle(session);
        const spoken = speak(session, `Before I save this — ${lowerFirst(question)}`);
        await save(session);
        return Object.freeze({
          ...fail(SESSION_CODES.UNRESOLVED, "an unresolved question remains"),
          sessionId, state: session.state, spoken,
          unresolved: Object.freeze(session.unresolved.map((u) => Object.freeze({ ...u }))),
          draft: null, approved: false, active: false,
        });
      }

      // A high-risk change nobody confirmed is not a change.
      const waiting = pendingHighRisk(session);
      if (waiting) {
        const spoken = speak(session, `Before I save this — should I ${waiting.spokenPhrase}?`);
        await save(session);
        return Object.freeze({
          ...fail(SESSION_CODES.UNRESOLVED, "a high-risk change was never confirmed"),
          sessionId, state: session.state, spoken,
          awaitingConfirmation: Object.freeze({ ...waiting }),
          draft: null, approved: false, active: false,
        });
      }

      // Low and medium changes count as confirmed by not being objected to;
      // high ones never reach here unconfirmed.
      for (const c of session.proposedChanges) {
        if (c.state === "proposed" && !c.awaitingConfirmation) c.state = "confirmed";
      }

      const confirmed = session.proposedChanges.filter((c) => c.state === "confirmed");
      if (confirmed.length === 0) {
        transition(session, "cancelled");
        const spoken = speak(session, "We didn't end up changing anything, so there's nothing to save. Thanks for calling.");
        await save(session);
        await record("voice_session_cancelled", session, { reason: "nothing_confirmed" });
        return Object.freeze({
          ...fail(SESSION_CODES.NOTHING_CONFIRMED, "no confirmed changes"),
          sessionId, state: session.state, spoken, draft: null, approved: false, active: false,
        });
      }

      transition(session, "ready_to_create_draft");

      // 4: through the EXISTING configuration authority, with a principal that
      //    holds config:propose and nothing else.
      const compiled = compileChangesToPatch({
        changes: confirmed,
        blueprint: session.blueprintSnapshot,
        reason: `Proposed in a voice configuration session (${session.sessionId}) and confirmed by the caller.`,
      });
      if (!compiled.ok) {
        const spoken = speak(session, "I couldn't turn that into a change I can save. Nothing has been altered.");
        settle(session);
        await save(session);
        return Object.freeze({
          ...fail(SESSION_CODES.NOTHING_CONFIRMED, compiled.message),
          sessionId, state: session.state, spoken, draft: null, approved: false, active: false,
        });
      }

      const principal = voicePrincipal({ clientId: session.clientId, actorId: session.actorId });
      const result = await configService.proposePatch({
        principal,
        clientId: session.clientId,          // the session's own client. Never from a transcript.
        patch: compiled.patch,
        source: "voice",
      });

      if (!result.ok) {
        settle(session);
        const spoken = speak(session, "I couldn't save that as a draft. Nothing has been changed, and somebody will need to look at it.");
        await save(session);
        return Object.freeze({
          ...fail(SESSION_CODES.DRAFT_REFUSED, result.message || "the configuration service refused"),
          sessionId, state: session.state, spoken,
          serviceCode: result.code || null, draft: null, approved: false, active: false,
        });
      }

      session.draft = Object.freeze({
        configVersion: result.configVersion,
        status: result.status || (result.version && result.version.metadata && result.version.metadata.status) || "draft",
        requiresHumanApproval: true,
        isLive: false,
      });
      transition(session, "draft_created");

      const spoken = speak(session,
        `${summary}\nI've saved that as draft version ${result.configVersion}. Somebody at your business needs to review and approve it before it changes how your calls are answered.`);
      await save(session);
      await record("voice_draft_created", session, {
        configVersion: result.configVersion, changeCount: confirmed.length, operationCount: compiled.operationCount,
      });

      return reply(session, spoken, {
        summary,
        draft: session.draft,
        changeCount: confirmed.length,
        operationCount: compiled.operationCount,
        requiresHumanApproval: true,
      });
    },

    async cancel({ sessionId, reason = null } = {}) {
      const session = await store.get(sessionId);
      if (!session) return fail(SESSION_CODES.NO_SESSION, "no such session");
      if (V.TERMINAL_STATES.includes(session.state)) return fail(SESSION_CODES.CLOSED, `already ${session.state}`);
      transition(session, "cancelled");
      const spoken = speak(session, "I've stopped there. Nothing was saved.");
      await save(session);
      await record("voice_session_cancelled", session, reason ? { reason } : {});
      return reply(session, spoken);
    },

    async get({ sessionId } = {}) {
      const session = await store.get(sessionId);
      return session ? Object.freeze(session) : null;
    },
  });
}

/** What is kept on a turn: the meaning, not the words twice over. */
const summariseInterpretation = (interp) => Object.freeze({
  intent: interp.intent,
  confidence: interp.confidence,
  ambiguityCount: (interp.ambiguities || []).length,
  assumptionCount: (interp.assumptions || []).length,
  rejected: interp.rejected || null,
});

const pendingConfirmationPrompt = (session) => {
  const waiting = session.proposedChanges.find((c) => c.state === "proposed" && c.awaitingConfirmation);
  return waiting ? { topic: waiting.section, question: `${waiting.description}. Shall I go ahead with that?` } : null;
};

const lowerFirst = (s) => (typeof s === "string" && s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

module.exports = { createVoiceSessionEngine, createInMemoryVoiceSessionStore, SESSION_CODES };
