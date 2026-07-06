const axios = require("axios");
const supabase = require("./supabase");
const { buildRollingSummaryPrompt } = require("./prompts");

async function getOrCreateContact(clientId, phone) {
  if (!phone) return null;
  const normPhone = phone.replace(/\s/g, "");

  const { data: existing } = await supabase
    .from("contacts")
    .select("*")
    .eq("client_id", clientId)
    .eq("phone", normPhone)
    .single();

  if (existing) return existing;

  const { data } = await supabase
    .from("contacts")
    .insert({ client_id: clientId, phone: normPhone })
    .select()
    .single();

  return data;
}

async function getContactHistory(clientId, phone) {
  if (!phone) return [];
  const normPhone = phone.replace(/\s/g, "");

  // TEST-… rows excluded: injected demo calls must not enter the contact
  // history that gets fed into analysis/summary prompts
  // (docs/LLM_PROMPT_CONTAMINATION_INVESTIGATION.md, loop L2).
  const { data } = await supabase
    .from("calls")
    .select("recorded_at, direction, duration, summary, intent, caller_name, caller_company")
    .eq("from_number", normPhone)
    .eq("client_id", clientId)
    .eq("status", "complete")
    .not("call_sid", "like", "TEST-%")
    .order("recorded_at", { ascending: false })
    .limit(20);

  return data || [];
}

async function updateContactFromCall(clientId, phone, analysis, callDate) {
  if (!phone || !analysis) return;
  const normPhone = phone.replace(/\s/g, "");

  const { data: existing } = await supabase
    .from("contacts")
    .select("*")
    .eq("client_id", clientId)
    .eq("phone", normPhone)
    .single();

  const existingFacts = existing?.facts || {};
  const newFacts = analysis.facts || {};
  const mergedFacts = { ...existingFacts, ...newFacts };

  const updates = {
    last_seen:  callDate || new Date().toISOString(),
    call_count: (existing?.call_count || 0) + 1,
    facts:      mergedFacts,
    updated_at: new Date().toISOString(),
  };

  if (analysis.caller?.name    && !existing?.name)    updates.name    = analysis.caller.name;
  if (analysis.caller?.email   && !existing?.email)   updates.email   = analysis.caller.email;
  if (analysis.caller?.company && !existing?.company) updates.company = analysis.caller.company;

  // Update rolling summary if contact has multiple calls
  const callCount = (existing?.call_count || 0) + 1;
  if (callCount >= 2) {
    try {
      const history = await getContactHistory(clientId, phone);
      updates.context_summary = await generateRollingSummary(existing, history, analysis);
    } catch (err) {
      console.error("⚠️  Rolling summary failed:", err.message);
    }
  }

  if (existing) {
    await supabase.from("contacts").update(updates).eq("id", existing.id);
  } else {
    await supabase.from("contacts").insert({
      client_id: clientId,
      phone:     normPhone,
      name:      analysis.caller?.name    || null,
      email:     analysis.caller?.email   || null,
      company:   analysis.caller?.company || null,
      ...updates,
    });
  }
}

async function generateRollingSummary(contact, history, latestAnalysis) {
  const existingSummary = contact?.context_summary || "";
  const recentCalls = history.slice(0, 3).map((c, i) =>
    `${i + 1}. ${new Date(c.recorded_at).toLocaleDateString("en-AU")}: ${c.summary || "No summary"}`
  ).join("\n");

  const { system, user } = buildRollingSummaryPrompt({
    existingSummary,
    recentCalls,
    latestSummary: latestAnalysis.summary,
    knownFacts: contact?.facts,
  });

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
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

  return response.data?.content?.[0]?.text?.trim() || existingSummary;
}

function buildContactContext(contact, history) {
  if (!contact && !history?.length) return null;
  const lines = [];

  // Use rolling summary if available (cheap, concise)
  if (contact?.context_summary) {
    lines.push("CONTACT SUMMARY:");
    lines.push(contact.context_summary);
  } else if (history?.length) {
    lines.push(`Previous calls: ${history.length}`);
    lines.push(`First contact: ${new Date(history[history.length - 1].recorded_at).toLocaleDateString("en-AU")}`);
    history.slice(0, 3).forEach((call, i) => {
      const date = new Date(call.recorded_at).toLocaleDateString("en-AU");
      lines.push(`${i + 1}. ${date}: ${call.summary || "No summary"}`);
    });
  }

  if (contact?.facts && Object.keys(contact.facts).length) {
    lines.push("\nKEY FACTS:");
    Object.entries(contact.facts).forEach(([k, v]) => {
      lines.push(`- ${k.replace(/_/g, " ")}: ${v}`);
    });
  }

  return lines.join("\n");
}

// List all contacts for a client — used by the client-facing dashboard.
async function listContacts(clientId) {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, phone, name, company, context_summary, updated_at")
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Failed to list contacts: ${error.message}`);
  return data || [];
}

module.exports = {
  getOrCreateContact,
  getContactHistory,
  updateContactFromCall,
  buildContactContext,
  listContacts,
};
