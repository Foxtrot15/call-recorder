// AIDA Locksmith Acquisition — deterministic locksmith qualification (M8B).
//
//   qualifyProspect(prospect, { evidenceRows, declared, market, at })
//   rankQualified(assessments)
//   compareQualifications(a, b)     why is this one above that one?
//   describeQualification(assessment)
//
// Answers ONE question, and it is not the compliance question:
//
//     Is this business worth approaching, and how does it compare to the
//     others on the list?
//
// ── THIS IS NOT AN ELIGIBILITY CHECK ────────────────────────────────
// Commercial fit and legal permission are different questions with different
// owners and different failure modes. acquisition-eligibility.js decides
// whether a call is PERMITTED; this module decides whether it is WORTH making.
// Nothing here may ever be read as authorisation, and this module deliberately
// knows nothing about suppression, the DNCR, calling hours or holidays — if it
// did, a future reader would eventually treat a high score as a green light.
//
// The queue asks both, separately, and both must say yes.
//
// ── NO OPAQUE SCORING ───────────────────────────────────────────────
// There is no model, no embedding, no learned weight and no hidden threshold.
// The score is the sum of a fixed table of NAMED signals, every one of which is
// returned with the points it contributed and the reason it fired. A founder
// asking "why is Northside above Bayside?" gets the signals that differ, not a
// number. compareQualifications() answers that question directly.
//
// The number exists only to ORDER prospects. The TIER is the judgement, because
// a tier is something a person can argue with and 0.72 is something a person
// tunes until it says what they wanted.
//
// ── FACTS AND INFERENCES ARE NOT MIXED ──────────────────────────────
// A fact is something we observed and can point at evidence for. An inference
// is something we concluded, and it must name the facts it was drawn from.
// They are scored separately and reported separately, because "their site
// advertises 24-hour callouts" and "they probably lose calls at night" are
// different kinds of claim and only one of them is checkable.
//
// Inferences are worth less than facts by construction (see INFERENCE_WEIGHT),
// so a prospect cannot climb the list on conclusions alone.
//
// ── UNKNOWN IS NEVER A POSITIVE ─────────────────────────────────────
// Every signal resolves to `yes`, `no` or `unknown`. Only `yes` scores. An
// unknown contributes nothing and is listed by name in `unknowns`, so a founder
// can see what we would need to find out. We never estimate call volume: it is
// the single most tempting number to invent here and the one we genuinely
// cannot see from outside. It is `unknown` unless somebody attests to it.
//
// ── BIGGER IS NOT WORSE ─────────────────────────────────────────────
// AIDA suits a sole operator and a twelve-van business. A business with more
// calls may be a BETTER customer, not a worse one, so no signal in the table
// awards negative points for size and a test asserts none ever will. What we
// exclude is not large businesses — it is aggregators, lead-resale funnels and
// national switchboards, which are a different thing that happens to be big.
//
// Pure + dep-free. See test/acquisition-qualification.test.js.

const S = require("./acquisition-schema");
const { normaliseProspectPhones } = require("./acquisition-phone");
const { summariseSources } = require("./acquisition-source");

// Inferences are scored at a fraction of a fact's weight. Stated as a constant
// rather than baked into each row so the relationship is visible and testable:
// conclusions support a ranking, they do not drive one.
const INFERENCE_WEIGHT = 0.5;

// Tier bands over the fact-weighted score. Round numbers on purpose — these are
// editorial bands, not a calibrated model, and pretending otherwise by using
// 63.5 would invite somebody to treat them as fitted.
//
// They are, however, calibrated against the achievable range rather than
// guessed. The table's maximum is 136 (112 in facts, 24 in weighted
// inferences), and a well-sourced locksmith with a website, an ABN, a callable
// number and evidence of emergency work already scores in the low 80s — so the
// first draft's 70/45/20 put almost everything in `priority` and ranked
// nothing. A band that does not divide the population is decoration.
const TIER_BANDS = Object.freeze([
  { tier: "priority", min: 95 },
  { tier: "standard", min: 65 },
  { tier: "marginal", min: 40 },
  { tier: "excluded", min: -Infinity },
]);

// The bar for `qualified` is the `standard` band, derived rather than repeated
// so the two cannot drift apart. Below it a record is `not_qualified` — a real
// answer, distinct from `insufficient_information`, which means we could not
// tell either way.
const QUALIFICATION_MINIMUM = TIER_BANDS.find((b) => b.tier === "standard").min;

