// Phase 1c regression tests — the mandatory proofs:
//   1. voicemail TwiML byte-identical for non-VoIP clients (frozen contract)
//   2. any guard/DB/device failure falls back to the v1 voicemail path
//   3. owner bridge executes before the VoIP branch
//   4. Twilio signature validation unchanged (/voip/dial-result chain)
//   5. no code path can create a PSTN loop (<Client> only, INV-2 no-<Dial>)
//
// TwiML byte-identity is proven at the op level: a fake recorder captures
// every method call + args. Same twilio lib + identical call sequence +
// identical args ⇒ identical XML bytes; the sequences below are transcribed
// VERBATIM from the pre-1c inline code and act as the frozen contract.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { appendVoicemailTwiml, DEFAULT_GREETING } = require("../src/services/voicemail-twiml");
const {
  decideVoipDelivery,
  appendClientDialTwiml,
  renderDialResult,
  evaluateVoipDelivery,
} = require("../src/services/voip-dial");
const { canRegisterNewDevice } = require("../src/services/devices");

const ENV = { BASE_URL: "https://aida.example", VOICEMAIL_GREETING: "" };

// Captures every TwiML method call, including nested <Dial> children.
function fakeTwiml() {
  const ops = [];
  const rec = (name) => (...args) => { ops.push({ op: name, args }); };
  return {
    ops,
    play: rec("play"),
    say: rec("say"),
    record: rec("record"),
    hangup: rec("hangup"),
    dial(attrs) {
      const children = [];
      ops.push({ op: "dial", args: [attrs], children });
      return {
        client: (id) => children.push({ op: "client", args: [id] }),
        number: (n) => children.push({ op: "number", args: [n] }),
      };
    },
  };
}

// ── MANDATORY 1: frozen voicemail contract (INV-3) ───────────────────────────
describe("1. voicemail TwiML is byte-identical (frozen pre-1c contract)", () => {
  const FROZEN_RECORD_ATTRS = {
    maxLength: 180,
    playBeep: true,
    trim: "trim-silence",
    recordingStatusCallback: "https://aida.example/recording/complete",
    recordingStatusCallbackMethod: "POST",
    action: "https://aida.example/inbound/voicemail-complete",
  };
  const FROZEN_CLOSING_SAY = [{ voice: "Polly.Amy", language: "en-AU" }, "Sorry, I didn't catch that. Goodbye."];

  it("no custom greeting: say(default) → record → say — exact pre-1c args", () => {
    const t = fakeTwiml();
    appendVoicemailTwiml(t, { greetingUrl: null, env: ENV });
    assert.deepStrictEqual(t.ops, [
      { op: "say", args: [{ voice: "Polly.Amy", language: "en-AU" }, DEFAULT_GREETING] },
      { op: "record", args: [FROZEN_RECORD_ATTRS] },
      { op: "say", args: FROZEN_CLOSING_SAY },
    ]);
  });

  it("frozen default greeting text is unchanged from the pre-1c inline string", () => {
    assert.strictEqual(
      DEFAULT_GREETING,
      "Sorry, I can't get to the phone right now. Please leave a message with your name, number, and reason for calling, and I'll get back to you as soon as possible."
    );
  });

  it("custom greeting: play(url) → record → say — exact pre-1c args", () => {
    const t = fakeTwiml();
    appendVoicemailTwiml(t, { greetingUrl: "https://cdn/greeting.mp3", env: ENV });
    assert.deepStrictEqual(t.ops, [
      { op: "play", args: ["https://cdn/greeting.mp3"] },
      { op: "record", args: [FROZEN_RECORD_ATTRS] },
      { op: "say", args: FROZEN_CLOSING_SAY },
    ]);
  });

  it("VOICEMAIL_GREETING env override still respected, exactly as before", () => {
    const t = fakeTwiml();
    appendVoicemailTwiml(t, { greetingUrl: null, env: { ...ENV, VOICEMAIL_GREETING: "Custom text" } });
    assert.deepStrictEqual(t.ops[0], { op: "say", args: [{ voice: "Polly.Amy", language: "en-AU" }, "Custom text"] });
  });
});

