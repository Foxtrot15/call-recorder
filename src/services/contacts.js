
const supabase = require("./supabase");

/**
 * Get or create a contact profile by phone number.
 * Returns the contact record and their full call history.
 */
async function getOrCreateContact(clientId, phone) {
  if (!phone) return null;

  // Normalise phone
  const normPhone = phone.replace(/\s/g, "");

  const { data: existing } = await supabase
    .from("contacts")
    .select("*")
    .eq("client_id", clientId)
    .eq("phone", normPhone)
    .single();

  if (existing) return existing;

  // Create new contact
  const { data } = await supabase
    .from("contacts")
    .insert({ client_id: clientId, phone: normPhone })
    .select()
    .single();

  return data;
}

/**
 * Get full call history for a contact (last 20 calls).
 */
async function getContactHistory(clientId, phone) {
  if (!phone) return [];

  const normPhone = phone.replace(/\s/g, "");

  const { data } = await supabase
    .from("calls")
    .select("recorded_at, direction, duration, summary, intent, caller_name, caller_company, transcript")
    .eq("client_id", clientId)
    .eq("from_number", normPhone)
    .eq("status", "complete")
    .order("recorded_at", { ascending: false })
    .limit(20);

  return data || [];
}

/**
 * Update contact profile after a call is analysed.
 */
async function updateContactFromCall(clientId, phone, analysis, callDate) {
  if (!phone || !analysis) return;

  const normPhone = phone.replace(/\s/g, "");

  // Get existing contact
  const { data: existing } = await supabase
    .from("contacts")
    .select("*")
    .eq("client_id", clientId)
    .eq("phone", normPhone)
    .single();

  const existingFacts = existing?.facts || {};

  // Merge new facts extracted from this call
  const newFacts = analysis.facts || {};
  const mergedFacts = { ...existingFacts, ...newFacts };

  const updates = {
    last_seen:  callDate || new Date().toISOString(),
    call_count: (existing?.call_count || 0) + 1,
    facts:      mergedFacts,
    updated_at: new Date().toISOString(),
  };

  // Only update name/email/company if we have better data
  if (analysis.caller?.name && !existing?.name) {
    updates.name = analysis.caller.name;
  }
  if (analysis.caller?.email && !existing?.email) {
    updates.email = analysis.caller.email;
  }
  if (analysis.caller?.company && !existing?.company) {
    updates.company = analysis.caller.company;
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

/**
 * Build a context summary string for Claude from call history.
 */
function buildContactContext(contact, history) {
  if (!contact && !history?.length) return null;

  const lines = [];

  if (contact?.name) {
    lines.push(`Contact: ${contact.name}${contact.company ? ` from ${contact.company}` : ""}`);
  }

  if (history?.length) {
    lines.push(`Previous calls: ${history.length}`);
    lines.push(`First contact: ${new Date(history[history.length - 1].recorded_at).toLocaleDateString("en-AU")}`);
    lines.push(`Last contact: ${new Date(history[0].recorded_at).toLocaleDateString("en-AU")}`);
    lines.push("");
    lines.push("Call history (most recent first):");
    history.slice(0, 5).forEach((call, i) => {
      const date = new Date(call.recorded_at).toLocaleDateString("en-AU");
      lines.push(`${i + 1}. ${date} — ${call.intent || "enquiry"}: ${call.summary || "No summary"}`);
    });
  }

  if (contact?.facts && Object.keys(contact.facts).length) {
    lines.push("");
    lines.push("Known facts about this contact:");
    Object.entries(contact.facts).forEach(([k, v]) => {
      lines.push(`- ${k}: ${v}`);
    });
  }

  return lines.join("\n");
}

module.exports = { getOrCreateContact, getContactHistory, updateContactFromCall, buildContactContext };
