// VoIP v2 — Phase 0 placeholder routes. NOT the implementation.
//
// Reserves the route surface specified in docs/VOIP_V2_BACKEND_SPEC.md §5 so
// Phase 1 lands into paths that are already claimed, tested, and gated.
//
// Behaviour contract (decision D7, two-level gating — server flag here):
//   VOIP_V2_ENABLED !== "true"  → next() — Express falls through to its
//                                 default 404, byte-identical to a server
//                                 without this file. VoIP is invisible.
//   VOIP_V2_ENABLED === "true"  → 501 Not Implemented with a JSON body
//                                 pointing at the spec. No auth is attached
//                                 yet BECAUSE nothing is served: a 501 with a
//                                 static body is safe unauthenticated, and
//                                 wiring real auth belongs to Phase 1 with
//                                 the real handlers (client session vs Twilio
//                                 signature differ per route — see spec §5).
//
// No handler here may ever grow logic. Phase 1 replaces this file's mounts
// route-by-route; anything still hitting a 501 is by definition unfinished.

const express = require("express");
const router = express.Router();
const { isVoipV2Enabled } = require("../config/voip");

// The exact route surface from VOIP_V2_BACKEND_SPEC.md §5.
const PLACEHOLDER_ROUTES = [
  { method: "post", path: "/voice/token" },
  { method: "post", path: "/devices/register" },
  { method: "post", path: "/devices/revoke" },
  { method: "get",  path: "/devices" },
  { method: "post", path: "/voip/dial-result" },
  { method: "post", path: "/voip/call-status" },
  { method: "post", path: "/voip/push-ack" },
];

function notImplemented(req, res, next) {
  if (!isVoipV2Enabled()) return next(); // disabled: identical to no route existing
  res.status(501).json({
    error: "Not Implemented",
    feature: "voip-v2",
    phase: 0,
    detail: "VoIP v2 is scaffolded but not built. See docs/VOIP_V2_BACKEND_SPEC.md.",
  });
}

for (const r of PLACEHOLDER_ROUTES) {
  router[r.method](r.path, notImplemented);
}

module.exports = router;
