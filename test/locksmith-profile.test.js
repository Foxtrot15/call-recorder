// LOCKSMITH M2 — canonical profile validation + provisioning readiness.
//
// Pure modules, runs without node_modules. These tests guard the boundary
// between "a locksmith answered some questions" and "it is safe to build a
// receptionist from this".

const { describe, it } = require("node:test");
const assert = require("node:assert");

const S = require("../src/services/locksmith-profile-schema");
const { validateProfile, assessProvisioning, toQueryableColumns, normaliseAuNumber, isValidTime } = require("../src/services/locksmith-profile");
require("../src/services/locksmith-extraction-fixture");
const { extractLocksmithProfile } = require("../src/services/locksmith-extraction");
const { DEMO_TRANSCRIPT } = require("../src/services/locksmith-interview-spec");

// A complete, valid profile — built once from the deterministic fixture so the
// tests and the shipped extraction can never drift apart.
function validProfile() {
  const result = extractLocksmithProfile({ transcript: DEMO_TRANSCRIPT, clientId: "demo-locksmith" });
  assert.strictEqual(result.ok, true, `fixture must produce a valid profile: ${result.message || ""}`);
  return JSON.parse(JSON.stringify(result.profile));
}

describe("schema declaration", () => {
  it("declares all twelve sections A-L", () => {
    assert.strictEqual(S.SECTIONS.length, 12);
    assert.deepStrictEqual(S.SECTIONS.map((s) => s.letter), ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]);
  });

  it("every section requires an explicit reviewer confirmation", () => {
    assert.deepStrictEqual(S.CONFIRMATION_KEYS, S.SECTION_KEYS, "each section must be individually confirmable");
  });

  it("the safety-critical sections are the ones that block provisioning", () => {
    for (const key of ["identity", "servicesAccepted", "serviceAreas", "hours", "urgencyRules", "transfer", "pricing", "callerInfo", "forbiddenPromises"]) {
      assert.ok(S.BLOCKING_SECTION_KEYS.includes(key), `${key} must block launch when incomplete`);
    }
  });

  it("an empty profile has every section present and is not accidentally valid", () => {
    const empty = S.emptyProfile();
    for (const key of S.SECTION_KEYS) assert.ok(key in empty, `emptyProfile is missing ${key}`);
    assert.strictEqual(validateProfile(empty).ok, false, "an empty profile must never validate");
  });
});

describe("valid complete profile", () => {
  it("passes validation with no errors", () => {
    const result = validateProfile(validProfile());
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors, null, 1));
  });

  it("is provisioning-ready with no blockers", () => {
    const { ready, blockers } = assessProvisioning(validProfile());
    assert.strictEqual(ready, true, JSON.stringify(blockers));
    assert.deepStrictEqual(blockers, []);
  });

  it("mirrors safety-critical facts into queryable columns", () => {
    const cols = toQueryableColumns(validProfile());
    assert.strictEqual(cols.business_timezone, "Australia/Melbourne");
    assert.strictEqual(cols.spoken_business_name, "Northside Lock and Key");
    assert.match(cols.transfer_primary_number, /^\+61\d{9}$/);
    assert.match(cols.transfer_backup_number, /^\+61\d{9}$/);
    assert.ok(cols.accepted_service_count > 0);
    assert.strictEqual(cols.pricing_may_be_mentioned, false);
    assert.strictEqual(cols.pricing_human_confirms, true);
    assert.strictEqual(cols.provisioning_ready, true);
    assert.deepStrictEqual(cols.blocking_reasons, []);
  });
});

describe("business identity", () => {
  it("missing identity fields are reported individually", () => {
    const p = validProfile();
    p.identity.spokenName = "";
    p.identity.greeting = null;
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    const fields = result.errors.filter((e) => e.section === "identity").map((e) => e.field);
    assert.ok(fields.includes("spokenName"));
    assert.ok(fields.includes("greeting"));
  });

  it("a missing identity section does not crash the validator", () => {
    const p = validProfile();
    delete p.identity;
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.section === "identity"));
  });

  it("a custom tone must carry its reviewed wording", () => {
    const p = validProfile();
    p.identity.tone = "custom_reviewed";
    p.identity.toneWording = "";
    assert.ok(validateProfile(p).errors.some((e) => e.field === "toneWording"));
    p.identity.toneWording = "Calm, unhurried, never rushes the caller.";
    assert.strictEqual(validateProfile(p).ok, true);
  });
});

