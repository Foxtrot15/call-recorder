// AIDA — lazy Twilio client factory (M7F-B2).
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────
// `routes/call.js` built its Twilio client at MODULE SCOPE:
//
//     const client = twilio(process.env.TWILIO_ACCOUNT_SID, ...);
//
// The Twilio constructor throws `username is required` when the account SID is
// undefined, so merely IMPORTING that route killed the process. server.js
// requires it at startup, which meant a deployment with no Twilio credentials
// could not boot at all — even to serve routes that have nothing to do with
// telephony, like the Retell inbound webhook.
//
// That is the wrong coupling. Twilio is one optional capability of this server,
// not a precondition for it existing. `config/startup-check.js` already agrees:
// TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER are listed as
// RECOMMENDED (warnings), not CRITICAL (fatal). The route contradicted that.
//
// ─── THE PATTERN ────────────────────────────────────────────────────
// Lazy require, memoised singleton, built on first USE — the same convention
// `middleware/auth.js` already uses for the Twilio webhook validator, and the
// same house rule that keeps heavy dependencies out of module scope so a
// dep-free checkout can still load the file.
//
// Missing credentials produce a REPORTED REFUSAL rather than a throw. A caller
// gets `{ ok: false, reason }` and can answer 503 deliberately; nothing here
// invents a placeholder credential, and nothing here weakens signature
// verification, which lives in middleware/auth.js and is untouched.

let cached = null;
let cachedKey = null;

/** Are both credentials the Twilio constructor requires actually present? */
function isTwilioConfigured(env = process.env) {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
}

/**
 * Which Twilio settings are missing, for a message an operator can act on.
 * Names only — a credential value is never read into a string here.
 */
function missingTwilioSettings(env = process.env) {
  const missing = [];
  if (!env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
  if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
  return missing;
}

/**
 * The Twilio client, built on first use.
 *
 * @returns {{ok: true, client: object} | {ok: false, client: null, reason: string}}
 *
 * Never throws for a configuration problem — that is the whole point. It still
 * reports a construction failure rather than swallowing it, because a present
 * but malformed credential is a different problem from an absent one and should
 * not be mistaken for "telephony is switched off".
 */
function getTwilioClient({ env = process.env, factory = null } = {}) {
  const missing = missingTwilioSettings(env);
  if (missing.length) {
    return { ok: false, client: null, reason: `Twilio is not configured (${missing.join(", ")} not set)` };
  }

  // Memoised per credential pair, so a test that swaps credentials gets a fresh
  // client while production builds exactly one. The SID is not a secret; the
  // auth token is, so only its length participates in the key.
  const key = `${env.TWILIO_ACCOUNT_SID}:${String(env.TWILIO_AUTH_TOKEN).length}`;
  if (cached && cachedKey === key) return { ok: true, client: cached };

  try {
    // Lazily required: the module must stay loadable on a checkout with no
    // node_modules, and importing it must never construct anything.
    const twilio = factory || require("twilio");
    cached = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    cachedKey = key;
    return { ok: true, client: cached };
  } catch (err) {
    // The message can echo a credential, so it is deliberately not propagated.
    return { ok: false, client: null, reason: "the Twilio client could not be constructed from the configured credentials" };
  }
}

/** Test seam. Production never calls this. */
function resetTwilioClient() {
  cached = null;
  cachedKey = null;
}

module.exports = { isTwilioConfigured, missingTwilioSettings, getTwilioClient, resetTwilioClient };
