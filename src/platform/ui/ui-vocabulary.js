// AIDA PLATFORM UI — the words a screen is allowed to say (P29).
//
//   STATUS_LABELS / statusChip(kind, value)
//   LOCKED_FIELDS / isLocked(path)
//   PLAN_ACTION_LABELS / planActionChip(action)
//   EXECUTION_LABELS / executionChip(status)
//
// ── WHY A VOCABULARY MODULE AT ALL ──────────────────────────────────
// Because the same state must read the same way on every screen. A dashboard
// that says "Pending" where the plan review says "Draft" and the history says
// "Not approved" is three names for one thing, and the person deciding whether
// to approve it has to work out that they are the same. Worse, the day somebody
// adds a fourth name it will be for the state that matters most.
//
// So the labels live here, once, keyed by the EXACT value the domain uses. An
// unknown value does not get a friendly guess — it gets rendered as itself and
// flagged, because a screen quietly inventing a label for a state nobody
// designed is how UNKNOWN eventually gets drawn as FAILED.
//
// ── TONE IS NOT DECORATION ──────────────────────────────────────────
// Each label carries a `tone`, and tone drives more than colour: it selects the
// text prefix a screen renders beside the chip, so status survives greyscale,
// colour blindness and a screen reader. "Do not rely on colour alone" is not
// satisfied by picking accessible colours.
//
// This module imports nothing and touches no DOM.

/** Tones, ordered by how much they should interrupt somebody. */
const TONES = Object.freeze(["neutral", "info", "good", "warn", "danger", "locked"]);

/**
 * The textual marker rendered with every chip. A person who cannot see the
 * colour still reads the state, and a screen reader announces it.
 */
const TONE_MARK = Object.freeze({
  neutral: "•",
  info: "•",
  good: "✓",
  warn: "!",
  danger: "!!",
  locked: "🔒",
});

const label = (text, tone, help = null) => Object.freeze({ text, tone, help });

// ── CONFIGURATION LIFECYCLE ─────────────────────────────────────────
// The five states in client-blueprint.js BLUEPRINT_STATUSES, and nothing else.
const CONFIG_STATUS = Object.freeze({
  draft: label("DRAFT", "neutral", "Editable. Not validated, not approved, not live."),
  validated: label("VALIDATED", "info", "Passed domain validation. Editing it makes it a draft again."),
  approved: label("APPROVED", "good", "Locked. A named person approved this exact content. Further edits create a new draft."),
  active: label("ACTIVE", "good", "This is the configuration AIDA considers current. It has NOT been sent to any provider."),
  superseded: label("SUPERSEDED", "neutral", "A later version replaced this one. Kept for history and never edited."),
});

// ── PROVISIONING PLAN LIFECYCLE ─────────────────────────────────────
// provisioning-model.js PLAN_STATUSES. Four of these are unreachable today
// because no live transport exists; they are labelled anyway, so the day a plan
// can enter one the screen already knows how to say it truthfully.
const PLAN_STATUS = Object.freeze({
  draft: label("PLAN DRAFT", "neutral", "Built from the active configuration. Not validated, not approved."),
  validated: label("PLAN VALIDATED", "info", "Still matches the configuration it was built from."),
  approved: label("PLAN APPROVED — NOT EXECUTED", "good",
    "A named person approved these provider changes. Nothing has been sent. Provider changes require a separately authorised provisioning operation."),
  executing: label("EXECUTING", "warn", "A provisioning run is in progress."),
  completed: label("COMPLETED", "good", "Every action in this plan reached a definite result."),
  failed: label("FAILED", "danger", "An action failed definitely. Nothing was created by the failed action."),
  unknown: label("RECONCILIATION REQUIRED", "danger",
    "The provider outcome is uncertain. Reconciliation is required before another mutation can be attempted."),
  cancelled: label("CANCELLED", "neutral", "Withdrawn before approval or execution."),
  superseded: label("SUPERSEDED", "neutral", "A newer plan replaced this one."),
});