// The markets the locksmith pilot serves. A prospect outside them is not a bad
// business, it is simply not one we can serve yet — so this is a disqualifier
// with a neutral label rather than a penalty.
const DEFAULT_TARGET_MARKET = Object.freeze({
  states: Object.freeze(["VIC", "NSW", "QLD", "SA", "WA", "TAS", "NT", "ACT"]),
  country: "AU",
});

// Words that, in a trading name or a stated category, indicate the locksmith
// trade. Matching is on whole words over a normalised string — "blockbuster"
// must not match "lock".
const LOCKSMITH_TERMS = Object.freeze(["locksmith", "locksmiths", "locksmithing", "lock", "locks", "keys", "key", "keying", "rekeying", "deadlock", "deadlocks"]);

// Terms that indicate a DIFFERENT trade wearing similar words. A "lock" in
// "Lockyer Valley Plumbing" or a "key" in "Keystone Real Estate" is a locality
// or a metaphor, not a trade.
const OTHER_TRADE_TERMS = Object.freeze(["plumbing", "plumber", "electrical", "electrician", "real estate", "realty", "conveyancing", "accounting", "accountants", "cafe", "restaurant", "hairdressing", "landscaping", "roofing", "glazier", "panel beating"]);

// Signals that a reference is a lead-resale funnel rather than a locksmith:
// pages that exist to capture a call and sell it on. Matched on the reference
// STRING only — no fetch, exactly as acquisition-source.js classifies.
const LEAD_GEN_TERMS = Object.freeze(["find-a-locksmith", "findalocksmith", "locksmith-near-me", "locksmithnearme", "compare", "quotes", "get3quotes", "hipages", "oneflare", "serviceseeking", "airtasker", "yourtradebase", "24-7-locksmith-australia"]);

// Words in a stated service area that indicate a national switchboard rather
// than a local operator. On their own they prove nothing — the disqualifier
// requires them PLUS the absence of any local presence.
const NATIONAL_TERMS = Object.freeze(["australia wide", "australiawide", "nationwide", "nation wide", "all of australia", "every state", "national"]);

// Words indicating emergency / after-hours work — the service pattern where a
// missed call is most obviously a lost job.
const EMERGENCY_TERMS = Object.freeze(["24/7", "24 7", "24hr", "24 hour", "24-hour", "twenty four hour", "emergency", "after hours", "afterhours", "out of hours", "all hours", "lockout", "lock out"]);

