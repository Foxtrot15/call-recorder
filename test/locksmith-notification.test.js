// AIDA — M7K: enquiry → locksmith notification.
//
// THE RULE: "The locksmith has been notified" is claimable ONLY after a
// provider accepted a message. Four facts stay separate forever —
// saved · attempted · delivered · acknowledged.
//
// NO TEST HERE CONTACTS TWILIO, RETELL OR A DATABASE.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const notify = require("../src/services/locksmith-notification");
const sms = require("../src/services/locksmith-sms-delivery");
const cfgN = require("../src/config/locksmith-notifications");
const enquiry = require("../src/services/locksmith-caller-enquiry");
const rc = require("../src/services/locksmith-receptionist-compiler");
const cfg = require("../src/config/retell");
const { buildSandboxProfile, SANDBOX_CLIENT_ID } = require("../src/services/locksmith-sandbox-profile");

const SILENT = { log() {}, error() {} };

const ENQUIRY = Object.freeze({
  id: "enq_1",
  caller_name: "Fixture Caller",
  callback_number: "+61491570111",
  suburb: "Springvale",
  problem_description: "Locked out.",
  urgency: "urgent",
  property_secure: false,
});

/** A store fake that models the pending -> sending claim exactly. */
function fakeStore(initialState = "pending") {
  const rows = { enq_1: { state: initialState, attempts: 0, provider: null, reference: null, code: null } };
  return {
    rows,
    claim: async ({ enquiryId }) => {
      const row = rows[enquiryId];
      if (!row) return { ok: false, claimed: false, state: null };
      if (row.state !== "pending") return { ok: true, claimed: false, state: row.state };
      row.state = "sending";
      row.attempts = 1;
      return { ok: true, claimed: true, state: "sending" };
    },
    markSent: async ({ enquiryId, provider, reference }) => {
      rows[enquiryId].state = "sent"; rows[enquiryId].provider = provider; rows[enquiryId].reference = reference;
    },
    markFailed: async ({ enquiryId, provider, code }) => {
      rows[enquiryId].state = "failed"; rows[enquiryId].provider = provider; rows[enquiryId].code = code;
    },
    markNotRequired: async ({ enquiryId }) => { rows[enquiryId].state = "not_required"; },
  };
}

const CONFIG = Object.freeze({ enabled: true, provider: "dry_run", mode: "dry_run", environment: "dev" });
const deliverOk = async () => ({ ok: true, provider: "dry_run", reference: "dryrun_enq_1", code: null });
const deliverFail = async () => ({ ok: false, provider: "dry_run", reference: null, code: "unsendable_recipient" });

const run = (over = {}) =>
  notify.notifyLocksmith({
    enquiry: ENQUIRY,
    profile: buildSandboxProfile(),
    config: CONFIG,
    deps: { logger: SILENT, deliver: deliverOk, ...over.deps },
    ...over,
  });

// ── Recipients ──────────────────────────────────────────────────────

describe("recipients come from the approved profile, never the request", () => {
  test("the sandbox profile's SMS list is used", () => {
    const r = notify.resolveRecipients(buildSandboxProfile());
    assert.deepEqual(r, ["+61491570006"], "the ACMA fictitious sandbox recipient");
  });

  test("urgentOnly numbers join only for an urgent job", () => {
    const p = buildSandboxProfile();
    p.notifications.urgentOnly = ["+61491570099"];
    assert.deepEqual(notify.resolveRecipients(p, { urgency: "standard" }), ["+61491570006"]);
    assert.deepEqual(notify.resolveRecipients(p, { urgency: "urgent" }), ["+61491570006", "+61491570099"]);
  });

  test("duplicates and junk are dropped", () => {
    const p = buildSandboxProfile();
    p.notifications.sms = ["+61491570006", "+61491570006", "", null, 42];
    assert.deepEqual(notify.resolveRecipients(p), ["+61491570006"]);
  });

  test("no configured recipient means no attempt and no claim of one", async () => {
    const p = buildSandboxProfile();
    p.notifications.sms = [];
    const store = fakeStore();
    const r = await notify.notifyLocksmith({
      enquiry: ENQUIRY, profile: p, config: CONFIG,
      deps: { logger: SILENT, deliver: deliverOk, claim: store.claim, markSent: store.markSent, markFailed: store.markFailed, markNotRequired: store.markNotRequired },
    });
    assert.equal(r.outcome, "no_recipient");
    assert.equal(r.attempted, false);
    assert.equal(r.delivered, false);
    assert.equal(store.rows.enq_1.state, "not_required");
    assert.match(r.agentMessage, /Do not say the locksmith has been notified/);
  });
});

// ── The message ─────────────────────────────────────────────────────

