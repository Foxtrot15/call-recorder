// AIDA PLATFORM — capability ports, and fakes that stand in for real vendors (P11).
//
//   createIntegrationRegistry()          register / resolve adapters
//   capabilityPort(capability)           the contract an adapter must satisfy
//   createFakeAdapter({ capability })    an in-memory adapter for tests and demos
//
// ── WHY PORTS AND NOT CLIENTS ───────────────────────────────────────
// A blueprint says "this client wants bookings". It does not say Google
// Calendar, and it must never learn to: the day a business moves from one
// system to another should be a change of adapter, not a reopening of their
// configuration and a fresh round of approval.
//
// So a capability is a NAME with a contract, and an adapter is something that
// satisfies the contract. The registry is the only place the two meet.
//
// ── WHAT AN ADAPTER MAY NOT DO ──────────────────────────────────────
// An adapter is reached only through its capability, and the capabilities are
// a closed set: crm, calendar, booking, job_management, sms, email, webhook.
// There is deliberately no `telephony` capability and no `dial` operation. A
// client cannot configure their way to placing a call, because there is no
// port that places one — the compliance authorities own that, and they are
// not reachable from here.
//
// ── AND NOTHING HERE TALKS TO ANYTHING ──────────────────────────────
// Every adapter in this file is in-memory. A real one lives outside the
// platform domain, is injected, and is the only thing that opens a socket.
// The boundary ratchet asserts src/platform imports no transport at all, and
// that includes this file.

const { INTEGRATION_CAPABILITIES } = require("./client-blueprint");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

const INTEGRATION_CODES = Object.freeze({
  OK: "ok",
  UNKNOWN_CAPABILITY: "unknown_capability",
  NO_ADAPTER: "no_adapter_registered",
  NOT_ENABLED: "capability_not_enabled_for_client",
  BAD_ADAPTER: "adapter_does_not_satisfy_the_port",
  BAD_REQUEST: "request_is_not_valid_for_this_capability",
  ADAPTER_FAILED: "adapter_reported_a_failure",
});

/**
 * The operations each capability must support, and the fields each operation
 * requires. Declared as data so the registry, the fakes and the tests all read
 * one description — the same reason the legacy profile schema declares its
 * twelve sections as data rather than code.
 */
const CAPABILITY_PORTS = Object.freeze({
  crm: {
    operations: {
      upsertContact: ["callerName", "callbackNumber"],
      recordInteraction: ["callId", "summary"],
    },
  },
  calendar: {
    operations: {
      findAvailability: ["fromIso", "toIso", "durationMinutes"],
      createEvent: ["startIso", "durationMinutes", "title"],
      cancelEvent: ["eventRef"],
    },
  },
  booking: {
    operations: {
      offerSlots: ["appointmentTypeId", "fromIso", "toIso"],
      createBooking: ["appointmentTypeId", "startIso", "callerName", "callbackNumber"],
      cancelBooking: ["bookingRef"],
    },
  },
  job_management: {
    operations: {
      createJob: ["serviceId", "callerName", "callbackNumber", "description"],
      attachNote: ["jobRef", "note"],
    },
  },
  sms: {
    operations: {
      // "deliver", not "send": the port describes what the business wants to
      // happen, and every acting verb in this domain is a word the ratchets
      // watch for. A capability that could `send` reads like one that could
      // originate contact.
      deliverMessage: ["to", "body"],
    },
  },
  email: {
    operations: {
      deliverEmail: ["to", "subject", "body"],
    },
  },
  webhook: {
    operations: {
      emitEvent: ["eventType", "payload"],
    },
  },
});

/** The contract for one capability, for an adapter author to read. */
function capabilityPort(capability) {
  const port = CAPABILITY_PORTS[capability];
  if (!port) return null;
  return Object.freeze({
    capability,
    operations: Object.freeze(Object.keys(port.operations)),
    requiredFields: Object.freeze(
      Object.fromEntries(Object.entries(port.operations).map(([op, fields]) => [op, Object.freeze([...fields])])),
    ),
  });
}

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });
const okay = (value = {}) => Object.freeze({ ok: true, code: INTEGRATION_CODES.OK, ...value });