// ── The signal table ────────────────────────────────────────────────
//
// One row per named signal. `points` is what it contributes when it resolves to
// `yes`; `kind` decides whether it is reported as something we saw or something
// we concluded, and whether INFERENCE_WEIGHT applies.
//
// `basis` on an inference names the FACT signals it was drawn from. A test
// asserts every named basis exists, so an inference can never cite a fact the
// table does not produce.
const SIGNALS = Object.freeze([
  // ── Facts: is this a locksmith at all? ──
  {
    key: "trade_evidence_locksmith",
    kind: "fact",
    points: 25,
    label: "Evidence shows locksmith work",
    describe: (r) => (r.yes ? `The trade evidence describes locksmith work${r.detail ? ` (${r.detail})` : ""}.` : "We hold no evidence that this business does locksmith work."),
  },
  {
    key: "official_source",
    kind: "fact",
    points: 15,
    label: "Confirmed from an official source",
    describe: (r) => (r.yes ? `Confirmed from ${r.detail}.` : "We have only third-party listings for this business."),
  },
  {
    key: "own_website",
    kind: "fact",
    points: 8,
    label: "Has its own website",
    describe: (r) => (r.yes ? "The business publishes its own website." : "We have not found a website the business controls."),
  },
  {
    key: "abn_registered",
    kind: "fact",
    points: 7,
    label: "Registered business (ABN)",
    describe: (r) => (r.yes ? `Registered under ABN ${r.detail}.` : "We do not hold an ABN for this business."),
  },
  {
    key: "still_trading_evidence",
    kind: "fact",
    points: 5,
    label: "Evidence it is still trading",
    describe: (r) => (r.yes ? "We hold evidence that the business is still trading." : "We hold nothing confirming the business is still trading."),
  },

  // ── Facts: can we reach them, and how do they take work? ──
  {
    key: "callable_number",
    kind: "fact",
    points: 10,
    label: "Has a number we could dial",
    describe: (r) => (r.yes ? `Publishes a callable number (${r.detail}).` : "Publishes no number of a kind we would ever dial."),
  },
  {
    key: "service_number_published",
    kind: "fact",
    points: 6,
    label: "Pays for a 1300/1800 number",
    // A business that rents a service number has decided inbound calls are
    // worth money to it. That is the clearest published signal of call value
    // available without asking them.
    describe: (r) => (r.yes ? "Pays for a 1300/1800 number, so inbound calls are worth money to them." : "No 1300/1800 number published."),
  },
  {
    key: "multiple_published_numbers",
    kind: "fact",
    points: 6,
    label: "Publishes more than one number",
    describe: (r) => (r.yes ? `Publishes ${r.detail} numbers, which usually means more than one person answering.` : "Publishes a single number."),
  },
  {
    key: "emergency_service_advertised",
    kind: "fact",
    points: 12,
    label: "Advertises emergency / after-hours work",
    describe: (r) => (r.yes ? `Advertises emergency or after-hours work${r.detail ? ` ("${r.detail}")` : ""}.` : "Does not advertise emergency or after-hours work."),
  },
  {
    key: "broad_service_area",
    kind: "fact",
    points: 5,
    label: "Covers a wide service area",
    describe: (r) => (r.yes ? `States a service area covering ${r.detail}.` : "No broad service area stated."),
  },
  {
    key: "team_size_stated",
    kind: "fact",
    points: 8,
    label: "More than one technician",
    // Explicitly positive. A twelve-van business takes more calls than a sole
    // operator and is a better AIDA customer, not a worse one.
    describe: (r) => (r.yes ? `States ${r.detail} technicians.` : "We do not know how many people work there."),
  },
  {
    key: "in_target_market",
    kind: "fact",
    points: 5,
    label: "In a market we serve",
    describe: (r) => (r.yes ? `Located in ${r.detail}.` : "Not in a market we currently serve."),
  },

  // ── Inferences: conclusions, each naming the facts behind it ──
  {
    key: "likely_loses_calls",
    kind: "inference",
    points: 20,
    basis: ["emergency_service_advertised", "callable_number"],
    label: "Missed calls probably cost them work",
    describe: (r) => (r.yes ? "Advertising after-hours work on a number that can go unanswered is the pattern where a missed call is a lost job." : "Nothing suggests missed calls are costing them work."),
  },
  {
    key: "likely_mobile_operator",
    kind: "inference",
    points: 8,
    basis: ["callable_number"],
    label: "Probably works out of a vehicle",
    // Whoever is driving cannot answer. This is the AIDA pitch in one line.
    describe: (r) => (r.yes ? "A mobile number as the published contact suggests whoever answers is also the person driving to the job." : "Not obviously a mobile operator."),
  },
  {
    key: "likely_multi_technician",
    kind: "inference",
    points: 10,
    basis: ["multiple_published_numbers", "broad_service_area", "team_size_stated"],
    label: "Probably more than a one-person business",
    describe: (r) => (r.yes ? `Several published numbers and a wide service area suggest more than one person on the tools${r.detail ? ` (${r.detail})` : ""}.` : "No indication of size either way."),
  },
  {
    key: "likely_local_operator",
    kind: "inference",
    points: 10,
    basis: ["own_website", "in_target_market", "official_source"],
    label: "Probably an independent local business",
    describe: (r) => (r.yes ? "Its own website and a single stated locality look like an independent local operator rather than a franchise or a referral network." : "We cannot tell whether this is an independent local business."),
  },
]);

const SIGNAL_BY_KEY = Object.freeze(Object.fromEntries(SIGNALS.map((s) => [s.key, s])));

// Every signal that is genuinely unknowable from published information without
// asking the business. Reported by name every time, so nobody mistakes silence
// for a negative — and so nobody is tempted to fill them in with a guess.
const NEVER_OBSERVABLE = Object.freeze([
  { key: "call_volume", label: "How many calls they take", why: "Not visible from outside. Only they can tell us." },
  { key: "missed_call_rate", label: "How many calls they miss", why: "Not visible from outside, and the number that would matter most." },
  { key: "current_answering_arrangement", label: "What happens now when they cannot answer", why: "Not published. A voicemail box and a receptionist look identical from here." },
]);

