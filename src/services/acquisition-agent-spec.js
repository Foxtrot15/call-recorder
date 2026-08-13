// AIDA Locksmith Acquisition — the outbound agent specification (E-10A).
//
//   ACQUISITION_AGENT_SPEC              the canonical behavioural contract
//   buildAcquisitionOpening(identity)   the first thing a stranger hears
//   buildAcquisitionAgentPrompt(...)    the general_prompt sections
//   buildAcquisitionAnalysisFields()    Retell post_call_analysis_data
//   buildAcquisitionAgent(...)          the create-agent request, unsent
//   describeAcquisitionRetellResources() both, plus what is not ready
//
// ── LOCAL ONLY. NOTHING HERE CREATES OR CONTACTS AN AGENT ───────────
// It builds strings and objects. No network client is imported, no credential
// is read, no host is named, and the builders return the requests that WOULD be
// sent rather than sending them. Provisioning is a separate founder-authorised
// milestone.
//
// ── WHY A THIRD AGENT ───────────────────────────────────────────────
// The receptionist serves a locksmith's own inbound callers. The onboarding
// agent interviews a client who asked to be interviewed. This one telephones a
// business that did not ask, has never heard of us, and owes us nothing. It is
// the only one of the three that must identify itself unprompted, take a no,
// and record a request never to be called again.
//
// ── THE OPENING IS BUILT FROM PARTS, NOT FROZEN AS A SENTENCE ───────
// A ratchet that pinned one exact string would forbid tuning a comma for
// speech, and would be switched off the first time somebody needed to. So the
// opening is assembled from named parts and the ratchets assert the PARTS: the
// assistant names itself, says "AI assistant", names the company, and states
// why it is calling. The wording can move; those four cannot.

const S = require("./acquisition-agent-contract");

const SPEC_VERSION = "acq-agent-spec-2026-08-13";

/**
 * WHO IS CALLING, AND WHAT THEY ARE CALLING ABOUT.
 *
 * ── THREE ROLES, THREE FIELDS, DELIBERATELY NOT MERGED ──────────────
 *
 *   assistantName   Aida          the thing speaking
 *   companyName     Niche Drops   the BUSINESS placing the call
 *   productName     AIDA          the PRODUCT being discussed
 *
 * The first draft of this file collapsed the second and third, because the
 * approved opening said "calling from AIDA" — and AIDA is the product, while
 * `PROVIDER_NAME` in src/config/locksmith.js is "Niche Drops". A cold call that
 * names the product as the caller misidentifies who is telephoning, which is
 * the one fact a stranger is entitled to be told accurately.
 *
 * They stay separate fields for that reason. Merging them to make a sentence
 * flow would put the ambiguity back, and the prompt states each role explicitly
 * so the agent cannot say "AIDA is my company" or "Niche Drops is the AI
 * receptionist".
 */
const DEFAULT_IDENTITY = Object.freeze({
  assistantName: "Aida",
  companyName: "Niche Drops",
  productName: "AIDA",
  // Not a legal claim. The founder's product decision is to disclose, and the
  // contract records it as such rather than as a statutory requirement.
  disclosure: "an AI assistant",
  productDescription: "our AI receptionist for locksmiths",
  valueProposition: "We help with missed and after-hours calls",
  reasonForCalling: "I was just calling to see if that might be useful for your business.",
});

/**
 * Claims this agent may make, taken from what the product page actually says.
 *
 * Source: src/views/locksmith-page.js — "answers missed and after-hours calls,
 * captures the customer's location and lock problem, and escalates urgent jobs
 * according to your rules."
 */
const PERMITTED_CLAIMS = Object.freeze([
  "AIDA answers missed and after-hours calls for the business.",
  "It captures the caller's location and what the lock problem is.",
  "It escalates urgent jobs according to rules the business sets.",
  "How calls are handled is configured by the business, and changes are reviewed before they take effect.",
  "It is intended to reduce missed enquiries and capture more after-hours work.",
]);

/**
 * Claims it may NOT make, and the tagline is on the list on purpose.
 *
 * "Never lose another after-hours locksmith enquiry" is the marketing tagline
 * in src/config/locksmith.js. It is an ABSOLUTE, and no infrastructure in this
 * repository justifies an absolute. Landing-page copy is read by somebody who
 * chose to visit; a cold call is not, and the same sentence spoken down a
 * telephone to a stranger is a promise rather than a headline.
 */
const FORBIDDEN_CLAIMS = Object.freeze([
  "Never misses a call, or any absolute about never losing an enquiry — including the marketing tagline.",
  "Guaranteed revenue, bookings, savings or return of any kind.",
  "A guarantee that a technician will attend, or when.",
  "Equivalence to a human receptionist, or any suggestion the caller is speaking to a person.",
  "Integrations, CRM connections or features that are not built.",
  "Any regulatory, legal or compliance guarantee.",
  "Any claim about the recipient's own business that we have not been told on this call.",
]);

/** How to behave when money comes up. */
const PRICE_RULE = Object.freeze({
  proactive: false,
  reason:
    "Pricing is provisional (src/config/locksmith.js sets provisional: true) and is overridable per deployment, " +
    "so it has exactly one numeric source and a prompt is not it. The agent does not raise price, and quotes " +
    "nothing from memory.",
  whenAsked:
    "Give the founding-pilot figures ONLY if they were supplied to this call as data, say plainly that they are " +
    "for the founding pilot and confirmed at setup, and offer to send the details in writing. If they were not " +
    "supplied, say the pilot pricing is confirmed at setup and offer to have it sent through.",
  neverInvent: true,
});

