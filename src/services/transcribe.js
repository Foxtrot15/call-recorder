const axios = require("axios");

async function transcribeAudio(audioUrl) {
  const audioResponse = await axios.get(audioUrl, {
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
    responseType: "arraybuffer",
  });

  const response = await axios.post(
    "https://api.deepgram.com/v1/listen",
    audioResponse.data,
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/mpeg",
      },
      params: {
        model: "nova-2",
        smart_format: true,
        punctuate: true,
        diarize: true,
        utterances: true,
        language: "en-AU",
      },
    }
  );

  const utterances = response.data?.results?.utterances;
  if (utterances && utterances.length > 0) {
    return utterances
      .map((u) => `Speaker ${u.speaker}: ${u.transcript}`)
      .join("\n");
  }

  return (
    response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ""
  );
}

module.exports = transcribeAudio;
