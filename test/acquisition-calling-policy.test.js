// LOCKSMITH ACQUISITION A2 — the calling-policy gate.
//
// This gate decides whether a business may lawfully be called at an instant.
// The tests are written around the failure directions that matter: every
// uncertainty must resolve to "do not call", permanent blocks must outrank
// temporary ones, and nothing may depend on the clock or timezone of whatever
// machine happens to be running.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { createCallingPolicy, POLICY_CODES, localParts, isUsableTimeZone } = require("../src/services/acquisition-calling-policy");
const { createFixtureHolidayProvider, createNullHolidayProvider } = require("../src/services/acquisition-holidays");
const { createSuppressionList } = require("../src/services/acquisition-suppression");
const { CALLING_WINDOWS } = require("../src/config/acquisition");

const MELBOURNE = "Australia/Melbourne";
const PERTH = "Australia/Perth";

/** A gate frozen at an instant, with the fixture holiday calendar loaded. */
function gateAt(iso, extra = {}) {
  return createCallingPolicy({
    now: () => new Date(iso),
    holidays: createFixtureHolidayProvider(),
    ...extra,
  });
}

describe("permitted calls", () => {
  it("allows a weekday afternoon inside the window", () => {
    // 2026-08-05T04:00Z = Wednesday 14:00 in Melbourne (AEST, UTC+10).
    const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.code, POLICY_CODES.PERMITTED);
    assert.strictEqual(d.localTime.weekday, "wed");
    assert.strictEqual(d.localTime.time, "14:00");
    assert.strictEqual(d.temporary, false);
  });

  it("allows a Saturday inside the shorter Saturday window", () => {
    const d = gateAt("2026-08-08T06:00:00Z").evaluate({ timezone: MELBOURNE }); // Sat 16:00
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.window.to, "17:00", "Saturday closes earlier than a weekday");
  });

  it("treats the exact opening minute as inside and the exact closing minute as outside", () => {
    const opens = gateAt("2026-08-04T23:00:00Z").evaluate({ timezone: MELBOURNE }); // Wed 09:00
    assert.strictEqual(opens.allowed, true, "09:00 is inside");

    const closes = gateAt("2026-08-05T10:00:00Z").evaluate({ timezone: MELBOURNE }); // Wed 20:00
    assert.strictEqual(closes.allowed, false, "20:00 is the end, not a permitted minute");
    assert.strictEqual(closes.code, POLICY_CODES.AFTER_HOURS);
  });

  it("returns structured output, not a bare boolean", () => {
    const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: MELBOURNE });
    for (const key of ["allowed", "code", "message", "timezone", "localTime", "nextPermittedAt", "policy", "inputs", "temporary"]) {
      assert.ok(key in d, `decision must carry ${key}`);
    }
    assert.strictEqual(typeof d.message, "string");
    assert.ok(d.message.length > 10, "the message must be readable by a person");
  });
});

describe("outside permitted hours", () => {
  it("blocks before opening, temporarily, with the next permitted time", () => {
    const d = gateAt("2026-08-04T22:30:00Z").evaluate({ timezone: MELBOURNE }); // Wed 08:30
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.BEFORE_HOURS);
    assert.strictEqual(d.temporary, true);
    assert.strictEqual(d.nextPermittedAt, "2026-08-04T23:00:00.000Z", "09:00 the same morning");
  });

  it("blocks after closing and rolls to the next day", () => {
    const d = gateAt("2026-08-05T10:30:00Z").evaluate({ timezone: MELBOURNE }); // Wed 20:30
    assert.strictEqual(d.code, POLICY_CODES.AFTER_HOURS);
    assert.strictEqual(d.temporary, true);
    assert.strictEqual(d.nextPermittedAt, "2026-08-05T23:00:00.000Z", "09:00 Thursday");
  });

  it("blocks Sunday as a prohibited day and rolls to Monday", () => {
    const d = gateAt("2026-08-09T02:00:00Z").evaluate({ timezone: MELBOURNE }); // Sun 12:00
    assert.strictEqual(d.code, POLICY_CODES.PROHIBITED_DAY);
    assert.match(d.message, /Sunday/);
    assert.strictEqual(d.nextPermittedAt, "2026-08-09T23:00:00.000Z", "09:00 Monday");
  });

  it("blocks Saturday evening and skips Sunday entirely", () => {
    const d = gateAt("2026-08-08T07:30:00Z").evaluate({ timezone: MELBOURNE }); // Sat 17:30
    assert.strictEqual(d.code, POLICY_CODES.AFTER_HOURS);
    const next = new Date(d.nextPermittedAt);
    assert.strictEqual(localParts(next, MELBOURNE).weekday, "mon", "must skip Sunday");
  });
});

