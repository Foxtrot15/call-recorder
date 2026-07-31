// AIDA Locksmith Receptionist — transcript ingestion boundary (M2).
//
// The single door a completed onboarding interview comes through, whatever
// produced it. Provider-neutral by construction: `provider` is data, not a
// branch, so adding Retell later means adding a caller and a signature check
// at the edge — not touching this module.
//
//   receiveOnboardingTranscript({ clientId, sessionId, provider,
//                                 providerCallId, transcript, metadata })
//
// Guarantees, each of which is a test:
//   * Idempotent. The same (provider, providerCallId) delivered twice is
//     accepted once and reported as a duplicate — webhooks retry, and a retry
//     must not create a second interview.
//   * Never silently replaces. A different transcript arriving for a session
//     that already has one is REFUSED, not merged and not overwritten. The
//     first transcript is what the locksmith actually said.
//   * Client/session must match. A transcript for a session belonging to
//     another tenant is rejected before anything is written.
//   * Size-bounded, and the text is treated as hostile input throughout: it is
//     stored verbatim (mangling evidence is worse than storing it) and escaped
//     at every render site. Control characters are stripped because they are
//     never speech, and a null byte would break Postgres text storage.
//   * Audited. Receipt, duplicate and rejection all produce an event.
//
// THERE IS NO PUBLIC ENDPOINT FOR THIS. M2 exposes it only behind the operator
// login (founder console, fixture path). The future Retell webhook must verify
// a provider signature BEFORE calling this — see
// docs/LOCKSMITH_ONBOARDING_SPEC.md §6.
//
// Pure decision core + thin adapter, lazy supabase require.

const crypto = require("crypto");
const { MAX_TRANSCRIPT_BYTES, MIN_TRANSCRIPT_BYTES, MAX_TRANSCRIPT_TURNS, MAX_METADATA_BYTES, TRANSCRIPT_PROVIDERS } = require("../config/locksmith-onboarding");
const session = require("./locksmith-onboarding-session");
const { tableMissing, provisioningError, recordAuditEvent, buildAuditEvent } = require("./locksmith-profile-store");

const RESULT_CODES = Object.freeze({
  received: "received",
  duplicate: "duplicate",
  conflict: "transcript_exists",
  invalid: "invalid",
  notFound: "session_not_found",
  wrongTenant: "session_client_mismatch",
  badState: "session_not_accepting_transcript",
});

/**
 * Normalise transcript text without destroying it.
 *
 * Removes ASCII control characters except tab/newline (never present in real
 * speech; a null byte would corrupt storage) and normalises line endings.
 * Deliberately does NOT strip or escape markup: a locksmith who says
 * "<script>" said that, and hiding it here would create a false belief that
 * stored text is render-safe. Escaping happens at output (src/views/escape.js).
 */
function normaliseTranscript(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n/g, "\n")
    // Control chars except tab and newline: never speech, and a null byte
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // would truncate Postgres text
    .trim();
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Pure validation of an ingestion request. Returns { ok } or
 * { ok:false, code, message } — no I/O, so the rules are testable directly.
 */
function validateIngestion({ clientId, sessionId, provider, providerCallId, transcript, metadata }) {
  if (!clientId || typeof clientId !== "string") return { ok: false, code: RESULT_CODES.invalid, message: "clientId is required." };
  if (!sessionId || typeof sessionId !== "string") return { ok: false, code: RESULT_CODES.invalid, message: "sessionId is required." };
  if (!TRANSCRIPT_PROVIDERS.includes(provider)) {
    return { ok: false, code: RESULT_CODES.invalid, message: `provider must be one of ${TRANSCRIPT_PROVIDERS.join(", ")}.` };
  }
  if (providerCallId !== null && providerCallId !== undefined && typeof providerCallId !== "string") {
    return { ok: false, code: RESULT_CODES.invalid, message: "providerCallId must be a string when present." };
  }
  if (typeof providerCallId === "string" && providerCallId.length > 200) {
    return { ok: false, code: RESULT_CODES.invalid, message: "providerCallId is too long." };
  }

  const text = normaliseTranscript(transcript);
  if (!text) return { ok: false, code: RESULT_CODES.invalid, message: "transcript is empty." };
  const bytes = byteLength(text);
  if (bytes < MIN_TRANSCRIPT_BYTES) return { ok: false, code: RESULT_CODES.invalid, message: "transcript is too short to be an interview." };
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    return { ok: false, code: RESULT_CODES.invalid, message: `transcript exceeds the ${Math.round(MAX_TRANSCRIPT_BYTES / 1024)} KB limit.` };
  }
  if (text.split("\n").length > MAX_TRANSCRIPT_TURNS) {
    return { ok: false, code: RESULT_CODES.invalid, message: "transcript has too many lines." };
  }
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return { ok: false, code: RESULT_CODES.invalid, message: "metadata must be an object." };
    }
    if (byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
      return { ok: false, code: RESULT_CODES.invalid, message: "metadata is too large." };
    }
  }
  return { ok: true, text, bytes, sha256: sha256(text) };
}

