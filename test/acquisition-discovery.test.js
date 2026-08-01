// LOCKSMITH ACQUISITION A1 — the discovery adapter contract and the fixture.
//
// These tests pin the contract a future live adapter would also have to
// satisfy, and — more importantly — pin that a live adapter CANNOT be
// registered while the offline boundary is closed.

const { describe, it } = require("node:test");
const assert = require("node:assert");

require("../src/services/acquisition-discovery-fixture");
const discovery = require("../src/services/acquisition-discovery");
const { FIXTURE_BUSINESSES } = require("../src/services/acquisition-discovery-fixture");
const { createEvidenceLedger } = require("../src/services/acquisition-evidence");

const FIXED = new Date("2026-08-01T00:00:00.000Z");
const now = () => FIXED;
const ON = { ACQUISITION_ENABLED: "true", ACQUISITION_REVIEW_ENABLED: "true" };

function run(overrides = {}) {
  const ledger = createEvidenceLedger({ now });
  const result = discovery.discoverProspects({ now, ledger, capturedBy: "test", env: ON, ...overrides });
  return { result, ledger };
}

describe("the adapter registry", () => {
  it("ships exactly one adapter in A1, and it is the deterministic fixture", () => {
    assert.deepStrictEqual(discovery.listDiscoveryAdapters(), ["fixture-v1"]);
  });

  it("no shipped adapter requires the network", () => {
    for (const a of discovery.describeDiscoveryAdapters()) {
      assert.strictEqual(a.requiresNetwork, false, `${a.name} must not need the network`);
    }
  });

  it("REFUSES to register an adapter that needs the network", () => {
    assert.throws(
      () => discovery.registerDiscoveryAdapter("google-places-v1", { requiresNetwork: true, origin: "manual_entry", run: () => [] }),
      /requires network access, which this build does not have/
    );
    assert.ok(!discovery.listDiscoveryAdapters().includes("google-places-v1"), "it must not be registered even partially");
  });

  it("refuses an adapter that will not say whether it touches the network", () => {
    assert.throws(
      () => discovery.registerDiscoveryAdapter("vague-v1", { origin: "manual_entry", run: () => [] }),
      /must declare requiresNetwork/
    );
  });

  it("refuses nonsense registrations", () => {
    assert.throws(() => discovery.registerDiscoveryAdapter("", { requiresNetwork: false, origin: "fixture", run: () => [] }), /needs a name/);
    assert.throws(() => discovery.registerDiscoveryAdapter("x", { requiresNetwork: false, origin: "fixture" }), /needs a run\(\) function/);
    assert.throws(() => discovery.registerDiscoveryAdapter("x", { requiresNetwork: false, origin: "scraped", run: () => [] }), /unknown origin/);
  });

  it("has no origin that means \"scraped\" or \"purchased\"", () => {
    const S = require("../src/services/acquisition-schema");
    for (const origin of S.DISCOVERY_ORIGINS) {
      assert.ok(!/scrape|crawl|purchas|bought|bulk/i.test(origin), `"${origin}" must not exist as an origin`);
    }
  });
});

describe("running discovery", () => {
  it("is off unless the engine is switched on", () => {
    const ledger = createEvidenceLedger({ now });
    const result = discovery.discoverProspects({ now, ledger, env: {} });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "acquisition_disabled");
  });

  it("refuses to run without an evidence ledger — discovery without evidence is not permitted", () => {
    const result = discovery.discoverProspects({ now, env: ON });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "ledger_missing");
  });

  it("refuses to run without an injected clock", () => {
    const ledger = createEvidenceLedger({ now });
    assert.strictEqual(discovery.discoverProspects({ ledger, env: ON }).code, "clock_missing");
  });

  it("an unknown adapter is an error, not a fallback to some default", () => {
    const { result } = run({ adapter: "google-live" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "unknown_adapter");
  });

  it("never approves anything", () => {
    const { result } = run();
    assert.strictEqual(result.approved, false);
  });

  it("is deterministic — the same query always gives the same prospects", () => {
    const a = run().result;
    const b = run().result;
    assert.deepStrictEqual(
      a.prospects.map((p) => p.prospectId),
      b.prospects.map((p) => p.prospectId)
    );
    assert.deepStrictEqual(a.rejected, b.rejected);
  });

  it("writes evidence for every prospect it admits", () => {
    const { result, ledger } = run();
    assert.ok(result.prospects.length > 0);
    for (const p of result.prospects) {
      assert.ok(ledger.forProspect(p.prospectId).length > 0, `${p.businessName} must have evidence`);
    }
  });

  it("stamps every prospect with the fixture origin, so nothing looks human-verified", () => {
    const { result, ledger } = run();
    for (const p of result.prospects) {
      assert.strictEqual(p.origin, "fixture");
      for (const row of ledger.forProspect(p.prospectId)) {
        assert.strictEqual(row.captureMode, "fixture");
        assert.strictEqual(row.authoritative, false);
      }
    }
  });
});

