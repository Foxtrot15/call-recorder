// M8A — the setup wizard's routes, rendering, mobile layout and accessibility.
//
// Runs on a bare checkout: no node_modules, no database, no network. Routes are
// exercised through the injected-deps handler factory with fake req/res, the
// house pattern (never supertest).
//
// Service-layer coverage lives in test/locksmith-setup-journey.test.js.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const S = require("../src/services/locksmith-profile-schema");
const steps = require("../src/services/locksmith-onboarding-steps");
const views = require("../src/views/locksmith-setup-page");
const draftService = require("../src/services/locksmith-onboarding-draft");
const { createSetupHandlers, PAGE_SECURITY_HEADERS, statusFor } = require("../src/routes/locksmith-setup-handlers");
const onboardingConfig = require("../src/config/locksmith-onboarding");

const CLIENT = "acme-locks";
const SILENT = { log() {}, error() {} };

// ── Fakes ───────────────────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    contentType: null,
    status(c) { this.statusCode = c; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    type(t) { this.contentType = t; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
}

function req(extra = {}) {
  return {
    headers: {},
    body: {},
    query: {},
    params: {},
    ip: "127.0.0.1",
    clientId: CLIENT,
    clientAuth: { user: { id: "user-1" } },
    ...extra,
  };
}

function jsonReq(body, extra = {}) {
  return req({ headers: { "content-type": "application/json" }, body, ...extra });
}

/** A stub service so route behaviour is tested without re-testing the service. */
function stubService(overrides = {}) {
  const profile = fullProfile();
  const base = {
    async loadDraft() {
      return { ok: true, outcome: "ok", version: 3, status: "draft", profile, updatedAt: "2026-08-04T00:00:00.000Z", progress: steps.assessProgress(profile) };
    },
    async startDraft() {
      return { ok: true, outcome: "ok", created: true, version: 3, status: "draft", profile, updatedAt: "2026-08-04T00:00:00.000Z", progress: steps.assessProgress(profile) };
    },
    async saveStep({ stepId }) {
      return { ok: true, outcome: "ok", stepId, nextStepId: steps.nextStepId(stepId), version: 3, status: "draft", profile, updatedAt: "2026-08-04T00:00:01.000Z", progress: steps.assessProgress(profile) };
    },
    async submitForReview() {
      return { ok: true, outcome: "ok", version: 3, status: "needs_review", profile, updatedAt: "2026-08-04T00:00:02.000Z", progress: steps.assessProgress(profile) };
    },
    async loadForReview() {
      return {
        ok: true, outcome: "ok", submitted: false, confirmations: {},
        outstandingConfirmations: S.CONFIRMATION_KEYS.slice(), outstandingSteps: steps.STEP_IDS.slice(),
        version: 3, status: "draft", profile, updatedAt: "2026-08-04T00:00:00.000Z", progress: steps.assessProgress(profile),
      };
    },
    async confirmSection({ section }) {
      return { ok: true, outcome: "ok", section, outstandingConfirmations: [], outstandingSteps: [], updatedAt: "2026-08-04T00:00:03.000Z" };
    },
    async approve() {
      return { ok: true, outcome: "ok", version: 3, activated: false };
    },
    async rollbackToVersion({ version }) {
      return { ok: true, outcome: "ok", restoredFromVersion: version, version: 4, status: "draft", profile, updatedAt: "x", progress: steps.assessProgress(profile) };
    },
    async listHistory() {
      return { ok: true, outcome: "ok", versions: [{ version: 2, status: "approved", createdAt: "2026-08-01T00:00:00.000Z", approvedAt: "2026-08-01T00:00:00.000Z", restorable: true, provisioningReady: true, supersededByVersion: null, rejectionReason: null, updatedAt: "2026-08-01T00:00:00.000Z" }] };
    },
  };
  return { ...base, ...overrides };
}

function stubStore(approved = null) {
  return {
    async getApprovedVersion() { return approved; },
    async listVersions() { return approved ? [approved] : []; },
  };
}

function handlers(opts = {}) {
  return createSetupHandlers({
    service: stubService(opts.service),
    store: stubStore(opts.approved || null),
    logger: SILENT,
    env: {},
    ...opts.extra,
  });
}

// ── A complete profile to render ────────────────────────────────────

const ANSWERS = {
  identity: {
    spokenName: "Peninsula Lock & Key", legalName: "Peninsula Lock and Key Pty Ltd", businessPhone: "0491570010",
    ownerName: "Sam Carter", ownerEmail: "sam@example.com", receptionistName: "Robbie",
    greeting: "Peninsula Lock & Key, this is Robbie, how can I help?", timezone: "Australia/Melbourne",
    description: "Family-run locksmith on the Mornington Peninsula.",
  },
  services: {
    services: { residential_lockout: "accepted", commercial_locksmith: "accepted", rekeying: "accepted", lock_installation: "accepted", broken_key_extraction: "accepted", break_in_security: "accepted", automotive_lockout: "declined", safe_opening: "declined" },
    proofOfOwnership: true, declinedNote: "No car work.",
  },
  areas: { primary: "Frankston\nSeaford", extended: "Mornington", declined: "Dandenong", outsideAreaAction: "collect_details_for_confirmation", afterHoursAreas: "" },
  hours: {
    ordinary: {
      monday: { closed: false, open: "08:00", close: "17:00" }, tuesday: { closed: false, open: "08:00", close: "17:00" },
      wednesday: { closed: false, open: "08:00", close: "17:00" }, thursday: { closed: false, open: "08:00", close: "17:00" },
      friday: { closed: false, open: "08:00", close: "17:00" }, saturday: { closed: false, open: "08:00", close: "13:00" }, sunday: { closed: true },
    },
    afterHoursAvailable: true, afterHoursNote: "Lockouts and break-ins all night.", publicHolidays: "byArrangement",
    callbackEstimate: { standard: { minMinutes: 30, maxMinutes: 90 }, urgent: { minMinutes: 5, maxMinutes: 15 } },
  },
  jobs: {
    urgencyPresets: ["residential_lockout_after_hours", "vulnerable_person", "break_in_unsecured", "quote_or_spare_key"],
    callerInfoAlways: ["callback_number", "caller_name", "suburb", "street_address", "problem_description"],
    mayMentionPricing: false, calloutWording: "", humanConfirmsEveryPrice: true, neverState: "That we're the cheapest",
  },
  contact: {
    transferPrimary: "0491570006", transferBackup: "0491570015", permittedHours: "always", collectDetailsFirst: true,
    unansweredAction: "try_backup_number", notifySms: "0491570006", notifyEmail: "sam@example.com",
    notifyExtraEmail: "office@example.com", notificationTiming: "immediate",
  },
  tone: { tone: "friendly_australian_trade", toneWording: "Say 'no worries'.", callsMayBeRecorded: "false", transcriptRetention: "keep_12_months", redactSensitiveData: true },
};

function fullProfile() {
  let p = draftService.seedProfile(CLIENT);
  for (const step of steps.STEPS) p = steps.applyStep(step.id, steps.lookup(ANSWERS, step.id), p);
  return p;
}

// ════════════════════════════════════════════════════════════════════

describe("M8A confirmation coverage", () => {
  test("every step declares the profile sections it owns", () => {
    for (const step of steps.STEPS) {
      assert.ok(Array.isArray(step.profileSections) && step.profileSections.length > 0, `${step.id} owns no profile section`);
      for (const section of step.profileSections) {
        assert.ok(S.SECTION_KEYS.includes(section), `${step.id} claims "${section}", which is not a profile section`);
      }
    }
  });

  test("ticking all seven steps ticks all twelve safety-critical sections", () => {
    const covered = new Set(steps.STEPS.flatMap((s) => s.profileSections));
    const missing = S.CONFIRMATION_KEYS.filter((k) => !covered.has(k));
    assert.deepEqual(missing, [], "a confirmable section is unreachable from the wizard — approval would be permanently blocked");
  });

  test("no section is claimed by two steps", () => {
    const seen = new Map();
    for (const step of steps.STEPS) {
      for (const section of step.profileSections) {
        assert.equal(seen.get(section), undefined, `"${section}" is owned by both ${seen.get(section)} and ${step.id}`);
        seen.set(section, step.id);
      }
    }
  });
});

describe("M8A routes: the dormant gate", () => {
  test("the whole surface is behind LOCKSMITH_ONBOARDING_ENABLED", () => {
    assert.equal(onboardingConfig.isOnboardingEnabled({}), false);
    for (const v of ["TRUE", "1", "yes", " true"]) {
      assert.equal(onboardingConfig.isOnboardingEnabled({ LOCKSMITH_ONBOARDING_ENABLED: v }), false, `"${v}" must not enable onboarding`);
    }
    assert.equal(onboardingConfig.isOnboardingEnabled({ LOCKSMITH_ONBOARDING_ENABLED: "true" }), true);
  });

  test("the gate exits the router, so a disabled deploy 404s before any auth runs", () => {
    let exited = null;
    onboardingConfig.onboardingRouterGate({})({}, {}, (arg) => { exited = arg; });
    assert.equal(exited, "router");
  });

  test("every setup route is registered behind requireClientAuth", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "locksmith-onboarding.js"), "utf8");
    const lines = source.split("\n").filter((l) => l.includes("/client/locksmith-setup"));
    assert.ok(lines.length >= 10, `expected the full setup surface, found ${lines.length} routes`);
    for (const line of lines) {
      assert.ok(line.includes("requireClientAuth"), `an unauthenticated setup route: ${line.trim()}`);
    }
  });

  test("the fixed setup paths are declared before the :stepId route", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "locksmith-onboarding.js"), "utf8");
    const stepRoute = source.indexOf('/client/locksmith-setup/step/:stepId');
    for (const fixed of ["/client/locksmith-setup/review", "/client/locksmith-setup/history", "/client/locksmith-setup/test", "/client/locksmith-setup/activate"]) {
      assert.ok(source.indexOf(fixed) < stepRoute, `"${fixed}" is declared after :stepId and would be swallowed as a step id`);
    }
  });
});

