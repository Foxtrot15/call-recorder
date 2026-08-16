// AIDA VOICE CONFIGURATION — the session audit sink (P44, privacy).
//
//   createInMemoryVoiceAudit({ now })
//   sanitiseVoiceMetadata(metadata)
//   VOICE_AUDIT_SCHEMA_NOTE
//
// ── WHY THIS IS A SEPARATE SINK ─────────────────────────────────────
// The obvious move is to send voice events to config-audit.js, which already
// exists and already has a table behind it. It was tried, and it silently ate
// every event: config-audit validates against a closed EVENT_TYPES list that
// does not contain the voice vocabulary, and the engine's try/catch — correct
// on its own terms — turned a rejection into nothing at all.
//
// The fix is NOT to widen that list. `config-audit.js`'s vocabulary must equal
// ACP1's `event_type` CHECK, ACP1's application state is an open question in
// another worktree, and widening one side of that pair from an isolated branch
// is exactly the drift that produced the open question.
//
// So voice events go to their own sink with their own closed vocabulary, and
// the durable question is written down (below) rather than answered by
// accident. The artefact that must survive a configuration call — the DRAFT —
// already has durable storage and is unaffected.
//
// ── WHAT IS NOT RECORDED ────────────────────────────────────────────
// No transcript. No audio, no recording reference, no credential, no card
// number. A caller reading a card number aloud to an assistant is a caller
// whose card number must not end up in an audit row, and the way to guarantee
// that is to make the sink REFUSE the key rather than trust every call site.

const { VOICE_AUDIT_EVENTS, FORBIDDEN_AUDIT_KEYS } = require("./voice-session-model");

/**
 * The open question this batch deliberately does not answer.
 * Written here so it is read by whoever adds durable session storage.
 */
const VOICE_AUDIT_SCHEMA_NOTE = Object.freeze({
  durable: false,
  why: "Voice session audit is in-memory. Giving it a table means either widening ACP1's event_type CHECK or creating a new one, and ACP1's applied state is unresolved.",
  whenDurableIsNeeded: "when a second person needs to answer 'who changed this and when' after the process restarts",
  recommendation: "a separate acp4_voice_sessions migration with its own vocabulary, NOT a widening of ACP1",
  meanwhile: "the draft the session produces is durable, carries source='voice', and is the artefact that matters",
});

/** Values that look like a secret regardless of the key they arrived under. */
const SECRET_SHAPED = /(sk_live|sk_test|eyJ[A-Za-z0-9_-]{20}|Bearer\s+[A-Za-z0-9._-]{16}|\b\d{13,19}\b)/;

const MAX_METADATA_BYTES = 2048;

/**
 * Strip anything that must not be stored, and refuse anything that should
 * never have been offered. A forbidden KEY throws — that is a programming
 * error at a call site and hiding it helps nobody. A secret-shaped VALUE is
 * redacted, because that one arrives from a caller's mouth and is not
 * anybody's mistake.
 */
function sanitiseVoiceMetadata(metadata = {}) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("voice audit metadata must be an object");
  }
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_AUDIT_KEYS.includes(key)) {
      throw new Error(`voice audit: "${key}" must never be recorded`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      // One level only. A nested blob is a transcript waiting to happen.
      out[key] = JSON.stringify(value).slice(0, 200);
    } else {
      out[key] = typeof value === "string" && SECRET_SHAPED.test(value) ? "[redacted]" : value;
    }
  }
  const encoded = JSON.stringify(out);
  if (encoded.length > MAX_METADATA_BYTES) {
    throw new Error(`voice audit metadata is ${encoded.length} bytes, over the ${MAX_METADATA_BYTES} limit`);
  }
  return Object.freeze(out);
}

function createInMemoryVoiceAudit({ now } = {}) {
  if (typeof now !== "function") throw new Error("createInMemoryVoiceAudit requires an injected clock");
  const rows = [];

  return Object.freeze({
    async append({ clientId, eventType, actor = null, actorRole = null, source = "voice", configVersion = null, metadata = {} } = {}) {
      if (!VOICE_AUDIT_EVENTS.includes(eventType)) {
        throw new Error(`voice audit: "${eventType}" is not a voice audit event`);
      }
      if (!clientId) throw new Error("voice audit: an event must belong to a client");

      rows.push(Object.freeze({
        clientId,
        eventType,
        actor,
        actorRole,
        source,
        configVersion,
        occurredAt: now().toISOString(),
        metadata: sanitiseVoiceMetadata(metadata),
      }));
      return true;
    },

    async list(clientId, { limit = 100 } = {}) {
      return rows.filter((r) => r.clientId === clientId).slice(-limit);
    },

    /** Every row, for tests that assert nothing leaked across tenants. */
    _all() { return rows.slice(); },
  });
}

module.exports = {
  createInMemoryVoiceAudit, sanitiseVoiceMetadata,
  VOICE_AUDIT_EVENTS, FORBIDDEN_AUDIT_KEYS, VOICE_AUDIT_SCHEMA_NOTE, MAX_METADATA_BYTES,
};
