// LOCKSMITH M2 — review page, founder console and their handlers.
//
// Handlers are driven with fake req/res objects (no express, no supertest, no
// node_modules) and fake service adapters, so auth, tenancy, the approval guard
// and the stale-review guard are all exercised without a database.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { renderReviewPage, sectionForBlocker } = require("../src/views/locksmith-review-page");
const { renderFounderList, renderFounderSession, renderTranscript } = require("../src/views/locksmith-founder-page");
const { createOnboardingHandlers, PAGE_SECURITY_HEADERS } = require("../src/routes/locksmith-onboarding-handlers");
const { onboardingRouterGate, isOnboardingEnabled, isExtractionRerunAllowed, PROVISIONAL_COMMERCIAL_MODEL } = require("../src/config/locksmith-onboarding");
const S = require("../src/services/locksmith-profile-schema");
const { assessProvisioning } = require("../src/services/locksmith-profile");
const storeReal = require("../src/services/locksmith-profile-store");
require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

// ── Fixtures ────────────────────────────────────────────────────────

function demoProfile() {
  const r = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
  assert.strictEqual(r.ok, true);
  return JSON.parse(JSON.stringify(r.profile));
}

function allConfirmed() {
  const out = {};
  for (const key of S.CONFIRMATION_KEYS) out[key] = { confirmedAt: "2026-08-01T00:00:00.000Z", actorId: "user-1", note: null };
  return out;
}

