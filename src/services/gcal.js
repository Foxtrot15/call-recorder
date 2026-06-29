
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

async function createEvent(clientId, { title, description, startTime, endTime, attendeeEmail }) {
  const auth     = await getAuthClient(clientId);
  const calendar = google.calendar({ version: "v3", auth });

  // Default to 1 hour meeting if no end time
  const start = startTime ? new Date(startTime) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end   = endTime   ? new Date(endTime)   : new Date(start.getTime() + 60 * 60 * 1000);

  const event = {
    summary:     title,
    description,
    start: { dateTime: start.toISOString(), timeZone: "Australia/Melbourne" },
    end:   { dateTime: end.toISOString(),   timeZone: "Australia/Melbourne" },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
  };

  const result = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
    sendUpdates: attendeeEmail ? "all" : "none",
  });

  console.log(`📅 Calendar event created: ${result.data.id}`);
  return result.data.id;
}

module.exports = { createEvent };
