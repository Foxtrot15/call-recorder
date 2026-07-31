// LOCKSMITH M4 — consent, start-call, lifecycle, transcript automation,
// approval→provisioning bridge, generated test plan, complexity assessment,
// and one full end-to-end mock journey.
//
// Pure modules and injected fakes; no network, no database, no provider.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const consentApi = require("../src/services/onboarding-call-consent");
const callService = require("../src/services/onboarding-call-service");
const lifecycle = require("../src/services/onboarding-call-lifecycle");
const bridge = require("../src/services/approval-provisioning-bridge");
const testPlan = require("../src/services/locksmith-test-plan");
const complexity = require("../src/services/locksmith-complexity");
const plans = require("../src/services/provisioning-plan");
const store = require("../src/services/locksmith-profile-store");
const sessions = require("../src/services/locksmith-onboarding-session");
const S = require("../src/services/locksmith-profile-schema");
const { assessProvisioning } = require("../src/services/locksmith-profile");
const { createMockAdapter, createDryRunAdapter, MODES, ERROR_CODES } = require("../src/services/voice-platform-port");
const { renderCallPage } = require("../src/views/locksmith-call-page");
const cfg = require("../src/config/retell");
require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

const CLIENT = "demo-locksmith";
const SESSION = "11111111-2222-3333-4444-555555555555";
const CONSENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NUMBER = "0491 570 006";

function demoProfile() {
  return JSON.parse(JSON.stringify(extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: CLIENT }).profile));
}

function validConsentArgs(overrides = {}) {
  return {
    consentId: CONSENT, clientId: CLIENT, sessionId: SESSION, userId: "user-1",
    destinationNumber: NUMBER, callConsent: true, transcriptionConsent: true, recordingConsent: false,
    ...overrides,
  };
}

// ── Consent ─────────────────────────────────────────────────────────

describe("onboarding-call consent", () => {
  it("records an explicit, number-bound, versioned consent", () => {
    const r = consentApi.buildConsent(validConsentArgs());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fields.destination_number, "+61491570006");
    assert.strictEqual(r.fields.call_consent, true);
    assert.strictEqual(r.fields.transcription_consent, true);
    assert.strictEqual(r.fields.recording_consent, false, "recording defaults off");
    assert.strictEqual(r.fields.disclosure_version, consentApi.CURRENT_DISCLOSURE_VERSION);
    assert.ok(r.fields.expires_at > r.fields.created_at);
    assert.strictEqual(r.fields.attempt_count, 0);
  });

  it("refuses anything that is not an explicit boolean true — no pre-ticked or defaulted consent", () => {
    for (const value of ["on", "true", "1", 1, "yes", {}, [], null, undefined, false]) {
      const r = consentApi.buildConsent(validConsentArgs({ callConsent: value }));
      assert.strictEqual(r.ok, false, `callConsent=${JSON.stringify(value)} must be refused`);
      assert.strictEqual(r.code, consentApi.REFUSAL_CODES.notAffirmative);
    }
    assert.strictEqual(consentApi.isAffirmative(true), true);
    assert.strictEqual(consentApi.isAffirmative("on"), false);
  });

  it("requires transcription consent separately from call consent", () => {
    const r = consentApi.buildConsent(validConsentArgs({ transcriptionConsent: false }));
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /transcribed/i);
  });

  it("treats recording as optional and separate", () => {
    const off = consentApi.buildConsent(validConsentArgs({ recordingConsent: false }));
    const on = consentApi.buildConsent(validConsentArgs({ recordingConsent: true }));
    assert.strictEqual(off.ok, true, "onboarding works without recording consent");
    assert.strictEqual(off.fields.recording_consent, false);
    assert.strictEqual(on.fields.recording_consent, true);
    assert.strictEqual(on.fields.transcription_consent, true, "recording never implies transcription or vice versa");
  });

  it("refuses a number it could not ring", () => {
    for (const bad of ["", "12345", "+1 202 555 0100", "0555 123 456", "not a number"]) {
      const r = consentApi.buildConsent(validConsentArgs({ destinationNumber: bad }));
      assert.strictEqual(r.ok, false, `${bad} must be refused`);
      assert.strictEqual(r.code, consentApi.REFUSAL_CODES.badNumber);
    }
  });

  it("preserves the disclosure version the client actually saw", () => {
    const disclosure = consentApi.getDisclosure();
    assert.ok(disclosure.callConsent.length > 40);
    assert.match(disclosure.transcriptionConsent, /transcribed/i);
    assert.match(disclosure.notMarketing, /not permission to.*marketing/i);
    assert.strictEqual(disclosure.legalReviewPending, true, "the wording is flagged as awaiting legal review");
    assert.strictEqual(consentApi.getDisclosure("made-up-version"), null);
  });

  it("is never usable as cold-marketing consent", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/services/onboarding-call-consent.js"), "utf8");
    assert.match(source, /NOT cold-marketing consent/i);
    const disclosure = consentApi.getDisclosure();
    assert.match(disclosure.notMarketing, /only about the call you are requesting/i);
  });
});