// ── ACTION EXECUTION STATES ─────────────────────────────────────────
// execution-model.js ACTION_EXECUTION_STATUSES. The two that matter most are
// the two a careless screen would collapse into "failed".
const EXECUTION_STATUS = Object.freeze({
  not_started: label("NOT STARTED", "neutral", "No attempt has been made."),
  claimed: label("CLAIMED", "info", "A durable claim exists. The provider may or may not have been contacted yet."),
  provider_succeeded: label("PROVIDER SUCCEEDED", "good", "The provider confirmed the change."),
  provider_failed_definite: label("FAILED", "danger", "The provider explicitly refused. Nothing was created."),
  unknown: label("OUTCOME UNCERTAIN", "danger",
    "Provider outcome is uncertain. Reconciliation is required before another mutation can be attempted."),
  persist_failed_after_provider_success: label("RECORDED NOWHERE — RESOURCE EXISTS", "danger",
    "The provider change SUCCEEDED and AIDA failed to record it. The resource exists and is not in the registry. Do not re-run."),
  completed: label("COMPLETED", "good", "Confirmed by the provider and recorded here."),
  manual_reconciliation_required: label("RECONCILIATION REQUIRED", "danger",
    "A person must compare the registry with the provider before anything else runs for this client."),
});

/**
 * The states in which offering a retry would be actively dangerous. Not a
 * styling concern — a screen asks this before rendering ANY action control.
 *
 * `unknown` is here for the obvious reason. `persist_failed_...` is here for
 * the less obvious one: the provider call worked, so "retry" would create a
 * second resource while the first is still serving.
 */
const NEVER_RETRYABLE = Object.freeze([
  "unknown",
  "persist_failed_after_provider_success",
  "manual_reconciliation_required",
]);

/** The single sentence the founder specified for an ambiguous outcome. */
const UNCERTAIN_OUTCOME_SENTENCE =
  "Provider outcome is uncertain. Reconciliation is required before another mutation can be attempted.";

// ── PROVISIONING PLAN ACTIONS ───────────────────────────────────────
// provisioning-model.js PROVISIONING_ACTIONS. `risk` drives prominence: the
// founder singled out replace, retire and reconcile_required, and the reason is
// that each one can take away something a business is currently being served by.
const PLAN_ACTION = Object.freeze({
  no_change: Object.freeze({ ...label("NO CHANGE", "neutral", "Already matches the desired state. Nothing would be sent."), risk: "none" }),
  create: Object.freeze({ ...label("CREATE", "info", "A new provider resource would be created."), risk: "normal" }),
  update: Object.freeze({ ...label("UPDATE", "info", "The existing resource would be updated in place, keeping its id."), risk: "normal" }),
  replace: Object.freeze({
    ...label("REPLACE", "warn",
      "A NEW resource would be created with a new id. The old one is retired by a SEPARATE action — never deleted first."),
    risk: "high",
  }),
  retire: Object.freeze({
    ...label("RETIRE", "warn",
      "A resource would stop being treated as active. Check which retirement mode: the provider may not be asked at all, and may still be serving it."),
    risk: "high",
  }),
  reconcile_required: Object.freeze({
    ...label("RECONCILIATION REQUIRED", "danger",
      "The recorded state and the provider cannot be assumed to agree. A person must look before anything is sent."),
    risk: "high",
  }),
});

const HIGH_RISK_ACTIONS = Object.freeze(
  Object.entries(PLAN_ACTION).filter(([, v]) => v.risk === "high").map(([k]) => k),
);

// ── READINESS ──────────────────────────────────────────────────────
const READINESS_TONE = Object.freeze({
  present: "good", active: "good", approved: "good", recorded: "good",
  satisfied: "good", bound: "good",
  absent: "warn", no_plan: "warn", stale: "warn",
  draft: "neutral", validated: "info",
  unresolved_references: "warn", adapters_missing: "warn", unsatisfied: "warn",
  unknown: "danger", mismatch: "danger",
});