// ── Helpers ─────────────────────────────────────────────────────────

function norm(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "";
}

/** Whole-word containment over a normalised string. "lock" must not hit "blockbuster". */
function hasWord(haystack, term) {
  const t = norm(term);
  if (!t) return false;
  return ` ${haystack} `.includes(` ${t} `);
}

function hasAnyWord(haystack, terms) {
  return terms.find((t) => hasWord(haystack, t)) || null;
}

/** Substring match, for URLs and slugs where word boundaries do not survive. */
function hasAnySubstring(haystack, terms) {
  const h = String(haystack || "").toLowerCase();
  return terms.find((t) => h.includes(t)) || null;
}

function yes(detail = null) {
  return { yes: true, unknown: false, detail };
}
function no(detail = null) {
  return { yes: false, unknown: false, detail };
}
function unknown(detail = null) {
  return { yes: false, unknown: true, detail };
}

/**
 * Everything the signals read, gathered once. Kept separate from the signals
 * themselves so each signal is a small readable rule rather than a paragraph of
 * data-wrangling, and so a test can assert what was observed independently of
 * what was concluded.
 */
function observe(prospect, evidenceRows, declared, market) {
  const evidence = Array.isArray(evidenceRows) ? evidenceRows : [];
  const byKind = new Map();
  for (const row of evidence) {
    if (!row || typeof row !== "object") continue;
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind).push(row);
  }

  const phones = normaliseProspectPhones(prospect);
  const sources = summariseSources(prospect.sourceRefs);

  // The text we are allowed to read for trade and service signals. Deliberately
  // NOT the whole record: notes are operator free-text and may contain our own
  // speculation, which must not become evidence of the business's behaviour.
  const tradeText = norm([prospect.businessName, prospect.legalName, prospect.tradeCategory, ...(byKind.get("trade_category") || []).map((r) => r.value)].filter(Boolean).join(" "));

  const serviceText = norm(
    [prospect.tradeCategory, ...(byKind.get("trade_category") || []).map((r) => r.value), ...(byKind.get("service_area") || []).map((r) => r.value), ...(byKind.get("website") || []).map((r) => r.value), declared && declared.servicesText]
      .filter(Boolean)
      .join(" ")
  );

  const areaText = norm([...(byKind.get("service_area") || []).map((r) => r.value), declared && declared.serviceAreaText].filter(Boolean).join(" "));

  const referenceText = [...(prospect.sourceRefs || []).map((r) => (r && (r.url || r.reference)) || ""), ...(byKind.get("website") || []).map((r) => r.value)].filter(Boolean).join(" ").toLowerCase();

  return {
    evidence,
    byKind,
    phones,
    sources,
    tradeText,
    serviceText,
    areaText,
    referenceText,
    market,
    declared: declared || {},
  };
}

/**
 * Hard exclusions. These are not penalties — no amount of other merit overturns
 * them — so they live outside the score entirely. Each returns a reason a
 * founder can check, because a wrong exclusion is invisible afterwards: the
 * business simply never appears again.
 */