describe("consent evaluation", () => {
  const base = consentApi.buildConsent(validConsentArgs()).fields;

  it("accepts a live consent", () => {
    assert.strictEqual(consentApi.evaluateConsent({ consent: base, clientId: CLIENT, sessionId: SESSION }).ok, true);
  });

  it("refuses a missing consent", () => {
    const r = consentApi.evaluateConsent({ consent: null, clientId: CLIENT, sessionId: SESSION });
    assert.strictEqual(r.code, consentApi.REFUSAL_CODES.missing);
  });

  it("refuses a revoked consent", () => {
    const r = consentApi.evaluateConsent({ consent: { ...base, revoked_at: "2026-08-01T00:00:00.000Z" }, clientId: CLIENT, sessionId: SESSION });
    assert.strictEqual(r.code, consentApi.REFUSAL_CODES.revoked);
  });

  it("refuses an expired consent", () => {
    const expired = { ...base, expires_at: "2020-01-01T00:00:00.000Z" };
    const r = consentApi.evaluateConsent({ consent: expired, clientId: CLIENT, sessionId: SESSION, nowMs: Date.now() });
    assert.strictEqual(r.code, consentApi.REFUSAL_CODES.expired);
  });

  it("refuses once the attempt limit is reached", () => {
    const r = consentApi.evaluateConsent({ consent: { ...base, attempt_count: consentApi.MAX_ATTEMPTS }, clientId: CLIENT, sessionId: SESSION });
    assert.strictEqual(r.code, consentApi.REFUSAL_CODES.exhausted);
  });

  it("a different number requires new consent", () => {
    const r = consentApi.evaluateConsent({ consent: base, clientId: CLIENT, sessionId: SESSION, destinationNumber: "0491 570 015" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, consentApi.REFUSAL_CODES.numberChanged);
    assert.match(r.message, /different number/i);
    // The same number in another format is still the same number.
    assert.strictEqual(consentApi.evaluateConsent({ consent: base, clientId: CLIENT, sessionId: SESSION, destinationNumber: "+61 491 570 006" }).ok, true);
  });

  it("refuses another tenant's or another session's consent", () => {
    assert.strictEqual(consentApi.evaluateConsent({ consent: base, clientId: "someone-else", sessionId: SESSION }).code, consentApi.REFUSAL_CODES.wrongClient);
    assert.strictEqual(consentApi.evaluateConsent({ consent: base, clientId: CLIENT, sessionId: "other-session" }).code, consentApi.REFUSAL_CODES.wrongSession);
  });

  it("shows the number back in full to the client, but keeps internals internal", () => {
    const view = consentApi.toPublicConsent(base);
    assert.strictEqual(view.destinationNumber, "+61491570006", "the client must be able to check the number");
    assert.ok(!("request_ip" in view));
    assert.ok(!("destination_fingerprint" in view));
    assert.strictEqual(view.attemptsRemaining, consentApi.MAX_ATTEMPTS);
  });
});

// ── Start-call service ──────────────────────────────────────────────

function callHarness(overrides = {}) {
  const db = { sessions: new Map(), consents: new Map(), calls: new Map(), audit: [] };
  db.sessions.set(SESSION, { session_id: SESSION, client_id: CLIENT, status: "interview_ready" });
  db.consents.set(CONSENT, consentApi.buildConsent(validConsentArgs()).fields);

  const deps = {
    env: overrides.env || {},
    logger: { error() {}, log() {} },
    localHour: () => 10,
    newCallId: () => "call-uuid-1",
    recordAuditEvent: async (e) => { db.audit.push(e); return true; },
    sessions: {
      ...sessions,
      getSession: async (c, s) => { const r = db.sessions.get(s); return r && r.client_id === c ? r : null; },
      transitionSession: async ({ sessionId, to }) => { const r = db.sessions.get(sessionId); if (r) r.status = to; return { ok: true, row: r }; },
    },
    consents: {
      ...consentApi,
      getConsent: async (c, id) => { const r = db.consents.get(id); return r && r.client_id === c ? r : null; },
      incrementAttempt: async (c, id, n) => { db.consents.get(id).attempt_count = (n || 0) + 1; return { ok: true }; },
    },
    calls: {
      create: async (f) => { db.calls.set(f.call_id, f); return f; },
      update: async (c, id, patch) => { const r = db.calls.get(id); if (r) Object.assign(r, patch); return r; },
      findByRequestKey: async (c, k) => [...db.calls.values()].find((x) => x.request_key === k) || null,
      findActive: async (c, s) => [...db.calls.values()].find((x) => x.session_id === s && callService.ACTIVE_STATUSES.includes(x.status)) || null,
      findByProviderCallId: async (id) => [...db.calls.values()].find((x) => x.provider_call_id === id) || null,
      findForSession: async () => [...db.calls.values()],
    },
    ...overrides,
  };
  return { db, service: callService.createOnboardingCallService(deps), deps };
}

describe("start-call service", () => {
  it("requests a call in mock mode without touching a network", async () => {
    const { service, db } = callHarness();
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "user-1", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, MODES.mock);
    assert.strictEqual(db.calls.get("call-uuid-1").status, "created");
    assert.ok(db.calls.get("call-uuid-1").provider_call_id, "a provider call id is bound after success");
  });

  it("refuses without a valid consent", async () => {
    const { service, db } = callHarness();
    db.consents.get(CONSENT).revoked_at = "2026-08-01T00:00:00.000Z";
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, callService.REFUSAL_CODES.consentInvalid);
    assert.strictEqual(db.calls.size, 0, "no call record may be created without consent");
  });

  it("refuses another tenant's session", async () => {
    const { service } = callHarness();
    const r = await service.requestOnboardingCall({ clientId: "intruder", sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.code, callService.REFUSAL_CODES.notFound);
  });

  it("refuses a terminal session", async () => {
    const { service, db } = callHarness();
    db.sessions.get(SESSION).status = "approved";
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.code, callService.REFUSAL_CODES.badSessionState);
  });

  it("is idempotent for a duplicate request", async () => {
    const { service, db } = callHarness();
    await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    const second = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.idempotent, true);
    assert.strictEqual(db.calls.size, 1, "a double-submitted request must not dial twice");
  });

  it("blocks a second call while one is active", async () => {
    const { service, db } = callHarness();
    db.calls.set("existing", { call_id: "existing", client_id: CLIENT, session_id: SESSION, status: "dialling", request_key: "other" });
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.code, callService.REFUSAL_CODES.activeCall);
  });

  it("enforces the calling window", async () => {
    const { service } = callHarness({ localHour: () => 3 });
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.code, callService.REFUSAL_CODES.outsideWindow);
    assert.strictEqual(callService.isWithinCallingWindow(3), false);
    assert.strictEqual(callService.isWithinCallingWindow(10), true);
    assert.strictEqual(callService.isWithinCallingWindow(20), false);
  });

  it("consumes a consent attempt", async () => {
    const { service, db } = callHarness();
    await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(db.consents.get(CONSENT).attempt_count, 1);
  });

  it("records a provider refusal recoverably and does not bind a call id", async () => {
    const { service, db } = callHarness({ mockAdapter: createMockAdapter({ failures: { createPhoneCall: { status: 500 } } }) });
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, callService.REFUSAL_CODES.providerRefused);
    assert.strictEqual(r.retryable, true, "a 500 is retryable");
    const row = db.calls.get("call-uuid-1");
    assert.strictEqual(row.status, "failed");
    assert.strictEqual(row.provider_call_id, null, "no provider id may be recorded for a failed call");
  });

  it("distinguishes a non-retryable provider refusal", async () => {
    const { service } = callHarness({ mockAdapter: createMockAdapter({ failures: { createPhoneCall: { status: 400 } } }) });
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(r.retryable, false);
  });
});

