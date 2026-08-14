// LOCKSMITH ACQUISITION E-12E — the gates in front of creating the agent.
//
// ── WHY THE AGENT IS A HARDER WRITE THAN THE ENGINE ─────────────────
// E-10D(i) created a response engine: a prompt and an opening, with no voice,
// no number and no webhook. The worst a duplicate could do was waste an object.
//
// An agent is different. It has a voice, it points at a prompt, it carries the
// answering-machine policy, and it names where outcomes are delivered. A wrong
// one is an agent that could speak to a stranger in the wrong voice, from the
// wrong prompt, and leave a sales message on their answering machine. A
// duplicate one is a second thing that can do that.
//
// So every check below is a specific way the single authorised write could
// produce an agent nobody would notice was wrong until it telephoned somebody.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  assessAcquisitionAgentProvisioning,
  classifyCreateAgentFailure,
  checkWebhookUrl,
  REFUSALS,
  AUTHORISED_OPERATION,
  FORBIDDEN_OPERATIONS,
  AMBIGUOUS_PROVIDER_CODES,
} = require("../src/services/acquisition-agent-provisioning");

const { PROVISIONED_RESPONSE_ENGINE } = require("../src/services/acquisition-agent-spec");
const { getRetellConfig } = require("../src/config/retell");

const LLM = "llm_111ed51e781164108b4d6ae762e1";
const VOICE = "custom_voice_018b4225b718ffc38a2e1da4d4";
const HOOK = "https://acq-staging.example.test/webhooks/retell/acquisition";

/** The environment in which creating the agent SHOULD be allowed. */
const READY_ENV = Object.freeze({
  NODE_ENV: "production",
  RETELL_ENABLED: "true",
  RETELL_ALLOWED_TAG: "staging",
  RETELL_API_KEY: "fixture_key",
  RETELL_ACQUISITION_LLM_ID: LLM,
  RETELL_ACQUISITION_VOICE_ID: VOICE,
  RETELL_ACQUISITION_WEBHOOK_URL: HOOK,
});

const assess = (over = {}, extra = {}) => {
  const env = { ...READY_ENV, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
  return assessAcquisitionAgentProvisioning({ env, config: getRetellConfig(env), ...extra });
};

const SCRIPT = path.join(__dirname, "..", "scripts", "dev", "acquisition-provision-agent.js");
const scriptSrc = () => fs.readFileSync(SCRIPT, "utf8");

// ---------------------------------------------------------------------------
// 1. THE READY CASE
// ---------------------------------------------------------------------------

describe("E-12E: what a create-ready acquisition agent looks like", () => {
  it("1. a fully configured environment is accepted", () => {
    const v = assess();
    assert.deepStrictEqual([...v.refusals], [], "no refusals expected");
    assert.strictEqual(v.ok, true);
    assert.ok(v.payload, "a payload is produced only when it is safe to send one");
  });

  it("2. the payload is exactly the agent, with the founder's choices in it", () => {
    const v = assess();
    assert.strictEqual(v.payload.response_engine.llm_id, LLM);
    assert.strictEqual(v.payload.voice_id, VOICE);
    assert.strictEqual(v.payload.language, "en-AU");
    assert.strictEqual(v.payload.webhook_url, HOOK);
    assert.deepStrictEqual(v.payload.voicemail_option, { action: { type: "hangup" } });
    assert.ok(v.payload.post_call_analysis_data.length > 0);
  });

  it("3. NODE_ENV=production with tag=staging is ACCEPTED", () => {
    // The founder's actual staging shape. NODE_ENV describes server security
    // posture; RETELL_ALLOWED_TAG describes which account is written to. They
    // are different questions and conflating them would block the real setup.
    const v = assess({ NODE_ENV: "production", RETELL_ALLOWED_TAG: "staging" });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.checks.nodeEnv, "production");
    assert.strictEqual(v.checks.allowedTag, "staging");
  });

  it("3b. tag=dev is also accepted", () => {
    assert.strictEqual(assess({ RETELL_ALLOWED_TAG: "dev" }).ok, true);
  });

  it("4. THE CURRENT REAL ENVIRONMENT IS NOT READY — the webhook does not exist", () => {
    // This is the truthful state today and must not be faked ready.
    const v = assessAcquisitionAgentProvisioning({ env: {}, config: getRetellConfig({}) });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.payload, null, "no payload is offered when it is not safe to send one");
    assert.ok(v.refusals.includes(REFUSALS.WEBHOOK_MISSING));
    assert.ok(v.refusals.includes(REFUSALS.VOICE_MISSING));
    assert.ok(v.refusals.includes(REFUSALS.ENGINE_ID_MISSING));
  });
});

