// AIDA VOICE CONFIGURATION P44 — the evaluation harness, run for real.
//
// Every transcript in test/fixtures/voice-transcripts.js is played through the
// real session engine against the real configuration service, and its WHOLE
// final state is compared with its golden outcome.
//
// The four flags — approved, active, providerChanged, callingChanged — are
// asserted on every scenario, not once globally, so a scenario that stopped
// checking them fails rather than passing quietly.

const { describe, it, before } = require("node:test");
const assert = require("node:assert");

const { SCENARIOS } = require("./fixtures/voice-transcripts");
const { evaluate, runScenario, compareToGolden, METRIC_DEFINITIONS } = require("../src/platform/voice/voice-evaluation");
const { createDeterministicInterpreter } = require("../src/platform/voice/voice-interpreter-port");
const { clock, buildPlatform, activate, seedDraft } = require("./helpers/voice-harness");

/** Each scenario gets its own platform, so one cannot contaminate the next. */
async function depsFor(scenario) {
  const now = clock();
  const platform = buildPlatform({ now });
  const blueprintFor = typeof scenario.blueprint === "function" ? scenario.blueprint() : scenario.blueprint;

  const blueprint = scenario.hasActiveVersion
    ? await activate(platform.configService, scenario.clientId, blueprintFor)
    : await seedDraft(platform.configService, scenario.clientId, blueprintFor);

  return {
    configService: platform.configService,
    audit: platform.voiceAudit,
    interpreter: createDeterministicInterpreter(),
    now,
    clientId: scenario.clientId,
    blueprint,
  };
}

let EVALUATION;

before(async () => {
  EVALUATION = await evaluate(SCENARIOS, depsFor);
});

describe("P44 evaluation — every golden transcript", () => {
  it("has scenarios covering all four required families", () => {
    const ids = SCENARIOS.map((s) => s.id);
    assert.ok(ids.some((i) => i.startsWith("locksmith-")), "no locksmith scenarios");
    assert.ok(ids.some((i) => i.startsWith("plumber-")), "no plumber scenarios");
    assert.ok(ids.some((i) => i.startsWith("garage-")), "no garage door scenarios");
    assert.ok(ids.filter((i) => i.startsWith("attack-")).length >= 12, "too few adversarial scenarios");
    assert.ok(SCENARIOS.length >= 30, `only ${SCENARIOS.length} scenarios`);
    assert.equal(new Set(ids).size, ids.length, "duplicate scenario id");
  });

  // One test per scenario, so a failure names the conversation that broke.
  for (const scenario of SCENARIOS) {
    it(`${scenario.id} — ${scenario.title}`, async () => {
      const result = await runScenario(scenario, await depsFor(scenario));
      const comparison = compareToGolden(result, scenario);
      assert.ok(
        comparison.matched,
        `${scenario.id} deviated from its golden outcome:\n  - ${comparison.problems.join("\n  - ")}\n` +
        `  spoken:\n${result.spoken.map((s) => `      ${String(s).split("\n")[0]}`).join("\n")}`,
      );
    });
  }
});

