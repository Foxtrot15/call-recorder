// AIDA — M7E: deterministic Retell call diagnostics.
//
// NO TEST HERE CONTACTS RETELL. Every provider response is a fixture built from
// the documented Get Call shape, and the suite asserts that fact rather than
// assuming it.
//
// The tests that matter most are the ones proving UNCERTAINTY SURVIVES. It is
// easy to write a diagnostic tool that always has an answer; the M7D dropout is
// the case where the honest answer is "not enough evidence", and several tests
// below exist purely to stop a future change from producing a confident guess.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const diagnostics = require("../src/services/retell-call-diagnostics");
const cfg = require("../src/config/retell");
const gate = require("../src/config/retell-diagnostics");
const port = require("../src/services/voice-platform-port");
const F = require("./fixtures/retell-call-responses");

const READ_ENV = Object.freeze({
  NODE_ENV: "development",
  RETELL_ENABLED: "true",
  RETELL_DIAGNOSTICS_ENABLED: "true",
  RETELL_DIAGNOSTICS_EXECUTE: "true",
  RETELL_ALLOWED_TAG: "dev",
  RETELL_API_KEY: "key_not_real",
});

const CALL_ID = "call_fixture000000000000000001";

// ── Lifecycle states ────────────────────────────────────────────────

describe("every documented lifecycle state", () => {
  const cases = [
    { name: "ended", fixture: F.connectedWebCall, status: "ended" },
    { name: "ongoing", fixture: F.ongoingCall, status: "ongoing" },
    { name: "registered", fixture: F.registeredCall, status: "registered" },
    { name: "not_connected", fixture: F.webCallNeverConnected, status: "not_connected" },
    { name: "error", fixture: F.providerError, status: "error" },
  ];

  for (const c of cases) {
    test(`${c.name} is recognised`, () => {
      const s = diagnostics.summariseCall(c.fixture);
      assert.equal(s.callStatus, c.status);
      assert.equal(s.callStatusRecognised, true);
      assert.equal(s.rawCallStatus, null);
    });
  }

  test("an undocumented status is preserved rather than mapped", () => {
    const s = diagnostics.summariseCall({ ...F.connectedWebCall, call_status: "quantum_superposition" });
    assert.equal(s.callStatus, null);
    assert.equal(s.callStatusRecognised, false);
    assert.equal(s.rawCallStatus, "quantum_superposition");
  });

  test("every documented status appears in the enum this build models", () => {
    assert.deepEqual([...diagnostics.CALL_STATUSES], ["registered", "not_connected", "ongoing", "ended", "error"]);
  });
});

// ── Disconnection categories ────────────────────────────────────────

describe("disconnection categories", () => {
  test("every documented reason maps to a category", () => {
    for (const reason of diagnostics.DISCONNECTION_REASONS) {
      assert.ok(diagnostics.REASON_CATEGORIES[reason], `${reason} has no category — an unmapped documented value is an oversight, not an unknown`);
    }
  });

  const cases = [
    { fixture: F.userHangup, category: "user_disconnected", reason: "user_hangup" },
    { fixture: F.agentHangup, category: "agent_disconnected", reason: "agent_hangup" },
    { fixture: F.silenceTimeout, category: "silence_timeout", reason: "inactivity" },
    { fixture: F.maximumDuration, category: "maximum_duration", reason: "max_duration_reached" },
    { fixture: F.providerError, category: "provider_error", reason: "error_llm_websocket_lost_connection" },
    { fixture: F.webCallNeverConnected, category: "not_connected", reason: "error_user_not_joined" },
    { fixture: F.transferBridged, category: "transfer", reason: "transfer_bridged" },
  ];

  for (const c of cases) {
    test(`${c.reason} → ${c.category}, on the provider's own word`, () => {
      const s = diagnostics.summariseCall(c.fixture);
      assert.equal(s.disconnectionReason, c.reason);
      assert.equal(s.category, c.category);
      assert.equal(s.categoryEvidence, "provider_classified");
      assert.equal(s.disconnectionDocumented, true);
    });
  }

  test("a provider error is flagged as one", () => {
    assert.equal(diagnostics.summariseCall(F.providerError).providerReportedError, true);
    assert.equal(diagnostics.summariseCall(F.userHangup).providerReportedError, false);
  });

  test("an UNKNOWN reason stays unknown, and the raw value survives", () => {
    const s = diagnostics.summariseCall(F.unknownDisconnectionReason);
    assert.equal(s.category, "unknown");
    assert.equal(s.disconnectionDocumented, false);
    assert.equal(s.disconnectionReason, null);
    assert.equal(s.rawDisconnectionReason, "error_some_future_reason_not_yet_documented");
    // Critically: an unrecognised string starting with "error_" must NOT be
    // guessed into provider_error just because it looks like one.
    assert.notEqual(s.category, "provider_error");
    assert.equal(s.providerReportedError, false);
  });

  test("ended with no reason is INCOMPLETE EVIDENCE, not normal completion", () => {
    const s = diagnostics.summariseCall(F.endedDuringAgentTurn);
    assert.equal(s.disconnectionReason, null);
    assert.equal(s.rawDisconnectionReason, null);
    assert.equal(s.category, "incomplete_evidence");
    assert.notEqual(s.category, "normal_completion");
    assert.equal(s.categoryEvidence, "observed");
  });
});

