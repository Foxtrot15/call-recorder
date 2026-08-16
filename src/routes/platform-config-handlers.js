// AIDA PLATFORM — the configuration HTTP surface (P17). Behaviour only.
//
// Imports no express, so every handler is testable without node_modules —
// the same split locksmith-portal-handlers.js uses.
//
// ── WHAT THESE HANDLERS MAY NOT DO ──────────────────────────────────
// No endpoint provisions a Retell resource, enables calling, alters calling
// state, executes a dial, enqueues a call, creates a number, or mutates
// provider_resources. There is no import path from here to any of them and a
// ratchet reads this file to prove it.
//
// The most important one: ACTIVATION IS NOT DEPLOYMENT. POST .../activate
// makes an approved version the configuration AIDA considers current. It sends
// nothing anywhere.
//
// ── THE TENANT IS NEVER TAKEN FROM THE URL ──────────────────────────
// `:clientId` in the path says which client the caller WANTS. Authority comes
// from `req.clientId`, which src/middleware/auth.js resolved server-side from
// a verified session. Every handler asks config-access whether the principal
// may act on the requested client, and a mismatch is refused with one
// indistinguishable message — a caller poking at other clients' URLs learns
// only that they may not.

const { principalFromRequest } = require("../platform/config-access");
const { SERVICE_CODES } = require("../platform/config-service");

/** Service outcome -> HTTP status. */
const STATUS_FOR = Object.freeze({
  [SERVICE_CODES.OK]: 200,
  [SERVICE_CODES.FORBIDDEN]: 403,
  [SERVICE_CODES.NOT_FOUND]: 404,
  [SERVICE_CODES.INVALID]: 422,
  [SERVICE_CODES.CONFLICT]: 409,
  [SERVICE_CODES.UNAVAILABLE]: 503,
});

/**
 * What a refusal is allowed to say. Deliberately narrow: a code and a short
 * message. Never a stack, never a database string, never whether the client or
 * the version exists.
 */
const SAFE_REFUSALS = Object.freeze({
  forbidden: "Not authorised for this client.",
  not_found: "Not found.",
});

const asVersion = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && String(n) === String(raw).trim() ? n : null;
};

