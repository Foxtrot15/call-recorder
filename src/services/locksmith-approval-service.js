// AIDA — profile approval service (M7).
//
// Approval orchestration, lifted out of the HTTP handler so every channel can
// reuse it.
//
// The audit named this the highest-leverage decoupling in the repo, and the
// reason is narrow: when the voice configuration agent needs to approve a
// change, it must not re-implement approval. Approval carries the product's
// central promise — nothing goes live without the client saying yes — and a
// second implementation of that promise is a second place for it to be subtly
// wrong.
//
// What this service owns:
//   * authorisation (the actor's tenant must own the draft)
//   * required section confirmations
//   * optimistic concurrency / stale-version protection
//   * safety-floor validation
//   * audit events with actor AND source-channel attribution
//   * the session follow-on, which is bookkeeping and must not fail an approval
//   * handing off to the provisioning bridge
//
// What it does NOT own: HTTP. It returns a result object with a `refusalKind`;
// translating that to a status code is the handler's job, and the handler's
// only job.
//
// ─── NO CHANNEL GETS A WEAKER RULE ──────────────────────────────────
// `sourceChannel` is recorded on every audit event and never branched on for
// authorisation. Voice will be held to exactly the checks the portal is held
// to. A future voice agent adds its own AUTHENTICATION on top (proving the
// caller is who they claim); it does not get to skip the AUTHORISATION and
// confirmation checks below.

const store = require("./locksmith-profile-store");
const sessions = require("./locksmith-onboarding-session");
const changeRequests = require("./locksmith-change-request");

const APPROVAL_SERVICE_VERSION = "approval-service-2026-08-01";

const REFUSAL_KINDS = Object.freeze(["auth", "conflict", "state", "content", "unavailable"]);

/** Worst kind wins, so a caller sees the most actionable failure first. */
const KIND_SEVERITY = Object.freeze({ auth: 4, conflict: 3, state: 2, content: 1, unavailable: 0 });

function worstKind(blockers) {
  let worst = null;
  for (const b of blockers || []) {
    if (!worst || (KIND_SEVERITY[b.kind] || 0) > (KIND_SEVERITY[worst] || 0)) worst = b.kind;
  }
  return worst;
}

