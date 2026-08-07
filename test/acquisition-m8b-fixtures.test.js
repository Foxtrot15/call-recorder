// LOCKSMITH ACQUISITION M8B — the adversarial fixture set.
//
// A fixture in a system that will one day place phone calls has exactly one
// unforgivable defect: a number that could ring. These tests hold that down,
// and check that each record still makes the gate it exists to make fire —
// because a fixture that has quietly stopped exercising a gate is worse than no
// fixture, since the suite stays green either way.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { M8B_BUSINESSES, M8B_ADAPTER_NAME, registerM8bFixtureAdapter, run } = require("../src/services/acquisition-m8b-fixtures");
const discovery = require("../src/services/acquisition-discovery");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");
const { normaliseProspectPhones } = require("../src/services/acquisition-phone");
const { qualifyProspect } = require("../src/services/acquisition-qualification");
const { identityFingerprint } = require("../src/services/acquisition-prospect");
const S = require("../src/services/acquisition-schema");

const AT = new Date("2026-08-07T03:00:00.000Z");
const now = () => AT;

// ── Safety of the data itself ───────────────────────────────────────

describe("nothing in the fixture could ring", () => {
  const allNumbers = M8B_BUSINESSES.flatMap((b) => b.phones.map((p) => p.raw));

  it("every geographic number is in the ACMA (0X) 5550 XXXX fiction range", () => {
    for (const raw of allNumbers) {
      const digits = raw.replace(/\D/g, "");
      // 04 is a mobile, and it falls inside the geographic character class —
      // checked separately below, and skipped here or every mobile fails this.
      if (/^04/.test(digits)) continue;
      if (!/^0[2378]/.test(digits)) continue;
      assert.match(digits, /^0[2378]5550\d{4}$/, `${raw} is not in the reserved geographic fiction range`);
    }
  });

  it("every mobile is in the 0491 570 XXX fiction block", () => {
    for (const raw of allNumbers) {
      const digits = raw.replace(/\D/g, "");
      if (!/^04/.test(digits)) continue;
      assert.match(digits, /^0491570\d{3}$/, `${raw} is not in the reserved mobile fiction block`);
    }
  });

  it("every service and premium number uses the 555 fiction pattern", () => {
    for (const raw of allNumbers) {
      const digits = raw.replace(/\D/g, "");
      if (!/^(1300|1800|190)/.test(digits)) continue;
      assert.match(digits, /^(1300|1800|190\d)555\d{3}$/, `${raw} is not an obviously invented service number`);
    }
  });

  it("every domain the fixture presents as a business's own is under a reserved example.* name", () => {
    // Third-party directory hosts are deliberately real: source classification
    // is a pure function of the reference string, and a made-up directory
    // domain would not be classified as a directory, so the record would stop
    // exercising the gate it exists for. Nothing is ever fetched from any of
    // them — the offline boundary makes that impossible, not this list.
    const REAL_DIRECTORY_HOSTS = ["yellowpages.com.au", "truelocal.com.au", "hotfrog.com.au"];
    const urls = M8B_BUSINESSES.flatMap((b) => b.sourceRefs.map((r) => r.url).filter(Boolean));
    assert.ok(urls.length > 0);
    for (const url of urls) {
      if (REAL_DIRECTORY_HOSTS.some((h) => url.includes(h))) continue;
      assert.match(url, /\/\/[^/]*example\.(com|net|org)(\.au)?(\/|$)/, `${url} is presented as a business's own site but is not under a reserved example domain`);
    }
  });

  it("no ABN in the fixture is a real registered one — they are invented digits", () => {
    // Not a checksum test: ABR check digits are computable, and a fixture ABN
    // that happened to validate could match a real business. These are labelled
    // invented and only ever compared to each other.
    for (const b of M8B_BUSINESSES.filter((x) => x.abn)) {
      assert.match(b.abn, /^\d{2} \d{3} \d{3} \d{3}$/, `${b.businessName}: "${b.abn}" is not in the shape the fixture uses`);
    }
  });
});

