// AIDA Locksmith Receptionist M1 — configuration + demonstration-data tests.
//
// Guards the two things that make the public page safe to show a stranger:
//   1. nothing on it is invented (no phone number, ABN, contact or URL the
//      founder hasn't supplied — those render as explicit placeholders), and
//   2. every demonstration record is labelled as demonstration data.
//
// Pure modules — runs without node_modules.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getLocksmithConfig,
  isLocksmithPilotEnabled,
  isEnquiryFormEnabled,
  locksmithRouterGate,
  unresolvedPlaceholders,
  isPlaceholder,
  PUBLIC_PATH,
  ENQUIRY_PATH,
} = require("../src/config/locksmith");

const demo = require("../src/services/locksmith-demo");

describe("page flag (LOCKSMITH_PILOT_ENABLED — dormant by default, strict parse)", () => {
  it('the page is off unless the env says exactly "true"', () => {
    assert.strictEqual(isLocksmithPilotEnabled({}), false, "an unset variable means the feature does not exist");
    assert.strictEqual(isLocksmithPilotEnabled({ LOCKSMITH_PILOT_ENABLED: "true" }), true);
    // Near-misses do NOT enable — the pilot cannot go live by accident.
    for (const v of ["TRUE", "True", "1", "yes", "on", "false", ""]) {
      assert.strictEqual(isLocksmithPilotEnabled({ LOCKSMITH_PILOT_ENABLED: v }), false, `"${v}" must not enable`);
    }
  });

  it("the gate exits the whole router while dormant (404 pass-through), plain next() when on", () => {
    for (const env of [{}, { LOCKSMITH_PILOT_ENABLED: "false" }, { LOCKSMITH_PILOT_ENABLED: "1" }, { LOCKSMITH_PILOT_ENABLED: "TRUE" }]) {
      let called = "never";
      locksmithRouterGate(env)({}, {}, (arg) => { called = arg; });
      assert.strictEqual(called, "router", `env ${JSON.stringify(env)} must exit the router`);
    }

    let called = "never";
    locksmithRouterGate({ LOCKSMITH_PILOT_ENABLED: "true" })({}, {}, (arg) => { called = arg; });
    assert.strictEqual(called, undefined, "enabled: plain next()");
  });
});

describe("enquiry flag (LOCKSMITH_ENQUIRY_ENABLED — off by default, strict parse)", () => {
  it('only the exact string "true" enables submissions', () => {
    assert.strictEqual(isEnquiryFormEnabled({}), false, "M1 default: submissions off");
    assert.strictEqual(isEnquiryFormEnabled({ LOCKSMITH_ENQUIRY_ENABLED: "true" }), true);
    for (const v of ["TRUE", "True", "1", "yes", "on", "false", ""]) {
      assert.strictEqual(isEnquiryFormEnabled({ LOCKSMITH_ENQUIRY_ENABLED: v }), false, `"${v}" must not enable`);
    }
  });
});

describe("config — nothing is invented", () => {
  it("an empty env yields placeholders, never fabricated details", () => {
    const config = getLocksmithConfig({});

    assert.ok(isPlaceholder(config.demoPhone), "demo phone must be a placeholder");
    assert.strictEqual(config.demoPhoneResolved, false);
    assert.strictEqual(config.cta.demoHref, null, "no tel: link without a real number");
    assert.ok(isPlaceholder(config.trust.abn));
    assert.ok(isPlaceholder(config.trust.contactEmail));
    assert.ok(isPlaceholder(config.trust.privacyUrl));
    assert.ok(isPlaceholder(config.trust.termsUrl));

    // No digit sequence anywhere in the placeholder values that could read as
    // a phone number or an ABN.
    const joined = [config.demoPhone, config.trust.abn, config.trust.contactEmail].join(" ");
    assert.ok(!/\d{4,}/.test(joined), `placeholders must contain no long digit runs: ${joined}`);
  });

  it("unresolvedPlaceholders lists exactly what the founder still has to supply", () => {
    const empty = unresolvedPlaceholders(getLocksmithConfig({}));
    assert.deepStrictEqual(
      empty.map((p) => p.key).sort(),
      ["LOCKSMITH_CONTACT_EMAIL", "LOCKSMITH_DEMO_PHONE", "NICHE_DROPS_ABN", "NICHE_DROPS_PRIVACY_URL", "NICHE_DROPS_TERMS_URL"]
    );

    const filled = unresolvedPlaceholders(
      getLocksmithConfig({
        LOCKSMITH_DEMO_PHONE: "+61300000000",
        NICHE_DROPS_ABN: "00 000 000 000",
        LOCKSMITH_CONTACT_EMAIL: "hello@example.com.au",
        NICHE_DROPS_PRIVACY_URL: "https://example.com.au/privacy",
        NICHE_DROPS_TERMS_URL: "https://example.com.au/terms",
      })
    );
    assert.deepStrictEqual(filled, [], "a fully configured env has nothing outstanding");
  });

  it("a supplied demo number becomes a tel: link with separators stripped", () => {
    const config = getLocksmithConfig({ LOCKSMITH_DEMO_PHONE: "+61 3 9000 0000" });
    assert.strictEqual(config.demoPhoneResolved, true);
    assert.strictEqual(config.cta.demoHref, "tel:+61390000000");
  });
});

