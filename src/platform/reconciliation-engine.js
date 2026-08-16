// AIDA PLATFORM — establishing what actually exists (P27 / P27A).
//
//   reconcileClient({ registry, executions, actions, desired, observations })
//   buildRepairPlan(reconciliation)
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// Three sources can disagree about a provider resource:
//
//   the REGISTRY        what AIDA wrote down
//   the EXECUTION LOG   what AIDA tried to do, including what it never finished
//   the PROVIDER        what is actually there
//
// A row is not proof. An execution that ended UNKNOWN is not proof of absence.
// Only an observation is evidence about the provider, and an observation that
// could not be taken is UNKNOWN — never "nothing there".
//
// ── AND WHY IT ONLY RECOMMENDS ──────────────────────────────────────
// `buildRepairPlan` is a pure function returning recommendations. It executes
// nothing, adopts nothing and writes nothing. Adoption in particular requires
// strict proof: client, provider tag, purpose, resource type and payload hash
// must ALL match. There is no "looks like ours" — a resource that looks like
// ours and is not is somebody else's telephone service.

const { RECONCILIATION_MEANING } = require("./provisioning-model");

const REPAIR_ACTIONS = Object.freeze([
  "adopt_existing_resource",
  "mark_resource_missing",
  "create_new_after_confirmed_missing",
  "update_drift",
  "manual_review",
]);

/** Sub-reasons, so a result is actionable rather than merely categorised. */
const SUBREASONS = Object.freeze({
  registry_and_provider_agree: "the registry and the provider agree, including the payload hash",
  provider_reports_absent: "the provider was asked and does not have it",
  provider_unreachable: "the provider could not be asked — this is not the same as absent",
  never_recorded_but_exists: "an execution reported provider success and the registry write failed; the provider confirms it exists",
  ambiguous_execution_confirmed_present: "an execution ended UNKNOWN and the provider confirms the resource exists",
  ambiguous_execution_confirmed_absent: "an execution ended UNKNOWN and the provider confirms nothing was created",
  ambiguous_execution_unobserved: "an execution ended UNKNOWN and the provider has not been observed",
  payload_hash_differs: "both exist and the payload hashes differ",
  identity_differs: "the registry and the provider name different resources for the same purpose",
  provider_has_extra: "the provider has a resource for a purpose AIDA has never recorded",
});

const keyOf = (r) => `${r.purpose}:${r.resourceType ?? r.resource_type}`;

const result = (key, name, subreason, detail, extra = {}) =>
  Object.freeze({
    key,
    result: name,
    subreason,
    meaning: RECONCILIATION_MEANING[name],
    subreasonMeaning: SUBREASONS[subreason] ?? null,
    detail,
    ...extra,
  });

/**
 * @param {Array}  registry      durable provider_resources rows for this client
 * @param {Array}  actions       action-execution records for this client
 * @param {object} desired       compiled desired state (optional)
 * @param {object} observations  key -> observation | null (asked, absent)
 *                               A key ABSENT from this object means NOT ASKED.
 */