function createPlatformConfigHandlers({ service, logger = console } = {}) {
  if (!service) throw new Error("createPlatformConfigHandlers requires a config service");

  /** Everything a handler shares: principal, tenant, and a uniform reply. */
  function begin(req, res) {
    const principal = principalFromRequest(req);
    const clientId = req.params && req.params.clientId;
    if (!principal) {
      res.status(403).json({ error: SAFE_REFUSALS.forbidden, code: "no_authenticated_principal" });
      return null;
    }
    if (!clientId) {
      res.status(404).json({ error: SAFE_REFUSALS.not_found });
      return null;
    }
    return { principal, clientId };
  }

  function reply(res, result, okStatus = 200) {
    if (result.ok) {
      const { ok: _ok, outcome: _outcome, ...body } = result;
      return res.status(okStatus).json(body);
    }
    const status = STATUS_FOR[result.outcome] || 400;
    const body = { error: SAFE_REFUSALS[result.outcome] || result.message, code: result.code };
    // Validation errors are the caller's own input coming back — safe, and the
    // whole point of the endpoint.
    if (result.errors) body.errors = result.errors;
    if (result.outcome === SERVICE_CODES.CONFLICT) body.error = result.message;
    if (result.outcome === SERVICE_CODES.INVALID) body.error = result.message;
    if (result.outcome === SERVICE_CODES.UNAVAILABLE) body.error = "Configuration store unavailable.";
    return res.status(status).json(body);
  }

  const guard = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      // A handler must never leak an internal message. The detail goes to the
      // log, the caller gets a code.
      logger.error(`[platform-config] ${name} failed: ${error && error.message}`);
      res.status(500).json({ error: "Configuration request failed.", code: "handler_error" });
    }
  };

  return {
    // ── reads ──
    getActive: guard("getActive", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      reply(res, await service.getActive(ctx));
    }),

    listVersions: guard("listVersions", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      reply(res, await service.listVersions(ctx));
    }),

    getVersion: guard("getVersion", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const configVersion = asVersion(req.params.versionId);
      if (configVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      reply(res, await service.getVersion({ ...ctx, configVersion }));
    }),

    diff: guard("diff", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const toVersion = asVersion(req.params.versionId);
      if (toVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      const fromRaw = req.query && req.query.from;
      const fromVersion = fromRaw === undefined || fromRaw === "" ? null : asVersion(fromRaw);
      if (fromRaw !== undefined && fromRaw !== "" && fromVersion === null) {
        return res.status(422).json({ error: "from must be a positive whole number", code: "bad_request" });
      }
      reply(res, await service.diff({ ...ctx, fromVersion, toVersion }));
    }),

    history: guard("history", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      reply(res, await service.history(ctx));
    }),

    // ── writes ──
    createDraft: guard("createDraft", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const body = req.body || {};
      if (!body.blueprint || typeof body.blueprint !== "object") {
        return res.status(422).json({ error: "a blueprint body is required", code: "bad_request" });
      }
      // `source` is RECORDED, never trusted. A caller claiming source:"operator"
      // gains nothing — authority comes from the principal.
      reply(res, await service.createDraft({ ...ctx, blueprint: body.blueprint, source: "ui" }), 201);
    }),

    updateDraft: guard("updateDraft", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const configVersion = asVersion(req.params.versionId);
      if (configVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      const body = req.body || {};
      if (!body.blueprint || typeof body.blueprint !== "object") {
        return res.status(422).json({ error: "a blueprint body is required", code: "bad_request" });
      }
      const args = {
        ...ctx,
        configVersion,
        // Replace the editable sections wholesale. Identity and metadata are
        // not among them: a PATCH cannot move a draft to another tenant.
        mutate: (draft) => {
          for (const section of [
            "services", "serviceArea", "hours", "callHandling", "knowledge",
            "booking", "voice", "compliance", "outbound", "integrations", "extensions",
          ]) {
            if (body.blueprint[section] !== undefined) draft[section] = body.blueprint[section];
          }
          if (body.blueprint.identity && typeof body.blueprint.identity === "object") {
            const { clientId: _ignored, vertical: _alsoIgnored, ...rest } = body.blueprint.identity;
            draft.identity = { ...draft.identity, ...rest };
          }
        },
      };
      if (Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")) {
        args.expectedUpdatedAt = body.expectedUpdatedAt;
      }
      reply(res, await service.updateDraft(args));
    }),

    validate: guard("validate", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const configVersion = asVersion(req.params.versionId);
      if (configVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      reply(res, await service.validate({ ...ctx, configVersion }));
    }),

    approve: guard("approve", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const configVersion = asVersion(req.params.versionId);
      if (configVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      const reason = req.body && typeof req.body.reason === "string" ? req.body.reason.slice(0, 2000) : null;
      reply(res, await service.approve({ ...ctx, configVersion, reason }));
    }),

    // ACTIVATION IS NOT DEPLOYMENT.
    activate: guard("activate", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const configVersion = asVersion(req.params.versionId);
      if (configVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      reply(res, await service.activate({ ...ctx, configVersion }));
    }),

    restore: guard("restore", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const configVersion = asVersion(req.params.versionId);
      if (configVersion === null) return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      reply(res, await service.restore({ ...ctx, configVersion }), 201);
    }),

    proposePatch: guard("proposePatch", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const body = req.body || {};
      if (!body.patch || typeof body.patch !== "object") {
        return res.status(422).json({ error: "a patch is required", code: "bad_request" });
      }
      reply(res, await service.proposePatch({ ...ctx, patch: body.patch, source: "api" }), 201);
    }),

    // ── preview: pure, no provider contact ──
    preview: guard("preview", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const raw = req.params.versionId;
      const configVersion = raw === undefined || raw === "active" ? null : asVersion(raw);
      if (raw !== undefined && raw !== "active" && configVersion === null) {
        return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      }
      const direction = req.query && req.query.direction === "outbound" ? "outbound" : "inbound";
      reply(res, await service.preview({ ...ctx, configVersion, direction }));
    }),
  };
}

module.exports = { createPlatformConfigHandlers, STATUS_FOR, SAFE_REFUSALS };
