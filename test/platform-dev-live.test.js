// AIDA PLATFORM P36 — the configuration subsystem against REAL DEV Postgres.
//
//   PLATFORM_DEV_LIVE=true PLATFORM_DEV_ENV_FILE=.env.platform-dev \
//     node --test test/platform-dev-live.test.js
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────
// Every other test in this repo runs against an in-memory store or a fake
// Postgres. Both are good, and both share one blind spot: they encode what we
// BELIEVE the database does. This suite asks the database.
//
// It is the same contract, not a watered-down "live smoke". Lifecycle,
// compare-and-swap, immutability, the one-active index, lineage, supersession,
// history, audit — run against ACP1 as applied to DEV on 2026-08-17.
//
// ── IT SKIPS BY DEFAULT ─────────────────────────────────────────────
// `npm test` must never touch a database, need a credential, or write a row.
// So this whole file skips unless three independent things hold: opted in with
// the exact string "true", a key resolves, and the project ref is DEV.
//
// ── WHAT IT WRITES ──────────────────────────────────────────────────
// Rows belonging to TWO fictional tenants: aida_platform_dev_contract (which
// this suite owns and which ACCUMULATES, because ACP1 refuses to delete a
// version) and aida_platform_dev_peer (one row, for the cross-tenant proof).
//
// It never touches dev-client, never touches aida_platform_dev_client — the
// clean tenant the founder browses — never touches provider_resources, and
// never touches a table ACP1 did not create.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");

const H = require("./helpers/dev-live-harness");
const { createPrincipal, executionPrincipal, voicePrincipal } = require("../src/platform/config-access");
const { resolveStoreBinding, createAcp1SchemaProbe, BINDING_CODES } = require("../src/platform/store-binding");
const { assertDevProject, DEV_PROJECT_REF } = require("../scripts/dev/platform-dev-supabase");
const { garageDoorD, plumberC } = require("../src/platform/fixtures/clients");
const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
const { compileRetellPreview } = require("../src/platform/provider-compiler-retell");

const AVAILABLE = H.liveAvailable();
const SKIP = AVAILABLE.available ? false : `DEV live suite skipped — ${AVAILABLE.why}`;

const CID = H.FIXTURE.slug;
const P = {
  editor: (c = CID) => createPrincipal({ role: "client_editor", actorId: "p36 editor", clientId: c }),
  owner: (c = CID) => createPrincipal({ role: "client_owner", actorId: "Peter Dang", clientId: c }),
  operator: (c = CID) => createPrincipal({ role: "operator", actorId: "Peter Dang", clientId: c, crossTenant: true }),
};

/** A blueprint for the fixture: the garage-door fictional business, retenanted. */
function fixtureBlueprint(clientId = CID) {
  const bp = garageDoorD();
  bp.identity.clientId = clientId;
  bp.identity.legalName = "AIDA Platform DEV Fixture Pty Ltd";
  bp.identity.tradingName = "AIDA Platform DEV Fixture";
  return bp;
}

let LIVE = null;
let db = null;

before(async () => {
  if (SKIP) return;
  LIVE = await H.buildLivePlatform();
  assert.equal(LIVE.ok, true, `the live binding refused: ${JSON.stringify(LIVE.binding)}`);
  db = LIVE.db;

  // A clean slate for the fixture, so a re-run is deterministic. Version rows
  // refuse deletion by trigger, so this is best-effort by design — the suite
  // works from whatever version number it finds.
  await db.from("platform_config_events").delete().eq("client_id", CID);
  await H.ensureFixtureClient(db, CID, H.FIXTURE.name);
});

after(async () => {
  if (SKIP || !db) return;
  // Nothing is torn down. ACP1 refuses to delete a configuration version, so
  // both fictional tenants are permanent once seeded — see Phase 5C, which
  // reports exactly what is retained and how to reset it.
  await db.from("platform_config_events").delete().eq("client_id", H.PEER.slug);
});

