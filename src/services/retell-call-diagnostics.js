// AIDA — deterministic Retell call diagnostics (M7E).
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────
// During M7D's live browser call the agent stopped mid-sentence, once. Nobody
// could say why. The plausible causes — the operator's connection (which did
// drop earlier that session), a websocket close, an interruption, endpointing,
// TTS, LLM latency, a provider fault, local audio — are all still plausible,
// and that is the problem. "Probably the internet" is a guess wearing a
// conclusion's clothes.
//
// This module turns a Get Call response into evidence. It does NOT contact
// Retell; it is handed a parsed body by the read-only diagnostics path.
//
// ─── THE DISCIPLINE ─────────────────────────────────────────────────
// Every statement it produces is tagged as exactly one of:
//
//   OBSERVED             the provider returned this. "call_status was ended."
//                        "The last completed turn was the agent's."
//   PROVIDER_CLASSIFIED  the provider itself said what happened.
//                        "disconnection_reason was user_hangup."
//   UNPROVEN             consistent with the evidence, established by none of
//                        it. "Connection instability is possible."
//
// A thing that is UNPROVEN never becomes a cause, however well it fits. An
// incomplete final sentence does not prove a network failure; audio stopping
// does not prove a Retell fault. The report is allowed to end with "not enough
// evidence", and for the M7D dropout it almost certainly will — because that is
// the true answer, and a confident wrong answer would send someone to fix the
// wrong thing.
//
// ─── WHAT IT REFUSES TO EMIT ────────────────────────────────────────
// No transcript text, no recording URL, no access token, no API key, no full
// phone number. A diagnostic summary gets written to disk and pasted into
// tickets; it must be safe to hand to somebody who is not entitled to the
// conversation. Turn STRUCTURE — who spoke, when, for how many characters — is
// what actually answers "did the agent get cut off", and it carries none of the
// content.
//
// ─── PROVIDER CONTRACT ──────────────────────────────────────────────
// GET /v2/get-call/{call_id}, docs.retellai.com/api-references/get-call,
// reviewed 2026-08-02. EVERY field below is documented OPTIONAL except
// call_id, agent_id, agent_version, call_status and call_type — so nothing here
// assumes a field exists, and a missing one is reported as missing rather than
// defaulted to something that reads like a measurement.
//
// Pure + dep-free.

const { maskAuNumber } = require("./au-phone-speech");
const analysisModule = require("./retell-call-analysis");

const DIAGNOSTICS_VERSION = "retell-call-diagnostics-2026-08-02";

// ── Documented provider enums (reviewed 2026-08-02) ─────────────────

const CALL_STATUSES = Object.freeze(["registered", "not_connected", "ongoing", "ended", "error"]);
const CALL_TYPES = Object.freeze(["web_call", "phone_call"]);
const DIRECTIONS = Object.freeze(["inbound", "outbound"]);

/** Documented `disconnection_reason` values, verbatim and complete. */
const DISCONNECTION_REASONS = Object.freeze([
  "user_hangup", "agent_hangup", "call_transfer", "voicemail_reached", "ivr_reached",
  "inactivity", "max_duration_reached", "concurrency_limit_reached", "no_concurrency_fallback",
  "no_valid_payment", "scam_detected", "dial_busy", "dial_failed", "dial_no_answer",
  "invalid_destination", "telephony_provider_permission_denied", "telephony_provider_unavailable",
  "sip_routing_error", "marked_as_spam", "user_declined", "error_llm_websocket_open",
  "error_llm_websocket_lost_connection", "error_llm_websocket_runtime",
  "error_llm_websocket_corrupt_payload", "error_no_audio_received", "error_asr", "error_retell",
  "error_unknown", "error_user_not_joined", "registered_call_timeout", "transfer_bridged",
  "transfer_cancelled", "manual_stopped", "call_take_over",
]);

/** Documented `latency` sub-objects. */
const LATENCY_COMPONENTS = Object.freeze(["e2e", "asr", "llm", "llm_websocket_network_rtt", "tts", "knowledge_base", "s2s"]);

/** Documented CallLatency metrics. `values` is deliberately excluded — see summariseLatency. */
const LATENCY_METRICS = Object.freeze(["p50", "p90", "p95", "p99", "max", "min", "num"]);

/** Documented transcript roles, including the non-utterance entries. */
const SPEAKING_ROLES = Object.freeze(["agent", "user", "transfer_target"]);
const NON_SPEAKING_ROLES = Object.freeze(["tool_call_invocation", "tool_call_result", "node_transition", "dtmf", "sms", "injected"]);

// ── AIDA's diagnostic categories ────────────────────────────────────

