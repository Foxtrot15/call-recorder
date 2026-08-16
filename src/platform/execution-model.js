// AIDA PLATFORM — the provisioning execution vocabulary (P24).
//
// ── THE FOUR SENTENCES THIS MODULE EXISTS TO KEEP TRUE ──────────────
//
//   APPROVED PLAN                    is not   EXECUTED PLAN
//   UNKNOWN                          is not   FAILURE
//   PROVIDER SUCCESS + DB FAILURE    is not   SAFE TO RETRY
//   AMBIGUOUS OUTCOME                is never AUTOMATICALLY RETRIED
//
// Everything below is a named, closed set so that each of those distinctions
// is representable. Collapsing UNKNOWN into FAILED is the single change that
// would make a second agent possible, so UNKNOWN has its own status, its own
// rules, and its own required human step.
//
// ── WHAT AIDA ACTUALLY GUARANTEES (P25B) ────────────────────────────
// Not "exactly once". The internet cannot provide that: a request may reach a
// provider and its response may be lost, and no client-side code can tell the
// difference. Claiming exactly-once would be a lie that makes people relax.
//
// What is guaranteed instead, and what the code below enforces:
//
//   1. ONE DURABLE LOCAL CLAIM per (client, action). Written before the
//      provider is contacted, so a second process cannot start the same work.
//   2. ONE INTENTIONAL PROVIDER MUTATION ATTEMPT per authorised action. The
//      executor sends once. It does not loop.
//   3. NO AUTOMATIC RETRY after an ambiguous outcome. The next step is a
//      person looking, never another request.
//   4. A DETERMINISTIC PROVIDER REQUEST IDENTITY, so a provider that supports
//      idempotency keys can de-duplicate on its side.
//   5. RECONCILIATION BEFORE ANY SECOND MUTATION. An unresolved action blocks
//      further execution for that client until durable truth is restored.

const crypto = require("crypto");
const { stableStringify } = require("./stable-json");

// ── EXECUTION ATTEMPT ───────────────────────────────────────────────
//
// One attempt to execute one approved plan. `claimed` is the only state from
// which provider work happens; everything else is terminal or requires a
// person.
const EXECUTION_STATUSES = Object.freeze([
  "claimed",                          // durably claimed; work may proceed
  "completed",                        // every action reached a definite end
  "failed",                           // stopped on a definite provider failure
  "unknown",                          // stopped on an ambiguous provider result
  "manual_reconciliation_required",   // a person must establish provider truth
  "abandoned",                        // operator gave up on it, deliberately
]);

/**
 * Statuses that mean "this execution is not finished with". While a client has
 * one of these, no new execution may be claimed for them — that is the durable
 * half of the no-second-agent guarantee.
 */
const UNRESOLVED_EXECUTION_STATUSES = Object.freeze([
  "claimed", "unknown", "manual_reconciliation_required",
]);

const TERMINAL_EXECUTION_STATUSES = Object.freeze(["completed", "failed", "abandoned"]);

// ── ACTION EXECUTION ────────────────────────────────────────────────
const ACTION_EXECUTION_STATUSES = Object.freeze([
  "not_started",
  "claimed",                              // durable claim taken, provider not yet called
  "provider_succeeded",                   // provider confirmed; registry not yet written
  "provider_failed_definite",             // the provider explicitly refused
  "unknown",                              // ambiguous: it may or may not exist
  "persist_failed_after_provider_success", // it EXISTS and AIDA did not record it
  "completed",                            // provider confirmed AND registry written
  "manual_reconciliation_required",
]);

/**
 * Action statuses that block further work on the same resource. An action in
 * any of these has an unresolved relationship with the provider, and starting
 * another attempt at it is how one authorised write becomes two resources.
 */
const UNRESOLVED_ACTION_STATUSES = Object.freeze([
  "claimed", "provider_succeeded", "unknown", "persist_failed_after_provider_success",
]);

const ACTION_KINDS = Object.freeze(["create", "update", "replace", "retire"]);