// ---------------------------------------------------------------------------
// 2. EVERY REFUSAL, ONE AT A TIME
// ---------------------------------------------------------------------------

describe("E-12E: each refusal fires on its own", () => {
  it("5. the production Retell tag is refused", () => {
    const v = assess({ RETELL_ALLOWED_TAG: "prod" });
    assert.ok(v.refusals.includes(REFUSALS.PROD_TAG));
    assert.strictEqual(v.payload, null);
  });

  it("6. a missing llm_id is refused", () => {
    assert.ok(assess({ RETELL_ACQUISITION_LLM_ID: undefined }).refusals.includes(REFUSALS.ENGINE_ID_MISSING));
  });

  it("7. a missing acquisition voice is refused — no shared fallback", () => {
    // Supplying the RECEPTIONIST voice must not rescue it.
    const v = assess({ RETELL_ACQUISITION_VOICE_ID: undefined, RETELL_DEFAULT_VOICE_ID: "custom_voice_receptionist" });
    assert.ok(v.refusals.includes(REFUSALS.VOICE_MISSING));
    assert.strictEqual(v.checks.voiceOnPayload, null, "acquisition stays voiceless rather than borrowing");
  });

  it("8. a missing webhook is refused — no shared fallback", () => {
    const v = assess({ RETELL_ACQUISITION_WEBHOOK_URL: undefined, RETELL_WEBHOOK_BASE_URL: "https://onboarding.example.test" });
    assert.ok(v.refusals.includes(REFUSALS.WEBHOOK_MISSING));
    assert.strictEqual(v.checks.webhookUrl, null);
  });

  it("9. a non-https webhook is refused", () => {
    for (const bad of ["http://acq.example.test/webhooks/retell/acquisition", "ftp://x.example.test/h", "not a url"]) {
      const v = assess({ RETELL_ACQUISITION_WEBHOOK_URL: bad });
      assert.ok(v.refusals.includes(REFUSALS.WEBHOOK_INSECURE), bad);
    }
  });

  it("10. a local or private-network webhook is refused", () => {
    for (const bad of [
      "https://localhost/webhooks/retell/acquisition",
      "https://127.0.0.1/h",
      "https://192.168.1.10/h",
      "https://10.0.0.5/h",
      "https://172.16.4.4/h",
      "https://box.local/h",
    ]) {
      const v = assess({ RETELL_ACQUISITION_WEBHOOK_URL: bad });
      assert.ok(v.refusals.includes(REFUSALS.WEBHOOK_LOCAL), `${bad} — Retell could never deliver here`);
    }
  });

  it("11. an already-provisioned agent is refused", () => {
    const v = assess({}, { existingResource: { provider_resource_id: "agent_existing", active: true } });
    assert.ok(v.refusals.includes(REFUSALS.ALREADY_PROVISIONED));
    assert.strictEqual(v.payload, null, "a second agent is a second thing that can telephone people");
  });

  it("12. response-engine drift is refused", () => {
    // Simulated by asserting the check reads the live hash rather than a
    // constant — a drifted engine would change `engineHashActual`.
    const v = assess();
    assert.strictEqual(v.checks.engineHashExpected, PROVISIONED_RESPONSE_ENGINE.payloadHash);
    assert.strictEqual(v.checks.engineHashActual, PROVISIONED_RESPONSE_ENGINE.payloadHash);
    assert.strictEqual(v.checks.engineDrifted, false);
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-provisioning.js"), "utf8");
    assert.match(src, /if \(drift\.drifted\) refusals\.push\(REFUSALS\.ENGINE_DRIFT\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE VOICEMAIL AND LANGUAGE INVARIANTS
// ---------------------------------------------------------------------------

describe("E-12E: the agent cannot be created with the wrong speaking behaviour", () => {
  it("13. the voicemail action must be hangup", () => {
    const v = assess();
    assert.strictEqual(v.checks.voicemailAction, "hangup");
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-provisioning.js"), "utf8");
    assert.match(src, /action\.type !== "hangup"/);
  });

  it("14. a voicemail MESSAGE is refused by a second, independent check", () => {
    // Two checks on purpose: one on the action type, one scanning for any
    // text-bearing key, so a new Retell field carrying a message would still
    // be caught.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-provisioning.js"), "utf8");
    assert.match(src, /"text"\|"prompt"\|"message"\|"audio"/);
    assert.ok(REFUSALS.VOICEMAIL_MESSAGE);
  });

  it("15. the language must be en-AU", () => {
    const v = assess();
    assert.strictEqual(v.checks.language, "en-AU");
    const v2 = assess({ RETELL_DEFAULT_LANGUAGE: "en-US" });
    assert.strictEqual(v2.checks.language, "en-AU", "acquisition does not read the shared language key");
  });
});

// ---------------------------------------------------------------------------
// 4. NO RETRY, EVER
// ---------------------------------------------------------------------------

describe("E-12E: an ambiguous provider answer is never retried", () => {
  it("16. timeout / unreachable / error are all UNKNOWN, not failure", () => {
    for (const code of AMBIGUOUS_PROVIDER_CODES) {
      const c = classifyCreateAgentFailure(code);
      assert.strictEqual(c.status, "unknown", code);
      assert.strictEqual(c.retry, false, code);
      assert.strictEqual(c.action, "reconcile_by_hand", code);
    }
  });

  it("17. a definitive refusal is safe to correct and re-run", () => {
    const c = classifyCreateAgentFailure("provider_invalid_request");
    assert.strictEqual(c.status, "refused");
    assert.strictEqual(c.retry, false, "still never an automatic retry");
    assert.strictEqual(c.action, "correct_and_rerun");
  });

  it("18. nothing in the module or the script loops or schedules", () => {
    const mod = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-provisioning.js"), "utf8");
    for (const src of [mod, scriptSrc()]) {
      assert.ok(!/setTimeout|setInterval|while \(|for \(let attempt|retries|backoff/.test(src), "no retry machinery");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. THE RUNNER'S SHAPE
// ---------------------------------------------------------------------------

describe("E-12E: the runner can do exactly one thing", () => {
  it("19. it defaults to preview and needs an explicit flag to write", () => {
    const src = scriptSrc();
    assert.match(src, /const PREVIEW_ONLY = !process\.argv\.includes\("--create-one-agent"\)/);
    assert.match(src, /PREVIEW COMPLETE/);
    assert.match(src, /NOTHING WAS SENT/);
  });

  it("20. it calls createAgent, and only createAgent", () => {
    const src = scriptSrc();
    const calls = [...src.matchAll(/adapter\.(\w+)\(/g)].map((m) => m[1]);
    assert.deepStrictEqual(calls, [AUTHORISED_OPERATION], `exactly one adapter call: ${calls.join(", ")}`);
  });

  it("21. no forbidden Retell operation appears anywhere in it", () => {
    const src = scriptSrc();
    for (const op of FORBIDDEN_OPERATIONS) {
      assert.ok(!new RegExp(`adapter\\.${op}\\s*\\(`).test(src), `${op} must not be reachable from the agent runner`);
    }
  });

  it("22. it refuses to create without the one-agent guard", () => {
    const src = scriptSrc();
    assert.match(src, /REFUSED — THE ONE-AGENT GUARD IS NOT AVAILABLE/);
    assert.match(src, /Refusing to create one blindly/);
  });

  it("23. a successful create with a failed record is LOUD and never re-creates", () => {
    const src = scriptSrc();
    assert.match(src, /AGENT CREATED BUT NOT RECORDED — RECONCILIATION REQUIRED/);
    // The id is printed more than once on purpose — it is the only thing that
    // matters at that moment, and it must survive a scrollback.
    const shouts = (src.match(/THE AGENT EXISTS\./g) || []).length;
    assert.ok(shouts >= 3, `the id must be unmissable, saw ${shouts}`);
    assert.match(src, /DO NOT run this script again — it would create a SECOND agent/);
  });

  it("24. an ambiguous failure exits distinctly from a definitive one", () => {
    const src = scriptSrc();
    assert.match(src, /AMBIGUOUS FAILURE — STOP/);
    assert.match(src, /process\.exit\(2\)/, "2 = unknown, needs a human");
    assert.match(src, /process\.exit\(3\)/, "3 = created but unrecorded");
    assert.match(src, /Do not run this again/i);
  });

  it("25. it is a hand-run script, not wired into the server", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.ok(!/acquisition-provision-agent/.test(server), "no route, no worker, no runtime exposure");
    for (const dir of ["src/services", "src/routes"]) {
      const d = path.join(__dirname, "..", dir);
      for (const f of fs.readdirSync(d).filter((n) => n.endsWith(".js"))) {
        assert.ok(
          !/acquisition-provision-agent/.test(fs.readFileSync(path.join(d, f), "utf8")),
          `${dir}/${f} must not import the provisioning runner`
        );
      }
    }
  });

  it("26. the gate module itself cannot reach the network", () => {
    const mod = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-provisioning.js"), "utf8");
    assert.ok(!/fetch\(|axios|node-fetch|retell-adapter|require\(["']https?["']\)/.test(mod));
  });
});

// ---------------------------------------------------------------------------
// 6. CREATING AN AGENT ENABLES NOTHING
// ---------------------------------------------------------------------------

describe("E-12E: creating an agent is not permission to call anybody", () => {
  it("27. the runner touches no calling authority", () => {
    const src = scriptSrc();
    // Matched as CALL/ASSIGNMENT forms, not bare words. The header comment
    // legitimately names these operations in order to say they are absent, and
    // banning the name would mean deleting the explanation to satisfy the test.
    // Test 21 pins the same rule at the adapter boundary.
    for (const form of [
      /\bwriteCallingState\s*\(/,
      /\bcreatePhoneCall\s*\(/,
      /\bcreateWebCall\s*\(/,
      /\bbindPhoneNumber\s*\(/,
      /\blive\s*:\s*true\b/,
      /ACQUISITION_ENABLED\s*=/,
      /RETELL_LIVE_CALLS_ENABLED\s*=/,
    ]) {
      assert.ok(!form.test(src), `${form} must not appear in the agent runner`);
    }
  });

  it("27b. and the header still names them, so the absence is documented", () => {
    const src = scriptSrc();
    assert.match(src, /There is no code path here to/i);
    for (const named of ["createResponseEngine", "createPhoneCall", "bindPhoneNumber"]) {
      assert.ok(src.includes(named), `${named} should be named as prohibited`);
    }
  });

  it("28. providers stay live:false and telephony stays unavailable", () => {
    const dial = require("../src/services/acquisition-dial-provider");
    const retell = require("../src/services/acquisition-retell-provider");
    assert.strictEqual(dial.createDisabledDialProvider().live, false);
    assert.strictEqual(retell.createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "+61355500001" } }).live, false);
    assert.strictEqual(require("../src/config/acquisition").EXTERNAL_SYSTEMS.telephony, false);
  });

  it("29. a ready-to-create verdict says nothing about being ready to CALL", () => {
    const v = assess();
    assert.strictEqual(v.ok, true, "create-ready");
    // Creating the agent does not provision a number, and there is none.
    assert.ok(!("from_number" in v.payload) && !("phone_number" in v.payload));
  });

  it("30. the webhook checker is exported and independently correct", () => {
    assert.strictEqual(checkWebhookUrl(HOOK), null);
    assert.strictEqual(checkWebhookUrl(""), REFUSALS.WEBHOOK_MISSING);
    assert.strictEqual(checkWebhookUrl("http://x.example.test/h"), REFUSALS.WEBHOOK_INSECURE);
    assert.strictEqual(checkWebhookUrl("https://localhost/h"), REFUSALS.WEBHOOK_LOCAL);
  });
});
