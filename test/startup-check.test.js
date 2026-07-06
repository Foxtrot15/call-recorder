// Unit tests for startup config validation (src/config/startup-check.js).
// assessConfig is pure (no deps), so this runs without node_modules.
// Guards the fail-closed P0 behaviour against regression.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { assessConfig } = require("../src/config/startup-check");

const VALID = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "svc",
  SESSION_SECRET: "s".repeat(40),
  ENCRYPTION_KEY: "e".repeat(32),
};

describe("startup config — critical", () => {
  it("empty env: all four critical vars are fatal", () => {
    const { fatal } = assessConfig({});
    const names = fatal.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ["ENCRYPTION_KEY", "SESSION_SECRET", "SUPABASE_SERVICE_KEY", "SUPABASE_URL"]);
  });

  it("valid critical env: no fatal", () => {
    assert.strictEqual(assessConfig(VALID).fatal.length, 0);
  });

  it("ENCRYPTION_KEY shorter than 32 chars is fatal (fail-closed)", () => {
    const { fatal } = assessConfig({ ...VALID, ENCRYPTION_KEY: "e".repeat(31) });
    assert.ok(fatal.find((f) => f.name === "ENCRYPTION_KEY"), "31-char key should be fatal");
  });

  it("ENCRYPTION_KEY of exactly 32 chars is accepted", () => {
    const { fatal } = assessConfig({ ...VALID, ENCRYPTION_KEY: "e".repeat(32) });
    assert.strictEqual(fatal.length, 0);
  });
});

describe("startup config — recommended", () => {
  it("missing feature vars warn, not fatal", () => {
    const { fatal, warnings } = assessConfig(VALID); // no OPERATOR_CLIENT_ID etc.
    assert.strictEqual(fatal.length, 0);
    assert.ok(warnings.find((w) => w.name === "OPERATOR_CLIENT_ID"));
    assert.ok(warnings.find((w) => w.name === "DASHBOARD_PASSWORD"));
  });
});
