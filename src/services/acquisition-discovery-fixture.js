// AIDA Locksmith Acquisition — the deterministic discovery fixture (A1).
//
// The ONLY discovery adapter this build ships. It returns a fixed set of
// invented Melbourne locksmith businesses. NO NETWORK IS TOUCHED: there is no
// fetch, no search API, no crawler. Same query in, same candidates out, every
// time — which is what makes the entire acquisition pipeline testable without
// contacting a single real business.
//
// EVERY BUSINESS BELOW IS FICTIONAL. The names are invented and the phone
// numbers are drawn from the ranges the ACMA reserves for fiction — geographic
// numbers of the form (0X) 5550 XXXX and mobiles in the 0491 570 XXX block —
// so that even a catastrophic bug that somehow reached a dialler could not
// reach a member of the public. The domains are under example.com /
// example.com.au, which are reserved by RFC 2606 and cannot be registered.
//
// This costs nothing and removes an entire category of accident. A fixture in a
// system that will one day place phone calls should never contain a number that
// could ring.
//
// THE DATASET IS DELIBERATELY MESSY. A fixture where everything is clean tests
// nothing: it proves the happy path and hides every gate. So this one contains,
// on purpose, a business with no official source, a phone number that came only
// from an aggregator, a duplicate of another record, a business with no phone
// at all, a premium-rate number, a short service number, an SEO lead-generation
// page pretending to be a locksmith, a record citing multiple sources without
// saying which fact came from where, and one whose source is unreadable. Each
// one exists to make a specific gate fire, and the tests name which.
//
// Pure + dep-free. See test/acquisition-discovery.test.js.

const { registerDiscoveryAdapter } = require("./acquisition-discovery");

const ADAPTER_NAME = "fixture-v1";

// A fixed observation date. Real discovery would stamp "when we saw this";
// a fixture must not move, or every hash and every freshness test drifts.
const OBSERVED_AT = "2026-07-15T02:00:00.000Z";

const MELBOURNE = { state: "VIC", region: "Melbourne", timezone: "Australia/Melbourne", country: "AU" };

/**
 * The fixture businesses.
 *
 * `expect` is documentation, not behaviour — it names the gate each record is
 * here to exercise, so a reader can tell at a glance why a deliberately broken
 * record exists. Tests assert against the real pipeline, never against `expect`.
 */
