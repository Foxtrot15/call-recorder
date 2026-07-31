// AIDA Locksmith Receptionist M1 — enquiry validation, submission boundary and
// route-handler tests.
//
// The handlers live in routes/locksmith-handlers.js precisely so they can be
// driven here with fake req/res objects — no express, no supertest, no
// node_modules (house rule). routes/locksmith.js is thin wiring over exactly
// these handlers.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  FIELDS,
  validateEnquiry,
  isValidEmail,
  isValidAuPhone,
  isValidWebsite,
  createEnquirySubmitter,
  SUBMISSION_RESULTS,
  SUBMISSION_MESSAGES,
  MAX_NOTES,
} = require("../src/services/locksmith-enquiry");

const {
  createLocksmithHandlers,
  PAGE_SECURITY_HEADERS,
  ENQUIRY_LIMIT,
} = require("../src/routes/locksmith-handlers");

const { createRateLimiter } = require("../src/services/rate-limit");

// A submission that passes every rule — each test starts from this and breaks
// exactly one thing, so a failure names its own cause.
const VALID = Object.freeze({
  businessName: "Example Locksmiths",
  contactName: "Alex Example",
  phone: "0400 000 000",
  email: "alex@example.com.au",
  website: "example.com.au",
  serviceArea: "Inner north and eastern suburbs",
  services: ["residential", "automotive"],
  afterHours: "yes",
  missedCallHandling: "voicemail",
  preferredContact: "phone",
  notes: "Mostly lockouts after 8pm.",
  consent: true,
});

// ── Fake req/res ────────────────────────────────────────────────────

function fakeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    contentType: null,
    set(keyOrObject, value) {
      if (typeof keyOrObject === "object") Object.assign(this.headers, keyOrObject);
      else this.headers[keyOrObject] = value;
      return this;
    },
    type(t) { this.contentType = t; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

function fakeReq(body, ip = "203.0.113.9") {
  return { body, ip, headers: {}, socket: { remoteAddress: ip } };
}

describe("field contract", () => {
  it("defines every field the brief specifies, with consent required", () => {
    const names = FIELDS.map((f) => f.name);
    assert.deepStrictEqual(names, [
      "businessName", "contactName", "phone", "email", "website", "serviceArea",
      "services", "afterHours", "missedCallHandling", "preferredContact", "notes", "consent",
    ]);
    const consent = FIELDS.find((f) => f.name === "consent");
    assert.strictEqual(consent.type, "consent");
    assert.strictEqual(consent.required, true);
    assert.match(consent.label, /agree to be contacted/i);

    // Website and notes are the only optional fields.
    const optional = FIELDS.filter((f) => !f.required).map((f) => f.name);
    assert.deepStrictEqual(optional, ["website", "notes"]);
  });
});

describe("validation — the happy path", () => {
  it("accepts a complete submission and returns normalised values", () => {
    const result = validateEnquiry({ ...VALID, businessName: "  Example   Locksmiths  " });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.errorList, []);
    assert.strictEqual(result.values.businessName, "Example Locksmiths", "whitespace collapsed and trimmed");
    assert.deepStrictEqual(result.values.services, ["residential", "automotive"]);
    assert.strictEqual(result.values.consent, true);
  });

  it("accepts the browser's form encoding (checkbox 'on', single-value group)", () => {
    const result = validateEnquiry({ ...VALID, services: "commercial", consent: "on" });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.values.services, ["commercial"]);
    assert.strictEqual(result.values.consent, true);
  });

  it("accepts a submission with both optional fields omitted", () => {
    const { website, notes, ...withoutOptional } = VALID;
    const result = validateEnquiry(withoutOptional);
    assert.strictEqual(result.ok, true, JSON.stringify(result.errorList));
  });
});

