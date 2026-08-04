// AIDA Locksmith Receptionist — setup wizard handlers (M8A).
//
// Express-free and injectable, the locksmith-onboarding-handlers.js precedent,
// so the whole surface is testable on a bare checkout with fake req/res.
//
// ─── TENANT KEY ─────────────────────────────────────────────────────
// req.clientId comes from the verified client session and is the ONLY tenant key
// used anywhere in this file. Nothing reads a client id from the body, the query
// or the path — there is no parameter here that could carry one.
//
// ─── CSRF ───────────────────────────────────────────────────────────
// The repo's posture: httpOnly + SameSite=Lax session cookies with JSON-only
// state-changing endpoints, asserted at the route rather than assumed from the
// cookie flag. A cross-site form POST cannot set Content-Type: application/json
// without a CORS preflight, and Lax withholds the cookie on cross-site POSTs
// anyway. That is why the wizard's <form> is submitted by fetch as JSON rather
// than as a normal form post: a form post would have to be accepted as
// urlencoded, which would forfeit exactly that protection.
//
// ─── WHAT THIS SURFACE CANNOT DO ────────────────────────────────────
// It cannot approve, and it cannot write to anything that is not a `draft` row.
// Approval stays on the M2 review routes, behind per-section confirmation and
// the existing approval guard. Activation is not implemented as an action at
// all — the page states the gates and stops, because switching a real business's
// phone over is not a thing a web button should do unattended.

const { getOnboardingConfig } = require("../config/locksmith-onboarding");
const steps = require("../services/locksmith-onboarding-steps");
const draftService = require("../services/locksmith-onboarding-draft");
const store = require("../services/locksmith-profile-store");
const testPlan = require("../services/locksmith-test-plan");
const readModel = require("../services/locksmith-portal-readmodel");
const views = require("../views/locksmith-setup-page");
const { createRateLimiter } = require("../services/rate-limit");

const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // These pages carry a business's full operating configuration, its owner's
  // contact details and its private transfer number. They must never sit in a
  // shared or browser cache.
  "Cache-Control": "no-store, private",
});

const ACTION_LIMIT = 120;
const ACTION_WINDOW_MS = 5 * 60 * 1000;
const PRUNE_EVERY = 100;

function isJsonRequest(req) {
  const type = (req.headers && (req.headers["content-type"] || req.headers["Content-Type"])) || "";
  return String(type).toLowerCase().includes("application/json");
}

/**
 * Map a service outcome to an HTTP status.
 *
 * Kept as one table so a new outcome cannot quietly default to 500 and look
 * like a server fault when it is really a refusal the client can act on.
 */
const STATUS_FOR_OUTCOME = Object.freeze({
  not_authorised: 403,
  unknown_step: 404,
  no_draft: 409,
  stale_draft: 409,
  incomplete: 422,
  bad_version: 404,
  invalid_answers: 422,
  store_unavailable: 503,
});

function statusFor(outcome) {
  return steps.lookup(STATUS_FOR_OUTCOME, outcome) || 400;
}

