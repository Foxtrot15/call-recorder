// AIDA — client billing routes (M6). Wiring only.
//
//   GET  /client/locksmith/billing                 the billing page
//   POST /client/locksmith/billing/portal-session  open Stripe's hosted portal
//   POST /client/locksmith/billing/plan            change plan
//
// Every path is behind requireClientAuth, so req.clientId is the verified
// session's client slug.
//
// Dormant: without BILLING_ENABLED="true", next("router") exits before any auth
// or handler runs and every path 404s exactly as if this file did not exist.
// That is the production state today, and it is the state in which no card can
// be charged because no route exists to charge it from.
//
// All behaviour lives in routes/billing-handlers.js, which imports no express.

const express = require("express");
const router = express.Router();

const { billingRouterGate } = require("../config/billing");
const { requireClientAuth } = require("../middleware/auth");
const { createBillingHandlers } = require("./billing-handlers");

const handlers = createBillingHandlers();

router.use(billingRouterGate());

router.get("/client/locksmith/billing", requireClientAuth, handlers.billingPage);
router.post("/client/locksmith/billing/portal-session", requireClientAuth, handlers.portalSession);
router.post("/client/locksmith/billing/plan", requireClientAuth, handlers.changePlan);

module.exports = router;
