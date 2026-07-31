// AIDA — voice configuration session model (M5, reserved).
//
// ─────────────────────────────────────────────────────────────────────
// NOTHING HERE PLACES OR RECEIVES A CALL. NO NUMBER IS CONNECTED.
// ─────────────────────────────────────────────────────────────────────
// This models the boundary a future dedicated AIDA configuration agent will
// use, so that the configuration domain cannot quietly become UI-only. It is
// deliberately built now, while the change-request service is being written,
// because a domain that has only ever been driven by an HTML form grows
// form-shaped assumptions that are expensive to remove later.
//
// The configuration agent is a FOURTH, separate agent. It is not:
//   * the public customer-facing receptionist (talks to the locksmith's
//     customers about lockouts),
//   * the outbound sales agent (not built),
//   * the initial onboarding agent (M2/M3: interviews a new client once).
// It talks to an AUTHENTICATED EXISTING CLIENT about their own settings.
//
// What it may eventually be asked to do: refine call handling, add or remove
// services, change areas, hours, after-hours rules, urgency definitions,
// transfer and backup recipients, notification recipients, approved pricing
// language, caller questions, greeting and tone; add FAQs and knowledge;
// correct a misunderstanding; make a temporary operational change; or review
// and reverse a previous change.
//
// Every one of those produces an ordinary change request through
// services/locksmith-change-request.js. Voice never writes configuration
// directly and never becomes a second configuration store.
//
// AUTHENTICATION IS DEFERRED, NOT DESIGNED AWAY. Caller ID alone is not
// authentication — numbers are spoofable and phones are shared. The layered
// factors below are modelled so the eventual implementation has somewhere to
// put them, and so a safety-critical change can demand a stronger factor than
// a greeting tweak.
//
// Pure + dep-free. No adapter: there is nothing to persist until a call can
// actually happen.

const { CHANGE_TARGETS } = require("./locksmith-change-request");

const SESSION_VERSION = "voice-configuration-session-2026-08-01";

// The agent this session belongs to. Named so it can never be confused with
// the other three.
const AGENT_ROLE = "configuration_agent";

const OTHER_AGENT_ROLES = Object.freeze(["receptionist_agent", "onboarding_agent", "outbound_sales_agent"]);

const SESSION_STATUSES = Object.freeze([
  "created",
  "authenticating",
  "authenticated",
  "gathering",
  "reading_back",
  "requests_created",
  "awaiting_portal_approval",
  "completed",
  "abandoned",
  "failed",
  "authentication_failed",
]);

const SESSION_TRANSITIONS = Object.freeze({
  created: ["authenticating", "abandoned", "failed"],
  authenticating: ["authenticated", "authentication_failed", "abandoned"],
  authenticated: ["gathering", "abandoned", "failed"],
  gathering: ["reading_back", "abandoned", "failed"],
  reading_back: ["requests_created", "gathering", "abandoned", "failed"],
  requests_created: ["awaiting_portal_approval", "completed", "failed"],
  awaiting_portal_approval: ["completed", "abandoned"],
  completed: [],
  abandoned: [],
  failed: [],
  authentication_failed: [],
});

// ── Layered authentication ──────────────────────────────────────────
// Ordered weakest to strongest. `strength` feeds the policy below.
const AUTH_FACTORS = Object.freeze({
  recognised_caller_number: { strength: 1, spoofable: true, label: "Calling from a number on the account" },
  account_pin: { strength: 2, spoofable: false, label: "Account PIN or spoken passphrase" },
  one_time_code: { strength: 3, spoofable: false, label: "One-time code sent to a verified channel" },
  portal_confirmation: { strength: 4, spoofable: false, label: "Confirmed in the authenticated portal" },
  verified_callback: { strength: 4, spoofable: false, label: "AIDA rang back a verified account number" },
});

const AUTH_FACTOR_KEYS = Object.freeze(Object.keys(AUTH_FACTORS));

