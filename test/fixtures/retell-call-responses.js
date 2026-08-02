// Deterministic Retell Get Call fixtures (M7E).
//
// ─── THE RULE THESE FIXTURES EXIST TO OBEY ──────────────────────────
// M7D found four provider mismatches that a fully green suite had missed, and
// all four had the same cause: the test fakes were RICHER than the real
// provider boundary. A fake that accepts anything cannot catch a wire-format
// error — it hides one.
//
// So every object below carries ONLY fields documented on
// docs.retellai.com/api-references/get-call (reviewed 2026-08-02), with the
// documented types and the documented enum spellings. Nothing is added because
// it would be convenient to assert against. Where a field is documented as
// optional and would be absent in reality, it is ABSENT here — that is the
// whole point, and it is why several fixtures look sparse.
//
// ─── CONTENT ────────────────────────────────────────────────────────
// Transcript text is fictional, minimal and about a made-up locksmith. Phone
// numbers are from the ACMA fictitious range (0491 570 006–156), which is
// reserved so it can never reach a real person. No real business, customer,
// address or number appears anywhere.

// A stable fake token shape. Long and opaque like the real thing, so the
// leak-detection tests are exercising something realistic — and deliberately
// self-describing so it can never be mistaken for a live credential.
const FAKE_ACCESS_TOKEN = "FAKE-NOT-A-REAL-TOKEN-0000000000000000000000000000000000";

/** A short fictional exchange, reused so timings stay comparable across fixtures. */
function conversation({ finalAgentTurnComplete = true } = {}) {
  return [
    {
      role: "agent",
      content: "Good afternoon, Harbour Locksmith Demo.",
      words: [
        { word: "Good", start: 0.4, end: 0.62 },
        { word: "afternoon,", start: 0.62, end: 1.18 },
        { word: "Harbour", start: 1.18, end: 1.6 },
        { word: "Locksmith", start: 1.6, end: 2.05 },
        { word: "Demo.", start: 2.05, end: 2.4 },
      ],
    },
    {
      role: "user",
      content: "Hi, I'm locked out of my house in Frankston.",
      words: [
        { word: "Hi,", start: 3.1, end: 3.3 },
        { word: "I'm", start: 3.3, end: 3.5 },
        { word: "locked", start: 3.5, end: 3.8 },
        { word: "out", start: 3.8, end: 4.0 },
        { word: "of", start: 4.0, end: 4.1 },
        { word: "my", start: 4.1, end: 4.25 },
        { word: "house", start: 4.25, end: 4.6 },
        { word: "in", start: 4.6, end: 4.7 },
        { word: "Frankston.", start: 4.7, end: 5.3 },
      ],
    },
    {
      role: "agent",
      content: finalAgentTurnComplete
        ? "No trouble at all. Can I take your name and a number to ring you back on?"
        : "No trouble at all. Can I take your name and a number to ring you",
      words: [
        { word: "No", start: 6.0, end: 6.2 },
        { word: "trouble", start: 6.2, end: 6.6 },
        { word: "at", start: 6.6, end: 6.7 },
        { word: "all.", start: 6.7, end: 7.0 },
        { word: "Can", start: 7.3, end: 7.5 },
        { word: "I", start: 7.5, end: 7.6 },
        { word: "take", start: 7.6, end: 7.9 },
        { word: "your", start: 7.9, end: 8.1 },
        { word: "name", start: 8.1, end: 8.4 },
        { word: "and", start: 8.4, end: 8.55 },
        { word: "a", start: 8.55, end: 8.6 },
        { word: "number", start: 8.6, end: 9.0 },
        { word: "to", start: 9.0, end: 9.1 },
        { word: "ring", start: 9.1, end: 9.35 },
        ...(finalAgentTurnComplete
          ? [{ word: "you", start: 9.35, end: 9.55 }, { word: "back", start: 9.55, end: 9.8 }, { word: "on?", start: 9.8, end: 10.1 }]
          : [{ word: "you", start: 9.35, end: 9.55 }]),
      ],
    },
  ];
}

function plainTranscript(utterances) {
  return utterances.map((u) => `${u.role === "agent" ? "Agent" : "User"}: ${u.content}`).join("\n");
}

