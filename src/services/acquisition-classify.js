// AIDA Locksmith Acquisition — is this actually a locksmith? (M8F)
//
//   classifyBusiness({ businessName, tradeCategory, website, serviceArea, ... })
//     → { verdict, confidence, signals, reviewReason }
//
// A real directory export is mostly not locksmiths. It contains hardware shops,
// security installers, property managers, national lead-generation pages
// wearing a suburb name, and the occasional plumber. Something has to say which
// rows are worth a founder's attention, and it has to be able to explain why.
//
// ── NAMED SIGNALS, NOT A SCORE NOBODY CAN ARGUE WITH ────────────────
// The same discipline acquisition-dedupe uses. Every verdict is produced by
// signals that fired, each with a name and a direction, and they come back with
// the answer. "Category says Locksmith, name says Locksmith, website is its
// own domain" is reviewable. "0.87" is not.
//
// ── NO LLM, AND THIS IS A DELIBERATE CEILING ────────────────────────
// Not because a model would classify badly — it would probably do well — but
// because this decides who gets phoned. A deterministic table gives the same
// answer twice, can be diffed when it changes, and can be argued with by
// someone holding the row. A model's answer can be none of those, and "the
// classifier thought it was a locksmith" is not something to say to a business
// that was called by mistake.
//
// A model may LATER propose rows for review. It may never be what admits one.
//
// ── FACTS AND INFERENCES STAY APART ─────────────────────────────────
// If the export's own category column says "Locksmith", that is a FACT about
// what the source published, and it is recorded as one. That the business
// therefore is a locksmith is an INFERENCE. The distinction is carried into the
// signals so a reviewer can see which is which, exactly as
// acquisition-qualification does.
//
// Pure + dep-free. See test/acquisition-classify.test.js.

/** Category or name text that positively indicates a locksmith. */
const LOCKSMITH_TERMS = Object.freeze([
  "locksmith",
  "locksmiths",
  "lock and key",
  "lock & key",
  "locks and keys",
  "key cutting",
  "rekeying",
  "re-keying",
  "lockout service",
  "auto locksmith",
  "automotive locksmith",
  "mobile locksmith",
]);

/** Adjacent but NOT sufficient on its own. */
const ADJACENT_TERMS = Object.freeze(["lock", "locks", "keys", "security", "safes", "access control"]);

/** Trades that are definitely not this. */
const OTHER_TRADE_TERMS = Object.freeze([
  "plumber",
  "plumbing",
  "electrician",
  "electrical",
  "carpenter",
  "roofing",
  "landscap",
  "painter",
  "pest control",
  "glazier",
  "handyman",
  "real estate",
  "property management",
  "property manager",
  "conveyanc",
  "hardware store",
  "hardware shop",
  "building supplies",
  "car dealer",
  "panel beater",
  "towing",
]);

/** Words a lead-generation or aggregator page wears. */
const AGGREGATOR_TERMS = Object.freeze([
  "near me",
  "find a",
  "find the best",
  "compare quotes",
  "get quotes",
  "quotes from",
  "directory",
  "listings",
  "trade services",
  "book a tradie",
  "local pros",
  "24/7 service network",
  "service network",
  "nationwide",
  "australia wide",
  "australia-wide",
]);

/** Hosts that are directories rather than a business's own site. */
const AGGREGATOR_HOSTS = Object.freeze([
  "yellowpages.com.au",
  "truelocal.com.au",
  "hotfrog.com.au",
  "cylex.com.au",
  "localsearch.com.au",
  "aussieweb.com.au",
  "startlocal.com.au",
  "oneflare.com.au",
  "hipages.com.au",
  "airtasker.com",
  "serviceseeking.com.au",
  "yelp.com",
  "facebook.com",
  "linktr.ee",
]);

const VERDICTS = Object.freeze(["locksmith", "likely_locksmith", "needs_review", "not_locksmith", "aggregator"]);

const lower = (v) => (typeof v === "string" ? v.toLowerCase() : "");
const hasAny = (haystack, terms) => terms.filter((t) => haystack.includes(t));

