// AIDA PLATFORM — which store the application uses, and why it refuses.
//
//   resolveStoreBinding({ mode, db, now, schemaProbe })
//
// ── THE RULING ──────────────────────────────────────────────────────
// ACP1 has not been applied to any database, so the application still uses the
// in-memory store. That is a DEFAULT, not an accident, and this module makes it
// explicit rather than leaving it as a line somebody has to notice in a router.
//
// ── AND THE PART THAT MATTERS ───────────────────────────────────────
//
//   THERE IS NO SILENT FALLBACK FROM POSTGRES TO MEMORY.
//
// A configuration subsystem that quietly serves from memory when the database
// is unavailable is a subsystem that answers a business telephone with an
// empty configuration and reports success. So if `postgres` is requested and
// the schema cannot be shown to be ready, this REFUSES — it does not degrade.
//
// Memory mode is available, but it must be ASKED FOR. Requesting postgres and
// receiving memory is the failure this file exists to prevent.

const { createInMemoryBlueprintStore } = require("./blueprint-authority");
const { createPostgresBlueprintStore } = require("./blueprint-store-postgres");

const STORE_MODES = Object.freeze(["memory", "postgres"]);

const BINDING_CODES = Object.freeze({
  OK: "ok",
  UNKNOWN_MODE: "unknown_store_mode",
  NO_DB: "postgres_mode_requires_a_db_handle",
  SCHEMA_UNVERIFIED: "postgres_schema_readiness_could_not_be_established",
  SCHEMA_ABSENT: "postgres_schema_is_not_present",
});

const fail = (code, message) => Object.freeze({ ok: false, code, message, store: null });

/**
 * @param {string}   mode         "memory" (default) or "postgres"
 * @param {object}   db           a Supabase-shaped handle, required for postgres
 * @param {Function} now          injected clock
 * @param {Function} schemaProbe  async () => ({ present: boolean, detail })
 *                                Injected so this module performs no query
 *                                itself and can be tested without a database.
 */
async function resolveStoreBinding({ mode = "memory", db = null, now, schemaProbe = null } = {}) {
  if (!STORE_MODES.includes(mode)) {
    return fail(BINDING_CODES.UNKNOWN_MODE, `store mode must be one of ${STORE_MODES.join(", ")}`);
  }
  if (typeof now !== "function") {
    return fail(BINDING_CODES.UNKNOWN_MODE, "an injected now() is required");
  }

  if (mode === "memory") {
    return Object.freeze({
      ok: true,
      code: BINDING_CODES.OK,
      mode: "memory",
      store: createInMemoryBlueprintStore(),
      durable: false,
      // Said out loud so a caller cannot mistake it for durability.
      note: "IN-MEMORY. Configuration does not survive a restart. This is the default because ACP1 has not been applied to any database.",
    });
  }

  // ── postgres, and every way it can refuse ──
  if (!db || typeof db.from !== "function") {
    return fail(BINDING_CODES.NO_DB, "postgres mode needs an injected db handle — and will not fall back to memory");
  }
  if (typeof schemaProbe !== "function") {
    return fail(
      BINDING_CODES.SCHEMA_UNVERIFIED,
      "postgres mode needs a schema probe. Binding to tables nobody has confirmed exist is how an empty configuration reaches a caller",
    );
  }

  let probe;
  try {
    probe = await schemaProbe();
  } catch (error) {
    // An unreachable database is UNVERIFIED, never "assume it is fine" and
    // never "use memory instead".
    return fail(BINDING_CODES.SCHEMA_UNVERIFIED, `the schema probe failed: ${(error && error.message) || error}`);
  }
  if (!probe || probe.present !== true) {
    return fail(
      BINDING_CODES.SCHEMA_ABSENT,
      `ACP1 does not appear to be applied${probe && probe.detail ? ` (${probe.detail})` : ""}. Apply the migration and verify it before requesting postgres mode`,
    );
  }

  return Object.freeze({
    ok: true,
    code: BINDING_CODES.OK,
    mode: "postgres",
    store: createPostgresBlueprintStore({ db, now }),
    durable: true,
    note: "Durable. ACP1 was confirmed present by the injected schema probe before binding.",
  });
}

/**
 * A probe that asks the database whether ACP1 is there, without assuming it is.
 * Injected into resolveStoreBinding so that function performs no query itself.
 */
function createAcp1SchemaProbe({ db }) {
  return async function probe() {
    // A read of zero rows is enough: the query only succeeds if the table
    // exists. It writes nothing and returns nothing sensitive.
    const { error } = await db.from("platform_config_versions").select("client_id").limit(1);
    if (error) return { present: false, detail: error.message || String(error) };
    return { present: true, detail: "platform_config_versions is readable" };
  };
}

module.exports = { resolveStoreBinding, createAcp1SchemaProbe, STORE_MODES, BINDING_CODES };
