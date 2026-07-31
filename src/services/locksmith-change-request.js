// AIDA — configuration-change requests (M5).
//
// ─────────────────────────────────────────────────────────────────────
// CHANNEL-NEUTRAL BY ARCHITECTURAL RULE
// ─────────────────────────────────────────────────────────────────────
// AIDA is intended to become a voice-operated business system. A locksmith
// will eventually ring a dedicated configuration number and say "stop taking
// safe jobs" or "my after-hours number changed". That request must land in
// EXACTLY the same domain service, validation, versioning and approval
// workflow as the same request typed into the portal.
//
// So nothing in this module assumes an HTML form. A request carries a
// `sourceChannel` and, where the channel is voice, a `voiceSessionId` and
// transcript reference. The lifecycle, the safety confirmations and the
// approval gate are identical whichever channel it came from.
//
// The rules that make voice safe are the same ones that make the form safe:
//   * A change NEVER mutates an approved profile. Accepted changes produce a
//     new DRAFT version; the approved profile stays live until the client
//     approves the new one.
//   * Raw transcripts never become configuration. A voice request produces a
//     structured, validated change request with the transcript as EVIDENCE.
//   * Safety-critical fields require explicit confirmation, and phone numbers
//     require a read-back, whichever channel asked.
//   * Hours and transfer changes invalidate the receptionist tests.
//   * Every transition is audited with the channel recorded.
//
// Voice is therefore never a second configuration store. It is another way of
// filing the same request.
//
// Pure core + thin adapter, house style.

const crypto = require("crypto");
const S = require("./locksmith-profile-schema");
const { normaliseAuNumber, validateProfile, assessProvisioning } = require("./locksmith-profile");

const TABLE = "locksmith_change_requests";

// ── Channels ────────────────────────────────────────────────────────
// Reserved now so the domain cannot become UI-only later.
const SOURCE_CHANNELS = Object.freeze([
  "client_ui",
  "voice_configuration_agent",
  "initial_voice_onboarding",
  "founder_operator",
  "api",
  "system_generated",
]);

// Channels that carry a spoken request and therefore need a voice session and
// read-back evidence before a safety-critical field can move.
const VOICE_CHANNELS = Object.freeze(["voice_configuration_agent", "initial_voice_onboarding"]);

const STATUSES = Object.freeze([
  "draft",
  "submitted",
  "needs_clarification",
  "accepted",
  "applied_to_draft",
  "awaiting_client_approval",
  "approved",
  "rejected",
  "cancelled",
  "superseded",
]);

const TRANSITIONS = Object.freeze({
  draft: ["submitted", "cancelled"],
  submitted: ["needs_clarification", "accepted", "rejected", "cancelled"],
  needs_clarification: ["submitted", "cancelled", "rejected"],
  accepted: ["applied_to_draft", "rejected", "cancelled"],
  applied_to_draft: ["awaiting_client_approval", "cancelled", "superseded"],
  awaiting_client_approval: ["approved", "rejected", "cancelled", "superseded"],
  approved: ["superseded"],
  rejected: [],
  cancelled: [],
  superseded: [],
});

