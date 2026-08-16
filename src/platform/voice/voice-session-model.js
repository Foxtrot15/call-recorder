// AIDA VOICE CONFIGURATION — the vocabulary of a configuration conversation (P38).
//
//   SESSION_STATES / TERMINAL_STATES / STATE_MEANING
//   TURN_ROLES
//   RISK_CLASSES / RISK_MEANING
//   CHANGE_STATES
//   VOICE_AUDIT_EVENTS
//   emptySession() / emptyTurn()
//
// ── WHAT A VOICE SESSION IS ─────────────────────────────────────────
// A business owner telephones AIDA and says "we close at four on Saturdays
// now". That sentence has to become a reviewed configuration change without
// ever becoming a live one on its own.
//
// So a session is a NEGOTIATION with an audit trail, not a command channel. It
// accumulates PROPOSED changes, asks about the ones it does not understand,
// takes confirmation for the ones that matter, and at the end hands the whole
// lot to the configuration authority as a DRAFT.
//
// ── THE STATES THAT DELIBERATELY DO NOT EXIST ───────────────────────
// There is no `approved`, no `active`, no `provisioned` and no `live` session
// state, and there is no transition that could reach one. Those words belong to
// authorities a telephone call cannot reach: approval is a named human,
// activation is an operator, provisioning is a separate authorised operation.
//
// A session's most advanced state is `draft_created`. That is the ceiling, and
// it is the ceiling by construction rather than by a check somebody remembered.
//
// ── RAW AUDIO IS NOT DOMAIN STATE ───────────────────────────────────
// Nothing here holds audio, and nothing holds a recording reference. A turn
// carries the TEXT it was understood as and the STRUCTURED MEANING extracted
// from it, because those are what a person reviewing the draft needs. What the
// caller's voice sounded like is not configuration and is not kept here.
//
// This module imports nothing.

// ── SESSION LIFECYCLE ───────────────────────────────────────────────

const SESSION_STATES = Object.freeze([
  "collecting",           // asking and hearing; the normal state
  "clarifying",           // one specific ambiguity is blocking, and AIDA asked about it
  "confirming",           // a high-risk change is waiting for an explicit yes
  "reviewing",            // the caller asked to hear the summary before finishing
  "ready_to_create_draft",// everything resolved; the draft has not been written yet
  "draft_created",        // the configuration authority accepted it. THE CEILING.
  "cancelled",            // the caller stopped, or the session was abandoned
  "refused",              // the session asked for something the platform will not do
]);

const TERMINAL_STATES = Object.freeze(["draft_created", "cancelled", "refused"]);

/**
 * Every legal move. A state machine written as data so a test can walk it and
 * prove no path reaches anything resembling approval — because the strongest
 * version of "voice cannot approve" is "there is no edge to approve".
 */
const STATE_TRANSITIONS = Object.freeze({
  collecting: Object.freeze(["collecting", "clarifying", "confirming", "reviewing", "ready_to_create_draft", "cancelled", "refused"]),
  clarifying: Object.freeze(["collecting", "clarifying", "confirming", "cancelled", "refused"]),
  confirming: Object.freeze(["collecting", "clarifying", "confirming", "reviewing", "ready_to_create_draft", "cancelled", "refused"]),
  reviewing: Object.freeze(["collecting", "clarifying", "confirming", "reviewing", "ready_to_create_draft", "cancelled", "refused"]),
  ready_to_create_draft: Object.freeze(["collecting", "draft_created", "cancelled", "refused"]),
  draft_created: Object.freeze([]),   // terminal, on purpose
  cancelled: Object.freeze([]),
  refused: Object.freeze([]),
});

const STATE_MEANING = Object.freeze({
  collecting: "Listening and proposing. Nothing is committed.",
  clarifying: "One thing was ambiguous and AIDA asked rather than guessed.",
  confirming: "A higher-risk change is waiting for the caller to say yes in words.",
  reviewing: "The caller asked what has been proposed so far.",
  ready_to_create_draft: "Everything is resolved. A draft has NOT been written yet.",
  draft_created: "A draft version exists and a person must review it. Nothing is live.",
  cancelled: "The caller stopped. No draft was written.",
  refused: "The session asked for something a configuration conversation may not do.",
});

