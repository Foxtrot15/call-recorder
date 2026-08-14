// LOCKSMITH ACQUISITION E-12K — the first controlled call, and the reason it
// cannot happen by accident.
//
// ── THE ARCHITECTURAL QUESTION THIS STAGE EXISTED TO ANSWER ─────────
// If the global calling state is enabled for one controlled proof, can any
// worker, route, timer or startup job automatically drain the acquisition queue
// or create a second dial?
//
// The answer is no, and it is better than the gate I was prepared to build.
// **The dial executor is not reachable from the running server at all.** A
// transitive walk of requires from server.js reaches 105 modules and
// `acquisition-dial-execution.js` is not among them. Nothing in that graph
// calls `executeAuthorisedDial`, and no scheduler runs work without a request.
//
// `selectNext` IS reachable, and that is fine: it reserves a prospect against a
// named worker. A reservation is not a call, and nothing converts one into a
// call because the thing that would is unreachable.
//
// So "global enabled + queue 0 + one founder proof" is sufficient today — not
// because we expect nothing to be enqueued, but because there is no consumer.
// The assessment is COMPUTED from the module graph rather than asserted here,
// so it stays true only while it is true.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PROOF_PHASES,
  POST_PROOF_CHECKS,
  assessQueueDrainRisk,
  assessProviderActivation,
  reachableFromServer,
} = require("../src/services/acquisition-proof-plan");

const {
  createProofAuthorisation,
  bindProofAuthorisation,
  PROOF_CODES,
} = require("../src/services/acquisition-proof-authorisation");

const { describeProofPreflight } = require("../src/services/acquisition-proof-preflight");
const { assessAcquisitionAgentProvisioning, REFUSALS } = require("../src/services/acquisition-agent-provisioning");
const { resolveAcquisitionOutboundNumber } = require("../src/config/acquisition");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const RUNBOOK = "scripts/dev/acquisition-proof-runbook.js";

const ISO = "2026-08-14T02:00:00.000Z";
const now = (iso = ISO) => () => new Date(iso);
const PROSPECT = "prospect_proof_1";
const TO = "+61355501234";
const FROM = "+61355509876";
const AGENT = "agent_proof_1";

const auth = (over = {}) =>
  createProofAuthorisation({ approvedBy: "Peter Dang", prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, now: now(), ...over });

// ---------------------------------------------------------------------------
// 1. QUEUE SAFETY — THE MAIN QUESTION
// ---------------------------------------------------------------------------

describe("E-12K: enabling calling cannot drain the queue, structurally", () => {
  it("1-3. no dial executor is reachable from the running server", () => {
    const q = assessQueueDrainRisk();
    assert.strictEqual(q.executorReachableFromServer, false, "acquisition-dial-execution must stay out of the server graph");
    assert.deepStrictEqual([...q.executorCallersInServerGraph], [], "nothing in the server graph calls the executor");
    assert.strictEqual(q.safe, true);
    assert.ok(q.modulesReachable > 50, "sanity: the walk actually traversed the graph");
  });

  it("3b. and no scheduler runs work without a request", () => {
    const q = assessQueueDrainRisk();
    assert.deepStrictEqual([...q.schedulersInServerGraph], [], "no setInterval, cron or scheduler in the server graph");
  });

  it("3c. the walk has teeth — server.js itself is in it, a scratch file is not", () => {
    const reachable = reachableFromServer();
    assert.ok(reachable.has("server.js"));
    assert.ok(reachable.has("routes/acquisition-retell-webhook.js"), "the acquisition webhook IS reachable");
    assert.ok(!reachable.has("services/acquisition-dial-execution.js"), "the executor is NOT");
  });

  it("3d. a reservation is not a call — selectNext exists but leads nowhere", () => {
    // selectNext is reachable. That is fine and worth stating: it reserves a
    // prospect against a named worker. The path from reservation to dial does
    // not exist in the server.
    const reachable = reachableFromServer();
    assert.ok(reachable.has("services/acquisition-queue.js"), "the queue module is reachable");
    const queue = read("src/services/acquisition-queue.js");
    assert.ok(!/executeAuthorisedDial|createPhoneCall|adapter\./.test(queue), "the queue cannot dial");
  });

  it("3e. only hand-run scripts call the executor", () => {
    const callers = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.name.endsWith(".js")) continue;
        // The definition itself, and the module that SEARCHES for the name as a
        // string needle, are not callers. Both named explicitly rather than
        // pattern-excluded; the analyser is separately asserted inert below.
        if (rel === "src/services/acquisition-dial-execution.js") continue;
        if (rel === "src/services/acquisition-proof-plan.js") continue;
        if (/executeAuthorisedDial\s*\(/.test(fs.readFileSync(path.join(ROOT, rel), "utf8"))) callers.push(rel);
      }
    };
    walk("src");
    walk("scripts");
    assert.ok(callers.every((c) => c.startsWith("scripts/")), `only scripts may call the executor: ${callers.join(", ")}`);
    assert.ok(!callers.some((c) => c.startsWith("src/routes")), "no route may");
  });
});

