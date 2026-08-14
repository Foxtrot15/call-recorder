// LOCKSMITH ACQUISITION E-12J — negative probes for the public webhook.
//
// ── THE ONE THING THIS HARNESS MUST NOT DO ──────────────────────────
// Fabricate a valid Retell signature. It would be easy — the API key is in the
// staging environment and the HMAC is not a secret algorithm — and it would be
// worthless: writing a second implementation of the thing the verifier exists
// to check, then congratulating ourselves when our forgery matched our forger.
//
// So every probe here is a REJECTION path, and the positive case stays reserved
// for a real Retell delivery after the agent exists. These tests assert that
// absence as strictly as they assert anything else.
//
// ── AND THE ONE THING IT MUST NOT REACH ─────────────────────────────
// Production. A probe suite aimed at the runtime that answers real customer
// calls would be a self-inflicted incident, so a host matching a configured
// production base URL is refused outright rather than warned about.
//
// No network in these tests. The runner is exercised as source and data.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  validateSmokeTarget,
  judgeProbeResult,
  describeRouteState,
  oversizeProbe,
  NEGATIVE_PROBES,
  SMOKE_CODES,
  ACQUISITION_WEBHOOK_PATH,
} = require("../src/services/acquisition-webhook-smoke");

const SCRIPT = path.join(__dirname, "..", "scripts", "dev", "acquisition-webhook-smoke.js");
const scriptSrc = () => fs.readFileSync(SCRIPT, "utf8");
const modSrc = () => fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-webhook-smoke.js"), "utf8");

const STAGING = "https://heroic-friendship-staging.up.railway.app";

// ---------------------------------------------------------------------------
// 1. WHERE IT MAY POINT
// ---------------------------------------------------------------------------

describe("E-12J: the target is validated before anything is sent", () => {
  it("1. a public https staging URL is accepted, and the path is appended", () => {
    const t = validateSmokeTarget(STAGING, { env: {} });
    assert.strictEqual(t.ok, true);
    assert.strictEqual(t.webhookUrl, `${STAGING}${ACQUISITION_WEBHOOK_PATH}`);
    assert.strictEqual(ACQUISITION_WEBHOOK_PATH, "/webhooks/retell/acquisition");
  });

  it("2. it has no default target — a URL must be supplied", () => {
    for (const empty of [undefined, null, "", "   "]) {
      assert.strictEqual(validateSmokeTarget(empty, { env: {} }).code, SMOKE_CODES.MISSING);
    }
    assert.ok(!/https?:\/\/[a-z]/.test(modSrc().replace(/^\s*\/\/.*$/gm, "")), "no URL literal in the module");
  });

  it("3. http is refused — a public webhook is https or it is not public", () => {
    assert.strictEqual(validateSmokeTarget("http://staging.example.test", { env: {} }).code, SMOKE_CODES.NOT_HTTPS);
  });

  it("4. localhost and private ranges are refused", () => {
    for (const local of [
      "https://localhost", "https://127.0.0.1", "https://[::1]", "https://0.0.0.0",
      "https://box.local", "https://10.0.0.4", "https://192.168.1.9", "https://172.20.0.1",
    ]) {
      assert.strictEqual(validateSmokeTarget(local, { env: {} }).code, SMOKE_CODES.LOCAL, local);
    }
  });

  it("5. PRODUCTION is refused outright, not warned about", () => {
    const env = { BASE_URL: "https://aida-production.up.railway.app" };
    const t = validateSmokeTarget("https://aida-production.up.railway.app", { env });
    assert.strictEqual(t.ok, false);
    assert.strictEqual(t.code, SMOKE_CODES.PRODUCTION);
    // Case-insensitively, and via either configured key.
    assert.strictEqual(validateSmokeTarget("https://AIDA-PRODUCTION.up.railway.app", { env }).code, SMOKE_CODES.PRODUCTION);
    assert.strictEqual(
      validateSmokeTarget("https://prod.example.test", { env: { PRODUCTION_BASE_URL: "https://prod.example.test" } }).code,
      SMOKE_CODES.PRODUCTION
    );
  });

  it("6. staging is still allowed when a production URL is configured", () => {
    const env = { BASE_URL: "https://aida-production.up.railway.app" };
    assert.strictEqual(validateSmokeTarget(STAGING, { env }).ok, true);
  });

  it("7. a URL carrying credentials is refused", () => {
    assert.strictEqual(validateSmokeTarget("https://user:pass@staging.example.test", { env: {} }).code, SMOKE_CODES.HAS_CREDENTIALS);
  });

  it("8. nonsense is refused", () => {
    assert.strictEqual(validateSmokeTarget("not a url", { env: {} }).code, SMOKE_CODES.NOT_URL);
  });
});

