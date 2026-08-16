// AIDA PLATFORM P15 — ONE contract, both stores.
//
// The in-memory store is the executable specification for the durable one. If
// they can diverge, the durable store will diverge in production and no test
// will notice — so every property that is genuinely a contract is asserted
// once, here, against both implementations.
//
// The Postgres side runs against test/helpers/fake-postgres.js, which enforces
// the constraints acp1_create_client_configuration.sql declares and raises the
// same SQLSTATE codes. That is what makes this suite meaningful rather than a
// stub agreeing with itself: a rule the migration declares and the adapter
// mishandles fails HERE.
//
// No live database. No network. No Supabase client is imported anywhere.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { runStoreContract, fixedClock } = require("./helpers/blueprint-store-contract");
const { createFakePostgres, ENFORCED_CONSTRAINTS, PgError } = require("./helpers/fake-postgres");

const { createBlueprintAuthority, createInMemoryBlueprintStore } = require("../src/platform/blueprint-authority");
const {
  createPostgresBlueprintStore, toRow, fromRow, contentHashOf, bodyOf, describeDbError,
  VERSIONS_TABLE, EVENTS_TABLE,
} = require("../src/platform/blueprint-store-postgres");
const fixtures = require("../src/platform/fixtures/clients");
const { locksmithA, plumberC } = fixtures;

const ROOT = path.join(__dirname, "..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase", "sql", "acp1_create_client_configuration.sql"), "utf8");

// ════════════════════════════════════════════════════════════════════
// THE CONTRACT, TWICE
// ════════════════════════════════════════════════════════════════════

runStoreContract({
  describe, it, assert, fixtures, createBlueprintAuthority,
  name: "in-memory",
  makeStore: () => ({ store: createInMemoryBlueprintStore(), now: fixedClock() }),
});

runStoreContract({
  describe, it, assert, fixtures, createBlueprintAuthority,
  name: "postgres",
  makeStore: () => {
    const now = fixedClock();
    return { store: createPostgresBlueprintStore({ db: createFakePostgres(), now }), now };
  },
});

// ════════════════════════════════════════════════════════════════════
// THE HARNESS ITSELF MUST NOT BE A LIE
// ════════════════════════════════════════════════════════════════════

