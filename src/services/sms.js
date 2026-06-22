const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(body) {
  await client.messages.create({
    from: "whatsapp:+14155238886",
    to:   `whatsapp:${process.env.TRANSCRIPT_RECIPIENT_NUMBER}`,
    body,
  });
}

module.exports = sendSMS;
