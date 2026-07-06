const axios = require("axios");
const supabase = require("./supabase");
const { buildBusinessProfilePrompt } = require("./prompts");

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
  // TEST-… rows (from /test/inject) are excluded everywhere in this file:
  // demo transcripts must never influence the profile that gets injected
  // into real prompts (root cause of the "Streamline Software" contamination
  // — see docs/LLM_PROMPT_CONTAMINATION_INVESTIGATION.md).
  const { count } = await supabase
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("status", "complete")
    .eq("client_id", clientId)
    .not("call_sid", "like", "TEST-%");

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

  // Fetch last 10 completed REAL calls — scoped to this client, excluding
  // TEST-… injections (see note in shouldUpdateProfile).
  const { data: calls } = await supabase
    .from("calls")
    .select("transcript, summary, intent, analysis")
    .eq("status", "complete")
    .eq("client_id", clientId)
    .not("call_sid", "like", "TEST-%")
    .order("recorded_at", { ascending: false })
    .limit(10);

  if (!calls?.length) return null;

  const transcriptSamples = calls
    .filter(c => c.transcript)
    .slice(0, 5)
    .map((c, i) => `--- Call ${i + 1} ---\n${c.transcript}`)
    .join("\n\n");

  const { system, user } = buildBusinessProfilePrompt({ transcriptSamples });

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
  let profile;
  try {
    profile = JSON.parse(text);
  } catch {
    const clean = text.replace(/```json|```/g, "").trim();
    profile = JSON.parse(clean);
  }

  // Get total call count — scoped to this client, TEST-… rows excluded
  const { count } = await supabase
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("status", "complete")
    .eq("client_id", clientId)
    .not("call_sid", "like", "TEST-%");

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