describe("the message carries what the locksmith needs to act", () => {
  const body = () => notify.buildNotificationBody({ enquiry: ENQUIRY, businessName: "AIDA Locksmith Sandbox", environment: "dev" });

  test("it carries caller, number, suburb, job and urgency", () => {
    const b = body();
    for (const bit of ["Fixture Caller", "+61491570111", "Springvale", "Locked out.", "urgent"]) {
      assert.ok(b.includes(bit), `the locksmith needs ${bit}`);
    }
  });

  test("a sandbox message says so in its first line", () => {
    assert.match(body(), /^\[DEV TEST — not a real job\]/);
    const prod = notify.buildNotificationBody({ enquiry: ENQUIRY, environment: "prod" });
    assert.equal(/TEST — not a real job/.test(prod), false, "a real job must not be labelled a test");
  });

  test("an unsecured property is called out", () => {
    assert.match(body(), /Property NOT secure/);
  });

  test("it is bounded so one job cannot become a twenty-part message", () => {
    const huge = { ...ENQUIRY, problem_description: "x".repeat(5000) };
    const b = notify.buildNotificationBody({ enquiry: huge, environment: "dev" });
    assert.ok(b.length <= notify.MAX_BODY_CHARS, `${b.length} exceeds ${notify.MAX_BODY_CHARS}`);
  });
});

// ── State transitions ───────────────────────────────────────────────

describe("state transitions", () => {
  test("a successful delivery moves pending -> sent and permits the claim", async () => {
    const store = fakeStore();
    const r = await run({ deps: { logger: SILENT, deliver: deliverOk, ...store } });
    assert.equal(r.outcome, "sent");
    assert.equal(r.attempted, true);
    assert.equal(r.delivered, true);
    assert.equal(r.state, "sent");
    assert.equal(store.rows.enq_1.state, "sent");
    assert.equal(store.rows.enq_1.reference, "dryrun_enq_1");
    assert.equal(r.agentMessage, "The locksmith has been notified.");
  });

  test("a failed delivery moves pending -> failed and forbids the claim", async () => {
    const store = fakeStore();
    const r = await run({ deps: { logger: SILENT, deliver: deliverFail, ...store } });
    assert.equal(r.outcome, "failed");
    assert.equal(r.attempted, true, "we DID try — that is a different fact from delivering");
    assert.equal(r.delivered, false);
    assert.equal(store.rows.enq_1.state, "failed");
    assert.equal(store.rows.enq_1.code, "unsendable_recipient");
    assert.equal(/has been notified/.test(r.agentMessage), false);
    assert.match(r.agentMessage, /could not get a message through/);
  });

  test("a delivery adapter that THROWS is a failure, not a crash", async () => {
    const store = fakeStore();
    const r = await run({ deps: { logger: SILENT, deliver: async () => { throw new Error("network gone"); }, ...store } });
    assert.equal(r.outcome, "failed");
    assert.equal(r.delivered, false);
    assert.equal(store.rows.enq_1.state, "failed");
  });

  test("disabled attempts nothing and leaves the row pending", async () => {
    const store = fakeStore();
    const r = await notify.notifyLocksmith({
      enquiry: ENQUIRY, profile: buildSandboxProfile(),
      config: { ...CONFIG, enabled: false },
      deps: { logger: SILENT, deliver: deliverOk, ...store },
    });
    assert.equal(r.outcome, "disabled");
    assert.equal(r.attempted, false);
    assert.equal(r.state, "pending", "still deserves delivery later — not not_required");
    assert.equal(store.rows.enq_1.state, "pending", "nothing was claimed");
  });

  test("notifyLocksmith never throws, whatever it is handed", async () => {
    for (const bad of [null, {}, { id: null }]) {
      const r = await notify.notifyLocksmith({ enquiry: bad, profile: buildSandboxProfile(), config: CONFIG, deps: { logger: SILENT } });
      assert.equal(typeof r.delivered, "boolean");
    }
  });

  test("bookkeeping failure after a REAL send does not retract the send", async () => {
    // The message went. Saying it failed would be the opposite lie to M7J-LV's.
    const store = fakeStore();
    const r = await run({ deps: { logger: SILENT, deliver: deliverOk, ...store, markSent: async () => { throw new Error("db down"); } } });
    assert.equal(r.delivered, true, "the provider accepted it; the row write is separate");
    assert.equal(r.outcome, "sent");
  });
});

// ── Idempotency ─────────────────────────────────────────────────────

