// AIDA PLATFORM P11 — capability ports and fake adapters.
//
// The property under test is that a client's configuration names a CAPABILITY
// and never a vendor, so moving a business from one booking system to another
// is a change of adapter rather than a reopening of their configuration and a
// fresh round of approval.
//
// And the harder one: there is no port that places a call. A client cannot
// configure their way to originating contact, because the operation does not
// exist to be configured.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createIntegrationRegistry,
  createFakeAdapter,
  registerFakeAdaptersFor,
  capabilityPort,
  describeAdapterConformance,
  CAPABILITY_PORTS,
  INTEGRATION_CODES,
} = require("../src/platform/integrations");

const { INTEGRATION_CAPABILITIES } = require("../src/platform/client-blueprint");
const { locksmithA, locksmithB, plumberC } = require("../src/platform/fixtures/clients");

const clock = () => new Date(Date.UTC(2026, 7, 16, 9, 0, 0));

describe("capability ports — a capability is a contract, not a vendor", () => {
  it("declares a port for every capability the blueprint offers", () => {
    for (const capability of INTEGRATION_CAPABILITIES) {
      const port = capabilityPort(capability);
      assert.ok(port, `no port declared for "${capability}"`);
      assert.ok(port.operations.length > 0, `"${capability}" has no operations`);
    }
  });

  it("declares no capability the blueprint does not offer", () => {
    for (const capability of Object.keys(CAPABILITY_PORTS)) {
      assert.ok(INTEGRATION_CAPABILITIES.includes(capability), `"${capability}" is a port with no blueprint capability`);
    }
  });

  it("returns null for something that is not a capability", () => {
    for (const notOne of ["servicem8", "google_calendar", "telephony", "", null]) {
      assert.equal(capabilityPort(notOne), null);
    }
  });

  it("names no vendor anywhere in the port declarations", () => {
    const json = JSON.stringify(CAPABILITY_PORTS).toLowerCase();
    for (const vendor of ["google", "outlook", "hubspot", "salesforce", "servicem8", "simpro", "twilio", "retell", "stripe", "xero"]) {
      assert.ok(!json.includes(vendor), `the ports mention ${vendor}`);
    }
  });
});