// ── Connection ──────────────────────────────────────────────────────

describe("was there a conversation", () => {
  test("turns present means connected", () => {
    const s = diagnostics.summariseCall(F.connectedWebCall);
    assert.equal(s.connected, true);
    assert.equal(s.connectionEvidence, "observed");
  });

  test("not_connected is the provider's own classification", () => {
    const s = diagnostics.summariseCall(F.webCallNeverConnected);
    assert.equal(s.connected, false);
    assert.equal(s.connectionEvidence, "provider_classified");
  });

  test("with neither transcript nor duration, connection is UNKNOWN not false", () => {
    const s = diagnostics.summariseCall(F.minimalRequiredFieldsOnly);
    assert.equal(s.connected, null);
    assert.equal(s.connectionEvidence, "none");
  });
});

// ── Missing fields ──────────────────────────────────────────────────

describe("missing and unknown fields", () => {
  test("a response with only the required fields does not throw or invent", () => {
    const s = diagnostics.summariseCall(F.minimalRequiredFieldsOnly);
    assert.equal(s.ok, true);
    assert.equal(s.durationMs, null);
    assert.equal(s.startTimestamp, null);
    assert.equal(s.derivedDurationMs, null);
    assert.equal(s.latency.present, false);
    assert.equal(s.timeline.present, false);
    for (const f of ["start_timestamp", "end_timestamp", "duration_ms", "disconnection_reason", "latency", "transcript_object", "call_analysis"]) {
      assert.ok(s.missing.includes(f), `${f} should be reported missing`);
    }
  });

  test("a null body is refused rather than summarised", () => {
    const s = diagnostics.summariseCall(null);
    assert.equal(s.ok, false);
    assert.equal(s.category, "incomplete_evidence");
  });

  test("an unmodelled provider field is reported by NAME only", () => {
    const s = diagnostics.summariseCall({ ...F.connectedWebCall, some_new_field: "a value we must not copy" });
    assert.ok(s.unknownFields.includes("some_new_field"));
    assert.equal(JSON.stringify(s).includes("a value we must not copy"), false);
  });

  test("the fixtures carry only documented fields", () => {
    // The M7D rule: a fake richer than the boundary cannot catch a wire-format
    // error, it causes one.
    //
    // `undocumentedTopLevelField` is the deliberate exception: it reproduces a
    // field the LIVE provider returned on 2026-08-02 that the documentation
    // reviewed the same day does not list. Exempted by name so the exemption is
    // visible rather than a hole in the rule.
    for (const [name, fixture] of Object.entries(F)) {
      if (name === "undocumentedTopLevelField") continue;
      if (!fixture || typeof fixture !== "object" || Array.isArray(fixture) || typeof fixture === "function") continue;
      if (!fixture.call_id) continue;
      for (const key of Object.keys(fixture)) {
        assert.ok(diagnostics.MODELLED_FIELDS.includes(key), `fixture ${name} carries "${key}", which is not a documented Get Call field`);
      }
    }
  });

  test("an undocumented live field is named, never consumed", () => {
    const s = diagnostics.summariseCall(F.undocumentedTopLevelField);
    assert.ok(s.unknownFields.includes("tool_calls"), "an unmodelled field must be reported by name");
    // Its VALUE must not reach the summary, and it must not be silently
    // absorbed into any modelled field.
    assert.equal(JSON.stringify(s).includes("check_service_area"), false);
    assert.equal(JSON.stringify(s).includes("Frankston"), false);
    assert.equal(s.timeline.toolCallCount, 0, "tool_calls is not transcript_with_tool_calls and must not be counted as one");
  });
});

// ── Latency ─────────────────────────────────────────────────────────