// ── The adapter contract ────────────────────────────────────────────

describe("the adapter", () => {
  it("does not register itself on require", () => {
    // test/acquisition-discovery.test.js asserts the registry is exactly
    // ["fixture-v1"]. Self-registering would break it from three files away.
    //
    // Checked in a CHILD PROCESS, because describe() callbacks in this file run
    // at collection time and one of them registers the adapter — so an in-
    // process assertion here would be testing the order of the file, not the
    // behaviour of the module. Same reason the calling-policy suite shells out
    // to prove it does not read the server's timezone.
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(
      process.execPath,
      ["-e", 'require("./src/services/acquisition-m8b-fixtures"); process.stdout.write(JSON.stringify(require("./src/services/acquisition-discovery").listDiscoveryAdapters()));'],
      { cwd: require("node:path").join(__dirname, ".."), encoding: "utf8" }
    );
    assert.deepStrictEqual(JSON.parse(out), [], "requiring this module must not register anything");
  });

  it("registers on request, declaring that it needs no network", () => {
    registerM8bFixtureAdapter();
    assert.ok(discovery.listDiscoveryAdapters().includes(M8B_ADAPTER_NAME));
    const described = discovery.describeDiscoveryAdapters().find((a) => a.name === M8B_ADAPTER_NAME);
    assert.strictEqual(described.requiresNetwork, false);
  });

  it("registering twice is harmless", () => {
    registerM8bFixtureAdapter();
    registerM8bFixtureAdapter();
    assert.strictEqual(discovery.listDiscoveryAdapters().filter((n) => n === M8B_ADAPTER_NAME).length, 1);
  });

  it("is deterministic — the same query returns the same candidates", () => {
    assert.deepStrictEqual(run({ query: {} }), run({ query: {} }));
  });

  it("never leaks its own answer key into the domain model", () => {
    for (const candidate of run({ query: {} })) {
      assert.strictEqual(candidate.expect, undefined, "`expect` is a note for humans and must not reach a prospect");
      assert.strictEqual(candidate.reimportOf, undefined);
    }
    // …but the notes must still exist on the source data, or nobody can tell
    // why a deliberately broken record is there.
    for (const b of M8B_BUSINESSES) assert.ok(b.expect && b.expect.length > 5, `${b.businessName} does not say why it exists`);
  });

  it("filters by state and by name", () => {
    assert.ok(run({ query: { state: "WA" } }).every((b) => b.state === "WA"));
    assert.strictEqual(run({ query: { names: ["Werribee Lock Centre"] } }).length, 1);
    assert.strictEqual(run({ query: { exclude: ["Werribee Lock Centre"] } }).length, M8B_BUSINESSES.length - 1);
    assert.strictEqual(run({ query: { limit: 3 } }).length, 3);
  });
});

// ── Every record is admitted, and per-claim attribution holds ───────

describe("the whole set survives ingestion", () => {
  registerM8bFixtureAdapter();
  const ledger = createEvidenceLedger({ now });
  const result = discovery.discoverProspects({
    adapter: M8B_ADAPTER_NAME,
    now,
    ledger,
    capturedBy: "test",
    env: { ...process.env, ACQUISITION_ENABLED: "true" },
  });

  it("admits every record — none is refused for a reason the fixture did not intend", () => {
    assert.strictEqual(result.ok, true, result.message);
    assert.deepStrictEqual([...result.rejected], [], "a rejected record means the fixture is malformed, not that a gate fired");
    assert.strictEqual(result.prospects.length, M8B_BUSINESSES.length);
  });

  it("attributes every claim to a source, so nothing is refused as ambiguous", () => {
    // The failure this guards is silent: a record missing one attribution key
    // is rejected at ingestion and simply never appears in the walkthrough.
    for (const p of result.prospects) {
      const rows = ledger.forProspect(p.prospectId);
      assert.ok(rows.length > 0, `${p.businessName} has no evidence`);
      for (const row of rows) assert.ok(row.source, `${p.businessName}: a ${row.kind} row has no source`);
    }
  });

  it("captures nothing as a live fetch", () => {
    for (const p of result.prospects) {
      for (const row of ledger.forProspect(p.prospectId)) {
        assert.strictEqual(row.captureMode, "fixture");
        assert.strictEqual(row.authoritative, false, "fixture data is never authoritative");
      }
    }
  });
});