describe("P44A metrics — the four that must be zero, and the ones that must not be dressed up", () => {
  it("matched every golden outcome", () => {
    assert.deepEqual(EVALUATION.failures, [], `${EVALUATION.failures.length} scenario(s) deviated`);
    assert.equal(EVALUATION.metrics.goldenMatchRate, 1);
  });

  it("performed ZERO unsafe actions across every conversation", () => {
    assert.equal(EVALUATION.metrics.unsafeActionCount, 0);
    for (const r of EVALUATION.results) {
      assert.equal(r.approved, false, `${r.scenarioId} approved something`);
      assert.equal(r.active, false, `${r.scenarioId} activated something`);
      assert.equal(r.providerChanged, false, `${r.scenarioId} changed a provider`);
      assert.equal(r.callingChanged, false, `${r.scenarioId} changed calling state`);
    }
  });

  it("let ZERO high-risk change reach a draft without a spoken confirmation", () => {
    assert.equal(EVALUATION.metrics.unconfirmedHighRiskCount, 0);
    for (const r of EVALUATION.results) {
      for (const c of r.highRiskReachingDraft) {
        assert.notEqual(c.confirmedAtTurn, null, `${r.scenarioId}: "${c.description}" reached a draft unconfirmed`);
      }
    }
  });

  it("refused every adversarial scenario", () => {
    assert.equal(EVALUATION.metrics.refusalRate, 1, "an attack was not refused");
    assert.ok(EVALUATION.metrics.adversarialScenarios >= 12);
    for (const r of EVALUATION.results.filter((x) => x.scenarioId.startsWith("attack-"))) {
      assert.ok(r.refusalReasons.length > 0, `${r.scenarioId} was not refused`);
      // A draft is judged against the scenario's own golden, not banned
      // outright. One attack scenario deliberately continues into a legitimate
      // change afterwards, because a refusal that silently ends the call is its
      // own failure — the caller rang about their Saturday hours.
      const scenario = SCENARIOS.find((s) => s.id === r.scenarioId);
      assert.equal(r.draftCreated, scenario.expect.draftCreated,
        `${r.scenarioId}: draftCreated ${r.draftCreated}, golden says ${scenario.expect.draftCreated}`);
    }

    // And the attack itself never contributed a change to that draft.
    const mixed = EVALUATION.results.find((r) => r.scenarioId === "attack-then-legitimate");
    assert.equal(mixed.draftCreated, true, "the mixed scenario must reach a draft, or it proves nothing");
    assert.deepEqual(mixed.changes, ["Saturday hours become 08:00-16:00"],
      "the refused request must not have become a change");
  });

  it("reports change accuracy and clarification correctness at 1", () => {
    assert.equal(EVALUATION.metrics.changeAccuracy, 1);
    assert.equal(EVALUATION.metrics.clarificationCorrectness, 1);
  });

  it("says out loud that it measures no model", () => {
    // The metric that stops the rest of them being misread. There is no model
    // in this harness, and a number called "accuracy" on a slide would imply
    // otherwise.
    assert.equal(EVALUATION.metrics.modelAccuracyMeasured, false);
    assert.deepEqual(EVALUATION.metrics.interpreterKinds, ["deterministic"]);
    assert.match(METRIC_DEFINITIONS.modelAccuracyMeasured, /no model/i);
    assert.match(METRIC_DEFINITIONS.unsafeActionCount, /MUST BE 0/);
  });

  it("created a draft in every scenario whose golden outcome says so, and no other", () => {
    for (const scenario of SCENARIOS) {
      if (scenario.expect.draftCreated === undefined) continue;
      const r = EVALUATION.results.find((x) => x.scenarioId === scenario.id);
      assert.equal(r.draftCreated, scenario.expect.draftCreated, scenario.id);
    }
    assert.ok(EVALUATION.metrics.draftsCreated > 0, "no scenario produced a draft — the harness proves nothing");
  });

  it("would CATCH a scenario that quietly approved something", () => {
    // The bad fixture for the most important metric in the file.
    const tampered = { ...EVALUATION.results[0], approved: true };
    const comparison = compareToGolden(tampered, { expect: {} });
    assert.equal(comparison.matched, false);
    assert.ok(comparison.problems.some((p) => /approved was true/.test(p)));
  });

  it("would CATCH a change list that silently drifted", () => {
    const scenario = SCENARIOS.find((s) => s.id === "locksmith-saturday-hours");
    const result = EVALUATION.results.find((r) => r.scenarioId === scenario.id);
    const drifted = { ...result, changes: ["Saturday hours become 08:00-17:00"] };
    const comparison = compareToGolden(drifted, scenario);
    assert.equal(comparison.matched, false);
    assert.ok(comparison.problems.some((p) => p.startsWith("changes ")));
  });
});
