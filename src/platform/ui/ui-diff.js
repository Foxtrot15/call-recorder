// AIDA PLATFORM UI — Review changes, in words a business owner can approve (P32A).
//
//   presentDiff(diff)  -> { sections[], changeCount, hasChanges, raw }
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────
// blueprint-diff.js already produces a deterministic, domain-level change list.
// What it produces is still shaped like the object:
//
//   hours.weekly.saturday.close: 17:00 -> 16:00
//
// A person approving a change to how their telephone is answered should read:
//
//   Saturday hours
//     9:00-17:00
//   → 9:00-16:00
//
// The difference between those two is whether the approval means anything. A
// screen full of dotted paths gets approved without being read, and an approval
// nobody read is worse than no approval, because it has a name attached to it.
//
// ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────
// It is not a second diff. It never compares anything and never decides what
// changed — blueprint-diff.js is the only authority on that. This takes the
// changes it produced and decides how to SAY them. If it cannot say one
// nicely, it falls back to the domain summary verbatim rather than dropping it:
// a change that a presenter does not recognise is exactly the change somebody
// needs to see.
//
// A test asserts every change in equals one change out. Silently swallowing a
// change on a review screen would be the worst defect this file could have.

const { DAYS } = require("../client-blueprint");

const SECTIONS = Object.freeze([
  { key: "identity", title: "Identity", blurb: "Who the business is and how the assistant introduces itself" },
  { key: "services", title: "Services", blurb: "What the business does, and how urgent each one is" },
  { key: "serviceArea", title: "Service area", blurb: "Where the business will travel" },
  { key: "hours", title: "Hours", blurb: "When the business is open, and what happens outside those times" },
  { key: "callHandling", title: "Call handling", blurb: "The greeting, what is collected, urgency and transfers" },
  { key: "knowledge", title: "Knowledge", blurb: "Approved facts, pricing policy, and what must never be claimed" },
  { key: "booking", title: "Booking", blurb: "Appointment types and constraints" },
  { key: "voice", title: "Voice", blurb: "Language, tone and the provider-independent voice reference" },
  { key: "outbound", title: "Outbound", blurb: "Outbound calling capability. AI disclosure is mandatory and not configurable" },
  { key: "compliance", title: "Compliance", blurb: "Recording, retention and what callers are told" },
  { key: "integrations", title: "Integrations", blurb: "Capabilities this client has enabled" },
  { key: "extensions", title: "Extensions", blurb: "Free-form notes. Nothing routing, safety or approval reads this" },
  { key: "metadata", title: "Lifecycle", blurb: "Version bookkeeping" },
  { key: "", title: "Other", blurb: "Changes outside the known sections" },
]);

const SECTION_KEYS = new Set(SECTIONS.map((s) => s.key).filter(Boolean));

const TITLE_CASE = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Field names a person did not choose, rendered as words a person would.
 * Anything absent falls through to a de-camelCased version, which is imperfect
 * and honest rather than wrong and confident.
 */
const FIELD_WORDS = Object.freeze({
  legalName: "Legal name",
  tradingName: "Trading name",
  assistantName: "Assistant name",
  businessPhone: "Business phone",
  greetingLine: "Greeting (the words a caller hears first)",
  greetingStyle: "Greeting style (an instruction, never spoken verbatim)",
  collectAlways: "Always collect",
  collectByService: "Collect for specific services",
  urgencyRules: "Urgency rules",
  escalation: "Transfer and escalation",
  primaryNumber: "Transfer number",
  backupNumber: "Backup transfer number",
  unansweredAction: "If the transfer is not answered",
  unavailableAction: "When nobody is available",
  callbackPolicy: "Callback policy",
  outsideAreaAction: "When a caller is outside the service area",
  outsideAreaWording: "Words used outside the service area",
  radiusKm: "Travel radius (km)",
  remoteServiceAvailable: "Remote service available",
  travelNotes: "Travel notes",
  afterHours: "After hours",
  closedPeriods: "Closed periods",
  publicHolidays: "Public holidays",
  approvedFacts: "Approved facts",
  sourceReferences: "Knowledge references",
  prohibitedClaims: "Prohibited claims",
  uncertaintyPolicy: "When the assistant is unsure",
  pricingDisclosure: "Pricing policy",
  pricingWording: "Pricing wording",
  appointmentTypes: "Appointment types",
  capabilityTarget: "Booking goes to",
  profileRef: "Voice reference",
  pronunciationHints: "Pronunciation hints",
  callsMayBeRecorded: "Calls may be recorded",
  recordingDisclosure: "What callers are told about recording",
  transcriptRetention: "Transcript retention",
  recordingRetention: "Recording retention",
  redactSensitiveData: "Redact sensitive data",
  privacyPolicyReference: "Privacy policy reference",
  disclosureWording: "Outbound disclosure wording",
  optOutWording: "Opt-out wording",
  qualificationCriteria: "Qualification criteria",
  qualificationRequirements: "Qualification requirements",
  urgencyCategory: "Urgency",
  serviceId: "Service id",
  enabled: "Enabled",
  aliases: "Also called",
  exclusions: "Exclusions",
  proposition: "Proposition",
  campaignType: "Campaign type",
});

