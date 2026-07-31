// AIDA Locksmith Receptionist — public product route (M1).
//
//   GET  /locksmith-receptionist          → the public page (HTML)
//   POST /locksmith-receptionist/enquiry  → pilot enquiry (JSON in, JSON out)
//
// Public by design: no operator session, no client session, no tenant data.
// The page reads nothing but config + the demonstration dataset, so there is
// no tenant surface to leak, and nothing here touches the v1 missed-call
// pipeline (prime directive).
//
// Gating (src/config/locksmith.js): without LOCKSMITH_PILOT_ENABLED="true" the
// gate exits the router via next("router"), making both paths 404 exactly as if
// this file did not exist — the dormant default. LOCKSMITH_ENQUIRY_ENABLED
// gates submissions separately and is likewise off unless explicitly "true";
// M1 ships no persistence sink, so POST answers a truthful 503 rather than
// pretending to have saved anything.
//
// Wiring only. All behaviour lives in routes/locksmith-handlers.js, which
// imports no express and is therefore testable without node_modules.

const express = require("express");
const router = express.Router();

const { locksmithRouterGate } = require("../config/locksmith");
const { createLocksmithHandlers } = require("./locksmith-handlers");

const handlers = createLocksmithHandlers();

router.use(locksmithRouterGate());
router.get("/locksmith-receptionist", handlers.page);
router.post("/locksmith-receptionist/enquiry", handlers.enquiry);

module.exports = router;
