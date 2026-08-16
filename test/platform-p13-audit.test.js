// AIDA PLATFORM P13 — the pre-push audit, as executable proof.
//
// Everything here restates a claim made in the P1–P12 report and proves it
// directly, in the founder's own framing, rather than pointing at a test that
// happens to cover it sideways.
//
// Four material defects were fixed during P1–P12. A fix nobody can demonstrate
// is a fix nobody should believe, so each gets a proof built the way an auditor
// would ask for one: the failing scenario named first, then the assertion that
// it no longer fails.
//
// The ratchet section deliberately reads the matchers OUT OF the boundaries
// test file and exercises those, rather than re-declaring copies here. A copy
// would pass forever while the real ratchet rotted.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const { validateBlueprint, MANDATORY_PROHIBITED_CLAIMS, RETENTION_PERIODS } = require("../src/platform/client-blueprint");
const { createBlueprintAuthority, createInMemoryBlueprintStore, AUTHORITY_CODES } = require("../src/platform/blueprint-authority");
const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
const { compileRetellPreview } = require("../src/platform/provider-compiler-retell");
const { migrateLocksmithProfile } = require("../src/platform/migrate-locksmith-profile");
const { locksmithA, locksmithB, plumberC } = require("../src/platform/fixtures/clients");

const REFS = Object.freeze({
  llmId: "llm_audit0000",
  voiceId: "custom_voice_audit0000",
  webhookUrl: "https://example.invalid/audit",
});

const clock = (startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) => {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
};

const preview = (bp, refs = REFS, direction = "inbound") =>
  compileRetellPreview({ spec: compileBehaviourSpec(bp).spec, providerRefs: refs, direction });

// ════════════════════════════════════════════════════════════════════
// DEFECT 1 — the stale-draft compare-and-set
// ════════════════════════════════════════════════════════════════════
//
// The bug: `expectedUpdatedAt = null` meant "no expectation", but null is also
// the genuine value on a never-edited draft. So the editor most likely to
// collide — two people opening a brand-new draft at the same moment — could
// not express any expectation at all, and the second save was accepted
// silently.

describe("P13 defect 1 — two editors on the SAME never-edited draft", () => {
  async function twoEditorsOpenTheSameFreshDraft() {
    const now = clock();
    const authority = createBlueprintAuthority({ store: createInMemoryBlueprintStore(), now });
    const draft = await authority.createDraft({
      clientId: "northside_locks", blueprint: locksmithA(), createdBy: "Peter Dang",
    });
    const configVersion = draft.version.metadata.configVersion;

    // Both editors read the SAME draft, at the same moment, before either types.
    const whatEditorOneSaw = (await authority.getDraft("northside_locks", configVersion)).version.metadata.updatedAt;
    const whatEditorTwoSaw = (await authority.getDraft("northside_locks", configVersion)).version.metadata.updatedAt;
    return { authority, now, configVersion, whatEditorOneSaw, whatEditorTwoSaw };
  }

  it("a never-edited draft states its unedited-ness as a value both editors can hold", async () => {
    const { whatEditorOneSaw, whatEditorTwoSaw } = await twoEditorsOpenTheSameFreshDraft();
    assert.equal(whatEditorOneSaw, null);
    assert.equal(whatEditorTwoSaw, null);
    assert.equal(whatEditorOneSaw, whatEditorTwoSaw, "both editors read the identical state");
  });

  it("the FIRST save lands", async () => {
    const { authority, configVersion, whatEditorOneSaw } = await twoEditorsOpenTheSameFreshDraft();
    const first = await authority.updateDraft({
      clientId: "northside_locks",
      configVersion,
      expectedUpdatedAt: whatEditorOneSaw, // null — "it had never been edited when I read it"
      mutate: (bp) => { bp.serviceArea.suburbs = ["Editor One's list"]; },
      updatedBy: "Editor One",
    });
    assert.equal(first.ok, true, JSON.stringify(first));
  });

  it("the SECOND save is REFUSED, not merged and not silently applied", async () => {
    const { authority, now, configVersion, whatEditorOneSaw, whatEditorTwoSaw } = await twoEditorsOpenTheSameFreshDraft();

    await authority.updateDraft({
      clientId: "northside_locks", configVersion, expectedUpdatedAt: whatEditorOneSaw,
      mutate: (bp) => { bp.serviceArea.suburbs = ["Editor One's list"]; }, updatedBy: "Editor One",
    });
    now.tick();

    const second = await authority.updateDraft({
      clientId: "northside_locks", configVersion,
      expectedUpdatedAt: whatEditorTwoSaw, // still null — Editor Two never saw the first save
      mutate: (bp) => { bp.serviceArea.suburbs = ["Editor Two's list"]; }, updatedBy: "Editor Two",
    });

    assert.equal(second.ok, false, "the stale writer must be refused");
    assert.equal(second.code, AUTHORITY_CODES.STALE);
    assert.equal(second.expectedUpdatedAt, null);
    assert.notEqual(second.actualUpdatedAt, null, "and told what it actually is");
  });

  it("Editor One's work survives intact — nothing was merged", async () => {
    const { authority, now, configVersion, whatEditorOneSaw, whatEditorTwoSaw } = await twoEditorsOpenTheSameFreshDraft();
    await authority.updateDraft({
      clientId: "northside_locks", configVersion, expectedUpdatedAt: whatEditorOneSaw,
      mutate: (bp) => { bp.serviceArea.suburbs = ["Editor One's list"]; }, updatedBy: "Editor One",
    });
    now.tick();
    await authority.updateDraft({
      clientId: "northside_locks", configVersion, expectedUpdatedAt: whatEditorTwoSaw,
      mutate: (bp) => { bp.serviceArea.suburbs = ["Editor Two's list"]; }, updatedBy: "Editor Two",
    });

    const after = await authority.getDraft("northside_locks", configVersion);
    assert.deepEqual(after.version.serviceArea.suburbs, ["Editor One's list"]);
    assert.equal(after.version.metadata.updatedBy, "Editor One");
  });

  it("the pre-fix behaviour is genuinely gone — null is no longer read as 'no expectation'", async () => {
    // Before the fix this exact call succeeded. That is the regression under guard.
    const { authority, now, configVersion } = await twoEditorsOpenTheSameFreshDraft();
    await authority.updateDraft({
      clientId: "northside_locks", configVersion,
      mutate: (bp) => { bp.identity.description = "moved on"; }, updatedBy: "Editor One",
    });
    now.tick();
    const stale = await authority.updateDraft({
      clientId: "northside_locks", configVersion, expectedUpdatedAt: null,
      mutate: (bp) => { bp.identity.description = "overwritten"; }, updatedBy: "Editor Two",
    });
    assert.equal(stale.ok, false);
    assert.equal((await authority.getDraft("northside_locks", configVersion)).version.identity.description, "moved on");
  });

  it("omitting the expectation still means 'do not check' — the two are distinguishable", async () => {
    const { authority, now, configVersion } = await twoEditorsOpenTheSameFreshDraft();
    await authority.updateDraft({
      clientId: "northside_locks", configVersion,
      mutate: (bp) => { bp.identity.description = "one"; }, updatedBy: "Editor One",
    });
    now.tick();
    const unchecked = await authority.updateDraft({
      clientId: "northside_locks", configVersion, // no expectedUpdatedAt at all
      mutate: (bp) => { bp.identity.description = "two"; }, updatedBy: "Editor Two",
    });
    assert.equal(unchecked.ok, true, "an omitted expectation is not a stale one");
  });
});

