// AIDA PLATFORM P7 — the existing locksmith, on the platform, unchanged.
//
// The input is not an invented example. It is the profile the SHIPPED
// extraction adapter produces from the demonstration interview — the same
// object the existing receptionist compiler builds a real agent from. A generic
// model that cannot express the business it was generalised from is not
// generic, it is just different.
//
// Two things are under test:
//
//   PARITY      every fact the old profile carried survives, in the new shape
//   HONESTY     everything that did NOT survive cleanly is reported, by name
//
// A migration that returns a clean blueprint and an empty report is lying about
// at least one of them.

const { describe, it } = require("node:test");
const assert = require("node:assert");

require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");
const { validateProfile, assessProvisioning } = require("../src/services/locksmith-profile");

const { migrateLocksmithProfile, MIGRATION_VERSION, slugify } = require("../src/platform/migrate-locksmith-profile");
const { validateBlueprint } = require("../src/platform/client-blueprint");
const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
const { compileRetellPreview } = require("../src/platform/provider-compiler-retell");
const { createBlueprintAuthority, createInMemoryBlueprintStore } = require("../src/platform/blueprint-authority");

/** The real thing, built deterministically so tests and shipped code cannot drift. */
function legacyProfile() {
  const result = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
  assert.equal(result.ok, true, "the shipped fixture must produce a valid profile");
  return JSON.parse(JSON.stringify(result.profile));
}

const migrated = () => migrateLocksmithProfile(legacyProfile());

describe("locksmith parity — the source profile is genuinely the shipped one", () => {
  it("validates and is provisioning-ready under the OLD rules", () => {
    const legacy = legacyProfile();
    assert.equal(validateProfile(legacy).ok, true, "this must be a profile the existing system accepts");
    const { ready, blockers } = assessProvisioning(legacy);
    assert.equal(ready, true, JSON.stringify(blockers));
  });

  it("is left completely untouched by the migration", () => {
    const legacy = legacyProfile();
    const snapshot = JSON.stringify(legacy);
    migrateLocksmithProfile(legacy);
    assert.equal(JSON.stringify(legacy), snapshot);
  });
});

describe("locksmith parity — it migrates to a valid blueprint", () => {
  it("produces a blueprint the platform accepts", () => {
    const result = migrated();
    assert.equal(result.ok, true);
    assert.equal(result.migrationVersion, MIGRATION_VERSION);
    const validation = validateBlueprint(result.blueprint);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 1));
  });

  it("refuses anything that is not a profile", () => {
    for (const junk of [null, undefined, 42, "profile", []]) {
      const result = migrateLocksmithProfile(junk);
      assert.equal(result.ok, false);
      assert.equal(result.blueprint, null);
    }
  });

  it("produces a DRAFT, because importing is not approving", () => {
    const result = migrated();
    assert.equal(result.blueprint.metadata.status, "draft");
    assert.equal(result.blueprint.metadata.source, "import");
    assert.equal(result.requiresHumanReview, true);
    assert.equal(result.blueprint.metadata.approvedBy, null);
    assert.equal(result.blueprint.metadata.activatedAt, null);
  });
});

describe("locksmith parity — identity", () => {
  it("carries the names the caller hears", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.equal(blueprint.identity.legalName, legacy.identity.legalName);
    assert.equal(blueprint.identity.tradingName, legacy.identity.spokenName);
    assert.equal(blueprint.identity.assistantName, legacy.identity.receptionistName);
    assert.equal(blueprint.identity.timezone, legacy.identity.timezone);
    assert.equal(blueprint.identity.description, legacy.identity.description);
  });

  it("slugifies a clientId that was not one, and says so rather than doing it quietly", () => {
    const { blueprint, notes } = migrated();
    assert.equal(blueprint.identity.clientId, "demo_locksmith");
    assert.ok(notes.some((n) => n.path === "identity.clientId" && /join/i.test(n.message)));
  });

  it("keeps the vertical nameable rather than assumed", () => {
    assert.equal(migrated().blueprint.identity.vertical, "locksmith");
    const asOther = migrateLocksmithProfile(legacyProfile(), { vertical: "security_services" });
    assert.equal(asOther.blueprint.identity.vertical, "security_services");
  });
});

