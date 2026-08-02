// AIDA Locksmith Acquisition — phone normalisation and classification (A2).
//
//   normalisePhone(raw)     one published number → E.164 + a classification
//   describePhone(result)   a plain-language sentence about it
//
// The pipeline's fifth step is "phone number normalised". It happens AFTER
// human review, deliberately: the number a reviewer checks against the source
// must be the number as published, and rewriting it first would destroy the
// thing being reviewed.
//
// WHY THIS RETURNS A CLASSIFICATION RATHER THAN null
// The repo already has normaliseAuNumber() in locksmith-profile.js, which
// answers "is this a usable transfer target?" with a number or null. That is
// the right shape there. Here it is the wrong shape: the eligibility engine has
// to be able to SAY, in a founder-facing sentence, *why* a number will not be
// called — "that is a 13 service number, which reaches a switchboard, not this
// business" is useful; a silent null is not.
//
// The two must agree wherever they overlap, and a test asserts that so they
// cannot drift apart.
//
// WHAT IS DELIBERATELY NOT CALLABLE
//   premium (190x)  dialling one can cost the RECIPIENT money
//   short   (13xxxx) reaches a shared switchboard, not a specific business
// Both classify successfully — we know exactly what they are — but neither is
// in CALLABLE_PHONE_KINDS, so the eligibility engine vetoes them with a reason
// a human can read.
//
// Pure + dep-free. See test/acquisition-phone.test.js.

const S = require("./acquisition-schema");

// Australian geographic area codes. 01/05/06/09 are not geographic subscriber
// prefixes, so a number starting with one of them is not a landline.
const GEOGRAPHIC_PREFIXES = Object.freeze(["2", "3", "7", "8"]);

/**
 * Reduce a published number to digits plus an optional leading +.
 * Extension suffixes ("x123", "ext 4") are DROPPED with a note rather than
 * silently concatenated — "0355501042x12" parsed as a 12-digit number is how a
 * valid number becomes invalid for no visible reason.
 */
function clean(raw) {
  if (typeof raw !== "string") return { digits: "", hadExtension: false };
  let value = raw.trim();

  // Cut anything from an extension marker onward. No \b before the marker:
  // "0355501042x12" has no word boundary between the digit and the "x", which
  // is exactly the form that most needs handling.
  const extMatch = value.match(/(?:x|ext|extn|extension)\.?\s*\d+\s*$/i);
  const hadExtension = Boolean(extMatch);
  if (extMatch) value = value.slice(0, extMatch.index);

  const plus = value.trimStart().startsWith("+");
  const digits = value.replace(/\D/g, "");
  return { digits: plus ? `+${digits}` : digits, hadExtension };
}

/**
 * Convert any accepted international/trunk form to the NATIONAL form
 * (leading 0 for subscriber numbers, bare for 13/1300/1800/190x).
 * Returns null when the input cannot be read as Australian.
 */
function toNational(cleaned) {
  let value = cleaned;

  if (value.startsWith("+61")) value = value.slice(3);
  else if (value.startsWith("+")) return null; // a different country
  else if (value.startsWith("0011 61")) value = value.slice(7);
  else if (value.startsWith("001161")) value = value.slice(6);
  else if (value.startsWith("61") && (value.length === 11 || value.length === 12)) value = value.slice(2);
  else if (value.startsWith("0")) return value; // already national
  else return value; // bare: 1300…, 13…, 190…, or a malformed fragment

  // After stripping +61 the trunk 0 is absent for subscriber numbers, and
  // present for nothing. Restore it only for the 8-9 digit subscriber forms;
  // 1300/1800/13/190 numbers carry their own leading 1.
  if (value.startsWith("1")) return value;
  return `0${value}`;
}

/**
 * Normalise and classify one published Australian number.
 *
 * Returns:
 *   { ok:true,  e164, national, kind, kindLabel, callable, notes }
 *   { ok:false, kind:"invalid", reason, notes }
 *
 * Never throws. A published number that is nonsense is a data-quality finding
 * that belongs in a report, not an exception that stops a batch.
 */