describe("latency summary", () => {
  test("documented components are summarised, and absent ones reported", () => {
    const s = diagnostics.summariseCall(F.connectedWebCall);
    assert.equal(s.latency.present, true);
    assert.ok(s.latency.componentsPresent.includes("llm"));
    assert.ok(s.latency.componentsPresent.includes("tts"));
    assert.ok(s.latency.missing.includes("s2s"));
    assert.equal(s.latency.components.llm.p95, 810);
  });

  test("the unbounded `values` array is never carried", () => {
    const s = diagnostics.summariseCall({ ...F.connectedWebCall, latency: { llm: { p50: 1, p95: 2, values: [1, 2, 3, 4, 5] } } });
    assert.equal(s.latency.components.llm.values, undefined);
  });

  test("a missing latency object is handled without inventing zeroes", () => {
    const s = diagnostics.summariseCall(F.missingLatency);
    assert.equal(s.latency.present, false);
    assert.deepEqual([...s.latency.componentsPresent], []);
    assert.equal(s.latencyBreaches.length, 0);
  });

  test("a high LLM p95 breaches, and the breach is LABELLED as a heuristic", () => {
    const s = diagnostics.summariseCall(F.highLlmLatency);
    const breach = s.latencyBreaches.find((b) => b.component === "llm");
    assert.ok(breach, "llm p95 of 4800ms should breach the 3000ms heuristic");
    assert.equal(breach.observedMs, 4800);
    assert.equal(breach.thresholdMs, 3000);
    assert.equal(breach.thresholdSource, "aida_diagnostic_heuristic");
    assert.match(breach.note, /not a provider guarantee/i);
  });

  test("a high TTS p95 breaches independently", () => {
    const s = diagnostics.summariseCall(F.highTtsLatency);
    assert.ok(s.latencyBreaches.some((b) => b.component === "tts" && b.observedMs === 3100));
    assert.ok(!s.latencyBreaches.some((b) => b.component === "llm"));
  });

  test("thresholds are configurable but their source label is not", () => {
    const strict = diagnostics.summariseCall(F.connectedWebCall, { thresholds: { llmP95Ms: 100 } });
    assert.ok(strict.latencyBreaches.some((b) => b.component === "llm"));
    const forged = diagnostics.summariseCall(F.connectedWebCall, { thresholds: { source: "retell_official_sla" } });
    assert.equal(forged.thresholds.source, "aida_diagnostic_heuristic", "the source label must not be overridable");
  });

  test("a healthy call breaches nothing", () => {
    assert.equal(diagnostics.summariseCall(F.connectedWebCall).latencyBreaches.length, 0);
  });
});

// ── Timeline ────────────────────────────────────────────────────────

describe("speech-turn timeline", () => {
  test("turn structure is summarised without any content", () => {
    const s = diagnostics.summariseCall(F.connectedWebCall);
    assert.equal(s.timeline.present, true);
    assert.equal(s.timeline.turnCount, 3);
    assert.equal(s.timeline.agentTurns, 2);
    assert.equal(s.timeline.userTurns, 1);
    for (const turn of s.timeline.turns) {
      assert.equal(turn.content, undefined, "turn content must never be carried");
      assert.equal(typeof turn.characterCount, "number");
      assert.equal(typeof turn.role, "string");
    }
  });

  test("word timings give the moment the last turn stopped", () => {
    const s = diagnostics.summariseCall(F.connectedWebCall);
    assert.equal(s.timeline.finalEventAtSeconds, 10.1);
    assert.equal(s.timeline.turns[0].startSeconds, 0.4);
  });

  test("a complete final turn is recognised as complete", () => {
    const s = diagnostics.summariseCall(F.agentHangup);
    assert.equal(s.timeline.finalTurnAppearsIncomplete, false);
    assert.equal(s.timeline.lastCompletedSpeaker, "agent");
  });

  test("an unfinished final turn is flagged — as a HEURISTIC", () => {
    const s = diagnostics.summariseCall(F.endedDuringAgentTurn);
    assert.equal(s.timeline.finalTurnRole, "agent");
    assert.equal(s.timeline.finalTurnAppearsIncomplete, true);
    // The last COMPLETED turn is the caller's, because the agent's never
    // finished. That difference is the evidence.
    assert.equal(s.timeline.lastCompletedSpeaker, "user");
  });

  test("tool calls are counted, their arguments are not", () => {
    const s = diagnostics.summariseCall(F.transcriptPresentForExclusion);
    assert.equal(s.timeline.toolCallCount, 1);
    assert.equal(JSON.stringify(s).includes("Frankston"), false);
  });

  test("a MID-CALL unfinished agent turn is found even when the ending is clean", () => {
    // The blind spot the M7E-LV live read exposed. The retained M7D call ended
    // on a user hang-up with a properly punctuated final turn, and had an
    // unfinished agent turn in the middle. Looking only at the last turn
    // answered "was the agent cut off?" with "no".
    const s = diagnostics.summariseCall(F.cleanEndingWithMidCallTruncation);

    assert.equal(s.category, "user_disconnected");
    assert.equal(s.timeline.finalTurnAppearsIncomplete, false, "the ending really is clean");
    // TWO, not one: both halves of the interrupted utterance are unfinished —
    // the turn that was cut off (#2) and the fragment that resumed over the
    // caller (#4). The live record had exactly this pair, and collapsing them
    // to one would misdescribe what the transcript shows.
    assert.equal(s.timeline.midCallIncompleteAgentCount, 2, "and there really are truncated agent turns before it");
    assert.deepEqual(s.timeline.incompleteTurns.filter((t) => t.role === "agent").map((t) => t.index), [2, 4]);
    // The caller's short "Sorry, go on." ends in a full stop and is not counted.
    assert.equal(s.timeline.incompleteTurns.some((t) => t.role === "user"), false);
  });

  test("overlapping speech is detected structurally", () => {
    const s = diagnostics.summariseCall(F.cleanEndingWithMidCallTruncation);
    assert.equal(s.overlapCount === undefined, true, "overlaps live on the timeline, not the summary root");
    assert.equal(s.timeline.overlapCount, 1);
    assert.equal(s.timeline.overlaps[0].index, 4);
    assert.equal(s.timeline.overlaps[0].afterIndex, 3);
    assert.ok(s.timeline.overlaps[0].overlapSeconds > 1);
  });

  test("the character threshold is what keeps backchannels out", () => {
    // Raising it above every turn suppresses the finding entirely, which proves
    // the threshold is doing the filtering rather than the punctuation check
    // alone. A one-word "mhm" without a full stop must never read as a
    // truncated turn.
    const s = diagnostics.summariseCall(F.cleanEndingWithMidCallTruncation, { thresholds: { incompleteTurnMinChars: 500 } });
    assert.equal(s.timeline.midCallIncompleteAgentCount, 0, "raising the threshold must suppress it");
    assert.equal(s.timeline.incompleteTurns.length, 0);
  });

  test("no transcript_object is reported as absent, not as zero turns", () => {
    const s = diagnostics.summariseCall(F.minimalRequiredFieldsOnly);
    assert.equal(s.timeline.present, false);
    assert.equal(s.timeline.finalTurnAppearsIncomplete, null);
  });
});