function findDisqualifiers(prospect, o) {
  const out = [];
  const add = (code, why) => out.push(Object.freeze({ code, label: S.DISQUALIFIER_LABELS[code], why }));

  // A lead-resale funnel. Checked FIRST: these pages advertise locksmith work
  // convincingly, so the trade test below would pass one happily.
  const leadGen = hasAnySubstring(o.referenceText, LEAD_GEN_TERMS) || (o.declared.isLeadGeneration === true ? "declared" : null);
  if (leadGen) {
    add("lead_generation_page", `The source looks like a lead-resale page rather than a locksmith's own presence (${leadGen}). Calling it reaches a broker, not a business that could use AIDA.`);
  }

  // Not a locksmith. Two ways to fail: nothing says locksmith, or something
  // says a different trade and nothing says locksmith.
  const tradeHit = hasAnyWord(o.tradeText, LOCKSMITH_TERMS);
  const otherTrade = OTHER_TRADE_TERMS.find((t) => o.tradeText.includes(norm(t)));
  if (!tradeHit) {
    add("not_a_locksmith", otherTrade ? `Nothing identifies this as a locksmith, and the record mentions "${otherTrade}".` : "Nothing in the name, category or trade evidence identifies this as a locksmith.");
  }

  // A national switchboard. Requires BOTH a national claim AND no local
  // presence — being big is not the problem, having nobody local is.
  const nationalClaim = hasAnySubstring(o.areaText, NATIONAL_TERMS) || hasAnySubstring(o.serviceText, NATIONAL_TERMS);
  const hasLocalPresence = Boolean(prospect.suburb) && o.phones.callable.some((p) => p.kind === "landline" || p.kind === "mobile");
  if (nationalClaim && !hasLocalPresence) {
    add("national_call_centre", `States national coverage ("${nationalClaim}") with no local number or locality. That is a switchboard, not the local operator AIDA is for.`);
  }

  // Nothing we would ever dial. Distinct from "no number": a premium-rate line
  // is a number, and dialling it would cost the RECIPIENT money.
  if (o.phones.numbers.length > 0 && o.phones.callable.length === 0) {
    add("no_callable_number_kind", `Every published number is of a kind we never dial (${[...new Set(o.phones.numbers.map((n) => n.kind))].join(", ")}).`);
  }

  if (o.declared.alreadyAClient === true) {
    add("already_a_client", "Already an AIDA client.");
  }

  // Market. Checked last so a business that fails for a substantive reason
  // reports that reason first.
  const states = (o.market && o.market.states) || DEFAULT_TARGET_MARKET.states;
  if (prospect.state && !states.includes(String(prospect.state).toUpperCase())) {
    add("outside_target_market", `${prospect.state} is not a market we currently serve.`);
  }

  return out;
}

/** Resolve every signal against the observations. Pure; no ordering effects. */
function resolveSignals(prospect, o) {
  const facts = {};

  facts.trade_evidence_locksmith = (() => {
    const hit = hasAnyWord(o.tradeText, LOCKSMITH_TERMS);
    if (!hit) return no();
    // A trade claim with no evidence row behind it is the prospect's own
    // category field, which is weaker but still observed. Say which.
    const backed = (o.byKind.get("trade_category") || []).length > 0;
    return yes(backed ? `"${hit}", with trade evidence recorded` : `"${hit}", from the record only — no trade evidence captured`);
  })();

  facts.official_source = o.sources.hasOfficialSource ? yes(o.sources.officialSource.label) : no();
  facts.own_website = (o.sources.sources || []).some((s) => s.sourceType === "official_website") ? yes() : no();
  facts.abn_registered = prospect.abn ? yes(prospect.abn) : no();
  facts.still_trading_evidence = (o.byKind.get("operating_status") || []).length > 0 ? yes() : unknown();

  facts.callable_number = o.phones.callable.length > 0 ? yes(o.phones.callable.map((p) => p.kindLabel.toLowerCase()).join(", ")) : no();
  facts.service_number_published = o.phones.callable.some((p) => p.kind === "service") ? yes() : no();
  facts.multiple_published_numbers = o.phones.callable.length > 1 ? yes(String(o.phones.callable.length)) : no();

  facts.emergency_service_advertised = (() => {
    const hit = hasAnySubstring(o.serviceText, EMERGENCY_TERMS.map((t) => norm(t)));
    if (hit) return yes(hit);
    // No service text at all is not the same as service text that says nothing
    // about emergencies. The first is unknown; the second is a real "no".
    return o.serviceText ? no() : unknown();
  })();

  facts.broad_service_area = (() => {
    if (!o.areaText) return unknown();
    const declaredCount = Number.isInteger(o.declared.serviceAreaSuburbCount) ? o.declared.serviceAreaSuburbCount : null;
    if (declaredCount !== null) return declaredCount >= 5 ? yes(`${declaredCount} suburbs`) : no();
    // Counting commas in a stated area is crude, and crude is fine here as long
    // as it is stated: this signal is worth 5 points and is never decisive.
    const parts = o.areaText.split(/\band\b|,/).map((p) => p.trim()).filter(Boolean);
    return parts.length >= 5 ? yes(`${parts.length} named areas`) : no();
  })();

  facts.team_size_stated = (() => {
    const n = o.declared.technicianCount;
    if (!Number.isInteger(n)) return unknown();
    return n > 1 ? yes(String(n)) : no();
  })();

  facts.in_target_market = (() => {
    if (!prospect.state) return unknown();
    const states = (o.market && o.market.states) || DEFAULT_TARGET_MARKET.states;
    return states.includes(String(prospect.state).toUpperCase()) ? yes(`${prospect.suburb ? `${prospect.suburb}, ` : ""}${prospect.state}`) : no();
  })();

  // ── Inferences. Each reads FACTS ONLY, never other inferences, so the
  // reasoning is one layer deep and cannot become circular.
  const inferences = {};

  inferences.likely_loses_calls =
    facts.emergency_service_advertised.yes && facts.callable_number.yes
      ? yes("advertises after-hours work and publishes a number")
      : facts.emergency_service_advertised.unknown
        ? unknown()
        : no();

  inferences.likely_mobile_operator = (() => {
    const mobiles = o.phones.callable.filter((p) => p.kind === "mobile");
    if (o.phones.callable.length === 0) return unknown();
    return mobiles.length > 0 && mobiles.length === o.phones.callable.length ? yes("every published number is a mobile") : no();
  })();

  inferences.likely_multi_technician = (() => {
    if (facts.team_size_stated.yes) return yes(`stated: ${facts.team_size_stated.detail} technicians`);
    const supporting = [facts.multiple_published_numbers.yes, facts.broad_service_area.yes].filter(Boolean).length;
    if (supporting >= 2) return yes("several numbers and a wide service area");
    if (facts.team_size_stated.unknown && facts.broad_service_area.unknown) return unknown();
    return no();
  })();

  inferences.likely_local_operator = facts.own_website.yes && facts.in_target_market.yes && !facts.service_number_published.yes ? yes() : facts.in_target_market.unknown ? unknown() : no();

  return { facts, inferences };
}

