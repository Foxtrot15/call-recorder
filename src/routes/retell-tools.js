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
const { createEnquiryStore, createToolAudit, createNotificationStore } = require("../services/locksmith-enquiry-store");
const { notifyLocksmith } = require("../services/locksmith-notification");
const { createSmsDelivery } = require("../services/locksmith-sms-delivery");
const { getNotificationConfig } = require("../config/locksmith-notifications");

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
    // ── Notification (M7K) ────────────────────────────────────────
    // Composed here, at the boundary, like everything else. Dormant unless
    // LOCKSMITH_NOTIFICATIONS_ENABLED is exactly "true", and a dry run unless
    // LOCKSMITH_NOTIFY_MODE is exactly "live" — so the default deployment
    // attempts nothing and the founder proof sends nothing.
    //
    // Recipients come from the client's APPROVED PROFILE, fetched here rather
    // than trusted from the request: who may be told a caller's details is a
    // configuration fact, never a model-influenced one.
    notify: async ({ enquiryId, clientId, profile }) => {
      const notifyConfig = getNotificationConfig();
      if (!notifyConfig.enabled) return null;

      const resolvedProfile = profile || (await loadApprovedProfile(clientId));
      const notificationStore = createNotificationStore();

      return notifyLocksmith({
        enquiry: { id: enquiryId, ...(await loadEnquiryForNotification(enquiryId)) },
        profile: resolvedProfile,
        config: notifyConfig,
        deps: {
          claim: notificationStore.claimForNotification,
          markSent: notificationStore.markSent,
          markFailed: notificationStore.markFailed,
          markNotRequired: notificationStore.markNotRequired,
          deliver: createSmsDelivery({ mode: notifyConfig.mode }),
        },
      });
    },
  })
);

/** The approved profile, for its notification recipients. Lazily required. */
async function loadApprovedProfile(clientId) {
  try {
    const row = await require("../services/locksmith-profile-store").getApprovedVersion(clientId);
    return (row && row.profile) || null;
  } catch {
    return null;
  }
}

/**
 * Re-read the row we just wrote, for the message body.
 *
 * From the DATABASE rather than the tool arguments: the row is what was
 * actually stored, after validation and normalisation. Notifying from the raw
 * arguments would let a message differ from the record it claims to describe.
 */
async function loadEnquiryForNotification(enquiryId) {
  try {
    const supabase = require("../services/supabase");
    const { data, error } = await supabase
      .from("locksmith_enquiries")
      .select("caller_name, callback_number, suburb, street_address, problem_description, urgency, property_secure, desired_timing")
      .eq("id", enquiryId)
      .limit(1);
    if (error || !data || !data.length) return {};
    return data[0];
  } catch {
    return {};
  }
}

module.exports = router;
module.exports.retellToolsGate = retellToolsGate;