/** A complete, healthy latency object with every documented component. */
function healthyLatency() {
  return {
    e2e: { p50: 780, p90: 1180, p95: 1350, p99: 1600, max: 1720, min: 520, num: 3 },
    asr: { p50: 120, p90: 190, p95: 210, p99: 240, max: 260, min: 90, num: 3 },
    llm: { p50: 420, p90: 690, p95: 810, p99: 950, max: 1010, min: 300, num: 3 },
    tts: { p50: 260, p90: 400, p95: 460, p99: 520, max: 540, min: 180, num: 3 },
    knowledge_base: { p50: 140, p90: 210, p95: 240, p99: 280, max: 300, min: 110, num: 2 },
  };
}

const BASE_WEB_CALL = {
  call_id: "call_fixture000000000000000001",
  call_type: "web_call",
  access_token: FAKE_ACCESS_TOKEN,
  agent_id: "agent_fixture0000000000000001",
  agent_version: 0,
  agent_name: "AIDA Sandbox Agent FIXTURE",
};

/**
 * 1. A connected web call that completed normally.
 * The agent hung up after the caller was done — the documented, expected shape.
 */
const connectedWebCall = Object.freeze({
  ...BASE_WEB_CALL,
  call_status: "ended",
  start_timestamp: 1754000000000,
  end_timestamp: 1754000012400,
  duration_ms: 12400,
  disconnection_reason: "agent_hangup",
  transcript: plainTranscript(conversation()),
  transcript_object: conversation(),
  latency: healthyLatency(),
  call_cost: { product_costs: [{ product: "retell_platform", unit_price: 0.0007, cost: 8.7 }], total_duration_seconds: 12.4, total_duration_unit_price: 0.0007, combined_cost: 8.7 },
  llm_token_usage: { values: [412, 508, 611], average: 510.3, num_requests: 3 },
  retell_llm_dynamic_variables: {
    current_transfer_number: "+61491570006",
    current_transfer_number_spoken: "oh four nine one, five seven oh, oh oh six",
    current_business_status: "open",
  },
  call_analysis: {
    call_summary: "A caller reported a residential lockout in Frankston and was asked for a callback number.",
    in_voicemail: false,
    user_sentiment: "Neutral",
    call_successful: true,
    custom_analysis_data: { caller_name: "Fictional Caller", suburb: "Frankston" },
  },
});

/** 2. The caller hung up. */
const userHangup = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000002",
  call_status: "ended",
  start_timestamp: 1754000100000,
  end_timestamp: 1754000106200,
  duration_ms: 6200,
  disconnection_reason: "user_hangup",
  transcript_object: conversation().slice(0, 2),
  latency: healthyLatency(),
});

/** 3. The agent hung up, cleanly, after a complete final turn. */
const agentHangup = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000003",
  call_status: "ended",
  start_timestamp: 1754000200000,
  end_timestamp: 1754000211000,
  duration_ms: 11000,
  disconnection_reason: "agent_hangup",
  transcript_object: conversation(),
  latency: healthyLatency(),
});

/**
 * 4. A web call that was created but never joined.
 * `duration_ms`, `transcript_object` and `latency` are ABSENT, not empty —
 * which is what the provider actually returns and what the "analysis will
 * never arrive" branch has to cope with.
 */
const webCallNeverConnected = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000004",
  call_status: "not_connected",
  disconnection_reason: "error_user_not_joined",
  start_timestamp: 1754000300000,
});

/** 5. Retell reported a fault on its own side. */
const providerError = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000005",
  call_status: "error",
  start_timestamp: 1754000400000,
  end_timestamp: 1754000404100,
  duration_ms: 4100,
  disconnection_reason: "error_llm_websocket_lost_connection",
  transcript_object: conversation({ finalAgentTurnComplete: false }),
});

/** 6. Silence timeout — the documented reason is "inactivity". */
const silenceTimeout = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000006",
  call_status: "ended",
  start_timestamp: 1754000500000,
  end_timestamp: 1754000530000,
  duration_ms: 30000,
  disconnection_reason: "inactivity",
  transcript_object: conversation().slice(0, 1),
  latency: healthyLatency(),
});

/** 7. The call hit the configured maximum duration. */
const maximumDuration = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000007",
  call_status: "ended",
  start_timestamp: 1754000600000,
  end_timestamp: 1754000900000,
  duration_ms: 300000,
  disconnection_reason: "max_duration_reached",
  transcript_object: conversation(),
  latency: healthyLatency(),
});

