const axios = require("axios");

async function analyseCall(transcript, contactContext = null, businessProfile = null) {
  const contextSection = contactContext
    ? `\n\nCONTACT HISTORY:\n${contactContext}\n\nUse this history to provide richer analysis. Note if this is a returning contact and reference previous interactions in the summary.`
    : "";

  // Build dynamic facts extraction based on business type
  let factsInstruction;
  if (businessProfile?.extraction_fields?.length) {
    const fields = businessProfile.extraction_fields
      .map(f => `  - "${f.key}" (${f.label}): ${f.description}. Example: "${f.example}"`)
      .join("\n");
    factsInstruction = `- facts: extract these business-specific facts if mentioned (omit if not mentioned):\n${fields}`;
  } else {
    factsInstruction = `- facts: extract any specific business facts mentioned (property, budget, timeline, job type, location etc). Use snake_case keys.`;
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
  "intent":    string,
  "summary":   string,
  "action":    string | null,
  "facts":     object,
  "follow_up": {
    "type":   "email" | "call" | "meeting" | "none",
    "detail": string | null
  }
}

Rules:
- intent: one of schedule_meeting, quote_request, referral, general_enquiry, complaint, wrong_number, follow_up, other
- summary: 1-2 sentences, plain English. If returning contact, reference previous interactions.
- action: the single most important next step, or null
- email_confidence: "low" if email was spelled out phonetically, repeated with corrections, or uncertain
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
    return JSON.parse(clean);
  }
}

module.exports = analyseCall;