/**
 * Decide what to do given the validated request and the CURRENT session row.
 * Pure — the adapter below does the I/O around it, and tests drive this
 * directly with plain objects.
 */
function decideIngestion({ row, clientId, providerCallId, digest }) {
  if (!row) return { action: "reject", code: RESULT_CODES.notFound, message: "No such onboarding session." };
  if (row.client_id !== clientId) {
    // Never reveal that the session exists under another tenant.
    return { action: "reject", code: RESULT_CODES.notFound, message: "No such onboarding session." };
  }
  if (session.isTerminal(row.status)) {
    return { action: "reject", code: RESULT_CODES.badState, message: `A ${row.status} session cannot accept a transcript.` };
  }

  if (row.transcript_sha256) {
    // Same bytes (or the same provider call) arriving again: idempotent success.
    const sameContent = row.transcript_sha256 === digest;
    const sameCall = Boolean(providerCallId) && row.provider_call_id === providerCallId;
    if (sameContent || sameCall) {
      return { action: "duplicate", code: RESULT_CODES.duplicate, message: "This transcript has already been received." };
    }
    // Different content: refuse. Replacing the record of what someone said is
    // never something to do silently.
    return { action: "reject", code: RESULT_CODES.conflict, message: "This session already has a different transcript. Start a new session rather than replacing it." };
  }

  return { action: "store", code: RESULT_CODES.received };
}

// ── Adapter ─────────────────────────────────────────────────────────

const TABLE = "locksmith_onboarding_sessions";

/**
 * The domain entry point. Returns a stable result:
 *   { ok, code, sessionId, status?, transcriptSha256?, message? }
 * `ok` is true for both a fresh receipt and an idempotent duplicate — callers
 * that need to distinguish read `code`.
 */
async function receiveOnboardingTranscript({ clientId, sessionId, provider, providerCallId = null, transcript, metadata = null, actor = { type: "system", id: null } }) {
  const validation = validateIngestion({ clientId, sessionId, provider, providerCallId, transcript, metadata });
  if (!validation.ok) {
    return { ok: false, code: validation.code, sessionId, message: validation.message };
  }

  const row = await session.getSession(clientId, sessionId);
  const decision = decideIngestion({ row, clientId, providerCallId, digest: validation.sha256 });

  if (decision.action === "reject") {
    // Audit rejections too: a stream of mismatches is a signal, and a silent
    // refusal is indistinguishable from a bug.
    if (row && row.client_id === clientId) {
      await recordAuditEvent(
        buildAuditEvent({ clientId, sessionId, eventType: "transcript.rejected", actorType: actor.type, actorId: actor.id, reason: decision.code, source: provider })
      );
    }
    return { ok: false, code: decision.code, sessionId, message: decision.message };
  }

  if (decision.action === "duplicate") {
    await recordAuditEvent(
      buildAuditEvent({ clientId, sessionId, eventType: "transcript.duplicate", actorType: actor.type, actorId: actor.id, source: provider, detail: { providerCallId: providerCallId || null } })
    );
    return { ok: true, code: RESULT_CODES.duplicate, sessionId, status: row.status, transcriptSha256: row.transcript_sha256, message: decision.message };
  }

  const supabase = require("./supabase");
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      provider,
      provider_call_id: providerCallId || null,
      transcript_source: provider,
      transcript_text: validation.text,
      transcript_sha256: validation.sha256,
      transcript_received_at: nowIso,
      transcript_metadata: metadata || null,
      status: "transcript_received",
      updated_at: nowIso,
    })
    .eq("client_id", clientId)
    .eq("session_id", sessionId)
    // Only write where no transcript exists — the database, not just the
    // decision above, refuses the overwrite. Closes the check-then-act race.
    .is("transcript_sha256", null)
    .select();

  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`transcript ingestion failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    // Something wrote a transcript between the read and the write.
    return { ok: false, code: RESULT_CODES.conflict, sessionId, message: "This session already has a transcript." };
  }

  await recordAuditEvent(
    buildAuditEvent({
      clientId,
      sessionId,
      eventType: "transcript.received",
      actorType: actor.type,
      actorId: actor.id,
      source: provider,
      // Digest and size only — the transcript itself is never copied into the
      // audit trail (spec §13).
      detail: { providerCallId: providerCallId || null, bytes: validation.bytes, sha256: validation.sha256 },
    })
  );

  return { ok: true, code: RESULT_CODES.received, sessionId, status: data[0].status, transcriptSha256: validation.sha256 };
}

module.exports = {
  RESULT_CODES,
  normaliseTranscript,
  validateIngestion,
  decideIngestion,
  sha256,
  receiveOnboardingTranscript,
};