// ── MANDATORY 2: every failure falls back to v1 ──────────────────────────────
describe("2. guard/DB/device failure ⇒ v1 voicemail path (evaluate never throws)", () => {
  const CLIENT = { slug: "pilot-plumbing" };
  const okDeps = {
    enabled: () => true,
    isClientVoipEnabled: async () => true,
    countActiveDevices: async () => 2,
    isPersonalCall: async () => false,
  };

  it("all gates pass ⇒ deliver with identity + record", async () => {
    const r = await evaluateVoipDelivery(CLIENT, { callerNumber: "+61399998888" }, okDeps);
    assert.deepStrictEqual(r, { deliver: true, record: true, identity: "client_pilot_plumbing" });
  });

  it("voip_enabled lookup THROWS ⇒ deliver:false (not an exception)", async () => {
    const r = await evaluateVoipDelivery(CLIENT, {}, { ...okDeps, isClientVoipEnabled: async () => { throw new Error("db down"); } });
    assert.deepStrictEqual(r, { deliver: false });
  });

  it("device count THROWS ⇒ deliver:false", async () => {
    const r = await evaluateVoipDelivery(CLIENT, {}, { ...okDeps, countActiveDevices: async () => { throw new Error("42P01"); } });
    assert.deepStrictEqual(r, { deliver: false });
  });

  it("flag-check THROWS ⇒ deliver:false", async () => {
    const r = await evaluateVoipDelivery(CLIENT, {}, { ...okDeps, enabled: () => { throw new Error("boom"); } });
    assert.deepStrictEqual(r, { deliver: false });
  });

  it("personal-check failure degrades to record:true delivery, not a drop", async () => {
    const r = await evaluateVoipDelivery(CLIENT, {}, { ...okDeps, isPersonalCall: async () => { throw new Error("nope"); } });
    assert.deepStrictEqual(r, { deliver: true, record: true, identity: "client_pilot_plumbing" });
  });

  it("bad slug (identity underivable) ⇒ deliver:false, not a throw", async () => {
    const r = await evaluateVoipDelivery({ slug: "BAD SLUG" }, {}, okDeps);
    assert.deepStrictEqual(r, { deliver: false });
  });

  it("PRODUCTION TODAY: server flag off ⇒ deliver:false and ZERO db calls", async () => {
    let dbCalls = 0;
    const spyDeps = {
      enabled: () => false,
      isClientVoipEnabled: async () => { dbCalls++; return true; },
      countActiveDevices: async () => { dbCalls++; return 5; },
      isPersonalCall: async () => { dbCalls++; return false; },
    };
    const r = await evaluateVoipDelivery(CLIENT, {}, spyDeps);
    assert.deepStrictEqual(r, { deliver: false });
    assert.strictEqual(dbCalls, 0, "disabled state must add no DB work to the live inbound path");
  });

  it("decision table: every partial gate combination refuses delivery", () => {
    const cases = [
      { serverEnabled: false, clientVoipEnabled: true, activeDeviceCount: 3 },
      { serverEnabled: true, clientVoipEnabled: false, activeDeviceCount: 3 },
      { serverEnabled: true, clientVoipEnabled: true, activeDeviceCount: 0 },
      { serverEnabled: true, clientVoipEnabled: true, activeDeviceCount: NaN },
    ];
    for (const c of cases) {
      assert.strictEqual(decideVoipDelivery({ ...c, isPersonal: false }).deliver, false, JSON.stringify(c));
    }
    assert.strictEqual(decideVoipDelivery({ serverEnabled: true, clientVoipEnabled: true, activeDeviceCount: 1, isPersonal: false }).deliver, true);
    assert.strictEqual(decideVoipDelivery({ serverEnabled: true, clientVoipEnabled: true, activeDeviceCount: 1, isPersonal: true }).record, false, "personal ⇒ no record attr");
  });
});

// ── MANDATORY 3: owner bridge before VoIP branch (source-order contract) ─────
describe("3. branch order in /inbound/voice", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "inbound.js"), "utf8");

  it("OUTBOUND BRIDGE < VOIP DELIVERY < MISSED CALL, all present exactly once", () => {
    const bridge = src.indexOf("OUTBOUND BRIDGE");
    const voipBranch = src.indexOf("VOIP DELIVERY");
    const missed = src.indexOf("MISSED CALL");
    assert.ok(bridge > -1 && voipBranch > -1 && missed > -1, "all three sections must exist");
    assert.ok(bridge < voipBranch, "owner bridge must run before the VoIP branch");
    assert.ok(voipBranch < missed, "VoIP branch must run before the voicemail block");
    assert.strictEqual(src.indexOf("VOIP DELIVERY", voipBranch + 1), -1, "exactly one VoIP branch");
  });

  it("the VoIP delivery attempt is wrapped in try/catch falling through to voicemail", () => {
    const section = src.slice(src.indexOf("VOIP DELIVERY"), src.indexOf("MISSED CALL"));
    assert.match(section, /try\s*\{/);
    assert.match(section, /catch\s*\(err\)/);
    assert.match(section, /falling back to v1 voicemail/);
  });
});

