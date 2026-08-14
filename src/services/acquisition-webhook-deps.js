// AIDA Locksmith Acquisition — the webhook's durable dependencies (E-12D).
//
//   await createAcquisitionWebhookDeps({ now })   → { store, recorder }
//
// ── WHAT THIS FIXES ─────────────────────────────────────────────────
// E-11A built the acquisition webhook ingress and mounted it, but the route
// called `createAcquisitionWebhookHandler()` with no dependencies. The handler
// defaults `store` to null, so a genuine signed Retell event was verified,
// fingerprinted, acknowledged — and then refused:
//
//   acquisition_event_store_unavailable   mutated: false
//
// Fail-safe, and useless. This module is the composition that makes the rest of
// the chain reachable.
//
// ── IT COMPOSES; IT DOES NOT REIMPLEMENT ────────────────────────────
// Every authority here already existed and is reused as-is:
//
//   createSupabaseAcquisitionStore   E-7B1 / M8C   the durable store
//   createDurableSuppression         M8C           hydrated suppression list
//   createDurableOutcomes            M8C           outcome → suppression → append
//
// There is no second persistence model, no SQL in the route, and no ad-hoc
// Supabase client — `createSupabaseAcquisitionStore` resolves the repo-standard
// client itself, lazily.
//
// ── WHY IT IS ASYNC, AND WHY THAT MATTERS ───────────────────────────
// `createDurableSuppression` HYDRATES from the store at construction: it calls
// `store.listSuppressions()` before returning. Building these dependencies is
// therefore a real database read, not an object graph.
//
// That is the whole reason this is a function called on demand rather than a
// module-level constant. Production has NO acquisition schema, and the route
// module is imported unconditionally by server.js. If composition happened at
// import, every production deploy would query `acquisition_suppressions` and
// fail — a module existing would have become a database access. Instead the
// route builds this on FIRST REQUEST, which can only happen after the three
// feature flags have opened the gate. Flags off ⇒ never constructed ⇒ no
// acquisition table is touched.
//
// ── WHAT IS DELIBERATELY NOT WIRED ──────────────────────────────────
// `audit` stays null. The decision chain (acquisition-decision-log.js) is a
// hash-linked append-only structure with its own contention handling, not a
// collaborator that can be dropped in here; wiring it is a separate decision
// with its own failure modes. Leaving it null does not weaken the outcome path:
// the recorder still refuses — `suppression_unavailable` — any outcome that
// must suppress when no suppression list is available, so nothing can be
// recorded as "opted out" without the business actually becoming uncallable.

const { createSupabaseAcquisitionStore } = require("./acquisition-store");
const { createDurableSuppression, createDurableOutcomes } = require("./acquisition-durable");

/**
 * Build the durable dependencies the acquisition webhook handler needs.
 *
 * @param {function} now      injected clock — required, never defaulted here
 * @param {object}   [store]  an acquisition store; defaults to the Supabase one
 * @param {object}   [audit]  the decision log. See the header: null by design
 * @returns {Promise<{store: object, recorder: object}>}
 */
async function createAcquisitionWebhookDeps({ now, store = null, audit = null } = {}) {
  if (typeof now !== "function") {
    throw new Error("createAcquisitionWebhookDeps requires an injected now().");
  }

  const durableStore = store || createSupabaseAcquisitionStore();

  // Hydrates from the store. This is the call that makes composition a database
  // operation, and the reason it must not happen at module load.
  const suppression = await createDurableSuppression({ now, store: durableStore, audit });

  // The recorder owns "suppress first, then append the outcome". It is handed
  // the DURABLE suppression service so that ordering is a real write ordering
  // rather than a description of one.
  const recorder = createDurableOutcomes({ now, suppression, store: durableStore, audit });

  return Object.freeze({ store: durableStore, recorder, suppression });
}

module.exports = { createAcquisitionWebhookDeps };
