// AIDA Locksmith Acquisition — the founder's readiness view (E-12H).
//
//   await describeProofPreflight({ env, store, now, proofAuthorisation })
//
// ── WHAT THIS IS ────────────────────────────────────────────────────
// One report answering one question: is AIDA allowed to make exactly one
// founder-authorised acquisition proof call, and if not, what is missing?
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────
// It is NOT a permission path. It authorises nothing, unlocks nothing, and is
// consulted by nothing at dial time. The authoritative pre-dial gate
// (acquisition-authorisation.js, M8E) still runs immediately before execution
// and still owns every compliance decision. If this report and that gate ever
// disagree, the gate is right and this is a stale view.
//
// That distinction is the whole design. A readiness aggregator that could be
// mistaken for permission is how a parallel, weaker authorisation path gets
// built by accident — so this returns booleans and prose, and imports nothing
// that can dial.
//
// ── IT AGGREGATES; IT DOES NOT RE-DECIDE ────────────────────────────
// Every fact below is read from the authority that already owns it:
//
//   calling state        acquisition-calling-state (durable, revisioned)
//   providers            acquisition-dial-provider / -retell-provider
//   engine               acquisition-agent-spec drift pin
//   agent                acquisition-resource-authority (provider_resources)
//   voice / webhook      config/acquisition acquisition-only keys
//   number               config/acquisition acquisition-only key
//   DNCR                 acquisition-dncr wash store
//   suppression          the durable suppression list
//   attempts / hours     acquisition-attempt-policy, calling windows
//
// Nothing here reimplements a rule. Where an authority cannot be reached, the
// item reports UNKNOWN and blocks — never "probably fine".

const { getAcquisitionRetellConfig, describeAcquisitionNumberReadiness, isAcquisitionEnabled, EXTERNAL_SYSTEMS, CALLING_WINDOWS, DNCR_WASH_VALIDITY_DAYS, resolveDncrMode } = require("../config/acquisition");
const { describeResponseEngineDrift, PROVISIONED_RESPONSE_ENGINE } = require("./acquisition-agent-spec");
const { assessAcquisitionAgentProvisioning } = require("./acquisition-agent-provisioning");
const { describeAcquisitionProvisioningState } = require("./acquisition-resource-authority");
const { createDisabledDialProvider } = require("./acquisition-dial-provider");
const { isLiveProofAuthorisation } = require("./acquisition-proof-authorisation");

const UNKNOWN = "unknown";

const ok = (label) => Object.freeze({ ready: true, detail: label });
const no = (detail) => Object.freeze({ ready: false, detail });
const unknown = (detail) => Object.freeze({ ready: UNKNOWN, detail });

/**
 * Read the durable calling state without inventing a default.
 *
 * A store that cannot be read must NOT read as "paused" (falsely reassuring) or
 * as "enabled" (dangerous). It reads as unknown, and unknown blocks.
 */
async function readCallingState(store) {
  if (!store || typeof store.readCallingState !== "function") {
    return unknown("the calling-state store is unavailable");
  }
  try {
    const state = await store.readCallingState();
    if (!state) return unknown("no calling-state row exists");
    if (state.state === "paused") return no(`calling is PAUSED (revision ${state.revision})`);
    if (state.state === "enabled") return ok(`calling is enabled (revision ${state.revision})`);
    return unknown(`calling state is "${state.state}", which is not recognised`);
  } catch (err) {
    return unknown(`the calling state could not be read: ${err.message}`);
  }
}

/** Has this exact number a wash that is both real and still fresh? */
async function readDncr(env, store, destinationE164, now) {
  const mode = resolveDncrMode(env).mode;
  if (mode !== "import") {
    return no(
      `DNCR mode is "${mode}" — only "import" carries an authoritative wash. ` +
        "A fixture wash does not clear a real number for a real call."
    );
  }
  if (!destinationE164) return no("no destination number has been chosen, so no wash can apply");
  if (!store || typeof store.listWashes !== "function") return unknown("the wash store is unavailable");
  try {
    const washes = await store.listWashes({ e164: destinationE164 });
    const fresh = (washes || []).filter((w) => {
      const at = new Date(w.washedAt || w.washed_at);
      const ageDays = (now().getTime() - at.getTime()) / 86_400_000;
      return ageDays >= 0 && ageDays <= DNCR_WASH_VALIDITY_DAYS;
    });
    if (!fresh.length) return no(`no authoritative DNCR wash within ${DNCR_WASH_VALIDITY_DAYS} days for this number`);
    return ok(`washed ${fresh.length} time(s) within ${DNCR_WASH_VALIDITY_DAYS} days`);
  } catch (err) {
    return unknown(`the wash store could not be read: ${err.message}`);
  }
}

async function readSuppression(store, prospectId, destinationE164) {
  if (!store || typeof store.lookupSuppression !== "function") return unknown("the suppression list is unavailable");
  try {
    const hit = await store.lookupSuppression({ prospectId, e164: destinationE164 });
    return hit ? no("this business or number is suppressed and must never be cold-called again") : ok("not suppressed");
  } catch (err) {
    return unknown(`suppression could not be checked: ${err.message}`);
  }
}

