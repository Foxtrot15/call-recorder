// WEB-CALL-SETUP-1 (WCS-1a) — pure divert-code template engine + setup status
// machine for the client "Phone setup" flow (docs/WEB_CALL_SETUP_SPEC.md).
//
// Product stance encoded here: carrier GSM/MMI diversion codes are
// RECOMMENDED templates, not guaranteed truth. Every result carries the
// "try this first / support may vary" disclaimer, and per-carrier confidence
// is explicit ('standard' | 'varies' | 'unknown') so the UI can never present
// an MVNO code with the same certainty as a Telstra postpaid one.
//
// Deliberate design points:
//   * Templates are config-in-code, not DB rows. There is no admin UI to edit
//     a table, and SQL applies are human-gated — a reviewed code change is the
//     faster, safer edit path today. The future routing-profile row snapshots
//     the generated payload (with templateVersion) so what a user was shown
//     survives template evolution. Revisit a table when non-engineers edit.
//   * Nothing here touches the network, Twilio, or Supabase — this module is
//     loadable and fully testable dep-free (house rule), and nothing imports
//     it yet: WCS-1a ships it dormant. Routes/DB arrive in WCS-1b.
//   * desk phone / VoIP platforms never receive GSM codes: diversion for
//     those lives in the provider's own settings, and handing a VoIP user a
//     mobile MMI string as if it applies would be exactly the false certainty
//     this module exists to avoid. They get a manual-help result instead.
//
// The target number is the client's AIDA/Twilio number and is expected to be
// derived SERVER-SIDE (clients.twilio_number) by the future route — never
// from user input — so Aida-branded instructions can't be made to divert a
// phone to an arbitrary number.

const { normalisePhone } = require("./loop-guard"); // pure fn; shared phone.js dedup is a known follow-up (loop-guard.js header)

// Bump whenever template/registry wording or shape changes — the future
// profile row snapshots this so support can tell which generation a user saw.
const TEMPLATE_VERSION = "au-gsm-mmi-2026-07.1";

const RECOMMENDED_DISCLAIMER =
  "Recommended setup — try these codes first. Carrier support may vary by carrier and plan, " +
  "and some plans need call diversion enabled by the carrier before the codes will work.";

// AU E.164: +61 followed by 9 digits (mobiles +614…, geographic +612/3/7/8…).
// The AIDA number is always an AU Twilio number (CLIENT_ONBOARDING_RUNBOOK
// step 1 mandates E.164 +61…), so anything else is a provisioning error.
const AU_E164_RE = /^\+61\d{9}$/;

// ── Loop registry (the three conditional-diversion loops of v1) ─────────────
// `**{seconds}` in a template is an OPTIONAL segment: it is removed entirely
// when the carrier-default delay is used (seconds == null). Editors changing
// templates keep that convention or renderTemplate throws loudly (below).
const LOOPS = {
  no_answer: {
    label: "No answer / missed calls",
    description: "Diverts calls you don't answer before they ring out",
    activateTemplate: "**61*{target}**{seconds}#",
    cancelCode: "##61#",
    usesDelay: true,
  },
  busy: {
    label: "Busy / on another call",
    description: "Diverts calls that arrive while you're already on a call",
    activateTemplate: "**67*{target}#",
    cancelCode: "##67#",
    usesDelay: false,
  },
  unreachable: {
    label: "Unreachable / phone off",
    description: "Diverts calls when your phone is off or has no reception",
    activateTemplate: "**62*{target}#",
    cancelCode: "##62#",
    usesDelay: false,
  },
};
const LOOP_KEYS = Object.keys(LOOPS); // stable presentation order

const CANCEL_ALL = {
  code: "##002#",
  label: "Cancel ALL diversions",
  warning:
    "This cancels every diversion on your line, including any you set up yourself for other reasons.",
};

// null means "carrier default" (no **{seconds} segment dialled at all).
const NO_ANSWER_DELAY_OPTIONS = [15, 20, 25, 30];
const DEFAULT_NO_ANSWER_DELAY_SECONDS = 20;

// ── Carrier registry ────────────────────────────────────────────────────────
// Grounded in what the repo already asserts (CLIENT_ONBOARDING_RUNBOOK step 7,
// public/onboarding.html step 5): standard GSM codes are expected on the big
// three postpaid networks; prepaid/MVNO plans sometimes differ or need
// diversion enabled first. No external verification has been done — which is
// exactly why confidence tiers and the disclaimer exist.
const MVNO_NOTE =
  "Prepaid and MVNO plans sometimes use different codes or need call diversion enabled " +
  "via the carrier's app or support first. Try the codes — if none gives a confirmation, " +
  "tell us your carrier and plan and we'll help find the right setup.";

