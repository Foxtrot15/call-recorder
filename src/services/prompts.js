// Single-responsibility prompt builders for every LLM call in the pipeline.
//
// Design rules (docs/LLM_PROMPT_CONTAMINATION_INVESTIGATION.md §5):
//   1. One builder per responsibility — analysis extraction, business profile,
//      rolling summary, email drafting, calendar gating. No builder does two.
//   2. GROUNDING: generation prompts carry the transcript verbatim and an
//      explicit evidence rule — every factual statement must be supported by
//      the transcript; unknown stays unknown.
//   3. MODES: a voicemail is not a conversation. Every downstream consumer
//      must know which it was, and the email drafter behaves differently for
//      voicemail / answered / callback-request / appointment-booking.
//   4. Cached LLM outputs (business profile, contact summaries) are labelled
//      as BACKGROUND in prompts and explicitly barred from being treated as
//      facts about THIS call.
//
// Pure module: no network, no DB, no env. Fully unit-tested without mocks
// (test/prompts.test.js).

// ── Call modes ───────────────────────────────────────────────────────────────
// v1 reality: everything arriving via /inbound is a voicemail (the caller
// spoke to a machine; the owner never talked to them). Only the operator
// bridge (/call, direction "outbound") is an answered two-way conversation.
const MODES = Object.freeze({ VOICEMAIL: "voicemail", ANSWERED: "answered" });

function deriveCallMode({ direction }) {
  return direction === "outbound" ? MODES.ANSWERED : MODES.VOICEMAIL;
}

// Sub-modes refine the email's purpose; they come from transcript-grounded
// analysis fields, never from guesses here.
function deriveSubMode(analysis) {
  const facts = analysis?.facts || {};
  const hasConcreteAppointment = Boolean(
    facts.appointment_date || facts.job_start_date || facts.meeting_date || facts.visit_date
  );
  if (hasConcreteAppointment) return "appointment_booking";
  if (analysis?.follow_up?.type === "call") return "callback_request";
  return null;
}

// ── Gate: is there anything to draft from? ──────────────────────────────────
// An empty or near-empty transcript is not evidence — drafting from it can
// only produce fabrication, so we refuse (caller falls back to no draft).
const MIN_TRANSCRIPT_CHARS = 40;

function canDraftEmail({ transcript, callerEmail }) {
  if (!callerEmail) return false;
  if (!transcript || transcript.trim().length < MIN_TRANSCRIPT_CHARS) return false;
  return true;
}

// ── Shared grounding rules (embedded into generation prompts) ────────────────
const GROUNDING_RULES = `EVIDENCE RULES (absolute — violating any of these makes the output unusable):
- Every factual statement MUST be supported by the transcript below. If it is not in the transcript, it does not go in the output.
- NEVER invent meetings, appointments, dates or times.
- NEVER invent products, services, prices or quotes.
- NEVER invent business names or company names.
- NEVER invent people or refer to anyone not named in the transcript.
- Unknown information stays unknown — write around gaps, do not fill them.
- BACKGROUND sections (if present) describe general context. They are NOT part of this call and must never be cited as something said or agreed in this call.`;