// ── THE CENTRAL DISCIPLINE ──────────────────────────────────────────

describe("uncertain evidence STAYS uncertain", () => {
  test("an incomplete final turn does NOT prove a cause", () => {
    const s = diagnostics.summariseCall(F.endedDuringAgentTurn);
    const r = diagnostics.buildDropoutEvidenceReport(s);

    assert.equal(r.cause, null, "no cause may be assigned without a provider classification");
    assert.equal(r.causeEvidence, "unproven");
    assert.equal(r.sufficientEvidence, false);
    assert.match(r.conclusion, /remain possible but unproven/);
    assert.ok(r.unknowns.length > 0);
  });

  test("the report never claims a network failure from a cut-off sentence", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.endedDuringAgentTurn));
    const text = `${r.conclusion} ${r.findings.map((f) => f.statement).join(" ")}`;
    assert.doesNotMatch(text, /caused by/i);
    assert.doesNotMatch(text, /the (internet|network|connection) (caused|failed)/i);
    // "possible" is allowed; "because" is not.
    assert.doesNotMatch(text, /because the (connection|network|internet)/i);
  });

  test("the possibilities are listed as NOT ESTABLISHED, not omitted", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.endedDuringAgentTurn));
    const unknowns = r.unknowns.join(" ");
    assert.match(unknowns, /browser connectivity/i);
    assert.match(unknowns, /websocket|transport/i);
    assert.match(unknowns, /Retell returned no disconnection_reason/i);
  });

  test("a clean ending does NOT close a mid-call question", () => {
    const s = diagnostics.summariseCall(F.cleanEndingWithMidCallTruncation);
    const r = diagnostics.buildDropoutEvidenceReport(s);

    // The ENDING is explained by the provider...
    assert.equal(r.cause, "user_disconnected");
    assert.equal(r.causeEvidence, "provider_classified");
    // ...and the mid-call truncation is still reported and still unexplained.
    assert.match(r.conclusion, /Separately, 2 agent turn\(s\) mid-call/);
    assert.match(r.unknowns.join(" "), /truncation that does not end the call is reported by no provider field/);
    const statements = r.findings.map((f) => f.statement).join(" ");
    assert.match(statements, /MID-CALL do not end in terminal punctuation/);
    assert.match(statements, /establishes neither/);
  });

  test("mid-call truncation never becomes a cause", () => {
    const s = diagnostics.summariseCall(F.cleanEndingWithMidCallTruncation);
    const r = diagnostics.buildDropoutEvidenceReport(s);
    // It is an observation about the middle of the call, not about how it
    // ended. It must not overwrite or invent a cause.
    assert.notEqual(r.cause, "provider_error");
    assert.equal(r.sufficientEvidence, true, "the ENDING is established");
    const text = `${r.conclusion} ${r.findings.map((f) => f.statement).join(" ")}`;
    assert.doesNotMatch(text, /caused by|interrupted by the|due to/i);
  });

  test("overlapping speech is reported without being blamed", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.cleanEndingWithMidCallTruncation));
    const statements = r.findings.map((f) => f.statement).join(" ");
    assert.match(statements, /start before the previous turn ends/);
    assert.match(statements, /proves nothing on its own/);
  });

  test("a provider classification IS enough to assign a cause", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.userHangup));
    assert.equal(r.cause, "user_disconnected");
    assert.equal(r.causeEvidence, "provider_classified");
    assert.equal(r.sufficientEvidence, true);
  });

  test("an undocumented reason is NOT enough to assign a cause", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.unknownDisconnectionReason));
    assert.equal(r.cause, null);
    assert.equal(r.sufficientEvidence, false);
    assert.match(r.unknowns.join(" "), /undocumented disconnection reason/i);
  });

  test("latency and a disconnect are never linked without evidence", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.highLlmLatency));
    assert.match(r.unknowns.join(" "), /not linked by any field/i);
  });

  test("every finding carries an evidence level", () => {
    for (const fixture of [F.connectedWebCall, F.endedDuringAgentTurn, F.providerError, F.minimalRequiredFieldsOnly]) {
      const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(fixture));
      for (const f of r.findings) {
        assert.ok(["provider_classified", "observed", "unproven", "none"].includes(f.evidence), `bad evidence level: ${f.evidence}`);
      }
    }
  });

  test("no evidence at all yields no conclusion", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(null));
    assert.equal(r.cause, null);
    assert.equal(r.sufficientEvidence, false);
    assert.match(r.conclusion, /Nothing can be concluded/i);
  });

  test("the report answers each of the M7E dropout questions", () => {
    const r = diagnostics.buildDropoutEvidenceReport(diagnostics.summariseCall(F.endedDuringAgentTurn));
    const text = r.findings.map((f) => f.statement).join(" ") + r.unknowns.join(" ");
    assert.match(text, /connected/i);
    assert.match(text, /web call/i);
    assert.match(text, /call_status/i);
    assert.match(text, /disconnection_reason/i);
    assert.match(text, /turn/i);
    assert.match(text, /latency/i);
    assert.match(text, /analysis/i);
  });
});