// ── MANDATORY 4: Twilio signature validation unchanged ──────────────────────
describe("4. webhook auth chains (source contracts)", () => {
  it("/voip/dial-result chain is flagGate → twilioWebhook → handler", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "voip-webhooks.js"), "utf8");
    assert.match(src, /router\.post\(\s*"\/dial-result",\s*flagGate,\s*twilioWebhook,/);
    assert.match(src, /require\("\.\.\/middleware\/auth"\)/);
  });

  it("existing Twilio mounts in server.js are untouched (inbound/recording still twilioWebhook)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
    assert.match(src, /app\.use\("\/inbound",\s+twilioWebhook,/);
    assert.match(src, /app\.use\("\/recording",\s+twilioWebhook,/);
  });

  it("scaffold no longer claims dial-result (real route owns it); other placeholders remain", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "voip-scaffold.js"), "utf8");
    assert.strictEqual(src.includes('"/voip/dial-result"'), false);
    assert.ok(src.includes('"/voip/call-status"') && src.includes('"/voip/push-ack"'));
  });
});

// ── MANDATORY 5: no PSTN loop possible (INV-2 + <Client>-only dial) ─────────
describe("5. INV-2: dial-result branches; delivery dial is <Client>-only", () => {
  it("completed ⇒ <Hangup/> only", () => {
    const t = fakeTwiml();
    const r = renderDialResult(t, { dialCallStatus: "completed", env: ENV });
    assert.strictEqual(r.branch, "completed");
    assert.deepStrictEqual(t.ops, [{ op: "hangup", args: [] }]);
  });

  it("EVERY non-completed status ⇒ shared voicemail TwiML, and never a <Dial>", () => {
    for (const status of ["busy", "no-answer", "failed", "canceled", "", undefined, null, "garbage"]) {
      const t = fakeTwiml();
      const r = renderDialResult(t, { dialCallStatus: status, greetingUrl: null, env: ENV });
      assert.strictEqual(r.branch, "voicemail", `status=${status}`);
      const opNames = t.ops.map((o) => o.op);
      assert.ok(opNames.includes("record"), `status=${status} must offer voicemail`);
      assert.strictEqual(opNames.includes("dial"), false, `INV-2 violated for status=${status}: <Dial> in fallback`);
      assert.strictEqual(opNames.includes("hangup"), false, `status=${status}: fallback must not hang up before recording`);
    }
  });

  it("dial-result fallback renders the IDENTICAL frozen voicemail ops as v1", () => {
    const v1 = fakeTwiml();
    appendVoicemailTwiml(v1, { greetingUrl: "https://cdn/g.mp3", env: ENV });
    const v2 = fakeTwiml();
    renderDialResult(v2, { dialCallStatus: "no-answer", greetingUrl: "https://cdn/g.mp3", env: ENV });
    assert.deepStrictEqual(v2.ops, v1.ops, "INV-2 fallback and v1 voicemail must be the same bytes");
  });

  it("delivery dial: <Client> child only, frozen attrs, action=/voip/dial-result", () => {
    const t = fakeTwiml();
    appendClientDialTwiml(t, { identity: "client_pilot_plumbing", record: true, env: ENV });
    assert.strictEqual(t.ops.length, 1);
    const dial = t.ops[0];
    assert.deepStrictEqual(dial.args[0], {
      answerOnBridge: true,
      timeout: 20,
      action: "/voip/dial-result",
      method: "POST",
      record: "record-from-answer-dual",
      recordingStatusCallback: "https://aida.example/recording/complete",
      recordingStatusCallbackMethod: "POST",
    });
    assert.deepStrictEqual(dial.children, [{ op: "client", args: ["client_pilot_plumbing"] }]);
    assert.ok(!dial.children.some((c) => c.op === "number"), "a <Number> child here would be a PSTN loop");
  });

  it("personal contact: record attrs omitted entirely (no recording exists)", () => {
    const t = fakeTwiml();
    appendClientDialTwiml(t, { identity: "client_x", record: false, env: ENV });
    const attrs = t.ops[0].args[0];
    assert.deepStrictEqual(Object.keys(attrs).sort(), ["action", "answerOnBridge", "method", "timeout"]);
  });
});

// Sanity: Phase 1b invariants still hold post-1c edits to devices.js.
describe("devices.js unchanged contracts", () => {
  it("cap logic untouched", () => {
    assert.strictEqual(canRegisterNewDevice(4), true);
    assert.strictEqual(canRegisterNewDevice(5), false);
  });
});
