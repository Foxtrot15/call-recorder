// AIDA Locksmith Acquisition — source import profiles (M8F).
//
//   listImportProfiles()            what this build can read
//   getImportProfile(name)          one profile, or a named refusal
//   mapRow(profile, values)         one CSV row → one raw record
//   validateMapping(profile, headers)  can this file be read at all?
//
// A profile is the ONLY place a column name appears. Every export tool spells
// things differently — Outscraper says `phone`, Google Takeout says
// `Phone Number`, Hotfrog says `Telephone` — and the difference between those
// is a mapping question, not a pipeline question.
//
// ── UNKNOWN STAYS UNKNOWN ───────────────────────────────────────────
// The single rule this module exists to enforce. A missing column produces
// `null`, never a guess and never an empty string masquerading as a value.
// The temptation is small and constant: infer the state from the postcode,
// default the country to Australia, assume a listing with no `verified` column
// is unverified. Each one manufactures a fact nobody observed, and the whole
// acquisition engine is built on being able to say where a fact came from.
//
// Timezone is the sharpest case. It is a COMPLIANCE input — calling hours are
// checked in the business's local time — so guessing it guesses whether a call
// is lawful. A profile may derive it from an explicit state column, because
// that is a lookup rather than an inference, and a row with no state gets no
// timezone and fails eligibility until a human supplies one.
//
// ── VALIDATION BEFORE PROCESSING ────────────────────────────────────
// validateMapping() is run against the file's headers BEFORE any row is read,
// so a founder who exported the wrong columns is told immediately rather than
// after nine hundred rows have produced nine hundred identical failures.
//
// Pure + dep-free. See test/acquisition-import.test.js.

const S = require("./acquisition-schema");

/** Australian state → IANA timezone. A lookup, not an inference. */
const STATE_TIMEZONES = Object.freeze({
  VIC: "Australia/Melbourne",
  NSW: "Australia/Sydney",
  ACT: "Australia/Sydney",
  QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  WA: "Australia/Perth",
  TAS: "Australia/Hobart",
  NT: "Australia/Darwin",
});

/** Postcode first-digit ranges, used ONLY to detect contradictions. */
const POSTCODE_STATES = Object.freeze([
  { from: 1000, to: 2599, state: "NSW" },
  { from: 2600, to: 2618, state: "ACT" },
  { from: 2619, to: 2899, state: "NSW" },
  { from: 2900, to: 2920, state: "ACT" },
  { from: 2921, to: 2999, state: "NSW" },
  { from: 3000, to: 3999, state: "VIC" },
  { from: 4000, to: 4999, state: "QLD" },
  { from: 5000, to: 5799, state: "SA" },
  { from: 6000, to: 6797, state: "WA" },
  { from: 7000, to: 7799, state: "TAS" },
  { from: 800, to: 899, state: "NT" },
]);

const text = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Pick the first column present and non-empty. Order in the list is priority. */
const pick = (values, columns) => {
  for (const c of columns) {
    const v = text(values[c]);
    if (v !== null) return v;
  }
  return null;
};

const normaliseState = (raw) => {
  const v = text(raw);
  if (v === null) return null;
  const upper = v.toUpperCase().replace(/[^A-Z]/g, "");
  if (STATE_TIMEZONES[upper]) return upper;
  const long = {
    VICTORIA: "VIC",
    NEWSOUTHWALES: "NSW",
    QUEENSLAND: "QLD",
    SOUTHAUSTRALIA: "SA",
    WESTERNAUSTRALIA: "WA",
    TASMANIA: "TAS",
    NORTHERNTERRITORY: "NT",
    AUSTRALIANCAPITALTERRITORY: "ACT",
  };
  return long[upper] || null;
};

/**
 * Normalise a URL enough to compare two of them, without changing what it
 * points at. Lowercased host, scheme defaulted to https, tracking query
 * stripped, trailing slash removed. The ORIGINAL is always kept alongside.
 */
function normaliseUrl(raw) {
  const v = text(raw);
  if (v === null) return null;
  let candidate = v;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const u = new URL(candidate);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname.includes(".")) return null;
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(p)) u.searchParams.delete(p);
    }
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

/** Collect every phone column a profile declares, in priority order. */
function collectPhones(values, profile) {
  const seen = new Set();
  const out = [];
  for (const spec of profile.phoneColumns) {
    const raw = text(values[spec.column]);
    if (raw === null) continue;
    // One cell can hold several numbers; real exports separate them with
    // commas, semicolons, slashes or " / ".
    for (const part of raw.split(/[;,/]|\s{2,}/)) {
      const one = text(part);
      if (one === null) continue;
      const key = one.replace(/[^0-9+]/g, "");
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      out.push({ raw: one, label: spec.label });
    }
  }
  return out;
}