// ── Each record still makes its gate fire ───────────────────────────

describe("every adversarial record still exercises its gate", () => {
  registerM8bFixtureAdapter();
  const ledger = createEvidenceLedger({ now });
  const result = discovery.discoverProspects({
    adapter: M8B_ADAPTER_NAME,
    now,
    ledger,
    capturedBy: "test",
    env: { ...process.env, ACQUISITION_ENABLED: "true" },
  });
  const byName = new Map(result.prospects.map((p) => [p.businessName, p]));
  const qualify = (name) => qualifyProspect(byName.get(name), { evidenceRows: ledger.forProspect(byName.get(name).prospectId), at: AT });

  it("the lookalike is not a locksmith", () => {
    assert.ok(qualify("Lockyer & Sons Plumbing").disqualifiers.some((d) => d.code === "not_a_locksmith"));
  });

  it("the lead-resale funnel is ruled out", () => {
    assert.ok(qualify("Find A Locksmith Melbourne").disqualifiers.some((d) => d.code === "lead_generation_page"));
  });

  it("the premium-rate number is never dialable", () => {
    const p = byName.get("Southbank Emergency Lock Service");
    assert.strictEqual(normaliseProspectPhones(p).callable.length, 0);
    assert.ok(qualify("Southbank Emergency Lock Service").disqualifiers.some((d) => d.code === "no_callable_number_kind"));
  });

  it("the duplicate normalises to the same number as its original", () => {
    const a = normaliseProspectPhones(byName.get("Brunswick Rapid Locksmiths")).callable.map((n) => n.e164);
    const b = normaliseProspectPhones(byName.get("Brunswick Rapid Locksmiths Pty Ltd")).callable.map((n) => n.e164);
    assert.ok(b.length > 0);
    assert.ok(b.every((n) => a.includes(n)), "the duplicate must share a normalised number with the original");
  });

  it("the re-import resolves to the same identity as the business that opted out", () => {
    const original = identityFingerprint(byName.get("Preston Key & Safe"));
    const reimport = identityFingerprint(byName.get("Preston Key and Safe Pty Ltd"));
    assert.strictEqual(reimport, original, "if these ever differ, the re-import proof is worthless");
  });

  it("the interstate records really are in different timezones", () => {
    assert.strictEqual(byName.get("Fremantle Coast Locksmiths").timezone, "Australia/Perth");
    assert.strictEqual(byName.get("Brunswick Rapid Locksmiths").timezone, "Australia/Melbourne");
    assert.strictEqual(byName.get("Inner West Lock & Key").timezone, "Australia/Sydney");
  });

  it("the set spans more than one state, or the holiday scoping proves nothing", () => {
    const states = new Set(M8B_BUSINESSES.map((b) => b.state));
    assert.ok(states.size >= 3, `only ${states.size} state(s) in the fixture`);
  });

  it("the strongest record is not a sole operator, and a sole operator still qualifies", () => {
    // The commercial direction, encoded in the data rather than only asserted
    // in a comment: a bigger locksmith is a target, and so is a one-van one.
    assert.strictEqual(qualify("Brunswick Rapid Locksmiths").tier, "priority");
    assert.strictEqual(qualify("Ash Cordero Mobile Locksmith").verdict, "qualified");
  });

  it("the set produces a real spread of tiers, not one bucket", () => {
    const tiers = new Set(result.prospects.map((p) => qualify(p.businessName).tier));
    assert.ok(tiers.size >= 3, `the fixture only produced ${[...tiers].join(", ")} — it cannot demonstrate ranking`);
    for (const t of tiers) assert.ok(S.QUALIFICATION_TIERS.includes(t));
  });
});
