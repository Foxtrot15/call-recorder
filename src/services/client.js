const supabase = require("./supabase");

// Resolves which client an incoming call belongs to, based on the Twilio
// number that was dialed. This is the one place that answers "whose call
// is this" — /voice uses it directly; recording.js reads the result back
// off the calls row instead of re-deriving it, since the recording
// webhook doesn't carry the original Twilio number.
async function getClientByTwilioNumber(twilioNumber) {
  if (!twilioNumber) return null;
  const { data, error } = await supabase
    .from("clients")
    .select("slug, name, twilio_number, real_number, timezone, pipeline_enabled")
    .eq("twilio_number", twilioNumber)
    .single();
  if (error || !data) return null;
  return data;
}

module.exports = { getClientByTwilioNumber };