function hostOf(url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const signal = (id, direction, fact, message) => Object.freeze({ id, direction, kind: fact ? "fact" : "inference", message });

/**
 * Classify one business.
 *
 * Never throws, never returns "probably fine". Where the evidence does not
 * decide, the verdict is `needs_review` and a founder is asked — which is the
 * correct outcome far more often than the pipeline would like.
 */
function classifyBusiness(record = {}) {
  const name = lower(record.businessName);
  const category = lower(record.tradeCategory);
  const service = lower(record.serviceArea);
  const website = typeof record.website === "string" ? record.website : null;
  const host = hostOf(website);
  const signals = [];

  // ── 1. What the source SAID. A fact about the export, recorded as one. ──
  const categoryHits = hasAny(category, LOCKSMITH_TERMS);
  const nameHits = hasAny(name, LOCKSMITH_TERMS);
  if (categoryHits.length > 0) signals.push(signal("category_says_locksmith", "positive", true, `The source's own category column says "${record.tradeCategory}".`));
  if (nameHits.length > 0) signals.push(signal("name_says_locksmith", "positive", true, `The published business name contains "${nameHits[0]}".`));

  // ── 2. What it says it is NOT ──
  const otherTrade = hasAny(`${category} ${name}`, OTHER_TRADE_TERMS);
  if (otherTrade.length > 0) signals.push(signal("other_trade", "negative", true, `Names an unrelated trade: "${otherTrade[0]}".`));

  // ── 3. Aggregator / lead-generation shape ──
  //
  // SPLIT BY WHERE THE MARKER APPEARS, AND THIS IS THE WHOLE TRICK.
  //
  // A lead-generation page's category column says "Locksmith" — that is the
  // entire point of it. So category can never be what rules one out, and an
  // earlier version of this module let "Locksmith Near Me 24/7" through as a
  // clean import for exactly that reason. Only its own website gave it away,
  // which meant a funnel hosted on its own domain would have been imported and
  // queued.
  //
  // A real business almost never NAMES itself "near me", "compare quotes" or
  // "find a locksmith". A marker in the NAME is therefore decisive on its own.
  // The same words in a description are weaker — a genuine locksmith may write
  // "servicing Melbourne and nationwide" — so those go to a human instead.
  const nameAggregator = hasAny(name, AGGREGATOR_TERMS);
  const descriptionAggregator = hasAny(service, AGGREGATOR_TERMS);
  const aggregatorHost = host && AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

  if (nameAggregator.length > 0) signals.push(signal("aggregator_name", "negative", true, `The business NAME reads like a lead-generation page: "${nameAggregator[0]}".`));
  if (descriptionAggregator.length > 0) signals.push(signal("aggregator_language", "negative", true, `Its description reads like a lead-generation page: "${descriptionAggregator[0]}".`));
  if (aggregatorHost) signals.push(signal("aggregator_website", "negative", true, `Its website is a directory (${host}), not the business's own domain.`));

  // ── 4. Its own domain is weak positive evidence of a real business ──
  if (host && !aggregatorHost) signals.push(signal("own_domain", "positive", false, `Has what appears to be its own domain (${host}).`));

  // ── 5. Adjacent-but-not-decisive ──
  const adjacent = hasAny(`${category} ${name}`, ADJACENT_TERMS);
  if (categoryHits.length === 0 && nameHits.length === 0 && adjacent.length > 0) {
    signals.push(signal("lock_adjacent", "neutral", true, `Mentions "${adjacent[0]}" but never says locksmith. A security installer and a locksmith are not the same trade.`));
  }

  // ── 6. Nothing at all to go on ──
  if (category === "" && name === "") signals.push(signal("no_identity_text", "negative", true, "The row has neither a business name nor a category."));

  // ── Verdict ──────────────────────────────────────────────────────
  // Order matters and is precedence, not convenience. A page that is a
  // lead-generation funnel is reported as one EVEN IF it says locksmith
  // everywhere, because saying locksmith is exactly what those pages do.

  let verdict;
  let confidence;
  let reviewReason = null;

  if (aggregatorHost || nameAggregator.length > 0) {
    // Decisive REGARDLESS of category, because the category is what these
    // pages fake.
    verdict = "aggregator";
    confidence = aggregatorHost || nameAggregator.length > 1 ? "conclusive" : "strong";
    reviewReason = "not_a_locksmith";
  } else if (descriptionAggregator.length > 0) {
    // Weaker evidence, so it buys a human rather than a verdict.
    verdict = "needs_review";
    confidence = "weak";
    reviewReason = "not_a_locksmith";
  } else if (otherTrade.length > 0 && categoryHits.length === 0 && nameHits.length === 0) {
    verdict = "not_locksmith";
    confidence = "strong";
    reviewReason = "not_a_locksmith";
  } else if (categoryHits.length > 0 && otherTrade.length === 0) {
    // The source's own category is the strongest thing a directory export
    // carries. Corroborated by the name, it is as good as this gets offline.
    verdict = nameHits.length > 0 ? "locksmith" : "likely_locksmith";
    confidence = nameHits.length > 0 ? "conclusive" : "strong";
  } else if (nameHits.length > 0 && otherTrade.length === 0) {
    verdict = "likely_locksmith";
    confidence = "moderate";
  } else if (categoryHits.length > 0 && otherTrade.length > 0) {
    // Says both. A hardware store with a key-cutting counter is a real case
    // and is not a locksmith call target — but it is not this module's to
    // decide alone.
    verdict = "needs_review";
    confidence = "weak";
    reviewReason = "not_a_locksmith";
  } else {
    verdict = "needs_review";
    confidence = "weak";
    reviewReason = adjacent.length > 0 ? "not_a_locksmith" : "evidence_insufficient";
  }

  return Object.freeze({
    verdict,
    confidence,
    isLocksmith: verdict === "locksmith" || verdict === "likely_locksmith",
    signals: Object.freeze(signals),
    reviewReason,
    message: describeVerdict(verdict, signals),
  });
}

function describeVerdict(verdict, signals) {
  const positives = signals.filter((s) => s.direction === "positive");
  const negatives = signals.filter((s) => s.direction === "negative");
  switch (verdict) {
    case "locksmith":
      return `A locksmith: ${positives.map((s) => s.message).join(" ")}`;
    case "likely_locksmith":
      return `Probably a locksmith. ${positives.map((s) => s.message).join(" ")} A human should confirm before it is called.`;
    case "aggregator":
      return `A lead-generation or directory page rather than a locksmith. ${negatives.map((s) => s.message).join(" ")}`;
    case "not_locksmith":
      return `Not a locksmith. ${negatives.map((s) => s.message).join(" ")}`;
    default:
      return `Cannot tell from this row. ${signals.map((s) => s.message).join(" ") || "There is nothing in it that names a trade."}`;
  }
}

module.exports = { classifyBusiness, VERDICTS, LOCKSMITH_TERMS, AGGREGATOR_HOSTS };
