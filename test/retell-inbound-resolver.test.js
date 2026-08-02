// AIDA — M7F-B1: inbound client resolution.
//
// NO TEST HERE TOUCHES A DATABASE OR CONTACTS RETELL. The resolver's whole data
// access is injected, so every case below is a deterministic fixture.
//
// The tests that matter most are the REFUSALS. A resolver that returns an answer
// for every input would be easy to write and catastrophic in production: the
// failure mode is not an error message, it is one locksmith's caller being
// offered another locksmith's transfer number, on a call that sounds normal.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { createInboundResolver, RESOLUTION, EXPECTED_PURPOSE, EXPECTED_RESOURCE_TYPE } = require("../src/services/retell-inbound-resolver");

const SILENT = { log() {}, error() {} };

const AGENT = "agent_m7fb1_fixture_0001";
// ACMA fictitious range only.
const TRANSFER_A = "+61491570006";
const TRANSFER_B = "+61491570099";

function row(overrides = {}) {
  return {
    client_id: "client-alpha",
    provider: "retell",
    resource_type: EXPECTED_RESOURCE_TYPE,
    purpose: EXPECTED_PURPOSE,
    provider_resource_id: AGENT,
    provider_version: "0",
    provider_tag: "dev",
    active: true,
    profile_version: 3,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function profile(transferPrimary = TRANSFER_A, transferBackup = null) {
  return {
    version: 3,
    status: "approved",
    profile: { transfer: { primaryNumber: transferPrimary, backupNumber: transferBackup } },
  };
}

/** The injected data-access boundary, as fixtures. */
function access({ rows = [row()], approved = profile(), clientStatus = undefined, throwOn = null } = {}) {
  const api = {
    async findResourcesByProviderId(agentId, opts) {
      if (throwOn === "registry") throw new Error("provider provisioning tables not provisioned");
      api.lastLookup = { agentId, opts };
      return rows;
    },
    async getApprovedProfile(clientId) {
      if (throwOn === "profile") throw new Error("profile store unreachable");
      api.lastProfileLookup = clientId;
      return typeof approved === "function" ? approved(clientId) : approved;
    },
  };
  if (clientStatus !== undefined) {
    api.getClientStatus = async () => {
      if (throwOn === "clientStatus") throw new Error("client store unreachable");
      return clientStatus;
    };
  }
  return api;
}

function resolver(opts = {}, { expectedTag = "dev" } = {}) {
  return createInboundResolver({ access: access(opts), expectedTag, logger: SILENT });
}

// ── The happy path ──────────────────────────────────────────────────

describe("resolving a known agent", () => {
  test("one active row resolves to exactly one client", async () => {
    const r = await resolver()({ agentId: AGENT, agentVersion: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.resolution, RESOLUTION.resolved);
    assert.equal(r.clientId, "client-alpha");
    assert.equal(r.context.transferPrimary, TRANSFER_A);
    assert.equal(r.context.profileVersion, 3);
    assert.equal(r.context.environment, "dev");
  });

  test("it queries for a receptionist voice agent specifically", async () => {
    const a = access();
    await createInboundResolver({ access: a, expectedTag: "dev", logger: SILENT })({ agentId: AGENT });
    assert.equal(a.lastLookup.agentId, AGENT);
    assert.equal(a.lastLookup.opts.purpose, EXPECTED_PURPOSE);
    assert.equal(a.lastLookup.opts.resourceType, EXPECTED_RESOURCE_TYPE);
    assert.equal(a.lastLookup.opts.provider, "retell");
  });

  test("only the minimum domain data is returned", async () => {
    const r = await resolver()({ agentId: AGENT });
    assert.deepEqual(
      Object.keys(r.context).sort(),
      ["callId", "clientId", "environment", "profileVersion", "transferBackup", "transferPrimary"]
    );
    // The whole approved profile must not travel: handing the inbound path a
    // business's entire configuration puts it one mistake from a provider payload.
    assert.equal(r.context.profile, undefined);
    assert.equal(r.context.hours, undefined);
    assert.equal(r.context.pricing, undefined);
  });

  test("the result is deterministic", async () => {
    const a = await resolver()({ agentId: AGENT });
    const b = await resolver()({ agentId: AGENT });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("a call id is carried as provenance and never used to decide ownership", async () => {
    const withCall = await resolver()({ agentId: AGENT, callId: "call_provenance_only" });
    const without = await resolver()({ agentId: AGENT });
    assert.equal(withCall.clientId, without.clientId);
    assert.equal(withCall.context.callId, "call_provenance_only");
  });
});

// ── Refusals ────────────────────────────────────────────────────────

describe("refusing rather than guessing", () => {
  test("an unknown agent resolves to nothing", async () => {
    const r = await resolver({ rows: [] })({ agentId: AGENT });
    assert.equal(r.ok, false);
    assert.equal(r.resolution, RESOLUTION.unknownAgent);
    assert.equal(r.clientId, null);
    assert.equal(r.context, null);
  });

  test("a missing agent id resolves to nothing", async () => {
    for (const bad of [undefined, null, "", 42]) {
      const r = await resolver()({ agentId: bad });
      assert.equal(r.resolution, RESOLUTION.unknownAgent, `${JSON.stringify(bad)} must not resolve`);
    }
  });

  test("TWO CLIENTS claiming one agent is refused, not arbitrated", async () => {
    // The database permits this: pr_one_active_per_purpose is unique on
    // (client_id, provider, purpose, resource_type), which constrains one agent
    // PER CLIENT and says nothing about one client per agent.
    const rows = [
      row({ client_id: "client-alpha", created_at: "2026-08-02T00:00:00.000Z" }),
      row({ client_id: "client-beta", created_at: "2026-08-01T00:00:00.000Z" }),
    ];
    const r = await resolver({ rows })({ agentId: AGENT });
    assert.equal(r.ok, false);
    assert.equal(r.resolution, RESOLUTION.ambiguousAgent);
    assert.equal(r.clientId, null);
    assert.equal(r.context, null);
    // Emphatically NOT "the newest wins" or "the first wins".
    assert.equal(JSON.stringify(r).includes("client-alpha"), false);
    assert.equal(JSON.stringify(r).includes("client-beta"), false);
  });

  test("duplicate active rows for ONE client are also refused", async () => {
    // Should be impossible while the partial unique index exists. If it happens,
    // the index is missing and the data cannot be trusted.
    const rows = [row(), row({ profile_version: 4 })];
    const r = await resolver({ rows })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.ambiguousAgent);
  });

  test("a row naming no client is refused", async () => {
    const r = await resolver({ rows: [row({ client_id: null })] })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.ambiguousAgent);
  });

  test("a superseded agent is distinguished from an unknown one", async () => {
    const rows = [row({ active: false, superseded_at: "2026-08-01T12:00:00.000Z" })];
    const r = await resolver({ rows })({ agentId: AGENT });
    assert.equal(r.ok, false);
    // Distinct because the fix is different: a stale number binding still points
    // at a retired agent, which is an operator action, not a mystery.
    assert.equal(r.resolution, RESOLUTION.supersededAgent);
    assert.notEqual(r.resolution, RESOLUTION.unknownAgent);
  });

  test("a superseded row never resolves even alongside its replacement's absence", async () => {
    const rows = [row({ active: false, superseded_at: "x" }), row({ active: false, superseded_at: "y", client_id: "client-beta" })];
    const r = await resolver({ rows })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.supersededAgent);
    assert.equal(r.clientId, null);
  });

  test("an inactive client is refused", async () => {
    const r = await resolver({ clientStatus: { active: false } })({ agentId: AGENT });
    assert.equal(r.ok, false);
    assert.equal(r.resolution, RESOLUTION.inactiveClient);
  });

  test("an active client passes, and an absent status check is treated as active", async () => {
    assert.equal((await resolver({ clientStatus: { active: true } })({ agentId: AGENT })).ok, true);
    assert.equal((await resolver()({ agentId: AGENT })).ok, true);
  });

  test("no approved profile means no client-specific values", async () => {
    for (const approved of [null, { version: 4, status: "draft", profile: {} }, { version: 4, status: "needs_review", profile: {} }]) {
      const r = await resolver({ approved })({ agentId: AGENT });
      assert.equal(r.ok, false, `${JSON.stringify(approved)} must not resolve`);
      assert.equal(r.resolution, RESOLUTION.unapprovedProfile);
    }
  });

  test("a registry outage is reported as an outage, not as an unknown agent", async () => {
    const r = await resolver({ throwOn: "registry" })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.registryUnavailable);
    // Conflating these would turn a database problem into a silent
    // misclassification, and the two need different operator responses.
    assert.notEqual(r.resolution, RESOLUTION.unknownAgent);
  });

  test("a profile-store outage is also an outage", async () => {
    const r = await resolver({ throwOn: "profile" })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.registryUnavailable);
  });

  test("no refusal ever names a tenant", async () => {
    const cases = [
      { rows: [] },
      { rows: [row({ active: false, superseded_at: "x" })] },
      { approved: null },
      { clientStatus: { active: false } },
      { throwOn: "registry" },
    ];
    for (const c of cases) {
      const r = await resolver(c)({ agentId: AGENT });
      assert.equal(r.clientId, null);
      assert.equal(JSON.stringify(r).includes("client-alpha"), false, `${JSON.stringify(c)} leaked a client id`);
    }
  });
});