describe("store contract — the suite is genuinely running against both", () => {
  it("both stores exist and report different kinds", () => {
    const memory = createInMemoryBlueprintStore();
    const postgres = createPostgresBlueprintStore({ db: createFakePostgres(), now: fixedClock() });
    assert.equal(memory.kind, "memory");
    assert.equal(postgres.kind, "postgres");
  });

  it("both implement the same four-method contract", () => {
    const memory = createInMemoryBlueprintStore();
    const postgres = createPostgresBlueprintStore({ db: createFakePostgres(), now: fixedClock() });
    for (const method of ["listVersions", "getVersion", "putVersion", "replaceVersion"]) {
      assert.equal(typeof memory[method], "function", `in-memory is missing ${method}`);
      assert.equal(typeof postgres[method], "function", `postgres is missing ${method}`);
    }
  });

  it("the contract suite would FAIL against a store that quietly does nothing", async () => {
    // Proof of non-vacuity: a store that accepts writes and forgets them must
    // not be able to pass. If this ever stops throwing, the suite is asserting
    // nothing.
    const amnesiac = {
      kind: "amnesiac",
      async listVersions() { return []; },
      async getVersion() { return null; },
      async putVersion(v) { return v; },
      async replaceVersion(v) { return v; },
    };
    const authority = createBlueprintAuthority({ store: amnesiac, now: fixedClock() });
    const created = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
    assert.equal(created.ok, true);
    const read = await authority.getDraft("northside_locks", created.version.metadata.configVersion);
    assert.equal(read.ok, false, "an amnesiac store must fail the very first contract assertion");
  });

  it("the fake enforces every constraint the migration declares", () => {
    // Drift guard. A constraint added to the SQL and forgotten in the fake
    // means the contract suite silently stops testing it.
    const declaredInSql = [...MIGRATION.matchAll(/constraint\s+(pcv_[a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    const indexesInSql = [...MIGRATION.matchAll(/create unique index if not exists\s+(pcv_[a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    const triggersInSql = [...MIGRATION.matchAll(/function public\.(pcv_[a-z_]+|pce_[a-z_]+)\(\)/gi)].map((m) => m[1].toLowerCase());

    const sqlNames = new Set([...declaredInSql, ...indexesInSql, ...triggersInSql]);
    const fakeNames = new Set(ENFORCED_CONSTRAINTS.map((n) => n.toLowerCase()));

    for (const name of sqlNames) {
      assert.ok(fakeNames.has(name), `the migration declares "${name}" but the fake does not enforce it`);
    }
    assert.ok(sqlNames.size >= 15, `expected the migration to declare many constraints, found ${sqlNames.size}`);
  });
});

// ════════════════════════════════════════════════════════════════════
// THE DATABASE'S OWN INVARIANTS, EXERCISED
// ════════════════════════════════════════════════════════════════════

describe("postgres store — the one-active authority is the DATABASE's", () => {
  const active = (clientId, configVersion) => ({
    id: `id-${clientId}-${configVersion}`,
    client_id: clientId,
    config_version: configVersion,
    schema_version: locksmithA().schemaVersion,
    status: "active",
    blueprint: bodyOf({ ...locksmithA(), metadata: {} }),
    content_hash: "a".repeat(64),
    created_at: "2026-08-16T09:00:00.000Z",
    source: "ui",
    validated_at: "2026-08-16T09:00:00.000Z",
    approved_at: "2026-08-16T09:00:00.000Z",
    approved_by: "Peter Dang",
    approved_hash: "a".repeat(64),
    activated_at: "2026-08-16T09:00:00.000Z",
    activated_by: "Peter Dang",
  });

  it("refuses a SECOND active row for the same client, whatever the app does", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const { error } = await db.from(VERSIONS_TABLE).insert(active("northside_locks", 2)).select().maybeSingle();
    assert.ok(error, "a second active row must be refused");
    assert.equal(error.code, "23505");
    assert.equal(error.constraint, "pcv_one_active_per_client");
  });

  it("allows one active row per client for many clients", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const other = { ...active("riverside_plumbing", 1) };
    other.blueprint = bodyOf({ ...plumberC(), metadata: {} });
    const { error } = await db.from(VERSIONS_TABLE).insert(other).select().maybeSingle();
    assert.equal(error, null, error && error.message);
  });

  it("refuses two versions with the same number for one client", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const duplicate = { ...active("northside_locks", 1), status: "draft", approved_at: null, approved_by: null, approved_hash: null, activated_at: null, activated_by: null, validated_at: null };
    const { error } = await db.from(VERSIONS_TABLE).insert(duplicate).select().maybeSingle();
    assert.equal(error.code, "23505");
    assert.equal(error.constraint, "pcv_client_version_unique");
  });

  it("refuses a body that disagrees with the row about who owns it", async () => {
    const db = createFakePostgres();
    const row = { ...active("northside_locks", 1) };
    row.blueprint = { ...row.blueprint, identity: { ...row.blueprint.identity, clientId: "somebody_else" } };
    const { error } = await db.from(VERSIONS_TABLE).insert(row).select().maybeSingle();
    assert.equal(error.constraint, "pcv_body_client_matches");
  });

  it("refuses an approved row whose approved hash is not the content hash", async () => {
    const db = createFakePostgres();
    const row = { ...active("northside_locks", 1), approved_hash: "b".repeat(64) };
    const { error } = await db.from(VERSIONS_TABLE).insert(row).select().maybeSingle();
    assert.equal(error.constraint, "pcv_approved_hash_is_content_hash");
  });

  it("refuses a draft that carries approval metadata", async () => {
    const db = createFakePostgres();
    const row = { ...active("northside_locks", 1), status: "draft" };
    const { error } = await db.from(VERSIONS_TABLE).insert(row).select().maybeSingle();
    assert.equal(error.constraint, "pcv_draft_is_clean");
  });

  it("refuses lineage pointing at a version that does not exist", async () => {
    const db = createFakePostgres();
    const row = { ...active("northside_locks", 1), supersedes: 99 };
    const { error } = await db.from(VERSIONS_TABLE).insert(row).select().maybeSingle();
    assert.equal(error.code, "23503");
    assert.equal(error.constraint, "pcv_supersedes_fk");
  });

  it("refuses DELETE outright — history is not deletable", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const { error } = await db.from(VERSIONS_TABLE).delete().eq("client_id", "northside_locks");
    assert.ok(error);
    assert.equal(error.constraint, "pcv_refuse_delete");
  });

  it("refuses to mutate an approved body through the raw table", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const { error } = await db
      .from(VERSIONS_TABLE)
      .update({ blueprint: { ...bodyOf({ ...locksmithA(), metadata: {} }), identity: { ...locksmithA().identity, legalName: "Swapped Pty Ltd" } } })
      .eq("client_id", "northside_locks")
      .eq("config_version", 1)
      .select()
      .maybeSingle();
    assert.ok(error);
    assert.equal(error.constraint, "pcv_guard_frozen_rows");
  });

  it("refuses to walk an active version back to draft", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const { error } = await db.from(VERSIONS_TABLE).update({ status: "draft" })
      .eq("client_id", "northside_locks").eq("config_version", 1).select().maybeSingle();
    assert.ok(error);
    assert.equal(error.constraint, "pcv_guard_frozen_rows");
  });

  it("allows the ONE legitimate transition out of active: supersession", async () => {
    const db = createFakePostgres({ seed: { platform_config_versions: [active("northside_locks", 1)] } });
    const { error } = await db.from(VERSIONS_TABLE)
      .update({ status: "superseded", superseded_at: "2026-08-16T10:00:00.000Z" })
      .eq("client_id", "northside_locks").eq("config_version", 1).select().maybeSingle();
    assert.equal(error, null, error && error.message);
  });
});

// ════════════════════════════════════════════════════════════════════
// ACTIVATION UNDER INTERRUPT
// ════════════════════════════════════════════════════════════════════

describe("postgres store — an interrupted activation fails CLOSED", () => {
  async function twoApprovedVersions() {
    const now = fixedClock();
    const db = createFakePostgres();
    const store = createPostgresBlueprintStore({ db, now });
    const authority = createBlueprintAuthority({ store, now });

    const first = await authority.createDraft({ clientId: "northside_locks", blueprint: locksmithA(), createdBy: "x" });
    await authority.validateDraft("northside_locks", 1);
    await authority.approveDraft({ clientId: "northside_locks", configVersion: 1, approvedBy: "Peter Dang" });
    await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: 1, activatedBy: "Peter Dang" });
    now.tick();

    const changed = locksmithA();
    changed.identity.description = "the successor";
    await authority.createDraft({ clientId: "northside_locks", blueprint: changed, createdBy: "x" });
    await authority.validateDraft("northside_locks", 2);
    await authority.approveDraft({ clientId: "northside_locks", configVersion: 2, approvedBy: "Peter Dang" });
    return { db, authority, now, first };
  }

  it("never leaves TWO active versions — that direction is unreachable", async () => {
    const { db, authority } = await twoApprovedVersions();
    await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: 2, activatedBy: "Peter Dang" });
    const actives = db._rows(VERSIONS_TABLE).filter((r) => r.status === "active");
    assert.equal(actives.length, 1);
    assert.equal(actives[0].config_version, 2);
  });

  it("leaves ZERO active when interrupted between the two writes, and refuses to serve one", async () => {
    const { db, authority } = await twoApprovedVersions();
    // Die immediately after superseding the incumbent.
    let calls = 0;
    const realFrom = db.from.bind(db);
    db.from = (table) => {
      const q = realFrom(table);
      const realThen = q.then.bind(q);
      q.then = (resolve, reject) => {
        if (q._op === "update" && q._payload && q._payload.status === "active") {
          calls += 1;
          return Promise.resolve({ data: null, error: new PgError("08006", null, "connection terminated") }).then(resolve, reject);
        }
        return realThen(resolve, reject);
      };
      return q;
    };

    const interrupted = await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: 2, activatedBy: "Peter Dang" });
    assert.equal(calls, 1, "the activation write must have been attempted and failed");
    assert.equal(interrupted.ok, false, "an interrupted activation must not report success");

    db.from = realFrom;
    const actives = db._rows(VERSIONS_TABLE).filter((r) => r.status === "active");
    assert.equal(actives.length, 0, "zero active is the safe outcome");

    const served = await authority.getActiveVersion("northside_locks");
    assert.equal(served.ok, false, "and nothing is served while there is no active version");
    assert.equal(served.code, "no_active_version");
  });

  it("recovers completely when activation is simply re-run", async () => {
    const { db, authority } = await twoApprovedVersions();
    const realFrom = db.from.bind(db);
    db.from = (table) => {
      const q = realFrom(table);
      const realThen = q.then.bind(q);
      q.then = (resolve, reject) => {
        if (q._op === "update" && q._payload && q._payload.status === "active") {
          db.from = realFrom;   // fail exactly once
          return Promise.resolve({ data: null, error: new PgError("08006", null, "connection terminated") }).then(resolve, reject);
        }
        return realThen(resolve, reject);
      };
      return q;
    };
    await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: 2, activatedBy: "Peter Dang" });
    assert.equal(db._rows(VERSIONS_TABLE).filter((r) => r.status === "active").length, 0);

    const retry = await authority.activateApprovedVersion({ clientId: "northside_locks", configVersion: 2, activatedBy: "Peter Dang" });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    const actives = db._rows(VERSIONS_TABLE).filter((r) => r.status === "active");
    assert.equal(actives.length, 1);
    assert.equal(actives[0].config_version, 2);
  });
});

