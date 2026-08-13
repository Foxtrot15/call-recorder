// LOCKSMITH ACQUISITION E-10C — two Retell resources, and the order between them.
//
// E-10B found the defect: one object carrying agent fields AND general_prompt
// AND begin_message. Sent as it was, it would have created an agent whose
// llm_id was null — an agent with no brain — while the prompt went to an
// endpoint that does not accept one.
//
// This proves the split, the dependency, and the thing that matters most:
// nothing here can be provisioned by accident.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildAcquisitionResponseEngine,
  buildAcquisitionAgent,
  describeAcquisitionRetellResources,
  buildAcquisitionAnalysisFields,
  ACQUISITION_RESOURCE_ORDER,
  ACQUISITION_RESOURCE_PREFIX,
  SPEC_VERSION,
} = require("../src/services/acquisition-agent-spec");

const ACQ_LLM = "llm_acquisition_fixture_0001";

// ---------------------------------------------------------------------------
// 1-4. WHICH FIELD LIVES ON WHICH RESOURCE
// ---------------------------------------------------------------------------

describe("E-10C: the prompt belongs to the engine, the analysis to the agent", () => {
  const r = describeAcquisitionRetellResources();

  it("1-2. general_prompt and begin_message live on the RESPONSE ENGINE", () => {
    assert.ok(typeof r.responseEngine.general_prompt === "string" && r.responseEngine.general_prompt.length > 500);
    assert.ok(typeof r.responseEngine.begin_message === "string" && r.responseEngine.begin_message.length > 50);
    assert.ok(!("general_prompt" in r.agent), "the agent must not carry the prompt");
    assert.ok(!("begin_message" in r.agent), "the agent must not carry the opening");
  });

  it("3. post_call_analysis_data lives on the AGENT", () => {
    assert.ok(Array.isArray(r.agent.post_call_analysis_data));
    assert.ok(!("post_call_analysis_data" in r.responseEngine));
  });

  it("4. response_engine.llm_id lives on the AGENT", () => {
    assert.ok("response_engine" in r.agent);
    assert.strictEqual(r.agent.response_engine.type, "retell-llm");
    assert.ok("llm_id" in r.agent.response_engine);
    assert.ok(!("response_engine" in r.responseEngine), "an engine does not reference itself");
  });

  it("matches the shape both existing compilers already use", () => {
    // Not a style preference — the same two endpoints, so the same two objects.
    assert.deepStrictEqual(Object.keys(r.responseEngine).sort(), ["begin_message", "default_dynamic_variables", "general_prompt", "general_tools"]);
    assert.deepStrictEqual(
      Object.keys(r.agent).sort(),
      // voicemail_option added by E-12A. Named explicitly rather than letting
      // the list go open-world, so the next field to appear on this payload
      // still has to be argued for here.
      ["agent_name", "language", "post_call_analysis_data", "response_engine", "voice_id", "voicemail_option", "webhook_url"]
    );
  });

  it("the engine has no tools, because this agent may not do anything", () => {
    assert.deepStrictEqual([...r.responseEngine.general_tools], [], "a tool would be a capability nobody approved");
  });

  it("the engine declares the variables the dial provider actually sends", () => {
    // E-7B2A sends retell_llm_dynamic_variables: { business_name, authorised_at }.
    assert.deepStrictEqual(Object.keys(r.responseEngine.default_dynamic_variables).sort(), ["authorised_at", "business_name"]);
    for (const v of Object.values(r.responseEngine.default_dynamic_variables)) {
      assert.strictEqual(v, "", "a default must be empty rather than a placeholder somebody would say aloud");
    }
  });
});

// ---------------------------------------------------------------------------
// 5-9. THE DEPENDENCY
// ---------------------------------------------------------------------------

