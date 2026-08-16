// AIDA PLATFORM — blueprint in, behaviour out (P5).
//
//   compileBehaviourSpec(activeBlueprint)  -> { spec, behaviourHash }
//
// ── THE BOUNDARY THIS HOLDS ─────────────────────────────────────────
//
//   Client Blueprint      what the business told us          (P2)
//        |
//   Agent Behaviour Spec  what the assistant should do       (here)
//        |
//   Provider payload      what Retell needs to be told       (P6)
//
// The middle layer exists so that swapping voice providers is a change to the
// last step only, and so that "what will the assistant say?" can be answered,
// reviewed and diffed without anybody reading a vendor's JSON.
//
// ── NO PROVIDER ANYTHING ────────────────────────────────────────────
// No Retell id, no voice id, no llm id, no webhook URL, no agent name. If a
// provider identifier can reach this object, the boundary is decorative. A
// ratchet asserts the compiled output is free of them.
//
// ── DETERMINISTIC ───────────────────────────────────────────────────
// Same blueprint version, same spec, same hash — always. Keys are emitted in a
// fixed order and every list is sorted by a stable key, so the hash changes
// when the MEANING changes and not when an editor reorders a form.
//
// That hash is what makes "has this client's behaviour changed?" a cheap,
// honest question. It is the same idea as the acquisition response-engine pin:
// something that already exists remotely can be compared against what the
// repository currently believes.

const crypto = require("crypto");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const byKey = (k) => (a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0);
const sortedStrings = (list) => (Array.isArray(list) ? [...list].map(String).sort() : []);

const BEHAVIOUR_SPEC_VERSION = "aida-behaviour-spec-2026-08-16";