describe("public holidays", () => {
  it("blocks a public holiday and names it", () => {
    const d = gateAt("2026-04-25T02:00:00Z").evaluate({ timezone: MELBOURNE }); // Anzac Day, Sat
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.PUBLIC_HOLIDAY);
    assert.strictEqual(d.holiday.name, "Anzac Day");
    assert.strictEqual(d.temporary, true);
  });

  it("blocks a state holiday in the state that observes it", () => {
    const d = gateAt("2026-11-03T02:00:00Z").evaluate({ timezone: MELBOURNE }); // Melbourne Cup
    assert.strictEqual(d.code, POLICY_CODES.PUBLIC_HOLIDAY);
    assert.strictEqual(d.holiday.name, "Melbourne Cup Day");
  });

  it("skips over a holiday when computing the next permitted time", () => {
    // Christmas Day 2026 is a Friday; Boxing Day Saturday; 28 Dec observed Monday.
    const d = gateAt("2026-12-25T02:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.code, POLICY_CODES.PUBLIC_HOLIDAY);
    const next = new Date(d.nextPermittedAt);
    const nextLocal = localParts(next, MELBOURNE);
    assert.ok(nextLocal.date > "2026-12-28", `next permitted must clear the holidays, got ${nextLocal.date}`);
  });

  it("REFUSES when the holiday calendar does not cover the date — never assumes 'not a holiday'", () => {
    const d = gateAt("2027-02-03T02:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.HOLIDAY_UNKNOWN);
    assert.match(d.message, /public holiday/i);
    assert.strictEqual(d.nextPermittedAt, null, "we cannot compute a next time we cannot verify");
  });

  it("refuses every date when no holiday provider is wired up", () => {
    // The default provider is the null one: forgetting to supply a calendar
    // must stop calls, not silently disable the holiday check.
    const gate = createCallingPolicy({ now: () => new Date("2026-08-05T04:00:00Z") });
    const d = gate.evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.HOLIDAY_UNKNOWN);
  });

  it("an explicitly null provider behaves the same as none", () => {
    const gate = createCallingPolicy({ now: () => new Date("2026-08-05T04:00:00Z"), holidays: createNullHolidayProvider() });
    assert.strictEqual(gate.evaluate({ timezone: MELBOURNE }).code, POLICY_CODES.HOLIDAY_UNKNOWN);
  });
});

