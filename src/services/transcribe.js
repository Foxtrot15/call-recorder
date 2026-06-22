const axios = require("axios");

/**
 * Transcribes an audio file URL using Deepgram.
 * Returns a plain text transcript string.
 *
 * Uses nova-2 model with smart formatting and speaker diarisation
 * so you can tell who's speaking (useful for call summaries).
 */
async function transcribeAudio(audioUrl) {
  const response = await axios.post(
    "https://api.deepgram.com/v1/listen",
    { url: audioUrl },
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      params: {
        model: "nova-2",
        smart_format: true,
        punctuate: true,
        diarize: true,          // Speaker A / Speaker B labels
        utterances: true,       // Break into speech segments
        language: "en-GB",
      },
    }
  );

  const utterances = response.data?.results?.utterances;

  if (utterances && utterances.length > 0) {
    // Format as "Speaker 0: ..." lines
    return utterances
      .map((u) => `Speaker ${u.speaker}: ${u.transcript}`)
      .join("\n");
  }

  // Fallback: plain transcript
  return (
    response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ""
  );
}

module.exports = transcribeAudio;
