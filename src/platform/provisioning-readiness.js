// AIDA PLATFORM — why this client is not yet a working assistant (P23A).
//
//   assessClientReadiness({ ... })  -> { dimensions[], blockers[], ready:false }
//
// ── READINESS IS A VIEW, NEVER AUTHORITY ────────────────────────────
// The same posture as the acquisition proof preflight, for the same reason:
// the moment a readiness report can be consulted for permission, it becomes a
// second, softer authority beside the real gates — and the softer one is the
// one somebody eventually calls.
//
// So `ready` is HARDCODED FALSE. Not computed, not conditional, not "false
// until the last dimension passes". There is no input to this function that
// makes it true, because provisioning execution does not exist. When it does,
// the executor will ask the plan authority and config-access — never this. A
// test asserts the literal.
//
// What it IS for: telling a person, in order, what is missing. "Not ready" is
// useless; "no durable clients row, no active configuration, and the voice id
// is unresolved" is a morning of work.

const DIMENSIONS = Object.freeze([
  "client_record", "configuration", "provisioning", "provider", "phone", "routing", "integrations", "compliance",
]);

const state = (name, status, detail, blocking = true) =>
  Object.freeze({ dimension: name, status, detail, blocking });

/**
 * Every input is OPTIONAL, and absence is reported rather than assumed. A
 * readiness view that throws when something is missing tells you nothing about
 * the thing that is missing.
 */
function assessClientReadiness({
  clientId,
  clientRecord = null,       // the durable clients row, or null
  activeConfig = null,       // { configVersion, behaviourHash, contentHash }
  plan = null,               // the current provisioning plan, or null
  planStaleness = null,      // { stale, why } from the plan authority
  desiredState = null,       // compileDesiredState output, for unresolved refs
  currentResources = [],     // durable provider_resources rows
  phoneNumber = null,        // a bound number, or null
  inboundBinding = null,
  integrations = [],         // [{ capability, enabled, adapterRegistered }]
  complianceIssues = [],
} = {}) {
  const dimensions = [];

  // ── the tenant must exist before anything can be filed under it ──
  // The clients.slug ruling, made operational: provisioning never invents a
  // slug from a business name, so a durable client record is a PREREQUISITE
  // rather than something provisioning creates on the way past.
  dimensions.push(
    clientRecord && clientRecord.slug
      ? state("client_record", "present", `clients.slug = "${clientRecord.slug}"`, false)
      : state("client_record", "absent",
          "no durable clients row. provider_resources.client_id is clients.slug, and provisioning must never invent one from a business name"),
  );
  if (clientRecord && clientRecord.slug && clientId && clientRecord.slug !== clientId) {
    dimensions.push(state("client_record", "mismatch",
      `the clients row says "${clientRecord.slug}" and this request says "${clientId}"`));
  }

  // ── configuration ──
  dimensions.push(
    activeConfig
      ? state("configuration", "active", `v${activeConfig.configVersion} is active`, false)
      : state("configuration", "absent", "no approved-and-activated configuration version"),
  );

  // ── provisioning plan ──
  if (!plan) {
    dimensions.push(state("provisioning", "no_plan", "no provisioning plan has been created for the active configuration"));
  } else if (planStaleness && planStaleness.stale) {
    dimensions.push(state("provisioning", "stale", planStaleness.why));
  } else if (plan.status === "approved") {
    dimensions.push(state("provisioning", "approved",
      `plan ${plan.planId} is approved (${plan.mutatingCount} provider mutation(s) would be required)`, false));
  } else {
    dimensions.push(state("provisioning", plan.status, `plan ${plan.planId} is ${plan.status}`));
  }

  // ── provider resources ──
  if (desiredState && desiredState.unresolved && desiredState.unresolved.length) {
    dimensions.push(state("provider", "unresolved_references",
      `deployment facts missing and never guessed: ${desiredState.unresolved.join(", ")}`));
  }
  const active = currentResources.filter((r) => r.active !== false);
  if (!active.length) {
    dimensions.push(state("provider", "absent", "no provider resources are recorded for this client"));
  } else {
    const untrusted = active.filter(
      (r) => !r.lastOutcome || r.lastOutcome === "ambiguous" || r.lastOutcome === "provider_success_persist_failed",
    );
    dimensions.push(
      untrusted.length
        ? state("provider", "unknown", `${untrusted.length} recorded resource(s) whose provider state is not trustworthy`)
        : state("provider", "recorded", `${active.length} recorded resource(s) — recorded is not the same as verified`, false),
    );
  }

  // ── phone and routing: a separate authority, reported rather than acquired ──
  dimensions.push(
    phoneNumber
      ? state("phone", "present", `${phoneNumber}`, false)
      : state("phone", "absent", "no telephone number. Number acquisition is a separate authority and provisioning does not buy one"),
  );
  dimensions.push(
    inboundBinding
      ? state("routing", "bound", "an inbound binding exists", false)
      : state("routing", "absent", "no inbound binding, so nothing routes a call to this assistant"),
  );

  // ── integrations ──
  const missingAdapters = integrations.filter((i) => i.enabled && !i.adapterRegistered);
  dimensions.push(
    missingAdapters.length
      ? state("integrations", "adapters_missing",
          `enabled with no adapter: ${missingAdapters.map((i) => i.capability).join(", ")}`)
      : state("integrations", "satisfied", "every enabled capability has an adapter", false),
  );

  // ── compliance ──
  dimensions.push(
    complianceIssues.length
      ? state("compliance", "unsatisfied", complianceIssues.join("; "))
      : state("compliance", "satisfied", "platform compliance requirements are met by the active configuration", false),
  );

  const blockers = dimensions.filter((d) => d.blocking);

  return Object.freeze({
    clientId: clientId ?? null,
    // ── HARDCODED. See the header. ──
    // No input makes this true, and there is no executor for it to authorise.
    ready: false,
    readyReason: "provisioning execution is not implemented; readiness is a view and never a permission",
    dimensions: Object.freeze(dimensions),
    blockers: Object.freeze(blockers),
    blockerCount: blockers.length,
    summary: blockers.length === 0
      ? "every dimension reports satisfied — and this still authorises nothing"
      : blockers.map((b) => `${b.dimension}: ${b.status}`).join(", "),
  });
}

module.exports = { assessClientReadiness, DIMENSIONS };