describe("M8A routes: pages", () => {
  test("the setup home renders with security headers and no caching", async () => {
    const res = fakeRes();
    await handlers().setupHome(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, "html");
    for (const key of Object.keys(PAGE_SECURITY_HEADERS)) {
      assert.equal(res.headers[key], PAGE_SECURITY_HEADERS[key], `missing header ${key}`);
    }
    assert.match(res.headers["Cache-Control"], /no-store/);
  });

  test("every step id renders a page", async () => {
    for (const stepId of steps.STEP_IDS) {
      const res = fakeRes();
      await handlers().setupStep(req({ params: { stepId } }), res);
      assert.equal(res.statusCode, 200, `${stepId} did not render`);
      assert.match(res.body, /<form class="setup-form"/, `${stepId} rendered no form`);
    }
  });

  test("an unknown step id does not render a form", async () => {
    for (const bad of ["nope", "constructor", "__proto__", "toString"]) {
      const res = fakeRes();
      await handlers().setupStep(req({ params: { stepId: bad } }), res);
      assert.equal(res.statusCode, 503, `"${bad}" was accepted`);
      assert.ok(!/setup-form/.test(res.body), `"${bad}" rendered a form`);
    }
  });

  test("review, history, test and activate all render", async () => {
    const h = handlers();
    for (const [name, fn] of [["review", h.setupReview], ["history", h.setupHistory], ["test", h.setupTest], ["activate", h.setupActivate]]) {
      const res = fakeRes();
      await fn(req(), res);
      assert.equal(res.statusCode, 200, `${name} failed`);
      assert.match(res.body, /<h1>/, `${name} rendered no heading`);
    }
  });
});

