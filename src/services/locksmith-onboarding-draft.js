// AIDA Locksmith Receptionist — the setup draft service (M8A).
//
// The missing middle of the journey. Everything downstream of "a draft profile
// exists" was already built and working — versioning, review, per-section
// confirmation, the approval guard, the audit trail. Nothing created that first
// draft except an operator pasting a call transcript, which is why onboarding a
// real locksmith needed a founder with SQL access.
//
// This service is the answer: a locksmith's own answers, step by step, becoming
// a versioned draft they then review and approve through the machinery that
// already exists.
//
// ─── CHANNEL-NEUTRAL BY CONSTRUCTION ────────────────────────────────
// Plain data in, plain data out. No req, no res, no rendering. The caller says
// which channel it is, and that is recorded but never branched on:
//
//   web setup wizard       → sourceChannel "client_ui"
//   Release 2 voice agent  → sourceChannel "initial_voice_onboarding"
//   founder tools          → sourceChannel "founder_operator"
//
// The Release 2 voice agent collects answers for the SAME step ids declared in
// locksmith-onboarding-steps.js and calls the SAME saveStep. It does not need a
// second onboarding model, a second validator or a second approval path — which
// is the requirement that shaped this file.
//
// ─── WHAT IT WILL NOT DO ────────────────────────────────────────────
// It does not approve, and it cannot touch an approved or under-review profile.
// Every write goes through store.updateDraftProfile, which filters on
// `status = "draft"`. Approval stays where it was: an explicit, confirmed,
// audited client act.

const S = require("./locksmith-profile-schema");
const steps = require("./locksmith-onboarding-steps");
const store = require("./locksmith-profile-store");
const { validateProfile, assessProvisioning, normaliseAuNumber } = require("./locksmith-profile");

const DRAFT_SERVICE_VERSION = "locksmith-onboarding-draft-2026-08-04";

const OUTCOMES = Object.freeze({
  ok: "ok",
  unknownStep: "unknown_step",
  invalidAnswers: "invalid_answers",
  noDraft: "no_draft",
  notAuthorised: "not_authorised",
  stale: "stale_draft",
  storeUnavailable: "store_unavailable",
  incomplete: "incomplete",
  badVersion: "bad_version",
});

const SOURCE_CHANNELS = Object.freeze(["client_ui", "initial_voice_onboarding", "voice_configuration_agent", "founder_operator", "api"]);

// ── Seeding ─────────────────────────────────────────────────────────

/**
 * A brand-new profile for a client who has answered nothing.
 *
 * The mandatory forbidden promises are switched on here rather than asked,
 * because they are a floor and not a preference — every one of them is a claim
 * that could put a caller in danger or the locksmith in court. The wizard shows
 * them, read-only, so the owner knows what we will never say; it does not offer
 * to turn them off, because there is no answer to that question we would accept.
 */
function seedProfile(clientId) {
  const profile = S.emptyProfile();
  profile.identity.clientId = clientId || null;
  profile.forbiddenPromises = S.MANDATORY_FORBIDDEN_PROMISES.map((promiseId) => ({
    promiseId,
    enabled: true,
    note: null,
  }));
  // Never absent, never optional: a lead with no number is not a lead, and
  // assessProvisioning blocks on it anyway. Seeding it means the owner starts
  // from a safe default rather than discovering a blocker at review.
  profile.callerInfo.always = ["callback_number", "caller_name"];
  return profile;
}

// ── Contradiction detection ─────────────────────────────────────────
//
// Distinct from validation and from provisioning blockers:
//
//   validateProfile      is this shape legal?
//   assessProvisioning   is anything missing that would stop us building it?
//   detectContradictions is anything here at odds with something else here?
//
// The third is the one a form cannot catch field by field, because each answer
// is individually fine. Every finding names the step that can fix it, so the
// review page can link straight to the box rather than describing it.