describe("the claim is the double-send guard", () => {
  test("a second notification for the same enquiry sends nothing", async () => {
    const store = fakeStore();
    let sends = 0;
    const counting = async () => { sends += 1; return { ok: true, provider: "dry_run", reference: "r", code: null }; };
    const first = await run({ deps: { logger: SILENT, deliver: counting, ...store } });
    const second = await run({ deps: { logger: SILENT, deliver: counting, ...store } });
    assert.equal(first.outcome, "sent");
    assert.equal(second.outcome, "already_handled");
    assert.equal(second.delivered, false);
    assert.equal(sends, 1, "exactly one message for one enquiry");
  });

  test("a row already sending is not claimed again", async () => {
    const store = fakeStore("sending");
    let sends = 0;
    const r = await run({ deps: { logger: SILENT, deliver: async () => { sends += 1; return { ok: true }; }, ...store } });
    assert.equal(r.outcome, "already_handled");
    assert.equal(sends, 0);
  });

  test("a previously FAILED row is not silently resent by this milestone", async () => {
    // M7K never retries. A sweep is a later milestone and must be deliberate.
    const store = fakeStore("failed");
    let sends = 0;
    const r = await run({ deps: { logger: SILENT, deliver: async () => { sends += 1; return { ok: true }; }, ...store } });
    assert.equal(r.outcome, "already_handled");
    assert.equal(sends, 0, "no retry storm");
  });

  test("only ONE delivery attempt is ever made per claim", async () => {
    const store = fakeStore();
    let attempts = 0;
    await run({ deps: { logger: SILENT, deliver: async () => { attempts += 1; return { ok: false, code: "boom" }; }, ...store } });
    assert.equal(attempts, 1, "a failure must not be retried inside a live call");
  });
});

// ── Delivery adapter ────────────────────────────────────────────────

