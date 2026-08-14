// AIDA Locksmith Acquisition — central configuration and the offline boundary
// (A1).
//
// The ONE place that owns whether any part of the acquisition engine may run,
// and the ONE place that decides whether this build is allowed to touch an
// external system at all.
//
// WHY THIS FILE IS SHAPED LIKE THIS
// The acquisition engine is the part of AIDA that can, if it goes wrong, place
// unlawful calls to real businesses. The failure is not a broken page — it is
// an ACMA complaint with per-day penalties (see docs/OUTBOUND_BDM_ARCHITECTURE.md
// §2.2). So the config layer is written to make "off" the state that requires
// no correctness, and "on" the state that requires deliberate, explicit,
// exactly-spelled action.
//
// THE OFFLINE BOUNDARY
// EXTERNAL_ACCESS_SUPPORTED is a hardcoded `false`. It is NOT read from env and
// there is deliberately no env var that can flip it. This build has no live
// search adapter, no crawler, no DNCR client, no Retell or Twilio outbound path
// in the acquisition engine — and the registries below REFUSE to accept an
// adapter that declares it needs the network while this constant is false.
//
// That is the difference between "we didn't build the live path yet" and "the
// live path cannot be switched on by an env var, a config typo, or a plausible
// looking pull request". Turning acquisition live is a code change that has to
// delete this line, which is reviewable in a way that `FOO_ENABLED=true` is not.
//
// Flags — all dormant by default, all strict-parse (the D7 house rule: only the
// exact string "true" enables, so a sloppy env value can never switch a feature
// on).
//   ACQUISITION_ENABLED        default OFF — the master switch. Everything in
//                              the engine checks this. Unset ⇒ discovery,
//                              review, wash and eligibility all refuse to run.
//   ACQUISITION_REVIEW_ENABLED default OFF — the human review workflow.
//   ACQUISITION_DNCR_MODE      default "disabled". See DNCR_MODES below. There
//                              is no "live" mode; asking for one is a config
//                              fault that resolves to "disabled".
//
// Pure + dep-free: nothing here touches the network, the DB or process state
// beyond reading env. See test/acquisition-config.test.js.

// ── The offline boundary ────────────────────────────────────────────

// Hardcoded. Not env-derived. Not overridable. See the header.
const EXTERNAL_ACCESS_SUPPORTED = false;

// Every external system the acquisition engine will EVENTUALLY need, named
// explicitly so that "is this thing allowed to run?" is a lookup rather than a
// judgement call at each call site. All false in this build.
const EXTERNAL_SYSTEMS = Object.freeze({
  web_fetch: false, // crawling or fetching a business website
  search_api: false, // Google / Bing / any search engine API
  directory_api: false, // Yellow Pages / True Local / any directory API
  business_register: false, // ABR / ASIC lookup
  dncr_api: false, // Do Not Call Register wash submission
  telephony: false, // Twilio / Retell / any dialler
  messaging: false, // SMS or email despatch
});

/**
 * Throw unless an operation is permitted to touch the outside world.
 *
 * Called by every module that would, in a later build, reach an external
 * system. In this build it ALWAYS throws — which is the point. A future live
 * adapter that forgets to be gated will fail loudly in tests rather than
 * quietly succeed in production.
 *
 * @param {string} system  a key of EXTERNAL_SYSTEMS
 * @param {string} why     what the caller was trying to do, for the message
 */
function assertExternalAccessAllowed(system, why = "") {
  const known = Object.prototype.hasOwnProperty.call(EXTERNAL_SYSTEMS, system);
  if (!known) {
    throw new Error(`Unknown external system "${String(system).slice(0, 60)}" — refusing by default.`);
  }
  if (!EXTERNAL_ACCESS_SUPPORTED || !EXTERNAL_SYSTEMS[system]) {
    throw new Error(
      `External access to "${system}" is not available in this build` +
        (why ? ` (attempted: ${String(why).slice(0, 120)})` : "") +
        ". The acquisition engine runs offline: use a fixture or import adapter."
    );
  }
}

/** True only if the named system is usable. Always false in this build. */
function isExternalSystemAvailable(system) {
  return EXTERNAL_ACCESS_SUPPORTED && EXTERNAL_SYSTEMS[system] === true;
}