describe("start-call service — live mode cannot activate accidentally", () => {
  it("selects the disabled adapter under the shipped configuration", () => {
    const { service } = callHarness({ env: {} });
    assert.strictEqual(service.selectCallAdapter(null).mode, MODES.disabled);
  });

  it("selects dry-run rather than live while dry-run is on, even with every flag set", () => {
    const env = {
      RETELL_ENABLED: "true", RETELL_LIVE_CALLS_ENABLED: "true", RETELL_LIVE_WRITES_ENABLED: "true",
      RETELL_API_KEY: "k", RETELL_DEFAULT_VOICE_ID: "v", RETELL_OUTBOUND_ONBOARDING_NUMBER: "+61491570006",
      RETELL_DRY_RUN: "true",
    };
    const { service } = callHarness({ env });
    assert.strictEqual(service.selectCallAdapter(null).mode, MODES.dryRun);
  });

  it("a disabled adapter refuses to place a call rather than silently doing nothing", async () => {
    const { service, db } = callHarness({ env: {} });
    const r = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "u", consentId: CONSENT });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, callService.REFUSAL_CODES.providerRefused);
    assert.strictEqual(db.calls.get("call-uuid-1").status, "failed");
  });

  it("mock mode is only reachable when the CALLER asks for it", () => {
    const { service } = callHarness({ env: {} });
    assert.notStrictEqual(service.selectCallAdapter(null).mode, MODES.mock);
    assert.strictEqual(service.selectCallAdapter(MODES.mock).mode, MODES.mock);
  });

  it("provider metadata carries opaque identifiers only", () => {
    const meta = callService.buildProviderMetadata({ clientId: CLIENT, sessionId: SESSION, callId: "c1" });
    assert.strictEqual(meta.aida_call_id, "c1");
    assert.ok(!JSON.stringify(meta).includes(CLIENT), "the tenant slug must not be sent to the provider");
    assert.match(meta.aida_client_ref, /^[a-f0-9]{24}$/);
  });

  it("masks the destination number in the client-facing shape", () => {
    const view = callService.toPublicCall({ call_id: "c", status: "ended", destination_number: "+61491570006", created_at: "x" });
    assert.ok(!view.destinationNumberMasked.includes("491570"));
    assert.match(view.destinationNumberMasked, /006$/);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────

describe("call lifecycle reconciliation", () => {
  const call = { client_id: CLIENT, session_id: SESSION, call_id: "c1", status: "dialling" };

  it("applies a legitimate forward transition", () => {
    assert.strictEqual(lifecycle.reconcileEvent({ call, internalEvent: "onboarding_call.connected" }).outcome, lifecycle.OUTCOMES.applied);
  });

  it("treats a repeat of the current state as a duplicate", () => {
    assert.strictEqual(lifecycle.reconcileEvent({ call: { ...call, status: "ended" }, internalEvent: "onboarding_call.ended" }).outcome, lifecycle.OUTCOMES.duplicate);
  });

  it("reconciles a late out-of-order event without dragging the call backwards", () => {
    const r = lifecycle.reconcileEvent({ call: { ...call, status: "ended" }, internalEvent: "onboarding_call.started" });
    assert.strictEqual(r.outcome, lifecycle.OUTCOMES.lateIgnored);
  });

  it("allows analysis to arrive after the transcript, and vice versa", () => {
    assert.strictEqual(lifecycle.reconcileEvent({ call: { ...call, status: "transcript_received" }, internalEvent: "onboarding_call.analysis_received" }).outcome, lifecycle.OUTCOMES.applied);
    assert.strictEqual(lifecycle.reconcileEvent({ call: { ...call, status: "analysis_received" }, internalEvent: "onboarding_call.transcript_received" }).outcome, lifecycle.OUTCOMES.applied);
  });

  it("accepts a transcript or analysis even when the call_ended delivery was lost", () => {
    // One dropped webhook must not strand the onboarding: a transcript or an
    // analysis is conclusive evidence the call finished.
    for (const from of ["created", "dialling", "connected"]) {
      for (const event of ["onboarding_call.transcript_received", "onboarding_call.analysis_received"]) {
        const r = lifecycle.reconcileEvent({ call: { ...call, status: from }, internalEvent: event });
        assert.strictEqual(r.outcome, lifecycle.OUTCOMES.applied, `${from} → ${event} should be accepted`);
      }
    }
  });

  it("surfaces a genuinely invalid transition rather than swallowing it", () => {
    const r = lifecycle.reconcileEvent({ call: { ...call, status: "failed" }, internalEvent: "onboarding_call.connected" });
    assert.ok([lifecycle.OUTCOMES.invalid, lifecycle.OUTCOMES.lateIgnored].includes(r.outcome));
    assert.ok(r.message);
  });

  it("fails closed with no binding and on a client mismatch", () => {
    assert.strictEqual(lifecycle.reconcileEvent({ call: null, internalEvent: "onboarding_call.ended" }).outcome, lifecycle.OUTCOMES.noBinding);
    assert.strictEqual(lifecycle.reconcileEvent({ call, internalEvent: "onboarding_call.ended", expectedClientId: "other" }).outcome, lifecycle.OUTCOMES.mismatch);
  });

  it("normalises provider end reasons and preserves the original label", () => {
    assert.strictEqual(lifecycle.buildLifecyclePatch({ target: "ended", providerCall: { disconnection_reason: "user_hangup" } }).end_reason, "caller_ended");
    const unknown = lifecycle.buildLifecyclePatch({ target: "ended", providerCall: { disconnection_reason: "quantum_collapse" } });
    assert.strictEqual(unknown.end_reason, "provider_other", "an unknown reason is not invented into one of ours");
    assert.strictEqual(unknown.provider_end_label, "quantum_collapse");
  });

  it("stores a recording URL as a reference and never downloads it", () => {
    const patch = lifecycle.buildLifecyclePatch({ target: "ended", providerCall: { recording_url: "https://provider.example/rec.wav" } });
    assert.strictEqual(patch.recording_reference, "https://provider.example/rec.wav");
    // Check for actual transport calls, not the word "download" in a comment.
    const source = fs.readFileSync(path.join(__dirname, "../src/services/onboarding-call-lifecycle.js"), "utf8");
    const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/\bfetch\s*\(|https?\.(get|request)\s*\(|axios/.test(code), "nothing here may fetch provider media");
  });

  it("records duration and cost when the provider supplies them", () => {
    const patch = lifecycle.buildLifecyclePatch({ target: "ended", providerCall: { duration_ms: 612000, call_cost: { combined_cost: 1.23 } } });
    assert.strictEqual(patch.duration_ms, 612000);
    assert.strictEqual(patch.provider_cost, 1.23);
  });

  it("walks a session through its legal path rather than jumping", async () => {
    const seen = [];
    const fakeSessions = {
      transitionSession: async ({ to }) => {
        // Mirrors the M2 machine: needs_review is not reachable directly.
        if (seen.length === 0 && to === "needs_review") return { ok: false, code: "illegal_transition", message: "no" };
        seen.push(to);
        return { ok: true };
      },
    };
    const r = await lifecycle.advanceSessionTo({
      sessionsApi: fakeSessions, clientId: CLIENT, sessionId: SESSION,
      path: ["transcript_received", "extraction_pending", "needs_review"], reason: "x", logger: { error() {} },
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(seen, ["transcript_received", "extraction_pending", "needs_review"]);
  });

  it("reports where a session walk stopped", async () => {
    const r = await lifecycle.advanceSessionTo({
      sessionsApi: { transitionSession: async ({ to }) => (to === "extraction_pending" ? { ok: false, code: "terminal", message: "no" } : { ok: true }) },
      clientId: CLIENT, sessionId: SESSION, path: ["transcript_received", "extraction_pending"], reason: "x", logger: { error() {} },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stoppedAt, "extraction_pending");
  });
});

// ── Transcript automation ───────────────────────────────────────────

function lifecycleHarness(overrides = {}) {
  const db = {
    sessions: new Map([[SESSION, { session_id: SESSION, client_id: CLIENT, status: "interview_in_progress", transcript_sha256: null }]]),
    calls: new Map([["c1", { call_id: "c1", client_id: CLIENT, session_id: SESSION, status: "connected", provider_call_id: "prov_1" }]]),
    versions: new Map(),
    audit: [],
    approved: null,
  };
  const service = lifecycle.createLifecycleService({
    logger: { error() {}, log() {} },
    recordAuditEvent: async (e) => { db.audit.push(e); return true; },
    calls: {
      findByProviderCallId: async (id) => [...db.calls.values()].find((c) => c.provider_call_id === id) || null,
      update: async (c, id, patch) => { Object.assign(db.calls.get(id), patch); return db.calls.get(id); },
    },
    sessions: { transitionSession: async ({ to }) => { db.sessions.get(SESSION).status = to; return { ok: true }; }, failSession: async () => ({ ok: true }) },
    store: {
      getApprovedVersion: async () => db.approved,
      createDraftVersion: async ({ profile, extractionVersion }) => {
        const version = db.versions.size + 1;
        const row = { client_id: CLIENT, version, status: "needs_review", profile, extraction_version: extractionVersion };
        db.versions.set(version, row);
        return row;
      },
    },
    intake: {
      receiveOnboardingTranscript: async ({ transcript }) => {
        const row = db.sessions.get(SESSION);
        const digest = require("../src/services/locksmith-transcript-intake").sha256(transcript);
        if (row.transcript_sha256 === digest) return { ok: true, code: "duplicate" };
        if (row.transcript_sha256) return { ok: false, code: "transcript_exists", message: "different transcript" };
        row.transcript_sha256 = digest;
        return { ok: true, code: "received" };
      },
    },
    ...overrides,
  });
  return { db, service };
}

describe("transcript-to-review automation", () => {
  it("a completed transcript creates a draft and moves the session to needs_review", async () => {
    const { service, db } = lifecycleHarness();
    const r = await service.handleEvent({
      internalEvent: "onboarding_call.ended", providerCallId: "prov_1",
      call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT },
    });
    assert.strictEqual(r.outcome, "draft_created");
    assert.strictEqual(r.profileVersion, 1);
    assert.strictEqual(r.reviewAvailable, true);
    assert.strictEqual(db.sessions.get(SESSION).status, "needs_review");
  });

  it("never auto-approves", async () => {
    const { service, db } = lifecycleHarness();
    await service.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT } });
    assert.strictEqual(db.versions.get(1).status, "needs_review");
    assert.ok(![...db.versions.values()].some((v) => v.status === "approved"));
  });

  it("leaves an existing approved profile untouched", async () => {
    const { service, db } = lifecycleHarness();
    db.approved = { client_id: CLIENT, version: 7, status: "approved", profile: demoProfile() };
    const snapshot = JSON.stringify(db.approved);
    const r = await service.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT } });
    assert.strictEqual(r.approvedProfileUntouched, 7);
    assert.strictEqual(JSON.stringify(db.approved), snapshot);
    assert.strictEqual(db.versions.get(1).version, 1, "a NEW draft is created, not an overwrite");
  });

  it("does not overwrite a previously received transcript", async () => {
    const { service, db } = lifecycleHarness();
    db.sessions.get(SESSION).transcript_sha256 = "an-earlier-digest";
    const r = await service.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "transcript_exists");
    assert.strictEqual(db.versions.size, 0, "no draft may be created from a refused transcript");
  });

  it("is idempotent for the same transcript delivered twice", async () => {
    const { service, db } = lifecycleHarness();
    await service.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT } });
    db.calls.get("c1").status = "connected"; // allow the transition again
    const second = await service.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT } });
    assert.strictEqual(second.outcome, "transcript_duplicate");
    assert.strictEqual(db.versions.size, 1);
  });

  it("produces missing-field and contradiction warnings", async () => {
    const thin = `AIDA: What's the business called — the name you'd want me to say when I pick up?
Owner: Southside Locks.
AIDA: Which state are you based in?
Owner: Victoria.
AIDA: Thanks, that's everything for now.`;
    const { service } = lifecycleHarness();
    const r = await service.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: thin }, binding: { clientId: CLIENT } });
    assert.strictEqual(r.outcome, "draft_created");
    assert.ok(r.warnings.some((w) => w.severity === "blocking"));
    assert.ok(r.warnings.length > 3);
  });

  it("provider analysis supplements warnings but cannot approve", async () => {
    const { service } = lifecycleHarness();
    const r = await service.handleEvent({
      internalEvent: "onboarding_call.analysis_received", providerCallId: "prov_1",
      call: { call_id: "prov_1", call_analysis: { consent_provided: true, call_outcome: "completed", pricing_authority: "may_not_mention" } },
      binding: { clientId: CLIENT },
    });
    assert.strictEqual(r.outcome, "analysis_recorded");
    assert.strictEqual(r.approved, false);
    assert.strictEqual(r.canApprove, false);
    assert.ok(r.warnings.length > 0);
  });

  it("a rejected analysis leaves the transcript-derived draft standing", async () => {
    const { service } = lifecycleHarness();
    const r = await service.handleEvent({
      internalEvent: "onboarding_call.analysis_received", providerCallId: "prov_1",
      call: { call_id: "prov_1", call_analysis: { call_outcome: "invented_value" } },
      binding: { clientId: CLIENT },
    });
    assert.strictEqual(r.outcome, "analysis_rejected");
    assert.strictEqual(r.draftUnaffected, true);
  });
});

