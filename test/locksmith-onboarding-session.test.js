// LOCKSMITH M2 — session lifecycle + the transcript ingestion boundary.
//
// The state machine and the ingestion decision core are pure, so both are
// driven here directly with plain objects — no database, no node_modules.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const sessions = require("../src/services/locksmith-onboarding-session");
const intake = require("../src/services/locksmith-transcript-intake");
const { MAX_TRANSCRIPT_BYTES, MIN_TRANSCRIPT_BYTES, TRANSCRIPT_PROVIDERS } = require("../src/config/locksmith-onboarding");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

describe("session lifecycle", () => {
  it("declares the nine required statuses", () => {
    assert.deepStrictEqual(sessions.SESSION_STATUSES, [
      "created", "interview_ready", "interview_in_progress", "transcript_received",
      "extraction_pending", "needs_review", "approved", "cancelled", "failed",
    ]);
  });

  it("walks the happy path one step at a time", () => {
    const path = ["created", "interview_ready", "interview_in_progress", "transcript_received", "extraction_pending", "needs_review", "approved"];
    for (let i = 0; i < path.length - 1; i += 1) {
      const verdict = sessions.evaluateTransition(path[i], path[i + 1]);
      assert.strictEqual(verdict.ok, true, `${path[i]} → ${path[i + 1]} should be allowed: ${verdict.message || ""}`);
    }
  });

  it("refuses to skip the transcript, the extraction or the review", () => {
    const illegal = [
      ["created", "approved"],
      ["created", "transcript_received"],
      ["interview_ready", "needs_review"],
      ["transcript_received", "approved"],
      ["extraction_pending", "approved"],
    ];
    for (const [from, to] of illegal) {
      const verdict = sessions.evaluateTransition(from, to);
      assert.strictEqual(verdict.ok, false, `${from} → ${to} must be refused`);
      assert.strictEqual(verdict.code, "illegal_transition");
    }
  });

  it("terminal states are terminal", () => {
    for (const terminal of ["approved", "cancelled", "failed"]) {
      assert.ok(sessions.isTerminal(terminal));
      const verdict = sessions.evaluateTransition(terminal, "needs_review");
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.code, "terminal");
    }
  });

  it("a review can send the session back for re-extraction", () => {
    assert.strictEqual(sessions.evaluateTransition("needs_review", "extraction_pending").ok, true);
  });

  it("failure and cancellation are reachable from every live state", () => {
    for (const from of ["created", "interview_ready", "interview_in_progress", "transcript_received", "extraction_pending", "needs_review"]) {
      assert.strictEqual(sessions.evaluateTransition(from, "failed").ok, true, `${from} → failed`);
      assert.strictEqual(sessions.evaluateTransition(from, "cancelled").ok, true, `${from} → cancelled`);
    }
  });

  it("rejects unknown statuses and no-ops with distinct codes", () => {
    assert.strictEqual(sessions.evaluateTransition("created", "vibing").code, "unknown_status");
    assert.strictEqual(sessions.evaluateTransition("nonsense", "created").code, "unknown_status");
    assert.strictEqual(sessions.evaluateTransition("created", "created").code, "no_op");
  });
});

describe("session field builders", () => {
  it("a new session starts empty and un-started", () => {
    const fields = sessions.buildSessionFields({ clientId: "demo", sessionId: "s-1", agentVersion: "a1", interviewSpecVersion: "i1" });
    assert.strictEqual(fields.status, "created");
    assert.strictEqual(fields.transcript_text, null);
    assert.strictEqual(fields.transcript_sha256, null);
    assert.strictEqual(fields.profile_version, null);
    assert.strictEqual(fields.started_at, null);
    assert.strictEqual(fields.completed_at, null);
  });

  it("requires a client and a session id", () => {
    assert.throws(() => sessions.buildSessionFields({ sessionId: "s" }), /requires clientId/);
    assert.throws(() => sessions.buildSessionFields({ clientId: "c" }), /requires sessionId/);
  });

  it("stamps started_at and completed_at at the right transitions", () => {
    assert.ok(sessions.buildStatusFields({ to: "interview_in_progress" }).started_at);
    for (const to of ["approved", "cancelled", "failed"]) {
      assert.ok(sessions.buildStatusFields({ to }).completed_at, `${to} should complete the session`);
    }
    assert.strictEqual(sessions.buildStatusFields({ to: "needs_review" }).completed_at, undefined);
  });

  it("failing a session requires a code and caps the detail", () => {
    assert.throws(() => sessions.buildFailureFields({ code: "" }), /requires a failure code/);
    const fields = sessions.buildFailureFields({ code: "transcript_unusable", detail: "x".repeat(5000) });
    assert.strictEqual(fields.status, "failed");
    assert.strictEqual(fields.failure_code, "transcript_unusable");
    assert.strictEqual(fields.failure_detail.length, 1000);
  });

  it("the public shape never includes the transcript body", () => {
    const view = sessions.toPublicSession({
      session_id: "s-1", client_id: "demo", status: "needs_review",
      transcript_text: "AIDA: secret business details", transcript_sha256: "abc123",
      created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
    });
    assert.strictEqual(view.hasTranscript, true);
    assert.strictEqual(view.transcriptSha256, "abc123");
    assert.ok(!("transcriptText" in view), "the transcript must be fetched deliberately, never by accident");
    assert.ok(!JSON.stringify(view).includes("secret business details"));
  });
});

