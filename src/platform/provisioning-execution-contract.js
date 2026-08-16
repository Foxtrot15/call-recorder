// AIDA PLATFORM — the contract the executor must satisfy (P23E).
//
//   EXECUTION_PRECONDITIONS      the ordered gates
//   describeExecutionContract()
//
// ── THIS IS STILL NOT AN EXECUTOR ───────────────────────────────────
// This file contains no transport, no provider client, no request, and no
// operation that could perform one. It imports nothing at all. It is a
// SPECIFICATION, written in P23E so the eventual executor would be reviewed
// against something rather than invented at a keyboard on the day somebody
// wanted a client live.
//
// P24-P28 then built that executor. Each precondition below is enforced by a
// named gate in execution-preflight.js, and a test maps the two lists to each
// other so neither can drift alone. The executor is real; every provider
// adapter it can be handed is a FAKE.
//
// It is code rather than prose so the preconditions can be enumerated,
// rendered and tested — and so the executor is checked against the list
// mechanically instead of from memory.
//
// ── WHAT IS BORROWED FROM ACQUISITION, AND WHAT IS NOT ──────────────
// BORROWED, because it is generic to "one authorised remote write":
//   * a create that times out may have SUCCEEDED — ambiguity is not failure
//   * never auto-retry a create after an ambiguous outcome
//   * a provider success whose durable record failed is louder, not quieter
//   * one authorisation is spent at most once
//   * the environment tag is re-read immediately before the write
//
// NOT BORROWED, because it belongs to cold-calling a stranger rather than to
// configuring a receptionist a business asked for:
//   * DNCR washing
//   * suppression lists
//   * calling-hours policy
//   * the dial authorisation slip
//   * the global calling stop
//
// Importing those here would tie a client's receptionist to the acquisition
// gates — both wrong, and a way to make one system's incident stop the other.

/**
 * The order IS the specification. Each gate must pass before the next is
 * evaluated, and the single provider mutation happens after all of them.
 */
const EXECUTION_PRECONDITIONS = Object.freeze([
  {
    step: 1,
    gate: "authenticated_execution_authority",
    requires: "a principal holding provisioning:execute for THIS client",
    why: "Building a plan and approving a plan are different capabilities from running one. Whoever wrote it does not thereby gain the right to run it.",
  },
  {
    step: 2,
    gate: "plan_approved",
    requires: "plan.status === approved, with a named human approver",
    why: "A machine may not approve its own provider mutations.",
  },
  {
    step: 3,
    gate: "plan_hash_exact",
    requires: "planHashOf(plan) === plan.planHash === plan.approvedPlanHash",
    why: "The approval binds to a body. A plan whose actions changed after approval is a set of mutations nobody agreed to.",
  },
  {
    step: 4,
    gate: "active_configuration_still_exact",
    requires: "the active config version, behaviour hash and content hash still equal the plan binding",
    why: "An approval describes mutations computed from specific words. If the words moved, the approval no longer describes reality. Stale plans never execute, and are never silently regenerated.",
  },
  {
    step: 5,
    gate: "tenant_and_resource_ownership_exact",
    requires: "every action resource belongs to this client, and no action references another tenant provider resource id",
    why: "A provider id from another client is somebody else telephone service.",
  },
  {
    step: 6,
    gate: "provider_tag_and_environment_exact",
    requires: "the plan provider tag equals the runtime environment tag, re-read immediately before the write",
    why: "The acquisition work found this the hard way: an env file overriding process.env meant a staging run was pointed at the wrong tag. Read it late and compare it explicitly.",
  },
  {
    step: 7,
    gate: "durable_one_resource_authority",
    requires: "the pr_one_active_per_purpose index on provider_resources accepts the write",
    why: "One active resource per (client, provider, purpose, type) is a DATABASE index, not an application check somebody has to remember. It is the guard against two agents for one business.",
  },
  {
    step: 8,
    gate: "final_stop_gate",
    requires: "a re-read of any platform-level provisioning stop, immediately before the mutation",
    why: "A stop that was checked a minute ago is a stop that was checked a minute ago.",
  },
  {
    step: 9,
    gate: "exactly_one_provider_mutation",
    requires: "one action, one endpoint, one call — no loop that could send twice",
    why: "A runner that can create twice will eventually create twice.",
  },
  {
    step: 10,
    gate: "durable_result_recorded",
    requires: "provider resource id, payload hash and the full provenance chain written to provider_resources",
    why: "An unrecorded resource that EXISTS is far more dangerous than a recorded one that does not. If the write fails, the id is printed loudly and the outcome is provider_success_persist_failed.",
  },
  {
    step: 11,
    gate: "ambiguity_is_unknown",
    requires: "any timeout, lost response or unparseable result records outcome ambiguous and stops",
    why: "The provider may have built the resource and lost the answer coming back.",
  },
  {
    step: 12,
    gate: "no_automatic_retry",
    requires: "no code path re-attempts a create after a non-definite outcome",
    why: "Calling create again is how one authorised write becomes two agents. The next step is a person LOOKING, not a retry.",
  },
]);

/** A renderable description, for a runbook or a founder review screen. */
function describeExecutionContract() {
  return Object.freeze({
    // P23E wrote this when nothing could execute. P24-P28 built the executor,
    // so "no executor exists" became false — and this object is served over
    // HTTP, which makes it a false statement somebody could act on. The honest
    // split is between an executor existing and a real transport existing.
    // Only the second one can telephone anybody, and it does not exist.
    implemented: true,
    executorExists: true,
    liveProviderTransportExists: false,
    note: "The executor exists and honours every precondition below, but every provider adapter it can be handed is a FAKE. No real transport exists, no flag or environment variable creates one, and this module still imports nothing.",
    preconditionCount: EXECUTION_PRECONDITIONS.length,
    preconditions: EXECUTION_PRECONDITIONS,
    borrowedFromAcquisition: Object.freeze([
      "ambiguity is not failure",
      "no auto-retry after ambiguity",
      "provider success with failed persistence is louder",
      "one authorisation spent once",
      "environment tag re-read immediately before the write",
    ]),
    deliberatelyNotBorrowed: Object.freeze([
      "DNCR washing",
      "suppression lists",
      "calling-hours policy",
      "the dial authorisation slip",
      "the global calling stop",
    ]),
    whyNotBorrowed:
      "Those gate cold-calling a stranger. A receptionist a business asked for is not a cold call, and importing them would couple the two systems so one incident stops the other.",
  });
}

module.exports = { EXECUTION_PRECONDITIONS, describeExecutionContract };