// ── Change targets ──────────────────────────────────────────────────
// `safetyCritical` fields need an explicit confirmation before they can be
// applied. `readBack` fields additionally need the value repeated back and
// confirmed — the two phone numbers, because a mis-heard digit routes an
// emergency to a stranger. `invalidatesTests` fields force fresh receptionist
// tests because they change what a correct call looks like.
const CHANGE_TARGETS = Object.freeze({
  greeting: { section: "identity", safetyCritical: false, readBack: false, invalidatesTests: false, label: "Greeting" },
  tone: { section: "identity", safetyCritical: false, readBack: false, invalidatesTests: false, label: "Tone" },
  servicesAccepted: { section: "servicesAccepted", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Services accepted" },
  servicesDeclined: { section: "servicesDeclined", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Services declined" },
  serviceAreas: { section: "serviceAreas", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Service areas" },
  hours: { section: "hours", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Business hours" },
  afterHours: { section: "hours", safetyCritical: true, readBack: false, invalidatesTests: true, label: "After-hours rules" },
  urgencyRules: { section: "urgencyRules", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Urgent-call rules" },
  transferPrimary: { section: "transfer", safetyCritical: true, readBack: true, invalidatesTests: true, label: "Primary transfer number" },
  transferBackup: { section: "transfer", safetyCritical: true, readBack: true, invalidatesTests: true, label: "Backup transfer number" },
  transferFallback: { section: "transfer", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Transfer fallback" },
  notifications: { section: "notifications", safetyCritical: false, readBack: false, invalidatesTests: false, label: "Notification recipients" },
  pricing: { section: "pricing", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Pricing wording and authority" },
  callerInfo: { section: "callerInfo", safetyCritical: false, readBack: false, invalidatesTests: true, label: "Required caller details" },
  forbiddenPromises: { section: "forbiddenPromises", safetyCritical: true, readBack: false, invalidatesTests: true, label: "Forbidden promises" },
  privacy: { section: "privacy", safetyCritical: true, readBack: false, invalidatesTests: false, label: "Privacy and recording" },
});

const CHANGE_TARGET_KEYS = Object.freeze(Object.keys(CHANGE_TARGETS));

const REFUSAL_CODES = Object.freeze({
  unknownTarget: "unknown_change_target",
  unknownChannel: "unknown_source_channel",
  badTransition: "illegal_transition",
  notAuthorised: "not_authorised",
  stale: "stale_request",
  confirmationMissing: "confirmation_required",
  readBackMissing: "read_back_required",
  invalidValue: "invalid_value",
  approvedUntouchable: "approved_profile_is_immutable",
  voiceSessionMissing: "voice_session_required",
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function isVoiceChannel(channel) {
  return VOICE_CHANNELS.includes(channel);
}

/** Which confirmations a set of requested changes demands before it can apply. */
function requiredConfirmations(changes) {
  const out = [];
  for (const change of changes || []) {
    const target = CHANGE_TARGETS[change.target];
    if (!target) continue;
    if (target.safetyCritical) out.push({ target: change.target, kind: "safety_critical", label: target.label });
    if (target.readBack) out.push({ target: change.target, kind: "read_back", label: target.label });
  }
  return out;
}

/** Does this change set invalidate the receptionist test plan? */
function invalidatesTests(changes) {
  return (changes || []).some((c) => CHANGE_TARGETS[c.target] && CHANGE_TARGETS[c.target].invalidatesTests);
}

/**
 * Validate one requested change. Pure. Phone numbers are normalised here so a
 * spoken "oh four nine one..." and a typed "0491 570 006" converge on the same
 * stored value before anything else looks at them.
 */
function validateChange(change) {
  if (!change || typeof change !== "object") return { ok: false, code: REFUSAL_CODES.invalidValue, message: "Each change must be an object." };
  const target = CHANGE_TARGETS[change.target];
  if (!target) return { ok: false, code: REFUSAL_CODES.unknownTarget, message: `"${String(change.target).slice(0, 40)}" is not something that can be changed.` };

  const out = { target: change.target, section: target.section };

  if (change.target === "transferPrimary" || change.target === "transferBackup") {
    const normalised = normaliseAuNumber(change.value);
    if (!normalised) {
      return { ok: false, code: REFUSAL_CODES.invalidValue, message: "That is not a number we could transfer a call to. Australian mobile or landline only." };
    }
    out.value = normalised;
    // The exact string the client must hear/see repeated back.
    out.readBackText = normalised.replace(/^\+61/, "0").split("").join(" ");
    return { ok: true, change: out };
  }

  if (change.target === "tone") {
    if (!S.TONES.includes(change.value)) return { ok: false, code: REFUSAL_CODES.invalidValue, message: "That is not a tone AIDA supports." };
    out.value = change.value;
    return { ok: true, change: out };
  }

  if (change.target === "servicesAccepted" || change.target === "servicesDeclined") {
    const list = Array.isArray(change.value) ? change.value : [];
    const unknown = list.filter((id) => !S.SERVICE_IDS.includes(id));
    if (unknown.length) return { ok: false, code: REFUSAL_CODES.invalidValue, message: `Unrecognised service: ${unknown.slice(0, 3).join(", ")}.` };
    out.value = list;
    return { ok: true, change: out };
  }

  if (change.target === "forbiddenPromises") {
    // The mandatory floor cannot be removed through a change request, from any
    // channel. Adding extra restrictions is always allowed.
    //
    // The check is on the RESULTING LIST, not on a caller-supplied `removing`
    // hint. Trusting `removing` left an open door: submitting the complete new
    // list with a mandatory entry simply absent removed it while declaring
    // nothing, and these are the promises that stop AIDA guaranteeing an
    // arrival time or a price it cannot honour.
    const list = Array.isArray(change.value) ? change.value : null;
    if (!list) {
      return { ok: false, code: REFUSAL_CODES.invalidValue, message: "The forbidden-promise list must be a list." };
    }

    const unknown = list.filter((id) => !S.FORBIDDEN_PROMISE_IDS.includes(id));
    if (unknown.length) {
      return { ok: false, code: REFUSAL_CODES.invalidValue, message: `Unrecognised restriction: ${unknown.slice(0, 3).join(", ")}.` };
    }

    const missing = S.MANDATORY_FORBIDDEN_PROMISES.filter((id) => !list.includes(id));
    if (missing.length) {
      return {
        ok: false,
        code: REFUSAL_CODES.invalidValue,
        message: `These safety limits cannot be switched off: ${missing.map((id) => S.FORBIDDEN_PROMISE_LABELS[id] || id).join(", ")}.`,
      };
    }

    out.value = list;
    // Retained for the audit trail and the read-back, but no longer trusted as
    // the security boundary.
    out.removing = Array.isArray(change.removing) ? change.removing : [];
    return { ok: true, change: out };
  }

  // Free-form targets (greeting, hours, areas, urgency, pricing wording,
  // caller info, notifications, privacy) are carried as a structured request
  // and validated in full when applied to a draft profile, where the whole
  // profile can be checked together.
  if (change.value === undefined || change.value === null || change.value === "") {
    return { ok: false, code: REFUSAL_CODES.invalidValue, message: "Tell us what it should be changed to." };
  }
  out.value = typeof change.value === "string" ? change.value.slice(0, 2000) : change.value;
  return { ok: true, change: out };
}

/**
 * Build a change request. `sourceChannel` is required and recorded; a voice
 * channel additionally requires a voice session so the request can always be
 * traced back to what was actually said.
 */
function buildChangeRequest({
  requestId,
  clientId,
  sourceChannel,
  requestedBy,
  changes,
  clientNote = null,
  voiceSessionId = null,
  transcriptReference = null,
  status = "draft",
}, nowIso = new Date().toISOString()) {
  if (!requestId || !clientId) return { ok: false, code: REFUSAL_CODES.invalidValue, message: "A change request needs a client." };
  if (!SOURCE_CHANNELS.includes(sourceChannel)) {
    return { ok: false, code: REFUSAL_CODES.unknownChannel, message: `"${String(sourceChannel).slice(0, 40)}" is not a recognised request channel.` };
  }
  if (isVoiceChannel(sourceChannel) && !voiceSessionId) {
    // A spoken request with no session cannot be traced to evidence.
    return { ok: false, code: REFUSAL_CODES.voiceSessionMissing, message: "A spoken change request must be attached to a voice session." };
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: false, code: REFUSAL_CODES.invalidValue, message: "A change request needs at least one change." };
  }

  const validated = [];
  for (const change of changes) {
    const result = validateChange(change);
    if (!result.ok) return result;
    validated.push(result.change);
  }

  const confirmations = requiredConfirmations(validated);

  return {
    ok: true,
    fields: {
      request_id: requestId,
      client_id: clientId,
      source_channel: sourceChannel,
      requested_by: requestedBy ? String(requestedBy).slice(0, 200) : null,
      status,
      changes: validated,
      client_note: clientNote ? String(clientNote).slice(0, 2000) : null,
      voice_session_id: voiceSessionId,
      // A reference, never the transcript itself. The transcript stays on the
      // session record; configuration is built from the structured changes.
      transcript_reference: transcriptReference ? String(transcriptReference).slice(0, 200) : null,
      required_confirmations: confirmations,
      confirmations: {},
      invalidates_tests: invalidatesTests(validated),
      clarification_note: null,
      resulting_profile_version: null,
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      created_at: nowIso,
      updated_at: nowIso,
    },
  };
}

/**
 * Can this request be applied to a new draft profile?
 * Returns { ok } or { ok:false, blockers[] } — every reason at once.
 */
function evaluateApplication({ request, actor, expectedUpdatedAt = null }) {
  const blockers = [];
  const add = (kind, code, message) => blockers.push({ kind, code, message });

  if (!request) {
    add("state", REFUSAL_CODES.badTransition, "That change request no longer exists.");
    return { ok: false, blockers };
  }
  if (!actor || actor.clientId !== request.client_id) {
    add("auth", REFUSAL_CODES.notAuthorised, "You are not authorised to act on this request.");
  }
  if (!canTransition(request.status, "applied_to_draft")) {
    add("state", REFUSAL_CODES.badTransition, `A request with status "${request.status}" cannot be applied.`);
  }
  if (expectedUpdatedAt && request.updated_at && expectedUpdatedAt !== request.updated_at) {
    add("conflict", REFUSAL_CODES.stale, "This request changed while you were looking at it. Reload and check before applying.");
  }

  // Every required confirmation must be present, whichever channel filed the
  // request. A voice request needs the read-back recorded exactly as a form
  // request needs the tick.
  const given = request.confirmations && typeof request.confirmations === "object" ? request.confirmations : {};
  for (const required of request.required_confirmations || []) {
    const key = `${required.target}:${required.kind}`;
    if (!given[key] || !given[key].confirmedAt) {
      add(
        "content",
        required.kind === "read_back" ? REFUSAL_CODES.readBackMissing : REFUSAL_CODES.confirmationMissing,
        required.kind === "read_back"
          ? `The ${required.label.toLowerCase()} must be read back and confirmed before it can change.`
          : `${required.label} is a safety-critical setting and needs explicit confirmation.`
      );
    }
  }

  return { ok: blockers.length === 0, blockers };
}

/** Record one confirmation. Pure merge. */
function applyConfirmation(existing, { target, kind, actorId, channel, evidence = null }, nowIso = new Date().toISOString()) {
  const key = `${target}:${kind}`;
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  next[key] = {
    confirmedAt: nowIso,
    actorId: actorId ? String(actorId).slice(0, 200) : null,
    // Which channel the confirmation came through — a portal tick and a spoken
    // "yes that's right" are both valid, and the audit must say which.
    channel: SOURCE_CHANNELS.includes(channel) ? channel : "client_ui",
    evidence: evidence ? String(evidence).slice(0, 300) : null,
  };
  return next;
}

/**
 * Produce the profile diff a request would make. Pure and side-effect free —
 * this is what the portal shows as before/after and what a voice agent would
 * read back. It does NOT touch the approved profile.
 */
function buildProfileDiff({ approvedProfile, changes }) {
  const diff = [];
  for (const change of changes || []) {
    const target = CHANGE_TARGETS[change.target];
    if (!target) continue;
    const before = readCurrentValue(approvedProfile, change.target);
    diff.push({
      target: change.target,
      label: target.label,
      section: target.section,
      before,
      after: change.value,
      safetyCritical: target.safetyCritical,
      requiresReadBack: target.readBack,
      invalidatesTests: target.invalidatesTests,
    });
  }
  return diff;
}

function readCurrentValue(profile, target) {
  if (!profile || typeof profile !== "object") return null;
  const map = {
    greeting: () => profile.identity && profile.identity.greeting,
    tone: () => profile.identity && profile.identity.tone,
    servicesAccepted: () => (profile.servicesAccepted || []).filter((s) => s && s.enabled).map((s) => s.serviceId),
    servicesDeclined: () => (profile.servicesDeclined || []).map((s) => s.serviceId),
    serviceAreas: () => profile.serviceAreas && profile.serviceAreas.primary,
    hours: () => profile.hours && profile.hours.ordinary,
    afterHours: () => profile.hours && profile.hours.afterHoursAvailable,
    urgencyRules: () => (profile.urgencyRules || []).map((r) => r.ruleId),
    transferPrimary: () => profile.transfer && profile.transfer.primaryNumber,
    transferBackup: () => profile.transfer && profile.transfer.backupNumber,
    transferFallback: () => profile.transfer && profile.transfer.unansweredAction,
    notifications: () => profile.notifications,
    pricing: () => profile.pricing && { mayMentionPricing: profile.pricing.mayMentionPricing, humanConfirmsEveryPrice: profile.pricing.humanConfirmsEveryPrice },
    callerInfo: () => profile.callerInfo && profile.callerInfo.always,
    forbiddenPromises: () => (profile.forbiddenPromises || []).filter((p) => p.enabled).map((p) => p.promiseId),
    privacy: () => profile.privacy,
  };
  const reader = map[target];
  return reader ? reader() ?? null : null;
}

/**
 * Apply validated changes to a COPY of the approved profile, producing the body
 * of a new draft version. The approved profile passed in is deep-copied first,
 * so there is no code path by which an accepted change mutates a live
 * configuration.
 */
function buildDraftFromChanges({ approvedProfile, changes }) {
  if (!approvedProfile) return { ok: false, code: REFUSAL_CODES.invalidValue, message: "There is no approved profile to change." };
  const draft = JSON.parse(JSON.stringify(approvedProfile));

  for (const change of changes || []) {
    switch (change.target) {
      case "greeting": draft.identity.greeting = change.value; break;
      case "tone": draft.identity.tone = change.value; break;
      case "transferPrimary": draft.transfer.primaryNumber = change.value; break;
      case "transferBackup": draft.transfer.backupNumber = change.value; break;
      case "transferFallback": draft.transfer.unansweredAction = change.value; break;
      case "afterHours": draft.hours.afterHoursAvailable = change.value === true || change.value === "true"; break;
      case "servicesAccepted": {
        const wanted = new Set(change.value);
        draft.servicesAccepted = [...S.SERVICE_IDS]
          .filter((id) => wanted.has(id))
          .map((id) => {
            const existing = (approvedProfile.servicesAccepted || []).find((s) => s.serviceId === id);
            return existing ? { ...existing, enabled: true } : { serviceId: id, publicName: S.SERVICE_LABELS[id], enabled: true, availability: null, notes: null, mayBeUrgent: false, mustCollect: [] };
          });
        break;
      }
      case "servicesDeclined":
        draft.servicesDeclined = change.value.map((id) => ({ serviceId: id, reason: "Updated by the business owner." }));
        break;
      case "serviceAreas":
        draft.serviceAreas.primary = Array.isArray(change.value) ? change.value : [change.value];
        break;
      case "callerInfo":
        draft.callerInfo.always = Array.isArray(change.value) ? change.value.filter((f) => S.CALLER_INFO_FIELDS.includes(f)) : draft.callerInfo.always;
        break;
      case "pricing":
        if (change.value && typeof change.value === "object") Object.assign(draft.pricing, change.value);
        break;
      case "privacy":
        if (change.value && typeof change.value === "object") Object.assign(draft.privacy, change.value);
        break;
      case "notifications":
        if (change.value && typeof change.value === "object") Object.assign(draft.notifications, change.value);
        break;
      case "hours":
        if (change.value && typeof change.value === "object") draft.hours.ordinary = change.value;
        break;
      case "urgencyRules":
        if (Array.isArray(change.value)) draft.urgencyRules = change.value;
        break;
      case "forbiddenPromises": {
        const removing = new Set(change.removing || []);
        draft.forbiddenPromises = draft.forbiddenPromises.filter((p) => !removing.has(p.promiseId));
        break;
      }
      default: break;
    }
  }

  const validation = validateProfile(draft);
  const assessment = assessProvisioning(draft);
  return { ok: validation.ok, draft, validation, assessment };
}

/** Deterministic request id from the change content, so a resubmit is idempotent. */
function requestFingerprint({ clientId, changes, sourceChannel }) {
  const material = JSON.stringify({ clientId, sourceChannel, changes: (changes || []).map((c) => ({ t: c.target, v: c.value })) });
  return crypto.createHash("sha256").update(material).digest("hex");
}

/** Client-facing shape. Numbers are masked; the read-back text is not. */
function toPublicChangeRequest(row) {
  if (!row) return null;
  return Object.freeze({
    requestId: row.request_id,
    status: row.status,
    sourceChannel: row.source_channel,
    changes: (row.changes || []).map((c) => ({
      target: c.target,
      label: CHANGE_TARGETS[c.target] ? CHANGE_TARGETS[c.target].label : c.target,
      // A transfer number in a change request is shown back in full on purpose:
      // the client must be able to check the digits they are approving.
      value: c.value,
      readBackText: c.readBackText || null,
    })),
    // A one-line description of what this request would change. Both the portal
    // and the founder view list requests by this line; without it every request
    // in the list read "Change request" and a client could not tell one from
    // another without opening each in turn.
    summary: summariseChanges(row.changes),
    requiredConfirmations: row.required_confirmations || [],
    confirmations: Object.keys(row.confirmations || {}),
    invalidatesTests: row.invalidates_tests === true,
    safetyCritical: (row.changes || []).some((c) => CHANGE_TARGETS[c.target] && CHANGE_TARGETS[c.target].safetyCritical),
    clarificationNote: row.clarification_note || null,
    resultingProfileVersion: row.resulting_profile_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** "Greeting" · "Greeting and primary transfer number" · "4 settings". */
function summariseChanges(changes) {
  const labels = (changes || []).map((c) => (CHANGE_TARGETS[c.target] ? CHANGE_TARGETS[c.target].label : c.target)).filter(Boolean);
  if (labels.length === 0) return "Change request";
  if (labels.length === 1) return `Change ${lowerFirst(labels[0])}`;
  if (labels.length === 2) return `Change ${lowerFirst(labels[0])} and ${lowerFirst(labels[1])}`;
  return `Change ${labels.length} settings: ${labels.slice(0, 2).map(lowerFirst).join(", ")} and ${labels.length - 2} more`;
}

// Labels are written for headings ("Primary transfer number"); mid-sentence
// they need a lower-case first letter unless they start with a proper noun.
function lowerFirst(s) {
  const str = String(s);
  return /^AIDA/.test(str) ? str : str.charAt(0).toLowerCase() + str.slice(1);
}

// ── DB adapter ──────────────────────────────────────────────────────

const { tableMissing: m4TableMissing } = require("./onboarding-call-consent");

function tableMissing(error) {
  return (
    Boolean(error && (error.code === "42P01" || /relation .* does not exist|could not find the table|schema cache/i.test(error.message || ""))) ||
    m4TableMissing(error)
  );
}

// Carries a `code` ending in "unavailable" — the portal handlers key their 503
// path off that suffix, so an unprovisioned table answers "not switched on yet"
// rather than a 500 that reads like a bug.
function provisioningError() {
  const e = new Error("Change requests are not provisioned yet. Apply supabase/sql/lpm5_create_client_portal.sql.");
  e.code = "change_requests_unavailable";
  return e;
}

async function listRequests(clientId, { limit = 50, supabase } = {}) {
  const db = supabase || require("./supabase");
  const { data, error } = await db.from(TABLE).select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(limit);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`change request list failed: ${error.message}`);
  }
  return data || [];
}

async function getRequest(clientId, requestId, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const { data, error } = await db.from(TABLE).select("*").eq("client_id", clientId).eq("request_id", requestId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`change request lookup failed: ${error.message}`);
  }
  return data || null;
}

/**
 * Insert one request. `fields` is the object buildChangeRequest returns, which
 * is already in column form.
 *
 * The clientId argument is deliberately separate and always wins, so a caller
 * cannot smuggle a different tenant in through the request body. This is the
 * one place the two could disagree, and the session's client is the only one
 * that has been verified.
 */
async function createRequest(clientId, fields, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const row = { ...fields, client_id: clientId };
  const { data, error } = await db.from(TABLE).insert(row).select().single();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`creating the change request failed: ${error.message}`);
  }
  return data;
}

async function updateRequest(clientId, requestId, patch, { expectedStatus = null, expectedUpdatedAt = null, supabase } = {}) {
  const db = supabase || require("./supabase");
  let query = db.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("request_id", requestId);
  if (expectedStatus) query = query.eq("status", expectedStatus);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`updating the change request failed: ${error.message}`);
  }
  if (!data || data.length === 0) return { ok: false, code: REFUSAL_CODES.stale, message: "The request changed underneath this update." };
  return { ok: true, row: data[0] };
}

module.exports = {
  TABLE,
  SOURCE_CHANNELS,
  VOICE_CHANNELS,
  STATUSES,
  TRANSITIONS,
  CHANGE_TARGETS,
  CHANGE_TARGET_KEYS,
  REFUSAL_CODES,
  canTransition,
  isVoiceChannel,
  requiredConfirmations,
  invalidatesTests,
  validateChange,
  buildChangeRequest,
  evaluateApplication,
  applyConfirmation,
  buildProfileDiff,
  buildDraftFromChanges,
  readCurrentValue,
  requestFingerprint,
  toPublicChangeRequest,
  tableMissing,
  provisioningError,
  listRequests,
  getRequest,
  createRequest,
  updateRequest,
};