// ── The profiles ────────────────────────────────────────────────────

/**
 * OUTSCRAPER / GOOGLE MAPS.
 *
 * Column names follow Outscraper's Google Maps export. Alternatives are listed
 * where the same tool has used more than one name across versions, and where
 * Google Takeout differs — a founder should not have to rename columns by hand
 * to use a file they just downloaded.
 *
 * DELIBERATELY NOT IMPORTED, though the export contains them: reviews, review
 * text, reviewer names, photos, owner names, emails harvested from pages,
 * popular times. None is needed to decide whether a locksmith may lawfully be
 * called, and importing personal data nobody needs is how a prospecting file
 * becomes a privacy problem.
 */
const OUTSCRAPER_GOOGLE_MAPS = Object.freeze({
  name: "outscraper-google-maps",
  label: "Outscraper / Google Maps business export",
  sourceType: "map_listing",
  sourceLabel: "Google Maps listing",
  origin: "operator_import",
  captureMode: "operator_import",
  requiredColumns: Object.freeze(["name"]),
  businessNameColumns: Object.freeze(["name", "title", "Name", "business_name"]),
  legalNameColumns: Object.freeze(["legal_name", "owner_title"]),
  categoryColumns: Object.freeze(["category", "categories", "type", "subtypes", "Category"]),
  websiteColumns: Object.freeze(["site", "website", "Website", "web_site"]),
  addressColumns: Object.freeze(["full_address", "address", "street", "Address"]),
  suburbColumns: Object.freeze(["city", "suburb", "locality", "City"]),
  stateColumns: Object.freeze(["state", "region", "State"]),
  postcodeColumns: Object.freeze(["postal_code", "postcode", "zip", "Zip"]),
  countryColumns: Object.freeze(["country", "country_code"]),
  latitudeColumns: Object.freeze(["latitude", "lat"]),
  longitudeColumns: Object.freeze(["longitude", "lng", "lon"]),
  sourceUrlColumns: Object.freeze(["location_link", "google_maps_url", "url", "link"]),
  sourceIdColumns: Object.freeze(["place_id", "google_id", "cid", "place-id"]),
  observedAtColumns: Object.freeze(["query_date", "scraped_at", "timestamp", "date"]),
  operatingStatusColumns: Object.freeze(["business_status", "status", "permanently_closed"]),
  serviceAreaColumns: Object.freeze(["service_area", "about", "description"]),
  phoneColumns: Object.freeze([
    { column: "phone", label: "Listed number" },
    { column: "phone_1", label: "Listed number" },
    { column: "Phone", label: "Listed number" },
    { column: "phone_2", label: "Additional listed number" },
    { column: "additional_phone", label: "Additional listed number" },
  ]),
});

/**
 * A GENERIC CSV a founder curated by hand.
 *
 * Plain column names, no tool-specific spellings. Its source type is
 * `unverified_directory` rather than anything stronger: a hand-made file is
 * only as good as where its rows came from, and this profile cannot know that.
 * A row's own source URL still classifies per-row through acquisition-source.
 */
const MANUAL_CSV = Object.freeze({
  name: "manual-csv",
  label: "Hand-curated CSV",
  sourceType: "unverified_directory",
  sourceLabel: "Operator-curated file",
  origin: "operator_import",
  captureMode: "operator_import",
  requiredColumns: Object.freeze(["business_name"]),
  businessNameColumns: Object.freeze(["business_name", "name"]),
  legalNameColumns: Object.freeze(["legal_name", "trading_name"]),
  categoryColumns: Object.freeze(["category", "trade", "trade_category"]),
  websiteColumns: Object.freeze(["website", "url", "site"]),
  addressColumns: Object.freeze(["address", "street_address"]),
  suburbColumns: Object.freeze(["suburb", "city"]),
  stateColumns: Object.freeze(["state"]),
  postcodeColumns: Object.freeze(["postcode", "postal_code"]),
  countryColumns: Object.freeze(["country"]),
  latitudeColumns: Object.freeze(["latitude"]),
  longitudeColumns: Object.freeze(["longitude"]),
  sourceUrlColumns: Object.freeze(["source_url", "listing_url"]),
  sourceIdColumns: Object.freeze(["source_id", "listing_id"]),
  observedAtColumns: Object.freeze(["observed_at", "collected_at"]),
  operatingStatusColumns: Object.freeze(["operating_status", "status"]),
  serviceAreaColumns: Object.freeze(["service_area"]),
  phoneColumns: Object.freeze([
    { column: "phone", label: "Listed number" },
    { column: "phone_2", label: "Additional listed number" },
    { column: "mobile", label: "Listed mobile" },
  ]),
});

const PROFILES = Object.freeze({
  [OUTSCRAPER_GOOGLE_MAPS.name]: OUTSCRAPER_GOOGLE_MAPS,
  [MANUAL_CSV.name]: MANUAL_CSV,
});