describe("M8A routes: JSON-only mutations (the CSRF posture)", () => {
  const mutations = [
    ["saveStep", (h) => h.saveStep, { params: { stepId: "identity" } }],
    ["submitSetup", (h) => h.submitSetup, {}],
    ["confirmSection", (h) => h.confirmSection, {}],
    ["approve", (h) => h.approve, {}],
    ["rollback", (h) => h.rollback, {}],
  ];

  test("every mutation refuses a non-JSON content type with 415", async () => {
    for (const [name, pick, extra] of mutations) {
      const res = fakeRes();
      await pick(handlers())(req({ headers: { "content-type": "application/x-www-form-urlencoded" }, ...extra }), res);
      assert.equal(res.statusCode, 415, `${name} accepted a form post`);
    }
  });

  test("every mutation refuses a missing content type", async () => {
    for (const [name, pick, extra] of mutations) {
      const res = fakeRes();
      await pick(handlers())(req(extra), res);
      assert.equal(res.statusCode, 415, `${name} accepted a body with no content type`);
    }
  });

  test("a valid JSON save returns the next step and the new concurrency token", async () => {
    const res = fakeRes();
    await handlers().saveStep(jsonReq({ answers: ANSWERS.identity }, { params: { stepId: "identity" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.nextStepId, "services");
    assert.ok(res.body.updatedAt);
  });

  test("a refused save reports field errors with 422 and no partial success", async () => {
    const h = handlers({
      service: {
        async saveStep() {
          return { ok: false, outcome: "invalid_answers", message: "Some answers need another look.", errors: { businessPhone: "That doesn't look like an Australian phone number." } };
        },
      },
    });
    const res = fakeRes();
    await h.saveStep(jsonReq({ answers: {} }, { params: { stepId: "identity" } }), res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.errors.businessPhone);
  });

  test("every service outcome maps to a deliberate status, never a default", async () => {
    const expected = { not_authorised: 403, unknown_step: 404, no_draft: 409, stale_draft: 409, incomplete: 422, bad_version: 404, invalid_answers: 422, store_unavailable: 503 };
    for (const outcome of Object.keys(expected)) {
      assert.equal(statusFor(outcome), expected[outcome], `"${outcome}" maps to the wrong status`);
    }
    // An outcome nobody mapped falls to 400, never to 200 or 500.
    assert.equal(statusFor("something_new"), 400);
    assert.equal(statusFor("constructor"), 400, "prototype lookup reached the status table");
  });

  test("approval refusal uses the worst-kind-wins status convention", async () => {
    for (const [kind, status] of [["auth", 403], ["conflict", 409], ["state", 409], ["content", 422]]) {
      const h = handlers({
        service: { async approve() { return { ok: false, outcome: "invalid_answers", message: "no", blockers: [{ kind, code: "x", message: "y" }] }; } },
      });
      const res = fakeRes();
      await h.approve(jsonReq({}), res);
      assert.equal(res.statusCode, status, `blocker kind "${kind}" produced ${res.statusCode}`);
    }
  });

  test("approval never reports itself as activation", async () => {
    const res = fakeRes();
    await handlers().approve(jsonReq({}), res);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.activated, false);
    assert.match(res.body.message, /isn't switched over|not switched/i);
  });

  test("a restore says plainly that it did not go live", async () => {
    const res = fakeRes();
    await handlers().rollback(jsonReq({ version: 2 }), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.message, /new draft/i);
    assert.match(res.body.message, /approve/i);
  });
});

describe("M8A tenant isolation at the route layer", () => {
  test("no handler reads a client id from the body, query or path", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "locksmith-setup-handlers.js"), "utf8");
    for (const pattern of [/body\.clientId/, /query\.clientId/, /params\.clientId/, /body\.client_id/]) {
      assert.ok(!pattern.test(source), `a client id is read from a request payload: ${pattern}`);
    }
    assert.ok(/req\.clientId/.test(source), "the verified session client id is never used");
  });

  test("the tenant key passed to the service is always req.clientId", async () => {
    const seen = [];
    const h = handlers({
      service: {
        async loadDraft({ clientId }) { seen.push(clientId); return { ok: false, outcome: "no_draft", message: "none" }; },
        async startDraft({ clientId }) { seen.push(clientId); return { ok: true, outcome: "ok", version: 1, status: "draft", profile: fullProfile(), updatedAt: "x", progress: steps.assessProgress(fullProfile()) }; },
      },
    });
    await h.setupHome(req({ clientId: "tenant-a", body: { clientId: "tenant-b" }, query: { clientId: "tenant-c" }, params: { clientId: "tenant-d" } }), fakeRes());
    assert.ok(seen.length > 0);
    for (const id of seen) assert.equal(id, "tenant-a", "a client id from a payload reached the service");
  });

  test("the actor carries the session's client id, not the body's", async () => {
    let actor = null;
    const h = handlers({ service: { async saveStep(args) { actor = args.actor; return { ok: true, outcome: "ok", stepId: "identity", nextStepId: "services", version: 1, status: "draft", profile: fullProfile(), updatedAt: "x", progress: steps.assessProgress(fullProfile()) }; } } });
    await h.saveStep(jsonReq({ answers: {}, actor: { clientId: "evil" }, clientId: "evil" }, { params: { stepId: "identity" } }), fakeRes());
    assert.equal(actor.clientId, CLIENT);
    assert.equal(actor.type, "client");
  });
});