function detectContradictions(profile) {
  const found = [];
  const add = (severity, code, stepId, message) => found.push({ severity, code, stepId, message });
  const p = profile && typeof profile === "object" ? profile : {};
  const areas = p.serviceAreas || {};
  const hours = p.hours || {};
  const transfer = p.transfer || {};
  const identity = p.identity || {};
  const pricing = p.pricing || {};

  // 1. A suburb cannot be two things at once. Compared case-insensitively —
  //    "Frankston" and "frankston" are the same place to a caller.
  const buckets = [
    ["primary", "covered", areas.primary],
    ["extended", "stretched to", areas.extended],
    ["declined", "declined", areas.declined],
  ];
  const seen = new Map();
  for (const [key, label, list] of buckets) {
    for (const suburb of Array.isArray(list) ? list : []) {
      const norm = String(suburb).trim().toLowerCase();
      if (!norm) continue;
      const previous = seen.get(norm);
      if (previous && previous.key !== key) {
        add(
          "blocker",
          "suburb_in_two_lists",
          "areas",
          `"${String(suburb).trim()}" is listed as ${previous.label} and as ${label}. It can only be one.`
        );
      } else if (!previous) {
        seen.set(norm, { key, label });
      }
    }
  }

  // 2. The mistake the whole M7 fix was about: sending urgent callers back into
  //    the number they just rang. It loops, and a genuine emergency is lost in
  //    the loop.
  const publicNumber = normaliseAuNumber(identity.businessPhone);
  const transferNumber = normaliseAuNumber(transfer.primaryNumber);
  if (publicNumber && transferNumber && publicNumber === transferNumber) {
    add(
      "blocker",
      "transfer_is_public_number",
      "contact",
      "Your urgent-transfer number is the same as your public business number, so an urgent caller would be sent back to the line they just rang. Use a mobile you carry."
    );
  }
  const backupNumber = normaliseAuNumber(transfer.backupNumber);
  if (publicNumber && backupNumber && publicNumber === backupNumber) {
    add("warning", "backup_is_public_number", "contact", "Your backup transfer number is your public business number.");
  }

  // 3. After-hours answers that disagree with each other.
  if (hours.afterHoursAvailable === false) {
    if (Array.isArray(areas.afterHoursAreas) && areas.afterHoursAreas.length) {
      add(
        "warning",
        "after_hours_areas_without_after_hours",
        "hours",
        "You've set a smaller after-hours area, but also said you don't take call-outs after hours."
      );
    }
    const est = hours.callbackEstimate;
    if (est && est.afterHours) {
      add(
        "warning",
        "after_hours_estimate_without_after_hours",
        "hours",
        "You've given an after-hours callback estimate, but said you don't work after hours."
      );
    }
  }

  // 4. A suburb you won't go to, listed as somewhere you go at 2am.
  const declinedSet = new Set((Array.isArray(areas.declined) ? areas.declined : []).map((s) => String(s).trim().toLowerCase()));
  for (const suburb of Array.isArray(areas.afterHoursAreas) ? areas.afterHoursAreas : []) {
    if (declinedSet.has(String(suburb).trim().toLowerCase())) {
      add("blocker", "after_hours_area_declined", "areas", `"${String(suburb).trim()}" is on your after-hours list and also on your "won't go" list.`);
    }
  }

  // 5. Pricing wording that can never be spoken.
  if (pricing.mayMentionPricing === false && typeof pricing.calloutWording === "string" && pricing.calloutWording.trim()) {
    add(
      "warning",
      "pricing_wording_unusable",
      "jobs",
      "You've written pricing wording but told us never to mention price, so it will never be said."
    );
  }

  // 6. A service both accepted and declined. Impossible through the wizard's
  //    tri-state, but a profile can also arrive from extraction or rollback.
  const accepted = new Set((Array.isArray(p.servicesAccepted) ? p.servicesAccepted : []).filter((s) => s && s.enabled === true).map((s) => s.serviceId));
  for (const svc of Array.isArray(p.servicesDeclined) ? p.servicesDeclined : []) {
    if (svc && accepted.has(svc.serviceId)) {
      add("blocker", "service_accepted_and_declined", "services", `"${S.SERVICE_LABELS[svc.serviceId] || svc.serviceId}" is marked both as work you take and work you refuse.`);
    }
  }

  // 7. A fallback that points at nothing.
  if (transfer.unansweredAction === "try_backup_number" && !backupNumber) {
    add("blocker", "backup_missing", "contact", "You've chosen to try a second number when nobody answers, but haven't given one.");
  }

  // 8. Urgent rules that transfer immediately with nowhere to transfer to.
  const transfersImmediately = (Array.isArray(p.urgencyRules) ? p.urgencyRules : []).some((r) => r && r.action === "transfer_immediately");
  if (transfersImmediately && !transferNumber) {
    add("blocker", "transfer_rule_without_number", "contact", "Some calls are set to be put straight through, but there is no number to put them through to.");
  }

  return found;
}

