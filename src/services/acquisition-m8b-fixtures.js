// AIDA Locksmith Acquisition — the M8B adversarial fixture set.
//
//   const { registerM8bFixtureAdapter, M8B_ADAPTER_NAME } = require(...)
//   registerM8bFixtureAdapter()
//
// A second deterministic dataset, separate from the A1 fixture, built to make
// the M8B gates fire: qualification, the queue, timezone differences, a
// state-specific public holiday, an opt-out and a re-import of the business
// that opted out.
//
// ── WHY IT IS A SEPARATE MODULE, AND WHY IT DOES NOT SELF-REGISTER ──
// `test/acquisition-discovery.test.js` asserts the adapter registry is exactly
// `["fixture-v1"]` — a real property worth keeping, because a build that has
// quietly acquired a second discovery source is exactly the thing that
// assertion is watching for. Registering on require would break it from three
// files away, which is the kind of failure that gets "fixed" by weakening the
// assertion.
//
// So registration is an explicit call. The walkthrough and this module's own
// test make it; nothing else does.
//
// The A1 fixture is also left completely untouched: its record count and its
// specific gaps are asserted across several test files, and extending it to
// cover M8B would have meant editing those assertions to accommodate new data —
// which is how a fixture stops proving anything.
//
// ── EVERY BUSINESS IS INVENTED AND EVERY NUMBER IS UNREACHABLE ──────
// Geographic numbers are of the form (0X) 5550 XXXX and mobiles are in the
// 0491 570 XXX block — the ranges the ACMA reserves for fiction. Service
// numbers use the 1300 555 XXX pattern. Domains are under RFC 2606's reserved
// `example.*`. A fixture in a system that will one day place calls must not
// contain a number that could ring, and a test asserts it.
//
// Pure + dep-free. See test/acquisition-m8b-fixtures.test.js.

const { registerDiscoveryAdapter } = require("./acquisition-discovery");

const M8B_ADAPTER_NAME = "m8b-walkthrough-v1";

// Fixed, like the A1 fixture's: a moving observation date would drift every
// hash and every freshness assertion.
const OBSERVED_AT = "2026-07-20T02:00:00.000Z";

const MELBOURNE = { state: "VIC", region: "Melbourne", timezone: "Australia/Melbourne", country: "AU" };
const PERTH = { state: "WA", region: "Perth", timezone: "Australia/Perth", country: "AU" };
const SYDNEY = { state: "NSW", region: "Sydney", timezone: "Australia/Sydney", country: "AU" };

// PER-CLAIM ATTRIBUTION, BUILT RATHER THAN TYPED.
//
// A candidate citing more than one source must say which source EVERY claim
// came from, or acquisition-discovery refuses it outright (`claim_source_
// ambiguous`). The claims it derives are fixed — business_name, legal_name,
// abn, trade_category, address, phone — so writing the map by hand means
// silently dropping `address` on seven records and discovering it as seven
// rejected candidates. This builds the whole map from the two sources.
//
// Note what is NOT here: `service_area` and `operating_status`. The discovery
// contract does not derive those claims, so declaring a source for them would
// promise evidence that is never written. They stay genuinely unknown, and the
// qualification engine reports them as such rather than being handed a fiction.
function attribute({ site, register = null }) {
  const fromSite = { url: site };
  const fromRegister = register ? { register: "ABR", identifier: register } : fromSite;
  return {
    business_name: fromSite,
    legal_name: fromRegister,
    abn: fromRegister,
    trade_category: fromSite,
    address: fromSite,
    phone: fromSite,
  };
}

/**
 * `expect` is documentation, never behaviour — it names the gate each record
 * exists to exercise. Tests assert against the real pipeline, never against it.
 */
