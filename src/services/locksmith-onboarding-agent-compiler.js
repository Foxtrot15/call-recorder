// AIDA — onboarding-agent compiler (M3).
//
// Compiles the VERSIONED interview specification from M2
// (services/locksmith-interview-spec.js) into an agent that can run the
// onboarding call. Separate from the receptionist compiler on purpose: this
// agent talks to the BUSINESS OWNER about configuration, the other talks to
// their CUSTOMERS about lockouts. They share no prompt, no tools and no
// failure modes.
//
// Two rules shape everything here:
//
//   1. CONSENT IS A GATE, NOT A FORMALITY. The agent discloses that it is
//      automated and that the call is transcribed, then asks. If consent is
//      not given it thanks them and ends — it does not persuade, and it does
//      not quietly continue collecting answers.
//
//   2. SILENCE IS NEVER AN ANSWER. Every safety-critical value is read back and
//      confirmed in the call. Anything the owner does not know is recorded as
//      not-established, never guessed. That is the same contract the extraction
//      adapter follows, enforced one layer earlier.
//
// Deterministic and testable without Retell: compileOnboardingAgent() returns a
// neutral spec plus hashes, and toRetellPayload() translates.

const crypto = require("crypto");
const spec = require("./locksmith-interview-spec");
const S = require("./locksmith-profile-schema");
const { stableStringify } = require("./voice-platform-port");
const { buildOnboardingAnalysisFields } = require("./locksmith-analysis-schema");

const COMPILER_VERSION = "locksmith-onboarding-agent-compiler-2026-08-01";

// The values that must be read back digit-by-digit or word-for-word before the
// call can be considered complete. Mirrors the brief's critical read-back list.
const CRITICAL_READBACKS = Object.freeze([
  { key: "identity.spokenName", label: "the name callers will hear" },
  { key: "servicesDeclined", label: "the work you do not take" },
  { key: "serviceAreas", label: "where you will and will not travel" },
  { key: "hours", label: "your ordinary hours and after-hours position" },
  { key: "transfer.primaryNumber", label: "the number urgent calls go to", digitByDigit: true },
  { key: "transfer.backupNumber", label: "the backup number", digitByDigit: true },
  { key: "urgencyRules", label: "what counts as urgent" },
  { key: "pricing", label: "whether I may discuss price" },
  { key: "forbiddenPromises", label: "the things I will never say" },
  { key: "privacy.callsMayBeRecorded", label: "your recording preference" },
]);

const ONBOARDING_DYNAMIC_VARIABLES = Object.freeze([
  "client_id",
  "session_id",
  "contact_first_name",
  "business_name_hint",
  "interview_spec_version",
  "disclosure_version",
]);

/** Non-negotiable behaviour for the onboarding agent. */
function buildCoreInstructions() {
  return Object.freeze([
    "You are AIDA, an automated assistant. Say so in the first few seconds. If the owner asks whether you are a person, say plainly that you are not.",
    "Your job on this call is to learn how this locksmith business runs so their AI receptionist can be set up correctly. You are not taking a job and you are not selling anything.",
    "Tell them the call is being transcribed so their answers can be written up, and that they will review everything before it goes live.",
    "Ask for their agreement to continue before you ask anything else. If they say no, or seem unsure and do not agree, thank them, tell them nothing has been recorded against their account, and end the call. Do not try to persuade them.",
    "Have a conversation, not an interrogation. Follow what they say, group related questions, and skip what they have already told you. Do not read a list of fields aloud.",
    "Never guess. If they do not know an answer, say that is fine, record it as not decided, and tell them it will show up for them to fill in later.",
    "If something they say now contradicts something they said earlier, say so plainly, repeat both versions, and ask which is right. Never quietly keep the most recent answer.",
    "Read back every safety-critical value and get a yes before moving on. Phone numbers go digit by digit.",
    "Do not offer advice about pricing, licensing, insurance or the law. You are collecting their settings, not consulting.",
    "At the end, summarise the important points out loud, then tell them it will be sent to them to check and that nothing answers their phone until they approve it.",
    "If they ask to speak to a person, or ask to stop, stop straight away and tell them someone will follow up.",
  ]);
}