/** The behaviours that decide whether this call was acceptable. */
const BEHAVIOURS = Object.freeze({
  notInterested: Object.freeze({
    trigger: "A clear statement that they are not interested.",
    response: "Acknowledge once, thank them, end the call.",
    forbidden: "Any second pitch, any 'can I just ask', any reframing of the offer.",
    classifies: "not_interested",
    consequence: "Permanent — never cold-acquired again (A-L8).",
  }),
  declined: Object.freeze({
    trigger: "They understood the offer and said no to it.",
    response: "Acknowledge, thank them, end the call.",
    forbidden: "A second close of any kind.",
    classifies: "declined",
    consequence: "Permanent — never cold-acquired again (A-L8). Kept DISTINCT from not_interested for audit.",
  }),
  optOut: Object.freeze({
    trigger: "Any request not to be contacted again — see EXPLICIT_OPT_OUT_RULE.",
    response: "Agree immediately, confirm we will not contact them again, thank them, END.",
    forbidden:
      "Asking why. Asking if they are sure. Any qualification question. Any offer. Anything at all except " +
      "agreeing and ending.",
    classifies: "opt_out",
    consequence: "Permanent, business-wide, cross-campaign suppression. Stronger than a decline.",
  }),
  callback: Object.freeze({
    trigger: "They ask to be called back, or name a better time.",
    response: "Confirm the day and rough time if it comes up naturally, thank them, end.",
    forbidden: "Promising an exact time. Scheduling anything. Implying a calendar entry exists.",
    classifies: "callback",
    consequence: "A callback exception — NOT a suppression. Honoured for 14 days (A-L8).",
  }),
  busy: Object.freeze({
    trigger: "\"Busy\", \"not now\", \"I'm on a job\".",
    response: "Offer to try another time. One short sentence, then let them go.",
    forbidden: "Treating this as a refusal, or as permission to keep talking.",
    classifies:
      "callback if they name a better time; otherwise NOTHING durable — a busy moment is not an answer about the offer.",
  }),
  aiQuestion: Object.freeze({
    trigger: "Asked whether it is AI, a robot, automated, a real person, or human.",
    response: "Answer plainly and immediately that it is an AI assistant, then continue only if they want to.",
    forbidden:
      "Any evasion, deflection, joke that dodges the question, or wording that could leave them thinking they " +
      "are speaking to a person. It may never claim to be human.",
    classifies: "nothing by itself",
  }),
  gatekeeper: Object.freeze({
    trigger: "The person answering is not the right contact.",
    response: "Be brief and polite, and ask only whether there is a better time or person.",
    forbidden:
      "Pitching them personally. Pressing for a name, a mobile or a direct line. Inventing another number to try.",
    classifies: "wrong_person where the number does not reach this business at all",
  }),
  hostile: Object.freeze({
    trigger: "Anger, abuse, or a demand to stop talking.",
    response: "Do not argue or defend. Apologise once for the interruption and end the call.",
    forbidden: "Any continuation. Any justification of why we called.",
    classifies: "opt_out only if they actually asked not to be contacted again; otherwise the conversation stands on its own words.",
  }),
});

/**
 * VOICEMAIL — the recommendation is NO MESSAGE for the first live proof.
 *
 * Three reasons, and the third is the one that decides it:
 *
 *   1. Under A-L7 a voicemail CONSUMES one of the two counted attempts, while a
 *      no-answer consumes none. Leaving a message therefore spends half the
 *      permitted contact with a business on a recording nobody has agreed to
 *      receive.
 *   2. Nothing in this repository has ever produced or reviewed a recorded
 *      acquisition message, and a first live proof is the wrong moment to hear
 *      one for the first time.
 *   3. Machine detection is a PROVIDER behaviour. As of E-12A it is CONFIGURED
 *      — the agent carries `voicemail_option.action.type: "hangup"` — but it
 *      has never been OBSERVED on a real call. Drafting a message that assumed
 *      reliable detection would still be inventing a capability, which is the
 *      failure mode this whole milestone is built to avoid.
 *
 * A template is therefore deliberately NOT provided. If the founder later wants
 * one, it is a small, separate, reviewable decision — and it should be made
 * after machine detection has actually been observed working.
 */
const VOICEMAIL_POLICY = Object.freeze({
  leaveMessage: false,
  recommendation: "Hang up without leaving a message for the first live proof.",
  template: null,
  attemptCost: "A voicemail consumes a counted attempt (A-L7); a no-answer does not.",
  // E-12A. The policy is now carried by a PROVIDER field on the agent
  // (`voicemail_option.action.type`), not by a sentence in the prompt. The
  // prompt still says it, but as defence in depth behind something Retell
  // enforces without consulting the model.
  providerAction: "hangup",
  providerAuthority: "retell_agent.voicemail_option.action.type",
  revisitWhen: "Machine detection has been observed working, and a message has been written and approved.",
});

