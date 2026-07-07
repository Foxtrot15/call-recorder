const axios = require("axios");
const { buildAnalysisPrompt, MODES } = require("./prompts");

// Structured extraction ONLY — prompt text lives in services/prompts.js
// (single-responsibility builders with grounding rules; see
// docs/LLM_PROMPT_CONTAMINATION_INVESTIGATION.md). `mode` distinguishes a
// voicemail (v1's normal case — no conversation happened) from an answered
// two-way call, so the summary can never describe a discussion that didn't
// occur.
async function analyseCall(transcript, contactContext = null, businessProfile = null, mode = MODES.VOICEMAIL) {
  const { system, user } = buildAnalysisPrompt({ transcript, contactContext, businessProfile, mode });

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: user }],
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
