// AIDA Locksmith Receptionist — onboarding routes (M2). Wiring only.
//
// Two mounts, two different auth boundaries, both behind the same dormant flag:
//
//   /client/locksmith-onboarding/...   requireClientAuth — the locksmith
//                                      reviewing and approving their own
//                                      profile. req.clientId comes from the
//                                      verified session.
//   /locksmith-founder/...             requireLogin — the operator console.
//                                      Reads across tenants; cannot approve.
//
// Gate: without LOCKSMITH_ONBOARDING_ENABLED="true", next("router") exits
// before ANY auth or handler runs, so every path 404s exactly as if this file
// did not exist. That is the production state today.
//
// All behaviour lives in routes/locksmith-onboarding-handlers.js, which imports
// no express and is therefore testable without node_modules.

const express = require("express");
const router = express.Router();

const { onboardingRouterGate } = require("../config/locksmith-onboarding");
const { requireLogin, requireClientAuth } = require("../middleware/auth");
const { createOnboardingHandlers } = require("./locksmith-onboarding-handlers");
const { createProvisioningHandlers } = require("./locksmith-provisioning-handlers");

const handlers = createOnboardingHandlers();
const provisioning = createProvisioningHandlers();

router.use(onboardingRouterGate());

// ── Client-authenticated review + approval ──────────────────────────
router.get("/client/locksmith-onboarding/:sessionId/review", requireClientAuth, handlers.clientReviewPage);
router.post("/client/locksmith-onboarding/:sessionId/confirm", requireClientAuth, handlers.clientConfirmSection);
router.post("/client/locksmith-onboarding/:sessionId/note", requireClientAuth, handlers.clientSaveNote);
router.post("/client/locksmith-onboarding/:sessionId/approve", requireClientAuth, handlers.clientApprove);
router.post("/client/locksmith-onboarding/:sessionId/reject", requireClientAuth, handlers.clientReject);

// ── Operator console ────────────────────────────────────────────────
router.get("/locksmith-founder/sessions", requireLogin, handlers.founderList);
router.get("/locksmith-founder/sessions/:sessionId", requireLogin, handlers.founderSession);
router.post("/locksmith-founder/sessions/:sessionId/fail", requireLogin, handlers.founderFailSession);
router.post("/locksmith-founder/sessions/:sessionId/re-extract", requireLogin, handlers.founderRerunExtraction);
// The ONLY transcript ingestion path in M2, deliberately operator-only. The
// future Retell webhook is a separate, signature-verified route — it does not
// reuse this one (docs/LOCKSMITH_ONBOARDING_SPEC.md §6).
router.post("/locksmith-founder/sessions/:sessionId/transcript", requireLogin, handlers.founderSubmitTranscript);

// ── Provisioning preview (M3) ───────────────────────────────────────
// Read-only preview of what would be sent to Retell. The execution control is
// revealed only when every gate in evaluateExecutionGate passes, which cannot
// happen under the shipped configuration. Mock and dry-run paths contact
// nothing.
router.get("/locksmith-founder/provisioning/:clientId", requireLogin, provisioning.provisioningPage);
router.post("/locksmith-founder/provisioning/:clientId/dry-run", requireLogin, provisioning.dryRun);
router.post("/locksmith-founder/provisioning/:clientId/mock-execute", requireLogin, provisioning.mockExecute);

module.exports = router;
