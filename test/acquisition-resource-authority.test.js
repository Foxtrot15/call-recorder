// LOCKSMITH ACQUISITION E-12F — "has the acquisition agent already been made?"
//
// ── WHY THIS IS THE STAGE THAT MATTERS MOST ─────────────────────────
// E-12E built a runner that can create the agent. A runner that cannot ask
// whether one already exists is a machine for creating a second one, and a
// second AGENT — unlike a second response engine — is a second thing capable
// of telephoning a stranger.
//
// ── WHAT WAS BUILT, AND WHAT WAS FOUND ALREADY BUILT ────────────────
// Almost nothing had to be built. LPM3's provider_resources already carries
// identity, version, payload hash, supersession, failure state — and:
//
//   pr_one_active_per_purpose
//     UNIQUE (client_id, provider, purpose, resource_type) WHERE active
//
// The one-agent guard is therefore a DATABASE INDEX, not an application check
// somebody has to remember to call. The only thing genuinely in the way was
// the `purpose` CHECK constraint, which lists six receptionist/onboarding
// values and would have Postgres reject an acquisition row outright. LPM4
// widens exactly that one constraint and nothing else, and it is NOT APPLIED.
//
// These tests use fakes throughout. No Supabase mutation, no DEV write.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const authority = require("../src/services/acquisition-resource-authority");
const registry = require("../src/services/provider-resource-registry");
const { RESOURCE_PURPOSES } = require("../src/services/voice-platform-port");

const {
  ACQUISITION_CLIENT_ID,
  AGENT_PURPOSE,
  AGENT_RESOURCE_TYPE,
  PROVISIONING_STATES,
  readAcquisitionAgentResource,
  recordAcquisitionAgentResource,
  describeAcquisitionProvisioningState,
  describeAmbiguousCreate,
} = authority;

const AGENT_PAYLOAD = Object.freeze({
  agent_name: "aida-acquisition-agent-fixture",
  response_engine: { type: "retell-llm", llm_id: "llm_fixture" },
  voice_id: "custom_voice_fixture",
  language: "en-AU",
  webhook_url: "https://acq.example.test/webhooks/retell/acquisition",
  voicemail_option: { action: { type: "hangup" } },
  post_call_analysis_data: [],
});

/**
 * An in-memory stand-in for provider_resources that ENFORCES the two things
 * the real table enforces — the partial unique index and the purpose CHECK —
 * because a fake that accepts anything would prove nothing about either.
 */