describe("daylight saving", () => {
  // Melbourne: DST ends Sun 5 Apr 2026, starts Sun 4 Oct 2026.
  it("maps 09:00 local to a different UTC instant either side of the October transition", () => {
    const beforeDst = gateAt("2026-09-25T07:30:00Z").evaluate({ timezone: MELBOURNE }); // Fri 17:30 AEST
    const afterDst = gateAt("2026-10-09T06:30:00Z").evaluate({ timezone: MELBOURNE }); // Fri 17:30 AEDT

    assert.strictEqual(beforeDst.localTime.time, "17:30");
    assert.strictEqual(afterDst.localTime.time, "17:30");
    assert.strictEqual(beforeDst.allowed, true);
    assert.strictEqual(afterDst.allowed, true);
  });

  it("computes the next permitted time across the DST boundary using the correct offset", () => {
    // Sat 3 Oct 2026 18:00 AEST (after Saturday close). Next is Mon 5 Oct 09:00,
    // by which time Melbourne is AEDT (UTC+11) — so 22:00Z, not 23:00Z.
    const d = gateAt("2026-10-03T08:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.code, POLICY_CODES.AFTER_HOURS);
    assert.strictEqual(d.nextPermittedAt, "2026-10-04T22:00:00.000Z");

    const landed = localParts(new Date(d.nextPermittedAt), MELBOURNE);
    assert.strictEqual(landed.time, "09:00", "must be 09:00 LOCAL, whatever the offset");
    assert.strictEqual(landed.weekday, "mon");
  });

  it("a pre-DST Monday opening resolves to a different UTC instant than a post-DST one", () => {
    const preDst = gateAt("2026-09-26T08:00:00Z").evaluate({ timezone: MELBOURNE }); // Sat after close
    const postDst = gateAt("2026-10-10T07:00:00Z").evaluate({ timezone: MELBOURNE }); // Sat after close

    const preOpen = new Date(preDst.nextPermittedAt).getUTCHours();
    const postOpen = new Date(postDst.nextPermittedAt).getUTCHours();
    assert.notStrictEqual(preOpen, postOpen, "the UTC hour of a 09:00 local opening must shift with DST");
    assert.strictEqual(localParts(new Date(preDst.nextPermittedAt), MELBOURNE).time, "09:00");
    assert.strictEqual(localParts(new Date(postDst.nextPermittedAt), MELBOURNE).time, "09:00");
  });

  it("handles a zone with no daylight saving at all", () => {
    // Perth is UTC+8 year round. 2026-08-05T04:00Z = 12:00 Wednesday.
    const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: PERTH });
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.localTime.time, "12:00");
  });

  it("the same instant is permitted in one zone and not another", () => {
    // 2026-08-04T23:30Z = Wed 09:30 Melbourne (open) but 07:30 Perth (closed).
    const gate = gateAt("2026-08-04T23:30:00Z");
    assert.strictEqual(gate.evaluate({ timezone: MELBOURNE }).allowed, true);
    const perth = gate.evaluate({ timezone: PERTH });
    assert.strictEqual(perth.allowed, false);
    assert.strictEqual(perth.code, POLICY_CODES.BEFORE_HOURS);
  });
});

describe("timezone is required and never assumed", () => {
  it("fails closed when the timezone is missing", () => {
    for (const missing of [undefined, null, "", "   "]) {
      const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: missing });
      assert.strictEqual(d.allowed, false, `timezone ${JSON.stringify(missing)} must refuse`);
      assert.strictEqual(d.code, POLICY_CODES.TIMEZONE_MISSING);
      assert.strictEqual(d.temporary, false, "a missing timezone is not fixed by waiting");
      assert.strictEqual(d.localTime, null);
    }
  });

  it("fails closed on an unrecognised timezone", () => {
    for (const bad of ["Mars/Olympus", "GMT+10", "Australia/Nowhere", "AEST"]) {
      const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: bad });
      assert.strictEqual(d.allowed, false, `"${bad}" must refuse`);
      assert.strictEqual(d.code, POLICY_CODES.TIMEZONE_INVALID);
    }
  });

  it("never silently falls back to server local time", () => {
    // A missing timezone must NOT produce a localTime — producing one would mean
    // some clock was consulted, and the only clock available is the server's.
    const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: null });
    assert.strictEqual(d.localTime, null);
    assert.strictEqual(d.timezone, null);
    assert.ok(/timezone/i.test(d.message));
  });

  it("accepts the IANA identifiers the pilot needs", () => {
    for (const tz of ["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Perth", "Australia/Adelaide", "Australia/Darwin", "Australia/Hobart"]) {
      assert.strictEqual(isUsableTimeZone(tz), true, tz);
    }
  });
});

