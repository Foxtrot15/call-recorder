// AIDA Locksmith Acquisition — the prospect domain model (A1).
//
//   createProspect(input)                     a validated, frozen prospect
//   validateProspect(prospect)                structural validation
//   transitionProspect(prospect, to, ctx)     the state machine
//   identityFingerprint(prospect)             stable identity key (A2 dedupe)
//
// A prospect is NOT "a row we found on the internet". It is a claim about a
// business, plus the state of our confidence in that claim. The two are held
// together on purpose: every field that could justify a phone call has to be
// traceable to evidence (acquisition-evidence.js) and to a human decision
// (acquisition-review.js).
//
// WHAT THIS MODULE REFUSES TO DO
//  * It never invents a value. A business with no published phone number has
//    `phones: []`, not a guessed one — the same "silence produces a gap, never
//    a guess" rule the onboarding extraction adapter follows.
//  * It never advances its own state. Every transition is a whitelist lookup
//    (S.PROSPECT_TRANSITIONS) plus a recorded actor and reason. Nothing in the
//    system can move a prospect toward callable without leaving its name on it.
//  * It never normalises or validates phone numbers. That is A2's job, done
//    after human review — the number stored here is the number as published,
//    which is what the evidence says, and rewriting it before a human has seen
//    it would destroy the thing being reviewed.
//
// Pure + dep-free apart from node:crypto (core). See test/acquisition-prospect.test.js.

const crypto = require("node:crypto");
const S = require("./acquisition-schema");
const { summariseSources } = require("./acquisition-source");

const MAX_NAME = 200;
const MAX_TEXT = 500;
const MAX_LIST = 50;

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isIsoInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * A stable key for "this is the same business". Deliberately built from the
 * trading name and locality only — NOT the phone number, because two genuinely
 * different businesses can share a switchboard, and one business changes its
 * number without becoming a different business. A2's dedupe uses this together
 * with the normalised phone, treating agreement as strong and disagreement as
 * something a human resolves.
 */
function identityFingerprint({ businessName, suburb, state } = {}) {
  const name = (clip(businessName, MAX_NAME) || "")
    .toLowerCase()
    // Strip the corporate-form noise that makes "X Pty Ltd" and "X" look
    // different to a machine and identical to a person.
    .replace(/\b(pty|ltd|limited|proprietary|inc|incorporated|co|company|the)\b/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  const place = `${(clip(suburb, 80) || "").toLowerCase()}|${(clip(state, 8) || "").toLowerCase()}`.replace(/[^a-z0-9|]+/g, "");
  return `${name}#${place}`;
}

function prospectIdFor(input) {
  const fingerprint = identityFingerprint(input);
  return `pr_${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 20)}`;
}

/**
 * Structural validation. Returns { ok, errors } — errors are objects with a
 * field and a plain-language message, because these surface in a founder-facing
 * review screen, not only in a stack trace.
 */
function validateProspect(prospect) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  if (!prospect || typeof prospect !== "object" || Array.isArray(prospect)) {
    return { ok: false, errors: [{ field: "prospect", message: "A prospect must be an object." }] };
  }

  if (!clip(prospect.prospectId, 120)) err("prospectId", "A prospect needs an id.");
  if (!clip(prospect.businessName, MAX_NAME)) err("businessName", "A prospect needs a business name.");

  if (!S.DISCOVERY_ORIGINS.includes(prospect.origin)) {
    err("origin", `"${String(prospect.origin).slice(0, 40)}" is not a way a business can enter this system.`);
  }
  // NOTE ON NAMING: `state` on a prospect is the AUSTRALIAN state (VIC, NSW).
  // The lifecycle state lives in `lifecycle`. They are different things and
  // conflating them would put "review_approved" in an address field.
  if (!S.PROSPECT_STATES.includes(prospect.lifecycle)) {
    err("lifecycle", `"${String(prospect.lifecycle).slice(0, 40)}" is not a prospect state.`);
  }
  if (!isIsoInstant(prospect.discoveredAt)) err("discoveredAt", "A prospect needs a valid discovery timestamp.");

  if (!Array.isArray(prospect.phones)) err("phones", "Phones must be a list.");
  else if (prospect.phones.length > MAX_LIST) err("phones", "Too many phone numbers.");
  else {
    prospect.phones.forEach((p, i) => {
      if (!p || typeof p !== "object") err(`phones[${i}]`, "Each phone must be an object.");
      else if (!clip(p.raw, 60)) err(`phones[${i}].raw`, "Each phone must record the number as published.");
    });
  }

  if (!Array.isArray(prospect.sourceRefs)) err("sourceRefs", "Sources must be a list.");
  else if (prospect.sourceRefs.length > MAX_LIST) err("sourceRefs", "Too many sources.");

  if (!Array.isArray(prospect.history)) err("history", "History must be a list.");

  // Region is a compliance input (it decides the timezone that decides whether
  // a call is inside permitted hours), so a missing timezone is an error, not a
  // cosmetic gap.
  if (!clip(prospect.timezone, 60)) err("timezone", "A prospect needs a timezone — calling hours are checked in the business's local time.");

  return { ok: errors.length === 0, errors };
}