function createSetupHandlers(deps = {}) {
  const service = deps.service || draftService.createOnboardingDraftService({ store: deps.store || store, logger: deps.logger || console });
  const storeApi = deps.store || store;
  const render = deps.views || views;
  const plans = deps.testPlan || testPlan;
  const rm = deps.readModel || readModel;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const config = deps.config || getOnboardingConfig(env);
  const limiter = deps.limiter || createRateLimiter({ limit: ACTION_LIMIT, windowMs: ACTION_WINDOW_MS });
  let sincePrune = 0;

  function rateLimited(req, res) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    if ((sincePrune += 1) >= PRUNE_EVERY) {
      sincePrune = 0;
      limiter.prune();
    }
    if (limiter.check(key).allowed) return false;
    res.status(429).json({ ok: false, code: "rate_limited", message: "Too many requests. Wait a moment and try again." });
    return true;
  }

  function requireJson(req, res) {
    if (isJsonRequest(req)) return true;
    res.status(415).json({ ok: false, code: "unsupported_media_type", message: "Send this request as application/json." });
    return false;
  }

  function actorFor(req) {
    return {
      type: "client",
      id: (req.clientAuth && req.clientAuth.user && req.clientAuth.user.id) || null,
      clientId: req.clientId,
    };
  }

  function sendPage(res, html) {
    res.set(PAGE_SECURITY_HEADERS);
    res.type("html");
    return res.status(200).send(html);
  }

  /**
   * A page-level failure must not leave a locksmith staring at a blank screen
   * with no idea whether their answers survived. Every message here says what
   * happened to their data.
   */
  function pageError(res, message) {
    res.set(PAGE_SECURITY_HEADERS);
    res.type("html");
    return res.status(503).send(
      `<!DOCTYPE html><html lang="en-AU"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup unavailable</title><link rel="stylesheet" href="/locksmith/setup.css"></head><body class="setup"><main class="setup-main"><h1>Setup isn't available right now</h1><p>${escapeText(message)}</p><p>Nothing you've already saved has been lost.</p></main></body></html>`
    );
  }

  function escapeText(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  /**
   * Load the working draft, starting one if the client has never begun.
   *
   * `startDraft` reports a version already handed over for review rather than
   * forking a second one, and the caller sends that client to the review page —
   * editing is not available while a version is being reviewed, and pretending
   * otherwise is how answers get lost.
   */
  async function ensureDraft(req) {
    const loaded = await service.loadDraft({ clientId: req.clientId });
    if (loaded.ok) return loaded;
    if (loaded.outcome === draftService.OUTCOMES.noDraft) {
      return service.startDraft({ clientId: req.clientId, actor: actorFor(req), sourceChannel: "client_ui" });
    }
    return loaded;
  }

  function redirectToReview(res) {
    res.set(PAGE_SECURITY_HEADERS);
    res.set({ Location: "/client/locksmith-setup/review" });
    return res.status(303).send("");
  }

  // ── GET /client/locksmith-setup ───────────────────────────────────

  async function setupHome(req, res) {
    try {
      const draft = await ensureDraft(req);
      if (!draft.ok) return pageError(res, draft.message);
      if (draft.submitted) return redirectToReview(res);

      // Shown so an existing client understands their live receptionist is
      // untouched while they edit — the single most common worry at this point.
      let approved = null;
      try {
        approved = await storeApi.getApprovedVersion(req.clientId);
      } catch (err) {
        logger.error(`[setup] approved lookup failed for ${req.clientId}: ${err.message}`);
      }

      return sendPage(
        res,
        render.renderSetupHome({
          progress: draft.progress,
          version: draft.version,
          updatedAt: draft.updatedAt,
          hasApproved: Boolean(approved),
          approvedVersion: approved ? approved.version : null,
        })
      );
    } catch (err) {
      logger.error(`[setup] home failed for ${req.clientId}: ${err.message}`);
      return pageError(res, "We couldn't load your setup. Please try again in a moment.");
    }
  }

  // ── GET /client/locksmith-setup/step/:stepId ──────────────────────

  async function setupStep(req, res) {
    const stepId = req.params && req.params.stepId;
    const step = steps.getStep(stepId);
    if (!step) return pageError(res, "That isn't a setup step.");

    try {
      const draft = await ensureDraft(req);
      if (!draft.ok) return pageError(res, draft.message);
      // A version under review is frozen. Editing resumes only through the
      // explicit "change something" action on the review page, which clears the
      // confirmations it invalidates.
      if (draft.submitted) return redirectToReview(res);

      return sendPage(
        res,
        render.renderSetupStep({
          step,
          answers: steps.readStep(step.id, draft.profile),
          errors: {},
          progress: draft.progress,
          version: draft.version,
          updatedAt: draft.updatedAt,
        })
      );
    } catch (err) {
      logger.error(`[setup] step ${stepId} failed for ${req.clientId}: ${err.message}`);
      return pageError(res, "We couldn't load that step. Please try again in a moment.");
    }
  }

  // ── POST /client/locksmith-setup/step/:stepId ─────────────────────

  async function saveStep(req, res) {
    if (!requireJson(req, res)) return undefined;
    if (rateLimited(req, res)) return undefined;

    const stepId = req.params && req.params.stepId;
    const body = req.body || {};

    try {
      const result = await service.saveStep({
        clientId: req.clientId,
        stepId,
        answers: body.answers,
        actor: actorFor(req),
        sourceChannel: "client_ui",
        expectedUpdatedAt: body.expectedUpdatedAt || null,
        // "Save and finish later" parks whatever is there. The distinction is
        // the client's to make, and it is safe either way: an incomplete draft
        // cannot be submitted, reviewed or approved.
        allowIncomplete: body.allowIncomplete === true,
      });

      if (!result.ok) {
        return res.status(statusFor(result.outcome)).json({
          ok: false,
          code: result.outcome,
          message: result.message,
          errors: result.errors || {},
        });
      }

      return res.status(200).json({
        ok: true,
        code: "saved",
        stepId: result.stepId,
        nextStepId: result.nextStepId,
        updatedAt: result.updatedAt,
        progress: result.progress,
      });
    } catch (err) {
      logger.error(`[setup] save ${stepId} failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ ok: false, code: "error", message: "We couldn't save that. Nothing was changed." });
    }
  }

  // ── GET /client/locksmith-setup/review ────────────────────────────

  async function setupReview(req, res) {
    try {
      const view = await service.loadForReview({ clientId: req.clientId });
      if (!view.ok) return pageError(res, view.message);

      return sendPage(
        res,
        render.renderSetupReview({
          summary: draftService.buildReviewSummary(view.profile),
          version: view.version,
          updatedAt: view.updatedAt,
          submitted: view.submitted,
          status: view.status,
          confirmations: view.confirmations,
          outstandingConfirmations: view.outstandingConfirmations,
        })
      );
    } catch (err) {
      logger.error(`[setup] review failed for ${req.clientId}: ${err.message}`);
      return pageError(res, "We couldn't load your review. Please try again in a moment.");
    }
  }

  // ── POST /client/locksmith-setup/confirm ──────────────────────────

  async function confirmSection(req, res) {
    if (!requireJson(req, res)) return undefined;
    if (rateLimited(req, res)) return undefined;

    const body = req.body || {};
    try {
      const result = await service.confirmSection({
        clientId: req.clientId,
        section: body.section,
        actor: actorFor(req),
        expectedUpdatedAt: body.expectedUpdatedAt || null,
      });
      if (!result.ok) {
        return res.status(statusFor(result.outcome)).json({ ok: false, code: result.outcome, message: result.message });
      }
      return res.status(200).json({
        ok: true,
        code: "confirmed",
        section: result.section,
        outstanding: result.outstandingConfirmations,
        updatedAt: result.updatedAt,
      });
    } catch (err) {
      logger.error(`[setup] confirm failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ ok: false, code: "error", message: "We couldn't record that. Nothing was changed." });
    }
  }

  // ── POST /client/locksmith-setup/approve ──────────────────────────

  async function approve(req, res) {
    if (!requireJson(req, res)) return undefined;
    if (rateLimited(req, res)) return undefined;

    const body = req.body || {};
    try {
      const result = await service.approve({
        clientId: req.clientId,
        actor: actorFor(req),
        reason: typeof body.reason === "string" ? body.reason.slice(0, 1000) : null,
        expectedUpdatedAt: body.expectedUpdatedAt || null,
      });

      if (!result.ok) {
        // Worst kind wins the status code, the M2 convention: auth beats
        // conflict beats state beats content, so the client sees the most
        // actionable failure rather than the first one.
        const kinds = (result.blockers || []).map((b) => b.kind);
        const status = kinds.includes("auth") ? 403 : kinds.includes("conflict") || kinds.includes("state") ? 409 : result.blockers ? 422 : statusFor(result.outcome);
        return res.status(status).json({ ok: false, code: "approval_refused", message: result.message, blockers: result.blockers || [] });
      }

      return res.status(200).json({
        ok: true,
        code: "approved",
        version: result.version,
        activated: false,
        message: "Approved. These settings are now the ones we'd build from — your phone isn't switched over yet.",
      });
    } catch (err) {
      logger.error(`[setup] approve failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ ok: false, code: "error", message: "We couldn't record your approval. Nothing was changed." });
    }
  }

  // ── POST /client/locksmith-setup/submit ───────────────────────────

  async function submitSetup(req, res) {
    if (!requireJson(req, res)) return undefined;
    if (rateLimited(req, res)) return undefined;

    const body = req.body || {};
    try {
      const result = await service.submitForReview({
        clientId: req.clientId,
        actor: actorFor(req),
        sourceChannel: "client_ui",
        expectedUpdatedAt: body.expectedUpdatedAt || null,
      });

      if (!result.ok) {
        return res.status(statusFor(result.outcome)).json({
          ok: false,
          code: result.outcome,
          message: result.message,
          outstanding: result.outstanding || [],
        });
      }

      return res.status(200).json({ ok: true, code: "submitted", version: result.version });
    } catch (err) {
      logger.error(`[setup] submit failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ ok: false, code: "error", message: "We couldn't send that for approval. Nothing was changed." });
    }
  }

  // ── POST /client/locksmith-setup/reopen ───────────────────────────

  async function reopen(req, res) {
    if (!requireJson(req, res)) return undefined;
    if (rateLimited(req, res)) return undefined;

    try {
      const result = await service.reopenForEditing({ clientId: req.clientId, actor: actorFor(req), sourceChannel: "client_ui" });
      if (!result.ok) {
        return res.status(statusFor(result.outcome)).json({ ok: false, code: result.outcome, message: result.message });
      }
      return res.status(200).json({
        ok: true,
        code: "reopened",
        version: result.version,
        message: result.reopened
          ? "Your answers are editable again. Anything you'd already checked has been unticked, so you'll read it back once more before approving."
          : "Your setup is already open for editing.",
      });
    } catch (err) {
      logger.error(`[setup] reopen failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ ok: false, code: "error", message: "We couldn't reopen that. Nothing was changed." });
    }
  }

  // ── GET /client/locksmith-setup/history ───────────────────────────

  async function setupHistory(req, res) {
    try {
      const history = await service.listHistory({ clientId: req.clientId });
      if (!history.ok) return pageError(res, history.message);
      const draft = await service.loadDraft({ clientId: req.clientId });
      return sendPage(
        res,
        render.renderSetupHistory({
          versions: history.versions,
          progress: draft.ok ? draft.progress : null,
        })
      );
    } catch (err) {
      logger.error(`[setup] history failed for ${req.clientId}: ${err.message}`);
      return pageError(res, "We couldn't load your version history. Please try again in a moment.");
    }
  }

  // ── POST /client/locksmith-setup/rollback ─────────────────────────

  async function rollback(req, res) {
    if (!requireJson(req, res)) return undefined;
    if (rateLimited(req, res)) return undefined;

    const body = req.body || {};
    try {
      const result = await service.rollbackToVersion({
        clientId: req.clientId,
        version: body.version,
        actor: actorFor(req),
        sourceChannel: "client_ui",
        reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
      });

      if (!result.ok) {
        return res.status(statusFor(result.outcome)).json({
          ok: false,
          code: result.outcome,
          message: result.message,
          workingDraftVersion: result.workingDraftVersion || null,
        });
      }

      return res.status(200).json({
        ok: true,
        code: "restored",
        restoredFromVersion: result.restoredFromVersion,
        version: result.version,
        // Said explicitly so nobody reads "restored" as "live again".
        message: "Those settings are back in your setup as a new draft. Read them over and approve them when you're happy.",
      });
    } catch (err) {
      logger.error(`[setup] rollback failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ ok: false, code: "error", message: "We couldn't restore that version. Nothing was changed." });
    }
  }

  // ── GET /client/locksmith-setup/test ──────────────────────────────

  async function setupTest(req, res) {
    try {
      let approved = null;
      try {
        approved = await storeApi.getApprovedVersion(req.clientId);
      } catch (err) {
        logger.error(`[setup] approved lookup failed for ${req.clientId}: ${err.message}`);
      }

      const draft = await service.loadDraft({ clientId: req.clientId });
      const progress = draft.ok ? draft.progress : null;

      // The checklist is generated from the APPROVED profile only. Generating it
      // from a draft would produce a list of things to check about settings that
      // do not exist yet.
      const plan = approved ? plans.generateTestPlan({ profile: approved.profile, profileVersion: approved.version, clientId: req.clientId }) : null;

      // Truthful by construction: there is no test-result store yet, so the
      // status is computed from an empty result set and reports exactly that
      // rather than implying a pass.
      const testStatus = rm.projectTestStatus([], { profileVersion: approved ? approved.version : null });

      return sendPage(
        res,
        render.renderSetupTest({
          plan,
          testStatus,
          profileVersion: approved ? approved.version : null,
          progress,
          canTest: Boolean(approved),
          blockers: approved ? [] : ["Your settings haven't been approved yet. Finish setup, read it back, and approve it first."],
        })
      );
    } catch (err) {
      logger.error(`[setup] test page failed for ${req.clientId}: ${err.message}`);
      return pageError(res, "We couldn't load your test checklist. Please try again in a moment.");
    }
  }

  // ── GET /client/locksmith-setup/activate ──────────────────────────
  //
  // A page, not an action. It lists what still has to happen and stops. There is
  // deliberately no route that switches a real business's phone over: that is
  // arranged with a person, on a call, with the owner listening.

  async function setupActivate(req, res) {
    try {
      let approved = null;
      try {
        approved = await storeApi.getApprovedVersion(req.clientId);
      } catch (err) {
        logger.error(`[setup] approved lookup failed for ${req.clientId}: ${err.message}`);
      }

      const draft = await service.loadDraft({ clientId: req.clientId });
      const progress = draft.ok ? draft.progress : null;
      const blockers = [];

      if (draft.ok && !draft.progress.allComplete) {
        blockers.push({
          label: "Finish your answers",
          detail: `${draft.progress.total - draft.progress.complete} step(s) still to answer.`,
          stepId: draft.progress.nextIncomplete,
        });
      }

      if (!approved) {
        blockers.push({ label: "Approve your settings", detail: "You haven't approved a version yet. Nothing can be built until you do.", stepId: null });
      } else {
        const summary = draftService.buildReviewSummary(approved.profile);
        for (const blocker of summary.blockers) {
          blockers.push({ label: "Something in your settings", detail: blocker.message, stepId: blocker.stepId || null });
        }
      }

      // Stated plainly, because a customer who thinks they are live and is not
      // has already lost the job. It is a NEXT STEP rather than a blocker: it is
      // our work, not theirs, and listing it as a blocker would leave the list
      // permanently non-empty and the page permanently saying "not ready yet"
      // to a client who had done everything asked of them.
      const nextSteps = [
        {
          label: "Your phone number",
          detail: "Your number is switched over with us on a short call. We'll book that in once everything above is clear.",
        },
        {
          label: "A test call first",
          detail: "We ring your receptionist together and work through the checklist before any customer does.",
        },
      ];

      return sendPage(res, render.renderSetupActivate({ readiness: { approved: Boolean(approved) }, progress, blockers, nextSteps }));
    } catch (err) {
      logger.error(`[setup] activate page failed for ${req.clientId}: ${err.message}`);
      return pageError(res, "We couldn't load your go-live checklist. Please try again in a moment.");
    }
  }

  return {
    setupHome,
    setupStep,
    saveStep,
    setupReview,
    submitSetup,
    confirmSection,
    reopen,
    approve,
    setupHistory,
    rollback,
    setupTest,
    setupActivate,
    config,
  };
}

module.exports = { createSetupHandlers, PAGE_SECURITY_HEADERS, ACTION_LIMIT, ACTION_WINDOW_MS, isJsonRequest, statusFor, STATUS_FOR_OUTCOME };