const FIXTURE_BUSINESSES = Object.freeze([
  // ── 1. The clean case ────────────────────────────────────────────
  // Official website + a government register entry, phone published on the
  // business's own site. This is what "ready to call" looks like.
  {
    businessName: "Northside Lock & Key",
    legalName: "Northside Lock and Key Pty Ltd",
    abn: "51 824 753 556",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    postcode: "3056",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 1042", label: "Published on the contact page" }],
    sourceRefs: [
      { url: "https://northsidelockandkey.example.com.au/contact" },
      { register: "ABR", identifier: "51 824 753 556" },
    ],
    evidenceSources: {
      business_name: { url: "https://northsidelockandkey.example.com.au/contact" },
      legal_name: { register: "ABR", identifier: "51 824 753 556" },
      abn: { register: "ABR", identifier: "51 824 753 556" },
      trade_category: { url: "https://northsidelockandkey.example.com.au/contact" },
      address: { url: "https://northsidelockandkey.example.com.au/contact" },
      phone: { url: "https://northsidelockandkey.example.com.au/contact" },
    },
    expect: "clean — passes review and, once washed, becomes eligible",
  },

  // ── 2. Phone from an aggregator only ─────────────────────────────
  // The business has its own site, but the only place we saw a NUMBER was a
  // third-party aggregator. This is the stale-number failure mode: aggregators
  // republish old numbers forever and have no correction path.
  {
    businessName: "Bayside Emergency Locksmiths",
    tradeCategory: "Locksmith",
    suburb: "Brighton",
    postcode: "3186",
    ...MELBOURNE,
    phones: [{ raw: "03 5550 2277", label: "Listed on Hotfrog" }],
    sourceRefs: [
      { url: "https://baysideemergencylocksmiths.example.com.au/" },
      { url: "https://www.hotfrog.com.au/company/bayside-emergency-locksmiths" },
    ],
    evidenceSources: {
      business_name: { url: "https://baysideemergencylocksmiths.example.com.au/" },
      trade_category: { url: "https://baysideemergencylocksmiths.example.com.au/" },
      address: { url: "https://www.hotfrog.com.au/company/bayside-emergency-locksmiths" },
      phone: { url: "https://www.hotfrog.com.au/company/bayside-emergency-locksmiths" },
    },
    expect: "phone_not_official gap — review must see that the number is unverified",
  },

  // ── 3. No official source at all ─────────────────────────────────
  {
    businessName: "Yarra Valley Security Services",
    tradeCategory: "Locksmith",
    suburb: "Lilydale",
    postcode: "3140",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 3311", label: "Directory listing" }],
    sourceRefs: [
      { url: "https://www.yellowpages.com.au/vic/lilydale/yarra-valley-security-services" },
      { url: "https://www.truelocal.com.au/business/yarra-valley-security-services/lilydale" },
    ],
    evidenceSources: {
      business_name: { url: "https://www.yellowpages.com.au/vic/lilydale/yarra-valley-security-services" },
      trade_category: { url: "https://www.yellowpages.com.au/vic/lilydale/yarra-valley-security-services" },
      address: { url: "https://www.truelocal.com.au/business/yarra-valley-security-services/lilydale" },
      phone: { url: "https://www.yellowpages.com.au/vic/lilydale/yarra-valley-security-services" },
    },
    expect: "no_official_source gap — directories only, never callable on this evidence",
  },

  // ── 4. A 1300 service number ─────────────────────────────────────
  {
    businessName: "CBD Lockworks",
    legalName: "CBD Lockworks Pty Ltd",
    abn: "29 002 589 460",
    tradeCategory: "Locksmith",
    suburb: "Melbourne",
    postcode: "3000",
    ...MELBOURNE,
    phones: [{ raw: "1300 975 707", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://cbdlockworks.example.com.au/contact" }],
    expect: "service-number classification — callable, but not a mobile or landline",
  },

  // ── 5. Mobile-only sole trader ───────────────────────────────────
  {
    businessName: "Melbourne Mobile Locksmith",
    tradeCategory: "Locksmith",
    suburb: "Coburg",
    postcode: "3058",
    ...MELBOURNE,
    phones: [{ raw: "0491 570 018", label: "Published on the home page" }],
    sourceRefs: [{ url: "https://melbournemobilelocksmith.example.com.au/" }],
    expect: "mobile classification — clean sole trader",
  },

  // ── 6. On the Do Not Call Register (see the A2 fixture register) ──
  {
    businessName: "Dandenong Lock Centre",
    legalName: "Dandenong Lock Centre Pty Ltd",
    abn: "63 176 288 049",
    tradeCategory: "Locksmith",
    suburb: "Dandenong",
    postcode: "3175",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 4488", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://dandenonglockcentre.example.com.au/contact" }],
    expect: "clean on evidence, but VETOed by the DNCR wash in A2",
  },

  // ── 7. A duplicate of #1, found somewhere else ───────────────────
  // Same business, different spelling, different source, different number
  // formatting. Dedupe must resolve this rather than calling them twice.
  {
    businessName: "Northside Lock and Key Pty Ltd",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    postcode: "3056",
    ...MELBOURNE,
    phones: [{ raw: "+61 3 5550 1042", label: "Directory listing" }],
    sourceRefs: [{ url: "https://www.localsearch.com.au/vic/brunswick/northside-lock-and-key" }],
    expect: "duplicate of #1 — same fingerprint and same normalised number",
  },

  // ── 8. A 13xxxx short number ─────────────────────────────────────
  {
    businessName: "Southbank Locksmiths",
    tradeCategory: "Locksmith",
    suburb: "Southbank",
    postcode: "3006",
    ...MELBOURNE,
    phones: [{ raw: "13 24 88", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://southbanklocksmiths.example.com.au/contact" }],
    expect: "short-number classification — not a callable prospect target",
  },

  // ── 9. No phone number published anywhere ────────────────────────
  {
    businessName: "Werribee Locks & Alarms",
    tradeCategory: "Locksmith",
    suburb: "Werribee",
    postcode: "3030",
    ...MELBOURNE,
    phones: [],
    sourceRefs: [{ url: "https://werribeelocksandalarms.example.com.au/" }],
    expect: "no_phone gap — nothing to call, so nothing to approve",
  },

  // ── 10. Already an AIDA client ───────────────────────────────────
  {
    businessName: "Frankston Safe & Lock",
    legalName: "Frankston Safe and Lock Pty Ltd",
    abn: "84 611 297 335",
    tradeCategory: "Locksmith",
    suburb: "Frankston",
    postcode: "3199",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 5521", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://frankstonsafeandlock.example.com.au/contact" }],
    expect: "suppressed as an existing client in A2",
  },

  // ── 11. Outside the pilot region ─────────────────────────────────
  {
    businessName: "Geelong Lock Pros",
    tradeCategory: "Locksmith",
    suburb: "Geelong",
    postcode: "3220",
    state: "VIC",
    region: "Geelong",
    timezone: "Australia/Melbourne",
    country: "AU",
    phones: [{ raw: "(03) 5550 6612", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://geelonglockpros.example.com.au/contact" }],
    expect: "outside the Melbourne pilot region — a reviewer decision, not an automatic block",
  },

  // ── 12. An SEO lead-generation page, not a business ──────────────
  // The name is a search phrase, the only sources are an aggregator and a
  // social page, and there is no register entry. A human should reject this.
  {
    businessName: "Locksmith Near Me 24/7 Melbourne",
    tradeCategory: "Locksmith",
    suburb: "Melbourne",
    postcode: "3000",
    ...MELBOURNE,
    phones: [{ raw: "1800 160 401", label: "Listed on the aggregator page" }],
    sourceRefs: [
      { url: "https://www.cylex.com.au/company/locksmith-near-me-24-7-melbourne" },
      { url: "https://www.facebook.com/locksmithnearme247melbourne" },
    ],
    evidenceSources: {
      business_name: { url: "https://www.cylex.com.au/company/locksmith-near-me-24-7-melbourne" },
      trade_category: { url: "https://www.cylex.com.au/company/locksmith-near-me-24-7-melbourne" },
      address: { url: "https://www.facebook.com/locksmithnearme247melbourne" },
      phone: { url: "https://www.cylex.com.au/company/locksmith-near-me-24-7-melbourne" },
    },
    expect: "no official source + aggregator-only — the reviewer's not_a_locksmith case",
  },

  // ── 13. A premium-rate number ────────────────────────────────────
  {
    businessName: "Ringwood Key & Safe",
    tradeCategory: "Locksmith",
    suburb: "Ringwood",
    postcode: "3134",
    ...MELBOURNE,
    phones: [{ raw: "1902 555 010", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://ringwoodkeyandsafe.example.com.au/contact" }],
    expect: "premium-rate classification — must never be dialled",
  },

  // ── 14. Multiple sources, no per-claim attribution ───────────────
  // Refused at discovery: with two sources and no statement of which fact came
  // from where, any attribution we made up would overstate our confidence.
  {
    businessName: "Essendon Lock Supply",
    tradeCategory: "Locksmith",
    suburb: "Essendon",
    postcode: "3040",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 7734", label: "Unclear which source" }],
    sourceRefs: [
      { url: "https://essendonlocksupply.example.com.au/" },
      { url: "https://www.hotfrog.com.au/company/essendon-lock-supply" },
    ],
    // evidenceSources deliberately absent
    expect: "rejected at discovery — claim_source_ambiguous",
  },

  // ── 15. An unreadable source ─────────────────────────────────────
  {
    businessName: "Sunshine Lock Repairs",
    tradeCategory: "Locksmith",
    suburb: "Sunshine",
    postcode: "3020",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 8899", label: "Unknown" }],
    sourceRefs: ["not a url at all"],
    expect: "rejected at discovery — candidate_unsourced",
  },

  // ── 16. Previously opted out ─────────────────────────────────────
  {
    businessName: "Altona Lock & Security",
    tradeCategory: "Locksmith",
    suburb: "Altona",
    postcode: "3018",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 9101", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://altonalockandsecurity.example.com.au/contact" }],
    expect: "clean on evidence, but permanently suppressed by a prior opt-out in A2",
  },
]);

/**
 * The adapter. `query` may narrow the dataset by suburb or by name so the dry
 * run and the tests can work with a subset; an unrecognised filter narrows to
 * nothing rather than silently returning everything (a filter that fails open
 * is how a "just these three" batch becomes the whole list).
 */
function run({ query = {} } = {}) {
  let out = FIXTURE_BUSINESSES.map((b) => ({ ...b, observedAt: OBSERVED_AT }));

  if (query && typeof query === "object") {
    if (typeof query.suburb === "string" && query.suburb.trim()) {
      const want = query.suburb.trim().toLowerCase();
      out = out.filter((b) => (b.suburb || "").toLowerCase() === want);
    }
    if (typeof query.namePrefix === "string" && query.namePrefix.trim()) {
      const want = query.namePrefix.trim().toLowerCase();
      out = out.filter((b) => (b.businessName || "").toLowerCase().startsWith(want));
    }
    if (Array.isArray(query.names)) {
      const want = new Set(query.names.map((n) => String(n).toLowerCase()));
      out = out.filter((b) => want.has((b.businessName || "").toLowerCase()));
    }
    if (typeof query.limit === "number" && Number.isInteger(query.limit) && query.limit >= 0) {
      out = out.slice(0, query.limit);
    }
  }

  // `expect` is a comment for humans; it must never reach the domain model.
  return out.map(({ expect, ...candidate }) => candidate);
}

registerDiscoveryAdapter(ADAPTER_NAME, {
  requiresNetwork: false,
  origin: "fixture",
  run,
});

module.exports = {
  ADAPTER_NAME,
  FIXTURE_BUSINESSES,
  OBSERVED_AT,
  run,
};
