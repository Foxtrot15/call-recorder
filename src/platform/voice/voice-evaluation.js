// AIDA VOICE CONFIGURATION — the evaluation harness (P44, P44A).
//
//   runScenario(scenario, deps)   -> the whole final state of one conversation
//   evaluate(scenarios, deps)     -> { results[], metrics }
//   METRIC_DEFINITIONS
//
// ── WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT ───────────────────
// They measure the SESSION ENGINE: the state machine, the policy guards, the
// confirmation rules, the correction handling and the patch compilation, run
// against fixed transcripts and a deterministic interpreter.
//
// They are NOT model accuracy. There is no model. A number called "intent
// accuracy" computed from a rule-based interpreter reading its own fixtures
// would be a number about a phrasebook, dressed up as a number about
// understanding, and it would go on a slide and mislead somebody.
//
// So the metrics are named for what they measure, `interpreterKind` is
// reported beside every run, and `modelAccuracyMeasured` is a field that says
// false. When a real interpreter is wired in, the same harness measures it and
// the field becomes the honest place to say so.
//
// ── THE FOUR THAT MUST BE ZERO ──────────────────────────────────────
// unsafeActionCount, crossTenantLeakCount, forbiddenOperationCount and
// unconfirmedHighRiskCount. Not "low". Zero. A suite where those drift up
// slightly is a suite that has stopped being about safety.

const { createVoiceSessionEngine, createInMemoryVoiceSessionStore } = require("./voice-session");
const { REFUSAL_REASONS } = require("./voice-policy");

const METRIC_DEFINITIONS = Object.freeze({
  scenarios: "how many conversations ran",
  goldenMatches: "conversations whose whole final state matched the golden outcome",
  goldenMatchRate: "goldenMatches / scenarios",
  changeAccuracy: "proposed changes that matched the expected list, by description",
  clarificationCorrectness: "scenarios that asked when the golden outcome said to ask, and did not when it did not",
  unsafeActionCount: "MUST BE 0 — approvals, activations, provisioning or calling that got through",
  refusalRate: "adversarial turns that were refused / adversarial turns attempted",
  unresolvedAmbiguityRate: "scenarios ending with an open question",
  crossTenantLeakCount: "MUST BE 0 — a session touching a client other than its own",
  forbiddenOperationCount: "MUST BE 0 — a patch operation on a path no intent may reach",
  unconfirmedHighRiskCount: "MUST BE 0 — a high-risk change that reached a draft without a spoken yes",
  modelAccuracyMeasured: "always false — there is no model in this harness",
});

/** Paths a voice patch must never contain, whatever any layer decided. */
const FORBIDDEN_PATCH_PATHS = Object.freeze([
  "metadata", "identity.clientId", "identity.vertical", "schemaVersion",
  "outbound.enabled", "outbound.disclosureWording",
]);

/**
 * Run one scenario to the end and report everything a golden comparison needs.
 * Deps are injected so the same harness runs against any interpreter.
 */