// ── Review summary ──────────────────────────────────────────────────

/**
 * Everything the review step needs, in one shape: what we learned, what is
 * missing, what disagrees, and — kept strictly apart — what actually blocks.
 *
 * The separation matters more than it looks. A warning the owner cannot
 * distinguish from a blocker teaches them to ignore both.
 */
function buildReviewSummary(profile) {
  const validation = validateProfile(profile);
  const assessment = assessProvisioning(profile);
  const contradictions = detectContradictions(profile);
  const progress = steps.assessProgress(profile);

  const contradictionBlockers = contradictions.filter((c) => c.severity === "blocker");
  const contradictionWarnings = contradictions.filter((c) => c.severity === "warning");

  const sections = steps.STEPS.map((step) => ({
    id: step.id,
    number: step.number,
    title: step.title,
    complete: steps.isStepComplete(step.id, profile),
    answers: steps.readStep(step.id, profile),
    fields: step.fields.map((f) => ({ name: f.name, label: f.label, kind: f.kind, required: f.required, options: f.options })),
    contradictions: contradictions.filter((c) => c.stepId === step.id),
  }));

  return {
    sections,
    progress,
    // Blockers are anything that would stop us building the receptionist:
    // structural errors, provisioning gaps, and contradictions we refuse to
    // guess our way past.
    blockers: [
      ...validation.errors.map((e) => ({ code: `invalid_${e.section}`, message: `${e.section}: ${e.message}`, stepId: stepForSection(e.section) })),
      ...assessment.blockers.map((b) => ({ ...b, stepId: stepForBlocker(b.code) })),
      ...contradictionBlockers,
    ],
    warnings: [
      ...assessment.warnings.map((w) => ({ ...w, stepId: stepForBlocker(w.code) })),
      ...contradictionWarnings,
    ],
    ready: assessment.ready && contradictionBlockers.length === 0 && validation.ok,
    // Read-only, always-on, and shown rather than asked.
    safetyFloor: S.MANDATORY_FORBIDDEN_PROMISES.map((id) => S.FORBIDDEN_PROMISE_LABELS[id]),
  };
}

// Which wizard step fixes a given profile section or blocker code. Used to turn
// "pricing_authority_ambiguous" into a link to the box that sets it.
const SECTION_TO_STEP = Object.freeze({
  identity: "identity",
  servicesAccepted: "services",
  servicesDeclined: "services",
  serviceAreas: "areas",
  hours: "hours",
  urgencyRules: "jobs",
  transfer: "contact",
  notifications: "contact",
  pricing: "jobs",
  callerInfo: "jobs",
  forbiddenPromises: "jobs",
  privacy: "tone",
  extensions: "identity",
  profile: "identity",
});

const BLOCKER_TO_STEP = Object.freeze({
  no_services_accepted: "services",
  transfer_number_invalid: "contact",
  transfer_backup_missing: "contact",
  no_service_area: "areas",
  no_outside_area_action: "areas",
  no_timezone: "identity",
  no_open_hours: "hours",
  no_urgency_rules: "jobs",
  pricing_authority_ambiguous: "jobs",
  forbidden_promises_missing: "jobs",
  no_callback_number: "jobs",
  no_caller_name: "jobs",
  no_description: "identity",
  no_notification_recipients: "contact",
  recording_preference_unset: "tone",
  no_declined_services: "services",
});