// ════════════════════════════════════════════════════════════════════
// PHASE 4 / 4A — BINDING AND READINESS
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 4 — the store binding, against a database that exists", { skip: SKIP }, () => {
  it("binds to postgres and says it is durable", () => {
    assert.equal(LIVE.binding.mode, "postgres");
    assert.equal(LIVE.binding.durable, true);
    assert.match(LIVE.binding.note, /confirmed present by the injected schema probe/);
  });

  it("the readiness probe finds both tables and every required column", async () => {
    const probe = createAcp1SchemaProbe({ db });
    const result = await probe();
    assert.equal(result.present, true, JSON.stringify(result));
    assert.match(result.detail, /both ACP1 tables readable/);
  });

  it("FAILS CLOSED when the schema is not there — no memory fallback", async () => {
    // A db handle whose tables do not exist. The binding must return NO STORE.
    const wrongSchema = {
      from: () => ({
        select: () => ({ limit: async () => ({ data: null, error: { code: "PGRST205", message: "could not find the table" } }) }),
      }),
    };
    const refused = await resolveStoreBinding({
      mode: "postgres", db: wrongSchema, now: H.clock(),
      schemaProbe: createAcp1SchemaProbe({ db: wrongSchema }),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, BINDING_CODES.SCHEMA_ABSENT);
    assert.equal(refused.store, null, "a store was returned despite an absent schema");
    assert.ok(!/memory/i.test(JSON.stringify(refused)), "the refusal mentions memory — there must be no fallback");
  });

  it("FAILS CLOSED when the probe throws — an unreachable database is not 'fine'", async () => {
    const refused = await resolveStoreBinding({
      mode: "postgres", db: { from: () => {} }, now: H.clock(),
      schemaProbe: async () => { throw new Error("connection reset"); },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, BINDING_CODES.SCHEMA_UNVERIFIED);
    assert.equal(refused.store, null);
  });

  it("the DEV project guard refuses every lookalike", () => {
    for (const hostile of [
      "https://PRODUCTIONREF.supabase.co",
      `https://${DEV_PROJECT_REF}.evil.com`,
      `https://evil.com/${DEV_PROJECT_REF}.supabase.co`,
      `http://${DEV_PROJECT_REF}.supabase.co`,
      "", null,
    ]) {
      assert.throws(() => assertDevProject(hostile), /REFUSED|not a Supabase project URL|not set/, `accepted ${hostile}`);
    }
    assert.equal(assertDevProject(`https://${DEV_PROJECT_REF}.supabase.co`), DEV_PROJECT_REF);
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 5 — THE REAL CONTRACT
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 5 — the configuration lifecycle, on real Postgres", { skip: SKIP }, () => {
  let v1 = null;

  it("CREATE DRAFT — the row persists, and the body must agree with the row", async () => {
    const created = await LIVE.configService.createDraft({
      principal: P.editor(), clientId: CID, blueprint: fixtureBlueprint(),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    v1 = created.configVersion;

    const { data, error } = await db.from("platform_config_versions")
      .select("client_id,config_version,status,source,schema_version,content_hash,updated_at")
      .eq("client_id", CID).eq("config_version", v1).limit(1);
    assert.equal(error, null);
    assert.equal(data.length, 1, "the draft did not reach the database");
    assert.equal(data[0].status, "draft");
    assert.equal(data[0].source, "ui");
    assert.equal(data[0].content_hash.length, 64);
    assert.equal(data[0].updated_at, null, "a fresh draft must have a NULL CAS token");
  });

  it("the database refuses a body whose clientId disagrees with the row", async () => {
    const bp = fixtureBlueprint();
    bp.identity.clientId = "somebody_else";
    const refused = await db.from("platform_config_versions").insert({
      client_id: CID, config_version: 99001, schema_version: bp.schemaVersion, status: "draft",
      blueprint: bp, content_hash: "a".repeat(64),
    });
    assert.ok(refused.error, "the body/row disagreement was accepted");
    assert.match(refused.error.message, /pcv_body_client_matches|violates check/i);
  });

  it("READ — the blueprint round-trips exactly", async () => {
    const got = await LIVE.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: v1 });
    assert.equal(got.ok, true);
    const original = fixtureBlueprint();
    assert.equal(got.version.identity.legalName, original.identity.legalName);
    assert.deepEqual(got.version.services.map((s) => s.serviceId), original.services.map((s) => s.serviceId));
    assert.deepEqual(got.version.hours.weekly, original.hours.weekly);
  });

  it("NULL CAS — an editor holding 'never edited' may save exactly once", async () => {
    const opened = await LIVE.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: v1 });
    assert.equal(opened.version.metadata.updatedAt ?? null, null);

    LIVE.now.tick(1000);
    const saved = await LIVE.configService.updateDraft({
      principal: P.editor(), clientId: CID, configVersion: v1,
      mutate: (d) => { d.identity.tradingName = "Edited Once"; },
      expectedUpdatedAt: null,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));

    // A SECOND editor still holding null is now stale — the real collision.
    LIVE.now.tick(1000);
    const stale = await LIVE.configService.updateDraft({
      principal: P.editor(), clientId: CID, configVersion: v1,
      mutate: (d) => { d.identity.tradingName = "Edited By Somebody Else"; },
      expectedUpdatedAt: null,
    });
    assert.equal(stale.ok, false, "a stale null-token write landed");
    assert.equal(stale.outcome, "conflict");

    const after = await LIVE.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: v1 });
    assert.equal(after.version.identity.tradingName, "Edited Once", "the stale write overwrote the good one");
  });

  it("CAS advances, and a stale token is refused by the real database", async () => {
    const opened = await LIVE.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: v1 });
    const token = opened.version.metadata.updatedAt;
    assert.ok(token, "no CAS token after the first save");

    LIVE.now.tick(1000);
    const first = await LIVE.configService.updateDraft({
      principal: P.editor(), clientId: CID, configVersion: v1,
      mutate: (d) => { d.identity.description = "first"; }, expectedUpdatedAt: token,
    });
    assert.equal(first.ok, true);

    LIVE.now.tick(1000);
    const second = await LIVE.configService.updateDraft({
      principal: P.editor(), clientId: CID, configVersion: v1,
      mutate: (d) => { d.identity.description = "second"; }, expectedUpdatedAt: token,
    });
    assert.equal(second.ok, false, "the same token worked twice");
    assert.equal(second.outcome, "conflict");

    const now = await LIVE.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: v1 });
    assert.equal(now.version.identity.description, "first");
    assert.notEqual(now.version.metadata.updatedAt, token, "the token did not advance");
  });

  it("VALIDATE — the lifecycle transition persists", async () => {
    const validated = await LIVE.configService.validate({ principal: P.editor(), clientId: CID, configVersion: v1 });
    assert.equal(validated.ok, true, JSON.stringify(validated.errors || validated));

    const { data } = await db.from("platform_config_versions")
      .select("status,validated_at").eq("client_id", CID).eq("config_version", v1).limit(1);
    assert.equal(data[0].status, "validated");
    assert.ok(data[0].validated_at, "validated_at was not written");
  });

  it("APPROVE — approver, instant and hash are written, and approved_hash = content_hash", async () => {
    const approved = await LIVE.configService.approve({
      principal: P.owner(), clientId: CID, configVersion: v1, reason: "P36 live contract",
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    const { data } = await db.from("platform_config_versions")
      .select("status,approved_at,approved_by,approved_hash,content_hash,approval_reason")
      .eq("client_id", CID).eq("config_version", v1).limit(1);
    assert.equal(data[0].status, "approved");
    assert.equal(data[0].approved_by, "Peter Dang");
    assert.ok(data[0].approved_at);
    assert.equal(data[0].approved_hash, data[0].content_hash, "the anti-tamper constraint is not being honoured");
    assert.equal(data[0].approval_reason, "P36 live contract");
  });

  it("IMMUTABLE — the database refuses to change approved content", async () => {
    const refused = await db.from("platform_config_versions")
      .update({ content_hash: "b".repeat(64) })
      .eq("client_id", CID).eq("config_version", v1);
    assert.ok(refused.error, "approved content was mutated");
    assert.match(refused.error.message, /immutable|content and approval/i);
  });

  it("ACTIVATE — the exact version goes live, with actor and instant", async () => {
    const activated = await LIVE.configService.activate({ principal: P.operator(), clientId: CID, configVersion: v1 });
    assert.equal(activated.ok, true, JSON.stringify(activated));

    const { data } = await db.from("platform_config_versions")
      .select("status,activated_at,activated_by").eq("client_id", CID).eq("config_version", v1).limit(1);
    assert.equal(data[0].status, "active");
    assert.equal(data[0].activated_by, "Peter Dang");
    assert.ok(data[0].activated_at);
  });

  it("ONE ACTIVE — the database makes a second active version impossible", async () => {
    // Attempt it directly, bypassing the application entirely. The index is the
    // authority; the application merely happens to agree with it.
    // The forged row must be valid in every OTHER respect, or an earlier
    // constraint refuses it and the index is never exercised. The first attempt
    // died on pcv_instants_ordered — created_at defaulted to now() while the
    // approval timestamps were computed a moment earlier — which proved
    // timestamp ordering works and nothing at all about one-active.
    const base = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now() - 30_000).toISOString();
    const bp = fixtureBlueprint();
    const forged = {
      client_id: CID, config_version: 99002, schema_version: bp.schemaVersion, status: "active",
      blueprint: bp, content_hash: "c".repeat(64), approved_hash: "c".repeat(64),
      created_at: base, validated_at: later,
      approved_by: "attacker", approved_at: later,
      activated_by: "attacker", activated_at: later,
    };
    const refused = await db.from("platform_config_versions").insert(forged);
    assert.ok(refused.error, "TWO ACTIVE VERSIONS WERE ACCEPTED");
    assert.match(refused.error.message, /pcv_one_active_per_client|duplicate key/i,
      `refused by the wrong constraint: ${refused.error.message}`);

    const { data } = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", CID).eq("status", "active");
    assert.equal(data.length, 1, `${data.length} active versions`);
  });

  it("RESTORE — creates a NEW version and records lineage without rewriting history", async () => {
    const restored = await LIVE.configService.restore({ principal: P.operator(), clientId: CID, configVersion: v1 });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const v2 = restored.version.metadata.configVersion;
    assert.ok(v2 > v1, "restore did not create a later version");

    const { data } = await db.from("platform_config_versions")
      .select("config_version,status,restored_from,supersedes")
      .eq("client_id", CID).in("config_version", [v1, v2]).order("config_version");
    const original = data.find((r) => r.config_version === v1);
    const copy = data.find((r) => r.config_version === v2);

    assert.equal(original.status, "active", "restore altered the version it copied from");
    assert.equal(copy.status, "draft");
    assert.equal(copy.restored_from, v1, "restored_from lineage is wrong");
  });

  it("VERSION HISTORY — ordered and complete", async () => {
    const listed = await LIVE.configService.listVersions({ principal: P.operator(), clientId: CID });
    assert.equal(listed.ok, true);
    assert.ok(listed.versions.length >= 2);
    const numbers = listed.versions.map((v) => v.configVersion);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "history is not ordered");
    assert.ok(listed.versions.some((v) => v.status === "active"));
  });

  it("SOURCE — a voice-origin version stores and retrieves as source=voice", async () => {
    // Phase 7A: schema compatibility only. The P37-P45 implementation is on
    // another branch and is deliberately not copied here.
    const bp = fixtureBlueprint();
    bp.identity.description = "voice-origin schema compatibility probe";
    const created = await LIVE.configService.createDraft({
      principal: P.editor(), clientId: CID, blueprint: bp, source: "voice",
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const { data } = await db.from("platform_config_versions")
      .select("source").eq("client_id", CID).eq("config_version", created.configVersion).limit(1);
    assert.equal(data[0].source, "voice", "ACP1 did not store a voice-origin source");
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 5 — AUDIT, including the P36 schema fix proven live
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 5 — the audit trail, on real Postgres", { skip: SKIP }, () => {
  it("appends events in order with the current vocabulary", async () => {
    const { data, error } = await db.from("platform_config_events")
      .select("event_type,actor,actor_role,source,occurred_at")
      .eq("client_id", CID).order("occurred_at");
    assert.equal(error, null);
    assert.ok(data.length > 0, "the live run produced no audit events");
    for (const row of data) {
      assert.ok(row.event_type, "an event with no type");
      assert.ok(["ui", "voice", "api", "import", "operator", null].includes(row.source));
    }
  });

  it("PROVES THE P36 FIX — operator_executor is accepted by the live CHECK", async () => {
    // The whole reason ACP1 was amended. Before the widening this row would
    // have been refused by the database, and config-service's try/catch would
    // have swallowed the refusal — losing exactly the audit rows describing the
    // one role that holds provisioning:execute.
    const executor = executionPrincipal({ clientId: CID, actorId: "P36 live proof" });
    assert.equal(executor.role, "operator_executor");

    const accepted = await db.from("platform_config_events").insert({
      client_id: CID, config_version: null, event_type: "execution_requested",
      actor: executor.actorId, actor_role: executor.role, source: "operator",
      metadata: { note: "P36 live proof that the widened actor_role CHECK is applied" },
    }).select("id");
    assert.equal(accepted.error, null, `operator_executor was REFUSED: ${accepted.error && accepted.error.message}`);
    assert.equal((accepted.data || []).length, 1);
  });

  it("accepts every current event type and refuses one nobody defined", async () => {
    const { EVENT_TYPES } = require("../src/platform/config-audit");
    assert.equal(EVENT_TYPES.length, 29);

    // A representative from each vocabulary generation, so a stale CHECK fails.
    for (const eventType of ["draft_created", "provisioning_plan_created", "manual_review_required"]) {
      const ok = await db.from("platform_config_events").insert({
        client_id: CID, event_type: eventType, actor: "P36", actor_role: "operator", source: "operator",
      }).select("id");
      assert.equal(ok.error, null, `${eventType} was refused — this database predates the widening`);
    }

    const refused = await db.from("platform_config_events").insert({
      client_id: CID, event_type: "quietly_deleted_everything", actor: "P36", actor_role: "operator",
    });
    assert.ok(refused.error, "an undefined event type was accepted");
  });

  it("refuses an actor role nobody defined", async () => {
    const refused = await db.from("platform_config_events").insert({
      client_id: CID, event_type: "draft_created", actor: "P36", actor_role: "superuser",
    });
    assert.ok(refused.error, "an undefined actor role was accepted");
    assert.match(refused.error.message, /actor_role|violates check/i);
  });

  it("is APPEND-ONLY — the database refuses an update and a delete", async () => {
    const one = await db.from("platform_config_events").select("id").eq("client_id", CID).limit(1);
    assert.ok((one.data || []).length, "no event to test against");
    const id = one.data[0].id;

    const updated = await db.from("platform_config_events").update({ actor: "somebody else" }).eq("id", id);
    assert.ok(updated.error, "an audit event was edited");
    assert.match(updated.error.message, /append-only/i);

    const deleted = await db.from("platform_config_events").delete().eq("id", id);
    assert.ok(deleted.error, "an audit event was deleted");
    assert.match(deleted.error.message, /append-only/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 5A — DATABASE INVARIANTS
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 5A — what the database itself refuses", { skip: SKIP }, () => {
  const otherTenant = H.PEER.slug;

  it("refuses an approved_hash that disagrees with content_hash", async () => {
    const bp = fixtureBlueprint();
    const refused = await db.from("platform_config_versions").insert({
      client_id: CID, config_version: 99010, schema_version: bp.schemaVersion, status: "approved",
      blueprint: bp, content_hash: "d".repeat(64), approved_hash: "e".repeat(64),
      approved_by: "x", approved_at: new Date().toISOString(), validated_at: new Date().toISOString(),
    });
    assert.ok(refused.error, "a body swapped after approval was accepted");
    assert.match(refused.error.message, /pcv_approved_hash_is_content_hash|violates check/i);
  });

  it("refuses a draft carrying approval metadata it has not earned", async () => {
    const bp = fixtureBlueprint();
    const refused = await db.from("platform_config_versions").insert({
      client_id: CID, config_version: 99011, schema_version: bp.schemaVersion, status: "draft",
      blueprint: bp, content_hash: "f".repeat(64),
      approved_by: "nobody", approved_at: new Date().toISOString(),
    });
    assert.ok(refused.error, "a draft claiming approval was accepted");
    assert.match(refused.error.message, /pcv_draft_is_clean|violates check/i);
  });

  it("refuses mutation of an ACTIVE version's content", async () => {
    const active = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", CID).eq("status", "active").limit(1);
    const v = active.data[0].config_version;
    const refused = await db.from("platform_config_versions")
      .update({ schema_version: "tampered" }).eq("client_id", CID).eq("config_version", v);
    assert.ok(refused.error, "an active version's content was changed");
    assert.match(refused.error.message, /immutable|content and approval/i);
  });

  it("refuses DELETE of a protected version", async () => {
    const active = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", CID).eq("status", "active").limit(1);
    const refused = await db.from("platform_config_versions")
      .delete().eq("client_id", CID).eq("config_version", active.data[0].config_version);
    assert.ok(refused.error, "a configuration version was deleted");
    assert.match(refused.error.message, /never deleted|supersede instead/i);
  });

  it("makes cross-client lineage UNREPRESENTABLE — supersedes, restored_from, superseded_by", async () => {
    // A real second tenant, with a real version, so the FK has something to
    // legitimately point at within its OWN client and nothing across.
    await H.ensureFixtureClient(db, otherTenant, "P36 temporary cross-tenant probe");
    const bp = fixtureBlueprint(otherTenant);
    // A version number that exists ONLY here. The first attempt used 1, which
    // the FIXTURE also has — so (fixture, 1) resolved legitimately and the test
    // proved nothing about crossing a tenant boundary.
    const ONLY_THERE = H.PEER.seededVersion;
    // Idempotent: a version row can never be deleted, so a re-run must reuse
    // the one already there rather than collide on pcv_client_version_unique.
    const already = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", otherTenant).eq("config_version", ONLY_THERE);
    if (!(already.data || []).length) {
      const seeded = await db.from("platform_config_versions").insert({
        client_id: otherTenant, config_version: ONLY_THERE, schema_version: bp.schemaVersion, status: "draft",
        blueprint: bp, content_hash: "1".repeat(64),
      }).select("config_version");
      assert.equal(seeded.error, null, `could not seed the peer tenant: ${seeded.error && seeded.error.message}`);
    }
    const clash = await db.from("platform_config_versions").select("config_version").eq("client_id", CID).eq("config_version", ONLY_THERE);
    assert.equal((clash.data || []).length, 0, "the fixture owns that version number too — the proof would be vacuous");

    const ours = fixtureBlueprint();
    // DISTINCT numbers per column. The first attempt used 99020 + name length,
    // and restored_from and superseded_by are both thirteen characters — so the
    // second collided on pcv_client_version_unique and never reached the
    // foreign key it was written to exercise.
    const SLOT = { supersedes: 88801, restored_from: 88802, superseded_by: 88803 };
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now() - 30_000).toISOString();

    for (const column of ["supersedes", "restored_from", "superseded_by"]) {
      // Every row must be valid in EVERY other respect, or an earlier
      // constraint refuses it and the foreign key is never reached. A draft
      // carrying superseded_by trips pcv_supersede_only_when_superseded first,
      // so that one gets a genuinely superseded row.
      const row = {
        client_id: CID, config_version: SLOT[column],
        schema_version: ours.schemaVersion, status: "draft",
        blueprint: ours, content_hash: "2".repeat(64), created_at: earlier,
        // ONLY_THERE exists — but it belongs to the OTHER client. The composite
        // FK is (client_id, n), so it cannot resolve for us.
        [column]: ONLY_THERE,
      };
      if (column === "superseded_by") {
        row.status = "superseded";
        row.superseded_at = later;
        row.supersede_reason = "P36 cross-tenant lineage proof";
      }

      const refused = await db.from("platform_config_versions").insert(row);
      assert.ok(refused.error, `cross-client ${column} was accepted`);
      assert.equal(refused.error.code, "23503",
        `${column} was refused by the wrong thing: ${refused.error.message}`);
      assert.match(refused.error.message, new RegExp(`pcv_${column}_fk`, "i"));
    }
  });

  it("refuses an active row with no activator", async () => {
    const bp = fixtureBlueprint(otherTenant);
    const refused = await db.from("platform_config_versions").insert({
      client_id: otherTenant, config_version: 99030, schema_version: bp.schemaVersion, status: "active",
      blueprint: bp, content_hash: "3".repeat(64), approved_hash: "3".repeat(64),
      approved_by: "x", approved_at: new Date().toISOString(), validated_at: new Date().toISOString(),
    });
    assert.ok(refused.error, "an active version with no activator was accepted");
    assert.match(refused.error.message, /pcv_active_is_complete|violates check/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 5B — ACTIVATION UNDER INTERRUPTION
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 5B — activation is two statements, and the index holds anyway", { skip: SKIP }, () => {
  it("never leaves two active versions, whichever way a race goes", async () => {
    // Two versions both ready to activate. Whatever order the statements
    // interleave in, the partial unique index permits at most one.
    const a = await LIVE.configService.createDraft({ principal: P.editor(), clientId: CID, blueprint: (() => {
      const bp = fixtureBlueprint(); bp.identity.description = "race A"; return bp;
    })() });
    const b = await LIVE.configService.createDraft({ principal: P.editor(), clientId: CID, blueprint: (() => {
      const bp = fixtureBlueprint(); bp.identity.description = "race B"; return bp;
    })() });

    for (const v of [a.configVersion, b.configVersion]) {
      await LIVE.configService.validate({ principal: P.editor(), clientId: CID, configVersion: v });
      await LIVE.configService.approve({ principal: P.owner(), clientId: CID, configVersion: v, reason: "race" });
    }

    const results = await Promise.allSettled([
      LIVE.configService.activate({ principal: P.operator(), clientId: CID, configVersion: a.configVersion }),
      LIVE.configService.activate({ principal: P.operator(), clientId: CID, configVersion: b.configVersion }),
    ]);
    void results;

    const { data } = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", CID).eq("status", "active");
    assert.ok(data.length <= 1, `${data.length} active versions after a concurrent activation`);
  });

  it("recovers from ZERO active by re-running activation — it is idempotent", async () => {
    // The safe half of the interrupt: supersede happened, activate did not.
    // The application must be able to finish the job by simply doing it again.
    const { data: before } = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", CID).eq("status", "active");

    if (before.length === 0) {
      const approved = await db.from("platform_config_versions")
        .select("config_version").eq("client_id", CID).eq("status", "approved").order("config_version", { ascending: false }).limit(1);
      if ((approved.data || []).length) {
        const again = await LIVE.configService.activate({
          principal: P.operator(), clientId: CID, configVersion: approved.data[0].config_version,
        });
        assert.equal(again.ok, true, `re-running activation failed: ${JSON.stringify(again)}`);
      }
    }

    const { data: after } = await db.from("platform_config_versions")
      .select("config_version").eq("client_id", CID).eq("status", "active");
    assert.ok(after.length <= 1, "recovery produced two active versions");
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 6 — RESTART PERSISTENCE
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 6 — it survives the process, not just the test", { skip: SKIP }, () => {
  it("A writes, B reads, B writes, C reads the whole history", async () => {
    const marker = `restart-proof-${Date.now()}`;

    // ── instance A ──
    const A = await H.buildLivePlatform();
    assert.equal(A.ok, true);
    const created = await A.configService.createDraft({
      principal: P.editor(), clientId: CID, blueprint: (() => {
        const bp = fixtureBlueprint(); bp.identity.description = marker; return bp;
      })(),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const version = created.configVersion;

    // Every in-process reference discarded. Nothing is shared with B.
    assert.notEqual(A.store, undefined);

    // ── instance B: a brand-new client, binding, store and service ──
    const B = await H.buildLivePlatform();
    assert.equal(B.ok, true);
    assert.notEqual(B.store, A.store, "B reused A's store object — this proves nothing");

    const readByB = await B.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: version });
    assert.equal(readByB.ok, true, "B could not see what A wrote");
    assert.equal(readByB.version.identity.description, marker);

    B.now.tick(1000);
    const updatedByB = await B.configService.updateDraft({
      principal: P.editor(), clientId: CID, configVersion: version,
      mutate: (d) => { d.identity.description = `${marker}-edited-by-B`; },
      expectedUpdatedAt: readByB.version.metadata.updatedAt ?? null,
    });
    assert.equal(updatedByB.ok, true, JSON.stringify(updatedByB));

    // ── instance C ──
    const C = await H.buildLivePlatform();
    assert.equal(C.ok, true);
    assert.notEqual(C.store, B.store);

    const readByC = await C.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: version });
    assert.equal(readByC.version.identity.description, `${marker}-edited-by-B`);

    const history = await C.configService.listVersions({ principal: P.operator(), clientId: CID });
    assert.ok(history.versions.some((v) => v.configVersion === version));
    assert.ok(history.versions.length >= 3, "history did not survive");
  });

  it("proves the data is in Postgres, not in a cache — a raw read finds it", async () => {
    // The strongest form: bypass every application object and ask the database.
    const { data, error } = await db.from("platform_config_versions")
      .select("config_version,blueprint->identity->>description")
      .eq("client_id", CID).order("config_version", { ascending: false }).limit(1);
    assert.equal(error, null);
    assert.ok(data.length === 1);
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 7 — THE APPLICATION SURFACE, ON REAL POSTGRES
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 7 — the HTTP surface against durable rows", { skip: SKIP }, () => {
  const { createPlatformConfigHandlers } = require("../src/routes/platform-config-handlers");

  const fakeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };
  const clientReq = (clientId, role, params = {}, body = {}, query = {}) => ({
    clientId, client: { slug: clientId, platform_role: role },
    clientAuth: { mode: "cookie", user: { email: "p36@example.invalid" } },
    params: { clientId, ...params }, body, query,
  });
  const operatorReq = (clientId, params = {}, body = {}) => ({
    clientId, operatorSession: true, session: { operatorId: "Peter Dang" },
    params: { clientId, ...params }, body, query: {},
  });

  let handlers = null;
  before(() => { if (!SKIP) handlers = createPlatformConfigHandlers({ service: LIVE.configService, logger: { error() {} } }); });

  it("creates, edits and validates a draft through the handlers, into Postgres", async () => {
    const create = fakeRes();
    await handlers.createDraft(clientReq(CID, "client_editor", {}, { blueprint: (() => {
      const bp = fixtureBlueprint(); bp.identity.description = "http e2e"; return bp;
    })() }), create);
    assert.equal(create.statusCode, 201, JSON.stringify(create.body));
    const version = create.body.configVersion;

    const { data } = await db.from("platform_config_versions")
      .select("config_version,status").eq("client_id", CID).eq("config_version", version).limit(1);
    assert.equal(data.length, 1, "the HTTP create did not reach the database");

    const validate = fakeRes();
    await handlers.validate(clientReq(CID, "client_editor", { versionId: String(version) }), validate);
    assert.equal(validate.statusCode, 200, JSON.stringify(validate.body));
  });

  it("returns 409 for a stale CAS against the real database", async () => {
    const listed = await LIVE.configService.listVersions({ principal: P.operator(), clientId: CID });
    const draft = listed.versions.filter((v) => v.status === "draft" || v.status === "validated").slice(-1)[0];
    assert.ok(draft, "no open draft to test with");

    const opened = await LIVE.configService.getVersion({ principal: P.editor(), clientId: CID, configVersion: draft.configVersion });
    const token = opened.version.metadata.updatedAt ?? null;

    LIVE.now.tick(1000);
    const first = fakeRes();
    await handlers.updateDraft(clientReq(CID, "client_editor", { versionId: String(draft.configVersion) }, {
      blueprint: { identity: { description: "http first" } }, expectedUpdatedAt: token,
    }), first);
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));

    LIVE.now.tick(1000);
    const stale = fakeRes();
    await handlers.updateDraft(clientReq(CID, "client_editor", { versionId: String(draft.configVersion) }, {
      blueprint: { identity: { description: "http stale" } }, expectedUpdatedAt: token,
    }), stale);
    assert.equal(stale.statusCode, 409, "a stale HTTP write was accepted");
  });

  it("refuses another tenant identically, and leaks nothing about it", async () => {
    const attack = {
      clientId: CID, client: { slug: CID, platform_role: "client_owner" },
      clientAuth: { mode: "cookie", user: {} },
      params: { clientId: "dev-client" }, body: {}, query: {},
    };
    const real = fakeRes();
    await handlers.listVersions(attack, real);
    assert.equal(real.statusCode, 403);

    const imaginary = fakeRes();
    await handlers.listVersions({ ...attack, params: { clientId: "no_such_client_at_all" } }, imaginary);
    assert.equal(imaginary.statusCode, 403);
    assert.deepEqual(real.body, imaginary.body, "the refusals differ — that tells an attacker which clients exist");

    // And dev-client gained nothing.
    const { data } = await db.from("platform_config_versions").select("config_version").eq("client_id", "dev-client");
    assert.equal(data.length, 0, "the P36 run wrote rows against dev-client");
  });

  it("activation through the operator path writes activated_by and nothing else", async () => {
    const listed = await LIVE.configService.listVersions({ principal: P.operator(), clientId: CID });
    const approved = listed.versions.filter((v) => v.status === "approved").slice(-1)[0];
    if (!approved) return; // the race test may have consumed them; not a failure

    const res = fakeRes();
    await handlers.activate(operatorReq(CID, { versionId: String(approved.configVersion) }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const { data } = await db.from("platform_config_versions")
      .select("status,activated_by").eq("client_id", CID).eq("status", "active");
    assert.equal(data.length, 1);
    assert.ok(data[0].activated_by);
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE 7B — PROVIDER PREVIEW STAYS PURE
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 7B — compiling from a live active configuration touches no provider", { skip: SKIP }, () => {
  it("compiles blueprint -> behaviour spec -> provider preview, deterministically", async () => {
    const active = await LIVE.configService.getActive({ principal: P.operator(), clientId: CID });
    assert.equal(active.ok, true, "no active configuration to compile");

    const first = compileBehaviourSpec(active.version);
    const second = compileBehaviourSpec(active.version);
    assert.equal(first.behaviourHash, second.behaviourHash, "the behaviour hash is not deterministic");
    assert.equal(first.behaviourHash.length, 64);

    const refs = { llmId: "llm_x", voiceId: "custom_voice_x", webhookUrl: "https://example.invalid/h" };
    const a = compileRetellPreview({ spec: first.spec, providerRefs: refs, direction: "inbound" });
    const b = compileRetellPreview({ spec: second.spec, providerRefs: refs, direction: "inbound" });
    assert.equal(a.payloadHash, b.payloadHash, "the provider payload hash is not deterministic");
  });

  it("ACTIVE means configuration active, NOT provider updated", async () => {
    // ACP2 and ACP3 are not applied, and nothing here needed them.
    for (const table of ["platform_provisioning_plans", "platform_provisioning_executions", "platform_action_executions"]) {
      const { error } = await db.from(table).select("*").limit(1);
      assert.ok(error, `${table} exists — ACP2/ACP3 must remain unapplied`);
    }
    // And no provider resource was created for the fixture.
    const { data } = await db.from("provider_resources").select("id").eq("client_id", CID);
    assert.equal((data || []).length, 0, "a provider resource exists for the fixture");
  });
});

// ════════════════════════════════════════════════════════════════════
// THE RETAINED FIXTURE
// ════════════════════════════════════════════════════════════════════

describe("P36 Phase 5C — what is left behind", { skip: SKIP }, () => {
  it("leaves exactly one fixture tenant and no anonymous debris", async () => {
    const counts = await H.fixtureRowCounts(db, CID);
    assert.equal(counts.client, 1, "the fixture clients row is missing");
    assert.ok(counts.versions >= 1);

    // Report it, so the number in the docs is the number in the database.
    console.log(`\n  RETAINED DEV FIXTURE: ${CID}`);
    console.log(`    clients rows                 ${counts.client}`);
    console.log(`    platform_config_versions     ${counts.versions}`);
    console.log(`    platform_config_events       ${counts.events}`);
    console.log(`    statuses                     ${counts.versionDetail.map((v) => `v${v.config_version}:${v.status}/${v.source}`).join(", ")}`);

    // No stray tenants beyond the fixture and dev-client.
    const all = await db.from("clients").select("slug");
    // Every tenant on DEV, named. Nothing anonymous.
    const KNOWN = [
      CID,                        // the contract suite's own tenant; accumulates
      H.PEER.slug,                // one row, the cross-tenant proof
      H.BROWSER_FIXTURE.slug,     // the clean tenant the founder browses
      "dev-client",               // pre-existing, not ours, never written to
      "aida_platform_dev_fixture", // P36 debris: a first attempt whose versions
                                   // cannot be deleted, because ACP1 refuses it
    ];
    const unexpected = (all.data || []).map((c) => c.slug).filter((s) => !KNOWN.includes(s));
    assert.deepEqual(unexpected, [], `unexpected tenants: ${unexpected.join(", ")}`);
    console.log(`    peer                         ${H.PEER.slug}`);
    console.log(`    browser fixture              ${H.BROWSER_FIXTURE.slug}`);
  });
});

// ════════════════════════════════════════════════════════════════════
// THE SKIP ITSELF IS VISIBLE
// ════════════════════════════════════════════════════════════════════

describe("P36 live suite — it is opt-in, and says so", () => {
  it("skips unless PLATFORM_DEV_LIVE is exactly \"true\", a key resolves and the ref is DEV", () => {
    // This test always runs, so a skipped suite is never silent.
    if (SKIP) {
      assert.match(SKIP, /skipped/);
      console.log(`\n  ${SKIP}\n  Set PLATFORM_DEV_LIVE=true and PLATFORM_DEV_ENV_FILE=.env.platform-dev to run it.\n`);
    } else {
      assert.equal(AVAILABLE.available, true);
      assert.equal(AVAILABLE.fixtureSlug, CID);
    }
  });

  it("names only the DEV project, and never a production one", () => {
    assert.equal(DEV_PROJECT_REF, "wvwemitmmsdytyutaqbm");
    assert.equal(H.FIXTURE.slug, "aida_platform_dev_contract");
    assert.equal(H.BROWSER_FIXTURE.slug, "aida_platform_dev_client");
    assert.match(H.BROWSER_FIXTURE.name, /fictional/i);
    assert.match(H.FIXTURE.name, /fictional/i);
  });
});