describe("permanent suppression outranks everything", () => {
  const now = () => new Date("2026-08-05T04:00:00Z"); // Wed 14:00 — otherwise permitted

  function withSuppression() {
    const list = createSuppressionList({ now });
    list.suppress({ reason: "opt_out", fingerprint: "some-locksmith#brunswick|vic", actor: "founder", actorKind: "human", note: "Asked not to be contacted again." });
    list.suppress({ reason: "wrong_number", e164: "+61355509999", actor: "founder", note: "Reaches a bakery." });
    return createCallingPolicy({ now, holidays: createFixtureHolidayProvider(), suppression: list });
  }

  it("blocks a suppressed business even at a permitted time", () => {
    const d = withSuppression().evaluate({ timezone: MELBOURNE, fingerprint: "some-locksmith#brunswick|vic" });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.SUPPRESSED);
    assert.strictEqual(d.temporary, false, "suppression is permanent, never 'try later'");
    assert.strictEqual(d.nextPermittedAt, null, "there is no next permitted time for a suppressed business");
  });

  it("reports suppression as suppression, not as 'outside hours'", () => {
    // Outside hours AND suppressed. Reporting the hours would read as
    // "try again tomorrow" — and tomorrow it would be called.
    const gate = createCallingPolicy({
      now: () => new Date("2026-08-05T10:30:00Z"), // Wed 20:30, after close
      holidays: createFixtureHolidayProvider(),
      suppression: (() => {
        const l = createSuppressionList({ now: () => new Date("2026-08-05T10:30:00Z") });
        l.suppress({ reason: "opt_out", fingerprint: "x#y|vic", actor: "founder", note: "Opted out." });
        return l;
      })(),
    });
    const d = gate.evaluate({ timezone: MELBOURNE, fingerprint: "x#y|vic" });
    assert.strictEqual(d.code, POLICY_CODES.SUPPRESSED);
    assert.strictEqual(d.temporary, false);
  });

  it("outranks a missing timezone too", () => {
    const d = withSuppression().evaluate({ timezone: null, fingerprint: "some-locksmith#brunswick|vic" });
    assert.strictEqual(d.code, POLICY_CODES.SUPPRESSED);
  });

  it("catches a number-scoped suppression by number", () => {
    const d = withSuppression().evaluate({ timezone: MELBOURNE, e164: "+61355509999" });
    assert.strictEqual(d.code, POLICY_CODES.SUPPRESSED);
    assert.strictEqual(d.suppression.scope, "number");
  });

  it("does not block an unrelated business", () => {
    const d = withSuppression().evaluate({ timezone: MELBOURNE, fingerprint: "other#place|vic", e164: "+61355501042" });
    assert.strictEqual(d.allowed, true);
  });

  it("uses the suppression service rather than reimplementing matching", () => {
    // A business-wide opt-out recorded against the identity must be caught when
    // a DIFFERENT number for that business is presented — behaviour that lives
    // in the suppression service, and would be lost by a local reimplementation.
    const d = withSuppression().evaluate({ timezone: MELBOURNE, fingerprint: "some-locksmith#brunswick|vic", e164: "+61355500000" });
    assert.strictEqual(d.code, POLICY_CODES.SUPPRESSED);
    assert.strictEqual(d.suppression.scope, "business");
  });
});