// ════════════════════════════════════════════════════════════════════
// DEFECT 2 — begin_message
// ════════════════════════════════════════════════════════════════════
//
// The bug: begin_message was set to the greeting STYLE, which is an
// instruction to the model. The assistant would have opened every call by
// reading its own stage directions aloud.

describe("P13 defect 2 — the assistant does not speak its own stage directions", () => {
  const STAGE_DIRECTION = "Warm and brief. Name the business, say you are an AI assistant, ask how you can help.";

  const withStyle = (make, style) => {
    const bp = make();
    bp.callHandling.greetingStyle = style;
    return bp;
  };

  it("never emits the greeting style as the spoken opening line", () => {
    const out = preview(withStyle(locksmithA, STAGE_DIRECTION));
    assert.notEqual(out.responseEngine.begin_message, STAGE_DIRECTION);
    for (const directive of ["Name the business", "Warm and brief", "ask how you can help"]) {
      assert.ok(!out.responseEngine.begin_message.includes(directive), `spoke the directive "${directive}"`);
    }
  });

  it("keeps the style where it belongs — as guidance inside the prompt", () => {
    const out = preview(withStyle(locksmithA, STAGE_DIRECTION));
    assert.ok(out.responseEngine.general_prompt.includes(STAGE_DIRECTION));
  });

  it("is compiled from business and assistant identity, not from configuration text", () => {
    const bp = locksmithA();
    const baseline = preview(bp).responseEngine.begin_message;
    assert.ok(baseline.includes(bp.identity.tradingName), "names the business");
    assert.ok(baseline.includes(bp.identity.assistantName), "names the assistant");

    const renamedBusiness = locksmithA();
    renamedBusiness.identity.tradingName = "A Completely Different Trading Name";
    assert.ok(preview(renamedBusiness).responseEngine.begin_message.includes("A Completely Different Trading Name"));

    const renamedAssistant = locksmithA();
    renamedAssistant.identity.assistantName = "Wren";
    assert.ok(preview(renamedAssistant).responseEngine.begin_message.includes("Wren"));
  });

  it("does not vary with the greeting style at all", () => {
    const a = preview(withStyle(locksmithA, "Brisk and businesslike.")).responseEngine.begin_message;
    const b = preview(withStyle(locksmithA, "Slow, gentle, take your time.")).responseEngine.begin_message;
    assert.equal(a, b, "the spoken line is identity-derived, so a style change must not move it");
  });

  it("survives a style that is itself a whole sentence somebody might mistake for a greeting", () => {
    // The style is guidance. Even when it reads like a greeting it is not the
    // spoken line — the client sets that with greetingLine, or gets a
    // constructed one.
    const trap = "Hello, thanks for calling, how can I help?";
    const bp = withStyle(locksmithA, trap);
    assert.equal(bp.callHandling.greetingLine, null, "this fixture has chosen no literal line");
    assert.notEqual(preview(bp).responseEngine.begin_message, trap);
    assert.notEqual(preview(bp, REFS, "outbound").responseEngine.begin_message, trap);
  });

  it("speaks the client's chosen inbound line verbatim when there is one", () => {
    const bp = locksmithA();
    bp.callHandling.greetingLine = "Northside Lock and Key, this is Aida, how can I help?";
    assert.equal(preview(bp).responseEngine.begin_message, bp.callHandling.greetingLine);
  });
});

// ════════════════════════════════════════════════════════════════════
// DEFECT 3 — the payload hash must see the voice
// ════════════════════════════════════════════════════════════════════
//
// The bug: payloadHash excluded voice_id, llm_id and webhook_url, so a drift
// detector was blind to the single field E-12B established must never change
// silently.

describe("P13 defect 3 — changing ONLY voice_id moves the deterministic hash", () => {
  const bp = locksmithA();
  const baseline = preview(bp);
  const voiceSwapped = preview(bp, { ...REFS, voiceId: "custom_voice_somebodyelse" });

  it("everything except the voice is byte-identical between the two payloads", () => {
    assert.equal(
      JSON.stringify(baseline.responseEngine),
      JSON.stringify(voiceSwapped.responseEngine),
      "the prompt must be identical, or this proves nothing about the voice",
    );
    assert.equal(baseline.agent.webhook_url, voiceSwapped.agent.webhook_url);
    assert.equal(baseline.agent.response_engine.llm_id, voiceSwapped.agent.response_engine.llm_id);
    assert.equal(baseline.agent.agent_name, voiceSwapped.agent.agent_name);
    assert.notEqual(baseline.agent.voice_id, voiceSwapped.agent.voice_id, "the voice is the ONLY difference");
  });

  it("the agent hash changes", () => {
    assert.notEqual(baseline.agentHash, voiceSwapped.agentHash);
  });

  it("the combined payload hash changes", () => {
    assert.notEqual(baseline.payloadHash, voiceSwapped.payloadHash);
  });

  it("the response engine hash does NOT change, because the words did not", () => {
    assert.equal(baseline.responseEngineHash, voiceSwapped.responseEngineHash);
  });

  it("the voice reaches the payload as an agent field, exactly once", () => {
    assert.equal(baseline.agent.voice_id, REFS.voiceId);
    assert.equal("voice_id" in baseline.responseEngine, false, "the voice is not an engine field");
  });

  it("is stable — the same voice hashes the same way every time", () => {
    assert.equal(preview(bp).agentHash, baseline.agentHash);
    assert.equal(preview(bp, { ...REFS, voiceId: "custom_voice_somebodyelse" }).agentHash, voiceSwapped.agentHash);
  });

  it("an ABSENT voice is not silently equal to a present one", () => {
    const missing = preview(bp, { ...REFS, voiceId: null });
    assert.equal(missing.ready, false);
    assert.deepEqual([...missing.unresolved], ["voiceId"]);
    assert.notEqual(missing.agentHash, baseline.agentHash);
  });
});