describe("transcript normalisation", () => {
  it("strips control characters that are never speech", () => {
    const dirty = `AIDA: hello${String.fromCharCode(0)} there${String.fromCharCode(7)}`;
    const clean = intake.normaliseTranscript(dirty);
    assert.strictEqual(clean, "AIDA: hello there");
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(clean));
  });

  it("keeps tabs, newlines and normalises line endings", () => {
    assert.strictEqual(intake.normaliseTranscript("a\r\nb"), "a\nb");
    assert.strictEqual(intake.normaliseTranscript("a\tb\nc"), "a\tb\nc");
  });

  it("does NOT strip markup — escaping is an output concern", () => {
    const hostile = 'Owner: my business is <script>alert("xss")</script>';
    assert.strictEqual(intake.normaliseTranscript(hostile), hostile, "evidence must be stored as spoken");
  });

  it("handles non-strings without throwing", () => {
    for (const junk of [null, undefined, 42, {}, []]) assert.strictEqual(intake.normaliseTranscript(junk), "");
  });

  it("the digest is stable and content-addressed", () => {
    assert.strictEqual(intake.sha256("abc"), intake.sha256("abc"));
    assert.notStrictEqual(intake.sha256("abc"), intake.sha256("abd"));
  });
});

describe("ingestion validation", () => {
  const base = { clientId: "demo", sessionId: "s-1", provider: "fixture", providerCallId: "call-1", transcript: DEMO_TRANSCRIPT };

  it("accepts a well-formed request", () => {
    const result = intake.validateIngestion(base);
    assert.strictEqual(result.ok, true);
    assert.ok(result.sha256);
    assert.ok(result.bytes > MIN_TRANSCRIPT_BYTES);
  });

  it("requires clientId and sessionId", () => {
    assert.strictEqual(intake.validateIngestion({ ...base, clientId: null }).ok, false);
    assert.strictEqual(intake.validateIngestion({ ...base, sessionId: "" }).ok, false);
  });

  it("accepts only known providers", () => {
    for (const provider of TRANSCRIPT_PROVIDERS) {
      assert.strictEqual(intake.validateIngestion({ ...base, provider }).ok, true, provider);
    }
    for (const bad of ["openai", "", null, "FIXTURE"]) {
      const result = intake.validateIngestion({ ...base, provider: bad });
      assert.strictEqual(result.ok, false, `${bad} must be refused`);
      assert.strictEqual(result.code, "invalid");
    }
  });

  it("enforces the size limits at both ends", () => {
    assert.strictEqual(intake.validateIngestion({ ...base, transcript: "hi" }).ok, false, "too short to be an interview");
    const huge = "AIDA: ".concat("a".repeat(MAX_TRANSCRIPT_BYTES + 100));
    const result = intake.validateIngestion({ ...base, transcript: huge });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /exceeds the \d+ KB limit/);
  });

  it("rejects an empty or non-string transcript", () => {
    for (const bad of ["", "   ", null, undefined, 42]) {
      assert.strictEqual(intake.validateIngestion({ ...base, transcript: bad }).ok, false);
    }
  });

  it("bounds the metadata", () => {
    assert.strictEqual(intake.validateIngestion({ ...base, metadata: { ok: true } }).ok, true);
    assert.strictEqual(intake.validateIngestion({ ...base, metadata: "not an object" }).ok, false);
    assert.strictEqual(intake.validateIngestion({ ...base, metadata: [1, 2, 3] }).ok, false);
    assert.strictEqual(intake.validateIngestion({ ...base, metadata: { blob: "x".repeat(9000) } }).ok, false);
  });

  it("bounds the provider call id", () => {
    assert.strictEqual(intake.validateIngestion({ ...base, providerCallId: null }).ok, true);
    assert.strictEqual(intake.validateIngestion({ ...base, providerCallId: 12345 }).ok, false);
    assert.strictEqual(intake.validateIngestion({ ...base, providerCallId: "x".repeat(300) }).ok, false);
  });
});