const STANDARD_NOTE =
  "Standard GSM diversion codes are expected to work on postpaid mobile plans. " +
  "Support may still vary by plan.";

const CARRIERS = {
  telstra: { label: "Telstra", confidence: "standard", notes: [STANDARD_NOTE] },
  optus: { label: "Optus", confidence: "standard", notes: [STANDARD_NOTE] },
  vodafone: { label: "Vodafone", confidence: "standard", notes: [STANDARD_NOTE] },
  boost: { label: "Boost Mobile", confidence: "varies", notes: [MVNO_NOTE] },
  amaysim: { label: "Amaysim", confidence: "varies", notes: [MVNO_NOTE] },
  aldi: { label: "ALDI Mobile", confidence: "varies", notes: [MVNO_NOTE] },
  other: {
    label: "Other / not sure",
    confidence: "unknown",
    notes: [
      "These are the standard GSM diversion codes most Australian carriers use. " +
        "If a code doesn't give a confirmation, tell us your carrier and we'll help.",
    ],
  },
};

// ── Platform registry ───────────────────────────────────────────────────────
// Diversion is a NETWORK feature, so handset brand only changes the dial hint
// — except desk/VoIP services, where GSM codes don't apply at all (kind is
// what buildDivertCodes branches on, so a future platform addition states its
// nature explicitly instead of inheriting mobile behaviour by accident).
const PLATFORMS = {
  iphone: {
    label: "iPhone",
    kind: "mobile",
    dialHint: "Open the Phone app, type each code exactly as shown, then tap the call button.",
  },
  samsung: {
    label: "Samsung",
    kind: "mobile",
    dialHint: "Open the Phone app, type each code exactly as shown, then tap the call button.",
  },
  pixel: {
    label: "Google Pixel",
    kind: "mobile",
    dialHint: "Open the Phone app, type each code exactly as shown, then tap the call button.",
  },
  other_android: {
    label: "Other Android",
    kind: "mobile",
    dialHint: "Open your phone/dialler app, type each code exactly as shown, then tap call.",
  },
  desk_voip: {
    label: "Desk phone / VoIP service",
    kind: "desk_voip",
    dialHint: null,
  },
  other: {
    label: "Other / not sure",
    kind: "unknown",
    dialHint: "Dial each code from the phone whose calls you want Aida to catch.",
  },
};

const MANUAL_HELP_NOTE =
  "Desk phone and VoIP providers manage call diversion in their own settings " +
  "(admin portal or handset menu), and the exact steps differ by provider. " +
  "We'll help you set this up — get in touch and tell us which provider you use.";

// ── Template rendering ──────────────────────────────────────────────────────

/**
 * Substitute {target} / the optional `**{seconds}` segment into a template.
 * Throws if any {placeholder} survives — a template edited into an invalid
 * shape must fail loudly at generate time, never emit a garbage dial string.
 */
