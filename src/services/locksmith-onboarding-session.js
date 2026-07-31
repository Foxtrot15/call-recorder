// AIDA Locksmith Receptionist — onboarding session lifecycle (M2).
//
// One row per attempt to onboard a locksmith by voice. The session is the
// audit spine: it links the interview, the transcript, the extraction and the
// profile version that came out of it.
//
// M2 does NOT require a live call. A session can be created, fed a fixture
// transcript, extracted and reviewed entirely offline — that is the whole point
// of separating this from any provider.
//
// Pure state machine + field builders up top; thin DB adapter below with a lazy
// supabase require. Table: supabase/sql/lpm2_create_locksmith_onboarding.sql
// (REVIEW ONLY, not applied).

const SESSION_STATUSES = Object.freeze([
  "created",
  "interview_ready",
  "interview_in_progress",
  "transcript_received",
  "extraction_pending",
  "needs_review",
  "approved",
  "cancelled",
  "failed",
]);

// Deliberately strict. A session cannot jump from `created` to `approved`;
// every path to approval passes through a transcript, an extraction and a
// review. `failed` and `cancelled` are reachable from any live state because
// reality intervenes, but they are terminal.
const SESSION_TRANSITIONS = Object.freeze({
  created: ["interview_ready", "cancelled", "failed"],
  interview_ready: ["interview_in_progress", "cancelled", "failed"],
  interview_in_progress: ["transcript_received", "cancelled", "failed"],
  transcript_received: ["extraction_pending", "failed", "cancelled"],
  extraction_pending: ["needs_review", "failed", "cancelled"],
  needs_review: ["approved", "extraction_pending", "cancelled", "failed"],
  approved: [],
  cancelled: [],
  failed: [],
});

const TERMINAL_STATUSES = Object.freeze(["approved", "cancelled", "failed"]);

function canTransition(from, to) {
  return Boolean(SESSION_TRANSITIONS[from]) && SESSION_TRANSITIONS[from].includes(to);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Validate a proposed transition. Returns { ok } or { ok:false, code, message }
 * so callers can map to an HTTP status without re-deriving why.
 */
function evaluateTransition(from, to) {
  if (!SESSION_STATUSES.includes(from)) return { ok: false, code: "unknown_status", message: `"${from}" is not a session status.` };
  if (!SESSION_STATUSES.includes(to)) return { ok: false, code: "unknown_status", message: `"${to}" is not a session status.` };
  if (from === to) return { ok: false, code: "no_op", message: `The session is already ${from}.` };
  if (isTerminal(from)) return { ok: false, code: "terminal", message: `A ${from} session cannot change status.` };
  if (!canTransition(from, to)) return { ok: false, code: "illegal_transition", message: `A session cannot move from ${from} to ${to}.` };
  return { ok: true };
}

/** Column payload for a new session. sessionId is supplied by the caller (uuid). */
function buildSessionFields({ clientId, sessionId, agentVersion = null, interviewSpecVersion = null, createdBy = null }, nowIso = new Date().toISOString()) {
  if (!clientId) throw new Error("session requires clientId");
  if (!sessionId) throw new Error("session requires sessionId");
  return {
    session_id: sessionId,
    client_id: clientId,
    status: "created",
    onboarding_agent_version: agentVersion,
    interview_spec_version: interviewSpecVersion,
    provider: null,
    provider_call_id: null,
    transcript_source: null,
    transcript_text: null,
    transcript_sha256: null,
    transcript_received_at: null,
    extraction_version: null,
    extraction_result: null,
    missing_fields: null,
    contradictions: null,
    review_warnings: null,
    profile_version: null,
    started_at: null,
    completed_at: null,
    failure_code: null,
    failure_detail: null,
    created_by: createdBy ? String(createdBy).slice(0, 200) : null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** Column payload for a status change, including the lifecycle timestamps. */
function buildStatusFields({ to }, nowIso = new Date().toISOString()) {
  const fields = { status: to, updated_at: nowIso };
  if (to === "interview_in_progress") fields.started_at = nowIso;
  if (to === "approved" || to === "cancelled" || to === "failed") fields.completed_at = nowIso;
  return fields;
}

/** Column payload for marking a session failed. A code is required so failures are groupable. */
function buildFailureFields({ code, detail = null }, nowIso = new Date().toISOString()) {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) throw new Error("failing a session requires a failure code");
  return {
    status: "failed",
    failure_code: trimmed.slice(0, 100),
    // Free text, capped. Never contains transcript content — callers pass a
    // short operator-facing explanation (spec §13).
    failure_detail: detail ? String(detail).slice(0, 1000) : null,
    completed_at: nowIso,
    updated_at: nowIso,
  };
}

/** Column payload once extraction has produced a draft. */
function buildExtractionFields({ extractionVersion, result, missingFields, contradictions, warnings, profileVersion }, nowIso = new Date().toISOString()) {
  return {
    extraction_version: extractionVersion,
    extraction_result: result || null,
    missing_fields: Array.isArray(missingFields) ? missingFields : [],
    contradictions: Array.isArray(contradictions) ? contradictions : [],
    review_warnings: Array.isArray(warnings) ? warnings : [],
    profile_version: profileVersion == null ? null : profileVersion,
    status: "needs_review",
    updated_at: nowIso,
  };
}

/**
 * Shape a session for API/UI use. `transcriptText` is deliberately omitted —
 * callers that genuinely need the transcript ask for it explicitly, so it is
 * never included by accident in a list response.
 */
function toPublicSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    clientId: row.client_id,
    status: row.status,
    agentVersion: row.onboarding_agent_version || null,
    interviewSpecVersion: row.interview_spec_version || null,
    provider: row.provider || null,
    providerCallId: row.provider_call_id || null,
    transcriptSource: row.transcript_source || null,
    hasTranscript: Boolean(row.transcript_text),
    transcriptSha256: row.transcript_sha256 || null,
    transcriptReceivedAt: row.transcript_received_at || null,
    extractionVersion: row.extraction_version || null,
    missingFields: row.missing_fields || [],
    contradictions: row.contradictions || [],
    reviewWarnings: row.review_warnings || [],
    profileVersion: row.profile_version == null ? null : row.profile_version,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    failureCode: row.failure_code || null,
    failureDetail: row.failure_detail || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── DB adapter ──────────────────────────────────────────────────────

const TABLE = "locksmith_onboarding_sessions";
const { tableMissing, provisioningError, recordAuditEvent, buildAuditEvent } = require("./locksmith-profile-store");

async function getSession(clientId, sessionId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("session_id", sessionId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`session lookup failed: ${error.message}`);
  }
  return data || null;
}

/**
 * Operator-scope lookup by session id alone. Used ONLY by the founder console,
 * which is already behind the operator login; every client-facing path uses
 * getSession(clientId, sessionId) so a tenant can never reach another's row.
 */
async function getSessionForOperator(sessionId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("session_id", sessionId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`session lookup failed: ${error.message}`);
  }
  return data || null;
}