describe("services", () => {
  it("no accepted service blocks provisioning", () => {
    const p = validProfile();
    p.servicesAccepted = [];
    const { ready, blockers } = assessProvisioning(p);
    assert.strictEqual(ready, false);
    assert.ok(blockers.some((b) => b.code === "no_services_accepted"));
  });

  it("a service listed as both accepted and declined is an error, not a guess", () => {
    const p = validProfile();
    p.servicesDeclined = [...p.servicesDeclined, { serviceId: "rekeying", reason: "changed their mind" }];
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => /both accepted and declined/i.test(e.message)));
  });

  it("explicit exclusions are stored and never inferred away", () => {
    const p = validProfile();
    const declinedIds = p.servicesDeclined.map((s) => s.serviceId);
    assert.ok(declinedIds.includes("automotive_lockout"), "the demo locksmith declines car work");
    assert.ok(declinedIds.includes("safe_opening"));
    // A declined service must not appear in the accepted list.
    const acceptedIds = p.servicesAccepted.filter((s) => s.enabled).map((s) => s.serviceId);
    for (const id of declinedIds) assert.ok(!acceptedIds.includes(id), `${id} must not be accepted`);
  });

  it("a duplicated accepted service is rejected", () => {
    const p = validProfile();
    p.servicesAccepted.push({ ...p.servicesAccepted[0] });
    assert.ok(validateProfile(p).errors.some((e) => /listed more than once/i.test(e.message)));
  });
});

describe("service areas", () => {
  it("a valid area set passes", () => {
    assert.strictEqual(validateProfile(validProfile()).ok, true);
  });

  it("an area that is both covered and declined is an error", () => {
    const p = validProfile();
    p.serviceAreas.declined = ["Preston"];
    assert.ok(validateProfile(p).errors.some((e) => /both covered and declined/i.test(e.message)));
  });

  it("no primary area blocks provisioning", () => {
    const p = validProfile();
    p.serviceAreas.primary = [];
    const { blockers } = assessProvisioning(p);
    assert.ok(blockers.some((b) => b.code === "no_service_area"));
  });

  it("an out-of-area rule is required — routing is never left to prose", () => {
    const p = validProfile();
    p.serviceAreas.outsideAreaAction = null;
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "outsideAreaAction"));
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "no_outside_area_action"));
  });

  it("an unknown out-of-area action is rejected, not passed through", () => {
    const p = validProfile();
    p.serviceAreas.outsideAreaAction = "figure_it_out";
    assert.ok(validateProfile(p).errors.some((e) => /not a recognised outsideAreaAction/i.test(e.message)));
  });

  it("an impossible radius is rejected", () => {
    const p = validProfile();
    for (const bad of [0, -5, 9000, "twenty"]) {
      p.serviceAreas.radiusKm = bad;
      assert.ok(validateProfile(p).errors.some((e) => e.field === "radiusKm"), `radius ${bad} must be rejected`);
    }
  });
});

describe("hours", () => {
  it("day-specific hours are accepted", () => {
    const p = validProfile();
    assert.deepStrictEqual(p.hours.ordinary.monday, { open: "08:00", close: "17:00" });
    assert.deepStrictEqual(p.hours.ordinary.saturday, { open: "08:00", close: "13:00" });
    assert.deepStrictEqual(p.hours.ordinary.sunday, { closed: true });
    assert.strictEqual(validateProfile(p).ok, true);
  });

  it("a close time at or before the open time is a conflict", () => {
    const p = validProfile();
    p.hours.ordinary.monday = { open: "17:00", close: "08:00" };
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => /closes at or before it opens/i.test(e.message)));
  });

  it("a timezone that disagrees with the business timezone is a conflict", () => {
    const p = validProfile();
    p.hours.timezone = "Australia/Perth";
    assert.ok(validateProfile(p).errors.some((e) => /does not match the business timezone/i.test(e.message)));
  });

  it("a non-Australian or unknown timezone is rejected", () => {
    const p = validProfile();
    for (const bad of ["Europe/London", "UTC", "GMT+10", "Australia/Atlantis"]) {
      p.identity.timezone = bad;
      assert.ok(validateProfile(p).errors.some((e) => e.field === "timezone"), `${bad} must be rejected`);
    }
  });

  it("no open days at all blocks provisioning", () => {
    const p = validProfile();
    p.hours.ordinary = { monday: { closed: true } };
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "no_open_hours"));
  });

  it("garbage day names and malformed times are rejected", () => {
    const p = validProfile();
    p.hours.ordinary.someday = { open: "08:00", close: "17:00" };
    assert.ok(validateProfile(p).errors.some((e) => /not a day of the week/i.test(e.message)));
    delete p.hours.ordinary.someday;
    p.hours.ordinary.monday = { open: "8am", close: "5pm" };
    assert.ok(validateProfile(p).errors.some((e) => /HH:MM/.test(e.message)));
  });

  it("isValidTime accepts 24-hour times only", () => {
    for (const good of ["00:00", "08:30", "23:59"]) assert.strictEqual(isValidTime(good), true, good);
    for (const bad of ["24:00", "8:30", "08:60", "0830", "8am", ""]) assert.strictEqual(isValidTime(bad), false, bad);
  });
});

