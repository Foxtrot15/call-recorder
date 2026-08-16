// A deterministic in-process stand-in for Postgres — test infrastructure.
//
// ── WHY THIS EXISTS AND WHY IT IS NOT A STUB ────────────────────────
// The Postgres adapter is only as good as what the database refuses. A fake
// that happily accepts everything would let the contract suite pass while the
// real invariants — one active version per client, frozen approved content,
// append-only events — existed nowhere but in a .sql file nobody ran.
//
// So this fake ENFORCES the constraints acp1_create_client_configuration.sql
// declares, raising errors with the same SQLSTATE codes Postgres would:
//
//   23505  unique_violation   — version identity, and the one-active index
//   23514  check_violation    — every CHECK, and the guard triggers
//   23503  foreign_key_violation — the composite lineage references
//
// It is deliberately NOT a SQL engine. It understands the exact query shapes
// the adapter builds and nothing else, and it throws on a shape it does not
// recognise rather than quietly returning [].
//
// ── DRIFT ───────────────────────────────────────────────────────────
// ENFORCED_CONSTRAINTS names every rule below. A test cross-checks those names
// against the migration file, so a constraint added to the SQL and forgotten
// here fails loudly instead of going untested.

const CONSTRAINT_CODES = Object.freeze({
  unique: "23505",
  check: "23514",
  foreignKey: "23503",
});

/** Every rule this fake reproduces, by the name the migration gives it. */
const ENFORCED_CONSTRAINTS = Object.freeze([
  "pcv_client_version_unique",
  "pcv_one_active_per_client",
  "pcv_body_client_matches",
  "pcv_body_schema_matches",
  "pcv_draft_is_clean",
  "pcv_validated_has_instant",
  "pcv_approved_is_complete",
  "pcv_approved_hash_is_content_hash",
  "pcv_active_is_complete",
  "pcv_activation_only_when_earned",
  "pcv_supersede_only_when_superseded",
  "pcv_lineage_not_self",
  "pcv_instants_ordered",
  "pcv_supersedes_fk",
  "pcv_restored_from_fk",
  "pcv_superseded_by_fk",
  "pcv_guard_frozen_rows",
  "pcv_refuse_delete",
  "pce_append_only",
]);

const STATUSES = ["draft", "validated", "approved", "active", "superseded"];
const SOURCES = ["ui", "voice", "api", "import", "operator"];
const EVENT_TYPES = [
  "draft_created", "draft_updated", "validated", "validation_failed",
  "approved", "approval_refused", "activated", "activation_refused",
  "superseded", "restored", "voice_patch_proposed", "voice_patch_refused",
  "previewed",
];
const ACTOR_ROLES = ["operator", "client_owner", "client_editor", "client_viewer", "voice_agent", "system", "import"];
const FROZEN = ["approved", "active", "superseded"];

class PgError extends Error {
  constructor(code, constraint, message) {
    super(message);
    this.code = code;
    this.constraint = constraint;
    this.details = message;
  }
}

const violation = (constraint, message) => {
  throw new PgError(CONSTRAINT_CODES.check, constraint, `check constraint "${constraint}" violated: ${message}`);
};
const conflict = (constraint, message) => {
  throw new PgError(CONSTRAINT_CODES.unique, constraint, `duplicate key value violates unique constraint "${constraint}": ${message}`);
};
const lineageBroken = (constraint, message) => {
  throw new PgError(CONSTRAINT_CODES.foreignKey, constraint, `insert or update violates foreign key constraint "${constraint}": ${message}`);
};