function fakeResourceTable({ rows = [], purposeCheck = null } = {}) {
  const store = rows.map((r) => ({ ...r }));
  const ALLOWED = purposeCheck || [
    "onboarding_agent", "receptionist_agent", "receptionist_knowledge",
    "receptionist_analysis", "onboarding_analysis", "inbound_binding",
  ];
  const api = {
    _rows: store,
    from() { return api; },
    select() { return api; },
    _filters: {},
    eq(col, val) { api._filters[col] = val; return api; },
    async maybeSingle() {
      const f = api._filters;
      api._filters = {};
      const hit = store.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
      if (hit.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: hit[0] || null, error: null };
    },
    insert(fields) {
      const attempted = { ...fields };
      return {
        select() { return this; },
        async single() {
          // purpose CHECK — what Postgres does today, before LPM4.
          if (!ALLOWED.includes(attempted.purpose)) {
            return { data: null, error: { code: "23514", message: `new row violates check constraint "provider_resources_purpose_check"` } };
          }
          // pr_one_active_per_purpose — the real one-agent guard.
          const clash = store.some(
            (r) => r.active && r.client_id === attempted.client_id && r.provider === attempted.provider &&
                   r.purpose === attempted.purpose && r.resource_type === attempted.resource_type
          );
          if (clash) {
            return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "pr_one_active_per_purpose"` } };
          }
          store.push(attempted);
          return { data: attempted, error: null };
        },
      };
    },
  };
  return api;
}

const withLpm4 = () => fakeResourceTable({
  purposeCheck: ["onboarding_agent", "receptionist_agent", "receptionist_knowledge", "receptionist_analysis",
    "onboarding_analysis", "inbound_binding", "acquisition_agent", "acquisition_response_engine"],
});

// ---------------------------------------------------------------------------
// 1. REUSE, NOT REINVENTION
// ---------------------------------------------------------------------------

describe("E-12F: the durable authority is the existing table", () => {
  it("1. it writes to provider_resources, not a new acquisition table", () => {
    assert.strictEqual(registry.TABLE, "provider_resources");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-resource-authority.js"), "utf8");
    assert.match(src, /require\("\.\/provider-resource-registry"\)/, "reuses the registry helpers");
    assert.ok(!/create table|acquisition_agents/i.test(src), "no second persistence model");
  });

  it("2. no new table was added to the repository", () => {
    const sqlDir = path.join(__dirname, "..", "supabase", "sql");
    const lpm4 = fs.readFileSync(path.join(sqlDir, "lpm4_acquisition_provider_resources.sql"), "utf8");
    assert.ok(!/create table/i.test(lpm4), "LPM4 creates no table");
    assert.ok(!/create (unique )?index/i.test(lpm4.split("-- ROLLBACK")[0].replace(/^--.*$/gm, "")), "and no index");
    assert.match(lpm4, /add constraint provider_resources_purpose_check/);
  });

  it("3. the one-agent guard is a DATABASE index, not an app check", () => {
    const lpm3 = fs.readFileSync(path.join(__dirname, "..", "supabase", "sql", "lpm3_create_retell_provisioning.sql"), "utf8");
    assert.match(lpm3, /create unique index if not exists pr_one_active_per_purpose/);
    assert.match(lpm3, /on public\.provider_resources \(client_id, provider, purpose, resource_type\)/);
    assert.match(lpm3, /where active = true/);
  });

  it("4. both purpose allowlists carry the acquisition values", () => {
    for (const list of [registry.PURPOSES, RESOURCE_PURPOSES]) {
      assert.ok(list.includes("acquisition_agent"));
      assert.ok(list.includes("acquisition_response_engine"));
    }
  });

  it("5. naming a purpose provisions nothing — acquisition stays out of the plan order", () => {
    const plan = fs.readFileSync(path.join(__dirname, "..", "src", "services", "provisioning-plan.js"), "utf8");
    assert.ok(!/acquisition/i.test(plan), "provisioning-plan.js must never mention acquisition");
  });

  it("6. acquisition uses a reserved client sentinel, never a real tenant", () => {
    assert.strictEqual(ACQUISITION_CLIENT_ID, "aida-acquisition");
    assert.ok(!["default", "demo-locksmith", ""].includes(ACQUISITION_CLIENT_ID));
  });
});

// ---------------------------------------------------------------------------
// 2. THE STATE MACHINE
// ---------------------------------------------------------------------------

describe("E-12F: what the authority says, and what it permits", () => {
  it("7. no row means not provisioned, and creating is allowed", () => {
    const s = describeAcquisitionProvisioningState(null);
    assert.strictEqual(s.state, PROVISIONING_STATES.NOT_PROVISIONED);
    assert.strictEqual(s.mayCreate, true);
  });

  it("8. a recorded agent refuses further creation", () => {
    const s = describeAcquisitionProvisioningState({ provider_resource_id: "agent_abc", active: true });
    assert.strictEqual(s.state, PROVISIONING_STATES.PROVISIONED);
    assert.strictEqual(s.mayCreate, false);
    assert.strictEqual(s.providerResourceId, "agent_abc");
  });

  it("9. a known id with no row is RECONCILIATION_REQUIRED — the dangerous state", () => {
    // The provider succeeded and persistence failed. The agent exists and
    // nothing here knows about it except this id.
    const s = describeAcquisitionProvisioningState(null, { knownProviderId: "agent_orphan" });
    assert.strictEqual(s.state, PROVISIONING_STATES.RECONCILIATION_REQUIRED);
    assert.strictEqual(s.mayCreate, false, "creating another would be the catastrophe");
    assert.strictEqual(s.providerResourceId, "agent_orphan");
    assert.match(s.reason, /Do NOT create another agent/i);
  });

  it("10. an ambiguous create is UNKNOWN, never a retry", () => {
    const s = describeAmbiguousCreate({ providerRequestId: "req_1" });
    assert.strictEqual(s.state, PROVISIONING_STATES.UNKNOWN);
    assert.strictEqual(s.retry, false);
    assert.strictEqual(s.mayCreate, false);
    assert.match(s.reason, /Do NOT retry/i);
  });

  it("11. every state that is not NOT_PROVISIONED forbids creating", () => {
    const states = [
      describeAcquisitionProvisioningState({ provider_resource_id: "a" }),
      describeAcquisitionProvisioningState(null, { knownProviderId: "b" }),
      describeAmbiguousCreate({}),
    ];
    for (const s of states) assert.strictEqual(s.mayCreate, false, s.state);
  });
});

// ---------------------------------------------------------------------------
// 3. READING AND WRITING, AGAINST A FAKE THAT ENFORCES THE REAL CONSTRAINTS
// ---------------------------------------------------------------------------

describe("E-12F: reads and writes behave against the real constraints", () => {
  it("12. an empty table reads as null", async () => {
    assert.strictEqual(await readAcquisitionAgentResource({ client: withLpm4() }), null);
  });

  it("13. an active acquisition agent is found", async () => {
    const client = withLpm4();
    client._rows.push({
      client_id: ACQUISITION_CLIENT_ID, provider: "retell", purpose: AGENT_PURPOSE,
      resource_type: AGENT_RESOURCE_TYPE, active: true, provider_resource_id: "agent_live",
    });
    const row = await readAcquisitionAgentResource({ client });
    assert.strictEqual(row.provider_resource_id, "agent_live");
  });

  it("14. a SUPERSEDED agent does not answer 'one exists'", async () => {
    const client = withLpm4();
    client._rows.push({
      client_id: ACQUISITION_CLIENT_ID, provider: "retell", purpose: AGENT_PURPOSE,
      resource_type: AGENT_RESOURCE_TYPE, active: false, provider_resource_id: "agent_old",
    });
    assert.strictEqual(await readAcquisitionAgentResource({ client }), null, "history is not a current answer");
  });

  it("15. a receptionist agent is NOT mistaken for the acquisition one", async () => {
    const client = withLpm4();
    client._rows.push({
      client_id: "demo-locksmith", provider: "retell", purpose: "receptionist_agent",
      resource_type: "voice_agent", active: true, provider_resource_id: "agent_receptionist",
    });
    assert.strictEqual(await readAcquisitionAgentResource({ client }), null);
  });

  it("16. an unreadable authority THROWS rather than answering 'none'", async () => {
    // Answering null on an error would read as "no agent exists" and permit a
    // create. The failure must propagate.
    const broken = { from() { return this; }, select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: null, error: { message: "connection refused" } }; } };
    await assert.rejects(() => readAcquisitionAgentResource({ client: broken }), /unreadable/i);
  });

  it("17. recording succeeds once and stores the payload hash", async () => {
    const client = withLpm4();
    const row = await recordAcquisitionAgentResource({ client, providerResourceId: "agent_new", payload: AGENT_PAYLOAD, providerTag: "staging" });
    assert.strictEqual(row.provider_resource_id, "agent_new");
    assert.strictEqual(row.purpose, AGENT_PURPOSE);
    assert.strictEqual(row.resource_type, AGENT_RESOURCE_TYPE);
    assert.strictEqual(row.client_id, ACQUISITION_CLIENT_ID);
    assert.strictEqual(row.active, true);
    assert.strictEqual(row.payload_hash.length, 64, "the exact payload that was sent, hashed");
    assert.strictEqual(row.provider_tag, "staging");
  });

  it("18. a SECOND record is refused by the database index, not by us", async () => {
    const client = withLpm4();
    await recordAcquisitionAgentResource({ client, providerResourceId: "agent_1", payload: AGENT_PAYLOAD });
    await assert.rejects(
      () => recordAcquisitionAgentResource({ client, providerResourceId: "agent_2", payload: AGENT_PAYLOAD }),
      /could not be recorded/i
    );
    assert.strictEqual(client._rows.filter((r) => r.purpose === AGENT_PURPOSE).length, 1, "one agent, ever");
  });

  it("19. recording without a confirmed provider id is refused", async () => {
    await assert.rejects(
      () => recordAcquisitionAgentResource({ client: withLpm4(), providerResourceId: null, payload: AGENT_PAYLOAD }),
      /only recorded after a confirmed provider success/i
    );
  });

  it("20. recording without the sent payload is refused", async () => {
    await assert.rejects(
      () => recordAcquisitionAgentResource({ client: withLpm4(), providerResourceId: "agent_x", payload: null }),
      /requires the exact payload/i
    );
  });
});

// ---------------------------------------------------------------------------
// 4. THE MIGRATION IS NOT APPLIED, AND THE FAILURE IS HONEST
// ---------------------------------------------------------------------------

describe("E-12F: before LPM4 is applied, Postgres refuses — loudly", () => {
  it("21. an insert against today's constraint fails with the check violation", async () => {
    // This is the CURRENT state of DEV: the purpose CHECK still lists six values.
    const preLpm4 = fakeResourceTable();
    await assert.rejects(
      () => recordAcquisitionAgentResource({ client: preLpm4, providerResourceId: "agent_x", payload: AGENT_PAYLOAD }),
      (err) => {
        assert.match(err.message, /could not be recorded/i);
        assert.match(err.message, /provider_resources_purpose_check/);
        assert.strictEqual(err.requiredMigration, authority.REQUIRED_MIGRATION);
        return true;
      }
    );
    assert.strictEqual(preLpm4._rows.length, 0, "nothing stored");
  });

  it("22. the required migration is named on the error, so the fix is discoverable", () => {
    assert.strictEqual(authority.REQUIRED_MIGRATION, "supabase/sql/lpm4_acquisition_provider_resources.sql");
    assert.ok(fs.existsSync(path.join(__dirname, "..", authority.REQUIRED_MIGRATION)), "and the file exists");
  });

  it("23. LPM4 widens the constraint and preserves every existing value", () => {
    const lpm4 = fs.readFileSync(path.join(__dirname, "..", authority.REQUIRED_MIGRATION), "utf8");
    for (const kept of ["onboarding_agent", "receptionist_agent", "receptionist_knowledge", "receptionist_analysis", "onboarding_analysis", "inbound_binding"]) {
      assert.ok(lpm4.includes(`'${kept}'`), `${kept} must remain permitted`);
    }
    assert.ok(lpm4.includes("'acquisition_agent'"));
    assert.ok(lpm4.includes("'acquisition_response_engine'"));
  });

  it("24. LPM4 discovers the constraint name rather than assuming it", () => {
    // The LPM3 constraint is inline and therefore auto-named by Postgres.
    const lpm4 = fs.readFileSync(path.join(__dirname, "..", authority.REQUIRED_MIGRATION), "utf8");
    assert.match(lpm4, /from pg_constraint/);
    assert.match(lpm4, /execute format\('alter table public\.provider_resources drop constraint %I'/);
  });

  it("25. LPM4 performs no data change and is reversible", () => {
    const lpm4 = fs.readFileSync(path.join(__dirname, "..", authority.REQUIRED_MIGRATION), "utf8");
    const executable = lpm4.split(/^-- =+$/m).map((s) => s).join("\n").replace(/^\s*--.*$/gm, "");
    assert.ok(!/\b(insert|update|delete|truncate|drop table)\b/i.test(executable), "no data change");
    assert.match(lpm4, /ROLLBACK/);
  });
});

// ---------------------------------------------------------------------------
// 5. THE RUNNER USES THIS AUTHORITY
// ---------------------------------------------------------------------------

describe("E-12F: the E-12E runner is wired to the guard", () => {
  const scriptSrc = () => fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", "acquisition-provision-agent.js"), "utf8");

  it("26. it reads the authority before deciding anything", () => {
    assert.match(scriptSrc(), /readAcquisitionAgentResource/);
  });

  it("27. it refuses to create when the guard cannot be read", () => {
    assert.match(scriptSrc(), /REFUSED — THE ONE-AGENT GUARD IS NOT AVAILABLE/);
  });

  it("28. it records only after a confirmed success", () => {
    const src = scriptSrc();
    const recordAt = src.indexOf("recordAcquisitionAgentResource");
    const successAt = src.indexOf("CREATED");
    assert.ok(successAt > 0 && recordAt > successAt, "the record happens after the provider confirmed");
  });

  it("29. an existing record makes the assessment refuse", () => {
    const { assessAcquisitionAgentProvisioning, REFUSALS } = require("../src/services/acquisition-agent-provisioning");
    const env = {
      RETELL_ALLOWED_TAG: "staging", RETELL_ACQUISITION_LLM_ID: "llm_x",
      RETELL_ACQUISITION_VOICE_ID: "voice_x",
      RETELL_ACQUISITION_WEBHOOK_URL: "https://acq.example.test/webhooks/retell/acquisition",
    };
    const v = assessAcquisitionAgentProvisioning({ env, existingResource: { provider_resource_id: "agent_here" } });
    assert.ok(v.refusals.includes(REFUSALS.ALREADY_PROVISIONED));
    assert.strictEqual(v.payload, null);
  });

  it("30. the authority imports nothing that can reach Retell", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-resource-authority.js"), "utf8");
    assert.ok(!/retell-adapter|fetch\(|axios|node-fetch/.test(src));
  });

  it("31. and it is importable with no database configured at all", () => {
    const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_KEY };
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;
      const abs = require.resolve("../src/services/acquisition-resource-authority");
      delete require.cache[abs];
      assert.doesNotThrow(() => require(abs));
    } finally {
      if (saved.u) process.env.SUPABASE_URL = saved.u;
      if (saved.k) process.env.SUPABASE_SERVICE_KEY = saved.k;
    }
  });
});