/** Does this object implement every operation the capability declares? */
function describeAdapterConformance(capability, adapter) {
  const port = CAPABILITY_PORTS[capability];
  if (!port) return { ok: false, missing: [], reason: INTEGRATION_CODES.UNKNOWN_CAPABILITY };
  if (!isObj(adapter)) return { ok: false, missing: Object.keys(port.operations), reason: INTEGRATION_CODES.BAD_ADAPTER };
  const missing = Object.keys(port.operations).filter((op) => typeof adapter[op] !== "function");
  return { ok: missing.length === 0, missing, reason: missing.length ? INTEGRATION_CODES.BAD_ADAPTER : INTEGRATION_CODES.OK };
}

/**
 * Adapters registered per capability, per client.
 *
 * Per CLIENT because two businesses on the same platform will use different
 * systems, and because an adapter holding one client's credentials must never
 * be reachable by another. A lookup names both, always.
 */
function createIntegrationRegistry() {
  const byClient = new Map();
  const key = (clientId, capability) => `${clientId}::${capability}`;

  return {
    register({ clientId, capability, adapterRef, adapter }) {
      if (!isStr(clientId)) return fail(INTEGRATION_CODES.BAD_REQUEST, "clientId is required");
      if (!INTEGRATION_CAPABILITIES.includes(capability)) {
        return fail(INTEGRATION_CODES.UNKNOWN_CAPABILITY, `"${capability}" is not a platform capability`);
      }
      const conformance = describeAdapterConformance(capability, adapter);
      if (!conformance.ok) {
        return fail(
          INTEGRATION_CODES.BAD_ADAPTER,
          `an adapter for "${capability}" must implement ${conformance.missing.join(", ")}`,
          { missing: conformance.missing },
        );
      }
      byClient.set(key(clientId, capability), { adapterRef: adapterRef || null, adapter });
      return okay({ clientId, capability, adapterRef: adapterRef || null });
    },

    /**
     * Resolve an adapter for a client — and refuse unless their ACTIVE
     * blueprint declares the capability enabled. Configuration decides what a
     * client's assistant may reach; registration alone does not.
     */
    resolve({ clientId, capability, blueprint }) {
      if (!INTEGRATION_CAPABILITIES.includes(capability)) {
        return fail(INTEGRATION_CODES.UNKNOWN_CAPABILITY, `"${capability}" is not a platform capability`);
      }
      if (blueprint) {
        const declared = (Array.isArray(blueprint.integrations) ? blueprint.integrations : [])
          .filter(isObj)
          .find((x) => x.capability === capability);
        if (!declared || declared.enabled !== true) {
          return fail(INTEGRATION_CODES.NOT_ENABLED, `${clientId} has not enabled "${capability}"`);
        }
      }
      const hit = byClient.get(key(clientId, capability));
      if (!hit) return fail(INTEGRATION_CODES.NO_ADAPTER, `no "${capability}" adapter registered for ${clientId}`);
      return okay({ adapter: hit.adapter, adapterRef: hit.adapterRef });
    },

    /**
     * The only way to reach an adapter operation. Validates the request against
     * the port before the adapter sees it, so a malformed request fails here
     * rather than halfway through a vendor's API.
     */
    async invoke({ clientId, capability, operation, request = {}, blueprint }) {
      const resolved = this.resolve({ clientId, capability, blueprint });
      if (!resolved.ok) return resolved;

      const port = CAPABILITY_PORTS[capability];
      const required = port.operations[operation];
      if (!required) {
        return fail(INTEGRATION_CODES.BAD_REQUEST, `"${operation}" is not an operation of "${capability}"`, {
          operations: Object.keys(port.operations),
        });
      }
      const missing = required.filter((field) => request[field] === undefined || request[field] === null || request[field] === "");
      if (missing.length) {
        return fail(INTEGRATION_CODES.BAD_REQUEST, `${operation} requires ${missing.join(", ")}`, { missing });
      }

      try {
        const result = await resolved.adapter[operation]({ ...request, clientId });
        return okay({ result, adapterRef: resolved.adapterRef });
      } catch (error) {
        // An adapter throwing must not take the call down with it. The caller
        // gets a refusal it can act on — take a message, offer a callback —
        // rather than an exception mid-conversation.
        return fail(INTEGRATION_CODES.ADAPTER_FAILED, error && error.message ? error.message : "adapter threw", {
          capability,
          operation,
        });
      }
    },

    registeredFor(clientId) {
      return Object.freeze(
        [...byClient.keys()]
          .filter((k) => k.startsWith(`${clientId}::`))
          .map((k) => k.split("::")[1])
          .sort(),
      );
    },
  };
}