const listImportProfiles = () => Object.keys(PROFILES);

function getImportProfile(name) {
  const profile = PROFILES[String(name || "").trim()];
  if (!profile) {
    return { ok: false, code: "unknown_profile", message: `There is no import profile called "${String(name || "").slice(0, 40)}". This build reads: ${listImportProfiles().join(", ")}.` };
  }
  return { ok: true, profile };
}

/**
 * Can this file be read with this profile?
 *
 * Run once, before any row. Reports what is missing by name, and — because the
 * commonest mistake is picking the wrong profile rather than the wrong export —
 * says which columns it DID recognise.
 */
function validateMapping(profile, headers) {
  const present = new Set((Array.isArray(headers) ? headers : []).map((h) => String(h).trim()));
  const missing = profile.requiredColumns.filter((c) => !present.has(c));

  const anyPhone = profile.phoneColumns.some((p) => present.has(p.column));
  const recognised = [];
  for (const [key, cols] of Object.entries(profile)) {
    if (!Array.isArray(cols) || !key.endsWith("Columns")) continue;
    for (const c of cols) {
      const col = typeof c === "string" ? c : c.column;
      if (present.has(col)) recognised.push(col);
    }
  }

  const problems = [];
  if (missing.length > 0) {
    problems.push({ code: "missing_required_column", message: `This file has no ${missing.map((m) => `"${m}"`).join(", ")} column, which "${profile.name}" needs to identify a business.` });
  }
  if (!anyPhone) {
    problems.push({ code: "no_phone_column", message: `This file has none of the phone columns "${profile.name}" reads (${profile.phoneColumns.map((p) => p.column).join(", ")}). Every row will import without a number and none will be callable.` });
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    recognised: Object.freeze([...new Set(recognised)]),
    unrecognised: Object.freeze([...present].filter((h) => h !== "" && !recognised.includes(h))),
  });
}

/**
 * One CSV row → one raw record.
 *
 * Shapes and normalises; decides nothing. Classification, phone validity,
 * duplicate status and qualification all happen later, against a record that
 * says plainly what the file did and did not contain.
 */
function mapRow(profile, values, { line = null } = {}) {
  const state = normaliseState(pick(values, profile.stateColumns));
  const postcode = pick(values, profile.postcodeColumns);
  const country = pick(values, profile.countryColumns);

  const websiteRaw = pick(values, profile.websiteColumns);
  const sourceUrlRaw = pick(values, profile.sourceUrlColumns);

  const notes = [];

  // A contradiction is recorded, never resolved. Which of the two is wrong is
  // not knowable from the row, and picking one silently would make a locality
  // up.
  if (state && postcode && /^\d{3,4}$/.test(postcode)) {
    const n = Number(postcode);
    const band = POSTCODE_STATES.find((b) => n >= b.from && n <= b.to);
    if (band && band.state !== state) {
      notes.push({ code: "state_postcode_mismatch", message: `The state says ${state} but postcode ${postcode} is in ${band.state}. Neither was changed.` });
    }
  }

  if (country && !/^(au|aus|australia)$/i.test(country)) {
    notes.push({ code: "unsupported_country", message: `This row says country "${country}". This build only handles Australian numbers and calling rules.` });
  }

  return Object.freeze({
    line,
    businessName: pick(values, profile.businessNameColumns),
    legalName: pick(values, profile.legalNameColumns),
    tradeCategory: pick(values, profile.categoryColumns),
    website: normaliseUrl(websiteRaw),
    websiteRaw,
    address: pick(values, profile.addressColumns),
    suburb: pick(values, profile.suburbColumns),
    state,
    postcode,
    country,
    // Timezone is DERIVED FROM STATE and from nothing else. No state, no
    // timezone, and eligibility refuses the prospect until a human says.
    timezone: state ? STATE_TIMEZONES[state] || null : null,
    latitude: pick(values, profile.latitudeColumns),
    longitude: pick(values, profile.longitudeColumns),
    sourceUrl: normaliseUrl(sourceUrlRaw) || sourceUrlRaw,
    sourceId: pick(values, profile.sourceIdColumns),
    observedAt: pick(values, profile.observedAtColumns),
    operatingStatus: pick(values, profile.operatingStatusColumns),
    serviceArea: pick(values, profile.serviceAreaColumns),
    phones: Object.freeze(collectPhones(values, profile)),
    notes: Object.freeze(notes),
    profileName: profile.name,
    sourceType: profile.sourceType,
  });
}

module.exports = {
  listImportProfiles,
  getImportProfile,
  validateMapping,
  mapRow,
  normaliseUrl,
  normaliseState,
  STATE_TIMEZONES,
  PROFILES,
};
