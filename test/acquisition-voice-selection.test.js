// LOCKSMITH ACQUISITION E-12B — the founder chose a voice, and it must not be
// the receptionist's by inheritance.
//
// ── THE TRAP THIS EXISTS TO AVOID ───────────────────────────────────
// The founder auditioned the catalogue and chose "Sunny - Australian Female".
// The shared `RETELL_DEFAULT_VOICE_ID` currently holds that same voice — which
// is exactly why acquisition must not read it. If it did, the two products
// would be wired together by accident, and the day somebody re-voices the
// receptionist they would silently re-voice every cold call to a stranger, with
// no test failing and nobody having decided it.
//
// The same voice may be chosen for both. It has to be a coincidence somebody
// typed twice, not an inheritance.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────
// An unset acquisition key yields null, keeps createAgentReady false and names
// the blocker. It never falls back to another product's voice.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveAcquisitionVoiceId,
  getAcquisitionRetellConfig,
} = require("../src/config/acquisition");

const {
  buildAcquisitionAgent,
  describeAcquisitionRetellResources,
  describeResponseEngineDrift,
  SELECTED_VOICE,
  PROVISIONED_RESPONSE_ENGINE,
} = require("../src/services/acquisition-agent-spec");

// The founder's selection. Used as a fixture here; the real value lives in the
// environment, which is why it is not hardcoded in src/.
const SUNNY = "custom_voice_018b4225b718ffc38a2e1da4d4";
const RECEPTIONIST_VOICE = "custom_voice_receptionist_fixture_9999";

// ---------------------------------------------------------------------------
// 1. THE SELECTION RESOLVES
// ---------------------------------------------------------------------------

describe("E-12B: the acquisition voice comes from an acquisition-only key", () => {
  it("1. the selected voice resolves from RETELL_ACQUISITION_VOICE_ID", () => {
    assert.strictEqual(resolveAcquisitionVoiceId({ RETELL_ACQUISITION_VOICE_ID: SUNNY }), SUNNY);
    assert.strictEqual(getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY }).voiceId, SUNNY);
  });

  it("2. agent.voice_id resolves to exactly the selected voice", () => {
    const config = getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY });
    const agent = buildAcquisitionAgent({ config, llmId: "llm_fixture_0001" });
    assert.strictEqual(agent.voice_id, SUNNY);
  });

  it("2b. the decision is recorded in source, but the id is not", () => {
    assert.strictEqual(SELECTED_VOICE.voiceName, "Sunny - Australian Female");
    assert.strictEqual(SELECTED_VOICE.envVar, "RETELL_ACQUISITION_VOICE_ID");
    assert.strictEqual(SELECTED_VOICE.selectedBy, "founder");
    // A dev-account resource id must not be baked into source that every
    // environment shares.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-agent-spec.js"), "utf8");
    assert.ok(!src.includes(SUNNY), "the voice id belongs in the environment, not in git");
    const cfg = fs.readFileSync(path.join(__dirname, "..", "src", "config", "acquisition.js"), "utf8");
    assert.ok(!cfg.includes(SUNNY), "nor in the config module");
  });

  it("2c. the accent claim is recorded as an audition, not as metadata", () => {
    // Retell returned no accent/gender/age for this voice. Saying otherwise
    // would be inventing provider evidence.
    assert.match(SELECTED_VOICE.accentEvidence, /audition/i);
    assert.match(SELECTED_VOICE.accentEvidence, /no accent metadata/i);
  });
});

// ---------------------------------------------------------------------------
// 3-4. THE SHARED DEFAULTS CANNOT SUBSTITUTE
// ---------------------------------------------------------------------------

describe("E-12B: receptionist and onboarding defaults are not the acquisition authority", () => {
  it("3. RETELL_DEFAULT_VOICE_ID alone does NOT give acquisition a voice", () => {
    const env = { RETELL_DEFAULT_VOICE_ID: RECEPTIONIST_VOICE };
    assert.strictEqual(resolveAcquisitionVoiceId(env), null, "no fallback — that would be inheritance");
    assert.strictEqual(getAcquisitionRetellConfig(env).voiceId, null);
    const agent = buildAcquisitionAgent({ config: getAcquisitionRetellConfig(env), llmId: "llm_fixture_0001" });
    assert.strictEqual(agent.voice_id, null, "acquisition stays voiceless rather than borrowing one");
  });

  it("4. the receptionist default cannot override an explicit acquisition choice", () => {
    const env = { RETELL_ACQUISITION_VOICE_ID: SUNNY, RETELL_DEFAULT_VOICE_ID: RECEPTIONIST_VOICE };
    assert.strictEqual(resolveAcquisitionVoiceId(env), SUNNY);
    const agent = buildAcquisitionAgent({ config: getAcquisitionRetellConfig(env), llmId: "llm_fixture_0001" });
    assert.strictEqual(agent.voice_id, SUNNY);
    assert.notStrictEqual(agent.voice_id, RECEPTIONIST_VOICE);
  });

  it("4b. the same voice in both keys is a coincidence, not a link", () => {
    // Today they genuinely do hold the same value. Prove acquisition read ITS
    // key by removing the shared one and watching nothing change.
    const both = { RETELL_ACQUISITION_VOICE_ID: SUNNY, RETELL_DEFAULT_VOICE_ID: SUNNY };
    const acquisitionOnly = { RETELL_ACQUISITION_VOICE_ID: SUNNY };
    assert.strictEqual(resolveAcquisitionVoiceId(both), resolveAcquisitionVoiceId(acquisitionOnly));
  });

  it("4c. no onboarding or receptionist key is read by the acquisition resolver", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "config", "acquisition.js"), "utf8");
    for (const foreign of ["RETELL_DEFAULT_VOICE_ID", "defaultVoiceId", "ONBOARDING_VOICE", "receptionist"]) {
      assert.ok(!new RegExp(`env\\.${foreign}|\\|\\|\\s*env\\.${foreign}`).test(src), `must not read ${foreign}`);
    }
    // Named in prose is fine — explaining why it is NOT read is the point.
    assert.match(src, /RETELL_DEFAULT_VOICE_ID/, "and the reasoning is written down");
  });

  it("4d. the acquisition webhook url is likewise its own key", () => {
    const env = { RETELL_WEBHOOK_URL: "https://onboarding.example.test/hook" };
    assert.strictEqual(getAcquisitionRetellConfig(env).acquisitionWebhookUrl, null, "never another family's webhook");
  });
});

