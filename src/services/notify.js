const { getAuthClient } = require("./gmail");
const { google } = require("googleapis");

async function sendNotification(clientId, { direction, duration, from, summary, transcript, dashboardUrl }) {
  try {
    const { oauth2Client, email } = await getAuthClient(clientId);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const subject = `📞 ${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration}) — ${from}`;
    const bodyLines = [
      `${direction === "outbound" ? "Outbound" : "Inbound"} call (${duration})`,
      `Contact: ${from}`,
      ``,
      summary ? `Summary: ${summary}` : "",
      ``,
      `View in Aida: ${dashboardUrl || process.env.BASE_URL}`,
      ``,
      `--- Transcript ---`,
      transcript,
    ].filter(l => l !== undefined);

    const body = bodyLines.join("\n");

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
  }
}

module.exports = sendNotification;