describe("locksmith parity — services", () => {
  it("carries every accepted service with its public name", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    for (const s of legacy.servicesAccepted) {
      const found = blueprint.services.find((x) => x.serviceId === s.serviceId);
      assert.ok(found, `${s.serviceId} must survive`);
      assert.equal(found.name, s.publicName);
      assert.equal(found.enabled, true);
      assert.equal(found.description, s.notes ?? null);
    }
  });

  it("keeps every declined service as a disabled one carrying its reason", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.ok(legacy.servicesDeclined.length > 0, "the demo profile declines real services");
    for (const d of legacy.servicesDeclined) {
      const found = blueprint.services.find((x) => x.serviceId === d.serviceId);
      assert.ok(found, `${d.serviceId} must survive as a declined service`);
      assert.equal(found.enabled, false);
      assert.ok(found.description.includes(d.reason), "the reason must survive too");
    }
  });

  it("does not promote a may-be-urgent service past urgent", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    for (const s of legacy.servicesAccepted) {
      const found = blueprint.services.find((x) => x.serviceId === s.serviceId);
      assert.equal(found.urgencyCategory, s.mayBeUrgent ? "urgent" : "standard");
      assert.notEqual(found.urgencyCategory, "emergency", "nothing may be promoted automatically");
    }
  });

  it("loses no service at all, in either direction", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    const expected = new Set([
      ...legacy.servicesAccepted.map((s) => s.serviceId),
      ...legacy.servicesDeclined.map((s) => s.serviceId),
    ]);
    assert.deepEqual(new Set(blueprint.services.map((s) => s.serviceId)), expected);
  });
});

describe("locksmith parity — where it works and when", () => {
  it("carries every suburb, primary and extended", () => {
    const legacy = legacyProfile();
    const { blueprint, notes } = migrated();
    for (const suburb of [...legacy.serviceAreas.primary, ...legacy.serviceAreas.extended]) {
      assert.ok(blueprint.serviceArea.suburbs.includes(suburb), `${suburb} must survive`);
    }
    assert.ok(notes.some((n) => n.path === "serviceAreas.extended"), "merging two lists into one is a change worth stating");
  });

  it("carries every declined area as an exclusion", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.deepEqual(blueprint.serviceArea.exclusions, legacy.serviceAreas.declined);
  });

  it("carries the hours exactly", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.deepEqual(blueprint.hours.weekly, legacy.hours.ordinary);
    assert.equal(blueprint.hours.timezone, legacy.hours.timezone);
    assert.equal(blueprint.hours.afterHours.available, legacy.hours.afterHoursAvailable);
    assert.equal(blueprint.hours.afterHours.policy, legacy.hours.afterHoursNote);
    assert.deepEqual(blueprint.hours.publicHolidays, legacy.hours.publicHolidays);
  });

  it("reports a different after-hours service area rather than losing it", () => {
    const legacy = legacyProfile();
    legacy.serviceAreas.afterHoursAreas = ["Preston"]; // narrower than primary
    const result = migrateLocksmithProfile(legacy);
    assert.ok(result.unmapped.some((u) => u.path === "serviceAreas.afterHoursAreas"));
  });

  it("says nothing about after-hours areas when they match the primary list", () => {
    const result = migrated(); // the demo profile's after-hours areas equal primary
    assert.ok(!result.unmapped.some((u) => u.path === "serviceAreas.afterHoursAreas"));
  });

  it("reports per-service hours rather than losing them", () => {
    const legacy = legacyProfile();
    legacy.hours.byService = { key_cutting: { monday: { open: "09:00", close: "16:00" } } };
    const result = migrateLocksmithProfile(legacy);
    assert.ok(result.unmapped.some((u) => u.path === "hours.byService"));
  });
});