// ---------------------------------------------------------------------------
// 2. PROVIDER ACTIVATION
// ---------------------------------------------------------------------------

describe("E-12K: the provider cannot be activated by configuration", () => {
  it("11. live is a literal false and no env var can change it", () => {
    const a = assessProviderActivation();
    assert.strictEqual(a.liveIsLiteralFalse, true);
    assert.strictEqual(a.activatableByConfiguration, false, "the provider reads no environment variable at all");
  });

  it("11b. submitting requires a transport nothing in src/ supplies", () => {
    const a = assessProviderActivation();
    assert.strictEqual(a.requiresInjectedTransport, true);
    assert.deepStrictEqual([...a.constructedAnywhereInSrc], [], "nothing in src/ even constructs the provider");
  });

  it("11c. so a staging API key cannot become a call transport by flipping a flag", () => {
    const a = assessProviderActivation();
    assert.match(a.reason, /CODE change, not a configuration change/i);
    // Demonstrated: full live-ish config, provider still refuses.
    const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");
    const p = createRetellAcquisitionProvider({ routing: { agentId: AGENT, fromNumber: FROM } });
    assert.strictEqual(p.live, false);
  });

  it("11d. creating an agent does not activate a provider — separate authorities", () => {
    const runner = read("scripts/dev/acquisition-provision-agent.js");
    assert.ok(!/live\s*:\s*true|transport\s*:/.test(runner), "the agent runner grants no transport");
  });
});

// ---------------------------------------------------------------------------
// 3. THE FOUNDER AUTHORISATION — ONE OF EVERYTHING
// ---------------------------------------------------------------------------