const DIAGNOSTIC_CATEGORIES = Object.freeze({
  normalCompletion: "normal_completion",
  userDisconnected: "user_disconnected",
  agentDisconnected: "agent_disconnected",
  transfer: "transfer",
  voicemail: "voicemail",
  providerError: "provider_error",
  timeout: "timeout",
  silenceTimeout: "silence_timeout",
  maximumDuration: "maximum_duration",
  notConnected: "not_connected",
  accountLimit: "account_limit",
  blocked: "blocked",
  manuallyStopped: "manually_stopped",
  takenOver: "taken_over",
  inProgress: "in_progress",
  incompleteEvidence: "incomplete_evidence",
  unknown: "unknown",
});

/**
 * Documented reason → AIDA category. Every documented value is mapped, so an
 * unmapped string is genuinely undocumented rather than an oversight here.
 *
 * The mapping is a RENAMING, not an inference: each entry is what the provider
 * already said, grouped. That is why a category derived through this table is
 * evidence level PROVIDER_CLASSIFIED, and everything else is not.
 */
const REASON_CATEGORIES = Object.freeze({
  user_hangup: DIAGNOSTIC_CATEGORIES.userDisconnected,
  user_declined: DIAGNOSTIC_CATEGORIES.userDisconnected,
  agent_hangup: DIAGNOSTIC_CATEGORIES.agentDisconnected,
  call_transfer: DIAGNOSTIC_CATEGORIES.transfer,
  transfer_bridged: DIAGNOSTIC_CATEGORIES.transfer,
  transfer_cancelled: DIAGNOSTIC_CATEGORIES.transfer,
  voicemail_reached: DIAGNOSTIC_CATEGORIES.voicemail,
  ivr_reached: DIAGNOSTIC_CATEGORIES.voicemail,
  inactivity: DIAGNOSTIC_CATEGORIES.silenceTimeout,
  max_duration_reached: DIAGNOSTIC_CATEGORIES.maximumDuration,
  registered_call_timeout: DIAGNOSTIC_CATEGORIES.timeout,
  concurrency_limit_reached: DIAGNOSTIC_CATEGORIES.accountLimit,
  no_concurrency_fallback: DIAGNOSTIC_CATEGORIES.accountLimit,
  no_valid_payment: DIAGNOSTIC_CATEGORIES.accountLimit,
  scam_detected: DIAGNOSTIC_CATEGORIES.blocked,
  marked_as_spam: DIAGNOSTIC_CATEGORIES.blocked,
  dial_busy: DIAGNOSTIC_CATEGORIES.notConnected,
  dial_failed: DIAGNOSTIC_CATEGORIES.notConnected,
  dial_no_answer: DIAGNOSTIC_CATEGORIES.notConnected,
  invalid_destination: DIAGNOSTIC_CATEGORIES.notConnected,
  sip_routing_error: DIAGNOSTIC_CATEGORIES.notConnected,
  telephony_provider_permission_denied: DIAGNOSTIC_CATEGORIES.notConnected,
  telephony_provider_unavailable: DIAGNOSTIC_CATEGORIES.notConnected,
  error_user_not_joined: DIAGNOSTIC_CATEGORIES.notConnected,
  error_llm_websocket_open: DIAGNOSTIC_CATEGORIES.providerError,
  error_llm_websocket_lost_connection: DIAGNOSTIC_CATEGORIES.providerError,
  error_llm_websocket_runtime: DIAGNOSTIC_CATEGORIES.providerError,
  error_llm_websocket_corrupt_payload: DIAGNOSTIC_CATEGORIES.providerError,
  error_no_audio_received: DIAGNOSTIC_CATEGORIES.providerError,
  error_asr: DIAGNOSTIC_CATEGORIES.providerError,
  error_retell: DIAGNOSTIC_CATEGORIES.providerError,
  error_unknown: DIAGNOSTIC_CATEGORIES.providerError,
  manual_stopped: DIAGNOSTIC_CATEGORIES.manuallyStopped,
  call_take_over: DIAGNOSTIC_CATEGORIES.takenOver,
});

/** Reasons the provider itself classifies as an error condition. */
const PROVIDER_ERROR_REASONS = Object.freeze(Object.keys(REASON_CATEGORIES).filter((r) => REASON_CATEGORIES[r] === DIAGNOSTIC_CATEGORIES.providerError));

const EVIDENCE_LEVELS = Object.freeze({
  providerClassified: "provider_classified",
  observed: "observed",
  unproven: "unproven",
  none: "none",
});

/**
 * AIDA DIAGNOSTIC HEURISTICS — NOT PROVIDER GUARANTEES.
 *
 * Retell publishes no "acceptable latency" figure, and these are not one. They
 * are the numbers above which a human should go and look, chosen so that a
 * report says "worth investigating" rather than "too slow". Every threshold
 * that fires is labelled with this source string in the output so nobody can
 * quote a breach as a provider SLA.
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  source: "aida_diagnostic_heuristic",
  llmP95Ms: 3000,
  ttsP95Ms: 2000,
  e2eP95Ms: 4000,
  knowledgeBaseP95Ms: 3000,
  // Below this, a "call" is more likely to be a failed join than a conversation.
  shortCallMs: 5000,
  // A final agent turn longer than this that ends without terminal punctuation
  // is more interesting than a short one, which is often just a backchannel.
  incompleteTurnMinChars: 15,
});

// ── Small helpers ───────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function finiteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Does this text end as though the speaker finished?
 *
 * A HEURISTIC, and labelled as one everywhere it is used. Terminal punctuation
 * is what a TTS engine is given for a completed sentence; a turn ending without
 * it is *consistent with* being cut off. It is not proof — a model can end a
 * turn without punctuation, and a caller can be interrupted mid-word by design.
 */
