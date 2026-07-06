// Regression tests for VoIP Phase 1b — /voice/token + device registration
// backend. Pure modules only (voip-identity, devices validation, rate-limit,
// config gate) — runs without node_modules; the twilio-SDK minting line and
// DB adapter are thin wrappers over what's proven here.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { clientIdentity, buildTokenConfig, TOKEN_TTL_SECONDS } = require("../src/services/voip-identity");
const { validateDeviceRegistration, canRegisterNewDevice, toPublicDevice, MAX_ACTIVE_DEVICES } = require("../src/services/devices");
const { createRateLimiter } = require("../src/services/rate-limit");
const { voipRouterGate } = require("../src/config/voip");

const FULL_ENV = {
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_API_KEY_SID: "SK456",
  TWILIO_API_KEY_SECRET: "secret",
  TWILIO_APNS_PUSH_CREDENTIAL_SID: "CR-APNS",
  TWILIO_FCM_PUSH_CREDENTIAL_SID: "CR-FCM",
};

describe("disabled state (VOIP_V2_ENABLED=false — every production deploy)", () => {
  it("gate exits the whole router via next('router') — 404 pass-through, auth never runs", () => {
    for (const env of [{}, { VOIP_V2_ENABLED: "false" }, { VOIP_V2_ENABLED: "1" }, { VOIP_V2_ENABLED: "TRUE" }]) {
      const gate = voipRouterGate(env);
      let calledWith = "never";
      gate({}, {}, (arg) => { calledWith = arg; });
      assert.strictEqual(calledWith, "router", `env ${JSON.stringify(env)} must exit the router`);
    }
  });

  it("gate lets requests through only for the exact string 'true'", () => {
    const gate = voipRouterGate({ VOIP_V2_ENABLED: "true" });
    let calledWith = "never";
    gate({}, {}, (arg) => { calledWith = arg; });
    assert.strictEqual(calledWith, undefined, "enabled: plain next() into the auth chain");
  });
});

describe("client identity (INV-6)", () => {
  it("derives client_<slug> with hyphens → underscores", () => {
    assert.strictEqual(clientIdentity("pilot-plumbing"), "client_pilot_plumbing");
    assert.strictEqual(clientIdentity("default"), "client_default");
    assert.strictEqual(clientIdentity("a1-b2-c3"), "client_a1_b2_c3");
  });

  it("refuses invalid slugs (identity is never derived from junk)", () => {
    for (const bad of [null, "", "Has Spaces", "UPPER", "sl.ug", "-leading", "sl_ug"]) {
      assert.throws(() => clientIdentity(bad), /invalid slug/i, `should refuse ${JSON.stringify(bad)}`);
    }
  });
});

describe("token config (shape of what gets minted)", () => {
  it("valid ios request: identity, 1h TTL, APNS credential", () => {
    const r = buildTokenConfig({ slug: "pilot-plumbing", platform: "ios", env: FULL_ENV });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.config, {
      identity: "client_pilot_plumbing",
      ttlSeconds: 3600,
      accountSid: "AC123",
      apiKeySid: "SK456",
      apiKeySecret: "secret",
      pushCredentialSid: "CR-APNS",
    });
    assert.strictEqual(TOKEN_TTL_SECONDS, 3600, "spec §5.1: TTL is deliberately 1h");
  });

  it("android selects the FCM credential", () => {
    const r = buildTokenConfig({ slug: "default", platform: "android", env: FULL_ENV });
    assert.strictEqual(r.config.pushCredentialSid, "CR-FCM");
  });

  it("unknown/missing platform → 400", () => {
    for (const p of ["web", "", undefined, "IOS"]) {
      const r = buildTokenConfig({ slug: "default", platform: p, env: FULL_ENV });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.status, 400, `platform ${JSON.stringify(p)}`);
    }
  });

  it("missing API key pair → 500 (defence in depth behind D9)", () => {
    const r = buildTokenConfig({ slug: "default", platform: "ios", env: { TWILIO_ACCOUNT_SID: "AC" } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 500);
  });

  it("platform whose push credential isn't configured → 503, the other still works", () => {
    const env = { ...FULL_ENV, TWILIO_FCM_PUSH_CREDENTIAL_SID: "" };
    assert.strictEqual(buildTokenConfig({ slug: "default", platform: "android", env }).status, 503);
    assert.strictEqual(buildTokenConfig({ slug: "default", platform: "ios", env }).ok, true);
  });
});

describe("device registration validation", () => {
  const HASH = "a".repeat(64);

  it("accepts a well-formed ios and android registration", () => {
    for (const platform of ["ios", "android"]) {
      const r = validateDeviceRegistration({ platform, pushTokenHash: HASH, label: "Pete's iPhone" });
      assert.deepStrictEqual(r, { ok: true, errors: [] }, platform);
    }
  });

  it("rejects bad platforms", () => {
    for (const platform of ["web", "", undefined, "iOS"]) {
      assert.strictEqual(validateDeviceRegistration({ platform, pushTokenHash: HASH }).ok, false);
    }
  });

  it("rejects anything that is not a sha256 hex digest — raw push tokens must never arrive", () => {
    for (const bad of [undefined, "", "raw-apns-token", "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      const r = validateDeviceRegistration({ platform: "ios", pushTokenHash: bad });
      assert.strictEqual(r.ok, false, `should reject ${JSON.stringify(bad && bad.slice(0, 10))}`);
      assert.match(r.errors.join(" "), /sha256|never send the raw/i);
    }
  });

  it("caps free-text field lengths", () => {
    assert.strictEqual(validateDeviceRegistration({ platform: "ios", pushTokenHash: HASH, label: "x".repeat(81) }).ok, false);
    assert.strictEqual(validateDeviceRegistration({ platform: "ios", pushTokenHash: HASH, appVersion: "x".repeat(41) }).ok, false);
  });

  it("device cap: 5 active max for NEW devices; re-registration is exempt by design", () => {
    assert.strictEqual(MAX_ACTIVE_DEVICES, 5);
    assert.strictEqual(canRegisterNewDevice(4), true);
    assert.strictEqual(canRegisterNewDevice(5), false);
    assert.strictEqual(canRegisterNewDevice(0), true);
  });

  it("public device shape never includes the token hash", () => {
    const pub = toPublicDevice({
      id: "d1", platform: "ios", label: "Phone", push_token_hash: "SECRET",
      app_version: "1.0", os_version: "18", last_registered_at: "t", created_at: "t0",
    });
    assert.strictEqual(JSON.stringify(pub).includes("SECRET"), false);
    assert.strictEqual(pub.id, "d1");
  });
});

describe("rate limiter (D11)", () => {
  it("allows up to the limit in a window, then blocks with retry info", () => {
    let t = 1000;
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    assert.strictEqual(rl.check("k").allowed, true);
    assert.strictEqual(rl.check("k").allowed, true);
    assert.strictEqual(rl.check("k").allowed, true);
    const blocked = rl.check("k");
    assert.strictEqual(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
  });

  it("window expiry resets the count; keys are independent", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    assert.strictEqual(rl.check("a").allowed, true);
    assert.strictEqual(rl.check("b").allowed, true, "different key unaffected");
    assert.strictEqual(rl.check("a").allowed, false);
    t = 1001;
    assert.strictEqual(rl.check("a").allowed, true, "new window");
  });
});