/**
 * Qualify one prospect.
 *
 * @param {object} prospect       an A1 prospect
 * @param {Array}  [evidenceRows] its evidence — facts without evidence are weaker, and say so
 * @param {object} [declared]     operator-attested values we cannot observe
 *                                (technicianCount, serviceAreaSuburbCount,
 *                                servicesText, isLeadGeneration, alreadyAClient).
 *                                Attested, never inferred — see `attested`.
 * @param {object} [market]       { states } — defaults to the whole of AU
 * @param {Date}   [at]           the evaluation instant, recorded on the result
 */
function qualifyProspect(prospect, { evidenceRows = [], declared = null, market = null, at = null } = {}) {
  // An array is `typeof "object"`, so the obvious guard lets `[]` through and
  // every property read below silently yields undefined — a record that scores
  // as though it were simply a thin business rather than not a business at all.
  // createProspect() rejects arrays explicitly for the same reason.
  if (!prospect || typeof prospect !== "object" || Array.isArray(prospect)) {
    return Object.freeze({
      ok: false,
      verdict: "insufficient_information",
      verdictLabel: S.QUALIFICATION_VERDICT_LABELS.insufficient_information,
      tier: "excluded",
      score: 0,
      prospectId: null,
      businessName: null,
      signals: Object.freeze([]),
      facts: Object.freeze([]),
      inferences: Object.freeze([]),
      unknowns: Object.freeze([]),
      disqualifiers: Object.freeze([{ code: "not_a_locksmith", label: S.DISQUALIFIER_LABELS.not_a_locksmith, why: "There is no prospect record to assess." }]),
      attested: Object.freeze([]),
      evaluatedAt: at instanceof Date ? at.toISOString() : null,
      message: "There is no prospect record to assess.",
    });
  }

  const o = observe(prospect, evidenceRows, declared, market);
  const disqualifiers = findDisqualifiers(prospect, o);
  const { facts, inferences } = resolveSignals(prospect, o);

  // Assemble one flat, ordered list. Order is the table's order, not the order
  // things happened to be computed in, so two runs render identically.
  const rows = SIGNALS.map((spec) => {
    const r = (spec.kind === "fact" ? facts : inferences)[spec.key] || unknown();
    const weight = spec.kind === "inference" ? INFERENCE_WEIGHT : 1;
    const points = r.yes ? Math.round(spec.points * weight) : 0;
    return Object.freeze({
      key: spec.key,
      kind: spec.kind,
      label: spec.label,
      status: r.unknown ? "unknown" : r.yes ? "yes" : "no",
      points,
      maxPoints: Math.round(spec.points * weight),
      detail: r.detail,
      basis: spec.basis ? Object.freeze([...spec.basis]) : null,
      why: spec.describe(r),
    });
  });

  const score = rows.reduce((sum, r) => sum + r.points, 0);

  const unknowns = [
    ...rows.filter((r) => r.status === "unknown").map((r) => Object.freeze({ key: r.key, label: r.label, why: "Not established from what we hold." })),
    // The three we can never see from outside are listed every time, whether or
    // not anything else is unknown. Their absence from a report would read as
    // "we checked and it was fine".
    ...NEVER_OBSERVABLE.map((u) => Object.freeze({ ...u, observable: false })),
  ];

  // Which `declared` values were actually used. An operator attestation is not
  // an observation, and a founder reading a ranking is entitled to know that
  // "12 technicians" came from a person, not from the world.
  const attested = Object.entries(o.declared)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => Object.freeze({ key: k, value: v, source: "operator attestation" }));

  const tier = disqualifiers.length > 0 ? "excluded" : (TIER_BANDS.find((b) => score >= b.min) || { tier: "excluded" }).tier;

  // The verdict distinguishes three failures that look the same in a list and
  // mean entirely different things to whoever has to act on them.
  let verdict;
  if (disqualifiers.length > 0) verdict = "disqualified";
  else if (!facts.trade_evidence_locksmith.yes || !facts.callable_number.yes) verdict = "insufficient_information";
  else if (score >= QUALIFICATION_MINIMUM) verdict = "qualified";
  else verdict = "not_qualified";

  return Object.freeze({
    ok: true,
    verdict,
    verdictLabel: S.QUALIFICATION_VERDICT_LABELS[verdict],
    tier,
    tierLabel: S.QUALIFICATION_TIER_LABELS[tier],
    score,
    qualified: verdict === "qualified",

    prospectId: prospect.prospectId || null,
    businessName: prospect.businessName || null,

    signals: Object.freeze(rows),
    facts: Object.freeze(rows.filter((r) => r.kind === "fact")),
    inferences: Object.freeze(rows.filter((r) => r.kind === "inference")),
    // Only what actually contributed, highest first — the answer to "why is
    // this one near the top?" without reading the whole table.
    contributing: Object.freeze([...rows.filter((r) => r.points > 0)].sort((a, b) => b.points - a.points || (a.key < b.key ? -1 : 1))),
    unknowns: Object.freeze(unknowns),
    disqualifiers: Object.freeze(disqualifiers),
    attested: Object.freeze(attested),

    // Ranking inputs, captured so the sort is reproducible from the result
    // alone and does not have to re-read the prospect.
    ranking: Object.freeze({
      score,
      hasOfficialSource: o.sources.hasOfficialSource,
      factCount: rows.filter((r) => r.kind === "fact" && r.status === "yes").length,
      unknownCount: rows.filter((r) => r.status === "unknown").length,
      discoveredAt: prospect.discoveredAt || null,
      prospectId: prospect.prospectId || "",
    }),

    evaluatedAt: at instanceof Date && Number.isFinite(at.getTime()) ? at.toISOString() : null,
    message: describeVerdict(verdict, tier, score, disqualifiers),
  });
}

