// AIDA PLATFORM — configuration API routes (P17). Wiring only.
//
//   GET    /api/clients/:clientId/config/active
//   GET    /api/clients/:clientId/config/versions
//   GET    /api/clients/:clientId/config/versions/:versionId
//   GET    /api/clients/:clientId/config/versions/:versionId/diff
//   GET    /api/clients/:clientId/config/history
//   GET    /api/clients/:clientId/config/preview/:versionId      ("active" allowed)
//
//   POST   /api/clients/:clientId/config/drafts
//   PATCH  /api/clients/:clientId/config/drafts/:versionId
//   POST   /api/clients/:clientId/config/drafts/:versionId/validate
//   POST   /api/clients/:clientId/config/drafts/:versionId/approve
//   POST   /api/clients/:clientId/config/versions/:versionId/activate
//   POST   /api/clients/:clientId/config/versions/:versionId/restore
//   POST   /api/clients/:clientId/config/proposals
//
// ── THE GATE ────────────────────────────────────────────────────────
// Without PLATFORM_CONFIG_API_ENABLED="true" — the exact string, the D7 house
// rule, so a sloppy env value can never switch it on — next("router") exits
// before ANY auth or handler runs and every path 404s exactly as if this file
// did not exist. That is the production state today, and it is why mounting
// this changes nothing until somebody decides otherwise.
//
// ── AUTHENTICATION ──────────────────────────────────────────────────
// Every path is behind requireClientAuth or requireLogin, so req.clientId is
// always a verified session's slug resolved server-side. The :clientId in the
// URL is what the caller WANTS; config-access decides whether they may have
// it. See platform-config-handlers.js.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────
// Provisioning routes PLAN and PREVIEW (P23); none of them performs anything.
// There is no execute route — not a disabled one, absent — no calling route,
// no dial, no number, no SMS and no webhook egress. Nothing this file or its
// handlers import could reach one, and ratchets assert it.
//
// All behaviour lives in routes/platform-config-handlers.js and
// routes/platform-provisioning-handlers.js, neither of which imports express,
// so both are testable without node_modules.

const express = require("express");
const router = express.Router();

const { requireClientAuth, requireLogin } = require("../middleware/auth");
const { createPlatformConfigHandlers } = require("./platform-config-handlers");
const { createPlatformProvisioningHandlers } = require("./platform-provisioning-handlers");
const { platformStoreGate } = require("./platform-store");

/** Exact-string parse. Anything else — "TRUE", "1", "yes", unset — is off. */
function platformConfigApiEnabled(env = process.env) {
  return env.PLATFORM_CONFIG_API_ENABLED === "true";
}

function platformConfigGate(env = process.env) {
  return function gate(req, res, next) {
    if (!platformConfigApiEnabled(env)) return next("router");
    return next();
  };
}

router.use(platformConfigGate());

// ── THE STORE (P36) ─────────────────────────────────────────────────
// Chosen by PLATFORM_CONFIG_STORE, resolved on the first request, and memoised.
// ACP1 was applied to DEV on 2026-08-17, so postgres is now a real option — but
// it is never the default and never inferred. If postgres is requested and ACP1
// readiness cannot be proven, every path answers 503 and NOTHING falls back to
// memory: a configuration API serving from an empty in-memory store because the
// database was unreachable is one that tells a business it has no services.
router.use(platformStoreGate());

// Handlers take their service per request, from req.platform.
const handlers = createPlatformConfigHandlers({ serviceFor: (req) => req.platform.configService });
const provisioning = createPlatformProvisioningHandlers({ serviceFor: (req) => req.platform.provisioningService });

const BASE = "/api/clients/:clientId/config";

// ── Reads ───────────────────────────────────────────────────────────
router.get(`${BASE}/active`, requireClientAuth, handlers.getActive);
router.get(`${BASE}/versions`, requireClientAuth, handlers.listVersions);
router.get(`${BASE}/versions/:versionId`, requireClientAuth, handlers.getVersion);
router.get(`${BASE}/versions/:versionId/diff`, requireClientAuth, handlers.diff);
router.get(`${BASE}/history`, requireClientAuth, handlers.history);
router.get(`${BASE}/preview/:versionId`, requireClientAuth, handlers.preview);

// ── Drafting ────────────────────────────────────────────────────────
router.post(`${BASE}/drafts`, requireClientAuth, handlers.createDraft);
router.patch(`${BASE}/drafts/:versionId`, requireClientAuth, handlers.updateDraft);
router.post(`${BASE}/drafts/:versionId/validate`, requireClientAuth, handlers.validate);
router.post(`${BASE}/drafts/:versionId/approve`, requireClientAuth, handlers.approve);

// ── Proposals (the future voice configurator's entry point) ─────────
router.post(`${BASE}/proposals`, requireClientAuth, handlers.proposePatch);

// ── Activation — OPERATOR ONLY, and it deploys nothing ──────────────
// Behind requireLogin rather than requireClientAuth: putting a configuration
// live is the moment a business's telephone starts being answered differently,
// and config-access only grants config:activate to the operator role.
router.post(`${BASE}/versions/:versionId/activate`, requireLogin, handlers.activate);
router.post(`${BASE}/versions/:versionId/restore`, requireLogin, handlers.restore);

// ── Provisioning: plan and preview, never perform ───────────────────
// Reads are open to any client session for their own configuration; building,
// validating and approving a plan need the operator, because they describe
// changes to resources AIDA owns and pays for at a provider.
router.get(`${BASE}/provisioning/diff`, requireClientAuth, provisioning.getDiff);
router.get(`${BASE}/provisioning/desired`, requireClientAuth, provisioning.getDesiredPayloads);
router.get(`${BASE}/provisioning/plans`, requireClientAuth, provisioning.listPlans);
router.get(`${BASE}/provisioning/plans/:planId`, requireClientAuth, provisioning.getPlan);
router.get(`${BASE}/provisioning/plans/:planId/actions`, requireClientAuth, provisioning.getPlanActions);
router.get(`${BASE}/provisioning/readiness`, requireClientAuth, provisioning.readiness);
router.get(`${BASE}/provisioning/execution-contract`, requireClientAuth, provisioning.executionContract);

router.post(`${BASE}/provisioning/plans`, requireLogin, provisioning.createPlan);
router.post(`${BASE}/provisioning/plans/:planId/validate`, requireLogin, provisioning.validatePlan);
router.post(`${BASE}/provisioning/plans/:planId/approve`, requireLogin, provisioning.approvePlan);
router.post(`${BASE}/provisioning/plans/:planId/cancel`, requireLogin, provisioning.cancelPlan);

// THERE IS NO EXECUTE ROUTE. Not disabled — absent. Adding one is a decision
// somebody makes in a commit, alongside an executor that satisfies the twelve
// preconditions in src/platform/provisioning-execution-contract.js.

module.exports = router;
module.exports.platformConfigApiEnabled = platformConfigApiEnabled;
module.exports.platformConfigGate = platformConfigGate;
