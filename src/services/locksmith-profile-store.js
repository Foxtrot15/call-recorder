// AIDA Locksmith Receptionist — profile versioning, approval and audit (M2).
//
// Pure lifecycle core up top (unit-testable, no deps); thin DB adapter below
// with a lazy supabase require — the routing-profile.js / devices.js house
// structure. Table: supabase/sql/lpm2_create_locksmith_onboarding.sql
// (REVIEW ONLY, not applied).
//
// The rules this module exists to enforce:
//   1. A draft NEVER overwrites an approved profile. Extraction always writes a
//      new draft row; approved rows are immutable after approval.
//   2. Approval is explicit, actor-attributed, and requires the reviewer to
//      have individually confirmed every safety-critical section.
//   3. Approving version N supersedes the previously approved version, so at
//      most one row per client is `approved` — enforced in the app AND by a
//      partial unique index in the DB, because "at most one" is exactly the
//      kind of invariant that survives code refactors only if the database
//      also believes it.
//   4. Superseded and rejected versions are retained, never deleted: they are
//      the audit trail and the rollback path.
//   5. Every status change records actor, timestamp, reason and source.
//
// Optimistic concurrency: approval carries the draft's `updated_at` as
// `expectedUpdatedAt`. If the row moved since the review page rendered, the
// update matches zero rows and the caller gets a stale-review conflict rather
// than approving text the reviewer never saw.

const { validateProfile, assessProvisioning, toQueryableColumns } = require("./locksmith-profile");
const { CONFIRMATION_KEYS } = require("./locksmith-profile-schema");

// ── Lifecycle ───────────────────────────────────────────────────────

const PROFILE_STATUSES = Object.freeze(["draft", "needs_review", "approved", "superseded", "rejected"]);

// from -> allowed next. Approved is terminal except for being superseded by a
// later approval; rejected and superseded are terminal full stop (corrections
// create a NEW version rather than reopening an old one).
const PROFILE_TRANSITIONS = Object.freeze({
  draft: ["needs_review", "rejected"],
  needs_review: ["approved", "rejected", "draft"],
  approved: ["superseded"],
  superseded: [],
  rejected: [],
});

const ACTOR_TYPES = Object.freeze(["client", "operator", "system"]);

function canTransition(from, to) {
  return Boolean(PROFILE_TRANSITIONS[from]) && PROFILE_TRANSITIONS[from].includes(to);
}

/**
 * Build an immutable audit event. Every status change and every ingestion step
 * produces one. Deliberately free of transcript text, phone numbers and profile
 * bodies — the audit trail says WHAT happened and WHO did it, and the row it
 * points at holds the data (spec §13: don't duplicate sensitive content into
 * logs and audit rows).
 */
function buildAuditEvent({
  clientId,
  sessionId = null,
  profileVersion = null,
  eventType,
  actorType,
  actorId = null,
  reason = null,
  source = null,
  detail = null,
}, nowIso = new Date().toISOString()) {
  if (!clientId) throw new Error("audit event requires clientId");
  if (!eventType) throw new Error("audit event requires eventType");
  if (!ACTOR_TYPES.includes(actorType)) throw new Error(`audit event actorType must be one of ${ACTOR_TYPES.join(", ")}`);

  return {
    client_id: clientId,
    session_id: sessionId,
    profile_version: profileVersion,
    event_type: eventType,
    actor_type: actorType,
    actor_id: actorId ? String(actorId).slice(0, 200) : null,
    reason: reason ? String(reason).slice(0, 1000) : null,
    source: source ? String(source).slice(0, 100) : null,
    detail: detail && typeof detail === "object" ? detail : null,
    created_at: nowIso,
  };
}

// ── Draft creation ──────────────────────────────────────────────────

/**
 * Fields for a new draft version. `version` is supplied by the adapter, which
 * reads the client's current maximum — never guessed here.
 *
 * A draft is written even when the profile is incomplete: an incomplete draft
 * is the whole point of the review step. What is NOT allowed is writing it over
 * an approved row, which is why this always produces an insert payload.
 */