function describeVerdict(verdict, tier, score, disqualifiers) {
  if (verdict === "disqualified") return `Ruled out: ${disqualifiers.map((d) => d.label.toLowerCase()).join("; ")}.`;
  if (verdict === "insufficient_information") return "We do not know enough about this business to say whether it is worth approaching.";
  if (verdict === "qualified") return `${S.QUALIFICATION_TIER_LABELS[tier]} (${score} points).`;
  return `Does not clear the bar for approaching (${score} points, ${QUALIFICATION_MINIMUM} needed).`;
}

// ── Ranking ─────────────────────────────────────────────────────────
//
// Deterministic and explainable. Every tie-break is NAMED and ordered, so
// "why is this locksmith above that one?" always has an answer, and two runs
// over the same set produce byte-identical order regardless of input order.
const TIE_BREAKERS = Object.freeze([
  { key: "score", label: "higher qualification score", get: (r) => r.ranking.score, direction: "desc" },
  { key: "officialSource", label: "confirmed from an official source", get: (r) => (r.ranking.hasOfficialSource ? 1 : 0), direction: "desc" },
  { key: "factCount", label: "more facts established", get: (r) => r.ranking.factCount, direction: "desc" },
  { key: "unknownCount", label: "fewer unknowns", get: (r) => r.ranking.unknownCount, direction: "asc" },
  // First found, first approached. A fair, stable rule that does not depend on
  // anything we might later change our minds about.
  { key: "discoveredAt", label: "found earlier", get: (r) => r.ranking.discoveredAt || "9999", direction: "asc" },
  // The final, always-decisive key. Without it the sort is not a total order
  // and two equal prospects could swap places between runs.
  { key: "prospectId", label: "identifier order", get: (r) => r.ranking.prospectId, direction: "asc" },
]);

