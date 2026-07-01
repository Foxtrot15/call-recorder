const axios = require("axios");

async function analyseCall(transcript, contactContext = null, businessProfile = null) {
  const contextSection = contactContext
    ? `\n\nCONTACT HISTORY:\n${contactContext}\n\nUse this history to provide richer analysis. Note if this is a returning contact and reference previous interactions in the summary.`
    : "";

  // Scheduling fields are ALWAYS required
  const schedulingFields = `REQUIRED scheduling fields (always extract if mentioned):
  - "appointment_date": any specific date for a visit, meeting, or consultation (e.g. "Friday", "July 14")
  - "appointment_time": any specific time (e.g. "2pm", "9am")
  - "job_start_date": date when a job/project starts (e.g. "July 14", "Monday the 14th")
  - "job_duration_days": number of days a job takes (e.g. "5", "7")`;

  let factsInstruction;
  if (businessProfile?.extraction_fields?.length) {
    const fields = businessProfile.extraction_fields
      .map(f => `  - "${f.key}" (${f.label}): ${f.description}. Example: "${f.example}"`)
      .join("\n");
    factsInstruction = `- facts: ${schedulingFields}\nAlso extract these business-specific facts if mentioned:\n${fields}`;
  } else {
    factsInstruction = `- facts: ${schedulingFields}\nAlso extract any other relevant business facts (property, budget, job type, urgency etc). Use snake_case keys.`;
  }

  const businessContext = businessProfile
    ? `\n\nBUSINESS TYPE: ${businessProfile.business_type} (${businessProfile.industry})\n${businessProfile.profile_summary}`
    : "";

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: `You are analysing transcripts of calls received by a small business.${businessContext}
Extract structured information and respond ONLY with a valid JSON object — no preamble, no markdown, no backticks.

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
- intent: one of schedule_meeting, quote_request, referral, general_enquiry, complaint, wrong_number, follow_up, other
- summary: 1-2 sentences, plain English. If returning contact, reference previous interactions.
- action: the single most important next step, or null
- suggested_actions: 2-3 short action labels e.g. ["Send quote", "Book callback", "Schedule meeting"] — max 5 words each
- follow_up.type: use "meeting" whenever a specific appointment, site visit, consultation, or callback time was agreed on in the call
- follow_up.detail: include the specific date/time/location agreed if mentioned
- email_confidence: "low" if email was spelled out phonetically or uncertain
${factsInstruction}${contextSection}`,

      messages: [
        {
          role: "user",
          content: `Analyse this call transcript:\n\n${transcript}`,
        },
      ],
    },
    {
      headers: {
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
      },
    }
  );

  const text = response.data?.content?.[0]?.text || "";

  try {
    return JSON.parse(text);
  } catch {
    const clean = text.replace(/```json|```/g, "").trim();
    try {
      return JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("Could not parse Claude response as JSON");
    }
  }
}

module.exports = analyseCall;
