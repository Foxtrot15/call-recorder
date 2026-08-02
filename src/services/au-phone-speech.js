// AIDA — Australian phone-number presentation (M7E).
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────
// M7D's live web call proved the receptionist works. It also proved it says
// this out loud:
//
//     "plus six one, four nine one, five seven oh, oh oh six"
//
// because the runtime dynamic variable carries the canonical E.164 value and
// the model reads what it is given. No Australian expects to hear their own
// number in international form, and a caller who mishears a callback number
// does not get called back. That is a correctness defect, not a polish item.
//
// ─── THE RULE ───────────────────────────────────────────────────────
//   STORAGE and MACHINES use E.164.       +61491234567
//   HUMANS see the local display form.    0491 234 567
//   MODELS are given the spoken form.     "zero four nine one, two three four,
//                                          five six seven"
//
// The spoken and display forms are DERIVED, never stored and never accepted as
// input. That is what makes a corrected digit safe: change the canonical number
// and every presentation regenerates from it. There is no second copy to go
// stale, because there is no copy at all.
//
// ─── ONE NORMALISER, NOT TWO ────────────────────────────────────────
// The canonical gate is still `normaliseAuNumber` in locksmith-profile.js. This
// module does not re-implement it, widen it, or keep its own idea of what a
// dialable number is. It asks that function first and formats what it returns.
//
// The one deliberate exception is the 13xxxx short-number family, which
// `normaliseAuNumber` rejects ON PURPOSE — you cannot transfer a caller to a
// 13 number. A business may still HAVE one, and a receptionist may still need
// to say it, so this module recognises 13 numbers for PRESENTATION ONLY and
// marks them `transferEligible: false`. Recognising a number and being willing
// to dial it are different questions, and conflating them is how a 13 number
// would quietly become a transfer target.
//
// ─── NO SSML, NO TTS GUESSWORK ──────────────────────────────────────
// The output is plain deterministic text. Retell's documented prompt fields
// carry no validated SSML contract in this codebase, so nothing here emits
// markup. Grouping is expressed with commas, which every TTS engine already
// treats as a pause, rather than trusting an engine to infer that a run of
// eleven digits is a phone number. Digits are spelled as WORDS so no engine can
// decide "491234567" is four hundred and ninety-one million.
//
// Pure + dep-free.

const { normaliseAuNumber } = require("./locksmith-profile");

const SPEECH_VERSION = "au-phone-speech-2026-08-02";

// ── "zero", not "oh" (founder decision, M7I-C2) ─────────────────────
//
// M7E chose "oh" because that is how an Australian reads a number aloud. That
// was a fair reading of the convention and the wrong trade for this product.
//
// A phone number is confirmed over a phone line, often by somebody standing in
// the dark outside their own front door. "Oh" is a single unstressed vowel: it
// is the syllable most easily lost to line noise, it collides with the filler
// "oh" a caller says while thinking, and TTS voices differ in how much weight
// they give it. "Zero" has two syllables and a hard consonant, and it survives
// all three. Clarity beats idiom when a mis-heard digit means nobody gets
// called back.
//
// This is the ONE place the convention is defined. The compiler's prompt rules
// deliberately teach the same word, so the number a caller hears read back is
// said the same way whether the model composed it or was handed it.
//
// INPUT is unaffected and stays tolerant: locksmith-extraction-fixture.js maps
// BOTH "zero" and "oh" back to 0, because people say both and a transcript
// records what was said, not what we would have preferred.
const DIGIT_WORDS = Object.freeze({
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four",
  5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
});

const NUMBER_TYPES = Object.freeze({
  mobile: "mobile",
  landline: "landline",
  service1300: "service_1300",
  service1800: "service_1800",
  service13: "service_13",
  international: "international",
});

// Why a number produced no spoken form. Never null when `spoken` is null, so a
// caller can always explain the gap rather than showing an empty string.
const FALLBACK_REASONS = Object.freeze({
  empty: "empty_value",
  notText: "not_text",
  notAustralian: "not_australian",
  unrecognised: "unrecognised_format",
});

/**
 * Australian geographic area codes, and how a local writes them.
 *
 * 02/03/07/08 are the only geographic prefixes in the plan. They are listed
 * rather than matched with a range so an unexpected prefix falls through to
 * "unrecognised" instead of being formatted as though it were geographic.
 */
const GEOGRAPHIC_PREFIXES = Object.freeze(["02", "03", "07", "08"]);