// ---------------------------------------------------------------------------
// 5-6. READINESS MOVES CORRECTLY, AND ONLY FOR THE VOICE
// ---------------------------------------------------------------------------

describe("E-12B: readiness reflects the selection honestly", () => {
  it("5. a missing acquisition voice is fail-closed and named as a blocker", () => {
    const r = describeAcquisitionRetellResources({ config: getAcquisitionRetellConfig({}), llmId: "llm_fixture_0001" });
    assert.strictEqual(r.readiness.agent.voiceResolved, false);
    assert.strictEqual(r.readiness.createAgentReady, false);
    const voiceBlocker = r.readiness.blockers.find((b) => /voice_id is unresolved/i.test(b));
    assert.ok(voiceBlocker, "the blocker must exist");
    // And it must tell a human what to do about it.
    assert.match(voiceBlocker, /RETELL_ACQUISITION_VOICE_ID/);
    assert.match(voiceBlocker, /Sunny/);
  });

  it("6. supplying the selected voice removes the VOICE blocker", () => {
    const r = describeAcquisitionRetellResources({
      config: getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY }),
      llmId: "llm_fixture_0001",
    });
    assert.strictEqual(r.readiness.agent.voiceResolved, true);
    assert.ok(!r.readiness.blockers.some((b) => /voice_id/i.test(b)), "voice is no longer a blocker");
  });

  it("6b. but the webhook blocker survives — voice was not the only one", () => {
    const r = describeAcquisitionRetellResources({
      config: getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY }),
      llmId: "llm_fixture_0001",
    });
    assert.strictEqual(r.readiness.createAgentReady, false);
    assert.deepStrictEqual(
      [...r.readiness.blockers],
      ["webhook_url is unresolved — the acquisition route is not exposed"]
    );
  });

  it("6c. with voice AND webhook resolved it is create-ready, and still not created", () => {
    const r = describeAcquisitionRetellResources({
      config: getAcquisitionRetellConfig({
        RETELL_ACQUISITION_VOICE_ID: SUNNY,
        RETELL_ACQUISITION_WEBHOOK_URL: "https://acq.example.test/webhooks/retell/acquisition",
      }),
      llmId: "llm_fixture_0001",
    });
    assert.strictEqual(r.readiness.createAgentReady, true);
    assert.strictEqual(r.readiness.agent.provisioned, false, "ready is not the same as done");
    // Live voicemail behaviour is still unobserved, and still reported.
    assert.strictEqual(r.readiness.unverifiedAfterCreation.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 7. THE RESPONSE ENGINE IS UNAFFECTED
// ---------------------------------------------------------------------------

describe("E-12B: choosing a voice does not touch the provisioned engine", () => {
  it("7. the drift pin is still green with the voice selected", () => {
    const r = describeAcquisitionRetellResources({
      config: getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY }),
      llmId: "llm_fixture_0001",
    });
    assert.strictEqual(describeResponseEngineDrift(r.responseEngine).drifted, false);
    assert.strictEqual(describeResponseEngineDrift().actual, PROVISIONED_RESPONSE_ENGINE.payloadHash);
  });

  it("7b. no response-engine update is required merely to select a voice", () => {
    // voice_id is an AGENT field. If this ever fails, selecting a voice would
    // mean re-provisioning the engine, which would be a genuine design problem.
    const withVoice = describeAcquisitionRetellResources({
      config: getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY }),
    }).responseEngine;
    const without = describeAcquisitionRetellResources().responseEngine;
    assert.deepStrictEqual(withVoice, without);
    assert.ok(!("voice_id" in withVoice), "the engine has never carried a voice");
  });

  it("7c. the voicemail hang-up survived the voice selection", () => {
    const agent = buildAcquisitionAgent({
      config: getAcquisitionRetellConfig({ RETELL_ACQUISITION_VOICE_ID: SUNNY }),
      llmId: "llm_fixture_0001",
    });
    assert.deepStrictEqual(agent.voicemail_option, { action: { type: "hangup" } });
  });
});