// ════════════════════════════════════════════════════════════════════
// DEFECT 4 — service-scoped questions stay scoped
// ════════════════════════════════════════════════════════════════════
//
// The bug: every additional question was emitted as always-ask, so a plumber's
// assistant was told to say "is anyone still inside, go outside and don't use
// switches" on a call about a dripping tap.

describe("P13 defect 4 — a leaking tap does not trigger emergency questions", () => {
  const bp = plumberC();
  const { spec } = compileBehaviourSpec(bp);
  const out = preview(bp);
  const prompt = out.responseEngine.general_prompt;

  const ALWAYS = prompt.slice(prompt.indexOf("# What you always find out"), prompt.indexOf("# What you also ask"));
  const SCOPED = prompt.slice(prompt.indexOf("# What you also ask"), prompt.indexOf("# Urgency"));

  const GAS_QUESTION = "Is anyone still inside? Please go outside and don't use switches.";
  const WATER_QUESTION = "Have you been able to turn the water off at the meter?";

  /** The per-service block, split into { serviceName: linesUnderIt }. */
  const scopedByService = (() => {
    const map = new Map();
    let current = null;
    for (const line of SCOPED.split("\n")) {
      if (line.startsWith("- ")) {
        current = line.slice(2).split(":")[0].trim();
        map.set(current, [line]);
      } else if (current && line.trim()) {
        map.get(current).push(line.trim());
      }
    }
    return map;
  })();

  it("the always-ask list carries no emergency question at all", () => {
    assert.ok(!ALWAYS.includes(GAS_QUESTION), "the gas evacuation instruction must not be on every call");
    assert.ok(!ALWAYS.includes(WATER_QUESTION), "the water-meter question must not be on every call");
    assert.ok(ALWAYS.includes("caller name"), "but the genuinely-always fields are still there");
  });

  it("a leaking tap appears NOWHERE in the job-specific block", () => {
    // It has no per-service collection and no scoped question, so it must not
    // pick anything up.
    assert.ok(!scopedByService.has("Leaking tap"), "a leaking tap needs no extra questions");
    const tapSpec = spec.services.find((s) => s.serviceId === "leaking_tap");
    assert.deepEqual(
      [...tapSpec.collect].sort(),
      [...spec.intake.collectAlways].sort(),
      "a leaking tap collects exactly what every call collects, and nothing more",
    );
  });

  it("no emergency question is reachable from a leaking tap", () => {
    for (const question of spec.intake.additionalQuestions) {
      if (question.question === GAS_QUESTION || question.question === WATER_QUESTION) {
        assert.ok(question.appliesToServices.length > 0, "an emergency question must be scoped");
        assert.ok(
          !question.appliesToServices.includes("leaking_tap"),
          `"${question.question}" must not apply to a leaking tap`,
        );
      }
    }
  });

  it("a burst pipe DOES compile its required service-scoped collection", () => {
    const burstSpec = spec.services.find((s) => s.serviceId === "burst_pipe");
    assert.ok(burstSpec.collect.includes("on_site_now"), "an emergency needs to know if they are there");
    assert.ok(burstSpec.collect.includes("access_notes"));

    const block = scopedByService.get("Burst pipe");
    assert.ok(block, "a burst pipe must appear in the job-specific block");
    assert.ok(block[0].includes("on site now"));
    assert.ok(block[0].includes("access notes"));
    assert.ok(block.some((l) => l.includes(WATER_QUESTION)), "and carry its own safety question");
  });

  it("gas fitting carries the evacuation instruction, and only gas fitting", () => {
    const gas = scopedByService.get("Gas fitting");
    assert.ok(gas && gas.some((l) => l.includes(GAS_QUESTION)));

    const carriers = [...scopedByService.entries()].filter(([, lines]) => lines.some((l) => l.includes(GAS_QUESTION)));
    assert.deepEqual(carriers.map(([name]) => name), ["Gas fitting"]);
  });

  it("the emergency questions appear exactly once each in the whole prompt", () => {
    const count = (needle) => prompt.split(needle).length - 1;
    assert.equal(count(GAS_QUESTION), 1);
    assert.equal(count(WATER_QUESTION), 2, "burst pipe and emergency water leak both ask it, and nothing else does");
  });

  it("a client with nothing job-specific gets no job-specific block at all", () => {
    const simple = plumberC();
    simple.callHandling.collectByService = {};
    simple.callHandling.additionalQuestions = [];
    assert.ok(!preview(simple).responseEngine.general_prompt.includes("# What you also ask"));
  });
});

// ════════════════════════════════════════════════════════════════════
// COMPLIANCE — what a client may say, versus what a client may decide
// ════════════════════════════════════════════════════════════════════