// ── ONE DIGIT, ONE WORD (M7E decision, re-affirmed M7I-C) ───────────
//
// "006" is "zero zero six", NOT "double zero", and that is deliberate.
//
// M7I-C examined collapsing repeats, because the founder read their own number
// aloud as "…five zero double six" and Australians plainly do say "double". It
// was implemented, then reverted, for two reasons that outrank the idiom:
//
//   1. IT WAS NOT THE DEFECT. On the live M7I call the agent never spoke a
//      transfer number at all — this function's output was never voiced. What
//      the founder heard was the agent's own read-back of a CALLER-supplied
//      number, emitted as the digit string "0467 745 066" and pronounced by the
//      voice engine. That is fixed in the prompt, not here. Changing production
//      pronunciation on a path nobody heard is a guess wearing a fix's clothes.
//
//   2. IT BREAKS A MECHANICAL SAFETY CHECK. One-word-per-digit is what lets a
//      test recover the digits from the spoken string and prove none was lost,
//      gained or reordered (see "digits are never lost, added or altered").
//      "double oh" makes that verification ambiguous, and a silently dropped
//      digit in a callback number means nobody gets called back.
//
// If live audio shows the zeros are still unclear, this is the single place to
// change and both the transfer and read-back paths move together — the prompt
// deliberately teaches the same convention this function produces.
function digitsToWords(digits) {
  return digits.split("").map((d) => DIGIT_WORDS[d]).join(" ");
}

/**
 * Join digit groups into speech.
 *
 * A comma between groups is the entire mechanism: it is the pause an Australian
 * leaves between "zero four nine one" and "two three four", and it is what stops
 * a listener losing their place in a ten-digit run.
 */
function speakGroups(groups) {
  return groups.map(digitsToWords).join(", ");
}

/**
 * Split the national form of an Australian number into the groups a local uses.
 * Returns null when the shape is not one this module recognises.
 *
 * `national` is the leading-zero form for mobiles and landlines ("0491234567"),
 * and the number as dialled for 13/1300/1800 ("1300123456"), because for those
 * the leading 1 is part of the number rather than a trunk prefix.
 */
function groupNational(national) {
  // Mobile: 04XX XXX XXX. Only 04 — the canonical rule accepts 0[2-478], so 04
  // is the whole mobile range that can reach here, and claiming more would
  // advertise support the gate does not actually give.
  if (/^04\d{8}$/.test(national)) {
    return { type: NUMBER_TYPES.mobile, groups: [national.slice(0, 4), national.slice(4, 7), national.slice(7)] };
  }
  // Geographic landline: 0X XXXX XXXX.
  if (/^0\d{9}$/.test(national) && GEOGRAPHIC_PREFIXES.includes(national.slice(0, 2))) {
    return { type: NUMBER_TYPES.landline, groups: [national.slice(0, 2), national.slice(2, 6), national.slice(6)] };
  }
  // 1300/1800: XXXX XXX XXX. The leading 1 is part of the number.
  if (/^1300\d{6}$/.test(national)) {
    return { type: NUMBER_TYPES.service1300, groups: [national.slice(0, 4), national.slice(4, 7), national.slice(7)] };
  }
  if (/^1800\d{6}$/.test(national)) {
    return { type: NUMBER_TYPES.service1800, groups: [national.slice(0, 4), national.slice(4, 7), national.slice(7)] };
  }
  // 13 short numbers: 13 XX XX. Presentation only — see the header.
  if (/^13\d{4}$/.test(national)) {
    return { type: NUMBER_TYPES.service13, groups: [national.slice(0, 2), national.slice(2, 4), national.slice(4)] };
  }
  return null;
}

/**
 * The 13xxxx family, which `normaliseAuNumber` deliberately refuses.
 *
 * Kept separate and narrow so it cannot be mistaken for a widening of the
 * canonical rule: it returns a presentation E.164 only, and every caller is
 * told `transferEligible: false`.
 */
function recognise13(cleaned) {
  let national = cleaned;
  if (cleaned.startsWith("+61")) national = cleaned.slice(3);
  else if (cleaned.startsWith("61") && cleaned.length === 8) national = cleaned.slice(2);
  if (!/^13\d{4}$/.test(national)) return null;
  return { national, e164: `+61${national}` };
}

function refusal(reason, e164 = null, numberType = null) {
  return Object.freeze({
    ok: false,
    e164,
    display: null,
    spoken: null,
    masked: maskAuNumber(e164),
    numberType,
    localised: false,
    transferEligible: false,
    fallback: reason,
    version: SPEECH_VERSION,
  });
}

/**
 * Mask a number for a log line or a report: keep the last three digits only.
 *
 * Diagnostics and manifests are written to disk and pasted into tickets. Three
 * digits is enough for a human to confirm they are looking at the right call
 * and not enough to ring anybody.
 */
function maskAuNumber(raw) {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `•••••• ${digits.slice(-3)}`;
}