const words = (key) =>
  FIELD_WORDS[key] ||
  TITLE_CASE(String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase());

/**
 * The platform's own vocabularies, in the words the founder used: "quote if
 * asked" rather than `confirmed_at_booking`. These are the values a client
 * PICKS from a list, so a review screen showing them as slugs is showing the
 * reviewer something they never typed and would not recognise.
 *
 * A test asserts every value in every platform enum has an entry here, so a new
 * urgency action cannot be added to the domain and quietly render as a slug on
 * the one screen where somebody approves it.
 */
const ENUM_WORDS = Object.freeze({
  // urgency levels
  emergency: "emergency", urgent: "urgent", priority: "priority",
  standard: "standard", non_urgent: "not urgent",
  // urgency actions
  transfer_immediately: "transfer the caller straight away",
  notify_urgently_and_collect: "collect details and notify urgently",
  collect_and_notify: "collect details and notify",
  collect_for_business_hours: "collect details for business hours",
  decline_politely: "decline politely",
  // outside the service area
  collect_details_for_confirmation: "collect details and confirm later",
  politely_decline: "politely decline",
  transfer_for_manual_assessment: "transfer for manual assessment",
  // nobody available
  take_message_and_notify: "take a message and notify",
  offer_callback: "offer a callback",
  transfer_to_backup: "transfer to the backup number",
  state_hours_and_end: "state the opening hours and end the call",
  // unanswered transfer
  try_backup_number: "try the backup number",
  take_message_only: "take a message only",
  // pricing
  never_discuss: "do not discuss pricing",
  callout_fee_only: "give the call-out fee only",
  indicative_ranges: "give indicative ranges",
  confirmed_at_booking: "quote if asked, confirmed at booking",
  // uncertainty
  say_unsure_and_take_message: "say it is unsure and take a message",
  say_unsure_and_transfer: "say it is unsure and transfer",
  say_unsure_and_offer_callback: "say it is unsure and offer a callback",
  // retention
  keep_indefinitely_until_changed: "keep until this is changed",
  keep_12_months: "keep for 12 months",
  keep_6_months: "keep for 6 months",
  keep_3_months: "keep for 3 months",
  delete_after_summary: "delete once summarised",
  // integration capabilities
  crm: "CRM", calendar: "calendar", booking: "booking",
  job_management: "job management", sms: "SMS", email: "email", webhook: "webhook",
  // caller information
  caller_name: "caller name", callback_number: "callback number",
  service_address: "service address", suburb: "suburb",
  problem_description: "description of the problem", urgency_signal: "urgency signal",
  access_notes: "access notes", preferred_time: "preferred time",
  property_type: "property type", on_site_now: "whether they are on site now",
  reference_number: "reference number",
  // mandatory prohibited claims
  guaranteed_arrival_time: "guaranteeing an arrival time",
  guaranteed_price: "guaranteeing a price",
  guaranteed_outcome: "guaranteeing an outcome",
  legal_or_regulatory_advice: "giving legal or regulatory advice",
  insurance_coverage_assurance: "assuring insurance coverage",
  claiming_to_be_human: "claiming to be human",
});

const plain = (v) => (typeof v === "string" && ENUM_WORDS[v] ? ENUM_WORDS[v] : null);

/** A day's hours as one readable phrase. */
const dayHours = (d) => {
  if (!d || typeof d !== "object") return "not set";
  if (d.closed === true) return "closed";
  if (typeof d.open === "string" && typeof d.close === "string") return `${d.open}-${d.close}`;
  return "not set";
};

/**
 * A service, rule or fact named the way a person named it, rather than dumped
 * as an object. The founder's example is "+ Garage door cable replacement",
 * not a JSON blob of six keys.
 */
function nameOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  for (const k of ["name", "label", "statement", "question", "when", "description"]) {
    if (typeof v[k] === "string" && v[k].trim()) return v[k];
  }
  for (const k of ["serviceId", "ruleId", "typeId", "factId", "refId", "capability", "intentId"]) {
    if (typeof v[k] === "string" && v[k].trim()) return String(v[k]).replace(/_/g, " ");
  }
  return null;
}

