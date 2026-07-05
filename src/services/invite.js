const crypto = require("crypto");

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours — long enough for a client to receive and act on the link

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — refusing to sign/verify invite tokens");
  }
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Stateless invite token binding a signup to one specific client slug.
// Format: "invite.<clientId>.<expiresAt>.<hmac>" — the "invite" marker keeps
// this token type from being confused with the operator session cookie even
// though both are HMAC'd with the same SESSION_SECRET (safe: HMAC domain
// separation comes from the signed content, not a separate key). clientId
// must not contain "." for the split-based parsing below.
function createInviteToken(clientId, ttlMs = INVITE_TTL_MS) {
  if (!clientId || typeof clientId !== "string") {
    throw new Error("clientId is required to create an invite token");
  }
  if (clientId.includes(".")) {
    throw new Error("clientId must not contain '.'");
  }
  const expiresAt = Date.now() + ttlMs;
  const payload = `invite.${clientId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

// Returns { clientId } if the token is validly signed, unexpired, and
// well-formed — otherwise null. Never throws.
function verifyInviteToken(token) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [marker, clientId, expiresAtStr, signature] = parts;
  if (marker !== "invite" || !clientId) return null;

  const payload = `${marker}.${clientId}.${expiresAtStr}`;
  let expected;
  try {
    expected = sign(payload);
  } catch (err) {
    console.error("⚠️ ", err.message);
    return null; // fail closed: no usable secret means no valid invites
  }

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  const expiresAt = parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  return { clientId };
}

module.exports = { createInviteToken, verifyInviteToken };