// ── Rendering ───────────────────────────────────────────────────────

function renderEveryStep() {
  const profile = fullProfile();
  return steps.STEPS.map((step) =>
    views.renderSetupStep({
      step,
      answers: steps.readStep(step.id, profile),
      errors: {},
      progress: steps.assessProgress(profile),
      version: 3,
      updatedAt: "2026-08-04T00:00:00.000Z",
    })
  );
}

describe("M8A accessibility", () => {
  test("every visible input has a label, a legend, or is inside a labelled fieldset", () => {
    for (const html of renderEveryStep()) {
      // Every id referenced by a `for` exists, and vice versa for text inputs.
      const forAttrs = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
      const ids = [...html.matchAll(/id="(f-[^"]+|h-[^"]+|e-[^"]+)"/g)].map((m) => m[1]);
      for (const target of forAttrs) {
        assert.ok(ids.includes(target), `a label points at "${target}", which does not exist`);
      }
      // Grouped controls are always in a fieldset with a legend.
      const fieldsets = [...html.matchAll(/<fieldset[\s\S]*?<\/fieldset>/g)].map((m) => m[0]);
      for (const fs_ of fieldsets) {
        assert.match(fs_, /<legend/, "a fieldset with no legend");
      }
    }
  });

  test("radio and checkbox controls are wrapped in their own <label>", () => {
    for (const html of renderEveryStep()) {
      const inputs = [...html.matchAll(/<input type="(radio|checkbox)"[^>]*>/g)].map((m) => m[0]);
      for (const input of inputs) {
        const at = html.indexOf(input);
        const before = html.slice(Math.max(0, at - 200), at);
        assert.match(before, /<label[^>]*>\s*$/, `an unlabelled control: ${input.slice(0, 80)}`);
      }
    }
  });

  test("every page has a skip link, a main landmark and a live region", () => {
    for (const html of renderEveryStep()) {
      assert.match(html, /class="skip-link" href="#main"/);
      assert.match(html, /<main id="main"/);
      assert.match(html, /aria-live="polite"/);
    }
  });

  test("the stage indicator is an ordered list with aria-current on exactly one item", () => {
    for (const html of renderEveryStep()) {
      assert.match(html, /<nav class="stage-nav" aria-label="Setup progress">/);
      assert.match(html, /<ol class="stage-list">/);
      const current = html.match(/aria-current="step"/g) || [];
      assert.equal(current.length, 1, `expected exactly one current stage, found ${current.length}`);
    }
  });

  test("errors are wired with aria-describedby and aria-invalid", () => {
    const step = steps.getStep("identity");
    const html = views.renderSetupStep({
      step,
      answers: {},
      errors: { businessPhone: "That doesn't look like an Australian phone number." },
      progress: steps.assessProgress(draftService.seedProfile(CLIENT)),
      version: 1,
      updatedAt: "x",
    });
    assert.match(html, /id="f-businessPhone-error"/);
    assert.match(html, /aria-describedby="[^"]*f-businessPhone-error/);
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /That doesn&#39;t look like an Australian phone number\./);
  });

  test("required fields are marked for a screen reader, not only with an asterisk", () => {
    const html = renderEveryStep()[0];
    assert.match(html, /<span class="field__required" aria-hidden="true">\*<\/span><span class="visually-hidden"> \(required\)<\/span>/);
  });

  test("a page without JavaScript says so rather than silently losing answers", () => {
    for (const html of renderEveryStep()) {
      assert.match(html, /<noscript>/);
      assert.match(html, /needs JavaScript/i);
    }
  });
});

