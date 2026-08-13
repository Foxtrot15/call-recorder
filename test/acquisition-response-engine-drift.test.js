// LOCKSMITH ACQUISITION E-12B — the response engine exists remotely, so the
// local copy is no longer just a document.
//
// ── WHAT THIS GUARDS ────────────────────────────────────────────────
// E-10D(i) created a real Retell response engine from this repository's
// `buildAcquisitionResponseEngine()`. From that moment the prompt stopped being
// a local artefact: `llm_111ed…` runs the text it was given, and editing
// `general_prompt` here changes nothing about it. Nothing would fail. The
// repository would simply begin describing behaviour the live engine does not
// have, and the first place anyone would find out is a telephone call to a
// stranger.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────
// Not a freeze on the copy. The opening is meant to stay tunable — E-10A
// deliberately avoided pinning it to an exact string so a comma could be moved
// for speech. This pins the payload that was SENT, so that changing it becomes
// an explicit decision about a remote resource instead of a silent divergence.
// A founder-approved rewording stays a two-line change: edit the copy, re-pin
// the hash in the same commit, and update the engine.
//
// ── WHY A HASH ──────────────────────────────────────────────────────
// A second copy of a 5,373-character prompt in the test tree would be updated in
// lockstep by anyone using find-and-replace — precisely the person this exists
// to stop.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  buildAcquisitionResponseEngine,
  buildAcquisitionAgent,
  describeAcquisitionRetellResources,
  responseEnginePayloadHash,
  describeResponseEngineDrift,
  PROVISIONED_RESPONSE_ENGINE,
  RESPONSE_ENGINE_DRIFT_MESSAGE,
} = require("../src/services/acquisition-agent-spec");

const { payloadHash, stableStringify } = require("../src/services/voice-platform-port");

// ---------------------------------------------------------------------------
// 1. THE PIN ITSELF
// ---------------------------------------------------------------------------

describe("E-12B: the provisioned response engine is pinned", () => {
  it("1. the current local payload matches the provisioned engine", () => {
    const drift = describeResponseEngineDrift();
    assert.strictEqual(
      drift.drifted,
      false,
      `${RESPONSE_ENGINE_DRIFT_MESSAGE}\n\nexpected ${drift.expected}\nactual   ${drift.actual}`
    );
    assert.strictEqual(drift.actual, PROVISIONED_RESPONSE_ENGINE.payloadHash);
    assert.strictEqual(drift.message, null);
  });

  it("1b. the pinned hash is the one E-10D(i) actually sent", () => {
    // The provisioning script sent `describeAcquisitionRetellResources().responseEngine`
    // with no arguments — fully deterministic, no environment input — which is
    // why this is reproducible at all.
    const sent = describeAcquisitionRetellResources().responseEngine;
    assert.strictEqual(payloadHash(sent), PROVISIONED_RESPONSE_ENGINE.payloadHash);
    assert.strictEqual(PROVISIONED_RESPONSE_ENGINE.payloadHash, "b0b5e21e3fcf7bcd7db9bacc577250689f5096a8705b9dd0d3b4ac18115e0542");
  });

  it("1c. uses the repository's existing canonical hashing, not a new one", () => {
    const engine = buildAcquisitionResponseEngine();
    assert.strictEqual(responseEnginePayloadHash(engine), payloadHash(engine));
    // Key order must not matter, or a harmless refactor would read as drift.
    const reordered = {
      general_tools: engine.general_tools,
      general_prompt: engine.general_prompt,
      default_dynamic_variables: engine.default_dynamic_variables,
      begin_message: engine.begin_message,
    };
    assert.strictEqual(payloadHash(reordered), PROVISIONED_RESPONSE_ENGINE.payloadHash, "sorted-key canonical form");
    assert.notStrictEqual(JSON.stringify(reordered), stableStringify(engine), "sanity: the orders really do differ");
  });

  it("1d. the pin records what a human needs to act on it", () => {
    assert.strictEqual(PROVISIONED_RESPONSE_ENGINE.provisionedByMilestone, "E-10D(i)");
    assert.strictEqual(PROVISIONED_RESPONSE_ENGINE.provisionedFromCommit, "d591262");
    assert.strictEqual(PROVISIONED_RESPONSE_ENGINE.remoteVersionAtCreation, 0);
    assert.deepStrictEqual(
      [...PROVISIONED_RESPONSE_ENGINE.fields].sort(),
      ["begin_message", "default_dynamic_variables", "general_prompt", "general_tools"]
    );
    // The llm_id is deployment config and must not be committed.
    assert.strictEqual(PROVISIONED_RESPONSE_ENGINE.llmIdEnvVar, "RETELL_ACQUISITION_LLM_ID");
    assert.ok(!/llm_[0-9a-f]{8,}/.test(JSON.stringify(PROVISIONED_RESPONSE_ENGINE)), "no llm_id in tracked source");
  });

  it("1e. the failure message tells you what to do, not just that it broke", () => {
    assert.match(RESPONSE_ENGINE_DRIFT_MESSAGE, /ALREADY BEEN PROVISIONED/i);
    assert.match(RESPONSE_ENGINE_DRIFT_MESSAGE, /revert/i);
    assert.match(RESPONSE_ENGINE_DRIFT_MESSAGE, /re-pin|re-provision/i);
  });
});

// ---------------------------------------------------------------------------
// 2-4. IT HAS TEETH — each engine field must move the hash
// ---------------------------------------------------------------------------

