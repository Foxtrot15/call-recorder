// AIDA — onboarding call runtime: request, lifecycle, and the call record (M4).
//
//   requestOnboardingCall({ clientId, sessionId, requestedBy, consentId })
//
// THIS IS FOR CLIENT-REQUESTED ONBOARDING CALLS ONLY. There is no cold-outreach
// path here and none may be added: the service refuses without a valid consent
// bound to this client, this session and this number.
//
// LIVE MODE CANNOT HAPPEN BY ACCIDENT. Placing a call requires, simultaneously:
// RETELL_ENABLED, RETELL_LIVE_CALLS_ENABLED, RETELL_LIVE_WRITES_ENABLED,
// RETELL_DRY_RUN=false, an API key, a voice id and an outbound number. Absent
// any of them the service runs in disabled / dry-run / mock mode and makes no
// network call at all. A test asserts that the shipped configuration cannot
// reach live mode.
//
// Pure decision core + thin adapter.

const crypto = require("crypto");
const { getRetellConfig, canPlaceCall } = require("../config/retell");
const { MODES, createMockAdapter, createDryRunAdapter, createDisabledAdapter } = require("./voice-platform-port");
const consentApi = require("./onboarding-call-consent");
const sessions = require("./locksmith-onboarding-session");
const { buildAuditEvent, recordAuditEvent } = require("./locksmith-profile-store");

const TABLE = "onboarding_calls";

// Normalised call lifecycle. Provider statuses map INTO this; we never store a
// provider's vocabulary as our own state.
const CALL_STATUSES = Object.freeze([
  "requested",
  "created",
  "dialling",
  "connected",
  "ended",
  "transcript_received",
  "analysis_received",
  "failed",
  "cancelled",
]);

const ACTIVE_STATUSES = Object.freeze(["requested", "created", "dialling", "connected"]);

// Transcript and analysis arrive AFTER the call ends, sometimes out of order,
// and sometimes the `call_ended` delivery itself is lost. A transcript or an
// analysis is conclusive evidence the call finished, so the mid-call states
// accept them directly rather than hard-rejecting a legitimate late event —
// otherwise one dropped webhook strands the whole onboarding.
const CALL_TRANSITIONS = Object.freeze({
  requested: ["created", "failed", "cancelled"],
  created: ["dialling", "connected", "ended", "transcript_received", "analysis_received", "failed", "cancelled"],
  dialling: ["connected", "ended", "transcript_received", "analysis_received", "failed", "cancelled"],
  connected: ["ended", "transcript_received", "analysis_received", "failed"],
  ended: ["transcript_received", "analysis_received", "failed"],
  transcript_received: ["analysis_received"],
  analysis_received: ["transcript_received"],
  failed: [],
  cancelled: [],
});

const REFUSAL_CODES = Object.freeze({
  notFound: "session_not_found",
  wrongTenant: "wrong_tenant",
  badSessionState: "session_not_ready",
  consentInvalid: "consent_invalid",
  activeCall: "call_already_active",
  outsideWindow: "outside_calling_window",
  providerRefused: "provider_refused",
  notProvisioned: "not_provisioned",
});

// Australian consumer-contact convention: a business owner asked us to ring, so
// this is deliberately generous, but ringing someone at 3am because a form was
// submitted then is still wrong.
const CALLING_WINDOW = Object.freeze({ startHour: 8, endHour: 20, timezoneNote: "evaluated in the client's configured timezone; defaults to Australia/Melbourne" });

function canTransition(from, to) {
  return Boolean(CALL_TRANSITIONS[from]) && CALL_TRANSITIONS[from].includes(to);
}

function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Is now inside the calling window? Pure — the caller supplies the local hour so
 * this stays testable and timezone handling lives at the edge.
 */
function isWithinCallingWindow(localHour) {
  return Number.isInteger(localHour) && localHour >= CALLING_WINDOW.startHour && localHour < CALLING_WINDOW.endHour;
}