describe("campaign and attempt-level blocks", () => {
  const now = () => new Date("2026-08-05T04:00:00Z");
  const gate = () => createCallingPolicy({ now, holidays: createFixtureHolidayProvider() });

  it("the kill switch stops calling, temporarily", () => {
    const d = gate().evaluate({ timezone: MELBOURNE, campaign: { id: "c1", killSwitchEngaged: true } });
    assert.strictEqual(d.code, POLICY_CODES.KILL_SWITCH);
    assert.strictEqual(d.temporary, true);
  });

  it("an unapproved campaign cannot call", () => {
    const d = gate().evaluate({ timezone: MELBOURNE, campaign: { id: "c1", approved: false } });
    assert.strictEqual(d.code, POLICY_CODES.CAMPAIGN_BLOCKED);
  });

  it("a campaign-level exclusion is permanent for that campaign", () => {
    const d = gate().evaluate({ timezone: MELBOURNE, campaign: { id: "c1", blocked: true, blockReason: "competitor" } });
    assert.strictEqual(d.code, POLICY_CODES.CAMPAIGN_BLOCKED);
    assert.strictEqual(d.temporary, false);
    assert.match(d.message, /competitor/);
  });

  it("the attempt cap is a permanent stop, not a wait", () => {
    const d = gate().evaluate({ timezone: MELBOURNE, history: { attempts: 3 } });
    assert.strictEqual(d.code, POLICY_CODES.ATTEMPT_CAP);
    assert.strictEqual(d.temporary, false);
    assert.strictEqual(d.nextPermittedAt, null);
  });

  it("calling again too soon is a temporary block with a computed next time", () => {
    const d = gate().evaluate({
      timezone: MELBOURNE,
      history: { attempts: 1, lastAttemptAt: "2026-08-04T04:00:00Z" }, // yesterday 14:00
    });
    assert.strictEqual(d.code, POLICY_CODES.TOO_SOON);
    assert.strictEqual(d.temporary, true);
    assert.ok(d.nextPermittedAt, "a wait must say how long");
    assert.ok(new Date(d.nextPermittedAt).getTime() > new Date("2026-08-05T04:00:00Z").getTime());
    // The 2-day cooldown expires Thursday 14:00 local, which is INSIDE the
    // window — so the next permitted moment is exactly when the cooldown ends,
    // not the following morning. Rounding up to 09:00 would delay a lawful call
    // by nineteen hours for no reason.
    assert.strictEqual(d.nextPermittedAt, "2026-08-06T04:00:00.000Z");
    assert.strictEqual(localParts(new Date(d.nextPermittedAt), MELBOURNE).time, "14:00");
  });

  it("a cooldown that expires outside the window rolls forward to the next opening", () => {
    // Last attempt Tuesday 22:00 local → cooldown expires Thursday 22:00 local,
    // which is after the 20:00 close, so the answer must be Friday 09:00.
    const d = gate().evaluate({
      timezone: MELBOURNE,
      history: { attempts: 1, lastAttemptAt: "2026-08-04T12:00:00Z" },
    });
    assert.strictEqual(d.code, POLICY_CODES.TOO_SOON);
    const local = localParts(new Date(d.nextPermittedAt), MELBOURNE);
    assert.strictEqual(local.time, "09:00");
    assert.strictEqual(local.weekday, "fri");
  });

  it("a recent conversation starts a cooldown", () => {
    const d = gate().evaluate({ timezone: MELBOURNE, history: { attempts: 1, lastContactAt: "2026-07-30T04:00:00Z" } });
    assert.strictEqual(d.code, POLICY_CODES.RECENT_CONTACT);
    assert.strictEqual(d.temporary, true);
  });

  it("suppression still outranks a campaign block", () => {
    const list = createSuppressionList({ now });
    list.suppress({ reason: "complaint", fingerprint: "x#y|vic", actor: "founder", note: "Complained." });
    const g = createCallingPolicy({ now, holidays: createFixtureHolidayProvider(), suppression: list });
    const d = g.evaluate({ timezone: MELBOURNE, fingerprint: "x#y|vic", campaign: { id: "c1", killSwitchEngaged: true } });
    assert.strictEqual(d.code, POLICY_CODES.SUPPRESSED);
  });
});

