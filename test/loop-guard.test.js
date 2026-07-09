// Regression tests for the VoIP Phase 1a PSTN loop guard
// (src/services/loop-guard.js — pure decision core; INV-1 / D10).
//
// Two proof obligations from the task:
//   1. Current (non-VoIP) clients behave UNCHANGED.
//   2. VoIP-enabled clients CANNOT trigger a PSTN loop call by any input.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  normalisePhone,
  findVoipClientByNumber,
  decidePstnDial,
  checkOutboundDialTarget,
} = require("../src/services/loop-guard");

const OWNER = "+61412345678";
const ENV_OWNER = "+61498765432";
const CUSTOMER = "+61399998888";

const NON_VOIP_CLIENT = { slug: "default", real_number: OWNER, voip_enabled: false };
const VOIP_CLIENT = { slug: "pilot-plumbing", real_number: "+61411222333", voip_enabled: true };

describe("normalisePhone", () => {
  it("normalises all common AU formats to the same E.164", () => {
    for (const v of ["+61412345678", "0412345678", "+61 412 345 678", "61412345678", "(04) 1234 5678"]) {
      assert.strictEqual(normalisePhone(v), "+61412345678", `failed for "${v}"`);
    }
  });
  it("null/empty stay null (never accidentally match)", () => {
    assert.strictEqual(normalisePhone(null), null);
    assert.strictEqual(normalisePhone(""), null);
    assert.strictEqual(normalisePhone("   "), null);
    assert.strictEqual(findVoipClientByNumber(null, [VOIP_CLIENT]), null);
  });
});

describe("PROOF 1 — current clients behave unchanged", () => {
  it("non-VoIP client, no VoIP fleet: allowed, owner number from clients row (D10/P2-5)", () => {
    const v = decidePstnDial({
      clientRow: NON_VOIP_CLIENT, voipClients: [], destination: CUSTOMER, envRealNumber: ENV_OWNER,
    });
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.ownerNumber, OWNER, "must prefer clients.real_number over env");
    assert.strictEqual(v.ownerNumberSource, "clients.real_number");
  });

  it("no client row (legacy single-tenant): allowed via env fallback", () => {
    const v = decidePstnDial({ clientRow: null, voipClients: [], destination: CUSTOMER, envRealNumber: ENV_OWNER });
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.ownerNumber, ENV_OWNER);
    assert.match(v.ownerNumberSource, /env/);
  });

  it("voip_enabled column not provisioned (undefined flag): allowed — fail-safe pre-provisioning", () => {
    const row = { slug: "default", real_number: OWNER }; // no voip_enabled key (42703 retry path)
    const v = decidePstnDial({ clientRow: row, voipClients: [], destination: CUSTOMER, envRealNumber: ENV_OWNER });
    assert.strictEqual(v.blocked, false);
  });

  it("non-VoIP client may still be dialled even when OTHER clients are VoIP", () => {
    const v = decidePstnDial({
      clientRow: NON_VOIP_CLIENT, voipClients: [VOIP_CLIENT], destination: CUSTOMER, envRealNumber: ENV_OWNER,
    });
    assert.strictEqual(v.blocked, false);
  });

  it("owner bridge: ordinary destinations pass, with or without a VoIP fleet", () => {
    assert.strictEqual(checkOutboundDialTarget(CUSTOMER, []).blocked, false);
    assert.strictEqual(checkOutboundDialTarget(CUSTOMER, [VOIP_CLIENT]).blocked, false);
  });
});

describe("PROOF 2 — VoIP-enabled clients cannot trigger PSTN loop calls", () => {
  it("voip_enabled client is refused OUTRIGHT — the owner leg itself would loop", () => {
    // Destination is completely innocent; the endpoint still dials the
    // owner's CFU'd number first, so the whole request must 409.
    const v = decidePstnDial({
      clientRow: VOIP_CLIENT, voipClients: [VOIP_CLIENT], destination: CUSTOMER, envRealNumber: ENV_OWNER,
    });
    assert.strictEqual(v.blocked, true);
    assert.match(v.reason, /VoIP-enabled|CFU/);
  });

  it("destination = a VoIP client's real number → blocked in every format", () => {
    for (const dest of ["+61411222333", "0411222333", "+61 411 222 333", "61411222333"]) {
      const v = decidePstnDial({
        clientRow: NON_VOIP_CLIENT, voipClients: [VOIP_CLIENT], destination: dest, envRealNumber: ENV_OWNER,
      });
      assert.strictEqual(v.blocked, true, `must block destination format "${dest}"`);
      assert.match(v.reason, /pilot-plumbing/);
    }
  });

  it("owner leg targeting a VoIP client's number (misconfig) → blocked", () => {
    const misconfigured = { slug: "default", real_number: VOIP_CLIENT.real_number, voip_enabled: false };
    const v = decidePstnDial({
      clientRow: misconfigured, voipClients: [VOIP_CLIENT], destination: CUSTOMER, envRealNumber: ENV_OWNER,
    });
    assert.strictEqual(v.blocked, true);
  });

  it("env-fallback owner number matching a VoIP client → blocked (legacy path guarded too)", () => {
    const v = decidePstnDial({
      clientRow: null, voipClients: [VOIP_CLIENT], destination: CUSTOMER, envRealNumber: "0411222333",
    });
    assert.strictEqual(v.blocked, true);
  });

  it("owner bridge cannot dial a VoIP client's real number, any format", () => {
    for (const dest of ["+61411222333", "0411222333"]) {
      const g = checkOutboundDialTarget(dest, [VOIP_CLIENT]);
      assert.strictEqual(g.blocked, true, `bridge must block "${dest}"`);
    }
  });

  it("VoIP client whose real_number is stored in local format is still guarded", () => {
    const localStored = { slug: "pilot", real_number: "0411 222 333", voip_enabled: true };
    const v = decidePstnDial({
      clientRow: NON_VOIP_CLIENT, voipClients: [localStored], destination: "+61411222333", envRealNumber: ENV_OWNER,
    });
    assert.strictEqual(v.blocked, true, "stored-format differences must not defeat the guard");
  });

  it("guard verdict still surfaces ownerNumber so a blocked request never falls back to dialling", () => {
    const v = decidePstnDial({
      clientRow: VOIP_CLIENT, voipClients: [VOIP_CLIENT], destination: CUSTOMER, envRealNumber: ENV_OWNER,
    });
    assert.strictEqual(v.blocked, true);
    // ownerNumber present but blocked=true — routes must check blocked FIRST;
    // this assertion documents that contract.
    assert.ok(v.ownerNumber);
  });
});