/**
 * A deterministic request key. The same client+session+consent always produces
 * the same key, so a double-submitted form is idempotent rather than two calls.
 */
function requestKey({ clientId, sessionId, consentId }) {
  return crypto.createHash("sha256").update(`${clientId}|${sessionId}|${consentId}`).digest("hex");
}

/**
 * Provider metadata. Opaque AIDA identifiers ONLY — no business name, no
 * profile content, nothing the provider does not need. If this payload leaked
 * it would reveal that a call happened, not what the business does.
 */
function buildProviderMetadata({ clientId, sessionId, callId }) {
  return Object.freeze({
    aida_call_id: callId,
    aida_session_id: sessionId,
    // Hashed: the provider gets a stable correlator without our tenant slug.
    aida_client_ref: crypto.createHash("sha256").update(clientId).digest("hex").slice(0, 24),
    aida_purpose: "onboarding_interview",
  });
}

function buildCallFields({ callId, clientId, sessionId, consentId, requestedBy, destinationNumber, mode, requestKeyValue }, nowIso = new Date().toISOString()) {
  return {
    call_id: callId,
    client_id: clientId,
    session_id: sessionId,
    consent_id: consentId,
    requested_by: requestedBy ? String(requestedBy).slice(0, 200) : null,
    request_key: requestKeyValue,
    status: "requested",
    mode,
    provider: "retell",
    provider_call_id: null,
    destination_number: destinationNumber,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    end_reason: null,
    failure_code: null,
    transcript_received_at: null,
    analysis_received_at: null,
    provider_cost: null,
    // A provider recording URL is a reference we store and never fetch.
    recording_reference: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Normalise a provider disconnection reason into our own vocabulary. Unknown
 * reasons are preserved as `provider_other` plus a bounded label rather than
 * being invented into one of ours.
 */
function normaliseEndReason(providerReason) {
  if (typeof providerReason !== "string" || !providerReason) return { reason: "unknown", providerLabel: null };
  const label = providerReason.slice(0, 100);
  const map = {
    user_hangup: "caller_ended",
    agent_hangup: "agent_ended",
    call_transfer: "transferred",
    voicemail_reached: "voicemail",
    inactivity: "timed_out",
    machine_detected: "voicemail",
    max_duration_reached: "timed_out",
    error: "provider_error",
    dial_busy: "busy",
    dial_failed: "dial_failed",
    dial_no_answer: "no_answer",
  };
  return { reason: map[providerReason] || "provider_other", providerLabel: label };
}

// ── The service ─────────────────────────────────────────────────────

function createOnboardingCallService(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const sessionsApi = deps.sessions || sessions;
  const consents = deps.consents || consentApi;
  const calls = deps.calls || createCallAdapter();
  const audit = deps.recordAuditEvent || recordAuditEvent;
  const now = deps.now || (() => new Date());
  const localHour = deps.localHour || (() => now().getHours());

  /**
   * Pick the adapter. Mock is only reachable when the CALLER asks for it
   * explicitly (the simulator and tests); it can never be selected by env.
   */
  function selectCallAdapter(explicitMode) {
    if (explicitMode === MODES.mock) return deps.mockAdapter || createMockAdapter();
    const config = getRetellConfig(env);
    const gate = canPlaceCall(env);
    if (!config.enabled) return createDisabledAdapter({ reasons: ["RETELL_ENABLED is not \"true\""] });
    if (config.dryRun) return deps.dryRunAdapter || createDryRunAdapter();
    if (!gate.allowed) return createDisabledAdapter({ reasons: gate.reasons });
    return deps.liveAdapter || require("./retell-adapter").createRetellAdapter({ config, env });
  }

  async function requestOnboardingCall({ clientId, sessionId, requestedBy, consentId, explicitMode = null, onboardingAgentId = null }) {
    const config = getRetellConfig(env);

    // 1. Ownership. The session must exist AND belong to this tenant.
    const session = await sessionsApi.getSession(clientId, sessionId);
    if (!session) return { ok: false, code: REFUSAL_CODES.notFound, message: "That setup session was not found." };

    // 2. Session state. A finished or failed session cannot be re-dialled.
    if (sessionsApi.isTerminal(session.status)) {
      return { ok: false, code: REFUSAL_CODES.badSessionState, message: `This session is ${session.status} and cannot start a new call.` };
    }

    // 3. Consent — bound to this client, this session, and still usable.
    const consent = await consents.getConsent(clientId, consentId);
    const verdict = consents.evaluateConsent({ consent, clientId, sessionId, nowMs: now().getTime() });
    if (!verdict.ok) return { ok: false, code: REFUSAL_CODES.consentInvalid, reason: verdict.code, message: verdict.message };

    // 4. Idempotency. The same request twice returns the first call.
    const key = requestKey({ clientId, sessionId, consentId });
    const existingByKey = await calls.findByRequestKey(clientId, key);
    if (existingByKey) {
      return { ok: true, idempotent: true, code: "already_requested", call: toPublicCall(existingByKey), mode: existingByKey.mode };
    }

    // 5. One active call at a time.
    const active = await calls.findActive(clientId, sessionId);
    if (active) {
      return { ok: false, code: REFUSAL_CODES.activeCall, message: "There's already a call in progress for this setup.", call: toPublicCall(active) };
    }

    // 6. Calling window.
    if (!isWithinCallingWindow(localHour())) {
      return {
        ok: false,
        code: REFUSAL_CODES.outsideWindow,
        message: `We only make setup calls between ${CALLING_WINDOW.startHour}am and ${CALLING_WINDOW.endHour - 12}pm. Request one during the day and we'll ring you.`,
      };
    }

    // 7. Create our record BEFORE talking to any provider, so a provider call
    //    that succeeds while our response is lost is still traceable.
    const adapter = selectCallAdapter(explicitMode);
    const callId = deps.newCallId ? deps.newCallId() : crypto.randomUUID();
    const fields = buildCallFields({
      callId, clientId, sessionId, consentId,
      requestedBy, destinationNumber: consent.destination_number,
      mode: adapter.mode, requestKeyValue: key,
    }, now().toISOString());

    let row;
    try {
      row = await calls.create(fields);
    } catch (err) {
      if (/not provisioned/i.test(err.message)) return { ok: false, code: REFUSAL_CODES.notProvisioned, message: "Setup calls aren't available yet." };
      throw err;
    }

    await consents.incrementAttempt(clientId, consentId, consent.attempt_count || 0);
    await audit(buildAuditEvent({
      clientId, sessionId, eventType: "onboarding_call.requested", actorType: "client", actorId: requestedBy,
      source: "client_portal", detail: { mode: adapter.mode, callId },
    }));

    // 8. Ask the provider. In disabled/dry-run/mock this touches no network.
    const response = await adapter.createPhoneCall({
      payload: {
        from_number: config.outboundOnboardingNumber,
        to_number: consent.destination_number,
        override_agent_id: onboardingAgentId,
        metadata: buildProviderMetadata({ clientId, sessionId, callId }),
        // Only the onboarding agent's variables. No business profile is sent —
        // this agent exists to LEARN the configuration.
        retell_llm_dynamic_variables: {
          client_id: clientId,
          session_id: sessionId,
          interview_spec_version: require("./locksmith-interview-spec").INTERVIEW_SPEC_VERSION,
          disclosure_version: consent.disclosure_version,
        },
      },
      idempotencyKey: key,
    });

    if (!response.ok) {
      await calls.update(clientId, callId, {
        status: "failed",
        failure_code: response.error.code,
        updated_at: now().toISOString(),
      });
      await audit(buildAuditEvent({
        clientId, sessionId, eventType: "onboarding_call.failed", actorType: "system",
        reason: response.error.code, source: adapter.mode,
        detail: { retryable: response.error.retryable },
      }));
      logger.error(`onboarding_call.provider_refused mode=${adapter.mode} code=${response.error.code}`);
      return {
        ok: false,
        code: REFUSAL_CODES.providerRefused,
        message: response.error.retryable
          ? "We couldn't get the call started just then. Try again in a moment."
          : "Setup calls aren't available right now.",
        retryable: response.error.retryable,
        mode: adapter.mode,
      };
    }

    // 9. Bind the provider call id — only now, after a confirmed success.
    const providerCallId = response.resource && response.resource.id ? response.resource.id : null;
    const updated = await calls.update(clientId, callId, {
      status: "created",
      provider_call_id: providerCallId,
      updated_at: now().toISOString(),
    });

    await audit(buildAuditEvent({
      clientId, sessionId, eventType: "onboarding_call.created", actorType: "system",
      source: adapter.mode, detail: { mode: adapter.mode, hasProviderCallId: Boolean(providerCallId) },
    }));

    // 10. Move the session along explicitly.
    await sessionsApi.transitionSession({
      clientId, sessionId, to: "interview_in_progress",
      actor: { type: "system", id: null }, reason: "onboarding call created", source: adapter.mode,
    });

    return { ok: true, code: "call_created", mode: adapter.mode, call: toPublicCall(updated || { ...fields, status: "created", provider_call_id: providerCallId }) };
  }

  return { requestOnboardingCall, selectCallAdapter };
}

/** Client-facing call shape. The destination number is masked. */
function toPublicCall(row) {
  if (!row) return null;
  const number = row.destination_number || "";
  return Object.freeze({
    callId: row.call_id,
    status: row.status,
    mode: row.mode,
    // Enough for the client to recognise which number, not enough to be useful
    // in a leaked log.
    destinationNumberMasked: number ? `••• ••• ${number.slice(-3)}` : null,
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
    endReason: row.end_reason || null,
    failureCode: row.failure_code || null,
    transcriptReceivedAt: row.transcript_received_at || null,
    analysisReceivedAt: row.analysis_received_at || null,
    createdAt: row.created_at,
  });
}

// ── DB adapter ──────────────────────────────────────────────────────

const { tableMissing, provisioningError } = require("./onboarding-call-consent");

function createCallAdapter() {
  return {
    async create(fields) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`creating the call record failed: ${error.message}`);
      }
      return data;
    },
    async update(clientId, callId, patch) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).update(patch).eq("client_id", clientId).eq("call_id", callId).select();
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`updating the call record failed: ${error.message}`);
      }
      return data && data.length ? data[0] : null;
    },
    async findByRequestKey(clientId, key) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("request_key", key).maybeSingle();
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`call lookup failed: ${error.message}`);
      }
      return data || null;
    },
    async findActive(clientId, sessionId) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("session_id", sessionId).in("status", [...ACTIVE_STATUSES]).limit(1);
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`active call lookup failed: ${error.message}`);
      }
      return data && data.length ? data[0] : null;
    },
    async findByProviderCallId(providerCallId) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).select("*").eq("provider_call_id", providerCallId).maybeSingle();
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`provider call lookup failed: ${error.message}`);
      }
      return data || null;
    },
    async findForSession(clientId, sessionId) {
      const supabase = require("./supabase");
      const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("session_id", sessionId).order("created_at", { ascending: false });
      if (error) {
        if (tableMissing(error)) throw provisioningError();
        throw new Error(`call list failed: ${error.message}`);
      }
      return data || [];
    },
  };
}

module.exports = {
  TABLE,
  CALL_STATUSES,
  ACTIVE_STATUSES,
  CALL_TRANSITIONS,
  REFUSAL_CODES,
  CALLING_WINDOW,
  canTransition,
  isActive,
  isWithinCallingWindow,
  requestKey,
  buildProviderMetadata,
  buildCallFields,
  normaliseEndReason,
  toPublicCall,
  createOnboardingCallService,
  createCallAdapter,
};
