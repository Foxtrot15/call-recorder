// AIDA Locksmith Acquisition — the gates in front of creating the agent (E-12E).
//
//   assessAcquisitionAgentProvisioning({ env, config, existingResource })
//
// ── WHY THIS IS A MODULE AND NOT JUST A SCRIPT ──────────────────────
// E-10D(i) put its safety checks inline in the provisioning script, which was
// right for one write of one object with four fields. The agent is a harder
// thing to get right: it points at an engine that already exists remotely, it
// carries a voice a founder chose by ear, it carries the answering-machine
// policy, and it carries a webhook that does not exist yet. Those checks are
// worth testing directly rather than only by reading a script, so they live
// here and the script prints what they decide.
//
// ── NOTHING HERE CAN REACH RETELL ───────────────────────────────────
// Pure functions over configuration and the locally-built payload. No transport
// is imported, no credential is read, and the module returns a verdict rather
// than acting on one. The single authorised write lives in the hand-run script.
//
// ── WHAT IT REFUSES, AND WHY EACH ONE EXISTS ────────────────────────
// Every refusal below is a way the one authorised write could produce an agent
// that is wrong in a way nobody would notice until it telephoned a stranger:
//
//   prod tag              creating the pilot agent on the production account
//   engine drift          an agent whose prompt is not the prompt we reviewed
//   wrong/absent voice    the receptionist's voice on a cold call
//   voicemail not hangup  a sales message on somebody's answering machine
//   voicemail message     the same, by a different field
//   wrong language        a US-English agent calling Australian businesses
//   bad webhook           outcomes delivered nowhere, or to another product
//   already provisioned   a SECOND acquisition agent
//
// The founder's own environment is the one that matters: NODE_ENV=production
// with RETELL_ALLOWED_TAG=staging is the CORRECT staging shape and is accepted.
// "Production" there describes security posture, not the Retell account.

const { describeAcquisitionRetellResources, describeResponseEngineDrift, PROVISIONED_RESPONSE_ENGINE } = require("./acquisition-agent-spec");
const { getAcquisitionRetellConfig, resolveAcquisitionVoiceId } = require("../config/acquisition");

/** The only Retell mutation this milestone may ever perform. */
const AUTHORISED_OPERATION = "createAgent";

/** Operations that must never appear on the agent path, named so tests can assert them. */
const FORBIDDEN_OPERATIONS = Object.freeze([
  "createResponseEngine",
  "updateResponseEngine",
  "createPhoneCall",
  "createWebCall",
  "bindPhoneNumber",
  "updateAgent",
  "createKnowledgeBase",
]);

const REFUSALS = Object.freeze({
  PROD_TAG: "prod_tag_refused",
  ENGINE_DRIFT: "response_engine_drift",
  ENGINE_ID_MISSING: "response_engine_id_missing",
  VOICE_MISSING: "acquisition_voice_missing",
  VOICE_MISMATCH: "acquisition_voice_mismatch",
  VOICEMAIL_NOT_HANGUP: "voicemail_action_not_hangup",
  VOICEMAIL_MESSAGE: "voicemail_message_present",
  LANGUAGE: "language_not_en_au",
  WEBHOOK_MISSING: "acquisition_webhook_missing",
  WEBHOOK_INSECURE: "acquisition_webhook_not_https",
  WEBHOOK_LOCAL: "acquisition_webhook_local_host",
  ALREADY_PROVISIONED: "acquisition_agent_already_provisioned",
  NOT_READY: "create_agent_not_ready",
});

const EXPECTED_LANGUAGE = "en-AU";

/** Local/loopback hosts a public provider could never deliver to. */
function isLocalHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Is this a webhook URL a provider could actually reach, and is it OURS?
 * Returns a refusal code or null.
 */
function checkWebhookUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return REFUSALS.WEBHOOK_MISSING;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return REFUSALS.WEBHOOK_INSECURE;
  }
  if (url.protocol !== "https:") return REFUSALS.WEBHOOK_INSECURE;
  if (isLocalHost(url.hostname)) return REFUSALS.WEBHOOK_LOCAL;
  return null;
}

/**
 * Everything that must be true before the ONE createAgent request.
 *
 * @param {object}  env               the resolved environment
 * @param {object}  config            getRetellConfig(env)
 * @param {object}  [existingResource] a durable acquisition-agent record, if any (E-12F)
 * @returns {{ok:boolean, refusals:string[], checks:object, payload:object|null, resources:object}}
 */
