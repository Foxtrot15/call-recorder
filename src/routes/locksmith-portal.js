// AIDA — client portal routes (M5). Wiring only.
//
//   /client/locksmith                          the portal (HTML, tabbed)
//   /client/locksmith/change-requests          POST — ask for a change
//   /client/locksmith/notifications            POST — how you're told
//   /client/locksmith/forwarding/instructions  POST — dialling codes
//
// Every path is behind requireClientAuth, so req.clientId is always the
// verified session's client slug.
//
// Gate: without LOCKSMITH_PORTAL_ENABLED="true", next("router") exits before
// ANY auth or handler runs, so every path 404s exactly as if this file did not
// exist. That is the production state today.
//
// All behaviour lives in routes/locksmith-portal-handlers.js, which imports no
// express and is therefore testable without node_modules.

const express = require("express");
const router = express.Router();

const { locksmithPortalGate } = require("../config/locksmith");
const { requireClientAuth, requireLogin } = require("../middleware/auth");
const { createPortalHandlers } = require("./locksmith-portal-handlers");

const handlers = createPortalHandlers();

router.use(locksmithPortalGate());

// ── Client-authenticated portal ─────────────────────────────────────
router.get("/client/locksmith", requireClientAuth, handlers.portalPage);
router.post("/client/locksmith/change-requests", requireClientAuth, handlers.createChangeRequest);
router.post("/client/locksmith/notifications", requireClientAuth, handlers.saveNotificationPreferences);
router.post("/client/locksmith/forwarding/instructions", requireClientAuth, handlers.forwardingInstructions);

// ── Operator client-operations view ─────────────────────────────────
// Cross-tenant reads behind requireLogin. Deliberately GET-only: there is no
// operator path that approves a client's change or alters their receptionist.
router.get("/locksmith-founder/clients", requireLogin, handlers.founderClientList);
router.get("/locksmith-founder/clients/:clientId", requireLogin, handlers.founderClientDetail);

module.exports = router;
