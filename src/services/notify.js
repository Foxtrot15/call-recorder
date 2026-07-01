
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

  return { oauth2Client, email: tokenData.email };
}

async function sendNotification(clientId, { direction, duration, from, summary, transcript, dashboardUrl }) {
  try {
    const { oauth2Client, email } = await getAuthClient(clientId);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

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

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    console.log(`📧 Notification email sent to ${email}`);
  } catch (err) {
    console.error("⚠️  Notification email failed:", err.message);
    // Fallback to Twilio SMS if email fails
    try {
      const twilio = require("twilio");
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
        to:   `whatsapp:${process.env.TRANSCRIPT_RECIPIENT_NUMBER}`,
        body: `📞 ${direction} call (${duration})\nFrom: ${from}\n${summary ? `Summary: ${summary}` : ""}`,
      });
      console.log("📱 Fallback WhatsApp sent");
    } catch (e) {
      console.error("⚠️  Fallback also failed:", e.message);
    }
  }
}

module.exports = sendNotification;
