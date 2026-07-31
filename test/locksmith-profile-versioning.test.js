// LOCKSMITH M2 — profile versioning, the approval guard and audit events.
//
// Pure lifecycle core only (no DB): every rule that decides whether a profile
// may be approved is testable without a database, which is the point of
// splitting evaluateApproval() out of approveVersion().

const { describe, it } = require("node:test");
const assert = require("node:assert");

const store = require("../src/services/locksmith-profile-store");
const S = require("../src/services/locksmith-profile-schema");
require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

function validProfile() {
  const r = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
  assert.strictEqual(r.ok, true);
  return JSON.parse(JSON.stringify(r.profile));
}

function allConfirmed(actorId = "user-1") {
  const out = {};
  for (const key of S.CONFIRMATION_KEYS) out[key] = { confirmedAt: "2026-08-01T00:00:00.000Z", actorId, note: null };
  return out;
}

function draftRow(overrides = {}) {
  return {
    client_id: "demo-locksmith",
    version: 1,
    status: "needs_review",
    profile: validProfile(),
    confirmations: allConfirmed(),
    updated_at: "2026-08-01T10:00:00.000Z",
    session_id: "session-1",
    ...overrides,
  };
}

const ACTOR = { type: "client", clientId: "demo-locksmith", id: "user-1" };

describe("lifecycle", () => {
  it("declares the five required statuses", () => {
    assert.deepStrictEqual(store.PROFILE_STATUSES, ["draft", "needs_review", "approved", "superseded", "rejected"]);
  });

  it("allows only the intended transitions", () => {
    assert.ok(store.canTransition("draft", "needs_review"));
    assert.ok(store.canTransition("needs_review", "approved"));
    assert.ok(store.canTransition("needs_review", "rejected"));
    assert.ok(store.canTransition("approved", "superseded"));
  });

  it("refuses shortcuts and resurrections", () => {
    assert.ok(!store.canTransition("draft", "approved"), "a draft cannot skip review");
    assert.ok(!store.canTransition("approved", "draft"), "approved is not editable — corrections make a new version");
    assert.ok(!store.canTransition("superseded", "approved"), "a superseded version cannot be re-approved");
    assert.ok(!store.canTransition("rejected", "approved"));
    assert.ok(!store.canTransition("rejected", "needs_review"));
  });
});

describe("draft creation", () => {
  it("builds an insert payload that mirrors the queryable safety columns", () => {
    const fields = store.buildDraftFields({ clientId: "demo-locksmith", version: 1, profile: validProfile(), sessionId: "s1", extractionVersion: "fixture-v1" });
    assert.strictEqual(fields.client_id, "demo-locksmith");
    assert.strictEqual(fields.version, 1);
    assert.strictEqual(fields.status, "needs_review");
    assert.strictEqual(fields.extraction_version, "fixture-v1");
    assert.match(fields.transfer_primary_number, /^\+61\d{9}$/);
    assert.strictEqual(fields.provisioning_ready, true);
    assert.deepStrictEqual(fields.confirmations, {}, "a new draft starts with nothing confirmed");
    assert.strictEqual(fields.approved_at, null);
    assert.strictEqual(fields.approved_by, null);
  });

  it("emits only real columns — no internal scratch keys can reach an INSERT", () => {
    // Regression: buildDraftFields once returned a convenience `_assessment`
    // key that the adapter had to remember to delete. A payload that needs
    // manual cleaning before every write is a column-not-found error waiting
    // for the one call site that forgets.
    const fields = store.buildDraftFields({ clientId: "demo-locksmith", version: 1, profile: validProfile() });
    const internal = Object.keys(fields).filter((k) => k.startsWith("_"));
    assert.deepStrictEqual(internal, [], `payload carries internal keys: ${internal.join(", ")}`);
    for (const key of Object.keys(fields)) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `"${key}" is not a snake_case column name`);
    }
  });

  it("a new version may only start as draft or needs_review — never approved", () => {
    for (const status of ["approved", "superseded", "rejected"]) {
      assert.throws(
        () => store.buildDraftFields({ clientId: "c", version: 1, profile: validProfile(), status }),
        /may only start as draft or needs_review/,
        `${status} must be refused as a starting status`
      );
    }
  });

  it("refuses a bad version number", () => {
    for (const bad of [0, -1, 1.5, "1", null]) {
      assert.throws(() => store.buildDraftFields({ clientId: "c", version: bad, profile: validProfile() }), /positive integer version/);
    }
  });

  it("an incomplete profile still produces a draft — that is what review is for", () => {
    const fields = store.buildDraftFields({ clientId: "c", version: 2, profile: S.emptyProfile() });
    assert.strictEqual(fields.provisioning_ready, false);
    assert.ok(fields.blocking_reasons.length > 0, "the blockers travel with the row");
  });
});