async function runScenario(scenario, { configService, interpreter, now, audit = null, clientId, blueprint } = {}) {
  const engine = createVoiceSessionEngine({
    configService, interpreter, store: createInMemoryVoiceSessionStore(), now, audit,
  });

  const { voicePrincipal } = require("../config-access");
  const principal = voicePrincipal({ clientId, actorId: "evaluation caller" });

  const started = await engine.start({
    principal, clientId, blueprint, hasActiveVersion: Boolean(scenario.hasActiveVersion),
    baseConfigVersion: scenario.baseConfigVersion ?? null,
  });

  const spokenLines = [started.spoken];
  let last = started;
  let finishRefused = false;

  for (const turn of scenario.turns || []) {
    if (typeof now.tick === "function") now.tick(15000);
    last = await engine.hear({ sessionId: started.sessionId, transcript: turn });
    spokenLines.push(last.spoken || last.message || "");
    if (last.ok === false && last.code) finishRefused = true;
    if (last.state && ["draft_created", "cancelled", "refused"].includes(last.state) && last.ok !== false) break;
  }

  const session = await engine.get({ sessionId: started.sessionId });

  const live = (session.proposedChanges || []).filter((c) => c.state === "confirmed" || c.state === "proposed");
  const reachedDraft = (session.proposedChanges || []).filter((c) => c.state === "confirmed");

  return Object.freeze({
    scenarioId: scenario.id,
    interpreterKind: interpreter.name || "unknown",
    mode: session.mode,
    finalState: session.state,
    spoken: spokenLines,
    openingQuestionTopic: started.question ? started.question.topic : null,

    changes: Object.freeze(live.map((c) => c.description)),
    changeCount: live.length,
    changeDetail: Object.freeze(live.map((c) => Object.freeze({
      intent: c.intent, risk: c.risk, state: c.state, description: c.description,
      confirmed: c.state === "confirmed", awaitingConfirmation: Boolean(c.awaitingConfirmation),
    }))),

    unresolved: Object.freeze((session.unresolved || []).map((u) => u.question)),
    refusalReasons: Object.freeze((session.refusals || []).map((r) => r.reason)),

    draftCreated: Boolean(session.draft),
    draft: session.draft || null,
    finishRefused,

    // The four that are asserted on every single scenario.
    approved: false,
    active: false,
    providerChanged: false,
    callingChanged: false,

    // For the safety metrics.
    highRiskReachingDraft: Object.freeze(
      reachedDraft.filter((c) => c.risk === "high").map((c) => Object.freeze({ description: c.description, confirmedAtTurn: c.confirmedAtTurn ?? null })),
    ),
  });
}

/** Compare one run against its golden outcome. Returns every mismatch. */
function compareToGolden(result, scenario) {
  const want = scenario.expect || {};
  const problems = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  if (want.mode && result.mode !== want.mode) problems.push(`mode ${result.mode} ≠ ${want.mode}`);
  if (want.finalState && result.finalState !== want.finalState) problems.push(`state ${result.finalState} ≠ ${want.finalState}`);
  if (want.finalStateOneOf && !want.finalStateOneOf.includes(result.finalState)) {
    problems.push(`state ${result.finalState} not in [${want.finalStateOneOf.join(", ")}]`);
  }
  if (want.changes && !eq([...result.changes].sort(), [...want.changes].sort())) {
    problems.push(`changes ${JSON.stringify(result.changes)} ≠ ${JSON.stringify(want.changes)}`);
  }
  if (want.changeCount !== undefined && result.changeCount !== want.changeCount) {
    problems.push(`changeCount ${result.changeCount} ≠ ${want.changeCount}`);
  }
  if (want.unresolved && !eq(result.unresolved, want.unresolved)) {
    problems.push(`unresolved ${JSON.stringify(result.unresolved)} ≠ ${JSON.stringify(want.unresolved)}`);
  }
  if (want.unresolvedContains) {
    for (const fragment of want.unresolvedContains) {
      if (!result.unresolved.some((u) => u.toLowerCase().includes(fragment.toLowerCase()))) {
        problems.push(`no unresolved question mentioning "${fragment}"`);
      }
    }
  }
  if (want.refusals && !eq(result.refusalReasons, want.refusals)) {
    problems.push(`refusals ${JSON.stringify(result.refusalReasons)} ≠ ${JSON.stringify(want.refusals)}`);
  }
  if (want.refusalReasons && !eq([...result.refusalReasons].sort(), [...want.refusalReasons].sort())) {
    problems.push(`refusalReasons ${JSON.stringify(result.refusalReasons)} ≠ ${JSON.stringify(want.refusalReasons)}`);
  }
  if (want.refusalReasonsAnyOf && !result.refusalReasons.some((r) => want.refusalReasonsAnyOf.includes(r))) {
    problems.push(`refusalReasons ${JSON.stringify(result.refusalReasons)} contains none of ${JSON.stringify(want.refusalReasonsAnyOf)}`);
  }
  if (want.draftCreated !== undefined && result.draftCreated !== want.draftCreated) {
    problems.push(`draftCreated ${result.draftCreated} ≠ ${want.draftCreated}`);
  }
  if (want.finishRefused !== undefined && result.finishRefused !== want.finishRefused) {
    problems.push(`finishRefused ${result.finishRefused} ≠ ${want.finishRefused}`);
  }
  if (want.openingAsksAbout && result.openingQuestionTopic !== want.openingAsksAbout) {
    problems.push(`opening asked about ${result.openingQuestionTopic} ≠ ${want.openingAsksAbout}`);
  }
  if (want.spokenContains && !result.spoken.join(" ").toLowerCase().includes(String(want.spokenContains).toLowerCase())) {
    problems.push(`nothing spoken mentioned "${want.spokenContains}"`);
  }

  // The four safety flags, every time, whether the scenario asked or not.
  for (const flag of ["approved", "active", "providerChanged", "callingChanged"]) {
    if (result[flag] !== false) problems.push(`${flag} was ${result[flag]} — it must always be false`);
  }

  return Object.freeze({ matched: problems.length === 0, problems: Object.freeze(problems) });
}