// ── Privacy ─────────────────────────────────────────────────────────

describe("what a summary must never carry", () => {
  const fixtures = [F.connectedWebCall, F.transcriptPresentForExclusion, F.accessTokenPresent, F.phoneCallWithNumbers, F.analysisReady];

  test("no full transcript, by default", () => {
    for (const fixture of fixtures) {
      const json = JSON.stringify(diagnostics.summariseCall(fixture));
      assert.equal(json.includes("locked out of my house"), false, "transcript content leaked");
      assert.equal(json.includes("Good afternoon, Harbour"), false, "transcript content leaked");
    }
  });

  test("no recording URL and no log URL", () => {
    const json = JSON.stringify(diagnostics.summariseCall(F.transcriptPresentForExclusion));
    assert.equal(json.includes("fixture-recording"), false);
    assert.equal(json.includes("fixture-log"), false);
    assert.equal(json.includes("https://"), false);
  });

  test("no access token, even though Get Call returns one as a REQUIRED field", () => {
    for (const fixture of fixtures) {
      const json = JSON.stringify(diagnostics.summariseCall(fixture));
      assert.equal(json.includes(F.FAKE_ACCESS_TOKEN), false, "the access token reached the summary");
      assert.equal(json.includes("access_token"), false);
    }
  });

  test("phone numbers are masked, never whole", () => {
    const s = diagnostics.summariseCall(F.phoneCallWithNumbers);
    assert.equal(s.numbers.from, "•••••• 110");
    assert.equal(s.numbers.to, "•••••• 156");
    assert.equal(s.numbers.transferDestination, "•••••• 006");
    const json = JSON.stringify(s);
    assert.equal(json.includes("+61491570110"), false);
    assert.equal(json.includes("491570110"), false);
  });

  test("dynamic-variable NAMES are carried, values are not", () => {
    const s = diagnostics.summariseCall(F.connectedWebCall);
    assert.ok(s.evidence.dynamicVariableKeys.includes("current_transfer_number"));
    assert.equal(JSON.stringify(s).includes("+61491570006"), false);
    assert.equal(JSON.stringify(s).includes("zero four nine one"), false);
  });

  test("the leak detector agrees, on every fixture", () => {
    for (const [name, fixture] of Object.entries(F)) {
      if (!fixture || typeof fixture !== "object" || !fixture.call_id) continue;
      const leaks = diagnostics.findSensitiveLeaks(diagnostics.summariseCall(fixture));
      assert.deepEqual(leaks, [], `${name} produced leaks: ${JSON.stringify(leaks)}`);
    }
  });

  test("the leak detector actually detects — it is not vacuously passing", () => {
    assert.ok(diagnostics.findSensitiveLeaks({ ok: true, oops: "https://example.com/recording.wav" }).length);
    assert.ok(diagnostics.findSensitiveLeaks({ ok: true, oops: F.FAKE_ACCESS_TOKEN }).length);
    assert.ok(diagnostics.findSensitiveLeaks({ ok: true, oops: "+61491570006" }).length);
    assert.ok(diagnostics.findSensitiveLeaks({ ok: true, transcript: "anything" }).length);
  });

  test("transcript content requires an explicit flag AND lands in a separate channel", () => {
    const off = diagnostics.summariseCall(F.transcriptPresentForExclusion);
    assert.equal(off.content, null);

    const on = diagnostics.summariseCall(F.transcriptPresentForExclusion, { includeContent: true });
    assert.ok(on.content.transcript.includes("locked out"));
    assert.match(on.content.warning, /Do not persist/i);

    // Stripping `content` — which is what the report writer does — leaves a
    // summary with no content in it at all.
    const { content, ...persisted } = on;
    assert.equal(JSON.stringify(persisted).includes("locked out"), false);
  });
});

// ── Determinism ─────────────────────────────────────────────────────

