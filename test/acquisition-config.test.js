// LOCKSMITH ACQUISITION A1 — configuration and the offline boundary.
//
// These tests pin the two properties the whole engine's safety rests on: that
// every capability is off unless deliberately switched on, and that no env
// value can grant this build access to an external system.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const config = require("../src/config/acquisition");

describe("the offline boundary", () => {
  it("is closed, and is a constant rather than a setting", () => {
    assert.strictEqual(config.EXTERNAL_ACCESS_SUPPORTED, false);
  });

  it("lists every external system the engine will eventually need, all disabled", () => {
    const systems = Object.keys(config.EXTERNAL_SYSTEMS);
    for (const expected of ["web_fetch", "search_api", "directory_api", "business_register", "dncr_api", "telephony", "messaging"]) {
      assert.ok(systems.includes(expected), `${expected} should be named explicitly`);
    }
    for (const [name, allowed] of Object.entries(config.EXTERNAL_SYSTEMS)) {
      assert.strictEqual(allowed, false, `${name} must be disabled in this build`);
    }
  });

  it("refuses every external system, whatever the environment says", () => {
    // The point of the test: there is no env var to try, so we try the ones a
    // developer would plausibly invent. None of them can open the boundary.
    const hopefulEnv = {
      ACQUISITION_ENABLED: "true",
      ACQUISITION_LIVE: "true",
      ACQUISITION_EXTERNAL_ACCESS: "true",
      ALLOW_NETWORK: "true",
      NODE_ENV: "production",
    };
    const resolved = config.getAcquisitionConfig(hopefulEnv);
    assert.strictEqual(resolved.externalAccess.supported, false);

    for (const system of Object.keys(config.EXTERNAL_SYSTEMS)) {
      assert.strictEqual(config.isExternalSystemAvailable(system), false);
      assert.throws(() => config.assertExternalAccessAllowed(system, "test"), /not available in this build/);
    }
  });

  it("refuses an unknown system by default rather than passing it through", () => {
    assert.throws(() => config.assertExternalAccessAllowed("some_new_api"), /Unknown external system/);
  });

  it("names what was attempted, so a failure is debuggable", () => {
    assert.throws(() => config.assertExternalAccessAllowed("dncr_api", "wash 40 numbers"), /wash 40 numbers/);
  });
});

describe("feature flags", () => {
  it("default to off when the environment is empty", () => {
    assert.strictEqual(config.isAcquisitionEnabled({}), false);
    assert.strictEqual(config.isAcquisitionReviewEnabled({}), false);
  });

  it("only the exact string \"true\" enables — the D7 house rule", () => {
    for (const sloppy of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""]) {
      assert.strictEqual(config.isAcquisitionEnabled({ ACQUISITION_ENABLED: sloppy }), false, `"${sloppy}" must not enable`);
    }
    assert.strictEqual(config.isAcquisitionEnabled({ ACQUISITION_ENABLED: "true" }), true);
  });

  it("acquisitionReady refuses with a reason when the master switch is off", () => {
    const gate = config.acquisitionReady("discovery", {});
    assert.strictEqual(gate.ok, false);
    assert.strictEqual(gate.code, "acquisition_disabled");
    assert.match(gate.message, /switched off/);
  });

  it("review needs BOTH the master switch and its own flag", () => {
    assert.strictEqual(config.acquisitionReady("review", { ACQUISITION_ENABLED: "true" }).code, "review_disabled");
    assert.strictEqual(config.acquisitionReady("review", { ACQUISITION_REVIEW_ENABLED: "true" }).code, "acquisition_disabled");
    assert.strictEqual(config.acquisitionReady("review", { ACQUISITION_ENABLED: "true", ACQUISITION_REVIEW_ENABLED: "true" }).ok, true);
  });
});

describe("DNCR mode", () => {
  it("defaults to disabled, which means nothing can be called", () => {
    assert.deepStrictEqual(config.resolveDncrMode({}), { mode: "disabled", faults: [] });
    assert.strictEqual(config.getAcquisitionConfig({}).dncr.mode, "disabled");
  });

  it("has no live mode, and asking for one fails closed with an explanation", () => {
    assert.ok(!config.DNCR_MODES.includes("live"));
    const resolved = config.resolveDncrMode({ ACQUISITION_DNCR_MODE: "live" });
    assert.strictEqual(resolved.mode, "disabled");
    assert.strictEqual(resolved.faults[0].code, "dncr_live_mode_unavailable");
    assert.match(resolved.faults[0].message, /no live DNCR client/);
  });

  it("an unknown mode degrades to disabled and reports a fault, never throws", () => {
    const resolved = config.resolveDncrMode({ ACQUISITION_DNCR_MODE: "prod" });
    assert.strictEqual(resolved.mode, "disabled");
    assert.strictEqual(resolved.faults[0].code, "dncr_mode_unknown");
  });

  it("accepts the three modes this build understands", () => {
    for (const mode of ["disabled", "fixture", "import"]) {
      assert.strictEqual(config.resolveDncrMode({ ACQUISITION_DNCR_MODE: mode }).mode, mode);
    }
  });

  it("only an imported wash is treated as authoritative", () => {
    assert.strictEqual(config.getAcquisitionConfig({ ACQUISITION_DNCR_MODE: "import" }).dncr.resultsAreAuthoritative, true);
    assert.strictEqual(config.getAcquisitionConfig({ ACQUISITION_DNCR_MODE: "fixture" }).dncr.resultsAreAuthoritative, false);
    assert.strictEqual(config.getAcquisitionConfig({}).dncr.resultsAreAuthoritative, false);
  });

  it("encodes the 30-day wash rule once", () => {
    assert.strictEqual(config.DNCR_WASH_VALIDITY_DAYS, 30);
  });
});

describe("calling windows", () => {
  it("has no Sunday window at all — an absent day is the rule, not an omission", () => {
    assert.strictEqual(config.CALLING_WINDOWS.sun, undefined);
    assert.ok(!Object.keys(config.CALLING_WINDOWS).includes("sun"));
  });

  it("matches the Telemarketing Industry Standard hours", () => {
    for (const day of ["mon", "tue", "wed", "thu", "fri"]) {
      assert.deepStrictEqual({ ...config.CALLING_WINDOWS[day] }, { from: "09:00", to: "20:00" });
    }
    assert.deepStrictEqual({ ...config.CALLING_WINDOWS.sat }, { from: "09:00", to: "17:00" });
  });
});

describe("the assembled config", () => {
  it("is frozen, so nothing can widen it at run time", () => {
    const resolved = config.getAcquisitionConfig({});
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(resolved.dncr));
    assert.ok(Object.isFrozen(resolved.caps));
    assert.throws(() => {
      "use strict";
      resolved.enabled = true;
    });
  });

  it("reports config faults so a typo is visible rather than silent", () => {
    assert.deepStrictEqual(config.getAcquisitionConfig({}).faults, []);
    assert.strictEqual(config.getAcquisitionConfig({ ACQUISITION_DNCR_MODE: "live" }).faults.length, 1);
  });

  it("caps are conservative ceilings", () => {
    const caps = config.DEFAULT_CAPS;
    assert.ok(caps.maxAttemptsPerProspect <= 3);
    assert.ok(caps.minDaysBetweenAttempts >= 1);
    assert.ok(caps.maxBatchSize <= 50);
  });
});
