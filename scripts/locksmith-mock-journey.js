#!/usr/bin/env node
// AIDA — deterministic mock onboarding journey (M4, Part 20).
//
//   node scripts/locksmith-mock-journey.js
//
// Drives the COMPLETE journey — consent → call → webhooks → transcript →
// extraction → draft → review → correction → approval → provisioning plan →
// mock provisioning — using the REAL domain services and handlers against an
// in-memory database and the deterministic mock provider.
//
// It is not a re-implementation. Every step calls the same module the
// production path would, which is the only way a simulator is worth anything.
//
// IT CANNOT: contact Retell, contact Twilio, place a call, apply SQL, or read a
// production secret. There is no transport wired anywhere in this file.
//
// Guarded: refuses to run unless NODE_ENV is development or test.

const assert = require("node:assert");
const crypto = require("node:crypto");

const { isExtractionRerunAllowed } = require("../src/config/locksmith-onboarding");

if (!isExtractionRerunAllowed(process.env)) {
  console.error("Refusing to run: the mock journey is available only when NODE_ENV is development or test.");
  console.error("Run it with:  NODE_ENV=development node scripts/locksmith-mock-journey.js");
  process.exit(1);
}

// ── Real modules under test ─────────────────────────────────────────
require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT, DEMO_LABEL } = require("../src/services/locksmith-interview-spec");
const consentApi = require("../src/services/onboarding-call-consent");
const callService = require("../src/services/onboarding-call-service");
const lifecycle = require("../src/services/onboarding-call-lifecycle");
const store = require("../src/services/locksmith-profile-store");
const sessions = require("../src/services/locksmith-onboarding-session");
const intake = require("../src/services/locksmith-transcript-intake");
const { assessProvisioning } = require("../src/services/locksmith-profile");
const { compileReceptionist, toRetellPayload } = require("../src/services/locksmith-receptionist-compiler");
const plans = require("../src/services/provisioning-plan");
const registry = require("../src/services/provider-resource-registry");
const bridge = require("../src/services/approval-provisioning-bridge");
const { createMockAdapter, MODES } = require("../src/services/voice-platform-port");
const { getRetellConfig } = require("../src/config/retell");
const { renderReviewPage } = require("../src/views/locksmith-review-page");
const { renderCallPage } = require("../src/views/locksmith-call-page");
const { createOnboardingHandlers } = require("../src/routes/locksmith-onboarding-handlers");
const S = require("../src/services/locksmith-profile-schema");
const testPlan = require("../src/services/locksmith-test-plan");
const complexity = require("../src/services/locksmith-complexity");

// ── Fictional client. DEMONSTRATION DATA ONLY. ──────────────────────
const CLIENT_ID = "demo-locksmith";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CONSENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_ID = "demo-user";
// ACMA fictitious range — cannot reach a real handset.
const DESTINATION = "0491 570 006";

const CONFIG = getRetellConfig({});
let step = 0;
const results = [];