describe("delivery is a dry run unless \"live\" is asked for exactly", () => {
  test("dry run is the default and contacts nothing", async () => {
    let twilioAsked = false;
    const deliver = sms.createSmsDelivery({ env: {}, logger: SILENT, getTwilioClient: () => { twilioAsked = true; return { ok: false }; } });
    const r = await deliver({ to: "+61491570006", body: "test", enquiryId: "enq_1" });
    assert.equal(r.ok, true);
    assert.equal(r.provider, "dry_run");
    assert.match(r.reference, /^dryrun_/, "unmistakably not a Twilio sid");
    assert.equal(twilioAsked, false, "the Twilio client must not even be requested");
  });

  test("only the exact string \"live\" selects real sending", () => {
    for (const v of ["LIVE", "Live", "true", "yes", "1", "", undefined]) {
      assert.equal(sms.resolveMode({ LOCKSMITH_NOTIFY_MODE: v }), "dry_run", `"${v}" must not send`);
    }
    assert.equal(sms.resolveMode({ LOCKSMITH_NOTIFY_MODE: "live" }), "live");
  });

  test("live mode without Twilio credentials refuses rather than throwing", async () => {
    const deliver = sms.createSmsDelivery({
      env: { LOCKSMITH_NOTIFY_MODE: "live", TWILIO_NUMBER: "+61400000000" },
      logger: SILENT,
      getTwilioClient: () => ({ ok: false, client: null, reason: "not configured" }),
    });
    const r = await deliver({ to: "+61491570006", body: "test" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "client_unavailable");
  });

  test("live mode with no sender number refuses", async () => {
    const deliver = sms.createSmsDelivery({ env: { LOCKSMITH_NOTIFY_MODE: "live" }, logger: SILENT, getTwilioClient: () => ({ ok: true, client: {} }) });
    assert.equal((await deliver({ to: "+61491570006", body: "t" })).code, "no_sender_configured");
  });

  test("a non-E.164 recipient is refused before any provider call", async () => {
    const deliver = sms.createSmsDelivery({ env: {}, logger: SILENT });
    for (const bad of ["0491570006", "not a number", "", null]) {
      assert.equal((await deliver({ to: bad, body: "t" })).ok, false, `${bad} must be refused`);
    }
  });

  test("a Twilio throw becomes a coded failure, and the error text is not propagated", async () => {
    const deliver = sms.createSmsDelivery({
      env: { LOCKSMITH_NOTIFY_MODE: "live", TWILIO_NUMBER: "+61400000000" },
      logger: SILENT,
      getTwilioClient: () => ({ ok: true, client: { messages: { create: async () => { const e = new Error("to=+61491570006 is unreachable"); e.code = 21211; throw e; } } } }),
    });
    const r = await deliver({ to: "+61491570006", body: "t" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "21211");
    assert.equal(/unreachable/.test(JSON.stringify(r)), false, "the provider message may echo the number");
  });
});

// ── Configuration ───────────────────────────────────────────────────

describe("notifications are gated and dormant by default", () => {
  test("off unless LOCKSMITH_NOTIFICATIONS_ENABLED is exactly \"true\"", () => {
    assert.equal(cfgN.areNotificationsEnabled({}), false);
    for (const v of ["TRUE", "True", "1", "yes", " true"]) {
      assert.equal(cfgN.areNotificationsEnabled({ LOCKSMITH_NOTIFICATIONS_ENABLED: v }), false);
    }
    assert.equal(cfgN.areNotificationsEnabled({ LOCKSMITH_NOTIFICATIONS_ENABLED: "true" }), true);
  });

  test("enabled but not live means dry run", () => {
    const c = cfgN.getNotificationConfig({ LOCKSMITH_NOTIFICATIONS_ENABLED: "true" });
    assert.equal(c.enabled, true);
    assert.equal(c.live, false);
    assert.equal(c.provider, "dry_run");
  });

  test("live sending reports its missing Twilio prerequisites", () => {
    const a = cfgN.assessNotificationConfig({ LOCKSMITH_NOTIFICATIONS_ENABLED: "true", LOCKSMITH_NOTIFY_MODE: "live" });
    assert.equal(a.ok, false);
    assert.match(a.blockers.join(" "), /TWILIO_ACCOUNT_SID/);
    assert.match(a.blockers.join(" "), /TWILIO_AUTH_TOKEN/);
  });
});

// ── Truthfulness end to end ─────────────────────────────────────────

describe("the tool response keeps four facts separate", () => {
  const captured = { saved: true, outcome: "saved", agentMessage: "Your details are recorded.", enquiryId: "enq_1", errors: [] };

  test("delivered notification -> notified:true and the notification wording wins", () => {
    const body = enquiry.toToolResponse(captured, { attempted: true, delivered: true, state: "sent", agentMessage: "The locksmith has been notified." });
    assert.equal(body.saved, true);
    assert.equal(body.notificationAttempted, true);
    assert.equal(body.notified, true);
    assert.equal(body.acknowledged, false, "delivery is not a human reading it");
    assert.equal(body.message, "The locksmith has been notified.");
  });

  test("attempted but failed -> attempted:true, notified:false", () => {
    const body = enquiry.toToolResponse(captured, { attempted: true, delivered: false, state: "failed", agentMessage: "…could not get a message through…" });
    assert.equal(body.saved, true);
    assert.equal(body.notificationAttempted, true);
    assert.equal(body.notified, false);
  });

  test("no notification at all -> saved only, nothing claimed", () => {
    const body = enquiry.toToolResponse(captured, null);
    assert.equal(body.saved, true);
    assert.equal(body.notificationAttempted, false);
    assert.equal(body.notified, false);
    assert.equal(body.message, "Your details are recorded.");
  });

  test("acknowledged is false on EVERY path — nothing can raise it", () => {
    for (const n of [null, { attempted: true, delivered: true, state: "sent" }, { attempted: true, delivered: false, state: "failed" }]) {
      assert.equal(enquiry.toToolResponse(captured, n).acknowledged, false);
    }
  });

  test("a failed capture can never report a notification", () => {
    const failed = { saved: false, outcome: "failed", agentMessage: "could not save", enquiryId: null, errors: [] };
    const body = enquiry.toToolResponse(failed, null);
    assert.equal(body.saved, false);
    assert.equal(body.notified, false);
  });
});

describe("the prompt permits the claim only on notified:true", () => {
  const prompt = () => {
    const config = cfg.getRetellConfig({
      RETELL_ENABLED: "true", RETELL_TOOLS_ENABLED: "true", RETELL_API_KEY: "k",
      RETELL_DEFAULT_VOICE_ID: "v", RETELL_WEBHOOK_BASE_URL: "https://example.com",
    });
    const compiled = rc.compileReceptionist({
      profile: buildSandboxProfile(), profileVersion: 2, profileStatus: "approved",
      clientId: SANDBOX_CLIENT_ID, templateVersion: "t", config, generatedAt: null, toolFree: false,
    });
    return rc.toRetellPayload({ compiled, config }).responseEngine.general_prompt;
  };

  test("all FOUR states are named", () => {
    const p = prompt();
    assert.match(p, /1\. RECORDED/);
    assert.match(p, /2\. NOT YET PASSED ON/);
    assert.match(p, /3\. NOTIFIED/);
    assert.match(p, /4\. ACKNOWLEDGED/);
  });

  test("the claim is gated on the result field", () => {
    assert.match(prompt(), /unless "notified" is true in the result you just received/);
  });

  test("delivery is explicitly not the locksmith reading or coming", () => {
    assert.match(prompt(), /that means a message was sent — NOT that the locksmith has read it, is available, or is on the way/);
  });

  test("a failed delivery must be stated plainly", () => {
    assert.match(prompt(), /could not get through, say so plainly/);
  });
});