// ── Approval → provisioning bridge ──────────────────────────────────

function bridgeHarness(overrides = {}) {
  const db = { plans: [], audit: [], resources: [] };
  const approvedRow = { client_id: CLIENT, version: 1, status: "approved", profile: demoProfile() };
  const service = bridge.createApprovalBridge({
    logger: { error() {}, log() {} },
    recordAuditEvent: async (e) => { db.audit.push(e); return true; },
    store: { getApprovedVersion: async () => (overrides.approved === null ? null : overrides.approved || approvedRow) },
    registry: { listResources: async () => db.resources },
    planStore: {
      create: async (f) => { const row = { ...f, id: `plan-${db.plans.length + 1}` }; db.plans.push(row); return row; },
      findCurrent: async (c, v) => db.plans.find((p) => p.approved_profile_version === v && !p.superseded_at) || null,
      supersedeStale: async (c, v) => { let n = 0; for (const p of db.plans) { if (p.approved_profile_version !== v && !p.superseded_at) { p.superseded_at = "x"; p.status = "superseded"; n += 1; } } return n; },
      findForClient: async () => db.plans,
    },
    ...overrides,
  });
  return { db, service, approvedRow };
}

describe("approval → provisioning bridge", () => {
  const actor = { type: "client", clientId: CLIENT, id: "user-1" };

  it("an approved, ready profile generates a plan and a truthful client message", async () => {
    const { service, db } = bridgeHarness();
    const r = await service.onProfileApproved({ clientId: CLIENT, sessionId: SESSION, approvedVersion: 1, actor });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, bridge.BRIDGE_OUTCOMES.ready);
    assert.ok(r.planHash);
    assert.strictEqual(db.plans.length, 1);
    assert.match(r.clientMessage, /approved and is being prepared/);
    assert.ok(!/live|running|answering/i.test(r.clientMessage), "the message must not imply the receptionist is live");
  });

  it("never executes anything", async () => {
    const { service } = bridgeHarness();
    const r = await service.onProfileApproved({ clientId: CLIENT, sessionId: SESSION, approvedVersion: 1, actor });
    assert.strictEqual(r.executedAnything, false);
    const source = fs.readFileSync(path.join(__dirname, "../src/services/approval-provisioning-bridge.js"), "utf8");
    assert.ok(!/executePlan/.test(source), "the bridge must not be able to execute a plan");
  });

  it("blocks when the profile is not provisioning-ready", async () => {
    const notReady = demoProfile();
    notReady.transfer.primaryNumber = null;
    const { service } = bridgeHarness({ approved: { client_id: CLIENT, version: 1, status: "approved", profile: notReady } });
    const r = await service.onProfileApproved({ clientId: CLIENT, sessionId: SESSION, approvedVersion: 1, actor });
    assert.strictEqual(r.outcome, bridge.BRIDGE_OUTCOMES.blocked);
    assert.match(r.clientMessage, /still needs attention/);
  });

  it("refuses when there is no approved profile", async () => {
    const { service } = bridgeHarness({ approved: null });
    const r = await service.onProfileApproved({ clientId: CLIENT, approvedVersion: 1, actor });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcome, bridge.BRIDGE_OUTCOMES.notApproved);
  });

  it("refuses an unauthorised actor", async () => {
    const { service } = bridgeHarness();
    const r = await service.onProfileApproved({ clientId: CLIENT, approvedVersion: 1, actor: { type: "client", clientId: "intruder", id: "x" } });
    assert.strictEqual(r.ok, false);
  });

  it("supersedes a stale plan when the approved version moves", async () => {
    const { service, db } = bridgeHarness();
    db.plans.push({ id: "old", client_id: CLIENT, approved_profile_version: 0, superseded_at: null, status: "validated" });
    await service.onProfileApproved({ clientId: CLIENT, approvedVersion: 1, actor });
    assert.strictEqual(db.plans[0].status, "superseded", "a plan for an older version must not stay current");
    assert.ok(db.audit.some((e) => e.event_type === "provisioning.plan_superseded"));
  });

  it("does not churn the plan table when nothing changed", async () => {
    const { service, db } = bridgeHarness();
    await service.onProfileApproved({ clientId: CLIENT, approvedVersion: 1, actor });
    const first = db.plans.length;
    const second = await service.onProfileApproved({ clientId: CLIENT, approvedVersion: 1, actor });
    assert.strictEqual(second.outcome, bridge.BRIDGE_OUTCOMES.unchanged);
    assert.strictEqual(db.plans.length, first, "an identical re-approval must not create a second plan");
  });
});