// ── Environment separation ──────────────────────────────────────────

describe("environment separation", () => {
  test("a prod-tagged resource is refused by a dev deployment", async () => {
    const r = await resolver({ rows: [row({ provider_tag: "prod" })] }, { expectedTag: "dev" })({ agentId: AGENT });
    assert.equal(r.ok, false);
    assert.equal(r.resolution, RESOLUTION.wrongEnvironment);
  });

  test("a dev-tagged resource is refused by a prod deployment", async () => {
    const r = await resolver({ rows: [row({ provider_tag: "dev" })] }, { expectedTag: "prod" })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.wrongEnvironment);
  });

  test("an untagged resource is refused when a tag is expected", async () => {
    const r = await resolver({ rows: [row({ provider_tag: null })] }, { expectedTag: "dev" })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.wrongEnvironment);
  });

  test("the environment is checked BEFORE any client data is read", async () => {
    const a = access({ rows: [row({ provider_tag: "prod" })] });
    const r = await createInboundResolver({ access: a, expectedTag: "dev", logger: SILENT })({ agentId: AGENT });
    assert.equal(r.resolution, RESOLUTION.wrongEnvironment);
    // A cross-environment request must not even cause a profile read.
    assert.equal(a.lastProfileLookup, undefined);
  });
});

// ── Version drift ───────────────────────────────────────────────────