describe("validation — required fields are enforced", () => {
  it("an empty submission reports every required field, in form order", () => {
    const result = validateEnquiry({});
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.errorList.map((e) => e.field),
      ["businessName", "contactName", "phone", "email", "serviceArea", "services", "afterHours", "missedCallHandling", "preferredContact", "consent"]
    );
    for (const e of result.errorList) {
      assert.ok(e.message && e.label, "each error carries a label and a message for the summary");
      assert.ok(e.label.length <= 40, `summary label too long to scan: "${e.label}"`);
    }
    // The consent checkbox's own label is a full sentence; the summary uses
    // the short form so the error list stays readable.
    assert.strictEqual(result.errorList.at(-1).label, "Consent");
  });

  it("whitespace is not a value", () => {
    for (const field of ["businessName", "contactName", "serviceArea"]) {
      const result = validateEnquiry({ ...VALID, [field]: "   \t  " });
      assert.strictEqual(result.ok, false, `${field} must reject whitespace`);
      assert.match(result.errors[field], /required/i);
    }
  });

  it("a missing body object is handled, not thrown on", () => {
    assert.strictEqual(validateEnquiry().ok, false);
    assert.strictEqual(validateEnquiry(null).ok, false);
  });

  it("over-long values are rejected rather than silently truncated", () => {
    const long = validateEnquiry({ ...VALID, businessName: "x".repeat(121) });
    assert.strictEqual(long.ok, false);
    assert.match(long.errors.businessName, /120 characters or fewer/);

    const longNotes = validateEnquiry({ ...VALID, notes: "y".repeat(MAX_NOTES + 1) });
    assert.strictEqual(longNotes.ok, false);
    assert.match(longNotes.errors.notes, /2000 characters or fewer/);
  });
});

describe("validation — email", () => {
  it("rejects invalid addresses", () => {
    for (const bad of ["alex", "alex@", "@example.com", "alex@example", "alex example@x.com", "alex@@example.com", "alex@.com"]) {
      assert.strictEqual(isValidEmail(bad), false, `"${bad}" must be rejected`);
      const result = validateEnquiry({ ...VALID, email: bad });
      assert.strictEqual(result.ok, false, `"${bad}" must fail validation`);
      assert.match(result.errors.email, /valid email address/i);
    }
  });

  it("accepts ordinary Australian business addresses", () => {
    for (const good of ["alex@example.com.au", "a.b+pilot@sub.example.org", "office@example.net"]) {
      assert.strictEqual(isValidEmail(good), true, `"${good}" must be accepted`);
      assert.strictEqual(validateEnquiry({ ...VALID, email: good }).ok, true);
    }
  });
});

describe("validation — Australian phone numbers", () => {
  it("accepts mobiles, landlines and business numbers, with any separators", () => {
    for (const good of [
      "0400 000 000", "0400000000", "04 0000 0000", "(03) 9000 0000", "03-9000-0000",
      "+61 400 000 000", "+61390000000", "61400000000", "1300 000 000", "1800 000 000", "13 00 00",
    ]) {
      assert.strictEqual(isValidAuPhone(good), true, `"${good}" must be accepted`);
    }
  });

  it("rejects values that are not reachable Australian numbers", () => {
    for (const bad of [
      "", "12345", "0000000000", "0100000000", "abc", "+1 202 555 0100",
      "04000000000", "040000000", "+61 400 000", "not a number", "0400 000 00a",
    ]) {
      assert.strictEqual(isValidAuPhone(bad), false, `"${bad}" must be rejected`);
    }
  });

  it("an invalid phone fails the whole submission with a usable message", () => {
    const result = validateEnquiry({ ...VALID, phone: "12345" });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.phone, /valid Australian phone number/i);
    assert.match(result.errors.phone, /04XX XXX XXX/, "the message shows the expected shape");
  });
});

describe("validation — optional website", () => {
  it("blank is fine; a bare domain is accepted", () => {
    assert.strictEqual(isValidWebsite(""), true);
    assert.strictEqual(isValidWebsite("example.com.au"), true);
    assert.strictEqual(isValidWebsite("https://example.com.au/locksmith"), true);
  });

  it("refuses script-bearing and non-web schemes outright", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "not a website", "http://"]) {
      assert.strictEqual(isValidWebsite(bad), false, `"${bad}" must be rejected`);
    }
    const result = validateEnquiry({ ...VALID, website: "javascript:alert(1)" });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.website, /valid website address/i);
  });
});

describe("validation — consent is mandatory", () => {
  it("an unticked or absent consent box fails the submission", () => {
    for (const value of [undefined, null, "", false, "false", "off", 0, "no"]) {
      const result = validateEnquiry({ ...VALID, consent: value });
      assert.strictEqual(result.ok, false, `consent=${JSON.stringify(value)} must fail`);
      assert.match(result.errors.consent, /tick this box/i);
    }
  });

  it("only an affirmative value counts as consent", () => {
    for (const value of [true, "true", "on", "1", 1, "yes"]) {
      assert.strictEqual(validateEnquiry({ ...VALID, consent: value }).ok, true, `consent=${JSON.stringify(value)}`);
    }
  });

  it("the value the consent checkbox actually renders is one the validator accepts", () => {
    // Regression: a plain (JavaScript-free) form POST sends the checkbox's
    // value attribute verbatim. If the rendered value and isChecked() ever
    // drift apart, consent silently fails for those visitors.
    const { renderLocksmithPage } = require("../src/views/locksmith-page");
    const { getLocksmithConfig } = require("../src/config/locksmith");
    const html = renderLocksmithPage({
      config: getLocksmithConfig({}),
      demo: require("../src/services/locksmith-demo"),
      fields: FIELDS,
    });
    const rendered = html.match(/id="f-consent" name="consent" value="([^"]+)"/);
    assert.ok(rendered, "the consent checkbox must render a value attribute");
    assert.strictEqual(validateEnquiry({ ...VALID, consent: rendered[1] }).ok, true,
      `rendered consent value "${rendered[1]}" is rejected by validateEnquiry`);
  });
});