describe("capability ports — nothing here can originate a call", () => {
  it("has no telephony capability at all", () => {
    assert.ok(!INTEGRATION_CAPABILITIES.includes("telephony"));
    assert.ok(!INTEGRATION_CAPABILITIES.includes("voice"));
    assert.ok(!INTEGRATION_CAPABILITIES.includes("dialer"));
    assert.equal(capabilityPort("telephony"), null);
  });

  it("declares no operation that places, transfers or originates a call", () => {
    const FORBIDDEN = /^(dial|placeCall|makeCall|originat|transfer|call|ring|autodial)/i;
    for (const [capability, port] of Object.entries(CAPABILITY_PORTS)) {
      for (const operation of Object.keys(port.operations)) {
        assert.ok(!FORBIDDEN.test(operation), `"${capability}" declares "${operation}"`);
      }
    }
  });

  it("refuses to invoke an operation the port does not declare, however plausible", async () => {
    const registry = createIntegrationRegistry();
    registry.register({ clientId: "riverside_plumbing", capability: "sms", adapter: createFakeAdapter({ capability: "sms" }) });
    for (const invented of ["dialCaller", "sendMessage", "callBack", "deliver"]) {
      const result = await registry.invoke({
        clientId: "riverside_plumbing", capability: "sms", operation: invented,
        request: { to: "+61355500311", body: "hello" },
      });
      assert.equal(result.ok, false, `"${invented}" must not be invokable`);
      assert.equal(result.code, INTEGRATION_CODES.BAD_REQUEST);
    }
  });

  it("cannot be reached with a capability that is not one", async () => {
    const registry = createIntegrationRegistry();
    const result = await registry.invoke({ clientId: "riverside_plumbing", capability: "telephony", operation: "dial", request: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.UNKNOWN_CAPABILITY);
  });
});

describe("adapter conformance — a partial adapter is refused at registration", () => {
  it("accepts an adapter that implements the whole port", () => {
    for (const capability of INTEGRATION_CAPABILITIES) {
      const conformance = describeAdapterConformance(capability, createFakeAdapter({ capability }));
      assert.equal(conformance.ok, true, `${capability}: missing ${conformance.missing.join(", ")}`);
    }
  });

  it("refuses one that implements only some of it, naming what is missing", () => {
    const registry = createIntegrationRegistry();
    const half = { offerSlots: async () => ({}) }; // booking needs three
    const result = registry.register({ clientId: "riverside_plumbing", capability: "booking", adapter: half });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.BAD_ADAPTER);
    assert.deepEqual([...result.missing].sort(), ["cancelBooking", "createBooking"]);
  });

  it("refuses something that is not an adapter at all", () => {
    const registry = createIntegrationRegistry();
    for (const junk of [null, undefined, 42, "adapter", []]) {
      const result = registry.register({ clientId: "x_client", capability: "sms", adapter: junk });
      assert.equal(result.ok, false);
      assert.equal(result.code, INTEGRATION_CODES.BAD_ADAPTER);
    }
  });

  it("refuses a capability the platform does not define", () => {
    const registry = createIntegrationRegistry();
    const result = registry.register({
      clientId: "x_client", capability: "carrier_pigeon", adapter: { fly: async () => ({}) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.UNKNOWN_CAPABILITY);
  });

  it("requires a clientId, because an adapter belongs to somebody", () => {
    const registry = createIntegrationRegistry();
    const result = registry.register({ capability: "sms", adapter: createFakeAdapter({ capability: "sms" }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.BAD_REQUEST);
  });
});

describe("resolution — configuration decides what an assistant may reach", () => {
  it("refuses a capability the client's blueprint has not enabled", async () => {
    const registry = createIntegrationRegistry();
    const blueprint = locksmithA(); // crm and calendar are declared but disabled
    registry.register({ clientId: "northside_locks", capability: "crm", adapter: createFakeAdapter({ capability: "crm" }) });

    const result = registry.resolve({ clientId: "northside_locks", capability: "crm", blueprint });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.NOT_ENABLED);
  });

  it("refuses a capability the blueprint does not mention at all", () => {
    const registry = createIntegrationRegistry();
    registry.register({ clientId: "northside_locks", capability: "webhook", adapter: createFakeAdapter({ capability: "webhook" }) });
    const result = registry.resolve({ clientId: "northside_locks", capability: "webhook", blueprint: locksmithA() });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.NOT_ENABLED);
  });

  it("allows one the blueprint has enabled", () => {
    const registry = createIntegrationRegistry();
    registry.register({ clientId: "northside_locks", capability: "sms", adapterRef: "sms_default", adapter: createFakeAdapter({ capability: "sms" }) });
    const result = registry.resolve({ clientId: "northside_locks", capability: "sms", blueprint: locksmithA() });
    assert.equal(result.ok, true);
    assert.equal(result.adapterRef, "sms_default");
  });

  it("reports a missing adapter as missing, not as forbidden", () => {
    const registry = createIntegrationRegistry();
    const result = registry.resolve({ clientId: "northside_locks", capability: "sms", blueprint: locksmithA() });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.NO_ADAPTER);
  });
});

describe("resolution — one client's adapter is not another's", () => {
  it("keeps adapters apart even for the same capability", async () => {
    const registry = createIntegrationRegistry();
    const a = createFakeAdapter({ capability: "sms" });
    const c = createFakeAdapter({ capability: "sms" });
    registry.register({ clientId: "northside_locks", capability: "sms", adapterRef: "sms_a", adapter: a });
    registry.register({ clientId: "riverside_plumbing", capability: "sms", adapterRef: "sms_c", adapter: c });

    await registry.invoke({
      clientId: "northside_locks", capability: "sms", operation: "deliverMessage",
      request: { to: "+61355500111", body: "job for you" }, blueprint: locksmithA(),
    });

    assert.equal(a.calls.length, 1);
    assert.equal(c.calls.length, 0, "the plumber's adapter must not have been touched");
    assert.equal(a.calls[0].request.clientId, "northside_locks");
  });

  it("does not resolve one client's adapter for another", () => {
    const registry = createIntegrationRegistry();
    registry.register({ clientId: "northside_locks", capability: "sms", adapter: createFakeAdapter({ capability: "sms" }) });
    const result = registry.resolve({ clientId: "riverside_plumbing", capability: "sms", blueprint: plumberC() });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.NO_ADAPTER);
  });

  it("lists only what a given client has registered", () => {
    const registry = createIntegrationRegistry();
    registry.register({ clientId: "northside_locks", capability: "sms", adapter: createFakeAdapter({ capability: "sms" }) });
    registry.register({ clientId: "northside_locks", capability: "email", adapter: createFakeAdapter({ capability: "email" }) });
    registry.register({ clientId: "riverside_plumbing", capability: "booking", adapter: createFakeAdapter({ capability: "booking" }) });

    assert.deepEqual(registry.registeredFor("northside_locks"), ["email", "sms"]);
    assert.deepEqual(registry.registeredFor("riverside_plumbing"), ["booking"]);
    assert.deepEqual(registry.registeredFor("southbank_security"), []);
  });
});