function stepForSection(section) {
  return steps.lookup(SECTION_TO_STEP, section) || "identity";
}

function stepForBlocker(code) {
  return steps.lookup(BLOCKER_TO_STEP, code) || null;
}

// ── The service ─────────────────────────────────────────────────────

function createOnboardingDraftService(deps = {}) {
  const storeApi = deps.store || store;
  const stepsApi = deps.steps || steps;
  const logger = deps.logger || console;

  function refuse(outcome, message, extra = {}) {
    return { ok: false, outcome, message, ...extra };
  }

  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && /not provisioned|unavailable/i.test(err.message || "")) {
        return refuse(OUTCOMES.storeUnavailable, "Setup storage is not switched on yet.");
      }
      throw err;
    }
  }

  /**
   * Return the client's open working draft, creating a blank one if there is
   * none. Idempotent on purpose: an owner who opens setup in two tabs, or a
   * voice agent that reconnects after a dropout, must land on the same draft
   * rather than fork into two rival ones.
   *
   * A new draft is seeded from the current APPROVED profile when one exists, so
   * "change my setup" starts from what is live rather than from blank. That is
   * also what makes this the same entry point for first-time setup and for a
   * later edit — one journey, not two.
   */
  async function startDraft({ clientId, actor, sourceChannel = "client_ui", reason = null }) {
    if (!clientId) return refuse(OUTCOMES.notAuthorised, "A setup needs to know which business it is for.");
    if (!actor || actor.clientId !== clientId) return refuse(OUTCOMES.notAuthorised, "You are not authorised to set up this business.");
    if (!SOURCE_CHANNELS.includes(sourceChannel)) return refuse(OUTCOMES.invalidAnswers, "Unrecognised setup channel.");

    return guarded(async () => {
      const existing = await storeApi.getWorkingDraft(clientId);
      if (existing) return { ok: true, outcome: OUTCOMES.ok, created: false, ...project(existing) };

      const approved = await storeApi.getApprovedVersion(clientId);
      const profile = approved && approved.profile ? JSON.parse(JSON.stringify(approved.profile)) : seedProfile(clientId);
      profile.identity.clientId = clientId;

      const row = await storeApi.createDraftVersion({
        clientId,
        profile,
        status: "draft",
        actor,
        reason: reason || (approved ? `Setup reopened from approved version ${approved.version}` : "Setup started"),
        source: sourceChannel,
      });
      logger.log(`[setup] draft_started client=${clientId} version=${row.version} from=${approved ? approved.version : "blank"} channel=${sourceChannel}`);
      return { ok: true, outcome: OUTCOMES.ok, created: true, basedOnVersion: approved ? approved.version : null, ...project(row) };
    });
  }

  /** The current working draft, or a `no_draft` refusal. Never creates one. */
  async function loadDraft({ clientId }) {
    if (!clientId) return refuse(OUTCOMES.notAuthorised, "A setup needs to know which business it is for.");
    return guarded(async () => {
      const row = await storeApi.getWorkingDraft(clientId);
      if (!row) return refuse(OUTCOMES.noDraft, "You haven't started your setup yet.");
      return { ok: true, outcome: OUTCOMES.ok, ...project(row) };
    });
  }

  /**
   * Validate and save one step's answers.
   *
   * Validation runs against the profile the answers would produce, not the one
   * they arrived at, because several rules are cross-field — "you chose to try a
   * backup number" is only wrong once you can see whether a backup number was
   * also supplied in the same submission.
   */
  async function saveStep({ clientId, stepId, answers, actor, sourceChannel = "client_ui", expectedUpdatedAt = null, allowIncomplete = false }) {
    if (!clientId) return refuse(OUTCOMES.notAuthorised, "A setup needs to know which business it is for.");
    if (!actor || actor.clientId !== clientId) return refuse(OUTCOMES.notAuthorised, "You are not authorised to change this setup.");
    if (!SOURCE_CHANNELS.includes(sourceChannel)) return refuse(OUTCOMES.invalidAnswers, "Unrecognised setup channel.");
    const step = stepsApi.getStep(stepId);
    if (!step) return refuse(OUTCOMES.unknownStep, "That isn't a setup step.");

    return guarded(async () => {
      const row = await storeApi.getWorkingDraft(clientId);
      if (!row) return refuse(OUTCOMES.noDraft, "You haven't started your setup yet.");

      const candidate = stepsApi.applyStep(stepId, answers, row.profile);

      // `allowIncomplete` is how "save and come back later" works: the answers
      // are stored exactly as given, and the step simply does not count as
      // complete. Nothing downstream can act on an incomplete draft anyway —
      // submission, review and approval each re-check.
      if (!allowIncomplete) {
        const verdict = stepsApi.validateStep(stepId, stepsApi.readStep(stepId, candidate), candidate);
        if (!verdict.ok) return refuse(OUTCOMES.invalidAnswers, "Some answers need another look.", { errors: verdict.errors, stepId });
      }

      const written = await storeApi.updateDraftProfile({
        clientId,
        version: row.version,
        profile: candidate,
        expectedUpdatedAt: expectedUpdatedAt || null,
      });
      if (!written.ok) return refuse(OUTCOMES.stale, written.message);

      await safeAudit(storeApi, logger, {
        clientId,
        profileVersion: row.version,
        eventType: "profile.setup_step_saved",
        actorType: actor.type,
        actorId: actor.id,
        source: sourceChannel,
        detail: { stepId, complete: stepsApi.isStepComplete(stepId, candidate), specVersion: stepsApi.STEP_SPEC_VERSION },
      });

      return {
        ok: true,
        outcome: OUTCOMES.ok,
        stepId,
        nextStepId: stepsApi.nextStepId(stepId),
        ...project(written.row),
      };
    });
  }

  /**
   * Hand the finished setup over for review.
   *
   * Refuses while any step is incomplete — not to be strict, but because the
   * review page's promise is "here is what we learned", and a review of a
   * half-answered form invites an approval of the blanks.
   */
  async function submitForReview({ clientId, actor, sourceChannel = "client_ui", expectedUpdatedAt = null }) {
    if (!clientId) return refuse(OUTCOMES.notAuthorised, "A setup needs to know which business it is for.");
    if (!actor || actor.clientId !== clientId) return refuse(OUTCOMES.notAuthorised, "You are not authorised to submit this setup.");

    return guarded(async () => {
      const row = await storeApi.getWorkingDraft(clientId);
      if (!row) return refuse(OUTCOMES.noDraft, "You haven't started your setup yet.");

      const progress = stepsApi.assessProgress(row.profile);
      if (!progress.allComplete) {
        return refuse(OUTCOMES.incomplete, "Finish every step before sending it for review.", {
          progress,
          outstanding: progress.steps.filter((s) => !s.complete).map((s) => ({ id: s.id, title: s.title })),
        });
      }

      const result = await storeApi.submitDraftForReview({
        clientId,
        version: row.version,
        actor,
        expectedUpdatedAt: expectedUpdatedAt || null,
        source: sourceChannel,
      });
      if (!result.ok) return refuse(result.code === "stale_draft" ? OUTCOMES.stale : OUTCOMES.badVersion, result.message);

      logger.log(`[setup] submitted_for_review client=${clientId} version=${row.version} channel=${sourceChannel}`);
      return { ok: true, outcome: OUTCOMES.ok, ...project(result.row) };
    });
  }

  /**
   * Roll back to an earlier version.
   *
   * Copies that version's profile into a NEW working draft. It does not
   * resurrect the old row, does not re-approve anything, and does not touch a
   * single byte of history — the whole point of retaining superseded versions is
   * that they stay exactly as they were. The restored settings then go through
   * review and approval like any other change, so a rollback is as visible and
   * as consented-to as the change it undoes.
   */
  async function rollbackToVersion({ clientId, version, actor, sourceChannel = "client_ui", reason = null }) {
    if (!clientId) return refuse(OUTCOMES.notAuthorised, "A setup needs to know which business it is for.");
    if (!actor || actor.clientId !== clientId) return refuse(OUTCOMES.notAuthorised, "You are not authorised to change this setup.");
    const wanted = Number.parseInt(version, 10);
    if (!Number.isInteger(wanted) || wanted < 1) return refuse(OUTCOMES.badVersion, "That isn't a version number.");

    return guarded(async () => {
      const source = await storeApi.getVersion(clientId, wanted);
      if (!source || !source.profile) return refuse(OUTCOMES.badVersion, "That version doesn't exist.");
      if (source.status === "draft") return refuse(OUTCOMES.badVersion, "That version is your current unfinished setup — there is nothing to roll back to.");

      const existing = await storeApi.getWorkingDraft(clientId);
      if (existing) {
        return refuse(OUTCOMES.stale, "Finish or discard your current setup before rolling back to an earlier version.", {
          workingDraftVersion: existing.version,
        });
      }

      const row = await storeApi.createDraftVersion({
        clientId,
        profile: JSON.parse(JSON.stringify(source.profile)),
        status: "draft",
        actor,
        reason: reason || `Rolled back to version ${wanted}`,
        source: sourceChannel,
      });

      await safeAudit(storeApi, logger, {
        clientId,
        profileVersion: row.version,
        eventType: "profile.rolled_back",
        actorType: actor.type,
        actorId: actor.id,
        reason: reason || null,
        source: sourceChannel,
        detail: { fromVersion: wanted, fromStatus: source.status, intoVersion: row.version },
      });

      logger.log(`[setup] rolled_back client=${clientId} from=v${wanted} into=v${row.version}`);
      return { ok: true, outcome: OUTCOMES.ok, restoredFromVersion: wanted, ...project(row) };
    });
  }

  /** Version history for the client, newest first. No internal ids leak. */
  async function listHistory({ clientId, limit = 50 }) {
    if (!clientId) return refuse(OUTCOMES.notAuthorised, "A setup needs to know which business it is for.");
    return guarded(async () => {
      const rows = await storeApi.listVersions(clientId, { limit });
      return {
        ok: true,
        outcome: OUTCOMES.ok,
        versions: rows.map((row) => ({
          version: row.version,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          approvedAt: row.approved_at || null,
          supersededByVersion: row.superseded_by_version || null,
          rejectionReason: row.rejection_reason || null,
          provisioningReady: row.provisioning_ready === true,
          // Restorable means: it is a settled version with content, and it is
          // not the row you are editing right now.
          restorable: ["approved", "superseded", "rejected", "needs_review"].includes(row.status),
        })),
      };
    });
  }

  return {
    startDraft,
    loadDraft,
    saveStep,
    submitForReview,
    rollbackToVersion,
    listHistory,
    OUTCOMES,
    DRAFT_SERVICE_VERSION,
  };
}

/** Shape a stored row for a caller. The profile body travels; nothing internal does. */
function project(row) {
  return {
    version: row.version,
    status: row.status,
    profile: row.profile,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    progress: steps.assessProgress(row.profile),
  };
}

/** An audit write must never be the reason a legitimate answer fails to save. */
async function safeAudit(storeApi, logger, event) {
  try {
    await storeApi.recordAuditEvent(storeApi.buildAuditEvent(event));
  } catch (err) {
    logger.error(`[setup] audit write failed: ${err.message}`);
  }
}

module.exports = {
  DRAFT_SERVICE_VERSION,
  OUTCOMES,
  SOURCE_CHANNELS,
  seedProfile,
  detectContradictions,
  buildReviewSummary,
  stepForSection,
  stepForBlocker,
  createOnboardingDraftService,
};