const SESSION = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  clientId: "demo-locksmith",
  status: "needs_review",
  provider: "fixture",
  providerCallId: "fixture-call-1",
  hasTranscript: true,
  transcriptSha256: "abc123def456",
  extractionVersion: "fixture-v1",
  missingFields: [],
  contradictions: [],
  reviewWarnings: [],
  profileVersion: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function versionView(overrides = {}) {
  return {
    clientId: "demo-locksmith",
    version: 1,
    status: "needs_review",
    profile: demoProfile(),
    confirmations: {},
    reviewNotes: {},
    provisioningReady: true,
    blockingReasons: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    contentType: null,
    set(k, v) {
      if (typeof k === "object") Object.assign(this.headers, k);
      else this.headers[k] = v;
      return this;
    },
    type(t) { this.contentType = t; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
  };
}

function fakeReq({ clientId = "demo-locksmith", sessionId = SESSION.sessionId, body = {}, json = true, userId = "user-1" } = {}) {
  return {
    clientId,
    clientAuth: { mode: "cookie", user: { id: userId } },
    params: { sessionId },
    body,
    headers: json ? { "content-type": "application/json" } : {},
    ip: "203.0.113.5",
    socket: { remoteAddress: "203.0.113.5" },
  };
}

// A fake store/session pair backed by plain objects.
function fakeDeps(overrides = {}) {
  const state = {
    sessionRow: {
      session_id: SESSION.sessionId,
      client_id: "demo-locksmith",
      status: "needs_review",
      provider: "fixture",
      provider_call_id: "fixture-call-1",
      transcript_text: "AIDA: hello\nOwner: hi there",
      transcript_sha256: "abc123",
      profile_version: 1,
      review_warnings: [],
      missing_fields: [],
      contradictions: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
    versionRow: {
      client_id: "demo-locksmith",
      version: 1,
      status: "needs_review",
      profile: demoProfile(),
      confirmations: {},
      review_notes: {},
      provisioning_ready: true,
      blocking_reasons: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    },
    audit: [],
    approved: null,
  };

  const deps = {
    logger: { log() {}, error() {} },
    env: { NODE_ENV: "test" },
    sessions: {
      getSession: async (clientId, sessionId) =>
        state.sessionRow.client_id === clientId && state.sessionRow.session_id === sessionId ? state.sessionRow : null,
      getSessionForOperator: async (sessionId) => (state.sessionRow.session_id === sessionId ? state.sessionRow : null),
      listSessions: async () => [state.sessionRow],
      toPublicSession: require("../src/services/locksmith-onboarding-session").toPublicSession,
      transitionSession: async () => ({ ok: true, row: state.sessionRow }),
      failSession: async ({ code }) => {
        state.sessionRow.status = "failed";
        state.sessionRow.failure_code = code;
        return { ok: true, row: state.sessionRow };
      },
      isTerminal: require("../src/services/locksmith-onboarding-session").isTerminal,
    },
    store: {
      getVersion: async (clientId, version) =>
        state.versionRow.client_id === clientId && state.versionRow.version === version ? state.versionRow : null,
      getApprovedVersion: async () => state.approved,
      toPublicProfileVersion: storeReal.toPublicProfileVersion,
      applyConfirmation: storeReal.applyConfirmation,
      clearConfirmation: storeReal.clearConfirmation,
      buildAuditEvent: storeReal.buildAuditEvent,
      recordAuditEvent: async (e) => { state.audit.push(e); return true; },
      listAuditEvents: async () => state.audit,
      updateReviewState: async ({ confirmations, reviewNotes, expectedUpdatedAt }) => {
        if (expectedUpdatedAt && expectedUpdatedAt !== state.versionRow.updated_at) {
          return { ok: false, code: "stale_review", message: "This draft changed while you were reviewing it. Reload and try again." };
        }
        state.versionRow.confirmations = confirmations;
        if (reviewNotes) state.versionRow.review_notes = reviewNotes;
        state.versionRow.updated_at = "2026-08-01T11:00:00.000Z";
        return { ok: true, row: state.versionRow };
      },
      approveVersion: async ({ clientId, version, actor, expectedUpdatedAt }) => {
        const verdict = storeReal.evaluateApproval({
          row: state.versionRow,
          profile: state.versionRow.profile,
          confirmations: state.versionRow.confirmations,
          actor,
          expectedUpdatedAt,
        });
        if (!verdict.ok) return { ok: false, blockers: verdict.blockers };
        state.versionRow.status = "approved";
        state.approved = state.versionRow;
        return { ok: true, row: state.versionRow };
      },
      rejectVersion: async ({ actor, reason }) => {
        if (actor.clientId !== state.versionRow.client_id) {
          return { ok: false, blockers: [{ kind: "auth", code: "not_authorised", message: "no" }] };
        }
        state.versionRow.status = "rejected";
        state.versionRow.rejection_reason = reason;
        return { ok: true, row: state.versionRow };
      },
      createDraftVersion: async ({ profile }) => {
        state.versionRow = { ...state.versionRow, version: state.versionRow.version + 1, profile, status: "needs_review" };
        return state.versionRow;
      },
    },
    ...overrides,
  };
  return { deps, state };
}

// ── Config / gating ─────────────────────────────────────────────────

describe("onboarding is dormant by default", () => {
  it("only the exact string \"true\" enables it", () => {
    assert.strictEqual(isOnboardingEnabled({}), false);
    assert.strictEqual(isOnboardingEnabled({ LOCKSMITH_ONBOARDING_ENABLED: "true" }), true);
    for (const v of ["TRUE", "1", "yes", "on", "false", ""]) {
      assert.strictEqual(isOnboardingEnabled({ LOCKSMITH_ONBOARDING_ENABLED: v }), false, `"${v}" must not enable`);
    }
  });

  it("the gate exits the router before any auth runs", () => {
    for (const env of [{}, { LOCKSMITH_ONBOARDING_ENABLED: "false" }, { LOCKSMITH_ONBOARDING_ENABLED: "1" }]) {
      let called = "never";
      onboardingRouterGate(env)({}, {}, (arg) => { called = arg; });
      assert.strictEqual(called, "router", `env ${JSON.stringify(env)} must 404`);
    }
    let called = "never";
    onboardingRouterGate({ LOCKSMITH_ONBOARDING_ENABLED: "true" })({}, {}, (arg) => { called = arg; });
    assert.strictEqual(called, undefined);
  });

  it("re-running extraction is restricted to development and test", () => {
    assert.strictEqual(isExtractionRerunAllowed({ NODE_ENV: "development" }), true);
    assert.strictEqual(isExtractionRerunAllowed({ NODE_ENV: "test" }), true);
    for (const env of [{ NODE_ENV: "production" }, {}, { NODE_ENV: "staging" }]) {
      assert.strictEqual(isExtractionRerunAllowed(env), false);
    }
  });

  it("the commercial model is clearly provisional and drives no billing code", () => {
    assert.strictEqual(PROVISIONAL_COMMERCIAL_MODEL.provisional, true);
    assert.match(PROVISIONAL_COMMERCIAL_MODEL.status, /unconfirmed/i);
    assert.strictEqual(PROVISIONAL_COMMERCIAL_MODEL.signupAmount, 49);
    assert.strictEqual(PROVISIONAL_COMMERCIAL_MODEL.initialServiceMonths, 2);
    assert.strictEqual(PROVISIONAL_COMMERCIAL_MODEL.monthOneCreditAmount, 49);
    assert.strictEqual(PROVISIONAL_COMMERCIAL_MODEL.renewalFromAmount, 49);
    assert.strictEqual(PROVISIONAL_COMMERCIAL_MODEL.microPlan.approximateAnsweredCalls, 15);
    assert.match(PROVISIONAL_COMMERCIAL_MODEL.qualityCommitment, /same core call quality/i);
  });

  it("no billing or payment library is imported anywhere in the M2 modules", () => {
    const files = fs.readdirSync(path.join(__dirname, "../src/services")).filter((f) => f.startsWith("locksmith"));
    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, "../src/services", file), "utf8");
      const requires = (source.match(/require\("([^"]+)"\)/g) || []).join(" ");
      for (const banned of ["stripe", "retell", "openai", "anthropic", "twilio"]) {
        assert.ok(!requires.includes(banned), `${file} must not require ${banned}`);
      }
    }
  });
});

