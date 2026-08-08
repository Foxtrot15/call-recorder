// AIDA Locksmith Acquisition — official business source identification (A1).
//
//   classifySource(reference)        one reference → a typed, ranked source
//   summariseSources(references)     many → which one is primary, and why
//
// The pipeline's second step is "official business source identified". This
// module is what decides whether that step has actually happened, and it does
// so WITHOUT TOUCHING THE NETWORK: classification is a function of the
// reference string alone. No fetch, no HEAD request, no DNS lookup, no
// robots.txt read. See src/config/acquisition.js for why that boundary is a
// hardcoded constant rather than a flag.
//
// WHY SOURCE TIER IS A FIRST-CLASS CONCEPT
// A phone number copied from an aggregator is the single most common way an
// outbound system dials a number that was reassigned two years ago, or a
// business that has closed. Aggregators re-publish stale data indefinitely and
// have no correction path. So the domain model refuses to let an aggregator be
// the only thing standing behind a call: OFFICIAL_SOURCE_TYPES (the business's
// own site, or a government register) is a hard requirement enforced at review
// (acquisition-review.js) and again at eligibility (acquisition-eligibility.js).
//
// A weak source is never an error here. It is recorded, tiered, and reported —
// the human decides. This module's job is to make the tier impossible to
// overlook, not to throw things away.
//
// Pure + dep-free. See test/acquisition-source.test.js.

const S = require("./acquisition-schema");

// ── Host tables ─────────────────────────────────────────────────────
//
// Curated, deliberately small, and matched on the REGISTRABLE DOMAIN so that
// `www.` / `m.` / arbitrary subdomains cannot be used to dodge a table entry.
// Unknown hosts are not assumed hostile — they fall through to "the business's
// own site", which is the common and correct case for a locksmith with a
// domain of their own.

const GOVERNMENT_REGISTER_HOSTS = Object.freeze([
  "abr.business.gov.au",
  "abr.gov.au",
  "asic.gov.au",
  "connectonline.asic.gov.au",
  "business.gov.au",
  "abn.business.gov.au",
]);

const SOCIAL_HOSTS = Object.freeze([
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "nextdoor.com",
]);

const MAP_HOSTS = Object.freeze([
  "maps.google.com",
  "goo.gl",
  "maps.app.goo.gl",
  "google.com", // only when the path is a maps path — see classifyHost
  "bing.com",
  "apple.com",
  "here.com",
]);

// Directories that verify something real about a trader (ABN, licence,
// insurance) before listing them. Still not official — a verified directory is
// a third party's assertion, not the business's own — but materially better
// evidence than a scraped aggregator.
const VERIFIED_DIRECTORY_HOSTS = Object.freeze([
  "hipages.com.au",
  "oneflare.com.au",
  "serviceseeking.com.au",
  "airtasker.com",
  "masterlocksmiths.com.au", // trade association member directory
  "mla.com.au",
]);

const UNVERIFIED_DIRECTORY_HOSTS = Object.freeze([
  "yellowpages.com.au",
  "truelocal.com.au",
  "localsearch.com.au",
  "startlocal.com.au",
  "aussieweb.com.au",
  "yelp.com",
  "yelp.com.au",
  "womo.com.au",
  "wordofmouth.com.au",
]);

// Compiled listing sites that republish other people's data with no correction
// path. The weakest tier that is still a recognisable source.
const AGGREGATOR_HOSTS = Object.freeze([
  "hotfrog.com.au",
  "hotfrog.com",
  "cylex.com.au",
  "cylex-australia.com",
  "brownbook.net",
  "cybo.com",
  "tuugo.biz",
  "purelocal.com.au",
  "australiayp.com",
  "au.enrollbusiness.com",
  "fyple.biz",
  "opendi.com.au",
]);

// Website builders that hand out a subdomain of THEIR domain. The page really
// may be the business's own, but the domain is not evidence of that, so these
// are classified as official-website-with-a-caveat rather than silently trusted.
const SITE_BUILDER_HOSTS = Object.freeze([
  "wixsite.com",
  "business.site",
  "weebly.com",
  "godaddysites.com",
  "squarespace.com",
  "myshopify.com",
  "webs.com",
  "wordpress.com",
  "blogspot.com",
  "netlify.app",
  "github.io",
]);

