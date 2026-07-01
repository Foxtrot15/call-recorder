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

async function sendNotification(clientId, { direction, duration, from, summary, transcript, dashboardUrl }) {
  try {
    const tokenData = await getToken(clientId, "google");
    if (!tokenData) throw new Error("No Google token");

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

    const email = tokenData.email;
    const subject = `📞 ${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration}) — ${from}`;
    const body = [
      `${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration})`,
      `Contact: ${from}`,
      ``,
      summary ? `Summary: ${summary}` : "",
      ``,
      `View in Aida: ${dashboardUrl || process.env.BASE_URL}`,
      ``,
      `--- Transcript ---`,
      transcript,
    ].filter(l => l !== undefined).join("\n");

    const emailLines = [
      `To: ${email}`,
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

    await axios.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { raw },
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    console.log(`📧 Notification email sent to ${email}`);
  } catch (err) {
    console.error("⚠️  Notification email failed:", err.message);
  }
}

module.exports = sendNotification;