describe("agent version drift", () => {
  test("a version mismatch resolves but is flagged", async () => {
    // The agent was updated at the provider since we recorded it. The IDENTITY
    // is not in doubt — same id, same resource — so refusing would degrade a
    // real call over a bookkeeping difference.
    const r = await resolver({ rows: [row({ provider_version: "0" })] })({ agentId: AGENT, agentVersion: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.versionDrift, true);
    assert.equal(r.clientId, "client-alpha");
  });

  test("a matching version is not flagged", async () => {
    const r = await resolver({ rows: [row({ provider_version: "2" })] })({ agentId: AGENT, agentVersion: 2 });
    assert.equal(r.versionDrift, false);
  });

  test("an absent version on either side is not drift", async () => {
    assert.equal((await resolver({ rows: [row({ provider_version: null })] })({ agentId: AGENT, agentVersion: 3 })).versionDrift, false);
    assert.equal((await resolver()({ agentId: AGENT, agentVersion: null })).versionDrift, false);
  });

  test("drift is NOT the same as superseded", async () => {
    const drift = await resolver({ rows: [row({ provider_version: "0" })] })({ agentId: AGENT, agentVersion: 9 });
    const superseded = await resolver({ rows: [row({ active: false, superseded_at: "x" })] })({ agentId: AGENT });
    assert.equal(drift.ok, true);
    assert.equal(superseded.ok, false);
  });
});

// ── Trust boundary ──────────────────────────────────────────────────

describe("what the resolver refuses to trust", () => {
  test("a client id supplied by the caller is ignored entirely", async () => {
    const a = access();
    const resolve = createInboundResolver({ access: a, expectedTag: "dev", logger: SILENT });
    const r = await resolve({
      agentId: AGENT,
      // None of these are parameters. Passing them must change nothing.
      clientId: "client-attacker",
      client_id: "client-attacker",
      dynamic_variables: { aida_client_id: "client-attacker" },
      metadata: { aida_client_id: "client-attacker" },
    });
    assert.equal(r.clientId, "client-alpha", "ownership comes from the registry, never from the request");
    assert.equal(JSON.stringify(r).includes("client-attacker"), false);
  });

  test("ownership is never inferred from prose", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-inbound-resolver"), "utf8");
    // No business-name, phone-text or prompt matching anywhere in the decision.
    assert.equal(/businessName|business_name|spokenName|from_number|fromNumber/.test(source), false);
    assert.equal(/general_prompt|knowledge/.test(source), false);
  });

  test("one client's transfer number can never reach another client's call", async () => {
    const rows = [
      row({ client_id: "client-alpha" }),
      row({ client_id: "client-beta" }),
    ];
    const approved = (clientId) => (clientId === "client-alpha" ? profile(TRANSFER_A) : profile(TRANSFER_B));
    const r = await resolver({ rows, approved })({ agentId: AGENT });
    // Ambiguous, so NEITHER number is emitted.
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes(TRANSFER_A), false);
    assert.equal(JSON.stringify(r).includes(TRANSFER_B), false);
  });

  test("the resolver imports no database and no Express", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-inbound-resolver"), "utf8");
    // The default access factory lazily requires the stores INSIDE functions;
    // nothing is required at module scope.
    for (const line of source.split("\n")) {
      if (/^\s/.test(line)) continue;
      assert.equal(/require\(["'](express|\.\/supabase)["']\)/.test(line), false, "no transport or database at module scope");
    }
    // Word-bounded on purpose: a bare /res\./ matches "resource", "result",
    // "resolution" and "response", which this file is full of.
    assert.equal(
      /\breq\.(body|headers|params|query)\b|\bres\.(status|json|send|end)\b/.test(source),
      false,
      "the resolver must not touch Express objects"
    );
  });

  test("it builds no second identity model — the registry is the source", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-inbound-resolver"), "utf8");
    assert.match(source, /provider-resource-registry/);
    assert.equal(/create table|CREATE TABLE|new Map\(\)\s*;\s*\/\/\s*agents/.test(source), false);
  });
});