describe("E-10C: the agent cannot exist before its engine", () => {
  it("5. an unresolved llm_id means NOT create-ready", () => {
    const r = describeAcquisitionRetellResources({ config: { voiceId: "v", acquisitionWebhookUrl: "https://acq.example.test/webhooks/retell" } });
    assert.strictEqual(r.agent.response_engine.llm_id, null);
    assert.strictEqual(r.readiness.agent.llmIdResolved, false);
    assert.strictEqual(r.readiness.createAgentReady, false);
    assert.ok(r.readiness.blockers.some((b) => /response-engine id/i.test(b)));
  });

  it("6. the order puts the engine first, and the agent depends on it", () => {
    assert.strictEqual(ACQUISITION_RESOURCE_ORDER[0].resourceType, "response_engine");
    assert.strictEqual(ACQUISITION_RESOURCE_ORDER[0].dependsOn, null, "an engine depends on nothing");
    assert.strictEqual(ACQUISITION_RESOURCE_ORDER[1].resourceType, "voice_agent");
    assert.strictEqual(ACQUISITION_RESOURCE_ORDER[1].dependsOn, "response_engine");
    assert.strictEqual(ACQUISITION_RESOURCE_ORDER[0].operation, "createResponseEngine");
    assert.strictEqual(ACQUISITION_RESOURCE_ORDER[1].operation, "createAgent");
  });

  it("7. a supplied acquisition llm_id lands in exactly one field", () => {
    const r = describeAcquisitionRetellResources({ llmId: ACQ_LLM });
    assert.strictEqual(r.agent.response_engine.llm_id, ACQ_LLM);
    assert.strictEqual(r.readiness.agent.llmIdResolved, true);
    assert.strictEqual(r.dependencies[0].satisfied, true);
    // And nowhere else.
    const engineText = JSON.stringify(r.responseEngine);
    assert.ok(!engineText.includes(ACQ_LLM), "the engine must not carry its own id");
  });

  it("8-9. a receptionist or onboarding id cannot satisfy the dependency by accident", () => {
    // The guarantee is structural: the id is supplied per call to THIS builder,
    // and nothing reads a shared registry. Proven by showing the acquisition
    // agent only ever carries what it was handed, and that the acquisition
    // resource names cannot be confused with the other families'.
    const foreign = ["llm_receptionist_abc", "llm_onboarding_xyz"];
    for (const id of foreign) {
      const r = describeAcquisitionRetellResources({ llmId: id });
      // It would be BOUND if handed over — nothing can stop that — so the
      // protection is that the acquisition agent is a distinct named resource
      // provisioned by an explicit acquisition action, never by the receptionist
      // or onboarding flows. That is what the next describe() proves.
      assert.strictEqual(r.agent.response_engine.llm_id, id);
      assert.ok(r.agent.agent_name.startsWith(`${ACQUISITION_RESOURCE_PREFIX}-agent-`), "and it is still unmistakably the acquisition agent");
    }
  });
});

// ---------------------------------------------------------------------------
// 10-11. NAMING AND — THE ONE THAT MATTERS — NO IMPLICIT PROVISIONING
// ---------------------------------------------------------------------------