const CONVERSATION_STYLE = Object.freeze([
  "Warm, brief and unhurried. Short turns — a few sentences at most.",
  "Ask one thing at a time and wait for the answer.",
  "Stop talking the moment they start. Never talk over them.",
  "Plain Australian conversational English. No slang performance, no caricature.",
  "No hype, no urgency, no scarcity, no flattery.",
  "Never assume anything about their business you have not been told on this call.",
  "If they are not engaging, stop early rather than filling the silence.",
]);

/** The one question worth asking, in the family the founder specified. */
const FIRST_VALUE_QUESTION = "Do you ever miss calls when you're on a job or after hours?";

const CONVERSATION_GOALS = Object.freeze([
  "Introduce AIDA in a sentence, having already said what it is.",
  "Find out whether missed or after-hours calls are actually a problem for them.",
  "If they are interested, offer a clear and modest next step.",
  "If they are not, end the call quickly and courteously.",
]);

const END_CALL_TRIGGERS = Object.freeze([
  "They ask to end the call.",
  "They ask not to be contacted again.",
  "They clearly say they are not interested.",
  "They clearly decline the offer.",
  "They make plain that they do not want the conversation to continue.",
]);

const ACQUISITION_AGENT_SPEC = Object.freeze({
  version: SPEC_VERSION,
  purpose: "cold_acquisition",
  appliesTo: "Outbound acquisition calls to locksmith businesses that have not asked to be contacted.",
  identity: DEFAULT_IDENTITY,
  goals: CONVERSATION_GOALS,
  style: CONVERSATION_STYLE,
  firstValueQuestion: FIRST_VALUE_QUESTION,
  permittedClaims: PERMITTED_CLAIMS,
  forbiddenClaims: FORBIDDEN_CLAIMS,
  price: PRICE_RULE,
  behaviours: BEHAVIOURS,
  voicemail: VOICEMAIL_POLICY,
  endCall: END_CALL_TRIGGERS,
  // The E-7B2B1 contract still governs. This spec is what the agent SAYS; that
  // contract is what the system will ACCEPT back.
  governedBy: S.ACQUISITION_AGENT_CONTRACT.version,
});

/**
 * THE OPENING — CONCEPT COPY, NOT FROZEN WORDING.
 *
 * The current sentence is a founder-approved concept and is expected to be
 * tuned for speech. No test asserts it verbatim, and none should: a ratchet
 * that pinned one string would forbid moving a comma and would be switched off
 * the first time somebody needed to.
 *
 * What the ratchets assert instead is MEANING — the seven things that must
 * survive any rewrite. See `describeOpeningSemantics`.
 */
function buildAcquisitionOpening(identity = DEFAULT_IDENTITY) {
  const id = { ...DEFAULT_IDENTITY, ...(identity || {}) };
  return (
    `Hi, this is ${id.assistantName}, ${id.disclosure} from ${id.companyName}. ` +
    `I'm calling about ${id.productName}, ${id.productDescription}. ` +
    `${id.valueProposition}, and ${id.reasonForCalling}`
  );
}

/**
 * What an opening actually conveys, checked as MEANING rather than as text.
 *
 * Every requirement is expressed against the CONFIGURED identity, so rewording,
 * reordering, or replacing "calling about X" with any equivalent phrasing all
 * pass — while dropping a required fact fails. That is the difference between a
 * ratchet that protects the obligation and one that protects a sentence.
 *
 * @returns {object} one boolean per requirement, plus `ok`
 */