function buildDraftFields({ clientId, version, profile, sessionId = null, extractionVersion = null, status = "needs_review" }, nowIso = new Date().toISOString()) {
  if (!clientId) throw new Error("draft requires clientId");
  if (!Number.isInteger(version) || version < 1) throw new Error("draft requires a positive integer version");
  if (!["draft", "needs_review"].includes(status)) throw new Error(`a new version may only start as draft or needs_review, got "${status}"`);

  return {
    client_id: clientId,
    version,
    status,
    schema_version: profile && profile.schemaVersion ? profile.schemaVersion : null,
    session_id: sessionId,
    extraction_version: extractionVersion,
    profile, // validated jsonb body; the queryable mirror follows
    ...toQueryableColumns(profile),
    confirmations: {}, // section key -> { confirmedAt, actorId }
    review_notes: {},
    approved_at: null,
    approved_by: null,
    approval_reason: null,
    superseded_at: null,
    superseded_by_version: null,
    rejected_at: null,
    rejection_reason: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

// ── Approval guard ──────────────────────────────────────────────────

/**
 * The complete pre-approval check. Returns { ok, blockers[] } — every reason
 * approval would be refused, all at once, so a reviewer fixes them in one pass
 * instead of discovering them one at a time.
 *
 * Ordering matters for the caller's HTTP status, so each blocker carries a
 * `kind`: "auth" (403), "conflict" (409), "state" (409) or "content" (422).
 */
function evaluateApproval({ row, profile, confirmations, actor, expectedUpdatedAt }) {
  const blockers = [];
  const add = (kind, code, message) => blockers.push({ kind, code, message });

  if (!row) {
    add("state", "not_found", "This draft no longer exists.");
    return { ok: false, blockers };
  }

  // Authorisation: the reviewer must belong to the tenant that owns the draft.
  if (!actor || !actor.clientId || actor.clientId !== row.client_id) {
    add("auth", "not_authorised", "You are not authorised to approve this profile.");
  }
  if (actor && !ACTOR_TYPES.includes(actor.type)) {
    add("auth", "bad_actor", "Unknown reviewer type.");
  }

  // Stale review: the draft changed since the page the reviewer read.
  if (expectedUpdatedAt && row.updated_at && expectedUpdatedAt !== row.updated_at) {
    add("conflict", "stale_review", "This draft changed while you were reviewing it. Reload and check the changes before approving.");
  }

  // Lifecycle: only a draft under review can be approved.
  if (!canTransition(row.status, "approved")) {
    add("state", "bad_status", `A profile with status "${row.status}" cannot be approved.`);
  }

  // Content: everything that makes the profile unsafe to build from.
  const validation = validateProfile(profile);
  if (!validation.ok) {
    for (const err of validation.errors) add("content", `invalid_${err.section}`, `${err.section}: ${err.message}`);
  }
  const assessment = assessProvisioning(profile);
  for (const blocker of assessment.blockers) add("content", blocker.code, blocker.message);

  // Explicit per-section confirmation — the reviewer has to have actually
  // looked at transfer numbers, hours, exclusions, pricing authority and the
  // forbidden promises (Part 4.8).
  const confirmed = confirmations && typeof confirmations === "object" ? confirmations : {};
  const missing = CONFIRMATION_KEYS.filter((key) => !confirmed[key] || !confirmed[key].confirmedAt);
  if (missing.length) {
    add("content", "confirmations_missing", `Confirm every section before approving. Outstanding: ${missing.join(", ")}.`);
  }

  return { ok: blockers.length === 0, blockers, assessment };
}

/** Column payload for a successful approval. */
function buildApprovalFields({ actor, reason = null }, nowIso = new Date().toISOString()) {
  return {
    status: "approved",
    approved_at: nowIso,
    approved_by: actor && actor.id ? String(actor.id).slice(0, 200) : null,
    approval_reason: reason ? String(reason).slice(0, 1000) : null,
    updated_at: nowIso,
  };
}

/** Column payload for superseding a previously approved version. */
function buildSupersedeFields({ bySupersedingVersion }, nowIso = new Date().toISOString()) {
  return {
    status: "superseded",
    superseded_at: nowIso,
    superseded_by_version: bySupersedingVersion,
    updated_at: nowIso,
  };
}

/** Column payload for a rejection. A reason is mandatory — "no" without a why is not reviewable. */
function buildRejectionFields({ actor, reason }, nowIso = new Date().toISOString()) {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (!trimmed) throw new Error("rejection requires a reason");
  return {
    status: "rejected",
    rejected_at: nowIso,
    rejection_reason: trimmed.slice(0, 1000),
    approved_by: null,
    updated_at: nowIso,
    _actorId: actor && actor.id ? String(actor.id) : null,
  };
}

/** Record one section confirmation onto the confirmations map (pure merge). */
function applyConfirmation(existing, { section, actorId, note = null }, nowIso = new Date().toISOString()) {
  if (!CONFIRMATION_KEYS.includes(section)) throw new Error(`"${section}" is not a confirmable section`);
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  next[section] = { confirmedAt: nowIso, actorId: actorId ? String(actorId).slice(0, 200) : null, note: note ? String(note).slice(0, 500) : null };
  return next;
}

/** Remove a confirmation — any correction to a section invalidates its tick. */
function clearConfirmation(existing, section) {
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  delete next[section];
  return next;
}

/** Shape a row for API/UI use. No internal ids leak; the profile body is passed through for rendering. */
function toPublicProfileVersion(row) {
  if (!row) return null;
  return {
    clientId: row.client_id,
    version: row.version,
    status: row.status,
    schemaVersion: row.schema_version,
    sessionId: row.session_id || null,
    extractionVersion: row.extraction_version || null,
    profile: row.profile || null,
    confirmations: row.confirmations || {},
    reviewNotes: row.review_notes || {},
    provisioningReady: row.provisioning_ready === true,
    blockingReasons: Array.isArray(row.blocking_reasons) ? row.blocking_reasons : [],
    approvedAt: row.approved_at || null,
    approvedBy: row.approved_by || null,
    supersededAt: row.superseded_at || null,
    supersededByVersion: row.superseded_by_version || null,
    rejectedAt: row.rejected_at || null,
    rejectionReason: row.rejection_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── DB adapter ──────────────────────────────────────────────────────
// Every query filters on client_id. There is no function that takes only a row
// id, so cross-tenant access by id cannot be expressed (the routing-profile.js
// tenancy rule).

const TABLE = "locksmith_business_profiles";
const EVENTS_TABLE = "locksmith_onboarding_events";

function tableMissing(error) {
  return Boolean(
    error && (error.code === "42P01" || /locksmith_(business_profiles|onboarding_\w+).*does not exist|relation .*locksmith_/i.test(error.message || ""))
  );
}

function provisioningError() {
  return new Error(
    "locksmith onboarding tables not provisioned — apply supabase/sql/lpm2_create_locksmith_onboarding.sql first"
  );
}

async function recordAuditEvent(event) {
  const supabase = require("./supabase");
  const { error } = await supabase.from(EVENTS_TABLE).insert(event);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`audit event insert failed: ${error.message}`);
  }
  return true;
}

async function listAuditEvents(clientId, { sessionId = null, limit = 200 } = {}) {
  const supabase = require("./supabase");
  let query = supabase.from(EVENTS_TABLE).select("*").eq("client_id", clientId);
  if (sessionId) query = query.eq("session_id", sessionId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(Math.min(limit, 500));
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`audit event lookup failed: ${error.message}`);
  }
  return data || [];
}

/** The client's current approved version, or null. */
async function getApprovedVersion(clientId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("status", "approved").maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`approved profile lookup failed: ${error.message}`);
  }
  return data || null;
}