describe("validation — choice fields cannot be forged", () => {
  it("values outside the published option list are rejected, not stored", () => {
    const result = validateEnquiry({ ...VALID, afterHours: "<script>", missedCallHandling: "'; drop table", preferredContact: "carrier-pigeon" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.values.afterHours, "", "an unknown option never reaches the values object");
    assert.strictEqual(result.values.missedCallHandling, "");
    assert.strictEqual(result.values.preferredContact, "");
  });

  it("unknown services are refused rather than silently dropped", () => {
    const result = validateEnquiry({ ...VALID, services: ["residential", "moon-landing"] });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.services, /choose from the listed services/i);
    assert.deepStrictEqual(result.values.services, ["residential"], "only known values survive");
  });

  it("no services selected is an error", () => {
    const result = validateEnquiry({ ...VALID, services: [] });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.services, /at least one service/i);
  });
});

describe("validation — hostile input is stored verbatim, never executed", () => {
  it("markup in a text field is kept as text (escaping happens at output)", () => {
    const payload = `<script>alert("xss")</script>`;
    const result = validateEnquiry({ ...VALID, businessName: payload });
    assert.strictEqual(result.ok, true, "markup is not itself a validation failure");
    assert.strictEqual(result.values.businessName, payload, "input is not mangled on the way in");
    // The page never renders submitted input — proven in locksmith-page.test.js
    // ("the page never echoes submitted form input").
  });

  it("legitimate punctuation survives validation", () => {
    const result = validateEnquiry({ ...VALID, businessName: "Smith & Sons Locksmiths (VIC)" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.values.businessName, "Smith & Sons Locksmiths (VIC)");
  });
});

describe("submission boundary — M1 ships no persistence", () => {
  it("with the flag off, nothing is stored and the caller is told so", async () => {
    let called = false;
    const submit = createEnquirySubmitter({ isEnabled: () => false, sink: () => { called = true; } });
    const result = await submit(VALID);
    assert.deepStrictEqual(result, SUBMISSION_RESULTS.disabled);
    assert.strictEqual(result.status, 503);
    assert.strictEqual(called, false, "the sink must not run while the flag is off");
  });

  it("with the flag on but no sink wired, it refuses honestly rather than faking success", async () => {
    const submit = createEnquirySubmitter({ isEnabled: () => true });
    const result = await submit(VALID);
    assert.deepStrictEqual(result, SUBMISSION_RESULTS.unavailable);
    assert.strictEqual(result.ok, false);
  });

  it("the default submitter (real config, empty env) is disabled — the shipped state", async () => {
    const previous = process.env.LOCKSMITH_ENQUIRY_ENABLED;
    delete process.env.LOCKSMITH_ENQUIRY_ENABLED;
    try {
      const result = await createEnquirySubmitter({})(VALID);
      assert.strictEqual(result.code, "disabled");
    } finally {
      if (previous === undefined) delete process.env.LOCKSMITH_ENQUIRY_ENABLED;
      else process.env.LOCKSMITH_ENQUIRY_ENABLED = previous;
    }
  });

  it("a wired sink receives the values and the outcome is success", async () => {
    const seen = [];
    const submit = createEnquirySubmitter({
      isEnabled: () => true,
      sink: async (values, meta) => { seen.push({ values, meta }); },
      logger: { log() {}, error() {} },
    });
    const result = await submit(VALID, { receivedVia: "web" });
    assert.deepStrictEqual(result, SUBMISSION_RESULTS.received);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].values.businessName, "Example Locksmiths");
    assert.strictEqual(seen[0].meta.receivedVia, "web");
  });

  it("a failing sink surfaces an error state — never a false success", async () => {
    const errors = [];
    const submit = createEnquirySubmitter({
      isEnabled: () => true,
      sink: async () => { throw new Error("sink exploded"); },
      logger: { log() {}, error: (...a) => errors.push(a) },
    });
    const result = await submit(VALID);
    assert.deepStrictEqual(result, SUBMISSION_RESULTS.failed);
    assert.strictEqual(errors.length, 1);
  });

  it("the success log line carries no personal information", async () => {
    const lines = [];
    const submit = createEnquirySubmitter({
      isEnabled: () => true,
      sink: async () => {},
      logger: { log: (line) => lines.push(line), error() {} },
    });
    await submit(VALID);
    assert.strictEqual(lines.length, 1);
    for (const pii of ["Example Locksmiths", "Alex Example", "0400", "alex@example.com.au", "Inner north"]) {
      assert.ok(!lines[0].includes(pii), `log leaked "${pii}": ${lines[0]}`);
    }
    assert.match(lines[0], /^locksmith\.enquiry\.received /, "house-style structured single-line log");
  });
});