describe("config — pricing and pilot values are central and overridable", () => {
  it("defaults match the founding-pilot offer", () => {
    const { pricing, pilot } = getLocksmithConfig({});
    assert.strictEqual(pricing.currency, "A$");
    assert.strictEqual(pricing.setupAmount, 149);
    assert.strictEqual(pricing.monthlyAmount, 299);
    assert.strictEqual(pricing.includedDays, 14);
    assert.strictEqual(pricing.commitment, "Month-to-month");
    assert.match(pricing.usageAllowance, /confirmed during setup/i);
    assert.strictEqual(pilot.limit, 3);
    assert.strictEqual(pilot.region, "Melbourne");
  });

  it("env overrides win, and junk falls back rather than rendering nonsense", () => {
    const overridden = getLocksmithConfig({
      LOCKSMITH_SETUP_PRICE: "199",
      LOCKSMITH_MONTHLY_PRICE: "349",
      LOCKSMITH_INCLUDED_DAYS: "21",
      LOCKSMITH_PILOT_LIMIT: "5",
      LOCKSMITH_PILOT_REGION: "Geelong",
    });
    assert.strictEqual(overridden.pricing.setupAmount, 199);
    assert.strictEqual(overridden.pricing.monthlyAmount, 349);
    assert.strictEqual(overridden.pricing.includedDays, 21);
    assert.strictEqual(overridden.pilot.limit, 5);
    assert.strictEqual(overridden.pilot.region, "Geelong");

    for (const bad of ["free", "-10", "0", "12.5", ""]) {
      const c = getLocksmithConfig({ LOCKSMITH_MONTHLY_PRICE: bad });
      assert.strictEqual(c.pricing.monthlyAmount, 299, `"${bad}" must fall back to the default`);
    }
  });

  it("paths and disclosures are fixed, not env-tunable", () => {
    const config = getLocksmithConfig({ LOCKSMITH_PUBLIC_PATH: "/somewhere-else" });
    assert.strictEqual(config.publicPath, PUBLIC_PATH);
    assert.strictEqual(config.publicPath, "/locksmith-receptionist");
    assert.strictEqual(config.enquiryPath, ENQUIRY_PATH);
    assert.match(config.trust.aiDisclosure, /AI-powered phone receptionist, not a human/i);
    assert.match(config.trust.rulesDisclosure, /rules each locksmith business configures/i);
  });

  it("the config object is frozen — no route can mutate shared product facts", () => {
    const config = getLocksmithConfig({});
    assert.throws(() => { "use strict"; config.productName = "hacked"; }, TypeError);
    assert.throws(() => { "use strict"; config.pricing.monthlyAmount = 0; }, TypeError);
  });
});

