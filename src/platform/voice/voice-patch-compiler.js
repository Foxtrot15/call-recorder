// AIDA VOICE CONFIGURATION — confirmed intents become a patch (P39A → P4).
//
//   compileChangesToPatch({ changes, blueprint }) -> { ok, patch } | { ok:false }
//   compileChange(change, blueprint)              -> operations[]
//
// ── WHERE THIS SITS ─────────────────────────────────────────────────
// This is the ONLY seam between the conversational layer and the configuration
// authority. Above it, structured intents with typed payloads. Below it,
// config-patch.js's four primitives and its allowlist of touchable paths —
// which already existed, was already reviewed, and is not reimplemented here.
//
// A conversation cannot reach a path config-patch does not permit, because the
// only way through is this file and every operation it emits names a path from
// the intent's declared section. `metadata`, `identity.clientId` and
// `identity.vertical` have no intent that targets them, and config-patch would
// refuse them anyway. Two independent barriers, one of which was built before
// any of this existed.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────
// An UNKNOWN_INTENT compiles to nothing, and a test asserts it — because "we
// did not understand you, so we changed something" is the single worst
// behaviour available to this system. A change that is not `confirmed` compiles
// to nothing either: proposals are not edits.

const { UNKNOWN_INTENT, isConfigurationIntent, validateIntentPayload } = require("./voice-intents");

const COMPILER_CODES = Object.freeze({
  OK: "ok",
  NOT_CONFIRMED: "change_not_confirmed",
  UNKNOWN: "unknown_intent_compiles_to_nothing",
  NO_CONTRACT: "intent_has_no_configuration_contract",
  BAD_PAYLOAD: "payload_failed_its_contract",
  NOTHING_TO_DO: "no_confirmed_changes",
});

const fail = (code, message, extra = {}) => Object.freeze({ ok: false, code, message, ...extra });

const slug = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "service";

/** Find an existing service by id, name or alias. Case- and space-insensitive. */
function findService(blueprint, ref) {
  const services = (blueprint && blueprint.services) || [];
  const needle = String(ref || "").toLowerCase().replace(/\s+/g, " ").trim();
  return services.find((s) => {
    if (!s) return false;
    if (String(s.serviceId || "").toLowerCase() === needle) return true;
    if (String(s.name || "").toLowerCase() === needle) return true;
    if (slug(s.name || "") === slug(needle)) return true;
    return (s.aliases || []).some((a) => String(a).toLowerCase() === needle);
  }) || null;
}

const findFact = (blueprint, ref) => {
  const facts = (blueprint && blueprint.knowledge && blueprint.knowledge.approvedFacts) || [];
  const needle = String(ref || "").toLowerCase().trim();
  return facts.find((f) => f && (String(f.factId).toLowerCase() === needle || String(f.statement).toLowerCase().includes(needle))) || null;
};

/**
 * One confirmed change into config-patch operations.
 * Returns [] when the change cannot or must not produce one.
 */