/**
 * 8. THE M7D SHAPE. The call ended during an agent turn, and Retell returned
 * NO disconnection_reason at all. This is the fixture the whole evidence
 * discipline exists for: the final turn is visibly unfinished, and nothing in
 * the response says why. A report that names a cause here is wrong.
 */
const endedDuringAgentTurn = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000008",
  call_status: "ended",
  start_timestamp: 1754000700000,
  end_timestamp: 1754000709600,
  duration_ms: 9600,
  transcript_object: conversation({ finalAgentTurnComplete: false }),
  latency: healthyLatency(),
});

/** 9. Slow LLM. Everything else healthy, so the breach is unambiguous. */
const highLlmLatency = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000009",
  call_status: "ended",
  start_timestamp: 1754000800000,
  end_timestamp: 1754000818000,
  duration_ms: 18000,
  disconnection_reason: "user_hangup",
  transcript_object: conversation(),
  latency: { ...healthyLatency(), llm: { p50: 2600, p90: 4100, p95: 4800, p99: 5200, max: 5400, min: 1900, num: 4 } },
});

/** 10. Slow TTS. */
const highTtsLatency = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000010",
  call_status: "ended",
  start_timestamp: 1754000900000,
  end_timestamp: 1754000914000,
  duration_ms: 14000,
  disconnection_reason: "user_hangup",
  transcript_object: conversation(),
  latency: { ...healthyLatency(), tts: { p50: 1800, p90: 2600, p95: 3100, p99: 3400, max: 3600, min: 1200, num: 4 } },
});

/** 11. No latency object at all — documented optional, and common on short calls. */
const missingLatency = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000011",
  call_status: "ended",
  start_timestamp: 1754001000000,
  end_timestamp: 1754001003000,
  duration_ms: 3000,
  disconnection_reason: "user_hangup",
  transcript_object: conversation().slice(0, 1),
});

/**
 * 12. An undocumented disconnection reason.
 * Invented on purpose: providers add enum values, and the raw string must
 * survive rather than being mapped to the nearest thing we know.
 */
const unknownDisconnectionReason = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000012",
  call_status: "ended",
  start_timestamp: 1754001100000,
  end_timestamp: 1754001108000,
  duration_ms: 8000,
  disconnection_reason: "error_some_future_reason_not_yet_documented",
  transcript_object: conversation(),
});

/** 13. Ended, analysis not yet produced — call_ended carries no call_analysis. */
const analysisPending = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000013",
  call_status: "ended",
  start_timestamp: 1754001200000,
  end_timestamp: 1754001210000,
  duration_ms: 10000,
  disconnection_reason: "agent_hangup",
  transcript_object: conversation(),
  latency: healthyLatency(),
});

/** 14. Analysis ready, with every documented custom type represented. */
const analysisReady = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000014",
  call_status: "ended",
  start_timestamp: 1754001300000,
  end_timestamp: 1754001312000,
  duration_ms: 12000,
  disconnection_reason: "agent_hangup",
  transcript_object: conversation(),
  latency: healthyLatency(),
  call_analysis: {
    call_summary: "A fictional caller asked about a residential lockout.",
    in_voicemail: false,
    user_sentiment: "Positive",
    call_successful: true,
    custom_analysis_data: {
      caller_name: "Fictional Caller",
      urgency: "urgent_now",
      transferred: false,
      attempts: 2,
    },
  },
});

/** 15. Never connected, so no analysis will ever arrive. */
const unconnectedNoAnalysis = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000015",
  call_status: "not_connected",
  disconnection_reason: "dial_no_answer",
});

/** 16. Analysis present but structurally wrong — types the schema did not ask for. */
const malformedAnalysis = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000016",
  call_status: "ended",
  start_timestamp: 1754001400000,
  end_timestamp: 1754001409000,
  duration_ms: 9000,
  disconnection_reason: "agent_hangup",
  call_analysis: {
    call_summary: "A fictional call.",
    user_sentiment: "Ecstatic",           // not a documented value
    call_successful: "yes",               // documented as boolean
    custom_analysis_data: {
      transferred: "no",                  // requested as boolean
      attempts: "two",                    // requested as number
      urgency: "extremely_urgent",        // not one of the requested choices
    },
  },
});

/**
 * 17. The bare minimum a Get Call response guarantees.
 * Only the five required fields. Everything optional is absent.
 */
const minimalRequiredFieldsOnly = Object.freeze({
  call_id: "call_fixture000000000000000017",
  call_type: "web_call",
  access_token: FAKE_ACCESS_TOKEN,
  agent_id: "agent_fixture0000000000000001",
  agent_version: 0,
  call_status: "ended",
});

