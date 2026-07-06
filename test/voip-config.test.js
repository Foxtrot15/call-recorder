// Unit tests for the VoIP v2 feature flag + config assessment
// (src/config/voip.js) and its integration into startup-check.
// Pure modules — run without node_modules. Guards the Phase 0 contract:
// disabled means invisible; enabled means fail-closed (D7/D9).

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { isVoipV2Enabled, assessVoipConfig } = require("../src/config/voip");
const { assessConfig } = require("../src/config/startup-check");

const BASE = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "svc",
  SESSION_SECRET: "s".repeat(40),
  ENCRYPTION_KEY: "e".repeat(32),
};

describe("VOIP_V2_ENABLED flag parse (strict)", () => {
  it('only the exact string "true" enables', () => {
    assert.strictEqual(isVoipV2Enabled({ VOIP_V2_ENABLED: "true" }), true);
    for (const v of ["TRUE", "True", "1", "yes", "on", "false", "", undefined]) {
      assert.strictEqual(isVoipV2Enabled({ VOIP_V2_ENABLED: v }), false, `"${v}" must not enable`);
    }
    assert.strictEqual(isVoipV2Enabled({}), false);
  });
});

describe("assessVoipConfig — disabled (the default production state)", () => {
  it("contributes nothing: no fatal, no warnings, regardless of other vars", () => {
    const r = assessVoipConfig({});
    assert.deepStrictEqual(r, { enabled: false, fatal: [], warnings: [] });
    // Even with VoIP secrets present, still silent while disabled:
    const r2 = assessVoipConfig({ TWILIO_API_KEY_SID: "SK123" });
    assert.strictEqual(r2.enabled, false);
    assert.strictEqual(r2.fatal.length + r2.warnings.length, 0);
  });

  it("startup-check output is unchanged by the VoIP module while disabled", () => {
    const withoutVoipVars = assessConfig(BASE);
    assert.strictEqual(withoutVoipVars.fatal.length, 0, "no fatal for a valid non-VoIP config");
    assert.ok(!withoutVoipVars.warnings.some((w) => w.name.includes("PUSH_CREDENTIAL")),
      "no VoIP warnings leak into non-VoIP deploys");
  });
});

describe("assessVoipConfig — enabled (fail-closed, D9)", () => {
  const ENABLED = { VOIP_V2_ENABLED: "true" };

  it("missing API key pair is fatal", () => {
    const { fatal } = assessVoipConfig({ ...ENABLED, TWILIO_APNS_PUSH_CREDENTIAL_SID: "CR1" });
    const names = fatal.map((f) => f.name);
    assert.ok(names.includes("TWILIO_API_KEY_SID"));
    assert.ok(names.includes("TWILIO_API_KEY_SECRET"));
  });

  it("no push credential at all is fatal (no device could ever ring)", () => {
    const { fatal } = assessVoipConfig({
      ...ENABLED,
      TWILIO_API_KEY_SID: "SK1",
      TWILIO_API_KEY_SECRET: "sec",
    });
    assert.ok(fatal.some((f) => f.name === "TWILIO_*_PUSH_CREDENTIAL_SID"));
  });

  it("one platform's credential missing is only a warning", () => {
    const r = assessVoipConfig({
      ...ENABLED,
      TWILIO_API_KEY_SID: "SK1",
      TWILIO_API_KEY_SECRET: "sec",
      TWILIO_APNS_PUSH_CREDENTIAL_SID: "CR1",
    });
    assert.strictEqual(r.fatal.length, 0);
    assert.ok(r.warnings.some((w) => w.name === "TWILIO_FCM_PUSH_CREDENTIAL_SID"));
  });

  it("fully configured: enabled with nothing to report", () => {
    const r = assessVoipConfig({
      ...ENABLED,
      TWILIO_API_KEY_SID: "SK1",
      TWILIO_API_KEY_SECRET: "sec",
      TWILIO_APNS_PUSH_CREDENTIAL_SID: "CR1",
      TWILIO_FCM_PUSH_CREDENTIAL_SID: "CR2",
    });
    assert.deepStrictEqual(r, { enabled: true, fatal: [], warnings: [] });
  });

  it("startup-check goes fatal when enabled-but-unconfigured (boot refused)", () => {
    const { fatal } = assessConfig({ ...BASE, ...ENABLED });
    assert.ok(fatal.some((f) => f.name === "TWILIO_API_KEY_SID"),
      "enabling the flag without secrets must block startup");
  });
});
