// AIDA Locksmith Acquisition — the Retell webhook route (E-11A).
//
//   POST /webhooks/retell/acquisition
//
// ── DORMANT, AND BEHIND ITS OWN SWITCH ──────────────────────────────
// Flag-off is byte-identical to the route not existing: the gate calls
// next("router") and the path 404s.
//
// It needs THREE flags, and the third is the point:
//
//   RETELL_ENABLED                       the integration at all
//   RETELL_WEBHOOK_ENABLED               webhooks at all
//   RETELL_ACQUISITION_WEBHOOK_ENABLED   THIS path
//
// The third exists because enabling onboarding webhooks must never enable
// acquisition ingestion as a side effect. It is the same reason acquisition
// keeps its own resource order rather than joining the receptionist's, and the
// same reason it will need its own capability gate before it can dial.
//
// ── WHY A SEPARATE PATH FROM /webhooks/retell ───────────────────────
// Retell attaches a webhook_url per AGENT, so the acquisition agent will point
// here and nothing else will. Sharing the onboarding ingress would mean every
// acquisition delivery traversing a handler whose binding model is
// "which onboarding session is this?" — see the handler's header.
//
// ── NOT DEPLOYED ────────────────────────────────────────────────────
// Mounting it in source is not exposing it. No agent points at it, no Retell
// webhook_url is configured, the flag is off by default, and nothing has been
// deployed. `RETELL_ACQUISITION_WEBHOOK_URL` is deliberately undocumented as a
// value — there is no deployed route for it to name yet.

const express = require("express");
const router = express.Router();

const { isRetellEnabled, isWebhookEnabled, getRetellConfig } = require("../config/retell");
const { createAcquisitionWebhookHandler } = require("./acquisition-retell-webhook-handler");
const { createAcquisitionWebhookDeps } = require("../services/acquisition-webhook-deps");

const ACQUISITION_WEBHOOK_PATH = "/webhooks/retell/acquisition";

/** THIS path needs its own flag, not just the shared webhook one. */
function isAcquisitionWebhookEnabled(env = process.env) {
  return env.RETELL_ACQUISITION_WEBHOOK_ENABLED === "true";
}

function acquisitionWebhookGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isRetellEnabled(env) || !isWebhookEnabled(env) || !isAcquisitionWebhookEnabled(env)) {
      return next("router");
    }
    next();
  };
}

router.use(acquisitionWebhookGate());

// ── THE DURABLE COMPOSITION, BUILT ON FIRST REQUEST (E-12D) ─────────
//
// Until E-12D this file built the handler with no dependencies at all, so its
// `store` defaulted to null and every genuine verified event ended at
// `acquisition_event_store_unavailable`.
//
// It is built HERE rather than in the handler — the handler stays a pure
// function of its injected dependencies, which is what makes it testable — and
// it is built LAZILY rather than at module load, which is the load-bearing part:
//
//   `createAcquisitionWebhookDeps` hydrates the suppression list from the
//   database as part of construction. Production has NO acquisition schema, and
//   server.js imports this router unconditionally. Composing at import would
//   mean every production deploy queried `acquisition_suppressions` and failed
//   — a module merely existing would have become a database access.
//
// Because `acquisitionWebhookGate` runs first, this can only be reached once
// all three flags are on. Flags off ⇒ never built ⇒ no acquisition table is
// touched. That is asserted by test, not assumed.
//
// Memoised on success, and NOT memoised on failure: a transient outage at the
// moment of first delivery must not disable the route for the process lifetime.
// E-12L moved WHEN this runs. It is now handed to the handler as a builder and
// called only after a delivery has verified — so an unsigned request never
// causes a database connection, and the honest 401 is not replaced by a 503
// about storage the caller was never entitled to reach.
let _deps = null;
let _building = null;

async function resolveDeps(overrides = {}) {
  if (_deps) return _deps;
  if (!_building) {
    _building = createAcquisitionWebhookDeps({ now: () => new Date(), ...overrides }).catch((err) => {
      _building = null; // a transient outage must not disable the route for the process
      throw err;
    });
  }
  _deps = await _building;
  return _deps;
}

// express.raw gives the exact bytes the signature was computed over.
// JSON.stringify(req.body) would produce different bytes and every signature
// would fail.
const config = getRetellConfig();
router.post(
  ACQUISITION_WEBHOOK_PATH,
  express.raw({ type: "application/json", limit: config.webhookMaxBytes }),
  createAcquisitionWebhookHandler({ resolveDeps, now: () => new Date() }),
);

module.exports = router;
module.exports.acquisitionWebhookGate = acquisitionWebhookGate;
module.exports.isAcquisitionWebhookEnabled = isAcquisitionWebhookEnabled;
module.exports.ACQUISITION_WEBHOOK_PATH = ACQUISITION_WEBHOOK_PATH;
// Exported for the composition tests. Resetting is a test affordance, not a
// runtime one — nothing in src/ calls it.
module.exports.resolveDeps = resolveDeps;
module.exports.__resetHandlerForTests = () => {
  _deps = null;
  _building = null;
};
