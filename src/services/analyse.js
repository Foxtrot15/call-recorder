const axios = require("axios");

async function analyseCall(transcript) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: `You are analysing transcripts of calls received by a small business. 
Extract structured information and respond ONLY with a valid JSON object — no preamble, no markdown, no backticks.

Return this exact shape:
{
  "caller": {
    "name":    string | null,
    "company": string | null,
    "email":   string | null,
    "email_confidence": "high" | "low" | null,
    "phone":   string | null
  },
  "intent":   string,
  "summary":  string,
  "action":   string | null,
  "follow_up": {
    "type":    "email" | "call" | "meeting" | "none",
    "detail":  string | null
  }
}

Rules:
- intent: one of schedule_meeting, quote_request, referral, general_enquiry, complaint, wrong_number, other
- summary: one sentence, plain English, what the call was about
- action: the single most important next step, or null
- email_confidence: "low" if the email was spelled out phonetically, repeated with corrections, or sounds uncertain`,

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
    // Strip any accidental markdown fences and retry
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  }
}

module.exports = analyseCall;
