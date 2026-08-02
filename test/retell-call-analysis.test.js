// AIDA — M7E: Retell post-call analysis retrieval and validation.
//
// M7D configured post_call_analysis_data on the sandbox agent but never
// retrieved a result. These tests establish what happens when one arrives —
// including the case that matters most: that a provider's analysis cannot
// change anything AIDA owns.
//
// NO TEST HERE CONTACTS RETELL.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const analysis = require("../src/services/retell-call-analysis");
const F = require("./fixtures/retell-call-responses");

const S = analysis.ANALYSIS_STATES;

// ── Readiness ───────────────────────────────────────────────────────

describe("analysis readiness", () => {
  test("ready when call_analysis carries documented fields", () => {
    const r = analysis.classifyAnalysisReadiness(F.analysisReady);
    assert.equal(r.state, S.ready);
    assert.equal(r.hasCustomData, true);
    assert.ok(r.fieldsPresent.includes("call_summary"));
    assert.ok(r.fieldsPresent.includes("user_sentiment"));
  });

  test("PENDING when the call has ended and no analysis has appeared", () => {
    const r = analysis.classifyAnalysisReadiness(F.analysisPending);
    assert.equal(r.state, S.pending);
    // The reason names the documented behaviour rather than guessing.
    assert.match(r.reason, /call_analyzed fires separately from call_ended/);
  });

  test("NOT APPLICABLE when the call never connected — polling would not end", () => {
    for (const fixture of [F.unconnectedNoAnalysis, F.webCallNeverConnected, F.registeredCall]) {
      const r = analysis.classifyAnalysisReadiness(fixture);
      assert.equal(r.state, S.notApplicable, `${fixture.call_status} should be terminal`);
      assert.match(r.reason, /no conversation to analyse/);
    }
  });

  test("pending while a call is still in progress", () => {
    assert.equal(analysis.classifyAnalysisReadiness(F.ongoingCall).state, S.pending);
  });

  test("an empty call_analysis object is pending, not ready", () => {
    const r = analysis.classifyAnalysisReadiness({ ...F.analysisPending, call_analysis: {} });
    assert.equal(r.state, S.ready === r.state ? S.ready : S.pending);
    assert.equal(r.state, S.pending, "an object with nothing in it must not count as ready");
  });

  test("a provider error is its own state, not \"pending\"", () => {
    const r = analysis.classifyAnalysisReadiness(null, { providerErrorCode: "provider_unauthorized" });
    assert.equal(r.state, S.providerError);
    assert.match(r.reason, /provider_unauthorized/);
  });

  test("an unrecognised status is unknown, not assumed", () => {
    const r = analysis.classifyAnalysisReadiness({ call_id: "x", call_status: "something_new" });
    assert.equal(r.state, S.unknown);
    assert.match(r.reason, /something_new/);
  });

  test("no body at all is unknown", () => {
    assert.equal(analysis.classifyAnalysisReadiness(null).state, S.unknown);
    assert.equal(analysis.classifyAnalysisReadiness(undefined).state, S.unknown);
  });
});

// ── Validation ──────────────────────────────────────────────────────

describe("built-in fields", () => {
  test("a well-formed analysis validates", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: F.EXPECTED_CUSTOM_FIELDS });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(v.analysis.userSentiment, "Positive");
    assert.equal(v.analysis.callSuccessful, true);
    assert.equal(v.analysis.inVoicemail, false);
  });

  test("the summary is reported by LENGTH, not by content", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis);
    assert.equal(v.analysis.callSummaryPresent, true);
    assert.equal(v.analysis.callSummaryLength, F.analysisReady.call_analysis.call_summary.length);
    assert.equal(v.analysis.callSummary, undefined, "summary text must not be carried by default");
    assert.equal(JSON.stringify(v).includes("residential lockout"), false);
  });

  test("summary text appears only with an explicit flag", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { includeContent: true });
    assert.equal(v.analysis.callSummary, F.analysisReady.call_analysis.call_summary);
  });

  test("an undocumented sentiment is REJECTED, not coerced to Unknown", () => {
    const v = analysis.validateCallAnalysis(F.malformedAnalysis.call_analysis);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.field === "user_sentiment"));
    // "Unknown" is itself a documented value, so mapping to it would erase the
    // difference between "the model said Unknown" and "the model said nonsense".
    assert.equal(v.analysis.userSentiment, undefined);
  });

  test("a string where a boolean was documented is an error", () => {
    const v = analysis.validateCallAnalysis(F.malformedAnalysis.call_analysis);
    assert.ok(v.errors.some((e) => e.field === "call_successful"), "call_successful: \"yes\" must fail");
  });

  test("missing optional fields are absences, not errors", () => {
    const v = analysis.validateCallAnalysis({ call_summary: "A short fictional summary." });
    assert.equal(v.ok, true);
    assert.equal(v.analysis.userSentiment, null);
    assert.equal(v.analysis.callSuccessful, null);
    assert.equal(v.analysis.inVoicemail, null);
  });

  test("a non-object analysis is refused", () => {
    for (const value of [null, "text", 42, []]) {
      assert.equal(analysis.validateCallAnalysis(value).ok, false);
    }
  });

  test("the documented sentiment enum is exact, including capitalisation", () => {
    assert.deepEqual([...analysis.USER_SENTIMENTS], ["Negative", "Positive", "Neutral", "Unknown"]);
    assert.equal(analysis.validateCallAnalysis({ user_sentiment: "positive" }).ok, false, "lower-case is not the documented spelling");
  });
});