describe("GET handler — the public route responds successfully", () => {
  it("returns 200 with the rendered HTML page", () => {
    const { page } = createLocksmithHandlers();
    const res = fakeRes();
    page(fakeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.contentType, "html");
    assert.ok(res.body.startsWith("<!DOCTYPE html>"));
    assert.ok(res.body.includes("Never lose another after-hours locksmith enquiry"));
  });

  it("sets the page's own security headers without touching anything else", () => {
    const { page } = createLocksmithHandlers();
    const res = fakeRes();
    page(fakeReq(), res);
    assert.strictEqual(res.headers["X-Content-Type-Options"], "nosniff");
    assert.match(res.headers["Content-Security-Policy"], /default-src 'self'/);
    assert.match(res.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(res.headers["Content-Security-Policy"]), "no unsafe CSP escape hatches");
    assert.strictEqual(res.headers["Cache-Control"], "public, max-age=60");
    assert.deepStrictEqual(Object.keys(PAGE_SECURITY_HEADERS).sort(), ["Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options"]);
  });

  it("renders whatever config it is given — no baked-in product values", () => {
    const { page } = createLocksmithHandlers({
      getConfig: () => ({ ...require("../src/config/locksmith").getLocksmithConfig({ LOCKSMITH_MONTHLY_PRICE: "777" }) }),
    });
    const res = fakeRes();
    page(fakeReq(), res);
    assert.ok(res.body.includes("A$777 per month"));
  });
});

describe("POST handler — states the visitor can actually reach", () => {
  function handlersWith(overrides = {}) {
    return createLocksmithHandlers({
      logger: { log() {}, error() {} },
      limiter: createRateLimiter({ limit: 50, windowMs: 60000 }),
      ...overrides,
    });
  }

  it("invalid submission → 400 with per-field errors for the summary", async () => {
    const res = fakeRes();
    await handlersWith().enquiry(fakeReq({ ...VALID, email: "nope", consent: false }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.code, "invalid");
    assert.strictEqual(res.body.message, SUBMISSION_MESSAGES.invalid);
    const fields = res.body.errors.map((e) => e.field);
    assert.deepStrictEqual(fields, ["email", "consent"]);
  });

  it("success state → 200 ok:true with the confirmation message", async () => {
    const res = fakeRes();
    await handlersWith({ submit: async () => SUBMISSION_RESULTS.received }).enquiry(fakeReq(VALID), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.code, "received");
    assert.match(res.body.message, /received/i);
  });

  it("server failure state → 502 with a safe message and no internal detail", async () => {
    const res = fakeRes();
    await handlersWith({ submit: async () => SUBMISSION_RESULTS.failed }).enquiry(fakeReq(VALID), res);
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.message, SUBMISSION_MESSAGES.error);
  });

  it("a submitter that throws is contained — 502, and the internal message never leaks", async () => {
    const res = fakeRes();
    await handlersWith({
      submit: async () => { throw new Error("SUPABASE_SERVICE_KEY is invalid"); },
    }).enquiry(fakeReq(VALID), res);
    assert.strictEqual(res.statusCode, 502);
    assert.ok(!JSON.stringify(res.body).includes("SUPABASE"), "internal error text must not reach the browser");
  });

  it("disabled state (the shipped M1 default) → 503 pointing at the footer contact", async () => {
    const res = fakeRes();
    await handlersWith({ submit: async () => SUBMISSION_RESULTS.disabled }).enquiry(fakeReq(VALID), res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, "disabled");
    assert.match(res.body.message, /contact details in the footer/i);
  });

  it("validation runs server-side even when the client skipped it", async () => {
    const res = fakeRes();
    let sinkCalls = 0;
    await handlersWith({ submit: async () => { sinkCalls += 1; return SUBMISSION_RESULTS.received; } })
      .enquiry(fakeReq({ consent: true }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(sinkCalls, 0, "an invalid submission never reaches the submitter");
  });

  it("submissions are rate limited per IP", async () => {
    const handlers = createLocksmithHandlers({
      logger: { log() {}, error() {} },
      submit: async () => SUBMISSION_RESULTS.received,
    });
    let last;
    for (let i = 0; i < ENQUIRY_LIMIT + 1; i += 1) {
      last = fakeRes();
      await handlers.enquiry(fakeReq(VALID, "198.51.100.7"), last);
    }
    assert.strictEqual(last.statusCode, 429);
    assert.strictEqual(last.body.code, "rate_limited");

    // A different visitor is unaffected.
    const other = fakeRes();
    await handlers.enquiry(fakeReq(VALID, "198.51.100.8"), other);
    assert.strictEqual(other.statusCode, 200);
  });

  it("expired rate-limit windows are swept, so a public endpoint can't grow the map forever", async () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: () => now });
    const handlers = createLocksmithHandlers({
      logger: { log() {}, error() {} },
      limiter,
      submit: async () => SUBMISSION_RESULTS.received,
    });
    // 150 distinct visitors, each one window apart: without pruning every key
    // would still be resident.
    for (let i = 0; i < 150; i += 1) {
      now += 2000;
      await handlers.enquiry(fakeReq(VALID, `198.51.100.${i}`), fakeRes());
    }
    assert.ok(limiter._size() < 150, `expired windows should be pruned, map holds ${limiter._size()}`);
  });
});

