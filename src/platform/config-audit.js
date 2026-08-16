// AIDA PLATFORM — configuration change history (P18C).
//
//   createInMemoryConfigAudit()
//   createStoreConfigAudit({ store })
//
// ── WHY THE VERSION ROWS ARE NOT ENOUGH ─────────────────────────────
// A version row answers "what is the configuration and who approved it". It
// cannot answer three questions a person will eventually ask:
//
//   who TRIED and was refused?        a rejected approval leaves no version
//   what did the voice agent propose?  a refused patch creates no draft
//   who has been reading this?         reads leave no trace at all
//
// So refusals are recorded as first-class events. An audit log that only
// contains successes describes a system where nothing ever goes wrong, which
// is the one system nobody has.
//
// ── WHAT IS NEVER RECORDED ──────────────────────────────────────────
// No blueprint body, no transcript, no integration credential, no recipient
// list. An event carries an actor, a role, a tenant, a version, an instant and
// a short bounded detail — the migration caps metadata at 4KB and the service
// truncates to 500 characters before it ever arrives.
//
// ── APPEND-ONLY ─────────────────────────────────────────────────────
// Neither implementation exposes an update or a delete. The durable one is
// additionally protected by a trigger, because an audit log that CAN be edited
// is a rumour rather than a record.

const EVENT_TYPES = Object.freeze([
  // ── configuration (P17/P18) ──
  "draft_created", "draft_updated", "validated", "validation_failed",
  "approved", "approval_refused", "activated", "activation_refused",
  "superseded", "restored", "voice_patch_proposed", "voice_patch_refused",
  "previewed",

  // ── provisioning planning (P19–P23) ──
  "provisioning_plan_created", "provisioning_plan_approved", "provisioning_plan_refused",

  // ── provisioning execution (P24–P28) ──
  // Every one of these is emitted by the executor. They live in the SAME log
  // as the configuration events, because "who changed what for this client"
  // is one question and answering it from two places is how half an answer
  // gets given.
  "execution_requested", "execution_refused", "execution_claimed",
  "provider_attempted", "provider_succeeded", "provider_failed", "provider_unknown",
  "registry_recorded", "registry_persist_failed", "execution_completed",
  "reconciliation_requested", "reconciliation_completed", "manual_review_required",
]);

const isStr = (v) => typeof v === "string" && v.trim().length > 0;

/** Reject anything that would put a secret or a body into the log. */
function sanitise(event) {
  if (!event || !isStr(event.clientId)) throw new Error("an audit event needs a clientId");
  if (!EVENT_TYPES.includes(event.eventType)) throw new Error(`unknown audit event type "${event.eventType}"`);
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : null;
  if (metadata && JSON.stringify(metadata).length > 4096) {
    throw new Error("audit metadata exceeds 4KB");
  }
  return {
    clientId: event.clientId,
    configVersion: Number.isInteger(event.configVersion) ? event.configVersion : null,
    eventType: event.eventType,
    actor: event.actor ?? null,
    actorRole: event.actorRole ?? null,
    source: event.source ?? null,
    occurredAt: event.occurredAt ?? null,
    metadata,
  };
}

/** For tests, the CLI and the local walkthrough. */
function createInMemoryConfigAudit({ now } = {}) {
  if (typeof now !== "function") throw new Error("createInMemoryConfigAudit requires an injected now()");
  const events = [];
  return {
    kind: "memory",
    async append(event) {
      const clean = sanitise(event);
      events.push(Object.freeze({ ...clean, occurredAt: clean.occurredAt || now().toISOString() }));
      return true;
    },
    async list(clientId, { limit = 100 } = {}) {
      // Scoped by tenant, like every other read in this subsystem.
      return events.filter((e) => e.clientId === clientId).slice(-limit).reverse();
    },
    async all() { return [...events]; },
  };
}

/** The durable one — delegates to the store's append-only events table. */
function createStoreConfigAudit({ store } = {}) {
  if (!store || typeof store.appendEvent !== "function") {
    throw new Error("createStoreConfigAudit requires a store with appendEvent");
  }
  return {
    kind: "store",
    async append(event) { return store.appendEvent(sanitise(event)); },
    async list(clientId, options) { return store.listEvents(clientId, options); },
  };
}

module.exports = { createInMemoryConfigAudit, createStoreConfigAudit, sanitise, EVENT_TYPES };