/**
 * Build a prospect from raw discovery input.
 *
 * Returns { ok:true, prospect } or { ok:false, errors }. Never throws on bad
 * input: a malformed discovery record is a data-quality finding that belongs in
 * a report, not an exception that kills a batch import halfway through.
 */
function createProspect(rawInput = {}) {
  // A default parameter only covers `undefined`, so null / a string / an array
  // would all reach the property reads below and throw. A discovery adapter
  // that emits one bad record must not be able to kill the whole batch, so a
  // non-object is a validation failure like any other.
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { ok: false, errors: [{ field: "prospect", message: "A prospect must be built from an object." }] };
  }
  const input = rawInput;

  const businessName = clip(input.businessName, MAX_NAME);
  const suburb = clip(input.suburb, 80);
  const state = clip(input.state, 8);

  const prospect = {
    prospectId: clip(input.prospectId, 120) || prospectIdFor({ businessName, suburb, state }),
    schemaVersion: S.SCHEMA_VERSION,

    // Identity, exactly as published. Nothing here is normalised or corrected.
    businessName,
    legalName: clip(input.legalName, MAX_NAME),
    abn: clip(input.abn, 40),
    tradeCategory: clip(input.tradeCategory, 120),

    // Locality + timezone. Timezone defaults are the caller's job, not ours —
    // guessing a timezone would guess whether a call is lawful.
    suburb,
    state,
    postcode: clip(input.postcode, 12),
    region: clip(input.region, 120),
    timezone: clip(input.timezone, 60),

    // Published numbers, untouched. A2 normalises after review.
    phones: (Array.isArray(input.phones) ? input.phones : [])
      .slice(0, MAX_LIST)
      .map((p) => {
        const raw = typeof p === "string" ? p : p && p.raw;
        return {
          raw: clip(raw, 60),
          label: clip(typeof p === "object" && p ? p.label : null, 60),
          // Which evidence row published this number. Populated by the
          // discovery adapter; a phone with no evidence is caught at review.
          evidenceId: clip(typeof p === "object" && p ? p.evidenceId : null, 120),
        };
      })
      .filter((p) => p.raw),

    sourceRefs: (Array.isArray(input.sourceRefs) ? input.sourceRefs : []).slice(0, MAX_LIST),

    origin: input.origin,
    discoveredAt: isIsoInstant(input.discoveredAt) ? new Date(input.discoveredAt).toISOString() : null,
    discoveredBy: clip(input.discoveredBy, 120),
    notes: clip(input.notes, MAX_TEXT),

    // Lifecycle always starts at the beginning. A caller cannot hand us a
    // prospect that is already approved — approval is something that HAPPENS,
    // recorded by transitionProspect, not something that can be asserted at
    // construction time.
    lifecycle: "discovered",
    history: [],
  };

  const validation = validateProspect(prospect);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  return { ok: true, prospect: Object.freeze({ ...prospect, phones: Object.freeze(prospect.phones), sourceRefs: Object.freeze(prospect.sourceRefs), history: Object.freeze([]) }) };
}

/**
 * Move a prospect to a new lifecycle state.
 *
 * Every transition is checked against the whitelist and stamped with WHO did it
 * and WHY. A transition that is not in the table is refused — including
 * seemingly harmless ones like discovered → review_approved, because skipping
 * evidence capture is exactly the shortcut that must not exist.
 *
 * A small set of transitions (S.REMEDIATION_TRANSITIONS) additionally require a
 * named approver and a justification, because they re-approach a business that
 * has already given or received an answer. See the comment on that table.
 *
 * @param {object} [opts.remediation]  { approvedBy, justification } — required
 *   only for the transitions listed in S.REMEDIATION_TRANSITIONS.
 *
 * Returns { ok:true, prospect } (a new frozen object) or { ok:false, code, message }.
 */