/**
 * Question groups come from the M2 interview specification verbatim — this
 * compiler does not invent questions, it arranges the reviewed ones.
 */
function buildQuestionGroups() {
  return spec.QUESTION_GROUPS.map((group) =>
    Object.freeze({
      id: group.id,
      title: group.title,
      intent: group.intent,
      questions: Object.freeze([...group.questions]),
      mustEstablish: Object.freeze([...(group.mustEstablish || [])]),
      conditionalFollowUps: Object.freeze([...(group.conditionalFollowUps || [])]),
      readBack: group.readBack === true,
      safetyCritical: group.safetyCritical === true,
      note: group.note || null,
    })
  );
}

/**
 * Conditional transitions: when to branch, expressed neutrally so a
 * conversation-flow provider could consume them later.
 */
function buildConditionalTransitions() {
  return Object.freeze([
    { from: "opening", when: "consent_not_given", to: "end_call", action: "Thank them and end. Record consent_provided = false." },
    { from: "opening", when: "consent_given", to: "identity" },
    { from: "services_accepted", when: "automotive accepted", to: "services_accepted", action: "Ask whether make, model and year are needed before attending." },
    { from: "services_accepted", when: "commercial accepted", to: "services_accepted", action: "Ask whether commercial jobs use a different after-hours contact." },
    { from: "after_hours", when: "after_hours_declined", to: "urgency", action: "Skip the middle-of-the-night questions; confirm business-hours-only handling." },
    { from: "transfer", when: "number_not_confirmed", to: "transfer", action: "Read the number back again. Do not proceed until confirmed or explicitly deferred." },
    { from: "pricing", when: "owner_unsure", to: "caller_info", action: "Record the safe default: no price given, locksmith confirms. Say that is what you have written down." },
    { from: "any", when: "owner_asks_for_human", to: "end_call", action: "Stop the interview, confirm someone will follow up." },
    { from: "any", when: "contradiction_detected", to: "same_group", action: "Quote both answers, ask which is right, record the resolution." },
    { from: "read_back", when: "all_confirmed", to: "end_call", action: "Close with the approval explanation." },
  ]);
}

function buildCompletionCriteria() {
  return Object.freeze({
    rule: spec.COMPLETION_CRITERIA.rule,
    neverComplete: Object.freeze([...spec.COMPLETION_CRITERIA.neverComplete]),
    closing: spec.COMPLETION_CRITERIA.closing,
    requiredReadBacks: CRITICAL_READBACKS.map((r) => r.key),
  });
}

/**
 * Compile. `disclosureVersion` is supplied by the caller (M4 owns the consent
 * wording), so the agent and the consent record always agree on which
 * disclosure the owner heard.
 */