async function getVersion(clientId, version) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("version", version).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`profile version lookup failed: ${error.message}`);
  }
  return data || null;
}

async function listVersions(clientId, { limit = 50 } = {}) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).order("version", { ascending: false }).limit(limit);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`profile version list failed: ${error.message}`);
  }
  return data || [];
}

async function nextVersionNumber(clientId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("version").eq("client_id", clientId).order("version", { ascending: false }).limit(1);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`version probe failed: ${error.message}`);
  }
  return data && data.length ? data[0].version + 1 : 1;
}

/**
 * Insert a new draft version. Always an INSERT — an approved row is never
 * updated in place, so extraction cannot clobber a live configuration. The
 * unique (client_id, version) constraint turns a concurrent double-create into
 * a clean error rather than two rival drafts.
 */
async function createDraftVersion({ clientId, profile, sessionId = null, extractionVersion = null, status = "needs_review", actor = { type: "system", id: null }, reason = null, source = null }) {
  const supabase = require("./supabase");
  const version = await nextVersionNumber(clientId);
  const fields = buildDraftFields({ clientId, version, profile, sessionId, extractionVersion, status });

  const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`draft creation failed: ${error.message}`);
  }
  await recordAuditEvent(
    buildAuditEvent({
      clientId,
      sessionId,
      profileVersion: version,
      eventType: "profile.draft_created",
      actorType: actor.type,
      actorId: actor.id,
      reason,
      source,
      detail: { status, extractionVersion, provisioningReady: fields.provisioning_ready },
    })
  );
  return data;
}