/**
 * Build the founder-visible report.
 *
 * Everything is optional: a caller with no store still gets a truthful report
 * in which the store-backed items are UNKNOWN and blocking.
 */
async function describeProofPreflight({
  env = process.env,
  store = null,
  washStore = null,
  now = () => new Date(),
  proofAuthorisation = null,
  agentResource = null,
  prospectId = null,
  destinationE164 = null,
} = {}) {
  const acq = getAcquisitionRetellConfig(env);
  const numberReadiness = describeAcquisitionNumberReadiness(env);
  const drift = describeResponseEngineDrift();
  const agentState = describeAcquisitionProvisioningState(agentResource);
  const agentAssessment = assessAcquisitionAgentProvisioning({ env, existingResource: agentResource });

  // ── RESOURCES ────────────────────────────────────────────────────
  const resources = Object.freeze({
    responseEngine: drift.drifted
      ? no(`the local response engine has drifted from the provisioned one (${PROVISIONED_RESPONSE_ENGINE.payloadHash.slice(0, 12)}…)`)
      : env.RETELL_ACQUISITION_LLM_ID
        ? ok("provisioned, and the local payload still matches the pin")
        : no("provisioned remotely, but RETELL_ACQUISITION_LLM_ID is not set in this environment"),
    agent: agentState.state === "provisioned" ? ok(`agent recorded (${agentState.providerResourceId})`) : no("no acquisition agent has been provisioned"),
    voice: acq.voiceId ? ok(`acquisition voice configured (${acq.voiceId})`) : no("RETELL_ACQUISITION_VOICE_ID is not set"),
    webhook: acq.acquisitionWebhookUrl ? ok("acquisition webhook URL configured") : no("RETELL_ACQUISITION_WEBHOOK_URL is not set — the route is not publicly deployed"),
    outboundNumber: numberReadiness.ready ? ok(`acquisition number configured (${numberReadiness.number})`) : no(numberReadiness.blockers[0] || "no acquisition number"),
  });

  // ── COMPLIANCE ───────────────────────────────────────────────────
  const dncr = await readDncr(env, washStore, destinationE164, now);
  const suppression = await readSuppression(store, prospectId, destinationE164);
  const compliance = Object.freeze({
    dncr,
    suppression,
    // Reported rather than decided: the pre-dial gate owns these, and a proof
    // call still passes through it.
    permittedHours: unknown("evaluated by the pre-dial gate at dial time, against the configured calling windows"),
    publicHoliday: unknown(
      "evaluated by the pre-dial gate using the FIXTURE holiday provider. A-L2 is OPEN — no authoritative " +
        "holiday source has been chosen, so a holiday cannot be relied on to block a call."
    ),
    attemptPolicy: unknown("evaluated by the pre-dial gate: 2 counted attempts, 2 days apart; voicemail counts, no-answer does not"),
  });

  // ── EXECUTION SAFETY ─────────────────────────────────────────────
  const callingState = await readCallingState(store);
  const providerLive = createDisabledDialProvider().live === true;
  const execution = Object.freeze({
    callingState,
    providerLive: providerLive ? ok("a live provider is configured") : no("every acquisition provider is live:false"),
    telephonyAvailable: EXTERNAL_SYSTEMS.telephony ? ok("telephony is available") : no("telephony is structurally unavailable (a hardcoded constant)"),
    acquisitionEngine: isAcquisitionEnabled(env) ? ok("the acquisition engine is enabled") : no("ACQUISITION_ENABLED is not \"true\""),
    founderAuthorisation: isLiveProofAuthorisation(proofAuthorisation, now)
      ? ok(`authorised by ${proofAuthorisation.approvedBy}, expires ${proofAuthorisation.expiresAt}`)
      : no("no live, unspent founder proof authorisation"),
    dispatchLock: unknown("claimed at execution time — one dispatch per authorised dial, enforced by the database"),
  });

  const sections = { resources, compliance, execution };
  const blockers = [];
  for (const [group, items] of Object.entries(sections)) {
    for (const [name, item] of Object.entries(items)) {
      if (item.ready !== true) blockers.push(`${group}.${name}: ${item.detail}`);
    }
  }

  return Object.freeze({
    ready: false, // ALWAYS false — see below.
    readyForReview: blockers.length === 0,
    blockers: Object.freeze(blockers),
    resources,
    compliance,
    execution,
    agentAssessment: Object.freeze({ ok: agentAssessment.ok, refusals: agentAssessment.refusals }),
    note:
      "`ready` is always false here BY DESIGN. This report is a view, not a permission. Even with every item " +
      "green, the authoritative pre-dial gate runs immediately before execution and is the only thing that may " +
      "authorise a call.",
    generatedAt: now().toISOString(),
  });
}

module.exports = { describeProofPreflight, CALLING_WINDOWS };