// ── PROVIDER OUTCOMES ───────────────────────────────────────────────
//
// Deliberately only three. A transport layer that returns anything else is
// forcing a judgement it is not qualified to make.
const PROVIDER_OUTCOMES = Object.freeze(["definite_success", "definite_failure", "unknown"]);

/** Why an outcome was classified UNKNOWN. Recorded; never used to soften it. */
const AMBIGUITY_REASONS = Object.freeze([
  "timeout_after_request_sent",
  "connection_reset_after_write",
  "malformed_response_after_accepted_request",
  "transport_ambiguity",
  "unclassifiable_provider_error",
]);

/**
 * What each outcome means for what happens next. `mayRetryAutomatically` is
 * false for EVERY outcome including definite_failure: this executor never
 * loops. A definite failure may be re-planned by a person, which is a
 * different act performed at a different time by somebody who looked.
 */
const OUTCOME_RULES = Object.freeze({
  definite_success: {
    actionStatus: "provider_succeeded",
    stopsExecution: false,
    mayRetryAutomatically: false,
    requiresHuman: false,
    note: "The provider confirmed. The registry write is next, and it is the dangerous half.",
  },
  definite_failure: {
    actionStatus: "provider_failed_definite",
    // The remaining actions are NOT attempted: a plan is a sequence somebody
    // approved as a whole, and half of it is not what they approved.
    stopsExecution: true,
    mayRetryAutomatically: false,
    requiresHuman: false,
    note: "The provider explicitly refused. Nothing exists remotely for this action.",
  },
  unknown: {
    actionStatus: "unknown",
    stopsExecution: true,
    mayRetryAutomatically: false,
    requiresHuman: true,
    note: "The request may have reached the provider. LOOK before anybody sends anything else. Re-creating is how one authorised write becomes two resources.",
  },
});

// ── RETIREMENT (P26B) ───────────────────────────────────────────────
//
// "Retire" means different things at different providers, and a model that
// pretends otherwise lies about what happened. Each is recorded explicitly.
const RETIREMENT_MODES = Object.freeze([
  "provider_disabled",   // the resource still exists remotely, switched off
  "provider_deleted",    // the resource is gone remotely
  "registry_inactive",   // AIDA stopped treating it as active; the provider was not asked
]);

const RETIREMENT_MEANING = Object.freeze({
  provider_disabled: "The resource still EXISTS at the provider and has been switched off. It can be switched back on.",
  provider_deleted: "The resource is GONE at the provider. This is irreversible and requires a provider that supports deletion.",
  registry_inactive: "AIDA no longer treats it as active. THE PROVIDER WAS NOT ASKED and may still be serving it.",
});

// ── AUDIT EVENTS (P28C) ─────────────────────────────────────────────
const EXECUTION_AUDIT_EVENTS = Object.freeze([
  "execution_requested",
  "execution_refused",
  "execution_claimed",
  "provider_attempted",
  "provider_succeeded",
  "provider_failed",
  "provider_unknown",
  "registry_recorded",
  "registry_persist_failed",
  "execution_completed",
  "reconciliation_requested",
  "reconciliation_completed",
  "manual_review_required",
]);

// ── DETERMINISTIC IDENTITY ──────────────────────────────────────────

/**
 * The provider request identity. Deterministic and immutable: the same
 * authorised action always produces the same value, so a provider offering
 * idempotency keys can de-duplicate on its side even when AIDA cannot tell
 * whether the first request arrived.
 *
 * It covers what makes the request unique — client, the exact approved plan,
 * the resource, and the exact payload — and nothing that varies per attempt.
 * A value that changed between attempts would defeat the whole point.
 */
function providerRequestId({ clientId, planHash, actionKey, desiredPayloadHash, actionKind }) {
  return crypto
    .createHash("sha256")
    .update(stableStringify({ clientId, planHash, actionKey, desiredPayloadHash, actionKind }))
    .digest("hex");
}