// ── Flags ───────────────────────────────────────────────────────────

// Master switch: off unless explicitly switched on (exact string "true").
function isAcquisitionEnabled(env = process.env) {
  return env.ACQUISITION_ENABLED === "true";
}

// Human review workflow. Independent of the master switch on purpose: review is
// the surface a founder uses, and it must be possible to have the engine
// enabled for analysis while review stays closed (and vice versa is refused —
// see acquisitionReady below).
function isAcquisitionReviewEnabled(env = process.env) {
  return env.ACQUISITION_REVIEW_ENABLED === "true";
}

/**
 * The single "may this run at all?" predicate used by the pipeline modules.
 * Both the master switch AND the specific capability must be on. Returns a
 * reason when refusing, because a silent false is impossible to debug.
 */
function acquisitionReady(capability, env = process.env) {
  if (!isAcquisitionEnabled(env)) {
    return { ok: false, code: "acquisition_disabled", message: "The acquisition engine is switched off (ACQUISITION_ENABLED is not \"true\")." };
  }
  if (capability === "review" && !isAcquisitionReviewEnabled(env)) {
    return { ok: false, code: "review_disabled", message: "Prospect review is switched off (ACQUISITION_REVIEW_ENABLED is not \"true\")." };
  }
  return { ok: true };
}

// ── DNCR mode ───────────────────────────────────────────────────────

// The three modes this build understands. There is deliberately no "live".
//
//   disabled  the default. Every wash returns "unknown", which the eligibility
//             engine treats as a VETO. A build that has not been configured for
//             DNCR cannot call anybody — that is the correct default, not a
//             degraded one.
//   fixture   a deterministic in-repo register used by tests and the dry run.
//             Results are clearly labelled as fixture and can never be
//             presented as a real wash.
//   import    operator-supplied results from a wash that a human performed
//             out-of-band against the real Register, loaded from a file. This
//             is how a real wash gets into the system without this process
//             holding DNCR credentials or calling the DNCR API.
const DNCR_MODES = Object.freeze(["disabled", "fixture", "import"]);

// Australian Do Not Call Register: a wash older than 30 days may not be relied
// upon for unsolicited telemarketing. Encoded once, here.
const DNCR_WASH_VALIDITY_DAYS = 30;

/**
 * Resolve the DNCR mode, fail-closed.
 *
 * An unrecognised value — including the very plausible "live" — resolves to
 * "disabled" and reports a fault. It never throws, because a config typo must
 * degrade to "cannot call anybody", not to "server won't boot"; and it never
 * silently accepts, because a mode nobody validated is how a fake wash gets
 * treated as a real one.
 */
function resolveDncrMode(env = process.env) {
  const raw = env.ACQUISITION_DNCR_MODE;
  if (raw === undefined || raw === null || raw === "") {
    return { mode: "disabled", faults: [] };
  }
  if (DNCR_MODES.includes(raw)) {
    return { mode: raw, faults: [] };
  }
  const faults = [
    {
      code: raw === "live" ? "dncr_live_mode_unavailable" : "dncr_mode_unknown",
      message:
        raw === "live"
          ? "ACQUISITION_DNCR_MODE=live was requested, but this build has no live DNCR client. Falling back to \"disabled\" — nothing can be called until a wash is imported."
          : `ACQUISITION_DNCR_MODE="${String(raw).slice(0, 40)}" is not a mode this build understands. Falling back to "disabled".`,
    },
  ];
  return { mode: "disabled", faults };
}

// ── Calling policy defaults ─────────────────────────────────────────

// The Australian Telemarketing and Research Calls Industry Standard 2017
// permitted hours, in the RECIPIENT's local time. Encoded as data so the policy
// gate is a lookup, and so a legal change is a one-line edit with a test that
// fails loudly.
//
// Sunday is absent from this table on purpose: an absent day means "no calling
// window exists", which is exactly the rule. Public holidays are handled
// separately (see acquisition-calling-policy.js) because they are dates, not
// weekdays.
const CALLING_WINDOWS = Object.freeze({
  mon: Object.freeze({ from: "09:00", to: "20:00" }),
  tue: Object.freeze({ from: "09:00", to: "20:00" }),
  wed: Object.freeze({ from: "09:00", to: "20:00" }),
  thu: Object.freeze({ from: "09:00", to: "20:00" }),
  fri: Object.freeze({ from: "09:00", to: "20:00" }),
  sat: Object.freeze({ from: "09:00", to: "17:00" }),
  // sun: deliberately absent — no calling on Sundays.
});

