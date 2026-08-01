// LOCKSMITH ACQUISITION A1 — official business source identification.
//
// The pipeline requires an OFFICIAL source before a business can be called.
// These tests pin what counts as official, what does not, and that the
// classification is a pure function of the reference — no network.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const src = require("../src/services/acquisition-source");
const S = require("../src/services/acquisition-schema");

describe("registrable domain", () => {
  it("handles Australian three-label domains", () => {
    assert.strictEqual(src.registrableDomain("www.example.com.au"), "example.com.au");
    assert.strictEqual(src.registrableDomain("shop.pages.example.net.au"), "example.net.au");
    assert.strictEqual(src.registrableDomain("abr.business.gov.au"), "business.gov.au");
  });

  it("handles ordinary two-label domains", () => {
    assert.strictEqual(src.registrableDomain("m.facebook.com"), "facebook.com");
    assert.strictEqual(src.registrableDomain("example.com"), "example.com");
  });
});

describe("classifying a source", () => {
  const classify = (ref) => src.classifySource(ref);

  it("treats a business's own domain as an official website", () => {
    const r = classify("https://northsidelockandkey.example.com.au/contact");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sourceType, "official_website");
    assert.strictEqual(r.official, true);
  });

  it("treats a government register record as official, and the strongest source", () => {
    const r = classify({ register: "ABR", identifier: "51 824 753 556" });
    assert.strictEqual(r.sourceType, "government_register");
    assert.strictEqual(r.official, true);
    assert.strictEqual(r.authorityRank, 0);
    assert.match(r.label, /ABR record/);
  });

  it("a register citation with no identifier is refused", () => {
    const r = classify({ register: "ABR" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "register_identifier_missing");
  });

  it("directories, aggregators, social and maps are all NOT official", () => {
    const cases = [
      ["https://www.yellowpages.com.au/vic/x/y", "unverified_directory"],
      ["https://www.truelocal.com.au/business/x", "unverified_directory"],
      ["https://www.hotfrog.com.au/company/x", "aggregator"],
      ["https://www.cylex.com.au/company/x", "aggregator"],
      ["https://www.facebook.com/somelocksmith", "social_profile"],
      ["https://www.instagram.com/somelocksmith", "social_profile"],
      ["https://maps.google.com/?cid=123", "map_listing"],
      ["https://www.google.com/maps/place/somewhere", "map_listing"],
      ["https://hipages.com.au/connect/x", "verified_directory"],
    ];
    for (const [url, expected] of cases) {
      const r = classify(url);
      assert.strictEqual(r.ok, true, url);
      assert.strictEqual(r.sourceType, expected, url);
      assert.strictEqual(r.official, false, `${url} must never be official`);
    }
  });

  it("subdomains cannot be used to dodge a host-table entry", () => {
    assert.strictEqual(classify("https://vic.yellowpages.com.au/x").sourceType, "unverified_directory");
    assert.strictEqual(classify("https://au.hotfrog.com/company/x").sourceType, "aggregator");
  });

  it("a website-builder subdomain is official-with-a-caveat, never silently trusted", () => {
    const r = classify("https://mylocksmith.wixsite.com/home");
    assert.strictEqual(r.sourceType, "official_website");
    assert.strictEqual(r.official, true);
    assert.ok(r.caveats.length > 0);
    assert.match(r.caveats[0], /shared website-builder domain/);
  });

  it("a front-page link to a directory is flagged as not being about this business", () => {
    const r = classify("https://www.yellowpages.com.au/");
    assert.ok(r.caveats.some((c) => /front page/.test(c)));
  });

  it("refuses references it cannot read, rather than guessing", () => {
    for (const bad of ["", "   ", "not a url at all", "mailto:someone@example.com", "tel:+61355501042", "javascript:alert(1)", "http://127.0.0.1/x", "http://localhost/x"]) {
      const r = classify(bad);
      assert.strictEqual(r.ok, false, `"${bad}" should be refused`);
    }
  });

  it("never throws on hostile input", () => {
    for (const bad of [null, undefined, 0, {}, [], { url: 12345 }, { url: null }]) {
      assert.doesNotThrow(() => classify(bad));
      assert.strictEqual(classify(bad).ok, false);
    }
  });

  it("an operator cannot simply ASSERT an official source with no reference", () => {
    const r = classify({ sourceType: "official_website", label: "their site, trust me" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "official_source_needs_reference");
  });

  it("an operator may declare a non-official source type", () => {
    const r = classify({ sourceType: "map_listing", label: "seen in store window" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.official, false);
    assert.ok(r.caveats.length > 0);
  });

  it("an unknown source type is refused", () => {
    assert.strictEqual(classify({ sourceType: "vibes" }).code, "source_type_unknown");
  });

  it("only the register and the business's own site are official", () => {
    assert.deepStrictEqual([...S.OFFICIAL_SOURCE_TYPES], ["government_register", "official_website"]);
  });
});

describe("summarising several sources", () => {
  it("picks the strongest as primary and reports official backing", () => {
    const summary = src.summariseSources([
      "https://www.hotfrog.com.au/company/x",
      { register: "ABR", identifier: "51 824 753 556" },
      "https://x.example.com.au/",
    ]);
    assert.strictEqual(summary.primary.sourceType, "government_register");
    assert.strictEqual(summary.hasOfficialSource, true);
    assert.strictEqual(summary.sources.length, 3);
  });

  it("reports no official source when only third parties are held", () => {
    const summary = src.summariseSources(["https://www.yellowpages.com.au/vic/x", "https://www.facebook.com/x"]);
    assert.strictEqual(summary.hasOfficialSource, false);
    assert.strictEqual(summary.officialSource, null);
  });

  it("keeps unreadable references as a data-quality signal rather than dropping them", () => {
    const summary = src.summariseSources(["https://x.example.com.au/", "not a url"]);
    assert.strictEqual(summary.sources.length, 1);
    assert.strictEqual(summary.unusable.length, 1);
    assert.strictEqual(summary.unusable[0].code, "source_unparseable");
  });

  it("an empty source list is not an official source", () => {
    const summary = src.summariseSources([]);
    assert.strictEqual(summary.hasOfficialSource, false);
    assert.strictEqual(summary.primary, null);
  });
});

describe("describing sources in plain language", () => {
  it("says so when we have nothing", () => {
    assert.match(src.describeSources(src.summariseSources([])), /no source at all/);
  });

  it("names the register when we have one", () => {
    const text = src.describeSources(src.summariseSources([{ register: "ABR", identifier: "51 824 753 556" }]));
    assert.match(text, /government business register/i);
  });

  it("is explicit that directory-only evidence is not the business's own", () => {
    const text = src.describeSources(src.summariseSources(["https://www.yellowpages.com.au/vic/x/y"]));
    assert.match(text, /third-party listings/);
    assert.match(text, /have not found this business's own website/);
  });
});