/** A value as a person would read it, not as JSON would print it. */
function value(v) {
  if (v === undefined) return "not set";
  if (v === null) return "none";
  if (v === true) return "yes";
  if (v === false) return "no";
  const spoken = plain(v);
  if (spoken) return spoken;
  if (Array.isArray(v)) return v.length === 0 ? "(empty)" : v.map(value).join(", ");
  if (typeof v === "object") {
    if (v.closed === true) return "closed";
    if (typeof v.open === "string" && typeof v.close === "string") return `${v.open}-${v.close}`;
    const named = nameOf(v);
    if (named) return named;
    const bits = Object.keys(v).sort().map((k) => `${words(k)}: ${value(v[k])}`);
    return bits.join("; ");
  }
  return String(v);
}

/** "services" -> "Service". A whole item added or removed reads in the singular. */
const SINGULAR = Object.freeze({
  services: "Service",
  urgencyRules: "Urgency rule",
  approvedFacts: "Approved fact",
  sourceReferences: "Knowledge reference",
  appointmentTypes: "Appointment type",
  integrations: "Integration",
  intentTaxonomy: "Intent",
  additionalQuestions: "Question",
  closedPeriods: "Closed period",
  pronunciationHints: "Pronunciation hint",
});
const singular = (container) => SINGULAR[container] || words(container).replace(/s$/, "");

/**
 * Turn one domain path into a heading a person recognises.
 * Returns { section, heading, itemLabel } — itemLabel names WHICH service or
 * rule changed, so a list of ten services does not produce ten identical rows.
 */
function describePath(path) {
  const raw = String(path || "");
  if (raw === "") return { section: "", heading: "Configuration", itemLabel: null };

  const head = raw.split(/[.[]/)[0];
  const section = SECTION_KEYS.has(head) ? head : "";

  // services[key_cutting].urgencyCategory  ->  item "key cutting", field "Urgency"
  const bracket = raw.match(/^([a-zA-Z]+)\[([^\]]+)\](?:\.(.+))?$/);
  if (bracket) {
    const [, container, id, rest] = bracket;
    const item = String(id).replace(/_/g, " ");
    // The whole item was added or removed: name the KIND of thing, singular, so
    // the row reads "Service added" rather than "Services — cable replacement".
    if (!rest) return { section, heading: singular(container), itemLabel: item, whole: true };
    return { section, heading: `${item} — ${rest.split(".").map(words).join(" / ")}`, itemLabel: item };
  }

  const parts = raw.split(".");

  // hours.weekly.saturday(.close)  ->  "Saturday hours"
  if (parts[0] === "hours" && parts[1] === "weekly" && DAYS.includes(parts[2])) {
    return { section: "hours", heading: `${TITLE_CASE(parts[2])} hours`, itemLabel: parts[2] };
  }

  if (parts.length === 1) return { section, heading: words(parts[0]), itemLabel: null };

  // Drop the section word from the heading — it is already the group title.
  const tail = parts.slice(1);
  return { section, heading: tail.map(words).join(" / "), itemLabel: tail[tail.length - 1] };
}

/** Which day a change belongs to, if any. `hours.weekly.saturday.close` -> "saturday". */
function dayOf(path) {
  const parts = String(path || "").split(".");
  return parts[0] === "hours" && parts[1] === "weekly" && DAYS.includes(parts[2]) ? parts[2] : null;
}

/**
 * Changing Saturday from 8:00-12:00 to 9:00-16:00 is ONE change a person made
 * and TWO leaf changes in the object. Reported separately they read as two
 * unrelated edits and the reviewer has to reassemble the day in their head.
 *
 * So same-day rows are merged into one, reconstructing the whole day on each
 * side from the parts the domain reported. `before`/`after` of each leaf are
 * authoritative — nothing is inferred from the current blueprint, because the
 * diff is the only thing here that knows what the old version said.
 */
function mergeHours(rows) {
  const out = [];
  const byDay = new Map();

  for (const row of rows) {
    const day = dayOf(row.path);
    const leaf = day ? String(row.path).split(".")[3] : null;
    // The whole-day object changed (closed <-> open): already one row.
    if (!day || !leaf) { out.push(row); continue; }
    if (!byDay.has(day)) {
      byDay.set(day, { day, before: {}, after: {}, rows: [], index: out.length });
      out.push(null); // placeholder, keeping the day in its sorted position
    }
    const g = byDay.get(day);
    g.before[leaf] = row.before === "not set" ? undefined : row.before;
    g.after[leaf] = row.after === "not set" ? undefined : row.after;
    g.rows.push(row);
  }

  for (const g of byDay.values()) {
    const first = g.rows[0];
    const both = (side) => {
      const open = g[side].open ?? "?";
      const close = g[side].close ?? "?";
      return `${open}-${close}`;
    };
    // Only one end changed: say which, rather than printing a "?" the reviewer
    // has to interpret.
    const partial = g.rows.length === 1;
    out[g.index] = Object.freeze({
      ...first,
      path: `hours.weekly.${g.day}`,
      heading: `${TITLE_CASE(g.day)} hours`,
      before: partial ? `${words(String(first.path).split(".")[3])} ${first.before}` : both("before"),
      after: partial ? `${words(String(first.path).split(".")[3])} ${first.after}` : both("after"),
      domainSummary: g.rows.map((r) => r.domainSummary).join("; "),
      mergedFrom: Object.freeze(g.rows.map((r) => r.path)),
    });
  }

  return out.filter(Boolean);
}