describe("missing or unusable policy", () => {
  const now = () => new Date("2026-08-05T04:00:00Z");

  it("refuses when no calling window is configured", () => {
    const gate = createCallingPolicy({ now, policy: {}, holidays: createFixtureHolidayProvider() });
    const d = gate.evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.allowed, false);
    assert.strictEqual(d.code, POLICY_CODES.POLICY_MISSING);
    assert.strictEqual(d.temporary, false);
  });

  it("refuses a window whose end is not after its start", () => {
    const gate = createCallingPolicy({ now, policy: { wed: { from: "20:00", to: "09:00" } }, holidays: createFixtureHolidayProvider() });
    assert.strictEqual(gate.evaluate({ timezone: MELBOURNE }).code, POLICY_CODES.POLICY_MISSING);
  });

  it("carries the policy source and its legal status in every decision", () => {
    const d = createCallingPolicy({ now, holidays: createFixtureHolidayProvider() }).evaluate({ timezone: MELBOURNE });
    assert.match(d.policy.source, /OUTBOUND_BDM_ARCHITECTURE/);
    assert.strictEqual(d.policy.counselApproved, false, "the window is documented, not legally signed off");
    assert.strictEqual(d.policy.holidayCalendarAuthoritative, false, "the fixture calendar is not authoritative");
  });

  it("counselApproved must be passed explicitly to become true", () => {
    const d = createCallingPolicy({ now, holidays: createFixtureHolidayProvider(), counselApproved: true }).evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.policy.counselApproved, true);
  });

  it("uses the repo-documented window by default rather than inventing one", () => {
    const d = createCallingPolicy({ now, holidays: createFixtureHolidayProvider() }).evaluate({ timezone: MELBOURNE });
    assert.deepStrictEqual({ ...d.policy.windows.wed }, { ...CALLING_WINDOWS.wed });
    assert.strictEqual(d.policy.windows.sun, undefined, "no Sunday window exists");
  });
});

