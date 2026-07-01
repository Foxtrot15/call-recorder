const axios = require("axios");
const { google } = require("googleapis");
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

async function getAuthClient(clientId) {
  const tokenData = await getToken(clientId, "google");
  if (!tokenData) throw new Error("No Google token found for client " + clientId);

  // Check if token is expired or about to expire
  let accessToken = tokenData.accessToken;
  const expiry = tokenData.expiry ? new Date(tokenData.expiry).getTime() : 0;
  const now = Date.now();

  if (!expiry || expiry < now + 60000) {
    // Refresh the token
    accessToken = await refreshAccessToken(tokenData);
    await storeToken(clientId, "google", {
      accessToken,
      refreshToken: tokenData.refreshToken,
      expiry:       new Date(now + 3600000).toISOString(),
      email:        tokenData.email,
    });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );
  oauth2Client.setCredentials({ access_token: accessToken });

  return { oauth2Client, email: tokenData.email };
}

async function createDraft(clientId, { to, subject, body }) {
  const { oauth2Client } = await getAuthClient(clientId);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const emailLines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ];
  const raw = Buffer.from(emailLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const draft = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });

  console.log(`📧 Gmail draft created: ${draft.data.id}`);
  return draft.data.id;
}

async function sendEmail(clientId, { to, subject, body }) {
  const { oauth2Client } = await getAuthClient(clientId);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const emailLines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ];
  const raw = Buffer.from(emailLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  console.log(`📧 Email sent to ${to}`);
}

module.exports = { createDraft, sendEmail, getAuthClient };