/**
 * Describe a phone number for presentation.
 *
 * @param {string} raw           any form a human or a store might hold
 * @param {object} [options]
 * @param {string} [options.purpose]  free-form label carried through to the
 *                                    result, e.g. "callback" or "transfer".
 *                                    Never changes the digits — it exists so a
 *                                    caller can tell two descriptors apart in a
 *                                    log without holding the number itself.
 * @returns {{ok, e164, display, spoken, masked, numberType, localised,
 *            transferEligible, fallback, purpose, version}}
 *
 * `e164` is ALWAYS the canonical value untouched. This function never alters,
 * pads or truncates a digit; it either recognises a shape or refuses.
 */
function describeAuNumber(raw, { purpose = null } = {}) {
  const withPurpose = (result) => Object.freeze({ ...result, purpose });

  if (raw === null || raw === undefined || raw === "") return withPurpose(refusal(FALLBACK_REASONS.empty));
  if (typeof raw !== "string") return withPurpose(refusal(FALLBACK_REASONS.notText));
  if (!raw.trim()) return withPurpose(refusal(FALLBACK_REASONS.empty));

  // The canonical gate first. Punctuation, spacing, a leading plus, a bare 61
  // prefix and an already-local form all converge here.
  const canonical = normaliseAuNumber(raw);
  if (canonical) {
    // Back to the national form the canonical rule started from. Mobiles and
    // landlines regain their trunk zero; 1300/1800 keep every digit, because
    // for them the 1 was never a trunk prefix.
    const rest = canonical.slice(3);
    const national = /^1(300|800)/.test(rest) ? rest : `0${rest}`;
    const grouped = groupNational(national);
    if (!grouped) {
      // The canonical rule accepted a shape this formatter does not know. Refuse
      // rather than improvise: a guessed grouping is a mis-read number.
      return withPurpose(refusal(FALLBACK_REASONS.unrecognised, canonical, null));
    }
    return withPurpose(Object.freeze({
      ok: true,
      e164: canonical,
      display: grouped.groups.join(" "),
      spoken: speakGroups(grouped.groups),
      masked: maskAuNumber(canonical),
      numberType: grouped.type,
      localised: true,
      transferEligible: true,
      fallback: null,
      version: SPEECH_VERSION,
    }));
  }

  // Not a transfer target. It may still be a 13 number we can SAY.
  const cleaned = typeof raw === "string" ? raw.replace(/[\s().-]/g, "") : "";
  if (/^\+?\d+$/.test(cleaned)) {
    const short = recognise13(cleaned);
    if (short) {
      const grouped = groupNational(short.national);
      return withPurpose(Object.freeze({
        ok: true,
        e164: short.e164,
        display: grouped.groups.join(" "),
        spoken: speakGroups(grouped.groups),
        masked: maskAuNumber(short.e164),
        numberType: NUMBER_TYPES.service13,
        localised: true,
        // The whole point of keeping this separate: sayable, not dialable.
        transferEligible: false,
        fallback: null,
        version: SPEECH_VERSION,
      }));
    }
    // A well-formed international number. Deliberately given NO spoken value:
    // reading "+1 415..." aloud is the exact failure this module exists to
    // remove, and inventing an Australian grouping for a foreign number would
    // be worse. The caller is asked to confirm the number instead.
    if (cleaned.startsWith("+") && cleaned.length >= 8) {
      return withPurpose(refusal(FALLBACK_REASONS.notAustralian, cleaned, NUMBER_TYPES.international));
    }
  }

  return withPurpose(refusal(FALLBACK_REASONS.unrecognised));
}

/**
 * The spoken form, or "" when there is none.
 *
 * Dynamic variables must be strings, and an absent variable renders as the
 * literal "{{name}}" in front of a caller — so the empty string is the correct
 * absence here, paired with the prompt rule that tells the agent to ask the
 * caller to confirm the number when it has nothing to read.
 */
function spokenAuNumber(raw) {
  const described = describeAuNumber(raw);
  return described.spoken || "";
}

/** The local display form, or "" when there is none. */
function displayAuNumber(raw) {
  const described = describeAuNumber(raw);
  return described.display || "";
}

/**
 * Does this text contain a number in international form?
 *
 * Used by the prompt regression tests and by the compiler's own guard. A
 * caller-facing instruction that interpolates "+61491234567" is the M7D defect
 * reappearing, and it is cheap to make that impossible rather than unlikely.
 */
function containsE164(text) {
  return typeof text === "string" && /\+\d{6,15}/.test(text);
}

module.exports = {
  SPEECH_VERSION,
  NUMBER_TYPES,
  FALLBACK_REASONS,
  GEOGRAPHIC_PREFIXES,
  DIGIT_WORDS,
  describeAuNumber,
  spokenAuNumber,
  displayAuNumber,
  maskAuNumber,
  containsE164,
};