function endsCleanly(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return /[.!?…"')\]]$/.test(trimmed);
}

// ── Latency ─────────────────────────────────────────────────────────

/**
 * Summarise the documented latency object.
 *
 * `values` (the full array of measurements) is deliberately dropped: it is
 * unbounded, it is not needed to answer "was this slow", and a diagnostic
 * report that grows with call length stops being readable.
 */
function summariseLatency(latency) {
  if (!isPlainObject(latency)) {
    return Object.freeze({ present: false, components: Object.freeze({}), componentsPresent: Object.freeze([]), missing: Object.freeze([...LATENCY_COMPONENTS]) });
  }
  const components = {};
  const present = [];
  const missing = [];
  for (const name of LATENCY_COMPONENTS) {
    const raw = latency[name];
    if (!isPlainObject(raw)) { missing.push(name); continue; }
    const metrics = {};
    let any = false;
    for (const metric of LATENCY_METRICS) {
      const value = finiteNumber(raw[metric]);
      if (value !== null) { metrics[metric] = value; any = true; }
    }
    if (!any) { missing.push(name); continue; }
    components[name] = Object.freeze(metrics);
    present.push(name);
  }
  return Object.freeze({
    present: present.length > 0,
    components: Object.freeze(components),
    componentsPresent: Object.freeze(present),
    missing: Object.freeze(missing),
  });
}

/**
 * Which heuristic thresholds a latency summary exceeds.
 * Each breach carries its own threshold and the source label, so a reader never
 * has to go and find out where the number came from.
 */
function findLatencyBreaches(latencySummary, thresholds) {
  const checks = [
    { component: "llm", metric: "p95", limit: thresholds.llmP95Ms },
    { component: "tts", metric: "p95", limit: thresholds.ttsP95Ms },
    { component: "e2e", metric: "p95", limit: thresholds.e2eP95Ms },
    { component: "knowledge_base", metric: "p95", limit: thresholds.knowledgeBaseP95Ms },
  ];
  const breaches = [];
  for (const check of checks) {
    const component = latencySummary.components[check.component];
    if (!component) continue;
    const observed = finiteNumber(component[check.metric]);
    if (observed === null || !(observed > check.limit)) continue;
    breaches.push(Object.freeze({
      component: check.component,
      metric: check.metric,
      observedMs: observed,
      thresholdMs: check.limit,
      thresholdSource: thresholds.source,
      note: "an AIDA diagnostic heuristic, not a provider guarantee",
    }));
  }
  return Object.freeze(breaches);
}

// ── Transcript timeline ─────────────────────────────────────────────

/**
 * Turn STRUCTURE, never turn content.
 *
 * Built from `transcript_object` (documented: role, content, words[] with
 * per-word start/end in seconds). Word timings are what make this useful: they
 * give the moment a turn actually stopped, which is the difference between "the
 * agent stopped talking" and "the call ended".
 */
function summariseTimeline(body, thresholds) {
  const utterances = Array.isArray(body.transcript_object) ? body.transcript_object : null;
  const withTools = Array.isArray(body.transcript_with_tool_calls) ? body.transcript_with_tool_calls : null;

  if (!utterances) {
    return Object.freeze({
      present: false,
      turnCount: 0,
      turns: Object.freeze([]),
      lastCompletedSpeaker: null,
      finalTurnRole: null,
      finalTurnAppearsIncomplete: null,
      finalEventAtSeconds: null,
      toolCallCount: withTools ? withTools.filter((u) => u && u.role === "tool_call_invocation").length : 0,
      agentTurns: 0,
      userTurns: 0,
    });
  }

  const turns = [];
  let finalEventAtSeconds = null;

  utterances.forEach((utterance, index) => {
    if (!isPlainObject(utterance)) return;
    const role = typeof utterance.role === "string" ? utterance.role : null;
    const content = typeof utterance.content === "string" ? utterance.content : "";
    const words = Array.isArray(utterance.words) ? utterance.words : [];
    const starts = words.map((w) => finiteNumber(w && w.start)).filter((n) => n !== null);
    const ends = words.map((w) => finiteNumber(w && w.end)).filter((n) => n !== null);
    const startSeconds = starts.length ? Math.min(...starts) : null;
    const endSeconds = ends.length ? Math.max(...ends) : null;
    if (endSeconds !== null && (finalEventAtSeconds === null || endSeconds > finalEventAtSeconds)) finalEventAtSeconds = endSeconds;

    turns.push(Object.freeze({
      index,
      role,
      speaking: SPEAKING_ROLES.includes(role),
      // Length, not text. Enough to tell a one-word acknowledgement from a
      // paragraph that got cut off.
      characterCount: content.length,
      wordCount: words.length,
      startSeconds,
      endSeconds,
      durationSeconds: startSeconds !== null && endSeconds !== null ? Number((endSeconds - startSeconds).toFixed(3)) : null,
      // HEURISTIC. See endsCleanly.
      endsWithTerminalPunctuation: endsCleanly(content),
    }));
  });

  const speaking = turns.filter((t) => t.speaking);
  const finalTurn = speaking.length ? speaking[speaking.length - 1] : null;
  // "Last COMPLETED speaker" means the last speaking turn that looks finished —
  // deliberately different from "last speaker", because when the two disagree
  // that disagreement is the interesting evidence.
  const lastCompleted = [...speaking].reverse().find((t) => t.endsWithTerminalPunctuation === true) || null;

  const finalTurnAppearsIncomplete = finalTurn
    ? finalTurn.endsWithTerminalPunctuation === false && finalTurn.characterCount >= thresholds.incompleteTurnMinChars
    : null;

  return Object.freeze({
    present: true,
    turnCount: turns.length,
    turns: Object.freeze(turns),
    lastCompletedSpeaker: lastCompleted ? lastCompleted.role : null,
    finalTurnRole: finalTurn ? finalTurn.role : null,
    finalTurnAppearsIncomplete,
    finalEventAtSeconds,
    toolCallCount: withTools ? withTools.filter((u) => isPlainObject(u) && u.role === "tool_call_invocation").length : 0,
    agentTurns: speaking.filter((t) => t.role === "agent").length,
    userTurns: speaking.filter((t) => t.role === "user").length,
  });
}

// ── Connection ──────────────────────────────────────────────────────

/**
 * Was there actually a conversation?
 *
 * Answered "yes" only on positive evidence — someone spoke, or the provider
 * reported a duration. "unknown" is a real answer here: a call that ended with
 * no transcript and no duration might have connected silently.
 */
function assessConnection(body, timeline) {
  const status = typeof body.call_status === "string" ? body.call_status : null;
  if (status === "not_connected") return { connected: false, evidence: EVIDENCE_LEVELS.providerClassified, why: "call_status was \"not_connected\"" };
  if (status === "registered") return { connected: false, evidence: EVIDENCE_LEVELS.providerClassified, why: "call_status was \"registered\" — the call was created but never joined" };
  if (timeline.present && timeline.turnCount > 0) return { connected: true, evidence: EVIDENCE_LEVELS.observed, why: `${timeline.turnCount} transcript turn(s) were returned` };
  const duration = finiteNumber(body.duration_ms);
  if (duration !== null && duration > 0) return { connected: true, evidence: EVIDENCE_LEVELS.observed, why: `duration_ms was ${duration}` };
  if (status === "ongoing") return { connected: true, evidence: EVIDENCE_LEVELS.providerClassified, why: "call_status was \"ongoing\"" };
  return { connected: null, evidence: EVIDENCE_LEVELS.none, why: "no transcript, no duration and no status that settles it" };
}

// ── Categorisation ──────────────────────────────────────────────────

function categorise(body, connection) {
  const status = typeof body.call_status === "string" ? body.call_status : null;
  const rawReason = typeof body.disconnection_reason === "string" ? body.disconnection_reason : null;
  const documented = rawReason !== null && DISCONNECTION_REASONS.includes(rawReason);

  if (documented) {
    const category = REASON_CATEGORIES[rawReason] || DIAGNOSTIC_CATEGORIES.unknown;
    return {
      category,
      evidence: EVIDENCE_LEVELS.providerClassified,
      why: `the provider reported disconnection_reason "${rawReason}"`,
      documented: true,
    };
  }

  if (rawReason !== null) {
    // An undocumented string. The RAW value is preserved on the summary rather
    // than mapped by guesswork: a reason we do not recognise is exactly the kind
    // of thing that later turns out to explain something.
    return {
      category: DIAGNOSTIC_CATEGORIES.unknown,
      evidence: EVIDENCE_LEVELS.observed,
      why: "the provider reported a disconnection_reason this build does not recognise; the raw value is preserved",
      documented: false,
    };
  }

  if (status === "error") return { category: DIAGNOSTIC_CATEGORIES.providerError, evidence: EVIDENCE_LEVELS.providerClassified, why: "call_status was \"error\"", documented: false };
  if (status === "ongoing") return { category: DIAGNOSTIC_CATEGORIES.inProgress, evidence: EVIDENCE_LEVELS.observed, why: "the call had not ended when it was read", documented: false };
  if (status === "not_connected" || status === "registered") return { category: DIAGNOSTIC_CATEGORIES.notConnected, evidence: EVIDENCE_LEVELS.providerClassified, why: `call_status was "${status}"`, documented: false };
  if (status === "ended" && connection.connected === true) {
    // Ended, connected, and the provider offered no reason. That is NOT
    // "normal completion" — it is an absence of evidence, and the two must not
    // be spelled the same way.
    return { category: DIAGNOSTIC_CATEGORIES.incompleteEvidence, evidence: EVIDENCE_LEVELS.observed, why: "the call ended but the provider returned no disconnection_reason", documented: false };
  }
  return { category: DIAGNOSTIC_CATEGORIES.unknown, evidence: EVIDENCE_LEVELS.none, why: "the response carried neither a usable call_status nor a disconnection_reason", documented: false };
}

// ── The summary ─────────────────────────────────────────────────────

/**
 * Fields this build models. Anything else in the response is reported by NAME
 * only under `unknownFields`, so a provider addition is noticed without its
 * value being copied anywhere.
 */
const MODELLED_FIELDS = Object.freeze([
  "call_id", "agent_id", "agent_name", "agent_version", "agent_tag", "call_status", "call_type",
  "direction", "from_number", "to_number", "telephony_identifier", "metadata",
  "retell_llm_dynamic_variables", "collected_dynamic_variables", "custom_sip_headers",
  "data_storage_setting", "opt_in_signed_url", "start_timestamp", "end_timestamp",
  "transfer_end_timestamp", "transfer_destination", "duration_ms", "transcript",
  "transcript_object", "transcript_with_tool_calls", "scrubbed_transcript_with_tool_calls",
  "recording_url", "recording_multi_channel_url", "scrubbed_recording_url",
  "scrubbed_recording_multi_channel_url", "public_log_url", "knowledge_base_retrieved_contents_url",
  "latency", "disconnection_reason", "call_analysis", "call_cost", "llm_token_usage", "access_token",
]);

/** Never copied into a summary, whatever the flags say. */
const NEVER_EMITTED_FIELDS = Object.freeze([
  "access_token", "recording_url", "recording_multi_channel_url", "scrubbed_recording_url",
  "scrubbed_recording_multi_channel_url", "public_log_url", "knowledge_base_retrieved_contents_url",
  "transcript", "transcript_object", "transcript_with_tool_calls", "scrubbed_transcript_with_tool_calls",
  "custom_sip_headers",
]);

/**
 * Turn a Get Call response into a sanitised diagnostic summary.
 *
 * @param {object} body                   parsed Get Call response
 * @param {object} [options]
 * @param {object} [options.thresholds]   overrides for DEFAULT_THRESHOLDS
 * @param {boolean} [options.includeContent] include transcript text. OFF by
 *        default, requires an explicit flag, and even then the content is
 *        returned SEPARATELY (see `content`) so it can be printed without ever
 *        being written into the summary a manifest would persist.
 */
function summariseCall(body, { thresholds: overrides = {}, includeContent = false } = {}) {
  const thresholds = Object.freeze({ ...DEFAULT_THRESHOLDS, ...overrides, source: DEFAULT_THRESHOLDS.source });

  if (!isPlainObject(body)) {
    return Object.freeze({
      version: DIAGNOSTICS_VERSION,
      ok: false,
      reason: "the provider returned no call object",
      callId: null,
      category: DIAGNOSTIC_CATEGORIES.incompleteEvidence,
      categoryEvidence: EVIDENCE_LEVELS.none,
    });
  }

  const timeline = summariseTimeline(body, thresholds);
  const connection = assessConnection(body, timeline);
  const classification = categorise(body, connection);
  const latency = summariseLatency(body.latency);
  const readiness = analysisModule.classifyAnalysisReadiness(body);

  const status = typeof body.call_status === "string" ? body.call_status : null;
  const callType = typeof body.call_type === "string" ? body.call_type : null;
  const direction = typeof body.direction === "string" ? body.direction : null;
  const rawReason = typeof body.disconnection_reason === "string" ? body.disconnection_reason : null;

  const missing = [];
  for (const field of ["start_timestamp", "end_timestamp", "duration_ms", "disconnection_reason", "latency", "transcript_object", "call_analysis"]) {
    if (body[field] === undefined || body[field] === null) missing.push(field);
  }

  const unknownFields = Object.keys(body).filter((k) => !MODELLED_FIELDS.includes(k));

  const startTimestamp = finiteNumber(body.start_timestamp);
  const endTimestamp = finiteNumber(body.end_timestamp);
  const durationMs = finiteNumber(body.duration_ms);

  const summary = {
    version: DIAGNOSTICS_VERSION,
    ok: true,

    // ── Identity ───────────────────────────────────────────────────
    callId: typeof body.call_id === "string" ? body.call_id : null,
    callType: CALL_TYPES.includes(callType) ? callType : null,
    callTypeRecognised: CALL_TYPES.includes(callType),
    direction: DIRECTIONS.includes(direction) ? direction : null,
    agentId: typeof body.agent_id === "string" ? body.agent_id : null,
    agentVersion: finiteNumber(body.agent_version),
    agentName: typeof body.agent_name === "string" ? body.agent_name : null,

    // ── Lifecycle ──────────────────────────────────────────────────
    callStatus: CALL_STATUSES.includes(status) ? status : null,
    callStatusRecognised: CALL_STATUSES.includes(status),
    rawCallStatus: CALL_STATUSES.includes(status) ? null : status,
    startTimestamp,
    endTimestamp,
    durationMs,
    // Derived rather than trusted: when both timestamps are present they are a
    // cross-check on duration_ms, and a disagreement is worth seeing.
    derivedDurationMs: startTimestamp !== null && endTimestamp !== null ? endTimestamp - startTimestamp : null,

    // ── Disconnection ──────────────────────────────────────────────
    disconnectionReason: classification.documented ? rawReason : null,
    // Preserved verbatim when undocumented — never dropped, never mapped.
    rawDisconnectionReason: classification.documented ? null : rawReason,
    disconnectionDocumented: classification.documented,

    // ── Classification ─────────────────────────────────────────────
    category: classification.category,
    categoryEvidence: classification.evidence,
    categoryBasis: classification.why,
    providerReportedError: rawReason !== null && PROVIDER_ERROR_REASONS.includes(rawReason),

    // ── Connection ─────────────────────────────────────────────────
    connected: connection.connected,
    connectionEvidence: connection.evidence,
    connectionBasis: connection.why,

    // ── Evidence bundles ───────────────────────────────────────────
    latency,
    latencyBreaches: findLatencyBreaches(latency, thresholds),
    timeline,
    analysis: Object.freeze({ state: readiness.state, reason: readiness.reason, fieldsPresent: readiness.fieldsPresent, hasCustomData: readiness.hasCustomData }),

    // ── Presence flags, not the things themselves ──────────────────
    evidence: Object.freeze({
      transcriptPresent: typeof body.transcript === "string" && body.transcript.length > 0,
      transcriptObjectPresent: Array.isArray(body.transcript_object),
      recordingPresent: typeof body.recording_url === "string" && body.recording_url.length > 0,
      publicLogPresent: typeof body.public_log_url === "string" && body.public_log_url.length > 0,
      latencyPresent: latency.present,
      analysisPresent: readiness.state === analysisModule.ANALYSIS_STATES.ready,
      costPresent: isPlainObject(body.call_cost),
      tokenUsagePresent: isPlainObject(body.llm_token_usage),
      dynamicVariablesPresent: isPlainObject(body.retell_llm_dynamic_variables),
      // NAMES only. The values are per-call runtime data, and one of them is a
      // phone number.
      dynamicVariableKeys: isPlainObject(body.retell_llm_dynamic_variables) ? Object.freeze(Object.keys(body.retell_llm_dynamic_variables).slice(0, 40)) : Object.freeze([]),
    }),

    // ── Numbers, masked ────────────────────────────────────────────
    numbers: Object.freeze({
      from: maskAuNumber(body.from_number),
      to: maskAuNumber(body.to_number),
      transferDestination: maskAuNumber(body.transfer_destination),
    }),

    // ── Cost, which carries no personal data ───────────────────────
    cost: isPlainObject(body.call_cost)
      ? Object.freeze({
        combinedCost: finiteNumber(body.call_cost.combined_cost),
        totalDurationSeconds: finiteNumber(body.call_cost.total_duration_seconds),
        productCount: Array.isArray(body.call_cost.product_costs) ? body.call_cost.product_costs.length : 0,
      })
      : null,

    missing: Object.freeze(missing),
    unknownFields: Object.freeze(unknownFields),
    thresholds,
  };

  // The content channel. Separate object, never merged into the summary, so a
  // caller that persists `summary` cannot persist transcript text by accident
  // even with the flag on.
  const content = includeContent
    ? Object.freeze({
      warning: "TRANSCRIPT CONTENT — a real conversation with a real person. Do not persist, paste or forward this.",
      transcript: typeof body.transcript === "string" ? body.transcript : null,
    })
    : null;

  return Object.freeze({ ...summary, content });
}

/**
 * Assert a summary carries nothing it should not.
 *
 * Belt and braces over a module that is already careful, because the cost of
 * being wrong is a customer's conversation in a ticket. Returns the offending
 * paths rather than throwing, so a caller can fail loudly with detail.
 */
function findSensitiveLeaks(summary) {
  const leaks = [];
  const seen = new Set();

  function walk(value, path, depth) {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) leaks.push({ path, kind: "url" });
      // Retell access tokens are long opaque strings; any long unbroken token
      // in a diagnostic summary is wrong regardless of what produced it.
      //
      // Snake_case identifiers are excluded because provider enum values are
      // snake_case and can be long: an undocumented disconnection reason like
      // "error_some_future_reason_not_yet_documented" is 43 characters and was
      // flagged as a token by the first version of this check. It is a value we
      // deliberately preserve, so a detector that hides it defeats the point.
      else if (/^[A-Za-z0-9_\-.]{40,}$/.test(value) && !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(value)) leaks.push({ path, kind: "token_like" });
      else if (/\+\d{8,15}/.test(value)) leaks.push({ path, kind: "phone_number" });
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_EMITTED_FIELDS.includes(k)) { leaks.push({ path: `${path}.${k}`, kind: "forbidden_field" }); continue; }
      walk(v, `${path}.${k}`, depth + 1);
    }
  }

  // `content` is the deliberate, flag-gated exception and is excluded — it is
  // never part of what gets persisted.
  const { content, ...rest } = summary || {};
  walk(rest, "summary", 0);
  return leaks;
}

