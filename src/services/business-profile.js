
const axios = require("axios");
const supabase = require("./supabase");

const MIN_CALLS_TO_PROFILE = 3; // Generate profile after 3 calls

/**
 * Get the current business profile for a client.
 */
async function getBusinessProfile(clientId) {
  const { data } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("client_id", clientId)
    .single();
  return data || null;
}

/**
 * Check if we should generate/update the business profile.
 * Triggers after MIN_CALLS_TO_PROFILE calls and then every 20 calls after.
 */
async function shouldUpdateProfile(clientId) {
  const { count } = await supabase
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("status", "complete");

  const profile = await getBusinessProfile(clientId);

  if (!profile && count >= MIN_CALLS_TO_PROFILE) return true;
  if (profile && count >= profile.call_count_at_generation + 20) return true;
  return false;
}

/**
 * Generate a business profile from recent call transcripts.
 */
async function generateBusinessProfile(clientId) {
  console.log("🏢 Generating business profile...");

  // Fetch last 10 completed calls
  const { data: calls } = await supabase
    .from("calls")
    .select("transcript, summary, intent, analysis")
    .eq("status", "complete")
    .order("recorded_at", { ascending: false })
    .limit(10);

  if (!calls?.length) return null;

  const transcriptSamples = calls
    .filter(c => c.transcript)
    .slice(0, 5)
    .map((c, i) => `--- Call ${i + 1} ---\n${c.transcript}`)
    .join("\n\n");

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: `You are analysing call transcripts to build a business intelligence profile.
Respond ONLY with valid JSON, no markdown, no preamble.

Return this shape:
{
  "industry": string,
  "business_type": string,
  "profile_summary": string,
  "common_intents": [string],
  "extraction_fields": [
    {
      "key": string,
      "label": string,
      "description": string,
      "example": string
    }
  ]
}

Rules:
- industry: e.g. "real_estate", "trades", "legal", "finance", "health"
- business_type: specific type e.g. "buyers_advocate", "plumber", "conveyancer", "mortgage_broker"
- profile_summary: 2-3 sentences describing what this business does and what callers typically want
- common_intents: list of the most common reasons people call this business
- extraction_fields: 5-8 business-specific facts worth extracting from EVERY call for this business type. These should be fields that are commonly mentioned and useful for follow-up. Use snake_case keys.`,

      messages: [
        {
          role: "user",
          content: `Analyse these call transcripts and build a business profile:\n\n${transcriptSamples}`,
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
  let profile;
  try {
    profile = JSON.parse(text);
  } catch {
    const clean = text.replace(/```json|```/g, "").trim();
    profile = JSON.parse(clean);
  }

  // Get total call count
  const { count } = await supabase
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("status", "complete");

  // Store/update in Supabase
  const { data: existing } = await supabase
    .from("business_profiles")
    .select("id")
    .eq("client_id", clientId)
    .single();

  const payload = {
    client_id:                clientId,
    industry:                 profile.industry,
    business_type:            profile.business_type,
    profile_summary:          profile.profile_summary,
    common_intents:           profile.common_intents,
    extraction_fields:        profile.extraction_fields,
    call_count_at_generation: count || 0,
    updated_at:               new Date().toISOString(),
  };

  if (existing) {
    await supabase.from("business_profiles").update(payload).eq("id", existing.id);
  } else {
    await supabase.from("business_profiles").insert(payload);
  }

  console.log(`🏢 Business profile generated: ${profile.business_type} (${profile.industry})`);
  return profile;
}

/**
 * Build a dynamic extraction prompt based on the business profile.
 */
function buildExtractionPrompt(businessProfile) {
  if (!businessProfile?.extraction_fields?.length) {
    return `- facts: extract any specific business facts mentioned (property, budget, timeline, job type etc). Use snake_case keys.`;
  }

  const fields = businessProfile.extraction_fields
    .map(f => `  - "${f.key}" (${f.label}): ${f.description}. Example: "${f.example}"`)
    .join("\n");

  return `- facts: extract these business-specific facts if mentioned (use snake_case keys, omit if not mentioned):\n${fields}`;
}

module.exports = {
  getBusinessProfile,
  shouldUpdateProfile,
  generateBusinessProfile,
  buildExtractionPrompt,
};