// Conservative caps. These are ceilings the engine enforces; a campaign may be
// stricter, never looser (the same non-weakening rule the receptionist prompt
// layer uses).
// The founder-approved caps (A-L6, approval AL6-AL7-AL8-2026-08-10). These are
// the same values acquisition-attempt-policy.js carries; that module owns the
// approval metadata and this one only mirrors the numbers for the older
// calling-policy path.
//
// `recentContactCooldownDays: null` is the RETIRED generic post-contact
// cooldown, not a missing value. It is null rather than 30 so the placeholder
// cannot come back through config, and every consumer already guards with
// Number.isFinite, which skips it.
const DEFAULT_CAPS = Object.freeze({
  maxAttemptsPerProspect: 2,
  minDaysBetweenAttempts: 2,
  recentContactCooldownDays: null,
  maxBatchSize: 25, // a founder-approved batch is small by design in the pilot
});

// The pilot's target market. Timezone is a compliance input, not a UX nicety —
// it decides whether a call is inside permitted hours.
const DEFAULT_MARKET = Object.freeze({
  region: "Melbourne",
  state: "VIC",
  timezone: "Australia/Melbourne",
  country: "AU",
});

/**
 * THE ACQUISITION VOICE — ITS OWN KEY, WITH NO FALLBACK (E-12B).
 *
 * ── WHY NOT JUST USE RETELL_DEFAULT_VOICE_ID ────────────────────────
 * Because at the moment it holds the same voice the founder chose for
 * acquisition, and that is precisely the trap. `RETELL_DEFAULT_VOICE_ID` is the
 * RECEPTIONIST's voice — the one a locksmith's own customers hear. If
 * acquisition read it, the two would be wired together by accident, and the day
 * somebody re-voiced the receptionist they would also silently re-voice every
 * cold call to a stranger, with no test failing and nobody deciding it.
 *
 * The same underlying voice may be chosen for both. That has to be a
 * coincidence somebody typed twice, not an inheritance.
 *
 * ── NO FALLBACK, ON PURPOSE ─────────────────────────────────────────
 * There is deliberately no fallback to the shared receptionist key here. An
 * unset acquisition key yields `null`, which keeps `createAgentReady` false and
 * names the blocker, rather than quietly borrowing another product's voice.
 * Fail closed.
 *
 * The value itself is deployment configuration and lives in the environment —
 * not in git — the same as RETELL_ACQUISITION_LLM_ID.
 */