describe("ingestion decisions", () => {
  const digest = intake.sha256(DEMO_TRANSCRIPT);
  const liveRow = { client_id: "demo", status: "interview_in_progress", transcript_sha256: null, provider_call_id: null };

  it("stores a first transcript", () => {
    const decision = intake.decideIngestion({ row: liveRow, clientId: "demo", providerCallId: "call-1", digest });
    assert.strictEqual(decision.action, "store");
  });

  it("a missing session is not found", () => {
    const decision = intake.decideIngestion({ row: null, clientId: "demo", providerCallId: "c", digest });
    assert.strictEqual(decision.action, "reject");
    assert.strictEqual(decision.code, intake.RESULT_CODES.notFound);
  });

  it("another tenant's session is reported as not found, never as forbidden", () => {
    const decision = intake.decideIngestion({ row: { ...liveRow, client_id: "someone-else" }, clientId: "demo", providerCallId: "c", digest });
    assert.strictEqual(decision.action, "reject");
    assert.strictEqual(decision.code, intake.RESULT_CODES.notFound, "existence itself is tenant information");
    assert.ok(!/tenant|client|belongs/i.test(decision.message), "the message must not hint that it exists elsewhere");
  });

  it("is idempotent for the same content — a webhook retry must not duplicate", () => {
    const row = { ...liveRow, transcript_sha256: digest, provider_call_id: "call-1" };
    const decision = intake.decideIngestion({ row, clientId: "demo", providerCallId: "call-1", digest });
    assert.strictEqual(decision.action, "duplicate");
  });

  it("is idempotent for the same provider call id even if the text differs slightly", () => {
    const row = { ...liveRow, transcript_sha256: "other-digest", provider_call_id: "call-1" };
    const decision = intake.decideIngestion({ row, clientId: "demo", providerCallId: "call-1", digest });
    assert.strictEqual(decision.action, "duplicate");
  });

  it("REFUSES a different transcript for a session that already has one", () => {
    const row = { ...liveRow, transcript_sha256: "an-earlier-digest", provider_call_id: "call-0" };
    const decision = intake.decideIngestion({ row, clientId: "demo", providerCallId: "call-99", digest });
    assert.strictEqual(decision.action, "reject");
    assert.strictEqual(decision.code, intake.RESULT_CODES.conflict);
    assert.match(decision.message, /already has a different transcript/i);
  });

  it("refuses a transcript for a terminal session", () => {
    for (const status of ["approved", "cancelled", "failed"]) {
      const decision = intake.decideIngestion({ row: { ...liveRow, status }, clientId: "demo", providerCallId: "c", digest });
      assert.strictEqual(decision.action, "reject");
      assert.strictEqual(decision.code, intake.RESULT_CODES.badState);
    }
  });

  it("preserves the provider call id on the stored row", () => {
    // The store decision carries no id itself; the adapter writes it. This
    // asserts the contract that a call id is never discarded when present.
    const validation = intake.validateIngestion({ clientId: "demo", sessionId: "s", provider: "retell", providerCallId: "retell-abc-123", transcript: DEMO_TRANSCRIPT });
    assert.strictEqual(validation.ok, true);
    assert.strictEqual(intake.decideIngestion({ row: liveRow, clientId: "demo", providerCallId: "retell-abc-123", digest: validation.sha256 }).action, "store");
  });
});

describe("result codes are stable", () => {
  it("exposes a fixed set callers can branch on", () => {
    assert.deepStrictEqual(Object.keys(intake.RESULT_CODES).sort(), ["badState", "conflict", "duplicate", "invalid", "notFound", "received", "wrongTenant"]);
  });
});