describe("locksmith parity — urgency and transfer, the safety-critical parts", () => {
  it("carries every urgency rule with its condition, level, action and words", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.equal(blueprint.callHandling.urgencyRules.length, legacy.urgencyRules.length);
    for (const r of legacy.urgencyRules) {
      const found = blueprint.callHandling.urgencyRules.find((x) => x.ruleId === r.ruleId);
      assert.ok(found, `${r.ruleId} must survive`);
      assert.equal(found.when, r.condition);
      assert.equal(found.action, r.action);
      assert.equal(found.transferEligible, r.transferEligible);
      assert.equal(found.wording, r.approvedWording);
    }
  });

  it("maps every legacy urgency level to itself, promoting nothing", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    for (const r of legacy.urgencyRules) {
      const found = blueprint.callHandling.urgencyRules.find((x) => x.ruleId === r.ruleId);
      assert.equal(found.level, r.classification, `${r.ruleId} must keep its level`);
    }
    assert.ok(!blueprint.callHandling.urgencyRules.some((r) => r.level === "emergency"));
  });

  it("flags that a new level exists above urgent, for a person to consider", () => {
    const { notes } = migrated();
    assert.ok(notes.some((n) => n.path === "urgencyRules" && /emergency/.test(n.message)));
  });

  it("carries the transfer configuration exactly", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    const esc = blueprint.callHandling.escalation;
    assert.equal(esc.primaryNumber, legacy.transfer.primaryNumber);
    assert.equal(esc.backupNumber, legacy.transfer.backupNumber);
    assert.deepEqual(esc.permittedHours, legacy.transfer.permittedHours);
    assert.deepEqual(esc.eligibleServices, legacy.transfer.eligibleServices);
    assert.equal(esc.minimumUrgency, legacy.transfer.requiredUrgency);
    assert.equal(esc.timeoutSeconds, legacy.transfer.timeoutSeconds);
    assert.equal(esc.preTransferWording, legacy.transfer.preTransferWording);
    assert.equal(esc.unansweredAction, legacy.transfer.unansweredAction);
    assert.equal(esc.maxAttempts, legacy.transfer.maxAttempts);
  });

  it("reports collect-before-transfer rather than silently discarding it", () => {
    const { unmapped } = migrated();
    assert.ok(unmapped.some((u) => u.path === "transfer.collectDetailsFirst"));
  });

  it("reports every per-rule notification priority rather than losing it", () => {
    const legacy = legacyProfile();
    const { unmapped } = migrated();
    for (const r of legacy.urgencyRules) {
      assert.ok(
        unmapped.some((u) => u.path === `urgencyRules.${r.ruleId}.notificationPriority`),
        `${r.ruleId}'s notification priority must be reported`,
      );
    }
  });
});

describe("locksmith parity — what the assistant collects", () => {
  it("carries every always-collected field, mapped or as an explicit question", () => {
    const legacy = legacyProfile();
    const { blueprint, notes } = migrated();
    const asked = [
      ...blueprint.callHandling.collectAlways,
      ...blueprint.callHandling.additionalQuestions.map((q) => q.id),
    ];
    const DIRECT = { street_address: "service_address", desired_timing: "preferred_time" };
    for (const field of legacy.callerInfo.always) {
      const expected = DIRECT[field] || field;
      assert.ok(asked.includes(expected), `${field} must still be asked for (as ${expected})`);
    }
    // The two with no platform column must be reported, not silently reshaped.
    for (const carried of ["property_secure", "proof_of_ownership_reminder"]) {
      assert.ok(notes.some((n) => n.path === `callerInfo.${carried}`), `${carried} must be reported as reshaped`);
    }
  });

  it("carries per-service collection from each service's mustCollect", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    const lockout = legacy.servicesAccepted.find((s) => s.serviceId === "residential_lockout");
    assert.ok(lockout.mustCollect.includes("street_address"));

    const always = blueprint.callHandling.collectAlways;
    const perService = blueprint.callHandling.collectByService.residential_lockout || [];
    // street_address maps to service_address, which the demo also collects
    // always — so it belongs in one list or the other, never neither.
    assert.ok(
      always.includes("service_address") || perService.includes("service_address"),
      "the address must still be collected for a lockout",
    );
  });

  it("never lists a field in both the always list and a per-service list", () => {
    const { blueprint } = migrated();
    const always = new Set(blueprint.callHandling.collectAlways);
    for (const [sid, fields] of Object.entries(blueprint.callHandling.collectByService)) {
      for (const f of fields) assert.ok(!always.has(f), `${sid} repeats "${f}" which is already always collected`);
    }
  });

  it("carries the legacy greeting VERBATIM as the inbound opening line", () => {
    // Founder ruling 2026-08-16: an inbound receptionist keeps its own words.
    const legacy = legacyProfile();
    const { blueprint, notes } = migrated();
    assert.equal(blueprint.callHandling.greetingLine, legacy.identity.greeting);
    assert.equal(blueprint.callHandling.greetingStyle, null, "it is words, not a style instruction");
    assert.ok(notes.some((n) => n.path === "identity.greeting" && /verbatim/i.test(n.message)));
  });

  it("speaks a byte-identical inbound opening to the shipped receptionist", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    const { spec } = compileBehaviourSpec(blueprint);
    const inbound = compileRetellPreview({
      spec, direction: "inbound",
      providerRefs: { llmId: "l", voiceId: "v", webhookUrl: "https://example.invalid/h" },
    });
    assert.equal(inbound.responseEngine.begin_message, legacy.identity.greeting);
    assert.ok(!/AI assistant/i.test(inbound.responseEngine.begin_message), "no forced inbound disclosure");
  });

  it("still discloses in the OUTBOUND opening for the same client", () => {
    const { blueprint } = migrated();
    const { spec } = compileBehaviourSpec(blueprint);
    const outbound = compileRetellPreview({
      spec, direction: "outbound",
      providerRefs: { llmId: "l", voiceId: "v", webhookUrl: "https://example.invalid/h" },
    });
    assert.match(outbound.responseEngine.begin_message, /AI assistant/i);
  });
});