function transitionProspect(prospect, to, { actor, reason, now, remediation = null } = {}) {
  if (!prospect || typeof prospect !== "object") {
    return { ok: false, code: "prospect_invalid", message: "No prospect was given." };
  }
  const from = prospect.lifecycle;
  if (!S.PROSPECT_STATES.includes(from)) {
    return { ok: false, code: "state_unknown", message: `This prospect is in an unrecognised state ("${String(from).slice(0, 40)}").` };
  }
  if (!S.PROSPECT_STATES.includes(to)) {
    return { ok: false, code: "state_unknown", message: `"${String(to).slice(0, 40)}" is not a prospect state.` };
  }

  const allowed = S.PROSPECT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      code: "transition_not_allowed",
      message:
        `A prospect cannot go from "${S.PROSPECT_STATE_LABELS[from]}" to "${S.PROSPECT_STATE_LABELS[to]}".` +
        (allowed.length ? ` From here it can only become: ${allowed.map((a) => S.PROSPECT_STATE_LABELS[a]).join(", ")}.` : " This is a final state."),
    };
  }

  const who = clip(actor, 120);
  if (!who) return { ok: false, code: "actor_missing", message: "Every change of state has to record who made it." };

  const why = clip(reason, MAX_TEXT);
  if (!why) return { ok: false, code: "reason_missing", message: "Every change of state has to record why." };

  if (typeof now !== "function") {
    return { ok: false, code: "clock_missing", message: "transitionProspect requires an injected now()." };
  }

  // Remediation-gated transitions. An actor and a reason are already required
  // above; these need a SECOND person to have authorised the move, named, plus
  // a justification. "Peter, because the list was short" must not be enough to
  // ring somebody back who already said no.
  const remediationNeeded = S.REMEDIATION_TRANSITIONS[S.REMEDIATION_KEY(from, to)];
  let remediationEntry = null;
  if (remediationNeeded) {
    const approvedBy = clip(remediation && remediation.approvedBy, 120);
    const justification = clip(remediation && remediation.justification, MAX_TEXT);
    if (!approvedBy || !justification) {
      return {
        ok: false,
        code: "remediation_required",
        message:
          `Going from "${S.PROSPECT_STATE_LABELS[from]}" to "${S.PROSPECT_STATE_LABELS[to]}" needs an explicit administrative decision — ${remediationNeeded} ` +
          "Record who approved it and why.",
      };
    }
    // The approver must be a person. A remediation signed by "system" is the
    // automation authorising itself, which is not a control.
    if (isNonHuman(approvedBy)) {
      return {
        ok: false,
        code: "remediation_actor_invalid",
        message: `"${approvedBy}" is not a person. Re-approaching a business that already answered has to be approved by a named human.`,
      };
    }
    remediationEntry = Object.freeze({ approvedBy, justification });
  }

  const entry = Object.freeze({
    from,
    to,
    at: now().toISOString(),
    actor: who,
    reason: why,
    ...(remediationEntry ? { remediation: remediationEntry } : {}),
  });

  return {
    ok: true,
    prospect: Object.freeze({
      ...prospect,
      lifecycle: to,
      history: Object.freeze([...(prospect.history || []), entry]),
    }),
  };
}

// Names that are not a person. Kept in step with the same rule in
// acquisition-review.js and acquisition-batch.js: an automated actor may record
// a transition, but it may not AUTHORISE re-approaching somebody.
const NON_HUMAN_ACTORS = Object.freeze(["system", "aida", "bot", "automation", "auto", "robot", "service", "cron", "scheduler"]);

function isNonHuman(name) {
  return NON_HUMAN_ACTORS.includes(String(name).trim().toLowerCase());
}

/**
 * Everything known about a prospect's readiness, assembled from the prospect
 * plus its evidence. This is the object review and eligibility both read, so
 * the two can never disagree about what the record contains.
 */
function assessProspect(prospect, evidenceRows = []) {
  const { assessEvidence } = require("./acquisition-evidence");
  const evidence = assessEvidence(evidenceRows);
  const sources = summariseSources(prospect.sourceRefs);

  const gaps = [];
  if (!prospect.businessName) gaps.push({ code: "no_business_name", message: "We do not have a business name." });
  if (prospect.phones.length === 0) gaps.push({ code: "no_phone", message: "We do not have a published phone number for this business." });
  if (!prospect.timezone) gaps.push({ code: "no_timezone", message: "We do not know this business's timezone, so we cannot check calling hours." });
  if (!sources.hasOfficialSource) {
    gaps.push({ code: "no_official_source", message: "We have not found this business's own website or a government register entry." });
  }
  for (const kind of evidence.missingRequired) {
    gaps.push({ code: `no_evidence_${kind}`, message: `We hold no evidence for: ${S.EVIDENCE_KIND_LABELS[kind]}.` });
  }
  if (evidence.phoneEvidenceCount > 0 && !evidence.phoneFromOfficialSource) {
    gaps.push({
      code: "phone_not_official",
      message: "The phone number we have came from a third-party listing, not from the business itself. Third-party listings keep stale numbers indefinitely.",
    });
  }

  return Object.freeze({
    prospectId: prospect.prospectId,
    lifecycle: prospect.lifecycle,
    evidence,
    sources,
    gaps: Object.freeze(gaps),
    // The single question review asks: is there enough here for a human to
    // even be OFFERED an approve button?
    reviewable: gaps.length === 0,
  });
}

module.exports = {
  createProspect,
  validateProspect,
  transitionProspect,
  assessProspect,
  identityFingerprint,
  prospectIdFor,
};
