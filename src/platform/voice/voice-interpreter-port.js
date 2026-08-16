// AIDA VOICE CONFIGURATION — the interpretation port (P41, P41A).
//
//   interpretation({ ... })            the result shape, validated
//   createDeterministicInterpreter()   the one used by every test
//   createScriptedInterpreter(script)  fixture playback for transcripts
//   createRefusingInterpreter()        proves the engine handles a dead port
//   INTERPRETER_CONTRACT               what a real adapter must satisfy
//
// ── THE PORT ────────────────────────────────────────────────────────
//
//   interpretTurn({ transcript, context }) -> Interpretation
//
// One method. The session engine knows nothing else about how meaning is
// extracted, and a test asserts the engine imports no interpreter
// implementation at all — it takes one by injection, exactly as the
// provisioning executor takes a provider adapter.
//
// ── WHY NO REAL MODEL, AND WHAT THAT COSTS ──────────────────────────
// There is no OpenAI, no Anthropic, no Retell and no model name anywhere in
// this subsystem. That is not caution for its own sake: an engine written
// against a real model gets tested against a real model, which means it gets
// tested rarely, slowly, non-deterministically and only when somebody is
// holding a key.
//
// What is honest about it: the DETERMINISTIC interpreter below understands the
// phrasings its patterns cover and nothing else. It is not a language
// understander and this file does not pretend it is. Every metric in the
// evaluation harness measures the SESSION ENGINE — the state machine, the
// guards, the confirmation rules, the patch compilation — against fixed
// interpretations. None of them is an "AI accuracy" number, because there is
// no AI here to be accurate.
//
// ── CONFIDENCE IS NOT PERMISSION ────────────────────────────────────
// An interpretation carries a confidence, and the engine uses it to decide
// whether to ASK. It never uses it to decide whether a change may skip
// confirmation: risk decides that, and risk is declared per intent. A model
// that is confidently wrong about a transfer number is the exact failure this
// separation exists for.

const { ALL_INTENTS, UNKNOWN_INTENT, validateIntentPayload, isConfigurationIntent } = require("./voice-intents");
const { DAYS, URGENCY_LEVELS } = require("../client-blueprint");

/** What every adapter — fake, scripted, or one day a real model — must return. */
const INTERPRETER_CONTRACT = Object.freeze({
  method: "interpretTurn({ transcript, context }) -> Interpretation",
  returns: Object.freeze({
    intent: "one of ALL_INTENTS. Anything unrecognised is UNKNOWN_INTENT, never a guess.",
    payload: "validated against the intent's contract, or null for conversational intents",
    confidence: "0..1. Drives whether to ASK. Never authorises a change.",
    ambiguities: "[{ field, question, options? }] — each becomes a spoken question",
    assumptions: "[string] — anything filled in that the caller did not say. Surfaced, never silent.",
    clarificationRequest: "the single question to ask, when the turn cannot be acted on",
    transcriptRef: "which turn this came from",
  }),
  mustNot: Object.freeze([
    "return an intent outside ALL_INTENTS",
    "return a payload that fails validateIntentPayload",
    "invent a value the caller did not say without listing it in assumptions",
    "use confidence to bypass confirmation of a high-risk change",
    "read or write configuration — it interprets words and nothing else",
  ]),
});

const clamp01 = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Build a validated interpretation. Anything malformed collapses to
 * UNKNOWN_INTENT with the reason attached — which leads to a question. A
 * malformed interpretation must never become a silent no-op, because a caller
 * whose sentence vanished says it again and assumes it worked.
 */