// ── Generated test plan ─────────────────────────────────────────────

describe("generated receptionist test plan", () => {
  const plan = testPlan.generateTestPlan({ profile: demoProfile(), profileVersion: 1, clientId: CLIENT });

  it("covers every required scenario family", () => {
    const ids = plan.cases.map((c) => c.id);
    const families = [
      /^accepted_service/, /^declined_service/, /^area_inside$/, /^area_outside$/,
      /^hours_ordinary$/, /^hours_after$/, /^urgent_transfer$/, /^quote_non_urgent$/,
      /^pricing_unapproved$/, /^guaranteed_arrival$/, /^lock_bypass_request$/, /^prompt_injection$/,
      /^transfer_unavailable$/, /^missing_caller_detail$/, /^caller_corrects_suburb$/,
      /^caller_changes_job_type$/, /^abusive_or_irrelevant$/,
    ];
    for (const family of families) {
      assert.ok(ids.some((id) => family.test(id)), `no case matches ${family}`);
    }
  });

  it("is deterministic", () => {
    const again = testPlan.generateTestPlan({ profile: demoProfile(), profileVersion: 1, clientId: CLIENT });
    assert.deepStrictEqual(again.cases.map((c) => c.id), plan.cases.map((c) => c.id));
  });

  it("every case has expectations and a pass criterion", () => {
    for (const c of plan.cases) {
      assert.ok(c.scenario && c.passCriteria, `${c.id} is incomplete`);
      assert.ok(Array.isArray(c.expectations) && c.expectations.length > 0, `${c.id} has no expectations`);
      for (const e of c.expectations) assert.ok(testPlan.EXPECTATION_KINDS.includes(e.kind), `${c.id} has an unknown expectation kind "${e.kind}"`);
      assert.strictEqual(typeof c.expectedTransferEligible, "boolean");
    }
  });

  it("uses the client's own declined services", () => {
    const declinedCases = plan.cases.filter((c) => c.id.startsWith("declined_service"));
    assert.ok(declinedCases.length > 0);
    assert.ok(declinedCases.some((c) => /automotive/i.test(c.title)), "the demo locksmith declines car work");
  });

  it("evaluation catches a guaranteed arrival, a quoted price and a leaked transfer number", () => {
    const profile = demoProfile();
    const bad = [
      ["I guarantee someone will arrive within the hour.", "guaranteed_arrival"],
      ["A locksmith has been dispatched already.", "claimed_dispatch"],
      ["You could pick the lock yourself with a shim.", "bypass_instruction"],
      ["It'll be $150.", "unapproved_price_quoted"],
      ["Ring them on 0491 570 006.", "transfer_number_disclosed"],
    ];
    for (const [transcript, code] of bad) {
      const r = testPlan.evaluateCase({ testCase: plan.cases[0], transcript, profile });
      assert.strictEqual(r.result, "fail", `"${transcript}" should fail`);
      assert.ok(r.findings.some((f) => f.code === code), `expected finding ${code}, got ${r.findings.map((f) => f.code)}`);
    }
  });

  it("is honest that a mechanical pass is not a full pass", () => {
    const r = testPlan.evaluateCase({ testCase: plan.cases[0], transcript: "I'll take your details and the locksmith will ring you back.", profile: demoProfile() });
    assert.strictEqual(r.result, "pass_mechanical_checks");
    assert.strictEqual(r.needsHumanReview, true);
    assert.match(r.note, /still needs a human read/);
  });

  it("the provider payload is explicitly a dry run that creates nothing", () => {
    const dry = testPlan.toProviderDryRun({ plan });
    assert.strictEqual(dry.executed, false);
    assert.match(dry.reason, /No official Retell test-case API contract was confirmed/);
    assert.strictEqual(dry.cases.length, plan.caseCount);
  });
});

