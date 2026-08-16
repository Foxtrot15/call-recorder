// AIDA PLATFORM — desired versus recorded (P21).
//
//   diffProvisioning({ desired, current })  -> { actions[], summary, ... }
//   reconcile({ recorded, observed })       -> a reconciliation result  (P21B)
//
// Pure. It compares two lists of objects. It contacts nothing, and a ratchet
// asserts its imports.
//
// ── THE SENTENCE THIS FILE IS BUILT AROUND ──────────────────────────
//
//   A DATABASE ROW IS NOT PROOF A REMOTE RESOURCE EXISTS.
//
// The registry records what AIDA believes it created. It cannot know whether
// somebody deleted the agent in a dashboard this morning, or whether a create
// that timed out actually landed. So the diff never claims to know provider
// state: it classifies against what is RECORDED, and any recorded row whose
// provisioning outcome was not a definite success becomes
// RECONCILE_REQUIRED rather than being treated as present or absent.
//
// Provider observation is a separate, later, read-only input — modelled by
// `reconcile()` below and fed by fakes until somebody authorises a real read.
//
// ── AND THE OTHER ONE ───────────────────────────────────────────────
//
//   UNKNOWN IS NEVER CREATE.
//
// The acquisition lesson generalised: a create that timed out may have
// succeeded. Re-creating is how one authorised write becomes two agents, and a
// duplicate agent is a thing that can speak to a stranger.

const {
  RESOURCE_MUTABILITY,
  OUTCOME_RULES,
  RECONCILIATION_RESULTS,
  MUTATING_ACTIONS,
} = require("./provisioning-model");

const keyOf = (r) => `${r.purpose}:${r.resourceType}`;

/**
 * Normalise a durable provider_resources row into what the diff needs.
 * Deliberately narrow: the diff must not depend on the whole row shape.
 */
function readCurrent(row) {
  // Normalise FIRST, then build the key from the normalised values.
  //
  // These rows arrive in two shapes: camelCase from a domain object, and
  // snake_case straight from provider_resources. Computing the key before
  // normalising produced "receptionist_agent:undefined" for every real
  // database row — so a client who already had resources planned as CREATE
  // plus a phantom RETIRE, which is the duplicate-resource case. Caught by
  // the fake end-to-end run, where the payload hashes matched perfectly and
  // the diff still refused to be a no-op.
  const purpose = row.purpose;
  const resourceType = row.resourceType ?? row.resource_type ?? null;
  const metadata = row.providerMetadata ?? row.provider_metadata ?? null;

  return {
    key: `${purpose}:${resourceType}`,
    purpose,
    resourceType,
    clientId: row.clientId ?? row.client_id,
    provider: row.provider,
    providerResourceId: row.providerResourceId ?? row.provider_resource_id ?? null,
    payloadHash: row.payloadHash ?? row.payload_hash ?? null,
    active: row.active !== false,
    providerTag: row.providerTag ?? row.provider_tag ?? null,
    // What AIDA believes about the last provisioning attempt. Absent means
    // nobody recorded one, which is itself a reason not to trust the row.
    lastOutcome: row.lastOutcome ?? row.last_outcome ?? null,
    configVersion: row.configVersion ?? (metadata && metadata.configVersion) ?? null,
    behaviourHash: row.behaviourHash ?? (metadata && metadata.behaviourHash) ?? null,
    producedBy: (metadata && metadata.producedBy) ?? null,
  };
}

/** Is this recorded row trustworthy enough to classify against? */
function trustworthiness(current) {
  if (!current.lastOutcome) {
    return { trusted: false, why: "no provisioning outcome was ever recorded for this row" };
  }
  const rule = OUTCOME_RULES[current.lastOutcome];
  if (!rule) return { trusted: false, why: `unknown provisioning outcome "${current.lastOutcome}"` };
  if (rule.resourceState === "unknown") {
    return { trusted: false, why: rule.note };
  }
  if (!current.providerResourceId) {
    return { trusted: false, why: "the row records no provider resource id" };
  }
  return { trusted: true };
}

