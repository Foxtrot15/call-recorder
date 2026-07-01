const crypto = require("crypto");
const supabase = require("./supabase");

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from((process.env.ENCRYPTION_KEY || "").padEnd(32).slice(0, 32));

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(b => b.toString("hex")).join(":");
}

function decrypt(data) {
  const [ivHex, tagHex, encHex] = data.split(":");
  const iv  = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
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