describe("locksmith parity — what the assistant must never say", () => {
  it("keeps every enabled forbidden promise as a prohibited claim", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    for (const p of legacy.forbiddenPromises) {
      if (p.enabled === false) continue;
      assert.ok(
        blueprint.knowledge.prohibitedClaims.includes(p.promiseId),
        `"${p.promiseId}" must survive as a prohibition`,
      );
    }
  });

  it("adds the platform's mandatory prohibitions on top rather than instead", () => {
    const { blueprint } = migrated();
    const { MANDATORY_PROHIBITED_CLAIMS } = require("../src/platform/client-blueprint");
    for (const must of MANDATORY_PROHIBITED_CLAIMS) {
      assert.ok(blueprint.knowledge.prohibitedClaims.includes(must), `${must} must be present`);
    }
    assert.ok(
      blueprint.knowledge.prohibitedClaims.length > MANDATORY_PROHIBITED_CLAIMS.length,
      "the locksmith's own prohibitions must survive too",
    );
  });

  it("drops a forbidden promise the owner had explicitly disabled", () => {
    const legacy = legacyProfile();
    legacy.forbiddenPromises = legacy.forbiddenPromises.map((p) =>
      p.promiseId === "guaranteed_arrival_time" ? { ...p, enabled: false } : p,
    );
    const { blueprint } = migrateLocksmithProfile(legacy);
    // ...but the PLATFORM's own mandatory version of that claim stays, because
    // a client may not remove one.
    assert.ok(blueprint.knowledge.prohibitedClaims.includes("guaranteed_arrival_time"));
  });

  it("carries the pricing never-state list into prohibitions", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.ok(legacy.pricing.neverState.length > 0);
    for (const never of legacy.pricing.neverState) {
      assert.ok(
        blueprint.knowledge.prohibitedClaims.includes(slugify(never)),
        `"${never}" must survive as a prohibition`,
      );
    }
  });

  it("reads a may-not-mention-pricing profile as never_discuss", () => {
    const legacy = legacyProfile();
    assert.equal(legacy.pricing.mayMentionPricing, false);
    const { blueprint } = migrated();
    assert.equal(blueprint.knowledge.pricingDisclosure, "never_discuss");
    assert.equal(blueprint.knowledge.pricingWording, legacy.pricing.disclaimer);
  });

  it("reads the other pricing shapes correctly", () => {
    const cases = [
      [{ mayMentionPricing: true, calloutWording: "The call-out is $99.", indicativePrices: [], neverState: [] }, "callout_fee_only"],
      [{ mayMentionPricing: true, indicativePrices: [{ serviceId: "rekeying", wording: "$150-$250" }], neverState: [] }, "indicative_ranges"],
      [{ mayMentionPricing: true, indicativePrices: [], neverState: [] }, "confirmed_at_booking"],
    ];
    for (const [pricing, expected] of cases) {
      const legacy = legacyProfile();
      legacy.pricing = { ...legacy.pricing, ...pricing, mayMentionPricing: pricing.mayMentionPricing, calloutWording: pricing.calloutWording ?? null };
      assert.equal(migrateLocksmithProfile(legacy).blueprint.knowledge.pricingDisclosure, expected);
    }
  });

  it("falls back to never_discuss when the old profile never said, and reports the default", () => {
    const legacy = legacyProfile();
    legacy.pricing = { ...legacy.pricing, mayMentionPricing: null, calloutWording: null, indicativePrices: [] };
    const result = migrateLocksmithProfile(legacy);
    assert.equal(result.blueprint.knowledge.pricingDisclosure, "never_discuss");
    assert.ok(result.defaultsApplied.some((d) => d.path === "knowledge.pricingDisclosure"));
  });
});

