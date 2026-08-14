// LOCKSMITH ACQUISITION E-12G — acquisition gets its own number, or none.
//
// ── THE LEAK THIS CLOSES ────────────────────────────────────────────
// `canPlaceCall` in config/retell.js is satisfied by RETELL_OUTBOUND_ONBOARDING_
// NUMBER. Had acquisition leaned on that shared gate, the ONBOARDING number
// would have counted as "acquisition has a number" — and cold calls to
// strangers would have gone out from the caller ID a consenting client was
// interviewed on.
//
// Those are different activities. One is a conversation somebody asked for; the
// other is an interruption. They have different consent, different compliance
// exposure and different reputations to lose, and they do not share a caller ID
// by accident.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────
// No number is provisioned, none is hardcoded, and nothing in this stage can
// dial. A resolved number is a prerequisite, never a permission — the provider,
// the global calling state, DNCR, suppression, hours and the pre-dial gate are
// all separate authorities and every one of them still applies.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveAcquisitionOutboundNumber,
  describeAcquisitionNumberReadiness,
  getAcquisitionRetellConfig,
  EXTERNAL_SYSTEMS,
} = require("../src/config/acquisition");

const ACQ_NUMBER = "+61355500123";
const ONBOARDING_NUMBER = "+61355509999";
const RECEPTIONIST_NUMBER = "+61355508888";

// ---------------------------------------------------------------------------
// 1. RESOLUTION
// ---------------------------------------------------------------------------

describe("E-12G: the acquisition number comes from an acquisition-only key", () => {
  it("1. an explicit acquisition number resolves", () => {
    assert.strictEqual(resolveAcquisitionOutboundNumber({ RETELL_ACQUISITION_OUTBOUND_NUMBER: ACQ_NUMBER }), ACQ_NUMBER);
    assert.strictEqual(getAcquisitionRetellConfig({ RETELL_ACQUISITION_OUTBOUND_NUMBER: ACQ_NUMBER }).outboundNumber, ACQ_NUMBER);
  });

  it("2. an unset key yields null, not a borrowed number", () => {
    assert.strictEqual(resolveAcquisitionOutboundNumber({}), null);
    assert.strictEqual(describeAcquisitionNumberReadiness({}).ready, false);
  });

  it("3. whitespace is tolerated, rubbish is not", () => {
    assert.strictEqual(resolveAcquisitionOutboundNumber({ RETELL_ACQUISITION_OUTBOUND_NUMBER: `  ${ACQ_NUMBER}  ` }), ACQ_NUMBER);
    for (const bad of ["0355500123", "+0355500123", "not a number", "+61", "", "   ", "+6135550012345678901"]) {
      assert.strictEqual(resolveAcquisitionOutboundNumber({ RETELL_ACQUISITION_OUTBOUND_NUMBER: bad }), null, bad);
    }
  });

  it("4. a malformed number is a readiness blocker, not a thrown exception", () => {
    // The provider refuses a non-E.164 fromNumber at dial time by throwing.
    // Catching it here means a founder sees it in a report instead of on the
    // one call that mattered.
    const r = describeAcquisitionNumberReadiness({ RETELL_ACQUISITION_OUTBOUND_NUMBER: "0355500123" });
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.number, null);
    assert.ok(r.blockers.some((b) => /not a valid E\.164/i.test(b)));
  });
});

// ---------------------------------------------------------------------------
// 2. NO OTHER PRODUCT'S NUMBER COUNTS
// ---------------------------------------------------------------------------

describe("E-12G: no shared or inherited number satisfies acquisition", () => {
  it("5. the ONBOARDING number does not make acquisition ready", () => {
    const env = { RETELL_OUTBOUND_ONBOARDING_NUMBER: ONBOARDING_NUMBER };
    assert.strictEqual(resolveAcquisitionOutboundNumber(env), null);
    const r = describeAcquisitionNumberReadiness(env);
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.inheritedFromAnotherProduct, false);
  });

  it("6. no generic Twilio or receptionist number counts either", () => {
    for (const key of ["TWILIO_PHONE_NUMBER", "CLIENT_REAL_NUMBER", "RETELL_INBOUND_DEMO_NUMBER"]) {
      const env = { [key]: RECEPTIONIST_NUMBER };
      assert.strictEqual(resolveAcquisitionOutboundNumber(env), null, key);
      assert.strictEqual(describeAcquisitionNumberReadiness(env).ready, false, key);
    }
  });

  it("7. every foreign number at once still leaves acquisition without one", () => {
    const env = {
      RETELL_OUTBOUND_ONBOARDING_NUMBER: ONBOARDING_NUMBER,
      RETELL_INBOUND_DEMO_NUMBER: RECEPTIONIST_NUMBER,
      TWILIO_PHONE_NUMBER: RECEPTIONIST_NUMBER,
      CLIENT_REAL_NUMBER: RECEPTIONIST_NUMBER,
    };
    assert.strictEqual(resolveAcquisitionOutboundNumber(env), null);
    assert.strictEqual(describeAcquisitionNumberReadiness(env).ready, false);
  });

  it("8. an explicit acquisition number is not overridden by a foreign one", () => {
    const env = { RETELL_ACQUISITION_OUTBOUND_NUMBER: ACQ_NUMBER, RETELL_OUTBOUND_ONBOARDING_NUMBER: ONBOARDING_NUMBER };
    assert.strictEqual(resolveAcquisitionOutboundNumber(env), ACQ_NUMBER);
    assert.notStrictEqual(resolveAcquisitionOutboundNumber(env), ONBOARDING_NUMBER);
  });

  it("9. the same number in both keys is a coincidence, not a link", () => {
    const both = { RETELL_ACQUISITION_OUTBOUND_NUMBER: ACQ_NUMBER, RETELL_OUTBOUND_ONBOARDING_NUMBER: ACQ_NUMBER };
    const acqOnly = { RETELL_ACQUISITION_OUTBOUND_NUMBER: ACQ_NUMBER };
    assert.strictEqual(resolveAcquisitionOutboundNumber(both), resolveAcquisitionOutboundNumber(acqOnly));
  });

  it("10. the resolver reads no foreign key at all", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "config", "acquisition.js"), "utf8");
    for (const foreign of ["RETELL_OUTBOUND_ONBOARDING_NUMBER", "TWILIO_PHONE_NUMBER", "CLIENT_REAL_NUMBER", "RETELL_INBOUND_DEMO_NUMBER"]) {
      assert.ok(!new RegExp(`env\\.${foreign}`).test(src), `must not read ${foreign}`);
    }
    // Named in prose is the point — explaining why it is NOT read.
    assert.match(src, /RETELL_OUTBOUND_ONBOARDING_NUMBER/);
    assert.ok(!/\|\|\s*env\./.test(src.split("function resolveAcquisitionOutboundNumber")[1].split("}")[0]), "no fallback chain");
  });
});

