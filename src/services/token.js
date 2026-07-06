const crypto = require("crypto");
const supabase = require("./supabase");

const ALGORITHM = "aes-256-gcm";

// Fail closed: refuse to encrypt/decrypt with a missing or too-short key rather
// than silently padding it with spaces (the previous behaviour produced a
// trivially-guessable key when ENCRYPTION_KEY was unset). Matches the
// fail-closed pattern used for SESSION_SECRET in middleware/auth.js.
//
// Key derivation is preserved exactly: for any key of length >= 32 the bytes are
// `Buffer.from(raw.slice(0, 32))`, identical to the old `padEnd(32).slice(0,32)`
// (padEnd is a no-op at length >= 32) — so tokens encrypted before this change
// remain decryptable. Only the previously-weak short/missing-key case now throws.
let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY || "";
  if (raw.length < 32) {
    throw new Error(
      "ENCRYPTION_KEY must be set to at least 32 characters — refusing to use a weak or space-padded key"
    );
  }
  cachedKey = Buffer.from(raw.slice(0, 32));
  return cachedKey;
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(b => b.toString("hex")).join(":");
}

function decrypt(data) {
  const [ivHex, tagHex, encHex] = data.split(":");
  const iv  = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

async function storeToken(clientId, provider, { accessToken, refreshToken, expiry, email }) {
  const payload = {
    client_id:     clientId,
    provider,
    access_token:  encrypt(accessToken),
    refresh_token: refreshToken ? encrypt(refreshToken) : null,
    token_expiry:  expiry ? new Date(expiry).toISOString() : null,
    email,
    updated_at:    new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("client_id", clientId)
    .eq("provider", provider)
    .single();

  if (existing) {
    await supabase.from("connections").update(payload).eq("id", existing.id);
  } else {
    await supabase.from("connections").insert(payload);
  }
}

async function getToken(clientId, provider) {
  const { data } = await supabase
    .from("connections")
    .select("*")
    .eq("client_id", clientId)
    .eq("provider", provider)
    .single();

  if (!data) return null;

  return {
    accessToken:  decrypt(data.access_token),
    refreshToken: data.refresh_token ? decrypt(data.refresh_token) : null,
    expiry:       data.token_expiry,
    email:        data.email,
  };
}

module.exports = { storeToken, getToken };