function reconcileClient({ clientId, registry = [], actions = [], desired = null, observations = {} } = {}) {
  const results = [];
  const seen = new Set();

  const asked = (key) => Object.prototype.hasOwnProperty.call(observations, key);
  const observed = (key) => observations[key];

  const activeRows = registry.filter((r) => r.active !== false && (r.client_id ?? r.clientId) === clientId);

  // ── every recorded resource ──
  for (const row of activeRows) {
    const key = keyOf(row);
    seen.add(key);
    const recordedId = row.provider_resource_id ?? row.providerResourceId ?? null;
    const recordedHash = row.payload_hash ?? row.payloadHash ?? null;

    if (!asked(key)) {
      results.push(result(key, "unknown", "provider_unreachable",
        "the provider was not observed for this resource", { recordedProviderResourceId: recordedId }));
      continue;
    }
    const o = observed(key);
    if (!o) {
      results.push(result(key, "missing_provider_resource", "provider_reports_absent",
        `AIDA records ${recordedId} and the provider does not have it`, { recordedProviderResourceId: recordedId }));
      continue;
    }
    if (o.providerResourceId && recordedId && o.providerResourceId !== recordedId) {
      results.push(result(key, "manual_review_required", "identity_differs",
        `AIDA records ${recordedId}, the provider reports ${o.providerResourceId}`,
        { recordedProviderResourceId: recordedId, observedProviderResourceId: o.providerResourceId }));
      continue;
    }
    if (o.payloadHash === undefined || o.payloadHash === null) {
      results.push(result(key, "unknown", "provider_unreachable",
        "the provider reported the resource but not enough to compare payloads",
        { recordedProviderResourceId: recordedId }));
      continue;
    }
    if (o.payloadHash !== recordedHash) {
      results.push(result(key, "drift", "payload_hash_differs",
        `recorded ${String(recordedHash).slice(0, 12)}…, provider ${String(o.payloadHash).slice(0, 12)}…`,
        { recordedProviderResourceId: recordedId, recordedPayloadHash: recordedHash, observedPayloadHash: o.payloadHash }));
      continue;
    }
    results.push(result(key, "match", "registry_and_provider_agree", "same id, same payload hash",
      { recordedProviderResourceId: recordedId }));
  }

  // ── every unresolved execution action, whether or not a row exists ──
  const unresolved = actions.filter(
    (a) => ["unknown", "persist_failed_after_provider_success", "provider_succeeded", "claimed"].includes(a.status),
  );
  for (const a of unresolved) {
    const key = a.actionKey;
    if (seen.has(key)) continue;   // already reported from the registry side
    seen.add(key);

    if (!asked(key)) {
      const subreason = a.status === "unknown" ? "ambiguous_execution_unobserved" : "provider_unreachable";
      results.push(result(key, "unknown", subreason,
        `execution ${a.executionId} left this action ${a.status} and the provider has not been observed`,
        { executionId: a.executionId, actionStatus: a.status, claimedProviderResourceId: a.providerResourceId ?? null }));
      continue;
    }
    const o = observed(key);
    if (!o) {
      results.push(result(key, "missing_provider_resource",
        a.status === "unknown" ? "ambiguous_execution_confirmed_absent" : "provider_reports_absent",
        `execution ${a.executionId} was ${a.status}; the provider confirms nothing exists`,
        { executionId: a.executionId, actionStatus: a.status }));
      continue;
    }
    results.push(result(key, "unrecorded_provider_resource",
      a.status === "unknown" ? "ambiguous_execution_confirmed_present" : "never_recorded_but_exists",
      `the provider has ${o.providerResourceId} and the registry has no active row — never adopt automatically`,
      {
        executionId: a.executionId, actionStatus: a.status,
        observedProviderResourceId: o.providerResourceId,
        observedPayloadHash: o.payloadHash ?? null,
        claimedProviderResourceId: a.providerResourceId ?? null,
      }));
  }

  // ── anything the provider has that AIDA has never heard of ──
  for (const [key, o] of Object.entries(observations)) {
    if (seen.has(key) || !o) continue;
    seen.add(key);
    results.push(result(key, "unrecorded_provider_resource", "provider_has_extra",
      `the provider has ${o.providerResourceId} for ${key} and AIDA has never recorded one`,
      { observedProviderResourceId: o.providerResourceId, observedPayloadHash: o.payloadHash ?? null }));
  }

  const counts = {};
  for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;

  return Object.freeze({
    clientId,
    results: Object.freeze(results),
    counts: Object.freeze(counts),
    inSync: results.every((r) => r.result === "match"),
    needsAttention: results.filter((r) => r.result !== "match").length,
    // A reconciliation NEVER produces a create. It produces knowledge.
    providerContacted: false,
    note: "Reconciliation is read-only and ran against injected observations. No provider was contacted and nothing was changed.",
    desiredHash: desired && desired.ok ? desired.desiredHash : null,
  });
}