// ── The dropout evidence report ─────────────────────────────────────

/**
 * Answer, from evidence alone, what can and cannot be said about how a call
 * ended. This is the module's actual product: the M7D dropout question, asked
 * in a form that can be answered the same way twice.
 *
 * `findings` are statements with an evidence level attached. `unknowns` are the
 * questions this response cannot settle. `cause` is null unless the provider
 * itself classified the disconnect — there is no path in this function that
 * promotes an observation to a cause.
 */
function buildDropoutEvidenceReport(summary, { thresholds: overrides = {} } = {}) {
  const thresholds = Object.freeze({ ...DEFAULT_THRESHOLDS, ...overrides, source: DEFAULT_THRESHOLDS.source });

  if (!summary || summary.ok !== true) {
    return Object.freeze({
      version: DIAGNOSTICS_VERSION,
      callId: (summary && summary.callId) || null,
      cause: null,
      causeEvidence: EVIDENCE_LEVELS.none,
      sufficientEvidence: false,
      findings: Object.freeze([]),
      unknowns: Object.freeze(["No call object was returned, so nothing can be established."]),
      conclusion: "No evidence was available. Nothing can be concluded.",
      thresholds,
    });
  }

  const findings = [];
  const unknowns = [];
  const add = (level, statement) => findings.push(Object.freeze({ evidence: level, statement }));

  // ── Connection ─────────────────────────────────────────────────
  if (summary.connected === true) add(summary.connectionEvidence, `The call connected — ${summary.connectionBasis}.`);
  else if (summary.connected === false) add(summary.connectionEvidence, `The call did not connect — ${summary.connectionBasis}.`);
  else unknowns.push("Whether the call ever connected: no transcript, no duration and no settling status.");

  // ── Type and lifecycle ─────────────────────────────────────────
  if (summary.callType) add(EVIDENCE_LEVELS.observed, `It was a ${summary.callType.replace("_", " ")}${summary.direction ? ` (${summary.direction})` : ""}.`);
  else unknowns.push("The call type was absent or not a documented value.");

  if (summary.callStatus) add(EVIDENCE_LEVELS.observed, `Final call_status was "${summary.callStatus}".`);
  else if (summary.rawCallStatus) unknowns.push(`call_status was "${String(summary.rawCallStatus).slice(0, 40)}", which is not a documented value.`);
  else unknowns.push("The response carried no call_status.");

  if (summary.durationMs !== null) add(EVIDENCE_LEVELS.observed, `Duration was ${summary.durationMs}ms.`);
  if (summary.durationMs !== null && summary.derivedDurationMs !== null && Math.abs(summary.durationMs - summary.derivedDurationMs) > 1000) {
    add(EVIDENCE_LEVELS.observed, `duration_ms (${summary.durationMs}ms) and the start/end timestamps (${summary.derivedDurationMs}ms) disagree by more than a second.`);
  }

  // ── What the provider said ─────────────────────────────────────
  if (summary.disconnectionDocumented) {
    add(EVIDENCE_LEVELS.providerClassified, `Retell classified the disconnect as "${summary.disconnectionReason}".`);
  } else if (summary.rawDisconnectionReason) {
    add(EVIDENCE_LEVELS.observed, `Retell returned disconnection_reason "${String(summary.rawDisconnectionReason).slice(0, 60)}", which this build does not recognise.`);
    unknowns.push("What that undocumented disconnection reason means.");
  } else {
    unknowns.push("Why the call ended: Retell returned no disconnection_reason.");
  }

  if (summary.providerReportedError) add(EVIDENCE_LEVELS.providerClassified, "Retell reported this as an error condition on its side.");

  // ── Turn structure ─────────────────────────────────────────────
  if (summary.timeline.present) {
    add(EVIDENCE_LEVELS.observed, `${summary.timeline.turnCount} turn(s): ${summary.timeline.agentTurns} from the agent, ${summary.timeline.userTurns} from the caller.`);
    if (summary.timeline.lastCompletedSpeaker) add(EVIDENCE_LEVELS.observed, `The last turn that ended in terminal punctuation was the ${summary.timeline.lastCompletedSpeaker}'s.`);
    else unknowns.push("Which speaker last completed a turn: no turn ended in terminal punctuation.");

    if (summary.timeline.finalTurnAppearsIncomplete === true) {
      // THE line this whole module exists to get right.
      add(EVIDENCE_LEVELS.observed, `The final ${summary.timeline.finalTurnRole} turn does not end in terminal punctuation, which is CONSISTENT WITH being cut off but does not establish it.`);
      unknowns.push("Whether that final turn was actually interrupted, and by what: no provider field reports it.");
    } else if (summary.timeline.finalTurnAppearsIncomplete === false) {
      add(EVIDENCE_LEVELS.observed, `The final ${summary.timeline.finalTurnRole} turn ends in terminal punctuation.`);
    }
    if (summary.timeline.finalEventAtSeconds !== null) add(EVIDENCE_LEVELS.observed, `The last word timing in the transcript is at ${summary.timeline.finalEventAtSeconds}s.`);
  } else {
    unknowns.push("The shape of the conversation: no transcript_object was returned.");
  }

  // ── Latency ────────────────────────────────────────────────────
  if (summary.latency.present) {
    add(EVIDENCE_LEVELS.observed, `Latency metrics present for: ${summary.latency.componentsPresent.join(", ")}.`);
    for (const breach of summary.latencyBreaches) {
      add(EVIDENCE_LEVELS.observed, `${breach.component} ${breach.metric} was ${breach.observedMs}ms, above AIDA's ${breach.thresholdMs}ms diagnostic heuristic (${breach.thresholdSource} — not a provider guarantee).`);
    }
    if (summary.latencyBreaches.length) unknowns.push("Whether that latency is related to how the call ended: elevated latency and a disconnect are not linked by any field in this response.");
  } else {
    unknowns.push("Latency: the response carried no latency object, so slow generation can be neither shown nor ruled out.");
  }

  // ── Analysis ───────────────────────────────────────────────────
  add(EVIDENCE_LEVELS.observed, `Post-call analysis: ${summary.analysis.state}${summary.analysis.reason ? ` — ${summary.analysis.reason}` : ""}.`);

  // ── Cause ──────────────────────────────────────────────────────
  // A cause is assigned ONLY from a documented provider classification. Nothing
  // else in this function can set it. The categories below are excluded because
  // they name an absence rather than an event.
  const inconclusive = [DIAGNOSTIC_CATEGORIES.unknown, DIAGNOSTIC_CATEGORIES.incompleteEvidence, DIAGNOSTIC_CATEGORIES.inProgress];
  const hasCause = summary.categoryEvidence === EVIDENCE_LEVELS.providerClassified && !inconclusive.includes(summary.category);

  // Things that remain possible whenever the provider did not say. Listed as
  // UNPROVEN so a reader can see they were considered and not established —
  // which is the difference between "we don't know" and "we didn't look".
  if (!hasCause && summary.connected === true) {
    unknowns.push("Client-side or transport causes — browser connectivity, a websocket close, local audio, an interruption — remain possible and are not observable in a Get Call response.");
  }

  const conclusion = hasCause
    ? `Retell classified this call as ${summary.category} (${summary.disconnectionReason}).`
    : summary.timeline.finalTurnAppearsIncomplete === true
      ? "An incomplete final turn was observed. Retell did not provide a disconnection reason or provider error establishing the cause. Browser connectivity, interruption and transport termination remain possible but unproven."
      : "There is not enough evidence in this response to assign a cause.";

  return Object.freeze({
    version: DIAGNOSTICS_VERSION,
    callId: summary.callId,
    cause: hasCause ? summary.category : null,
    causeEvidence: hasCause ? EVIDENCE_LEVELS.providerClassified : EVIDENCE_LEVELS.unproven,
    sufficientEvidence: hasCause,
    findings: Object.freeze(findings),
    unknowns: Object.freeze(unknowns),
    conclusion,
    thresholds,
  });
}

module.exports = {
  DIAGNOSTICS_VERSION,
  CALL_STATUSES,
  CALL_TYPES,
  DIRECTIONS,
  DISCONNECTION_REASONS,
  LATENCY_COMPONENTS,
  LATENCY_METRICS,
  SPEAKING_ROLES,
  NON_SPEAKING_ROLES,
  DIAGNOSTIC_CATEGORIES,
  REASON_CATEGORIES,
  PROVIDER_ERROR_REASONS,
  EVIDENCE_LEVELS,
  DEFAULT_THRESHOLDS,
  MODELLED_FIELDS,
  NEVER_EMITTED_FIELDS,
  summariseCall,
  summariseLatency,
  summariseTimeline,
  findLatencyBreaches,
  findSensitiveLeaks,
  buildDropoutEvidenceReport,
};