function interpretation({
  intent = UNKNOWN_INTENT, payload = null, confidence = 0,
  ambiguities = [], assumptions = [], clarificationRequest = null,
  transcriptRef = null, note = null,
} = {}) {
  const problems = [];

  if (!ALL_INTENTS.includes(intent)) {
    problems.push(`"${intent}" is not an intent this system models`);
  }
  if (isConfigurationIntent(intent)) {
    const check = validateIntentPayload(intent, payload || {});
    if (!check.ok) problems.push(...check.errors.map((e) => `${e.field}: ${e.message}`));
  }

  if (problems.length) {
    return Object.freeze({
      intent: UNKNOWN_INTENT,
      payload: null,
      confidence: 0,
      ambiguities: Object.freeze([]),
      assumptions: Object.freeze([]),
      clarificationRequest: "I didn't quite catch that — could you say it another way?",
      transcriptRef,
      rejected: Object.freeze(problems),
      note,
    });
  }

  return Object.freeze({
    intent,
    payload: payload ? Object.freeze({ ...payload }) : null,
    confidence: clamp01(confidence),
    ambiguities: Object.freeze(ambiguities.map((a) => Object.freeze({ ...a }))),
    assumptions: Object.freeze([...assumptions]),
    clarificationRequest,
    transcriptRef,
    rejected: null,
    note,
  });
}

// ════════════════════════════════════════════════════════════════════
// THE DETERMINISTIC INTERPRETER
// ════════════════════════════════════════════════════════════════════

const WORD_NUMBER = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
});

/** "four", "4pm", "16:00", "half four" -> "16:00". Returns null rather than guessing. */
function parseTime(text, { assumeAfternoon = true } = {}) {
  if (typeof text !== "string") return null;
  const t = text.toLowerCase();

  const hhmm = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?\b/);
  if (hhmm) {
    let h = Number(hhmm[1]);
    const m = hhmm[2];
    if (hhmm[3] === "pm" && h < 12) h += 12;
    if (hhmm[3] === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }

  const oclock = t.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm|o'?clock)?\b/);
  if (oclock) {
    let h = /^\d+$/.test(oclock[1]) ? Number(oclock[1]) : WORD_NUMBER[oclock[1]];
    if (!Number.isFinite(h) || h > 23) return null;
    const marker = oclock[2];
    if (marker === "pm" && h < 12) h += 12;
    else if (marker === "am" && h === 12) h = 0;
    else if (!marker || marker.includes("clock")) {
      // No am/pm. A business closing "at four" means the afternoon; saying so
      // out loud is what `assumptions` is for.
      if (assumeAfternoon && h >= 1 && h <= 11) h += 12;
    }
    return `${String(h).padStart(2, "0")}:00`;
  }
  return null;
}

const dayIn = (text) => DAYS.find((d) => new RegExp(`\\b${d}s?\\b`, "i").test(text)) || null;

/** Split "blocked drains, burst pipes, taps and hot water" into four. */
function splitList(text) {
  return String(text)
    .split(/,| and | & |\/|\bplus\b/i)
    .map((s) => s.replace(/^\s*(we do|we handle|we also do|also)\s*/i, "").trim())
    .map((s) => s.replace(/[.!?]+$/, "").trim())
    .filter((s) => s.length > 1 && s.length < 80);
}

const TITLE = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * A small, honest rule-based interpreter.
 *
 * It handles the phrasings the fixtures use and returns UNKNOWN_INTENT for
 * everything else — which is the correct behaviour, not a limitation to be
 * apologised for. The engine's job is to ask when it does not know, and this is
 * how that path gets exercised.
 */