const M8B_BUSINESSES = Object.freeze([
  // ── 1. The high-value qualified prospect ─────────────────────────
  // Everything present: own site, register entry, emergency work, a service
  // number, several lines, a wide service area. This is what "approach this one
  // first" looks like, and it is deliberately NOT a sole operator — a bigger
  // locksmith takes more calls and is a better AIDA customer, not a worse one.
  {
    businessName: "Brunswick Rapid Locksmiths",
    legalName: "Brunswick Rapid Locksmiths Pty Ltd",
    abn: "62 914 337 201",
    tradeCategory: "Locksmith — 24 hour emergency lockouts, rekeying, deadlocks",
    suburb: "Brunswick",
    postcode: "3056",
    ...MELBOURNE,
    phones: [
      { raw: "(03) 5550 1180", label: "Published on the contact page" },
      { raw: "1300 555 118", label: "Published on the contact page" },
    ],
    sourceRefs: [{ url: "https://brunswickrapidlocksmiths.example.com.au/contact" }, { register: "ABR", identifier: "62 914 337 201" }],
    evidenceSources: attribute({ site: "https://brunswickrapidlocksmiths.example.com.au/contact", register: "62 914 337 201" }),
    serviceArea: "Brunswick, Coburg, Preston, Northcote, Fitzroy, Carlton, Thornbury",
    expect: "priority tier — the strongest record in the set",
  },

  // ── 2. A sole operator, and still a good customer ────────────────
  // Mobile only, one person, emergency callouts. The AIDA pitch in one record:
  // whoever answers is also the person driving to the job.
  {
    businessName: "Ash Cordero Mobile Locksmith",
    abn: "77 402 118 663",
    tradeCategory: "Locksmith — emergency lockouts, mobile service",
    suburb: "Coburg",
    postcode: "3058",
    ...MELBOURNE,
    phones: [{ raw: "0491 570 221", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://ashcorderolocksmith.example.com.au/" }, { register: "ABR", identifier: "77 402 118 663" }],
    evidenceSources: attribute({ site: "https://ashcorderolocksmith.example.com.au/", register: "77 402 118 663" }),
    expect: "qualifies — a sole operator is a target, not an exclusion",
  },

  // ── 3. The duplicate, with the same number formatted differently ─
  // Same business as #1, discovered again with the number written another way
  // and the corporate suffix dropped. Normalisation has to happen BEFORE the
  // comparison or these look like two businesses and both get called.
  {
    businessName: "Brunswick Rapid Locksmiths Pty Ltd",
    abn: "62 914 337 201",
    tradeCategory: "Locksmith",
    suburb: "Brunswick",
    postcode: "3056",
    ...MELBOURNE,
    phones: [{ raw: "+61 3 5550 1180", label: "Listed in a trade directory" }],
    sourceRefs: [{ url: "https://www.yellowpages.com.au/vic/brunswick/brunswick-rapid-locksmiths" }],
    evidenceSources: {
      business_name: { url: "https://www.yellowpages.com.au/vic/brunswick/brunswick-rapid-locksmiths" },
      abn: { url: "https://www.yellowpages.com.au/vic/brunswick/brunswick-rapid-locksmiths" },
      trade_category: { url: "https://www.yellowpages.com.au/vic/brunswick/brunswick-rapid-locksmiths" },
      phone: { url: "https://www.yellowpages.com.au/vic/brunswick/brunswick-rapid-locksmiths" },
    },
    expect: "duplicate of #1 — same normalised number and same ABN",
  },

  // ── 4. Interstate: Perth, two hours behind Melbourne ─────────────
  // Exists to prove calling hours are checked in the BUSINESS's local time. At
  // 09:30 in Melbourne it is 07:30 here, and this locksmith must not be called.
  {
    businessName: "Fremantle Coast Locksmiths",
    abn: "38 771 620 449",
    tradeCategory: "Locksmith — emergency lockouts and rekeying",
    suburb: "Fremantle",
    postcode: "6160",
    ...PERTH,
    phones: [{ raw: "(08) 5550 4410", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://fremantlecoastlocksmiths.example.com.au/contact" }, { register: "ABR", identifier: "38 771 620 449" }],
    evidenceSources: attribute({ site: "https://fremantlecoastlocksmiths.example.com.au/contact", register: "38 771 620 449" }),
    expect: "timezone — callable in Perth hours, not Melbourne hours",
  },

  // ── 5. Interstate: Sydney, same timezone, different holidays ─────
  // Paired with the Melbourne records to prove a VIC-only public holiday
  // (Melbourne Cup Day) blocks Victoria and leaves New South Wales alone.
  {
    businessName: "Inner West Lock & Key",
    abn: "45 220 984 117",
    tradeCategory: "Locksmith — commercial and residential",
    suburb: "Newtown",
    postcode: "2042",
    ...SYDNEY,
    phones: [{ raw: "(02) 5550 7730", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://innerwestlockandkey.example.com.au/contact" }, { register: "ABR", identifier: "45 220 984 117" }],
    evidenceSources: attribute({ site: "https://innerwestlockandkey.example.com.au/contact", register: "45 220 984 117" }),
    expect: "holiday scope — unaffected by a Victorian public holiday",
  },

  // ── 6. On the Do Not Call Register ───────────────────────────────
  // Nothing wrong with the record. That is the point: the only thing stopping
  // this call is the wash, and the wash has to be consulted to know it.
  {
    businessName: "Werribee Lock Centre",
    abn: "29 663 447 902",
    tradeCategory: "Locksmith — automotive and residential",
    suburb: "Werribee",
    postcode: "3030",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 9021", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://werribeelockcentre.example.com.au/contact" }, { register: "ABR", identifier: "29 663 447 902" }],
    evidenceSources: attribute({ site: "https://werribeelockcentre.example.com.au/contact", register: "29 663 447 902" }),
    expect: "blocked by the DNC Register — a clean record is not permission",
  },

  // ── 7. Never washed ──────────────────────────────────────────────
  // The fail-closed case. Unknown must not resolve to "probably fine".
  {
    businessName: "Dandenong Ranges Locksmiths",
    abn: "84 115 730 288",
    tradeCategory: "Locksmith — residential",
    suburb: "Belgrave",
    postcode: "3160",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 6104", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://dandenongrangeslocksmiths.example.com.au/contact" }, { register: "ABR", identifier: "84 115 730 288" }],
    evidenceSources: attribute({ site: "https://dandenongrangeslocksmiths.example.com.au/contact", register: "84 115 730 288" }),
    expect: "DNCR state unknown — must fail closed, never be assumed clear",
  },

  // ── 8. Already opted out, before this run ────────────────────────
  // Seeded into the suppression list at the start of the walkthrough. Present
  // so the ordinary path proves it is skipped, before the re-import proves it
  // stays skipped.
  {
    businessName: "Altona Bay Locksmiths",
    abn: "91 508 224 776",
    tradeCategory: "Locksmith — emergency lockouts",
    suburb: "Altona",
    postcode: "3018",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 3390", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://altonabaylocksmiths.example.com.au/contact" }, { register: "ABR", identifier: "91 508 224 776" }],
    evidenceSources: attribute({ site: "https://altonabaylocksmiths.example.com.au/contact", register: "91 508 224 776" }),
    expect: "suppressed before this run — must never be selected",
  },

  // ── 9. The locksmith we will call, who then opts out ─────────────
  // The walkthrough calls this one, records an opt-out, and then re-discovers
  // it. It exists to be the subject of the re-import proof.
  {
    businessName: "Preston Key & Safe",
    abn: "53 337 901 664",
    tradeCategory: "Locksmith — safes, rekeying, emergency lockouts",
    suburb: "Preston",
    postcode: "3072",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 2287", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://prestonkeyandsafe.example.com.au/contact" }, { register: "ABR", identifier: "53 337 901 664" }],
    evidenceSources: attribute({ site: "https://prestonkeyandsafe.example.com.au/contact", register: "53 337 901 664" }),
    expect: "the opt-out subject — called, opts out, then re-imported",
  },

  // ── 10. The re-import, with the name and number reformatted ──────
  // Exactly what a second data drop three months later looks like: the same
  // business, spelled differently, punctuated differently, arriving fresh with
  // no memory of the conversation. Suppression is keyed on the normalised
  // identity, so it must still be caught.
  {
    businessName: "Preston Key and Safe Pty Ltd",
    abn: "53 337 901 664",
    tradeCategory: "Locksmith",
    suburb: "Preston",
    postcode: "3072",
    ...MELBOURNE,
    phones: [{ raw: "03-5550-2287", label: "Listed in a trade directory" }],
    sourceRefs: [{ url: "https://prestonkeyandsafe.example.com.au/" }],
    evidenceSources: {
      business_name: { url: "https://prestonkeyandsafe.example.com.au/" },
      abn: { url: "https://prestonkeyandsafe.example.com.au/" },
      trade_category: { url: "https://prestonkeyandsafe.example.com.au/" },
      phone: { url: "https://prestonkeyandsafe.example.com.au/" },
    },
    reimportOf: "Preston Key & Safe",
    expect: "re-import of the opted-out business — must stay suppressed",
  },

  // ── 11. Looks like a locksmith, is not one ───────────────────────
  // "Lockyer" contains "lock" and this is a plumber. Substring matching
  // qualifies it; whole-word matching does not.
  {
    businessName: "Lockyer & Sons Plumbing",
    abn: "16 889 305 412",
    tradeCategory: "Plumbing and gas fitting",
    suburb: "Reservoir",
    postcode: "3073",
    ...MELBOURNE,
    phones: [{ raw: "(03) 5550 5512", label: "Published on the contact page" }],
    sourceRefs: [{ url: "https://lockyerandsonsplumbing.example.com.au/contact" }],
    evidenceSources: {
      business_name: { url: "https://lockyerandsonsplumbing.example.com.au/contact" },
      trade_category: { url: "https://lockyerandsonsplumbing.example.com.au/contact" },
      phone: { url: "https://lockyerandsonsplumbing.example.com.au/contact" },
    },
    expect: "not a locksmith — ruled out despite the name",
  },

  // ── 12. A lead-resale funnel ─────────────────────────────────────
  // Advertises locksmith work convincingly. Calling it reaches a broker.
  {
    businessName: "Find A Locksmith Melbourne",
    tradeCategory: "Locksmith — 24/7 emergency, all suburbs",
    suburb: "Melbourne",
    postcode: "3000",
    ...MELBOURNE,
    phones: [{ raw: "1300 555 664", label: "Listed on the landing page" }],
    sourceRefs: [{ url: "https://www.find-a-locksmith.example.com/melbourne" }],
    evidenceSources: {
      business_name: { url: "https://www.find-a-locksmith.example.com/melbourne" },
      trade_category: { url: "https://www.find-a-locksmith.example.com/melbourne" },
      phone: { url: "https://www.find-a-locksmith.example.com/melbourne" },
    },
    expect: "lead-generation page — ruled out",
  },

  // ── 13. An unusable number ───────────────────────────────────────
  // A premium-rate line. It is a number, and dialling it would cost the
  // RECIPIENT money, which is why "has a number" is not the same as "callable".
  {
    businessName: "Southbank Emergency Lock Service",
    tradeCategory: "Locksmith — emergency",
    suburb: "Southbank",
    postcode: "3006",
    ...MELBOURNE,
    phones: [{ raw: "1902 555 330", label: "Listed on the landing page" }],
    sourceRefs: [{ url: "https://southbankemergencylock.example.com.au/" }],
    evidenceSources: {
      business_name: { url: "https://southbankemergencylock.example.com.au/" },
      trade_category: { url: "https://southbankemergencylock.example.com.au/" },
      phone: { url: "https://southbankemergencylock.example.com.au/" },
    },
    expect: "premium-rate number — never dialable",
  },
]);