function renderTemplate(template, { target, seconds } = {}) {
  let out = String(template);
  if (seconds == null) {
    out = out.split("**{seconds}").join(""); // optional segment: carrier default delay
  } else {
    out = out.split("{seconds}").join(String(seconds));
  }
  out = out.split("{target}").join(target == null ? "" : String(target));
  if (/[{}]/.test(out)) {
    throw new Error(`divert template left unresolved placeholders: "${out}" (from "${template}")`);
  }
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────────

// hasOwnProperty guard, not `in`/truthy lookup: registry keys arrive from
// request bodies in WCS-1b, and "constructor"/"toString" must not resolve.
function isRegistryKey(registry, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(registry, key);
}

/** Normalise + validate the AIDA target number. */
function validateTargetNumber(targetNumber) {
  if (targetNumber == null || String(targetNumber).trim() === "") {
    return { ok: false, error: "targetNumber is required (the client's AIDA forwarding number is not provisioned)" };
  }
  const e164 = normalisePhone(targetNumber);
  if (!e164 || !AU_E164_RE.test(e164)) {
    return { ok: false, error: `targetNumber must normalise to an Australian E.164 number (+61…): got "${targetNumber}"` };
  }
  return { ok: true, e164 };
}

/**
 * Validate an optional client-supplied AU number (e.g. business_number on the
 * routing profile). Absent/blank is fine ({ ok, e164: null }); anything
 * present must normalise to AU E.164. Callers prefix the field name.
 */
function validateOptionalAuNumber(value) {
  if (value == null || String(value).trim() === "") {
    return { ok: true, e164: null };
  }
  const e164 = normalisePhone(value);
  if (!e164 || !AU_E164_RE.test(e164)) {
    return { ok: false, error: `must normalise to an Australian E.164 number (+61…): got "${value}"` };
  }
  return { ok: true, e164 };
}

/**
 * Validate the user-editable profile fields WITHOUT the target number —
 * the save path must work for clients whose AIDA number isn't provisioned
 * yet (they can store preferences; only generate needs the target).
 * Collects ALL errors (not first-fail) so the future UI shows everything.
 */
function validateProfileInputs({ carrier, phonePlatform, loops, noAnswerDelaySeconds } = {}) {
  const errors = [];

  if (!isRegistryKey(CARRIERS, carrier)) {
    errors.push(`carrier must be one of: ${Object.keys(CARRIERS).join(", ")}`);
  }
  if (!isRegistryKey(PLATFORMS, phonePlatform)) {
    errors.push(`phonePlatform must be one of: ${Object.keys(PLATFORMS).join(", ")}`);
  }

  if (typeof loops !== "object" || loops === null || Array.isArray(loops)) {
    errors.push("loops must be an object of { no_answer, busy, unreachable } booleans");
  } else {
    const unknown = Object.keys(loops).filter((k) => !LOOP_KEYS.includes(k));
    if (unknown.length) {
      // Stale/foreign keys (e.g. a future all_calls) are rejected, not ignored
      // — silently dropping a requested loop would misrepresent the setup.
      errors.push(`unknown loop key(s): ${unknown.join(", ")} — supported: ${LOOP_KEYS.join(", ")}`);
    }
    const nonBoolean = Object.keys(loops).filter((k) => LOOP_KEYS.includes(k) && typeof loops[k] !== "boolean");
    if (nonBoolean.length) {
      errors.push(`loop value(s) must be boolean: ${nonBoolean.join(", ")}`);
    }
    if (!unknown.length && !nonBoolean.length && !LOOP_KEYS.some((k) => loops[k] === true)) {
      errors.push("select at least one diversion loop (no_answer, busy or unreachable)");
    }
  }

  if (noAnswerDelaySeconds != null) {
    if (!Number.isInteger(noAnswerDelaySeconds) || !NO_ANSWER_DELAY_OPTIONS.includes(noAnswerDelaySeconds)) {
      errors.push(
        `noAnswerDelaySeconds must be one of ${NO_ANSWER_DELAY_OPTIONS.join(", ")} (or null for the carrier default)`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate the full setup input set (profile fields + target). Returns
 * { ok, errors, target } where `target` is the normalised E.164 AIDA number
 * when valid. Delegates to validateProfileInputs so the two can never drift;
 * the target error is appended last (error order is part of the contract —
 * WCS-1a tests assert it).
 */
function validateSetupInputs({ targetNumber, carrier, phonePlatform, loops, noAnswerDelaySeconds } = {}) {
  const profile = validateProfileInputs({ carrier, phonePlatform, loops, noAnswerDelaySeconds });
  const errors = [...profile.errors];

  const target = validateTargetNumber(targetNumber);
  if (!target.ok) errors.push(target.error);

  return { ok: errors.length === 0, errors, target: target.ok ? target.e164 : null };
}

// ── Code generation ─────────────────────────────────────────────────────────

/**
 * Build the divert-code payload for one client's setup selections.
 *
 * Returns { ok: false, errors } on invalid input, or { ok: true, result }
 * where result.mode is:
 *   'gsm_codes'   — activate/cancel codes for the selected loops
 *   'manual_help' — desk/VoIP platform: NO codes, a manual-help path instead
 *
 * Both modes carry templateVersion + the recommended/vary disclaimer; the
 * future generate route snapshots `result` verbatim into the profile row.
 */
function buildDivertCodes({ targetNumber, carrier, phonePlatform, loops, noAnswerDelaySeconds } = {}) {
  const v = validateSetupInputs({ targetNumber, carrier, phonePlatform, loops, noAnswerDelaySeconds });
  if (!v.ok) return { ok: false, errors: v.errors };

  const carrierInfo = CARRIERS[carrier];
  const platformInfo = PLATFORMS[phonePlatform];
  const common = {
    templateVersion: TEMPLATE_VERSION,
    target: v.target,
    carrier,
    carrierLabel: carrierInfo.label,
    confidence: carrierInfo.confidence,
    phonePlatform,
    platformLabel: platformInfo.label,
    disclaimer: RECOMMENDED_DISCLAIMER,
  };

  if (platformInfo.kind === "desk_voip") {
    return {
      ok: true,
      result: {
        mode: "manual_help",
        ...common,
        reason:
          "GSM diversion codes apply to mobile services — a desk phone or VoIP service " +
          "configures forwarding in its own provider settings instead.",
        notes: [MANUAL_HELP_NOTE],
      },
    };
  }

  const selected = LOOP_KEYS.filter((k) => loops[k] === true);
  // Delay only means something for the no-answer loop; a stored delay with
  // no_answer unselected is ignored here (kept in the profile for later).
  const effectiveDelay = selected.includes("no_answer") ? (noAnswerDelaySeconds == null ? null : noAnswerDelaySeconds) : null;

  const activate = selected.map((k) => ({
    loop: k,
    label: LOOPS[k].label,
    description: LOOPS[k].description,
    code: renderTemplate(LOOPS[k].activateTemplate, {
      target: v.target,
      seconds: LOOPS[k].usesDelay ? effectiveDelay : null,
    }),
  }));

  const cancel = selected.map((k) => ({
    loop: k,
    label: `Cancel: ${LOOPS[k].label}`,
    code: LOOPS[k].cancelCode,
  }));

  return {
    ok: true,
    result: {
      mode: "gsm_codes",
      ...common,
      dialHint: platformInfo.dialHint,
      noAnswerDelaySeconds: effectiveDelay, // null = carrier default (or loop unselected)
      activate,
      cancel,
      cancelAll: { ...CANCEL_ALL },
      notes: [...carrierInfo.notes],
    },
  };
}

// ── Setup status machine ────────────────────────────────────────────────────
// Honesty contract: user_claimed_done and test_passed are SELF-REPORTED —
// the user telling us what happened on their handset, not something the
// platform verified. The spec labels them accordingly; automatic
// verification (a calls row arriving post-claim) is a future slice.

const STATUSES = [
  "not_started",
  "instructions_generated",
  "user_claimed_done",
  "test_passed",
  "needs_help",
];

const STATUS_ACTIONS = {
  // Regenerating instructions is always allowed — fresh codes are the
  // recovery path from every state, including after help or a passed test.
  generate: { from: [...STATUSES], to: "instructions_generated" },
  claim_done: { from: ["instructions_generated"], to: "user_claimed_done" },
  report_test_passed: { from: ["user_claimed_done"], to: "test_passed" }, // self-reported
  // Help is only meaningful once instructions exist; before that there is
  // nothing in-product to be stuck on (pre-generate help is a support
  // conversation, not a profile state).
  needs_help: { from: ["instructions_generated", "user_claimed_done", "test_passed"], to: "needs_help" },
  back_to_instructions: { from: ["needs_help"], to: "instructions_generated" },
  // Profile edits invalidate generated codes (stale codes carry an old
  // number) — the future adapter clears the snapshot when applying reset.
  reset: { from: [...STATUSES], to: "not_started" },
};

/** Pure transition check: { ok, next } or { ok: false, error }. */
function applyStatusAction(currentStatus, action) {
  if (!STATUSES.includes(currentStatus)) {
    return { ok: false, error: `unknown setup status: ${JSON.stringify(currentStatus)}` };
  }
  if (!isRegistryKey(STATUS_ACTIONS, action)) {
    return { ok: false, error: `unknown status action: ${JSON.stringify(action)}` };
  }
  const rule = STATUS_ACTIONS[action];
  if (!rule.from.includes(currentStatus)) {
    return { ok: false, error: `cannot ${action} from status '${currentStatus}'` };
  }
  return { ok: true, next: rule.to };
}

module.exports = {
  TEMPLATE_VERSION,
  RECOMMENDED_DISCLAIMER,
  LOOPS,
  LOOP_KEYS,
  CANCEL_ALL,
  NO_ANSWER_DELAY_OPTIONS,
  DEFAULT_NO_ANSWER_DELAY_SECONDS,
  CARRIERS,
  PLATFORMS,
  MANUAL_HELP_NOTE,
  renderTemplate,
  validateTargetNumber,
  validateOptionalAuNumber,
  validateProfileInputs,
  validateSetupInputs,
  buildDivertCodes,
  STATUSES,
  STATUS_ACTIONS,
  applyStatusAction,
};