describe("invocation — a malformed request fails here, not inside a vendor", () => {
  it("names every missing required field before the adapter sees anything", async () => {
    const registry = createIntegrationRegistry();
    const adapter = createFakeAdapter({ capability: "booking" });
    registry.register({ clientId: "riverside_plumbing", capability: "booking", adapter });

    const result = await registry.invoke({
      clientId: "riverside_plumbing", capability: "booking", operation: "createBooking",
      request: { appointmentTypeId: "standard_visit" }, blueprint: plumberC(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.BAD_REQUEST);
    assert.deepEqual([...result.missing].sort(), ["callbackNumber", "callerName", "startIso"]);
    assert.equal(adapter.calls.length, 0, "the adapter must not have been called at all");
  });

  it("treats an empty string as missing", async () => {
    const registry = createIntegrationRegistry();
    registry.register({ clientId: "riverside_plumbing", capability: "sms", adapter: createFakeAdapter({ capability: "sms" }) });
    const result = await registry.invoke({
      clientId: "riverside_plumbing", capability: "sms", operation: "deliverMessage",
      request: { to: "", body: "hello" }, blueprint: plumberC(),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["to"]);
  });

  it("passes a well-formed request through and returns the adapter's result", async () => {
    const registry = createIntegrationRegistry();
    const adapter = createFakeAdapter({ capability: "booking", now: clock });
    registry.register({ clientId: "riverside_plumbing", capability: "booking", adapter });

    const result = await registry.invoke({
      clientId: "riverside_plumbing", capability: "booking", operation: "createBooking",
      request: {
        appointmentTypeId: "standard_visit",
        startIso: "2026-08-17T09:00:00.000Z",
        callerName: "Jo Baker",
        callbackNumber: "+61355500399",
      },
      blueprint: plumberC(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.confirmed, true);
    assert.match(result.result.bookingRef, /^bkg_\d+$/);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].request.callerName, "Jo Baker");
  });

  it("turns an adapter throwing into a refusal rather than an exception mid-call", async () => {
    const registry = createIntegrationRegistry();
    registry.register({
      clientId: "riverside_plumbing",
      capability: "booking",
      adapter: createFakeAdapter({ capability: "booking", failOn: ["createBooking"] }),
    });

    const result = await registry.invoke({
      clientId: "riverside_plumbing", capability: "booking", operation: "createBooking",
      request: {
        appointmentTypeId: "standard_visit",
        startIso: "2026-08-17T09:00:00.000Z",
        callerName: "Jo Baker",
        callbackNumber: "+61355500399",
      },
      blueprint: plumberC(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, INTEGRATION_CODES.ADAPTER_FAILED);
    assert.equal(result.capability, "booking");
    assert.equal(result.operation, "createBooking");
    assert.ok(/told to fail/.test(result.message));
  });

  it("keeps working after one operation fails", async () => {
    const registry = createIntegrationRegistry();
    registry.register({
      clientId: "riverside_plumbing", capability: "booking",
      adapter: createFakeAdapter({ capability: "booking", failOn: ["createBooking"] }),
    });
    const ok = await registry.invoke({
      clientId: "riverside_plumbing", capability: "booking", operation: "offerSlots",
      request: { appointmentTypeId: "standard_visit", fromIso: "2026-08-17T09:00:00.000Z", toIso: "2026-08-17T17:00:00.000Z" },
      blueprint: plumberC(),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.result.slots.length, 3);
  });
});

describe("swapping a vendor is a change of adapter, not of configuration", () => {
  it("serves the same capability from a completely different adapter", async () => {
    const registry = createIntegrationRegistry();
    const blueprint = plumberC();
    const configurationBefore = JSON.stringify(blueprint);

    const first = createFakeAdapter({ capability: "booking" });
    registry.register({ clientId: "riverside_plumbing", capability: "booking", adapterRef: "booking_vendor_one", adapter: first });
    const a = await registry.invoke({
      clientId: "riverside_plumbing", capability: "booking", operation: "offerSlots",
      request: { appointmentTypeId: "standard_visit", fromIso: "2026-08-17T09:00:00.000Z", toIso: "2026-08-17T12:00:00.000Z" },
      blueprint,
    });
    assert.equal(a.adapterRef, "booking_vendor_one");

    // A completely different implementation, same port.
    const second = {
      offerSlots: async () => ({ slots: ["2026-08-18T08:00:00.000Z"] }),
      createBooking: async () => ({ bookingRef: "vendor-two-42", confirmed: true }),
      cancelBooking: async () => ({ cancelled: true }),
    };
    registry.register({ clientId: "riverside_plumbing", capability: "booking", adapterRef: "booking_vendor_two", adapter: second });

    const b = await registry.invoke({
      clientId: "riverside_plumbing", capability: "booking", operation: "offerSlots",
      request: { appointmentTypeId: "standard_visit", fromIso: "2026-08-17T09:00:00.000Z", toIso: "2026-08-17T12:00:00.000Z" },
      blueprint,
    });
    assert.equal(b.adapterRef, "booking_vendor_two");
    assert.deepEqual(b.result.slots, ["2026-08-18T08:00:00.000Z"]);

    // The client's configuration never moved, so no re-approval was needed.
    assert.equal(JSON.stringify(blueprint), configurationBefore);
  });

  it("keeps the blueprint free of anything vendor-shaped", () => {
    for (const make of [locksmithA, locksmithB, plumberC]) {
      for (const declared of make().integrations) {
        assert.ok(INTEGRATION_CAPABILITIES.includes(declared.capability));
        if (declared.adapterRef) {
          assert.ok(
            /^[a-z][a-z0-9_]*$/.test(declared.adapterRef),
            `"${declared.adapterRef}" should be an opaque reference, not a vendor URL or key`,
          );
        }
      }
    }
  });
});

describe("wiring a whole client at once", () => {
  it("registers a fake for every capability a blueprint enables, and none it does not", () => {
    const registry = createIntegrationRegistry();
    const blueprint = plumberC();
    const result = registerFakeAdaptersFor({ registry, blueprint, now: clock });
    assert.equal(result.ok, true);

    const expected = blueprint.integrations.filter((i) => i.enabled).map((i) => i.capability).sort();
    assert.deepEqual([...result.registered].sort(), expected);
    assert.deepEqual(registry.registeredFor("riverside_plumbing"), expected);

    for (const disabled of blueprint.integrations.filter((i) => !i.enabled)) {
      assert.ok(!registry.registeredFor("riverside_plumbing").includes(disabled.capability));
    }
  });

  it("wires three clients differently, from their configuration alone", () => {
    const registry = createIntegrationRegistry();
    for (const make of [locksmithA, locksmithB, plumberC]) {
      registerFakeAdaptersFor({ registry, blueprint: make(), now: clock });
    }
    assert.deepEqual(registry.registeredFor("northside_locks"), ["email", "sms"]);
    assert.deepEqual(registry.registeredFor("southbank_security"), ["calendar", "crm", "email"]);
    assert.deepEqual(registry.registeredFor("riverside_plumbing"), ["booking", "job_management", "sms"]);
  });
});

describe("the fakes talk to nothing", () => {
  it("records what it was asked and returns without touching the world", async () => {
    const adapter = createFakeAdapter({ capability: "email", now: clock });
    const result = await adapter.deliverEmail({ to: "office@example.invalid", subject: "s", body: "b" });
    assert.equal(result.accepted, true);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].operation, "deliverEmail");
  });

  it("refuses to be built for a capability that does not exist", () => {
    assert.throws(() => createFakeAdapter({ capability: "telephony" }), /unknown capability/);
  });

  it("keeps a job's notes without a database", async () => {
    const adapter = createFakeAdapter({ capability: "job_management" });
    const { jobRef } = await adapter.createJob({
      serviceId: "burst_pipe", callerName: "Jo", callbackNumber: "+61355500399", description: "water everywhere",
    });
    await adapter.attachNote({ jobRef, note: "meter turned off" });
    const second = await adapter.attachNote({ jobRef, note: "on the way" });
    assert.equal(second.noteCount, 2);
    assert.deepEqual(adapter.store.get(jobRef).notes, ["meter turned off", "on the way"]);
  });

  it("cancels only what exists", async () => {
    const adapter = createFakeAdapter({ capability: "booking", now: clock });
    const { bookingRef } = await adapter.createBooking({
      appointmentTypeId: "standard_visit", startIso: "2026-08-17T09:00:00.000Z", callerName: "Jo", callbackNumber: "+61355500399",
    });
    assert.equal((await adapter.cancelBooking({ bookingRef })).cancelled, true);
    assert.equal((await adapter.cancelBooking({ bookingRef })).cancelled, false);
  });
});