describe("phone numbers (safety-critical)", () => {
  it("normalises valid Australian numbers to E.164", () => {
    assert.strictEqual(normaliseAuNumber("0491 570 006"), "+61491570006");
    assert.strictEqual(normaliseAuNumber("(03) 9000 0000"), "+61390000000");
    assert.strictEqual(normaliseAuNumber("+61 3 9000 0000"), "+61390000000");
    assert.strictEqual(normaliseAuNumber("61390000000"), "+61390000000");
    // 1300/1800 keep all ten digits — the leading 1 is part of the number.
    assert.strictEqual(normaliseAuNumber("1300 000 000"), "+611300000000");
    assert.strictEqual(normaliseAuNumber("1800 000 000"), "+611800000000");
  });

  it("refuses anything it could not actually dial", () => {
    for (const bad of ["", "12345", "0555123456", "0100000000", "+1 202 555 0100", "abc", "04915700061", "13 00 00", null, undefined]) {
      assert.strictEqual(normaliseAuNumber(bad), null, `${JSON.stringify(bad)} must not normalise`);
    }
  });

  it("an invalid transfer number fails validation AND blocks provisioning", () => {
    const p = validProfile();
    p.transfer.primaryNumber = "0555 123 456";
    assert.ok(validateProfile(p).errors.some((e) => e.field === "primaryNumber"));
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "transfer_number_invalid"));
  });

  it("a missing transfer number blocks provisioning", () => {
    const p = validProfile();
    p.transfer.primaryNumber = null;
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "transfer_number_invalid"));
  });

  it("a backup identical to the primary is rejected", () => {
    const p = validProfile();
    p.transfer.backupNumber = p.transfer.primaryNumber;
    assert.ok(validateProfile(p).errors.some((e) => /same as the primary/i.test(e.message)));
  });

  it("promising to try a backup that does not exist is refused", () => {
    const p = validProfile();
    p.transfer.backupNumber = null;
    p.transfer.unansweredAction = "try_backup_number";
    assert.ok(validateProfile(p).errors.some((e) => e.field === "backupNumber"));
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "transfer_backup_missing"));
  });

  it("a missing fallback action is an error — silence is not a plan", () => {
    const p = validProfile();
    p.transfer.unansweredAction = null;
    assert.ok(validateProfile(p).errors.some((e) => e.field === "unansweredAction"));
  });

  it("out-of-range timeouts and attempt counts are rejected", () => {
    const p = validProfile();
    p.transfer.timeoutSeconds = 5;
    assert.ok(validateProfile(p).errors.some((e) => e.field === "timeoutSeconds"));
    p.transfer.timeoutSeconds = 30;
    p.transfer.maxAttempts = 99;
    assert.ok(validateProfile(p).errors.some((e) => e.field === "maxAttempts"));
  });
});

describe("urgency rules", () => {
  it("no rules blocks provisioning", () => {
    const p = validProfile();
    p.urgencyRules = [];
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "no_urgency_rules"));
  });

  it("unknown classifications and actions are rejected", () => {
    const p = validProfile();
    p.urgencyRules[0].classification = "very_urgent";
    assert.ok(validateProfile(p).errors.some((e) => /not a recognised .*classification/i.test(e.message)));
    p.urgencyRules[0].classification = "urgent";
    p.urgencyRules[0].action = "call_the_police";
    assert.ok(validateProfile(p).errors.some((e) => /not a recognised .*action/i.test(e.message)));
  });

  it("a rule that transfers immediately must be transfer-eligible", () => {
    const p = validProfile();
    p.urgencyRules[0].action = "transfer_immediately";
    p.urgencyRules[0].transferEligible = false;
    assert.ok(validateProfile(p).errors.some((e) => /not transfer-eligible/i.test(e.message)));
  });

  it("AIDA may never be scripted to promise emergency services", () => {
    const p = validProfile();
    for (const wording of [
      "I'll send an ambulance right away.",
      "The police are on their way.",
      "I'll call triple zero for you.",
      "Ring 000 and I'll stay on the line.",
    ]) {
      p.urgencyRules[0].approvedWording = wording;
      const result = validateProfile(p);
      assert.strictEqual(result.ok, false, `"${wording}" must be rejected`);
      assert.ok(result.errors.some((e) => /emergency services/i.test(e.message)));
    }
  });
});