describe("locksmith parity — privacy survives as compliance", () => {
  it("carries every privacy answer the old profile held", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    assert.equal(blueprint.compliance.callsMayBeRecorded, legacy.privacy.callsMayBeRecorded);
    assert.equal(blueprint.compliance.transcriptRetention, legacy.privacy.transcriptRetention);
    assert.equal(blueprint.compliance.recordingRetention, legacy.privacy.recordingRetention);
    assert.equal(blueprint.compliance.redactSensitiveData, legacy.privacy.redactSensitiveData);
  });

  it("refuses a migrated profile that records calls without telling anybody", () => {
    const legacy = legacyProfile();
    legacy.privacy = { ...legacy.privacy, callsMayBeRecorded: true, recordingDisclosure: null };
    const result = migrateLocksmithProfile(legacy);
    const validation = validateBlueprint(result.blueprint);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.path === "compliance.recordingDisclosure"));
  });

  it("puts the recording disclosure into the prompt when there is one", () => {
    const legacy = legacyProfile();
    legacy.privacy = {
      ...legacy.privacy,
      callsMayBeRecorded: true,
      recordingDisclosure: "This call is recorded for quality.",
    };
    const { blueprint } = migrateLocksmithProfile(legacy);
    const { spec } = compileBehaviourSpec(blueprint);
    const out = compileRetellPreview({ spec, providerRefs: { llmId: "llm_x", voiceId: "v_x", webhookUrl: "https://example.invalid/h" } });
    assert.ok(out.responseEngine.general_prompt.includes("This call is recorded for quality."));
  });

  it("says nothing about recording when the client does not record", () => {
    const { blueprint } = migrated();
    assert.equal(blueprint.compliance.callsMayBeRecorded, false);
    const { spec } = compileBehaviourSpec(blueprint);
    const out = compileRetellPreview({ spec, providerRefs: { llmId: "llm_x", voiceId: "v_x", webhookUrl: "https://example.invalid/h" } });
    assert.ok(!/# Recording/.test(out.responseEngine.general_prompt));
  });
});

describe("locksmith parity — voice is never inherited by accident", () => {
  it("leaves the voice unchosen, because a tone is not a voice", () => {
    const result = migrated();
    assert.equal(result.blueprint.voice.profileRef, null);
    assert.ok(result.defaultsApplied.some((d) => d.path === "voice.profileRef"));
  });

  it("carries the legacy tone as tone wording", () => {
    const { blueprint } = migrated();
    assert.equal(blueprint.voice.tone, "friendly, straightforward Australian trade");
  });

  it("prefers the owner's own words when a custom tone was reviewed", () => {
    const legacy = legacyProfile();
    legacy.identity.tone = "custom_reviewed";
    legacy.identity.toneWording = "Calm, unhurried, never rushes the caller.";
    const { blueprint } = migrateLocksmithProfile(legacy);
    assert.equal(blueprint.voice.tone, "Calm, unhurried, never rushes the caller.");
  });
});

describe("locksmith parity — notifications become capabilities", () => {
  it("turns recipient lists into enabled capabilities and keeps the recipients readable", () => {
    const legacy = legacyProfile();
    const { blueprint } = migrated();
    const sms = blueprint.integrations.find((i) => i.capability === "sms");
    const email = blueprint.integrations.find((i) => i.capability === "email");
    assert.ok(sms && sms.enabled);
    assert.ok(email && email.enabled);
    assert.ok(sms.notes.includes(legacy.notifications.sms[0]));
    assert.ok(email.notes.includes(legacy.notifications.email[0]));
  });

  it("reports timing and content preferences as adapter concerns", () => {
    const { unmapped } = migrated();
    assert.ok(unmapped.some((u) => u.path === "notifications.timing/contentPreferences"));
  });

  it("reports the other recipient lists when a profile uses them", () => {
    const legacy = legacyProfile();
    legacy.notifications.urgentOnly = ["+61491570099"];
    legacy.notifications.backup = ["backup@example.invalid"];
    const { unmapped } = migrateLocksmithProfile(legacy);
    assert.ok(unmapped.some((u) => u.path === "notifications.urgentOnly"));
    assert.ok(unmapped.some((u) => u.path === "notifications.backup"));
  });
});

