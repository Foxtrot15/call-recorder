// AIDA PLATFORM — the durable configuration store (P15).
//
//   createPostgresBlueprintStore({ db, now })
//
// Implements the SAME four-method contract the in-memory store does, so the
// authority cannot tell them apart:
//
//   listVersions(clientId)                -> version[]
//   getVersion(clientId, configVersion)   -> version | null
//   putVersion(version)                   -> version
//   replaceVersion(version)               -> version
//
// The in-memory store is the executable specification. Both are run against
// one shared contract suite (test/helpers/blueprint-store-contract.js), so a
// semantic difference is a test failure rather than a production surprise.
//
// ── WHAT IS A COLUMN AND WHAT IS JSONB, AND WHY ─────────────────────
// Lifecycle metadata — status, tenancy, version identity, approval,
// activation, lineage, the CAS token — is NORMALISED into real columns with
// real constraints. Those are the fields a decision switches on, and being
// wrong about them means a business's telephone is answered with words nobody
// approved.
//
// The blueprint BODY is one jsonb column, minus its metadata, because the
// alternative is 200 columns and a migration for every product change. It is
// validated against client-blueprint.js before it is ever written, so this is
// not a blob store: the database additionally asserts that the body agrees
// with the row about who owns it and which schema it is.
//
// Metadata therefore lives in exactly ONE place. It is stripped on write and
// reassembled on read, so a column and a jsonb key can never disagree.
//
// ── ACTIVATION, AND THE INTERRUPT ───────────────────────────────────
// Activation is two writes: supersede the incumbent, then activate the
// successor. This codebase has no cross-table transaction, so an interrupt
// between them is possible. The order is chosen so the reachable failure is
// the safe one:
//
//   interrupted -> ZERO active   fail-closed; getActiveVersion refuses, and
//                                re-running activation fixes it
//   two active                   UNREACHABLE — the partial unique index
//                                pcv_one_active_per_client rejects the write
//
// ── NO NETWORK IN THIS FILE ─────────────────────────────────────────
// The database handle is injected. This module imports no Supabase client, no
// http and no env; the boundary ratchets read the source and assert it.

const crypto = require("crypto");
const { stableStringify } = require("./stable-json");

const VERSIONS_TABLE = "platform_config_versions";
const EVENTS_TABLE = "platform_config_events";

/** The metadata keys that are COLUMNS. Stripped from the body on write. */
const METADATA_COLUMNS = Object.freeze([
  "configVersion", "status", "createdAt", "createdBy", "source",
  "supersedes", "restoredFrom", "updatedAt", "updatedBy", "validatedAt",
  "approvedAt", "approvedBy", "approvedHash", "approvalReason",
  "activatedAt", "activatedBy",
  "supersededAt", "supersededBy", "supersedeReason",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/**
 * The hash of what a person approves. Covers the BODY only — metadata moves on
 * every save and is not a change to what the assistant says.
 */
function contentHashOf(blueprintBody) {
  return crypto.createHash("sha256").update(stableStringify(blueprintBody)).digest("hex");
}

/** Strip metadata from a version, leaving the body the hash is taken over. */
function bodyOf(version) {
  const body = clone(version);
  delete body.metadata;
  return body;
}

/** version (domain) -> row (database). */
function toRow(version) {
  if (!isObj(version)) throw new Error("toRow requires a version object");
  const m = version.metadata || {};
  const body = bodyOf(version);
  const contentHash = contentHashOf(body);

  return {
    client_id: version.identity ? version.identity.clientId : null,
    config_version: m.configVersion ?? null,
    schema_version: version.schemaVersion ?? null,
    status: m.status ?? "draft",

    blueprint: body,
    content_hash: contentHash,
    behaviour_hash: m.behaviourHash ?? null,

    created_at: iso(m.createdAt),
    created_by: m.createdBy ?? null,
    source: m.source ?? "ui",

    supersedes: m.supersedes ?? null,
    restored_from: m.restoredFrom ?? null,

    updated_at: iso(m.updatedAt),
    updated_by: m.updatedBy ?? null,
    validated_at: iso(m.validatedAt),

    approved_at: iso(m.approvedAt),
    approved_by: m.approvedBy ?? null,
    // The hash a person approved IS the content hash. The database enforces
    // the equality, so a body swapped after approval cannot be stored.
    approved_hash: m.approvedAt ? contentHash : null,
    approval_reason: m.approvalReason ?? null,

    activated_at: iso(m.activatedAt),
    activated_by: m.activatedBy ?? null,

    superseded_at: iso(m.supersededAt),
    superseded_by: m.supersededBy ?? null,
    supersede_reason: m.supersedeReason ?? null,
  };
}

/** row (database) -> version (domain). Metadata is reassembled from columns. */
function fromRow(row) {
  if (!isObj(row)) return null;
  const body = clone(row.blueprint);
  return {
    ...body,
    metadata: {
      configVersion: row.config_version,
      status: row.status,
      createdAt: row.created_at ?? null,
      createdBy: row.created_by ?? null,
      source: row.source ?? null,
      supersedes: row.supersedes ?? null,
      restoredFrom: row.restored_from ?? null,
      updatedAt: row.updated_at ?? null,
      updatedBy: row.updated_by ?? null,
      validatedAt: row.validated_at ?? null,
      approvedAt: row.approved_at ?? null,
      approvedBy: row.approved_by ?? null,
      approvalReason: row.approval_reason ?? null,
      activatedAt: row.activated_at ?? null,
      activatedBy: row.activated_by ?? null,
      supersededAt: row.superseded_at ?? null,
      supersededBy: row.superseded_by ?? null,
      supersedeReason: row.supersede_reason ?? null,
      // Storage facts the domain does not set but a reader may want.
      contentHash: row.content_hash ?? null,
      behaviourHash: row.behaviour_hash ?? null,
    },
  };
}

/** Turn a database error into something a caller can act on. */
function describeDbError(error) {
  const message = (error && (error.message || error.details)) || String(error);
  const code = error && error.code;
  // 23505 unique_violation — the one-active index or the version identity.
  if (code === "23505" || /duplicate key|unique/i.test(message)) {
    return { kind: "conflict", message };
  }
  // 23514 check_violation — a CHECK or one of the guard triggers.
  if (code === "23514" || /check constraint|immutable|append-only|never deleted/i.test(message)) {
    return { kind: "refused", message };
  }
  if (code === "23503" || /foreign key/i.test(message)) {
    return { kind: "lineage", message };
  }
  return { kind: "unavailable", message };
}

class StoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
  }
}

