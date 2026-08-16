// AIDA PLATFORM UI — routes (P29-P35). Wiring only.
//
//   GET   /platform/clients/:clientId
//   GET   /platform/clients/:clientId/history
//   GET   /platform/clients/:clientId/versions/:versionId
//   GET   /platform/clients/:clientId/edit                    (first section)
//   GET   /platform/clients/:clientId/edit/:section
//   PATCH /platform/clients/:clientId/drafts/:versionId
//   POST  /platform/clients/:clientId/drafts/:versionId/validate
//   GET   /platform/clients/:clientId/review
//   POST  /platform/clients/:clientId/approve
//   GET   /platform/clients/:clientId/activate
//   POST  /platform/clients/:clientId/activate
//   POST  /platform/clients/:clientId/versions/:versionId/restore
//   GET   /platform/clients/:clientId/preview
//   GET   /platform/clients/:clientId/preview/provider
//   GET   /platform/clients/:clientId/provisioning
//   POST  /platform/clients/:clientId/provisioning/plans
//   POST  /platform/clients/:clientId/provisioning/plans/:planId/approve
//   GET   /platform/clients/:clientId/wizard
//   POST  /platform/clients/:clientId/wizard/start
//
// ── THE SAME GATE AS THE JSON SURFACE ───────────────────────────────
// Without PLATFORM_CONFIG_API_ENABLED="true" — the exact string — next("router")
// exits before any auth or handler runs, and every path 404s exactly as if this
// file did not exist. Mounting it changes nothing until somebody decides
// otherwise, and it is the SAME flag as the JSON API on purpose: a UI that
// could be switched on while the API it calls is off is a UI that shows a
// person an empty screen and no reason.
//
// ── AUTHENTICATION ──────────────────────────────────────────────────
// Reads and drafting are behind requireClientAuth. Activation, restore and
// everything provisioning are behind requireLogin, matching the JSON surface
// exactly — because putting a configuration live, and describing changes to
// resources AIDA pays a provider for, are operator decisions.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────
// No execute route. Not a disabled one — absent, as in platform-config.js.
// No provisioning of numbers, no dial, no SMS, no calling state, no webhook
// egress, and no route that could reach one.

const express = require("express");
const router = express.Router();

const { requireClientAuth, requireLogin } = require("../middleware/auth");
const { createPlatformUiHandlers } = require("./platform-ui-handlers");
const { createConfigService } = require("../platform/config-service");
const { createProvisioningService } = require("../platform/provisioning-service");
const { createInMemoryBlueprintStore } = require("../platform/blueprint-authority");
const { createInMemoryPlanStore } = require("../platform/provisioning-plan-authority");

/** Exact-string parse, the D7 house rule. "TRUE", "1", "yes" and unset are all off. */
function platformUiEnabled(env = process.env) {
  return env.PLATFORM_CONFIG_API_ENABLED === "true";
}

function platformUiGate(env = process.env) {
  return function gate(req, res, next) {
    if (!platformUiEnabled(env)) return next("router");
    return next();
  };
}

router.use(platformUiGate());

// The same in-memory stores as the JSON surface, and for the same reason: ACP1
// has been applied to no database, so binding this to Postgres would be binding
// it to tables that do not exist.
const configService = createConfigService({
  store: createInMemoryBlueprintStore(),
  now: () => new Date(),
});
const provisioningService = createProvisioningService({
  configService,
  planStore: createInMemoryPlanStore(),
  now: () => new Date(),
  providerRefs: {},   // deployment facts are injected, never invented
});

const h = createPlatformUiHandlers({ configService, provisioningService });

const BASE = "/platform/clients/:clientId";

// ── the static assets ───────────────────────────────────────────────
// Served by express.static from public/, so nothing is needed here. The
// stylesheet and the enhancement script are same-origin, which is what the
// page CSP requires.

// ── reads and drafting: any authenticated client session ────────────
router.get(BASE, requireClientAuth, h.dashboard);
router.get(`${BASE}/history`, requireClientAuth, h.history);
router.get(`${BASE}/wizard`, requireClientAuth, h.wizard);
router.get(`${BASE}/edit`, requireClientAuth, h.editor);
router.get(`${BASE}/edit/:section`, requireClientAuth, h.editor);
router.get(`${BASE}/review`, requireClientAuth, h.review);
router.get(`${BASE}/preview`, requireClientAuth, h.behaviourPreview);
router.get(`${BASE}/preview/provider`, requireClientAuth, h.providerPreview);
router.get(`${BASE}/provisioning`, requireClientAuth, h.provisioning);

router.patch(`${BASE}/drafts/:versionId`, requireClientAuth, h.saveSection);
router.post(`${BASE}/drafts/:versionId/validate`, requireClientAuth, h.validateDraft);
router.post(`${BASE}/approve`, requireClientAuth, h.approve);
router.post(`${BASE}/wizard/start`, requireClientAuth, h.startWizard);

// ── operator only: putting a configuration live, and provisioning ───
router.get(`${BASE}/activate`, requireLogin, h.activatePage);
router.post(`${BASE}/activate`, requireLogin, h.activate);
router.post(`${BASE}/versions/:versionId/restore`, requireLogin, h.restore);
router.post(`${BASE}/provisioning/plans`, requireLogin, h.createPlan);
router.post(`${BASE}/provisioning/plans/:planId/approve`, requireLogin, h.approvePlan);

// THERE IS NO EXECUTE ROUTE, AND NO BUTTON THAT WOULD CALL ONE.

module.exports = router;
module.exports.platformUiEnabled = platformUiEnabled;
module.exports.platformUiGate = platformUiGate;
