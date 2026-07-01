const axios = require("axios");
const { getToken, storeToken } = require("./token");

async function refreshAccessToken(tokenData) {
  const params = new URLSearchParams();
  params.append("client_id",     process.env.GOOGLE_CLIENT_ID);
  params.append("client_secret", process.env.GOOGLE_CLIENT_SECRET);
  params.append("refresh_token", tokenData.refreshToken);
  params.append("grant_type",    "refresh_token");

  const res = await axios.post("https://oauth2.googleapis.com/token", params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
  });
  return res.data.access_token;
}

async function getAccessToken(clientId) {
  const tokenData = await getToken(clientId, "google");
  if (!tokenData) throw new Error("No Google token found for client " + clientId);

  const expiry = tokenData.expiry ? new Date(tokenData.expiry).getTime() : 0;
  let accessToken = tokenData.accessToken;

  if (!expiry || expiry < Date.now() + 60000) {
    accessToken = await refreshAccessToken(tokenData);
    await storeToken(clientId, "google", {
      accessToken,
      refreshToken: tokenData.refreshToken,
      expiry:       new Date(Date.now() + 3600000).toISOString(),
      email:        tokenData.email,
    });
  }
  return { accessToken, email: tokenData.email };
}

function buildRaw(to, subject, body) {
  const emailLines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ];
  return Buffer.from(emailLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createDraft(clientId, { to, subject, body }) {
  const { accessToken } = await getAccessToken(clientId);

  const res = await axios.post(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    { message: { raw: buildRaw(to, subject, body) } },
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  console.log("📧 Gmail draft created:", res.data.id);
  return res.data.id;
}

async function sendEmail(clientId, { to, subject, body }) {
  const { accessToken } = await getAccessToken(clientId);

  await axios.post(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { raw: buildRaw(to, subject, body) },
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  console.log("📧 Email sent to", to);
}

async function getAuthClient(clientId) {
  const { accessToken, email } = await getAccessToken(clientId);
  // Lightweight wrapper for notify.js compatibility
  return {
    email,
    sendEmail: (to, subject, body) => sendEmail(clientId, { to, subject, body }),
    accessToken,
  };
}

module.exports = { createDraft, sendEmail, getAuthClient };
