// AIDA — provider webhook event handling (M3).
//
// The domain half of the webhook boundary: fingerprinting, idempotency,
// validation and event mapping. The HTTP half (raw body, size limit, signature)
// lives in routes/retell-webhook.js and services/retell-webhook-verify.js.
//
// EVENT NAMES ARE NOT GUESSED. The list below is exactly what Retell's official
// webhook documentation publishes (reviewed 2026-08-01). Anything else is
// recorded minimally and ignored — an unknown event is not an error, it is a
// provider that has moved on, and it must not 500 a webhook or block a retry.
//
// IDEMPOTENCY WITHOUT A PROVIDER EVENT ID
// Retell's payload envelope is { event, call } — there is no documented
// per-delivery event id. So the fingerprint is derived from stable fields we do
// control: provider + event type + call id + a hash of the meaningful payload.
// The same delivery retried produces the same fingerprint; a genuinely
// different event on the same call does not.
//
// Pure core + thin adapter.

const crypto = require("crypto");
const { stableStringify } = require("./voice-platform-port");

const TABLE = "provider_webhook_events";
const PROVIDER = "retell";

// Verbatim from the official webhook documentation. Voice events only —
// the chat events are documented but out of scope for this product.
const KNOWN_EVENT_TYPES = Object.freeze([
  "call_started",
  "call_ended",
  "call_analyzed",
  "transcript_updated",
  "transfer_started",
  "transfer_bridged",
  "transfer_cancelled",
  "transfer_ended",
]);

// Provider event → stable internal event. Only mappings we are confident in;
// everything else stays unmapped rather than being invented.
const INTERNAL_EVENT_MAP = Object.freeze({
  call_started: "onboarding_call.started",
  call_ended: "onboarding_call.ended",
  call_analyzed: "onboarding_call.analysis_received",
  transfer_started: "onboarding_call.transfer_started",
  transfer_bridged: "onboarding_call.connected",
  transfer_cancelled: "onboarding_call.transfer_cancelled",
  transfer_ended: "onboarding_call.transfer_ended",
  // transcript_updated is intentionally unmapped: it fires repeatedly mid-call
  // and carries partial text. We act on the transcript in call_ended only.
  transcript_updated: null,
});

const PROCESSING_STATUSES = Object.freeze(["received", "ignored", "processed", "failed", "duplicate"]);

const REJECT_CODES = Object.freeze({
  malformed: "malformed_event",
  unknownEvent: "unknown_event_type",
  missingCallId: "missing_provider_call_id",
  invalidCallId: "invalid_provider_call_id",
  clientMismatch: "client_mismatch",
  noBinding: "no_session_binding",
});

/**
 * Validate the envelope. Runs AFTER signature verification — a payload we have
 * not verified is never parsed at all.
 */
function validateEventEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: REJECT_CODES.malformed, message: "webhook body was not an object" };
  }
  const eventType = parsed.event;
  if (typeof eventType !== "string" || !eventType) {
    return { ok: false, code: REJECT_CODES.malformed, message: "webhook body has no event type" };
  }

  const known = KNOWN_EVENT_TYPES.includes(eventType);
  const call = parsed.call;

  // An unknown event still needs a minimal, safe record — but it is not an
  // error and must return 2xx so the provider stops retrying.
  if (!known) {
    return { ok: true, known: false, eventType, providerCallId: call && typeof call.call_id === "string" ? call.call_id : null, call: null };
  }

  if (!call || typeof call !== "object") {
    return { ok: false, code: REJECT_CODES.malformed, message: `${eventType} carried no call object` };
  }
  const providerCallId = call.call_id;
  if (typeof providerCallId !== "string" || !providerCallId) {
    return { ok: false, code: REJECT_CODES.missingCallId, message: `${eventType} carried no call_id` };
  }
  // Bound it: an id is an opaque token, not a payload.
  if (providerCallId.length > 200 || /[\s<>]/.test(providerCallId)) {
    return { ok: false, code: REJECT_CODES.invalidCallId, message: "call_id is not a plausible provider identifier" };
  }

  return { ok: true, known: true, eventType, providerCallId, call };
}

/**
 * Deterministic fingerprint for idempotency. Built from stable, meaningful
 * fields only — timestamps that shift between retries are deliberately
 * excluded, or a retry would look like a new event.
 */
function eventFingerprint({ provider = PROVIDER, eventType, providerCallId, call = null }) {
  const meaningful = call
    ? {
        call_status: call.call_status || null,
        disconnection_reason: call.disconnection_reason || null,
        // Hash the transcript rather than including it — the fingerprint must
        // never carry call content.
        transcript_digest: typeof call.transcript === "string" ? crypto.createHash("sha256").update(call.transcript).digest("hex").slice(0, 32) : null,
        has_analysis: Boolean(call.call_analysis),
      }
    : {};
  const material = stableStringify({ provider, eventType, providerCallId: providerCallId || null, meaningful });
  return crypto.createHash("sha256").update(material).digest("hex");
}