describe("isolation — existing routes and behaviour are untouched", () => {
  const SERVER = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

  it("every pre-existing mount is still registered, unchanged", () => {
    for (const mount of [
      'app.use("/login", require("./routes/login"));',
      'app.use("/client-auth", require("./routes/client-auth"));',
      'app.use("/inbound",           twilioWebhook, require("./routes/inbound"));',
      'app.use("/outbound",          twilioWebhook, require("./routes/outbound"));',
      'app.use("/recording",         twilioWebhook, require("./routes/recording"));',
      'app.use("/calls",             requireLogin, require("./routes/calls"));',
      'app.use("/settings",          requireLogin, require("./routes/settings"));',
      'app.use("/client-dashboard",  require("./routes/client-dashboard"));',
      'app.get("/health", (req, res) => res.json({ status: "ok" }));',
    ]) {
      assert.ok(SERVER.includes(mount.split(");")[0]), `server.js lost: ${mount}`);
    }
  });

  it("the locksmith router is mounted public — no auth middleware attached", () => {
    const line = SERVER.split("\n").find((l) => l.includes('require("./routes/locksmith")'));
    assert.ok(line, "the locksmith router must be mounted");
    assert.ok(!line.includes("requireLogin"), "the public page must not be behind the operator login");
    assert.ok(!line.includes("requireClientAuth"));
    assert.ok(!line.includes("twilioWebhook"));
  });

  it("the gated dashboard route still precedes express.static", () => {
    assert.ok(
      SERVER.indexOf('app.get(["/", "/index.html"], requireLogin') < SERVER.indexOf("app.use(express.static("),
      "the login gate on / must still win over static's index.html"
    );
  });

  it("the feature is not linked from any existing page's navigation", () => {
    for (const file of ["index.html", "login.html", "onboarding.html", "client-dashboard.html"]) {
      const html = fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
      assert.ok(!html.includes("locksmith"), `${file} must not advertise the unfinished pilot`);
    }
  });

  it("no locksmith module reaches for a database, Twilio or any external service", () => {
    const modules = [
      "../src/config/locksmith.js",
      "../src/services/locksmith-demo.js",
      "../src/services/locksmith-enquiry.js",
      "../src/views/locksmith-page.js",
      "../src/views/escape.js",
      "../src/routes/locksmith.js",
      "../src/routes/locksmith-handlers.js",
    ];
    for (const rel of modules) {
      const source = fs.readFileSync(path.join(__dirname, rel), "utf8");
      const requires = (source.match(/require\("([^"]+)"\)/g) || []).join(" ");
      for (const banned of ["supabase", "twilio", "axios", "googleapis", "retell", "gohighlevel", "stripe"]) {
        assert.ok(!requires.includes(banned), `${rel} must not require ${banned}`);
      }
      assert.ok(!/fetch\(|https?\.request|\.from\("/.test(source), `${rel} must make no network or DB call`);
    }
  });
});
