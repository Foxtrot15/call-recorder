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
const { createSetupHandlers } = require("./locksmith-setup-handlers");

const handlers = createOnboardingHandlers();
const provisioning = createProvisioningHandlers();
const setup = createSetupHandlers();

router.use(onboardingRouterGate());

// ── Client-authenticated setup wizard (M8A) ─────────────────────────
// The locksmith describing their own business, step by step. Every write goes
// to a `status:"draft"` row and stops there: submission hands the draft to the
// review routes below, and approval stays where it always was. There is no path
// from this surface to a live configuration.
router.get("/client/locksmith-setup", requireClientAuth, setup.setupHome);
router.get("/client/locksmith-setup/review", requireClientAuth, setup.setupReview);
router.get("/client/locksmith-setup/history", requireClientAuth, setup.setupHistory);
router.get("/client/locksmith-setup/test", requireClientAuth, setup.setupTest);
router.get("/client/locksmith-setup/activate", requireClientAuth, setup.setupActivate);
// Declared after the fixed paths so "review"/"history"/"test"/"activate" can
// never be swallowed as a step id.
router.get("/client/locksmith-setup/step/:stepId", requireClientAuth, setup.setupStep);
router.post("/client/locksmith-setup/step/:stepId", requireClientAuth, setup.saveStep);
router.post("/client/locksmith-setup/submit", requireClientAuth, setup.submitSetup);
// Review and approval for a TYPED setup. Deliberately not routed through the M2
// review page below: that page is keyed on an onboarding SESSION, whose state
// machine requires a transcript and an extraction on the way to review, and
// inventing a fake transcript to satisfy it would corrupt every session row.
// Same store, same approval guard, same audit events — different page.
router.post("/client/locksmith-setup/confirm", requireClientAuth, setup.confirmSection);
// Takes a submitted version back for editing (needs_review → draft), clearing
// the confirmations it invalidates. Without it, spotting a typo on the review
// page would mean starting the whole setup again.
router.post("/client/locksmith-setup/reopen", requireClientAuth, setup.reopen);
router.post("/client/locksmith-setup/approve", requireClientAuth, setup.approve);
router.post("/client/locksmith-setup/rollback", requireClientAuth, setup.rollback);

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