/** 18. Rich transcript content that must NOT survive into a sanitised summary. */
const transcriptPresentForExclusion = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000018",
  call_status: "ended",
  start_timestamp: 1754001500000,
  end_timestamp: 1754001515000,
  duration_ms: 15000,
  disconnection_reason: "agent_hangup",
  transcript: plainTranscript(conversation()),
  transcript_object: conversation(),
  transcript_with_tool_calls: [
    ...conversation(),
    { role: "tool_call_invocation", tool_call_id: "tool_fixture01", name: "check_service_area", arguments: "{\"suburb\":\"Frankston\"}" },
    { role: "tool_call_result", tool_call_id: "tool_fixture01", content: "{\"covered\":true}" },
  ],
  recording_url: "https://example.com/fixture-recording-does-not-exist.wav",
  public_log_url: "https://example.com/fixture-log-does-not-exist",
  latency: healthyLatency(),
});

/**
 * 19. An inbound PHONE call with both numbers populated.
 * ACMA fictitious range only. Included so masking is proved on the one call
 * type that actually carries caller numbers.
 */
const phoneCallWithNumbers = Object.freeze({
  call_id: "call_fixture000000000000000019",
  call_type: "phone_call",
  direction: "inbound",
  from_number: "+61491570110",
  to_number: "+61491570156",
  agent_id: "agent_fixture0000000000000001",
  agent_version: 0,
  call_status: "ended",
  start_timestamp: 1754001600000,
  end_timestamp: 1754001618000,
  duration_ms: 18000,
  disconnection_reason: "user_hangup",
  transfer_destination: "+61491570006",
  telephony_identifier: { twilio_call_sid: "CAfixture00000000000000000000000001" },
  transcript_object: conversation(),
  latency: healthyLatency(),
});

/**
 * 20. A web call whose access_token is present, as the documented REQUIRED
 * field on a V2WebCallResponse. Nothing may carry it into a summary.
 */
const accessTokenPresent = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000020",
  call_status: "ended",
  start_timestamp: 1754001700000,
  end_timestamp: 1754001707000,
  duration_ms: 7000,
  disconnection_reason: "user_hangup",
  access_token: FAKE_ACCESS_TOKEN,
  transcript_object: conversation(),
});

/** An ongoing call, for the lifecycle states the implementation must handle. */
const ongoingCall = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000021",
  call_status: "ongoing",
  start_timestamp: 1754001800000,
  transcript_object: conversation().slice(0, 2),
});

/** A registered call that has not started. */
const registeredCall = Object.freeze({
  ...BASE_WEB_CALL,
  call_id: "call_fixture000000000000000022",
  call_status: "registered",
});

/** A transfer that bridged successfully. */
const transferBridged = Object.freeze({
  ...phoneCallWithNumbers,
  call_id: "call_fixture000000000000000023",
  disconnection_reason: "transfer_bridged",
  transfer_end_timestamp: 1754001617000,
});

/**
 * The custom analysis schema these fixtures were "configured" with, in the same
 * shape the AIDA compilers emit. Used to prove type validation.
 */
const EXPECTED_CUSTOM_FIELDS = Object.freeze([
  { type: "string", name: "caller_name", description: "The caller's name." },
  { type: "enum", name: "urgency", description: "How urgent the job is.", choices: ["routine", "urgent_soon", "urgent_now"] },
  { type: "boolean", name: "transferred", description: "Whether the caller was put through." },
  { type: "number", name: "attempts", description: "How many transfer attempts were made." },
]);

module.exports = {
  FAKE_ACCESS_TOKEN,
  EXPECTED_CUSTOM_FIELDS,
  conversation,
  healthyLatency,
  connectedWebCall,
  userHangup,
  agentHangup,
  webCallNeverConnected,
  providerError,
  silenceTimeout,
  maximumDuration,
  endedDuringAgentTurn,
  highLlmLatency,
  highTtsLatency,
  missingLatency,
  unknownDisconnectionReason,
  analysisPending,
  analysisReady,
  unconnectedNoAnalysis,
  malformedAnalysis,
  minimalRequiredFieldsOnly,
  transcriptPresentForExclusion,
  phoneCallWithNumbers,
  accessTokenPresent,
  ongoingCall,
  registeredCall,
  transferBridged,
};