// ════════════════════════════════════════════════════════════════════
// ROW MAPPING
// ════════════════════════════════════════════════════════════════════

describe("postgres store — the row mapping keeps ONE source of truth", () => {
  it("strips metadata from the stored body, so a column and a jsonb key cannot disagree", () => {
    const bp = locksmithA();
    bp.metadata = { ...bp.metadata, configVersion: 3, status: "active", approvedBy: "Peter Dang" };
    const row = toRow(bp);
    assert.equal(row.blueprint.metadata, undefined, "metadata must not be duplicated into the body");
    assert.equal(row.config_version, 3);
    assert.equal(row.status, "active");
    assert.equal(row.approved_by, "Peter Dang");
  });

  it("reassembles metadata from columns on the way back", () => {
    const bp = locksmithA();
    bp.metadata = { ...bp.metadata, configVersion: 7, status: "approved", approvedBy: "Peter Dang", createdBy: "Someone", source: "import" };
    const round = fromRow({ ...toRow(bp), id: "x" });
    assert.equal(round.metadata.configVersion, 7);
    assert.equal(round.metadata.status, "approved");
    assert.equal(round.metadata.approvedBy, "Peter Dang");
    assert.equal(round.metadata.source, "import");
    assert.deepEqual(round.services, bp.services);
  });

  it("round-trips a blueprint without changing a single section", () => {
    for (const make of [locksmithA, plumberC]) {
      const bp = make();
      bp.metadata = { ...bp.metadata, configVersion: 1 };
      const round = fromRow({ ...toRow(bp), id: "x" });
      for (const section of ["identity", "services", "serviceArea", "hours", "callHandling", "knowledge", "booking", "voice", "compliance", "outbound", "integrations", "extensions"]) {
        assert.deepEqual(round[section], bp[section], `${section} changed in the round trip`);
      }
    }
  });

  it("hashes the BODY, so metadata churn does not look like a content change", () => {
    const a = locksmithA();
    a.metadata = { ...a.metadata, configVersion: 1, createdBy: "Alice", updatedAt: "2026-01-01T00:00:00.000Z" };
    const b = locksmithA();
    b.metadata = { ...b.metadata, configVersion: 99, createdBy: "Bob", updatedAt: "2027-01-01T00:00:00.000Z" };
    assert.equal(toRow(a).content_hash, toRow(b).content_hash);

    const c = locksmithA();
    c.metadata = { ...c.metadata, configVersion: 1 };
    c.identity.legalName = "Something Else Pty Ltd";
    assert.notEqual(toRow(a).content_hash, toRow(c).content_hash, "a real change must move the hash");
  });

  it("sets approved_hash to the content hash exactly when approved", () => {
    const bp = locksmithA();
    bp.metadata = { ...bp.metadata, configVersion: 1 };
    assert.equal(toRow(bp).approved_hash, null);

    bp.metadata.approvedAt = "2026-08-16T09:00:00.000Z";
    const approved = toRow(bp);
    assert.equal(approved.approved_hash, approved.content_hash);
  });

  it("is deterministic — the same blueprint hashes identically every time", () => {
    const bp = locksmithA();
    bp.metadata = { ...bp.metadata, configVersion: 1 };
    assert.equal(contentHashOf(bodyOf(bp)), contentHashOf(bodyOf(bp)));
    assert.match(contentHashOf(bodyOf(bp)), /^[0-9a-f]{64}$/);
  });
});

