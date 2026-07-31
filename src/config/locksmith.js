// AIDA Locksmith Receptionist — central product configuration (M1).
//
// The ONE place that owns every changeable value on the public locksmith page:
// names, demo number, pricing, pilot limit, trust details, CTA destinations and
// the two feature flags. Templates never hardcode any of these — the renderer
// (src/views/locksmith-page.js) is handed this object and nothing else.
//
// Founder-supplied details that do NOT exist yet (demo phone number, ABN,
// contact email, privacy/terms URLs) resolve to explicit PLACEHOLDER markers
// rather than invented values. The page renders them as visibly unresolved and
// unresolvedPlaceholders() lists them, so nothing fake can quietly ship.
//
// Flags — both dormant by default, both strict-parse (the D7 house rule: only
// the exact string "true" enables, so a sloppy env value can never switch a
// feature on). See docs/LOCKSMITH_PILOT_SPEC.md §5.
//   LOCKSMITH_PILOT_ENABLED    default OFF — the public page. Unset ⇒ both
//                              routes 404, byte-identical to this feature not
//                              existing. The product is a pilot that has not
//                              launched; it stays invisible until Peter turns
//                              it on deliberately.
//   LOCKSMITH_ENQUIRY_ENABLED  default OFF — enquiry submissions. M1 ships
//                              with NO persistence sink, so leaving this off
//                              is the correct production state.
//
// Pure + dep-free: nothing here touches the network, the DB or process state
// beyond reading env. See test/locksmith-config.test.js.

// Marker for a value the founder has not supplied yet. Rendered verbatim so an
// unresolved detail is obvious on the page itself, never mistaken for real.
const PLACEHOLDER_PREFIX = "TO BE CONFIRMED";

function placeholder(what) {
  return `[${PLACEHOLDER_PREFIX}: ${what}]`;
}

function isPlaceholder(value) {
  return typeof value === "string" && value.startsWith(`[${PLACEHOLDER_PREFIX}:`);
}

// ── Flags ───────────────────────────────────────────────────────────
// Page: off unless explicitly switched on (exact string "true").
function isLocksmithPilotEnabled(env = process.env) {
  return env.LOCKSMITH_PILOT_ENABLED === "true";
}

// Submissions: off unless explicitly switched on (exact string "true").
function isEnquiryFormEnabled(env = process.env) {
  return env.LOCKSMITH_ENQUIRY_ENABLED === "true";
}

// Client portal (M5): off unless explicitly switched on. Independent of the
// public page flag — the marketing shell and the authenticated portal are
// different surfaces with different risk, and turning one on must never turn
// the other on. Every portal route sits behind requireClientAuth as well, so
// this flag governs existence, not authorisation.
function isClientPortalEnabled(env = process.env) {
  return env.LOCKSMITH_PORTAL_ENABLED === "true";
}

// Router-level gate, same contract as voipRouterGate: next("router") exits the
// whole router so a disabled deploy 404s exactly as if the file did not exist.
function locksmithRouterGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isLocksmithPilotEnabled(env)) return next("router");
    next();
  };
}

// Same contract, for the M5 client portal.
function locksmithPortalGate(env = process.env) {
  return function gate(req, res, next) {
    if (!isClientPortalEnabled(env)) return next("router");
    next();
  };
}

// ── Static product facts (not env-tunable; changing these is a code change) ──
const PRODUCT_NAME = "AIDA Locksmith Receptionist";
const PROVIDER_NAME = "Niche Drops";
const PUBLIC_PATH = "/locksmith-receptionist";
const ENQUIRY_PATH = `${PUBLIC_PATH}/enquiry`;
const PORTAL_PATH = "/client/locksmith";

// Provisional founding-pilot pricing. Amounts are integers in whole dollars;
// the renderer formats them, so there is exactly one numeric source.
const DEFAULT_PRICING = {
  currency: "A$",
  setupAmount: 149,
  monthlyAmount: 299,
  includedDays: 14,
  // Deliberately not a number: the allowance is agreed per business at setup.
  usageAllowance: "Confirmed during setup",
  overage: "Confirmed during setup",
  commitment: "Month-to-month",
  provisional: true,
};

