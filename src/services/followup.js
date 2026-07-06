// Follow-up automation: email draft + calendar event, from ONE implementation.
//
// Replaces the previously-duplicated (and drifted) drafting blocks in
// routes/recording.js and routes/test.js (backlog P2-2). Pipeline:
//
//   canDraftEmail gate → mode-aware prompt (prompts.js) → Claude →
//   draft-guard grounding validation → pass: LLM draft / fail: safe fallback
//
// The guard failing is NOT an error: it means the model fabricated despite
// instructions, we caught it, and the customer gets an honest template
// instead. It is logged loudly so contamination shows up in Railway logs.

const axios = require("axios");
const { createDraft } = require("./gmail");
const { createEvent } = require("./gcal");
const prompts = require("./prompts");
const { validateDraft } = require("./draft-guard");

async function callClaude({ system, user, maxTokens = 400 }) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );
  return response.data?.content?.[0]?.text?.trim() || "";
}

/**
 * Draft (and create in Gmail) a grounded follow-up email.
 * Returns { created, guarded } — guarded=true means the LLM draft was
 * rejected by the grounding guard and the safe fallback was used.
 */
async function draftFollowUpEmail(clientId, { mode, transcript, analysis, isReturning }) {
  const callerName = analysis?.caller?.name || null;
  const callerEmail = analysis?.caller?.email || null;

  if (!prompts.canDraftEmail({ transcript, callerEmail })) {
    return { created: false, guarded: false, reason: !callerEmail ? "no email" : "transcript too short to ground a draft" };
  }

  const firstName = (callerName || "there").split(" ")[0];
  const subMode = prompts.deriveSubMode(analysis);

  let body = null;
  let guarded = false;
  try {
    const p = prompts.buildEmailDraftPrompt({ mode, subMode, firstName, transcript, analysis, isReturning });
    const llmDraft = await callClaude({ system: p.system, user: p.user });

    const verdict = validateDraft(llmDraft, {
      transcript,
      analysis,
      allowlist: [firstName, callerName || ""],
    });

    if (llmDraft && verdict.ok) {
      body = llmDraft;
    } else {
      guarded = true;
      console.error(
        `🛡️  Draft guard rejected LLM draft (mode=${mode}): ungrounded ` +
        `entities=${JSON.stringify(verdict.ungroundedEntities)} temporals=${JSON.stringify(verdict.ungroundedTemporals)} — using safe fallback`
      );
    }
  } catch (err) {
    console.error("⚠️  Email drafting LLM call failed — using safe fallback:", err.message);
  }

  if (!body) body = prompts.buildFallbackEmailBody({ mode, firstName });

  const subject = prompts.buildEmailSubject({ mode, firstName, callerName, isReturning });
  await createDraft(clientId, { to: callerEmail, subject, body });
  return { created: true, guarded };
}

/**
 * Create a calendar event only when the analysis carries a CONCRETE,
 * transcript-extracted date (prompts.shouldCreateCalendarEvent — never
 * invent appointments).
 */
async function maybeCreateCalendarEvent(clientId, { analysis, fromNumber }) {
  if (!prompts.shouldCreateCalendarEvent(analysis)) return { created: false };

  const callerName = analysis.caller?.name || fromNumber;
  const callerEmail = analysis.caller?.email || null;
  const summary = analysis.summary || "Call received";
  const eventDetail = analysis.follow_up?.detail || analysis.action || summary;
  const desc =
    summary + "\n\nContact: " + fromNumber + (callerEmail ? " | " + callerEmail : "") + "\n\n" + eventDetail;

  await createEvent(clientId, {
    title: callerName + (analysis.facts?.job_start_date ? " — Job" : " — Appointment"),
    description: desc,
    attendeeEmail: callerEmail,
    facts: analysis.facts || {},
  });
  return { created: true };
}

module.exports = { draftFollowUpEmail, maybeCreateCalendarEvent };