// ── TURNS ───────────────────────────────────────────────────────────

const TURN_ROLES = Object.freeze(["caller", "assistant", "system"]);

// ── PROPOSED CHANGES ────────────────────────────────────────────────

const CHANGE_STATES = Object.freeze([
  "proposed",     // AIDA understood it and said it back
  "confirmed",    // the caller agreed, explicitly where risk demands it
  "rejected",     // the caller said no
  "superseded",   // a later correction replaced it
  "blocked",      // platform policy refuses it
]);

/**
 * How much a mishearing would cost. Drives whether an explicit spoken
 * confirmation is required before a change may be counted.
 *
 * The line is not "how big is the edit" — it is "who finds out, and how". A
 * removed service is a caller being told no by a business that does do the job.
 * A changed transfer number is a ringing telephone nobody owns.
 */
const RISK_CLASSES = Object.freeze(["low", "medium", "high"]);

const RISK_MEANING = Object.freeze({
  low: "Reversible and visible on the review screen. Proposed without a spoken confirmation.",
  medium: "Worth reading carefully. Proposed, and included in the spoken summary.",
  high: "Requires an explicit spoken confirmation before it is counted at all.",
});

/** High risk requires a confirmation. This is the whole rule. */
const requiresSpokenConfirmation = (risk) => risk === "high";

// ── AUDIT ───────────────────────────────────────────────────────────
//
// Safe metadata only. No transcript, no credential, no payment detail — see
// the privacy note in docs/AIDA_VOICE_CONFIGURATION.md. What is recorded is
// what a person auditing a configuration change needs: that a session existed,
// what it proposed, what was confirmed, and what came out.
const VOICE_AUDIT_EVENTS = Object.freeze([
  "voice_session_started",
  "voice_change_proposed",
  "voice_change_confirmed",
  "voice_change_rejected",
  "voice_change_blocked",
  "voice_clarification_requested",
  "voice_draft_created",
  "voice_session_cancelled",
  "voice_session_refused",
]);

/**
 * Keys that must never appear in voice audit metadata, whatever a caller says
 * out loud. A caller reading a card number to an assistant is a caller whose
 * card number must not end up in an audit table.
 */
const FORBIDDEN_AUDIT_KEYS = Object.freeze([
  "transcript", "audio", "recording", "recordingUrl",
  "apiKey", "api_key", "secret", "token", "password", "credential",
  "cardNumber", "card_number", "cvv", "pan", "accountNumber", "bsb",
]);

// ── SHAPES ──────────────────────────────────────────────────────────

/**
 * A session, empty. `clientId` is fixed here and never reassigned — a
 * transcript that names another business changes nothing, and a test proves the
 * field is frozen rather than merely unwritten.
 */
function emptySession({ sessionId, clientId, actorId, baseConfigVersion = null, mode = "edit", startedAt = null }) {
  return {
    sessionId,
    clientId,
    actorId,
    source: "voice",              // recorded, never used to grant trust
    mode,                          // "setup" | "edit"
    baseConfigVersion,
    startedAt,
    updatedAt: startedAt,
    state: "collecting",
    currentTopic: null,
    coveredTopics: [],
    turns: [],
    proposedChanges: [],
    unresolved: [],
    refusals: [],
    draft: null,                   // { configVersion, status } once created
    summaryText: null,
  };
}

function emptyTurn({ turnNumber, role, text = null, at = null }) {
  return {
    turnNumber,
    role,
    // The words, as understood. NOT audio, and not a recording reference.
    text,
    interpretation: null,          // set for caller turns once interpreted
    at,
  };
}

module.exports = {
  SESSION_STATES, TERMINAL_STATES, STATE_TRANSITIONS, STATE_MEANING,
  TURN_ROLES,
  CHANGE_STATES, RISK_CLASSES, RISK_MEANING, requiresSpokenConfirmation,
  VOICE_AUDIT_EVENTS, FORBIDDEN_AUDIT_KEYS,
  emptySession, emptyTurn,
};