/**
 * @param {object} db  a Supabase-shaped handle: db.from(table) with
 *                     .select/.insert/.update/.eq/.order/.maybeSingle, each
 *                     resolving to { data, error }. Injected, never imported.
 */
function createPostgresBlueprintStore({ db, now } = {}) {
  if (!db || typeof db.from !== "function") {
    throw new Error("createPostgresBlueprintStore requires an injected db handle");
  }

  const fail = (error) => {
    const { kind, message } = describeDbError(error);
    throw new StoreError(kind, message);
  };

  async function listVersions(clientId) {
    const { data, error } = await db
      .from(VERSIONS_TABLE)
      .select("*")
      .eq("client_id", clientId)
      .order("config_version", { ascending: true });
    if (error) fail(error);
    return (data || []).map(fromRow);
  }

  async function getVersion(clientId, configVersion) {
    // BOTH keys, always. A lookup by version number alone would be a
    // cross-tenant read waiting for somebody to guess a number.
    const { data, error } = await db
      .from(VERSIONS_TABLE)
      .select("*")
      .eq("client_id", clientId)
      .eq("config_version", configVersion)
      .maybeSingle();
    if (error) fail(error);
    return data ? fromRow(data) : null;
  }

  async function putVersion(version) {
    const row = toRow(version);
    if (!row.client_id) throw new StoreError("refused", "a version must carry identity.clientId");
    if (!row.config_version) throw new StoreError("refused", "a version must carry metadata.configVersion");
    if (!row.created_at && typeof now === "function") row.created_at = now().toISOString();

    const { data, error } = await db.from(VERSIONS_TABLE).insert(row).select().maybeSingle();
    if (error) fail(error);
    return fromRow(data);
  }

  /**
   * Update in place, scoped by BOTH tenant and version. The database refuses
   * the write outright if the row is frozen — this adapter does not re-check
   * what the trigger already owns, because two implementations of one rule is
   * how they come to disagree.
   */
  async function replaceVersion(version) {
    const row = toRow(version);
    if (!row.client_id || !row.config_version) {
      throw new StoreError("refused", "replaceVersion needs a client and a version number");
    }
    // Identity columns are immutable and the trigger enforces it; sending them
    // in the patch would be sending a no-op the database has to check.
    const patch = { ...row };
    delete patch.client_id;
    delete patch.config_version;
    delete patch.created_at;

    const { data, error } = await db
      .from(VERSIONS_TABLE)
      .update(patch)
      .eq("client_id", row.client_id)
      .eq("config_version", row.config_version)
      .select()
      .maybeSingle();
    if (error) fail(error);
    if (!data) throw new StoreError("refused", `replaceVersion: no such version ${row.config_version} for ${row.client_id}`);
    return fromRow(data);
  }

  /**
   * Append one audit event. Separate from the four-method contract on purpose:
   * the authority does not need it, and a store that cannot record history is
   * still a valid store.
   */
  async function appendEvent(event) {
    const { error } = await db.from(EVENTS_TABLE).insert({
      client_id: event.clientId,
      config_version: event.configVersion ?? null,
      event_type: event.eventType,
      actor: event.actor ?? null,
      actor_role: event.actorRole ?? null,
      source: event.source ?? null,
      occurred_at: event.occurredAt ?? (typeof now === "function" ? now().toISOString() : null),
      metadata: event.metadata ?? null,
    });
    if (error) fail(error);
    return true;
  }

  async function listEvents(clientId, { limit = 100 } = {}) {
    const { data, error } = await db
      .from(EVENTS_TABLE)
      .select("*")
      .eq("client_id", clientId)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) fail(error);
    return (data || []).map((r) => ({
      clientId: r.client_id,
      configVersion: r.config_version,
      eventType: r.event_type,
      actor: r.actor,
      actorRole: r.actor_role,
      source: r.source,
      occurredAt: r.occurred_at,
      metadata: r.metadata,
    }));
  }

  return {
    kind: "postgres",
    listVersions,
    getVersion,
    putVersion,
    replaceVersion,
    appendEvent,
    listEvents,
  };
}

module.exports = {
  createPostgresBlueprintStore,
  toRow,
  fromRow,
  contentHashOf,
  bodyOf,
  describeDbError,
  StoreError,
  VERSIONS_TABLE,
  EVENTS_TABLE,
  METADATA_COLUMNS,
};