function compileChange(change, blueprint) {
  if (!change || change.state !== "confirmed") return [];
  const { intent, payload = {} } = change;
  if (intent === UNKNOWN_INTENT || !isConfigurationIntent(intent)) return [];
  if (!validateIntentPayload(intent, payload).ok) return [];

  const set = (path, value) => ({ op: "set", path, value });
  const add = (path, value) => ({ op: "add_to_list", path, value });
  const remove = (path, value) => ({ op: "remove_from_list", path, value });

  switch (intent) {
    case "SET_BUSINESS_HOURS": {
      const p = payload.periods[0];
      // The blueprint models one period per day; a second period is carried in
      // the session's own record and surfaced to the reviewer rather than
      // silently dropped here.
      return [set(`hours.weekly.${payload.day}`, { open: p.start, close: p.end })];
    }
    case "SET_DAY_CLOSED":
      return [set(`hours.weekly.${payload.day}`, { closed: true })];

    case "SET_AFTER_HOURS_POLICY": {
      const ops = [set("hours.afterHours.available", payload.available)];
      if (payload.policy) ops.push(set("hours.afterHours.policy", payload.policy));
      return ops;
    }

    case "ADD_SERVICE": {
      const existing = findService(blueprint, payload.name);
      if (existing) {
        // Already there. Re-adding would produce a duplicate serviceId, which
        // the blueprint refuses — so this becomes an update instead.
        const ops = [];
        // "We also do safe opening" about a service that exists but is
        // DISABLED means turn it back on. This is the other half of
        // REMOVE_SERVICE disabling rather than deleting: a business that
        // changes its mind gets its old wording back rather than describing
        // the job again from scratch.
        if (existing.enabled === false) ops.push(set(`services[${existing.serviceId}].enabled`, true));
        if (payload.urgency) ops.push(set(`services[${existing.serviceId}].urgencyCategory`, payload.urgency));
        if (payload.aliases && payload.aliases.length) ops.push(set(`services[${existing.serviceId}].aliases`, payload.aliases));
        return ops;
      }
      return [add("services", {
        serviceId: slug(payload.name),
        name: payload.name,
        enabled: true,
        urgencyCategory: payload.urgency || "standard",
        ...(payload.aliases && payload.aliases.length ? { aliases: payload.aliases } : {}),
        ...(payload.qualificationRequirements && payload.qualificationRequirements.length
          ? { qualificationRequirements: payload.qualificationRequirements } : {}),
        ...(payload.exclusions && payload.exclusions.length ? { exclusions: payload.exclusions } : {}),
      })];
    }

    case "UPDATE_SERVICE": {
      const existing = findService(blueprint, payload.serviceRef);
      if (!existing) return [];
      const id = existing.serviceId;
      const ops = [];
      if (payload.name) ops.push(set(`services[${id}].name`, payload.name));
      if (payload.urgency) ops.push(set(`services[${id}].urgencyCategory`, payload.urgency));
      if (payload.aliases) ops.push(set(`services[${id}].aliases`, payload.aliases));
      if (payload.enabled !== undefined) ops.push(set(`services[${id}].enabled`, payload.enabled));
      return ops;
    }

    case "REMOVE_SERVICE": {
      const existing = findService(blueprint, payload.serviceRef);
      if (!existing) return [];
      // DISABLED, not deleted. A service that vanishes takes its history with
      // it, and a business that changes its mind next week has to describe it
      // again from scratch.
      return [set(`services[${existing.serviceId}].enabled`, false)];
    }

    case "SET_SERVICE_AREA": {
      const ops = [];
      for (const s of payload.suburbs || []) ops.push(add("serviceArea.suburbs", s));
      for (const r of payload.regions || []) ops.push(add("serviceArea.regions", r));
      for (const p of payload.postcodes || []) ops.push(add("serviceArea.postcodes", p));
      return ops;
    }

    case "EXCLUDE_SERVICE_AREA": {
      const ops = [];
      const current = (blueprint && blueprint.serviceArea && blueprint.serviceArea.suburbs) || [];
      for (const s of payload.suburbs) {
        ops.push(add("serviceArea.exclusions", s));
        // If it is currently served, take it off the served list too —
        // otherwise the configuration says both at once.
        if (current.some((c) => String(c).toLowerCase() === String(s).toLowerCase())) {
          ops.push(remove("serviceArea.suburbs", current.find((c) => String(c).toLowerCase() === String(s).toLowerCase())));
        }
      }
      return ops;
    }

    case "SET_GREETING": return [set("callHandling.greetingLine", payload.greeting)];
    case "SET_CALLBACK_POLICY": return [set("callHandling.callbackPolicy", payload.policy)];
    case "SET_TRANSFER_RULE":
      return [set(payload.whichNumber === "backup"
        ? "callHandling.escalation.backupNumber"
        : "callHandling.escalation.primaryNumber", payload.number)];

    case "SET_URGENCY_RULE":
      return [add("callHandling.urgencyRules", {
        ruleId: slug(payload.when),
        when: payload.when,
        level: payload.level,
        action: payload.action,
      })];

    case "SET_CALLER_INFORMATION": return [set("callHandling.collectAlways", payload.collect)];

    case "ADD_APPROVED_FACT":
      return [add("knowledge.approvedFacts", { factId: slug(payload.statement).slice(0, 40), statement: payload.statement })];

    case "REMOVE_APPROVED_FACT": {
      const fact = findFact(blueprint, payload.factRef);
      return fact ? [remove("knowledge.approvedFacts", fact)] : [];
    }

    case "SET_PRICING_POLICY": {
      const ops = [set("knowledge.pricingDisclosure", payload.disclosure)];
      if (payload.wording) ops.push(set("knowledge.pricingWording", payload.wording));
      return ops;
    }

    case "SET_BOOKING_SETTING": {
      const ops = [set("booking.enabled", payload.enabled)];
      if (payload.capabilityTarget) ops.push(set("booking.capabilityTarget", payload.capabilityTarget));
      return ops;
    }

    case "SET_INTEGRATION_REQUIREMENT":
      return [add("integrations", { capability: payload.capability, enabled: payload.enabled })];

    case "SET_VOICE_PREFERENCE": {
      const ops = [];
      if (payload.tone) ops.push(set("voice.tone", payload.tone));
      if (payload.language) ops.push(set("voice.language", payload.language));
      return ops;
    }

    case "SET_COMPLIANCE_WORDING":
      // DELIBERATELY COMPILES TO NOTHING.
      //
      // config-patch.js's PATCHABLE_PREFIXES does not include `compliance`, and
      // that is not an oversight — what a caller is told about recording is a
      // legal position, not a preference, and P4 decided a mishearing must not
      // be able to reach it. Found here when a sweep asserted every emitted
      // path is one config-patch permits.
      //
      // So the intent stays: a caller saying "change the recording message"
      // gets a specific answer instead of a shrug. It is answered by
      // voice-policy.js, which explains that the change belongs on the review
      // screen where somebody can read it before it is said to anybody.
      return [];

    case "PROPOSE_OUTBOUND_SETTING": {
      const ops = [];
      if (payload.proposition) ops.push(set("outbound.proposition", payload.proposition));
      if (payload.optOutWording) ops.push(set("outbound.optOutWording", payload.optOutWording));
      // Note what is NOT here: nothing sets outbound.enabled, and nothing
      // touches disclosure wording. Enabling outbound is not a configuration
      // conversation's business, and the disclosure is platform policy.
      return ops;
    }

    case "SET_BUSINESS_IDENTITY": {
      const ops = [];
      if (payload.legalName) ops.push(set("identity.legalName", payload.legalName));
      if (payload.tradingName) ops.push(set("identity.tradingName", payload.tradingName));
      if (payload.assistantName) ops.push(set("identity.assistantName", payload.assistantName));
      return ops;
    }

    default: return [];
  }
}