/** Look one up by name, for the walkthrough's narrative steps. */
function m8bBusiness(businessName) {
  return M8B_BUSINESSES.find((b) => b.businessName === businessName) || null;
}

function run({ query = {} } = {}) {
  let out = M8B_BUSINESSES.map((b) => ({ ...b, observedAt: OBSERVED_AT }));

  if (query && typeof query === "object") {
    if (Array.isArray(query.names)) {
      const want = new Set(query.names.map((n) => String(n).toLowerCase()));
      out = out.filter((b) => want.has((b.businessName || "").toLowerCase()));
    }
    if (Array.isArray(query.exclude)) {
      const skip = new Set(query.exclude.map((n) => String(n).toLowerCase()));
      out = out.filter((b) => !skip.has((b.businessName || "").toLowerCase()));
    }
    if (typeof query.state === "string" && query.state.trim()) {
      const want = query.state.trim().toUpperCase();
      out = out.filter((b) => b.state === want);
    }
    if (Number.isInteger(query.limit) && query.limit >= 0) out = out.slice(0, query.limit);
  }

  // `expect` and `reimportOf` are notes for humans; they must never reach the
  // domain model, which would otherwise be able to read its own answer key.
  return out.map(({ expect, reimportOf, serviceArea, ...candidate }) => candidate);
}

/**
 * Register the adapter. Explicit, never on require — see the header.
 * Idempotent, so a walkthrough and a test in the same process do not conflict.
 */
function registerM8bFixtureAdapter() {
  registerDiscoveryAdapter(M8B_ADAPTER_NAME, {
    requiresNetwork: false,
    origin: "fixture",
    run,
  });
  return M8B_ADAPTER_NAME;
}

module.exports = {
  M8B_ADAPTER_NAME,
  M8B_BUSINESSES,
  OBSERVED_AT,
  registerM8bFixtureAdapter,
  m8bBusiness,
  run,
};
