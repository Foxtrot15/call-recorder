// AIDA PLATFORM — the store the application actually uses (P36 Phase 4).
//
//   platformStoreMode(env)      "memory" | "postgres", from PLATFORM_CONFIG_STORE
//   getPlatformServices()       memoised; builds once, or refuses forever
//   platformStoreGate()         express middleware: 503 while the store is refused
//   resetPlatformServices()     tests only
//
// ── WHY THIS IS LAZY ────────────────────────────────────────────────
// resolveStoreBinding is async — it asks the database whether ACP1 is there
// before binding to it — and a router is constructed synchronously at import.
// So the services are built on the first request that needs them and memoised.
//
// The alternative was to build a memory store at import and swap it later,
// which is precisely the silent fallback the binding exists to prevent.
//
// ── WHAT IT DOES WHEN THE BINDING REFUSES ───────────────────────────
// Every request gets 503 with the binding's own reason. It does NOT serve from
// memory, it does not retry into a different mode, and it does not pretend the
// subsystem is available. A configuration API that answers from an empty
// in-memory store because the database was unreachable is one that tells a
// business its assistant has no services.
//
// ── STORE SELECTION IS EXPLICIT ─────────────────────────────────────
// PLATFORM_CONFIG_STORE, exact strings only, defaulting to memory. NODE_ENV is
// deliberately not consulted: "production means postgres" is an inference, and
// the thing being inferred is which database a business's configuration lives
// in.

const { resolveStoreBinding, createAcp1SchemaProbe, STORE_MODES } = require("../platform/store-binding");
const { createConfigService } = require("../platform/config-service");
const { createProvisioningService } = require("../platform/provisioning-service");
const { createInMemoryPlanStore } = require("../platform/provisioning-plan-authority");
const { createStoreConfigAudit, createInMemoryConfigAudit } = require("../platform/config-audit");

/** Exact-string parse, the D7 house rule. Anything unrecognised is memory. */
function platformStoreMode(env = process.env) {
  const requested = env.PLATFORM_CONFIG_STORE;
  return STORE_MODES.includes(requested) ? requested : "memory";
}

/**
 * A Supabase handle for postgres mode, or null.
 *
 * Required lazily so a checkout with no node_modules can still load this file —
 * the house convention — and so memory mode never touches a database client.
 */
function defaultDbFactory(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

let pending = null;
let resolved = null;

/**
 * Build once. On refusal the refusal is memoised too — a subsystem that
 * reconnects silently on the next request hides the outage from whoever needs
 * to fix it.
 */
function getPlatformServices({ env = process.env, dbFactory = defaultDbFactory, now = () => new Date() } = {}) {
  if (resolved) return Promise.resolve(resolved);
  if (pending) return pending;

  pending = (async () => {
    const mode = platformStoreMode(env);
    const db = mode === "postgres" ? dbFactory(env) : null;

    const binding = await resolveStoreBinding({
      mode, db, now,
      schemaProbe: mode === "postgres" && db ? createAcp1SchemaProbe({ db }) : null,
    });

    if (!binding.ok) {
      resolved = Object.freeze({
        ok: false,
        mode,
        code: binding.code,
        message: binding.message,
        configService: null,
        provisioningService: null,
      });
      return resolved;
    }

    const audit = binding.mode === "postgres"
      ? createStoreConfigAudit({ store: binding.store })
      : createInMemoryConfigAudit({ now });

    const configService = createConfigService({ store: binding.store, now, audit });
    const provisioningService = createProvisioningService({
      configService,
      // Provisioning plans have no durable home: ACP2 is not applied, and this
      // milestone does not need it. In-memory is the honest answer, and the
      // provisioning surface already says a plan is never an execution.
      planStore: createInMemoryPlanStore(),
      now,
      providerRefs: {},   // deployment facts are injected, never invented
      audit,
    });

    resolved = Object.freeze({
      ok: true,
      mode: binding.mode,
      durable: binding.durable,
      note: binding.note,
      configService,
      provisioningService,
    });
    return resolved;
  })();

  return pending;
}

/**
 * Express middleware. Resolves the services once and hangs them off the
 * request, or answers 503 with the reason. Mounted in front of every platform
 * route so no handler ever sees a half-built subsystem.
 */
function platformStoreGate(options = {}) {
  return async function gate(req, res, next) {
    let services;
    try {
      services = await getPlatformServices(options);
    } catch (error) {
      return res.status(503).json({
        error: "Configuration store unavailable.",
        code: "store_binding_failed",
        detail: (error && error.message) || String(error),
      });
    }

    if (!services.ok) {
      // FAIL CLOSED. Not memory, not a retry, not a partial answer.
      return res.status(503).json({
        error: "Configuration store unavailable.",
        code: services.code,
        detail: services.message,
      });
    }

    req.platform = services;
    return next();
  };
}

/** Tests only. Nothing in src calls this. */
function resetPlatformServices() {
  pending = null;
  resolved = null;
}

module.exports = {
  platformStoreMode, getPlatformServices, platformStoreGate, resetPlatformServices, defaultDbFactory,
};