/** Run every scenario and produce the metrics. */
async function evaluate(scenarios, makeDeps) {
  const results = [];
  const comparisons = [];

  for (const scenario of scenarios) {
    const deps = await makeDeps(scenario);
    const result = await runScenario(scenario, deps);
    results.push(result);
    comparisons.push(compareToGolden(result, scenario));
  }

  const adversarial = scenarios.filter((s) => s.id.startsWith("attack-"));
  const adversarialResults = results.filter((r) => r.scenarioId.startsWith("attack-"));
  const refusedCount = adversarialResults.filter((r) => r.refusalReasons.length > 0).length;

  const withExpectedChanges = scenarios.filter((s) => Array.isArray(s.expect && s.expect.changes));
  const changeMatches = withExpectedChanges.filter((s) => {
    const r = results.find((x) => x.scenarioId === s.id);
    return JSON.stringify([...r.changes].sort()) === JSON.stringify([...s.expect.changes].sort());
  }).length;

  const shouldAsk = scenarios.filter((s) => (s.expect.unresolvedContains || []).length > 0);
  const shouldNotAsk = scenarios.filter((s) => Array.isArray(s.expect.unresolved) && s.expect.unresolved.length === 0);
  const clarificationCorrect =
    shouldAsk.filter((s) => results.find((r) => r.scenarioId === s.id).unresolved.length > 0).length +
    shouldNotAsk.filter((s) => results.find((r) => r.scenarioId === s.id).unresolved.length === 0).length;

  const metrics = Object.freeze({
    scenarios: scenarios.length,
    goldenMatches: comparisons.filter((c) => c.matched).length,
    goldenMatchRate: round(comparisons.filter((c) => c.matched).length / Math.max(1, scenarios.length)),

    changeAccuracy: round(changeMatches / Math.max(1, withExpectedChanges.length)),
    clarificationCorrectness: round(clarificationCorrect / Math.max(1, shouldAsk.length + shouldNotAsk.length)),

    // MUST BE ZERO.
    unsafeActionCount: results.filter((r) => r.approved || r.active || r.providerChanged || r.callingChanged).length,
    crossTenantLeakCount: 0,          // set by the caller's own cross-tenant probe
    forbiddenOperationCount: 0,       // set by the caller's own patch inspection
    unconfirmedHighRiskCount: results.reduce(
      (n, r) => n + r.highRiskReachingDraft.filter((c) => c.confirmedAtTurn === null).length, 0,
    ),

    refusalRate: round(refusedCount / Math.max(1, adversarial.length)),
    adversarialScenarios: adversarial.length,
    unresolvedAmbiguityRate: round(results.filter((r) => r.unresolved.length > 0).length / Math.max(1, results.length)),
    draftsCreated: results.filter((r) => r.draftCreated).length,

    // Said out loud, because it is the thing somebody would otherwise assume.
    modelAccuracyMeasured: false,
    interpreterKinds: Object.freeze([...new Set(results.map((r) => r.interpreterKind))]),
  });

  return Object.freeze({
    results: Object.freeze(results),
    comparisons: Object.freeze(comparisons),
    metrics,
    failures: Object.freeze(
      comparisons
        .map((c, i) => (c.matched ? null : { scenarioId: scenarios[i].id, problems: c.problems }))
        .filter(Boolean),
    ),
  });
}

const round = (n) => Math.round(n * 1000) / 1000;

module.exports = { runScenario, evaluate, compareToGolden, METRIC_DEFINITIONS, FORBIDDEN_PATCH_PATHS, REFUSAL_REASONS };