/**
 * Bounded, PII-light metadata for the event row. No transcript, no recording
 * URL content, no analysis body — those live on the call/session records, not
 * duplicated into an event log we keep for a long time.
 */
function boundEventMetadata(call) {
  if (!call || typeof call !== "object") return null;
  return {
    call_status: typeof call.call_status === "string" ? call.call_status.slice(0, 50) : null,
    disconnection_reason: typeof call.disconnection_reason === "string" ? call.disconnection_reason.slice(0, 100) : null,
    direction: typeof call.direction === "string" ? call.direction.slice(0, 20) : null,
    agent_id: typeof call.agent_id === "string" ? `${call.agent_id.slice(0, 8)}…` : null,
    duration_ms: Number.isFinite(call.duration_ms) ? call.duration_ms : null,
    transcript_present: typeof call.transcript === "string" && call.transcript.length > 0,
    transcript_chars: typeof call.transcript === "string" ? call.transcript.length : 0,
    analysis_present: Boolean(call.call_analysis),
    // Recording URLs are references to provider-hosted media. We record only
    // that one exists — we never store or download it.
    recording_present: Boolean(call.recording_url),
  };
}

/** Column payload for the event row. */
function buildEventFields({
  provider = PROVIDER,
  eventType,
  providerCallId,
  fingerprint,
  verificationResult,
  processingStatus = "received",
  clientId = null,
  sessionId = null,
  errorCode = null,
  metadata = null,
  attempt = 1,
}, nowIso = new Date().toISOString()) {
  return {
    provider,
    event_type: String(eventType).slice(0, 100),
    provider_call_id: providerCallId ? String(providerCallId).slice(0, 200) : null,
    fingerprint,
    received_at: nowIso,
    verification_result: verificationResult,
    processing_status: processingStatus,
    attempt_count: attempt,
    client_id: clientId,
    session_id: sessionId,
    error_code: errorCode,
    metadata,
    updated_at: nowIso,
  };
}

/**
 * Map a validated provider event to the stable internal event, or null when we
 * deliberately do not act on it.
 */
function toInternalEvent(eventType) {
  return Object.prototype.hasOwnProperty.call(INTERNAL_EVENT_MAP, eventType) ? INTERNAL_EVENT_MAP[eventType] : null;
}

/**
 * Decide what to do with a verified, validated event given what we already
 * know. Pure: the caller does the I/O around it.
 */
function decideEventHandling({ envelope, existingEvent, binding }) {
  if (existingEvent) {
    return { action: "duplicate", internalEvent: null, message: "this exact delivery has already been recorded" };
  }
  if (!envelope.known) {
    return { action: "ignore", internalEvent: null, message: `"${envelope.eventType}" is not an event type this build handles` };
  }
  if (!binding) {
    // A verified event for a call we have no record of. Recorded, not
    // processed, and NOT an error — it may belong to another environment
    // sharing the account.
    return { action: "record_unbound", internalEvent: null, message: "no onboarding session is bound to this provider call id" };
  }
  if (binding.clientId && envelope.expectedClientId && binding.clientId !== envelope.expectedClientId) {
    return { action: "reject", code: REJECT_CODES.clientMismatch, internalEvent: null, message: "the call is bound to a different client" };
  }
  const internalEvent = toInternalEvent(envelope.eventType);
  if (!internalEvent) {
    return { action: "ignore", internalEvent: null, message: `"${envelope.eventType}" is known but deliberately not acted on` };
  }
  return { action: "process", internalEvent, message: null };
}

// ── DB adapter ──────────────────────────────────────────────────────

const { tableMissing, provisioningError } = require("./provider-resource-registry");

async function findEventByFingerprint(fingerprint) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("fingerprint", fingerprint).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`webhook event lookup failed: ${error.message}`);
  }
  return data || null;
}

async function recordEvent(fields) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
  if (error) {
    // A unique violation on the fingerprint means a concurrent duplicate — the
    // desired outcome, not a failure.
    if (error.code === "23505") return { duplicate: true };
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`recording the webhook event failed: ${error.message}`);
  }
  return { duplicate: false, row: data };
}

async function markEventProcessed(fingerprint, { status, errorCode = null }) {
  const supabase = require("./supabase");
  const { error } = await supabase
    .from(TABLE)
    .update({ processing_status: status, error_code: errorCode, updated_at: new Date().toISOString() })
    .eq("fingerprint", fingerprint);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`updating the webhook event failed: ${error.message}`);
  }
  return true;
}

module.exports = {
  TABLE,
  PROVIDER,
  KNOWN_EVENT_TYPES,
  INTERNAL_EVENT_MAP,
  PROCESSING_STATUSES,
  REJECT_CODES,
  validateEventEnvelope,
  eventFingerprint,
  boundEventMetadata,
  buildEventFields,
  toInternalEvent,
  decideEventHandling,
  findEventByFingerprint,
  recordEvent,
  markEventProcessed,
};
