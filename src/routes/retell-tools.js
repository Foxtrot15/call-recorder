// AIDA — Retell custom-tool routes (M7J).
//
//   POST /webhooks/retell/tools/create-locksmith-enquiry
//
// ─── WHY ITS OWN ROUTE AND ITS OWN FLAG ─────────────────────────────
// This is the third provider-facing surface, and it is the first one that
// WRITES. The other two:
//
//   /webhooks/retell          set on the AGENT. Records what happened. 204.
//   /webhooks/retell/inbound  set on the NUMBER. Decides how a ringing phone is
//                             handled. Answers with call configuration.
//
// A tool call persists a member of the public's name, number and address on
// behalf of a live conversation. Being willing to record events, or even to
// answer a ringing phone, is not the same as being willing to let a model write
// to the database — so RETELL_TOOLS_ENABLED is a separate switch and the route
// does not mount without it.
//
// ─── ONE PATH PER TOOL ──────────────────────────────────────────────
// Not one endpoint that dispatches on `name`. A per-tool path means a URL can
// be revoked for one capability without withdrawing the others, and the access
// log names the capability without anyone having to trust the body.
//
// ORDER OF OPERATIONS:
//   1. flag gate                (404 if dormant — the URL simply does not exist)
//   2. raw body, size-capped
//   3. SIGNATURE VERIFICATION   ← before anything is parsed
//   4. JSON.parse
//   5. resolve ownership from agent_id via the registry
//   6. capture + respond 200 with a truthful saved/not-saved result
//
// NEVER LOGGED: the API key, the signature header, the raw body, the caller's
// name, number or address.

const express = require("express");
const router = express.Router();

const { isRetellEnabled, areToolsEnabled, getRetellConfig, ENQUIRY_TOOL_PATH } = require("../config/retell");
const { createEnquiryToolHandler } = require("./retell-tools-handler");
const { createInboundResolver, createRegistryAccess } = require("../services/retell-inbound-resolver");
const { createEnquiryStore, createToolAudit } = require("../services/locksmith-enquiry-store");

/**
 * Router-level gate. Dormant by default: without RETELL_TOOLS_ENABLED the path
 * 404s, which is the correct answer — the capability does not exist here.
 */
function retellToolsGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isRetellEnabled(env) || !areToolsEnabled(env)) return next("router");
    next();
  };
}

router.use(retellToolsGate());

const config = getRetellConfig();

// ── Composition at the application boundary, and nowhere deeper ─────
// The tool handler resolves ownership through the SAME resolver and the SAME
// registry the inbound webhook uses. A second identity model for tools would be
// a second way to get "whose call is this?" wrong.
const resolveInboundContext = createInboundResolver({
  access: createRegistryAccess(),
  expectedTag: config.allowedTag,
});

router.post(
  ENQUIRY_TOOL_PATH,
  // Raw bytes: the signature was computed over exactly these.
  express.raw({ type: "application/json", limit: config.webhookMaxBytes }),
  createEnquiryToolHandler({
    resolveInbound: (request) =>
      resolveInboundContext({
        agentId: request.agentId,
        agentVersion: request.agentVersion,
        callId: null, // provenance only; ownership never depends on it
      }),
    store: createEnquiryStore(),
    audit: createToolAudit(),
  })
);

module.exports = router;
module.exports.retellToolsGate = retellToolsGate;
