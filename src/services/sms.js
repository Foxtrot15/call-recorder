const twilio = require("twilio");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Sends an SMS to TRANSCRIPT_RECIPIENT_NUMBER.
 * This is the number that receives the raw transcript —
 * typically your AI agent or your own number.
 */
async function sendSMS(body) {
  await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to:   process.env.TRANSCRIPT_RECIPIENT_NUMBER,
    body,
  });
}

module.exports = sendSMS;