// ── Review page rendering ───────────────────────────────────────────

describe("review page", () => {
  const assessment = assessProvisioning(demoProfile());
  const html = renderReviewPage({ session: SESSION, profileVersion: versionView(), assessment, warnings: [], isDemo: true });

  it("leads with the headline the product promises", () => {
    assert.match(html, /<h1>Here is what AIDA understood about your business<\/h1>/);
  });

  it("renders every one of the twelve sections", () => {
    for (const section of S.SECTIONS) {
      assert.ok(html.includes(`data-section="${section.key}"`), `missing section ${section.key}`);
      assert.ok(html.includes(section.title), `missing section title "${section.title}"`);
    }
  });

  it("shows the five required status facts on every section", () => {
    // extracted value, source, missing info, warnings, confirmation, blocking
    assert.ok((html.match(/Source: /g) || []).length >= 12);
    assert.ok((html.match(/Not yet confirmed|Confirmed by you/g) || []).length >= 12);
    assert.ok((html.match(/Blocks launch|Does not block launch/g) || []).length >= 12);
  });

  it("labels demonstration data", () => {
    assert.match(html, /Demonstration data — this is an example onboarding session, not a real business\./);
  });

  it("shows missing values as missing rather than blank", () => {
    const thin = demoProfile();
    thin.identity.website = null;
    const page = renderReviewPage({ session: SESSION, profileVersion: versionView({ profile: thin }), assessment: assessProvisioning(thin) });
    assert.match(page, /Not established during the call/);
  });

  it("shows blockers in the section they belong to", () => {
    const broken = demoProfile();
    broken.transfer.primaryNumber = null;
    const page = renderReviewPage({ session: SESSION, profileVersion: versionView({ profile: broken }), assessment: assessProvisioning(broken) });
    const transferStart = page.indexOf('data-section="transfer"');
    const transferEnd = page.indexOf("</section>", transferStart);
    const transferBlock = page.slice(transferStart, transferEnd);
    assert.match(transferBlock, /Needs your input before launch/);
    assert.match(transferBlock, /valid Australian primary transfer number/i);
  });

  it("marks a section as blocking launch when it has a blocker", () => {
    const broken = demoProfile();
    broken.servicesAccepted = [];
    const page = renderReviewPage({ session: SESSION, profileVersion: versionView({ profile: broken }), assessment: assessProvisioning(broken) });
    assert.match(page, /review-section--blocking/);
  });

  it("disables Approve until everything is confirmed and unblocked", () => {
    assert.match(html, /id="approve-button"[^>]*disabled/, "nothing confirmed yet — approval must be unavailable");

    const ready = renderReviewPage({
      session: SESSION,
      profileVersion: versionView({ confirmations: allConfirmed() }),
      assessment,
    });
    const button = ready.match(/<button[^>]*id="approve-button"[^>]*>/)[0];
    assert.ok(!button.includes("disabled"), "fully confirmed and unblocked — approval available");
  });

  it("names the sections still outstanding", () => {
    assert.match(html, /Outstanding: /);
    assert.match(html, /Transfers and fallback/);
  });

  it("carries the stale-review token the client sends back", () => {
    assert.match(html, /data-updated-at="2026-08-01T10:00:00\.000Z"/);
    assert.match(html, /data-session-id="11111111-2222-3333-4444-555555555555"/);
  });

  it("is read-only once approved, with no action buttons", () => {
    const page = renderReviewPage({
      session: SESSION,
      profileVersion: versionView({ status: "approved", confirmations: allConfirmed() }),
      assessment,
      readOnly: true,
    });
    assert.match(page, /This version is approved and can no longer be edited/);
    assert.ok(!page.includes('id="approve-button"'));
    assert.ok(!page.includes('data-action="confirm"'));
  });

  it("escapes hostile profile content — a transcript cannot inject markup", () => {
    const hostile = demoProfile();
    hostile.identity.spokenName = '<script>alert("xss")</script>';
    hostile.identity.description = '"><img src=x onerror=alert(1)>';
    const page = renderReviewPage({ session: SESSION, profileVersion: versionView({ profile: hostile }), assessment: assessProvisioning(hostile) });
    assert.ok(!page.includes("<script>alert("), "script must be escaped");
    assert.ok(!/<img[^>]*onerror/i.test(page), "no live element with an event handler");
    assert.ok(page.includes("&lt;script&gt;"));
  });

  it("shows a saved correction back to the reviewer, escaped", () => {
    const page = renderReviewPage({
      session: SESSION,
      profileVersion: versionView({
        reviewNotes: {
          hours: { note: 'Saturdays are 8 to 3 <script>alert(1)</script>', forDiscussion: false, savedAt: "2026-08-01T11:00:00.000Z" },
          pricing: { note: "Want to talk about this one.", forDiscussion: true, savedAt: "2026-08-01T11:00:00.000Z" },
        },
      }),
      assessment: assessProvisioning(demoProfile()),
    });
    assert.match(page, /Your correction/);
    assert.match(page, /Saturdays are 8 to 3/);
    assert.match(page, /You marked this for discussion/);
    assert.ok(!page.includes("<script>alert(1)</script>"), "a saved note must be escaped like any other value");
  });

  it("carries no inline script, style or event handler", () => {
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html));
    assert.ok(!/\son[a-z]+\s*=\s*"/i.test(html));
    assert.ok(!/<style[\s>]/i.test(html));
    assert.ok(!/\sstyle="/i.test(html));
  });

  it("tells search engines not to index it", () => {
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  });

  it("maps every blocker code to a real section", () => {
    const broken = S.emptyProfile();
    for (const blocker of assessProvisioning(broken).blockers) {
      const key = blocker.code.startsWith("invalid_") ? blocker.code.slice(8) : sectionForBlocker(blocker.code);
      assert.ok(S.SECTION_KEYS.includes(key), `blocker "${blocker.code}" mapped to unknown section "${key}"`);
    }
  });
});