function assessAcquisitionAgentProvisioning({ env = process.env, config = null, existingResource = null } = {}) {
  const acquisitionConfig = getAcquisitionRetellConfig(env);
  const llmId = typeof env.RETELL_ACQUISITION_LLM_ID === "string" && env.RETELL_ACQUISITION_LLM_ID.trim()
    ? env.RETELL_ACQUISITION_LLM_ID.trim()
    : null;

  const resources = describeAcquisitionRetellResources({ config: acquisitionConfig, llmId });
  const agent = resources.agent;
  const drift = describeResponseEngineDrift(resources.responseEngine);

  const refusals = [];

  // ── The account ──────────────────────────────────────────────────
  // NODE_ENV is irrelevant here on purpose: it describes how the SERVER
  // behaves, not which Retell account is being written to.
  const tag = config ? config.allowedTag : env.RETELL_ALLOWED_TAG;
  if (tag === "prod") refusals.push(REFUSALS.PROD_TAG);

  // ── The engine this agent will point at ──────────────────────────
  if (drift.drifted) refusals.push(REFUSALS.ENGINE_DRIFT);
  if (!llmId) refusals.push(REFUSALS.ENGINE_ID_MISSING);

  // ── The voice, which must be the acquisition one specifically ────
  const selectedVoice = resolveAcquisitionVoiceId(env);
  if (!selectedVoice) refusals.push(REFUSALS.VOICE_MISSING);
  else if (agent.voice_id !== selectedVoice) refusals.push(REFUSALS.VOICE_MISMATCH);

  // ── The answering-machine policy (E-12A) ─────────────────────────
  const vm = agent.voicemail_option;
  if (!vm || !vm.action || vm.action.type !== "hangup") refusals.push(REFUSALS.VOICEMAIL_NOT_HANGUP);
  if (vm && /"text"|"prompt"|"message"|"audio"/i.test(JSON.stringify(vm))) refusals.push(REFUSALS.VOICEMAIL_MESSAGE);

  // ── The market ───────────────────────────────────────────────────
  if (agent.language !== EXPECTED_LANGUAGE) refusals.push(REFUSALS.LANGUAGE);

  // ── Where outcomes will be delivered ─────────────────────────────
  const webhookRefusal = checkWebhookUrl(agent.webhook_url);
  if (webhookRefusal) refusals.push(webhookRefusal);

  // ── One agent, ever (E-12F) ──────────────────────────────────────
  if (existingResource) refusals.push(REFUSALS.ALREADY_PROVISIONED);

  // ── The spec's own readiness, which owns blockers we do not ──────
  if (!resources.readiness.createAgentReady) refusals.push(REFUSALS.NOT_READY);

  return Object.freeze({
    ok: refusals.length === 0,
    refusals: Object.freeze([...new Set(refusals)]),
    checks: Object.freeze({
      allowedTag: tag || null,
      nodeEnv: env.NODE_ENV || null,
      engineHashExpected: PROVISIONED_RESPONSE_ENGINE.payloadHash,
      engineHashActual: drift.actual,
      engineDrifted: drift.drifted,
      llmIdPresent: Boolean(llmId),
      voiceSelected: selectedVoice,
      voiceOnPayload: agent.voice_id,
      voicemailAction: vm && vm.action ? vm.action.type : null,
      language: agent.language,
      webhookUrl: agent.webhook_url,
      alreadyProvisioned: Boolean(existingResource),
      createAgentReady: resources.readiness.createAgentReady,
      specBlockers: resources.readiness.blockers,
    }),
    payload: refusals.length === 0 ? agent : null,
    resources,
  });
}

/**
 * How to describe a Retell answer we did not fully receive.
 *
 * A timeout is NOT "nothing happened". Retell may have created the agent and
 * lost the reply, so the only safe reading is UNKNOWN — and the only safe next
 * action is a human looking at the dashboard. There is deliberately no retry
 * anywhere in this module or the script that uses it.
 */
const AMBIGUOUS_PROVIDER_CODES = Object.freeze(["provider_timeout", "provider_unreachable", "provider_error"]);

function classifyCreateAgentFailure(errorCode) {
  return AMBIGUOUS_PROVIDER_CODES.includes(errorCode)
    ? Object.freeze({ status: "unknown", retry: false, action: "reconcile_by_hand" })
    : Object.freeze({ status: "refused", retry: false, action: "correct_and_rerun" });
}

module.exports = {
  assessAcquisitionAgentProvisioning,
  classifyCreateAgentFailure,
  checkWebhookUrl,
  isLocalHost,
  REFUSALS,
  AUTHORISED_OPERATION,
  FORBIDDEN_OPERATIONS,
  AMBIGUOUS_PROVIDER_CODES,
  EXPECTED_LANGUAGE,
};