describe("determinism", () => {
  test("the same response always produces the same summary and report", () => {
    for (const fixture of [F.connectedWebCall, F.endedDuringAgentTurn, F.phoneCallWithNumbers]) {
      const a = diagnostics.summariseCall(fixture);
      const b = diagnostics.summariseCall(fixture);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.equal(JSON.stringify(diagnostics.buildDropoutEvidenceReport(a)), JSON.stringify(diagnostics.buildDropoutEvidenceReport(b)));
    }
  });

  test("summarising does not mutate the response", () => {
    const before = JSON.stringify(F.connectedWebCall);
    diagnostics.summariseCall(F.connectedWebCall);
    assert.equal(JSON.stringify(F.connectedWebCall), before);
  });
});

// ── The read-only gate ──────────────────────────────────────────────

describe("read-only diagnostics gate", () => {
  test("every default is closed", () => {
    const g = gate.evaluateDiagnosticsGate({}, { callId: CALL_ID });
    assert.equal(g.allowed, false);
    assert.equal(cfg.canReadDiagnostics({}).allowed, false);
    const c = gate.getDiagnosticsConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.executeRequested, false);
    assert.equal(c.includeContentRequested, false);
  });

  test("a fully configured environment opens it", () => {
    const g = gate.evaluateDiagnosticsGate(READ_ENV, { callId: CALL_ID });
    assert.equal(g.allowed, true, g.blockers.join("; "));
    assert.equal(g.callId, CALL_ID);
    assert.equal(cfg.canReadDiagnostics(READ_ENV).allowed, true);
  });

  test("only the exact string \"true\" enables anything", () => {
    for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true "]) {
      const g = gate.evaluateDiagnosticsGate({ ...READ_ENV, RETELL_DIAGNOSTICS_EXECUTE: value }, { callId: CALL_ID });
      assert.equal(g.allowed, false, `"${value}" must not enable execution`);
    }
  });

  test("production is refused outright", () => {
    const g = gate.evaluateDiagnosticsGate({ ...READ_ENV, NODE_ENV: "production" }, { callId: CALL_ID });
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /production/i);
    assert.equal(cfg.canReadDiagnostics({ ...READ_ENV, NODE_ENV: "production" }).allowed, false);
  });

  test("a missing API key blocks", () => {
    const { RETELL_API_KEY, ...withoutKey } = READ_ENV;
    const g = gate.evaluateDiagnosticsGate(withoutKey, { callId: CALL_ID });
    assert.equal(g.allowed, false);
    assert.match(g.blockers.join(" "), /RETELL_API_KEY/);
  });

  test("a missing or malformed call id blocks", () => {
    for (const callId of [null, "", "   ", "call id with spaces", "../../etc/passwd", "a".repeat(300)]) {
      const g = gate.evaluateDiagnosticsGate(READ_ENV, { callId });
      assert.equal(g.allowed, false, `${JSON.stringify(callId)} must not be accepted`);
      assert.equal(g.callId, null);
    }
  });

  test("the wrong allowed tag blocks", () => {
    // "production" and "" are the interesting ones: getRetellConfig falls back
    // to "dev" for an unrecognised tag, so a typo would read as dev unless the
    // gate checks the RAW value.
    for (const tag of ["prod", "staging", "production", "", "DEV"]) {
      const g = gate.evaluateDiagnosticsGate({ ...READ_ENV, RETELL_ALLOWED_TAG: tag }, { callId: CALL_ID });
      assert.equal(g.allowed, false, `tag "${tag}" must not be accepted`);
      assert.equal(cfg.canReadDiagnostics({ ...READ_ENV, RETELL_ALLOWED_TAG: tag }).allowed, false, `tag "${tag}" must not be accepted by the capability either`);
    }
  });

  test("an unset tag falls back to \"dev\", which is the safe default", () => {
    // Existing getRetellConfig behaviour, asserted here so a future change to
    // that default is caught by the gate that depends on it.
    const { RETELL_ALLOWED_TAG, ...noTag } = READ_ENV;
    assert.equal(cfg.getRetellConfig(noTag).allowedTag, "dev");
    assert.equal(gate.evaluateDiagnosticsGate(noTag, { callId: CALL_ID }).allowed, true);
  });

  test("live WRITES are not required", () => {
    const { ...noWrites } = READ_ENV;
    assert.equal(noWrites.RETELL_LIVE_WRITES_ENABLED, undefined);
    assert.equal(gate.evaluateDiagnosticsGate(noWrites, { callId: CALL_ID }).allowed, true);
  });

  test("live CALLS are not required", () => {
    assert.equal(READ_ENV.RETELL_LIVE_CALLS_ENABLED, undefined);
    assert.equal(gate.evaluateDiagnosticsGate(READ_ENV, { callId: CALL_ID }).allowed, true);
  });

  test("dry-run does not block a read — it promises not to CHANGE anything", () => {
    const g = gate.evaluateDiagnosticsGate({ ...READ_ENV, RETELL_DRY_RUN: "true" }, { callId: CALL_ID });
    assert.equal(g.allowed, true, g.blockers.join("; "));
  });

  test("no phone number, webhook, voice id, model key or database is required", () => {
    for (const key of ["RETELL_OUTBOUND_ONBOARDING_NUMBER", "RETELL_INBOUND_DEMO_NUMBER", "RETELL_WEBHOOK_BASE_URL", "RETELL_DEFAULT_VOICE_ID", "ANTHROPIC_API_KEY", "SUPABASE_URL"]) {
      assert.equal(READ_ENV[key], undefined, `${key} must not be part of the diagnostics environment`);
    }
    assert.equal(gate.evaluateDiagnosticsGate(READ_ENV, { callId: CALL_ID }).allowed, true);
  });

  test("the sandbox gate and the diagnostics gate are independent", () => {
    const sandboxCfg = require("../src/config/retell-sandbox");
    // A diagnostics-only environment must not open the sandbox.
    assert.equal(sandboxCfg.evaluateSandboxGate(READ_ENV).allowed, false);
  });

  test("transcript content needs BOTH the env var and the flag", () => {
    assert.equal(gate.evaluateContentDisclosure(READ_ENV, { commandLineFlag: true }).include, false);
    assert.equal(gate.evaluateContentDisclosure({ ...READ_ENV, RETELL_DIAGNOSTICS_INCLUDE_CONTENT: "true" }, { commandLineFlag: false }).include, false);
    assert.equal(gate.evaluateContentDisclosure({ ...READ_ENV, RETELL_DIAGNOSTICS_INCLUDE_CONTENT: "true" }, { commandLineFlag: true }).include, true);
  });

  test("transcript content is never disclosed in production", () => {
    const production = { ...READ_ENV, NODE_ENV: "production", RETELL_DIAGNOSTICS_INCLUDE_CONTENT: "true" };
    assert.equal(gate.evaluateContentDisclosure(production, { commandLineFlag: true }).include, false);
  });
});