/**
 * @param {object} desired  the output of compileDesiredState
 * @param {Array}  current  durable provider_resources rows for THIS client
 */
function diffProvisioning({ desired, current = [] } = {}) {
  if (!desired || desired.ok !== true) {
    return Object.freeze({ ok: false, code: "no_desired_state", message: "a compiled desired state is required" });
  }

  // Tenancy first. A row belonging to another client must never be compared
  // against this client's desired state, let alone reused.
  const foreign = current.map(readCurrent).filter((c) => c.clientId && c.clientId !== desired.clientId);
  if (foreign.length) {
    return Object.freeze({
      ok: false,
      code: "cross_tenant_resource",
      message: `refusing to plan against ${foreign.length} resource(s) belonging to another client`,
    });
  }

  const currentByKey = new Map();
  for (const row of current.map(readCurrent)) {
    if (row.provider !== desired.provider) continue;   // a different provider is a different world
    if (!row.active) continue;                          // superseded rows are history
    currentByKey.set(row.key, row);
  }

  const actions = [];
  const seen = new Set();

  for (const want of desired.resources) {
    const key = keyOf(want);
    seen.add(key);
    const have = currentByKey.get(key);

    const base = {
      key,
      purpose: want.purpose,
      resourceType: want.resourceType,
      provider: want.provider,
      desiredPayloadHash: want.payloadHash,
      dependencyHash: want.dependencyHash,
      currentPayloadHash: have ? have.payloadHash : null,
      providerResourceId: have ? have.providerResourceId : null,
    };

    if (!have) {
      actions.push({ ...base, action: "create", reason: "no active recorded resource for this purpose and type" });
      continue;
    }

    const trust = trustworthiness(have);
    if (!trust.trusted) {
      // NOT create. The row may correspond to something that exists.
      actions.push({
        ...base,
        action: "reconcile_required",
        reason: trust.why,
        note: "A person must establish what exists at the provider before anything else happens. This is never automatically resolved into a create.",
      });
      continue;
    }

    // A resource produced by a DIFFERENT authority for the same purpose. The
    // database's pr_one_active_per_purpose index means only one may be active,
    // so this is a genuine ownership conflict, not something to overwrite.
    if (have.producedBy && have.producedBy !== "aida-client-platform") {
      actions.push({
        ...base,
        action: "reconcile_required",
        reason: `this resource was produced by "${have.producedBy}", not by the client platform`,
        note: "Two systems believe they own this client's receptionist. A person decides which, before either writes.",
      });
      continue;
    }

    if (have.payloadHash === want.payloadHash) {
      // The payload is identical. It may still need touching if something it
      // DEPENDS ON is being replaced — that cascade is applied below.
      actions.push({
        ...base,
        action: "no_change",
        reason: "the recorded payload hash equals the desired payload hash",
        // Traceability decision, made explicitly rather than silently: a
        // resource produced by an OLDER config whose output is byte-identical
        // is left alone, and its provenance is refreshed without a provider
        // mutation. Rewriting the resource to "update" its provenance would be
        // a remote write with no remote effect.
        provenanceRefresh:
          have.configVersion !== null && have.configVersion !== desired.configVersion
            ? { from: have.configVersion, to: desired.configVersion, providerMutation: false }
            : null,
      });
      continue;
    }

    const mutability = RESOURCE_MUTABILITY[want.resourceType];
    actions.push({
      ...base,
      action: mutability === "updatable" ? "update" : "replace",
      reason: `the desired payload differs from the recorded one (${mutability})`,
    });
  }

  // Anything active and recorded that the desired set no longer wants.
  for (const [key, have] of currentByKey) {
    if (seen.has(key)) continue;
    actions.push({
      key,
      purpose: have.purpose,
      resourceType: have.resourceType,
      provider: have.provider,
      desiredPayloadHash: null,
      currentPayloadHash: have.payloadHash,
      providerResourceId: have.providerResourceId,
      action: "retire",
      reason: "an active recorded resource that the desired state no longer contains",
    });
  }

  // ── DEPENDENCY CASCADE ──
  // If a resource is being REPLACED it will have a new provider id, so
  // everything that references it must be updated even though its own payload
  // did not change. Without this, an agent keeps pointing at a dead engine.
  const replaced = new Set(actions.filter((a) => a.action === "replace").map((a) => a.key));
  if (replaced.size) {
    for (const action of actions) {
      if (action.action !== "no_change") continue;
      const want = desired.resources.find((r) => keyOf(r) === action.key);
      const dependsOnReplaced = (want ? want.dependsOn : []).some((d) => replaced.has(`${d.purpose}:${d.resourceType}`));
      if (dependsOnReplaced) {
        action.action = "update";
        action.reason = "its own payload is unchanged, but a resource it references is being replaced and will have a new provider id";
        action.cascaded = true;
      }
    }
  }

  // Order matters for a future executor: a dependency is provisioned before
  // whatever references it.
  const rank = (a) => (a.resourceType === "response_engine" ? 0 : 1);
  actions.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : 1));

  const counts = {};
  for (const a of actions) counts[a.action] = (counts[a.action] || 0) + 1;
  const mutating = actions.filter((a) => MUTATING_ACTIONS.includes(a.action));

  return Object.freeze({
    ok: true,
    clientId: desired.clientId,
    configVersion: desired.configVersion,
    behaviourHash: desired.behaviourHash,
    desiredHash: desired.desiredHash,
    provider: desired.provider,
    actions: Object.freeze(actions.map(Object.freeze)),
    counts: Object.freeze(counts),
    mutatingCount: mutating.length,
    // The whole point of a no-op proof.
    isNoOp: mutating.length === 0 && !actions.some((a) => a.action === "reconcile_required"),
    requiresReconciliation: actions.some((a) => a.action === "reconcile_required"),
    summary: actions.length === 0
      ? "nothing to do"
      : Object.entries(counts).sort().map(([k, n]) => `${n} ${k}`).join(", "),
  });
}