function say(title, detail = "") {
  step += 1;
  const line = `${String(step).padStart(2, "0")}. ${title}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  results.push(line);
}
function fail(message) {
  console.error(`\n✕ FAILED: ${message}`);
  process.exit(1);
}

// ── In-memory database ──────────────────────────────────────────────
// Stands in for the tables in lpm2/lpm3/lpm4. No SQL is applied anywhere.
const db = { sessions: new Map(), consents: new Map(), calls: new Map(), versions: new Map(), resources: [], plans: [], audit: [] };

const fakeSessions = {
  ...sessions,
  getSession: async (clientId, sessionId) => {
    const row = db.sessions.get(sessionId);
    return row && row.client_id === clientId ? row : null;
  },
  getSessionForOperator: async (sessionId) => db.sessions.get(sessionId) || null,
  transitionSession: async ({ clientId, sessionId, to }) => {
    const row = db.sessions.get(sessionId);
    if (!row) return { ok: false, code: "not_found" };
    const verdict = sessions.evaluateTransition(row.status, to);
    if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
    row.status = to;
    return { ok: true, row };
  },
  failSession: async ({ sessionId, code }) => {
    const row = db.sessions.get(sessionId);
    row.status = "failed";
    row.failure_code = code;
    return { ok: true, row };
  },
};

const fakeConsents = {
  ...consentApi,
  getConsent: async (clientId, consentId) => {
    const row = db.consents.get(consentId);
    return row && row.client_id === clientId ? row : null;
  },
  recordConsent: async (fields) => {
    db.consents.set(fields.consent_id, fields);
    return fields;
  },
  incrementAttempt: async (clientId, consentId, current) => {
    const row = db.consents.get(consentId);
    row.attempt_count = (current || 0) + 1;
    return { ok: true };
  },
};

const fakeCalls = {
  create: async (fields) => { db.calls.set(fields.call_id, fields); return fields; },
  update: async (clientId, callId, patch) => {
    const row = db.calls.get(callId);
    if (!row) return null;
    Object.assign(row, patch);
    return row;
  },
  findByRequestKey: async (clientId, key) => [...db.calls.values()].find((c) => c.client_id === clientId && c.request_key === key) || null,
  findActive: async (clientId, sessionId) =>
    [...db.calls.values()].find((c) => c.client_id === clientId && c.session_id === sessionId && callService.ACTIVE_STATUSES.includes(c.status)) || null,
  findByProviderCallId: async (id) => [...db.calls.values()].find((c) => c.provider_call_id === id) || null,
  findForSession: async (clientId, sessionId) => [...db.calls.values()].filter((c) => c.client_id === clientId && c.session_id === sessionId),
};

const fakeStore = {
  ...store,
  getApprovedVersion: async (clientId) => [...db.versions.values()].find((v) => v.client_id === clientId && v.status === "approved") || null,
  getVersion: async (clientId, version) => {
    const row = db.versions.get(version);
    return row && row.client_id === clientId ? row : null;
  },
  listAuditEvents: async () => db.audit,
  recordAuditEvent: async (e) => { db.audit.push(e); return true; },
  createDraftVersion: async ({ clientId, profile, sessionId, extractionVersion }) => {
    const version = db.versions.size + 1;
    const row = {
      client_id: clientId, version, status: "needs_review", profile, session_id: sessionId,
      extraction_version: extractionVersion, confirmations: {}, review_notes: {},
      provisioning_ready: assessProvisioning(profile).ready, blocking_reasons: assessProvisioning(profile).blockers,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.versions.set(version, row);
    db.audit.push({ event_type: "profile.draft_created", actor_type: "system", created_at: row.created_at });
    return row;
  },
  updateReviewState: async ({ version, confirmations, reviewNotes, expectedUpdatedAt }) => {
    const row = db.versions.get(version);
    if (expectedUpdatedAt && expectedUpdatedAt !== row.updated_at) return { ok: false, code: "stale_review", message: "stale" };
    row.confirmations = confirmations;
    if (reviewNotes) row.review_notes = reviewNotes;
    row.updated_at = new Date(Date.now() + db.versions.size + Math.random()).toISOString();
    return { ok: true, row };
  },
  approveVersion: async ({ clientId, version, actor, expectedUpdatedAt }) => {
    const row = db.versions.get(version);
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor, expectedUpdatedAt });
    if (!verdict.ok) return { ok: false, blockers: verdict.blockers };
    row.status = "approved";
    row.approved_at = new Date().toISOString();
    row.approved_by = actor.id;
    db.audit.push({ event_type: "profile.approved", actor_type: actor.type, created_at: row.approved_at });
    return { ok: true, row };
  },
  rejectVersion: async () => ({ ok: true }),
};

const fakePlanStore = {
  create: async (fields) => { const row = { ...fields, id: crypto.randomUUID() }; db.plans.push(row); return row; },
  findCurrent: async (clientId, version) => db.plans.find((p) => p.client_id === clientId && p.approved_profile_version === version && !p.superseded_at) || null,
  supersedeStale: async (clientId, version) => {
    let n = 0;
    for (const p of db.plans) {
      if (p.client_id === clientId && p.approved_profile_version !== version && !p.superseded_at) { p.superseded_at = new Date().toISOString(); p.status = "superseded"; n += 1; }
    }
    return n;
  },
  findForClient: async (clientId) => db.plans.filter((p) => p.client_id === clientId),
};

const fakeRegistry = {
  ...registry,
  listResources: async (clientId) => db.resources.filter((r) => r.client_id === clientId),
};

function fakeRes() {
  return {
    statusCode: null, headers: {}, body: null, contentType: null,
    set(k, v) { if (typeof k === "object") Object.assign(this.headers, k); else this.headers[k] = v; return this; },
    type(t) { this.contentType = t; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
  };
}
function fakeReq(body = {}) {
  return {
    clientId: CLIENT_ID, clientAuth: { mode: "cookie", user: { id: USER_ID } },
    params: { sessionId: SESSION_ID }, body,
    headers: { "content-type": "application/json" }, ip: "203.0.113.5", socket: { remoteAddress: "203.0.113.5" },
  };
}

// ── The journey ─────────────────────────────────────────────────────

async function run() {
  console.log(`\nAIDA locksmith — deterministic mock onboarding journey`);
  console.log(`${DEMO_LABEL}`);
  console.log(`Provider mode: MOCK. No network, no SQL, no provider, no call.\n`);

  // 1. Session
  db.sessions.set(SESSION_ID, {
    session_id: SESSION_ID, client_id: CLIENT_ID, status: "interview_ready",
    provider: null, provider_call_id: null, transcript_text: null, transcript_sha256: null,
    profile_version: null, review_warnings: [], missing_fields: [], contradictions: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  say("Onboarding session created", `status=${db.sessions.get(SESSION_ID).status}`);

  // 2. Consent — explicit, never pre-ticked
  const built = consentApi.buildConsent({
    consentId: CONSENT_ID, clientId: CLIENT_ID, sessionId: SESSION_ID, userId: USER_ID,
    destinationNumber: DESTINATION, callConsent: true, transcriptionConsent: true, recordingConsent: false,
  });
  if (!built.ok) fail(`consent refused: ${built.message}`);
  await fakeConsents.recordConsent(built.fields);
  say("Consent recorded", `number=${built.fields.destination_number}, recording=${built.fields.recording_consent}, disclosure=${built.fields.disclosure_version}`);

  // Prove a pre-ticked / absent affirmative is refused.
  const notTicked = consentApi.buildConsent({ ...built.fields, consentId: "x", clientId: CLIENT_ID, sessionId: SESSION_ID, userId: USER_ID, destinationNumber: DESTINATION, callConsent: "on", transcriptionConsent: true });
  if (notTicked.ok) fail("a non-boolean consent value was accepted");
  say("Non-explicit consent refused", `code=${notTicked.code}`);

  // 3. Request the call (mock mode)
  const service = callService.createOnboardingCallService({
    sessions: fakeSessions, consents: fakeConsents, calls: fakeCalls,
    recordAuditEvent: async (e) => { db.audit.push(e); return true; },
    logger: { error() {}, log() {} },
    localHour: () => 10,
    newCallId: () => "cccccccc-dddd-eeee-ffff-000000000000",
  });

  const requested = await service.requestOnboardingCall({
    clientId: CLIENT_ID, sessionId: SESSION_ID, requestedBy: USER_ID, consentId: CONSENT_ID, explicitMode: MODES.mock,
  });
  if (!requested.ok) fail(`call request refused: ${requested.message}`);
  const callRow = db.calls.get("cccccccc-dddd-eeee-ffff-000000000000");
  say("Onboarding call requested", `mode=${requested.mode}, status=${callRow.status}, providerCallId=${callRow.provider_call_id}`);

  // 4. Idempotency: the same request again returns the same call
  const again = await service.requestOnboardingCall({ clientId: CLIENT_ID, sessionId: SESSION_ID, requestedBy: USER_ID, consentId: CONSENT_ID, explicitMode: MODES.mock });
  if (!again.idempotent) fail("a duplicate call request was not idempotent");
  if (db.calls.size !== 1) fail(`a duplicate request created ${db.calls.size} calls`);
  say("Duplicate request was idempotent", "still exactly one call");

  // 5–7. Lifecycle events
  const life = lifecycle.createLifecycleService({
    calls: fakeCalls, sessions: fakeSessions, store: fakeStore,
    intake: {
      receiveOnboardingTranscript: async ({ clientId, sessionId, transcript, providerCallId }) => {
        const row = db.sessions.get(sessionId);
        const digest = intake.sha256(intake.normaliseTranscript(transcript));
        if (row.transcript_sha256 === digest) return { ok: true, code: "duplicate", sessionId };
        if (row.transcript_sha256) return { ok: false, code: "transcript_exists", message: "already has a different transcript" };
        row.transcript_text = transcript;
        row.transcript_sha256 = digest;
        row.provider_call_id = providerCallId;
        return { ok: true, code: "received", sessionId };
      },
    },
    recordAuditEvent: async (e) => { db.audit.push(e); return true; },
    logger: { error() {}, log() {} },
  });

  const providerCallId = callRow.provider_call_id;
  await life.handleEvent({ internalEvent: "onboarding_call.started", providerCallId, call: { call_id: providerCallId }, binding: { clientId: CLIENT_ID } });
  say("call_started received", `status=${db.calls.get(callRow.call_id).status}`);

  const ended = await life.handleEvent({
    internalEvent: "onboarding_call.ended",
    providerCallId,
    call: { call_id: providerCallId, call_status: "ended", disconnection_reason: "user_hangup", transcript: DEMO_TRANSCRIPT, duration_ms: 612000 },
    binding: { clientId: CLIENT_ID },
  });
  if (!ended.ok) fail(`call_ended handling failed: ${ended.message}`);
  say("call_ended received with transcript", `outcome=${ended.outcome}, draft version=${ended.profileVersion}`);
  if (ended.outcome !== "draft_created") fail(`expected a draft to be created, got ${ended.outcome}`);

  // 8. A duplicate call_ended must not create a second draft
  const dupe = await life.handleEvent({
    internalEvent: "onboarding_call.ended", providerCallId,
    call: { call_id: providerCallId, transcript: DEMO_TRANSCRIPT }, binding: { clientId: CLIENT_ID },
  });
  if (db.versions.size !== 1) fail(`a duplicate call_ended created ${db.versions.size} versions`);
  say("Duplicate call_ended ignored", `outcome=${dupe.outcome}, versions=${db.versions.size}`);

  // 9. Out-of-order: a late call_started must not drag the call backwards
  const late = await life.handleEvent({ internalEvent: "onboarding_call.started", providerCallId, call: { call_id: providerCallId }, binding: { clientId: CLIENT_ID } });
  if (late.outcome !== lifecycle.OUTCOMES.lateIgnored) fail(`a late event was not reconciled: ${late.outcome}`);
  say("Late out-of-order event reconciled", `outcome=${late.outcome}`);

  // 10. Analysis arrives after the call — supplements, never approves
  const analysed = await life.handleEvent({
    internalEvent: "onboarding_call.analysis_received", providerCallId,
    call: {
      call_id: providerCallId,
      call_analysis: { consent_provided: true, onboarding_completed: true, call_outcome: "completed", pricing_authority: "may_not_mention", transfer_primary_number: "0491 570 006" },
    },
    binding: { clientId: CLIENT_ID },
  });
  if (analysed.approved !== false || analysed.canApprove !== false) fail("provider analysis claimed approval authority");
  say("Analysis received", `warnings=${analysed.warnings.length}, approved=${analysed.approved} (analysis can never approve)`);

  // 11. Review page renders
  const draft = db.versions.get(1);
  const handlers = createOnboardingHandlers({
    sessions: fakeSessions, store: fakeStore, logger: { error() {}, log() {} }, env: { NODE_ENV: "development" },
  });
  db.sessions.get(SESSION_ID).profile_version = 1;
  const pageRes = fakeRes();
  await handlers.clientReviewPage(fakeReq(), pageRes);
  if (pageRes.statusCode !== 200) fail(`review page returned ${pageRes.statusCode}`);
  say("Review page rendered", `${pageRes.body.length} bytes, session=${db.sessions.get(SESSION_ID).status}`);

  // 12. Confirm every section
  let token = draft.updated_at;
  for (const section of S.CONFIRMATION_KEYS) {
    const res = fakeRes();
    await handlers.clientConfirmSection(fakeReq({ section, expectedUpdatedAt: token }), res);
    if (res.statusCode !== 200) fail(`confirming ${section} returned ${res.statusCode}: ${JSON.stringify(res.body)}`);
    token = res.body.updatedAt;
  }
  say("All sections confirmed", `${Object.keys(draft.confirmations).length}/${S.CONFIRMATION_KEYS.length}`);

  // 13. A correction clears that section's confirmation
  const noteRes = fakeRes();
  await handlers.clientSaveNote(fakeReq({ section: "hours", note: "Saturdays are 8 to 3, not 8 to 1.", expectedUpdatedAt: token }), noteRes);
  if (noteRes.statusCode !== 200) fail(`saving a correction returned ${noteRes.statusCode}`);
  token = noteRes.body.updatedAt;
  if (draft.confirmations.hours) fail("a correction did not clear the section's confirmation");
  say("Correction cleared its confirmation", "hours is no longer confirmed");

  // 14. Approval is refused while that section is unconfirmed
  const blockedRes = fakeRes();
  await handlers.clientApprove(fakeReq({ expectedUpdatedAt: token }), blockedRes);
  if (blockedRes.statusCode !== 422) fail(`approval should have been refused, got ${blockedRes.statusCode}`);
  say("Approval refused while a section is unconfirmed", blockedRes.body.blockers.map((b) => b.code).join(","));

  // 15. Reconfirm, then approve
  const reRes = fakeRes();
  await handlers.clientConfirmSection(fakeReq({ section: "hours", expectedUpdatedAt: token }), reRes);
  token = reRes.body.updatedAt;
  const approveRes = fakeRes();
  await handlers.clientApprove(fakeReq({ expectedUpdatedAt: token }), approveRes);
  if (approveRes.statusCode !== 200) fail(`approval failed: ${JSON.stringify(approveRes.body)}`);
  say("Profile approved", `version=${approveRes.body.version}, status=${draft.status}`);

  // 16. Approval → provisioning plan
  const approvalBridge = bridge.createApprovalBridge({
    store: fakeStore, registry: fakeRegistry, planStore: fakePlanStore,
    recordAuditEvent: async (e) => { db.audit.push(e); return true; },
    logger: { error() {}, log() {} },
  });
  const bridged = await approvalBridge.onProfileApproved({
    clientId: CLIENT_ID, sessionId: SESSION_ID, approvedVersion: 1,
    actor: { type: "client", clientId: CLIENT_ID, id: USER_ID },
  });
  if (!bridged.ok) fail(`the provisioning bridge failed: ${bridged.message}`);
  if (bridged.executedAnything !== false) fail("the bridge executed something");
  say("Provisioning plan generated", `outcome=${bridged.outcome}, hash=${bridged.planHash.slice(0, 16)}, ops=${bridged.plan.estimatedApiOperations}`);
  say("Client status message", `"${bridged.clientMessage}"`);

  // 17. Mock provisioning stores mock resource ids
  const mockAdapter = createMockAdapter();
  const provisioned = [];
  const execution = await plans.executePlan({
    plan: bridged.plan, adapter: mockAdapter,
    onResourceProvisioned: async (r) => {
      provisioned.push(r);
      db.resources.push({
        client_id: CLIENT_ID, provider: "retell", purpose: r.purpose, resource_type: r.resourceType,
        provider_resource_id: r.providerResourceId, payload_hash: r.payloadHash, idempotency_key: r.idempotencyKey,
        active: true, profile_version: 1,
      });
    },
    logger: { error() {}, log() {} },
  });
  if (execution.status !== "completed") fail(`mock provisioning ended ${execution.status}`);
  say("Mock provisioning completed", `${execution.summary.succeeded} resources: ${provisioned.map((r) => r.providerResourceId.split("_")[0]).join(", ")}`);

  // 18. Re-planning is idempotent — everything is now a no-op
  const rePlanned = await approvalBridge.onProfileApproved({
    clientId: CLIENT_ID, sessionId: SESSION_ID, approvedVersion: 1,
    actor: { type: "client", clientId: CLIENT_ID, id: USER_ID },
  });
  if (rePlanned.plan.estimatedApiOperations !== 0) fail(`re-planning wanted ${rePlanned.plan.estimatedApiOperations} operations; expected 0`);
  say("Re-planning produced no work", `noops=${rePlanned.plan.noopActions}, creates=${rePlanned.plan.createActions}`);

  // 19. Retrying execution does not duplicate resources
  const before = db.resources.length;
  const done = new Set(provisioned.map((r) => r.idempotencyKey));
  await plans.executePlan({ plan: bridged.plan, adapter: createMockAdapter(), alreadyDone: done, onResourceProvisioned: async () => { db.resources.push({}); }, logger: { error() {}, log() {} } });
  if (db.resources.length !== before) fail(`a retry created ${db.resources.length - before} duplicate resources`);
  say("Retry created no duplicates", `${db.resources.length} resources total`);

  // 20. Live execution is still impossible
  const gate = plans.evaluateExecutionGate({
    plan: { ...bridged.plan, status: "approved_for_execution" }, config: CONFIG,
    actor: { type: "operator", id: "founder" }, currentApprovedVersion: 1, explicitRequest: true,
  });
  if (gate.allowed) fail("live execution was permitted under the shipped configuration");
  say("Live execution refused", `${gate.reasons.length} reasons, e.g. "${gate.reasons[0]}"`);

  // 21. Generated receptionist test plan
  const generated = testPlan.generateTestPlan({ profile: draft.profile, profileVersion: 1, clientId: CLIENT_ID });
  say("Receptionist test plan generated", `${generated.caseCount} cases, ${generated.safetyCaseIds.length} safety cases`);

  // 22. Micro-complexity assessment
  const assessed = complexity.assessComplexity({ profile: draft.profile, profileVersion: 1 });
  say("Micro complexity assessed", `micro=${assessed.microCompatible}, tier=${assessed.minimumOperationalTier}, billingEffect=${assessed.billingEffect}`);

  // 23. Final client-facing status page
  const finalPage = renderCallPage({
    clientId: CLIENT_ID,
    session: { sessionId: SESSION_ID },
    state: "provisioning_ready",
    disclosure: consentApi.getDisclosure(),
    destinationNumber: DESTINATION,
    call: callService.toPublicCall(db.calls.get(callRow.call_id)),
    providerAvailable: false,
    providerMode: "mock",
    provisioningStatus: bridged.clientMessage,
    isDemo: true,
  });
  say("Final client status page rendered", `${finalPage.length} bytes`);

  // ── Safety assertions ──
  assert.ok(!finalPage.includes(DESTINATION.replace(/\s/g, "")), "the full destination number must not appear on the status page");
  assert.strictEqual(db.calls.size, 1, "exactly one call");
  assert.strictEqual(db.versions.size, 1, "exactly one profile version");
  assert.strictEqual(draft.status, "approved");

  console.log(`\n✓ Journey complete: consent → call → webhooks → transcript → draft → review → approval → plan → mock provisioning.`);
  console.log(`  Calls placed: 0. Network requests: 0. SQL applied: 0. Provider resources created: 0 (${provisioned.length} mock ids only).`);
  console.log(`  Audit events recorded: ${db.audit.length}.\n`);
}

run().catch((err) => {
  console.error(`\n✕ Journey threw: ${err.stack}`);
  process.exit(1);
});