function createDeterministicInterpreter({ assumeAfternoon = true } = {}) {
  return Object.freeze({
    name: "deterministic",
    isFake: true,

    async interpretTurn({ transcript, context = {} } = {}) {
      const raw = String(transcript || "").trim();
      const t = raw.toLowerCase();
      const ref = context.turnNumber ?? null;
      const say = (o) => interpretation({ ...o, transcriptRef: ref });

      if (!raw) return say({ intent: UNKNOWN_INTENT, clarificationRequest: "Sorry, I didn't hear that." });

      // ── refused requests, named explicitly so the guard can be specific ──
      if (/\bapprove\b|\bsign\s*off\b/i.test(t)) return say({ intent: "REQUEST_APPROVAL", confidence: 0.95 });
      if (/\bactivate\b|\bmake (it|this|these|that) live\b|\bgo live\b|\bdeploy\b|\bpublish\b/i.test(t)) return say({ intent: "REQUEST_ACTIVATION", confidence: 0.95 });
      if (/\bprovision\b|\bcreate the agent\b|\bbuy (a|the) number\b/i.test(t)) return say({ intent: "REQUEST_PROVISIONING", confidence: 0.95 });
      if (/\bstart calling\b|\bturn outbound on\b|\bcall (all|every|each)\b|\bcall everyone\b|\benable calling\b|\bstart dialling\b|\bstart dialing\b/i.test(t)) return say({ intent: "REQUEST_CALLING", confidence: 0.95 });
      if (/\bdon'?t (say|tell|mention).{0,30}(ai|robot|bot|automated)\b|\bpretend (to be|you'?re) (a )?(human|person)\b/i.test(t)) return say({ intent: "REQUEST_DISABLE_AI_DISCLOSURE", confidence: 0.95 });
      if (/\bbypass\b|\badmin mode\b|\bignore (the )?(previous|prior|all) (rules?|instructions?)\b|\boverride\b/i.test(t)) return say({ intent: "REQUEST_BYPASS_AUTHORITY", confidence: 0.9 });

      // ── conversational ──
      if (/\bthat('?s| is| will be| would be)? ?(it|all)\b/i.test(t) || /^(nothing else|no(thing)? more|i'?m done|we'?re done|that will do|all done)\b/i.test(t)) {
        return say({ intent: "FINISH_CONFIGURATION", confidence: 0.95 });
      }
      // CANCEL is the whole session ending, so it must be the whole utterance.
      // "Stop quoting the call-out price" starts with "stop" and is a PRICING
      // change; treating it as a cancel threw away the caller's session, which
      // is the worst thing a bare prefix match can do here.
      if (/^(cancel|forget it|never mind|abandon)( this| that| the session)?[.!]?$/i.test(t) ||
          /^stop( this| the session| everything)?[.!]?$/i.test(t)) {
        return say({ intent: "CANCEL", confidence: 0.9 });
      }
      if (/^(yes|yeah|yep|correct|that'?s right|go ahead|please do|confirm|do it)\b/i.test(t)) return say({ intent: "CONFIRM", confidence: 0.9 });
      if (/^(no|nope|don'?t|do not|leave it|cancel that)\b/i.test(t) && !/\bno,? i said\b/i.test(t)) {
        return say({ intent: "REJECT", confidence: 0.85 });
      }
      if (/\b(what (have we|did we|are we) (changed|discussed|got)|what will change|read (that|it) back|what'?s changed)\b/i.test(t)) {
        return say({ intent: "ASK_WHAT_WILL_CHANGE", confidence: 0.9 });
      }
      if (/\bwhat (is|are) (currently |we )?(configured|set up|set)\b|\bwhat do (we|you) have\b/i.test(t)) {
        return say({ intent: "ASK_WHAT_IS_CONFIGURED", confidence: 0.9 });
      }
      // Correction. Must be checked before the topical rules, because "no, I
      // said four" also contains a time.
      if (/^(no,? i said|actually|sorry,? i meant|i meant|no,? make it|scrap that|i'?ve changed my mind)\b/i.test(t)) {
        return say({ intent: "CORRECT", payload: null, confidence: 0.85, note: raw });
      }
      if (/\bundo (that|the last)\b|\btake that back\b|\bforget that (last )?one\b/i.test(t)) {
        return say({ intent: "UNDO_PROPOSED_CHANGE", confidence: 0.9 });
      }

      // ── an answer to what the planner just asked ─────────────────
      // "Blocked drains, burst pipes, taps and hot water" is a complete
      // sentence to a person who was just asked what jobs they do, and noise to
      // anybody else. Context is what makes the difference, so the interpreter
      // is told what was asked rather than guessing from the words alone.
      if (context.awaitingAnswerFor === "services" && !dayIn(t)) {
        const names = splitList(raw);
        if (names.length === 1) {
          return say({ intent: "ADD_SERVICE", payload: { name: TITLE(names[0]) }, confidence: 0.8 });
        }
        if (names.length > 1) {
          return say({
            intent: UNKNOWN_INTENT, confidence: 0.6,
            ambiguities: [{ field: "urgency", question: "Which of those should be treated as urgent after hours?", options: names.map(TITLE) }],
            clarificationRequest: "Which of those should be treated as urgent after hours?",
            note: JSON.stringify({ services: names.map(TITLE) }),
          });
        }
      }
      if (context.awaitingAnswerFor === "serviceArea" && !dayIn(t)) {
        const suburbs = splitList(raw).map(TITLE);
        if (suburbs.length) return say({ intent: "SET_SERVICE_AREA", payload: { suburbs }, confidence: 0.75 });
      }

      // ── hours ──
      const day = dayIn(t);
      if (day && /\b(closed|shut|don'?t open|not open)\b/i.test(t)) {
        return say({ intent: "SET_DAY_CLOSED", payload: { day }, confidence: 0.9 });
      }
      if (day && /\b(clos(e|ing)|finish(ing)?|shut|until|till|to)\b/i.test(t)) {
        const close = parseTime(t, { assumeAfternoon });
        if (!close) {
          return say({
            intent: UNKNOWN_INTENT, confidence: 0.4,
            ambiguities: [{ field: "periods", question: `What time would you like ${TITLE(day)} calls treated as after-hours?` }],
            clarificationRequest: `What time would you like ${TITLE(day)} calls treated as after-hours?`,
          });
        }
        const open = (context.currentHours && context.currentHours[day] && context.currentHours[day].open) || "09:00";
        const assumptions = [];
        if (!/\bam\b|\bpm\b|:\d\d/.test(t)) assumptions.push(`took "${(t.match(/\b(\d{1,2}|four|five|three|two|one|six)\b/) || [])[0] || "that"}" to mean the afternoon`);
        if (!(context.currentHours && context.currentHours[day] && context.currentHours[day].open)) {
          assumptions.push(`kept the existing opening time`);
        }
        return say({
          intent: "SET_BUSINESS_HOURS",
          payload: { day, periods: [{ start: open, end: close }] },
          confidence: 0.8, assumptions,
        });
      }
      // "We finish early Saturday" — a real ambiguity, and the founder's own
      // example of what must NOT be guessed.
      if (day && /\b(early|earlier|late|later)\b/i.test(t)) {
        return say({
          intent: UNKNOWN_INTENT, confidence: 0.3,
          ambiguities: [{ field: "periods", question: `What time would you like ${TITLE(day)} calls treated as after-hours?` }],
          clarificationRequest: `What time would you like ${TITLE(day)} calls treated as after-hours?`,
        });
      }

      // ── service area ──
      if (/\b(don'?t|do not|no longer|stop) (go(ing)? to|servic\w+|cover(ing)?|travel(ling)? to)\b/i.test(t) || /\bstop servicing\b/i.test(t)) {
        const m = raw.match(/(?:to|servicing|service|cover|covering)\s+([A-Z][A-Za-z' -]+)/);
        const suburbs = m ? [m[1].trim().replace(/\s+(any ?more|now|from now on)\.?$/i, "")] : [];
        if (!suburbs.length) {
          return say({ intent: UNKNOWN_INTENT, confidence: 0.4, clarificationRequest: "Which suburb should I take off the list?" });
        }
        return say({ intent: "EXCLUDE_SERVICE_AREA", payload: { suburbs }, confidence: 0.85 });
      }
      if (/\bwe (service|cover|go to|travel to)\b/i.test(t)) {
        const after = raw.replace(/^.*?\b(?:service|cover|go to|travel to)\b/i, "");
        const suburbs = splitList(after).map((s) => TITLE(s));
        if (suburbs.length) return say({ intent: "SET_SERVICE_AREA", payload: { suburbs }, confidence: 0.75 });
      }

      // ── services ──
      if (/\b(add|we also do|we now do|start offering|we do)\b/i.test(t) && !/\bservice area\b/i.test(t)) {
        const after = raw.replace(/^.*?\b(?:add|we also do|we now do|start offering|we do)\b/i, "");
        const names = splitList(after);
        if (names.length === 1) {
          const urgency = URGENCY_LEVELS.find((u) => new RegExp(`\\b${u.replace("_", " ")}\\b`, "i").test(t)) || null;
          // The urgency phrase is not part of the service's NAME. "cable
          // replacement as an urgent job" must become the service "Cable
          // Replacement", not a service called "…As An Urgent Job".
          const name = names[0]
            .replace(/\s*\b(as|and treat it as|treated as|which is|that'?s)\b.*$/i, "")
            .replace(/\s*\b(an?|the)\s+(emergency|urgent|priority|standard|non.?urgent)\b.*$/i, "")
            .trim();
          const payload = { name: TITLE(name || names[0]) };
          if (urgency) payload.urgency = urgency;
          return say({ intent: "ADD_SERVICE", payload, confidence: urgency ? 0.85 : 0.7 });
        }
        if (names.length > 1) {
          // Several services in one breath. Ask rather than inventing urgency
          // for each — this is the P40A interview path.
          return say({
            intent: UNKNOWN_INTENT, confidence: 0.5,
            ambiguities: [{ field: "services", question: "Which of those should be treated as urgent after hours?", options: names.map(TITLE) }],
            clarificationRequest: "Which of those should be treated as urgent after hours?",
            note: JSON.stringify({ services: names.map(TITLE) }),
          });
        }
      }
      if (/\b(remove|drop|stop offering|we don'?t do|no longer do)\b/i.test(t)) {
        const after = raw.replace(/^.*?\b(?:remove|drop|stop offering|we don'?t do|no longer do)\b/i, "");
        const names = splitList(after);
        if (names.length === 1) return say({ intent: "REMOVE_SERVICE", payload: { serviceRef: TITLE(names[0]) }, confidence: 0.8 });
      }

      // ── pricing ──
      if (/\b(stop|don'?t) (quot|mention|say|giv|discuss)\w*.{0,20}\b(price|pricing|cost|call.?out|fee|\$)/i.test(t)) {
        return say({ intent: "SET_PRICING_POLICY", payload: { disclosure: "never_discuss" }, confidence: 0.85 });
      }

      // ── transfer ──
      const number = raw.match(/\+\d[\d ]{7,16}/);
      if (/\btransfer\b/i.test(t) && number) {
        return say({ intent: "SET_TRANSFER_RULE", payload: { number: number[0].replace(/\s/g, "") }, confidence: 0.8 });
      }

      // ── after hours ──
      if (/\bafter hours\b/i.test(t)) {
        if (/\b(don'?t|do not|no|not) (answer|take|pick up)\b/i.test(t)) {
          return say({ intent: "SET_AFTER_HOURS_POLICY", payload: { available: false }, confidence: 0.8 });
        }
        if (/\b(answer|take|pick up)\b/i.test(t)) {
          return say({ intent: "SET_AFTER_HOURS_POLICY", payload: { available: true }, confidence: 0.8 });
        }
      }

      // ── nothing matched. Ask. ──
      return say({
        intent: UNKNOWN_INTENT,
        confidence: 0,
        clarificationRequest: "I'm not sure I follow — could you tell me which part of the setup you'd like to change?",
      });
    },
  });
}

/**
 * Plays back fixed interpretations by turn number. This is what the golden
 * transcripts use, so a scenario tests the ENGINE rather than the phrasebook —
 * and so a fixture cannot silently start passing because the phrasebook grew.
 */
function createScriptedInterpreter(script = []) {
  let index = 0;
  return Object.freeze({
    name: "scripted",
    isFake: true,
    async interpretTurn({ transcript, context = {} } = {}) {
      const step = script[index];
      index += 1;
      if (!step) {
        return interpretation({ intent: UNKNOWN_INTENT, clarificationRequest: "The script ran out.", transcriptRef: context.turnNumber ?? null });
      }
      if (step.expect && !new RegExp(step.expect, "i").test(String(transcript))) {
        throw new Error(`scripted interpreter: turn ${index} expected /${step.expect}/ but heard "${transcript}"`);
      }
      return interpretation({ ...step, transcriptRef: context.turnNumber ?? null });
    },
    get position() { return index; },
  });
}

/** A port that is simply broken. The engine must degrade to asking, not crash. */
function createRefusingInterpreter(message = "interpretation unavailable") {
  return Object.freeze({
    name: "refusing",
    isFake: true,
    async interpretTurn() { throw new Error(message); },
  });
}

module.exports = {
  interpretation,
  createDeterministicInterpreter, createScriptedInterpreter, createRefusingInterpreter,
  parseTime, splitList,
  INTERPRETER_CONTRACT,
};
