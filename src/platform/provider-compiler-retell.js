// AIDA PLATFORM — behaviour spec in, Retell PREVIEW out (P6).
//
//   compileRetellPreview({ spec, providerRefs })
//     -> { responseEngine, agent, payloadHash, unresolved[] }
//
// ── THE LAST STEP, AND THE ONLY ONE THAT KNOWS ABOUT RETELL ─────────
// Everything upstream is provider-independent by construction. This is where a
// vendor's vocabulary is allowed to appear, and it appears in exactly one
// direction: spec -> payload. Nothing here is read back into the blueprint or
// the behaviour spec, so Retell cannot become the source of AIDA truth.
//
// ── PREVIEW MEANS PREVIEW ───────────────────────────────────────────
// This module builds objects. It imports no transport, constructs no adapter
// and makes no request — the same posture as the acquisition agent spec, and
// for the same reason: a compiler that can also send is a compiler that will
// eventually send by accident. Provisioning stays a separate, hand-run,
// explicitly-authorised act.
//
// ── PROVIDER IDS ARE INJECTED, NEVER INVENTED ───────────────────────
// The voice id, the llm id and the webhook URL are deployment facts. They are
// passed in, and anything missing is reported by name in `unresolved` rather
// than defaulted — because a payload that quietly substitutes a placeholder is
// how the wrong voice reaches a real caller.
//
// ── TWO RESOURCES, NOT ONE ──────────────────────────────────────────
// The same split the acquisition work established the hard way (E-10C): the
// prompt belongs to a response engine, and the agent REFERENCES it. Sent as one
// object it would create an agent with no brain.

const crypto = require("crypto");
const { stableStringify } = require("./behaviour-spec");

const RETELL_COMPILER_VERSION = "aida-retell-compiler-2026-08-16";

const line = (s) => (s === null || s === undefined || s === "" ? null : String(s));

/** Human-readable prompt sections, assembled from the spec in a fixed order. */
function buildGeneralPrompt(spec) {
  const b = spec.business;
  const a = spec.assistant;
  const out = [];

  out.push("# Who you are");
  out.push(
    `You are ${a.name || "the assistant"}, an AI assistant answering the telephone for ` +
      `${b.tradingName || b.legalName || "this business"}.`,
  );
  out.push("If anyone asks whether you are a person, a robot or AI, say plainly that you are an AI assistant. Never imply you are human.");
  if (b.description) out.push(b.description);
  out.push("");

  if (spec.greeting.style) {
    out.push("# How you open");
    out.push(spec.greeting.style);
    out.push("");
  }

  out.push("# What this business does");
  for (const s of spec.services) {
    const aliases = s.aliases.length ? ` (also called: ${s.aliases.join(", ")})` : "";
    out.push(`- ${s.name}${aliases}${s.description ? ` — ${s.description}` : ""}`);
    if (s.exclusions.length) out.push(`  Not included: ${s.exclusions.join("; ")}`);
  }
  out.push("");

  const area = spec.serviceArea;
  if (area.regions.length || area.suburbs.length || area.postcodes.length || area.radiusKm) {
    out.push("# Where it works");
    if (area.regions.length) out.push(`Regions: ${area.regions.join(", ")}`);
    if (area.suburbs.length) out.push(`Suburbs: ${area.suburbs.join(", ")}`);
    if (area.postcodes.length) out.push(`Postcodes: ${area.postcodes.join(", ")}`);
    if (area.radiusKm) out.push(`Within roughly ${area.radiusKm}km.`);
    if (area.exclusions.length) out.push(`Not serviced: ${area.exclusions.join(", ")}`);
    if (area.outsideAreaWording) out.push(`If they are outside that: ${area.outsideAreaWording}`);
    out.push("");
  }

  out.push("# What you always find out");
  for (const f of spec.intake.collectAlways) out.push(`- ${f.replace(/_/g, " ")}`);
  for (const q of spec.intake.additionalQuestions) out.push(`- ${q.question}`);
  out.push("");

  if (spec.urgency.rules.length) {
    out.push("# Urgency");
    for (const r of spec.urgency.rules) {
      out.push(`- If ${r.when} — treat as ${r.level}, then ${r.action.replace(/_/g, " ")}.${r.wording ? ` Say: ${r.wording}` : ""}`);
    }
    out.push("");
  }

  out.push("# Hours");
  for (const [day, h] of Object.entries(spec.availability.weekly)) {
    out.push(`- ${day}: ${h && h.closed ? "closed" : `${h.open}–${h.close}`}`);
  }
  if (spec.availability.afterHours.available === true) {
    out.push(`After hours: available.${spec.availability.afterHours.policy ? ` ${spec.availability.afterHours.policy}` : ""}`);
  } else if (spec.availability.afterHours.available === false) {
    out.push("After hours: not available.");
  }
  out.push("");

  out.push("# Price");
  const p = spec.knowledge.pricing;
  if (p.disclosure === "never_discuss") out.push("Do not discuss price. Say it is confirmed by the business.");
  else if (p.disclosure === "callout_fee_only") out.push("You may state the call-out fee only. Quote nothing else.");
  else if (p.disclosure === "indicative_ranges") out.push("You may give indicative ranges only, never a firm quote.");
  else if (p.disclosure === "confirmed_at_booking") out.push("Say that price is confirmed at booking.");
  if (p.wording) out.push(p.wording);
  out.push("");

  out.push("# What you must never claim");
  for (const c of spec.knowledge.prohibitedClaims) out.push(`- ${c.replace(/_/g, " ")}`);
  out.push("");

  if (spec.knowledge.approvedFacts.length) {
    out.push("# Facts you may state");
    for (const f of spec.knowledge.approvedFacts) out.push(`- ${f.statement}`);
    out.push("");
  }

  if (spec.compliance.callsMayBeRecorded === true && spec.compliance.recordingDisclosure) {
    out.push("# Recording");
    out.push(`Early in the call, say: ${spec.compliance.recordingDisclosure}`);
    out.push("");
  }

  out.push("# When you are not sure");
  const u = spec.knowledge.uncertaintyPolicy;
  if (u === "say_unsure_and_take_message") out.push("Say you are not sure, take a message and tell them somebody will come back.");
  else if (u === "say_unsure_and_transfer") out.push("Say you are not sure and offer to put them through.");
  else if (u === "say_unsure_and_offer_callback") out.push("Say you are not sure and offer a callback.");
  out.push("Never guess. Never invent a fact about this business.");

  return out.join("\n");
}