function compileOnboardingAgent({ clientId, sessionId, templateVersion, disclosureVersion, config = {}, generatedAt = null }) {
  if (!templateVersion) return { ok: false, code: "missing_template_version", message: "A template version is required." };

  const openingMessage = [
    spec.OPENING.disclosure,
    spec.OPENING.purpose,
    spec.OPENING.reassurance,
    "Is it alright to go ahead?",
  ].join(" ");

  const compiled = {
    compilerVersion: COMPILER_VERSION,
    templateVersion,
    interviewSpecVersion: spec.INTERVIEW_SPEC_VERSION,
    disclosureVersion: disclosureVersion || null,
    clientId: clientId || null,
    sessionId: sessionId || null,

    openingMessage,
    coreInstructions: buildCoreInstructions(),
    questionGroups: buildQuestionGroups(),
    conditionalTransitions: buildConditionalTransitions(),
    criticalReadBacks: CRITICAL_READBACKS,
    neverInfer: Object.freeze([...spec.HANDLING.neverInfer]),
    handling: Object.freeze({
      uncertainty: spec.HANDLING.uncertainty,
      contradiction: spec.HANDLING.contradiction,
      ownerDoesNotKnow: spec.HANDLING.ownerDoesNotKnow,
    }),
    completionCriteria: buildCompletionCriteria(),

    // Only opaque identifiers and the owner's own first name. No business
    // configuration is injected — this agent is here to LEARN it.
    dynamicVariables: Object.freeze(
      ONBOARDING_DYNAMIC_VARIABLES.reduce((acc, key) => {
        acc[key] =
          key === "client_id" ? String(clientId || "")
            : key === "session_id" ? String(sessionId || "")
              : key === "interview_spec_version" ? spec.INTERVIEW_SPEC_VERSION
                : key === "disclosure_version" ? String(disclosureVersion || "")
                  : "{{runtime}}";
        return acc;
      }, {})
    ),

    analysisSchema: buildOnboardingAnalysisFields(),

    // The three outcomes the call must be able to report, independent of the
    // transcript. These are what the session machine reads.
    outcomeContract: Object.freeze({
      consentResult: Object.freeze(["given", "refused", "unclear"]),
      missingDataResult: "an array of mustEstablish keys the owner did not answer",
      contradictionResult: "an array of { topic, firstAnswer, laterAnswer, resolution }",
    }),
  };

  const { ...hashable } = compiled;
  const specHash = crypto.createHash("sha256").update(stableStringify(hashable)).digest("hex");

  return {
    ok: true,
    spec: compiled,
    hashes: { specHash, analysisSchemaHash: crypto.createHash("sha256").update(stableStringify(compiled.analysisSchema)).digest("hex") },
    provenance: { compilerVersion: COMPILER_VERSION, templateVersion, interviewSpecVersion: spec.INTERVIEW_SPEC_VERSION, generatedAt },
  };
}

/** Translate to Retell's documented shapes. Pure mapping, no judgement. */
function toRetellPayload({ compiled, config }) {
  if (!compiled || !compiled.ok) throw new Error("toRetellPayload requires a successful compile");
  const s = compiled.spec;

  const prompt = [
    "# Who you are and what this call is for",
    ...s.coreInstructions.map((l) => `- ${l}`),
    "",
    "# You must never",
    ...s.neverInfer.map((l) => `- Assume: ${l}`),
    "",
    "# Handling uncertainty",
    `- ${s.handling.uncertainty}`,
    `- ${s.handling.contradiction}`,
    `- ${s.handling.ownerDoesNotKnow}`,
    "",
    "# What to cover",
    ...s.questionGroups.flatMap((g) => [
      `## ${g.title}${g.safetyCritical ? " (safety-critical — read back and confirm)" : ""}`,
      `Purpose: ${g.intent}`,
      ...g.questions.map((q) => `- ${q}`),
      g.note ? `Note: ${g.note}` : null,
      g.mustEstablish.length ? `Must establish or explicitly record as unknown: ${g.mustEstablish.join(", ")}` : null,
    ].filter(Boolean)),
    "",
    "# Read these back before finishing",
    ...s.criticalReadBacks.map((r) => `- ${r.label}${r.digitByDigit ? " (digit by digit)" : ""}`),
    "",
    "# Finishing",
    `- ${s.completionCriteria.rule}`,
    `- Close with: ${s.completionCriteria.closing}`,
  ].join("\n");

  return Object.freeze({
    responseEngine: Object.freeze({
      general_prompt: prompt,
      begin_message: s.openingMessage,
      default_dynamic_variables: s.dynamicVariables,
      general_tools: [],
    }),
    agent: Object.freeze({
      agent_name: `aida-onboarding-${s.clientId || "unassigned"}`,
      response_engine: { type: config.responseEngineType || "retell-llm", llm_id: null },
      voice_id: config.defaultVoiceId || null,
      language: config.defaultLanguage || "en-AU",
      webhook_url: config.webhookBaseUrl ? `${config.webhookBaseUrl}/webhooks/retell` : null,
      post_call_analysis_data: s.analysisSchema,
    }),
  });
}

module.exports = {
  COMPILER_VERSION,
  CRITICAL_READBACKS,
  ONBOARDING_DYNAMIC_VARIABLES,
  buildCoreInstructions,
  buildQuestionGroups,
  buildConditionalTransitions,
  buildCompletionCriteria,
  compileOnboardingAgent,
  toRetellPayload,
};