const KIND_VERB = Object.freeze({
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  list_changed: "Changed",
  created: "Created",
});

/**
 * Present one domain change. `domainSummary` is always carried through
 * untouched, so an operator can see exactly what the domain said and a test can
 * prove nothing was lost in translation.
 */
function presentChange(change) {
  const { section, heading, itemLabel, whole } = describePath(change.path);
  const verb = KIND_VERB[change.kind] || "Changed";

  // A plain list gaining or losing entries: say WHICH, not both full lists.
  // Reading two forty-suburb lists to find the one that moved is not review.
  if (change.kind === "list_changed") {
    const before = Array.isArray(change.before) ? change.before.map(value) : [];
    const after = Array.isArray(change.after) ? change.after.map(value) : [];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    return Object.freeze({
      path: change.path, kind: change.kind, section, heading, itemLabel, verb,
      before: removed.length ? removed.join(", ") : null,
      after: added.length ? added.join(", ") : null,
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      isList: true,
      domainSummary: change.summary,
      notable: removed.length > 0,
    });
  }

  const row = {
    path: change.path,
    kind: change.kind,
    section,
    heading,
    itemLabel,
    verb,
    before: dayOf(change.path) && !String(change.path).split(".")[3] ? dayHours(change.before) : value(change.before),
    after: dayOf(change.path) && !String(change.path).split(".")[3] ? dayHours(change.after) : value(change.after),
    domainSummary: change.summary,
    // Removing something is the direction that takes capability away from a
    // caller, so it is flagged for prominence rather than styled the same as
    // adding a suburb.
    notable: change.kind === "removed",
  };

  // A whole service, rule or fact appearing or disappearing: one side is the
  // thing's name, the other is nothing. "not set → {six keys}" is not review.
  if (whole && (change.kind === "added" || change.kind === "removed")) {
    const named = value(change.kind === "added" ? change.after : change.before);
    row.before = change.kind === "removed" ? named : null;
    row.after = change.kind === "added" ? named : null;
    row.itemName = named;
  }

  if (change.kind === "created") {
    row.before = null;
    row.after = null;
    row.heading = "First configuration for this client";
  }
  return Object.freeze(row);
}

/**
 * Group the domain diff into the sections the founder named, in a fixed order,
 * dropping empty sections. Deterministic in, deterministic out.
 */
function presentDiff(diff) {
  const changes = (diff && Array.isArray(diff.changes) ? diff.changes : []).map(presentChange);

  const bySection = new Map(SECTIONS.map((s) => [s.key, []]));
  for (const c of changes) {
    if (!bySection.has(c.section)) bySection.set("", bySection.get("") || []);
    (bySection.get(c.section) || bySection.get("")).push(c);
  }

  const sections = SECTIONS
    .map((s) => {
      const rows = s.key === "hours" ? mergeHours(bySection.get(s.key) || []) : (bySection.get(s.key) || []);
      if (rows.length === 0) return null;
      return Object.freeze({
        key: s.key || "other",
        title: s.title,
        blurb: s.blurb,
        changes: Object.freeze(rows),
        changeCount: rows.length,
        // A section containing a removal deserves the reviewer's eye first.
        notable: rows.some((r) => r.notable),
      });
    })
    .filter(Boolean);

  return Object.freeze({
    hasChanges: Boolean(diff && diff.hasChanges),
    // The DOMAIN change count, not the row count. Merging two Saturday rows
    // into one line must never make a review screen claim fewer changes than
    // the domain found.
    changeCount: changes.length,
    rowCount: sections.reduce((n, s) => n + s.changeCount, 0),
    summary: (diff && diff.summary) || "no changes",
    sections: Object.freeze(sections),
    // Every domain change, flat and untouched, for the operator raw view. This
    // is what makes "nothing was lost" checkable rather than asserted.
    raw: Object.freeze((diff && Array.isArray(diff.changes) ? diff.changes : []).slice()),
  });
}

module.exports = { presentDiff, presentChange, describePath, value, words, SECTIONS };
