// LOCKSMITH ACQUISITION E-12C — what it costs to make the ingress public.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────
// E-12C set out to resolve a real public HTTPS URL for the acquisition webhook
// and stopped: this repository has exactly one deployable environment, and it
// is production. Nothing was deployed.
//
// But the audit it performed produced claims that should not have to be
// re-derived by hand the next time somebody considers exposing this route. The
// dangerous ones are here as proofs rather than prose:
//
//   1. turning the ingress ON does not turn calling on
//   2. there is no signature bypass to discover later
//   3. the acquisition webhook_url cannot be inherited from another product
//
// The first is the one that matters. A public URL is only safe if the
// configuration that makes the door work is not also the configuration that
// lets something walk out of it.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const webhookRoute = require("../src/routes/acquisition-retell-webhook");
const retellConfig = require("../src/config/retell");
const acquisitionConfig = require("../src/config/acquisition");
const dialProvider = require("../src/services/acquisition-dial-provider");
const retellProvider = require("../src/services/acquisition-retell-provider");

const src = (rel) => fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

// Everything needed for the acquisition ingress to accept signed Retell
// traffic — and deliberately nothing more.
const INGRESS_ONLY = Object.freeze({
  RETELL_ENABLED: "true",
  RETELL_WEBHOOK_ENABLED: "true",
  RETELL_ACQUISITION_WEBHOOK_ENABLED: "true",
  RETELL_API_KEY: "fixture_key_not_a_real_credential",
  RETELL_API_BASE_URL: "https://api.retellai.com",
});

// ---------------------------------------------------------------------------
// 1. THE INGRESS OPENS THE DOOR AND NOTHING ELSE
// ---------------------------------------------------------------------------

describe("E-12C: enabling acquisition webhook ingress cannot enable calling", () => {
  it("1. the exact three flags open the route", () => {
    assert.strictEqual(webhookRoute.isAcquisitionWebhookEnabled(INGRESS_ONLY), true);
    // Each one is load-bearing: drop any and the path closes.
    for (const drop of ["RETELL_ENABLED", "RETELL_WEBHOOK_ENABLED", "RETELL_ACQUISITION_WEBHOOK_ENABLED"]) {
      const env = { ...INGRESS_ONLY };
      delete env[drop];
      const gate = webhookRoute.acquisitionWebhookGate(env);
      let passedThrough = false;
      gate({}, {}, (arg) => {
        if (arg === "router") return;
        passedThrough = true;
      });
      assert.strictEqual(passedThrough, false, `without ${drop} the route must 404`);
    }
  });

  it("2. the same config does NOT permit creating a Retell resource", () => {
    const gate = retellConfig.canWriteLive(INGRESS_ONLY);
    assert.strictEqual(gate.allowed, false, "ingress must not grant agent creation");
    assert.ok(gate.reasons.length > 0);
  });

  it("3. the same config does NOT permit placing a call", () => {
    const gate = retellConfig.canPlaceCall(INGRESS_ONLY);
    assert.strictEqual(gate.allowed, false, "a webhook door is not a dialling permission");
    assert.ok(gate.reasons.some((r) => /RETELL_LIVE_CALLS_ENABLED/.test(r)));
  });

  it("4. the same config leaves the acquisition engine switched off", () => {
    assert.strictEqual(acquisitionConfig.isAcquisitionEnabled(INGRESS_ONLY), false);
    const ready = acquisitionConfig.acquisitionReady("dial", INGRESS_ONLY);
    assert.strictEqual(ready.ok, false);
    assert.strictEqual(ready.code, "acquisition_disabled");
  });

  it("5. no provider becomes live, and dry-run stays on", () => {
    assert.strictEqual(dialProvider.createDisabledDialProvider().live, false);
    assert.strictEqual(dialProvider.createFakeDialProvider().live, false);
    assert.strictEqual(
      retellProvider.createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "+61355500001" } }).live,
      false
    );
    assert.strictEqual(retellConfig.getRetellConfig(INGRESS_ONLY).dryRun, true, "inverted gate — still on");
    assert.strictEqual(acquisitionConfig.EXTERNAL_SYSTEMS.telephony, false);
  });

  it("6. no number, no agent and no transport appear from ingress config", () => {
    const cfg = retellConfig.getRetellConfig(INGRESS_ONLY);
    assert.ok(!cfg.outboundOnboardingNumber, "no outbound number");
    // The acquisition provider still has no transport to submit through.
    const p = retellProvider.createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "+61355500001" } });
    assert.strictEqual(p.live, false);
  });
});

