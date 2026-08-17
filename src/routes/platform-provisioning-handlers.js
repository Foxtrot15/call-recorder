// AIDA PLATFORM — provisioning HTTP handlers (P23). Behaviour only.
//
// Imports no express, so every handler is testable without node_modules.
//
// ── THERE IS NO EXECUTE ENDPOINT ────────────────────────────────────
// Not a disabled one, not a 501 placeholder. None. A route that exists and
// refuses is a route somebody eventually makes work in a hurry; a route that
// does not exist has to be written, reviewed and committed alongside an
// executor that satisfies the twelve preconditions in
// provisioning-execution-contract.js.
//
// GET .../execution-contract returns those preconditions as a DESCRIPTION.
// Reading a contract is not signing one.
//
// ── AND THE TENANT IS NEVER FROM THE URL ────────────────────────────
// Same rule as the configuration surface: `:clientId` says what the caller
// WANTS; authority comes from the session that src/middleware/auth.js already
// verified.

const { principalFromRequest } = require("../platform/config-access");
const { PROVISIONING_OUTCOMES } = require("../platform/provisioning-service");

const STATUS_FOR = Object.freeze({
  [PROVISIONING_OUTCOMES.OK]: 200,
  [PROVISIONING_OUTCOMES.FORBIDDEN]: 403,
  [PROVISIONING_OUTCOMES.NOT_FOUND]: 404,
  [PROVISIONING_OUTCOMES.INVALID]: 422,
  [PROVISIONING_OUTCOMES.CONFLICT]: 409,
  [PROVISIONING_OUTCOMES.UNAVAILABLE]: 503,
});

const SAFE_REFUSALS = Object.freeze({
  forbidden: "Not authorised for this client.",
  not_found: "Not found.",
});

const PLAN_ID = /^plan_[A-Za-z0-9_-]{1,58}$/;

/** Same shape as the configuration handlers — a fixed service, or a per-request resolver (P36). */
function createPlatformProvisioningHandlers({ service, serviceFor = null, logger = console } = {}) {
  if (!service && typeof serviceFor !== "function") {
    throw new Error("createPlatformProvisioningHandlers requires a provisioning service, or a serviceFor(req) resolver");
  }
  const resolve = (req) => (serviceFor ? serviceFor(req) : service);

  function begin(req, res) {
    const principal = principalFromRequest(req);
    const clientId = req.params && req.params.clientId;
    if (!principal) {
      res.status(403).json({ error: SAFE_REFUSALS.forbidden, code: "no_authenticated_principal" });
      return null;
    }
    if (!clientId) {
      res.status(404).json({ error: SAFE_REFUSALS.not_found });
      return null;
    }
    return { principal, clientId };
  }

  function reply(res, result, okStatus = 200) {
    if (result.ok) {
      const { ok: _ok, outcome: _outcome, ...body } = result;
      return res.status(okStatus).json(body);
    }
    const status = STATUS_FOR[result.outcome] || 400;
    const body = { error: SAFE_REFUSALS[result.outcome] || result.message, code: result.code };
    if (result.blockingReasons) body.blockingReasons = result.blockingReasons;
    if (result.errors) body.errors = result.errors;
    if ([PROVISIONING_OUTCOMES.CONFLICT, PROVISIONING_OUTCOMES.INVALID].includes(result.outcome)) body.error = result.message;
    if (result.outcome === PROVISIONING_OUTCOMES.UNAVAILABLE) body.error = "Provisioning store unavailable.";
    return res.status(status).json(body);
  }

  const guard = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      logger.error(`[platform-provisioning] ${name} failed: ${error && error.message}`);
      res.status(500).json({ error: "Provisioning request failed.", code: "handler_error" });
    }
  };

  const direction = (req) => (req.query && req.query.direction === "outbound" ? "outbound" : "inbound");
  const planId = (req, res) => {
    const id = req.params.planId;
    if (!PLAN_ID.test(String(id || ""))) {
      res.status(404).json({ error: SAFE_REFUSALS.not_found });
      return null;
    }
    return id;
  };

  return {
    getDiff: guard("getDiff", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      reply(res, await resolve(req).getDiff({ ...ctx, direction: direction(req) }));
    }),

    getDesiredPayloads: guard("getDesiredPayloads", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      reply(res, await resolve(req).getDesiredPayloads({ ...ctx, direction: direction(req) }));
    }),

    listPlans: guard("listPlans", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      reply(res, await resolve(req).listPlans(ctx));
    }),

    createPlan: guard("createPlan", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const notes = req.body && typeof req.body.notes === "string" ? req.body.notes.slice(0, 2000) : null;
      reply(res, await resolve(req).createPlan({ ...ctx, direction: direction(req), notes }), 201);
    }),

    getPlan: guard("getPlan", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const id = planId(req, res);
      if (!id) return;
      reply(res, await resolve(req).getPlan({ ...ctx, planId: id }));
    }),

    getPlanActions: guard("getPlanActions", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const id = planId(req, res);
      if (!id) return;
      const result = await resolve(req).getPlan({ ...ctx, planId: id });
      if (!result.ok) return reply(res, result);
      res.status(200).json({
        planId: result.plan.planId,
        status: result.plan.status,
        planHash: result.plan.planHash,
        actions: result.plan.actions,
        mutatingCount: result.plan.mutatingCount,
        staleness: result.staleness,
      });
    }),

    validatePlan: guard("validatePlan", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const id = planId(req, res);
      if (!id) return;
      reply(res, await resolve(req).validatePlan({ ...ctx, planId: id }));
    }),

    approvePlan: guard("approvePlan", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const id = planId(req, res);
      if (!id) return;
      const body = req.body || {};
      reply(res, await resolve(req).approvePlan({
        ...ctx,
        planId: id,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : null,
        // The reviewer states which plan they read. A mismatch is a 409.
        expectedPlanHash: typeof body.expectedPlanHash === "string" ? body.expectedPlanHash : null,
      }));
    }),

    cancelPlan: guard("cancelPlan", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const id = planId(req, res);
      if (!id) return;
      const reason = req.body && typeof req.body.reason === "string" ? req.body.reason.slice(0, 2000) : null;
      reply(res, await resolve(req).cancelPlan({ ...ctx, planId: id, reason }));
    }),

    readiness: guard("readiness", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const result = await resolve(req).readiness(ctx);
      if (!result.ok) return reply(res, result);
      // Restated at the boundary so a UI cannot present readiness as a
      // go-ahead without deliberately deleting the field.
      res.status(200).json({ ...result.readiness, isPermission: false });
    }),

    /** The future executor's preconditions. A description, not a door. */
    executionContract: guard("executionContract", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const result = resolve(req).executionContract(ctx);
      if (!result.ok) return reply(res, result);
      res.status(200).json({ ...result.contract, endpointExists: false });
    }),
  };
}

module.exports = { createPlatformProvisioningHandlers, STATUS_FOR, SAFE_REFUSALS, PLAN_ID };