describe("approval guard", () => {
  it("approves a complete, confirmed, unchanged draft", () => {
    const row = draftRow();
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict.blockers));
  });

  it("refuses when a required section is incomplete", () => {
    const row = draftRow();
    row.profile.transfer.primaryNumber = null;
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.blockers.some((b) => b.kind === "content" && b.code === "transfer_number_invalid"));
  });

  it("refuses when no service is accepted", () => {
    const row = draftRow();
    row.profile.servicesAccepted = [];
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.ok(verdict.blockers.some((b) => b.code === "no_services_accepted"));
  });

  it("refuses when there is no service-area action", () => {
    const row = draftRow();
    row.profile.serviceAreas.outsideAreaAction = null;
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.ok(verdict.blockers.some((b) => b.code === "no_outside_area_action"));
  });

  it("refuses when hours conflict", () => {
    const row = draftRow();
    row.profile.hours.ordinary.monday = { open: "17:00", close: "08:00" };
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.ok(verdict.blockers.some((b) => b.kind === "content" && /hours/i.test(b.message)));
  });

  it("refuses when pricing permission is ambiguous", () => {
    const row = draftRow();
    row.profile.pricing.humanConfirmsEveryPrice = null;
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.ok(verdict.blockers.some((b) => b.code === "pricing_authority_ambiguous"));
  });

  it("refuses when forbidden promises are missing", () => {
    const row = draftRow();
    row.profile.forbiddenPromises = [];
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    assert.ok(verdict.blockers.some((b) => b.code === "forbidden_promises_missing"));
  });

  it("refuses when any safety confirmation is missing, and names which", () => {
    for (const missing of ["transfer", "hours", "servicesDeclined", "pricing", "forbiddenPromises"]) {
      const row = draftRow();
      delete row.confirmations[missing];
      const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
      assert.strictEqual(verdict.ok, false, `${missing} must be individually confirmed`);
      const blocker = verdict.blockers.find((b) => b.code === "confirmations_missing");
      assert.ok(blocker && blocker.message.includes(missing), `the blocker should name "${missing}"`);
    }
  });

  it("refuses an unauthorised reviewer from another tenant", () => {
    const row = draftRow();
    const verdict = store.evaluateApproval({
      row,
      profile: row.profile,
      confirmations: row.confirmations,
      actor: { type: "client", clientId: "someone-else", id: "user-9" },
      expectedUpdatedAt: row.updated_at,
    });
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.blockers.some((b) => b.kind === "auth" && b.code === "not_authorised"));
  });

  it("refuses when there is no actor at all", () => {
    const row = draftRow();
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: null, expectedUpdatedAt: row.updated_at });
    assert.ok(verdict.blockers.some((b) => b.kind === "auth"));
  });

  it("refuses a stale review — the draft changed since the page was read", () => {
    const row = draftRow();
    const verdict = store.evaluateApproval({
      row,
      profile: row.profile,
      confirmations: row.confirmations,
      actor: ACTOR,
      expectedUpdatedAt: "2026-08-01T09:00:00.000Z", // older than the row
    });
    assert.strictEqual(verdict.ok, false);
    const stale = verdict.blockers.find((b) => b.code === "stale_review");
    assert.ok(stale);
    assert.strictEqual(stale.kind, "conflict");
    assert.match(stale.message, /changed while you were reviewing/i);
  });

  it("refuses to approve something that is already approved or rejected", () => {
    for (const status of ["approved", "superseded", "rejected"]) {
      const row = draftRow({ status });
      const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: row.confirmations, actor: ACTOR, expectedUpdatedAt: row.updated_at });
      assert.ok(verdict.blockers.some((b) => b.code === "bad_status"), `${status} must not be approvable`);
    }
  });

  it("refuses when the draft no longer exists", () => {
    const verdict = store.evaluateApproval({ row: null, profile: null, confirmations: {}, actor: ACTOR });
    assert.strictEqual(verdict.ok, false);
    assert.ok(verdict.blockers.some((b) => b.code === "not_found"));
  });

  it("reports every reason at once so a reviewer fixes them in one pass", () => {
    const row = draftRow({ confirmations: {} });
    row.profile.transfer.primaryNumber = null;
    row.profile.servicesAccepted = [];
    const verdict = store.evaluateApproval({ row, profile: row.profile, confirmations: {}, actor: ACTOR, expectedUpdatedAt: row.updated_at });
    const codes = verdict.blockers.map((b) => b.code);
    assert.ok(codes.includes("transfer_number_invalid"));
    assert.ok(codes.includes("no_services_accepted"));
    assert.ok(codes.includes("confirmations_missing"));
  });
});