/**
 * How much authentication a change needs.
 *
 * Caller ID alone is never sufficient for anything that changes configuration.
 * A safety-critical change needs a strong factor AND portal-side confirmation,
 * because "someone who answered the owner's phone" must not be able to reroute
 * the owner's emergency calls to themselves.
 */
const AUTH_POLICY = Object.freeze({
  // Read-only: "what are my current hours?"
  read_only: { minimumStrength: 2, requiresPortalConfirmation: false },
  // Ordinary change: greeting, tone, notification recipients.
  ordinary_change: { minimumStrength: 3, requiresPortalConfirmation: false },
  // Safety-critical: transfer numbers, pricing authority, hours, emergency
  // rules, service exclusions, recording preference, permitted statements.
  safety_critical_change: { minimumStrength: 4, requiresPortalConfirmation: true },
});

/** The safety-critical set, derived from the change-request targets so the two cannot drift. */
const SAFETY_CRITICAL_TARGETS = Object.freeze(
  Object.entries(CHANGE_TARGETS).filter(([, meta]) => meta.safetyCritical).map(([key]) => key)
);

function classifyRequestSensitivity(targets) {
  if (!targets || targets.length === 0) return "read_only";
  return targets.some((t) => SAFETY_CRITICAL_TARGETS.includes(t)) ? "safety_critical_change" : "ordinary_change";
}

/**
 * Is this session authenticated well enough for what it is being asked to do?
 * Pure. Returns { allowed, required, achieved, reasons[] }.
 */
function evaluateAuthentication({ factors = [], targets = [], portalConfirmed = false }) {
  const sensitivity = classifyRequestSensitivity(targets);
  const policy = AUTH_POLICY[sensitivity];
  const reasons = [];

  const known = factors.filter((f) => AUTH_FACTOR_KEYS.includes(f));
  const unknown = factors.filter((f) => !AUTH_FACTOR_KEYS.includes(f));
  for (const f of unknown) reasons.push(`"${String(f).slice(0, 40)}" is not a recognised authentication factor.`);

  const achieved = known.reduce((max, f) => Math.max(max, AUTH_FACTORS[f].strength), 0);

  // Caller ID on its own is explicitly insufficient, even for read-only.
  const onlyCallerId = known.length > 0 && known.every((f) => f === "recognised_caller_number");
  if (onlyCallerId) {
    reasons.push("Caller ID alone is not authentication. A phone number can be spoofed and handsets are shared.");
  }

  if (achieved < policy.minimumStrength) {
    reasons.push(`This ${sensitivity.replace(/_/g, " ")} needs a stronger factor than has been provided.`);
  }
  if (policy.requiresPortalConfirmation && !portalConfirmed) {
    reasons.push("A safety-critical change must also be confirmed in the authenticated portal before it can be applied.");
  }

  return {
    allowed: reasons.length === 0 && !onlyCallerId && achieved >= policy.minimumStrength,
    sensitivity,
    required: policy,
    achieved,
    reasons,
  };
}

function canTransition(from, to) {
  return Boolean(SESSION_TRANSITIONS[from]) && SESSION_TRANSITIONS[from].includes(to);
}

/**
 * The session record shape. Built now so the eventual implementation has a
 * settled vocabulary; nothing persists it yet.
 */