function createApprovalService(deps = {}) {
  const storeApi = deps.store || store;
  const sessionsApi = deps.sessions || sessions;
  const domain = deps.changeRequests || changeRequests;
  const bridge = deps.bridge || null;
  const logger = deps.logger || console;

  /**
   * Approve a specific draft version.
   *
   * @param {object}  args
   * @param {string}  args.clientId          verified tenant
   * @param {number}  args.version           the draft version being approved
   * @param {object}  args.actor             { type, id, clientId }
   * @param {string}  args.sourceChannel     who asked — recorded, never trusted for auth
   * @param {string} [args.expectedUpdatedAt] stale-review token
   * @param {string} [args.sessionId]        onboarding session to follow along, if any
   * @param {boolean}[args.runProvisioning]  compile + plan after approving
   */
  async function approve({ clientId, version, actor, sourceChannel, expectedUpdatedAt = null, reason = null, sessionId = null, runProvisioning = true }) {
    if (!clientId || version == null) {
      return refuse("content", "not_found", "There is no such draft to approve.");
    }
    if (!domain.SOURCE_CHANNELS.includes(sourceChannel)) {
      return refuse("content", "unknown_channel", `"${String(sourceChannel).slice(0, 40)}" is not a recognised request channel.`);
    }
    // Approval is an explicit CLIENT act. A system actor may never approve —
    // this is the code-level expression of "no critical change goes live
    // without explicit client approval".
    if (!actor || actor.type === "system") {
      return refuse("auth", "requires_client", "Approval needs an explicit client action. A system actor cannot approve a configuration change.");
    }
    if (actor.clientId !== clientId) {
      return refuse("auth", "not_authorised", "You are not authorised to approve this configuration.");
    }

    let result;
    try {
      // approveVersion re-reads the row and runs evaluateApproval internally:
      // authorisation, confirmations, safety floors, optimistic concurrency.
      // Deliberately delegated rather than duplicated here.
      result = await storeApi.approveVersion({
        clientId,
        version,
        actor,
        reason: reason || null,
        expectedUpdatedAt,
        source: sourceChannel,
      });
    } catch (err) {
      if (err && /not provisioned|unavailable/i.test(err.message || "")) {
        return refuse("unavailable", "store_unavailable", "Configuration storage is not set up yet.");
      }
      throw err;
    }

    if (!result.ok) {
      return {
        ok: false,
        code: "approval_refused",
        refusalKind: worstKind(result.blockers) || "content",
        message: "These settings can't be approved yet.",
        blockers: result.blockers,
      };
    }

    // The session follows the profile, not the other way round. The approval
    // above is what counts; a session that refuses the transition (it moved on,
    // or was already terminal) is bookkeeping drift worth logging, never a
    // reason to tell a client their approval failed.
    if (sessionId) {
      try {
        const followed = await sessionsApi.transitionSession({
          clientId, sessionId, to: "approved", actor,
          reason: "profile approved", source: sourceChannel,
        });
        if (followed && followed.ok === false) {
          logger.error(`[approval] session_not_followed session=${sessionId} code=${followed.code}`);
        }
      } catch (err) {
        logger.error(`[approval] session follow failed session=${sessionId}: ${err.message}`);
      }
    }

    // Compile + plan. Never executes — see approval-provisioning-bridge.js.
    let provisioning = null;
    if (runProvisioning && bridge) {
      try {
        provisioning = await bridge.onProfileApproved({ clientId, sessionId, approvedVersion: version, actor });
      } catch (err) {
        // A failure to PREPARE provisioning must not un-approve a change the
        // client legitimately approved. Surfaced, not thrown.
        logger.error(`[approval] provisioning preparation failed client=${clientId} v${version}: ${err.message}`);
        provisioning = { ok: false, outcome: "bridge_failed", message: err.message };
      }
    }

    logger.log(`[approval] client=${clientId} v${version} approved channel=${sourceChannel} actor=${actor.type}`);

    return {
      ok: true,
      code: "approved",
      approvalServiceVersion: APPROVAL_SERVICE_VERSION,
      clientId,
      version,
      sourceChannel,
      actorType: actor.type,
      provisioning,
    };
  }

  /**
   * Can this draft be approved right now, and if not, why?
   *
   * Read-only. The portal calls it to decide whether to enable an approve
   * button; a voice agent would call it to decide whether it is even worth
   * reading a change back. Same answer for both.
   */
  async function checkApprovable({ clientId, version, actor, expectedUpdatedAt = null }) {
    let row;
    try {
      row = await storeApi.getVersion(clientId, version);
    } catch (err) {
      if (err && /not provisioned|unavailable/i.test(err.message || "")) {
        return { ok: false, refusalKind: "unavailable", blockers: [{ kind: "unavailable", code: "store_unavailable", message: "Configuration storage is not set up yet." }] };
      }
      throw err;
    }

    const verdict = storeApi.evaluateApproval({
      row,
      profile: row ? row.profile : null,
      confirmations: row ? row.confirmations : {},
      actor,
      expectedUpdatedAt,
    });

    return verdict.ok
      ? { ok: true, version, status: row.status, updatedAt: row.updated_at || null }
      : { ok: false, refusalKind: worstKind(verdict.blockers) || "content", blockers: verdict.blockers };
  }

  return { approve, checkApprovable, REFUSAL_KINDS, APPROVAL_SERVICE_VERSION };
}

function refuse(refusalKind, code, message) {
  return { ok: false, refusalKind, code, message, blockers: [{ kind: refusalKind, code, message }] };
}

/**
 * The one place that maps a refusal to an HTTP status. Handlers import this
 * rather than each inventing their own mapping — which is how two endpoints end
 * up disagreeing about whether a stale approval is a 409 or a 422.
 */
function statusForRefusal(refusalKind) {
  return { auth: 403, conflict: 409, state: 409, content: 422, unavailable: 503 }[refusalKind] || 422;
}

module.exports = {
  APPROVAL_SERVICE_VERSION,
  REFUSAL_KINDS,
  createApprovalService,
  statusForRefusal,
  worstKind,
};