/**
 * Persist review progress (section confirmations and correction notes) with
 * optimistic concurrency. Only ever touches a draft: the `.in("status", ...)`
 * filter means an approved, superseded or rejected row cannot be edited even if
 * a caller asks, so review state can never mutate a live configuration.
 *
 * Returns { ok:true, row } or { ok:false, code, message } — a zero-row update
 * is a stale review, not a silent success.
 */
async function updateReviewState({ clientId, version, confirmations, reviewNotes = null, expectedUpdatedAt = null }) {
  const supabase = require("./supabase");
  const nowIso = new Date().toISOString();
  const fields = { confirmations: confirmations || {}, updated_at: nowIso };
  if (reviewNotes) fields.review_notes = reviewNotes;

  let update = supabase
    .from(TABLE)
    .update(fields)
    .eq("client_id", clientId)
    .eq("version", version)
    .in("status", ["draft", "needs_review"]);
  if (expectedUpdatedAt) update = update.eq("updated_at", expectedUpdatedAt);

  const { data, error } = await update.select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`review state update failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    return { ok: false, code: "stale_review", message: "This draft changed while you were reviewing it. Reload and try again." };
  }
  return { ok: true, row: data[0] };
}

/**
 * The client's open WORKING DRAFT — a `status:"draft"` row, which is the
 * partially-filled setup form (M8A). Distinct from `needs_review`, which is a
 * finished draft waiting to be read.
 *
 * Highest version wins rather than `maybeSingle()`: "one working draft per
 * client" is an app invariant that the shipped SQL does not yet index, so a
 * duplicate must degrade to "carry on with the newest" rather than throw and
 * lock the owner out of their own setup.
 */
async function getWorkingDraft(clientId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "draft")
    .order("version", { ascending: false })
    .limit(1);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`working draft lookup failed: ${error.message}`);
  }
  return data && data.length ? data[0] : null;
}

/**
 * Write the profile BODY of a working draft.
 *
 * The `.eq("status", "draft")` filter is the safety property of this whole
 * milestone: `needs_review`, `approved`, `superseded` and `rejected` rows are
 * unreachable from here, so no amount of setup-form traffic can alter a
 * configuration that is live or under review. A zero-row update is reported as
 * a conflict, never as a silent success.
 */
async function updateDraftProfile({ clientId, version, profile, expectedUpdatedAt = null }) {
  const supabase = require("./supabase");
  const nowIso = new Date().toISOString();
  const fields = {
    profile,
    schema_version: profile && profile.schemaVersion ? profile.schemaVersion : null,
    ...toQueryableColumns(profile),
    updated_at: nowIso,
  };

  let update = supabase.from(TABLE).update(fields).eq("client_id", clientId).eq("version", version).eq("status", "draft");
  if (expectedUpdatedAt) update = update.eq("updated_at", expectedUpdatedAt);

  const { data, error } = await update.select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`draft profile update failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    return { ok: false, code: "stale_draft", message: "Your setup changed in another window. Reload to see the latest answers." };
  }
  return { ok: true, row: data[0] };
}

/**
 * Hand a finished working draft over for review: `draft` → `needs_review`.
 *
 * This is the moment the owner stops editing and starts reading. It changes no
 * profile content — only who may touch it, and through which surface.
 */
