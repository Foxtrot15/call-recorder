
const { google } = require("googleapis");
const { getToken, storeToken } = require("./token");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = `${process.env.BASE_URL}/auth/google/callback`;

async function getAuthClient(clientId) {
  const tokenData = await getToken(clientId, "google");
  if (!tokenData) throw new Error("No Google token found for client " + clientId);

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oauth2Client.setCredentials({
    access_token:  tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
    expiry_date:   tokenData.expiry ? new Date(tokenData.expiry).getTime() : null,
  });

  // Auto-refresh token if expired
  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.refresh_token || tokens.access_token) {
      await storeToken(clientId, "google", {
        accessToken:  tokens.access_token || tokenData.accessToken,
        refreshToken: tokens.refresh_token || tokenData.refreshToken,
        expiry:       tokens.expiry_date,
        email:        tokenData.email,
      });
    }
  });

  return oauth2Client;
}

async function createDraft(clientId, { to, subject, body }) {
  const auth   = await getAuthClient(clientId);
  const gmail  = google.gmail({ version: "v1", auth });

  // Build RFC 2822 email
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
  const auth  = await getAuthClient(clientId);
  const gmail = google.gmail({ version: "v1", auth });

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

module.exports = { createDraft, sendEmail };