function describeOpeningSemantics(opening = "", identity = DEFAULT_IDENTITY) {
  const id = { ...DEFAULT_IDENTITY, ...(identity || {}) };
  const text = String(opening);
  const lower = text.toLowerCase();
  const has = (v) => Boolean(v) && lower.includes(String(v).toLowerCase());
  const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const checks = {
    // 1. The assistant names itself — IN A SELF-IDENTIFYING CONTEXT.
    //
    // A plain substring test is not good enough here, and the reason is the
    // exact ambiguity this identity model exists to remove: "Aida" is a
    // substring of "AIDA", so an opening that only mentioned the PRODUCT would
    // have counted as the assistant introducing itself. It must actually say
    // "this is Aida" / "I'm Aida" / "my name is Aida".
    namesAssistant: new RegExp(`\\b(?:this is|i'?m|i am|my name is)\\s+${escapeRe(id.assistantName)}\\b`, "i").test(text),
    // 2. It says plainly that it is AI. Any phrasing carrying "AI" plus an
    //    assistant-ish noun counts; "artificial intelligence" counts too.
    disclosesAI: /\bA\.?I\.?\b/i.test(text) || /artificial intelligence/i.test(text),
    // 3. The BUSINESS placing the call is named.
    namesCompany: has(id.companyName),
    // 4. The PRODUCT is named, AND framed as a thing being discussed.
    //
    // The mirror of the problem above: "AIDA" contains "Aida", so an opening
    // that only introduced the ASSISTANT would otherwise have counted as
    // naming the product. It has to appear in a product frame — "calling about
    // AIDA", "we provide AIDA", "AIDA, our AI receptionist".
    // An appositive frame ("AIDA, our AI receptionist") is deliberately NOT
    // accepted: it collides with the assistant's own introduction, "Aida, an
    // AI assistant". The frames below are ones only a product can occupy.
    namesProduct: new RegExp(
      `(?:\\b(?:about|regarding|our|called|named|introducing)\\s+${escapeRe(id.productName)}\\b)` +
        `|(?:\\bwe(?:'ve)?\\s+(?:provide|offer|make|built|have|created)\\s+${escapeRe(id.productName)}\\b)` +
        `|(?:\\b${escapeRe(id.productName)}\\s+(?:is|handles|answers|picks up|covers|does)\\b)`,
      "i"
    ).test(text),
    // 5. Commercial purpose is legible — it is selling something to a business.
    statesPurpose: /\buseful\b|\bhelp\b|\bcalling about\b|\bfor your business\b/i.test(text),
    // 6. The missed / after-hours value proposition survives.
    statesValue: /missed/i.test(text) && /after[- ]hours/i.test(text),
    // 7. Still an opening, not a monologue.
    concise: text.split(/\s+/).filter(Boolean).length <= 90,
  };

  // The product must not be presented AS the caller — "from AIDA" when the
  // company is Niche Drops is precisely the defect this correction fixes.
  checks.doesNotNameProductAsCaller =
    id.productName === id.companyName || !new RegExp(`\\bfrom\\s+${id.productName}\\b`, "i").test(text);

  // And it may never present itself as a person. Written to catch the claim
  // however it is phrased — "I'm a human", "this is Aida, a real person" —
  // rather than only the first-person form.
  //
  // It would also flag "I'm not a real person", which is honest but is not the
  // approved phrasing; the approved form is "I'm an AI assistant", so the
  // false positive costs nothing.
  checks.doesNotClaimHuman =
    !/\b(?:a|an)\s+(?:real\s+person|human(?:\s+being)?)\b/i.test(text) &&
    !/\b(?:i am|i'?m)\s+(?:a\s+)?(?:human|person)\b/i.test(text);

  return Object.freeze({ ...checks, ok: Object.values(checks).every(Boolean) });
}

const bullet = (lines) => lines.filter(Boolean).map((l) => `- ${l}`).join("\n");

/**
 * The agent's `general_prompt`.
 *
 * Assembled from the spec so the prompt and the contract cannot drift: there is
 * no second copy of the rules written out in prose for a human to update
 * separately.
 *
 * @param {object} [identity]
 * @param {object} [pricing]  { setupAmount, monthlyAmount, currency, ... } or null.
 *                            Passed in from config at compile time — NEVER
 *                            hardcoded here, because the config declares itself
 *                            provisional and has exactly one numeric source.
 */
function buildAcquisitionAgentPrompt({ identity = DEFAULT_IDENTITY, pricing = null } = {}) {
  const id = { ...DEFAULT_IDENTITY, ...(identity || {}) };

  const priceLines = pricing
    ? [
        `If they ask about price: the founding pilot is ${pricing.currency}${pricing.setupAmount} to set up and ` +
          `${pricing.currency}${pricing.monthlyAmount} a month, ${pricing.commitment || "month-to-month"}. ` +
          "Say it is founding-pilot pricing confirmed at setup, and offer to send the details in writing.",
        "Do not raise price yourself, and do not quote any other number.",
      ]
    : [
        "If they ask about price: say the founding-pilot pricing is confirmed at setup and offer to have the " +
          "details sent through. Do not quote a number — you have not been given one.",
        "Do not raise price yourself.",
      ];

  return [
    `# Who you are, and who you are not`,
    `You are ${id.assistantName}, ${id.disclosure} making an outbound call for ${id.companyName}.`,
    ``,
    `Three names, three different things. Keep them straight, because a stranger is entitled to know exactly`,
    `who is telephoning them:`,
    bullet([
      `${id.assistantName} — you. The assistant speaking.`,
      `${id.companyName} — THE BUSINESS placing this call. This is who you are from.`,
      `${id.productName} — THE PRODUCT you are calling about: ${id.productDescription}.`,
    ]),
    ``,
    `Never say that ${id.productName} is your company, never say you are calling "from ${id.productName}", and`,
    `never describe ${id.companyName} as the receptionist product. You are from ${id.companyName}; you are`,
    `calling about ${id.productName}.`,
    ``,
    `You are calling a locksmith business that has NOT asked to hear from you. They owe you nothing, and the`,
    `call is an interruption. Behave accordingly.`,
    ``,
    `# How you open`,
    buildAcquisitionOpening(id),
    ``,
    `You say this unprompted, at the start, before anything else. You never wait to be asked what you are.`,
    `The wording above is a guide — say it naturally rather than reciting it — but every part of it must be`,
    `there: your name, that you are ${id.disclosure}, that you are from ${id.companyName}, that you are calling`,
    `about ${id.productName}, and why.`,
    ``,
    `# If they ask whether you are AI, a robot, automated, or a real person`,
    `Answer immediately and plainly: yes, you are ${id.disclosure} from ${id.companyName}.`,
    `Never say or imply that you are a person, human, or "just like" a member of staff. Never dodge the question,`,
    `change the subject, or answer it with a joke. This rule has no exceptions.`,
    ``,
    `# What you are trying to find out`,
    bullet(CONVERSATION_GOALS),
    ``,
    `A good early question is: "${FIRST_VALUE_QUESTION}"`,
    `Ask it naturally, and skip it if the conversation has already answered it.`,
    ``,
    `# How you speak`,
    bullet(CONVERSATION_STYLE),
    ``,
    `# What you may say about the product`,
    bullet(PERMITTED_CLAIMS),
    ``,
    `# What you must never claim`,
    bullet(FORBIDDEN_CLAIMS),
    ``,
    `# Price`,
    bullet(priceLines),
    ``,
    `# If they are not interested`,
    `Acknowledge it once, thank them, and end the call. Do not pitch again. Do not ask why. Do not reframe the`,
    `offer and try once more. One "no" is the whole answer.`,
    ``,
    `# If they decline the offer`,
    `Same: acknowledge, thank them, end. No second close.`,
    ``,
    `# If they ask not to be contacted again`,
    `Agree immediately. Say something like: "Absolutely. I'll make sure we don't contact you again. Thanks for`,
    `your time." Then END THE CALL.`,
    `Do not ask why. Do not ask if they are sure. Do not ask anything. Do not offer anything. This is the one`,
    `moment in the call where you say nothing except agreement.`,
    ``,
    `# If they ask you to call back`,
    `Confirm the day and rough time if it comes up naturally, thank them, and end. Do not promise an exact time`,
    `and do not imply anything has been scheduled.`,
    ``,
    `# If it is a bad moment`,
    `"Busy", "not now", "I'm on a job" are NOT a refusal. Offer to try another time in one short sentence, then`,
    `let them go.`,
    ``,
    `# If they are not the right person`,
    `Be brief and polite. Ask only whether there is a better time or person. Do not pitch them personally, do not`,
    `press for a name or a direct number, and never invent another number to try.`,
    ``,
    `# If they are annoyed`,
    `Do not argue and do not defend the call. Apologise once for interrupting them and end.`,
    ``,
    `# When to end the call`,
    bullet(END_CALL_TRIGGERS),
    ``,
    `After any of these, there is no rescue attempt. You end the call.`,
  ].join("\n");
}

/**
 * Retell `post_call_analysis_data`, in the shape this repository already uses
 * (type/name/description, `choices` for enums) — see
 * locksmith-analysis-schema.js and the receptionist compiler.
 *
 * The enum is the E-7B2B1 CONVERSATION vocabulary, deliberately. `voicemail`
 * and `no_answer` are NOT here: they are machine facts derived from
 * `disconnection_reason` at call_ended, and letting the analysis assert them
 * too would put one fact behind two sources that can disagree.
 */
function buildAcquisitionAnalysisFields() {
  return Object.freeze([
    { type: "system-presets", name: "call_summary" },
    { type: "system-presets", name: "call_successful" },
    {
      type: "boolean",
      name: "reached_human",
      description: "Did a person actually speak with you on this call? False for voicemail, silence or a failed connection.",
    },
    {
      type: "enum",
      name: "final_outcome",
      description: "How the conversation actually ended. Choose no_meaningful_conversation if nobody engaged.",
      choices: [...S.ANALYSED_OUTCOMES],
    },
    {
      type: "boolean",
      name: "explicit_opt_out",
      description:
        "TRUE only if they asked not to be contacted again — for example 'don't call me again', 'take me off " +
        "your list', 'stop calling'. Being busy, saying 'not now', 'maybe later', or simply not being interested " +
        "is NOT an opt-out. If you are unsure, answer false.",
    },
    { type: "boolean", name: "callback_requested", description: "Did they ask to be called back another time?" },
    {
      type: "string",
      name: "requested_callback_at",
      description: "The day and time they asked for, if they named one. Leave empty if they did not.",
    },
    {
      type: "enum",
      name: "confidence",
      description: "How confident you are in final_outcome and explicit_opt_out. Answer low if the call was unclear.",
      choices: [...S.CONFIDENCE_LEVELS],
    },
    {
      type: "string",
      name: "transcript_evidence",
      description:
        "A short quote or turn reference showing where the outcome was decided. REQUIRED when explicit_opt_out " +
        "is true. Do not paste the whole transcript.",
    },
    { type: "string", name: "brief_reason", description: "One short sentence explaining the outcome, for a person reading the record." },
  ]);
}

// ── TWO RESOURCES, NOT ONE (E-10C) ──────────────────────────────────
//
// The first version of this file described ONE object carrying agent fields
// AND `general_prompt` AND `begin_message`. That was wrong against Retell's API
// and against this repository's own convention, which both compilers already
// follow:
//
//   response engine   POST /create-retell-llm   general_prompt, begin_message,
//                                               default_dynamic_variables,
//                                               general_tools
//   agent             POST /create-agent        agent_name, response_engine,
//                                               voice_id, language,
//                                               webhook_url,
//                                               post_call_analysis_data
//
// Sent as it was, it would have created an agent whose `llm_id` was null — an
// agent with no brain — while the prompt went to an endpoint that does not take
// one. The dependency is real and is now expressed as one.

const ACQUISITION_RESOURCE_PREFIX = "aida-acquisition";

/**
 * The acquisition provisioning order, DELIBERATELY NOT in
 * provisioning-plan.js's DESIRED_RESOURCE_ORDER.
 *
 * ── WHY IT LIVES HERE INSTEAD ───────────────────────────────────────
 * That list is keyed by `resourceType`, and `buildDesiredResources` looks each
 * entry up in a `byResource` map built from ONE compiled receptionist. An
 * acquisition entry with `resourceType: "response_engine"` would therefore be
 * handed the RECEPTIONIST's engine payload and emitted as an
 * acquisition-purposed row carrying receptionist content.
 *
 * There is no executor today — nothing dispatches `operation` to an adapter —
 * so this could not provision anything by itself. But "it cannot run yet" is a
 * poor reason to leave a landmine where the next person will step on it, and
 * acquisition provisioning must be an explicit act rather than a side effect of
 * planning a receptionist.
 */
const ACQUISITION_RESOURCE_ORDER = Object.freeze([
  Object.freeze({ purpose: "acquisition_agent", resourceType: "response_engine", operation: "createResponseEngine", updateOperation: "updateResponseEngine", dependsOn: null }),
  Object.freeze({ purpose: "acquisition_agent", resourceType: "voice_agent", operation: "createAgent", updateOperation: "updateAgent", dependsOn: "response_engine" }),
]);

/** The Retell LLM. Everything the agent SAYS lives here. */
function buildAcquisitionResponseEngine({ identity = DEFAULT_IDENTITY, pricing = null } = {}) {
  const id = { ...DEFAULT_IDENTITY, ...(identity || {}) };
  return Object.freeze({
    general_prompt: buildAcquisitionAgentPrompt({ identity: id, pricing }),
    begin_message: buildAcquisitionOpening(id),
    // Declared so a missing variable at call time is an empty string rather
    // than a literal placeholder spoken down the telephone. The dial provider
    // supplies both per call (E-7B2A).
    default_dynamic_variables: Object.freeze({ business_name: "", authorised_at: "" }),
    // No tools. This agent books nothing, looks nothing up, and calls no
    // endpoint of ours — giving it a tool would be giving it a capability
    // nobody has approved.
    general_tools: Object.freeze([]),
  });
}

/**
 * THE VOICE THE FOUNDER CHOSE (E-12B).
 *
 * ── WHY THE ID IS NOT HERE ──────────────────────────────────────────
 * This records the DECISION — who chose, what they chose, and where the value
 * lives — but not the value. A Retell voice id is deployment configuration, the
 * same class of thing as RETELL_ACQUISITION_LLM_ID, and hardcoding it here would
 * put a dev-account resource id into source that every environment then shares.
 *
 * ── WHY IT NAMES AN ACQUISITION-ONLY KEY ────────────────────────────
 * `RETELL_DEFAULT_VOICE_ID` currently happens to hold the same voice. That is a
 * coincidence, and treating it as the source would wire the receptionist's voice
 * to every cold call — see resolveAcquisitionVoiceId in config/acquisition.js.
 *
 * The selection was made from a read-only catalogue listing. Retell reported no
 * `accent`, `gender` or `age` metadata for this voice at all — its name claims
 * an Australian female and the founder confirmed it BY LISTENING to the preview,
 * which is the only evidence that was ever going to settle it.
 */
const SELECTED_VOICE = Object.freeze({
  voiceName: "Sunny - Australian Female",
  provider: "elevenlabs",
  voiceType: "custom",
  envVar: "RETELL_ACQUISITION_VOICE_ID",
  selectedBy: "founder",
  selectedOn: "2026-08-13",
  selectedFrom: "E-12B read-only list-voices catalogue (272 voices)",
  accentEvidence: "founder audition of the preview — Retell returned no accent metadata for this voice",
});

/**
 * WHAT WAS ACTUALLY SENT TO RETELL, PINNED (E-12B).
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────
 * E-10D(i) created a real Retell response engine from
 * `describeAcquisitionRetellResources().responseEngine`. That resource now
 * exists remotely and runs whatever prompt it was given. Nothing about editing
 * `general_prompt` or `begin_message` in this file would change it, and nothing
 * would fail — the repository would simply start describing behaviour that the
 * live engine does not have, and the first place anybody would notice is a
 * telephone call.
 *
 * So the payload is pinned by hash. Changing the copy is still allowed; changing
 * it SILENTLY is not. A failing ratchet turns an edit into a decision about the
 * remote resource, which is what it always was.
 *
 * ── WHY A HASH RATHER THAN A COPY OF THE TEXT ───────────────────────
 * A second copy of a 5,373-character prompt in the test tree would be edited in
 * lockstep with the first by anybody using find-and-replace, which is exactly
 * the person this is meant to stop.
 *
 * ── HOW IT IS COMPUTED ──────────────────────────────────────────────
 * `payloadHash` from voice-platform-port.js — sha256 over `stableStringify`,
 * the repository's existing canonical form (recursively sorted keys, so
 * property order cannot change the hash). Deliberately NOT a new convention:
 * provisioning-plan.js and provider-resource-registry.js already hash provider
 * payloads this way.
 *
 * ── WHAT IS IN SCOPE ────────────────────────────────────────────────
 * The four fields of the `create-retell-llm` body and nothing else. Agent
 * fields — voice, webhook, analysis, the E-12A voicemail policy — are a
 * different API resource that has never been created, so they must not move
 * this hash. Tests assert both directions.
 *
 * Verified reproducible: the payload built from commit d591262 (the E-10D(i)
 * provisioning commit), from 31075f2 and from this commit all hash identically.
 */
const PROVISIONED_RESPONSE_ENGINE = Object.freeze({
  payloadHash: "b0b5e21e3fcf7bcd7db9bacc577250689f5096a8705b9dd0d3b4ac18115e0542",
  provisionedAt: "2026-08-13",
  provisionedByMilestone: "E-10D(i)",
  provisionedFromCommit: "d591262",
  specVersion: SPEC_VERSION,
  remoteVersionAtCreation: 0,
  // The llm_id is deployment configuration and lives in the environment as
  // RETELL_ACQUISITION_LLM_ID. It is deliberately absent here.
  llmIdEnvVar: "RETELL_ACQUISITION_LLM_ID",
  fields: Object.freeze(["begin_message", "default_dynamic_variables", "general_prompt", "general_tools"]),
});

/** The message a drift failure should print. Kept beside the pin it explains. */
const RESPONSE_ENGINE_DRIFT_MESSAGE = [
  "The acquisition response engine has ALREADY BEEN PROVISIONED at Retell.",
  "The local response-engine payload has changed, so this repository now describes",
  "behaviour the live engine does not have.",
  "",
  "Do not silently accept this. Either revert the change, or make it an explicit",
  "decision: update/re-provision the remote response engine and re-pin",
  "PROVISIONED_RESPONSE_ENGINE.payloadHash in the same commit.",
].join("\n");

/**
 * THE ANSWERING-MACHINE POLICY, AS A PROVIDER SETTING (E-12A).
 *
 * ── WHY THIS IS NOT IN THE PROMPT ───────────────────────────────────
 * "Leave no message" was already written into the general_prompt, and until now
 * that was the ONLY thing carrying it. A prompt is an instruction to a model:
 * it is advisory, it competes with everything else in the context, and on the
 * one call where it loses we have recorded a sales pitch onto a stranger's
 * answering machine and spent a counted attempt (A-L7) doing it. Retell will
 * end the call itself, without asking the model, so the failure mode stops
 * being possible rather than becoming unlikely.
 *
 * ── WHY IT IS A CONSTANT AND NOT READ FROM `config` ─────────────────
 * Every other field here falls back to a caller-supplied value. This one does
 * not, and that asymmetry is the point: a caller able to supply the action
 * could supply a static-text one, turning the founder's "leave no message" into
 * a message from outside the file where the policy is written and reviewed.
 * Changing it has to be an edit to this line.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────
 * Retell's other actions — static_text, prompt-generated, callback — all
 * deliver something. None is configured, and there is no `text` key to fill in
 * by accident. Enabling one is a separate founder decision, per VOICEMAIL_POLICY.
 */
const ACQUISITION_VOICEMAIL_OPTION = Object.freeze({
  action: Object.freeze({ type: "hangup" }),
});

/**
 * The agent. It REFERENCES the engine and never contains it.
 *
 * @param {string|null} llmId  the id returned by createResponseEngine. Until a
 *                             real one is supplied this stays null and the
 *                             resource is NOT provisionable — see `readiness`.
 */
function buildAcquisitionAgent({ config = {}, llmId = null } = {}) {
  return Object.freeze({
    agent_name: `${ACQUISITION_RESOURCE_PREFIX}-agent-${SPEC_VERSION}`,
    response_engine: Object.freeze({ type: config.responseEngineType || "retell-llm", llm_id: llmId || null }),
    voice_id: config.voiceId || null,
    language: config.language || "en-AU",
    // Never the receptionist's or onboarding's webhook, never localhost, never
    // a placeholder. Null until the acquisition route exists.
    webhook_url: config.acquisitionWebhookUrl || null,
    voicemail_option: ACQUISITION_VOICEMAIL_OPTION,
    post_call_analysis_data: buildAcquisitionAnalysisFields(),
  });
}

const isRealId = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * The canonical hash of a response-engine payload, in the repository's existing
 * form. Defaults to the current local payload.
 *
 * `voice-platform-port` is required lazily so this module keeps its property of
 * importing nothing that knows what a network is — the port carries the
 * disabled adapter, and E-10C's ratchets assert the spec stays inert.
 */
function responseEnginePayloadHash(payload = buildAcquisitionResponseEngine()) {
  const { payloadHash } = require("./voice-platform-port");
  return payloadHash(payload);
}

/**
 * Has the local response-engine payload drifted from the provisioned one?
 *
 * Returns the finding rather than throwing, so a caller can decide whether it is
 * a build failure or a line in a report. The ratchet throws; a status page would
 * not want to.
 */
function describeResponseEngineDrift(payload = buildAcquisitionResponseEngine()) {
  const actual = responseEnginePayloadHash(payload);
  const expected = PROVISIONED_RESPONSE_ENGINE.payloadHash;
  return Object.freeze({
    drifted: actual !== expected,
    expected,
    actual,
    provisionedAt: PROVISIONED_RESPONSE_ENGINE.provisionedAt,
    message: actual === expected ? null : RESPONSE_ENGINE_DRIFT_MESSAGE,
  });
}

/**
 * BOTH resources, their dependency, and an honest account of what is not ready.
 *
 * Readiness is not "the JSON parses". Every unresolved item below is a real
 * decision or a real provider behaviour nobody has verified, and each one is
 * reported by name rather than averaged into a single optimistic boolean.
 */
function describeAcquisitionRetellResources({ identity = DEFAULT_IDENTITY, pricing = null, config = {}, llmId = null } = {}) {
  const responseEngine = buildAcquisitionResponseEngine({ identity, pricing });
  const agent = buildAcquisitionAgent({ config, llmId });

  const engineReady = {
    promptReady: responseEngine.general_prompt.length > 500,
    openingReady: describeOpeningSemantics(responseEngine.begin_message, identity).ok,
    networkIdPresent: false,
    provisioned: false,
  };

  const agentReady = {
    identityReady: true,
    languageReady: agent.language === "en-AU",
    analysisReady: agent.post_call_analysis_data.length > 0,
    voiceResolved: isRealId(agent.voice_id),
    llmIdResolved: isRealId(agent.response_engine.llm_id),
    webhookResolved: isRealId(agent.webhook_url),
    // ── CONFIGURED AND OBSERVED ARE TWO DIFFERENT FACTS (E-12A) ──────
    // Until E-12A there was ONE flag here, `voicemailProviderBehaviourVerified`,
    // and it was a permanent false in the create-agent blocker list. That made
    // it unsatisfiable by construction: provider behaviour on an answering
    // machine cannot be observed until an agent exists and has been telephoned,
    // and the agent could not be created until the behaviour was observed. A
    // gate nobody can ever open is not a safety property, it is a gate people
    // eventually delete.
    //
    // So it is split. What can be settled before creation — is the hang-up
    // policy actually in the payload — is COMPUTED from the payload and gates
    // creation. What genuinely cannot — has a real answering machine hung up on
    // a real call — is reported by name below and does NOT gate creation,
    // because creating the agent is a prerequisite for answering it.
    voicemailProviderPolicyConfigured:
      agent.voicemail_option != null &&
      agent.voicemail_option.action != null &&
      agent.voicemail_option.action.type === "hangup",
    // Never been observed. This is not paperwork: detection is probabilistic,
    // and nobody here has watched it fire.
    voicemailProviderBehaviourObserved: false,
    provisioned: false,
  };

  const blockers = [
    engineReady.promptReady ? null : "the response engine has no usable prompt",
    engineReady.openingReady ? null : "the opening does not carry its required meaning",
    agentReady.llmIdResolved ? null : "no acquisition response-engine id has been supplied (create the engine first)",
    agentReady.voiceResolved
      ? null
      : `voice_id is unresolved — set ${SELECTED_VOICE.envVar} (the founder has chosen ${SELECTED_VOICE.voiceName})`,
    agentReady.webhookResolved ? null : "webhook_url is unresolved — the acquisition route is not exposed",
    agentReady.voicemailProviderPolicyConfigured
      ? null
      : "the agent payload does not configure a provider hang-up on detected voicemail",
  ].filter(Boolean);

  // Things that stay open AFTER the agent exists. Kept as a named list rather
  // than folded into `blockers`, so that moving voicemail observation out of the
  // create gate does not quietly delete the fact that nobody has seen it work.
  const unverifiedAfterCreation = [
    agentReady.voicemailProviderBehaviourObserved
      ? null
      : "hang-up on a detected answering machine is configured but has never been observed on a real call",
  ].filter(Boolean);

  return Object.freeze({
    order: ACQUISITION_RESOURCE_ORDER,
    responseEngine,
    agent,
    dependencies: Object.freeze([
      Object.freeze({
        from: "response_engine",
        to: "voice_agent",
        field: "response_engine.llm_id",
        satisfied: agentReady.llmIdResolved,
        note: "The agent may not be created until createResponseEngine has returned an id for THIS acquisition engine.",
      }),
    ]),
    readiness: Object.freeze({
      responseEngine: Object.freeze(engineReady),
      agent: Object.freeze(agentReady),
      // COMPUTED, not asserted. A hardcoded `false` would be honest today and
      // a lie the moment somebody resolved the blockers, and a readiness flag
      // that cannot ever say yes is one people learn to ignore.
      createAgentReady: blockers.length === 0,
      blockers: Object.freeze(blockers),
      unverifiedAfterCreation: Object.freeze(unverifiedAfterCreation),
      note:
        "NOT CREATE-AGENT READY. Nothing here has been sent to any provider; no acquisition response engine " +
        "and no acquisition agent exists.",
    }),
  });
}

module.exports = {
  ACQUISITION_AGENT_SPEC,
  SPEC_VERSION,
  DEFAULT_IDENTITY,
  PERMITTED_CLAIMS,
  FORBIDDEN_CLAIMS,
  PRICE_RULE,
  BEHAVIOURS,
  VOICEMAIL_POLICY,
  CONVERSATION_STYLE,
  CONVERSATION_GOALS,
  FIRST_VALUE_QUESTION,
  END_CALL_TRIGGERS,
  buildAcquisitionOpening,
  describeOpeningSemantics,
  buildAcquisitionAgentPrompt,
  buildAcquisitionAnalysisFields,
  // E-10C: two resources. The old `describeAcquisitionAgentPayload` is gone
  // rather than aliased — its name promised one agent payload while the truth
  // is two unrelated API resources with a dependency between them, and a
  // misleading name is worse than a rename.
  buildAcquisitionResponseEngine,
  buildAcquisitionAgent,
  ACQUISITION_VOICEMAIL_OPTION,
  SELECTED_VOICE,
  PROVISIONED_RESPONSE_ENGINE,
  RESPONSE_ENGINE_DRIFT_MESSAGE,
  responseEnginePayloadHash,
  describeResponseEngineDrift,
  describeAcquisitionRetellResources,
  ACQUISITION_RESOURCE_ORDER,
  ACQUISITION_RESOURCE_PREFIX,
};