describe("custom analysis fields", () => {
  const expected = F.EXPECTED_CUSTOM_FIELDS;

  test("a custom TEXT field is length-reported, never carried", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: expected });
    assert.deepEqual(v.analysis.custom.caller_name, { type: "string", present: true, length: "Fictional Caller".length });
    assert.equal(JSON.stringify(v.analysis.custom).includes("Fictional Caller"), false);
  });

  test("a custom SELECTOR field is checked against its choices", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: expected });
    assert.deepEqual(v.analysis.custom.urgency, { type: "enum", value: "urgent_now" });
  });

  test("a custom BOOLEAN field keeps its value", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: expected });
    assert.deepEqual(v.analysis.custom.transferred, { type: "boolean", value: false });
  });

  test("a custom NUMBER field keeps its value", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: expected });
    assert.deepEqual(v.analysis.custom.attempts, { type: "number", value: 2 });
  });

  test("every type mismatch is flagged, and none is coerced", () => {
    const v = analysis.validateCallAnalysis(F.malformedAnalysis.call_analysis, { expectedCustomFields: expected });
    assert.equal(v.ok, false);
    const fields = v.errors.map((e) => e.field);
    assert.ok(fields.includes("transferred"), "\"no\" must not become false");
    assert.ok(fields.includes("attempts"), "\"two\" must not become 2");
    assert.ok(fields.includes("urgency"), "a value outside the choices must fail");
    assert.equal(v.analysis.custom.transferred, undefined);
    assert.equal(v.analysis.custom.attempts, undefined);
  });

  test("both type vocabularies are accepted", () => {
    // The API uses string/enum/boolean/number; the dashboard documents the same
    // four as Text/Selector/Boolean/Number. A schema copied from either place
    // must validate rather than failing on a spelling.
    const dashboardStyle = [
      { type: "Text", name: "caller_name" },
      { type: "Selector", name: "urgency", choices: ["routine", "urgent_soon", "urgent_now"] },
      { type: "Boolean", name: "transferred" },
      { type: "Number", name: "attempts" },
    ];
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: dashboardStyle });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });

  test("with NO schema supplied, fields are not accused of being unrequested", () => {
    // The M7E-LV live read printed "the provider returned X, which was not in
    // the requested schema" for every custom field — while no schema had been
    // supplied to compare against. The message asserted a check that never ran.
    const v = analysis.validateCallAnalysis({ custom_analysis_data: { caller_name: "X", suburb: "Y" } });
    assert.equal(v.ok, true);
    assert.equal(v.warnings.every((w) => w.code === "no_schema_supplied"), true);
    assert.equal(v.warnings.some((w) => w.code === "unexpected_custom_field"), false);
    assert.match(v.warnings[0].message, /no expected schema was supplied/);
  });

  test("with a schema supplied, a genuinely unrequested field still warns", () => {
    const v = analysis.validateCallAnalysis(
      { custom_analysis_data: { caller_name: "X", something_new: "Y" } },
      { expectedCustomFields: expected }
    );
    assert.ok(v.warnings.some((w) => w.code === "unexpected_custom_field"));
    assert.equal(v.warnings.some((w) => w.code === "no_schema_supplied"), false);
  });

  test("an unexpected field warns rather than failing", () => {
    const v = analysis.validateCallAnalysis(
      { custom_analysis_data: { something_new: "value" } },
      { expectedCustomFields: expected }
    );
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.code === "unexpected_custom_field"));
    assert.equal(v.analysis.custom.something_new, undefined);
  });

  test("a requested field that did not come back warns", () => {
    const v = analysis.validateCallAnalysis({ custom_analysis_data: { caller_name: "X" } }, { expectedCustomFields: expected });
    const missing = v.warnings.filter((w) => w.code === "missing_custom_field").map((w) => w.message);
    assert.equal(missing.length, 3);
  });

  test("custom_analysis_data of the wrong type is an error", () => {
    assert.equal(analysis.validateCallAnalysis({ custom_analysis_data: "not an object" }).ok, false);
    assert.equal(analysis.validateCallAnalysis({ custom_analysis_data: [] }).ok, false);
  });
});