describe("demonstration data — labelled, safe, and free of invented contact details", () => {
  const allRecords = [...demo.SCENARIOS, ...demo.EXAMPLE_CALLS, ...demo.DASHBOARD.recentCalls];

  it("every scenario, example call and dashboard row is flagged as demo data", () => {
    assert.strictEqual(allRecords.length, 4 + 4 + 6);
    for (const r of allRecords) {
      assert.strictEqual(r.demo, true, `${r.id} must carry demo: true`);
      assert.strictEqual(r.demoLabel, demo.DEMO_LABEL, `${r.id} must carry the demo label`);
    }
  });

  it("the dashboard is a demonstration workspace, not a customer's", () => {
    assert.strictEqual(demo.DASHBOARD.demo, true);
    assert.strictEqual(demo.DASHBOARD.label, "Demonstration workspace — example locksmith calls");
    assert.strictEqual(demo.DASHBOARD.metrics.length, 6);
    const keys = demo.DASHBOARD.metrics.map((m) => m.key);
    for (const required of ["answered", "urgent", "transfers", "leads", "afterHours"]) {
      assert.ok(keys.includes(required), `dashboard must report ${required}`);
    }
    for (const m of demo.DASHBOARD.metrics) {
      assert.ok(Number.isInteger(m.value) && m.value >= 0, `${m.key} must be a plain count`);
    }
  });

  it("recent calls carry every field the preview promises", () => {
    for (const call of demo.DASHBOARD.recentCalls) {
      for (const field of ["when", "caller", "suburb", "serviceType", "urgency", "outcome", "summary"]) {
        assert.ok(call[field], `${call.id} is missing ${field}`);
      }
      assert.ok(call.urgency.label && call.urgency.marker, "urgency needs a text label AND a non-colour marker");
    }
  });

  it("no invented phone numbers, emails, ABNs or surnames anywhere in the dataset", () => {
    const text = JSON.stringify(allRecords) + JSON.stringify(demo.DASHBOARD.metrics);
    assert.ok(!/\b0[2-478]\d{8}\b/.test(text), "no AU national-format numbers");
    assert.ok(!/\+61\d/.test(text), "no +61 numbers");
    assert.ok(!/\b(1300|1800)\d{6}\b/.test(text), "no 1300/1800 numbers");
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), "no email addresses");
    assert.ok(!/\bABN\b/i.test(text), "no ABNs");
    // Callers are first name + single initial only.
    for (const r of allRecords) {
      if (!r.caller) continue;
      assert.match(r.caller, /^[A-Z][a-z]+ [A-Z]\.$/, `caller "${r.caller}" must be a first name + initial`);
    }
  });

  it("example calls ship no audio and keep the slot for it", () => {
    assert.strictEqual(demo.EXAMPLE_CALLS.length, 4);
    for (const call of demo.EXAMPLE_CALLS) {
      assert.strictEqual(call.audioUrl, null, "M1 embeds no audio");
      assert.ok(Array.isArray(call.transcript) && call.transcript.length >= 4, "each example needs a mock transcript");
      for (const field of ["scenario", "summary", "urgency", "outcome", "action"]) {
        assert.ok(call[field], `${call.id} is missing ${field}`);
      }
      // The caller must be told they're talking to an automated assistant.
      const aidaLines = call.transcript.filter((l) => l.speaker === "AIDA").map((l) => l.text).join(" ");
      assert.match(aidaLines, /automated assistant/i, `${call.id} must disclose the assistant to the caller`);
    }
  });

  it("the four required scenarios are present and cover the required urgency mix", () => {
    const ids = demo.SCENARIOS.map((s) => s.id);
    assert.deepStrictEqual(ids, ["residential-lockout", "vehicle-key", "commercial-access", "lock-replacement"]);
    assert.strictEqual(demo.SCENARIOS[3].urgency.key, "routine", "the quote enquiry must not be urgent");
    for (const s of demo.SCENARIOS) {
      for (const field of ["caller", "suburb", "jobType", "urgency", "summary", "action"]) {
        assert.ok(s[field], `${s.id} is missing ${field}`);
      }
    }
  });

  it("all eleven advertised capabilities are described", () => {
    assert.strictEqual(demo.CAPABILITIES.length, 11);
    const titles = demo.CAPABILITIES.map((c) => c.title.toLowerCase()).join(" | ");
    for (const needle of [
      "after-hours", "greeting", "callback number", "suburb", "classification",
      "urgency", "transfer", "escalation", "summaries", "transcripts", "existing number",
    ]) {
      assert.ok(titles.includes(needle), `capabilities must cover "${needle}"`);
    }
  });

  it("how-it-works is exactly the five specified steps, in order", () => {
    assert.deepStrictEqual(demo.HOW_IT_WORKS.map((s) => s.step), [1, 2, 3, 4, 5]);
  });
});