async function listSessions({ clientId = null, limit = 100 } = {}) {
  const supabase = require("./supabase");
  let query = supabase.from(TABLE).select("*");
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(Math.min(limit, 300));
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`session list failed: ${error.message}`);
  }
  return data || [];
}

async function createSession({ clientId, sessionId, agentVersion = null, interviewSpecVersion = null, actor = { type: "system", id: null } }) {
  const supabase = require("./supabase");
  const fields = buildSessionFields({ clientId, sessionId, agentVersion, interviewSpecVersion, createdBy: actor.id });
  const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`session creation failed: ${error.message}`);
  }
  await recordAuditEvent(buildAuditEvent({ clientId, sessionId, eventType: "session.created", actorType: actor.type, actorId: actor.id, source: "onboarding" }));
  return data;
}

/**
 * Apply a validated transition with optimistic concurrency: the update matches
 * the status the decision was made against, so two racing transitions cannot
 * both land (zero rows updated ⇒ conflict).
 */
async function transitionSession({ clientId, sessionId, to, actor = { type: "system", id: null }, reason = null, source = "onboarding" }) {
  const row = await getSession(clientId, sessionId);
  if (!row) return { ok: false, code: "not_found", message: "Session not found." };

  const verdict = evaluateTransition(row.status, to);
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from(TABLE)
    .update(buildStatusFields({ to }))
    .eq("client_id", clientId)
    .eq("session_id", sessionId)
    .eq("status", row.status)
    .select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`session transition failed: ${error.message}`);
  }
  if (!data || data.length === 0) return { ok: false, code: "conflict", message: "The session changed underneath this request." };

  await recordAuditEvent(
    buildAuditEvent({ clientId, sessionId, eventType: `session.${to}`, actorType: actor.type, actorId: actor.id, reason, source, detail: { from: row.status, to } })
  );
  return { ok: true, row: data[0] };
}

async function failSession({ clientId, sessionId, code, detail = null, actor = { type: "operator", id: null } }) {
  const row = await getSession(clientId, sessionId);
  if (!row) return { ok: false, code: "not_found", message: "Session not found." };
  if (isTerminal(row.status)) return { ok: false, code: "terminal", message: `A ${row.status} session cannot be failed.` };

  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from(TABLE)
    .update(buildFailureFields({ code, detail }))
    .eq("client_id", clientId)
    .eq("session_id", sessionId)
    .eq("status", row.status)
    .select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`session failure update failed: ${error.message}`);
  }
  if (!data || data.length === 0) return { ok: false, code: "conflict", message: "The session changed underneath this request." };

  await recordAuditEvent(
    buildAuditEvent({ clientId, sessionId, eventType: "session.failed", actorType: actor.type, actorId: actor.id, reason: code, source: "founder_console", detail: { from: row.status } })
  );
  return { ok: true, row: data[0] };
}

module.exports = {
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
  TERMINAL_STATUSES,
  canTransition,
  isTerminal,
  evaluateTransition,
  buildSessionFields,
  buildStatusFields,
  buildFailureFields,
  buildExtractionFields,
  toPublicSession,
  // adapter
  getSession,
  getSessionForOperator,
  listSessions,
  createSession,
  transitionSession,
  failSession,
};