// ── The provider boundary ───────────────────────────────────────────

describe("the diagnostics provider path", () => {
  test("the live adapter refuses a diagnostics read when the gate is closed", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const adapter = createRetellAdapter({
      config: cfg.getRetellConfig({}),
      env: {},
      fetchImpl: () => { throw new Error("no request may be attempted"); },
      logger: { error() {} },
    });
    const result = await adapter.retrieveCallForDiagnostics({ callId: CALL_ID });
    assert.equal(result.ok, false);
    // The port nests failures under `error`. Asserted at this exact path
    // because reading result.code gives undefined — the shape mistake that made
    // M7D's agent verification report "(none)" against a correct agent.
    assert.equal(result.error.code, "operation_not_permitted");
    assert.match(result.error.message, /RETELL_DIAGNOSTICS_ENABLED/);
  });

  test("with the gate open it uses the documented endpoint, and only reads", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const seen = [];
    const adapter = createRetellAdapter({
      config: cfg.getRetellConfig(READ_ENV),
      env: READ_ENV,
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init.method, headers: init.headers, body: init.body });
        return { ok: true, status: 200, headers: new Map(), json: async () => F.connectedWebCall };
      },
      logger: { error() {} },
    });

    const result = await adapter.retrieveCallForDiagnostics({ callId: CALL_ID });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "GET");
    assert.match(seen[0].url, /\/v2\/get-call\/call_fixture000000000000000001$/);
    assert.equal(seen[0].body, undefined, "a read sends no body");
  });

  test("the API key never appears in a log line", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const logged = [];
    const adapter = createRetellAdapter({
      config: cfg.getRetellConfig(READ_ENV),
      env: READ_ENV,
      fetchImpl: async () => ({ ok: false, status: 404, headers: new Map(), json: async () => ({ message: "not found" }) }),
      logger: { error: (m) => logged.push(String(m)) },
    });
    await adapter.retrieveCallForDiagnostics({ callId: CALL_ID });
    assert.ok(logged.length > 0);
    for (const line of logged) {
      assert.equal(line.includes("key_not_real"), false, "the API key reached a log line");
      assert.equal(line.toLowerCase().includes("authorization"), false);
    }
  });

  test("the call body is a ONE-SHOT reader", async () => {
    const { createRetellAdapter } = require("../src/services/retell-adapter");
    const adapter = createRetellAdapter({
      config: cfg.getRetellConfig(READ_ENV),
      env: READ_ENV,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => F.accessTokenPresent }),
      logger: { error() {} },
    });
    const result = await adapter.retrieveCallForDiagnostics({ callId: CALL_ID });

    // The body cannot be serialised out of the result...
    assert.equal(JSON.stringify(result).includes(F.FAKE_ACCESS_TOKEN), false);
    // ...it can be taken exactly once...
    assert.equal(typeof result.takeCallBody, "function");
    assert.equal(result.takeCallBody().call_id, F.accessTokenPresent.call_id);
    // ...and never twice.
    assert.equal(result.takeCallBody(), null);
  });

  test("the MOCK adapter mirrors the live result shape", async () => {
    // M7D's actual lesson: a fake richer or differently-shaped than the boundary
    // hides wire defects instead of catching them.
    const mock = port.createMockAdapter();
    const result = await mock.retrieveCallForDiagnostics({ callId: CALL_ID, mockBody: F.connectedWebCall });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.resource).sort(), ["agentId", "callType", "id", "status", "version"].sort());
    assert.equal(typeof result.takeCallBody, "function");
    assert.ok(result.takeCallBody());
    assert.equal(result.takeCallBody(), null, "the mock must be one-shot too, or a test would pass where production returns null");
  });

  test("the disabled and dry-run adapters cover the new operation", async () => {
    const disabled = port.createDisabledAdapter();
    const dry = port.createDryRunAdapter();
    assert.equal((await disabled.retrieveCallForDiagnostics({ callId: CALL_ID })).ok, false);
    assert.equal((await dry.retrieveCallForDiagnostics({ callId: CALL_ID })).ok, true);
    assert.ok(port.OPERATIONS.includes("retrieveCallForDiagnostics"));
  });

  test("NO mutation operation is reachable from the diagnostics script", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "retell-call-diagnostics.js"), "utf8");
    for (const op of ["createAgent", "updateAgent", "deleteAgent", "createKnowledgeBase", "deleteKnowledgeBase", "createResponseEngine", "deleteResponseEngine", "createWebCall", "createPhoneCall", "bindPhoneNumber"]) {
      assert.equal(source.includes(`.${op}(`), false, `the diagnostics script must not be able to call ${op}`);
    }
    assert.ok(source.includes("retrieveCallForDiagnostics"));
  });

  test("the diagnostics modules do not depend on any Retell SDK", () => {
    // This asserted that retell-sdk was ABSENT from node_modules. M7F-A
    // installs it deliberately, for webhook signature verification only, so
    // that assertion is now false by design.
    //
    // The guarantee it was actually protecting is stronger and is asserted
    // here instead: diagnostics import neither SDK, and therefore still work on
    // a checkout where neither is installed. That holds whether or not the
    // package happens to be present, which the old test could not say.
    for (const mod of ["../src/services/retell-call-diagnostics", "../src/services/retell-call-analysis", "../src/config/retell-diagnostics"]) {
      const source = fs.readFileSync(require.resolve(mod), "utf8");
      assert.equal(/require\(["']retell-sdk["']\)/.test(source), false, `${mod} must not import the server SDK`);
      assert.equal(/require\(["']retell-client-js-sdk["']\)/.test(source), false, `${mod} must not import the browser SDK`);
    }
    // The browser SDK is still absent, and must stay that way server-side.
    assert.throws(() => require.resolve("retell-client-js-sdk"));
    assert.equal(typeof diagnostics.summariseCall, "function");
    assert.equal(typeof gate.evaluateDiagnosticsGate, "function");
  });

  test("M7E did not open anything M7D closed", () => {
    // Narrow cross-checks. The M7B/M7C/M7D suites own these properties in full;
    // these assert that adding a third gate did not weaken the other two.
    const sandboxCfg = require("../src/config/retell-sandbox");
    const multipart = require("../src/services/retell-multipart");

    // The multipart fix: one JSON-encoded array field, not indexed sub-fields.
    const kb = multipart.buildCreateKnowledgeBaseRequest({ knowledgeBaseName: "T", texts: [{ title: "a", text: "b" }] });
    assert.equal(kb.ok, true);
    assert.match(kb.request.body.toString("utf8"), /name="knowledge_base_texts"/);
    assert.equal(/knowledge_base_texts\[0\]/.test(kb.request.body.toString("utf8")), false);

    // The telephone-call gate is untouched: a diagnostics environment cannot
    // place a call and cannot run the sandbox.
    assert.equal(cfg.canPlaceCall(READ_ENV).allowed, false);
    assert.equal(cfg.canWriteLive(READ_ENV).allowed, false);
    assert.equal(sandboxCfg.evaluateSandboxGate(READ_ENV).allowed, false);

    // And the sandbox's own gate still refuses to run beside live phone calls.
    assert.equal(sandboxCfg.evaluateSandboxGate({ ...READ_ENV, RETELL_LIVE_CALLS_ENABLED: "true" }).allowed, false);
  });

  test("M1 stays dormant and M6 billing gates stay closed", () => {
    const billing = require("../src/config/billing");
    // isDryRun is INVERTED — true is the safe state — so it is asserted the
    // other way round rather than swept up by the loop.
    assert.equal(billing.isDryRun(READ_ENV), true, "billing dry-run must stay ON");
    for (const name of ["isBillingEnabled", "isLiveWritesEnabled", "isChargesEnabled", "isWebhookEnabled"]) {
      assert.equal(billing[name](READ_ENV), false, `billing gate ${name} must stay closed in a diagnostics environment`);
    }

    // M1: the public locksmith surface is flag-gated and stays dormant.
    const locksmith = require("../src/config/locksmith");
    assert.equal(locksmith.isLocksmithPilotEnabled(READ_ENV), false);
  });

  test("no diagnostics module opens a socket at load time", () => {
    for (const mod of ["../src/services/retell-call-diagnostics", "../src/services/retell-call-analysis", "../src/config/retell-diagnostics"]) {
      const source = fs.readFileSync(`${require.resolve(mod)}`, "utf8");
      assert.equal(/require\(["']https?["']\)|globalThis\.fetch|new WebSocket/.test(source), false, `${mod} must not reach the network`);
    }
  });
});