// ── RECONCILIATION (P21B) ───────────────────────────────────────────
//
// Designed now, fed by fakes. When a real read-only provider observation
// exists it plugs in here and nothing else changes.

/**
 * @param {object|null} recorded  a durable row, or null if AIDA has none
 * @param {object|null} observed  what the provider says, or null for "asked
 *                                and it is not there"; `undefined` means
 *                                "could not ask", which is NOT the same thing
 */
function reconcile({ recorded = null, observed } = {}) {
  const result = (name, detail) => Object.freeze({ result: name, detail, meaning: require("./provisioning-model").RECONCILIATION_MEANING[name] });

  if (observed === undefined) {
    // The distinction that matters: an unreachable provider is UNKNOWN, never
    // "nothing there". Treating it as absent is how a second agent gets made.
    return result("unknown", "the provider could not be asked");
  }
  if (!recorded && !observed) {
    return result("match", "neither side has anything, which is a consistent state");
  }
  if (!recorded && observed) {
    return result("unrecorded_provider_resource",
      `the provider has ${observed.providerResourceId || "a resource"} that AIDA never recorded — never adopt it automatically`);
  }
  if (recorded && !observed) {
    return result("missing_provider_resource",
      `AIDA records ${recorded.providerResourceId || "a resource"} and the provider does not have it`);
  }
  if (recorded.providerResourceId && observed.providerResourceId &&
      recorded.providerResourceId !== observed.providerResourceId) {
    return result("manual_review_required",
      `AIDA records ${recorded.providerResourceId} and the provider reports ${observed.providerResourceId} for the same purpose`);
  }
  if (observed.payloadHash === undefined || observed.payloadHash === null) {
    return result("unknown", "the provider reported the resource but not enough to compare payloads");
  }
  if (recorded.payloadHash !== observed.payloadHash) {
    return result("drift", `recorded ${recorded.payloadHash.slice(0, 12)}…, provider ${String(observed.payloadHash).slice(0, 12)}…`);
  }
  return result("match", "same id, same payload hash");
}

module.exports = { diffProvisioning, reconcile, readCurrent, trustworthiness, RECONCILIATION_RESULTS };