describe("approval, supersede and rejection payloads", () => {
  it("approval records actor and timestamp", () => {
    const fields = store.buildApprovalFields({ actor: ACTOR, reason: "checked with Dave" }, "2026-08-01T12:00:00.000Z");
    assert.strictEqual(fields.status, "approved");
    assert.strictEqual(fields.approved_at, "2026-08-01T12:00:00.000Z");
    assert.strictEqual(fields.approved_by, "user-1");
    assert.strictEqual(fields.approval_reason, "checked with Dave");
  });

  it("superseding points at the version that replaced it", () => {
    const fields = store.buildSupersedeFields({ bySupersedingVersion: 4 }, "2026-08-01T12:00:00.000Z");
    assert.strictEqual(fields.status, "superseded");
    assert.strictEqual(fields.superseded_by_version, 4);
    assert.strictEqual(fields.superseded_at, "2026-08-01T12:00:00.000Z");
  });

  it("rejection requires a reason — 'no' without a why is not reviewable", () => {
    assert.throws(() => store.buildRejectionFields({ actor: ACTOR, reason: "" }), /requires a reason/);
    assert.throws(() => store.buildRejectionFields({ actor: ACTOR, reason: "   " }), /requires a reason/);
    const fields = store.buildRejectionFields({ actor: ACTOR, reason: "Transfer number is wrong" });
    assert.strictEqual(fields.status, "rejected");
    assert.strictEqual(fields.rejection_reason, "Transfer number is wrong");
  });

  it("long reasons are capped rather than rejected", () => {
    const fields = store.buildRejectionFields({ actor: ACTOR, reason: "x".repeat(5000) });
    assert.strictEqual(fields.rejection_reason.length, 1000);
  });
});

