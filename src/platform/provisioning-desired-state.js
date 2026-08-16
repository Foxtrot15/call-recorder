// AIDA PLATFORM — what SHOULD exist at the provider (P20).
//
//   compileDesiredState({ version, providerRefs, provider })
//     -> { ok, clientId, configVersion, behaviourHash, resources[], desiredHash }
//
// Answers one question, and only asks it of local objects:
//
//   "What provider resources should exist for this active configuration?"
//
// ── PURE, AND STRUCTURALLY SO ───────────────────────────────────────
// No network, no provider client, no environment. It composes the behaviour
// compiler and the Retell payload compiler — both of which import no transport
// — and produces a description. A ratchet reads this file's imports.
//
// ── DETERMINISTIC ───────────────────────────────────────────────────
// Same active configuration, same desired set, same hashes, forever. That is
// what makes "nothing has changed, do nothing" a provable answer rather than a
// hopeful one, and it is why re-planning an untouched client produces
// NO_CHANGE instead of a fresh CREATE.
//
// ── TRACEABILITY IS BUILT IN, NOT BOLTED ON (P20A) ──────────────────
// Every desired resource carries the chain that produced it:
//
//   clientId -> configVersion -> behaviourHash -> payloadHash
//
// so "which active client configuration produced this provider resource?" is
// answerable from the resource itself. The chain is recorded in
// provider_resources.provider_metadata at execution time, which needs no
// schema change — provider_metadata already exists and is bounded.
//
// A resource is never mutated in a way that makes its recorded provenance
// lie: a changed payload is a new payloadHash and therefore a new action, not
// a quiet edit under the old provenance.

const crypto = require("crypto");
const { stableStringify } = require("./stable-json");
const { compileBehaviourSpec } = require("./behaviour-spec");
const { compileRetellPreview } = require("./provider-compiler-retell");
const { PRODUCED_SHAPES, validateDesiredResource } = require("./provisioning-model");

const sha = (value) => crypto.createHash("sha256").update(stableStringify(value)).digest("hex");

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });

/**
 * A dependency hash covers what this resource DEPENDS ON, separately from what
 * it contains. It is what lets the diff engine notice "the agent's own payload
 * is unchanged, but the engine it points at was replaced, so the agent must be
 * updated anyway" — a cascade that is invisible if you only hash payloads.
 */
function dependencyHashFor(dependsOn, byKey) {
  if (!dependsOn.length) return sha([]);
  return sha(
    dependsOn
      .map((d) => {
        const target = byKey.get(`${d.purpose}:${d.resourceType}`);
        return { purpose: d.purpose, resourceType: d.resourceType, payloadHash: target ? target.payloadHash : null };
      })
      .sort((a, b) => (a.purpose + a.resourceType < b.purpose + b.resourceType ? -1 : 1)),
  );
}

/**
 * @param {object} version       an ACTIVE (or approved) blueprint version
 * @param {object} providerRefs  deployment facts, injected — never invented
 * @param {string} provider      "retell" | "mock" | "dry_run"
 * @param {string} direction     which agent this describes; inbound for a receptionist
 */
function compileDesiredState({ version, providerRefs = {}, provider = "retell", direction = "inbound" } = {}) {
  if (!version || typeof version !== "object") {
    return fail("no_version", "compileDesiredState requires a configuration version");
  }
  const clientId = version.identity && version.identity.clientId;
  const configVersion = version.metadata && version.metadata.configVersion;
  if (!clientId) return fail("no_client", "the version carries no identity.clientId");
  if (!Number.isInteger(configVersion) || configVersion < 1) {
    return fail("no_config_version", "the version carries no usable metadata.configVersion");
  }

  const { spec, behaviourHash } = compileBehaviourSpec(version);
  const compiled = compileRetellPreview({ spec, providerRefs, direction });

  // Two resources, in dependency order: the engine holds the prompt, the agent
  // references it. PRODUCED_SHAPES declares which shapes this batch builds and
  // records WHY the others are absent, so a reader can tell a decision from an
  // oversight.
  const payloadFor = {
    "receptionist_agent:response_engine": compiled.responseEngine,
    "receptionist_agent:voice_agent": compiled.agent,
  };
  const hashFor = {
    "receptionist_agent:response_engine": compiled.responseEngineHash,
    "receptionist_agent:voice_agent": compiled.agentHash,
  };

  const byKey = new Map();
  const resources = [];

  for (const shape of PRODUCED_SHAPES) {
    const key = `${shape.purpose}:${shape.resourceType}`;
    const payload = payloadFor[key];
    if (!payload) {
      return fail("unbuilt_shape", `no payload was compiled for ${key} — the model and the compiler disagree`);
    }
    const resource = {
      clientId,
      configVersion,
      behaviourHash,
      provider,
      purpose: shape.purpose,
      resourceType: shape.resourceType,
      direction,
      payload,
      payloadHash: hashFor[key],
      dependsOn: shape.dependsOn,
      dependencyHash: dependencyHashFor(shape.dependsOn, byKey),
      // Provenance travels WITH the resource. Recorded into
      // provider_resources.provider_metadata at execution time.
      provenance: Object.freeze({
        producedBy: "aida-client-platform",
        clientId,
        configVersion,
        behaviourHash,
        payloadHash: hashFor[key],
        schemaVersion: version.schemaVersion ?? null,
        compilerVersion: compiled.compilerVersion,
        specVersion: spec.specVersion,
      }),
    };
    const check = validateDesiredResource(resource);
    if (!check.ok) {
      return fail("invalid_desired_resource", `${key} is not a valid desired resource`, { errors: check.errors });
    }
    byKey.set(key, resource);
    resources.push(Object.freeze(resource));
  }

  return Object.freeze({
    ok: true,
    clientId,
    configVersion,
    behaviourHash,
    provider,
    direction,
    // Deployment facts that are still missing. A desired set can be COMPUTED
    // without them — the payload simply carries nulls where an id belongs —
    // but a plan built from it must never be executable, and the readiness
    // view says so by name.
    unresolved: compiled.unresolved,
    ready: compiled.ready,
    resources: Object.freeze(resources),
    // The whole desired set, in one hash. Two runs over one active version
    // must produce the same value; that is what makes a no-op provable.
    desiredHash: sha(
      resources.map((r) => ({
        purpose: r.purpose,
        resourceType: r.resourceType,
        payloadHash: r.payloadHash,
        dependencyHash: r.dependencyHash,
      })),
    ),
    // Declared here so a reader of a plan can see what was deliberately NOT
    // provisioned, without reading the model.
    deliberatelyAbsent: Object.freeze(
      require("./provisioning-model").CLIENT_RESOURCE_SHAPES
        .filter((s) => !s.produced)
        .map((s) => Object.freeze({ purpose: s.purpose, resourceType: s.resourceType, why: s.why })),
    ),
  });
}

module.exports = { compileDesiredState, dependencyHashFor };
