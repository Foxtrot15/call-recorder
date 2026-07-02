const supabase = require("./supabase");

/**
 * Determine if a call should be treated as personal (not recorded/logged).
 * Checks against a client's personal_contacts list.
 */
async function isPersonalCall(clientId, callerNumber) {
  if (!callerNumber) return false;
  const norm = callerNumber.replace(/\s/g, "");

  const { data } = await supabase
    .from("personal_contacts")
    .select("id")
    .eq("client_id", clientId)
    .eq("phone", norm)
    .single();

  return !!data;
}

/**
 * Add a number to the personal contacts list (family, friends etc).
 */
async function addPersonalContact(clientId, phone, label = null) {
  const norm = phone.replace(/\s/g, "");
  await supabase.from("personal_contacts").upsert({
    client_id: clientId,
    phone: norm,
    label,
  }, { onConflict: "client_id,phone" });
}

/**
 * Remove a number from personal contacts (start recording them again).
 */
async function removePersonalContact(clientId, phone) {
  const norm = phone.replace(/\s/g, "");
  await supabase.from("personal_contacts")
    .delete()
    .eq("client_id", clientId)
    .eq("phone", norm);
}

/**
 * Get all personal contacts for a client.
 */
async function getPersonalContacts(clientId) {
  const { data } = await supabase
    .from("personal_contacts")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  return data || [];
}

/**
 * Post-call check: did Claude's analysis flag this as a personal conversation
 * even though it wasn't in the known personal contacts list?
 * Used to suggest adding new numbers to the personal list.
 */
function looksPersonalFromAnalysis(analysis) {
  if (!analysis) return false;
  const personalIntents = ["personal", "family", "friend", "wrong_number"];
  return personalIntents.includes(analysis.intent) ||
    (analysis.summary && /\b(mum|dad|wife|husband|son|daughter|family|personal)\b/i.test(analysis.summary));
}

module.exports = {
  isPersonalCall,
  addPersonalContact,
  removePersonalContact,
  getPersonalContacts,
  looksPersonalFromAnalysis,
};