/**
 * The LITERAL first sentence of the call.
 *
 * `greeting.style` is an instruction to the model ("Warm and brief. Name the
 * business, say you are an AI assistant") and belongs in the prompt, where it
 * already appears. Using it here would have the assistant open every call by
 * reading its own stage directions aloud.
 *
 * Constructed from identity rather than taken from configuration, so the AI
 * disclosure is in the first sentence of every call for every client. A client
 * who wants different opening words is asking for a schema change that goes
 * through the same approval path as anything else — not a free-text field that
 * can quietly drop the disclosure.
 */
function buildBeginMessage(spec) {
  const b = spec.business;
  const name = b.tradingName || b.legalName || "the business";
  const who = spec.assistant.name || "an assistant";
  return `Hi, you've reached ${name}. This is ${who}, an AI assistant. How can I help?`;
}

/**
 * The post-call analysis fields. Derived from the spec so a client that
 * collects different things gets different fields — without any vertical
 * branching.
 */
function buildAnalysisFields(spec) {
  const fields = [
    { type: "boolean", name: "reached_person", description: "Did a person actually speak on this call?" },
    { type: "string", name: "caller_intent", description: "What the caller wanted, in a short phrase." },
    {
      type: "enum",
      name: "urgency",
      description: "How urgent the caller's problem was.",
      choices: ["emergency", "urgent", "priority", "standard", "non_urgent", "unknown"],
    },
    {
      type: "enum",
      name: "service_requested",
      description: "Which service this call was about.",
      choices: [...spec.services.map((s) => s.serviceId), "other", "none"],
    },
    { type: "boolean", name: "within_service_area", description: "Was the caller inside the service area?" },
    { type: "boolean", name: "transfer_attempted", description: "Was a transfer attempted?" },
    { type: "string", name: "callback_number", description: "The number to call back on, if given." },
    { type: "string", name: "summary", description: "One short paragraph a person can read." },
  ];
  if (spec.booking.enabled) {
    fields.push({ type: "boolean", name: "booking_requested", description: "Did the caller ask to book?" });
  }
  return fields;
}

/**
 * @param {object} spec         a compiled behaviour spec
 * @param {object} providerRefs { llmId, voiceId, webhookUrl, agentNamePrefix }
 */
function compileRetellPreview({ spec, providerRefs = {} } = {}) {
  if (!spec || typeof spec !== "object") throw new Error("compileRetellPreview requires a behaviour spec");

  const unresolved = [];
  const need = (value, name) => {
    if (value === null || value === undefined || value === "") { unresolved.push(name); return null; }
    return value;
  };

  const responseEngine = {
    general_prompt: buildGeneralPrompt(spec),
    begin_message: buildBeginMessage(spec),
    default_dynamic_variables: {},
    general_tools: [],
  };

  const clientId = spec.sourceBlueprint ? spec.sourceBlueprint.clientId : null;
  const prefix = providerRefs.agentNamePrefix || "aida";

  const agent = {
    agent_name: `${prefix}-${clientId || "unknown"}-v${spec.sourceBlueprint ? spec.sourceBlueprint.configVersion : 0}`,
    response_engine: { type: "retell-llm", llm_id: need(providerRefs.llmId, "llmId") },
    voice_id: need(providerRefs.voiceId, "voiceId"),
    language: spec.assistant.language || "en-AU",
    webhook_url: need(providerRefs.webhookUrl, "webhookUrl"),
    post_call_analysis_data: buildAnalysisFields(spec),
  };

  // ── HASHES ────────────────────────────────────────────────────────
  // One per RESOURCE, because Retell has two and they are created and updated
  // independently — the same split provider_resources already stores a payload
  // hash against.
  //
  // The agent hash covers voice_id, llm_id and webhook_url deliberately. An
  // earlier draft of this file excluded them on the theory that provider refs
  // are deployment facts rather than behaviour. That was backwards: the VOICE
  // is the single field E-12B established must never change silently, and a
  // hash that cannot see it is a drift detector blind to the drift that
  // matters. Behaviour-level comparison is what `behaviourHash` is for.
  const sha = (value) => crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
  const responseEngineHash = sha(responseEngine);
  const agentHash = sha(agent);
  const payloadHash = sha({ responseEngine, agent });

  return Object.freeze({
    compilerVersion: RETELL_COMPILER_VERSION,
    responseEngine: Object.freeze(responseEngine),
    agent: Object.freeze(agent),
    responseEngineHash,
    agentHash,
    payloadHash,
    unresolved: Object.freeze(unresolved),
    ready: unresolved.length === 0,
  });
}

module.exports = { compileRetellPreview, RETELL_COMPILER_VERSION };