/** JSON with recursively sorted keys, so property order cannot affect the hash. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function compileBehaviourSpec(bp) {
  if (!isObj(bp)) throw new Error("compileBehaviourSpec requires a blueprint");

  const id = bp.identity || {};
  const area = bp.serviceArea || {};
  const hours = bp.hours || {};
  const ch = bp.callHandling || {};
  const esc = ch.escalation || {};
  const know = bp.knowledge || {};
  const booking = bp.booking || {};
  const voice = bp.voice || {};
  const outbound = bp.outbound || {};

  const services = (Array.isArray(bp.services) ? bp.services : [])
    .filter((s) => isObj(s) && s.enabled !== false)
    .map((s) => ({
      serviceId: s.serviceId,
      name: s.name,
      aliases: sortedStrings(s.aliases),
      description: s.description ?? null,
      urgencyCategory: s.urgencyCategory,
      qualificationRequirements: sortedStrings(s.qualificationRequirements),
      exclusions: sortedStrings(s.exclusions),
      collect: sortedStrings(
        [...(Array.isArray(ch.collectAlways) ? ch.collectAlways : []),
         ...(isObj(ch.collectByService) && Array.isArray(ch.collectByService[s.serviceId]) ? ch.collectByService[s.serviceId] : [])],
      ).filter((x, i, a) => a.indexOf(x) === i),
    }))
    .sort(byKey("serviceId"));

  const spec = {
    specVersion: BEHAVIOUR_SPEC_VERSION,

    // ── who is speaking ──
    assistant: {
      name: id.assistantName ?? null,
      language: voice.language ?? id.locale ?? null,
      tone: voice.tone ?? null,
      // Every AIDA assistant discloses it is not a person. Platform-owned:
      // a client may not configure this away, and it is emitted for every
      // vertical whether or not the blueprint mentions it.
      disclosesAiWhenAsked: true,
    },

    business: {
      legalName: id.legalName ?? null,
      tradingName: id.tradingName ?? null,
      description: id.description ?? null,
      vertical: id.vertical ?? null,
      timezone: id.timezone ?? null,
      country: id.country ?? null,
    },

    greeting: {
      style: ch.greetingStyle ?? null,
      namesBusiness: true,
      namesAssistant: Boolean(id.assistantName),
    },

    services,

    serviceArea: {
      regions: sortedStrings(area.regions),
      suburbs: sortedStrings(area.suburbs),
      postcodes: sortedStrings(area.postcodes),
      exclusions: sortedStrings(area.exclusions),
      radiusKm: area.radiusKm ?? null,
      remoteServiceAvailable: area.remoteServiceAvailable ?? null,
      outsideAreaAction: area.outsideAreaAction ?? null,
      outsideAreaWording: area.outsideAreaWording ?? null,
    },

    availability: {
      timezone: hours.timezone ?? null,
      weekly: Object.fromEntries(
        Object.keys(hours.weekly || {}).sort().map((d) => [d, hours.weekly[d]]),
      ),
      closedPeriods: (Array.isArray(hours.closedPeriods) ? [...hours.closedPeriods] : []).sort(byKey("from")),
      afterHours: {
        available: hours.afterHours ? hours.afterHours.available ?? null : null,
        policy: hours.afterHours ? hours.afterHours.policy ?? null : null,
        surchargeApplies: hours.afterHours ? hours.afterHours.surchargeApplies ?? null : null,
      },
      publicHolidays: hours.publicHolidays ?? null,
      whenUnavailable: ch.unavailableAction ?? null,
    },

    intake: {
      collectAlways: sortedStrings(ch.collectAlways),
      additionalQuestions: (Array.isArray(ch.additionalQuestions) ? [...ch.additionalQuestions] : []).sort(byKey("id")),
      intentTaxonomy: (Array.isArray(ch.intentTaxonomy) ? [...ch.intentTaxonomy] : []).sort(byKey("intentId")),
    },

    urgency: {
      rules: (Array.isArray(ch.urgencyRules) ? [...ch.urgencyRules] : [])
        .map((r) => ({
          ruleId: r.ruleId,
          when: r.when,
          level: r.level,
          action: r.action,
          transferEligible: r.transferEligible ?? null,
          wording: r.wording ?? null,
        }))
        .sort(byKey("ruleId")),
    },

    escalation: {
      // The NUMBER is deliberately present: it is business configuration, not a
      // provider detail, and the assistant genuinely needs to know where a
      // transfer goes. It is not a Retell identifier.
      primaryNumber: esc.primaryNumber ?? null,
      backupNumber: esc.backupNumber ?? null,
      permittedHours: esc.permittedHours ?? null,
      eligibleServices: sortedStrings(esc.eligibleServices),
      minimumUrgency: esc.minimumUrgency ?? null,
      timeoutSeconds: esc.timeoutSeconds ?? null,
      preTransferWording: esc.preTransferWording ?? null,
      unansweredAction: esc.unansweredAction ?? null,
      maxAttempts: esc.maxAttempts ?? null,
      callbackPolicy: ch.callbackPolicy ?? null,
    },

    knowledge: {
      approvedFacts: (Array.isArray(know.approvedFacts) ? [...know.approvedFacts] : []).sort(byKey("factId")),
      prohibitedClaims: sortedStrings(know.prohibitedClaims),
      uncertaintyPolicy: know.uncertaintyPolicy ?? null,
      pricing: {
        disclosure: know.pricingDisclosure ?? null,
        wording: know.pricingWording ?? null,
      },
    },

    booking: {
      enabled: booking.enabled ?? false,
      appointmentTypes: (Array.isArray(booking.appointmentTypes) ? [...booking.appointmentTypes] : []).sort(byKey("typeId")),
      requiredInformation: sortedStrings(booking.requiredInformation),
      constraints: booking.constraints ?? null,
      // A CAPABILITY name, never a vendor or an account id.
      capability: booking.capabilityTarget ?? null,
    },

    // Capability description only. Compiling a spec authorises no call, and the
    // spec cannot express permission — there is nowhere to put it.
    outbound: {
      enabled: outbound.enabled ?? false,
      campaignType: outbound.campaignType ?? null,
      proposition: outbound.proposition ?? null,
      qualificationCriteria: sortedStrings(outbound.qualificationCriteria),
      disclosureWording: outbound.disclosureWording ?? null,
      optOutWording: outbound.optOutWording ?? null,
    },

    capabilities: (Array.isArray(bp.integrations) ? [...bp.integrations] : [])
      .filter(isObj)
      .map((x) => ({ capability: x.capability, enabled: x.enabled === true }))
      .sort(byKey("capability")),

    // Provenance, so a compiled spec can be traced to the exact approved words.
    sourceBlueprint: {
      clientId: id.clientId ?? null,
      configVersion: bp.metadata ? bp.metadata.configVersion ?? null : null,
      schemaVersion: bp.schemaVersion ?? null,
    },
  };

  // The hash covers the BEHAVIOUR, not its provenance: two clients with
  // genuinely identical behaviour should hash identically, and the same client
  // re-approving unchanged words should not produce a new hash.
  const hashable = { ...spec };
  delete hashable.sourceBlueprint;
  const behaviourHash = crypto.createHash("sha256").update(stableStringify(hashable)).digest("hex");

  return Object.freeze({ spec: Object.freeze(spec), behaviourHash });
}

module.exports = { compileBehaviourSpec, stableStringify, BEHAVIOUR_SPEC_VERSION };