// ── P27A — THE REPAIR PLAN ──────────────────────────────────────────

/**
 * Recommendations only. Nothing here executes, and adoption demands proof.
 *
 * @param {object} desired  the compiled desired state, for adoption matching
 */
function buildRepairPlan(reconciliation, { desired = null } = {}) {
  const recommendations = [];

  const desiredFor = (key) =>
    desired && desired.ok ? desired.resources.find((r) => `${r.purpose}:${r.resourceType}` === key) : null;

  for (const r of reconciliation.results) {
    if (r.result === "match") continue;

    if (r.result === "unrecorded_provider_resource") {
      const want = desiredFor(r.key);
      // ── STRICT ADOPTION PROOF ──
      // Every one of these must hold. A resource that "looks like ours" and is
      // not is somebody else's telephone service.
      const proof = {
        hasObservedId: Boolean(r.observedProviderResourceId),
        matchesClaimedId:
          r.claimedProviderResourceId == null || r.claimedProviderResourceId === r.observedProviderResourceId,
        hasDesiredResource: Boolean(want),
        payloadHashMatches: Boolean(want) && r.observedPayloadHash === want.payloadHash,
      };
      const adoptable = Object.values(proof).every(Boolean);
      recommendations.push(Object.freeze({
        key: r.key,
        action: adoptable ? "adopt_existing_resource" : "manual_review",
        why: adoptable
          ? "the provider resource matches the desired payload exactly and belongs to this client's purpose"
          : "a provider resource exists but does not satisfy every adoption proof",
        adoptionProof: Object.freeze(proof),
        providerResourceId: r.observedProviderResourceId ?? null,
        requiresHuman: true,
        automatic: false,
      }));
      continue;
    }

    if (r.result === "missing_provider_resource") {
      // Only after CONFIRMED absence may a create be recommended — and it is
      // a recommendation, routed back through planning and approval.
      const confirmed = r.subreason === "provider_reports_absent" || r.subreason === "ambiguous_execution_confirmed_absent";
      recommendations.push(Object.freeze({
        key: r.key,
        action: confirmed ? "create_new_after_confirmed_missing" : "manual_review",
        why: confirmed
          ? "the provider was asked and confirmed nothing exists, so a new plan may create one"
          : "absence has not been confirmed by an observation",
        requiresHuman: true,
        automatic: false,
        note: "This does not create anything. It recommends that a person build and approve a new plan.",
      }));
      recommendations.push(Object.freeze({
        key: r.key, action: "mark_resource_missing",
        why: "the registry still claims an active resource the provider does not have",
        requiresHuman: true, automatic: false,
      }));
      continue;
    }

    if (r.result === "drift") {
      recommendations.push(Object.freeze({
        key: r.key, action: "update_drift",
        why: "both sides exist and the payload hashes differ; somebody changed it outside AIDA, or a write half-landed",
        requiresHuman: true, automatic: false,
        note: "Routed through a normal plan, so the update is reviewed like any other provider mutation.",
      }));
      continue;
    }

    // unknown, manual_review_required, and anything unclassified
    recommendations.push(Object.freeze({
      key: r.key, action: "manual_review",
      why: r.detail || r.meaning,
      requiresHuman: true, automatic: false,
    }));
  }

  return Object.freeze({
    clientId: reconciliation.clientId,
    recommendations: Object.freeze(recommendations),
    // The whole point.
    executed: false,
    automatic: false,
    adoptable: recommendations.filter((x) => x.action === "adopt_existing_resource").length,
    needingHuman: recommendations.filter((x) => x.requiresHuman).length,
    note: "A repair plan is a recommendation. Nothing here adopts, creates, updates or deletes anything.",
  });
}

module.exports = { reconcileClient, buildRepairPlan, REPAIR_ACTIONS, SUBREASONS };