async function submitDraftForReview({ clientId, version, actor, expectedUpdatedAt = null, source = "setup_ui" }) {
  const row = await getVersion(clientId, version);
  if (!row) return { ok: false, code: "not_found", message: "That setup no longer exists." };
  if (!actor || actor.clientId !== row.client_id) {
    return { ok: false, code: "not_authorised", message: "You are not authorised to submit this setup." };
  }
  if (!canTransition(row.status, "needs_review")) {
    return { ok: false, code: "bad_status", message: `Setup with status "${row.status}" cannot be submitted for review.` };
  }

  const supabase = require("./supabase");
  const nowIso = new Date().toISOString();
  let update = supabase
    .from(TABLE)
    .update({ status: "needs_review", updated_at: nowIso })
    .eq("client_id", clientId)
    .eq("version", version)
    .eq("status", "draft");
  if (expectedUpdatedAt) update = update.eq("updated_at", expectedUpdatedAt);

  const { data, error } = await update.select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`submit for review failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    return { ok: false, code: "stale_draft", message: "Your setup changed in another window. Reload before submitting." };
  }

  await recordAuditEvent(
    buildAuditEvent({
      clientId,
      sessionId: row.session_id,
      profileVersion: version,
      eventType: "profile.submitted_for_review",
      actorType: actor.type,
      actorId: actor.id,
      source,
    })
  );
  return { ok: true, row: data[0] };
}

/**
 * Approve a version. Guard first, then an optimistic update matched on
 * (client_id, version, status, updated_at) so a racing approval or a background
 * correction cannot be approved from under the reviewer. Supersedes the
 * previous approved version only after this one commits.
 */
async function approveVersion({ clientId, version, actor, reason = null, expectedUpdatedAt = null, source = "review_ui" }) {
  const row = await getVersion(clientId, version);
  const verdict = evaluateApproval({
    row,
    profile: row ? row.profile : null,
    confirmations: row ? row.confirmations : {},
    actor,
    expectedUpdatedAt,
  });
  if (!verdict.ok) return { ok: false, blockers: verdict.blockers };

  const supabase = require("./supabase");
  const nowIso = new Date().toISOString();
  let update = supabase.from(TABLE).update(buildApprovalFields({ actor, reason }, nowIso)).eq("client_id", clientId).eq("version", version).eq("status", row.status);
  if (expectedUpdatedAt) update = update.eq("updated_at", expectedUpdatedAt);

  const { data, error } = await update.select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`approval failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    return { ok: false, blockers: [{ kind: "conflict", code: "stale_review", message: "This draft changed while you were reviewing it. Reload and try again." }] };
  }

  // Supersede the previously approved version, if any. Ordering is deliberate:
  // the new approval commits first, so a failure here leaves two approved rows
  // detectable by the partial unique index rather than zero approved rows.
  const previous = await supabase.from(TABLE).select("version").eq("client_id", clientId).eq("status", "approved").neq("version", version);
  if (!previous.error && previous.data) {
    for (const old of previous.data) {
      await supabase.from(TABLE).update(buildSupersedeFields({ bySupersedingVersion: version }, nowIso)).eq("client_id", clientId).eq("version", old.version).eq("status", "approved");
      await recordAuditEvent(
        buildAuditEvent({ clientId, profileVersion: old.version, eventType: "profile.superseded", actorType: actor.type, actorId: actor.id, reason: `superseded by version ${version}`, source })
      );
    }
  }

  await recordAuditEvent(
    buildAuditEvent({ clientId, sessionId: row.session_id, profileVersion: version, eventType: "profile.approved", actorType: actor.type, actorId: actor.id, reason, source, detail: { provisioningReady: data[0].provisioning_ready } })
  );
  return { ok: true, row: data[0] };
}

/** Reject a version. Retained, never deleted — a rejection is evidence. */
async function rejectVersion({ clientId, version, actor, reason, source = "review_ui" }) {
  const row = await getVersion(clientId, version);
  if (!row) return { ok: false, blockers: [{ kind: "state", code: "not_found", message: "This draft no longer exists." }] };
  if (!actor || actor.clientId !== row.client_id) {
    return { ok: false, blockers: [{ kind: "auth", code: "not_authorised", message: "You are not authorised to reject this profile." }] };
  }
  if (!canTransition(row.status, "rejected")) {
    return { ok: false, blockers: [{ kind: "state", code: "bad_status", message: `A profile with status "${row.status}" cannot be rejected.` }] };
  }

  const fields = buildRejectionFields({ actor, reason });
  delete fields._actorId;
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).update(fields).eq("client_id", clientId).eq("version", version).eq("status", row.status).select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`rejection failed: ${error.message}`);
  }
  if (!data || data.length === 0) {
    return { ok: false, blockers: [{ kind: "conflict", code: "stale_review", message: "This draft changed while you were reviewing it." }] };
  }
  await recordAuditEvent(buildAuditEvent({ clientId, sessionId: row.session_id, profileVersion: version, eventType: "profile.rejected", actorType: actor.type, actorId: actor.id, reason, source }));
  return { ok: true, row: data[0] };
}

module.exports = {
  PROFILE_STATUSES,
  PROFILE_TRANSITIONS,
  ACTOR_TYPES,
  canTransition,
  buildAuditEvent,
  buildDraftFields,
  evaluateApproval,
  buildApprovalFields,
  buildSupersedeFields,
  buildRejectionFields,
  applyConfirmation,
  clearConfirmation,
  toPublicProfileVersion,
  tableMissing,
  provisioningError,
  // adapter
  recordAuditEvent,
  listAuditEvents,
  getApprovedVersion,
  getVersion,
  listVersions,
  nextVersionNumber,
  createDraftVersion,
  getWorkingDraft,
  updateDraftProfile,
  submitDraftForReview,
  updateReviewState,
  approveVersion,
  rejectVersion,
};