/**
 * Every confirmed change into one patch. Later changes win, because a caller
 * who says "four" and then "no, five" meant five — and emitting both would
 * apply them in list order and produce whichever the array happened to hold
 * last. The session engine already supersedes corrections; this de-duplicates
 * by path as a second guard.
 */
function compileChangesToPatch({ changes = [], blueprint = null, reason = null } = {}) {
  const confirmed = changes.filter((c) => c && c.state === "confirmed");
  if (confirmed.length === 0) return fail(COMPILER_CODES.NOTHING_TO_DO, "no confirmed changes to compile");

  const operations = [];
  const compiled = [];
  const skipped = [];

  for (const change of confirmed) {
    const ops = compileChange(change, blueprint);
    if (ops.length === 0) { skipped.push({ changeId: change.changeId, intent: change.intent, why: "compiled to no operation" }); continue; }
    operations.push(...ops);
    compiled.push(change.changeId);
  }

  if (operations.length === 0) {
    return fail(COMPILER_CODES.NOTHING_TO_DO, "every confirmed change compiled to nothing", { skipped: Object.freeze(skipped) });
  }

  // Last write per path wins, order otherwise preserved.
  const lastSetIndex = new Map();
  operations.forEach((op, i) => { if (op.op === "set") lastSetIndex.set(op.path, i); });
  const deduped = operations.filter((op, i) => op.op !== "set" || lastSetIndex.get(op.path) === i);

  return Object.freeze({
    ok: true,
    patch: Object.freeze({
      operations: Object.freeze(deduped),
      reason: reason || "Proposed in a voice configuration session and confirmed by the caller.",
    }),
    compiled: Object.freeze(compiled),
    skipped: Object.freeze(skipped),
    operationCount: deduped.length,
  });
}

module.exports = { compileChangesToPatch, compileChange, findService, findFact, slug, COMPILER_CODES };