const ts = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Every CHECK on platform_config_versions, applied to one candidate row. */
function checkVersionRow(row) {
  if (!STATUSES.includes(row.status)) violation("platform_config_versions_status_check", `status "${row.status}"`);
  if (!SOURCES.includes(row.source)) violation("platform_config_versions_source_check", `source "${row.source}"`);
  if (!Number.isInteger(row.config_version) || row.config_version < 1) {
    violation("platform_config_versions_config_version_check", "config_version must be >= 1");
  }
  if (typeof row.content_hash !== "string" || row.content_hash.length !== 64) {
    violation("platform_config_versions_content_hash_check", "content_hash must be 64 chars");
  }
  if (typeof row.client_id !== "string" || !row.client_id.length) {
    violation("platform_config_versions_client_id_check", "client_id required");
  }

  const identity = row.blueprint && row.blueprint.identity;
  if (!identity || identity.clientId !== row.client_id) {
    violation("pcv_body_client_matches", `body says "${identity && identity.clientId}", row says "${row.client_id}"`);
  }
  if (row.blueprint.schemaVersion !== row.schema_version) {
    violation("pcv_body_schema_matches", `body says "${row.blueprint.schemaVersion}", row says "${row.schema_version}"`);
  }

  if (["draft", "validated"].includes(row.status)) {
    if (row.approved_at || row.approved_by || row.approved_hash || row.activated_at || row.activated_by) {
      violation("pcv_draft_is_clean", `a ${row.status} row carries approval or activation metadata`);
    }
  }
  if (["validated", "approved", "active"].includes(row.status) && !row.validated_at) {
    violation("pcv_validated_has_instant", `${row.status} requires validated_at`);
  }
  if (["approved", "active"].includes(row.status)) {
    if (!row.approved_at || !row.approved_by || !row.approved_hash) {
      violation("pcv_approved_is_complete", `${row.status} requires approved_at, approved_by and approved_hash`);
    }
  }
  if (row.approved_hash && row.approved_hash !== row.content_hash) {
    violation("pcv_approved_hash_is_content_hash", "the approved hash is not the hash of the stored body");
  }
  if (row.status === "active" && (!row.activated_at || !row.activated_by)) {
    violation("pcv_active_is_complete", "active requires activated_at and activated_by");
  }
  if (!["active", "superseded"].includes(row.status) && (row.activated_at || row.activated_by)) {
    violation("pcv_activation_only_when_earned", `a ${row.status} row must not look activated`);
  }
  if (row.status !== "superseded" && (row.superseded_at || row.superseded_by || row.supersede_reason)) {
    violation("pcv_supersede_only_when_superseded", `a ${row.status} row carries supersession metadata`);
  }
  for (const field of ["supersedes", "restored_from", "superseded_by"]) {
    if (row[field] !== null && row[field] !== undefined && row[field] === row.config_version) {
      violation("pcv_lineage_not_self", `${field} points at itself`);
    }
  }
  const created = ts(row.created_at);
  if (created !== null) {
    for (const field of ["updated_at", "validated_at", "approved_at", "activated_at"]) {
      const t = ts(row[field]);
      if (t !== null && t < created) violation("pcv_instants_ordered", `${field} precedes created_at`);
    }
    const approved = ts(row.approved_at);
    const activated = ts(row.activated_at);
    if (approved !== null && activated !== null && activated < approved) {
      violation("pcv_instants_ordered", "activated_at precedes approved_at");
    }
  }
}

/** The composite lineage foreign keys — same client, existing version. */
function checkLineage(row, rows) {
  const exists = (n) => rows.some((r) => r.client_id === row.client_id && r.config_version === n);
  for (const [field, constraint] of [
    ["supersedes", "pcv_supersedes_fk"],
    ["restored_from", "pcv_restored_from_fk"],
    ["superseded_by", "pcv_superseded_by_fk"],
  ]) {
    const target = row[field];
    if (target === null || target === undefined) continue;   // MATCH SIMPLE
    if (!exists(target)) {
      lineageBroken(constraint, `${row.client_id} has no version ${target} for ${field}`);
    }
  }
}

/** The `pcv_guard_frozen_rows` trigger. */
function checkFrozenTransition(oldRow, newRow) {
  for (const field of ["id", "client_id", "config_version", "created_at"]) {
    if (clone(newRow[field]) !== undefined && String(newRow[field]) !== String(oldRow[field])) {
      violation("pcv_guard_frozen_rows", `identity is immutable (${field})`);
    }
  }
  if (!FROZEN.includes(oldRow.status)) return;

  const frozenFields = ["blueprint", "content_hash", "schema_version", "created_by", "source", "approved_at", "approved_by", "approved_hash"];
  for (const field of frozenFields) {
    const before = field === "blueprint" ? JSON.stringify(oldRow.blueprint) : oldRow[field];
    const after = field === "blueprint" ? JSON.stringify(newRow.blueprint) : newRow[field];
    if (after !== undefined && after !== before) {
      violation("pcv_guard_frozen_rows",
        `client=${oldRow.client_id} version=${oldRow.config_version} is ${oldRow.status} — content and approval are immutable`);
    }
  }
  if (newRow.status !== undefined && !FROZEN.includes(newRow.status)) {
    violation("pcv_guard_frozen_rows", `cannot go from ${oldRow.status} back to ${newRow.status}`);
  }
  if (oldRow.status === "active" && newRow.status !== undefined && !["active", "superseded"].includes(newRow.status)) {
    violation("pcv_guard_frozen_rows", "an active version may only be superseded");
  }
  if (oldRow.status === "superseded" && newRow.status !== undefined && newRow.status !== "superseded") {
    violation("pcv_guard_frozen_rows", "superseded is terminal — restore creates a NEW draft");
  }
}

function checkEventRow(row) {
  if (!EVENT_TYPES.includes(row.event_type)) {
    violation("platform_config_events_event_type_check", `event_type "${row.event_type}"`);
  }
  if (row.actor_role !== null && row.actor_role !== undefined && !ACTOR_ROLES.includes(row.actor_role)) {
    violation("platform_config_events_actor_role_check", `actor_role "${row.actor_role}"`);
  }
  if (row.source !== null && row.source !== undefined && !SOURCES.includes(row.source)) {
    violation("platform_config_events_source_check", `source "${row.source}"`);
  }
  if (row.metadata && JSON.stringify(row.metadata).length > 4096) {
    violation("platform_config_events_metadata_check", "metadata exceeds 4KB");
  }
}

/**
 * A Supabase-shaped handle over in-memory tables, enforcing the migration's
 * constraints. `failNext` makes a single operation fail, so an interrupted
 * activation can be tested without a real crash.
 */