// ---------------------------------------------------------------------------
// 2. NO FORGED SIGNATURE, EVER
// ---------------------------------------------------------------------------

describe("E-12J: it cannot and does not fabricate a valid signature", () => {
  it("9. neither the module nor the runner computes an HMAC", () => {
    for (const src of [modSrc(), scriptSrc()]) {
      assert.ok(!/createHmac|createHash|timingSafeEqual|require\(["']crypto["']\)/.test(src), "no crypto anywhere");
    }
  });

  it("10. neither reads the Retell API key", () => {
    for (const src of [modSrc(), scriptSrc()]) {
      assert.ok(!/RETELL_API_KEY/.test(src), "the key is never read, so a signature cannot be made");
    }
  });

  it("11. the one signature-ish probe is explicitly NOT a valid one", () => {
    const probe = NEGATIVE_PROBES.find((p) => p.headers && p.headers["x-retell-signature"]);
    assert.ok(probe, "there is a malformed-signature probe");
    assert.strictEqual(probe.headers["x-retell-signature"], "not-a-real-signature");
    assert.match(probe.proves, /NOT a forged valid signature/i);
  });

  it("12. every probe expects a 4xx — none expects success", () => {
    for (const p of [...NEGATIVE_PROBES, oversizeProbe()]) {
      assert.ok(p.expect.length > 0, p.name);
      for (const code of p.expect) {
        assert.ok(code >= 400 && code < 500, `${p.name} expects ${code}; probes must never expect success`);
      }
    }
  });

  it("13. a 2xx is judged CRITICAL, not merely unexpected", () => {
    const v = judgeProbeResult(NEGATIVE_PROBES[0], 204);
    assert.strictEqual(v.pass, false);
    assert.strictEqual(v.severity, "critical");
    assert.match(v.detail, /ACCEPTED/);
  });

  it("14. a 5xx is a failure too — a rejection should not be a server error", () => {
    const v = judgeProbeResult(NEGATIVE_PROBES[0], 500);
    assert.strictEqual(v.pass, false);
    assert.strictEqual(v.severity, "attention");
  });

  it("15. an expected status passes", () => {
    assert.strictEqual(judgeProbeResult(NEGATIVE_PROBES[0], 404).pass, true);
    const unsigned = NEGATIVE_PROBES.find((p) => p.name === "POST, no signature");
    assert.strictEqual(judgeProbeResult(unsigned, 401).pass, true);
  });
});

// ---------------------------------------------------------------------------
// 3. NO PROBE LOOKS LIKE OUR TRAFFIC
// ---------------------------------------------------------------------------

describe("E-12J: nothing sent could be mistaken for acquisition traffic", () => {
  it("16. no probe body carries aida_purpose or a dispatch id", () => {
    for (const p of [...NEGATIVE_PROBES, oversizeProbe()]) {
      const body = String(p.body || "");
      assert.ok(!/aida_purpose/i.test(body), p.name);
      assert.ok(!/aida_dispatch_id/i.test(body), p.name);
      assert.ok(!/locksmith_acquisition/i.test(body), p.name);
      assert.ok(!/call_id/i.test(body), p.name);
    }
  });

  it("17. probe bodies identify themselves as probes", () => {
    for (const p of NEGATIVE_PROBES.filter((x) => x.body && x.body.startsWith("{\""))) {
      assert.match(p.body, /"probe":"e12j-/, `${p.name} should be self-identifying`);
    }
  });

  it("18. the probe list is closed — exactly the six, plus opt-in oversize", () => {
    assert.strictEqual(NEGATIVE_PROBES.length, 6);
    assert.ok(Object.isFrozen(NEGATIVE_PROBES));
    for (const p of NEGATIVE_PROBES) assert.ok(Object.isFrozen(p));
    const names = NEGATIVE_PROBES.map((p) => p.name);
    assert.ok(names.some((n) => /GET/.test(n)));
    assert.ok(names.some((n) => /no signature/.test(n)));
    assert.ok(names.some((n) => /malformed signature/.test(n)));
    assert.ok(names.some((n) => /malformed body/.test(n)));
    assert.ok(names.some((n) => /content type/.test(n)));
  });

  it("19. the oversize probe is opt-in and actually large", () => {
    const p = oversizeProbe();
    assert.ok(p.body.length > 500 * 1024);
    assert.ok(p.expect.includes(413));
    assert.match(scriptSrc(), /--include-oversize/);
    assert.ok(!NEGATIVE_PROBES.some((x) => /oversize/i.test(x.name)), "not in the default set");
  });
});

// ---------------------------------------------------------------------------
// 4. DORMANT IS NOT SECURE
// ---------------------------------------------------------------------------

describe("E-12J: all-404 is reported as dormant, not as a pass", () => {
  it("20. every probe answering 404 means the feature is off", () => {
    const s = describeRouteState([404, 404, 404, 404]);
    assert.strictEqual(s.dormant, true);
    assert.match(s.detail, /DORMANT/);
    assert.match(s.detail, /Nothing about rejection has been proven/i);
  });

  it("21. a mix of statuses means the route is exposed and rejecting", () => {
    const s = describeRouteState([404, 401, 400]);
    assert.strictEqual(s.dormant, false);
    assert.match(s.detail, /exposed and actively rejecting/i);
  });

  it("22. no statuses at all is not 'dormant'", () => {
    assert.strictEqual(describeRouteState([]).dormant, false);
  });
});

// ---------------------------------------------------------------------------
// 5. THE RUNNER'S SAFETY
// ---------------------------------------------------------------------------

describe("E-12J: the runner sends probes and nothing else", () => {
  it("23. it describes by default and needs --run to send", () => {
    const s = scriptSrc();
    assert.match(s, /const RUN = process\.argv\.includes\("--run"\)/);
    assert.match(s, /NOTHING WAS SENT/);
  });

  it("24. it sends no credential of any kind", () => {
    // Matched as USAGE, not as words. The runner prints a line telling the
    // founder that no key or cookie is sent, and banning the word would mean
    // deleting the reassurance to satisfy the test.
    const code = scriptSrc()
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/console\.log\([^\n]*\)/g, "")
      .replace(/console\.error\([^\n]*\)/g, "");
    for (const usage of [
      /env\.RETELL_API_KEY/,
      /env\.SUPABASE_SERVICE_KEY/,
      /["']authorization["']\s*:/i,
      /Bearer \$\{/,
      /["']cookie["']\s*:/i,
      /credentials\s*:/,
    ]) {
      assert.ok(!usage.test(code), `${usage} must not appear in executable code`);
    }
    // And the reassurance is still printed.
    assert.match(scriptSrc(), /Nothing sent here carries a Retell key/);
  });

  it("25. it has no provider mutation capability", () => {
    const s = scriptSrc();
    for (const forbidden of [/adapter\./, /createAgent/, /createPhoneCall/, /createResponseEngine/, /bindPhoneNumber/, /twilio/i]) {
      assert.ok(!forbidden.test(s.replace(/^\s*\/\/.*$/gm, "")), `${forbidden} must not be reachable`);
    }
  });

  it("26. its only outbound request is to the validated webhook URL", () => {
    const s = scriptSrc();
    const fetches = [...s.matchAll(/fetch\(([^,]+),/g)].map((m) => m[1].trim());
    assert.deepStrictEqual(fetches, ["target.webhookUrl"], "one fetch, one destination");
  });

  it("27. the DEV census is read-only", () => {
    const s = scriptSrc();
    assert.match(s, /makeClient/, "uses the existing read-only helper");
    assert.ok(!/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(s), "no writes");
    assert.match(s, /select\("\*"\)/);
  });

  it("28. a changed census after probing is treated as a failure", () => {
    assert.match(scriptSrc(), /census unchanged/);
    assert.match(scriptSrc(), /INVESTIGATE/);
  });

  it("29. it is not wired into the server or any service", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.ok(!/webhook-smoke/.test(server));
    for (const dir of ["src/services", "src/routes"]) {
      const d = path.join(__dirname, "..", dir);
      for (const f of fs.readdirSync(d).filter((n) => n.endsWith(".js"))) {
        if (f === "acquisition-webhook-smoke.js") continue;
        assert.ok(!/acquisition-webhook-smoke/.test(fs.readFileSync(path.join(d, f), "utf8")), `${dir}/${f}`);
      }
    }
  });

  it("30. the probe definitions module reaches no network itself", () => {
    assert.ok(!/fetch\(|axios|node-fetch|require\(["']https?["']\)/.test(modSrc()));
  });
});