describe("postgres store — errors are classified, not swallowed", () => {
  it("maps SQLSTATEs onto something a caller can act on", () => {
    assert.equal(describeDbError({ code: "23505", message: "duplicate key" }).kind, "conflict");
    assert.equal(describeDbError({ code: "23514", message: "check constraint" }).kind, "refused");
    assert.equal(describeDbError({ code: "23503", message: "foreign key" }).kind, "lineage");
    assert.equal(describeDbError({ code: "08006", message: "connection terminated" }).kind, "unavailable");
  });

  it("treats an unreadable store as UNAVAILABLE rather than as 'nothing found'", async () => {
    const db = createFakePostgres();
    db._failNext("connection terminated");
    const store = createPostgresBlueprintStore({ db, now: fixedClock() });
    await assert.rejects(() => store.listVersions("northside_locks"), /connection terminated/);
  });

  it("refuses a version with no tenant rather than writing an orphan", async () => {
    const store = createPostgresBlueprintStore({ db: createFakePostgres(), now: fixedClock() });
    const orphan = locksmithA();
    orphan.identity.clientId = null;
    orphan.metadata = { ...orphan.metadata, configVersion: 1 };
    await assert.rejects(() => store.putVersion(orphan), /identity\.clientId/);
  });

  it("requires a database handle rather than inventing one", () => {
    assert.throws(() => createPostgresBlueprintStore({}), /injected db handle/);
    assert.throws(() => createPostgresBlueprintStore({ db: {} }), /injected db handle/);
  });
});