// ---------------------------------------------------------------------------
// 3. A NUMBER GRANTS NOTHING
// ---------------------------------------------------------------------------

describe("E-12G: having a number is not permission to use it", () => {
  const READY = { RETELL_ACQUISITION_OUTBOUND_NUMBER: ACQ_NUMBER };

  it("11. number readiness does not make any provider live", () => {
    assert.strictEqual(describeAcquisitionNumberReadiness(READY).ready, true);
    const dial = require("../src/services/acquisition-dial-provider");
    const retell = require("../src/services/acquisition-retell-provider");
    assert.strictEqual(dial.createDisabledDialProvider().live, false);
    assert.strictEqual(dial.createFakeDialProvider().live, false);
    assert.strictEqual(retell.createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: ACQ_NUMBER } }).live, false);
  });

  it("12. it does not enable the acquisition engine or unpause calling", () => {
    const cfg = require("../src/config/acquisition");
    assert.strictEqual(cfg.isAcquisitionEnabled(READY), false);
    assert.strictEqual(cfg.acquisitionReady("dial", READY).code, "acquisition_disabled");
    // Nothing in this stage can write calling state.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "config", "acquisition.js"), "utf8");
    assert.ok(!/writeCallingState/.test(src));
  });

  it("13. it does not make Retell live writes or live calls permissible", () => {
    const { canWriteLive, canPlaceCall } = require("../src/config/retell");
    assert.strictEqual(canWriteLive(READY).allowed, false);
    assert.strictEqual(canPlaceCall(READY).allowed, false);
  });

  it("14. telephony remains structurally unavailable", () => {
    assert.strictEqual(EXTERNAL_SYSTEMS.telephony, false, "a hardcoded constant no env var can change");
  });

  it("15. and it says so itself, rather than leaving the reader to assume", () => {
    const r = describeAcquisitionNumberReadiness(READY);
    assert.match(r.note, /grants no permission to dial/i);
    assert.match(r.note, /pre-dial gate still runs/i);
  });
});

// ---------------------------------------------------------------------------
// 4. NOTHING WAS PROVISIONED, AND NOTHING CAN BE
// ---------------------------------------------------------------------------

describe("E-12G: no number was provisioned and none is hardcoded", () => {
  it("16. no real-looking number literal was committed", () => {
    for (const rel of ["src/config/acquisition.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      assert.ok(!/\+\d{9,15}/.test(src), `${rel} must not carry a phone number literal`);
    }
  });

  it("17. nothing in src/ or scripts/ can provision or bind a number", () => {
    const roots = ["src", "scripts"];
    const offenders = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(__dirname, "..", d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.name.endsWith(".js")) continue;
        const body = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
        if (/\b(bindPhoneNumber|createPhoneNumber|buyPhoneNumber|provisionNumber)\s*\(/.test(body)) offenders.push(rel);
      }
    };
    for (const r of roots) walk(r);
    assert.deepStrictEqual(offenders, [], `nothing may provision a number: ${offenders.join(", ")}`);
  });

  it("18. the acquisition provider still refuses a non-E.164 from-number at dial time", () => {
    // The resolver is a second line of defence, not a replacement for this.
    const { createRetellAcquisitionProvider } = require("../src/services/acquisition-retell-provider");
    assert.throws(
      () => createRetellAcquisitionProvider({ routing: { agentId: "a", fromNumber: "0355500123" } }),
      /E\.164/
    );
  });

  it("19. routing still comes from server config and never from a caller", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "acquisition-retell-provider.js"), "utf8");
    assert.match(src, /NEVER from the\s*\*? ?execution/i);
  });

  it("20. the number boundary added no network reach", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "config", "acquisition.js"), "utf8");
    // Import/call forms only. The EXTERNAL_SYSTEMS block names Twilio in prose
    // precisely to declare it unavailable, and banning the word would mean
    // deleting the declaration to satisfy the test.
    assert.ok(!/require\(["'][^"']*(twilio|retell-adapter|node-fetch|axios)["']\)/.test(src), "no transport import");
    assert.ok(!/\bfetch\s*\(/.test(src), "no fetch call");
    // And the declaration is still there.
    assert.match(src, /telephony:\s*false/);
  });
});