describe("E-12K: one authority binds one call", () => {
  it("4. it binds one destination", () => {
    const a = auth();
    assert.strictEqual(a.destinationE164, TO);
    const bound = bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d1", now: now() });
    assert.strictEqual(bound.consumed, true);
  });

  it("5. it cannot be reused", () => {
    const bound = bindProofAuthorisation(auth(), { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d1", now: now() });
    assert.strictEqual(
      bindProofAuthorisation(bound, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d2", now: now() }).code,
      PROOF_CODES.ALREADY_USED
    );
  });

  it("6. an expired authority is refused", () => {
    const a = auth({ windowMinutes: 15 });
    const later = () => new Date("2026-08-14T04:00:00.000Z");
    assert.strictEqual(bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d", now: later }).code, PROOF_CODES.EXPIRED);
  });

  it("7-10. wrong prospect, destination, from-number or agent are all refused", () => {
    const a = auth();
    for (const [label, wrong] of [
      ["prospect", { prospectId: "other" }],
      ["destination", { destinationE164: "+61300000000" }],
      ["from-number", { fromNumber: "+61399999999" }],
      ["agent", { agentId: "other_agent" }],
    ]) {
      const r = bindProofAuthorisation(a, { prospectId: PROSPECT, destinationE164: TO, fromNumber: FROM, agentId: AGENT, dispatchId: "d", now: now(), ...wrong });
      assert.strictEqual(r.code, PROOF_CODES.SCOPE_MISMATCH, label);
    }
  });

  it("27. it cannot authorise a campaign", () => {
    const a = auth();
    assert.strictEqual(a.scope, "one_call");
    assert.ok(!/prospects|members|batch|campaign|list/i.test(JSON.stringify(a)));
    // The plan module NAMES selectNext and writeCallingState — one as a string
    // it searches the module graph for, one as a phase checklist item. Naming
    // is not calling. So the two files that should never mention them at all
    // are checked for the words, and the plan is checked for the CALL form.
    for (const rel of ["src/services/acquisition-proof-authorisation.js", RUNBOOK]) {
      assert.ok(!/selectNext|enqueue|writeCallingState/.test(read(rel)), `${rel} must not touch the queue or calling state`);
    }
    const plan = read("src/services/acquisition-proof-plan.js");
    for (const call of [/\bselectNext\s*\(/, /\benqueue\s*\(/, /\bwriteCallingState\s*\(/]) {
      assert.ok(!call.test(plan), `the plan must not CALL ${call}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. EVERY GATE STILL REFUSES TODAY
// ---------------------------------------------------------------------------

describe("E-12K: today, every authority says no", () => {
  it("1b. the preflight previews NOT READY", async () => {
    const r = await describeProofPreflight({ env: {}, now: now() });
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.readyForReview, false);
    assert.ok(r.blockers.length >= 6);
  });

  it("11e/12. provider live and calling paused are both blockers", async () => {
    const store = { async readCallingState() { return { scope: "global", state: "paused", revision: 1 }; } };
    const r = await describeProofPreflight({ env: {}, store, now: now() });
    assert.strictEqual(r.execution.providerLive.ready, false);
    assert.ok(r.blockers.some((b) => /calling is PAUSED/.test(b)));
  });

  it("13. DNCR without an authoritative wash refuses", async () => {
    const r = await describeProofPreflight({ env: {}, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.dncr.ready, false);
  });

  it("14. a suppressed business refuses", async () => {
    const store = { async lookupSuppression() { return { reason: "opt_out" }; } };
    const r = await describeProofPreflight({ env: {}, store, prospectId: PROSPECT, destinationE164: TO, now: now() });
    assert.strictEqual(r.compliance.suppression.ready, false);
  });

  it("15-16. hours, holiday and attempt policy are deferred to the pre-dial gate, not re-decided", async () => {
    const r = await describeProofPreflight({ env: {}, now: now() });
    for (const key of ["permittedHours", "publicHoliday", "attemptPolicy"]) {
      assert.strictEqual(r.compliance[key].ready, "unknown", key);
      assert.match(r.compliance[key].detail, /pre-dial gate/i, key);
    }
    assert.match(r.compliance.publicHoliday.detail, /A-L2 is OPEN/);
  });

  it("30. a production Retell tag refuses agent creation", () => {
    const v = assessAcquisitionAgentProvisioning({ env: { RETELL_ALLOWED_TAG: "prod" } });
    assert.ok(v.refusals.includes(REFUSALS.PROD_TAG));
  });
});

// ---------------------------------------------------------------------------
// 5. NO SHARED RESOURCE SUBSTITUTES
// ---------------------------------------------------------------------------

describe("E-12K: no other product's resource can stand in", () => {
  it("28. the onboarding number cannot substitute", () => {
    assert.strictEqual(resolveAcquisitionOutboundNumber({ RETELL_OUTBOUND_ONBOARDING_NUMBER: FROM }), null);
  });

  it("29. the receptionist voice cannot substitute", () => {
    const v = assessAcquisitionAgentProvisioning({
      env: { RETELL_ALLOWED_TAG: "staging", RETELL_ACQUISITION_LLM_ID: "llm_x", RETELL_DEFAULT_VOICE_ID: "voice_receptionist", RETELL_ACQUISITION_WEBHOOK_URL: "https://a.example.test/webhooks/retell/acquisition" },
    });
    assert.ok(v.refusals.includes(REFUSALS.VOICE_MISSING));
  });

  it("29b. and no shared webhook can", () => {
    const v = assessAcquisitionAgentProvisioning({
      env: { RETELL_ALLOWED_TAG: "staging", RETELL_ACQUISITION_LLM_ID: "llm_x", RETELL_ACQUISITION_VOICE_ID: "v", RETELL_WEBHOOK_BASE_URL: "https://onboarding.example.test" },
    });
    assert.ok(v.refusals.includes(REFUSALS.WEBHOOK_MISSING));
  });
});

// ---------------------------------------------------------------------------
// 6. THE EXECUTION CONTRACT, PINNED BEFORE IT IS WRITTEN
// ---------------------------------------------------------------------------

describe("E-12K: the runbook has no execution path, and constrains the future one", () => {
  it("17-18. the runbook calls no adapter and no executor", () => {
    const s = read(RUNBOOK);
    assert.ok(!/adapter\.|createPhoneCall|createAgent|executeAuthorisedDial\s*\(/.test(s.replace(/^\s*\/\/.*$/gm, "")));
  });

  it("18b. it has no execution flag at all", () => {
    const s = read(RUNBOOK);
    assert.ok(!/--execute|--run|--confirm|--yes|--call/.test(s.replace(/^\s*\/\/.*$/gm, "")));
    assert.match(s, /THERE IS NO EXECUTION FLAG/i);
  });

  it("19. the future wrapper must delegate to the existing executor", () => {
    // Pinned as prose in the runbook AND as the contract the executor already
    // enforces: one dispatch, claimed durably, behind the M8E gate.
    assert.match(read(RUNBOOK), /must delegate to the EXISTING\s*\n?\/\/ executor/i);
    const exec = read("src/services/acquisition-dial-execution.js");
    assert.match(exec, /AuthorisedDial/);
  });

  it("20. an ambiguous provider result is raised, never retried", () => {
    const provider = read("src/services/acquisition-retell-provider.js");
    assert.match(provider, /AmbiguousSubmission/);
    // Matched as MACHINERY, not as a word. The provider explains at length why
    // it discards the shared port's retryable flag, and banning the word would
    // mean deleting the explanation to satisfy the test.
    const code = provider.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
    for (const machinery of [/setTimeout\s*\(/, /setInterval\s*\(/, /for \(let attempt/, /while \(attempt/, /\.retry\s*\(/]) {
      assert.ok(!machinery.test(code), `${machinery} must not appear in the provider`);
    }
  });

  it("21-22. acceptance authorises nothing further, and a callback does not auto-call", () => {
    const events = read("src/services/acquisition-call-events.js");
    // Call forms. The header sentence "never redials" documents the property;
    // it is not a violation of it.
    const code = events.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
    for (const call of [/executeAuthorisedDial\s*\(/, /createPhoneCall\s*\(/, /\bredial\s*\(/]) {
      assert.ok(!call.test(code), `the return path must never ${call}`);
    }
    assert.match(events, /never redials/i);
  });

  it("23-24. voicemail counts, no_answer does not", () => {
    const { ATTEMPT_CONSUMPTION } = require("../src/services/acquisition-attempt-policy");
    assert.strictEqual(ATTEMPT_CONSUMPTION.voicemail.countsTowardCap, true);
    assert.strictEqual(ATTEMPT_CONSUMPTION.no_answer.countsTowardCap, false);
  });

  it("31. every proof tool is preview/read-only by default", () => {
    for (const [rel, marker] of [
      ["scripts/dev/acquisition-provision-agent.js", /PREVIEW_ONLY = !process\.argv/],
      ["scripts/dev/acquisition-webhook-smoke.js", /const RUN = process\.argv\.includes\("--run"\)/],
      ["scripts/dev/acquisition-preview-proof.js", /process\.exit\(0\)/],
      [RUNBOOK, /read-only, no execution path/i],
    ]) {
      assert.match(read(rel), marker, rel);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. THE PHASES, AND POST-PROOF SAFE STATE
// ---------------------------------------------------------------------------

describe("E-12K: the sequence is data, and the last phase is the one people skip", () => {
  it("25-26. post-proof requires the authority consumed and the queue still 0", () => {
    const joined = POST_PROOF_CHECKS.join(" | ");
    assert.match(joined, /queue is still 0/i);
    assert.match(joined, /proof authorisation is consumed/i);
    assert.match(joined, /exactly one dispatch/i);
    assert.match(joined, /returned to paused/i);
    assert.match(joined, /no provider was left live/i);
    assert.match(joined, /no retry is pending/i);
  });

  it("phases 0-6 exist, in order, and phase 3 checks the queue BEFORE enabling", () => {
    assert.strictEqual(PROOF_PHASES.length, 7);
    assert.deepStrictEqual(PROOF_PHASES.map((p) => p.phase), [0, 1, 2, 3, 4, 5, 6]);
    const enable = PROOF_PHASES[3];
    assert.strictEqual(enable.title, "CONTROLLED ENABLE");
    assert.match(enable.checks[0], /queue is empty \(0 rows\) BEFORE enabling/i);
    assert.match(enable.checks.join(" "), /compare-and-set on the current revision/i);
  });

  it("phase 4 is one command, one destination, no retry", () => {
    const p4 = PROOF_PHASES[4].checks.join(" | ");
    assert.match(p4, /no loop, no list, no retry, no second destination/i);
    assert.match(p4, /does NOT call the Retell adapter/i);
  });

  it("phase 5 resolves the dispatch LAST", () => {
    const p5 = PROOF_PHASES[5].checks;
    assert.match(p5[p5.length - 1], /resolved LAST/i);
  });

  it("the plan module places no call and reaches no network", () => {
    const s = read("src/services/acquisition-proof-plan.js");
    // The executor's name appears inside a string literal the module searches
    // the graph for, so the assertions are: it never imports the executor, and
    // never invokes the name as an identifier — i.e. not preceded by a quote.
    const code = s.replace(/^\s*\/\/.*$/gm, "");
    // retell-adapter is named as an EXCLUSION in the scheduler scan ("the
    // adapter's per-request AbortController timeout is not a scheduler"), so
    // this checks the import form rather than the name.
    assert.ok(!/fetch\s*\(|require\(["'][^"']*(axios|node-fetch|retell-adapter)/.test(code), "no transport imported or called");
    assert.ok(!/require\([^)]*acquisition-dial-execution/.test(code), "does not import the executor");
    assert.ok(!/[^"'`]executeAuthorisedDial\s*\(/.test(code), "never invokes it");
  });
});