function cmp(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Why is `a` ranked above `b`? Returns the FIRST tie-breaker that separates
 * them, in plain language, or null if they are genuinely indistinguishable.
 */
function compareQualifications(a, b) {
  for (const t of TIE_BREAKERS) {
    const av = t.get(a);
    const bv = t.get(b);
    const c = t.direction === "desc" ? -cmp(av, bv) : cmp(av, bv);
    if (c !== 0) {
      const winner = c < 0 ? a : b;
      const loser = c < 0 ? b : a;
      return Object.freeze({
        order: c,
        decidedBy: t.key,
        reason: `${winner.businessName || winner.prospectId} ranks above ${loser.businessName || loser.prospectId}: ${t.label} (${t.get(winner)} vs ${t.get(loser)}).`,
        // For the score case, name the signals that actually differ — that is
        // the answer a founder wanted when they asked.
        differingSignals: t.key === "score" ? differingSignals(winner, loser) : null,
      });
    }
  }
  return null;
}

function differingSignals(winner, loser) {
  const loserByKey = new Map(loser.signals.map((s) => [s.key, s]));
  return Object.freeze(
    winner.signals
      .filter((s) => {
        const other = loserByKey.get(s.key);
        return other && s.points !== other.points;
      })
      .map((s) => Object.freeze({ key: s.key, label: s.label, winner: s.points, loser: loserByKey.get(s.key).points }))
      .sort((x, y) => y.winner - x.winner - (y.loser - x.loser) || cmp(x.key, y.key))
  );
}

/**
 * Order a list of assessments. Disqualified records sort to the bottom
 * regardless of score — a ruled-out business must never appear above a live one
 * because it happened to have a website.
 */
function rankQualified(assessments) {
  const list = (Array.isArray(assessments) ? assessments : []).filter((a) => a && a.ok);
  return Object.freeze(
    [...list].sort((a, b) => {
      const ad = a.disqualifiers.length > 0 ? 1 : 0;
      const bd = b.disqualifiers.length > 0 ? 1 : 0;
      if (ad !== bd) return ad - bd;
      for (const t of TIE_BREAKERS) {
        const c = t.direction === "desc" ? -cmp(t.get(a), t.get(b)) : cmp(t.get(a), t.get(b));
        if (c !== 0) return c;
      }
      return 0;
    })
  );
}

/** A founder-facing paragraph. Weaknesses before strengths, as the review packet does. */
function describeQualification(assessment) {
  if (!assessment || !assessment.ok) return "We could not assess this business.";
  const lines = [assessment.message];
  if (assessment.disqualifiers.length) {
    lines.push(...assessment.disqualifiers.map((d) => `  ✗ ${d.why}`));
    return lines.join("\n");
  }
  const top = assessment.contributing.slice(0, 5);
  if (top.length) lines.push(...top.map((s) => `  ${s.kind === "fact" ? "•" : "≈"} ${s.why} (+${s.points})`));
  const observable = assessment.unknowns.filter((u) => u.observable !== false);
  if (observable.length) lines.push(`  ? Not established: ${observable.map((u) => u.label.toLowerCase()).join(", ")}.`);
  lines.push(`  ? Never visible from outside: ${NEVER_OBSERVABLE.map((u) => u.label.toLowerCase()).join(", ")}.`);
  return lines.join("\n");
}

module.exports = {
  qualifyProspect,
  rankQualified,
  compareQualifications,
  describeQualification,
  SIGNALS,
  SIGNAL_BY_KEY,
  TIE_BREAKERS,
  TIER_BANDS,
  QUALIFICATION_MINIMUM,
  INFERENCE_WEIGHT,
  NEVER_OBSERVABLE,
  DEFAULT_TARGET_MARKET,
  LOCKSMITH_TERMS,
};
