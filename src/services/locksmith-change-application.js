// AIDA — change application service (M7).
//
// The reusable step that was missing: structured changes in, a NEW DRAFT
// VERSION out, with a diff and read-back, leaving the approved version exactly
// as it was.
//
// This is the service the audit found had no consumer. buildDraftFromChanges,
// buildProfileDiff and evaluateApplication all existed and all worked; nothing
// called them. This wires them into one callable operation.
//
// ─── CHANNEL-NEUTRAL BY CONSTRUCTION ────────────────────────────────
// Takes plain data. No req, no res, no rendering, no channel assumptions. The
// caller supplies `sourceChannel`, which is recorded but never branched on:
//
//   portal UI            → sourceChannel: "client_ui"
//   voice config agent   → sourceChannel: "voice_configuration_agent"
//   founder tools        → sourceChannel: "founder_operator"
//   API / chat           → sourceChannel: "api"
//
// Every one of them gets the same validation, the same versioning, the same
// diff and the same audit trail. That is the whole point: a second path would
// be a second set of rules, and the second set is always the one that is wrong.
//
// ─── WHAT IT WILL NOT DO ────────────────────────────────────────────
// It does not approve. It creates a draft and stops. Approval is a separate,
// explicit client act (services/locksmith-approval-service.js), because "the
// system decided your change was fine" is precisely the property this product
// sells the absence of.

const changeRequests = require("./locksmith-change-request");
const store = require("./locksmith-profile-store");
const { assessProvisioning } = require("./locksmith-profile");

const APPLICATION_VERSION = "change-application-2026-08-01";

const OUTCOMES = Object.freeze({
  drafted: "drafted",
  noApprovedProfile: "no_approved_profile",
  invalidChanges: "invalid_changes",
  wouldNotChange: "would_not_change",
  draftInvalid: "draft_invalid",
  storeUnavailable: "store_unavailable",
});

/**
 * Apply structured changes to a new draft version.
 *
 * @returns {Promise<{ok, outcome, version?, diff?, readBack?, changes?, blockers?}>}
 */