describe("locksmith parity — the report is the interesting output", () => {
  it("reports something in all three categories for a real profile", () => {
    const { notes, unmapped, defaultsApplied } = migrated();
    assert.ok(notes.length > 0, "a real migration reshapes something");
    assert.ok(unmapped.length > 0, "a real migration cannot carry everything");
    assert.ok(defaultsApplied.length > 0, "a real migration must invent some answers");
  });

  it("names a path for every single entry, so each one is actionable", () => {
    const { notes, unmapped, defaultsApplied } = migrated();
    for (const entry of [...notes, ...unmapped, ...defaultsApplied]) {
      assert.ok(typeof entry.path === "string" && entry.path.length > 0, JSON.stringify(entry));
      assert.ok(typeof entry.message === "string" && entry.message.length > 0, JSON.stringify(entry));
    }
  });

  it("keeps the report stable across runs", () => {
    const a = migrated();
    const b = migrated();
    assert.equal(JSON.stringify(a.notes), JSON.stringify(b.notes));
    assert.equal(JSON.stringify(a.unmapped), JSON.stringify(b.unmapped));
    assert.equal(JSON.stringify(a.defaultsApplied), JSON.stringify(b.defaultsApplied));
  });
});

describe("locksmith parity — end to end, and still nothing is live", () => {
  it("compiles all the way to a Retell payload", () => {
    const { blueprint } = migrated();
    const { spec, behaviourHash } = compileBehaviourSpec(blueprint);
    const out = compileRetellPreview({
      spec,
      providerRefs: { llmId: "llm_fake0000", voiceId: "custom_voice_fake0000", webhookUrl: "https://example.invalid/hooks" },
    });
    assert.equal(out.ready, true);
    assert.match(behaviourHash, /^[0-9a-f]{64}$/);

    const prompt = out.responseEngine.general_prompt;
    assert.ok(prompt.includes("Northside Lock and Key"));
    assert.ok(prompt.includes("Residential lockouts"));
    assert.ok(prompt.includes("Preston"));
    assert.ok(prompt.includes("Caller is locked out of a residence after hours"));
    assert.match(prompt, /Do not discuss price/i);
  });

  it("does not put a declined service in the prompt", () => {
    const { blueprint } = migrated();
    const { spec } = compileBehaviourSpec(blueprint);
    const out = compileRetellPreview({ spec, providerRefs: { llmId: "l", voiceId: "v", webhookUrl: "https://example.invalid/h" } });
    assert.ok(!/automotive_lockout/.test(out.responseEngine.general_prompt));
  });

  it("still has to be validated, approved by a person and activated", async () => {
    const now = () => new Date(Date.UTC(2026, 7, 16, 9, 0, 0));
    const authority = createBlueprintAuthority({ store: createInMemoryBlueprintStore(), now });
    const { blueprint } = migrated();

    const draft = await authority.createDraft({
      clientId: blueprint.identity.clientId,
      blueprint,
      createdBy: "migration",
      source: "import",
    });
    assert.equal(draft.version.metadata.status, "draft");
    const v = draft.version.metadata.configVersion;

    assert.equal((await authority.activateApprovedVersion({ clientId: blueprint.identity.clientId, configVersion: v })).ok, false);
    assert.equal((await authority.validateDraft(blueprint.identity.clientId, v)).ok, true);
    assert.equal((await authority.approveDraft({ clientId: blueprint.identity.clientId, configVersion: v, approvedBy: "system" })).ok, false);
    assert.equal((await authority.approveDraft({ clientId: blueprint.identity.clientId, configVersion: v, approvedBy: "Peter Dang" })).ok, true);
    assert.equal((await authority.activateApprovedVersion({ clientId: blueprint.identity.clientId, configVersion: v, activatedBy: "Peter Dang" })).ok, true);
  });

  it("carries no permission with it, however it is compiled", () => {
    const { blueprint } = migrated();
    assert.equal(blueprint.outbound.enabled, false);
    const json = JSON.stringify(compileBehaviourSpec(blueprint).spec);
    for (const key of ["callingEnabled", "dialAuthorised", "approvedToCall", "dncr"]) {
      assert.ok(!json.includes(`"${key}"`));
    }
  });
});