/**
 * Printed on every readiness view, at the top, in the same words as
 * provisioning-readiness.js. A readiness report that looks like a green light
 * becomes one.
 */
const READINESS_DISCLAIMER =
  "Readiness is INFORMATIONAL. It is not permission to provision, and satisfying every dimension does not authorise anything.";

// ── WHAT A CLIENT MAY NOT EDIT ──────────────────────────────────────
//
// Blueprint paths the UI must render as read-only with a visible reason. This
// is a DISPLAY list, not the enforcement — client-blueprint.js validation and
// config-patch.js are the authorities, and a test asserts every path here is
// genuinely refused by one of them rather than merely hidden. A locked field
// that is only locked in the browser is a lie told in CSS.
const LOCKED_FIELDS = Object.freeze({
  "identity.clientId": "The tenant is resolved from your session. It is never taken from a form.",
  "identity.vertical": "Changing the trade of an existing client is not an edit; it is a new client.",
  "metadata": "Lifecycle metadata is written by the approval and activation authorities, never typed.",
  "metadata.status": "A configuration cannot approve or activate itself by claiming a status.",
  "knowledge.prohibitedClaims.mandatory": "PLATFORM REQUIREMENT — six claims no assistant may make for any client, in any trade. A client may ADD prohibitions; these six cannot be removed.",
  "outbound.aiDisclosure": "PLATFORM REQUIREMENT — outbound calls must identify AIDA as an AI assistant. There is no toggle.",
  "compliance.dncr": "DNCR washing, suppression and dial authority are separate safety systems. They are not configuration.",
  "compliance.suppression": "Suppression is append-only and owned by its own authority.",
});

const LOCKED_LABEL = "PLATFORM REQUIREMENT — LOCKED";

/** The exact sentence the outbound section must render. No toggle accompanies it. */
const OUTBOUND_DISCLOSURE_SENTENCE = "Outbound calls must identify AIDA as an AI assistant.";

/** And the inbound counterpart, which is a different rule and must not be conflated. */
const INBOUND_DISCLOSURE_SENTENCE =
  "Inbound calls open with your greeting. AIDA does not announce that it is an AI assistant in the first sentence — but if a caller asks whether they are speaking to a person, it always answers truthfully.";

const isLocked = (path) => Object.prototype.hasOwnProperty.call(LOCKED_FIELDS, path);

/**
 * Look a value up, or report honestly that nobody designed a label for it.
 * `known:false` is what stops a new domain state from being drawn with a
 * plausible-looking label that happens to be wrong.
 */
function chip(table, value) {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value)) {
    return Object.freeze({ ...table[value], value, known: true, mark: TONE_MARK[table[value].tone] });
  }
  return Object.freeze({
    text: String(value === undefined || value === null ? "UNSPECIFIED" : value).toUpperCase(),
    tone: "warn",
    help: "This state has no designed label. It is shown exactly as the system reported it.",
    value: value ?? null,
    known: false,
    mark: TONE_MARK.warn,
  });
}

const configChip = (v) => chip(CONFIG_STATUS, v);
const planChip = (v) => chip(PLAN_STATUS, v);
const executionChip = (v) => chip(EXECUTION_STATUS, v);
const planActionChip = (v) => chip(PLAN_ACTION, v);

/** May a screen offer to run this action state again? Only ever false for the dangerous ones. */
const mayOfferRetry = (executionStatus) => !NEVER_RETRYABLE.includes(executionStatus);

module.exports = {
  TONES, TONE_MARK,
  CONFIG_STATUS, PLAN_STATUS, EXECUTION_STATUS, PLAN_ACTION,
  NEVER_RETRYABLE, HIGH_RISK_ACTIONS,
  READINESS_TONE, READINESS_DISCLAIMER,
  LOCKED_FIELDS, LOCKED_LABEL, isLocked,
  OUTBOUND_DISCLOSURE_SENTENCE, INBOUND_DISCLOSURE_SENTENCE, UNCERTAIN_OUTCOME_SENTENCE,
  configChip, planChip, executionChip, planActionChip, mayOfferRetry,
};