function normalisePhone(raw) {
  const { digits, hadExtension } = clean(raw);
  const notes = [];
  if (hadExtension) notes.push("An extension was published with this number; the extension is not dialled.");

  if (!digits || digits === "+") {
    return { ok: false, kind: "invalid", kindLabel: S.PHONE_KIND_LABELS.invalid, callable: false, reason: "No digits were published.", notes };
  }

  const national = toNational(digits);
  if (national === null) {
    return {
      ok: false,
      kind: "invalid",
      kindLabel: S.PHONE_KIND_LABELS.invalid,
      callable: false,
      reason: "This is not an Australian number.",
      notes,
    };
  }

  const build = (kind, e164) => ({
    ok: true,
    e164,
    national,
    kind,
    kindLabel: S.PHONE_KIND_LABELS[kind],
    callable: S.CALLABLE_PHONE_KINDS.includes(kind),
    notes,
  });

  // ── Mobile: 04XX XXX XXX ─────────────────────────────────────────
  if (/^04\d{8}$/.test(national)) return build("mobile", `+61${national.slice(1)}`);

  // ── Landline: 0[2378] XXXX XXXX ──────────────────────────────────
  if (new RegExp(`^0[${GEOGRAPHIC_PREFIXES.join("")}]\\d{8}$`).test(national)) {
    return build("landline", `+61${national.slice(1)}`);
  }

  // ── 1300 / 1800: the leading 1 is PART OF THE NUMBER ─────────────
  // Dropping it, as one would a trunk prefix, produces a number that looks
  // plausible and rings nothing.
  if (/^1(300|800)\d{6}$/.test(national)) return build("service", `+61${national}`);

  // ── Premium rate: 190X ───────────────────────────────────────────
  // Classified, not rejected — we want to be able to say what it is.
  if (/^19\d{2}\d{4,6}$/.test(national)) return build("premium", `+61${national}`);

  // ── Short service numbers: 13 XX XX ──────────────────────────────
  // The (?!00) matters: 1300 is a distinct ten-digit prefix, so a six-digit
  // number beginning "1300" is not a short number — it is a TRUNCATED 1300
  // number, and must fall through to the wrong-length message below rather
  // than being silently accepted as something dialable.
  if (/^13(?!00)\d{4}$/.test(national)) return build("short", `+61${national}`);

  // 1300/1800 with the wrong number of digits is a common transcription error
  // and deserves its own message rather than a generic "invalid".
  if (/^1(300|800)\d*$/.test(national)) {
    return {
      ok: false,
      kind: "invalid",
      kindLabel: S.PHONE_KIND_LABELS.invalid,
      callable: false,
      reason: `A 1300/1800 number has ten digits; this one has ${national.length}.`,
      notes,
    };
  }

  const subscriberish = /^0\d+$/.test(national);
  return {
    ok: false,
    kind: "invalid",
    kindLabel: S.PHONE_KIND_LABELS.invalid,
    callable: false,
    reason: subscriberish
      ? `An Australian landline or mobile has ten digits; this one has ${national.length}.`
      : "This is not a recognisable Australian phone number.",
    notes,
  };
}

/** A founder-facing sentence about one normalised number. */
function describePhone(result, raw = null) {
  const shown = raw ? `"${String(raw).slice(0, 40)}"` : "This number";
  if (!result.ok) return `${shown} could not be read: ${result.reason}`;
  if (result.kind === "premium") {
    return `${shown} is a premium-rate number (${result.e164}). Calling it can cost the person who answers money, so AIDA never dials one.`;
  }
  if (result.kind === "short") {
    return `${shown} is a 13 service number (${result.e164}). These reach a shared switchboard rather than one business, so AIDA does not dial them.`;
  }
  return `${shown} is a ${result.kindLabel.toLowerCase()} (${result.e164}).`;
}

/**
 * Normalise every number on a prospect, keeping the published form beside the
 * result. Returns { numbers, callable, problems } — `problems` is what a human
 * needs to see, and is never empty just because one number worked.
 */
function normaliseProspectPhones(prospect) {
  const numbers = (prospect && Array.isArray(prospect.phones) ? prospect.phones : []).map((phone) => {
    const result = normalisePhone(phone.raw);
    return { raw: phone.raw, label: phone.label || null, evidenceId: phone.evidenceId || null, ...result };
  });

  return {
    numbers,
    callable: numbers.filter((n) => n.ok && n.callable),
    problems: numbers.filter((n) => !n.ok || !n.callable).map((n) => ({ raw: n.raw, kind: n.kind, message: describePhone(n, n.raw) })),
  };
}

module.exports = {
  normalisePhone,
  describePhone,
  normaliseProspectPhones,
  GEOGRAPHIC_PREFIXES,
};