describe("pricing", () => {
  it("pricing authority must be explicit — unset is ambiguous, not permissive", () => {
    const p = validProfile();
    p.pricing.mayMentionPricing = null;
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === "mayMentionPricing"));
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "pricing_authority_ambiguous"));
  });

  it("the safe default extracted from the demo interview is: no quote, human confirms", () => {
    const p = validProfile();
    assert.strictEqual(p.pricing.mayMentionPricing, false);
    assert.strictEqual(p.pricing.humanConfirmsEveryPrice, true);
  });

  it("mentioning pricing requires a disclaimer", () => {
    const p = validProfile();
    p.pricing.mayMentionPricing = true;
    p.pricing.disclaimer = "";
    assert.ok(validateProfile(p).errors.some((e) => e.field === "disclaimer"));
  });

  it("wording that promises a fixed price without human confirmation is refused", () => {
    const p = validProfile();
    p.pricing.mayMentionPricing = true;
    p.pricing.humanConfirmsEveryPrice = false;
    p.pricing.disclaimer = "Prices are indicative.";
    p.pricing.indicativePrices = [{ serviceId: "rekeying", wording: "A fixed price of $180 for a rekey." }];
    assert.ok(validateProfile(p).errors.some((e) => /fixed price but a human is not confirming/i.test(e.message)));
  });
});

describe("forbidden promises (the safety floor)", () => {
  it("every mandatory restriction is present on a valid profile", () => {
    const p = validProfile();
    const enabled = p.forbiddenPromises.filter((x) => x.enabled).map((x) => x.promiseId);
    for (const required of S.MANDATORY_FORBIDDEN_PROMISES) assert.ok(enabled.includes(required), `${required} must be forbidden`);
  });

  it("removing one fails validation and blocks provisioning", () => {
    const p = validProfile();
    p.forbiddenPromises = p.forbiddenPromises.filter((x) => x.promiseId !== "guaranteed_arrival_time");
    const result = validateProfile(p);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => /Guaranteeing an arrival time/i.test(e.message)));
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "forbidden_promises_missing"));
  });

  it("disabling one is the same as removing it — it cannot be switched off", () => {
    const p = validProfile();
    p.forbiddenPromises.find((x) => x.promiseId === "advise_illegal_entry").enabled = false;
    assert.strictEqual(validateProfile(p).ok, false);
  });

  it("an empty list blocks provisioning entirely", () => {
    const p = validProfile();
    p.forbiddenPromises = [];
    const { blockers } = assessProvisioning(p);
    assert.ok(blockers.some((b) => b.code === "forbidden_promises_missing"));
  });
});

describe("caller information", () => {
  it("a callback number must be collected on every call", () => {
    const p = validProfile();
    assert.ok(p.callerInfo.always.includes("callback_number"));
    p.callerInfo.always = p.callerInfo.always.filter((f) => f !== "callback_number");
    assert.ok(assessProvisioning(p).blockers.some((b) => b.code === "no_callback_number"));
  });

  it("unknown caller-info fields are rejected", () => {
    const p = validProfile();
    p.callerInfo.always.push("star_sign");
    assert.ok(validateProfile(p).errors.some((e) => /not a recognised always value/i.test(e.message)));
  });
});

describe("privacy preferences", () => {
  it("the client's stated preference is modelled without deciding legality", () => {
    const p = validProfile();
    assert.strictEqual(p.privacy.callsMayBeRecorded, false);
    assert.strictEqual(p.privacy.transcriptRetention, "keep_12_months");
    assert.strictEqual(p.privacy.redactSensitiveData, true);
    assert.strictEqual(validateProfile(p).ok, true);
  });

  it("recording requires disclosure wording", () => {
    const p = validProfile();
    p.privacy.callsMayBeRecorded = true;
    p.privacy.recordingDisclosure = null;
    assert.ok(validateProfile(p).errors.some((e) => e.field === "recordingDisclosure"));
  });

  it("unknown retention values are rejected", () => {
    const p = validProfile();
    p.privacy.transcriptRetention = "forever_and_ever";
    assert.ok(validateProfile(p).errors.some((e) => e.field === "transcriptRetention"));
  });

  it("an unset recording preference warns but does not block", () => {
    const p = validProfile();
    p.privacy.callsMayBeRecorded = null;
    const { ready, warnings } = assessProvisioning(p);
    assert.strictEqual(ready, true, "a soft gap must not block launch");
    assert.ok(warnings.some((w) => w.code === "recording_preference_unset"));
  });
});