describe("determinism and isolation", () => {
  it("requires an injected clock", () => {
    assert.throws(() => createCallingPolicy({}), /injected now\(\)/);
    assert.throws(() => createCallingPolicy({ now: "nope" }), /injected now\(\)/);
  });

  it("the same inputs always give the same decision", () => {
    const a = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: MELBOURNE });
    const b = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  it("an explicit `at` overrides the clock, so schedulers can ask about a future instant", () => {
    const gate = gateAt("2026-08-05T04:00:00Z");
    const later = gate.evaluate({ timezone: MELBOURNE, at: new Date("2026-08-05T10:30:00Z") });
    assert.strictEqual(later.code, POLICY_CODES.AFTER_HOURS, "asked about 20:30, not 14:00");
  });

  it("does not depend on the host machine's timezone", () => {
    // The real proof: run the same evaluation in child processes whose TZ env
    // differs wildly, and require byte-identical output. A gate that consulted
    // the server clock anywhere would diverge here.
    const script = `
      const { createCallingPolicy } = require(${JSON.stringify(path.join(__dirname, "../src/services/acquisition-calling-policy"))});
      const { createFixtureHolidayProvider } = require(${JSON.stringify(path.join(__dirname, "../src/services/acquisition-holidays"))});
      const gate = createCallingPolicy({ now: () => new Date("2026-08-04T22:30:00Z"), holidays: createFixtureHolidayProvider() });
      const d = gate.evaluate({ timezone: "Australia/Melbourne" });
      process.stdout.write(JSON.stringify({ allowed: d.allowed, code: d.code, local: d.localTime, next: d.nextPermittedAt }));
    `;
    const run = (tz) => execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });

    const utc = run("UTC");
    const honolulu = run("Pacific/Honolulu");
    const kathmandu = run("Asia/Kathmandu");

    assert.strictEqual(utc, honolulu, "TZ=UTC and TZ=Pacific/Honolulu must agree");
    assert.strictEqual(utc, kathmandu, "TZ=UTC and TZ=Asia/Kathmandu must agree");

    const parsed = JSON.parse(utc);
    assert.strictEqual(parsed.local.time, "08:30", "always the business's local time");
    assert.strictEqual(parsed.code, POLICY_CODES.BEFORE_HOURS);
  });

  it("does not depend on the host machine's current time", () => {
    // Two gates with clocks years apart must disagree; a gate reading Date.now()
    // would return the same answer for both.
    const winter = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: MELBOURNE });
    const holiday = gateAt("2026-04-25T04:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.notStrictEqual(winter.code, holiday.code);
  });

  it("makes no network call and touches no provider", () => {
    // Source-level assertion: the gate and its holiday provider must not be able
    // to reach the outside world at all.
    for (const file of ["../src/services/acquisition-calling-policy.js", "../src/services/acquisition-holidays.js"]) {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
      for (const dep of requires) {
        assert.ok(dep.startsWith("./") || dep.startsWith("../"), `${file} may only require local modules, found "${dep}"`);
      }
      assert.ok(!/\bfetch\(|axios|XMLHttpRequest|https?:\/\//.test(source.replace(/^\s*\/\/.*$/gm, "")), `${file} must contain no network call`);
      for (const forbidden of ["twilio", "retell", "sendgrid", "nodemailer"]) {
        assert.ok(!new RegExp(forbidden, "i").test(source.replace(/^\s*\/\/.*$/gm, "")), `${file} must not reference ${forbidden}`);
      }
    }
  });

  it("the decision object is frozen", () => {
    const d = gateAt("2026-08-05T04:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.ok(Object.isFrozen(d));
    assert.throws(() => {
      "use strict";
      d.allowed = true;
    });
  });
});

describe("next permitted time", () => {
  const gate = () => gateAt("2026-08-05T04:00:00Z");

  it("returns the current instant when calling is already permitted", () => {
    const d = gate().evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.nextPermittedAt, "2026-08-05T04:00:00.000Z");
  });

  it("always lands on 09:00 local when it rolls to a later day", () => {
    for (const iso of ["2026-08-05T10:30:00Z", "2026-08-09T02:00:00Z", "2026-08-08T07:30:00Z"]) {
      const d = gateAt(iso).evaluate({ timezone: MELBOURNE });
      assert.strictEqual(localParts(new Date(d.nextPermittedAt), MELBOURNE).time, "09:00", iso);
    }
  });

  it("never proposes a Sunday or a public holiday", () => {
    for (const iso of ["2026-04-24T10:30:00Z", "2026-08-08T07:30:00Z", "2026-12-24T10:30:00Z"]) {
      const d = gateAt(iso).evaluate({ timezone: MELBOURNE });
      if (!d.nextPermittedAt) continue;
      const local = localParts(new Date(d.nextPermittedAt), MELBOURNE);
      assert.notStrictEqual(local.weekday, "sun", `${iso} proposed a Sunday`);
      const holiday = createFixtureHolidayProvider().isHoliday(local.date);
      assert.strictEqual(holiday.holiday, false, `${iso} proposed the holiday ${holiday.name}`);
    }
  });

  it("is null rather than guessed when it cannot be known", () => {
    const d = gateAt("2027-02-03T02:00:00Z").evaluate({ timezone: MELBOURNE });
    assert.strictEqual(d.nextPermittedAt, null);
  });

  it("findNextPermitted is callable on its own for schedulers", () => {
    const next = gate().findNextPermitted(new Date("2026-08-05T10:30:00Z"), MELBOURNE);
    assert.strictEqual(next.toISOString(), "2026-08-05T23:00:00.000Z");
  });
});

describe("the suppression severity list stays in step with the vocabulary", () => {
  it("every reason the suppression service can record is a known code", () => {
    const S = require("../src/services/acquisition-schema");
    const list = createSuppressionList({ now: () => new Date("2026-08-05T04:00:00Z") });
    for (const reason of S.SUPPRESSION_REASONS) {
      const businessWide = S.BUSINESS_WIDE_SUPPRESSIONS.includes(reason);
      const result = list.suppress({
        reason,
        fingerprint: businessWide ? `biz-${reason}#x|vic` : null,
        e164: businessWide ? null : `+6135550${String(S.SUPPRESSION_REASONS.indexOf(reason)).padStart(4, "0")}`,
        actor: "test",
        note: "coverage",
      });
      assert.strictEqual(result.ok, true, `${reason} should be recordable: ${result.message || ""}`);
    }
    assert.strictEqual(list.count(), S.SUPPRESSION_REASONS.length);
  });
});