// ── Complexity assessment ───────────────────────────────────────────

describe("Micro complexity assessment", () => {
  it("an ordinary solo locksmith is Micro-compatible", () => {
    const r = complexity.assessComplexity({ profile: demoProfile(), profileVersion: 1 });
    assert.strictEqual(r.microCompatible, true, `unexpected reasons: ${JSON.stringify(r.reasons)}`);
    assert.strictEqual(r.minimumOperationalTier, "micro");
  });

  it("a multi-location profile moves above Micro", () => {
    const p = demoProfile();
    p.hours.byService = { rekeying: { monday: { open: "09:00", close: "12:00" } } };
    const r = complexity.assessComplexity({ profile: p, profileVersion: 1 });
    assert.strictEqual(r.microCompatible, false);
    assert.ok(r.unsupportedComplexity.includes("per_service_hours"));
  });

  it("a custom integration requirement is flagged for manual review", () => {
    const p = demoProfile();
    p.extensions = { crm_integration: "servicem8" };
    const r = complexity.assessComplexity({ profile: p, profileVersion: 1 });
    assert.strictEqual(r.manualReviewRequired, true);
    assert.ok(r.unsupportedComplexity.includes("custom_integration"));
  });

  it("a missing transfer number blocks Micro entirely", () => {
    const p = demoProfile();
    p.transfer.primaryNumber = null;
    const r = complexity.assessComplexity({ profile: p, profileVersion: 1 });
    assert.strictEqual(r.minimumOperationalTier, "bespoke");
    assert.ok(r.reasons.some((x) => x.impact === "blocks_micro"));
  });

  it("restates the same-core-quality commitment on every assessment", () => {
    const r = complexity.assessComplexity({ profile: demoProfile(), profileVersion: 1 });
    assert.match(r.qualityCommitment, /same core call quality/i);
    assert.match(r.qualityCommitment, /never from a deliberately degraded receptionist/i);
  });

  it("does not mutate the profile it assesses", () => {
    const p = demoProfile();
    const snapshot = JSON.stringify(p);
    complexity.assessComplexity({ profile: p, profileVersion: 1 });
    assert.strictEqual(JSON.stringify(p), snapshot);
  });

  it("does not charge, price or reject anyone", () => {
    const r = complexity.assessComplexity({ profile: demoProfile(), profileVersion: 1 });
    assert.match(r.billingEffect, /^none/);
    assert.strictEqual(r.provisional, true);
    const source = fs.readFileSync(path.join(__dirname, "../src/services/locksmith-complexity.js"), "utf8");
    assert.ok(!/stripe|charge\(|invoice|payment/i.test(source), "no billing may live here");
    assert.ok(!Object.keys(r).some((k) => /price|amount|charge/i.test(k)), "the result must carry no price");
  });
});

// ── Client call page ────────────────────────────────────────────────

describe("client onboarding-call page", () => {
  const disclosure = consentApi.getDisclosure();
  const html = renderCallPage({
    clientId: CLIENT, session: { sessionId: SESSION }, state: "ready_to_request",
    disclosure, destinationNumber: NUMBER, providerAvailable: true, providerMode: "mock",
  });

  it("leads with the headline and explains the interview honestly", () => {
    assert.match(html, /<h1>Talk with AIDA to configure your receptionist<\/h1>/);
    assert.match(html, /services, service areas, hours/i);
    assert.match(html, /repeat the important details back/i);
    assert.match(html, /will be transcribed/i);
    assert.match(html, /Nothing goes live until you've read what AIDA understood and approved it/);
    assert.match(html, /Recording the audio is a separate, optional choice/i);
  });

  it("has NO pre-ticked consent box anywhere", () => {
    const inputs = html.match(/<input[^>]*type="checkbox"[^>]*>/g) || [];
    assert.ok(inputs.length >= 3);
    for (const input of inputs) {
      assert.ok(!/\bchecked\b/.test(input), `a consent box is pre-ticked: ${input}`);
    }
  });

  it("shows the destination number back for checking", () => {
    assert.ok(html.includes(NUMBER));
    assert.match(html, /Check it carefully/i);
  });

  it("tells the truth when the provider is unavailable", () => {
    const disabled = renderCallPage({
      clientId: CLIENT, session: { sessionId: SESSION }, state: "ready_to_request",
      disclosure, destinationNumber: NUMBER, providerAvailable: false, providerMode: "disabled",
      providerReasons: ["RETELL_ENABLED is not \"true\""],
    });
    assert.match(disabled, /Setup calls aren't switched on yet/);
    assert.match(disabled, /can't ring you until we finish connecting/i);
    const button = disabled.match(/<button[^>]*id="request-call"[^>]*>/)[0];
    assert.match(button, /disabled/, "the request button must be disabled when calls cannot be made");
  });

  it("renders a server-side timeline so core status works without JavaScript", () => {
    assert.match(html, /<ol class="timeline">/);
    assert.match(html, /aria-current="step"/);
    assert.ok((html.match(/timeline__step/g) || []).length >= 8);
  });

  it("shows the review link once a draft is ready", () => {
    const review = renderCallPage({
      clientId: CLIENT, session: { sessionId: SESSION }, state: "needs_review",
      disclosure, reviewUrl: `/client/locksmith-onboarding/${SESSION}/review`, providerAvailable: true,
    });
    assert.match(review, /Review what AIDA understood/);
    assert.match(review, new RegExp(SESSION));
  });

  it("shows a truthful provisioning status", () => {
    const ready = renderCallPage({
      clientId: CLIENT, session: { sessionId: SESSION }, state: "provisioning_ready",
      disclosure, providerAvailable: true,
      provisioningStatus: bridge.CLIENT_STATUS_MESSAGES.provisioning_ready,
    });
    assert.match(ready, /approved and is being prepared/);
  });

  it("escapes hostile content and carries no inline script", () => {
    const hostile = renderCallPage({
      clientId: CLIENT, session: { sessionId: SESSION }, state: "ready_to_request",
      disclosure, destinationNumber: '"><script>alert(1)</script>', providerAvailable: true,
    });
    assert.ok(!hostile.includes("<script>alert(1)</script>"));
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(hostile));
    assert.ok(!/\son[a-z]+\s*=\s*"/i.test(hostile));
  });

  it("the stylesheet gives its form controls touch-friendly, zoom-safe sizing", () => {
    // Regression: onboarding.css was written for the M2 review page, which had
    // no text inputs. The M4 call page introduced a tel field and consent
    // checkboxes, which fell back to browser defaults — a 13px input makes iOS
    // zoom on focus and a 13px checkbox is far below a usable touch target.
    const css = fs.readFileSync(path.join(__dirname, "../public/locksmith/onboarding.css"), "utf8");
    assert.match(css, /\.field input\[type="tel"\]/, "the tel input must be styled");
    assert.match(css, /font-size: 16px;\s*\/\* 16px stops iOS zooming on focus \*\//);
    assert.match(css, /\.check input \{[^}]*width: 22px/, "consent checkboxes need a real touch target");
    assert.match(css, /\.timeline__step/, "the journey timeline must be styled");
  });

  it("has one h1, landmarks, labels and a status region", () => {
    assert.strictEqual((html.match(/<h1/g) || []).length, 1);
    assert.strictEqual((html.match(/<main/g) || []).length, 1);
    assert.match(html, /<a class="skip-link" href="#main">/);
    assert.match(html, /<label for="destination-number">/);
    assert.match(html, /<label for="consent-call">/);
    assert.match(html, /id="form-status" role="status" aria-live="polite"/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  });
});

// ── End-to-end ──────────────────────────────────────────────────────

describe("end-to-end: one full mock journey", () => {
  it("runs consent → call → transcript → draft → approval → provisioning-ready without touching anything external", async () => {
    // Consent
    const consent = consentApi.buildConsent(validConsentArgs());
    assert.strictEqual(consent.ok, true);

    // Call
    const { service, db: callDb } = callHarness();
    const requested = await service.requestOnboardingCall({ clientId: CLIENT, sessionId: SESSION, requestedBy: "user-1", consentId: CONSENT, explicitMode: MODES.mock });
    assert.strictEqual(requested.ok, true);
    assert.strictEqual(callDb.calls.size, 1);

    // Transcript → draft
    const { service: life, db: lifeDb } = lifecycleHarness();
    const ended = await life.handleEvent({ internalEvent: "onboarding_call.ended", providerCallId: "prov_1", call: { call_id: "prov_1", transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT } });
    assert.strictEqual(ended.outcome, "draft_created");
    assert.strictEqual(lifeDb.sessions.get(SESSION).status, "needs_review");

    // Approve (the M2 guard, exercised directly)
    const draft = lifeDb.versions.get(1);
    draft.confirmations = {};
    for (const key of S.CONFIRMATION_KEYS) draft.confirmations[key] = { confirmedAt: "2026-08-01T00:00:00.000Z", actorId: "user-1" };
    draft.updated_at = "2026-08-01T10:00:00.000Z";
    const verdict = store.evaluateApproval({
      row: draft, profile: draft.profile, confirmations: draft.confirmations,
      actor: { type: "client", clientId: CLIENT, id: "user-1" }, expectedUpdatedAt: draft.updated_at,
    });
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict.blockers));
    draft.status = "approved";

    // Approval → plan
    const { service: bridgeService, db: bridgeDb } = bridgeHarness({ approved: draft });
    const bridged = await bridgeService.onProfileApproved({ clientId: CLIENT, sessionId: SESSION, approvedVersion: 1, actor: { type: "client", clientId: CLIENT, id: "user-1" } });
    assert.strictEqual(bridged.outcome, bridge.BRIDGE_OUTCOMES.ready);
    assert.strictEqual(bridged.executedAnything, false);
    assert.strictEqual(bridgeDb.plans.length, 1);

    // Mock provisioning
    const provisioned = [];
    const execution = await plans.executePlan({
      plan: bridged.plan, adapter: createMockAdapter(),
      onResourceProvisioned: async (r) => provisioned.push(r),
      logger: { error() {}, log() {} },
    });
    assert.strictEqual(execution.status, "completed");
    assert.strictEqual(provisioned.length, 3);

    // Retry is idempotent
    const retryRecorded = [];
    await plans.executePlan({
      plan: bridged.plan, adapter: createMockAdapter(),
      alreadyDone: new Set(provisioned.map((r) => r.idempotencyKey)),
      onResourceProvisioned: async (r) => retryRecorded.push(r),
      logger: { error() {}, log() {} },
    });
    assert.strictEqual(retryRecorded.length, 0, "a retry must not create duplicates");

    // Live execution still impossible
    const gate = plans.evaluateExecutionGate({
      plan: { ...bridged.plan, status: "approved_for_execution" }, config: cfg.getRetellConfig({}),
      actor: { type: "operator" }, currentApprovedVersion: 1, explicitRequest: true,
    });
    assert.strictEqual(gate.allowed, false);
  });
});

// ── Regression ──────────────────────────────────────────────────────

describe("M4 regression", () => {
  it("M1 remains dormant by default", () => {
    assert.strictEqual(require("../src/config/locksmith").isLocksmithPilotEnabled({}), false);
  });

  it("M2 client review remains behind client auth", () => {
    const ROUTES = fs.readFileSync(path.join(__dirname, "../src/routes/locksmith-onboarding.js"), "utf8");
    for (const line of ROUTES.split("\n").filter((l) => l.includes("/client/locksmith-onboarding"))) {
      assert.ok(line.includes("requireClientAuth"), `unprotected: ${line.trim()}`);
    }
  });

  it("M3 live writes and live calls remain disabled", () => {
    assert.strictEqual(cfg.canWriteLive({}).allowed, false);
    assert.strictEqual(cfg.canPlaceCall({}).allowed, false);
  });

  it("the mock simulator refuses to run outside development or test", () => {
    const source = fs.readFileSync(path.join(__dirname, "../scripts/locksmith-mock-journey.js"), "utf8");
    assert.match(source, /isExtractionRerunAllowed/);
    assert.match(source, /Refusing to run/);
    assert.ok(!/fetch\(|https?\.request/.test(source), "the simulator must contain no transport");
  });

  it("no M4 module imports a provider SDK or makes a network call", () => {
    const files = ["onboarding-call-consent.js", "onboarding-call-service.js", "onboarding-call-lifecycle.js", "approval-provisioning-bridge.js", "locksmith-test-plan.js", "locksmith-complexity.js"];
    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, "../src/services", file), "utf8");
      assert.ok(!/require\("retell-sdk"\)/.test(source), `${file} must not import the SDK`);
      assert.ok(!/\bfetch\(|https?\.request|axios/.test(source), `${file} must make no network call`);
    }
  });
});