describe("postgres store — the audit event path", () => {
  it("appends an event and reads it back", async () => {
    const db = createFakePostgres();
    const store = createPostgresBlueprintStore({ db, now: fixedClock() });
    await store.appendEvent({
      clientId: "northside_locks", configVersion: 1, eventType: "draft_created",
      actor: "Peter Dang", actorRole: "operator", source: "ui", metadata: { note: "first" },
    });
    const events = await store.listEvents("northside_locks");
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "draft_created");
    assert.equal(events[0].actor, "Peter Dang");
  });

  it("refuses an event type nobody defined", async () => {
    const store = createPostgresBlueprintStore({ db: createFakePostgres(), now: fixedClock() });
    await assert.rejects(
      () => store.appendEvent({ clientId: "northside_locks", eventType: "quietly_deleted_everything" }),
      /event_type/,
    );
  });

  it("refuses to UPDATE an event — the log is append-only", async () => {
    const db = createFakePostgres();
    const store = createPostgresBlueprintStore({ db, now: fixedClock() });
    await store.appendEvent({ clientId: "northside_locks", eventType: "approved", actor: "Peter Dang" });
    const { error } = await db.from(EVENTS_TABLE).update({ actor: "Somebody Else" }).eq("client_id", "northside_locks");
    assert.ok(error);
    assert.equal(error.constraint, "pce_append_only");
  });

  it("keeps one client's events away from another's", async () => {
    const db = createFakePostgres();
    const store = createPostgresBlueprintStore({ db, now: fixedClock() });
    await store.appendEvent({ clientId: "northside_locks", eventType: "approved", actor: "Peter Dang" });
    await store.appendEvent({ clientId: "riverside_plumbing", eventType: "approved", actor: "Ravi Menon" });
    const theirs = await store.listEvents("northside_locks");
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].actor, "Peter Dang");
  });
});