describe("unknown enum values are rejected everywhere", () => {
  it("refuses invented values rather than silently dropping them", () => {
    const cases = [
      ["identity.tone", "extremely_chill"],
      ["identity.timezone", "Mars/Olympus"],
      ["serviceAreas.outsideAreaAction", "wing_it"],
      ["transfer.unansweredAction", "keep_ringing_forever"],
      ["privacy.transcriptRetention", "until_the_heat_death"],
      ["notifications.timing", "whenever"],
    ];
    for (const [path, value] of cases) {
      const p = validProfile();
      const [section, field] = path.split(".");
      p[section][field] = value;
      const result = validateProfile(p);
      assert.strictEqual(result.ok, false, `${path} = ${value} must be rejected`);
    }
  });

  it("an unknown service id is rejected", () => {
    const p = validProfile();
    p.servicesAccepted[0].serviceId = "teleportation";
    assert.ok(validateProfile(p).errors.some((e) => /not a recognised/i.test(e.message)));
  });
});

describe("hostile input is stored verbatim and never sanitised in place", () => {
  it("markup in a business name is not itself a validation failure", () => {
    const p = validProfile();
    p.identity.spokenName = '<script>alert("xss")</script>';
    const result = validateProfile(p);
    assert.strictEqual(result.ok, true, "escaping is an output concern, not a storage one");
    assert.strictEqual(p.identity.spokenName, '<script>alert("xss")</script>', "input must not be mangled");
  });

  it("legitimate punctuation survives", () => {
    const p = validProfile();
    p.identity.spokenName = "O'Brien & Sons Locksmiths (VIC)";
    assert.strictEqual(validateProfile(p).ok, true);
  });

  it("over-long values are rejected rather than truncated", () => {
    const p = validProfile();
    p.identity.spokenName = "x".repeat(201);
    assert.ok(validateProfile(p).errors.some((e) => e.field === "spokenName"));
  });
});

describe("the extensions bag cannot be used to smuggle real fields", () => {
  it("reserved keys are rejected", () => {
    for (const key of ["transfer", "pricing", "provisioningReady", "status", "schemaVersion"]) {
      const p = validProfile();
      p.extensions = { [key]: "sneaky" };
      const result = validateProfile(p);
      assert.strictEqual(result.ok, false, `extensions.${key} must be rejected`);
    }
  });

  it("small genuine extensions are allowed", () => {
    const p = validProfile();
    p.extensions = { preferredVanColour: "white", crmReference: "abc-123" };
    assert.strictEqual(validateProfile(p).ok, true);
  });

  it("a large extensions blob is refused — it is not a place to hide a schema", () => {
    const p = validProfile();
    p.extensions = { notes: "x".repeat(5000) };
    assert.ok(validateProfile(p).errors.some((e) => e.section === "extensions"));
  });
});

describe("schema version", () => {
  it("a profile claiming an unknown schema version is rejected", () => {
    const p = validProfile();
    p.schemaVersion = "locksmith-profile-1999-01-01";
    assert.ok(validateProfile(p).errors.some((e) => e.field === "schemaVersion"));
  });
});

describe("provisioning readiness is deterministic", () => {
  it("the same profile always produces the same verdict and blockers", () => {
    const p = validProfile();
    const first = assessProvisioning(p);
    const second = assessProvisioning(JSON.parse(JSON.stringify(p)));
    assert.deepStrictEqual(first, second);
  });

  it("each blocker names a specific fact, never a generic failure", () => {
    const broken = S.emptyProfile();
    const { ready, blockers } = assessProvisioning(broken);
    assert.strictEqual(ready, false);
    assert.ok(blockers.length > 0);
    for (const b of blockers) {
      assert.ok(b.code && b.message, "every blocker needs a code and a message");
      assert.ok(b.message.length > 15, `blocker "${b.code}" must explain itself: "${b.message}"`);
    }
  });

  it("an unparseable profile does not throw", () => {
    for (const junk of [null, undefined, "profile", 42, []]) {
      assert.doesNotThrow(() => assessProvisioning(junk), `assessProvisioning(${JSON.stringify(junk)}) must not throw`);
      assert.strictEqual(assessProvisioning(junk).ready, false);
    }
  });
});