describe("candidates that cannot be admitted", () => {
  it("refuses a candidate with no usable source", () => {
    const { result } = run();
    const rejected = result.rejected.find((r) => r.businessName === "Sunshine Lock Repairs");
    assert.ok(rejected, "the unsourced fixture record must be rejected");
    assert.strictEqual(rejected.code, "candidate_unsourced");
  });

  it("refuses a candidate that cites several sources without saying which fact came from where", () => {
    const { result } = run();
    const rejected = result.rejected.find((r) => r.businessName === "Essendon Lock Supply");
    assert.ok(rejected);
    assert.strictEqual(rejected.code, "claim_source_ambiguous");
    assert.match(rejected.message, /overstate how well we know it/);
  });

  it("a rejected candidate leaves no prospect and no evidence behind", () => {
    const { result, ledger } = run();
    const names = result.prospects.map((p) => p.businessName);
    assert.ok(!names.includes("Sunshine Lock Repairs"));
    assert.ok(!names.includes("Essendon Lock Supply"));
    // No orphan evidence: every row belongs to an admitted prospect.
    const admitted = new Set(result.prospects.map((p) => p.prospectId));
    for (const row of ledger.all()) assert.ok(admitted.has(row.prospectId), "no evidence may outlive a refused candidate");
  });

  it("rejections are reported, not silently dropped", () => {
    const { result } = run();
    assert.ok(result.rejected.length >= 2);
    for (const r of result.rejected) {
      assert.ok(r.code, "every rejection carries a code");
      assert.ok(r.message, "every rejection carries a plain-language message");
    }
  });

  it("a single-source candidate needs no per-claim attribution", () => {
    const { result } = run({ query: { names: ["CBD Lockworks"] } });
    assert.strictEqual(result.prospects.length, 1);
    assert.strictEqual(result.rejected.length, 0);
  });
});

describe("evidence attribution is honest", () => {
  it("attributes each claim to the source that actually published it", () => {
    const { result, ledger } = run({ query: { names: ["Bayside Emergency Locksmiths"] } });
    const p = result.prospects[0];
    const rows = ledger.forProspect(p.prospectId);

    const name = rows.find((r) => r.kind === "business_name");
    const phone = rows.find((r) => r.kind === "phone");

    assert.strictEqual(name.source.official, true, "the name came from their own site");
    assert.strictEqual(phone.source.official, false, "the phone came from an aggregator and must not be dressed up");
    assert.strictEqual(phone.source.sourceType, "aggregator");
  });

  it("does not promote a weak claim to the prospect's strongest source", () => {
    const { result, ledger } = run({ query: { names: ["Bayside Emergency Locksmiths"] } });
    const rows = ledger.forProspect(result.prospects[0].prospectId);
    assert.ok(rows.some((r) => r.source.official === false), "at least one claim must remain marked unofficial");
  });
});

describe("the fixture dataset", () => {
  it("contains only fictional, non-connectable phone numbers", () => {
    for (const business of FIXTURE_BUSINESSES) {
      for (const phone of business.phones || []) {
        const digits = phone.raw.replace(/[^\d]/g, "");
        const isDramaLandline = /^(61)?3?5550\d{4}$/.test(digits) || /5550\d{4}$/.test(digits);
        const isDramaMobile = /^(61)?4?91570\d{3}$/.test(digits) || /491570\d{3}$/.test(digits);
        const isReservedService = /^(1300975707|1800160401|1902555010|132488)$/.test(digits);
        assert.ok(
          isDramaLandline || isDramaMobile || isReservedService,
          `${business.businessName}: "${phone.raw}" is not from a fiction/reserved range and must never appear in a dialling fixture`
        );
      }
    }
  });

  it("uses only RFC 2606 reserved domains for the businesses' own sites", () => {
    for (const business of FIXTURE_BUSINESSES) {
      for (const ref of business.sourceRefs || []) {
        const url = typeof ref === "string" ? ref : ref.url;
        if (!url || !/^https?:/.test(url)) continue;
        const host = new URL(url).hostname;
        const isThirdParty = /(yellowpages|truelocal|localsearch|hotfrog|cylex|facebook|hipages)\./.test(host);
        assert.ok(isThirdParty || /\.example\.(com|com\.au|net|org)$/.test(host), `${host} must be a reserved example domain`);
      }
    }
  });

  it("is deliberately messy — it exercises every admission gate", () => {
    const { result } = run();
    assert.ok(result.prospects.length > 5, "enough clean records to be useful");
    assert.ok(result.rejected.length >= 2, "enough broken records to prove the gates fire");
  });

  it("its narrative `expect` notes never leak into the domain model", () => {
    const { result } = run();
    for (const p of result.prospects) assert.strictEqual(p.expect, undefined);
  });

  it("filters narrow the dataset, and an unmatched filter narrows to nothing", () => {
    // Brunswick holds two records on purpose — the clean one and its duplicate.
    assert.strictEqual(run({ query: { suburb: "Brunswick" } }).result.prospects.length, 2);
    assert.strictEqual(run({ query: { suburb: "Nowhere" } }).result.prospects.length, 0);
    const limited = run({ query: { limit: 3 } }).result;
    assert.strictEqual(limited.prospects.length + limited.rejected.length, 3);
  });

  it("a filter that fails to match narrows to nothing rather than failing open", () => {
    // A filter that returned everything when it did not understand itself is
    // how a "just these three" batch quietly becomes the whole list.
    assert.strictEqual(run({ query: { names: ["No Such Business"] } }).result.prospects.length, 0);
    assert.strictEqual(run({ query: { namePrefix: "zzzz" } }).result.prospects.length, 0);
    assert.strictEqual(run({ query: { limit: 0 } }).result.prospects.length, 0);
  });
});