// ---------------------------------------------------------------------------
// 2. NO SIGNATURE BYPASS EXISTS TO FIND LATER
// ---------------------------------------------------------------------------

describe("E-12C: a public URL would still demand a real Retell signature", () => {
  it("7. the handler delegates to the one verifier and implements no crypto", () => {
    const handler = src("routes/acquisition-retell-webhook-handler.js");
    assert.match(handler, /verifyRetellWebhook/, "uses the shared verifier");
    assert.ok(!/createHmac|createHash|timingSafeEqual|require\(["']crypto["']\)/.test(handler), "no second implementation");
  });

  it("8. there is no staging/development bypass anywhere in the verify path", () => {
    for (const file of ["services/retell-webhook-verify.js", "routes/acquisition-retell-webhook-handler.js", "routes/acquisition-retell-webhook.js"]) {
      const body = src(file);
      // The specific shapes a "just for staging" bypass would take.
      assert.ok(!/NODE_ENV\s*===?\s*["']development["']/.test(body), `${file}: no NODE_ENV bypass`);
      assert.ok(!/allowUnsigned|skipVerification|skipSignature|bypassSignature|verifyDisabled/i.test(body), `${file}: no bypass flag`);
      assert.ok(!/req\.query\.(secret|token|key)/.test(body), `${file}: no query-string secret substitute`);
    }
  });

  it("9. an unavailable verifier fails CLOSED rather than improvising", () => {
    const verify = src("services/retell-webhook-verify.js");
    assert.match(verify, /fail closed, do not improvise/i, "the reasoning is recorded where it is implemented");
    assert.match(verify, /verifier_unavailable/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE WEBHOOK URL BOUNDARY (verified, not redesigned)
// ---------------------------------------------------------------------------

describe("E-12C: the acquisition webhook_url has one source", () => {
  const REAL = "https://acq.example.test/webhooks/retell/acquisition";

  it("10. it comes only from RETELL_ACQUISITION_WEBHOOK_URL", () => {
    assert.strictEqual(acquisitionConfig.getAcquisitionRetellConfig({ RETELL_ACQUISITION_WEBHOOK_URL: REAL }).acquisitionWebhookUrl, REAL);
  });

  it("11. no onboarding or shared webhook value can substitute", () => {
    for (const foreign of ["RETELL_WEBHOOK_BASE_URL", "RETELL_WEBHOOK_URL", "BASE_URL"]) {
      const cfg = acquisitionConfig.getAcquisitionRetellConfig({ [foreign]: "https://onboarding.example.test/webhooks/retell" });
      assert.strictEqual(cfg.acquisitionWebhookUrl, null, `${foreign} must not become the acquisition webhook`);
    }
  });

  it("12. unset means unresolved, and the agent is not create-ready", () => {
    const { describeAcquisitionRetellResources } = require("../src/services/acquisition-agent-spec");
    const r = describeAcquisitionRetellResources({
      config: acquisitionConfig.getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: "voice_fixture" }),
      llmId: "llm_fixture_0001",
    });
    assert.strictEqual(r.agent.webhook_url, null);
    assert.strictEqual(r.readiness.createAgentReady, false);
    assert.ok(r.readiness.blockers.some((b) => /webhook_url is unresolved/i.test(b)));
  });

  it("13. the route path the URL must end in has not moved", () => {
    assert.strictEqual(webhookRoute.ACQUISITION_WEBHOOK_PATH, "/webhooks/retell/acquisition");
  });
});

// ---------------------------------------------------------------------------
// 4. NOTHING WAS DEPLOYED
// ---------------------------------------------------------------------------

describe("E-12C: exposure did not happen", () => {
  it("14. no deployment manifest was added for a second environment", () => {
    const root = path.join(__dirname, "..");
    for (const f of ["render.yaml", "fly.toml", "vercel.json", "Procfile", "Dockerfile", "railway.json", "railway.toml"]) {
      assert.ok(!fs.existsSync(path.join(root, f)), `${f} must not appear without a founder infrastructure decision`);
    }
  });

  it("15. the acquisition ingress remains off by default", () => {
    assert.strictEqual(webhookRoute.isAcquisitionWebhookEnabled({}), false);
  });
});
