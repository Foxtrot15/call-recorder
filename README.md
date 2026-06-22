# Call Recorder & Transcriber

Records inbound and outbound calls on a Twilio number, transcribes them with Deepgram, and SMS's the transcript to a recipient number (your AI agent or yourself).

---

## How it works

```
INBOUND
  Caller → Twilio number → recorded → forwarded to client's real mobile
                                    ↓ (on completion)
                              Deepgram transcribes
                                    ↓
                              SMS sent to recipient number

OUTBOUND
  Client → Twilio bridge number → prompted for destination → recorded → connected
                                                                       ↓ (on completion)
                                                                 Deepgram transcribes
                                                                       ↓
                                                                 SMS sent to recipient number
```

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Expose your server publicly
During development use [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# Copy the https URL → set as BASE_URL in .env
```

### 4. Configure Twilio webhooks

In the Twilio Console, for your phone number(s):

| Webhook | URL |
|---|---|
| Inbound calls "A call comes in" | `https://your-domain.com/inbound/voice` |
| Outbound bridge "A call comes in" | `https://your-domain.com/outbound/voice` |

> You can use **one** Twilio number for both by routing based on who's calling,
> or use **two** separate numbers (simpler). Two numbers is recommended.

### 5. Set up call forwarding on the client's phone (inbound only)

The client dials this once on their mobile:
```
*21*[TWILIO_INBOUND_NUMBER]#
```
This unconditionally forwards all inbound calls through Twilio.

To cancel forwarding later:
```
##21#
```

### 6. Save the outbound bridge number

Have the client save the Twilio bridge number as a contact (e.g. "📞 Recorded Call"). 
When they want to make a recorded outbound call, they:
1. Call the bridge number
2. Hear: *"Enter the number you want to call, then press hash"*
3. Dial destination + `#`
4. Call connects and is recorded

### 7. Start the server
```bash
npm start
# or for development:
npm run dev
```

---

## SMS output format

Each call produces an SMS like:

```
📞 Inbound call (3m 42s)
From: +447911123456
To: +447700900000

Speaker 0: Hello, I'm calling about my property purchase.
Speaker 1: Of course, let me pull up your file.
Speaker 0: Great, I wanted to check on the exchange date.
...
```

For long calls, the transcript is split across multiple SMS messages labeled `[1/3]`, `[2/3]` etc.

---

## Environment variables

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (E.164 format) |
| `CLIENT_REAL_NUMBER` | Client's actual mobile to forward inbound calls to |
| `DEEPGRAM_API_KEY` | Deepgram API key |
| `TRANSCRIPT_RECIPIENT_NUMBER` | Number to SMS transcripts to (your agent or yourself) |
| `PORT` | Server port (default: 3000) |
| `BASE_URL` | Public URL of your server (for Twilio callbacks) |

---

## Deployment

Any Node.js host works: Railway, Render, Fly.io, or your existing VPS.
Make sure the server is publicly reachable so Twilio can hit the webhooks.
