const supabase = require("./supabase");

// supabase-js does NOT throw on query failures — it returns { data, error }.
// These functions used to destructure only `data`, which silently swallowed
// every error (including the personal_contacts table not existing at all,
// backlog P1-6): /add reported success while saving nothing, and the pipeline
// check never logged. Fail closed instead: every unexpected error is thrown so
// the route handlers return 500 (not a false success) and the pipeline's
// existing catch at recording.js logs it.

// .single() reports "no matching row" as error code PGRST116 — for a lookup
// that's the normal miss case, not a failure.
const NO_ROWS = "PGRST116";

/**
 * Determine if a call should be treated as personal (not recorded/logged).
 * Checks against a client's personal_contacts list.
 * Throws on query failure — the pipeline caller catches, logs, and proceeds
 * as not-personal (deliberate: better to process a call than drop it, but
 * the failure must be visible).
 */
async function isPersonalCall(clientId, callerNumber) {
  if (!callerNumber) return false;
  const norm = callerNumber.replace(/\s/g, "");

  const { data, error } = await supabase
    .from("personal_contacts")
    .select("id")
    .eq("client_id", clientId)
    .eq("phone", norm)
    .single();

  if (error && error.code !== NO_ROWS) {
    throw new Error(`personal_contacts lookup failed: ${error.message}`);
  }
  return !!data;
}

/**
 * Add a number to the personal contacts list (family, friends etc).
 * Throws on failure so the /add route can never report false success.
 */
async function addPersonalContact(clientId, phone, label = null) {
  const norm = phone.replace(/\s/g, "");
  const { error } = await supabase.from("personal_contacts").upsert({
    client_id: clientId,
    phone: norm,
    label,
  }, { onConflict: "client_id,phone" });
  if (error) {
    throw new Error(`Failed to save personal contact: ${error.message}`);
  }
}

/**
 * Remove a number from personal contacts (start recording them again).
 * Throws on failure so the /remove route can never report false success.
 */
async function removePersonalContact(clientId, phone) {
  const norm = phone.replace(/\s/g, "");
  const { error } = await supabase.from("personal_contacts")
    .delete()
    .eq("client_id", clientId)
    .eq("phone", norm);
  if (error) {
    throw new Error(`Failed to remove personal contact: ${error.message}`);
  }
}

/**
 * Get all personal contacts for a client.
 * Throws on failure — an error must not masquerade as an empty list.
 */
async function getPersonalContacts(clientId) {
  const { data, error } = await supabase
    .from("personal_contacts")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to load personal contacts: ${error.message}`);
  }
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