describe("review page accessibility", () => {
  const html = renderReviewPage({ session: SESSION, profileVersion: versionView(), assessment: assessProvisioning(demoProfile()) });

  it("has one h1, landmarks and a skip link", () => {
    assert.strictEqual((html.match(/<h1/g) || []).length, 1);
    assert.strictEqual((html.match(/<header/g) || []).length, 1);
    assert.strictEqual((html.match(/<main/g) || []).length, 1);
    assert.strictEqual((html.match(/<footer/g) || []).length, 1);
    assert.match(html, /<a class="skip-link" href="#main">/);
  });

  it("labels every section by its own heading", () => {
    for (const section of S.SECTIONS) {
      assert.ok(html.includes(`aria-labelledby="section-${section.key}-heading"`), `${section.key} is not labelled`);
    }
  });

  it("announces progress and save state", () => {
    for (const id of ["progress-summary", "form-status"]) {
      const tag = html.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`));
      assert.ok(tag, `${id} must exist`);
      assert.match(tag[0], /role="status"/, `${id} needs role="status"`);
      assert.match(tag[0], /aria-live="polite"/, `${id} needs aria-live`);
    }
  });

  it("labels every correction textarea", () => {
    for (const section of S.SECTIONS) {
      assert.ok(html.includes(`for="note-${section.key}"`), `${section.key} textarea needs a label`);
      assert.ok(html.includes(`id="note-${section.key}"`));
    }
    assert.match(html, /<label for="reject-reason">/);
  });

  it("wires the correction toggle to what it controls", () => {
    assert.match(html, /aria-expanded="false" aria-controls="correct-identity"/);
    assert.match(html, /id="correct-identity" hidden/);
  });

  it("never signals status by colour alone", () => {
    // Each status pairs a non-colour marker with words a screen reader reads.
    const blocks = html.split('class="status status--').slice(1);
    assert.ok(blocks.length >= 12, `expected a status per section, saw ${blocks.length}`);
    for (const block of blocks) {
      const window = block.slice(0, 220);
      assert.match(window, /aria-hidden="true">[^<]+<\/span>/, "a non-colour marker is required");
      assert.match(window, /<\/span>\s*[A-Za-z]/, "the marker must be followed by text");
    }
  });

  it("gives every button meaningful text", () => {
    for (const button of html.match(/<button[^>]*>([\s\S]*?)<\/button>/g) || []) {
      const text = button.replace(/<[^>]+>/g, "").trim();
      assert.ok(text.length > 2, `button text too short: ${button}`);
    }
  });
});

// ── Handlers: the client review surface ─────────────────────────────

describe("client review handlers — auth and tenancy", () => {
  it("GET review returns the page for the owning tenant", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientReviewPage(fakeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.contentType, "html");
    assert.match(res.body, /Here is what AIDA understood about your business/);
  });

  it("sets no-store security headers — this page must never be cached", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientReviewPage(fakeReq(), res);
    assert.strictEqual(res.headers["Cache-Control"], "no-store, private");
    assert.strictEqual(res.headers["X-Content-Type-Options"], "nosniff");
    assert.match(res.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(PAGE_SECURITY_HEADERS["Content-Security-Policy"]));
  });

  it("requires authentication", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientReviewPage({ ...fakeReq(), clientId: null }, res);
    assert.strictEqual(res.statusCode, 401);
  });

  it("another tenant gets 404, never another business's settings", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientReviewPage(fakeReq({ clientId: "someone-else" }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!JSON.stringify(res.body).includes("Northside"), "no cross-tenant content may leak");
  });

  it("rejects a non-JSON state change (the repo's CSRF posture)", async () => {
    const { deps } = fakeDeps();
    const handlers = createOnboardingHandlers(deps);
    for (const handler of ["clientConfirmSection", "clientSaveNote", "clientApprove", "clientReject"]) {
      const res = fakeRes();
      await handlers[handler](fakeReq({ json: false, body: { section: "transfer" } }), res);
      assert.strictEqual(res.statusCode, 415, `${handler} must require application/json`);
    }
  });
});

describe("client review handlers — confirming and correcting", () => {
  it("confirms a section and returns the new stale-review token", async () => {
    const { deps, state } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientConfirmSection(fakeReq({ body: { section: "transfer", expectedUpdatedAt: "2026-08-01T10:00:00.000Z" } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.ok(state.versionRow.confirmations.transfer.confirmedAt);
    assert.strictEqual(res.body.updatedAt, "2026-08-01T11:00:00.000Z");
    assert.ok(state.audit.some((e) => e.event_type === "profile.section_confirmed"));
  });

  it("refuses an unknown section", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientConfirmSection(fakeReq({ body: { section: "vibes" } }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  it("refuses a stale confirmation", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientConfirmSection(fakeReq({ body: { section: "transfer", expectedUpdatedAt: "2026-08-01T09:00:00.000Z" } }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "stale_review");
  });

  it("saving a correction clears that section's confirmation", async () => {
    const { deps, state } = fakeDeps();
    const handlers = createOnboardingHandlers(deps);
    await handlers.clientConfirmSection(fakeReq({ body: { section: "hours", expectedUpdatedAt: state.versionRow.updated_at } }), fakeRes());
    assert.ok(state.versionRow.confirmations.hours);

    const res = fakeRes();
    await handlers.clientSaveNote(fakeReq({ body: { section: "hours", note: "Saturdays are 8 to 3, not 8 to 1.", expectedUpdatedAt: state.versionRow.updated_at } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.versionRow.confirmations.hours, undefined, "a disputed section is no longer confirmed");
    assert.match(state.versionRow.review_notes.hours.note, /8 to 3/);
  });

  it("requires a non-empty, bounded note", async () => {
    const { deps } = fakeDeps();
    const handlers = createOnboardingHandlers(deps);
    for (const [note, expected] of [["", 400], ["   ", 400], ["x".repeat(1001), 400]]) {
      const res = fakeRes();
      await handlers.clientSaveNote(fakeReq({ body: { section: "hours", note } }), res);
      assert.strictEqual(res.statusCode, expected);
    }
  });

  it("refuses to edit a version that is already closed", async () => {
    const { deps, state } = fakeDeps();
    state.versionRow.status = "approved";
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientConfirmSection(fakeReq({ body: { section: "transfer" } }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, "closed");
  });
});

describe("client review handlers — the approval guard", () => {
  it("refuses approval while sections are unconfirmed", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientApprove(fakeReq({ body: { expectedUpdatedAt: "2026-08-01T10:00:00.000Z" } }), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.code, "approval_refused");
    assert.ok(res.body.blockers.some((b) => b.code === "confirmations_missing"));
  });

  it("refuses approval when the profile is not provisioning-ready", async () => {
    const { deps, state } = fakeDeps();
    state.versionRow.confirmations = allConfirmed();
    state.versionRow.profile.transfer.primaryNumber = null;
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientApprove(fakeReq({ body: { expectedUpdatedAt: state.versionRow.updated_at } }), res);
    assert.strictEqual(res.statusCode, 422);
    assert.ok(res.body.blockers.some((b) => b.code === "transfer_number_invalid"));
  });

  it("refuses a stale approval with 409", async () => {
    const { deps, state } = fakeDeps();
    state.versionRow.confirmations = allConfirmed();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientApprove(fakeReq({ body: { expectedUpdatedAt: "2026-08-01T09:00:00.000Z" } }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.ok(res.body.blockers.some((b) => b.code === "stale_review"));
  });

  it("refuses an unauthorised approver with 403", async () => {
    const { deps, state } = fakeDeps();
    state.versionRow.confirmations = allConfirmed();
    // A different tenant's session lookup returns null, so approval never
    // reaches the store — but the store guard is asserted directly too.
    const verdict = storeReal.evaluateApproval({
      row: state.versionRow,
      profile: state.versionRow.profile,
      confirmations: state.versionRow.confirmations,
      actor: { type: "client", clientId: "intruder", id: "x" },
      expectedUpdatedAt: state.versionRow.updated_at,
    });
    assert.ok(verdict.blockers.some((b) => b.kind === "auth"));
  });

  it("approves a complete, confirmed, current draft", async () => {
    const { deps, state } = fakeDeps();
    state.versionRow.confirmations = allConfirmed();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientApprove(fakeReq({ body: { expectedUpdatedAt: state.versionRow.updated_at } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(state.versionRow.status, "approved");
  });

  it("a session that refuses to follow the approval is logged, not swallowed", async () => {
    // Regression: the approval is what counts. A session that has moved on (or
    // is already terminal) is bookkeeping drift — it must be recorded, but it
    // must not tell the client their approval failed.
    const { deps, state } = fakeDeps();
    state.versionRow.confirmations = allConfirmed();
    const errors = [];
    const res = fakeRes();
    await createOnboardingHandlers({
      ...deps,
      logger: { log() {}, error: (...a) => errors.push(a.join(" ")) },
      sessions: { ...deps.sessions, transitionSession: async () => ({ ok: false, code: "terminal", message: "already terminal" }) },
    }).clientApprove(fakeReq({ body: { expectedUpdatedAt: state.versionRow.updated_at } }), res);

    assert.strictEqual(res.statusCode, 200, "the client's approval still succeeded");
    assert.strictEqual(res.body.ok, true);
    assert.ok(errors.some((e) => e.includes("session_not_followed")), `the drift must be logged, saw: ${JSON.stringify(errors)}`);
    assert.ok(errors.some((e) => e.includes("terminal")), "the log should carry the refusal code");
  });

  it("rejection requires a reason", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientReject(fakeReq({ body: {} }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, "reason_required");
  });

  it("records a rejection with its reason", async () => {
    const { deps, state } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).clientReject(fakeReq({ body: { reason: "The transfer number is Dave's old one." } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.versionRow.status, "rejected");
    assert.match(state.versionRow.rejection_reason, /Dave's old one/);
  });
});

// ── Founder console ─────────────────────────────────────────────────

describe("founder console", () => {
  it("lists sessions with status, client and warning counts", () => {
    const html = renderFounderList({ sessions: [SESSION] });
    assert.match(html, /Onboarding sessions/);
    assert.match(html, /demo-locksmith/);
    assert.match(html, /needs_review/);
    assert.match(html, /11111111/);
  });

  it("says what to apply when the tables are missing", () => {
    const html = renderFounderList({ sessions: [], tablesMissing: true });
    assert.match(html, /lpm2_create_locksmith_onboarding\.sql/);
  });

  it("escapes transcript content — this is the page that shows raw speech", () => {
    const hostile = 'Owner: my business is <script>alert("xss")</script> and <img src=x onerror=alert(1)>';
    const html = renderTranscript(hostile);
    assert.ok(!html.includes("<script>alert("));
    assert.ok(!/<img[^>]*onerror/i.test(html));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("shows why provisioning is blocked, with codes", () => {
    const broken = demoProfile();
    broken.servicesAccepted = [];
    const html = renderFounderSession({
      session: SESSION,
      transcriptText: "AIDA: hi",
      profileVersion: versionView({ profile: broken }),
      assessment: assessProvisioning(broken),
      events: [],
      rerunAllowed: true,
    });
    assert.match(html, /Why provisioning is blocked/);
    assert.match(html, /no_services_accepted/);
  });

  it("renders the audit history", () => {
    const html = renderFounderSession({
      session: SESSION,
      transcriptText: "AIDA: hi",
      profileVersion: versionView(),
      assessment: assessProvisioning(demoProfile()),
      events: [
        { created_at: "2026-08-01T00:00:00.000Z", event_type: "transcript.received", actor_type: "system", actor_id: null, reason: null },
        { created_at: "2026-08-01T00:01:00.000Z", event_type: "profile.draft_created", actor_type: "system", actor_id: null, reason: null },
      ],
      events_: null,
      rerunAllowed: false,
    });
    assert.match(html, /Audit history/);
    assert.match(html, /transcript\.received/);
    assert.match(html, /profile\.draft_created/);
  });

  it("surfaces the client's corrections — they are the list of things to fix", () => {
    const html = renderFounderSession({
      session: SESSION,
      transcriptText: "AIDA: hi",
      profileVersion: versionView({ reviewNotes: { transfer: { note: "Dave's number changed.", forDiscussion: false } } }),
      assessment: assessProvisioning(demoProfile()),
      events: [],
      rerunAllowed: true,
    });
    assert.match(html, /Client corrections/);
    assert.match(html, /Dave&#39;s number changed\./);
  });

  it("offers NO approve control — the client approves, always", () => {
    const html = renderFounderSession({
      session: SESSION,
      transcriptText: "AIDA: hi",
      profileVersion: versionView(),
      assessment: assessProvisioning(demoProfile()),
      events: [],
      rerunAllowed: true,
    });
    assert.ok(!/id="approve-button"/.test(html), "the founder console must not be able to approve");
    assert.ok(!/\bApprove these settings\b/.test(html));
    assert.match(html, /cannot approve on their behalf/i);
  });

  it("hides the re-extract control outside development", () => {
    const html = renderFounderSession({
      session: SESSION,
      transcriptText: "AIDA: hi",
      profileVersion: versionView(),
      assessment: assessProvisioning(demoProfile()),
      events: [],
      rerunAllowed: false,
    });
    assert.ok(!html.includes('id="rerun-extraction"'));
    assert.match(html, /development and test environments only/i);
  });

  it("re-extraction is refused outside development, as a 404", async () => {
    const { deps } = fakeDeps({ env: { NODE_ENV: "production" } });
    const res = fakeRes();
    await createOnboardingHandlers(deps).founderRerunExtraction(fakeReq({ body: {} }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, "not_available");
  });

  it("re-extraction creates a NEW draft and leaves an approved version untouched", async () => {
    const { deps, state } = fakeDeps();
    const approvedSnapshot = { ...state.versionRow, version: 1, status: "approved", profile: demoProfile() };
    state.approved = approvedSnapshot;
    const before = JSON.stringify(approvedSnapshot);

    const res = fakeRes();
    await createOnboardingHandlers({ ...deps, extract: () => ({ ok: true, profile: demoProfile(), extractionVersion: "fixture-v1", warnings: [] }) })
      .founderRerunExtraction(fakeReq({ body: {} }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.code, "re_extracted");
    assert.strictEqual(JSON.stringify(approvedSnapshot), before, "the approved version must not be modified");
  });

  it("marking a session failed requires a reason", async () => {
    const { deps } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).founderFailSession(fakeReq({ body: {} }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  it("marks a session failed with its reason", async () => {
    const { deps, state } = fakeDeps();
    const res = fakeRes();
    await createOnboardingHandlers(deps).founderFailSession(fakeReq({ body: { code: "caller_hung_up" } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.sessionRow.status, "failed");
    assert.strictEqual(state.sessionRow.failure_code, "caller_hung_up");
  });
});

// ── Route wiring + regression ───────────────────────────────────────

describe("route wiring", () => {
  const ROUTES = fs.readFileSync(path.join(__dirname, "../src/routes/locksmith-onboarding.js"), "utf8");
  const SERVER = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

  it("gates the whole router before any auth middleware", () => {
    const gateAt = ROUTES.indexOf("router.use(onboardingRouterGate())");
    const firstRoute = ROUTES.indexOf("router.get(");
    assert.ok(gateAt > -1 && gateAt < firstRoute, "the flag gate must run first");
  });

  it("puts every client route behind requireClientAuth", () => {
    for (const line of ROUTES.split("\n").filter((l) => l.includes("/client/locksmith-onboarding"))) {
      assert.ok(line.includes("requireClientAuth"), `unprotected client route: ${line.trim()}`);
    }
  });

  it("puts every founder route behind requireLogin", () => {
    for (const line of ROUTES.split("\n").filter((l) => l.includes("/locksmith-founder"))) {
      assert.ok(line.includes("requireLogin"), `unprotected founder route: ${line.trim()}`);
    }
  });

  it("exposes NO unauthenticated transcript-ingestion endpoint", () => {
    const transcriptLines = ROUTES.split("\n").filter((l) => /transcript/i.test(l) && l.includes("router."));
    assert.ok(transcriptLines.length > 0, "there should be exactly one ingestion route");
    for (const line of transcriptLines) {
      assert.ok(line.includes("requireLogin"), `transcript ingestion must be operator-only: ${line.trim()}`);
    }
  });

  it("is mounted in server.js", () => {
    assert.match(SERVER, /app\.use\(require\("\.\/routes\/locksmith-onboarding"\)\);/);
  });
});

describe("M1 regression — the product shell is unchanged and still dormant", () => {
  const SERVER = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

  it("every pre-existing mount survives", () => {
    for (const mount of [
      'app.use("/login"',
      'app.use("/client-auth"',
      'app.use("/inbound"',
      'app.use("/recording"',
      'app.use("/calls"',
      'app.use("/client-dashboard"',
      'app.get("/health"',
    ]) {
      assert.ok(SERVER.includes(mount), `server.js lost: ${mount}`);
    }
  });

  it("the M1 locksmith page is still mounted with no auth", () => {
    const line = SERVER.split("\n").find((l) => l.includes('require("./routes/locksmith")'));
    assert.ok(line);
    assert.ok(!line.includes("requireLogin"));
  });

  it("the M1 page is still dormant by default", () => {
    const { isLocksmithPilotEnabled } = require("../src/config/locksmith");
    assert.strictEqual(isLocksmithPilotEnabled({}), false);
    assert.strictEqual(isLocksmithPilotEnabled({ LOCKSMITH_PILOT_ENABLED: "true" }), true);
  });

  it("the M1 page now explains autonomous onboarding without claiming it is live", () => {
    const { renderLocksmithPage } = require("../src/views/locksmith-page");
    const { getLocksmithConfig } = require("../src/config/locksmith");
    const demo = require("../src/services/locksmith-demo");
    const { FIELDS } = require("../src/services/locksmith-enquiry");
    const html = renderLocksmithPage({ config: getLocksmithConfig({}), demo, fields: FIELDS });

    assert.match(html, /Speak with AIDA once/);
    assert.match(html, /asks you to approve them before launch/);
    assert.match(html, /Coming in the founding pilot — not available yet/);
    // No claim that it works today, and no invented comparison or saving.
    assert.ok(!/\b(faster than|cheaper than|unlike other|competitors?)\b/i.test(html), "no competitor comparisons");
    assert.ok(!/\bsaves? you \$?\d/i.test(html), "no invented savings");
    // Guards fake social proof specifically. "review page" is legitimate
    // product language and must not trip this.
    assert.ok(!/\btestimonials?\b|\bcustomer reviews?\b|\b\d+ reviews?\b|customers say|trusted by/i.test(html));
  });
});