// ── A. Call analysis / structured extraction ─────────────────────────────────
function buildAnalysisPrompt({ transcript, contactContext = null, businessProfile = null, mode = MODES.VOICEMAIL }) {
  const modeLine =
    mode === MODES.ANSWERED
      ? "This is a transcript of an ANSWERED two-way phone conversation."
      : "This is a transcript of a VOICEMAIL. The caller spoke to a recording — the business owner did NOT speak with them, and nothing can have been 'agreed' or 'discussed'.";

  const businessContext = businessProfile
    ? `\n\nBACKGROUND — the business receiving this call (general context only, NOT part of this call):\nType: ${businessProfile.business_type} (${businessProfile.industry})\n${businessProfile.profile_summary}`
    : "";

  const contextSection = contactContext
    ? `\n\nBACKGROUND — prior contact history (context only, NOT part of this call):\n${contactContext}`
    : "";

  const schedulingFields = `REQUIRED scheduling fields (extract ONLY if explicitly stated in the transcript; otherwise omit):
  - "appointment_date": a specific date the CALLER stated for a visit/meeting/consultation
  - "appointment_time": a specific time the CALLER stated
  - "job_start_date": a start date the CALLER stated
  - "job_duration_days": a duration the CALLER stated`;

  let factsInstruction;
  if (businessProfile?.extraction_fields?.length) {
    const fields = businessProfile.extraction_fields
      .map((f) => `  - "${f.key}" (${f.label}): ${f.description}`)
      .join("\n");
    factsInstruction = `- facts: ${schedulingFields}\nAlso extract these business-specific facts IF AND ONLY IF the transcript mentions them (field names below are schema hints, not content — never copy example values into output):\n${fields}`;
  } else {
    factsInstruction = `- facts: ${schedulingFields}\nAlso extract other business facts the transcript explicitly mentions (property, budget, job type, urgency etc). Use snake_case keys. Omit anything not stated.`;
  }

  const system = `You are extracting structured information from a call received by a small business.
${modeLine}
${GROUNDING_RULES}${businessContext}

Respond ONLY with a valid JSON object — no preamble, no markdown, no backticks.

Return this exact shape:
{
  "caller": {
    "name":             string | null,
    "company":          string | null,
    "email":            string | null,
    "email_confidence": "high" | "low" | null,
    "phone":            string | null
  },
  "intent":             string,
  "summary":            string,
  "action":             string | null,
  "suggested_actions":  [string],
  "facts":              object,
  "follow_up": {
    "type":   "email" | "call" | "meeting" | "none",
    "detail": string | null
  }
}

Rules:
- caller fields: null unless the caller states them in the transcript.
- intent: one of schedule_meeting, quote_request, referral, general_enquiry, complaint, wrong_number, follow_up, other
- summary: 1-2 sentences, plain English, describing only what the transcript contains.${mode === MODES.VOICEMAIL ? ' Describe it as a message left by the caller ("called asking about…"), never as a discussion.' : ""}
- action: the single most important next step, or null
- suggested_actions: 2-3 short action labels, max 5 words each
- follow_up.type: "meeting" ONLY when the transcript contains a specific appointment/site-visit/consultation; "call" when the caller asks to be called back
- follow_up.detail: the specific date/time/location AS STATED in the transcript, or null
- email_confidence: "low" if the email was spelled out phonetically or uncertain
${factsInstruction}${contextSection}`;

  const user = `Extract structured information from this ${mode === MODES.ANSWERED ? "call" : "voicemail"} transcript:\n\n${transcript}`;
  return { system, user };
}

// ── B. Business profile generation ───────────────────────────────────────────
function buildBusinessProfilePrompt({ transcriptSamples, mode = MODES.VOICEMAIL }) {
  const system = `You are analysing call transcripts to build a profile of the business that RECEIVED these calls.
${mode === MODES.VOICEMAIL ? "These are VOICEMAILS: usually only the CALLER speaks. Infer the business from what callers ask for — callers' own companies are NOT the business being profiled." : "These may include two-way conversations; the business side is the party answering."}
Base every field ONLY on what the transcripts support. If the transcripts are insufficient to identify the industry, use "unknown" rather than guessing.
Respond ONLY with valid JSON, no markdown, no preamble.

Return this shape:
{
  "industry": string,
  "business_type": string,
  "profile_summary": string,
  "common_intents": [string],
  "extraction_fields": [
    { "key": string, "label": string, "description": string, "example": string }
  ]
}

Rules:
- industry: e.g. "real_estate", "trades", "legal", "finance", "health", or "unknown"
- business_type: specific, e.g. "buyers_advocate", "plumber", "conveyancer", or "unknown"
- profile_summary: 2-3 sentences describing what this business does and what callers typically want — grounded in these transcripts only
- common_intents: the most common reasons people call, per these transcripts
- extraction_fields: 5-8 business-specific facts worth extracting from every call. snake_case keys. Examples must be generic placeholders, never real names/companies from the transcripts.`;

  const user = `Build a business profile from these call transcripts:\n\n${transcriptSamples}`;
  return { system, user };
}

// ── C. Rolling contact summary ───────────────────────────────────────────────
function buildRollingSummaryPrompt({ existingSummary, recentCalls, latestSummary, knownFacts }) {
  const system = `You are maintaining a concise contact-history summary for a business CRM.
Respond with ONLY a 2-3 sentence plain-text summary. No JSON, no markdown.
Summarise only what the inputs below state: who this person is, what they want, where they are in the journey, key facts. Do not add anything the inputs do not contain; drop anything that looks like test or demo data.`;

  const user = `Update this contact summary from their call history.

EXISTING SUMMARY:
${existingSummary || "No previous summary."}

RECENT CALLS:
${recentCalls}

LATEST CALL SUMMARY:
${latestSummary || ""}

KEY FACTS KNOWN:
${JSON.stringify(knownFacts || {})}

Write the updated 2-3 sentence summary.`;
  return { system, user };
}

