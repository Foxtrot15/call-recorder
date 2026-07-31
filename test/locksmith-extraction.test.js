// LOCKSMITH M2 — the extraction adapter contract and the deterministic fixture.
//
// These tests pin the behaviour a future LLM adapter must also satisfy: silence
// produces a gap rather than a guess, unknown values are refused outright,
// nothing is ever auto-approved, and an existing approved profile is never
// touched.

const { describe, it } = require("node:test");
const assert = require("node:assert");

require("../src/services/locksmith-extraction-fixture");
const extraction = require("../src/services/locksmith-extraction");
const S = require("../src/services/locksmith-profile-schema");
const { validateProfile } = require("../src/services/locksmith-profile");
const spec = require("../src/services/locksmith-interview-spec");
const { spokenNumberFrom } = require("../src/services/locksmith-extraction-fixture");

function extractDemo(overrides = {}) {
  return extraction.extractLocksmithProfile({ transcript: spec.DEMO_TRANSCRIPT, clientId: "demo-locksmith", ...overrides });
}

describe("adapter registry", () => {
  it("ships exactly one adapter in M2, and it is the deterministic fixture", () => {
    const adapters = extraction.listExtractionAdapters();
    assert.ok(adapters.includes("fixture-v1"));
    assert.ok(!adapters.some((a) => /openai|anthropic|claude|gpt|retell/i.test(a)), "no model adapter may ship in M2");
  });

  it("refuses to register nonsense", () => {
    assert.throws(() => extraction.registerExtractionAdapter("", () => ({})), /needs a name/);
    assert.throws(() => extraction.registerExtractionAdapter("x", "not a function"), /must be a function/);
  });

  it("an unknown adapter name is an error, not a fallback", () => {
    const result = extractDemo({ adapter: "llm-that-does-not-exist" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "unknown_adapter");
  });
});

describe("the deterministic mock transcript produces the expected draft", () => {
  const result = extractDemo();

  it("succeeds and produces a valid profile", () => {
    assert.strictEqual(result.ok, true, result.message || "");
    assert.strictEqual(validateProfile(result.profile).ok, true);
  });

  it("is deterministic — the same transcript always gives the same profile", () => {
    const again = extractDemo();
    assert.deepStrictEqual(again.profile, result.profile);
    assert.deepStrictEqual(again.warnings, result.warnings);
  });

  it("captures the business identity as spoken", () => {
    const i = result.profile.identity;
    assert.strictEqual(i.clientId, "demo-locksmith");
    assert.strictEqual(i.spokenName, "Northside Lock and Key");
    assert.strictEqual(i.legalName, "Northside Lock and Key Pty Ltd");
    assert.strictEqual(i.receptionistName, "Mel");
    assert.strictEqual(i.greeting, "Northside Lock and Key, this is Mel, how can I help?");
    assert.strictEqual(i.timezone, "Australia/Melbourne");
    assert.strictEqual(i.tone, "friendly_australian_trade");
  });

  it("captures accepted services, including the qualifying note on access control", () => {
    const accepted = result.profile.servicesAccepted.filter((s) => s.enabled).map((s) => s.serviceId);
    for (const expected of ["residential_lockout", "commercial_locksmith", "rekeying", "lock_installation", "broken_key_extraction", "access_control", "break_in_security", "key_cutting"]) {
      assert.ok(accepted.includes(expected), `expected ${expected} to be accepted`);
    }
    const accessControl = result.profile.servicesAccepted.find((s) => s.serviceId === "access_control");
    assert.match(accessControl.notes, /basic hardware only/i, "the owner's qualification must survive extraction");
    const keyCutting = result.profile.servicesAccepted.find((s) => s.serviceId === "key_cutting");
    assert.match(keyCutting.notes, /never a call-out/i);
  });

  it("records the declined services explicitly — nothing is inferred", () => {
    const declined = result.profile.servicesDeclined.map((s) => s.serviceId);
    for (const expected of ["automotive_lockout", "lost_car_keys", "car_key_replacement", "safe_opening"]) {
      assert.ok(declined.includes(expected), `${expected} must be explicitly declined`);
    }
    const accepted = result.profile.servicesAccepted.filter((s) => s.enabled).map((s) => s.serviceId);
    for (const id of declined) assert.ok(!accepted.includes(id), `${id} must not also be accepted`);
  });

  it("captures the service areas and the out-of-area rule", () => {
    const areas = result.profile.serviceAreas;
    assert.deepStrictEqual(areas.primary, ["Preston", "Reservoir", "Coburg", "Brunswick", "Thornbury", "Northcote"]);
    assert.deepStrictEqual(areas.extended, ["Epping", "Bundoora"]);
    assert.ok(areas.declined.includes("Frankston"));
    assert.strictEqual(areas.outsideAreaAction, "collect_details_for_confirmation");
    assert.deepStrictEqual(areas.afterHoursAreas, areas.primary, "the smaller after-hours area was stated");
  });

  it("captures day-specific hours and the after-hours position", () => {
    const h = result.profile.hours;
    assert.deepStrictEqual(h.ordinary.monday, { open: "08:00", close: "17:00" });
    assert.deepStrictEqual(h.ordinary.saturday, { open: "08:00", close: "13:00" });
    assert.deepStrictEqual(h.ordinary.sunday, { closed: true });
    assert.deepStrictEqual(h.publicHolidays, { byArrangement: true });
    assert.strictEqual(h.afterHoursAvailable, true);
    assert.strictEqual(h.timezone, "Australia/Melbourne");
  });

  it("captures urgency rules including the non-urgent case", () => {
    const rules = result.profile.urgencyRules;
    const byId = Object.fromEntries(rules.map((r) => [r.ruleId, r]));
    assert.strictEqual(byId.after_hours_lockout.classification, "urgent");
    assert.strictEqual(byId.vulnerable_person.action, "transfer_immediately");
    assert.strictEqual(byId.break_in_unsecured.transferEligible, true);
    assert.strictEqual(byId.commercial_cannot_open.classification, "priority");
    assert.strictEqual(byId.quote_or_key_cut.classification, "non_urgent");
    assert.strictEqual(byId.quote_or_key_cut.transferEligible, false, "a quote must never wake anyone up");
  });

  it("takes phone numbers only from the confirmed read-back lines", () => {
    const t = result.profile.transfer;
    assert.strictEqual(t.primaryNumber, "+61491570006");
    assert.strictEqual(t.backupNumber, "+61491570015");
    assert.strictEqual(t.unansweredAction, "try_backup_number");
    assert.strictEqual(t.maxAttempts, 2);
    assert.strictEqual(t.collectDetailsFirst, true);
  });

  it("applies the safe pricing default the owner asked for", () => {
    assert.strictEqual(result.profile.pricing.mayMentionPricing, false);
    assert.strictEqual(result.profile.pricing.humanConfirmsEveryPrice, true);
    assert.ok(result.profile.pricing.neverState.some((s) => /cheapest/i.test(s)), "the owner's extra restriction is kept");
  });

  it("always applies the mandatory forbidden-promise floor regardless of the transcript", () => {
    const enabled = result.profile.forbiddenPromises.filter((p) => p.enabled).map((p) => p.promiseId);
    assert.deepStrictEqual(enabled.sort(), [...S.MANDATORY_FORBIDDEN_PROMISES].sort());
    const arrival = result.profile.forbiddenPromises.find((p) => p.promiseId === "guaranteed_arrival_time");
    assert.match(arrival.note, /emphasised this one/i);
  });

  it("records the privacy preferences as stated", () => {
    const pv = result.profile.privacy;
    assert.strictEqual(pv.callsMayBeRecorded, false);
    assert.strictEqual(pv.transcriptRetention, "keep_12_months");
    assert.strictEqual(pv.redactSensitiveData, true);
  });

  it("produces a provisioning-ready draft with no missing fields or contradictions", () => {
    assert.strictEqual(result.provisioning.ready, true, JSON.stringify(result.provisioning.blockers));
    assert.deepStrictEqual(result.missingFields, []);
    assert.deepStrictEqual(result.contradictions, []);
  });
});

describe("spoken number parsing", () => {
  it("reads Australian digit-by-digit read-backs", () => {
    assert.strictEqual(spokenNumberFrom("AIDA: oh four nine one, five seven oh, oh oh six."), "+61491570006");
    assert.strictEqual(spokenNumberFrom("AIDA: zero three, nine zero zero zero, zero zero zero zero."), "+61390000000");
  });

  it("returns null rather than a half-heard number", () => {
    assert.strictEqual(spokenNumberFrom("AIDA: it's about four or five."), null);
    assert.strictEqual(spokenNumberFrom("AIDA: no digits here at all."), null);
  });
});

describe("missing answers produce warnings, never guesses", () => {
  // A transcript where the owner never gives a transfer number, hours or a
  // pricing position.
  const THIN = `AIDA: What's the business called — the name you'd want me to say when I pick up?
Owner: Southside Locks.
AIDA: Which state are you based in?
Owner: Victoria.
AIDA: Residential lockouts — yes?
Owner: Yep, most of what we do at night.
AIDA: Thanks, that's everything for now.`;

  const result = extraction.extractLocksmithProfile({ transcript: THIN, clientId: "thin-client" });

  it("still returns a draft — an incomplete profile is what review is for", () => {
    assert.strictEqual(result.ok, true, result.message || "");
  });

  it("reports each unanswered safety-critical fact", () => {
    const paths = result.missingFields.map((m) => m.path);
    for (const expected of ["transfer.primaryNumber", "transfer.unansweredAction", "serviceAreas.outsideAreaAction", "pricing.mayMentionPricing", "pricing.humanConfirmsEveryPrice"]) {
      assert.ok(paths.includes(expected), `${expected} should be reported as missing`);
    }
  });

  it("never invents a value for something that was not said", () => {
    assert.strictEqual(result.profile.transfer.primaryNumber, null);
    assert.strictEqual(result.profile.serviceAreas.outsideAreaAction, null);
    assert.strictEqual(result.profile.pricing.mayMentionPricing, null);
    assert.deepStrictEqual(result.profile.serviceAreas.primary, []);
  });

  it("is not provisioning-ready, and says exactly why", () => {
    assert.strictEqual(result.provisioning.ready, false);
    const codes = result.provisioning.blockers.map((b) => b.code);
    assert.ok(codes.includes("transfer_number_invalid"));
    assert.ok(codes.includes("no_service_area"));
    assert.ok(codes.includes("pricing_authority_ambiguous"));
  });

  it("surfaces every gap as a blocking review warning", () => {
    const blocking = result.warnings.filter((w) => w.severity === "blocking");
    assert.ok(blocking.length >= 5);
    for (const w of blocking) assert.match(w.message, /Not established during the interview/);
  });
});

describe("contradictions are reported, never resolved", () => {
  it("flags a service that is both accepted and declined", () => {
    const profile = extractDemo().profile;
    profile.servicesDeclined.push({ serviceId: "rekeying", reason: "conflicting answer later in the call" });
    const found = extraction.detectContradictions(profile);
    assert.ok(found.some((c) => c.code === "service_both_ways"));
  });

  it("flags an area that is both covered and refused", () => {
    const profile = extractDemo().profile;
    profile.serviceAreas.declined = ["Preston"];
    const found = extraction.detectContradictions(profile);
    assert.ok(found.some((c) => c.code === "area_both_ways"));
  });

  it("flags transfers restricted to business hours while after-hours work is accepted", () => {
    const profile = extractDemo().profile;
    profile.transfer.permittedHours = { businessHoursOnly: true };
    const found = extraction.detectContradictions(profile);
    assert.ok(found.some((c) => c.code === "transfer_hours_conflict"));
  });

  it("flags urgent transfers on a business that says it is not available after hours", () => {
    const profile = extractDemo().profile;
    profile.hours.afterHoursAvailable = false;
    const found = extraction.detectContradictions(profile);
    assert.ok(found.some((c) => c.code === "after_hours_conflict"));
  });

  it("flags transfer eligibility for a service the business does not accept", () => {
    const profile = extractDemo().profile;
    profile.transfer.eligibleServices = [...profile.transfer.eligibleServices, "safe_opening"];
    const found = extraction.detectContradictions(profile);
    assert.ok(found.some((c) => c.code === "transfer_service_not_accepted"));
  });

  it("flags unbounded pricing authority", () => {
    const profile = extractDemo().profile;
    profile.pricing.mayMentionPricing = true;
    profile.pricing.humanConfirmsEveryPrice = false;
    profile.pricing.indicativePrices = [];
    assert.ok(extraction.detectContradictions(profile).some((c) => c.code === "pricing_unbounded"));
  });

  it("does not pick a side — the contradictory values are both left in place", () => {
    const profile = extractDemo().profile;
    profile.serviceAreas.declined = ["Preston"];
    extraction.detectContradictions(profile);
    assert.ok(profile.serviceAreas.primary.includes("Preston"));
    assert.ok(profile.serviceAreas.declined.includes("Preston"));
  });
});

describe("adapter output is validated, never half-applied", () => {
  it("an adapter that invents an enum value has its whole output rejected", () => {
    extraction.registerExtractionAdapter("test-bad-enum", ({ existingProfile }) => {
      const p = existingProfile || S.emptyProfile();
      p.identity.tone = "extremely_relaxed";
      return p;
    });
    const result = extractDemo({ adapter: "test-bad-enum" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "adapter_output_invalid");
    assert.ok(result.errors.some((e) => /not a recognised tone/i.test(e.message)));
  });

  it("an adapter that returns junk is rejected cleanly", () => {
    for (const [name, value] of [["test-null", null], ["test-string", "a profile"], ["test-array", []]]) {
      extraction.registerExtractionAdapter(name, () => value);
      const result = extractDemo({ adapter: name });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, "adapter_output_invalid");
    }
  });

  it("an adapter that throws is contained", () => {
    extraction.registerExtractionAdapter("test-throws", () => {
      throw new Error("model timed out");
    });
    const result = extractDemo({ adapter: "test-throws" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "adapter_failed");
    assert.match(result.message, /model timed out/);
  });

  it("an adapter cannot claim a different schema version", () => {
    extraction.registerExtractionAdapter("test-schema-liar", ({ existingProfile }) => {
      const p = existingProfile || S.emptyProfile();
      p.schemaVersion = "something-else";
      return p;
    });
    const result = extractDemo({ adapter: "test-schema-liar" });
    // Rejected on content, not on the version claim — the version is overwritten.
    assert.ok(!result.ok || result.profile.schemaVersion === S.SCHEMA_VERSION);
  });

  it("an adapter cannot retarget the draft at another tenant", () => {
    extraction.registerExtractionAdapter("test-tenant-hijack", ({ existingProfile }) => {
      const p = existingProfile || S.emptyProfile();
      p.identity.clientId = "some-other-business";
      return p;
    });
    const result = extraction.extractLocksmithProfile({ transcript: spec.DEMO_TRANSCRIPT, clientId: "demo-locksmith", adapter: "test-tenant-hijack" });
    if (result.ok) {
      assert.strictEqual(result.profile.identity.clientId, "demo-locksmith", "the caller's tenant always wins");
    }
  });

  it("refuses an unsupported schema version up front", () => {
    const result = extractDemo({ schemaVersion: "locksmith-profile-1999-01-01" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "unsupported_schema");
  });

  it("refuses an empty transcript", () => {
    for (const bad of ["", "   ", null, undefined, 42]) {
      const result = extraction.extractLocksmithProfile({ transcript: bad, clientId: "c" });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, "empty_transcript");
    }
  });
});

describe("extraction never approves and never touches an approved profile", () => {
  it("the result is explicitly unapproved", () => {
    const result = extractDemo();
    assert.strictEqual(result.approved, false);
    assert.ok(!("status" in result.profile), "a profile body carries no status — the version row owns that");
  });

  it("an existing approved profile passed in is not mutated", () => {
    const approved = extractDemo().profile;
    const before = JSON.stringify(approved);

    extraction.registerExtractionAdapter("test-mutator", ({ existingProfile }) => {
      // A hostile or buggy adapter tries to edit what it was handed.
      existingProfile.transfer.primaryNumber = "+61400000000";
      existingProfile.servicesAccepted = [];
      return existingProfile;
    });
    extraction.extractLocksmithProfile({ transcript: spec.DEMO_TRANSCRIPT, existingProfile: approved, clientId: "demo-locksmith", adapter: "test-mutator" });

    assert.strictEqual(JSON.stringify(approved), before, "the caller's approved profile must be untouched");
  });

  it("re-extracting over an existing draft keeps values the transcript does not mention", () => {
    const existing = extractDemo().profile;
    existing.identity.website = "https://example.com.au";
    const result = extraction.extractLocksmithProfile({ transcript: spec.DEMO_TRANSCRIPT, existingProfile: existing, clientId: "demo-locksmith" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.profile.identity.website, "https://example.com.au", "a human's correction is not erased by a re-run");
  });
});

describe("review warnings", () => {
  it("always asks for the transfer number to be checked, even when it extracted cleanly", () => {
    const result = extractDemo();
    const confirm = result.warnings.filter((w) => w.severity === "confirm");
    assert.ok(confirm.some((w) => w.code === "verify_transfer_number"));
    assert.match(confirm[0].message, /digit by digit/i);
  });

  it("every warning carries a code, a message and a severity", () => {
    for (const w of extractDemo().warnings) {
      assert.ok(w.code && w.message && w.severity, `malformed warning: ${JSON.stringify(w)}`);
      assert.ok(["blocking", "contradiction", "advisory", "confirm"].includes(w.severity));
    }
  });
});

describe("the interview specification", () => {
  it("is versioned", () => {
    assert.match(spec.INTERVIEW_SPEC_VERSION, /^locksmith-interview-\d{4}-\d{2}-\d{2}$/);
  });

  it("covers all sixteen required areas", () => {
    const ids = spec.QUESTION_GROUPS.map((g) => g.id);
    for (const expected of [
      "identity", "services_accepted", "services_declined", "service_areas", "hours",
      "after_hours", "urgency", "transfer", "fallback", "notifications", "pricing",
      "caller_info", "forbidden", "tone", "privacy", "read_back",
    ]) {
      assert.ok(ids.includes(expected), `the interview must cover ${expected}`);
    }
  });

  it("opens with a disclosure that AIDA is automated and the call is transcribed", () => {
    assert.match(spec.OPENING.disclosure, /automated assistant, not a person/i);
    assert.match(spec.OPENING.disclosure, /transcribed/i);
    assert.strictEqual(spec.OPENING.transcriptionDisclosurePlaceholder, true, "the wording is pending legal review");
  });

  it("states what AIDA must never infer", () => {
    const never = spec.HANDLING.neverInfer.join(" ");
    assert.match(never, /unlisted service is accepted/i);
    assert.match(never, /read every digit back/i);
    assert.match(never, /emergency services/i);
    assert.match(never, /licensed, insured or verified/i);
  });

  it("has rules for uncertainty, contradiction and 'I don't know'", () => {
    assert.match(spec.HANDLING.uncertainty, /record the uncertainty rather than the guess/i);
    assert.match(spec.HANDLING.contradiction, /Never silently keep the most recent answer/i);
    assert.match(spec.HANDLING.ownerDoesNotKnow, /owner_did_not_know/);
  });

  it("marks the safety-critical groups and requires read-backs on them", () => {
    for (const id of ["transfer", "fallback", "pricing", "forbidden", "read_back"]) {
      assert.ok(spec.SAFETY_CRITICAL_GROUPS.includes(id), `${id} must be safety-critical`);
    }
    const transfer = spec.QUESTION_GROUPS.find((g) => g.id === "transfer");
    assert.strictEqual(transfer.readBack, true);
  });

  it("does not treat silence as an answer", () => {
    assert.match(spec.COMPLETION_CRITERIA.rule, /answered or explicitly recorded as owner_did_not_know/);
    assert.ok(spec.COMPLETION_CRITERIA.neverComplete.some((r) => /read back digit by digit/i.test(r)));
  });

  it("labels the demonstration transcript and keeps it free of reachable contact details", () => {
    assert.match(spec.DEMO_LABEL, /demonstration data/i);
    assert.match(spec.DEMO_LABEL, /not a real call/i);
    // Only ACMA fictitious numbers (0491 570 006-156) may appear.
    const numbers = spec.DEMO_TRANSCRIPT.match(/\b0\d[\d ]{7,}\d\b/g) || [];
    assert.deepStrictEqual(numbers, [], "no numeric phone numbers should be written out in the transcript");
    const emails = spec.DEMO_TRANSCRIPT.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
    assert.deepStrictEqual(emails, [], "email addresses are spoken as words, not written");
  });

  it("the extracted demo numbers are inside the ACMA fictitious range", () => {
    const { transfer } = extractDemo().profile;
    for (const number of [transfer.primaryNumber, transfer.backupNumber]) {
      const national = `0${number.slice(3)}`;
      assert.match(national, /^04915700\d{2}$/, `${number} must be an ACMA fictitious number`);
      const last = Number(national.slice(-3));
      assert.ok(last >= 6 && last <= 156, `${number} must sit inside 0491 570 006-156`);
    }
  });

  it("the demo email uses an RFC 2606 reserved domain", () => {
    const email = extractDemo().profile.notifications.email[0];
    assert.match(email, /@[\w.-]*\bexample\.(com|net|org)$/, `${email} must use a reserved example domain`);
  });
});