function createChangeApplicationService(deps = {}) {
  const domain = deps.changeRequests || changeRequests;
  const storeApi = deps.store || store;
  const assess = deps.assessProvisioning || assessProvisioning;
  const logger = deps.logger || console;
  const now = deps.now || (() => new Date().toISOString());

  /**
   * @param {object}   args
   * @param {string}   args.clientId       verified tenant — never from a payload
   * @param {Array}    args.changes        [{ target, value, ... }]
   * @param {string}   args.sourceChannel  one of SOURCE_CHANNELS
   * @param {object}   args.actor          { type, id, clientId }
   * @param {object}  [args.provenance]    extraction provenance, if any
   * @param {string}  [args.reason]        human-readable why
   */
  async function applyChanges({ clientId, changes, sourceChannel, actor, provenance = null, reason = null, sessionId = null }) {
    if (!clientId) return refuse(OUTCOMES.invalidChanges, "A change needs to know which client it is for.");
    if (!domain.SOURCE_CHANNELS.includes(sourceChannel)) {
      return refuse(OUTCOMES.invalidChanges, `"${String(sourceChannel).slice(0, 40)}" is not a recognised request channel.`);
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      return refuse(OUTCOMES.invalidChanges, "There were no changes to apply.");
    }
    // Authorisation is the caller's tenant matching the target tenant. The same
    // rule for every channel; voice does not get a weaker one.
    if (!actor || actor.clientId !== clientId) {
      return refuse(OUTCOMES.invalidChanges, "Not authorised to change this client's configuration.");
    }

    // 1. Load the CURRENT approved profile. Read fresh rather than trusting a
    //    caller-supplied copy — a proposal built minutes ago may be stale.
    let approvedRow;
    try {
      approvedRow = await storeApi.getApprovedVersion(clientId);
    } catch (err) {
      if (err && /not provisioned|unavailable/i.test(err.message || "")) {
        return refuse(OUTCOMES.storeUnavailable, "Configuration storage is not set up yet.");
      }
      throw err;
    }
    if (!approvedRow || !approvedRow.profile) {
      return refuse(OUTCOMES.noApprovedProfile, "There is no approved profile to change yet.");
    }

    // 2. Validate every change through the ONE domain validator.
    //
    // validateChange returns a NORMALISED change carrying only fields the
    // domain knows about — which deliberately excludes a caller-supplied
    // read-back. That is correct (an extractor must not be able to smuggle
    // arbitrary fields into a change), but the read-back it produced is worth
    // keeping: it is phrased for the client and names things the generic
    // fallback cannot, such as a refusal being reversed. So it is carried
    // alongside, keyed by target, rather than through the validator.
    const validated = [];
    const suppliedReadBacks = new Map();
    for (const change of changes) {
      const result = domain.validateChange(change);
      if (!result.ok) {
        return { ok: false, outcome: OUTCOMES.invalidChanges, code: result.code, message: result.message, target: change && change.target };
      }
      if (change && change.readBack && change.readBack.spoken) {
        suppliedReadBacks.set(result.change.target, change.readBack);
      }
      validated.push(result.change);
    }

    // 3. Diff BEFORE building the draft, against the profile we just read.
    const diff = domain.buildProfileDiff({ approvedProfile: approvedRow.profile, changes: validated });

    // A change that changes nothing should not create a version. Version churn
    // makes the audit trail unreadable and gives the client a pointless
    // approval to make.
    const effective = diff.filter((d) => !deepEqual(d.before, d.after));
    if (!effective.length) {
      return {
        ok: false,
        outcome: OUTCOMES.wouldNotChange,
        message: "That is already how your receptionist is set up. Nothing to approve.",
        diff,
      };
    }

    // 4. Build the draft from a DEEP COPY. buildDraftFromChanges copies first;
    //    asserted below rather than assumed.
    const approvedSnapshot = JSON.parse(JSON.stringify(approvedRow.profile));
    const built = domain.buildDraftFromChanges({ approvedProfile: approvedRow.profile, changes: validated });

    if (!deepEqual(approvedSnapshot, approvedRow.profile)) {
      // Defensive: if this ever fires, the approved profile was mutated in
      // place and the live configuration is at risk. Fail loudly.
      logger.error(`[change-application] APPROVED PROFILE MUTATED during draft build for ${clientId} — refusing`);
      return refuse(OUTCOMES.draftInvalid, "Internal error building the draft. Nothing was changed.");
    }

    if (!built.ok) {
      return {
        ok: false,
        outcome: OUTCOMES.draftInvalid,
        message: "The change would leave your configuration invalid.",
        errors: (built.validation && built.validation.errors) || [],
        diff,
      };
    }

    // 5. Create the new draft version. status "needs_review" — the client has
    //    not seen it yet, so it is not approvable.
    let draftRow;
    try {
      draftRow = await storeApi.createDraftVersion({
        clientId,
        profile: built.draft,
        sessionId,
        extractionVersion: provenance ? provenance.extractionVersion : null,
        status: "needs_review",
        actor,
        reason: reason || `Change requested via ${sourceChannel}`,
        source: sourceChannel,
      });
    } catch (err) {
      if (err && /not provisioned|unavailable/i.test(err.message || "")) {
        return refuse(OUTCOMES.storeUnavailable, "Configuration storage is not set up yet.");
      }
      throw err;
    }

    // 6. Audit. Provenance travels with it so a later dispute can reach the
    //    original words.
    await safeAudit(storeApi, logger, {
      clientId,
      sessionId,
      eventType: "profile.change_applied_to_draft",
      actorType: actor.type,
      actorId: actor.id,
      reason: reason || null,
      source: sourceChannel,
      detail: {
        applicationVersion: APPLICATION_VERSION,
        fromVersion: approvedRow.version,
        toVersion: draftRow.version,
        targets: validated.map((c) => c.target),
        safetyCritical: validated.some((c) => domain.CHANGE_TARGETS[c.target] && domain.CHANGE_TARGETS[c.target].safetyCritical),
        invalidatesTests: domain.invalidatesTests(validated),
        provenance: provenance || null,
      },
    });

    logger.log(
      `[change-application] client=${clientId} v${approvedRow.version}->v${draftRow.version} channel=${sourceChannel} targets=${validated.map((c) => c.target).join(",")}`
    );

    return {
      ok: true,
      outcome: OUTCOMES.drafted,
      applicationVersion: APPLICATION_VERSION,
      clientId,
      fromVersion: approvedRow.version,
      version: draftRow.version,
      status: draftRow.status,
      updatedAt: draftRow.updated_at || null,
      changes: validated,
      diff,
      effectiveDiff: effective,
      readBack: buildReadBackSummary(effective, validated, suppliedReadBacks),
      // Approving this will invalidate existing receptionist tests, and the
      // caller should say so before asking for approval.
      invalidatesTests: domain.invalidatesTests(validated),
      requiredConfirmations: domain.requiredConfirmations(validated),
      provisioning: assess(built.draft),
      provenance,
    };
  }

  return { applyChanges, OUTCOMES, APPLICATION_VERSION };
}

/**
 * One read-back for every channel. The portal prints `written`; a future voice
 * agent speaks `spoken`. Same content, so the two can never describe the same
 * change differently.
 */
function buildReadBackSummary(effectiveDiff, validated, suppliedReadBacks = new Map()) {
  const lines = effectiveDiff.map((d) => {
    const supplied = suppliedReadBacks.get(d.target);
    if (supplied) return supplied;
    return {
      spoken: `Your ${d.label.toLowerCase()} would change.`,
      written: `${d.label}: ${describe(d.before)} → ${describe(d.after)}`,
    };
  });
  return {
    spoken: lines.map((l) => l.spoken).join(" "),
    written: lines.map((l) => l.written),
    changeCount: effectiveDiff.length,
    safetyCritical: effectiveDiff.some((d) => d.safetyCritical),
  };
}

function describe(v) {
  if (v === null || v === undefined) return "not set";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function refuse(outcome, message) {
  return { ok: false, outcome, message };
}

/** An audit write must never be the reason a legitimate change fails. */
async function safeAudit(storeApi, logger, event) {
  try {
    await storeApi.recordAuditEvent(storeApi.buildAuditEvent(event));
  } catch (err) {
    logger.error(`[change-application] audit write failed: ${err.message}`);
  }
}

module.exports = {
  APPLICATION_VERSION,
  OUTCOMES,
  createChangeApplicationService,
  buildReadBackSummary,
};
