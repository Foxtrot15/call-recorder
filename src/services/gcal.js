const axios   = require("axios");
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
  return accessToken;
}

async function createEvent(clientId, { title, description, startTime, endTime, attendeeEmail }) {
  const accessToken = await getAccessToken(clientId);

  const start = startTime ? new Date(startTime) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end   = endTime   ? new Date(endTime)   : new Date(start.getTime() + 60 * 60 * 1000);

  const event = {
    summary:     title,
    description,
    start: { dateTime: start.toISOString(), timeZone: "Australia/Melbourne" },
    end:   { dateTime: end.toISOString(),   timeZone: "Australia/Melbourne" },
    attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
  };

  const res = await axios.post(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none",
    event,
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  console.log("📅 Calendar event created:", res.data.id);
  return res.data.id;
}

module.exports = { createEvent };