// ── Bounded polling ─────────────────────────────────────────────────

describe("bounded polling", () => {
  const NO_SLEEP = async () => {};

  test("returns as soon as analysis is ready", async () => {
    let calls = 0;
    const out = await analysis.pollForAnalysis({
      readCall: async () => { calls += 1; return { ok: true, body: calls < 3 ? F.analysisPending : F.analysisReady }; },
      intervalMs: 1000,
      maxWaitMs: 10000,
      sleep: NO_SLEEP,
    });
    assert.equal(out.outcome, "ready");
    assert.equal(out.attempts, 3);
    assert.equal(out.readiness.state, S.ready);
  });

  test("TIMES OUT rather than polling for ever", async () => {
    let calls = 0;
    const out = await analysis.pollForAnalysis({
      readCall: async () => { calls += 1; return { ok: true, body: F.analysisPending }; },
      intervalMs: 1000,
      maxWaitMs: 5000,
      sleep: NO_SLEEP,
    });
    assert.equal(out.outcome, "timeout");
    assert.equal(out.attempts, 5, "attempts are derived from the budget, so the bound is structural");
    assert.equal(calls, 5);
  });

  test("stops immediately when analysis can never arrive", async () => {
    let calls = 0;
    const out = await analysis.pollForAnalysis({
      readCall: async () => { calls += 1; return { ok: true, body: F.unconnectedNoAnalysis }; },
      intervalMs: 1000,
      maxWaitMs: 60000,
      sleep: NO_SLEEP,
    });
    assert.equal(out.outcome, "not_applicable");
    assert.equal(calls, 1, "waiting for analysis of a call that never connected is waiting for ever");
  });

  test("a provider error ends the poll on the first failure", async () => {
    let calls = 0;
    const out = await analysis.pollForAnalysis({
      readCall: async () => { calls += 1; return { ok: false, errorCode: "provider_unauthorized" }; },
      intervalMs: 1000,
      maxWaitMs: 60000,
      sleep: NO_SLEEP,
    });
    assert.equal(out.outcome, "provider_error");
    assert.equal(calls, 1, "retrying a 401 for a minute gives the same answer more expensively");
    assert.equal(out.readiness.state, S.providerError);
  });

  test("the interval and budget are configurable and clamped", async () => {
    const attempts = [];
    await analysis.pollForAnalysis({
      readCall: async () => { attempts.push(1); return { ok: true, body: F.analysisPending }; },
      intervalMs: 0,        // clamped up to 1000
      maxWaitMs: 3000,
      sleep: NO_SLEEP,
    });
    assert.equal(attempts.length, 3);
  });

  test("it performs no I/O of its own", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-call-analysis"), "utf8");
    assert.equal(/globalThis\.fetch|require\(["']https?["']\)/.test(source), false);
  });
});

// ── The posture ─────────────────────────────────────────────────────

describe("provider analysis is untrusted", () => {
  test("the module exposes no way to write anything", () => {
    // A structural check: if a mutation ever appears here it will have a verb.
    for (const name of Object.keys(analysis)) {
      assert.doesNotMatch(name, /^(apply|approve|save|update|write|persist|commit|route|charge|bill)/i, `${name} looks like a mutation`);
    }
  });

  test("it requires no store, client or database", () => {
    const source = fs.readFileSync(require.resolve("../src/services/retell-call-analysis"), "utf8");
    assert.equal(/supabase|createClient|storeApi|db\./i.test(source), false);
    // Its only require is the standard-library-free pure path.
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, [], "the analysis module has no dependencies at all");
  });

  test("validation returns data, never a decision", () => {
    const v = analysis.validateCallAnalysis(F.analysisReady.call_analysis, { expectedCustomFields: F.EXPECTED_CUSTOM_FIELDS });
    assert.deepEqual(Object.keys(v).sort(), ["analysis", "errors", "ok", "warnings"]);
    assert.equal(v.analysis.approved, undefined);
    assert.equal(v.analysis.profileChange, undefined);
  });

  test("a confident analysis of a transfer number changes nothing", () => {
    // The provider claiming a transfer number is exactly the case where a
    // confident mistake is most expensive. It is data, and only data.
    const v = analysis.validateCallAnalysis(
      { custom_analysis_data: { caller_name: "+61491570006" } },
      { expectedCustomFields: F.EXPECTED_CUSTOM_FIELDS }
    );
    assert.equal(v.ok, true);
    // Even the value is not carried — a text field reports its length only.
    assert.equal(JSON.stringify(v).includes("+61491570006"), false);
  });
});