describe("M8A mobile layout", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "locksmith", "setup.css"), "utf8");

  test("every page declares a responsive viewport", () => {
    for (const html of renderEveryStep()) {
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    }
  });

  test("the stylesheet is mobile-first: every media query widens, none narrows", () => {
    const queries = [...css.matchAll(/@media\s*\(([^)]+)\)/g)].map((m) => m[1].trim());
    const widthQueries = queries.filter((q) => /width/.test(q));
    assert.ok(widthQueries.length > 0, "no responsive breakpoints at all");
    for (const q of widthQueries) {
      assert.match(q, /min-width/, `"${q}" is a max-width query — the base styles are not the mobile ones`);
    }
  });

  test("nothing is laid out in a fixed width that would overflow 320px", () => {
    // A fixed px width above ~296 (320 minus the 12px padding each side) cannot
    // fit, and produces the horizontal scroll this rule exists to prevent.
    const widths = [...css.matchAll(/(?:^|[;{])\s*(?:min-)?width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    for (const w of widths) {
      assert.ok(w <= 296, `a ${w}px fixed width cannot fit a 320px screen`);
    }
  });

  test("inputs are at least 16px so iOS does not zoom on focus", () => {
    const inputRule = css.match(/\.input \{[\s\S]*?\}/);
    assert.ok(inputRule, "no .input rule");
    assert.match(inputRule[0], /font-size:\s*16px/);
  });

  test("tap targets are at least 44px", () => {
    for (const selector of [".input", ".choice", ".checkbox"]) {
      const rule = css.match(new RegExp(`\\${selector} \\{[\\s\\S]*?\\}`));
      assert.ok(rule, `no rule for ${selector}`);
      assert.match(rule[0], /min-height:\s*(4[4-9]|[5-9]\d)px/, `${selector} is smaller than a thumb`);
    }
    assert.match(css.match(/\.btn \{[\s\S]*?\}/)[0], /min-height:\s*4[4-9]px|min-height:\s*[5-9]\dpx/);
  });

  test("long values wrap instead of forcing a horizontal scroll", () => {
    assert.match(css, /overflow-wrap:\s*break-word/);
    assert.match(css, /word-break:\s*break-word/);
  });

  test("focus is always visible and never removed", () => {
    assert.match(css, /:focus-visible \{[\s\S]*?outline:\s*3px solid/);
    assert.ok(!/outline:\s*(none|0)\s*;/.test(css), "focus outline is removed somewhere");
  });

  test("reduced motion and high contrast are respected", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(prefers-contrast: more\)/);
  });

  test("no state is signalled by colour alone", () => {
    // Each state class also carries a text marker via ::before or a label.
    for (const marker of ["✓", "▲", "●"]) {
      assert.ok(css.includes(marker), `no non-colour marker "${marker}" anywhere in the stylesheet`);
    }
  });
});