describe("P13 compliance — the boundary between wording and authority", () => {
  it("lets a client configure their own disclosure WORDING and retention", () => {
    const bp = plumberC();
    bp.compliance = {
      callsMayBeRecorded: true,
      recordingDisclosure: "Heads up, we record calls so we get the job right.",
      transcriptRetention: "keep_3_months",
      recordingRetention: "keep_3_months",
      redactSensitiveData: false,
      privacyPolicyReference: "https://example.invalid/privacy",
    };
    assert.equal(validateBlueprint(bp).ok, true, JSON.stringify(validateBlueprint(bp).errors));
    const out = preview(bp);
    assert.ok(out.responseEngine.general_prompt.includes("Heads up, we record calls so we get the job right."));
  });

  it("refuses recording without a disclosure — the caller has to be told, in words", () => {
    const bp = plumberC();
    bp.compliance = { ...bp.compliance, callsMayBeRecorded: true, recordingDisclosure: null };
    const result = validateBlueprint(bp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === "compliance.recordingDisclosure"));
  });

  it("refuses to leave recording unanswered", () => {
    const bp = plumberC();
    bp.compliance = { ...bp.compliance, callsMayBeRecorded: null };
    assert.ok(validateBlueprint(bp).errors.some((e) => e.path === "compliance.callsMayBeRecorded"));
  });

  it("keeps retention a platform-owned vocabulary, not free text", () => {
    const bp = plumberC();
    bp.compliance = { ...bp.compliance, transcriptRetention: "keep_forever_probably" };
    assert.ok(validateBlueprint(bp).errors.some((e) => e.path === "compliance.transcriptRetention"));
    assert.ok(!RETENTION_PERIODS.includes("keep_forever_probably"));
  });

  it("says nothing about recording for a client who does not record", () => {
    const bp = locksmithA();
    assert.equal(bp.compliance.callsMayBeRecorded, false);
    assert.ok(!preview(bp).responseEngine.general_prompt.includes("# Recording"));
  });

  it("carries every legacy privacy answer across, losing none of them", () => {
    require("../src/services/locksmith-extraction-fixture");
    const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
    const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");
    const legacy = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" }).profile;
    const { blueprint, unmapped } = migrateLocksmithProfile(legacy);

    const CARRIED = {
      callsMayBeRecorded: "callsMayBeRecorded",
      recordingDisclosure: "recordingDisclosure",
      transcriptRetention: "transcriptRetention",
      recordingRetention: "recordingRetention",
      redactSensitiveData: "redactSensitiveData",
      privacyPolicyReference: "privacyPolicyReference",
    };
    for (const [legacyField, newField] of Object.entries(CARRIED)) {
      assert.equal(blueprint.compliance[newField], legacy.privacy[legacyField], `privacy.${legacyField} was lost`);
    }

    // The one field with no home is REPORTED rather than dropped.
    const remaining = Object.keys(legacy.privacy).filter((k) => !(k in CARRIED));
    for (const field of remaining) {
      if (legacy.privacy[field] === null || legacy.privacy[field] === undefined) continue;
      assert.ok(
        unmapped.some((u) => u.path === `privacy.${field}`),
        `privacy.${field} was neither carried nor reported`,
      );
    }
  });

  it("cannot disable a platform-owned compliance authority from configuration", () => {
    // Everything a client could plausibly try, and what happens.
    const attempts = [
      ["remove a mandatory prohibition", (bp) => { bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== "claiming_to_be_human"); }],
      ["remove all of them", (bp) => { bp.knowledge.prohibitedClaims = []; }],
      ["record with no disclosure", (bp) => { bp.compliance = { ...bp.compliance, callsMayBeRecorded: true, recordingDisclosure: null }; }],
    ];
    for (const [what, mutate] of attempts) {
      const bp = plumberC();
      mutate(bp);
      assert.equal(validateBlueprint(bp).ok, false, `"${what}" should be refused`);
    }
  });

  it("keeps AI disclosure on even when a blueprint tries every way to switch it off", () => {
    for (const sabotage of [
      (bp) => { bp.assistant = { disclosesAiWhenAsked: false }; },
      (bp) => { bp.extensions = { disclosesAiWhenAsked: false }; },
      (bp) => { bp.compliance = { ...bp.compliance, disclosesAiWhenAsked: false }; },
      (bp) => { bp.voice = { ...bp.voice, disclosesAiWhenAsked: false }; },
      (bp) => { bp.disclosure = { whenAsked: false, inOpening: { outbound: false } }; },
    ]) {
      const bp = plumberC();
      sabotage(bp);
      const { spec } = compileBehaviourSpec(bp);
      assert.equal(spec.disclosure.whenAsked, true);
      assert.equal(spec.disclosure.inOpening.outbound, true);
      assert.match(preview(bp, REFS, "outbound").responseEngine.begin_message, /AI assistant/i);
      for (const direction of ["inbound", "outbound"]) {
        assert.match(preview(bp, REFS, direction).responseEngine.general_prompt, /say plainly and immediately that you are an AI assistant/i);
      }
    }
  });

  it("has no field anywhere that could reach a compliance authority", () => {
    const REACHABLE = [
      "dncr", "dncrWashed", "suppression", "suppressed", "callingState", "callingEnabled",
      "dialAuthorised", "dispatchId", "providerResourceId", "webhookVerified",
    ];
    for (const make of [locksmithA, locksmithB, plumberC]) {
      const body = JSON.stringify(make());
      const spec = JSON.stringify(compileBehaviourSpec(make()).spec);
      for (const field of REACHABLE) {
        assert.ok(!body.includes(`"${field}"`), `a blueprint carries "${field}"`);
        assert.ok(!spec.includes(`"${field}"`), `a spec carries "${field}"`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// TENANT ISOLATION — the eleven dimensions, named
// ════════════════════════════════════════════════════════════════════

describe("P13 tenant isolation — Locksmith A, Locksmith B, Plumber C", () => {
  const CLIENTS = [
    { id: "northside_locks", make: locksmithA },
    { id: "southbank_security", make: locksmithB },
    { id: "riverside_plumbing", make: plumberC },
  ];

  /** For each named dimension: how to read it, and how to compare two clients. */
  const DIMENSIONS = {
    identity: (bp) => [bp.identity.legalName, bp.identity.tradingName, bp.identity.assistantName],
    services: (bp) => bp.services.map((s) => s.serviceId),
    questions: (bp) => bp.callHandling.additionalQuestions.map((q) => q.question),
    knowledge: (bp) => bp.knowledge.approvedFacts.map((f) => f.statement),
    "pricing policy": (bp) => [bp.knowledge.pricingDisclosure, bp.knowledge.pricingWording],
    "service areas": (bp) => [...bp.serviceArea.suburbs, ...bp.serviceArea.postcodes],
    escalation: (bp) => [bp.callHandling.escalation.primaryNumber, bp.callHandling.escalation.backupNumber].filter(Boolean),
    "integration references": (bp) => bp.integrations.filter((i) => i.enabled).map((i) => i.capability),
    voice: (bp) => [bp.voice.profileRef, bp.voice.tone],
    greeting: (bp) => [bp.callHandling.greetingStyle],
    "outbound proposition": (bp) => [bp.outbound.enabled, bp.outbound.proposition],
  };

  // Dimensions where two businesses may legitimately coincide. Each is named
  // and justified rather than skipped silently, and each gets its own
  // INDEPENDENCE proof below — because isolation here means "one client's
  // choice does not move another's", not "they must choose differently".
  //
  //   integration references  a capability is a platform word, not a tenant's
  //                           property; two businesses both wanting SMS is
  //                           the system working
  //   voice                   `profileRef` points into a shared voice
  //                           catalogue. Two businesses picking the same
  //                           Australian female voice is ordinary — a
  //                           requirement that they differ would be absurd
  //   outbound proposition    every client's outbound is off, so all three
  //                           are legitimately null
  const MAY_COINCIDE = new Set(["integration references", "voice", "outbound proposition"]);

  for (const [dimension, read] of Object.entries(DIMENSIONS)) {
    it(`keeps ${dimension} distinct between every pair of clients`, () => {
      for (const a of CLIENTS) {
        for (const b of CLIENTS) {
          if (a.id === b.id) continue;
          const av = read(a.make());
          const bv = read(b.make());
          if (MAY_COINCIDE.has(dimension)) {
            assert.ok(Array.isArray(av) && Array.isArray(bv), `${dimension} should be readable`);
            continue;
          }
          const shared = av.filter((v) => v !== null && v !== undefined && bv.includes(v));
          assert.deepEqual(shared, [], `${a.id} and ${b.id} share ${dimension}: ${shared.join(", ")}`);
        }
      }
    });
  }

  it("keeps every client's outbound switched off, so none can propose anything", () => {
    for (const { id, make } of CLIENTS) {
      assert.equal(make().outbound.enabled, false, id);
      assert.equal(make().outbound.proposition, null, id);
    }
  });

  it("keeps outbound propositions apart when they are actually set", async () => {
    const now = clock();
    const authority = createBlueprintAuthority({ store: createInMemoryBlueprintStore(), now });
    for (const { id, make } of CLIENTS) {
      const bp = make();
      bp.outbound = {
        ...bp.outbound, enabled: true,
        proposition: `a proposition belonging only to ${id}`,
        disclosureWording: "This is an AI assistant calling on behalf of the business.",
        optOutWording: "Say the word and we will never call again.",
      };
      const draft = await authority.createDraft({ clientId: id, blueprint: bp, createdBy: "auditor" });
      assert.equal(draft.ok, true);
    }
    for (const { id } of CLIENTS) {
      const listed = await authority.listVersions(id);
      const got = await authority.getDraft(id, listed.versions[0].configVersion);
      assert.equal(got.version.outbound.proposition, `a proposition belonging only to ${id}`);
    }
  });

  it("proves the MAY_COINCIDE dimensions are independent, not merely equal", async () => {
    // Two clients share the voice reference `warm_female_au`. Changing one
    // must not move the other — that is what isolation means here.
    const now = clock();
    const authority = createBlueprintAuthority({ store: createInMemoryBlueprintStore(), now });
    for (const { id, make } of CLIENTS) {
      await authority.createDraft({ clientId: id, blueprint: make(), createdBy: "auditor" });
    }

    const before = {};
    for (const { id } of CLIENTS) before[id] = (await authority.getDraft(id, 1)).version.voice.profileRef;
    assert.equal(before.northside_locks, before.riverside_plumbing, "these two genuinely share a voice today");

    await authority.updateDraft({
      clientId: "northside_locks", configVersion: 1,
      mutate: (bp) => { bp.voice.profileRef = "a_completely_different_voice"; }, updatedBy: "auditor",
    });

    assert.equal((await authority.getDraft("northside_locks", 1)).version.voice.profileRef, "a_completely_different_voice");
    for (const { id } of CLIENTS.filter((c) => c.id !== "northside_locks")) {
      assert.equal(
        (await authority.getDraft(id, 1)).version.voice.profileRef,
        before[id],
        `${id}'s voice moved when another client's did`,
      );
    }

    // Same for capabilities: enabling one for a client must not enable it elsewhere.
    await authority.updateDraft({
      clientId: "northside_locks", configVersion: 1,
      mutate: (bp) => { bp.integrations = [...bp.integrations, { capability: "webhook", enabled: true, adapterRef: null, notes: null }]; },
      updatedBy: "auditor",
    });
    for (const { id } of CLIENTS.filter((c) => c.id !== "northside_locks")) {
      const caps = (await authority.getDraft(id, 1)).version.integrations.map((i) => i.capability);
      assert.ok(!caps.includes("webhook"), `${id} gained a capability another client enabled`);
    }
  });

  it("gives no client another client's service area", () => {
    // Compared as LISTS. Two Melbourne businesses legitimately both say
    // "Melbourne" somewhere — A as a region, B as a suburb — and a raw
    // substring sweep over the prompt reads that coincidence as a leak.
    for (const a of CLIENTS) {
      const spec = compileBehaviourSpec(a.make()).spec;
      for (const b of CLIENTS) {
        if (a.id === b.id) continue;
        const other = compileBehaviourSpec(b.make()).spec;
        const sharedSuburbs = spec.serviceArea.suburbs.filter((s) => other.serviceArea.suburbs.includes(s));
        assert.deepEqual(sharedSuburbs, [], `${a.id} and ${b.id} share suburbs: ${sharedSuburbs.join(", ")}`);
        const sharedPostcodes = spec.serviceArea.postcodes.filter((p) => other.serviceArea.postcodes.includes(p));
        assert.deepEqual(sharedPostcodes, [], `${a.id} and ${b.id} share postcodes: ${sharedPostcodes.join(", ")}`);
      }
    }
  });

  it("compiles a suburb line that lists only that client's own suburbs", () => {
    for (const a of CLIENTS) {
      const prompt = preview(a.make()).responseEngine.general_prompt;
      const line = prompt.split("\n").find((l) => l.startsWith("Suburbs: "));
      assert.ok(line, `${a.id} has no suburb line`);
      const listed = line.slice("Suburbs: ".length).split(", ");
      assert.deepEqual([...listed].sort(), [...a.make().serviceArea.suburbs].sort());
    }
  });

  it("compiles three prompts that name no other client's business or transfer number", () => {
    for (const a of CLIENTS) {
      const prompt = preview(a.make()).responseEngine.general_prompt;
      for (const b of CLIENTS) {
        if (a.id === b.id) continue;
        const other = b.make();
        assert.ok(!prompt.includes(other.identity.tradingName), `${a.id} names ${b.id}`);
        assert.ok(!prompt.includes(other.identity.legalName), `${a.id} names ${b.id}'s legal name`);
        assert.ok(!prompt.includes(other.identity.assistantName), `${a.id} names ${b.id}'s assistant`);
        for (const number of [other.callHandling.escalation.primaryNumber, other.callHandling.escalation.backupNumber]) {
          if (number) assert.ok(!prompt.includes(number), `${a.id} carries ${b.id}'s number ${number}`);
        }
        for (const fact of other.knowledge.approvedFacts) {
          assert.ok(!prompt.includes(fact.statement), `${a.id} states ${b.id}'s fact`);
        }
      }
    }
  });

  it("gives the two SAME-TRADE locksmiths as much separation as two different trades", () => {
    const a = compileBehaviourSpec(locksmithA()).spec;
    const b = compileBehaviourSpec(locksmithB()).spec;
    assert.equal(a.business.vertical, b.business.vertical, "same trade");
    const shared = a.services.map((s) => s.serviceId).filter((id) => b.services.some((s) => s.serviceId === id));
    assert.deepEqual(shared, [], "and yet not one shared service");
  });
});

// ════════════════════════════════════════════════════════════════════
// RATCHETS — the four that were narrowed, proven non-vacuous
// ════════════════════════════════════════════════════════════════════
//
// These read the matchers OUT OF the boundaries test file and exercise those.
// Re-declaring copies here would pass forever while the real ratchet rotted.

describe("P13 ratchets — narrowed, and still with teeth", () => {
  const BOUNDARIES = fs.readFileSync(path.join(ROOT, "test", "platform-boundaries.test.js"), "utf8");

  /**
   * Pull a regex literal out of the boundaries file by the line it lives on,
   * so this audit exercises the REAL matcher. `(?:\\.|[^/\\])` steps over an
   * escaped slash — `REJECTION_DECLARATION` contains two of them, and a lazy
   * `.+?` stops at the first backslash-slash and yields nonsense.
   */
  function matcherFrom(anchor) {
    const line = BOUNDARIES.split("\n").find((l) => l.includes(anchor));
    assert.ok(line, `the boundaries test no longer contains: ${anchor}`);
    const literal = line.match(/\/((?:\\.|\[[^\]]*\]|[^/\\[])+)\/([gimsuy]*)/);
    assert.ok(literal, `could not read a regex from: ${line.trim()}`);
    return new RegExp(literal[1], literal[2]);
  }

  it("can genuinely read the matchers out of the boundaries file", () => {
    // If extraction silently failed this whole block would be vacuous, so
    // prove it recovered each one exactly.
    assert.equal(String(matcherFrom("compares vertical to a value")), String(/vertical\s*[=!]==/));
    assert.equal(String(matcherFrom("switches on vertical")), String(/switch\s*\(\s*[\w.]*vertical/));
    assert.equal(String(matcherFrom("looks something up by vertical")), String(/\[\s*[\w.]*vertical\s*\]/));
    assert.equal(String(matcherFrom("const REJECTION_DECLARATION")), String(/const PROVIDER_VOICE_ID_PREFIXES = \/[^\n]*\/i;/));
    assert.ok(String(matcherFrom("const ACTING = ")).includes("authorise"));
  });

  // ── RATCHET 1: no behaviour selected from a vertical ──────────────
  describe("1. vertical branching — protects: a plumber differs by CONFIGURATION, never by a code path", () => {
    const compare = matcherFrom("compares vertical to a value");
    const switchOn = matcherFrom("switches on vertical");
    const lookup = matcherFrom("looks something up by vertical");
    const caught = (s) => compare.test(s) || switchOn.test(s) || lookup.test(s);

    it("catches every shape of intentionally bad code", () => {
      for (const bad of [
        'if (vertical === "plumber") { specialCase(); }',
        'if (bp.identity.vertical !== "locksmith") return;',
        "switch (vertical) { case 'plumbing': break; }",
        "switch (bp.identity.vertical) { default: break; }",
        "const rules = BY_TRADE[vertical];",
        "const rules = BY_TRADE[bp.identity.vertical];",
        'const x = vertical === "hvac" ? a : b;',
      ]) {
        assert.ok(caught(bad), `would NOT catch: ${bad}`);
      }
    });

    it("does not reject the intended implementation — reading and validating the field is fine", () => {
      for (const fine of [
        "if (!isStr(id.vertical) || !SLUG.test(id.vertical)) err('identity.vertical', 'required');",
        "return emptyBlueprint({ clientId, vertical });",
        "version.identity = { ...version.identity, clientId, vertical };",
        "vertical: id.vertical ?? null,",
        "function migrateLocksmithProfile(legacy, { vertical = 'locksmith' } = {}) {",
      ]) {
        assert.ok(!caught(fine), `wrongly rejects: ${fine}`);
      }
    });

    it("is the matcher the real ratchet uses, not a copy", () => {
      assert.ok(BOUNDARIES.includes(compare.source.replace(/\\\\/g, "\\")) || BOUNDARIES.includes(String(compare)));
    });
  });

  // ── RATCHET 2: only one module knows what Retell is ───────────────
  describe("2. provider naming — protects: the domain must not depend on a vendor", () => {
    const exemption = matcherFrom("const REJECTION_DECLARATION");

    it("exempts exactly one declaration, and it still exists as written", () => {
      const blueprint = fs.readFileSync(path.join(ROOT, "src", "platform", "client-blueprint.js"), "utf8");
      assert.match(blueprint, exemption, "the exempted declaration is gone or reworded");
      assert.equal(
        blueprint.split("\n").filter((l) => exemption.test(l)).length,
        1,
        "the exemption must cover one line, not become a licence",
      );
    });

    it("the exempted declaration is a REFUSAL, and it still refuses", () => {
      for (const providerId of ["retell-sunny", "11labs-Adrian", "custom_voice_abc", "cartesia-x", "openai-alloy"]) {
        const bp = locksmithA();
        bp.voice.profileRef = providerId;
        assert.ok(
          validateBlueprint(bp).errors.some((e) => e.path === "voice.profileRef"),
          `"${providerId}" should be refused`,
        );
      }
    });

    it("exempting it does not blind the ratchet to a SECOND mention", () => {
      const smuggled = "const PROVIDER_VOICE_ID_PREFIXES = /^(retell-)/i;\nconst client = makeRetellClient();";
      assert.ok(smuggled.replace(exemption, "").toLowerCase().includes("retell"), "a second mention must survive");
    });

    it("does not reject the intended implementation — a provider-independent ref is accepted", () => {
      const bp = locksmithA();
      bp.voice.profileRef = "warm_female_au";
      assert.equal(validateBlueprint(bp).ok, true);
    });
  });

  // ── RATCHET 3: no acting export ───────────────────────────────────
  describe("3. acting exports — protects: configuration exposes nothing that could DO something", () => {
    const acting = matcherFrom("const ACTING = ");

    it("catches an acting export, including the authoriseDial case the first version missed", () => {
      for (const bad of [
        "dialProspect", "sendSms", "provisionAgent", "enableCalling", "disableSuppression",
        "suppressBusiness", "washDncrList", "deployAgent", "publishConfig", "postPayload",
        // The specific miss: the old matcher was the STEM `authoris`, which then
        // required [A-Z] or end-of-string. The next character is a lowercase
        // "e", so `authoriseDial` slipped straight through.
        "authoriseDial", "authorizeDial", "authorise", "authorize",
        "authorisationGrant", "authorizationGrant",
      ]) {
        assert.ok(acting.test(bad), `would NOT catch "${bad}"`);
      }
    });

    it("does not reject a vocabulary constant or an ordinary name", () => {
      for (const fine of [
        "CALLER_INFO_FIELDS", "CALLING_HOURS", "compileBehaviourSpec", "compileRetellPreview",
        "postcodeOf", "sender", "provisional", "enabledCapabilities", "washingtonSuburbs",
        "validateBlueprint", "createBlueprintAuthority", "proposeConfigPatch", "diffBlueprints",
      ]) {
        assert.ok(!acting.test(fine), `wrongly rejects "${fine}"`);
      }
    });

    it("the real platform surface passes it", () => {
      const MODULES = [
        "client-blueprint", "blueprint-authority", "blueprint-diff", "config-patch",
        "behaviour-spec", "provider-compiler-retell", "migrate-locksmith-profile",
        "integrations", "client-cli",
      ];
      for (const name of MODULES) {
        const mod = require(`../src/platform/${name}`);
        for (const [exported, value] of Object.entries(mod)) {
          if (typeof value !== "function") continue;
          assert.ok(!acting.test(exported), `${name} exports "${exported}"`);
        }
      }
    });

    it("the old broken stem is genuinely no longer in use", () => {
      const OLD = /^(dial|call|send|post|provision|deploy|publish|enable|disable|suppress|wash|authoris|authoriz)([A-Z]|$)/;
      assert.equal(OLD.test("authoriseDial"), false, "the old matcher missed it");
      assert.equal(acting.test("authoriseDial"), true, "the current one catches it");
      assert.ok(!BOUNDARIES.includes("|authoris|authoriz)"), "the broken stem must be gone from the file");
    });
  });

  // ── RATCHET 4: no trade name in a code literal ────────────────────
  describe("4. trade literals — protects: the platform cannot hardcode a business it grew from", () => {
    it("catches a trade smuggled into a code literal", () => {
      const literalsIn = (code) => [...code.matchAll(/["'`]([^"'`\n]*)["'`]/g)].map((m) => m[1]);
      const TRADES = ["locksmith", "lockout", "plumber", "plumbing", "garage", "electrician", "drain", "rekey"];
      const caught = (code) =>
        literalsIn(code).some((lit) => TRADES.some((t) => lit.toLowerCase().includes(t)));

      for (const bad of [
        'const DEFAULT = "residential_lockout";',
        "const label = `a plumbing job`;",
        "if (name === 'locksmith') {}",
      ]) {
        assert.ok(caught(bad), `would NOT catch: ${bad}`);
      }
      for (const fine of [
        'const DEFAULT = "caller_name";',
        "const label = `a job`;",
        'err("services", "at least one service is required");',
      ]) {
        assert.ok(!caught(fine), `wrongly rejects: ${fine}`);
      }
    });

    it("names its two exemptions explicitly rather than pattern-matching them away", () => {
      assert.ok(BOUNDARIES.includes('rel(file).includes("/fixtures/")'), "the fixtures exemption must be by path");
      assert.ok(BOUNDARIES.includes('rel(file).endsWith("migrate-locksmith-profile.js")'), "the adapter exemption must be by name");
    });

    it("holds the legacy adapter to the rule that matters even though it is exempt", () => {
      const adapter = fs.readFileSync(path.join(ROOT, "src", "platform", "migrate-locksmith-profile.js"), "utf8");
      assert.ok(!/vertical\s*[=!]==/.test(adapter), "the exempt file still may not branch on a vertical");
    });
  });

  it("every ratchet in the boundaries file is paired with a non-vacuity proof", () => {
    // The rule that keeps this honest: a narrow matcher must be demonstrated
    // to bite. Three "would catch" companions live in the boundaries file
    // itself; the rest are above.
    assert.ok(BOUNDARIES.includes("would catch a vertical branch if one were added"));
    assert.ok(BOUNDARIES.includes("would catch an acting export if one were added"));
    assert.ok(BOUNDARIES.includes("keeps that one exemption real, and narrow"));
    assert.ok(BOUNDARIES.includes("leaves no file unlayered"));
  });
});

// ════════════════════════════════════════════════════════════════════
// ARCHITECTURE — the chain, end to end, in one place
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// AI DISCLOSURE — classified, not quietly resolved
// ════════════════════════════════════════════════════════════════════
//
// The platform is STRICTER than what AIDA ships: it puts the disclosure in the
// first spoken sentence for every client, where the existing inbound
// receptionist uses the client's own greeting verbatim. That is a change to
// what a real caller hears, so it is flagged for a founder ruling rather than
// decided here — and deliberately not resolved by making it configurable.

describe("P13 AI disclosure — flagged for founder ruling, not silently redesigned", () => {
  const PLATFORM_DOC = fs.readFileSync(path.join(ROOT, "docs", "AIDA_CLIENT_PLATFORM.md"), "utf8");
  const CHECKLIST = fs.readFileSync(path.join(ROOT, "docs", "NEW_CLIENT_IMPLEMENTATION_CHECKLIST.md"), "utf8");

  it("the existing INBOUND receptionist genuinely does not disclose in its opening line", () => {
    // The premise of the whole flag. If this ever stops being true, the
    // divergence has been resolved and the doc section should go.
    const compiler = fs.readFileSync(path.join(ROOT, "src", "services", "locksmith-receptionist-compiler.js"), "utf8");
    assert.match(compiler, /begin_message:\s*spec\.identity\.greeting/, "inbound speaks the client's own greeting");

    require("../src/services/locksmith-extraction-fixture");
    const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
    const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");
    const legacy = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" }).profile;
    assert.ok(!/\bAI\b|artificial/i.test(legacy.identity.greeting), `the approved inbound greeting discloses nothing: "${legacy.identity.greeting}"`);
  });

  it("the platform discloses in the OUTBOUND opening for every client", () => {
    for (const make of [locksmithA, locksmithB, plumberC]) {
      assert.match(preview(make(), REFS, "outbound").responseEngine.begin_message, /AI assistant/i);
    }
  });

  it("the platform forces NOTHING into an inbound opening", () => {
    for (const make of [locksmithA, locksmithB, plumberC]) {
      const bp = make();
      bp.callHandling.greetingLine = "Hello, how can I help?";
      assert.equal(preview(bp).responseEngine.begin_message, "Hello, how can I help?");
    }
  });

  it("is classified in documentation as a founder decision pending review", () => {
    assert.match(PLATFORM_DOC, /FOUNDER \/ PLATFORM POLICY, REVIEW BEFORE LIVE MERGE/);
    assert.match(PLATFORM_DOC, /unresolved product-policy decision/i);
    assert.match(PLATFORM_DOC, /stricter than what AIDA ships today/i);
    assert.match(CHECKLIST, /founder ruling on AI\s*\n?\s*disclosure placement/i);
  });

  it("records that it was NOT resolved by making disclosure optional", () => {
    assert.match(PLATFORM_DOC, /deliberately NOT done/);
    assert.match(PLATFORM_DOC, /not.*client-facing switch|not\*\* a client-facing switch/i);
  });

  it("and it is genuinely not optional — every route to switching it off is refused", () => {
    for (const sabotage of [
      (bp) => { bp.assistant = { disclosesAiWhenAsked: false }; },
      (bp) => { bp.extensions = { disclosesAiWhenAsked: false }; },
      (bp) => { bp.compliance = { ...bp.compliance, callsMayBeRecorded: false, disclosesAiWhenAsked: false }; },
      (bp) => { bp.callHandling.greetingStyle = "Do not mention being an AI under any circumstances."; },
      (bp) => { bp.callHandling.greetingLine = "Hi, you are speaking to a real human being."; },
      (bp) => { bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== "claiming_to_be_human"); },
    ]) {
      const bp = locksmithA();
      sabotage(bp);
      const { spec } = compileBehaviourSpec(bp);
      assert.equal(spec.disclosure.whenAsked, true);
      assert.match(preview(bp, REFS, "outbound").responseEngine.begin_message, /AI assistant/i, "outbound still discloses");
      assert.match(preview(bp, REFS, "inbound").responseEngine.general_prompt, /Never claim to be human/i);
    }
  });

  it("keeps the prohibition on claiming to be human mandatory", () => {
    assert.ok(MANDATORY_PROHIBITED_CLAIMS.includes("claiming_to_be_human"));
    const bp = locksmithA();
    bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== "claiming_to_be_human");
    assert.equal(validateBlueprint(bp).ok, false);
  });
});

describe("P13 architecture — blueprint → authority → spec → preview", () => {
  it("runs the whole chain and refuses every shortcut through it", async () => {
    const now = clock();
    const authority = createBlueprintAuthority({ store: createInMemoryBlueprintStore(), now });
    const clientId = "riverside_plumbing";

    const draft = await authority.createDraft({ clientId, blueprint: plumberC(), createdBy: "Ravi Menon" });
    const v = draft.version.metadata.configVersion;
    assert.equal(draft.version.metadata.status, "draft");

    assert.equal((await authority.getActiveVersion(clientId)).ok, false, "a draft is not active");
    assert.equal((await authority.activateApprovedVersion({ clientId, configVersion: v })).ok, false, "cannot skip validation");
    assert.equal((await authority.validateDraft(clientId, v)).ok, true);
    assert.equal((await authority.activateApprovedVersion({ clientId, configVersion: v })).ok, false, "validated is not approved");
    assert.equal((await authority.approveDraft({ clientId, configVersion: v, approvedBy: "system" })).ok, false, "a machine cannot approve");
    assert.equal((await authority.approveDraft({ clientId, configVersion: v, approvedBy: "Ravi Menon" })).ok, true);
    assert.equal((await authority.getActiveVersion(clientId)).ok, false, "approval is not activation");
    assert.equal((await authority.activateApprovedVersion({ clientId, configVersion: v, activatedBy: "Ravi Menon" })).ok, true);

    const active = await authority.getActiveVersion(clientId);
    const { spec, behaviourHash } = compileBehaviourSpec(active.version);
    assert.match(behaviourHash, /^[0-9a-f]{64}$/);
    const out = compileRetellPreview({ spec, providerRefs: REFS });
    assert.equal(out.ready, true);

    // A diff exists at every step a person would be asked to approve.
    const nextDraft = await authority.createDraft({ clientId, blueprint: plumberC(), createdBy: "Ravi Menon" });
    const diff = await authority.diffDraft({ clientId, toVersion: nextDraft.version.metadata.configVersion });
    assert.equal(diff.ok, true);
    assert.equal(typeof diff.diff.hasChanges, "boolean");
  });

  it("the provider compiler imports nothing that could open a socket", () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "platform", "provider-compiler-retell.js"), "utf8");
    const imports = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./behaviour-spec", "crypto"]);
    for (const reach of ["fetch(", "XMLHttpRequest", "http.request", "https.request", "process.env"]) {
      assert.ok(!source.includes(reach), `the compiler contains ${reach}`);
    }
  });

  it("a compiled preview is inert — it carries no instruction to send it anywhere", () => {
    const out = preview(plumberC());
    assert.equal(typeof out.responseEngine, "object");
    assert.equal(typeof out.agent, "object");
    for (const key of Object.keys(out)) {
      assert.notEqual(typeof out[key], "function", `preview exposes a callable "${key}"`);
    }
  });
});