function createFakePostgres({ seed = {}, uuid } = {}) {
  const tables = {
    platform_config_versions: (seed.platform_config_versions || []).map(clone),
    platform_config_events: (seed.platform_config_events || []).map(clone),
  };
  let counter = 0;
  const nextId = () => (typeof uuid === "function" ? uuid() : `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`);
  const state = { failNext: null, writes: 0, reads: 0 };

  function insertInto(table, row) {
    const rows = tables[table];
    if (!rows) throw new Error(`fake-postgres: unknown table "${table}"`);
    const record = { id: nextId(), ...clone(row) };

    if (table === "platform_config_versions") {
      checkVersionRow(record);
      if (rows.some((r) => r.client_id === record.client_id && r.config_version === record.config_version)) {
        conflict("pcv_client_version_unique", `(${record.client_id}, ${record.config_version}) already exists`);
      }
      if (record.status === "active" && rows.some((r) => r.client_id === record.client_id && r.status === "active")) {
        conflict("pcv_one_active_per_client", `${record.client_id} already has an active version`);
      }
      checkLineage(record, rows);
    } else {
      checkEventRow(record);
    }

    rows.push(record);
    state.writes += 1;
    return clone(record);
  }

  function updateIn(table, patch, filters) {
    if (table === "platform_config_events") {
      violation("pce_append_only", "platform_config_events is append-only");
    }
    const rows = tables[table];
    const matches = rows.filter((r) => filters.every(([col, val]) => r[col] === val));
    if (matches.length === 0) return [];

    const updated = [];
    for (const current of matches) {
      const candidate = { ...clone(current), ...clone(patch) };
      checkFrozenTransition(current, patch);
      checkVersionRow(candidate);
      if (candidate.status === "active") {
        const otherActive = rows.some(
          (r) => r.client_id === candidate.client_id && r.status === "active" && r.config_version !== candidate.config_version,
        );
        if (otherActive) {
          conflict("pcv_one_active_per_client", `${candidate.client_id} already has an active version`);
        }
      }
      checkLineage(candidate, rows);
      Object.assign(current, candidate);
      state.writes += 1;
      updated.push(clone(current));
    }
    return updated;
  }

  function deleteFrom(table) {
    violation(
      table === "platform_config_events" ? "pce_append_only" : "pcv_refuse_delete",
      `${table}: rows are never deleted`,
    );
  }

  /** The narrow query builder the adapter actually uses. */
  function from(table) {
    if (!tables[table]) throw new Error(`fake-postgres: unknown table "${table}"`);
    const q = {
      _op: null, _payload: null, _filters: [], _order: null, _limit: null,
      select() { if (!q._op) q._op = "select"; return q; },
      insert(row) { q._op = "insert"; q._payload = row; return q; },
      update(patch) { q._op = "update"; q._payload = patch; return q; },
      delete() { q._op = "delete"; return q; },
      eq(col, val) { q._filters.push([col, val]); return q; },
      order(col, opts) { q._order = [col, opts && opts.ascending === false ? -1 : 1]; return q; },
      limit(n) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q.then.bind(q)(); },
      single() { q._single = true; q._required = true; return q.then.bind(q)(); },
      then(resolve, reject) {
        let out;
        try {
          if (state.failNext) {
            const message = state.failNext;
            state.failNext = null;
            throw new PgError("08006", null, message);
          }
          if (q._op === "insert") {
            const created = insertInto(table, q._payload);
            out = q._single ? created : [created];
          } else if (q._op === "update") {
            const rows = updateIn(table, q._payload, q._filters);
            out = q._single ? (rows[0] ?? null) : rows;
          } else if (q._op === "delete") {
            deleteFrom(table);
          } else {
            state.reads += 1;
            let rows = tables[table].filter((r) => q._filters.every(([col, val]) => r[col] === val));
            if (q._order) {
              const [col, dir] = q._order;
              rows = [...rows].sort((a, b) => (a[col] > b[col] ? dir : a[col] < b[col] ? -dir : 0));
            }
            if (q._limit !== null) rows = rows.slice(0, q._limit);
            rows = rows.map(clone);
            if (q._single) {
              if (rows.length > 1) throw new PgError("PGRST116", null, "more than one row returned");
              out = rows[0] ?? null;
            } else {
              out = rows;
            }
          }
          const result = { data: out === undefined ? null : out, error: null };
          return Promise.resolve(result).then(resolve, reject);
        } catch (error) {
          return Promise.resolve({ data: null, error }).then(resolve, reject);
        }
      },
    };
    return q;
  }

  return {
    from,
    /** Test controls — not part of any Supabase surface. */
    _tables: tables,
    _state: state,
    _failNext(message) { state.failNext = message; },
    _rows(table) { return tables[table].map(clone); },
  };
}

module.exports = {
  createFakePostgres,
  ENFORCED_CONSTRAINTS,
  CONSTRAINT_CODES,
  STATUSES,
  SOURCES,
  EVENT_TYPES,
  ACTOR_ROLES,
  PgError,
};