describe("confirmations", () => {
  it("records the section, actor and time", () => {
    const next = store.applyConfirmation({}, { section: "transfer", actorId: "user-1" }, "2026-08-01T11:00:00.000Z");
    assert.deepStrictEqual(next.transfer, { confirmedAt: "2026-08-01T11:00:00.000Z", actorId: "user-1", note: null });
  });

  it("refuses an unknown section", () => {
    assert.throws(() => store.applyConfirmation({}, { section: "vibes", actorId: "u" }), /not a confirmable section/);
  });

  it("a correction clears that section's confirmation", () => {
    const confirmed = store.applyConfirmation({}, { section: "transfer", actorId: "user-1" });
    const cleared = store.clearConfirmation(confirmed, "transfer");
    assert.strictEqual(cleared.transfer, undefined);
  });

  it("clearing one section leaves the others alone", () => {
    let state = store.applyConfirmation({}, { section: "transfer", actorId: "u" });
    state = store.applyConfirmation(state, { section: "hours", actorId: "u" });
    const cleared = store.clearConfirmation(state, "transfer");
    assert.ok(cleared.hours);
    assert.strictEqual(cleared.transfer, undefined);
  });

  it("does not mutate the object it is given", () => {
    const original = {};
    store.applyConfirmation(original, { section: "pricing", actorId: "u" });
    assert.deepStrictEqual(original, {}, "confirmation merge must be pure");
  });
});

describe("audit events", () => {
  it("records actor, timestamp, reason and source", () => {
    const event = store.buildAuditEvent(
      { clientId: "demo-locksmith", sessionId: "s1", profileVersion: 2, eventType: "profile.approved", actorType: "client", actorId: "user-1", reason: "looks right", source: "review_ui" },
      "2026-08-01T12:00:00.000Z"
    );
    assert.strictEqual(event.client_id, "demo-locksmith");
    assert.strictEqual(event.event_type, "profile.approved");
    assert.strictEqual(event.actor_type, "client");
    assert.strictEqual(event.actor_id, "user-1");
    assert.strictEqual(event.reason, "looks right");
    assert.strictEqual(event.source, "review_ui");
    assert.strictEqual(event.created_at, "2026-08-01T12:00:00.000Z");
  });

  it("requires the fields that make an event auditable", () => {
    assert.throws(() => store.buildAuditEvent({ eventType: "x", actorType: "client" }), /requires clientId/);
    assert.throws(() => store.buildAuditEvent({ clientId: "c", actorType: "client" }), /requires eventType/);
    assert.throws(() => store.buildAuditEvent({ clientId: "c", eventType: "x", actorType: "wizard" }), /actorType must be one of/);
  });

  it("accepts only the three real actor types", () => {
    for (const type of ["client", "operator", "system"]) {
      assert.doesNotThrow(() => store.buildAuditEvent({ clientId: "c", eventType: "e", actorType: type }));
    }
  });

  it("caps free text so a hostile reason cannot bloat the audit table", () => {
    const event = store.buildAuditEvent({ clientId: "c", eventType: "e", actorType: "system", reason: "x".repeat(5000), actorId: "y".repeat(5000) });
    assert.strictEqual(event.reason.length, 1000);
    assert.strictEqual(event.actor_id.length, 200);
  });

  it("detail carries structured context, never raw content", () => {
    const event = store.buildAuditEvent({ clientId: "c", eventType: "transcript.received", actorType: "system", detail: { bytes: 1234, sha256: "abc" } });
    assert.deepStrictEqual(event.detail, { bytes: 1234, sha256: "abc" });
    // A non-object detail is dropped rather than stringified into the row.
    const junk = store.buildAuditEvent({ clientId: "c", eventType: "e", actorType: "system", detail: "the whole transcript" });
    assert.strictEqual(junk.detail, null);
  });
});

describe("public shape", () => {
  it("exposes review state without leaking the internal row id", () => {
    const view = store.toPublicProfileVersion({
      id: "internal-uuid",
      client_id: "demo-locksmith",
      version: 3,
      status: "needs_review",
      profile: validProfile(),
      confirmations: {},
      review_notes: {},
      provisioning_ready: true,
      blocking_reasons: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T10:00:00.000Z",
    });
    assert.strictEqual(view.version, 3);
    assert.strictEqual(view.provisioningReady, true);
    assert.ok(!("id" in view), "the internal row id must not be exposed");
    assert.strictEqual(view.updatedAt, "2026-08-01T10:00:00.000Z", "updatedAt is the stale-review token");
  });

  it("returns null for a missing row rather than throwing", () => {
    assert.strictEqual(store.toPublicProfileVersion(null), null);
  });
});