/** A stable id for one execution attempt of one plan. */
function executionIdFor({ clientId, planHash, attemptOrdinal }) {
  const digest = crypto
    .createHash("sha256")
    .update(stableStringify({ clientId, planHash, attemptOrdinal }))
    .digest("hex");
  return `exec_${digest.slice(0, 24)}`;
}

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Validate an action-execution record before it can be claimed. */
function validateActionExecution(record) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  if (!record || typeof record !== "object") {
    return { ok: false, errors: [{ field: "", message: "an action execution must be an object" }] };
  }
  if (!isStr(record.clientId)) err("clientId", "required");
  if (!isStr(record.executionId)) err("executionId", "required");
  if (!isStr(record.planId)) err("planId", "required");
  if (!isStr(record.actionKey)) err("actionKey", "required");
  if (!ACTION_KINDS.includes(record.actionKind)) err("actionKind", `one of ${ACTION_KINDS.join(", ")}`);
  if (!Number.isInteger(record.actionOrdinal) || record.actionOrdinal < 0) err("actionOrdinal", "non-negative integer required");
  if (!isHash(record.providerRequestId)) err("providerRequestId", "64-char sha256 required");
  if (!ACTION_EXECUTION_STATUSES.includes(record.status)) err("status", `one of ${ACTION_EXECUTION_STATUSES.join(", ")}`);
  // retire has no desired payload; everything else must have one.
  if (record.actionKind !== "retire" && !isHash(record.desiredPayloadHash)) {
    err("desiredPayloadHash", "64-char sha256 required for create, update and replace");
  }
  return { ok: errors.length === 0, errors };
}

/** Human-readable summary of where an execution got to, and what to do next. */
function describeExecutionOutcome(execution, actions = []) {
  const byStatus = {};
  for (const a of actions) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

  const unresolved = actions.filter((a) => UNRESOLVED_ACTION_STATUSES.includes(a.status));
  const existsButUnrecorded = actions.filter((a) => a.status === "persist_failed_after_provider_success");
  const ambiguous = actions.filter((a) => a.status === "unknown");

  return Object.freeze({
    executionId: execution.executionId,
    status: execution.status,
    counts: Object.freeze(byStatus),
    unresolvedCount: unresolved.length,
    // The loudest possible surfacing: a resource that EXISTS and which AIDA
    // did not record is more dangerous than one that was never created.
    unrecordedProviderResources: Object.freeze(
      existsButUnrecorded.map((a) => ({
        actionKey: a.actionKey,
        providerResourceId: a.providerResourceId,
        warning: "THIS RESOURCE EXISTS AT THE PROVIDER AND IS NOT RECORDED. Do not re-create it.",
      })),
    ),
    ambiguousActions: Object.freeze(
      ambiguous.map((a) => ({
        actionKey: a.actionKey,
        ambiguityReason: a.ambiguityReason ?? null,
        warning: "It is unknown whether this resource was created. Observe the provider before anything else.",
      })),
    ),
    nextStep:
      existsButUnrecorded.length
        ? "Record the provider resource ids listed above, by hand if necessary. Do NOT re-run."
        : ambiguous.length
          ? "Observe the provider and reconcile. Do NOT re-run."
          : execution.status === "failed"
            ? "A definite provider failure. A person may build a new plan after understanding why."
            : execution.status === "completed"
              ? "Nothing further."
              : "Review.",
  });
}

module.exports = {
  EXECUTION_STATUSES,
  UNRESOLVED_EXECUTION_STATUSES,
  TERMINAL_EXECUTION_STATUSES,
  ACTION_EXECUTION_STATUSES,
  UNRESOLVED_ACTION_STATUSES,
  ACTION_KINDS,
  PROVIDER_OUTCOMES,
  AMBIGUITY_REASONS,
  OUTCOME_RULES,
  RETIREMENT_MODES,
  RETIREMENT_MEANING,
  EXECUTION_AUDIT_EVENTS,
  providerRequestId,
  executionIdFor,
  validateActionExecution,
  describeExecutionOutcome,
};