describe("E-12B: changing the engine payload is detected", () => {
  const engine = buildAcquisitionResponseEngine();

  // Mutating COPIES only. The real payload is frozen and never touched here,
  // so the current opening survives this file intact — asserted at the end.
  const mutated = (patch) => ({ ...engine, ...patch });

  it("2. changing begin_message fails", () => {
    const d = describeResponseEngineDrift(mutated({ begin_message: engine.begin_message + " Cheers." }));
    assert.strictEqual(d.drifted, true);
    assert.match(d.message, /ALREADY BEEN PROVISIONED/i);
  });

  it("2b. even a single character in begin_message fails", () => {
    // A comma moved "for speech" is exactly the edit that would otherwise slip.
    const d = describeResponseEngineDrift(mutated({ begin_message: engine.begin_message.replace(".", ",") }));
    assert.strictEqual(d.drifted, true);
  });

  it("3. changing general_prompt fails", () => {
    const d = describeResponseEngineDrift(mutated({ general_prompt: engine.general_prompt + "\nBe brief." }));
    assert.strictEqual(d.drifted, true);
  });

  it("4. changing default_dynamic_variables fails", () => {
    const added = describeResponseEngineDrift(
      mutated({ default_dynamic_variables: { ...engine.default_dynamic_variables, suburb: "" } })
    );
    assert.strictEqual(added.drifted, true, "a new variable changes what the engine can say");

    const valued = describeResponseEngineDrift(
      mutated({ default_dynamic_variables: { ...engine.default_dynamic_variables, business_name: "Fixture" } })
    );
    assert.strictEqual(valued.drifted, true, "a non-empty default is a placeholder somebody would say aloud");
  });

  it("4b. adding a tool fails — a tool is a capability nobody approved", () => {
    const d = describeResponseEngineDrift(mutated({ general_tools: [{ type: "custom", name: "book_job" }] }));
    assert.strictEqual(d.drifted, true);
  });

  it("4c. removing a field entirely fails", () => {
    const { begin_message, ...without } = engine;
    assert.strictEqual(describeResponseEngineDrift(without).drifted, true);
  });
});

// ---------------------------------------------------------------------------
// 5-6. IT IS SCOPED — agent-only fields must NOT move the engine hash
// ---------------------------------------------------------------------------

describe("E-12B: agent fields are a different resource and do not move this hash", () => {
  it("5. choosing a voice_id does not affect the engine hash", () => {
    // The whole point of E-12B is that resolving the voice — the very next
    // milestone — must not read as prompt drift.
    const before = describeAcquisitionRetellResources();
    const after = describeAcquisitionRetellResources({ config: { voiceId: "11labs-Aussie-Fixture" } });
    assert.notStrictEqual(after.agent.voice_id, before.agent.voice_id, "sanity: the voice really did change");
    assert.strictEqual(payloadHash(after.responseEngine), PROVISIONED_RESPONSE_ENGINE.payloadHash);
    assert.strictEqual(describeResponseEngineDrift(after.responseEngine).drifted, false);
  });

  it("6. setting the agent webhook_url does not affect the engine hash", () => {
    const after = describeAcquisitionRetellResources({
      config: { acquisitionWebhookUrl: "https://acq.example.test/webhooks/retell/acquisition" },
    });
    assert.ok(after.agent.webhook_url, "sanity: the webhook really was set");
    assert.strictEqual(describeResponseEngineDrift(after.responseEngine).drifted, false);
  });

  it("6b. supplying the llm_id does not affect the engine hash", () => {
    const after = describeAcquisitionRetellResources({ llmId: "llm_fixture_0001" });
    assert.strictEqual(after.agent.response_engine.llm_id, "llm_fixture_0001");
    assert.strictEqual(describeResponseEngineDrift(after.responseEngine).drifted, false);
  });

  it("6c. the E-12A voicemail policy lives on the agent and does not move it", () => {
    const agent = buildAcquisitionAgent({ llmId: "llm_fixture_0001" });
    assert.strictEqual(agent.voicemail_option.action.type, "hangup", "sanity: it is still there");
    assert.ok(!("voicemail_option" in buildAcquisitionResponseEngine()), "and not on the engine");
    assert.strictEqual(describeResponseEngineDrift().drifted, false);
  });
});

// ---------------------------------------------------------------------------
// 7. NOTHING HERE ALTERED THE REAL PAYLOAD
// ---------------------------------------------------------------------------

describe("E-12B: the opening survived this file", () => {
  it("7. restoring / re-reading the engine still passes", () => {
    // Every mutation above was made on a copy. If any of them had touched the
    // real object, this would fail — which is the point of asserting it last.
    const fresh = buildAcquisitionResponseEngine();
    assert.strictEqual(payloadHash(fresh), PROVISIONED_RESPONSE_ENGINE.payloadHash);
    assert.strictEqual(describeResponseEngineDrift(fresh).drifted, false);
    assert.strictEqual(fresh.general_prompt.length, 5373, "the provisioned prompt, unchanged");
    assert.ok(Object.isFrozen(fresh), "frozen, which is why the mutations had to be copies");
  });

  it("7b. no Retell request is needed to evaluate any of this", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const text = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-spec.js"), "utf8");
    assert.ok(!/fetch\(|axios|node-fetch|require\(["']https?["']\)/.test(text), "the pin is computed locally");
    assert.ok(!/retell-adapter/.test(text), "and the spec still imports nothing that can reach Retell");
  });
});