function resolveAcquisitionVoiceId(env = process.env) {
  const raw = env.RETELL_ACQUISITION_VOICE_ID;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * THE ACQUISITION OUTBOUND NUMBER — ITS OWN KEY, WITH NO FALLBACK (E-12G).
 *
 * ── WHY THIS IS NOT RETELL_OUTBOUND_ONBOARDING_NUMBER ───────────────
 * Because `canPlaceCall` in config/retell.js is satisfied by exactly that key.
 * If acquisition leaned on the shared gate, the ONBOARDING number would count
 * as "acquisition has a number" — and cold calls to strangers would go out
 * from the number a consenting client was interviewed on. The two are
 * different activities with different consent, different compliance exposure
 * and different reputations to lose; they do not share a caller ID by accident.
 *
 * ── NO FALLBACK, ON PURPOSE ─────────────────────────────────────────
 * Same rule as the voice (E-12B): an unset key yields `null` and acquisition
 * stays unable to dial, rather than quietly borrowing another product's number.
 * The same number MAY one day be chosen for both — but that has to be a value
 * somebody typed into this key, not an inheritance.
 *
 * ── FORMAT IS CHECKED HERE, NOT ASSUMED DOWNSTREAM ──────────────────
 * The provider already refuses a non-E.164 `fromNumber` at dial time. Checking
 * it at resolution means a malformed number is a configuration problem a
 * founder sees in a readiness report, rather than an exception thrown on the
 * one call that mattered.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

function resolveAcquisitionOutboundNumber(env = process.env) {
  const raw = env.RETELL_ACQUISITION_OUTBOUND_NUMBER;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return E164.test(trimmed) ? trimmed : null;
}

/**
 * Is the NUMBER part of acquisition calling ready — and nothing else?
 *
 * Deliberately narrow. This answers one question about one resource. It does
 * not enable a provider, unpause calling, or say anything about DNCR,
 * suppression, hours or holidays, all of which are separate authorities that
 * the final pre-dial gate owns. A ready number is a prerequisite for calling,
 * never a permission to call.
 */
function describeAcquisitionNumberReadiness(env = process.env) {
  const raw = typeof env.RETELL_ACQUISITION_OUTBOUND_NUMBER === "string" ? env.RETELL_ACQUISITION_OUTBOUND_NUMBER.trim() : "";
  const number = resolveAcquisitionOutboundNumber(env);
  const blockers = [];

  if (!raw) blockers.push("RETELL_ACQUISITION_OUTBOUND_NUMBER is not set — acquisition has no number of its own");
  else if (!number) blockers.push("RETELL_ACQUISITION_OUTBOUND_NUMBER is not a valid E.164 number");

  return Object.freeze({
    ready: blockers.length === 0,
    number,
    // Named so a report can say WHY a present onboarding number changed nothing.
    inheritedFromAnotherProduct: false,
    blockers: Object.freeze(blockers),
    note:
      "A number is one prerequisite among several. It grants no permission to dial: the provider is a " +
      "separate authority, the global calling state is a separate authority, and the pre-dial gate still runs.",
  });
}

/**
 * The config `buildAcquisitionAgent` expects, assembled from acquisition-only
 * environment keys. Reads no receptionist or onboarding key at all.
 */
function getAcquisitionRetellConfig(env = process.env) {
  return Object.freeze({
    voiceId: resolveAcquisitionVoiceId(env),
    outboundNumber: resolveAcquisitionOutboundNumber(env),
    // Named here so the agent builder never reaches for the onboarding webhook.
    acquisitionWebhookUrl:
      typeof env.RETELL_ACQUISITION_WEBHOOK_URL === "string" && env.RETELL_ACQUISITION_WEBHOOK_URL.trim()
        ? env.RETELL_ACQUISITION_WEBHOOK_URL.trim()
        : null,
  });
}

/**
 * Assemble the config object handed to the pipeline. Every env var is optional;
 * an unset var yields the safe default, never a permissive one.
 */
function getAcquisitionConfig(env = process.env) {
  const dncr = resolveDncrMode(env);

  return Object.freeze({
    enabled: isAcquisitionEnabled(env),
    reviewEnabled: isAcquisitionReviewEnabled(env),

    externalAccess: Object.freeze({
      supported: EXTERNAL_ACCESS_SUPPORTED,
      systems: EXTERNAL_SYSTEMS,
    }),

    dncr: Object.freeze({
      mode: dncr.mode,
      washValidityDays: DNCR_WASH_VALIDITY_DAYS,
      // A wash performed by this build is never a real wash unless it was
      // imported from a real one. Surfaced so the UI can say so out loud.
      resultsAreAuthoritative: dncr.mode === "import",
    }),

    callingWindows: CALLING_WINDOWS,
    caps: DEFAULT_CAPS,
    market: DEFAULT_MARKET,

    // Config problems worth showing a human. Empty is the healthy state.
    faults: Object.freeze(dncr.faults),
  });
}

module.exports = {
  // offline boundary
  EXTERNAL_ACCESS_SUPPORTED,
  EXTERNAL_SYSTEMS,
  assertExternalAccessAllowed,
  isExternalSystemAvailable,
  // flags
  isAcquisitionEnabled,
  isAcquisitionReviewEnabled,
  acquisitionReady,
  // dncr
  DNCR_MODES,
  DNCR_WASH_VALIDITY_DAYS,
  resolveDncrMode,
  // policy data
  CALLING_WINDOWS,
  DEFAULT_CAPS,
  DEFAULT_MARKET,
  // retell resources — acquisition-only keys, no receptionist fallback
  resolveAcquisitionVoiceId,
  resolveAcquisitionOutboundNumber,
  describeAcquisitionNumberReadiness,
  getAcquisitionRetellConfig,
  // assembled
  getAcquisitionConfig,
};