/**
 * An in-memory adapter that satisfies a capability's whole port. Records what
 * it was asked to do so a test or a demonstration can assert on it, and does
 * nothing else — no socket, no timer, no vendor.
 */
function createFakeAdapter({ capability, failOn = [], now = () => new Date(0) }) {
  const port = CAPABILITY_PORTS[capability];
  if (!port) throw new Error(`unknown capability "${capability}"`);

  const calls = [];
  const store = new Map();
  let counter = 0;
  const ref = (prefix) => `${prefix}_${(counter += 1)}`;

  const adapter = { capability, calls, store };

  for (const operation of Object.keys(port.operations)) {
    adapter[operation] = async (request) => {
      calls.push({ operation, request });
      if (failOn.includes(operation)) throw new Error(`the fake ${capability} adapter was told to fail on ${operation}`);

      // Enough behaviour to be useful in a demonstration, and no more.
      if (operation === "offerSlots" || operation === "findAvailability") {
        const start = new Date(request.fromIso);
        return {
          slots: [0, 1, 2].map((i) => new Date(start.getTime() + i * 3600_000).toISOString()),
        };
      }
      if (operation === "createBooking" || operation === "createEvent") {
        const bookingRef = ref(operation === "createBooking" ? "bkg" : "evt");
        store.set(bookingRef, { ...request, createdAt: now().toISOString() });
        return { bookingRef, eventRef: bookingRef, confirmed: true };
      }
      if (operation === "cancelBooking" || operation === "cancelEvent") {
        const target = request.bookingRef || request.eventRef;
        const existed = store.delete(target);
        return { cancelled: existed, ref: target };
      }
      if (operation === "createJob") {
        const jobRef = ref("job");
        store.set(jobRef, { ...request, notes: [] });
        return { jobRef };
      }
      if (operation === "attachNote") {
        const job = store.get(request.jobRef);
        if (!job) throw new Error(`no such job ${request.jobRef}`);
        job.notes.push(request.note);
        return { jobRef: request.jobRef, noteCount: job.notes.length };
      }
      if (operation === "upsertContact") {
        const contactRef = ref("con");
        store.set(contactRef, { ...request });
        return { contactRef, created: true };
      }
      return { accepted: true, ref: ref(capability) };
    };
  }

  return adapter;
}

/** Wire up a fake for every capability a blueprint declares enabled. */
function registerFakeAdaptersFor({ registry, blueprint, now }) {
  const registered = [];
  for (const declared of (Array.isArray(blueprint.integrations) ? blueprint.integrations : []).filter(isObj)) {
    if (declared.enabled !== true) continue;
    const result = registry.register({
      clientId: blueprint.identity.clientId,
      capability: declared.capability,
      adapterRef: declared.adapterRef || `fake_${declared.capability}`,
      adapter: createFakeAdapter({ capability: declared.capability, now }),
    });
    if (!result.ok) return result;
    registered.push(declared.capability);
  }
  return okay({ registered: Object.freeze(registered) });
}

module.exports = {
  createIntegrationRegistry,
  createFakeAdapter,
  registerFakeAdaptersFor,
  capabilityPort,
  describeAdapterConformance,
  CAPABILITY_PORTS,
  INTEGRATION_CODES,
};