const DEFAULT_PILOT = {
  limit: 3,
  region: "Melbourne",
  audience: "locksmith businesses",
};

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Assembles the full config object handed to the renderer and the route.
// Every env var is optional — an unset var yields a placeholder, never a
// fabricated value.
function getLocksmithConfig(env = process.env) {
  const demoPhone = env.LOCKSMITH_DEMO_PHONE || placeholder("live demo number not yet provisioned");
  const contactEmail = env.LOCKSMITH_CONTACT_EMAIL || placeholder("Australian contact email");
  const abn = env.NICHE_DROPS_ABN || placeholder("Niche Drops ABN");
  const contactRegion = env.LOCKSMITH_CONTACT_REGION || "Melbourne, Victoria, Australia";
  const privacyUrl = env.NICHE_DROPS_PRIVACY_URL || placeholder("privacy policy URL");
  const termsUrl = env.NICHE_DROPS_TERMS_URL || placeholder("terms of service URL");

  return Object.freeze({
    productName: PRODUCT_NAME,
    providerName: PROVIDER_NAME,
    tagline: "Never lose another after-hours locksmith enquiry",
    publicPath: PUBLIC_PATH,
    enquiryPath: ENQUIRY_PATH,

    demoPhone,
    demoPhoneResolved: !isPlaceholder(demoPhone),

    pricing: Object.freeze({
      ...DEFAULT_PRICING,
      setupAmount: parsePositiveInt(env.LOCKSMITH_SETUP_PRICE, DEFAULT_PRICING.setupAmount),
      monthlyAmount: parsePositiveInt(env.LOCKSMITH_MONTHLY_PRICE, DEFAULT_PRICING.monthlyAmount),
      includedDays: parsePositiveInt(env.LOCKSMITH_INCLUDED_DAYS, DEFAULT_PRICING.includedDays),
    }),

    pilot: Object.freeze({
      ...DEFAULT_PILOT,
      limit: parsePositiveInt(env.LOCKSMITH_PILOT_LIMIT, DEFAULT_PILOT.limit),
      region: env.LOCKSMITH_PILOT_REGION || DEFAULT_PILOT.region,
    }),

    trust: Object.freeze({
      abn,
      contactEmail,
      contactRegion,
      privacyUrl,
      termsUrl,
      // Mandatory disclosures — plain statements of fact about the product,
      // rendered on every page load. Not env-tunable by design.
      aiDisclosure:
        `${PRODUCT_NAME} is an AI-powered phone receptionist, not a human operator. ` +
        "Callers are told they are speaking to an automated assistant.",
      rulesDisclosure:
        "Transfers, escalations and notifications follow the rules each locksmith " +
        "business configures during setup. AIDA does not decide them on its own.",
    }),

    cta: Object.freeze({
      demoLabel: "Call the live demo",
      pilotLabel: "Join the locksmith pilot",
      pilotAnchor: "#pilot-enquiry",
      // tel: link only when a real number exists; otherwise the CTA renders as
      // a non-interactive placeholder (see renderHero).
      demoHref: isPlaceholder(demoPhone) ? null : `tel:${demoPhone.replace(/[^\d+]/g, "")}`,
    }),

    portalPath: PORTAL_PATH,

    flags: Object.freeze({
      pageEnabled: isLocksmithPilotEnabled(env),
      enquiryEnabled: isEnquiryFormEnabled(env),
      portalEnabled: isClientPortalEnabled(env),
    }),
  });
}

// Everything the founder still has to supply. Reported at completion and
// surfaced in the spec doc so placeholders can't silently become permanent.
function unresolvedPlaceholders(config) {
  const candidates = [
    { key: "LOCKSMITH_DEMO_PHONE", label: "Live demo phone number", value: config.demoPhone },
    { key: "NICHE_DROPS_ABN", label: "Niche Drops ABN", value: config.trust.abn },
    { key: "LOCKSMITH_CONTACT_EMAIL", label: "Australian contact email", value: config.trust.contactEmail },
    { key: "NICHE_DROPS_PRIVACY_URL", label: "Privacy policy URL", value: config.trust.privacyUrl },
    { key: "NICHE_DROPS_TERMS_URL", label: "Terms of service URL", value: config.trust.termsUrl },
  ];
  return candidates.filter((c) => isPlaceholder(c.value));
}

module.exports = {
  getLocksmithConfig,
  isLocksmithPilotEnabled,
  isEnquiryFormEnabled,
  isClientPortalEnabled,
  locksmithRouterGate,
  locksmithPortalGate,
  unresolvedPlaceholders,
  isPlaceholder,
  PLACEHOLDER_PREFIX,
  PRODUCT_NAME,
  PROVIDER_NAME,
  PUBLIC_PATH,
  ENQUIRY_PATH,
  PORTAL_PATH,
};