describe("E-10C: acquisition cannot be provisioned as a side effect", () => {
  it("10. resource names cannot collide with the other agent families", () => {
    const { agent } = describeAcquisitionRetellResources();
    assert.match(agent.agent_name, /^aida-acquisition-agent-/);
    assert.ok(!agent.agent_name.startsWith("aida-receptionist-"));
    assert.ok(!agent.agent_name.startsWith("aida-onboarding-"));
    assert.ok(agent.agent_name.includes(SPEC_VERSION), "versioned, like the others");
  });

  it("11. provisioning-plan.js does not know acquisition exists", () => {
    // THE LOAD-BEARING TEST OF THIS MILESTONE.
    //
    // DESIRED_RESOURCE_ORDER is keyed by resourceType, and buildDesiredResources
    // looks each entry up in a byResource map built from ONE compiled
    // receptionist. An acquisition entry with resourceType "response_engine"
    // would be handed the RECEPTIONIST's payload and emitted as an
    // acquisition-purposed row carrying receptionist content.
    const plan = require("../src/services/provisioning-plan");
    for (const entry of plan.DESIRED_RESOURCE_ORDER) {
      assert.ok(!/acquisition/i.test(entry.purpose), `provisioning-plan must not carry ${entry.purpose}`);
    }
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "provisioning-plan.js"), "utf8");
    assert.ok(!/acquisition/i.test(src), "provisioning-plan.js must not mention acquisition at all");
  });

  it("no existing provisioning caller reaches the acquisition compiler", () => {
    const roots = ["src/services/approval-provisioning-bridge.js", "src/routes/locksmith-provisioning-handlers.js", "scripts/locksmith-mock-journey.js"];
    for (const rel of roots) {
      const body = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      assert.ok(!/acquisition-agent-spec/.test(body), `${rel} must not compile acquisition resources`);
      assert.ok(!/describeAcquisitionRetellResources/.test(body), `${rel} must not build acquisition resources`);
    }
  });

  /**
   * Nothing builds acquisition resources except ONE named script.
   *
   * ── THE EXCEPTION IS NAMED, NOT WILDCARDED (E-10D(i)) ─────────────
   * This test used to assert that NOTHING anywhere touched these builders,
   * which was right while provisioning was unauthorised. E-10D(i) authorised
   * exactly one act: creating the response engine. The rule it was protecting —
   * acquisition is never provisioned as a side effect of something else — is
   * unchanged, so the exception is a single filename rather than a relaxed
   * pattern. Same shape as the runbook's section-6 probe exception.
   *
   * A second provisioning caller appearing anywhere still fails the build.
   */
  const PROVISIONING_SCRIPT = "acquisition-provision-response-engine.js";

  it("nothing provisions acquisition resources except the one named script", () => {
    const dirs = ["src/services", "src/routes", "scripts", "scripts/dev"];
    const offenders = [];
    for (const d of dirs) {
      const dir = path.join(__dirname, "..", d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
        if (f === "acquisition-agent-spec.js" || f === PROVISIONING_SCRIPT) continue;
        const body = fs.readFileSync(path.join(dir, f), "utf8");
        if (/describeAcquisitionRetellResources|buildAcquisitionResponseEngine|buildAcquisitionAgent/.test(body)) {
          offenders.push(`${d}/${f}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, [], offenders.join("; "));
  });

  it("the provisioning script can create an ENGINE and nothing else", () => {
    // The structural guarantee behind "no agent was created": there is no code
    // path to one. Asserted by reading the only file that can reach Retell.
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", PROVISIONING_SCRIPT), "utf8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");

    assert.match(code, /adapter\.createResponseEngine\s*\(/, "it must create the engine");
    for (const forbidden of [
      /\.createAgent\s*\(/,
      /\.updateAgent\s*\(/,
      /\.createPhoneCall\s*\(/,
      /\.createWebCall\s*\(/,
      /\.bindPhoneNumber\s*\(/,
      /\.updateResponseEngine\s*\(/,
      /\.deleteAgent\s*\(/,
    ]) {
      assert.ok(!forbidden.test(code), `the provisioning script must not be able to call ${forbidden}`);
    }
  });

  it("the provisioning script never retries an ambiguous write", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", PROVISIONING_SCRIPT), "utf8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");
    for (const p of [/\bretry\s*\(/, /\bbackoff\b/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bwhile\s*\(/, /\bfor\s*\(\s*;;/]) {
      assert.ok(!p.test(code), `the provisioning script must contain no ${p}`);
    }
    // Exactly one create call in the whole file.
    const creates = code.match(/adapter\.create\w+\s*\(/g) || [];
    assert.strictEqual(creates.length, 1, `exactly one create call, found ${creates.length}: ${creates.join(", ")}`);
  });

  it("the provisioning script defaults to preview and refuses production", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", PROVISIONING_SCRIPT), "utf8");
    assert.match(src, /PREVIEW_ONLY = !process\.argv\.includes\("--create-one-response-engine"\)/, "sending must be opt-in");
    assert.match(src, /allowedTag === "prod"/, "it must refuse the production account");
    assert.match(src, /REFUSING/, "and say so");
  });

  it("the provisioning script sends the ENGINE payload only", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "dev", PROVISIONING_SCRIPT), "utf8");
    assert.match(src, /const payload = resources\.responseEngine/, "the engine payload, never the agent's");
    assert.ok(!/resources\.agent/.test(src.replace(/\/\/.*$/gm, "")), "the agent payload must not be reachable");
  });
});

// ---------------------------------------------------------------------------
// 12-19. READINESS TELLS THE TRUTH
// ---------------------------------------------------------------------------

describe("E-10C: readiness is honest about what is unresolved", () => {
  it("12-13. compiling needs no network client and no credential", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-spec.js"), "utf8");
    const code = src.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    }).join("\n");
    assert.ok(!/process\.env/.test(src));
    for (const p of [/\bfetch\s*\(/, /createAgent\s*\(/, /createResponseEngine\s*\(/, /require\(["'](axios|got|node-fetch|undici|retell-sdk)/, /require\(["']\.\/retell-adapter["']\)/]) {
      assert.ok(!p.test(code), `must not contain ${p}`);
    }
    for (const r of [...src.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])) {
      assert.ok(r.startsWith("./"), `may not import ${r}`);
    }
    // And it compiles with no config at all.
    const r = describeAcquisitionRetellResources();
    assert.ok(r.responseEngine.general_prompt.length > 500);
  });

  it("14. voice remains unresolved and is never invented", () => {
    const r = describeAcquisitionRetellResources();
    assert.strictEqual(r.agent.voice_id, null);
    assert.strictEqual(r.readiness.agent.voiceResolved, false);
    assert.ok(r.readiness.blockers.some((b) => /voice_id is unresolved/i.test(b)));
  });

  it("15. language stays en-AU", () => {
    assert.strictEqual(describeAcquisitionRetellResources().agent.language, "en-AU");
    assert.strictEqual(describeAcquisitionRetellResources().readiness.agent.languageReady, true);
  });

  it("16. webhook stays unresolved, and never borrows another family's", () => {
    const r = describeAcquisitionRetellResources({ config: { webhookBaseUrl: "https://example.test" } });
    assert.strictEqual(r.agent.webhook_url, null, "the receptionist's webhookBaseUrl must not leak in");
    assert.strictEqual(r.readiness.agent.webhookResolved, false);
    // Only an explicitly acquisition webhook may set it.
    const wired = describeAcquisitionRetellResources({ config: { acquisitionWebhookUrl: "https://acq.example.test/webhooks/retell" } });
    assert.strictEqual(wired.readiness.agent.webhookResolved, true);
  });

  it("17. no price is injected", () => {
    const r = describeAcquisitionRetellResources();
    assert.ok(!/\b149\b|\b299\b|A\$/.test(r.responseEngine.general_prompt), "no figure may appear without one being supplied");
    assert.match(r.responseEngine.general_prompt, /Do not quote a number — you have not been given one/i);
  });

  it("18-19. voicemail stays no-message, now enforced by the PROVIDER (E-12A)", () => {
    const { VOICEMAIL_POLICY } = require("../src/services/acquisition-agent-spec");
    assert.strictEqual(VOICEMAIL_POLICY.leaveMessage, false);
    assert.strictEqual(VOICEMAIL_POLICY.template, null);
    const r = describeAcquisitionRetellResources();
    // The E-10C form of this test asserted there was NO voicemail field, which
    // was a true statement of the gap rather than a property worth keeping.
    // E-12A closes the gap, so the assertion is re-pointed at the new truth:
    // exactly one voicemail field, and it hangs up.
    assert.deepStrictEqual(r.agent.voicemail_option, { action: { type: "hangup" } });
    assert.strictEqual(r.readiness.agent.voicemailProviderPolicyConfigured, true);
    // Configured is still not observed, and that distinction is the whole point.
    assert.strictEqual(r.readiness.agent.voicemailProviderBehaviourObserved, false);
    assert.ok(r.readiness.unverifiedAfterCreation.some((u) => /never been observed on a real call/i.test(u)));
    // Checked against field NAMES, not the serialised payload: `reached_human`'s
    // description legitimately says "False for voicemail, silence or a failed
    // connection", and a scan of the whole JSON would have banned describing the
    // concept at all.
    assert.deepStrictEqual(
      Object.keys(r.agent).filter((k) => /voicemail|machine|answering/i.test(k)),
      ["voicemail_option"],
      "one voicemail field, the one we put there"
    );
    assert.ok(!Object.keys(r.responseEngine).some((k) => /voicemail|machine|answering/i.test(k)), "none on the engine either");
    assert.ok(
      !r.agent.post_call_analysis_data.some((f) => /voicemail|machine|answering/i.test(f.name)),
      "and none smuggled in as an analysis field"
    );
  });

  it("readiness is COMPUTED — it can say yes once everything is resolved", () => {
    // A flag that can never be true is one people learn to ignore, so it is
    // derived from the blockers rather than hardcoded.
    const r = describeAcquisitionRetellResources({
      llmId: ACQ_LLM,
      config: { voiceId: "voice_fixture", acquisitionWebhookUrl: "https://acq.example.test/webhooks/retell" },
    });
    // E-10C left ONE blocker standing here — "provider behaviour on an answering
    // machine is unverified" — which could never be cleared before creating an
    // agent, because you need the agent to observe the behaviour. E-12A settles
    // the half that IS settleable in advance (the payload configures a hang-up)
    // and moves the half that is not out of the create gate.
    assert.strictEqual(r.readiness.createAgentReady, true);
    assert.deepStrictEqual([...r.readiness.blockers], []);
    // Moved, not deleted.
    assert.strictEqual(r.readiness.unverifiedAfterCreation.length, 1);
  });

  it("the real world is still NOT create-agent ready — voice and webhook are unresolved", () => {
    // The test above supplies fixtures. With the config this repository actually
    // has, two genuine blockers remain, and E-12A cleared neither of them.
    const r = describeAcquisitionRetellResources({ llmId: ACQ_LLM });
    assert.strictEqual(r.readiness.createAgentReady, false);
    assert.ok(r.readiness.blockers.some((b) => /voice_id is unresolved/i.test(b)));
    assert.ok(r.readiness.blockers.some((b) => /webhook_url is unresolved/i.test(b)));
  });

  it("nothing claims to be provisioned", () => {
    const r = describeAcquisitionRetellResources({ llmId: ACQ_LLM, config: { voiceId: "v" } });
    assert.strictEqual(r.readiness.responseEngine.provisioned, false);
    assert.strictEqual(r.readiness.agent.provisioned, false);
    assert.match(r.readiness.note, /has been sent to any provider/i);
  });

  it("20. the misleading single-payload API is gone, not aliased", () => {
    const mod = require("../src/services/acquisition-agent-spec");
    assert.strictEqual(mod.describeAcquisitionAgentPayload, undefined, "its name promised one payload and returned two resources");
  });
});