function buildVoiceConfigurationSession({
  sessionId,
  clientId,
  authorisedUserId = null,
  callerIdentity = null,
  agentVersion = null,
  providerCallId = null,
}, nowIso = new Date().toISOString()) {
  if (!sessionId || !clientId) throw new Error("a voice configuration session needs a session id and a client");
  return Object.freeze({
    sessionVersion: SESSION_VERSION,
    agentRole: AGENT_ROLE,
    sessionId,
    clientId,
    authorisedUserId,
    // Who appears to be calling. Deliberately NOT treated as identity.
    callerIdentity: callerIdentity ? { maskedNumber: maskCaller(callerIdentity), recognised: false } : null,
    authentication: { status: "not_started", factors: [], achievedStrength: 0, portalConfirmed: false },
    agentVersion,
    providerCallId,
    // A reference to the transcript on the call record. The transcript is
    // evidence; it is never the configuration.
    transcriptReference: null,
    status: "created",
    requestedChanges: [],
    clarificationQuestions: [],
    readBackConfirmations: [],
    missingInformation: [],
    contradictions: [],
    changeRequestIds: [],
    completionStatus: null,
    approvalStatus: "not_requested",
    auditEvents: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

function maskCaller(number) {
  const digits = String(number).replace(/\D/g, "");
  return digits.length >= 3 ? `••• ••• ${digits.slice(-3)}` : "•••";
}

/**
 * Turn what the agent understood into ordinary change requests. This is the
 * ONLY bridge from voice into configuration, and it produces requests — never
 * profile mutations.
 *
 * Returns the arguments buildChangeRequest expects, so the voice path and the
 * portal path converge on one constructor.
 */
function toChangeRequestArgs({ session, changes, requestId }) {
  return {
    requestId,
    clientId: session.clientId,
    sourceChannel: "voice_configuration_agent",
    requestedBy: session.authorisedUserId,
    changes,
    voiceSessionId: session.sessionId,
    transcriptReference: session.transcriptReference,
    status: "submitted",
  };
}

/**
 * What the agent must read back before a change may be filed. Mirrors the
 * change-request rules rather than restating them, so the two cannot diverge.
 */
function requiredReadBacks(targets) {
  return (targets || [])
    .filter((t) => CHANGE_TARGETS[t])
    .map((t) => ({
      target: t,
      label: CHANGE_TARGETS[t].label,
      digitByDigit: CHANGE_TARGETS[t].readBack === true,
      safetyCritical: CHANGE_TARGETS[t].safetyCritical === true,
    }))
    .filter((r) => r.safetyCritical || r.digitByDigit);
}

/**
 * Knowledge-base amendments requested by voice. The receptionist knowledge base
 * is a GENERATED PROJECTION of the approved profile plus approved knowledge —
 * never directly mutable. A spoken "add a FAQ about key cutting" therefore
 * produces a structured amendment carrying its own evidence, which follows the
 * same approval path as any other change.
 */
function buildKnowledgeAmendment({ session, title, body, transcriptReference = null }) {
  const cleanTitle = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const cleanBody = typeof body === "string" ? body.replace(/\s+/g, " ").trim().slice(0, 4000) : "";
  if (!cleanTitle || !cleanBody) {
    return { ok: false, code: "incomplete_amendment", message: "A knowledge amendment needs a title and body." };
  }

  // Screen for instruction-like content exactly as the receptionist compiler
  // does. Business knowledge that reads like a command to the assistant is
  // surfaced for review, never silently accepted.
  const { INSTRUCTION_LIKE } = require("./locksmith-receptionist-compiler");
  const suspicious = INSTRUCTION_LIKE.some((pattern) => pattern.test(cleanTitle) || pattern.test(cleanBody));

  return {
    ok: true,
    amendment: Object.freeze({
      kind: "knowledge_amendment",
      sourceChannel: "voice_configuration_agent",
      voiceSessionId: session ? session.sessionId : null,
      title: cleanTitle,
      body: cleanBody,
      // Evidence, not authority.
      transcriptReference: transcriptReference || (session ? session.transcriptReference : null),
      suspiciousInstructionContent: suspicious,
      requiresClientConfirmation: true,
      // Approval produces a new knowledge/profile version, a regenerated
      // knowledge projection, refreshed receptionist tests and a new
      // provisioning plan. Never a direct provider write.
      appliesVia: "new_approved_version_then_provisioning_plan",
    }),
  };
}

module.exports = {
  SESSION_VERSION,
  AGENT_ROLE,
  OTHER_AGENT_ROLES,
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
  AUTH_FACTORS,
  AUTH_FACTOR_KEYS,
  AUTH_POLICY,
  SAFETY_CRITICAL_TARGETS,
  classifyRequestSensitivity,
  evaluateAuthentication,
  canTransition,
  buildVoiceConfigurationSession,
  toChangeRequestArgs,
  requiredReadBacks,
  buildKnowledgeAmendment,
  maskCaller,
};