// Multi-label public suffixes we care about. Australia's registrable domains
// are three labels (`example.com.au`), so a naive "last two labels" rule would
// treat `com.au` as the registrable domain and collapse every Australian site
// into one bucket.
const MULTI_LABEL_SUFFIXES = Object.freeze([
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "asn.au", "id.au", "csiro.au",
  "co.uk", "org.uk", "co.nz", "net.nz", "org.nz", "co.za",
]);

// ── Reference parsing ───────────────────────────────────────────────

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Host + path from a reference string, without throwing on rubbish.
 * Accepts bare hosts ("example.com.au/contact") as well as full URLs.
 */
function parseReference(raw) {
  const value = lower(raw);
  if (!value) return null;

  // A bare host has no scheme; give it one so URL can parse it. Anything with a
  // scheme we do not understand (mailto:, tel:, javascript:) is rejected.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/.test(value);
  if (hasScheme && !/^https?:\/\//.test(value)) return null;

  let url;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (!host || !host.includes(".")) return null;
  // Reject IP literals and localhost — never a business's published source.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "localhost") return null;

  return { host, path: url.pathname || "/", search: url.search || "", url: url.href };
}

/** The registrable domain, honouring multi-label public suffixes. */
function registrableDomain(host) {
  const labels = host.split(".");
  for (const suffix of MULTI_LABEL_SUFFIXES) {
    const parts = suffix.split(".");
    if (labels.length > parts.length && labels.slice(-parts.length).join(".") === suffix) {
      return labels.slice(-(parts.length + 1)).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

function inTable(domain, host, table) {
  return table.some((entry) => domain === entry || host === entry || host.endsWith(`.${entry}`));
}

// ── Classification ──────────────────────────────────────────────────

/**
 * Decide the source type for a parsed host+path. Order matters: the most
 * specific and most consequential tables are consulted first.
 */
function classifyHost(host, path) {
  const domain = registrableDomain(host);

  if (inTable(domain, host, GOVERNMENT_REGISTER_HOSTS)) return { sourceType: "government_register", caveats: [] };

  // Maps live under general-purpose domains, so the path decides.
  const looksLikeMaps = /^\/maps(\/|$)/.test(path) || host.startsWith("maps.");
  if (inTable(domain, host, MAP_HOSTS)) {
    if (looksLikeMaps || host.startsWith("maps.") || domain === "here.com") {
      return { sourceType: "map_listing", caveats: [] };
    }
    // google.com/something-else is not a source we recognise at all.
    return { sourceType: "unknown", caveats: ["This link is not a business listing we recognise."] };
  }

  if (inTable(domain, host, SOCIAL_HOSTS)) return { sourceType: "social_profile", caveats: [] };
  if (inTable(domain, host, VERIFIED_DIRECTORY_HOSTS)) return { sourceType: "verified_directory", caveats: [] };
  if (inTable(domain, host, UNVERIFIED_DIRECTORY_HOSTS)) return { sourceType: "unverified_directory", caveats: [] };
  if (inTable(domain, host, AGGREGATOR_HOSTS)) return { sourceType: "aggregator", caveats: [] };

  if (inTable(domain, host, SITE_BUILDER_HOSTS)) {
    return {
      sourceType: "official_website",
      caveats: [
        "This page is on a shared website-builder domain, so the web address alone does not prove it belongs to this business. Confirm the business name on the page.",
      ],
    };
  }

  // A registrable domain nobody has flagged: treat as the business's own site.
  // This is the common, correct case for a trading locksmith.
  return { sourceType: "official_website", caveats: [] };
}

/**
 * Classify one source reference.
 *
 * Accepts either a URL/host string, or an object:
 *   { url }                                   a web reference
 *   { register, identifier }                  a government register record
 *   { sourceType, label }                     an operator's explicit declaration
 *
 * Returns { ok, sourceType, official, authorityRank, host, domain, url,
 *           label, caveats, reason }
 * or { ok:false, code, message } when the reference cannot be understood.
 * Never throws on bad input — an unparseable source is a finding, not a crash.
 */
function classifySource(reference) {
  if (!reference) {
    return { ok: false, code: "source_missing", message: "No source was given for this business." };
  }

  // A government register record, referenced by identifier rather than a URL.
  if (typeof reference === "object" && !Array.isArray(reference) && reference.register) {
    const register = lower(reference.register);
    const identifier = typeof reference.identifier === "string" ? reference.identifier.trim() : "";
    if (!identifier) {
      return { ok: false, code: "register_identifier_missing", message: `A ${reference.register} record was cited with no identifier.` };
    }
    return finalise({
      sourceType: "government_register",
      host: null,
      domain: null,
      url: null,
      label: `${String(reference.register).trim()} record ${identifier}`,
      caveats: [],
      reason: "Cited as a government business register record.",
      register,
      identifier,
    });
  }

  // An operator declaring a source type directly, with no machine-checkable
  // reference. Honoured only for types that cannot be officially claimed —
  // declaring "official_website" without a URL is exactly the unverifiable
  // assertion this pipeline exists to prevent.
  if (typeof reference === "object" && !Array.isArray(reference) && reference.sourceType && !reference.url) {
    const declared = lower(reference.sourceType);
    if (!S.SOURCE_TYPES.includes(declared)) {
      return { ok: false, code: "source_type_unknown", message: `"${String(reference.sourceType).slice(0, 40)}" is not a source type this system understands.` };
    }
    if (S.OFFICIAL_SOURCE_TYPES.includes(declared)) {
      return {
        ok: false,
        code: "official_source_needs_reference",
        message: "An official source has to come with a web address or a register identifier — it cannot just be asserted.",
      };
    }
    return finalise({
      sourceType: declared,
      host: null,
      domain: null,
      url: null,
      label: typeof reference.label === "string" && reference.label.trim() ? reference.label.trim() : S.SOURCE_TYPE_LABELS[declared],
      caveats: ["Declared by an operator with no link to check."],
      reason: "Declared directly by an operator.",
    });
  }

  const raw = typeof reference === "string" ? reference : reference.url;
  const parsed = parseReference(raw);
  if (!parsed) {
    return { ok: false, code: "source_unparseable", message: `"${String(raw ?? "").slice(0, 60)}" is not a web address this system can read.` };
  }

  const { sourceType, caveats } = classifyHost(parsed.host, parsed.path);
  const domain = registrableDomain(parsed.host);

  // A bare homepage on an aggregator/directory is a link to the SITE, not to
  // this business's listing on it — worthless as evidence about one business.
  const extraCaveats = [...caveats];
  if (parsed.path === "/" && !S.OFFICIAL_SOURCE_TYPES.includes(sourceType) && sourceType !== "unknown") {
    extraCaveats.push("This link points at the site's front page, not at this business's own listing.");
  }

  /**
   * A CALLER MAY DECLARE ITSELF LESS AUTHORITATIVE, NEVER MORE (M8G).
   *
   * Host classification cannot know everything. A CSV import knows for certain
   * that its rows came from a map listing, but the listing URLs carry hostnames
   * this table has never seen — and an unrecognised host falls through to
   * `official_website`, which is the most authoritative classification there is.
   *
   * That is how an imported directory phone number came to be recorded as
   * having come from the business's own website, with `official: true` and
   * `authoritative: true`. `phoneFromOfficialSource` then reported a directory
   * number as officially sourced, which removes a review gap that should exist.
   * It failed OPEN, which is the wrong direction for a source-authority rule.
   *
   * So a declared type is honoured when it is WEAKER than what the host
   * suggests. The asymmetry is the safety property: lowering your own authority
   * can only ever add caution, while raising it is the unverifiable assertion
   * the block above already refuses. An operator saying "this is only a map
   * listing" is telling us something true that we could not otherwise know.
   */
  let effectiveType = sourceType;
  const declaredWithUrl = typeof reference === "object" && !Array.isArray(reference) ? lower(reference.sourceType) : null;
  if (declaredWithUrl && S.SOURCE_TYPES.includes(declaredWithUrl)) {
    const declaredRank = S.SOURCE_AUTHORITY_ORDER.indexOf(declaredWithUrl);
    const hostRank = S.SOURCE_AUTHORITY_ORDER.indexOf(sourceType);
    // SOURCE_AUTHORITY_ORDER runs strongest-first, so a HIGHER index is weaker.
    if (declaredRank > hostRank) {
      effectiveType = declaredWithUrl;
      extraCaveats.push(`The importer declared this a ${S.SOURCE_TYPE_LABELS[declaredWithUrl] || declaredWithUrl}, which is weaker than the web address alone would suggest.`);
    }
  }

  return finalise({
    sourceType: effectiveType,
    host: parsed.host,
    domain,
    url: parsed.url,
    label: domain,
    caveats: extraCaveats,
    reason: effectiveType === sourceType ? `Classified from the web address ${domain}.` : `Declared as ${effectiveType} by the importer; the web address ${domain} alone would have suggested ${sourceType}.`,
  });
}

function finalise(fields) {
  const rank = S.SOURCE_AUTHORITY_ORDER.indexOf(fields.sourceType);
  return Object.freeze({
    ok: true,
    sourceType: fields.sourceType,
    typeLabel: S.SOURCE_TYPE_LABELS[fields.sourceType],
    official: S.OFFICIAL_SOURCE_TYPES.includes(fields.sourceType),
    // Lower is stronger. -1 would sort a broken type to the front, so an
    // unrecognised type is pushed to the back explicitly.
    authorityRank: rank === -1 ? S.SOURCE_AUTHORITY_ORDER.length : rank,
    host: fields.host || null,
    domain: fields.domain || null,
    url: fields.url || null,
    register: fields.register || null,
    identifier: fields.identifier || null,
    label: fields.label,
    caveats: Object.freeze(fields.caveats || []),
    reason: fields.reason,
  });
}

/**
 * Classify a list of references and work out which is primary.
 *
 * "Primary" is the strongest source available, and the pipeline's official
 * source requirement is satisfied only if at least one source is `official`.
 * Returns the rejected references too — a reference nobody could parse is a
 * data-quality signal that belongs in the review packet, not in a swallowed
 * catch block.
 */
function summariseSources(references) {
  const list = Array.isArray(references) ? references : references ? [references] : [];
  const classified = [];
  const unusable = [];

  for (const ref of list) {
    const result = classifySource(ref);
    if (result.ok) classified.push(result);
    else unusable.push({ reference: typeof ref === "string" ? ref : ref && ref.url ? ref.url : "(unreadable)", code: result.code, message: result.message });
  }

  const sorted = [...classified].sort((a, b) => a.authorityRank - b.authorityRank);
  const primary = sorted[0] || null;
  const official = sorted.find((s) => s.official) || null;

  return Object.freeze({
    sources: Object.freeze(sorted),
    unusable: Object.freeze(unusable),
    primary,
    // The gate the rest of the pipeline reads.
    hasOfficialSource: Boolean(official),
    officialSource: official,
    strongestType: primary ? primary.sourceType : null,
    // Everything a reviewer should be told about source quality, flattened.
    caveats: Object.freeze(sorted.flatMap((s) => s.caveats.map((c) => ({ sourceType: s.sourceType, label: s.label, caveat: c })))),
  });
}

/**
 * One plain-language sentence about the source position, for the review packet
 * and the eligibility explanation. Written for a founder, not an engineer.
 */
function describeSources(summary) {
  // Defensive about its own input: this string is rendered to a founder mid
  // decision, so a malformed summary must produce the most conservative
  // sentence available, never a crash and never an optimistic one.
  if (!summary || !Array.isArray(summary.sources) || summary.sources.length === 0) {
    return "We have no source at all for this business.";
  }
  if (summary.hasOfficialSource) {
    const s = summary.officialSource;
    return s.sourceType === "government_register"
      ? `Confirmed against a government business register (${s.label}).`
      : `Confirmed from the business's own website (${s.label}).`;
  }
  const strongest = summary.primary;
  return (
    `The only sources we have are third-party listings — the strongest is ${S.SOURCE_TYPE_LABELS[strongest.sourceType].toLowerCase()}` +
    `${strongest.label ? ` (${strongest.label})` : ""}. We have not found this business's own website or a government register entry.`
  );
}

module.exports = {
  classifySource,
  summariseSources,
  describeSources,
  // exported for tests and for reuse by the evidence layer
  parseReference,
  registrableDomain,
  GOVERNMENT_REGISTER_HOSTS,
  SOCIAL_HOSTS,
  VERIFIED_DIRECTORY_HOSTS,
  UNVERIFIED_DIRECTORY_HOSTS,
  AGGREGATOR_HOSTS,
  SITE_BUILDER_HOSTS,
};