describe("M8A the content security policy is honoured", () => {
  test("no page emits an inline style attribute or a <style> block", () => {
    for (const html of [...renderEveryStep(), reviewHtml(), historyHtml()]) {
      assert.ok(!/\sstyle="/.test(html), "an inline style attribute would be blocked by the CSP");
      assert.ok(!/<style[\s>]/.test(html), "an inline <style> block would be blocked by the CSP");
    }
  });

  test("no page emits an inline event handler or an inline script body", () => {
    for (const html of [...renderEveryStep(), reviewHtml(), historyHtml()]) {
      assert.ok(!/\son(click|change|submit|input|load)=/i.test(html), "an inline event handler would be blocked by the CSP");
      const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
      for (const [, attrs, bodyText] of scripts) {
        assert.match(attrs, /src="/, "a script with no src is an inline script");
        assert.equal(bodyText.trim(), "", "a script tag with a body is an inline script");
      }
    }
  });

  test("the page's own CSP forbids exactly what the markup avoids", () => {
    assert.match(PAGE_SECURITY_HEADERS["Content-Security-Policy"], /style-src 'self'/);
    assert.match(PAGE_SECURITY_HEADERS["Content-Security-Policy"], /script-src 'self'/);
    assert.ok(!/unsafe-inline/.test(PAGE_SECURITY_HEADERS["Content-Security-Policy"]));
    assert.match(PAGE_SECURITY_HEADERS["Content-Security-Policy"], /frame-ancestors 'none'/);
  });
});

function reviewHtml(overrides = {}) {
  const profile = fullProfile();
  return views.renderSetupReview({
    summary: draftService.buildReviewSummary(profile),
    version: 3,
    updatedAt: "2026-08-04T00:00:00.000Z",
    submitted: false,
    status: "draft",
    confirmations: {},
    outstandingConfirmations: S.CONFIRMATION_KEYS.slice(),
    outstandingSteps: steps.STEP_IDS.slice(),
    ...overrides,
  });
}

function historyHtml() {
  return views.renderSetupHistory({
    versions: [
      { version: 3, status: "draft", createdAt: "2026-08-04T00:00:00.000Z", approvedAt: null, supersededByVersion: null, rejectionReason: null, provisioningReady: false, restorable: false, updatedAt: "2026-08-04T00:00:00.000Z" },
      { version: 2, status: "approved", createdAt: "2026-08-01T00:00:00.000Z", approvedAt: "2026-08-01T00:00:00.000Z", supersededByVersion: null, rejectionReason: null, provisioningReady: true, restorable: true, updatedAt: "2026-08-01T00:00:00.000Z" },
    ],
    progress: steps.assessProgress(fullProfile()),
  });
}

describe("M8A example phone numbers can never ring a real handset", () => {
  // The ACMA range reserved for drama and training. Valid Australian mobiles by
  // format, so they exercise the real validator, but permanently unallocated.
  const FICTITIOUS_MIN = 491570006;
  const FICTITIOUS_MAX = 491570156;

  const FILES = [
    "src/services/locksmith-onboarding-steps.js",
    "src/views/locksmith-setup-page.js",
    "scripts/locksmith-setup-walkthrough.js",
    "test/locksmith-setup-journey.test.js",
    "test/locksmith-setup-ui.test.js",
  ];

  test("every Australian mobile in the M8A files is inside the fictitious range", () => {
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      const numbers = [...source.matchAll(/0(4\d{2})\s?(\d{3})\s?(\d{3})/g)].map((m) => Number(`${m[1]}${m[2]}${m[3]}`));
      for (const n of numbers) {
        assert.ok(
          n >= FICTITIOUS_MIN && n <= FICTITIOUS_MAX,
          `${file} contains 0${n}, which is outside the ACMA fictitious range and could be a real handset`
        );
      }
    }
  });

  test("the placeholders a locksmith sees are fictitious too", () => {
    // A placeholder is never dialled by the system, but it is the number a
    // hurried owner is most likely to copy.
    for (const step of steps.STEPS) {
      for (const field of step.fields) {
        if (field.kind !== "tel" || !field.placeholder) continue;
        const digits = field.placeholder.replace(/\D/g, "");
        if (!/^04/.test(digits)) continue;
        const n = Number(digits.slice(1));
        assert.ok(n >= FICTITIOUS_MIN && n <= FICTITIOUS_MAX, `${step.id}.${field.name} suggests ${field.placeholder}, which is not a fictitious number`);
      }
    }
  });
});

describe("M8A the words on the page", () => {
  const JARGON = [
    "retell", "twilio", "supabase", "webhook", "e.164", "e164", "llm", "prompt",
    "agent_id", "agent id", "provider_resource", "provisioning plan", "jsonb",
    "schema version", "idempotency", "dynamic variable", "sourcechannel", "clientid",
    "profile_version", "needs_review", "servicesaccepted", "outsideareaaction",
  ];

  test("no provider name, internal id or implementation term reaches the client", () => {
    for (const html of [...renderEveryStep(), reviewHtml(), historyHtml()]) {
      const visible = stripMarkup(html).toLowerCase();
      for (const term of JARGON) {
        assert.ok(!visible.includes(term), `"${term}" is visible to the locksmith`);
      }
    }
  });

  test("no raw enum value is printed as an answer", () => {
    const html = reviewHtml();
    const visible = stripMarkup(html);
    for (const value of [...S.OUTSIDE_AREA_ACTIONS, ...S.TONES, ...S.NOTIFICATION_TIMINGS, ...S.RETENTION_PREFERENCES, ...S.UNANSWERED_TRANSFER_ACTIONS]) {
      assert.ok(!visible.includes(value), `the raw enum "${value}" is shown instead of a sentence`);
    }
  });

  test("the review reads back real answers, not placeholders", () => {
    const visible = stripMarkup(reviewHtml());
    assert.ok(visible.includes("Peninsula Lock & Key"), "the business name was not read back");
    assert.ok(visible.includes("Frankston"), "the service area was not read back");
    assert.ok(visible.includes("Take their details and tell them you'll confirm"), "the unknown-suburb rule was not read back in plain words");
  });

  test("the safety floor is stated in full and described as unchangeable", () => {
    const visible = stripMarkup(reviewHtml());
    assert.ok(/cannot be switched off/i.test(visible));
    for (const label of Object.values(S.FORBIDDEN_PROMISE_LABELS)) {
      assert.ok(visible.includes(label), `the safety floor omits "${label}"`);
    }
  });

  test("approval is never described as going live", () => {
    const html = reviewHtml({ submitted: true, outstandingConfirmations: [], outstandingSteps: [] });
    const visible = stripMarkup(html);
    assert.match(visible, /does not switch anything on by itself/i);
    assert.match(visible, /phone stays exactly as it is/i);
  });

  test("the transfer number is explained as separate from the public number", () => {
    const html = renderEveryStep()[5]; // contact
    const visible = stripMarkup(html);
    assert.match(visible, /separate from your public business number/i);
  });

  test("text-message delivery is described truthfully as not yet switched on", () => {
    const visible = stripMarkup(renderEveryStep()[5]);
    assert.match(visible, /not switched on yet|pending carrier approval/i);
  });

  test("the callback estimate is never described as an arrival time or a promise", () => {
    const visible = stripMarkup(renderEveryStep()[3]); // hours
    assert.match(visible, /not when anyone arrives/i);
    assert.match(visible, /never state it as a promise/i);
  });
});

function stripMarkup(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

describe("M8A review rendering", () => {
  test("an unsubmitted review offers 'send for approval' and no approve button", () => {
    const html = reviewHtml();
    assert.match(html, /id="submit-setup"/);
    assert.ok(!/id="approve-setup"/.test(html), "approval was offered before the setup was submitted");
    assert.ok(!/confirm-button/.test(html), "sections were tickable before submission");
  });

  test("a submitted review offers a tick per step and a disabled approve button", () => {
    const html = reviewHtml({ submitted: true });
    const ticks = html.match(/class="btn btn--small btn--primary confirm-button"/g) || [];
    assert.equal(ticks.length, steps.STEPS.length, "one tick per step");
    assert.match(html, /id="approve-setup"[^>]*disabled/);
  });

  test("approve unlocks only when every section is ticked AND nothing blocks", () => {
    const ready = reviewHtml({ submitted: true, outstandingConfirmations: [], outstandingSteps: [] });
    assert.match(ready, /id="approve-setup"\s*>/, "approve stayed disabled with everything clear");

    const unticked = reviewHtml({ submitted: true, outstandingConfirmations: ["transfer"], outstandingSteps: ["contact"] });
    assert.match(unticked, /id="approve-setup"[^>]*disabled/, "approve unlocked with a section unticked");
  });

  test("an approved review is read-only: no change links, no ticks, no approve", () => {
    const html = reviewHtml({ submitted: true, status: "approved", outstandingConfirmations: [], outstandingSteps: [] });
    assert.ok(!/id="approve-setup"/.test(html));
    assert.ok(!/confirm-button/.test(html));
    assert.ok(!/>Change</.test(html), "an approved version offered an in-place edit");
  });

  test("blockers and warnings are rendered in separate, differently-marked lists", () => {
    const profile = draftService.seedProfile(CLIENT);
    const html = views.renderSetupReview({
      summary: draftService.buildReviewSummary(profile),
      version: 1, updatedAt: "x", submitted: false, status: "draft",
      confirmations: {}, outstandingConfirmations: S.CONFIRMATION_KEYS.slice(), outstandingSteps: steps.STEP_IDS.slice(),
    });
    assert.match(html, /class="issues issues--blocker"/);
    assert.match(html, /Needs fixing before we can build it/);
    assert.match(html, /id="submit-setup"[^>]*disabled/, "an unfinished setup could be submitted");
  });

  test("each blocker links to the step that fixes it", () => {
    const profile = draftService.seedProfile(CLIENT);
    const summary = draftService.buildReviewSummary(profile);
    const html = views.renderSetupReview({ summary, version: 1, updatedAt: "x", submitted: false, status: "draft", confirmations: {}, outstandingConfirmations: [], outstandingSteps: [] });
    const linked = summary.blockers.filter((b) => b.stepId);
    assert.ok(linked.length > 0, "no blocker knows which step fixes it");
    for (const blocker of linked) {
      assert.ok(html.includes(`/client/locksmith-setup/step/${blocker.stepId}`), `"${blocker.code}" has no link to ${blocker.stepId}`);
    }
  });
});

describe("M8A test centre and activation", () => {
  test("with nothing approved, the test page says so instead of implying a pass", async () => {
    const res = fakeRes();
    await handlers().setupTest(req(), res);
    const visible = stripMarkup(res.body);
    assert.match(visible, /nothing to test yet/i);
    assert.match(visible, /No test calls have been recorded/i);
    assert.ok(!/passed/i.test(visible.replace(/It passes if/g, "")), "an empty test run implied a pass");
  });

  test("with an approved profile, a real checklist is generated", async () => {
    const approved = { client_id: CLIENT, version: 2, status: "approved", profile: fullProfile(), updated_at: "x" };
    const res = fakeRes();
    await handlers({ approved }).setupTest(req(), res);
    const visible = stripMarkup(res.body);
    assert.match(visible, /Try this:/);
    assert.match(visible, /safety check/i);
    assert.match(visible, /You should never hear/i);
  });

  test("with everything clear, the go-live page does not still say 'not ready yet'", async () => {
    // The earlier version listed the phone switch-over as a blocker, which made
    // the blocker list permanently non-empty and this branch dead.
    const approved = { client_id: CLIENT, version: 2, status: "approved", profile: fullProfile(), updated_at: "x" };
    const res = fakeRes();
    await handlers({ approved }).setupActivate(req(), res);
    const visible = stripMarkup(res.body);
    assert.ok(!/Not ready yet/.test(visible), "a client who has done everything is told they are not ready");
    assert.match(visible, /Everything we need from you is done/i);
    assert.match(visible, /Nothing left for you to do/i);
    // Still gated: the control never becomes an activation.
    assert.match(res.body, /id="request-activation"[^>]*disabled/);
  });

  test("with work outstanding, the go-live page says so and lists it", async () => {
    const res = fakeRes();
    await handlers({
      service: {
        async loadDraft() {
          const p = draftService.seedProfile(CLIENT);
          return { ok: true, outcome: "ok", version: 1, status: "draft", profile: p, updatedAt: "x", progress: steps.assessProgress(p) };
        },
      },
    }).setupActivate(req(), res);
    const visible = stripMarkup(res.body);
    assert.match(visible, /Not ready yet/);
    assert.match(visible, /Finish your answers/);
    assert.match(visible, /Approve your settings/);
  });

  test("a submitted setup redirects to review instead of forking a blank draft", async () => {
    const profile = fullProfile();
    const h = handlers({
      service: {
        async loadDraft() { return { ok: false, outcome: "no_draft", message: "none" }; },
        async startDraft() {
          return { ok: true, outcome: "ok", created: false, submitted: true, version: 3, status: "needs_review", profile, updatedAt: "x", progress: steps.assessProgress(profile) };
        },
      },
    });
    for (const [name, fn, extra] of [["home", h.setupHome, {}], ["step", h.setupStep, { params: { stepId: "identity" } }]]) {
      const res = fakeRes();
      await fn(req(extra), res);
      assert.equal(res.statusCode, 303, `${name} did not redirect`);
      assert.equal(res.headers.Location, "/client/locksmith-setup/review");
      assert.ok(!/setup-form/.test(res.body || ""), `${name} rendered an editable form over a submitted version`);
    }
  });

  test("reopening is offered on a submitted review and is a POST, not a link", () => {
    const html = reviewHtml({ submitted: true });
    assert.match(html, /id="reopen-setup"/);
    assert.match(html, /<button type="button"[^>]*id="reopen-setup"/);
  });

  test("activation is a page with gates, and there is no route that switches a phone over", async () => {
    const res = fakeRes();
    await handlers().setupActivate(req(), res);
    const visible = stripMarkup(res.body);
    assert.match(visible, /Nothing here happens automatically/i);
    assert.match(res.body, /id="request-activation"[^>]*disabled/);

    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "locksmith-onboarding.js"), "utf8");
    assert.ok(!/locksmith-setup\/activate['"]\s*,\s*requireClientAuth\s*,\s*setup\.\w*[Aa]ctivateNow/.test(routes));
    assert.ok(!/router\.post\([^)]*locksmith-setup\/activate/.test(routes), "activation is POSTable — it must not be");
  });

  test("the go-live page always names the phone switch-over as an outstanding step", async () => {
    const approved = { client_id: CLIENT, version: 2, status: "approved", profile: fullProfile(), updated_at: "x" };
    const res = fakeRes();
    await handlers({ approved }).setupActivate(req(), res);
    const visible = stripMarkup(res.body);
    assert.match(visible, /Your phone number/);
    assert.match(visible, /switched over with us on a short call/i);
  });
});