// ── D. Email drafting (mode-aware) ───────────────────────────────────────────
function buildEmailDraftPrompt({ mode, subMode = null, firstName, transcript, analysis, isReturning = false }) {
  const modeBlocks = {
    [MODES.VOICEMAIL]: `SITUATION: The caller left a VOICEMAIL. You did NOT speak with them. There was no conversation, so nothing was discussed, agreed, or quoted.
- Open by acknowledging their message (e.g. "Thanks for your message" / "Sorry I missed your call").
- NEVER write as if a conversation happened. Forbidden phrasings include: "great speaking with you", "as discussed", "as we agreed", "following our conversation".
- Respond to what their message asked, and say what happens next.`,
    [MODES.ANSWERED]: `SITUATION: You spoke with this person on the phone. You may refer to the conversation — but only to things the transcript actually contains.`,
  };

  const subModeBlocks = {
    callback_request: `\nThe caller asked to be called back. Confirm you will call them, and only mention a time if the transcript states one.`,
    appointment_booking: `\nThe transcript contains a specific appointment. Confirm exactly the date/time stated in the transcript — do not adjust, infer, or embellish it.`,
  };

  const system = `You are writing a follow-up email on behalf of a small business owner.
${modeBlocks[mode] || modeBlocks[MODES.VOICEMAIL]}${subMode && subModeBlocks[subMode] ? subModeBlocks[subMode] : ""}

${GROUNDING_RULES}

Style:
- Address them by first name; write in first person as the business owner.
- SHORT: 3-5 sentences. Warm sign-off. No subject line — body only.
- Do not summarise the ${mode === MODES.ANSWERED ? "call" : "message"} back at them in third person.
- If the transcript gives you too little to say, keep the email to a simple acknowledgement and next step — that is success, not failure.`;

  const user = `TRANSCRIPT (your only source of facts about this ${mode === MODES.ANSWERED ? "call" : "voicemail"}):
---
${transcript}
---

Structured notes (derived from the transcript; if they conflict with the transcript, the transcript wins):
- Summary: ${analysis?.summary || "n/a"}
- Facts: ${JSON.stringify(analysis?.facts || {})}
- Next action: ${analysis?.action || "follow up"}${isReturning ? "\n- This is a returning contact." : ""}

Write the email to ${firstName}.`;
  return { system, user };
}

// Mode-appropriate subject — never implies a conversation for a voicemail.
function buildEmailSubject({ mode, firstName, callerName, isReturning }) {
  if (isReturning) return `Following up — ${callerName || firstName}`;
  return mode === MODES.ANSWERED
    ? `Great speaking with you today, ${firstName}`
    : `Thanks for your call, ${firstName}`;
}

// Non-fabricating fallback body used when the LLM draft is unavailable or
// rejected by the grounding guard. States only what is certainly true.
function buildFallbackEmailBody({ mode, firstName }) {
  return mode === MODES.ANSWERED
    ? `Hi ${firstName},\n\nThanks for your time on the phone today. I'll be in touch shortly with the next steps.\n\nKind regards`
    : `Hi ${firstName},\n\nThanks for your message — sorry I missed your call. I've got your details and I'll get back to you as soon as possible.\n\nKind regards`;
}

// ── E. Calendar gating (never invent appointments) ───────────────────────────
// An event is only justified by a CONCRETE date fact extracted from the
// transcript. Intent alone ("schedule_meeting") or follow_up.type alone is a
// desire for an appointment, not an appointment — drafting the email covers
// that; putting fiction in a calendar does not.
function shouldCreateCalendarEvent(analysis) {
  if (!analysis) return false;
  const facts = analysis.facts || {};
  const hasConcreteDate = Boolean(
    facts.appointment_date || facts.job_start_date || facts.meeting_date || facts.visit_date
  );
  const hasDetail = Boolean(analysis.follow_up?.detail || analysis.action);
  return hasConcreteDate && hasDetail;
}

module.exports = {
  MODES,
  MIN_TRANSCRIPT_CHARS,
  GROUNDING_RULES,
  deriveCallMode,
  deriveSubMode,
  canDraftEmail,
  buildAnalysisPrompt,
  buildBusinessProfilePrompt,
  buildRollingSummaryPrompt,
  buildEmailDraftPrompt,
  buildEmailSubject,
  buildFallbackEmailBody,
  shouldCreateCalendarEvent,
};
