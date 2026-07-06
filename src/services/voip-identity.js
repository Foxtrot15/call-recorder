// VoIP identity + Access Token configuration (INV-6, backend spec §2/§5.1).
//
// Pure module — the ONE place identity strings and token parameters are
// derived. No route may re-implement the slug→identity mapping (INV-6:
// deterministic, never from user input; the slug always comes from
// req.clientId, resolved server-side by requireClientAuth).
//
// Token minting itself (twilio lib) happens in routes/voip.js with a lazy
// require; everything decidable without the SDK lives here so it can be
// unit-tested without node_modules.

// clients.slug format (also enforced at invite/signup time).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const TOKEN_TTL_SECONDS = 3600; // 1h — deliberately short (spec §5.1); app refreshes on launch/foreground/expiry

// INV-6: "client_" + slug with hyphens → underscores.
// e.g. "pilot-plumbing" → "client_pilot_plumbing"
function clientIdentity(slug) {
  if (!slug || typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Error(`Cannot derive VoIP identity from invalid slug: ${JSON.stringify(slug)}`);
  }
  return "client_" + slug.replace(/-/g, "_");
}

/**
 * Everything needed to mint a Twilio Access Token, validated. Returns
 * { ok:true, config } or { ok:false, status, error } so the route maps
 * failures to HTTP without re-deriving anything.
 */
function buildTokenConfig({ slug, platform, env = process.env }) {
  if (platform !== "ios" && platform !== "android") {
    return { ok: false, status: 400, error: 'platform must be "ios" or "android"' };
  }

  let identity;
  try {
    identity = clientIdentity(slug);
  } catch (err) {
    return { ok: false, status: 500, error: err.message };
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const apiKeySid = env.TWILIO_API_KEY_SID;
  const apiKeySecret = env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !apiKeySid || !apiKeySecret) {
    // Normally unreachable: D9 startup validation refuses to boot when
    // VOIP_V2_ENABLED=true without these. Kept as defence in depth.
    return { ok: false, status: 500, error: "VoIP token signing is not configured (TWILIO_API_KEY_SID/SECRET)" };
  }

  const pushCredentialSid =
    platform === "ios" ? env.TWILIO_APNS_PUSH_CREDENTIAL_SID : env.TWILIO_FCM_PUSH_CREDENTIAL_SID;
  if (!pushCredentialSid) {
    return { ok: false, status: 503, error: `${platform} push credential is not configured on this server yet` };
  }

  return {
    ok: true,
    config: { identity, ttlSeconds: TOKEN_TTL_SECONDS, accountSid, apiKeySid, apiKeySecret, pushCredentialSid },
  };
}

module.exports = { clientIdentity, buildTokenConfig, TOKEN_TTL_SECONDS, SLUG_RE };
